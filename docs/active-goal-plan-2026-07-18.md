# Meta activa: hibernar y reactivar una instancia de cliente

Ultima revision: **12 de agosto de 2026 (Europe/Madrid)**

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
    - Autorizacion recibida el `2026-08-12`. Estado: preflight previo al primer
      efecto; falta confirmacion manual de Google y guardar la clave H5 del
      portapapeles en Google Password Manager. Produccion sigue intacta.
    - Con autorizacion expresa sobre el paquete H5-A: crear checkpoint fresco,
      segunda copia cifrada y expediente; eliminar solo los recursos DO
      aprobados y comprobar el coste residual real.
    - Antes del primer efecto, comprobar de forma redactada que la alerta
      general de Google Password Manager no afecta a las entradas H5; rotar
      cualquier entrada afectada o aplicar STOP.
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
en el worktree `codex/client-hibernation` y ejecuta la primera casilla
pendiente. El objetivo es demostrar un ciclo comercial finito
de hibernar una instancia, eliminar sus recursos facturables de DigitalOcean y
reactivarla despues en infraestructura nueva con Namespace/PVC nuevos, DB y
ret-pvc exactos y aceptacion funcional real. No continues el recovery avanzado
congelado, no repitas evidencia verde y no añadas protocolos, matrices, HMAC,
monitores o infraestructura que no sean imprescindibles para ese ciclo.
Actualiza el plan y docs/estado-sencillo.md al cerrar cada hito. GitHub se usa
solo para una confirmacion terminal del candidato; una ejecucion cancelada sin
diagnostico no se convierte en un loop de parches ni cuenta como fallo del
producto. Detente antes de tocar
produccion, borrar recursos, exponer secretos o generar un posible coste y pide
confirmacion concreta para esa frontera.
```
