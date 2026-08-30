# Sitting (waypoints + Sit/Stand)

## Objetivo

Permitir que una persona se siente en un waypoint de Spoke y garantizar que una
misma silla no pueda quedar asignada a dos sesiones a la vez.

El diseño candidato ya no usa la propiedad NAF del waypoint como fuente de
verdad. La exclusión se resuelve en Reticulum mediante el protocolo Phoenix de
reservas de waypoint v2 y leases persistidos en PostgreSQL. El estado NAF se
mantiene solo como representación derivada para compatibilidad visual.

> Estado: **aceptado en producción**. Las fuentes están congeladas en Hubs
> `b2697e7` y Reticulum `6d9ee9e`; browser **12/12**, Hubs **48/48** y
> Reticulum **20/20** pasan. La carrera real de dos navegadores pasó en staging
> y sus mismos digests se promovieron a producción tras checkpoint y diff. El
> runtime terminó con **12/12 Deployments Ready**, verificador live **0/0** y
> navegador frío desktop/móvil con reserva y pose sentada confirmadas. El
> staging temporal ya no existe y no queda coste adicional.

## Cómo authorizar una silla en Spoke

Cada silla debe ser un waypoint publicado con:

- `Disable motion = true`: hace que el avatar permanezca sentado.
- `Can be occupied = true`: hace que el waypoint sea reservable y, por tanto,
  elegible como silla.
- `Can be clicked = true`: forma parte del contrato de escena y permite usar el
  waypoint una vez cargada la sala.
- `Disable teleporting = true` cuando también se quiera bloquear el teletransporte,
  especialmente en mobile.

`Disable motion` sin `Can be occupied` ya no define una silla válida para el
botón **Sit**. Un asiento necesita una identidad de red estable publicada desde
Spoke; esa identidad del waypoint es la que usa Reticulum como `waypoint_id`.
No se deben clonar o recrear waypoints entre una prueba y otra suponiendo que
conservarán la misma identidad.

## Experiencia Sit / Stand

- **Sit** busca la silla válida más cercana a menos de `2.0 m`, solicita su
  reserva al servidor y solo inicia el movimiento después del `ok` autoritativo.
- Si otra sesión gana la misma silla, el perdedor permanece de pie y puede
  probar otra silla.
- La pose sentada se replica mediante `player-info.isSitting`, de modo que el
  resto de clientes ve la misma pose.
- **Stand** libera la reserva y mueve al usuario al waypoint más cercano que no
  sea asiento ni sea ocupable. Si no existe, usa un spawn no ocupable o, como
  último recurso, el origen.
- Si se pierde o vence el lease, el cliente deja de usar la silla, cancela el
  travel pendiente y sale a un destino no ocupable.
- Al desconectarse el canal autoritativo, Reticulum libera la reserva; el lease
  de 15 segundos es la red de seguridad ante desconexiones que no puedan
  procesarse limpiamente.

## Compatibilidad y comportamiento seguro

- El cliente anuncia `waypoint_reservation: { protocol: 2,
  client_instance_id }` al unirse al canal Phoenix.
- Un Reticulum anterior, un join que omita el contrato o un join inválido
  producen capacidad no soportada. Hubs v2 falla cerrado: no permite sentarse
  en una silla reservable sin autoridad del servidor.
- Un Hubs realmente anterior no conoce el protocolo y no puede ofrecer esa
  garantía. Durante la ventana de versión mixta no se acepta ni se prueba el uso
  de sillas; el rollout de Hubs debe seguir inmediatamente al de Reticulum.
- Los bot runners no participan en el protocolo de reservas.
- El cliente clásico y el cliente bitECS consumen la misma fuente autoritativa.
- Cada pestaña genera una identidad de instancia distinta en memoria; las
  migraciones de socket de esa página conservan la identidad.
- Tras una migración, el cliente solo conserva y renueva `current` si coincide
  con el mismo lease y claim local que seguía sentado. Un snapshot nuevo,
  cambiado o marcado previamente por Stand se trata como huérfano: no se
  expone como asiento local, no se renueva y se libera condicionalmente en el
  canal nuevo.
- En `vr-mode` el botón continúa deshabilitado.
- La animación requiere un avatar full-body compatible con el esqueleto de las
  animaciones compartidas. Un avatar sin piernas puede no mostrar la pose
  completa aunque la reserva sea correcta.

## Orden de rollout obligatorio

1. Completar gates locales, commit/push y construir Reticulum y Hubs mediante
   GitHub Actions. Resolver ambos artefactos a digests antes de desplegar
   staging.
2. En staging, generar/aplicar primero un manifiesto que cambie Reticulum y su
   migración pero conserve el digest Hubs anterior.
3. Verificar que el Reticulum nuevo mantiene compatible el join legacy y
   anuncia `supported: false`; no abrir la aceptación de sillas mientras quede
   el cliente anterior.
4. Regenerar/aplicar después staging con el digest Hubs v2 y ejecutar la prueba
   de dos navegadores en una sala vacía, incluida la revisión de pose remota.
5. Tras aceptar staging, crear el checkpoint de producción y completar la
   rotación/preflight exigidos por `deployment/README.md`.
6. Promover exactamente los mismos digests a producción en dos generaciones:
   primero Reticulum conservando Hubs anterior; después Hubs v2.
7. Reiniciar Reticulum tras el cambio Hubs para renovar HTML/assets y completar
   cold desktop/mobile más el verificador live 0/0.

El orden inverso deja al cliente nuevo sin autoridad de reservas y por diseño
impide sentarse. No se permite construir directamente en staging o el cluster:
ambos entornos consumen imágenes de Actions fijadas por digest. El rollback
compatible es volver primero el cliente Hubs; el Reticulum nuevo puede
permanecer mientras atiende clientes legacy. Revertir la migración con datos
activos no forma parte del rollback normal.

## Referencias

- Contrato técnico: `features/sitting/IMPLEMENTATION.md`.
- Matriz de pruebas y estado de aceptación:
  `features/sitting/TESTING.md`.
- Flujo de despliegue y recuperación: `deployment/README.md`.
