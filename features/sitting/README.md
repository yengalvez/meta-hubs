# Sitting (Waypoints + Sit/Stand)

## Objetivo
Permitir que los usuarios se sienten en Hubs usando waypoints ya existentes (sin modificar Spoke):

- Un waypoint con **"Disable motion"** activado se interpreta como **asiento**.
- Al llegar a un asiento, el avatar reproduce la animacion **sit** y se queda en la pose final.
- Se anade un boton en la toolbar: **Sit** / **Stand**.

## Como authorizar "sillas" en Spoke
En Spoke, crea un waypoint en la posicion/orientacion donde quieres sentar al usuario y activa:

- `Disable motion` (obligatorio): marca ese waypoint como asiento.
- `Can be occupied` (recomendado): evita que dos usuarios ocupen la misma silla (si el waypoint esta networked).
- `Can be clicked` (opcional): si quieres que el icono de waypoint sea interactuable cuando la escena esta frozen.

Notas:
- En mobile, Hubs evita deshabilitar motion si no hay manera clara de salir. Si quieres que en mobile tambien quede "bloqueado", activa tambien `Disable teleporting`.

## Boton Sit / Stand
- **Sit**: busca el waypoint-asiento mas cercano a menos de `2.0m` y te mueve a ese waypoint.
- **Stand**: te saca del asiento y te mueve al waypoint mas cercano que **NO** tenga `Disable motion`.
  - Si no hay waypoints no-asiento, hace fallback a spawn.

## Limitaciones actuales
- En `vr-mode` el boton esta deshabilitado (MVP).
- La animacion solo se aplica a avatares con esqueleto Mixamo/RPM (full-body). En avatares que no tienen piernas, no hay pose sentada.

