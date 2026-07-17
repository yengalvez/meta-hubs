# Inventario de personalizaciones YenHubs

Este documento es la checklist de preservacion para upgrades. Los detalles de
uso estan en `features/`; la evidencia de pruebas esta en
`docs/audit-2026-07.md`.

## Magnitud

Comparado con las releases estables aceptadas:

- Hubs: 147 archivos, 10.913 inserciones y 2.472 eliminaciones.
- Hubs CE: 118 archivos, 13.663 inserciones y 12.700 eliminaciones.

El candidato integrado local del 17 de julio queda identificado por Hubs
`d7f0c2fc4` y Hubs Cloud `b7b752f`. Spoke pasó 68/68 pruebas, lint y build con
Node 16.13.2/Yarn 1. Es un GO de integración local, no de Actions, staging,
capacidad ni producción.

## Cliente Hubs

| Area | Contrato propio | Archivos de mayor riesgo |
| --- | --- | --- |
| Tercera persona | preferencia persistente, modo de camara y prioridad VR | `src/storage/store.js`, `src/systems/camera-system.js`, `src/react-components/ui-root.js` |
| Full-body/RPM | normalizacion GLB, skeleton, locomocion Mixamo e IK | `src/components/player-info.js`, `src/components/fullbody-locomotion.js`, `src/components/ik-controller.js`, `src/utils/avatar-*.js`, `src/utils/mixamo-shared-animations.js` |
| Sitting | reserva Phoenix v2 versionada antes de mover, identidad Spoke estable, `isSitting` replicado y salida fail-closed | `src/utils/waypoint-reservation-*`, `src/utils/waypoint-entity-identity.js`, loaders/sistemas waypoint, `src/utils/hub-channel.js`, `src/react-components/ui-root.js` |
| Avatar upload | import local Admin, preview y GLB privado no listado neutral a proveedor | `admin/src/react-components/import-content.js`, `src/react-components/avatar-editor.js`, `src/react-components/media-browser.js`, `src/react-components/room/PrivateGlbHelpModal.js` |
| Bots | entidad NAF con namespace/ACK autoritativos, `bot-path`, chat privado con capacidad exacta por canal y settings 0..10 | `src/components/bot-*.js`, `src/network-schemas.js`, `src/systems/bot-runner-system.js`, `src/react-components/room/BotChatPanel*`, `src/react-components/room/RoomSettingsSidebar*`, `src/utils/bot-chat-lifecycle.js` |
| UI/i18n | Obsidian Aurora, espanol forzado, responsive y badge | `src/react-components/**`, `src/assets/locales/es.json`, `src/utils/i18n.js` |
| Estabilidad | guards de transform, cookie parsing, assets runtime | `src/components/*transform*`, `src/utils/identity.js`, `webpack.config.js`, `RetPageOriginDockerfile` |

Assets propios que deben sobrevivir:

- `src/assets/animations/mixamo/*.glb`;
- estilos y fondos de `landing-aurora`;
- locale espanol;
- tests de skeleton y features.

## Hubs CE y backend

| Area | Contrato propio | Archivos de mayor riesgo |
| --- | --- | --- |
| Generador | 44 recursos, un LB, TLS/cert-manager, RBAC, digests y hardening | `community-edition/generate_script/hcce.yam`, `index.js`, `verify-generated-manifest.js` |
| Reticulum | bots/NAF autoritativos, admisión global serializada, capacidad de chat por canal, reservas de waypoint, uploads, storage, seguridad, OTP 27 y SMTP | `services/reticulum/lib/ret/**`, `lib/ret_web/**`, `priv/repo/migrations/**`, `config/**`, `mix.*` |
| Bot orchestrator | GPT-5 Nano reply-only, moderación/deadline fail-closed, Presence/ACK y readiness | `services/bot-orchestrator/app.js`, `run-bot.js`, `run-ghost-runner.js`, tests |
| Navegacion bots | GLB parcial, navmesh obligatorio, A*, recuperación limpia, `spawbot-*`, static | `services/bot-orchestrator/run-ghost-runner.js` |
| Dialog | Node 22, Mediasoup, auth y runtime non-root | `services/dialog/**` |
| Photomnemonic | Chromium moderno, SSRF fail-closed y limites | `services/photomnemonic/**` |
| Coturn | URI DB fuera de logs/argv y runtime seguro | `services/coturn/**` |
| Spoke | retry de publicacion y token expirado | `services/spoke/src/api/Api.js`, tests |

## Contratos persistidos

Cambiar estos contratos exige compatibilidad hacia atras o migracion:

- `preferences.enableThirdPersonView`;
- `player-info.isSitting`;
- join Phoenix `waypoint_reservation` protocolo 2, su `state_version` global y su
  `client_instance_id` por pestaña;
- tabla `waypoint_reservations`, lease de 15 s, request sequence/fingerprint y
  unicidad por `(hub_id, waypoint_id)`;
- `hub.user_data.bots`:
  - `enabled`;
  - `count` 0..10;
  - `mobility`: `static`, `low`, `medium`, `high`;
  - `chat_enabled`;
  - prompt limitado;
- admisión global de configuraciones activas serializada en PostgreSQL, con
  `MAX_ACTIVE_ROOMS` idéntico en Reticulum y bot-orchestrator;
- template/schema NAF `#remote-bot-avatar`, namespace exacto
  `room-bot-<hub_sid>-bot-<1..10>`, `bot-info`, `bot-path` y ACK de first sync;
- archivos Reticulum: DB metadata + pares cifrados `.blob`/`.meta.json`;
- app config JSON almacenada como wrapper `{"value": ...}`;
- `PERMS_KEY` compartida por Reticulum y Dialog.

## Contratos de privacidad de bots

- No hay historial persistido en YenHubs.
- El historial React desaparece al salir de la sala.
- La capacidad de chat es base64url de 32 caracteres exactos, privada por canal
  y vinculada a sala/cuenta/epoch; se rota o revoca en cambios de identidad y
  las respuestas asíncronas obsoletas se descartan.
- Mensajes y prompts se filtran en logs.
- OpenAI usa `store:false`, moderacion y salida estructurada.
- La salida estructurada solo contiene reply. Las acciones no proceden del
  modelo: se derivan de una orden humana exacta, se sanea el destino y
  Reticulum vuelve a validarlas.
- `store:false` no equivale a Zero Data Retention del proveedor.

## Contratos operativos

- Builds custom solo mediante GitHub Actions.
- Produccion fija imagenes por digest.
- Hubs rollout implica reinicio posterior de Reticulum.
- El rollout de sitting despliega Reticulum/migración antes que Hubs y no acepta
  exclusión durante la ventana de clientes legacy.
- Bot readiness usa `/ready`; `/health` es solo liveness/diagnóstico.
- `pgsql`, Reticulum, Dialog y Coturn usan `Recreate`.
- Solo existe un LoadBalancer.
- El cluster low-cost no usa control-plane HA.
- Los secretos reales solo viven en el values local ignorado, GitHub Secrets y
  Kubernetes Secrets.

## Bloqueos antes de producción

- `AUD-065`: checkpoint fresco DB+storage y rotación coordinada de secretos
  potencialmente expuestos antes de cualquier mutación.
- Un runner por pod/contenedor con frontera OS, credencial y recursos propios;
  fencing persistente en DB para leases de autoridad.
- Aprobación persistida o cuarentena ejecutable para configuraciones activas
  heredadas; `room_stop` sigue siendo best-effort.
- Capacidad física, Actions, staging y aceptación live siguen pendientes; los
  gates locales no miden CCU ni autorizan rollout público.

## Prueba obligatoria tras upgrade

```bash
./scripts/verify-project.sh --full
./deployment/verify-live-reactivation.sh
```

Ademas, realizar carga fria en navegador desktop y movil y comprobar:

1. Home, entrada y escena 3D.
2. Primera/tercera persona.
3. Avatar normal y full-body.
4. Carrera de dos clientes por una silla autoritativa, pose remota,
   stand/reclaim y desconexión.
5. Bots static y moviles sobre navmesh, auth/namespace/ACK y `/ready`.
6. Chat IA sin persistencia.
7. Selector/subida de avatar.
8. Spoke y Admin.
9. Entrada multiusuario y audio.
