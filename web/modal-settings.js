import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MODAL_PREFIX = "/comfymodal";

// Sections shown in the Models panel (order matters).
// "checkpoints" groups: checkpoints/ + diffusion_models/ + unet/
const FOLDERS = ["checkpoints", "loras", "vae", "controlnet", "upscale_models", "embeddings", "clip", "text_encoders"];

// Folders available in the "Add Model" download dropdown
const DOWNLOAD_FOLDERS = [
  "checkpoints",
  "diffusion_models",
  "loras",
  "vae",
  "controlnet",
  "upscale_models",
  "embeddings",
  "clip",
  "text_encoders",
  "model_patches",
  "clip_vision",
  "style_models",
  "vae_approx",
  "hypernetworks",
  "gligen",
  "photomaker",
  "latent_upscale_models",
  "audio_encoders",
  "frame_interpolation",
];

const GPU_OPTIONS = [
  { value: "a10g",  label: "A10G  (24 GB) — recommended" },
  { value: "a100",  label: "A100  (40 GB)" },
  { value: "t4",    label: "T4    (16 GB) — budget" },
];

const STORAGE_KEY_GPU    = "comfymodal_gpu";
const STORAGE_KEY_ENABLED = "comfymodal_enabled";

const STATUS = {
  UNKNOWN:    "unknown",
  CHECKING:   "checking",
  ONLINE:     "online",
  OFFLINE:    "offline",
  GENERATING: "generating",
};

let currentStatus = STATUS.UNKNOWN;
let dotEl = null;
let statusEl = null;
let modelListEl = null;
let deployBannerEl = null;
let deployBannerTextEl = null;
let _deployPollTimer = null;

const STATUS_STYLE = {
  [STATUS.UNKNOWN]:    { color: "#888",    label: "Not checked" },
  [STATUS.CHECKING]:   { color: "#f5a623", label: "Checking..." },
  [STATUS.ONLINE]:     { color: "#7ed321", label: "Online (warm)" },
  [STATUS.OFFLINE]:    { color: "#888",    label: "Offline (cold)" },
  [STATUS.GENERATING]: { color: "#4a90e2", label: "Generating..." },
};

const DEPLOY_STATE_STYLE = {
  idle:      { color: "#888",    text: "" },
  deploying: { color: "#f5a623", text: "⏳ Deploying to Modal..." },
  ready:     { color: "#7ed321", text: "" },
  error:     { color: "#e05050", text: "" },
};

function setDeployBanner(state, message) {
  if (!deployBannerEl || !deployBannerTextEl) return;
  const style = DEPLOY_STATE_STYLE[state] || DEPLOY_STATE_STYLE.idle;
  const text = state === "error" ? `⚠ ${message}` : style.text;
  if (!text) {
    deployBannerEl.style.display = "none";
    return;
  }
  deployBannerEl.style.display = "block";
  deployBannerEl.style.color = style.color;
  deployBannerTextEl.textContent = text;
}

async function pollDeployStatus() {
  try {
    const resp = await api.fetchApi(`${MODAL_PREFIX}/deploy/status`);
    if (!resp.ok) return;
    const data = await resp.json();
    setDeployBanner(data.state, data.message);
    if (data.state === "deploying") {
      _deployPollTimer = setTimeout(pollDeployStatus, 3000);
    }
  } catch {}
}

function startDeployPoll() {
  if (_deployPollTimer) clearTimeout(_deployPollTimer);
  pollDeployStatus();
}

function setStatus(s) {
  currentStatus = s;
  if (!dotEl || !statusEl) return;
  const { color, label } = STATUS_STYLE[s] || STATUS_STYLE[STATUS.UNKNOWN];
  dotEl.style.background = color;
  statusEl.textContent = label;
}

async function checkHealth(ping = false) {
  setStatus(STATUS.CHECKING);
  try {
    const url = ping
      ? `${MODAL_PREFIX}/health?mode=ping`
      : `${MODAL_PREFIX}/health?mode=deploy`;
    const resp = await api.fetchApi(url);
    if (resp.ok) {
      const data = await resp.json();
      setStatus(data.status === "ok" ? STATUS.ONLINE : STATUS.OFFLINE);
    } else {
      const data = await resp.json().catch(() => ({}));
      if (data.status === "deploying") {
        setStatus(STATUS.CHECKING);
        statusEl.textContent = "Deploying...";
      } else {
        setStatus(STATUS.OFFLINE);
      }
    }
  } catch {
    setStatus(STATUS.OFFLINE);
  }
}

api.addEventListener("execution_start", () => setStatus(STATUS.GENERATING));
api.addEventListener("executing", (e) => {
  if (e?.detail?.node === null) setStatus(STATUS.OFFLINE);
});
api.addEventListener("execution_error", () => setStatus(STATUS.OFFLINE));

function fmtSize(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + " GB";
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + " MB";
  return (bytes / 1024).toFixed(0) + " KB";
}

async function loadModels() {
  if (!modelListEl) return;
  modelListEl.innerHTML = `<div style="color:#888;padding:8px 0;font-size:12px;">Loading...</div>`;
  try {
    const resp = await api.fetchApi(`${MODAL_PREFIX}/models`);
    if (resp.status === 503) {
      modelListEl.innerHTML = `<div style="color:#888;font-size:12px;line-height:1.6;">Modal app not deployed yet.<br>Click <b>↑ Deploy</b> above to get started.</div>`;
      return;
    }
    if (!resp.ok) throw new Error(resp.status);
    const data = await resp.json();
    renderModelList(data);
  } catch (e) {
    modelListEl.innerHTML = `<div style="color:#e05;font-size:12px;">Error: ${e.message}</div>`;
  }
}

function renderModelList(data) {
  modelListEl.innerHTML = "";

  let hasAny = false;
  for (const folder of FOLDERS) {
    const files = data[folder] || [];
    if (files.length === 0) continue;
    hasAny = true;

    const section = document.createElement("div");
    section.style.cssText = "margin-bottom: 10px;";

    const folderLabel = document.createElement("div");
    folderLabel.style.cssText = "font-size:11px; font-weight:600; color:#aaa; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:4px;";
    folderLabel.textContent = folder;
    section.appendChild(folderLabel);

    for (const file of files) {
      const alreadyInjected = file.name.startsWith("modal-");
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:4px; background:#2a2a2a; margin-bottom:3px;";

      const name = document.createElement("span");
      name.style.cssText = "flex:1; font-size:12px; color:#ddd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:ltr; min-width:0;";
      name.title = file.name;
      name.textContent = file.name;

      const size = document.createElement("span");
      size.style.cssText = "font-size:11px; color:#666; flex-shrink:0;";
      size.textContent = fmtSize(file.size);

      if (file.folder && file.folder !== folder) {
        const badge = document.createElement("span");
        badge.style.cssText = "font-size:10px; color:#888; background:#333; border:1px solid #444; border-radius:3px; padding:0 4px; flex-shrink:0;";
        badge.textContent = file.folder;
        row.appendChild(name);
        row.appendChild(badge);
        row.appendChild(size);
      } else {
        row.appendChild(name);
        row.appendChild(size);
      }

      const delBtn = document.createElement("button");
      delBtn.textContent = "✕";
      delBtn.title = `Delete ${file.name}`;
      delBtn.style.cssText = `
        background: transparent; border: 1px solid #555; color: #e05;
        width: 20px; height: 20px; border-radius: 3px; cursor: pointer;
        font-size: 11px; flex-shrink: 0; line-height: 1;
        display: flex; align-items: center; justify-content: center;
      `;
      delBtn.onclick = async () => {
        if (!confirm(`Delete ${file.folder ?? folder}/${file.name}?`)) return;
        delBtn.disabled = true;
        delBtn.textContent = "…";
        try {
          const r = await api.fetchApi(`${MODAL_PREFIX}/models/${file.folder ?? folder}/${encodeURIComponent(file.name)}`, { method: "DELETE" });
          const result = await r.json();
          if (result.status === "ok") {
            row.remove();
          } else {
            alert(`Delete failed: ${result.message}`);
            delBtn.disabled = false;
            delBtn.textContent = "✕";
          }
        } catch (e) {
          alert(`Error: ${e.message}`);
          delBtn.disabled = false;
          delBtn.textContent = "✕";
        }
      };

      const injectBtn = document.createElement("button");
      injectBtn.title = alreadyInjected ? "Already injected as local placeholder" : `Inject as modal-${file.name}`;
      injectBtn.textContent = alreadyInjected ? "✓" : "⬇L";
      injectBtn.style.cssText = `
        background: transparent; border: 1px solid ${alreadyInjected ? "#3a3" : "#557"}; color: ${alreadyInjected ? "#3a3" : "#99b"};
        width: 28px; height: 20px; border-radius: 3px; cursor: ${alreadyInjected ? "default" : "pointer"};
        font-size: 10px; flex-shrink: 0; line-height: 1;
      `;
      if (!alreadyInjected) {
        injectBtn.onclick = async () => {
          injectBtn.disabled = true;
          injectBtn.textContent = "…";
          try {
            const r = await api.fetchApi(`${MODAL_PREFIX}/models/inject`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ folder: file.folder ?? folder, filename: file.name }),
            });
            const result = await r.json();
            if (result.status === "ok") {
              injectBtn.textContent = "✓";
              injectBtn.style.color = "#3a3";
              injectBtn.style.borderColor = "#3a3";
              injectBtn.title = `Injected as ${result.name}`;
            } else {
              throw new Error(result.message);
            }
          } catch (e) {
            injectBtn.textContent = "!";
            injectBtn.style.color = "#e05";
            injectBtn.title = `Error: ${e.message}`;
            setTimeout(() => {
              injectBtn.disabled = false;
              injectBtn.textContent = "⬇L";
              injectBtn.style.color = "#99b";
            }, 2000);
          }
        };
      }

      row.appendChild(name);
      row.appendChild(size);
      row.appendChild(injectBtn);
      row.appendChild(delBtn);
      section.appendChild(row);
    }

    modelListEl.appendChild(section);
  }

  if (!hasAny) {
    modelListEl.innerHTML = `<div style="color:#666;font-size:12px;padding:8px 0;">No models in volume.</div>`;
  }
}

const downloadQueue = [];
let queueListEl = null;
let downloadAllBtn = null;
let batchStatusEl = null;

function renderQueueItem(entry) {
  const row = document.createElement("div");
  row.dataset.id = entry.id;
  row.style.cssText = "display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:4px; background:#1e1e2e; margin-bottom:3px;";

  const info = document.createElement("div");
  info.style.cssText = "flex:1; min-width:0;";

  const nameLine = document.createElement("div");
  nameLine.style.cssText = "font-size:12px; color:#ddd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
  nameLine.textContent = `${entry.folder}/${entry.filename}`;
  nameLine.title = entry.url;

  const statusLine = document.createElement("div");
  statusLine.style.cssText = "font-size:10px; color:#888; margin-top:1px;";
  statusLine.textContent = "queued";
  statusLine.dataset.status = "queued";

  info.appendChild(nameLine);
  info.appendChild(statusLine);

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "✕";
  removeBtn.style.cssText = `
    background: transparent; border: 1px solid #555; color: #888;
    width: 18px; height: 18px; border-radius: 3px; cursor: pointer;
    font-size: 10px; flex-shrink: 0; line-height: 1;
    display: flex; align-items: center; justify-content: center;
  `;
  removeBtn.onclick = () => {
    const idx = downloadQueue.findIndex(e => e.id === entry.id);
    if (idx !== -1) downloadQueue.splice(idx, 1);
    row.remove();
    syncDownloadAllBtn();
  };

  row.appendChild(info);
  row.appendChild(removeBtn);

  entry.statusEl = statusLine;
  entry.removeBtn = removeBtn;

  return row;
}

function syncDownloadAllBtn() {
  if (!downloadAllBtn) return;
  const queued = downloadQueue.filter(e => e.state === "queued").length;
  downloadAllBtn.disabled = queued === 0;
  downloadAllBtn.textContent = queued > 1
    ? `⬇ Download All (${queued})`
    : "⬇ Download";
}

function buildAuthPanel(onConnected) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex; flex-direction:column; gap:12px; padding:14px 16px; height:100%; box-sizing:border-box;";

  const title = document.createElement("div");
  title.style.cssText = "font-weight:600; font-size:14px;";
  title.textContent = "☁ Modal GPU";
  wrap.appendChild(title);

  const desc = document.createElement("div");
  desc.style.cssText = "font-size:12px; color:#aaa; line-height:1.6;";
  desc.innerHTML = `Connect your <a href="https://modal.com" target="_blank" style="color:#6a9fd8;">Modal</a> account to run generations on cloud GPUs.`;
  wrap.appendChild(desc);

  const steps = document.createElement("ol");
  steps.style.cssText = "font-size:12px; color:#aaa; line-height:1.8; padding-left:18px; margin:0;";
  steps.innerHTML = `
    <li>Create a free account at <a href="https://modal.com" target="_blank" style="color:#6a9fd8;">modal.com</a></li>
    <li>Go to <a href="https://modal.com/settings/tokens" target="_blank" style="color:#6a9fd8;">Settings → Tokens</a></li>
    <li>Create a new token and paste below</li>
  `;
  wrap.appendChild(steps);

  const pasteHint = document.createElement("div");
  pasteHint.style.cssText = "font-size:11px; color:#888; line-height:1.5;";
  pasteHint.innerHTML = `You can paste the full command directly:<br><span style="color:#666; font-family:monospace;">modal token set --token-id ak-... --token-secret as-...</span>`;
  wrap.appendChild(pasteHint);

  const pasteInput = document.createElement("input");
  pasteInput.type = "text";
  pasteInput.placeholder = "Paste full command or Token ID (ak-...)";
  pasteInput.style.cssText = inputStyle();
  wrap.appendChild(pasteInput);

  const tokenSecretInput = document.createElement("input");
  tokenSecretInput.type = "password";
  tokenSecretInput.placeholder = "Token Secret  (as-...)  — auto-filled if pasted above";
  tokenSecretInput.style.cssText = inputStyle();
  wrap.appendChild(tokenSecretInput);

  function tryParseCommand(val) {
    const idMatch = val.match(/--token-id\s+(ak-\S+)/);
    const secretMatch = val.match(/--token-secret\s+(as-\S+)/);
    if (idMatch && secretMatch) {
      pasteInput.value = idMatch[1];
      tokenSecretInput.value = secretMatch[1];
      return true;
    }
    return false;
  }
  pasteInput.addEventListener("input", () => tryParseCommand(pasteInput.value));
  pasteInput.addEventListener("paste", (e) => {
    const pasted = (e.clipboardData || window.clipboardData).getData("text");
    if (tryParseCommand(pasted)) e.preventDefault();
  });

  const tokenIdInput = { get value() { return pasteInput.value; } };

  const errorEl = document.createElement("div");
  errorEl.style.cssText = "font-size:11px; color:#e05050; min-height:14px;";
  wrap.appendChild(errorEl);

  const connectBtn = document.createElement("button");
  connectBtn.textContent = "Connect & Deploy";
  connectBtn.style.cssText = btnStyle("primary");
  connectBtn.onclick = async () => {
    const token_id = pasteInput.value.trim();
    const token_secret = tokenSecretInput.value.trim();
    errorEl.textContent = "";
    if (!token_id || !token_secret) {
      errorEl.textContent = "Both fields are required.";
      return;
    }
    connectBtn.disabled = true;
    connectBtn.textContent = "Connecting...";
    try {
      const resp = await api.fetchApi(`${MODAL_PREFIX}/auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token_id, token_secret }),
      });
      const data = await resp.json();
      if (data.status === "ok") {
        onConnected();
      } else {
        errorEl.textContent = data.message || "Connection failed.";
        connectBtn.disabled = false;
        connectBtn.textContent = "Connect & Deploy";
      }
    } catch (e) {
      errorEl.textContent = `Error: ${e.message}`;
      connectBtn.disabled = false;
      connectBtn.textContent = "Connect & Deploy";
    }
  };
  wrap.appendChild(connectBtn);

  return wrap;
}

function buildPanel() {
  const panel = document.createElement("div");
  panel.style.cssText = `
    padding: 14px 16px;
    font-size: 13px;
    color: var(--fg-color, #ddd);
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow: hidden;
  `;

  const headerRow = document.createElement("div");
  headerRow.style.cssText = "display:flex; align-items:center; gap:8px; flex-shrink:0;";

  const title = document.createElement("span");
  title.style.cssText = "font-weight:600; font-size:14px; letter-spacing:0.03em; flex:1;";
  title.textContent = "☁ Modal GPU";

  const toggleLabel = document.createElement("label");
  toggleLabel.style.cssText = "display:flex; align-items:center; gap:5px; cursor:pointer; flex-shrink:0;";
  toggleLabel.title = "Toggle Modal GPU routing. Off = use local ComfyUI.";

  const toggleInput = document.createElement("input");
  toggleInput.type = "checkbox";
  toggleInput.style.cssText = "cursor:pointer; width:14px; height:14px;";

  const savedEnabled = localStorage.getItem(STORAGE_KEY_ENABLED);
  toggleInput.checked = savedEnabled === null ? true : savedEnabled === "true";

  const toggleText = document.createElement("span");
  toggleText.style.cssText = "font-size:11px; color:#aaa;";
  toggleText.textContent = toggleInput.checked ? "Modal ON" : "Local";

  toggleInput.addEventListener("change", () => {
    const enabled = toggleInput.checked;
    localStorage.setItem(STORAGE_KEY_ENABLED, String(enabled));
    toggleText.textContent = enabled ? "Modal ON" : "Local";
    updateModalSections(enabled);
    window._comfyModalEnabled = enabled;
  });

  toggleLabel.appendChild(toggleInput);
  toggleLabel.appendChild(toggleText);
  const redeployBtn = document.createElement("button");
  redeployBtn.textContent = "↑ Deploy";
  redeployBtn.title = "Re-deploy comfyapp.py to Modal";
  redeployBtn.style.cssText = btnStyle() + "flex-shrink:0;";
  redeployBtn.onclick = async () => {
    redeployBtn.disabled = true;
    try {
      await api.fetchApi(`${MODAL_PREFIX}/deploy`, { method: "POST" });
      startDeployPoll();
    } catch (e) {
      setDeployBanner("error", e.message);
    }
    setTimeout(() => { redeployBtn.disabled = false; }, 3000);
  };

  const reimportKeyBtn = document.createElement("button");
  reimportKeyBtn.textContent = "🔑 API Key";
  reimportKeyBtn.title = "Re-enter Modal API key";
  reimportKeyBtn.style.cssText = btnStyle() + "flex-shrink:0;";
  reimportKeyBtn.onclick = () => {
    const container = panel.parentElement;
    if (!container) return;
    container.innerHTML = "";
    container.appendChild(buildAuthPanel(() => {
      container.innerHTML = "";
      container.appendChild(buildPanel());
      startDeployPoll();
    }));
  };

  headerRow.appendChild(title);
  headerRow.appendChild(reimportKeyBtn);
  headerRow.appendChild(redeployBtn);
  headerRow.appendChild(toggleLabel);
  panel.appendChild(headerRow);

  deployBannerEl = document.createElement("div");
  deployBannerEl.style.cssText = "font-size:11px; padding:5px 8px; border-radius:4px; background:#1a1a1a; flex-shrink:0; display:none; line-height:1.4;";
  deployBannerTextEl = document.createElement("span");
  deployBannerEl.appendChild(deployBannerTextEl);
  panel.appendChild(deployBannerEl);

  const gpuRow = document.createElement("div");
  gpuRow.style.cssText = "display:flex; align-items:center; gap:8px; flex-shrink:0;";

  const gpuLabel = document.createElement("span");
  gpuLabel.style.cssText = "font-size:12px; color:#aaa; flex-shrink:0;";
  gpuLabel.textContent = "GPU";

  const gpuSelect = document.createElement("select");
  gpuSelect.style.cssText = inputStyle() + "flex:1; margin:0;";
  for (const opt of GPU_OPTIONS) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    gpuSelect.appendChild(o);
  }

  const savedGpu = localStorage.getItem(STORAGE_KEY_GPU) || "a10g";
  gpuSelect.value = savedGpu;
  window._comfyModalGpu = savedGpu;

  gpuSelect.addEventListener("change", async () => {
    const gpu = gpuSelect.value;
    localStorage.setItem(STORAGE_KEY_GPU, gpu);
    window._comfyModalGpu = gpu;
    try {
      await api.fetchApi(`${MODAL_PREFIX}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gpu }),
      });
    } catch {}
  });

  gpuRow.appendChild(gpuLabel);
  gpuRow.appendChild(gpuSelect);

  dotEl = document.createElement("span");
  dotEl.style.cssText = "width:9px; height:9px; border-radius:50%; background:#888; display:inline-block; flex-shrink:0;";
  statusEl = document.createElement("span");
  statusEl.style.cssText = "font-size:11px; color:#888; flex-shrink:0;";
  statusEl.textContent = "Not checked";

  const checkBtn = document.createElement("button");
  checkBtn.textContent = "Check";
  checkBtn.title = "Check if Modal app is deployed (instant)";
  checkBtn.style.cssText = btnStyle();
  checkBtn.onclick = () => checkHealth(false);

  const pingBtn = document.createElement("button");
  pingBtn.textContent = "Ping";
  pingBtn.title = "Wake up Modal container and confirm it's alive (may take 1-3 min on cold start)";
  pingBtn.style.cssText = btnStyle();
  pingBtn.onclick = async () => {
    pingBtn.disabled = true;
    pingBtn.textContent = "Pinging...";
    await checkHealth(true);
    pingBtn.disabled = false;
    pingBtn.textContent = "Ping";
  };

  gpuRow.appendChild(dotEl);
  gpuRow.appendChild(statusEl);
  gpuRow.appendChild(checkBtn);
  gpuRow.appendChild(pingBtn);
  panel.appendChild(gpuRow);

  const hr = document.createElement("div");
  hr.style.cssText = "border-top: 1px solid #3a3a3a; flex-shrink:0;";
  panel.appendChild(hr);

  const modalSections = document.createElement("div");
  modalSections.style.cssText = "display:flex; flex-direction:column; gap:10px; flex:1; overflow:hidden; min-height:0;";

  // --- Custom Nodes Section ---
  const customNodesSection = document.createElement("div");
  customNodesSection.style.cssText = "display:flex; flex-direction:column; gap:6px; flex-shrink:0;";

  const cnHeader = document.createElement("div");
  cnHeader.style.cssText = "display:flex; align-items:center; gap:6px; flex-shrink:0;";

  const cnTitle = document.createElement("span");
  cnTitle.style.cssText = "font-weight:600; font-size:13px; flex:1;";
  cnTitle.textContent = "Custom Nodes";

  const cnRefreshBtn = document.createElement("button");
  cnRefreshBtn.textContent = "↺";
  cnRefreshBtn.title = "Refresh custom nodes list";
  cnRefreshBtn.style.cssText = btnStyle();
  cnRefreshBtn.onclick = () => loadCustomNodes();

  cnHeader.appendChild(cnTitle);
  cnHeader.appendChild(cnRefreshBtn);
  customNodesSection.appendChild(cnHeader);

  const cnListEl = document.createElement("div");
  cnListEl.style.cssText = "max-height:120px; overflow-y:auto;";
  customNodesSection.appendChild(cnListEl);

  const cnNotice = document.createElement("div");
  cnNotice.style.cssText = "font-size:11px; color:#f5a623; display:none;";
  cnNotice.textContent = "Click Deploy to apply changes.";
  customNodesSection.appendChild(cnNotice);

  const cnInputRow = document.createElement("div");
  cnInputRow.style.cssText = "display:flex; gap:6px;";

  const cnInput = document.createElement("input");
  cnInput.type = "text";
  cnInput.placeholder = "https://github.com/user/comfyui-node";
  cnInput.style.cssText = inputStyle() + "flex:1;";

  const cnAddBtn = document.createElement("button");
  cnAddBtn.textContent = "Add";
  cnAddBtn.style.cssText = btnStyle();

  cnInputRow.appendChild(cnInput);
  cnInputRow.appendChild(cnAddBtn);
  customNodesSection.appendChild(cnInputRow);

  let cnInstallStatus = {};

  function renderCustomNodesList(nodes) {
    cnListEl.innerHTML = "";
    if (!nodes || nodes.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "font-size:11px; color:#666; padding:4px 0;";
      empty.textContent = "No custom nodes configured.";
      cnListEl.appendChild(empty);
      return;
    }
    for (const url of nodes) {
      const repoName = url.replace(/\/$/, "").split("/").pop().replace(/\.git$/, "");
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:4px; background:#2a2a2a; margin-bottom:3px;";

      const name = document.createElement("span");
      name.style.cssText = "flex:1; font-size:12px; color:#ddd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0;";
      name.title = url;
      name.textContent = repoName;

      const statusInfo = cnInstallStatus[url];
      if (statusInfo) {
        const badge = document.createElement("span");
        badge.style.cssText = "font-size:10px; flex-shrink:0; padding:1px 4px; border-radius:3px;";
        if (statusInfo.status === "ok") {
          badge.style.color = "#7ed321";
          badge.style.border = "1px solid #3a5";
          badge.textContent = "\u2713";
        } else {
          badge.style.color = "#e05050";
          badge.style.border = "1px solid #a33";
          badge.textContent = "\u2717";
          badge.title = statusInfo.error || "Install failed";
        }
        row.appendChild(name);
        row.appendChild(badge);
      } else {
        row.appendChild(name);
      }

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "\u2715";
      removeBtn.title = "Remove " + repoName;
      removeBtn.style.cssText = `
        background: transparent; border: 1px solid #555; color: #e05;
        width: 20px; height: 20px; border-radius: 3px; cursor: pointer;
        font-size: 11px; flex-shrink: 0; line-height: 1;
        display: flex; align-items: center; justify-content: center;
      `;
      removeBtn.onclick = async () => {
        removeBtn.disabled = true;
        removeBtn.textContent = "\u2026";
        try {
          const r = await api.fetchApi(`${MODAL_PREFIX}/custom-nodes`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          });
          const data = await r.json();
          if (data.status === "ok") {
            renderCustomNodesList(data.nodes);
            cnNotice.style.display = "block";
          }
        } catch (e) {
          removeBtn.disabled = false;
          removeBtn.textContent = "\u2715";
        }
      };

      row.appendChild(removeBtn);
      cnListEl.appendChild(row);
    }
  }

  async function loadCustomNodes() {
    cnListEl.innerHTML = '<div style="color:#888;font-size:11px;">Loading...</div>';
    try {
      const resp = await api.fetchApi(`${MODAL_PREFIX}/custom-nodes`);
      const data = await resp.json();
      renderCustomNodesList(data.nodes || []);
    } catch (e) {
      cnListEl.innerHTML = `<div style="color:#e05;font-size:11px;">Error: ${e.message}</div>`;
    }
    // Try to load install status
    try {
      const resp = await api.fetchApi(`${MODAL_PREFIX}/custom-nodes/status`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.status === "ok" && Array.isArray(data.nodes)) {
          cnInstallStatus = {};
          for (const n of data.nodes) {
            cnInstallStatus[n.url] = n;
          }
          // Re-render with status
          const listResp = await api.fetchApi(`${MODAL_PREFIX}/custom-nodes`);
          const listData = await listResp.json();
          renderCustomNodesList(listData.nodes || []);
        }
      }
    } catch {}
  }

  cnAddBtn.onclick = async () => {
    const url = cnInput.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      cnInput.style.borderColor = "#e05";
      return;
    }
    cnInput.style.borderColor = "#444";
    cnAddBtn.disabled = true;
    try {
      const r = await api.fetchApi(`${MODAL_PREFIX}/custom-nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await r.json();
      if (data.status === "ok") {
        renderCustomNodesList(data.nodes);
        cnInput.value = "";
        cnNotice.style.display = "block";
      } else {
        cnInput.style.borderColor = "#e05";
      }
    } catch (e) {
      cnInput.style.borderColor = "#e05";
    }
    cnAddBtn.disabled = false;
  };

  cnInput.addEventListener("keydown", (e) => { if (e.key === "Enter") cnAddBtn.click(); });

  modalSections.appendChild(customNodesSection);

  const cnHr = document.createElement("div");
  cnHr.style.cssText = "border-top: 1px solid #3a3a3a; flex-shrink:0;";
  modalSections.appendChild(cnHr);

  // --- Models Section ---

  const modelsSection = document.createElement("div");
  modelsSection.style.cssText = "display:flex; flex-direction:column; gap:6px; flex:1; overflow:hidden; min-height:0;";

  const listHeader = document.createElement("div");
  listHeader.style.cssText = "display:flex; align-items:center; gap:6px; flex-shrink:0;";

  const listTitle = document.createElement("span");
  listTitle.style.cssText = "font-weight:600; font-size:13px; flex:1;";
  listTitle.textContent = "Models";

  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = "↺ Refresh";
  refreshBtn.style.cssText = btnStyle();
  refreshBtn.onclick = loadModels;

  listHeader.appendChild(listTitle);
  listHeader.appendChild(refreshBtn);
  modelsSection.appendChild(listHeader);

  modelListEl = document.createElement("div");
  modelListEl.style.cssText = "flex:1; overflow-y:auto; min-height:0;";
  modelsSection.appendChild(modelListEl);

  modalSections.appendChild(modelsSection);

  const addSection = document.createElement("div");
  addSection.style.cssText = "display:flex; flex-direction:column; gap:6px; flex-shrink:0; border-top:1px solid #3a3a3a; padding-top:10px;";

  const addTitle = document.createElement("div");
  addTitle.style.cssText = "font-weight:600; font-size:13px;";
  addTitle.textContent = "Add Model";
  addSection.appendChild(addTitle);

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.placeholder = "Model URL (https://...)";
  urlInput.style.cssText = inputStyle();
  addSection.appendChild(urlInput);

  const row2 = document.createElement("div");
  row2.style.cssText = "display:flex; gap:6px;";

  const folderSelect = document.createElement("select");
  folderSelect.style.cssText = inputStyle() + "flex:1;";
  for (const f of DOWNLOAD_FOLDERS) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = f;
    folderSelect.appendChild(opt);
  }

  const filenameInput = document.createElement("input");
  filenameInput.type = "text";
  filenameInput.placeholder = "filename.safetensors";
  filenameInput.style.cssText = inputStyle() + "flex:2;";

  row2.appendChild(folderSelect);
  row2.appendChild(filenameInput);
  addSection.appendChild(row2);

  const addToQueueBtn = document.createElement("button");
  addToQueueBtn.textContent = "+ Add to Queue";
  addToQueueBtn.style.cssText = btnStyle();
  addToQueueBtn.style.width = "100%";
  urlInput.addEventListener("blur", () => {
    const url = urlInput.value.trim();
    if (!url || filenameInput.value.trim()) return;
    try {
      const parts = new URL(url).pathname.split("/");
      const name = parts.filter(Boolean).pop() || "";
      if (name.includes(".")) filenameInput.value = decodeURIComponent(name);
    } catch {}
  });

  addToQueueBtn.onclick = () => {
    let url = urlInput.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    if (!filenameInput.value.trim()) {
      try {
        const parts = new URL(url).pathname.split("/");
        const name = parts.filter(Boolean).pop() || "";
        if (name.includes(".")) filenameInput.value = decodeURIComponent(name);
      } catch {}
    }
    const filename = filenameInput.value.trim();
    const folder = folderSelect.value;
    if (!url || !filename) return;
    const entry = { id: Date.now() + Math.random(), url, filename, folder, state: "queued" };
    downloadQueue.push(entry);
    const row = renderQueueItem(entry);
    queueListEl.appendChild(row);
    urlInput.value = "";
    filenameInput.value = "";
    syncDownloadAllBtn();
  };

  const enterSubmit = (e) => { if (e.key === "Enter") addToQueueBtn.click(); };
  urlInput.addEventListener("keydown", enterSubmit);
  filenameInput.addEventListener("keydown", enterSubmit);

  addSection.appendChild(addToQueueBtn);

  const queueHeader = document.createElement("div");
  queueHeader.style.cssText = "font-size:11px; font-weight:600; color:#aaa; text-transform:uppercase; letter-spacing:0.05em;";
  queueHeader.textContent = "Queue";
  addSection.appendChild(queueHeader);

  queueListEl = document.createElement("div");
  queueListEl.style.cssText = "max-height:100px; overflow-y:auto;";
  addSection.appendChild(queueListEl);

  batchStatusEl = document.createElement("div");
  batchStatusEl.style.cssText = "font-size:11px; color:#888; min-height:14px;";
  addSection.appendChild(batchStatusEl);

  downloadAllBtn = document.createElement("button");
  downloadAllBtn.textContent = "⬇ Download";
  downloadAllBtn.disabled = true;
  downloadAllBtn.style.cssText = btnStyle("primary");
  downloadAllBtn.onclick = async () => {
    const pending = downloadQueue.filter(e => e.state === "queued");
    if (pending.length === 0) return;

    downloadAllBtn.disabled = true;
    batchStatusEl.style.color = "#f5a623";
    batchStatusEl.textContent = `Sending ${pending.length} download(s) to Modal...`;

    pending.forEach(e => {
      e.state = "running";
      if (e.statusEl) {
        e.statusEl.textContent = "⏳ downloading...";
        e.statusEl.style.color = "#f5a623";
      }
      if (e.removeBtn) e.removeBtn.disabled = true;
    });

    const items = pending.map(e => ({ url: e.url, filename: e.filename, save_path: e.folder }));

    try {
      const resp = await api.fetchApi(`${MODAL_PREFIX}/models/batch-install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const data = await resp.json();

      if (data.status === "ok") {
        const injectPromises = [];
        data.results.forEach((res, i) => {
          const entry = pending[i];
          if (!entry) return;
          entry.state = "done";
          if (entry.statusEl) {
            entry.statusEl.textContent = res.skipped ? "✓ already exists" : "✓ done";
            entry.statusEl.style.color = "#7ed321";
          }
          injectPromises.push(
            api.fetchApi(`${MODAL_PREFIX}/models/inject`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ folder: entry.folder, filename: entry.filename }),
            }).catch(() => {})
          );
        });
        await Promise.all(injectPromises);
        batchStatusEl.style.color = "#7ed321";
        batchStatusEl.textContent = `Done — ${pending.length} model(s) downloaded.`;
        await loadModels();
      } else {
        throw new Error(data.message || "Unknown error");
      }
    } catch (e) {
      pending.forEach(entry => {
        if (entry.state !== "done") {
          entry.state = "queued";
          if (entry.statusEl) {
            entry.statusEl.textContent = "✗ failed — re-queued";
            entry.statusEl.style.color = "#e05";
          }
          if (entry.removeBtn) entry.removeBtn.disabled = false;
        }
      });
      batchStatusEl.style.color = "#e05";
      batchStatusEl.textContent = `Error: ${e.message}`;
    }

    syncDownloadAllBtn();
  };
  addSection.appendChild(downloadAllBtn);

  modalSections.appendChild(addSection);
  panel.appendChild(modalSections);

  const localNotice = document.createElement("div");
  localNotice.style.cssText = "font-size:12px; color:#888; line-height:1.5; flex-shrink:0; display:none;";
  localNotice.textContent = "Local mode: prompts go directly to ComfyUI. GPU routing is off.";
  panel.appendChild(localNotice);

  const hfHr = document.createElement("div");
  hfHr.style.cssText = "border-top: 1px solid #3a3a3a; flex-shrink:0;";
  panel.appendChild(hfHr);

  const hfSection = document.createElement("div");
  hfSection.style.cssText = "display:flex; flex-direction:column; gap:6px; flex-shrink:0;";

  const hfTitle = document.createElement("div");
  hfTitle.style.cssText = "font-weight:600; font-size:13px;";
  hfTitle.textContent = "🤗 HuggingFace API Key";
  hfSection.appendChild(hfTitle);

  const hfDesc = document.createElement("div");
  hfDesc.style.cssText = "font-size:11px; color:#888; line-height:1.5;";
  hfDesc.textContent = "Required for downloading gated models. Saved locally.";
  hfSection.appendChild(hfDesc);

  const hfRow = document.createElement("div");
  hfRow.style.cssText = "display:flex; gap:6px;";

  const hfInput = document.createElement("input");
  hfInput.type = "password";
  hfInput.placeholder = "hf_...";
  hfInput.style.cssText = inputStyle() + "flex:1;";

  const hfSaveBtn = document.createElement("button");
  hfSaveBtn.textContent = "Save";
  hfSaveBtn.style.cssText = btnStyle();

  hfRow.appendChild(hfInput);
  hfRow.appendChild(hfSaveBtn);
  hfSection.appendChild(hfRow);

  const hfStatus = document.createElement("div");
  hfStatus.style.cssText = "font-size:11px; color:#888; min-height:14px;";
  hfSection.appendChild(hfStatus);

  panel.appendChild(hfSection);

  (async () => {
    try {
      const r = await api.fetchApi(`${MODAL_PREFIX}/hf-token`);
      const d = await r.json();
      if (d.token) hfStatus.textContent = `Saved: ${d.token}`;
    } catch {}
  })();

  hfSaveBtn.onclick = async () => {
    const token = hfInput.value.trim();
    hfStatus.textContent = "";
    hfSaveBtn.disabled = true;
    try {
      const r = await api.fetchApi(`${MODAL_PREFIX}/hf-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const d = await r.json();
      if (d.status === "ok") {
        hfStatus.style.color = "#5c9";
        hfStatus.textContent = token ? "Saved ✓" : "Cleared";
        hfInput.value = "";
      } else {
        hfStatus.style.color = "#e05";
        hfStatus.textContent = d.message || "Error saving token.";
      }
    } catch (e) {
      hfStatus.style.color = "#e05";
      hfStatus.textContent = `Error: ${e.message}`;
    }
    hfSaveBtn.disabled = false;
  };
  hfInput.addEventListener("keydown", (e) => { if (e.key === "Enter") hfSaveBtn.click(); });

  function updateModalSections(enabled) {
    modalSections.style.display = enabled ? "flex" : "none";
    localNotice.style.display = enabled ? "none" : "block";
    gpuSelect.disabled = !enabled;
    checkBtn.disabled = !enabled;
  }

  updateModalSections(toggleInput.checked);
  window._comfyModalEnabled = toggleInput.checked;

  (async () => {
    try {
      await api.fetchApi(`${MODAL_PREFIX}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gpu: savedGpu }),
      });
    } catch {}
  })();

  startDeployPoll();
  loadModels();
  loadCustomNodes();

  return panel;
}

function btnStyle(variant) {
  if (variant === "primary") {
    return `
      background: #3a6fcc; border: 1px solid #4a7fe0; color: #fff;
      padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;
      width: 100%;
    `;
  }
  return `
    background: #3a3a3a; border: 1px solid #555; color: #ddd;
    padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;
  `;
}

function inputStyle() {
  return `
    background: #222; border: 1px solid #444; color: #ddd;
    padding: 5px 8px; border-radius: 4px; font-size: 12px;
    width: 100%; box-sizing: border-box; outline: none;
  `;
}

app.registerExtension({
  name: "comfyui.modal.settings",

  async setup() {
    if (app?.extensionManager?.registerSidebarTab) {
      app.extensionManager.registerSidebarTab({
        id: "modal-gpu",
        icon: "pi pi-cloud",
        title: "Modal GPU",
        tooltip: "Modal GPU model manager",
        type: "custom",
        render: async (el) => {
          el.style.height = "100%";

          async function mount() {
            el.innerHTML = "";
            try {
              const resp = await api.fetchApi(`${MODAL_PREFIX}/auth/status`);
              const { connected } = await resp.json();
              if (connected) {
                el.appendChild(buildPanel());
              } else {
                el.appendChild(buildAuthPanel(() => {
                  el.innerHTML = "";
                  el.appendChild(buildPanel());
                  startDeployPoll();
                }));
              }
            } catch {
              el.appendChild(buildPanel());
            }
          }

          await mount();
        },
      });
    }
  },
});
