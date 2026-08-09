# Diseno minimo de hibernacion de clientes v1

Estado: **H3 DEMOSTRADO EN K3S LOCAL; H4 PENDIENTE**
Fecha: **9 de agosto de 2026**

Este documento convierte el objetivo comercial en un contrato tecnico finito.
No sustituye el runbook ejecutable de `deployment/README.md`. H2 implemento el
contrato y H3 lo demostro en Namespace/PVC realmente aislados. H4 debe validar
e integrar el candidato antes de cualquier uso comercial.

## 1. Problema que resolvemos

Una instancia de cliente inactiva debe poder apagarse durante semanas o meses,
retirar los recursos de DigitalOcean que siguen facturando y volver a levantarse
sin reconstruir manualmente salas, proyectos, avatares o medios.

El resultado v1 es una operacion planificada con tiempo de inactividad. No es
alta disponibilidad, failover automatico, recuperacion ante cualquier carrera
de Kubernetes ni certificacion de escala.

## 2. Baseline de producto que se preserva

El candidato parte exactamente de `origin/main`:

- root `9c1b85be99a797c219022b0dd506b0be5ebd026b`;
- Hubs `ce8390a8905fa38fa0acdb10d5f94290981477ec`;
- Hubs Cloud `c0a3419b19b1b3e4eb4369b54daa41d22796b98c`;
- releases aceptadas Hubs `prod-2026-03-11` y Hubs CE `2.1.0`;
- runtime productivo conservado: `process-local`.

La oferta general de este baseline, condicionada a la aceptacion fria H1, es:

- espacios 3D privados en navegador desktop y movil;
- invitado y magic link, interfaz espanola y audio multiusuario;
- camaras primera/tercera persona en desktop;
- avatares existentes y GLB privado gestionado por un operador confiable;
- Admin y Spoke como servicio gestionado;
- sitting legacy solo como pose visual, sin promesa de exclusividad concurrente.

No se promete en v1: bots/IA publicos sobre `process-local`, sitting v2,
Avaturn/MetaPerson embebido, uploads GLB de usuarios no confiables, VR, HA,
CCU/RTO no medidos ni memoria/ZDR/SLA de IA.

### Evidencia funcional H1

El 9 de agosto se refresco sin mutaciones la parte publica de produccion:

- portada en espanol;
- pagina previa de la sala `VJopCY3`;
- entrada al vestibulo como espectador;
- formulario de inicio de sesion;
- redireccion de Admin al login;
- carga del editor Spoke y rechazo correcto del proyecto sin autenticar.

La sesion autorizada envio y entrego un magic link real. Quedaron comprobados el
login de `info@virtualmente.com`, Admin, el proyecto Spoke sin guardar ni
publicar, la sala con dos presencias, el avatar visible y el cambio visual
primera/tercera persona. El control de asiento respondio de forma segura al no
encontrar un waypoint cercano.

Ambos navegadores enumeraron y activaron sus microfonos. Cada participante pudo
silenciar y reactivar su pista, y el otro cliente reflejo los dos cambios en
tiempo real en ambas direcciones. Con esta evidencia H1 declara completa la
aceptacion funcional del baseline. No se toco DigitalOcean ni se mutaron datos
de la sala, Admin o Spoke.

## 3. Contrato exacto `freeze-bundle-v1`

El bundle publicado contiene exactamente nueve ficheros directos, regulares y
no vacios, sin enlaces ni extras:

1. `checkpoint-metadata.json`
2. `retdb-<stamp>.sql.gz`
3. `ret-storage-<stamp>.tar.gz`
4. `database-contract.json`
5. `deployment-images.json`
6. `git-state.json`
7. `external-config-redacted.json`
8. `infrastructure-recipe.json`
9. `SHA256SUMS`

`SHA256SUMS` cubre exactamente los otros ocho ficheros. Su propio SHA-256 se
guarda en un expediente protegido y separado de ambas copias del bundle. Ese
expediente liga `client_instance_id`, `freeze_id`, el hash, dos referencias
opacas a ubicaciones independientes, la referencia opaca de escrow de clave, la
referencia opaca al conjunto completo de credenciales, su responsable y el
resultado/fecha de una prueba de lectura completa y de descifrado/rehash. No se
copian valores ni hashes de credenciales al expediente, bundle o logs; la clave
de datos tampoco se guarda junto a ellos.

### Contenido minimo

`checkpoint-metadata.json` fija `schema=freeze-bundle-v1`, un
`client_instance_id` estable, `freeze_id` unico, sello UTC, identidades source
de cluster/Namespace/PVC como evidencia, operacion, intervalo de quiescencia,
tamano y hash solo de DB y storage, `runtime_generation=legacy-absent`,
`runner_mode=process-local`, procedencia del generador, version minima de
restore y `publication_state=complete`. No contiene su propio hash; la cobertura
del resto pertenece a `SHA256SUMS` para evitar ciclos.

`deployment-images.json` fija los 12 Deployments y 13 pares
Deployment/contenedor, sin initContainers, con repositorios allowlisted y
digests exactos. Los UID del source son evidencia historica, nunca una
precondicion del target.

El expediente debe demostrar antes de cualquier borrado que los 13 digests se
pueden recuperar durante toda la hibernacion. La opcion preferida es retencion
inmutable y verificable en el registry. Si no puede garantizarse, se conserva
un archivo OCI cifrado y hasheado en ubicacion independiente, con su propio
cost gate. Comprobar que hoy son pullables no sustituye la custodia futura.

`git-state.json` fija los tres commits, los gitlinks y las releases estables
aceptadas.

`external-config-redacted.json` registra dominio/DNS, proveedor SMTP, repos de
imagenes, IDs funcionales de sala/escena/Spoke, nombres de claves requeridas,
presencia booleana y responsables. No contiene valores, hashes de secretos,
tokens, prompts, conversaciones, manifiestos ignorados ni cuerpos de Secrets o
ConfigMaps.

`infrastructure-recipe.json` normaliza proveedor/region, DOKS sin HA,
numero/tamano de nodos, storage class, PVC y tamanos, Load Balancer, Namespace
logico, ingress/cert-manager, topologia, orden de regeneracion/aplicacion y
resultado fechado del cost gate. No es un volcado crudo de la API del proveedor.

## 4. Identidades de origen y destino

`client_instance_id` une comercialmente ambas instalaciones. Las identidades
de Kubernetes no se reutilizan:

- los UID de cluster, Namespace y PVC source quedan congelados como evidencia;
- el target se captura despues de crear la infraestructura nueva;
- Namespace y PVC target deben tener UID nuevos y distintos del source;
- los UID/resourceVersion de Deployments y runners source no se comparan con el
  target;
- la compatibilidad target se decide por nombres, contratos, specs portables,
  runtime y digests;
- cualquier deriva de identidad target tras el preflight detiene el restore
  antes de escribir.

La confirmacion de restore liga como minimo `freeze_id`, hash externo de
`SHA256SUMS`, hashes DB/storage/inventario, UID source de Namespace/PVC, UID
target de cluster/Namespace/PVC y un operation ID nuevo.

## 5. Flujo v1

### Freeze

1. Verificar el baseline y adquirir una exclusion minima de operacion.
2. Detener los cinco consumidores en orden seguro y confirmar quiescencia.
3. Capturar DB y `ret-pvc` del mismo instante logico.
4. Generar inventarios redactados y validar contenido, hashes y pares fisicos.
5. Publicar atomicamente el bundle completo.
6. Crear dos copias cifradas independientes y comparar el recibo externo.
7. Solo entonces reanudar o, en una hibernacion aprobada, pasar al inventario de
   recursos que se propone retirar.

Un fallo posterior a publicar no puede invalidar ni descartar una copia ya
coherente. Una respuesta ambigua detiene la automatizacion con un diagnostico
corto; no activa reentradas, receipts o un coordinador distribuido nuevo.

### Reactivacion

1. `preflight-greenfield`: valida offline bundle, recibo, commits, digests,
   disponibilidad de imagenes, configuracion/redaccion, receta y cost gate. No
   requiere un cluster vivo y no crea recursos.
2. Tras una aprobacion explicita de coste, se crea la infraestructura target.
3. `preflight-reactivation`: captura identidades target nuevas, exige el
   bootstrap exacto y valida manifest, storage, DB y digests.
4. Los cinco consumidores permanecen a cero mientras se restauran juntos DB y
   `ret-pvc` del mismo bundle.
5. Se validan contrato DB, migraciones, UUID activos y pares fisicos; despues se
   reanudan los servicios en orden.
6. Verificador live y navegador frio cierran la operacion y registran el RTO
   observado, sin prometer un tiempo anterior al ensayo.

La edad del bundle se informa. No caduca automaticamente a las 24 horas: para
una hibernacion larga mandan integridad, compatibilidad, credenciales e imagenes
disponibles.

### Bootstrap target exacto

El target previo al restore solo puede contener recursos declarados por el
manifest generado y validado para ese candidato. Sus unicos Deployments son:

```text
bot-orchestrator coturn dialog haproxy hubs nearspark
pgbouncer pgbouncer-t photomnemonic pgsql reticulum spoke
```

Los cinco consumidores `reticulum`, `pgbouncer`, `pgbouncer-t`,
`bot-orchestrator` y `coturn` permanecen a replicas cero. Los otros siete solo
pueden usar los digests del bundle. No puede existir Job, CronJob, DaemonSet,
StatefulSet, Deployment, Pod, PVC, runner namespace ni objeto namespaced fuera
del manifest/PVC allowlist. Ningun Pod puede montar `ret-pvc`; los volumenes
target son nuevos y contienen solo el bootstrap DB/storage explicitamente
validado. Cualquier extra o dato de aplicacion previo es FAIL.

## 6. Mapa keep / reimplementar / congelar

### Conservar desde `origin/main`

- `create-checkpoint.sh`, los dos capturadores DB/storage y la publicacion
  atomica ya existente;
- `validate-checkpoint.sh` y sus validaciones de hashes, dump, tar, UUID y pares
  de medios;
- `capture-instance-state.sh` como fuente, sustituyendo snapshots crudos por las
  proyecciones portables de v1;
- restore coordinado DB+PVC, orden seguro de consumidores, Lease/lock minimo y
  comportamiento fail-closed;
- `verify-live-reactivation.sh`, aceptacion de navegador y lifecycle por cliente;
- commits, gitlinks, digests y features ya integradas en los forks.

### Implementado de forma minima en H2

- el layout/validador de `freeze-bundle-v1` y su recibo externo;
- las dos proyecciones redactadas de configuracion e infraestructura;
- `preflight-greenfield` separado;
- binding source/target y `cold-rebind` con UID nuevos;
- preflight de target vacio/bootstrap y confirmacion source+content+target;
- una prueba enfocada que preserve la publicacion del bundle antes de cualquier
  reanudacion, invariante que `origin/main` ya implementa;
- un runbook manual corto para resultados ambiguos.

En `origin/main`, `create-checkpoint.sh` ya valida y publica el directorio final
antes de intentar reanudar los writers. H2 no reimplementa esa frontera: la
congela con una regresion. Solo debe corregir la deriva de
`deployment/client-instance-lifecycle.md`, que llama schema 3 a
`deployment-images.json` aunque el capturador y `deployment/README.md` ya usan
schema 4.

### Congelar: no trasladar al candidato

La rama `codex/recovery-closure@0e33acb` y sus tres ficheros locales sin commit
se conservan sin fusionar. No se trasladan por defecto los commits funcionales
`6d2b0f9`, `75ab970`, `3a6d6ad` y `0e33acb`, ni:

- `deployment/recovery-checkpoint-authority.mjs`;
- `deployment/recover-checkpoint-backup.sh plan/execute`;
- keyring/HMAC y autoridad durable de cinco Deployments;
- nuevas reentradas, receipts, monitores, PID/FINAL y matrices de respuestas
  perdidas;
- pruebas dedicadas que solo existen para esos protocolos.

Una pieza congelada solo puede volver mediante una meta separada y una
necesidad demostrada. El tiempo ya invertido no es criterio de incorporacion.

## 7. Aceptacion binaria

Freeze es PASS solo con los nueve artefactos exactos, validadores completos,
stamp DB/storage comun, pares fisicos completos, quiescencia correcta,
publicacion previa a reanudacion y un recibo exacto que pueda demostrar la
custodia de los 13 digests y dos copias cifradas. H2 implementa y prueba ese
contrato; la creacion y comprobacion real de las dos copias pertenece a H5.

Cold restore es PASS solo con bundle byte-invariante, source/target ligados por
separado, UID target nuevos, bootstrap exacto, consumidores a cero
durante DB/PVC, contrato y medios exactos, imagenes por digest, cero residuos
ambiguos, verificador live con cero fallos/warnings y aceptacion fria real.

Un warning, estado parcial, mezcla DB/PVC, drift target o respuesta ambigua es
FAIL. Produccion, borrado y costes quedan fuera de H1-H4 y necesitan permiso
explicito en H5.

## 8. Limite de implementacion H2

H2 no puede anadir un servicio, CRD, base de datos, keyring, protocolo de
monitorizacion ni dependencia. Su allowlist maxima inicial es:

```text
deployment/create-checkpoint.sh
deployment/capture-instance-state.sh
deployment/lib/recovery-safety.sh
deployment/restore-checkpoint.sh
deployment/preflight-greenfield.sh
deployment/preflight-reactivation.sh
tests/recovery/test-recovery-safety.sh
tests/scripts/security-gates.test.sh
deployment/client-instance-lifecycle.md
deployment/README.md
docs/client-hibernation-design-v1.md
docs/active-goal-plan-2026-07-18.md
docs/estado-sencillo.md
docs/session-changelog.md
```

H2 no cambia `restore-retdb.sh`, `restore-ret-storage.sh` ni los dos monitores.
`capture-instance-state.sh` queda incorporado de forma causal al alcance H2:
es el productor actual de los inventarios, y su modo `freeze-bundle-v1` debe
emitir directamente las cuatro proyecciones portables sin crear volcados crudos
que despues hubiera que borrar. No cambia su modo historico. Si otra prueba
causal demuestra que un hijo concreto necesita cambiar, se anade solo ese
fichero y se revisa el alcance antes de editarlo.

Si el cold-rebind exige ampliar esta frontera o aparece el mismo fallo dos
veces sin nueva evidencia causal, H2 se detiene para auditoria en vez de abrir
otra matriz.

### Evidencia de cierre H2

Sobre el candidato local pasan bundle `5/5`, materializacion `46/46`, preflight
greenfield `4/4`, preflight target `49/49`, creacion `49/49` y cold restore con
fail-close `49/49`. Tambien pasan Bash syntax, ShellCheck y `51/51` regresiones
de seguridad. No se ejecuto el full, GitHub, un cluster real ni produccion; esa
frontera corresponde a H3/H4.

## 9. Evidencia de cierre H3

El ensayo aceptado `20260809-h3d` se ejecuto sobre Ubuntu 24.04 ARM64 con K3s
`v1.35.5+k3s1`, un unico nodo y API local. La VM no monto el checkout ni el Home
del host y el harness no llama a DigitalOcean, GitHub ni endpoints publicos.

El origen y el destino tuvieron UID distintos de cluster, Namespace,
`pgsql-pvc` y `ret-pvc`. El mismo bundle restauro:

- `356` relaciones PostgreSQL, `94` migraciones y `17` hubs;
- `4` pares de medios: avatar, escena, proyecto Spoke y diferido;
- los `3` UUID activos y los bytes exactos de DB/storage;
- los cinco writers a `1/1`, con cero lock residual.

El resultado fue `14/14 PASS` y el segmento local de reactivacion midio `11 s`.
La medida excluye provisionamiento DOKS, pull de imagenes, DNS, certificados y
aceptacion funcional de navegador; H5 medira el ciclo comercial completo.

La ejecucion tambien justifico una ampliacion causal del alcance H3: los hijos
DB/storage y los dos watchers debian distinguir identidad source de target y
usar endpoints de listas Kubernetes tipados. No se incorporo el recovery
avanzado congelado ni se anadio servicio, CRD, protocolo o dependencia.
