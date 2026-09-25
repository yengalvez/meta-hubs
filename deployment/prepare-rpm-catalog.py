"""Render an RPM catalogue without exporting or modifying the source avatars.
Run in a separate background Blender process, never in the owner's live scene.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector

def args():
    p = argparse.ArgumentParser()
    p.add_argument("--output-dir", required=True)
    p.add_argument("--sample", action="store_true")
    return p.parse_args(sys.argv[sys.argv.index("--") + 1:])

def reset():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures):
        for block in list(datablocks):
            if not block.users:
                datablocks.remove(block)

def aim(obj, target):
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()

def prepare_pose():
    for obj in bpy.context.scene.objects:
        if obj.type != "ARMATURE":
            continue
        for side, sign in (("Left", 1), ("Right", -1)):
            bone = next((b for b in obj.pose.bones if b.name.split(":")[-1] == side + "Arm"), None)
            if bone is None:
                raise RuntimeError("Missing RPM upper arm")
            # Render-only natural arms-down pose. Original GLB bytes stay intact.
            basis = bone.matrix.to_quaternion()
            current = bone.vector.normalized()
            wanted = Vector((sign * 0.10, -0.025, -1)).normalized()
            delta = current.rotation_difference(wanted)
            bone.rotation_mode = "QUATERNION"
            bone.rotation_quaternion = basis.inverted() @ delta @ basis
    bpy.context.view_layer.update()

def bounds():
    points = []
    graph = bpy.context.evaluated_depsgraph_get()
    for obj in bpy.context.scene.objects:
        # glTF importer creates a hidden Icosphere bone widget. It must never
        # frame the avatar: its -1m lower bound caused the empty bottom half.
        if obj.type != "MESH" or obj.hide_render or not obj.visible_get():
            continue
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        used_vertices = {i for polygon in mesh.polygons for i in polygon.vertices}
        points.extend(evaluated.matrix_world @ mesh.vertices[i].co for i in used_vertices)
        evaluated.to_mesh_clear()
    if not points:
        raise RuntimeError("Avatar has no evaluated mesh")
    return Vector(tuple(min(p[i] for p in points) for i in range(3))), Vector(tuple(max(p[i] for p in points) for i in range(3)))

def render(source, output):
    reset()
    bpy.ops.import_scene.gltf(filepath=str(source))
    prepare_pose()
    lo, hi = bounds()
    center, height = (lo + hi) * .5, hi.z - lo.z
    scene = bpy.context.scene
    engines = {x.identifier for x in scene.render.bl_rna.properties["engine"].enum_items}
    scene.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in engines else "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x, scene.render.resolution_y = 720, 1280
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "AgX"
    scene.world.color = (.12, .12, .12)
    data = bpy.data.cameras.new("CatalogueCamera")
    camera = bpy.data.objects.new("CatalogueCamera", data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    data.type = "ORTHO"
    data.ortho_scale = 1
    camera.location = center + Vector((0, -height * 3, 0))
    aim(camera, center)
    frame = data.view_frame(scene=scene)
    frame_width = max(v.x for v in frame) - min(v.x for v in frame)
    frame_height = max(v.y for v in frame) - min(v.y for v in frame)
    data.ortho_scale = max((hi.x - lo.x) / frame_width, height / frame_height) * 1.08
    for name, offset, power, size in (
        ("Key", (-1, -1.7, 1.1), 260, 2),
        ("Fill", (1.3, -1, .5), 150, 2),
        ("Rim", (0, 1.2, 1.3), 200, 1.5),
    ):
        light_data = bpy.data.lights.new(name, "AREA")
        light_data.energy, light_data.size = power, size
        light = bpy.data.objects.new(name, light_data)
        scene.collection.objects.link(light)
        light.location = center + Vector(offset)
        aim(light, center)
    scene.render.filepath = str(output)
    bpy.ops.render.render(write_still=True)
    return {"height": height, "width": hi.x-lo.x, "ortho_scale": data.ortho_scale}

def main():
    a = args()
    out = Path(a.output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    source_dir = Path("/Users/yengalvez/Downloads/AvatarsRPM")
    sources = sorted(source_dir.glob("*.glb"))
    sources.append(Path("/Users/yengalvez/Desktop/T/UNIE/Avatars/chica.glb"))
    if a.sample:
        sources = [source_dir / "CamisaNegra.glb", source_dir / "Wvestido.glb"]
    receipts = []
    for source in sources:
        original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        output = out / (source.stem + ".png")
        if output.exists():
            raise RuntimeError("Refusing to overwrite " + str(output))
        framing = render(source, output)
        if hashlib.sha256(source.read_bytes()).hexdigest() != original_hash:
            raise RuntimeError("Source avatar changed unexpectedly")
        receipts.append({"file": str(source), "sha256": original_hash, "thumbnail": str(output), "framing": framing})
        (out / "render-receipts.json").write_text(json.dumps(receipts, indent=2) + "\n")
        print("CATALOG_RENDERED " + source.name, flush=True)

if __name__ == "__main__":
    main()
