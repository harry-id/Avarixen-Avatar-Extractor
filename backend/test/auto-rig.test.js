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
    getPartInfo
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
