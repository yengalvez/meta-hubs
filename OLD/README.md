# OLD - Archivo historico

Este directorio conserva evidencia que puede ser util para investigar decisiones
pasadas. No contiene fuentes de verdad operativas y no debe usarse para
desplegar, actualizar ni implementar features.

## Inventario

| Ruta | Motivo | Sustituto activo |
| --- | --- | --- |
| `OLD/docs/hubs-ce-digitalocean-deploy-guide.md` | guia inicial sustituida | `deployment/README.md` |
| `OLD/docs/project_maintenance.md` | mezclaba mantenimiento e historial | `AGENTS.md`, `docs/development-workflow.md` |
| `OLD/docs/reactivation-audit-2026-07.md` | plan/evidencia de reactivacion ya ejecutada | `docs/audit-2026-07.md` |
| `OLD/docs/reactivation-media-recovery-2026-07.md` | investigacion del contenido perdido de marzo | `docs/project-handoff-2026-07.md` |
| `OLD/docs/project-freeze-2026-03.md` | freeze incompleto sin `ret-pvc` | `deployment/client-instance-lifecycle.md` |
| `OLD/features/avaturn-research/` | investigacion previa, iframe y ejemplos no usados | `features/avaturn/README.md` |
| `OLD/patches/third-person/` | diffs antiguos ya integrados | `features/third-person/doc-thirdperson.md` |
| `OLD/research/bit_ecs_research.md` | investigacion historica | codigo y auditoria vigentes |
| `OLD/research/third-person-analysis.md` | referencias previas a la implementacion | `features/third-person/doc-thirdperson.md` |

## Regla

Si un documento activo necesita informacion historica, debe resumir el dato
relevante y enlazar este archivo solo como evidencia opcional. Nunca debe exigir
un comando o fichero de `OLD/` para completar una operacion.
