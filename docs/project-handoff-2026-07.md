# Handoff de YenHubs - Julio 2026

Fecha de corte: 16 de julio de 2026.

Este documento es el punto de entrada para continuar YenHubs. El procedimiento operativo completo esta en
`deployment/README.md`; la evidencia y riesgos estan en `docs/audit-2026-07.md`.

## Estado del proyecto

YenHubs esta reactivado en DigitalOcean y usa las ultimas releases estables auditadas para este ciclo:

- Hubs `prod-2026-03-11` con las personalizaciones YenHubs.
- Hubs Community Edition `2.1.0`.
- Reticulum modernizado sobre Elixir 1.18.4 / OTP 27.3.4.14 y Phoenix 1.6.17.
- Bots con ghost runner Node, no Chromium.
- Spoke, Admin, Dialog, Coturn, Photomnemonic, PostgreSQL y almacenamiento persistente operativos.

Produccion: <https://meta-hubs.org>
Sala de aceptacion: <https://meta-hubs.org/VJopCY3/inicio>
Namespace Kubernetes: `hcce`
Cluster/contexto: `hubs-ce` / `do-ams3-hubs-ce`

## Repositorios y ramas base

| Ruta | Repositorio | Rama base |
| --- | --- | --- |
| `/Users/Shared/Gits/YenHubs` | `yengalvez/meta-hubs` | `main` |
| `/Users/Shared/Gits/YenHubs/hubs` | `yengalvez/hubs` | `master` |
| `/Users/Shared/Gits/YenHubs/hubs-cloud` | `yengalvez/hubs-cloud` | `master` |

El superproyecto fija los commits exactos de ambos submodulos. Una feature no esta integrada hasta que el commit del
subrepo esta en su rama base y el puntero queda registrado en `meta-hubs/main`.

## Funcionalidad personalizada estable

- Camara primera/tercera persona, con primera persona forzada en VR.
- Avatares normales, RPM full-body y subida privada Avaturn no listada.
- Importacion Admin local/URL, previews, featured y validacion de archivos en servidor.
- Sitting con waypoints `Disable motion`, pose compartida y boton Sentarse/Levantarse.
- Locomocion full-body idle, walk, lateral y atras.
- Bots por sala con 0..10 instancias, movilidad, featured avatars, patrulla `spawbot-*`, chat privado y acciones de
  navegacion allowlist.
- Ghost runner de bajo consumo, sincronizacion de late joiners y reconciliacion dinamica sin reiniciar procesos.
- UI oscura glass en espanol, responsive para desktop, tablet y movil.
- Badge de version del bundle en la toolbar.

## Bots e IA

Reticulum es la autoridad de configuracion y acciones. `bot-orchestrator` ejecuta el ghost runner y llama a OpenAI
`gpt-5-nano` desde backend.

Garantias implementadas:

- `store: false` en Responses API.
- YenHubs no guarda conversaciones en DB, ficheros ni logs.
- El historial del cliente vive solo en memoria y se pierde al salir de la sala.
- Moderacion de entrada y salida.
- Rate limit por cuenta y sala, incluso alternando bots.
- Mensajes, prompt, salida y tokens limitados.
- Structured Outputs estricto y acciones allowlist `go_to_waypoint`.
- `safety_identifier` seudonimo; no se envia el ID de cuenta en claro a OpenAI.
- La UI informa que la conversacion es temporal y que un proveedor procesa el mensaje.

Limite externo: `store:false` no equivale a Zero Data Retention. OpenAI puede conservar datos de monitoreo de abuso
hasta 30 dias salvo que la organizacion tenga ZDR aprobado. No pedir datos sensibles y revisar el aviso legal antes de
un evento publico.

## Infraestructura y coste

Topologia intencionada de bajo coste:

- Un cluster DOKS no-HA.
- Un nodo `s-4vcpu-8gb` en `ams3`.
- Un unico Load Balancer.
- Dos PVC de 10 GiB.
- Coste estimado aproximado: 62 USD/mes.

No anadir nodos, LoadBalancers o ampliar PVC sin aprobacion de coste. Escalar pods a cero no elimina el coste del nodo,
LB ni volumenes.

## Imagenes finales

La fuente de verdad operativa es `deployment/input-values.local.yaml`, siempre con `repository@sha256:digest`.

| Servicio | Imagen final |
| --- | --- |
| Hubs | `ghcr.io/yengalvez/hubs@sha256:c5e2ee4eb125535b8b8ca55a369f24e2e2c5bcf2882158e53996bf5df3c030f3` |
| Reticulum | `ghcr.io/yengalvez/reticulum@sha256:0b1f8104a520a15828f92ac1428c98a8f45846dcf49d0c99e8ea929f26dad317` |
| Bot orchestrator | `ghcr.io/yengalvez/bot-orchestrator@sha256:1ab1e66b63aa3ae08bf78b285ba52f46ec555fedb2924ed5aea906f44b28f3b5` |
| Spoke | `ghcr.io/yengalvez/spoke@sha256:f5120264938e189e702f835182ed4a28a5ce20b140d7262bc2a3074e6d0b6657` |
| Dialog | `ghcr.io/yengalvez/dialog@sha256:95687f4765e7a68ef05a714b807bf5c80e0f9187e2715f3a5a96e2d664377a23` |
| Photomnemonic | `ghcr.io/yengalvez/photomnemonic@sha256:aef369b82212429d01c0f1f554b16c34a99cf4bbb75e0693e190c796b33012f2` |
| Coturn | `ghcr.io/yengalvez/coturn@sha256:c2ad335349d477d342d5b17c82b513bfebc8c17b8e6b4e27a3049f3478207780` |

No usar un tag `latest` como unica referencia de rollback.

## Deploy correcto

Solo se aprueba este flujo:

1. Validar codigo localmente.
2. Commit y push de la rama.
3. Construir/publicar por el GitHub Actions estandar del repo.
4. Resolver el digest publicado y actualizar `deployment/input-values.local.yaml`.
5. Copiarlo al `input-values.yaml` ignorado de Hubs CE.
6. Ejecutar `npm run gen-hcce`; debe validar 44 recursos.
7. Revisar `kubectl diff` sin imprimir Secrets.
8. Ejecutar `kubectl apply -f hcce.yaml`.
9. Esperar el rollout.
10. Si cambia Hubs, reiniciar Reticulum para refrescar HTML y hashes de assets.
11. Hacer una carga fria en navegador real y confirmar que `APP`/`AFRAME` arrancan y no hay excepciones.
12. Ejecutar `deployment/verify-live-reactivation.sh` y exigir 0 fallos/0 avisos.

No usar builds locales/in-cluster, `kubectl set image`, copia de ficheros al pod, edicion manual del manifiesto ni parches
RBAC posteriores sin autorizacion explicita.

## Backup y rollback

Checkpoint previo al rollout final:

`output/final-candidate-predeploy-20260716-014319/`

Incluye:

- dump comprimido de Reticulum/PostgreSQL;
- archivo de storage persistente;
- checksums verificados;
- inventario de deployments, commits e imagenes;
- evidencia del verificador.

En ese checkpoint final previo habia 34 archivos activos, 34 blobs activos, 34 metadatos activos y cuatro pares
completos diferidos por la reconciliacion de Spoke; no eran corrupcion.

Checkpoint previo a la reparacion SMTP/publicacion de escena:

`output/magiclink-scene-prepublish-20260716-093347/`

Incluye un dump, un archivo de storage y copias original/modificada del proyecto Spoke con checksums. En ese momento
habia 34 archivos activos y 38 pares fisicos completos. Tras publicar el nuevo `Floor Plan`, el estado live conserva
34 activos y 43 pares completos, de los cuales nueve son diferidos validos pendientes de la reconciliacion normal.

Rollback de Hubs probado:

`ghcr.io/yengalvez/hubs@sha256:aa703dc35b80e05a3ece28a9827375fd9d2d312dfa5a173991ebf54a3e978481`

Para restaurar DB/storage seguir exclusivamente `deployment/README.md` y `deployment/restore-retdb.sh`. No restaurar
el dump raw de marzo sobre el estado actual: contenia 93 referencias activas cuyos bytes ya no existian.

## Validacion final realizada

- Hubs: TypeScript, ESLint, 12 pruebas unitarias y build de produccion.
- Hubs CE: generador 2.1.0 y verificacion de 44 recursos.
- Reticulum: formato, compilacion estricta, 278 pruebas, properties y release.
- Bot orchestrator: 19 pruebas y 0 advisories de produccion.
- Audio real entre dos navegadores por Dialog/WebRTC.
- DNS, TLS, 12 deployments, hardening, DB/storage, HTTPS, assets y CSP.
- Ghost runner: late join, movimiento, cinco bots visibles, config live 5 -> 10 -> 5 sin reiniciar proceso.
- Magic link real entregado a `info@virtualmente.com`, verificacion Hubs completada y Spoke autenticado.
- Escena `f6VKtim` republicada con un `nav-mesh` nativo; la sala carga exactamente un nav mesh sin errores.
- Carga fria de Hubs en navegador real.
- Capturas y layout sin overflow a 1440x900, 1024x1366 y 390x844.
- Flujo de entrada movil completo, toolbar oculta durante el modal y badge de version visible tras entrar.

Evidencia visual final: `output/final-acceptance-20260716/`.

## Riesgos residuales conocidos

No presentar estos puntos como ya probados:

- VR real no se probo con casco fisico.
- La carrera de dos usuarios intentando ocupar el mismo asiento no tuvo aceptacion multiusuario dedicada.
- El guardado real de un nuevo Avaturn y un Publish/Delete aislado de Spoke requieren mutar DB/storage; no se hicieron
  sin un checkpoint dedicado.
- No se hizo una carga representativa de cinco salas con bots y alto CCU/WebRTC.
- Los secretos que aparecieron historicamente en Git fueron rotados, pero la historia publica no se reescribio porque
  es una operacion destructiva para clones y referencias.
- El bundle Hubs sigue siendo grande; es deuda de rendimiento, no una regresion funcional.
- La escena recuperada ya tiene `nav-mesh` y no permite el fallo vertical causado por su ausencia. Conserva avisos
  A-Frame/MeshBVH y no tiene `box-collider`; el raycast de bots queda en fallback.

## Secretos y configuracion local

- Fuente local real: `deployment/input-values.local.yaml`.
- Copia runtime ignorada: `hubs-cloud/community-edition/input-values.yaml`.
- Administrador Hubs/Spoke: `info@virtualmente.com`.
- Mailtrap se identifica operativamente por account ID `2385821` y dominio verificado `meta-hubs.org`; la cuenta del
  proveedor no debe inferirse a partir del correo administrador.
- Nunca versionar ni imprimir tokens, claves SMTP/OpenAI, `PERMS_KEY`, `BOT_ACCESS_KEY` o passwords DB.
- Mantener `PERMS_KEY` identico en Reticulum y Dialog.
- GitHub usa secretos `REGISTRY_USERNAME` y `REGISTRY_PASSWORD` para GHCR.

## Orden para continuar

1. Leer este handoff y `deployment/README.md`.
2. Ejecutar `deployment/preflight-reactivation.sh`.
3. Confirmar ramas, submodulos y arboles limpios.
4. Crear un checkpoint DB+storage antes de cualquier cambio mutable.
5. Crear una rama `codex/<feature>` en el subrepo afectado.
6. No mezclar una feature, un upgrade upstream y una migracion backend en el mismo cambio.
7. Validar, construir por Actions, desplegar por manifiesto generado y aceptar en navegador real.
8. Actualizar `docs/session-changelog.md` y este handoff si cambia la arquitectura.
