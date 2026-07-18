# Matriz de evidencia del cierre final - 17-18 de julio de 2026

Esta matriz impide confundir codigo candidato, una prueba local y una
aceptacion desplegada. Se actualiza con evidencia reproducible y no se usa una
casilla verde para cubrir un alcance mayor que la prueba que la respalda.

## Estados

- `PROBADO`: existe evidencia directa del alcance indicado.
- `CANDIDATO`: implementado y probado en una rama de revisión, pero todavía no
  integrado.
- `INTEGRADO`: pertenece a las ramas base y su CI de fuentes pasó, pero todavía
  no está aceptado en staging/live.
- `PENDIENTE`: falta evidencia suficiente o la implementacion sigue abierta.
- `BLOQUEADO`: requiere una accion externa, credencial, coste o mitigacion de
  seguridad expresamente indicada.

## Requisitos y evidencia autoritativa

| Area | Estado actual | Evidencia que ya existe | Evidencia que falta para cerrar |
| --- | --- | --- | --- |
| Releases upstream | PROBADO | `./scripts/verify-project.sh --full` repitió `audit-upstream.sh` sobre Hubs `674ece411691` y Cloud `0f151eb88da1`: baselines `prod-2026-03-11` y `2.1.0`, con 0 commits estables ausentes. | Repetir inmediatamente antes de construir imágenes/desplegar; los conflictos contra `upstream/master` siguen siendo una señal informativa, no una release desplegable. |
| Avatares | INTEGRADO | `docs/avatar-provider-evaluation-2026-07.md`; fuente Hubs `d7f0c2fc4` integrada en `master`; carga GLB manual conservada; investigación oficial sin crear cuenta ni coste. | Prueba funcional del GLB privado en staging y decision contractual separada antes de integrar un SaaS. |
| Sitting de dos clientes | INTEGRADO | La reproducción live del baseline midió una doble ocupación de unos 17 ms; el contrato automatizado de dos contextos y 11/11 unitarias cubre concesión única, stand, reclaim y desconexión. Las fuentes Hubs `d7f0c2fc4` y Cloud `b7b752f` ya pertenecen a sus ramas base. | Ejecutar el test de dos navegadores contra el backend candidato, comprobar pose remota y revisar visualmente suelo/geometria; no basta listar el spec. |
| Bots, IA y privacidad | INTEGRADO | Hubs `674ece411691`: AVA 97/97, Admin lint/build y Gitleaks verdes. Cloud `0f151eb88da1`: Reticulum 418 pruebas + 5 properties, orquestador 103/103, generador 26/26, migraciones reales y CI PostgreSQL 12/14 verdes. Hubs `#4` y Cloud `#3`-`#8` quedaron fusionados en sus ramas base. El contrato cubre Presence, ACK, navmesh, capacidad de chat por canal, aprobación/cuarentena exacta, fencing PostgreSQL por sala, modelo reply-only, moderación fail-closed, `store:false`, límites y logs redactados. | Resolver `AUD-075` e implementar `AUD-078`; desplegar y atestar `AUD-076`; revisar/aprobar el inventario migrado de `AUD-077`; después construir imágenes por Actions y aceptar rehidratación, 0/5/10 bots, movilidades, chat y logs en staging/live. |
| Capacidad | BLOQUEADO | El arnes fail-closed pasa 115/115 y su validacion local es verde, pero devuelve `physicalReadiness=BLOCKED`: 39 metricas no disponibles, `anchors=0`, ninguna carga real ejecutada y ninguna capacidad certificada. | Aislar runners segun `AUD-075`, completar anclas y baseline Prometheus ligado a la ejecucion y obtener autorizacion de entorno/coste antes de generar carga; no emitir recomendacion de compra sin muestras fisicas. |
| Spoke legacy | INTEGRADO | `docs/spoke-legacy-audit-2026-07.md`; Cloud `b7b752f` con lint, 68/68 y build verdes sobre Node 16/Yarn 1 quedó integrado en `master` mediante `2164851185da`. | Aceptar funcionalmente en staging proyecto, escena, navmesh, ocho `spawbot-*` y dos asientos. La modernización de imagen sigue siendo otro rollout. |
| Backup/restore/seguridad | PENDIENTE | Pasan 36 regresiones de seguridad, 142 de recuperación, Actionlint, ShellCheck 0.9/0.11, Gitleaks en root/Hubs/Cloud y `verify-project --full` sobre Hubs `674ece411691`/Cloud `0f151eb88da1`. SC2119, SC2015 y la portabilidad GNU/BSD quedaron cubiertos por regresiones. No hubo acceso ni mutación del cluster. | Repetir el gate en el PR raíz; probar preflight/restore en un entorno aislado y, antes de cualquier mutación real, crear checkpoint DB+storage y completar la rotación de `AUD-065`. |
| Actions e imagenes | PENDIENTE | El CI de fuentes terminó verde y Hubs/Cloud ya están integrados en sus ramas base, incluidos `AUD-076`/`AUD-077`. El bootstrap meta-hubs `#2` y el cierre raíz `#3` pertenecen a `main`; el baseline live conserva sus digests. No se presenta ningún digest candidato como publicado. | Integrar el nuevo gitlink/documentación raíz; después resolver `AUD-075`/`AUD-078`, construir las imágenes mediante los workflows aprobados, capturar digests y regenerar el manifiesto estándar. |
| Rollout y produccion | BLOQUEADO | No hubo deploy ni cambio live. `AUD-065` exige checkpoint y rotacion tras la exposicion; `AUD-075` bloquea uso publico por falta de aislamiento por Pod. El fencing de `AUD-076` ya está integrado, pero el baseline live sigue siendo process-local y no está migrado ni atestado. La aprobación/cuarentena de `AUD-077` tampoco se ha ejecutado ni revisado live, y `AUD-078` aún carece de outbox/ACK terminal. | Antes de cualquier mutacion: checkpoint DB+storage nuevo y rotacion coordinada. Antes de publico: aislamiento por runner, outbox/ACK durable, desplegar y atestar fencing, y aprobar individualmente el inventario redactado. Solo despues: Actions, digests, `kubectl diff`, apply estandar y verificador live. |
| Aceptacion final | PENDIENTE | Existe baseline historico, pero no prueba el candidato actual. | Navegador frio desktop y movil, sitting con dos clientes, bots y privacidad; cero fallos y cero avisos de consola, pagina, red y HTTP. |
| Coherencia Git/documental | PROBADO LOCALMENTE | La rama raíz fija Hubs `674ece411691` y Cloud `0f151eb88da1`, ambos heads de sus ramas base, y registra `AUD-076`/`AUD-077`. `verify-project` normal y `--full` terminaron verdes; Cloud PR `#7/#8` pasó CI. | Repetir el gate en CI, fusionar el PR raíz y no confundir ese cierre Git con aceptación live. |

## Regla de cierre

La meta solo se marca completa cuando todas las filas estan `PROBADO` para el
alcance exigido o, si una accion externa impide el rollout, cuando el codigo y
la documentacion estan integrados y el bloqueo externo queda declarado sin
presentar produccion como validada. Una suite local no sustituye Actions, y
Actions no sustituyen la aceptacion cold-browser o la verificacion live.
