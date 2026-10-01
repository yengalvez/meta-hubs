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

## Sección real y coste de consultar evidencias

74742 terminó exit0/SECTION PASS: cinco properties,495tests,0fallos/3excluded;
summary terminalPASS/stopped=true/PID48847 ausente,39.553s total. Padre
Bash5.3.15 fuera del sandbox, cuatro Mix confinados y DB propia65509. No tocar
el5432 del dueño ni adoptar el recibo inseguro de18214. No equivale a full.

El siguiente finalizador69650 agotó120s sin lista;0 procesos coincidentes tras
reconciliar.67613 midió SOLO metadata nativa sobre cd0b487:271.307s para15
secciones;14pendientes y SOLOreticulum reutilizable. Static83.165s,
security52.445s, hcce46.895s, hubs29.585s. La causa de ese coste quedó acotada
por25871:100 archivos Hubs reales,100 procesos Git/1775ms frente a un lote/
25ms, hashes iguales. No repetir un test de app por el timeout del inventario.

### Delta de huellas por lotes, sin caché débil

Los buffers tienen como máximo128 registros. Git calcula los blobs regulares
en un proceso por lote; no escribe objetos, no aplica filtros y no deduce un
PASS de fechas/HEAD. Orden, etiqueta de repo, duplicados de closures solapadas,
nombre NUL-delimitado, tipo, blob nativo SHA1/SHA256, bit ejecutable efectivo,
missing y hash del target symlink conservados. `--` trata el nombre como literal
incluso si empieza por guion. [Contrato oficial de Git](https://git-scm.com/docs/git-hash-object).

Los dos helpers también forman parte del harness común. Se rechaza el error
de inventario/Git/readlink y una salida de lote truncada, inválida o sobrante.
Los callers comprueban explícitamente el resultado antes de reutilizar un
recibo, después del cuerpo y al finalizar: un hash fallido no puede convertirse
en recibo PASS aunque Bash esté en contexto condicional. Gitlinks/diff del
finalizador tampoco pueden fallar y quedar ocultos por su mensaje final.

- 25528 rojo:257 invocaciones en vez de3 para257 archivos.
- 79370 exit0/12 controles iniciales; a94fce no ejecutó tests por interpolación
  JS de la fixture shell, corregida SOLO en el oracle.
- 005ea4 rojo3/3: un hash que retornaba97 se aceptaba en los tres callers.
- 45992 exit0:17 nuevas pruebas normales y38 controles previos PASS,0skips;
  ShellCheck PASS. Bash3.2/5.3, nombres especiales/binarios/filtros/symlinks,
  missing/directorio, ignore/tracked, cierre vacío, SHA256, duplicados,
  cambio de contenido/permisos/target, errores y binding de helpers.

74542 midió las15 consultas nativas después:11.393s frente a271.307s. Las
OCHO closures Hubs/Cloud sin cambios dieron exactamente el hash anterior.
Root tenía el delta sin commit: es diagnóstico/equivalencia, no aceptación
de un candidato sucio. Todos15 pendientes por cambio del harness común;
no copiar ni promover los recibos anteriores, incluido74742, por inferencia.
Logs y summary owner-only en `/private/tmp/yn-ret-full-ndUhKs/cache-inventory`
y `cache-inventory-batch`, fuente congelada y renovación posterior en PLAN.

La mejora demostrada es SOLO consulta de evidencias local, no tiempo de
backup/restore/deploy, preflight productivo completo, red/VM fría o tres ciclos
aceptados. Revisión primaria dirigida separada, no independiente. Goal abierto.

40956 ejecutó el finalizador NORMAL sobre9ea7e29 limpio:exit1 esperado,
10.978s y exactamente15 pendientes. No repetir el inventario lento; el algoritmo
no cambió los ocho hashes anteriores, pero el harness común sí cambió.

En la misma frontera de publicación se reprodujeron dos retornos falsos:
3358be rojo2/2, el writer fallaba o decía éxito con evidencia inválida y aun así
el caller imprimía SECTION PASS.4a497e verde2/2 más ShellCheck/diff: mover el
log, escribir el recibo y releerlo mediante el guard canónico deben pasar ANTES
del marcador. La ruta failed conserva la ubicación real del log publicado.
Son dos fixtures dirigidas del writer, no una prueba de discos defectuosos ni
una suite repetida. Los17+38 previos se conservan; candidato/recibos finales y
controles positivos reales tras esta guarda quedan en PLAN.

## Separar tests Node y build Webpack · 02/10/2026

39606 renovó static/advisories/Reticulum con exit0, pero Hubs terminó1:
240 unidades pasaron y dos archivos murieron al importar configs.js porque
BASE_ASSETS_PATH activo intenta asignar `__webpack_public_path__`, inexistente
en Node. No falló otra copia multimedia ni llegó a compilar/Admin. La DB propia
de Reticulum quedó detenida antes de empezar Hubs; producción no cambió.

78204 exit0 demuestra SOLO los dos archivos implicados: seis unidades reales
con ambas variables ausentes, red denegada y fuente d3f4989 limpia,2.433s.
El driver conserva BASE_ASSETS_PATH/RETICULUM_SERVER en instalación, ambos
builds y el padre; las quita únicamente en dos subshells de `npm test`.
No se modifica configs.js, el shim, los tests Hubs ni sus oráculos.

Regresión normal `verification-hubs-build-env.test.mjs`: cea20a rojo2/6;
715955 verde6/6 en Bash3.2/5.3. Traza exacta de seis llamadas y del padre,
ausencia/presencia, y fallos de unidad Hubs/Admin que impiden el build posterior.
El npm de esas fixtures es un doble; no acredita compilación ni UI real.

27b17c rojo2/2 también demuestra que cambiar las dos variables no cambiaba
la firma del recibo Hubs. Ahora liga presencia y SHA256 de cada una, distingue
unset de vacío y no imprime valores.41e49d/64408 verde2/2 acredita invalidación
Hubs y compatibilidad Dialog/Reticulum. Los seis controles previos no se
repitieron por este cambio exclusivo de firma. Los ocho pertenecen al gate
security normal; no se crea otro coordinador ni se debilitan cleanup/guardas.

Revisión primaria dirigida separada, no independiente: builds conservan inputs,
solo unidades aislan Webpack, las dos fallas no son ignoradas por el caller,
firma incluye el entorno y los otros servicios conservan su evidencia.
Gates cortos, commit, secciones caducadas y full exacto posterior en PLAN;
estos controles no aceptan el candidato integral ni el objetivo completo.
