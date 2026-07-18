#!/usr/bin/env python3
"""
prepare-rpm-avatar.py

Script de Blender para pre-procesar avatares ReadyPlayer.me para Hubs Foundation

Funciones:
- Validar skeleton Mixamo
- Ajustar escala a altura estándar (1.7m)
- Centrar en origen
- Optimizar geometría (opcional)
- Verificar materiales y texturas
- Exportar GLB optimizado

Uso:
    blender --background --python prepare-rpm-avatar.py -- input.glb output.glb [--optimize] [--height 1.7]

Requisitos:
    - Blender 2.83 o superior
    - Avatar RPM en formato GLB

Autor: Integración RPM-Hubs
Licencia: MIT
"""

import bpy
import sys
import os
import argparse
import math

# ===== CONFIGURACIÓN =====

# Huesos requeridos (Mixamo full-body)
REQUIRED_BONES_MIXAMO = [
    "Hips",
    "Spine", "Spine1", "Spine2",
    "Neck", "Head",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    "LeftUpLeg", "LeftLeg", "LeftFoot",
    "RightUpLeg", "RightLeg", "RightFoot"
]

# Huesos opcionales
OPTIONAL_BONES = [
    "LeftToeBase", "RightToeBase",
    "LeftHandThumb1", "RightHandThumb1",
    # ... más dedos
]

DEFAULT_HEIGHT = 1.7  # metros
DEFAULT_TEXTURE_SIZE = 1024  # px


# ===== FUNCIONES AUXILIARES =====

def log(message, level="INFO"):
    """Logger simple"""
    prefix = {
        "INFO": "ℹ️ ",
        "SUCCESS": "✅",
        "WARNING": "⚠️ ",
        "ERROR": "❌"
    }.get(level, "  ")

    print(f"{prefix} {message}")


def clear_scene():
    """Limpia la escena de Blender"""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    log("Scene cleared")


def import_glb(filepath):
    """Importa archivo GLB"""
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"File not found: {filepath}")

    log(f"Importing GLB: {filepath}")

    bpy.ops.import_scene.gltf(filepath=filepath)

    log("Import complete", "SUCCESS")


def find_armature():
    """Encuentra el armature principal en la escena"""
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE':
            return obj

    return None


def validate_skeleton(armature):
    """Valida que el skeleton tiene la estructura Mixamo esperada"""
    if not armature:
        log("No armature found!", "ERROR")
        return False

    bones = armature.data.bones
    bone_names = [bone.name for bone in bones]

    log(f"Found {len(bones)} bones")

    # Verificar huesos requeridos
    missing_bones = [name for name in REQUIRED_BONES_MIXAMO if name not in bone_names]

    if missing_bones:
        log(f"Missing required bones: {', '.join(missing_bones)}", "WARNING")
        log("This may not be a valid Mixamo skeleton", "WARNING")
        return False

    log("Skeleton structure validated", "SUCCESS")
    return True


def print_bone_hierarchy(armature, max_depth=3):
    """Imprime jerarquía de huesos (para debugging)"""
    log("\nBone Hierarchy:")

    def print_bone(bone, depth=0):
        if depth > max_depth:
            return

        indent = "  " * depth
        print(f"{indent}├─ {bone.name}")

        for child in bone.children:
            print_bone(child, depth + 1)

    root_bones = [bone for bone in armature.data.bones if bone.parent is None]

    for root in root_bones:
        print_bone(root)


def calculate_avatar_height(armature):
    """Calcula altura del avatar (pies a cabeza)"""
    bones = armature.data.bones

    # Buscar Head bone
    head_bone = bones.get("Head")
    if not head_bone:
        log("Head bone not found, using armature bounds", "WARNING")
        # Fallback: usar bounds del armature
        return armature.dimensions.z

    # Calcular altura desde Hips (o root) hasta Head
    # En espacio world
    head_world_pos = armature.matrix_world @ head_bone.head_local

    # Asumir que los pies están en Y=0 (o usar LeftFoot/RightFoot)
    left_foot = bones.get("LeftFoot")
    right_foot = bones.get("RightFoot")

    if left_foot and right_foot:
        left_foot_pos = armature.matrix_world @ left_foot.head_local
        right_foot_pos = armature.matrix_world @ right_foot.head_local
        feet_avg_z = (left_foot_pos.z + right_foot_pos.z) / 2
    else:
        feet_avg_z = armature.location.z

    height = head_world_pos.z - feet_avg_z

    return height


def scale_avatar_to_height(armature, target_height):
    """Escala avatar a altura target"""
    current_height = calculate_avatar_height(armature)

    log(f"Current height: {current_height:.3f}m")
    log(f"Target height: {target_height:.3f}m")

    if abs(current_height - target_height) < 0.01:
        log("Height already correct", "SUCCESS")
        return

    scale_factor = target_height / current_height
    log(f"Scaling by factor: {scale_factor:.3f}")

    # Aplicar escala
    armature.scale = (scale_factor, scale_factor, scale_factor)
    bpy.ops.object.select_all(action='DESELECT')
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.transform_apply(scale=True)

    log("Scaling applied", "SUCCESS")


def center_avatar():
    """Centra avatar en el origen"""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.origin_set(type='ORIGIN_CENTER_OF_VOLUME', center='BOUNDS')

    # Mover a Z=0 (pies en el suelo)
    for obj in bpy.context.selected_objects:
        if obj.type == 'ARMATURE':
            # Buscar pies
            bones = obj.data.bones
            left_foot = bones.get("LeftFoot")
            right_foot = bones.get("RightFoot")

            if left_foot and right_foot:
                left_foot_z = (obj.matrix_world @ left_foot.head_local).z
                right_foot_z = (obj.matrix_world @ right_foot.head_local).z
                feet_avg_z = (left_foot_z + right_foot_z) / 2

                # Mover para que pies estén en Z=0
                obj.location.z -= feet_avg_z

                log("Avatar centered at origin, feet on ground", "SUCCESS")
            else:
                log("Could not find feet bones, centered by bounds", "WARNING")


def optimize_geometry():
    """Optimiza geometría del avatar (reduce poly count)"""
    log("Optimizing geometry...")

    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            log(f"  Processing mesh: {obj.name}")

            # Seleccionar objeto
            bpy.ops.object.select_all(action='DESELECT')
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj

            # Aplicar Decimate modifier (reducir a 80% de triángulos)
            modifier = obj.modifiers.new(name="Decimate", type='DECIMATE')
            modifier.ratio = 0.8

            bpy.ops.object.modifier_apply(modifier=modifier.name)

            log(f"    Optimized: {obj.name} (20% reduction)", "SUCCESS")

    log("Geometry optimization complete", "SUCCESS")


def check_materials_and_textures():
    """Verifica materiales y texturas"""
    log("\nMaterials and Textures:")

    for mat in bpy.data.materials:
        log(f"  Material: {mat.name}")

        if mat.use_nodes:
            for node in mat.node_tree.nodes:
                if node.type == 'TEX_IMAGE':
                    if node.image:
                        img = node.image
                        size = f"{img.size[0]}x{img.size[1]}"
                        log(f"    Texture: {img.name} ({size})")

                        if img.size[0] > DEFAULT_TEXTURE_SIZE or img.size[1] > DEFAULT_TEXTURE_SIZE:
                            log(f"      ⚠️  Large texture! Consider resizing to {DEFAULT_TEXTURE_SIZE}x{DEFAULT_TEXTURE_SIZE}", "WARNING")
                    else:
                        log(f"    Texture node missing image!", "WARNING")


def export_glb(output_path, optimize=False):
    """Exporta avatar como GLB"""
    log(f"\nExporting to: {output_path}")

    export_settings = {
        'filepath': output_path,
        'export_format': 'GLB',
        'export_texcoords': True,
        'export_normals': True,
        'export_materials': 'EXPORT',
        'export_colors': True,
        'export_cameras': False,
        'export_lights': False,
        'export_skins': True,
        'export_animations': False,  # Avatares son estáticos
        'export_optimize_animation_size': False,
        'export_apply': False,
    }

    # Opciones de optimización
    if optimize:
        export_settings.update({
            'export_draco_mesh_compression_enable': False,  # Draco puede causar problemas en Hubs
            'export_texture_dir': '',  # Embed textures
        })

    bpy.ops.export_scene.gltf(**export_settings)

    # Verificar que se creó el archivo
    if os.path.exists(output_path):
        file_size = os.path.getsize(output_path) / (1024 * 1024)  # MB
        log(f"Export complete: {file_size:.2f} MB", "SUCCESS")
    else:
        log("Export failed!", "ERROR")
        return False

    return True


# ===== FUNCIÓN PRINCIPAL =====

def process_avatar(input_glb, output_glb, target_height=DEFAULT_HEIGHT, optimize=False):
    """
    Procesa un avatar RPM completo

    Args:
        input_glb: Ruta al GLB de entrada
        output_glb: Ruta al GLB de salida
        target_height: Altura objetivo en metros
        optimize: Si se debe optimizar geometría
    """
    log("=" * 60)
    log("ReadyPlayer.me Avatar Processor for Hubs Foundation")
    log("=" * 60)

    # 1. Limpiar escena
    clear_scene()

    # 2. Importar GLB
    try:
        import_glb(input_glb)
    except Exception as e:
        log(f"Failed to import GLB: {e}", "ERROR")
        return False

    # 3. Encontrar armature
    armature = find_armature()

    if not armature:
        log("No armature found in GLB", "ERROR")
        return False

    log(f"Found armature: {armature.name}", "SUCCESS")

    # 4. Validar skeleton
    if not validate_skeleton(armature):
        log("Skeleton validation failed", "ERROR")
        return False

    # 5. Imprimir jerarquía (debugging)
    if "--verbose" in sys.argv:
        print_bone_hierarchy(armature)

    # 6. Ajustar escala
    scale_avatar_to_height(armature, target_height)

    # 7. Centrar avatar
    center_avatar()

    # 8. Optimizar geometría (opcional)
    if optimize:
        optimize_geometry()

    # 9. Verificar materiales
    check_materials_and_textures()

    # 10. Exportar GLB
    success = export_glb(output_glb, optimize)

    if success:
        log("\n" + "=" * 60)
        log("✅ Avatar ready for Hubs Foundation!", "SUCCESS")
        log("=" * 60)
        return True
    else:
        log("Processing failed", "ERROR")
        return False


# ===== ENTRY POINT =====

def main():
    """Entry point del script"""

    # Parsear argumentos (después del --)
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        log("Usage: blender --background --python prepare-rpm-avatar.py -- input.glb output.glb [--optimize] [--height 1.7]", "ERROR")
        sys.exit(1)

    parser = argparse.ArgumentParser(description="Prepare RPM avatar for Hubs")
    parser.add_argument("input", help="Input GLB file")
    parser.add_argument("output", help="Output GLB file")
    parser.add_argument("--optimize", action="store_true", help="Optimize geometry")
    parser.add_argument("--height", type=float, default=DEFAULT_HEIGHT, help="Target height in meters")
    parser.add_argument("--verbose", action="store_true", help="Verbose output")

    args = parser.parse_args(argv)

    # Procesar avatar
    success = process_avatar(
        input_glb=args.input,
        output_glb=args.output,
        target_height=args.height,
        optimize=args.optimize
    )

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
