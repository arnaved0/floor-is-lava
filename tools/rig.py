"""Auto-rig the scanned avatar onto the Mixamo (mixamorig) skeleton and bake in Mixamo clips.

Pipeline
1. Load scan, scale to 1.78 m, face -Y, centre torso at origin.
2. Load Mixamo Y-Bot armature (rest = T-pose) and rescale bone chains to the scan's
   proportions while keeping every bone's direction/roll (so Mixamo rotations stay valid).
3. Duplicate the rig, pose the duplicate to match the scan's relaxed A-pose, apply as rest.
4. Bone-heat weights on a voxel-remeshed proxy of the scan, transferred onto the real mesh.
5. Pose the duplicate back into the T-pose and bake that deformation into the mesh, then
   bind the mesh to the T-pose rig. Rest pose == Mixamo rest pose.
6. Import Mixamo clips as NLA tracks and export a single GLB.
"""
import sys, os
sys.path.insert(0, __import__("os").path.dirname(__file__))
from common import *

OUT = os.path.abspath(os.environ.get("OUT", "player_raw.glb"))
PREVIEW = "--preview" in sys.argv

reset()
mesh = load_avatar()
# recentre: measured torso centre offset
mesh.data.transform(Matrix.Translation((-0.02, -0.03, 0)))
rig = load_ybot()
P = "mixamorig:"

# ---------------------------------------------------------------- 2. proportions
k = {}
for b in rig.data.bones:
    n = b.name[len(P):]
    if "UpLeg" in n: k[b.name] = 1.084
    elif n.endswith("Leg"): k[b.name] = 0.833
    elif n.startswith("Spine") or n == "Hips": k[b.name] = 1.04
    else: k[b.name] = 1.0

select_only(rig)
bpy.ops.object.mode_set(mode='EDIT')
eb = rig.data.edit_bones
old = {e.name: (e.head.copy(), e.tail.copy()) for e in eb}
new_head = {}
def visit(e):
    h0, t0 = old[e.name]
    if e.parent is None:
        nh = Vector((h0.x, h0.y, 0.95))
    else:
        ph0, _ = old[e.parent.name]
        nh = new_head[e.parent.name] + (h0 - ph0) * k[e.parent.name]
    new_head[e.name] = nh
    for c in e.children:
        visit(c)
visit(eb[P + "Hips"])
for e in eb:
    h0, t0 = old[e.name]
    roll = e.roll
    e.head = new_head[e.name]
    e.tail = new_head[e.name] + (t0 - h0) * k[e.name]
    e.roll = roll
bpy.ops.object.mode_set(mode='OBJECT')
for b in rig.data.bones:
    n = b.name[len(P):]
    if any(f in n for f in ("Thumb", "Index", "Middle", "Ring", "Pinky")) or n.endswith("_End"):
        b.use_deform = False

# ---------------------------------------------------------------- 3. fit rig (A-pose)
fit = rig.copy(); fit.data = rig.data.copy(); fit.name = "Fit"
bpy.context.scene.collection.objects.link(fit)

T = {  # bone -> world position its TAIL should reach (head is inherited)
    "LeftArm": (0.295, 0.045, 1.08), "LeftForeArm": (0.35, -0.02, 0.89), "LeftHand": (0.34, -0.075, 0.76),
    "RightArm": (-0.29, -0.075, 1.08), "RightForeArm": (-0.33, -0.16, 0.89), "RightHand": (-0.31, -0.21, 0.78),
    "LeftUpLeg": (0.138, 0.085, 0.46), "LeftLeg": (0.15, 0.07, 0.10), "LeftFoot": (0.17, -0.06, 0.03), "LeftToeBase": (0.18, -0.14, 0.03),
    "RightUpLeg": (-0.175, 0.01, 0.46), "RightLeg": (-0.195, 0.01, 0.10), "RightFoot": (-0.215, -0.11, 0.03), "RightToeBase": (-0.225, -0.20, 0.03),
    "Neck": (0.0, -0.06, 1.56), "Head": (0.0, -0.065, 1.78),
}
order = ["Neck", "Head", "LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand",
         "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"]
select_only(fit)
bpy.ops.object.mode_set(mode='POSE')
for n in order:
    pb = fit.pose.bones[P + n]
    bpy.context.view_layer.update()
    head = pb.head.copy(); cur = (pb.tail - pb.head).normalized()
    tgt = (Vector(T[n]) - head)
    if tgt.length < 1e-4: continue
    R = cur.rotation_difference(tgt.normalized()).to_matrix().to_4x4()
    pb.matrix = Matrix.Translation(head) @ R @ Matrix.Translation(-head) @ pb.matrix
bpy.context.view_layer.update()
if PREVIEW:
    bpy.ops.object.mode_set(mode='OBJECT')
    stick_figure(fit)
    render_views("fitA", views=("front", "side"), xray=True)
    sys.exit(0)
bpy.ops.pose.armature_apply(selected=False)
bpy.ops.object.mode_set(mode='OBJECT')

# ---------------------------------------------------------------- 4. weights via proxy
select_only(mesh, fit)
mesh.select_set(True); fit.select_set(True); bpy.context.view_layer.objects.active = fit
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
mesh.parent = None
for m in list(mesh.modifiers):
    mesh.modifiers.remove(m)
deform = [pb for pb in fit.pose.bones if fit.data.bones[pb.name].use_deform]
for pb in deform:
    if pb.name not in mesh.vertex_groups:
        mesh.vertex_groups.new(name=pb.name)

def seg_dist(p, a, b):
    ab = b - a; t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return (p - (a + ab * t)).length

segs = [(pb.name, fit.matrix_world @ pb.head, fit.matrix_world @ pb.tail) for pb in deform]
gi = {g.name: g.index for g in mesh.vertex_groups}
fixed = 0
for v in mesh.data.vertices:
    if any(g.weight > 1e-3 for g in v.groups):
        continue
    # fallback: inverse-distance to the two nearest bone segments
    d = sorted((seg_dist(v.co, a, b), n) for n, a, b in segs)[:2]
    w = [1.0 / max(x, 1e-3) ** 4 for x, _ in d]; s = sum(w)
    for (x, n), wi in zip(d, w):
        mesh.vertex_groups[gi[n]].add([v.index], wi / s, 'REPLACE')
    fixed += 1
print("fallback-weighted verts", fixed, "of", len(mesh.data.vertices))
select_only(mesh)
bpy.ops.object.vertex_group_limit_total(limit=4)
bpy.ops.object.vertex_group_normalize_all(lock_active=False)
# light smoothing to reduce seams between heat and fallback weights
bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
bpy.ops.object.vertex_group_smooth(group_select_mode='ALL', factor=0.5, repeat=2)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.vertex_group_limit_total(limit=4)
bpy.ops.object.vertex_group_normalize_all(lock_active=False)

# ---------------------------------------------------------------- 5. bake to T-pose
am = mesh.modifiers.new("arm", 'ARMATURE'); am.object = fit
select_only(fit); bpy.ops.object.mode_set(mode='POSE')
for pb in fit.pose.bones:
    c = pb.constraints.new('COPY_TRANSFORMS'); c.target = rig; c.subtarget = pb.name
bpy.context.view_layer.update()
bpy.ops.object.mode_set(mode='OBJECT')
select_only(mesh); bpy.ops.object.modifier_apply(modifier="arm")
bpy.data.objects.remove(fit, do_unlink=True)
mesh.parent = rig
am = mesh.modifiers.new("Armature", 'ARMATURE'); am.object = rig

# ---------------------------------------------------------------- 5b. "glutes" blend shape
# Mesh is in the Mixamo T-pose here: Z up, character faces -Y, so the back is +Y.
# Each buttock is a soft Gaussian blob pushed backwards/outwards along the surface normal.
GLUTE_AMP = 0.08           # metres of push at influence 1.0 (game may drive it past 1)
up_leg = {s: rig.data.bones[P + s + "UpLeg"].head_local for s in ("Left", "Right")}
hips_z = rig.data.bones[P + "Hips"].head_local.z
me = mesh.data
me.calc_normals_split() if hasattr(me, "calc_normals_split") else None
vs = me.vertices
back_y = max(v.co.y for v in vs if abs(v.co.z - (hips_z - 0.1)) < 0.04 and abs(v.co.x) < 0.15)
centres = [Vector((up_leg[s].x * 0.95, back_y - 0.06, hips_z - 0.16)) for s in ("Left", "Right")]
print("glute centres", [tuple(round(c_, 3) for c_ in c) for c in centres], "back_y", round(back_y, 3))
mesh.shape_key_add(name="Basis", from_mix=False)
sk = mesh.shape_key_add(name="glutes", from_mix=False)
sk.slider_max = 5.0   # the game drives this past 1.0
# Balloon-style inflation: every vertex near a buttock moves radially away from that
# buttock's centre (up, down, sideways and back), so the growth stays round.
# Directions from both centres are blended by weight so the cleft stays closed.
SX, SY, SZ = 0.11, 0.12, 0.11   # influence radii (x across, y depth, z height)
moved = 0
for v in vs:
    n = v.normal
    if v.co.y < centres[0].y - 0.13:          # leave the front of the body alone
        continue
    w_tot, dsum = 0.0, Vector((0, 0, 0))
    for c in centres:
        d = v.co - c
        w = math.exp(-((d.x / SX) ** 2 + (d.y / SY) ** 2 + (d.z / SZ) ** 2))
        if d.length > 1e-6:
            dsum += d.normalized() * w
        w_tot = max(w_tot, w)
    if w_tot < 0.01 or dsum.length < 1e-6:
        continue
    radial = dsum.normalized()
    dirv = (radial * 0.75 + n * 0.25).normalized()
    # fade out toward the front so the hips/crotch don't balloon
    front = min(1.0, max(0.0, (v.co.y - (centres[0].y - 0.13)) / 0.1))
    sk.data[v.index].co = v.co + dirv * GLUTE_AMP * w_tot * front
    moved += 1
print("glute verts moved", moved)
if "--glutes" in sys.argv:
    for val in (0.0, 1.0, 3.0):
        sk.value = val
        render_views(f"glutes_{val:.0f}", views=("side", "back", "q"), color_type='TEXTURE')
    sys.exit(0)

# ---------------------------------------------------------------- 6. animations
def fcurves_of(act):
    out = []
    for l in act.layers:
        for s in l.strips:
            for cb in s.channelbags:
                out.extend(cb.fcurves)
    return out

CLIPS = {  # game name : (file, keep hips horizontal motion?)
    "idle": "Standing_Idle", "walk": "Walking_In_Place", "run": "Running_In_Place", "sprint": "Sprinting_In_Place",
    "crouchIdle": "Crouching_Idle", "crouchWalk": "Sneaking_In_Place", "jump": "kcc_Jumping", "fall": "Falling_Idle",
    "land": "kcc_Landing", "roll": "Roll_In_Place", "wave": "Waving",
}
rig.animation_data_create()
hips_rest_h = rig.data.bones[P + "Hips"].head_local.z
for name, f in CLIPS.items():
    before = set(bpy.data.objects); acts_before = set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=FBX + f + ".fbx")
    newo = [o for o in bpy.data.objects if o not in before]
    src = [o for o in newo if o.type == 'ARMATURE'][0]
    act = [a for a in bpy.data.actions if a not in acts_before][0]
    sc = src.matrix_world.to_scale().x  # cm -> m (0.01)
    src_hips_h = (src.matrix_world @ src.data.bones[P + "Hips"].head_local).z
    ratio = hips_rest_h / src_hips_h
    for fc in fcurves_of(act):
        if fc.data_path.endswith(".location"):
            if P + "Hips" not in fc.data_path:
                # other bones: keep rest offsets (zero delta)
                for kp in fc.keyframe_points:
                    kp.co.y = 0; kp.handle_left.y = 0; kp.handle_right.y = 0
            else:
                for kp in fc.keyframe_points:
                    kp.co.y *= sc * ratio; kp.handle_left.y *= sc * ratio; kp.handle_right.y *= sc * ratio
    for o in newo:
        bpy.data.objects.remove(o, do_unlink=True)
    act.name = name
    act.use_fake_user = True
    tr = rig.animation_data.nla_tracks.new(); tr.name = name
    st = tr.strips.new(name, int(act.frame_range[0]), act)
    try:
        st.action_slot = act.slots[0]
    except Exception as e:
        print("slot", e)
    tr.mute = False
    print("clip", name, act.frame_range[:], "scale", sc, "ratio", round(ratio, 3))

# hips location in Mixamo is in hips-bone-local space of the source; both rigs share orientation.
rig.animation_data.action = None

# preview: render a few clip frames
if "--render" in sys.argv:
    for tr in rig.animation_data.nla_tracks: tr.mute = True
    for clip, frame in [("idle", 1), ("walk", 8), ("run", 6), ("crouchWalk", 10), ("jump", 12)]:
        tr = rig.animation_data.nla_tracks[clip]; tr.mute = False
        bpy.context.scene.frame_set(frame)
        render_views(f"pose_{clip}", views=("q",), color_type='TEXTURE')
        tr.mute = True
    bpy.context.scene.frame_set(1)
    render_views("tpose", views=("front", "side"), color_type='TEXTURE')
    for tr in rig.animation_data.nla_tracks: tr.mute = False

bpy.context.scene.render.fps = 30
select_only(rig, mesh)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True,
                          export_animation_mode='NLA_TRACKS', export_def_bones=False,
                          export_image_format='JPEG', export_jpeg_quality=85, export_apply=False,
                          export_force_sampling=True, export_optimize_animation_size=True)
print("exported", OUT, os.path.getsize(OUT))
