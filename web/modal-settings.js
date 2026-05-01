import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MODAL_PREFIX = "/comfymodal";

// Sections shown in the Models panel (order matters).
// "checkpoints" groups: checkpoints/ + diffusion_models/ + unet/
const FOLDERS = ["checkpoints", "loras", "vae", "controlnet", "upscale_models", "embeddings", "clip", "text_encoders"];

// Folders available in the "Add Model" download dropdown
const DOWNLOAD_FOLDERS = ["checkpoints", "diffusion_models", "loras", "vae", "controlnet", "upscale_models", "embeddings", "clip", "text_encoders"];

const GPU_OPTIONS = [
  { value: "a10g",    label: "A10G   (24 GB VRAM) — recommended" },
  { value: "l4",      label: "L4     (24 GB VRAM)" },
  { value: "l40s",    label: "L40S   (48 GB VRAM)" },
  { value: "a100",    label: "A100   (40 GB VRAM)" },
  { value: "a100-80gb", label: "A100   (80 GB VRAM)" },
  { value: "h100",    label: "H100   (80 GB VRAM)" },
  { value: "h200",    label: "H200   (141 GB VRAM)" },
  { value: "t4",      label: "T4     (16 GB VRAM) — budget" },
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
let injectAllBtn = null;
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
  let nonInjectedCount = 0;
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
      if (!alreadyInjected) nonInjectedCount++;
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

  if (injectAllBtn) {
    injectAllBtn.style.display = nonInjectedCount > 0 ? "" : "none";
    injectAllBtn.title = `Inject all ${nonInjectedCount} non-injected models as local placeholders`;
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

  const _rawSavedGpu = localStorage.getItem(STORAGE_KEY_GPU) || "a10g";
  // Migrate: ensure saved value is valid; fall back to a10g if unknown
  const _validGpuValues = GPU_OPTIONS.map(o => o.value);
  const savedGpu = _validGpuValues.includes(_rawSavedGpu) ? _rawSavedGpu : "a10g";
  if (savedGpu !== _rawSavedGpu) {
    localStorage.setItem(STORAGE_KEY_GPU, savedGpu);
  }
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

  const tokensSection = document.createElement("div");
  tokensSection.style.cssText = "flex-shrink:0; border-bottom:1px solid #3a3a3a; padding-bottom:8px;";

  const tokensHeader = document.createElement("div");
  tokensHeader.style.cssText = "display:flex; align-items:center; gap:6px; cursor:pointer; padding:6px 0 4px;";

  const tokensArrow = document.createElement("span");
  tokensArrow.style.cssText = "font-size:10px; color:#888; transition:transform 0.15s;";
  tokensArrow.textContent = "▶";

  const tokensTitle = document.createElement("span");
  tokensTitle.style.cssText = "font-size:12px; font-weight:600; color:#aaa;";
  tokensTitle.textContent = "API Tokens";

  const tokensStatusBadge = document.createElement("span");
  tokensStatusBadge.style.cssText = "font-size:10px; color:#888; margin-left:auto;";
  tokensStatusBadge.textContent = "";

  tokensHeader.appendChild(tokensArrow);
  tokensHeader.appendChild(tokensTitle);
  tokensHeader.appendChild(tokensStatusBadge);

  const tokensBody = document.createElement("div");
  tokensBody.style.cssText = "display:none; flex-direction:column; gap:8px; padding-top:4px;";

  let tokensExpanded = false;
  tokensHeader.onclick = () => {
    tokensExpanded = !tokensExpanded;
    tokensBody.style.display = tokensExpanded ? "flex" : "none";
    tokensArrow.style.transform = tokensExpanded ? "rotate(90deg)" : "";
  };

  // HuggingFace token row
  const hfRow = document.createElement("div");
  hfRow.style.cssText = "display:flex; flex-direction:column; gap:4px;";

  const hfLabel = document.createElement("div");
  hfLabel.style.cssText = "font-size:11px; color:#888;";
  hfLabel.textContent = "HuggingFace Token";

  const hfInputRow = document.createElement("div");
  hfInputRow.style.cssText = "display:flex; gap:4px;";

  const hfInput = document.createElement("input");
  hfInput.type = "password";
  hfInput.placeholder = "hf_...";
  hfInput.style.cssText = inputStyle() + "flex:1; margin:0;";

  const hfStatusEl = document.createElement("span");
  hfStatusEl.style.cssText = "font-size:10px; color:#888; align-self:center; flex-shrink:0; min-width:60px; text-align:right;";

  const hfSaveBtn = document.createElement("button");
  hfSaveBtn.textContent = "Save";
  hfSaveBtn.style.cssText = btnStyle() + "padding:4px 8px; flex-shrink:0;";
  hfSaveBtn.onclick = async () => {
    const token = hfInput.value.trim();
    hfSaveBtn.disabled = true;
    hfSaveBtn.textContent = "…";
    try {
      const r = await api.fetchApi(`${MODAL_PREFIX}/settings/hf-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await r.json();
      if (data.status === "ok") {
        hfStatusEl.textContent = token ? "✓ Saved" : "Cleared";
        hfStatusEl.style.color = "#7ed321";
        hfInput.value = "";
        loadTokenStatuses();
      } else {
        hfStatusEl.textContent = data.message || "Error";
        hfStatusEl.style.color = "#e05";
      }
    } catch (e) {
      hfStatusEl.textContent = "Error";
      hfStatusEl.style.color = "#e05";
    }
    hfSaveBtn.disabled = false;
    hfSaveBtn.textContent = "Save";
  };

  hfInputRow.appendChild(hfInput);
  hfInputRow.appendChild(hfSaveBtn);
  hfInputRow.appendChild(hfStatusEl);
  hfRow.appendChild(hfLabel);
  hfRow.appendChild(hfInputRow);

  // CivitAI token row
  const civRow = document.createElement("div");
  civRow.style.cssText = "display:flex; flex-direction:column; gap:4px;";

  const civLabel = document.createElement("div");
  civLabel.style.cssText = "font-size:11px; color:#888;";
  civLabel.textContent = "CivitAI API Key";

  const civInputRow = document.createElement("div");
  civInputRow.style.cssText = "display:flex; gap:4px;";

  const civInput = document.createElement("input");
  civInput.type = "password";
  civInput.placeholder = "API key...";
  civInput.style.cssText = inputStyle() + "flex:1; margin:0;";

  const civStatusEl = document.createElement("span");
  civStatusEl.style.cssText = "font-size:10px; color:#888; align-self:center; flex-shrink:0; min-width:60px; text-align:right;";

  const civSaveBtn = document.createElement("button");
  civSaveBtn.textContent = "Save";
  civSaveBtn.style.cssText = btnStyle() + "padding:4px 8px; flex-shrink:0;";
  civSaveBtn.onclick = async () => {
    const token = civInput.value.trim();
    civSaveBtn.disabled = true;
    civSaveBtn.textContent = "…";
    try {
      const r = await api.fetchApi(`${MODAL_PREFIX}/settings/civitai-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await r.json();
      if (data.status === "ok") {
        civStatusEl.textContent = token ? "✓ Saved" : "Cleared";
        civStatusEl.style.color = "#7ed321";
        civInput.value = "";
        loadTokenStatuses();
      } else {
        civStatusEl.textContent = data.message || "Error";
        civStatusEl.style.color = "#e05";
      }
    } catch (e) {
      civStatusEl.textContent = "Error";
      civStatusEl.style.color = "#e05";
    }
    civSaveBtn.disabled = false;
    civSaveBtn.textContent = "Save";
  };

  civInputRow.appendChild(civInput);
  civInputRow.appendChild(civSaveBtn);
  civInputRow.appendChild(civStatusEl);
  civRow.appendChild(civLabel);
  civRow.appendChild(civInputRow);

  tokensBody.appendChild(hfRow);
  tokensBody.appendChild(civRow);
  tokensSection.appendChild(tokensHeader);
  tokensSection.appendChild(tokensBody);
  panel.appendChild(tokensSection);

  async function loadTokenStatuses() {
    try {
      const [hfResp, civResp] = await Promise.all([
        api.fetchApi(`${MODAL_PREFIX}/settings/hf-token`),
        api.fetchApi(`${MODAL_PREFIX}/settings/civitai-token`),
      ]);
      const hfData = await hfResp.json();
      const civData = await civResp.json();

      let badges = [];
      if (hfData.has_token) badges.push("HF");
      if (civData.has_token) badges.push("CivitAI");
      tokensStatusBadge.textContent = badges.length ? `(${badges.join(", ")} set)` : "";

      if (hfData.has_token) {
        hfStatusEl.textContent = hfData.masked;
        hfStatusEl.style.color = "#7ed321";
      }
      if (civData.has_token) {
        civStatusEl.textContent = civData.masked;
        civStatusEl.style.color = "#7ed321";
      }
    } catch {}
  }

  loadTokenStatuses();

  const modalSections = document.createElement("div");
  modalSections.style.cssText = "display:flex; flex-direction:column; gap:10px; flex:1; overflow:hidden; min-height:0;";

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

  injectAllBtn = document.createElement("button");
  injectAllBtn.textContent = "⬇ All";
  injectAllBtn.title = "Inject all non-injected models as local placeholders";
  injectAllBtn.style.cssText = btnStyle();
  injectAllBtn.style.display = "none";

  injectAllBtn.onclick = async () => {
    const resp = await api.fetchApi(`${MODAL_PREFIX}/models`);
    if (!resp.ok) {
      alert("Inject All failed: Failed to fetch models");
      return;
    }

    const data = await resp.json();
    let count = 0;
    const items = [];

    for (const sectionKey of FOLDERS) {
      const files = data[sectionKey] || [];
      for (const file of files) {
        if (file.name.startsWith("modal-")) continue;
        count++;
        items.push({ folder: file.folder || sectionKey, filename: file.name });
      }
    }

    if (count === 0) return;
    if (count > 10 && !confirm(`Inject all ${count} models?`)) return;

    injectAllBtn.disabled = true;
    injectAllBtn.textContent = "…";

    try {
      const injectResp = await api.fetchApi(`${MODAL_PREFIX}/models/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const result = await injectResp.json();
      if (result.status === "ok") {
        await loadModels();
      } else {
        throw new Error(result.message || "Inject failed");
      }
    } catch (e) {
      alert(`Inject All failed: ${e.message}`);
    }

    injectAllBtn.disabled = false;
    injectAllBtn.textContent = "⬇ All";
  };

  listHeader.appendChild(listTitle);
  listHeader.appendChild(refreshBtn);
  listHeader.appendChild(injectAllBtn);
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

  row2.appendChild(folderSelect);
  addSection.appendChild(row2);

  const addToQueueBtn = document.createElement("button");
  addToQueueBtn.textContent = "+ Add to Queue";
  addToQueueBtn.style.cssText = btnStyle();
  addToQueueBtn.style.width = "100%";

  addToQueueBtn.onclick = () => {
    let url = urlInput.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    let filename = "";
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/");
      const name = parts.filter(Boolean).pop() || "";
      if (name) filename = decodeURIComponent(name);
      if (filename && !filename.includes(".")) {
        const fmt = (parsed.searchParams.get("format") || "").toLowerCase();
        const typeParam = (parsed.searchParams.get("type") || "").toLowerCase();
        if (fmt === "safetensor" || fmt === "safetensors") filename += ".safetensors";
        else if (fmt === "pickletensor" || typeParam === "lora") filename += ".safetensors";
        else if (fmt === "gguf") filename += ".gguf";
        else if (fmt === "pt") filename += ".pt";
        else filename += ".safetensors";
      }
    } catch {}
    if (!filename) filename = "model_" + Date.now() + ".safetensors";
    const folder = folderSelect.value;
    const entry = { id: Date.now() + Math.random(), url, filename, folder, state: "queued" };
    downloadQueue.push(entry);
    const row = renderQueueItem(entry);
    queueListEl.appendChild(row);
    urlInput.value = "";
    syncDownloadAllBtn();
  };

  const enterSubmit = (e) => { if (e.key === "Enter") addToQueueBtn.click(); };
  urlInput.addEventListener("keydown", enterSubmit);


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

  const uploadSection = document.createElement("div");
  uploadSection.style.cssText = "display:flex; flex-direction:column; gap:6px; flex-shrink:0; border-top:1px solid #3a3a3a; padding-top:10px;";

  const uploadTitle = document.createElement("div");
  uploadTitle.style.cssText = "font-weight:600; font-size:13px;";
  uploadTitle.textContent = "Upload Local File";
  uploadSection.appendChild(uploadTitle);

  const uploadFileInput = document.createElement("input");
  uploadFileInput.type = "file";
  uploadFileInput.style.cssText = "font-size:11px; color:#aaa; width:100%; box-sizing:border-box;";
  uploadSection.appendChild(uploadFileInput);

  const uploadRow2 = document.createElement("div");
  uploadRow2.style.cssText = "display:flex; gap:6px;";

  const uploadFolderSelect = document.createElement("select");
  uploadFolderSelect.style.cssText = inputStyle() + "flex:1; margin:0;";
  for (const f of DOWNLOAD_FOLDERS) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = f;
    uploadFolderSelect.appendChild(opt);
  }

  uploadRow2.appendChild(uploadFolderSelect);
  uploadSection.appendChild(uploadRow2);

  // Progress bar
  const uploadProgressWrap = document.createElement("div");
  uploadProgressWrap.style.cssText = "background:#1a1a1a; border-radius:3px; height:6px; overflow:hidden; display:none;";
  const uploadProgressBar = document.createElement("div");
  uploadProgressBar.style.cssText = "height:100%; background:#3a6fcc; width:0%; transition:width 0.1s;";
  uploadProgressWrap.appendChild(uploadProgressBar);
  uploadSection.appendChild(uploadProgressWrap);

  const uploadStatusEl = document.createElement("div");
  uploadStatusEl.style.cssText = "font-size:11px; color:#888; min-height:14px;";
  uploadSection.appendChild(uploadStatusEl);

  const uploadBtn = document.createElement("button");
  uploadBtn.textContent = "⬆ Upload";
  uploadBtn.disabled = true;
  uploadBtn.style.cssText = btnStyle("primary");
  uploadBtn.onclick = () => {
    const file = uploadFileInput.files && uploadFileInput.files[0];
    if (!file) return;
    const folder = uploadFolderSelect.value;
    const filename = file.name;

    uploadBtn.disabled = true;
    uploadProgressWrap.style.display = "block";
    uploadProgressBar.style.width = "0%";
    uploadStatusEl.style.color = "#f5a623";
    uploadStatusEl.textContent = "Uploading...";

    const formData = new FormData();
    formData.append("folder", folder);
    formData.append("filename", filename);
    formData.append("file", file, filename);

    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round(e.loaded / e.total * 100);
        uploadProgressBar.style.width = pct + "%";
        uploadStatusEl.textContent = `Uploading... ${pct}%`;
      }
    };
    xhr.onload = async () => {
      uploadProgressBar.style.width = "100%";
      if (xhr.status >= 200 && xhr.status < 300) {
        let result = {};
        try { result = JSON.parse(xhr.responseText); } catch {}
        if (result.status === "ok") {
          uploadStatusEl.style.color = "#7ed321";
          uploadStatusEl.textContent = `✓ Uploaded ${filename} to ${folder}`;
          uploadFileInput.value = "";
          await loadModels();
        } else {
          uploadStatusEl.style.color = "#e05";
          uploadStatusEl.textContent = `Error: ${result.message || "Upload failed"}`;
        }
      } else {
        let msg = "Upload failed";
        try { msg = JSON.parse(xhr.responseText).message || msg; } catch {}
        uploadStatusEl.style.color = "#e05";
        uploadStatusEl.textContent = `Error: ${msg}`;
      }
      uploadBtn.disabled = false;
    };
    xhr.onerror = () => {
      uploadStatusEl.style.color = "#e05";
      uploadStatusEl.textContent = "Network error";
      uploadBtn.disabled = false;
    };
    xhr.open("POST", "/comfymodal/models/upload");
    xhr.send(formData);
  };

  uploadFileInput.addEventListener("change", () => {
    uploadBtn.disabled = !(uploadFileInput.files && uploadFileInput.files[0]);
  });

  uploadSection.appendChild(uploadBtn);
  modalSections.appendChild(uploadSection);

  const workflowSection = buildWorkflowSection();
  modalSections.appendChild(workflowSection);

  panel.appendChild(modalSections);

  const localNotice = document.createElement("div");
  localNotice.style.cssText = "font-size:12px; color:#888; line-height:1.5; flex-shrink:0; display:none;";
  localNotice.textContent = "Local mode: prompts go directly to ComfyUI. GPU routing is off.";
  panel.appendChild(localNotice);

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

function buildWorkflowSection() {
  const section = document.createElement("div");
  section.style.cssText = "display:flex; flex-direction:column; gap:6px; flex-shrink:0; border-top:1px solid #3a3a3a; padding-top:10px;";

  const headerRow = document.createElement("div");
  headerRow.style.cssText = "display:flex; align-items:center; gap:6px;";

  const title = document.createElement("div");
  title.style.cssText = "font-weight:600; font-size:13px; flex:1;";
  title.textContent = "Workflow Build";

  const resetBtn = document.createElement("button");
  resetBtn.textContent = "↺";
  resetBtn.title = "Reset to current nodes.json";
  resetBtn.style.cssText = btnStyle() + "padding:3px 7px;";

  headerRow.appendChild(title);
  headerRow.appendChild(resetBtn);
  section.appendChild(headerRow);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json";
  fileInput.style.cssText = "font-size:11px; color:#aaa; width:100%; box-sizing:border-box;";
  section.appendChild(fileInput);

  const analyzeBtn = document.createElement("button");
  analyzeBtn.textContent = "Analyze Workflow";
  analyzeBtn.disabled = true;
  analyzeBtn.style.cssText = btnStyle();
  analyzeBtn.style.width = "100%";
  section.appendChild(analyzeBtn);

  const analyzeStatusEl = document.createElement("div");
  analyzeStatusEl.style.cssText = "font-size:11px; color:#888; min-height:14px;";
  section.appendChild(analyzeStatusEl);

  const packageListEl = document.createElement("div");
  packageListEl.style.cssText = "display:none; flex-direction:column; gap:4px; max-height:120px; overflow-y:auto;";
  section.appendChild(packageListEl);

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.placeholder = "Add custom node URL (https://github.com/...)";
  urlInput.style.cssText = inputStyle();
  urlInput.style.display = "none";
  section.appendChild(urlInput);

  const addUrlBtn = document.createElement("button");
  addUrlBtn.textContent = "+ Add URL";
  addUrlBtn.style.cssText = btnStyle();
  addUrlBtn.style.display = "none";

  const buildBtn = document.createElement("button");
  buildBtn.textContent = "⚙ Build & Deploy";
  buildBtn.disabled = true;
  buildBtn.style.cssText = btnStyle("primary");
  buildBtn.style.display = "none";

  const buildRow = document.createElement("div");
  buildRow.style.cssText = "display:flex; gap:6px;";
  buildRow.appendChild(addUrlBtn);
  buildRow.appendChild(buildBtn);
  section.appendChild(buildRow);

  const buildStatusEl = document.createElement("div");
  buildStatusEl.style.cssText = "font-size:11px; color:#888; min-height:14px;";
  section.appendChild(buildStatusEl);

  let pendingNodes = [];

  function renderPackages(nodes, missingRefs) {
    packageListEl.innerHTML = "";
    packageListEl.style.display = nodes.length ? "flex" : "none";
    const missingSet = new Set(missingRefs);

    nodes.forEach(url => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; gap:4px; font-size:11px;";

      const badge = document.createElement("span");
      const isMissing = missingSet.has(url) || (!url.startsWith("http") && url !== "comfyui-manager");
      badge.style.cssText = `flex-shrink:0; padding:1px 5px; border-radius:3px; font-size:10px; ${isMissing ? "background:#5a2020; color:#f88;" : "background:#1e3a1e; color:#7ed321;"}`;
      badge.textContent = isMissing ? "new" : "✓";

      const label = document.createElement("span");
      label.style.cssText = "flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#ccc;";
      label.title = url;
      label.textContent = url === "comfyui-manager" ? "comfyui-manager (core)" : url.replace("https://github.com/", "");

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "✕";
      removeBtn.style.cssText = "background:none; border:none; color:#888; cursor:pointer; padding:0 2px; font-size:11px; flex-shrink:0;";
      removeBtn.onclick = () => {
        pendingNodes = pendingNodes.filter(n => n !== url);
        renderPackages(pendingNodes, []);
        buildBtn.disabled = pendingNodes.length === 0;
      };

      row.appendChild(badge);
      row.appendChild(label);
      row.appendChild(removeBtn);
      packageListEl.appendChild(row);
    });
  }

  async function loadCurrentNodes() {
    try {
      const r = await api.fetchApi(`${MODAL_PREFIX}/workflow/nodes`);
      const data = await r.json();
      if (data.status === "ok") {
        pendingNodes = data.nodes;
        renderPackages(pendingNodes, []);
        urlInput.style.display = "block";
        addUrlBtn.style.display = "block";
        buildBtn.style.display = "block";
        buildBtn.disabled = pendingNodes.length === 0;
      }
    } catch {}
  }

  resetBtn.onclick = () => {
    analyzeStatusEl.textContent = "";
    buildStatusEl.textContent = "";
    loadCurrentNodes();
  };

  fileInput.addEventListener("change", () => {
    analyzeBtn.disabled = !fileInput.files || !fileInput.files[0];
  });

  analyzeBtn.onclick = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    analyzeBtn.disabled = true;
    analyzeBtn.textContent = "Analyzing...";
    analyzeStatusEl.style.color = "#f5a623";
    analyzeStatusEl.textContent = "Fetching comfyui-manager DB...";

    try {
      const text = await file.text();
      let workflow;
      try {
        workflow = JSON.parse(text);
      } catch {
        throw new Error("Invalid JSON file");
      }

      const r = await api.fetchApi(`${MODAL_PREFIX}/workflow/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow }),
      });
      const data = await r.json();
      if (data.status !== "ok") throw new Error(data.message || "Analyze failed");

      const { summary, needed_packages, missing_packages, current_nodes } = data;

      const missingRefs = missing_packages.map(p => p.reference);
      const neededRefs = needed_packages.map(p => p.reference);
      const merged = [...new Set([...current_nodes, ...neededRefs])];
      pendingNodes = merged;

      renderPackages(pendingNodes, missingRefs);

      const missingCount = missing_packages.length;
      const unmatchedCount = summary.unmatched_types ? summary.unmatched_types.length : 0;
      let msg = `Found ${summary.custom_types} custom type(s). `;
      msg += missingCount > 0 ? `${missingCount} new package(s) added.` : "All packages already included.";
      if (unmatchedCount > 0) msg += ` ${unmatchedCount} type(s) unmatched.`;
      analyzeStatusEl.style.color = missingCount > 0 ? "#f5a623" : "#7ed321";
      analyzeStatusEl.textContent = msg;

      urlInput.style.display = "block";
      addUrlBtn.style.display = "block";
      buildBtn.style.display = "block";
      buildBtn.disabled = pendingNodes.length === 0;
    } catch (e) {
      analyzeStatusEl.style.color = "#e05";
      analyzeStatusEl.textContent = `Error: ${e.message}`;
    }

    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analyze Workflow";
  };

  addUrlBtn.onclick = () => {
    const url = urlInput.value.trim();
    if (!url) return;
    if (!pendingNodes.includes(url)) {
      pendingNodes = [...pendingNodes, url];
      renderPackages(pendingNodes, [url]);
      buildBtn.disabled = false;
    }
    urlInput.value = "";
  };

  urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addUrlBtn.click(); });

  buildBtn.onclick = async () => {
    if (pendingNodes.length === 0) return;
    buildBtn.disabled = true;
    buildBtn.textContent = "Building...";
    buildStatusEl.style.color = "#f5a623";
    buildStatusEl.textContent = "Saving nodes and triggering deploy...";

    try {
      const r = await api.fetchApi(`${MODAL_PREFIX}/workflow/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes: pendingNodes }),
      });
      const data = await r.json();
      if (data.status !== "ok") throw new Error(data.message || "Build failed");
      buildStatusEl.style.color = "#7ed321";
      buildStatusEl.textContent = `✓ Deploy started with ${data.nodes.length} package(s).`;
      startDeployPoll();
    } catch (e) {
      buildStatusEl.style.color = "#e05";
      buildStatusEl.textContent = `Error: ${e.message}`;
    }

    buildBtn.disabled = false;
    buildBtn.textContent = "⚙ Build & Deploy";
  };

  loadCurrentNodes();

  return section;
}

function _showOnboardingBanner() {
  if (document.getElementById("modal-onboarding-banner")) return;
  const banner = document.createElement("div");
  banner.id = "modal-onboarding-banner";
  Object.assign(banner.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    zIndex: "9999",
    background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
    color: "#e0e0e0",
    borderRadius: "12px",
    padding: "16px 20px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(99,102,241,0.3)",
    maxWidth: "320px",
    fontFamily: "inherit",
    fontSize: "13px",
    lineHeight: "1.5",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    animation: "modalBannerSlideIn 0.3s ease",
  });

  if (!document.getElementById("modal-banner-styles")) {
    const style = document.createElement("style");
    style.id = "modal-banner-styles";
    style.textContent = `
      @keyframes modalBannerSlideIn {
        from { opacity: 0; transform: translateY(16px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      #modal-onboarding-banner button.modal-banner-btn {
        background: #6366f1;
        color: #fff;
        border: none;
        border-radius: 7px;
        padding: 8px 14px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        transition: background 0.2s;
      }
      #modal-onboarding-banner button.modal-banner-btn:hover { background: #4f46e5; }
      #modal-onboarding-banner button.modal-banner-close {
        background: transparent;
        border: none;
        color: #888;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 0;
        margin-left: auto;
      }
    `;
    document.head.appendChild(style);
  }

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.gap = "8px";

  const icon = document.createElement("span");
  icon.textContent = "☁️";
  icon.style.fontSize = "18px";

  const title = document.createElement("span");
  title.textContent = "Modal GPU not configured";
  title.style.fontWeight = "700";
  title.style.fontSize = "14px";
  title.style.color = "#fff";

  const closeBtn = document.createElement("button");
  closeBtn.className = "modal-banner-close";
  closeBtn.textContent = "✕";
  closeBtn.title = "Dismiss";
  closeBtn.onclick = () => banner.remove();

  header.appendChild(icon);
  header.appendChild(title);
  header.appendChild(closeBtn);

  const msg = document.createElement("div");
  msg.style.color = "#b0b0c0";
  msg.textContent = "Set up your Modal token to run workflows on cloud GPUs.";

  const openBtn = document.createElement("button");
  openBtn.className = "modal-banner-btn";
  openBtn.textContent = "Open Modal Settings →";
  openBtn.onclick = () => {
    _activateModalSidebarTab();
    banner.remove();
  };

  banner.appendChild(header);
  banner.appendChild(msg);
  banner.appendChild(openBtn);
  document.body.appendChild(banner);

  setTimeout(() => { if (banner.parentNode) banner.remove(); }, 15000);
}

function _activateModalSidebarTab() {
  try {
    const em = app?.extensionManager;
    if (em?.sidebarTab) {
      em.sidebarTab.activeSidebarTabId = "modal-gpu";
      return;
    }
  } catch (_) {}

  try {
    const btn = document.querySelector(
      '[data-tab-id="modal-gpu"], [title="Modal GPU"], [aria-label="Modal GPU"]'
    );
    if (btn) { btn.click(); return; }

    const allBtns = document.querySelectorAll(".sidebar-icon-container button, .side-bar-button");
    for (const b of allBtns) {
      if (b.title?.includes("Modal") || b.getAttribute("aria-label")?.includes("Modal")) {
        b.click();
        return;
      }
    }
  } catch (_) {}
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

    setTimeout(async () => {
      try {
        const resp = await api.fetchApi(`${MODAL_PREFIX}/auth/status`);
        const { connected } = await resp.json();
        if (!connected) {
          _showOnboardingBanner();
        }
      } catch (_) {}
    }, 2000);
  },
});
