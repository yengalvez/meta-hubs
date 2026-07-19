#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PrivateDockerConfigError,
  withPrivateDockerConfig
} from "../../deployment/with-private-docker-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODULE = path.join(ROOT, "deployment/with-private-docker-config.mjs");
const SECRET = `fixture-ghcr-token-${"S".repeat(64)}`;
const CONFIG_BYTES = Buffer.from(JSON.stringify({
  auths: {
    "ghcr.io": {
      auth: Buffer.from(`fixture-user:${SECRET}`, "utf8").toString("base64")
    }
  }
}), "utf8");
const ENCODED_CONFIG = CONFIG_BYTES.toString("base64");

function fixture() {
  const parent = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "yenhubs-docker-parent-")
  );
  fs.chmodSync(parent, 0o700);
  return parent;
}

function cleanup(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

async function expectCode(factory, code) {
  let captured;
  await assert.rejects(factory, error => {
    captured = error;
    return error instanceof PrivateDockerConfigError;
  });
  assert.equal(captured.code, code);
  assert.equal(`${captured.message}\n${captured.stack}`.includes(SECRET), false);
  return captured;
}

test("materializes exact owner-private bytes only for the callback lifetime", async () => {
  const parent = fixture();
  let callbackDirectory;
  try {
    const result = await withPrivateDockerConfig({
      encodedDockerConfig: ENCODED_CONFIG,
      privateParentDirectory: parent,
      async callback(directoryPath) {
        callbackDirectory = directoryPath;
        assert.equal(path.dirname(directoryPath), parent);
        assert.match(path.basename(directoryPath), /^\.yenhubs-docker-config-[a-f0-9]{32}$/u);
        const directory = fs.lstatSync(directoryPath, { bigint: true });
        const configPath = path.join(directoryPath, "config.json");
        const config = fs.lstatSync(configPath, { bigint: true });
        assert.equal(directory.isDirectory(), true);
        assert.equal(Number(directory.mode & 0o7777n), 0o700);
        assert.equal(config.isFile(), true);
        assert.equal(config.isSymbolicLink(), false);
        assert.equal(config.nlink, 1n);
        assert.equal(Number(config.mode & 0o7777n), 0o600);
        assert.equal(fs.readFileSync(configPath).equals(CONFIG_BYTES), true);
        await Promise.resolve();
        return Object.freeze({ ok: true });
      }
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(fs.existsSync(callbackDirectory), false);
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally {
    cleanup(parent);
  }
});

test("callback failure is preserved after config wipe and complete cleanup", async () => {
  const parent = fixture();
  const expected = new Error("fixed callback failure");
  let callbackDirectory;
  try {
    await assert.rejects(() => withPrivateDockerConfig({
      encodedDockerConfig: ENCODED_CONFIG,
      privateParentDirectory: parent,
      callback(directoryPath) {
        callbackDirectory = directoryPath;
        throw expected;
      }
    }), error => error === expected);
    assert.equal(fs.existsSync(callbackDirectory), false);
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally {
    cleanup(parent);
  }
});

test("rejects loose or symlinked parents before creating credential files", async () => {
  const loose = fixture();
  try {
    fs.chmodSync(loose, 0o755);
    await expectCode(() => withPrivateDockerConfig({
      encodedDockerConfig: ENCODED_CONFIG,
      privateParentDirectory: loose,
      callback() {
        assert.fail("callback must not run");
      }
    }), "private_parent_invalid");
    assert.deepEqual(fs.readdirSync(loose), []);
  } finally {
    cleanup(loose);
  }

  const root = fixture();
  const actual = path.join(root, "actual");
  const alias = path.join(root, "alias");
  fs.mkdirSync(actual, { mode: 0o700 });
  fs.symlinkSync(actual, alias);
  try {
    await expectCode(() => withPrivateDockerConfig({
      encodedDockerConfig: ENCODED_CONFIG,
      privateParentDirectory: alias,
      callback() {
        assert.fail("callback must not run");
      }
    }), "private_parent_invalid");
    assert.deepEqual(fs.readdirSync(actual), []);
  } finally {
    cleanup(root);
  }
});

test("hardlink, permission and symlink races are detected and secret bytes are removed", async t => {
  await t.test("hardlink", async () => {
    const parent = fixture();
    const alias = path.join(parent, "config-hardlink-alias");
    try {
      await expectCode(() => withPrivateDockerConfig({
        encodedDockerConfig: ENCODED_CONFIG,
        privateParentDirectory: parent,
        callback() {
          assert.fail("callback must not run");
        },
        hooks: {
          afterConfigFsync({ configPath }) {
            fs.linkSync(configPath, alias);
          }
        }
      }), "private_docker_config_changed");
      assert.equal(fs.existsSync(alias), true);
      assert.equal(fs.readFileSync(alias).length, 0);
      assert.deepEqual(fs.readdirSync(parent), [path.basename(alias)]);
    } finally {
      cleanup(parent);
    }
  });

  await t.test("permissions", async () => {
    const parent = fixture();
    try {
      await expectCode(() => withPrivateDockerConfig({
        encodedDockerConfig: ENCODED_CONFIG,
        privateParentDirectory: parent,
        callback() {
          assert.fail("callback must not run");
        },
        hooks: {
          afterConfigFsync({ configPath }) {
            fs.chmodSync(configPath, 0o644);
          }
        }
      }), "private_docker_config_changed");
      assert.deepEqual(fs.readdirSync(parent), []);
    } finally {
      cleanup(parent);
    }
  });

  await t.test("symlink replacement", async () => {
    const parent = fixture();
    const target = path.join(parent, "symlink-target");
    fs.writeFileSync(target, "preserve-target", { mode: 0o600 });
    try {
      await expectCode(() => withPrivateDockerConfig({
        encodedDockerConfig: ENCODED_CONFIG,
        privateParentDirectory: parent,
        callback() {
          assert.fail("callback must not run");
        },
        hooks: {
          afterConfigFsync({ configPath }) {
            fs.unlinkSync(configPath);
            fs.symlinkSync(target, configPath);
          }
        }
      }), "private_docker_config_changed");
      assert.equal(fs.readFileSync(target, "utf8"), "preserve-target");
      assert.deepEqual(fs.readdirSync(parent), [path.basename(target)]);
    } finally {
      cleanup(parent);
    }
  });
});

test("success emits no credential bytes to stdout, stderr, argv or environment", () => {
  const script = `
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { withPrivateDockerConfig } from ${JSON.stringify(pathToFileURL(MODULE).href)};
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const encodedDockerConfig = Buffer.concat(chunks).toString("utf8");
    const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "docker-output-"));
    fs.chmodSync(parent, 0o700);
    try {
      await withPrivateDockerConfig({
        encodedDockerConfig,
        privateParentDirectory: parent,
        callback(directoryPath) {
          if (process.argv.some(value => value.includes(encodedDockerConfig)) ||
              Object.values(process.env).some(value => value?.includes(encodedDockerConfig))) {
            throw new Error("credential exposed");
          }
          if (!fs.readFileSync(path.join(directoryPath, "config.json")).length) {
            throw new Error("config absent");
          }
        }
      });
      process.stdout.write("private_docker_config_ok\\n");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    input: ENCODED_CONFIG,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C",
      LC_ALL: "C"
    }
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "private_docker_config_ok\n");
  assert.equal(result.stderr, "");
  const exposed = `${result.stdout}\n${result.stderr}\n${result.error || ""}`;
  assert.equal(exposed.includes(SECRET), false);
  assert.equal(exposed.includes(ENCODED_CONFIG), false);
});
