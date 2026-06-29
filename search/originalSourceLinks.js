const ARCHIVE_SOURCES_WITH_ORIGINAL_PROVENANCE = new Set(["kcna-watch"]);

export function enrichArchiveOriginalSourceUrls(documents = []) {
  const originalUrlByKey = createOriginalUrlLookup(documents);

  return documents.map((document) => {
    if (!shouldLinkArchiveOriginalSource(document)) return document;

    const keys = createArchiveLookupKeys(document);
    const originalSourceUrl = keys.map((key) => originalUrlByKey.get(key)).find(Boolean) || "";
    if (!originalSourceUrl) return document;

    return {
      ...document,
      originalSourceUrl,
    };
  });
}

function createOriginalUrlLookup(documents = []) {
  const lookup = new Map();

  for (const document of documents) {
    if (!isDirectOriginalSourceCandidate(document)) continue;
    for (const key of createDirectOriginalLookupKeys(document)) {
      if (!lookup.has(key)) lookup.set(key, document.url);
    }
  }

  return lookup;
}

function shouldLinkArchiveOriginalSource(document = {}) {
  const sourceId = String(document.sourceId || "");
  const displaySourceId = String(document.displaySourceId || "");
  return ARCHIVE_SOURCES_WITH_ORIGINAL_PROVENANCE.has(sourceId)
    && displaySourceId
    && displaySourceId !== sourceId
    && !String(document.originalSourceUrl || "").trim();
}

function isDirectOriginalSourceCandidate(document = {}) {
  const sourceId = String(document.sourceId || "");
  const url = String(document.url || "").trim();
  return sourceId
    && !ARCHIVE_SOURCES_WITH_ORIGINAL_PROVENANCE.has(sourceId)
    && url
    && normalizeOriginalTitle(document.title);
}

function createArchiveLookupKeys(document = {}) {
  const displaySourceId = String(document.displaySourceId || "");
  return uniqueStrings([
    createOriginalLookupKey(displaySourceId, document.mediaType, document.date, document.title),
    createOriginalLookupKey(displaySourceId, document.mediaType, "", document.title),
  ]);
}

function createDirectOriginalLookupKeys(document = {}) {
  const sourceId = String(document.sourceId || "");
  return uniqueStrings([
    createOriginalLookupKey(sourceId, document.mediaType, document.date, document.title),
    createOriginalLookupKey(sourceId, document.mediaType, "", document.title),
  ]);
}

function createOriginalLookupKey(sourceId = "", mediaType = "", date = "", title = "") {
  const normalizedTitle = normalizeOriginalTitle(title);
  if (!sourceId || !normalizedTitle) return "";
  return [
    sourceId,
    String(mediaType || "article"),
    normalizeOriginalDate(date),
    normalizedTitle,
  ].join("|");
}

function normalizeOriginalDate(value = "") {
  const date = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function normalizeOriginalTitle(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/\(\s*\d{4}\s*[./년-]\s*\d{1,2}\s*[./월-]\s*\d{1,2}\s*일?\s*\)$/g, "")
    .replace(/\[\s*\d{4}\s*[./년-]\s*\d{1,2}\s*[./월-]\s*\d{1,2}\s*\.?\s*\]$/g, "")
    .replace(/[^\p{L}\p{N}가-힣]+/gu, "")
    .trim();
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}
