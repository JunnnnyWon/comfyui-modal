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

### Quick reference

| Issue | Fix |
|-------|-----|
| **modal CLI not found** | `pip install modal` in ComfyUI's Python environment |
| **Modal token not set** | Enter token in the sidebar connect screen |
| **Deploy timed out** | Click ↑ Deploy to retry |
| **503 on Models** | App not deployed yet — click ↑ Deploy |
| **Prompts not going to Modal** | Check the Modal ON toggle in the sidebar |
| **Model not showing in node dropdowns** | Click ⬇L next to the model, or re-download — placeholder is now auto-created |
| **unet_name dropdown empty** | Download the model via Add Model — `unet` folder is supported |

---

### Known issues & fixes

#### Windows: `cp949` codec error during deploy

**Symptom**
```
[comfyui-modal] Deploy failed: 'cp949' codec can't encode character '\u2713'
```

**Cause**
Windows CMD/PowerShell defaults to `cp949` encoding. Modal CLI outputs Unicode characters (e.g. `✓`) that cannot be decoded.

**Fix**
Already patched in v1.0.0+. If you see this error, update the node:
```bat
cd ComfyUI\custom_nodes\comfyui-modal
git pull
```

---

#### Check button always shows Offline after deploy

**Symptom**
Deploy succeeds, but clicking **Check** always shows `Offline`.

**Cause**
`min_containers=0` means the Modal container is shut down when idle. The old Check button tried to wake the container and timed out before getting a response.

**Fix**
Already patched. The **Check** button now verifies deploy state instantly (no container wake-up). Use **Ping** when you want to confirm the container is actually alive — this may take 1–3 minutes on a cold start.

---

#### Container shuts down immediately after generation

**Expected behavior**
`scaledown_window=2` is intentional — the container shuts down 2 seconds after the last request to minimize cost. The next generation will cold-start again (1–3 min).

If you want the container to stay warm longer, edit `comfyapp.py`:
```python
scaledown_window=120,  # stay alive 2 minutes after last request
```
Then click **↑ Deploy** to redeploy.

---

#### Model URL causes "missing http:// or https://" error

**Symptom**
```
Error: Request URL is missing an 'http://' or 'https://' protocol.
```

**Cause**
URL was pasted without the `https://` prefix.

**Fix**
Already patched. The URL field now auto-prepends `https://` if missing. Update the node with `git pull`.

---

#### unet_name / model dropdown empty after download

**Cause**
Modal Volume models are stored in the cloud. ComfyUI's local file scanner cannot see them.

**Fix**
A zero-byte placeholder file (`modal-<filename>`) is automatically created in the local `models/` directory after each download. This makes the model appear in ComfyUI dropdowns.

If a placeholder is missing, click **⬇L** next to the model in the Models list to create it manually.

---

### Uninstalling

Removing the custom node folder does **not** automatically clean up placeholder files. To fully uninstall:

**1. Remove placeholder files**

```bash
# Mac / Linux
find /path/to/ComfyUI/models -name "modal-*" -delete

# Windows (PowerShell)
Get-ChildItem -Path "C:\ComfyUI_windows_portable\ComfyUI\models" -Recurse -Filter "modal-*" | Remove-Item
```

**2. Remove the custom node**

```bash
rm -rf /path/to/ComfyUI/custom_nodes/comfyui-modal
```

**3. (Optional) Remove Modal token**

```bash
# Mac / Linux
rm ~/.modal.toml

# Windows
del %USERPROFILE%\.modal.toml
```

**4. (Optional) Delete Modal cloud resources**

Go to [modal.com](https://modal.com) → Apps → delete `comfyui`, and Volumes → delete `comfyui-models`.

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
