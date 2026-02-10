# Testing checklist

## Spoke authoring
- Crear un waypoint con:
  - `Disable motion = true`
  - (opcional) `Can be occupied = true`
  - (opcional) `Disable teleporting = true` (recomendado en mobile)

## Cliente (local)
1. Entrar en una sala con un waypoint-asiento.
2. Pulsar boton **Sit** cerca del waypoint:
   - Te mueve al waypoint.
   - Al llegar, el avatar hace la transicion a sentado y se queda en la pose final.
3. Pulsar boton **Stand**:
   - Vuelves a pose normal (idle/walk).
   - Te mueve al waypoint mas cercano que NO sea asiento.
4. Click manual en el waypoint-asiento (si procede):
   - Debe activar el modo sentado igual.
5. Multiusuario:
   - El otro usuario debe ver tu pose sentada (no solo "quieto").

## No regresiones
- Idle/walk de RPM sigue funcionando igual que antes.
- Third-person toggle sigue funcionando.

