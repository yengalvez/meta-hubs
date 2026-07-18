import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));
const {
  BOT_ORCHESTRATOR_ALLOWED_ENV_NAMES,
  BOT_ORCHESTRATOR_RUNTIME_ENV,
  BOT_ORCHESTRATOR_SECURITY_CONTEXT
} = require(`${root}/hubs-cloud/community-edition/generate_script/verify-manifest-contracts.js`);

export const deploymentConfiguration = Object.freeze({
  namespace: "hcce",
  runnerNamespace: "hcce-bot-runners",
  botImage: `ghcr.io/yengalvez/bot-orchestrator@sha256:${"b".repeat(64)}`,
  runnerImage: `ghcr.io/yengalvez/bot-runner@sha256:${"a".repeat(64)}`,
  hubDomain: "example.invalid",
  accessKey: "k".repeat(64),
  maxActiveRooms: "5",
  maxBotsPerRoom: "10",
  activationPhase: "active",
  recoveryPhase: "active",
  recoveryEpoch: "44444444-4444-4444-8444-444444444444"
});

const literalEnvironment = Object.freeze({
  OPENAI_MODEL: "gpt-5-nano",
  OPENAI_TOTAL_BUDGET_MS: "4000",
  ...BOT_ORCHESTRATOR_RUNTIME_ENV,
  BOT_RUNNER_IMAGE: deploymentConfiguration.runnerImage,
  BOT_RUNNER_RECOVERY_EPOCH: deploymentConfiguration.recoveryEpoch,
  RUNNER_POD_NAMESPACE: deploymentConfiguration.runnerNamespace,
  RUNNER_CONTROL_URL:
    `http://bot-orchestrator.${deploymentConfiguration.namespace}.svc.cluster.local:5001`,
  GHOST_NAVIGATION_RECOVERY_RESTART_MS: "30000",
  GHOST_SPAWN_RECOVERY_RESTART_MS: "5000",
  GHOST_NAVMESH_MAX_TRIANGLES: "50000",
  GHOST_NAVMESH_MAX_ROUTE_POINTS: "64",
  GHOST_NAVMESH_MAX_SNAP_DISTANCE_M: "3",
  GHOST_FEATURED_FETCH_TIMEOUT_MS: "4000",
  GHOST_FEATURED_MAX_BYTES: "524288",
  GHOST_FEATURED_MAX_REDIRECTS: "2",
  GHOST_FEATURED_MAX_ENTRIES: "256",
  GHOST_FEATURED_MAX_REFS: "128",
  GHOST_SCENE_FETCH_TIMEOUT_MS: "10000",
  GHOST_SCENE_MAX_BYTES: "67108864",
  GHOST_SCENE_MAX_JSON_BYTES: "4194304",
  GHOST_SCENE_MAX_NODES: "50000",
  GHOST_SCENE_MAX_EDGES: "200000",
  HUBS_BASE_URL: `https://${deploymentConfiguration.hubDomain}`,
  RET_SYNC_TIMEOUT_MS: "5000",
  RET_SNAPSHOT_TTL_MS: "120000",
  RUNNER_CONFIG_ACK_TIMEOUT_MS: "15000",
  RUNNER_STARTUP_GRACE_MS: "180000",
  RUNNER_STALE_RESTART_MS: "30000",
  RUNNER_TERMINAL_RECOVERY_GRACE_MS: "15000",
  RUNNER_WATCHDOG_INTERVAL_MS: "5000",
  RUNNER_RESTART_BASE_MS: "3000",
  RUNNER_RESTART_MAX_MS: "60000",
  RUNNER_STABLE_RESET_MS: "30000",
  RUNNER_TERMINATION_GRACE_MS: "10000",
  RUNNER_KILL_GRACE_MS: "5000",
  MAX_ACTIVE_ROOMS: deploymentConfiguration.maxActiveRooms,
  MAX_BOTS_PER_ROOM: deploymentConfiguration.maxBotsPerRoom
});

const secretKeys = Object.freeze({
  BOT_ORCHESTRATOR_ACCESS_KEY: "BOT_ORCHESTRATOR_ACCESS_KEY",
  OPENAI_API_KEY: "OPENAI_API_KEY"
});
const downwardFields = Object.freeze({
  POD_NAMESPACE: "metadata.namespace",
  ORCHESTRATOR_POD_NAME: "metadata.name",
  ORCHESTRATOR_POD_UID: "metadata.uid"
});

export function fixtureEnvironment() {
  return BOT_ORCHESTRATOR_ALLOWED_ENV_NAMES.map(name => {
    if (Object.hasOwn(secretKeys, name)) {
      return { name, valueFrom: { secretKeyRef: { name: "configs", key: secretKeys[name] } } };
    }
    if (Object.hasOwn(downwardFields, name)) {
      return {
        name,
        valueFrom: { fieldRef: { apiVersion: "v1", fieldPath: downwardFields[name] } }
      };
    }
    if (!Object.hasOwn(literalEnvironment, name)) throw new Error(`missing fixture env ${name}`);
    return { name, value: literalEnvironment[name] };
  });
}

function fixtureProbe(path, initialDelaySeconds, periodSeconds) {
  return {
    httpGet: { path, port: 5001, host: "", scheme: "HTTP", httpHeaders: [] },
    initialDelaySeconds,
    periodSeconds,
    timeoutSeconds: 1,
    successThreshold: 1,
    failureThreshold: 3
  };
}

export function fixtureDeployment() {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "bot-orchestrator",
      namespace: deploymentConfiguration.namespace,
      uid: "bot-orchestrator-deployment-uid",
      annotations: {
        "cluster-autoscaler.kubernetes.io/safe-to-evict": "true",
        "yenhubs.org/runner-activation-phase": deploymentConfiguration.activationPhase,
        "yenhubs.org/bot-runner-recovery-phase": deploymentConfiguration.recoveryPhase,
        "yenhubs.org/bot-runner-recovery-epoch": deploymentConfiguration.recoveryEpoch,
        "deployment.kubernetes.io/revision": "1"
      }
    },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { app: "bot-orchestrator" } },
      revisionHistoryLimit: 10,
      progressDeadlineSeconds: 600,
      paused: false,
      minReadySeconds: 0,
      template: {
        metadata: {
          creationTimestamp: null,
          labels: { app: "bot-orchestrator" },
          annotations: {
            "yenhubs.org/bot-orchestrator-access-key-checksum": crypto
              .createHash("sha256")
              .update(deploymentConfiguration.accessKey)
              .digest("hex"),
            "yenhubs.org/bot-runner-recovery-epoch": deploymentConfiguration.recoveryEpoch,
            "kubectl.kubernetes.io/restartedAt": "2026-07-18T06:00:00+02:00"
          }
        },
        spec: {
          serviceAccountName: "bot-orchestrator",
          serviceAccount: "bot-orchestrator",
          automountServiceAccountToken: true,
          imagePullSecrets: [{ name: "bot-images-pull" }],
          restartPolicy: "Always",
          terminationGracePeriodSeconds: 30,
          dnsPolicy: "ClusterFirst",
          securityContext: {},
          schedulerName: "default-scheduler",
          enableServiceLinks: true,
          hostNetwork: false,
          hostPID: false,
          hostIPC: false,
          shareProcessNamespace: false,
          hostUsers: true,
          preemptionPolicy: "PreemptLowerPriority",
          containers: [{
            name: "bot-orchestrator",
            image: deploymentConfiguration.botImage,
            imagePullPolicy: "IfNotPresent",
            terminationMessagePath: "/dev/termination-log",
            terminationMessagePolicy: "File",
            securityContext: {
              ...structuredClone(BOT_ORCHESTRATOR_SECURITY_CONTEXT),
              privileged: false,
              procMount: "Default"
            },
            resources: {
              requests: { cpu: "25m", memory: "128Mi" },
              limits: { memory: "512Mi" }
            },
            ports: [{
              containerPort: 5001,
              name: "http",
              protocol: "TCP",
              hostPort: 0,
              hostIP: ""
            }],
            env: fixtureEnvironment(),
            volumeMounts: [{
              name: "bot-orchestrator-tmp",
              mountPath: "/tmp",
              readOnly: false,
              subPath: "",
              subPathExpr: ""
            }],
            livenessProbe: fixtureProbe("/health", 10, 15),
            readinessProbe: fixtureProbe("/transport-ready", 5, 10)
          }],
          volumes: [{ name: "bot-orchestrator-tmp", emptyDir: { sizeLimit: "256Mi" } }]
        }
      }
    },
    status: { replicas: 1, readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1 }
  };
}

export function omitKubernetesDefaults(deployment) {
  const candidate = structuredClone(deployment);
  for (const name of ["revisionHistoryLimit", "progressDeadlineSeconds", "paused", "minReadySeconds"]) {
    delete candidate.spec[name];
  }
  delete candidate.spec.template.metadata.creationTimestamp;
  const podSpec = candidate.spec.template.spec;
  for (const name of [
    "restartPolicy", "terminationGracePeriodSeconds", "dnsPolicy", "securityContext",
    "schedulerName", "enableServiceLinks", "hostNetwork", "hostPID", "hostIPC",
    "shareProcessNamespace", "hostUsers", "preemptionPolicy", "serviceAccount"
  ]) delete podSpec[name];
  const container = podSpec.containers[0];
  delete container.terminationMessagePath;
  delete container.terminationMessagePolicy;
  delete container.securityContext.privileged;
  delete container.securityContext.procMount;
  for (const name of ["protocol", "hostPort", "hostIP"]) delete container.ports[0][name];
  for (const name of ["readOnly", "subPath", "subPathExpr"]) delete container.volumeMounts[0][name];
  for (const probe of [container.livenessProbe, container.readinessProbe]) {
    delete probe.timeoutSeconds;
    delete probe.successThreshold;
    delete probe.failureThreshold;
    delete probe.httpGet.host;
    delete probe.httpGet.scheme;
    delete probe.httpGet.httpHeaders;
  }
  return candidate;
}

export function fixtureParentPod() {
  const deployment = fixtureDeployment();
  const spec = structuredClone(deployment.spec.template.spec);
  const serviceAccountVolumeName = "kube-api-access-abc12";
  spec.serviceAccount = "bot-orchestrator";
  spec.nodeName = "worker-fixture-1";
  spec.priority = 0;
  spec.tolerations = [
    {
      effect: "NoExecute",
      key: "node.kubernetes.io/not-ready",
      operator: "Exists",
      tolerationSeconds: 300
    },
    {
      effect: "NoExecute",
      key: "node.kubernetes.io/unreachable",
      operator: "Exists",
      tolerationSeconds: 300
    }
  ];
  spec.volumes.push({
    name: serviceAccountVolumeName,
    projected: {
      defaultMode: 420,
      sources: [
        { serviceAccountToken: { expirationSeconds: 3607, path: "token" } },
        {
          configMap: {
            name: "kube-root-ca.crt",
            items: [{ key: "ca.crt", path: "ca.crt" }]
          }
        },
        {
          downwardAPI: {
            items: [{
              path: "namespace",
              fieldRef: { apiVersion: "v1", fieldPath: "metadata.namespace" }
            }]
          }
        }
      ]
    }
  });
  spec.containers[0].volumeMounts.push({
    name: serviceAccountVolumeName,
    readOnly: true,
    mountPath: "/var/run/secrets/kubernetes.io/serviceaccount"
  });
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "bot-orchestrator-fixture",
      namespace: deploymentConfiguration.namespace,
      uid: "parent-uid-fixture",
      labels: { app: "bot-orchestrator", "pod-template-hash": "abc123def0" },
      annotations: structuredClone(deployment.spec.template.metadata.annotations),
      ownerReferences: [{
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        name: "bot-orchestrator-abc123def0",
        uid: "parent-replica-set-uid",
        controller: true,
        blockOwnerDeletion: true
      }]
    },
    spec,
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{
        name: "bot-orchestrator",
        ready: true,
        started: true,
        restartCount: 0,
        imageID: deploymentConfiguration.botImage,
        state: { running: { startedAt: "2033-05-18T03:30:00Z" } }
      }]
    }
  };
}
