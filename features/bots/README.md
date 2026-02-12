# Bots en YenHubs (MVP)

Esta feature permite añadir bots por sala, con movilidad configurable y chat privado por proximidad.

## Que hace

- Bots visibles en sala con avatar.
- Movimiento automatico entre puntos (`spawbot-*`) con ciclos `idle -> walk -> idle`.
- Chat privado por bot con IA (`gpt-5-nano`).
- Accion opcional de movimiento por chat: `go_to_waypoint(spawbot-...)`.

## Guia rapida para usuarios

1. Entra en una sala donde el admin haya activado bots.
2. Acercate a un bot.
3. Pulsa el boton `Talk` en la toolbar.
4. Escribe un mensaje en el panel privado.
5. Si pides un destino tipo `spawbot-2`, el bot puede moverse a ese punto.

## Guia rapida para admins

1. Abre `Room Settings`.
2. Activa:
- `Enable bots`
- `Bot Count` (0 a 5)
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

## Limites del MVP (intencionales)

- Maximo `5` bots por sala.
- Capacidad global low-cost: `1` sala activa con runner tecnico a la vez.
- Si otra sala activa bots mientras hay una ya activa, puede quedar en estado de capacidad ocupada (`queued_capacity`) hasta liberar runner.

## Troubleshooting

## No aparecen bots

1. Verifica que `Enable bots` esta activado en esa sala.
2. Verifica que `Bot Count` > 0.
3. Revisa que la feature global de bots/chat este habilitada en app config.
4. Revisa despliegue de `bot-orchestrator` en `hcce`.

## No responden en chat

1. Verifica que `Enable bot chat` esta activo en la sala.
2. Verifica que el usuario este autenticado (si aplica permisos de sala).
3. Verifica que `OPENAI_API_KEY` esta presente en secret/config.
4. Revisa logs de `bot-orchestrator` y `reticulum`.

## No se mueven o se mueven raro

1. Asegura que la escena tenga **al menos 2 waypoints** separados entre si.
2. Si hay paredes/objetos entre un waypoint y otro, el bot puede descartar ese enlace (raycast) y elegir otro.
3. Verifica que la sala no este en cola de capacidad por limite global del runner.

## Animaciones / avatares
- Los bots intentan usar avatares `featured` con tags `fullbody` o `rpm` (si existen).
- Si solo hay avatares normales sin esqueleto fullbody, el bot puede verse mas "rigido".

## Sala en cola de capacidad

- Es esperado con modo low-cost.
- Solo una sala con runner activo a la vez.
- Al liberar la sala activa (o desactivar bots), la siguiente sala en cola puede activarse.
