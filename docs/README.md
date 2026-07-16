# Documentacion activa de YenHubs

Este directorio contiene solo documentacion vigente. El material sustituido se
conserva en `OLD/` y nunca debe usarse como entrada operativa.

## Por donde empezar

| Necesidad | Documento |
| --- | --- |
| Entender el estado actual | `docs/project-handoff-2026-07.md` |
| Ver hallazgos, pruebas y riesgos | `docs/audit-2026-07.md` |
| Desarrollar o integrar upstream | `docs/development-workflow.md` |
| Saber que personalizaciones preservar | `docs/customization-inventory.md` |
| Desplegar y operar | `deployment/README.md` |
| Crear, congelar o recuperar un cliente | `deployment/client-instance-lifecycle.md` |
| Ver la actualizacion estable aceptada | `docs/upgrade-stable-2026.md` |
| Coste y escalabilidad de bots/Hubs | `docs/bots-cost-capacity-analysis-2026-07.md` |
| Historial cronologico | `docs/session-changelog.md` |

## Fuentes de verdad

1. `AGENTS.md` contiene reglas duraderas, no historial.
2. `deployment/README.md` define el unico despliegue aprobado.
3. `deployment/input-values.local.yaml` contiene valores reales locales y no se
   versiona.
4. El root fija los commits exactos de `hubs/` y `hubs-cloud/`.
5. Las imagenes de produccion se fijan por digest, no por `latest`.

## Comandos de entrada

```bash
./scripts/audit-upstream.sh
./scripts/verify-project.sh
./scripts/verify-project.sh --full
./deployment/preflight-reactivation.sh
./deployment/create-checkpoint.sh
```

Antes del checkpoint, exportar `EXPECTED_KUBE_CONTEXT` y
`EXPECTED_NAMESPACE_UID` siguiendo `deployment/client-instance-lifecycle.md`.
No ejecutar los dos ultimos comandos sin acceso al cluster correcto. El
checkpoint incluye base de datos y storage; un dump de PostgreSQL por si solo
no recupera escenas, proyectos, avatares o thumbnails.
