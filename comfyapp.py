import subprocess
import sys
import time
import json
import uuid
import modal

# Bump this version whenever comfyapp.py changes.
# The custom node compares this against the last deployed version
# and re-runs `modal deploy` only when the version changes.
COMFYAPP_VERSION = "1.1.1"

APP_NAME = "comfyui"
VOLUME_NAME = "comfyui-models"
COMFYUI_PORT = 8188
COMFYUI_API_PORT = 8189
MODELS_PATH = "/root/models"

CUSTOM_NODES = [
    "comfyui-manager",
]

SUPPORTED_GPUS = ["a10g", "a100", "a100-80gb", "t4", "l4", "l40s", "h100", "h200"]

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "git",
        "libgl1",
        "libglib2.0-0",
        "libsm6",
        "libxrender1",
        "libxext6",
        "ffmpeg",
    )
    .pip_install("comfy-cli==1.3.7")
    .run_commands(
        "comfy --skip-prompt install --nvidia",
        gpu="a10g",
    )
    .run_commands(
        *[f"comfy node install {node}" for node in CUSTOM_NODES],
        gpu="a10g",
    )
    .run_commands("rm -rf /root/comfy/ComfyUI/models && ln -s /root/models /root/comfy/ComfyUI/models")
)

download_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("httpx>=0.27.0", "huggingface_hub>=0.20.0")
)

app = modal.App(APP_NAME, image=image)
vol = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)


@app.function(
    gpu="a10g",
    cpu=4,
    memory=16384,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
)
@modal.web_server(COMFYUI_PORT, startup_timeout=300)
def ui():
    subprocess.Popen(
        f"comfy launch -- --listen 0.0.0.0 --port {COMFYUI_PORT}",
        shell=True,
    )


@app.function(
    image=download_image,
    cpu=2,
    memory=512,
    timeout=1800,
    volumes={MODELS_PATH: vol},
)
def download_model_to_volume(url: str, filename: str, save_path: str = "checkpoints", hf_token=None, civitai_token=None):
    import httpx
    from pathlib import Path

    dest = Path(MODELS_PATH) / save_path / filename
    dest.parent.mkdir(parents=True, exist_ok=True)

    if dest.exists():
        return {"status": "ok", "skipped": True, "path": str(dest)}

    # HuggingFace download
    if "huggingface.co" in url:
        from huggingface_hub import hf_hub_download  # pyright: ignore[reportMissingImports]
        import re, shutil
        # Parse repo_id and filename from URL
        # e.g. https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors
        match = re.search(r"huggingface\.co/([^/]+/[^/]+)/resolve/[^/]+/(.+)", url)
        if match:
            repo_id = match.group(1)
            hf_filename = match.group(2)
        else:
            # Fallback: try blob URL pattern
            match2 = re.search(r"huggingface\.co/([^/]+/[^/]+)/blob/[^/]+/(.+)", url)
            if match2:
                repo_id = match2.group(1)
                hf_filename = match2.group(2)
            else:
                # Cannot parse — fall through to httpx download with token header
                headers = {}
                if hf_token:
                    headers["Authorization"] = f"Bearer {hf_token}"
                with httpx.stream("GET", url, follow_redirects=True, timeout=1800, headers=headers) as r:
                    r.raise_for_status()
                    with open(dest, "wb") as f:
                        for chunk in r.iter_bytes(chunk_size=65536):
                            f.write(chunk)
                vol.commit()
                return {"status": "ok", "path": str(dest)}
        tmp = hf_hub_download(
            repo_id=repo_id,
            filename=hf_filename,
            token=hf_token or None,
            local_dir=str(dest.parent),
        )
        # hf_hub_download saves to local_dir/filename — rename to exact dest if needed
        tmp_path = Path(tmp)
        if tmp_path != dest:
            shutil.move(str(tmp_path), str(dest))
        vol.commit()
        return {"status": "ok", "path": str(dest)}

    if "civitai.com" in url or "civitai.red" in url:
        headers = {}
        if civitai_token:
            headers["Authorization"] = f"Bearer {civitai_token}"
        with httpx.stream("GET", url, follow_redirects=True, timeout=1800, headers=headers) as r:
            r.raise_for_status()
            total = int(r.headers.get("content-length", 0))
            downloaded = 0
            with open(dest, "wb") as f:
                for chunk in r.iter_bytes(chunk_size=65536):
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = downloaded / total * 100
                        sys.stdout.write(f"\r  {pct:.1f}%  ({downloaded // 1024**2} MB / {total // 1024**2} MB)")
                        sys.stdout.flush()
        vol.commit()
        return {"status": "ok", "path": str(dest)}

    headers = {}
    if hf_token:
        headers["Authorization"] = f"Bearer {hf_token}"
    elif civitai_token:
        headers["Authorization"] = f"Bearer {civitai_token}"
    with httpx.stream("GET", url, follow_redirects=True, timeout=1800, headers=headers) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        downloaded = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_bytes(chunk_size=65536):
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = downloaded / total * 100
                    sys.stdout.write(f"\r  {pct:.1f}%  ({downloaded // 1024**2} MB / {total // 1024**2} MB)")
                    sys.stdout.flush()

    vol.commit()
    return {"status": "ok", "path": str(dest)}


@app.function(
    image=download_image,
    cpu=2,
    memory=512,
    timeout=1800,
    volumes={MODELS_PATH: vol},
)
def batch_download_models(items: list) -> list:
    results = list(
        download_model_to_volume.starmap(
            [
                (
                    item["url"],
                    item["filename"],
                    item.get("save_path", "checkpoints"),
                    item.get("hf_token"),
                    item.get("civitai_token"),
                )
                for item in items
            ]
        )
    )
    return results


@app.function(
    cpu=2,
    memory=4096,
    timeout=3600,
    volumes={MODELS_PATH: vol},
)
def download(url: str, dest: str = "checkpoints"):
    import os
    import urllib.request

    dest_dir = os.path.join(MODELS_PATH, dest)
    os.makedirs(dest_dir, exist_ok=True)

    filename = url.split("/")[-1].split("?")[0]
    output_path = os.path.join(dest_dir, filename)

    print(f"Downloading: {url}")
    print(f"Destination: {output_path}")

    def progress(block_num, block_size, total_size):
        if total_size > 0:
            percent = min(block_num * block_size / total_size * 100, 100)
            sys.stdout.write(f"\r  {percent:.1f}%")
            sys.stdout.flush()

    urllib.request.urlretrieve(url, output_path, reporthook=progress)
    print(f"\nDone: {output_path}")
    vol.commit()


@app.function(volumes={MODELS_PATH: vol})
def list_models():
    import os

    for root, dirs, files in os.walk(MODELS_PATH):
        level = root.replace(MODELS_PATH, "").count(os.sep)
        indent = "  " * level
        folder = os.path.basename(root)
        if level == 0:
            print("models/")
        else:
            print(f"{indent}{folder}/")
        for f in sorted(files):
            size = os.path.getsize(os.path.join(root, f))
            size_str = f"{size / 1024**3:.2f} GB" if size > 1024**2 else f"{size / 1024:.0f} KB"
            print(f"{indent}  {f}  ({size_str})")


@app.cls(
    gpu="a10g",
    cpu=4,
    memory=16384,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
)
class ComfyAPI:
    @modal.enter()
    def startup(self):
        self._proc = subprocess.Popen(
            ["comfy", "launch", "--", "--listen", "0.0.0.0",
             f"--port={COMFYUI_API_PORT}", "--disable-auto-launch"],
        )
        self._wait_for_comfy()

    @modal.exit()
    def shutdown(self):
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()

    def _wait_for_comfy(self):
        import urllib.request
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/system_stats")
                return
            except Exception:
                time.sleep(1)
        raise RuntimeError("ComfyUI API failed to start")

    @modal.method()
    def object_info(self):
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/object_info") as r:
            return json.loads(r.read())

    @modal.method()
    def run_prompt(self, workflow: dict, input_images: dict = None) -> dict:
        import urllib.request
        import base64
        from pathlib import Path

        if input_images:
            input_dir = Path("/root/comfy/ComfyUI/input")
            input_dir.mkdir(parents=True, exist_ok=True)
            for filename, b64data in input_images.items():
                dest = input_dir / Path(filename).name
                dest.write_bytes(base64.b64decode(b64data))

        client_id = str(uuid.uuid4())
        payload = json.dumps({"prompt": workflow, "client_id": client_id}).encode()

        req = urllib.request.Request(
            f"http://127.0.0.1:{COMFYUI_API_PORT}/prompt",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req) as r:
            queued = json.loads(r.read())

        prompt_id = queued["prompt_id"]
        return self._poll_until_done(prompt_id, client_id)

    def _poll_until_done(self, prompt_id: str, client_id: str) -> dict:
        import urllib.request
        for _ in range(3600):
            with urllib.request.urlopen(
                f"http://127.0.0.1:{COMFYUI_API_PORT}/history/{prompt_id}"
            ) as r:
                history = json.loads(r.read())
            if prompt_id in history:
                outputs = history[prompt_id].get("outputs", {})
                return self._collect_outputs(outputs)
            time.sleep(1)
        raise TimeoutError(f"Prompt {prompt_id} timed out")

    def _collect_outputs(self, outputs: dict) -> dict:
        import urllib.request
        import base64

        images = []
        videos = []

        for node_id, node_output in outputs.items():
            for img in node_output.get("images", []):
                animated = node_output.get("animated", (False,))
                is_animated = animated[0] if animated else False
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={img['filename']}&subfolder={img.get('subfolder','')}&type={img.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                entry = {"filename": img["filename"], "data": data, "node_id": node_id}
                if is_animated:
                    videos.append(entry)
                else:
                    images.append(entry)

            for vid in node_output.get("gifs", []):
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={vid['filename']}&subfolder={vid.get('subfolder','')}&type={vid.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                videos.append({"filename": vid["filename"], "data": data, "node_id": node_id})

        return {"images": images, "videos": videos}

    @modal.method()
    def health(self):
        return {"status": "ok"}

    @modal.method()
    def list_models(self):
        import os
        # Standalone folders shown as their own sections
        solo_folders = ["loras", "vae", "controlnet", "upscale_models",
                        "embeddings", "clip", "text_encoders"]
        result = {}
        for folder in solo_folders:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                result[folder] = []
                continue
            files = []
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    files.append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
            result[folder] = files
        # Checkpoint-family folders all shown under "checkpoints" in the sidebar,
        # but each file carries its real "folder" so inject/delete uses the right path.
        checkpoint_family = ["checkpoints", "diffusion_models", "unet"]
        result["checkpoints"] = []
        for folder in checkpoint_family:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                continue
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    result["checkpoints"].append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
        return result

    @modal.method()
    def delete_model(self, folder: str, filename: str):
        import os
        safe_folder = os.path.basename(folder)
        safe_file = os.path.basename(filename)
        target = os.path.join(MODELS_PATH, safe_folder, safe_file)
        if not os.path.isfile(target):
            return {"status": "error", "message": "File not found"}
        os.remove(target)
        vol.commit()
        return {"status": "ok", "deleted": f"{safe_folder}/{safe_file}"}


@app.cls(
    gpu="a100",
    cpu=4,
    memory=32768,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
)
class ComfyAPI_A100:
    @modal.enter()
    def startup(self):
        self._proc = subprocess.Popen(
            ["comfy", "launch", "--", "--listen", "0.0.0.0",
             f"--port={COMFYUI_API_PORT}", "--disable-auto-launch"],
        )
        self._wait_for_comfy()

    @modal.exit()
    def shutdown(self):
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()

    def _wait_for_comfy(self):
        import urllib.request
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/system_stats")
                return
            except Exception:
                time.sleep(1)
        raise RuntimeError("ComfyUI API failed to start")

    @modal.method()
    def object_info(self):
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/object_info") as r:
            return json.loads(r.read())

    @modal.method()
    def run_prompt(self, workflow: dict, input_images: dict = None) -> dict:
        import urllib.request
        import base64
        from pathlib import Path

        if input_images:
            input_dir = Path("/root/comfy/ComfyUI/input")
            input_dir.mkdir(parents=True, exist_ok=True)
            for filename, b64data in input_images.items():
                dest = input_dir / Path(filename).name
                dest.write_bytes(base64.b64decode(b64data))

        client_id = str(uuid.uuid4())
        payload = json.dumps({"prompt": workflow, "client_id": client_id}).encode()

        req = urllib.request.Request(
            f"http://127.0.0.1:{COMFYUI_API_PORT}/prompt",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req) as r:
            queued = json.loads(r.read())

        prompt_id = queued["prompt_id"]
        return self._poll_until_done(prompt_id, client_id)

    def _poll_until_done(self, prompt_id: str, client_id: str) -> dict:
        import urllib.request
        for _ in range(3600):
            with urllib.request.urlopen(
                f"http://127.0.0.1:{COMFYUI_API_PORT}/history/{prompt_id}"
            ) as r:
                history = json.loads(r.read())
            if prompt_id in history:
                outputs = history[prompt_id].get("outputs", {})
                return self._collect_outputs(outputs)
            time.sleep(1)
        raise TimeoutError(f"Prompt {prompt_id} timed out")

    def _collect_outputs(self, outputs: dict) -> dict:
        import urllib.request
        import base64

        images = []
        videos = []

        for node_id, node_output in outputs.items():
            for img in node_output.get("images", []):
                animated = node_output.get("animated", (False,))
                is_animated = animated[0] if animated else False
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={img['filename']}&subfolder={img.get('subfolder','')}&type={img.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                entry = {"filename": img["filename"], "data": data, "node_id": node_id}
                if is_animated:
                    videos.append(entry)
                else:
                    images.append(entry)

            for vid in node_output.get("gifs", []):
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={vid['filename']}&subfolder={vid.get('subfolder','')}&type={vid.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                videos.append({"filename": vid["filename"], "data": data, "node_id": node_id})

        return {"images": images, "videos": videos}

    @modal.method()
    def health(self):
        return {"status": "ok"}

    @modal.method()
    def list_models(self):
        import os
        # Standalone folders shown as their own sections
        solo_folders = ["loras", "vae", "controlnet", "upscale_models",
                        "embeddings", "clip", "text_encoders"]
        result = {}
        for folder in solo_folders:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                result[folder] = []
                continue
            files = []
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    files.append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
            result[folder] = files
        # Checkpoint-family folders all shown under "checkpoints" in the sidebar,
        # but each file carries its real "folder" so inject/delete uses the right path.
        checkpoint_family = ["checkpoints", "diffusion_models", "unet"]
        result["checkpoints"] = []
        for folder in checkpoint_family:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                continue
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    result["checkpoints"].append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
        return result

    @modal.method()
    def delete_model(self, folder: str, filename: str):
        import os
        safe_folder = os.path.basename(folder)
        safe_file = os.path.basename(filename)
        target = os.path.join(MODELS_PATH, safe_folder, safe_file)
        if not os.path.isfile(target):
            return {"status": "error", "message": "File not found"}
        os.remove(target)
        vol.commit()
        return {"status": "ok", "deleted": f"{safe_folder}/{safe_file}"}


@app.cls(
    gpu="t4",
    cpu=2,
    memory=8192,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
)
class ComfyAPI_T4:
    @modal.enter()
    def startup(self):
        self._proc = subprocess.Popen(
            ["comfy", "launch", "--", "--listen", "0.0.0.0",
             f"--port={COMFYUI_API_PORT}", "--disable-auto-launch"],
        )
        self._wait_for_comfy()

    @modal.exit()
    def shutdown(self):
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()

    def _wait_for_comfy(self):
        import urllib.request
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/system_stats")
                return
            except Exception:
                time.sleep(1)
        raise RuntimeError("ComfyUI API failed to start")

    @modal.method()
    def object_info(self):
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/object_info") as r:
            return json.loads(r.read())

    @modal.method()
    def run_prompt(self, workflow: dict, input_images: dict = None) -> dict:
        import urllib.request
        import base64
        from pathlib import Path

        if input_images:
            input_dir = Path("/root/comfy/ComfyUI/input")
            input_dir.mkdir(parents=True, exist_ok=True)
            for filename, b64data in input_images.items():
                dest = input_dir / Path(filename).name
                dest.write_bytes(base64.b64decode(b64data))

        client_id = str(uuid.uuid4())
        payload = json.dumps({"prompt": workflow, "client_id": client_id}).encode()

        req = urllib.request.Request(
            f"http://127.0.0.1:{COMFYUI_API_PORT}/prompt",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req) as r:
            queued = json.loads(r.read())

        prompt_id = queued["prompt_id"]
        return self._poll_until_done(prompt_id, client_id)

    def _poll_until_done(self, prompt_id: str, client_id: str) -> dict:
        import urllib.request
        for _ in range(3600):
            with urllib.request.urlopen(
                f"http://127.0.0.1:{COMFYUI_API_PORT}/history/{prompt_id}"
            ) as r:
                history = json.loads(r.read())
            if prompt_id in history:
                outputs = history[prompt_id].get("outputs", {})
                return self._collect_outputs(outputs)
            time.sleep(1)
        raise TimeoutError(f"Prompt {prompt_id} timed out")

    def _collect_outputs(self, outputs: dict) -> dict:
        import urllib.request
        import base64

        images = []
        videos = []

        for node_id, node_output in outputs.items():
            for img in node_output.get("images", []):
                animated = node_output.get("animated", (False,))
                is_animated = animated[0] if animated else False
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={img['filename']}&subfolder={img.get('subfolder','')}&type={img.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                entry = {"filename": img["filename"], "data": data, "node_id": node_id}
                if is_animated:
                    videos.append(entry)
                else:
                    images.append(entry)

            for vid in node_output.get("gifs", []):
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={vid['filename']}&subfolder={vid.get('subfolder','')}&type={vid.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                videos.append({"filename": vid["filename"], "data": data, "node_id": node_id})

        return {"images": images, "videos": videos}

    @modal.method()
    def health(self):
        return {"status": "ok"}

    @modal.method()
    def list_models(self):
        import os
        # Standalone folders shown as their own sections
        solo_folders = ["loras", "vae", "controlnet", "upscale_models",
                        "embeddings", "clip", "text_encoders"]
        result = {}
        for folder in solo_folders:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                result[folder] = []
                continue
            files = []
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    files.append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
            result[folder] = files
        # Checkpoint-family folders all shown under "checkpoints" in the sidebar,
        # but each file carries its real "folder" so inject/delete uses the right path.
        checkpoint_family = ["checkpoints", "diffusion_models", "unet"]
        result["checkpoints"] = []
        for folder in checkpoint_family:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                continue
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    result["checkpoints"].append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
        return result

    @modal.method()
    def delete_model(self, folder: str, filename: str):
        import os
        safe_folder = os.path.basename(folder)
        safe_file = os.path.basename(filename)
        target = os.path.join(MODELS_PATH, safe_folder, safe_file)
        if not os.path.isfile(target):
            return {"status": "error", "message": "File not found"}
        os.remove(target)
        vol.commit()
        return {"status": "ok", "deleted": f"{safe_folder}/{safe_file}"}


@app.cls(
    gpu="l4",
    cpu=4,
    memory=24576,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
)
class ComfyAPI_L4:
    @modal.enter()
    def startup(self):
        self._proc = subprocess.Popen(
            ["comfy", "launch", "--", "--listen", "0.0.0.0",
             f"--port={COMFYUI_API_PORT}", "--disable-auto-launch"],
        )
        self._wait_for_comfy()

    @modal.exit()
    def shutdown(self):
        self._proc.terminate()

    def _wait_for_comfy(self):
        import urllib.request
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/system_stats")
                return
            except Exception:
                time.sleep(1)
        raise RuntimeError("ComfyUI did not start in time")

    @modal.method()
    def object_info(self):
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/object_info") as r:
            return json.loads(r.read())

    @modal.method()
    def run_prompt(self, workflow: dict, input_images: dict = None) -> dict:
        import urllib.request
        import base64
        from pathlib import Path

        if input_images:
            input_dir = Path("/root/comfy/ComfyUI/input")
            input_dir.mkdir(parents=True, exist_ok=True)
            for filename, b64data in input_images.items():
                dest = input_dir / Path(filename).name
                dest.write_bytes(base64.b64decode(b64data))

        client_id = str(uuid.uuid4())
        payload = json.dumps({"prompt": workflow, "client_id": client_id}).encode()

        req = urllib.request.Request(
            f"http://127.0.0.1:{COMFYUI_API_PORT}/prompt",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req) as r:
            queued = json.loads(r.read())

        prompt_id = queued["prompt_id"]
        return self._poll_until_done(prompt_id, client_id)

    def _poll_until_done(self, prompt_id: str, client_id: str) -> dict:
        import urllib.request
        for _ in range(3600):
            with urllib.request.urlopen(
                f"http://127.0.0.1:{COMFYUI_API_PORT}/history/{prompt_id}"
            ) as r:
                history = json.loads(r.read())
            if prompt_id in history:
                outputs = history[prompt_id].get("outputs", {})
                return self._collect_outputs(outputs)
            time.sleep(1)
        raise TimeoutError(f"Prompt {prompt_id} timed out")

    def _collect_outputs(self, outputs: dict) -> dict:
        import urllib.request
        import base64

        images = []
        videos = []

        for node_id, node_output in outputs.items():
            for img in node_output.get("images", []):
                animated = node_output.get("animated", (False,))
                is_animated = animated[0] if animated else False
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={img['filename']}&subfolder={img.get('subfolder','')}&type={img.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                entry = {"filename": img["filename"], "data": data, "node_id": node_id}
                if is_animated:
                    videos.append(entry)
                else:
                    images.append(entry)

            for vid in node_output.get("gifs", []):
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={vid['filename']}&subfolder={vid.get('subfolder','')}&type={vid.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                videos.append({"filename": vid["filename"], "data": data, "node_id": node_id})

        return {"images": images, "videos": videos}

    @modal.method()
    def health(self):
        return {"status": "ok"}

    @modal.method()
    def list_models(self):
        import os
        solo_folders = ["loras", "vae", "controlnet", "upscale_models",
                        "embeddings", "clip", "text_encoders"]
        result = {}
        for folder in solo_folders:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                result[folder] = []
                continue
            files = []
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    files.append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
            result[folder] = files
        checkpoint_family = ["checkpoints", "diffusion_models", "unet"]
        result["checkpoints"] = []
        for folder in checkpoint_family:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                continue
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    result["checkpoints"].append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
        return result

    @modal.method()
    def delete_model(self, folder: str, filename: str):
        import os
        safe_folder = os.path.basename(folder)
        safe_file = os.path.basename(filename)
        target = os.path.join(MODELS_PATH, safe_folder, safe_file)
        if not os.path.isfile(target):
            return {"status": "error", "message": "File not found"}
        os.remove(target)
        vol.commit()
        return {"status": "ok", "deleted": f"{safe_folder}/{safe_file}"}


@app.cls(
    gpu="l40s",
    cpu=4,
    memory=32768,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
)
class ComfyAPI_L40S:
    @modal.enter()
    def startup(self):
        self._proc = subprocess.Popen(
            ["comfy", "launch", "--", "--listen", "0.0.0.0",
             f"--port={COMFYUI_API_PORT}", "--disable-auto-launch"],
        )
        self._wait_for_comfy()

    @modal.exit()
    def shutdown(self):
        self._proc.terminate()

    def _wait_for_comfy(self):
        import urllib.request
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/system_stats")
                return
            except Exception:
                time.sleep(1)
        raise RuntimeError("ComfyUI did not start in time")

    @modal.method()
    def object_info(self):
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/object_info") as r:
            return json.loads(r.read())

    @modal.method()
    def run_prompt(self, workflow: dict, input_images: dict = None) -> dict:
        import urllib.request
        import base64
        from pathlib import Path

        if input_images:
            input_dir = Path("/root/comfy/ComfyUI/input")
            input_dir.mkdir(parents=True, exist_ok=True)
            for filename, b64data in input_images.items():
                dest = input_dir / Path(filename).name
                dest.write_bytes(base64.b64decode(b64data))

        client_id = str(uuid.uuid4())
        payload = json.dumps({"prompt": workflow, "client_id": client_id}).encode()

        req = urllib.request.Request(
            f"http://127.0.0.1:{COMFYUI_API_PORT}/prompt",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req) as r:
            queued = json.loads(r.read())

        prompt_id = queued["prompt_id"]
        return self._poll_until_done(prompt_id, client_id)

    def _poll_until_done(self, prompt_id: str, client_id: str) -> dict:
        import urllib.request
        for _ in range(3600):
            with urllib.request.urlopen(
                f"http://127.0.0.1:{COMFYUI_API_PORT}/history/{prompt_id}"
            ) as r:
                history = json.loads(r.read())
            if prompt_id in history:
                outputs = history[prompt_id].get("outputs", {})
                return self._collect_outputs(outputs)
            time.sleep(1)
        raise TimeoutError(f"Prompt {prompt_id} timed out")

    def _collect_outputs(self, outputs: dict) -> dict:
        import urllib.request
        import base64

        images = []
        videos = []

        for node_id, node_output in outputs.items():
            for img in node_output.get("images", []):
                animated = node_output.get("animated", (False,))
                is_animated = animated[0] if animated else False
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={img['filename']}&subfolder={img.get('subfolder','')}&type={img.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                entry = {"filename": img["filename"], "data": data, "node_id": node_id}
                if is_animated:
                    videos.append(entry)
                else:
                    images.append(entry)

            for vid in node_output.get("gifs", []):
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={vid['filename']}&subfolder={vid.get('subfolder','')}&type={vid.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                videos.append({"filename": vid["filename"], "data": data, "node_id": node_id})

        return {"images": images, "videos": videos}

    @modal.method()
    def health(self):
        return {"status": "ok"}

    @modal.method()
    def list_models(self):
        import os
        solo_folders = ["loras", "vae", "controlnet", "upscale_models",
                        "embeddings", "clip", "text_encoders"]
        result = {}
        for folder in solo_folders:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                result[folder] = []
                continue
            files = []
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    files.append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
            result[folder] = files
        checkpoint_family = ["checkpoints", "diffusion_models", "unet"]
        result["checkpoints"] = []
        for folder in checkpoint_family:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                continue
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    result["checkpoints"].append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
        return result

    @modal.method()
    def delete_model(self, folder: str, filename: str):
        import os
        safe_folder = os.path.basename(folder)
        safe_file = os.path.basename(filename)
        target = os.path.join(MODELS_PATH, safe_folder, safe_file)
        if not os.path.isfile(target):
            return {"status": "error", "message": "File not found"}
        os.remove(target)
        vol.commit()
        return {"status": "ok", "deleted": f"{safe_folder}/{safe_file}"}


@app.cls(
    gpu="a100-80gb",
    cpu=4,
    memory=49152,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
)
class ComfyAPI_A100_80:
    @modal.enter()
    def startup(self):
        self._proc = subprocess.Popen(
            ["comfy", "launch", "--", "--listen", "0.0.0.0",
             f"--port={COMFYUI_API_PORT}", "--disable-auto-launch"],
        )
        self._wait_for_comfy()

    @modal.exit()
    def shutdown(self):
        self._proc.terminate()

    def _wait_for_comfy(self):
        import urllib.request
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/system_stats")
                return
            except Exception:
                time.sleep(1)
        raise RuntimeError("ComfyUI did not start in time")

    @modal.method()
    def object_info(self):
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/object_info") as r:
            return json.loads(r.read())

    @modal.method()
    def run_prompt(self, workflow: dict, input_images: dict = None) -> dict:
        import urllib.request
        import base64
        from pathlib import Path

        if input_images:
            input_dir = Path("/root/comfy/ComfyUI/input")
            input_dir.mkdir(parents=True, exist_ok=True)
            for filename, b64data in input_images.items():
                dest = input_dir / Path(filename).name
                dest.write_bytes(base64.b64decode(b64data))

        client_id = str(uuid.uuid4())
        payload = json.dumps({"prompt": workflow, "client_id": client_id}).encode()

        req = urllib.request.Request(
            f"http://127.0.0.1:{COMFYUI_API_PORT}/prompt",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req) as r:
            queued = json.loads(r.read())

        prompt_id = queued["prompt_id"]
        return self._poll_until_done(prompt_id, client_id)

    def _poll_until_done(self, prompt_id: str, client_id: str) -> dict:
        import urllib.request
        for _ in range(3600):
            with urllib.request.urlopen(
                f"http://127.0.0.1:{COMFYUI_API_PORT}/history/{prompt_id}"
            ) as r:
                history = json.loads(r.read())
            if prompt_id in history:
                outputs = history[prompt_id].get("outputs", {})
                return self._collect_outputs(outputs)
            time.sleep(1)
        raise TimeoutError(f"Prompt {prompt_id} timed out")

    def _collect_outputs(self, outputs: dict) -> dict:
        import urllib.request
        import base64

        images = []
        videos = []

        for node_id, node_output in outputs.items():
            for img in node_output.get("images", []):
                animated = node_output.get("animated", (False,))
                is_animated = animated[0] if animated else False
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={img['filename']}&subfolder={img.get('subfolder','')}&type={img.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                entry = {"filename": img["filename"], "data": data, "node_id": node_id}
                if is_animated:
                    videos.append(entry)
                else:
                    images.append(entry)

            for vid in node_output.get("gifs", []):
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={vid['filename']}&subfolder={vid.get('subfolder','')}&type={vid.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                videos.append({"filename": vid["filename"], "data": data, "node_id": node_id})

        return {"images": images, "videos": videos}

    @modal.method()
    def health(self):
        return {"status": "ok"}

    @modal.method()
    def list_models(self):
        import os
        solo_folders = ["loras", "vae", "controlnet", "upscale_models",
                        "embeddings", "clip", "text_encoders"]
        result = {}
        for folder in solo_folders:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                result[folder] = []
                continue
            files = []
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    files.append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
            result[folder] = files
        checkpoint_family = ["checkpoints", "diffusion_models", "unet"]
        result["checkpoints"] = []
        for folder in checkpoint_family:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                continue
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    result["checkpoints"].append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
        return result

    @modal.method()
    def delete_model(self, folder: str, filename: str):
        import os
        safe_folder = os.path.basename(folder)
        safe_file = os.path.basename(filename)
        target = os.path.join(MODELS_PATH, safe_folder, safe_file)
        if not os.path.isfile(target):
            return {"status": "error", "message": "File not found"}
        os.remove(target)
        vol.commit()
        return {"status": "ok", "deleted": f"{safe_folder}/{safe_file}"}


@app.cls(
    gpu="h100",
    cpu=4,
    memory=49152,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
)
class ComfyAPI_H100:
    @modal.enter()
    def startup(self):
        self._proc = subprocess.Popen(
            ["comfy", "launch", "--", "--listen", "0.0.0.0",
             f"--port={COMFYUI_API_PORT}", "--disable-auto-launch"],
        )
        self._wait_for_comfy()

    @modal.exit()
    def shutdown(self):
        self._proc.terminate()

    def _wait_for_comfy(self):
        import urllib.request
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/system_stats")
                return
            except Exception:
                time.sleep(1)
        raise RuntimeError("ComfyUI did not start in time")

    @modal.method()
    def object_info(self):
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/object_info") as r:
            return json.loads(r.read())

    @modal.method()
    def run_prompt(self, workflow: dict, input_images: dict = None) -> dict:
        import urllib.request
        import base64
        from pathlib import Path

        if input_images:
            input_dir = Path("/root/comfy/ComfyUI/input")
            input_dir.mkdir(parents=True, exist_ok=True)
            for filename, b64data in input_images.items():
                dest = input_dir / Path(filename).name
                dest.write_bytes(base64.b64decode(b64data))

        client_id = str(uuid.uuid4())
        payload = json.dumps({"prompt": workflow, "client_id": client_id}).encode()

        req = urllib.request.Request(
            f"http://127.0.0.1:{COMFYUI_API_PORT}/prompt",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req) as r:
            queued = json.loads(r.read())

        prompt_id = queued["prompt_id"]
        return self._poll_until_done(prompt_id, client_id)

    def _poll_until_done(self, prompt_id: str, client_id: str) -> dict:
        import urllib.request
        for _ in range(3600):
            with urllib.request.urlopen(
                f"http://127.0.0.1:{COMFYUI_API_PORT}/history/{prompt_id}"
            ) as r:
                history = json.loads(r.read())
            if prompt_id in history:
                outputs = history[prompt_id].get("outputs", {})
                return self._collect_outputs(outputs)
            time.sleep(1)
        raise TimeoutError(f"Prompt {prompt_id} timed out")

    def _collect_outputs(self, outputs: dict) -> dict:
        import urllib.request
        import base64

        images = []
        videos = []

        for node_id, node_output in outputs.items():
            for img in node_output.get("images", []):
                animated = node_output.get("animated", (False,))
                is_animated = animated[0] if animated else False
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={img['filename']}&subfolder={img.get('subfolder','')}&type={img.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                entry = {"filename": img["filename"], "data": data, "node_id": node_id}
                if is_animated:
                    videos.append(entry)
                else:
                    images.append(entry)

            for vid in node_output.get("gifs", []):
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={vid['filename']}&subfolder={vid.get('subfolder','')}&type={vid.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                videos.append({"filename": vid["filename"], "data": data, "node_id": node_id})

        return {"images": images, "videos": videos}

    @modal.method()
    def health(self):
        return {"status": "ok"}

    @modal.method()
    def list_models(self):
        import os
        solo_folders = ["loras", "vae", "controlnet", "upscale_models",
                        "embeddings", "clip", "text_encoders"]
        result = {}
        for folder in solo_folders:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                result[folder] = []
                continue
            files = []
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    files.append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
            result[folder] = files
        checkpoint_family = ["checkpoints", "diffusion_models", "unet"]
        result["checkpoints"] = []
        for folder in checkpoint_family:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                continue
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    result["checkpoints"].append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
        return result

    @modal.method()
    def delete_model(self, folder: str, filename: str):
        import os
        safe_folder = os.path.basename(folder)
        safe_file = os.path.basename(filename)
        target = os.path.join(MODELS_PATH, safe_folder, safe_file)
        if not os.path.isfile(target):
            return {"status": "error", "message": "File not found"}
        os.remove(target)
        vol.commit()
        return {"status": "ok", "deleted": f"{safe_folder}/{safe_file}"}


@app.cls(
    gpu="h200",
    cpu=4,
    memory=65536,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
)
class ComfyAPI_H200:
    @modal.enter()
    def startup(self):
        self._proc = subprocess.Popen(
            ["comfy", "launch", "--", "--listen", "0.0.0.0",
             f"--port={COMFYUI_API_PORT}", "--disable-auto-launch"],
        )
        self._wait_for_comfy()

    @modal.exit()
    def shutdown(self):
        self._proc.terminate()

    def _wait_for_comfy(self):
        import urllib.request
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/system_stats")
                return
            except Exception:
                time.sleep(1)
        raise RuntimeError("ComfyUI did not start in time")

    @modal.method()
    def object_info(self):
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/object_info") as r:
            return json.loads(r.read())

    @modal.method()
    def run_prompt(self, workflow: dict, input_images: dict = None) -> dict:
        import urllib.request
        import base64
        from pathlib import Path

        if input_images:
            input_dir = Path("/root/comfy/ComfyUI/input")
            input_dir.mkdir(parents=True, exist_ok=True)
            for filename, b64data in input_images.items():
                dest = input_dir / Path(filename).name
                dest.write_bytes(base64.b64decode(b64data))

        client_id = str(uuid.uuid4())
        payload = json.dumps({"prompt": workflow, "client_id": client_id}).encode()

        req = urllib.request.Request(
            f"http://127.0.0.1:{COMFYUI_API_PORT}/prompt",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req) as r:
            queued = json.loads(r.read())

        prompt_id = queued["prompt_id"]
        return self._poll_until_done(prompt_id, client_id)

    def _poll_until_done(self, prompt_id: str, client_id: str) -> dict:
        import urllib.request
        for _ in range(3600):
            with urllib.request.urlopen(
                f"http://127.0.0.1:{COMFYUI_API_PORT}/history/{prompt_id}"
            ) as r:
                history = json.loads(r.read())
            if prompt_id in history:
                outputs = history[prompt_id].get("outputs", {})
                return self._collect_outputs(outputs)
            time.sleep(1)
        raise TimeoutError(f"Prompt {prompt_id} timed out")

    def _collect_outputs(self, outputs: dict) -> dict:
        import urllib.request
        import base64

        images = []
        videos = []

        for node_id, node_output in outputs.items():
            for img in node_output.get("images", []):
                animated = node_output.get("animated", (False,))
                is_animated = animated[0] if animated else False
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={img['filename']}&subfolder={img.get('subfolder','')}&type={img.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                entry = {"filename": img["filename"], "data": data, "node_id": node_id}
                if is_animated:
                    videos.append(entry)
                else:
                    images.append(entry)

            for vid in node_output.get("gifs", []):
                url = (
                    f"http://127.0.0.1:{COMFYUI_API_PORT}/view"
                    f"?filename={vid['filename']}&subfolder={vid.get('subfolder','')}&type={vid.get('type','output')}"
                )
                with urllib.request.urlopen(url) as r:
                    data = base64.b64encode(r.read()).decode()
                videos.append({"filename": vid["filename"], "data": data, "node_id": node_id})

        return {"images": images, "videos": videos}

    @modal.method()
    def health(self):
        return {"status": "ok"}

    @modal.method()
    def list_models(self):
        import os
        solo_folders = ["loras", "vae", "controlnet", "upscale_models",
                        "embeddings", "clip", "text_encoders"]
        result = {}
        for folder in solo_folders:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                result[folder] = []
                continue
            files = []
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    files.append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
            result[folder] = files
        checkpoint_family = ["checkpoints", "diffusion_models", "unet"]
        result["checkpoints"] = []
        for folder in checkpoint_family:
            folder_path = os.path.join(MODELS_PATH, folder)
            if not os.path.isdir(folder_path):
                continue
            for fname in sorted(os.listdir(folder_path)):
                fpath = os.path.join(folder_path, fname)
                if os.path.isfile(fpath):
                    result["checkpoints"].append({"name": fname, "size": os.path.getsize(fpath), "folder": folder})
        return result

    @modal.method()
    def delete_model(self, folder: str, filename: str):
        import os
        safe_folder = os.path.basename(folder)
        safe_file = os.path.basename(filename)
        target = os.path.join(MODELS_PATH, safe_folder, safe_file)
        if not os.path.isfile(target):
            return {"status": "error", "message": "File not found"}
        os.remove(target)
        vol.commit()
        return {"status": "ok", "deleted": f"{safe_folder}/{safe_file}"}
