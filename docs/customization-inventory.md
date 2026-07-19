# Inventario de personalizaciones YenHubs

Este documento es la checklist de preservacion para upgrades. Los detalles de
uso estan en `features/`; la evidencia de pruebas esta en
`docs/audit-2026-07.md`.

## Magnitud

Comparado con las releases estables aceptadas:

- Hubs: 172 archivos, 14.681 inserciones y 2.611 eliminaciones.
- Hubs CE: 155 archivos, 28.154 inserciones y 12.876 eliminaciones.

Las cifras anteriores corresponden al corte base medido. El corte fuente de
`AUD-075` queda identificado por Hubs `674ece411691` y Hubs Cloud
`5392495b077249edcedfb3092551201645f648f1`. `AUD-075` llegó a `development`
por el PR `#11` (`ebe960794735d378149966b78090e22acc60cc26`) y a `master` por el
PR `#12` (`5392495b077249edcedfb3092551201645f648f1`), con CI Cloud verde. Pasan
128/128 del orquestador, 30/30 del generador con 58 recursos y Reticulum 430
pruebas + 5 properties. En la raíz, los gates normal y `--full` pasan con
seguridad 43/43, recuperación 239/239, Pods 45/45, pull 19/19 y Deployment
18/18, además de Hubs 97/97 y build, navegador 11/11, capacidad 115/115
fail-closed, Dialog 2/2, Photomnemonic 7/7 y Spoke 68/68 y build. No hay build
de imágenes, digests, checkpoint, staging, despliegue, aceptación live ni
capacidad física atribuibles a esta integración Git/fuente.

Ambos commits pertenecen ya a las ramas base de sus subrepositorios y root
`main` los fijó mediante el PR raíz `#5`. No llamar «final» a ese commit Cloud
para el rollout vigente: el commit final será el que integre después `AUD-078`,
el productor de procedencia/recibos y su gitlink/consumidor raíz, antes del build
conjunto.

## Cliente Hubs

| Area | Contrato propio | Archivos de mayor riesgo |
| --- | --- | --- |
| Tercera persona | preferencia persistente, modo de camara y prioridad VR | `src/storage/store.js`, `src/systems/camera-system.js`, `src/react-components/ui-root.js` |
| Full-body/RPM | normalizacion GLB, skeleton, locomocion Mixamo e IK | `src/components/player-info.js`, `src/components/fullbody-locomotion.js`, `src/components/ik-controller.js`, `src/utils/avatar-*.js`, `src/utils/mixamo-shared-animations.js` |
| Sitting | reserva Phoenix v2 versionada antes de mover, identidad Spoke estable, `isSitting` replicado y salida fail-closed | `src/utils/waypoint-reservation-*`, `src/utils/waypoint-entity-identity.js`, loaders/sistemas waypoint, `src/utils/hub-channel.js`, `src/react-components/ui-root.js` |
| Avatar upload | import local Admin, preview y GLB privado no listado neutral a proveedor | `admin/src/react-components/import-content.js`, `src/react-components/avatar-editor.js`, `src/react-components/media-browser.js`, `src/react-components/room/PrivateGlbHelpModal.js` |
| Bots | entidad NAF con namespace/ACK autoritativos, `bot-path`, chat privado con capacidad exacta por canal, settings 0..10 y Admin de aprobación redactada | `src/components/bot-*.js`, `src/network-schemas.js`, `src/systems/bot-runner-system.js`, `src/react-components/room/BotChatPanel*`, `src/react-components/room/RoomSettingsSidebar*`, `admin/src/react-components/bot-config-approvals.js`, `src/utils/bot-chat-lifecycle.js` |
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
| Generador | 58 recursos, un LB, dos imágenes bot por digest, dos namespaces, pull Secret kubelet-only, ServiceAccounts/RBAC exactos, cuota, admisión, ocho NetworkPolicies, TLS/cert-manager y hardening | `community-edition/generate_script/hcce.yam`, `index.js`, `verify-generated-manifest.js`, `set-bot-image-pull-config.js` |
| Reticulum | bots/NAF autoritativos, token v1 preauth + lease UUID/epoch DB obligatorio, admisión global serializada, aprobación/cuarentena exacta, capacidad de chat por canal, reservas de waypoint, uploads, storage, seguridad, OTP 27 y SMTP | `services/reticulum/lib/ret/**`, `lib/ret_web/**`, `priv/repo/migrations/**`, `config/**`, `mix.*` |
| Bot orchestrator parent | GPT-5 Nano reply-only, moderación/deadline fail-closed, reconciliación namespaced de Pods, canal de control, `/transport-ready` y `/ready` | `services/bot-orchestrator/app.js`, `kubernetes-runner-manager.js`, `runner-control-client.js`, `runner-generation-token.js`, tests |
| Bot runner | imagen ghost-only, UID 10001, token de generación, Presence/ACK/navmesh, lease/epoch exactos, sin provider/master/Kubernetes credentials | `services/bot-orchestrator/Dockerfile.runner`, `run-ghost-runner.js`, `package.runner.json` |
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
- tabla `bot_config_approvals`, un registro por sala, con JSON candidato y
  aprobado exactos, fingerprint canónico, estado `approved`/`quarantined`,
  actor, motivo y timestamps; cualquier cambio exacto exige nueva aprobación;
- template/schema NAF `#remote-bot-avatar`, namespace exacto
  `room-bot-<hub_sid>-bot-<1..10>`, `bot-info`, `bot-path` y ACK de first sync;
- tabla `bot_runner_leases` con tombstone, lease UUID, holder/sesión, expiración
  y epoch global JS-safe; el token de generación v1 no persiste ni sustituye
  este fence;
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
- La probe Kubernetes del parent usa `/transport-ready` tras limpiar huérfanos;
  `/ready` sigue siendo la aceptación autoritativa y `/health` solo
  liveness/diagnóstico.
- Reticulum, parent y runner se construyen desde el mismo commit Cloud en tres
  imágenes dentro de un único run, con procedencia atestada y digests separados.
  El contrato conserva cinco ficheros distintos: recibo JSON, bundle del recibo
  y bundles OCI de las tres imágenes. Se verifican contra el commit derivado del
  gitlink Cloud de un root `main=origin/main` limpio, sin overrides, usando un
  `DOCKER_CONFIG` efímero owner-only `0700` con `config.json` `0600` que se borra
  al terminar. En la campaña `AUD-065`,
  `BOT_IMAGE_PULL_CONFIG_JSON_BASE64` se materializa solo desde la credencial
  NEW del Llavero mediante el gestor privado trackeado; el token no entra por
  argv o entorno y el Secret nunca se monta.
- El rollout bot usa Reticulum compatible primero y parent/runner/control-plane
  después mediante tres manifiestos completos de 58 recursos, regenerados como
  `bootstrap`, `admission` y `active`, cada uno aplicado exclusivamente con el
  wrapper `npm run apply`. Rollback inverso. Un manifiesto viejo no poda los
  recursos Kubernetes adicionales.
- `pgsql`, Reticulum, Dialog y Coturn usan `Recreate`.
- Solo existe un LoadBalancer.
- El cluster low-cost no usa control-plane HA.
- Los secretos reales solo viven en el values local ignorado, GitHub Secrets y
  Kubernetes Secrets.

## Bloqueos antes de producción

- `AUD-065`: las credenciales externas NEW existen, pero OLD/NEW, checkpoints y
  rotación siguen pendientes; ninguna mutación live está autorizada todavía.
- El aislamiento por Pod, el fencing DB y su gitlink raíz están integrados.
  Antes del rollout faltan, en orden: fusionar el tooling de secuencia;
  implementar/fusionar `AUD-078`; integrar el productor Cloud de
  procedencia/recibos y su consumidor raíz; construir Reticulum, parent y runner
  en un único run atestado; verificar recibo+cuatro bundles; crear checkpoint1;
  completar OLD/NEW y rotar; crear checkpoint2; y ejecutar
  `bootstrap -> admission -> active`, aceptación live/cold y promoción.
- `process-local` sigue siendo el último baseline live aceptado y puede servir
  de rollback. Tras volver a él, mantener bots públicos deshabilitados y no
  reabrirlo ni declararlo aceptado de nuevo hasta pasar preflight, verificador
  live y carga fría actuales con las credenciales rotadas.
- La aprobación/cuarentena está integrada pero no desplegada: la primera
  migración debe producir un inventario redactado y cada configuración válida
  requiere una decisión individual antes de reactivarse. El diseño separado
  `AUD-078` sigue pendiente y `room_stop` continúa siendo best-effort.
- Capacidad física, builds de imágenes por Actions, staging y aceptación live
  siguen pendientes; los gates de fuentes no miden CCU ni autorizan rollout
  público.

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
5. Bots static y moviles sobre navmesh: `/transport-ready`, auth
   token-v1+lease/epoch, namespace/ACK, un Pod exacto por sala y `/ready`.
6. Chat IA sin persistencia.
7. Selector/subida de avatar.
8. Spoke y Admin.
9. Entrada multiusuario y audio.
