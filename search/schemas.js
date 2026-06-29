export const SEARCH_SOURCE_TYPES = Object.freeze([
  "official_site",
  "archive",
  "video_archive",
  "pdf",
  "image",
]);

export const SEARCH_MEDIA_TYPES = Object.freeze([
  "article",
  "image",
  "video",
  "pdf",
  "broadcast",
]);

export const SEARCH_LANGUAGES = Object.freeze([
  "ko",
  "en",
  "ja",
  "zh",
  "ru",
  "es",
  "fr",
  "ar",
  "de",
  "multi",
  "unknown",
]);

export const NORMALIZED_DOCUMENT_SCHEMA = Object.freeze({
  id: "string",
  title: "string",
  snippet: "string",
  date: "YYYY-MM-DD",
  sourceId: "string",
  sourceName: "string",
  sourceType: SEARCH_SOURCE_TYPES,
  displaySourceId: "string",
  displaySourceName: "string",
  displaySourceType: SEARCH_SOURCE_TYPES,
  mediaType: SEARCH_MEDIA_TYPES,
  url: "string",
  archiveUrl: "string",
  originalSourceUrl: "string",
  thumbnailUrl: "string",
  cachedUrl: "string",
  cachedThumbnailUrl: "string",
  body: "string",
  searchSnippet: "string",
  searchBody: "string",
  previewText: "string",
  previewSourceName: "string",
  previewDocumentId: "string",
  language: SEARCH_LANGUAGES,
  aliases: "string[]",
  searchTabs: "string[]",
  displayOrder: "number",
});

export const SEARCH_SOURCE_SCHEMA = Object.freeze({
  id: "string",
  name: "string",
  sourceType: SEARCH_SOURCE_TYPES,
  baseUrl: "string",
  languages: "string[]",
  mediaTypes: SEARCH_MEDIA_TYPES,
  aliases: "string[]",
  searchTabs: "string[]",
  crawler: {
    enabled: "boolean",
    entryUrl: "string",
    strategy: "string",
    schedule: "string",
    robotsPolicy: "string",
  },
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeSearchDocument(document = {}) {
  const title = normalizeKoreanSourceSpacing(document.title);
  const snippet = normalizeKoreanSourceSpacing(document.snippet);
  const body = normalizeKoreanSourceBodySpacing(document.body);
  const sourceId = document.sourceId || slugSourceId(document.sourceName);
  const sourceName = String(document.sourceName || "");
  const sourceType = document.sourceType || "archive";
  return {
    id: String(document.id || ""),
    title,
    snippet,
    date: String(document.date || ""),
    sourceId,
    sourceName,
    sourceType,
    displaySourceId: String(document.displaySourceId || sourceId),
    displaySourceName: String(document.displaySourceName || sourceName),
    displaySourceType: document.displaySourceType || sourceType,
    mediaType: document.mediaType || "article",
    url: String(document.url || ""),
    archiveUrl: String(document.archiveUrl || ""),
    originalSourceUrl: String(document.originalSourceUrl || ""),
    thumbnailUrl: String(document.thumbnailUrl || ""),
    cachedUrl: String(document.cachedUrl || ""),
    cachedThumbnailUrl: String(document.cachedThumbnailUrl || ""),
    language: document.language || "ko",
    aliases: Array.isArray(document.aliases) ? document.aliases.map((alias) => normalizeKoreanSourceSpacing(alias)) : [],
    body,
    searchSnippet: normalizeKoreanSourceBodySpacing(document.searchSnippet),
    searchBody: normalizeKoreanSourceBodySpacing(document.searchBody),
    previewText: normalizeKoreanSourceBodySpacing(document.previewText),
    previewSourceName: String(document.previewSourceName || ""),
    previewDocumentId: String(document.previewDocumentId || ""),
    searchTabs: Array.isArray(document.searchTabs) ? document.searchTabs.map(String) : [],
    displayOrder: document.displayOrder,
  };
}

export function normalizeKoreanSourceSpacing(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/김\s*정\s*은\s+동지/g, "김정은동지")
    .replace(/김\s*정\s*일\s+동지/g, "김정일동지")
    .replace(/김\s*일\s*성\s+동지/g, "김일성동지")
    .replace(/([가-힣])\s+(께서|께서는|께|은|는|이|가|을|를|의|에|에서|에게|한테|와|과|도|로|으로|부터|까지|만|조차|마저|마다|밖에|처럼|보다|이며|이시며|이신|이라고|라고|으로써|으로서)(?=[\s,.;:!?()[\]{}《》〈〉「」『』“”"']|$)/g, "$1$2")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

export function normalizeKoreanSourceBodySpacing(value = "") {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .split("\n")
    .map((line) => normalizeKoreanSourceSpacing(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeSearchSource(source = {}) {
  return {
    id: String(source.id || ""),
    name: String(source.name || ""),
    sourceType: source.sourceType || "archive",
    baseUrl: String(source.baseUrl || ""),
    languages: Array.isArray(source.languages) ? source.languages.map(String) : [],
    mediaTypes: Array.isArray(source.mediaTypes) ? source.mediaTypes.map(String) : [],
    aliases: Array.isArray(source.aliases) ? source.aliases.map(String) : [],
    searchTabs: Array.isArray(source.searchTabs) ? source.searchTabs.map(String) : [],
    crawler: {
      enabled: Boolean(source.crawler?.enabled),
      entryUrl: String(source.crawler?.entryUrl || source.baseUrl || ""),
      strategy: String(source.crawler?.strategy || "html"),
      schedule: String(source.crawler?.schedule || "manual"),
      robotsPolicy: String(source.crawler?.robotsPolicy || "respect"),
      selectors: source.crawler?.selectors || {},
      notes: String(source.crawler?.notes || ""),
    },
  };
}

export function validateSearchDocument(document = {}, sources = []) {
  const normalized = normalizeSearchDocument(document);
  const sourceIds = new Set(sources.map((source) => source.id));
  const errors = [];

  for (const field of ["id", "title", "snippet", "date", "sourceName", "sourceType", "mediaType", "url", "language"]) {
    if (!normalized[field]) errors.push(`document.${field} is required`);
  }
  if (!DATE_PATTERN.test(normalized.date)) errors.push("document.date must be YYYY-MM-DD");
  if (DATE_PATTERN.test(normalized.date) && !isValidSearchDate(normalized.date)) errors.push(`document.date is invalid: ${normalized.date}`);
  if (!SEARCH_SOURCE_TYPES.includes(normalized.sourceType)) errors.push(`document.sourceType is invalid: ${normalized.sourceType}`);
  if (!SEARCH_SOURCE_TYPES.includes(normalized.displaySourceType)) errors.push(`document.displaySourceType is invalid: ${normalized.displaySourceType}`);
  if (!SEARCH_MEDIA_TYPES.includes(normalized.mediaType)) errors.push(`document.mediaType is invalid: ${normalized.mediaType}`);
  if (!SEARCH_LANGUAGES.includes(normalized.language)) errors.push(`document.language is invalid: ${normalized.language}`);
  if (!Array.isArray(normalized.aliases)) errors.push("document.aliases must be an array");
  if (sourceIds.size > 0 && !sourceIds.has(normalized.sourceId)) {
    errors.push(`document.sourceId does not match a configured source: ${normalized.sourceId}`);
  }

  return errors;
}

function isValidSearchDate(value = "") {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Number.isInteger(day) && day >= 1 && day <= daysInMonth;
}

export function validateSearchSource(source = {}) {
  const normalized = normalizeSearchSource(source);
  const errors = [];

  for (const field of ["id", "name", "sourceType", "baseUrl"]) {
    if (!normalized[field]) errors.push(`source.${field} is required`);
  }
  if (!SEARCH_SOURCE_TYPES.includes(normalized.sourceType)) errors.push(`source.sourceType is invalid: ${normalized.sourceType}`);
  for (const mediaType of normalized.mediaTypes) {
    if (!SEARCH_MEDIA_TYPES.includes(mediaType)) errors.push(`source.mediaTypes contains invalid value: ${mediaType}`);
  }
  if (!normalized.crawler.entryUrl) errors.push("source.crawler.entryUrl is required");

  return errors;
}

export function slugSourceId(sourceName = "") {
  return String(sourceName)
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-|-$/g, "");
}
