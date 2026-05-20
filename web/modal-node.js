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
        log("Intercepted /prompt POST -> routing to Modal GPU");
        return _originalFetchApi(`${MODAL_PREFIX}/prompt`, options);
      }

      if (
        options.method === "POST" &&
        (route === "/model/install" || route === "model/install")
      ) {
        log("Intercepted model/install -> routing to Modal Volume download");
        return _originalFetchApi(`${MODAL_PREFIX}/model/install`, options);
      }

      return _originalFetchApi(route, options);
    };

    log("fetchApi patched. All /prompt POST requests -> Modal GPU.");
  },
});
