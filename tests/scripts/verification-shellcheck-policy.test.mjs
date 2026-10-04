import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const local = readFileSync(new URL("../../scripts/verify-project.sh", import.meta.url), "utf8");
const ci = readFileSync(new URL("../../.github/workflows/project-security.yml", import.meta.url), "utf8");
const inputs = [
  "tests/recovery/test-recovery-safety.sh",
  "deployment/lib/recovery-safety.sh",
  "deployment/ordinary.sh"
];

function loopBody(source, variable) {
  const pattern = new RegExp(`while IFS= read -r -d '' ${variable}; do\\n([\\s\\S]*?)\\n\\s*done <`);
  const match = source.match(pattern);
  assert.ok(match, `${variable}: real shell lint loop required`);
  return match[1];
}

function run(body, variable, absolute, failPath = "") {
  const prefix = absolute ? "/workspace/" : "";
  const script = String.raw`
set -euo pipefail
ROOT_DIR=/workspace
shellcheck() {
  printf 'TOOL'
  printf '\t%s' "$@"
  printf '\n'
  [[ "$*" != *'${failPath || "__no_fault__"}'* ]] || return 42
}
while IFS= read -r -d '' ${variable}; do
${body}
done < <(printf '%s\0' ${inputs.map(input => `'${prefix}${input}'`).join(" ")})
`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const calls = result.stdout.split("\n").filter(line => line.startsWith("TOOL\t"))
    .map(line => line.split("\t").slice(1).map(arg => arg.replace(/^\/workspace\//u, "")));
  return { status: result.status, calls, stderr: result.stderr };
}

const localBody = loopBody(local, "shell_script");
const ciBody = loopBody(ci, "script");

test("local full uses exactly the existing CI lint policy with exclusions confined to two inputs", () => {
  const expected = [
    ["-e", "SC1091,SC2030,SC2034,SC2317,SC2329", inputs[0]],
    ["-x", "-e", "SC2317", inputs[1]],
    ["-x", inputs[2]]
  ];
  for (const [body, variable, absolute] of [[localBody, "shell_script", true], [ciBody, "script", false]]) {
    const result = run(body, variable, absolute);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, expected);
  }
  assert.match(local, /"\$ROOT_DIR\/deployment" "\$ROOT_DIR\/scripts"/u,
    "the recovery library remains a separately linted operational input");
});

test("a real nonzero ShellCheck result still stops both loops without treating it as compatibility", () => {
  for (const [body, variable, absolute] of [[localBody, "shell_script", true], [ciBody, "script", false]]) {
    for (const [index, failed] of inputs.entries()) {
      const result = run(body, variable, absolute, failed);
      assert.equal(result.status, 42, result.stderr);
      assert.equal(result.calls.length, index + 1, failed);
    }
  }
});
