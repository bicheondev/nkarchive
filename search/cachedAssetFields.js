export function preserveCachedAssetFields(documents = [], existingDocuments = []) {
  const thumbnailCacheBySourceUrl = new Map();
  const primaryCacheBySourceUrl = new Map();

  for (const document of existingDocuments) {
    const thumbnailUrl = normalizeUrlValue(document.thumbnailUrl);
    const cachedThumbnailUrl = normalizeUrlValue(document.cachedThumbnailUrl);
    if (thumbnailUrl && cachedThumbnailUrl) {
      thumbnailCacheBySourceUrl.set(createAssetCacheKey(document.sourceId, thumbnailUrl), cachedThumbnailUrl);
    }

    const primaryAssetUrl = getPrimaryAssetUrl(document);
    const cachedUrl = normalizeUrlValue(document.cachedUrl);
    if (primaryAssetUrl && cachedUrl) {
      primaryCacheBySourceUrl.set(createAssetCacheKey(document.sourceId, document.mediaType, primaryAssetUrl), cachedUrl);
    }
  }

  return documents.map((document) => {
    const nextDocument = { ...document };
    const thumbnailUrl = normalizeUrlValue(nextDocument.thumbnailUrl);
    if (!normalizeUrlValue(nextDocument.cachedThumbnailUrl) && thumbnailUrl) {
      nextDocument.cachedThumbnailUrl = thumbnailCacheBySourceUrl.get(createAssetCacheKey(nextDocument.sourceId, thumbnailUrl)) || "";
    }

    const primaryAssetUrl = getPrimaryAssetUrl(nextDocument);
    if (!normalizeUrlValue(nextDocument.cachedUrl) && primaryAssetUrl) {
      nextDocument.cachedUrl = primaryCacheBySourceUrl.get(createAssetCacheKey(nextDocument.sourceId, nextDocument.mediaType, primaryAssetUrl)) || "";
    }

    return nextDocument;
  });
}

function getPrimaryAssetUrl(document = {}) {
  if (document.mediaType !== "image" && document.mediaType !== "pdf") return "";
  return normalizeUrlValue(document.url) || normalizeUrlValue(document.archiveUrl);
}

function createAssetCacheKey(...parts) {
  return parts.map((part) => String(part || "").trim()).join("\u001f");
}

function normalizeUrlValue(value = "") {
  return String(value || "").trim();
}
