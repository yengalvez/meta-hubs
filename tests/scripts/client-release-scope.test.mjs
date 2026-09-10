import test from 'node:test';
import assert from 'node:assert/strict';
import { isVisualClientPath, inspectClientScope, isOnlyCreatorCameraIntegration } from '../../scripts/client-release-scope.mjs';

test('only reviewed rendering modules and unit tests enter visual lane', () => {
  assert.equal(isVisualClientPath('src/utils/avatar-creator-garment-fit.js'), true);
  assert.equal(isVisualClientPath('src/utils/avatar-creator-viewpoint.js'), true);
  assert.equal(isVisualClientPath('test/unit/utils/avatar-creator-fit.test.js'), true);
  for (const name of ['src/utils/avatar-api.js', 'src/hub.js', 'package.json',
    'package-lock.json', 'Dockerfile', '.github/workflows/build.yml',
    'src/networked-aframe.js', 'test/unit/fake.js\npackage.json']) {
    assert.equal(isVisualClientPath(name), false, name);
  }
});
test('camera exception admits only the exact reviewed optical integration', () => {
  const before = 'import { INSPECTABLE_FLAGS } from "../bit-systems/inspect-system";\n' +
    '    const scale = new THREE.Vector3();\n' +
    '          this.avatarPOV.object3D.matrixWorld.decompose(position, quat, scale);\n';
  const after = before
    .replace('import { INSPECTABLE_FLAGS } from "../bit-systems/inspect-system";',
      'import { INSPECTABLE_FLAGS } from "../bit-systems/inspect-system";\nimport { createCreatorViewpointClassifier, creatorViewpointPosition } from "../utils/avatar-creator-viewpoint";')
    .replace('    const scale = new THREE.Vector3();',
      '    const scale = new THREE.Vector3();\n    const opticalPosition = new THREE.Vector3();\n    const isCreatorViewpoint = createCreatorViewpointClassifier();')
    .replace('          this.avatarPOV.object3D.matrixWorld.decompose(position, quat, scale);',
      '          this.avatarPOV.object3D.matrixWorld.decompose(position, quat, scale);\n          const avatarMesh = this.avatarRig.querySelector(".model")?.getObject3D("mesh");\n          creatorViewpointPosition(position, quat, isCreatorViewpoint(avatarMesh), opticalPosition);\n          position.copy(opticalPosition);');
  assert.equal(isOnlyCreatorCameraIntegration(before, after), true);
  assert.equal(isOnlyCreatorCameraIntegration(before, after + 'avatarPOV.position.y += 1;'), false);
  assert.equal(isOnlyCreatorCameraIntegration(before, after.replace('position.copy(opticalPosition)', 'this.avatarPOV.position.copy(opticalPosition)')), false);
  assert.equal(isOnlyCreatorCameraIntegration(before + before, after), false);
  assert.equal(isOnlyCreatorCameraIntegration(after, after), false);
});
test('symbolic refs cannot substitute the deployed commit identity', () => {
  assert.throws(() => inspectClientScope('.', 'HEAD', 'HEAD'), /exact_commit_sha_required/);
});
