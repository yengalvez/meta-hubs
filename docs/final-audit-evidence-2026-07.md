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
| Releases upstream | PROBADO | `./scripts/verify-project.sh --full` repitió `audit-upstream.sh` sobre Hubs `674ece411691` y Cloud final `5392495b077249edcedfb3092551201645f648f1`: baselines `prod-2026-03-11` y `2.1.0`, con 0 commits estables ausentes. | Repetir inmediatamente antes de construir imágenes/desplegar; los conflictos contra `upstream/master` siguen siendo una señal informativa, no una release desplegable. |
| Avatares | INTEGRADO | `docs/avatar-provider-evaluation-2026-07.md`; fuente Hubs `d7f0c2fc4` integrada en `master`; carga GLB manual conservada; investigación oficial sin crear cuenta ni coste. | Prueba funcional del GLB privado en staging y decision contractual separada antes de integrar un SaaS. |
| Sitting de dos clientes | INTEGRADO | La reproducción live del baseline midió una doble ocupación de unos 17 ms; el contrato automatizado de dos contextos y 11/11 unitarias cubre concesión única, stand, reclaim y desconexión. Las fuentes Hubs `d7f0c2fc4` y Cloud `b7b752f` ya pertenecen a sus ramas base. | Ejecutar el test de dos navegadores contra el backend candidato, comprobar pose remota y revisar visualmente suelo/geometria; no basta listar el spec. |
| Bots, IA y privacidad | INTEGRADO (Git/fuente) | Hubs `674ece411691` y Cloud final `5392495b077249edcedfb3092551201645f648f1` fijan `AUD-075`. El PR Cloud `#11` llegó a `development` como `ebe960794735d378149966b78090e22acc60cc26` y el PR `#12` a `master` como `5392495b077249edcedfb3092551201645f648f1`; su CI está verde. La topología define parent y runner separados entre dos namespaces, token v1 + lease/epoch DB, pull Secret kubelet-only, cuota, admisión, RBAC y ocho NetworkPolicies. Pasan orquestador 128/128, generador 30/30 con 58 recursos y Reticulum 430 + 5. `AUD-078` conserva un diseño separado y sigue pendiente. | Cerrar el PR raíz; crear checkpoint y completar la rotación `AUD-065`; implementar `AUD-078`; construir ambos digests desde el mismo commit; desplegar Reticulum primero y luego parent/runner/control-plane; atestar `AUD-075`/`AUD-076`; revisar/aprobar el inventario migrado de `AUD-077`; aceptar rehidratación, 0/5/10 bots, movilidades, chat y logs en staging/live. |
| Capacidad | BLOQUEADO | El arnes fail-closed pasa 115/115 y su validacion local es verde, pero devuelve `physicalReadiness=BLOCKED`: 39 metricas no disponibles, `anchors=0`, ninguna carga real ejecutada y ninguna capacidad certificada. El aislamiento `AUD-075` existe en fuente, no en el runtime medido. | Desplegar y atestar los Pods aislados, completar anclas y baseline Prometheus ligado a la ejecucion y obtener autorizacion de entorno/coste antes de generar carga; no emitir recomendacion de compra sin muestras fisicas. |
| Spoke legacy | INTEGRADO | `docs/spoke-legacy-audit-2026-07.md`; Cloud `b7b752f` con lint, 68/68 y build verdes sobre Node 16/Yarn 1 quedó integrado en `master` mediante `2164851185da`. | Aceptar funcionalmente en staging proyecto, escena, navmesh, ocho `spawbot-*` y dos asientos. La modernización de imagen sigue siendo otro rollout. |
| Backup/restore/seguridad | PROBADO (fuente); PENDIENTE (runtime) | Sobre el gitlink Cloud final, `verify-project.sh` y `--full` pasan con seguridad 43/43 y recuperación 239/239. También pasan Pods 45/45, pull 19/19 y Deployment 18/18; el inventario schema 3 conserva `bot_runner_runtime` legacy/digest y quiesce/restore exige cero Pods dinámicos. Las regresiones mutan values/manifiesto tras el fencing y fuerzan un reintento CAS para demostrar que solo el driver principal puede recuperar: ningún subshell duplica fencing, reanuda writers o libera el lock. No hubo acceso ni mutación del cluster. | Probar preflight/restore en un entorno aislado y, antes de cualquier mutación real, crear checkpoint DB+storage con schema 3 y completar la rotación de `AUD-065`. |
| Actions e imagenes | PENDIENTE | El CI de fuente Cloud de los PR `#11`/`#12` está verde y `AUD-075` incluye un workflow que define build separado de parent y runner con el mismo commit, pero ese build de imágenes no se ejecutó ni se presenta ningún digest candidato como publicado. | Después de `AUD-078`, construir ambas imágenes mediante el workflow aprobado, capturar los dos digests, configurar el pull Secret privado y regenerar el manifiesto estándar. |
| Rollout y produccion | BLOQUEADO | No hubo deploy ni cambio live. `AUD-065` exige checkpoint y rotacion; `AUD-075`/`AUD-076` están corregidos en fuente pero el baseline live sigue siendo `process-local`, sin Pods/digests ni atestación. La aprobación/cuarentena de `AUD-077` tampoco se ejecutó/revisó live y `AUD-078` carece de outbox/ACK terminal. | Cerrar primero el PR raíz y `AUD-065`, implementar `AUD-078` por separado y construir los dos digests. Después: tres manifiestos completos de 58 recursos regenerados y aplicados con el wrapper en orden `bootstrap -> admission -> active`, Reticulum compatible primero y autoridad inerte hasta la última fase. Rollback inverso con las credenciales nuevas; el manifiesto viejo no poda ServiceAccounts, Role/Binding, Secret o NetworkPolicy. Solo tras atestación, inventario aprobado y outbox: cold load y verificador live. |
| Aceptacion final | PENDIENTE | Existe baseline historico, pero no prueba el candidato actual. | Navegador frio desktop y movil, sitting con dos clientes, bots y privacidad; cero fallos y cero avisos de consola, pagina, red y HTTP. |
| Coherencia Git/documental | PROBADO (Cloud y gitlink candidato raíz) | Cloud `5392495b077249edcedfb3092551201645f648f1` pertenece a `master` tras los PR `#11`/`#12`, el candidato raíz fija ese gitlink y tanto el gate normal como `--full` están verdes: Hubs 97/97 y build, navegador 11/11, capacidad 115/115 fail-closed, Dialog 2/2, Photomnemonic 7/7 y Spoke 68/68 y build, además de los gates bot/seguridad/recuperación detallados arriba. | Fusionar el PR raíz y no confundir ese cierre Git con builds de imágenes, checkpoint, despliegue o aceptación live. |

## Regla de cierre

La meta solo se marca completa cuando todas las filas estan `PROBADO` para el
alcance exigido o, si una accion externa impide el rollout, cuando el codigo y
la documentacion estan integrados y el bloqueo externo queda declarado sin
presentar produccion como validada. Una suite local no sustituye Actions, y
Actions no sustituyen la aceptacion cold-browser o la verificacion live.
