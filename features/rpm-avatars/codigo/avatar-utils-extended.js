/**
 * avatar-utils-extended.js
 *
 * Validador de skeleton extendido para soportar avatares full-body de ReadyPlayer.me
 *
 * Modificaciones sobre Hubs original:
 * - Soporte para lower body bones (Mixamo skeleton)
 * - Detección automática de tipo de avatar (half-body vs full-body)
 * - Validación flexible de spine bones opcionales
 *
 * Ubicación en Hubs: src/utils/avatar-utils.js (reemplazar función validateAvatarSkeleton)
 */

// ===== CONFIGURACIÓN DE HUESOS =====

/**
 * Huesos requeridos para upper body (mínimo para que funcione)
 */
const REQUIRED_BONES_UPPER = [
  "Hips",
  "Spine",
  "Neck",
  "Head",
  "LeftShoulder",
  "LeftArm",
  "LeftForeArm",
  "LeftHand",
  "RightShoulder",
  "RightArm",
  "RightForeArm",
  "RightHand"
];

/**
 * Huesos opcionales de spine (Mixamo tiene Spine1 y Spine2, High Fidelity puede variar)
 */
const OPTIONAL_BONES_SPINE = [
  "Spine1",
  "Spine2"
];

/**
 * Huesos de lower body (full-body avatars)
 * Si todos están presentes, se activa modo full-body
 */
const FULLBODY_BONES_LOWER = [
  "LeftUpLeg",
  "LeftLeg",
  "LeftFoot",
  "RightUpLeg",
  "RightLeg",
  "RightFoot"
];

/**
 * Huesos opcionales de lower body (dedos de pies, etc.)
 */
const OPTIONAL_BONES_LOWER = [
  "LeftToeBase",
  "RightToeBase"
];

/**
 * Huesos de dedos (opcionales pero comunes en avatares detallados)
 */
const FINGER_BONES = [
  // Mano izquierda
  "LeftHandThumb1", "LeftHandThumb2", "LeftHandThumb3",
  "LeftHandIndex1", "LeftHandIndex2", "LeftHandIndex3",
  "LeftHandMiddle1", "LeftHandMiddle2", "LeftHandMiddle3",
  "LeftHandRing1", "LeftHandRing2", "LeftHandRing3",
  "LeftHandPinky1", "LeftHandPinky2", "LeftHandPinky3",
  // Mano derecha
  "RightHandThumb1", "RightHandThumb2", "RightHandThumb3",
  "RightHandIndex1", "RightHandIndex2", "RightHandIndex3",
  "RightHandMiddle1", "RightHandMiddle2", "RightHandMiddle3",
  "RightHandRing1", "RightHandRing2", "RightHandRing3",
  "RightHandPinky1", "RightHandPinky2", "RightHandPinky3"
];

// ===== FUNCIÓN PRINCIPAL =====

/**
 * Valida el skeleton de un avatar y detecta características
 *
 * @param {THREE.Skeleton} skeleton - Skeleton del avatar cargado
 * @returns {Object} Resultado de validación con metadatos
 *
 * @example
 * const result = validateAvatarSkeleton(avatarSkeleton);
 * if (!result.valid) {
 *   console.error('Invalid avatar:', result.errors);
 * } else {
 *   console.log('Avatar type:', result.isFullBody ? 'full-body' : 'half-body');
 * }
 */
export function validateAvatarSkeleton(skeleton) {
  const result = {
    valid: false,
    isFullBody: false,
    hasFingers: false,
    boneCount: 0,
    errors: [],
    warnings: [],
    metadata: {}
  };

  // Validar que skeleton existe y tiene bones
  if (!skeleton || !skeleton.bones || skeleton.bones.length === 0) {
    result.errors.push("Skeleton is empty or invalid");
    return result;
  }

  result.boneCount = skeleton.bones.length;

  // Extraer nombres de huesos
  const boneNames = skeleton.bones.map(b => b.name);
  const boneNamesSet = new Set(boneNames);

  // ===== VALIDACIÓN UPPER BODY (REQUERIDO) =====

  const missingUpper = REQUIRED_BONES_UPPER.filter(name => !boneNamesSet.has(name));

  if (missingUpper.length > 0) {
    result.errors.push(`Missing required upper body bones: ${missingUpper.join(', ')}`);
    return result; // Fallo crítico, no continuar
  }

  // ===== DETECCIÓN FULL-BODY =====

  const lowerBonesPresent = FULLBODY_BONES_LOWER.filter(name => boneNamesSet.has(name));
  result.isFullBody = lowerBonesPresent.length === FULLBODY_BONES_LOWER.length;

  if (lowerBonesPresent.length > 0 && !result.isFullBody) {
    result.warnings.push(
      `Partial lower body detected (${lowerBonesPresent.length}/${FULLBODY_BONES_LOWER.length} bones). ` +
      `Full-body mode requires all lower body bones. Missing: ` +
      FULLBODY_BONES_LOWER.filter(n => !boneNamesSet.has(n)).join(', ')
    );
  }

  // ===== DETECCIÓN DE DEDOS =====

  const fingerBonesPresent = FINGER_BONES.filter(name => boneNamesSet.has(name));
  result.hasFingers = fingerBonesPresent.length >= 10; // Al menos 5 dedos de una mano

  // ===== VALIDACIÓN OPCIONAL (WARNINGS) =====

  const spineBonesPresent = OPTIONAL_BONES_SPINE.filter(name => boneNamesSet.has(name));
  if (spineBonesPresent.length === 0) {
    result.warnings.push(
      "No optional spine bones (Spine1, Spine2) found. Avatar may have limited torso flexibility."
    );
  }

  // ===== DETECCIÓN DE ROOT ARMATURE =====

  const rootBone = skeleton.bones[0];
  result.metadata.rootBoneName = rootBone.name;

  if (rootBone.name !== "Hips") {
    // Intentar encontrar Hips en jerarquía
    const hipsIndex = skeleton.bones.findIndex(b => b.name === "Hips");
    if (hipsIndex !== -1) {
      result.metadata.hipsIndex = hipsIndex;
      result.warnings.push(
        `Root bone is "${rootBone.name}" instead of "Hips". ` +
        `Hips found at index ${hipsIndex}. Avatar may need re-rooting.`
      );
    } else {
      result.errors.push(
        `Root bone is "${rootBone.name}" and "Hips" bone not found. Invalid skeleton hierarchy.`
      );
      return result;
    }
  }

  // ===== METADATA ADICIONAL =====

  result.metadata.skeletonType = detectSkeletonType(boneNames);
  result.metadata.boneHierarchy = buildBoneHierarchy(skeleton.bones);

  // ===== ÉXITO =====

  result.valid = true;

  return result;
}

// ===== FUNCIONES AUXILIARES =====

/**
 * Detecta el tipo de skeleton basándose en patrones de nombres
 */
function detectSkeletonType(boneNames) {
  const boneNamesLower = boneNames.map(n => n.toLowerCase());

  // Patrones conocidos
  const patterns = {
    mixamo: ["mixamorig", "spine2", "leftupleg"],
    highfidelity: ["hips", "spine1", "leftarm"],
    rpm: ["armature", "leftupleg", "rightupleg"], // ReadyPlayer.me típico
    vrm: ["j_bip_c_hips", "j_adj_"], // VRM format
    custom: []
  };

  for (const [type, keywords] of Object.entries(patterns)) {
    const matches = keywords.filter(kw =>
      boneNamesLower.some(bn => bn.includes(kw))
    );

    if (matches.length >= 2) {
      return type;
    }
  }

  return "unknown";
}

/**
 * Construye jerarquía de huesos simplificada (para debugging)
 */
function buildBoneHierarchy(bones) {
  const hierarchy = {};

  bones.forEach((bone, index) => {
    const parentIndex = bone.parent ? bones.indexOf(bone.parent) : -1;

    hierarchy[bone.name] = {
      index,
      parent: bone.parent ? bone.parent.name : null,
      parentIndex,
      childCount: bones.filter(b => b.parent === bone).length
    };
  });

  return hierarchy;
}

// ===== UTILIDADES ADICIONALES =====

/**
 * Genera un reporte legible del skeleton
 */
export function generateSkeletonReport(skeleton) {
  const validation = validateAvatarSkeleton(skeleton);

  let report = "=== AVATAR SKELETON REPORT ===\n\n";

  report += `Status: ${validation.valid ? '✅ VALID' : '❌ INVALID'}\n`;
  report += `Type: ${validation.isFullBody ? 'Full-Body' : 'Half-Body'}\n`;
  report += `Bones: ${validation.boneCount}\n`;
  report += `Fingers: ${validation.hasFingers ? 'Yes' : 'No'}\n`;
  report += `Skeleton Type: ${validation.metadata.skeletonType}\n`;
  report += `Root Bone: ${validation.metadata.rootBoneName}\n`;

  if (validation.errors.length > 0) {
    report += "\n❌ ERRORS:\n";
    validation.errors.forEach(err => report += `  - ${err}\n`);
  }

  if (validation.warnings.length > 0) {
    report += "\n⚠️  WARNINGS:\n";
    validation.warnings.forEach(warn => report += `  - ${warn}\n`);
  }

  report += "\n=== BONE HIERARCHY ===\n";
  skeleton.bones.slice(0, 20).forEach((bone, idx) => {
    const depth = getBoneDepth(bone);
    const indent = "  ".repeat(depth);
    report += `${indent}${bone.name}\n`;
  });

  if (skeleton.bones.length > 20) {
    report += `  ... (${skeleton.bones.length - 20} more bones)\n`;
  }

  return report;
}

/**
 * Calcula profundidad de un hueso en la jerarquía
 */
function getBoneDepth(bone) {
  let depth = 0;
  let current = bone;

  while (current.parent) {
    depth++;
    current = current.parent;
  }

  return depth;
}

/**
 * Verifica si un avatar es compatible con animaciones Mixamo
 */
export function isMixamoCompatible(skeleton) {
  const validation = validateAvatarSkeleton(skeleton);

  if (!validation.valid) return false;

  // Mixamo requiere estos huesos específicos
  const mixamoRequired = [
    "Hips", "Spine", "Spine1", "Spine2",
    "Neck", "Head",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand"
  ];

  if (validation.isFullBody) {
    mixamoRequired.push(
      "LeftUpLeg", "LeftLeg", "LeftFoot",
      "RightUpLeg", "RightLeg", "RightFoot"
    );
  }

  const boneNames = new Set(skeleton.bones.map(b => b.name));
  const hasMixamoBones = mixamoRequired.every(name => boneNames.has(name));

  return hasMixamoBones && validation.metadata.skeletonType !== "vrm";
}

// ===== EXPORTS =====

export {
  REQUIRED_BONES_UPPER,
  OPTIONAL_BONES_SPINE,
  FULLBODY_BONES_LOWER,
  OPTIONAL_BONES_LOWER,
  FINGER_BONES
};

export default validateAvatarSkeleton;
