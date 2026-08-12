# HISTORICO: estado del recovery avanzado congelado el 9 de agosto de 2026

Este documento se conserva solo como evidencia. No es una fuente de reanudacion.

# Estado sencillo anterior de YenHubs

Última actualización: **9 de agosto de 2026**

Estado actual: **el proyecto sigue bien orientado. `execute` ya está construido
localmente; positivos, takeover, respuestas perdidas y deriva están verdes.
Faltan tres grupos finitos antes de poder dar P1.4 por terminada**.

Progreso global único: **aproximadamente 45% de la meta completa**. Es una
estimación de trabajo, no una promesa de fecha.

El `8 de 23` se conserva únicamente como ledger de casillas: no se convierte en
porcentaje porque una casilla grande y una pequeña no pesan lo mismo. La casilla
grande actual, P1.4 recovery, está aproximadamente al **85%**, pero ese dato
solo describe recovery, no todo el proyecto. Si antes se comunicó `60–70%` como
porcentaje del proyecto completo, queda corregido: no estaba ligado al alcance
completo actual y no debe usarse para comparar progreso.

El porcentaje global solo se actualizará al cerrar una casilla completa, no por
cada test, revisión o hipótesis. Es menor que el de recovery porque todavía
faltan builds, ensayo aislado, la ventana segura de producción y la aceptación
visible completa. La lista y el orden viven únicamente en
`docs/active-goal-plan-2026-07-18.md`.

## Respuesta corta

No hay que rehacer el metaverso. La versión anterior sigue siendo el baseline
de producción y no la hemos sustituido durante esta auditoría.

El atasco estaba en la capa que crea una copia completa y vuelve a encender
Reticulum y los bots si algo falla. El PR `#15` repitió los mismos cinco fallos
en cuatro pruebas largas. Está congelado y **no se fusionará**.

Ya no vamos a seguir publicando hipótesis en GitHub. El nuevo método es:

```text
diseño revisado
  -> implementación local pequeña
  -> pruebas enfocadas locales
  -> un full local sobre un SHA congelado
  -> un único CI GitHub de confirmación
```

GitHub no vuelve a ser una espera de 17 horas. Esas 17 horas eran el intervalo
de una automatización que miraba el run, no una limitación de GitHub.

## Qué funciona y qué falta demostrar

La aceptación de julio registró sala, login, Admin, Spoke, audio, español,
cámaras, avatares, sitting básico y bots/IA básicos. La última comprobación
read-only vio 12/12 servicios listos. Eso confirma que el baseline sigue vivo,
pero no sustituye la aceptación final de la versión nueva.

El código nuevo de sitting exclusivo, bots aislados, privacidad y recovery ya
existe en las ramas base. Todavía faltan sus imágenes definitivas, ensayo
aislado, despliegue y prueba real completa.

## El problema concreto y la solución

El checkpoint copia dos cosas inseparables:

- PostgreSQL: usuarios y metadatos;
- `ret-pvc`: escenas, proyectos Spoke, avatares, thumbnails y medios.

Al empezar, detiene cinco servicios que pueden escribir. El diseño anterior
intentaba averiguar automáticamente qué ocurrió incluso si se perdió una
respuesta o terminó un monitor. Esa reconstrucción es la parte que se hizo
demasiado compleja y produjo el loop.

El sucesor conserva las protecciones importantes: copia DB+medios, Lease,
lock, orden seguro, CAS exacto, fence, monitores durante la copia y
fail-closed. Retira solo la segunda pasada que intenta devolver autoridad
después de una respuesta ambigua.

Si todo es claro, el camino normal vuelve a encender automáticamente los cinco
servicios. Si una respuesta es ambigua, deja el lock puesto y usa un comando
manual trackeado con dos pasos: `plan` de solo lectura y `execute` con una
confirmación exacta y caducable.

La auditoría descubrió una necesidad que el plan anterior había prohibido: tras
perder el proceso o el ordenador, el lock actual no recuerda qué cinco objetos
había antes. Sin ese dato, ningún runbook puede recuperarlos con exactitud.

La excepción mínima es guardar **un inventario redactado dentro del mismo lock
que ya existe**. No crea otro servicio, objeto, monitor o protocolo. Guarda la
identidad del Namespace/PVC original, identidades y escalas. Una firma HMAC
demuestra además que las configuraciones siguen siendo las mismas sin guardar
templates, valores, tokens, hashes públicos de credenciales o Secrets. Restore y
la rotación no cambian su formato.

El HMAC necesita un keyring privado fuera del repositorio. Es una carpeta
append-only de records inmutables: no tiene clave activa automática, registry ni
rotación online. Cada copia nueva indica explícitamente un UUID público y cada
lock antiguo conserva el suyo. Un comando crea el candidato privado sin mostrar
la clave; se guarda cifrado fuera del host, se restaura y solo entonces se
importa. Si esa copia falta, cambia o no coincide, el sistema se detiene sin
tocar los servicios.

## En qué estamos exactamente

```text
[HECHO] Auditoría general y plan finito
[HECHO] Rama limpia desde main; PR #15 congelado
[HECHO] Diagnóstico detenido sin inventar una causa
[HECHO] Diseño reducido aprobado por seguridad y coherencia
[HECHO] Keyring y autoridad HMAC redactada integrados y revisados
[HECHO] Reentrada ambigua retirada; camino normal y fail-closed probados
[HECHO] Crear el plan manual de solo lectura y su confirmación exacta
[HECHO] Deriva post-takeover: 14/14 casos nuevos, producto inmóvil
[AHORA] Ejecutar solo el grupo de señales TERM (6 casos)
[SIGUE] Validar localmente una vez y confirmar una vez en GitHub
[DESPUÉS] Imágenes, ensayo aislado, copias, rotación y rollout
[FINAL] Prueba real completa, copia final y volver a nuevas features
```

Las revisiones encontraron y cerraron estos defectos antes de programar:

1. la excepción del inventario no figuraba en el plan;
2. no estaban definidas las generaciones admisibles tras cada escala;
3. faltaba identidad suficiente del fence durable;
4. la confirmación manual no enumeraba exactamente qué estado firmaba;
5. los specs reales contienen checksums derivados de credenciales, así que se
   sustituyó su SHA público por HMAC privado para evitar un oracle.

La implementación queda fijada hasta ahora en cuatro commits locales: `6d2b0f9`
(helper/keyring), `75ab970` (lock, autoridad, hijos y monitores) y `3a6d6ad`
(reducción automática), más `0e33acb` (`plan` manual). El camino normal detiene
y reanuda los cinco writers
una sola vez, con CAS y generaciones exactas, parent último y publicación al
final. Ante respuesta perdida, JOIN ambiguo o deriva, no intenta una segunda
pasada: conserva lock/Lease/fence y pide recuperación manual. Restore mantiene
su handoff y receipts exactos. Los focos de CAS, terminal, durable, restore y
process-local, ShellCheck, sintaxis, Gitleaks y cuatro revisiones independientes
quedaron limpios: **0 P0/P1/P2**.

El subcomando `plan` ya está trackeado y probado. Solo lee Kubernetes: valida
dos veces el mismo estado, crea una fotografía temporal privada `0600`, emite
un resumen redactado y una confirmación exacta que caduca. No adquiere Lease,
no escala, no parchea y no borra nada. Pasan sus escenarios normal y durable,
el contrato canónico, `21` clases fail-closed, redacción y una señal TERM tardía
sin residuos; dos revisiones independientes quedaron en **0 P0/P1/P2**.

Esto todavía no cierra P1.4. `execute` ya implementa la toma exacta de Lease,
normalización a cero, helper/runner/fence, reanudación ordenada y liberación
terminal. Sus tres escenarios normales pasan `48/48`; takeover está `16/16`.

Las 21 fronteras de respuesta perdida están cerradas por evidencia disjunta. La
ejecución limpia fijó 14 de los 19 casos retry; después se corrigieron solo los
cinco oráculos afectados y la selección focal terminó `50/50` contando los 45
controles comunes. No se repitieron los 14 verdes ni takeover/Lease-release.

La única pasada de deriva terminó `59/59` (`45` controles comunes + `14/14`
casos nuevos) en `270,69` segundos. Cada deriva se produjo después del takeover
y antes del primer CAS; `execute` paró en `pre-mutation-revalidation`, conservó
lock/Lease y no escaló, publicó ni ejecutó una mutación de negocio. El grupo
queda congelado y no se repetirá con estos bytes.

Después faltan tres grupos ya enumerados: señales TERM `6`, redacción `2` y
cierre terminal `6`, seguidos de la aceptación local final. Todavía no se
autoriza un full largo, GitHub ni producción.

## ¿Estamos en loop o repitiendo trabajo?

No hay un loop técnico activo, pero hoy sí hubo una repetición accidental: dos
agentes arrancaron el mismo foco sobre el mismo harness. Se detectó, se pararon
y sus resultados se descartaron. La pasada posterior sobre un único hash
congelado es la única que cuenta.

Desde ahora se usa este ledger:

- `plan`: cerrado; no repetir;
- positivos de `execute`: `48/48`, cerrados;
- takeover: `16/16` por grupos disjuntos, cerrado;
- lost-response: `21/21` por grupos disjuntos, cerrado;
- drift: `14/14`, cerrado y congelado;
- TERM/redacción/terminal: todavía no ejecutados;
- full local y GitHub: una sola vez al final sobre el SHA congelado.

Un cambio solo del oráculo no vuelve a ejecutar producto ya demostrado salvo que
la aserción modificada lo afecte. No se añadirá otra matriz, receipt, monitor,
objeto Kubernetes ni fase de recovery.

## ¿Cuánto queda?

Seguimos en el **bloque 1 de 5**, recuperación. El contador continúa en **8/23**
porque P1.4 es una sola casilla grande y aún no está cerrada.

Para P1.4 queda: ejecutar 14 casos aún no probados y hacer la
aceptación/revisión local. Si no aparece un defecto productivo nuevo, es una
cantidad de trabajo de varias horas locales, no otra campaña de días ni una
espera de GitHub.

Para terminar toda la meta quedan después cuatro bloques: regresiones visibles
pequeñas, builds/ensayo aislado, ventana segura de checkpoints+rotación+rollout y
aceptación real. Son 15 casillas en total, así que el proyecto completo todavía
requiere varias sesiones y una ventana controlada de producción; no está a unos
minutos de terminar, pero el camino es finito y ya no depende de ciclos de 17
horas.

## Lo que queda, agrupado

1. **Recovery:** implementar `execute`, validar localmente y fusionar el sucesor
   con un solo CI final.
2. **Cliente visible:** añadir regresiones pequeñas de tercera persona y español.
3. **Release:** construir Hubs, Reticulum, bot parent y bot runner en Actions,
   fijar sus digests y ensayarlos en Linux efímero sin recursos DO nuevos.
4. **Ventana segura:** checkpoint DB+medios, rotar credenciales potencialmente
   expuestas y crear el segundo checkpoint.
5. **Rollout y aceptación:** publicar sitting correcto en Spoke; desplegar
   servidor antes que cliente; probar desktop/móvil, login, audio, español,
   cámaras, avatares, dos usuarios sentándose, bots `0/5/10`, IA privada,
   Admin y Spoke; hacer checkpoint final.
6. **Handoff:** elegir una sola feature nueva, por ejemplo proveedor de
   avatares, nuevas capacidades de bots, VR o escala.

## Qué no bloquea esta meta

No vamos a mezclar ahora upgrades masivos, `upstream/master`, HA/HPA,
certificación de 10.000 usuarios, VR físico, un SaaS de avatares o una
modernización total de Spoke. Tampoco se añadirá un parser GLB backend completo
salvo que se abra el servicio a usuarios no confiables o se prepare un evento
público.

Estas cosas pueden ser metas posteriores; no hacen falta para dejar usable y
actualizable la plataforma definida.

## Producción, credenciales y dinero

- Producción no se ha modificado en esta fase.
- PR `#15` sigue congelado y no se ha lanzado otro Actions.
- La auditoría añadió **USD 0**.
- La topología existente se estima en unos **USD 65/mes**, antes de impuestos o
  consumos variables; no se creará un recurso DigitalOcean sin un cost gate.
- Antes de cualquier Actions se comprobará en solo lectura que el importe
  facturable posible es USD 0.
- Unos valores privados aparecieron en una terminal interna. No se volverá a
  abrir ni imprimir ese fichero; las credenciales representadas se rotarán de
  forma coordinada después del primer checkpoint y antes del rollout.

## Cuándo se considerará terminado

No basta con Pods `Ready` o un HTTP 200. La meta termina cuando recovery y CI
estén verdes, las cuatro imágenes tengan procedencia/digest, existan las tres
copias conjuntas, producción pase el verificador sin fallos ni warnings y un
navegador frío demuestre todas las funciones visibles. Entonces se cierra esta
meta y empieza una sola feature nueva.
