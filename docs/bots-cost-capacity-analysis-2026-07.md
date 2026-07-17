# Bots, coste y capacidad: analisis de julio de 2026

> Actualización del 17 de julio de 2026: `mobility: static` y navegación navmesh+A* están desplegadas y fueron
> aceptadas en producción el 16 de julio. Además existe un arnés reproducible para planificar y validar evidencia de
> 30/100 usuarios por sala, 300 totales y un modelo de 10.000, siempre con variantes de 0/5/10 bots. Su suite local
> valida contratos y bloqueos fail-closed. Incluye un driver Playwright confinado, pero el almacén de confianza
> versionado está vacío y toda ejecución
> física falla cerrada no solo por confianza: las 39 métricas de servidor carecen de productores/reglas/scrape
> revisados y también faltan HTTPS/auth del collector, aislamiento egress de host, identidad física de generadores,
> prueba cgroup de terminación, policy base-owned y fencing de Reticulum. La suite local valida esos bloqueos. No
> existe evidencia de carga ni certificación de capacidad para esos objetivos.

## Resumen ejecutivo

- La infraestructura actual cuesta aproximadamente **62 USD/mes** antes de impuestos, uso extra de red, snapshots,
  registro de contenedores y consumo de OpenAI.
- El `ghost runner` es la decision correcta para los bots: dos salas activas consumen en conjunto unos **134 MiB**
  de memoria de cgroup y una fraccion pequena de CPU. Un navegador Chromium por sala empeoraria mucho el coste y,
  además, no forma parte del runner autenticado.
- El diagnostico inicial encontro **cero `box-collider`** y trayectos rectos que atravesaban estructuras.
- La solución desplegada conserva el ghost runner y navega sobre el **navmesh de la escena**, proyectando puntos y
  calculando rutas A*. El endurecimiento candidato hace el navmesh obligatorio; colliders y trayectos directos quedan
  solo para compatibilidad legacy o diagnóstico explícito y no cuentan como estado ready.
- `mobility: static` mantiene bots inmoviles y rechaza acciones de navegacion. `low` conserva su significado de
  movilidad lenta.
- La instalacion actual no debe prometer 300 CCU. Hubs recomienda 25 personas dentro de una sala y documenta
  problemas en moviles por encima de 10. Treinta puede ser un objetivo de pruebas controladas; 100 avatares activos
  en una sola sala requeriria redisenar partes importantes del producto.
- El arnés versionado define rampas, plateau, evidencia por sala/worker, métricas y paradas provisionales. Incluye un
  driver Playwright y su suite prueba el confinamiento con un Chromium local sobre `about:blank`, pero no se ha
  conectado a Hubs ni a staging, no crea salas y no aprovisiona infraestructura. Un resultado generado con fixtures
  no es una medición.

## Estado medido

Medición realizada el 16 de julio de 2026:

| Recurso | Estado |
| --- | --- |
| Cluster | DOKS `hubs-ce`, Amsterdam `ams3`, Kubernetes `1.34.8-do.2` |
| Workers | 1 nodo Basic `s-4vcpu-8gb`, sin autoscaling |
| Control plane HA | No activado |
| Load balancer | 1 regional HTTP `lb-small` |
| Volumenes | 2 x 10 GiB |
| Deployments | 12/12 Ready |
| Reservas del nodo | 1297m CPU (33%) y 4002 MiB RAM (62%) |
| Limites de memoria | 9682 MiB (150%, overcommit intencional) |
| Bot backend | `ghost` |
| Capacidad configurada | 5 salas activas, 10 bots por sala |
| Estado observado | 2 salas activas, 0 en cola |
| Bot orchestrator | ~140 MB en cgroup con `app.js` y dos ghost runners |

Las reservas de Kubernetes no equivalen al consumo real: sirven para que el scheduler coloque pods. Para decidir un
escalado hay que instalar metricas y realizar pruebas de carga, no extrapolar solo desde `requests`.

## Coste actual estimado

| Concepto | Coste mensual |
| --- | ---: |
| Nodo Basic 8 GiB / 4 vCPU | 48 USD |
| Load balancer regional HTTP | 12 USD |
| 20 GiB de volumenes | 2 USD |
| Control plane DOKS | 0 USD |
| **Base estimada** | **62 USD/mes** |

No está habilitado el control plane HA, que añadiría 40 USD/mes. Los precios base se revalidaron el 17 de julio de
2026. El coste real puede variar por impuestos, snapshots, egress que exceda la cuota, registro y llamadas al LLM.

Fuentes oficiales consultadas:

- <https://www.digitalocean.com/pricing/droplets>
- <https://docs.digitalocean.com/products/kubernetes/details/pricing/>
- <https://www.digitalocean.com/pricing/load-balancers>
- <https://docs.digitalocean.com/products/volumes/details/pricing/>

Como referencias para una arquitectura futura, no incluidas en los 62 USD actuales, un Droplet Basic de 4 GiB/2
vCPU cuesta 24 USD/mes y uno de 16 GiB/8 vCPU cuesta 96 USD/mes. PostgreSQL administrado parte de 15,15 USD/mes para
1 GiB, 30,45 USD para 2 GiB y 60,90 USD para 4 GiB, antes de nodos adicionales y almacenamiento. Fuente oficial:
<https://www.digitalocean.com/pricing/managed-databases>.

## Arnés reproducible y límites de la evidencia

El contrato versionado está en `tests/capacity/` y tiene cinco escenarios:

| Escenario | Forma | Estado permitido |
| --- | --- | --- |
| `local-smoke` | 2 participantes en localhost | Plan seco; ejecución física bloqueada por readiness |
| `room-30` | 1 sala, 30 participantes | Protocolo de driver/shards; instrumentación física ausente |
| `room-100-experimental` | 1 sala, 100 participantes | Experimento no certificante; instrumentación física ausente |
| `total-300` | 12 salas de 25 | Protocolo distribuido; hosts físicos no atestados |
| `total-10000-model` | Modelo de arquitectura | Nunca produce plan físico |

Cada escenario físico exige elegir exactamente 0, 5 o 10 bots por sala. El plan fija una semilla, identidades únicas,
rampa, plateau y descenso. El esquema exige series exactas de cliente/WebRTC por participante durante el plateau y una
muestra de join por participante; no afirma telemetría de descenso. Para servidor, Kubernetes, bots y generadores solo
existe el contrato requerido: no hay productores Prometheus, reglas, inventario de scrape ni atestación física externa
capaces de satisfacerlo. El adaptador local ya deriva contadores desde series raw y reset explícito, exige inventario
exacto y ventana ligada al run, agrega buckets antes del percentil y pondera ratios por numerador/denominador; aun así
permanece bloqueado porque esas fuentes reales no existen. Cada bundle liga además machine/boot/cgroup/root PID y la
prueba post-STOP de cero procesos al plan, run y host, y el loader la revalida. Los joins
usan exactamente el inicio firmado del plateau; los eventos de fase conservan el instante real de cada transición.
Los límites son provisionales y cualquier criterio de parada invalida la pretensión de capacidad.

Las defensas actuales son deliberadas:

- no hay destino por defecto;
- producción y todos sus subdominios están denegados;
- un destino remoto debe ser HTTPS y estar marcado como staging/test/QA/preview/sandbox/dev;
- no se acepta un `--driver` arbitrario ni acknowledgements antiguos; `--execute` exige el plan firmado exacto, el
  ACK ligado al plan y todos los artefactos revisados, y hoy falla cerrado porque no hay ninguna clave pública de
  propietario en `trust-anchors.json`;
- el navegador bloquea service workers y confina HTTP(S), WebSocket y la configuración ICE efectiva, incluidas
  construcciones alias y cambios posteriores con `setConfiguration`; es confinamiento de aplicación, no aislamiento
  egress del host;
- no existe código que invoque `kubectl`, cree recursos de nube o lance un ejecutable arbitrario;
- `physical-readiness.json` enumera cada prerrequisito ausente y exige además identidades de policy/revisión
  materializadas fuera del cambio candidato;
- el modelo actual de 10.000 devuelve `INSUFFICIENT`, sin nodos ni costes, además de `certified: false` y
  `physicalExecutionAllowed: false`.

La siguiente fase exige una clave Ed25519 externa revisada; productores, reglas, scrape e inventario Prometheus
reales; timestamp de fuente, resets y scope de run; collector HTTPS con TLS/auth; aislamiento egress de host;
identidad física/cgroup y prueba de cero procesos; y arbitraje/fencing de base de datos antes de más de una réplica de
Reticulum. Policy y atestación de readiness deben proceder del baseline controlado por el propietario. También hacen
falta presupuesto, ventana y revisión independiente. Hasta entonces no hay un `PASSED` físico posible.

## Diagnostico historico: por que atravesaban estructuras

El ghost runner:

1. Descarga el GLB de la escena.
2. Extrae waypoints `spawbot-*`.
3. Busca componentes Spoke `box-collider`.
4. Eleva el segmento 0,20 m y comprueba si cruza uno de esos volumenes.
5. Si no hay colliders, usa el fallback `allow`.

Los logs de las dos salas activas muestran:

```text
No box-colliders found in scene. Raycast fallback -> allow.
Waypoints: all=11 spawn=8 patrol=8 colliders=0
```

Ese era el comportamiento anterior. El ghost runner nuevo usa el `nav-mesh` generado por el Floor Plan, calcula una
ruta A* y publica sus tramos consecutivos. En la configuración operativa candidata, un navmesh ausente o inválido
impide declarar la sala ready y provoca reintentos/reinicio limpio; no autoriza movimiento directo.

## Opciones para corregir la navegacion

### Opcion A: `box-collider` en Spoke

La mas rapida y sin codigo de runtime:

- Anadir colliders a paredes, muebles grandes y limites.
- Colocar waypoints de forma que existan enlaces rectos despejados.
- El ghost runner actual descartara un destino si la linea lo cruza.

Ventajas:

- Coste de CPU practicamente nulo.
- Compatible como ayuda de authoring/diagnóstico con escenas legacy.
- Riesgo tecnico bajo.

Limitaciones:

- Solo sabe que el trayecto esta bloqueado; no calcula como rodearlo.
- Requiere authoring manual cuidadoso.
- Una linea no representa el volumen completo del avatar.

### Opcion B: grafo explicito de waypoints

Guardar enlaces permitidos entre waypoints y mover bots solo por esas aristas.

Ventajas:

- Muy barato y determinista.
- Facil de validar en escenas importantes.
- No necesita parsear toda la geometria.

Limitaciones:

- Trabajo manual por escena.
- Spoke no ofrece hoy una UX nativa para enlazarlos; haria falta convencion o metadata propia.

### Opcion C: navmesh + A* en el ghost runner (implementada)

1. Extraer el navmesh existente del GLB.
2. Proyectar cada waypoint y posicion de bot sobre el navmesh.
3. Construir un grafo navegable.
4. Calcular una ruta A* al elegir destino.
5. Publicar una secuencia de segmentos `bot-path`.
6. Aplicar margen de agente y separacion/reserva entre bots.

Ventajas:

- Rodea paredes en vez de limitarse a rechazar el destino.
- Mantiene Node sin Chromium.
- El calculo ocurre al escoger ruta, no cada frame.
- Escala bien para 5 salas y 10 bots si se cachea el navmesh por escena.

Validacion realizada sobre la escena live recuperada:

- 350 triangulos y 11 grupos de navmesh parseados.
- 11 waypoints y 8 `spawbot-*` proyectados.
- 56 de 56 rutas dirigidas entre los ocho puntos disponibles.
- Descarga parcial por HTTP Range del JSON GLB y los buffers necesarios.
- Limites fail-closed de triangulos, puntos por ruta y distancia de proyeccion.

Siguen siendo casos de regresion para futuras escenas: escaleras, enlaces desconectados, waypoints fuera de malla e
invalidacion al publicar una version nueva.

### Opcion D: raycast sobre triangulos/BVH

Detecta mas obstaculos que los colliders, pero sigue sin calcular una ruta alternativa. Es util como guardarrail, no
como solucion completa de navegacion.

### Opcion E: fisica completa o Chromium

No recomendada. Un motor físico por bot o un navegador por sala aumentan CPU/RAM y complejidad sin resolver mejor el
authoring. Chromium se conserva solo como diagnóstico browser legacy/local sin `--runner`: el renderer no recibe
`BOT_RUNNER_ACCESS_KEY`, no puede autenticarse contra Reticulum endurecido y no cuenta para readiness. La clave nunca debe
pasarse por URL ni por estado cliente.

## Bots inmoviles

`mobility: "static"` esta implementado de extremo a extremo:

- `Room Settings`
- validacion de Reticulum
- contrato del orchestrator
- ghost runner
- documentacion y pruebas

Comportamiento actual:

- El bot aparece en su `spawbot-*` asignado.
- No selecciona destinos automaticos.
- Mantiene orientacion configurable.
- Sigue permitiendo chat.
- Una accion LLM `go_to_waypoint` se rechaza por defecto mientras sea estatico.

Como segunda iteracion futura conviene permitir configuracion por bot:

```json
{
  "id": "recepcion",
  "anchor": "spawbot-recepcion",
  "mobility": "static",
  "prompt": "Eres el agente de recepcion."
}
```

Esto permite mezclar recepcionistas inmoviles y bots patrullando en la misma sala.

## Capacidad realista

La documentacion oficial de Hubs recomienda un maximo de 25 participantes dentro de una sala. Tambien indica que el
limite de eventos puede subirse de 24 a 30, pero avisa de problemas en dispositivos moviles por encima de 10:

- <https://docs.hubsfoundation.org/hubs-faq>
- <https://docs.hubsfoundation.org/intro-events>
- <https://docs.hubsfoundation.org/beginners-guide-to-CE>

### Objetivo 30 por sala y 300 totales

Es factible como objetivo de plataforma, pero no con el nodo unico actual ni sin pruebas:

- Mantener 20-25 como valor operativo general.
- Probar 30 con escena optimizada, avatares ligeros, audio controlado y clientes desktop.
- Pasar a varios nodos con autoscaling.
- Escalar Dialog/mediasoup; mantener Reticulum exactamente en una réplica mientras `BotRunnerLease` sea local al
  proceso y no exista arbitraje con fencing en base de datos.
- Externalizar o hacer altamente disponible Postgres, almacenamiento y sesiones.
- Medir CPU, RAM, red, SFU consumers, FPS cliente y tiempos de join.

El arnés representa exactamente 30 en una sala y 300 como 12 salas de 25, pero su driver no puede producir evidencia
física válida mientras falten instrumentación, límite de red e identidad de hosts. No se ha ejecutado contra Hubs ni
staging. Trescientos CCU distribuidos en 12-15
salas de 20-25 sigue siendo mucho más realista que diez salas de 30 sin margen.

### Objetivo 100 por sala

El escenario `room-100-experimental` existe para descubrir el punto de fallo, no para certificarlo. No es un objetivo
razonable para una sala Hubs clásica con 100 avatares y audio activo. Los límites principales son:

- render y animacion en el navegador;
- mensajes y transforms de todos los avatares;
- mezcla de estados y objetos;
- cantidad de productores/consumidores del SFU;
- dispositivos moviles y VR.

mediasoup documenta que cada worker ocupa un core y que una aplicacion debe repartir rooms/routers entre workers y
hosts cuando aumenta la carga. El servidor puede escalar horizontalmente, pero eso no elimina el limite del cliente:
<https://mediasoup.org/documentation/v3/scalability/>.

Para 100 asistentes hay alternativas:

- 20-30 participantes representados y el resto en lobby;
- pocos ponentes y muchos espectadores mediante streaming;
- salas/zonas separadas;
- redisenar Hubs con interest management, avatar LOD y audio espacial por zonas.

### Objetivo 10.000 totales

El escenario `total-10000-model` nunca ejecuta carga. Actualmente tampoco proyecta nodos: los puntos 30/100/300
confunden participantes con número de salas, el salto a 10.000 es de unas 33 veces frente al máximo medido y falta
fencing distribuido para Reticulum. El gate exige diseño factorial participantes×salas, repeticiones, extrapolación
máxima de 3x y arbitraje de base de datos antes de emitir cifras o costes. Diez mil usuarios totales podría plantearse como una
plataforma multi-cluster futura, no como 100 salas Hubs de 100:

- cientos de salas de 20-30;
- directorio de eventos y asignador de capacidad;
- varios clusters/regiones;
- Dialog/mediasoup particionado por sala;
- Reticulum escalable solo después de sustituir el lease local por arbitraje persistente con fencing;
- CDN/objeto storage;
- observabilidad, pruebas de carga y operacion 24/7.

Es un proyecto de arquitectura de plataforma, no un simple cambio de tamano del Droplet.

## Rebalanceo y salas overflow

Es viable implementar un servicio de asignacion:

1. El usuario entra por una URL logica de evento.
2. El allocator consulta ocupacion y capacidad.
3. Lo dirige a una sala con hueco o crea/activa una sala overflow.
4. Mantiene afinidad para grupos y reingresos.

El balanceador de DigitalOcean no entiende la capacidad semantica de una room. Esta decision debe ocurrir en la
aplicacion antes de entrar. Mover un usuario ya conectado implica salir y reconectar; no debe presentarse como una
migracion transparente.

## Recomendacion de hoja de ruta

1. Mantener Node `ghost` como único runner productivo/autenticado y Chromium
   solo como diagnóstico browser legacy/local sin `--runner`, sin clave en URL
   o cliente y fuera de readiness.
2. `Completado`: implementar `mobility: static`.
3. `Completado`: implementar y probar navmesh+A* contra la escena actual.
4. `Completado`: aceptar en vivo trayectos, modo estatico y restauracion de movilidad tras el rollout estandar.
5. `Completado como scaffolding local`: definir escenarios 30/100/300/10.000, variantes 0/5/10 bots, contrato de
   evidencia, driver confinado, semántica por tipo y criterios provisionales; las 39 métricas de servidor permanecen
   explícitamente `unavailable` y la ejecución física está bloqueada.
6. Implementar y revisar productores/reglas/scrape/inventario, collector HTTPS/TLS/auth, egress de host,
   identidad+cgroup+terminación de generadores, clave del propietario y policy/atestación base-owned. Mantener
   Reticulum en una réplica hasta disponer de lease persistente con fencing.
7. Ejecutar primero local smoke y luego pruebas controladas de 10, 20, 25 y 30 usuarios, sin saltar etapas ante una
   parada o evidencia incompleta.
8. Solo después modelar con datos medidos el escalado a 300 CCU y diseñar el allocator de salas.
9. Mantener 100 por sala como experimento no certificante y 10.000 como modelo de arquitectura hasta contar con una
   plataforma multi-cluster y validación independiente.
