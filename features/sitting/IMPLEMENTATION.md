# Sitting: implementación candidata

## Resumen técnico

La feature combina tres contratos:

1. Spoke publica waypoints con identidad de red estable y flags de asiento.
2. Reticulum serializa las reservas por sala y persiste leases autoritativos.
3. Hubs solicita, renueva y libera el lease antes de reflejar la ocupación en
   A-Frame o bitECS y antes de activar la pose sentada.

La fuente de verdad de exclusión es Reticulum/PostgreSQL. El estado
`NetworkedWaypoint.occupied` o `waypoint.isOccupied` es una proyección para UI y
compatibilidad; nunca concede autoridad.

## Contrato de escena

Una silla es un waypoint con las dos propiedades siguientes:

- `willDisableMotion === true` (`Disable motion` en Spoke);
- `canBeOccupied === true` (`Can be occupied` en Spoke).

Para la aceptación de YenHubs también se exige `canBeClicked === true`. El
identificador de reserva es el `networked.id` persistente publicado por Spoke
para ese waypoint, independientemente del loader usado por Hubs. El servidor
limita `waypoint_id` a 512 bytes.

Stand nunca elige un waypoint con `willDisableMotion` o `canBeOccupied`. Esto
evita liberar una silla y caer accidentalmente sobre otro punto reservable.

## Protocolo Phoenix v2

### Negociación de capacidad

El cliente humano añade al join de `hub:<hub_sid>`:

```json
{
  "waypoint_reservation": {
    "protocol": 2,
    "client_instance_id": "<uuid-de-la-pestaña>"
  }
}
```

La respuesta del join devuelve una capacidad privada con:

- `protocol`, `supported`, `lease_ms` y `request_timeout_ms`;
- snapshot público `active` de la sala, con `state_version` monotónica por
  waypoint;
- lease privado `current`, si esta sesión ya lo posee;
- barrera global `snapshot_state_version`, tomada dentro del mismo lock después
  de construir el snapshot;
- siguiente base monotónica `request_seq`.

La identidad de instancia se crea en memoria para que dos pestañas duplicadas
no compartan UUID. Se conserva durante las migraciones de socket de esa página.
Reticulum añade además una identidad de canal; un canal reemplazado queda
obsoleto y no puede modificar el lease.

Un join legacy, inválido o de `bot_runner` recibe `supported: false`. Hubs v2
falla cerrado cuando la capacidad no está disponible. Un Hubs anterior al
protocolo puede ignorar esa capacidad y conservar su comportamiento NAF local;
por eso la ventana mixta no es una ventana de aceptación de sillas.

### Mutaciones

Las acciones `reserve`, `renew` y `release` se envían mediante
`waypoint_reservation:request`. Cada petición contiene exactamente:

```json
{
  "protocol": 2,
  "action": "reserve|renew|release",
  "waypoint_id": "<identidad Spoke>",
  "operation_id": "<uuid de esta operación>",
  "reservation_id": "<uuid estable del lease>",
  "request_seq": 1
}
```

- `request_seq` crece de forma monotónica por sesión.
- `operation_id` identifica cada intento lógico.
- `reservation_id` permanece estable durante reserve/renew/release del mismo
  lease.
- Reticulum cachea la respuesta exacta del último fingerprint, incluidos los
  errores, para que un reintento tras timeout sea idempotente.
- Cada mutación aceptada obtiene una `state_version` global monotónica desde
  PostgreSQL. La respuesta correlacionada, el snapshot y el broadcast público
  la incluyen; Hubs ignora versiones iguales o anteriores para que un mensaje
  reordenado entre réplicas no pueda revocar una concesión más nueva.
- La barrera `snapshot_state_version` también cubre waypoints ausentes del
  snapshot: un broadcast anterior al join no puede reactivar una silla que ya
  estaba libre cuando se tomó la instantánea.
- El cliente espera hasta 3 segundos y reintenta una vez la misma operación.
  Un reserve sin confirmación se compensa con un release correlacionado.
- Un reply Phoenix `ok` se acepta únicamente si además declara `status: ok`,
  `reason: null` y semántica coherente: reserve/renew ocupados con vencimiento
  parseable, o release libre con vencimiento nulo. Correlación y versión por sí
  solas no conceden autoridad.

El servidor responde de forma correlacionada y emite
`waypoint_reservation:state` sin identidad de usuario. Solo `current`, enviado
de forma privada al propietario, contiene los UUID del lease.

## Modelo de datos y concurrencia

La tabla `ret0.waypoint_reservations` mantiene una fila por sala/sesión. Una fila
activa guarda el waypoint, la instancia, el canal, los UUID de operación y
reserva, el vencimiento y la respuesta idempotente. Una fila liberada queda como
tombstone para rechazar secuencias antiguas; los tombstones inactivos se purgan
después de siete días al registrar actividad de la sala.

Las invariantes principales son:

- índice único parcial por `(hub_id, waypoint_id)` para leases activos;
- índice único por `(hub_id, session_id)` para una reserva por sesión;
- campos de lease completos o todos nulos;
- secuencia y contador de rate limit no negativos.

Cada operación se ejecuta dentro de una transacción protegida por advisory lock
de la sala. Así, dos reservas simultáneas del mismo waypoint se ordenan antes de
consultar o escribir PostgreSQL. Solo una obtiene `ok`; la otra recibe
`occupied`.

El servidor permite 30 peticiones por 10 segundos por sesión. Las mutaciones
solo se autorizan mientras la sesión está en estado de sala/entrada y se
rechazan para bot runners.

## Lease y desconexión

- Duración del lease: 15 segundos.
- Hubs renueva antes del vencimiento y limita localmente cualquier timestamp
  recibido al máximo del lease negociado.
- La expiración autoritativa se limpia al registrar o procesar actividad y se
  publica como `occupied: false`.
- `terminate/2` libera inmediatamente solo si el canal que termina sigue siendo
  el canal autoritativo de esa sesión.
- Si una nueva instancia toma la misma sesión, invalida el canal anterior y
  libera su silla.
- Si se pierde una renovación, Hubs deja de presentarse como sentado y se mueve
  a un waypoint no ocupable; no prolonga el estado por NAF.

## Integración en Hubs

`WaypointReservationCoordinator` mantiene el snapshot público, el lease privado,
la cola serial de acciones, los reintentos, la renovación y la detección de
pérdida. `HubChannel` expone las operaciones al resto del cliente y reinstala el
binding tras una migración de canal.

La intención de abandonar un lease se registra de forma síncrona al invocar
`release`, antes de que la operación entre en la cola. Al recibir un snapshot
privado tras migrar, el coordinador solo adopta `current` si waypoint,
`reservation_id` y claim local anterior siguen siendo los mismos y no existe
esa intención de abandono. Cualquier lease desconocido, cambiado o abandonado
queda fuera de `current`, nunca programa `renew` y ejecuta un release
condicional en el canal autoritativo nuevo. Si ese cleanup no se confirma, el
lease vence sin renovación.

Tanto el sistema A-Frame como bitECS:

- extraen la identidad persistente del waypoint;
- solicitan `reserve` antes de moverse a un waypoint ocupable;
- usan el estado del coordinador para el color/ocupación visual;
- liberan al abandonar el waypoint, hacer Stand o viajar a otro destino;
- cancelan movimiento y ejecutan el fallback seguro si pierden autoridad.

La UI Sit filtra `Disable motion && Can be occupied`. La UI Stand filtra
`!Disable motion && !Can be occupied`. El estado
`player-info.isSitting` continúa replicando la pose remota y
`fullbody-locomotion` reproduce `mixamo-sit` una vez y mantiene su pose final.

## Compatibilidad, rollout y rollback

Ambas imágenes se construyen primero por GitHub Actions y se resuelven a
digests. Después, el servidor v2 se despliega antes que Hubs v2. Mantiene
compatible el join de
clientes que no negocien el protocolo y devuelve capacidad no soportada, pero
no convierte su estado NAF en una concesión autoritativa. Hubs v2 frente a un
servidor anterior falla cerrado y no entra en una silla reservable. Un Hubs
antiguo no puede garantizar exclusión; durante ese intervalo no debe aceptarse
uso de sillas y el despliegue del cliente debe seguir inmediatamente.

Después de desplegar Reticulum hay que confirmar migración y compatibilidad
legacy; después se despliega Hubs y se ejecuta el E2E de dos clientes en
staging. No se ha ejecutado todavía esa aceptación staging ni existe evidencia
de despliegue/live para este candidato.

Para un rollback rápido, volver Hubs al cliente anterior antes de considerar
Reticulum. Mantener la tabla y Reticulum v2 evita una migración destructiva; su
retirada se planifica aparte y solo cuando no haya leases activos.

## Superficie principal

Hubs:

- `src/utils/waypoint-reservation-coordinator.js`;
- `src/utils/hub-channel.js` y `src/utils/hub-utils.js`;
- sistemas de waypoint A-Frame y bitECS;
- `src/scene-entry-manager.js` y entrada de sala;
- `src/react-components/ui-root.js`;
- `player-info`, `character-controller-system` y `fullbody-locomotion` para la
  pose.

Reticulum:

- `lib/ret/waypoint_reservation.ex`;
- `lib/ret_web/channels/hub_channel.ex`;
- migración `create_waypoint_reservations`;
- pruebas unitarias y de canal asociadas.
