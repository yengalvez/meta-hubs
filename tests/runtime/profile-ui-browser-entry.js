// One real RoomSettings consumer; event delivery and room data are local seams.
// No socket connect/join, application bootstrap, SDK, avatar rendering or writes.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { Socket } from "phoenix";
import HubChannel from "../../hubs/src/utils/hub-channel";
import { RoomSettingsSidebar } from "../../hubs/src/react-components/room/RoomSettingsSidebar";
import messages from "../../hubs/src/assets/locales/es.json";
import "../../hubs/src/react-components/styles/global.scss";

const store = { state: { credentials: {} }, addEventListener() {} };
const hub = new HubChannel(store, "profile-ui-canary");
const transport = new Socket("/socket").channel("hub:profile-ui-canary", {});
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
        "Canary local: canal sin conexión y datos de sala sintéticos. No prueba SQL, servidor, Avaturn ni escena.",
      ),
      React.createElement(
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
