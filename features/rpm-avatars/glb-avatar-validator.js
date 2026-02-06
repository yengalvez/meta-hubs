/**
 * Hubs GLB Avatar Validator
 *
 * Validates and processes GLB avatars (ReadyPlayer.me, Avaturn, or custom)
 * to ensure compatibility with Mozilla Hubs (hubs-foundation).
 *
 * Based on lessons learned from ReadyPlayer.me integration issues:
 * - #5964: Half-body avatars
 * - #4847: Speaking indicators
 * - #5532: Third-person view
 */

import * as THREE from "three";

export class HubsGLBAvatarValidator {
  constructor() {
    // Required bones for a functional avatar in Hubs
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

    // Finger keywords for animation filtering
    this.fingerKeywords = [
      'thumb', 'index', 'middle', 'ring', 'pinky', 'finger'
    ];
  }

  /**
   * Validates a GLB avatar for Hubs compatibility
   * @param {Object} gltf - Loaded GLTF object
   * @returns {Object} { valid: boolean, errors: string[], warnings: string[] }
   */
  async validate(gltf) {
    const errors = [];
    const warnings = [];

    // 1. Check basic structure
    if (!gltf || !gltf.scene) {
      errors.push("Invalid GLTF/GLB file: missing scene");
      return { valid: false, errors, warnings };
    }

    // 2. Check skeleton
    const skeleton = this.findSkeleton(gltf.scene);
    if (!skeleton) {
      errors.push("No skeleton found in avatar");
    } else {
      const missingBones = this.checkRequiredBones(skeleton);
      if (missingBones.length > 0) {
        warnings.push(`Missing recommended bones: ${missingBones.join(", ")}`);
      }
    }

    // 3. Check materials
    const materials = this.getMaterials(gltf);
    if (materials.length === 0) {
      errors.push("No materials found");
    }

    // 4. Check textures
    const textureIssues = this.checkTextures(materials);
    warnings.push(...textureIssues);

    // 5. Check animations
    if (gltf.animations && gltf.animations.length > 0) {
      const animIssues = this.checkAnimations(gltf.animations);
      warnings.push(...animIssues);
    }

    // 6. Check geometry
    const geometryIssues = this.checkGeometry(gltf);
    warnings.push(...geometryIssues);

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Processes a GLB avatar to optimize for Hubs
   * @param {Object} gltf - Loaded GLTF object
   * @returns {Object} Processed GLTF
   */
  process(gltf) {
    console.log("[HubsGLBValidator] Processing avatar...");

    // 1. Filter problematic animations
    if (gltf.animations && gltf.animations.length > 0) {
      console.log("[HubsGLBValidator] Filtering animations...");
      this.filterAnimations(gltf);
    }

    // 2. Ensure Bot_PBS material
    console.log("[HubsGLBValidator] Ensuring Bot_PBS material...");
    this.ensureBotPBSMaterial(gltf);

    // 3. Optimize textures
    console.log("[HubsGLBValidator] Optimizing textures...");
    this.optimizeTextures(gltf);

    // 4. Add Hubs components
    console.log("[HubsGLBValidator] Adding Hubs components...");
    this.addHubsComponents(gltf);

    // 5. Optimize geometry
    console.log("[HubsGLBValidator] Optimizing geometry...");
    this.optimizeGeometry(gltf);

    console.log("[HubsGLBValidator] Processing complete");
    return gltf;
  }

  // ========== VALIDATION METHODS ==========

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
    return [...new Set(materials)];
  }

  checkTextures(materials) {
    const warnings = [];
    materials.forEach(material => {
      if (material.map && material.map.image) {
        const { width, height } = material.map.image;

        if (width > 2048 || height > 2048) {
          warnings.push(
            `Texture "${material.name}" is ${width}x${height} ` +
            `(recommended max 2048x2048 for web performance)`
          );
        }

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
      const hasVectorTracks = clip.tracks.some(track =>
        track instanceof THREE.VectorKeyframeTrack
      );

      if (hasVectorTracks) {
        warnings.push(
          `Animation "${clip.name}" has VectorKeyframeTracks ` +
          `(may cause T-Pose flashing, will be filtered)`
        );
      }

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

  // ========== PROCESSING METHODS ==========

  /**
   * Filters problematic animations.
   * Based on fixes from ReadyPlayer.me Hubs issues.
   */
  filterAnimations(gltf) {
    gltf.animations.forEach(clip => {
      // 1. Keep only QuaternionKeyframeTracks (rotation)
      const quaternionTracks = clip.tracks.filter(track =>
        track instanceof THREE.QuaternionKeyframeTrack
      );

      // 2. Remove finger/hand tracks that cause T-Pose flashing
      const filteredTracks = quaternionTracks.filter(track => {
        const name = track.name.toLowerCase();
        const isFingerTrack = this.fingerKeywords.some(keyword =>
          name.includes(keyword)
        );
        return !isFingerTrack;
      });

      const originalCount = clip.tracks.length;
      clip.tracks = filteredTracks;

      console.log(
        `[HubsGLBValidator] Animation "${clip.name}": ` +
        `${originalCount} tracks -> ${filteredTracks.length} tracks`
      );
    });
  }

  /**
   * Ensures the avatar has the Bot_PBS material required by Hubs.
   */
  ensureBotPBSMaterial(gltf) {
    const MAT_NAME = "Bot_PBS";

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
      console.log(`[HubsGLBValidator] Bot_PBS material already exists`);
      return;
    }

    // Rename first material found to Bot_PBS
    gltf.scene.traverse(node => {
      if (node.isMesh && node.material && !hasBotPBS) {
        if (Array.isArray(node.material)) {
          console.log(
            `[HubsGLBValidator] Renaming material "${node.material[0].name}" -> "${MAT_NAME}"`
          );
          node.material[0].name = MAT_NAME;
        } else {
          console.log(
            `[HubsGLBValidator] Renaming material "${node.material.name}" -> "${MAT_NAME}"`
          );
          node.material.name = MAT_NAME;
        }
        hasBotPBS = true;
      }
    });
  }

  /**
   * Optimizes textures for web performance.
   */
  optimizeTextures(gltf) {
    gltf.scene.traverse(node => {
      if (node.isMesh && node.material) {
        const materials = Array.isArray(node.material)
          ? node.material
          : [node.material];

        materials.forEach(material => {
          // Base color maps need sRGB encoding
          if (material.map) {
            material.map.encoding = THREE.sRGBEncoding;
            material.map.generateMipmaps = true;
            material.map.anisotropy = 4;
          }

          // Normal maps always use Linear encoding
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

          material.precision = "highp";
          material.shadowSide = THREE.FrontSide;
        });
      }
    });
  }

  /**
   * Adds Hubs-specific components to the avatar (audio feedback).
   */
  addHubsComponents(gltf) {
    if (!gltf.userData) {
      gltf.userData = {};
    }

    if (!gltf.userData.gltfExtensions) {
      gltf.userData.gltfExtensions = {};
    }

    // Add scale-audio-feedback to the Head bone
    gltf.scene.traverse(node => {
      const nodeName = node.name.toLowerCase();

      if (nodeName.includes('head')) {
        if (!node.userData) {
          node.userData = {};
        }
        if (!node.userData.gltfExtensions) {
          node.userData.gltfExtensions = {};
        }

        node.userData.gltfExtensions.MOZ_hubs_components = {
          "scale-audio-feedback": {
            minScale: 1.0,
            maxScale: 1.3
          }
        };

        console.log(`[HubsGLBValidator] Added scale-audio-feedback to "${node.name}"`);
      }
    });
  }

  /**
   * Optimizes geometry for better performance.
   */
  optimizeGeometry(gltf) {
    gltf.scene.traverse(node => {
      if (node.isMesh && node.geometry) {
        const geometry = node.geometry;

        if (!geometry.boundingSphere) {
          geometry.computeBoundingSphere();
        }

        if (!geometry.boundingBox) {
          geometry.computeBoundingBox();
        }

        if (!geometry.attributes.normal) {
          geometry.computeVertexNormals();
        }
      }
    });
  }

  // ========== UTILITY METHODS ==========

  /**
   * Generates a detailed report of the avatar.
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

    report.overview = { meshCount, vertexCount, triangleCount };

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

export default HubsGLBAvatarValidator;
