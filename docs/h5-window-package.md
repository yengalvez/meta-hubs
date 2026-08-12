# Paquete de ventana H5: hibernacion comercial

Estado: **H5-A cerrada 10/10; paquete listo, sin autorizacion para H5-B**
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

## H5-B: ventana real, aun no autorizada

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

Presentar la autorizacion exacta de H5-B. Hasta recibirla, no se detiene el
metaverso, no se crea el checkpoint con downtime y no se retira ni crea ningun
recurso DigitalOcean.

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
