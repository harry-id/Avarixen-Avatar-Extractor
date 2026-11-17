"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
    parseObj,
    parseMtl,
    detectRigType,
    detectNamedRigType,
    computeBox,
    computeRecenter,
    matchBodyParts,
    getPartInfo,
    convertAvatar,
    assignHandleBone,
    computeJoints,
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

test("detectRigType only accepts 6 or 15 player groups", () => {
    assert.equal(detectRigType(6), "R6");
    assert.equal(detectRigType(15), "R15");
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

    assert.equal(detectNamedRigType(r6.map((name) => ({ name }))), "R6");
    assert.equal(detectNamedRigType(partial.map((name) => ({ name }))), null);
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

test("R6 rig adds hand bones at the bottom of each arm", () => {
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
    assert.equal(joints["Left Foot"], undefined);
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
