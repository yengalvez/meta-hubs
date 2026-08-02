# Estado sencillo de YenHubs

Última actualización: 2 de agosto de 2026

Este es el panel humano del proyecto. Aquí debe poder entenderse, sin leer el
plan técnico, qué está terminado, qué se está haciendo y qué queda. Se
actualiza cada vez que cambia la tarea activa o se completa un hito.

## Resumen rápido

- **El YenHubs que usabas sigue funcionando y no se ha tocado.**
- **Todavía no estamos desplegando.** Estamos acabando de integrar y probar el
  código que hará más seguros los bots, los asientos, las copias y la
  recuperación.
- **No estamos añadiendo funciones nuevas ni actualizando Hubs entero.**
- **Faltan cuatro bloques después del actual:** construir las imágenes, hacer
  copias y rotar credenciales, probar en staging y desplegar/verificar.

## Dónde estamos

```text
[ EN CURSO ] 1. Terminar e integrar el código seguro
[ PENDIENTE] 2. Construir las cuatro imágenes definitivas
[ PENDIENTE] 3. Copias de seguridad y cambio de credenciales
[ PENDIENTE] 4. Ensayo completo en staging
[ PENDIENTE] 5. Despliegue, comprobación real y cierre
```

Estamos al final del bloque 1. El PR raíz `#14` está fusionado. La corrección de
la carpeta privada pasó localmente y los cuatro checks rápidos de GitHub están
verdes. Los dos gates largos no encontraron un fallo: GitHub los canceló al
cumplir el límite configurado de 75 minutos, cuando todavía iban por los casos
315 y 295 de 861. Ahora se corrige únicamente ese límite y se evita ejecutar dos
veces el mismo gate por push y PR. No se avanzará al bloque 2 hasta obtener un
gate completo verde. La corrección CI ya pasa sus comprobaciones locales y la
acción actual es publicarla en un PR nuevo.

## Qué se ha terminado

- [x] Revisar el alcance y quitar trabajos que no hacen falta para cerrar.
- [x] Conservar la versión estable de Hubs como base actualizable; no se ha
  incorporado `upstream/master` ni una modernización masiva.
- [x] Integrar en los forks el endurecimiento de sitting, bots, runners y
  parada segura.
- [x] Hacer que las copias y restauraciones traten juntas la base de datos y
  los ficheros del metaverso.
- [x] Corregir los avisos de seguridad necesarios de Immutable.js, Cowboy,
  Cowlib y Guardian sin actualizar dependencias ajenas.
- [x] Pasar las pruebas locales y de CI de Reticulum en PostgreSQL 12 y 14.
- [x] Abrir el PR raíz `#14` con el código candidato.
- [x] Resolver los avisos reales y falsos positivos de ShellCheck que impedían
  que el CI llegase a la prueba completa.
- [x] Mantener producción intacta durante todo este trabajo.

## Qué estoy haciendo ahora

- [x] Validar en macOS con `TMPDIR` ausente, como en el CI Linux, que la carpeta
  temporal privada funciona y sigue rechazando permisos inseguros o enlaces
  falsos.
- [x] Publicar la corrección como `78b7165` y fusionar el PR `#14`.
- [x] Diagnosticar las dos cancelaciones: límite del workflow de 75 minutos, no
  un fallo de pruebas.
- [x] Validar la corrección CI: workflow, ShellCheck, 51 controles de seguridad,
  gitlinks, diff y escaneo de secretos están verdes.
- [ ] Publicar la corrección CI acotada: 360 minutos para el gate largo y una
  sola ejecución por rama cuando coinciden push y PR.
- [ ] Exigir un gate Linux completo verde antes de pasar al bloque 2.

Este arreglo pertenece al sistema de checkpoint/restore. No modifica la sala,
la interfaz ni las personalizaciones visibles de Hubs.

## Qué quedará después de fusionar el PR

- [ ] Añadir la evidencia que une cada imagen con su código y su digest.
- [ ] Construir mediante GitHub Actions Hubs, Reticulum, parent de bots y
  runner de bots. Construir no significa desplegar.
- [ ] Crear una copia completa previa, rotar las credenciales preventivas y
  crear la copia posterior.
- [ ] Probar en staging primero Reticulum y después Hubs, incluida la escena de
  Spoke, los bots y dos usuarios intentando ocupar el mismo asiento.
- [ ] Desplegar en producción exactamente los mismos digests aceptados en
  staging.
- [ ] Comprobar con navegador frío en ordenador y móvil: acceso y magic link,
  sala, audio, español, cámaras, avatares, sitting, bots, chat, Admin y Spoke.
- [ ] Probar backup/rollback, crear la copia final y cerrar la documentación.

## Por qué hace falta

Antes ya funcionaba para los usuarios. El objetivo no es reparar un metaverso
roto ni cambiar su aspecto: es poder actualizarlo, recuperarlo y desplegarlo
sin que un fallo parcial deje datos, bots o permisos en un estado ambiguo. La
prueba final debe confirmar que, además de ser más seguro por dentro, sigue
funcionando igual por fuera.

## Lo que no vamos a hacer ahora

- [x] No certificar 30, 100, 300 o 10.000 usuarios con pruebas de carga.
- [x] No convertir Reticulum en multirréplica ni añadir alta disponibilidad.
- [x] No actualizar masivamente Hubs, Spoke o sus dependencias.
- [x] No incorporar `upstream/master`, VR, otro proveedor de avatares ni
  funciones nuevas.
- [x] No repetir pruebas o auditorías verdes si no cambia lo que verifican.

## Regla para mantener este panel

Antes de pasar a una tarea distinta se actualizan «Dónde estamos» y «Qué estoy
haciendo ahora». Al cerrar un hito se marca su casilla. El detalle técnico y la
evidencia quedan en `docs/active-goal-plan-2026-07-18.md` y
`docs/session-changelog.md`; este fichero siempre debe contar el mismo estado
en lenguaje sencillo.
