/**
 * fullbody-avatar-component.js
 *
 * Componente A-Frame para gestionar avatares full-body en Hubs
 *
 * Características:
 * - Detección automática de lower body
 * - Mapeo de huesos Mixamo a estructura interna
 * - Sistema de animación básico (idle, walk, run)
 * - Integración con sistema de cámara
 *
 * Ubicación en Hubs: src/components/fullbody-avatar.js (nuevo archivo)
 *
 * Uso:
 * <a-entity fullbody-avatar="enabled: true; showLegs: true"></a-entity>
 */

import { validateAvatarSkeleton } from "../utils/avatar-utils";

AFRAME.registerComponent("fullbody-avatar", {
  schema: {
    enabled: { type: "boolean", default: true },
    showLegs: { type: "boolean", default: true },
    animationSpeed: { type: "number", default: 1.0 },
    debugMode: { type: "boolean", default: false }
  },

  init() {
    this.skeleton = null;
    this.lowerBodyBones = {};
    this.upperBodyBones = {};
    this.isFullBody = false;

    // Animation state
    this.currentAnimationState = "idle";
    this.animationTime = 0;
    this.velocity = { x: 0, y: 0, z: 0 };

    // Bind methods
    this.onModelLoaded = this.onModelLoaded.bind(this);
    this.onModelError = this.onModelError.bind(this);

    // Listen for model loaded
    this.el.addEventListener("model-loaded", this.onModelLoaded);
    this.el.addEventListener("model-error", this.onModelError);

    if (this.data.debugMode) {
      console.log("[FullBodyAvatar] Component initialized", this.el);
    }
  },

  onModelLoaded(event) {
    if (this.data.debugMode) {
      console.log("[FullBodyAvatar] Model loaded event", event);
    }

    const object3D = this.el.getObject3D("mesh");

    if (!object3D) {
      console.warn("[FullBodyAvatar] No mesh found on entity");
      return;
    }

    this.processModel(object3D);
  },

  onModelError(event) {
    console.error("[FullBodyAvatar] Model failed to load", event);
  },

  processModel(object3D) {
    // Encontrar SkinnedMesh y Skeleton
    let skinnedMesh = null;

    object3D.traverse((node) => {
      if (node.isSkinnedMesh && node.skeleton) {
        skinnedMesh = node;
        this.skeleton = node.skeleton;

        if (this.data.debugMode) {
          console.log("[FullBodyAvatar] Found SkinnedMesh:", node.name);
          console.log("[FullBodyAvatar] Skeleton bones:", this.skeleton.bones.length);
        }
      }
    });

    if (!this.skeleton) {
      console.warn("[FullBodyAvatar] No skeleton found in model");
      return;
    }

    // Validar skeleton
    const validation = validateAvatarSkeleton(this.skeleton);

    if (!validation.valid) {
      console.error("[FullBodyAvatar] Invalid skeleton:", validation.errors);
      this.el.emit("fullbody-invalid", { errors: validation.errors });
      return;
    }

    this.isFullBody = validation.isFullBody;

    if (this.data.debugMode) {
      console.log("[FullBodyAvatar] Skeleton validation:", validation);
    }

    // Mapear huesos
    this.mapBones();

    // Setup componentes
    if (this.isFullBody) {
      this.setupLowerBody();
      this.setupAnimations();

      this.el.emit("fullbody-ready", {
        isFullBody: true,
        boneCount: this.skeleton.bones.length
      });

      if (this.data.debugMode) {
        console.log("[FullBodyAvatar] Full-body avatar ready!");
      }
    } else {
      this.el.emit("fullbody-ready", {
        isFullBody: false,
        boneCount: this.skeleton.bones.length
      });

      if (this.data.debugMode) {
        console.log("[FullBodyAvatar] Half-body avatar (no lower body)");
      }
    }
  },

  mapBones() {
    if (!this.skeleton) return;

    // Upper body mapping
    const upperBodyNames = [
      "Hips", "Spine", "Spine1", "Spine2",
      "Neck", "Head",
      "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
      "RightShoulder", "RightArm", "RightForeArm", "RightHand"
    ];

    // Lower body mapping
    const lowerBodyNames = [
      "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
      "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"
    ];

    this.skeleton.bones.forEach(bone => {
      if (upperBodyNames.includes(bone.name)) {
        this.upperBodyBones[bone.name] = bone;
      }

      if (lowerBodyNames.includes(bone.name)) {
        this.lowerBodyBones[bone.name] = bone;
      }
    });

    if (this.data.debugMode) {
      console.log("[FullBodyAvatar] Mapped bones:");
      console.log("  Upper body:", Object.keys(this.upperBodyBones));
      console.log("  Lower body:", Object.keys(this.lowerBodyBones));
    }
  },

  setupLowerBody() {
    // Verificar que tenemos todos los huesos necesarios
    const requiredBones = ["LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg", "RightLeg", "RightFoot"];
    const hasAll = requiredBones.every(name => this.lowerBodyBones[name]);

    if (!hasAll) {
      console.warn("[FullBodyAvatar] Incomplete lower body bones");
      this.isFullBody = false;
      return;
    }

    // Hacer visible el lower body (por si estaba oculto)
    if (this.data.showLegs) {
      this.skeleton.bones.forEach(bone => {
        if (this.lowerBodyBones[bone.name]) {
          // El bone está visible por defecto, pero asegurar que su mesh lo está
          // (esto depende de la implementación específica de Hubs)
        }
      });
    }

    if (this.data.debugMode) {
      console.log("[FullBodyAvatar] Lower body setup complete");
    }
  },

  setupAnimations() {
    // Inicializar sistema de animación procedural
    // Por ahora, las piernas se quedan en bind pose
    // En una implementación completa, aquí cargaríamos clips de animación

    this.animationStates = {
      idle: {
        name: "idle",
        loop: true,
        speed: 1.0
      },
      walk: {
        name: "walk",
        loop: true,
        speed: 1.0
      },
      run: {
        name: "run",
        loop: true,
        speed: 1.2
      }
    };

    if (this.data.debugMode) {
      console.log("[FullBodyAvatar] Animation system ready (procedural)");
    }
  },

  tick(time, deltaTime) {
    if (!this.isFullBody || !this.data.enabled) return;

    // Actualizar tiempo de animación
    this.animationTime += (deltaTime / 1000) * this.data.animationSpeed;

    // Determinar estado de animación basado en velocidad
    // (esto debería obtenerse del sistema de movimiento/physics)
    const speed = this.getMovementSpeed();

    let newState = "idle";
    if (speed > 0.1) {
      newState = speed > 2.0 ? "run" : "walk";
    }

    if (newState !== this.currentAnimationState) {
      this.transitionAnimation(newState);
    }

    // Actualizar animación procedural
    this.updateProceduralAnimation(deltaTime);
  },

  getMovementSpeed() {
    // Placeholder: obtener velocidad del entity
    // En implementación real, esto vendría de:
    // - Componente de physics
    // - Networked data
    // - Character controller

    // Por ahora, retornar 0 (idle)
    return 0;
  },

  transitionAnimation(newState) {
    if (this.data.debugMode) {
      console.log(`[FullBodyAvatar] Animation: ${this.currentAnimationState} -> ${newState}`);
    }

    this.currentAnimationState = newState;
    this.animationTime = 0; // Reset phase

    this.el.emit("animation-changed", {
      from: this.currentAnimationState,
      to: newState
    });
  },

  updateProceduralAnimation(deltaTime) {
    // Animación procedural simple de piernas basada en ciclo sinusoidal

    if (!this.lowerBodyBones.LeftUpLeg || !this.lowerBodyBones.RightUpLeg) {
      return;
    }

    // Parámetros de animación
    const cycleSpeed = this.currentAnimationState === "run" ? 2.0 : 1.0;
    const phase = (this.animationTime * cycleSpeed) % 1.0; // 0 to 1

    // Calcular ángulos de swing
    let maxSwing = 0;
    if (this.currentAnimationState === "walk") {
      maxSwing = Math.PI / 6; // 30 grados
    } else if (this.currentAnimationState === "run") {
      maxSwing = Math.PI / 4; // 45 grados
    }

    // Legs swing en oposición
    const leftAngle = Math.sin(phase * Math.PI * 2) * maxSwing;
    const rightAngle = Math.sin((phase + 0.5) * Math.PI * 2) * maxSwing;

    // Aplicar rotaciones (simple, sin IK completo)
    if (this.currentAnimationState !== "idle") {
      this.lowerBodyBones.LeftUpLeg.rotation.x = leftAngle;
      this.lowerBodyBones.RightUpLeg.rotation.x = rightAngle;

      // Knee bend (cuando la pierna está hacia atrás)
      const leftKneeBend = Math.max(0, -leftAngle) * 1.5;
      const rightKneeBend = Math.max(0, -rightAngle) * 1.5;

      this.lowerBodyBones.LeftLeg.rotation.x = leftKneeBend;
      this.lowerBodyBones.RightLeg.rotation.x = rightKneeBend;
    } else {
      // Idle: volver a bind pose gradualmente
      this.lowerBodyBones.LeftUpLeg.rotation.x *= 0.95;
      this.lowerBodyBones.RightUpLeg.rotation.x *= 0.95;
      this.lowerBodyBones.LeftLeg.rotation.x *= 0.95;
      this.lowerBodyBones.RightLeg.rotation.x *= 0.95;
    }
  },

  remove() {
    this.el.removeEventListener("model-loaded", this.onModelLoaded);
    this.el.removeEventListener("model-error", this.onModelError);

    if (this.data.debugMode) {
      console.log("[FullBodyAvatar] Component removed");
    }
  },

  // ===== API PÚBLICA =====

  /**
   * Activa o desactiva el renderizado de lower body
   */
  setLegsVisible(visible) {
    this.data.showLegs = visible;

    // Implementar lógica de visibilidad si es necesario
    // (depende de la arquitectura de Hubs)
  },

  /**
   * Fuerza un estado de animación específico
   */
  forceAnimationState(state) {
    if (["idle", "walk", "run"].includes(state)) {
      this.transitionAnimation(state);
    }
  },

  /**
   * Obtiene información del estado actual
   */
  getState() {
    return {
      isFullBody: this.isFullBody,
      animationState: this.currentAnimationState,
      boneCount: this.skeleton ? this.skeleton.bones.length : 0,
      lowerBodyBones: Object.keys(this.lowerBodyBones)
    };
  }
});

export default AFRAME.components["fullbody-avatar"];
