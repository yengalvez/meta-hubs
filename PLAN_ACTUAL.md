# PLAN ACTUAL — cerrar H5 y volver a features

Version: **v11.14 — CERRADO**
Ultima revision: **27 de agosto de 2026 (Europe/Madrid)**
Autoridad: **este fichero es la única cola ejecutable**. El historial de
intentos vive en `docs/session-changelog.md`; no se reanuda trabajo desde él.

## Resultado final

Demostrar una sola vez que una instancia comercial de YenHubs puede hibernarse,
recrearse y volver a funcionar con su PostgreSQL y sus medios intactos. Cuando
la recuperación, la aceptación live y la integración pasen, H5 termina y el
proyecto vuelve a features.

## Estado actual confirmado

- M1, M2 y M3 están cerrados. No se repite el `--full` ni ninguna sección verde
  cuyas entradas no hayan cambiado.
- El bundle conjunto `output/checkpoints/h5-b16-20260813-022800`, sus dos copias
  cifradas, recibo privado, hashes, 13 imágenes e inventarios están validados.
- La infraestructura autorizada está recreada: contexto `do-ams3-hubs-ce`,
  cluster `hubs-ce`, región `ams3`, Kubernetes `1.34.10-do.1`, HA desactivada,
  un nodo `s-4vcpu-8gb`, LB regional y dos volúmenes de 10 GiB.
- Recaptura live final del 26 de agosto: Namespace UID
  `6020aa74-b369-4484-90f6-a767b1ca566f`, `ret-pvc` UID
  `80f66189-311e-4cc5-a2d1-6eed38d33715` y Bound; writers
  `reticulum/pgbouncer/pgbouncer-t/bot-orchestrator/coturn` a `5/5`, `pgsql`
  `1/1`, un único consumidor legítimo de `ret-pvc` (Reticulum), cero helpers y
  cero policies storage.
- El lock `yenhubs-recovery-operation-lock` está ausente y la Lease UID
  `bc32cd00-c0ba-4252-babd-e8e43dc908c9` está libre. No quedan procesos locales
  de recovery.
- La operación final `1dc5d5c9db33165a08a473dc3cf7afae` validó DB y medios,
  retiró exactamente el orphan `8aa…`, reactivó los cinco writers y completó
  el verificador con **0 fallos y 0 avisos**. Confirmó perfil, 13 imágenes,
  DNS, TLS, DB `356/94/18/33`, medios `33/33`, Reticulum histórico, HTTPS y
  ghost runner activo.

## Decisión de la auditoría

La imagen congelada
`ghcr.io/yengalvez/bot-orchestrator@sha256:325c5c10e4ee039518693771c0974a0e5c876dcf54c443295e84490f4fa8ec53`
es la imagen correcta para este restore histórico y debe seguir coincidiendo con
el bundle, los values privados y el Deployment live.

La imagen moderna publicada por Actions `32827354958` con digest
`sha256:334759ad3611aa68187daf885654abb607d2d11c4ec82b51cda4d20a406625db`
queda aparcada para una migración durable posterior. No puede introducirse sola
en H5: exige ServiceAccount/RBAC, namespace runner, epoch y variables que el
perfil `cold-rebind-legacy-absent-v1` elimina deliberadamente.

La reparación mínima es únicamente de composición: el perfil legacy transforma
readiness a `/health` y conserva liveness `/health`; el perfil durable mantiene
readiness `/transport-ready`. Generador, verificador standalone y contrato
estructural rechazan una mezcla. Las focales afectadas pasan **49/49** y
`git diff --check` pasa.

La auditoría del 26 de agosto corrige además tres supuestos del verificador:

- el API raw entrega un `DeploymentList` tipado cuyos elementos omiten
  `apiVersion/kind`; la autoridad singleton debe validar la lista completa;
- el digest Reticulum histórico fue construido en Cloud `5a82de5`, anterior a
  `/health/capabilities`; durante el restore legacy se valida su `/health/`
  exacto, y protocol 2 queda para el runtime moderno posterior;
- el bot histórico reintenta sincronización cada 30 s; el verificador espera
  hasta 60 s al contrato legacy completo en lugar de aceptar la primera
  respuesta JSON prematura. La DB contiene dos salas configuradas con bots,
  incluida `VJopCY3`.

Las correcciones son solo de aceptación y pasan `security-gates` **58/58**,
Bash, ShellCheck, `git diff --check` y una prueba contra el `DeploymentList`
raw real. No cambian imágenes, datos, topología ni seguridad del restore.

La evidencia de `8aa…` aisló además una incompatibilidad de composición real:
el manifiesto live entrega al bot histórico
`RET_INTERNAL_ACCESS_HEADER=x-ret-bot-orchestrator-access-key`, pero el código
congelado `5a82de5` autentica `/api-internal` mediante
`x-ret-dashboard-access-key`. Por eso la sincronización recibe `401`, no activa
ninguna sala y el runner nunca puede cumplir readiness. El perfil legacy, sus
dos verificadores, su regresión de generador y el gate live exigen ya el
encabezado histórico; `test:generator` pasa **32/32** y `security-gates`
**58/58**, más Bash, ShellCheck y `git diff --check`. No se cambia la credencial,
la imagen ni el protocolo: únicamente el nombre de header compatible con esos
bytes históricos.

## Cola ejecutable

### M4. Una recuperación productiva final

- [x] Auditar source, bundle, plan, worktrees, estado live y reglas anti-loop.
- [x] Corregir solo el contrato de probe del perfil legacy y validar las tres
  focales afectadas; no ejecutar otro `--full`.
- [x] Confirmar en read-only el Lease de serialización, la imagen/probe del
  Deployment live y que las identidades y el estado fail-closed siguen siendo
  exactamente los anteriores. Resultado: Lease libre; digest histórico exacto;
  readiness live todavía `/transport-ready` y liveness `/health`; identidades,
  writers, PVC y consumidores coinciden.
- [x] Limpiar únicamente el lock stale exacto mediante la confirmación completa
  del supervisor. El cleanup es condicional a la recaptura; no se leen
  anotaciones ni valores privados. Resultado: helper/policy propios y lock
  exacto retirados; ningún workload se reanudó.
- [x] Regenerar desde `output/private-h5-b4/input-values.freeze-20260812.yaml`
  con `HCCE_TARGET_PROFILE=cold-rebind-legacy-absent-v1`. Verificar el
  manifiesto sin abrirlo ni imprimir Secrets; comprobar por inventario redactado
  que conserva el digest histórico y usa readiness/liveness `/health` solo para
  `bot-orchestrator` legacy. Resultado: 44 recursos verificados, fichero `0600`,
  digest histórico exacto, writers cero y probes `/health`/`/health`.
- [x] Revisar el `kubectl diff` redactado y aplicar únicamente por el wrapper
  protegido `npm run apply`. Los cinco writers deben permanecer a cero y no se
  cambia topología, coste, DNS, certificados, PVC ni imágenes del checkpoint.
  El diff fue solo `/transport-ready` a `/health`. El wrapper aplicó ese cambio
  y después agotó su espera por un reset TCP del API al normalizar el último
  Deployment; no se repitió. Una comprobación read-only posterior confirmó los
  doce Deployments exactos, Lease libre, bot `/health` y writers todavía cero.
- [x] Repetir una sola vez el preflight cold-rebind DB+medios sobre el mismo
  bundle, recibo, Namespace y PVC. Resultado: PASS read-only; bundle y recibo
  rehasheados, target exacto y vacío, writers cero y bytes invariantes.
- [x] Ejecutar la operación causal `3b905ea22b1235e90df885469e1e3d18`.
  Se detuvo antes del stream DB con
  `database_restore_stream_stage:launch` / `lease-window:0:2838`. El rollback
  dejó writers cero, `pgsql=1`, cero consumidores/helpers/policies y retuvo
  lock y Lease. No se repitió producción.
- [x] Preparar un candidato para esa causa: si todas las guardas avanzaron pero
  no coinciden en una ventana suficiente para Lease y cancelación, la guarda
  con menor margen obtiene otro barrido dentro del plazo inicial de 30 s. La
  frescura productiva continúa en 10 s y ningún hijo destructivo existe durante
  la realineación. La regresión exacta y el foco pasan **50/50**, además de
  Bash, ShellCheck y `git diff --check`. **No queda aceptado live:** la operación
  posterior cruzó el stream DB pero falló en `post-audit`; el refuerzo de esa
  frontera pasó la focal, pero otro intento volvió a fallar la misma clase de
  alineación en otra guarda.
- [x] Limpiar de forma supervisada el lock y la Lease retenidos, recapturar y
  repetir el preflight sin reabrir bloques verdes. Resultado anterior al último
  intento: Lease libre, lock ausente y preflight PASS.
- [x] Ejecutar `a31b9c5671049404da5f4d33a61c2b1a`: cruzó el stream DB y
  se detuvo en `database-stream/post-audit`, sin subdetalle. Rollback seguro.
- [x] Añadir post-audit explícito, puerta aislada previa a la alineación y
  diagnóstico de Lease; focal **50/50**, Bash, ShellCheck y diff PASS.
- [x] Ejecutar `d719176b220c65711c37869184a5c80d`: volvió a fallar antes
  del stream en `refresh/lease-window:1:3536`. Es la misma clase de fallo en
  otra guarda; rollback seguro con Lease libre, lock retenido, writers cero y
  sin consumidor/helper/policy.
- [x] **STOP anti-loop resuelto localmente:** la capacidad firmada del monitor
  de escritores ya valida en cada ronda la Lease, el lock y las identidades de
  esta operación. El supervisor deja de repetir un segundo GET síncrono de
  Lease cuando esa capacidad exacta está presente; deriva el margen de inicio
  solo de las capacidades que aún deben ejecutarse y conserva intactos los
  diez segundos de frescura y los dos segundos de cancelación. La focal pasa
  **92/92**, incluida una regresión que hace fallar cualquier Lease directo;
  Bash, ShellCheck y `git diff --check` pasan. No es todavía evidencia live.
- [x] Recapturar, limpiar el lock exacto y pasar preflight. La operación
  `51f5f9bb49f0cd473ba60d06caca4ce4` restauró y validó DB, retiró el orphan
  exacto de `33` pares de `7311bb41b28765341d8993a91375c8f2` y restauró y
  validó los medios. El coordinador superó por tanto la frontera de guardas.
  Falló después, en aceptación, porque el verificador hijo perdió
  `RECOVERY_CHECKPOINT_RUNNER_GENERATION=legacy-absent` al volver a cargar la
  librería de seguridad. Rollback seguro: writers cero, `pgsql=1`, Lease libre,
  lock retenido y cero consumidores/helpers/policies.
- [x] Corregir esa frontera: el verificador conserva el input inmutable antes
  de cargar la librería y lo restaura después; no conserva capacidades de
  cleanup o señalización. La regresión estructural y `security-gates` pasan
  **58/58**, junto con Bash, ShellCheck y `git diff --check`.
- [x] Recapturar metadata y estado, limpiar el lock exacto y repetir el
  preflight. La operación nueva fue `22ec832b72ba151b6cbef155ec1e2e94`.
- [x] Ejecutar esa única recuperación coordinada con el orphan exacto de
  `51f5f9bb49f0cd473ba60d06caca4ce4`: DB y medios pasaron, los cinco writers
  reanudaron en orden y Reticulum llegó a `Ready`; la aceptación externa falló
  después y activó rollback seguro.
- [x] Diagnosticar sin repetir: la sonda de sitting hacía port-forward al puerto
  TLS `4000` y lo consultaba como HTTP, mientras Reticulum, el Service y la
  arquitectura documentada usan HTTP interno `4001`. Corregir verificador y su
  gate estructural únicamente; Bash, ShellCheck, gate dirigido y diff deben
  pasar antes de otra acción live.
- [x] Recapturar el rollback exacto, limpiar solo el lock y pasar el preflight.
  Resultado: target exacto, vacío y byte-invariante; operación nueva
  `dbd20994714ea8eb532f12803729269b`.
- [x] Ejecutar esa recuperación con orphan source `22ec…`: datos y reanudación
  pasaron; aceptación falló por los tres supuestos legacy descritos arriba y el
  rollback quedó seguro.
- [x] Corregir solo esas tres causas y validar el foco: `58/58`, Bash,
  ShellCheck, diff y `DeploymentList` raw real pasan. No se ejecuta `--full`.
- [x] Recapturar el rollback, limpiar solo el lock exacto y pasar el mismo
  preflight una vez; no cambiar bytes de producto, imágenes, datos o topología.
- [x] Ejecutar `8aa49fb2d35e2d0189dd3931d59b5a5d` con orphan source `dbd…`.
  DB, medios, reanudación, perfil, imágenes, DNS, TLS, recursos, PostgreSQL,
  `ret-pvc`, Reticulum histórico y HTTPS pasaron. El runner ghost no activó
  salas; rollback seguro con escritores cero, Lease libre, mismo Namespace/PVC,
  cero consumidores/helpers/policies y lock nuevo retenido.
- [x] Diagnosticar esa única firma: el bot histórico enviaba el header moderno
  que Reticulum histórico no reconoce y sincronizaba con `401`. Corregir solo
  la composición legacy y sus contratos; generador **32/32**, security-gates
  **58/58**, Bash, ShellCheck y diff pasan.
- [x] Limpiar condicionalmente solo el lock exacto `bca29da4…`, regenerar desde
  los mismos values con el mismo perfil y revisar/aplicar por el wrapper
  protegido únicamente el cambio de header. Resultado: 44 recursos y 12
  Deployments exactos, header histórico live, writers cero durante el cambio;
  no cambiaron imágenes, credenciales, datos, topología ni coste. El wrapper
  agotó su bucle de observación, pero el readback server-normalized posterior
  probó los 12 Deployments exactos; no se repitió el apply.
- [x] Recapturar el estado posterior y pasar el mismo preflight una vez.
  Resultado: PASS read-only y bundle byte-invariante.
- [x] Ejecutar la última recuperación con operación
  `1dc5d5c9db33165a08a473dc3cf7afae` y orphan source `8aa…`. Resultado: DB,
  medios, reanudación y verificador live completos con 0 fallos/avisos; lock
  ausente, Lease libre, writers `5/5`, `pgsql=1`, cero helpers/policies/procesos.
- [x] La rama de fallo final no se activó: la operación terminó en verde. Se
  conserva como regla que no existe reintento automático ni segunda hipótesis
  sin evidencia causal nueva.

**M4: DONE.** DB y medios se validaron conjuntamente, los writers se reactivaron
en el orden protegido, el lock se liberó y no quedan helper, policy, Lease
ocupada ni procesos residuales.

### M5. Aceptación comercial e integración

- [x] Ejecutar `./deployment/verify-live-reactivation.sh`: resultado final con
  cero fallos y cero avisos, conjunto activo coherente y `33/33` pares físicos.
- [x] En navegador interno con sesión fría comprobar carga sin excepciones
  first-party, español, login, sala `VJopCY3`, escena y medios. `APP`, `AFRAME`,
  escena y cinco bots inicializaron correctamente.
- [x] Probar escritorio y móvil, primera y tercera persona y sitting histórico;
  comprobar además el catálogo de nueve avatares y sus thumbnails.
- [x] Completar solo la aceptación humana que no puede inferirse del mismo
  perfil autenticado. La selección real del avatar neutral `base` pasó y la UI
  confirmó `Tu avatar ha sido cambiado`. Después la sala mostró `Personas (2)`,
  el micrófono local pasó por `Hablando`, el propietario confirmó audio en ambos
  sentidos y se volvió a dejar `Silenciado`. La exclusividad protocol 2
  pertenece al runtime moderno pendiente y no se falsifica en la imagen
  restaurada `5a82de5`.
- [x] Probar Admin y propiedad/edición en Spoke del proyecto `qa3U3Ke` y escena
  `f6VKtim`.
- [x] Para el perfil histórico, comprobar `/health`, runner ghost activo, cinco
  bots presentes y navegación con el navmesh publicado.
- [x] Enviar un único mensaje inocuo en el chat privado del bot y comprobar su
  respuesta. `bot-2` respondió `¡Hola! ¿En qué puedo ayudarte hoy?`; la UI
  mostró que la conversación es privada y temporal y el aviso de procesamiento
  por OpenAI. No se exige `/transport-ready`, propio del runtime durable.
- [x] Ejecutar únicamente las secciones invalidadas por los bytes finales, sin
  `--full`: `recovery` **894/894**, `h5` **174/174**, `hcce`, `composition`,
  `advisories`, `static`, `security` y `reticulum` tienen PASS. Tras integrar
  Cloud y renovar solo `static`/`security`, `--finalize` confirmó los dos
  gitlinks y todos los recibos exactos. El falso positivo `SC2317` del runner
  sobre el callback de `trap EXIT` se acotó solo en el workflow y solo para esa
  biblioteca, sin invalidar recovery ni H5.
- [x] Integrar primero el commit de `hubs-cloud`, después el gitlink y los
  cambios raíz, siguiendo `docs/development-workflow.md`. Cloud ya está en
  `master` como `6d9ee9e998f636fcf61a4928cd2a275829768259`; el PR raíz #18
  permaneció abierto durante la estabilización. El run `33021997403` sobre `63c4509` terminó con
  PostgreSQL verde y solo los positivos DB `553/554` rojos. La causa local
  quedó aislada: el supervisor repetía auditorías completas ya acreditadas por
  tres monitores y el caso positivo durable duplicaba además la espera
  ``en vuelo`` que ya cubren los casos legacy/negativos. El candidato local
  conserva una validación completa antes de abrir, observa durante el stream
  proceso/fallo/autoridad/progreso/caducidad, reserva continuidad y cancelación,
  y separa la integración durable positiva de la prueba específica en vuelo.
  El foco positivo exacto pasa **47/47**; la regresión de coordinación pasa
  **50/50** y la matriz de aborto del monitor PostgreSQL pasa **63/63**.
  ShellCheck sobre los tres scripts modificados, gitlinks, diff-check y
  Gitleaks también están verdes. El CI `33048676041` sobre `0b38b0d` conservó
  esos gates y PostgreSQL verdes, pero reveló siete regresiones del supervisor:
  una reserva local de 1 s hacía imposible una ventana estricta de 3 s y los
  diagnósticos ligeros habían cambiado de nombre. La corrección no amplía
  plazos: la observación local queda dentro de la reserva de cancelación ya
  existente y reutiliza los diagnósticos públicos anteriores. Los dos focos
  exactos pasan **92/92** y **53/53**. El commit correctivo `370d078` pasó el
  único CI final `33073636287`: PostgreSQL 12.19/14.23, gitlinks, Gitleaks,
  Actionlint, ShellCheck y recovery **894/894**. La PR raíz #18 se fusionó en
  `main` como `feee36b9f3e226463192737d40848b56ec707d92`; sus gitlinks fijan
  Hubs `ce8390a8905fa38fa0acdb10d5f94290981477ec` y Cloud
  `6d9ee9e998f636fcf61a4928cd2a275829768259`. Estado: **DONE**.
- [x] Actualizar `docs/estado-sencillo.md` y `docs/session-changelog.md` después
  del merge real y declarar H5 cerrado. Estado: **DONE**; el siguiente trabajo
  es features.

## Reglas anti-loop y parada

1. Un PASS se reutiliza mientras sus bytes, toolchain y dependencias no cambien.
2. Un FAIL solo puede repetirse después de identificar una causa nueva y cambiar
   exactamente la superficie responsable.
3. No se crea otro checkpoint, otra copia cifrada, otra topología ni otra
   arquitectura de recovery para cerrar H5.
4. No se despliega la imagen durable nueva dentro del restore histórico.
5. No se abren ni imprimen values, manifiestos generados, Secret bodies,
   anotaciones o tokens del lock.
6. Solo se para ante divergencia del target, estado/Lease/lock ambiguo,
   exposición de secreto, pérdida del estado fail-closed, coste/topología no
   previsto o un fallo grave que requiera investigación superior.
7. El cierre lo demuestran el restore, el verificador live, el navegador y la
   integración; no la cantidad de tests ejecutados.

## Confianza operativa

**Alta y cerrada para H5.** La operación final demostró DB,
medios, reanudación, infraestructura, HTTPS y ghost runner con cero
fallos/avisos y cierre limpio; la batería final pasó 894/894. Ya no queda otro
restore. La aceptación humana completa está demostrada: avatar neutral, chat
privado y dos participantes con audio bidireccional. Cloud y los dos gitlinks
están integrados; el CI final y el merge raíz son verdes y verificables. **H5
está funcional y técnicamente cerrado; la siguiente cola corresponde a
features.**
