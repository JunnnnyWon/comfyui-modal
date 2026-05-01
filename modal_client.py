import asyncio
import modal

_apis = {
    "a10g":     modal.Cls.from_name("comfyui", "ComfyAPI"),
    "a100":     modal.Cls.from_name("comfyui", "ComfyAPI_A100"),
    "a100-80gb": modal.Cls.from_name("comfyui", "ComfyAPI_A100_80"),
    "t4":       modal.Cls.from_name("comfyui", "ComfyAPI_T4"),
    "l4":       modal.Cls.from_name("comfyui", "ComfyAPI_L4"),
    "l40s":     modal.Cls.from_name("comfyui", "ComfyAPI_L40S"),
    "h100":     modal.Cls.from_name("comfyui", "ComfyAPI_H100"),
    "h200":     modal.Cls.from_name("comfyui", "ComfyAPI_H200"),
}
_download_fn = modal.Function.from_name("comfyui", "download_model_to_volume")
_batch_download_fn = modal.Function.from_name("comfyui", "batch_download_models")
_list_models_fn = modal.Function.from_name("comfyui", "list_models_fn")
_delete_model_fn = modal.Function.from_name("comfyui", "delete_model_fn")
_get_nodes_fn = modal.Function.from_name("comfyui", "get_nodes_json")
_save_nodes_fn = modal.Function.from_name("comfyui", "save_nodes_json")

_current_gpu = "a10g"


def set_gpu(gpu: str):
    global _current_gpu
    if gpu in _apis:
        _current_gpu = gpu


def get_gpu() -> str:
    return _current_gpu


def _api():
    return _apis[_current_gpu]()


async def convert_workflow(workflow: dict) -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: _api().convert_workflow.remote(workflow),
    )


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


async def download_model(url: str, filename: str, save_path: str = "checkpoints", hf_token=None, civitai_token=None) -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: _download_fn.remote(
            url=url,
            filename=filename,
            save_path=save_path,
            hf_token=hf_token,
            civitai_token=civitai_token,
        ),
    )


async def batch_download_models(items: list) -> list:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: _batch_download_fn.remote(items),
    )


async def list_models() -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _list_models_fn.remote)


async def delete_model(folder: str, filename: str) -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: _delete_model_fn.remote(folder=folder, filename=filename),
    )


async def get_nodes() -> list:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _get_nodes_fn.remote)


async def save_nodes(nodes: list) -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: _save_nodes_fn.remote(nodes))
