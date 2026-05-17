"""
Scan the local custom_nodes/ directory and produce a portable list of
install specs that comfyapp.py can use to replicate the environment
on the cloud Modal container.

Identification priority:
  1. CNR (ComfyUI Registry) — pyproject.toml + .tracking file → id@version
  2. Git remote URL → usable with `comfy node install <url>`
  3. Directory name → usable with `comfy node install <name>`
"""

import configparser
import json
import os
from datetime import datetime, timezone

# Directories to always skip when scanning custom_nodes/
_SKIP_DIRS = frozenset({
    "__pycache__",
    ".disabled",
    "comfyui-modal",   # never install ourselves in the cloud
})


def _read_cnr_info(node_path: str) -> dict | None:
    """
    Read CNR metadata from pyproject.toml + .tracking file.
    Returns {"id": ..., "version": ...} or None.
    Mirrors the logic in ComfyUI-Manager's cnr_utils.read_cnr_info().
    """
    toml_path = os.path.join(node_path, "pyproject.toml")
    tracking_path = os.path.join(node_path, ".tracking")

    if not os.path.exists(toml_path) or not os.path.exists(tracking_path):
        return None

    try:
        # Use tomllib (Python 3.11+) or fall back to a simple parser
        try:
            import tomllib
            with open(toml_path, "rb") as f:
                data = tomllib.load(f)
        except ImportError:
            try:
                import toml
                with open(toml_path, "r", encoding="utf-8") as f:
                    data = toml.load(f)
            except ImportError:
                return None

        project = data.get("project", {})
        name = project.get("name", "").strip().lower()
        version = project.get("version", "").strip()

        if name and version:
            return {"id": name, "version": version}
    except Exception:
        pass

    return None


def _read_git_url(node_path: str) -> str | None:
    """
    Read the git remote origin URL from .git/config.
    """
    git_config = os.path.join(node_path, ".git", "config")
    if not os.path.isfile(git_config):
        return None

    try:
        cfg = configparser.ConfigParser()
        cfg.read(git_config, encoding="utf-8")

        # Look for [remote "origin"] url = ...
        for section in cfg.sections():
            if section.startswith('remote "') and section.endswith('"'):
                url = cfg.get(section, "url", fallback=None)
                if url:
                    return url.strip()
    except Exception:
        pass

    return None


def _read_cnr_id_from_git(node_path: str) -> str | None:
    """
    Read CNR ID from .git/.cnr-id (written by ComfyUI-Manager for git-cloned
    nodes that are also registered in the ComfyUI Registry).
    """
    cnr_id_path = os.path.join(node_path, ".git", ".cnr-id")
    try:
        if os.path.isfile(cnr_id_path):
            with open(cnr_id_path, "r") as f:
                return f.read().strip() or None
    except Exception:
        pass
    return None


def scan_custom_nodes(custom_nodes_dir: str | None = None) -> list[dict]:
    """
    Scan the custom_nodes/ directory and return a list of node descriptors.

    Each descriptor: {
        "name":         directory name,
        "install_spec": string to pass to `comfy node install`,
        "source":       "cnr" | "git" | "dirname",
        "version":      version string or None,
    }
    """
    if custom_nodes_dir is None:
        # Resolve: this file lives in custom_nodes/comfyui-modal/
        custom_nodes_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    nodes = []

    if not os.path.isdir(custom_nodes_dir):
        return nodes

    for entry in sorted(os.listdir(custom_nodes_dir)):
        full_path = os.path.join(custom_nodes_dir, entry)

        # Only process directories
        if not os.path.isdir(full_path):
            continue

        # Skip well-known non-node directories and disabled nodes
        if entry in _SKIP_DIRS or entry.endswith(".disabled"):
            continue

        # --- Strategy 1: CNR metadata (pyproject.toml + .tracking) ---
        cnr_info = _read_cnr_info(full_path)
        if cnr_info:
            # Pin to exact tracked version
            install_spec = f"{cnr_info['id']}@{cnr_info['version']}"
            nodes.append({
                "name": entry,
                "install_spec": install_spec,
                "source": "cnr",
                "version": cnr_info["version"],
            })
            continue

        # --- Strategy 2: Git remote URL ---
        git_url = _read_git_url(full_path)
        if git_url:
            # Check if Manager has a CNR ID for this git-cloned node
            cnr_id = _read_cnr_id_from_git(full_path)
            if cnr_id:
                # Use CNR ID (install latest since we don't have a pinned version)
                nodes.append({
                    "name": entry,
                    "install_spec": cnr_id,
                    "source": "cnr",
                    "version": None,
                })
            else:
                nodes.append({
                    "name": entry,
                    "install_spec": git_url,
                    "source": "git",
                    "version": None,
                })
            continue

        # --- Strategy 3: directory name fallback ---
        nodes.append({
            "name": entry,
            "install_spec": entry,
            "source": "dirname",
            "version": None,
        })

    return nodes


def scan_and_save(custom_nodes_dir: str | None = None,
                  output_path: str | None = None) -> list[dict]:
    """
    Scan custom nodes and write the result to custom_nodes.json.
    Returns the node list.
    """
    nodes = scan_custom_nodes(custom_nodes_dir)

    if output_path is None:
        output_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "custom_nodes.json",
        )

    manifest = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "nodes": nodes,
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    return nodes
