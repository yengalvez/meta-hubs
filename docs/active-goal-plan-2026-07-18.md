# Meta activa de YenHubs: cierre seguro y runtime endurecido

Última actualización: 2 de agosto de 2026

Estado actual: **EN EJECUCIÓN; el PR raíz `#14` fusionó `78b7165` como
`main=9c1b85be99a7` y el checkout canónico está sincronizado. El commit
`d303d3e` del PR borrador `#15` amplió correctamente el timeout a 360 minutos y
deduplicó push+PR. Su único run `30731785217` terminó recovery con `845/864`:
los 19 fallos son cascadas de una sola incompatibilidad Linux demostrada. La
función de comparación de imágenes pasaba un JSON live de 214.796 bytes a
`jq --argjson`; Linux limita un argumento a unos 128 KiB y devolvió `Argument
list too long`, mientras macOS lo aceptaba. La corrección local conserva la
misma comparación, pero hace que `jq` lea el JSON desde un fichero `0600` bajo
la raíz temporal privada y lo elimina tanto al aceptar como al rechazar el
inventario. La reproducción match/mismatch bajo un límite Linux simulado pasa
con cleanup exacto; el foco end-to-end durable pasa `50/50` bajo ese mismo
límite, y Actionlint, Bash, ShellCheck, los 51 gates de seguridad, gitlinks,
diff-check y Gitleaks 9,09 MB están verdes. Falta publicar el commit en el mismo
PR y exigir un único CI verde. Producción permanece intacta.**

Punto exacto de reanudación: publicar la única corrección portable ya validada
en el PR `#15` y esperar el gate que dispare el push; no relanzarlo manualmente
ni repetir el full local. Si el gate queda verde, marcar el PR listo, fusionarlo
y cerrar la Fase 3B. Si falla, corregir solo la nueva causa exacta. No se avanza
a Fase 4 antes del verde.
Después continuar con build, checkpoints, rotación, staging, rollout y
aceptación live, sin añadir funciones nuevas.

Worktree inicial: `/Users/Shared/Gits/YenHubs-aud075-root`

Rama inicial: `codex/aud075-integration`

Worktree activo: `/Users/Shared/Gits/YenHubs`

Última rama de desbloqueo fusionada: `codex/aud065-sequencing-unblock`

Este fichero exacto del worktree activo es la única fuente de verdad operativa:
`/Users/Shared/Gits/YenHubs/docs/active-goal-plan-2026-07-18.md`.
Los worktrees `aud075`, `aud076` y `aud077` son evidencia histórica y nunca se
usan para reanudar. El worktree `aud078` conserva evidencia local previa al
traslado, pero tampoco vuelve a usarse para reanudar.

Panel humano obligatorio:
`/Users/Shared/Gits/YenHubs/docs/estado-sencillo.md`. Debe
actualizarse antes de pasar a una acción distinta, después de cada hito real y
siempre que cambie la acción actual, manteniendo casillas y lenguaje sencillo
coherentes con este plan técnico. Esta obligación forma parte de la meta porque
la meta ordena seguir este documento. Si hubiera una discrepancia, este plan
gobierna la ejecución y ambos documentos se sincronizan antes de continuar.

El historial de sesión y las cuentas completas de pruebas se conservan exclusivamente en
`docs/session-changelog.md`. `docs/completion-plan-2026-07-18.md` es solo una
referencia consolidada anterior y no debe utilizarse para ampliar el alcance de
esta meta.

## Panel operativo vigente

- Fase activa: **3B, integración raíz final**.
- Primera acción al reanudar: publicar en el mismo PR `#15` la lectura por
  fichero privado ya validada que elimina el `ARG_MAX` Linux del run
  `30731785217`; después exigir un único gate completo verde. No abrir otra
  ronda general de dependencias, diseño o auditoría.
- El último full sobre Cloud `master=c540c292` confirmó recovery `861/861`,
  incluido el caso 850, y todos los bloques anteriores; falló únicamente en el
  `mix hex.audit` final por cuatro advisories nuevos de Guardian `2.4.0`.
- Guardian `2.4.1` ya está validado e integrado mediante los PR `#21`/`#22` en
  Cloud `master=c0a3419b`; el gitlink, los controles proporcionales y la única
  revisión final están cerrados. El PR raíz `#14` está fusionado. El timeout CI
  ya está resuelto y el gate posterior reveló una única incompatibilidad
  `ARG_MAX` en la comparación local de inventarios; esa es la única superficie
  abierta antes de Fase 4.
- Camino crítico posterior: (1) integrar la procedencia de Cloud y su
  consumidor raíz; (2) construir por Actions cuatro imágenes trazables —Hubs,
  Reticulum, parent y runner—; (3) checkpoint 1, rotación y checkpoint 2;
  (4) staging server-first y rollout producción con los mismos digests; (5)
  aceptación live, checkpoint 3 y cierre documental.
- Las casillas de «Definición de terminado» son resultados de auditoría, no un
  selector de orden. Los párrafos cronológicos y hashes supersedidos son
  evidencia, no acciones. Solo mandan las casillas de la fase activa.
- Las prohibiciones fail-closed son guardarraíles, no trabajo adicional. Una
  repetición solo procede si cambian código, workflow, gitlinks, values,
  commits, digests, inventario, DB/storage o el TTL del checkpoint.

## Meta

Cerrar de forma segura la campaña actual de YenHubs conservando el servicio que
ya funciona, integrando y desplegando el runtime endurecido de sitting y bots,
rotando las credenciales potencialmente expuestas y demostrando el resultado en
producción mediante los verificadores y un navegador frío.

El resultado visible debe seguir siendo el mismo YenHubs funcional. La mejora
buscada es interna: autoridad única, runners aislados, parada terminal, rollback
completo y despliegues fail-closed.

## Alcance obligatorio

- Cerrar la integración raíz ya validada de `AUD-075`.
- Crear un checkpoint completo de PostgreSQL y `ret-pvc`.
- Cerrar `AUD-065` mediante rotación coordinada y verificación por huellas, sin
  mostrar secretos.
- Implementar `AUD-078` en una rama separada y conservar `AUD-076`/`AUD-077`.
- Construir por GitHub Actions las imágenes necesarias y fijarlas por digest.
- Desplegar Reticulum compatible y después el control plane de runners mediante
  `bootstrap -> admission -> active` y el wrapper aprobado.
- Mantener Reticulum en una réplica, estrategia `Recreate` y sin HPA.
- Aceptar sitting, bots, chat, privacidad, backup/restore y carga fría real.
- Dejar ramas base, punteros de submódulos, documentación y evidencias coherentes.
- Conservar el mecanismo update-friendly: releases estables como baseline,
  auditoría upstream de solo lectura, inventario de personalizaciones, gates por
  contrato y rollback documentado.

## Fuera de esta meta

Estos trabajos pertenecen a campañas futuras y **no bloquean el cierre**:

- certificar 30, 100, 300 o 10.000 usuarios mediante carga física;
- ejecutar carga destructiva o de alta concurrencia en producción;
- convertir Reticulum en multi-réplica o añadir HPA/control-plane HA;
- modernizar completamente Spoke, Node, React, Webpack, Three.js o Recast;
- ejecutar `npm audit fix --force` o una actualización masiva de dependencias;
- fusionar `upstream/master` o incorporar una nueva release estable dentro de
  esta misma campaña;
- contratar o integrar un SaaS nuevo de avatares;
- probar VR físico, obtener ZDR o realizar una revisión legal completa;
- modernizaciones de infraestructura que no sean necesarias para este rollout.

Si aparece una nueva release upstream durante la ejecución, se registra mediante
`scripts/audit-upstream.sh` y se difiere a una rama propia, salvo que exista un
bloqueo crítico demostrado. No se absorbe silenciosamente en esta meta.

## Estado de partida histórico confirmado

Este bloque describe el baseline con el que comenzó la campaña; no sustituye el
estado vigente del panel superior.

- [x] El baseline anterior de producción estaba operativo en la última
  aceptación documentada; el candidato nuevo todavía no se ha desplegado.
- [x] Hubs está integrado en `674ece41169117a1a842af9cf5d256a10cc43df0`.
- [x] Hubs Cloud está integrado en
  `5392495b077249edcedfb3092551201645f648f1`.
- [x] Los PR Cloud `#11` y `#12` de `AUD-075` están fusionados y su CI está
  verde.
- [x] Los gates raíz normal y completo pasaron sobre esos commits finales.
- [x] `AUD-076` (lease/epoch PostgreSQL) y `AUD-077`
  (aprobación/cuarentena) están integrados en fuente.
- [x] El diseño de `AUD-078` está auditado y su candidato fuente está publicado
  como Cloud `a3b7396`; 79/79 pruebas de aplicación y revisión independiente
  están verdes. El PR `#13` está fusionado en
  `development=0a21634688445eeb2ad2935627ad1c2f7a233f72` y la
  promoción separada PR `#14` terminó con CI verde en `master=1cf95ca`. Las
  correcciones causales posteriores y el fence de operación se fusionaron por
  los PR `#15`–`#18`; el head Cloud actual es `master=24d09706c2d9` y sus runs
  post-merge están verdes.
- [x] No se ha construido ni desplegado el nuevo runtime y producción no fue
  mutada por `AUD-075`.

## Definición de terminado

La meta solo puede marcarse completa cuando se cumpla todo lo siguiente:

- [ ] `AUD-075` y `AUD-078` pertenecen a las ramas base correspondientes y el
  root `main` fija exactamente esos commits.
- [ ] El productor Cloud de procedencia/recibos y su consumidor raíz están
  fusionados; un root `main=origin/main` limpio fija el commit Cloud exacto que
  construyó Reticulum, parent y runner.
- [ ] Existen los tres checkpoints conjuntos exigidos: uno antes de la rotación,
  otro después de ella y antes del rollout, y un tercero posterior a `P6` que
  liga el journal durable; todos son frescos, verificables y restaurables con DB
  y storage.
- [ ] Las credenciales afectadas por `AUD-065` fueron rotadas; las anteriores
  están revocadas o rechazadas cuando exista una comprobación segura.
- [ ] Reticulum, parent y runner proceden del mismo commit y del mismo run Cloud
  atestado, fueron construidos por Actions y se ejecutan mediante digests
  inmutables.
- [ ] Hubs procede del commit exacto fijado por el gitlink raíz, fue construido
  por el workflow Actions aprobado y queda ligado a run, commit y digest
  inmutable; el mismo digest aceptado en staging se ejecuta en producción.
- [ ] El recibo JSON canónico, su bundle de atestación y los tres bundles OCI de
  Reticulum, parent y runner —cinco ficheros distintos en total— están
  conservados y verificados sin overrides de commit o digest.
- [ ] Producción usa el protocolo compatible de sitting, fencing DB,
  aprobación/cuarentena, Pods runner aislados y parada terminal de `AUD-078`.
- [ ] Un staging aislado demuestra primero Reticulum protocol 2 con el Hubs
  anterior y después el Hubs protocol 2; la escena publicada tiene
  `Disable motion`, `Can be occupied`, `Clickable` e identidad estable, y la
  carrera de dos navegadores produce exactamente un ganador antes de promover
  los mismos digests a producción.
- [ ] `verify-live-reactivation.sh` termina con cero fallos y cero avisos.
- [ ] Una carga fría desktop y móvil demuestra `APP`, `AFRAME`, escena, audio,
  español, cámara primera/tercera persona, avatares, sitting, bots y chat sin
  errores ni respuestas anómalas.
- [ ] Los logs revisados no contienen secretos, prompts ni mensajes completos.
- [ ] Existe rollback documentado hacia los digests anteriores y el checkpoint.
- [ ] El rollback usa las credenciales nuevas y nunca restaura o reactiva valores
  revocados o potencialmente comprometidos.
- [ ] La documentación distingue fuente integrada, imagen construida, runtime
  desplegado y aceptación live.
- [ ] `scripts/audit-upstream.sh` está registrado sobre los commits finales y
  `docs/customization-inventory.md`/`docs/development-workflow.md` reflejan los
  baselines, contratos, tests, conflictos previsibles y rollback finales.
- [ ] El root `main` queda limpio y los submódulos apuntan a commits de sus
  ramas base.

## Orden de ejecución

No se salta una fase. Dentro de cada fase se trabaja desde la primera casilla
pendiente.

### Fase 1 — cerrar la integración raíz de `AUD-075`

- [x] Confirmar el estado conservado con `git status`, ramas, remotos y
  submódulos, sin limpiar ni sobrescribir cambios existentes.
- [x] Completar la coherencia de runbooks y documentos activos de `AUD-075`.
- [x] Eliminar referencias activas obsoletas, preservando entradas históricas;
  corregir especialmente cualquier orden que permita desplegar antes de
  checkpoint+rotación, además de conteos antiguos de recursos/policies y el
  rollout anterior de dos fases. La excepción posterior de build sin deploy,
  necesaria para obtener el primer digest runner, debe quedar versionada y
  fail-closed antes de utilizarse.
- [x] Revisar el diff raíz completo y confirmar que no contiene trabajo ajeno.
- [x] Ejecutar solo las validaciones afectadas por los últimos cambios; no
  repetir gates verdes cuyos inputs no cambiaron.
- [x] Ejecutar `git diff --check`, ShellCheck/Gitleaks pertinentes y revisión de
  secretos antes del commit.
- [x] Commit, push y PR raíz desde `codex/aud075-integration` hacia `main`.
- [x] Incluir este plan activo en el PR y conservar su ruta relativa
  `docs/active-goal-plan-2026-07-18.md` como fuente de verdad versionada.
- [x] Esperar el CI, corregir fallos reales y fusionar el PR.
- [x] Confirmar que `main` fija Hubs y Cloud a commits existentes en sus ramas
  base.

Resultado: el código, los gates, los scripts de recuperación y la documentación
de `AUD-075` quedan integrados, todavía sin cambiar el runtime live.

### Fase 2 — preparar el cierre de `AUD-065` sin mutar producción

#### Fase 2A — completar primero el tooling de rotación

- [x] Crear una rama raíz propia `codex/aud065-process-local-rotation` desde el
  `main` resultante de la Fase 1; no mezclar imágenes, dependencias, upstream,
  `AUD-075`, `AUD-078` ni otra modernización.
- [x] Implementar un coordinador trackeado y context-pinned que rote únicamente
  el baseline `process-local` y los mismos digests live, sin usar el apply
  histórico desnudo ni introducir recursos candidatos de `AUD-075`.
- [x] Implementar la transición segura de `DB_PASS` en el rol PostgreSQL
  persistente, con rollback mediante la credencial nueva y prueba de rechazo de
  la anterior; actualizar solo el Secret no cuenta como rotación de la base.
  La transición debe cerrar por CAS el `NetworkPolicy/pgsql-ingress` existente,
  demostrar el cierre con un probe real, eliminar sesiones cliente residuales y
  usar exclusivamente el socket Unix del pod PostgreSQL para el cambio.
- [x] Añadir verificación de paridad de `PERMS_KEY` entre Reticulum y Dialog
  únicamente por huella, sin imprimir el valor.
- [x] Añadir un diff de rollout redactado: `Secret/configs` únicamente por
  presencia y comprobaciones privadas; nunca enviar `data`, `stringData`,
  huellas directas ni anotaciones derivadas a la salida diagnóstica.
  `ConfigMap/ret-config` pertenece al baseline ordinario, contiene marcadores
  como `<DB_PASS>` y `<PERMS_KEY>` —no credenciales renderizadas— y debe quedar
  byte-invariante; encontrar allí un valor renderizado bloquea la operación.
- [x] Ampliar la misma operación para rotar por UID/resourceVersion CAS el
  `Secret/ghcr-pull` histórico desde el nuevo pull config privado, y ligar como
  invariante `ServiceAccount/default` con exactamente ese `imagePullSecret`.
  Los 42 recursos generados, los 13 digests y el modo `process-local` permanecen
  intactos; `bot-images-pull` continúa siendo exclusivo del candidato
  `AUD-075`. El auditor no puede declarar éxito si sobrevive el pull Secret
  antiguo o si `ServiceAccount/default` deja de conservar exactamente la
  referencia a `ghcr-pull`. Antes de adquirir el lock o hacer cualquier CAS,
  `plan` y cada entrada de ejecución/recuperación deben demostrar
  por red que las credenciales GHCR antigua y nueva pueden leer todos los
  digests GHCR fijados del baseline más el runner; un timeout, 5xx o permiso
  denegado no cuenta como aceptación.
- [x] Cubrir coordinador, fallo parcial, rollback y redacción con fixtures; pasar
  los gates proporcionales, revisión independiente, PR/CI y merge antes de crear
  el checkpoint live.

Evidencia local aceptada el 2026-07-18, todavía sin PR/CI/merge ni acceso al
clúster: el agregador de 14 suites terminó con `exit 0` (lock 27/27, barrera
56/56, transición DB 54/54 más PostgreSQL real, coordinador 153/153, perfil
30/30, operación 34/34, source 20/20, prepare 20/20, materialización 18/18,
publicación privada 13/13, proyección 6/6, captura 6/6 y verificador redactado
28/28). Pasaron además seguridad 47/47, recuperación 243/243, Bash,
ShellCheck, sintaxis Node/Python, Actionlint, `git diff --check` y Gitleaks sobre
6,75 MB sin filtraciones. Esa evidencia cerró los hallazgos conocidos entonces,
incluidos el TTL del checkpoint, el preflight Python, la reentrada de
materialización y dos falsos TOCTOU por `nlink` de directorios. Una revisión
posterior al CI descubrió el P1 GHCR descrito en la casilla anterior; por tanto
la evidencia no autoriza todavía merge ni checkpoint.

Evidencia final del 2026-07-19, todavía sin checkpoint ni mutación live: el
agregador de 15 suites terminó con `exit 0` (lock 27/27,
barrera 56/56, transición DB 54/54 más PostgreSQL real, coordinador 163/163,
perfil 31/31, operación 34/34, source 20/20, prepare 21/21, materialización
18/18, publicación privada 13/13, proyección 6/6, GHCR 44/44, captura 9/9 y
verificador redactado 31/31). Dos revisiones independientes confirmaron el orden
OLD -> NEW antes del lock/CAS, la denegación fail-closed, NEW antes del primer
restart y en auditoría, el dispatcher real y la rama normal `bundle-applied`,
sin falsos verdes P1/P2. `verify-project.sh` y `verify-project.sh --full`
terminaron después con código 0. El commit `4ac252b875e8` pasó los seis checks de
los runs `29667729457` y `29667730561` (seguridad estática y PostgreSQL 12.19 y
14.23 para push y PR); el PR raíz `#6` se fusionó en
`main=c87f5b3982f7b68547702b6fa5b6b6212705f679`. El `main` sincronizado quedó
limpio con los gitlinks Hubs `674ece411691` y Cloud `5392495b0772` intactos.

Resultado de Fase 2A: la ruta integrada liga y rota `Secret/ghcr-pull`, conserva
`ServiceAccount/default` como invariante bind-only y verifica por red las
credenciales GHCR. El merge no creó credenciales, checkpoint ni mutación live;
el handoff documental pasó seis checks y el PR raíz `#7` se fusionó como
`main=83732fe6a4372ef0a5bb6cd9a1ab2eb451def7a1`. En ese momento, el siguiente hito
era integrar el preparador privado NEW antes de crear credenciales.

#### Fase 2B — preparar credenciales sin invalidar todavía el baseline

- [x] Tras quedar el handoff fusionado, sincronizar un `main` limpio, confirmar
  los gitlinks fijados y repetir `verify-project.sh` y
  `verify-project.sh --full` antes de crear credenciales o datos de checkpoint.
  Ambos gates terminaron con código 0 sobre
  `main=83732fe6a4372ef0a5bb6cd9a1ab2eb451def7a1`, Hubs `674ece411691` y Cloud
  `5392495b0772`.
- [x] Integrar en `main`, mediante commit, PR y CI verdes, la compatibilidad
  fail-closed de la fuente OLD (`---` inicial exacto y el único bloque legado
  `PERMS_KEY: |`) ya validada localmente. El PR raíz `#9`, head final
  `5ee444fd2357`, pasó los seis checks de los runs push/PR
  `29681808358`/`29681809883` y se fusionó como
  `main=50b504a15a4ada8658cf4ce1a3b827d4fab8fc31`; no se creó credencial, NEW ni
  checkpoint antes del merge.
- [x] Crear por canales privados las credenciales externas nuevas necesarias,
  manteniendo válidas las anteriores hasta que el rollout coordinado haya sido
  aceptado.
- [x] Hacer disponible el fichero privado en el worktree final mediante una ruta
  absoluta o una copia regular `0600`, nunca mediante Git, symlink, chat o
  salida de terminal; no abrirlo ni usarlo como evidencia. Sin leer contenido,
  se verificó que `/Users/Shared/Gits/YenHubs/deployment/input-values.local.yaml`
  es regular, owner-owned, single-link y `0600`, con padre owner-owned no
  escribible por grupo/otros. El directorio NEW vacío
  `/Users/yengalvez/.yenhubs-private/aud065-20260719-01` quedó owner-owned y
  `0700`. Una comprobación componente a componente descartó symlinks en toda
  la ruta OLD y en todos los componentes existentes de la ruta NEW; el target
  `new-values.yaml` permanece ausente.
- [x] Integrar primero, mediante rama/PR/CI propios, la corrección de secuencia,
  el completador atómico de OLD y el preparador bootstrap `create`/`verify` de
  la copia candidata. `advance` y `promote` permanecen deliberadamente ausentes
  hasta que otra pareja de PR Cloud/root aporte recibos autenticados. No
  ejecutar ninguno contra valores reales hasta que este tooling pertenezca a
  `main`, sus gates estén verdes y exista un digest runner oficial.
  Las suites focales y ambos gates raíz quedaron verdes sobre el mismo árbol
  congelado. El head `e144dafe6e77` del PR raíz `#12` pasó los seis checks de
  los runs push/PR `29699523880`/`29699535163` y se fusionó como
  `main=4651596b452aa4227446f5046ab916a3c1810264`.

Resultado de Fase 2B: el merge verde del tooling cierra esta fase sin ejecutar
el completador ni materializar NEW. La siguiente fase es `AUD-078`; completar
OLD y crear NEW ocurre exclusivamente en Fase 4, después de integrar los PR de
procedencia/recibos, verificar el build conjunto y crear el primer checkpoint.
No existe una tercera fuente de credenciales para `rollback` y todavía no se
crean snapshots sellados de la operación.

Preflight privado de 19 de julio de 2026: `main=origin/main=f14f1f40869d`
permanecía limpio con los gitlinks aceptados. Las tres etiquetas NEW
revisionadas `OPENAI_API_KEY`, `SMTP_PASS` y `GHCR_TOKEN` seguían ausentes en
Keychain; la comprobación consultó solo existencia y no solicitó ni mostró
valores. Los formularios de proveedor quedaron preparados pero no enviados:
OpenAI service account de proyecto y Mailtrap `Domain Admin` limitado al único
dominio requerido, `meta-hubs.org`. GitHub PAT classic quedó detenido ante
passkey con el enlace oficial de `write:packages` sin `repo`; después de la
autenticación aún deben verificarse caducidad, `read:packages`,
`write:packages` y ausencia de `repo` antes de generar. No se creó, leyó ni
revocó credencial alguna, no existe NEW y no hubo acceso al clúster o
producción.

Captura privada completada el 19 de julio de 2026, sin mostrar valores: las tres
etiquetas revisionadas existen en macOS Keychain bajo el prefijo
`YenHubs-AUD065-NEW-20260719-01`. OpenAI usa la cuenta de servicio de proyecto
`yenhubs-aud065-20260719-01`, modo Restricted, únicamente Responses Write y
Moderations Request; la clave personal creada por error durante el formulario
fue revocada y no se reutilizó. Mailtrap quedó limitado a `Domain Admin` de
`meta-hubs.org`, con las lecturas dependientes que impone el proveedor. El PAT
classic de GitHub caduca el 19 de julio de 2027, contiene solo
`read:packages`/`write:packages` y excluye `repo`, `workflow` y
`delete:packages`. Todas las credenciales OLD siguen válidas.

El bridge Keychain se ejecutó una vez y falló cerrado con NEW todavía ausente.
La diagnosis de presencia, sin valores, identificó exactamente dos claves que
el OLD histórico anterior a los runners aislados no contiene:
`OVERRIDE_BOT_RUNNER_IMAGE` y `BOT_IMAGE_PULL_CONFIG_JSON_BASE64`. No existe aún
un paquete/digest oficial `ghcr.io/yengalvez/bot-runner`, por lo que no se
inventó ningún digest ni se editó OLD. Esto reveló una circularidad real del
orden anterior: el gate de rotación exige el runner, pero ese artefacto solo
puede construirse después de integrar en raíz la Fase 3B de `AUD-078` y los PR
Cloud/root de procedencia/recibos. La corrección autorizada permite únicamente construir por
Actions sin desplegar, mantiene todos los workloads live exactos durante
`AUD-065` y exige, después de la rotación, un segundo checkpoint antes de crear
la copia candidata y antes del primer apply.

El preparador integrado de esta fase construye NEW sin editar valores a mano:
lee proveedores desde etiquetas nuevas de macOS Keychain, entrega el frame solo
por FD 3, genera los secretos internos y `PERMS_KEY`, deriva URI/JWT/GHCR,
preserva byte a byte las líneas no autorizadas y publica una única salida
`0600` sin clobber. La corrección final usa `OLD -> NEW -> OLD` tanto en prepare
como en verify. El agregado de 17 suites terminó con código 0, incluidos NEW
21/21, Keychain/supervisor 27/27, source 21/21 y proyección 8/8; el gate raíz
normal también terminó con código 0. El primer gate completo agotó una sola vez
el timeout de prueba de 100 ms al esperar un ACK de spawn de Reticulum; el foco
pasó después 100/100, la suite Reticulum 430/430 y una ejecución canónica nueva
de `verify-project.sh --full` terminó con código 0 y
`Full project verification passed`. Se clasifica como temporización transitoria
del test, no como fallo funcional ni cambio de runtime. Un falso positivo de
Gitleaks en el nombre de una propiedad de fixture se corrigió mediante un
renombrado sin cambio funcional; los escaneos root/Hubs/Cloud quedan limpios.
No se leyó ninguna fuente real de values ni Keychain real. Una búsqueda
diagnóstica mal acotada
alcanzó el `hcce.yaml` ignorado de Cloud y mostró el JWT público derivado; el
valor no se reutilizó y `PERMS_KEY`/JWT permanecen dentro de la rotación
preventiva obligatoria. No se creó credencial/checkpoint ni se consultó o mutó
producción. En ese momento, esta evidencia solo autorizaba PR/CI/merge del
preparador; la captura privada de credenciales y la materialización de NEW
seguían bloqueadas. El commit `a6ed7b3fe3f9`
pasó los seis checks de los runs push/PR `29675286715`/`29675308171`; el PR raíz
`#8` se fusionó como `main=623d70c607f23ff8bf45387cf1af3ea6ab57eb61`.
La compatibilidad OLD descrita a continuación pasó entonces a ser la primera
casilla activa de Fase 2B; las tres casillas privadas quedaron bloqueadas hasta
el merge posterior del PR `#9`.

La primera lectura estrictamente redactada de presencia opcional se detuvo antes
de crear credenciales: la fuente canónica OLD comienza con el marcador YAML
estándar `---`, pero el parser escalar integrado lo rechazaba en la línea 1. La
comprobación solo emitió el tipo de error y después confirmó de forma booleana
que no había BOM y que la primera línea era un marcador; no mostró contenido.
La corrección candidata acepta como máximo un `---` exacto en la primera línea,
liga su presencia y terminación LF/CRLF entre OLD y NEW, lo preserva byte a byte
y mantiene fail-closed todos los marcadores internos, duplicados o
multidocumento. En ese punto, credenciales, NEW, checkpoint y producción
permanecían intactos hasta integrar y revalidar esta compatibilidad.

Tras admitir el marcador, la misma consulta redactada se detuvo en la única
construcción restante fuera del subset: el legado exacto `PERMS_KEY: |`. Un
inventario de solo metadatos confirmó una cabecera, 28 líneas no vacías con dos
espacios y LF uniforme, seguida por otra clave top-level; una comprobación
booleana confirmó RSA válido de al menos 2048 bits sin mostrar el PEM. La
compatibilidad candidata comparte una sola gramática fail-closed entre parser y
preparador, normaliza los saltos a `\n`, deja OLD byte-idéntico y sustituye todo
el span por un único scalar quoted en NEW. La transición compara además la SPKI
pública, por lo que reserializar la misma clave no cuenta como rotación. Pasan
seguridad 50/50, proyección 8/8, preparador 23/23, Keychain 27/27, transición
24/24 y el agregado AUD-065 completo con código 0. Tres revisiones iniciales no
encontraron P1/P2. El parser real termina con código 0 y solo informa que
Sketchfab y Tenor están sin configurar. Los dos falsos positivos del primer
normal procedían únicamente de cabeceras PEM sintéticas del fixture; se
sustituyeron por sentinels no-PEM sin cambiar la cobertura ni añadir una
allowlist. En el primer CI del PR `#9`, los cuatro jobs PostgreSQL pasaron pero
ambos `static-security` encontraron otras dos cabeceras PEM literales dentro de
aserciones del test, no material de clave. Las aserciones construyen ahora la
misma cabecera desde fragmentos y mantienen idéntica comprobación; el foco
vuelve a pasar 23/23, `git diff --check` y Gitleaks del worktree raíz terminan
con código 0, sin allowlist. Los runs finales push/PR
`29681808358`/`29681809883` pasaron los seis checks, incluidos ambos
`static-security`, antes del merge.

Una revisión tardía posterior a esos primeros verdes detectó un P2: el parser
debía admitir el bloque legado para leer OLD, pero la transición podía sellar o
promover un NEW que aún conservara `PERMS_KEY: |`. La corrección inspecciona las
líneas físicas de `newBytes` y falla con
`new_source_perms_key_not_canonical`; solo OLD literal -> NEW scalar permanece
permitido. El caso focal versionado y la re-revisión cerraron el P2 sin otros
P1/P2. Como el cambio material invalidó los verdes anteriores, se repitieron los
gates sobre los bytes finales: transición 24/24, preparador 23/23, seguridad
50/50, el agregado AUD-065, `./scripts/verify-project.sh` y
`./scripts/verify-project.sh --full` terminaron con código 0; el full cerró con
Reticulum 430 pruebas, 5 propiedades y 0 fallos. En ese hito histórico todavía
no se había creado credencial/NEW/checkpoint, leído Keychain real ni accedido al
clúster. El PR raíz `#9` quedó fusionado como
`main=50b504a15a4ada8658cf4ce1a3b827d4fab8fc31`; después se completó la captura
privada de credenciales descrita en Fase 2B. Ese era el punto de entrada
histórico a `AUD-078`; la rama y el candidato Cloud ya existen y la fase activa
actual es cerrar su CI junto con la compatibilidad de checkpoint de Fase 3B.

### Fase 3 — implementar `AUD-078` de forma aislada

- [x] Crear una rama Cloud nueva desde `master`; no mezclarla con `AUD-075`,
  dependencias, upstream ni infraestructura no relacionada.
- [x] Añadir `runtime_revision` durable y outbox PostgreSQL transaccional.
- [x] Encolar config/stop en la misma transacción que aprobación, cuarentena y
  revoke epoch.
- [x] Implementar claims recuperables con CAS, expiración, retry y orden estricto
  por sala.
- [x] Impedir que un snapshot posterior atraviese un stop pendiente.
- [x] Considerar terminal una parada solo después de observar ausencia del
  nombre+UID y cero Pods gestionados de la sala.
- [x] Cubrir `202`, timeout, `2xx` legacy, ABA, Pod desconocido, creación tardía,
  reinicio y pérdida de claim.
- [x] Verificar migraciones PostgreSQL 12/14, Reticulum, orquestador, generador,
  seguridad y rollback.
- [x] PR Cloud hacia `development`, promoción separada a `master` y CI verde.
- [x] Cerrar en un PR Cloud separado el hueco causal descubierto después de la
  promoción: cada `LIST` causal debe venir de la API raw con un
  `resourceVersion` no cero; el watch exacto inicial y cada successor deben
  demostrar progreso mediante su propio `BOOKMARK` in-band antes de detener el
  predecesor. Tiempo transcurrido, cierre limpio, ausencia de bookmark,
  hang/`410`/churn o listas incompletas fallan cerrado. Repetir `test:apply`,
  revisión independiente, CI y promoción `development -> master` antes de mover
  el gitlink raíz.
Integración raíz diferida: no abre una casilla ni un PR independiente aquí. El
gitlink se actualiza una sola vez junto con los callsites de checkpoint/restore
en la última casilla de Fase 3B.

Resultado: Reticulum no declara una parada completa mientras quede o reaparezca
un runner gestionado para la sala.

Evidencia final Cloud: candidato `a3b7396`, apply 79/79 y revisión independiente
sin P0/P1/P2. El PR `hubs-cloud #13` pasó su CI, incluida la matriz PostgreSQL
12/14, y quedó fusionado en
`development=0a21634688445eeb2ad2935627ad1c2f7a233f72`; la promoción separada
`hubs-cloud #14` terminó también verde y fusionó
`master=1cf95ca8719b40aa94adc8ffa987cce835316066`. El worktree raíz fija ya ese
commit como candidato, pero el gitlink no se considera integrado hasta que el
PR raíz de Fase 3B quede verde y fusionado. No hubo build de imágenes ni
mutación live.

Corrección causal posterior en curso: el candidato local
`codex/aud078-watch-boundary` usa `LIST` raw completo y watches exactos con
relevos demostrados por `BOOKMARK` in-band. Un smoke live estrictamente de solo
lectura observó bookmarks en Pods `hcce` (~121 s), Pods
`hcce-bot-runners` (~62 s) y ReplicaSets `hcce` (~121 s), sin mutaciones ni
procesos residuales; también confirmó que los items de un LIST pueden omitir
TypeMeta, por lo que se exige metadata exacta y TypeMeta exacto solo cuando
aparece, mientras los eventos WATCH siguen exigiéndolo. Sobre los bytes actuales
`npm run test:apply` pasa 106/106; `git diff --check`, la sintaxis Node de los
cinco ficheros ejecutables/test afectados y Gitleaks sobre 57,24 MB terminan con
código 0. La revisión independiente final no encontró P0, P1 ni P2 nuevos,
confirmó el fail-close ante EPERM/ESRCH y dejó el escape deliberado de la sesión
POSIX fuera del límite confiable explícito de `kubectl`/plugins de confianza.
El commit `7baee36e6e06` pasó todos los checks push/PR; el PR Cloud `#15` se
fusionó en `development=1a370dd6e48d7f74692544a285dcfefbfda10472`. La
promoción separada `#16` pasó también guard de rama, dos checks de seguridad,
dos de servicios Node y dos de Spoke, y quedó fusionada en
`master=4c0f7be4a4793fc5f370263f081e8a077cb52e59`; los runs post-merge
`29790381506` (seguridad) y `29790381527` (servicios) terminaron también con
éxito sobre ese SHA exacto. El fence de operación posterior pasó 30/30 del
generador, 110/110 de apply y dos E2E contra Kubernetes 1.34.8; los PR Cloud
`#17/#18` quedaron fusionados y promovieron
`master=24d09706c2d9302888ce5192de562005c155bd67`, con seguridad y servicios
post-merge verdes. El gitlink candidato raíz ya apunta a ese SHA, pero sigue sin
estar integrado hasta cerrar sus callsites, gates y PR root.

### Fase 3B — hacer checkpoint/restore compatible con el journal durable

- [x] Rechazar `cold-rebind` antes de toda mutación. Una futura recuperación con
  Namespace UID nuevo será una campaña `namespace-epoch` separada, autenticada y
  destructiva; nunca una bandera de restore normal.
- [x] Exigir igualdad de generación: checkpoint `legacy-absent` solo sobre un
  destino legacy exacto sin residuos AUD-078, y `durable-v2` solo sobre el mismo
  Namespace UID, journal y control plane durable. No cruzar generaciones.
- [x] Generar `checkpoint-metadata.json` schema 3,
  `deployment-images.json` schema 4 y el artefacto obligatorio
  `runner-cutover-evidence.json` schema 3, ligado por checksum y con contratos
  normalizados del control plane. La evidencia registra
  `recovery_operation_fence_state` exacto (`dormant` o `active`); el pull Secret
  se liga solo mediante HMAC con la clave privada del journal, nunca mediante
  datos o hashes sin clave. Conservar lectura de checkpoints schema 2 históricos
  únicamente para legacy in-place.
- [x] Verificar el journal canónico y su HMAC sin archivar ni mostrar la clave;
  ligar operación, Namespace UID, manifest/target hashes, finalizer, políticas y
  bindings observados, Deployment padre y fences exactos.
- [x] Cambiar quiescencia a cero runners ejecutables, cero intents y cero objetos
  desconocidos, permitiendo y preservando fences permanentes por nombre+UID. Un
  fence borrado, reemplazado, terminando o malformado debe abortar.
- [x] Añadir y fusionar primero en Cloud un
  `ValidatingAdmissionPolicy` sin parámetros y un binding permanente y
  fail-closed. El binding debe viajar dormido, mediante un `namespaceSelector`
  imposible, en `bootstrap`/`admission`/`active`, y activo únicamente en
  `restore-fence` para `hcce` y `hcce-bot-runners`. Una vez alcanzados cinco
  writers a cero y reconciliados los fences runner exactos, la raíz cambia el
  selector por CAS de UID/resourceVersion bajo el lock global y su Lease. El
  modo activo deniega en el API server cualquier creación de los cinco writers
  en `hcce` y las operaciones peligrosas de Pods runner y sus subrecursos en
  `hcce-bot-runners`; antes de reanudar writers vuelve por CAS al selector
  dormido. Cada transición debe probarse con GET exacto y dry-runs server-side:
  negativos al activar y positivos al desactivar, ligados al diagnóstico de la
  policy; observar solo el objeto local no basta. No añadir RBAC, no hacer
  legible ningún secreto y no usar `paramKind`/`paramRef`. Integrar generador,
  inventarios, apply/live verifier, tests y promoción Cloud antes de mover de
  nuevo el gitlink raíz. Antes del merge, un CI efímero con la misma versión
  Kubernetes de producción debe probar compilación CEL/estado observado,
  propagación, CAS/ABA y los dry-runs positivos/negativos sin usar el clúster
  live. Este fence se exige solo a `durable-v2`: debe estar
  observado antes de abrir bytes de un restore durable, pero no se despliega
  anticipadamente ni rompe la regla que sitúa el primer checkpoint legacy antes
  de toda mutación live.
- [x] Sustituir todo uso de `deployments/scale` por una transición del objeto
  Deployment completo con CAS de UID/resourceVersion bajo la Lease global; no
  debilitar la política Cloud que prohíbe `/scale`.
- [x] Supervisar cada stream largo de DB y `ret-pvc` con una vuelta completa
  estrictamente nueva antes de abrirlo, progreso monotónico publicado
  atómicamente, frescura máxima de 10 s, sondeo productivo de 1 s, Lease leída
  con timeout máximo de 5 s —reducido a 1 s cuando queden como máximo 5 s del
  presupuesto de frescura— y cancelación/recolección del grupo exacto por PID
  e identidad de arranque. Los overrides temporales solo son válidos bajo
  atestación de fixture local.
- [x] Cubrir schemas, checksums, symlinks, snapshot inmutable, HMAC, UID,
  finalizer, policies, fences, residuos, cruces de generación, redacción,
  señales, frescura/abort de streams y reentrada con pruebas fail-closed. Las
  pruebas focales y la suite completa deben repetirse sobre los bytes finales;
  ningún verde anterior a la última corrección cierra esta casilla. Evidencia
  final: `env -u NODE_PATH /usr/bin/time -p bash
  tests/recovery/test-recovery-safety.sh` terminó el 21 de julio sobre los bytes
  definitivos con `861/861`, exit `0` y `real 13325.23` s. Incluye integralmente
  los antiguos fallos 323/324, el consumidor transitorio de `ret-pvc`, la
  restauración legacy/durable, el preflight final y todas las baterías de
  writers, helpers, streams y watchdog. No quedaron procesos fixture.
- [x] Integrar primero la corrección mínima de los advisories nuevos de
  Reticulum: PR Cloud `#19`, CI PostgreSQL 12/14, merge
  `development=b2abe936`, promoción separada PR `#20` y
  `master=c540c292`. No se amplió la allowlist ni cambió otra dependencia.
- [x] Fijar en raíz Cloud `c540c292` junto a Hubs `ce8390a89` y ejecutar una
  sola vez el gate `--full` sobre esos nuevos bytes. La ejecución recorrió
  todos los bloques y terminó con 860/861 de recovery por el fallo temporal
  aislado del caso 850; no se presenta como gate verde.
- [x] Diagnosticar de forma focal el caso 850 y corregir solo su causa
  demostrada. La llamada completa estaba dentro de 5 s y la inversión era de
  −1 ms entre marcadores de fixture; el runtime revocó y recogió el grupo. La
  publicación de marcadores es ahora atómica y el fallback acepta solo −1 ms
  cuando el cronómetro completo también queda bajo 5 s. El test exige además
  al menos un Lease GET lento post-launch. Bash, ShellCheck, diff-check y el
  foco final `stream-guards` 81/81 pasan; revisión independiente sin P0/P1.
- [x] Ejecutar una única revalidación `--full` sobre el fixture final. Recovery
  pasó `861/861`, incluido el caso 850, y los demás bloques llegaron verdes al
  control final de dependencias; el gate terminó exit `1`, `real 12834.18` s,
  por cuatro advisories nuevos de Guardian `2.4.0`.
- [x] Corregir únicamente esos cuatro advisories con Guardian `2.4.1`. El diff
  Cloud cambia una sola entrada de `mix.lock`; pasan formato, compilación,
  `mix hex.audit`, dos verificadores de migración, `461` tests + `5` properties,
  release, Gitleaks y CI PostgreSQL 12.19/14.23. PR `#21` se fusionó en
  `development=67e89a15` y PR `#22` en `master=c0a3419b`; los runs post-merge
  `30725805066` y `30725805072` están verdes.
- [x] Fijar Cloud `c0a3419b` en raíz y ejecutar la validación proporcional:
  pines exactos, diff-check, auditoría upstream y Gitleaks raíz verdes. La única
  revisión final no encontró P0/P1/P2 ni archivos accidentales.
- [x] Crear el commit raíz `1d45626`, publicarlo y abrir el PR raíz `#14`.
- [x] Resolver los dos únicos diagnósticos `SC2015` de su primer CI mediante
  `if` explícitos, sin alterar la semántica. Pasan Bash syntax, ShellCheck,
  diff-check, el foco de librería `46/46` y el foco writers `170/170`.
- [x] Publicar esa corrección en el segundo commit `6601cb1`. Los cuatro jobs
  AUD-065 volvieron a pasar; los jobs estáticos avanzaron hasta falsos positivos
  Linux `SC2317` en dos callbacks de `trap` y `SC2119/SC2120` en una función que
  recibe overrides mediante `expect_success`.
- [x] Añadir supresiones locales justificadas solo para esos diagnósticos. No
  cambia ninguna instrucción ejecutable; Bash syntax, ShellCheck local sobre el
  fichero completo y diff-check pasan.
- [x] Publicar las supresiones en un tercer commit y fusionar el PR `#14` en
  `main`. No se creó todavía un checkpoint real. Sus gates largos fueron
  cancelados por el límite de 75 minutos y el cierre permaneció retenido.
- [ ] Cerrar el PR `#15`: timeout 360 y deduplicación ya funcionan; corregir la
  única incompatibilidad Linux demostrada (`jq --argjson` con inventario live
  de 214.796 bytes), exigir un único gate integral verde y fusionar en `main`.

Resultado: los checkpoints anteriores siguen siendo legibles en su generación,
pero el rollout durable solo puede avanzar con evidencia restaurable ligada al
journal y sin destruir sus fences causales.

#### Historial de cierre de Fase 3B

Los párrafos de esta subsección conservan evidencia cronológica y estados
intermedios que quedaron supersedidos. No se usan para seleccionar trabajo; el
estado operativo vigente es el panel superior y la última evidencia de esta
subsección.

Estado de la Fase 3B al 21 de julio: la fuente candidata se está cerrando en
`codex/aud078-root-integration` sobre root
`main=origin/main=ed8c9d13fbbd2336417c36e54663d09e032193ba`; Hubs candidato apunta a
`master=ce8390a8905fa38fa0acdb10d5f94290981477ec` y el gitlink Cloud candidato es
`24d09706c2d9302888ce5192de562005c155bd67`, ya colocado en el worktree pero
todavía no fusionado en root. La revisión adversarial que invalidó el cierre
anterior encontró un handoff LIST/watch no causal, snapshots durable-v2 sin
watcher continuo y cancelación tardía del stream cuando se congelaba el watcher
de writers. El Cloud corregido está fusionado mediante los PR `#15`–`#18`; en
raíz se han implementado dos monitores causales separados. Ambos publican una
autoridad JSON checksummed que liga PID e identidad de arranque, paths y hashes
de contrato/baselines, operación, propietario, lock y Lease; sus handshakes
`READY`, progreso y `FINAL` están tokenizados y una sustitución o replay falla
cerrado. `operation_owner` solo admite `checkpoint-backup` o
`checkpoint-restore`.

El monitor de writers mantiene los cinco Deployments a cero. El monitor durable
liga esa frontera de control y conserva watches de Pods/ReplicaSets con handoff
in-band; no compara `resourceVersion` opacos por orden. En los hijos durable, la
autoridad heredada exige a la vez la capability del writer padre, la capability
del monitor durable padre y el guard local del stream. Al cerrar, `FINAL` del
monitor durable se exige antes de detener y aceptar `FINAL` del monitor de
writers. Los focos propios de ambos monitores y sus revisiones independientes
están verdes, pero las casillas de quiescencia, supervisión de streams y
cobertura fail-closed permanecen abiertas hasta cerrar los callsites/fixtures
y repetir la suite completa sobre bytes inmóviles.

El handoff del monitor legacy quedó inicialmente congelado en
`watch-checkpoint-writers.mjs=6acc75c821103c776279301b51d19f176a8d2110b29c7728728f38bd94e4c1f5`,
`recovery-safety.sh=8c5aecda7151ca012647b9788525c52ee2e44afef6566af1377b0d02a2706a7d`
y
`restore-checkpoint.sh=57e831021a5bb61e7efb0283394eea97096f321b4f3602fa89df4abba7581a04`.
Dos revisiones independientes no encuentran P0/P1/P2 en esos bytes; `node
--check`, `bash -n`, ShellCheck y `git diff --check` terminan con código 0. El
protocolo enlaza ARM, recibo CAS, COMMIT y ACK con lock, Lease, UID,
`resourceVersion` y autoridad exactos; Reticulum es el primer writer que vuelve,
el recibo se retira por CAS tras recapturar su RV posterior al rollout y
`clear-stale` nunca elimina el lock dejando un recibo huérfano. Esta evidencia
es todavía estática: no cierra las casillas hasta que las fixtures adversariales
y la suite completa pasen sobre los mismos hashes. El hash de la librería de
seguridad quedó después supersedido por la limpieza común descrita abajo; el
watcher y el coordinador restore permanecen byte a byte en sus hashes citados,
pero el conjunto debe repetir sus focos sobre la librería final.

La auditoría de equivalencia del gate detectó que el verificador local sí
ejecutaba la suite causal durable, pero el workflow raíz todavía la omitía.
`project-security.yml` invoca ahora tanto
`runner-cutover-checkpoint-evidence.test.mjs` como
`durable-runner-quiescence-monitor.test.mjs`, y una regresión fija exactamente
ambas entradas en local y CI. `bash -n`, ShellCheck y `git diff --check` pasan;
`tests/scripts/security-gates.test.sh` termina con `51/51`, exit `0`. La casilla
de gates permanece abierta hasta la ejecución normal/completa y el CI del PR.

La auditoría literal de cierre encuentra `P0=0`, pero impide congelar todavía
por tres P1: el `pg_dump` coordinado tiene capabilities padre pero no guard
local continuo de la identidad PostgreSQL; los backups standalone DB/PVC aún
abren streams que no pueden constituir el checkpoint conjunto exigido; y tres
monitores locales aceptan cadencias directas no atestadas —incluido un default
DB de 0,25 s— en vez del segundo productivo único. También pide como P2 fijar
en los callsites restore que matar, estancar o intercambiar una capability
padre cancela y recoge el stream conservando lock y fence. Las correcciones se
aplican antes de nuevas focales o de repetir la suite recovery completa.

El candidato source que cierra esos P1 queda en
`backup-retdb.sh=fcaf9566deffad4ac34c347b8c6f324280caac392ff40d4b187275517d3c007e`,
`backup-ret-storage-quiesced.sh=c02606a47d58df0ee23322cf6a458e71584dc2fc4af6b6f03798f7032c9b977c`,
`restore-retdb.sh=2a60cc55576dec766e0759c0989b47b486bebd3a4f3e8ce95c70ea470b091a66`
y
`restore-ret-storage.sh=eadf05f035291b77b65aec979e58336ed8c5baccce164cce47a5ef7de12d530d`.
El dump solo admite el hijo coordinado, añade guard PostgreSQL local continuo y
vuelve a listar la identidad exacta después del stream. El restore DB incorpora
esa identidad PostgreSQL al barrido continuo que guarda tanto `DROP/CREATE`
como la importación. Si la publicación secuencial de dump y contrato falla, el
child retira solo los nombres finales que aún conservan sus inodos exactos y no
puede borrar un reemplazo ajeno. El backup storage
standalone queda como stub sin lectura Kubernetes ni salida; su implementación
histórica está inventariada en `OLD/` y el sustituto activo es el checkpoint
conjunto. Todos los monitores derivan una sola cadencia mediante el helper que
fija un segundo en producción y solo acepta override en fixture atestada.
`bash -n`, ShellCheck y `git diff --check` terminan con código 0; falta todavía
auditoría independiente y cobertura dinámica sobre estos hashes.

Los hashes de source del párrafo anterior quedan supersedidos por la auditoría
posterior de publicación y directorios privados: no son candidatos de suite ni
de commit. El árbol vuelve a estado no congelado mientras se sustituye todo
`rm -rf` de Fase 3B por una capacidad `dev:ino`/`dirfd` común y se repiten sus
estáticos, auditoría y focales.

El source vuelve a quedar congelado tras esa corrección en
`recovery-safety.sh=aeef24f71bf7847ebe3e52caa067bd598d5fc935c83f34fae993ec26bd771ec0`,
`create-checkpoint.sh=5fef9a3a891a6ef9bc6c2f426e8b0c87e8a4c8ed2cef836ae26d56e7b2b92730`,
`validate-checkpoint.sh=2d973b7f5cceb45c2b324b9a09593a8d0741876cdbfdbc68ce54bb640175f069`,
`backup-retdb.sh=4d2cda39a9a599f20aa711a35f5181f4fa5a1104aaef5584e5dd77fc59d4d2e5`,
`restore-retdb.sh=2a60cc55576dec766e0759c0989b47b486bebd3a4f3e8ce95c70ea470b091a66`,
`backup-ret-storage-quiesced.sh=2596a1b509568e8d4fe331e0fd2e08bb0829e42802c58c8e9a150f97b631e34d`
y
`restore-ret-storage.sh=9fcf9550ca68e686c1013fe833c0dd336d990caa4f95084c08c9ecde095fd394`.
La capacidad opaca liga padre y raíz canónicos por `dev:ino`, UID, modos y
`dirfd` con `O_NOFOLLOW`; prevalida el árbol completo contra allowlists
`d:`/`f:`, conserva el descriptor exacto hasta `unlink` y nunca recurre a un
borrado por pathname. Staging/final, materialización schema 2/3, validadores y
el `WORK_DIR` storage difieren `INT`/`TERM` hasta armar identidad, marker y
latch; una limpieza fallida queda terminal y preserva replacement u orphan.
`bash -n`, Node `--check`, ShellCheck, compilación del Python embebido,
`git diff --check` y la ausencia de `rm -rf` en esos callsites terminan con
código 0. Smokes locales pasan happy recursivo y rechazan/preservan extra,
marker incorrecto y root swap. El límite residual portable es la nanorace
POSIX same-UID entre última comparación y `unlink`/`rmdir`; ante drift o
`SIGKILL` se falla conservando el reemplazo o un orphan, nunca borrándolo por
fallback. Los fixtures finales y la suite completa siguen siendo necesarios.

El primer foco adversarial del recibo legacy termina con `59/59`, exit `0`:
replay W1/LIST para ReplicaSet y Pod, evento status-only sin ACK, happy path con
solape H largo y R posterior, y fallos R por `410`, cierre prematuro y exit 91.
No deja procesos H/R huérfanos. Es evidencia intermedia: el mismo fichero de
fixtures seguirá cambiando para integrar el driver shell, los guards DB/PVC y
los rechazos standalone, por lo que el foco se repetirá sobre el hash final.

La evidencia runner schema 3 registra dos Namespace, 13 recursos namespaced y
cinco pares policy/binding —10 recursos cluster—, incluido el fence de operación.
En `durable-v2`, checkpoint activa por CAS el binding `dormant -> active` después
de los cinco writers a cero y vuelve a `dormant` justo antes de reanudar. Legacy
no exige ese quinto par y solo acepta semántica `dormant`; nunca activa el fence.
Restore aplica la máquina de estados documentada en `deployment/README.md`:
PREPARE/PREFLIGHT dormidos, `restore-fence` reconcilia y activa con sondas,
EXECUTE adopta la identidad activa y la conserva durante streams, validación y
el lock awaiting-reactivation; el apply Cloud `active` vuelve por CAS a dormant
inmediatamente antes de devolver autoridad a workloads, y FINALIZE comprueba
dormant. Desde justo antes de abrir el stream mutable de PVC hasta terminar su
validación exacta, cualquier fallo de stream o validación —incluida una
reentrada exacta que no termina o un `owned` no vacío/inseguro— conserva el
helper Pod, la NetworkPolicy deny-all y el lock. El `clear-stale` durable sólo
admite el quinto fence exacto ya dormido; si está activo, no muta helper, lock
ni fence y exige una recuperación Cloud revisada.

La última auditoría causal del supervisor multi-guard descubrió que las
esperas secuenciales podían atribuir a un incremento una fecha no observada y
no demostrar una ventana fresca simultánea. El source final
`recovery-safety.sh=93afad8ce84a41fd66d953dcc73fc84a5a0d6fe88f58579d8a6d70cee9734200`
usa dos vueltas round-robin en foreground, progreso monotónico con cota temporal
conservadora, autoridad exacta y comparación estricta de frescura antes del
stream. La revisión independiente de fuente no encontró P0–P3. Sobre ese
source y el fixture entonces candidato
`test-recovery-safety.sh=37e814b149c2b74f720ddea43efce1ecb7983f8d42d73e5b770f7a1a37800a56`,
el foco multi-guard determinista termina 48/48 y la matriz durable DB/PVC
termina 72/72, exit `0`, `real 824.87` s, incluida la revocación en vuelo por
PID, progreso y autoridad con lock, fence y frontera cero preservados. No deja
procesos fixture.

La primera suite completa posterior detectó en sus checks 105/107 una fixture
legacy desfasada, no un fallo de producto: el segundo inventario de
`runner-reappears*` era consumido por la nueva frontera exacta parent-writer y
el child no alcanzaba el waiter residual/timeout que debía probar. La ejecución
se detuvo una vez invalidada. El fixture final
`test-recovery-safety.sh=a36447bc9e1ea30d68f0d9bba3a8e65fc6157d5f9e0f2e3c186b01673ad52ba6`
reserva vacías la lectura de generación y la frontera padre y hace reaparecer
el runner en el tercer inventario del waiter. Su foco reutilizable termina
49/49, exit `0`, `real 32.33` s, con diagnósticos exactos residual/timeout y dos
pruebas de ausencia de `dropdb`. Una revisión independiente no encuentra
P1–P3 ni modos hermanos afectados; Bash syntax y `git diff --check` pasan y
ShellCheck no añade diagnósticos en las líneas cambiadas.

La segunda ejecución completa alcanzó 155 comprobaciones verdes y produjo un
checkpoint durable completo y verificable, pero el caso que lo reutiliza para
restore falló después de publicar y retirar el marker, exactamente dentro de
`resume_writers`. El fallback conservó cinco writers a cero y el lock global;
los logs posteriores de la fixture impidieron identificar el subgate. Un foco
aislado confirmó además que dos diagnósticos antiguos de drift del fence ya
ocurrían antes, durante el stream DB, por el monitor continuo; se ligaron a
markers causales exactos y el foco resultante pasó 51/51. Esa ejecución completa
no cuenta como gate verde y debe repetirse sobre los bytes finales.

La auditoría de finalización posterior encontró dos P2 antes de autorizar esa
repetición: la identidad `dormant` producida por el CAS se capturaba pero no se
revalidaba hasta liberar el lock, y los fallos posteriores a validación solo
emitían un mensaje genérico. El candidato actual fija UID y `resourceVersion`
del policy/binding durante cada resume y justo antes del borrado CAS del lock;
una excursión `dormant(rv3) -> active(rv4) -> dormant(rv5)` falla cerrada tanto
antes del primer writer como después del último. El diagnóstico conserva el
status original y solo admite pares literales `stage/code`, sin rutas, líneas,
UID, RV, hashes, manifests ni payloads. Dos revisiones independientes no
encuentran P0–P2; el único P3 de etiquetado temprano quedó corregido.

El foco writer final descubrió únicamente tres desajustes del arnés: los E2E
durable no resembraban el binding `dormant` después de `reset_stub`, el código
diagnóstico esperado en la frontera final aún decía `writer-stop` en vez de
`writer-monitor`, y el caso de salida 143 sustituía el PID sin volver a firmar
su autoridad. Las correcciones quedan confinadas a fixtures y añaden un marker
causal post-READY y un límite de recolección de 10 s. Tres revisiones
independientes confirmaron la causa y no encontraron P0/P1; el foco corto de
salida 143 pasa 46/46 y el foco completo
`YENHUBS_RECOVERY_TEST_FOCUS=checkpoint-writers` pasa 170/170, exit `0`,
`real 2001.66` s, sin procesos residuales.

Los bytes congelados en ese hito intermedio —no los bytes actuales— eran
`create-checkpoint.sh=2cec747e1dd24bf201a386a6128b672d2f2946b3c0509bde77e07b1dc748a037`,
`recovery-safety.sh=93afad8ce84a41fd66d953dcc73fc84a5a0d6fe88f58579d8a6d70cee9734200`,
`watch-durable-runner-quiescence.mjs=54a25fbf17d417ea89acc79ca08e6eddbe627ae161f582abdffb9a0823fdc47d`,
`watch-checkpoint-writers.mjs=6acc75c821103c776279301b51d19f176a8d2110b29c7728728f38bd94e4c1f5`
y
`restore-checkpoint.sh=d1ab89e77635976abd96329b541a4ea229b48c9b8389690365c7d9c86fe1b4b9`
y
`test-recovery-safety.sh=4b2eb4401cd987ee2e19081e401c186dff9eb8c89db30512d8d666d4aae9e2eb`.
Bash syntax, ShellCheck y `git diff --check` están verdes. El foco durable
se repitió sobre el mismo hash y pasa 60/60, exit `0`, `real 838.38` s. Demuestra
preservación del fence permanente por UID/RV, reconciliación exacta de runner e
intent, rechazo sin borrado de Pods desconocidos y retención de lock/cinco
writers a cero si el fence desaparece, se reemplaza o termina. No deja procesos
residuales. La suite recovery completa inmutable termina 861/861, exit `0`,
`real 13325.23` s; Bash syntax, ShellCheck y `git diff --check` también pasan y
una revisión independiente no encuentra P0/P1/P2 en los últimos ajustes de
fixtures. Quedan ambos gates raíz, revisión final, commit, PR/CI y merge. No se
construyó ninguna imagen, no se creó un checkpoint real y no hubo apply,
despliegue ni mutación de producción.

El primer `./scripts/verify-project.sh` posterior a recovery terminó con código
0 sobre Hubs `674ece411691` y Cloud `24d0970`, incluida recovery 861/861. El
primer `--full` volvió a pasar seguridad 51/51 y recovery 861/861, pero se
detuvo en el audit de producción de Hubs por dos advisories publicados para
Immutable.js `<4.3.9`; no se aceptó una allowlist. El PR Hubs `#5` fija
Immutable.js 4.3.9, aplica de forma fail-closed la compatibilidad necesaria para
Draft.js 0.11.7 y añade regresiones del editor Tweet. Localmente pasan audit de
producción con 0 vulnerabilidades, 100/100 pruebas, TypeScript y build; los tres
checks del PR pasaron y el merge dejó `master=ce8390a89`. La repetición normal
sobre los gitlinks finales Hubs `ce8390a8905f` y Cloud `24d09706c2d9` terminó
después con código 0 (`real 13647.23` s): seguridad 51/51, recovery 861/861,
todas las suites `AUD-065`, Gitleaks en los tres repositorios y auditoría
upstream sin release estable pendiente. Solo queda ejecutar `--full` una vez
sobre esos mismos bytes, revisar y publicar el PR raíz.

La primera repetición `--full` alcanzó el happy path durable de restore y falló
en su cierre porque dos monitores del kubectl stub ejecutaban cientos de WATCH
de dos segundos como cierres instantáneos. El restore real no falló de forma
determinista: DB/PVC quedaron validados y el lock/fence se retuvo fail-closed.
Se añadió `STUB_MONITOR_WATCH_PACE=1` solo a los EXECUTE durable; los focos
`restore-finalize-positive` 54/54 (`real 639.24` s) y `restore-execute-cas`
55/55 (`real 956.62` s) pasaron. La siguiente repetición `--full` confirmó que
el pacing eliminaba el spin —los casos 284–290 pasaron—, pero otro restore
positivo consecutivo volvió a fallar al revalidar los monitores y el run se
detuvo con exit `1` (`real 4153.50` s).

El diagnóstico posterior descartó la frescura productiva de 10 s: el fallo
ocurría fuera del stream, durante la revalidación final. El monitor durable
usaba para `local-fixture` un handshake de solo 1 s, aunque cada frontera
inicial abre dos procesos reales del stub (`kubectl` recursivo y `jq`) y la ruta
productiva ya permite 7 s. El fixture atestado usa ahora ese mismo límite
acotado de 7 s; producción no cambia. El diagnóstico seguro queda activo solo
ante fallo y el foco nuevo `restore-repeat-positive` ejecuta tres restores
completos en un único proceso. Pasan el test Node 11/11 y la regresión final
61/61, exit `0`, `real 1334.59` s, incluidos tres restores DB+storage, ambos
monitores con `watch=true`, el replace CAS exacto del lock identificado solo
después de validar UID/RV/estado y los tres estados finales fail-closed. Una
revisión independiente confirma que el cambio solo alcanza
`YENHUBS_RECOVERY_TEST_MODE=local-fixture` con contexto fixture. El full debe
reiniciarse una vez y será el único gate amplio vigente de esos bytes.

Esa ejecución pasó los casos 284–294 y después falló con
`durable_runner_monitor_error:parent_pod_contract`, exit `1`,
`real 4261.81` s. El Pod helper del stub se publicaba en cinco ficheros
independientes; un LIST concurrente con DELETE podía observar solo parte de
ellos, algo que Kubernetes no hace al devolver un objeto Pod. El fixture publica
ahora un único snapshot JSON con `mv` atómico, LIST conserva un descriptor al
snapshot completo y DELETE lo retira por UID exacto. También se aísla
preventivamente el contexto kubectl entre escenarios. Los focos
`storage-helper-pod-snapshot-race` y `restore-context-isolation` pasan 46/46
cada uno, y `restore-repeat-positive` vuelve a pasar tres restores completos:
61/61, exit `0`, `real 1081.42` s. Bash syntax, ShellCheck y `git diff --check`
quedan verdes. No cambió fuente productiva; como sí cambiaron los bytes del
fixture, corresponde exactamente una revalidación `--full` post-corrección.

Esa revalidación alcanzó y pasó los antiguos casos críticos 284–288, pero se
detuvo voluntariamente al observar que un LIST que perdía el snapshot justo
antes de `open(2)` devolvía correctamente lista vacía pero dejaba el diagnóstico
shell `No such file or directory` en stderr. No se aceptaron horas adicionales
sobre bytes ya incompletos. La apertura se agrupa ahora con stderr suprimido
solo para ese `ENOENT` esperado; el retorno sigue distinguiendo GET obligatorio
de LIST vacío. La regresión determinista cubre tanto DELETE posterior a open
como DELETE anterior a open y pasa 46/46, exit `0`, `real 8.49` s, sin stderr.
No se repite 61/61 porque esta corrección no cambia su semántica ni su retorno.
Sí corresponde una única revalidación `--full` porque cambió el fixture.

La revalidación final se ejecutó una vez y terminó todos los bloques anteriores:
seguridad, recovery 861/861, suites AUD-065, auditoría upstream, Gitleaks de los
tres repositorios, Hubs/Admin, navegador, capacidad fail-closed, orquestador,
servicios CE, Spoke y compilación Reticulum. El último `mix hex.audit` descubrió
dos avisos publicados después del baseline: `EEF-CVE-2026-59248` en Cowlib
2.18.0 y `EEF-CVE-2026-65624` en Cowboy 2.15.0. El run terminó con exit `1` y
`real 12474.87` s; no se amplió la allowlist y producción no cambió.

Las fuentes oficiales fijan las primeras correcciones en Cowlib 2.19.0 y Cowboy
2.18.0. La rama Cloud `codex/reticulum-http-advisories`, commit `fc0b45f`,
cambia únicamente la restricción directa Cowboy y las dos entradas necesarias
del lock; Ranch queda en 2.2.0. Pasan formato, compilación, `mix hex.audit`, las
dos verificaciones de migraciones, 461 tests + 5 properties sobre PostgreSQL
14.23, release `turkey`, diff-check y Gitleaks de fuente trackeada. El PR `#19`
repitió seguridad, PostgreSQL 12.19/14.23 y release y se fusionó como
`development=b2abe936`; la promoción separada `#20` repitió los mismos gates y
se fusionó como `master=c540c292`. Los runs post-merge
`security-ci=30709212953` y `reticulum-ci=30709212992` quedaron verdes; en ese
momento quedó pendiente la revalidación raíz sobre el gitlink nuevo.

Esa revalidación confirmó recovery 861/861 y todos los bloques anteriores, pero
el Hex audit final recibió cuatro advisories nuevos de Guardian `2.4.0`. La
primera release oficial corregida, Guardian `2.4.1`, se integró cambiando una
sola entrada del lock mediante PR `#21` y promoción `#22`; Cloud
`master=c0a3419b` y sus CI post-merge PostgreSQL 12/14, seguridad y release están
verdes. Como el único byte lógico posterior pertenece a la dependencia ya
validada de Reticulum, no se vuelven a ejecutar recovery, Hubs, Spoke o
capacidad.

Hashes sometidos a la regresión final y al full que confirmó recovery 861/861:
`create-checkpoint.sh=2cec747e1dd24bf201a386a6128b672d2f2946b3c0509bde77e07b1dc748a037`,
`recovery-safety.sh=93afad8ce84a41fd66d953dcc73fc84a5a0d6fe88f58579d8a6d70cee9734200`,
`watch-checkpoint-writers.mjs=6acc75c821103c776279301b51d19f176a8d2110b29c7728728f38bd94e4c1f5`,
`watch-durable-runner-quiescence.mjs=d2df0c06c8b816ba9137e60c66026b25e3d2c1b90f69973b48b4e23bb48c59b2`,
`restore-checkpoint.sh=d1ab89e77635976abd96329b541a4ea229b48c9b8389690365c7d9c86fe1b4b9`
y
`test-recovery-safety.sh=0ea88ed52e80ec8a420fa5bd53a77eba56776c518238f1eb9b9d8388ebb18bc0`.

El candidato actual cambia después únicamente la forma ShellCheck de dos
señalizaciones de descarte, de `cmd && asignación || :` a `if cmd; then
asignación; fi`, sin cambiar sus comandos ni estados. Su hash vigente es
`recovery-safety.sh=c5a1f2df9a2c26698f60a1064065d15aee6f6401cbf4b812400101a660392a54`;
queda cubierto por Bash syntax, ShellCheck, diff-check, el foco de librería
`46/46` y writers `170/170`. El fixture solo añade después comentarios de
compatibilidad ShellCheck y su hash vigente es
`test-recovery-safety.sh=01c41bb2d461fc3e0f434f8ebc8176accdb044f07adad0e83ff37551e2b7f80e`;
no cambió ninguna instrucción ejecutable.

### Fase 4 — integrar evidencias, construir sin desplegar y completar `AUD-065`

- [ ] Ejecutar la auditoría upstream de solo lectura y registrar el resultado;
  no incorporar upstream dentro de esta meta.
- [ ] En una rama/PR Cloud separada de `AUD-078`, integrar un workflow fijo que
  construya/ateste Reticulum, parent y runner en un único run, la regeneración
  exacta values -> manifiesto antes del primer `kubectl` y recibos autenticados
  `bootstrap-server`/`bootstrap-client`/`admission`/`active` bajo el Lease
  global. Las dos generaciones bootstrap representan explícitamente el orden
  Reticulum-first/Hubs-second y ninguna permite saltar directo al cliente.
- [ ] Después del merge Cloud, actualizar su gitlink en una rama raíz —Hubs ya
  queda fijado por el PR de Fase 3B— e integrar el consumidor de
  recibos/evidencia: operación privada ligada a
  checkpoint, commits Hubs/Cloud, cuatro digests, contexto/UID y candidato; sin
  esa cadena `advance` y `promote` deben fallar sin mutar archivos.
- [ ] Sobre esos nuevos bytes —sus inputs sí habrán cambiado— ejecutar una vez
  `./scripts/verify-project.sh` y `./scripts/verify-project.sh --full`, hacer una
  única revisión final, y solo entonces publicar/validar/fusionar el PR raíz.
  No repetirlos tras quedar verdes salvo cambio material posterior.
- [ ] Congelar los commits Hubs y Cloud fijados por ese root limpio. Justo antes
  del build,
  actualizar ambos `REGISTRY_PASSWORD` de Actions mediante el supervisor
  Keychain y exigir `aud065_actions_secrets_updated`; OLD permanece válido y no
  se revoca nada todavía.
- [ ] Construir mediante un único workflow GitHub Actions aprobado Reticulum,
  `bot-orchestrator` y `bot-runner` desde ese commit Cloud exacto. Esta es una
  excepción de supply-chain sin deploy: no crea checkpoint, no genera/aplica
  manifiesto y no cambia Kubernetes.
- [ ] Construir Hubs mediante el workflow Actions aprobado
  `custom-docker-build-push` desde el commit Hubs exacto fijado por el mismo
  root y resolver su digest inmutable. El build no genera/aplica manifiesto ni
  cambia Kubernetes.

Regla fail-closed: detenerse ante cualquier fallo o publicación parcial de
Actions/GHCR. No
  aceptar parent sin runner o viceversa, y no usar builds dentro del clúster,
  hotpatches, `kubectl cp`, `kubectl set image` ni reemplazos manuales.
- [ ] Descargar y conservar exactamente cinco ficheros distintos del mismo run:
  el recibo JSON canónico, su bundle de atestación y los tres bundles OCI de
  Reticulum, parent y runner. Exigir que las cuatro atestaciones liguen las tres
  imágenes al mismo commit, workflow e `invocationId`; una ausencia, alias,
  publicación parcial o digest escrito a mano bloquea la fase.
- [ ] Conservar y verificar además el identificador de run, commit y digest del
  build Hubs contra el gitlink Hubs exacto. Esta evidencia es independiente de
  los cinco ficheros Cloud y no se sustituye por un tag o un digest escrito a
  mano.
- [ ] Verificar las evidencias Cloud y Hubs únicamente desde un root limpio con
  `HEAD=main=origin/main`; el verificador deriva el commit esperado del gitlink
  correspondiente, exige que cada checkout y `origin/master` lo contengan y
  devuelve los cuatro digests inmutables. No acepta un override de commit o
  imagen.
- [ ] Para las verificaciones OCI, materializar desde el pull config privado un
  `DOCKER_CONFIG` efímero mediante el helper trackeado: padre y directorio
  temporales owner-only `0700`, `config.json` `0600`, sin `docker login`, argv ni
  entorno global, y borrado/wipe incluso si falla la atestación.
- [ ] Confirmar contexto Kubernetes, namespace, UID, PVC, Deployments e imágenes
  mediante rutas redactadas; no abrir ni imprimir manifiestos privados. Exigir
  además un `kubectl` dentro del skew soportado de +/-1 minor frente al API
  server: el cliente local observado `1.36.2` no puede mutar el servidor
  `1.34.8`; usar/pinear `1.34.x` o `1.35.x` antes de cualquier operación live.
- [ ] Crear el primer checkpoint nuevo con
  `ALLOW_CHECKPOINT_DOWNTIME=1 ./deployment/create-checkpoint.sh` antes de que el
  completador de OLD adquiera el Lease global. Debe incluir PostgreSQL y
  `ret-pvc`; verificar `SHA256SUMS`, gzip, contrato DB, pares de storage y restore
  dry-run, evidencia `legacy-absent` y la copia cifrada exigida.
- [ ] Ejecutar desde `main` el completador versionado de OLD. Primero hace una
  copia byte-exacta y ligada por inode de los cinco artefactos ya validados en
  un snapshot privado aleatorio antes del primer `kubectl`; solo esa copia puede
  alimentar la captura preliminar read-only del pull auth y de
  `Deployment/bot-orchestrator`, el `DOCKER_CONFIG` efímero y la derivación del
  runner final. Después adquiere el Lease global, hace dos capturas estables y
  una tercera captura post-CAS, todas silenciosas, del `Secret/ghcr-pull` live,
  `ServiceAccount/default` y el parent, ligando UID, resourceVersion, contenedor
  único, imagen OLD exacta y herencia de pull exclusiva mediante ese
  ServiceAccount, sin override en el Pod; verifica por red ese parent live y el runner, y
  añade por CAS únicamente el pull config exacto y
  `OVERRIDE_BOT_RUNNER_IMAGE`. El runner es aquí solo un binding de verificación:
  ningún workload live ni otro digest cambia.
- [ ] Exigir `aud065_old_source_completed_v1` y después
  `aud065_old_source_verified_v1`; estado parcial, drift de UID/resourceVersion,
  denegación GHCR o digest inventado bloquean la fase sin editar OLD. Tras el
  CAS local, solo una renovación y aserción fresca del Lease permite rollback;
  pérdida de Lease o ACK ambiguo de release conserva el completado exacto y
  exige reentrada/reconciliación, nunca una restauración a ciegas.
- [ ] Ejecutar de nuevo el bridge Keychain para materializar NEW desde el OLD ya
  completo y exigir exactamente `aud065_new_values_prepared_from_keychain` y
  `aud065_new_values_verified`. NEW usa las credenciales nuevas pero conserva
  todos los workloads live y el binding runner exacto.

Regla de estado: mantener OLD, NEW y las credenciales bajo exclusión de
escritores. No crear
  todavía los snapshots sellados ni generar el manifiesto candidato.

Resultado: existen los artefactos finales y las dos fuentes completas de
rotación, pero el runtime live sigue byte/imagen-equivalente al baseline.

### Fase 5 — rotación coordinada de `AUD-065`

- [ ] Revalidar que el primer checkpoint conjunto sigue dentro de su TTL y que
  contexto, namespace UID, PVC UID, commits, workload digests, DB y storage no
  han derivado desde su creación; repetirlo antes de `plan` ante cualquier
  cambio.
- [ ] Ejecutar `rotate-process-local-credentials.sh plan`. Debe sellar exactamente
  OLD/NEW, validar GHCR OLD -> NEW contra cada digest aplicable y terminar solo
  con `aud065_plan_ready`; no permitir `execute` ni el primer CAS ante fallo.
- [ ] Confirmar que la recuperación one-way queda ligada al snapshot nuevo y al
  checkpoint. `rollback` solo se usa desde `db-rotated` o `bundle-applied`,
  converge al estado nuevo y nunca restaura una credencial anterior.
- [ ] Ejecutar la rotación interna coordinada sin revocar aún proveedores:
  materializar/aplicar exactamente `Secret/configs`, `Secret/ghcr-pull` y seis
  Deployments por CAS de UID/resourceVersion, verificando
  `ServiceAccount/default` sin mutarlo. Nunca usar patch, edición manual, apply
  parcial o el manifiesto candidato.
- [ ] Mantener los digests de workloads y `process-local` exactos. Reiniciar los
  consumidores requeridos, conservar `PERMS_KEY` idéntica entre Reticulum y
  Dialog y verificar únicamente por presencia/huella y gates funcionales
  estrechos.
- [ ] Ejecutar el auditor live de solo lectura y exigir exactamente
  `aud065_rotation_verified`. El verificador global y la carga fría pertenecen a
  Fase 7, después del candidato completo.
- [ ] Reejecutar el supervisor Actions con el mismo ítem NEW como reconciliación
  terminal y revalidar pull/upload no publicante. Después cerrar cada dominio:
  NEW aceptada, OLD revocada, OLD rechazada específicamente por autenticación y
  NEW aceptada otra vez. Timeout, DNS, rate limit o `5xx` no prueban revocación.
- [ ] Registrar únicamente nombres/estados de credenciales, nunca sus valores.

Resultado: el baseline anterior continúa sano con credenciales nuevas y
recuperación one-way; todavía no se ha desplegado el candidato.

### Fase 6 — preparar y desplegar el candidato de forma fail-closed

- [ ] Crear y validar un segundo checkpoint conjunto fresco del baseline ya
  rotado. Repetirlo si supera el TTL o cambian DB, storage, commits, digests,
  values o inventario relevantes; antes del cutover todavía debe registrar
  `legacy-absent` exacto.
- [ ] Desde la fuente canónica ya promovida por `AUD-065`, crear una operación
  privada ligada al segundo checkpoint y publicar una copia candidata bootstrap
  separada mediante el gestor versionado. El gestor vuelve a verificar el
  recibo y los cuatro bundles con un `DOCKER_CONFIG` efímero dentro del padre
  privado de la candidata, deriva sin overrides los digests finales de
  Hubs, Reticulum, parent y runner desde sus evidencias respectivas y fija la
  credencial GHCR NEW; no modificar los OLD/NEW sellados de la rotación.
- [ ] Exigir `aud065_candidate_values_created` y
  `aud065_candidate_values_verified`, además de recibo conjunto de procedencia,
  pulls de todos los digests GHCR, baseline exacto sellado y preservación
  byte-exacta de todo valor no autorizado.
- [ ] Ejecutar preflight final contra ese segundo checkpoint, commits y digests.
  Generar el manifiesto completo desde la copia candidata; nunca editar
  `hcce.yaml`.
- [ ] Fijar un destino staging aislado y context-pinned que no cree recursos
  DigitalOcean ni coste adicional. Si no existe una ruta aislada sobre la
  infraestructura actual y hiciera falta crear o ampliar recursos, detenerse en
  el cost gate y pedir autorización explícita; no llamar staging a un canary
  improvisado en producción.
- [ ] Desde Spoke y con checkpoint 2 ya válido, publicar en el contenido de
  staging los asientos previstos con `Disable motion`, `Can be occupied` y
  `Clickable`, conservar un `networked.id` estable y comprobar que
  `info@virtualmente.com` mantiene propiedad editable del proyecto `qa3U3Ke` y
  la escena `f6VKtim`. No editar geometría o waypoints fuera de Spoke.
- [ ] Aplicar en staging dos manifiestos completos y trackeados: primero
  Reticulum protocol 2 conservando el digest Hubs anterior y verificando
  migración, capability y compatibilidad legacy; después el digest Hubs
  candidato con la autoridad runner aún inerte. Correr la carrera de dos
  navegadores sobre el mismo asiento y exigir exactamente un ganador, pose
  remota idéntica, Stand, reclaim y release por desconexión. Solo esos mismos
  cuatro digests pueden pasar a producción.
- [ ] Ejecutar en producción el diff privado/redactado y aplicar la generación
  `bootstrap-server` únicamente con `KUBECTL_CONTEXT` exacto y `npm run apply`;
  Reticulum compatible y sus migraciones llegan primero, el digest Hubs live se
  conserva y la autoridad runner permanece inerte.
- [ ] Consumir el recibo exacto `bootstrap-server` para generar/aplicar la
  generación completa `bootstrap-client` con el digest Hubs ya aceptado en
  staging. Reiniciar Reticulum mediante el wrapper/runbook para renovar
  HTML/assets con hash y repetir capability/cold-load estrecho antes de avanzar.
- [ ] Revisar el inventario de `AUD-077`, registrar fingerprints redactados y
  aprobar o rechazar individualmente cada configuración; no existe aprobación
  masiva ni autostart de una configuración no aprobada. Avanzar la copia
  candidata únicamente al consumir el recibo `bootstrap-client` final del
  wrapper trackeado, regenerar/diff/apply y exigir policy, RBAC efectivo y probe
  negativo con el parent parado.
- [ ] Avanzar después `admission -> active` solo con el recibo admission
  encadenado, volver a verificar,
  regenerar/diff/apply y exigir `/transport-ready`, readiness autoritativa,
  NetworkPolicies exactas, un Pod runner por sala y cero huérfanos.
Regla de rollout: no usar `kubectl apply -f hcce.yaml`, parches manuales ni
atajos. Mantener
  Reticulum en una réplica, `Recreate`, sin HPA y con el contrato de `ret-pvc`.
Ante cualquier fallo, detener el rollout y usar el rollback publicado.

Resultado: producción ejecuta el candidato endurecido sin una ventana de
autoridad mixta; la promoción canónica final espera la aceptación.

### Fase 7 — aceptación y cierre

- [ ] Ejecutar `./deployment/verify-live-reactivation.sh` con cero fallos y cero
  avisos.
- [ ] Realizar carga fría desktop y móvil comprobando página, consola, red,
  `APP`, `AFRAME`, escena, assets, audio, UI española, cámara primera/tercera
  persona y layouts sin overflow, sin errores ni warnings first-party.
- [ ] Solicitar y consumir un magic link real con la credencial Mailtrap nueva,
  entrar con `info@virtualmente.com` y comprobar acceso operativo a sala y Admin
  sin registrar token, contenido del correo ni otros datos sensibles.
- [ ] Realizar un smoke de audio con dos sesiones aisladas que publiquen y
  consuman audio y alcancen signaling, ICE y `PeerConnection` conectado; no es
  una prueba de carga.
- [ ] Probar sitting con dos sesiones: exclusión, pose remota, stand, reclaim,
  desconexión e identidad publicada.
- [ ] Probar funcionalmente bots `0/5/10`, movilidades, navmesh+A*, rehidratación,
  readiness y una parada terminal; esto no es una certificación de capacidad.
- [ ] Probar `AUD-078` con runner activo: el `200 terminal` solo puede llegar
  después de observar la desaparición del nombre+UID y cero Pods gestionados de
  la sala.
- [ ] Probar una recuperación controlada de `AUD-078` mediante retry o reinicio
  de parent/claim y demostrar que no resucita ni deja runners huérfanos.
- [ ] Verificar casos negativos de aislamiento: el runner no recibe provider o
  master key, token de ServiceAccount, RBAC ni autoridad de acciones, y
  admission/PSA/cuota/NetworkPolicies rechazan las formas prohibidas.
- [ ] Probar chat privado, moderación, Structured Outputs, rate/token limits,
  safety ID y acciones allowlisted.
- [ ] Revisar logs de Hubs, Reticulum, parent y runner sin exponer su contenido
  sensible.
- [ ] Probar con contenido desechable el flujo GLB manual/provider-neutral,
  avatar normal y full-body, preview/import Admin y Featured; verificar además
  que `info@virtualmente.com` conserva propiedad y capacidad de edición/publicación
  del proyecto Spoke `qa3U3Ke` y la escena `f6VKtim`, sin republicar contenido
  permanente salvo el cambio de asientos ya aprobado.
- [ ] Verificar backup/restore y rollback en modo seguro previsto por el runbook;
  no ejecutar una restauración destructiva live como smoke.
- [ ] Después de alcanzar `P6` y la aceptación live, crear y validar un tercer
  checkpoint conjunto fresco con DB, `ret-pvc` y evidencia `durable-v2` del
  journal/HMAC; conservar una segunda copia cifrada. Los checkpoints 1 y 2 no
  sustituyen este artefacto posterior al cutover.
- [ ] Solo después de toda la aceptación live, promover por CAS la copia candidata
  `active` a la fuente canónica mediante el gestor versionado, exigiendo los
  recibos encadenados `active`, live 0/0 y cold-browser desktop/móvil, y conservar la
  copia sellada de la operación `AUD-065` como evidencia privada, sin reescribirla.
- [ ] Actualizar auditoría, evidencia, handoff, changelog, inventario y este plan
  con commits, PR, workflows, digests y resultados sin secretos.
- [ ] Confirmar root `main` limpio y submódulos en commits de sus ramas base.
- [ ] Marcar la meta completa solo cuando toda la definición de terminado esté
  satisfecha.

## Reglas anti-loop y de evidencia

1. Leer este fichero al empezar cada continuación y tomar solo la primera
   casilla pendiente de la fase activa.
2. Marcar una casilla únicamente con evidencia concreta: commit, PR, workflow,
   comando, cuenta exacta o resultado live.
3. No repetir un gate verde si no cambió ninguno de sus inputs. Tras cambios
   documentales se usa validación documental/estática proporcional. Si un gate
   falla, se corrige una causa concreta y con ello cambian sus inputs, una sola
   revalidación post-corrección es necesaria y no constituye un loop.
4. No confundir proceso activo, Pod Ready o HTTP 200 con aceptación funcional.
5. Integrar siempre el subrepo antes de actualizar y fusionar su puntero raíz.
6. Mantener feature, actualización upstream, dependencias y despliegue en
   cambios separados.
7. No declarar desplegado algo que solo está integrado o construido.
8. No ampliar el alcance con elementos de la sección «Fuera de esta meta».
9. Un bloqueo solo es real después de agotar alternativas seguras y registrar
   el error exacto; no se finge éxito ni se cambia de método.
10. Nunca imprimir, abrir, buscar ampliamente ni usar como evidencia un fichero
    privado que pueda contener secretos.
11. La auditoría general de proceso del 1 de agosto se ejecuta una sola vez. No
    reabrirla ni rediseñar trabajo ya verificado salvo evidencia nueva concreta;
    las revisiones futuras se limitan al diff material de cada PR y a su gate de
    aceptación correspondiente.

## Registro de avance

Este registro conserva los hitos escritos antes de consolidar `AGENTS.md`. No
añadir filas nuevas: el historial de sesión posterior pertenece exclusivamente a
`docs/session-changelog.md`; este plan solo actualiza estado, casillas y evidencia
resumida, siempre sin secretos.

| Fecha/hora | Fase y casilla | Evidencia | Resultado / siguiente casilla |
| --- | --- | --- | --- |
| 2026-07-18 | Creación de la meta acotada | Este documento | Reanudar en Fase 1, primera casilla pendiente |
| 2026-07-18 12:18 CEST | Fase 1: estado conservado | Root `HEAD=origin/main=0657ddcb1e33`, divergencia `0/0`; Hubs remoto `master=674ece411691`; Cloud remoto `master=5392495b0772`, `development=ebe960794735`; sin PR raíz previo | Continuar con coherencia documental de `AUD-075` |
| 2026-07-18 12:52 CEST | Fase 1: coherencia documental y checkpoint pre-rollout | Runbooks activos alineados con checkpoint+rotación antes de build, Cloud `5392495`, 58 recursos, ocho NetworkPolicies y `bootstrap -> admission -> active`; el gate bifurcado fail-closed pasa 223/223 regresiones y los focos de ambos modos | Revisar el diff raíz completo y confirmar su alcance |
| 2026-07-18 14:16 CEST | Fase 1: revisión de alcance y gates finales | Revisión independiente de 38 ficheros sin trabajo ajeno; gitlink Cloud exacto `5392495` limpio y en `origin/master`; `npm run apply` confirmado como wrapper del mismo manifiesto generado y `kubectl apply` bajo Lease/fencing/fases. `verify-project.sh` y `--full` verdes: seguridad 43/43, recuperación 239/239, Pods 45/45, pull 19/19, Deployment 18/18, Hubs 97/97 y build, navegador 11/11, capacidad 115/115 fail-closed, orquestador 128/128, Dialog 2/2, Photomnemonic 7/7, Spoke 68/68 y build, generador 30/30 con 58 recursos y Reticulum 430 + 5 | Preparar el diff staged, repetir checks estáticos proporcionales y crear el commit raíz; producción sigue intacta |
| 2026-07-18 14:17 CEST | Fase 1: precommit estático | `git diff --check`, Actionlint, ShellCheck completo y Gitleaks sobre root/Hubs/Cloud terminan con código 0; submódulos exactos Hubs `674ece` y Cloud `5392495` | Stagear únicamente los 38 ficheros revisados y verificar el diff cached antes del commit |
| 2026-07-18 14:18 CEST | Fase 1: revisión staged | Los 38 ficheros se añadieron explícitamente; `git diff --cached --check` termina con código 0, no quedan cambios unstaged ni untracked y el gitlink registra únicamente Cloud `0f151eb -> 5392495` | Crear el commit raíz y publicar el PR de Fase 1 |
| 2026-07-18 14:20 CEST | Fase 1: publicación del candidato | Commit raíz `9e7b860`, push de `codex/aud075-integration` y PR `meta-hubs #5` hacia `main`; el PR incluye este plan activo y declara explícitamente que no hubo mutación live | Esperar CI, corregir únicamente fallos reales y fusionar el PR |
| 2026-07-18 14:23 CEST | Fase 1: corrección CI focal | El run `29644117855` pasó gitlinks, Gitleaks y Actionlint, pero el ShellCheck Linux señaló `SC2317` en el callback `heartbeat_stop`, invocado indirectamente por `trap`; se amplió la supresión existente `SC2329` exclusivamente a `SC2317,SC2329`. `bash -n`, ShellCheck local y `git diff --check` vuelven a pasar | Publicar la corrección mínima y exigir un nuevo run verde sobre su SHA exacto |
| 2026-07-18 14:36 CEST | Fase 1: reproducibilidad desde clone limpio | Los runs `29644229034`/`29644229946` ya pasan ShellCheck, pero revelaron `Cannot find module 'yaml'`: el workflow instalaba solo el orquestador aunque dos verificadores raíz importan el parser declarado y lockeado por Community Edition. Workflow y `verify-project.sh` instalan ahora ambos paquetes propietarios con `npm ci --ignore-scripts --no-audit`; revisión independiente confirma la frontera. `verify-project.sh` vuelve a pasar con seguridad 43/43, recuperación 239/239, Gitleaks y auditoría upstream | Publicar el fix hermético y exigir dos ejecuciones CI verdes sobre el nuevo SHA |
| 2026-07-18 15:04 CEST | Fase 1: orden determinista del fail-close en Linux | Los runs `29644657391`/`29644658348` pasan instalación limpia y 43/43 gates de seguridad, pero Linux permite que el watcher de Pods detecte dos derivas parciales antes del gate semántico; ambos runs conservan parent a cero y lock retenido, aunque 237/239 tests exigen el diagnóstico exacto. `resume_writers` revalida ahora el modo antes de derivar namespaces, conserva el gate posterior TOCTOU y pasa el foco 61/61, ShellCheck y la suite completa 239/239 | Repetir checks estáticos, publicar el ajuste y exigir dos runs verdes sobre el SHA exacto |
| 2026-07-18 15:04 CEST | Preparación de Fase 2, solo lectura | Auditoría independiente confirma que el checkpoint `process-local` es fail-closed, pero no existe todavía coordinador compliant para rotar el rol PostgreSQL, atestar `PERMS_KEY` por huella ni producir un diff redactado sin adelantar `AUD-075`; el fichero privado solo está disponible como regular `0600` fuera del worktree candidato | Se añade Fase 2A de tooling antes de gastar el checkpoint/TTL; Fase 1 continúa siendo la activa y producción permanece intacta |
| 2026-07-18 15:19 CEST | Cierre de Fase 1 y transición a Fase 2A | Runs Linux exactos `29645630814`/`29645631723` verdes sobre `ee47dd3`; PR raíz `#5` fusionado como `main=9f4ada1`. `main` fija Hubs `674ece411691` y Cloud `5392495b0772`, ambos existentes en sus ramas base. El worktree canónico limpio pasa a `codex/aud065-process-local-rotation` y conserva el fichero privado únicamente como regular `0600`, sin abrirlo | Fase 1 cerrada sin mutación live; continuar en Fase 2A, primer tooling pendiente |
| 2026-07-18 16:21 CEST | Fase 2A: contrato previo a implementación live | El lock `AUD-065` pasa 18/18 fixtures con adquisición solo en `preflight`, transiciones CAS adyacentes, adopción exacta y release solo en `verified`; la librería DB pasa 54/54, apaga logging, muestreo y actividad antes del SQL sensible, y una prueba real PostgreSQL 14 descubrió/corrigió meta-comandos `psql` doblemente escapados. La revisión del Cloud histórico `5a82de5` confirmó 24 placeholders en `ret-config` y sustitución `turkeyCfg_*` dentro del pod; no contiene valores live. La suite de recuperación no afectada vuelve a 239/239. | Mantener `ret-config` invariante, reescribir el verificador redactado como consumidor del bundle exacto y añadir barrera CAS/probe para `pgsql-ingress`; ninguna casilla de tooling se cierra todavía y producción permanece intacta |
| 2026-07-18 17:51 CEST | Fase 2A: bindings durables y reentrada por recurso | El lock global ampliado pasa 25/25; la barrera `pgsql-ingress` con probe, UID/RV y rechazo ABA pasa 43/43; la transición DB conserva 54/54 y PostgreSQL real; el perfil histórico se contrasta de forma independiente contra las 42 identidades del template Cloud. El intent privado prequiescence, su barrier-binding y el terminal recuperable pasan 20/20, y el materializador/clasificador de `Secret/configs` más seis Deployments pasa 10/10. Una revisión detectó la circularidad entre lock y bundle antes de tocar live: se separó un operation binding previo del bundle binding posterior, encadenados por la misma clave HMAC. | Terminar el encadenado en preparer/verificador y el coordinador `plan/execute/resume`; no se adquirió Lease, no se consultó el clúster y producción sigue intacta |
| 2026-07-18 18:13 CEST | Fase 2A: cierre criptográfico y cortes de recuperación | Preparer 14/14, verificador redactado 21/21 y perfil/reentrada 30/30 encadenan intent, bundle, baseline original/quiesced, `PERMS_KEY` y la policy `open-verified`. El registro terminal exige barrier HMAC, hash del binding y valores finales esperados; su publicación atómica/reconciliable pasa 22/22. La barrera pasa 44/44 y ya rechaza confundir el `normal` inicial con un cleanup reanudado. La revisión independiente detectó antes del PR dos TOCTOU restantes en materialización/aplicación; se están eliminando junto al coordinador, cuya primera mitad pasa 15/15. | Autenticar y emitir cada candidato sin reabrir paths, completar todos los estados/cortes del coordinador y repetir gates; producción continúa intacta, sin Lease ni consultas live |
| 2026-07-18 20:33 CEST | Fase 2A: revisión final de operabilidad previa al PR | Tres revisiones independientes detectaron antes de fusionar: orden inválido de la fixture PostgreSQL externa, ausencia de validación temprana de `DB_PASS`, rotación incompleta de values candidatos, falta de promoción canónica y contratos de checkpoint/live que confundían `process-local` con `AUD-075`. El orden y `DB_PASS` ya están corregidos; pasan 20/20 tests del preparer y PostgreSQL 14.23 real por TCP+MD5 con inspección de logs. Se están ligando/promoviendo los values completos y separando de forma fail-closed los contratos `pgsql/postgresql`+`BOT_ACCESS_KEY` del baseline y `pgsql/pgsql` del candidato. | Cerrar estos dos contratos y su gate live específico antes de declarar Fase 2A completa; siguen ausentes PR/CI/merge, checkpoint y toda mutación de producción |
| 2026-07-19 00:46 CEST | Fase 2A: bloqueo GHCR previo al merge | Los runs `29663204419`/`29663205680` llegaron a seguridad 47/47 y recuperación 243/243 y revelaron/cerraron una aserción GNU/BSD del fixture. Antes de fusionar, una auditoría independiente trazó el PAT compartido: el bundle y el auditor podían terminar verdes manteniendo `Secret/ghcr-pull` antiguo y `ServiceAccount/default` fuera de sus bindings. Revocar después el PAT rompería pulls tras un reinicio aunque los Pods cacheados siguieran Ready; la ruta histórica `apply`/`patch` está prohibida. | Añadir los dos recursos auxiliares a la captura privada, reemplazar solo `ghcr-pull` por CAS bajo el mismo Lease, verificar `default` como invariante, cubrir reentrada/rollback/redacción y repetir gates/CI. PR `#6` permanece abierto y producción intacta. |
| 2026-07-19 01:29 CEST | Fase 2A: revisión adversarial del cierre GHCR | La captura/preparación exigen ahora 44 recursos operativos; el bundle aplica por prefijo 2 Secrets más 6 Deployments y liga 16 recursos, con `ServiceAccount/default` bind-only. La estructura live de `ghcr-pull` se inspeccionó de forma redactada y reveló la forma histórica `metadata.annotations:{}` del last-applied, ya cubierta. Materialización 18/18, coordinador 154/154 y auditoría 31/31 están verdes. Dos revisiones cerraron un falso exit 0 del harness, una afirmación de ausencia no demostrable, ABA de RV final y riesgo de stream interactivo. Detectaron además que faltaba demostrar permisos reales del PAT nuevo antes del primer CAS. | Integrar el gate de red old+new para todos los digests GHCR fijados más runner antes de lock/mutación y revalidarlo antes del restart; después repetir el agregado, seguridad, recuperación, revisión, CI y merge. Producción no fue mutada. |
| 2026-07-19 02:03 CEST | Fase 2A: gate GHCR online y agregado local final | El gate lee snapshots privados estables, autentica por pull cada digest GHCR aplicable más runner y exige el digest exacto. `plan` y execute/resume/rollback prueban OLD -> NEW; cualquier fallo libera el Lease antes del operation lock/callbacks. NEW se revalida antes del primer pool y en audit. El coordinador final pasa 163/163 y el agregador de 15 suites termina con `exit 0`, incluidos GHCR 44/44, materialización 18/18 y auditoría 31/31. Dos revisiones independientes no encuentran falsos verdes P1/P2. | Ejecutar seguridad, recuperación y gates raíz/estáticos; publicar el nuevo SHA, exigir CI verde y fusionar PR `#6`. Producción permanece intacta. |
| 2026-07-19 02:44 CEST | Fase 2A: gates raíz finales | `verify-project.sh` y `verify-project.sh --full` terminan con código 0 sobre el árbol final. Pasan seguridad 47/47, recuperación 243/243, el agregado AUD-065, Actionlint, ShellCheck, tres escaneos Gitleaks y auditoría upstream; además Hubs 97/97 y build, Admin, navegador 11/11, capacidad 115/115 fail-closed, servicios CE, Spoke 68/68 y build, y Reticulum 430 tests + 5 properties. | Revisar/stagear el diff exacto, crear y publicar el commit, exigir el nuevo CI verde y fusionar PR `#6`; no crear aún checkpoint ni mutar producción. |
Esa afirmación pertenecía al cierre histórico de Fase 2A. En la Fase 3B actual,
la copia autoritativa es la del worktree `YenHubs-aud078-root` indicada en el
panel superior. La autoridad volverá a `/Users/Shared/Gits/YenHubs` únicamente
después de fusionar el PR raíz y sincronizar un `main=origin/main` limpio.

## Prompt de meta

Copiar literalmente el siguiente texto como meta:

```text
Completa el cierre seguro y endurecido de YenHubs siguiendo
la copia trackeada de docs/active-goal-plan-2026-07-18.md en el worktree raíz
activo declarado en su panel superior y respetando también AGENTS.md. En el
punto actual la fuente exacta es
/Users/Shared/Gits/YenHubs-aud078-root/docs/active-goal-plan-2026-07-18.md;
después de fusionar el PR raíz de Fase 3B, sincroniza un
/Users/Shared/Gits/YenHubs limpio en main, actualiza el campo Worktree activo y
continúa desde esa copia. Nunca reanudes desde aud075/aud076/aud077.

Reanuda desde la primera acción del panel operativo y trabaja una sola casilla
de la fase activa cada vez. Actualiza en el plan solo estado, casillas y
evidencia resumida; registra el historial exclusivamente en
docs/session-changelog.md. No repitas gates o auditorías verdes salvo cambio
material de inputs o un fallo concreto. Conserva el runtime que ya funciona,
no expongas secretos y no mutes producción antes de los checkpoints y gates
exigidos.

Integra subrepositorios antes que sus punteros raíz. Construye únicamente por
GitHub Actions las imágenes Hubs, Reticulum, parent y runner, fija sus digests y
procedencia, ejecuta staging Reticulum-first/Hubs-second con sitting v2 y
promueve exactamente los mismos digests mediante el flujo fail-closed
publicado. No termines en la integración de código: continúa hasta aceptación
live, checkpoint durable final y cierre documental, o registra con evidencia un
bloqueo externo real.

Respeta lo que el plan declara fuera de alcance: no certifiques
30/100/300/10.000 usuarios, no conviertas Reticulum en multi-réplica, no
modernices masivamente Spoke/dependencias, no incorpores upstream/master y no
añadas VR, SaaS de avatares o infraestructura no necesaria. No pidas
aprobaciones rutinarias ya concedidas, pero conserva los gates de seguridad,
coste, rollback y protección de datos.
```
