# ReadyPlayer.me GLB Avatars for Hubs CE

## Overview

ReadyPlayer.me (RPM) has shut down, but we have pre-downloaded `.glb` avatar files that can be used in Hubs Community Edition. These avatars are full-body, rigged humanoid models in GLB format (glTF 2.0 binary) that work with Hubs' avatar system.

This guide covers how to upload and validate these avatars for proper functionality including movement, bones, animations, and third-person camera compatibility.

## Uploading Avatars via Admin Panel

Hubs CE provides a native way to manage avatars through the Admin Panel.

### Steps

1. Log into your Hubs instance as admin
2. Navigate to **Admin Panel** (`https://your-domain.com/admin`)
3. Go to **Avatars** section
4. Click **New Avatar** (or import)
5. Upload the `.glb` file
6. Set a name and thumbnail
7. Save

The avatar will now be available for users to select in the avatar picker.

### Bulk Upload via API

For multiple avatars, you can use the Reticulum API directly:

```bash
# Upload avatar GLB via API
curl -X POST "https://your-domain.com/api/v1/avatars" \
  -H "Authorization: Bearer <admin-token>" \
  -F "avatar[file]=@avatar.glb" \
  -F "avatar[name]=My RPM Avatar"
```

## Known Issues with RPM GLBs in Hubs

ReadyPlayer.me avatars were not originally designed for Hubs. The following issues have been documented by the community and have known fixes.

### 1. T-Pose Flashing

**Symptom**: Avatar flickers back to T-Pose during animations.

**Cause**: RPM avatars include `VectorKeyframeTrack`s (position/scale tracks) that conflict with Hubs' animation system. Only `QuaternionKeyframeTrack`s (rotation) should be used.

**Fix**: Filter animations before loading:
```javascript
clip.tracks = clip.tracks.filter(track =>
  track instanceof THREE.QuaternionKeyframeTrack
);
```

Additionally, finger/hand tracks can cause issues:
```javascript
const fingerKeywords = ['thumb', 'index', 'middle', 'ring', 'pinky', 'finger'];
clip.tracks = clip.tracks.filter(track => {
  const name = track.name.toLowerCase();
  return !fingerKeywords.some(keyword => name.includes(keyword));
});
```

**Reference**: Hubs issues #5964, #4847

### 2. Missing Bot_PBS Material

**Symptom**: Avatar renders incorrectly or materials look wrong.

**Cause**: Hubs expects the primary avatar material to be named `Bot_PBS`. RPM avatars use different material names.

**Fix**: Rename the first material:
```javascript
// Find first material and rename to Bot_PBS
gltf.scene.traverse(node => {
  if (node.isMesh && node.material) {
    const mat = Array.isArray(node.material) ? node.material[0] : node.material;
    mat.name = "Bot_PBS";
  }
});
```

### 3. Textures Not Loading / Wrong Colors

**Symptom**: Avatar appears black or with incorrect colors.

**Cause**: Texture encoding must be explicitly set for Hubs' renderer.

**Fix**:
```javascript
// Base color maps need sRGB encoding
material.map.encoding = THREE.sRGBEncoding;

// Normal maps need Linear encoding
material.normalMap.encoding = THREE.LinearEncoding;
```

For CORS issues when loading textures from external URLs:
```javascript
const proxiedUrl = `/api/v1/media?url=${encodeURIComponent(avatarUrl)}`;
```

### 4. Audio Feedback Not Working

**Symptom**: Avatar head doesn't scale when the user speaks.

**Fix**: Add the `scale-audio-feedback` Hubs component to the Head bone:
```javascript
headNode.userData.gltfExtensions = {
  MOZ_hubs_components: {
    "scale-audio-feedback": {
      minScale: 1.0,
      maxScale: 1.3
    }
  }
};
```

## Required Bone Structure

Hubs requires a humanoid skeleton with these bones for proper IK (inverse kinematics) and animation:

### Minimum Required
- `Hips`
- `Spine`
- `Neck`
- `Head`
- `LeftShoulder`, `LeftArm`, `LeftForeArm`, `LeftHand`
- `RightShoulder`, `RightArm`, `RightForeArm`, `RightHand`

### Recommended for Full Body
- `Spine1`, `Spine2` (better torso deformation)
- `LeftUpLeg`, `LeftLeg`, `LeftFoot`
- `RightUpLeg`, `RightLeg`, `RightFoot`
- `LeftToeBase`, `RightToeBase`

RPM full-body avatars typically include all these bones. Half-body avatars (issue #5964) are NOT recommended as they cause mesh holes.

## Pre-Upload Validation Checklist

Before uploading a GLB to Hubs:

- [ ] File is valid `.glb` format (glTF 2.0 binary)
- [ ] Skeleton is present with required bones
- [ ] Full-body avatar (not half-body)
- [ ] Vertex count < 100,000 (for web performance)
- [ ] Triangle count < 50,000
- [ ] Textures are power-of-2 dimensions (512, 1024, 2048)
- [ ] Textures are max 2048x2048
- [ ] No problematic VectorKeyframeTracks in animations

Use `glb-avatar-validator.js` to automate this validation (see below).

## Validator Script

The file `glb-avatar-validator.js` in this directory provides automated validation and processing:

```javascript
import { HubsGLBAvatarValidator } from './glb-avatar-validator.js';

const validator = new HubsGLBAvatarValidator();

// Validate
const result = await validator.validate(gltf);
console.log('Valid:', result.valid);
console.log('Errors:', result.errors);
console.log('Warnings:', result.warnings);

// Process (fix known issues automatically)
const processed = validator.process(gltf);

// Generate detailed report
const report = validator.generateReport(gltf);
```

The validator:
- Checks skeleton and required bones
- Validates materials and textures
- Detects problematic animations
- Checks geometry vertex/triangle counts
- Filters VectorKeyframeTracks (T-Pose fix)
- Ensures Bot_PBS material naming
- Optimizes texture encoding
- Adds Hubs audio feedback components
- Computes bounding volumes for performance

## Third-Person Camera Compatibility

For RPM avatars to work correctly with the third-person camera feature (see `features/third-person/`):

- The avatar MUST have a complete skeleton (Hips through Head chain)
- The camera system uses `avatarRig.object3D.matrixWorld` for positioning
- The third-person layer system (`CAMERA_LAYER_THIRD_PERSON_ONLY`) makes the avatar body visible to the user
- First-person layers are disabled so you see your own avatar from behind

If the avatar skeleton is incomplete, the camera may position incorrectly or the avatar body may not render in third-person view.

## References

- Hubs Issue #5964: Half-body RPM avatars
- Hubs Issue #4847: Speaking indicators with external avatars
- Hubs Issue #5532: Third-person view
- Hubs PR #5660: Third-person camera implementation
