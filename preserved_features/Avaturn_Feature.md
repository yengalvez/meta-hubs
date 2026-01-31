# Avaturn Integration Feature Archive

## Overview
This feature integrates the Avaturn avatar creator into Mozilla Hubs as a modal iframe. It includes a specialized validator (`AvaturnAvatarValidator`) to ensure compatibility with Hubs' requirements (skeletons, materials, etc.).

## 1. New Files

### `src/react-components/room/AvaturnModal.js`
Renders the Avaturn iFrame in a modal overlay and handles the postMessage communication.

```javascript
import React, { useEffect, useCallback, useRef } from "react";
import ReactDOM from "react-dom";
import PropTypes from "prop-types";
import styles from "./AvaturnModal.scss";

const AVATURN_URL = "https://demo.avaturn.dev/iframe";

export function AvaturnModal({ onClose, onAvatarCreated }) {
    const iframeRef = useRef(null);

    const handleMessage = useCallback(
        (event) => {
            // Validate origin
            if (!event.origin.includes("avaturn.dev")) {
                return;
            }

            let data;
            try {
                data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
            } catch (e) {
                console.warn("[Avaturn] Could not parse message:", e);
                return;
            }

            // Check for Avaturn export events
            if (data.source === "avaturn" && data.eventName === "v2.avatar.exported") {
                console.log("[Avaturn] Avatar exported:", data.data);
                const glbUrl = data.data.url;
                const metadata = {
                    avatarId: data.data.avatarId,
                    bodyId: data.data.bodyId,
                    gender: data.data.gender,
                    supportsFaceAnimations: data.data.avatarSupportsFaceAnimations
                };
                onAvatarCreated(glbUrl, metadata);
            }

            // Alternative format (type-based)
            if (data.type === "avatarExport" && data.url) {
                console.log("[Avaturn] Avatar exported (alt format):", data);
                onAvatarCreated(data.url, {
                    avatarId: data.avatarId,
                    bodyId: data.bodyId,
                    gender: data.gender,
                    supportsFaceAnimations: data.avatarSupportsFaceAnimations
                });
            }
        },
        [onAvatarCreated]
    );

    // Block body scroll when modal is open
    useEffect(() => {
        const originalOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = originalOverflow;
        };
    }, []);

    useEffect(() => {
        window.addEventListener("message", handleMessage);
        return () => {
            window.removeEventListener("message", handleMessage);
        };
    }, [handleMessage]);

    // Use React Portal to render outside the current DOM tree
    return ReactDOM.createPortal(
        <div className={styles.avaturnOverlay} onClick={onClose}>
            <div className={styles.avaturnContainer} onClick={(e) => e.stopPropagation()}>
                <button className={styles.closeButton} onClick={onClose} aria-label="Close Avaturn">
                    ✕
                </button>
                <iframe
                    ref={iframeRef}
                    src={AVATURN_URL}
                    allow="camera *; microphone *; clipboard-write"
                    className={styles.avaturnIframe}
                    title="Avaturn Avatar Creator"
                />
            </div>
        </div>,
        document.body
    );
}

AvaturnModal.propTypes = {
    onClose: PropTypes.func.isRequired,
    onAvatarCreated: PropTypes.func.isRequired
};
```

### `src/react-components/room/AvaturnModal.scss`
Styles for the modal overlay.

```scss
@use "../styles/theme";

.avaturnOverlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.9);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 2147483647;
  /* Maximum z-index value */
  backdrop-filter: blur(8px);
  /* Ensure nothing can be above this */
  isolation: isolate;
}

.avaturnContainer {
  position: relative;
  width: calc(100vw - 40px);
  height: calc(100vh - 40px);
  max-width: 100vw;
  max-height: 100vh;
  background-color: #ffffff;
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  padding: 8px;
  box-sizing: border-box;
}

.avaturnIframe {
  width: 100%;
  height: 100%;
  flex: 1;
  border: none;
  border-radius: 12px;
  background-color: #f5f5f5;
}

.closeButton {
  position: absolute;
  top: -20px;
  right: -20px;
  width: 50px;
  height: 50px;
  border-radius: 50%;
  background-color: #e53935;
  color: white;
  border: 5px solid #ffffff;
  font-size: 24px;
  font-weight: bold;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  transition: transform 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;
  z-index: 2147483647;

  &:hover {
    background-color: #c62828;
    transform: scale(1.15);
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.5);
  }

  &:active {
    transform: scale(0.95);
  }
}
```

### `src/utils/avaturn-validator.js`
Logic to validate and optimize GLBs coming from Avaturn.

```javascript
/**
 * Avaturn Avatar Validator para Mozilla Hubs
 *
 * Valida y procesa avatares de Avaturn para asegurar compatibilidad
 * con Mozilla Hubs (hubs-foundation)
 *
 * Basado en lecciones aprendidas de ReadyPlayer.me integration
 */

import * as THREE from "three";

export class AvaturnAvatarValidator {
  constructor() {
    // Huesos requeridos para avatar básico funcional
    this.requiredBones = [
      "Hips", "Spine", "Neck", "Head", "LeftShoulder", "LeftArm",
      "LeftForeArm", "LeftHand", "RightShoulder", "RightArm",
      "RightForeArm", "RightHand"
    ];
    // Palabras clave de dedos para filtrado
    this.fingerKeywords = ['thumb', 'index', 'middle', 'ring', 'pinky', 'finger'];
  }

  // ... (Full implementation available in backup, see original file content) ...
  // Refer to original file content for full 537 lines of logic.
}
export default AvaturnAvatarValidator;
```

## 2. Modified Files

### `src/react-components/profile-entry-panel.js`
Modifications to handle the modal state and receive the new avatar URL.

**Key Changes:**
1.  Import `AvaturnModal`.
2.  Add `showAvaturnModal` to state.
3.  Add `handleAvaturnAvatarCreated` method.
4.  Render `AvaturnModal` conditionally.

```javascript
// ... imports
import { AvaturnModal } from "./room/AvaturnModal"; // [ADDED]

// ... inside Class
state = {
    // ...
    showAvaturnModal: false // [ADDED]
};

// ...
handleAvaturnAvatarCreated = (glbUrl, metadata) => { // [ADDED]
    console.log("[Avaturn] Avatar created:", glbUrl, metadata);
    this.setState({
        avatarId: glbUrl,
        showAvaturnModal: false
    });
    replaceHistoryState(
        this.props.history,
        this.props.history.location.state?.key || "profile",
        "profile",
        { avatarId: glbUrl }
    );
};

// ... inside render()
const avatarSettingsProps = {
    // ...
    onCreateAvaturn: e => { // [ADDED]
        e.preventDefault();
        this.setState({ showAvaturnModal: true });
    },
    // ...
};

// ... inside return JSX
{this.state.showAvaturnModal && ( // [ADDED]
    <AvaturnModal
        onClose={() => this.setState({ showAvaturnModal: false })}
        onAvatarCreated={this.handleAvaturnAvatarCreated}
    />
)}
```

### `src/react-components/room/AvatarSettingsContent.js`
Adds the "Create with Avaturn" button to the UI.

**Key Changes:**
1.  Destructure `onCreateAvaturn` prop.
2.  Render the button.

```javascript
// ... destructuring props
onCreateAvaturn, // [ADDED]

// ... inside JSX
{onCreateAvaturn && ( // [ADDED]
    <Button type="button" preset="accent" onClick={onCreateAvaturn}>
        <FormattedMessage id="avatar-settings-content.create-avaturn-button" defaultMessage="✨ Create with Avaturn" />
    </Button>
)}
```
