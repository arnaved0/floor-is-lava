import bpy, bmesh, math, mathutils, sys, os
from mathutils import Vector, Matrix, Quaternion

FBX = os.environ.get("FBX_DIR", "fbx") + "/"         # Mixamo clip FBXs + y_bot.fbx
AVATAR = os.environ.get("AVATAR", "avatar.glb")      # the unrigged scan
TARGET_HEIGHT = 1.78  # metres, top of head


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def select_only(*objs):
    bpy.ops.object.mode_set(mode='OBJECT') if bpy.context.object and bpy.context.object.mode != 'OBJECT' else None
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]


def load_avatar():
    bpy.ops.import_scene.gltf(filepath=AVATAR)
    mesh = [o for o in bpy.context.scene.objects if o.type == 'MESH'][0]
    mesh.name = "Avatar"
    select_only(mesh)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # scan faces -X; Mixamo faces -Y -> rotate +90deg about Z
    vs = [v.co.copy() for v in mesh.data.vertices]
    zmin = min(v.z for v in vs); zmax = max(v.z for v in vs)
    s = TARGET_HEIGHT / (zmax - zmin)
    # centre on torso (use verts in hip band)
    band = [v for v in vs if zmin + 0.45 * (zmax - zmin) < v.z < zmin + 0.6 * (zmax - zmin)]
    # torso centre: median
    cx = sorted(v.x for v in band)[len(band) // 2]
    cy = sorted(v.y for v in band)[len(band) // 2]
    M = Matrix.Rotation(math.radians(90), 4, 'Z') @ Matrix.Diagonal((s, s, s, 1)) @ Matrix.Translation((-cx, -cy, -zmin))
    mesh.data.transform(M)
    mesh.data.update()
    # weld seams so bone heat sees one surface
    bm = bmesh.new(); bm.from_mesh(mesh.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
    bm.to_mesh(mesh.data); bm.free()
    return mesh


def load_ybot():
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=FBX + "y_bot.fbx")
    new = [o for o in bpy.data.objects if o not in before]
    arm = [o for o in new if o.type == 'ARMATURE'][0]
    for o in new:
        if o.type != 'ARMATURE':
            bpy.data.objects.remove(o, do_unlink=True)
    arm.name = "Rig"
    select_only(arm)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return arm


def stick_figure(arm, name="Sticks", radius=0.012):
    bm = bmesh.new()
    for pb in arm.pose.bones:
        h = arm.matrix_world @ pb.head; t = arm.matrix_world @ pb.tail
        d = t - h
        if d.length < 1e-5:
            continue
        m = Matrix.Translation((h + t) / 2) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=6, radius1=radius, radius2=radius * 0.5, depth=d.length, matrix=m)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    mat = bpy.data.materials.new("red"); mat.diffuse_color = (1, 0, 0, 1)
    me.materials.append(mat)
    return ob


def render_views(prefix, views=("front", "side"), center_z=0.9, ortho=2.0, color_type='TEXTURE', xray=False, res=(400, 600)):
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'FLAT' if xray else 'STUDIO'
    scene.display.shading.color_type = color_type
    scene.display.shading.show_xray = xray
    scene.display.shading.xray_alpha = 0.6
    scene.render.resolution_x, scene.render.resolution_y = res
    cam = bpy.data.objects.get("cam")
    if cam is None:
        cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
        scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = ortho
    dirs = {"front": Vector((0, -1, 0)), "side": Vector((1, 0, 0)), "back": Vector((0, 1, 0)), "q": Vector((1, -1, 0.4)).normalized()}
    for v in views:
        d = dirs[v]
        cam.location = Vector((0, 0, center_z)) + d * 6
        cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.abspath(f"{prefix}_{v}.png")
        bpy.ops.render.render(write_still=True)
