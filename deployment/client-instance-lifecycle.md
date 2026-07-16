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
6. Ejecutar el preflight antes de crear recursos:

   ```bash
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
- `SHA256SUMS`;
- commits y submodulos;
- imagenes live;
- inventario Kubernetes y DigitalOcean;
- presencia de claves configuradas, nunca sus valores.

### 2. Validar recuperabilidad

```bash
gzip -t /ruta/retdb-*.sql.gz
./deployment/validate-checkpoint.sh \
  /ruta/retdb-*.sql.gz /ruta/ret-storage-*.tar.gz
RESTORE_PREFLIGHT=1 ./deployment/restore-retdb.sh /ruta/retdb-*.sql.gz
RESTORE_STORAGE_PREFLIGHT=1 \
  ./deployment/restore-ret-storage.sh /ruta/ret-storage-*.tar.gz
(cd /ruta/checkpoint && shasum -a 256 -c SHA256SUMS)
```

`create-checkpoint.sh` ejecuta el validador de contenido antes de crear
`SHA256SUMS`: extrae del dump los UUID activos de `ret0.owned_files` y exige
que el tar contenga ambos ficheros `.blob`/`.meta.json`. Permite pares
adicionales completos en estado diferido, pero no activos ausentes ni pares
incompletos. Los modos `*_PREFLIGHT=1` son solo lectura; no crean una base
temporal ni ensayan el restore real.

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
4. Ejecutar `deployment/preflight-reactivation.sh`.
5. Recrear DOKS, cert-manager, ingress y DNS.
6. Generar y aplicar el manifest.
7. Volver a capturar `EXPECTED_NAMESPACE_UID` para el namespace recien creado.
8. Restaurar primero PostgreSQL con confirmacion ligada a
   `retdb:<contexto>:<namespace>:<uid>`.
9. Restaurar despues el archive correspondiente de `ret-pvc`, con confirmacion
   ligada a `ret-pvc:<contexto>:<namespace>:<uid>`.
10. Reiniciar servicios dependientes.
11. Validar migrations, active owned files y pares fisicos.
12. Ejecutar el verificador y la aceptacion funcional completa.

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
