# Handoff de YenHubs - 16 de julio de 2026

Este es el punto de entrada para continuar el proyecto sin depender de una conversacion anterior.

> **Addendum activo — 17 de julio de 2026:** los hashes e imágenes de este
> documento siguen describiendo producción el 16 de julio. Hay candidatos aún
> no desplegados para reservas autoritativas de sitting, autenticación/readiness
> de bots, carga GLB neutral a proveedor, arnés de capacidad y gate de Spoke.
> Durante el trabajo se mostró contenido real del `hcce.yaml` local ignorado al
> registro de la tarea. La exposición no produjo apply ni cambio live. Los
> candidatos se publicaron después en ramas y PR separados, pero el próximo
> rollout queda bloqueado hasta rotar de forma coordinada todos los
> secretos potencialmente incluidos y verificar solo por huella. No volver a
> abrir ni imprimir el manifiesto ignorado para inventariarlos. Además, el
> candidato de bots no puede pasar a rollout público ni a certificación de
> capacidad mientras padre y runners ghost compartan contenedor, UID, namespace
> PID y cgroup; debe separarse cada runner con credenciales y recursos propios.

## Estado ejecutivo

YenHubs esta operativo en <https://meta-hubs.org> y el verificador live informa 0 fallos y 0 avisos. La produccion usa:

- Hubs `prod-2026-03-11` con 79 commits propios adicionales.
- Hubs CE `2.1.0` con 79 commits propios adicionales.
- Reticulum sobre Elixir 1.18.4 / OTP 27.
- Ghost runner Node, no Chromium, con navmesh+A*.
- Un cluster DOKS no-HA `hubs-ce` en `ams3`.

Sala de aceptacion: <https://meta-hubs.org/VJopCY3/inicio>

| Elemento | Valor |
| --- | --- |
| Namespace | `hcce` |
| Contexto | `do-ams3-hubs-ce` |
| Sala principal | `VJopCY3` |
| Proyecto Spoke | `qa3U3Ke` |
| Escena | `f6VKtim` |
| Administrador operativo | `info@virtualmente.com` |

## Repos y ramas

| Ruta | Rama base | Fuente final auditada | Fuente del runtime live |
| --- | --- | --- | --- |
| Root | `main` | commit que contiene este handoff | `a0a2b59cad80e0b07f9b2a2f82c2020781163570` |
| `hubs/` | `master` | `d7f0c2fc40bb17e36e428b425064d2d47c7cdcbe` | `a7214eb882d19c98b2c8516489e0ed1fb7401c75` |
| `hubs-cloud/` | `master` | `b7b752f8247b30b22df241bfad2be795c5733420` | `5a82de5387d7296cd01470d5136b2c07c2d5c7ac` |

Los commits del corte original de auditoria/CI estan publicados en Git. Los
candidatos del addendum tambien estan publicados en ramas remotas y PR, pero no
pertenecen todavia a las ramas base ni cambiaran el runtime hasta construir
nuevas imagenes por Actions y desplegarlas por digest.

Estado de publicacion comprobado el 17 de julio:

- Hubs PR `#3`, `codex/hubs-race-hardening-final -> master`: `CLEAN`, checks
  verdes.
- Hubs Cloud PR `#1`, `codex/bot-safety-final -> development`: `CLEAN`, checks
  verdes. Tras fusionarlo debe abrirse y aceptar el paso separado
  `development -> master` exigido por el repositorio.
- Meta-hubs PR `#1`, `codex/final-audit-readiness -> main`: bloqueado solo
  porque `main` todavia no contiene la politica Gitleaks base-owned.
- Meta-hubs PR minimo `#2`, `codex/gitleaks-policy-bootstrap -> main`: `CLEAN`,
  checks verdes y pendiente de revision/merge. Debe integrarse antes de repetir
  el PR `#1`; no se debe permitir que la politica candidata se autorice a si
  misma.

La integración candidata del 17 de julio está cerrada en GO sobre
Hubs `d7f0c2fc4` y Hubs Cloud `b7b752f`. Este resultado solo acredita código,
suites, builds locales y CI de PR: no sustituye los valores live de la tabla,
no implica que se hayan construido imágenes candidatas por Actions y no constituye aceptación de
staging, capacidad ni producción. No actualizar punteros base ni digests live
hasta completar el flujo publicado de integración y rollout.

El candidato de bots añade dos contratos que tampoco forman parte del runtime
live de la tabla:

- Reticulum serializa en una transacción PostgreSQL la admisión global de salas
  activas. Solo un administrador global no deshabilitado puede activar o
  modificar bots; un propietario ordinario puede conservar la configuración
  aprobada al cambiar otros datos o desactivarla. El alta que exceda el límite
  se rechaza antes de persistir. Generador y verificador obligan a que Reticulum
  y bot-orchestrator reciban el mismo `MAX_ACTIVE_ROOMS` (5 por defecto, máximo
  duro 10).
- Cada canal autenticado recibe una capacidad aleatoria privada para chat. Se
  registra server-side solo tras entrar en la sala, se rota al iniciar sesión y
  se invalida al cerrar sesión o terminar el canal. El cliente exige la
  capacidad exacta base64url de 32 caracteres, el canal, sala, bot, cuenta y
  epochs capturados para aceptar una respuesta tardía; no se publica en Phoenix
  Presence y una segunda sesión de la misma cuenta no puede reutilizarla.

El gate separado de Spoke también pasó localmente con Node 16.13.2/Yarn 1:
68/68 pruebas, lint y build. Spoke conserva su deuda legacy; este resultado no
autoriza un upgrade masivo ni demuestra publicar la escena en live.

## Imagenes live

| Deployment | Imagen |
| --- | --- |
| Hubs | `ghcr.io/yengalvez/hubs@sha256:cff099ef4759c8ec8e8d6010ae9268c6b6e99f29ff5ecb50f6e50ce884d20a8c` |
| Reticulum | `ghcr.io/yengalvez/reticulum@sha256:9ae6712fa5cd4380048ec559cbf75596507ae91cdbd653cac1978b685254faef` |
| Bot orchestrator | `ghcr.io/yengalvez/bot-orchestrator@sha256:325c5c10e4ee039518693771c0974a0e5c876dcf54c443295e84490f4fa8ec53` |
| Spoke | `ghcr.io/yengalvez/spoke@sha256:f5120264938e189e702f835182ed4a28a5ce20b140d7262bc2a3074e6d0b6657` |
| Dialog | `ghcr.io/yengalvez/dialog@sha256:95687f4765e7a68ef05a714b807bf5c80e0f9187e2715f3a5a96e2d664377a23` |
| Photomnemonic | `ghcr.io/yengalvez/photomnemonic@sha256:aef369b82212429d01c0f1f554b16c34a99cf4bbb75e0693e190c796b33012f2` |
| Coturn | `ghcr.io/yengalvez/coturn@sha256:c2ad335349d477d342d5b17c82b513bfebc8c17b8e6b4e27a3049f3478207780` |

El inventario completo esta en el checkpoint y en el cluster; no usar tags `latest` como rollback.

## Funcionalidad aceptada

- Entrada desktop/movil, landing y sala 3D.
- Camara primera/tercera persona.
- Avatares normales y RPM full-body.
- Flujo Avaturn privado no listado y validacion client/server.
- Import Admin, previews y Featured.
- Sitting con `Disable motion`, animacion y salida del asiento.
- Bots `static|low|medium|high`, 0..10, `spawbot-*`, navmesh+A* y late join.
- Chat privado de bot con GPT-5 Nano, Structured Outputs, moderacion y acciones allowlist.
- Historial de bot solo en memoria de la sesion; no hay persistencia de conversaciones en YenHubs.
- Magic link Mailtrap, Admin, Spoke, Dialog/Coturn y audio multiusuario.

## Backup vigente

Checkpoint completo mas reciente:

```text
output/checkpoints/20260716-215518/
```

Contenido validado:

- DB comprimida: 49 KiB, SHA-256
  `bddfdcb4d69c210908b76660cb6949586f307aeac3390ac72967614a0ed5c5f1`.
- Storage comprimido: 183 MiB, SHA-256
  `8c34c803b41ba4217fa620ae4472fbb604b028c49e573651466227893b222102`.
- 356 de schema, 94 migraciones, 33 archivos activos.
- 47 pares fisicos completos, 14 diferidos validos.
- commits, imagenes, Kubernetes, DigitalOcean y presencia de configuracion.
- `SHA256SUMS` y dry-runs de DB/storage correctos.

`output/latest-backup-path.txt` conserva una referencia historica ignorada, pero
el preflight actual no la selecciona: cada rollout debe pasar `BACKUP_DIR`
explicitamente y crear un checkpoint fresco con el layout vigente. Mantener una segunda copia cifrada fuera
del Mac antes de retirar infraestructura.

## Credenciales operativas

### 1. Pull de paquetes GHCR

La credencial se renovo el 16 de julio de 2026 y se distribuyo sin imprimirla a:

- llavero macOS, servicio `YenHubs-GHCR`;
- secretos `REGISTRY_USERNAME`/`REGISTRY_PASSWORD` de `yengalvez/hubs`;
- secretos `REGISTRY_USERNAME`/`REGISTRY_PASSWORD` de `yengalvez/hubs-cloud`;
- `Secret/ghcr-pull` y `ServiceAccount/default` del namespace `hcce`.

Se comprobo pull de los tres digests privados y permiso de inicio de upload en
GHCR; `deployment/preflight-reactivation.sh` termino con 0 fallos y 0 avisos.
No almacenar esta credencial en inputs de workflow ni YAML trackeado.

### 2. Clave OpenAI historica

La clave encontrada en la historia Git era tambien la clave live anterior. El
16 de julio de 2026 se creo una clave distinta, se valido contra Models,
Moderation y Responses, se desplego mediante el manifiesto estandar y el chat
live respondio con `gpt-5-nano`. La clave nueva solo se conserva en el llavero
macOS (`YenHubs-OpenAI`) y en los valores locales/Secret ignorados.

La clave anterior se revoco en el panel OpenAI el 16 de julio de 2026. Una
comprobacion posterior devolvio HTTP 401, mientras la clave nueva siguio
respondiendo HTTP 200. Su copia temporal se elimino del llavero. La historia Git
no se reescribio porque es una operacion destructiva; Gitleaks del entregable
actual esta limpio.

### 3. Capacidad no certificada

La topologia actual no tiene Metrics Server ni una prueba de carga
representativa. `tests/capacity/` ya define y valida planes reproducibles para
30/100 por sala, 300 totales y un modelo de 10.000, todos con variantes de
0/5/10 bots; sus 115 pruebas pasan. El driver Playwright confinado está
implementado, pero el almacén de confianza de producción está deliberadamente
vacío: ninguna ejecución física puede empezar hasta que el propietario
versione y revise su clave pública y exista un staging con el contrato exacto
de collector/Prometheus. No se ejecutó carga; el modelo nunca certifica
capacidad. No prometer 75, 300 o 10.000 CCU basándose en requests, fixtures o
planes. La recomendación oficial de Hubs sigue siendo alrededor de 25 usuarios
dentro de una sala. Ver
`docs/bots-cost-capacity-analysis-2026-07.md`.

### 4. Rotación reabierta para el próximo rollout

La exposición accidental del manifiesto local al registro de esta tarea se
trata como compromiso potencial aunque el fichero estuviera ignorado y el
registro no sea público. Antes de construir/desplegar el siguiente candidato:

1. crear el checkpoint DB+storage exigido;
2. rotar mediante los runbooks vigentes todos los secretos que pudieran figurar
   en el manifiesto generado, sin copiar valores a tickets, chat o shell output;
3. mantener `PERMS_KEY` coherente entre Reticulum y Dialog y reiniciar los
   consumidores que correspondan;
4. comprobar hashes, filtros `[FILTERED]`, pulls GHCR y paridad de configuración;
5. regenerar en temporal aislado, ejecutar `kubectl diff` sin imprimir Secrets y
   exigir preflight 0/0 antes de cualquier apply.

## Bloqueos y residuales del candidato de bots

Aunque el hijo ghost recibe por entorno únicamente `BOT_RUNNER_ACCESS_KEY`, el
padre y todos los runners siguen siendo procesos del mismo contenedor bajo UID
1000, el mismo namespace PID y el mismo cgroup de memoria. La allowlist de
entorno reduce exposición accidental, pero no constituye aislamiento frente a
JavaScript comprometido: `/proc` puede exponer el entorno del padre, los
procesos pueden señalizarse y una sola sala puede agotar el límite compartido y
derribar todo el orquestador.

Esto bloquea el rollout público del candidato y cualquier certificación de
capacidad. La salida requerida es ejecutar cada runner en un pod o contenedor
aislado, con namespace de proceso, credencial de runner, requests/limits y
política de red propios; el padre debe conservar las credenciales OpenAI y de
orquestación y comunicarse con los runners mediante un canal autenticado y
mínimo. Este rediseño aún no está implementado ni desplegado.

El GO de integración local no levanta los siguientes bloqueos:

- `AUD-065`: antes de cualquier mutación de producción hay que crear un
  checkpoint fresco de DB+storage y rotar coordinadamente todos los secretos
  potencialmente expuestos, verificándolos solo por presencia o huella;
- cada runner sigue sin aislamiento OS/pod por bot, con UID, namespace PID y
  cgroup compartidos;
- los leases de autoridad del orquestador no tienen fencing persistente en DB;
  no se puede operar más de una autoridad concurrente con garantías;
- las configuraciones activas heredadas carecen de aprobación persistida y de
  una cuarentena ejecutable fail-closed; se exige inventario exacto redacted y
  aprobación del propietario o migración antes de permitir autostart;
- `room_stop` es best-effort: DB y snapshots terminan convergiendo, pero un fallo
  de la llamada no garantiza detener inmediatamente el runner;
- no se ejecutó carga física ni aceptación staging/live. No hay capacidad
  medida ni autorización de rollout público.

## Riesgos no bloqueantes

- VR fisico no probado.
- El baseline live permite una doble ocupación transitoria y deja estado NAF
  visual obsoleto tras ciertos cierres; el candidato autoritativo lo aborda,
  pero falta E2E de dos navegadores en staging y aceptación cold live.
- Guardado real de un Avaturn nuevo requiere checkpoint dedicado.
- El cierre de Ready Player Me obliga a evitar una dependencia nueva del
  proveedor; la recomendación actual es conservar GLB manual y ensayar
  MPFB/MakeHuman local antes de contratar Avaturn/MetaPerson.
- El bundle Hubs es grande (~8,4 MiB el entrypoint de sala).
- Spoke conserva dependencias legacy y advisories; se valida con Node 16.13.2 y debe modernizarse como proyecto
  separado, no con un upgrade masivo.
- `cowlib 2.18.0` mantiene dos avisos upstream sin release corregida; cualquier aviso Hex adicional falla CI.
- La imagen del orquestador conserva Chromium solo para diagnóstico browser
  legacy/local, sin `--runner`; no es un fallback operativo ni autenticado. El
  renderer no recibe `BOT_RUNNER_ACCESS_KEY`, por lo que Reticulum endurecido rechaza
  ese navegador, nunca cuenta para readiness y la clave no debe pasarse por URL
  ni estado cliente. Separar una imagen ghost-only reduciría tamaño/superficie.
- La proximidad de 3 m para `Talk` sigue siendo UX, no autorización por
  distancia. El candidato exige la capacidad privada exacta de un canal
  autenticado que haya entrado en la misma sala; se rota al iniciar sesión, se
  invalida al cerrar sesión o morir el canal y no se publica en Presence.
  Validar distancia real aún exigiría una posición fresca y confiable
  server-side.
- La exploración sitting del baseline produjo 2 errores y 61 warnings de
  navegador. El verificador operativo 0/0 no cubre esa misma superficie; el
  próximo cierre exige consola/red/página sin errores ni warnings en cold
  desktop y mobile.

## Auditoria y pruebas realizadas

El cierre candidato del 17 de julio añadió Hubs `d7f0c2fc4`, Hubs Cloud
`b7b752f` y el gate Spoke 68/68+lint+build. Su dictamen es GO de integración
local únicamente; las cifras y verificaciones live siguientes pertenecen al
baseline de producción del 16 de julio y no prueban el candidato.

- Hubs: check, lint, 12 unit tests, build; Hubs/Admin audit de produccion en 0.
- Admin: tests, lint y build.
- Hubs CE: generator y verificador de 44 recursos; audit en 0.
- Reticulum: format, compile warnings-as-errors, 305 tests, 0 fallos, 3 excluidos.
- Bot orchestrator: 22 tests y audit en 0.
- Dialog: lint, 2 tests y audit en 0.
- Photomnemonic: syntax/check, 7 tests y audit en 0.
- Coturn: test de entrypoint.
- Spoke: lint, unit y build con Node 16.13.2/Yarn 1.
- Gitleaks, Actionlint, ShellCheck, SBOM y Trivy.
- Navegador real desktop/movil: sin errores JS/HTTP, escena lista y cinco bots.
- Live: 12 deployments Ready, TLS/DNS/DB/storage/assets/CSP/ghost runner, 0 fallos/avisos.
- GitHub Actions de cierre: Hubs Security `29518981250`, Storybook
  `29518980804`, cloud Security `29520235224`, Services `29520235446`,
  Reticulum `29519815859` y root Security `29519331721`, todos correctos.

Los cambios de auditoria anaden CI de seguridad, healthchecks y correcciones de calidad. No estan desplegados hasta que
se construyan imagenes nuevas por Actions y se renueve GHCR.

## Actualizacion upstream

Ejecutar:

```bash
./scripts/audit-upstream.sh
```

Estado del corte:

- no faltan commits de las releases estables aceptadas;
- `upstream/master` tiene 13 commits Hubs y 5 Hubs CE no publicados;
- los dry merges solo anticipan conflictos en workflows.

No desplegar `upstream/master`. Seguir `docs/development-workflow.md` y preservar
`docs/customization-inventory.md`.

## Deploy correcto

1. checkpoint;
2. rotación coordinada exigida por el addendum y verificación solo por huellas;
3. tests locales;
4. commit/push;
5. GitHub Actions;
6. digest en values local;
7. `npm run gen-hcce` en aislamiento;
8. `kubectl diff` sin imprimir Secrets;
9. `kubectl apply -f hcce.yaml` sin editarlo;
10. rollout;
11. si cambia Hubs, reiniciar Reticulum;
12. carga fria real desktop/mobile, consola y red sin errores ni warnings;
13. `deployment/verify-live-reactivation.sh` con 0/0.

No usar `kubectl set image`, hotpatches, builds in-cluster, `kubectl cp` ni parches manuales como flujo normal.

## Coste y ciclo de vida

Coste base actual aproximado: 62 USD/mes (48 nodo + 12 LB + 2 storage). Escalar deployments a cero no elimina esa
factura. Para alta, congelacion, restauracion o baja de un cliente usar
`deployment/client-instance-lifecycle.md`.

## Orden para continuar

1. Leer `AGENTS.md` y este handoff.
2. Ejecutar `deployment/preflight-reactivation.sh`.
3. Confirmar arboles limpios y ramas base.
4. Crear checkpoint si se va a mutar produccion.
5. Usar una rama por feature o upgrade.
6. Ejecutar los gates y desplegar solo por el metodo estandar.

## Indice

- Operacion: `deployment/README.md`.
- Auditoria: `docs/audit-2026-07.md`.
- Desarrollo/upstream: `docs/development-workflow.md`.
- Personalizaciones: `docs/customization-inventory.md`.
- Evaluacion de avatares: `docs/avatar-provider-evaluation-2026-07.md`.
- Capacidad: `docs/bots-cost-capacity-analysis-2026-07.md` y
  `tests/capacity/README.md`.
- Spoke legacy: `docs/spoke-legacy-audit-2026-07.md`.
- Features: `features/`.
- Archivo historico: `OLD/README.md`.
