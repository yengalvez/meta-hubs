# Documentacion activa de YenHubs

Este directorio contiene las fuentes vigentes y cortes historicos marcados. El
material sustituido se conserva en `OLD/` y nunca debe usarse como entrada
operativa.

## Por donde empezar

| Necesidad | Documento |
| --- | --- |
| Entender el estado actual en lenguaje sencillo | `docs/estado-sencillo.md` |
| Continuar la unica meta activa | `docs/active-goal-plan-2026-07-18.md` |
| Ver auditoria, decision y riesgos vigentes | `docs/audit-general-2026-08-09.md` |
| Ver el contrato minimo de hibernacion | `docs/client-hibernation-design-v1.md` |
| Desarrollar o integrar upstream | `docs/development-workflow.md` |
| Saber que personalizaciones preservar | `docs/customization-inventory.md` |
| Desplegar y operar | `deployment/README.md` |
| Crear, congelar o recuperar un cliente | `deployment/client-instance-lifecycle.md` |
| Ver la actualizacion estable aceptada | `docs/upgrade-stable-2026.md` |
| Evaluar el futuro de avatares GLB | `docs/avatar-provider-evaluation-2026-07.md` |
| Coste y escalabilidad de bots/Hubs | `docs/bots-cost-capacity-analysis-2026-07.md` |
| Auditar y modernizar Spoke por fases | `docs/spoke-legacy-audit-2026-07.md` |
| Historial cronologico | `docs/session-changelog.md` |

El handoff, la auditoria y la matriz de evidencia de julio son cortes
historicos. Conservan evidencia util, pero no deciden la siguiente accion si
contradicen el plan activo.

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
./scripts/verify-project.sh --full
./deployment/preflight-reactivation.sh
./deployment/create-checkpoint.sh
```

`--full` incluye el bloque normal; no ejecutar ambos seguidos sobre los mismos
bytes. El comando normal se reserva para iteracion intermedia.

Antes del checkpoint, exportar `EXPECTED_KUBE_CONTEXT` y
`EXPECTED_NAMESPACE_UID` siguiendo `deployment/client-instance-lifecycle.md`.
No ejecutar los dos ultimos comandos sin acceso al cluster correcto. El
checkpoint incluye base de datos y storage; un dump de PostgreSQL por si solo
no recupera escenas, proyectos, avatares o thumbnails.
