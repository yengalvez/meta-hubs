// Genuine provider observation: AvatarEditor -> AvaturnCreator -> installed
// SDK -> owned iframe Next -> native uploads/API. No export or callback seam.
import "aframe";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { injectIntl, IntlProvider } from "react-intl";
import {
  AVATURN_OBSERVATION_CEILING_MS, AVATURN_OBSERVATION_INTERVAL_MS, createAvaturnEditorObservation,
} from "./avaturn-editor-observation.mjs";
import messages from "../../hubs/src/assets/locales/es.json";
import "../../hubs/src/react-components/styles/global.scss";

const bootstrap = __RETICULUM_UI_BOOTSTRAP__;
if (!bootstrap || bootstrap.kind !== "reticulum-profile-avaturn-save" ||
    bootstrap.mode !== "avaturn-save" || bootstrap.auth_bootstrap !== "local-native-guardian" ||
    window.location.origin !== bootstrap.browser_origin ||
    bootstrap.storage_origin !== bootstrap.reticulum_origin ||
    new URL(bootstrap.reticulum_origin).hostname !== "127.0.0.1" ||
    bootstrap.app_config?.links?.avaturn_creator !== "https://virtualmente.avaturn.dev") {
  throw new Error("avaturn_save_local_bootstrap_required");
}
const initialSid = new URLSearchParams(window.location.search).get("avatar_sid");
if (initialSid !== null && !/^[A-Za-z0-9]{7}$/.test(initialSid))
  throw new Error("avaturn_save_invalid_reload_sid");

async function mount() {
  const [
    { store }, { default: AuthChannel }, { default: HubChannel },
    { default: DefaultAvatarEditor }, { connectToReticulum, getReticulumFetchUrl }, { default: configs },
  ] = await Promise.all([
    import("../../hubs/src/utils/store-instance"),
    import("../../hubs/src/utils/auth-channel"),
    import("../../hubs/src/utils/hub-channel"),
    import("../../hubs/src/react-components/avatar-editor"),
    import("../../hubs/src/utils/phoenix-utils"),
    import("../../hubs/src/utils/configs"),
  ]);
  // The installed react-intl wrapper normally does not forward a ref. Its
  // standard forwardRef option preserves IntlConsumer/the exact real class;
  // only this opt-in new-avatar page needs it. API reload/private-GLB is intact.
  const AvatarEditor = initialSid === null
    ? injectIntl(DefaultAvatarEditor.WrappedComponent, { forwardRef: true }) : DefaultAvatarEditor;
  if (window.APP) throw new Error("avaturn_save_standalone_page_required");
  // Real material preferences and credentials, shared by the real preview/API.
  window.APP = { store };
  const auth = new AuthChannel(store);
  await auth.handleAuthCredentials(bootstrap.auth_email, bootstrap.auth_token);
  if (!auth.signedIn || store.state.credentials.token !== bootstrap.auth_token)
    throw new Error("avaturn_save_native_auth_bootstrap_failed");
  if (getReticulumFetchUrl("/api/v1/avatars") !== `${bootstrap.reticulum_origin}/api/v1/avatars`)
    throw new Error("avaturn_save_native_http_origin_mismatch");

  // Real /api/v1/meta initializes the native direct upload origin.
  const socket = await connectToReticulum();
  auth.setSocket(socket);
  if (new URL(socket.endPoint).origin !== new URL(bootstrap.ws_url).origin) {
    socket.disconnect();
    throw new Error("avaturn_save_native_socket_origin_mismatch");
  }
  const hub = new HubChannel(store, bootstrap.hub_sid);
  const transport = socket.channel(`hub:${bootstrap.hub_sid}`, {
    profile: { displayName: "Avaturn save local" }, context: {},
    auth_token: store.state.credentials.token,
  });
  // Product HubChannel owns capability application and fail-closed revocation.
  // The observation listeners below count events; they never apply capabilities.
  hub.setChannel(transport);

  function AvaturnSaveCanary() {
    const [status, setStatus] = useState({ join: "PENDING", socket: socket.isConnected() ? "CONNECTED" : "CONNECTING", events: 0, creator: "WAITING" });
    const [editor, setEditor] = useState(initialSid === null ? "new" : initialSid);
    const [saved, setSaved] = useState({ sid: initialSid, callbacks: 0, failure: null });
    const [dependency, setDependency] = useState(null);
    const [observer] = useState(() => createAvaturnEditorObservation());
    const [observation, setObservation] = useState(() => observer.snapshot());
    const callbacksRef = useRef(saved.callbacks);
    callbacksRef.current = saved.callbacks;
    const intervalRef = useRef(null);
    const observingRef = useRef(false);
    const stopObservationRef = useRef(null);
    const publishObservation = useCallback(next => setObservation(previous =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next), []);
    const sampleObservation = useCallback(() => observer.sample({
      creatorEnabled: configs.feature("enable_avaturn_creator") === true,
      socketConnected: socket.isConnected(), callbackcount: callbacksRef.current,
    }), [observer]);
    const observeEditor = useCallback(instance => {
      observer.attachEditor(instance);
      if (instance === null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
        stopObservationRef.current?.("harness_teardown");
      }
      if (observingRef.current) publishObservation(sampleObservation());
    }, [observer, publishObservation, sampleObservation]);
    useEffect(() => {
      if (initialSid !== null) return;
      observingRef.current = true;
      const started = performance.now();
      let unsubscribe = null;
      const cleanup = reason => {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
        observingRef.current = false;
        unsubscribe?.();
        unsubscribe = null;
        window.removeEventListener("pagehide", pagehide);
        return observer.stop(reason);
      };
      const stop = reason => publishObservation(cleanup(reason));
      const pagehide = () => stop("harness_teardown");
      stopObservationRef.current = stop;
      const tick = () => {
        if (!observingRef.current) return;
        if (performance.now() - started >= AVATURN_OBSERVATION_CEILING_MS) return stop("deadline");
        publishObservation(sampleObservation());
      };
      // One bounded read-only poll. The real AbortSignal event is listened to
      // inside the observer; no fetch, upload or abort method is wrapped/called.
      intervalRef.current = setInterval(tick, AVATURN_OBSERVATION_INTERVAL_MS);
      unsubscribe = configs.subscribeToProductModules(tick);
      window.addEventListener("pagehide", pagehide);
      tick();
      return () => {
        stopObservationRef.current = null;
        cleanup("harness_teardown");
      };
    }, [observer, publishObservation, sampleObservation]);
    useEffect(() => {
      const update = patch => setStatus(previous => ({ ...previous, ...patch }));
      const moduleRef = transport.on("product_modules_changed", capabilities => {
        setStatus(previous => ({ ...previous, events: previous.events + 1,
          creator: capabilities.avaturn_enabled === true ? "ON" : "OFF" }));
      });
      const openRef = socket.onOpen(() => update({ socket: "CONNECTED" }));
      const closeRef = socket.onClose(() => update({ socket: "CLOSED" }));
      const errorRef = socket.onError(() => update({ socket: "ERROR" }));
      const blocked = event => {
        // CSP observations expose only directive/origin, never token-bearing
        // provider URLs, payloads, credentials or request/response content.
        let origin;
        try { origin = new URL(event.blockedURI).origin; } catch { return; }
        if (origin === "null" || origin === window.location.origin) return;
        setDependency({ directive: event.effectiveDirective, origin });
      };
      document.addEventListener("securitypolicyviolation", blocked);
      transport.join(10000)
        .receive("ok", () => update({ join: "JOINED" }))
        .receive("error", () => update({ join: "DENIED" }))
        .receive("timeout", () => update({ join: "TIMEOUT" }));
      return () => {
        transport.off("product_modules_changed", moduleRef);
        socket.off([openRef, closeRef, errorRef]);
        document.removeEventListener("securitypolicyviolation", blocked);
        socket.disconnect();
      };
    }, []);
    const onSave = avatar => {
      const valid = avatar && /^[A-Za-z0-9]{7}$/.test(avatar.avatar_id) &&
        typeof avatar.account_id === "string" && avatar.account_id === bootstrap.account_id &&
        avatar.allow_promotion === false && avatar.allow_remixing === false && avatar.has_listings === false;
      // Count every actual callback, including a late/invalid one. OFF or socket
      // close does NOT unmount the editor or suppress callbacks in this harness:
      // the real product must revoke its own operation before onSave.
      setSaved(previous => ({ sid: valid ? avatar.avatar_id : previous.sid,
        callbacks: previous.callbacks + 1,
        failure: valid ? previous.failure : "API owner/private response mismatch" }));
      setEditor(null);
    };
    return React.createElement("main", { className: "profile-canary" },
      React.createElement("section", { className: "profile-avaturn-controls", "aria-label": "Observación Avaturn real" },
        React.createElement("h1", null, "AvatarEditor: guardado Avaturn real"),
        React.createElement("p", null, "Guardian local y Store/AuthChannel reales. SDK 1.1.4 y proyecto virtualmente.avaturn.dev. Usa sólo Next del iframe; sin GLB local, exportación inyectada ni aceptación automática."),
        React.createElement("p", null, "El login/export de Avaturn requiere la cuenta y autoridad existentes. No crear cuenta ni aceptar términos automáticamente. Cualquier origen externo de descarga queda bloqueado y pendiente de decisión."),
        React.createElement("p", null, React.createElement("output", { id: "avaturn-save-connection", "aria-live": "polite" },
          `Join: ${status.join}; socket: ${status.socket}; creador: ${status.creator}; eventos: ${status.events}.`)),
        React.createElement("output", { id: "avaturn-save-saves", "data-saved-avatar-sid": saved.sid || "", "aria-live": "polite" },
          `Callbacks onSave reales: ${saved.callbacks}; vista: ${initialSid ? "recarga API" : editor ? "proveedor" : "desmontado"}; ${saved.failure || "sin aceptación inferida"}.`),
        initialSid === null && React.createElement("output", {
          id: "avaturn-save-editor-observation", "aria-live": "polite",
          "data-observation-state": observation.observation_state,
          "data-upload-started": String(observation.upload_started),
          "data-abort-event-seen": String(observation.abort_event_seen),
          "data-aborted-signal": String(observation.aborted_signal),
          "data-upload-drained": String(observation.upload_drained),
          "data-same-editor-instance": String(observation.same_editor_instance),
          "data-controller-seen-count": observation.controller_seen_count,
          "data-editor-mount-count": observation.editor_mount_count,
          "data-is-current-guards": String(observation.is_current_guards),
          "data-off-observed": String(observation.off_observed),
          "data-saved-state-seen": String(observation.saved_state_seen),
          "data-callbackcount": saved.callbacks,
          "data-invalid-reasons": observation.invalid_reasons.join(","),
        }, `Observación pasiva: ${observation.observation_state}; aborted_signal: ${observation.aborted_signal}; ` +
          `abort_event_seen: ${observation.abort_event_seen}; upload_drained: ${observation.upload_drained}; ` +
          `same_editor_instance: ${observation.same_editor_instance}; controller_seen_count: ${observation.controller_seen_count}; ` +
          `saved_state_seen: ${observation.saved_state_seen}; ` +
          `callbackcount: ${saved.callbacks}. No acredita terminal de red ni aceptación runtime.`),
        dependency && React.createElement("p", { id: "avaturn-save-dependency", role: "status" },
          `Dependencia bloqueada por CSP: ${dependency.directive}; origen: ${dependency.origin}. No se amplía el permiso automáticamente.`),
        saved.sid && React.createElement("a", { id: "avaturn-save-reload", href: `/?avatar_sid=${encodeURIComponent(saved.sid)}` }, "Recargar guardado desde API (página nueva)"),
        React.createElement("button", { id: "avaturn-save-disconnect", type: "button", onClick: () => socket.disconnect() }, "Cerrar socket real")),
      editor && status.join === "JOINED" && React.createElement("section", { className: "profile-avaturn-editor", "aria-label": "AvatarEditor Avaturn real" },
        React.createElement(AvatarEditor, { key: editor, mode: editor === "new" ? "avaturn" : "private-glb", ...(editor === "new" ? {} : { avatarId: editor }), ...(editor === "new" ? { ref: observeEditor } : {}), hideDelete: true, onSave })));
  }
  createRoot(document.getElementById("root")).render(
    React.createElement(IntlProvider, { locale: "es", messages }, React.createElement(AvaturnSaveCanary)));
}

mount().catch(() => {
  document.getElementById("root").textContent = "No se pudo montar Avaturn real. Consulta los controles nativos privados; observación no iniciada.";
});
