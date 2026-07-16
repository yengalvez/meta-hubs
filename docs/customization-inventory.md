# Inventario de personalizaciones YenHubs

Este documento es la checklist de preservacion para upgrades. Los detalles de
uso estan en `features/`; la evidencia de pruebas esta en
`docs/audit-2026-07.md`.

## Magnitud

Comparado con las releases estables aceptadas:

- Hubs: 147 archivos, 10.913 inserciones y 2.472 eliminaciones.
- Hubs CE: 118 archivos, 13.663 inserciones y 12.700 eliminaciones.

## Cliente Hubs

| Area | Contrato propio | Archivos de mayor riesgo |
| --- | --- | --- |
| Tercera persona | preferencia persistente, modo de camara y prioridad VR | `src/storage/store.js`, `src/systems/camera-system.js`, `src/react-components/ui-root.js` |
| Full-body/RPM | normalizacion GLB, skeleton, locomocion Mixamo e IK | `src/components/player-info.js`, `src/components/fullbody-locomotion.js`, `src/components/ik-controller.js`, `src/utils/avatar-*.js`, `src/utils/mixamo-shared-animations.js` |
| Sitting | `Disable motion` implica asiento; `isSitting` replicado | `src/systems/character-controller-system.js`, `src/components/player-info.js`, `src/components/fullbody-locomotion.js`, `src/react-components/ui-root.js` |
| Avatar upload | import local Admin, preview, private Avaturn no listado | `admin/src/react-components/import-content.js`, `src/react-components/avatar-editor.js`, `src/react-components/media-browser.js` |
| Bots | entidad NAF, `bot-path`, chat privado y settings 0..10 | `src/components/bot-*.js`, `src/network-schemas.js`, `src/react-components/room/BotChatPanel*`, `src/react-components/room/RoomSettingsSidebar*` |
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
| Reticulum | bots, uploads, storage, seguridad, OTP 27, SMTP | `services/reticulum/lib/ret/**`, `lib/ret_web/**`, `config/**`, `mix.*` |
| Bot orchestrator | GPT-5 Nano, guardarrailes y ghost runner | `services/bot-orchestrator/app.js`, `run-ghost-runner.js`, tests |
| Navegacion bots | GLB parcial, navmesh, A*, `spawbot-*`, static | `services/bot-orchestrator/run-ghost-runner.js` |
| Dialog | Node 22, Mediasoup, auth y runtime non-root | `services/dialog/**` |
| Photomnemonic | Chromium moderno, SSRF fail-closed y limites | `services/photomnemonic/**` |
| Coturn | URI DB fuera de logs/argv y runtime seguro | `services/coturn/**` |
| Spoke | retry de publicacion y token expirado | `services/spoke/src/api/Api.js`, tests |

## Contratos persistidos

Cambiar estos contratos exige compatibilidad hacia atras o migracion:

- `preferences.enableThirdPersonView`;
- `player-info.isSitting`;
- `hub.user_data.bots`:
  - `enabled`;
  - `count` 0..10;
  - `mobility`: `static`, `low`, `medium`, `high`;
  - `chat_enabled`;
  - prompt limitado;
- templates/schemas NAF `#remote-bot-avatar`, `bot-info`, `bot-path`;
- archivos Reticulum: DB metadata + pares cifrados `.blob`/`.meta.json`;
- app config JSON almacenada como wrapper `{"value": ...}`;
- `PERMS_KEY` compartida por Reticulum y Dialog.

## Contratos de privacidad de bots

- No hay historial persistido en YenHubs.
- El historial React desaparece al salir de la sala.
- Mensajes y prompts se filtran en logs.
- OpenAI usa `store:false`, moderacion y salida estructurada.
- Las acciones se validan en backend y solo admiten nombres allowlist.
- `store:false` no equivale a Zero Data Retention del proveedor.

## Contratos operativos

- Builds custom solo mediante GitHub Actions.
- Produccion fija imagenes por digest.
- Hubs rollout implica reinicio posterior de Reticulum.
- `pgsql`, Reticulum, Dialog y Coturn usan `Recreate`.
- Solo existe un LoadBalancer.
- El cluster low-cost no usa control-plane HA.
- Los secretos reales solo viven en el values local ignorado, GitHub Secrets y
  Kubernetes Secrets.

## Prueba obligatoria tras upgrade

```bash
./scripts/verify-project.sh --full
./deployment/verify-live-reactivation.sh
```

Ademas, realizar carga fria en navegador desktop y movil y comprobar:

1. Home, entrada y escena 3D.
2. Primera/tercera persona.
3. Avatar normal y full-body.
4. Sit/stand.
5. Bots static y moviles sobre navmesh.
6. Chat IA sin persistencia.
7. Selector/subida de avatar.
8. Spoke y Admin.
9. Entrada multiusuario y audio.
