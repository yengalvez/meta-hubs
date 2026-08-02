# Estado sencillo de YenHubs

Última actualización: 2 de agosto de 2026

Este es el panel para entender el proyecto sin leer el plan técnico. Se
actualiza después de cada hito real y siempre que cambie «qué estoy haciendo
ahora».

## Resumen en una frase

El YenHubs que ya estaba publicado sigue intacto; estamos terminando de probar e
integrar una versión más segura de sitting, bots, recuperación y despliegue,
pero esa versión nueva todavía no se ha desplegado.

## Situación actual

- **Producción:** sin cambios durante esta campaña. Conserva el último baseline
  que fue aceptado en funcionamiento; esa aceptación es histórica y se repetirá
  con navegador real después del nuevo despliegue.
- **Código candidato:** casi cerrado, pero todavía está en una rama raíz y no en
  `main`.
- **Prueba larga más reciente:** el caso temporal corregido ya pasó y recovery
  quedó verde `861/861`. También pasaron las demás pruebas y builds hasta el
  último control de dependencias de Reticulum.
- **Avisos nuevos resueltos:** Guardian se actualizó de `2.4.0` a `2.4.1`, la
  primera versión oficial que corrige los cuatro avisos. Solo cambió una línea
  del lock; todas las demás dependencias permanecen iguales.
- **Validación:** Reticulum pasó audit, compilación, dos verificadores de
  migración, `461` pruebas + `5` propiedades en local y en PostgreSQL 12/14 de
  CI, además de su release. Los PR Cloud `#21` y `#22` están fusionados en
  `master=c0a3419b`.
- **Qué estoy haciendo ahora:** crear el commit y PR raíz sobre el árbol ya
  staged, validado y revisado. No se repiten las 3,5 horas de recovery, Hubs,
  Spoke y capacidad porque sus bytes no cambiaron.

## Lo que ya funcionaba antes de esta campaña

- [x] El metaverso público y su sala principal tenían una aceptación live
  documentada.
- [x] Acceso de usuarios, escena, audio, interfaz española, cámaras y avatares
  formaban parte del baseline funcional.
- [x] Los bots y su chat privado ya tenían un baseline operativo.
- [x] Existían copias conjuntas de base de datos y ficheros, rollback y una ruta
  de despliegue controlada.

Estas casillas describen el último baseline aceptado, no una comprobación hecha
hoy. El candidato nuevo deberá demostrar de nuevo todo lo visible antes de
considerarse terminado.

## Lo terminado en esta campaña

- [x] Se auditó el alcance y se eliminaron del cierre tareas que no eran
  necesarias ahora.
- [x] Se mantuvo Hubs preparado para futuras actualizaciones: release estable
  como base, personalizaciones inventariadas y cambios separados.
- [x] Se integró en los forks el código endurecido de sitting, bots,
  aislamiento de runners, parada terminal y recuperación segura.
- [x] Se protegió checkpoint/restore para que base de datos y ficheros se
  recuperen juntos y fallen de forma segura ante estados ambiguos.
- [x] Se corrigieron sin silenciarlos los avisos de seguridad de Immutable.js,
  Cowboy y Cowlib.
- [x] Los cambios Cowboy/Cowlib pasaron CI y están fusionados en la rama base de
  Hubs Cloud.
- [x] Producción no se ha tocado durante estas pruebas e integraciones.

## Lo que queda para terminar

- [x] Diagnosticar el único fallo temporal del caso 850 con una prueba focal.
- [x] Corregir únicamente su fixture: publicación atómica de marcas, tolerancia
  exacta de −1 ms solo cuando el cronómetro más amplio también prueba menos de
  5 segundos, y al menos una comprobación Lease lenta después del lanzamiento.
  Bash, ShellCheck, diff-check y el foco final 81/81 están verdes.
- [x] Ejecutar una vez el gate completo sobre el fixture final. Recovery pasó
  `861/861`, incluido el caso 850; los demás bloques llegaron verdes hasta el
  último control de dependencias.
- [x] Corregir de forma mínima los cuatro avisos nuevos con Guardian `2.4.1` y
  validar Reticulum localmente y en CI PostgreSQL 12/14; integrado en Cloud
  `master=c0a3419b`.
- [x] Fijar Cloud `c0a3419b` en la raíz, pasar pines, diff-check, auditoría
  upstream y Gitleaks, y revisar una vez el diff sin P0/P1/P2.
- [ ] Crear el commit y PR raíz, exigir CI verde y fusionarlo en `main`.
- [ ] Integrar la procedencia y los recibos que demostrarán exactamente qué
  código e imágenes se despliegan.
- [ ] Construir por GitHub Actions cuatro imágenes trazables: Hubs, Reticulum,
  parent de bots y runner de bots.
- [ ] Crear el checkpoint previo, rotar las credenciales preventivas y crear el
  checkpoint posterior.
- [ ] Probar en staging primero el servidor Reticulum y después el cliente Hubs,
  incluida la escena Spoke y la carrera de dos usuarios por un asiento.
- [ ] Desplegar en producción exactamente las mismas imágenes aceptadas en
  staging, fijadas por digest.
- [ ] Verificar con navegador frío en ordenador y móvil el acceso, escena,
  audio, español, cámaras, avatares, sitting, bots y chat, sin errores ni
  avisos.
- [ ] Crear el checkpoint final y cerrar la documentación.

## Lo que no hace falta para cerrar ahora

- [x] No certificar 30, 100, 300 o 10.000 usuarios con carga física.
- [x] No convertir Reticulum en multi-réplica ni añadir alta disponibilidad.
- [x] No hacer una actualización masiva de dependencias o de `upstream/master`.
- [x] No contratar otro proveedor de avatares, probar VR físico ni añadir
  funciones nuevas.
- [x] No repetir auditorías o pruebas verdes si no cambian sus entradas.

## Cómo se mantiene este panel

Al completar un hito se marca su casilla, se cambia «qué estoy haciendo ahora»
y se actualiza la fecha. El detalle y las evidencias permanecen en
`docs/active-goal-plan-2026-07-18.md` y `docs/session-changelog.md`; este fichero
solo debe contar el mismo estado en lenguaje sencillo.
