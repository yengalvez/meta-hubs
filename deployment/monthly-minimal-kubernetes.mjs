/** Small native adapter. No historical backup scripts or running guardians. */
import { lstat, realpath, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { inspectMonthlySource, inspectPostgresLayout } from "./monthly-snapshot-source.mjs";
import { readPrivateBytes } from "./monthly-snapshot-worker.mjs";
import { runExportNative } from "./monthly-snapshot-export-provider.mjs";
import { minimalRecoveryObjects } from "./monthly-minimal-recovery.mjs";

const require = createRequire(import.meta.url);
const { leaseState, leaseDocument, OPERATION_LEASE_NAME } = require("../hubs-cloud/community-edition/apply/operation-lease.js");
const need = (ok, message) => { if (!ok) throw new Error(message); };
const writers = ["bot-orchestrator", "reticulum", "pgbouncer", "pgbouncer-t", "coturn"];
const services = [...writers, "pgsql"];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const image = /^\S+@sha256:[a-f0-9]{64}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createMinimalKubernetes({ env, root }, { run = runExportNative, now = () => Date.now(), delay = sleep } = {}) {
  const context = env.EXPECTED_KUBE_CONTEXT, namespace = env.NAMESPACE;
  need(context === "do-ams3-hubs-ce" && namespace === "hcce" && env.MONTHLY_REGION === "ams3" &&
    [env.EXPECTED_NAMESPACE_UID, env.EXPECTED_RET_PVC_UID, env.EXPECTED_DB_PVC_UID].every(v => uuid.test(v ?? "")),
    "monthly_minimal_target_invalid");
  const holder = `root-recovery:${randomUUID()}`;
  let end = Infinity, recovering = false, lease, state, sourceValue, owned = [];
  const checkDeadline = () => { need(recovering || now() < end, "monthly_minimal_pause_timeout"); };
  async function command(args, input = null) {
    checkDeadline();
    const result = await run("kubectl", ["--context", context, "--request-timeout=20s", ...args],
      { input, timeout: Math.min(30000, recovering ? 30000 : Math.max(1, end - now())) });
    need(result.nativeExitCode === 0, "monthly_minimal_kubernetes_command_failed");
    checkDeadline();
    return result.stdout;
  }
  async function json(args, input = null) {
    const stdout = await command([...args, "-o", "json"], input);
    try { return JSON.parse(stdout); } catch { throw new Error("monthly_minimal_kubernetes_json_invalid"); }
  }
  const get = (kind, name, ns = namespace) => json(["-n", ns, "get", kind, ...(name ? [name] : [])]);
  async function patch(kind, name, value, type = "merge") {
    return json(["-n", namespace, "patch", kind, name, `--type=${type}`, "--patch-file=/dev/stdin"], JSON.stringify(value));
  }
  async function waitUntil(read, acceptable, timeout = 90000) {
    const until = now() + timeout;
    for (;;) {
      const value = await read(); if (acceptable(value)) return value;
      need(now() < until, "monthly_minimal_wait_timeout"); checkDeadline(); await delay(1000);
    }
  }
  async function statePhase() {
    const value = await get("configmap", state.name);
    need(value.metadata.uid === state.stateUid, "monthly_minimal_recovery_state_changed");
    return value.data.phase;
  }
  async function requireLease() {
    const value = await get("lease", OPERATION_LEASE_NAME);
    need(value.metadata.uid === lease.metadata.uid && leaseState(value, namespace, holder, now()) === "owned",
      "monthly_minimal_operation_lock_lost");
    return value;
  }
  async function replicas(service, count) {
    await requireLease();
    const value = await get("deployment", service.name);
    need(value.metadata.uid === service.uid && [0, service.replicas].includes(value.spec.replicas),
      "monthly_minimal_deployment_changed");
    if (value.spec.replicas === count) return;
    await patch("deployment", service.name, [
      { op: "test", path: "/metadata/uid", value: service.uid },
      { op: "test", path: "/metadata/resourceVersion", value: value.metadata.resourceVersion },
      { op: "replace", path: "/spec/replicas", value: count }
    ], "json");
  }
  const writerPod = pod => pod.spec?.volumes?.some(v => ["pgsql-pvc", "ret-pvc"].includes(v.persistentVolumeClaim?.claimName)) ||
    services.some(name => pod.metadata?.labels?.app === name);
  const running = pod => !["Succeeded", "Failed"].includes(pod.status?.phase);
  async function noPods(includeDatabase) {
    const list = await get("pods");
    return !list.items.some(pod => writerPod(pod) && running(pod) &&
      (includeDatabase || pod.metadata?.labels?.app !== "pgsql"));
  }
  async function create(object) {
    const value = await json(["create", "-f", "-"], JSON.stringify(object));
    need(uuid.test(value.metadata?.uid ?? ""), "monthly_minimal_created_identity_invalid");
    owned.push({ kind: object.kind, name: object.metadata.name, uid: value.metadata.uid });
    return value;
  }
  async function remove(kind, name, uid, ns = namespace) {
    const paths = { Pod: ["/api/v1", "pods"], ConfigMap: ["/api/v1", "configmaps"],
      ServiceAccount: ["/api/v1", "serviceaccounts"], Job: ["/apis/batch/v1", "jobs"],
      Role: ["/apis/rbac.authorization.k8s.io/v1", "roles"], RoleBinding: ["/apis/rbac.authorization.k8s.io/v1", "rolebindings"] };
    const [prefix, plural] = paths[kind];
    await command(["delete", "--raw", `${prefix}/namespaces/${ns}/${plural}/${name}`, "-f", "-"],
      JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Foreground", preconditions: { uid } }));
  }
  return {
    checkDeadline, readPrivateBytes,
    async requirePrivateDirectory(path) {
      const stat = await lstat(path);
      need(await realpath(path) === path && stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700,
        "monthly_minimal_output_parent_not_private");
    },
    async source() {
      // Inventory is read once, under the mutex; this is only configuration.
      return { schema: "yenhubs-monthly-selection-v1", context, instanceId: env.MONTHLY_INSTANCE_ID,
        namespace: { name: namespace, uid: env.EXPECTED_NAMESPACE_UID },
        volumes: { database: { pvcUid: env.EXPECTED_DB_PVC_UID }, media: { pvcUid: env.EXPECTED_RET_PVC_UID } } };
    },
    async inventory(source) {
      need(source.context === context && source.namespace.uid === env.EXPECTED_NAMESPACE_UID &&
        source.volumes.database.pvcUid === env.EXPECTED_DB_PVC_UID && source.volumes.media.pvcUid === env.EXPECTED_RET_PVC_UID,
        "monthly_minimal_source_changed");
      const readJson = async (program, args) => JSON.parse((await run(program, args)).stdout);
      const current = await inspectMonthlySource({ context, namespace, instanceId: source.instanceId, region: env.MONTHLY_REGION }, readJson);
      current.postgres = await inspectPostgresLayout(current, readJson, run);
      need(current.namespace.uid === source.namespace.uid && ["database", "media"].every(role =>
        ["pvcUid", "pvUid", "volumeId", "sizeGiB"].every(key => source.volumes[role][key] === undefined ||
          current.volumes[role][key] === source.volumes[role][key])),
        "monthly_minimal_source_changed");
      need(Object.values(current.volumes).reduce((sum, volume) => sum + volume.sizeGiB, 0) <= 20,
        "monthly_minimal_source_budget_exceeded");
      source = current; sourceValue = current;
      const ns = await get("namespace", namespace);
      need(ns.metadata.uid === source.namespace.uid, "monthly_minimal_namespace_changed");
      const [deployments, hpa, cron, jobs] = await Promise.all([
        get("deployments"), get("hpa"), get("cronjobs"), get("jobs")
      ]);
      need(!hpa.items.some(item => services.includes(item.spec?.scaleTargetRef?.name)) &&
        cron.items.every(item => item.spec?.suspend === true) && jobs.items.every(item => !(item.status?.active > 0)),
        "monthly_minimal_background_writer_unsupported");
      const selected = services.map(name => {
        const matches = deployments.items.filter(item => item.metadata?.name === name);
        need(matches.length === 1, "monthly_minimal_service_missing");
        const item = matches[0];
        need(uuid.test(item.metadata.uid) && Number.isSafeInteger(item.spec.replicas) && item.spec.replicas >= 0 &&
          item.spec.replicas <= 1 && item.spec.template.spec.containers.every(c => image.test(c.image)),
          "monthly_minimal_service_identity_invalid");
        return { name, uid: item.metadata.uid, replicas: item.spec.replicas };
      });
      const bot = deployments.items.find(item => item.metadata.name === "bot-orchestrator");
      return { source, services: selected, recoveryImage: bot.spec.template.spec.containers[0].image,
        imagePullSecrets: bot.spec.template.spec.imagePullSecrets || [],
        images: deployments.items.map(item => ({ name: item.metadata.name,
          containers: item.spec.template.spec.containers.map(c => ({ name: c.name, image: c.image })) })) };
    },
    async acquire() {
      const observed = await command(["-n", namespace, "get", "lease", OPERATION_LEASE_NAME, "--ignore-not-found", "-o", "json"]);
      let values = null;
      if (observed !== "") {
        try { values = JSON.parse(observed); } catch { throw new Error("monthly_minimal_kubernetes_json_invalid"); }
      }
      need(["absent", "available"].includes(leaseState(values, namespace, holder, now())), "monthly_minimal_operation_lock_busy");
      const document = leaseDocument({ namespace, holder, now: now(), current: values });
      lease = await json([values ? "replace" : "create", "-f", "-"], JSON.stringify(document));
      need(leaseState(lease, namespace, holder, now()) === "owned", "monthly_minimal_operation_lock_unproven");
    },
    async armRecovery(saved, operationId) {
      await requireLease();
      end = now() + 300000;
      const name = `monthly-resume-${operationId}`;
      const config = await create({ apiVersion: "v1", kind: "ConfigMap", metadata: { name, namespace,
        labels: { "yenhubs.org/monthly-resume": operationId } }, data: { phase: "armed", services: JSON.stringify(saved.services) } });
      state = { name, namespace, namespaceUid: env.EXPECTED_NAMESPACE_UID, operationId, holder,
        leaseUid: lease.metadata.uid, stateUid: config.metadata.uid, services: saved.services, resumeAt: end };
      const objects = minimalRecoveryObjects(state, saved.recoveryImage);
      objects.at(-1).spec.template.spec.imagePullSecrets = saved.imagePullSecrets;
      for (const object of objects) await create(object);
      await waitUntil(() => json(["-n", namespace, "get", "pods", "-l", `job-name=${name}`]),
        value => value.items.some(pod => pod.status?.phase === "Running" && pod.status.containerStatuses?.length === 1 &&
          pod.status.containerStatuses[0].ready === true && pod.status.containerStatuses[0].state?.running), 60000);
      await requireLease();
    },
    async pauseWriters(saved) {
      for (const service of saved.services.filter(item => writers.includes(item.name))) await replicas(service, 0);
      await waitUntil(() => noPods(false), Boolean);
      // Stop the exact managed runner pods after their parent has terminated.
      const runners = await get("pods", null, "hcce-bot-runners");
      for (const pod of runners.items.filter(running)) {
        need(pod.metadata.labels?.["yenhubs.org/managed-by"] === "bot-orchestrator", "monthly_minimal_runner_identity_invalid");
        if (pod.metadata.labels.app !== "bot-runner") continue; // inert scheduling guards carry no writable data
        await remove("Pod", pod.metadata.name, pod.metadata.uid, "hcce-bot-runners");
      }
      await waitUntil(() => get("pods", null, "hcce-bot-runners"), value =>
        !value.items.some(pod => running(pod) && pod.metadata.labels?.app === "bot-runner"));
    },
    async databaseContract(source) {
      const query = await readFile(join(root, "deployment/monthly-database-contract.sql"), "utf8");
      const database = source.volumes.database;
      const value = await command(["-n", namespace, "exec", "-i", database.consumer.name, "-c", database.container, "--",
        "sh", "-ec", 'exec psql -U "$POSTGRES_USER" -d retdb -v ON_ERROR_STOP=1 -At'], query);
      let contract;
      try { contract = JSON.parse(value); } catch { throw new Error("monthly_minimal_database_contract_invalid"); }
      need(contract.schema_version === 2 && contract.sql_dump_sha256 === null, "monthly_minimal_database_contract_invalid");
      return contract;
    },
    async stopDatabase(saved) {
      const database = sourceValue.volumes.database;
      await command(["-n", namespace, "exec", database.consumer.name, "-c", database.container, "--", "sync"]);
      await replicas(saved.services.find(item => item.name === "pgsql"), 0);
      await waitUntil(() => noPods(true), Boolean);
    },
    async confirmPaused(saved) {
      const list = await get("deployments");
      need(saved.services.every(service => list.items.some(item => item.metadata.uid === service.uid && item.spec.replicas === 0)) &&
        await noPods(true), "monthly_minimal_pause_unproven");
    },
    async assertPaused() {
      need(await statePhase() === "armed", "monthly_minimal_deferred_resume_started"); await requireLease();
    },
    async resume(saved) {
      recovering = true;
      const observed = await get("lease", OPERATION_LEASE_NAME);
      need(observed.metadata.uid === lease.metadata.uid, "monthly_minimal_operation_lock_lost");
      if (leaseState(observed, namespace, holder, now()) === "available" && state && await statePhase() === "resumed") return;
      need(["owned", "expired-owned"].includes(leaseState(observed, namespace, holder, now())), "monthly_minimal_operation_lock_lost");
      // The Job already renews a live mutex. Avoid competing CAS writes; after
      // expiry, one renewal or a fresh owned read resolves a concurrent renewal.
      if (leaseState(observed, namespace, holder, now()) === "expired-owned") {
        try { await json(["replace", "-f", "-"], JSON.stringify(leaseDocument({ namespace, holder, now: now(), current: observed }))); }
        catch { await requireLease(); }
      }
      // The initial arm may have failed part-way: restore known services anyway.
      const failures = [];
      for (const service of [...saved.services].sort((a, b) => Number(b.name === "pgsql") - Number(a.name === "pgsql"))) {
        try { await replicas(service, service.replicas); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "monthly_minimal_resume_failed");
    },
    async verifyResumed(saved) {
      await waitUntil(() => get("deployments"), list => saved.services.every(service => list.items.some(item =>
        item.metadata.uid === service.uid && item.spec.replicas === service.replicas &&
        item.status?.observedGeneration >= item.metadata.generation && Number(item.status?.readyReplicas || 0) === service.replicas)), 180000);
      if (state) await patch("configmap", state.name, { data: { phase: "resumed" } });
    },
    async disarmRecovery() {
      for (const object of [...owned].reverse()) {
        const value = await get(object.kind, object.name);
        need(value.metadata.uid === object.uid, "monthly_minimal_recovery_object_changed");
        await remove(object.kind, object.name, object.uid);
        if (object.kind === "Job") await waitUntil(() => json(["-n", namespace, "get", "pods", "-l", `job-name=${object.name}`]),
          value => value.items.length === 0, 30000);
      }
      owned = [];
    },
    async release() {
      const value = await get("lease", OPERATION_LEASE_NAME);
      need(value.metadata.uid === lease.metadata.uid, "monthly_minimal_operation_lock_lost");
      if (leaseState(value, namespace, holder, now()) === "available") return;
      need(leaseState(value, namespace, holder, now()) === "owned", "monthly_minimal_operation_lock_lost");
      await json(["replace", "-f", "-"], JSON.stringify(leaseDocument({ namespace, holder, now: now(), current: value, release: true })));
    }
  };
}
