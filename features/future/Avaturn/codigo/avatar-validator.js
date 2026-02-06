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

    // Palabras clave de dedos para filtrado
    this.fingerKeywords = [
      'thumb', 'index', 'middle', 'ring', 'pinky', 'finger'
    ];
  }

  /**
   * Valida un avatar de Avaturn
   * @param {Object} gltf - GLTF object cargado
   * @returns {Object} { valid: boolean, errors: string[], warnings: string[] }
   */
  async validate(gltf) {
    const errors = [];
    const warnings = [];

    // 1. Verificar estructura básica
    if (!gltf || !gltf.scene) {
      errors.push("Invalid GLTF/GLB file: missing scene");
      return { valid: false, errors, warnings };
    }

    // 2. Verificar skeleton
    const skeleton = this.findSkeleton(gltf.scene);
    if (!skeleton) {
      errors.push("No skeleton found in avatar");
    } else {
      const missingBones = this.checkRequiredBones(skeleton);
      if (missingBones.length > 0) {
        warnings.push(`Missing recommended bones: ${missingBones.join(", ")}`);
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

    // 6. Verificar geometría
    const geometryIssues = this.checkGeometry(gltf);
    warnings.push(...geometryIssues);

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Procesa avatar de Avaturn para optimizar para Hubs
   * @param {Object} gltf - GLTF object cargado
   * @returns {Object} GLTF procesado
   */
  process(gltf) {
    console.log("[AvaturnValidator] Processing avatar...");

    // 1. Filtrar animaciones problemáticas
    if (gltf.animations && gltf.animations.length > 0) {
      console.log("[AvaturnValidator] Filtering animations...");
      this.filterAnimations(gltf);
    }

    // 2. Asegurar material Bot_PBS
    console.log("[AvaturnValidator] Ensuring Bot_PBS material...");
    this.ensureBotPBSMaterial(gltf);

    // 3. Optimizar texturas
    console.log("[AvaturnValidator] Optimizing textures...");
    this.optimizeTextures(gltf);

    // 4. Agregar componentes de Hubs
    console.log("[AvaturnValidator] Adding Hubs components...");
    this.addHubsComponents(gltf);

    // 5. Optimizar geometría
    console.log("[AvaturnValidator] Optimizing geometry...");
    this.optimizeGeometry(gltf);

    console.log("[AvaturnValidator] Processing complete");
    return gltf;
  }

  // ========== MÉTODOS DE VALIDACIÓN ==========

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
    return [...new Set(materials)]; // Remover duplicados
  }

  checkTextures(materials) {
    const warnings = [];
    materials.forEach(material => {
      if (material.map && material.map.image) {
        const { width, height } = material.map.image;

        // Advertir si texturas son muy grandes
        if (width > 2048 || height > 2048) {
          warnings.push(
            `Texture "${material.name}" is ${width}x${height} ` +
            `(recommended max 2048x2048 for web performance)`
          );
        }

        // Advertir si no son potencia de 2
        if (!this.isPowerOfTwo(width) || !this.isPowerOfTwo(height)) {
          warnings.push(
            `Texture "${material.name}" size ${width}x${height} ` +
            `is not power of 2 (may cause rendering issues)`
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
          `(may cause T-Pose flashing, will be filtered)`
        );
      }

      // Verificar duración
      if (clip.duration === 0) {
        warnings.push(`Animation "${clip.name}" has zero duration`);
      }
    });
    return warnings;
  }

  checkGeometry(gltf) {
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
        `High vertex count: ${totalVertices.toLocaleString()} ` +
        `(recommended < 100,000 for web performance)`
      );
    }

    if (totalTriangles > 50000) {
      warnings.push(
        `High triangle count: ${totalTriangles.toLocaleString()} ` +
        `(recommended < 50,000 for web performance)`
      );
    }

    return warnings;
  }

  // ========== MÉTODOS DE PROCESAMIENTO ==========

  /**
   * Filtra animaciones problemáticas
   * Basado en soluciones de ReadyPlayer.me issues
   */
  filterAnimations(gltf) {
    gltf.animations.forEach(clip => {
      // 1. Filtrar solo QuaternionKeyframeTracks (rotación)
      const quaternionTracks = clip.tracks.filter(track =>
        track instanceof THREE.QuaternionKeyframeTrack
      );

      // 2. Remover tracks de manos/dedos que causan parpadeo a T-Pose
      const filteredTracks = quaternionTracks.filter(track => {
        const name = track.name.toLowerCase();

        // Verificar si contiene palabras clave de dedos
        const isFingerTrack = this.fingerKeywords.some(keyword =>
          name.includes(keyword)
        );

        // Mantener solo si NO es track de dedos
        return !isFingerTrack;
      });

      // Actualizar tracks del clip
      const originalCount = clip.tracks.length;
      clip.tracks = filteredTracks;

      console.log(
        `[AvaturnValidator] Animation "${clip.name}": ` +
        `${originalCount} tracks → ${filteredTracks.length} tracks`
      );
    });
  }

  /**
   * Asegura que el avatar tenga material Bot_PBS requerido por Hubs
   */
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

    if (hasBotPBS) {
      console.log(`[AvaturnValidator] Bot_PBS material already exists`);
      return;
    }

    // Si no existe, renombrar el primer material encontrado
    gltf.scene.traverse(node => {
      if (node.isMesh && node.material && !hasBotPBS) {
        if (Array.isArray(node.material)) {
          console.log(
            `[AvaturnValidator] Renaming material "${node.material[0].name}" → "${MAT_NAME}"`
          );
          node.material[0].name = MAT_NAME;
        } else {
          console.log(
            `[AvaturnValidator] Renaming material "${node.material.name}" → "${MAT_NAME}"`
          );
          node.material.name = MAT_NAME;
        }
        hasBotPBS = true;
      }
    });
  }

  /**
   * Optimiza texturas para performance web
   */
  optimizeTextures(gltf) {
    gltf.scene.traverse(node => {
      if (node.isMesh && node.material) {
        const materials = Array.isArray(node.material)
          ? node.material
          : [node.material];

        materials.forEach(material => {
          // Configurar encoding correcto (crítico para color accuracy)
          if (material.map) {
            material.map.encoding = THREE.sRGBEncoding;
            material.map.generateMipmaps = true;
            material.map.anisotropy = 4; // Mejor calidad
          }

          // Normal maps siempre LinearEncoding
          if (material.normalMap) {
            material.normalMap.encoding = THREE.LinearEncoding;
            material.normalMap.generateMipmaps = true;
          }

          // ORM maps (occlusion, roughness, metallic)
          if (material.aoMap || material.roughnessMap || material.metalnessMap) {
            [material.aoMap, material.roughnessMap, material.metalnessMap].forEach(map => {
              if (map) {
                map.encoding = THREE.LinearEncoding;
                map.generateMipmaps = true;
              }
            });
          }

          // Emissive maps
          if (material.emissiveMap) {
            material.emissiveMap.encoding = THREE.sRGBEncoding;
            material.emissiveMap.generateMipmaps = true;
          }

          // Configurar material para mejor performance
          material.precision = "highp"; // Mejor calidad visual
          material.shadowSide = THREE.FrontSide; // Solo frente para sombras
        });
      }
    });
  }

  /**
   * Agrega componentes específicos de Hubs al avatar
   */
  addHubsComponents(gltf) {
    // Asegurar que existe userData
    if (!gltf.userData) {
      gltf.userData = {};
    }

    if (!gltf.userData.gltfExtensions) {
      gltf.userData.gltfExtensions = {};
    }

    // Agregar scale-audio-feedback al nodo Head
    gltf.scene.traverse(node => {
      const nodeName = node.name.toLowerCase();

      if (nodeName.includes('head')) {
        // Asegurar userData
        if (!node.userData) {
          node.userData = {};
        }
        if (!node.userData.gltfExtensions) {
          node.userData.gltfExtensions = {};
        }

        // Agregar componente de audio feedback
        node.userData.gltfExtensions.MOZ_hubs_components = {
          "scale-audio-feedback": {
            minScale: 1.0,
            maxScale: 1.3
          }
        };

        console.log(`[AvaturnValidator] Added scale-audio-feedback to "${node.name}"`);
      }
    });
  }

  /**
   * Optimiza geometría para mejor performance
   */
  optimizeGeometry(gltf) {
    gltf.scene.traverse(node => {
      if (node.isMesh && node.geometry) {
        const geometry = node.geometry;

        // Computar bounding sphere para frustum culling
        if (!geometry.boundingSphere) {
          geometry.computeBoundingSphere();
        }

        // Computar bounding box
        if (!geometry.boundingBox) {
          geometry.computeBoundingBox();
        }

        // Computar vertex normals si no existen
        if (!geometry.attributes.normal) {
          geometry.computeVertexNormals();
        }
      }
    });
  }

  // ========== MÉTODOS DE UTILIDAD ==========

  /**
   * Genera reporte detallado del avatar
   */
  generateReport(gltf) {
    const report = {
      overview: {},
      geometry: {},
      materials: {},
      textures: {},
      animations: {},
      skeleton: {}
    };

    // Overview
    let meshCount = 0;
    let vertexCount = 0;
    let triangleCount = 0;

    gltf.scene.traverse(node => {
      if (node.isMesh) {
        meshCount++;
        if (node.geometry) {
          const vertices = node.geometry.attributes.position.count;
          const triangles = node.geometry.index
            ? node.geometry.index.count / 3
            : vertices / 3;

          vertexCount += vertices;
          triangleCount += triangles;
        }
      }
    });

    report.overview = {
      meshCount,
      vertexCount,
      triangleCount
    };

    // Materials
    const materials = this.getMaterials(gltf);
    report.materials = {
      count: materials.length,
      materials: materials.map(m => ({
        name: m.name,
        type: m.type,
        hasBaseTexture: !!m.map,
        hasNormalMap: !!m.normalMap,
        hasEmissive: !!m.emissiveMap
      }))
    };

    // Textures
    const textures = new Set();
    materials.forEach(material => {
      ['map', 'normalMap', 'emissiveMap', 'aoMap', 'roughnessMap', 'metalnessMap'].forEach(prop => {
        if (material[prop]) {
          textures.add(material[prop]);
        }
      });
    });

    report.textures = {
      count: textures.size,
      textures: Array.from(textures).map(t => ({
        width: t.image?.width || 0,
        height: t.image?.height || 0,
        encoding: t.encoding
      }))
    };

    // Animations
    if (gltf.animations) {
      report.animations = {
        count: gltf.animations.length,
        animations: gltf.animations.map(clip => ({
          name: clip.name,
          duration: clip.duration,
          trackCount: clip.tracks.length
        }))
      };
    }

    // Skeleton
    const skeleton = this.findSkeleton(gltf.scene);
    if (skeleton) {
      report.skeleton = {
        boneCount: skeleton.bones.length,
        bones: skeleton.bones.map(b => b.name)
      };
    }

    return report;
  }
}

// Export para uso en ES6 modules
export default AvaturnAvatarValidator;
