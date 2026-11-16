#!/usr/bin/env python3
"""Export a GLB to GLTF and FBX formats via Blender, with proper texture handling."""
import bpy
import sys
import os
import struct

# Get input GLB path from env var
glb_path = os.environ.get("EXPORT_GLB_INPUT")
out_dir = os.environ.get("EXPORT_OUT_DIR", "/tmp/opencode")

if not glb_path:
    print("ERROR: EXPORT_GLB_INPUT not set")
    sys.exit(1)

# Clear default scene
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

# Import GLB
bpy.ops.import_scene.gltf(filepath=glb_path)

# Extract textures from GLB binary and save as PNG files
# GLB format: 12-byte header, then chunks (length + type + data)
with open(glb_path, "rb") as f:
    data = f.read()

offset = 12
json_chunk = None
bin_chunk = None
while offset < len(data):
    chunk_len = struct.unpack_from("<I", data, offset)[0]
    chunk_type = data[offset + 4 : offset + 8]
    if chunk_type == b"JSON":
        json_chunk = data[offset + 8 : offset + 8 + chunk_len]
    elif chunk_type == b"BIN\x00":
        bin_chunk = data[offset + 8 : offset + 8 + chunk_len]
    offset += 8 + ((chunk_len + 3) & ~3)

if json_chunk is None or bin_chunk is None:
    print("ERROR: Could not parse GLB chunks")
    sys.exit(1)

import json
gltf = json.loads(json_chunk)

# Extract and save each image
texture_files = []
for i, img in enumerate(gltf.get("images", [])):
    bv_idx = img.get("bufferView")
    if bv_idx is None:
        continue
    bv = gltf["bufferViews"][bv_idx]
    byte_offset = bv.get("byteOffset", 0)
    byte_length = bv["byteLength"]
    img_data = bin_chunk[byte_offset : byte_offset + byte_length]

    # Determine extension from mimeType
    mime = img.get("mimeType", "image/png")
    ext = ".png" if "png" in mime else (".jpg" if "jpeg" in mime else ".png")

    # Use material name if available
    mat_name = img.get("name", f"texture_{i}")
    tex_filename = f"{mat_name}{ext}"
    tex_path = os.path.join(out_dir, tex_filename)
    with open(tex_path, "wb") as tf:
        tf.write(img_data)
    texture_files.append(tex_path)
    print(f"  Extracted texture: {tex_path}")

# Now set up Blender materials to use these extracted textures
for mat in bpy.data.materials:
    if not mat.node_tree:
        continue
    # Find the image texture node
    tex_node = None
    for node in mat.node_tree.nodes:
        if node.type == "TEX_IMAGE":
            tex_node = node
            break
    if tex_node and tex_node.image:
        img = tex_node.image
        # Find matching extracted file
        for tf in texture_files:
            if img.name in os.path.basename(tf):
                img.filepath = tf
                img.reload()
                break

# Simplify materials for FBX export (FBX exporter can't handle glTF Mix nodes)
# Also fix texture color space and disable backface culling to prevent missing faces
for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue
    for i, mat in enumerate(obj.data.materials):
        if not mat or not mat.node_tree:
            continue
        tex_image = None
        for node in mat.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image:
                tex_image = node.image
                break
        if tex_image:
            # Ensure sRGB color space for textures
            tex_image.colorspace_settings.name = "sRGB"
            
            # Create simple material with just diffuse texture
            new_mat = bpy.data.materials.new(name=mat.name + "_fbx")
            new_mat.use_nodes = True
            new_mat.use_backface_culling = False  # prevent missing faces
            nt = new_mat.node_tree
            bsdf = nt.nodes.get("Principled BSDF")
            tex_node = nt.nodes.new(type="ShaderNodeTexImage")
            tex_node.image = tex_image
            tex_node.interpolation = "Linear"
            tex_node.location = (-300, 0)
            nt.links.new(tex_node.outputs["Color"], bsdf.inputs["Base Color"])
            # Ensure alpha is not used (prevents transparency issues)
            if "Alpha" in bsdf.inputs:
                bsdf.inputs["Alpha"].default_value = 1.0
            obj.data.materials[i] = new_mat

base = os.path.splitext(os.path.basename(glb_path))[0]

# Export GLTF (embedded)
gltf_path = os.path.join(out_dir, f"{base}.gltf")
bpy.ops.export_scene.gltf(
    filepath=gltf_path,
    export_format="GLTF_EMBEDDED",
    export_texcoords=True,
    export_normals=True,
    export_colors=True,
    export_materials="EXPORT",
    export_animations=False,
    export_skins=True,
    export_def_bones=False,
    export_yup=True,
)
print(f"GLTF exported: {gltf_path}")

# Export FBX
fbx_path = os.path.join(out_dir, f"{base}.fbx")
bpy.ops.export_scene.fbx(
    filepath=fbx_path,
    use_selection=False,
    apply_scale_options="FBX_SCALE_ALL",
    axis_forward="-Z",
    axis_up="Y",
    object_types={"ARMATURE", "MESH"},
    use_mesh_modifiers=True,
    mesh_smooth_type="FACE",
    use_armature_deform_only=True,
    add_leaf_bones=False,
    bake_anim=False,
    path_mode="RELATIVE",
    embed_textures=False,
)
print(f"FBX exported: {fbx_path}")

print("EXPORT COMPLETE")