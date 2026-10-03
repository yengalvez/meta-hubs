// One real RoomSettings consumer. The optional private bootstrap joins only
// the runner's local synthetic room; neither mode loads a scene or provider.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { Socket } from "phoenix";
import HubChannel from "../../hubs/src/utils/hub-channel";
import { RoomSettingsSidebar } from "../../hubs/src/react-components/room/RoomSettingsSidebar";
import messages from "../../hubs/src/assets/locales/es.json";
import "../../hubs/src/react-components/styles/global.scss";

const bootstrap =
  typeof __RETICULUM_UI_BOOTSTRAP__ === "undefined"
    ? null
    : __RETICULUM_UI_BOOTSTRAP__;
if (bootstrap && window.location.origin !== bootstrap.browser_origin)
  throw new Error("local_bootstrap_origin_mismatch");
const store = {
  state: { credentials: bootstrap ? { token: bootstrap.auth_token } : {} },
  addEventListener() {},
};
const hubSid = bootstrap ? bootstrap.hub_sid : "profile-ui-canary";
const hub = new HubChannel(store, hubSid);
const socket = new Socket(bootstrap ? bootstrap.ws_url : "/socket");
const transport = socket.channel(
  `hub:${hubSid}`,
  bootstrap
    ? {
        profile: { displayName: "Canary local" },
        context: {},
        auth_token: bootstrap.auth_token,
      }
    : {},
);
// Bind the production consumer before connect/join and the initial push.
hub.setChannel(transport);

const room = {
  name: "Canary local",
  description: "",
  room_size: 24,
  entry_mode: "allow",
  member_permissions: { spawn_and_move_media: true },
  user_data: {
    bots: {
      enabled: true,
      count: 1,
      chat_enabled: true,
      mobility: "static",
      prompt: "Instrucciones locales",
    },
  },
};
const noAction = () => {};

function ProfileCanary() {
  const [delivered, setDelivered] = useState({ profile: "BASE", events: 0 });
  const [connection, setConnection] = useState({
    join: "PENDING",
    invalidToken: "PENDING",
    missingToken: "PENDING",
    socket: "NOT_CONNECTED",
  });
  useEffect(() => {
    if (!bootstrap) return undefined;
    const update = (patch) =>
      setConnection((previous) => ({ ...previous, ...patch }));
    const ref = transport.on("product_modules_changed", (capabilities) => {
      setDelivered((previous) => ({
        profile:
          capabilities.bots_enabled === true
            ? capabilities.ai_enabled === true
              ? "BOTS + IA"
              : "BOTS"
            : "BASE",
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

    // A distinct real socket tests required-account denial. It is deliberately
    // never attached to HubChannel/configs, so it cannot revoke the valid join.
    const deniedSocket = new Socket(bootstrap.ws_url);
    const deniedChannel = deniedSocket.channel(`hub:${hubSid}`, {
      profile: { displayName: "Invalid local token" },
      context: {},
      auth_token: "invalid-local-ui-token",
    });
    const finishDenied = (status) => {
      update({ invalidToken: status });
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
    const missingChannel = missingSocket.channel(`hub:${hubSid}`, {
      profile: { displayName: "Missing local token" },
      context: {},
    });
    const finishMissing = (status) => {
      update({ missingToken: status });
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
      transport.off("product_modules_changed", ref);
      socket.off([openRef, closeRef, errorRef]);
      deniedSocket.disconnect();
      missingSocket.disconnect();
      socket.disconnect();
    };
  }, []);
  function deliver(bots, ai) {
    transport.trigger("product_modules_changed", {
      bots_enabled: bots,
      ai_enabled: ai,
      avaturn_enabled: false,
    });
    setDelivered((previous) => ({
      profile: bots ? "BOTS + IA" : "BASE",
      events: previous.events + 1,
    }));
  }

  return React.createElement(
    "main",
    { className: "profile-canary" },
    React.createElement(
      "section",
      {
        className: "profile-canary-controls",
        "aria-label": "Capacidades locales del canary",
      },
      React.createElement("h1", null, "RoomSettings: capacidades vivas"),
      React.createElement(
        "p",
        null,
        bootstrap
          ? "Canary conectado: SQL/PubSub/Phoenix locales y RoomSettings real. Cuenta y sala sintéticas; no prueba Avaturn, escena ni producción."
          : "Canary local: canal sin conexión y datos de sala sintéticos. No prueba SQL, servidor, Avaturn ni escena.",
      ),
      bootstrap
        ? React.createElement(
            "div",
            { className: "profile-canary-buttons" },
            React.createElement(
              "button",
              {
                type: "button",
                id: "profile-disconnect",
                onClick: () => socket.disconnect(),
              },
              "Cerrar socket real",
            ),
            React.createElement(
              "output",
              { id: "profile-connection", "aria-live": "polite" },
              `Join válido: ${connection.join}; token inválido: ${connection.invalidToken}; token ausente: ${connection.missingToken}; socket: ${connection.socket}. Transiciones solo por SQL del runner.`,
            ),
          )
        : React.createElement(
            "div",
            { className: "profile-canary-buttons" },
            React.createElement(
              "button",
              {
                type: "button",
                id: "profile-base",
                onClick: () => deliver(false, false),
              },
              "1. BASE",
            ),
            React.createElement(
              "button",
              {
                type: "button",
                id: "profile-bots-ai",
                onClick: () => deliver(true, true),
              },
              "2. BOTS + IA",
            ),
            React.createElement(
              "button",
              {
                type: "button",
                id: "profile-base-again",
                onClick: () => deliver(false, false),
              },
              "3. Volver a BASE",
            ),
          ),
      React.createElement(
        "output",
        { id: "profile-delivered", "aria-live": "polite" },
        `Perfil entregado: ${delivered.profile}; eventos: ${delivered.events}. No es un resultado de aceptación.`,
      ),
    ),
    React.createElement(
      "section",
      {
        id: "room-settings-consumer",
        className: "profile-canary-consumer",
        "aria-label": "RoomSettings real",
      },
      React.createElement(RoomSettingsSidebar, {
        room,
        maxRoomSize: 42,
        canChangeScene: false,
        showPublicRoomSetting: false,
        onSubmit: noAction,
        onClose: noAction,
      }),
    ),
  );
}

// The consumer remains the same React instance across all three event buttons.
createRoot(document.getElementById("root")).render(
  React.createElement(
    IntlProvider,
    { locale: "es", messages },
    React.createElement(ProfileCanary),
  ),
);
