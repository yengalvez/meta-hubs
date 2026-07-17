# Sitting: validación y aceptación

## Estado actual

La implementación candidata tiene evidencia local, pero no tiene todavía
aceptación de navegador contra staging ni evidencia de despliegue/live.

Validación local registrada antes de la integración final:

- suites AVA del coordinador e identidad de waypoint correctas;
- Hubs: `npm run check` y lint dirigido correctos;
- pruebas dirigidas de Reticulum correctas;
- suite completa local de Reticulum correcta, incluidas sus propiedades y solo
  las exclusiones esperadas;
- Reticulum: compilación con warnings tratados como errores correcta.

Estos resultados no sustituyen la carrera real entre dos navegadores, la
revisión visual ni el cold-browser posterior al rollout.

## Precondiciones de staging

Antes del E2E:

1. Usar una sala staging desechable y vacía; no usar la sala principal.
2. Haber completado gates, commit/push, builds de GitHub Actions y resolución a
   digests para Reticulum y Hubs; staging no admite builds locales/in-cluster.
3. Crear el checkpoint exigido por `deployment/README.md` antes de cualquier
   mutación de una instalación compartida.
4. Desplegar en dos manifest generations: Reticulum v2/migración conservando el
   Hubs anterior, y solo después Hubs v2.
5. Confirmar que la respuesta de join anuncia `protocol: 2`,
   `supported: true`, `lease_ms: 15000` y `request_timeout_ms: 3000` para un
   cliente nuevo.
6. Publicar desde Spoke al menos una silla con `Disable motion`,
   `Can be occupied` y `Can be clicked`, y al menos un waypoint de salida que
   no sea asiento ni ocupable.
7. Confirmar que ambas sesiones ven la misma identidad persistente para la
   silla.

## Gates locales

Desde la raíz:

```bash
./scripts/verify-project.sh
./scripts/verify-project.sh --full
```

El gate completo enumera las pruebas Playwright pero no ejecuta el E2E remoto:
no existe una URL staging por defecto y no debe inventarse una.

Para validar el arnés sin acceder a una sala:

```bash
cd tests/browser
npm ci
npm run test:unit
npm run test:sitting -- --list
```

## E2E obligatorio de dos clientes

Cuando Reticulum y Hubs candidatos estén disponibles en staging:

```bash
cd tests/browser
SITTING_TEST_URL=https://staging.example/<room-id> npm run test:sitting
```

El helper rechaza URLs con credenciales, redirecciones a otro origen y destinos
remotos que no sean HTTPS o no estén marcados como
`staging|test|qa|preview|sandbox|dev`. No habilitar el opt-in de producción para
esta aceptación.

La prueba abre exactamente dos contextos Chrome aislados y debe demostrar:

1. Ambos entran y ven dos presencias.
2. Inventario de silla idéntico, con identidades publicadas no vacías y únicas,
   los tres flags obligatorios y ocupación inicial vacía.
3. Click sincronizado de Sit sobre la misma silla sin solape entre los intervalos
   sentados reconstruidos a partir de transiciones explícitas, no throttled y
   marcadas con tiempo epoch.
4. Exactamente un ganador estable y una sola reserva autoritativa.
5. Ambos clientes ven la misma pose sentada remota y la misma ocupación.
6. La posición del ganador queda dentro de la tolerancia del waypoint.
7. Stand publica la liberación, desactiva la pose y usa el waypoint no ocupable
   más cercano.
8. El perdedor puede reservar la silla liberada y ambos clientes ven primero su
   ocupación, ownership y pose remota en la posición del waypoint.
9. Tras esa barrera visual `occupied: true`, un cierre abrupto del ganador
   produce una transición observada a `occupied: false` en un máximo de
   2.5 segundos por terminación de canal. El lease de 15 segundos sigue siendo
   la protección ante una desconexión que el servidor no detecte de inmediato.
10. No hay warnings/errores de consola, excepciones de página, requests fallidas
    ni respuestas HTTP `>= 400`.

La ausencia de solape local se decide con el registro de transiciones
`sitting-state-changed`, que se contrasta con `player-info`. `componentchanged`
está limitado internamente por A-Frame y solo aporta una señal secundaria de
coherencia. El muestreo cruzado cada 25 ms conserva snapshots acotados del estado
autoritativo público/privado, pero no se presenta como cobertura de cada frame.

La captura `remote-seated-pose.png` debe revisarse manualmente. La tolerancia
automatizada detecta desplazamientos graves, pero no certifica intersecciones
entre cuerpo, ropa, mesa y silla.

## Matriz adicional de protocolo

### Concurrencia e idempotencia

- Dos `reserve` simultáneos para el mismo `(hub, waypoint)` producen un `ok` y
  un `occupied`.
- Repetir el mismo fingerprint y `request_seq` devuelve exactamente la misma
  respuesta, también si era error.
- Una secuencia inferior o igual con fingerprint distinto devuelve
  `stale_request`.
- Cambiar de silla libera públicamente la anterior y reserva la nueva como una
  operación serializada.
- Un timeout de reserve dispara el reintento exacto y una compensación de
  release si no se confirmó la autoridad.

### Lease, pestañas y canales

- `renew` conserva `reservation_id`, cambia `operation_id` y extiende el lease.
- La pérdida de renovación saca al usuario de la silla y no conserva ocupación
  por NAF.
- Dos pestañas duplicadas tienen `client_instance_id` distintos.
- Un canal migrado conserva la instancia; el canal anterior recibe
  `stale_channel`.
- Un reserve aceptado por el servidor cuyo caller queda cancelado durante la
  migración reaparece solo como cleanup huérfano: `current` local es nulo, no
  existe timer de renovación y el canal nuevo envía release para el mismo
  `reservation_id`.
- La intención de Stand se registra antes de ejecutar la cola; una migración
  inmediata no puede rehidratar ni renovar ese mismo lease desde el snapshot.
- Solo un claim local aún vigente puede adoptar el mismo waypoint y
  `reservation_id` tras migrar, conservando su `claimId`.
- Una nueva instancia en la misma sesión invalida y libera la reserva anterior.
- Terminar un canal obsoleto no libera el lease del canal nuevo.
- Una expiración observada publica `occupied: false` y permite reclamar.

### Compatibilidad fail-closed

- Hubs con protocolo 2 frente a Reticulum anterior: Sit no mueve a una silla
  ocupable.
- Hubs v2 con join legacy/no negociado: `supported: false` y Sit fail-closed.
- Hubs anterior con Reticulum v2: join compatible, pero su estado NAF no es una
  concesión autoritativa; no se acepta el uso de sillas en la ventana mixta.
- Join con protocolo 1 o con forma/UUID inválidos: `supported: false`.
- `bot_runner`: reservas no soportadas y mutaciones rechazadas.
- Sesión fuera del estado de entrada/sala: mutación rechazada.

### UX y regresiones

- Replies Phoenix `ok` contradictorios (`status`, `reason`, `occupied` o
  `expires_at`) se rechazan aunque sus UUID y `request_seq` correlacionen.

- Click directo, botón Sit y navegación por hash solicitan reserva antes de
  mover a un waypoint ocupable.
- Una silla ocupada muestra el estado visual igual en cliente clásico y bitECS.
- Stand nunca selecciona otro waypoint ocupable.
- Idle/walk y third-person siguen funcionando al levantarse.
- Mobile puede salir cuando la escena está authorizada con el waypoint seguro;
  revisar también el efecto de `Disable teleporting`.
- En avatar full-body, el observador ve la pose final de `mixamo-sit`.

## Promoción posterior a staging

Las imágenes ya se construyeron por Actions y se fijaron por digest antes de
staging. Solo después de que staging sea completamente correcto se pueden
promover esos mismos digests a producción: checkpoint+rotación, generación y
`kubectl diff`, apply Reticulum-first/Hubs-second, restart de Reticulum tras
Hubs y verificación live. La aceptación requiere también cold desktop/mobile y
`./deployment/verify-live-reactivation.sh` con cero fallos y cero warnings.

Esta sección define el gate futuro; no afirma que se haya ejecutado.
