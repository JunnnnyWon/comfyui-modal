from __future__ import annotations

import importlib.util
import pathlib
import sys
from types import ModuleType, SimpleNamespace


def _load_module_without_repo_path(
    module_filename: str,
    module_name: str,
) -> ModuleType:
    repo_root = pathlib.Path(__file__).resolve().parent.parent
    module_path = repo_root / module_filename

    sys.modules.pop("workflow_inputs", None)
    sys.path = [
        entry
        for entry in sys.path
        if entry not in ("", ".") and pathlib.Path(entry).resolve() != repo_root
    ]

    spec = importlib.util.spec_from_file_location(module_name, module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_init_bootstraps_repo_path_before_importing_workflow_inputs() -> None:
    aiohttp_module = ModuleType("aiohttp")
    aiohttp_module.web = SimpleNamespace(
        Request=object,
        Response=object,
        json_response=lambda *_args, **_kwargs: None,
    )
    sys.modules["aiohttp"] = aiohttp_module

    modal_client = ModuleType("modal_client")
    for name in (
        "run_prompt",
        "get_object_info",
        "health_check",
        "download_model",
        "batch_download_models",
        "list_models",
        "delete_model",
        "set_gpu",
        "get_gpu",
        "sync_custom_nodes",
        "get_sync_status",
        "upload_model_to_volume",
        "upload_model_chunk",
        "clear_cache",
    ):
        setattr(modal_client, name, lambda *_args, **_kwargs: None)
    sys.modules["modal_client"] = modal_client

    loaded = _load_module_without_repo_path("__init__.py", "comfyui_modal_import_test")

    assert loaded._NODE_DIR in sys.path


def test_comfyapp_bootstraps_repo_path_before_importing_workflow_inputs() -> None:
    fake_modal = ModuleType("modal")

    class FakeImageBuilder:
        def apt_install(self, *_args: object, **_kwargs: object) -> "FakeImageBuilder":
            return self

        def pip_install(self, *_args: object, **_kwargs: object) -> "FakeImageBuilder":
            return self

        def run_commands(self, *_args: object, **_kwargs: object) -> "FakeImageBuilder":
            return self

        def add_local_python_source(self, *_args: object, **_kwargs: object) -> "FakeImageBuilder":
            return self

    class FakeImage:
        @staticmethod
        def debian_slim(*_args: object, **_kwargs: object) -> FakeImageBuilder:
            return FakeImageBuilder()

    class FakeApp:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            return None

        def function(self, *_args: object, **_kwargs: object):
            return lambda value: value

        def cls(self, *_args: object, **_kwargs: object):
            return lambda value: value

    fake_modal.Image = FakeImage
    fake_modal.App = FakeApp
    fake_modal.Volume = SimpleNamespace(
        from_name=lambda *_args, **_kwargs: SimpleNamespace(),
    )
    fake_modal.web_server = lambda *_args, **_kwargs: (lambda value: value)
    fake_modal.method = lambda *_args, **_kwargs: (lambda value: value)
    fake_modal.enter = lambda *_args, **_kwargs: (lambda value: value)
    fake_modal.exit = lambda *_args, **_kwargs: (lambda value: value)
    fake_modal.concurrent = lambda *_args, **_kwargs: (lambda value: value)
    sys.modules["modal"] = fake_modal

    loaded = _load_module_without_repo_path("comfyapp.py", "comfyapp_import_test")

    assert loaded._NODE_DIR in sys.path
