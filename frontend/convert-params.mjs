// Conversion query parameter construction for the backend /convert endpoint.

export function buildConversionParams({
    rig = false,
    separate = false,
    subdivision = 0,
    moreJoints = false,
    bendAccessories = false,
    name = null
} = {}) {
    const params = new URLSearchParams();

    if (rig) params.set("rig", "1");
    if (separate) params.set("separate", "1");
    if (subdivision > 0) params.set("subdivision", String(subdivision));
    if (moreJoints) params.set("moreJoints", "1");
    if (rig) params.set("bendAccessories", bendAccessories ? "1" : "0");
    if (name) params.set("name", name);

    return params;
}
