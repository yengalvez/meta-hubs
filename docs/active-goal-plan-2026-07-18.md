# Meta activa: hibernar y reactivar una instancia de cliente

Ultima revision: **20 de agosto de 2026 (Europe/Madrid)**

Version: **v29**. Estado activo: **H5-B19 en reactivacion. La topologia exacta
ya esta recreada con Kubernetes `1.34.10-do.1`: `ams3`, HA desactivada, un nodo
`s-4vcpu-8gb`, un balanceador regional y dos volumenes de 10 GiB. El target
greenfield esta `12/12` exacto, con los cinco writers a cero. El preflight real
cold-rebind pasa completo. DNS y certificados ya estan cerrados `4/4`. El
restore supero el baseline y alcanzo la fase DB, pero no pudo demostrar la
quietud continua antes del reset en el ultimo intento. Estado fail-closed:
lock `cold-rebind` retenido, Lease existente pero libre/sin holder, cinco
writers `0`, cero Pods writer y DB target vacia. La lectura posterior confirma
contratos `5/5`, runner ausente, LIST/WATCH runner y PostgreSQL Ready; el fallo
restante fue temporal en la cadena de capacidades. El diagnostico por subetapa
queda implementado y su foco pasa `51/51`. La revision independiente del
candidato encontro tres incompatibilidades de integracion finitas. Ya estan
corregidas: el verificador live separa durable de cold-rebind process-local, el
gate full convoca una sola bateria agregada H5 y las suites oficiales Cloud, y
el runbook contiene el target exacto de limpieza. Sus focos finales pasan
`120/120`, `57/57` y `49/49`; el unico riesgo no simulado es la aceptacion live
real de DNS/TLS/HTTP/DB/medios. Siguiente accion exacta: fijar primero Cloud y
root en commits limpios y ejecutar una sola validacion
`./scripts/verify-project.sh --full`. Solo si queda verde se
limpia el lock por el procedimiento confirmado y se ejecuta un unico restore;
cualquier nueva parada debe traer el guard cerrado exacto y no autoriza otro
retry.

Este fichero es la unica fuente de orden y estado. La explicacion para el
propietario esta en `docs/estado-sencillo.md`.

## Decision de la auditoria

La plataforma funcional de YenHubs no se rehace. Produccion conserva el
baseline `process-local`, los forks se mantienen sobre sus releases estables y
el PR raiz `#15` permanece congelado, sin fusionar. H4 solo ha actualizado dos
pins transitivos vulnerables dentro de Hubs Cloud, sin mezclar un upstream ni
una feature.

La linea local de recovery avanzado tambien queda **congelada**. No ejecutar sus
grupos drift, TERM, redaccion, terminal, full o GitHub; no publicar ni desplegar
`recover-checkpoint-backup.sh execute`, la autoridad HMAC/keyring o sus matrices
hasta que una necesidad futura independiente los justifique.

La razon es de producto: el requisito del propietario no era crear un sistema
de alta disponibilidad ni resolver automaticamente cualquier respuesta ambigua
de Kubernetes. Era poder detener una instancia de cliente durante semanas o
meses, eliminar los recursos facturables de DigitalOcean y reactivarla despues
sin una reconstruccion artesanal.

Al abrir esta meta, el runbook documentaba `freeze -> borrar DOKS -> recrear`,
pero el restore de partida rechazaba `cold-rebind` y exigia los UID originales
del Namespace y del PVC. H2 cerro esa brecha en el codigo y H3 la demostro en un
target Kubernetes aislado real, sin crear recursos DigitalOcean.

## Resultado buscado

Entregar un ciclo por cliente, repetible y ensayado:

```text
instancia activa
  -> checkpoint conjunto PostgreSQL + ret-pvc validado
  -> segunda copia cifrada fuera del cluster
  -> inventario de versiones, digests, DNS y dependencias
  -> eliminacion confirmada de recursos DO facturables no deseados
  -> coste residual inventariado
  -> recreacion posterior en infraestructura nueva
  -> restore autenticado sobre Namespace/PVC nuevos
  -> aceptacion funcional real
```

Al cerrarlo se termina esta meta y se vuelve a una feature elegida por el
propietario. Alta disponibilidad, failover sin caida y certificacion de escala
son metas distintas y no bloquean este cierre.

## Dos modos de pausa

- **Pausa corta:** reducir capacidad cuando DigitalOcean lo permita. Puede
  conservar costes de Load Balancer, volumenes u otros recursos y no cuenta como
  hibernacion completa.
- **Hibernacion larga:** checkpoint verificado en dos ubicaciones, eliminacion
  controlada de cluster/LB/volumenes no deseados y reconstruccion posterior. Es
  el modo destinado a clientes inactivos.

## Reutilizar y sacar del camino critico

### Conservar

- releases estables aceptadas de Hubs y Hubs CE, forks y features existentes;
- copia conjunta de PostgreSQL y `ret-pvc`;
- validacion de hashes, contratos DB y pares fisicos de medios;
- commits, submodulos, imagenes por digest e inventario no secreto;
- publicacion atomica del checkpoint;
- Lease/lock unico y orden seguro de parada/reanudacion, en su forma minima;
- preflights redactados, verificador live y aceptacion de navegador frio;
- una segunda copia cifrada y un inventario explicito de costes.

### Fuera del camino critico

- adopcion automatica de respuestas perdidas;
- segunda reentrada, receipts y protocolos de PID/FINAL del backup;
- keyring/HMAC y el coordinador manual `plan/execute` actual;
- matrices exhaustivas de fallos hipoteticos;
- HA, recuperacion sin caida, escala masiva y nuevas modernizaciones de infra.

Nada se borra. La rama y los commits quedan como investigacion recuperable, pero
el coste hundido no obliga a terminarlos ni desplegarlos.

## Reglas anti-loop

1. Una casilla se ejecuta una vez sobre bytes identificados. No repetir un verde
   si no cambia producto u oraculo relevante.
2. No continuar una matriz porque ya se haya invertido tiempo en ella.
3. No añadir protocolo, monitor, objeto Kubernetes o criptografia sin demostrar
   primero que es imprescindible para hibernar o reactivar.
4. Una implementacion pequena debe preceder a cualquier full. Solo un
   `./scripts/verify-project.sh --full` por candidato final; no ejecutar antes el
   gate normal sobre los mismos bytes.
5. GitHub confirma un candidato local; no descubre hipotesis. Un solo run
   autoritativo por SHA y seguimiento directo hasta terminal, sin heartbeat de
   horas.
6. No mezclar recovery, upstream updates y features en una rama.
7. No abrir ni imprimir values/manifiestos ignorados o secretos.
8. Ninguna eliminacion de recursos, despliegue o posible coste nuevo se ejecuta
   sin un checkpoint explicito del propietario en ese momento.
9. Actualizar este fichero y `docs/estado-sencillo.md` al cerrar cada casilla.
10. Mismo fallo dos veces sin nueva evidencia causal: STOP y auditoria, no otra
    hipotesis.

## Plan finito

- [x] **H0. Auditar y corregir el objetivo.**
  - Confirmado: el baseline productivo sigue listo a nivel de Deployments; la
    aceptacion funcional completa mas reciente es historica y debe refrescarse.
  - Confirmado: el objetivo comercial es hibernar/reactivar clientes, no HA.
  - Confirmado al abrir H0: el restore era in-place y `cold-rebind` estaba
    deshabilitado.
  - Resultado: recovery avanzado congelado y este plan sustituye su continuacion.

- [x] **H1. Congelar un baseline funcional y el contrato minimo.**
  - [x] Preservar sin fusionar la rama/worktree `codex/recovery-closure` y sus tres
    ficheros tecnicos sin commit. Crear un worktree limpio
    `codex/client-hibernation` desde `origin/main`; no trasladar codigo por
    defecto, solo documentacion y piezas aceptadas por el mapa keep/remove. El
    worktree activo es `/Users/Shared/Gits/YenHubs-client-hibernation`, creado
    desde `origin/main=9c1b85be99a797c219022b0dd506b0be5ebd026b`.
  - [x] Hacer una aceptacion fria no destructiva del baseline actual: lobby/sala,
    login, audio, camaras, avatar, Admin, Spoke y bots baseline que formen parte
    de la oferta.
    - [x] Magic link real, sesion `info@virtualmente.com`, Admin y proyecto Spoke
      autenticados, sin guardar ni publicar contenido.
    - [x] Sala `VJopCY3` cargada con dos presencias; avatar GLB visible y cambio
      visual primera/tercera persona comprobado. El boton de asiento responde y
      rechaza correctamente cuando no hay un waypoint disponible a menos de 2 m.
    - [x] Dos clientes enumeraron y activaron sus microfonos. Cada cliente pudo
      silenciarse y reactivarse, y el otro reflejo ambos cambios en tiempo real;
      quedaron demostradas las dos direcciones del canal de audio. Bots publicos
      no forman parte del baseline comercial v1.
  - [x] Definir el contrato minimo `freeze-bundle-v1`: DB, `ret-pvc`, hashes,
    contratos, digests, commits, configuracion externa redactada y receta de
    infraestructura. Contrato en `docs/client-hibernation-design-v1.md`.
  - [x] Producir un mapa keep/remove exacto desde `origin/main`; ninguna pieza
    del recovery avanzado se incorpora por defecto. Los cuatro commits
    funcionales y sus tres ficheros locales quedan congelados.
  - [x] Revisar una sola vez `docs/client-hibernation-design-v1.md`: GO sin
    P0/P1/P2 residual tras corregir hashes, custodia, digests y bootstrap.
  - [x] Cierre: lista funcional aceptada sin mutar produccion, sala, Admin ni
    Spoke. H2 paso a ser la unica fase activa.

- [x] **H2. Implementar freeze y cold-rebind minimos.**
  - [x] El capturador conserva su salida historica y anade un modo
    `freeze-bundle-v1` que emite directamente inventarios portables; esta
    ampliacion causal evita generar y borrar volcados crudos dentro del bundle.
  - [x] Preservar con una prueba enfocada el orden ya correcto de `origin/main`: el
    bundle valido se publica antes de intentar reanudar los writers.
  - [x] Mantener un rollback automatico unico solo para resultados inequivocos;
    ante ambiguedad, parar con diagnostico y runbook manual corto.
  - [x] Permitir restaurar un checkpoint de origen sobre Namespace/PVC nuevos,
    autenticando por separado identidad de origen, identidad de destino y
    contenido, sin fingir que sus UID deben coincidir.
  - [x] Separar `preflight-greenfield` de `preflight-reactivation`.
  - [x] Cierre: sintaxis, ShellCheck y 51 gates de seguridad verdes. Focos:
    bundle `5/5`, materializacion `46/46`, greenfield `4/4`, target preflight
    `49/49`, creacion `49/49` y cold restore/fail-close `49/49`. No se ejecuto
    full ni GitHub y no se toco produccion, DigitalOcean o secretos.

- [x] **H3. Ensayar reactivacion sin crear recursos DO nuevos.**
  - [x] El ensayo aceptado `20260809-h3d` se ejecuto sobre Ubuntu 24.04 ARM64 y
    K3s `v1.35.5+k3s1`, en una VM Lima local sin mounts del host, endpoint
    publico, GitHub, DigitalOcean ni coste externo.
  - [x] El bundle conjunto restauro una DB con `356` relaciones, `94`
    migraciones y `17` hubs, mas `4` pares de medios —avatar, escena, proyecto
    Spoke y diferido—; los tres UUID activos quedaron presentes y byte-exactos.
  - [x] Origen y destino usaron identidades distintas de cluster, Namespace y
    ambos PVC. Los cinco writers terminaron `1/1`, sin lock de recovery
    residual, y pasaron las `14/14` comprobaciones del ensayo.
  - [x] El segmento local de reactivacion observado tardo `11 s`. Es una medida
    del laboratorio K3s, no un RTO prometido para recrear DigitalOcean, DNS,
    imagenes o navegadores.
  - [x] Los intentos H3a-H3c descubrieron causas distintas y corregibles
    —envolvente PostgreSQL 14, listas Kubernetes tipadas y preflight coordinado
    source/target—. H3d fue el unico candidato aceptado; no se repitieron bytes
    verdes ni se reabrio la matriz de recovery congelada.
  - Cierre: cold-rebind real local verde con UID nuevos y contenido de una sola
    fecha. La evidencia privada queda preservada en la VM; no se borra para
    fingir limpieza.

- [x] **H4. Validar e integrar una sola vez.**
  - [x] Focos aplicables, ShellCheck/Actionlint/Gitleaks y gate local integral.
    La unica invocacion `verify-project.sh --full` completo el bloque comun con
    recovery `865/865`, AUD-065, PostgreSQL real, Gitleaks y el resto de suites;
    se detuvo despues por faltar los remotos locales `upstream`, no por codigo.
    Tras corregir solo ese entorno se ejecuto una vez el tramo full-only exacto,
    sin repetir las cuatro horas ya verdes: Hubs `100/100` y build, navegador,
    capacidad `115/115`, manifiesto HCCE `68` recursos, bot orchestrator
    `154/154`, Dialog `2/2`, Photomnemonic `7/7`, Coturn, Spoke `68/68` y build,
    y Reticulum `461` tests + `5` propiedades, cero fallos.
  - [x] Resolver dos advisories nuevos descubiertos por el gate sin upgrade
    amplio: `ip-address 10.2.0 -> 10.3.1` y `postgrex 0.22.3 -> 0.22.4`.
    Ambos auditores quedan verdes y se repitieron solo sus componentes
    afectados. Hubs Cloud queda en `b0701ebdfef57ce3597ffaee7124b508b511c8c2`.
  - [x] Cost gate GitHub comprobado el 11 de agosto: plan GitHub Free, Actions
    billable USD 0, uso bruto USD 12.91 compensado integramente por el descuento
    incluido y `0/2000` minutos facturables. No se amplio el token ni se cambio
    ningun presupuesto.
  - [x] Publicar sin duplicar gates: PR Hubs Cloud `#23` y PR raiz `#16`, ambos
    draft, mediante commits `[skip ci]`; no se inicio ningun workflow automatico.
  - [x] Obtener un unico CI GitHub autoritativo terminal. El run manual
    `31518137826` fue cancelado externamente sin diagnostico. El run nuevo
    `31520065425` demostro la causa real: PostgreSQL 12/14 verde y el runner
    estatico perdio comunicacion durante ShellCheck porque `-x` cargaba muchas
    veces la libreria desde el arnes de 17.000 lineas; la medicion local alcanzo
    `16.214.080 KiB` RSS. Validar una vez el gate corregido: el arnes conserva
    todas las reglas salvo cinco diagnosticos de source-following y la
    libreria sigue analizandose completa y separadamente con `-x`.
    El job debe conservar las regresiones completas y un timeout de `360`
    minutos: `75` minutos era incompatible con la suite secuencial de unas
    cuatro horas y garantizaba un falso rojo aun despues de arreglar memoria.
    El candidato `d0fc186` demostro que PostgreSQL 12/14, Gitleaks, Actionlint,
    ShellCheck y `860/865` regresiones eran verdes. Los cinco rojos eran las
    cinco expectativas antiguas ya congeladas: exigian reentrada/rollback
    automaticos incluso cuando Linux solo podia demostrar una parada segura
    con writers a cero y lock retenido. No se cambio producto ni se reabrio ese
    coordinador. El oraculo ahora acepta exclusivamente rollback exacto o el
    estado fail-closed exacto, nunca una combinacion intermedia. Los tres focos
    afectados pasan `47/47`, `54/54` y `89/89`, mas sintaxis y ShellCheck. Falta
    La unica confirmacion remota de estos bytes nuevos, run `31546745988` sobre
    `09af04f`, termino verde el 12 de agosto: static-security, las `865`
    regresiones y PostgreSQL 12/14, sin cancelacion ni repeticion adicional.
  - [x] Fusionar por orden Hubs Cloud PR `#23` en `7de73e9` y despues el puntero
    raiz PR `#16` en `45faaf6`; no cambia Hubs.
  - [x] Cierre: candidato integrado en `origin/main`, documentacion sincronizada
    y ninguna mutacion de produccion. El checkout oficial no se sincronizo
    porque contiene la rama de investigacion y cambios locales preservados; no
    se sobrescribieron. La construccion de imagenes por digest pertenece al
    preflight de H5 inmediatamente anterior a cualquier rollout autorizado.

- [ ] **H5. Demostrar una hibernacion comercial completa.**
  - [x] **H5-A. Preparar la ventana sin mutar produccion ni generar coste.**
    - Trabajar localmente desde `codex/h5-preflight`; GitHub no es un bloqueo y
      no se abre CI durante la preparacion.
    - Inventariar en modo lectura la instancia, DNS y recursos facturables;
      separar claramente lo que se conserva, lo que se elimina y el coste
      residual esperado.
    - Comprobar que el procedimiento puede producir el checkpoint conjunto, el
      recibo y la segunda copia cifrada; validar custodia recuperable de los 13
      digests y del escrow opaco sin imprimir secretos.
    - Ejecutar solo preflights y dry-runs no mutantes. Entregar un paquete de
      ventana con orden, tiempos, rollback, criterio GO/STOP y lista exacta de
      recursos DigitalOcean afectados.
    - Cierre: paquete H5-B completo y comprensible. Solo entonces pedir una
      autorizacion concreta; no esperar a GitHub mientras se prepara.
    - Progreso `2026-08-12`: inventario runtime/DO/DNS, frontera de downtime,
      ensayo de cifrado y hoja de efectos completados. Los `12` digests unicos
      de los `13` contenedores estan en un layout OCI local; `214/214` blobs
      rehasheados y `12/12` referencias offline. GitHub Packages figura con USD
      `0` facturados y presupuesto USD `0` con parada de uso. Pendiente solo:
      Google Password Manager quedo confirmado como almacenamiento de cuenta,
      no solo local, y se fijaron referencias opacas de escrow. La copia local
      fuera de Dropbox mas la copia Dropbox cumplen el primer ciclo; un tercer
      destino es opcional. H5-A queda `10/10`; produccion no cambio y no se
      ejecuto CI.
  - [ ] **H5-B. Ejecutar la ventana comercial autorizada.**
    - Autorizacion y confirmacion manual de custodia recibidas el `2026-08-12`.
      La clave H5 se guardo en Google Password Manager. Produccion esta
      recuperada y verificada `12/12`, sin recovery lock; DigitalOcean no se
      ha retirado ni recreado.
    - [x] **H5-B0. Cerrar localmente las brechas del primer checkpoint real.**
      - El preflight completo `freeze-bundle-v1` quedo verde sobre el runtime
        live, incluida la excepcion checkpoint-only para el unico
        `RollingUpdate`, el bloque Reticulum process-local, repos historicos,
        `HA=false` y GVK/ReplicaSet reales. El generador opt-in
        `cold-rebind-legacy-absent-v1` produce el target greenfield legacy sin
        control plane durable; sus `32/32` tests estan verdes.
      - El primer checkpoint que entro en downtime escalo los cinco writers a
        cero y fallo antes del handshake `ready` del monitor. No produjo DB ni
        copia storage. Se reanudaron exactamente los cinco writers, se
        verificaron `12/12` Deployments y se retiro el lock exacto; no se toco
        infraestructura DO ni datos.
      - Evidencia causal: los LIST reales conservan GVK superior, pero omiten
        `apiVersion/kind` en `12/12` items Deployment, `67/67` ReplicaSet y
        `12/12` Pod. El monitor exigia esos campos por item y fallaba primero
        como `replicaset_inventory`. Ahora acepta solo el par ausente/null bajo
        un LIST tipado, mantiene WATCH/GET estrictos y rechaza cualquier GVK
        explicito falso. Positivo `46/46`, negativos `48/48`, sintaxis,
        ShellCheck y diff-check verdes; revision independiente GO.
      - Regla anti-loop cumplida: no hubo segundo checkpoint sobre los mismos
        bytes. El siguiente intento solo esta permitido por esta evidencia y
        el cambio causal verificado; si reaparece el mismo fallo, STOP.
    - [x] **H5-B1. Resolver el STOP del checkpoint sin otra tentativa.**
      - La unica repeticion causal se ejecuto con los ocho metadatos
        `FREEZE_*` completos. La captura redactada termino, pero el monitor
        volvio a fallar antes de `ready`, ahora con diagnostico allowlisted
        `checkpoint_writer_monitor_stage:baseline`; no se copiaron DB ni
        `ret-pvc` y no se publico ningun bundle.
      - El rollback automatico restauro exactamente los cinco writers. La
        reconciliacion posterior confirma `12/12` Deployments disponibles,
        recovery lock ausente y Lease libre. DigitalOcean, datos y DNS no se
        retiraron ni recrearon.
      - Esta evidencia invalida el GO operativo de H5-B0 aunque sus pruebas
        enfocadas sigan siendo validas: aceptar GVK omitido no era suficiente
        para que el monitor real completara todo su baseline.
      - **Hard stop:** no ejecutar otro checkpoint, no cifrar una copia
        incompleta y no borrar recursos DO. La siguiente accion admisible es
        una sola autopsia read-only del fallo `baseline` que produzca evidencia
        causal nueva y una decision `reparar estrechamente` o `simplificar la
        ruta`; no se autoriza otra hipotesis seguida de retry.
      - La autopsia read-only encontro una unica diferencia estructural en los
        siete Pods no writers: Kubernetes materializa `enableServiceLinks=true`
        y copia `imagePullSecrets` del ServiceAccount aunque ambas claves se
        omitan en el PodTemplate. Los `7/7` Pods coincidieron exactamente con
        sus ServiceAccounts; ownership, selectores y ReplicaSets eran exactos.
      - La reparacion solo normaliza el default booleano y separa la comparacion
        Template-Pod de la huella completa del Pod. La proyeccion
        ServiceAccount+imagePullSecrets se valida contra el objeto live, queda
        ligada al baseline por ReplicaSet y se exige tambien en LIST y WATCH.
        Un `false`, un secreto inicial distinto o un reemplazo con deriva
        fallan cerrado. Microfoco `49/49`, sintaxis, ShellCheck y diff-check
        verdes; revision adversarial final GO, cero P0/P1/P2.
      - Se descarto retirar el watcher: checks puntuales no detectarian una
        excursion `0 -> 1 -> 0` durante DB/storage. El watcher continuo se
        conserva. La autopsia cierra H5-B1 y autoriza un unico candidato final
        sobre estos bytes. Cualquier fallo de ese candidato produce STOP de la
        ruta automatica, sin otro parche/retry dentro de H5.
    - [x] **H5-B2. Ejecutar el candidato final y cerrar la ruta automatica.**
      - El candidato final completo de nuevo la captura redactada, pero el
        monitor volvio a fallar antes de `ready` con el mismo stage
        `baseline`. No se copiaron DB ni `ret-pvc`, no se publico bundle y no
        hubo borrado o recreacion de DigitalOcean.
      - El rollback restauro exactamente los cinco writers. Estado terminal:
        `12/12` Deployments disponibles, recovery lock ausente, Lease libre y
        cero bundles visibles.
      - Decision anti-loop: se cierra esta ruta, incluso aunque una autopsia
        adicional pudiera descubrir otra incompatibilidad. Las correcciones de
        GVK y defaults son validas, pero seguir normalizando el monitor no es
        una via finita para la necesidad comercial.
    - [x] **H5-B3. Implementar y validar la barrera temporal elegida.**
      - Decision del propietario: opcion segura `1`. Ventana de mantenimiento
        exclusiva con una barrera temporal que impida crear Pods writers,
        seguida de copia DB + `ret-pvc`, verificacion, retirada exacta de la
        barrera y resume controlado.
      - Reutilizar el contrato de admision existente; no crear otro subsistema
        ni reabrir el watcher que ya quedo cerrado por la regla anti-loop.
      - La barrera debe quedar ligada a Lease, lock, Namespace y operacion;
        demostrar server-side que rechaza un Pod writer antes del primer
        scale-down; mantenerse comprobable durante ambos streams y la
        publicacion; y quedar ausente con identidad exacta antes del resume.
      - Respuesta perdida, deriva, señal o retirada ambigua fallan cerrado. No
        se publica un bundle incompleto ni se reanuda si no puede demostrarse
        que la barrera dejo de aplicar de forma segura.
      - Implementacion local cerrada: policy y binding dedicados con
        `failurePolicy=Fail`, rechazo de `Pod CREATE`, `Pod UPDATE` y
        `pods/ephemeralcontainers UPDATE`, salvo el helper storage exacto y de
        solo lectura. La barrera se liga a Namespace, operacion, lock y Lease;
        los hijos revalidan esa capacidad durante DB y storage.
      - Dos latches armados antes de CREATE impiden liberar lock o Lease si el
        servidor pudo crear policy/binding pero falla el GET posterior. Solo
        objeto exacto o `NotFound` demostrado permiten limpiar; deriva o lectura
        ambigua quedan fail-closed.
      - Evidencia final sobre los bytes locales: matriz H5-B3 `73/73`, helper
        puro `8/8`, Bash/Node syntax, ShellCheck y diff-check verdes. La revision
        adversarial final dio GO con cero P0/P1/P2 y considero proporcionales los
        dos latches y la reconciliacion central.
      - No se ejecuto full, GitHub, Kubernetes real ni produccion: no eran gates
        de esta unidad local y no se repiten antes de una autorizacion concreta.
    - [x] **H5-B4. Ejecutar una unica ventana productiva con la barrera.**
      - Autorizacion expresa recibida el 12 de agosto de 2026 para crear y
        retirar temporalmente la policy/binding de admision, pausar los cinco
        writers, crear/validar el bundle y reanudar. No autoriza borrar DO.
      - Secuencia unica: preflight live -> crear/probar barrera server-side ->
        pausar cinco writers -> copiar DB y `ret-pvc` -> validar/publicar bundle
        -> retirar barrera por UID/RV -> confirmar ausencia -> reanudar.
      - Cualquier respuesta ambigua, deriva, señal o perdida de Lease/lock
        produce STOP fail-closed. En esta ventana no se borran aun recursos DO.
      - El primer preflight autorizado paro antes de Lease/lock/barrera porque
        se selecciono la copia privada historica de julio, que no contiene el
        discriminador `OVERRIDE_BOT_RUNNER_IMAGE`. Produccion permanecio
        `12/12`, sin Lease, lock, barrera ni bundle. No cuenta como ventana de
        downtime ni como fallo ambiguo.
      - Evidencia causal nueva: se reconstruyo un snapshot privado `0600` desde
        la fuente canonica, cambiando solo dominio, runner `No` y pins de imagen
        no secretos; valida `13/13` pares exactos contra el runtime live. Esta
        precondicion distinta autoriza un unico intento operativo, no otro ciclo
        de hipotesis.
      - Un segundo preflight con ese snapshot paro tambien antes de Lease porque
        el comando no incluia los UID esperados de Namespace y `ret-pvc`. Una
        auditoria estatica congelo el paquete completo y ambos UID se capturaron
        en el mismo contexto inmediatamente antes de la invocacion operativa.
      - La invocacion operativa capturo el inventario redactado y creo solo la
        policy; Kubernetes materializo defaults de API que el comparador no
        normalizaba y produjo `stage=quiescence code=fence-create`. El binding
        nunca existio, los writers nunca se escalaron y no hubo bundle.
      - Reconciliacion live: policy sin binding e inerte, lock inmutable presente
        y Lease ausente. Un rollback revisado adquirio Lease, revalido policy y
        lock, borro ambos exclusivamente por UID/RV, confirmo `NotFound` y dejo
        la Lease libre. Estado final `12/12`, cinco writers `1/1`, cero residuos.
      - Correccion local posterior: el comparador elimina solo los defaults
        exactos del API para policy (`Equivalent`, selectores `{}`, `paramKind`
        null y `reason` null); alternativas siguen rojas y binding sigue
        estricto. Node/test `15/15`, diff-check y revision adversarial GO, cero
        P0/P1/P2. No se hizo otro checkpoint.
    - [x] **H5-B5. Ejecutar el candidato corregido y reconciliar su STOP.**
      - Autorizacion continua recibida el 12 de agosto de 2026 para completar
        todo H5 dentro del paquete ya documentado. H5-B4 termino segura, pero
        sin bundle; H5-B5 reutilizo el snapshot privado validado `13/13` y los
        UID capturados inmediatamente antes.
      - El servidor acepto la policy, pero materializo tambien defaults en la
        binding (`matchPolicy=Equivalent` y `objectSelector={}`); el validador
        la rechazo con `stage=quiescence code=fence-create`. Los cinco writers
        permanecieron `1/1` y no se creo bundle.
      - La reconciliacion exacta retiro primero binding, despues policy y lock,
        y libero la Lease. Estado terminal confirmado: `12/12`, sin barrera,
        lock, Lease, bundle ni cambios DigitalOcean.
    - [x] **H5-B6. Ejecutar un unico candidato con preflight server-side.**
      - Cambio de metodo anti-loop: antes de cualquier CREATE persistente, el
        API server recibe policy y binding con `--dry-run=server`; las dos
        respuestas canonicalizadas deben pasar el validador exacto. Solo
        entonces se vuelve a probar ausencia y puede empezar el CREATE real.
      - Los tests focales pasan `49/49`; la regresion H5-B3 pasa `77/77`, mas
        Node, sintaxis, ShellCheck y diff-check. El API real devolvio
        `server_dry_run=pass` y policy/binding siguieron ausentes.
      - Ejecutar una sola vez con el snapshot `13/13` y UID live capturados en
        la misma invocacion. Una firma nueva produce STOP y reconciliacion, no
        otra cadena de defaults o retries.
      - Resultado: el preflight paso, policy y binding se crearon y limpiaron,
        pero el candidato paro en `probe`. Estado terminal `12/12`, cinco
        writers `1/1`, sin barrera, lock, Lease, bundle ni cambios DO.
      - Un smoke acotado demostro `probe-helper-denied`: la barrera bloqueaba
        tambien el helper permitido porque el API omite `request.subResource`
        en el CREATE base. Se corrigio con la forma CEL ya usada por el watcher:
        `!has(request.subResource) || request.subResource == ''`.
    - [x] **H5-B7. Ejecutar el candidato con la barrera probada live.**
      - Evidencia previa: helper puro `17/17`, smoke live completo PASS sin tocar
        writers, regresion H5-B3 `77/77`, sintaxis, ShellCheck y diff-check.
      - Ejecutar una sola vez. Una nueva firma conserva el STOP anti-loop; no
        borrar DigitalOcean hasta que el bundle y las dos copias esten verdes.
      - Resultado: supero barrera, probe y scale-down de los cinco writers; paro
        antes de iniciar `pg_dump` porque el monitor PostgreSQL no publico su
        primer barrido dentro de los 10 segundos de arranque. El rollback
        restauro cada writer y termino `12/12`, sin barrera, lock, Lease o bundle.
    - [x] **H5-B8. Ejecutar con plazo inicial separado de la frescura.**
      - El primer barrido recibe 30 segundos; despues de arrancar, la frescura
        sigue limitada a 10 segundos. El monitor emite solo una etapa enumerada
        si falla: identidad, Lease, lock, guard o fuente PostgreSQL.
      - Foco `stream-guards` `81/81`, sintaxis, ShellCheck y diff-check verdes.
        Ejecutar una sola vez; nueva firma produce STOP, no otro retry.
      - Resultado: el monitor completo su arranque, pero fallo durante el
        stream de `pg_dump`. El rollback exacto restauro los cinco writers y
        termino `12/12`, sin barrera, lock, Lease, bundle ni cambios DO.
    - [x] **H5-B9. Ejecutar la ruta freeze sin monitor PostgreSQL redundante.**
      - La barrera `failurePolicy=Fail` ya impide CREATE/UPDATE de Pods durante
        DB y storage, salvo el helper storage exacto. Si PostgreSQL desaparece,
        `pg_dump` falla y no hay bundle; no puede recrearse bajo la barrera.
      - La ruta freeze comprueba fuente PostgreSQL, Lease, lock y guard
        inmediatamente antes y despues del stream. Las rutas legacy/durable
        conservan su monitor continuo y sus regresiones.
      - Evidencia previa: H5-B3 `77/77`, hijos checkpoint `161/161`, sintaxis,
        ShellCheck y diff-check verdes. Ejecutar una sola vez; una firma nueva
        produce STOP, no H5-B10 automatico.
      - Resultado: el dump completo el stream, pero el validador agregado
        rechazo el contrato SQL critico. No se publico bundle. El rollback
        restauro los cinco writers y termino `12/12`, sin barrera, lock o Lease.
      - La autopsia read-only posterior confirmo PostgreSQL `12.19`, los tres
        schemas, `356` DDL, los tres COPY, marcador completo y hashes iguales
        para migraciones, relaciones, hubs, owned files y activos. Como el dump
        rechazado ya fue retirado y el error agregado no identifica el
        predicado, no existe evidencia para repetir el downtime.
    - [x] **H5-B10. Discriminar el predicado SQL sin otro checkpoint.**
      - Añadir solo diagnostico enumerado/redactado o una reproduccion
        read-only que conserve cero filas/valores. No ejecutar otro checkpoint
        productivo hasta identificar una diferencia concreta y probar su fix.
      - Resultado: PostgreSQL `12.19` termina el dump con el marcador seguido
        por un unico comentario vacio canonico `--`. El parser exigia que el
        marcador fuera la ultima linea no vacia y rechazaba el dump correcto.
      - El parser acepta solo cero o un footer canonico en la posicion exacta y
        sigue rechazando duplicados, tokens desparejados y SQL posterior. Foco
        `7/7`, dump real read-only completo PASS, Bash/ShellCheck/diff-check
        verdes. El temporal privado se retiro por borrado recuperable.
    - [x] **H5-B11. Ejecutar un checkpoint con el parser PostgreSQL 12 corregido.**
      - Un unico candidato bajo la autorizacion continua. Nueva firma produce
        STOP; no existe H5-B12 automatico.
      - Resultado: DB real verde con `356` relaciones, `94` migraciones, `18`
        hubs y `33` ficheros activos. Storage paro antes de crear su Pod porque
        el API omite las listas vacias `ingress` y `egress` del NetworkPolicy.
        Rollback `12/12`, writers `5/5`, cero barrera, lock, Lease o bundle.
    - [x] **H5-B12. Ejecutar tras el corte productivo y la canonicalizacion storage.**
      - El comparador acepta solo ambas listas vacias explicitas o ambas
        omitidas por el API. Rechaza omision parcial, `null` y reglas no vacias.
      - Evidencia: dry-run server-side real y foco storage `88/88`, mas Bash,
        ShellCheck y diff-check verdes. Reanudar desde preflight limpio bajo la
        autorizacion vigente, no dentro de la misma cadena productiva H5-B11.
      - No volver a pedir confirmacion entre hitos previstos. Solo STOP ante
        recurso nuevo, coste/topologia distintos, secreto no recuperable,
        perdida/ambiguedad de estado o riesgo para datos/recursos ajenos.
      - Resultado: DB real verde; storage creo su helper exacto pero su monitor
        local no completo el barrido inicial. Rollback exacto `12/12`, writers
        `5/5`, lock/Lease ausentes y cero bundle. Dos policies huerfanas exactas
        de B11/B12, sin Pods consumidores, se retiraron por UID/RV y quedaron
        `NotFound`; DigitalOcean no cambio.
    - [x] **H5-B13. Ejecutar la ruta freeze sin monitor storage redundante.**
      - La barrera ya impide CREATE/UPDATE de todo Pod salvo el helper exacto de
        solo lectura. La ruta freeze exige helper, policy, PVC y consumidores
        exactos inmediatamente antes y despues del tar; legacy/durable conservan
        su monitor continuo.
      - Evidencia local final: barrera `77/77`, hijos checkpoint `161/161`,
        Bash, ShellCheck y diff-check verdes. Ejecutar un unico checkpoint desde
        preflight limpio y continuar automaticamente si publica bundle valido.
      - Resultado: DB verde; storage termino con `stream status=1`. Rollback
        `12/12`, writers `5/5`, barrera/lock/Lease ausentes y cero bundle. La
        policy deny-all residual sin Pods se retiro por UID/RV y quedo NotFound.
        Un `tar|gzip` read-only sobre el mismo `ret-pvc` termino `0/0`, por lo
        que los bytes no son la causa.
    - [x] **H5-B14. Discriminar supervisor frente a limite post-stream.**
      - El hijo emite solo `storage_backup_child_stage:<enum>` al fallar; no
        incluye objetos, nombres, valores ni errores crudos. Bash, ShellCheck y
        diff-check pasan. Un unico candidato puede usar esta evidencia; no se
        permite otra hipotesis ni retry sin cambiar el diagnostico causal.
      - Resultado: enum exacto `helper-cleanup`. DB, stream, archivo y postcheck
        ya habian pasado; el DELETE Foreground del Pod supero 180 s. Rollback
        `12/12`, policy residual exacta retirada y DO intacto.
    - [x] **H5-B15. Ejecutar con borrado normal acotado del helper.**
      - Solo el helper sin dependientes usa `Background`, UID preconditionado,
        espera NotFound y `terminationGracePeriodSeconds=1`; no usa force. Todos
        los demas borrados siguen Foreground.
      - Smoke live sin downtime: NotFound en `4 s`, cero residuos y writers
        `5/5`. Helper puro `17/17`, matriz H5-B3 `77/77`, Bash, ShellCheck y
        diff-check verdes.
      - Resultado: STOP pre-downtime en `probe-helper-denied`. El constructor
        shell del probe no incluia el grace=1 ya presente en policy/Pod/helper
        Node. Cero writer mutation y estado final `12/12` sin residuos.
    - [x] **H5-B16. Ejecutar con ambos constructores exactos.**
      - Regresion explicita del probe shell y matriz final `78/78`; helper Node
        `17/17`, Bash, ShellCheck y diff-check verdes. Un unico candidato; si
        publica, continuar a las dos copias cifradas sin pedir confirmacion.
      - Resultado: bundle conjunto publicado en
        `output/checkpoints/h5-b16-20260813-022800`. Contiene el inventario
        exacto de 9 ficheros, DB validada (356 relaciones, 94 migraciones,
        18 hubs y 33 activos) y storage validado (33 pares completos, cero
        diferidos). La validacion final del manifiesto paso; estado live
        `12/12`, writers `5/5`, barrera/lock/Lease/helper/policy ausentes.
    - [x] Demostrar tambien una receta estandar, generada y aplicable para el
      target greenfield compatible con `runtime_generation=legacy-absent`.
      El perfil opt-in parte del template actual, conserva los controles
      comunes y retira solo los recursos durable incompatibles; no se ha
      aplicado aun a DOKS porque eso pertenece a la ventana posterior al bundle.
    - [x] **H5-B17. Crear y verificar dos copias cifradas independientes.**
      Ligar ambas a hash/tamano, reabrirlas y probar
      que Dropbox informa `isUploaded=1`, una revision remota y una lectura
      posterior completa. Congelar tambien cuenta y UUID exactos del cluster,
      Load Balancer y dos volumenes; nunca borrar por nombre ni asumir cascada.
      - Inventario live refrescado y congelado en expediente privado `0600`:
        coincide exactamente con una cuenta, un cluster/nodo en `ams3`, un
        Load Balancer, dos volumenes de `10 GiB`, un firewall ajeno a conservar
        y dos firewalls DOKS solo para reconciliar. Los destinos local fuera de
        Dropbox y Dropbox estan preparados; falta recuperar la clave H5 para
        cifrar, reabrir y rehashear ambas copias.
      - Progreso: paquete cifrado de `1,455,943,712` bytes creado con bundle y
        custodia OCI. La copia local descifra y rehashea; Dropbox confirma
        `isUploaded=1`, `isUploading=0`, identificador y version remotos, y la
        lectura completa posterior coincide byte a byte. Google vacio el
        portapapeles durante esa lectura: falta solo repetir el descifrado
        post-upload con la clave recopiada y emitir/validar el recibo `0600`.
      - Cierre: ambas copias descifraron y rehashearon; Dropbox confirmo
        `isUploaded=1`, `isUploading=0`, identidad/version y readback completo.
        Recibo externo `freeze-bundle-receipt-v1` valido, privado `0600`, con
        dos copias y `13/13` imagenes. `preflight-greenfield.sh` PASS completo.
    - [x] **H5-B18. Retirar solo los recursos DigitalOcean inventariados.**
      - Gate final: `12/12`, writers `5/5`, lock ausente, Lease libre, endpoint
        DOKS asociado exactamente a un LB, dos volumenes y cero snapshots.
      - `delete-selective` retiro cluster/nodo y LB. Tras espera finita, los dos
        volumenes seguian exactos y desconectados; se borraron manualmente por
        sus UUID autorizados. Resultado reconciliado: cluster `0`, Droplets `0`,
        LB `0`, volumenes `0`, firewalls DOKS `0`; `voice-chat` sigue presente.
    - [ ] **H5-B19. Recrear, restaurar y aceptar la instancia.**
      - Reusar exactamente `ams3`, HA false, un nodo `s-4vcpu-8gb`, LB
        `REGIONAL_NETWORK` y dos PVC de `10 GiB`; coste mensual estimado USD 65.
        Cualquier diferencia produce STOP antes de crear o continuar.
      - [x] Version sustituta autorizada: `1.34.10-do.1`, misma rama minor que
        la retirada `1.34.8-do.2`.
      - [x] Cluster recreado con la topologia exacta autorizada. Cert-manager,
        IngressClass e Issuer instalados; LB regional activo y PVC nuevos Bound.
      - [x] Perfil greenfield legacy generado/aplicado: `12/12` Deployments
        exactos, activos no-writer `1/1`, cinco writers `0/0`, sin lock ni Lease.
      - [x] Preflight cold-rebind real PASS. La excepcion de pull secret queda
        limitada al target frio y conserva el contrato estricto anterior;
        focos `52/52` y `89/89` verdes.
      - [x] Actualizar en IONOS los cuatro A (`meta-hubs.org`, `stream`,
        `assets`, `cors`) de `143.244.196.227` a `165.245.201.85`; esperar
        certificados Ready y cero Pods `cm-acme-http-solver-*`.
        - Los cuatro A autoritativos y publicos apuntan al LB nuevo. El
          hairpin del LB regional se resolvio solo para cert-manager mediante
          el Service interno; resultado `4/4` certificados Ready y cero solver
          Pods, sin cambiar el trafico publico.
      - [ ] Consolidar una unica version final H5 de root y Hubs Cloud, revisar
        el diff completo y ejecutar exactamente una vez
        `./scripts/verify-project.sh --full` sobre esos bytes. No ejecutar antes
        el gate normal ni repetir bloques verdes. Este gate es dependencia del
        siguiente restore productivo.
      - [ ] Repetir el restore coordinado con confirmacion nueva y ejecutar
        verificador live mas navegador frio. El intento previo no escribio DB
        ni medios: fallo en `baseline`, libero lock/Lease y dejo writers `0/0`.
        - El baseline live se cerro sin relajar seguridad: Pods con pull secret
          declarado por su ReplicaSet quedan ligados a esa plantilla, y las
          huellas `GET/LIST` se comparan canonicalmente sin cambiar el contrato
          historico. Foco `51/51` y diagnostico live PASS.
        - Un intento alcanzo el reset de PostgreSQL pero el stream no comenzo;
          dejo la DB vacia y lock retenido. El limpiador stale se amplio de
          forma estrecha para `cold-rebind` y retiro ese lock sin reanudar.
        - El candidato posterior paro antes del reset con
          `database_restore_stage:quiescence`. Estado actual exacto: DB vacia,
          cinco writers `0`, cero Pods writer/helper, siete servicios auxiliares
          `1/1`, certificados `4/4`, Lease libre/sin holder y lock `cold-rebind`
          retenido. La autopsia read-only confirma contratos `5/5`, cero runner,
          LIST/WATCH runner valido y PostgreSQL Ready; no existe deriva material
          persistente. El hijo emite ahora una unica subetapa allowlisted de
          quiescence y el foco dirigido pasa `51/51`. Tras consolidar y pasar
          el unico full se permite un solo candidato nuevo, precedido por la
          limpieza exacta del lock; cualquier nueva firma produce STOP con su
          guard concreto, sin tercer intento.
    - [ ] Antes de recrear, fijar region, `HA=false`, nodo, LB, volumenes y un
      techo mensual aprobado; cualquier diferencia produce STOP.
    - La autorizacion expresa sobre el paquete H5-A ya esta recibida: crear
      checkpoint fresco, segunda copia cifrada y expediente; eliminar solo los
      recursos DO aprobados y comprobar el coste residual real. No volver a
      pedirla mientras no cambien recursos, cuenta, region, coste o efectos.
    - La clave H5 es una entrada nueva y su custodia de cuenta quedo confirmada.
      La alerta general de Google Password Manager no se convierte en un
      bloqueo ajeno a este ciclo; si el propio gestor identifica la entrada H5
      como comprometida, rotarla antes del checkpoint sin imprimirla.
    - Recrear, restaurar y ejecutar verificador live mas navegador frio.
    - Si hiciera falta construir una imagen, GitHub se usa una vez para ese
      artefacto por digest; el resto de la operacion no espera gates remotos.
  - Cierre: metaverso funcional con datos y medios exactos, tiempo medido,
    inventario economico y runbook ejecutable por otra sesion.

- [ ] **H6. Cerrar recovery y volver a features.**
  - Mover mejoras no necesarias de recovery a backlog sin mantenerlas como
    bloqueadores.
  - Cierre: esta meta marcada completa, documentacion/runbook sincronizados y
    lista de features candidatas entregada al propietario. Elegir y abrir la
    siguiente feature ocurre despues, en una meta separada.

## Prompt exacto para la meta

```text
Retoma YenHubs exclusivamente desde
/Users/Shared/Gits/YenHubs-client-hibernation/docs/active-goal-plan-2026-07-18.md
en el worktree `codex/h5-preflight` y ejecuta la primera casilla
pendiente. El objetivo es demostrar un ciclo comercial finito
de hibernar una instancia, eliminar sus recursos facturables de DigitalOcean y
reactivarla despues en infraestructura nueva con Namespace/PVC nuevos, DB y
ret-pvc exactos y aceptacion funcional real. No continues el recovery avanzado
congelado, no repitas evidencia verde y no añadas protocolos, matrices, HMAC,
monitores o infraestructura que no sean imprescindibles para ese ciclo.
Actualiza el plan y docs/estado-sencillo.md al cerrar cada hito. GitHub se usa
solo para una confirmacion terminal del candidato; una ejecucion cancelada sin
diagnostico no se convierte en un loop de parches ni cuenta como fallo del
producto. La autorizacion H5-B ya cubre el checkpoint con downtime, las dos
copias cifradas, la retirada por UUID del DOKS/nodo, Load Balancer y dos
volumenes actuales, y la recreacion de la misma topologia de bajo coste. No
vuelvas a solicitarla si el paquete coincide exactamente; aplica STOP y pide
una nueva confirmacion solo si cambia algun recurso, cuenta, region, precio,
efecto o frontera de secretos.
El runtime live esta `12/12`, sin recovery lock, Lease ni barrera. H5-B11
confirmo la DB completa y aislo el default storage sin publicar bundle. La
canonicalizacion pasa `88/88`; H5-B12 queda pendiente tras este corte
productivo. No borres
recursos DigitalOcean; primero deben existir bundle valido, hashes, recibo y dos
copias cifradas verificadas.
```
