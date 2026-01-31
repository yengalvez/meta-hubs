# Third Person Camera Feature Archive

## Overview
This feature adds a toggleable "Third Person View" to Mozilla Hubs. It modifies the camera system to support a new mode where the camera follows the avatar from behind.

## 1. Storage Schema

### `src/storage/store.js`
Added `enableThirdPersonView` to the `preferences` schema.

```javascript
// Inside SCHEMA.definitions.preferences.properties
enableThirdPersonView: { type: "bool", default: false },
```

## 2. Logic Implementation

### `src/systems/camera-system.js`
Implements the third-person camera logic, including orbit/follow mechanics and mode switching.

**Key Changes:**
1.  **New Mode Constant:** `CAMERA_MODE_THIRD_PERSON_VIEW = 5` defined.
2.  **Toggle Logic:** `setMode` handles disabling first-person layers and enabling third-person logic.
3.  **Tick Logic:** Updates camera position relative to `avatarRig` when in third-person mode.

```javascript
// ... constants
export const CAMERA_MODE_THIRD_PERSON_VIEW = 5; // [ADDED]

// ... inside CameraSystem class

setMode(cameraMode) {
    // ... validation
    this.mode = mode;

    if (this.mode == CAMERA_MODE_THIRD_PERSON_VIEW) { // [ADDED]
      this.viewingCamera.layers.disable(Layers.CAMERA_LAYER_FIRST_PERSON_ONLY);
      this.viewingCamera.layers.enable(Layers.CAMERA_LAYER_THIRD_PERSON_ONLY);
    } else {
      this.viewingCamera.layers.disable(Layers.CAMERA_LAYER_THIRD_PERSON_ONLY);
      this.viewingCamera.layers.enable(Layers.CAMERA_LAYER_FIRST_PERSON_ONLY);
    }
}

// ... inside tick() function
if (!this.enteredScene && entered) {
    this.enteredScene = true;
    // Check store for preference [ADDED]
    const thirdPersonEnabled = window.APP.store.state.preferences.enableThirdPersonView;
    this.setMode(thirdPersonEnabled ? CAMERA_MODE_THIRD_PERSON_VIEW : CAMERA_MODE_FIRST_PERSON);
}

// ... inside tick() loop handling modes
} else if (this.mode === CAMERA_MODE_THIRD_PERSON_VIEW) { // [ADDED BLOCK]
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

## 3. UI Implementation

### `src/react-components/preferences-screen.js`
Adds a checkbox to the Graphics (or Controls) section to enable/disable the view.

**Key Changes:**
1.  **Label Definition:** Added `enableThirdPersonView` to `preferenceLabels`.
2.  **Schema Default:** Ensuring `store.js` has the default value (covered above).

```javascript
// ... inside preferenceLabels definition
enableThirdPersonView: {
    id: "preferences-screen.preference.enable-third-person-view",
    defaultMessage: "Enable Third-Person View"
},
```
*(Note: The actual UI component is auto-generated based on the store schema key matching the label key)*
```
