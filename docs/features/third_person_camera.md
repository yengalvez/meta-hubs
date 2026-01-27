# Third-Person Camera Feature Documentation

## Overview
This document details the implementation of the Third-Person Camera feature in Mozilla Hubs. The feature provides users with an alternative perspective to the default first-person view, allowing them to see their avatar and surroundings more broadly.

## Features
-   **Toggleable View**: Users can switch between First-Person, Third-Person (Near), and Third-Person (Far) modes.
-   **Smooth Camera Follow**: The camera smoothly follows the avatar's movement using linear and spherical interpolation (Lerp/Slerp), reducing jitter and motion sickness.
-   **UI Integration**: A "Camera View" button is integrated into the central toolbar for easy access.

## Implementation Details

### Core Logic: `CameraSystem`
Location: `src/systems/camera-system.js`

-   **State Management**: The `CameraSystem` maintains a `mode` property that tracks the current camera state (`CAMERA_MODE_FIRST_PERSON`, `CAMERA_MODE_THIRD_PERSON_NEAR`, `CAMERA_MODE_THIRD_PERSON_FAR`).
-   **Cycle Logic**: The `nextMode()` function cycles through the defined modes.
-   **Frame Update (`tick`)**:
    -   In `tick()`, the system calculates the desired target position for the camera rig (`viewingRig`) based on the avatar's position (`avatarRig`) and a predefined offset.
    -   **Smoothing**: Instead of snapping the camera to the target position, we use:
        ```javascript
        const DAMPING = 0.1;
        this.viewingRig.object3D.position.lerp(targetPosition, DAMPING);
        this.viewingRig.object3D.quaternion.slerp(targetQuaternion, DAMPING);
        ```
    -   This interpolation happens every frame, ensuring a fluid camera movement that trails slightly behind the avatar.

### UI Component: `ToolbarButton`
Location: `src/react-components/ui-root.js`

-   A new `ToolbarButton` was added to the `toolbarCenter` section.
-   It uses a generic camera icon and triggers `cameraSystem.nextMode()` on click.

## Configuration
-   `enableThirdPersonMode`: A constant in `camera-system.js` set to `true` to enable the feature by default along with the logic to allow cycling through modes.

## Known Issues & Limitations
-   **Clipping**: The camera does not currently detect collisions with walls or objects. In tight spaces, the camera might clip through geometry.
-   **Teleportation**: rapid long-distance movement (teleportation) might cause a fast "swoop" of the camera. Future improvements could snap the camera instantly if the distance is too large.
