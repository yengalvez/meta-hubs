# HISTORICO: meta de recovery avanzado congelada el 9 de agosto de 2026

Este documento se conserva solo como evidencia. No es una fuente de reanudacion.

# Meta anterior: cerrar la plataforma YenHubs y volver a desarrollar features

Última verificación: **9 de agosto de 2026 (Europe/Madrid)**

Estado: **objetivo activo; P1.3 cerrado y P1.4 en curso como primera
implementación local**

Fuente única de orden y estado de la meta: **este fichero**

Explicación humana: `docs/estado-sencillo.md`

Auditoría vigente: `docs/audit-general-2026-08-08.md`

## Panel operativo

| Campo | Estado |
| --- | --- |
| Worktree operativo | `/Users/Shared/Gits/YenHubs` |
| Rama activa / base local | `codex/recovery-closure` / `origin/main=9c1b85be99a797c219022b0dd506b0be5ebd026b` |
| Candidato rechazado | PR raíz `#15`, head `9315efb69f96755feb61f157509495eb935ff368`, abierto/draft/UNSTABLE; **congelado, no fusionar ni añadir commits** |
| Producción | no modificada; 12/12 Deployments listos; baseline anterior `process-local` |
| Progreso | ≈45% de la meta completa; 8/23 es solo el ledger de casillas y P1.4 recovery está ≈85%; no mezclar esos tres indicadores ni recalcular el global hasta cerrar una casilla |
| Bloqueo real | ninguno externo; P1.4 continúa por tres grupos finitos de aceptación de `execute` |
| Evidencia local | `6d2b0f9` helper/keyring, `75ab970` autoridad HMAC, `3a6d6ad` reducción automática y `0e33acb` `plan` manual; `execute`: positivos `48/48`, takeover `16/16`, lost-response `21/21` y drift `14/14` por grupos disjuntos; drift terminó `59/59` con controles comunes en `270,69` s |
| Acción actual | P1.4: ejecutar únicamente el grupo TERM de `6` casos; positivos, takeover, lost-response y drift quedan congelados |
| Primera acción siguiente | comprobar TERM en las seis fronteras enumeradas de `execute`; cada señal debe recolectar procesos locales, conservar o liberar autoridad exactamente según la frontera y no filtrar datos privados |
| GitHub ahora | nada; no publicar hasta congelar un candidato verde local |
| Coste | topología existente ≈ USD 65/mes; auditoría añadió USD 0 |
| Condición de parada | mismo fallo sin nueva evidencia, expansión arquitectónica, secreto, producción o coste no previsto |

## Resultado buscado

Entregar el runtime endurecido de YenHubs sobre las releases estables aceptadas,
sin perder la sala, usuarios, proyectos o medios, y dejar demostrado en un
entorno real:

- UI Aurora en español, login/Admin/Spoke, desktop y móvil;
- primera y tercera persona, audio y avatares GLB privados/full-body;
- sitting autoritativo con un único ocupante;
- bots `0..10`, navmesh, runner aislado y chat privado con IA;
- checkpoint/restauración de PostgreSQL **y** `ret-pvc`, rollback y digests;
- una base actualizable cuando aparezca una nueva release estable de Hubs.

No se añaden nuevas features hasta cerrar esta meta. Cerrarla no significa
certificar escala masiva, VR ni un SaaS de avatares.

## Reglas anti-loop y de alcance

1. Una hipótesis se prueba primero con un foco Linux; no se publica para ver qué
   pasa.
2. Un solo full por candidato congelado y un solo CI por SHA/material PR.
3. `--full` subsume el gate normal cuando ejecuta la misma parte común; no correr
   ambos consecutivamente sobre los mismos bytes.
4. Monitorizar directamente cada run hasta terminal; no esperar un heartbeat.
5. No añadir protocols, monitors, fences, receipts, objetos Kubernetes ni
   matrices para cerrar los cinco casos. Excepciones aprobadas y cerradas: una
   autoridad JSON redactada dentro del ConfigMap-lock `checkpoint-backup` ya
   existente y un keyring privado externo append-only dedicado exclusivamente a
   custodiar records HMAC inmutables; no tiene registry, estado activo,
   rotación online, autoridad de runtime ni segundo protocolo.
6. Un cambio coherente por PR: recovery, Hubs/tests, workflow Cloud y gitlinks no
   se mezclan sin necesidad.
7. No abrir, imprimir ni buscar values/manifiestos ignorados. Solo presencia y
   huellas redactadas.
8. Nada de builds locales como entregable, `kubectl apply` manual, hotpatches,
   recursos DigitalOcean nuevos o imágenes sin digest.
9. Actualizar este panel y `docs/estado-sencillo.md` solo al cambiar de acción o
   cerrar un hito; la cronología va al changelog.
10. Antes de iniciar un run Actions, comprobar billing/allowance en solo lectura.
    Si existe posibilidad de importe facturado mayor que USD 0, parar y avisar;
    ninguna autorización general sustituye este cost gate.
11. Mantener un ledger de evidencia por hash y selector. Un caso verde no se
    repite si no cambian sus bytes o su oráculo. Un cambio test-only ejecuta
    únicamente las aserciones afectadas; el full se reserva al candidato final.
12. Dos ejecuciones solapadas sobre el mismo harness invalidan ambas como
    aceptación. El solapamiento detectado el 9 de agosto queda descartado; solo
    cuenta la pasada posterior sobre el hash congelado
    `48a3ed389a4cda1f69571b6206226f1003925d14`.
13. La matriz lost-response no es una nueva feature ni una expansión del
    protocolo: verifica 21 fronteras de una única regla fail-closed. Quedó
    `21/21` mediante grupos disjuntos; no repetirla ni crear otra matriz o
    mecanismo.
14. La estimación global se fija en ≈45% hasta cerrar una casilla completa. El
    `8/23` es un ledger sin ponderar y el ≈85% describe solo P1.4; ninguna de
    esas cifras se sustituye por una estimación conversacional sin denominador.

## Cómo leer cada casilla

- **Por qué/entrada**: necesidad y evidencia previa.
- **Resultado/cierre**: artefacto y prueba exacta que permiten marcarla.
- **Frontera**: dependencia externa o acción sensible.

## Fase 0 — Auditoría y reconstrucción del rumbo

- [x] **P0.1 Revalidar estado factual.**
  - Por qué/entrada: el plan anterior mezclaba `861/861`, `859/864` e historia.
  - Resultado/cierre: Git, PR/CI, runtime, DO, upstream y worktrees contrastados
    en `docs/audit-general-2026-08-08.md`.
  - Frontera: solo lectura; sin producción, secretos, coste ni gates largos.

- [x] **P0.2 Auditar producto y update-friendly con red-team.**
  - Por qué/entrada: confirmar que el trabajo sirve al metaverso solicitado.
  - Resultado/cierre: necesidades, sobretrabajo, brechas GLB/cámara/idioma y
    conflictos futuros clasificados; objeciones adversariales resueltas.
  - Frontera: cinco agentes read-only; ninguna mutación externa.

- [x] **P0.3 Dejar una sola fuente de verdad.**
  - Por qué/entrada: 1.390 líneas y 74 casillas abiertas impedían saber qué
    quedaba.
  - Resultado/cierre: este plan reconstruido, auditoría vigente, índice y panel
    humano sincronizados; documentos de julio marcados históricos.
  - Frontera: documentación local únicamente.

## Fase 1 — Cerrar recovery sin otra ronda de hipótesis

- [x] **P1.1 Preparar el sucesor limpio y preservar la auditoría.**
  - Por qué/entrada: `#15` mezcla arreglos demostrados con fixtures refutados y
    el checkout contiene documentación local que no debe perderse.
  - Resultado/cierre: branch/worktree `codex/recovery-closure` desde
    `origin/main`, documentos trasladados y diff inicial vacío de hipótesis;
    `#15` queda congelado como evidencia.
  - Evidencia: la rama parte de `9c1b85b`, contiene únicamente 18 documentos y
    conserva los gitlinks; `codex/project-security-timeout` y el PR raíz `#15`
    siguen inmóviles en `9315efb`.
  - Frontera: Git local; sin push, PR, CI o producción.

- [x] **P1.2 Cerrar el diagnóstico causal del 402 con un NO-GO explícito.**
  - Por qué/entrada: ARM reproduce 402, pero `monitor-prepare` no identifica si
    falla preparación, salud, stop/join o ausencia posterior.
  - Evidencia terminal: el contrato final reproduce en ARM, foco x86 completo,
    `2/2` variantes writer y `3/3` variantes ordinarias; siempre deja el parent
    en `0` y el lock retenido. Quedan refutados arquitectura, orden del full,
    wrapper writer y pacing de 20 ms. `automatic=present|absent` varía y el
    subpaso sigue `none`, así que no se repite 402 ni se atribuye aún a producto.
  - Intento 478: la única ejecución no alcanzó la inyección de checksum; QEMU
    falló antes en `database-backup:stream` y el rollback terminó en
    `terminal-boundary:durable-stop`. No es evidencia sobre 478 ni explica 402,
    cuyo modo `process-local` no usa ese monitor. No repetir 478 ni comenzar
    764/766/768.
  - Foco durable: `durable-monitor-library` falla aislado `45/46` en `111.85` s.
    Localiza interferencia del wrapper/fixture durable, pero es ortogonal a 402
    `process-local`; ese carril queda cerrado sin repetirlo.
  - Auditoría CFG: `step=none` excluye las 13 salidas instrumentadas de
    `prepare_runner_monitor_for_resume()`, pero deja ocho familias posteriores
    de `resume_writers()`; `automatic=absent` contradice un flujo que obliga a
    emitir etapa/código y confirma observabilidad incompleta. El transcript no
    puede recuperar la arista causal.
  - Primer microselector inválido: la preparación común pasó `45/45`, pero el
    selector terminó `monitor_prepare_step:mode` en `76.30` s. La autopsia
    demostró que, tras `source`, el propio test no restauró stamp, SHA del dump
    y SHA del storage; el lock no podía validar y no se alcanzó el objetivo.
  - Excepción red-team: corregir exclusivamente esas tres huellas reproduce el
    contrato que producción sí establece y constituye bytes/precondiciones
    distintos, no otra muestra de 402. Tras revisión se permite **una única
    ejecución válida** del selector; PASS separa la preparación del estado
    global y un enum localiza la primera frontera. Cualquier salida es hard stop.
  - Resultado válido: el selector corregido termina `45/45`, exit `0`, en
    `84.58` s y atraviesa modo, parent/contrato/cero, consumer-zero,
    delete/wait/ausencia y start/health del watcher. Queda descartado un defecto
    determinista de esas primitives aisladas; no demuestra si el flujo integral
    construye otro estado por producto o por fixture.
  - Resultado estático terminal: el camino 402 entra con el parent `0/rv2`, los
    otros cuatro writers `1/rv1`, receipts ausentes y watcher aún no creado; el
    microselector termina justo después de preparar el watcher y no consume los
    contratos/receipts de los cinco writers ni su stop/boundary. El marcador
    `waited` solo provoca el fallo inicial y no domina el rollback posterior.
  - Permanecen al menos dos familias independientes y no existe una arista
    exclusiva que clasifique producto frente a fixture. Se agotó el hard stop:
    no se permiten más 402/478/durable/microselector ni 764/766/768.
  - Resultado/cierre: **diagnóstico terminado, no defecto corregido**. El NO-GO
    evita fingir una causa y traslada la obligación técnica a P1.3.
  - Frontera: las VM ARM/x86 quedan apagadas y preservadas; sin full, secretos,
    GitHub, producción o coste.

- [x] **P1.3 Reducir el contrato de reanudación automática ambigua.**
  - Por qué/entrada: `1d45626` enlaza 51 ficheros, receipts, `FINAL`, identidad
    de PID y segunda pasada; seguir instrumentándolo repetiría el loop, pero un
    revert bruto también retiraría controles necesarios.
  - Decisión: preservar checkpoint conjunto PostgreSQL + `ret-pvc`, Lease/lock
    global, inventario de réplicas, orden parent-first, CAS exacto, fence durable
    y fail-closed. Conservar auto-reanudación solo cuando el resultado sea
    inequívoco; un PATCH/JOIN/respuesta perdida ambigua retiene autoridad y usa
    un procedimiento manual redactado, sin liberar el lock a ciegas.
  - Hallazgo de coherencia: el lock actual no guarda UID/escala/spec/fence
    suficientes y el staging se elimina; prohibir todo estado nuevo hacía
    imposible el propio runbook manual tras perder el host.
  - Excepción de alcance aprobada: persistir una sola autoridad canónica y
    redactada dentro de `data["checkpoint-backup-authority.json"]` del mismo
    lock inmutable. No se crea objeto, monitor, receipt, fence ni protocolo
    paralelo. Se permite un keyring privado externo append-only solo como
    custodia de records HMAC inmutables; no contiene registry, estado
    Kubernetes ni de producto.
    Restore y AUD-065 continúan exigiendo `data == {}`.
  - Resultado/cierre: `docs/recovery-reduction-design-2026-08-08.md` define
    keep/remove, HMAC de Deployment specs con keyring externo dedicado,
    canonicalización única, autoridad de Namespace/PVC, cinco consumidores y fence, generations/RV,
    takeover de Lease, plan/confirmación manual, allowlist y expectativas binarias para
    402/478/764/766/768. Las revisiones finales de seguridad, ejecutabilidad,
    coherencia y documentación terminaron GO, 0 P0/P1/P2.
  - Frontera: diseño estático local; producción permanece inmóvil. Cualquier
    segunda autoridad durable o imposibilidad residual implica STOP.

- [ ] **P1.4 Construir un sucesor coherente.**
  - Por qué/entrada: implementar el contrato reducido y conservar solo
    timeout/deduplicación, `ARG_MAX`, diagnóstico y cleanup Node respaldados por
    evidencia; nunca ramificar desde `#15`.
  - Resultado/cierre: diff revisable desde `origin/main`, autoridad lock
    redactada y HMAC sin oracle, reducción coherente de la reentrada automática,
    procedimiento `plan/execute` probado, temporal
    `yenhubs-live-deployments.*` con cleanup cooperativo y prueba de señal; sin
    los intentos de fixture refutados y sin fichero fuera de la allowlist del
    diseño.
  - Estado parcial aceptado: `6d2b0f9` implementa el helper canónico/HMAC y su
    keyring append-only; `75ab970` integra la autoridad redactada en el lock de
    backup, la propaga a hijos y monitores, conserva restore/AUD-065 owner-aware
    y elimina specs/fingerprints/anotaciones privadas de los argumentos del
    componente. `3a6d6ad` añade el latch previo al primer CAS, elimina del
    backup receipts y segunda reentrada automática, conserva lock/Lease/fence y
    emite un único `manual-recovery-required` ante cualquier ambigüedad
    postmutación; el camino inequívoco prueba `G -> G+1 -> G+2`, parent último y
    publicación posterior a los cinco rollouts. Restore conserva receipts y
    handoff exactos. Focos proporcionales, Gitleaks y cuatro revisiones
    independientes terminaron verdes, 0 P0/P1/P2. La cuarta unidad añade
    `recover-checkpoint-backup.sh plan` estrictamente de
    solo lectura: valida y recaptura lock, Lease expirada, keyring, Namespace,
    PVC, cinco Deployments, runner, fence y helpers; genera un plan canónico y
    una confirmación exacta/caducable sin mostrar autoridad privada. Su temporal
    `yenhubs-live-deployments.*` es `0600`, se limpia en salida normal y señales,
    y la matriz positiva, contrato, `21` hard-stops, redacción y TERM queda
    verde. Dos revisiones independientes terminaron GO, 0 P0/P1/P2.
  - Estado actual de `execute`: la implementación ya existe localmente. Los tres
    escenarios positivos terminaron `48/48`; takeover quedó `16/16`; las 21
    fronteras lost-response quedaron verdes mediante evidencia disjunta. La
    pasada limpia inicial fijó `14/19` retry y la corrección test-only repitió
    exclusivamente los cinco oráculos rojos: `50/50` con los controles comunes.
    Drift post-takeover quedó `14/14` en una única pasada: `59/59` contando los
    `45` controles comunes, `270,69` segundos; todos pararon antes del primer
    CAS y conservaron lock/Lease sin mutación de negocio.
  - Incidencia anti-loop: dos agentes ejecutaron accidentalmente el mismo foco
    en paralelo; sus resultados se descartaron y no se cuentan. Se congeló un
    único hash y se hizo una sola pasada limpia posterior. Los cinco oráculos
    se cerraron sin repetir los catorce casos ya verdes.
  - Pendiente finito para cerrar esta casilla: grupos TERM `6`, redacción `2` y
    terminal `6`; aceptación
    local estática/focal y dos revisiones finales. No full, GitHub ni producción
    antes de ello.
  - P1.4 continúa abierta; no se marca progreso adicional hasta cerrar toda esa
    evidencia y crear el commit coherente de `execute`.
  - Frontera: Git local; revisión independiente antes de publicar.

- [ ] **P1.5 Validar una vez el candidato congelado.**
  - Por qué/entrada: evitar que GitHub descubra otra hipótesis tras horas.
  - Resultado/cierre: focos aplicables verdes; `scripts/test-aud065.sh` verde;
    todos los casos recovery descubiertos verdes, incluidos los cinco contratos,
    registrando el total real; ShellCheck/Actionlint/Gitleaks aplicables; SHA y
    tiempos registrados.
  - Frontera: local; un solo full. No ejecutar normal y `--full` duplicados.

- [ ] **P1.6 Publicar, confirmar y fusionar el sucesor.**
  - Por qué/entrada: hace falta un checkout Ubuntu x64 limpio autoritativo.
  - Resultado/cierre: un PR sucesor, un CI integral verde sobre el mismo SHA,
    merge a `main`; cerrar `#15` sin merge y sincronizar el worktree canónico.
  - Frontera: GitHub obligatorio con cost gate USD 0. Misma firma roja => STOP,
    no quinta hipótesis.

## Fase 2 — Corregir verdad y regresiones visibles de Hubs

- [x] **P2.1 Cerrar la brecha documental GLB.**
  - Por qué/entrada: Reticulum limita forma de promoción/campos/tamaños, pero la
    validación GLB estructural y skeleton solo está en el cliente.
  - Resultado/cierre: documentos activos dicen exactamente esa frontera y
    registran el hardening backend como condicional a usuarios no confiables o
    evento público.
  - Frontera: documentación; no añadir parser a este rollout.

- [ ] **P2.2 Añadir regresiones pequeñas de cámara e idioma.**
  - Por qué/entrada: tercera persona y español existen, pero no tienen contrato
    directo suficiente para una nueva imagen Hubs.
  - Resultado/cierre: test de toggle/preferencia/prioridad VR; extractor
    JS/JSX/TS/TSX, allowlist de `contact-email`, dos claves TSX y cold browser
    `en-US` que sigue mostrando español.
  - Frontera: PR Hubs separado; CI Hubs una vez y cost gate USD 0. No bloquea
    P1.

- [x] **P2.3 Actualizar el inventario update-friendly.**
  - Por qué/entrada: contadores y SHAs de julio estaban obsoletos.
  - Resultado/cierre: inventario provisional Hubs `ce8390a`/Cloud `c0a3419`,
    contratos core, tests, conflictos y rollback. P3.2 refresca SHAs y contadores
    del corte final sin repetir el análisis upstream si no cambia el tag.
  - Frontera: documentación; repetir upstream audit solo si cambian tags/pins.

## Fase 3 — Producir una release trazable sin ceremonias propias

- [ ] **P3.1 Adaptar workflow, consumidores y diff como un cambio coordinado.**
  - Por qué/entrada: Reticulum, parent y runner deben salir de Actions, mientras
    coordinador/completers aún dependen de receipts retirados y el diff crudo
    puede mostrar Secret bodies. Separar productor y consumidor dejaría una ruta
    intermedia no ejecutable.
  - Resultado/cierre: PRs coordinados construyen **una sola vez** Reticulum,
    parent y runner, publican sus tres digests y attestations/SBOM nativos;
    completers implementan y prueban con fixtures el contrato de gitlinks, SHAs
    y cuatro digests sin receipts/bundles HMAC de procedencia/`invocationId`
    (no afecta al HMAC de autoridad del lock recovery), pero en este hito
    solo se materializan/verifican los tres Cloud. Tests de rechazo/cleanup
    verdes y comando trackeado de diff sin Secret bodies; instrucciones
    históricas retiradas o archivadas.
  - Frontera: GitHub/Cloud CI obligatorio con cost gate USD 0; no deploy y no
    retirar productores antes de que sus consumidores estén listos.

- [ ] **P3.2 Integrar gitlinks y ejecutar un único full raíz.**
  - Por qué/entrada: los subrepos se integran primero y root fija sus commits.
  - Resultado/cierre: PR root de punteros/docs después de P3.1, inventario
    update-friendly refrescado con SHAs/contadores finales, una sola invocación
    `--full` verde sobre todos los bytes consumidores y CI root verde sobre SHAs
    exactos.
  - Frontera: GitHub con cost gate USD 0; no repetir gates ya cubiertos por CI
    de subrepo.

- [ ] **P3.3 Construir Hubs y consolidar las cuatro imágenes definitivas.**
  - Por qué/entrada: Hubs aún necesita procedencia; Reticulum, parent y runner
    ya tienen los tres artefactos finales de P3.1 y no deben reconstruirse.
  - Resultado/cierre: un run Actions terminal verde construye Hubs; se registran
    su SHA/digest/attestation y se reutilizan exactamente los tres digests Cloud
    de P3.1. El completer verifica materialmente entonces los cuatro; pull
    preflight sin mostrar credenciales.
  - Frontera: GitHub/GHCR obligatorio con cost gate USD 0; construir no
    despliega ni repite imágenes sobre los mismos SHAs.

- [ ] **P3.4 Ensayo efímero Linux x64 con los mismos digests.**
  - Por qué/entrada: no existe staging DO y duplicar la pila en el nodo único es
    inseguro.
  - Resultado/cierre: `kind` efímero en el mismo ciclo de release con datos de
    prueba: Reticulum-first, Hubs-second, `bootstrap→admission→active`, dos
    clientes, checkpoint/restore conjunto y una referencia DB→media verificable,
    bots `0/5/10` con namespace por sala, Presence/ACK/readiness, navmesh,
    `mobility=static`, parada terminal y teardown verdes.
  - Frontera: se integra en el run ya aprobado; no crea nodo, LB ni volumen DO.
    Si aumenta un importe GitHub facturable sobre USD 0, STOP.

## Fase 4 — Preparar la ventana real sin perder datos

- [ ] **P4.1 Preflight y checkpoint 1.**
  - Por qué/entrada: una mutación sin DB+medios recuperables puede perder sala,
    Spoke, avatares o thumbnails.
  - Resultado/cierre: contexto/UID/digests verificados; candidato HMAC generado
    localmente sin salida sensible, guardado cifrado en backend externo aprobado,
    restaurado y solo entonces importado no-clobber como record de UUID explícito
    en el keyring append-only;
    SQL + `ret-pvc` + hashes + inventario no secreto; restore dry-run del par,
    inspección de la copia cifrada externa y referencia DB→media comprobada sin
    restaurar producción.
  - Frontera: producción read/scale coordinado; checkpoint obligatorio.

- [ ] **P4.2 Rotar credenciales coordinadamente.**
  - Por qué/entrada: valores privados aparecieron en una terminal interna y
    P3.1 debe haber dejado una ruta aprobada ejecutable.
  - Resultado/cierre: NEW aceptada, OLD revocada y rechazada, NEW reaceptada;
    `PERMS_KEY` coherente; solo huellas/presencia registradas.
  - Frontera: producción/credenciales. Sin imprimir valores.

- [ ] **P4.3 Checkpoint 2 y canary guardado.**
  - Por qué/entrada: preservar el estado post-rotación antes del cutover; el
    tooling actual lo liga al candidato.
  - Resultado/cierre: segundo par DB+medios con hashes, dry-run e inspección de
    copia cifrada externa; canary productivo mínimo posterior confirma DOKS,
    TURN, DNS/TLS y correo que `kind` no cubre.
  - Frontera: producción; rollback inmediato ante cualquier warning.

## Fase 5 — Rollout y aceptación visible

- [ ] **P5.1 Publicar escena de sitting y aplicar server-first.**
  - Por qué/entrada: la escena live carece de `Can be occupied`; protocolo v2
    debe existir antes del cliente.
  - Resultado/cierre: copia Spoke con identidad estable, `Disable motion`,
    `Can be occupied` y `Clickable`; manifiestos generados aplicados bajo Lease:
    Reticulum, después Hubs y luego runner control plane.
  - Frontera: Spoke/producción; checkpoint válido, diff redactado y rollback.

- [ ] **P5.2 Aceptación real completa.**
  - Por qué/entrada: Pods Ready y HTTP 200 no prueban el producto.
  - Resultado/cierre: `verify-live-reactivation.sh` 0 fallos/0 warnings; navegador
    frío desktop/móvil prueba login/magic link, sala, audio de dos sesiones,
    español y cámaras; GLB provider-neutral upper/full-body, persistencia,
    privacidad y aislamiento; sitting competitivo; bots `0/5/10` con namespace
    por sala, Presence/ACK/readiness, navmesh, movilidad estática, stop terminal,
    moderación fail-closed, `store:false`, reply-only sin autoridad, separación
    entre sesiones y no persistencia; Admin; propietario de sala distinto del de
    proyecto Spoke y publicación a la escena correcta; ausencia de mensajes,
    prompts, secretos o identificadores sensibles en logs.
  - Frontera: producción y navegador real. Cualquier fallo => rollback.

- [ ] **P5.3 Checkpoint 3 y cierre.**
  - Por qué/entrada: conservar el estado exacto aceptado y su rollback.
  - Resultado/cierre: checkpoint post-cutover con hashes, dry-run, inspección de
    copia cifrada externa, digests/run IDs, inventario final update-friendly y
    documentación; `main` y subrepos limpios/sin drift.
  - Frontera: producción/checkpoint; después solo queda el handoff P6.1, no la
    ejecución de una feature nueva.

## Fase 6 — Volver a nuevas capacidades

- [ ] **P6.1 Elegir una sola feature siguiente.**
  - Por qué/entrada: evitar volver a mezclar plataforma, upstream y producto.
  - Resultado/cierre: objetivo separado para Avaturn/otro proveedor, nuevas
    personalidades de bots, VR, capacidad o la feature que el propietario elija.
  - Frontera: decisión de producto/coste/privacidad; no pertenece a esta meta.

## Trabajo explícitamente fuera de esta meta

- `upstream/master`, upgrades masivos y modernización total de Spoke;
- HA/HPA, Reticulum multirréplica y carga 30/100/300/10.000;
- VR físico, proveedor de avatares embebido y nuevas personalidades/features;
- parser GLB backend completo salvo que se abra el servicio a usuarios no
  confiables o se decida un evento público;
- optimización de la topología de USD 65 durante el cierre técnico.

## OBJETIVO NUEVO PARA PEGAR EN CODEX

```text
Completa de principio a fin la meta activa de YenHubs descrita en
/Users/Shared/Gits/YenHubs/docs/active-goal-plan-2026-07-18.md. Lee primero y
respeta /Users/Shared/Gits/YenHubs/AGENTS.md y usa únicamente
/Users/Shared/Gits/YenHubs como autoridad operativa; los demás worktrees son
evidencia hasta clasificarlos.

Continúa exactamente por la primera casilla ejecutable. P1.2 cerró con NO-GO y
no debe repetirse. P1.3 quedó aprobado con revisiones finales 0 P0/P1/P2. En
P1.4 ya están cerrados helper/keyring, autoridad HMAC, reducción automática y
el subcomando `plan` read-only. `execute` ya está implementado localmente: sus
positivos, takeover y las 21 fronteras lost-response están verdes por grupos
disjuntos. Drift `14/14` quedó congelado tras una única pasada. La primera acción
es ejecutar únicamente TERM `6`, seguida de redacción `2` y terminal `6`. No
repitas ninguna evidencia anterior.
Conserva la
auditoría, deja el PR raíz #15
congelado y no ejecutes 402, 478, durable, microselector, 764, 766 ni 768 como
nuevos discriminadores.

Aplica exactamente el contrato reducido del diseño: conserva checkpoint conjunto
PostgreSQL+ret-pvc, Lease/lock global, orden parent-first, CAS exacto, fence
durable y fail-closed. Las únicas persistencias nuevas permitidas son: autoridad
JSON canónica/redactada dentro del lock `checkpoint-backup` existente y custodia
criptográfica en un keyring privado externo append-only, sin registry, estado
activo ni rotación online. El keyring no es una segunda autoridad Kubernetes.
Liga las specs mediante HMAC; nunca persiste SHA público, template o spec.
Restore/AUD-065 mantienen data vacío. Un PATCH/JOIN/respuesta
perdida tras la primera mutación retiene lock y usa el procedimiento manual
`plan/execute`. No añadas otro estado, objeto, monitor, fence, receipt o
discriminador. Si ese contrato no resulta implementable dentro de su allowlist,
marca el objetivo bloqueado y no improvises un revert bruto.

Solo después implementa un sucesor desde origin/main, nunca desde #15, y
extrae únicamente fixes demostrados. Ejecuta focos proporcionales, un único
full por candidato congelado y un único CI GitHub por SHA. La misma firma roja
o una nueva expansión arquitectónica implican STOP definitivo, no otra
hipótesis.

Continúa autónomamente por las fases en orden cuando sus criterios de cierre
estén demostrados: recovery; regresiones pequeñas Hubs; workflows/builds por
Actions y digests; ensayo kind efímero sin coste DO; checkpoint conjunto DB y
ret-pvc; rotación redactada; checkpoint 2; rollout Reticulum-first/Hubs-second;
Spoke/sitting; aceptación real; rollback/checkpoint final. No recortes backup,
seguridad, privacidad, staging ni aceptación y no confundas Ready/HTTP 200 con
producto aceptado.

Usa GitHub solo para checkout x64 limpio, CI material y builds/attestations que
lo requieran. Monitoriza los runs directamente hasta terminal, sin heartbeats
de 17 horas. No repitas gates verdes con los mismos inputs ni ejecutes normal y
--full si duplican la misma suite. Comprueba billing antes de Actions y detente
si pudiera haber cualquier importe facturado mayor que USD 0. No abras ni
imprimas values/manifiestos
ignorados, no uses builds locales como entregable, no hagas hotpatches ni crees
o amplíes recursos de pago. Cualquier posible coste nuevo requiere detenerse y
avisar antes.

Mantén sincronizados el panel superior de ese plan y
/Users/Shared/Gits/YenHubs/docs/estado-sencillo.md antes de cambiar de acción y
después de cada hito; añade solo un resumen por hito a session-changelog.md. La
historia no vuelve al plan. Marca una casilla únicamente con evidencia exacta y
haz una revisión breve al final de cada cambio coherente. Termina solo cuando se
cumpla la definición de cierre del plan y no queden pendientes de esta meta.
```
