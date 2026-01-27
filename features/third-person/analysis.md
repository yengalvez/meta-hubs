# Third Person Camera: Comprehensive Reference Analysis

This document archives the research on third-person camera implementations for Mozilla Hubs. The actual code snippets extracted from these references are stored in:
- `farvel_space_commit.js`
- `hubs_foundation_pr.js`

## 1. Farvel Space Implementation
**Source**: [Commit d388fa3](https://github.com/farvel-space/space-client/commit/d388fa30cfbde9e836384dc61a98c9310ff91dc9)

### Architecture
- **Camera Mode**: Defines `CAMERA_MODE_THIRD_PERSON_VIEW = 5`.
- **System Logic**: Modifies `CameraSystem` directly to use `setMatrixWorld` for positioning.
- **Layering**: Correctly toggles `CAMERA_LAYER_THIRD_PERSON_ONLY` to allow users to see their own avatar body.
- **UI**: Integrated into the Preferences screen as a checkbox.

### Constraints
- Positioning is rigid (fixed translation of `z=1`).
- No collision detection for walls.

## 2. Hubs Foundation PR #5660
**Source**: [PR #5660](https://github.com/Hubs-Foundation/hubs/pull/5660)

### Architecture
- **Identical Logic**: Uses the same mode `5` and identical matrix math as the Farvel implementation.
- **Internationalization**: Includes translations for Korean (ko.json).
- **Store Integration**: Adds `enableThirdPersonView` to the persistent schema.

## Comparison Summary

| Feature | Farvel Space | Hubs Foundation PR #5660 |
| :--- | :--- | :--- |
| **Logic** | Matrix-based Sync | Matrix-based Sync (Identical) |
| **State** | Preferences Store | Preferences Store |
| **Layers** | Handled | Handled |
| **Language** | German (de) | Korean (ko) |

### Conclusion
Both systems share a common ancestor or were developed following the same pattern. They provide a native-feeling integration by modifying the core `CameraSystem.js` and `PreferencesScreen.js`, rather than using external components.

**Status**: All research code is archived in the `commit/` directory. No implementation is active in the current project.
