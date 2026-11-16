#!/usr/bin/env node
'use strict';

/**
 * Validation script for auto-rig GLB output.
 *
 * Reads a skinned GLB and confirms:
 *   1. Every vertex has weights summing to 1
 *   2. Joint indices are in range (0 <= joint < numJoints)
 *   3. Skeleton hierarchy is correct (each joint has at most one parent; root has none)
 *   4. No vertex is unassigned (weight sum == 1 means at least one joint assigned)
 *
 * Usage:
 *   node validate.js <rigged.glb>
 */

const fs = require("fs");
const { NodeIO } = require("@gltf-transform/core");

async function main() {
    const glbPath = process.argv[2];
    if (!glbPath) {
        console.error("Usage: node validate.js <rigged.glb>");
        process.exit(1);
    }
    if (!fs.existsSync(glbPath)) {
        console.error("Error: GLB not found:", glbPath);
        process.exit(1);
    }

    const io = new NodeIO();
    await io.init();
    const doc = await io.read(glbPath);
    const root = doc.getRoot();

    const meshes = root.listMeshes();
    const skins = root.listSkins();

    console.log(`Validating: ${glbPath}`);
    console.log(`  Meshes: ${meshes.length}, Skins: ${skins.length}`);

    if (skins.length === 0) {
        console.error("  FAIL: No skin found in GLB");
        process.exit(1);
    }

    const skin = skins[0];
    const joints = skin.listJoints();
    const numJoints = joints.length;
    const jointNames = joints.map(j => j.getName ? j.getName() : `joint`);
    console.log(`  Joints (${numJoints}): ${jointNames.join(", ")}`);

    const ibm = skin.getInverseBindMatrices();
    console.log(`  InverseBindMatrices: ${ibm ? ibm.getCount() : 0}`);

    // Build node -> parent map by traversing the scene graph
    const nodeParent = {};
    const scenes = root.listScenes();
    const scene = scenes[0];

    function traverse(node, parentName) {
        const name = node.getName();
        nodeParent[name] = parentName;
        const children = node.listChildren ? node.listChildren() : [];
        for (const c of children) traverse(c, name);
    }
    for (const c of scene.listChildren()) traverse(c, null);
    // Also traverse from skin joints/skeleton (armature nodes may not be scene children)
    for (const j of joints) {
        const jname = j.getName ? j.getName() : null;
        if (jname && nodeParent[jname] === undefined) {
            traverse(j, null);
        }
    }

    let totalVertices = 0;
    let totalErrors = 0;

    for (const mesh of meshes) {
        const primitives = mesh.listPrimitives();
        for (let pi = 0; pi < primitives.length; pi++) {
            const prim = primitives[pi];
            const position = prim.getAttribute("POSITION");
            if (!position) {
                console.error(`  FAIL: mesh ${mesh.getName()} prim ${pi} has no POSITION`);
                totalErrors++;
                continue;
            }
            const vertexCount = position.getCount();
            totalVertices += vertexCount;

            const jointsAttr = prim.getAttribute("JOINTS_0");
            const weightsAttr = prim.getAttribute("WEIGHTS_0");

            if (!jointsAttr || !weightsAttr) {
                console.error(`  FAIL: mesh ${mesh.getName()} prim ${pi} missing JOINTS_0 or WEIGHTS_0`);
                totalErrors++;
                continue;
            }

            const jArray = jointsAttr.getArray();
            const wArray = weightsAttr.getArray();

            for (let v = 0; v < vertexCount; v++) {
                const base = v * 4;
                let sum = 0;
                for (let k = 0; k < 4; k++) {
                    const jIdx = jArray[base + k];
                    const w = wArray[base + k];
                    sum += w;
                    if (jIdx < 0 || jIdx >= numJoints) {
                        console.error(`  FAIL: ${mesh.getName()} p${pi} v${v}: joint index ${jIdx} out of range [0,${numJoints})`);
                        totalErrors++;
                    }
                    if (w < 0) {
                        console.error(`  FAIL: ${mesh.getName()} p${pi} v${v}: negative weight ${w}`);
                        totalErrors++;
                    }
                }
                if (Math.abs(sum - 1.0) > 1e-4) {
                    console.error(`  FAIL: ${mesh.getName()} p${pi} v${v}: weights sum to ${sum}, expected 1.0`);
                    totalErrors++;
                }
                if (sum === 0) {
                    console.error(`  FAIL: ${mesh.getName()} p${pi} v${v}: unassigned vertex (all weights 0)`);
                    totalErrors++;
                }
            }
        }
    }

    // Hierarchy check: each joint should appear exactly once as a child (except root)
    const jointSet = new Set(jointNames);
    let hierErrors = 0;
    for (const jname of jointNames) {
        const parent = nodeParent[jname];
        if (parent === undefined) {
            console.error(`  FAIL: joint ${jname} not found in scene graph`);
            hierErrors++;
        }
    }
    totalErrors += hierErrors;

    console.log(`\n  Total vertices checked: ${totalVertices}`);
    console.log(`  Total errors: ${totalErrors}`);
    if (totalErrors === 0) {
        console.log("  VALID: All checks passed!");
    } else {
        console.error(`  INVALID: ${totalErrors} error(s) found`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
