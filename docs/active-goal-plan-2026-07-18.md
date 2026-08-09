# Meta activa: hibernar y reactivar una instancia de cliente

Ultima revision: **9 de agosto de 2026 (Europe/Madrid)**

Este fichero es la unica fuente de orden y estado. La explicacion para el
propietario esta en `docs/estado-sencillo.md`.

## Decision de la auditoria

La plataforma funcional de YenHubs no se rehace. Produccion conserva el
baseline `process-local`, los gitlinks de Hubs/Hubs Cloud no se cambian y el PR
raiz `#15` permanece congelado, sin fusionar.

La linea local de recovery avanzado tambien queda **congelada**. No ejecutar sus
grupos drift, TERM, redaccion, terminal, full o GitHub; no publicar ni desplegar
`recover-checkpoint-backup.sh execute`, la autoridad HMAC/keyring o sus matrices
hasta que una necesidad futura independiente los justifique.

La razon es de producto: el requisito del propietario no era crear un sistema
de alta disponibilidad ni resolver automaticamente cualquier respuesta ambigua
de Kubernetes. Era poder detener una instancia de cliente durante semanas o
meses, eliminar los recursos facturables de DigitalOcean y reactivarla despues
sin una reconstruccion artesanal.

El runbook documenta `freeze -> borrar DOKS -> recrear`, pero el restore actual
rechaza `cold-rebind` y exige los UID originales del Namespace y del PVC. Esos
UID cambian al recrear el cluster. Cerrar esa brecha es ahora la prioridad.

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
  - Confirmado: el restore actual es in-place y `cold-rebind` esta deshabilitado.
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
    Spoke. H2 pasa a ser la unica fase activa.

- [ ] **H2. Implementar freeze y cold-rebind minimos.**
  - Preservar con una prueba enfocada el orden ya correcto de `origin/main`: el
    bundle valido se publica antes de intentar reanudar los writers.
  - Mantener un rollback automatico unico solo para resultados inequivocos;
    ante ambiguedad, parar con diagnostico y runbook manual corto.
  - Permitir restaurar un checkpoint de origen sobre Namespace/PVC nuevos,
    autenticando por separado identidad de origen, identidad de destino y
    contenido, sin fingir que sus UID deben coincidir.
  - Separar `preflight-greenfield` de `preflight-reactivation`.
  - Cierre: cambios pequenos, revisados y con pruebas enfocadas; sin GitHub ni
    produccion.

- [ ] **H3. Ensayar reactivacion sin crear recursos DO nuevos.**
  - Restaurar el bundle en Namespace/PVC nuevos y aislados sobre la capacidad ya
    pagada, o en Linux efimero local cuando la semantica sea equivalente.
  - Probar DB + medios juntos, migraciones, UUID activos, escenas, avatares y el
    runtime baseline; retirar el entorno de ensayo solo mediante el mecanismo
    recuperable autorizado por las reglas del proyecto.
  - Medir tiempo real y registrar el RTO observado; no prometerlo antes.
  - Cierre: un cold-rebind real verde con UID nuevos y sin mezclar fechas.

- [ ] **H4. Validar e integrar una sola vez.**
  - Focos aplicables, ShellCheck/Actionlint/Gitleaks y un unico
    `verify-project.sh --full` sobre el candidato congelado.
  - Un PR coherente y un unico CI GitHub autoritativo, solo si el cost gate
    confirma importe facturable posible de USD 0.
  - Fusionar por orden subrepositorios y punteros solo si realmente cambian.
  - Cierre: `main` limpio, documentacion sincronizada e imagenes necesarias por
    digest.

- [ ] **H5. Demostrar una hibernacion comercial completa.**
  - Con ventana expresamente aprobada: checkpoint, segunda copia cifrada,
    expediente separado, custodia recuperable de los 13 digests, inventario de
    DNS/recursos, escrow opaco del conjunto completo de credenciales con prueba
    fechada de lectura y prueba de descifrado/restaurabilidad.
  - Eliminar solo los recursos DO aprobados y verificar el coste residual real;
    nunca asumir que borrar el cluster elimina todo.
  - Recrear, restaurar y ejecutar verificador live mas navegador frio.
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
una sola vez para confirmar el candidato final. Detente antes de tocar
produccion, borrar recursos, exponer secretos o generar un posible coste y pide
confirmacion concreta para esa frontera.
```
