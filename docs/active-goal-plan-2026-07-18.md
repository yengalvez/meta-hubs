# Meta activa de YenHubs: cierre seguro y runtime endurecido

Última actualización: 18 de julio de 2026

Estado actual: **EN EJECUCIÓN; Fase 1, integración raíz de `AUD-075`**

Worktree inicial: `/Users/Shared/Gits/YenHubs-aud075-root`

Rama inicial: `codex/aud075-integration`

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
- [ ] Commit, push y PR raíz desde `codex/aud075-integration` hacia `main`.
- [ ] Incluir este plan activo en el PR y conservar su ruta relativa
  `docs/active-goal-plan-2026-07-18.md` como fuente de verdad versionada.
- [ ] Esperar el CI, corregir fallos reales y fusionar el PR.
- [ ] Confirmar que `main` fija Hubs y Cloud a commits existentes en sus ramas
  base.

Resultado: el código, los gates, los scripts de recuperación y la documentación
de `AUD-075` quedan integrados, todavía sin cambiar el runtime live.

### Fase 2 — cerrar inmediatamente `AUD-065`

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
  últimas coordinadamente mediante el manifiesto generado y el wrapper
  documentado, nunca mediante `kubectl patch`, edición manual de Secrets o
  hotpatches.
- [ ] Para esta rotación, regenerar el baseline con los digests y modo
  `process-local` que ya están live; verificar que el diff no adelanta
  `AUD-075` ni introduce cambios de workload ajenos a la rotación.
- [ ] Reiniciar todos los consumidores que correspondan y mantener `PERMS_KEY`
  idéntica en Reticulum y Dialog, comprobando únicamente su paridad por huella.
- [ ] Verificar por presencia/huella, revocación o rechazo seguro de valores
  anteriores, pulls GHCR y filtros de logs.
- [ ] Ejecutar preflight y verificador live sobre el baseline resultante; exigir
  cero fallos y cero avisos.
- [ ] Preparar y verificar, sin revelar secretos, el rollback a los digests
  anteriores usando exclusivamente las credenciales nuevas; un restore nunca
  debe reactivar credenciales revocadas.
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

Mientras se completa la Fase 1, la copia autoritativa está en el worktree
indicado al principio. Después de fusionarla, continuar desde la versión
trackeada con la misma ruta relativa en el worktree raíz activo y registrar ese
cambio de ruta antes de eliminar el worktree anterior.

## Prompt de meta

Copiar literalmente el siguiente texto como meta:

```text
Completa el cierre seguro y endurecido de YenHubs siguiendo
/Users/Shared/Gits/YenHubs-aud075-root/docs/active-goal-plan-2026-07-18.md
como única fuente de verdad operativa y respetando también AGENTS.md. Tras
fusionar la Fase 1, continúa desde la versión trackeada del mismo fichero en el
worktree raíz activo. Reanuda desde la primera casilla pendiente
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
