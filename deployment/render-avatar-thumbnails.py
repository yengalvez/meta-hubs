"""Render consistent transparent thumbnails for local avatar GLBs with Blender.

Run with:
  blender --background --python deployment/render-avatar-thumbnails.py -- \
    --input-dir /path/to/avatars --output-dir /path/to/thumbnails
"""

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def scene_bounds():
    corners = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        corners.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)

    if not corners:
        raise RuntimeError("GLB has no renderable mesh")

    minimum = Vector((min(p.x for p in corners), min(p.y for p in corners), min(p.z for p in corners)))
    maximum = Vector((max(p.x for p in corners), max(p.y for p in corners), max(p.z for p in corners)))
    return minimum, maximum


def point_at(obj, target):
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def add_area_light(name, location, energy, size, target):
    data = bpy.data.lights.new(name=name, type="AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    light = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(light)
    light.location = location
    point_at(light, target)


def render_avatar(glb_path, output_path):
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(glb_path))

    minimum, maximum = scene_bounds()
    center = (minimum + maximum) * 0.5
    height = max(maximum.z - minimum.z, 0.5)
    width = max(maximum.x - minimum.x, maximum.y - minimum.y, 0.3)

    camera_data = bpy.data.cameras.new("AvatarThumbnailCamera")
    camera = bpy.data.objects.new("AvatarThumbnailCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = max(height * 1.12, width * 1.8)
    camera.location = Vector((center.x, center.y - height * 3.0, center.z + height * 0.03))
    point_at(camera, Vector((center.x, center.y, minimum.z + height * 0.52)))

    light_target = Vector((center.x, center.y, minimum.z + height * 0.58))
    add_area_light(
        "Key",
        Vector((center.x - height, center.y - height * 1.5, center.z + height)),
        900,
        height,
        light_target,
    )
    add_area_light(
        "Fill",
        Vector((center.x + height, center.y - height, center.z + height * 0.3)),
        500,
        height,
        light_target,
    )
    add_area_light(
        "Rim",
        Vector((center.x, center.y + height, center.z + height)),
        700,
        height,
        light_target,
    )

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 720
    scene.render.resolution_y = 1280
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.render.filepath = str(output_path)
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.world.color = (0.025, 0.04, 0.08)
    bpy.ops.render.render(write_still=True)


def main():
    args = parse_args()
    input_dir = Path(args.input_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    glbs = sorted(input_dir.glob("*.glb"))
    if not glbs:
        raise RuntimeError(f"No GLB files found in {input_dir}")

    for glb_path in glbs:
        output_path = output_dir / f"{glb_path.stem}.png"
        print(f"Rendering {glb_path.name} -> {output_path.name}")
        render_avatar(glb_path, output_path)


if __name__ == "__main__":
    main()
