# Ciclo de vida de una instancia YenHubs

Guia para crear, operar, congelar, recuperar o retirar una instancia de
cliente. Los comandos detallados de Kubernetes estan en `deployment/README.md`.

## Principio

Cada cliente debe poder identificarse por un expediente local sin secretos:

- dominio y subdominios;
- cluster, region y namespace;
- commits de los tres repos;
- imagenes por digest;
- capacidad contratada;
- proveedor SMTP;
- IDs de salas/escenas/proyectos importantes;
- ultimo checkpoint completo;
- responsable de DNS, DigitalOcean, GitHub y correo.

Los secretos reales se guardan en un fichero local `0600` ignorado y en los
secret stores de los proveedores. No se copian al expediente.

## Alta de un cliente

### 1. Gate de coste

Antes de crear recursos, aprobar por escrito:

- region;
- tamano y numero de nodos;
- HA de control plane;
- numero de LoadBalancers;
- volumenes y retencion;
- SMTP, OpenAI y egress estimado.

Baseline YenHubs actual:

- un DOKS no-HA;
- un nodo Basic 4 vCPU / 8 GiB;
- un LB regional;
- dos PVC de 10 GiB;
- coste base aproximado de 62 USD/mes.

### 2. Preparar identidad

1. Crear o delegar DNS.
2. Definir correo administrador y proveedor SMTP.
3. Crear tokens de GitHub/GHCR sin reutilizar credenciales personales.
4. Crear claves OpenAI y DigitalOcean por cliente/proyecto cuando sea posible.
5. Copiar `deployment/input-values.example.yaml` a un fichero local ignorado.
   Para bots aislados, fijar por digest Reticulum, `bot-orchestrator` y
   `bot-runner` desde el mismo commit/recibo atestado. Conservar y verificar los
   cinco ficheros de esa procedencia: recibo JSON, bundle del recibo y bundles
   OCI de las tres imágenes. El commit se deriva del gitlink Cloud integrado en
   un root `main=origin/main` limpio; no se escribe un digest a mano. En una
   instancia nueva el pull config se genera con el helper trackeado y entrada
   oculta; durante la campaña AUD-065 se usa exclusivamente el preparador
   respaldado por Llavero, que crea y elimina un `DOCKER_CONFIG` efímero
   (`0700`, `config.json` `0600`) sin pasar `GHCR_TOKEN` por argv/entorno ni
   mostrarlo.
6. Ejecutar el preflight antes de crear recursos:

   ```bash
   BACKUP_DIR=/ruta/absoluta/checkpoint-fresco \
     ./deployment/preflight-reactivation.sh
   ```

### 3. Crear infraestructura

Seguir `deployment/README.md`:

1. DOKS no-HA.
2. kubeconfig.
3. cert-manager.
4. IngressClass y ClusterIssuer.
5. values local.
6. `npm ci && npm run gen-hcce`.
7. revisar `kubectl diff`.
8. aplicar el manifiesto sin editarlo.
9. configurar DNS.
10. validar certificados y endpoints.

### 4. Bootstrap de aplicacion

- comprobar magic link;
- registrar la cuenta administradora;
- abrir Admin y Spoke;
- crear/publicar una escena con Floor Plan/navmesh;
- crear sala de aceptacion;
- importar avatares permitidos;
- configurar `spawbot-*` y asientos;
- activar bots solo despues de validar navmesh y costes.

### 5. Aceptacion

```bash
./deployment/verify-live-reactivation.sh
```

Completar tambien:

- cold load desktop y movil;
- dos usuarios y audio;
- Admin/Spoke;
- avatar normal/full-body;
- sitting;
- bots y chat;
- `/transport-ready` del padre, `/ready` autoritativo y exactamente un Pod
  runner Ready por cada sala esperada, con digest/owner/generación exactos y
  cero Pods gestionados stale, terminales o desconocidos;
- backup y restore preflight de solo lectura.

## Operacion y cambios

Antes de una mutacion de DB, storage, escena live o infraestructura:

```bash
./deployment/create-checkpoint.sh
```

Para una feature:

1. rama corta;
2. tests;
3. Actions;
4. digest;
5. manifest generado;
6. rollout;
7. carga fria;
8. verificador;
9. merge.

Para cerrar la circularidad inicial de `AUD-065`, primero se fusionan el tooling
de secuencia, `AUD-078`, el productor Cloud de procedencia/recibos y su
consumidor raíz. Solo entonces se permite construir por Actions, sin desplegar,
Reticulum, parent y runner en un único run desde el commit Cloud fijado por el
gitlink raíz. Se verifican el recibo y los cuatro bundles con el Docker config
privado efímero; después se crea el primer checkpoint DB+storage. El completador
deriva de esa evidencia el runner, completa OLD y permite materializar NEW; a
continuación se ejecuta la rotación coordinada sobre el baseline live. Después
de la rotación se crea y valida el segundo checkpoint, y solo entonces se crea
la candidata bootstrap derivando sus tres digests de los mismos cinco ficheros.
Ningún build sustituye esos checkpoints ni autoriza un rollout.

El primer rollout de runners aislados usa tres manifiestos completos de 58
recursos, regenerados y aplicados con el wrapper guardado en orden
`bootstrap -> admission -> active`. Cada transición local debe consumir el
recibo autenticado de la fase live anterior y la promoción de la fuente
canónica debe consumir la aceptación final 0/0 ligada al mismo candidato.
`bootstrap` introduce Reticulum compatible manteniendo inerte la autoridad;
`admission` prueba policy/RBAC con el parent todavía parado; solo `active` puede
levantar parent y runners. El rollback restaura primero el parent legacy contra
el Reticulum compatible y solo después el Reticulum anterior, siempre con las
credenciales nuevas. Un manifiesto viejo no poda los ServiceAccounts, Role,
RoleBinding, Secret de pull ni NetworkPolicies nuevos; no declarar limpieza
completa hasta inventariarlos y retirarlos mediante una transición trackeada.
`process-local` sigue siendo el último baseline live aceptado y también puede
usarse como rollback. Tras un rollback, los bots públicos permanecen
deshabilitados y no se reabre ni se declara de nuevo aceptado hasta repetir
preflight, verificador live y carga fría con las credenciales nuevas. Nunca es
evidencia de capacidad.

No usar atajos manuales salvo emergencia expresamente aprobada.

## Modo mantenimiento

Escalar deployments a cero puede detener trabajo de aplicacion, pero no reduce
el coste principal:

```bash
kubectl scale deployment --all --replicas=0 -n hcce
```

El nodo, LB y volumenes siguen facturando. Este modo sirve para mantenimiento
corto, no para una pausa de semanas.

## Congelacion de una instancia

Fijar primero la identidad exacta. No usar un contexto implicito ni reutilizar
el UID despues de recrear el namespace:

```bash
export NAMESPACE=hcce
export EXPECTED_KUBE_CONTEXT='<contexto-kubectl-exacto>'
test "$(kubectl config current-context)" = "$EXPECTED_KUBE_CONTEXT"
export EXPECTED_NAMESPACE_UID="$(
  kubectl --context "$EXPECTED_KUBE_CONTEXT" get namespace "$NAMESPACE" \
    -o jsonpath='{.metadata.uid}'
)"
test -n "$EXPECTED_NAMESPACE_UID"
export EXPECTED_RET_PVC_UID="$(
  kubectl --context "$EXPECTED_KUBE_CONTEXT" get pvc ret-pvc -n "$NAMESPACE" \
    -o jsonpath='{.metadata.uid}'
)"
test -n "$EXPECTED_RET_PVC_UID"
```

Los scripts de backup y restore vuelven a comparar ambos valores antes de usar
el cluster. Un namespace recreado con el mismo nombre tiene otro UID y queda
bloqueado.

### 1. Crear checkpoint completo

```bash
./deployment/create-checkpoint.sh
```

Debe contener:

- `retdb-*.sql.gz`;
- `ret-storage-*.tar.gz`;
- `database-contract.json` con schemas, relaciones, migraciones, SID de salas,
  UUID/estado de `owned_files` y conteos exactos;
- `SHA256SUMS`;
- `checkpoint-metadata.json`;
- commits y submodulos;
- `deployment-images.json` con los 12 Deployments, 13 pares exactos, ningun
  `initContainer` ni contenedor efimero y todas las imagenes por digest. Su
  schema 3 incluye `bot_runner_runtime`: modo legacy `process-local` con imagen
  nula o modo `kubernetes-pod` con el digest exacto del runner;
- `k8s-hcce-structure.json` e inventario DigitalOcean;
- presencia de claves configuradas, nunca sus valores.

Antes de leer DB o PVC, checkpoint y restore deben mantener a cero Reticulum,
ambos Pgbouncers, bot-orchestrator y Coturn, y además esperar/monitorizar cero
Pods dinámicos gestionados de `bot-runner`. La reaparición de uno bloquea la
operación y la reanudación de escritores.

El checkpoint autoriza antes de mutar exactamente una frontera: el baseline
legacy `process-local` completo, sin autoridad ni namespace Kubernetes de
runners, o el runtime `kubernetes-pod` con fase `active`, manifiesto,
admission y RBAC exactos. Un binding parcial, una anotación unilateral o un
namespace runner residual no pueden hacer fallback a legacy. El driver liga el
modo al inventario y al fingerprint del Deployment y vuelve a validarlo antes
de reanudar; una deriva deja el parent a cero y conserva el lock.

Los inputs de values y, cuando corresponde, del manifiesto se copian antes del
downtime a snapshots privados `0600` ligados a la ejecución. Los gates consumen
solo esos snapshots. Checkpoint y restore reservan además la recuperación
autoritativa al driver principal: un subshell puede devolver un error, pero no
reanudar writers, duplicar el fencing ni liberar el lock. El contrato completo
se documenta en `deployment/README.md`.

### 2. Validar recuperabilidad

```bash
gzip -t /ruta/retdb-*.sql.gz
./deployment/validate-checkpoint.sh \
  /ruta/retdb-*.sql.gz /ruta/ret-storage-*.tar.gz
RESTORE_PREFLIGHT=1 ./deployment/restore-retdb.sh /ruta/retdb-*.sql.gz
EXPECTED_RET_PVC_UID='<uid-exacto-ret-pvc>' RESTORE_STORAGE_PREFLIGHT=1 \
  ./deployment/restore-ret-storage.sh /ruta/ret-storage-*.tar.gz
RESTORE_CHECKPOINT_PREFLIGHT=1 \
  ./deployment/restore-checkpoint.sh /ruta/checkpoint
BACKUP_DIR=/ruta/checkpoint ./deployment/preflight-reactivation.sh
```

`create-checkpoint.sh` ejecuta el validador de contenido antes de crear
`SHA256SUMS`: extrae del dump los UUID activos de `ret0.owned_files` y exige
que el tar contenga ambos ficheros `.blob`/`.meta.json`. Permite pares
adicionales completos en estado diferido, pero no activos ausentes ni pares
incompletos. Tambien exige que `database-contract.json` coincida exactamente
con el DDL, las versiones de migracion y los conteos del dump. El checkpoint se
construye en staging privado y solo se publica atomicamente tras validar todo;
una colision o fallo no sobrescribe ni deja un directorio final parcial. Los
modos `*_PREFLIGHT=1` son solo lectura; no crean una base temporal ni ensayan el
restore real.

La restauracion destructiva solo se permite mediante
`deployment/restore-checkpoint.sh`: mantiene Reticulum, ambos Pgbouncers,
bot-orchestrator y Coturn a cero desde antes del drop hasta validar juntos DB y
PVC. No ejecutar los dos hijos destructivos por separado. Si falla, los
consumidores permanecen a cero y conserva un lock global create-only ligado al
checkpoint y al destino. Un segundo restore no puede cruzarlo. Al completar,
el driver inicia proxies, Reticulum y despues bot/Coturn en orden de
dependencia, y solo entonces elimina su lock. El pod temporal tambien es
create-only: UID, token privado, spec admitida y montaje directo
`ret-pvc` -> `/storage` deben coincidir exactamente durante toda la extraccion.

Tras revisar un fallo, el lock retenido solo se elimina con
`RESTORE_CHECKPOINT_CLEAR_STALE_LOCK=1`, los cinco consumidores a cero, ningun
pod usando el PVC y `CONFIRM_CLEAR_RESTORE_LOCK` ligado al UID exacto del lock y
del PVC. Ese modo no escala ni reanuda nada.

Copiar el checkpoint a una segunda ubicacion cifrada. No borrar DigitalOcean
hasta validar ambas copias.

### 3. Capturar dependencias externas

- exportar/registrar DNS;
- anotar proveedor SMTP y dominio verificado;
- anotar repos y paquetes GHCR;
- conservar values local en un password manager o almacenamiento cifrado;
- registrar quien puede renovar los tokens;
- registrar fecha y motivo de cierre.

### 4. Apagar

Para una pausa larga:

```bash
doctl kubernetes cluster delete hubs-ce --force
doctl kubernetes cluster list
doctl compute load-balancer list
doctl compute volume list
```

Verificar tambien snapshots, backups administrados, reserved IPs y recursos
independientes del cluster. El objetivo es cero recursos no deseados, no asumir
que borrar el cluster elimina cualquier recurso de la cuenta.

## Restauracion

1. Recuperar los tres repos y el checkpoint.
2. Confirmar los commits y digests del expediente.
3. Renovar tokens caducados antes de crear el cluster.
4. Ejecutar `BACKUP_DIR=/ruta/checkpoint deployment/preflight-reactivation.sh`.
5. Recrear DOKS, cert-manager, ingress y DNS.
6. Generar y aplicar el manifest.
7. Volver a capturar `EXPECTED_NAMESPACE_UID` para el namespace recien creado.
8. Restaurar primero PostgreSQL con confirmacion ligada a
   `retdb:<contexto>:<namespace>:<uid>:<stamp>:<db-sha>:<storage-sha>`.
9. Restaurar despues el archive correspondiente de `ret-pvc`, con confirmacion
   ligada a `ret-pvc:<contexto>:<namespace>:<uid>:<stamp>:<db-sha>:<storage-sha>:<pvc-uid>`.
10. Confirmar cero Pods runner dinámicos durante toda la restauración.
11. Reiniciar servicios dependientes en el orden compatible: proxies,
    Reticulum Ready y después Coturn/parent; los nuevos runner Pods solo pueden
    aparecer tras abrir el control-plane.
12. Validar migrations, active owned files, pares fisicos y el
    `bot_runner_runtime` schema 3 contra el digest privado esperado.
13. Ejecutar el verificador y la aceptacion funcional completa.

Nunca combinar un dump de una fecha con un storage de otra.

## Baja definitiva

Ademas de la congelacion:

- acordar retencion y destruccion de backups;
- revocar tokens DigitalOcean, GitHub, SMTP y OpenAI;
- retirar DNS y certificados;
- revisar paquetes GHCR y repositorios;
- entregar o eliminar datos segun contrato;
- registrar evidencia sin incluir secretos ni conversaciones.

## Checklist compacta

```text
[ ] checkpoint DB + storage
[ ] checksums y dry-run correctos
[ ] segunda copia cifrada
[ ] commits y digests registrados
[ ] values/secrets custodiados fuera de Git
[ ] DNS/SMTP/OpenAI/GHCR documentados
[ ] cluster/LB/volumenes verificados tras cierre
[ ] procedimiento de restauracion probado
```
