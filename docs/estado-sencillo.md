# Estado sencillo de YenHubs

Ultima actualizacion: **12 de agosto de 2026**

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
[SIGUIENTE, CON AUTORIZACION] H5: hibernacion real y reconstruccion
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

- **H5-A, ahora:** preparacion local y de solo lectura. Inventario de costes y
  recursos, preflights, checkpoint/segunda copia, digests, escrow, orden de la
  ventana y rollback. No apaga nada, no crea recursos y no depende de GitHub.
- **H5-B, despues:** la ventana real que borra y recrea recursos DigitalOcean.
  Solo esta segunda parte requiere una autorizacion concreta sobre una lista
  exacta de efectos y costes.

H5-A ya es la fase activa en `codex/h5-preflight`. Produccion sigue intacta.

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

Quedan exactamente dos decisiones humanas para cerrar H5-A: elegir una segunda
ubicacion que sea realmente independiente del Mac y de Dropbox, y decidir donde
se custodian las referencias opacas de las claves/credenciales. No falta otra
prueba larga ni otro gate GitHub. Despues vendra H5-B: una sola ventana real,
con autorizacion sobre cluster/nodo, Load Balancer y los dos volumenes. Hasta
entonces produccion sigue intacta.

Tras cerrar H5 con una unica ventana comercial, H6 cierra recovery y devuelve
el proyecto a features.

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
- el full se ejecuto una sola vez; al detenerse por configuracion local se
  completo exclusivamente su tramo aun pendiente y no se repitio el bloque
  comun de cuatro horas;
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
- Antes de borrar o recrear recursos reales se pedira una confirmacion concreta.
- GitHub se reserva para una confirmacion final sobre un candidato ya verde.

La lista tecnica completa y el prompt de continuacion estan en
`docs/active-goal-plan-2026-07-18.md`.
