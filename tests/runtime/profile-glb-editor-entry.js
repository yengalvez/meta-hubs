// Separate normal-GLB observation. Real editor/form/preview/HTTP/SQL/storage;
// native Guardian credentials are a local auth bootstrap, NOT a login test.
import "aframe";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import messages from "../../hubs/src/assets/locales/es.json";
import "../../hubs/src/react-components/styles/global.scss";

const bootstrap = __RETICULUM_UI_BOOTSTRAP__;
if (!bootstrap || bootstrap.kind !== "reticulum-profile-normal-glb" ||
    bootstrap.mode !== "normal-glb" || bootstrap.auth_bootstrap !== "local-native-guardian" ||
    window.location.origin !== bootstrap.browser_origin ||
    bootstrap.storage_origin !== bootstrap.reticulum_origin ||
    new URL(bootstrap.reticulum_origin).hostname !== "127.0.0.1") {
  throw new Error("normal_glb_local_bootstrap_required");
}
const initialSid = new URLSearchParams(window.location.search).get("avatar_sid");
if (initialSid !== null && !/^[A-Za-z0-9]{7}$/.test(initialSid))
  throw new Error("normal_glb_invalid_reload_sid");

async function mount() {
  // Normal page config is loaded before imports. Do not override configs,
  // capability setters, product callbacks, loaders or editor/preview state.
  const [
    { store }, { default: AuthChannel }, { default: HubChannel },
    { default: AvatarEditor }, { connectToReticulum, getReticulumFetchUrl },
  ] = await Promise.all([
    import("../../hubs/src/utils/store-instance"),
    import("../../hubs/src/utils/auth-channel"),
    import("../../hubs/src/utils/hub-channel"),
    import("../../hubs/src/react-components/avatar-editor"),
    import("../../hubs/src/utils/phoenix-utils"),
  ]);
  if (window.APP) throw new Error("normal_glb_standalone_page_required");
  // AvatarPreview's native material preference reader uses this very singleton.
  // No Store substitute or injected preferences; default preferences stay real.
  window.APP = { store };
  const auth = new AuthChannel(store);
  await auth.handleAuthCredentials(bootstrap.auth_email, bootstrap.auth_token);
  if (!auth.signedIn || store.state.credentials.token !== bootstrap.auth_token)
    throw new Error("normal_glb_native_auth_bootstrap_failed");
  const avatarApi = getReticulumFetchUrl("/api/v1/avatars");
  if (avatarApi !== `${bootstrap.reticulum_origin}/api/v1/avatars`)
    throw new Error("normal_glb_native_http_origin_mismatch");

  // Actual HTTP auth-required pipeline, before a real file can be saved.
  // Neither request has a promotion tuple or can create an authenticated avatar.
  for (const token of [null, "invalid-local-normal-glb-token"]) {
    const response = await fetch(avatarApi, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", ...(token ? { authorization: `bearer ${token}` } : {}) },
      body: JSON.stringify({ avatar: {} }),
    });
    if (response.status !== 401) throw new Error("normal_glb_http_auth_denial_required");
    await response.arrayBuffer();
  }

  // Initializes the real direct upload URL through native local /api/v1/meta;
  // no private setter or alternate fake HTTP backend is used.
  const socket = await connectToReticulum();
  auth.setSocket(socket);
  if (new URL(socket.endPoint).origin !== new URL(bootstrap.ws_url).origin) {
    socket.disconnect();
    throw new Error("normal_glb_native_socket_origin_mismatch");
  }
  const hub = new HubChannel(store, bootstrap.hub_sid);
  const transport = socket.channel(`hub:${bootstrap.hub_sid}`, {
    profile: { displayName: "Normal GLB local" }, context: {},
    auth_token: store.state.credentials.token,
  });
  hub.setChannel(transport);

  function NormalGlbCanary() {
    const [status, setStatus] = useState({ join: "PENDING", socket: socket.isConnected() ? "CONNECTED" : "CONNECTING", events: 0, creator: "WAITING" });
    const [editor, setEditor] = useState(initialSid === null ? "new" : initialSid);
    const [saved, setSaved] = useState({ sid: initialSid, callbacks: 0, failure: null });
    useEffect(() => {
      const update = patch => setStatus(previous => ({ ...previous, ...patch }));
      const moduleRef = transport.on("product_modules_changed", capabilities => {
        setStatus(previous => ({ ...previous, events: previous.events + 1,
          creator: capabilities.avaturn_enabled === true ? "ON" : "OFF" }));
      });
      const openRef = socket.onOpen(() => update({ socket: "CONNECTED" }));
      const closeRef = socket.onClose(() => update({ socket: "CLOSED" }));
      const errorRef = socket.onError(() => update({ socket: "ERROR" }));
      transport.join(10000)
        .receive("ok", () => update({ join: "JOINED" }))
        .receive("error", () => update({ join: "DENIED" }))
        .receive("timeout", () => update({ join: "TIMEOUT" }));
      return () => {
        transport.off("product_modules_changed", moduleRef);
        socket.off([openRef, closeRef, errorRef]);
        socket.disconnect();
      };
    }, []);
    const onSave = avatar => {
      const valid = avatar && /^[A-Za-z0-9]{7}$/.test(avatar.avatar_id) &&
        typeof avatar.account_id === "string" && avatar.account_id === bootstrap.account_id &&
        avatar.allow_promotion === false && avatar.allow_remixing === false &&
        avatar.has_listings === false;
      // Record the real API callback, never manufacture a save or PASS. Closing
      // mirrors the owning UI and disposes the real preview before cold reload.
      setSaved(previous => ({ sid: valid ? avatar.avatar_id : previous.sid,
        callbacks: previous.callbacks + 1,
        failure: valid ? previous.failure : "API owner/private response mismatch" }));
      setEditor(null);
    };
    return React.createElement("main", { className: "profile-canary" },
      React.createElement("section", { className: "profile-glb-controls", "aria-label": "Observación normal GLB local" },
        React.createElement("h1", null, "AvatarEditor: GLB privado real"),
        React.createElement("p", null, "Cuenta SQL y Guardian locales; Store/AuthChannel reales. Login externo/OAuth no probado. Sin proveedor, escena ni aceptación automática."),
        React.createElement("output", { id: "normal-glb-http-auth" }, "HTTP real: anónimo DENIED 401; token inválido DENIED 401."),
        React.createElement("p", null, React.createElement("output", { id: "normal-glb-connection", "aria-live": "polite" },
          `Join: ${status.join}; socket: ${status.socket}; creador: ${status.creator}; eventos: ${status.events}.`)),
        React.createElement("output", { id: "normal-glb-saves", "data-saved-avatar-sid": saved.sid || "", "aria-live": "polite" },
          `Callbacks onSave reales: ${saved.callbacks}; vista: ${initialSid ? "recarga API" : editor ? "selección" : "desmontado"}; ${saved.failure || "sin aceptación inferida"}.`),
        saved.sid && React.createElement("a", { id: "normal-glb-reload", href: `/?avatar_sid=${encodeURIComponent(saved.sid)}` }, "Recargar guardado desde API (página nueva)"),
        React.createElement("button", { id: "normal-glb-disconnect", type: "button", onClick: () => socket.disconnect() }, "Cerrar socket real")),
      editor && status.join === "JOINED" && React.createElement("section", { className: "profile-glb-editor", "aria-label": "AvatarEditor real" },
        React.createElement(AvatarEditor, { key: editor, mode: "private-glb", ...(editor === "new" ? {} : { avatarId: editor }), hideDelete: true, onSave })));
  }
  createRoot(document.getElementById("root")).render(
    React.createElement(IntlProvider, { locale: "es", messages }, React.createElement(NormalGlbCanary)));
}

mount().catch(() => {
  // Never echo a request URL, credential or server response into task output.
  document.getElementById("root").textContent = "No se pudo montar normal GLB real. Consulta los controles nativos privados; observación no iniciada.";
});
