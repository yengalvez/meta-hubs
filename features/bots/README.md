# Bots en YenHubs

> Arquitectura aceptada: backend `ghost` sin Chromium, capacidad `MAX_ACTIVE_ROOMS=5` y
> `MAX_BOTS_PER_ROOM=10`. El digest y la ejecucion de GitHub Actions activos se mantienen en
> `deployment/README.md`; no copies aqui un tag mutable como fuente de verdad.
> Aceptacion del 16 de julio de 2026: `navmesh_preferred` activo en dos salas, modo `static` inmovil, restauracion a
> `low`, chat neutral y `go_to_waypoint` verificados en produccion sin drift.

Esta feature permite añadir bots por sala, con movilidad configurable y chat privado por proximidad.

> Privacidad: YenHubs no guarda las conversaciones del bot en base de datos. El historial visible vive solo en la
> memoria del navegador durante la sesion de sala. Las peticiones a OpenAI usan `store: false`, pero OpenAI puede
> conservar datos de monitoreo de abuso hasta 30 dias salvo que la organizacion tenga Zero Data Retention aprobado.

## Que hace

- Bots visibles en sala con avatar.
- Movimiento automatico entre puntos (`spawbot-*`) mediante rutas A* sobre el navmesh de la escena.
- Modo `static` para mantener los bots inmoviles en su punto asignado.
- Chat privado por bot con IA (`gpt-5-nano`).
- Accion opcional de movimiento por chat: `go_to_waypoint(spawbot-...)`.
- Prompt de comportamiento configurable por sala (maximo 1500 caracteres).
- Moderacion de entrada/salida, rate limit y allowlist de acciones.
- Respuesta de IA restringida mediante Structured Outputs y JSON Schema estricto.

## Guia rapida para usuarios

1. Inicia sesion y entra en una sala donde el admin haya activado bots. Los invitados pueden verlos, pero el endpoint
   de chat exige una cuenta autenticada.
2. Acercate a un bot.
3. Pulsa el boton `Talk` en la toolbar.
4. Escribe un mensaje en el panel privado.
5. Si pides un destino tipo `spawbot-2`, el bot puede moverse a ese punto.

## Guia rapida para admins

1. Abre `Room Settings`.
2. Configura:
- `Enable bots`
- `Bot Count` (0 a 10)
- `Mobility` (`static`, `low`, `medium`, `high`)
- `Enable bot chat` (si quieres chat privado)
3. Guarda cambios.
4. En Spoke, crea **waypoints** en los puntos por donde quieres que se muevan (recomendado: 6-12).
5. Opcional (recomendado): nombra algunos waypoints con prefijo `spawbot-` para controlar por donde aparecen y patrullan, por ejemplo:
- `spawbot-1`
- `spawbot-2`
- `spawbot-lobby`
  Nota: el sufijo puede ser cualquier cosa (no hace falta numero).
6. Añade o conserva un **Floor Plan** que cubra toda la zona transitable. Spoke genera a partir de el el componente
   `nav-mesh` que usa el ghost runner para rodear paredes.
7. Publica la escena y prueba en sala.

### Waypoint vs "Spawn point" (Spoke)
- En Spoke, **un spawn point es un waypoint** con la opcion de spawn activada.
- Para bots en este MVP:
  - Si existen waypoints `spawbot-*`, se usan como prioridad para spawn y patrulla.
  - Si no existen `spawbot-*`, los bots usan **cualquier waypoint** para spawn y patrulla.
  - Si no hay waypoints en la escena, el fallback es aparecer en el origen (0,0,0) y moverse cerca.
- No hace falta activar `Spawn Point` en un waypoint llamado `spawbot-*`.
- Coloca los puntos sobre la superficie azul/transitable del Floor Plan. Un punto que quede a mas de
  `GHOST_NAVMESH_MAX_SNAP_DISTANCE_M` del navmesh no es valido para rutas.

### Como navegan

1. El ghost runner descarga solo el JSON del GLB y los `bufferView` necesarios para el navmesh.
2. Proyecta waypoints y bots sobre la malla.
3. Calcula una ruta A* al elegir destino.
4. Publica varios segmentos `bot-path` consecutivos; el cliente los reproduce con su reloj sincronizado.
5. Si dos zonas del navmesh no estan conectadas, el bot descarta ese destino y permanece `idle`.

El radio de agente configurado en el Floor Plan de Spoke ya se aplica al generar el navmesh. No se debe sumar otro
margen artificial en runtime porque estrecharia dos veces puertas y pasillos.

## Como interpretar mobility

- `static`: el bot permanece inmovil en su punto de spawn, conserva chat y rechaza navegacion automatica o por LLM.
- `low`: mas tiempo quietos, menos desplazamientos.
- `medium`: equilibrio entre quietud y movimiento.
- `high`: se mueven con mas frecuencia.

## Runner (ghost vs chromium) y coste

Hay 2 backends de runner:

- `ghost`: runner en Node (sin Chromium). No renderiza nada: solo publica `bot-path` + `bot-info` por Phoenix/NAF. Es el modo recomendado por coste.
- `chromium`: runner basado en navegador headless. Funciona, pero consume mucha mas CPU/RAM por sala.

En el cierre final del proyecto se dejo `ghost` como backend estable y recomendado.
Si `RUNNER_BACKEND` falta o tiene un valor invalido, el fallback seguro tambien es `ghost`. Chromium solo debe
activarse de forma explicita para diagnostico.

Configuracion (Kubernetes env vars en `bot-orchestrator`):

- `RUNNER_BACKEND`: backend por defecto (`ghost` o `chromium`).
- `RUNNER_BACKEND_CANARY_HUBS`: lista CSV de `hub_sid` que fuerzan `ghost` aunque el default sea `chromium` (canary seguro).
- `MAX_ACTIVE_ROOMS`: maximo de salas con runner activo a la vez.
- `MAX_BOTS_PER_ROOM`: maximo de bots por sala.
- `GHOST_SCENE_ALLOWED_HOSTS`: hosts adicionales CSV para escenas; vacio mantiene solo el origen de Hubs.
- `GHOST_SCENE_FETCH_TIMEOUT_MS`: timeout de descarga, 10 segundos por defecto.
- `GHOST_SCENE_MAX_BYTES`: tamano maximo declarado/cargado, 64 MiB por defecto.
- `GHOST_SCENE_MAX_JSON_BYTES`: JSON glTF maximo, 4 MiB por defecto.
- `GHOST_SCENE_MAX_NODES` / `GHOST_SCENE_MAX_EDGES`: 50.000 / 200.000 por defecto.
- `GHOST_NAVIGATION_MODE`: debe ser `navmesh_preferred` en produccion.
- `GHOST_NAVMESH_MAX_TRIANGLES`: limite de seguridad al parsear la malla; `50000` por defecto.
- `GHOST_NAVMESH_MAX_ROUTE_POINTS`: maximo de vertices publicados por ruta; `64` por defecto.
- `GHOST_NAVMESH_MAX_SNAP_DISTANCE_M`: distancia maxima para proyectar un punto; `3` metros por defecto.
- Si el backend default es `chromium`, se recomienda cap adicional (por coste) con `MAX_CHROMIUM_ROOMS`.

## Limites del MVP (intencionales)

- Maximo `10` bots por sala (clamp en backend).
- Capacidad global por defecto: `5` salas activas con runner a la vez (`MAX_ACTIVE_ROOMS`).
- Con backend `chromium`, se recomienda limitar a 1 sala activa (por coste) y usar `ghost` para escalar.
- La navegacion preferida usa navmesh+A*. Los `box-collider` quedan como fallback compatible para escenas antiguas
  sin navmesh valido.
- Si no existe ni navmesh valido ni collider, el fallback historico permite el trayecto recto. Produccion debe tratar
  el log `No valid navmesh` como una incidencia de authoring, no como un estado aceptado.
- `static` es inmovilidad real; `low` sigue siendo una movilidad automatica lenta.
- Los bots no estan implementados para el cliente bitECS.

El analisis completo de navegacion, coste y capacidad esta en
`docs/bots-cost-capacity-analysis-2026-07.md`.

## Privacidad y seguridad del chat IA

- La API key de OpenAI solo se inyecta en `bot-orchestrator`; nunca llega al navegador.
- Reticulum valida la sala, el bot y la accion antes de emitir movimiento.
- Los clientes no pueden publicar directamente `bot_command`.
- El mensaje se limita a 800 caracteres y la respuesta a 500.
- El rate limit por defecto es 8 mensajes por minuto para cada combinacion sala/bot/usuario.
- El prompt de sala es subordinado al prompt fijo de seguridad del sistema.
- Solo se acepta `go_to_waypoint` hacia un nombre saneado `spawbot-*`.
- El fallback solo interpreta verbos completos de movimiento; mencionar un waypoint o una silaba no mueve al bot.
- No se registran prompts ni respuestas completas.
- El identificador de cuenta se transforma con HMAC antes de enviarse como `safety_identifier`.

Antes de un evento publico, documentar el aviso de privacidad, probar prompt injection en espanol y decidir si se
necesita solicitar Zero Data Retention a OpenAI.

`store:false` desactiva el estado recuperable de Responses, pero no sustituye Zero Data Retention. Sin ZDR, los logs de
monitoreo de abuso del proveedor pueden contener prompts/respuestas y conservarse hasta 30 dias. Referencia oficial:
<https://developers.openai.com/api/docs/guides/your-data#data-retention-controls-for-abuse-monitoring>.

## Troubleshooting

## No aparecen bots

1. Verifica que `Enable bots` esta activado en esa sala.
2. Verifica que `Bot Count` > 0.
3. Asegura que **NO** tienes activado `Enable bitECS based Client` (por ahora los bots solo se ven en el cliente clasico).
4. Revisa que la feature global de bots/chat este habilitada en app config.
5. Revisa despliegue de `bot-orchestrator` en `hcce`.

## No responden en chat

1. Verifica que `Enable bot chat` esta activo en la sala.
2. Verifica que el usuario este autenticado; el chat de bots no acepta invitados.
3. Verifica que `OPENAI_API_KEY` esta presente en secret/config.
4. Revisa logs de `bot-orchestrator` y `reticulum`.

## No se mueven o se mueven raro

1. Asegura que la escena tenga **al menos 2 waypoints** separados entre si.
2. Comprueba que `Mobility` no sea `static`.
3. Comprueba en Spoke que exista un Floor Plan y que los waypoints esten sobre su zona transitable.
4. Revisa el log del orquestador. El estado sano incluye `Navmesh ready` con triangulos y grupos. `No valid navmesh`
   significa que se ha activado el fallback.
5. Verifica que la sala no este en cola de capacidad por limite global del runner (`MAX_ACTIVE_ROOMS`).

## Animaciones / avatares
- Los bots intentan usar avatares `featured` con tags `fullbody` o `rpm` (si existen).
- Si solo hay avatares normales sin esqueleto fullbody, el bot puede verse mas "rigido".

## Sala en cola de capacidad

- Es esperado si la capacidad global esta limitada.
- Si el maximo de runners esta ocupado, otra sala puede quedar en cola hasta liberar.

## Superficie custom y auditoria de upgrades

Baseline de esta implementacion:

- Hubs: `prod-2026-03-11`.
- Hubs Community Edition: `2.1.0`.

Superficie custom que debe revisarse al actualizar upstream:

- `hubs/src/react-components/room/RoomSettingsSidebar.js`: opcion `static`.
- `hubs/src/systems/bot-runner-system.js`: compatibilidad del fallback Chromium.
- `hubs-cloud/community-edition/services/reticulum/lib/ret/hub.ex` y controladores/canal de bots: contrato persistido
  de movilidad.
- `hubs-cloud/community-edition/services/bot-orchestrator/app.js`: normalizacion, chat y bloqueo de acciones en
  `static`.
- `hubs-cloud/community-edition/services/bot-orchestrator/run-ghost-runner.js`: parser GLB parcial, navmesh,
  proyeccion, A* y segmentos de ruta.
- `hubs-cloud/community-edition/generate_script/`: variables y verificaciones fail-closed.

Riesgos de upgrade:

- cambios en `MOZ_hubs_components["nav-mesh"]`, transforms GLTF o export de Floor Plan;
- cambios en `networked-aframe`, Phoenix o el contrato `bot-path`;
- cambios en `hub.user_data.bots` o en la UI de Room Settings;
- incompatibilidad de `three`/`three-pathfinding` con el Node del contenedor.

Gate minimo tras cada upgrade:

1. Suites completas de Hubs, Reticulum y bot-orchestrator.
2. Generador de 44 recursos sin placeholders ni imagenes mutables.
3. Parseo de la escena real: navmesh, ocho `spawbot-*` y rutas entre todos los pares conectados.
4. Prueba live de `static`, `low/medium/high`, late join, chat y `go_to_waypoint`.
5. Confirmar que el runner sigue oculto y que no se ha reactivado Chromium.

Rollback: volver a los tres digests anteriores de Hubs, Reticulum y bot-orchestrator en
`deployment/input-values.local.yaml`, regenerar el manifiesto y aplicarlo por el flujo estandar.
