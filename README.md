# comfyui-modal

**Run ComfyUI image generation on [Modal](https://modal.com) GPU cloud — directly from your local ComfyUI.**

No need to manage servers or pay for idle time. Modal spins up a GPU container on demand and shuts it down automatically when you're done.

[한국어 README](./README.ko.md)

---

## Features

- 🚀 **On-demand GPU** — A10G, A100, or T4. Pay only for what you use.
- ☁️ **Cloud model storage** — Models live in a Modal Volume, not on your local disk.
- 🔄 **Auto-deploy** — ComfyUI deploys the Modal app automatically on startup when the app version changes.
- 🔌 **One-click connect** — Enter your Modal token directly in the ComfyUI sidebar. No terminal needed.
- 🔀 **Local fallback** — Toggle Modal off to run generations locally at any time.

---

## Requirements

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
- Python 3.10+
- `modal` Python package
- A free [Modal account](https://modal.com)

---

## Installation

### Option A — Windows Portable (recommended for Windows users)

The Windows portable package ships its own isolated Python (`python_embeded`). You must install `modal` into that Python, not your system Python.

**1. Download and extract ComfyUI Windows portable**

Get it from [ComfyUI releases](https://github.com/comfyanonymous/ComfyUI/releases) and extract to a folder such as `C:\ComfyUI_windows_portable\`.

**2. Clone this repo into custom_nodes**

Open Command Prompt and run:

```bat
cd C:\ComfyUI_windows_portable\ComfyUI\custom_nodes
git clone https://github.com/JunnnnyWon/comfyui-modal
```

> If you don't have `git`, download the ZIP from GitHub and extract it as `comfyui-modal` inside `custom_nodes`.

**3. Install modal into the embedded Python**

```bat
C:\ComfyUI_windows_portable\python_embeded\python.exe -m pip install modal
```

**4. Start ComfyUI**

Double-click `run_nvidia_gpu.bat` (or `run_cpu.bat`).

The **Modal GPU** tab will appear in the sidebar.

---

### Option B — Standard install (Mac / Linux / Windows venv)

**1. Clone into ComfyUI custom nodes**

```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/JunnnnyWon/comfyui-modal
```

**2. Install the modal package**

Install `modal` into the **same Python environment that runs ComfyUI**:

```bash
pip install modal
```

**3. Start ComfyUI**

```bash
python main.py
```

The **Modal GPU** tab will appear in the sidebar.

---

## Connecting your Modal account

On first launch, the sidebar shows a connect screen.

1. Go to [modal.com](https://modal.com) and create a free account
2. Navigate to **Settings → Tokens** and create a new token
3. Copy the **Token ID** (`ak-...`) and **Token Secret** (`as-...`)
4. Paste them into the sidebar and click **Connect & Deploy**

The Modal app deploys automatically in the background. The sidebar shows deploy progress.

> **Token format**
> - Token ID starts with `ak-`
> - Token Secret starts with `as-`

---

## Usage

### Running a generation on Modal GPU

1. Open the **Modal GPU** sidebar tab (cloud icon)
2. Make sure the **Modal ON** toggle is enabled
3. Select your GPU (A10G recommended)
4. Queue a generation as normal — it runs on Modal

### Managing models

Models are stored in a Modal Volume (`comfyui-models`), not locally.

| Action | How |
|--------|-----|
| **View models** | Models section in the sidebar |
| **Download a model** | Paste URL + filename in Add Model, click Download |
| **Delete a model** | Click ✕ next to any model |
| **Inject as local placeholder** | Click ⬇L — creates a zero-byte `modal-<filename>` locally so ComfyUI nodes can reference it |

### GPU options

| GPU | VRAM | Best for |
|-----|------|----------|
| **A10G** | 24 GB | SDXL, Flux, most workflows (default) |
| **A100** | 40 GB | Large models, video, multi-LoRA stacks |
| **T4** | 16 GB | Budget option — slower, cheapest |

### Local mode

Toggle **Modal ON → Local** in the sidebar to bypass Modal and run generations on your local ComfyUI directly. Toggle back to resume cloud routing.

---

## Re-deploying

The Modal app re-deploys automatically when `COMFYAPP_VERSION` in `comfyapp.py` changes (e.g. after a git pull).

To force a manual re-deploy at any time, click **↑ Deploy** in the sidebar.

---

## Updating

```bash
cd /path/to/ComfyUI/custom_nodes/comfyui-modal
git pull
```

Restart ComfyUI. If `comfyapp.py` changed, the new version deploys automatically on startup.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| **modal CLI not found** | `pip install modal` in ComfyUI's Python environment |
| **Modal token not set** | Enter token in the sidebar connect screen |
| **Deploy timed out** | Click ↑ Deploy to retry |
| **503 on Models** | App not deployed yet — click ↑ Deploy |
| **Prompts not going to Modal** | Check the Modal ON toggle in the sidebar |

---

## How it works

```
ComfyUI (local)
  └── comfyui-modal custom node
        ├── Intercepts /prompt POST requests
        ├── Routes them to Modal GPU container
        ├── Streams results back as images/videos
        └── Manages model downloads to Modal Volume
```

The `comfyapp.py` file defines the Modal app — three independent GPU classes (`ComfyAPI` / `ComfyAPI_A100` / `ComfyAPI_T4`), each running a full ComfyUI server inside a Modal container.

---

## License

MIT
