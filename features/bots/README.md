# Bots en YenHubs

## Estado y contrato

La arquitectura candidata usa Node `ghost` como único runner productivo y
autenticado. Chromium se conserva solo como diagnóstico browser legacy/local
sin `--runner`: el renderer no recibe `BOT_RUNNER_ACCESS_KEY`, no puede autenticarse
contra Reticulum endurecido, no cuenta para readiness y nunca debe recibir la
clave por URL ni estado cliente. Ghost publica avatares y rutas por Phoenix/NAF
sin renderizar la sala, mientras Reticulum conserva la autoridad sobre
identidad, spawn, actualizaciones y comandos.

> Estado: `AUD-075` está integrado en la fuente Cloud final
> `5392495b077249edcedfb3092551201645f648f1`; sus PR `#11`/`#12` y CI están
> verdes. Todavía no se ha construido por Actions el par de imágenes, desplegado
> ni atestado en staging/live. Por ello el rollout público sigue bloqueado hasta
> cerrar `AUD-065`/`AUD-078`, fijar ambos digests, desplegar la topología
> generada y superar los gates live de `deployment/README.md`. La certificación
> física de capacidad es una campaña futura separada.

El corte usa Hubs `674ece411691` y Hubs Cloud
`5392495b077249edcedfb3092551201645f648f1`, que incluye el baseline
`0f151eb88da1` de fencing y aprobación. Pasan 128/128 pruebas del orquestador,
30/30 del generador con 58 recursos, 45/45 del verificador de Pods runner,
19/19 del pull/configuración, 18/18 del Deployment, 43/43 gates raíz de
seguridad y 239/239 de recuperación. El dictamen es GO de fuente/CI únicamente:
no se ejecutaron builds de rollout, staging, despliegue ni aceptación live.

Límites de seguridad por defecto:

- `MAX_ACTIVE_ROOMS=5`, con hard cap de 10 salas ghost;
- `MAX_BOTS_PER_ROOM=10`, con hard cap de 10;
- la configuración Chromium heredada no habilita un runner autenticado ni
  participa en readiness;
- backend no reconocido: `ghost`;
- autostart: solo ghost autenticado.

`MAX_ACTIVE_ROOMS` no es solo una señal de readiness. El candidato lo entrega
con el mismo valor a Reticulum y bot-orchestrator y el verificador de manifiesto
rechaza divergencias o valores fuera de 1-10. Reticulum serializa las altas con
un lock transaccional global PostgreSQL y rechaza N+1 antes de persistir; el
endpoint interno del orquestador conserva una segunda defensa y tampoco acepta
una población parcial.

## Capacidades

- Bots visibles en la sala con avatar y estado de movimiento replicado.
- Movilidad `static`, `low`, `medium` o `high`.
- Rutas A* sobre el navmesh publicado por Spoke.
- Chat privado por bot para cuentas autenticadas mediante GPT-5 Nano
  (`gpt-5-nano`).
- Acción allowlisted `go_to_waypoint(spawbot-...)` derivada de un comando humano
  exacto.
- Un único prompt/persona de sala, de hasta 1500 caracteres, compartido por
  todos los bots de esa sala.

No existe todavía configuración de personalidad por bot. Personalidades,
prompts o memoria separados para cada bot son trabajo futuro y requieren un
nuevo esquema persistido, UI, límites y pruebas de aislamiento; no deben
simularse codificando instrucciones por nombre de bot en el prompt de sala.

## Guía para usuarios

1. Entra con una cuenta autenticada en una sala donde el administrador haya
   habilitado bots y chat.
2. Acércate a un bot y pulsa `Talk`.
3. Escribe en el panel privado. La conversación visible solo vive en la memoria
   de esa sesión de navegador.
4. Para solicitar movimiento, usa una orden directa y completa hacia un
   waypoint publicado, por ejemplo `ve a spawbot-lobby`.

Mencionar un waypoint, formular una pregunta o incluir texto adicional no es
una orden ejecutable. En movilidad `static` ninguna petición, incluida una
petición por chat, mueve el bot.

## Guía para admins y authoring de Spoke

1. Con una cuenta de administrador global no deshabilitada, en `Room Settings`
   configura `Enable bots`, `Bot Count` (0-10),
   `Mobility`, `Enable bot chat` y, si procede, el prompt único de sala.
2. En Spoke, conserva o añade un `Floor Plan` que cubra toda la superficie
   transitable y publícalo para obtener el componente `nav-mesh`.
3. Crea waypoints `spawbot-*` sobre el área navegable; se recomiendan 6-12 y
   nombres descriptivos como `spawbot-lobby` o `spawbot-stage`.
4. Publica la escena y valida que los puntos se proyectan al navmesh sin superar
   `GHOST_NAVMESH_MAX_SNAP_DISTANCE_M`.

Un spawn point de Spoke es un waypoint con la opción de spawn activada, pero un
`spawbot-*` no necesita esa opción. El prefijo determina la allowlist de
patrulla y chat; no concede autoridad por sí mismo.

Solo un administrador global puede activar o modificar una configuración de
bots activa. Un propietario ordinario puede conservar exactamente la
configuración ya aprobada mientras cambia otros datos de la sala, o desactivar
bots; no puede reactivarlos ni variar count, movilidad, chat o prompt. Alcanzar
`MAX_ACTIVE_ROOMS` rechaza la operación de alta sin mutar la sala. Estos son
contratos integrados en las ramas base, no del runtime live actual.

Cloud `0f151eb88da1` persiste en `ret0.bot_config_approvals` el candidato exacto,
su fingerprint, el último estado aprobado y la atribución de la decisión. La
migración inicial conserva el JSON heredado y cambia únicamente
`bots.enabled` a `false`, de modo que ninguna configuración previa puede
autoiniciarse. Hubs `674ece411691` añade al Admin un inventario redactado y
acciones individuales de aprobar o poner en cuarentena; nunca devuelve ni
renderiza prompt o JSON crudo. Un cambio exacto posterior invalida la
aprobación, y runtime, chat y registro del runner fallan cerrados hasta una nueva
decisión. Antes del rollout hay que revisar y aprobar individualmente el
inventario; la integración de fuentes no equivale a esa decisión operativa.

### Navmesh obligatorio y recuperación

El contrato operativo requiere:

```text
GHOST_NAVIGATION_MODE=navmesh_preferred
GHOST_NAVIGATION_REQUIRE_NAVMESH=true
```

El runner descarga de forma acotada el JSON del GLB y los `bufferView`
necesarios, extrae el navmesh, proyecta waypoints y calcula rutas A*. El radio
del agente ya se incorpora al generar el Floor Plan; no se añade otro margen en
runtime.

Si la escena, el navmesh o la proyección no son válidos:

1. el runner hace tres intentos con backoff acotado;
2. no crea ni declara activos los bots requeridos;
3. publica `navigationReady=false` y razón `navmesh_unavailable`;
4. readiness pasa a 503 para esa sala;
5. programa un reinicio de recuperación limpio, 30 segundos por defecto, para
   reintentar desde cero.

El modo de colliders, el movimiento recto y el origen solo son compatibilidad
legacy/diagnóstico mediante opt-out explícito. No son un estado sano ni un
fallback autorizado para el rollout operativo. Un waypoint solicitado que no
se pueda proyectar tampoco se sustituye por una patrulla aleatoria.

## Autenticación y autoridad del ghost runner

Las cuatro credenciales internas deben tener al menos 32 caracteres, ser todas
distintas y existir solo en los consumidores mínimos:

- `BOT_ACCESS_KEY`: compatibilidad del binding interno heredado, solo en
  Reticulum;
- `BOT_RUNNER_ACCESS_KEY`: transición del runner `process-local` heredado, solo
  en Reticulum; no se monta en ninguna de las dos imágenes nuevas;
- `BOT_ORCHESTRATOR_ACCESS_KEY`: llamadas de Reticulum al proceso padre y firma
  del token de generación v1, en Reticulum y en el padre;
- `DASHBOARD_ACCESS_KEY`: rutas administrativas de Reticulum.

El Pod runner recibe únicamente su token de generación efímero; el padre no
recibe la clave legacy de runner ni la administrativa. Ninguna credencial se
envía al navegador ni se almacena en YAML versionado. El Secret privado
`bot-images-pull` solo lo consume kubelet mediante `imagePullSecrets`: no se
monta ni se entrega a Node. Su origen
`BOT_IMAGE_PULL_CONFIG_JSON_BASE64` vive únicamente en el values local `0600` y
se actualiza con `npm run set-bot-image-pull-config`, pasando `GHCR_TOKEN` por
entrada oculta/entorno y sin imprimirlo.

El flujo autoritativo es:

1. Ghost solicita el join Phoenix con `context.bot_runner=true` y su token de
   generación v1; la master key solo existe para el rollback legacy privado.
2. Reticulum verifica sala, generación, holder y caducidad exactos. Si falla, no
   degrada silenciosamente a cliente normal.
3. Bajo lock PostgreSQL adquiere/asigna el lease UUID y epoch de autoridad; la
   respuesta y Presence confirman `bot_runner=true` con ese fence exacto.
4. Ghost espera su propia Presence autenticada con lease+epoch coincidentes
   antes de intentar un spawn.
5. Los bots usan exclusivamente el template `#remote-bot-avatar` y el namespace
   reservado `room-bot-<hub_sid>-bot-<id>`.
6. Reticulum rechaza que un cliente normal use ese namespace o template, y
   rechaza que el runner publique un bot fuera del namespace exacto.
7. Cada first sync de bot necesita un ACK Phoenix con
   `bot_spawn_accepted: true` y el mismo `network_id`. Un timeout, error o ACK
   que identifique otro objeto no cuenta como spawn.
8. Updates, multi-updates y removals del namespace reservado siguen sujetos al
   runner autenticado y a la forma dedicada no persistente.

El orquestador solo cuenta un bot como activo después del ACK autoritativo. Ante
un spawn fallido intenta retirar el objeto de forma best-effort y aplica un
reintento acotado; no anuncia una población que Reticulum no confirmó.

### Fencing PostgreSQL de autoridad

`ret0.bot_runner_leases` conserva una fila o tombstone por sala con UUID de
lease, holder Reticulum, sesión de canal, expiración y un epoch global limitado
al entero seguro de JavaScript que no puede ciclar. La adquisición usa lock
advisory por sala, lock de fila y reloj PostgreSQL; concede 15 segundos y se
renueva cada 5. Renovación y release son CAS del tuple completo; takeover tras
expiración y revoke consumen un epoch nuevo. No hay fallback local ante error
de base de datos.

Spawn, updates, removals, NAF raw, ACK y entrega final de chat revalidan el
fence exacto bajo el mismo lock. Cada `bot_command` lleva lease+epoch y el ghost
descarta comandos ausentes o stale. Esto cerca autoridades antiguas entre
procesos, pero no convierte por sí solo la topología en HA: el generador y el
verificador siguen exigiendo una réplica Reticulum, `Recreate` y sin HPA hasta
que un rollout separado pruebe dos réplicas frías, readiness/Endpoints y la
restricción `ret-pvc` RWO.

### Aislamiento por Pod (`AUD-075`)

Cloud `5392495b077249edcedfb3092551201645f648f1` elimina el hijo Node del
contenedor padre y crea exactamente
un Pod `restartPolicy: Never` por sala y generación. El padre conserva
`OPENAI_API_KEY`, `BOT_ORCHESTRATOR_ACCESS_KEY` y el control namespaced de Pods;
no recibe `BOT_RUNNER_ACCESS_KEY`. Cada runner usa la imagen separada
`bot-runner`, UID/GID 10001, namespace PID y cgroup propios, requests/limits,
raíz de solo lectura, `/tmp` acotado, `allowPrivilegeEscalation=false`, todas las
capabilities eliminadas y seccomp `RuntimeDefault`. Su ServiceAccount no monta
token y no tiene RBAC. No recibe clave del proveedor, credencial maestra de
runner, credencial del padre ni autoridad Kubernetes.

Los nombres y labels usan un HMAC de la sala, nunca el SID crudo. El padre solo
puede crear, consultar/listar y borrar Pods en el namespace; cada borrado se
liga al nombre y UID exactos. Al arrancar no adopta Pods heredados: elimina todo
runner gestionado, prueba el conjunto vacío y después abre el transporte. La
reconciliación periódica elimina de forma fail-closed Pods desconocidos,
caducados, terminales o con owner/contrato distinto. Las dos NetworkPolicies
del namespace runner aplican default-deny y autorizan únicamente el egress
necesario hacia kube-dns, el control-plane padre y TCP/443 público.

El token de generación v1 preautoriza únicamente sala, UUID de generación,
holder/UID del Pod padre y caducidad. No contiene lease ni epoch y no sustituye
el fencing. Después del join, Reticulum asigna el UUID de lease PostgreSQL y el
epoch de autoridad positivo; Presence, ACKs, comandos, estado del runner y
readiness deben coincidir exactamente. El runner rechaza fences ausentes o
stale. El token viaja en el join y en el header Bearer del canal de control,
nunca en URL o estado cliente.

Este aislamiento está integrado y probado en fuente, pero sigue sin digests ni
atestación de runtime. `process-local` solo se admite como rollback privado con
bots públicos deshabilitados; no es una topología aceptable para público ni
para certificar capacidad.

### Otros bloqueos operativos

- `AUD-065` exige checkpoint fresco de DB+storage y rotación coordinada de todos
  los secretos potencialmente expuestos antes de cualquier mutación de
  producción.
- El aislamiento por Pod y el fencing PostgreSQL están integrados y probados en
  fuente, pero aún no desplegados ni atestados; el baseline live sigue siendo
  `process-local` y no debe autorizar uso público ni autoridades concurrentes.
- El código de aprobación/cuarentena está integrado pero no desplegado; tras la
  migración debe revisarse el inventario redactado y aprobar cada configuración
  válida antes de reactivar bots.
- El aviso `room_stop` es best-effort. La desactivación persistida y el snapshot
  periódico convergen, pero un fallo HTTP no garantiza la parada inmediata del
  runner.
- No existe medición física de capacidad ni aceptación staging/live para este
  candidato.

## Configuración y readiness

Variables principales de `bot-orchestrator`:

- `RUNNER_BACKEND`: debe ser `ghost` para cualquier ejecución productiva o
  autenticada; `chromium` identifica únicamente el diagnóstico browser
  legacy/local sin `--runner`.
- `RUNNER_BACKEND_CANARY_HUBS`: lista CSV de salas forzadas a ghost.
- `MAX_ACTIVE_ROOMS` compartido exactamente con la admisión Reticulum, y
  `MAX_BOTS_PER_ROOM`; `MAX_CHROMIUM_ROOMS` es un límite heredado del
  diagnóstico, no una autorización ni una señal de readiness.
- `GHOST_NAVIGATION_MODE` y `GHOST_NAVIGATION_REQUIRE_NAVMESH`.
- `GHOST_NAVIGATION_RECOVERY_RESTART_MS`: espera antes del reinicio de
  recuperación.
- `GHOST_SCENE_ALLOWED_HOSTS`: hosts de escena adicionales explícitos.
- `GHOST_SCENE_FETCH_TIMEOUT_MS`, `GHOST_SCENE_MAX_BYTES` y
  `GHOST_SCENE_MAX_JSON_BYTES`.
- `GHOST_SCENE_MAX_NODES`, `GHOST_SCENE_MAX_EDGES` y
  `GHOST_NAVMESH_MAX_TRIANGLES`.
- `GHOST_NAVMESH_MAX_ROUTE_POINTS` y
  `GHOST_NAVMESH_MAX_SNAP_DISTANCE_M`.
- `RUNNER_HEALTH_TTL_MS`: frescura máxima del estado autoritativo.
- `BOT_RUNNER_IMAGE`: digest exacto de la imagen separada que el padre crea por
  sala; debe coincidir con `OVERRIDE_BOT_RUNNER_IMAGE`.
- `OPENAI_MODEL`: debe permanecer `gpt-5-nano` si el chat IA está habilitado.
- `OPENAI_TOTAL_BUDGET_MS`: presupuesto total, limitado a 4000 ms.

`/health` describe proceso, cola y diagnóstico. No certifica por sí solo que
los bots estén utilizables. La probe Kubernetes del padre usa
`/transport-ready`: solo abre tras eliminar/probar ausentes los runners
huérfanos y permite que los nuevos Pods alcancen el canal de control sin crear
un deadlock de bootstrap. No es aceptación de bots. `/ready` es el gate
autoritativo: cada sala configurada con una
población mayor que cero debe tener un estado reciente que confirme a la vez:

- runner autenticado;
- configuración aplicada;
- navmesh listo;
- ACKs autoritativos de spawn;
- población activa igual a la deseada;
- razón `ready` dentro del TTL.

Si falta cualquiera de estas condiciones, la sala aparece en `unready_hubs` y
`/ready` devuelve 503. La admisión transaccional debe impedir que el número de
salas activas persistidas supere `MAX_ACTIVE_ROOMS`; si un estado externo o
inconsistente lo supera, `capacity_exceeded=true` mantiene el gate cerrado y no
se acepta una población parcialmente atendida. Una sala en `queued_capacity`
tampoco está ready.

El snapshot autoritativo está acotado por ambos lados: Reticulum consulta como
máximo 11 filas para detectar un exceso sobre el límite duro de 10 salas y el
orquestador deja de leer después de 128 KiB. Un payload mayor, una undécima sala
o una forma JSON inválida se rechaza atómicamente sin conservar un subconjunto
ni refrescar el TTL del snapshot anterior.

## Chat IA: privacidad y seguridad

La API key de OpenAI solo existe en `bot-orchestrator`. El navegador envía el
mensaje y la capacidad privada de su canal a Reticulum; Reticulum comprueba
autenticación, permiso de entrada, coincidencia exacta sala/cuenta/capacidad,
bot, configuración y forma/tamaño antes de llamar al orquestador. La capacidad
aleatoria se entrega solo en la respuesta privada del canal, se registra en
`BotChatPresence` únicamente tras `events:entered`, se rota al iniciar sesión y
se invalida al cerrar sesión o terminar el proceso. No se publica ni la
capacidad ni el identificador de cuenta en Phoenix Presence, y otra sesión de
la misma cuenta no puede reutilizar esta autoridad.

En Hubs, la autoridad es una cadena base64url exacta de 32 caracteres y se
vincula a canal, sala, bot, cuenta y epoch. Al cambiar sala/canal/cuenta,
rotar/revocar la capacidad o cerrar sesión, la UI aborta solicitudes y descarta
respuestas tardías cuyos valores capturados ya no coincidan; además limpia
sesiones, borradores, selección y panel. El logger Phoenix redacta de forma
recursiva capacidades y credenciales.

La distancia de 3 m es actualmente una regla UX del cliente para mostrar
`Talk`, no una barrera de autorización del backend. Una cuenta autenticada y
presente en la sala puede invocar directamente el endpoint aunque su avatar
esté lejos. No se debe describir la proximidad como control de seguridad; hacerla
autoritativa requeriría que Reticulum mantuviera y validara una posición fresca
y confiable de la sesión.

Controles del contrato candidato:

- GPT-5 Nano (`gpt-5-nano`) como único modelo permitido cuando existe API key;
- mensaje máximo de 800 caracteres y respuesta máxima de 500;
- máximo de 8 solicitudes por minuto por combinación sala/cuenta, además de un
  intervalo corto entre solicitudes;
- `safety_identifier` pseudónimo mediante HMAC, sin enviar el ID de cuenta en
  claro al proveedor;
- Structured Outputs con JSON Schema estricto que solo contiene `reply`;
- moderación de entrada y salida;
- un único presupuesto compartido máximo de 4 segundos para moderación de
  entrada, modelo y moderación de salida;
- fallback genérico sin repetir el mensaje del usuario;
- ningún log de prompt o respuesta completos.

La moderación falla cerrada. Un HTTP no correcto, timeout, JSON inválido o una
respuesta 2xx que no contenga el booleano `results[0].flagged` no se interpreta
como contenido permitido. Lo mismo aplica a una respuesta estructurada inválida
o a la moderación de salida.

### El modelo no tiene autoridad de movimiento

La salida del modelo se reduce a `reply`; cualquier acción incluida o sugerida
por el modelo se ignora. `go_to_waypoint` se deriva por separado exclusivamente
del mensaje original del usuario y exige una orden positiva y completa.

La lista de waypoints enviada por el cliente es entrada no confiable:
Reticulum limita cantidad, longitud y prefijo `spawbot-*`, y vuelve a validar
cuenta, sala, bot, movilidad y forma de la acción. La autoridad final sobre la
existencia del destino es el inventario extraído de la escena por el ghost
runner; un nombre inexistente se descarta y el bot queda `idle`. Reticulum no
certifica por sí solo que el waypoint exista en el GLB. El prompt de sala se
trata también como texto no confiable y queda subordinado al prompt fijo de
seguridad.

### `store: false` no es Zero Data Retention

Las peticiones Responses usan `store: false`, por lo que no crean estado
recuperable de Responses. Esto no equivale a Zero Data Retention (ZDR) y no
anula por sí solo los logs de monitoreo de abuso del proveedor. Sin una
aprobación ZDR aplicable, esos logs pueden contener entradas/salidas y estar
sujetos a la retención indicada por OpenAI.

YenHubs no persiste conversaciones del bot en su base de datos. El historial de
la UI vive solo en la sesión actual del navegador. Antes de cualquier evento
público hay que mantener el aviso de privacidad, revisar la política vigente y
decidir si se necesita ZDR. Referencia oficial:
<https://developers.openai.com/api/docs/guides/your-data#data-retention-controls-for-abuse-monitoring>.

## Movilidad

- `static`: inmovilidad real; conserva chat, pero bloquea navegación automática
  y órdenes de movimiento.
- `low`: intervalos largos de reposo.
- `medium`: equilibrio entre reposo y movimiento.
- `high`: mayor frecuencia de movimiento.

El runner publica segmentos `bot-path` consecutivos con reloj sincronizado. Si
el destino está en otro grupo del navmesh o no puede proyectarse, se descarta y
el bot queda `idle`; no cruza paredes ni inventa un destino alternativo.

## Troubleshooting

### No aparecen bots

1. Comprueba `Enable bots`, `Bot Count > 0` y que la sala no esté en cola de
   capacidad.
2. Comprueba que el cliente bitECS no esté habilitado; los bots siguen siendo
   una superficie del cliente clásico.
3. Consulta `/ready`, no solo `/health`.
4. Revisa `runner_bots[hub]`: autenticación, ACKs, desired/active, razón y
   frescura.
5. Verifica el Floor Plan/navmesh y los `spawbot-*`; no habilites un fallback
   inseguro para ocultar un error de authoring.
6. Comprueba que el runner recibió `bot_runner=true` y observó su Presence.

### No responden en chat

1. Verifica `Enable bot chat` y que el usuario esté autenticado.
2. Verifica la presencia de la API key solo por indicador/configuración, sin
   imprimirla.
3. Revisa rate limit, presupuesto total de 4 segundos y resultado de
   moderación.
4. Un fallback genérico puede indicar indisponibilidad, moderación fail-closed o
   salida estructurada inválida; los logs no deben incluir el texto del usuario.

### No se mueven

1. Confirma que `Mobility` no es `static`.
2. Exige `Navmesh ready`, waypoints proyectados y `/ready=200`.
3. Revisa la razón `navmesh_unavailable` y los tres intentos de carga.
4. Si persiste, corrige/publica la escena y deja que el reinicio de recuperación
   cree un runner limpio; no hotpatchees el pod.
5. Para chat, usa una orden exacta hacia un `spawbot-*` conocido.

## Superficie custom y upgrades

Baselines aceptados para planificar el candidato:

- Hubs: `prod-2026-03-11`;
- Hubs Community Edition: `2.1.0`.

Superficie que debe revalidarse en cada upgrade:

- Room Settings y contrato persistido `hub.user_data.bots`;
- `bot-runner-system.js` y template `#remote-bot-avatar`;
- handlers NAF, Presence y autenticación de `HubChannel`;
- normalización, chat, readiness y límites de `bot-orchestrator/app.js`;
- parser GLB, navmesh, namespace y ACKs de `run-ghost-runner.js`;
- generador Hubs CE y verificaciones fail-closed.
- manager Kubernetes, cliente de control y token de generación v1;
- ambos Dockerfiles, workflow de dos imágenes, RBAC/ServiceAccounts, Secret de
  pull y NetworkPolicy del runner.

Gate mínimo:

1. suites completas de Hubs, Reticulum y bot-orchestrator;
2. generador sin placeholders, secretos expuestos ni imágenes mutables;
3. escena staging con navmesh y rutas entre puntos conectados;
4. autenticación negativa/positiva, namespace reservado y ACK exacto;
5. `/transport-ready` solo tras reconciliar huérfanos y `/ready=503` ante
   navmesh, auth, lease/epoch, ACK o población incorrectos;
6. `static`, movilidad, late join, chat, moderación y comando allowlisted;
7. cold desktop/mobile y verificador live solo después del rollout estándar.

El gate local de Spoke requiere además sus 68/68 pruebas, lint y build con el
runtime legacy fijado. No sustituye abrir, guardar y publicar una copia segura
en staging.

El análisis de coste y capacidad se mantiene en
`docs/bots-cost-capacity-analysis-2026-07.md`. El procedimiento de build,
digests, despliegue y rollback vive exclusivamente en `deployment/README.md`.
