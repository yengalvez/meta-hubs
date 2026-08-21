# Estado sencillo de YenHubs

Ultima actualizacion: **21 de agosto de 2026**

## Respuesta corta

No estamos rehaciendo YenHubs ni tirando diez dias de trabajo. La parte
comercial dificil ya esta hecha: existe un bundle conjunto de base de datos y
medios, dos copias cifradas verificadas, se demostro el apagado de los recursos
facturables, se recreo la topologia en DigitalOcean y el destino nuevo esta
preparado para recibir el restore.

Avance razonado: **aproximadamente 85 %**. Lo que falta no es otra arquitectura:
el recovery normal termino `871/871`, H5 `173/173` y el generador `32/32`. El
full corregido llego hasta `test:apply` y dejo `119/120`; solo fallo una prueba
de limpieza de un grupo de procesos detached, por timeout de `180001 ms`. El
mismo caso habia pasado en el full anterior en `1006 ms` y no hubo cambios en
ese watcher. Una reejecucion aislada del caso paso `1/1` en `1026 ms`; por tanto
el bloqueo queda acotado al contexto concurrente de `test:apply`, no a una
regresion demostrada del metaverso. No se repite el full hasta tener evidencia
nueva de ese contexto.

La unica autoridad de trabajo es [`PLAN_ACTUAL.md`](../PLAN_ACTUAL.md). La
auditoria tecnica completa esta en
[`docs/auditoria-final-h5-2026-08-20.md`](auditoria-final-h5-2026-08-20.md).

## Para que sirve realmente H5

H5 permite hibernar el metaverso de un cliente cuando deja de pagar o cuando no
se va a usar durante un tiempo:

1. guardar PostgreSQL y todos los medios de `ret-pvc` en el mismo bundle;
2. conservar copias cifradas fuera de DigitalOcean;
3. retirar cluster, nodo, Load Balancer y volumenes para dejar de pagarlos;
4. recrear mas adelante una topologia equivalente con identidades nuevas;
5. restaurar datos y medios y volver a abrir el producto.

No es alta disponibilidad. Mientras esta hibernado, el metaverso esta apagado.

## Lo que ya esta terminado y no se repite

- Producto y forks preservados; no se ha sustituido el Hubs que funcionaba.
- Bundle `freeze-bundle-v1` valido con DB, medios, inventarios y checksums.
- Dos copias cifradas verificadas y recibo privado; 13 imagenes custodiadas.
- Borrado selectivo demostrado sin tocar el recurso ajeno `voice-chat`.
- Topologia nueva exacta: `ams3`, Kubernetes `1.34.10-do.1`, HA desactivada,
  un nodo `s-4vcpu-8gb`, LB regional y dos PVC de 10 GiB.
- DNS y certificados `4/4`.
- Perfil `cold-rebind-legacy-absent-v1` y preflight live read-only verdes.
- Ensayo local real con Namespace/PVC nuevos: DB y medios recuperados juntos,
  `14/14` y sin lock residual.
- Hubs/Hubs Cloud y cobertura H5 ya implementados; no se abre otra linea de
  monitores, receipts, HMAC o takeover.
- Recovery normal final `871/871`, sin `not ok`, con log persistente y sin
  proceso residual. No se repite.

## Estado productivo actual

El destino esta parado de forma segura, no roto:

- 12 Deployments y siete auxiliares Ready;
- los cinco servicios que escriben estan a cero;
- DB `retdb` sin tablas de aplicacion;
- dos PVC de 10 GiB Bound;
- cero Pods writer, backup o restore;
- lock exacto `checkpoint-restore/cold-rebind` retenido;
- Lease de serializacion libre.

Por eso la web principal devuelve 503 ahora: Reticulum sigue deliberadamente a
cero hasta que el restore termine.

## Que ocurrio con las pruebas largas

La auditoria encontro un loop real en el proceso: una bateria recovery enorme
se repetia y un agregado H5 iba a volver a ejecutarla. Esa duplicacion ya se
elimino.

El primer full del plan nuevo paso 113 checks y encontro una carrera del stub
de Lease. Se corrigio solo el fixture y el camino padre concurrente quedo
`49/49`.

El segundo full cruzo esa zona y paso **672 checks**. El primer fallo fue el
673, otra incompatibilidad del fixture positivo: el proceso del monitor dejaba
abierto el canal de captura y la asercion esperaba el baseline anterior al
fence H5. No fue una averia del metaverso ni una regresion productiva.

El tercer full supero estaticos y la primera suite Node `32/32`, pero se detuvo
antes de recovery con `56/57`: macOS devolvio `EPERM` al consultar un process
group que estaba terminando y el helper de cleanup lo trato como excepcion. Los
procesos desaparecieron y producto no cambio. La correccion mantiene el control
estricto: `EPERM` significa «aun existe» y solo `ESRCH` confirma ausencia.

El candidato anterior fue **`3b8a6bd`**. Evidencia dirigida sobre sus bytes:

- positivo backup `46/46`;
- positivo restore `46/46`;
- Lease caducada `46/46`;
- negativos writer `55/55`;
- restore con heartbeat padre `49/49`;
- contrato writer-fence completo `100/100`;
- cleanup causal de process group `1/1` y suite Node completa `57/57`;
- Bash, ShellCheck y `git diff --check` verdes.

Estas pruebas no sustituyen el full; demuestran que existe una causa concreta y
que no hemos reabierto la carrera anterior.

El intento siguiente del `--full` avanzo al menos hasta `323` checks recovery
verdes y entro en restores coordinados, pero el terminal perdio su identificador
durante una espera y el proceso fue terminado externamente tras unas 1 h 48
min, sin codigo de salida ni resumen final recuperable. No se cuenta como verde
ni como fallo de producto. El selector causal `restore-finalize-positive` paso
`54/54` despues, descartando esa frontera concreta.

La unica repeticion permitida del candidato anterior se ejecuto con log
persistente. El primer fallo nuevo fue el caso 173: el mutador del fixture no
vio el marcador de inicio del stream dentro de 90 s, aunque el producto se
quedo fail-closed con writers a cero, lock presente y fence activa. La
reproduccion aislada paso `50/50` y el grupo secuencial DB/medios paso `72/72`.
Ese resultado cerro el candidato anterior; no se reutiliza como excusa para
repetirlo.

El candidato vigente es **`10a1aa1`**. Tras aislar el perfil sintetico que
contaminaba los guards de restore, la unica ejecucion persistente del recovery
normal termino con `All 871 recovery safety tests passed using local fixtures
only.`; no hay ningun `not ok` y el PID `14324` ya no existe. El log privado es
el indicado en `PLAN_ACTUAL.md`. El lanzador no escribio `exit.status`, por lo
que no se afirma un codigo numerico; la evidencia terminal sí cierra este gate.

El siguiente `--full`, sobre root `8c01608`, ya alcanzo las suites que antes no
se habian ejecutado: H5 `173/173`, generador Hubs CE `32/32` y `test:apply` con
`120` tests quedaron verdes. Termino con codigo `1` exclusivamente al auditar
`bot-orchestrator`: Puppeteer arrastraba `extract-zip 2.0.1`, publicado ahora
como advisory alto. Puppeteer no entra en las imagenes productivas; solo sirve
al diagnostico Chromium manual. Cloud `d74cded` ya la contiene y la validacion
dirigida queda verde: audit de produccion en cero, `bot-orchestrator` `155/155`,
Puppeteer cargable para el diagnostico manual y sin Puppeteer en el arbol
`--omit=dev`.

El candidato vigente del full es root **`972efe3`** con Cloud **`d74cded`**.
Su unico full persistente termino con codigo `1` tras recovery `871/871`, H5
`173/173`, generador `32/32` y `test:apply` `119/120`. El unico `not ok` fue
`apply/watch-evidence-process.test.js:269`, caso 92, sobre recoger un grupo de
procesos detached despues de que termina su lider. El log privado es
`/var/folders/t5/k22wlmd54b32xnqlqrxvglh80000gp/T//yenhubs-full-candidate.5yFlsm/full.log`.
No hay cambios de produccion, DigitalOcean ni procesos residuales. No se lanza
otro full sin una revision causal de ese test; la siguiente comprobacion, si se
reabre F2, es solo `npm run test:apply` una vez.

## Lo que queda, en orden

1. Resolver o aceptar explícitamente el único test de process-group; solo una
   causa demostrada permite un nuevo full. No repetir recovery, H5 ni
   `test:apply` por separado.
2. Recapturar el estado live y limpiar una sola vez el lock stale exacto,
   unicamente despues de reabrir F2 con esa decision.
3. Ejecutar un unico restore coordinado de DB y medios y medir el RTO.
4. Aceptar en navegador frio: español, login, dos usuarios/audio, camaras,
   avatar, Admin, Spoke, sitting y medios.
5. Integrar primero Hubs Cloud y despues el puntero root; cerrar H5 y volver a
   features.

## Regla para no volver al loop

- Un PASS sobre los mismos bytes no se repite.
- Un FAIL necesita una causa demostrada y un SHA nuevo.
- Un defecto de fixture no abre trabajo de produccion.
- Un full con un solo fallo no significa volver al principio: conserva todos
  los bloques verdes y solo reabre la firma causal pendiente.
- No habra otro checkpoint, otro borrado DigitalOcean ni un segundo restore.
- No se añaden mejoras recovery, HA, upgrades o features antes de cerrar H5.
- El full completo sigue sin estar verificado; las sumas parciales no se
  presentaran como si fuera verde.

## Confianza humana

La confianza es alta en el bundle, la recreacion, el estado fail-closed y los
bloques recovery/H5 que ya tienen evidencia. Quedan dos incertidumbres acotadas:
el caso de process-group que agoto el timeout una vez y la diferencia que el
restore productivo pueda encontrar y que los ensayos locales no reprodujeron.
La defensa correcta es resolver primero esa firma sin tocar produccion, luego
un unico full verde, el preflight live ya verde y un unico restore fail-closed;
no mas ingenieria preventiva.
