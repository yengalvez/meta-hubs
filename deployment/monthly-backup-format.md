# Monthly backup components: local implementation, not operational acceptance

The portable component encrypts and verifies PostgreSQL/media/runtime packages.
The explicit native backend is now connected to the existing protected capture
coordinator. Its code can pause/resume workloads and create native snapshots;
it is **not yet approved for production use**. No monthly capture, isolated
DO/Drive restore, rotation or scheduler has been accepted.

## Native capture and protected parent

`monthly-snapshot-source.mjs` binds each PVC/PV UID to its actual DigitalOcean
volume with one native GET per volume. It rejects a rebound claim, another driver,
region/capacity mismatch or ambiguous/unready consumer. Its read-only PostgreSQL
probe uses the directory reported by the running server and requires WAL on the
same filesystem, no external tablespaces, fsync/full_page_writes enabled and a
known sync command. It performs no flush, checkpoint, stop or capture. The
inventory is explicitly `inventory-not-captured`.

`monthly-snapshot-pair.mjs` supplies the native DO adapter and pair engine, **not a
stand-alone mutating CLI**. The protected parent must provide the real boundary
checks and filesystem flush while the existing Lease, writer and continuous
PostgreSQL/control guards remain active. The new fixed worker supplies those
checks only through the existing DB child's gated session. An arbitrary callback
or a successful worker unit test is not complete-coordinator acceptance.

The engine fsyncs a private intent journal before each single POST, reads back
both exact native identities, and rejects existing monthly names, another source,
region/type/time mismatch, changed readback or a late boundary failure. A failed
or ambiguous POST is never retried automatically; a first snapshot is not erased
or accepted as a pair. Its output is `captured-not-restore-accepted`; it cannot
prove parent terminal joins, writer resume, Drive export or either real restore.

`create-checkpoint.sh` retains `CHECKPOINT_BACKEND=legacy` by default. The explicit
`native-monthly` backend requires the durable-v2 runtime, exact context/UIDs,
`MONTHLY_INSTANCE_ID`, `MONTHLY_REGION` and an existing private0700
`MONTHLY_JOURNAL_ROOT`. It preserves the operation Lease, runner/fence and writer
monitors, complete before/after database contracts, continuous PGSQL source
monitor, native parent joins, abort recovery and final no-clobber publication.
The capture does not stream the entire media disk through the paused source.

The fixed `monthly-snapshot-worker.mjs` is not an operator entrypoint. Its five
arguments are private source inventory, new journal directory, civil month,
operation ID and the private before-contract. All three original guard kinds
and Lease supervision are mandatory in `recovery_kubectl_stream_supervised`;
there is no arbitrary-command switch or weakened30/10s/reserve2s deadline.

`monthly-native-bundle.mjs` validates a separate fourteen-artifact closed set:
the eleven inventories/contracts, `monthly-source.json`, `native-pair.json` and
`runtime.tar.gz`. It does not label snapshots as SQL dumps or allow the legacy
restore validator to accept them. `runtime.tar.gz` contains only fixed regular
entries `input-values.yaml`, `hcce.yaml` and `cutover.key`, read from pinned
private0600 files before the pause. This archive remains private locally; only
the portable component's encrypted output may go to Drive. Recovery/decryption
key custody is separate and still needs verification.

Local checks: new worker/bundle/routing16/16, including real child execution
with fixture-only provider binaries and a failed media POST without retry;
shared native process supervision57/57. These do not exercise the complete new
capture coordinator end-to-end or substitute for its full gate and real restore.

The closed monthly provider fixture exec-dispatches protected kubectl calls
directly to the original local fake. It must not insert a Node child in that
fallback: the existing Lease WATCH/GET handoff is keyed by the guard's parent
identity. A focused native test reproduces the former orphaned handoff and
verifies its removal plus a real fixture CAS; no production guard is relaxed.

The deployed PostgreSQL source is major12. Physical snapshot recovery must use
that compatible major/image; the existing local14.23 portable-format fixture does
not validate a physical12 snapshot. Primary references:
[DO native volume snapshots](https://docs.digitalocean.com/products/snapshots/how-to/snapshot-volumes/)
and [PostgreSQL12 filesystem backup](https://www.postgresql.org/docs/12/backup-file.html).
DO snapshots do not themselves flush application/filesystem caches. Preserve the
coordinated writer pause and verify a flush plus recovery, rather than inferring
coherence from two successful native requests.

## Isolated data recovery checks

`monthly-restore-input.mjs` downloads only the five IDs pinned in the verified
Drive record. Root/month ownership, versions, bytes, MD5 and SHA256 are checked
before/after; changed sharing or an ambiguous read never triggers an upload,
repair or second attempt. Outputs remain in new private paths. A closed decrypted
point must match its three payload hashes, native manifest, source snapshots,
month, operation and PostgreSQL major. An existing COMPLETE materialization may
be reconciled read-only; a partial one is never filled in or accepted.

Both native runtime and media producers use explicit USTAR. Media export contains
only `owned`, matching the existing Reticulum two-shard contract; unrelated disk
directories are not media. The streaming local decoder rejects links, hardlinks,
PAX, unexpected paths, wrong shards, incomplete pairs and excessive expansion.
It never invokes `tar -x` on unknown bytes. USTAR does not support a single entry
of8GiB or greater; such an export must fail, not silently drop the entry. The
current decoder caps expansion at40GiB and one million entries; this is a bounded
recovery format, not a promise to accept arbitrary future disk layouts.

`tests/recovery/monthly-portable-restore.mjs` is an opt-in LOCAL data canary,
not a production restore command. It requires the source's PostgreSQL major,
starts a new private Unix-only database, compares the complete database contract,
all COPY rows and canonical SQL, checks every active owned-file pair and all
media hashes, and proves its owned server stopped before reporting success.
Runtime/configuration bytes are validated but the app is NOT deployed here.

Native format-only proof on08/10: PG14.23,356 tables,178 rows, one media pair,
original exit0 in2.870s, source and target servers stopped. This is NOT acceptance
of the PostgreSQL12 metaverse, either real snapshot route, or an installation.
Nine media/runtime parser tests and fifteen download/materialization/binding
tests passed; the actual export-command fixture passed with explicit USTAR and
`owned`. All new monthly unit components are registered in `run_security`.
No new full, production effect, key custody or actual calendar acceptance is
inferred from those focused results. A bounded adversarial primary pass is not
an independent reviewer result.

## Producer contract

### Export from the frozen snapshots

`monthly-snapshot-export.mjs` requires a closed fourteen-artifact native bundle
plus SHA256SUMS and a completion receipt written only after the original protected
capture command exits natively0. Missing receipts, incomplete markers, additional
files or changed source identities are rejected. A disappearing process is not
capture acceptance.

`monthly-snapshot-export-provider.mjs` generates a separate temporary namespace
and imports each original snapshot through retained VolumeSnapshotContent,
VolumeSnapshot and a new CSI PVC. This follows the
[official DO snapshot import route](https://docs.digitalocean.com/products/kubernetes/how-to/import-snapshot/);
[API-created volumes cannot be attached directly to DOKS](https://docs.digitalocean.com/products/kubernetes/how-to/add-volumes/).
No source PVC is mounted. The clone server uses the captured PostgreSQL12 digest,
a private Unix socket, no API token and no TCP listener. Both complete database
contracts must match before and after native dump/media export; downloaded bytes
must match their remote sizes and SHA256.

The encrypted portable runtime payload contains ALL native artifacts and their
SHA256SUMS, including the fixed inner runtime/configuration archive. It is not
merely the three configuration files. Export completion is explicitly
`sealed-not-restore-accepted`; it does not accept either isolated restore.

Temporary objects are removed only with recorded UID/resourceVersion
preconditions. Original snapshot contents remain Retain. Cleanup checks the
absence of both new PVs and their DO volumes and retention of both originals.
Ambiguous creation or cleanup stops without automatic retries/adoption. A stuck
cleanup can continue accruing costs and must be reported, not labelled complete.
The one-hour working limit and <=1USD owner gate remain mandatory;
[volume billing](https://docs.digitalocean.com/products/volumes/details/pricing/)
is an hourly estimate, not a guaranteed cap if cleanup fails.

Local acceptance:25 focused tests, real age/tar/native-child operations on
fixtures; four original kubectl exits0 against a loopback-only API in150ms.
The loopback server initially rejected kubectl's `?timeout=10s` query: URL parsing
was corrected in the fixture only. No production/export guard was weakened.
Native syntax and the generated POSIX server's ShellCheck passed. This does not
prove real CSI provisioning, production-sized export or cleanup. Do not activate
capture or monthly scheduling until final gates and independent recovery-key
custody are resolved.

`monthly-portable-point.mjs` exports `sealPortablePoint` and `openPortablePoint`.
The producer must first establish a coherent, identified DB/media snapshot pair.
Export from frozen copies, not independently from changing production data.

The three required inputs are a PostgreSQL custom-format dump, a compressed media
archive and a compressed runtime/configuration archive. Inputs and recovery keys
must be private regular files owned by the executing user: mode0600, no symlinks
or hard links. Paths must be canonical. Output directories are newly claimed with
mode0700; existing attempts are never overwritten.

The `binding` contains `instanceId`, civil `month` (`YYYY-MM`) and `operationId`.
Snapshot identity and provenance may be included in the encrypted binding, but
the transport module does not authenticate or accept their source by itself.

## Transport and recovery

The transport directory contains exactly four age-encrypted files plus
`portable-point.json`. Database, media, runtime and manifest plaintext are not
stored in that transport directory. The public receipt contains only binding
labels, ciphertext sizes and SHA256 hashes, not runtime values or keys.

Use a dedicated public age recipient for encryption. The private recovery key
belongs in separate, recoverable custody, never in the package, Git, a command
argument or an unattended cloud capture worker. The current tests use disposable
fixture keys only; production key custody is **not configured**.

Opening a downloaded package verifies ciphertext hashes, decrypts into a new
private quarantine directory and verifies the encrypted binding and plaintext
hashes. It does not extract unknown archives or execute a restore. Its receipt
states `verified-not-restore-accepted`. Decryption is not application acceptance.

Archive path validation, bounded provider/child execution, native provenance,
actual Drive byte readback, production key custody and isolated restore acceptance
remain responsibilities of the complete pipeline before production use.

## Bounded verification

```sh
node --test tests/scripts/monthly-backup-retention.test.mjs
node --test tests/scripts/monthly-portable-point.test.mjs
node --test tests/scripts/monthly-snapshot-source.test.mjs
node --test tests/scripts/monthly-snapshot-pair.test.mjs
node --test tests/scripts/monthly-snapshot-worker.test.mjs tests/scripts/monthly-native-bundle.test.mjs tests/scripts/monthly-native-routing.test.mjs
node --test tests/scripts/monthly-fixture-attestation.test.mjs
node --test --test-concurrency=1 tests/recovery/monthly-provider-dispatch.test.mjs
node --test --test-concurrency=1 tests/recovery/monthly-native-coordinator.test.mjs
node tests/recovery/monthly-portable-postgres-proof.mjs
```

The PostgreSQL proof command starts its own local server on a private Unix socket,
without a TCP listener or production credentials. It creates a two-row fixture,
exports all three payloads, encrypts/decrypts them, restores to a second database,
compares media hashes and configuration, and stops only that local server.
It is a small format proof, **not** a production-size timing measurement or either
of the required DigitalOcean/Drive recovery acceptances. Requires existing
PostgreSQL tools, standard age and tar. It never installs or downloads software.

The coordinator regression reuses a local copy of the existing durable harness,
with an explicit fixed UUID fixture identity and closed fake provider programs.
Real pause/fence/monitor/join/publication/resume scripts run unchanged. It checks
fourteen artifact hashes and writer/Lease recovery, including a failed media
POST with no retry. The new fixed local attestation has seven focused rejection
tests; it cannot admit arbitrary UUIDs or any production context. The recovery
section runs this regression before the established suite. Do not run the whole
coordinator regression from a dirty source checkout: its original clean-tree
guard remains mandatory. This test is not a production capture or restore.

The local monthly SQL response is derived from the complete existing fixture
contract with `sql_dump_sha256:null`, matching the actual live query; a frozen
dump-file hash must not be passed off as a live database contract. The closed
adapter accepts only the worker's five exact timed source-read/sync forms.
Protected WATCH/Lease/mutations still exec the established fake unchanged.
Five dispatch/contract tests passed; the previous integral attempt90597 failed
before sync/POST and resumed all five simulated writers. No production guard
was relaxed, and a new integral pass is still required.

Attempt22190 accepted the positive simulated capture (native0, fourteen hashes,
five writers resumed) but failed its media-error recovery: the terminal Watch
reported code0/no signal, and the original stop contract correctly refused resume.
The inherited short-bookmark fake is unsuitable for terminal overlap. A focused
native comparison confirms that default fake exits0 immediately, while the
existing `checkpoint-writer-terminal-live` peer remains open and closes with its
owned SIGTERM. The monthly driver now selects that peer and requires live terminal
continuity explicitly. Production watcher/stop contract/limits are unchanged;
six dispatch tests passed, with the changed bounded lifecycle test1/1 afterward.
This establishes the fixture mismatch, not a historical production cause. Both
integral cases must pass on the newly frozen bytes before the full gate.

## Guarded monthly execution and retention (not activated)

`monthly-backup-runtime.mjs --config PRIVATE_RUNTIME_JSON --mode validation`
joins the original protected capture, isolated snapshot export and dedicated
Drive transport in one sequential attempt. Before any pause it requires exact
clean code, final15/15 acceptance, independent key-custody evidence, a currently
private Drive destination, source UIDs and the approved20GiB source/budget.
The validation route never rotates history and never claims real restore.
`--mode scheduled` additionally requires enabled configuration and both isolated
restore receipts. No scheduler has been installed or enabled.

One private attempt directory is claimed and fsynced per civil Madrid month.
An incomplete attempt stops subsequent runs for reconciliation; it does not retry
capture or cloud writes. A completed existing month is checked against provider
identities/versions and never recaptured. Each original phase records its own
timing. The runtime binds active private values/manifest/key by route, not the
historical `deployment/input-values.local.yaml`, and rejects changed inputs.

`monthly-retention-executor.mjs` derives its retirement list from the existing
two/ten planner and exact producer/readback receipts. Drive receipt versions
are now persisted alongside the five verified hashes/IDs. Retained originals
and remote files are rechecked at retirement boundaries. Cross-month reused
IDs, changed/sharing/extra files, partial upload and ambiguous DELETE/PATCH stop.
DigitalOcean snapshot deletion is immutable-ID-only, one native request, followed
by list-absence proof. Native0 alone is not absence evidence.

The dedicated upload provider remains create-only by default. Only an explicit
retention adapter can move the five exact old backup files to Drive's recoverable
trash; no folder cascade, permanent DELETE or emptyTrash. Empty folders remain.
As [Google documents](https://developers.google.com/workspace/drive/api/guides/delete),
trashed files can be recovered for30days and continue using quota until removal.
This is not a server-side transaction or a claim of atomic protection against
concurrent owner edits; metadata checks and recoverable file-only retirement
bound that risk. No real snapshot or Drive file was retired in these tests.

Local acceptance:72 directed adapter/retention tests natively0; after the bounded
malformed-version/journal repairs,23 relevant tests natively0. Runtime16/16 and
the latest directory/fsync/root-sharing integration4/4 passed on fixtures.
After binding the producer ciphertexts to Drive readback and the rotation result
to the exact month/operation, the35 affected runtime/retention tests passed.
These results do NOT accept a real monthly capture, restore, rotation or calendar.

`monthly-backup-calendar.mjs` prepares, but does not install/start, one macOS
LaunchAgent: day1 at03:00 Europe/Madrid, login catch-up, no KeepAlive/retry loop,
absolute executable paths and private logs. Six local tests passed, including
native plutil parsing. It runs Node mechanically, not a Codex Goal or monitor.
The Mac must be available and the owner logged in; months the machine never runs
cannot be recovered by pretending they were captured. This is a prepared timer,
not an accepted always-on cloud service. Activation requires final code, custody,
isolated real restores and an observed real invocation. No launchctl was called.

## Owner authorization for unattended Drive access

`monthly-drive-authorize.mjs --config NEW_PRIVATE_CONFIG_PATH --client-json PRIVATE_INSTALLED_CLIENT_JSON`
starts the official rclone browser flow with only `drive.file`, without opening Chrome. Its stdout
exposes only the loopback login URL and a sanitized terminal result; OAuth token
output stays in memory and is saved to the dedicated0600 configuration. The parent
directory must already be private and canonical. Existing configurations are not
overwritten. A failed attempt may leave an empty claimed file, never usable auth.

The downloaded JSON must be a private0600, canonical, single-link installed-app
client for the owner-authorized project `yenhubs-backups-20261006`; web clients,
foreign projects/endpoints, oversized files and INI injection are rejected before
login. Client ID/secret are passed only through the private child's environment,
not argv or the base64 scope-only blob. Inherited Rclone overrides are removed,
global config is excluded via `/dev/null`, and dedicated ID/secret/token are
preserved together in the new private config for refresh. Twelve focused tests
use fake credentials and a closed child, not a real Google authorization.

Stop at Google's consent screen for the owner's approval. Authorization alone
does not prove folder access, transfer, refresh or scheduling. `drive.file` may not
allow access to a folder created by a different connector: verify the chosen
folder rather than silently broadening scope. Retain recovery access separately
from the encrypted backups. Parsing/login tests do not accept Drive transport.

On06/10 the owner flow90771 completed natively with AUTHORIZED/drive.file and a
nonempty private0600 config. This is not a successful transfer: the read-only
folder request returned Google's403 shared-client requests-per-minute quota
error. That failure alone does not authorize scope expansion, Cloud resources or
retry loops. Folder access, byte readback and unattended transfer remain pending.

A subsequent single read-only query again failed at root-directory discovery
with403 shared-project quota. The installed1.75.1 warning and the
[official Rclone documentation](https://rclone.org/drive/#making-your-own-client-id)
state that the shared client is being retired in2026. Do not activate a monthly
scheduler on this credential as if it were a reliable dedicated connection.
The owner authorized a dedicated OAuth client with only `drive.file`, no billing
and no new terms. Its isolated Cloud project `yenhubs-backups-20261006` exists;
no client credentials have been created. Google requires accepting its API
Services User Data Policy during app setup. Stop at that unchecked box and let
the owner review/accept it; authorization to configure is not authorization to
accept new terms. No billing was activated or terms accepted.

Before scheduling monthly operation, finish the dedicated app's publishing state:
Google documents that External/Testing refresh tokens with Drive scope expire
after seven days, so Testing cannot be accepted as unattended monthly access.
Obtain a fresh owner consent after the suitable state is confirmed and verify
refresh plus exact byte readback without broadening `drive.file`. Stop if Google
requires new terms, billing or an owner approval. Source:
[Google OAuth token lifecycle](https://developers.google.com/identity/protocols/oauth2#expiration).
No publishing state, client, real token or unattended access is accepted yet.
