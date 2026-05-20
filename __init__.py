import asyncio
import json
import uuid
import sys
import os
import re
import base64
import copy
import threading
import subprocess
import time
from aiohttp import web

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "web"


def _unique_path(directory: str, filename: str) -> str:
    path = os.path.join(directory, filename)
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(filename)
    suffix = time.strftime("%Y%m%d_%H%M%S") + f"_{int(time.time() * 1_000_000) % 1_000_000:06d}"
    return os.path.join(directory, f"{stem}_{suffix}{ext}")


_NODE_DIR = os.path.dirname(os.path.abspath(__file__))
_COMFYAPP_PATH = os.path.join(_NODE_DIR, "comfyapp.py")
_DEPLOY_STATE_FILE = os.path.join(_NODE_DIR, ".deployed_version")
_DEPLOY_LOG_FILE = os.path.join(_NODE_DIR, ".deploy_log")

_pip_install_error = ""

def _ensure_modal():
    global _pip_install_error
    try:
        import modal  # noqa: F401
        return
    except ImportError:
        pass
    print("[comfyui-modal] 'modal' package not found — installing...")
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "modal"],
            check=True,
            capture_output=True,
            text=True,
        )
        print("[comfyui-modal] 'modal' installed successfully.")
    except subprocess.CalledProcessError as e:
        _pip_install_error = e.stderr or str(e)
        print(f"[comfyui-modal] ERROR: Failed to install 'modal' package: {e.stderr}")
        print("[comfyui-modal] Please install manually: pip install modal")
    except Exception as e:
        _pip_install_error = str(e)
        print(f"[comfyui-modal] ERROR: Unexpected error installing 'modal': {e}")
        print("[comfyui-modal] Please install manually: pip install modal")

_ensure_modal()


_deploy_status = {"state": "idle", "message": ""}

def _get_deployed_version():
    try:
        with open(_DEPLOY_STATE_FILE, "r") as f:
            return f.read().strip()
    except FileNotFoundError:
        return None

def _set_deployed_version(version: str):
    with open(_DEPLOY_STATE_FILE, "w") as f:
        f.write(version)

def _get_comfyapp_version():
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("comfyapp_meta", _COMFYAPP_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return getattr(mod, "COMFYAPP_VERSION", "unknown")
    except Exception as e:
        print(f"[comfyui-modal] Could not read COMFYAPP_VERSION: {e}")
        return "unknown"

def _find_modal_executable():
    import shutil
    modal_cmd = shutil.which("modal")
    if modal_cmd:
        return modal_cmd
    python_dir = os.path.dirname(sys.executable)
    candidates = [
        os.path.join(python_dir, "modal"),
        os.path.join(python_dir, "modal.exe"),
        os.path.join(python_dir, "Scripts", "modal"),
        os.path.join(python_dir, "Scripts", "modal.exe"),
        os.path.expanduser("~/.local/bin/modal"),
        "/usr/local/bin/modal",
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None

def _parse_deploy_error(output):
    """Try to extract specific failure info from deploy output."""
    # Look for pip install failures
    m = re.search(r"ERROR: Could not find a version that satisfies the requirement (\S+)", output)
    if m:
        return f"Failed package: {m.group(1)}."
    m = re.search(r"ERROR: No matching distribution found for (\S+)", output)
    if m:
        return f"Failed package: {m.group(1)}."
    if "conflicting dependencies" in output.lower():
        m = re.search(r"(\S+) requires (\S+)", output)
        if m:
            return f"Conflicting dependencies: {m.group(1)} requires {m.group(2)}."
        return "Conflicting dependencies detected."
    # Look for failed node install
    m = re.search(r"Installing (\S+).{0,200}?(?:error|failed|Error)", output, re.IGNORECASE)
    if m:
        return f"Failed node: {m.group(1)}."
    return ""


def _run_deploy_background():
    global _deploy_status

    modal_cmd = _find_modal_executable()
    if not modal_cmd:
        _deploy_status = {
            "state": "error",
            "message": "modal CLI not found. Run: pip install modal",
        }
        print(f"[comfyui-modal] {_deploy_status['message']}")
        return

    _deploy_status = {"state": "deploying", "message": "Running modal deploy..."}
    print(f"[comfyui-modal] Deploying comfyapp.py (modal: {modal_cmd})")

    try:
        result = subprocess.run(
            [modal_cmd, "deploy", _COMFYAPP_PATH],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        combined_output = (result.stdout or "") + "\n" + (result.stderr or "")

        # Always write full log
        try:
            with open(_DEPLOY_LOG_FILE, "w", encoding="utf-8") as f:
                f.write(combined_output)
        except Exception as e:
            print(f"[comfyui-modal] Warning: could not write deploy log: {e}")

        if result.returncode == 0:
            version = _get_comfyapp_version()
            _set_deployed_version(version)
            _deploy_status = {"state": "ready", "message": f"Deployed v{version}"}
            print(f"[comfyui-modal] Deploy succeeded (v{version})")
            if _modal_available:
                try:
                    clear_cache()
                except Exception as e:
                    print(f"[comfyui-modal] clear_cache failed: {e}")
        else:
            combined = combined_output.strip()
            if "token" in combined.lower() or "auth" in combined.lower() or "credentials" in combined.lower():
                msg = "Modal token not set. Run: modal setup"
            else:
                error_prefix = _parse_deploy_error(combined)
                truncated = combined[:2000]
                msg = f"Deploy failed: {truncated}"
                if error_prefix:
                    msg = f"{error_prefix} {msg}"
            _deploy_status = {
                "state": "error",
                "message": msg,
                "details": combined[:2000],
            }
            print(f"[comfyui-modal] {msg[:500]}")
    except subprocess.TimeoutExpired:
        _deploy_status = {"state": "error", "message": "Deploy timed out (10 min)", "details": "Deploy timed out after 10 minutes"}
        print(f"[comfyui-modal] Deploy timed out")
    except Exception as e:
        _deploy_status = {"state": "error", "message": str(e), "details": str(e)}
        print(f"[comfyui-modal] Deploy error: {e}")

def _maybe_auto_deploy():
    current_version = _get_comfyapp_version()
    deployed_version = _get_deployed_version()

    if current_version == deployed_version:
        _deploy_status["state"] = "ready"
        _deploy_status["message"] = f"Already deployed v{current_version}"
        print(f"[comfyui-modal] comfyapp.py v{current_version} already deployed — skipping deploy")
        return

    print(f"[comfyui-modal] Version changed ({deployed_version} → {current_version}), starting background deploy...")
    t = threading.Thread(target=_run_deploy_background, daemon=True)
    t.start()

try:
    from server import PromptServer
    import execution
    _server = PromptServer.instance
except Exception as e:
    print(f"[comfyui-modal] Could not get PromptServer: {e}")
    _server = None
    execution = None

sys.path.insert(0, _NODE_DIR)

try:
    import modal as _modal_pkg
    from modal_client import run_prompt, get_object_info, health_check, download_model, batch_download_models, list_models, delete_model, set_gpu, get_gpu, sync_custom_nodes, get_sync_status, upload_model_to_volume, upload_model_chunk, clear_cache
    _modal_available = True
    _maybe_auto_deploy()
except ImportError:
    _err_detail = f" (install error: {_pip_install_error})" if _pip_install_error else ""
    print(f"[comfyui-modal] WARNING: 'modal' package not installed.{_err_detail} Run: pip install modal")
    _modal_available = False
    _deploy_msg = "modal package not installed. Run: pip install modal"
    if _pip_install_error:
        _deploy_msg += f" (pip error: {_pip_install_error})"
    _deploy_status = {"state": "error", "message": _deploy_msg}
    def run_prompt(*a, **kw): raise RuntimeError("modal not installed")
    def get_object_info(*a, **kw): raise RuntimeError("modal not installed")
    def health_check(*a, **kw): raise RuntimeError("modal not installed")
    def download_model(*a, **kw): raise RuntimeError("modal not installed")
    def batch_download_models(*a, **kw): raise RuntimeError("modal not installed")
    def list_models(*a, **kw): raise RuntimeError("modal not installed")
    def delete_model(*a, **kw): raise RuntimeError("modal not installed")
    def sync_custom_nodes(*a, **kw): raise RuntimeError("modal not installed")
    def get_sync_status(*a, **kw): raise RuntimeError("modal not installed")
    def upload_model_to_volume(*a, **kw): raise RuntimeError("modal not installed")
    def upload_model_chunk(*a, **kw): raise RuntimeError("modal not installed")
    def set_gpu(gpu): pass
    def get_gpu(): return "a10g"

_COMFYUI_ROOT = os.path.dirname(os.path.dirname(_NODE_DIR))

_MODAL_TOML_PATH = os.path.expanduser("~/.modal.toml")
_HF_TOKEN_PATH = os.path.join(os.path.dirname(__file__), ".hf_token")

def _read_hf_token() -> str:
    try:
        with open(_HF_TOKEN_PATH, "r") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""

def _write_hf_token(token: str):
    with open(_HF_TOKEN_PATH, "w") as f:
        f.write(token.strip())

def _is_modal_token_set() -> bool:
    try:
        with open(_MODAL_TOML_PATH, "r") as f:
            content = f.read()
        return "token_id" in content and "token_secret" in content
    except FileNotFoundError:
        return False

def _write_modal_toml(token_id: str, token_secret: str):
    content = f'[default]\ntoken_id = "{token_id}"\ntoken_secret = "{token_secret}"\n'
    os.makedirs(os.path.dirname(_MODAL_TOML_PATH), exist_ok=True)
    with open(_MODAL_TOML_PATH, "w") as f:
        f.write(content)


_queue: asyncio.Queue = asyncio.Queue()
_queue_worker_started = False
_item_counter = 0
_counter_lock = asyncio.Lock()


def _send(sid: str, event: str, data: dict):
    if _server:
        _server.send_sync(event, data, sid)


def _pq():
    return _server.prompt_queue if _server else None


def _register_running(item: tuple) -> int:
    pq = _pq()
    if pq is None:
        return 0
    import heapq
    with pq.mutex:
        try:
            pq.queue.remove(item)
            heapq.heapify(pq.queue)
        except ValueError:
            pass
        key = pq.task_counter
        pq.currently_running[key] = copy.deepcopy(item)
        pq.task_counter += 1
        pq.server.queue_updated()
    return key


def _finish_job(item_id: int, prompt_id: str, outputs: dict, success: bool):
    pq = _pq()
    if pq is None:
        return
    status = execution.PromptQueue.ExecutionStatus(
        status_str='success' if success else 'error',
        completed=success,
        messages=[],
    )
    history_result = {"outputs": outputs, "meta": {}}
    pq.task_done(item_id, history_result, status=status,
                 process_item=lambda prompt: prompt[:5] + prompt[6:])


async def _process_queue():
    while True:
        item, item_id = await _queue.get()
        try:
            await _execute_job(item, item_id)
        finally:
            _queue.task_done()


def _collect_input_images(workflow: dict) -> dict:
    images = {}
    search_dirs = [
        os.path.join(_COMFYUI_ROOT, "input"),
        os.path.join(_COMFYUI_ROOT, "output"),
    ]
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        if not class_type.startswith("LoadImage"):
            continue
        filename = node.get("inputs", {}).get("image", "") or node.get("inputs", {}).get("mask", "")
        if not filename or filename in images:
            continue
        if filename.startswith("http://") or filename.startswith("https://"):
            continue
        for d in search_dirs:
            candidate = os.path.join(d, filename)
            if os.path.isfile(candidate):
                with open(candidate, "rb") as f:
                    images[filename] = base64.b64encode(f.read()).decode()
                break
        else:
            print(f"[comfyui-modal] Warning: input image not found locally: {filename}")
    return images


async def _execute_job(item: tuple, item_id: int):
    number, prompt_id, workflow, extra_data, _, _ = item
    sid = extra_data.get("client_id", "")

    task_key = _register_running(item)

    node_ids = list(workflow.keys())
    _send(sid, "execution_start", {"prompt_id": prompt_id})
    _send(sid, "execution_cached", {"nodes": [], "prompt_id": prompt_id})

    for node_id in node_ids:
        _send(sid, "executing", {"node": node_id, "display_node": node_id, "prompt_id": prompt_id})
        await asyncio.sleep(0)

    success = False
    outputs = {}
    try:
        input_images = _collect_input_images(workflow)
        result = await run_prompt(workflow, input_images)
        success = True
    except asyncio.CancelledError:
        _send(sid, "execution_error", {"message": "cancelled", "prompt_id": prompt_id})
        _finish_job(task_key, prompt_id, outputs, success=False)
        raise
    except Exception as e:
        _send(sid, "execution_error", {"message": str(e), "prompt_id": prompt_id})
        _finish_job(task_key, prompt_id, outputs, success=False)
        return

    output_dir = os.path.join(_COMFYUI_ROOT, "output")
    os.makedirs(output_dir, exist_ok=True)

    for img in result.get("images", []):
        img_bytes = base64.b64decode(img["data"])
        local_filename = img["filename"]
        local_path = _unique_path(output_dir, local_filename)
        local_filename = os.path.basename(local_path)
        with open(local_path, "wb") as f:
            f.write(img_bytes)

        node_id = img["node_id"]
        img_entry = {"filename": local_filename, "subfolder": "", "type": "output"}

        if node_id not in outputs:
            outputs[node_id] = {"images": []}
        outputs[node_id]["images"].append(img_entry)

        _send(sid, "executed", {
            "node": node_id,
            "display_node": node_id,
            "prompt_id": prompt_id,
            "output": {"images": [img_entry]},
        })

    for vid in result.get("videos", []):
        vid_bytes = base64.b64decode(vid["data"])
        local_filename = vid["filename"]
        local_path = _unique_path(output_dir, local_filename)
        local_filename = os.path.basename(local_path)
        with open(local_path, "wb") as f:
            f.write(vid_bytes)

        node_id = vid["node_id"]
        vid_entry = {"filename": local_filename, "subfolder": "", "type": "output"}

        if node_id not in outputs:
            outputs[node_id] = {"images": [], "animated": (True,)}
        outputs[node_id].setdefault("images", []).append(vid_entry)
        outputs[node_id]["animated"] = (True,)

        _send(sid, "executed", {
            "node": node_id,
            "display_node": node_id,
            "prompt_id": prompt_id,
            "output": {"images": [vid_entry], "animated": [True]},
        })

    _send(sid, "executing", {"node": None, "display_node": None, "prompt_id": prompt_id})
    _send(sid, "execution_success", {"prompt_id": prompt_id})
    _finish_job(task_key, prompt_id, outputs, success=True)


if _server:
    @_server.routes.get("/comfymodal/auth/status")
    async def modal_auth_status(request: web.Request) -> web.Response:
        return web.json_response({"connected": _is_modal_token_set()})

    @_server.routes.get("/comfymodal/hf-token")
    async def modal_hf_token_get(request: web.Request) -> web.Response:
        token = _read_hf_token()
        return web.json_response({"token": token[:8] + "..." if len(token) > 8 else ("set" if token else "")})

    @_server.routes.post("/comfymodal/hf-token")
    async def modal_hf_token_set(request: web.Request) -> web.Response:
        body = await request.json()
        token = body.get("token", "").strip()
        if token and not token.startswith("hf_"):
            return web.json_response({"status": "error", "message": "HF token must start with hf_"}, status=400)
        _write_hf_token(token)
        return web.json_response({"status": "ok"})

    @_server.routes.post("/comfymodal/auth/setup")
    async def modal_auth_setup(request: web.Request) -> web.Response:
        body = await request.json()
        token_id = body.get("token_id", "").strip()
        token_secret = body.get("token_secret", "").strip()
        if not token_id or not token_secret:
            return web.json_response({"status": "error", "message": "token_id and token_secret required"}, status=400)
        if not token_id.startswith("ak-") or not token_secret.startswith("as-"):
            return web.json_response({"status": "error", "message": "Invalid token format. Token ID starts with ak-, Secret starts with as-"}, status=400)
        try:
            _write_modal_toml(token_id, token_secret)
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)
        t = threading.Thread(target=_run_deploy_background, daemon=True)
        t.start()
        return web.json_response({"status": "ok"})

    @_server.routes.post("/comfymodal/prompt")
    async def modal_prompt(request: web.Request) -> web.Response:
        global _queue_worker_started, _item_counter

        body = await request.json()
        workflow = body.get("prompt", body)
        client_id = body.get("client_id", str(uuid.uuid4()))
        prompt_id = str(uuid.uuid4())

        import time
        async with _counter_lock:
            _item_counter += 1
            item_id = _item_counter
            extra_data = {"client_id": client_id, "create_time": int(time.time() * 1000)}
            item = (_item_counter, prompt_id, workflow, extra_data, list(workflow.keys()), {})

        pq = _pq()
        if pq:
            with pq.mutex:
                import heapq
                heapq.heappush(pq.queue, item)
                pq.server.queue_updated()

        await _queue.put((item, item_id))

        if not _queue_worker_started:
            _queue_worker_started = True
            asyncio.create_task(_process_queue())

        return web.json_response({
            "prompt_id": prompt_id,
            "number": _item_counter,
            "node_errors": {},
        })

    @_server.routes.post("/comfymodal/models/batch-install")
    async def modal_batch_model_install(request: web.Request) -> web.Response:
        body = await request.json()
        items = body.get("items", [])
        if not items:
            return web.json_response({"status": "error", "message": "items required"}, status=400)
        for it in items:
            if not it.get("url") or not it.get("filename"):
                return web.json_response({"status": "error", "message": "each item needs url and filename"}, status=400)
        try:
            results = await batch_download_models(items, hf_token=_read_hf_token())
            return web.json_response({"status": "ok", "results": results})
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    @_server.routes.post("/comfymodal/model/install")
    async def modal_model_install(request: web.Request) -> web.Response:
        body = await request.json()
        url = body.get("url", "")
        filename = body.get("filename", "")
        save_path = body.get("save_path", "checkpoints")

        if not url or not filename:
            return web.json_response(
                {"status": "error", "message": "url and filename required"},
                status=400,
            )

        try:
            result = await download_model(url=url, filename=filename, save_path=save_path, hf_token=_read_hf_token())
            return web.json_response({"status": "ok", **result})
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    @_server.routes.get("/comfymodal/deploy/status")
    async def modal_deploy_status(request: web.Request) -> web.Response:
        resp = dict(_deploy_status)
        resp.setdefault("has_log", os.path.isfile(_DEPLOY_LOG_FILE))
        if resp.get("state") != "error":
            resp.setdefault("details", "")
        return web.json_response(resp)

    @_server.routes.get("/comfymodal/deploy/log")
    async def modal_deploy_log(request: web.Request) -> web.Response:
        try:
            file_size = os.path.getsize(_DEPLOY_LOG_FILE)
            max_bytes = 512000  # 500KB
            with open(_DEPLOY_LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
                if file_size > max_bytes:
                    f.seek(file_size - max_bytes)
                    # Discard partial first line after seek
                    f.readline()
                    log = "[...truncated, showing last 500KB...]\n" + f.read()
                else:
                    log = f.read()
        except FileNotFoundError:
            log = ""
        return web.json_response({"log": log})

    @_server.routes.post("/comfymodal/deploy")
    async def modal_deploy_trigger(request: web.Request) -> web.Response:
        if _deploy_status.get("state") == "deploying":
            return web.json_response({"status": "already_deploying"})
        t = threading.Thread(target=_run_deploy_background, daemon=True)
        t.start()
        return web.json_response({"status": "started"})

    @_server.routes.get("/comfymodal/config")
    async def modal_get_config(request: web.Request) -> web.Response:
        return web.json_response({"gpu": get_gpu()})

    @_server.routes.post("/comfymodal/config")
    async def modal_set_config(request: web.Request) -> web.Response:
        body = await request.json()
        gpu = body.get("gpu", "")
        if not gpu:
            return web.json_response({"status": "error", "message": "gpu required"}, status=400)
        set_gpu(gpu)
        return web.json_response({"status": "ok", "gpu": get_gpu()})

    @_server.routes.get("/comfymodal/health")
    async def modal_health(request: web.Request) -> web.Response:
        mode = request.rel_url.query.get("mode", "deploy")
        if mode == "deploy":
            state = _deploy_status.get("state", "idle")
            if state == "ready":
                return web.json_response({"status": "ok", "mode": "deploy"})
            elif state == "deploying":
                return web.json_response({"status": "deploying"}, status=503)
            else:
                return web.json_response({"status": state, "message": _deploy_status.get("message", "")}, status=503)
        try:
            result = await asyncio.wait_for(health_check(), timeout=10)
            return web.json_response(result)
        except asyncio.TimeoutError:
            return web.json_response({"status": "error", "message": "timeout"}, status=503)
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=503)

    @_server.routes.get("/comfymodal/object_info")
    async def modal_object_info(request: web.Request) -> web.Response:
        try:
            result = await get_object_info()
            return web.json_response(result)
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=503)

    @_server.routes.delete("/comfymodal/cancel/{client_id}")
    async def modal_cancel(request: web.Request) -> web.Response:
        client_id = request.match_info.get("client_id", "")
        return web.json_response({"status": "not_supported"}, status=404)

    @_server.routes.get("/comfymodal/models")
    async def modal_list_models(request: web.Request) -> web.Response:
        try:
            result = await list_models()
            return web.json_response(result)
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=503)

    @_server.routes.delete("/comfymodal/models/{folder}/{filename}")
    async def modal_delete_model(request: web.Request) -> web.Response:
        folder = request.match_info.get("folder", "")
        filename = request.match_info.get("filename", "")
        if not folder or not filename:
            return web.json_response({"status": "error", "message": "folder and filename required"}, status=400)
        try:
            result = await delete_model(folder=folder, filename=filename)
            return web.json_response(result)
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    @_server.routes.get("/comfymodal/sync/status")
    async def modal_sync_status(request: web.Request) -> web.Response:
        """Get sync status: compare local models/custom_nodes with remote volumes."""
        try:
            # Get remote volume status
            remote = await get_sync_status()
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=503)

        # Scan local models
        models_root = os.path.join(_COMFYUI_ROOT, "models")
        local_models = []
        if os.path.isdir(models_root):
            for folder in os.listdir(models_root):
                folder_path = os.path.join(models_root, folder)
                if not os.path.isdir(folder_path):
                    continue
                for fname in os.listdir(folder_path):
                    fpath = os.path.join(folder_path, fname)
                    if os.path.isfile(fpath) and not fname.startswith("."):
                        size = os.path.getsize(fpath)
                        if size > 0:  # skip empty placeholder files
                            local_models.append({"folder": folder, "name": fname, "size": size})

        # Scan local custom nodes
        cn_root = os.path.join(_COMFYUI_ROOT, "custom_nodes")
        local_custom_nodes = []
        if os.path.isdir(cn_root):
            for d in os.listdir(cn_root):
                dpath = os.path.join(cn_root, d)
                if os.path.isdir(dpath) and not d.startswith(".") and d != "__pycache__":
                    local_custom_nodes.append(d)

        # Compare
        remote_models = remote.get("models", [])
        remote_model_keys = {f"{m['folder']}/{m['name']}" for m in remote_models}
        local_model_keys = {f"{m['folder']}/{m['name']}" for m in local_models}

        synced_models = [m for m in local_models if f"{m['folder']}/{m['name']}" in remote_model_keys]
        pending_models = [m for m in local_models if f"{m['folder']}/{m['name']}" not in remote_model_keys]

        remote_cn = set(remote.get("custom_nodes", []))
        local_cn_set = set(local_custom_nodes)
        synced_cn = sorted(local_cn_set & remote_cn)
        pending_cn = sorted(local_cn_set - remote_cn)

        return web.json_response({
            "status": "ok",
            "models": {
                "local": local_models,
                "remote": remote_models,
                "synced": synced_models,
                "pending": pending_models,
            },
            "custom_nodes": {
                "local": local_custom_nodes,
                "remote": sorted(remote_cn),
                "synced": synced_cn,
                "pending": pending_cn,
            },
        })

    @_server.routes.post("/comfymodal/sync/models")
    async def modal_sync_models(request: web.Request) -> web.Response:
        """Upload local models that are not yet on the remote volume."""
        CHUNK_SIZE = 100 * 1024 * 1024  # 100MB chunks

        try:
            remote = await get_sync_status()
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=503)

        remote_model_keys = {f"{m['folder']}/{m['name']}" for m in remote.get("models", [])}

        # Scan local models
        models_root = os.path.join(_COMFYUI_ROOT, "models")
        to_upload = []
        if os.path.isdir(models_root):
            for folder in os.listdir(models_root):
                folder_path = os.path.join(models_root, folder)
                if not os.path.isdir(folder_path):
                    continue
                for fname in os.listdir(folder_path):
                    fpath = os.path.join(folder_path, fname)
                    if not os.path.isfile(fpath) or fname.startswith("."):
                        continue
                    size = os.path.getsize(fpath)
                    if size == 0:
                        continue
                    key = f"{folder}/{fname}"
                    if key not in remote_model_keys:
                        to_upload.append({"folder": folder, "name": fname, "path": fpath, "size": size})

        if not to_upload:
            return web.json_response({"status": "ok", "message": "All models already synced", "uploaded": 0})

        uploaded = 0
        errors = []
        for item in to_upload:
            try:
                file_size = item["size"]
                offset = 0
                with open(item["path"], "rb") as f:
                    while True:
                        chunk = f.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        is_last = (offset + len(chunk)) >= file_size
                        await upload_model_chunk(
                            chunk_data=chunk,
                            folder=item["folder"],
                            filename=item["name"],
                            offset=offset,
                            is_last=is_last,
                        )
                        offset += len(chunk)
                uploaded += 1
            except Exception as e:
                errors.append({"name": f"{item['folder']}/{item['name']}", "error": str(e)})

        result = {"status": "ok", "uploaded": uploaded, "total": len(to_upload)}
        if errors:
            result["errors"] = errors
        return web.json_response(result)

    @_server.routes.post("/comfymodal/sync/custom-nodes")
    async def modal_sync_custom_nodes(request: web.Request) -> web.Response:
        """Package local custom_nodes directory and upload to Modal volume."""
        import tarfile
        import io

        cn_root = os.path.join(_COMFYUI_ROOT, "custom_nodes")
        if not os.path.isdir(cn_root):
            return web.json_response({"status": "error", "message": "custom_nodes directory not found"}, status=400)

        # Exclusion patterns
        exclude_dirs = {".git", "__pycache__", "node_modules", ".venv", "venv"}
        exclude_extensions = {".pyc", ".pyo"}

        def tar_filter(tarinfo):
            # Skip excluded directories and files
            parts = tarinfo.name.split("/")
            for part in parts:
                if part in exclude_dirs:
                    return None
            if any(tarinfo.name.endswith(ext) for ext in exclude_extensions):
                return None
            return tarinfo

        # Create tar.gz archive
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            for node_dir in os.listdir(cn_root):
                node_path = os.path.join(cn_root, node_dir)
                if not os.path.isdir(node_path):
                    continue
                if node_dir.startswith(".") or node_dir == "__pycache__":
                    continue
                tar.add(node_path, arcname=node_dir, filter=tar_filter)

        archive_data = buf.getvalue()

        try:
            result = await sync_custom_nodes(archive_data)
            return web.json_response(result)
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    print("[comfyui-modal] Routes registered: /comfymodal/prompt, /comfymodal/model/install, /comfymodal/models/batch-install, /comfymodal/health, /comfymodal/object_info, /comfymodal/cancel/{id}, /comfymodal/models, /comfymodal/sync/status, /comfymodal/sync/models, /comfymodal/sync/custom-nodes")
