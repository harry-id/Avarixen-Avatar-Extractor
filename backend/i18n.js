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
        "download.write_failed": "Folder unduhan tidak dapat ditulis. Perbaiki izin pada folder downloads/<userId>.",
        "download.success": "Avatar berhasil diunduh.",
        "convert.invalid_user_id": "User ID tidak valid.",
        "convert.unsupported": "Format tidak didukung. Gunakan GLB, GLTF, atau FBX.",
        "convert.no_obj": "File OBJ tidak ditemukan. Unduh avatar terlebih dahulu.",
        "convert.failed": "Konversi model gagal.",
        "convert.rig_failed": "Auto-rig gagal: {{message}}",
        "convert.rig_unsupported_fbx": "Auto-rig tidak didukung untuk format FBX.",
        "catalog.search_failed": "Pencarian katalog gagal.",
        "catalog.invalid_asset_id": "ID aset tidak valid.",
        "catalog.not_ready": "Pratinjau 3D belum siap. Coba lagi.",
        "catalog.no_3d": "Aset ini tidak memiliki pratinjau 3D.",
        "catalog.metadata_invalid": "Metadata aset tidak valid atau tidak lengkap.",
        "catalog.metadata_failed": "Gagal mengunduh aset katalog.",
        "catalog.download_success": "Aset katalog berhasil diunduh.",
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
        "download.write_failed": "The download folder is not writable. Fix permissions on downloads/<userId>.",
        "download.success": "Avatar downloaded successfully.",
        "convert.invalid_user_id": "Invalid user ID.",
        "convert.unsupported": "Unsupported format. Use GLB, GLTF, or FBX.",
        "convert.no_obj": "OBJ file not found. Download the avatar first.",
        "convert.failed": "Model conversion failed.",
        "convert.rig_failed": "Auto-rig failed: {{message}}",
        "convert.rig_unsupported_fbx": "Auto-rig is not supported for the FBX format.",
        "catalog.search_failed": "Catalog search failed.",
        "catalog.invalid_asset_id": "Invalid asset ID.",
        "catalog.not_ready": "The 3D preview is not ready yet. Try again.",
        "catalog.no_3d": "This asset does not have a 3D preview.",
        "catalog.metadata_invalid": "Asset metadata is invalid or incomplete.",
        "catalog.metadata_failed": "Failed to download catalog asset.",
        "catalog.download_success": "Catalog asset downloaded successfully.",
        "rate_limited": "Too many requests. Try again later."
    }
};

const DEFAULT_LANG = "id";

function getLang(req) {
    const header = req.headers["accept-language"] || "";
    const first = header.split(",")[0];
    const primary = first.split("-")[0].trim().toLowerCase();
    return MESSAGES[primary] ? primary : DEFAULT_LANG;
}

function t(lang, key) {
    const dict = MESSAGES[lang] || MESSAGES[DEFAULT_LANG];
    return dict[key] || key;
}

module.exports = { getLang, t, DEFAULT_LANG, MESSAGES };
