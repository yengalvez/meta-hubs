# Estado sencillo de YenHubs

Ultima actualizacion: **20 de agosto de 2026**

## Respuesta corta

No estamos rehaciendo YenHubs ni tirando diez dias de trabajo. La parte
comercial dificil ya esta hecha: existe un bundle conjunto de base de datos y
medios, dos copias cifradas verificadas, se demostro el apagado de los recursos
facturables, se recreo la topologia en DigitalOcean y el destino nuevo esta
preparado para recibir el restore.

Avance razonado: **aproximadamente 85 %**. Lo que falta no es otra arquitectura:
es conseguir un unico gate completo verde, restaurar una vez, comprobar el
producto en navegador real e integrar los commits.

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

El candidato actual es **`9377986`**. Evidencia dirigida sobre sus bytes:

- positivo backup `46/46`;
- positivo restore `46/46`;
- Lease caducada `46/46`;
- negativos writer `55/55`;
- restore con heartbeat padre `49/49`;
- contrato writer-fence completo `100/100`;
- Bash, ShellCheck y `git diff --check` verdes.

Estas pruebas no sustituyen el full; demuestran que existe una causa concreta y
que no hemos reabierto la carrera anterior.

## Lo que queda, en orden

1. Ejecutar una sola vez `./scripts/verify-project.sh --full` sobre el candidato
   congelado. Si falla, STOP en la primera causa nueva; no relanzar igual.
2. Recapturar el estado live y limpiar una sola vez el lock stale exacto.
3. Ejecutar un unico restore coordinado de DB y medios y medir el RTO.
4. Aceptar en navegador frio: español, login, dos usuarios/audio, camaras,
   avatar, Admin, Spoke, sitting y medios.
5. Integrar primero Hubs Cloud y despues el puntero root; cerrar H5 y volver a
   features.

## Regla para no volver al loop

- Un PASS sobre los mismos bytes no se repite.
- Un FAIL necesita una causa demostrada y un SHA nuevo.
- Un defecto de fixture no abre trabajo de produccion.
- No habra otro checkpoint, otro borrado DigitalOcean ni un segundo restore.
- No se añaden mejoras recovery, HA, upgrades o features antes de cerrar H5.
- El full completo es el unico gate local pendiente; las sumas parciales no se
  presentaran como si fuera verde.

## Confianza humana

La confianza es alta en el bundle, la recreacion y el estado fail-closed. La
incertidumbre material que queda es una sola: que el restore productivo encuentre
una diferencia que los ensayos locales no reprodujeron. La defensa correcta es
el full, el preflight live ya verde y un unico restore fail-closed; no mas
ingenieria preventiva.
