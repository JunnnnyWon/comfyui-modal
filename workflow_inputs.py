from __future__ import annotations

import base64
import copy
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Final

_ANNOTATED_INPUT_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^(?P<path>.+?) \[(?P<location>input|output|temp)\]$",
)
_DEFAULT_SEARCH_DIRECTORIES: Final[tuple[str, ...]] = ("input", "output")


@dataclass(frozen=True, slots=True)
class PreparedWorkflowInputs:
    workflow: dict[str, object]
    input_images: dict[str, str]
    missing_files: tuple[str, ...]


def prepare_local_workflow_inputs(
    workflow: dict[str, object],
    comfyui_root: Path,
) -> PreparedWorkflowInputs:
    prepared_workflow = copy.deepcopy(workflow)
    input_images: dict[str, str] = {}
    missing_files: list[str] = []

    for node in prepared_workflow.values():
        if not isinstance(node, dict):
            continue

        class_type = node.get("class_type")
        if not isinstance(class_type, str) or not class_type.startswith("LoadImage"):
            continue

        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue

        for field_name in ("image", "mask"):
            raw_reference = inputs.get(field_name)
            if not isinstance(raw_reference, str) or not raw_reference:
                continue
            if raw_reference.startswith(("http://", "https://")):
                continue

            resolved = _resolve_local_reference(raw_reference, comfyui_root)
            if resolved is None:
                missing_files.append(raw_reference)
                continue

            remote_reference, local_path = resolved
            if remote_reference not in input_images:
                input_images[remote_reference] = base64.b64encode(
                    local_path.read_bytes(),
                ).decode("ascii")
            inputs[field_name] = remote_reference

    return PreparedWorkflowInputs(
        workflow=prepared_workflow,
        input_images=input_images,
        missing_files=tuple(missing_files),
    )


def stage_remote_input_images(input_dir: Path, input_images: dict[str, str]) -> None:
    input_dir.mkdir(parents=True, exist_ok=True)
    for remote_reference, encoded_bytes in input_images.items():
        relative_path = _safe_relative_path(remote_reference)
        destination = input_dir / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(base64.b64decode(encoded_bytes))


def _resolve_local_reference(
    raw_reference: str,
    comfyui_root: Path,
) -> tuple[str, Path] | None:
    stripped_reference, preferred_directory = _split_annotation(raw_reference)
    relative_path = _safe_relative_path(stripped_reference)

    for directory_name in _search_directories(preferred_directory):
        candidate = comfyui_root / directory_name / relative_path
        if candidate.is_file():
            return relative_path.as_posix(), candidate
    return None


def _split_annotation(raw_reference: str) -> tuple[str, str | None]:
    match = _ANNOTATED_INPUT_PATTERN.fullmatch(raw_reference)
    if match is None:
        return raw_reference, None
    return match.group("path"), match.group("location")


def _safe_relative_path(reference: str) -> Path:
    relative_path = Path(reference.replace("\\", "/"))
    if relative_path.is_absolute() or ".." in relative_path.parts:
        msg = f"Unsafe workflow input path: {reference}"
        raise ValueError(msg)
    return relative_path


def _search_directories(preferred_directory: str | None) -> tuple[str, ...]:
    if preferred_directory is None:
        return _DEFAULT_SEARCH_DIRECTORIES
    if preferred_directory == "temp":
        return ("temp",) + _DEFAULT_SEARCH_DIRECTORIES
    if preferred_directory == "input":
        return _DEFAULT_SEARCH_DIRECTORIES
    return (preferred_directory, "input")
