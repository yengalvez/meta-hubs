#!/usr/bin/env python3
"""
blender_convert_animations.py

Script automatizado para convertir animaciones FBX de Mixamo a GLB para Hubs

Convierte todos los archivos FBX en un directorio a GLB optimizados:
- Extrae solo skeleton + animación (sin meshes)
- Reduce tamaño de archivo
- Valida que la animación se exportó correctamente

Uso:
    blender --background --python blender_convert_animations.py -- input_dir output_dir

Ejemplo:
    blender --background --python blender_convert_animations.py -- animations_fbx/ animations_glb/

Autor: Sistema de Animaciones Compartidas Hubs
Licencia: MIT
"""

import bpy
import sys
import os
from pathlib import Path

def log(message, level="INFO"):
    """Logger con colores"""
    colors = {
        "INFO": "\033[94m",   # Azul
        "OK": "\033[92m",     # Verde
        "WARN": "\033[93m",   # Amarillo
        "ERROR": "\033[91m",  # Rojo
        "RESET": "\033[0m"
    }

    prefix = {
        "INFO": "ℹ️ ",
        "OK": "✅",
        "WARN": "⚠️ ",
        "ERROR": "❌"
    }.get(level, "  ")

    color = colors.get(level, colors["RESET"])
    print(f"{color}{prefix} {message}{colors['RESET']}")


def clear_scene():
    """Limpia completamente la escena de Blender"""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(filepath):
    """Importa archivo FBX con configuración óptima"""
    bpy.ops.import_scene.fbx(
        filepath=filepath,
        automatic_bone_orientation=True,  # Importante para Mixamo
        use_custom_normals=False,
        use_image_search=False  # No necesitamos texturas
    )


def find_armature():
    """Encuentra el armature principal"""
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE':
            return obj
    return None


def remove_meshes():
    """Elimina todos los meshes, solo queremos skeleton + animación"""
    meshes_removed = 0

    for obj in list(bpy.data.objects):
        if obj.type == 'MESH':
            bpy.data.objects.remove(obj, do_unlink=True)
            meshes_removed += 1

    if meshes_removed > 0:
        log(f"Removed {meshes_removed} mesh(es)")


def validate_animation(armature):
    """Valida que el armature tiene animación"""
    if not armature.animation_data:
        return False, "No animation data"

    if not armature.animation_data.action:
        return False, "No action"

    action = armature.animation_data.action

    if len(action.fcurves) == 0:
        return False, "No fcurves (keyframes)"

    # Verificar que tiene animación de piernas (importante para walk/run)
    leg_bones = ['LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg']
    has_leg_animation = False

    for fcurve in action.fcurves:
        bone_name = fcurve.data_path.split('"')[1] if '"' in fcurve.data_path else ""
        if any(leg in bone_name for leg in leg_bones):
            has_leg_animation = True
            break

    if not has_leg_animation:
        log("No leg bone animation detected (may be upper-body only)", "WARN")

    # Calcular duración
    frame_start, frame_end = action.frame_range
    duration = (frame_end - frame_start) / bpy.context.scene.render.fps

    return True, {
        'duration': duration,
        'keyframes': len(action.fcurves),
        'has_legs': has_leg_animation,
        'frame_range': (int(frame_start), int(frame_end))
    }


def export_glb(filepath, armature):
    """Exporta armature como GLB optimizado"""

    # Seleccionar solo armature
    bpy.ops.object.select_all(action='DESELECT')
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature

    # Exportar con configuración óptima
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format='GLB',
        use_selection=True,  # Solo armature seleccionado
        export_animations=True,
        export_skins=True,
        export_all_influences=True,  # Importante para animaciones
        export_morph=False,
        export_lights=False,
        export_cameras=False,
        export_texcoords=False,  # No necesitamos UVs
        export_normals=False,    # No necesitamos normales
        export_materials='NONE',  # Sin materiales
        export_colors=False,
        export_apply=False,
        export_yup=True,  # Mixamo usa Y-up
        export_optimize_animation_size=True,  # Reducir tamaño
    )


def get_file_size_mb(filepath):
    """Retorna tamaño de archivo en MB"""
    size_bytes = os.path.getsize(filepath)
    return size_bytes / (1024 * 1024)


def convert_fbx_to_glb(input_dir, output_dir, verbose=False):
    """
    Convierte todos los FBX en input_dir a GLB en output_dir

    Args:
        input_dir: Directorio con archivos FBX
        output_dir: Directorio de salida para GLB
        verbose: Si True, muestra más información
    """

    input_path = Path(input_dir)
    output_path = Path(output_dir)

    # Validar input
    if not input_path.exists():
        log(f"Input directory not found: {input_dir}", "ERROR")
        return False

    # Crear output si no existe
    output_path.mkdir(parents=True, exist_ok=True)

    # Encontrar todos los FBX
    fbx_files = list(input_path.glob("*.fbx"))

    if len(fbx_files) == 0:
        log(f"No FBX files found in {input_dir}", "ERROR")
        return False

    log(f"Found {len(fbx_files)} FBX file(s) to convert")
    print()

    # Procesar cada archivo
    success_count = 0
    total_size_kb = 0

    for idx, fbx_file in enumerate(fbx_files, 1):
        log(f"[{idx}/{len(fbx_files)}] Processing: {fbx_file.name}")

        try:
            # 1. Limpiar escena
            clear_scene()

            # 2. Importar FBX
            import_fbx(str(fbx_file))

            # 3. Encontrar armature
            armature = find_armature()

            if not armature:
                log(f"No armature found in {fbx_file.name}", "WARN")
                continue

            if verbose:
                log(f"Found armature: {armature.name}")

            # 4. Eliminar meshes
            remove_meshes()

            # 5. Validar animación
            valid, result = validate_animation(armature)

            if not valid:
                log(f"Invalid animation: {result}", "ERROR")
                continue

            if verbose:
                log(f"Duration: {result['duration']:.2f}s")
                log(f"Keyframes: {result['keyframes']}")
                log(f"Frame range: {result['frame_range']}")
                log(f"Has leg animation: {result['has_legs']}")

            # 6. Preparar nombre de salida
            output_name = fbx_file.stem.lower().replace(" ", "_").replace("-", "_")
            output_file = output_path / f"{output_name}.glb"

            # 7. Exportar GLB
            export_glb(str(output_file), armature)

            # 8. Verificar resultado
            if not output_file.exists():
                log(f"Export failed: {output_file}", "ERROR")
                continue

            file_size_kb = get_file_size_mb(output_file) * 1024

            log(f"Exported: {output_file.name} ({file_size_kb:.1f} KB)", "OK")

            success_count += 1
            total_size_kb += file_size_kb

        except Exception as e:
            log(f"Error processing {fbx_file.name}: {e}", "ERROR")
            if verbose:
                import traceback
                traceback.print_exc()

        print()  # Línea en blanco entre archivos

    # Resumen final
    print("=" * 60)
    log(f"Conversion complete!", "OK")
    log(f"Success: {success_count}/{len(fbx_files)} files")
    log(f"Total size: {total_size_kb:.1f} KB ({total_size_kb/1024:.2f} MB)")
    print("=" * 60)

    return success_count > 0


def main():
    """Entry point"""

    # Parsear argumentos (después del --)
    argv = sys.argv

    if "--" not in argv:
        print()
        log("Usage: blender --background --python blender_convert_animations.py -- input_dir output_dir [--verbose]", "ERROR")
        print()
        print("Example:")
        print("  blender --background --python blender_convert_animations.py -- animations_fbx/ animations_glb/")
        print()
        sys.exit(1)

    argv = argv[argv.index("--") + 1:]

    if len(argv) < 2:
        log("Error: Missing input_dir and output_dir", "ERROR")
        sys.exit(1)

    input_dir = argv[0]
    output_dir = argv[1]
    verbose = "--verbose" in argv or "-v" in argv

    print()
    print("=" * 60)
    log("Blender Animation Converter for Hubs")
    print("=" * 60)
    log(f"Input: {input_dir}")
    log(f"Output: {output_dir}")
    log(f"Verbose: {verbose}")
    print("=" * 60)
    print()

    success = convert_fbx_to_glb(input_dir, output_dir, verbose)

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
