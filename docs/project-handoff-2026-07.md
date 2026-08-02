# Handoff de YenHubs - 16 de julio de 2026

Este es el punto de entrada para continuar el proyecto sin depender de una conversacion anterior.

> **Addendum activo — 21 de julio de 2026:** los hashes e imágenes de este
> documento siguen describiendo producción el 16 de julio. El código para
> reservas autoritativas de sitting, autenticación/readiness de bots, carga GLB
> neutral a proveedor, arnés de capacidad y gate de Spoke ya está integrado en
> las ramas base, pero aún no se ha construido ni desplegado como nuevo runtime.
> Durante el trabajo se mostró contenido real del `hcce.yaml` local ignorado al
> registro de la tarea. La exposición no produjo apply ni cambio live. Los
> candidatos se publicaron después en ramas y PR separados. No volver a abrir ni
> imprimir el manifiesto ignorado para inventariar valores. `AUD-075` ya está
> integrado en Cloud `5392495b0772`: separa el parent y un Pod runner por
> sala/generación y endurece su activación y recuperación. `AUD-078` ya está
> tuvo su primer corte fusionado en Cloud: PR `#13` en
> `development=0a21634688445eeb2ad2935627ad1c2f7a233f72` y PR `#14` en
> `master=1cf95ca8719b40aa94adc8ffa987cce835316066`, ambos con CI verde. Los PR
> `#15/#16` cerraron después el relevo causal de watches y `#17/#18` añadieron el
> fence de operación; el head Cloud actual es `master=24d09706c2d9`, con CI
> post-merge verde. Hubs está ahora en `master=ce8390a8905f` tras cerrar sin
> allowlist los advisories de Immutable.js. El worktree raíz contiene la
> compatibilidad durable de checkpoint/restore y los gitlinks candidatos;
> recovery 861/861 y el gate normal final pasan, pero full, revisión, PR/CI y
> merge aún están pendientes. Después vendrán
> los PR separados de procedencia/recibos Cloud y consumidor raíz, los builds
> Actions sin deploy de las cuatro imágenes, checkpoint1, OLD/NEW y rotación,
> checkpoint2, staging Reticulum-first/Hubs-second, candidata
> `bootstrap-server -> bootstrap-client -> admission -> active`, aceptación
> live/cold, checkpoint3 durable y promoción. No hubo build, checkpoint, apply, despliegue
> ni mutación de producción; el rollout público y la certificación de capacidad
> siguen bloqueados.

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
| Root | `main` | Base `ed8c9d13fbb`; Fase 3B y gitlink Cloud `24d0970` pendientes de PR raíz | `a0a2b59cad80e0b07f9b2a2f82c2020781163570` |
| `hubs/` | `master` | `ce8390a8905fa38fa0acdb10d5f94290981477ec` | `a7214eb882d19c98b2c8516489e0ed1fb7401c75` |
| `hubs-cloud/` | `master` | `24d09706c2d9302888ce5192de562005c155bd67` | `5a82de5387d7296cd01470d5136b2c07c2d5c7ac` |

Hubs `ce8390a8905f` y Cloud `24d09706c2d9` son los heads actuales de sus ramas
`master`. Root `main=ed8c9d13fbb` todavía fija Cloud `5392495b0772`; solo el
worktree `codex/aud078-root-integration` apunta a los candidatos Hubs
`ce8390a89` y Cloud `24d0970`. Recovery 861/861 y el gate raíz normal final
pasan sobre esos bytes; falta una ejecución `--full`, revisión y PR raíz.
Ningún cambio de fuente modifica el runtime hasta construir
imágenes por Actions y desplegarlas por digest.

Estado de publicación comprobado el 18 de julio:

- Hubs PR `#3`: fusionado en `master` como `6f1f5315696c`; Security y Storybook
  post-merge verdes.
- Hubs Cloud PR `#1`: fusionado en `development` como `c5d39e0c930`; PR `#2`
  `development -> master`: fusionado como `2164851185da`, con guard, Security,
  Services, Spoke y Reticulum PostgreSQL 12/14 verdes.
- Hubs PR `#4`: fusionado en `master` como `674ece411691`; 97/97 pruebas,
  Security, Admin build y Storybook verdes.
- Hubs PR `#5`: corrección Immutable.js fusionada en `master` como
  `ce8390a8905f`; audit de producción 0, 100/100 pruebas, TypeScript, build y
  los tres checks GitHub verdes.
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
- Hubs Cloud PR `#13`: `AUD-078` fusionado en `development` como
  `0a2163468844`; PR `#14` `development -> master`: fusionado como
  `1cf95ca8719b`, con CI verde. La outbox durable ordena config/stop y una parada
  terminal exige la ausencia observada del nombre+UID y cero Pods gestionados
  de la sala.
- Hubs Cloud PR `#15`: relevo causal fusionado en `development=1a370dd6e48d`;
  PR `#16` lo promovió a `master=4c0f7be4a479`, con CI y runs post-merge verdes.
- Hubs Cloud PR `#17`: fence de operación fusionado en `development=2813cc83fb27`;
  PR `#18` lo promovió a `master=24d09706c2d9`. Pasó 30/30 del generador,
  110/110 de apply, dos E2E Kubernetes 1.34.8 y CI post-merge verde.
- Meta-hubs PR minimo `#2`, `codex/gitleaks-policy-bootstrap -> main`: fusionado
  como `f79175d`. La politica ya procede de la base y no de la rama candidata.
- Meta-hubs PR `#1`, `codex/final-audit-readiness -> main`: fusionado como
  `4481e9628b76` después de corregir SC2119, SC2015 y portabilidad GNU/BSD.
- Meta-hubs PR `#5`, `codex/aud075-integration -> main`: fusionado como
  `9f4ada1`; fija Hubs `674ece411691` y Cloud `5392495b0772` sin build ni deploy.
- Meta-hubs PR `#13`: fusionado como `main=ed8c9d13fbb`; registra el cierre del
  tooling AUD-065. Todavía no incluye el gitlink Cloud `24d0970` ni la Fase 3B.

La integración Cloud de `AUD-078` está cerrada en su fork, pero la integración
del superproyecto no: root `main=ed8c9d13fbb` fija Hubs `674ece411691` y todavía
Cloud `5392495b0772`; Hubs `ce8390a89`, Cloud `24d0970` y la compatibilidad de
recuperación son candidatos sin PR raíz. Recovery 861/861 y el gate normal
final pasan; full, revisión y PR/CI siguen pendientes. Ninguno de esos resultados sustituye los valores
live de la tabla. No se han construido las imágenes candidatas, no existe un
checkpoint nuevo y no hubo aceptación de staging, capacidad o producción. No
actualizar digests live hasta completar el flujo publicado de seguridad, build
y rollout.

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

El checkpoint listado arriba es evidencia histórica anterior al layout actual
y no sirve como checkpoint del próximo rollout. El tooling vigente publica
`checkpoint-metadata.json` schema 3, `deployment-images.json` schema 4 y
`runner-cutover-evidence.json` schema 3. `bot_runner_runtime` distingue
`legacy-absent` del runtime `durable-v2` y no permite cruzar generaciones. En
legacy la quiescencia exige ausencia completa de runners y residuos; en durable
exige cero runners ejecutables, cero intents y preserva el conjunto exacto de
fences permanentes ligado al journal firmado. La evidencia durable fija los
contratos normalizados de 2 Namespace, 13 recursos namespaced y cinco pares
policy/binding —10 recursos cluster—; el Secret de pull se liga sólo mediante
HMAC con la clave privada. Schema 3 registra además
`recovery_operation_fence_state` exacto (`dormant` o `active`). Legacy no exige
el quinto par, nunca lo activa y sólo admite semántica `dormant`.

Durante DB, storage, validación y el rehash completo del directorio todavía
marcado como incompleto, dos monitores causales conservan a la vez los cinco
writers a cero y la frontera runner durable. Ambos publican una autoridad JSON
checksummed ligada a PID/start, paths/hashes, operación, lock y Lease; el
`operation_owner` exacto es `checkpoint-backup` o `checkpoint-restore` según el
driver. Sus `READY`, progreso y `FINAL` están tokenizados. Un hijo durable valida
las capabilities del writer padre y del monitor durable padre, además de su
guard local. Un evento transitorio, stream perdido, replay o deriva falla
cerrado; al cerrar se exige `FINAL` durable antes de `FINAL` writer.

Los streams largos de restauración DB/PVC y del backup de storage de sólo
lectura tienen además un supervisor propio. Antes de cada stream exige una
vuelta completa del monitor estrictamente posterior al contador observado;
durante la transferencia acepta sólo progreso monotónico publicado mediante
rename atómico, con frescura máxima productiva de 10 s y sondeo fijo de 1 s. La
Lease se revalida por una lectura con timeout máximo de 5 s, reducido a 1 s
cuando el presupuesto de frescura restante sea de 5 s o menos. Fallo, deriva,
estancamiento, pérdida de Lease o sustitución de PID cancela y recolecta el
grupo exacto usando PID más identidad de arranque. Los overrides de tiempos son
exclusivos de fixtures locales atestadas. Este contrato está implementado en la
fuente Fase 3B, pero sus regresiones finales y gates raíz siguen pendientes.

En un checkpoint durable normal, root cambia por CAS el fence de operación
`dormant -> active` después de probar los cinco writers a cero y lo devuelve a
`dormant` justo antes de reanudar. En restore, PREFLIGHT y PREPARE exigen
`dormant`; el apply Cloud `restore-fence` escala/reconcilia, activa por CAS y
prueba las denegaciones; EXECUTE adopta esa identidad `active` durante streams,
validación y el lock awaiting-reactivation. El apply Cloud `active` vuelve a
`dormant` por CAS y prueba permisos positivos inmediatamente antes de devolver
autoridad; FINALIZE verifica `dormant`. Desde que se arma la escritura PVC hasta
completar su validación exacta, un fallo de stream, validación o reentrada
conserva el helper Pod exacto, su NetworkPolicy deny-all y el lock; también se
retienen ante un `owned` no vacío o inseguro. Sólo el éxito completamente
validado limpia automáticamente helper y policy. `clear-stale` exige un quinto
fence ya dormido; uno activo requiere una recuperación Cloud separada y
revisada.

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

1. terminar pruebas, gates, PR/CI y merge raíz de Fase 3B, fijando Cloud
   `24d09706c2d9`, y después integrar los PR Cloud/root de procedencia y recibos;
2. permitir únicamente los builds no-deploy de Reticulum, parent y runner en un
   run Cloud conjunto, más Hubs en su workflow aprobado, y verificar los cinco
   ficheros Cloud junto con run/commit/digest Hubs;
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

`AUD-075` está integrado desde Cloud `5392495b0772`; el hito histórico
`1cf95ca8719` añadió la outbox de `AUD-078` y el head Cloud actual
`24d09706c2d9` incorpora además los relevos causales y el fence de operación: un
Pod endurecido por
sala/generación, imagen y cgroup propios, runner sin provider/master/Kubernetes
credentials, canal autenticado con token v1 y fencing PostgreSQL obligatorio.
El control-plane abarca los namespaces `hcce` y `hcce-bot-runners`, cuota,
ValidatingAdmissionPolicy+binding, RBAC mínimo atestado mediante revisiones
efectivas y ocho NetworkPolicies. El pull Secret es kubelet-only; el parent
conserva OpenAI y la credencial de orquestación. La probe del Deployment usa
`/transport-ready` después de limpiar huérfanos; el gate de bots sigue siendo
`/ready`.

Eso elimina el residual de implementación, pero no acredita el runtime. Faltan
el run conjunto Cloud de tres imágenes/digests, el build trazable Hubs desde su
gitlink, el recibo y cuatro bundles Cloud más el run/commit/digest Hubs, el Secret
privado generado, staging y rollout Reticulum-first/Hubs-second, publicación
Spoke de `Can be occupied` con identidad estable, prueba de un Pod exacto por
sala y aceptación live. El runtime
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
  contrato completo está en `deployment/README.md`; el tooling ya pertenece a
  root `main`, pero todavía no se ejecutó live y no debe sustituirse por un
  apply o parche manual;
- aislamiento y fencing están integrados y probados en fuente, pero no
  desplegados ni atestados; el baseline live aceptado sigue siendo
  `process-local`, y un rollback a él no puede reabrirse después sin repetir los
  gates actuales ni operar más de una autoridad concurrente;
- la aprobación/cuarentena ya está integrada pero no desplegada: la migración
  debe producir el inventario redactado y cada configuración válida necesita
  una aprobación individual antes de permitir autostart;
- el baseline live todavía trata `room_stop` como best-effort. La fuente Cloud
  `1cf95ca` lo sustituye por outbox transaccional, `runtime_revision`, claims
  recuperables y ACK terminal tras ausencia nombre+UID y cero Pods, pero esa
  corrección no será operativa hasta integrar el PR raíz, construir y desplegar;
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

El último cierre raíz integrado usa Hubs `674ece411691` y Hubs Cloud
`5392495b0772`; root `main` avanzó después hasta `ed8c9d13fbb`. El candidato
usa Hubs `ce8390a8905f` y Cloud `24d09706c2d9`; ya pasa recovery 861/861 y el
gate normal final, pero el full, el gitlink y Fase 3B siguen sin PR raíz. Las cifras y
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
  12/14 y release build verdes tras las promociones `#11`/`#12`; los PR
  `#13`/`#14` de `AUD-078` también quedaron fusionados con CI verde y el foco
  de aplicación pasó 79/79. Los PR `#15/#16` cerraron el watch causal y
  `#17/#18` promovieron el fence a `master=24d09706c2d9`; este último corte pasó
  30/30 del generador, 110/110 de apply, dos E2E Kubernetes 1.34.8 y CI
  post-merge verde. Esto no valida todavía la Fase 3B raíz.
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

1. terminar el gate full, una revisión, PR/CI y merge raíz de Fase 3B, fijando
   Hubs `ce8390a8905f` y Cloud `24d09706c2d9`; no crear aún checkpoint;
2. conservar las credenciales NEW en Keychain y todas las OLD válidas;
3. integrar en un PR Cloud distinto la procedencia conjunta de tres imágenes,
   la igualdad values/manifiesto y los recibos
   `bootstrap-server/bootstrap-client/admission/active`; después integrar en
   otro PR raíz el gitlink Cloud y su consumidor fail-closed, conservando el
   gitlink Hubs ya fijado por Fase 3B;
4. como esos inputs son nuevos, repetir una vez ambos gates raíz y una revisión
   antes del PR/CI/merge; no repetirlos de nuevo sin otra deriva material;
5. justo antes del build, actualizar ambos `REGISTRY_PASSWORD` de Actions desde
   el ítem NEW mediante el supervisor trackeado, sin revocar OLD;
6. GitHub Actions: construir Reticulum, parent y runner en un único run Cloud y
   Hubs en su workflow aprobado desde los commits derivados de un root
   `main=origin/main` limpio; exigir cinco ficheros Cloud distintos y el
   run/commit/digest Hubs. No generar ni aplicar manifiesto. La
   verificación usa un `DOCKER_CONFIG` efímero `0700`, `config.json` `0600`;
7. crear y validar el primer checkpoint conjunto DB+storage;
8. antes del primer `kubectl`, congelar los cinco artefactos Cloud ya ligados en un
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
    derivando Hubs y Reticulum/parent/runner de sus evidencias, pull NEW y
    `bootstrap-server`, sin overrides manuales;
12. preparar staging sin coste DigitalOcean adicional —o detenerse en el cost
    gate—, publicar desde Spoke asientos con `Can be occupied` e identidad
    estable, aplicar Reticulum protocol 2 con Hubs anterior y después Hubs
    candidato, y exigir exactamente un ganador en la carrera de dos navegadores;
13. promover los mismos digests a producción: generar/aplicar
    `bootstrap-server` conservando el Hubs live y, tras su recibo, aplicar
    `bootstrap-client` con Hubs candidato y reiniciar Reticulum para renovar los
    assets cacheados;
14. revisar el inventario AUD-077 y aprobar/rechazar individualmente cada
    fingerprint; consumir el recibo `bootstrap-client` para avanzar a
    `admission`, regenerar/diff/apply y exigir policy, RBAC efectivo y probe
    negativo con el parent parado;
15. consumir el recibo admission para avanzar después a `active`, regenerar,
    revisar el diff y ejecutar `npm run apply`; solo esta transición puede
    levantar el parent después de verificar Lease, ausencia estable de runners
    y control-plane exacto;
16. no sustituir esas transiciones por un `kubectl apply` directo: ante
   error o deriva el wrapper falla cerrado y vuelve a cercar la autoridad;
17. verificar los dos namespaces, cuota, ValidatingAdmissionPolicy+binding,
    RBAC efectivo, ocho NetworkPolicies, `/transport-ready`, `/ready` y
    exactamente un Pod runner por sala;
18. carga fría real desktop/mobile, magic link, español, cámaras, avatares,
    sitting, bots, chat, audio, Admin y Spoke sin errores ni warnings;
19. `deployment/verify-live-reactivation.sh` con 0/0;
20. crear y validar un tercer checkpoint conjunto `durable-v2`, con DB,
    `ret-pvc`, journal/HMAC y una segunda copia cifrada;
21. solo entonces, con los
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
