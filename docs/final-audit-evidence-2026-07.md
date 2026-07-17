# Matriz de evidencia del cierre final - 17 de julio de 2026

Esta matriz impide confundir codigo candidato, una prueba local y una
aceptacion desplegada. Se actualiza con evidencia reproducible y no se usa una
casilla verde para cubrir un alcance mayor que la prueba que la respalda.

## Estados

- `PROBADO`: existe evidencia directa del alcance indicado.
- `CANDIDATO`: implementado y probado, pero todavia no integrado en las ramas
  base ni aceptado en staging/live.
- `PENDIENTE`: falta evidencia suficiente o la implementacion sigue abierta.
- `BLOQUEADO`: requiere una accion externa, credencial, coste o mitigacion de
  seguridad expresamente indicada.

## Requisitos y evidencia autoritativa

| Area | Estado actual | Evidencia que ya existe | Evidencia que falta para cerrar |
| --- | --- | --- | --- |
| Releases upstream | PROBADO | `./scripts/verify-project.sh --full` repitio `audit-upstream.sh` el 17-07-2026 sobre Hubs `d7f0c2fc4` y Cloud `b7b752f`: baselines `prod-2026-03-11` y `2.1.0`, con 0 commits estables ausentes. | Repetir solo si cambia algun candidato o inmediatamente antes de publicar; los conflictos contra `upstream/master` siguen siendo una senal informativa, no una release desplegable. |
| Avatares | CANDIDATO | `docs/avatar-provider-evaluation-2026-07.md`; candidato Hubs `d7f0c2fc4`; carga GLB manual conservada; investigacion oficial sin crear cuenta ni coste. | Prueba funcional del GLB privado en staging y decision contractual separada antes de integrar un SaaS. |
| Sitting de dos clientes | CANDIDATO | La reproduccion live del baseline midio una doble ocupacion de unos 17 ms; el contrato automatizado de dos contextos y 11/11 unitarias cubre concesion unica, stand, reclaim y desconexion. Los candidatos terminales son Hubs `d7f0c2fc4` y Cloud `b7b752f`. | Ejecutar el test de dos navegadores contra el backend candidato, comprobar pose remota y revisar visualmente suelo/geometria; no basta listar el spec. |
| Bots, IA y privacidad | CANDIDATO | Hubs `d7f0c2fc4`: 10/10 focales, AVA 79/79, check, build, lint, Prettier y Gitleaks verdes. Cloud `b7b752f`: Reticulum 391 pruebas + 5 properties, 0 fallos y 3 excluidas; bot orchestrator 102/102; generador 26/26. Los PR Hubs `#3` y Cloud `#1` estan `CLEAN` con sus checks verdes. El contrato cubre Presence, ACK, navmesh, capacidad de chat por canal, modelo reply-only, moderacion fail-closed, `store:false`, limites y logs redactados. | Resolver `AUD-075`, fencing persistente de leases y cuarentena/aprobacion ejecutable de configuraciones heredadas; despues integrar, construir imagenes por Actions y aceptar rehidratacion, 0/5/10 bots, movilidades, chat y logs en staging/live. |
| Capacidad | BLOQUEADO | El arnes fail-closed pasa 115/115 y su validacion local es verde, pero devuelve `physicalReadiness=BLOCKED`: 39 metricas no disponibles, `anchors=0`, ninguna carga real ejecutada y ninguna capacidad certificada. | Aislar runners segun `AUD-075`, completar anclas y baseline Prometheus ligado a la ejecucion y obtener autorizacion de entorno/coste antes de generar carga; no emitir recomendacion de compra sin muestras fisicas. |
| Spoke legacy | CANDIDATO | `docs/spoke-legacy-audit-2026-07.md`; candidato Cloud `b7b752f` con lint, 68/68 y build verdes sobre el baseline Node 16/Yarn 1, tambien en el PR Cloud `#1`. | Integrar primero en `development` y despues mediante `development -> master`; aceptar funcionalmente en staging proyecto, escena, navmesh, ocho `spawbot-*` y dos asientos. La modernizacion de imagen sigue siendo otro rollout. |
| Backup/restore/seguridad | CANDIDATO | Los gates integrados pasan: 36 regresiones de seguridad, 137 de recuperacion, Actionlint, ShellCheck, Gitleaks en root/Hubs/Cloud y `verify-project` normal y `--full`. No hubo acceso ni mutacion del cluster. | Probar preflight/restore en un entorno aislado y, antes de cualquier mutacion real, crear checkpoint DB+storage y completar la rotacion de `AUD-065`. |
| Actions e imagenes | PENDIENTE | Las ramas candidatas estan publicadas. Hubs `#3` esta `CLEAN` y verde contra `master`; Cloud `#1` esta `CLEAN` y verde contra `development`. Meta-hubs `#1` solo queda bloqueado por el bootstrap de politica Gitleaks base-owned; el PR minimo meta-hubs `#2` esta `CLEAN`, verde y pendiente de revision/merge. El baseline live anterior conserva sus digests y no se presenta ningun digest candidato como publicado. | Revisar y fusionar primero meta-hubs `#2`, actualizar y repetir `#1`, integrar Hubs en `master` y Cloud en `development` seguido de `development -> master`; despues construir las imagenes por Actions, capturar digests y regenerar el manifiesto estandar. |
| Rollout y produccion | BLOQUEADO | No hubo deploy ni cambio live. `AUD-065` exige checkpoint y rotacion tras la exposicion; `AUD-075` bloquea uso publico por compartir contenedor, UID, PID namespace y cgroup. La autoridad de leases sigue en memoria sin fencing DB y las configuraciones heredadas activas carecen de aprobacion/cuarentena persistente. | Antes de cualquier mutacion: checkpoint DB+storage nuevo y rotacion coordinada. Antes de publico: aislamiento por runner, leases con fencing y un inventario redacted exacto con aprobacion del propietario o migracion fail-closed. Solo despues: Actions, digests, `kubectl diff`, apply estandar y verificador live. |
| Aceptacion final | PENDIENTE | Existe baseline historico, pero no prueba el candidato actual. | Navegador frio desktop y movil, sitting con dos clientes, bots y privacidad; cero fallos y cero avisos de consola, pagina, red y HTTP. |
| Coherencia Git/documental | CANDIDATO | El indice raiz fija Hubs `d7f0c2fc4` y Cloud `b7b752f`; las tres ramas candidatas estan publicadas, los arboles estan limpios y los gates normal/full pasan sobre esos gitlinks. | Fusionar en orden Hubs, Cloud `development`, Cloud `development -> master` y finalmente root tras el bootstrap `#2`; no confundir ese cierre Git con aceptacion live. |

## Regla de cierre

La meta solo se marca completa cuando todas las filas estan `PROBADO` para el
alcance exigido o, si una accion externa impide el rollout, cuando el codigo y
la documentacion estan integrados y el bloqueo externo queda declarado sin
presentar produccion como validada. Una suite local no sustituye Actions, y
Actions no sustituyen la aceptacion cold-browser o la verificacion live.
