// Creator-only local admission observation. No scene, SDK, editor or writes.
import "aframe";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider, useIntl } from "react-intl";
import { Socket } from "phoenix";
import messages from "../../hubs/src/assets/locales/es.json";
import "../../hubs/src/react-components/styles/global.scss";

const bootstrap = __RETICULUM_UI_BOOTSTRAP__;
if (
  !bootstrap ||
  bootstrap.kind !== "reticulum-profile-creator-socket" ||
  bootstrap.mode !== "creator-only" ||
  window.location.origin !== bootstrap.browser_origin ||
  window.APP_CONFIG?.links?.avaturn_creator !==
    "https://virtualmente.avaturn.dev"
) {
  throw new Error("creator_local_bootstrap_required");
}

async function mount() {
  // public-app-config.js has already initialized window.APP_CONFIG. Delay all
  // product imports until that normal page initialization and A-Frame finish.
  const [
    { default: HubChannel },
    { default: MediaBrowserContainer },
    { default: MediaSearchStore },
  ] = await Promise.all([
    import("../../hubs/src/utils/hub-channel"),
    import("../../hubs/src/react-components/media-browser"),
    import("../../hubs/src/storage/media-search-store"),
  ]);
  // react-intl exposes the real class as WrappedComponent. useIntl supplies
  // the same intl prop, while its ref exposes the real bound admission callback.
  const MediaBrowserConsumer = MediaBrowserContainer.WrappedComponent;
  if (!MediaBrowserConsumer)
    throw new Error("real_media_browser_class_missing");
  const store = {
    state: { credentials: { token: bootstrap.auth_token } },
    addEventListener() {},
  };
  const hub = new HubChannel(store, bootstrap.hub_sid);
  const socket = new Socket(bootstrap.ws_url);
  const transport = socket.channel(`hub:${bootstrap.hub_sid}`, {
    profile: { displayName: "Creator-only local" },
    context: {},
    auth_token: bootstrap.auth_token,
  });
  hub.setChannel(transport);

  const history = {
    location: {
      pathname: `/${bootstrap.hub_sid}/media/avatars`,
      search: "?media_source=avatars",
      hash: "",
      state: {},
    },
    push(location) {
      history.location = location;
    },
    replace(location) {
      history.location = location;
    },
  };
  const mediaSearchStore = new MediaSearchStore();
  // Deliberately do NOT setHistory: that method starts a real search. Real
  // filterQueryNavigate can update this synthetic history without subscribing
  // it to _update/fetch. The actual search input retains its own component state.
  mediaSearchStore.history = history;
  const noAction = () => {};
  const scene = {}; // Unused by the empty action-only avatar route; no a-scene.

  function CreatorCanary() {
    const intl = useIntl();
    const capturedAdmission = useRef(null);
    const [captured, setCaptured] = useState(false);
    const [counts, setCounts] = useState({ avaturn: 0, glb: 0, diagnostic: 0 });
    const [status, setStatus] = useState({
      join: "PENDING",
      invalidToken: "PENDING",
      missingToken: "PENDING",
      socket: "NOT_CONNECTED",
      creator: "WAITING",
      events: 0,
    });
    useEffect(() => {
      const update = (patch) =>
        setStatus((previous) => ({ ...previous, ...patch }));
      const countAvaturn = () =>
        setCounts((previous) => ({
          ...previous,
          avaturn: previous.avaturn + 1,
        }));
      const countGlb = () =>
        setCounts((previous) => ({ ...previous, glb: previous.glb + 1 }));
      window.addEventListener("action_create_avaturn_avatar", countAvaturn);
      window.addEventListener("action_create_private_glb_avatar", countGlb);
      const ref = transport.on("product_modules_changed", (capabilities) => {
        setStatus((previous) => ({
          ...previous,
          creator: capabilities.avaturn_enabled === true ? "ON" : "OFF",
          events: previous.events + 1,
        }));
      });
      const openRef = socket.onOpen(() => update({ socket: "CONNECTED" }));
      const closeRef = socket.onClose(() => update({ socket: "CLOSED" }));
      const errorRef = socket.onError(() => update({ socket: "ERROR" }));
      socket.connect();
      transport
        .join(10000)
        .receive("ok", () => update({ join: "JOINED" }))
        .receive("error", () => update({ join: "DENIED" }))
        .receive("timeout", () => update({ join: "TIMEOUT" }));

      // Keep both account-required negatives separate from the valid HubChannel.
      const deniedSocket = new Socket(bootstrap.ws_url);
      const deniedChannel = deniedSocket.channel(`hub:${bootstrap.hub_sid}`, {
        profile: { displayName: "Invalid local token" },
        context: {},
        auth_token: "invalid-local-ui-token",
      });
      const finishDenied = (value) => {
        update({ invalidToken: value });
        deniedSocket.disconnect();
      };
      deniedSocket.connect();
      deniedChannel
        .join(10000)
        .receive("ok", () => finishDenied("UNEXPECTED_JOIN"))
        .receive("error", (response) =>
          finishDenied(
            response.reason === "join_denied" ? "DENIED" : "OTHER_ERROR",
          ),
        )
        .receive("timeout", () => finishDenied("TIMEOUT"));
      const missingSocket = new Socket(bootstrap.ws_url);
      const missingChannel = missingSocket.channel(`hub:${bootstrap.hub_sid}`, {
        profile: { displayName: "Missing local token" },
        context: {},
      });
      const finishMissing = (value) => {
        update({ missingToken: value });
        missingSocket.disconnect();
      };
      missingSocket.connect();
      missingChannel
        .join(10000)
        .receive("ok", () => finishMissing("UNEXPECTED_JOIN"))
        .receive("error", (response) =>
          finishMissing(
            response.reason === "join_denied" ? "DENIED" : "OTHER_ERROR",
          ),
        )
        .receive("timeout", () => finishMissing("TIMEOUT"));
      return () => {
        window.removeEventListener(
          "action_create_avaturn_avatar",
          countAvaturn,
        );
        window.removeEventListener(
          "action_create_private_glb_avatar",
          countGlb,
        );
        transport.off("product_modules_changed", ref);
        socket.off([openRef, closeRef, errorRef]);
        deniedSocket.disconnect();
        missingSocket.disconnect();
        socket.disconnect();
      };
    }, []);
    const capture = (instance) => {
      if (instance && !capturedAdmission.current) {
        capturedAdmission.current = instance.onCreateAvaturnAvatar;
        setCaptured(true);
      }
    };
    const invokeCapturedAdmission = () => {
      capturedAdmission.current();
      setCounts((previous) => ({
        ...previous,
        diagnostic: previous.diagnostic + 1,
      }));
    };
    return React.createElement(
      "main",
      null,
      React.createElement(
        "section",
        {
          className: "profile-media-controls",
          "aria-label": "Diagnóstico local de admisión",
        },
        React.createElement("h1", null, "MediaBrowser: admisión creator-only"),
        React.createElement(
          "p",
          null,
          "SQL/Phoenix locales. Solo cuenta acciones: no abre editor, SDK, registro ni importación. La búsqueda conserva estado, sin consultar catálogo.",
        ),
        React.createElement(
          "button",
          {
            type: "button",
            id: "creator-stale-admission",
            disabled: !captured,
            onClick: invokeCapturedAdmission,
          },
          "Invocar callback real capturado (diagnóstico)",
        ),
        React.createElement(
          "button",
          {
            type: "button",
            id: "creator-disconnect",
            onClick: () => socket.disconnect(),
          },
          "Cerrar socket real",
        ),
        React.createElement(
          "output",
          { id: "creator-connection", "aria-live": "polite" },
          `Join: ${status.join}; token inválido: ${status.invalidToken}; token ausente: ${status.missingToken}; socket: ${status.socket}; último evento creador: ${status.creator}; eventos: ${status.events}.`,
        ),
        React.createElement(
          "p",
          null,
          React.createElement(
            "output",
            { id: "creator-admissions", "aria-live": "polite" },
            `Admisiones Avaturn: ${counts.avaturn}; GLB: ${counts.glb}; intentos diagnósticos: ${counts.diagnostic}. No es aceptación del editor.`,
          ),
        ),
      ),
      React.createElement(
        "form",
        {
          id: "media-browser-consumer",
          onSubmit: (event) => event.preventDefault(),
          "aria-label": "MediaBrowser real",
        },
        React.createElement(MediaBrowserConsumer, {
          ref: capture,
          intl,
          mediaSearchStore,
          history,
          hubChannel: hub,
          showNonHistoriedDialog: noAction,
          performConditionalSignIn: noAction,
          scene,
          store,
        }),
      ),
    );
  }

  createRoot(document.getElementById("root")).render(
    React.createElement(
      IntlProvider,
      { locale: "es", messages },
      React.createElement(CreatorCanary),
    ),
  );
}

mount().catch(() => {
  document.getElementById("root").textContent =
    "No se pudo montar el consumidor real. Observación no iniciada.";
});
