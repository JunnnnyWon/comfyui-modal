from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace


def _install_aiohttp_stub() -> None:
    aiohttp_module = ModuleType("aiohttp")
    aiohttp_module.web = SimpleNamespace(
        Request=object,
        Response=object,
        json_response=lambda *_args, **_kwargs: None,
    )
    sys.modules.setdefault("aiohttp", aiohttp_module)


def _install_modal_stub() -> None:
    modal_module = ModuleType("modal")
    sys.modules.setdefault("modal", modal_module)


def _install_modal_client_stub() -> None:
    sys.modules.setdefault("modal_client", ModuleType("modal_client"))


_install_aiohttp_stub()
_install_modal_stub()
_install_modal_client_stub()
