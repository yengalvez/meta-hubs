# Flujo de desarrollo y actualizacion upstream

## Objetivo

YenHubs es una distribucion personalizada de dos proyectos actualizables:

- `hubs/`: fork del cliente Hubs.
- `hubs-cloud/`: fork de Hubs Community Edition y sus servicios.

El objetivo no es evitar cambios al core, sino hacerlos localizables,
verificables y reimplantables cuando Hubs Foundation publique una release.

## Baseline actual

| Repositorio | Rama base YenHubs | Release estable aceptada |
| --- | --- | --- |
| Root | `main` | N/A |
| `hubs/` | `master` | `prod-2026-03-11` |
| `hubs-cloud/` | `master` | `2.1.0` |

Las ramas `upstream/master` contienen trabajo no publicado. Se usan para
anticipar conflictos, nunca como baseline automatico de produccion.

## Preparar remotos

```bash
git -C hubs remote get-url origin
git -C hubs remote get-url upstream
git -C hubs-cloud remote get-url origin
git -C hubs-cloud remote get-url upstream

git -C hubs fetch origin --prune
git -C hubs fetch upstream --tags --prune
git -C hubs-cloud fetch origin --prune
git -C hubs-cloud fetch upstream --tags --prune
```

Los `origin` deben ser los forks `yengalvez/*`; los `upstream` deben apuntar a
`Hubs-Foundation/*`.

## Auditar sin modificar

Desde el root:

```bash
./scripts/audit-upstream.sh --output output/upstream-audit.md
```

El script:

- detecta la release estable mas reciente;
- comprueba si la release ya es ancestro del fork;
- cuenta commits propios y oficiales pendientes;
- hace un dry merge contra `upstream/master`;
- no cambia ningun worktree.

En el corte del 16 de julio de 2026:

- Hubs esta 79 commits propios por delante de `prod-2026-03-11` y no le falta
  ningun commit de esa release;
- Hubs CE esta 79 commits propios por delante de `2.1.0` y no le falta ningun
  commit de esa release;
- hay 13 commits Hubs y 5 Hubs CE no publicados en los respectivos `master`
  oficiales;
- los conflictos anticipados estan concentrados en workflows, no en runtime.

## Integrar una nueva release

No mezclar esta tarea con una feature.

```bash
# Ejemplo Hubs. Sustituir <release>.
git -C hubs switch master
git -C hubs pull --ff-only origin master
git -C hubs switch -c codex/upgrade-hubs-<release>
git -C hubs merge --no-ff <release>

# Ejemplo Hubs CE.
git -C hubs-cloud switch master
git -C hubs-cloud pull --ff-only origin master
git -C hubs-cloud switch -c codex/upgrade-hcce-<release>
git -C hubs-cloud merge --no-ff <release>
```

Reglas de resolucion:

1. No aceptar automaticamente `ours` o `theirs`.
2. Comparar el contrato oficial nuevo con
   `docs/customization-inventory.md`.
3. Preservar tests, feature flags, schemas persistidos y wiring de despliegue.
4. Actualizar la documentacion si cambia un contrato.
5. Mantener `input-values.yaml` real fuera de Git.

## Desarrollar una feature

1. Partir de las ramas base limpias.
2. Crear una rama `codex/<feature>` solo en los repos afectados.
3. Si mutara produccion, crear antes:

   ```bash
   ./deployment/create-checkpoint.sh
   ```

4. Implementar con un flag cuando exista riesgo operativo.
5. Anadir tests en la capa mas baja que pueda demostrar el contrato.
6. Actualizar `features/<feature>/` y `docs/session-changelog.md`.
7. Ejecutar:

   ```bash
   ./scripts/verify-project.sh
   ./scripts/verify-project.sh --full
   ```

8. Commit y push del subrepo.
9. Construir mediante GitHub Actions.
10. Desplegar por el flujo de `deployment/README.md`.
11. Fusionar subrepos primero y actualizar despues los punteros del root.

## Gate de regresion por area

| Area cambiada | Aceptacion minima |
| --- | --- |
| Camara, IK o avatar rig | primera/tercera persona, avatar normal y full-body |
| Waypoints o character controller | movimiento, sit/stand, Space targets |
| Networking/NAF | usuario remoto, bots, late join, remove/reconnect |
| Media/avatar upload | normal, RPM/Avaturn, preview, privado y featured |
| Room settings/Reticulum | persistencia, permisos y normalizacion backend |
| Bots | spawn, static/low, navmesh, chat, rate limit y privacidad |
| UI/i18n | desktop, tablet, movil, espanol y escena 3D visible |
| Spoke | login, abrir proyecto, guardar y publicar en copia segura |
| Dialog/Coturn | entrada de sala y audio entre dos clientes |
| Generator/Kubernetes | 44 recursos, un LB, digests, TLS, RBAC y diff seguro |

## Conflictos previsibles

La personalizacion es amplia: frente a la release estable, Hubs modifica 146
archivos y Hubs CE 111. No significa que cada update produzca 257 conflictos;
la mayoria de cambios estan aislados por componentes y servicios. Los puntos
con mayor riesgo son:

- `camera-system`, `character-controller-system`, `ik-controller`;
- `player-info`, network schemas y templates de avatar/bot;
- room settings, media browser y `ui-root`;
- Reticulum `hub_channel`, controllers, storage y CORS proxy;
- el generador `hcce.yam` y su verificador;
- workflows de build y seguridad.

El inventario detallado esta en `docs/customization-inventory.md`.

## Integracion y rollback

Una release solo se acepta cuando:

- el suite completo pasa;
- la imagen se publica por Actions;
- se fija el digest;
- el manifiesto se regenera sin ediciones;
- la carga fria no tiene excepciones ni 404;
- el verificador live informa 0 fallos y 0 avisos;
- existe un checkpoint y un digest anterior de rollback.

Si falla cualquiera de esos gates, detener el rollout. No sustituir el metodo
por hotpatches, builds dentro del cluster o copias manuales.
