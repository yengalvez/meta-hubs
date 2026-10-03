// Private abort-only receipt. It is deliberately outside the accepted backup
// artifact set and never authorizes publication of an interrupted copy.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { captureReceipt, captureAuthorityReceipt } = require("../hubs-cloud/community-edition/apply/recover-avatar-checkpoint.js");

export function captureFromEnvironment(directory, env = process.env) {
  const signed = Boolean(env.RECOVERY_BACKUP_AUTHORITY_KEYRING || env.RECOVERY_BACKUP_AUTHORITY_KEY_ID);
  if (signed && (!path.isAbsolute(env.RECOVERY_BACKUP_AUTHORITY_KEYRING || "") ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(env.RECOVERY_BACKUP_AUTHORITY_KEY_ID || ""))) {
    throw new Error("receipt_authority_selection");
  }
  const incident = {
    context: env.EXPECTED_KUBE_CONTEXT, namespace: env.NAMESPACE,
    namespaceUid: env.RECOVERY_NAMESPACE_UID, pvcUid: env.RECOVERY_PVC_UID,
    operation: env.RECOVERY_OPERATION_ID, stamp: env.RECOVERY_CHECKPOINT_STAMP,
    lockUid: env.RECOVERY_OPERATION_LOCK_UID, lockRv: env.RECOVERY_OPERATION_LOCK_RESOURCE_VERSION
  }, contract = JSON.parse(env.RECOVERY_CONSUMER_CONTRACT_JSON), sources = {
    values: env.CHECKPOINT_VALUES_SNAPSHOT, manifest: env.CHECKPOINT_MANIFEST_SNAPSHOT,
    inventory: env.CHECKPOINT_RECOVERY_INVENTORY, key: env.CHECKPOINT_CUTOVER_KEY_SNAPSHOT
  };
  return signed ? captureAuthorityReceipt(path.resolve(directory), incident, contract, sources, {
    keyringPath: env.RECOVERY_BACKUP_AUTHORITY_KEYRING, keyId: env.RECOVERY_BACKUP_AUTHORITY_KEY_ID
  }) : captureReceipt(path.resolve(directory), incident, contract, sources);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 3) throw new Error("receipt_arguments");
    await captureFromEnvironment(process.argv[2]);
    process.stdout.write("abort_recovery_receipt_persisted\n");
  } catch (_) {
    // Neither API bodies nor private input parser errors may reach the log.
    process.stderr.write("abort_recovery_receipt_capture_failed\n");
    process.exitCode = 1;
  }
}
