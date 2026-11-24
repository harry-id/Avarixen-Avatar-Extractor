// Status classification helpers for the AAE frontend.
//
// Extracted from the inline module script in frontend/index.html so the
// status-key classification rules can be unit tested with the Node.js built-in
// test runner. Behavior is unchanged: the sets of busy/error status keys below
// mirror the original implementation exactly.

export function isStatusBusyKey(key) {
    // Keys that represent an in-progress operation (not a final/error state).
    return key === "statusLoadingMaterial" ||
        key === "statusLoadingModel" ||
        key === "statusSearching" ||
        key === "statusFetchMetadata" ||
        key === "statusDownloadAssets" ||
        key === "statusConverting" ||
        key === "statusRigging";
}

export function isStatusErrorKey(key) {
    return key === "statusLoadObjFailed" ||
        key === "statusLoadMtlFailed" ||
        key === "statusNoLocalModel" ||
        key === "errorEmptyUsername" ||
        key === "errorNotFound" ||
        key === "errorFetchMetadata" ||
        key === "errorDownloadAssets" ||
        key === "errorOccurred" ||
        key === "errorConvertFailed" ||
        key === "errorZipFetch" ||
        key === "apiOffline";
}
