# Entrada a los tres ciclos completos · 01/10/2026

Receta subordinada al [plan activo](/Users/Shared/Gits/YenHubs/PLAN/Plan_activo.md)
y al [contrato completo](/Users/Shared/Gits/YenHubs/DOC/fiabilidad-operativa-yenhubs-2026-10-01.md).
Preparación OFFLINE, no un recibo de aceptación de runtime ni otra fuente de
orden. Se reutilizan `create-checkpoint.sh`, `restore-checkpoint.sh`, el
generador/`npm run apply` protegidos y los verificadores existentes; ningún
coordinador nuevo ni sustitución de sus guardas.

## Cuatro entradas antes de ejecutar

1. **Código:** candidato limpio, dos gitlinks exactos, full con15/15 recibos
   compatibles y exit0. Integrar subrepos en sus bases y luego root `main`;
   el consumidor oficial exige `main=origin/main` limpio y su Cloud exacto.
   No pasarle un SHA alternativo para acreditar una rama candidata. Una
   integración que cambie inputs renueva solo los recibos afectados, sin
   transferir aceptación por el nombre de la rama.
2. **Imágenes:** productor coordinado de Reticulum/parent/runner del mismo
   SHA/run/attempt, cinco archivos auténticos y verificación criptográfica
   real. Ver [productor](fiabilidad-build-runtime-2026-10-01.md) y el runbook.
   Dos Hubs oficiales distintos para publicación/vuelta atrás, cada uno con
   su fuente/digest; todos los demás servicios también por digest y plataforma
   disponible. Los digests de fixtures, PAUSE, tags y JSON sin firma no sirven.
   No se despacha otro build ni se descarga una imagen en esta preparación.
3. **Destino:** Kubernetes aislado real AMD64, API/admission/Lease/Watch,
   storage y red verificados, sin mounts/credenciales/DNS de producción.
   La VM x86 existente aún no tiene K3s; el checkpoint planteado al dueño
   sigue sin respuesta. No iniciarla/instalar/pullar por silencio. La ARM
   histórica con alias PAUSE no reemplaza esta entrada. Reticulum y ambos
   pools deben usar la major PG fijada por la imagen aprobada; el ensayo
   nativo14.23 no autoriza un cambio de major en el destino.
4. **Datos:** fuente medible que incluya los33 modelos/miniaturas aprobados,
   siete listing IDs y vínculos DB/medios/sala/escena/ownership. Preparar una
   instancia sintética propia y coherente por el procedimiento de instalación,
   no llamar a un restore standalone ni copiar values/SMTP productivos.
   La copia histórica de347 tablas/61 pares no incluye el catálogo actual.
   No se acepta como representativa hasta verificar su semilla SQL, origen
   local de todas las URLs, datos y volumen; no basta disponer de los GLB.

Las entradas2–4 aún no están aceptadas. El productor local y los tests del
preparador no cierran estos gates, ni los tres ciclos ni el Goal.

## Fuente de activos comprobada en lectura

Canary77cff9 exit0, sin red ni escrituras: catálogo de W igual al aprobado,
33 GLB cuyo SHA coincide con los receipts,33 PNG con cabecera720×1280 y
siete IDs previstos.30.659.964B de GLB y20.375.367B de PNG. No se regeneraron
modelos/miniaturas ni se leyó la web como laboratorio. Los hashes de PNG son
una selección actual de inputs, no una nueva revisión visual del dueño.

- Manifest `features/avatar-creator/rpm-catalog.json`, SHA256
  `b516e6edb68ef484d6a4547eb3b52a90e5bceed00d83a0185f0df1a2b6dfdbab`.
- Receipts de fuente: `/Users/Shared/Gits/YenHubs-avaturn/output/rpm-catalog-20260925/thumbnails/render-receipts.json`.
- Originales: `/Users/yengalvez/Downloads/AvatarsRPM` y
  `/Users/yengalvez/Desktop/T/UNIE/Avatars`; no trasladarlos ni sobrescribirlos.
- Binding SHA256`0c20c58c231996f43fe30a19ee9b8fac67ba583d710cb0dfa4ea7183c3641443`
  de JSON UTF-8 en orden de entries con `{stem,glb_sha256,png_sha256,existing_listing}`.

Esto fija binarios de referencia. Aún falta una semilla del destino con esos
vínculos y ownership y un oráculo de readback DB/API; no es el backup actual
de producción ni afirma que el catálogo público haya sido releído hoy.

## Inputs y autoridad del destino

Un directorio propio0700, archivos0600; valores sintéticos por perfil,
clave HMAC local nueva, autoría de origen y output no-clobber. Usar
`prepare-staging-values.mjs` existente con shared/admin/SMTP sintéticos, no
con archivos ACTIVOS de producción; sus defaults no son automáticamente
storage/TLS/red válidos para K3s. Revisar esos contratos antes de aplicar.
Resolver nombres solo al destino; bloquear proveedor/SMTP/salida productiva
en el aislamiento. Una llamada a IA sintética no acredita un proveedor real.

Fijar `KUBECONFIG`, `EXPECTED_KUBE_CONTEXT`, `NAMESPACE`,
`EXPECTED_NAMESPACE_UID`, `EXPECTED_RET_PVC_UID`, nodos/platform/storage,
epoch, cinco contratos de consumers, imágenes y hashes de values/manifiesto.
El driver Cloud además usa `KUBECTL_CONTEXT` con el mismo contexto explícito;
el `current-context` de ese kubeconfig aislado debe coincidir. No cambiar el
kubeconfig/namespace ambiente del dueño para forzar la coincidencia.
Prohibir el contexto `do-ams3-hubs-ce`, sus UIDs
y dominios/credenciales como destino de estos ensayos. No usar aliases
`fixture-context/fixture-uid/fixture-pvc-uid`, opt-ins de fixture, bypasses ni
un preset cold-rebind para disfrazar identidad in-place.

Para bot installation durable: manifests **bootstrap→admission→active**, cada
uno generado/verificado/aplicado por el driver normal. Primero certificar la
instalación real y el dataset, no importar a un cluster no inventariado.
Los seis perfiles se aceptan por separado; BASE/botsOFF no se fuerza a
durable-v2 ni se omiten los controles de presencia/tráfico/STOP de su contrato.

## Cada ciclo i=1,2,3 sobre los mismos bytes congelados

Los tres son positivos, completos y consecutivos en la instalación durable
representativa, no tres pausas de producción ni tres rondas nativas de datos.
Entre ciclos se mantiene el destino/UID/PVC y se avanza epoch Ei-1→Ei. No
reutilizar un checkpoint viejo ligado a la generación anterior.

1. **Copia:** validar autoridad/ausencia de operación pendiente, oráculos de
   datos y servicio; `./deployment/create-checkpoint.sh /ruta/privada/cycle-i`
   con `ALLOW_CHECKPOINT_DOWNTIME=1`, values/manifiesto activos del destino y clave
   propia. Registrar exit real. Exigir ambas partes, esquema/inventario/identidad,
   13 hashes recalculados para el formato ordinario, marcador incompleto
   ausente y reanudación exacta/lock ausente/Lease libre. Una carpeta no es PASS.
2. **Preflight/restore:** preparar values de fence con Ei nuevo y values de
   reactivación con el mismo Ei mediante la transición de abajo; generar ambos
   manifiestos con Cloud actual. Preflight read-only del coordinador, confirmar
   el prepare exacto, aplicar fence protegido, ejecutar fenced exacto. Las
   confirmaciones y journal son privados y de ESTA operación; no fabricarlos
   ni reemplazar UID/epoch tras una negativa. Restaurar DB+medios, no solo SQL.
3. **Reactivate/smoke:** aplicar active protegido con Ei, live0fallos/0avisos
   y navegador interno frío; finalizar por coordinador hasta journal terminal,
   lock ausente/Lease libre. Comparar filas/IDs/hash de archivos,33 modelos,
   miniaturas/ownership/links y sala/escena con el oráculo anterior. El gate
   de navegador exige APP/AFRAME/escena, bots según perfil,0uncaught; no cache
   heredada, CSS inyectado o PIN de otra copia como evidencia.
4. **Deploy/rollback:** generar cambio coherente con segundo digest Hubs
   oficial, diff redactado y `npm run apply` protegido; refrescar Reticulum
   con la misma imagen/configuración. Live y navegador frío. Volver al digest
   anterior por otro manifiesto generado/apply protegido, refrescar y repetir
   los oráculos. Esta vuelta de imagen no restaura DB. No introducir upgrade
   upstream/major PG/otros digests dentro de ese cambio de cliente.
5. **Cerrar medición:** tiempos monotónicos de preparación, preflight,
   quiescence, DB, medios, hashes, restore, apply/readiness, cold smoke,
   reanudación/finalización y rollback; total incluye cleanup/esperas/caches.
   Registrar frío/caliente, volumen, calls y los mismos oráculos en los tres.
   Evaluar los SLO del contrato sin ampliar30/10s o reserva2s ni ocultar fases.

Los cortes negativos (API/Watch/SIGKILL/ACK/pull/readiness/admisión/autoridad)
son ensayos dirigidos separados dentro del aislamiento, antes de la serie
positiva. Ante un fallo, marcar ciclo incompleto, reconciliar de forma protegida
y diagnosticar; no autorreintentar ni aceptar las partes. Reanudar una fase
exacta del journal no equivale a ejecutar de nuevo una operación ya completada.
No realizar restore, fence, copia nueva o despliegue productivo por esta receta.

## Transición de inputs nueva, no otra operación de recuperación

Desde el root limpio del candidato, SOLO con fuente aislada privada:

```bash
node deployment/prepare-staging-values.mjs --transition-recovery-phase \
  /ruta/privada/source-active.yaml /ruta/privada/target-fence.yaml active restore-fence
node deployment/prepare-staging-values.mjs --transition-recovery-phase \
  /ruta/privada/target-fence.yaml /ruta/privada/target-active.yaml restore-fence active
```

Solo dos transiciones; fuente con bots instalados/activation active, runner de
familia oficial por digest y UUIDv4 canónico. Primera: fase y epoch nueva.
Segunda: fase, misma epoch. Todos los demás bytes se conservan. No prueba firma,
imagen disponible, checkpoint, UIDs, journal, SQL o autoridad de restore/apply.
Esas validaciones siguen en coordinador/Cloud. No editar el manifiesto generado.

Para generar cada archivo desde `hubs-cloud/community-edition`, fijar juntos
`HCCE_INPUT_VALUES_PATH`, `HCCE_OUTPUT_PATH` y `HCCE_MANIFEST_PATH` antes de
`npm run gen-hcce`; output y manifest designan el mismo archivo nuevo privado.
Para apply: input y manifest de ESA fase, `KUBECTL_CONTEXT` aislado y las
capacidades/clave/journal que el runbook exige. Para copia/restore/live:
`VALUES_FILE`, `HCCE_MANIFEST_PATH`, `PROCESS_LOCAL_CUTOVER_KEY_PATH` y los
EXPECTED bindings aislados. Fence para preflight/prepare/execute; active para
reactivación/finalize. Ningún preset/confirmación en esta receta sustituye
las identidades devueltas y comprobadas por la operación.

Pruebas normales `tests/scripts/staging-recovery-values.test.mjs`, registradas
una sola vez en el inventario local/CI `scripts/test-aud065.sh`. Canaryf3feea
exit1 por modo ausente;37947 exit0,3/3 nuevas.94089 exit0,1/1 adicional:
preparador→generador y verificador reales offline de fence/active, cinco
replicas0→1, PG1, epoch exacta/digests conservados. Antesf64d67 falló por PEM
sintético serializado fuera del subset estricto; se corrigió SOLO el fixture
a la representación quoted emitida por el preparador, sin relajar parser.
Las3 válidas no se repitieron.6630 exit0,1/1 distinto de bots-only sin key IA
comprueba que preparar el fence no activa IA/Avaturn ni exige sus credenciales.
Los cinco tests son nuevos y cada caso vigente pasó sobre sus bytes finales;
no se repiten matrices anteriores. Esto no es una
aceptación de un perfil runtime. Inputs/artefactos son sintéticos, sin apply/red.
YAML2.9 cacheado de F/lock idéntico; scratch/logs0700/0600 en
`/private/tmp/yn-cycle-entry-aAklf6`. Revisión primaria separada, no independiente:
argumentos y tipos cerrados, ausencia de autoridad implícita/red, no-clobber,
preservación byte a byte y epoch/source correctos; BASE/legacy no se convierten
en durable. No se encontró otro delta de producto que reparar en este bloque.
bd0955 exit0: Node syntax, Bash syntax/ShellCheck, diff y comprobación de
registro único local/CI PASS. Gitleaks final/commit y la consulta de recibos
se registran en PLAN; aquí no se afirma full ni aceptación de sus entradas.
