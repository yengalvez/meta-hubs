# Quick Reference Card
## Snippets de Código Más Usados

---

## 🚀 Cargar Avatar de Avaturn

```javascript
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { AvaturnAvatarValidator } from './avatar-validator';

async function loadAvaturnAvatar(url) {
  // 1. Cargar GLB
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });

  // 2. Validar
  const validator = new AvaturnAvatarValidator();
  const validation = await validator.validate(gltf);

  if (!validation.valid) {
    throw new Error(`Invalid avatar: ${validation.errors.join(', ')}`);
  }

  // 3. Procesar (filtrar animaciones, optimizar)
  const processed = validator.process(gltf);

  // 4. Agregar a escena
  scene.add(processed.scene);

  return processed;
}
```

---

## 🎨 iFrame de Avaturn

```html
<iframe
  id="avaturn-frame"
  src="https://demo.avaturn.dev/"
  allow="microphone; camera"
  style="width: 100%; height: 100%; border: none;"
></iframe>

<script>
window.addEventListener('message', (event) => {
  if (!event.origin.includes('avaturn.dev')) return;

  if (event.data?.type === 'avatarExport') {
    const avatarUrl = event.data.url;
    console.log('Avatar URL:', avatarUrl);
    // Usar avatar...
  }
});
</script>
```

---

## ✅ Validar Avatar

```javascript
const validator = new AvaturnAvatarValidator();

// Validar
const result = await validator.validate(gltf);

console.log('Valid:', result.valid);
console.log('Errors:', result.errors);
console.log('Warnings:', result.warnings);

// Generar reporte
const report = validator.generateReport(gltf);
console.log('Report:', report);
```

---

## 🔧 Filtrar Animaciones Problemáticas

```javascript
// Fix para T-Pose flashing
function fixAnimations(gltf) {
  gltf.animations.forEach(clip => {
    // Solo QuaternionKeyframeTracks
    clip.tracks = clip.tracks.filter(track =>
      track instanceof THREE.QuaternionKeyframeTrack
    );

    // Sin tracks de dedos
    clip.tracks = clip.tracks.filter(track => {
      const name = track.name.toLowerCase();
      return !['hand', 'finger', 'thumb'].some(k => name.includes(k));
    });
  });
}
```

---

## 🎯 Asegurar Material Bot_PBS

```javascript
function ensureBotPBS(gltf) {
  const MAT_NAME = "Bot_PBS";

  let found = false;
  gltf.scene.traverse(node => {
    if (node.isMesh && node.material && !found) {
      if (Array.isArray(node.material)) {
        node.material[0].name = MAT_NAME;
      } else {
        node.material.name = MAT_NAME;
      }
      found = true;
    }
  });
}
```

---

## 📦 Configurar Texturas

```javascript
function setupTextures(material) {
  // Base color (sRGB)
  if (material.map) {
    material.map.encoding = THREE.sRGBEncoding;
    material.map.generateMipmaps = true;
    material.map.anisotropy = 4;
  }

  // Normal map (Linear)
  if (material.normalMap) {
    material.normalMap.encoding = THREE.LinearEncoding;
  }

  // ORM maps (Linear)
  [material.aoMap, material.roughnessMap, material.metalnessMap]
    .forEach(map => {
      if (map) map.encoding = THREE.LinearEncoding;
    });
}
```

---

## 🔊 Agregar Audio Feedback

```javascript
function addAudioFeedback(gltf) {
  gltf.scene.traverse(node => {
    if (node.name.toLowerCase().includes('head')) {
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

## 💾 Cache de Avatares

```javascript
class AvatarCache {
  constructor(maxSize = 10) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.lru = [];
  }

  get(url) {
    if (this.cache.has(url)) {
      // Update LRU
      const idx = this.lru.indexOf(url);
      if (idx > -1) this.lru.splice(idx, 1);
      this.lru.push(url);

      return this.cache.get(url).clone();
    }
    return null;
  }

  set(url, gltf) {
    if (this.cache.size >= this.maxSize) {
      const oldest = this.lru.shift();
      this.cache.delete(oldest);
    }

    this.cache.set(url, gltf);
    this.lru.push(url);
  }
}

// Uso
const cache = new AvatarCache(10);
let avatar = cache.get(url);
if (!avatar) {
  avatar = await loadAvaturnAvatar(url);
  cache.set(url, avatar);
}
```

---

## 🌐 URL Parameters para Hubs

```javascript
// Construir URL
function buildHubsUrl(roomId, avatarUrl, displayName) {
  const base = `https://hubs.mozilla.com/${roomId}`;
  const params = new URLSearchParams({
    avatarUrl: avatarUrl,
    displayName: displayName || 'Guest'
  });

  return `${base}?${params.toString()}`;
}

// Parsear URL
function parseHubsUrl() {
  const params = new URLSearchParams(window.location.search);
  return {
    avatarUrl: params.get('avatarUrl'),
    displayName: params.get('displayName')
  };
}
```

---

## 🎭 Crear Avatar en Hubs Store

```javascript
import { createAvaturnAvatar } from './utils/avatar-utils';

async function saveAvaturnAvatar(glbUrl, metadata) {
  const avatar = await createAvaturnAvatar(glbUrl, {
    bodyId: metadata.bodyId,
    gender: metadata.gender,
    avatarSupportsFaceAnimations: metadata.avatarSupportsFaceAnimations
  });

  // Guardar en store
  store.update({
    profile: {
      avatarId: avatar.avatar_id
    }
  });

  return avatar;
}
```

---

## 🧪 Testing de Avatar

```javascript
async function testAvatar(gltf) {
  const tests = {
    hasSkeleton: false,
    hasMaterial: false,
    hasTextures: false,
    animationsValid: false
  };

  // Test skeleton
  gltf.scene.traverse(node => {
    if (node.isSkinnedMesh && node.skeleton) {
      tests.hasSkeleton = true;
    }
    if (node.isMesh && node.material) {
      tests.hasMaterial = true;
      if (node.material.map) {
        tests.hasTextures = true;
      }
    }
  });

  // Test animations
  if (gltf.animations?.length > 0) {
    tests.animationsValid = gltf.animations.every(clip =>
      clip.tracks.length > 0
    );
  } else {
    tests.animationsValid = true; // OK sin animaciones
  }

  const allPassed = Object.values(tests).every(v => v);
  console.log('Tests:', tests);
  console.log('All passed:', allPassed);

  return { tests, allPassed };
}
```

---

## 🔍 Debug Avatar Info

```javascript
function debugAvatar(gltf) {
  console.group('🎭 Avatar Debug Info');

  // Meshes
  let meshCount = 0;
  let vertexCount = 0;
  gltf.scene.traverse(node => {
    if (node.isMesh) {
      meshCount++;
      vertexCount += node.geometry.attributes.position.count;
    }
  });
  console.log('Meshes:', meshCount);
  console.log('Vertices:', vertexCount.toLocaleString());

  // Materials
  const materials = new Set();
  gltf.scene.traverse(node => {
    if (node.isMesh && node.material) {
      materials.add(node.material.name);
    }
  });
  console.log('Materials:', Array.from(materials));

  // Skeleton
  let skeleton = null;
  gltf.scene.traverse(node => {
    if (node.isSkinnedMesh && node.skeleton) {
      skeleton = node.skeleton;
    }
  });
  console.log('Bones:', skeleton ? skeleton.bones.length : 0);

  // Animations
  console.log('Animations:', gltf.animations?.length || 0);
  gltf.animations?.forEach(clip => {
    console.log(`  - ${clip.name}: ${clip.tracks.length} tracks`);
  });

  console.groupEnd();
}
```

---

## 📊 Performance Monitoring

```javascript
class AvatarPerformanceMonitor {
  constructor() {
    this.metrics = {
      loadTime: 0,
      processTime: 0,
      vertexCount: 0,
      drawCalls: 0
    };
  }

  async measureLoad(url) {
    const start = performance.now();
    const gltf = await loadAvaturnAvatar(url);
    this.metrics.loadTime = performance.now() - start;

    // Count vertices
    gltf.scene.traverse(node => {
      if (node.isMesh) {
        this.metrics.vertexCount +=
          node.geometry.attributes.position.count;
      }
    });

    return gltf;
  }

  report() {
    console.table(this.metrics);
  }
}

// Uso
const monitor = new AvatarPerformanceMonitor();
const avatar = await monitor.measureLoad(avatarUrl);
monitor.report();
```

---

## 🛠️ Utilidades Comunes

```javascript
// Verificar si es avatar de Avaturn
function isAvaturnAvatar(url) {
  return url.includes('avaturn.dev') ||
         url.includes('cdn.avaturn.dev') ||
         url.startsWith('avaturn://');
}

// Proxy para CORS
function proxiedUrl(url) {
  return `/api/v1/media?url=${encodeURIComponent(url)}`;
}

// Verificar potencia de 2
function isPowerOfTwo(value) {
  return (value & (value - 1)) === 0 && value !== 0;
}

// Redimensionar textura
function resizeTexture(texture, maxSize = 2048) {
  const { width, height } = texture.image;
  if (width <= maxSize && height <= maxSize) return;

  const canvas = document.createElement('canvas');
  const scale = maxSize / Math.max(width, height);
  canvas.width = width * scale;
  canvas.height = height * scale;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(texture.image, 0, 0, canvas.width, canvas.height);

  texture.image = canvas;
  texture.needsUpdate = true;
}
```

---

## 🐛 Errores Comunes

```javascript
// Error: Avatar negro
// Fix: Configurar encoding
material.map.encoding = THREE.sRGBEncoding;

// Error: T-Pose flashing
// Fix: Filtrar animaciones
validator.filterAnimations(gltf);

// Error: CORS
// Fix: Usar proxy
const url = proxiedUrl(avatarUrl);

// Error: No sincroniza en multiplayer
// Fix: Agregar networked-avatar
avatarEl.setAttribute('networked-avatar', {
  left_hand_pose: 0,
  right_hand_pose: 0
});
```

---

## 📞 Enlaces Rápidos

```
Avaturn Demo:  https://demo.avaturn.dev/
Hubs Docs:     https://docs.hubsfoundation.org
Avaturn Docs:  https://docs.avaturn.me
Three.js Docs: https://threejs.org/docs
A-Frame Docs:  https://aframe.io/docs

Hubs Discord:    discord.gg/dFJncWwHun
Avaturn Discord: discord.com/invite/FfavuatXrz
```

---

*Para documentación completa: `IMPLEMENTACION_AVATURN_MOZILLA_HUBS.md`*
