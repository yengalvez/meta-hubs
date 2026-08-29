# Sitting: validación y aceptación

## Estado actual

La implementación candidata, congelada en Hubs `b2697e7` y Cloud/Reticulum
`6d9ee9e`, tiene validación local y aceptación real de navegador en staging. El
30 de agosto de 2026 el E2E final pasó **1/1 en 47,1 s** sobre la sala temporal
`3E2enaA`, después de desplegar las dos imágenes por digest.

Validación focal actual:

- arnés browser: **12/12** unidades y exactamente un E2E Sitting;
- Hubs: `npm run check`, lint dirigido y las cinco familias AVA Sitting
  **48/48**;
- Reticulum: dependencias locked, format y compilación estricta correctos; las
  dos suites de reserva/modelo y canal pasan **20/20** contra PostgreSQL local;
- composición: **2/2** gitlinks, diff-check y árboles root/Hubs/Cloud limpios.

No cambió ningún byte de producto durante esta validación. El arnés browser sí
se endureció para reconocer el host staging exacto, usar micrófono falso y
conservar el detalle de cualquier diagnóstico inesperado. Los avisos de datos
Browserslist y de compilación de dependencias legacy fueron no first-party y
los comandos estrictos terminaron con código cero.

La carrera real de dos navegadores ya pasó. El cold-browser posterior al rollout
productivo y la inspección estética de la pose siguen siendo gates de S5.

## Precondiciones de staging

La ejecución S4 completó estas precondiciones:

1. Usar el clúster temporal separado `yenhubs-sitting-staging`, DOKS
   `1.34.10-do.2` en `ams3`, Namespace `hcce` y dominio
   `staging.meta-hubs.org`; no compartir clúster/ingress con producción.
2. Usar una sala staging desechable y vacía; no usar la sala principal.
3. Haber completado gates, commit/push, builds de GitHub Actions y resolución a
   digests para Reticulum y Hubs; staging no admite builds locales/in-cluster.
4. Crear el checkpoint exigido por `deployment/README.md` antes de cualquier
   mutación de una instalación compartida.
   El target greenfield y desechable no contiene datos de cliente y no necesita
   checkpoint; producción sí lo exigirá en S5.
5. Desplegar en dos manifest generations: Reticulum v2/migración conservando el
   Hubs anterior, y solo después Hubs v2.
6. Confirmar que la respuesta de join anuncia `protocol: 2`,
   `supported: true`, `lease_ms: 15000` y `request_timeout_ms: 3000` para un
   cliente nuevo.
7. Publicar desde Spoke al menos una silla con `Disable motion`,
   `Can be occupied` y `Can be clicked`, y al menos un waypoint de salida que
   no sea asiento ni ocupable.
8. Confirmar que ambas sesiones ven la misma identidad persistente para la
   silla.
9. Preservar evidencia no secreta y retirar clúster, nodo, LB, volúmenes y los
   dos firewalls DOKS gestionados antes de `23 h 30 min`, con readback de
   ausencia. Esto quedó cumplido. Los cuatro DNS no facturables permanecen
   temporalmente apuntando a la IP retirada hasta reautenticar IONOS.

## Receta de build candidata

Esta receta quedó ejecutada y fijada por digest:

- Hubs `b2697e7`: workflow `custom-docker-build-push`, run `33245207737` y
  digest `ghcr.io/yengalvez/hubs@sha256:e8f9423ace1bf4108ae5a7ce59c1b45cf0b44b74ea944fdb82fee47e4d7be5b0`.
- Cloud/Reticulum `6d9ee9e`: workflow `custom-docker-build-push` con
  `Override_Repo_Name=reticulum`,
  `Override_Code_Path=community-edition/services/reticulum` y
  `Override_Dockerfile=community-edition/services/reticulum/Dockerfile`; run
  `33244980400` y digest
  `ghcr.io/yengalvez/reticulum@sha256:256c292d0d5a69e021322bdbd11b3f318f2d44bee580433252e0b04ade1d5e18`.
- Ambos resultados deben resolverse a `repository@sha256:<digest>` y quedar
  ligados al run y commit exactos antes de generar un manifiesto.

Los `master` remotos apuntan exactamente a esos dos commits verificados y los
workflows están activos. Los repos son públicos y usan `ubuntu-latest`
estándar, por lo que sus minutos no son facturables. Antes del dispatch se
revalida una vez esa identidad; no se lanza otro run sobre los mismos bytes sin
una causa nueva.

`deployment/prepare-staging-values.mjs` deriva desde la plantilla moderna dos
values privados: Reticulum-first conserva el Hubs live anterior y Sitting v2
cambia solo el digest Hubs. Copia únicamente admin/SMTP, genera todas las claves
internas de staging y nunca imprime secretos.

## Gates locales

Durante una iteración con cambios de producto, el gate rápido desde la raíz es:

```bash
./scripts/verify-project.sh
```

Un candidato final cuyos bytes de producto hayan cambiado ejecuta una sola vez:

```bash
./scripts/verify-project.sh --full
```

`--full` ya incluye el bloque normal: no deben ejecutarse ambos consecutivamente
sobre los mismos bytes. En el corte actual no se repitió `--full` porque no hubo
cambio de producto y su evidencia final seguía aplicando. El gate completo
enumera Playwright pero no ejecuta el E2E remoto: no existe una URL staging por
defecto y no debe inventarse una.

Para validar el arnés sin acceder a una sala:

```bash
cd tests/browser
npm ci
npm run test:unit
npm run test:sitting -- --list
```

## E2E obligatorio de dos clientes

La ejecución final fue:

```bash
cd tests/browser
SITTING_TEST_URL=https://staging.meta-hubs.org/3E2enaA/worldly-belated-volume npm run test:sitting
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
10. No hay diagnósticos inesperados: excepciones de página, fallos first-party,
    requests fallidas ni respuestas HTTP `>= 400`. Se excluyen solo firmas
    exactas y unit-tested del baseline: `HEAD` abortado, `/favicon.ico` 404,
    estados AEC, ausencia de la animación opcional `allOpen` y deprecación
    legacy del componente `background`.

La ausencia de solape local se decide con el registro de transiciones
`sitting-state-changed`, que se contrasta con `player-info`. `componentchanged`
está limitado internamente por A-Frame y solo aporta una señal secundaria de
coherencia. El muestreo cruzado cada 25 ms conserva snapshots acotados del estado
autoritativo público/privado, pero no se presenta como cobertura de cada frame.

La captura `remote-seated-pose.png` fue revisada: la geometría/cámara no encuadró
al avatar remoto. La tolerancia automatizada sí probó posición, ownership y
pose coherentes en ambos clientes, pero no certifica intersecciones entre
cuerpo, ropa, mesa y silla. Esa inspección estética se traslada explícitamente
al cold-browser de S5 y no justifica recrear staging por una fotografía.

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
