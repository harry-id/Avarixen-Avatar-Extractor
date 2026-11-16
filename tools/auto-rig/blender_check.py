#!/usr/bin/env python3
"""
Blender check script for auto-rigged GLB output.

Imports a GLB, lists the armature's bones and each mesh's vertex groups,
then rotates one arm/leg bone by 45 degrees and reports whether the
vertices of that limb moved while the torso stayed still.

Usage with Blender 3.6:

    blender --background --python tools/auto-rig/blender_check.py -- \
        --input /path/to/rigged.glb [--bone LeftUpperArm] [--angle 45]

Without Blender on PATH, install Blender 3.6+ and run the command above.
"""

import sys
import os
import math
import argparse

try:
    import bpy
    import mathutils
except ImportError:
    print("ERROR: bpy module not found. Run this script inside Blender (e.g. "
          "`blender --background --python blender_check.py -- --input file.glb`).")
    sys.exit(1)


def clear_scene():
    """Remove all default objects (cube, light, camera)."""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def import_glb(filepath):
    """Import a GLB file. Returns list of imported objects."""
    before = set(bpy.data.objects.keys())
    bpy.ops.import_scene.gltf(filepath=filepath)
    after = set(bpy.data.objects.keys())
    new_objs = [bpy.data.objects[name] for name in after - before]
    return new_objs


def find_armature(objects):
    for obj in objects:
        if obj.type == "ARMATURE":
            return obj
    return None


def list_bones(armature):
    print("\n=== Armature bones ===")
    for bone in armature.data.bones:
        parent = bone.parent.name if bone.parent else "(none)"
        print(f"  {bone.name:<24} parent={parent:<24} head={tuple(round(c, 3) for c in bone.head_local)}")


def list_vertex_groups(meshes):
    print("\n=== Mesh vertex groups ===")
    for mesh in meshes:
        if mesh.type != "MESH":
            continue
        vg_names = [vg.name for vg in mesh.vertex_groups]
        print(f"  {mesh.name:<24} vertex_groups={vg_names}")


def capture_positions(mesh):
    """Capture world-space vertex positions of a mesh (post-modifier/deformed)."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    eval_obj = mesh.evaluated_get(depsgraph)
    eval_mesh = eval_obj.to_mesh()
    try:
        world = eval_obj.matrix_world
        positions = [tuple(mathutils.Vector(world @ v.co)) for v in eval_mesh.vertices]
    finally:
        bpy.data.meshes.remove(eval_mesh)
    return positions


def positions_moved(before, after, threshold=1e-4):
    """Return True if any vertex moved beyond threshold."""
    for b, a in zip(before, after):
        if (mathutils.Vector(b) - mathutils.Vector(a)).length > threshold:
            return True
    return False


def main():
    parser = argparse.ArgumentParser(description="Validate auto-rigged GLB in Blender")
    parser.add_argument("--input", default=None, help="Path to rigged .glb file")
    parser.add_argument("--bone", default=None,
                        help="Bone to rotate for the movement test")
    parser.add_argument("--angle", type=float, default=45.0,
                        help="Rotation angle in degrees")
    args, _ = parser.parse_known_args()

    # Fallback to environment variables (Blender's -- arg separator is unreliable)
    if not args.input:
        args.input = os.environ.get("BLENDER_GLB_INPUT")
    if not args.input:
        print("ERROR: --input or BLENDER_GLB_INPUT is required")
        sys.exit(1)
    if not args.bone:
        args.bone = os.environ.get("BLENDER_GLB_BONE", "LeftUpperArm")
    if args.angle == 45.0 and os.environ.get("BLENDER_GLB_ANGLE"):
        args.angle = float(os.environ.get("BLENDER_GLB_ANGLE"))

    clear_scene()

    imported = import_glb(args.input)
    armature = find_armature(imported)
    meshes = [o for o in imported if o.type == "MESH"]

    if not armature:
        print("ERROR: No armature found in imported GLB")
        sys.exit(1)

    print(f"Imported {len(imported)} object(s): {len(meshes)} mesh(es), 1 armature")
    list_bones(armature)
    list_vertex_groups(meshes)

    # Ensure every mesh has an armature modifier pointing to the armature
    for m in meshes:
        if m.type != "MESH":
            continue
        has_arm_mod = any(mod.type == "ARMATURE" for mod in m.modifiers)
        if not has_arm_mod:
            mod = m.modifiers.new(name="Armature", type="ARMATURE")
            mod.object = armature
        else:
            for mod in m.modifiers:
                if mod.type == "ARMATURE":
                    mod.object = armature
        # Enable preserve volume (dual quaternion skinning) to prevent LBS pinching at joints
        for mod in m.modifiers:
            if mod.type == "ARMATURE":
                mod.use_deform_preserve_volume = True

    # --- Movement test ------------------------------------------------------
    # Select the armature and enter pose mode
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="POSE")

    bone_name = args.bone
    pose_bone = armature.pose.bones.get(bone_name)
    if pose_bone is None:
        print(f"\nERROR: Bone '{bone_name}' not found in armature")
        print(f"Available bones: {[b.name for b in armature.pose.bones]}")
        sys.exit(1)

    # Capture positions before rotating (evaluated/deformed via depsgraph)
    depsgraph = bpy.context.evaluated_depsgraph_get()

    def captured_positions_for(dg):
        """Return dict of mesh name -> list of world-space vertex positions."""
        result = {}
        for m in meshes:
            if m.type != "MESH":
                continue
            eval_obj = dg.objects.get(m.name)
            if eval_obj is None:
                continue
            eval_mesh = eval_obj.to_mesh()
            try:
                world = eval_obj.matrix_world
                result[m.name] = [
                    tuple(mathutils.Vector(world @ v.co)) for v in eval_mesh.vertices
                ]
            finally:
                # to_mesh() creates a new mesh owned by eval_obj; don't remove
                # from bpy.data.meshes (it's not registered there).
                pass
        return result

    before = captured_positions_for(depsgraph)

    # Rotate the pose bone around its local X axis
    pose_bone.rotation_mode = "XYZ"
    pose_bone.rotation_euler = mathutils.Euler(
        (math.radians(args.angle), 0, 0), "XYZ"
    )
    bpy.context.view_layer.update()

    # Re-evaluate after rotating
    depsgraph2 = bpy.context.evaluated_depsgraph_get()
    after = captured_positions_for(depsgraph2)

    print(f"\n=== Movement test: rotate '{bone_name}' by {args.angle}° ===")

    # --- Movement test using vertex groups ---------------------------------
    # For each mesh that has a vertex group matching the bone name, check if
    # those vertices moved when the bone was rotated.
    def mesh_vertices_in_group(mesh, group_name):
        """Return indices of vertices in the given vertex group, or None."""
        vg = mesh.vertex_groups.get(group_name)
        if vg is None:
            return None
        idx = []
        for v in mesh.data.vertices:
            for g in v.groups:
                if g.group == vg.index:
                    idx.append(v.index)
                    break
        return idx if idx else None

    limb_moved = False
    limb_checked = False
    for m in meshes:
        if m.type != "MESH":
            continue
        vidx = mesh_vertices_in_group(m, bone_name)
        if vidx is None:
            continue
        limb_checked = True
        bpos = [before[m.name][i] for i in vidx]
        apos = [after[m.name][i] for i in vidx]
        if positions_moved(bpos, apos):
            limb_moved = True

    # Torso: check meshes with "Torso" vertex group
    torso_still = True
    torso_checked = False
    for m in meshes:
        if m.type != "MESH":
            continue
        vidx = mesh_vertices_in_group(m, "Torso")
        if vidx is None:
            continue
        torso_checked = True
        bpos = [before[m.name][i] for i in vidx]
        apos = [after[m.name][i] for i in vidx]
        if positions_moved(bpos, apos):
            torso_still = False

    print(f"  Limb vertex group checked: {limb_checked}")
    print(f"  Torso vertex group checked: {torso_checked}")
    print(f"  Limb vertices moved: {limb_moved}")
    print(f"  Torso vertices stayed still: {torso_still}")

    if limb_checked and limb_moved and torso_still:
        print("  RESULT: PASS — rig deforms correctly")
    elif limb_checked and not limb_moved:
        print("  RESULT: FAIL — limb vertices did not move (weights not applied?)")
    elif not torso_still:
        print("  RESULT: FAIL — torso vertices moved (incorrect hierarchy/weights?)")
    else:
        print("  RESULT: UNCLEAR")


if __name__ == "__main__":
    main()
