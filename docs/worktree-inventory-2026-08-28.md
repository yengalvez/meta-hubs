# Inventario local de worktrees — 28 de agosto de 2026

Este snapshot se creó para abrir features sin limpiar, mezclar ni reutilizar
checkouts históricos. No es una cola de borrado. `Detrás/delante` compara cada
`HEAD` con `origin/main=48111017838051e6a095d1255a8dab5efbfd0973` mediante
`git rev-list --left-right --count origin/main...HEAD`.

| Ruta | Rama | Cambios | Detrás | Delante | Clasificación |
| --- | --- | ---: | ---: | ---: | --- |
| `/Users/Shared/Gits/YenHubs-features` | `codex/sitting-v2` | 0 | 0 | 6 | feature activa limpia |
| `/Users/Shared/Gits/YenHubs-client-hibernation` | `codex/hibernation-ops-hardening` | 0 | 0 | 5 | base limpia conservada; no editar para features |
| `/Users/Shared/Gits/YenHubs` | `codex/recovery-closure` | 28 | 63 | 14 | preservar; no limpiar ni reutilizar |
| `/Users/Shared/Gits/YenHubs-aud078-root` | `codex/aud078-root-integration` | 3 | 64 | 0 | preservar; revisar solo en una tarea futura específica |
| `/Users/Shared/Gits/YenHubs-p12-diagnostic` | `DETACHED` | 2 | 63 | 9 | preservar; revisar solo en una tarea futura específica |
| `/Users/yengalvez/.claude-worktrees/YenHubs/naughty-maxwell` | `naughty-maxwell` | 1 | 205 | 1 | ajeno a esta transición; preservar |
| `/Users/Shared/Gits/YenHubs-aud075-root` | `codex/aud075-integration` | 0 | 93 | 0 | histórico limpio; revisar después |
| `/Users/Shared/Gits/YenHubs-aud076-root` | `codex/aud076-integration` | 0 | 99 | 0 | histórico limpio; revisar después |
| `/Users/Shared/Gits/YenHubs-aud077-root` | `codex/aud077-integration` | 0 | 101 | 0 | histórico limpio; revisar después |
| `/Users/Shared/Gits/YenHubs-gates-security` | `codex/gates-security-final` | 0 | 122 | 1 | histórico limpio; revisar después |
| `/Users/Shared/Gits/YenHubs-gitleaks-policy-bootstrap` | `codex/gitleaks-policy-bootstrap` | 0 | 121 | 0 | histórico limpio; revisar después |
| `/Users/Shared/Gits/YenHubs-recovery-safety-final` | `codex/recovery-safety-final` | 0 | 122 | 1 | histórico limpio; revisar después |

Los submódulos del worktree activo están inicializados, limpios y en la rama
local `codex/sitting-v2`, con Hubs
`ce8390a8905fa38fa0acdb10d5f94290981477ec` y Cloud
`6d9ee9e998f636fcf61a4928cd2a275829768259`. Permanecen sin ediciones; un fallo
causal decidirá si alguno necesita un commit nuevo.
