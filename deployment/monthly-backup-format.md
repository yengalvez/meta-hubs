# Monthly snapshots: minimal operator

This route is implemented locally. A local simulation is not acceptance of a real
DigitalOcean pair, restored metaverse or enabled calendar.
Current authority and results: /Users/Shared/Gits/YenHubs/PLAN/Plan_activo.md.

## Capture

`deployment/create-monthly-snapshot.sh /absolute/new-private-directory` invokes
`monthly-minimal-snapshot.mjs` directly. It cannot fall back to SQL/media streaming
or the historical guardian. Backend/format selectors remain native-monthly and
native-monthly-v1; conflicting or empty selectors reject.

Required explicit inputs: ALLOW_CHECKPOINT_DOWNTIME=1, MONTHLY_INSTANCE_ID,
MONTHLY_REGION=ams3, EXPECTED_KUBE_CONTEXT=do-ams3-hubs-ce, NAMESPACE=hcce,
EXPECTED_NAMESPACE_UID, EXPECTED_DB_PVC_UID, EXPECTED_RET_PVC_UID, VALUES_FILE,
HCCE_MANIFEST_PATH and PROCESS_LOCAL_CUTOVER_KEY_PATH. Private inputs are read by
path and never printed. Do not use historical values or fixtures in production.

One global operation Lease excludes another backup/deploy. Under that lock the
operator identifies both PVC/PV/DO volumes and saves original replica counts and
images. It prepares one finite Kubernetes recovery Job before changing replicas.
The Job uses the existing digest-pinned bot image, copies only image-pull Secret
names, has named get/patch RBAC, no snapshot permission and backoffLimit=0.

The sequence stops writers, captures the database contract, runs sync and stops
PostgreSQL gracefully. Two native volume snapshots are created during this same
pause, one POST per volume through the official HTTPS API. The installed doctl
discards the POST response and the global catalogue can lag behind it; the
minimal route instead retains the POST response ID and GETs that exact volume
snapshot directly. There is no continuously sampled source/counter guardian.
POST and canonical GET share the original total30-second native budget, including
credential resolution, with no catalogue discovery, polling or repeated POST.
The API uses the same existing active doctl auth context; a non-default context
does not silently switch to an environment/root token. Credentials go through
curl stdin only, with fixed HTTPS origin, verified TLS and no redirects.
Private journal events
record field presence/types/matches before validation, without raw provider
output or unknown tag values. An incomplete canonical GET remains a failure.
The ordinary five-minute operation limit is for this new method; the old
guardian's 30/10-second rules have not been enlarged or bypassed.

Success and ordinary error both restore original counts, including disabled
services. The native recovery Job maintains the same lock and requests resume
at the deadline if the executor disappears; maintenance-read failure does not
discard that request. A changed UID/holder is refused. Recovery attempts other
exact services even when one fails. Failure leaves the partial and original cause
for reconciliation; no capture retry or deletion of previous backups occurs.

## Publication and transport

Only after service readiness and deferred-recovery cleanup does the operator
remove its incomplete marker and emit the native publication line. The compact
format is schema_version=5/runtime_generation=minimal-snapshot-v1: seven files
(source, pair, metadata, DB contract, images, private runtime archive and attempt
log) plus SHA256SUMS. Old fourteen-file points remain readable, not executable.

The runtime archive contains fixed private files input-values.yaml, hcce.yaml
and cutover.key; upload only its encrypted portable export. The monthly driver
checks Deployments Ready and room HTTP immediately after resume, before clones
or Drive. This brief check is not the full product/browser verifier.

Drive, encryption, custody, snapshot-clone export, restore readers, budgets,
retention (two DO pairs/ten Drive months) and the existing monthly ledger are
reused. No Spaces, Velero or new Google billing. Enable the calendar only after
a complete real pair, Drive readback and one isolated restore per format.

Capture, export and retention recheck each exact snapshot ID, name, source volume, region, creation
time and minimum disk capacity. `billableGiB` is a mutable provider billing
statistic, not snapshot identity: an update after capture must not reject export.
Its GET value still must be finite and nonnegative. Capacity-based clone budgets
and the hashed native capture remain unchanged; this exception does not permit
a different snapshot, rewritten capture or acceptance of a failed monthly attempt.
Retirement still issues one UUID-bound DELETE only after immutable identity and
valid provider metadata; its successful exit is not proof of subsequent absence.

## Local verification

`node scripts/verify-monthly-backup.mjs --evidence-dir /absolute/empty-private-dir`
runs only the declared affected components, installed curl against verified
loopback TLS, installed doctl against a non-forwarding loopback server and the
direct minimal CLI against fictitious
Kubernetes/DO executables. Its checks record original native exits and code pins.
No historical H5/full recovery coordinator is selected. These are development
tests, not an audit performed before every monthly snapshot.

The preceding protected implementation and its evidence are preserved in Git
and OLD/docs/monthly-backup-format-protected-20261012.md. They do not authorize
reviving its guardian or old goals.
