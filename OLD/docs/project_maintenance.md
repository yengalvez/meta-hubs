# YenHubs Project Maintenance

This file describes repository maintenance only. The authoritative infrastructure and deployment procedure is
`/Users/Shared/Gits/YenHubs/deployment/README.md`; do not duplicate or improvise its commands here.

## Repository layout

- `/Users/Shared/Gits/YenHubs`: superproject, feature documentation and deployment configuration. Base branch: `main`.
- `/Users/Shared/Gits/YenHubs/hubs`: customized Hubs client submodule. Base branch: `master`.
- `/Users/Shared/Gits/YenHubs/hubs-cloud`: Hubs CE generator, Reticulum and bot orchestrator submodule. Base branch: `master`.
- `/Users/Shared/Gits/YenHubs/deployment/input-values.local.yaml`: local source of truth for real values and secrets.
  It must never be committed.

The superproject pins exact submodule commits. A change is not fully integrated until the subrepo commit exists and
the parent repository records the new submodule pointer.

## Feature workflow

1. Create a short-lived `codex/<feature>` branch in the affected subrepo.
2. Implement and validate the change there.
3. Build container images only with the approved GitHub Actions workflows.
4. Update the ignored local image override.
5. Generate and verify the manifest with `npm run gen-hcce`.
6. Deploy with `kubectl apply -f hcce.yaml` and complete the live checks in the deployment guide.
7. Merge accepted work to the subrepo base branch, then update the parent submodule pointer.

If GitHub Actions or the standard deployment path fails, stop and report the failure. Do not switch to local Docker,
in-cluster builds, runtime file copying, `kubectl set image`, manual manifest edits or post-apply RBAC patches without
explicit owner approval.

## Required validation

### Hubs client

```bash
cd /Users/Shared/Gits/YenHubs/hubs
npm ci
npm run check
npm run lint:js
npm run build
```

### Hubs CE generator

```bash
cd /Users/Shared/Gits/YenHubs/hubs-cloud/community-edition
npm ci
npm run gen-hcce
npm audit
```

`gen-hcce` must finish with `Manifest verification passed`. The generated manifest must remain unedited.

### Bot orchestrator

```bash
cd /Users/Shared/Gits/YenHubs/hubs-cloud/community-edition/services/bot-orchestrator
npm ci
npm test
npm audit --omit=dev
```

## Upstream updates

Do not merge an upstream Hubs release, Hubs CE update and Reticulum dependency modernization into one change. Use this
order:

1. Restore and validate the known baseline.
2. Create a fresh database backup.
3. Integrate a tagged Hubs production release in its own branch.
4. Integrate a tagged Hubs CE release in a separate branch.
5. Modernize Reticulum/toolchain separately with migration and rollback tests.

The accepted July 2026 baseline and residual risks are tracked in
`/Users/Shared/Gits/YenHubs/docs/audit-2026-07.md`. Start future work from
`/Users/Shared/Gits/YenHubs/docs/project-handoff-2026-07.md`.

## Secrets and operational invariants

- Never print, commit or paste tokens, passwords, SMTP credentials, `PERMS_KEY`, `BOT_ACCESS_KEY` or OpenAI keys.
- Keep `PERMS_KEY` stable across Reticulum and Dialog. A mismatch causes room join failures and JWT signature errors.
- Bots use the `ghost` backend by default. Chromium is opt-in only because it consumes substantially more CPU/RAM.
- Keep exactly one Kubernetes `Service` of type `LoadBalancer` and one non-HA node unless a cost increase is approved.
- The session history belongs only in `/Users/Shared/Gits/YenHubs/docs/session-changelog.md`.

## Recovery references

- Deployment and reactivation: `/Users/Shared/Gits/YenHubs/deployment/README.md`
- Frozen backup handoff: `/Users/Shared/Gits/YenHubs/docs/project-freeze-2026-03.md`
- Audit register: `/Users/Shared/Gits/YenHubs/docs/audit-2026-07.md`
- Current project handoff: `/Users/Shared/Gits/YenHubs/docs/project-handoff-2026-07.md`
- Feature docs: `/Users/Shared/Gits/YenHubs/features/`
