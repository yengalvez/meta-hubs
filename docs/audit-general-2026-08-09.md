# Auditoria general YenHubs - 9 de agosto de 2026

Estado: **decision vigente que origina la meta de hibernacion**

## Veredicto

YenHubs no necesita rehacer Mozilla Hubs ni terminar el recovery avanzado para
volver a desarrollar features. El producto base, los forks y las
personalizaciones se preservan.

El trabajo anterior no fue enteramente en vano: produjo un checkpoint conjunto
de PostgreSQL y `ret-pvc`, validaciones fuertes, inventarios, orden seguro y
evidencia sobre fallos. Pero su ultima linea resolvia respuestas ambiguas,
reentradas y takeover mediante HMAC/keyring/monitores y matrices extensas. Esa
arquitectura excede el requisito comercial inmediato y genero un loop de
diagnostico.

La brecha que si bloquea el negocio es mas sencilla y diferente: el runbook
promete borrar/recrear DigitalOcean, pero el restore implementado solo admite
`in-place`, rechaza `cold-rebind` y exige los UID antiguos de Namespace/PVC.
Esos UID cambian al crear el cluster nuevo. Por tanto hoy existe recuperacion
fuerte sobre la instalacion original, pero no un ciclo demostrado de
hibernacion durante meses y reactivacion sobre infraestructura nueva.

## Estado comprobado

### Producto

- Baseline raiz aceptado: `9c1b85b`; Hubs `ce8390a`; Hubs Cloud `c0a3419`.
- Releases estables: Hubs `prod-2026-03-11`, Hubs CE `2.1.0`.
- Produccion no se ha sustituido por el candidato de recovery.
- El 9 de agosto respondieron sin mutacion portada espanola, sala/vestibulo,
  login, proteccion de Admin y editor Spoke no autenticado.
- La aceptacion completa de login, audio, camaras, avatar, Admin y Spoke sigue
  pendiente de una unica sesion autorizada.

### Datos y recuperacion

- El checkpoint actual copia DB y medios conjuntamente y valida hashes,
  contratos, migraciones, UUID y pares fisicos.
- El restore coordinado actual es util para recuperacion in-place.
- `cold-rebind` esta deshabilitado y el preflight mezcla identidades source con
  target.
- El TTL por defecto de 24 horas no sirve como criterio de validez para una
  hibernacion de meses.
- La documentacion de alta exige un checkpoint incluso para un cliente nuevo;
  hace falta separar greenfield de reactivacion.

### Operacion y coste

- DigitalOcean no ofrece una pausa total equivalente a coste cero para toda la
  topologia. Hibernar requiere inventariar y retirar expresamente cluster, LB,
  volumenes u otros recursos aprobados.
- Nunca se debe asumir que borrar el cluster elimina todo ni ejecutar una
  eliminacion sin dos copias verificadas y permiso concreto.
- La ultima estimacion local del 8 de agosto era aproximadamente USD 65/mes
  antes de impuestos, egress y servicios externos; no se trata como factura
  actual y debe refrescarse antes de H5.

### Actualizaciones futuras

- Los forks siguen basados en releases estables y gitlinks exactos; no se ha
  reemplazado el producto por un fork nuevo.
- La hibernacion se implementa en scripts externos al nucleo de Hubs. Esto
  mantiene separada la superficie que puede entrar en conflicto con upstream.
- Features, upgrades y recovery permanecen en ramas/rollouts distintos.
- `upstream/master` sirve como aviso temprano, no como deployment target.

### Loop y sobretrabajo

- El PR `#15` repitio los mismos cinco fallos Linux cuatro veces y la suite
  recovery se convirtio en el principal coste de feedback.
- La espera de 17 horas era el intervalo de una automatizacion de seguimiento,
  no una espera obligatoria de GitHub.
- La rama avanzada tiene cuatro commits funcionales y tres ficheros locales sin
  commit; todos quedan preservados y fuera del nuevo candidato.
- No se ejecutan los grupos pendientes, full o CI de esa rama.

## Requerimientos reales del MVP

Obligatorio antes de ofrecer una hibernacion restaurable:

1. aceptar funcionalmente el baseline que se va a preservar;
2. producir `freeze-bundle-v1` con DB, `ret-pvc`, contratos, versiones, digests,
   configuracion redactada y receta de infraestructura;
3. guardar dos copias cifradas con un recibo de integridad externo;
4. separar `preflight-greenfield` de `preflight-reactivation`;
5. restaurar sobre Namespace/PVC nuevos sin confundir UID source y target;
6. ensayar DB+medios juntos sin crear recursos DO adicionales;
7. ejecutar una sola validacion completa y un CI final por SHA;
8. demostrar una hibernacion real con permiso, coste residual y RTO medido.

No bloquea este MVP:

- HA/failover sin caida, HPA o certificacion de escala;
- bots/IA publicos y runner durable-v2;
- sitting v2, VR o proveedor de avatares embebido;
- Terraform/self-service multi-cliente;
- stack completo de observabilidad;
- recovery automatico ante toda respuesta perdida.

## Decision

1. Congelar `codex/recovery-closure` y no fusionar sus cambios avanzados.
2. Partir limpio de `origin/main` en `codex/client-hibernation`.
3. Usar `docs/client-hibernation-design-v1.md` como contrato H1.
4. Ejecutar los seis hitos finitos del plan activo.
5. Cerrar recovery al demostrar la hibernacion; cualquier mejora residual va a
   backlog y la siguiente meta vuelve a una feature elegida por el propietario.

## Riesgos que permanecen

- Falta cerrar la aceptacion autenticada del baseline actual.
- El diseno H2 aun no es codigo ni tiene ensayo cold-rebind.
- No hay RTO ni coste residual demostrados hasta H5.
- Las credenciales que aparecieron en salida interna deben considerarse
  potencialmente expuestas y rotarse antes de cualquier rollout futuro, sin
  abrir ni imprimir el fichero privado.
- Bots `process-local`, sitting legacy y uploads GLB tienen limites comerciales
  que deben mantenerse fuera de promesas no aceptadas.

Esta auditoria no autorizo despliegue, borrado, creacion de infraestructura,
rotacion, envio de correo ni coste nuevo.
