const MESSAGES = {
    id: {
        "user.empty": "Username tidak boleh kosong.",
        "user.invalid": "Username tidak valid.",
        "user.not_found": "Username tidak ditemukan.",
        "user.lookup_failed": "Gagal mencari akun Roblox.",
        "user.upstream_failed": "Gagal menghubungi layanan Roblox.",
        "user.timeout": "Permintaan ke Roblox melebihi batas waktu.",
        "avatar.invalid_user_id": "User ID tidak valid.",
        "avatar.not_configured": "Roblox API Key belum dikonfigurasi.",
        "avatar.upstream_failed": "Gagal mengambil metadata avatar dari Roblox.",
        "avatar.timeout": "Permintaan ke Roblox melebihi batas waktu.",
        "avatar.failed": "Gagal mengambil avatar 3D.",
        "download.invalid_user_id": "User ID tidak valid.",
        "download.not_configured": "Roblox API Key belum dikonfigurasi.",
        "download.upstream_avatar_failed": "Gagal mengambil informasi avatar dari Roblox.",
        "download.metadata_failed": "Gagal mengunduh metadata avatar.",
        "download.metadata_invalid": "Metadata avatar tidak valid.",
        "download.metadata_incomplete": "Metadata avatar tidak lengkap atau tidak valid.",
        "download.timeout": "Permintaan ke Roblox melebihi batas waktu.",
        "download.failed": "Gagal mengunduh aset avatar.",
        "download.busy": "Server sedang sibuk mengunduh. Coba lagi sebentar.",
        "download.rate_limited": "Terlalu banyak permintaan unduhan. Tunggu sebentar lalu coba lagi.",
        "download.too_large": "Aset avatar melebihi batas ukuran yang diizinkan.",
        "download.no_space": "Ruang penyimpanan server tidak mencukupi untuk mengunduh avatar.",
        "download.write_failed": "Folder unduhan tidak dapat ditulis. Perbaiki izin pada folder downloads/<userId>.",
        "download.success": "Avatar berhasil diunduh.",
        "convert.invalid_user_id": "User ID tidak valid.",
        "convert.unsupported": "Format tidak didukung. Gunakan GLB, GLTF, atau FBX.",
        "convert.no_obj": "File OBJ tidak ditemukan. Unduh avatar terlebih dahulu.",
        "convert.failed": "Konversi model gagal.",
        "convert.too_large": "Model melebihi batas ukuran yang diizinkan.",
        "convert.rig_failed": "Auto-rig gagal: {{message}}",
        "convert.rig_failed_generic": "Auto-rig gagal. Periksa model dan opsi ekspor.",
        "convert.busy": "Server sedang sibuk mengonversi model. Coba lagi sebentar.",
        "convert.worker_oom": "Konversi kehabisan memori. Coba lagi atau turunkan kualitas mesh.",
        "convert.timeout": "Konversi terlalu lama. Coba lagi atau turunkan kualitas mesh.",
        "parts.busy": "Server sedang sibuk menganalisis model. Coba lagi sebentar.",
        "error.bad_request": "Permintaan tidak valid.",
        "error.not_found": "Endpoint tidak ditemukan.",
        "error.internal": "Terjadi kesalahan pada server.",
        "rate_limited": "Terlalu banyak permintaan. Coba lagi nanti."
    },
    en: {
        "user.empty": "Username cannot be empty.",
        "user.invalid": "Invalid username.",
        "user.not_found": "Roblox account not found.",
        "user.lookup_failed": "Failed to look up Roblox account.",
        "user.upstream_failed": "Failed to contact Roblox service.",
        "user.timeout": "Request to Roblox timed out.",
        "avatar.invalid_user_id": "Invalid user ID.",
        "avatar.not_configured": "Roblox API Key not configured.",
        "avatar.upstream_failed": "Failed to fetch avatar metadata from Roblox.",
        "avatar.timeout": "Request to Roblox timed out.",
        "avatar.failed": "Failed to fetch 3D avatar.",
        "download.invalid_user_id": "Invalid user ID.",
        "download.not_configured": "Roblox API Key not configured.",
        "download.upstream_avatar_failed": "Failed to fetch avatar information from Roblox.",
        "download.metadata_failed": "Failed to download avatar metadata.",
        "download.metadata_invalid": "Avatar metadata is invalid.",
        "download.metadata_incomplete": "Avatar metadata is incomplete or invalid.",
        "download.timeout": "Request to Roblox timed out.",
        "download.failed": "Failed to download avatar assets.",
        "download.busy": "The server is busy downloading. Try again shortly.",
        "download.rate_limited": "Too many download requests. Wait a moment and try again.",
        "download.too_large": "The avatar asset exceeds the allowed size limit.",
        "download.no_space": "The server does not have enough storage to download this avatar.",
        "download.write_failed": "The download folder is not writable. Fix permissions on downloads/<userId>.",
        "download.success": "Avatar downloaded successfully.",
        "convert.invalid_user_id": "Invalid user ID.",
        "convert.unsupported": "Unsupported format. Use GLB, GLTF, or FBX.",
        "convert.no_obj": "OBJ file not found. Download the avatar first.",
        "convert.failed": "Model conversion failed.",
        "convert.too_large": "The model exceeds the allowed size limit.",
        "convert.rig_failed": "Auto-rig failed: {{message}}",
        "convert.rig_failed_generic": "Auto-rig failed. Check the model and export options.",
        "convert.busy": "The server is busy converting models. Try again shortly.",
        "convert.worker_oom": "The conversion ran out of memory. Try again or lower the mesh quality.",
        "convert.timeout": "The conversion took too long. Try again or lower the mesh quality.",
        "parts.busy": "The server is busy analyzing the model. Try again shortly.",
        "error.bad_request": "Invalid request.",
        "error.not_found": "Endpoint not found.",
        "error.internal": "An internal server error occurred.",
        "rate_limited": "Too many requests. Try again later."
    }
};

const DEFAULT_LANG = "en";

function getLang(req) {
    const header = req.headers["accept-language"] || "";
    const first = header.split(",")[0];
    const primary = first.split("-")[0].trim().toLowerCase();
    return MESSAGES[primary] ? primary : DEFAULT_LANG;
}

function t(lang, key, params = {}) {
    const dict = MESSAGES[lang] || MESSAGES[DEFAULT_LANG];
    const text = dict[key] || key;

    return text.replace(/\{\{(\w+)\}\}/g, (match, name) =>
        params[name] !== undefined && params[name] !== null
            ? String(params[name])
            : match
    );
}

module.exports = { getLang, t, DEFAULT_LANG, MESSAGES };
