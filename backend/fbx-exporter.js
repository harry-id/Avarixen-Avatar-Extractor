"use strict";

// Minimal, dependency-free ASCII FBX 7.4 exporter.
// Converts the OBJ + MTL (+ textures) produced by the avatar downloader into
// an FBX scene that Blender, Maya and 3ds Max can import.

const fs = require("fs/promises");
const path = require("path");

const GEOMETRY_ID = 1000000;
const MODEL_ID = 2000000;
const MATERIAL_ID_BASE = 3000000;
const VIDEO_ID_BASE = 4000000;
const TEXTURE_ID_BASE = 5000000;

const INDENT = "\t";

function fmt(value) {
    if (!Number.isFinite(value)) {
        return "0";
    }

    const rounded = Math.round(value * 1e6) / 1e6;
    return String(rounded);
}

function quote(value) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseNumbers(parts, count, fallback) {
    const values = [];

    for (let i = 1; i <= count; i++) {
        const value = Number(parts[i]);
        values.push(Number.isFinite(value) ? value : fallback[i - 1]);
    }

    return values;
}

function resolveIndex(value, count) {
    const index = parseInt(value, 10);

    if (!Number.isFinite(index) || index === 0) {
        return null;
    }

    return index < 0 ? count + index : index - 1;
}

function parseObj(text) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const polygons = [];
    let currentMaterial = null;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (!line || line.startsWith("#")) {
            continue;
        }

        const parts = line.split(/\s+/);
        const tag = parts[0];

        if (tag === "v") {
            positions.push(parseNumbers(parts, 3, [0, 0, 0]));
        } else if (tag === "vn") {
            normals.push(parseNumbers(parts, 3, [0, 0, 0]));
        } else if (tag === "vt") {
            uvs.push(parseNumbers(parts, 2, [0, 0]));
        } else if (tag === "usemtl") {
            currentMaterial = parts.slice(1).join(" ") || null;
        } else if (tag === "f") {
            const corners = [];

            for (let i = 1; i < parts.length; i++) {
                const [p, t, n] = parts[i].split("/");

                corners.push({
                    p: resolveIndex(p, positions.length),
                    t: t ? resolveIndex(t, uvs.length) : null,
                    n: n ? resolveIndex(n, normals.length) : null
                });
            }

            if (corners.length >= 3 && corners.every((corner) => corner.p !== null)) {
                polygons.push({ corners, material: currentMaterial });
            }
        }
    }

    return { positions, normals, uvs, polygons };
}

function parseMtl(text) {
    const materials = new Map();
    let current = null;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (!line || line.startsWith("#")) {
            continue;
        }

        const parts = line.split(/\s+/);
        const tag = parts[0];

        if (tag === "newmtl") {
            current = {
                name: parts.slice(1).join(" ") || "material",
                ambient: [0, 0, 0],
                diffuse: [0.8, 0.8, 0.8],
                specular: [0, 0, 0],
                emissive: [0, 0, 0],
                shininess: 20,
                opacity: 1,
                diffuseMap: null
            };
            materials.set(current.name, current);
        } else if (current && tag === "Ka") {
            current.ambient = parseNumbers(parts, 3, current.ambient);
        } else if (current && tag === "Kd") {
            current.diffuse = parseNumbers(parts, 3, current.diffuse);
        } else if (current && tag === "Ks") {
            current.specular = parseNumbers(parts, 3, current.specular);
        } else if (current && tag === "Ke") {
            current.emissive = parseNumbers(parts, 3, current.emissive);
        } else if (current && tag === "Ns") {
            const value = Number(parts[1]);
            if (Number.isFinite(value)) {
                current.shininess = value;
            }
        } else if (current && tag === "d") {
            const value = Number(parts[1]);
            if (Number.isFinite(value)) {
                current.opacity = Math.min(1, Math.max(0, value));
            }
        } else if (current && tag === "Tr") {
            const value = Number(parts[1]);
            if (Number.isFinite(value)) {
                current.opacity = Math.min(1, Math.max(0, 1 - value));
            }
        } else if (current && (tag === "map_Kd" || tag === "map_kd")) {
            current.diffuseMap = parts.slice(1).join(" ") || null;
        }
    }

    return materials;
}

function faceNormal(polygon, positions) {
    let nx = 0;
    let ny = 0;
    let nz = 0;

    const corners = polygon.corners;

    for (let i = 0; i < corners.length; i++) {
        const current = positions[corners[i].p];
        const next = positions[corners[(i + 1) % corners.length].p];

        if (!current || !next) {
            continue;
        }

        nx += (current[1] - next[1]) * (current[2] + next[2]);
        ny += (current[2] - next[2]) * (current[0] + next[0]);
        nz += (current[0] - next[0]) * (current[1] + next[1]);
    }

    const length = Math.hypot(nx, ny, nz);

    if (length === 0) {
        return [0, 1, 0];
    }

    return [nx / length, ny / length, nz / length];
}

async function readTexture(assetDir, filename) {
    if (!filename) {
        return null;
    }

    const resolved = path.resolve(assetDir, filename);
    const root = path.resolve(assetDir);

    // Never read outside the downloaded avatar folder.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return null;
    }

    try {
        const data = await fs.readFile(resolved);

        return {
            filename: path.basename(resolved),
            base64: data.toString("base64")
        };
    } catch {
        return null;
    }
}

function arrayBlock(name, values) {
    return [
        `${INDENT}${INDENT}${name}: *${values.length} {`,
        `${INDENT}${INDENT}${INDENT}a: ${values.join(",")}`,
        `${INDENT}${INDENT}}`
    ];
}

async function buildFbx({ objText, mtlText, assetDir }) {
    const obj = parseObj(objText);
    const mtl = mtlText ? parseMtl(mtlText) : new Map();

    if (obj.polygons.length === 0) {
        throw new Error("FBX conversion failed: the OBJ has no faces.");
    }

    const materialNames = [];
    const materialIndex = new Map();

    for (const polygon of obj.polygons) {
        const name = polygon.material || "default";

        if (!materialIndex.has(name)) {
            materialIndex.set(name, materialNames.length);
            materialNames.push(name);
        }
    }

    const hasUv = obj.polygons.every((polygon) =>
        polygon.corners.every((corner) => corner.t !== null && obj.uvs[corner.t])
    );

    const vertices = [];
    const polygonVertexIndex = [];
    const polygonNormals = [];
    const polygonUvs = [];
    const polygonMaterials = [];

    for (const polygon of obj.polygons) {
        const normal = faceNormal(polygon, obj.positions);

        polygonMaterials.push(materialIndex.get(polygon.material || "default"));

        polygon.corners.forEach((corner, index) => {
            const position = obj.positions[corner.p];

            vertices.push(position[0], position[1], position[2]);

            const isLast = index === polygon.corners.length - 1;
            polygonVertexIndex.push(isLast ? -(corner.p + 1) : corner.p);

            const cornerNormal =
                corner.n !== null && obj.normals[corner.n]
                    ? obj.normals[corner.n]
                    : normal;

            polygonNormals.push(cornerNormal[0], cornerNormal[1], cornerNormal[2]);

            if (hasUv) {
                polygonUvs.push(obj.uvs[corner.t][0], obj.uvs[corner.t][1]);
            }
        });
    }

    // Textures referenced by the MTL, embedded as base64 so the .fbx is portable.
    const textureMap = new Map();

    for (const name of materialNames) {
        const material = mtl.get(name);

        if (!material?.diffuseMap) {
            continue;
        }

        const texture = await readTexture(assetDir, material.diffuseMap);

        if (texture) {
            textureMap.set(name, texture);
        }
    }

    const lines = [];
    const push = (...values) => lines.push(...values);

    push(
        "; FBX 7.4.0 project file",
        "; Generated by Avarixen Avatar Extractor",
        "FBXHeaderExtension:  {",
        `${INDENT}FBXHeaderVersion: 1003`,
        `${INDENT}FBXVersion: 7400`,
        `${INDENT}Creator: ${quote("Avarixen Avatar Extractor")}`,
        "}",
        "GlobalSettings:  {",
        `${INDENT}Version: 1000`,
        `${INDENT}Properties70:  {`,
        `${INDENT}${INDENT}P: "UpAxis", "int", "Integer", "",1`,
        `${INDENT}${INDENT}P: "UpAxisSign", "int", "Integer", "",1`,
        `${INDENT}${INDENT}P: "FrontAxis", "int", "Integer", "",2`,
        `${INDENT}${INDENT}P: "FrontAxisSign", "int", "Integer", "",1`,
        `${INDENT}${INDENT}P: "CoordAxis", "int", "Integer", "",0`,
        `${INDENT}${INDENT}P: "CoordAxisSign", "int", "Integer", "",1`,
        `${INDENT}${INDENT}P: "UnitScaleFactor", "double", "Number", "",1`,
        `${INDENT}}`,
        "}",
        "Definitions:  {",
        `${INDENT}Version: 100`,
        `${INDENT}Count: ${3 + (textureMap.size ? 2 : 0)}`,
        `${INDENT}ObjectType: "Geometry" {`,
        `${INDENT}${INDENT}Count: 1`,
        `${INDENT}}`,
        `${INDENT}ObjectType: "Model" {`,
        `${INDENT}${INDENT}Count: 1`,
        `${INDENT}}`,
        `${INDENT}ObjectType: "Material" {`,
        `${INDENT}${INDENT}Count: ${materialNames.length}`,
        `${INDENT}}`
    );

    if (textureMap.size) {
        push(
            `${INDENT}ObjectType: "Texture" {`,
            `${INDENT}${INDENT}Count: ${textureMap.size}`,
            `${INDENT}}`,
            `${INDENT}ObjectType: "Video" {`,
            `${INDENT}${INDENT}Count: ${textureMap.size}`,
            `${INDENT}}`
        );
    }

    push("}", "Objects:  {");

    // Geometry
    push(
        `${INDENT}Geometry: ${GEOMETRY_ID}, "Geometry::Avatar", "Mesh" {`,
        ...arrayBlock("Vertices", vertices.map(fmt)),
        ...arrayBlock("PolygonVertexIndex", polygonVertexIndex),
        `${INDENT}${INDENT}GeometryVersion: 124`,
        `${INDENT}${INDENT}LayerElementNormal: 0 {`,
        `${INDENT}${INDENT}${INDENT}Version: 101`,
        `${INDENT}${INDENT}${INDENT}Name: ""`,
        `${INDENT}${INDENT}${INDENT}MappingInformationType: "ByPolygonVertex"`,
        `${INDENT}${INDENT}${INDENT}ReferenceInformationType: "Direct"`,
        ...arrayBlock("Normals", polygonNormals.map(fmt)),
        `${INDENT}${INDENT}}`
    );

    if (hasUv) {
        push(
            `${INDENT}${INDENT}LayerElementUV: 0 {`,
            `${INDENT}${INDENT}${INDENT}Version: 101`,
            `${INDENT}${INDENT}${INDENT}Name: "UVMap"`,
            `${INDENT}${INDENT}${INDENT}MappingInformationType: "ByPolygonVertex"`,
            `${INDENT}${INDENT}${INDENT}ReferenceInformationType: "Direct"`,
            ...arrayBlock("UV", polygonUvs.map(fmt)),
            `${INDENT}${INDENT}}`
        );
    }

    push(
        `${INDENT}${INDENT}LayerElementMaterial: 0 {`,
        `${INDENT}${INDENT}${INDENT}Version: 101`,
        `${INDENT}${INDENT}${INDENT}Name: ""`,
        `${INDENT}${INDENT}${INDENT}MappingInformationType: "ByPolygon"`,
        `${INDENT}${INDENT}${INDENT}ReferenceInformationType: "IndexToDirect"`,
        ...arrayBlock("Materials", polygonMaterials),
        `${INDENT}${INDENT}}`,
        `${INDENT}${INDENT}Layer: 0 {`,
        `${INDENT}${INDENT}${INDENT}Version: 100`,
        `${INDENT}${INDENT}${INDENT}LayerElement:  {`,
        `${INDENT}${INDENT}${INDENT}${INDENT}Type: "LayerElementNormal"`,
        `${INDENT}${INDENT}${INDENT}${INDENT}TypedIndex: 0`,
        `${INDENT}${INDENT}${INDENT}}`,
        `${INDENT}${INDENT}${INDENT}LayerElement:  {`,
        `${INDENT}${INDENT}${INDENT}${INDENT}Type: "LayerElementMaterial"`,
        `${INDENT}${INDENT}${INDENT}${INDENT}TypedIndex: 0`,
        `${INDENT}${INDENT}${INDENT}}`
    );

    if (hasUv) {
        push(
            `${INDENT}${INDENT}${INDENT}LayerElement:  {`,
            `${INDENT}${INDENT}${INDENT}${INDENT}Type: "LayerElementUV"`,
            `${INDENT}${INDENT}${INDENT}${INDENT}TypedIndex: 0`,
            `${INDENT}${INDENT}${INDENT}}`
        );
    }

    push(`${INDENT}${INDENT}}`, `${INDENT}}`);

    // Model
    push(
        `${INDENT}Model: ${MODEL_ID}, "Model::Avatar", "Mesh" {`,
        `${INDENT}${INDENT}Version: 232`,
        `${INDENT}${INDENT}Properties70:  {`,
        `${INDENT}${INDENT}${INDENT}P: "Lcl Translation", "Lcl Translation", "", "A",0,0,0`,
        `${INDENT}${INDENT}${INDENT}P: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0`,
        `${INDENT}${INDENT}${INDENT}P: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1`,
        `${INDENT}${INDENT}}`,
        `${INDENT}${INDENT}Shading: T`,
        `${INDENT}${INDENT}Culling: "CullingOff"`,
        `${INDENT}}`
    );

    // Materials
    materialNames.forEach((name, index) => {
        const material = mtl.get(name) || {
            ambient: [0, 0, 0],
            diffuse: [0.8, 0.8, 0.8],
            specular: [0, 0, 0],
            emissive: [0, 0, 0],
            shininess: 20,
            opacity: 1
        };

        push(
            `${INDENT}Material: ${MATERIAL_ID_BASE + index}, ${quote(`Material::${name}`)}, "" {`,
            `${INDENT}${INDENT}Version: 102`,
            `${INDENT}${INDENT}ShadingModel: "phong"`,
            `${INDENT}${INDENT}MultiLayer: 0`,
            `${INDENT}${INDENT}Properties70:  {`,
            `${INDENT}${INDENT}${INDENT}P: "AmbientColor", "Color", "", "A",${material.ambient.map(fmt).join(",")}`,
            `${INDENT}${INDENT}${INDENT}P: "DiffuseColor", "Color", "", "A",${material.diffuse.map(fmt).join(",")}`,
            `${INDENT}${INDENT}${INDENT}P: "SpecularColor", "Color", "", "A",${material.specular.map(fmt).join(",")}`,
            `${INDENT}${INDENT}${INDENT}P: "EmissiveColor", "Color", "", "A",${material.emissive.map(fmt).join(",")}`,
            `${INDENT}${INDENT}${INDENT}P: "Shininess", "double", "Number", "",${fmt(material.shininess)}`,
            `${INDENT}${INDENT}${INDENT}P: "Opacity", "double", "Number", "",${fmt(material.opacity)}`,
            `${INDENT}${INDENT}}`,
            `${INDENT}}`
        );
    });

    // Embedded textures
    const textureEntries = materialNames
        .map((name, index) => ({ name, index, texture: textureMap.get(name) }))
        .filter((entry) => entry.texture);

    textureEntries.forEach((entry, offset) => {
        const videoId = VIDEO_ID_BASE + offset;
        const textureId = TEXTURE_ID_BASE + offset;
        const filename = entry.texture.filename;

        push(
            `${INDENT}Video: ${videoId}, ${quote(`Video::${filename}`)}, "Clip" {`,
            `${INDENT}${INDENT}Type: "Clip"`,
            `${INDENT}${INDENT}Properties70:  {`,
            `${INDENT}${INDENT}${INDENT}P: "Path", "KString", "XRefUrl", "", ${quote(filename)}`,
            `${INDENT}${INDENT}}`,
            `${INDENT}${INDENT}UseMipMap: 0`,
            `${INDENT}${INDENT}Filename: ${quote(filename)}`,
            `${INDENT}${INDENT}RelativeFilename: ${quote(filename)}`,
            `${INDENT}${INDENT}Content: , ${quote(entry.texture.base64)}`,
            `${INDENT}}`,
            `${INDENT}Texture: ${textureId}, ${quote(`Texture::${filename}`)}, "" {`,
            `${INDENT}${INDENT}Type: "TextureVideoClip"`,
            `${INDENT}${INDENT}Version: 202`,
            `${INDENT}${INDENT}TextureName: ${quote(`Texture::${filename}`)}`,
            `${INDENT}${INDENT}Media: ${quote(`Video::${filename}`)}`,
            `${INDENT}${INDENT}FileName: ${quote(filename)}`,
            `${INDENT}${INDENT}RelativeFilename: ${quote(filename)}`,
            `${INDENT}${INDENT}ModelUVTranslation: 0,0`,
            `${INDENT}${INDENT}ModelUVScaling: 1,1`,
            `${INDENT}${INDENT}Texture_Alpha_Source: "None"`,
            `${INDENT}${INDENT}Cropping: 0,0,0,0`,
            `${INDENT}}`
        );
    });

    push("}", "Connections:  {");

    push(`${INDENT}C: "OO", ${MODEL_ID}, 0`);
    push(`${INDENT}C: "OO", ${GEOMETRY_ID}, ${MODEL_ID}`);

    materialNames.forEach((name, index) => {
        push(`${INDENT}C: "OO", ${MATERIAL_ID_BASE + index}, ${MODEL_ID}`);
    });

    textureEntries.forEach((entry, offset) => {
        const textureId = TEXTURE_ID_BASE + offset;
        const materialId = MATERIAL_ID_BASE + entry.index;

        push(`${INDENT}C: "OP", ${textureId}, ${materialId}, "DiffuseColor"`);
    });

    push("}", "Takes:  {", `${INDENT}Current: ""`, "}");

    return Buffer.from(lines.join("\n") + "\n", "utf8");
}

module.exports = { buildFbx };
