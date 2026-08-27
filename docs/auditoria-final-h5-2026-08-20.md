# Auditoria final de YenHubs H5 — 20 de agosto de 2026

Estado: **auditoria completa; ruta de cierre corregida**

## Veredicto humano

El trabajo no se ha hecho en vano y no hay que empezar otra version. La parte
dificil y comercialmente valiosa ya existe: backup conjunto, custodia cifrada,
borrado selectivo, recreacion equivalente y restore cold-rebind fail-closed.

Si hubo sobreingenieria y un loop real de proceso. El proyecto empleo muchos
intentos en convertir diferencias de Kubernetes y respuestas ambiguas en
contratos exhaustivos, y el gate final repetia una bateria recovery enorme. El
problema no es que YenHubs se haya roto: es que la validacion local se convirtio
en el objetivo en vez de cerrar el restore que ve el cliente.

**Decision:** conservar el trabajo que ya demostro valor, congelar toda
arquitectura recovery nueva y terminar mediante un full valido, un restore y
una aceptacion real. Avance razonado: **85 %**.

## Evidencia comprobada en esta auditoria

### Repos y producto

- Root: rama `codex/h5-preflight`; candidato actual `3b8a6bd`, con el trabajo
  H5 congelado en commits locales revisables.
- Hubs: `ce8390a`, exactamente el baseline ya aceptado; no contiene cambios H5.
- Hubs Cloud: `7e56f90`, un commit H5 sobre su remoto y descendiente de `2.1.0`.
- La modificacion Cloud se limita al perfil target cold-rebind, su generacion,
  aplicacion y verificadores. No sustituye el cliente Hubs ni mezcla una
  feature nueva.

### Bundle y custodia

- Existe `output/checkpoints/h5-b16-20260813-022800` con los nueve ficheros
  exactos de `freeze-bundle-v1`.
- `SHA256SUMS` valida los otros ocho ficheros en los bytes actuales.
- DB: 356 relaciones, 94 migraciones, 18 hubs y 33 ficheros activos.
- Storage: 33 pares completos y cero diferidos en ese checkpoint.
- El recibo privado es regular, `0600`, declara dos copias con
  `decrypt_rehash=passed` y 13 imagenes custodiadas.
- No se reabrieron las copias remotas durante esta auditoria; su ultima
  verificacion queda documentada, no se repite sin una alarma del preflight.

### Estado live read-only

- Contexto `do-ams3-hubs-ce`; un nodo Ready con Kubernetes `v1.34.10`.
- DigitalOcean: un cluster no-HA, un nodo `s-4vcpu-8gb`, un LB activo en
  `ams3` y dos volumenes de 10 GiB.
- Namespace `hcce`: 12 Deployments; siete auxiliares Ready; los cinco writers
  tienen replicas deseadas y Ready iguales a cero.
- Dos PVC de 10 GiB Bound y cuatro certificados Ready.
- Cero Pods writer, backup o restore.
- Lock inmutable `checkpoint-restore`, estado `cold-rebind`, presente; Lease de
  serializacion presente y sin holder.
- La DB `retdb` tiene cero tablas de aplicacion. El preflight cold-rebind real
  paso de nuevo read-only y no escribio nada.
- El endpoint principal devuelve 503, resultado esperado mientras Reticulum
  permanece a cero; los cuatro DNS apuntan al LB nuevo.

No existe un P0 live: el target esta parado de forma segura. Si existe urgencia
economica porque nodo, LB y volumenes vuelven a estar asignados y facturando.

## Que era necesario

| Trabajo | Veredicto | Motivo |
|---|---|---|
| Bundle DB + `ret-pvc` del mismo instante | Necesario | Sin medios, el metaverso no se recupera |
| Dos copias cifradas y recibo | Necesario | Permite borrar recursos sin depender de un unico disco |
| Inventario y receta de infraestructura | Necesario | Hace reproducible la topologia y el coste |
| Separar greenfield de reactivacion | Necesario | Un cliente nuevo no tiene checkpoint |
| `cold-rebind` con UID nuevos | Necesario | Los UID originales desaparecen al recrear DOKS |
| Perfil Cloud `legacy-absent` | Necesario | Reproduce el baseline process-local realmente congelado |
| Restore coordinado y fail-closed | Necesario | Evita mezclar DB/medios o arrancar sobre datos parciales |
| Barrera temporal del checkpoint | Justificada para este ciclo | Impidio escritores transitorios durante la copia con RollingUpdate |

## Donde se produjo sobretrabajo

1. Se persiguieron respuestas perdidas, takeover, monitores y matrices mucho
   mas alla del requisito comercial inmediato. Ese trabajo puede conservarse,
   pero no debe seguir bloqueando H5.
2. Entre H5-B4 y H5-B16 hubo numerosos candidatos live para diferencias de
   defaults, monitors y helpers. Los STOP protegieron los datos, pero el metodo
   produjo demasiado feedback mediante produccion.
3. `tests/recovery/test-recovery-safety.sh` supera 18.000 lineas. Su alcance es
   util para regresion, no debe dirigir la prioridad del producto.
4. `verify-project.sh --full` ejecutaba recovery normal al inicio y `h5-final`
   volvia a caer en la misma bateria. Esa duplicacion real ya se ha eliminado.
5. El intento descrito como “full final” paso 855 aserciones y fallo 16 dentro
   del primer recovery. Por `set -e`, nunca llego a Hubs, navegador/capacidad,
   Hubs Cloud, Spoke ni Reticulum. No era un full parcialmente aceptable.

## Hallazgos y correcciones

### P1 — gate final incompleto

**Hallazgo:** no existe todavia un `--full` completo y verde.  
**Correccion:** dos familias causales cerradas (`75/75` y `55/55`), despacho
H5 desduplicado y un unico full pendiente sobre SHA congelado.

El primer full posterior a la auditoria se detuvo despues de 113 checks
recovery verdes por una carrera introducida en el propio fixture: varios
watchers escribian `serialization-lease.next`. La correccion no toca producto;
el refresco sintetico queda limitado a los modos unitarios. La reproduccion
dirigida del camino con heartbeat real pasa `49/49`, y las dos familias
adyacentes vuelven a pasar `55/55` y `75/75`.

El segundo full sobre `42a4142` cruzo esa frontera y alcanzo 672 checks verdes.
El primer fallo, el 673, seguia siendo del arnes: el monitor standalone heredaba
la captura de salida de `expect_success`, de modo que el helper no podia
continuar hasta su boundary; al envejecer la Lease aparecia un diagnostico
secundario de watch. La asercion positiva tambien conservaba la forma anterior
al fence H5: 12 ReplicaSets y Pods sin `admission_fingerprint`, frente a los 13
ReplicaSets validos (12 actuales mas uno historico inerte) y la huella admission
actual. El candidato `9377986` separa el log del proceso, usa temporales unicos
solo en refrescos sinteticos y actualiza esas formas. Evidencia final dirigida:
positivos backup/restore `46/46`, stale `46/46`, writer negativos `55/55`,
concurrencia padre `49/49` y contrato fence completo `100/100`; Bash, ShellCheck
y diff-check pasan. Aun falta el unico full completo, no otra arquitectura.

El siguiente full sobre root `38f2358` se detuvo antes de recovery: la primera
suite Node paso `32/32` y la segunda `56/57`. El unico rojo fue un helper de
cleanup en macOS, no el monitor: la consulta POSIX de un process group recibio
`EPERM` de forma transitoria y el test la trato como excepcion. Los PIDs y grupos
desaparecieron. `3b8a6bd` clasifica `EPERM` como «todavia existe», tolera esa
respuesta al señalizar y conserva el fallo final salvo que llegue `ESRCH`.
Prueba causal `1/1`, suite completa `57/57`, Node check y diff-check verdes.

### P1 — resultado live pendiente

**Hallazgo:** infraestructura nueva correcta, pero DB y medios no restaurados;
los writers siguen a cero.  
**Correccion:** limpieza exacta del lock, preflight inmediato y un solo restore
coordinado tras el full.

### P1 — aceptacion anterior demasiado estrecha

**Hallazgo:** APP/AFRAME y una carga de sala no bastan para el baseline vendido.
**Correccion:** la aceptacion final incluye español, login, dos usuarios/audio,
camaras, avatar, Admin, Spoke y sitting legacy.

### P1 — evidencia comercial incompleta

**Hallazgo:** el historial documenta cero recursos tras H5-B18, pero no hay un
artefacto independiente de facturacion en el checkout; tampoco existe RTO live
porque el restore final no termino.  
**Correccion:** recuperar evidencia historica read-only si aun existe y medir
el restore. No repetir una hibernacion solo para recrear la prueba.

### P1 — reproducibilidad Git y autoridad

**Hallazgo:** el plan nuevo no estaba versionado, el root esta por delante de su
remoto y Hubs Cloud aun no esta en su rama base.  
**Correccion:** una sola autoridad (`PLAN_ACTUAL.md`), candidato root versionado
antes del efecto live e integracion Cloud antes del gitlink root al cerrar.

### P2 — verificador duplicado

**Hallazgo:** el restore ya ejecuta el verificador live antes de liberar su
autoridad y el plan lo ordenaba de nuevo.  
**Correccion:** conservar ese resultado; repetir solo si no hay evidencia o el
estado cambia.

## Lo que no se vuelve a hacer

- otro checkpoint o nuevas copias;
- otro borrado/recreacion de DigitalOcean;
- otra arquitectura recovery o matriz de casos extremos;
- un segundo restore automatico;
- features, upstream o modernizacion dentro de H5;
- pruebas ya verdes sobre los mismos bytes.

## Pendiente exacto

1. congelar/versionar el candidato;
2. ejecutar un full valido una vez;
3. limpiar el lock exacto;
4. restaurar una vez y medir RTO;
5. aceptar el baseline comercial en navegador frio;
6. integrar Cloud y root y cerrar H5.

La ruta ejecutable y sus STOP estan en `PLAN_ACTUAL.md`.
