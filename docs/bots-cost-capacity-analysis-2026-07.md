# Bots, coste y capacidad: analisis de julio de 2026

> Actualizacion del 16 de julio de 2026: las dos recomendaciones de runtime de este informe ya estan implementadas,
> desplegadas y aceptadas en produccion: `mobility: static` y navegacion navmesh+A* en el ghost runner. La parte de
> 300/10.000 CCU sigue siendo solo analisis de arquitectura; no se ha implementado.

## Resumen ejecutivo

- La infraestructura actual cuesta aproximadamente **62 USD/mes** antes de impuestos, uso extra de red, snapshots,
  registro de contenedores y consumo de OpenAI.
- El `ghost runner` es la decision correcta para los bots: dos salas activas consumen en conjunto unos **134 MiB**
  de memoria de cgroup y una fraccion pequena de CPU. Volver a Chromium empeoraria mucho el coste por sala.
- El diagnostico inicial encontro **cero `box-collider`** y trayectos rectos que atravesaban estructuras.
- La solucion implementada conserva el ghost runner y navega sobre el **navmesh de la escena**, proyectando puntos y
  calculando rutas A*. Los colliders quedan solo como fallback de compatibilidad.
- `mobility: static` mantiene bots inmoviles y rechaza acciones de navegacion. `low` conserva su significado de
  movilidad lenta.
- La instalacion actual no debe prometer 300 CCU. Hubs recomienda 25 personas dentro de una sala y documenta
  problemas en moviles por encima de 10. Treinta puede ser un objetivo de pruebas controladas; 100 avatares activos
  en una sola sala requeriria redisenar partes importantes del producto.

## Estado medido

Medicion realizada el 16 de julio de 2026:

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

No esta habilitado el control plane HA, que anadiria 40 USD/mes. El coste real puede variar por impuestos, snapshots,
egress que exceda la cuota, registro y llamadas al LLM.

Fuentes oficiales consultadas:

- <https://www.digitalocean.com/pricing/droplets>
- <https://docs.digitalocean.com/products/kubernetes/details/pricing/>
- <https://docs.digitalocean.com/products/networking/load-balancers/details/pricing/>
- <https://docs.digitalocean.com/products/volumes/details/pricing/>

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
ruta A* y publica sus tramos consecutivos. Solo cae al comportamiento de collider/directo cuando la escena no contiene
un navmesh valido.

## Opciones para corregir la navegacion

### Opcion A: `box-collider` en Spoke

La mas rapida y sin codigo de runtime:

- Anadir colliders a paredes, muebles grandes y limites.
- Colocar waypoints de forma que existan enlaces rectos despejados.
- El ghost runner actual descartara un destino si la linea lo cruza.

Ventajas:

- Coste de CPU practicamente nulo.
- Compatible con lo que ya esta desplegado.
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

No recomendada. Un motor fisico por bot o un navegador por sala aumentan CPU/RAM y complejidad sin resolver mejor el
authoring. Chromium debe quedar solo como fallback de diagnostico.

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
- Escalar horizontalmente Reticulum y Dialog/mediasoup.
- Externalizar o hacer altamente disponible Postgres, almacenamiento y sesiones.
- Medir CPU, RAM, red, SFU consumers, FPS cliente y tiempos de join.

Trescientos CCU distribuidos en 12-15 salas de 20-25 es mucho mas realista que diez salas de 30 sin margen.

### Objetivo 100 por sala

No es un objetivo razonable para una sala Hubs clasica con 100 avatares y audio activo. Los limites principales son:

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

Diez mil usuarios totales podria plantearse como una plataforma multi-cluster futura, no como 100 salas Hubs de 100:

- cientos de salas de 20-30;
- directorio de eventos y asignador de capacidad;
- varios clusters/regiones;
- Dialog/mediasoup particionado por sala;
- Reticulum y base de datos escalables horizontalmente;
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

1. Mantener `ghost` y prohibir Chromium en produccion salvo diagnostico.
2. `Completado`: implementar `mobility: static`.
3. `Completado`: implementar y probar navmesh+A* contra la escena actual.
4. `Completado`: aceptar en vivo trayectos, modo estatico y restauracion de movilidad tras el rollout estandar.
5. Instalar metricas y ejecutar pruebas controladas de 10, 20, 25 y 30 usuarios.
6. Solo despues disenar el escalado a 300 CCU y el allocator de salas.
