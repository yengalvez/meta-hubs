# Integración de ReadyPlayer.me Full-Body Avatars en Hubs Foundation 2.0.0

**Fecha**: Febrero 2026
**Versión**: 1.0
**Autor**: Investigación técnica completa

---

## Tabla de Contenidos

1. [Resumen Ejecutivo](#resumen-ejecutivo)
2. [Estado Actual del Ecosistema](#estado-actual-del-ecosistema)
3. [Arquitectura de Avatares en Hubs](#arquitectura-de-avatares-en-hubs)
4. [Estructura de Esqueleto RPM vs Hubs](#estructura-de-esqueleto-rpm-vs-hubs)
5. [Problemas Conocidos y Limitaciones](#problemas-conocidos-y-limitaciones)
6. [Soluciones Implementadas: XRCLOUD](#soluciones-implementadas-xrcloud)
7. [Guía de Implementación](#guía-de-implementación)
8. [Ejemplos de Código](#ejemplos-de-código)
9. [Testing y Validación](#testing-y-validación)
10. [Referencias](#referencias)

---

## Resumen Ejecutivo

### Contexto

ReadyPlayer.me (RPM) ha cerrado su servicio, pero miles de avatares .glb descargados siguen siendo un activo valioso. Este documento detalla cómo integrar avatares full-body de RPM en Hubs Foundation 2.0.0, basándose en:

- Implementación exitosa de XRCLOUD/BELIVVR (código open source disponible)
- Especificaciones técnicas de la estructura de huesos Mixamo-compatible de RPM
- Sistema de avatares bit-ecs de Hubs Foundation
- Issues y discusiones de la comunidad Hubs

### Objetivos del Proyecto

1. **Subir avatares RPM descargados** (.glb) a tu instancia Hubs 2.0.0
2. **Sistema full-body funcional** con movimiento de piernas y cámara en tercera persona
3. **Compatibilidad** con el sistema de avatares existente de Hubs
4. **Sin errores** de esqueleto, IK, o animación

### Nivel de Complejidad

- **Dificultad**: Alta (requiere fork y modificación del core de Hubs)
- **Tiempo estimado**: 40-60 horas de desarrollo + testing
- **Conocimientos**: Three.js, A-Frame, bit-ecs, Blender (básico), Node.js

---

## Estado Actual del Ecosistema

### ReadyPlayer.me

**Estado**: Servicio operativo pero el iframe ya no es viable para integración
**Avatares existentes**: Los archivos .glb descargados mantienen su validez técnica
**Formato**: GLB con skeleton Mixamo-compatible

#### Especificaciones Técnicas RPM

**Full-Body Avatars**:
- Root armature: `Armature`
- Skeleton: Mixamo-compatible (53+ huesos)
- Formato: GLB con texturas embebidas
- Altura estándar: ~1.75m
- Soporte para animaciones Mixamo

**Estructura de huesos** (simplificada):
```
Armature
├── Hips
│   ├── Spine
│   │   ├── Spine1
│   │   │   ├── Spine2
│   │   │   │   ├── Neck
│   │   │   │   │   └── Head
│   │   │   │   ├── LeftShoulder
│   │   │   │   │   └── LeftArm → LeftForeArm → LeftHand
│   │   │   │   └── RightShoulder
│   │   │       └── RightArm → RightForeArm → RightHand
│   ├── LeftUpLeg
│   │   └── LeftLeg → LeftFoot → LeftToeBase
│   └── RightUpLeg
│       └── RightLeg → RightFoot → RightToeBase
```

### Hubs Foundation 2.0.0

**Sistema de avatares actual**:
- **Half-body only** (cabeza, torso, brazos, sin piernas)
- **Sin IK** para codos o piernas
- **Skeleton**: Basado en High Fidelity, nombres hard-coded
- **Arquitectura**: bit-ecs (ECS) + Three.js scene graph híbrido

**Limitaciones documentadas**:
> "Hubs ha eliminado algunos huesos de la jerarquía, específicamente lower body y arm joints, ya que no están usando IK en este momento. Esto es principalmente porque Hubs es una aplicación web donde tiempos de descarga grandes pueden afectar el rendimiento, especialmente en móviles."

**Fuente**: [Hubs-Foundation/hubs-avatar-pipelines](https://github.com/Hubs-Foundation/hubs-avatar-pipelines)

### XRCLOUD - Solución Full-Body Existente

**Estado**: Open source (Febrero 2025), proyecto descontinuado por BELIVVR
**Repositorios**:
- [luke-n-alpha/xrcloud](https://github.com/luke-n-alpha/xrcloud)
- [luke-n-alpha/xrcloud-avatar-editor](https://github.com/luke-n-alpha/xrcloud-avatar-editor)
- [belivvr/xrcloud-avatar-editor](https://github.com/belivvr/xrcloud-avatar-editor)

**Características implementadas**:
- Full-body avatars funcionales
- Sistema de "Blueprint" (Male/Female)
- Editor de avatares por partes
- Saltar (con reset del eje Y al suelo)
- Vista en tercera persona
- Cámara libre

**Limitaciones conocidas**:
> "El proyecto de avatar no está diseñado considerando bit-ecs, por lo que no soporta todas las características de Hubs. El avatar full-body resetea el valor Y al suelo al saltar, por lo que no puede saltar."

**Fuente**: [BELIVVR Open Source Announcement](https://medium.com/belivvr-en/open-source-the-xrcloud-mozilla-hub-full-body-avatar-editor-by-belivvr-9396d11687e5)

---

## Arquitectura de Avatares en Hubs

### Sistema bit-ecs

Hubs Foundation utiliza **bitECS**, un ECS (Entity Component System) para gestionar el estado del juego fuera del scene graph de Three.js.

#### Conceptos Clave

**Entity**: Un ID numérico (índice en arrays tipados)
**Component**: Datos estructurados en TypedArrays
**System**: Lógica que opera sobre entities con componentes específicos

#### Estructura de Avatar en Hubs

```javascript
// Ejemplo conceptual de la estructura
Entity ID: 42
├── NetworkedAvatar Component
│   ├── owner: sessionId
│   └── avatarSrc: "url-to-glb"
├── PlayerInfo Component
│   ├── displayName: "Usuario"
│   └── presence: "room"
├── IKRoot Component
│   ├── headEntity: 43
│   ├── leftHandEntity: 44
│   └── rightHandEntity: 45
└── AvatarRig Component (Three.js Object3D)
    └── skeleton: THREE.Skeleton
```

### Archivos Clave

**Cliente (hubs/src/)**:
- `hub.html`: Define la estructura HTML/A-Frame de la escena
- `hub.js`: Inicialización y lógica principal
- `systems/`: Contiene los sistemas ECS
  - `avatar-system.js`: Gestión de avatares
- `components/`: Componentes A-Frame custom
  - `networked-avatar.js`: Sincronización de avatares
- `inflators/`: Funciones que inicializan componentes desde parámetros
- `avatar-utils.js`: Utilidades para manejo de avatares

**Pipelines (hubs-avatar-pipelines/)**:
- `Blender/AvatarBot/`: Assets base del avatar robot
  - `AvatarBot_base_for_export.blend`: Esqueleto y rig
  - Animaciones de dedos para controladores 6DOF

### Flujo de Carga de Avatar

```
1. Usuario selecciona avatar (GLB URL)
   ↓
2. PlayerInfo actualizado con avatarSrc
   ↓
3. Sistema de avatares detecta cambio
   ↓
4. GLTFLoader carga modelo
   ↓
5. Validación de skeleton (nombre de huesos)
   ↓
6. Instantiate en scene graph Three.js
   ↓
7. IKRoot setup (cabeza, manos tracking)
   ↓
8. NetworkedAvatar sincroniza con otros clientes
```

### Sistema IK Actual

**Componentes trackeados** (VR):
- Cabeza (HMD)
- Mano izquierda (controlador)
- Mano derecha (controlador)

**Sin tracking**:
- Codos (sin IK)
- Piernas (no existen en half-body)
- Cadera/torso (inferido de posición de cabeza)

---

## Estructura de Esqueleto RPM vs Hubs

### Comparación de Esqueletos

| Característica | ReadyPlayer.me | Hubs (Actual) | Compatibilidad |
|---------------|----------------|---------------|----------------|
| Root Name | `Armature` | Varía | ⚠️ Requiere mapeo |
| Jerarquía | Mixamo (53+ huesos) | High Fidelity simplificado | ❌ Incompatible |
| Lower Body | ✅ Completo | ❌ No existe | ❌ Requiere implementación |
| Upper Body | ✅ Mixamo | ✅ High Fidelity | ⚠️ Requiere mapeo |
| Nombres Hard-coded | No | Sí | ❌ Requiere modificación |
| IK Support | Mixamo animations | Sin IK | ❌ Requiere implementación |

### Tabla de Mapeo de Huesos

#### Upper Body (Zona compatible con modificaciones)

| Mixamo (RPM) | High Fidelity (Hubs) | Notas |
|--------------|----------------------|-------|
| Hips | Hips | Root del skeleton |
| Spine | Spine | Torso bajo |
| Spine1 | Spine1 | Torso medio |
| Spine2 | Spine2 | Torso alto |
| Neck | Neck | Cuello |
| Head | Head | Cabeza |
| LeftShoulder | LeftShoulder | Hombro izquierdo |
| LeftArm | LeftArm | Brazo superior izquierdo |
| LeftForeArm | LeftForeArm | Antebrazo izquierdo |
| LeftHand | LeftHand | Mano izquierda |

#### Lower Body (NO existe en Hubs actual)

| Mixamo (RPM) | High Fidelity (Hubs) | Estado |
|--------------|----------------------|--------|
| LeftUpLeg | ❌ No existe | ⚠️ Requiere añadir |
| LeftLeg | ❌ No existe | ⚠️ Requiere añadir |
| LeftFoot | ❌ No existe | ⚠️ Requiere añadir |
| LeftToeBase | ❌ No existe | ⚠️ Requiere añadir |
| RightUpLeg | ❌ No existe | ⚠️ Requiere añadir |
| RightLeg | ❌ No existe | ⚠️ Requiere añadir |
| RightFoot | ❌ No existe | ⚠️ Requiere añadir |
| RightToeBase | ❌ No existe | ⚠️ Requiere añadir |

### Issue: Nombres Hard-coded

**Problema**: Hubs valida nombres de huesos contra una lista hard-coded.

**Ubicación en código** (aproximada):
```javascript
// src/utils/avatar-utils.js o similar
const REQUIRED_BONES = [
  "Hips", "Spine", "Spine1", "Spine2",
  "Neck", "Head",
  "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
  // ... (sin lower body)
];
```

**Solución**: Modificar el validador para aceptar esqueleto Mixamo completo.

---

## Problemas Conocidos y Limitaciones

### Issues de GitHub Documentados

#### 1. Full Body Avatars No Soportados Oficialmente

**Issue**: [Hubs-Foundation/hubs #3203](https://github.com/Hubs-Foundation/hubs/discussions/3203)

> "¿Hay alguna forma de usar avatares full-body en Hubs?"
> **Respuesta oficial**: "Actualmente no tenemos planes de hacer avatares full-body en nuestro roadmap."

**Implicaciones**:
- No hay soporte nativo
- Requiere fork y desarrollo custom
- Sin garantía de compatibilidad con futuras versiones

#### 2. Tercera Persona con ReadyPlayer.me

**Issue**: [Hubs-Foundation/hubs #5532](https://github.com/mozilla/hubs/issues/5532)

> "Característica para usar el avatar de readyplayerme en vista de tercera persona. La cámara del usuario estaría posicionada atrás del avatar para poder ver las piernas animarse mientras se mueven por la escena."

**Estado**: Trabajo en progreso mencionado, nunca completado oficialmente

**Implicaciones**:
- Vista tercera persona esencial para full-body
- Requiere implementación de cámara follow
- Necesita sistema de animación de piernas

#### 3. Avatar No Usa Jerarquía Esperada

**Issue**: [mozilla/hubs #3403](https://github.com/mozilla/hubs/issues/3403)

> "Avatares full-body no están actualmente soportados, y el formato de avatar no está usando la jerarquía esperada para avatares Hubs."

**Implicaciones**:
- Validación estricta de skeleton
- Requiere adaptador/mapper de huesos
- Posibles errores en runtime si no se mapea correctamente

#### 4. Expresiones Faciales con RPM

**Issue**: [Hubs-Foundation/hubs #4847](https://github.com/mozilla/hubs/issues/4847)

> "Al poner el avatar half-body de Ready Player Me en Hubs.Mozilla, encontramos que la expresión facial del avatar es muy vívida. Sin embargo, NO es fácil identificar quién está hablando en el entorno VR."

**Implicaciones**:
- Half-body RPM funciona (con limitaciones)
- Audio-visual sync es un desafío
- Expresiones faciales son soportadas pero requieren indicadores visuales

### Limitaciones Técnicas

#### 1. Falta de IK para Lower Body

**Problema**: Hubs no implementa IK (Inverse Kinematics) para piernas.

**Consecuencias**:
- Piernas estáticas sin movimiento realista
- No puede usar tracking de pies (full-body tracking VR)
- Animaciones procedurales difíciles de implementar

**Soluciones posibles**:
1. **Animaciones cíclicas**: Loop de caminar/correr basado en velocidad
2. **IK procedural simple**: Two-bone IK para rodillas (costoso en performance)
3. **Hybrid**: Animaciones blend + ajustes IK mínimos

#### 2. Performance en Web

**Problema**: Full-body avatars son pesados (vértices, texturas, huesos).

**Impacto**:
- Móviles pueden sufrir FPS drops
- Bandwidth para sincronización mayor
- Más draw calls y complejidad de rendering

**Mitigaciones**:
- LOD (Level of Detail) automático
- Texture atlas (Ready Player Me ya lo soporta)
- Draco compression (con cuidado, puede no funcionar)
- Limitar número de avatares full-body simultáneos

#### 3. Compatibilidad Mixamo vs High Fidelity

**Problema**: Diferencias en bone naming y orientación.

| Aspecto | Mixamo | High Fidelity |
|---------|--------|---------------|
| Bone orientation | Y-up (default) | Varía |
| Twist bones | Sí (arms) | No |
| Finger bones | 3 por dedo | Simplificado |
| Foot IK targets | Sí | No |

**Soluciones**:
- Script de pre-procesamiento en Blender (ver ejemplos)
- Runtime bone mapper en código Hubs
- Conversión automática al subir avatar

---

## Soluciones Implementadas: XRCLOUD

### Análisis de la Implementación XRCLOUD

XRCLOUD (por BELIVVR) es la **única implementación open-source conocida** de full-body avatars en Hubs. Aunque el proyecto está descontinuado, su código es MIT licensed y extremadamente valioso.

#### Arquitectura XRCLOUD

**Blueprint System**:
```javascript
// Concepto de Blueprints
const blueprints = {
  male: {
    skeleton: 'assets/skeletons/male_mixamo.glb',
    parts: ['head', 'torso', 'legs', 'feet'],
    height: 1.75
  },
  female: {
    skeleton: 'assets/skeletons/female_mixamo.glb',
    parts: ['head', 'torso', 'legs', 'feet'],
    height: 1.68
  }
};
```

**Avatar Combiner**:
- Usuarios seleccionan partes (cabeza, ropa, piernas, zapatos)
- Sistema combina meshes en runtime
- Genera thumbnail y guarda en DB
- Usa `avatarUrl` query parameter para carga

**Características Clave**:
1. **Full-body rendering**: Meshes completos incluyendo piernas
2. **Jump mechanic**: Sistema de salto (con limitación conocida)
3. **Third-person camera**: Cámara detrás del avatar
4. **Movement animation**: Animaciones básicas al moverse

#### Limitaciones XRCLOUD

> "El proyecto de avatar no está diseñado considerando bit-ecs, por lo que no soporta todas las características de Hubs."

**Problemas identificados**:
1. **No integrado con bit-ecs**: Implementación paralela/legacy
2. **Jump bug**: Resetea Y al suelo, impidiendo saltos reales
3. **Performance**: No optimizado para múltiples usuarios
4. **Partial feature set**: Falta integración con nuevas features de Hubs

#### Valor para Nuestra Implementación

**Lo que podemos aprovechar**:
✅ Lógica de carga de full-body avatars
✅ Sistema de cámara en tercera persona
✅ Mapeo de skeleton Mixamo a Hubs
✅ Componentes de animación básica

**Lo que debemos reimplementar**:
❌ Integración completa con bit-ecs
❌ Sistema IK procedural
❌ Optimizaciones de performance
❌ Sincronización networking robusta

### Repositorios XRCLOUD

**Repositorios principales**:
- [luke-n-alpha/xrcloud](https://github.com/luke-n-alpha/xrcloud) - Fork principal de Hubs
- [luke-n-alpha/xrcloud-avatar-editor](https://github.com/luke-n-alpha/xrcloud-avatar-editor) - Editor React
- [belivvr/xrcloud-avatar-editor](https://github.com/belivvr/xrcloud-avatar-editor) - Fork actualizado

**Cómo explorar**:
```bash
# Clonar repositorio principal
git clone https://github.com/luke-n-alpha/xrcloud.git
cd xrcloud

# Buscar cambios relacionados con avatares
git log --all --grep="avatar" --grep="full.body" --oneline

# Comparar con Hubs original (si tienes ambos repos)
git diff mozilla/hubs:main...luke-n-alpha/xrcloud:main -- src/systems/ src/components/

# Ver archivos modificados
git log --name-status --diff-filter=M -- "*avatar*"
```

**Archivos de interés** (basado en estructura típica de Hubs):
- `src/systems/avatar-system.js` - Modificaciones al sistema principal
- `src/components/avatar-*.js` - Componentes custom
- `src/assets/` - Blueprints y skeletons base
- `src/utils/avatar-utils.js` - Utilidades modificadas

---

## Guía de Implementación

### Fase 1: Preparación del Entorno (2-4 horas)

#### 1.1 Fork de Hubs Foundation

```bash
# Clonar Hubs Foundation 2.0.0
git clone https://github.com/Hubs-Foundation/hubs.git hubs-rpm-fullbody
cd hubs-rpm-fullbody

# Crear rama de desarrollo
git checkout -b feature/rpm-fullbody-avatars

# Instalar dependencias
npm ci
```

#### 1.2 Setup de Desarrollo

```bash
# Copiar configuración
cp .env.defaults .env

# Configurar variables (editar .env)
# - BASE_ASSETS_PATH
# - RETICULUM_SERVER (tu instancia)
# - etc.

# Verificar build
npm run dev

# Debería arrancar en https://localhost:8080
```

#### 1.3 Backup y Testing

```bash
# Crear rama de testing
git checkout -b test/rpm-integration-sandbox

# Siempre commitear antes de cambios mayores
git commit -am "Checkpoint antes de modificar avatar system"
```

### Fase 2: Análisis de Avatares RPM (4-6 horas)

#### 2.1 Inspección de Avatares Descargados

```bash
# Instalar herramientas
npm install -g gltf-pipeline
pip install pygltflib

# Inspeccionar un avatar RPM
gltf-pipeline -i avatar_rpm.glb --stats

# Output esperado:
# - Triangles: ~10k-30k
# - Textures: 1-3 (atlas)
# - Bones: 53-65 (Mixamo)
# - Animations: 0 (avatares estáticos)
```

#### 2.2 Script de Análisis de Skeleton

Crear `scripts/analyze-rpm-skeleton.js`:

```javascript
const fs = require('fs');
const { GLTFLoader } = require('three/examples/jsm/loaders/GLTFLoader');

async function analyzeAvatar(glbPath) {
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.load(glbPath, resolve, undefined, reject);
  });

  console.log('=== Avatar Analysis ===');

  gltf.scene.traverse((node) => {
    if (node.isSkinnedMesh) {
      console.log('\\nSkinnedMesh found:', node.name);
      console.log('Bones:', node.skeleton.bones.length);

      console.log('\\nBone Hierarchy:');
      node.skeleton.bones.forEach((bone, idx) => {
        const depth = getDepth(bone);
        const indent = '  '.repeat(depth);
        console.log(`${indent}${bone.name}`);
      });
    }
  });
}

function getDepth(bone) {
  let depth = 0;
  let current = bone;
  while (current.parent) {
    depth++;
    current = current.parent;
  }
  return depth;
}

// Uso
analyzeAvatar(process.argv[2]);
```

Ejecutar:
```bash
node scripts/analyze-rpm-skeleton.js ~/Descargas/avatar_rpm.glb
```

#### 2.3 Identificar Diferencias Clave

Crear documento de mapeo:

```markdown
# Bone Mapping: RPM → Hubs

## Coincidencias Directas (OK)
- Hips → Hips ✅
- Spine → Spine ✅
- Neck → Neck ✅
- Head → Head ✅

## Requieren Mapeo (Nombres diferentes)
- Spine1 (RPM) → Spine1 (Hubs) ✅ pero orden diferente
- Spine2 (RPM) → Spine2 (Hubs) ✅ pero orden diferente

## No Existen en Hubs (CRÍTICO)
- LeftUpLeg ❌
- LeftLeg ❌
- LeftFoot ❌
- LeftToeBase ❌
- RightUpLeg ❌
- RightLeg ❌
- RightFoot ❌
- RightToeBase ❌

## Acción Requerida
1. Modificar validador de skeleton para aceptar estos huesos
2. Implementar rendering de lower body
3. Añadir animaciones procedurales o cíclicas para piernas
```

### Fase 3: Modificación del Core de Hubs (15-20 horas)

#### 3.1 Extender Validador de Skeleton

**Archivo**: `src/utils/avatar-utils.js` (ubicación aproximada)

```javascript
// ANTES (Hubs original)
const REQUIRED_BONES = [
  "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
  "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
  "RightShoulder", "RightArm", "RightForeArm", "RightHand"
];

function validateAvatarSkeleton(skeleton) {
  const boneNames = skeleton.bones.map(b => b.name);
  const missing = REQUIRED_BONES.filter(name => !boneNames.includes(name));

  if (missing.length > 0) {
    throw new Error(`Missing required bones: ${missing.join(', ')}`);
  }

  return true;
}

// DESPUÉS (Soporte full-body)
const REQUIRED_BONES_UPPER = [
  "Hips", "Spine", "Neck", "Head",
  "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
  "RightShoulder", "RightArm", "RightForeArm", "RightHand"
];

const OPTIONAL_BONES_SPINE = ["Spine1", "Spine2"];

const FULLBODY_BONES_LOWER = [
  "LeftUpLeg", "LeftLeg", "LeftFoot",
  "RightUpLeg", "RightLeg", "RightFoot"
];

function validateAvatarSkeleton(skeleton) {
  const boneNames = skeleton.bones.map(b => b.name);

  // Validar upper body (requerido)
  const missingUpper = REQUIRED_BONES_UPPER.filter(name => !boneNames.includes(name));
  if (missingUpper.length > 0) {
    throw new Error(`Missing required upper body bones: ${missingUpper.join(', ')}`);
  }

  // Detectar si es full-body
  const hasLowerBody = FULLBODY_BONES_LOWER.every(name => boneNames.includes(name));

  return {
    valid: true,
    isFullBody: hasLowerBody,
    boneCount: skeleton.bones.length
  };
}

// Exportar
export { validateAvatarSkeleton };
```

#### 3.2 Componente Full-Body Avatar

**Archivo nuevo**: `src/components/fullbody-avatar.js`

```javascript
import { SYSTEMS } from "../systems/systems";

AFRAME.registerComponent("fullbody-avatar", {
  schema: {
    isFullBody: { type: "boolean", default: false },
    showLegs: { type: "boolean", default: true }
  },

  init() {
    this.skeleton = null;
    this.lowerBodyBones = {};
    this.mixer = null;
    this.currentAnimation = null;

    this.el.addEventListener("model-loaded", this.onModelLoaded.bind(this));
  },

  onModelLoaded() {
    const object3D = this.el.getObject3D("mesh");
    if (!object3D) return;

    // Encontrar skeleton
    object3D.traverse((node) => {
      if (node.isSkinnedMesh && node.skeleton) {
        this.skeleton = node.skeleton;
        this.setupLowerBody();
      }
    });
  },

  setupLowerBody() {
    if (!this.skeleton) return;

    // Mapear lower body bones
    const boneNames = ["LeftUpLeg", "LeftLeg", "LeftFoot",
                      "RightUpLeg", "RightLeg", "RightFoot"];

    this.skeleton.bones.forEach(bone => {
      if (boneNames.includes(bone.name)) {
        this.lowerBodyBones[bone.name] = bone;
      }
    });

    const hasAllBones = boneNames.every(name => this.lowerBodyBones[name]);

    if (hasAllBones) {
      console.log("[FullBody] Lower body bones detected and mapped");
      this.data.isFullBody = true;
      this.setupAnimations();
    } else {
      console.warn("[FullBody] Incomplete lower body skeleton");
      this.data.isFullBody = false;
    }
  },

  setupAnimations() {
    // TODO: Cargar animaciones de caminar/idle
    // Por ahora, las piernas permanecerán en bind pose
    console.log("[FullBody] Animation system ready (placeholder)");
  },

  tick(time, deltaTime) {
    if (!this.data.isFullBody) return;

    // Actualizar animaciones si existen
    if (this.mixer) {
      this.mixer.update(deltaTime / 1000);
    }
  },

  remove() {
    if (this.mixer) {
      this.mixer.stopAllAction();
    }
  }
});
```

#### 3.3 Sistema de Animación Procedural

**Archivo nuevo**: `src/systems/fullbody-animation-system.js`

```javascript
import { defineQuery, enterQuery, exitQuery } from "bitecs";

// Query para entities con full-body avatar
const fullbodyQuery = defineQuery([FullBodyAvatar, AvatarRig]);
const fullbodyEnterQuery = enterQuery(fullbodyQuery);
const fullbodyExitQuery = exitQuery(fullbodyQuery);

export class FullBodyAnimationSystem {
  constructor(world, avatarSystem) {
    this.world = world;
    this.avatarSystem = avatarSystem;

    this.animationStates = new Map(); // eid -> animation state
  }

  tick(dt) {
    // Nuevos full-body avatars
    fullbodyEnterQuery(this.world).forEach(eid => {
      this.initializeFullBodyAvatar(eid);
    });

    // Update existing
    fullbodyQuery(this.world).forEach(eid => {
      this.updateFullBodyAnimation(eid, dt);
    });

    // Cleanup
    fullbodyExitQuery(this.world).forEach(eid => {
      this.cleanupFullBodyAvatar(eid);
    });
  }

  initializeFullBodyAvatar(eid) {
    console.log(`[FullBodySystem] Initialize entity ${eid}`);

    const state = {
      isMoving: false,
      velocity: { x: 0, y: 0, z: 0 },
      speed: 0,
      animationState: 'idle'
    };

    this.animationStates.set(eid, state);
  }

  updateFullBodyAnimation(eid, dt) {
    const state = this.animationStates.get(eid);
    if (!state) return;

    // Obtener velocity del entity (desde physics o networked)
    // const velocity = getVelocity(eid); // Placeholder
    const speed = 0; // Math.sqrt(velocity.x ** 2 + velocity.z ** 2);

    // Determinar estado de animación
    let newAnimState = 'idle';
    if (speed > 0.1) {
      newAnimState = speed > 2.0 ? 'run' : 'walk';
    }

    // Transicionar si cambió
    if (newAnimState !== state.animationState) {
      this.transitionAnimation(eid, state.animationState, newAnimState);
      state.animationState = newAnimState;
    }

    // Actualizar leg IK (procedural básico)
    this.updateProceduralLegs(eid, speed, dt);
  }

  transitionAnimation(eid, from, to) {
    console.log(`[FullBodySystem] ${eid}: ${from} -> ${to}`);
    // TODO: Implementar fade entre animaciones
  }

  updateProceduralLegs(eid, speed, dt) {
    // Animación procedural simple de piernas
    // Basado en speed y time

    // TODO: Implementar ciclo de caminar
    // - Calcular fase del ciclo basado en tiempo
    // - Rotar LeftUpLeg y RightUpLeg en X (swing)
    // - Bend LeftLeg y RightLeg en Z (knee bend)
    // - Pitch LeftFoot y RightFoot para contacto con suelo

    // Placeholder
    const time = Date.now() / 1000;
    const cyclePhase = (time * speed) % 1.0;

    // Swing legs alternating
    // leftLegAngle = sin(cyclePhase * 2π) * maxSwing
    // rightLegAngle = sin((cyclePhase + 0.5) * 2π) * maxSwing
  }

  cleanupFullBodyAvatar(eid) {
    this.animationStates.delete(eid);
  }
}

// Registrar en systems.js
// import { FullBodyAnimationSystem } from "./fullbody-animation-system";
// export const SYSTEMS = { ..., fullbodyAnimation: FullBodyAnimationSystem };
```

#### 3.4 Cámara en Tercera Persona

**Archivo nuevo**: `src/systems/third-person-camera-system.js`

```javascript
import { defineQuery } from "bitecs";
import { ThirdPersonCamera } from "../bit-components"; // Crear componente

const thirdPersonQuery = defineQuery([ThirdPersonCamera, AvatarRig]);

export class ThirdPersonCameraSystem {
  constructor(world, camera) {
    this.world = world;
    this.camera = camera; // THREE.Camera
    this.enabled = false;

    this.offset = { x: 0, y: 1.6, z: 2.5 }; // Detrás y arriba del avatar
    this.lookAtOffset = { x: 0, y: 1.2, z: 0 }; // Punto de mirada (cabeza)

    this.smoothing = 0.1; // Suavizado de cámara
  }

  enable(eid) {
    this.enabled = true;
    this.targetEid = eid;
  }

  disable() {
    this.enabled = false;
    this.targetEid = null;
  }

  tick(dt) {
    if (!this.enabled || !this.targetEid) return;

    const avatarRig = this.getAvatarRigObject3D(this.targetEid);
    if (!avatarRig) return;

    // Posición del avatar
    const avatarPos = avatarRig.position;
    const avatarRot = avatarRig.rotation;

    // Calcular posición target de cámara (detrás del avatar)
    const targetPos = {
      x: avatarPos.x - Math.sin(avatarRot.y) * this.offset.z,
      y: avatarPos.y + this.offset.y,
      z: avatarPos.z - Math.cos(avatarRot.y) * this.offset.z
    };

    // Suavizar movimiento de cámara (lerp)
    this.camera.position.x += (targetPos.x - this.camera.position.x) * this.smoothing;
    this.camera.position.y += (targetPos.y - this.camera.position.y) * this.smoothing;
    this.camera.position.z += (targetPos.z - this.camera.position.z) * this.smoothing;

    // Look at avatar head
    const lookAtPos = {
      x: avatarPos.x + this.lookAtOffset.x,
      y: avatarPos.y + this.lookAtOffset.y,
      z: avatarPos.z + this.lookAtOffset.z
    };

    this.camera.lookAt(lookAtPos.x, lookAtPos.y, lookAtPos.z);
  }

  getAvatarRigObject3D(eid) {
    // Obtener Object3D del entity
    // Depende de la arquitectura de Hubs
    // return world.eid2obj.get(eid); // Placeholder
    return null;
  }
}
```

#### 3.5 Integración en Sistema Principal

**Archivo**: `src/systems/systems.js`

```javascript
import { FullBodyAnimationSystem } from "./fullbody-animation-system";
import { ThirdPersonCameraSystem } from "./third-person-camera-system";

// En la inicialización de sistemas
export function initSystems(world, scene) {
  const systems = {
    // ... sistemas existentes

    fullbodyAnimation: new FullBodyAnimationSystem(world, systems.avatar),
    thirdPersonCamera: new ThirdPersonCameraSystem(world, scene.camera),

    // ...
  };

  return systems;
}

// En el game loop
export function tickSystems(world, systems, dt) {
  // ... sistemas existentes

  systems.fullbodyAnimation.tick(dt);
  systems.thirdPersonCamera.tick(dt);

  // ...
}
```

### Fase 4: Subida y Validación de Avatares (5-8 horas)

#### 4.1 Endpoint de Subida Custom

**Archivo backend**: `reticulum/lib/ret_web/controllers/api/v1/avatar_controller.ex` (o similar)

```elixir
# Añadir validación de full-body avatars
defmodule RetWeb.Api.V1.AvatarController do
  use RetWeb, :controller

  def create(conn, %{"avatar" => avatar_params}) do
    with {:ok, glb_data} <- validate_glb(avatar_params["file"]),
         {:ok, skeleton_info} <- analyze_skeleton(glb_data),
         {:ok, avatar} <- Avatars.create_avatar(avatar_params, skeleton_info) do

      conn
      |> put_status(:created)
      |> json(%{
        avatar_id: avatar.id,
        glb_url: avatar.glb_url,
        is_fullbody: skeleton_info.is_fullbody
      })
    else
      {:error, reason} ->
        conn
        |> put_status(:unprocessable_entity)
        |> json(%{error: reason})
    end
  end

  defp analyze_skeleton(glb_data) do
    # Llamar a script Node.js para analizar skeleton
    # Ver scripts/analyze-rpm-skeleton.js

    # Retornar
    {:ok, %{
      is_fullbody: true,
      bone_count: 65,
      has_lower_body: true
    }}
  end
end
```

#### 4.2 Script de Pre-procesamiento (Blender)

**Archivo**: `scripts/prepare-rpm-avatar.py`

```python
import bpy
import sys
import os

def prepare_rpm_for_hubs(input_glb, output_glb):
    """
    Pre-procesa un avatar RPM para compatibilidad con Hubs:
    1. Verifica skeleton Mixamo
    2. Ajusta escala a 1.7m
    3. Centra en origen
    4. Optimiza geometría (opcional)
    5. Exporta GLB optimizado
    """

    # Limpiar escena
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Importar GLB
    bpy.ops.import_scene.gltf(filepath=input_glb)

    # Encontrar armature
    armature = None
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE':
            armature = obj
            break

    if not armature:
        print("ERROR: No armature found in GLB")
        sys.exit(1)

    print(f"Found armature: {armature.name}")
    print(f"Bones: {len(armature.data.bones)}")

    # Listar huesos
    print("\nBone hierarchy:")
    for bone in armature.data.bones:
        depth = len(list(bone.parent_recursive))
        indent = "  " * depth
        print(f"{indent}- {bone.name}")

    # Verificar lower body
    lower_body_bones = ["LeftUpLeg", "LeftLeg", "LeftFoot",
                       "RightUpLeg", "RightLeg", "RightFoot"]
    has_lower_body = all(armature.data.bones.get(name) for name in lower_body_bones)

    print(f"\nHas lower body: {has_lower_body}")

    # Ajustar escala (si necesario)
    # Calcular altura actual
    head_bone = armature.data.bones.get("Head")
    if head_bone:
        current_height = head_bone.head_local.z + armature.location.z
        target_height = 1.7  # metros
        scale_factor = target_height / current_height

        print(f"Current height: {current_height:.2f}m, scaling by {scale_factor:.2f}")
        armature.scale = (scale_factor, scale_factor, scale_factor)
        bpy.ops.object.transform_apply(scale=True)

    # Centar en origen
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.origin_set(type='ORIGIN_CENTER_OF_VOLUME', center='BOUNDS')

    # Exportar
    bpy.ops.export_scene.gltf(
        filepath=output_glb,
        export_format='GLB',
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_colors=True,
        export_cameras=False,
        export_lights=False,
        export_skins=True,
        export_animations=False,  # Avatares son estáticos
        export_optimize_animation_size=False,
    )

    print(f"\nExported to: {output_glb}")
    print("✅ Avatar ready for Hubs!")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: blender --background --python prepare-rpm-avatar.py -- input.glb output.glb")
        sys.exit(1)

    input_glb = sys.argv[-2]
    output_glb = sys.argv[-1]

    prepare_rpm_for_hubs(input_glb, output_glb)
```

**Uso**:
```bash
blender --background --python scripts/prepare-rpm-avatar.py -- \
  ~/Descargas/avatar_rpm_original.glb \
  ~/Descargas/avatar_rpm_hubs.glb
```

#### 4.3 Optimización de Assets

```bash
# Comprimir texturas (opcional)
gltf-pipeline -i avatar_rpm_hubs.glb -o avatar_rpm_optimized.glb \
  --draco.compressionLevel 7

# NOTA: Draco puede causar problemas en Hubs (ver Issue #6209)
# Probar sin compresión primero

# Generar texture atlas (si no lo tiene)
# Ready Player Me ya debería tenerlo
```

#### 4.4 Subida a Hubs

**Opción 1: UI de Hubs (simple)**
```
1. Abrir Hubs room
2. Click en avatar
3. "Avatar GLB URL" o "Upload GLB"
4. Seleccionar avatar_rpm_hubs.glb
5. Esperar carga y validación
```

**Opción 2: API directa (avanzado)**
```bash
# Subir a storage (AWS S3, Cloudflare R2, etc.)
aws s3 cp avatar_rpm_hubs.glb s3://mi-bucket/avatars/avatar_001.glb

# Obtener URL pública
AVATAR_URL="https://mi-bucket.s3.amazonaws.com/avatars/avatar_001.glb"

# Configurar en perfil
curl -X POST https://mi-hubs.com/api/v1/avatars \
  -H "Authorization: Bearer $TOKEN" \
  -d "{"glb_url": "$AVATAR_URL", "name": "Mi Avatar RPM"}"
```

### Fase 5: Testing y Debugging (8-12 horas)

#### 5.1 Checklist de Testing

**Carga de Avatar**:
- [ ] Avatar carga sin errores de consola
- [ ] Skeleton se valida correctamente
- [ ] Texturas se aplican correctamente
- [ ] Escala es correcta (~1.7m de altura)
- [ ] Lower body es visible

**Rendering**:
- [ ] Upper body renderiza correctamente
- [ ] Lower body renderiza correctamente
- [ ] No z-fighting o artifacts visuales
- [ ] Materiales PBR funcionan
- [ ] Transparencias (pelo, ropa) funcionan

**Networking**:
- [ ] Avatar sincroniza con otros usuarios
- [ ] Posición se actualiza en tiempo real
- [ ] Rotación (head, hands) sincroniza
- [ ] Lower body visible para otros usuarios

**Performance**:
- [ ] FPS estable (>30 FPS en desktop, >60 ideal)
- [ ] Sin lag en mobile (probar en dispositivo real)
- [ ] Múltiples avatares full-body (test con 5-10 usuarios)

**Animaciones** (si implementadas):
- [ ] Idle animation reproduce
- [ ] Walk animation activa al moverse
- [ ] Transiciones suaves entre estados
- [ ] Piernas no se clippean con el suelo

**Cámara Tercera Persona** (si implementada):
- [ ] Cámara sigue al avatar suavemente
- [ ] Distancia y altura correctas
- [ ] Look-at apunta a cabeza/torso
- [ ] No colisiona con geometría

#### 5.2 Errores Comunes y Soluciones

**Error: "Invalid skeleton: missing required bones"**
```
Causa: Validador no reconoce skeleton Mixamo
Solución: Verificar que modificaste avatar-utils.js correctamente
```

**Error: "Failed to load GLB: NetworkError"**
```
Causa: CORS, URL inválida, o archivo corrupto
Solución:
- Verificar CORS headers en storage
- Probar URL en navegador directamente
- Re-exportar GLB desde Blender
```

**Avatar aparece negro/sin texturas**
```
Causa: Texturas no se cargaron o materiales inválidos
Solución:
- Abrir GLB en Blender, verificar materiales
- Comprobar que texturas están embebidas en GLB
- Verificar Content-Type del servidor (debe ser model/gltf-binary)
```

**Lower body no es visible**
```
Causa: Meshes de piernas no se renderizan
Solución:
- Verificar que fullbody-avatar component está activo
- Console.log en setupLowerBody() para debug
- Comprobar que meshes no tienen layer incorrecto
```

**Performance terrible con full-body**
```
Causa: Demasiados vértices, sin LOD, sin optimización
Solución:
- Reducir poly count en Blender (Decimate modifier)
- Implementar LOD system (ver docs de Hubs)
- Limitar número de full-body avatars simultáneos
```

**Piernas en pose T o extraña**
```
Causa: Bind pose incorrecta o animaciones no funcionan
Solución:
- Verificar bind pose en Blender (debe ser A-pose o T-pose consistente)
- Comprobar que animaciones se están aplicando
- Revisar fullbody-animation-system.js logs
```

#### 5.3 Debugging Tools

**Browser DevTools**:
```javascript
// En consola de navegador

// Inspeccionar avatar entity
const avatarEl = document.querySelector('[networked-avatar]');
console.log(avatarEl.components);

// Ver skeleton
const mesh = avatarEl.getObject3D('mesh');
mesh.traverse(node => {
  if (node.isSkinnedMesh) {
    console.log('Skeleton:', node.skeleton);
    console.log('Bones:', node.skeleton.bones.map(b => b.name));
  }
});

// Monitorear performance
const stats = document.querySelector('[stats]');
// Ver FPS, entities, geometries, calls
```

**Hubs Debug Mode**:
```
URL: https://tu-hubs.com/room-id?debugMode=true

Features:
- Show bone gizmos
- Performance overlay
- Network stats
- Entity inspector
```

**Blender Verification**:
```python
# Script para verificar avatar en Blender
import bpy

armature = bpy.data.objects['Armature']

# Listar todos los huesos
for bone in armature.data.bones:
    print(f"{bone.name}: parent={bone.parent.name if bone.parent else 'None'}")

# Verificar bind pose
bpy.ops.object.mode_set(mode='POSE')
bpy.ops.pose.transforms_clear()  # Reset a bind pose

# Exportar test
bpy.ops.export_scene.gltf(filepath='/tmp/test_avatar.glb')
```

---

## Ejemplos de Código

Ver archivos adjuntos:

1. `avatar-utils-extended.js` - Validador de skeleton modificado
2. `fullbody-avatar-component.js` - Componente A-Frame completo
3. `fullbody-animation-system.js` - Sistema bit-ecs de animación
4. `third-person-camera-system.js` - Sistema de cámara
5. `prepare-rpm-avatar.py` - Script Blender de pre-procesamiento
6. `analyze-rpm-skeleton.js` - Análisis de estructura de huesos

---

## Testing y Validación

### Plan de Testing

**Fase 1: Unit Tests**
- Validador de skeleton con fixtures RPM
- Bone mapper con diferentes configuraciones
- Sistema de animación (mocks)

**Fase 2: Integration Tests**
- Carga de avatar completa end-to-end
- Networking con múltiples clientes
- Performance benchmarks

**Fase 3: User Acceptance Testing**
- Beta testers con avatares propios
- Testing en diferentes dispositivos (desktop, mobile, VR)
- Stress test con 10+ usuarios simultáneos

### Métricas de Éxito

| Métrica | Target | Crítico |
|---------|--------|---------|
| FPS (desktop) | >60 | >30 |
| FPS (mobile) | >30 | >20 |
| Load time (avatar) | <3s | <5s |
| Network sync delay | <100ms | <200ms |
| Crash rate | 0% | <1% |

---

## Referencias

### Documentación Oficial

- [Hubs Foundation Documentation](https://docs.hubsfoundation.org/)
- [Hubs-Foundation/hubs GitHub](https://github.com/Hubs-Foundation/hubs)
- [Hubs-Foundation/hubs-avatar-pipelines](https://github.com/Hubs-Foundation/hubs-avatar-pipelines)
- [Ready Player Me Documentation](https://docs.readyplayer.me/)
- [Mixamo Documentation](https://www.mixamo.com/)

### Repositorios Open Source

- [luke-n-alpha/xrcloud](https://github.com/luke-n-alpha/xrcloud)
- [luke-n-alpha/xrcloud-avatar-editor](https://github.com/luke-n-alpha/xrcloud-avatar-editor)
- [belivvr/xrcloud-avatar-editor](https://github.com/belivvr/xrcloud-avatar-editor)

### Issues y Discusiones

- [Full body avatars at readyplayer.me #3203](https://github.com/Hubs-Foundation/hubs/discussions/3203)
- [3rd person view with ready player me characters #5532](https://github.com/Hubs-Foundation/hubs/issues/5532)
- [Big avatar doesn't let you see #3403](https://github.com/mozilla/hubs/issues/3403)
- [Ready Player Me avatar facial expression #4847](https://github.com/Hubs-Foundation/hubs/issues/4847)

### Artículos Técnicos

- [Open source the XRCLOUD full-body avatar editor by BELIVVR](https://medium.com/belivvr-en/open-source-the-xrcloud-mozilla-hub-full-body-avatar-editor-by-belivvr-9396d11687e5)
- [Are you want to use Fullbody-avatar in Mozilla Hubs?](https://medium.com/@ourbelivvr/are-you-want-to-use-fullbody-avatar-in-mozilla-hubs-here-is-how-947477c20308)
- [Advanced Avatar Customization - Hubs](https://docs.hubsfoundation.org/creators-advanced-avatar-customization.html)
- [Ready Player Me Full-body avatars](https://docs.readyplayer.me/ready-player-me/api-reference/avatars/full-body-avatars)

### Herramientas

- [gltf-pipeline](https://github.com/CesiumGS/gltf-pipeline) - Optimización de GLB
- [Blender](https://www.blender.org/) - Modelado y pre-procesamiento
- [Three.js](https://threejs.org/) - Rendering 3D
- [A-Frame](https://aframe.io/) - Framework WebVR
- [bitECS](https://github.com/NateTheGreatt/bitECS) - Entity Component System

---

## Conclusión

La integración de avatares full-body de ReadyPlayer.me en Hubs Foundation 2.0.0 es **técnicamente viable** pero requiere:

1. **Fork y modificación profunda** del core de Hubs
2. **Implementación de sistemas nuevos** (animación lower body, cámara tercera persona)
3. **Testing exhaustivo** para garantizar estabilidad
4. **Consideraciones de performance** para mantener experiencia fluida

El precedente de XRCLOUD demuestra que es posible, aunque su implementación tiene limitaciones. Una implementación propia, integrada correctamente con bit-ecs y optimizada, puede lograr resultados superiores.

**Tiempo estimado total**: 40-60 horas de desarrollo + 15-20 horas de testing

**Recomendación**: Comenzar con una implementación mínima (solo rendering de lower body, sin animaciones complejas) y iterar basándose en feedback y performance.

---

**Documento generado**: Febrero 2026
**Versión**: 1.0
**Licencia**: MIT (código de ejemplo)
**Contacto**: Para consultas técnicas, referirse a los issues de GitHub listados en Referencias
