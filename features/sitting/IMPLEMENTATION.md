# Implementacion

## Resumen tecnico
La feature se implementa 100% en cliente (`hubs`) reutilizando el sistema de waypoints existente:

- "Asiento" = `willDisableMotion === true` (Spoke: "Disable motion").
- Se replica un flag `player-info.isSitting` para que otros clientes vean la pose sentada.
- `fullbody-locomotion` reproduce `mixamo-sit` (LoopOnce + clampWhenFinished) cuando `isSitting` esta activo.
- La toolbar ofrece un toggle Sit/Stand que mueve al waypoint asiento o sale al waypoint no-asiento mas cercano.

## Archivos tocados (hubs)
- `src/components/player-info.js`
  - Nuevo schema: `isSitting: { default: false }`
- `src/systems/character-controller-system.js`
  - `setSittingState(isSitting)`:
    - actualiza `#avatar-rig` -> `player-info.isSitting`
    - emite `scene.emit("sitting-state-changed", { isSitting })` para React UI
  - Al terminar un travel a waypoint:
    - `isSitting` se setea segun `activeWaypoint.waypointComponentData.willDisableMotion`
  - En `teleportTo(...)`:
    - `isSitting` vuelve a `false`
- `src/assets/animations/mixamo/sit.glb`
  - Clip base de Mixamo (Stand To Sit) convertido a GLB reducido (solo armature + animacion)
- `src/utils/mixamo-shared-animations.js`
  - Carga `sit.glb` junto con `idle.glb` y `walk.glb`
  - Para `sit` se permite un set de huesos mas amplio (incluye torso) manteniendo:
    - solo tracks quaternion (sin translations)
    - sin neck/head
- `src/components/fullbody-locomotion.js`
  - Si `player-info.isSitting`:
    - reproduce `sit` una vez y clampa la pose final
    - ignora idle/walk mientras este sentado
- `src/react-components/ui-root.js`
  - Boton toolbar Sit/Stand (fuera de VR)
  - Busca el waypoint mas cercano (A-Frame o bitECS) y viaja

## Evento UI
- Evento: `sitting-state-changed`
- Emisor: `CharacterControllerSystem`
- Consumidor: `UIRoot` (React)

