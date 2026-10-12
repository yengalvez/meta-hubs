/** One Kubernetes Job: maintain the operation mutex, resume once at the deadline. */
export async function deferredSnapshotResume() {
  const fs = require("node:fs"), https = require("node:https");
  const state = JSON.parse(process.env.RESUME_STATE);
  const base = `/api/v1/namespaces/${state.namespace}/configmaps/${state.name}`;
  const leasePath = `/apis/coordination.k8s.io/v1/namespaces/${state.namespace}/leases/yenhubs-operation-serialization`;
  const token = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim();
  const ca = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function request(method, path, value, type = "application/merge-patch+json") {
    return new Promise((accept, reject) => {
      const body = value === undefined ? null : JSON.stringify(value);
      const req = https.request({ hostname: process.env.KUBERNETES_SERVICE_HOST,
        port: process.env.KUBERNETES_SERVICE_PORT_HTTPS || 443, path, method, ca,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": type } : {}) } }, response => {
        const chunks = []; let count = 0;
        response.on("data", bytes => { count += bytes.length; if (count > 1024 * 1024) req.destroy(); else chunks.push(bytes); });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error("recovery_api_failed"));
          try { accept(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error("recovery_json_invalid")); }
        });
      });
      req.setTimeout(10000, () => req.destroy(new Error("recovery_api_timeout")));
      req.on("error", reject); req.end(body);
    });
  }
  const requireLease = value => {
    if (value.metadata.uid !== state.leaseUid || value.spec.holderIdentity !== state.holder) throw new Error("recovery_lease_changed");
  };
  while (Date.now() < state.resumeAt) {
    try {
    const config = await request("GET", base);
    if (config.metadata.uid !== state.stateUid) throw new Error("recovery_state_changed");
    if (config.data.phase === "resumed") return;
    const lease = await request("GET", leasePath); requireLease(lease);
    await request("PATCH", leasePath, { metadata: { resourceVersion: lease.metadata.resourceVersion },
      spec: { renewTime: new Date().toISOString().replace(/(\.\d{3})Z$/, "$1000Z") } });
    } catch { /* a failed maintenance read must not remove the deferred resume */ }
    await delay(Math.min(20000, Math.max(0, state.resumeAt - Date.now())));
  }
  const config = await request("GET", base);
  if (config.metadata.uid !== state.stateUid) throw new Error("recovery_state_changed");
  if (config.data.phase === "resumed") return;
  const initialLease = await request("GET", leasePath); requireLease(initialLease);
  // Re-establish ownership by CAS even after expiry; another holder rejects
  // recovery before any scale change. No second snapshot POST is involved.
  await request("PATCH", leasePath, { metadata: { resourceVersion: initialLease.metadata.resourceVersion },
    spec: { renewTime: new Date().toISOString().replace(/(\.\d{3})Z$/, "$1000Z") } });
  await request("PATCH", base, { metadata: { resourceVersion: config.metadata.resourceVersion }, data: { phase: "recovering" } });
  const failures = [];
  for (const service of [...state.services].sort((a, b) => Number(b.name === "pgsql") - Number(a.name === "pgsql"))) {
    try {
    const path = `/apis/apps/v1/namespaces/${state.namespace}/deployments/${service.name}`;
    const current = await request("GET", path);
    if (current.metadata.uid !== service.uid || ![0, service.replicas].includes(current.spec.replicas)) throw new Error("recovery_deployment_changed");
    await request("PATCH", path, [
      { op: "test", path: "/metadata/uid", value: service.uid },
      { op: "test", path: "/metadata/resourceVersion", value: current.metadata.resourceVersion },
      { op: "replace", path: "/spec/replicas", value: service.replicas }
    ], "application/json-patch+json");
    } catch (error) { failures.push(error); }
  }
  if (failures.length) {
    await request("PATCH", base, { data: { phase: "recovery-incomplete" } }).catch(() => {});
    throw new AggregateError(failures, "recovery_incomplete");
  }
  await request("PATCH", base, { data: { phase: "recovery-requested" } });
  // Keep the mutex until the restored Deployments report Ready, not just spec=1.
  const until = Date.now() + 180000;
  for (;;) {
    const deployments = await Promise.all(state.services.map(service => request("GET",
      `/apis/apps/v1/namespaces/${state.namespace}/deployments/${service.name}`)));
    if (deployments.every((value, i) => value.metadata.uid === state.services[i].uid &&
      value.spec.replicas === state.services[i].replicas && value.status?.observedGeneration >= value.metadata.generation &&
      Number(value.status?.readyReplicas || 0) === state.services[i].replicas)) break;
    if (Date.now() >= until) throw new Error("recovery_readiness_timeout");
    const lease = await request("GET", leasePath); requireLease(lease);
    await request("PATCH", leasePath, { metadata: { resourceVersion: lease.metadata.resourceVersion },
      spec: { renewTime: new Date().toISOString().replace(/(\.\d{3})Z$/, "$1000Z") } });
    await delay(5000);
  }
  await request("PATCH", base, { data: { phase: "resumed" } });
  const lease = await request("GET", leasePath); requireLease(lease);
  await request("PATCH", leasePath, { metadata: { resourceVersion: lease.metadata.resourceVersion },
    spec: { holderIdentity: null, acquireTime: null, renewTime: null } });
}

export function minimalRecoveryObjects(state, image) {
  if (!/^ghcr\.io\/yengalvez\/bot-orchestrator@sha256:[a-f0-9]{64}$/.test(image ?? "")) throw new Error("monthly_minimal_recovery_image_invalid");
  const { namespace, name } = state;
  const metadata = objectName => ({ name: objectName, namespace, labels: { "yenhubs.org/monthly-resume": state.operationId } });
  return [
    { apiVersion: "v1", kind: "ServiceAccount", metadata: metadata(name) },
    { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: metadata(name), rules: [
      { apiGroups: ["apps"], resources: ["deployments"], resourceNames: state.services.map(service => service.name), verbs: ["get", "patch"] },
      { apiGroups: [""], resources: ["configmaps"], resourceNames: [name], verbs: ["get", "patch"] },
      { apiGroups: ["coordination.k8s.io"], resources: ["leases"], resourceNames: ["yenhubs-operation-serialization"], verbs: ["get", "patch"] }
    ] },
    { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: metadata(name),
      subjects: [{ kind: "ServiceAccount", name, namespace }], roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name } },
    { apiVersion: "batch/v1", kind: "Job", metadata: metadata(name), spec: {
      backoffLimit: 0, activeDeadlineSeconds: 600, ttlSecondsAfterFinished: 86400,
      template: { metadata: { labels: { "yenhubs.org/monthly-resume": state.operationId } }, spec: {
        serviceAccountName: name, automountServiceAccountToken: true, restartPolicy: "Never",
        containers: [{ name: "resume", image, imagePullPolicy: "IfNotPresent", command: ["node", "-e",
          `(${deferredSnapshotResume.toString()})().catch(() => { console.error('MONTHLY_RECOVERY_REQUIRED'); process.exitCode=1; })`],
          env: [{ name: "RESUME_STATE", value: JSON.stringify(state) }],
          resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { cpu: "100m", memory: "96Mi" } },
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } } }]
      } }
    } }
  ];
}
