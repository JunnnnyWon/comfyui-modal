from __future__ import annotations

import base64
import importlib.util
import json
import pathlib
import sys
from types import ModuleType, SimpleNamespace
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable

import pytest


class _FakeImageBuilder:
    def apt_install(self, *_args: object, **_kwargs: object) -> "_FakeImageBuilder":
        return self

    def pip_install(self, *_args: object, **_kwargs: object) -> "_FakeImageBuilder":
        return self

    def run_commands(self, *_args: object, **_kwargs: object) -> "_FakeImageBuilder":
        return self


class _FakeImage:
    @staticmethod
    def debian_slim(*_args: object, **_kwargs: object) -> _FakeImageBuilder:
        return _FakeImageBuilder()


class _FakeVolumeHandle:
    def commit(self) -> None:
        return None

    def reload(self) -> None:
        return None


class _FailingReloadVolume:
    def commit(self) -> None:
        return None

    def reload(self) -> None:
        msg = "run_prompt should not reload the models volume"
        raise AssertionError(msg)


class _FakeApp:
    def __init__(self, *_args: object, **_kwargs: object) -> None:
        return None

    def function(
        self,
        *_args: object,
        **_kwargs: object,
    ) -> Callable[[object], object]:
        def decorator(value: object) -> object:
            return value

        return decorator

    def cls(
        self,
        *_args: object,
        **_kwargs: object,
    ) -> Callable[[type[object]], type[object]]:
        def decorator(value: type[object]) -> type[object]:
            return value

        return decorator


class _FakeResponse:
    def __init__(self, payload: dict[str, str]) -> None:
        self._payload = payload

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(
        self,
        _exc_type: object,
        _exc: object,
        _tb: object,
    ) -> bool:
        return False

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")


def _fake_modal_module() -> ModuleType:
    fake_modal = ModuleType("modal")
    fake_modal.Image = _FakeImage
    fake_modal.App = _FakeApp
    fake_modal.Volume = SimpleNamespace(
        from_name=lambda *_args, **_kwargs: _FakeVolumeHandle(),
    )
    fake_modal.web_server = lambda *_args, **_kwargs: (lambda value: value)
    fake_modal.method = lambda *_args, **_kwargs: (lambda value: value)
    fake_modal.enter = lambda *_args, **_kwargs: (lambda value: value)
    fake_modal.exit = lambda *_args, **_kwargs: (lambda value: value)
    fake_modal.concurrent = lambda *_args, **_kwargs: (lambda value: value)
    return fake_modal


def _load_comfyapp(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    spec = importlib.util.spec_from_file_location("comfyapp_under_test", "comfyapp.py")
    assert spec is not None
    assert spec.loader is not None

    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "modal", _fake_modal_module())
    sys.modules.pop("comfyapp_under_test", None)
    spec.loader.exec_module(module)
    return module


def test_run_prompt_stages_relative_input_paths(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: pathlib.Path,
) -> None:
    comfyapp = _load_comfyapp(monkeypatch)
    remote_input_dir = tmp_path / "remote-input"
    original_path = pathlib.Path

    def fake_path(value: str | pathlib.Path) -> pathlib.Path:
        if value == "/root/comfy/ComfyUI/input":
            return original_path(remote_input_dir)
        return original_path(value)

    requests: list[object] = []

    def fake_urlopen(request: object) -> _FakeResponse:
        requests.append(request)
        return _FakeResponse({"prompt_id": "prompt-1"})

    class FakeAPI(comfyapp._ComfyAPIMixin):
        def _poll_until_done(self, prompt_id: str, client_id: str) -> dict[str, str]:
            return {"prompt_id": prompt_id, "client_id": client_id}

    monkeypatch.setattr(pathlib, "Path", fake_path)
    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    api = FakeAPI()
    result = api.run_prompt(
        workflow={"17": {"class_type": "LoadImage", "inputs": {"image": "clipspace/mask.png"}}},
        input_images={
            "clipspace/mask.png": base64.b64encode(b"mask-bytes").decode("ascii"),
        },
    )

    assert result["prompt_id"] == "prompt-1"
    assert requests
    assert (remote_input_dir / "clipspace" / "mask.png").read_bytes() == b"mask-bytes"


def test_run_prompt_submits_prompt_without_reloading_model_volume(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    comfyapp = _load_comfyapp(monkeypatch)

    class FakeAPI(comfyapp._ComfyAPIMixin):
        def _poll_until_done(self, prompt_id: str, client_id: str) -> dict[str, str]:
            return {"prompt_id": prompt_id, "client_id": client_id}

    def fake_urlopen(_request: object) -> _FakeResponse:
        return _FakeResponse({"prompt_id": "prompt-2"})

    monkeypatch.setattr(comfyapp, "vol", _FailingReloadVolume())
    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    api = FakeAPI()
    result = api.run_prompt(workflow={"17": {"class_type": "LoadImage", "inputs": {}}})

    assert result["prompt_id"] == "prompt-2"
