# PLAN ACTUAL — Sitting v2 autoritativo

Version: **v2 — EJECUTABLE LOCAL; EFECTOS EXTERNOS EN ESPERA**
Ultima revision: **28 de agosto de 2026 (Europe/Madrid)**
Autoridad: **este fichero es la única cola ejecutable**. El plan de transición
cerrado se conserva en
`OLD/docs/PLAN_ACTUAL-feature-transition-2026-08-28.md`.

## Resultado buscado

Entregar Sitting v2 para que dos personas que pulsan **Sit** sobre la misma
silla nunca puedan quedar sentadas simultáneamente: Reticulum concede un único
lease autoritativo, el ganador se mueve y replica su pose, el perdedor permanece
de pie, y Stand, handoff y desconexión liberan la silla de forma observable.

La feature termina únicamente cuando:

1. la fuente exacta de Hubs y Reticulum pasa las pruebas locales aplicables;
2. las imágenes de esos mismos commits se construyen por GitHub Actions y se
   fijan por digest;
3. staging demuestra la carrera con dos navegadores, pose remota, Stand,
   relevo y cierre abrupto sin errores;
4. producción recibe los mismos digests en orden Reticulum primero y Hubs
   después, con checkpoint, rollback preparado, navegador frío y verificador
   live con cero fallos y cero avisos.

Un test unitario, un build o la existencia del código no sustituyen la carrera
real. La feature tampoco obliga a promover el runtime durable de bots.

## Decisión y estado confirmado

- El propietario eligió **Sitting v2** el 28 de agosto de 2026.
- Workspace raíz: `/Users/Shared/Gits/YenHubs-features`, rama local
  `codex/sitting-v2`, sobre el commit de transición `8c0d547`.
- Hubs: rama local `codex/sitting-v2` en
  `ce8390a8905fa38fa0acdb10d5f94290981477ec`.
- Cloud: rama local `codex/sitting-v2` en
  `6d9ee9e998f636fcf61a4928cd2a275829768259`.
- Los commits Hubs `9c2da562b` y `3f18bdf24`, Cloud `ce20e20` y el arnés raíz
  `875642e` son ancestros de esos cortes. La implementación, migraciones y E2E
  ya existen; no se reescriben sin un fallo causal nuevo.
- El runtime productivo recuperado conserva Hubs `a7214eb88` y Reticulum/Cloud
  `5a82de5`, ambos anteriores a Sitting v2. La aceptación H5 demostró sitting
  histórico, no el protocolo v2 ni su carrera multiusuario.
- Sitting v2 necesita únicamente una imagen Hubs y una imagen Reticulum del
  corte actual. No necesita construir parent/runner de bots, Spoke, Dialog,
  Photomnemonic ni Coturn.

## Requisitos de producto

1. Una silla válida tiene identidad Spoke estable y los flags `Disable motion`,
   `Can be occupied` y `Can be clicked`.
2. Reticulum/PostgreSQL es la única autoridad de exclusión; NAF es una
   proyección visual y nunca concede ocupación.
3. Dos reservas simultáneas producen exactamente un ganador y un perdedor.
4. El cliente solo se mueve después del `ok` autoritativo correlacionado.
5. El estado público no expone identidad, UUID de lease ni datos privados.
6. `player-info.isSitting` y la posición del avatar muestran al ganador sentado
   de forma coherente en ambos clientes.
7. Stand libera, apaga la pose y elige un waypoint no ocupable.
8. Tras liberar, el perdedor puede reclamar la misma silla.
9. Cierre limpio libera inmediatamente; el lease de 15 segundos protege la
   desconexión no observable.
10. Hubs v2 ante servidor antiguo o capacidad inválida falla cerrado. Un cliente
    antiguo puede convivir con Reticulum v2, pero esa ventana no acepta sillas.
11. No hay warnings/errores first-party, excepciones, requests fallidas ni HTTP
    `>= 400` durante la aceptación.

## Alcance, no objetivos y autoridad

Incluido:

- contrato y tests Sitting existentes en Hubs, Reticulum y browser;
- corrección local de un defecto solo si un verificador aplicable lo demuestra;
- build trazable de Hubs y Reticulum, staging y promoción productiva posterior;
- documentación, rollback y aceptación cold desktop/mobile.

Fuera de alcance:

- GLB neutral, personalidad de bots, runtime durable de bots o capacidad CCU;
- actualización upstream, modernización de Spoke o cambio de topología general;
- rediseñar recovery, repetir H5 o limpiar worktrees históricos;
- editar la escena principal para crear fixtures de prueba;
- revertir destructivamente la migración con leases activos.

Autorizado ahora: trabajo local reversible, ramas, documentación y pruebas
locales proporcionales. No están autorizados todavía push, Actions, publicación
de imágenes, staging, Spoke, credenciales, DigitalOcean ni producción.

## Plan de producción

### S0. Cerrar la transición y fijar ramas

- [x] Elegir Sitting v2 y descartar GLB neutral de esta cola.
  - Estado: **DONE**.
  - Evidencia: elección `1` del propietario.
- [x] Abrir ramas `codex/sitting-v2` en root, Hubs y Cloud desde los cortes
  exactos aceptados.
  - Estado: **DONE**.
  - Evidencia: los tres árboles están limpios; Hubs `ce8390a`, Cloud `6d9ee9e`.

### S1. Confirmar el gap real

- [x] Contrastar source, historial y runtime aceptado.
  - Estado: **DONE**.
  - Evidencia: el código y los tests v2 son ancestros del source actual; las
    imágenes live proceden de commits anteriores.
- [x] Limitar la release a Hubs + Reticulum.
  - Estado: **DONE**.
  - Consecuencia: no se construyen ni despliegan imágenes no relacionadas.

### S2. Refrescar evidencia local sobre los bytes exactos

- [ ] Ejecutar la unidad contractual y enumeración Playwright de Sitting sin
  contactar una URL remota.
  - Estado: **READY**.
  - Verificación: `npm ci`, `npm run test:unit` y
    `npm run test:sitting -- --list` en `tests/browser`.
- [ ] Ejecutar Hubs focal: TypeScript, lint de la superficie afectada y las
  pruebas AVA de reserva, identidad, intentos y diagnóstico de waypoints.
  - Estado: **READY**.
  - Hecho cuando: cero fallos sobre `ce8390a`; no se atribuye un build todavía.
- [ ] Ejecutar Reticulum focal: dependencias locked, format/compile estricto y
  las dos suites de reserva/modelo y canal contra PostgreSQL local.
  - Estado: **READY**.
  - Hecho cuando: concurrencia, idempotencia, lease, canal y privacidad pasan
    sobre `6d9ee9e`.
- [ ] Ejecutar composición/diff-check y registrar la evidencia exacta.
  - Estado: **READY** después de los tres focos.
  - Nota: no se repite `--full`; no cambiaron bytes de producto y el gate final
    sectioned solo será necesario si una corrección invalida su cierre.

### S3. Resolver solo defectos demostrados

- [ ] Si todos los focos pasan, declarar que no hace falta implementación nueva
  y congelar los dos commits fuente.
  - Estado: **WAITING** de S2.
- [ ] Si falla un foco, corregir únicamente su causa en el subrepo dueño,
  repetir el verificador más cercano y actualizar el gitlink raíz.
  - Estado: **WAITING** de evidencia; no es trabajo preventivo.
  - Regla: dos fallos equivalentes sin nueva evidencia producen STOP y
    replanteamiento, no otro intento ciego.

### S4. Construir y aceptar en staging

- [ ] Autorizar el efecto externo y el target staging exacto, incluido cualquier
  coste o uso compartido del clúster.
  - Estado: **WAITING — autorización posterior**.
  - Decisión mínima: staging aislado sin crear un clúster nuevo por defecto; si
    no es viable, presentar coste/topología antes de crear recursos.
- [ ] Construir Hubs y Reticulum por los workflows aprobados y resolver ambos
  artefactos a digests con procedencia del commit exacto.
  - Estado: **WAITING** de autorización y S3.
- [ ] Preparar una sala/escena staging desechable con una silla y un waypoint de
  salida; no usar ni modificar la escena principal como fixture.
  - Estado: **WAITING** del target staging.
- [ ] Desplegar staging en dos generaciones: Reticulum/migración conservando
  Hubs anterior, verificar compatibilidad legacy, y después Hubs v2.
  - Estado: **WAITING** de builds y staging.
- [ ] Ejecutar `tests/browser/sitting-occupancy.spec.mjs` con dos contextos y
  revisar manualmente `remote-seated-pose.png`.
  - Estado: **WAITING** del rollout staging.
  - Aceptación: los once requisitos de producto pasan sin warnings ni errores.

### S5. Promover los mismos digests a producción

- [ ] Autorizar la ventana productiva exacta y crear checkpoint DB+medios.
  - Estado: **WAITING — efecto productivo**.
- [ ] Revisar el `kubectl diff` generado y aplicar Reticulum primero, Hubs
  después, sin cambios no relacionados.
  - Estado: **WAITING** de staging verde y autorización.
- [ ] Reiniciar Reticulum tras Hubs, ejecutar navegador frío desktop/mobile y
  `./deployment/verify-live-reactivation.sh` con cero fallos y cero avisos.
  - Estado: **WAITING** del rollout.
- [ ] Cerrar la feature con evidencia, commits/digests, rollback y estado humano.
  - Estado: **WAITING** de aceptación live.

## Rollback

1. Ante un fallo cliente/UX, volver primero Hubs al digest anterior.
2. Mantener Reticulum v2 y su tabla: acepta clientes legacy y evita una
   migración destructiva.
3. Si el fallo es exclusivamente Reticulum y Hubs v2 aún no se desplegó,
   conservar Hubs anterior y volver al digest Reticulum previo solo tras probar
   que no existen leases activos.
4. No borrar la tabla ni sus datos como rollback normal.
5. Conservar checkpoint y digests anteriores hasta cerrar aceptación.

## Estado de trabajo

- Completado: S0 ramas y S1 gap/release boundary.
- Activo: S2 validación local focal.
- Ready: browser contract, Hubs focal y Reticulum focal.
- Waiting: S3 por resultados; S4/S5 por evidencia y autorización externa.
- Bloqueos técnicos: ninguno.
- Efectos externos realizados: ninguno.

## Reglas anti-loop

1. La implementación existente se conserva; no se crea “Sitting v3”.
2. Un PASS previo no se repite salvo que cambien sus inputs u oráculo.
3. Los focos actuales prueban source; solo staging prueba la carrera real.
4. No se usa producción como fixture ni se presenta sitting histórico como v2.
5. La ausencia de un staging viable se resuelve con una decisión de coste y
   aislamiento, no mezclando la feature con otra arquitectura.
6. Hubs y Reticulum son las únicas imágenes de esta release.
7. Un fallo local no autoriza push, build, deploy ni cambios de topología.

## Artefactos clave

- Contrato humano: `features/sitting/README.md`.
- Implementación: `features/sitting/IMPLEMENTATION.md`.
- Aceptación: `features/sitting/TESTING.md`.
- E2E: `tests/browser/sitting-occupancy.spec.mjs`.
- Hubs: `hubs/src/utils/waypoint-reservation-coordinator.js` y sistemas/UI de
  waypoint.
- Reticulum: `hubs-cloud/community-edition/services/reticulum/lib/ret/waypoint_reservation.ex`
  y `hub_channel.ex`.
- Rollout: `deployment/README.md`.
- Estado humano: `docs/estado-sencillo.md`.
- Historial: `docs/session-changelog.md`.

## Punto de menor confianza

No existe todavía un target staging identificado y aceptado. Eso no invalida la
fuente ni bloquea S2, pero sí impide afirmar que Sitting v2 funciona entre dos
navegadores reales. La comprobación más barata, después de cerrar los focos
locales, es inventariar read-only la capacidad actual y proponer un único target
aislado con coste cero o coste explícito. Hasta entonces no se crea ningún
recurso ni se toca producción.
