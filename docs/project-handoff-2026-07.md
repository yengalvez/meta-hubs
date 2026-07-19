# Handoff de YenHubs - 16 de julio de 2026

Este es el punto de entrada para continuar el proyecto sin depender de una conversacion anterior.

> **Addendum activo — 19 de julio de 2026:** los hashes e imágenes de este
> documento siguen describiendo producción el 16 de julio. El código para
> reservas autoritativas de sitting, autenticación/readiness de bots, carga GLB
> neutral a proveedor, arnés de capacidad y gate de Spoke ya está integrado en
> las ramas base, pero aún no se ha construido ni desplegado como nuevo runtime.
> Durante el trabajo se mostró contenido real del `hcce.yaml` local ignorado al
> registro de la tarea. La exposición no produjo apply ni cambio live. Los
> candidatos se publicaron después en ramas y PR separados. No volver a abrir ni
> imprimir el manifiesto ignorado para inventariar valores. `AUD-075` ya está
> integrado en Cloud `5392495b0772`: separa el parent y un Pod runner por
> sala/generación y endurece su activación y recuperación. El orden vigente es:
> fusionar el tooling de secuencia; integrar `AUD-078`; integrar en PR separados
> el productor Cloud de procedencia/recibos y su consumidor raíz; construir sin
> desplegar Reticulum, parent y runner en un único run; verificar el recibo y
> cuatro bundles contra el gitlink Cloud integrado; checkpoint1; completar
> OLD/NEW y rotar; checkpoint2; candidata bootstrap; recibos
> `bootstrap -> admission -> active`; aceptación live/cold; y promoción. El
> rollout público y la certificación de capacidad siguen bloqueados.

## Estado ejecutivo

En la última aceptación live documentada del 16 de julio, YenHubs estaba
operativo en <https://meta-hubs.org> y el verificador informó 0 fallos y 0
avisos. Ese baseline histórico usa:

- Hubs sobre la release aceptada `prod-2026-03-11`.
- Hubs CE sobre la release aceptada `2.1.0`.
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

| Ruta | Rama base | Fuente candidata auditada | Fuente del runtime live |
| --- | --- | --- | --- |
| Root | `main` | `9f4ada1` (PR raíz `#5` fusionado) | `a0a2b59cad80e0b07f9b2a2f82c2020781163570` |
| `hubs/` | `master` | `674ece41169117a1a842af9cf5d256a10cc43df0` | `a7214eb882d19c98b2c8516489e0ed1fb7401c75` |
| `hubs-cloud/` | `master` | `5392495b077249edcedfb3092551201645f648f1` | `5a82de5387d7296cd01470d5136b2c07c2d5c7ac` |

Hubs `674ece411691` y Cloud `5392495b0772` son los heads finales integrados en
sus ramas `master`; root `main=9f4ada1` fija ambos tras fusionar el PR `#5` con
CI verde. Pasan 128/128 pruebas del orquestador, 30/30 del generador, 430
pruebas Reticulum + 5 properties y los gates raíz normal y `--full`. Ningún
cambio de fuente modifica el runtime hasta construir imágenes por Actions y
desplegarlas por digest.

Estado de publicación comprobado el 18 de julio:

- Hubs PR `#3`: fusionado en `master` como `6f1f5315696c`; Security y Storybook
  post-merge verdes.
- Hubs Cloud PR `#1`: fusionado en `development` como `c5d39e0c930`; PR `#2`
  `development -> master`: fusionado como `2164851185da`, con guard, Security,
  Services, Spoke y Reticulum PostgreSQL 12/14 verdes.
- Hubs PR `#4`: fusionado en `master` como `674ece411691`; 97/97 pruebas,
  Security, Admin build y Storybook verdes.
- Hubs Cloud PR `#3`: fusionado en `development` como `43753e8aea49`; PR `#4`
  `development -> master`: fusionado como `cc70e4023622`, con guard, Security,
  release build y Reticulum PostgreSQL 12/14 verdes.
- Hubs Cloud PR `#5`: fusionado en `development` como `356dce328f9d`; PR `#6`
  `development -> master`: fusionado como `34d1d3a8d3cc`. La prueba de entidades
  espera los ACK, comprueba el conjunto completo y selecciona el PDF por `nid`.
- Hubs Cloud PR `#7`: fusionado en `development` como `04278c69646b`; PR `#8`
  `development -> master`: fusionado como `0f151eb88da1`. El fencing PostgreSQL
  de `AUD-076` pasó PostgreSQL 12/14, Services, Spoke, Security y release build.
- Hubs Cloud PR `#9`: fusionado en `development` como `41cdbe639707`; PR `#10`
  `development -> master`: fusionado como `ca18723fa31b`. Publicó el primer
  corte de aislamiento por Pod de `AUD-075`.
- Hubs Cloud PR `#11`: fusionado en `development` como `ebe960794735`; PR `#12`
  `development -> master`: fusionado como `5392495b0772`. Cerró consumo único
  de generaciones, fencing de recuperación y verificación live ligada al
  manifiesto generado; Security, Services, Spoke, PostgreSQL 12/14 y release
  quedaron verdes.
- Meta-hubs PR minimo `#2`, `codex/gitleaks-policy-bootstrap -> main`: fusionado
  como `f79175d`. La politica ya procede de la base y no de la rama candidata.
- Meta-hubs PR `#1`, `codex/final-audit-readiness -> main`: fusionado como
  `4481e9628b76` después de corregir SC2119, SC2015 y portabilidad GNU/BSD.
- Meta-hubs PR `#5`, `codex/aud075-integration -> main`: fusionado como
  `9f4ada1`; fija Hubs `674ece411691` y Cloud `5392495b0772` sin build ni deploy.

La integración de los subrepositorios y la raíz está cerrada en Git sobre Hubs
`674ece411691`, Hubs Cloud `5392495b0772` y root `main=9f4ada1`. Ninguno de esos
resultados sustituye los valores live de la tabla. No se han construido las dos imágenes
candidatas de `AUD-075`, ni existe checkpoint nuevo o aceptación de staging,
capacidad o producción. No actualizar digests live hasta completar el flujo
publicado de seguridad, build y rollout.

El candidato de bots añade cuatro contratos que tampoco forman parte del runtime
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
- `ret0.bot_config_approvals` conserva candidato y aprobado exactos con
  fingerprint y atribución. La migración desactiva únicamente `bots.enabled`,
  el Admin solo muestra inventario redactado y cada decisión es individual.
  Runtime, chat y registro del runner fallan cerrados ante configuración no
  aprobada o modificada.
- El parent conserva `OPENAI_API_KEY`, la credencial de orquestación y un Role
  namespaced mínimo. Cada sala/generación usa una imagen `bot-runner` separada,
  UID/GID 10001, PID/cgroup, resources, filesystem y ServiceAccount propios, sin
  provider/master-runner/Kubernetes credentials. El token v1 liga solo
  sala/generación/holder/expiry; el lease UUID y epoch PostgreSQL siguen siendo
  obligatorios después del join.

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

El layout vigente añade `deployment-images.json` schema 3 con
`bot_runner_runtime`: `{mode:"process-local",image:null}` para el rollback
legacy o `{mode:"kubernetes-pod",image:"...@sha256:..."}` para el runner
aislado. Checkpoint y restore deben mantener y monitorizar cero Pods dinámicos
gestionados durante toda la quiescencia; el checkpoint histórico anterior no
prueba ese contrato y no sirve para el próximo rollout.

El checkpoint vigente liga antes del downtime snapshots privados `0600` de sus
inputs y consume solo esas copias. Tanto checkpoint como restore reservan la
recuperación autoritativa al driver principal: un error heredado por un
subshell no puede reanudar writers, duplicar el fencing ni liberar el lock.

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
registro no sea público. Antes de desplegar el siguiente candidato:

1. integrar `AUD-078` y los PR Cloud/root de procedencia y recibos;
2. permitir únicamente el build no-deploy conjunto de Reticulum, parent y
   runner, y verificar sus cinco ficheros de evidencia;
3. crear checkpoint1 DB+storage antes de completar OLD;
4. completar OLD/NEW y rotar mediante los runbooks vigentes todos los secretos
   que pudieran figurar en el manifiesto generado, sin copiar valores a tickets,
   chat o shell output;
5. crear checkpoint2 antes de la candidata;
6. mantener `PERMS_KEY` coherente entre Reticulum y Dialog, comprobar hashes,
   filtros `[FILTERED]`, pulls GHCR y paridad de configuración;
7. regenerar en temporal aislado, ejecutar `kubectl diff` sin imprimir Secrets y
   exigir preflight antes de cualquier apply.

## Bloqueos y residuales del candidato de bots

`AUD-075` está integrado en Cloud `5392495b0772`: un Pod endurecido por
sala/generación, imagen y cgroup propios, runner sin provider/master/Kubernetes
credentials, canal autenticado con token v1 y fencing PostgreSQL obligatorio.
El control-plane abarca los namespaces `hcce` y `hcce-bot-runners`, cuota,
ValidatingAdmissionPolicy+binding, RBAC mínimo atestado mediante revisiones
efectivas y ocho NetworkPolicies. El pull Secret es kubelet-only; el parent
conserva OpenAI y la credencial de orquestación. La probe del Deployment usa
`/transport-ready` después de limpiar huérfanos; el gate de bots sigue siendo
`/ready`.

Eso elimina el residual de implementación, pero no acredita el runtime. Faltan
el run conjunto de tres imágenes/digests desde el mismo commit integrado, el
recibo y cuatro bundles verificados, el Secret privado generado, rollout
Reticulum-first, prueba de un Pod exacto por sala y aceptación live. El runtime
`process-local` es el último baseline live aceptado. Si un
rollout candidato vuelve a él como rollback, debe mantener los bots públicos
deshabilitados y no reabrirse ni declararse aceptado de nuevo hasta superar el
preflight, el verificador live y la carga fría vigentes con las credenciales
rotadas; tampoco certifica capacidad.

La evidencia local de fuente no levanta los siguientes bloqueos:

- `AUD-065`: antes de cualquier mutación de producción hay que crear un
  checkpoint fresco de DB+storage y rotar coordinadamente todos los secretos
  potencialmente expuestos, verificándolos solo por presencia o huella. La
  ruta candidata es `deployment/rotate-process-local-credentials.sh` y su
  contrato completo está en `deployment/README.md`; todavía no está fusionada
  ni ejecutada live y no debe sustituirse por un apply o parche manual;
- aislamiento y fencing están integrados y probados en fuente, pero no
  desplegados ni atestados; el baseline live aceptado sigue siendo
  `process-local`, y un rollback a él no puede reabrirse después sin repetir los
  gates actuales ni operar más de una autoridad concurrente;
- la aprobación/cuarentena ya está integrada pero no desplegada: la migración
  debe producir el inventario redactado y cada configuración válida necesita
  una aprobación individual antes de permitir autostart;
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
- Chromium se conserva como comando manual de diagnóstico browser legacy/local,
  sin `--runner`; no forma parte de las imágenes parent/runner productivas, no
  recibe credenciales y nunca cuenta para readiness.
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

El cierre integra Hubs `674ece411691` y Hubs Cloud `5392495b0772` en root
`main=9f4ada1`, con CI de fuentes verde. Las cifras y
verificaciones live históricas pertenecen al baseline de producción del 16 de
julio y no prueban el nuevo runtime.

- Root normal y `--full`: 43 regresiones de seguridad, 239 de recuperación,
  verificador de Pods 45/45, pull/checksum 19/19 y Deployment 18/18.
- Hubs: check, lint, 97 unit tests y build; audit de producción en 0.
- Admin: lint, build y audit de producción en 0.
- Hubs CE: generador 30/30 y manifiesto exacto de 58 recursos repartidos entre
  dos namespaces, con cuota, ValidatingAdmissionPolicy+binding, RBAC efectivo y
  ocho NetworkPolicies.
- Reticulum: format, compile warnings-as-errors, 430 tests + 5 properties,
  0 fallos y 3 excluidos.
- Bot orchestrator: 128/128 tests y audit de producción en 0.
- Dialog: lint, 2 tests y audit en 0.
- Photomnemonic: syntax/check, 7 tests y audit en 0.
- Coturn: test de entrypoint.
- Spoke: 68/68, lint y build con Node 16.13.2/Yarn 1.
- Navegador local: 11 contratos; capacidad: 115/115 con ejecución física
  deliberadamente bloqueada y sin certificación.
- Gitleaks, Actionlint, ShellCheck, SBOM y Trivy.
- GitHub Actions de Cloud: Security, Services, Spoke, Reticulum PostgreSQL
  12/14 y release build verdes tras las promociones `#11` y `#12`.
- Baseline live histórico: navegador real desktop/móvil sin errores JS/HTTP,
  escena lista y cinco bots; 12 deployments Ready, TLS/DNS/DB/storage/assets/CSP
  y ghost runner con 0 fallos/avisos. No acredita el candidato actual.
- GitHub Actions del baseline previo: Hubs Security `29518981250`, Storybook
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

1. finalizar gates, PR/CI y merge de la corrección de secuencia, el completador
   atómico de OLD y el preparador `create`/`verify` de candidata bootstrap;
2. conservar las credenciales NEW en Keychain y todas las OLD válidas;
3. en una rama Cloud separada, implementar, validar y fusionar `AUD-078` sin
   mezclar dependencias ni upstream, y actualizar después el gitlink raíz;
4. integrar en un PR Cloud distinto la procedencia conjunta de tres imágenes,
   la igualdad exacta values/manifiesto y los recibos de fase bajo Lease; después
   integrar en otro PR raíz su consumidor, que mantendrá bloqueados
   `advance`/`promote` sin la cadena autenticada;
5. justo antes del build, actualizar ambos `REGISTRY_PASSWORD` de Actions desde
   el ítem NEW mediante el supervisor trackeado, sin revocar OLD;
6. GitHub Actions: construir Reticulum, parent y runner en un único run desde el
   commit Cloud final derivado del gitlink de un root `main=origin/main` limpio;
   exigir exactamente cinco ficheros distintos —recibo JSON, bundle del recibo
   y bundles OCI Reticulum/parent/runner— y no generar ni aplicar manifiesto. La
   verificación usa un `DOCKER_CONFIG` efímero `0700`, `config.json` `0600`,
   creado desde pull auth privado y eliminado incluso ante error;
7. crear y validar el primer checkpoint conjunto DB+storage;
8. antes del primer `kubectl`, congelar los cinco artefactos ya ligados en un
   snapshot privado owner-only y consumir exclusivamente esa copia; completar
   OLD bajo el Lease global por CAS desde el `Secret/ghcr-pull` live, el
   `ServiceAccount/default` y el `Deployment/bot-orchestrator` ligado por
   UID/resourceVersion/imagen OLD y herencia exacta de ese ServiceAccount sin
   pull-secret override, junto al runner derivado del recibo+bundles,
   donde el runner es solo binding de verificación y no existe argumento de
   digest. Tras el CAS local, permitir rollback solo
   después de renovar y reafirmar el Lease; pérdida de Lease o ACK ambiguo de
   release conserva el completado exacto para reentrada. Después materializar
   NEW por el bridge Keychain conservando todos los workloads live;
9. completar la rotación coordinada, promover la fuente canónica, exigir
   `aud065_rotation_verified`, reconciliar Actions y cerrar las revocaciones;
   el verificador global 0/0 se reserva para el candidato completo;
10. crear y validar un segundo checkpoint conjunto fresco y ligarlo a la
    operación candidata privada;
11. crear/verificar desde la fuente rotada una copia candidata separada,
    derivando del mismo recibo+bundles Reticulum/parent/runner finales, pull NEW
    y `bootstrap`, sin overrides manuales;
12. generar el manifiesto completo de 58 recursos con
   `BOT_RUNNER_ACTIVATION_PHASE=bootstrap`, revisar el diff por la vía redactada
   y ejecutar `npm run apply` con `KUBECTL_CONTEXT` fijado;
13. consumir el recibo bootstrap para avanzar la copia a `admission`, regenerar, revisar el diff y
   ejecutar de nuevo
   `npm run apply`; el wrapper mantiene el parent parado, comprueba la
   ValidatingAdmissionPolicy, atesta RBAC efectivo y exige que el probe no
   autorizado sea denegado antes de conceder autoridad;
14. consumir el recibo admission para avanzar después a `active`, regenerar, revisar el diff y ejecutar
   `npm run apply`; solo esta transición puede levantar el parent después de
   verificar Lease global, ausencia estable de runners y control-plane exacto;
15. no sustituir esas tres transiciones por un `kubectl apply` directo: ante
   error o deriva el wrapper falla cerrado y vuelve a cercar la autoridad;
16. verificar los dos namespaces, cuota, ValidatingAdmissionPolicy+binding,
    RBAC efectivo, ocho NetworkPolicies, `/transport-ready`, `/ready` y
    exactamente un Pod runner por sala;
17. si cambia Hubs, reiniciar Reticulum;
18. carga fria real desktop/mobile, consola y red sin errores ni warnings;
19. `deployment/verify-live-reactivation.sh` con 0/0 y solo entonces, con los
    recibos active/live/cold encadenados, promover por CAS la copia candidata
    `active` a la fuente canónica.

Rollback en orden inverso: cero runner Pods y bots públicos deshabilitados,
parent legacy contra Reticulum compatible, verificar auth privada, y solo
después Reticulum antiguo. El manifiesto viejo no poda los nuevos
ServiceAccounts, Role, RoleBinding, Secret o NetworkPolicy; inventariarlos y
retirarlos mediante una transición trackeada, no con parches manuales.

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
