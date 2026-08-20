# Estado sencillo de YenHubs

Ultima actualizacion: **20 de agosto de 2026**

## Respuesta corta

El metaverso no se esta rehaciendo y produccion no ha sido sustituida.

El objetivo correcto es poder **hibernar la instancia de un cliente para dejar
de pagar DigitalOcean y recuperarla mas adelante sin una reconstruccion
artesanal**.

La auditoria ha descubierto que estabamos profundizando en el problema
equivocado. Se habia construido un coordinador muy complejo para reaccionar a
fallos ambiguos durante una copia. Sin embargo, el restore que existe sigue
exigiendo los UID antiguos del Namespace y del volumen, por lo que no puede
restaurar directamente sobre el cluster nuevo que aparece despues de borrar el
anterior.

Por eso el trabajo complejo queda congelado y seguimos un plan corto. Ese
cambio ya ha dado el resultado principal: el restore sobre identidades nuevas
ha funcionado en un Kubernetes local real.

## Que queremos conseguir

```text
cliente activo
  -> guardar DB + escenas/avatares/Spoke/medios
  -> comprobar la copia y guardarla cifrada fuera de DigitalOcean
  -> registrar versiones, digests, DNS y dependencias
  -> borrar los recursos que siguen cobrando
  -> meses despues crear infraestructura nueva
  -> restaurar todo sobre Namespace/PVC nuevos
  -> comprobar el metaverso en un navegador real
  -> volver a features
```

Esto es **hibernacion y reactivacion**, no alta disponibilidad. Mientras la
instancia esta hibernada, el metaverso esta apagado. Mantenerlo online aunque
falle un servidor seria otro proyecto y otro coste.

## Que estaba haciendo el plan anterior

Intentaba resolver automaticamente situaciones como:

- Kubernetes hizo un cambio pero se perdio la respuesta;
- murio un monitor justo entre dos cambios;
- otro proceso encontro un lock a mitad de operacion;
- no se sabia si habia que reanudar un servicio una o dos veces.

Esa seguridad puede tener valor en una plataforma grande y multioperador, pero
no es la pieza que permite borrar DigitalOcean y volver meses despues. Ademas,
su complejidad habia creado otro riesgo: una copia coherente podia descartarse
si despues fallaba el reencendido de un servicio.

## Que conservamos

- el producto Hubs que ya funcionaba;
- las features existentes en los forks;
- la copia conjunta de PostgreSQL y `ret-pvc`;
- validacion de hashes, salas y pares de medios;
- commits, versiones e imagenes por digest;
- inventario de infraestructura y dependencias;
- publicacion atomica, preflights y verificacion final;
- una segunda copia cifrada fuera del cluster.

No se borra el trabajo avanzado. Queda preservado en su rama como investigacion,
pero deja de bloquear el producto.

Los tres ficheros tecnicos sin commit del recovery anterior siguen intactos y
no se consideran parte del nuevo candidato. El worktree limpio
`codex/client-hibernation` ya parte de `origin/main` y H2 solo reutilizo las
piezas incluidas en el contrato minimo aprobado.

## Donde estamos

```text
[HECHO] Producto base y forks preservados
[HECHO] Auditoria general y objetivo comercial aclarado
[HECHO] Detectar que el restore actual no admite un cluster/PVC nuevos
[HECHO] Preservar la rama antigua y partir limpio de main
[HECHO] Fijar el bundle minimo y el mapa de piezas que se conservan
[HECHO] Aceptacion real: login, dos usuarios, audio, camara, avatar, Admin y Spoke
[HECHO] H2: bundle y restore sobre identidades nuevas implementados localmente
[HECHO] H3: DB y medios restaurados juntos en K3s con UID nuevos, 14/14 verde
[HECHO] H4 local: gate integral, builds y pruebas de todos los componentes
[HECHO] H4 remoto: CI terminal verde y fusion ordenada
[EN CURSO, AUTORIZADA] H5: producir el bundle y ejecutar la ventana real
[FINAL] Cerrar recovery y volver a features
```

**H1 esta terminado.** Se comprobaron login real, Admin, el proyecto Spoke, la
sala con dos presencias, el avatar, primera/tercera persona y los dos microfonos.
Silenciar y reactivar cada cliente se reflejo en el otro en tiempo real. No se
guardo ni publico contenido y no se toco DigitalOcean.

**H2 esta terminado localmente.** El sistema produce los nueve ficheros exactos
de `freeze-bundle-v1`, valida un recibo externo, separa el preflight sin cluster
del preflight del target y puede restaurar DB y medios juntos sobre Namespace y
PVC con UID nuevos. Si la comprobacion live falla despues de escribir, vuelve a
dejar los cinco consumidores a cero y conserva el lock para no fingir exito.

**H3 esta terminado.** En un K3s local real se creo un origen y un destino con
identidades distintas de cluster, Namespace y PVC. Se restauro una DB de `356`
relaciones, `94` migraciones y `17` hubs junto a avatar, escena, proyecto Spoke
y un medio diferido. Los tres UUID activos y todos los bytes coincidieron; los
cinco servicios terminaron `1/1`, sin lock residual. El ensayo paso `14/14`.

La reactivacion local medida tardo `11 s`, pero eso no incluye comprar/recrear
DOKS, descargar imagenes, DNS, certificados ni la aceptacion de navegador. Por
tanto es evidencia tecnica, no una promesa comercial de RTO.

**H4 esta cerrado.** El candidato final paso las `865` regresiones, seguridad y
PostgreSQL 12/14. Hubs Cloud `#23` y el repositorio raiz `#16` quedaron
fusionados en ese orden. Los detalles tecnicos e intentos anteriores estan en
`docs/session-changelog.md`; ya no son trabajo activo ni un punto de reanudacion.

El siguiente paso es H5, pero ya no se trata como un unico bloque que obliga a
esperar. Se divide en dos partes:

- **H5-A, cerrada:** preparacion local y de solo lectura. Inventario de costes y
  recursos, preflights, checkpoint/segunda copia, digests, escrow, orden de la
  ventana y rollback. No apaga nada, no crea recursos y no depende de GitHub.
- **H5-B, despues:** la ventana real que borra y recrea recursos DigitalOcean.
  Solo esta segunda parte requiere una autorizacion concreta sobre una lista
  exacta de efectos y costes.

H5-A se preparo en `codex/h5-preflight`. H5-B ya tiene autorizacion y custodia
manual confirmada, pero produccion sigue intacta porque el primer uso real
encontro una brecha antes del downtime.

La primera lectura H5-A ya esta hecha: produccion mantiene `12/12`
Deployments, `13/13` contenedores por digest, un Load Balancer y dos volumenes
que suman `20 GiB`; no hay recovery lock. El productor de checkpoint tambien
demostro que, sin la bandera explicita de downtime, se detiene antes de crear
un artefacto o parar servicios. El paquete comprensible y sus casillas viven en
`docs/h5-window-package.md`.

La preparacion ha avanzado sin volver a CI. Ya estan terminados el inventario,
la hoja exacta de efectos, el ensayo de cifrado y la custodia local de las
imagenes. Las `12` imagenes unicas de los `13` contenedores ocupan
`1,378,619,392` bytes en un layout OCI: los `12` digests vivos estan presentes,
las `12` referencias se abren offline y `214/214` blobs pasan SHA-256. GitHub
Packages muestra USD `0` facturados y tiene presupuesto USD `0` con parada de
uso, por lo que no se ha abierto un riesgo de cobro.

Para este primer ciclo no hace falta una tercera ubicacion: una copia cifrada
local fuera de Dropbox y otra cifrada dentro de Dropbox son las dos copias
operativas. Un disco externo o segundo cloud queda como mejora opcional. Google
Password Manager ya se comprobo accesible desde la cuenta Google sin abrir
ninguna contraseña, y las referencias opacas quedaron definidas.

**H5-B esta autorizada y ya tuvo su primer intento con downtime.** El checkpoint
paro los cinco servicios que pueden escribir, pero el monitor de seguridad no
confirmo su estado `ready`; por eso el sistema se detuvo antes de copiar la DB o
los medios. Se reanudaron los cinco servicios, se comprobaron los `12/12`
Deployments y se retiro el lock exacto. Los datos y los recursos DigitalOcean
no se borraron ni se recrearon.

La causa ya no es una hipotesis: Kubernetes devuelve LIST superiores tipados,
pero omite `apiVersion` y `kind` dentro de todos sus elementos live. El monitor
exigia esos campos repetidos y fallo primero al leer los ReplicaSets. Se ha
corregido de forma estrecha: acepta ausencia/null solo dentro de un LIST cuya
forma superior ya es exacta, pero sigue rechazando cualquier tipo explicito
falso y mantiene los eventos WATCH estrictos. El positivo pasa `46/46`, los
tres negativos pasan `48/48`, los chequeos estaticos estan verdes y una revision
independiente dio GO.

Tambien esta terminada la receta greenfield: el perfil opt-in genera la variante
legacy que corresponde al runtime actual, con los cinco writers a cero y sin
introducir el control plane durable. Sus `32/32` tests estan verdes.

**La repeticion causal ya se hizo y activo el STOP anti-loop.** Los ocho
metadatos de freeze estaban completos y la captura redactada termino, pero el
monitor volvio a fallar en `baseline` antes de quedar listo. Por tanto la
correccion de GVK era real, pero no suficiente para completar el baseline live.
No se copiaron la DB ni los medios y no existe un bundle valido.

El rollback restauro exactamente los cinco servicios. La comprobacion final
dio `12/12` Deployments disponibles, sin recovery lock y con la Lease libre.
DigitalOcean, los datos y DNS siguen intactos.

Esto evito que entraramos en loop: antes de intentar otra vez se hizo una unica
autopsia de solo lectura. Los siete Pods que no escriben diferian de sus
ReplicaSets solo porque Kubernetes añade `enableServiceLinks=true` y copia los
`imagePullSecrets` del ServiceAccount. Los `7/7` coincidieron exactamente con su
ServiceAccount; no habia un Pod extraño ni ownership roto.

La correccion conserva la seguridad: el ServiceAccount y sus credenciales de
pull quedan ligados al baseline y cualquier cambio inicial o durante WATCH se
rechaza. El foco nuevo pasa `49/49` y la revision adversarial final dio GO. Se
descarto quitar el watcher, porque necesitamos detectar si un writer se
enciende y vuelve a apagar durante la copia.

El **candidato final se ejecuto y volvio a fallar en `baseline`**. Se recuperaron
de nuevo los cinco servicios y el estado terminal es sano: `12/12`, sin lock,
Lease libre, cero bundles publicados y DigitalOcean intacto.

Por tanto se cierra definitivamente esa ruta automatica. Las dos correcciones
encontradas eran reales, pero el monitor sigue convirtiendo diferencias de la
plataforma live en una sucesion de bloqueos. Continuar con un tercer detalle y
un cuarto checkpoint seria exactamente el loop que queriamos evitar.

El gestor mostro una alerta general sobre otras contraseñas, pero la clave H5
es nueva y su custodia en la cuenta quedo confirmada. Esa alerta general no
bloquea este ciclo ni obliga a abrir contraseñas ajenas; solo se rotaria la
entrada H5 si el propio gestor llegara a marcarla como comprometida, sin
imprimir su contenido.

Ya elegiste la opcion **1, la segura**, y la implementacion local esta
terminada. La barrera temporal impide que Kubernetes cree o cambie Pods mientras
se copian la base de datos y los medios. Solo permite el ayudante exacto de
storage, configurado como solo lectura. No se ha reabierto el watcher que nos
llevo al loop.

En lenguaje sencillo, el nuevo recorrido es: cerrar la puerta de entrada de
los escritores, comprobar de verdad que esta cerrada, apagarlos, copiar DB y
medios, validar el bundle, retirar la puerta con identidad exacta y volver a
encenderlos. Durante las copias habra un guard ligero que detendra el proceso
si cambian la Lease, el lock o la propia barrera.

La prueba local final pasa **73/73** y el helper puro **8/8**; sintaxis,
ShellCheck y diff-check tambien pasan. La revision adversarial final dio GO sin
fallos P0/P1/P2. Incluye el caso dificil que faltaba: si Kubernetes crea la
barrera pero falla justo la lectura de confirmacion, no se liberan el lock ni
la Lease y no se apagan los servicios.

La ventana H5-B4 ya termino. No llego a apagar servicios ni a copiar datos:
Kubernetes creo solo la mitad inerte de la barrera y el proceso paro al ver que
el objeto recibido tenia campos por defecto que el validador local no esperaba.
El binding nunca existio, por lo que esa policy no bloqueaba nada.

El rollback se hizo por identidad exacta: se retiro la policy, se retiro el
lock y se libero la Lease. El estado final vuelve a ser **`12/12`**, con los
cinco writers `1/1`, sin barrera, sin lock, sin Lease, sin bundle y sin cambios
en DigitalOcean.

El primer preflight se detuvo antes de tocar Kubernetes porque tomo una copia
privada historica que no declaraba el modo runner. No hubo downtime. Ya esta
corregida la entrada, no el producto: el snapshot privado nuevo coincide
`13/13` con las imagenes live, conserva modo `0600` y declara el baseline
`process-local`. Por esa evidencia concreta se permite un unico intento real;
si aparece una firma nueva, se para sin encadenar otro parche.

El candidato H5-B5 se ejecuto con la autorizacion continua. Kubernetes acepto
la policy, pero añadio tambien defaults a la binding; el proceso los rechazo
antes de apagar servicios. Se retiraron binding, policy y lock por identidad
exacta y se libero la Lease. Produccion volvio a **`12/12`**, sin barrera, lock,
Lease, bundle ni cambios DigitalOcean.

Para no descubrir los defaults uno a uno, se cambio el metodo. Antes de crear
nada persistente, ahora se envian policy y binding al propio API con
`--dry-run=server` y se validan exactamente sus respuestas. El foco pasa
**49/49**, la regresion de la barrera **77/77** y el dry-run contra produccion
ha pasado dejando ambos objetos ausentes. La siguiente accion es un unico
candidato H5-B6 con este preflight; no es otra hipotesis sobre el mismo metodo.

H5-B6 paso ese preflight y creo correctamente la pareja, pero paro al probar el
helper: la barrera bloqueaba tambien ese Pod porque Kubernetes omite el campo
`subResource` en un CREATE base. El rollback volvio a dejar `12/12` y cero
residuos. La condicion se ha ajustado con la misma forma segura que ya usa el
watcher; cualquier subrecurso real sigue rechazado. El helper pasa **17/17**, el
smoke real completo pasa sin tocar writers y H5-B3 vuelve a pasar **77/77**.
La siguiente accion es un unico H5-B7 bajo la autorizacion continua.

H5-B7 demostro que la barrera y su excepcion ya funcionan: los cinco writers
se pausaron. H5-B8 logro arrancar el monitor PostgreSQL, pero este fallo durante
el volcado. En ambos casos el rollback restauro exactamente los cinco servicios
y termino `12/12`, sin residuos ni bundle.

La siguiente ruta cambia el metodo y evita repetir el mismo problema. Durante
freeze, la barrera ya impide crear o modificar Pods; por eso no se mantiene un
segundo monitor continuo de PostgreSQL. Se comprueba la fuente exacta justo
antes y despues del volcado, y si el Pod desaparece el propio `pg_dump` falla.
Las rutas antiguas conservan su monitor. Esta variante pasa **77/77** en la
barrera y **161/161** en los hijos checkpoint; H5-B9 es el unico candidato
siguiente. Si aparece una firma nueva, se para: no se inventa H5-B10.

H5-B9 llego mas lejos: termino el volcado, pero su verificador rechazo el
contrato SQL critico. Por seguridad no publico el bundle. El rollback termino
con **12/12**, los cinco writers **1/1**, sin barrera, lock ni Lease; DigitalOcean
sigue intacto. Una comprobacion posterior sin downtime encontro PostgreSQL
12.19, los tres schemas, 356 relaciones, los COPY y los inventarios criticos
coincidentes. El problema es que el mensaje del intento agrupaba varias reglas
y el dump rechazado se limpio, por lo que todavia no sabemos cual fallo.

En lenguaje sencillo: los datos live no parecen faltar, pero tampoco podemos
declarar bueno un backup que el validador rechazo. El siguiente trabajo es
hacer que esa comprobacion diga exactamente que regla falla, sin volver a parar
produccion. Hasta entonces no hay otro checkpoint ni se borra DigitalOcean.

Ese diagnostico ya esta cerrado. PostgreSQL 12.19 pone una linea de comentario
vacia `--` despues del marcador final. El verificador antiguo no la aceptaba,
aunque el dump estuviera completo. Ahora acepta exclusivamente ese footer
canonico y sigue rechazando contenido extra o duplicado. Las pruebas pasan
**7/7** y un dump real de solo lectura supera todo el contrato. H5-B11 es un
unico checkpoint habilitado; DigitalOcean sigue sin tocarse.

H5-B11 confirmo que la parte de base de datos ya funciona: **356 relaciones,
94 migraciones, 18 hubs y 33 medios activos**. Paro al preparar la red temporal
del helper de medios. Kubernetes elimina del JSON las dos listas deny-all
vacias, aunque su efecto no cambia; nuestro comparador esperaba verlas.

La correccion acepta solo ambas listas vacias o ambas omitidas y rechaza
cualquier regla real, omision parcial o `null`. Pasa **88/88** y el dry-run del
API real confirma esa forma. El rollback dejo **12/12**, writers **5/5** y cero
residuos. H5-B12 es el siguiente candidato, pero se separa del intento anterior
para cumplir la regla anti-loop. DigitalOcean continua intacto.

H5-B12 volvio a validar la base de datos y avanzo hasta el helper de medios. La
red temporal ya era correcta; esta vez paro porque el monitor local de storage
no termino su primer barrido. El rollback dejo **12/12**, writers **5/5**, sin
lock, Lease ni bundle. Tambien se retiraron por identidad exacta dos policies
huerfanas de B11/B12 que no tenian ningun Pod asociado.

En el modo freeze ese monitor era redundante: la barrera ya bloquea cualquier
Pod nuevo o modificado salvo el helper exacto de solo lectura. Ahora se valida
el helper, la policy, el PVC y todos sus consumidores justo antes y despues de
copiar los medios. Las rutas legacy/durable mantienen el monitor. Las pruebas
quedan **77/77** y **161/161**, con ShellCheck y diff-check verdes. El siguiente
paso automatico es H5-B13; el avance global sigue cerca del **65%** hasta que
exista un bundle valido.

H5-B13 confirmo otra vez la DB, pero la copia de medios termino con error dentro
del supervisor o de la comprobacion posterior. Todo se recupero: **12/12**,
writers **5/5**, sin barrera, lock, Lease ni bundle; la unica policy residual se
elimino por identidad exacta. Una lectura independiente del mismo `ret-pvc` con
`tar|gzip` dio **0/0**, asi que los medios son legibles. El siguiente candidato
solo añade una etapa diagnostica cerrada para separar supervisor de limite
post-stream; no repite una hipotesis a ciegas. El porcentaje global no sube aun.

H5-B14 lo separo: **DB y medios ya estaban copiados y validados**; el fallo era
solo el borrado `Foreground` del Pod helper, que quedaba terminando mas de 180
segundos. Ese Pod no tiene dependientes. Ahora usa borrado normal `Background`,
UID exacto, espera `NotFound` y un grace period de 1 segundo, sin forzar el
borrado. Un smoke live sin downtime lo elimino en **4 segundos**, sin residuos
y con writers **5/5**. Las pruebas quedan **17/17** y **77/77**. H5-B15 es el
candidato funcional; el porcentaje sigue conservador hasta publicar el bundle.

H5-B15 paro antes de pausar servicios porque el segundo constructor del probe
no llevaba el nuevo grace period. La barrera lo rechazo correctamente. Se ha
igualado ese constructor y añadido una prueba especifica; la matriz final pasa
**78/78**. Produccion quedo **12/12**, sin lock, Lease, barrera ni residuos.
H5-B16 es el siguiente candidato y no cambia aun el porcentaje global.

## 13 de agosto: el bundle completo ya esta terminado

H5-B16 ha terminado bien. La copia conjunta contiene tanto la base de datos
como los medios de Reticulum y ha pasado su validacion interna: 356 relaciones,
94 migraciones, 18 hubs, 33 ficheros activos y 33 pares de medios completos.
Despues del proceso, el metaverso volvio a su estado normal: **12/12 servicios**
y **5/5 escritores**, sin barreras ni bloqueos residuales.

Esto coloca el ciclo H5 aproximadamente en el **75%**. Ya no queda desarrollar
otro sistema de backup. Quedan tres resultados finitos:

1. crear y reabrir dos copias cifradas verificadas, una local fuera de Dropbox
   y otra en Dropbox;
2. apagar solo los recursos DigitalOcean previamente inventariados y comprobar
   que la instancia queda realmente hibernada;
3. recrear la misma topologia, restaurar el bundle y validar el metaverso en un
   navegador real.

El objetivo activo autoriza continuar automaticamente entre esos pasos. Solo se
para ante una diferencia real de cuenta, recurso, coste o topologia, una copia
que no pueda verificarse, un secreto no recuperable o riesgo para recursos
ajenos. Un fallo ordinario de prueba se diagnostica y corrige sin pedir permiso.

El inventario DigitalOcean se ha refrescado sin modificar nada y coincide con
la autorizacion: un cluster con un nodo, un Load Balancer, dos volumenes de
10 GiB y el firewall `voice-chat` separado para conservarlo. Sus identidades
exactas estan en un expediente privado `0600`. Las carpetas de las dos copias
estan preparadas; el unico paso humano abierto es confirmar la llave de acceso
de Google para recuperar la clave H5 sin mostrarla.

Las dos copias cifradas ya existen. La local se ha descifrado y rehasheado; la
de Dropbox esta subida completamente, tiene identidad/version remotas y su
lectura posterior completa coincide byte a byte. Google vacio automaticamente
la clave del portapapeles antes del ultimo descifrado post-subida. No es una
corrupcion ni un fallo del bundle: solo hay que copiar otra vez esa clave y
ejecutar inmediatamente la comprobacion final y el recibo privado.

## 13 de agosto: hibernacion real completada

La clave se recupero y las dos copias pasaron el descifrado y rehash. Dropbox
confirmo subida completa, identidad/version remotas y lectura posterior total.
El recibo privado `0600` liga las dos copias y las 13 imagenes, y el preflight
offline greenfield paso completo.

DigitalOcean se apago solo por las identidades autorizadas. El resultado real
es: **0 clusters, 0 Droplets, 0 Load Balancers y 0 volumenes**. El firewall
ajeno `voice-chat` se conserva. Esto demuestra por primera vez la hibernacion
comercial completa y elimina el coste base vivo de esa instancia.

El avance global esta ahora aproximadamente en el **91%**. La misma topologia
de bajo coste ya esta recreada con Kubernetes `1.34.10-do.1`: `ams3`, HA
desactivada, un nodo `s-4vcpu-8gb`, LB regional y dos volumenes de 10 GiB. El
target tiene sus 12 Deployments exactos, los servicios auxiliares disponibles y
los cinco escritores detenidos a proposito para restaurar.

La recreacion ya esta autorizada con `1.34.10-do.1`: la misma rama 1.34 y dos
parches posteriores a la version retirada. Todo lo demas coincide. Antes de
crear se ha confirmado que DigitalOcean sigue sin cluster, Droplets,
balanceadores ni volumenes residuales.

El preflight real de restauracion ya pasa completo: reconoce los UID nuevos,
el bundle y su recibo, las imagenes exactas, los PVC y los cinco writers a cero.
La primera entrada al restore se detuvo antes de modificar DB o medios porque
cert-manager mantiene cuatro Pods ACME temporales. La causa no es el bundle:
los cuatro registros DNS de IONOS aun apuntan al LB borrado. El sistema hizo lo
correcto: libero lock y Lease y conservo los cinco writers a cero.

Solo falta iniciar sesion en IONOS, apuntar `meta-hubs.org`, `stream`, `assets`
y `cors` al nuevo LB `165.245.201.85`, esperar que desaparezcan los Pods ACME,
restaurar DB+medios y hacer la aceptacion funcional de navegador. No se repite
un fallo a ciegas ni se relaja el monitor para aceptar Pods extra.

## 13 de agosto: infraestructura lista, restore detenido de forma segura

Los cuatro DNS de IONOS ya apuntan al balanceador nuevo y los cuatro
certificados estan **Ready**. No queda ningun Pod temporal de cert-manager. El
cluster recreado mantiene exactamente la topologia autorizada y los siete
servicios auxiliares estan `1/1`.

El restore avanzo mas alla del problema DNS y del baseline. Se corrigieron dos
diferencias reales de Kubernetes sin rebajar seguridad: el pull secret puede
venir de la plantilla exacta del ReplicaSet, y `GET`/`LIST` pueden ordenar las
claves JSON de forma distinta aunque el contenido sea identico. El foco pasa
**51/51** y el diagnostico live `GET -> LIST` pasa.

La restauracion de datos aun no esta terminada. Un intento creo la DB target
vacia pero el stream SQL no llego a empezar; el lock se retiro despues mediante
el limpiador exacto, sin reanudar servicios. El intento siguiente se detuvo
antes del reset con el codigo cerrado
`database_restore_stage:quiescence`: uno de los guards no pudo demostrar
quietud continua.

El estado actual es seguro pero no operativo para clientes: cinco writers a
cero, cero Pods writer, cero helper, DB target vacia, Lease existente pero
libre/sin holder y lock `cold-rebind` retenido. No se ha restaurado aun el medio
ni se ha hecho la prueba de navegador. El avance global se mantiene en **91%**;
no sube por haber hecho intentos.

La comprobacion posterior de solo lectura ha descartado una deriva permanente:
los cinco contratos siguen exactos a cero, no hay runners, el LIST/WATCH de Pods
funciona y PostgreSQL esta Ready. Lo que fallo fue una capacidad temporal del
proceso, pero el diagnostico anterior era demasiado amplio para saber cual.
Ahora cada subetapa tiene un codigo cerrado y no sensible; su prueba dirigida
pasa **51/51**.

El Goal se ha actualizado y el plan tecnico queda en **v31**. La revision
independiente ha encontrado tres incompatibilidades concretas antes de volver a
produccion: el verificador live todavia espera el runner durable aunque este
target es legacy/process-local; el full no llama aun todas las pruebas nuevas de
H5; y Git no puede validar un submodulo Cloud sin fijar primero su commit. No es
un rediseño de recovery: son tres cierres de integracion con propietarios y
criterios de salida separados.

Esas tres correcciones ya estan cerradas localmente. Cloud pasa **120/120**; el
contrato live por perfil pasa **57/57**; y el cold-rebind coordinado afectado
pasa **49/49**. El selector final agrupa H5 sin repetir los 45 prechecks. No se
ha fabricado una simulacion de Internet: DNS, TLS, HTTP y el contenido real se
probaran una vez en la aceptacion live, despues del restore.

Cloud y root ya quedaron fijados en commits limpios. El primer full no consumio
horas ni llego a las suites: paro a los **40 segundos** porque ShellCheck no
reconocia que una funcion se invoca mediante un trap `EXIT`. Se ha añadido solo
la anotacion exacta para ese uso indirecto y el ShellCheck del fichero ya pasa.
La politica anti-loop impide relanzar el full en esta misma parada; el siguiente
paso es una unica ejecucion nueva sobre el commit corregido.

Esa ejecucion nueva tambien paro pronto, a los **52 segundos**, por otra
anotacion ShellCheck mal colocada: el comentario que justificaba una cadena SQL
con expansion dentro del contenedor no estaba pegado al comando. Se ha movido
solo ese comentario, el ShellCheck exacto pasa y ninguna suite larga ni recurso
productivo llego a ejecutarse. El siguiente turno conserva el mismo paso: un
unico full nuevo sobre el commit corregido.

La siguiente ejecucion alcanzo **160 segundos** y volvio a parar antes de las
suites: el analizador encontro ocho avisos informativos en fixtures recovery que
usan deliberadamente subshells, `PATH`, PID y cadenas literales. Cada supresion
queda pegada al comando concreto y explica por que es intencional. El ShellCheck
completo de ese arnes ya pasa. No se repitio el full ni se toco produccion.

El siguiente full ya supero todo ese bloque estatico y avanzo de verdad por las
suites: quedaron verdes `32/32` pruebas de recovery y `57/57` del monitor. Se
detuvo a los **320 segundos** en una prueba nueva del perfil legacy, porque su
expresion regular tenia barras duplicadas y rechazaba incluso la sala valida
`VJopCY3`. Se ha corregido solo esa linea y el gate de seguridad afectado pasa
de nuevo **57/57**. No se repite el full en esta misma parada y produccion sigue
sin tocarse.

El orden es ahora inequívoco: corregir esas tres fronteras, fijar primero el
commit Cloud y despues el commit root, comprobar que ambos arboles quedan
limpios y ejecutar exactamente una vez `./scripts/verify-project.sh --full`.
No se ejecuta tambien el gate normal.

Solo si ese candidato queda verde se limpia el lock por el procedimiento ya
probado y se hace **un unico restore**. Si vuelve a detenerse, mostrara el guard
exacto y se para ahi; no se encadena otro intento. Despues de un restore verde
siguen siendo obligatorios el verificador live y el navegador frio. Esto evita
convertir la reactivacion en otro loop y hace reproducible la version que se
prueba en produccion.

Esa autorizacion ya esta recibida, y ademas cubre todo el recorrido H5 que ya
estaba definido. Desde ahora no se pedira permiso entre cada paso normal:
checkpoint, dos copias cifradas, retirada de los recursos DO inventariados,
recreacion equivalente, restore y prueba real. Solo se parara si aparece algo
distinto a lo acordado o no puede demostrarse un estado seguro.

El diseno tecnico corto esta en `docs/client-hibernation-design-v1.md`. Define
nueve artefactos exactos, separa los UID antiguos de los UID nuevos y limita H2
a una lista pequena de scripts. No importa por defecto ninguno de los cuatro
commits funcionales del recovery avanzado.

## Comprobacion anti-loop

No se esta repitiendo la matriz antigua:

- no se han ejecutado sus 28 casos pendientes ni GitHub;
- la rama antigua sigue preservada, pero el nuevo candidato parte de `main`;
- H2 ejecuto una sola vez cada foco relevante sobre sus bytes finales y H3 solo
  repitio los focos afectados por cambios causales;
- el candidato H3 pasa `5/5` SQL, `50/50` preflight cold, `49/49` ejecucion
  cold, `57/57` target mode, `47/47` restore legacy, `100/100` writer fence,
  `51/51` runner identity, `46/46` durable monitor y `14/14` K3s real;
- H3a, H3b y H3c no fueron repeticiones: cada uno encontro una causa diferente
  y genero bytes nuevos. H3d fue el unico candidato aceptado;
- sintaxis, ShellCheck y diff-check pasan sobre los componentes afectados;
- cada full se detuvo en una causa nueva antes de repetir un bloque largo ya
  aceptado; el ultimo supero por primera vez todo ShellCheck y avanzo hasta las
  suites recovery/monitor, y la correccion posterior se valido solo con el
  gate de seguridad afectado;
- las dos correcciones posteriores fueron dependencias de seguridad con causa
  nueva y solo repitieron los componentes afectados;
- GitHub se uso para publicar los dos PR sin CI automatico y para runs causales:
  primero se aislo el agotamiento de memoria de ShellCheck y despues el run
  completo demostro que los unicos cinco rojos eran expectativas congeladas,
  no fallos de H2/H3; no se han convertido en parches de producto;
- el mismo ShellCheck termino verde localmente y no se importo el coordinador
  HMAC/keyring;
- cada evidencia queda ligada a una casilla concreta;
- si el mismo fallo reaparece dos veces sin causa nueva, el plan obliga a parar.

El trabajo anterior no se declara inutil: se conservan sus ideas y evidencia.
Lo que se evita es terminar o desplegar su coordinador complejo solo por el
tiempo ya invertido.

## Como sabremos que esta terminado

Recovery queda cerrado cuando una instancia pueda:

1. producir una copia completa y validada en dos ubicaciones;
2. registrar exactamente que recursos y dependencias necesita;
3. eliminar los recursos DigitalOcean aprobados y mostrar el coste residual;
4. recrearse con Namespace y PVC nuevos;
5. recuperar DB, escenas, avatares, proyectos Spoke y medios;
6. superar login, sala, audio, camaras, avatar, Admin, Spoke y bots incluidos;
7. dejar un tiempo real medido y un runbook repetible.

En ese punto no seguiremos perfeccionando recovery por inercia. Se cierra esta
meta y se elige una sola capacidad nueva del metaverso.

## Seguridad, produccion y coste

- Produccion no se toca durante las fases locales.
- No se ejecutan las matrices pendientes del recovery congelado.
- No se fusiona el PR `#15` rojo.
- No se crea infraestructura DigitalOcean nueva para el ensayo inicial.
- La autorizacion continua cubre solo los recursos exactos y la misma topologia
  ya inventariados; cualquier diferencia de recurso, cuenta o coste produce STOP.
- GitHub se reserva para una confirmacion final sobre un candidato ya verde.

La lista tecnica completa y el prompt de continuacion estan en
`docs/active-goal-plan-2026-07-18.md`.
