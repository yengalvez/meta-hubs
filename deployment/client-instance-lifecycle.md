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
- coste base aproximado de 65 USD/mes antes de impuestos y overages.

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
6. Para un cliente realmente nuevo, que aun no tiene checkpoint, validar los
   values locales sin usar un preflight de reactivacion:

   ```bash
   VALUES_FILE=/ruta/privada/input-values.yaml \
     node deployment/parse-local-values.mjs \
       /ruta/privada/input-values.yaml --validate
   ```

   `preflight-greenfield.sh` se reserva para recrear una instancia hibernada:
   exige su bundle y recibo; no se inventa un checkpoint para un alta nueva.

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
export CLIENT_INSTANCE_ID='<id-estable-minusculas>'
export FREEZE_DNS_PROVIDER='<proveedor-dns>'
export FREEZE_SMTP_PROVIDER='<proveedor-smtp>'
export FREEZE_ROOM_ID='<id-sala-principal>'
export FREEZE_SCENE_ID='<id-escena-publicada>'
export FREEZE_SPOKE_PROJECT_ID='<id-proyecto-spoke>'
export FREEZE_RESPONSIBLE_OWNER='<responsable-operativo>'
export FREEZE_COST_GATE_CHECKED_AT='<AAAA-MM-DDTHH:MM:SSZ>'
export FREEZE_ESTIMATED_MONTHLY_USD='<importe-no-negativo>'

ALLOW_CHECKPOINT_DOWNTIME=1 CHECKPOINT_FORMAT=freeze-bundle-v1 \
  ./deployment/create-checkpoint.sh /ruta/absoluta/freeze-bundle
```

El bundle comercial contiene exactamente nueve ficheros:

- `retdb-*.sql.gz`;
- `ret-storage-*.tar.gz`;
- `checkpoint-metadata.json`;
- `database-contract.json`;
- `deployment-images.json` con los 12 Deployments, 13 pares exactos, ningun
  `initContainer` ni contenedor efimero y todas las imagenes por digest;
- `git-state.json`;
- `external-config-redacted.json`;
- `infrastructure-recipe.json`;
- `SHA256SUMS`, que cubre exactamente los otros ocho.

Este modo acepta el baseline comercial `process-local`. Detiene coordinadamente
los cinco consumidores, captura DB y medios del mismo instante, valida pares y
contratos y publica el bundle antes de intentar reanudar. Ante una respuesta
ambigua no se debe improvisar otra reentrada: conservar el diagnostico, el lock
y los consumidores a cero hasta revisar el estado exacto.

### 2. Validar recuperabilidad

```bash
gzip -t /ruta/retdb-*.sql.gz
./deployment/validate-checkpoint.sh \
  /ruta/retdb-*.sql.gz /ruta/ret-storage-*.tar.gz
RESTORE_PREFLIGHT=1 ./deployment/restore-retdb.sh /ruta/retdb-*.sql.gz
EXPECTED_RET_PVC_UID='<uid-exacto-ret-pvc>' RESTORE_STORAGE_PREFLIGHT=1 \
  ./deployment/restore-ret-storage.sh /ruta/ret-storage-*.tar.gz

VALUES_FILE=/ruta/privada/input-values.yaml \
  ./deployment/preflight-greenfield.sh \
    /ruta/freeze-bundle /ruta/protegida/freeze-receipt.json
```

`create-checkpoint.sh` ejecuta el validador de contenido antes de crear
`SHA256SUMS`: extrae del dump los UUID activos de `ret0.owned_files` y exige
que el tar contenga ambos ficheros `.blob`/`.meta.json`. Permite pares
adicionales completos en estado diferido, pero no activos ausentes ni pares
incompletos. Tambien exige que `database-contract.json` coincida exactamente
con el DDL, las versiones de migracion y los conteos del dump. El checkpoint se
construye en staging privado y solo se publica atomicamente tras validar todo;
una colision o fallo no sobrescribe ni deja un directorio final parcial. Los
modos de preflight son solo lectura; no crean una base temporal ni ensayan el
restore real.

Antes de borrar DigitalOcean, copiar el bundle completo a dos ubicaciones
cifradas independientes y crear fuera del bundle un recibo privado `0600` con
schema `freeze-bundle-receipt-v1`. El recibo liga el SHA-256 de `SHA256SUMS`,
ambas pruebas de descifrado/rehash, custodia de las 13 imagenes y referencias
opacas al escrow de clave y credenciales. El schema exacto esta en
`docs/client-hibernation-design-v1.md`; ninguna referencia contiene secretos.

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

### Ensayo local aceptado antes de H4

El 9 de agosto de 2026 se completo el ensayo `20260809-h3d` en Ubuntu 24.04
ARM64 con K3s `v1.35.5+k3s1`. Origen y destino usaron identidades distintas de
cluster, Namespace y ambos PVC; DB y medios se restauraron juntos y los cinco
consumidores terminaron `1/1`, sin lock residual. El harness paso `14/14` y el
segmento local de reactivacion midio `11 s`.

Esta evidencia demuestra el contrato cold-rebind y no toca DigitalOcean. No
sustituye el ensayo comercial: no incluye provisionamiento DOKS, DNS,
certificados, pulls remotos ni aceptacion de navegador. Los recursos y el
expediente privado del laboratorio se preservan para auditoria; no se reutiliza
el mismo `RUN_ID` ni se borra evidencia para repetir un verde.

1. Recuperar los tres repos, el bundle, el recibo separado y los values
   privados. Confirmar commits y digests.
2. Antes de crear infraestructura, ejecutar el gate offline:

   ```bash
   VALUES_FILE=/ruta/privada/input-values.yaml \
     ./deployment/preflight-greenfield.sh \
       /ruta/freeze-bundle /ruta/protegida/freeze-receipt.json
   ```

3. Solo tras aprobar el coste, recrear DOKS, cert-manager, ingress y DNS.
4. Generar el manifest target con los cinco consumidores a replicas cero. El
   Namespace, `ret-pvc`, `pgsql-pvc` y sus UID deben ser nuevos; no introducir
   Jobs, Pods, workloads o datos extra.
5. Capturar `EXPECTED_KUBE_CONTEXT`, `EXPECTED_NAMESPACE_UID` y
   `EXPECTED_RET_PVC_UID` del target y ejecutar el preflight read-only:

   ```bash
   RESTORE_TARGET_MODE=cold-rebind \
   BACKUP_DIR=/ruta/freeze-bundle \
   FREEZE_RECEIPT_PATH=/ruta/protegida/freeze-receipt.json \
   VALUES_FILE=/ruta/privada/input-values.yaml \
     ./deployment/preflight-reactivation.sh
   ```

6. Crear un `COLD_REBIND_OPERATION_ID` nuevo de 32 hex minusculas. Ejecutar una
   primera vez sin confirmacion para obtener el valor exacto; esa negativa es
   anterior al Lease y a cualquier mutacion. Revisarlo y repetir:

   ```bash
   RESTORE_TARGET_MODE=cold-rebind \
   RESTORE_CHECKPOINT_COLD_REBIND=1 \
   COLD_REBIND_OPERATION_ID='<32-hex-nuevo>' \
   FREEZE_RECEIPT_PATH=/ruta/protegida/freeze-receipt.json \
   VALUES_FILE=/ruta/privada/input-values.yaml \
     ./deployment/restore-checkpoint.sh /ruta/freeze-bundle

   RESTORE_TARGET_MODE=cold-rebind \
   RESTORE_CHECKPOINT_COLD_REBIND=1 \
   COLD_REBIND_OPERATION_ID='<32-hex-nuevo>' \
   FREEZE_RECEIPT_PATH=/ruta/protegida/freeze-receipt.json \
   VALUES_FILE=/ruta/privada/input-values.yaml \
   CONFIRM_COLD_REBIND_RESTORE='<valor-exacto-impreso>' \
     ./deployment/restore-checkpoint.sh /ruta/freeze-bundle
   ```

7. El driver restaura DB y `ret-pvc` juntos, valida contrato/UUID/pares, reanuda
   en orden y ejecuta el verificador live. Nunca ejecutar los hijos destructivos
   por separado ni combinar DB y storage de fechas distintas.
8. Completar carga fria, login, sala, audio, camaras, avatar, Admin y Spoke. Los
   bots solo se aceptan si forman parte del baseline comercial de esa instancia.

Si falla despues de empezar a escribir, el driver intenta dejar los cinco
consumidores a cero y conserva el lock exacto. No borrar el lock, escalar a mano
ni repetir a ciegas: guardar el primer diagnostico, comprobar Lease/lock,
replicas y consumidor de PVC, y abrir una recuperacion manual separada.

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
[ ] recibo externo privado verificado
[ ] commits y digests registrados
[ ] values/secrets custodiados fuera de Git
[ ] DNS/SMTP/OpenAI/GHCR documentados
[ ] cluster/LB/volumenes verificados tras cierre
[ ] procedimiento de restauracion probado
```
