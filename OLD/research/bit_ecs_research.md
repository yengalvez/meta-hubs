# BitECS in Mozilla Hubs: Research & Overview

## Introduction
Mozilla Hubs is transitioning towards a hybrid architecture that combines the ease of use of A-Frame (DOM-based ECS) with the high performance of BitECS (Data-Oriented ECS). This document summarizes the role of BitECS in the codebase.

## Why BitECS?
-   **Performance**: A-Frame's object-oriented nature can introduce overhead, especially with thousands of objects. BitECS uses typed arrays (SoA - Structure of Arrays) which are much more cache-friendly and performant for mass queries and updates.
-   **Memory Efficiency**: Reduces garbage collection overhead by reusing memory in pre-allocated arrays.
-   **Scalability**: Essential for handling complex scenes with many dynamic entities (networking, physics, audio).

## Architecture in Hubs

### 1. Hybrid Coexistence
Hubs runs A-Frame and BitECS side-by-side.
-   **A-Frame**: Handles high-level logic, scene graph, rendering setup (Three.js integration), and UI.
-   **BitECS**: Handles high-frequency systems, physics, and networking synchronization.

### 2. Key Components
-   **Inflators (`src/inflators/*`)**: These appear to be the "bridge" mechanism. An "inflator" likely takes a networked entity or a scene object and "inflates" it into the BitECS world, adding necessary components.
-   **Bit-Systems (`src/systems/bit-*`)**: Systems specifically written to operate on BitECS entities. Examples found: `bit-constraints-system.js`, `bit-media-frames.js`.
-   **Tags & Queries**: BitECS relies heavily on queries to find entities with specific component combinations, whereas A-Frame often uses `querySelectorAll` or iterating over `el.children`.

## Best Practices for Future Development
-   **New Features**: If a feature involves many objects or runs every frame (like particle systems or complex physics), prefer BitECS.
-   **UI/Interaction**: A-Frame components are still suitable for one-off interactions and UI logic.
-   **Migration**: Existing heavy systems are being migrated. When touching old code, check if there's a "bit-" equivalent or if it's slated for migration.

## Further Reading
-   [BitECS Documentation](https://github.com/NateTheGreatt/bitECS)
-   Mozilla Hubs architectural diagrams (if available in official docs).
