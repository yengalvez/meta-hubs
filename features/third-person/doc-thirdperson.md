# Third Person Camera Feature

## Overview

This feature adds a toggleable "Third Person View" to Mozilla Hubs. It modifies the camera system to support a new mode where the camera follows the avatar from behind, allowing users to see their own avatar body.

Based on two reference implementations:
- **Farvel Space** - Commit d388fa3 ([source](https://github.com/farvel-space/space-client/commit/d388fa30cfbde9e836384dc61a98c9310ff91dc9))
- **Hubs Foundation PR #5660** ([source](https://github.com/Hubs-Foundation/hubs/pull/5660))

Both implementations share identical logic. The diffs for applying this feature are in the `commit/` directory.

## Files Modified

| File | Change |
|------|--------|
| `src/storage/store.js` | Add `enableThirdPersonView` preference |
| `src/systems/camera-system.js` | New camera mode + positioning logic |
| `src/react-components/preferences-screen.js` | UI toggle checkbox |

## 1. Storage Schema

### `src/storage/store.js`

Add `enableThirdPersonView` to the `preferences` schema:

```javascript
// Inside SCHEMA.definitions.preferences.properties
enableThirdPersonView: { type: "bool", default: false },
```

## 2. Camera System Logic

### `src/systems/camera-system.js`

#### New Mode Constant

```javascript
export const CAMERA_MODE_THIRD_PERSON_VIEW = 5;
```

#### setMode() - Layer Switching

When entering third-person mode, disable first-person layers and enable third-person layers so the user can see their own avatar body:

```javascript
setMode(cameraMode) {
    // ... validation
    this.mode = mode;

    if (this.mode == CAMERA_MODE_THIRD_PERSON_VIEW) {
      this.viewingCamera.layers.disable(Layers.CAMERA_LAYER_FIRST_PERSON_ONLY);
      this.viewingCamera.layers.enable(Layers.CAMERA_LAYER_THIRD_PERSON_ONLY);
    } else {
      this.viewingCamera.layers.disable(Layers.CAMERA_LAYER_THIRD_PERSON_ONLY);
      this.viewingCamera.layers.enable(Layers.CAMERA_LAYER_FIRST_PERSON_ONLY);
    }
}
```

#### tick() - Scene Entry Detection

Check the user's preference when entering the scene:

```javascript
if (!this.enteredScene && entered) {
    this.enteredScene = true;
    const thirdPersonEnabled = window.APP.store.state.preferences.enableThirdPersonView;
    this.setMode(thirdPersonEnabled ? CAMERA_MODE_THIRD_PERSON_VIEW : CAMERA_MODE_FIRST_PERSON);
}
```

#### tick() - Camera Positioning

The third-person camera positions itself behind the avatar using matrix math:

```javascript
} else if (this.mode === CAMERA_MODE_THIRD_PERSON_VIEW) {
    this.viewingCameraRotator.on = false;
    translation.makeTranslation(0, 0, 1);
    this.avatarRig.object3D.updateMatrices();
    setMatrixWorld(this.viewingRig.object3D, this.avatarRig.object3D.matrixWorld);
    if (scene.is("vr-mode")) {
        this.viewingCamera.updateMatrices();
        setMatrixWorld(this.avatarPOV.object3D, this.viewingCamera.matrixWorld);
    } else {
        this.avatarPOV.object3D.updateMatrices();
        setMatrixWorld(this.viewingCamera, this.avatarPOV.object3D.matrixWorld.multiply(translation));
    }

    this.avatarRig.object3D.updateMatrices();
    this.viewingRig.object3D.matrixWorld.copy(this.avatarRig.object3D.matrixWorld);
    setMatrixWorld(this.viewingRig.object3D, this.viewingRig.object3D.matrixWorld);
    this.avatarPOV.object3D.quaternion.copy(this.viewingCamera.quaternion);
    this.avatarPOV.object3D.matrixNeedsUpdate = true;
}
```

**Key details:**
- `translation.makeTranslation(0, 0, 1)` offsets the camera 1 unit behind the avatar (z-axis)
- The camera follows the avatar rig's world matrix
- VR mode handles positioning differently (camera tracks head position)
- Avatar POV quaternion is synced with the viewing camera for consistent orientation

## 3. UI Implementation

### `src/react-components/preferences-screen.js`

Add a label for the toggle:

```javascript
// Inside preferenceLabels definition
enableThirdPersonView: {
    id: "preferences-screen.preference.enable-third-person-view",
    defaultMessage: "Enable Third-Person View"
},
```

The UI checkbox is auto-generated based on the store schema key matching the label key.

## Known Constraints

- Camera positioning is fixed (z=1 offset) - no dynamic distance adjustment
- No collision detection with walls - camera can clip through geometry
- Third-person mode requires a full-body avatar with proper skeleton (see `features/rpm-avatars/`)

## Applying the Feature

The diff files in `commit/` can be applied to the Hubs client (submodule `hubs/`):

```bash
cd hubs
git apply ../features/third-person/commit/store.js.diff
git apply ../features/third-person/commit/camera-system.js.diff
git apply ../features/third-person/commit/preferences-screen.js.diff
# Optional: German translations
git apply ../features/third-person/commit/de.json.diff
```

After applying, build and deploy following the instructions in `docs/project_maintenance.md`.
