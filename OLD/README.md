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
| `OLD/docs/active-goal-plan-recovery-avanzado-2026-08-09.md` | objetivo de recovery avanzado detenido por sobrealcance y por no cerrar la reactivacion sobre un cluster nuevo | `docs/active-goal-plan-2026-07-18.md` |
| `OLD/docs/estado-sencillo-recovery-avanzado-2026-08-09.md` | panel humano del objetivo de recovery avanzado ya congelado | `docs/estado-sencillo.md` |
| `OLD/docs/PLAN_ACTUAL-h5-cerrado-2026-08-28.md` | plan completo que cerró H5 y el hardening operativo local posterior | `PLAN_ACTUAL.md` |
| `OLD/docs/PLAN_ACTUAL-feature-transition-2026-08-28.md` | transición completada desde H5 hasta la elección y ramas de Sitting v2 | `PLAN_ACTUAL.md` |
| `OLD/docs/PLAN_ACTUAL-sitting-v2-pre-inventory-2026-08-29.md` | plan Sitting v2 anterior al inventario que todavía no tenía target ni coste staging | `PLAN_ACTUAL.md` v3 |
| `OLD/features/avaturn-research/` | investigacion previa, iframe y ejemplos no usados | `features/avaturn/README.md` |
| `OLD/features/rpm-avatar-research/` | FBX, guias y prototipos anteriores ya sustituidos por la implementacion Mixamo/GLB integrada | `features/rpm-avatars/README.md`, codigo y pruebas en `hubs/` |
| `OLD/patches/third-person/` | diffs antiguos ya integrados | `features/third-person/doc-thirdperson.md` |
| `OLD/research/bit_ecs_research.md` | investigacion historica | codigo y auditoria vigentes |
| `OLD/research/third-person-analysis.md` | referencias previas a la implementacion | `features/third-person/doc-thirdperson.md` |
| `OLD/deployment/backup-ret-storage.sh` | stream standalone de ret-pvc retirado porque no podia producir un checkpoint valido junto con PostgreSQL | `deployment/create-checkpoint.sh` |

## Regla

Si un documento activo necesita informacion historica, debe resumir el dato
relevante y enlazar este archivo solo como evidencia opcional. Nunca debe exigir
un comando o fichero de `OLD/` para completar una operacion.
