// Export format capability matrix for the AAE frontend.

export const DEFAULT_FORMAT_SUPPORT = {
    separate: true,
    rig: true
};

export const FORMAT_OPTION_SUPPORT = {
    obj: { separate: false, rig: false },
    glb: { separate: false, rig: true },
    gltf: { separate: true, rig: true },
    fbx: { separate: true, rig: true }
};

export function isFormatOptionSupported(format, option) {
    const support = FORMAT_OPTION_SUPPORT[format] || DEFAULT_FORMAT_SUPPORT;

    return Boolean(support[option]);
}
