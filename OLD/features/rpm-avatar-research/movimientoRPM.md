# Movimiento y Animaciones de Avatares ReadyPlayer.me en Hubs

**Última actualización**: Febrero 2026

---

## Índice

1. [¿Por Qué Mi Avatar RPM No Se Mueve?](#por-qué-mi-avatar-rpm-no-se-mueve)
2. [Cómo Funcionan las Animaciones en Hubs](#cómo-funcionan-las-animaciones-en-hubs)
3. [Sistema IK y Tracking de Manos](#sistema-ik-y-tracking-de-manos)
4. [Solución: Añadir Animaciones Mixamo](#solución-añadir-animaciones-mixamo)
5. [Proceso Completo Paso a Paso](#proceso-completo-paso-a-paso)
6. [Problemas Comunes y Soluciones](#problemas-comunes-y-soluciones)
7. [Información para el Desarrollador](#información-para-el-desarrollador)
8. [Implementación de Sentarse](#implementación-de-sentarse)
9. [Referencias](#referencias)

---

## ¿Por Qué Mi Avatar RPM No Se Mueve?

### Diagnóstico del Problema

Tu avatar de ReadyPlayer.me **no se mueve automáticamente** en Hubs por las siguientes razones:

#### 1. **Avatares RPM Son Estáticos por Diseño**

Los archivos GLB descargados de ReadyPlayer.me **NO incluyen animaciones**. Son modelos estáticos en pose A-pose o T-pose.

```
Avatar RPM descargado:
├── Geometría (mesh) ✅
├── Texturas ✅
├── Skeleton (Mixamo) ✅
└── Animaciones ❌ NO INCLUIDAS
```

#### 2. **Hubs No Tiene Sistema de Locomotion Automático**

A diferencia de plataformas como VRChat o Unity, **Hubs no genera animaciones de caminar automáticamente**. Los avatares de Hubs se mueven de estas formas:

| Parte del Avatar | Cómo Se Mueve | Estado Actual RPM |
|------------------|---------------|-------------------|
| **Cabeza** | IK tracking (VR headset o mouse) | ✅ Funciona |
| **Manos** | IK tracking (VR controllers) | ⚠️ Puede fallar (ver abajo) |
| **Torso** | Se infiere de posición de cabeza | ✅ Funciona |
| **Piernas** | Animaciones pre-hechas o procedurales | ❌ NO implementado en Hubs |

#### 3. **Sistema Half-Body de Hubs**

Hubs fue diseñado originalmente para **avatares half-body** (sin piernas). Tu avatar RPM tiene piernas, pero Hubs:

- ❌ No las anima automáticamente
- ❌ No tiene sistema de IK para piernas
- ❌ No tiene ciclos de caminar/correr por defecto

### Resumen: ¿Qué Funciona y Qué No?

| Funcionalidad | Estado | Explicación |
|--------------|--------|-------------|
| Avatar carga | ✅ Funciona | El modelo GLB se ve en Hubs |
| Cabeza se mueve | ✅ Funciona | Sigue tu cámara/headset |
| Manos se mueven | ⚠️ A veces falla | Requiere configuración correcta |
| Avatar camina/corre | ❌ No funciona | Necesita animaciones añadidas |
| Piernas se mueven | ❌ No funciona | Sin animaciones ni IK |
| Avatar se sienta | ❌ No funciona | Requiere implementación custom |

---

## Cómo Funcionan las Animaciones en Hubs

### Arquitectura de Animaciones

Hubs usa **Three.js** para rendering, que incluye un sistema de animaciones basado en `AnimationMixer`:

```javascript
// Concepto simplificado
const mixer = new THREE.AnimationMixer(avatarModel);

// Cargar clip de animación del GLB
const clip = avatarModel.animations[0]; // ej: "walk"

// Crear acción
const action = mixer.clipAction(clip);
action.play();

// Update en cada frame
function animate(deltaTime) {
  mixer.update(deltaTime);
}
```

### Tipos de Animaciones en Hubs

Hubs soporta 3 tipos de animaciones:

#### 1. **Animaciones Embebidas en GLB** (tu caso)

El GLB puede incluir clips de animación pre-hechos:

```
avatar.glb
├── Scene
├── Meshes
├── Materials
├── Skeleton
└── Animations
    ├── idle
    ├── walk
    ├── run
    └── sit
```

**Estado actual de avatares RPM**: ❌ Sin animaciones embebidas

#### 2. **Animaciones de Manos (VR Controllers)**

Hubs incluye animaciones de dedos para VR:

- `fist` - Puño cerrado
- `point` - Índice apuntando
- `open` - Mano abierta
- `thumbsUp` - Pulgar arriba

Estas están en `hubs-avatar-pipelines/Blender/AvatarBot/` y son **Actions** de Blender.

#### 3. **Animaciones Procedurales (Código)**

Animaciones generadas en runtime mediante código:

```javascript
// Ejemplo: hacer que las piernas se muevan sinusoidalmente
leftLeg.rotation.x = Math.sin(time) * 0.5;
rightLeg.rotation.x = Math.sin(time + Math.PI) * 0.5;
```

**Limitación**: Hubs no tiene esto implementado para locomotion.

### Flujo de Animación Esperado

```
1. Usuario presiona W (avanzar)
   ↓
2. Sistema de movimiento mueve avatar (posición X, Z)
   ↓
3. Sistema de animación detecta velocidad > 0
   ↓
4. Reproduce clip "walk"
   ↓
5. Piernas se animan según el clip
```

**Tu problema**: Paso 3-5 **no existen** para avatares full-body en Hubs estándar.

---

## Sistema IK y Tracking de Manos

### Qué Es IK (Inverse Kinematics)

IK permite que partes del avatar sigan posiciones target:

```
Target (VR Controller) → IK Solver → Mueve brazo + antebrazo + mano
```

Hubs usa IK **solo para**:
- ✅ Cabeza (sigue headset/cámara)
- ✅ Manos (sigue VR controllers)

Hubs **NO usa IK para**:
- ❌ Codos (los calcula aproximadamente)
- ❌ Piernas
- ❌ Pies

### Problema: Manos No Se Mueven

#### Síntoma

> "Las manos de mi avatar no responden a los controladores VR. Se quedan planas/estáticas."

#### Causa

Este es un **problema conocido** de exportación desde Blender. Fuente: [GitHub Discussion #2827](https://github.com/Hubs-Foundation/hubs/discussions/2827)

**Causa raíz**: Las animaciones de dedos están configuradas incorrectamente en Blender al exportar.

#### Solución

**En Blender, antes de exportar**:

1. **Abrir Animation Window**
   - En Blender, ir a `Window > Animation`

2. **Desmarcar TODAS las checkboxes de animaciones**
   - Esto desactiva animaciones que pueden conflictuar

3. **Abrir Export Settings (File > Export > glTF 2.0)**
   - Buscar sección "Animation"
   - **Desmarcar "Always Sample Animations"**

4. **Exportar GLB**

**Después de estos cambios**, las manos deberían responder correctamente a VR controllers.

### Configuración de Bones para IK de Manos

Hubs busca estos huesos específicos para IK:

| Bone Name (Hubs) | Bone Name (Mixamo/RPM) | Función |
|------------------|------------------------|---------|
| `Head` | `Head` | Tracking de cabeza |
| `LeftHand` | `LeftHand` | Tracking mano izquierda |
| `RightHand` | `RightHand` | Tracking mano derecha |

Si estos nombres no coinciden exactamente, el IK puede fallar.

### Animaciones de Dedos

Para que los **dedos individuales** se muevan (ej: hacer puño, apuntar):

**Requerimiento**: Huesos de dedos con nombres específicos:

```
LeftHand/RightHand
├── Thumb1, Thumb2, Thumb3
├── Index1, Index2, Index3
├── Middle1, Middle2, Middle3
├── Ring1, Ring2, Ring3
└── Pinky1, Pinky2, Pinky3
```

**Avatares RPM**: Usualmente tienen estos huesos ✅

**Problema**: Las **Actions de Blender** (animaciones de poses de dedos) no están configuradas.

**Solución**: Importar actions desde `AvatarBot_base_for_export.blend` de Hubs (ver sección de Mixamo).

---

## Solución: Añadir Animaciones Mixamo

### Visión General

**Mixamo** es una biblioteca gratuita de animaciones 3D compatible con avatares humanoides (incluyendo RPM).

**Objetivo**: Descargar animaciones de Mixamo y añadirlas a tu avatar RPM en formato GLB.

### Requisitos

- ✅ Avatar RPM descargado (`.glb`)
- ✅ Blender 3.0+ instalado
- ✅ Cuenta en Mixamo (gratuita)
- ✅ Conocimientos básicos de Blender

### Flujo de Trabajo Completo

```
Avatar RPM → Mixamo → Descargar FBX → Blender → Combinar → Exportar GLB → Hubs
```

---

## Proceso Completo Paso a Paso

### Fase 1: Preparar Avatar en Mixamo (30-45 min)

#### Paso 1.1: Subir Avatar a Mixamo

1. Ir a [mixamo.com](https://www.mixamo.com/)
2. Crear cuenta o login
3. Click en **"Upload Character"**

**IMPORTANTE**: Mixamo **NO acepta GLB directamente**. Debes convertir primero:

**Opción A: Usar Blender para convertir GLB → FBX**

```bash
# Abrir Blender
blender --background --python - << EOF
import bpy
bpy.ops.import_scene.gltf(filepath="avatar_rpm.glb")
bpy.ops.export_scene.fbx(filepath="avatar_rpm.fbx", use_selection=False)
bpy.ops.wm.quit_blender()
EOF
```

**Opción B: Usar herramienta online**
- [https://products.aspose.app/3d/conversion/glb-to-fbx](https://products.aspose.app/3d/conversion/glb-to-fbx)

4. Subir `avatar_rpm.fbx` a Mixamo
5. Esperar a que Mixamo auto-rig el avatar (1-2 min)
6. Verificar que el rigging es correcto (mover sliders de prueba)

#### Paso 1.2: Seleccionar Animaciones

Mixamo tiene **miles** de animaciones. Para Hubs, necesitas al menos:

**Esenciales**:
- ✅ **Idle** - Avatar parado (ej: "Idle" o "Breathing Idle")
- ✅ **Walking** - Caminar (ej: "Walking" o "Walking Forward")
- ✅ **Running** - Correr (ej: "Running" o "Fast Run")

**Opcionales (futuro)**:
- Sitting - Sentarse (ej: "Sitting Idle")
- Waving - Saludar
- Dancing - Bailar
- Jumping - Saltar

#### Paso 1.3: Descargar Animaciones

**Para CADA animación**:

1. Click en la animación en Mixamo
2. Click en **"Download"**
3. **Configuración CRÍTICA**:
   ```
   Format: FBX Binary (.fbx)
   Skin: Without Skin ← IMPORTANTE
   Frames per second: 30
   Keyframe Reduction: none
   ```

4. Click "Download"
5. Repetir para cada animación (idle, walk, run)

**Resultado**: Tendrás archivos como:
- `Idle.fbx`
- `Walking.fbx`
- `Running.fbx`

---

### Fase 2: Combinar en Blender (1-2 horas)

**Objetivo**: Importar avatar y animaciones en Blender, combinarlas en un solo GLB.

#### Paso 2.1: Importar Avatar Base

1. Abrir Blender (nueva escena)
2. Borrar todo (`A` para seleccionar todo, `X` para borrar)
3. `File > Import > glTF 2.0 (.glb/.gltf)`
4. Seleccionar `avatar_rpm.glb`
5. **IMPORTANTE**: En opciones de importación:
   - ✅ Marcar "Guess Original Bind Pose"
   - ✅ Marcar "Bone Direction: Blender (best for re-importing)"

**Verificar**: Deberías ver tu avatar en la escena. Seleccionar armature y verificar que tiene ~53-65 huesos.

#### Paso 2.2: Importar Animaciones Mixamo

**Para cada animación FBX**:

1. `File > Import > FBX (.fbx)`
2. Seleccionar `Idle.fbx` (empezar con esta)
3. **Opciones de importación CRÍTICAS**:
   ```
   ✅ Import Animation
   ✅ Automatic Bone Orientation
   ❌ Deselect: Import Normals
   ```
4. Click "Import FBX"

**Resultado**: Aparecerá un **segundo armature** con la animación.

#### Paso 2.3: Transferir Animación al Avatar Original

Ahora debes **copiar la animación** del armature de Mixamo a tu avatar RPM:

**Método 1: Action Editor (recomendado)**

1. Seleccionar el **armature de Mixamo** (el que acabas de importar)
2. Cambiar a `Dope Sheet` editor (arriba de la ventana)
3. Cambiar mode a **"Action Editor"**
4. Verás una acción llamada `Armature|Idle` o similar
5. Click en el icono de **"Fake User"** (escudo) para preservarla
6. Renombrar a `idle` (sin espacios, minúsculas)

7. Seleccionar **armature de tu avatar RPM** (original)
8. En Action Editor, click en **"Browse Action"** (icono de dos flechas)
9. Seleccionar `idle` de la lista
10. Ahora tu avatar tiene la animación idle asignada

**Método 2: NLA Editor (avanzado)**

Si quieres **múltiples animaciones en un solo GLB**:

1. Cambiar a `Nonlinear Animation` editor
2. Para el armature de avatar RPM, click en `Add > Action Strip`
3. Seleccionar acción `idle`
4. Repetir para cada animación (`walk`, `run`, etc.)

#### Paso 2.4: Limpiar Escena

**Borrar armatures de Mixamo** (ya no los necesitas):

1. Seleccionar armature importado de Mixamo
2. Presionar `X > Delete`
3. Repetir para todos los imports de Mixamo

**Resultado**: Solo debe quedar tu avatar RPM original con las animaciones asignadas.

#### Paso 2.5: Configurar Animaciones para Export

**CRÍTICO para que Hubs las detecte**:

1. Seleccionar armature de avatar
2. Ir a `Dope Sheet > Action Editor`
3. Para cada action/animation:
   - Asignar "Fake User" (escudo)
   - Renombrar con nombres claros: `idle`, `walk`, `run`
   - Verificar que tiene keyframes (deben verse en timeline)

**Configurar en NLA Track** (opcional pero recomendado):

1. Cambiar a `Nonlinear Animation` editor
2. Push cada action como NLA strip
3. Mute todos menos uno (ej: deja `idle` activo)

**¿Por qué NLA?**: Permite que Hubs detecte múltiples animaciones como clips separados.

#### Paso 2.6: Verificar Animaciones

**Test rápido**:

1. En timeline (abajo), presionar `Spacebar` para reproducir
2. Tu avatar debería animarse
3. Si no se mueve, revisar:
   - ¿La acción está asignada al armature correcto?
   - ¿Hay keyframes en el timeline?
   - ¿El armature es el parent de las meshes?

#### Paso 2.7: Exportar GLB Final

**Exportar con configuración específica para Hubs**:

1. `File > Export > glTF 2.0 (.glb/.gltf)`
2. **Configuración CRÍTICA**:

```
Format: glTF Binary (.glb)
Include:
  ✅ Selected Objects (si solo seleccionaste avatar)
  ❌ Cameras
  ❌ Lights

Transform:
  ✅ +Y Up

Geometry:
  ✅ Apply Modifiers
  ✅ UVs
  ✅ Normals
  ✅ Tangents
  ✅ Vertex Colors
  Material: Export

Animation:
  ✅ Animation
  ❌ Always Sample Animations ← MUY IMPORTANTE
  ✅ Group by NLA Track (si usaste NLA)
  ❌ Export Deformation Bones Only
  ✅ Optimize Animation Size
```

3. **Nombre del archivo**: `avatar_rpm_animated.glb`
4. Click "Export glTF 2.0"

**RESULTADO**: Tienes un GLB con animaciones embebidas ✅

---

### Fase 3: Integración en Hubs (30 min - 2 horas)

#### Paso 3.1: Subir Avatar a Hubs

**Opción A: Upload directo**

1. Entrar a tu room en Hubs
2. Click en avatar (esquina inferior izquierda)
3. "Upload Avatar" o "Create Avatar"
4. Subir `avatar_rpm_animated.glb`
5. Esperar carga (puede tardar 1-2 min)

**Opción B: Usar URL de storage**

1. Subir GLB a tu storage (AWS S3, Cloudflare R2, etc.)
   ```bash
   aws s3 cp avatar_rpm_animated.glb s3://mi-bucket/avatars/
   ```

2. Obtener URL pública:
   ```
   https://mi-bucket.s3.amazonaws.com/avatars/avatar_rpm_animated.glb
   ```

3. En Hubs, usar "Avatar GLB URL" y pegar la URL

#### Paso 3.2: Verificar en Consola del Navegador

**Abrir DevTools** (`F12` en Chrome/Firefox):

```javascript
// Inspeccionar avatar cargado
const avatarEl = document.querySelector('[networked-avatar]');
const mesh = avatarEl.getObject3D('mesh');

// Ver animaciones disponibles
console.log('Animations:', mesh.animations);

// Deberías ver algo como:
// [
//   { name: 'idle', duration: 2.5, ... },
//   { name: 'walk', duration: 1.33, ... },
//   { name: 'run', duration: 0.8, ... }
// ]
```

**Si ves las animaciones**: ✅ Export correcto

**Si `animations` está vacío**: ❌ Problema en export de Blender (revisar Fase 2.7)

#### Paso 3.3: Activar Animaciones (Código Custom)

**PROBLEMA**: Hubs **NO reproduce automáticamente** las animaciones de locomotion.

**Necesitas código custom** para:
1. Detectar cuando el avatar se mueve
2. Cambiar de `idle` a `walk` según velocidad
3. Reproducir la animación correcta

**Dos opciones**:

##### Opción A: Usar Componente Custom (Requiere Fork de Hubs)

Ver archivo `fullbody-avatar-component.js` del paquete anterior. Ese componente:

- Detecta animaciones en el GLB
- Reproduce `idle` cuando velocidad = 0
- Reproduce `walk` cuando velocidad > 0.1
- Reproduce `run` cuando velocidad > 2.0

**Limitación**: Requiere modificar código de Hubs (fork).

##### Opción B: Script Externo via Hubs Components

Si tu instancia de Hubs soporta **custom components**, puedes añadir:

```javascript
// Componente A-Frame custom
AFRAME.registerComponent('rpm-animator', {
  init() {
    this.mixer = null;
    this.actions = {};
    this.currentAction = null;

    this.el.addEventListener('model-loaded', () => {
      const model = this.el.getObject3D('mesh');

      if (!model || !model.animations || model.animations.length === 0) {
        console.warn('No animations found');
        return;
      }

      this.mixer = new THREE.AnimationMixer(model);

      // Cargar todas las animaciones
      model.animations.forEach(clip => {
        const action = this.mixer.clipAction(clip);
        this.actions[clip.name] = action;
      });

      // Reproducir idle por defecto
      if (this.actions.idle) {
        this.play('idle');
      }
    });
  },

  play(animationName) {
    const action = this.actions[animationName];

    if (!action) {
      console.warn(`Animation ${animationName} not found`);
      return;
    }

    if (this.currentAction && this.currentAction !== action) {
      this.currentAction.fadeOut(0.2);
    }

    action.reset().fadeIn(0.2).play();
    this.currentAction = action;
  },

  tick(time, deltaTime) {
    if (this.mixer) {
      this.mixer.update(deltaTime / 1000);
    }

    // Detectar movimiento (pseudo-código)
    // const velocity = this.getVelocity(); // implementar
    // if (velocity > 2.0) this.play('run');
    // else if (velocity > 0.1) this.play('walk');
    // else this.play('idle');
  }
});
```

**Uso en Spoke** (editor de Hubs):
- Añadir componente `rpm-animator` a tu avatar

**Limitación**: Detectar velocidad del avatar es complejo sin acceso al código de Hubs.

#### Paso 3.4: Testing

**Checklist**:

1. ✅ Avatar carga sin errores
2. ✅ Geometría se ve correcta
3. ✅ Cabeza sigue cámara
4. ✅ Manos responden a VR controllers (si aplica)
5. ⚠️ Animaciones existen (ver consola)
6. ❌ Animaciones NO se reproducen automáticamente (esperado sin código custom)

---

## Problemas Comunes y Soluciones

### Problema 1: "Avatar en T-Pose Estático"

**Síntoma**: Avatar aparece con brazos extendidos, sin movimiento.

**Causa**: Animaciones no se exportaron correctamente o no están siendo reproducidas.

**Solución**:

1. **Verificar export de Blender**:
   - Revisar que "Animation" esté marcado en export settings
   - Verificar que **"Always Sample Animations" esté DESMARCADO**

2. **Verificar en consola de navegador**:
   ```javascript
   const mesh = document.querySelector('[networked-avatar]').getObject3D('mesh');
   console.log(mesh.animations); // ¿Vacío? → problema de export
   ```

3. **Forzar reproducción en consola** (test):
   ```javascript
   const mixer = new THREE.AnimationMixer(mesh);
   const action = mixer.clipAction(mesh.animations[0]);
   action.play();

   // Update loop (copiar/pegar en consola)
   setInterval(() => mixer.update(0.016), 16);
   ```

   Si funciona → el problema es activación de animación (necesitas componente custom)

### Problema 2: "Manos No Responden a VR Controllers"

**Síntoma**: Manos permanecen planas, sin hacer puño/apuntar.

**Causa**: Animaciones de dedos conflictúan en export de Blender.

**Solución**: Ver sección [Sistema IK y Tracking de Manos](#sistema-ik-y-tracking-de-manos)

**TL;DR**:
1. En Blender Animation window, desmarcar todos los checkboxes
2. En export settings, desmarcar "Always Sample Animations"
3. Re-exportar

**Fuente**: [GitHub Discussion #2827](https://github.com/Hubs-Foundation/hubs/discussions/2827)

### Problema 3: "Avatar Se Hunde en el Suelo"

**Síntoma**: Avatar aparece parcialmente dentro del suelo.

**Causa**: Origen del armature no está en los pies.

**Solución en Blender**:

1. Seleccionar armature
2. `Object > Set Origin > Origin to 3D Cursor`
3. Mover 3D cursor a posición de pies:
   - Seleccionar bone `LeftFoot` o `RightFoot`
   - `Shift + S > Cursor to Selected`
4. Con armature seleccionado, `Object > Set Origin > Origin to 3D Cursor`
5. Verificar que armature.location.z ≈ 0
6. Re-exportar

### Problema 4: "Animación Se Ve Rara/Glitchy"

**Síntoma**: Piernas/brazos se tuercen, avatar se distorsiona.

**Causa**: Skeleton de Mixamo no coincide perfectamente con skeleton de RPM.

**Solución**: **Retargeting** de animaciones.

**Proceso de Retargeting** (avanzado):

1. En Blender, instalar addon **Rokoko Studio** o **Auto-Rig Pro**
2. Usar herramienta de retargeting para mapear bones:
   ```
   Mixamo         →  RPM
   LeftUpLeg      →  LeftUpLeg
   LeftLeg        →  LeftLeg
   LeftFoot       →  LeftFoot
   ... (mapear todos)
   ```
3. Bake retargeted animation
4. Exportar

**Alternativa**: Usar animaciones de Mixamo directamente en el avatar de Mixamo (subir avatar a Mixamo primero, descargar con animación incluida).

### Problema 5: "GLB Es Demasiado Grande (>10MB)"

**Síntoma**: Upload falla o tarda mucho.

**Causa**: Animaciones añaden peso. Multiple clips pueden hacer GLB muy grande.

**Solución**:

1. **Reducir duración de clips**:
   - En Blender, recortar animaciones a 1-2 segundos (loopean)
   - Para walk cycle: 1 segundo es suficiente

2. **Comprimir keyframes**:
   - En export settings, marcar "Optimize Animation Size"

3. **Exportar solo animaciones esenciales**:
   - Solo idle + walk (sin run, sin extras)

4. **Usar Draco compression** (con cuidado):
   ```
   En export settings:
   ✅ Compression > Draco
   ```
   **ADVERTENCIA**: Draco puede causar problemas en Hubs. Probar primero sin compresión.

---

## Información para el Desarrollador

### Resumen Técnico

**Situación actual**:
- Avatar RPM carga correctamente en Hubs ✅
- Skeleton Mixamo es compatible (con mapeo) ✅
- Geometría y texturas funcionan ✅
- **Animaciones de locomotion NO se reproducen automáticamente** ❌

**Razón**: Hubs no tiene sistema de locomotion animation por defecto para avatares full-body.

### Soluciones Técnicas

El desarrollador tiene **3 opciones**:

#### Opción 1: Componente Custom en Cliente (Recomendado)

**Complejidad**: Media-Alta
**Tiempo estimado**: 8-15 horas
**Resultado**: Sistema de animación robusto

**Implementación**:

1. **Fork de Hubs Foundation**
   ```bash
   git clone https://github.com/Hubs-Foundation/hubs.git
   cd hubs
   git checkout -b feature/rpm-locomotion
   ```

2. **Crear componente `animated-avatar`** en `src/components/`

   Ver archivo `fullbody-avatar-component.js` del paquete anterior como base.

3. **Integrar con sistema de movimiento**

   Modificar `src/systems/character-controller-system.js` (o equivalente) para:

   ```javascript
   // Detectar velocidad del avatar
   const velocity = this.calculateVelocity(eid);

   // Emitir evento para componente de animación
   this.el.emit('velocity-changed', { velocity });
   ```

4. **Componente escucha evento y cambia animación**:

   ```javascript
   this.el.addEventListener('velocity-changed', (evt) => {
     const speed = evt.detail.velocity;

     if (speed > 2.0) this.play('run');
     else if (speed > 0.1) this.play('walk');
     else this.play('idle');
   });
   ```

5. **Build y deploy**:
   ```bash
   npm run build
   npm run deploy
   ```

**Ventajas**:
- ✅ Control total
- ✅ Funciona para todos los avatares con animaciones
- ✅ Puede extenderse (emotes, gestos, etc.)

**Desventajas**:
- ❌ Requiere mantener fork de Hubs
- ❌ Updates de Hubs Foundation requieren merge manual

#### Opción 2: Hubs Blender Addon Component

**Complejidad**: Baja-Media
**Tiempo estimado**: 2-4 horas
**Resultado**: Animación limitada pero funcional

**Implementación**:

Usar sistema de **componentes de Hubs** desde Spoke/Blender:

1. En Blender, instalar [Hubs Blender Exporter](https://github.com/Hubs-Foundation/hubs-blender-exporter)

2. Añadir componente `loop-animation` a armature:

   ```json
   {
     "loop-animation": {
       "clip": "idle",
       "paused": false
     }
   }
   ```

3. Exportar GLB con componentes

**Limitación**: Solo puede reproducir **una animación en loop**. No detecta movimiento para cambiar entre walk/idle/run.

**Posible workaround**: Usar `media-frame` events para trigger animaciones, pero es muy manual.

#### Opción 3: Post-Processing via Script en Room

**Complejidad**: Baja
**Tiempo estimado**: 1-2 horas
**Resultado**: Proof of concept, no production-ready

**Implementación**:

Inyectar script en room de Hubs que manipula avatares:

```javascript
// En consola del navegador o via custom room script
(function() {
  const avatars = document.querySelectorAll('[networked-avatar]');

  avatars.forEach(avatarEl => {
    const mesh = avatarEl.getObject3D('mesh');

    if (!mesh || !mesh.animations) return;

    const mixer = new THREE.AnimationMixer(mesh);

    // Reproducir idle
    const idleClip = mesh.animations.find(a => a.name === 'idle');
    if (idleClip) {
      const action = mixer.clipAction(idleClip);
      action.play();
    }

    // Update loop
    avatarEl.setAttribute('animation-mixer-ticker', '');
  });

  // Componente helper para tick
  AFRAME.registerComponent('animation-mixer-ticker', {
    tick(t, dt) {
      const mesh = this.el.getObject3D('mesh');
      if (mesh && mesh.mixer) {
        mesh.mixer.update(dt / 1000);
      }
    }
  });
})();
```

**Ventajas**:
- ✅ Rápido de probar
- ✅ No requiere fork de Hubs

**Desventajas**:
- ❌ No persiste (se pierde al recargar)
- ❌ No detecta movimiento (solo reproduce idle)
- ❌ Puede conflictuar con updates de Hubs

### Recomendación del Desarrollador

**Para producción**: **Opción 1** (Componente Custom en Fork)

**Para prototipo rápido**: **Opción 3** (Script en room)

**Si no puedes fork Hubs**: **Opción 2** (Hubs Components), pero con limitaciones

### APIs y Hooks Relevantes

**Para implementar detección de movimiento**:

```javascript
// En sistema de character controller de Hubs
import { defineQuery } from "bitecs";
import { CharacterController, AvatarRig } from "../bit-components";

const avatarQuery = defineQuery([CharacterController, AvatarRig]);

export class AnimationSystem {
  tick(world, dt) {
    avatarQuery(world).forEach(eid => {
      // Obtener velocidad del entity
      const vx = CharacterController.velocityX[eid];
      const vz = CharacterController.velocityZ[eid];
      const speed = Math.sqrt(vx * vx + vz * vz);

      // Cambiar animación basado en speed
      this.updateAnimation(eid, speed);
    });
  }
}
```

**Registrar sistema**:

```javascript
// En src/systems/systems.js
import { AnimationSystem } from "./animation-system";

export function initSystems(world, scene) {
  return {
    // ... sistemas existentes
    animation: new AnimationSystem(world),
  };
}
```

---

## Implementación de Sentarse

### Requisitos

Para que un avatar pueda **sentarse** en Hubs, necesitas:

1. ✅ Animación de "sit" en el GLB
2. ✅ Trigger para activar animación (ej: click en silla)
3. ✅ Sistema de navegación que posicione avatar en silla
4. ✅ Código que mantenga avatar en posición sentado

### Proceso

#### 1. Descargar Animación de Sentarse

En Mixamo:
- Buscar "Sitting Idle" o "Sitting"
- Descargar FBX (Without Skin)
- Importar en Blender junto con otras animaciones (mismo proceso que walk/idle)

#### 2. Implementar Trigger en Hubs

**Opción A: Usar componente `media-frame`** (Spoke)

En Spoke, añadir a la silla:

```json
{
  "media-frame": {
    "bounds": {
      "x": 0.5, "y": 0.5, "z": 0.5
    }
  },
  "trigger-volume": {
    "target": "#avatar",
    "event": "sit",
    "animationClip": "sit"
  }
}
```

**Opción B: Código custom**

```javascript
// Detectar colisión con silla
chairEl.addEventListener('interact', () => {
  const avatarEl = document.querySelector('[networked-avatar]');

  // Mover avatar a posición de silla
  avatarEl.setAttribute('position', {
    x: chairEl.object3D.position.x,
    y: chairEl.object3D.position.y,
    z: chairEl.object3D.position.z
  });

  // Activar animación sit
  avatarEl.emit('play-animation', { name: 'sit' });

  // Deshabilitar movimiento
  avatarEl.setAttribute('character-controller', 'enabled', false);
});
```

#### 3. Issue Conocido: Sentarse en Hubs

**GitHub Issue**: [Sitting in chairs #2359](https://github.com/Hubs-Foundation/hubs/issues/2359)

**Estado**: Feature request abierto, sin implementación oficial.

**Workarounds de la comunidad**:
- Usar `waypoint` components para posicionar avatares
- Deshabilitar character controller temporalmente
- Animación sit + constraint de posición

**Limitación**: Sin sistema oficial, cada implementación es custom.

---

## Referencias

### Documentación Oficial

- [Creating Animated glTF Characters with Mixamo and Blender](https://www.donmccurdy.com/2017/11/06/creating-animated-gltf-characters-with-mixamo-and-blender/) - Guía completa del flujo de trabajo
- [Hubs Advanced Avatar Customization](https://hubs.mozilla.com/docs/creators-advanced-avatar-customization.html)
- [Hubs Avatar Pipelines](https://github.com/Hubs-Foundation/hubs-avatar-pipelines)
- [Ready Player Me - Loading Mixamo Animations](https://docs.readyplayer.me/ready-player-me/integration-guides/unreal-engine/animations/loading-mixamo-animations)

### Issues de GitHub Relevantes

- [Custom Avatar Animations #3030](https://github.com/Hubs-Foundation/hubs/discussions/3030) - Discusión sobre animaciones custom
- [Custom Avatar's hands glitching #2827](https://github.com/Hubs-Foundation/hubs/discussions/2827) - **Solución al problema de manos**
- [Getting the hands to animate #3491](https://github.com/Hubs-Foundation/hubs/discussions/3491)
- [Sitting in chairs #2359](https://github.com/Hubs-Foundation/hubs/issues/2359) - Feature request para sentarse

### Herramientas

- [Mixamo](https://www.mixamo.com/) - Biblioteca gratuita de animaciones
- [Blender](https://www.blender.org/) - Software 3D open source
- [Hubs Blender Exporter](https://github.com/Hubs-Foundation/hubs-blender-exporter)
- [Three.js AnimationMixer](https://threejs.org/docs/#api/en/animation/AnimationMixer) - Documentación técnica

### Tutoriales Relacionados

- [Mixamo Animations to Ready Player Avatar](https://forum.babylonjs.com/t/mixamo-animations-to-ready-player-avatar-video-tutorial/39241)
- [Add animation to Ready Player Me Avatar in Three.js using Mixamo](https://robesantoro.medium.com/three-js-blender-mixamo-52304823046)
- [Combining Mixamo animations into a single GLB](https://forum.babylonjs.com/t/combining-mixamo-animations-into-a-single-glb-using-blender-2-8/6690)
- [Retargeting Mixamo Animations for RPM Avatars](https://github.com/rdeioris/glTFRuntime-docs/blob/master/Tutorials/RetargetingRPMAndMixamo.md)

---

## Resumen para el Desarrollador

### El Problema

**Avatar RPM no se mueve porque**:
1. GLB de RPM no incluye animaciones (archivo estático)
2. Hubs no tiene sistema de locomotion animation automático
3. Hubs fue diseñado para half-body (sin piernas animadas)

### La Solución

**3 pasos**:

1. **Descargar animaciones de Mixamo** (idle, walk, run)
   - Formato: FBX Without Skin
   - Tiempo: 30-45 min

2. **Combinar en Blender y exportar GLB con animaciones**
   - Importar avatar + animaciones
   - Transferir actions al armature de avatar
   - Exportar GLB con "Always Sample Animations" **desmarcado**
   - Tiempo: 1-2 horas

3. **Implementar código en Hubs para reproducir animaciones**
   - Opción A: Fork de Hubs + componente custom (recomendado)
   - Opción B: Hubs components (limitado)
   - Opción C: Script inyectado (prototipo)
   - Tiempo: 2-15 horas según opción

### Checklist para el Desarrollador

Antes de implementar código:

- [ ] Verificar que GLB tiene animaciones embebidas (consola: `mesh.animations`)
- [ ] Confirmar que animaciones se ven bien en Blender (playback)
- [ ] Probar carga en Hubs (avatar debe verse, sin errores en consola)

Durante implementación:

- [ ] Fork de Hubs creado (si opción A)
- [ ] Componente de animación creado y registrado
- [ ] Sistema de detección de velocidad implementado
- [ ] Transiciones de animación suaves (fade in/out)
- [ ] Testing con múltiples usuarios (sincronización)

### Archivos de Referencia del Paquete

En el directorio `codigo/`:

1. **`fullbody-avatar-component.js`**
   - Componente A-Frame completo
   - Maneja detección y reproducción de animaciones
   - Usar como base para opción A

2. **`avatar-utils-extended.js`**
   - Validador de skeleton que acepta Mixamo
   - Necesario si modificas el core de Hubs

---

**Fin del documento**

Para dudas técnicas adicionales, consultar:
- `INTEGRACION_RPM_HUBS.md` (documento principal del paquete)
- Issues de GitHub listados en Referencias
- Comunidad de Hubs Foundation

---

**Última actualización**: Febrero 2026
**Versión**: 1.0
**Licencia**: MIT (código de ejemplo)
