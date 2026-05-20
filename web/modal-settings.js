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
  { value: "a10g",  label: "A10G - 24GB VRAM (recommended, ~$0.60/hr)" },
  { value: "a100",  label: "A100 - 40GB VRAM (large models, ~$1.10/hr)" },
  { value: "t4",    label: "T4 - 16GB VRAM (budget, ~$0.30/hr)" },
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
let modelsCollapsibleRef = null;
let statusBannerEl = null;
let statusBannerTextEl = null;
let _deployPollTimer = null;
let _deployState = "idle";
let _hasChanges = false;

const STATUS_STYLE = {
  [STATUS.UNKNOWN]:    { color: "#888",    label: "Unknown" },
  [STATUS.CHECKING]:   { color: "#f5a623", label: "Checking..." },
  [STATUS.ONLINE]:     { color: "#7ed321", label: "Ready (container running)" },
  [STATUS.OFFLINE]:    { color: "#888",    label: "Sleeping (will wake on use)" },
  [STATUS.GENERATING]: { color: "#4a90e2", label: "Generating..." },
};

// --- Status Banner Logic ---
function updateStatusBanner() {
  if (!statusBannerEl || !statusBannerTextEl) return;
  let text = "";
  let bg = "#2a2a2a";
  let color = "#aaa";
  let animation = "";

  if (_deployState === "deploying") {
    text = "Deploying...";
    bg = "#3d2e00";
    color = "#f5a623";
    animation = "statusPulse 1.5s ease-in-out infinite";
  } else if (_deployState === "error") {
    text = "Error";
    bg = "#3d1010";
    color = "#e05050";
  } else if (_hasChanges) {
    text = "Deploy needed";
    bg = "#3d2e00";
    color = "#f5a623";
  } else if (currentStatus === STATUS.ONLINE) {
    text = "Ready to generate";
    bg = "#1a3a1a";
    color = "#7ed321";
  } else if (currentStatus === STATUS.OFFLINE) {
    text = "Sleeping";
    bg = "#2a2a2a";
    color = "#888";
  } else {
    text = "Not deployed";
    bg = "#2a2a2a";
    color = "#888";
  }

  statusBannerEl.style.background = bg;
  statusBannerEl.style.color = color;
  statusBannerEl.style.animation = animation;
  statusBannerTextEl.textContent = text;
}

function setDeployBanner(state, message) {
  _deployState = state;
  if (state === "error" && statusBannerTextEl) {
    statusBannerTextEl.textContent = "Error: " + (message || "Unknown error");
  }
  updateStatusBanner();
}

async function pollDeployStatus() {
  try {
    const resp = await api.fetchApi(`${MODAL_PREFIX}/deploy/status`);
    if (!resp.ok) return;
    const data = await resp.json();
    setDeployBanner(data.state, data.message);
    if (data.state === "deploying") {
      _deployPollTimer = setTimeout(pollDeployStatus, 3000);
    } else if (data.state === "ready") {
      _hasChanges = false;
      updateStatusBanner();
    }
  } catch {}
}

function startDeployPoll() {
  if (_deployPollTimer) clearTimeout(_deployPollTimer);
  pollDeployStatus();
}

function setStatus(s) {
  currentStatus = s;
  if (dotEl) {
    const { color } = STATUS_STYLE[s] || STATUS_STYLE[STATUS.UNKNOWN];
    dotEl.style.background = color;
  }
  if (statusEl) {
    const { label } = STATUS_STYLE[s] || STATUS_STYLE[STATUS.UNKNOWN];
    statusEl.textContent = label;
  }
  updateStatusBanner();
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
        if (statusEl) statusEl.textContent = "Deploying...";
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

// --- Toast notification ---
function showToast(message, type) {
  const toast = document.createElement("div");
  toast.setAttribute("role", "alert");
  toast.setAttribute("aria-live", "polite");
  const bgMap = { success: "#1a3a1a", error: "#3d1010", info: "#1a2a3a" };
  const colorMap = { success: "#7ed321", error: "#e05050", info: "#6a9fd8" };
  toast.style.cssText = `
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: ${bgMap[type] || bgMap.info}; color: ${colorMap[type] || colorMap.info};
    padding: 8px 16px; border-radius: 6px; font-size: 12px;
    z-index: 10000; pointer-events: none; opacity: 1;
    transition: opacity 0.5s ease; border: 1px solid ${colorMap[type] || colorMap.info};
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; }, 1500);
  setTimeout(() => { toast.remove(); }, 2100);
}

// --- Utility ---
function fmtSize(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + " GB";
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + " MB";
  return (bytes / 1024).toFixed(0) + " KB";
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// --- Collapsible section helper ---
function createCollapsibleSection(title, opts) {
  const { defaultOpen, badge, id } = opts || {};
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "border-radius: 6px; background: #1e1e2e; overflow: hidden; flex-shrink: 0;";

  const header = document.createElement("div");
  header.style.cssText = `
    display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    cursor: pointer; user-select: none;
  `;

  const chevron = document.createElement("span");
  chevron.style.cssText = "font-size: 10px; color: #888; transition: transform 0.2s ease; flex-shrink: 0;";
  chevron.textContent = "\u25B6";

  const titleEl = document.createElement("span");
  titleEl.style.cssText = "font-weight: 600; font-size: 13px; flex: 1;";
  titleEl.textContent = title;

  const badgeEl = document.createElement("span");
  badgeEl.style.cssText = "font-size: 10px; background: #3a3a4a; color: #aaa; padding: 1px 6px; border-radius: 8px; flex-shrink: 0;";
  badgeEl.textContent = badge != null ? badge : "0";

  header.appendChild(chevron);
  header.appendChild(titleEl);
  header.appendChild(badgeEl);

  const content = document.createElement("div");
  content.style.cssText = "max-height: 0; overflow: hidden; transition: max-height 0.3s ease; padding: 0 10px;";

  let isOpen = !!defaultOpen;

  function toggle() {
    isOpen = !isOpen;
    if (isOpen) {
      content.style.maxHeight = content.scrollHeight + 200 + "px";
      content.style.paddingBottom = "10px";
      chevron.style.transform = "rotate(90deg)";
    } else {
      content.style.maxHeight = "0";
      content.style.paddingBottom = "0";
      chevron.style.transform = "rotate(0deg)";
    }
  }

  function open() {
    if (!isOpen) toggle();
  }

  function updateBadge(val) {
    badgeEl.textContent = String(val);
  }

  function refreshHeight() {
    if (isOpen) {
      content.style.maxHeight = content.scrollHeight + 200 + "px";
    }
  }

  if (isOpen) {
    // start open
    setTimeout(() => {
      content.style.maxHeight = content.scrollHeight + 200 + "px";
      content.style.paddingBottom = "10px";
      chevron.style.transform = "rotate(90deg)";
    }, 0);
  }

  header.onclick = toggle;

  wrapper.appendChild(header);
  wrapper.appendChild(content);

  return { wrapper, content, header, updateBadge, open, toggle, refreshHeight };
}

// --- Models loading ---
async function loadModels() {
  if (!modelListEl) return;
  modelListEl.innerHTML = `<div style="color:#888;padding:8px 0;font-size:12px;">Loading...</div>`;
  try {
    const resp = await api.fetchApi(`${MODAL_PREFIX}/models`);
    if (resp.status === 503) {
      modelListEl.innerHTML = `<div style="color:#888;font-size:12px;line-height:1.6;">Modal app not deployed yet.<br>Click <b>Deploy to Cloud</b> above to get started.</div>`;
      if (modelsCollapsibleRef) modelsCollapsibleRef.refreshHeight();
      return;
    }
    if (!resp.ok) throw new Error(resp.status);
    const data = await resp.json();
    renderModelList(data);
  } catch (e) {
    modelListEl.innerHTML = "";
    const errDiv = document.createElement("div");
    errDiv.style.cssText = "color:#e05;font-size:12px;";
    errDiv.textContent = "Error loading models";
    const details = document.createElement("details");
    details.style.cssText = "font-size:11px;color:#888;margin-top:4px;";
    const summary = document.createElement("summary");
    summary.style.cssText = "cursor:pointer;color:#aaa;";
    summary.textContent = "Show details";
    const msgP = document.createElement("p");
    msgP.style.cssText = "margin:4px 0 0;font-family:monospace;";
    msgP.textContent = e.message;
    details.appendChild(summary);
    details.appendChild(msgP);
    modelListEl.appendChild(errDiv);
    modelListEl.appendChild(details);
    if (modelsCollapsibleRef) modelsCollapsibleRef.refreshHeight();
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

      // Inject button - "Create local reference"
      const injectBtn = document.createElement("button");
      injectBtn.title = alreadyInjected
        ? "Already referenced locally"
        : "Create local reference - lets ComfyUI see this cloud model in node dropdowns";
      injectBtn.textContent = alreadyInjected ? "Referenced" : "\u2B07";
      injectBtn.style.cssText = `
        background: transparent; border: 1px solid ${alreadyInjected ? "#3a5" : "#557"}; color: ${alreadyInjected ? "#3a3" : "#99b"};
        padding: 0 6px; height: 20px; border-radius: 3px; cursor: ${alreadyInjected ? "default" : "pointer"};
        font-size: ${alreadyInjected ? "10px" : "12px"}; flex-shrink: 0; line-height: 1;
      `;
      if (!alreadyInjected) {
        injectBtn.onclick = async () => {
          injectBtn.disabled = true;
          injectBtn.textContent = "\u2026";
          try {
            const r = await api.fetchApi(`${MODAL_PREFIX}/models/inject`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ folder: file.folder ?? folder, filename: file.name }),
            });
            const result = await r.json();
            if (result.status === "ok") {
              injectBtn.textContent = "Referenced";
              injectBtn.style.color = "#3a3";
              injectBtn.style.borderColor = "#3a5";
              injectBtn.style.fontSize = "10px";
              injectBtn.title = `Referenced as ${result.name}`;
            } else {
              throw new Error(result.message);
            }
          } catch (e) {
            injectBtn.textContent = "!";
            injectBtn.style.color = "#e05";
            injectBtn.title = `Error: ${e.message}`;
            setTimeout(() => {
              injectBtn.disabled = false;
              injectBtn.textContent = "\u2B07";
              injectBtn.style.color = "#99b";
            }, 2000);
          }
        };
      }

      const delBtn = document.createElement("button");
      delBtn.textContent = "\u2715";
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
        delBtn.textContent = "\u2026";
        try {
          const r = await api.fetchApi(`${MODAL_PREFIX}/models/${file.folder ?? folder}/${encodeURIComponent(file.name)}`, { method: "DELETE" });
          const result = await r.json();
          if (result.status === "ok") {
            row.remove();
            showToast("Model deleted", "success");
          } else {
            alert(`Delete failed: ${result.message}`);
            delBtn.disabled = false;
            delBtn.textContent = "\u2715";
          }
        } catch (e) {
          alert(`Error: ${e.message}`);
          delBtn.disabled = false;
          delBtn.textContent = "\u2715";
        }
      };

      row.appendChild(injectBtn);
      row.appendChild(delBtn);
      section.appendChild(row);
    }

    modelListEl.appendChild(section);
  }

  if (!hasAny) {
    modelListEl.innerHTML = `<div style="color:#666;font-size:12px;padding:8px 0;">No models in volume.</div>`;
  }
  if (modelsCollapsibleRef) modelsCollapsibleRef.refreshHeight();
}

// --- Download queue ---
const downloadQueue = [];
let queueListEl = null;
let downloadAllBtn = null;
let batchStatusEl = null;

function renderQueueItem(entry) {
  const row = document.createElement("div");
  row.dataset.id = entry.id;
  row.style.cssText = "display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:4px; background:#2a2a2a; margin-bottom:3px;";

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
  removeBtn.textContent = "\u2715";
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
    ? `\u2B07 Download All (${queued})`
    : "\u2B07 Download Batch";
}

// --- Auth Panel ---
function buildAuthPanel(onConnected) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex; flex-direction:column; gap:12px; padding:14px 16px; height:100%; box-sizing:border-box;";

  const title = document.createElement("div");
  title.style.cssText = "font-weight:600; font-size:14px;";
  title.textContent = "\u2601 Modal GPU";
  wrap.appendChild(title);

  const desc = document.createElement("div");
  desc.style.cssText = "font-size:12px; color:#aaa; line-height:1.6;";
  desc.innerHTML = `Connect your <a href="https://modal.com" target="_blank" style="color:#6a9fd8;">Modal</a> account to run generations on cloud GPUs.`;
  wrap.appendChild(desc);

  const steps = document.createElement("ol");
  steps.style.cssText = "font-size:12px; color:#aaa; line-height:1.8; padding-left:18px; margin:0;";
  steps.innerHTML = `
    <li>Create a free account at <a href="https://modal.com" target="_blank" style="color:#6a9fd8;">modal.com</a></li>
    <li>Go to <a href="https://modal.com/settings/tokens" target="_blank" style="color:#6a9fd8;">Settings \u2192 Tokens</a></li>
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
  tokenSecretInput.placeholder = "Token Secret  (as-...)  \u2014 auto-filled if pasted above";
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

// --- Main Panel ---
function buildPanel() {
  const panel = document.createElement("div");
  panel.style.cssText = `
    font-size: 13px;
    color: var(--fg-color, #ddd);
    height: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  `;

  // Inject keyframe animation for status pulse
  if (!document.getElementById("modal-settings-styles")) {
    const styleTag = document.createElement("style");
    styleTag.id = "modal-settings-styles";
    styleTag.textContent = `
      @keyframes statusPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
      }
    `;
    document.head.appendChild(styleTag);
  }

  // === STICKY HEADER AREA ===
  const stickyTop = document.createElement("div");
  stickyTop.style.cssText = "flex-shrink: 0; padding: 14px 16px 0; display: flex; flex-direction: column; gap: 10px;";

  // -- Status Banner --
  statusBannerEl = document.createElement("div");
  statusBannerEl.style.cssText = `
    padding: 8px 12px; border-radius: 6px; background: #2a2a2a;
    font-size: 12px; font-weight: 600; text-align: center; color: #888;
  `;
  statusBannerTextEl = document.createElement("span");
  statusBannerTextEl.textContent = "Not deployed";
  statusBannerEl.appendChild(statusBannerTextEl);
  stickyTop.appendChild(statusBannerEl);

  // -- Header Row: Title + Gear --
  const headerRow = document.createElement("div");
  headerRow.style.cssText = "display:flex; align-items:center; gap:8px;";

  const title = document.createElement("span");
  title.style.cssText = "font-weight:600; font-size:14px; letter-spacing:0.03em; flex:1;";
  title.textContent = "\u2601 Modal GPU";

  const gearBtn = document.createElement("button");
  gearBtn.textContent = "\u2699";
  gearBtn.title = "Settings";
  gearBtn.style.cssText = `
    background: transparent; border: 1px solid #555; color: #aaa;
    width: 28px; height: 28px; border-radius: 4px; cursor: pointer;
    font-size: 16px; display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  `;

  headerRow.appendChild(title);
  headerRow.appendChild(gearBtn);
  stickyTop.appendChild(headerRow);

  // -- Deploy Button (prominent) --
  const redeployBtn = document.createElement("button");
  redeployBtn.textContent = "Deploy to Cloud";
  redeployBtn.title = "Deploy or re-deploy comfyapp.py to Modal";
  redeployBtn.style.cssText = btnStyle("primary");
  redeployBtn.onclick = async () => {
    redeployBtn.disabled = true;
    redeployBtn.textContent = "Deploying...";
    try {
      await api.fetchApi(`${MODAL_PREFIX}/deploy`, { method: "POST" });
      startDeployPoll();
      showToast("Deploy started", "success");
    } catch (e) {
      setDeployBanner("error", e.message);
    }
    setTimeout(() => {
      redeployBtn.disabled = false;
      redeployBtn.textContent = "Deploy to Cloud";
    }, 3000);
  };
  stickyTop.appendChild(redeployBtn);

  // -- Run Mode Toggle --
  const modeSection = document.createElement("div");
  modeSection.style.cssText = "display: flex; flex-direction: column; gap: 6px;";

  const modeLabel = document.createElement("div");
  modeLabel.style.cssText = "font-size: 12px; color: #aaa; font-weight: 600;";
  modeLabel.textContent = "Run on:";

  const modeToggle = document.createElement("div");
  modeToggle.style.cssText = "display: flex; border-radius: 6px; overflow: hidden; border: 1px solid #444;";

  const savedEnabled = localStorage.getItem(STORAGE_KEY_ENABLED);
  let isCloudMode = savedEnabled === null ? true : savedEnabled === "true";

  const cloudBtn = document.createElement("button");
  cloudBtn.textContent = "Cloud (Modal GPU)";
  cloudBtn.style.cssText = segmentBtnStyle(isCloudMode);

  const localBtn = document.createElement("button");
  localBtn.textContent = "Local (this PC)";
  localBtn.style.cssText = segmentBtnStyle(!isCloudMode);

  function updateModeToggle(cloud) {
    isCloudMode = cloud;
    cloudBtn.style.cssText = segmentBtnStyle(cloud);
    localBtn.style.cssText = segmentBtnStyle(!cloud);
    localStorage.setItem(STORAGE_KEY_ENABLED, String(cloud));
    window._comfyModalEnabled = cloud;
    updateModalSections(cloud);
  }

  cloudBtn.onclick = () => updateModeToggle(true);
  localBtn.onclick = () => updateModeToggle(false);

  modeToggle.appendChild(cloudBtn);
  modeToggle.appendChild(localBtn);

  const modeHint = document.createElement("div");
  modeHint.style.cssText = "font-size: 11px; color: #666; line-height: 1.4;";
  modeHint.textContent = "Cloud mode sends generations to Modal. Local mode runs on your machine.";

  modeSection.appendChild(modeLabel);
  modeSection.appendChild(modeToggle);
  modeSection.appendChild(modeHint);
  stickyTop.appendChild(modeSection);

  // Divider
  const topDivider = document.createElement("div");
  topDivider.style.cssText = "border-top: 1px solid #3a3a3a; margin-top: 4px;";
  stickyTop.appendChild(topDivider);

  panel.appendChild(stickyTop);

  // === SCROLLABLE CONTENT AREA ===
  const scrollContent = document.createElement("div");
  scrollContent.style.cssText = "flex: 1; overflow-y: auto; min-height: 0; padding: 10px 16px 16px; display: flex; flex-direction: column; gap: 16px;";

  // -- GPU Selector --
  const gpuSection = document.createElement("div");
  gpuSection.style.cssText = "display:flex; flex-direction:column; gap:6px;";

  const gpuRow = document.createElement("div");
  gpuRow.style.cssText = "display:flex; align-items:center; gap:8px;";

  const gpuLabel = document.createElement("span");
  gpuLabel.style.cssText = "font-size:12px; color:#aaa; font-weight:600; flex-shrink:0;";
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
  gpuSection.appendChild(gpuRow);

  const gpuHint = document.createElement("div");
  gpuHint.style.cssText = "font-size: 11px; color: #666; line-height: 1.4;";
  gpuHint.textContent = "You only pay while generating. Container shuts down when idle.";
  gpuSection.appendChild(gpuHint);

  // -- Status row --
  const statusRow = document.createElement("div");
  statusRow.style.cssText = "display:flex; align-items:center; gap:8px;";

  dotEl = document.createElement("span");
  dotEl.style.cssText = "width:9px; height:9px; border-radius:50%; background:#888; display:inline-block; flex-shrink:0;";
  statusEl = document.createElement("span");
  statusEl.style.cssText = "font-size:11px; color:#888; flex:1;";
  statusEl.textContent = "Unknown";

  const checkBtn = document.createElement("button");
  checkBtn.textContent = "Check Status";
  checkBtn.title = "Verify your Modal app is deployed and ready";
  checkBtn.style.cssText = btnStyle();
  checkBtn.onclick = () => checkHealth(false);

  const pingBtn = document.createElement("button");
  pingBtn.textContent = "Wake Up";
  pingBtn.title = "Start the GPU container (takes 1-3 min on first use)";
  pingBtn.style.cssText = btnStyle();
  pingBtn.onclick = async () => {
    pingBtn.disabled = true;
    pingBtn.textContent = "Waking...";
    await checkHealth(true);
    pingBtn.disabled = false;
    pingBtn.textContent = "Wake Up";
  };

  statusRow.appendChild(dotEl);
  statusRow.appendChild(statusEl);
  statusRow.appendChild(checkBtn);
  statusRow.appendChild(pingBtn);
  gpuSection.appendChild(statusRow);

  scrollContent.appendChild(gpuSection);

  // === CUSTOM NODES SECTION (Collapsible) ===
  const cnCollapsible = createCollapsibleSection("Custom Nodes", { defaultOpen: false, badge: "0" });
  const cnContent = cnCollapsible.content;

  const cnHelp = document.createElement("div");
  cnHelp.style.cssText = "font-size: 11px; color: #888; line-height: 1.5; margin-bottom: 8px;";
  cnHelp.textContent = "Add ComfyUI custom node repositories. These are installed in the cloud environment during deploy.";
  cnContent.appendChild(cnHelp);

  const cnListEl = document.createElement("div");
  cnListEl.style.cssText = "max-height:150px; overflow-y:auto;";
  cnContent.appendChild(cnListEl);

  const cnNotice = document.createElement("div");
  cnNotice.style.cssText = `
    font-size: 11px; color: #f5a623; background: #3d2e00; border-radius: 4px;
    padding: 6px 10px; margin-top: 6px; display: none;
    display: none; align-items: center; gap: 8px;
  `;
  const cnNoticeText = document.createElement("span");
  cnNoticeText.style.cssText = "flex: 1;";
  cnNoticeText.textContent = "Deploy required - new custom nodes will be installed on next deploy";
  const cnNoticeDeployBtn = document.createElement("button");
  cnNoticeDeployBtn.textContent = "Deploy Now";
  cnNoticeDeployBtn.style.cssText = "background:#f5a623; border:none; color:#111; padding:3px 8px; border-radius:3px; cursor:pointer; font-size:11px; font-weight:600; flex-shrink:0;";
  cnNoticeDeployBtn.onclick = () => redeployBtn.click();
  cnNotice.appendChild(cnNoticeText);
  cnNotice.appendChild(cnNoticeDeployBtn);
  cnContent.appendChild(cnNotice);

  const cnInputRow = document.createElement("div");
  cnInputRow.style.cssText = "display:flex; gap:6px; margin-top:8px;";

  const cnInput = document.createElement("input");
  cnInput.type = "text";
  cnInput.placeholder = "e.g. https://github.com/ltdrdata/ComfyUI-Manager";
  cnInput.style.cssText = inputStyle() + "flex:1;";

  const cnAddBtn = document.createElement("button");
  cnAddBtn.textContent = "Add";
  cnAddBtn.style.cssText = btnStyle();

  const cnRefreshBtn = document.createElement("button");
  cnRefreshBtn.textContent = "\u21BA";
  cnRefreshBtn.title = "Refresh custom nodes list";
  cnRefreshBtn.style.cssText = btnStyle();
  cnRefreshBtn.onclick = () => loadCustomNodes();

  cnInputRow.appendChild(cnInput);
  cnInputRow.appendChild(cnAddBtn);
  cnInputRow.appendChild(cnRefreshBtn);
  cnContent.appendChild(cnInputRow);

  let cnInstallStatus = {};
  let cnStatusLoaded = false;

  function renderCustomNodesList(nodes) {
    cnListEl.innerHTML = "";
    cnCollapsible.updateBadge(nodes ? nodes.length : 0);
    if (nodes && nodes.length > 0) {
      cnCollapsible.open();
    }
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
      } else if (cnStatusLoaded) {
        const badge = document.createElement("span");
        badge.style.cssText = "font-size:10px; flex-shrink:0; padding:1px 4px; border-radius:3px; color:#888; border:1px solid #555;";
        badge.textContent = "?";
        badge.title = "Deploy to check status";
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
            cnNotice.style.display = "flex";
            _hasChanges = true;
            updateStatusBanner();
          }
        } catch (e) {
          removeBtn.disabled = false;
          removeBtn.textContent = "\u2715";
        }
      };

      row.appendChild(removeBtn);
      cnListEl.appendChild(row);
    }
    cnCollapsible.refreshHeight();
  }

  async function loadCustomNodes() {
    cnListEl.innerHTML = '<div style="color:#888;font-size:11px;">Loading...</div>';
    try {
      const resp = await api.fetchApi(`${MODAL_PREFIX}/custom-nodes`);
      const data = await resp.json();
      renderCustomNodesList(data.nodes || []);
    } catch (e) {
      cnListEl.innerHTML = "";
      const errDiv = document.createElement("div");
      errDiv.style.cssText = "color:#e05;font-size:11px;";
      errDiv.textContent = "Error: " + e.message;
      cnListEl.appendChild(errDiv);
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
          cnStatusLoaded = true;
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
        cnNotice.style.display = "flex";
        _hasChanges = true;
        updateStatusBanner();
        showToast("Custom node added!", "success");
      } else {
        cnInput.style.borderColor = "#e05";
      }
    } catch (e) {
      cnInput.style.borderColor = "#e05";
    }
    cnAddBtn.disabled = false;
  };

  cnInput.addEventListener("keydown", (e) => { if (e.key === "Enter") cnAddBtn.click(); });

  scrollContent.appendChild(cnCollapsible.wrapper);

  // === MODELS SECTION (Collapsible, default open) ===
  const modelsCollapsible = createCollapsibleSection("Models", { defaultOpen: true, badge: "..." });
  modelsCollapsibleRef = modelsCollapsible;
  const modelsContent = modelsCollapsible.content;

  modelListEl = document.createElement("div");
  modelListEl.style.cssText = "max-height: 300px; overflow-y: auto; min-height: 0;";
  modelsContent.appendChild(modelListEl);

  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = "\u21BA Refresh";
  refreshBtn.style.cssText = btnStyle() + "margin-top:8px;";
  refreshBtn.onclick = loadModels;
  modelsContent.appendChild(refreshBtn);

  scrollContent.appendChild(modelsCollapsible.wrapper);

  // === ADD MODEL SECTION ===
  const addSection = document.createElement("div");
  addSection.style.cssText = "display:flex; flex-direction:column; gap:8px; background:#1e1e2e; border-radius:6px; padding:10px;";

  const addTitle = document.createElement("div");
  addTitle.style.cssText = "font-weight:600; font-size:13px;";
  addTitle.textContent = "Add Model";
  addSection.appendChild(addTitle);

  const addHelp = document.createElement("div");
  addHelp.style.cssText = "font-size:11px; color:#888; line-height:1.4;";
  addHelp.textContent = "Download models to the Modal cloud volume. Use batch mode to download multiple models at once.";
  addSection.appendChild(addHelp);

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

  // Auto-detect filename on URL input (debounced)
  const autoDetectFilename = debounce(() => {
    const url = urlInput.value.trim();
    if (!url || filenameInput.value.trim()) return;
    try {
      const parts = new URL(url).pathname.split("/");
      const name = parts.filter(Boolean).pop() || "";
      if (name.includes(".")) filenameInput.value = decodeURIComponent(name);
    } catch {}
  }, 600);

  urlInput.addEventListener("input", autoDetectFilename);
  urlInput.addEventListener("blur", () => {
    const url = urlInput.value.trim();
    if (!url || filenameInput.value.trim()) return;
    try {
      const parts = new URL(url).pathname.split("/");
      const name = parts.filter(Boolean).pop() || "";
      if (name.includes(".")) filenameInput.value = decodeURIComponent(name);
    } catch {}
  });

  // Buttons row: Download (single) + Add to Batch
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex; gap:6px;";

  const singleDownloadBtn = document.createElement("button");
  singleDownloadBtn.textContent = "Download";
  singleDownloadBtn.title = "Download this single model immediately";
  singleDownloadBtn.style.cssText = btnStyle("primary") + "flex:1;";
  singleDownloadBtn.onclick = async () => {
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
    if (!filename) return;

    singleDownloadBtn.disabled = true;
    singleDownloadBtn.textContent = "Downloading...";
    try {
      const resp = await api.fetchApi(`${MODAL_PREFIX}/models/batch-install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ url, filename, save_path: folder }] }),
      });
      const data = await resp.json();
      if (data.status === "ok") {
        showToast("Model downloaded!", "success");
        // Auto-inject
        await api.fetchApi(`${MODAL_PREFIX}/models/inject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder, filename }),
        }).catch(() => {});
        urlInput.value = "";
        filenameInput.value = "";
        await loadModels();
      } else {
        throw new Error(data.message || "Download failed");
      }
    } catch (e) {
      showToast("Error: " + e.message, "error");
    }
    singleDownloadBtn.disabled = false;
    singleDownloadBtn.textContent = "Download";
  };

  const addToQueueBtn = document.createElement("button");
  addToQueueBtn.textContent = "+ Add to Batch";
  addToQueueBtn.title = "Add to batch download queue";
  addToQueueBtn.style.cssText = btnStyle() + "flex:1;";
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
    showToast("Added to batch", "info");
  };

  const enterSubmit = (e) => { if (e.key === "Enter") singleDownloadBtn.click(); };
  urlInput.addEventListener("keydown", enterSubmit);
  filenameInput.addEventListener("keydown", enterSubmit);

  btnRow.appendChild(singleDownloadBtn);
  btnRow.appendChild(addToQueueBtn);
  addSection.appendChild(btnRow);

  // Queue area
  const queueHeader = document.createElement("div");
  queueHeader.style.cssText = "font-size:11px; font-weight:600; color:#aaa; text-transform:uppercase; letter-spacing:0.05em; margin-top:4px;";
  queueHeader.textContent = "Batch Queue";
  addSection.appendChild(queueHeader);

  queueListEl = document.createElement("div");
  queueListEl.style.cssText = "max-height:100px; overflow-y:auto;";
  addSection.appendChild(queueListEl);

  batchStatusEl = document.createElement("div");
  batchStatusEl.style.cssText = "font-size:11px; color:#888; min-height:14px;";
  addSection.appendChild(batchStatusEl);

  downloadAllBtn = document.createElement("button");
  downloadAllBtn.textContent = "\u2B07 Download Batch";
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
        e.statusEl.textContent = "\u23F3 downloading...";
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
            entry.statusEl.textContent = res.skipped ? "\u2713 already exists" : "\u2713 done";
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
        batchStatusEl.textContent = `Done - ${pending.length} model(s) downloaded.`;
        showToast(`${pending.length} model(s) downloaded!`, "success");
        await loadModels();
      } else {
        throw new Error(data.message || "Unknown error");
      }
    } catch (e) {
      pending.forEach(entry => {
        if (entry.state !== "done") {
          entry.state = "queued";
          if (entry.statusEl) {
            entry.statusEl.textContent = "\u2717 failed - re-queued";
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

  scrollContent.appendChild(addSection);

  // === SETTINGS SECTION (Collapsible, at bottom) ===
  const settingsCollapsible = createCollapsibleSection("Settings", { defaultOpen: false, badge: null });
  settingsCollapsible.wrapper.querySelector("span:last-of-type").style.display = "none"; // hide badge for settings

  const settingsContent = settingsCollapsible.content;

  // -- HuggingFace Token --
  const hfTitle = document.createElement("div");
  hfTitle.style.cssText = "font-weight:600; font-size:12px; margin-bottom:4px;";
  hfTitle.textContent = "\uD83E\uDD17 HuggingFace Token";
  settingsContent.appendChild(hfTitle);

  const hfDesc = document.createElement("div");
  hfDesc.style.cssText = "font-size:11px; color:#888; line-height:1.5; margin-bottom:6px;";
  hfDesc.innerHTML = `Required only for gated/private models on HuggingFace (e.g., Flux, SDXL Turbo). Get your token at <a href="https://huggingface.co/settings/tokens" target="_blank" style="color:#6a9fd8;">huggingface.co/settings/tokens</a>`;
  settingsContent.appendChild(hfDesc);

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
  settingsContent.appendChild(hfRow);

  const hfStatus = document.createElement("div");
  hfStatus.style.cssText = "font-size:11px; color:#888; min-height:14px; margin-top:4px;";
  settingsContent.appendChild(hfStatus);

  (async () => {
    try {
      const r = await api.fetchApi(`${MODAL_PREFIX}/hf-token`);
      const d = await r.json();
      if (d.token) {
        hfStatus.innerHTML = "";
        const badge = document.createElement("span");
        badge.style.cssText = "color:#7ed321; background:#1a3a1a; padding:2px 6px; border-radius:3px; font-size:10px;";
        badge.textContent = "Saved";
        const tokenSpan = document.createElement("span");
        tokenSpan.style.cssText = "color:#666; margin-left:6px;";
        tokenSpan.textContent = d.token;
        hfStatus.appendChild(badge);
        hfStatus.appendChild(tokenSpan);
      }
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
        hfStatus.innerHTML = token
          ? `<span style="color:#7ed321; background:#1a3a1a; padding:2px 6px; border-radius:3px; font-size:10px;">Saved</span>`
          : `<span style="color:#888;">Cleared</span>`;
        hfInput.value = "";
        showToast(token ? "Token saved" : "Token cleared", "success");
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

  // -- Change API Key --
  const keyDivider = document.createElement("div");
  keyDivider.style.cssText = "border-top: 1px solid #3a3a3a; margin: 10px 0;";
  settingsContent.appendChild(keyDivider);

  const reimportKeyBtn = document.createElement("button");
  reimportKeyBtn.textContent = "\uD83D\uDD11 Change API Key";
  reimportKeyBtn.title = "Re-enter Modal API key";
  reimportKeyBtn.style.cssText = btnStyle() + "width: 100%;";
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
  settingsContent.appendChild(reimportKeyBtn);

  scrollContent.appendChild(settingsCollapsible.wrapper);

  // === LOCAL MODE NOTICE ===
  const localNotice = document.createElement("div");
  localNotice.style.cssText = "font-size:12px; color:#888; line-height:1.5; padding:12px; background:#1e1e2e; border-radius:6px; display:none; text-align:center;";
  localNotice.textContent = "Local mode: prompts go directly to ComfyUI. GPU routing is off.";
  scrollContent.appendChild(localNotice);

  panel.appendChild(scrollContent);

  // === Gear button opens settings section ===
  gearBtn.onclick = () => {
    settingsCollapsible.open();
    settingsCollapsible.wrapper.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  // === Modal sections toggle ===
  const modalSectionElements = [gpuSection, cnCollapsible.wrapper, modelsCollapsible.wrapper, addSection];

  function updateModalSections(enabled) {
    for (const el of modalSectionElements) {
      el.style.display = enabled ? "" : "none";
    }
    localNotice.style.display = enabled ? "none" : "block";
    gpuSelect.disabled = !enabled;
    checkBtn.disabled = !enabled;
    redeployBtn.disabled = !enabled;
  }

  updateModalSections(isCloudMode);
  window._comfyModalEnabled = isCloudMode;

  // Sync GPU config on load
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

// --- Style helpers ---
function segmentBtnStyle(active) {
  if (active) {
    return `
      flex: 1; padding: 7px 0; border: none; cursor: pointer; font-size: 12px; font-weight: 600;
      background: #3a6fcc; color: #fff; transition: background 0.2s;
    `;
  }
  return `
    flex: 1; padding: 7px 0; border: none; cursor: pointer; font-size: 12px;
    background: #2a2a2a; color: #888; transition: background 0.2s;
  `;
}

function btnStyle(variant) {
  if (variant === "primary") {
    return `
      background: #3a6fcc; border: 1px solid #4a7fe0; color: #fff;
      padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;
      width: 100%; font-weight: 600;
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

// --- Extension Registration ---
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
