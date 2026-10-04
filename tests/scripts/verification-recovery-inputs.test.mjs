import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const verifier = join(root, "scripts/verify-project.sh");
const shells = [...new Set([process.env.BASH || "bash", "/bin/bash"])];
const sections = ["recovery", "h5", "static", "security"];
const consumedTest = "tests/scripts/freeze-checkpoint-admission-fence.test.mjs";

test("the recovery harness's script-test boundary is explicit and its module is covered", () => {
  const source = readFileSync(join(root, "tests/recovery/test-recovery-safety.sh"), "utf8");
  const references = [...new Set([...source.matchAll(/\$ROOT_DIR\/(tests\/scripts\/[A-Za-z0-9_./-]+)/g)]
    .map(match => match[1]))];
  assert.deepEqual(references, [consumedTest], "review the declared footprint when a script-test dependency changes");
  const testSource = readFileSync(join(root, consumedTest), "utf8");
  const imports = [...testSource.matchAll(/\bimport\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g)]
    .map(match => match[1]).sort();
  assert.deepEqual(imports, [
    "../../deployment/freeze-checkpoint-admission-fence.mjs", "node:assert/strict", "node:test"
  ]);
  assert.doesNotMatch(testSource, /\b(?:import\s*\(|require\s*\(|eval\s*\(|new\s+Function\b)/,
    "dynamic loads require a reviewed dependency footprint");
});

function git(repository, ...args) {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function put(directory, relative, payload = "fixture-v1\n") {
  const path = join(directory, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, payload);
  return path;
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "yenhubs-recovery-inputs-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true }));
  for (const relative of ["", "hubs", "hubs-cloud"]) {
    const repository = join(directory, relative);
    mkdirSync(repository, { recursive: true });
    git(repository, "init", "-q");
  }
  for (const relative of [
    consumedTest,
    "tests/scripts/unrelated-ui.test.mjs",
    "tests/recovery/test-recovery-safety.sh",
    "deployment/lib/recovery-safety.sh",
    "deployment/freeze-checkpoint-admission-fence.mjs",
    "scripts/test-aud065.sh",
    "scripts/verify-gitlinks.sh"
  ]) put(directory, relative);
  put(join(directory, "hubs"), "package.json");
  for (const relative of [
    "community-edition/apply/operation-lease.js",
    "community-edition/generate_script/index.js",
    "community-edition/services/bot-orchestrator/kubernetes-runner-manager.js",
    ".github/workflows/runtime-images-build-push.yml"
  ]) put(join(directory, "hubs-cloud"), relative);
  git(directory, "add", "--", "tests", "deployment", "scripts");
  git(join(directory, "hubs"), "add", ".");
  git(join(directory, "hubs-cloud"), "add", ".");
  return directory;
}

function fingerprints(directory, shell) {
  // Source the real mapper and hashing functions. No receipts, section bodies,
  // package installation, global cache or real repository inventory is used.
  const result = spawnSync(shell, ["-c", String.raw`
    source "$1"
    ROOT_DIR="$2"
    for section in recovery h5 static security; do
      digest="$(verification_section_input_sha256 "$section")" || exit 23
      printf '%s\t%s\n' "$section" "$digest"
    done
  `, "_", verifier, directory], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const values = Object.fromEntries(result.stdout.trim().split("\n").map(line => line.split("\t")));
  assert.deepEqual(Object.keys(values), sections);
  for (const value of Object.values(values)) assert.match(value, /^[a-f0-9]{64}$/);
  return values;
}

for (const shell of shells) {
  test(`${shell}: an unrelated script test does not invalidate recovery/H5 but remains in static/security`, t => {
    const directory = fixture(t);
    let before = fingerprints(directory, shell);
    for (const [relative, payload] of [
      ["tests/scripts/new-ui.test.mjs", "new unrelated test\n"],
      ["tests/scripts/unrelated-ui.test.mjs", "changed unrelated test\n"]
    ]) {
      put(directory, relative, payload);
      const after = fingerprints(directory, shell);
      for (const section of ["recovery", "h5"]) {
        assert.equal(after[section], before[section], `${section}: ${relative}`);
      }
      for (const section of ["static", "security"]) {
        assert.notEqual(after[section], before[section], `${section}: ${relative}`);
      }
      before = after;
    }
  });

  test(`${shell}: every consumed recovery dependency still invalidates both long sections`, t => {
    const directory = fixture(t);
    let before = fingerprints(directory, shell);
    for (const [repository, relative] of [
      [directory, consumedTest],
      [directory, "tests/recovery/test-recovery-safety.sh"],
      [directory, "deployment/lib/recovery-safety.sh"],
      [directory, "deployment/freeze-checkpoint-admission-fence.mjs"],
      [directory, "scripts/test-aud065.sh"],
      [directory, "scripts/verify-gitlinks.sh"],
      [join(directory, "hubs-cloud"), "community-edition/apply/operation-lease.js"],
      [join(directory, "hubs-cloud"), "community-edition/generate_script/index.js"],
      [join(directory, "hubs-cloud"), "community-edition/services/bot-orchestrator/kubernetes-runner-manager.js"],
      [join(directory, "hubs-cloud"), ".github/workflows/runtime-images-build-push.yml"]
    ]) {
      put(repository, relative, "changed consumed dependency\n");
      const after = fingerprints(directory, shell);
      for (const section of ["recovery", "h5", "static", "security"]) {
        assert.notEqual(after[section], before[section], `${section}: ${relative}`);
      }
      before = after;
    }
  });

  test(`${shell}: deletion and executable changes of the consumed test cannot reuse recovery/H5`, t => {
    const directory = fixture(t);
    const path = join(directory, consumedTest);
    let before = fingerprints(directory, shell);
    chmodSync(path, 0o700);
    let after = fingerprints(directory, shell);
    for (const section of ["recovery", "h5"]) assert.notEqual(after[section], before[section]);
    before = after;
    rmSync(path);
    after = fingerprints(directory, shell);
    for (const section of ["recovery", "h5"]) assert.notEqual(after[section], before[section]);
  });
}
