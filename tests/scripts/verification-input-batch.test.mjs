import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const verifier = join(root, "scripts/verify-project.sh");
const shells = [...new Set([process.env.BASH || "bash", "/bin/bash"])];

function git(repository, ...args) {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fixture(t, format = "sha1") {
  const directory = mkdtempSync(join(tmpdir(), "yenhubs-input-batch-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true }));
  git(directory, "init", "-q", `--object-format=${format}`);
  return directory;
}

// Fixed pre-batch oracle: raw Git blobs, exact ls-files order, typed NUL fields,
// shell readlink newline semantics and effective executable bit, not git mode.
const reference = String.raw`
legacy_input_material() {
  local relative=. file absolute kind digest executable
  if (( $# > 0 )); then relative="$1"; fi
    while IFS= read -r -d '' file; do
      absolute="$ROOT_DIR/$file"
      if [[ -L "$absolute" ]]; then
        kind=symlink
        digest="$(printf '%s' "$(readlink "$absolute")" | sha256_stream)"
        executable=0
      elif [[ -f "$absolute" ]]; then
        kind=file
        digest="$(command git -C "$ROOT_DIR" hash-object --no-filters -- "$file")"
        if [[ -x "$absolute" ]]; then executable=1; else executable=0; fi
      else
        kind=missing; digest=missing; executable=0
      fi
      printf '%s\0%s\0%s\0%s\0%s\0' root "$file" "$kind" "$digest" "$executable"
    done < <(command git -C "$ROOT_DIR" ls-files -co --exclude-standard -z -- "$relative")
}
legacy_input_sha() {
  legacy_input_material | sha256_stream
}
`;

function fingerprint(directory, shell, extra = "", comparison = true) {
  const result = spawnSync(shell, ["-c", String.raw`
    source "$1"
    ROOT_DIR="$2"
    verification_section_inputs() { printf 'root\t.\n'; }
    ${reference}
    ${comparison ? 'expected="$(legacy_input_sha)"' : ""}
    git() {
      if [[ " $* " == *' hash-object '* ]]; then printf 'hash\n' >>"$ROOT_DIR.calls"; fi
      command git "$@"
    }
    ${extra}
    actual="$(verification_section_input_sha256 static)" || exit 23
    printf 'ACTUAL=%s\n' "$actual"
    ${comparison ? '[[ "$actual" == "$expected" ]] || exit 24' : ""}
  `, "_", verifier, directory], { encoding: "utf8", timeout: 30000 });
  return result;
}

test("batch hashes preserve the full fingerprint with at most three hash processes for 257 files", t => {
  const directory = fixture(t);
  for (let index = 0; index < 257; index++) writeFileSync(join(directory, `f-${index}`), `payload-${index}\0\r\n`);
  for (const shell of shells) {
    const calls = `${directory}.calls`;
    if (lstatSync(directory).isDirectory()) writeFileSync(calls, "");
    t.after(() => rmSync(calls, { force: true }));
    const result = fingerprint(directory, shell);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 3);
  }
});

test("spaces, leading dash, newline, UTF-8, binary, filters and symlinks retain exact typed material", t => {
  const directory = fixture(t);
  const files = ["two words", "-leading", "line\nbreak", "café", "quote\"slash\\"];
  for (const file of files) writeFileSync(join(directory, file), Buffer.from([0, 13, 10, 255, 17]));
  writeFileSync(join(directory, ".gitattributes"), "* text eol=lf\n");
  chmodSync(join(directory, "two words"), 0o700);
  symlinkSync("two words", join(directory, "linked"));
  symlinkSync("absent\n\n", join(directory, "dangling"));
  for (const shell of shells) {
    const result = fingerprint(directory, shell);
    assert.equal(result.status, 0, result.stderr);
  }
  t.after(() => rmSync(`${directory}.calls`, { force: true }));
});

test("missing tracked files and directory replacements keep the missing marker", t => {
  const directory = fixture(t);
  writeFileSync(join(directory, "missing"), "tracked");
  writeFileSync(join(directory, "directory"), "tracked");
  git(directory, "add", "missing", "directory");
  unlinkSync(join(directory, "missing"));
  unlinkSync(join(directory, "directory"));
  mkdirSync(join(directory, "directory"));
  for (const shell of shells) {
    const result = fingerprint(directory, shell);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("ignored untracked files are excluded while tracked ignored files remain bound", t => {
  const directory = fixture(t);
  writeFileSync(join(directory, "kept.log"), "tracked");
  git(directory, "add", "kept.log");
  writeFileSync(join(directory, ".gitignore"), "*.log\n");
  writeFileSync(join(directory, "ignored.log"), "not input");
  const before = fingerprint(directory, "bash");
  assert.equal(before.status, 0, before.stderr);
  writeFileSync(join(directory, "ignored.log"), "different excluded bytes");
  const ignored = fingerprint(directory, "bash");
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.equal(ignored.stdout, before.stdout);
  writeFileSync(join(directory, "kept.log"), "changed tracked bytes");
  const changed = fingerprint(directory, "bash");
  assert.equal(changed.status, 0, changed.stderr);
  assert.notEqual(changed.stdout, before.stdout);
  t.after(() => rmSync(`${directory}.calls`, { force: true }));
});

test("an empty input closure works with Bash nounset without invoking hash-object", t => {
  const directory = fixture(t);
  for (const shell of shells) {
    const result = fingerprint(directory, shell);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("SHA-256 Git repositories retain their native object IDs", t => {
  const directory = fixture(t, "sha256");
  writeFileSync(join(directory, "blob"), "same raw bytes\r\n");
  for (const shell of shells) {
    const result = fingerprint(directory, shell);
    assert.equal(result.status, 0, result.stderr);
  }
  t.after(() => rmSync(`${directory}.calls`, { force: true }));
});

test("overlapping declared paths preserve duplicated ordered records", t => {
  const directory = fixture(t);
  mkdirSync(join(directory, "tree"));
  writeFileSync(join(directory, "tree", "blob"), "payload");
  writeFileSync(join(directory, "other"), "different");
  for (const shell of shells) {
    const result = fingerprint(directory, shell, String.raw`
      verification_section_inputs() { printf 'root\t.\nroot\ttree\n'; }
      expected="$( { legacy_input_material .; legacy_input_material tree; } | sha256_stream)"
    `);
    assert.equal(result.status, 0, result.stderr);
  }
  t.after(() => rmSync(`${directory}.calls`, { force: true }));
});

test("content, effective executable permission and symlink target each invalidate the fingerprint", t => {
  const directory = fixture(t);
  const blob = join(directory, "blob");
  const link = join(directory, "link");
  writeFileSync(blob, "payload");
  symlinkSync("blob", link);
  let previous = fingerprint(directory, "bash");
  assert.equal(previous.status, 0, previous.stderr);
  for (const mutate of [
    () => writeFileSync(blob, "different"),
    () => chmodSync(blob, 0o700),
    () => { unlinkSync(link); symlinkSync("different-target", link); }
  ]) {
    mutate();
    const result = fingerprint(directory, "bash");
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.stdout, previous.stdout);
    previous = result;
  }
  t.after(() => rmSync(`${directory}.calls`, { force: true }));
});

for (const failure of ["inventory", "hash-exit", "hash-short", "hash-invalid", "hash-extra"]) {
  test(`a ${failure} failure cannot produce a usable fingerprint under a conditional caller`, t => {
    const directory = fixture(t);
    writeFileSync(join(directory, "one"), "1");
    writeFileSync(join(directory, "two"), "2");
    const result = fingerprint(directory, "bash", String.raw`
      git() {
        case "$3" in
          ls-files) [[ "$3" != ls-files || "$4" != -co || "${failure}" != inventory ]] || return 97 ;;
          hash-object)
            case "${failure}" in
              hash-exit) printf '%040d\n' 0; return 97 ;;
              hash-short) printf '%040d\n' 0; return 0 ;;
              hash-invalid) printf 'invalid\ninvalid\n'; return 0 ;;
              hash-extra) printf '%040d\n%040d\n%040d\n' 0 0 0; return 0 ;;
            esac ;;
        esac
        command git "$@"
      }
      if actual="$(verification_section_input_sha256 static)"; then exit 98; else exit 0; fi
    `, false);
    assert.equal(result.status, 0, result.stderr);
  });
}

test("batch helpers themselves are part of common harness evidence", () => {
  const result = spawnSync("bash", ["-c", String.raw`
    source "$1"
    material="$(verification_common_harness_material)"
    [[ "$material" == *'verification_emit_input_batch ()'* &&
       "$material" == *'verification_repository_input_material ()'* ]]
  `, "_", verifier], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

for (const boundary of ["before receipt reuse", "post-run fingerprint", "finalizer rejects"]) {
  test(`${boundary}: a failed input hash cannot be ignored by its conditional caller`, t => {
    const directory = fixture(t);
    mkdirSync(join(directory, "evidence"), { mode: 0o700 });
    const result = fingerprint(directory, "bash", String.raw`
      VERIFY_EVIDENCE_DIR="$ROOT_DIR/evidence"
      VERIFY_FULL_SECTIONS=(dialog)
      verification_section_input_sha256() {
        printf '%064d\n' 0
        if [[ "${boundary}" == 'post-run fingerprint' && ! -e "$ROOT_DIR/body-ran" ]]; then return 0; fi
        return 97
      }
      receipt_is_current() {
        printf 'checked\n' >>"$ROOT_DIR/receipt-checked"
        [[ "${boundary}" != 'post-run fingerprint' ]]
      }
      run_section_in_fresh_shell() { printf 'ran\n' >"$ROOT_DIR/body-ran"; }
      known_verification_processes_are_absent() { return 0; }
      write_pass_receipt() { printf 'unsafe\n' >"$ROOT_DIR/receipt-written"; }
      if [[ "${boundary}" == 'finalizer rejects' ]]; then
        if finalize_verification; then exit 98; else
          [[ ! -e "$ROOT_DIR/receipt-checked" ]] || exit 99
          exit 0
        fi
      fi
      if run_recorded_section dialog; then exit 98; else
        [[ ! -e "$ROOT_DIR/receipt-written" ]] || exit 99
        if [[ "${boundary}" == 'before receipt reuse' ]]; then
          [[ ! -e "$ROOT_DIR/receipt-checked" && ! -e "$ROOT_DIR/body-ran" ]] || exit 99
        fi
        exit 0
      fi
    `, false);
    assert.equal(result.status, 0, result.stderr);
  });
}
