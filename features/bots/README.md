# Bots en YenHubs (MVP)

> Estado de auditoria del 14 de julio de 2026: backend `ghost`, capacidad `MAX_ACTIVE_ROOMS=5` y
> `MAX_BOTS_PER_ROOM=10`. Produccion usa
> `ghcr.io/yengalvez/bot-orchestrator:audit-botguard-20260714-7de9b5c-latest`, publicado por GitHub Actions
> `29362366946`. Rehidratacion, chat estructurado y carga tardia con tres bots en movimiento pasaron; la imagen de
> marzo `ghost-fullsync-20260307-e38b70d-latest` queda solo como rollback.

Esta feature permite añadir bots por sala, con movilidad configurable y chat privado por proximidad.

> Privacidad: YenHubs no guarda las conversaciones del bot en base de datos. El historial visible vive solo en la
> memoria del navegador durante la sesion de sala. Las peticiones a OpenAI usan `store: false`, pero OpenAI puede
> conservar datos de monitoreo de abuso hasta 30 dias salvo que la organizacion tenga Zero Data Retention aprobado.

## Que hace

- Bots visibles en sala con avatar.
- Movimiento automatico entre puntos (`spawbot-*`) con ciclos `idle -> walk -> idle`.
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
2. Activa:
- `Enable bots`
- `Bot Count` (0 a 10)
- `Mobility` (`low`, `medium`, `high`)
- `Enable bot chat` (si quieres chat privado)
3. Guarda cambios.
4. En Spoke, crea **waypoints** en los puntos por donde quieres que se muevan (recomendado: 6-12).
5. Opcional (recomendado): nombra algunos waypoints con prefijo `spawbot-` para controlar por donde aparecen y patrullan, por ejemplo:
- `spawbot-1`
- `spawbot-2`
- `spawbot-lobby`
  Nota: el sufijo puede ser cualquier cosa (no hace falta numero).
6. Publica la escena y prueba en sala.

### Waypoint vs "Spawn point" (Spoke)
- En Spoke, **un spawn point es un waypoint** con la opcion de spawn activada.
- Para bots en este MVP:
  - Si existen waypoints `spawbot-*`, se usan como prioridad para spawn y patrulla.
  - Si no existen `spawbot-*`, los bots usan **cualquier waypoint** para spawn y patrulla.
  - Si no hay waypoints en la escena, el fallback es aparecer en el origen (0,0,0) y moverse cerca.

## Como interpretar mobility

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
- Si el backend default es `chromium`, se recomienda cap adicional (por coste) con `MAX_CHROMIUM_ROOMS`.

## Limites del MVP (intencionales)

- Maximo `10` bots por sala (clamp en backend).
- Capacidad global por defecto: `5` salas activas con runner a la vez (`MAX_ACTIVE_ROOMS`).
- Con backend `chromium`, se recomienda limitar a 1 sala activa (por coste) y usar `ghost` para escalar.
- El raycast no usa navmesh: solo evita `box-collider` detectados entre waypoints.
- Si la escena no exporta ningun `box-collider`, el ghost runner permite los trayectos rectos y los bots pueden
  atravesar estructuras.
- `low` no es un modo inmovil: el futuro modo de bots quietos debe implementarse como `mobility: static`.
- Los bots no estan implementados para el cliente bitECS.

El analisis completo de navegacion, coste y capacidad esta en
`docs/bots-cost-capacity-analysis-2026-07.md`. La opcion recomendada para evitar estructuras sin volver a Chromium es
usar el navmesh de la escena y calcular rutas A* en el ghost runner.

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
2. El bloqueo por obstaculos (raycast) es best-effort:
- En `ghost` runner, el raycast MVP usa `box-collider` de Spoke. Si tu escena no tiene colliders, no se bloquearan caminos.
3. Verifica que la sala no este en cola de capacidad por limite global del runner (`MAX_ACTIVE_ROOMS`).

## Animaciones / avatares
- Los bots intentan usar avatares `featured` con tags `fullbody` o `rpm` (si existen).
- Si solo hay avatares normales sin esqueleto fullbody, el bot puede verse mas "rigido".

## Sala en cola de capacidad

- Es esperado si la capacidad global esta limitada.
- Si el maximo de runners esta ocupado, otra sala puede quedar en cola hasta liberar.
