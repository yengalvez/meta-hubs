# Handoff de YenHubs - 16 de julio de 2026

Este es el punto de entrada para continuar el proyecto sin depender de una conversacion anterior.

## Estado ejecutivo

YenHubs esta operativo en <https://meta-hubs.org> y el verificador live informa 0 fallos y 0 avisos. La produccion usa:

- Hubs `prod-2026-03-11` con 79 commits propios adicionales.
- Hubs CE `2.1.0` con 79 commits propios adicionales.
- Reticulum sobre Elixir 1.18.4 / OTP 27.
- Ghost runner Node, no Chromium, con navmesh+A*.
- Un cluster DOKS no-HA `hubs-ce` en `ams3`.

Sala de aceptacion: <https://meta-hubs.org/VJopCY3/inicio>

| Elemento | Valor |
| --- | --- |
| Namespace | `hcce` |
| Contexto | `do-ams3-hubs-ce` |
| Sala principal | `VJopCY3` |
| Proyecto Spoke | `qa3U3Ke` |
| Escena | `f6VKtim` |
| Administrador operativo | `info@virtualmente.com` |

## Repos y ramas

| Ruta | Rama base | Fuente final auditada | Fuente del runtime live |
| --- | --- | --- | --- |
| Root | `main` | commit que contiene este handoff | `a0a2b59cad80e0b07f9b2a2f82c2020781163570` |
| `hubs/` | `master` | `492625c5791fa540e752cc8300018a4e8252d3f4` | `a7214eb882d19c98b2c8516489e0ed1fb7401c75` |
| `hubs-cloud/` | `master` | `4a1e3b9f2516851b015c17e968ea2cc4aabf4680` | `5a82de5387d7296cd01470d5136b2c07c2d5c7ac` |

Los commits finales de auditoria/CI estan publicados en Git, pero no cambian el
runtime hasta construir nuevas imagenes por Actions y desplegarlas por digest.

## Imagenes live

| Deployment | Imagen |
| --- | --- |
| Hubs | `ghcr.io/yengalvez/hubs@sha256:cff099ef4759c8ec8e8d6010ae9268c6b6e99f29ff5ecb50f6e50ce884d20a8c` |
| Reticulum | `ghcr.io/yengalvez/reticulum@sha256:9ae6712fa5cd4380048ec559cbf75596507ae91cdbd653cac1978b685254faef` |
| Bot orchestrator | `ghcr.io/yengalvez/bot-orchestrator@sha256:325c5c10e4ee039518693771c0974a0e5c876dcf54c443295e84490f4fa8ec53` |
| Spoke | `ghcr.io/yengalvez/spoke@sha256:f5120264938e189e702f835182ed4a28a5ce20b140d7262bc2a3074e6d0b6657` |
| Dialog | `ghcr.io/yengalvez/dialog@sha256:95687f4765e7a68ef05a714b807bf5c80e0f9187e2715f3a5a96e2d664377a23` |
| Photomnemonic | `ghcr.io/yengalvez/photomnemonic@sha256:aef369b82212429d01c0f1f554b16c34a99cf4bbb75e0693e190c796b33012f2` |
| Coturn | `ghcr.io/yengalvez/coturn@sha256:c2ad335349d477d342d5b17c82b513bfebc8c17b8e6b4e27a3049f3478207780` |

El inventario completo esta en el checkpoint y en el cluster; no usar tags `latest` como rollback.

## Funcionalidad aceptada

- Entrada desktop/movil, landing y sala 3D.
- Camara primera/tercera persona.
- Avatares normales y RPM full-body.
- Flujo Avaturn privado no listado y validacion client/server.
- Import Admin, previews y Featured.
- Sitting con `Disable motion`, animacion y salida del asiento.
- Bots `static|low|medium|high`, 0..10, `spawbot-*`, navmesh+A* y late join.
- Chat privado de bot con GPT-5 Nano, Structured Outputs, moderacion y acciones allowlist.
- Historial de bot solo en memoria de la sesion; no hay persistencia de conversaciones en YenHubs.
- Magic link Mailtrap, Admin, Spoke, Dialog/Coturn y audio multiusuario.

## Backup vigente

Checkpoint completo mas reciente:

```text
output/backups/20260716-183112/
```

Contenido validado:

- DB comprimida: 49 KiB, SHA-256
  `1ae3d7a76d317484b646c3e6f0fd25598f5f80161d1ecf55b84a84ac3d1fc5de`.
- Storage comprimido: 183 MiB, SHA-256
  `c071c02d7945b2bdba06585304113e730d085097855c98b1d4096417acc1f349`.
- 356 de schema, 94 migraciones, 33 archivos activos.
- 47 pares fisicos completos, 14 diferidos validos.
- commits, imagenes, Kubernetes, DigitalOcean y presencia de configuracion.
- `SHA256SUMS` y dry-runs de DB/storage correctos.

`output/latest-backup-path.txt` apunta al checkpoint vigente y esta ignorado. Mantener una segunda copia cifrada fuera
del Mac antes de retirar infraestructura.

## Riesgos bloqueantes actuales

### 1. Pull de paquetes GHCR

El token contenido en el `imagePullSecret` actual devuelve `401/403`. Los pods live siguen funcionando porque las
imagenes ya estaban descargadas, pero un nodo nuevo, reschedule o nueva imagen privada puede fallar con
`ImagePullBackOff`.

Antes de reiniciar nodos o desplegar:

1. crear/renovar un token GitHub con `read:packages` y acceso a los paquetes privados;
2. configurar `REGISTRY_USERNAME`/`REGISTRY_PASSWORD` en Actions para pushes;
3. renovar `ghcr-pull` en Kubernetes;
4. ejecutar `deployment/preflight-reactivation.sh` hasta que las tres imagenes prueben pull.

No almacenar el PAT en inputs de workflow ni YAML trackeado.

### 2. Clave OpenAI historica

Una clave encontrada en la historia Git antigua sigue respondiendo. No es la clave live actual y no puede eliminarse
con la API normal de proyecto. Debe revocarse en el panel OpenAI. La historia Git no se reescribio porque es una
operacion destructiva; Gitleaks del entregable actual esta limpio.

### 3. Capacidad no certificada

La topologia actual no tiene Metrics Server ni una prueba de carga representativa. No prometer 75, 300 o 10.000 CCU
basandose solo en requests. La recomendacion oficial de Hubs sigue siendo alrededor de 25 usuarios dentro de una sala.
Ver `docs/bots-cost-capacity-analysis-2026-07.md`.

## Riesgos no bloqueantes

- VR fisico no probado.
- Carrera de dos usuarios por el mismo asiento pendiente.
- Guardado real de un Avaturn nuevo requiere checkpoint dedicado.
- El bundle Hubs es grande (~8,4 MiB el entrypoint de sala).
- Spoke conserva dependencias legacy y advisories; se valida con Node 16.13.2 y debe modernizarse como proyecto
  separado, no con un upgrade masivo.
- `cowlib 2.18.0` mantiene dos avisos upstream sin release corregida; cualquier aviso Hex adicional falla CI.
- La imagen ghost contiene Chromium como fallback diagnostico, aunque no lo ejecuta en produccion. Separar una imagen
  ghost-only puede reducir tamano/superficie, no es necesario para el consumo runtime actual.

## Auditoria y pruebas realizadas

- Hubs: check, lint, 12 unit tests, build; Hubs/Admin audit de produccion en 0.
- Admin: tests, lint y build.
- Hubs CE: generator y verificador de 44 recursos; audit en 0.
- Reticulum: format, compile warnings-as-errors, 305 tests, 0 fallos, 3 excluidos.
- Bot orchestrator: 22 tests y audit en 0.
- Dialog: lint, 2 tests y audit en 0.
- Photomnemonic: syntax/check, 7 tests y audit en 0.
- Coturn: test de entrypoint.
- Spoke: lint, unit y build con Node 16.13.2/Yarn 1.
- Gitleaks, Actionlint, ShellCheck, SBOM y Trivy.
- Navegador real desktop/movil: sin errores JS/HTTP, escena lista y cinco bots.
- Live: 12 deployments Ready, TLS/DNS/DB/storage/assets/CSP/ghost runner, 0 fallos/avisos.
- GitHub Actions de cierre: Hubs Security `29518981250`, Storybook
  `29518980804`, cloud Security `29520235224`, Services `29520235446`,
  Reticulum `29519815859` y root Security `29519331721`, todos correctos.

Los cambios de auditoria anaden CI de seguridad, healthchecks y correcciones de calidad. No estan desplegados hasta que
se construyan imagenes nuevas por Actions y se renueve GHCR.

## Actualizacion upstream

Ejecutar:

```bash
./scripts/audit-upstream.sh
```

Estado del corte:

- no faltan commits de las releases estables aceptadas;
- `upstream/master` tiene 13 commits Hubs y 5 Hubs CE no publicados;
- los dry merges solo anticipan conflictos en workflows.

No desplegar `upstream/master`. Seguir `docs/development-workflow.md` y preservar
`docs/customization-inventory.md`.

## Deploy correcto

1. checkpoint;
2. tests locales;
3. commit/push;
4. GitHub Actions;
5. digest en values local;
6. `npm run gen-hcce`;
7. `kubectl diff` sin imprimir Secrets;
8. `kubectl apply -f hcce.yaml` sin editarlo;
9. rollout;
10. si cambia Hubs, reiniciar Reticulum;
11. carga fria real;
12. `deployment/verify-live-reactivation.sh` con 0/0.

No usar `kubectl set image`, hotpatches, builds in-cluster, `kubectl cp` ni parches manuales como flujo normal.

## Coste y ciclo de vida

Coste base actual aproximado: 62 USD/mes (48 nodo + 12 LB + 2 storage). Escalar deployments a cero no elimina esa
factura. Para alta, congelacion, restauracion o baja de un cliente usar
`deployment/client-instance-lifecycle.md`.

## Orden para continuar

1. Leer `AGENTS.md` y este handoff.
2. Revocar la clave OpenAI historica.
3. Renovar credenciales GitHub/GHCR.
4. Ejecutar `deployment/preflight-reactivation.sh`.
5. Confirmar arboles limpios y ramas base.
6. Crear checkpoint si se va a mutar produccion.
7. Usar una rama por feature o upgrade.
8. Ejecutar los gates y desplegar solo por el metodo estandar.

## Indice

- Operacion: `deployment/README.md`.
- Auditoria: `docs/audit-2026-07.md`.
- Desarrollo/upstream: `docs/development-workflow.md`.
- Personalizaciones: `docs/customization-inventory.md`.
- Features: `features/`.
- Archivo historico: `OLD/README.md`.
