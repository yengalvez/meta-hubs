# Meta activa de YenHubs: cierre seguro y runtime endurecido

Última actualización: 18 de julio de 2026

Estado actual: **EN EJECUCIÓN; Fase 2A, tooling de rotación `AUD-065`**

Worktree inicial: `/Users/Shared/Gits/YenHubs-aud075-root`

Rama inicial: `codex/aud075-integration`

Worktree activo: `/Users/Shared/Gits/YenHubs`

Rama activa: `codex/aud065-process-local-rotation`

Este documento es la fuente de verdad de la meta activa. El detalle histórico y
las cuentas completas de pruebas se conservan en
`docs/completion-plan-2026-07-18.md`; no deben utilizarse para ampliar el alcance
de esta meta.

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

## Estado de partida confirmado

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
- [x] El diseño de `AUD-078` está auditado; su implementación está pendiente.
- [x] No se ha construido ni desplegado el nuevo runtime y producción no fue
  mutada por `AUD-075`.

## Definición de terminado

La meta solo puede marcarse completa cuando se cumpla todo lo siguiente:

- [ ] `AUD-075` y `AUD-078` pertenecen a las ramas base correspondientes y el
  root `main` fija exactamente esos commits.
- [ ] Existe un checkpoint fresco, verificable y restaurable con DB y storage.
- [ ] Las credenciales afectadas por `AUD-065` fueron rotadas; las anteriores
  están revocadas o rechazadas cuando exista una comprobación segura.
- [ ] Parent y runner proceden del mismo commit Cloud, fueron construidos por
  Actions y se ejecutan mediante digests inmutables.
- [ ] Producción usa el protocolo compatible de sitting, fencing DB,
  aprobación/cuarentena, Pods runner aislados y parada terminal de `AUD-078`.
- [ ] `verify-live-reactivation.sh` termina con cero fallos y cero avisos.
- [ ] Una carga fría desktop y móvil demuestra `APP`, `AFRAME`, escena, audio,
  sitting, bots y chat sin errores ni respuestas anómalas.
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
  corregir especialmente cualquier orden que permita build antes de
  checkpoint+rotación, además de conteos antiguos de recursos/policies y el
  rollout anterior de dos fases.
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

### Fase 2 — cerrar inmediatamente `AUD-065`

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
- [ ] Cubrir coordinador, fallo parcial, rollback y redacción con fixtures; pasar
  los gates proporcionales, revisión independiente, PR/CI y merge antes de crear
  el checkpoint live.

Evidencia local aceptada el 2026-07-18, todavía sin PR/CI/merge ni acceso al
clúster: el agregador de 14 suites terminó con `exit 0` (lock 27/27, barrera
56/56, transición DB 54/54 más PostgreSQL real, coordinador 153/153, perfil
30/30, operación 34/34, source 20/20, prepare 20/20, materialización 18/18,
publicación privada 13/13, proyección 6/6, captura 6/6 y verificador redactado
28/28). Pasaron además seguridad 47/47, recuperación 243/243, Bash,
ShellCheck, sintaxis Node/Python, Actionlint, `git diff --check` y Gitleaks sobre
6,75 MB sin filtraciones. Las revisiones independientes finales no dejan P1/P2
abiertos; detectaron y cerraron antes de esta evidencia el TTL del checkpoint,
el preflight Python, la reentrada de materialización y dos falsos TOCTOU por
`nlink` de directorios.

Resultado intermedio: existe una ruta reproducible para rotar el runtime que ya
funciona sin adelantar el candidato ni revelar secretos.

#### Fase 2B — preparar credenciales sin invalidar todavía el baseline

- [ ] Crear por canales privados las credenciales externas nuevas necesarias y
  preparar las internas nuevas, manteniendo válidas las anteriores hasta que el
  rollout coordinado haya sido aceptado.
- [ ] Hacer disponible el fichero privado en el worktree final mediante una ruta
  absoluta o una copia regular `0600`, nunca mediante Git, symlink, chat o
  salida de terminal; no abrirlo ni usarlo como evidencia.
- [ ] Preparar values anterior/nuevo y rollback como snapshots privados `0600`,
  comprobando solo esquema, presencia y huellas.

#### Fase 2C — checkpoint y rotación inmediata

- [ ] Confirmar contexto Kubernetes, namespace, UID, PVC, Deployments e imágenes
  mediante rutas redactadas; no abrir ni imprimir manifiestos privados.
- [ ] Crear un checkpoint nuevo con `./deployment/create-checkpoint.sh` que
  incluya PostgreSQL y `ret-pvc`.
- [ ] Verificar `SHA256SUMS`, gzip, contrato DB, pares de storage y restore
  dry-run.
- [ ] Conservar una segunda copia cifrada del checkpoint fuera del equipo cuando
  el runbook lo exija.
- [ ] Rotar coordinadamente todas las credenciales incluidas en el alcance
  preventivo de `AUD-065`, sin copiarlas a Git, tarea, chat o salida de terminal.
- [ ] Separar credenciales externas de las internas del runtime y aplicar estas
  últimas coordinadamente mediante el bundle `AUD-065` generado por código
  trackeado: materializar y aplicar exactamente `Secret/configs` y seis
  Deployments mediante CAS de UID/resourceVersion de Kubernetes. El manifiesto
  Hubs CE completo queda intacto porque el generador actual representa el
  candidato `AUD-075`, no el baseline live `process-local`; nunca usar
  `kubectl patch`, edición manual de Secrets, un apply parcial ad hoc ni
  hotpatches.
- [ ] Mantener los digests y el modo `process-local` exactos que ya están live;
  verificar por contrato redactado que el bundle no adelanta `AUD-075` ni
  introduce cambios de workload ajenos a la rotación. Promover los values por
  rename atómico bajo exclusión absoluta de otros escritores del mismo usuario:
  esa promoción no se considera un CAS linealizable frente a procesos ajenos.
- [ ] Reiniciar todos los consumidores que correspondan y mantener `PERMS_KEY`
  idéntica en Reticulum y Dialog, comprobando únicamente su paridad por huella.
- [ ] Verificar por presencia/huella, revocación o rechazo seguro de valores
  anteriores, pulls GHCR y filtros de logs.
- [ ] Ejecutar el auditor live de solo lectura de `AUD-065` y exigir el token
  exacto `aud065_rotation_verified`; comprobar además los smokes funcionales
  estrechos de chat, magic-link, pulls y proveedores aplicables. El verificador
  global `verify-live-reactivation.sh` con 0/0 y la carga fría desktop/móvil
  permanecen en Fase 6, después de desplegar `AUD-075` y `AUD-078`.
- [ ] Preparar y verificar, sin revelar secretos, la recuperación one-way del
  mismo baseline y los mismos digests fijados en el checkpoint, usando
  exclusivamente las credenciales nuevas; un restore nunca debe reactivar
  credenciales revocadas. El rollback a imágenes anteriores corresponde al
  rollout candidato posterior, no a `AUD-065`.
- [ ] Registrar únicamente qué credenciales fueron rotadas y su estado, nunca
  sus valores.

Resultado: el servicio anterior continúa sano, existe rollback completo y las
credenciales potencialmente expuestas dejan de ser válidas.

### Fase 3 — implementar `AUD-078` de forma aislada

- [ ] Crear una rama Cloud nueva desde `master`; no mezclarla con `AUD-075`,
  dependencias, upstream ni infraestructura no relacionada.
- [ ] Añadir `runtime_revision` durable y outbox PostgreSQL transaccional.
- [ ] Encolar config/stop en la misma transacción que aprobación, cuarentena y
  revoke epoch.
- [ ] Implementar claims recuperables con CAS, expiración, retry y orden estricto
  por sala.
- [ ] Impedir que un snapshot posterior atraviese un stop pendiente.
- [ ] Considerar terminal una parada solo después de observar ausencia del
  nombre+UID y cero Pods gestionados de la sala.
- [ ] Cubrir `202`, timeout, `2xx` legacy, ABA, Pod desconocido, creación tardía,
  reinicio y pérdida de claim.
- [ ] Verificar migraciones PostgreSQL 12/14, Reticulum, orquestador, generador,
  seguridad y rollback.
- [ ] PR Cloud hacia `development`, promoción separada a `master` y CI verde.
- [ ] Actualizar después el gitlink raíz en una rama/PR raíz propia y fusionarlo.

Resultado: Reticulum no declara una parada completa mientras quede o reaparezca
un runner gestionado para la sala.

### Fase 4 — construir artefactos publicables

- [ ] Ejecutar la auditoría upstream de solo lectura y registrar el resultado;
  no incorporar upstream dentro de esta meta.
- [ ] Identificar únicamente las imágenes cuyo código cambió.
- [ ] Construirlas mediante los workflows GitHub Actions aprobados.
- [ ] Detenerse ante fallos de Actions o GHCR; no usar builds dentro del clúster,
  hotpatches, `kubectl cp`, `kubectl set image` ni reemplazos manuales.
- [ ] Exigir que parent y runner procedan del mismo commit Cloud.
- [ ] Capturar y fijar los digests sin imprimir valores privados.
- [ ] Regenerar el manifiesto desde valores locales y verificar el inventario
  exacto; nunca editar `hcce.yaml` a mano.
- [ ] Ejecutar preflight final contra checkpoint, commits y digests exactos.

Resultado: todos los artefactos candidatos tienen procedencia y rollback, pero
aún no se han aplicado.

### Fase 5 — desplegar de forma fail-closed

- [ ] Confirmar de nuevo contexto, checkpoint, rotación y preflight justo antes
  de la primera mutación.
- [ ] Revalidar la frescura exigida del checkpoint y repetirlo si ha superado el
  TTL o si cambiaron DB, storage, commits, digests o inventario relevantes.
- [ ] Ejecutar `kubectl diff` mediante la ruta privada/redactada sin mostrar
  cuerpos de Secrets.
- [ ] Desplegar primero Reticulum compatible y sus migraciones.
- [ ] Revisar el inventario redactado creado por `AUD-077` y aprobar o poner en
  cuarentena cada configuración individualmente.
- [ ] Regenerar y aplicar sucesivamente las fases `bootstrap`, `admission` y
  `active` exclusivamente con el wrapper `npm run apply` y contexto exacto.
- [ ] No usar `kubectl apply -f hcce.yaml` directamente ni parches manuales.
- [ ] Mantener Reticulum en una réplica, `Recreate`, sin HPA y con el contrato
  vigente de `ret-pvc`.
- [ ] Si cambia la imagen Hubs, reiniciar Reticulum según el runbook para renovar
  HTML y assets con hash.
- [ ] Confirmar Deployments por digest, RBAC/admission/NetworkPolicies exactos,
  un Pod runner por sala y ausencia de runners huérfanos.
- [ ] Ante cualquier fallo, detener el rollout y usar el rollback publicado; no
  improvisar otro método.

Resultado: producción ejecuta el candidato endurecido sin una ventana de
autoridad mixta.

### Fase 6 — aceptación y cierre

- [ ] Ejecutar `./deployment/verify-live-reactivation.sh` con cero fallos y cero
  avisos.
- [ ] Realizar carga fría desktop y móvil comprobando página, consola, red,
  `APP`, `AFRAME`, escena, assets y audio.
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
- [ ] Probar el flujo GLB manual/provider-neutral y Spoke únicamente en la medida
  necesaria para demostrar que el rollout no los rompió.
- [ ] Verificar backup/restore y rollback en modo seguro previsto por el runbook;
  no ejecutar una restauración destructiva live como smoke.
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
   documentales se usa validación documental/estática proporcional.
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

## Registro de avance

Añadir una fila después de cada hito; no usar este registro para guardar
secretos ni reemplazar la evidencia original.

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

La copia autoritativa está ahora en `/Users/Shared/Gits/YenHubs` con la misma
ruta relativa. El worktree anterior se conserva solo como evidencia hasta que
la transición y el primer commit de Fase 2A queden publicados; no se reanuda
trabajo desde él.

## Prompt de meta

Copiar literalmente el siguiente texto como meta:

```text
Completa el cierre seguro y endurecido de YenHubs siguiendo
/Users/Shared/Gits/YenHubs/docs/active-goal-plan-2026-07-18.md
como única fuente de verdad operativa y respetando también AGENTS.md. Reanuda
desde la primera casilla pendiente
de la fase activa, actualiza el propio Markdown tras cada evidencia y no repitas
gates verdes salvo que hayan cambiado sus inputs. Conserva el runtime que ya
funciona, no expongas secretos y no mutes producción antes de disponer del
checkpoint y las comprobaciones exigidas. Integra subrepositorios antes que sus
punteros raíz, usa únicamente GitHub Actions para imágenes, despliega mediante el
flujo fail-closed publicado y no termines en la integración de código: continúa
hasta la aceptación live y el cierre documental, o registra con evidencia un
bloqueo externo real. Respeta explícitamente lo que el plan declara fuera de
alcance: no certifiques 30/100/300/10.000 usuarios, no conviertas Reticulum en
multi-réplica, no modernices masivamente Spoke/dependencias, no incorpores
upstream/master y no añadas trabajos de VR, SaaS de avatares o infraestructura
no necesaria. No pidas aprobaciones rutinarias ya concedidas, pero mantén todos
los gates de seguridad, coste, rollback y protección de datos del repositorio.
```
