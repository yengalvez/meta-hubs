# Importador RPM: C01/C02, contrato y verificación local

Estado: candidato local; no ejecución contra producción. El manifiesto de 33
modelos, los siete listing SID existentes y los hashes originales no se cambian.
Los tests usan exclusivamente GLB, PNG, SQL y medios artificiales.

## Puerta de respaldo

`--apply` exige `--checkpoint DIR --target-identity JSON`. El nuevo adaptador
`deployment/validate-rpm-catalog-checkpoint.sh` invoca exclusivamente los
validadores canónicos de `recovery-safety.sh` (legacy v2/v3 o freeze-bundle-v1)
y `validate-checkpoint.sh`: layout, hashes, contrato de base de datos,
generación/metadata y correspondencia DB/media. No adquiere leases, consulta
Kubernetes, restaura ni autentica. No modifica el contrato de los backups.

La identidad debe obtenerla el coordinador del **destino real**, independientemente
del backup. No copiar UID desde `checkpoint-metadata.json`. Esquema JSON cerrado:

```json
{
  "schema_version": 1,
  "base": "https://destino.example",
  "kube_context": "contexto-explicito",
  "namespace": "hcce",
  "namespace_uid": "uid-obtenido-del-destino",
  "ret_pvc_uid": "uid-obtenido-del-pvc-destino"
}
```

Para freeze-bundle-v1 son obligatorias además `client_instance_id` (identificador
estable de esa instancia, desde su configuración autorizada) y `cluster_uid`
(UID del namespace kube-system). No añadirlas al esquema legacy. `base` debe
ser exactamente el origen HTTPS usado por `--base`, sin ruta ni barra final.

Captura read-only que corresponde al coordinador, con contexto/namespace
previamente seleccionados por su runbook (no se ejecutó durante este trabajo):

```bash
kubectl --context "$CTX" get namespace "$NS" -o jsonpath='{.metadata.uid}'
kubectl --context "$CTX" -n "$NS" get pvc ret-pvc -o jsonpath='{.metadata.uid}'
# Solo para freeze-bundle-v1:
kubectl --context "$CTX" get namespace kube-system -o jsonpath='{.metadata.uid}'
```

El recibo del journal enlaza identidad, hash del manifiesto del catálogo, hash
de SHA256SUMS y fecha previa a la primera mutación. El respaldo no puede estar
en el futuro ni tener más de 24 horas entonces; `--checkpoint-max-age-hours`
solo permite estrechar ese límite (>0, <=24). Una reanudación del **mismo** journal
conserva ese preestado aunque hayan transcurrido días: no reemplazar el respaldo
por uno posterior a la mutación. Cambiar identidad/manifiesto/checkpoint falla.
La puerta offline se ejecuta antes incluso de solicitar el token administrativo.
El recibo definitivo se persiste atómicamente con la primera intención de
escritura, tras repetir la puerta de frescura. Un preflight, aunque hubiera
dejado un recibo antiguo, no congela la edad sin una intención durable. Un
journal con intención pero sin ese recibo se rechaza por inconsistente.

## Reanudación y concurrencia

Cada operación persiste intención con fsync de archivo y directorio antes de
enviarse. Una intención existente se reconcilia mediante lectura, nunca mediante
otro PUT/POST/PATCH. Se comprueban UUID e ID de cada archivo subido, bytes de glTF,
binario y thumbnail nuevos, campos/IDs de avatar/listing y hashes de modelo.
Los siete modelos existentes conservan sus IDs glTF/bin; solo se cambia metadata
y thumbnail. Una respuesta perdida después de aceptar la operación puede
reanudarse automáticamente cuando la lectura es inequívoca.

El PUT requiere Reticulum compatible, anunciado en GET `/api/v1/avatars/:sid`:
`capabilities.conditional_update === true` y
`capabilities.conditional_update_fields === true`. Se envían
`avatar.expected_updated_at` y `avatar.expected_fields` con exactamente
`name`, `description`, `thumbnail_owned_file_id`, `gltf_owned_file_id`,
`bin_owned_file_id`. El servidor compara bajo lock antes de promover archivos;
un conflicto es 412, esquema inválido 400. Desplegar ese backend antes de usar
el candidato con los existentes. Un servidor viejo se rechaza antes del upload.
Los PATCH administrativos filtran el snapshot completo, incluido updated_at,
para proteger también cambios PostgREST que no avancen ese timestamp.

Una subida cuya respuesta se perdió antes de obtener el UUID no puede
reconciliarse inequívocamente: se detiene sin volver a subir. Lo mismo ocurre
si una intención quedó persistida pero nunca llegó al servidor, o si el estado
remoto difiere. Se requiere reconciliación del coordinador, no editar el journal
para forzar reintentos. Los journals v1 se rechazan; no se migran a ciegas.

`sync.lock` contiene PID y destino. Una muerte abrupta puede dejarlo presente;
comprobar que el propietario no sigue ejecutándose y conservar/retirar el lock
como evidencia antes de reanudar. El importador no elimina locks ajenos ni los
considera caducados por tiempo. El directorio privado contiene recibos de
promoción: mantener permisos 0700/0600 y no publicarlo.

## Invocación y pruebas

Los defaults de origen, correo y rutas siguen compatibles. Se pueden pasar
`--manifest`, `--receipts`, `--base`, `--admin-email`; el journal liga también el
correo. No se rebaja el allowlist de 33 entradas, siete IDs exactos y 26 altas.

```bash
node deployment/sync-rpm-catalog.mjs --values PRIVATE_VALUES \
  --journal-dir PRIVATE_JOURNAL --admin-origin http://127.0.0.1:4000 \
  --manifest MANIFEST_JSON --receipts RECEIPTS_JSON \
  --base https://destino.example --admin-email ADMIN_EMAIL \
  --apply --checkpoint CHECKPOINT_DIR --target-identity TARGET_JSON

node --test tests/scripts/rpm-catalog*.test.mjs
node --check deployment/sync-rpm-catalog.mjs
shellcheck -x deployment/validate-rpm-catalog-checkpoint.sh
```

Las pruebas cubren respaldo ajeno/viejo/futuro/no-preestado, binding de
reanudación, bundle parcial, contrato DB erróneo y medios incompletos/incompatibles;
recorrido 33/7/26, respuesta perdida PUT/POST/PATCH, fallo del journal tras
respuesta, colisión de identidad, respuesta de upload perdida y escrituras
concurrentes con/sin cambio de timestamp. Los fixtures se conservan en
`output/rpm-*-test-*` (ignorados), sin borrado automático amplio.

La revisión independiente detectó además que `Ret.AvatarSlug` regenera `slug`
al renombrar (`always_change: true`, fuentes `avatar_sid` y `name`). La lectura
valida ese slug esperado para el alfabeto real del catálogo fijo, en vez de
exigir el anterior o ignorar cualquier cambio. El valor queda incluido en el
snapshot completo para las reanudaciones posteriores. Ampliar los nombres a
otros alfabetos requiere extender explícitamente esa equivalencia con Slugger;
no se aplican transliteraciones aproximadas. Las regresiones reproducen cambio
realista de slug en POST/PUT, múltiples renombrados, respuesta perdida y slug
ajeno, además de interrupción antes del primer intent frente a continuación
válida 72 horas después de haberlo persistido.

La comprobación local no es aceptación live, visual ni legal del catálogo.
