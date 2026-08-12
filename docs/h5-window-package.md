# Paquete de ventana H5: hibernacion comercial

Estado: **H5-A avanzada; faltan destino externo independiente y escrow, sin autorizacion para H5-B**
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
- [ ] Preparar dos destinos realmente independientes para copias cifradas. En
  este Mac solo se ha encontrado Dropbox como destino externo; una carpeta
  local y Dropbox prueban el mecanismo, pero no cuentan como dos custodios
  independientes.
- [ ] Fijar referencias opacas y recuperables para la clave de cifrado y el
  escrow de credenciales; ninguna clave o secreto entra en este documento.
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
3. Dos copias cifradas independientes reabiertas, descifradas y rehasheadas.
4. Recibo externo privado `0600` y referencias de escrow recuperables.
5. Los 13 digests disponibles o archivados de forma recuperable.
6. Inventario DNS/SMTP/OpenAI/GHCR y receta de infraestructura completos.
7. Lista exacta de recursos autorizados por el propietario.

Si falta cualquiera, el resultado es **STOP**: no se borra nada.

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

Elegir un segundo destino realmente independiente de Dropbox y el Mac, y fijar
las referencias opacas del escrow de cifrado, DNS, GHCR, SMTP y OpenAI. Todo lo
demas de H5-A ya puede cerrarse localmente; no requiere GitHub ni tocar
DigitalOcean.
