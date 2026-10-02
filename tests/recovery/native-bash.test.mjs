import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { nativeBashArguments, nativeShellEnvironment, resolveNativeBash } from "./native-bash.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "yenhubs-native-shell-test-"));
  fs.chmodSync(directory, 0o700); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  function shell(name, version, exitCode = 0) {
    const bin = path.join(directory, name); fs.mkdirSync(bin, { mode: 0o700 });
    const executable = path.join(bin, "bash"), trace = path.join(bin, "probe.json");
    fs.writeFileSync(executable, `#!${process.execPath}\n` +
      `require("node:fs").writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }));\n` +
      `process.stdout.write(${JSON.stringify(version)}); process.exitCode = ${exitCode};\n`, { mode: 0o700 });
    return { bin, executable, trace };
  }
  return { directory, shell };
}

test("native Bash lookup binds the canonical caller-PATH executable with a clean probe environment", t => {
  const f = fixture(t), shell = f.shell("custom", "4.1\n"), alias = path.join(f.directory, "alias");
  fs.mkdirSync(alias, { mode: 0o700 }); fs.symlinkSync(shell.executable, path.join(alias, "bash"));
  assert.equal(resolveNativeBash(`${alias}:/usr/bin:/bin`), shell.executable);
  const probe = JSON.parse(fs.readFileSync(shell.trace, "utf8"));
  // Node adds this runtime-owned key on macOS even with an explicit env.
  delete probe.env.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(probe.env, nativeShellEnvironment());
  assert.deepEqual(probe.args.slice(0, 3), ["--noprofile", "--norc", "-c"]);
});

test("an explicit native binding survives the sanitized PATH instead of selecting another Bash", t => {
  const f = fixture(t), shell = f.shell("custom", "5.2\n");
  assert.equal(resolveNativeBash("/usr/bin:/bin", shell.executable), shell.executable);
  assert.throws(() => resolveNativeBash(shell.bin, "bash"), /native_bash_path_not_absolute/);
  assert.throws(() => resolveNativeBash(shell.bin, path.join(f.directory, "missing")), /native_bash_missing/);
});

test("unsupported first-PATH Bash cannot fall through to a later supported interpreter", t => {
  const f = fixture(t), unsupported = f.shell("unsupported", "3.2\n"), supported = f.shell("supported", "5.2\n");
  assert.throws(() => resolveNativeBash(`${unsupported.bin}${path.delimiter}${supported.bin}`), /native_bash_requires_4_1/);
  assert.equal(fs.existsSync(unsupported.trace), true);
  assert.equal(fs.existsSync(supported.trace), false);
  const oldFour = f.shell("old-four", "4.0\n");
  assert.throws(() => resolveNativeBash(oldFour.bin), /native_bash_requires_4_1/);
});

test("missing, malformed and failed interpreter probes fail closed", t => {
  const f = fixture(t);
  assert.throws(() => resolveNativeBash(f.directory), /native_bash_missing/);
  for (const [name, output, status] of [["malformed", "not bash\n", 0], ["failed", "5.2\n", 9]]) {
    const shell = f.shell(name, output, status);
    assert.throws(() => resolveNativeBash(shell.bin), /native_bash_validation_failed/);
  }
});

test("a failed or malformed library source cannot continue to the requested command", t => {
  const f = fixture(t), library = path.join(f.directory, "source.sh"), bashExecutable = resolveNativeBash();
  for (const [source, status] of [["return 17\n", 17], ["if then\n", 2]]) {
    fs.writeFileSync(library, source, { mode: 0o600 });
    const result = spawnSync(bashExecutable, nativeBashArguments(library, "printf continuation"), {
      env: nativeShellEnvironment(), encoding: "utf8", timeout: 5000
    });
    assert.equal(result.status, status);
    assert.equal(result.stdout, "");
  }
});

test("an internal sourced-library failure cannot be hidden by a successful return", t => {
  const f = fixture(t), library = path.join(f.directory, "source.sh");
  fs.writeFileSync(library, "false; return 0\n", { mode: 0o600 });
  const result = spawnSync(resolveNativeBash(), nativeBashArguments(library, "printf continuation"), {
    env: nativeShellEnvironment(), encoding: "utf8", timeout: 5000
  });
  assert.equal(result.stdout, "");
  assert.equal(result.status, 1);
});
