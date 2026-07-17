# Bots en YenHubs

## Estado y contrato

La arquitectura candidata usa Node `ghost` como único runner productivo y
autenticado. Chromium se conserva solo como diagnóstico browser legacy/local
sin `--runner`: el renderer no recibe `BOT_RUNNER_ACCESS_KEY`, no puede autenticarse
contra Reticulum endurecido, no cuenta para readiness y nunca debe recibir la
clave por URL ni estado cliente. Ghost publica avatares y rutas por Phoenix/NAF
sin renderizar la sala, mientras Reticulum conserva la autoridad sobre
identidad, spawn, actualizaciones y comandos.

> Estado: endurecimiento candidato validado con suites locales. Esta
> especificación no afirma despliegue ni aceptación en staging/live; esas fases
> siguen pendientes del flujo de `deployment/README.md`. El rollout público y
> la certificación de capacidad están además bloqueados hasta aislar padre y
> runners ghost en pods o contenedores distintos con credenciales y recursos
> propios.

El corte local integrado usa Hubs `d7f0c2fc4` y Hubs Cloud `b7b752f`. Spoke
pasó aparte 68/68 pruebas, lint y build con Node 16.13.2/Yarn 1. El dictamen es
GO de integración local únicamente: no se ejecutaron carga física, Actions,
staging ni aceptación live.

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
contratos del candidato local, no del runtime live actual.

Las configuraciones activas heredadas todavía no tienen un marcador persistido
de aprobación ni una cuarentena ejecutable fail-closed. Antes de autostart o
rollout hay que obtener un inventario exacto redacted y registrar aprobación
del propietario, o migrarlas a un estado deshabilitado/cuarentenado verificable.

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
- `BOT_RUNNER_ACCESS_KEY`: join Phoenix del ghost runner y lectura del snapshot,
  en Reticulum y en el proceso padre/hijo del runner;
- `BOT_ORCHESTRATOR_ACCESS_KEY`: llamadas de Reticulum al proceso padre del
  orquestador;
- `DASHBOARD_ACCESS_KEY`: rutas administrativas de Reticulum.

El proceso hijo recibe por entorno únicamente `BOT_RUNNER_ACCESS_KEY`; el padre
no recibe la clave legacy ni la administrativa. Ninguna se envía al navegador
ni se almacena en YAML versionado. Esta separación de variables reduce la
herencia accidental, pero no constituye una frontera de seguridad entre
procesos mientras compartan contenedor y UID.

El flujo autoritativo es:

1. Ghost solicita el join Phoenix con `context.bot_runner=true` y la clave
   interna.
2. Reticulum rechaza el join si se pidió rol de runner sin clave válida; no
   degrada silenciosamente a cliente normal.
3. La respuesta confirma `bot_runner=true` y Presence publica el contexto
   autenticado de esa misma sesión.
4. Ghost espera a observar su propia Presence autenticada antes de intentar un
   spawn.
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

### Bloqueo de aislamiento de procesos

El candidato actual ejecuta el padre y todos los ghost runners bajo UID 1000 en
el mismo contenedor, namespace PID y cgroup. Por ello un runner comprometido
puede intentar leer mediante `/proc` variables del padre que no heredó, enviar
señales a otros procesos y consumir el límite de memoria compartido hasta
derribar padre y salas vecinas. La allowlist de `spawn` no resuelve ese límite
de confianza ni el dominio común de fallo/OOM.

Antes de rollout público o certificación de capacidad, cada runner debe vivir
en su propio pod o contenedor, con namespace de proceso, credencial
`BOT_RUNNER_ACCESS_KEY`, requests/limits y NetworkPolicy propios. El padre debe
conservar `BOT_ORCHESTRATOR_ACCESS_KEY` y `OPENAI_API_KEY` y comunicarse por un
canal autenticado mínimo. Este rediseño es un residual P1 abierto y no está
implementado ni desplegado.

### Otros bloqueos operativos

- `AUD-065` exige checkpoint fresco de DB+storage y rotación coordinada de todos
  los secretos potencialmente expuestos antes de cualquier mutación de
  producción.
- La autoridad de leases del orquestador sigue siendo local al proceso y carece
  de fencing persistente en DB; no autorizar autoridades concurrentes.
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
- `OPENAI_MODEL`: debe permanecer `gpt-5-nano` si el chat IA está habilitado.
- `OPENAI_TOTAL_BUDGET_MS`: presupuesto total, limitado a 4000 ms.

`/health` describe proceso, cola y diagnóstico. No certifica por sí solo que
los bots estén utilizables. `/ready` es el gate: cada sala configurada con una
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

Gate mínimo:

1. suites completas de Hubs, Reticulum y bot-orchestrator;
2. generador sin placeholders, secretos expuestos ni imágenes mutables;
3. escena staging con navmesh y rutas entre puntos conectados;
4. autenticación negativa/positiva, namespace reservado y ACK exacto;
5. `/ready=503` ante navmesh, auth, ACK o población incorrectos;
6. `static`, movilidad, late join, chat, moderación y comando allowlisted;
7. cold desktop/mobile y verificador live solo después del rollout estándar.

El gate local de Spoke requiere además sus 68/68 pruebas, lint y build con el
runtime legacy fijado. No sustituye abrir, guardar y publicar una copia segura
en staging.

El análisis de coste y capacidad se mantiene en
`docs/bots-cost-capacity-analysis-2026-07.md`. El procedimiento de build,
digests, despliegue y rollback vive exclusivamente en `deployment/README.md`.
