import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const MODAL_PREFIX = "/comfymodal";

let _originalFetchApi = null;

function log(...args) {
  console.log("[comfyui-modal]", ...args);
}

app.registerExtension({
  name: "comfyui.modal",

  async setup() {
    log("Extension loaded. Patching fetchApi...");

    function stripModalPrefix(obj) {
      if (typeof obj === "string") {
        return obj.startsWith("modal-") ? obj.slice(6) : obj;
      }
      if (Array.isArray(obj)) return obj.map(stripModalPrefix);
      if (obj && typeof obj === "object") {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = stripModalPrefix(v);
        return out;
      }
      return obj;
    }

    _originalFetchApi = api.fetchApi.bind(api);
    api.fetchApi = async function (route, options = {}) {
      const isPromptPost =
        options.method === "POST" &&
        (route === "/prompt" || route === "prompt");

      if (isPromptPost) {
        const enabled = window._comfyModalEnabled !== false;
        if (!enabled) {
          return _originalFetchApi(route, options);
        }
        log("Intercepted /prompt POST → routing to Modal GPU");
        const body = JSON.parse(options.body);
        body.prompt = stripModalPrefix(body.prompt);
        return _originalFetchApi(`${MODAL_PREFIX}/prompt`, {
          ...options,
          body: JSON.stringify(body),
        });
      }

      if (
        options.method === "POST" &&
        (route === "/model/install" || route === "model/install")
      ) {
        log("Intercepted model/install → routing to Modal Volume download");
        return _originalFetchApi(`${MODAL_PREFIX}/model/install`, options);
      }

      return _originalFetchApi(route, options);
    };

    log("fetchApi patched. All /prompt POST requests → Modal GPU.");
  },
});
