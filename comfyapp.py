import subprocess
import sys
import time
import json
import uuid
import modal

COMFYAPP_VERSION = "1.3.0"

APP_NAME = "comfyui"
VOLUME_NAME = "comfyui-models"
COMFYUI_PORT = 8188
COMFYUI_API_PORT = 8189
MODELS_PATH = "/root/models"

DEFAULT_CUSTOM_NODES = [
    "comfyui-manager",
]

SUPPORTED_GPUS = ["a10g", "a100", "a100-80gb", "t4", "l4", "l40s", "h100", "h200"]

app = modal.App(APP_NAME)
vol = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)


def _load_custom_nodes() -> list:
    import os
    nodes_path = os.path.join(MODELS_PATH, "nodes.json")
    if os.path.exists(nodes_path):
        try:
            with open(nodes_path) as f:
                data = json.load(f)
            if isinstance(data, list) and data:
                return data
        except Exception:
            pass
    return DEFAULT_CUSTOM_NODES




def _build_comfy_image():
    import os
    nodes_json_path = os.path.join(os.path.dirname(__file__), "nodes.json")
    if os.path.exists(nodes_json_path):
        try:
            with open(nodes_json_path) as f:
                custom_nodes = json.load(f)
        except Exception:
            custom_nodes = DEFAULT_CUSTOM_NODES
    else:
        custom_nodes = DEFAULT_CUSTOM_NODES

    install_cmds = [f"comfy node install {node}" for node in custom_nodes]

    img = (
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
            *install_cmds,
            gpu="a10g",
        )
        .pip_install(
            "torch==2.5.1",
            "torchvision==0.20.1",
            "torchaudio==2.5.1",
            extra_index_url="https://download.pytorch.org/whl/cu124",
        )
        .pip_install("huggingface_hub>=0.33.5", "transformers>=4.48.3")
        .run_commands("rm -rf /root/comfy/ComfyUI/models && ln -s /root/models /root/comfy/ComfyUI/models")
    )
    return img


image = _build_comfy_image()

download_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("httpx>=0.27.0", "huggingface_hub>=0.23.0", "requests>=2.31.0")
)




@app.function(
    image=image,
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

    _SAFE_EXTS = {".ckpt", ".pt", ".pt2", ".bin", ".pth", ".safetensors", ".pkl", ".sft", ".gguf"}
    if Path(filename).suffix.lower() not in _SAFE_EXTS:
        params = {}
        try:
            from urllib.parse import urlparse, parse_qs
            qs = parse_qs(urlparse(url).query)
            fmt = (qs.get("format", [""])[0]).lower()
        except Exception:
            fmt = ""
        if fmt in ("safetensor", "safetensors"):
            filename += ".safetensors"
        elif fmt == "gguf":
            filename += ".gguf"
        elif fmt == "pt":
            filename += ".pt"
        else:
            filename += ".safetensors"

    dest = Path(MODELS_PATH) / save_path / filename
    dest.parent.mkdir(parents=True, exist_ok=True)

    if dest.exists():
        return {"status": "ok", "skipped": True, "path": str(dest)}

    if "huggingface.co" in url:
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

    if "civitai.com" in url or "civitai.red" in url:
        headers = {}
        if civitai_token:
            headers["Authorization"] = f"Bearer {civitai_token}"
        civitai_urls = [url]
        if "civitai.red" in url:
            civitai_urls.append(url.replace("civitai.red", "civitai.com"))
        last_err = None
        for attempt_url in civitai_urls:
            try:
                with httpx.stream("GET", attempt_url, follow_redirects=True, timeout=1800, headers=headers) as r:
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
            except httpx.HTTPStatusError as e:
                last_err = e
                if e.response.status_code < 500:
                    raise Exception(f"Download failed ({e.response.status_code}): {attempt_url}") from None
                print(f"\n  Mirror returned {e.response.status_code}, retrying origin...")
                continue
        raise Exception(f"Download failed: all CivitAI URLs returned server error. Last URL: {civitai_urls[-1]}, status: {last_err.response.status_code if last_err else 'unknown'}") from None

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




def _list_models_impl() -> dict:
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


def _delete_model_impl(folder: str, filename: str) -> dict:
    import os
    safe_folder = os.path.basename(folder)
    safe_file = os.path.basename(filename)
    target = os.path.join(MODELS_PATH, safe_folder, safe_file)
    if not os.path.isfile(target):
        return {"status": "error", "message": "File not found"}
    os.remove(target)
    vol.commit()
    return {"status": "ok", "deleted": f"{safe_folder}/{safe_file}"}


@app.function(
    image=image,
    cpu=1,
    memory=256,
    timeout=60,
    volumes={MODELS_PATH: vol},
)
def list_models_fn() -> dict:
    return _list_models_impl()


@app.function(
    image=image,
    cpu=1,
    memory=256,
    timeout=60,
    volumes={MODELS_PATH: vol},
)
def delete_model_fn(folder: str, filename: str) -> dict:
    return _delete_model_impl(folder, filename)




@app.function(
    image=image,
    cpu=1,
    memory=256,
    timeout=60,
    volumes={MODELS_PATH: vol},
)
def get_nodes_json() -> list:
    import os
    nodes_path = os.path.join(MODELS_PATH, "nodes.json")
    if os.path.exists(nodes_path):
        with open(nodes_path) as f:
            return json.load(f)
    return DEFAULT_CUSTOM_NODES


@app.function(
    image=image,
    cpu=1,
    memory=256,
    timeout=60,
    volumes={MODELS_PATH: vol},
)
def save_nodes_json(nodes: list) -> dict:
    import os
    nodes_path = os.path.join(MODELS_PATH, "nodes.json")
    with open(nodes_path, "w") as f:
        json.dump(nodes, f, indent=2)
    vol.commit()
    return {"status": "ok", "nodes": nodes}




class _ComfyMixin:

    @modal.enter()
    def startup(self):
        import os, shutil
        inputs_vol = os.path.join(MODELS_PATH, "inputs")
        comfy_input = "/root/comfy/ComfyUI/input"
        if os.path.isdir(inputs_vol):
            os.makedirs(comfy_input, exist_ok=True)
            for fname in os.listdir(inputs_vol):
                src = os.path.join(inputs_vol, fname)
                dst = os.path.join(comfy_input, fname)
                if os.path.isfile(src) and not os.path.exists(dst):
                    shutil.copy2(src, dst)
        self._proc = subprocess.Popen(
            ["comfy", "launch", "--", "--listen", "0.0.0.0",
             f"--port={COMFYUI_API_PORT}", "--disable-auto-launch"],
        )
        self._wait_for_comfy()

    @modal.exit()
    def shutdown(self):
        if hasattr(self, "_proc") and self._proc and self._proc.poll() is None:
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
    def convert_workflow(self, workflow: dict) -> dict:
        import urllib.request
        import re

        with urllib.request.urlopen(f"http://127.0.0.1:{COMFYUI_API_PORT}/object_info") as r:
            obj_info = json.loads(r.read())

        links = {l[0]: l for l in workflow.get("links", [])}
        _SKIP_TYPES = {"IMAGE", "LATENT", "MODEL", "CLIP", "VAE", "CONDITIONING", "MASK", "SEGS", "DETAILER_PIPE", "BASIC_PIPE"}
        _CTRL_WIDGETS = {"randomize", "fixed", "increment", "decrement"}

        nodes_by_id = {str(n["id"]): n for n in workflow.get("nodes", [])}

        bypass_remap = {}
        for node in workflow.get("nodes", []):
            if node.get("mode") != 4:
                continue
            ntype = node.get("type")
            if not ntype or ntype not in obj_info:
                continue
            node_info = obj_info[ntype]
            req_inputs = node_info.get("input", {}).get("required", {})
            opt_inputs = node_info.get("input", {}).get("optional", {})
            all_input_names = list(req_inputs.keys()) + list(opt_inputs.keys())
            inp_map = {inp["name"]: inp for inp in node.get("inputs", [])}
            for out_idx, out_slot in enumerate(node.get("outputs", [])):
                out_type = out_slot.get("type")
                for inp_name in all_input_names:
                    cfg = req_inputs.get(inp_name) or opt_inputs.get(inp_name)
                    if not cfg:
                        continue
                    inp_type = cfg[0] if isinstance(cfg, list) else cfg
                    if inp_type == out_type and inp_name in inp_map:
                        link_id = inp_map[inp_name].get("link")
                        if link_id is not None and link_id in links:
                            l = links[link_id]
                            bypass_remap[(str(node["id"]), out_idx)] = [str(l[1]), l[2]]
                        break

        # Recursively resolve bypass chains
        def resolve_ref(node_id_str, slot, depth=0):
            if depth > 20:
                return node_id_str, slot
            key = (node_id_str, slot)
            if key in bypass_remap:
                mapped = bypass_remap[key]
                return resolve_ref(str(mapped[0]), mapped[1], depth + 1)
            return node_id_str, slot

        print(f"bypass_remap entries: {len(bypass_remap)}")
        prompt = {}
        bypassed_node_ids = {str(n["id"]) for n in workflow.get("nodes", []) if n.get("mode") == 4}

        for node in workflow.get("nodes", []):
            node_id = node["id"]
            ntype = node.get("type")

            if not ntype or ntype == "Note":
                continue
            if node.get("mode") == 4:
                continue
            if re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-", ntype):
                continue
            if ntype not in obj_info:
                continue

            node_schema = obj_info[ntype]
            req_inputs_schema = node_schema.get("input", {}).get("required", {})
            opt_inputs_schema = node_schema.get("input", {}).get("optional", {})

            inputs = {}
            linked_names = set()
            for inp in node.get("inputs", []):
                link_id = inp.get("link")
                if link_id is not None and link_id in links:
                    l = links[link_id]
                    src_node, src_slot = resolve_ref(str(l[1]), l[2])
                    if src_node in bypassed_node_ids:
                        inp_schema = req_inputs_schema.get(inp["name"]) or opt_inputs_schema.get(inp["name"])
                        if inp_schema:
                            inp_type = inp_schema[0] if isinstance(inp_schema, list) else inp_schema
                            if inp_type not in _SKIP_TYPES:
                                continue
                        continue
                    inputs[inp["name"]] = [src_node, src_slot]
                    linked_names.add(inp["name"])

            node_info = obj_info.get(ntype, {})
            req_inputs = node_info.get("input", {}).get("required", {})
            opt_inputs = node_info.get("input", {}).get("optional", {})

            widget_input_names = []
            for name in list(req_inputs.keys()) + list(opt_inputs.keys()):
                cfg = req_inputs.get(name) or opt_inputs.get(name)
                if not cfg:
                    continue
                input_type = cfg[0] if isinstance(cfg, list) else cfg
                if isinstance(input_type, str) and input_type in _SKIP_TYPES:
                    continue
                widget_input_names.append(name)

            widget_values = node.get("widgets_values", [])
            wi = 0
            for name in widget_input_names:
                if wi >= len(widget_values):
                    break
                val = widget_values[wi]
                wi += 1

                cfg = req_inputs.get(name) or opt_inputs.get(name)
                input_type = cfg[0] if isinstance(cfg, list) else cfg
                if isinstance(input_type, str) and input_type in ("INT", "FLOAT"):
                    if wi < len(widget_values) and isinstance(widget_values[wi], str) and widget_values[wi] in _CTRL_WIDGETS:
                        wi += 1

                if name not in linked_names:
                    cfg2 = req_inputs.get(name) or opt_inputs.get(name)
                    input_type2 = cfg2[0] if isinstance(cfg2, list) else cfg2
                    if val == [] or val is None:
                        if isinstance(input_type2, list):
                            val = input_type2[0]
                        elif input_type2 == "BOOLEAN":
                            val = False
                        elif input_type2 == "INT":
                            val = 0
                        elif input_type2 == "FLOAT":
                            val = 0.0
                        elif input_type2 == "STRING":
                            val = ""
                        else:
                            continue
                    elif isinstance(input_type2, list) and val not in input_type2:
                        val = input_type2[0] if input_type2 else val
                    inputs[name] = val

            prompt[str(node_id)] = {
                "class_type": ntype,
                "_meta": {"title": node.get("title") or ntype},
                "inputs": inputs,
            }

        changed = True
        while changed:
            changed = False
            valid_ids = set(prompt.keys())
            to_remove = []
            for nid, node_data in prompt.items():
                for inp_val in node_data["inputs"].values():
                    if isinstance(inp_val, list) and len(inp_val) >= 1:
                        if str(inp_val[0]) not in valid_ids:
                            to_remove.append(nid)
                            break
            for nid in to_remove:
                del prompt[nid]
                changed = True

        return prompt

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

        try:
            free_req = urllib.request.Request(
                f"http://127.0.0.1:{COMFYUI_API_PORT}/queue",
                data=json.dumps({"clear": True}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(free_req)
        except Exception:
            pass

        req = urllib.request.Request(
            f"http://127.0.0.1:{COMFYUI_API_PORT}/prompt",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req) as r:
                queued = json.loads(r.read())
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"ComfyUI /prompt returned {e.code}: {body}") from None

        prompt_id = queued["prompt_id"]
        return self._poll_until_done(prompt_id, client_id)

    def _poll_until_done(self, prompt_id: str, client_id: str, debug: bool = False) -> dict:
        import urllib.request
        for _ in range(3600):
            with urllib.request.urlopen(
                f"http://127.0.0.1:{COMFYUI_API_PORT}/history/{prompt_id}"
            ) as r:
                history = json.loads(r.read())
            if prompt_id in history:
                entry = history[prompt_id]
                status = entry.get("status", {})
                if debug:
                    print(f"[DEBUG] status={status}")
                    print(f"[DEBUG] outputs keys={list(entry.get('outputs', {}).keys())}")
                    for nid, nout in entry.get("outputs", {}).items():
                        print(f"[DEBUG]   node {nid}: {list(nout.keys())}")
                if status.get("status_str") == "error" or not status.get("completed", True):
                    msgs = status.get("messages", [])
                    raise RuntimeError(f"ComfyUI execution error: {msgs}")
                outputs = entry.get("outputs", {})
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
        return _list_models_impl()

    @modal.method()
    def delete_model(self, folder: str, filename: str):
        return _delete_model_impl(folder, filename)




@app.cls(
    image=image,
    gpu="a10g",
    cpu=4,
    memory=16384,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
    enable_memory_snapshot=False,
)
class ComfyAPI(_ComfyMixin):
    pass


@app.cls(
    image=image,
    gpu="a100",
    cpu=4,
    memory=32768,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
    enable_memory_snapshot=False,
)
class ComfyAPI_A100(_ComfyMixin):
    pass


@app.cls(
    image=image,
    gpu="a100-80gb",
    cpu=4,
    memory=49152,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
    enable_memory_snapshot=False,
)
class ComfyAPI_A100_80(_ComfyMixin):
    pass


@app.cls(
    image=image,
    gpu="t4",
    cpu=2,
    memory=8192,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
    enable_memory_snapshot=False,
)
class ComfyAPI_T4(_ComfyMixin):
    pass


@app.cls(
    image=image,
    gpu="l4",
    cpu=4,
    memory=24576,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
    enable_memory_snapshot=False,
)
class ComfyAPI_L4(_ComfyMixin):
    pass


@app.cls(
    image=image,
    gpu="l40s",
    cpu=4,
    memory=32768,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
    enable_memory_snapshot=False,
)
class ComfyAPI_L40S(_ComfyMixin):
    pass


@app.cls(
    image=image,
    gpu="h100",
    cpu=4,
    memory=49152,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
    enable_memory_snapshot=False,
)
class ComfyAPI_H100(_ComfyMixin):
    pass


@app.cls(
    image=image,
    gpu="h200",
    cpu=4,
    memory=65536,
    timeout=3600,
    min_containers=0,
    scaledown_window=2,
    volumes={MODELS_PATH: vol},
    enable_memory_snapshot=False,
)
class ComfyAPI_H200(_ComfyMixin):
    pass
