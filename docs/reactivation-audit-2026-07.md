# Reactivacion y preparacion de auditoria - Julio 2026

Este documento fija el punto de partida comprobado para reactivar YenHubs y, despues, auditarlo sin depender del historial de una conversacion.

> Estado: preparacion completada. La auditoria y la creacion de recursos de pago en DigitalOcean no deben empezar sin confirmacion explicita del propietario.

## 1. Que proyecto es realmente

YenHubs es un despliegue personalizado de **Hubs Community Edition (Hubs CE)**. No usa el antiguo servicio gestionado Hubs Cloud de Mozilla, que esta obsoleto.

Repositorios:

- Superproyecto: `/Users/Shared/Gits/YenHubs`, rama base `main`.
- Cliente web y runtime 3D: `/Users/Shared/Gits/YenHubs/hubs`, fork `yengalvez/hubs`, rama base `master`.
- Generador de infraestructura y Reticulum: `/Users/Shared/Gits/YenHubs/hubs-cloud`, fork `yengalvez/hubs-cloud`, rama base `master`.

Commits estables congelados:

- Superproyecto: `511e608b6b34567f5477abc3f2cb5c1791604a24`.
- `hubs/master`: `7aa9a35f4d3d6e9ac48cdf3cebf4553073f43823`.
- `hubs-cloud/master`: `832d8e39566e22768b816422bffc9417f9f5a53c`.

La copia local de `hubs-cloud` puede aparecer en `codex/bots-ghost-runner` (`e38b70d`) aunque el superproyecto fija el merge estable `832d8e3`. Antes de crear ramas nuevas, sincronizar el submodulo con el commit fijado por `main`.

## 2. Estado de la version y upstream

Comprobado el 13 de julio de 2026:

- El fork usa el generador Hubs CE `2.0.0`.
- El `hubs-cloud` oficial esta en `2.1.0`.
- La ultima etiqueta de produccion identificada del cliente es `prod-2026-03-11` (`e3b9cc749`).
- El fork del cliente parte de `prod-2025-12-17` (`55ae9ec20`), tiene 52 commits propios y esta solo 2 commits por detras de `prod-2026-03-11`.
- Esos 2 commits oficiales corrigen PDFs en VR movil.
- La rama oficial `master` contiene cambios posteriores de CI, seguridad, documentacion y retirada de branding, pero no debe confundirse automaticamente con una release de produccion.

Pruebas de merge sin modificar las ramas:

- `hubs/master` + `prod-2026-03-11`: merge limpio, sin conflictos.
- `hubs/master` + ultimo `master` oficial: un conflicto localizado en `.github/workflows/custom-docker-build-push.yml`.
- `hubs-cloud/master` + ultimo `master` oficial (`2.1.0`): merge limpio, sin conflictos.

Ruta recomendada:

1. Reactivar primero el estado conocido y congelado.
2. Crear ramas de actualizacion separadas.
3. Integrar primero `prod-2026-03-11` en `hubs`.
4. Integrar `hubs-cloud 2.1.0` de forma independiente.
5. Evaluar despues los commits posteriores de `hubs/master`; no mezclarlos a ciegas con la primera actualizacion.
6. Mantener los commits propios en bloques pequenos y documentados para reducir el coste de futuras sincronizaciones.

## 3. Baseline tecnico comprobado

Pruebas realizadas sobre el estado congelado, sin iniciar la auditoria:

- `hubs/npm ci`: correcto con Node `22.11.0`.
- `hubs/npm run check`: correcto.
- `hubs/npm run lint:js`: correcto.
- `hubs/npm run build`: correcto; Webpack termina con avisos de tamano de bundles, no con errores.
- `bot-orchestrator/npm ci`: correcto.
- `node --check app.js`: correcto.
- `node --check run-ghost-runner.js`: correcto.
- Generacion aislada de `hcce.yaml` con los valores locales: correcta, manifiesto de aproximadamente 42 KiB.

Deuda detectada que se tratara en la auditoria, no con un `npm audit fix --force` automatico:

- Cliente Hubs: 69 avisos npm (3 bajos, 17 moderados, 38 altos y 11 criticos).
- Bot orchestrator: 7 avisos npm (4 moderados, 2 altos y 1 critico).
- Hay dependencias antiguas y paquetes Git; cada aviso se debe clasificar por ruta realmente ejecutable y riesgo de regresion.
- El entrypoint principal de la sala ronda 8.3 MiB, por lo que rendimiento y carga inicial deben formar parte de la auditoria UX/tecnica.

Herramientas locales preparadas:

- `doctl 1.163.0`.
- `kubectl 1.36.2`.
- `helm 4.2.3`.
- Node `22.11.0` y npm `10.9.0`.

## 4. Backup y artefactos recuperables

Backup principal:

```text
/Users/Shared/Gits/YenHubs/output/project-freeze-20260316-090114/
```

Validaciones:

- `retdb-20260316-090114.sql.gz` pasa `gzip -t` y tiene un tamano comprimido coherente para el contenido existente (~41 KiB).
- Estan guardados los manifiestos, estado de Kubernetes, imagenes desplegadas, valores locales y commits de cierre.
- Las tres imagenes privadas principales responden correctamente en GHCR con la credencial local:
  - `ghcr.io/yengalvez/hubs:runtime-fix-20260219-5e1344b00-55`
  - `ghcr.io/yengalvez/reticulum:ret-cspfix-20260219-984ba9a-latest`
  - `ghcr.io/yengalvez/bot-orchestrator:ghost-fullsync-20260307-e38b70d-latest`

La fuente de verdad de secretos sigue siendo:

```text
/Users/Shared/Gits/YenHubs/deployment/input-values.local.yaml
```

No mostrar, copiar a documentacion ni versionar sus valores.

## 5. Bloqueadores antes de reactivar DigitalOcean

1. `doctl account get` devuelve HTTP 401. Hay que renovar la autenticacion local con `doctl auth init` usando un token nuevo de DigitalOcean. No pegar el token en chats ni commits.
2. Hay que aprobar expresamente la creacion de recursos de pago.
3. Antes de crear el cluster, comprobar en el panel/API que `HA=false`. En DOKS 1.36 o posterior, omitir el campo de HA en determinadas llamadas de creacion puede habilitarlo por defecto y sumar 40 USD/mes.
4. La rama/commit local de cada submodulo debe alinearse con los commits estables indicados arriba antes de abrir ramas de actualizacion.

Preflight reproducible y de solo lectura:

```bash
cd /Users/Shared/Gits/YenHubs
./deployment/preflight-reactivation.sh
```

El script no crea ni modifica recursos de nube y no imprime secretos. Termina con error mientras falte autenticacion o cualquier artefacto obligatorio.

## 6. Coste estimado de la reactivacion

Topologia que ya funciono:

- 1 nodo Basic de 8 GiB y 4 vCPU: 48 USD/mes.
- 1 balanceador regional HTTP: 12 USD/mes.
- 2 volumenes de 10 GiB: aproximadamente 2 USD/mes.
- Control plane sin HA: 0 USD/mes.
- Total estimado: **62 USD/mes**, mas posibles consumos externos de SMTP/OpenAI.

DigitalOcean factura nodos y balanceadores por tiempo de uso con tope mensual. No crear un segundo cluster para la primera auditoria salvo que el propietario acepte expresamente duplicar temporalmente el coste.

## 7. Secuencia de reactivacion segura

La reactivacion debe demostrar primero que el backup sigue funcionando, sin mezclarla con una actualizacion:

1. Renovar autenticacion de `doctl`.
2. Crear `hubs-ce` en `ams3`, un nodo de 8 GiB/4 vCPU, `HA=false`.
3. Guardar kubeconfig y verificar el nodo.
4. Instalar cert-manager y aplicar IngressClass/ClusterIssuer.
5. Generar el manifiesto desde `deployment/input-values.local.yaml`.
6. Aplicar los ajustes documentados de HAProxy, ingress, certificados y RBAC.
7. Crear el pull secret privado de GHCR y asociarlo al ServiceAccount del namespace.
8. Desplegar exactamente las imagenes congeladas.
9. Restaurar `retdb` desde el dump.
10. Configurar/verificar DNS y TLS.
11. Ejecutar smoke tests del estado conocido: home, login, creacion/entrada en sala, Spoke, audio/WebRTC, avatares, tercera persona, sitting y bots ghost.
12. Crear un dump nuevo antes de probar una actualizacion.

No se debe actualizar Hubs y restaurar infraestructura en el mismo paso: si algo falla, hay que poder distinguir si falla la recuperacion o la actualizacion.

## 8. Alcance propuesto para la auditoria integral

La auditoria empieza solo despues del punto de confirmacion del propietario.

### Arquitectura y mantenimiento

- Modelo de submodulos, ramas y remotos.
- Separacion de personalizaciones respecto a upstream.
- Estrategia de parches/commits para que actualizar Hubs no rompa features.
- Automatizacion de los cuatro ajustes manuales de `hcce.yaml` y del RBAC.
- Reproducibilidad de builds, imagenes y rollback.

### Seguridad y supply chain

- Clasificar vulnerabilidades npm por explotabilidad real.
- GitHub Actions, permisos GHCR y fijacion de actions/imagenes.
- Secretos, CSP, cabeceras, endpoints internos, rate limits y autenticacion.
- Versiones de Reticulum, Dialog, PostgreSQL, HAProxy, cert-manager y Kubernetes.
- Revisar exposicion de datos y logs operativos.

### Bots e IA

- Ghost runner: reconexion, late join, limites de salas/bots, CPU/RAM y limpieza de entidades.
- Movimiento, waypoints `spawbot-*`, colisiones por `box-collider`, avatares featured y animaciones.
- Chat privado: historial solo en memoria de la sesion y borrado al salir/cambiar de sala.
- OpenAI Responses API desde backend, nunca desde navegador.
- Enviar explicitamente `store: false` en cada peticion.
- No registrar prompts/respuestas ni incluirlos en telemetria o errores.
- Moderacion de entrada/salida, limites de longitud/tokens, rate limits y allowlist estricta de acciones.
- Defensa frente a prompt injection y separacion entre instrucciones del sistema, datos de sala y texto del usuario.
- Aviso de privacidad y politica de retencion. La API de OpenAI no usa datos para entrenamiento por defecto, pero el monitoreo de abuso puede conservar datos hasta 30 dias salvo que la organizacion tenga Zero Data Retention aprobado; esto debe decidirse y documentarse antes de uso real con publico.
- Prompt configurable por sala/admin con validacion, versionado y fallback seguro.

### Funcionalidad

- Entrada/creacion de salas, audio/WebRTC, chat, compartir medios y salida.
- Third-person, sit/stand, RPM/Avaturn, carga local de avatares y featured.
- Compatibilidad desktop, movil y VR; cliente A-Frame y limitaciones bitECS.
- Pruebas multiusuario reales para sincronizacion de bots, sitting y avatares.

### UX y visual

- Inventario de todas las pantallas de usuario, excluyendo Admin/Spoke salvo fallos funcionales.
- Capturas comparables en 1440x900, 1024x1366 y 390x844.
- Contraste, legibilidad, transparencias, safe areas, toolbar, sidebars, modales y selector de avatar.
- Priorizar primero errores de layout y accesibilidad; despues aplicar un sistema visual coherente, evitando overrides globales que oculten el canvas 3D.
- Auditoria de traducciones al espanol y eliminacion de textos hardcoded.

### Rendimiento y capacidad

- Bundle, carga inicial, memoria WebGL, FPS y recursos de escena.
- CPU/RAM del stack en reposo y bajo concurrencia.
- Impacto del ghost runner y del numero de bots en CCU.
- Prueba escalonada antes de aceptar cifras de capacidad.

## 9. Metodo de ejecucion de la auditoria

1. Crear ramas `codex/audit-...`; no trabajar directamente en `master`/`main`.
2. Registrar primero hallazgos por severidad, archivo y prueba reproducible.
3. Corregir por lotes pequenos: infraestructura, seguridad/privacidad, funcionalidad, bots y UX.
4. Ejecutar checks/builds y smoke tests despues de cada lote.
5. Desplegar solo imagenes construidas por el workflow GitHub Actions aprobado.
6. Mantener un tag conocido para rollback y un dump de DB previo.
7. No cambiar a metodos de deploy alternativos si CI falla sin autorizacion expresa.

## 10. Punto de control obligatorio

Antes de continuar hacen falta dos confirmaciones separadas:

1. **Reactivar DigitalOcean**: autorizar el gasto estimado y renovar `doctl` localmente.
2. **Iniciar auditoria**: confirmar que se puede empezar a abrir ramas, registrar hallazgos y aplicar correcciones.

La preparacion anterior no equivale a haber iniciado la auditoria.

## Referencias oficiales

- Hubs Foundation docs: <https://docs.hubsfoundation.org/>
- Hubs CE guide: <https://docs.hubsfoundation.org/beginners-guide-to-CE>
- Hubs source: <https://github.com/Hubs-Foundation/hubs>
- Hubs CE infrastructure: <https://github.com/Hubs-Foundation/hubs-cloud>
- DigitalOcean Kubernetes pricing: <https://docs.digitalocean.com/products/kubernetes/details/pricing/>
- DigitalOcean load balancer pricing: <https://docs.digitalocean.com/products/networking/load-balancers/details/pricing/>
- OpenAI API data controls: <https://platform.openai.com/docs/models/default-usage-policies-by-endpoint>
- OpenAI enterprise privacy: <https://openai.com/enterprise-privacy/>
