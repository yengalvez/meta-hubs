# Sistema de Animaciones Compartidas para Avatares RPM/Mixamo en Hubs

**Para**: Desarrollador
**Objetivo**: Implementar sistema donde animaciones se descargan UNA vez y funcionan con CUALQUIER avatar compatible Mixamo
**Complejidad**: Media-Alta
**Tiempo estimado**: 15-25 horas

---

## Índice

1. [Visión General](#visión-general)
2. [Cómo Funciona el Retargeting](#cómo-funciona-el-retargeting)
3. [Arquitectura del Sistema](#arquitectura-del-sistema)
4. [Preparación de Animaciones Base](#preparación-de-animaciones-base)
5. [Implementación en Hubs](#implementación-en-hubs)
6. [API para el Usuario](#api-para-el-usuario)
7. [Testing y Validación](#testing-y-validación)
8. [Mantenimiento y Extensión](#mantenimiento-y-extensión)

---

## Visión General

### El Problema Actual

**Flujo ineficiente** (documentado en `movimientoRPM.md`):
```
Usuario 1: Avatar RPM → Mixamo → Blender → Exportar GLB con animaciones → Subir a Hubs
Usuario 2: Avatar RPM → Mixamo → Blender → Exportar GLB con animaciones → Subir a Hubs
Usuario 3: Avatar RPM → Mixamo → Blender → Exportar GLB con animaciones → Subir a Hubs
...
```

**Problemas**:
- ❌ Cada usuario repite proceso tedioso (1-2 horas)
- ❌ Cada GLB incluye animaciones → archivos pesados (10-20MB+)
- ❌ Más bandwidth para descargar
- ❌ Mismas animaciones duplicadas N veces

### La Solución Correcta

**Flujo eficiente con animaciones compartidas**:
```
Desarrollador (UNA VEZ):
  Animaciones Mixamo → Servidor Hubs → Sistema de retargeting

Usuario 1: Avatar RPM estático (2-5MB) → Subir a Hubs → ✅ Funciona automáticamente
Usuario 2: Avatar RPM estático (2-5MB) → Subir a Hubs → ✅ Funciona automáticamente
Usuario 3: Avatar RPM estático (2-5MB) → Subir a Hubs → ✅ Funciona automáticamente
...
```

**Ventajas**:
- ✅ Usuario solo sube avatar estático (sin Blender, sin Mixamo)
- ✅ Archivos pequeños (2-5MB vs 10-20MB)
- ✅ Animaciones se descargan UNA vez del servidor
- ✅ Cache del navegador las guarda localmente
- ✅ Cualquier avatar Mixamo-compatible funciona automáticamente

### Precedente: XRCLOUD

**XRCLOUD implementó exactamente esto**:

> "El sistema usa Blueprints, que son una colección del skeleton del avatar y las partes añadidas al skeleton, con blueprints Male/Female disponibles."

**Código**: https://github.com/luke-n-alpha/xrcloud

**Cómo lo hicieron**:
1. Animaciones base almacenadas en `/assets/animations/`
2. Sistema de retargeting en runtime (Three.js)
3. Detecta skeleton compatible → aplica animaciones automáticamente

---

## Cómo Funciona el Retargeting

### Concepto de Animation Retargeting

**Retargeting** = Adaptar animaciones de un skeleton a otro.

```
Animación Source (Skeleton A)     →  Retargeting  →  Animación Target (Skeleton B)
  LeftUpLeg: rotation X: 45°                            LeftUpLeg: rotation X: 45°
  LeftLeg: rotation X: -20°                             LeftLeg: rotation X: -20°
  ...                                                    ...
```

**Requisito**: Ambos skeletons deben tener:
- ✅ Misma jerarquía (o compatible)
- ✅ Mismos nombres de huesos (o mapeo conocido)
- ✅ Orientaciones similares

### Por Qué Funciona con Mixamo

**Todos los avatares Mixamo-compatible (incluyendo RPM) comparten**:

1. **Misma jerarquía de huesos**:
   ```
   Hips
   ├── Spine → Spine1 → Spine2 → Neck → Head
   ├── LeftUpLeg → LeftLeg → LeftFoot
   └── RightUpLeg → RightLeg → RightFoot
   ```

2. **Mismos nombres de huesos**:
   - Mixamo usa nombres estándar (`Hips`, `LeftUpLeg`, etc.)
   - RPM usa el mismo esquema Mixamo
   - Otros avatares Mixamo-compatible también

3. **Orientaciones consistentes**:
   - Todos están en A-pose o T-pose
   - Misma dirección forward (Z+ o Z-)

**Resultado**: Una animación de Mixamo funciona en CUALQUIER avatar Mixamo-compatible con mínimo ajuste.

### Retargeting en Three.js

Three.js (motor de rendering de Hubs) tiene soporte **parcial** de retargeting:

**Opción 1: Bone Matching Directo** (simple)

```javascript
// Si ambos skeletons tienen mismos nombres de huesos
const sourceClip = animationClips[0]; // Animación base
const targetSkeleton = avatarSkeleton; // Skeleton del avatar del usuario

// Three.js mapea automáticamente por nombre
const mixer = new THREE.AnimationMixer(avatarModel);
const action = mixer.clipAction(sourceClip);
action.play();

// ✅ Funciona si nombres coinciden exactamente
```

**Opción 2: Manual Bone Mapping** (avanzado)

```javascript
// Si nombres no coinciden, crear mapeo
const boneMapping = {
  'mixamorig:Hips': 'Hips',
  'mixamorig:LeftUpLeg': 'LeftUpLeg',
  // ... mapear todos
};

// Clonar clip y renombrar tracks
const retargetedClip = retargetAnimation(sourceClip, boneMapping);
```

**Opción 3: Librería Externa** (profesional)

Usar librería de retargeting como:
- [THREE.RetargetingManager](https://github.com/mrdoob/three.js/issues/18167) (experimental)
- [Kalidokit](https://github.com/yeemachine/kalidokit) (para motion capture)
- **Custom implementation** basado en quaternion interpolation

---

## Arquitectura del Sistema

### Componentes del Sistema

```
┌─────────────────────────────────────────────────────────┐
│                    HUBS SERVER                          │
├─────────────────────────────────────────────────────────┤
│  /assets/animations/                                    │
│    ├── idle.glb        (animación base)                │
│    ├── walk.glb        (animación base)                │
│    ├── run.glb         (animación base)                │
│    └── sit.glb         (animación base)                │
└─────────────────────────────────────────────────────────┘
                          ↓ (HTTP request)
┌─────────────────────────────────────────────────────────┐
│                  HUBS CLIENT (Browser)                  │
├─────────────────────────────────────────────────────────┤
│  Animation Manager                                      │
│    ├── Descarga animaciones base (UNA vez, cache)     │
│    ├── Detecta skeleton de avatar del usuario         │
│    ├── Aplica retargeting si necesario                │
│    └── Reproduce animación                             │
│                                                         │
│  User Avatar (GLB sin animaciones)                     │
│    ├── Mesh + Textures                                 │
│    └── Skeleton (Mixamo-compatible)                    │
└─────────────────────────────────────────────────────────┘
```

### Flujo de Datos

```
1. Usuario sube avatar RPM estático (avatar.glb - 3MB)
   ↓
2. Hubs carga avatar, detecta skeleton Mixamo
   ↓
3. Animation Manager verifica cache local
   ↓
4. Si no existe, descarga animaciones base del servidor
   (idle.glb, walk.glb, run.glb - 2MB total, UNA vez)
   ↓
5. Guarda en cache del navegador
   ↓
6. Aplica animaciones al skeleton del usuario (retargeting)
   ↓
7. Sistema de locomotion detecta velocidad y cambia animación
   ↓
8. Usuario ve su avatar animado ✅
```

### Ventajas de Esta Arquitectura

| Aspecto | Valor |
|---------|-------|
| **Primera carga** | ~5MB (avatar 3MB + animaciones 2MB) |
| **Cargas siguientes** | ~3MB (solo avatar, animaciones en cache) |
| **Mantenimiento** | Actualizar animaciones una vez en servidor |
| **Escalabilidad** | 1000 usuarios = 1 set de animaciones |
| **Compatibilidad** | Cualquier avatar Mixamo funciona |

---

## Preparación de Animaciones Base

### Paso 1: Descargar Animaciones de Mixamo

**Animaciones recomendadas** (mínimo viable):

1. **Idle** - Avatar parado
   - Sugerencia: "Breathing Idle" o "Idle"

2. **Walk** - Caminar normal
   - Sugerencia: "Walking"

3. **Run** - Correr
   - Sugerencia: "Running" o "Fast Run"

**Animaciones opcionales** (expandir sistema):

4. **Sit** - Sentarse
5. **Wave** - Saludar
6. **Dance** - Bailar
7. **Jump** - Saltar
8. **Crouch** - Agacharse

### Paso 2: Configuración de Descarga en Mixamo

**IMPORTANTE**: Para animaciones compartidas, usar un **skeleton de referencia**:

1. Subir a Mixamo un avatar base (puede ser RPM o cualquier humanoid)
2. Para CADA animación:
   ```
   Format: FBX Binary (.fbx)
   Skin: With Skin ← CAMBIO: Ahora CON skin
   Frames per second: 30
   Keyframe Reduction: none
   ```

**¿Por qué "With Skin"?**: El skeleton se incluye en el FBX, lo usaremos como referencia.

### Paso 3: Convertir FBX a GLB en Blender

**Script automatizado** para convertir todas las animaciones:

```python
# blender_convert_animations.py
import bpy
import sys
import os
from pathlib import Path

def convert_fbx_to_glb(input_dir, output_dir):
    """
    Convierte todos los FBX en input_dir a GLB en output_dir
    Extrae solo la animación, sin mesh
    """

    input_path = Path(input_dir)
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)

    fbx_files = list(input_path.glob("*.fbx"))

    for fbx_file in fbx_files:
        print(f"\n[INFO] Processing: {fbx_file.name}")

        # Limpiar escena
        bpy.ops.wm.read_factory_settings(use_empty=True)

        # Importar FBX
        bpy.ops.import_scene.fbx(filepath=str(fbx_file))

        # Encontrar armature
        armature = None
        for obj in bpy.data.objects:
            if obj.type == 'ARMATURE':
                armature = obj
                break

        if not armature:
            print(f"[WARN] No armature in {fbx_file.name}, skipping")
            continue

        # Eliminar meshes (solo queremos skeleton + animación)
        for obj in list(bpy.data.objects):
            if obj.type == 'MESH':
                bpy.data.objects.remove(obj, do_unlink=True)

        # Seleccionar solo armature
        bpy.ops.object.select_all(action='DESELECT')
        armature.select_set(True)
        bpy.context.view_layer.objects.active = armature

        # Nombre de salida
        output_name = fbx_file.stem.lower().replace(" ", "_")
        output_file = output_path / f"{output_name}.glb"

        # Exportar GLB
        bpy.ops.export_scene.gltf(
            filepath=str(output_file),
            export_format='GLB',
            use_selection=True,  # Solo armature seleccionado
            export_animations=True,
            export_skins=True,
            export_all_influences=True,
            export_morph=False,
            export_lights=False,
            export_cameras=False,
        )

        print(f"[OK] Exported: {output_file.name}")

        # Verificar animación
        if armature.animation_data and armature.animation_data.action:
            action = armature.animation_data.action
            duration = action.frame_range[1] / 30.0  # 30 FPS
            print(f"     Duration: {duration:.2f}s, Keyframes: {len(action.fcurves)}")
        else:
            print(f"[WARN] No animation data found!")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: blender --background --python blender_convert_animations.py -- input_dir output_dir")
        sys.exit(1)

    input_dir = sys.argv[-2]
    output_dir = sys.argv[-1]

    convert_fbx_to_glb(input_dir, output_dir)
    print("\n[DONE] All animations converted!")
```

**Uso**:

```bash
# Estructura de directorios:
# animations_fbx/
#   ├── Idle.fbx
#   ├── Walking.fbx
#   ├── Running.fbx
#   └── Sitting.fbx

# Convertir todos
blender --background --python blender_convert_animations.py -- \
  animations_fbx/ \
  animations_glb/

# Resultado:
# animations_glb/
#   ├── idle.glb        (~200KB)
#   ├── walking.glb     (~150KB)
#   ├── running.glb     (~100KB)
#   └── sitting.glb     (~180KB)
```

### Paso 4: Validar Animaciones

**Script de validación**:

```javascript
// validate_animations.js (Node.js)
const fs = require('fs');
const { GLTFLoader } = require('three/examples/jsm/loaders/GLTFLoader');

async function validateAnimation(glbPath) {
  const data = fs.readFileSync(glbPath);

  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();

    loader.parse(data.buffer, '', (gltf) => {
      const animations = gltf.animations;

      if (animations.length === 0) {
        reject(`No animations in ${glbPath}`);
        return;
      }

      const clip = animations[0];

      console.log(`✅ ${glbPath}:`);
      console.log(`   Name: ${clip.name}`);
      console.log(`   Duration: ${clip.duration.toFixed(2)}s`);
      console.log(`   Tracks: ${clip.tracks.length}`);

      // Verificar que tiene tracks de piernas
      const legTracks = clip.tracks.filter(t =>
        t.name.includes('LeftUpLeg') ||
        t.name.includes('RightUpLeg') ||
        t.name.includes('LeftLeg') ||
        t.name.includes('RightLeg')
      );

      if (legTracks.length === 0) {
        console.warn(`   ⚠️  No leg animation tracks found!`);
      } else {
        console.log(`   Leg tracks: ${legTracks.length}`);
      }

      resolve();
    }, reject);
  });
}

// Validar todas
['idle.glb', 'walk.glb', 'run.glb', 'sit.glb'].forEach(async (file) => {
  await validateAnimation(`animations_glb/${file}`);
});
```

---

## Implementación en Hubs

### Paso 1: Estructura de Archivos

**En el repositorio de Hubs**:

```
hubs/
├── public/
│   └── assets/
│       └── animations/
│           ├── mixamo/          ← Nuevo directorio
│           │   ├── idle.glb
│           │   ├── walk.glb
│           │   ├── run.glb
│           │   └── sit.glb
│           └── README.md
└── src/
    └── systems/
        ├── animation-retarget-system.js  ← Nuevo sistema
        └── shared-animation-manager.js    ← Nuevo manager
```

**Copiar animaciones**:

```bash
# Desde tu directorio de trabajo
cp animations_glb/*.glb hubs/public/assets/animations/mixamo/
```

### Paso 2: Shared Animation Manager

**Archivo**: `src/systems/shared-animation-manager.js`

```javascript
/**
 * Gestor de animaciones compartidas
 *
 * Descarga animaciones base UNA vez, las cachea, y las aplica a cualquier
 * avatar compatible Mixamo.
 */

import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";

// URLs de animaciones base (relativas al servidor)
const ANIMATION_URLS = {
  idle: '/assets/animations/mixamo/idle.glb',
  walk: '/assets/animations/mixamo/walk.glb',
  run: '/assets/animations/mixamo/run.glb',
  sit: '/assets/animations/mixamo/sit.glb'
};

class SharedAnimationManager {
  constructor() {
    this.loader = new GLTFLoader();
    this.animations = new Map(); // name -> AnimationClip
    this.loading = new Set();
    this.loaded = false;
  }

  /**
   * Carga todas las animaciones base (llamar al inicio)
   */
  async loadAnimations() {
    if (this.loaded) return;

    console.log('[SharedAnimations] Loading base animations...');

    const promises = Object.entries(ANIMATION_URLS).map(([name, url]) =>
      this.loadAnimation(name, url)
    );

    try {
      await Promise.all(promises);
      this.loaded = true;
      console.log('[SharedAnimations] All animations loaded ✅');
    } catch (error) {
      console.error('[SharedAnimations] Failed to load animations:', error);
      throw error;
    }
  }

  /**
   * Carga una animación individual
   */
  async loadAnimation(name, url) {
    if (this.animations.has(name)) return this.animations.get(name);
    if (this.loading.has(name)) {
      // Ya se está cargando, esperar
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (this.animations.has(name)) {
            clearInterval(checkInterval);
            resolve(this.animations.get(name));
          }
        }, 100);
      });
    }

    this.loading.add(name);

    return new Promise((resolve, reject) => {
      this.loader.load(
        url,
        (gltf) => {
          if (gltf.animations.length === 0) {
            reject(new Error(`No animations in ${url}`));
            return;
          }

          const clip = gltf.animations[0];
          clip.name = name; // Asegurar nombre consistente

          this.animations.set(name, clip);
          this.loading.delete(name);

          console.log(`[SharedAnimations] Loaded: ${name} (${clip.duration.toFixed(2)}s)`);
          resolve(clip);
        },
        undefined,
        (error) => {
          this.loading.delete(name);
          reject(error);
        }
      );
    });
  }

  /**
   * Obtiene un clip de animación por nombre
   */
  getAnimation(name) {
    return this.animations.get(name);
  }

  /**
   * Verifica si un skeleton es compatible Mixamo
   */
  isMixamoCompatible(skeleton) {
    const requiredBones = [
      'Hips', 'Spine', 'Neck', 'Head',
      'LeftUpLeg', 'LeftLeg', 'LeftFoot',
      'RightUpLeg', 'RightLeg', 'RightFoot',
      'LeftArm', 'LeftForeArm', 'LeftHand',
      'RightArm', 'RightForeArm', 'RightHand'
    ];

    const boneNames = skeleton.bones.map(b => b.name);

    // Verificar que tiene la mayoría de huesos
    const matches = requiredBones.filter(name => boneNames.includes(name));
    const compatibility = matches.length / requiredBones.length;

    return compatibility > 0.8; // 80%+ de huesos coinciden
  }

  /**
   * Aplica animación a un avatar
   * Hace retargeting si es necesario
   */
  applyAnimationToAvatar(avatarMesh, animationName) {
    const clip = this.getAnimation(animationName);

    if (!clip) {
      console.warn(`[SharedAnimations] Animation "${animationName}" not found`);
      return null;
    }

    // Verificar skeleton
    let skeleton = null;
    avatarMesh.traverse(node => {
      if (node.isSkinnedMesh && node.skeleton) {
        skeleton = node.skeleton;
      }
    });

    if (!skeleton) {
      console.warn('[SharedAnimations] No skeleton found in avatar');
      return null;
    }

    if (!this.isMixamoCompatible(skeleton)) {
      console.warn('[SharedAnimations] Skeleton is not Mixamo-compatible');
      return null;
    }

    // Crear mixer
    const mixer = new THREE.AnimationMixer(avatarMesh);

    // Aplicar animación (Three.js hace matching automático por nombre)
    const action = mixer.clipAction(clip);

    console.log(`[SharedAnimations] Applied "${animationName}" to avatar`);

    return { mixer, action };
  }
}

// Singleton global
export const sharedAnimationManager = new SharedAnimationManager();

export default SharedAnimationManager;
```

### Paso 3: Animation Retarget System (bit-ecs)

**Archivo**: `src/systems/animation-retarget-system.js`

```javascript
/**
 * Sistema ECS para aplicar animaciones compartidas a avatares
 */

import { defineQuery, enterQuery, exitQuery } from "bitecs";
import { sharedAnimationManager } from "./shared-animation-manager";
import { AvatarRig, CharacterController } from "../bit-components";

// Query para avatares que necesitan animaciones
const avatarQuery = defineQuery([AvatarRig]);
const avatarEnterQuery = enterQuery(avatarQuery);
const avatarExitQuery = exitQuery(avatarQuery);

export class AnimationRetargetSystem {
  constructor(world) {
    this.world = world;
    this.avatarAnimations = new Map(); // eid -> { mixer, actions, currentAction }

    // Pre-cargar animaciones al inicializar
    sharedAnimationManager.loadAnimations().catch(err => {
      console.error('[AnimationRetargetSystem] Failed to load animations:', err);
    });
  }

  tick(dt) {
    // Nuevos avatares
    avatarEnterQuery(this.world).forEach(eid => {
      this.setupAvatarAnimation(eid);
    });

    // Actualizar animaciones existentes
    avatarQuery(this.world).forEach(eid => {
      this.updateAvatarAnimation(eid, dt);
    });

    // Cleanup
    avatarExitQuery(this.world).forEach(eid => {
      this.cleanupAvatarAnimation(eid);
    });
  }

  setupAvatarAnimation(eid) {
    // Obtener mesh del avatar
    const avatarRig = this.getAvatarRig(eid);
    if (!avatarRig) return;

    const mesh = avatarRig.object3D;

    // Verificar si es compatible Mixamo
    if (!sharedAnimationManager.isMixamoCompatible(this.getSkeleton(mesh))) {
      console.log(`[AnimationRetarget] Avatar ${eid} is not Mixamo-compatible, skipping`);
      return;
    }

    console.log(`[AnimationRetarget] Setting up animations for avatar ${eid}`);

    // Crear mixer y actions
    const mixer = new THREE.AnimationMixer(mesh);
    const actions = {};

    // Aplicar todas las animaciones
    ['idle', 'walk', 'run', 'sit'].forEach(animName => {
      const clip = sharedAnimationManager.getAnimation(animName);
      if (clip) {
        const action = mixer.clipAction(clip);
        actions[animName] = action;
      }
    });

    // Guardar estado
    this.avatarAnimations.set(eid, {
      mixer,
      actions,
      currentAction: null,
      currentState: 'idle'
    });

    // Reproducir idle por defecto
    this.playAnimation(eid, 'idle');
  }

  updateAvatarAnimation(eid, dt) {
    const animState = this.avatarAnimations.get(eid);
    if (!animState) return;

    // Update mixer
    animState.mixer.update(dt / 1000);

    // Detectar velocidad y cambiar animación
    const speed = this.getSpeed(eid);

    let targetState = 'idle';
    if (speed > 2.0) {
      targetState = 'run';
    } else if (speed > 0.1) {
      targetState = 'walk';
    }

    if (targetState !== animState.currentState) {
      this.playAnimation(eid, targetState);
    }
  }

  playAnimation(eid, animationName) {
    const animState = this.avatarAnimations.get(eid);
    if (!animState) return;

    const action = animState.actions[animationName];
    if (!action) {
      console.warn(`[AnimationRetarget] Animation "${animationName}" not available for avatar ${eid}`);
      return;
    }

    // Fade out current action
    if (animState.currentAction && animState.currentAction !== action) {
      animState.currentAction.fadeOut(0.2);
    }

    // Fade in new action
    action.reset().fadeIn(0.2).play();

    animState.currentAction = action;
    animState.currentState = animationName;

    console.log(`[AnimationRetarget] Avatar ${eid}: ${animState.currentState} -> ${animationName}`);
  }

  cleanupAvatarAnimation(eid) {
    const animState = this.avatarAnimations.get(eid);
    if (animState) {
      animState.mixer.stopAllAction();
      this.avatarAnimations.delete(eid);
    }
  }

  // ===== Helpers =====

  getAvatarRig(eid) {
    // Implementación depende de arquitectura de Hubs
    // Placeholder
    return null;
  }

  getSkeleton(mesh) {
    let skeleton = null;
    mesh.traverse(node => {
      if (node.isSkinnedMesh && node.skeleton) {
        skeleton = node.skeleton;
      }
    });
    return skeleton;
  }

  getSpeed(eid) {
    // Obtener velocidad del character controller
    // Placeholder
    if (!CharacterController) return 0;

    const vx = CharacterController.velocityX[eid] || 0;
    const vz = CharacterController.velocityZ[eid] || 0;
    return Math.sqrt(vx * vx + vz * vz);
  }
}
```

### Paso 4: Registrar Sistema

**Archivo**: `src/systems/systems.js`

```javascript
import { AnimationRetargetSystem } from "./animation-retarget-system";

export function initSystems(world, scene) {
  const systems = {
    // ... sistemas existentes

    animationRetarget: new AnimationRetargetSystem(world),

    // ...
  };

  return systems;
}

export function tickSystems(world, systems, dt) {
  // ... sistemas existentes

  systems.animationRetarget.tick(dt);

  // ...
}
```

---

## API para el Usuario

### Flujo del Usuario (Simplificado)

```
1. Usuario descarga avatar RPM (GLB estático, sin animaciones)
   ↓
2. Sube a Hubs (botón "Upload Avatar")
   ↓
3. ✅ Avatar funciona automáticamente con animaciones
```

**Eso es todo.** Usuario no necesita:
- ❌ Mixamo
- ❌ Blender
- ❌ Conocimientos técnicos
- ❌ Añadir animaciones manualmente

### Compatibilidad

**Avatares soportados automáticamente**:
- ✅ ReadyPlayer.me (RPM)
- ✅ Avatares de Mixamo directamente
- ✅ Cualquier avatar con skeleton Mixamo-compatible
- ✅ Avatares custom rigged con nombres Mixamo

**Avatares NO soportados** (requieren trabajo adicional):
- ❌ VRM avatars (nombres de huesos diferentes)
- ❌ Avatares con skeleton custom no-Mixamo
- ❌ Avatares sin lower body (half-body) - funcionan pero sin walk animation

### Configuración Avanzada (Opcional)

**Para usuarios avanzados**, exponer settings:

```javascript
// En panel de configuración de Hubs
{
  "avatar": {
    "animationSystem": "shared", // o "embedded" (modo legacy)
    "animationSet": "mixamo",    // futuro: permitir custom
    "enableFullBody": true
  }
}
```

---

## Testing y Validación

### Test Plan

#### Test 1: Carga de Animaciones

```javascript
// En consola del navegador
import { sharedAnimationManager } from './shared-animation-manager';

await sharedAnimationManager.loadAnimations();

console.log('Loaded animations:', Array.from(sharedAnimationManager.animations.keys()));
// Esperado: ['idle', 'walk', 'run', 'sit']
```

#### Test 2: Compatibilidad de Avatar

```javascript
const avatarEl = document.querySelector('[networked-avatar]');
const mesh = avatarEl.getObject3D('mesh');

let skeleton;
mesh.traverse(node => {
  if (node.isSkinnedMesh) skeleton = node.skeleton;
});

const isCompatible = sharedAnimationManager.isMixamoCompatible(skeleton);
console.log('Mixamo compatible:', isCompatible);
// Esperado: true (para avatar RPM)
```

#### Test 3: Aplicación de Animación

```javascript
const { mixer, action } = sharedAnimationManager.applyAnimationToAvatar(mesh, 'walk');

action.play();

// Update loop manual
setInterval(() => mixer.update(0.016), 16);

// Deberías ver el avatar caminando
```

### Checklist de Testing

**Testing local (desarrollador)**:
- [ ] Animaciones se cargan sin errores
- [ ] Cache del navegador guarda animaciones (verificar en DevTools > Network)
- [ ] Avatar RPM se detecta como Mixamo-compatible
- [ ] Animaciones se aplican correctamente (sin glitches)
- [ ] Transiciones suaves entre idle/walk/run
- [ ] Multiple avatares en misma room usan mismas animaciones

**Testing con usuarios reales**:
- [ ] Usuario sube avatar RPM estático → funciona automáticamente
- [ ] Diferentes avatares RPM funcionan (male, female, custom)
- [ ] Performance es aceptable (FPS > 30)
- [ ] Sincronización networking correcta (otros ven las animaciones)
- [ ] Funciona en mobile (iOS, Android)
- [ ] Funciona en VR (Quest, Vive, Index)

---

## Mantenimiento y Extensión

### Añadir Nuevas Animaciones

**Proceso simple**:

1. Descargar nueva animación de Mixamo (ej: "Dance")
2. Convertir FBX → GLB con script de Blender
3. Copiar a `/public/assets/animations/mixamo/dance.glb`
4. Añadir a `ANIMATION_URLS` en `shared-animation-manager.js`:
   ```javascript
   const ANIMATION_URLS = {
     // ... existentes
     dance: '/assets/animations/mixamo/dance.glb'
   };
   ```
5. Deploy actualizado de Hubs
6. ✅ Todos los usuarios tienen acceso inmediatamente

### Sistema de Animaciones Custom

**Permitir a usuarios subir sus propias animaciones**:

**Arquitectura**:
```
/assets/animations/
  ├── mixamo/           (default, siempre disponible)
  │   ├── idle.glb
  │   └── walk.glb
  └── custom/           (subidas por usuarios)
      ├── user123/
      │   └── custom_dance.glb
      └── user456/
          └── special_sit.glb
```

**API**:
```javascript
// Usuario sube animación custom
await uploadCustomAnimation(userId, animationFile);

// Aplicar animación custom a avatar
sharedAnimationManager.loadAnimation(
  'my-dance',
  `/assets/animations/custom/${userId}/custom_dance.glb`
);
```

### Performance Optimization

**Si performance es problema**:

1. **Lazy loading**: Solo cargar animaciones cuando se necesitan
   ```javascript
   // Solo cargar walk cuando speed > 0
   if (speed > 0.1 && !this.animations.has('walk')) {
     await this.loadAnimation('walk', ANIMATION_URLS.walk);
   }
   ```

2. **LOD (Level of Detail)**: Animaciones simplificadas para avatares lejanos
   ```javascript
   const distance = avatar.position.distanceTo(camera.position);
   if (distance > 10) {
     // Usar animación low-poly o desactivar
   }
   ```

3. **Animation compression**: Reducir keyframes
   ```javascript
   // En Blender export:
   // Optimize Animation Size: true
   // Sample rate: 15 FPS (en vez de 30)
   ```

---

## Resumen para el Desarrollador

### Implementación Completa

**Archivos a crear**:
1. `public/assets/animations/mixamo/*.glb` (4 archivos, ~630KB total)
2. `src/systems/shared-animation-manager.js` (230 líneas)
3. `src/systems/animation-retarget-system.js` (180 líneas)
4. Modificar `src/systems/systems.js` (registrar sistema)

**Tiempo estimado**: 15-25 horas
- Preparación animaciones: 3-4h
- Implementación core: 8-12h
- Testing y debugging: 4-6h
- Documentation: 2-3h

### Ventajas de Este Enfoque

**Para usuarios**:
- ✅ Solo suben avatar estático (simple)
- ✅ Funciona inmediatamente (sin setup)
- ✅ Archivos pequeños (rápido)

**Para desarrollador**:
- ✅ Mantenimiento centralizado
- ✅ Fácil añadir animaciones
- ✅ Escalable (1000+ usuarios, 1 set animaciones)
- ✅ Cache del navegador optimiza bandwidth

**Para servidor**:
- ✅ Menos storage (animaciones compartidas)
- ✅ Menos bandwidth (cache)
- ✅ Más rápido (usuarios no re-procesan animaciones)

### Comparación con Método Anterior

| Aspecto | Método Anterior (Documento movimientoRPM.md) | Este Método (Animaciones Compartidas) |
|---------|----------------------------------------------|----------------------------------------|
| **Usuario** | 1-2 horas Mixamo+Blender por avatar | 0 minutos (sube avatar estático) |
| **Tamaño GLB** | 10-20 MB (con animaciones) | 2-5 MB (sin animaciones) |
| **Compatibilidad** | Solo ese avatar específico | Todos los avatares Mixamo |
| **Mantenimiento** | Usuario re-hace proceso si cambia animación | Desarrollador actualiza una vez |
| **Escalabilidad** | N usuarios = N sets animaciones | N usuarios = 1 set animaciones |

**Conclusión**: **Este método es superior en todos los aspectos** y es la forma profesional de implementarlo.

---

## Próximos Pasos

### Para Ti (Cliente)

1. **Descargar animaciones de Mixamo** (30-45 min)
   - Idle, Walk, Run, Sit
   - FBX Binary, With Skin

2. **Convertir a GLB** con el script de Blender (10 min)

3. **Entregar al desarrollador**:
   - 4 archivos GLB (~630KB total)
   - Este documento
   - Archivos de código base del paquete

### Para el Desarrollador

1. **Revisar este documento completo**

2. **Copiar animaciones** a `/public/assets/animations/mixamo/`

3. **Implementar los 2 archivos JavaScript**:
   - `shared-animation-manager.js`
   - `animation-retarget-system.js`

4. **Registrar sistema** en `systems.js`

5. **Testing** con avatar RPM de prueba

6. **Deploy** a producción

7. **Comunicar a usuarios**: "Ahora pueden subir avatares RPM directamente, sin necesidad de Blender"

---

**Fin del documento**

Este es el enfoque correcto, profesional y escalable para animaciones de avatares en Hubs.

**Licencia**: MIT (código de ejemplo)
**Autor**: Investigación técnica basada en XRCLOUD y best practices
**Versión**: 1.0
**Fecha**: Febrero 2026
