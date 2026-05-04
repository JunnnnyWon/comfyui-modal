import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MODAL_PREFIX = "/comfymodal";
const POLL_INTERVAL_MS = 30000;

let _statusDot = null;
let _statusText = null;
let _pollTimer = null;

const STATUS_COLORS = { online: "#7ed321", offline: "#888", checking: "#f5a623", unknown: "#555" };

async function updateStatusDot() {
  if (!_statusDot) return;
  _statusDot.style.background = STATUS_COLORS.checking;
  if (_statusText) _statusText.textContent = "Checking...";
  try {
    const resp = await api.fetchApi(`${MODAL_PREFIX}/health?mode=deploy`);
    const data = await resp.json();
    const online = data.status === "online";
    _statusDot.style.background = online ? STATUS_COLORS.online : STATUS_COLORS.offline;
    if (_statusText) _statusText.textContent = online ? "Online" : "Offline";
  } catch {
    _statusDot.style.background = STATUS_COLORS.unknown;
    if (_statusText) _statusText.textContent = "Unknown";
  }
}

function startPolling() {
  updateStatusDot();
  _pollTimer = setInterval(updateStatusDot, POLL_INTERVAL_MS);
}

app.registerExtension({
  name: "comfyui.modal.settings",
  async setup() {
    app.extensionManager.registerSidebarTab({
      id: "modal-gpu",
      icon: "pi pi-cloud",
      title: "Modal GPU",
      tooltip: "Modal GPU Dashboard",
      type: "custom",
      render: async (el) => {
        el.innerHTML = "";
        el.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;padding:24px;box-sizing:border-box;";
        const title = document.createElement("div");
        title.textContent = "Modal GPU";
        title.style.cssText = "font-size:15px;font-weight:600;color:#e0e0e0;";
        el.appendChild(title);
        const statusRow = document.createElement("div");
        statusRow.style.cssText = "display:flex;align-items:center;gap:8px;";
        _statusDot = document.createElement("span");
        _statusDot.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:50%;background:${STATUS_COLORS.unknown};flex-shrink:0;`;
        statusRow.appendChild(_statusDot);
        _statusText = document.createElement("span");
        _statusText.textContent = "Not checked";
        _statusText.style.cssText = "font-size:12px;color:#888;";
        statusRow.appendChild(_statusText);
        el.appendChild(statusRow);
        const btn = document.createElement("button");
        btn.textContent = "Open Modal Dashboard ↗";
        btn.style.cssText = "padding:10px 18px;background:#4a90e2;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;width:100%;max-width:200px;";
        btn.onmouseover = () => btn.style.background = "#3a80d2";
        btn.onmouseout = () => btn.style.background = "#4a90e2";
        btn.onclick = () => window.open("/modal-gpu", "_blank", "noopener");
        el.appendChild(btn);
        const hint = document.createElement("div");
        hint.textContent = "All model management in the dashboard →";
        hint.style.cssText = "font-size:11px;color:#555;text-align:center;";
        el.appendChild(hint);
        startPolling();
      },
    });
  },
});
