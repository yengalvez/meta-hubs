# Verificación sin falsa aceptación · 01/10/2026

Subordinado al [plan canónico](/Users/Shared/Gits/YenHubs/PLAN/Plan_activo.md).
No cambia permisos, monitores, plazos ni estado del producto. Corrige el driver
que decide si una sección es aceptable, no los 495 tests Reticulum ya verdes.

## Defectos reproducidos

La sección18214 ejecutó cinco properties y495tests con0fallos/3excluded,
pero salió1. Su padre estaba dentro del sandbox macOS, donde `/bin/ps` no
puede ejecutarse incluso con allow-default (a412b4, exit71). El chequeo de
procesos, llamado en un condicional, ignoró el error de la pipeline y marcó
cleanup como probado. Ese SECTION PASS NO acredita un recibo seguro.
Además el wrapper eligió Bash3.2, el resumen falló por array vacío+nounset y
la huella decía Bash5.3 del PATH. PID42362 propio detenido, summary terminal
FAIL/stopped=true; no fallo del producto, backup ni producción inferido.

## Cambio mínimo y efectos

- `known_verification_processes_are_absent` rechaza explícitamente el error
  de enumeración/filtrado. Ausencia de salida no equivale a ausencia de procesos.
  El finalizador tampoco puede ignorar cleanup fallido bajo un caller condicional.
- Resumen y finalizador cuentan fallos antes de expandir arrays vacíos,
  conservando nounset y las secciones fallidas. Funciona en Bash3.2 y5.3.
- Toolchain liga el `BASH_VERSION` REAL del driver, además de la versión del
  Bash resuelto para sus shells hijos. No aceptar datos del shell del PATH
  como si fueran necesariamente el padre que interpreta el verificador.
- `YENHUBS_RETICULUM_TEST_SANDBOX_PROFILE` opcional confina SOLO los cuatro
  comandos Mix existentes. El padre, los recibos y la inspección de procesos
  quedan fuera. Default CI sin perfil conservado; no otro runner/build/gate.
  La política se pasa como un argumento, no eval, y su SHA256 liga Reticulum.
  Un cambio de política afecta ese harness, no Dialog ni otro componente.

El perfil elegido para este ensayo deja loopback salvo5432/tripwire y remoto53
para DNS sintético de tests. No salida HTTPS ni claves/config de usuario;
política+peer denegado+UID/PID/DB/puerto/stop propios deben probarse antes del
ensayo, no inferirse de la opción. El helper canary SOLO-PG sigue intacto.
El PostgreSQL del dueño no se sondea, consulta ni detiene.

**El delta del harness COMÚN invalida recibos afectados.** Conservar logs y
positivos anteriores, pero no transferir aceptación ni borrar evidencia para
hacer pasar el finalizador. Consultar los bytes congelados y renovar lo que
marque; el full exacto sigue obligatorio. La suite verde de18214 no puede
adoptarse como sección completa exit0/cleanup probado.

## Regresiones y límites

- ddc9d1 rojo: enumeración ps fallida se aceptaba como ausencia. Primera
  invocación3b583e no ejecutó el archivo no-ejecutable; no es un test rojo.
- Primer verde detectó grep-q/SIGPIPE del oracle; se corrigió SOLO el consumo
  de su salida completa, no el guard ni una aceptación adversa.
- 21901 exit0:38 tests normales (nueve nuevos y29 compatibles), incluyendo
  ps fallido/vacío, huella de los dos Bash, resumen/finalizador vacíos,
  cleanup bajo caller condicional y cuatro lanzamientos/política ligados.
  Las fixtures de finalizador son control de flujo, no15 recibos reales.

Revisión primaria dirigida separada, no independiente: fail-closed explícito,
no array vacío bajo Bash3.2, launcher siempre no-vacío/quoted, ninguna shell
interpreta la política, no secretos impresos, cleanup fuera del sandbox y
firma de política solo Reticulum. Gates/commit, sección real renovada y full
quedan registrados en PLAN; estos tests no acreditan Kubernetes, ciclos,
restauración, SLO, integración en bases o cierre del Goal.
