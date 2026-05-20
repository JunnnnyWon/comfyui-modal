import asyncio
import functools
import modal

_apis = {
    "a10g": modal.Cls.from_name("comfyui", "ComfyAPI"),
    "a100": modal.Cls.from_name("comfyui", "ComfyAPI_A100"),
    "t4":   modal.Cls.from_name("comfyui", "ComfyAPI_T4"),
}
_download_fn = modal.Function.from_name("comfyui", "download_model_to_volume")
_batch_download_fn = modal.Function.from_name("comfyui", "batch_download_models")
_sync_custom_nodes_fn = modal.Function.from_name("comfyui", "sync_custom_nodes_to_volume")
_get_volume_status_fn = modal.Function.from_name("comfyui", "get_volume_status")
_upload_model_fn = modal.Function.from_name("comfyui", "upload_model_to_volume")

_current_gpu = "a10g"
_api_instances = {}


def set_gpu(gpu: str):
    global _current_gpu
    if gpu in _apis:
        _current_gpu = gpu


def get_gpu() -> str:
    return _current_gpu


def _api():
    if _current_gpu not in _api_instances:
        _api_instances[_current_gpu] = _apis[_current_gpu]()
    return _api_instances[_current_gpu]


def clear_cache():
    """Clear cached API instance handles so subsequent requests use fresh handles."""
    _api_instances.clear()


def _modal_error_handler(func):
    """Decorator that catches common exceptions and re-raises with user-friendly messages."""
    @functools.wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)
        except (ConnectionError, OSError) as e:
            raise ConnectionError(
                "Modal connection failed. Check your internet connection and Modal token."
            ) from e
        except TimeoutError as e:
            raise TimeoutError(
                "Modal request timed out. The container may be cold-starting (1-3 min)."
            ) from e
        except Exception as e:
            if getattr(type(e), "__module__", "").startswith("modal"):
                raise RuntimeError(
                    f"Modal error: {e}. Try redeploying with the Deploy button."
                ) from e
            raise
    return wrapper


@_modal_error_handler
async def run_prompt(workflow: dict, input_images: dict = None) -> dict:
    return await asyncio.to_thread(
        lambda: _api().run_prompt.remote(workflow, input_images or {}),
    )


@_modal_error_handler
async def get_object_info() -> dict:
    return await asyncio.to_thread(lambda: _api().object_info.remote())


@_modal_error_handler
async def health_check() -> dict:
    return await asyncio.to_thread(lambda: _api().health.remote())


@_modal_error_handler
async def download_model(url: str, filename: str, save_path: str = "checkpoints", hf_token: str = "") -> dict:
    return await asyncio.to_thread(
        lambda: _download_fn.remote(url=url, filename=filename, save_path=save_path, hf_token=hf_token),
    )


@_modal_error_handler
async def batch_download_models(items: list, hf_token: str = "") -> list:
    return await asyncio.to_thread(
        lambda: _batch_download_fn.remote(items, hf_token=hf_token),
    )


@_modal_error_handler
async def list_models() -> dict:
    return await asyncio.to_thread(lambda: _api().list_models.remote())


@_modal_error_handler
async def delete_model(folder: str, filename: str) -> dict:
    return await asyncio.to_thread(
        lambda: _api().delete_model.remote(folder=folder, filename=filename),
    )


@_modal_error_handler
async def sync_custom_nodes(archive_data: bytes) -> dict:
    return await asyncio.to_thread(
        lambda: _sync_custom_nodes_fn.remote(archive_data),
    )


@_modal_error_handler
async def get_sync_status() -> dict:
    return await asyncio.to_thread(
        lambda: _get_volume_status_fn.remote(),
    )


@_modal_error_handler
async def upload_model_to_volume(file_data: bytes, folder: str, filename: str) -> dict:
    return await asyncio.to_thread(
        lambda: _upload_model_fn.remote(file_data, folder, filename),
    )
