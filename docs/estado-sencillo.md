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

La unica fase activa sigue siendo **H4**, pero su parte local ya esta terminada.
El gate comun paso recovery `865/865`, seguridad, PostgreSQL real y los demas
bloques. La configuracion local de los remotos detuvo el comando despues de ese
tramo; se corrigio el entorno y se continuo solo con el tramo pendiente, sin
repetir cuatro horas verdes. Pasaron Hubs y Admin, navegador, capacidad
`115/115`, Hubs CE, bots `154/154`, Dialog, Photomnemonic, Coturn, Spoke y
Reticulum con `461` tests y `5` propiedades.

El gate encontro dos avisos de seguridad publicados recientemente. Se
actualizaron solo los pins transitivos afectados: `ip-address` a `10.3.1` y
`postgrex` a `0.22.4`; sus auditores y suites quedaron verdes. No se hizo un
`audit fix`, no se modernizo el stack y no se cambio funcionalidad.

El coste GitHub ya esta comprobado: la cuenta sigue en GitHub Free, Actions
muestra USD 0 facturados y el uso bruto de USD 12.91 esta compensado por el
descuento incluido. Los PR draft `hubs-cloud #23` y raiz `#16` se publicaron con
`[skip ci]`, por lo que no duplicaron jobs.

La primera confirmacion manual, run `31518137826`, dejo PostgreSQL 12 y 14
verdes, pero fue cancelada externamente sin diagnostico. Una ejecucion nueva
observada solo con lecturas, `31520065425`, encontro la causa real: el runner
perdio comunicacion mientras ShellCheck consumia mas memoria de la disponible.
`-x` seguia muchas veces la misma libreria desde el arnes de recovery de 17.000
lineas; la medicion local llego a unos 16,2 GB RSS.

Esto no es un fallo del metaverso ni abre otro proyecto. La correccion queda
limitada al CI: el arnes se analiza sin reabrir fuentes externas y la libreria
se sigue analizando completa, por separado, con `-x`. Solo se silencian en ese
arnes cinco diagnosticos falsos que dependen de seguir el source. Falta validar
una vez ese gate corregido y, si queda verde, fusionar.

Tambien se corrigio una contradiccion de tiempo: el workflow permitia solo 75
minutos aunque su suite secuencial completa tarda alrededor de cuatro horas. Se
mantienen todas las pruebas y se restaura un limite de 360 minutos; no se
acorta ni se fragmenta la suite para fabricar un verde.

El siguiente candidato, `d0fc186`, confirmo que esa correccion de memoria
funciona: PostgreSQL 12 y 14, Gitleaks, Actionlint y ShellCheck quedaron verdes,
y la regresion completa termino con `860/865`. Los cinco rojos eran exactamente
los cinco casos Linux antiguos que el plan ya habia congelado; ninguno pertenece
al bundle nuevo, al cold-rebind ni al ensayo H3.

La causa era una contradiccion en las expectativas: aun exigian reanudar y
borrar el lock automaticamente, aunque el objetivo nuevo ordena parar de forma
segura cuando el resultado no se puede demostrar. No se ha tocado el producto.
Se ha corregido solo el oraculo para aceptar dos finales seguros y exactos:
rollback demostrado, o writers confirmados a cero con el lock retenido. Cualquier
estado intermedio sigue fallando. Los focos afectados pasan `47/47`, `54/54` y
`89/89`, y ShellCheck/sintaxis estan verdes. La confirmacion remota final,
run `31546745988` sobre `09af04f`, termino completamente verde: las `865`
regresiones, seguridad y PostgreSQL 12/14. Hubs Cloud `#23` y el repositorio
raiz `#16` quedaron fusionados, en ese orden. **H4 esta cerrado.**

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

Cuando esa confirmacion termine verde, solo quedan la fusion ordenada de Hubs
Cloud y del root, y H5 —la unica prueba que toca una instancia comercial y
necesita autorizacion concreta—. H6 cierra recovery y devuelve el proyecto a
features.

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
