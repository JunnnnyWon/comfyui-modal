import asyncio
import modal

_apis = {
    "a10g": modal.Cls.from_name("comfyui", "ComfyAPI"),
    "a100": modal.Cls.from_name("comfyui", "ComfyAPI_A100"),
    "t4":   modal.Cls.from_name("comfyui", "ComfyAPI_T4"),
}
_download_fn = modal.Function.from_name("comfyui", "download_model_to_volume")
_batch_download_fn = modal.Function.from_name("comfyui", "batch_download_models")

_current_gpu = "a10g"


def set_gpu(gpu: str):
    global _current_gpu
    if gpu in _apis:
        _current_gpu = gpu


def get_gpu() -> str:
    return _current_gpu


def _api():
    return _apis[_current_gpu]()


async def run_prompt(workflow: dict, input_images: dict = None) -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: _api().run_prompt.remote(workflow, input_images or {}),
    )


async def get_object_info() -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _api().object_info.remote)


async def health_check() -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _api().health.remote)


async def download_model(url: str, filename: str, save_path: str = "checkpoints", hf_token: str = "") -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: _download_fn.remote(url=url, filename=filename, save_path=save_path, hf_token=hf_token),
    )


async def batch_download_models(items: list, hf_token: str = "") -> list:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: _batch_download_fn.remote(items, hf_token=hf_token),
    )


async def list_models() -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _api().list_models.remote)


async def delete_model(folder: str, filename: str) -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: _api().delete_model.remote(folder=folder, filename=filename),
    )
