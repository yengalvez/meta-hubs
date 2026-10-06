# Monthly portable backup: local component

This component encrypts and verifies a portable PostgreSQL/media/runtime package.
It does **not** capture snapshots, pause services, contact a provider, rotate
backups, schedule jobs or establish production restore acceptance.

## Native capture components (not yet an operational coordinator)

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
PostgreSQL/control guards remain active. Integration with that parent is still
pending; an arbitrary callback is not production acceptance.

The engine fsyncs a private intent journal before each single POST, reads back
both exact native identities, and rejects existing monthly names, another source,
region/type/time mismatch, changed readback or a late boundary failure. A failed
or ambiguous POST is never retried automatically; a first snapshot is not erased
or accepted as a pair. Its output is `captured-not-restore-accepted`; it cannot
prove parent terminal joins, writer resume, Drive export or either real restore.

The deployed PostgreSQL source is major12. Physical snapshot recovery must use
that compatible major/image; the existing local14.23 portable-format fixture does
not validate a physical12 snapshot. Primary references:
[DO native volume snapshots](https://docs.digitalocean.com/products/snapshots/how-to/snapshot-volumes/)
and [PostgreSQL12 filesystem backup](https://www.postgresql.org/docs/12/backup-file.html).
DO snapshots do not themselves flush application/filesystem caches. Preserve the
coordinated writer pause and verify a flush plus recovery, rather than inferring
coherence from two successful native requests.

## Producer contract

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
node tests/recovery/monthly-portable-postgres-proof.mjs
```

The last command starts its own local PostgreSQL server on a private Unix socket,
without a TCP listener or production credentials. It creates a two-row fixture,
exports all three payloads, encrypts/decrypts them, restores to a second database,
compares media hashes and configuration, and stops only that local server.
It is a small format proof, **not** a production-size timing measurement or either
of the required DigitalOcean/Drive recovery acceptances. Requires existing
PostgreSQL tools, standard age and tar. It never installs or downloads software.

## Owner authorization for unattended Drive access

`monthly-drive-authorize.mjs --config NEW_PRIVATE_CONFIG_PATH` starts the official
rclone browser flow with only `drive.file`, without opening Chrome. Its stdout
exposes only the loopback login URL and a sanitized terminal result; OAuth token
output stays in memory and is saved to the dedicated0600 configuration. The parent
directory must already be private and canonical. Existing configurations are not
overwritten. A failed attempt may leave an empty claimed file, never usable auth.

Stop at Google's consent screen for the owner's approval. Authorization alone
does not prove folder access, transfer, refresh or scheduling. `drive.file` may not
allow access to a folder created by a different connector: verify the chosen
folder rather than silently broadening scope. Retain recovery access separately
from the encrypted backups. Five parser/link tests cover the installed rclone
result format without exposing real credentials.

On06/10 the owner flow90771 completed natively with AUTHORIZED/drive.file and a
nonempty private0600 config. This is not a successful transfer: the read-only
folder request returned Google's403 shared-client requests-per-minute quota
error. Do not broaden scope, create a Cloud project/client, or loop retries from
that failure. Folder access, byte readback and unattended transfer remain pending.
