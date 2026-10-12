# Minimal monthly snapshots

Owner decision, 12 October 2026: choose a small ordinary backup flow and allow
recoverable occasional failures. Implementation: deployment/monthly-backup-format.md.

Stop writers/PostgreSQL, create one native snapshot per bound volume, restore
saved replica counts; export from the captured clones to encrypted Drive only
after service health. No historical guardian, streaming fallback or automatic
capture retry. One finite deferred Job protects resume on executor loss.
The minimal route retains the ID from the official snapshot POST and reads
that ID directly, not a potentially stale global catalogue. The installed
HTTPS transport and existing auth-context selection have local wire coverage.

Local acceptance covers the real command with fictitious Kubernetes/DO,
second-snapshot failure, uncertain POST, executor interruption, partial rejection,
original counts, expired/concurrent Lease and Drive/restore format compatibility.
It does not accept real captures or restores. Those and calendar activation
remain separate steps in /Users/Shared/Gits/YenHubs/PLAN/Plan_activo.md.
