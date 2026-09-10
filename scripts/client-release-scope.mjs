#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Deliberately small: a new module is a reviewed policy change, not an automatic
// assertion that every browser edit is incapable of changing persisted data.
const visualFiles = new Set([
  'src/utils/avatar-animation-retarget.js',
  'src/utils/avatar-creator-garment-fit.js',
  'src/utils/avatar-creator-garment-hems.js',
  'src/utils/mixamo-shared-animations.js'
]);
export function isVisualClientPath(name) {
  return visualFiles.has(name) || /^test\/unit\/[^\n\r]+\.(?:js|json)$/.test(name);
}
export function inspectClientScope(repository, from, to) {
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const sha of [from, to]) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('exact_commit_sha_required');
    if (git('rev-parse', `${sha}^{commit}`).trim() !== sha) throw new Error('commit_invalid');
  }
  git('merge-base', '--is-ancestor', from, to);
  if (git('rev-parse', 'HEAD').trim() !== to || git('status', '--porcelain').trim()) {
    throw new Error('client_candidate_must_be_clean_HEAD');
  }
  const changes = git('diff', '--no-renames', '--raw', '-z', from, to).split('\0');
  const paths = [];
  for (let i = 0; i < changes.length - 1; i += 2) {
    const fields = changes[i].split(' ');
    const name = changes[i + 1];
    // Only ordinary regular-file additions/modifications; never gitlinks,
    // executable build hooks, symlinks, deletes or renames hidden by detection.
    if (!/^:(?:100644|000000)$/.test(fields[0]) || fields[1] !== '100644' ||
        !['M', 'A'].includes(fields[4]) || !isVisualClientPath(name)) {
      throw new Error('full_workflow_required_for_nonvisual_change');
    }
    paths.push(name);
  }
  if (!paths.some(name => visualFiles.has(name))) throw new Error('visual_change_required');
  return { profile: 'visual-client-v1', from, to, paths,
    sections: ['advisories', 'hubs', 'browser-capacity', 'composition'],
    liveAcceptanceRequired: true, imageOnlyGuardRequired: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) throw new Error('usage_repository_fromSHA_toSHA');
    console.log(JSON.stringify(inspectClientScope(...process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message?.startsWith('Command failed:') ? 'client_scope_git_check_failed' : error.message);
    process.exitCode = 1;
  }
}
