# YenHubs

Distribucion personalizada de Hubs Foundation Community Edition sobre DigitalOcean Kubernetes.

Estado de referencia: 16 de julio de 2026.

- Hubs estable: `prod-2026-03-11`.
- Hubs CE estable: `2.1.0`.
- Produccion: <https://meta-hubs.org>.
- Bots: ghost runner Node, navmesh+A*, hasta 10 por sala y modo estatico.
- Interfaz: Obsidian Aurora en espanol, desktop/tablet/movil.
- Infraestructura: DOKS no-HA de un nodo, coste base aproximado 62 USD/mes.

## Empezar

1. `AGENTS.md`: reglas de trabajo y despliegue.
2. `docs/project-handoff-2026-07.md`: estado operativo y riesgos actuales.
3. `docs/README.md`: indice documental.
4. `deployment/README.md`: procedimiento completo de deploy.
5. `docs/development-workflow.md`: features y actualizaciones upstream.
6. `docs/customization-inventory.md`: contratos propios que hay que preservar.

## Repositorios

| Ruta | Fork | Rama base |
| --- | --- | --- |
| root | `yengalvez/meta-hubs` | `main` |
| `hubs/` | `yengalvez/hubs` | `master` |
| `hubs-cloud/` | `yengalvez/hubs-cloud` | `master` |

El root fija los commits exactos de los dos submodulos. Una feature no esta integrada hasta que el subrepo esta en su
rama base y el root registra el nuevo puntero.

## Funcionalidad propia

- Camara primera/tercera persona.
- Avatares normales, RPM full-body y Avaturn privado no listado.
- Import local/URL, previews y Featured.
- Sitting con waypoints `Disable motion`.
- Locomocion idle, frontal, lateral y hacia atras.
- Bots por sala, featured avatars, `spawbot-*`, navmesh, chat privado y GPT-5 Nano.
- Guardarrailes, moderacion, rate limit y sin historial persistido en YenHubs.
- Landing y room UI responsive en espanol.
- Admin, Spoke, WebRTC, SSL y backup DB+storage.

## Estructura

```text
YenHubs/
|-- AGENTS.md
|-- hubs/                         # cliente y Admin
|-- hubs-cloud/                   # CE, Reticulum y servicios
|-- deployment/                   # deploy, backup, restore y ciclo de vida
|-- docs/                         # handoff, auditoria y desarrollo
|-- features/                     # contratos por feature
|-- scripts/                      # auditoria upstream y gate integral
|-- OLD/                          # archivo historico, nunca input operativo
`-- output/                       # backups/evidencias locales, ignorado
```

## Verificacion

```bash
./scripts/audit-upstream.sh
./scripts/verify-project.sh
./scripts/verify-project.sh --full
./deployment/preflight-reactivation.sh
./deployment/verify-live-reactivation.sh
```

Los dos ultimos comandos requieren el contexto de infraestructura correcto. No desplegar si el preflight falla.

## Backup

Fijar antes `EXPECTED_KUBE_CONTEXT` y `EXPECTED_NAMESPACE_UID` como describe
`deployment/client-instance-lifecycle.md`; los scripts no aceptan un destino
Kubernetes implicito.

```bash
./deployment/create-checkpoint.sh
```

Un checkpoint valido incluye PostgreSQL y `ret-pvc`. Un dump de DB sin storage no recupera escenas, proyectos Spoke,
avatares ni thumbnails.

## Coste base

| Recurso | Estimacion mensual |
| --- | ---: |
| Nodo Basic 4 vCPU / 8 GiB | 48 USD |
| Load Balancer regional | 12 USD |
| 2 x 10 GiB de volumen | 2 USD |
| **Base** | **~62 USD** |

Escalar pods a cero no elimina estos costes. Para una pausa larga, seguir
`deployment/client-instance-lifecycle.md` y borrar la infraestructura solo despues de validar un checkpoint completo.

## Upstream

- [Hubs Foundation Hubs](https://github.com/Hubs-Foundation/hubs)
- [Hubs Community Edition](https://github.com/Hubs-Foundation/hubs-cloud)
- [Documentacion Hubs Foundation](https://docs.hubsfoundation.org)
