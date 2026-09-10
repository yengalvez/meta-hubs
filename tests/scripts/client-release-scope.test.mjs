import test from 'node:test';
import assert from 'node:assert/strict';
import { isVisualClientPath, inspectClientScope } from '../../scripts/client-release-scope.mjs';

test('only reviewed rendering modules and unit tests enter visual lane', () => {
  assert.equal(isVisualClientPath('src/utils/avatar-creator-garment-fit.js'), true);
  assert.equal(isVisualClientPath('test/unit/utils/avatar-creator-fit.test.js'), true);
  for (const name of ['src/utils/avatar-api.js', 'src/hub.js', 'package.json',
    'package-lock.json', 'Dockerfile', '.github/workflows/build.yml',
    'src/networked-aframe.js', 'test/unit/fake.js\npackage.json']) {
    assert.equal(isVisualClientPath(name), false, name);
  }
});
test('symbolic refs cannot substitute the deployed commit identity', () => {
  assert.throws(() => inspectClientScope('.', 'HEAD', 'HEAD'), /exact_commit_sha_required/);
});
