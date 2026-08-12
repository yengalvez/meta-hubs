# Paquete de ventana H5: hibernacion comercial

Estado: **H5-A en preparacion, sin autorizacion para H5-B**  
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
- los dos PV usan politica `Delete`: no se puede borrar el cluster antes de
  validar el bundle y sus dos copias externas.

La factura provisional generada a las `2026-08-12T04:49:05Z` llevaba USD
`26.21` de uso total del mes. De los recursos Hubs visibles: nodo USD `18.86`,
Load Balancer USD `5.89` y volumenes USD `0.78`. Son importes acumulados hasta
esa hora, no una tarifa mensual ni una promesa del ahorro final.

## H5-A: trabajo permitido ahora

- [x] CI e integracion H4 cerrados; GitHub deja de ser bloqueo.
- [x] Inventario read-only de runtime, DNS y recursos facturables.
- [x] Confirmar que todos los workloads usan digests y que no hay recovery lock.
- [x] Identificar el riesgo `Delete` de los dos PV.
- [x] Comprobar la frontera read-only del productor: sin
  `ALLOW_CHECKPOINT_DOWNTIME=1` devuelve el rechazo exacto antes de crear un
  artefacto o detener writers.
- [ ] Preparar dos destinos realmente independientes para copias cifradas.
- [ ] Fijar referencias opacas y recuperables para la clave de cifrado y el
  escrow de credenciales; ninguna clave o secreto entra en este documento.
- [ ] Comprobar, con un artefacto de prueba no sensible, lectura, descifrado y
  rehash desde ambos destinos.
- [ ] Confirmar custodia durante toda la hibernacion de las 13 imagenes por
  digest o, si GHCR no ofrece esa garantia, preparar archivo OCI cifrado con
  cost gate separado.
- [ ] Preparar la hoja final de efectos con la seleccion explicita de recursos
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

El paquete final presentara, por separado:

- DOKS y su nodo;
- Load Balancer;
- volumen PostgreSQL de `10 GiB`;
- volumen `ret-pvc` de `10 GiB`;
- cualquier recurso nuevo descubierto antes de la ventana.

No se asumira que borrar DOKS elimina los otros elementos. Cada recurso se
reconciliara por lectura despues de la operacion. Firewalls y DNS externos no se
retiran salvo que aparezcan expresamente en la autorizacion.

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

Completar el preflight local de checkpoint/cifrado y demostrar dos destinos
recuperables con datos de prueba. No requiere downtime ni autorizacion de
DigitalOcean.
