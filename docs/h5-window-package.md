# Paquete de ventana H5: hibernacion comercial

Estado: **H5-B5 cerrada en STOP seguro; produccion `12/12`, sin residuos y sin
bundle; preflight server-side real verde, H5-B6 activo bajo autorizacion continua**
Ultima lectura: **12 de agosto de 2026 (Europe/Madrid)**

## Decision sencilla

Ahora podemos preparar y comprobar casi todo localmente. No hace falta esperar
a GitHub. La unica frontera que requiere autorizacion es ejecutar una ventana
que detenga el metaverso y retire o cree recursos DigitalOcean.

## Estado verificado de partida

- metaverso: `12/12` Deployments disponibles, `12` replicas deseadas;
- imagenes: `13/13` contenedores fijados por digest;
- almacenamiento: `2` PVC, `20 GiB`, ambos `Bound`;
- red: `13` Services, exactamente `1` de tipo `LoadBalancer`;
- recovery: ningun lock activo;
- DNS publico: los dos hosts operativos comprobados tienen respuesta A;
- DigitalOcean: `1` DOKS, `1` nodo `s-4vcpu-8gb`, `1` Load Balancer y
  `2` volumenes de `10 GiB`; no hay snapshots, Managed Databases, Reserved IPs,
  zonas DNS de DigitalOcean ni registry DigitalOcean;
- `pgsql-pvc` y `ret-pvc` coinciden uno a uno con esos dos volumenes
  DigitalOcean; ambos PV usan politica `Delete`;
- DNS: `meta-hubs.org` y `assets.meta-hubs.org` apuntan al Load Balancer actual;
  la zona esta delegada fuera de DigitalOcean mediante IONOS;
- por la politica `Delete`, no se puede borrar el cluster antes de validar el
  bundle y sus dos copias externas.

La factura provisional generada a las `2026-08-12T04:49:05Z` llevaba USD
`26.21` de uso total del mes. De los recursos Hubs visibles: nodo USD `18.86`,
Load Balancer USD `5.89` y volumenes USD `0.78`. Son importes acumulados hasta
esa hora, no una tarifa mensual ni una promesa del ahorro final.

GitHub no es un riesgo de cobro para esta preparacion: el panel del `12 de
agosto` muestra Packages con USD `0.19` brutos y USD `0` facturados, y existe
un presupuesto Packages de USD `0` con `Stop usage: Yes`. GitHub documenta
ademas que el almacenamiento y ancho de banda de Container registry son
actualmente gratuitos. Si deja de entrar en lo gratuito, el presupuesto debe
bloquear el uso en vez de facturarlo.

## H5-A: trabajo permitido ahora

- [x] CI e integracion H4 cerrados; GitHub deja de ser bloqueo.
- [x] Inventario read-only de runtime, DNS y recursos facturables.
- [x] Confirmar que todos los workloads usan digests y que no hay recovery lock.
- [x] Identificar el riesgo `Delete` de los dos PV.
- [x] Comprobar la frontera read-only del productor: sin
  `ALLOW_CHECKPOINT_DOWNTIME=1` devuelve el rechazo exacto antes de crear un
  artefacto o detener writers.
- [x] Preparar dos ubicaciones separadas para copias cifradas: una copia local
  fuera de cualquier carpeta sincronizada y otra copia externa en Dropbox.
  Esto basta para el primer ciclo comercial. Un disco externo o segundo cloud
  seria una tercera copia opcional, no un bloqueador de H5.
- [x] Confirmar que Google Password Manager es accesible desde la cuenta Google
  y no depende solo del almacenamiento local del Mac. Se usara para los accesos
  de GitHub, IONOS, Mailtrap y OpenAI, mas una entrada dedicada para la clave
  del bundle. No se abrio ni mostro ninguna contraseña.
- [x] Comprobar con un artefacto no sensible el cifrado AES-256-CBC/PBKDF2, la
  lectura por streaming, el descifrado y el rehash desde la copia local y la
  copia Dropbox. Ambos hashes coincidieron; esto prueba la receta, no la
  independencia fisica pendiente.
- [x] Confirmar custodia de las imagenes: las `12` imagenes unicas que sirven a
  los `13` contenedores fueron copiadas por digest a un layout OCI local de
  `1,378,619,392` bytes. Los `12` digests vivos estan presentes, las `12`
  referencias se leen offline y `214` blobs pasaron SHA-256 con cero fallos.
  El archivo queda local y privado; su copia cifrada externa se hara junto al
  bundle real en H5-B.
- [x] Preparar la hoja final de efectos con la seleccion explicita de recursos
  a retirar y el coste residual esperado.

## H5-B: ventana real autorizada

Autorizacion y custodia manual confirmadas: **12 de agosto de 2026**. La clave H5
se guardo en Google Password Manager. Tras cerrar los preflights locales, el
primer intento que entro en downtime escalo los cinco writers a cero, pero el
monitor fallo antes de `ready`; por tanto no se copiaron DB ni medios. Se
reanudaron los cinco writers, se verifico produccion `12/12` y se elimino el
lock exacto. DigitalOcean y los datos no se borraron ni recrearon.

La causa esta confirmada: el API live omite GVK en los items de LIST aunque el
LIST superior sea tipado. El monitor ahora acepta solo ausencia/null bajo ese
LIST exacto y conserva WATCH/GET estrictos; los GVK falsos siguen fallando.
Pruebas dirigidas `46/46` y `48/48`, validacion estatica y revision independiente
GO. El perfil greenfield `cold-rebind-legacy-absent-v1` tambien esta probado
`32/32`.

La unica repeticion causal se ejecuto con los ocho metadatos `FREEZE_*`
completos. La captura redactada termino, pero el monitor volvio a fallar antes
de `ready` con el stage allowlisted `baseline`. No se copiaron DB ni medios y no
se publico ningun bundle. El rollback restauro los cinco writers; la
reconciliacion final confirma produccion `12/12`, lock ausente y Lease libre.
La regla anti-loop activo una autopsia antes de cualquier otro efecto. Esta
demostro que Kubernetes materializa `enableServiceLinks=true` e
`imagePullSecrets` desde el ServiceAccount en los siete Pods no writers. Los
`7/7` valores de credenciales de pull coinciden exactamente con su
ServiceAccount. El comparador normaliza solo el default booleano, valida la
proyeccion contra el ServiceAccount y la exige en LIST y WATCH. Microfoco
`49/49` y revision adversarial GO. Se conservo el watcher continuo y se ejecuto
el unico candidato final permitido. Volvio a fallar en `baseline`; rollback
exacto, produccion `12/12`, lock ausente, Lease libre, cero bundles y DO intacto.
La ruta automatica queda cerrada sin otra autopsia o retry.

### GO antes de cualquier borrado

1. Produccion estable y sin operacion concurrente.
2. Checkpoint fresco conjunto DB + `ret-pvc`, nueve artefactos exactos y
   `SHA256SUMS` verde.
3. Copia local cifrada fuera de Dropbox y copia cifrada externa en Dropbox,
   ambas reabiertas, descifradas y rehasheadas.
4. Recibo externo privado `0600` y referencias de escrow recuperables. La
   revision de seguridad de Google Password Manager no debe marcar como
   comprometida ninguna entrada H5; si marca una, se rota antes de continuar.
5. Los 13 digests disponibles o archivados de forma recuperable.
6. Inventario DNS/SMTP/OpenAI/GHCR y receta de infraestructura completos.
7. Lista exacta de recursos autorizados por el propietario.
8. Copia Dropbox con estado remoto `isUploaded=1`, identificador/revision y
   lectura completa posterior; hash y tamano del ciphertext ligados al
   expediente privado.
9. Cuenta y UUID exactos del cluster, Load Balancer y dos volumenes, mas techo
   mensual de la recreacion.

Si falta cualquiera, el resultado es **STOP**: no se borra nada.

Las referencias opacas aprobadas son:

- `GPM:github.com/YenHubs`;
- `GPM:ionos.com/YenHubs-DNS`;
- `GPM:mailtrap.io/YenHubs-SMTP`;
- `GPM:platform.openai.com/YenHubs`;
- `GPM:meta-hubs.org/YenHubs-H5-bundle-key`.

La presencia recuperable de cada entrada se confirma de forma redactada al
inicio de H5-B. La clave nueva del bundle se genera y guarda entonces; nunca se
escribe en Git, en este documento ni en el log.

### Efectos propuestos para autorizacion

La autorizacion H5-B presentara y reconciliara por separado:

- **retirar:** el cluster DOKS y su nodo `s-4vcpu-8gb`;
- **retirar:** el unico Load Balancer, despues de confirmar que el bundle y sus
  copias ya no dependen de el;
- **retirar:** el volumen de `pgsql-pvc` de `10 GiB`;
- **retirar:** el volumen de `ret-pvc` de `10 GiB`;
- **conservar:** la zona y registros DNS externos en IONOS para poder
  reorientarlos al Load Balancer nuevo durante la reactivacion;
- **conservar:** el firewall ajeno `voice-chat`;
- **reconciliar, no borrar manualmente por defecto:** los dos firewalls
  gestionados por DOKS; se comprobara su estado despues de retirar el cluster;
- **releer antes de actuar:** cualquier recurso nuevo descubierto en la
  ventana invalida la lista y produce STOP hasta nueva autorizacion.

No se asumira que borrar DOKS elimina los otros elementos. Cada recurso se
reconciliara por lectura despues de la operacion. El coste residual esperado de
la instancia Hubs en DigitalOcean es USD `0` una vez retirados cluster/nodo,
Load Balancer y ambos volumenes; la factura seguira mostrando el consumo ya
acumulado antes del apagado. DNS externo y recursos ajenos no cambian.

### Reactivacion

1. `preflight-greenfield` offline sobre bundle y recibo.
2. Aprobacion de coste y creacion de infraestructura nueva.
3. Bootstrap con los cinco consumidores a cero.
4. `preflight-reactivation` en modo `cold-rebind` con UID nuevos.
5. Restore conjunto DB + storage, nunca piezas de fechas distintas.
6. Verificador live y navegador frio: login, sala, audio, camaras, avatar,
   Admin, Spoke y las capacidades incluidas en el baseline comercial.
7. Registrar tiempo observado, recursos, coste residual y resultado.

## Regla anti-loop

- H5-A usa lecturas, preflights y artefactos de prueba pequeños; no repite el
  full ni el CI H4.
- GitHub solo vuelve a intervenir si falta construir una imagen concreta por
  digest para la reactivacion.
- Un fallo se repite solo después de identificar una causa y cambiar bytes o
  precondicion relevante.
- H5 termina al completar un ciclo comercial. No se reabre recovery avanzado,
  HA ni matrices hipoteticas.

## Proxima accion segura

La ruta elegida es la barrera temporal segura. El nuevo preflight server-side
de policy y binding pasa `49/49`, la matriz integrada pasa `77/77` y el API real
acepta ambas formas sin persistirlas. No volver a ejecutar el monitor anterior.

H5-B4 consumio su unica ventana y paro antes del downtime: el API server añadio
defaults a la policy, el comparador la rechazo, nunca se creo binding y los
writers siguieron `1/1`. El rollback por UID/RV retiro policy y lock y libero la
Lease. Produccion esta `12/12`, sin residuos ni bundle.

H5-B5 demostro que el API añade defaults tambien a la binding. El rollback
exacto retiro binding, policy y lock y libero Lease; no hubo downtime ni bundle.
Para evitar otro ciclo de defaults, H5-B6 valida primero ambas respuestas con
`--dry-run=server`. Focal `49/49`, matriz `77/77` y API real verdes, sin crear
objetos persistentes. La autorizacion continua ya cubre ese unico candidato.
No se borra DigitalOcean. Ningun artefacto incompleto se cifra o se presenta
como backup hasta que los nueve artefactos, hashes, recibo y copias externas
superen todos los criterios GO.

La autorizacion continua ya recibida cubre la nueva ventana dentro del alcance
exacto del paquete. No se necesita otro mensaje rutinario antes de H5-B6.

Estado operativo posterior: H5-B6 aislo y corrigio la forma omitida de
`subResource`; H5-B7 llego al arranque del monitor PostgreSQL y H5-B8 fallo ya
dentro del stream. Los tres terminaron `12/12`, sin barrera, lock, Lease,
bundle ni cambios DigitalOcean. H5-B9 cambia de metodo: en freeze la barrera
impide CREATE/UPDATE de Pods, se valida PostgreSQL a ambos lados de `pg_dump` y
no se arranca el monitor continuo redundante. Legacy/durable lo conservan.
Focos finales: barrera `77/77`, hijos checkpoint `161/161` y checks estaticos
verdes. Una firma nueva produce STOP; no se encadena otro candidato.

H5-B9 termino el stream DB, pero el verificador agregado rechazo el contrato
SQL y no publico bundle. El rollback dejo `12/12`, writers `1/1`, barrera,
lock y Lease ausentes; DigitalOcean no cambio. La autopsia read-only posterior
en PostgreSQL 12.19 confirma schemas, 356 relaciones, COPY, marcador y hashes
criticos coincidentes, pero no puede reconstruir cual predicado fallo sobre el
dump ya retirado. El paquete queda en STOP operativo: primero diagnostico
enumerado sin downtime; no otro checkpoint ni borrado DO.

H5-B10 aislo el falso negativo: PostgreSQL 12.19 añade el comentario vacio
canonico `--` despues del marcador final. El parser ahora acepta solo esa forma
exacta y mantiene los negativos de duplicado, token y SQL posterior. Foco
`7/7`, dump real read-only PASS y checks estaticos verdes. H5-B11 queda
habilitado como unico candidato; DigitalOcean continua fuera de alcance hasta
bundle valido y dos copias cifradas verificadas.

H5-B11 valido la DB real completa, pero storage paro al validar el
NetworkPolicy: el API omite simultaneamente `ingress: []` y `egress: []`. El
efecto sigue siendo deny-all porque `policyTypes` conserva Ingress/Egress. El
comparador acepta solo ambas listas vacias o ambas omitidas y rechaza toda otra
forma; dry-run live y foco `88/88` verdes. Rollback `12/12`, cero bundle y DO
intacto. H5-B12 se reanuda desde preflight limpio tras el corte anti-loop.

H5-B12 volvio a validar la DB y creo el helper storage exacto, pero paro porque
el monitor local no completo su primer barrido. El rollback dejo `12/12`, cinco
writers activos, lock/Lease ausentes y cero bundle. Dos policies huerfanas sin
Pods se retiraron por UID/RV exactos. Para H5-B13, solo freeze omite ese monitor
redundante: la barrera de admision permanece activa y el helper, policy, PVC y
consumidores se validan inmediatamente antes y despues del stream. Legacy y
durable conservan el monitor. Evidencia: `77/77`, `161/161`, ShellCheck y
diff-check verdes.

H5-B13 valido la DB y paro con `storage-backup:stream`. El rollback dejo
`12/12`, writers `5/5`, sin barrera/lock/Lease/bundle; la policy residual sin
Pods se retiro por UID/RV. Una lectura read-only independiente del mismo PVC
con el mismo `tar|gzip` termino `0/0`, descartando bytes ilegibles. H5-B14 queda
limitado a un enum cerrado del hijo para separar fallo del supervisor y fallo
del limite post-stream; no autoriza retries sin nueva evidencia.

H5-B14 emitio `helper-cleanup`: la DB, el tar, su inventario y el postcheck ya
habian pasado; el unico fallo era el DELETE Foreground del Pod helper sin
dependientes. H5-B15 usa Background graceful, UID exacto, espera NotFound y
grace=1, nunca force. Un smoke live sin downtime elimino el Pod en 4 s, dejo
cero residuos y writers `5/5`; helper `17/17`, H5-B3 `77/77` y checks verdes.

H5-B15 paro antes del downtime: el probe shell omitio el grace=1 que la policy,
el Pod y el constructor Node ya exigian. La barrera lo rechazo correctamente;
produccion quedo `12/12`, writers `5/5` y cero residuos. Ambos constructores ya
coinciden, existe una regresion directa y la matriz final pasa `78/78`. H5-B16
es el unico candidato funcional siguiente.

H5-B16 termino correctamente el 13 de agosto de 2026. Publico y valido el
bundle `output/checkpoints/h5-b16-20260813-022800`: 9 ficheros exactos, DB con
356 relaciones/94 migraciones/18 hubs/33 activos y storage con 33 pares
completos. El cierre live fue `12/12`, writers `5/5` y cero barrera, lock,
Lease, helper o policy. La unica fase activa antes de cualquier borrado de
DigitalOcean es H5-B17: dos copias cifradas reabiertas y verificadas.

Texto historico de la autorizacion H5-B5:

```text
Autorizo una unica ventana productiva H5-B5 para crear y retirar temporalmente
la policy y el binding de admision freeze-checkpoint-pod-create-fence.yenhubs.org,
probar la barrera server-side, pausar los cinco writers, crear y validar el
bundle conjunto DB + ret-pvc, retirar la barrera por identidad exacta y
reanudar. Esta autorizacion no permite borrar todavia ningun recurso de
DigitalOcean; cualquier ambiguedad conserva el estado fail-closed y produce STOP.
```

Texto exacto que puede aprobar el propietario:

```text
Autorizo ejecutar H5-B sobre la instancia actual de meta-hubs.org. La
autorizacion permite crear un checkpoint conjunto DB + ret-pvc con downtime,
validarlo, guardar una copia cifrada local fuera de Dropbox y otra cifrada en
Dropbox, y despues retirar exclusivamente el cluster DOKS con su nodo, el Load
Balancer y los dos volumenes de 10 GiB asociados a pgsql-pvc y ret-pvc. Se
conservan DNS/IONOS, el firewall voice-chat y todo recurso ajeno. Cualquier
recurso nuevo, copia no verificable, credencial no recuperable o coste distinto
produce STOP y requiere una nueva autorizacion. Tras verificar la hibernacion,
autorizo recrear la misma topologia de bajo coste, restaurar el bundle y validar
el metaverso en navegador real.
```
