"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
    parseObj,
    parseObjString,
    parseMtl,
    detectRigType,
    detectNamedRigType,
    resolveRigType,
    computeCompatibility,
    computeBox,
    computeRecenter,
    resolvePartMapping,
    matchBodyParts,
    getPartInfo,
    convertAvatar,
    assignHandleBone,
    splitHandleGroups,
    computeJoints,
    buildParentMap,
    subdivideParsed
} = require("../auto-rig");

const OBJ_FIXTURE = `# minimal avatar
mtllib avatar.mtl
v 0 0 0
v 2 0 0
v 0 2 0
vt 0 0
vt 1 0
vt 0 1
vn 0 0 1
usemtl cloth
g Player1
f 1/1/1 2/2/1 3/3/1
g Handle1
f 1/1/1 2/2/1 3/3/1
`;

const MTL_FIXTURE = `newmtl cloth
Kd 0.8 0.8 0.8
map_Kd texture1.png
`;

test("parseObj keeps groups, faces, and materials", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-test-"));
    const objPath = path.join(dir, "avatar.obj");

    try {
        fs.writeFileSync(objPath, OBJ_FIXTURE);

        const parsed = parseObj(objPath);

        assert.equal(parsed.groups.length, 2);
        assert.deepEqual(parsed.groups.map((g) => g.name), ["Player1", "Handle1"]);
        assert.equal(parsed.groups[0].faceCount, 1);
        assert.equal(parsed.groups[0].material, "cloth");
        assert.equal(parsed.faces.length, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("parseMtl reads Kd and map_Kd", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-test-"));
    const mtlPath = path.join(dir, "avatar.mtl");

    try {
        fs.writeFileSync(mtlPath, MTL_FIXTURE);

        const materials = parseMtl(mtlPath);

        assert.deepEqual(materials.cloth.Kd, [0.8, 0.8, 0.8]);
        assert.equal(materials.cloth.map_Kd, "texture1.png");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("detectRigType accepts R6 and full/partial R15 player groups", () => {
    assert.equal(detectRigType(6), "R6");
    assert.equal(detectRigType(15), "R15");
    assert.equal(detectRigType(14), "R15");
    assert.equal(detectRigType(7), "R15");
    assert.equal(detectRigType(5), null);
    assert.equal(detectRigType(16), null);
});

test("computeBox reports bounds and centre", () => {
    const positions = [0, 0, 0, 2, 4, 6];
    const box = computeBox([0, 1], positions);

    assert.equal(box.cx, 1);
    assert.equal(box.cy, 2);
    assert.equal(box.cz, 3);
    assert.equal(box.sx, 2);
    assert.equal(box.sy, 4);
    assert.equal(box.sz, 6);
});

test("computeRecenter centres X/Z and puts feet on y = 0", () => {
    const boxes = {
        Torso: { cx: 2, cz: 4, ymin: 10 },
        Head: { cx: 6, cz: 8, ymin: 20 }
    };

    const recenter = computeRecenter(boxes, { Torso: "Torso", Head: "Head" });

    assert.equal(recenter.offsetX, 4);
    assert.equal(recenter.offsetZ, 6);
    assert.equal(recenter.offsetY, 10);
});

test("matchBodyParts maps R6 groups by position", () => {
    const boxes = {
        Head: { cx: 0, cy: 12 },
        Torso: { cx: 0, cy: 8 },
        LeftArm: { cx: -2, cy: 8 },
        RightArm: { cx: 2, cy: 8 },
        LeftLeg: { cx: -1, cy: 2 },
        RightLeg: { cx: 1, cy: 2 }
    };

    const playerGroups = Object.keys(boxes).map((name) => ({ name }));
    const mapping = matchBodyParts(playerGroups, boxes);

    assert.equal(mapping.Head, "Head");
    assert.equal(mapping.Torso, "Torso");
    assert.equal(mapping["Left Arm"], "LeftArm");
    assert.equal(mapping["Right Arm"], "RightArm");
    assert.equal(mapping["Left Leg"], "LeftLeg");
    assert.equal(mapping["Right Leg"], "RightLeg");
});

test("detectNamedRigType recognizes renamed body-part groups", () => {
    const r6 = ["Head", "Torso", "Left Arm", "Right Arm", "Left Leg", "Right Leg"];
    const partial = ["Head", "Torso", "Left Arm"];
    const r15 = [
        "Head", "UpperTorso", "LowerTorso",
        "LeftUpperArm", "RightUpperArm", "LeftLowerArm", "RightLowerArm",
        "LeftHand", "RightHand",
        "LeftUpperLeg", "RightUpperLeg", "LeftLowerLeg", "RightLowerLeg",
        "LeftFoot", "RightFoot"
    ];

    assert.equal(detectNamedRigType(r6.map((name) => ({ name }))), "R6");
    assert.equal(detectNamedRigType(partial.map((name) => ({ name }))), null);
    assert.equal(detectNamedRigType(r15.map((name) => ({ name }))), "R15");

    // Partial named R15 (missing a forearm + foot): still detected as R15.
    const partialR15 = r15.filter(
        (name) => name !== "RightLowerArm" && name !== "RightFoot"
    );
    assert.equal(detectNamedRigType(partialR15.map((name) => ({ name }))), "R15");

    // 13 of 15 parts (missing LeftLowerLeg + RightFoot).
    const partialR15b = r15.filter(
        (name) => name !== "LeftLowerLeg" && name !== "RightFoot"
    );
    assert.equal(detectNamedRigType(partialR15b.map((name) => ({ name }))), "R15");
});

test("resolveRigType disambiguates with the Roblox hint", () => {
    const six = ["Player1", "Player2", "Player3", "Player4", "Player5", "Player6"]
        .map((name) => ({ name }));

    // Six groups, no hint -> R6.
    assert.deepEqual(resolveRigType(six, 6, null), { rigType: "R6", source: "players" });

    // Six groups but Roblox says R15 (merged R15) -> R15 via hint.
    assert.deepEqual(resolveRigType(six, 6, "R15"), { rigType: "R15", source: "hint" });

    // Six groups, Roblox says R6 -> R6 via hint.
    assert.deepEqual(resolveRigType(six, 6, "R6"), { rigType: "R6", source: "hint" });

    // Named partial R15 wins over the hint.
    const named = ["Head", "UpperTorso", "LowerTorso", "LeftUpperArm",
        "RightUpperArm", "LeftHand", "RightHand", "LeftUpperLeg", "RightUpperLeg"]
        .map((name) => ({ name }));
    assert.deepEqual(resolveRigType(named, 0, null), { rigType: "R15", source: "named" });

    // Nothing to go on -> null.
    assert.deepEqual(resolveRigType([], 0, null), { rigType: null, source: null });

    // No geometry but a hint still classifies.
    assert.deepEqual(resolveRigType([], 0, "R15"), { rigType: "R15", source: "hint" });
});

test("computeCompatibility reports complete vs partial rigs", () => {
    const fullR6 = {
        Head: "Head", Torso: "Torso", "Left Arm": "LeftArm",
        "Right Arm": "RightArm", "Left Leg": "LeftLeg", "Right Leg": "RightLeg"
    };
    const r6 = computeCompatibility("R6", fullR6);
    assert.equal(r6.status, "compatible");
    assert.equal(r6.complete, true);
    assert.deepEqual(r6.missing, []);

    const partialR15 = {
        Head: "Head", UpperTorso: "UpperTorso", LowerTorso: "LowerTorso",
        LeftUpperArm: "LeftUpperArm", RightUpperArm: "RightUpperArm",
        LeftHand: "LeftHand", RightHand: "RightHand"
    };
    const r15 = computeCompatibility("R15", partialR15);
    assert.equal(r15.status, "partial");
    assert.equal(r15.complete, false);
    assert.equal(r15.expected, 15);
    assert.equal(r15.matched, 7);
    assert.ok(r15.missing.includes("LeftFoot"));

    const none = computeCompatibility(null, {});
    assert.equal(none.status, "incompatible");
    assert.equal(none.complete, false);
});

test("getPartInfo maps renamed groups back to body parts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-test-"));
    const obj = [
        "g Head",
        "v 0 12 0",
        "v 1 12 0",
        "v 0 13 0",
        "f 1 2 3",
        "g Torso",
        "v 0 8 0",
        "v 1 8 0",
        "v 0 9 0",
        "f 4 5 6",
        "g Left Arm",
        "v -2 8 0",
        "v -1 8 0",
        "v -2 9 0",
        "f 7 8 9",
        "g Right Arm",
        "v 2 8 0",
        "v 3 8 0",
        "v 2 9 0",
        "f 10 11 12",
        "g Left Leg",
        "v -1 2 0",
        "v 0 2 0",
        "v -1 3 0",
        "f 13 14 15",
        "g Right Leg",
        "v 1 2 0",
        "v 2 2 0",
        "v 1 3 0",
        "f 16 17 18",
        ""
    ].join("\n");

    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), obj);

        const info = getPartInfo(dir);

        assert.equal(info.rigType, "R6");
        assert.equal(info.groups.length, 6);
        assert.equal(info.groups.every((group) => group.type === "player"), true);
        assert.equal(info.groups.find((group) => group.name === "Head").part, "Head");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("non-rigged conversion centres on the body, not accessories", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-test-"));
    const obj = [
        "g Player1",
        "v -1 100 0",
        "v 1 100 0",
        "v 0 102 2",
        "f 1 2 3",
        "g Handle1",
        "v 10 102 100",
        "v 11 102 100",
        "v 10 103 101",
        "f 4 5 6",
        ""
    ].join("\n");

    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), obj);

        const conversion = await convertAvatar(dir);
        const prim = conversion.doc
            .getRoot()
            .listMeshes()[0]
            .listPrimitives()[0];
        const pos = prim.getAttribute("POSITION").getArray();

        // Feet on the ground.
        assert.equal(pos[1], 0);

        // Body vertices (first three) are centred on X/Z.
        const bodyZ = [pos[2], pos[5], pos[8]];
        assert.equal((Math.min(...bodyZ) + Math.max(...bodyZ)) / 2, 0);

        // The accessory stays far away and did not influence the offsets.
        assert.ok(pos[11] > 90);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function makeBox(xmin, xmax, ymin, ymax, zmin, zmax) {
    return {
        xmin, xmax, ymin, ymax, zmin, zmax,
        cx: (xmin + xmax) / 2,
        cy: (ymin + ymax) / 2,
        cz: (zmin + zmax) / 2,
        sx: xmax - xmin,
        sy: ymax - ymin,
        sz: zmax - zmin
    };
}

// Build an OBJ where each part is a small box, so convertAvatar can classify
// it without needing real mesh data.
function objFromBoxes(boxes, startIndex = 1) {
    const lines = [];
    let offset = startIndex;

    for (const [name, b] of Object.entries(boxes)) {
        lines.push(`g ${name}`);

        const corners = [
            [b.xmin, b.ymin, b.zmin], [b.xmax, b.ymin, b.zmin],
            [b.xmax, b.ymax, b.zmin], [b.xmin, b.ymax, b.zmin],
            [b.xmin, b.ymin, b.zmax], [b.xmax, b.ymin, b.zmax],
            [b.xmax, b.ymax, b.zmax], [b.xmin, b.ymax, b.zmax]
        ];
        for (const c of corners) lines.push(`v ${c[0]} ${c[1]} ${c[2]}`);

        const faces = [
            [1, 2, 3], [1, 3, 4], [5, 6, 7], [5, 7, 8],
            [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6],
            [3, 4, 8], [3, 8, 7], [4, 1, 5], [4, 5, 8]
        ];
        for (const f of faces) {
            lines.push(`f ${offset + f[0] - 1} ${offset + f[1] - 1} ${offset + f[2] - 1}`);
        }
        offset += 8;
    }

    return lines.join("\n");
}

function handleFrom(points) {
    const positions = [];
    const vertexIndices = [];
    points.forEach((p, i) => {
        positions.push(p[0], p[1], p[2]);
        vertexIndices.push(i);
    });
    return { handleGroup: { vertexIndices }, positions };
}

const R15_BOXES = {
    Head: makeBox(-0.5, 0.5, 9, 11, -0.5, 0.5),
    UpperTorso: makeBox(-1, 1, 7, 9, -0.5, 0.5),
    LowerTorso: makeBox(-1, 1, 5, 7, -0.5, 0.5),
    LeftHand: makeBox(-2, -1.5, 7, 8, -0.5, 0.5),
    RightHand: makeBox(1.5, 2, 7, 8, -0.5, 0.5),
    LeftUpperLeg: makeBox(-0.8, -0.1, 2, 5, -0.5, 0.5),
    RightUpperLeg: makeBox(0.1, 0.8, 2, 5, -0.5, 0.5)
};

test("partial R15 avatars (14 parts) still map to body parts", () => {
    const boxes = {
        Player8: makeBox(-0.58, 0.58, 3.97, 5.15, -0.58, 0.58),
        Player7: makeBox(-0.45, 0.45, 2.31, 4.09, -0.42, 0.29),
        Player6: makeBox(-0.46, 0.46, 2.16, 2.57, -0.33, 0.29),
        Player3: makeBox(0.33, 0.80, 2.85, 3.67, -0.25, 0.23),
        Player2: makeBox(0.76, 1.03, 2.15, 2.58, -0.24, 0.08),
        Player1: makeBox(0.84, 1.22, 1.69, 2.27, -0.49, -0.03),
        Player5: makeBox(-0.80, -0.33, 2.84, 3.67, -0.25, 0.23),
        Player4: makeBox(-1.22, -0.84, 1.69, 2.28, -0.49, -0.03),
        Player9: makeBox(-0.10, 0.59, 1.03, 2.37, -0.42, 0.42),
        Player10: makeBox(-0.10, 0.59, 0.21, 1.49, -0.42, 0.42),
        Player11: makeBox(-0.11, 0.60, 0.0, 0.31, -0.43, 0.43),
        Player12: makeBox(-0.59, 0.10, 1.03, 2.37, -0.42, 0.42),
        Player13: makeBox(-0.59, 0.10, 0.21, 1.49, -0.42, 0.42),
        Player14: makeBox(-0.60, 0.11, 0.0, 0.31, -0.43, 0.43)
    };

    const playerGroups = Object.keys(boxes).map((name) => ({ name }));
    const mapping = matchBodyParts(playerGroups, boxes);

    assert.equal(detectRigType(playerGroups.length), "R15");
    assert.equal(mapping.Head, "Player8");
    assert.equal(mapping.UpperTorso, "Player7");
    assert.equal(mapping.LowerTorso, "Player6");
    assert.equal(mapping.RightUpperArm, "Player3");
    assert.equal(mapping.RightLowerArm, "Player2");
    assert.equal(mapping.RightHand, "Player1");
    assert.equal(mapping.LeftUpperArm, "Player5");
    assert.equal(mapping.LeftHand, "Player4");
    assert.equal(mapping.LeftLowerArm, undefined);
    assert.equal(mapping.RightUpperLeg, "Player9");
    assert.equal(mapping.RightLowerLeg, "Player10");
    assert.equal(mapping.RightFoot, "Player11");
    assert.equal(mapping.LeftUpperLeg, "Player12");
    assert.equal(mapping.LeftLowerLeg, "Player13");
    assert.equal(mapping.LeftFoot, "Player14");
});

test("R15 leg bones start at the top center of the upper leg", () => {
    const boxes = {
        Head: makeBox(-0.53, 0.53, 4.85, 5.97, -0.55, 0.55),
        UpperTorso: makeBox(-0.91, 0.91, 3.04, 4.97, -0.51, 0.51),
        LowerTorso: makeBox(-0.99, 0.99, 2.64, 3.04, -0.51, 0.51),
        LeftUpperLeg: makeBox(-0.98, 0.00, 1.20, 2.90, -0.45, 0.46),
        LeftLowerLeg: makeBox(-0.98, 0.00, 0.22, 1.77, -0.45, 0.46),
        LeftFoot: makeBox(-1.01, 0.02, 0.00, 0.34, -0.50, 0.50),
        RightUpperLeg: makeBox(0.00, 0.98, 1.20, 2.90, -0.45, 0.46),
        RightLowerLeg: makeBox(0.00, 0.98, 0.22, 1.77, -0.45, 0.46),
        RightFoot: makeBox(-0.02, 1.01, 0.00, 0.34, -0.50, 0.50)
    };
    const mapping = {
        Head: "Head",
        UpperTorso: "UpperTorso",
        LowerTorso: "LowerTorso",
        LeftUpperLeg: "LeftUpperLeg",
        LeftLowerLeg: "LeftLowerLeg",
        LeftFoot: "LeftFoot",
        RightUpperLeg: "RightUpperLeg",
        RightLowerLeg: "RightLowerLeg",
        RightFoot: "RightFoot"
    };

    const joints = computeJoints(mapping, boxes, 0, 0, 0, "R15");

    // Top center of each upper-leg box (x centered, y at the top).
    assert.equal(joints.LeftUpperLeg[0], -0.49);
    assert.equal(joints.LeftUpperLeg[1], 2.90);
    assert.equal(joints.RightUpperLeg[0], 0.49);
    assert.equal(joints.RightUpperLeg[1], 2.90);
});

test("GLB rig orients bones along the limbs", async () => {
    const boxes = {
        Head: makeBox(-0.53, 0.53, 4.85, 5.97, -0.55, 0.55),
        UpperTorso: makeBox(-0.91, 0.91, 3.04, 4.97, -0.51, 0.51),
        LowerTorso: makeBox(-0.99, 0.99, 2.64, 3.04, -0.51, 0.51),
        LeftUpperArm: makeBox(-1.91, -0.91, 3.50, 4.91, -0.50, 0.50),
        LeftLowerArm: makeBox(-1.91, -0.91, 2.86, 4.13, -0.50, 0.50),
        LeftHand: makeBox(-1.88, -0.93, 2.56, 2.92, -0.55, 0.55),
        RightUpperArm: makeBox(0.91, 1.91, 3.50, 4.91, -0.50, 0.50),
        RightLowerArm: makeBox(0.91, 1.91, 2.86, 4.13, -0.50, 0.50),
        RightHand: makeBox(0.93, 1.88, 2.56, 2.92, -0.55, 0.55),
        LeftUpperLeg: makeBox(-0.98, 0.00, 1.20, 2.90, -0.45, 0.46),
        LeftLowerLeg: makeBox(-0.98, 0.00, 0.22, 1.77, -0.45, 0.46),
        LeftFoot: makeBox(-1.01, 0.02, 0.00, 0.34, -0.50, 0.50),
        RightUpperLeg: makeBox(0.00, 0.98, 1.20, 2.90, -0.45, 0.46),
        RightLowerLeg: makeBox(0.00, 0.98, 0.22, 1.77, -0.45, 0.46),
        RightFoot: makeBox(-0.02, 1.01, 0.00, 0.34, -0.50, 0.50)
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-test-"));
    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), objFromBoxes(boxes));

        const conversion = await convertAvatar(dir, { rig: true, splitParts: true });
        const root = conversion.doc.getRoot();
        const find = (name) => root.listNodes().find((n) => n.getName() === name);

        const upper = find("LeftUpperArm");
        const lower = find("LeftLowerArm");

        assert.ok(upper && lower);
        assert.equal(conversion.rigType, "R15");

        // The upper-arm node must have a non-identity rotation.
        const q = upper.getRotation();
        assert.ok(
            Math.abs(q[0]) + Math.abs(q[1]) + Math.abs(q[2]) + Math.abs(q[3] - 1) > 0.1,
            "upper arm should be rotated toward its child"
        );

        // Its local +Y (the bone direction) should point at the lower arm.
        const m = upper.getWorldMatrix();
        const dirY = [m[4], m[5], m[6]];
        const up = upper.getWorldTranslation();
        const lo = lower.getWorldTranslation();
        const expected = [lo[0] - up[0], lo[1] - up[1], lo[2] - up[2]];
        const dot =
            (dirY[0] * expected[0] + dirY[1] * expected[1] + dirY[2] * expected[2]) /
            (Math.hypot(...dirY) * Math.hypot(...expected));

        assert.ok(dot > 0.99, `bone +Y should align with its child (dot=${dot})`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("GLB accessories are bone-parented to their body part's bone", async () => {
    // Full R15 body + a hat-like handle box sitting on top of the head.
    const body = {
        Head: makeBox(-0.53, 0.53, 4.85, 5.5, -0.55, 0.55),
        UpperTorso: makeBox(-0.91, 0.91, 3.04, 4.97, -0.51, 0.51),
        LowerTorso: makeBox(-0.99, 0.99, 2.64, 3.04, -0.51, 0.51),
        LeftUpperArm: makeBox(-1.91, -0.91, 3.50, 4.91, -0.50, 0.50),
        LeftLowerArm: makeBox(-1.91, -0.91, 2.86, 4.13, -0.50, 0.50),
        LeftHand: makeBox(-1.88, -0.93, 2.56, 2.92, -0.55, 0.55),
        RightUpperArm: makeBox(0.91, 1.91, 3.50, 4.91, -0.50, 0.50),
        RightLowerArm: makeBox(0.91, 1.91, 2.86, 4.13, -0.50, 0.50),
        RightHand: makeBox(0.93, 1.88, 2.56, 2.92, -0.55, 0.55),
        LeftUpperLeg: makeBox(-0.98, 0.00, 1.20, 2.90, -0.45, 0.46),
        LeftLowerLeg: makeBox(-0.98, 0.00, 0.22, 1.77, -0.45, 0.46),
        LeftFoot: makeBox(-1.01, 0.02, 0.00, 0.34, -0.50, 0.50),
        RightUpperLeg: makeBox(0.00, 0.98, 1.20, 2.90, -0.45, 0.46),
        RightLowerLeg: makeBox(0.00, 0.98, 0.22, 1.77, -0.45, 0.46),
        RightFoot: makeBox(-0.02, 1.01, 0.00, 0.34, -0.50, 0.50)
    };
    const hat = makeBox(-0.4, 0.4, 5.5, 5.9, -0.4, 0.4);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-test-"));

    try {
        // objFromBoxes restarts face indices per call, so offset the handle's
        // vertices past the body's (15 boxes × 8 verts) to keep them distinct.
        const bodyVertCount = Object.keys(body).length * 8;
        const obj = [
            objFromBoxes(body),
            objFromBoxes({ Handle1: hat }, bodyVertCount + 1)
        ].join("\n");
        fs.writeFileSync(path.join(dir, "avatar.obj"), obj);

        const conversion = await convertAvatar(dir, { rig: true, splitParts: true });
        const root = conversion.doc.getRoot();
        const find = (name) => root.listNodes().find((n) => n.getName() === name);

        const handle = find("Handle1");
        const headMesh = root.listNodes().find(
            (n) => n.getName() === "Head" && n.getMesh()
        );
        const headBone = root.listNodes().find(
            (n) => n.getName() === "Head" && !n.getMesh()
        );

        assert.ok(handle, "handle node exists");
        assert.ok(handle.getParentNode(), "handle has a parent");

        // Bone-parent: the handle's parent is the Head BONE, not the mesh node.
        assert.equal(handle.getParentNode(), headBone);
        assert.ok(headBone && !headBone.getMesh(), "parent is a bone node");
        assert.notEqual(handle.getParentNode(), headMesh);

        // The handle keeps its original world position (centered geometry on
        // top of the head): the node's rest rotation is cancelled.
        const world = handle.getWorldTranslation();
        assert.ok(Math.abs(world[0] - 0) < 0.01, `x=${world[0]}`);
        assert.ok(Math.abs(world[1] - 5.7) < 0.01, `y=${world[1]}`);
        assert.ok(Math.abs(world[2] - 0) < 0.01, `z=${world[2]}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("R15 layered clothing is skinned to the skeleton, not bone-parented", async () => {
    const body = {
        Head: makeBox(-0.53, 0.53, 4.85, 5.5, -0.55, 0.55),
        UpperTorso: makeBox(-0.91, 0.91, 3.04, 4.97, -0.51, 0.51),
        LowerTorso: makeBox(-0.99, 0.99, 2.64, 3.04, -0.51, 0.51),
        LeftUpperArm: makeBox(-1.91, -0.91, 3.50, 4.91, -0.50, 0.50),
        LeftLowerArm: makeBox(-1.91, -0.91, 2.86, 4.13, -0.50, 0.50),
        LeftHand: makeBox(-1.88, -0.93, 2.56, 2.92, -0.55, 0.55),
        RightUpperArm: makeBox(0.91, 1.91, 3.50, 4.91, -0.50, 0.50),
        RightLowerArm: makeBox(0.91, 1.91, 2.86, 4.13, -0.50, 0.50),
        RightHand: makeBox(0.93, 1.88, 2.56, 2.92, -0.55, 0.55),
        LeftUpperLeg: makeBox(-0.98, 0.00, 1.20, 2.90, -0.45, 0.46),
        LeftLowerLeg: makeBox(-0.98, 0.00, 0.22, 1.77, -0.45, 0.46),
        LeftFoot: makeBox(-1.01, 0.02, 0.00, 0.34, -0.50, 0.50),
        RightUpperLeg: makeBox(0.00, 0.98, 1.20, 2.90, -0.45, 0.46),
        RightLowerLeg: makeBox(0.00, 0.98, 0.22, 1.77, -0.45, 0.46),
        RightFoot: makeBox(-0.02, 1.01, 0.00, 0.34, -0.50, 0.50)
    };
    // A jacket-like handle spanning the torso and both arms (3 body regions).
    const jacket = makeBox(-1.5, 1.5, 3.0, 5.0, -0.6, 0.6);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-test-"));

    try {
        const bodyVertCount = Object.keys(body).length * 8;
        const obj = [
            objFromBoxes(body),
            objFromBoxes({ Handle1: jacket }, bodyVertCount + 1)
        ].join("\n");
        fs.writeFileSync(path.join(dir, "avatar.obj"), obj);

        const conversion = await convertAvatar(dir, {
            rig: true,
            splitParts: true,
            bendAccessories: true
        });
        const root = conversion.doc.getRoot();
        const handle = root.listNodes().find((n) => n.getName() === "Handle1");

        assert.ok(handle, "handle node exists");

        // Skinned clothing: bound to the skeleton with JOINTS_0/WEIGHTS_0 and
        // NOT rigidly parented to a single bone.
        assert.ok(handle.getSkin(), "clothing handle is skinned");
        const prim = handle.getMesh().listPrimitives()[0];
        assert.ok(prim.getAttribute("JOINTS_0"), "has JOINTS_0");
        assert.ok(prim.getAttribute("WEIGHTS_0"), "has WEIGHTS_0");

        const parent = handle.getParentNode();
        assert.ok(parent, "has a parent");
        assert.equal(parent.getMesh(), null, "parent is a container, not a bone");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("R15 clothing stays rigid when bendAccessories is off", async () => {
    const body = {
        Head: makeBox(-0.53, 0.53, 4.85, 5.5, -0.55, 0.55),
        UpperTorso: makeBox(-0.91, 0.91, 3.04, 4.97, -0.51, 0.51),
        LowerTorso: makeBox(-0.99, 0.99, 2.64, 3.04, -0.51, 0.51),
        LeftUpperArm: makeBox(-1.91, -0.91, 3.50, 4.91, -0.50, 0.50),
        LeftLowerArm: makeBox(-1.91, -0.91, 2.86, 4.13, -0.50, 0.50),
        LeftHand: makeBox(-1.88, -0.93, 2.56, 2.92, -0.55, 0.55),
        RightUpperArm: makeBox(0.91, 1.91, 3.50, 4.91, -0.50, 0.50),
        RightLowerArm: makeBox(0.91, 1.91, 2.86, 4.13, -0.50, 0.50),
        RightHand: makeBox(0.93, 1.88, 2.56, 2.92, -0.55, 0.55),
        LeftUpperLeg: makeBox(-0.98, 0.00, 1.20, 2.90, -0.45, 0.46),
        LeftLowerLeg: makeBox(-0.98, 0.00, 0.22, 1.77, -0.45, 0.46),
        LeftFoot: makeBox(-1.01, 0.02, 0.00, 0.34, -0.50, 0.50),
        RightUpperLeg: makeBox(0.00, 0.98, 1.20, 2.90, -0.45, 0.46),
        RightLowerLeg: makeBox(0.00, 0.98, 0.22, 1.77, -0.45, 0.46),
        RightFoot: makeBox(-0.02, 1.01, 0.00, 0.34, -0.50, 0.50)
    };
    const jacket = makeBox(-1.5, 1.5, 3.0, 5.0, -0.6, 0.6);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-test-"));

    try {
        const bodyVertCount = Object.keys(body).length * 8;
        const obj = [
            objFromBoxes(body),
            objFromBoxes({ Handle1: jacket }, bodyVertCount + 1)
        ].join("\n");
        fs.writeFileSync(path.join(dir, "avatar.obj"), obj);

        const conversion = await convertAvatar(dir, {
            rig: true,
            splitParts: true,
            bendAccessories: false
        });
        const root = conversion.doc.getRoot();
        const handle = root.listNodes().find((n) => n.getName() === "Handle1");

        assert.ok(handle, "handle node exists");
        // Rigid: no skin, parented to a bone (no JOINTS_0/WEIGHTS_0).
        assert.equal(handle.getSkin(), null, "clothing handle is not skinned");
        const parent = handle.getParentNode();
        assert.ok(parent && !parent.getMesh(), "parent is a bone node");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("tail-like accessory attaches to the hips (R15)", () => {
    const { handleGroup, positions } = handleFrom([
        [0, 4.2, 1.6], [0.2, 4.1, 1.7], [-0.2, 4.3, 1.5]
    ]);

    assert.equal(assignHandleBone(handleGroup, R15_BOXES, positions), "LowerTorso");
});

test("hand accessory stays on the hand", () => {
    const { handleGroup, positions } = handleFrom([
        [1.8, 7.5, 0], [1.9, 7.6, 0.1], [1.7, 7.4, -0.1]
    ]);

    assert.equal(assignHandleBone(handleGroup, R15_BOXES, positions), "RightHand");
});

test("head accessory attaches to the head", () => {
    const { handleGroup, positions } = handleFrom([
        [0, 10, 0], [0.2, 10.1, 0.1], [-0.2, 9.9, -0.1]
    ]);

    assert.equal(assignHandleBone(handleGroup, R15_BOXES, positions), "Head");
});

test("tail-like accessory attaches to the Torso (R6)", () => {
    const r6 = {
        Head: makeBox(-0.5, 0.5, 9, 11, -0.5, 0.5),
        Torso: makeBox(-1, 1, 5, 7, -0.5, 0.5),
        "Left Leg": makeBox(-0.8, -0.1, 2, 5, -0.5, 0.5),
        "Right Leg": makeBox(0.1, 0.8, 2, 5, -0.5, 0.5)
    };
    const { handleGroup, positions } = handleFrom([
        [0, 4.2, 1.6], [0.2, 4.1, 1.7], [-0.2, 4.3, 1.5]
    ]);

    assert.equal(assignHandleBone(handleGroup, r6, positions), "Torso");
});

test("R6 rig adds hand bones at the arm bottom and foot bones at the leg bottom", () => {
    const mapping = {
        Head: "Player6",
        Torso: "Player5",
        "Left Arm": "Player4",
        "Right Arm": "Player3",
        "Left Leg": "Player2",
        "Right Leg": "Player1"
    };
    const boxes = {
        Player6: makeBox(-0.5, 0.5, 10, 11, -0.5, 0.5),
        Player5: makeBox(-1, 1, 6, 9, -0.5, 0.5),
        Player4: makeBox(-1.8, -1.1, 7, 9.5, -0.3, 0.3),
        Player3: makeBox(1.1, 1.8, 7, 9.5, -0.3, 0.3),
        Player2: makeBox(-0.9, -0.1, 2, 6, -0.3, 0.3),
        Player1: makeBox(0.1, 0.9, 2, 6, -0.3, 0.3)
    };

    const joints = computeJoints(mapping, boxes, 0, 0, 0, "R6");
    assert.ok(joints["Left Hand"]);
    assert.ok(joints["Right Hand"]);
    assert.equal(joints["Left LowerArm"], undefined);
    assert.ok(joints["Left Foot"]);
    assert.ok(joints["Right Foot"]);
    assert.equal(joints["Left LowerLeg"], undefined);
    // Feet sit at the bottom of the legs (OBJ Y is up).
    assert.equal(joints["Left Foot"][1], 2);
    assert.equal(joints["Right Foot"][1], 2);

    const { parentOf } = buildParentMap("R6", joints);
    assert.equal(parentOf["Left Foot"], "Left Leg");
    assert.equal(parentOf["Right Foot"], "Right Leg");
});

test("R6 more-joints adds lower arm/leg and foot joints", () => {
    const mapping = {
        Head: "Player6",
        Torso: "Player5",
        "Left Arm": "Player4",
        "Right Arm": "Player3",
        "Left Leg": "Player2",
        "Right Leg": "Player1"
    };
    const boxes = {
        Player6: makeBox(-0.5, 0.5, 10, 11, -0.5, 0.5),
        Player5: makeBox(-1, 1, 6, 9, -0.5, 0.5),
        Player4: makeBox(-1.8, -1.1, 7, 9.5, -0.3, 0.3),
        Player3: makeBox(1.1, 1.8, 7, 9.5, -0.3, 0.3),
        Player2: makeBox(-0.9, -0.1, 2, 6, -0.3, 0.3),
        Player1: makeBox(0.1, 0.9, 2, 6, -0.3, 0.3)
    };

    const joints = computeJoints(mapping, boxes, 0, 0, 0, "R6", true);
    assert.ok(joints["Left LowerArm"]);
    assert.ok(joints["Right LowerArm"]);
    assert.ok(joints["Left LowerLeg"]);
    assert.ok(joints["Left Foot"]);
    assert.ok(joints["Right Foot"]);
    assert.ok(joints["Waist"]);
});

test("subdivision quadruples faces and keeps groups and UVs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-test-"));
    const obj = [
        "g Torso",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "vt 0 0",
        "vt 1 0",
        "vt 0 1",
        "vn 0 0 1",
        "f 1/1/1 2/2/1 3/3/1",
        ""
    ].join("\n");

    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), obj);
        const parsed = parseObj(path.join(dir, "avatar.obj"));

        assert.equal(parsed.faces.length, 1);
        assert.equal(parsed.groups[0].name, "Torso");

        const refined = subdivideParsed(parsed, 1);

        assert.equal(refined.faces.length, 4);
        assert.equal(refined.groups[0].name, "Torso");
        assert.ok(refined.uvs.length >= 8);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("parseMtl reads opacity from d and Tr", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-test-"));
    const mtlPath = path.join(dir, "avatar.mtl");

    try {
        fs.writeFileSync(mtlPath, [
            "newmtl opaque",
            "Kd 1 1 1",
            "d 0.25",
            "newmtl inverted",
            "Kd 1 1 1",
            "Tr 0.4",
            ""
        ].join("\n"));

        const materials = parseMtl(mtlPath);
        assert.equal(materials.opaque.opacity, 0.25);
        assert.equal(materials.inverted.opacity, 0.6);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("parseObj supports object groups, ungrouped faces, and negative indices", () => {
    const ungrouped = parseObjString([
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f -3 -2 -1",
        ""
    ].join("\n"));

    assert.equal(ungrouped.faces.length, 1);
    assert.deepEqual(ungrouped.faces[0].verts, [0, 1, 2]);
    assert.equal(ungrouped.groups[0].name, "Avatar");

    const objectGroup = parseObjString([
        "o Body",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f 1 2 3",
        ""
    ].join("\n"));

    assert.equal(objectGroup.groups[0].name, "Body");
});

test("parseObj rejects invalid face indices", () => {
    assert.throws(
        () => parseObjString("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4\n"),
        /invalid vertex index/
    );
    assert.throws(
        () => parseObjString("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/9 2/9 3/9\n"),
        /invalid UV index/
    );
});

test("convertAvatar rejects an OBJ without faces", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-test-"));

    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), "# no faces\n");
        await assert.rejects(
            () => convertAvatar(dir),
            /contains no faces/
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("GLTF materials honour opacity and are double-sided", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-test-"));
    const obj = [
        "g Torso",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "usemtl cloth",
        "f 1 2 3",
        ""
    ].join("\n");
    const mtl = "newmtl cloth\nKd 0.2 0.3 0.4\nd 0.5\n";

    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), obj);
        fs.writeFileSync(path.join(dir, "avatar.mtl"), mtl);

        const conversion = await convertAvatar(dir, { splitParts: true });
        const material = conversion.doc.getRoot().listMaterials()[0];

        assert.equal(material.getDoubleSided(), true);
        assert.equal(material.getAlphaMode(), "BLEND");
        assert.equal(material.getBaseColorFactor()[3], 0.5);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("subdivision shares midpoints across adjacent faces", () => {
    const parsed = parseObjString([
        "g Torso",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "v 1 1 0",
        "f 1 2 3",
        "f 2 4 3",
        ""
    ].join("\n"));

    assert.equal(parsed.faces.length, 2);

    const refined = subdivideParsed(parsed, 1);

    assert.equal(refined.faces.length, 8);
    // 4 original vertices + 5 unique edge midpoints (one edge is shared).
    assert.equal(refined.positions.length / 3, 9);
});

test("mixed named and Player groups keep named parts and map safe leftovers", () => {
    const boxes = {
        Head: makeBox(-0.5, 0.5, 9, 11, -0.5, 0.5),
        UpperTorso: makeBox(-1, 1, 7, 9, -0.5, 0.5),
        LowerTorso: makeBox(-1, 1, 5, 7, -0.5, 0.5),
        LeftUpperArm: makeBox(-2, -1.2, 7, 9, -0.3, 0.3),
        RightUpperArm: makeBox(1.2, 2, 7, 9, -0.3, 0.3),
        LeftLowerArm: makeBox(-2, -1.5, 5, 7, -0.3, 0.3),
        RightLowerArm: makeBox(1.5, 2, 5, 7, -0.3, 0.3),
        LeftUpperLeg: makeBox(-0.8, -0.1, 2, 5, -0.3, 0.3),
        RightUpperLeg: makeBox(0.1, 0.8, 2, 5, -0.3, 0.3),
        LeftLowerLeg: makeBox(-0.8, -0.1, 0.5, 2, -0.3, 0.3),
        RightLowerLeg: makeBox(0.1, 0.8, 0.5, 2, -0.3, 0.3),
        LeftFoot: makeBox(-0.8, -0.1, 0, 0.5, -0.3, 0.3),
        RightFoot: makeBox(0.1, 0.8, 0, 0.5, -0.3, 0.3),
        Player12: makeBox(0.1, 0.8, 0, 0.3, -0.3, 0.3),
        Player15: makeBox(-0.8, -0.1, 0, 0.3, -0.3, 0.3),
        Player20: makeBox(1.5, 1.8, 4.5, 5, -0.3, 0.3)
    };
    const groups = Object.keys(boxes).map((name) => ({ name }));

    const { partMapping, extraGroupParts } = resolvePartMapping(groups, boxes, "R15");

    assert.equal(partMapping.Head, "Head");
    assert.equal(partMapping.UpperTorso, "UpperTorso");
    assert.equal(partMapping.RightFoot, "RightFoot");
    assert.equal(partMapping.RightHand, "Player20");
    assert.equal(partMapping.LeftHand, undefined);
    assert.equal(extraGroupParts.Player12, "RightFoot");
    assert.equal(extraGroupParts.Player15, "LeftFoot");
});

test("getPartInfo keeps handles typed as handles after attachment mapping", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-test-"));
    const boxes = {
        Head: makeBox(-0.5, 0.5, 9, 11, -0.5, 0.5),
        UpperTorso: makeBox(-1, 1, 7, 9, -0.5, 0.5),
        LowerTorso: makeBox(-1, 1, 5, 7, -0.5, 0.5),
        LeftUpperArm: makeBox(-2, -1.2, 7, 9, -0.3, 0.3),
        RightUpperArm: makeBox(1.2, 2, 7, 9, -0.3, 0.3),
        LeftLowerArm: makeBox(-2, -1.5, 5, 7, -0.3, 0.3),
        RightLowerArm: makeBox(1.5, 2, 5, 7, -0.3, 0.3),
        LeftUpperLeg: makeBox(-0.8, -0.1, 2, 5, -0.3, 0.3),
        RightUpperLeg: makeBox(0.1, 0.8, 2, 5, -0.3, 0.3),
        LeftLowerLeg: makeBox(-0.8, -0.1, 0.5, 2, -0.3, 0.3),
        RightLowerLeg: makeBox(0.1, 0.8, 0.5, 2, -0.3, 0.3),
        LeftFoot: makeBox(-0.8, -0.1, 0, 0.5, -0.3, 0.3),
        RightFoot: makeBox(0.1, 0.8, 0, 0.5, -0.3, 0.3),
        Handle1: makeBox(-0.2, 0.2, 10.5, 11.2, -0.2, 0.2)
    };

    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), objFromBoxes(boxes));
        const info = getPartInfo(dir);
        const handle = info.groups.find((group) => group.name === "Handle1");

        assert.ok(handle);
        assert.equal(handle.type, "handle");
        assert.equal(handle.part, "Head");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("splitHandleGroups separates disconnected accessories by body part", () => {
    const left = makeBox(-2.2, -1.1, 7, 9, -0.3, 0.3);
    const right = makeBox(1.1, 2.2, 7, 9, -0.3, 0.3);
    const obj = [
        objFromBoxes({ Handle1: left }),
        objFromBoxes({ Handle1: right }, 9)
    ].join("\n");

    const parsed = parseObjString(obj);
    assert.equal(parsed.groups.length, 1);
    assert.equal(parsed.groups[0].name, "Handle1");

    const playerBoxes = {
        LeftUpperArm: makeBox(-2, -1.2, 7, 9, -0.3, 0.3),
        RightUpperArm: makeBox(1.2, 2, 7, 9, -0.3, 0.3)
    };

    assert.equal(splitHandleGroups(parsed, playerBoxes), true);
    assert.equal(parsed.groups.length, 2);

    const parts = parsed.groups.map((group) => group.splitPart).sort();
    assert.deepEqual(parts, ["LeftUpperArm", "RightUpperArm"]);
    assert.ok(parsed.groups.every((group) => group.baseName === "Handle1"));
});
