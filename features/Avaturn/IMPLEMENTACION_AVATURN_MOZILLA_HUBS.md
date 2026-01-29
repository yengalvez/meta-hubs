# Implementación de Avaturn en Mozilla Hubs
## Guía Técnica Completa para Desarrolladores

**Fecha de Investigación:** Enero 2026
**Versión:** 1.0
**Estado de Mozilla Hubs:** Hubs-Foundation (mantenido por la comunidad)

---

## Tabla de Contenidos

1. [Resumen Ejecutivo](#resumen-ejecutivo)
2. [Estado Actual de Mozilla Hubs](#estado-actual-de-mozilla-hubs)
3. [Arquitectura del Sistema de Avatares en Hubs](#arquitectura-del-sistema-de-avatares-en-hubs)
4. [Implementación de ReadyPlayer.me](#implementación-de-readyplayerme)
5. [Sistema BELIVVR XRcloud](#sistema-belivvr-xrcloud)
6. [Avaturn: Documentación y Modo Gratuito](#avaturn-documentación-y-modo-gratuito)
7. [Estrategia de Implementación de Avaturn en Hubs](#estrategia-de-implementación-de-avaturn-en-hubs)
8. [Código Completo de Implementación](#código-completo-de-implementación)
9. [Problemas Conocidos y Soluciones](#problemas-conocidos-y-soluciones)
10. [Mejores Prácticas](#mejores-prácticas)
11. [Testing y Validación](#testing-y-validación)
12. [Referencias y Recursos](#referencias-y-recursos)

---

## Resumen Ejecutivo

### Objetivo
Implementar el sistema de avatares de **Avaturn** dentro de **Mozilla Hubs** (repositorio hubs-foundation), utilizando como referencia las implementaciones existentes de **ReadyPlayer.me** y **BELIVVR XRcloud**, sin usar la API de pago de Avaturn (modo gratuito).

### Hallazgos Clave

1. **Mozilla Hubs fue discontinuado el 31 de mayo de 2024** pero la comunidad lo mantiene activamente en hubs-foundation
2. **ReadyPlayer.me ya está implementado** en Hubs con problemas conocidos y soluciones documentadas
3. **BELIVVR XRcloud** proporciona un fork con sistema de avatares full-body mejorado
4. **Avaturn puede usarse gratuitamente** mediante iFrame sin API, exportando avatares en formato GLB
5. **La arquitectura de Hubs es modular** basada en componentes A-Frame + Three.js

### Estrategia Recomendada

**Opción 1: iFrame Integration (Más Simple)**
- Integrar Avaturn mediante iFrame en el avatar editor de Hubs
- Recibir GLB exportado via postMessage
- Cargar avatar con el sistema existente de Hubs

**Opción 2: Full Integration (Más Compleja)**
- Modificar avatar-editor.js para incluir Avaturn SDK
- Adaptar el flujo de carga similar a ReadyPlayer.me
- Implementar fallbacks y validaciones

---

## Estado Actual de Mozilla Hubs

### Contexto Histórico

**Mozilla Hubs Original:**
- Desarrollado por Mozilla Mixed Reality
- Discontinuado: 31 de mayo de 2024
- Repositorio original: `mozilla/hubs` (archivado)

**Hubs Foundation (Actual):**
- Mantenido por: Hubs Foundation + comunidad
- Repositorio: https://github.com/Hubs-Foundation/hubs
- Última versión estable: `prod-2025-12-17` (Diciembre 2025)
- Estado: Activamente mantenido
- Licencia: Mozilla Public License 2.0 (MPL-2.0)

### Repositorios Relevantes

| Repositorio | URL | Propósito |
|------------|-----|-----------|
| **Hubs Foundation** | https://github.com/Hubs-Foundation/hubs | Código principal del cliente |
| **Hubs Avatar Pipelines** | https://github.com/MozillaReality/hubs-avatar-pipelines | Templates de Blender y assets |
| **Hubs Community** | https://github.com/Hubs-Community | Recursos de la comunidad |
| **Hackweek Avatar Maker** | https://github.com/mozilla/hackweek-avatar-maker | Prototipo de avatar maker |

### Stack Tecnológico

**Frontend:**
- **A-Frame:** Framework WebVR/WebXR (Entity-Component-System)
- **Three.js r128:** Motor de renderizado 3D
- **React:** UI components y editor
- **TypeScript:** Tipos y sistemas BitECS
- **Webpack:** Bundler y module resolution

**Backend:**
- **Reticulum:** Phoenix (Elixir) backend
- **WebRTC:** Comunicación P2P
- **Mediasoup:** SFU para audio/video
- **PostgreSQL:** Base de datos

**Formatos 3D:**
- **glTF 2.0:** Formato principal (GLB para binary)
- **Extensiones MOZ:** `MOZ_hubs_components`, `HUBS_components`
- **Compresión:** DRACO, KTX2, Basis

---

## Arquitectura del Sistema de Avatares en Hubs

### Estructura de Carpetas

```
hubs/src/
├── components/              # Componentes A-Frame
│   ├── networked-avatar.js           # Sincronización en red
│   ├── avatar-audio-source.js        # Audio spatial
│   ├── ik-controller.js              # Cinemática inversa
│   ├── hand-poses.js                 # 8 poses de mano
│   ├── gltf-model-plus.js           # Cargador glTF mejorado
│   └── [más componentes...]
│
├── react-components/        # Componentes React UI
│   ├── avatar-editor.js              # Editor principal
│   └── avatar-preview.js             # Preview con Three.js
│
├── systems/                 # Sistemas A-Frame
│   ├── character-controller-system.js # Control de movimiento
│   └── [64 sistemas...]
│
├── utils/                   # Utilidades
│   ├── avatar-utils.js               # Funciones de avatar
│   ├── three-utils.js
│   └── media-url-utils.js
│
└── bit-systems/            # Sistemas BitECS modernos
    └── networking.ts
```

### Tipos de Avatares Soportados

```javascript
// Definidos en avatar-utils.js
export const AVATAR_TYPES = {
  SKINNABLE: "skinnable",    // Avatar personalizable del servidor
  URL: "url"                 // URL directa a GLB/GLTF
};
```

### Pipeline de Carga de Avatares

```
Usuario selecciona avatar
         ↓
avatar-utils.js → getAvatarSrc(avatarId)
         ↓
¿Tipo de avatar?
    ↙        ↘
SKINNABLE    URL
    ↓        ↓
API fetch   Proxy URL
    ↘        ↙
    GLB/GLTF URL
         ↓
gltf-model-plus.js → loadGLTF()
         ↓
ensureAvatarMaterial() → Busca "Bot_PBS"
         ↓
Three.js → GLTFLoader
         ↓
Inflate entities (A-Frame)
         ↓
Apply Hubs components
         ↓
Add to scene
         ↓
networked-avatar → Sync state
```

### Componentes Clave

#### 1. `gltf-model-plus.js` - Cargador Principal

```javascript
AFRAME.registerComponent("gltf-model-plus", {
  schema: {
    src: { type: "string" },              // URL del modelo
    contentType: { type: "string" },      // MIME type
    useCache: { type: "boolean" },        // Cache (default: true)
    inflate: { type: "boolean" },         // Crear entidades
    batch: { type: "boolean" },           // Batching
    modelToWorldScale: { type: "number" } // Escala
  },

  init() {
    this.gltfCache = new Map();
    this.inflatedEntities = [];
  },

  async update(oldData) {
    if (this.data.src === oldData.src) return;

    // Cargar modelo
    const gltf = await this.loadModel(this.data.src);

    // Aplicar a entidad
    this.el.setObject3D("mesh", gltf.scene);

    // Inflar entidades si es necesario
    if (this.data.inflate) {
      this.inflateEntities(gltf);
    }

    // Aplicar componentes de Hubs
    this.applyHubsComponents(gltf);
  },

  async loadModel(url) {
    // Verificar cache
    if (this.data.useCache && this.gltfCache.has(url)) {
      return this.gltfCache.get(url).clone();
    }

    // Cargar con Three.js GLTFLoader
    const loader = new THREE.GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    });

    // Guardar en cache
    if (this.data.useCache) {
      this.gltfCache.set(url, gltf);
    }

    return gltf;
  }
});
```

#### 2. `avatar-utils.js` - Utilidades Principales

```javascript
import { fetchReticulumAuthenticated } from "./phoenix-utils";
import { proxiedUrlFor } from "./media-url-utils";

const AVATARS_API = "/api/v1/avatars";
export const MAT_NAME = "Bot_PBS"; // Material estándar requerido

// Tipos de avatares
export const AVATAR_TYPES = {
  SKINNABLE: "skinnable",
  URL: "url"
};

// Determinar tipo de avatar
export function getAvatarType(avatarId) {
  if (avatarId.startsWith("http")) return AVATAR_TYPES.URL;
  return AVATAR_TYPES.SKINNABLE;
}

// Fetch de avatar desde API o URL
export async function fetchAvatar(avatarId) {
  switch (getAvatarType(avatarId)) {
    case AVATAR_TYPES.SKINNABLE:
      const resp = await fetchReticulumAuthenticated(
        `/api/v1/avatars/${avatarId}`
      );
      return resp && resp.avatars && resp.avatars[0];

    case AVATAR_TYPES.URL:
      return {
        avatar_id: avatarId,
        gltf_url: proxiedUrlFor(avatarId)
      };
  }
}

// Obtener URL de GLB del avatar
export function getAvatarSrc(avatarId) {
  switch (getAvatarType(avatarId)) {
    case AVATAR_TYPES.SKINNABLE:
      return fetchAvatar(avatarId).then(avatar => avatar.gltf_url);
    case AVATAR_TYPES.URL:
      return proxiedUrlFor(avatarId);
    default:
      return avatarId;
  }
}

// Asegurar que el avatar tenga material editable
export function ensureAvatarMaterial(gltf) {
  // Si ya tiene el material Bot_PBS, retornar
  if (gltf.materials.find(m => m.name === MAT_NAME)) {
    return gltf;
  }

  // Buscar primer material en los meshes y renombrarlo
  function findMaterialInMesh(mesh) {
    if (!mesh.primitives) return;
    const primitive = mesh.primitives.find(p => p.material !== undefined);
    return primitive && gltf.materials[primitive.material];
  }

  let nodes = gltf.scenes[gltf.scene].nodes.slice(0);
  while (nodes.length) {
    const node = gltf.nodes[nodes.shift()];
    const material = node.mesh !== undefined &&
                     findMaterialInMesh(gltf.meshes[node.mesh]);

    if (material) {
      material.name = MAT_NAME;
      break;
    }

    if (node.children) {
      nodes = nodes.concat(node.children);
    }
  }

  return gltf;
}

// Remixear/copiar avatar
export async function remixAvatar(parentId, name) {
  const avatar = {
    parent_avatar_listing_id: parentId,
    name: name,
    files: {}
  };

  return fetchReticulumAuthenticated(AVATARS_API, "POST", { avatar });
}
```

#### 3. `networked-avatar.js` - Sincronización en Red

```javascript
/**
 * Almacena estado de avatar sincronizado en red
 * @namespace avatar
 * @component networked-avatar
 */
AFRAME.registerComponent("networked-avatar", {
  schema: {
    left_hand_pose: { default: 0 },    // Índice de pose (0-7)
    right_hand_pose: { default: 0 }    // Índice de pose (0-7)
  },

  init() {
    this.networkedEl = this.el;
  },

  update() {
    // El estado se sincroniza automáticamente via NAF
    // (Networked A-Frame)
  }
});
```

#### 4. `hand-poses.js` - Sistema de Poses de Manos

```javascript
const POSES = {
  open: "allOpen",
  thumbDown: "thumbDown",
  indexDown: "indexDown",
  mrpDown: "mrpDown",
  thumbUp: "thumbsUp",
  point: "point",
  fist: "allGrip",
  pinch: "pinch"
};

const NETWORK_POSES = [
  "allOpen", "thumbDown", "indexDown", "mrpDown",
  "thumbsUp", "point", "allGrip", "pinch"
];

AFRAME.registerComponent("hand-pose", {
  multiple: true,

  init() {
    this.pose = 0;
    this.animatePose = this.animatePose.bind(this);

    // Obtener mixer de animaciones
    const mixerEl = findAncestorWithComponent(this.el, "animation-mixer");
    const suffix = this.id == "left" ? "_L" : "_R";
    this.mixer = mixerEl && mixerEl.components["animation-mixer"].mixer;

    if (!this.mixer || !this.mixer.clipAction(POSES.open + suffix)) {
      console.warn("Avatar no tiene animación 'allOpen'");
      this.el.removeAttribute("hand-pose");
      return;
    }

    this.from = this.to = this.mixer.clipAction(POSES.open + suffix);
    this.from.play();
    this.networkField = `${this.id}_hand_pose`;

    // Obtener componente networked-avatar
    this.networkedAvatar = this.getNetworkedAvatar();
  },

  tick() {
    if (!this.networkedAvatar ||
        !this.networkedAvatar.data ||
        this.networkedAvatar.data[this.networkField] === this.pose) {
      return;
    }

    // Animar transición entre poses
    this.animatePose(
      NETWORK_POSES[this.pose],
      NETWORK_POSES[this.networkedAvatar.data[this.networkField]]
    );

    this.pose = this.networkedAvatar.data[this.networkField];
  },

  animatePose(prevPose, currPose) {
    const duration = 0.065; // 65ms transición
    const suffix = this.id == "left" ? "_L" : "_R";

    if (this.from) this.from.stop();
    if (this.to) this.to.stop();

    this.from = this.mixer.clipAction(prevPose + suffix);
    this.to = this.mixer.clipAction(currPose + suffix);

    if (this.from) {
      this.from.setLoop(THREE.LoopOnce, -1);
      this.from.clampWhenFinished = true;
      this.from.fadeOut(duration);
      this.from.play();
    }

    if (this.to) {
      this.to.setLoop(THREE.LoopOnce, -1);
      this.to.clampWhenFinished = true;
      this.to.fadeIn(duration);
      this.to.play();
    }

    this.mixer.update(0.001);
  },

  getNetworkedAvatar() {
    let el = this.el;
    while (el) {
      const networkedAvatar = el.components &&
                              el.components["networked-avatar"];
      if (networkedAvatar) return networkedAvatar;
      el = el.parentEl;
    }
    return null;
  }
});
```

#### 5. `avatar-preview.js` - Preview React Component

```javascript
import React, { Component } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { ensureAvatarMaterial, MAT_NAME } from "../utils/avatar-utils";

class AvatarPreview extends Component {
  static propTypes = {
    avatarGltfUrl: PropTypes.string,
    className: PropTypes.string,
    onGltfLoaded: PropTypes.func
  };

  componentDidMount() {
    this.initThreeScene();
    if (this.props.avatarGltfUrl) {
      this.loadAvatar(this.props.avatarGltfUrl);
    }
  }

  componentDidUpdate(prevProps) {
    if (this.props.avatarGltfUrl !== prevProps.avatarGltfUrl) {
      this.loadAvatar(this.props.avatarGltfUrl);
    }
  }

  initThreeScene() {
    const canvas = this.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf0f0f0);

    // Camera
    this.camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 1000);
    this.camera.position.set(0, 1.5, 2);
    this.camera.lookAt(0, 1, 0);

    // Renderer (WebGL2)
    const context = canvas.getContext("webgl2", {
      alpha: false,
      depth: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "default"
    });

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context,
      antialias: true
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.physicallyCorrectLights = true;

    // Controls
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 1, 0);
    this.controls.update();

    // Lights
    const directionalLight = new THREE.DirectionalLight(0xf7f6ef, 1);
    directionalLight.position.set(0, 10, 10);
    this.scene.add(directionalLight);

    const hemisphereLight = new THREE.HemisphereLight(0xb1e3ff, 0xb1e3ff, 2.5);
    this.scene.add(hemisphereLight);

    // Animation loop
    const clock = new THREE.Clock();
    const animate = () => {
      const delta = clock.getDelta();

      if (this.mixer) {
        this.mixer.update(delta);
      }

      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(animate);
    };
    animate();
  }

  async loadAvatar(avatarGltfUrl) {
    this.setState({ loading: true, error: false });

    try {
      // Cargar GLTF
      const loader = new GLTFLoader();
      const gltf = await new Promise((resolve, reject) => {
        loader.load(avatarGltfUrl, resolve, undefined, reject);
      });

      // Asegurar material Bot_PBS
      ensureAvatarMaterial(gltf);

      // Limpiar avatar anterior
      if (this.avatarGroup) {
        this.scene.remove(this.avatarGroup);
      }

      // Agregar nuevo avatar
      this.avatarGroup = gltf.scene;
      this.scene.add(this.avatarGroup);

      // Buscar mesh principal
      this.previewMesh = this.findNode(
        gltf.scene,
        n => (n.isMesh && n.material && n.material.name === MAT_NAME) ||
             n.name === "Bot_Skinned"
      );

      // Configurar animaciones idle
      const idleAnimation = gltf.animations &&
                            gltf.animations.find(({ name }) => name === "idle_eyes");

      if (idleAnimation) {
        this.mixer = new THREE.AnimationMixer(gltf.scene);
        const action = this.mixer.clipAction(idleAnimation);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.play();
      }

      this.setState({ loading: false });

      if (this.props.onGltfLoaded) {
        this.props.onGltfLoaded(gltf);
      }
    } catch (error) {
      console.error("Error loading avatar:", error);
      this.setState({ loading: false, error: true });
    }
  }

  findNode(root, predicate) {
    let result = null;
    root.traverse(node => {
      if (!result && predicate(node)) {
        result = node;
      }
    });
    return result;
  }

  render() {
    return (
      <div className={this.props.className}>
        <canvas ref={c => this.canvas = c} />
        {this.state.loading && <div>Cargando avatar...</div>}
        {this.state.error && <div>Error al cargar avatar</div>}
      </div>
    );
  }
}

export default AvatarPreview;
```

### Especificaciones Técnicas del Avatar

#### Formato GLB Esperado

```
Avatar.glb
├── Scene
│   └── AvatarRoot (Node)
│       ├── Armature/Skeleton
│       │   ├── Hips
│       │   ├── Spine
│       │   ├── Head
│       │   ├── LeftArm → LeftHand
│       │   └── RightArm → RightHand
│       │
│       └── Meshes
│           ├── Body_Mesh
│           ├── Head_Mesh
│           └── Hands_Mesh
│
├── Materials
│   └── Bot_PBS (PBR Material)
│       ├── baseColorTexture (1024x1024)
│       ├── normalTexture (1024x1024)
│       ├── occlusionRoughnessMetallicTexture (ORM, 1024x1024)
│       └── emissiveTexture (opcional)
│
└── Animations (opcional)
    ├── idle_eyes
    ├── allOpen_L / allOpen_R
    ├── point_L / point_R
    └── [otras poses...]
```

#### Requisitos del Rigging

**Nombres de Huesos Requeridos:**
```
Hips
Spine
Chest (opcional)
Neck
Head
LeftShoulder → LeftUpperArm → LeftLowerArm → LeftHand
RightShoulder → RightUpperArm → RightLowerArm → RightHand
LeftUpperLeg → LeftLowerLeg → LeftFoot
RightUpperLeg → RightLowerLeg → RightFoot
```

**Poses de Manos (8 animaciones):**
1. `allOpen_L` / `allOpen_R` - Mano abierta
2. `thumbDown_L` / `thumbDown_R` - Pulgar abajo
3. `indexDown_L` / `indexDown_R` - Índice abajo
4. `mrpDown_L` / `mrpDown_R` - Medio, anular, meñique abajo
5. `thumbsUp_L` / `thumbsUp_R` - Pulgar arriba
6. `point_L` / `point_R` - Apuntar
7. `allGrip_L` / `allGrip_R` - Puño cerrado
8. `pinch_L` / `pinch_R` - Pinza

---

## Implementación de ReadyPlayer.me

### Contexto

ReadyPlayer.me es un sistema de avatares similar a Avaturn que **ya está parcialmente integrado** en Mozilla Hubs. La comunidad ha documentado varios issues y soluciones que son directamente aplicables a Avaturn.

### Repositorios y Issues Relevantes

| Recurso | URL | Estado |
|---------|-----|--------|
| **Issue #5964** | [Half-Body Avatars Problems](https://github.com/mozilla/hubs/issues/5964) | 🔴 Abierto |
| **Issue #4847** | [Speaking Indicators](https://github.com/mozilla/hubs/issues/4847) | ✅ Cerrado |
| **Issue #5532** | [Third-person View](https://github.com/mozilla/hubs/issues/5532) | 🔴 Abierto |
| **Discussion #3203** | [Full-body Avatars](https://github.com/mozilla/hubs/discussions/3203) | 💬 Activo |
| **PR #1658** | [Avatar Remixing](https://github.com/mozilla/hubs/pull/1658/files) | ✅ Merged |

### Arquitectura de Integración ReadyPlayer.me

```javascript
// Patrón básico usado en Hubs para avatares externos
class ExternalAvatarLoader {
  constructor(scene) {
    this.scene = scene;
    this.loader = new THREE.GLTFLoader();
  }

  async load(avatarUrl) {
    try {
      const gltf = await new Promise((resolve, reject) => {
        this.loader.load(avatarUrl, resolve, undefined, reject);
      });

      // Filtrar animaciones problemáticas
      this.filterAnimations(gltf);

      // Agregar a escena
      this.scene.add(gltf.scene);

      return gltf;
    } catch (error) {
      console.error("Error loading external avatar:", error);
      throw error;
    }
  }

  filterAnimations(gltf) {
    // CRÍTICO: Filtrar VectorKeyframeTracks que causan problemas
    gltf.animations.forEach(clip => {
      // Solo mantener QuaternionKeyframeTracks (rotación)
      const quaternionTracks = clip.tracks.filter(track =>
        track instanceof THREE.QuaternionKeyframeTrack
      );

      // Filtrar tracks de manos que causan parpadeo a T-Pose
      const filteredTracks = quaternionTracks.filter(track => {
        return !track.name.includes('Hand');
      });

      clip.tracks = filteredTracks;
    });
  }
}
```

### Problemas Conocidos y Soluciones

#### Problema 1: Mesh Holes y T-Pose Flashing

**Síntoma:**
- Avatares muestran "agujeros" en las manos
- Animaciones parpadean volviendo a T-Pose
- Ocurre con avatares creados después de enero 2023

**Causa:**
Los avatares nuevos de ReadyPlayer.me incluyen `VectorKeyframeTracks` (posición y escala) además de `QuaternionKeyframeTracks` (rotación). El sistema de animaciones de Hubs no los maneja correctamente.

**Solución:**

```javascript
// En animation-mixer.js o custom loader
function fixReadyPlayerMeAnimations(gltf) {
  gltf.animations.forEach(clip => {
    // 1. Filtrar solo tracks de cuaternión
    const quaternionTracks = clip.tracks.filter(track =>
      track instanceof THREE.QuaternionKeyframeTrack
    );

    // 2. Remover tracks de manos problemáticos
    const cleanTracks = quaternionTracks.filter(track => {
      const trackName = track.name.toLowerCase();
      return !trackName.includes('hand') &&
             !trackName.includes('finger') &&
             !trackName.includes('thumb');
    });

    clip.tracks = cleanTracks;
  });

  return gltf;
}
```

#### Problema 2: Audio Feedback (Speaking Indicators)

**Síntoma:**
Difícil identificar quién habla en VR

**Solución Existente:**
Hubs ya tiene componentes `scale-audio-feedback` y `morph-audio-feedback`.

**Implementación en Blender:**

```javascript
// Agregar componente a nodo Head en Blender
{
  "name": "scale-audio-feedback",
  "props": {
    "minScale": 1.0,
    "maxScale": 1.5
  }
}

// Para morph targets (Shape Keys)
{
  "name": "morph-audio-feedback",
  "props": {
    "morphTarget": "mouthOpen"
  }
}
```

**Código del Componente:**

```javascript
// scale-audio-feedback.js
AFRAME.registerComponent("scale-audio-feedback", {
  schema: {
    minScale: { default: 1.0 },
    maxScale: { default: 1.5 }
  },

  init() {
    this.originalScale = this.el.object3D.scale.clone();
    this.targetScale = new THREE.Vector3();
  },

  tick() {
    // Obtener nivel de audio del networked-avatar
    const networkedAvatar = this.el.closest("[networked-avatar]");
    if (!networkedAvatar) return;

    const audioSource = networkedAvatar.components["avatar-audio-source"];
    if (!audioSource) return;

    const volume = audioSource.volume || 0;

    // Escalar basado en volumen
    const scaleFactor = THREE.MathUtils.lerp(
      this.data.minScale,
      this.data.maxScale,
      volume
    );

    this.targetScale.copy(this.originalScale).multiplyScalar(scaleFactor);
    this.el.object3D.scale.lerp(this.targetScale, 0.3);
  }
});
```

#### Problema 3: Full-Body vs Half-Body

**Estado Actual:**
- **Half-body:** Soportado (cabeza, torso, manos)
- **Full-body:** NO soportado oficialmente

**Workaround:**
Usar avatares half-body de ReadyPlayer.me diseñados específicamente para Hubs.

**Formato Esperado:**
```
Half-body avatar (VR ready)
├── Head + Neck
├── Torso + Arms
└── Hands
```

### Integración vía URL Parameters

ReadyPlayer.me y otros avatares externos pueden cargarse mediante URL:

```
https://hubs.mozilla.com/room-id?
  avatarUrl=https://models.readyplayer.me/[avatar-id].glb&
  displayName=UserName
```

**Implementación en Hubs:**

```javascript
// room.js - Parsing de URL parameters
const urlParams = new URLSearchParams(window.location.search);
const avatarUrl = urlParams.get('avatarUrl');
const displayName = urlParams.get('displayName');

if (avatarUrl) {
  // Validar URL
  if (!avatarUrl.startsWith('https://')) {
    console.error("Avatar URL must be HTTPS");
  } else {
    // Cargar avatar
    await loadExternalAvatar(avatarUrl);

    // Configurar perfil
    store.update({
      profile: {
        avatarId: avatarUrl,
        displayName: displayName || "Guest"
      }
    });
  }
}
```

### Checklist de Compatibilidad ReadyPlayer.me

✅ **Compatible:**
- Avatares half-body (cabeza + torso + manos)
- Formato GLB
- ARKit blendshapes
- Texturas PBR estándar
- Esqueleto humanoid rig

❌ **Incompatible / Problemas:**
- Full-body avatares
- VectorKeyframeTracks sin filtrar
- Avatares sin material PBR
- Animaciones de dedos complejas

---

## Sistema BELIVVR XRcloud

### Contexto

**BELIVVR XRcloud** es un fork completo de Mozilla Hubs con mejoras significativas en el sistema de avatares, incluido soporte full-body y features avanzados.

### Repositorio

- **URL:** https://github.com/luke-n-alpha/XRcloud
- **Estado:** Open-source (liberado feb 2025)
- **Licencia:** Apache License 2.0
- **Contacto:** luke.yang@cafelua.com

### Características Destacadas

1. **Full-body Avatar Support**
   - Editor de avatares full-body open-source
   - No usa Bit-ECS (limitaciones de compatibilidad)

2. **Avatar Change via URL**
   - Cambio dinámico de avatar mediante query params
   - Fast entry mode (sin modales)

3. **Inline Frame Component (Spoke)**
   - Componente personalizado para cambios de avatar
   - Triggers por proximidad
   - Integración con componentes espejo

4. **Jump Feature**
   - Salto en desktop (tecla "J")
   - No funciona con avatares full-body

5. **Third-person Free View**
   - Vista en tercera persona con cámara libre

### Arquitectura XRcloud

```
XRcloud/
├── hubs-all-in-one/         # Fork de Hubs Foundation
│   ├── hubs/                # Cliente principal
│   ├── spoke/               # Editor de escenas
│   ├── reticulum/           # Backend
│   └── dialog/              # Sistema de diálogos
│
├── xrcloud-backend/         # Backend custom
├── xrcloud-frontend/        # Frontend custom
├── xrcloud-nginx/           # Config de Nginx
└── xrcloud-avatar-editor/   # Editor full-body
```

### Código: Avatar via URL Parameters

```javascript
// RoomEntryModal.js - XRcloud
const urlParams = new URLSearchParams(location.search);
const avatarUrl = urlParams.get("avatarUrl");
const displayName = urlParams.get("displayName");
const funcs = urlParams.get("funcs")?.split(",") || [];

const isFastEntry = funcs.includes("fastEntry");
const isGhost = funcs.includes("ghost");

if (isGhost) {
  // Modo espectador (sin avatar)
  onSpectate();
} else if (isFastEntry) {
  // Entrada rápida sin modales
  if (avatarUrl) {
    await loadAvatarFromUrl(avatarUrl);
  }
  onJoinRoom();
} else {
  // Flujo normal
  showEntryModal();
}

async function loadAvatarFromUrl(url) {
  try {
    const avatar = await fetchAvatar(url);
    store.update({
      profile: {
        avatarId: url,
        displayName: displayName || "Guest"
      }
    });
  } catch (error) {
    console.error("Error loading avatar from URL:", error);
    // Usar avatar por defecto
  }
}
```

**Ejemplo de URL:**

```
https://room.xrcloud.app:4000/qkoCp3x/test2?
  public=04f740f3-b96f-43da-90da-5c99d64e2364&
  avatarUrl=https://example.com/avatar.glb&
  displayName=MyName&
  funcs=fastEntry
```

### Avatar Utils - XRcloud Version

```javascript
// avatar-utils.js - XRcloud enhancements
export const AVATAR_TYPES = {
  SKINNABLE: "skinnable",
  URL: "url",
  FULLBODY: "fullbody"  // Nuevo tipo
};

export function getAvatarType(avatarId) {
  if (avatarId.startsWith("http")) {
    // Detectar si es full-body por naming convention
    if (avatarId.includes("fullbody") || avatarId.includes("fb_")) {
      return AVATAR_TYPES.FULLBODY;
    }
    return AVATAR_TYPES.URL;
  }
  return AVATAR_TYPES.SKINNABLE;
}

export async function fetchAvatar(avatarId) {
  const type = getAvatarType(avatarId);

  switch (type) {
    case AVATAR_TYPES.SKINNABLE:
      return fetchSkinnableAvatar(avatarId);

    case AVATAR_TYPES.FULLBODY:
      return {
        avatar_id: avatarId,
        gltf_url: proxiedUrlFor(avatarId),
        type: "fullbody"
      };

    case AVATAR_TYPES.URL:
      return {
        avatar_id: avatarId,
        gltf_url: proxiedUrlFor(avatarId)
      };
  }
}
```

### Character Controller - Jump Feature

```javascript
// character-controller-system.js - XRcloud
export class CharacterControllerSystem {
  constructor(scene) {
    this.scene = scene;
    this.fly = false;
    this.relativeMotion = new THREE.Vector3(0, 0, 0);

    // Jump system
    this.isJumping = false;
    this.jumpVelocity = new THREE.Vector3(0, 0, 0);
    this.groundThreshold = 0.1;
    this.jumpPower = 5.0;
    this.gravity = -9.8;
  }

  tick(deltaTime) {
    // Detectar input de salto (tecla J)
    if (this.jumpKeyPressed && this.isOnGround()) {
      this.jump();
    }

    // Aplicar gravedad y física de salto
    if (this.isJumping) {
      this.jumpVelocity.y += this.gravity * deltaTime;
      this.relativeMotion.y = this.jumpVelocity.y * deltaTime;

      // Verificar si tocó el suelo
      if (this.checkGroundCollision()) {
        this.isJumping = false;
        this.jumpVelocity.set(0, 0, 0);
        this.snapToGround();
      }
    }

    // Aplicar movimiento
    this.applyMovement(this.relativeMotion);
  }

  jump() {
    if (this.avatarType === "fullbody") {
      console.warn("Jump not supported for full-body avatars");
      return;
    }

    this.isJumping = true;
    this.jumpVelocity.y = this.jumpPower;
  }

  isOnGround() {
    // Raycast hacia abajo
    const raycaster = new THREE.Raycaster(
      this.avatar.position,
      new THREE.Vector3(0, -1, 0),
      0,
      this.groundThreshold
    );

    const intersects = raycaster.intersectObjects(
      this.scene.children,
      true
    );

    return intersects.length > 0;
  }
}
```

### Inline Frame Component (Spoke)

El componente "inline-frame" de XRcloud permite:
- Portales a otras rooms
- Cambio de avatar al atravesar
- Triggers por proximidad

```javascript
// inline-frame.js - Spoke component
AFRAME.registerComponent("inline-frame", {
  schema: {
    src: { type: "string" },              // URL destino
    avatarUrl: { type: "string" },        // Avatar a usar
    trigger: { default: "proximity" },    // "proximity" | "click"
    distance: { default: 2.0 }            // Distancia activación
  },

  init() {
    this.onEnter = this.onEnter.bind(this);
    this.onExit = this.onExit.bind(this);
  },

  tick() {
    if (this.data.trigger !== "proximity") return;

    const playerPos = this.getPlayerPosition();
    const framePos = this.el.object3D.position;
    const distance = playerPos.distanceTo(framePos);

    if (distance < this.data.distance && !this.isInside) {
      this.onEnter();
    } else if (distance >= this.data.distance && this.isInside) {
      this.onExit();
    }
  },

  async onEnter() {
    this.isInside = true;

    // Cambiar avatar si especificado
    if (this.data.avatarUrl) {
      await this.changeAvatar(this.data.avatarUrl);
    }

    // Navegar a destino
    if (this.data.src) {
      window.location.href = this.data.src;
    }
  },

  onExit() {
    this.isInside = false;
  },

  async changeAvatar(avatarUrl) {
    const avatar = await fetchAvatar(avatarUrl);
    const store = window.APP.store;

    store.update({
      profile: {
        avatarId: avatarUrl
      }
    });

    // Reload avatar
    const avatarRig = document.querySelector("#avatar-rig");
    if (avatarRig) {
      avatarRig.setAttribute("player-info", {
        avatarSrc: avatarUrl
      });
    }
  },

  getPlayerPosition() {
    const avatarRig = document.querySelector("#avatar-rig");
    return avatarRig ? avatarRig.object3D.position : new THREE.Vector3();
  }
});
```

### Lecciones Aprendidas de XRcloud

1. **URL Parameters son poderosos** para configuración dinámica
2. **Fast entry mejora UX** eliminando modales innecesarios
3. **Full-body requiere system rewrite** - no compatible con Bit-ECS
4. **Inline frames permiten experiencias fluidas** tipo metaverso
5. **Jump feature es simple** pero incompatible con full-body

---

## Avaturn: Documentación y Modo Gratuito

### Información General

**Avaturn** es una plataforma de creación de avatares 3D fotorrealistas similar a ReadyPlayer.me pero con características distintas.

### Recursos Oficiales

| Recurso | URL |
|---------|-----|
| **Documentación** | https://docs.avaturn.me |
| **SDK NPM** | https://www.npmjs.com/package/@avaturn/sdk |
| **SDK Docs** | https://sdk-docs.avaturn.me |
| **Developer Portal** | https://developer.avaturn.me |
| **GitHub** | https://github.com/avaturn |
| **Discord** | https://discord.com/invite/FfavuatXrz |

### Modo Gratuito: iFrame Integration

La forma MÁS SIMPLE de usar Avaturn sin API ni costos:

#### Paso 1: Registrar Subdomain (Gratuito)

1. Ir a https://developer.avaturn.me
2. Crear cuenta gratuita
3. Obtener subdomain: `tu-app.avaturn.dev`
4. (O usar `demo.avaturn.dev` para testing)

#### Paso 2: HTML Básico con iFrame

```html
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Avaturn Avatar Creator</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; height: 100vh; }

        .container {
            display: flex;
            height: 100%;
        }

        #avaturn-frame {
            flex: 1;
            border: none;
        }

        #result-panel {
            flex: 1;
            background: #f5f5f5;
            padding: 20px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
        }

        .info-box {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            max-width: 400px;
            width: 100%;
        }

        .info-box h2 {
            margin-bottom: 15px;
            color: #333;
        }

        .info-box p {
            margin: 8px 0;
            color: #666;
        }

        .download-btn {
            margin-top: 15px;
            padding: 12px 24px;
            background: #4CAF50;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
            width: 100%;
        }

        .download-btn:hover {
            background: #45a049;
        }

        .download-btn:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- iFrame de Avaturn -->
        <iframe
            id="avaturn-frame"
            src="https://demo.avaturn.dev/"
            allow="microphone; camera"
        ></iframe>

        <!-- Panel de resultados -->
        <div id="result-panel">
            <div class="info-box">
                <h2>Avatar Creator</h2>
                <p id="status">Esperando creación de avatar...</p>
                <div id="avatar-info" style="display:none;">
                    <p><strong>Avatar ID:</strong> <span id="avatar-id"></span></p>
                    <p><strong>Body Type:</strong> <span id="body-id"></span></p>
                    <p><strong>Animación facial:</strong> <span id="face-anim"></span></p>
                </div>
                <button
                    class="download-btn"
                    id="download-btn"
                    disabled
                >
                    Descargar Avatar GLB
                </button>
                <button
                    class="download-btn"
                    id="use-btn"
                    disabled
                    style="margin-top: 10px; background: #2196F3;"
                >
                    Usar en Hubs
                </button>
            </div>
        </div>
    </div>

    <script>
        let currentAvatarData = null;

        // Escuchar mensajes del iFrame de Avaturn
        window.addEventListener('message', (event) => {
            // Validar origen
            if (!event.origin.includes('avaturn.dev')) {
                return;
            }

            console.log('Mensaje recibido:', event.data);

            // Avatar exportado
            if (event.data && event.data.type === 'avatarExport') {
                currentAvatarData = event.data;
                handleAvatarExport(event.data);
            }
        });

        function handleAvatarExport(data) {
            console.log('Avatar exportado:', data);

            // Actualizar UI
            document.getElementById('status').textContent =
                '✓ Avatar creado exitosamente';

            document.getElementById('avatar-info').style.display = 'block';
            document.getElementById('avatar-id').textContent =
                data.avatarId || 'N/A';
            document.getElementById('body-id').textContent =
                data.bodyId || 'N/A';
            document.getElementById('face-anim').textContent =
                data.avatarSupportsFaceAnimations ? 'Sí' : 'No';

            // Habilitar botones
            document.getElementById('download-btn').disabled = false;
            document.getElementById('use-btn').disabled = false;
        }

        // Descargar GLB
        document.getElementById('download-btn').addEventListener('click', () => {
            if (!currentAvatarData || !currentAvatarData.url) {
                alert('No hay avatar para descargar');
                return;
            }

            const link = document.createElement('a');
            link.href = currentAvatarData.url;
            link.download = 'avatar.glb';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });

        // Usar en Hubs
        document.getElementById('use-btn').addEventListener('click', () => {
            if (!currentAvatarData || !currentAvatarData.url) {
                alert('No hay avatar disponible');
                return;
            }

            // Opción 1: Redirigir a Hubs con avatar
            const hubsUrl = 'https://hubs.mozilla.com/spoke/new';
            const avatarParam = encodeURIComponent(currentAvatarData.url);
            window.open(`${hubsUrl}?avatarUrl=${avatarParam}`, '_blank');

            // Opción 2: Guardar en localStorage para uso posterior
            localStorage.setItem('customAvatarUrl', currentAvatarData.url);
            alert('Avatar guardado. Usa la URL: ' + currentAvatarData.url);
        });
    </script>
</body>
</html>
```

### SDK Integration (Alternativa)

Si prefieres más control:

```bash
npm install @avaturn/sdk
```

```javascript
import AvaturnSDK from "@avaturn/sdk";

const container = document.getElementById("avaturn-container");
const sdk = new AvaturnSDK();

// Tu subdomain registrado
const subdomain = "tu-app"; // o "demo" para testing

// Inicializar
sdk.init(container, {
    url: `https://${subdomain}.avaturn.dev/`
});

// Evento cuando avatar se exporta
sdk.on("export", (data) => {
    console.log("Avatar exportado:", data);
    console.log("URL del GLB:", data.url);
    console.log("Avatar ID:", data.avatarId);
    console.log("Body ID:", data.bodyId);
    console.log("Soporta facial animation:", data.avatarSupportsFaceAnimations);

    // Cargar en Three.js
    loadAvatarInThreeJS(data.url);
});

// Otros eventos
sdk.on("load", () => console.log("Editor cargado"));
sdk.on("assetSet", (asset) => console.log("Asset cambiado:", asset));
sdk.on("bodySet", (body) => console.log("Body cambiado:", body));

function loadAvatarInThreeJS(glbUrl) {
    const loader = new THREE.GLTFLoader();
    loader.load(glbUrl, (gltf) => {
        scene.add(gltf.scene);
        console.log("Avatar cargado en Three.js");
    });
}
```

### Estructura de Datos del Export

```javascript
{
    type: "avatarExport",
    url: "https://cdn.avaturn.dev/avatars/abc123.glb",  // o dataURL
    urlType: "httpURL" | "dataURL",
    avatarId: "abc123",
    sessionId: "sess_xyz456",
    bodyId: "body_v2024_male",    // o "body_v2024_female", "body_v2023_*"
    gender: "male" | "female",
    avatarSupportsFaceAnimations: true | false  // T1=false, T2=true
}
```

### Tipos de Avatar Avaturn

**T1 Avatars (Estático):**
- ✅ Caras estáticas y realistas
- ✅ Rendimiento ligero
- ❌ NO soporta animación facial
- ✅ Mejor realismo fotográfico

**T2 Avatars (Animable):**
- ✅ Ojos y boca separados
- ✅ Soporta ARKit blendshapes (51 shapes)
- ✅ Soporta Visemes para sincronización labial
- ⚠️ Menos realismo que T1
- ✅ Animaciones faciales

### Versiones de Body

**v2023 (Legacy):**
- Esqueletos únicos por tipo de body
- Variación esquelética significativa
- Limitaciones para animadores

**v2024 (Recomendado - Actual):**
- ✅ Esqueletos idénticos en todas las variantes
- ✅ Mejor para animadores
- ✅ Componentes consistentes (brazos, piernas, cabeza)
- ✅ Mejoras estéticas

### Especificaciones Técnicas GLB Avaturn

```
Avatar.glb (Avaturn Export)
├── Scene
│   └── Armature (Humanoid Rig)
│       ├── Hips
│       ├── Spine → Spine1 → Spine2
│       ├── Neck → Head
│       ├── LeftShoulder → LeftArm → LeftForeArm → LeftHand
│       │   └── Finger bones (5 dedos × 3 falanges)
│       ├── RightShoulder → RightArm → RightForeArm → RightHand
│       │   └── Finger bones
│       ├── LeftUpLeg → LeftLeg → LeftFoot
│       └── RightUpLeg → RightLeg → RightFoot
│
├── Meshes
│   ├── Body (skinned mesh)
│   ├── Eyes_L / Eyes_R (T2 avatars)
│   └── Teeth (T2 avatars)
│
├── Materials (PBR)
│   ├── Body_Material
│   │   ├── baseColorTexture (4K-8K)
│   │   ├── normalTexture
│   │   ├── roughnessTexture
│   │   ├── metallicTexture
│   │   └── occlusionTexture
│   └── [otros materiales...]
│
├── Blendshapes (T2 only)
│   ├── ARKit Standard (51 shapes)
│   │   ├── eyeBlinkLeft / eyeBlinkRight
│   │   ├── jawOpen
│   │   ├── mouthSmile_L / mouthSmile_R
│   │   └── [48 más...]
│   └── Visemes (phoneme shapes)
│       ├── viseme_aa
│       ├── viseme_E
│       ├── viseme_I
│       └── [más...]
│
└── Metadata
    ├── generator: "Avaturn"
    ├── version: "2.0"
    └── extras: { bodyType, gender, etc. }
```

### Requisitos Técnicos

**Vértices:** ~50,000 - 100,000 (variable según body)
**Texturas:** 4K - 8K (PBR completo)
**Rigging:** 60+ bones (humanoid rig estándar)
**Blendshapes:** 51 ARKit standard (T2)
**Visemes:** Standard phoneme visemes (T2)
**Formato:** GLB (GLTF 2.0 binary)

### Plan Gratuito - Características

✅ **SÍ Incluido (GRATIS):**
- Avatares ilimitados creados
- Exportaciones ilimitadas en GLB
- 150+ prendas HD y peinados
- Customización completa (body, ropa, accesorios)
- iFrame embedding básico
- Subdomain gratuito (tu-app.avaturn.dev)
- Subdomain demo para testing
- Acceso a comunidad Discord
- Ejemplos de código en GitHub

❌ **NO Incluido (Requiere Plan PRO $800/mes):**
- API REST access
- Web SDK avanzado con full control UI/UX
- Branding customizado (logos y colores)
- Gestión independiente de usuarios
- Carga de prendas customizadas propias
- Soporte prioritario por email
- Más de 1,000 avatares/mes

### Ejemplos de Repositorios

| Repositorio | Descripción | URL |
|------------|-------------|-----|
| **web-sdk-example** | Ejemplo básico del SDK | https://github.com/avaturn/web-sdk-example |
| **threejs-example** | Integración Three.js | https://github.com/avaturn/avaturn-threejs-example |
| **unity-examples** | Unity WebGL y Mobile | https://github.com/avaturn/avaturn-unity-examples |

### Conversiones de Formato

Avaturn soporta conversión a otros formatos:

```
GLB (nativo)
  ↓
  ├─→ VRM (para VTubing)
  ├─→ FBX (para Unity/Unreal)
  └─→ Compatible Mixamo (animaciones)
```

---

## Estrategia de Implementación de Avaturn en Hubs

### Resumen de Opciones

Tenemos **3 opciones principales** para integrar Avaturn en Hubs:

| Opción | Complejidad | Ventajas | Desventajas |
|--------|-------------|----------|-------------|
| **A. URL Parameters** | 🟢 Baja | Rápido, sin modificar código | Requiere hosting externo del GLB |
| **B. iFrame in Editor** | 🟡 Media | UI integrada, experiencia fluida | Requiere modificar avatar-editor.js |
| **C. SDK Full Integration** | 🔴 Alta | Control total, branding | Requiere API ($800/mes) |

### Recomendación: Opción B (iFrame in Editor)

**Razones:**
1. ✅ **Gratuito** - No requiere API de Avaturn
2. ✅ **Experiencia integrada** - Usuario no sale de Hubs
3. ✅ **Complejidad manejable** - Similar a ReadyPlayer.me
4. ✅ **Compatible** - Usa el mismo pipeline GLB existente

---

## Código Completo de Implementación

### Opción A: URL Parameters (Más Simple)

Esta opción permite usar avatares de Avaturn sin modificar código de Hubs.

#### Paso 1: Crear Avatar en Avaturn

1. Ir a https://demo.avaturn.dev/ (o tu subdomain)
2. Crear avatar personalizado
3. Exportar y obtener URL del GLB

#### Paso 2: Usar Avatar en Hubs

```
https://hubs.mozilla.com/room-id?
  avatarUrl=https://cdn.avaturn.dev/avatars/tu-avatar-id.glb&
  displayName=TuNombre
```

#### Código en Hubs (Ya Existente)

El código para soportar esto **ya existe** en Hubs:

```javascript
// room.js - URL parameter handling
const urlParams = new URLSearchParams(window.location.search);
const avatarUrl = urlParams.get('avatarUrl');

if (avatarUrl && avatarUrl.startsWith('https://')) {
  await loadExternalAvatar(avatarUrl);
}
```

**Ventaja:** ✅ Sin modificaciones necesarias
**Desventaja:** ❌ Requiere URL público del GLB

---

### Opción B: iFrame in Editor (Recomendado)

Modificar el editor de avatares de Hubs para incluir Avaturn.

#### Archivos a Modificar

```
hubs/src/
├── react-components/
│   ├── avatar-editor.js          # MODIFICAR - Agregar tab Avaturn
│   └── avatar-preview.js         # Usar sin cambios
│
├── utils/
│   └── avatar-utils.js           # MODIFICAR - Agregar tipo AVATURN
│
└── assets/
    └── stylesheets/
        └── avatar-editor.scss    # MODIFICAR - Estilos del tab
```

#### 1. Modificar `avatar-utils.js`

```javascript
// utils/avatar-utils.js

// AGREGAR nuevo tipo
export const AVATAR_TYPES = {
  SKINNABLE: "skinnable",
  URL: "url",
  AVATURN: "avaturn"  // ← NUEVO
};

// MODIFICAR getAvatarType
export function getAvatarType(avatarId) {
  if (avatarId.startsWith("avaturn://")) {
    return AVATAR_TYPES.AVATURN;
  }
  if (avatarId.startsWith("http")) {
    return AVATAR_TYPES.URL;
  }
  return AVATAR_TYPES.SKINNABLE;
}

// MODIFICAR fetchAvatar
export async function fetchAvatar(avatarId) {
  switch (getAvatarType(avatarId)) {
    case AVATAR_TYPES.SKINNABLE:
      const resp = await fetchReticulumAuthenticated(
        `/api/v1/avatars/${avatarId}`
      );
      return resp && resp.avatars && resp.avatars[0];

    case AVATAR_TYPES.AVATURN:
      // Extraer GLB URL del formato avaturn://
      const glbUrl = avatarId.replace("avaturn://", "");
      return {
        avatar_id: avatarId,
        gltf_url: proxiedUrlFor(glbUrl),
        type: "avaturn"
      };

    case AVATAR_TYPES.URL:
      return {
        avatar_id: avatarId,
        gltf_url: proxiedUrlFor(avatarId)
      };
  }
}

// AGREGAR función específica Avaturn
export async function createAvaturnAvatar(glbUrl, metadata = {}) {
  const avatarId = `avaturn://${glbUrl}`;

  return {
    avatar_id: avatarId,
    gltf_url: proxiedUrlFor(glbUrl),
    type: "avaturn",
    name: metadata.name || "Avaturn Avatar",
    attributions: {
      creator: "Avaturn",
      url: "https://avaturn.me"
    },
    files: {
      glb: glbUrl,
      thumbnail: metadata.thumbnail || null
    },
    metadata: {
      bodyId: metadata.bodyId,
      gender: metadata.gender,
      supportsFaceAnimations: metadata.avatarSupportsFaceAnimations
    }
  };
}
```

#### 2. Modificar `avatar-editor.js`

```javascript
// react-components/avatar-editor.js
import React, { Component } from "react";
import PropTypes from "prop-types";
import { FormattedMessage } from "react-intl";
import AvatarPreview from "./avatar-preview";
import { createAvaturnAvatar } from "../utils/avatar-utils";

class AvatarEditor extends Component {
  static propTypes = {
    avatarId: PropTypes.string,
    onSave: PropTypes.func,
    onClose: PropTypes.func
  };

  constructor(props) {
    super(props);
    this.state = {
      activeTab: "base",  // "base" | "url" | "avaturn"
      avaturnData: null,
      previewGltfUrl: null,
      saving: false
    };
  }

  componentDidMount() {
    // Setup postMessage listener para Avaturn
    window.addEventListener('message', this.handleAvaturnMessage);
  }

  componentWillUnmount() {
    window.removeEventListener('message', this.handleAvaturnMessage);
  }

  handleAvaturnMessage = (event) => {
    // Validar origen
    if (!event.origin.includes('avaturn.dev')) {
      return;
    }

    // Avatar exportado desde Avaturn
    if (event.data && event.data.type === 'avatarExport') {
      console.log('Avaturn avatar recibido:', event.data);

      this.setState({
        avaturnData: event.data,
        previewGltfUrl: event.data.url
      });
    }
  };

  handleSaveAvaturn = async () => {
    const { avaturnData } = this.state;

    if (!avaturnData || !avaturnData.url) {
      alert("No hay avatar de Avaturn para guardar");
      return;
    }

    this.setState({ saving: true });

    try {
      // Crear avatar usando el GLB de Avaturn
      const avatar = await createAvaturnAvatar(avaturnData.url, {
        bodyId: avaturnData.bodyId,
        gender: avaturnData.gender,
        avatarSupportsFaceAnimations: avaturnData.avatarSupportsFaceAnimations
      });

      // Guardar en store
      this.props.store.update({
        profile: {
          avatarId: avatar.avatar_id
        }
      });

      this.setState({ saving: false });

      // Callback
      if (this.props.onSave) {
        this.props.onSave(avatar);
      }
    } catch (error) {
      console.error("Error guardando avatar de Avaturn:", error);
      this.setState({ saving: false });
      alert("Error al guardar avatar");
    }
  };

  render() {
    const { activeTab, previewGltfUrl, saving, avaturnData } = this.state;

    return (
      <div className="avatar-editor">
        {/* Tabs */}
        <div className="avatar-editor__tabs">
          <button
            className={activeTab === "base" ? "active" : ""}
            onClick={() => this.setState({ activeTab: "base" })}
          >
            <FormattedMessage id="avatar-editor.base-tab"
                              defaultMessage="Base Avatars" />
          </button>

          <button
            className={activeTab === "url" ? "active" : ""}
            onClick={() => this.setState({ activeTab: "url" })}
          >
            <FormattedMessage id="avatar-editor.url-tab"
                              defaultMessage="From URL" />
          </button>

          {/* NUEVO TAB */}
          <button
            className={activeTab === "avaturn" ? "active" : ""}
            onClick={() => this.setState({ activeTab: "avaturn" })}
          >
            <FormattedMessage id="avatar-editor.avaturn-tab"
                              defaultMessage="Avaturn" />
          </button>
        </div>

        {/* Content */}
        <div className="avatar-editor__content">
          {/* Tab Base (existente) */}
          {activeTab === "base" && (
            <div className="avatar-editor__base">
              {/* Contenido existente de base avatars */}
            </div>
          )}

          {/* Tab URL (existente) */}
          {activeTab === "url" && (
            <div className="avatar-editor__url">
              {/* Contenido existente de URL input */}
            </div>
          )}

          {/* NUEVO TAB AVATURN */}
          {activeTab === "avaturn" && (
            <div className="avatar-editor__avaturn">
              <div className="avaturn-container">
                {/* iFrame de Avaturn */}
                <iframe
                  src="https://demo.avaturn.dev/"
                  className="avaturn-iframe"
                  allow="microphone; camera"
                  title="Avaturn Avatar Creator"
                />

                {/* Info panel */}
                <div className="avaturn-info">
                  <h3>
                    <FormattedMessage
                      id="avatar-editor.avaturn-title"
                      defaultMessage="Create Photorealistic Avatar"
                    />
                  </h3>

                  <p>
                    <FormattedMessage
                      id="avatar-editor.avaturn-description"
                      defaultMessage="Use Avaturn to create a photorealistic 3D avatar from a selfie."
                    />
                  </p>

                  {avaturnData && (
                    <div className="avaturn-data">
                      <p>✓ Avatar created successfully</p>
                      <p><strong>Body:</strong> {avaturnData.bodyId}</p>
                      <p><strong>Facial animation:</strong> {
                        avaturnData.avatarSupportsFaceAnimations ? "Yes" : "No"
                      }</p>
                    </div>
                  )}

                  <button
                    className="save-button"
                    onClick={this.handleSaveAvaturn}
                    disabled={!avaturnData || saving}
                  >
                    {saving ? (
                      <FormattedMessage
                        id="avatar-editor.saving"
                        defaultMessage="Saving..."
                      />
                    ) : (
                      <FormattedMessage
                        id="avatar-editor.save-avaturn"
                        defaultMessage="Use This Avatar"
                      />
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Preview */}
        <div className="avatar-editor__preview">
          <AvatarPreview
            avatarGltfUrl={previewGltfUrl}
            className="avatar-preview"
          />
        </div>

        {/* Footer buttons */}
        <div className="avatar-editor__footer">
          <button onClick={this.props.onClose}>
            <FormattedMessage id="avatar-editor.close" defaultMessage="Close" />
          </button>
        </div>
      </div>
    );
  }
}

export default AvatarEditor;
```

#### 3. Agregar Estilos `avatar-editor.scss`

```scss
// assets/stylesheets/avatar-editor.scss

.avatar-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #fff;

  &__tabs {
    display: flex;
    border-bottom: 1px solid #e0e0e0;
    background: #f5f5f5;

    button {
      flex: 1;
      padding: 15px;
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      color: #666;
      transition: all 0.2s;

      &:hover {
        background: #ececec;
      }

      &.active {
        background: #fff;
        color: #333;
        border-bottom: 2px solid #4CAF50;
      }
    }
  }

  &__content {
    flex: 1;
    overflow: auto;
    padding: 20px;
  }

  &__avaturn {
    height: 100%;
    display: flex;
    gap: 20px;

    .avaturn-container {
      flex: 1;
      display: flex;
      gap: 20px;
    }

    .avaturn-iframe {
      flex: 2;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      min-height: 600px;
    }

    .avaturn-info {
      flex: 1;
      background: #f9f9f9;
      padding: 20px;
      border-radius: 8px;
      display: flex;
      flex-direction: column;

      h3 {
        margin-bottom: 10px;
        color: #333;
        font-size: 18px;
      }

      p {
        margin-bottom: 15px;
        color: #666;
        font-size: 14px;
        line-height: 1.5;
      }

      .avaturn-data {
        margin-top: 20px;
        padding: 15px;
        background: #fff;
        border-radius: 4px;
        border-left: 3px solid #4CAF50;

        p {
          margin: 5px 0;
          font-size: 13px;
        }
      }

      .save-button {
        margin-top: auto;
        padding: 12px 24px;
        background: #4CAF50;
        color: white;
        border: none;
        border-radius: 4px;
        font-size: 16px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s;

        &:hover:not(:disabled) {
          background: #45a049;
        }

        &:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
      }
    }
  }

  &__preview {
    flex: 0 0 300px;
    border-left: 1px solid #e0e0e0;
    background: #f0f0f0;
  }

  &__footer {
    padding: 15px 20px;
    border-top: 1px solid #e0e0e0;
    display: flex;
    justify-content: flex-end;
    gap: 10px;

    button {
      padding: 10px 20px;
      border: 1px solid #ccc;
      background: white;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;

      &:hover {
        background: #f5f5f5;
      }
    }
  }
}
```

#### 4. Configurar Validación y Filtering

```javascript
// components/avatar-validator.js - NUEVO ARCHIVO

/**
 * Valida y procesa avatares de Avaturn para Hubs
 */

import * as THREE from "three";

export class AvaturnAvatarValidator {
  constructor() {
    this.requiredBones = [
      "Hips", "Spine", "Neck", "Head",
      "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
      "RightShoulder", "RightArm", "RightForeArm", "RightHand"
    ];
  }

  /**
   * Valida un avatar de Avaturn
   */
  async validate(gltf) {
    const errors = [];
    const warnings = [];

    // 1. Verificar que es GLB válido
    if (!gltf || !gltf.scene) {
      errors.push("Invalid GLTF/GLB file");
      return { valid: false, errors, warnings };
    }

    // 2. Verificar skeleton
    const skeleton = this.findSkeleton(gltf.scene);
    if (!skeleton) {
      errors.push("No skeleton found in avatar");
    } else {
      const missingBones = this.checkRequiredBones(skeleton);
      if (missingBones.length > 0) {
        warnings.push(`Missing bones: ${missingBones.join(", ")}`);
      }
    }

    // 3. Verificar materiales
    const materials = this.getMaterials(gltf);
    if (materials.length === 0) {
      errors.push("No materials found");
    }

    // 4. Verificar texturas
    const textureIssues = this.checkTextures(materials);
    warnings.push(...textureIssues);

    // 5. Verificar animaciones
    if (gltf.animations && gltf.animations.length > 0) {
      const animIssues = this.checkAnimations(gltf.animations);
      warnings.push(...animIssues);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Procesa avatar de Avaturn para optimizar para Hubs
   */
  process(gltf) {
    // 1. Filtrar animaciones problemáticas (como en ReadyPlayer.me)
    if (gltf.animations) {
      this.filterAnimations(gltf);
    }

    // 2. Asegurar material Bot_PBS
    this.ensureBotPBSMaterial(gltf);

    // 3. Optimizar texturas
    this.optimizeTextures(gltf);

    // 4. Agregar componentes de Hubs si no existen
    this.addHubsComponents(gltf);

    return gltf;
  }

  findSkeleton(scene) {
    let skeleton = null;
    scene.traverse(node => {
      if (node.isSkinnedMesh && node.skeleton) {
        skeleton = node.skeleton;
      }
    });
    return skeleton;
  }

  checkRequiredBones(skeleton) {
    const boneNames = skeleton.bones.map(b => b.name);
    return this.requiredBones.filter(required =>
      !boneNames.some(name => name.includes(required))
    );
  }

  getMaterials(gltf) {
    const materials = [];
    gltf.scene.traverse(node => {
      if (node.isMesh && node.material) {
        if (Array.isArray(node.material)) {
          materials.push(...node.material);
        } else {
          materials.push(node.material);
        }
      }
    });
    return materials;
  }

  checkTextures(materials) {
    const warnings = [];
    materials.forEach(material => {
      if (material.map && material.map.image) {
        const { width, height } = material.map.image;

        // Advertir si texturas son muy grandes
        if (width > 2048 || height > 2048) {
          warnings.push(
            `Texture ${material.name} is ${width}x${height} ` +
            `(recommended max 2048x2048 for web)`
          );
        }

        // Advertir si no son potencia de 2
        if (!this.isPowerOfTwo(width) || !this.isPowerOfTwo(height)) {
          warnings.push(
            `Texture ${material.name} size ${width}x${height} ` +
            `is not power of 2 (may cause issues)`
          );
        }
      }
    });
    return warnings;
  }

  isPowerOfTwo(value) {
    return (value & (value - 1)) === 0 && value !== 0;
  }

  checkAnimations(animations) {
    const warnings = [];
    animations.forEach(clip => {
      // Verificar si tiene VectorKeyframeTracks problemáticos
      const hasVectorTracks = clip.tracks.some(track =>
        track instanceof THREE.VectorKeyframeTrack
      );

      if (hasVectorTracks) {
        warnings.push(
          `Animation "${clip.name}" has VectorKeyframeTracks ` +
          `(may cause issues, will be filtered)`
        );
      }
    });
    return warnings;
  }

  filterAnimations(gltf) {
    // Similar a fix de ReadyPlayer.me
    gltf.animations.forEach(clip => {
      // Solo mantener QuaternionKeyframeTracks
      const quaternionTracks = clip.tracks.filter(track =>
        track instanceof THREE.QuaternionKeyframeTrack
      );

      // Filtrar tracks de manos/dedos que causan problemas
      const filteredTracks = quaternionTracks.filter(track => {
        const name = track.name.toLowerCase();
        return !name.includes('hand') &&
               !name.includes('finger') &&
               !name.includes('thumb');
      });

      clip.tracks = filteredTracks;
    });
  }

  ensureBotPBSMaterial(gltf) {
    const MAT_NAME = "Bot_PBS";

    // Buscar si ya existe
    let hasBotPBS = false;
    gltf.scene.traverse(node => {
      if (node.isMesh && node.material) {
        const materials = Array.isArray(node.material)
          ? node.material
          : [node.material];

        if (materials.some(m => m.name === MAT_NAME)) {
          hasBotPBS = true;
        }
      }
    });

    if (hasBotPBS) return;

    // Si no existe, renombrar el primer material encontrado
    gltf.scene.traverse(node => {
      if (node.isMesh && node.material && !hasBotPBS) {
        if (Array.isArray(node.material)) {
          node.material[0].name = MAT_NAME;
        } else {
          node.material.name = MAT_NAME;
        }
        hasBotPBS = true;
      }
    });
  }

  optimizeTextures(gltf) {
    gltf.scene.traverse(node => {
      if (node.isMesh && node.material) {
        const materials = Array.isArray(node.material)
          ? node.material
          : [node.material];

        materials.forEach(material => {
          // Configurar encoding correcto
          if (material.map) {
            material.map.encoding = THREE.sRGBEncoding;
          }

          // Configurar anisotropy para mejor calidad
          if (material.map) {
            material.map.anisotropy = 4;
          }

          // Habilitar mipmaps
          if (material.map) {
            material.map.generateMipmaps = true;
          }
        });
      }
    });
  }

  addHubsComponents(gltf) {
    // Agregar extensión MOZ_hubs_components si no existe
    if (!gltf.userData) {
      gltf.userData = {};
    }

    if (!gltf.userData.gltfExtensions) {
      gltf.userData.gltfExtensions = {};
    }

    if (!gltf.userData.gltfExtensions.MOZ_hubs_components) {
      gltf.userData.gltfExtensions.MOZ_hubs_components = {
        components: []
      };
    }

    // Agregar scale-audio-feedback a head si existe
    gltf.scene.traverse(node => {
      if (node.name.toLowerCase().includes('head')) {
        if (!node.userData.gltfExtensions) {
          node.userData.gltfExtensions = {};
        }
        if (!node.userData.gltfExtensions.MOZ_hubs_components) {
          node.userData.gltfExtensions.MOZ_hubs_components = {
            "scale-audio-feedback": {
              minScale: 1.0,
              maxScale: 1.3
            }
          };
        }
      }
    });
  }
}
```

#### 5. Usar Validator en Avatar Loading

```javascript
// Modificar gltf-model-plus.js para incluir validación

import { AvaturnAvatarValidator } from "./avatar-validator";

AFRAME.registerComponent("gltf-model-plus", {
  // ... schema existente ...

  async update(oldData) {
    if (this.data.src === oldData.src) return;

    try {
      let gltf = await this.loadModel(this.data.src);

      // NUEVO: Validar y procesar si es avatar de Avaturn
      if (this.isAvaturnAvatar(this.data.src)) {
        console.log("Detectado avatar de Avaturn, validando...");

        const validator = new AvaturnAvatarValidator();

        // Validar
        const validation = await validator.validate(gltf);

        if (!validation.valid) {
          console.error("Errores de validación:", validation.errors);
          throw new Error("Invalid Avaturn avatar: " + validation.errors.join(", "));
        }

        if (validation.warnings.length > 0) {
          console.warn("Advertencias:", validation.warnings);
        }

        // Procesar
        gltf = validator.process(gltf);
        console.log("Avatar de Avaturn procesado correctamente");
      }

      // Continuar con flujo normal
      this.el.setObject3D("mesh", gltf.scene);

      if (this.data.inflate) {
        this.inflateEntities(gltf);
      }

      this.applyHubsComponents(gltf);

    } catch (error) {
      console.error("Error loading model:", error);
      this.el.emit("model-error", { src: this.data.src, error });
    }
  },

  isAvaturnAvatar(src) {
    return src.includes("avaturn.dev") ||
           src.includes("cdn.avaturn.dev") ||
           src.startsWith("avaturn://");
  }
});
```

---

### Opción C: SDK Full Integration (Más Avanzada)

Esta opción requiere **API de pago ($800/mes)** pero ofrece control total.

```javascript
// avatar-editor-avaturn-sdk.js - NUEVO ARCHIVO

import AvaturnSDK from "@avaturn/sdk";

class AvatarEditorAvaturnSDK extends Component {
  componentDidMount() {
    this.initAvaturnSDK();
  }

  async initAvaturnSDK() {
    const container = this.avaturnContainer;

    // Requiere API key (plan PRO)
    const sdk = new AvaturnSDK();

    await sdk.init(container, {
      url: "https://tu-app.avaturn.dev/",
      apiKey: process.env.AVATURN_API_KEY,  // ← Requiere API
      // Customización avanzada
      ui: {
        theme: "dark",
        primaryColor: "#4CAF50",
        logo: "/path/to/hubs-logo.png"
      },
      features: {
        camera: true,
        photoUpload: true,
        bodyTypes: ["v2024"]
      }
    });

    // Eventos
    sdk.on("export", this.handleAvatarExport);
    sdk.on("error", this.handleError);
  }

  handleAvatarExport = async (data) => {
    // Similar a opción B pero con más datos
    const avatar = await createAvaturnAvatar(data.url, data);
    this.props.store.update({
      profile: { avatarId: avatar.avatar_id }
    });
  };

  render() {
    return (
      <div ref={c => this.avaturnContainer = c}
           className="avaturn-sdk-container" />
    );
  }
}
```

**Pros:**
- ✅ Control total de UI/UX
- ✅ Branding personalizado
- ✅ Gestión de usuarios independiente
- ✅ Acceso a API REST

**Cons:**
- ❌ Costo: $800/mes
- ❌ Mayor complejidad de implementación
- ❌ Requiere gestión de API keys

---

## Problemas Conocidos y Soluciones

### Problema 1: Animaciones T-Pose Flashing

**Síntoma:**
Avatar parpadea volviendo a T-Pose durante animaciones

**Causa:**
VectorKeyframeTracks (posición/escala) no manejados correctamente

**Solución:**

```javascript
function filterProblematicTracks(gltf) {
  gltf.animations.forEach(clip => {
    // Solo QuaternionKeyframeTracks
    clip.tracks = clip.tracks.filter(track =>
      track instanceof THREE.QuaternionKeyframeTrack &&
      !track.name.toLowerCase().includes('hand')
    );
  });
}
```

**Aplicar en:**
- `AvaturnAvatarValidator.filterAnimations()`
- `gltf-model-plus.js` antes de crear AnimationMixer

---

### Problema 2: Mesh Holes (Agujeros en Manos)

**Síntoma:**
Avatares muestran agujeros visuales en manos/dedos

**Causa:**
Bones de dedos con animaciones incompatibles

**Solución:**

```javascript
// Remover tracks de dedos
function removeFingerTracks(gltf) {
  const fingerKeywords = [
    'thumb', 'index', 'middle', 'ring', 'pinky',
    'finger', 'hand'
  ];

  gltf.animations.forEach(clip => {
    clip.tracks = clip.tracks.filter(track => {
      const name = track.name.toLowerCase();
      return !fingerKeywords.some(keyword => name.includes(keyword));
    });
  });
}
```

---

### Problema 3: Texturas No Se Cargan

**Síntoma:**
Avatar aparece negro o sin texturas

**Causas Posibles:**
1. CORS issues
2. Encoding incorrecto
3. Texturas muy grandes

**Soluciones:**

```javascript
// 1. Usar proxy para CORS
function proxiedUrlFor(url) {
  if (url.startsWith("http")) {
    return `/api/v1/media?url=${encodeURIComponent(url)}`;
  }
  return url;
}

// 2. Configurar encoding correcto
material.map.encoding = THREE.sRGBEncoding;

// 3. Redimensionar texturas grandes
function resizeTextureIfNeeded(texture, maxSize = 2048) {
  const { width, height } = texture.image;

  if (width > maxSize || height > maxSize) {
    const canvas = document.createElement('canvas');
    const scale = maxSize / Math.max(width, height);

    canvas.width = width * scale;
    canvas.height = height * scale;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(texture.image, 0, 0, canvas.width, canvas.height);

    texture.image = canvas;
    texture.needsUpdate = true;
  }
}
```

---

### Problema 4: Audio Feedback No Funciona

**Síntoma:**
Avatar no escala o cambia cuando usuario habla

**Causa:**
Componente `scale-audio-feedback` no aplicado

**Solución:**

```javascript
// En Blender: Agregar componente al nodo Head
// O programáticamente:
function addAudioFeedback(gltf) {
  gltf.scene.traverse(node => {
    if (node.name.toLowerCase() === 'head') {
      if (!node.userData.gltfExtensions) {
        node.userData.gltfExtensions = {};
      }

      node.userData.gltfExtensions.MOZ_hubs_components = {
        "scale-audio-feedback": {
          minScale: 1.0,
          maxScale: 1.3
        }
      };
    }
  });
}
```

---

### Problema 5: Avatar No Sincroniza en Multiplayer

**Síntoma:**
Otros usuarios no ven el avatar correctamente

**Causa:**
networked-avatar component no configurado

**Solución:**

```javascript
// Asegurar que el avatar tenga networked-avatar
const avatarEl = document.querySelector("#avatar-rig");

if (avatarEl && !avatarEl.hasAttribute("networked-avatar")) {
  avatarEl.setAttribute("networked-avatar", {
    left_hand_pose: 0,
    right_hand_pose: 0
  });
}

// Verificar NAF template
NAF.schemas.add({
  template: "#avatar-template",
  components: [
    {
      component: "networked-avatar",
      property: "left_hand_pose"
    },
    {
      component: "networked-avatar",
      property: "right_hand_pose"
    }
  ]
});
```

---

### Problema 6: Performance Bajo con Avaturn

**Síntoma:**
FPS baja con avatares de Avaturn (texturas 4K-8K)

**Causa:**
Texturas muy pesadas para web

**Solución:**

```javascript
// Optimización de texturas Avaturn
function optimizeAvaturnTextures(gltf, maxTextureSize = 1024) {
  gltf.scene.traverse(node => {
    if (node.isMesh && node.material) {
      const materials = Array.isArray(node.material)
        ? node.material
        : [node.material];

      materials.forEach(material => {
        // Reducir texturas
        ['map', 'normalMap', 'roughnessMap', 'metalnessMap'].forEach(mapType => {
          if (material[mapType]) {
            resizeTextureIfNeeded(material[mapType], maxTextureSize);
          }
        });

        // Configurar para performance
        material.precision = "mediump";
        material.shadowSide = THREE.FrontSide;
      });

      // LOD para geometría
      if (node.geometry) {
        node.geometry.computeBoundingSphere();
      }
    }
  });
}
```

---

### Problema 7: Avatar No Aparece en VR

**Síntoma:**
Avatar visible en desktop pero no en VR

**Causa:**
Escala incorrecta o posición

**Solución:**

```javascript
// Asegurar escala y posición correctas
function setupAvatarForVR(avatarEl) {
  // Escala típica de avatar
  avatarEl.object3D.scale.set(1, 1, 1);

  // Posición relativa al rig
  avatarEl.object3D.position.set(0, 0, 0);

  // Asegurar que está en layer correcto
  avatarEl.object3D.traverse(node => {
    node.layers.enable(0); // Default layer
    node.layers.enable(1); // VR layer
  });

  // Verificar que tiene componentes VR
  if (!avatarEl.hasAttribute("ik-controller")) {
    avatarEl.setAttribute("ik-controller", {
      leftHand: "#left-hand",
      rightHand: "#right-hand",
      head: "#head"
    });
  }
}
```

---

## Mejores Prácticas

### 1. Validación de Avatares

**SIEMPRE validar antes de cargar:**

```javascript
async function loadAvatar(url) {
  const validator = new AvaturnAvatarValidator();

  // Cargar
  const gltf = await loadGLTF(url);

  // Validar
  const validation = await validator.validate(gltf);

  if (!validation.valid) {
    throw new Error("Invalid avatar: " + validation.errors.join(", "));
  }

  // Procesar
  return validator.process(gltf);
}
```

### 2. Manejo de Errores

**Implementar fallbacks:**

```javascript
async function loadAvatarWithFallback(url, fallbackUrl) {
  try {
    return await loadAvatar(url);
  } catch (error) {
    console.error("Error loading avatar:", error);
    console.log("Loading fallback avatar...");

    try {
      return await loadAvatar(fallbackUrl);
    } catch (fallbackError) {
      console.error("Error loading fallback:", fallbackError);
      return loadDefaultAvatar();
    }
  }
}
```

### 3. Caching de Avatares

**Implementar cache para performance:**

```javascript
class AvatarCache {
  constructor(maxSize = 10) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.accessOrder = [];
  }

  async get(url) {
    if (this.cache.has(url)) {
      // Mover al final (LRU)
      const index = this.accessOrder.indexOf(url);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
      }
      this.accessOrder.push(url);

      return this.cache.get(url).clone();
    }
    return null;
  }

  set(url, gltf) {
    // Evict si excede max size
    if (this.cache.size >= this.maxSize) {
      const oldest = this.accessOrder.shift();
      this.cache.delete(oldest);
    }

    this.cache.set(url, gltf);
    this.accessOrder.push(url);
  }

  clear() {
    this.cache.clear();
    this.accessOrder = [];
  }
}

// Uso
const avatarCache = new AvatarCache(10);

async function loadAvatarCached(url) {
  let gltf = await avatarCache.get(url);

  if (!gltf) {
    gltf = await loadAvatar(url);
    avatarCache.set(url, gltf);
  }

  return gltf;
}
```

### 4. Logging y Debugging

**Implementar logging comprehensivo:**

```javascript
class AvatarLogger {
  constructor(enableDebug = false) {
    this.enableDebug = enableDebug;
    this.logs = [];
  }

  log(message, data = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      message,
      data
    };

    this.logs.push(entry);

    if (this.enableDebug) {
      console.log(`[Avatar] ${message}`, data || "");
    }
  }

  error(message, error) {
    const entry = {
      timestamp: new Date().toISOString(),
      message,
      error: error.toString(),
      stack: error.stack
    };

    this.logs.push(entry);
    console.error(`[Avatar Error] ${message}`, error);
  }

  export() {
    return JSON.stringify(this.logs, null, 2);
  }
}

// Uso
const logger = new AvatarLogger(true);

async function loadAvatarWithLogging(url) {
  logger.log("Starting avatar load", { url });

  try {
    const gltf = await loadAvatar(url);
    logger.log("Avatar loaded successfully", {
      url,
      vertices: countVertices(gltf),
      materials: countMaterials(gltf)
    });
    return gltf;
  } catch (error) {
    logger.error("Failed to load avatar", error);
    throw error;
  }
}
```

### 5. Testing de Avatares

**Checklist de testing:**

```javascript
class AvatarTester {
  async runTests(gltf) {
    const results = {
      passed: [],
      failed: [],
      warnings: []
    };

    // Test 1: Skeleton
    try {
      this.testSkeleton(gltf);
      results.passed.push("Skeleton test");
    } catch (error) {
      results.failed.push({ test: "Skeleton", error: error.message });
    }

    // Test 2: Materials
    try {
      this.testMaterials(gltf);
      results.passed.push("Materials test");
    } catch (error) {
      results.failed.push({ test: "Materials", error: error.message });
    }

    // Test 3: Texturas
    try {
      const warnings = this.testTextures(gltf);
      if (warnings.length > 0) {
        results.warnings.push(...warnings);
      }
      results.passed.push("Textures test");
    } catch (error) {
      results.failed.push({ test: "Textures", error: error.message });
    }

    // Test 4: Animaciones
    try {
      this.testAnimations(gltf);
      results.passed.push("Animations test");
    } catch (error) {
      results.failed.push({ test: "Animations", error: error.message });
    }

    // Test 5: Performance
    try {
      const perfWarnings = this.testPerformance(gltf);
      if (perfWarnings.length > 0) {
        results.warnings.push(...perfWarnings);
      }
      results.passed.push("Performance test");
    } catch (error) {
      results.failed.push({ test: "Performance", error: error.message });
    }

    return results;
  }

  testSkeleton(gltf) {
    let skeleton = null;
    gltf.scene.traverse(node => {
      if (node.isSkinnedMesh && node.skeleton) {
        skeleton = node.skeleton;
      }
    });

    if (!skeleton) {
      throw new Error("No skeleton found");
    }

    const requiredBones = ["Hips", "Spine", "Head"];
    const boneNames = skeleton.bones.map(b => b.name);

    requiredBones.forEach(required => {
      if (!boneNames.some(name => name.includes(required))) {
        throw new Error(`Missing required bone: ${required}`);
      }
    });
  }

  testMaterials(gltf) {
    let hasMaterial = false;
    gltf.scene.traverse(node => {
      if (node.isMesh && node.material) {
        hasMaterial = true;
      }
    });

    if (!hasMaterial) {
      throw new Error("No materials found");
    }
  }

  testTextures(gltf) {
    const warnings = [];
    gltf.scene.traverse(node => {
      if (node.isMesh && node.material) {
        const materials = Array.isArray(node.material)
          ? node.material
          : [node.material];

        materials.forEach(material => {
          if (material.map && material.map.image) {
            const { width, height } = material.map.image;

            if (width > 2048 || height > 2048) {
              warnings.push(
                `Texture ${material.name} is ${width}x${height} (large)`
              );
            }
          }
        });
      }
    });
    return warnings;
  }

  testAnimations(gltf) {
    if (!gltf.animations || gltf.animations.length === 0) {
      // No es error, solo no tiene animaciones
      return;
    }

    gltf.animations.forEach(clip => {
      if (clip.tracks.length === 0) {
        throw new Error(`Animation "${clip.name}" has no tracks`);
      }
    });
  }

  testPerformance(gltf) {
    const warnings = [];
    let totalVertices = 0;
    let totalTriangles = 0;

    gltf.scene.traverse(node => {
      if (node.isMesh && node.geometry) {
        const vertices = node.geometry.attributes.position.count;
        const triangles = node.geometry.index
          ? node.geometry.index.count / 3
          : vertices / 3;

        totalVertices += vertices;
        totalTriangles += triangles;
      }
    });

    if (totalVertices > 100000) {
      warnings.push(
        `High vertex count: ${totalVertices} (recommended < 100k for web)`
      );
    }

    if (totalTriangles > 50000) {
      warnings.push(
        `High triangle count: ${totalTriangles} (recommended < 50k for web)`
      );
    }

    return warnings;
  }
}

// Uso
const tester = new AvatarTester();
const results = await tester.runTests(gltf);

console.log("Tests passed:", results.passed);
console.log("Tests failed:", results.failed);
console.log("Warnings:", results.warnings);
```

---

## Testing y Validación

### Test Suite Completo

```javascript
// test-avatar-integration.js

import { AvaturnAvatarValidator } from "./avatar-validator";
import { loadGLTF } from "./gltf-loader";

describe("Avaturn Integration Tests", () => {
  let validator;

  beforeEach(() => {
    validator = new AvaturnAvatarValidator();
  });

  test("Cargar avatar de Avaturn válido", async () => {
    const gltf = await loadGLTF("https://cdn.avaturn.dev/test-avatar.glb");
    const validation = await validator.validate(gltf);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  test("Detectar avatar sin skeleton", async () => {
    const gltf = await loadGLTF("invalid-avatar-no-skeleton.glb");
    const validation = await validator.validate(gltf);

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("No skeleton found in avatar");
  });

  test("Filtrar animaciones problemáticas", async () => {
    const gltf = await loadGLTF("avatar-with-vector-tracks.glb");
    validator.process(gltf);

    gltf.animations.forEach(clip => {
      clip.tracks.forEach(track => {
        expect(track).toBeInstanceOf(THREE.QuaternionKeyframeTrack);
      });
    });
  });

  test("Asegurar material Bot_PBS", async () => {
    const gltf = await loadGLTF("avatar-without-botpbs.glb");
    validator.process(gltf);

    let hasBotPBS = false;
    gltf.scene.traverse(node => {
      if (node.isMesh && node.material) {
        if (node.material.name === "Bot_PBS") {
          hasBotPBS = true;
        }
      }
    });

    expect(hasBotPBS).toBe(true);
  });

  test("Advertir sobre texturas grandes", async () => {
    const gltf = await loadGLTF("avatar-with-4k-textures.glb");
    const validation = await validator.validate(gltf);

    const hasTextureSizeWarning = validation.warnings.some(w =>
      w.includes("recommended max 2048")
    );

    expect(hasTextureSizeWarning).toBe(true);
  });
});
```

### Testing Manual

**Checklist de Testing Manual:**

```markdown
# Checklist de Testing de Avatar Avaturn

## Pre-carga
- [ ] Avatar creado en Avaturn (demo.avaturn.dev)
- [ ] Avatar exportado como GLB
- [ ] URL del GLB accesible

## Integración en Hubs
- [ ] Tab "Avaturn" visible en editor
- [ ] iFrame de Avaturn carga correctamente
- [ ] Puede crear avatar en iFrame
- [ ] postMessage recibido al exportar
- [ ] URL del GLB mostrada en UI

## Validación
- [ ] Sin errores en consola
- [ ] Avatar pasa validación (AvaturnAvatarValidator)
- [ ] Material Bot_PBS presente
- [ ] Skeleton con huesos requeridos
- [ ] Animaciones filtradas correctamente

## Preview
- [ ] Avatar se muestra en preview panel
- [ ] Texturas cargadas correctamente
- [ ] Sin agujeros en mesh
- [ ] Colores correctos

## Guardado
- [ ] Botón "Use This Avatar" funciona
- [ ] Avatar guardado en store
- [ ] avatarId correcto (avaturn://...)

## En Sala (Room)
- [ ] Avatar carga al entrar
- [ ] Posición y escala correctas
- [ ] Movimiento funciona
- [ ] Rotación de cabeza funciona
- [ ] Manos visibles y animadas

## Multiplayer
- [ ] Otros usuarios ven el avatar
- [ ] Avatar sincroniza movimiento
- [ ] Poses de manos sincronizadas
- [ ] Audio feedback funciona (escala al hablar)

## VR Mode
- [ ] Avatar visible en VR
- [ ] IK funciona (brazos siguen controllers)
- [ ] Escala correcta en VR
- [ ] Hand tracking funciona

## Performance
- [ ] FPS estable (>60 en desktop, >72 en VR)
- [ ] Sin stuttering al cargar
- [ ] Múltiples avatares soportados (5+ usuarios)
- [ ] Memoria estable (no hay leaks)

## Edge Cases
- [ ] Funciona con avatar T1 (sin facial anim)
- [ ] Funciona con avatar T2 (con facial anim)
- [ ] Funciona con body v2023
- [ ] Funciona con body v2024
- [ ] Maneja errores de red gracefully
- [ ] Fallback a avatar default si falla
```

---

## Referencias y Recursos

### Repositorios GitHub

| Repositorio | URL | Descripción |
|------------|-----|-------------|
| **Hubs Foundation** | https://github.com/Hubs-Foundation/hubs | Código principal de Hubs |
| **Hubs Avatar Pipelines** | https://github.com/MozillaReality/hubs-avatar-pipelines | Templates y assets |
| **XRcloud (BELIVVR)** | https://github.com/luke-n-alpha/XRcloud | Fork con full-body |
| **Avaturn Web SDK** | https://github.com/avaturn/web-sdk-example | Ejemplo del SDK |
| **Avaturn Three.js** | https://github.com/avaturn/avaturn-threejs-example | Integración Three.js |
| **Ready Player Me** | https://github.com/readyplayerme | SDK y ejemplos |

### Documentación Oficial

| Recurso | URL |
|---------|-----|
| **Hubs Docs** | https://docs.hubsfoundation.org |
| **A-Frame Docs** | https://aframe.io/docs |
| **Three.js Docs** | https://threejs.org/docs |
| **Avaturn Docs** | https://docs.avaturn.me |
| **glTF Spec** | https://github.com/KhronosGroup/glTF |

### Issues Relevantes

| Issue | Título | Estado |
|-------|--------|--------|
| #5964 | Ready Player Me Half-Body Problems | 🔴 Abierto |
| #4847 | Speaking Indicators | ✅ Cerrado |
| #5532 | Third-person View | 🔴 Abierto |
| #3203 | Full-body Avatars Discussion | 💬 Activo |

### Comunidades

| Comunidad | URL |
|-----------|-----|
| **Hubs Discord** | https://discord.gg/dFJncWwHun |
| **Avaturn Discord** | https://discord.com/invite/FfavuatXrz |
| **A-Frame Slack** | https://aframe.io/slack-invite |
| **WebXR Discord** | https://discord.gg/Jt5tfaM |

### Tools y Utilidades

| Tool | URL | Propósito |
|------|-----|-----------|
| **glTF Validator** | https://github.khronos.org/glTF-Validator/ | Validar glTF/GLB |
| **glTF Viewer** | https://gltf-viewer.donmccurdy.com/ | Preview glTF |
| **Blender** | https://www.blender.org | Edición 3D |
| **Spoke** | https://hubs.mozilla.com/spoke | Editor de escenas |

---

## Conclusiones

### Resumen

Esta guía documenta el proceso completo para implementar **Avaturn** en **Mozilla Hubs (hubs-foundation)** usando como referencia las implementaciones de **ReadyPlayer.me** y **BELIVVR XRcloud**.

### Opción Recomendada

**Opción B: iFrame Integration en Editor** es la mejor opción porque:

✅ **Gratuita** - No requiere API de pago
✅ **Integrada** - Experiencia fluida dentro de Hubs
✅ **Complejidad manejable** - Código bien documentado
✅ **Mantenible** - Usa sistemas existentes de Hubs
✅ **Escalable** - Puede migrar a SDK si es necesario

### Próximos Pasos

1. **Implementar Opción B** siguiendo el código proporcionado
2. **Testing exhaustivo** con checklist manual
3. **Validación con múltiples tipos de avatar** (T1, T2, v2023, v2024)
4. **Optimización de performance** con cache y LOD
5. **Documentación de usuario** para crear avatares

### Consideraciones Finales

- **Mozilla Hubs fue discontinuado** pero Hubs Foundation continúa activamente
- **ReadyPlayer.me tiene problemas conocidos** que debemos evitar con Avaturn
- **BELIVVR XRcloud** proporciona patrones útiles (URL params, fast entry)
- **Avaturn es gratuito** mediante iFrame sin necesidad de API
- **Validación es crítica** para evitar problemas de compatibilidad

### Soporte

Para preguntas o problemas:
- **Hubs Discord:** https://discord.gg/dFJncWwHun
- **Avaturn Discord:** https://discord.com/invite/FfavuatXrz
- **GitHub Issues:** https://github.com/Hubs-Foundation/hubs/issues

---

**Fecha de creación:** Enero 2026
**Versión:** 1.0
**Mantenido por:** Comunidad Hubs Foundation

---

## Apéndice A: Glosario

**A-Frame:** Framework WebVR/WebXR basado en Entity-Component-System
**ARKit Blendshapes:** 51 formas de animación facial estándar de Apple
**BitECS:** Entity Component System moderno usado en Hubs
**DRACO:** Compresión de geometría 3D
**GLB:** Formato binario de glTF
**glTF:** GL Transmission Format (estándar 3D)
**IK (Inverse Kinematics):** Cinemática inversa para animación
**LOD:** Level of Detail (optimización)
**NAF:** Networked A-Frame (multiplayer)
**ORM:** Occlusion, Roughness, Metallic texture
**PBR:** Physically Based Rendering
**Reticulum:** Backend de Hubs (Phoenix/Elixir)
**SFU:** Selective Forwarding Unit (media server)
**Spoke:** Editor de escenas de Hubs
**T-Pose:** Pose default de rigging
**Visemes:** Formas de boca para sincronización labial
**VRM:** Formato de avatar para VTubing
**WebRTC:** Web Real-Time Communication
**WebXR:** Web Extended Reality (VR/AR)

---

## Apéndice B: Troubleshooting Rápido

| Problema | Solución Rápida |
|----------|-----------------|
| Avatar no carga | Verificar CORS, usar proxy |
| Avatar negro | Verificar texturas, encoding sRGB |
| T-Pose flash | Filtrar VectorKeyframeTracks |
| Mesh holes | Remover tracks de dedos |
| No audio feedback | Agregar scale-audio-feedback component |
| No sincroniza | Verificar networked-avatar component |
| FPS bajo | Reducir tamaño texturas, optimizar geometría |
| No visible en VR | Verificar layers y escala |

---

**FIN DEL DOCUMENTO**
