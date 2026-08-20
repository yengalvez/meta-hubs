# PLAN ACTUAL — terminar H5 y volver a features

Version: **v2**  
Estado: **EJECUTABLE**  
Ultima revision: **20 de agosto de 2026 (Europe/Madrid)**  
Autoridad: este es el unico plan ejecutable. El detalle de la auditoria esta en
`docs/auditoria-final-h5-2026-08-20.md`; los planes anteriores son historial.

## Resultado que importa

Demostrar una sola vez que una instancia YenHubs puede:

1. guardar conjuntamente PostgreSQL y los medios de `ret-pvc`;
2. apagar sus recursos facturables de DigitalOcean;
3. recrear la misma topologia con identidades Kubernetes nuevas;
4. restaurar datos y medios;
5. volver a ofrecer el baseline comercial en un navegador real.

Al cumplirlo, H5 termina. No se abre otra mejora de recovery dentro de este
plan; el siguiente trabajo sera una feature elegida por el propietario.

## Estado real

Avance razonado: **aproximadamente 85 %**. No es una medicion automatica: cinco
resultados comerciales estan terminados y quedan el restore, la aceptacion y la
integracion final.

### Terminado y no se repite

- [x] Baseline de producto aceptado; Hubs sigue en la release
  `prod-2026-03-11` y Hubs CE en `2.1.0`.
- [x] Bundle `freeze-bundle-v1` conjunto y valido: nueve ficheros, DB, medios,
  inventarios y checksums.
- [x] Dos copias cifradas reabiertas, descifradas y rehasheadas; recibo privado
  `0600`; 13 imagenes custodiadas.
- [x] Retirada selectiva del cluster, nodo, Load Balancer y dos volumenes
  autorizados; el recurso ajeno `voice-chat` se conservo.
- [x] Recreacion equivalente: `ams3`, Kubernetes `1.34.10-do.1`, HA false, un
  nodo `s-4vcpu-8gb`, LB regional y dos PVC de 10 GiB.
- [x] DNS y certificados `4/4`.
- [x] Perfil target `cold-rebind-legacy-absent-v1` generado, aplicado y
  preflight live read-only PASS.
- [x] Estado fail-closed actual: 12 Deployments, siete auxiliares Ready, cinco
  writers a cero, DB `retdb` sin tablas, cero Pods writer/helper, lock
  `checkpoint-restore/cold-rebind` retenido y Lease libre.
- [x] Las dos familias rojas del intento de full eran fixtures, no averias de
  producto: stale/helper `75/75` y writer-monitor `55/55` en los bytes finales.
- [x] Eliminada la duplicacion por la que `h5-final` repetia toda la bateria
  recovery normal.

### No demostrado todavia

- [ ] Un `./scripts/verify-project.sh --full` completo y verde sobre el
  candidato congelado. El intento anterior termino dentro del primer recovery
  y nunca alcanzo las suites full-only.
- [ ] Restore real de DB y `ret-pvc` en la infraestructura nueva.
- [ ] Baseline comercial completo en navegador frio.
- [ ] RTO real medido y evidencia historica del intervalo sin recursos
  facturables; si esta ultima no puede recuperarse, se documenta como no
  verificada y no se repite una hibernacion para fabricarla.
- [ ] Integracion final de Hubs Cloud y despues del puntero root.

## Camino critico finito

### F1. Congelar el candidato local

- [x] Revisar el diff final y retirar cualquier selector o diagnostico temporal
  que no pertenezca al arnes definitivo.
- [x] Ejecutar `bash -n`, ShellCheck, Gitleaks y `git diff --check` sobre la
  superficie modificada. No habia JavaScript modificado que requiriese otro
  Node check.
- [x] Versionar `PLAN_ACTUAL.md`, la auditoria, los fixes de fixture y la salida
  terminal de `h5-final`. Candidato de codigo root `3b8a6bd`, Hubs
  `ce8390a` y Hubs Cloud `7e56f90`.

**Cierre:** candidato reproducible y sin procesos locales residuales.

### F2. Ejecutar un unico gate final valido

- [ ] Ejecutar exactamente una vez, sobre los SHA congelados:

  ```bash
  ./scripts/verify-project.sh --full
  ```

- [ ] Preservar el resumen terminal y comprobar que la bateria recovery normal
  se ejecuta una vez y el agregado H5 solo ejecuta sus focos adicionales.

**Cierre:** comando completo verde.  
**STOP:** cualquier fallo. No hay restore ni relanzamiento automatico; primero
se identifica una causa concreta. Nunca se repiten los mismos bytes.

**Intento invalidado y cerrado:** el candidato anterior `cdf15ba` alcanzo 113
checks recovery verdes y fallo cuando un refresco sintetico de Lease del stub
uso el mismo temporal desde varios watchers. No fue un fallo live ni de
produccion. El refresco queda limitado a los modos unitarios que lo necesitan;
el camino con heartbeat real pasa `49/49`, writer-monitor `55/55` y
stale/helper `75/75` en `42a4142`.

**Segundo intento invalidado y cerrado:** el candidato `42a4142` cruzo la
carrera anterior y acumulo 672 checks recovery verdes. El primer fallo fue el
673, en el positivo standalone del writer monitor. La causa completa estaba en
el arnes: el proceso de fondo heredaba el canal de `expect_success`, impedia que
el helper enviase el boundary y envejecia la Lease; ademas, su asercion seguia
esperando el baseline anterior a H5 (12 ReplicaSets y Pods sin
`admission_fingerprint`). Produccion no cambio. En `9377986` pasan los dos
positivos `46/46` por owner, stale Lease `46/46`, negativos writer `55/55`,
concurrencia restore `49/49` y el bloque writer-fence completo `100/100`.

**Tercer intento invalidado y cerrado:** el root `38f2358` supero estaticos y
la primera suite Node `32/32`; la segunda termino `56/57` antes de recovery. El
unico fallo fue test-only y especifico de Darwin: `kill(-pgid, 0)` devolvio
`EPERM` durante el cleanup transitorio y el helper lo lanzo como excepcion. En
`3b8a6bd`, `EPERM` cuenta como grupo aun existente y no como ausencia; la
comprobacion final sigue exigiendo `ESRCH`, por lo que no se ocultan procesos.
El caso causal pasa `1/1` y la suite completa `57/57`.

**Intento posterior no aceptado:** el `--full` sobre `3b8a6bd` avanzo al menos
hasta `323` comprobaciones recovery verdes y ejecuto los restores coordinados
del bloque. El canal de terminal perdio su identificador durante una ventana de
espera; el proceso fue terminado externamente despues de aproximadamente 1 h
48 min y no existe codigo de salida ni resumen final recuperable. No se
observaron `not ok`, no se cambio ningun byte y no se puede afirmar que F2 sea
verde. El selector causal existente `restore-finalize-positive` se ejecuto
despues, una sola vez, y paso `54/54`; sirve para descartar esa frontera
concreta, pero no sustituye el full.

**Regla de reanudacion F2:** se permite una unica nueva ejecucion del mismo
candidato solo para recuperar evidencia persistente del gate incompleto
anterior. Debe arrancar desde un worktree limpio y escribir stdout/stderr y el
codigo de salida en un log privado persistente; si termina por timeout externo
otra vez, F2 queda inconclusa y no se formula otra hipotesis ni se relanza de
nuevo.

### F3. Completar una unica restauracion productiva

- [ ] Recapturar read-only contexto, topologia, Namespace/PVC, cinco writers,
  DB, Pods, lock y Lease. Deben coincidir con el estado permitido anterior.
- [ ] Obtener la confirmacion exacta y ejecutar una sola limpieza
  `RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1` con
  `RESTORE_TARGET_MODE=cold-rebind`.
- [ ] Confirmar que solo desaparecieron helper/policy si existian y el lock;
  Lease libre, writers cero, DB y PVC sin cambios.
- [ ] Ejecutar otra vez el preflight cold-rebind read-only inmediatamente antes
  de restaurar.
- [ ] Iniciar cronometro y ejecutar un unico restore coordinado del bundle y
  recibo ya validados. Nunca ejecutar DB y storage por separado.

**Cierre:** DB y medios validados, cinco writers reanudados en orden, lock y
Lease liberados y RTO registrado.  
**STOP:** identidad, topologia o coste distintos; Lease ocupada; lock no exacto;
respuesta ambigua o fallo del restore. Se conserva el estado fail-closed y no
se lanza un segundo restore en este plan.

### F4. Aceptar el producto real una sola vez

- [ ] Conservar el resultado `0 failures / 0 warnings` del verificador que el
  restore coordinado ejecuta internamente. Solo repetir el verificador si no se
  pudo conservar esa evidencia o si el estado cambio.
- [ ] En navegador interno frio y sin cache comprobar el baseline comercial:
  portada en espanol, magic link/login, entrada a `VJopCY3`, dos participantes
  y audio bidireccional, primera/tercera persona, avatar visible, Admin, Spoke y
  sitting legacy. Confirmar escena, medios y cero excepciones first-party.
- [ ] Bots solo se comprueban hasta el baseline ya prometido para esta
  instancia; H5 no introduce bots nuevos, runner durable, VR ni otras features.

**Cierre:** resultado observable por un cliente, no solo mocks o HTTP 200.

### F5. Integrar y cerrar

- [ ] Recuperar evidencia read-only del intervalo con cero recursos/facturacion
  si sigue disponible. No borrar ni recrear infraestructura para obtenerla.
- [ ] Actualizar `docs/estado-sencillo.md` y `docs/session-changelog.md` con
  hashes, RTO, resultado live y cualquier limitacion real.
- [ ] Integrar primero el commit Hubs Cloud en su rama base y despues el
  gitlink/root, siguiendo `docs/development-workflow.md`.
- [ ] Marcar H5 completo y entregar la siguiente decision de feature.

**Cierre:** repos reproducibles, documentacion fiel y cero tarea recovery
abierta en el camino critico.

## Lo que queda fuera

- nuevas matrices, monitores, receipts, HMAC, takeover o protocolos de
  respuesta ambigua;
- HA, HPA, Terraform, self-service multi-cliente o observabilidad nueva;
- upgrades upstream, features, modernizacion o refactors no requeridos por el
  restore actual;
- otro checkpoint, otras copias cifradas, otro borrado DigitalOcean o un
  segundo restore;
- `kubectl scale`, hotpatches, edicion del manifiesto generado o ejecucion
  manual de los hijos de restore.

## Reglas anti-loop

1. Un PASS sobre los mismos bytes no se repite.
2. Un FAIL no se relanza sin cambio causal y SHA nuevo.
3. Polling de un proceso no cuenta como un intento ni como progreso.
4. El full se ejecuta una vez por candidato congelado; no se sustituyen sus
   bloques por sumas parciales.
5. Un defecto de fixture se corrige en el fixture; no abre arquitectura de
   produccion.
6. Un fallo live conserva writers cero y autoridad; no autoriza un segundo
   restore.
7. No se crea otro plan, Goal ni auditoria H5 salvo evidencia material nueva.
8. Solo cuentan como progreso: requisito cerrado, riesgo eliminado, evidencia
   nueva o mejora observable del estado live.

## Punto de menor confianza

El riesgo restante no es el bundle ni la recreacion: es que el unico restore
real encuentre una diferencia que los ensayos locales no reprodujeron. La
defensa correcta es el preflight live ya verde, el full final, un solo restore
coordinado y la parada fail-closed; no otra capa de recovery.
