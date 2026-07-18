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

## Corte integrado del 18 de julio

La integración validada se apoya en Hubs
`674ece41169117a1a842af9cf5d256a10cc43df0` y Hubs Cloud
`5392495b077249edcedfb3092551201645f648f1`, ambos en `master`. Incluye
`AUD-075`: parent y runner separados, un Pod por sala/generación, token v1
seguido de lease/epoch DB, dos imágenes y control Kubernetes mínimo. Incluye
además la capacidad base64url exacta de 32
caracteres por canal para chat privado, la admisión global serializada de salas
con bots, la aprobación/cuarentena persistente exacta de configuraciones y el
fencing PostgreSQL de autoridad por sala. El
gate Spoke pasó 68/68 pruebas, lint y build con Node 16.13.2/Yarn 1. Para
el head final pasan 128/128 pruebas del orquestador, 30/30 del generador, 58
recursos, Reticulum 430 pruebas + 5 properties y CI Cloud. Los gates raíz normal
y `--full` pasan con seguridad 43, recuperación 239, Pods 45, pull 19,
Deployment 18, Hubs 97, navegador 11, capacidad 115 fail-closed, Dialog 2,
Photomnemonic 7 y Spoke 68. No se afirma build de imágenes, checkpoint nuevo,
carga física, staging, deploy ni aceptación live.

Esos commits ya pertenecen a las ramas base de los subrepositorios y root
`main=9f4ada1` los fija tras el PR `#5`. Esta integración no implica build,
despliegue ni aceptación live.

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

En el corte integrado del 18 de julio de 2026:

- Hubs esta 89 commits propios por delante de `prod-2026-03-11` y no le falta
  ningun commit de esa release;
- Hubs CE esta 103 commits propios por delante de `2.1.0` y no le falta ningun
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
| Waypoints o character controller | movimiento, reserva autoritativa de dos clientes, sit/stand, lease/disconnect y Space targets |
| Networking/NAF | usuario remoto, namespace/ACK de bots, tipos `networkId`, late join, remove/reconnect |
| Media/avatar upload | normal, full-body/RPM histórico, GLB neutral, preview, privado y featured |
| Room settings/Reticulum | persistencia, permisos y normalizacion backend |
| Bots | admisión global, aprobación/cuarentena, token v1 + lease UUID/epoch DB, un Pod por sala, parent/runner credentials y digests separados, reconciliación/UID exactos, `/transport-ready`, Presence/ACK/navmesh `/ready`, chat, moderación/deadline, rate limit y privacidad |
| UI/i18n | desktop, tablet, movil, espanol y escena 3D visible |
| Spoke | 68/68 pruebas y lint/build legacy; después login, abrir proyecto, guardar y publicar en copia segura |
| Dialog/Coturn | entrada de sala y audio entre dos clientes |
| Generator/Kubernetes | 58 recursos, dos namespaces, un LB, dos digests bot, pull Secret privado, cuota, ValidatingAdmissionPolicy+binding, ServiceAccounts/RBAC efectivos mínimos, ocho NetworkPolicies, TLS y diff seguro |

## Conflictos previsibles

La personalizacion es amplia: frente a la release estable, Hubs modifica 172
archivos y Hubs CE 155. No significa que cada update produzca 327 conflictos;
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

Antes de desplegar el código integrado siguen bloqueando: `AUD-065` (checkpoint fresco
DB+storage y rotación coordinada), construcción/despliegue/atestación del
aislamiento por Pod y del fencing DB ya integrados, revisión y aprobación individual del
inventario que generará la migración ya integrada, y una parada autoritativa
más fuerte que el `room_stop` best-effort. También
faltan builds de imágenes por Actions, carga física, staging y aceptación live;
ningún gate de fuentes mide capacidad ni autoriza rollout público.

El orden de la campaña vigente es estricto: primero terminar y fusionar el
tooling `AUD-065`; después preparar las fuentes privadas, crear el checkpoint y
completar la rotación sobre el baseline live exclusivamente con
`deployment/rotate-process-local-credentials.sh`, la operación privada sellada,
la promoción atómica y el auditor read-only `aud065_rotation_verified`
descritos en `deployment/README.md`; el verificador global 0/0 se reserva para
la aceptación final del control plane aislado. A continuación implementar y fusionar
`AUD-078` en una rama
Cloud separada; solo entonces construir las imágenes por Actions y desplegar el
candidato. Un build anterior no sustituye ni adelanta checkpoint o rotación.

El cambio de runners se promociona con dos imágenes del mismo commit y tres
manifiestos completos de 58 recursos, regenerados sucesivamente con
`BOT_RUNNER_ACTIVATION_PHASE=bootstrap`, `admission` y `active`. Cada fase se
aplica exclusivamente desde `hubs-cloud/community-edition` mediante
`npm run apply` y un `KUBECTL_CONTEXT` exacto. El wrapper verifica el manifiesto,
serializa la mutación con el Lease global, mantiene el parent y los runners
parados hasta completar policy/RBAC/probe, y vuelve a cercar la autoridad si
detecta error o deriva. No usar un `kubectl apply -f hcce.yaml` directo para
saltar esa máquina de estados.

Los 58 recursos abarcan los namespaces `hcce` y `hcce-bot-runners`, cuota,
ValidatingAdmissionPolicy+binding, RBAC mínimo comprobado con revisiones
efectivas y ocho NetworkPolicies. Rollback en orden inverso: cero Pods runner,
parent legacy contra Reticulum compatible y solo después Reticulum antiguo.
El runtime `process-local` sigue siendo el último baseline live aceptado. Si se
usa como rollback de un candidato, los bots públicos permanecen deshabilitados
y no se reabre ni se declara aceptado de nuevo hasta superar preflight,
verificador live y carga fría actuales con las credenciales rotadas.

`kubectl apply` de un manifiesto viejo no poda ServiceAccounts, Role,
RoleBinding, `bot-images-pull` ni NetworkPolicy ausentes de ese YAML. El rollback
debe inventariarlos y mantenerlos inertes hasta una limpieza trackeada; no usar
parches manuales. El pull config se actualiza exclusivamente con
`npm run set-bot-image-pull-config`, `GHCR_TOKEN` oculto/en entorno y sin mostrar
`BOT_IMAGE_PULL_CONFIG_JSON_BASE64`.

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
