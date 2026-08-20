import { normalizeSearchDocument, normalizeSearchSource, validateSearchDocument, validateSearchSource } from "./schemas.js?v=search-20260803-6";
import { createSearchToken } from "./normalizeQuery.js?v=search-20260803-6";
import { getSearchableBodyText, getSearchableSnippetText } from "./documentSearch.js?v=search-20260803-6";

export const DEFAULT_LOCAL_SEARCH_BASE_URL = "/data/search";
export const DEFAULT_LOCAL_DOCUMENTS_URL = `${DEFAULT_LOCAL_SEARCH_BASE_URL}/documents.jsonl`;
export const DEFAULT_LOCAL_SOURCES_URL = `${DEFAULT_LOCAL_SEARCH_BASE_URL}/sources.json`;

export function parseJsonl(text = "") {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });
}

export function stringifyJsonl(rows = []) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}${rows.length ? "\n" : ""}`;
}

export function normalizeIndexedDocument(document = {}) {
  const normalized = normalizeSearchDocument(document);
  return {
    ...normalized,
    searchFields: {
      title: normalizeSearchText(normalized.title),
      snippet: normalizeSearchText(getSearchableSnippetText(normalized.snippet)),
      body: normalizeSearchText(getSearchableBodyText(normalized.body)),
      sourceName: normalizeSearchText(normalized.sourceName),
      displaySourceName: normalizeSearchText(normalized.displaySourceName),
      aliases: normalized.aliases.map(normalizeSearchText),
    },
  };
}

export function normalizeIndexedSource(source = {}) {
  return {
    ...normalizeSearchSource(source),
    searchFields: {
      name: normalizeSearchText(source.name),
      aliases: (source.aliases || []).map(normalizeSearchText),
    },
  };
}

export function toStoredSearchDocument(document = {}) {
  return normalizeSearchDocument(document);
}

export function toStoredSearchSource(source = {}) {
  return normalizeSearchSource(source);
}

export function validateSearchIndex(documents = [], sources = []) {
  const normalizedSources = sources.map(normalizeIndexedSource);
  const sourceById = new Map(normalizedSources.map((source) => [source.id, source]));
  const sourceByName = new Map(normalizedSources.map((source) => [source.name, source]));
  const normalizedDocuments = documents.map((document) => {
    const source = sourceById.get(document.sourceId) || sourceByName.get(document.sourceName);
    return normalizeIndexedDocument({
      ...document,
      body: normalizeDocumentBody(document, source),
      searchTabs: getDocumentSearchTabs(document, source),
    });
  });
  const sourceNames = new Set(normalizedSources.map((source) => source.name));
  const documentIds = new Set();
  const errors = [];

  for (const source of normalizedSources) {
    for (const error of validateSearchSource(source)) {
      errors.push(`[source:${source.id || "unknown"}] ${error}`);
    }
  }

  for (const document of normalizedDocuments) {
    const source = sourceById.get(document.sourceId) || sourceByName.get(document.sourceName);
    if (documentIds.has(document.id)) errors.push(`[document:${document.id}] duplicate document id`);
    documentIds.add(document.id);
    if (sourceNames.size > 0 && !sourceNames.has(document.sourceName)) {
      errors.push(`[document:${document.id}] sourceName is not configured: ${document.sourceName}`);
    }
    if (document.displaySourceId && !sourceById.has(document.displaySourceId)) {
      errors.push(`[document:${document.id}] displaySourceId is not configured: ${document.displaySourceId}`);
    }
    if (document.displaySourceName && !sourceNames.has(document.displaySourceName)) {
      errors.push(`[document:${document.id}] displaySourceName is not configured: ${document.displaySourceName}`);
    }
    for (const error of validateSearchDocument(document, normalizedSources)) {
      errors.push(`[document:${document.id || "unknown"}] ${error}`);
    }
    for (const error of validateDocumentSourcePolicy(document, source)) {
      errors.push(`[document:${document.id || "unknown"}] ${error}`);
    }
  }

  return {
    documents: normalizedDocuments,
    sources: normalizedSources,
    errors,
  };
}

export function normalizeSearchText(value = "") {
  const token = createSearchToken(String(value).trim().normalize("NFC"));
  return {
    original: token.original,
    compact: token.compact,
    lower: token.lower,
    compactLower: token.compactLower,
    disassembled: token.disassembled,
  };
}

function getDocumentSearchTabs(document = {}, source = null) {
  if (Array.isArray(document.searchTabs) && document.searchTabs.length) return document.searchTabs;
  if (Array.isArray(source?.searchTabs) && source.searchTabs.length) return source.searchTabs;
  if (document.mediaType === "image") return ["all", "image"];
  if (document.mediaType === "pdf") return ["all", "pdf"];
  if (document.mediaType === "video" || document.mediaType === "broadcast") return ["all", "video"];
  return [];
}

function validateDocumentSourcePolicy(document = {}, source = null) {
  if (!source) return [];

  const errors = [];
  if (source.mediaTypes.length && !source.mediaTypes.includes(document.mediaType)) {
    errors.push(`document.mediaType is not allowed for source ${source.id}: ${document.mediaType}`);
  }

  for (const field of ["url", "archiveUrl"]) {
    const value = document[field];
    if (!value) continue;
    if (!urlBelongsToSource(value, source)) {
      errors.push(`document.${field} is outside configured source domain ${source.baseUrl}: ${value}`);
    }
  }

  return errors;
}

function urlBelongsToSource(value = "", source = {}) {
  const sourceHost = getCanonicalHost(source.baseUrl);
  const documentHost = getCanonicalHost(value);
  if (!sourceHost || !documentHost) return false;
  return documentHost === sourceHost || documentHost.endsWith(`.${sourceHost}`);
}

function getCanonicalHost(value = "") {
  try {
    return new URL(value).hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

function stripTrailingSourceMetadata(body = "", source = null) {
  const text = String(body || "").trim();
  if (!text || !source) return text;

  const sourceTerms = [source.name, ...(source.aliases || [])]
    .map((term) => String(term || "").trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let stripped = text;
  let changed = true;

  while (changed) {
    changed = false;
    for (const term of sourceTerms) {
      const pattern = new RegExp(`(?:\\s+|^)${escapeRegExp(term)}\\s*$`, "iu");
      if (pattern.test(stripped)) {
        stripped = stripped.replace(pattern, "").trim();
        changed = true;
      }
    }
  }

  return stripped || text;
}

function normalizeDocumentBody(document = {}, source = null) {
  const stripped = stripTrailingSourceMetadata(document.body, source);
  if (isUnfocusedRodongBody(stripped, source)) {
    return [document.title, document.snippet].filter(Boolean).join(" ");
  }
  return normalizeArticleBodyLines(stripped, document, source) || stripped;
}

function isUnfocusedRodongBody(body = "", source = null) {
  if (source?.id !== "rodong-sinmun") return false;
  return /오늘호 기사|Copyright @ 2026 by The Rodong Sinmun|검색 혁명활동소식|인민을 위한 정치/.test(String(body || ""));
}

function normalizeArticleBodyLines(body = "", document = {}, source = null) {
  const titleKey = normalizeBodyComparable(document.title);
  const snippetKey = normalizeBodyComparable(document.snippet);
  const seen = new Map();
  const lines = [];

  for (const rawLine of String(body || "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/[ \t\f\v]+/g, " ").trim();
    if (!line) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }

    if (isSourceChromeLine(line, source)) continue;
    const comparable = normalizeBodyComparable(line);
    if (!comparable) continue;
    if (titleKey && comparable === titleKey) continue;
    if (snippetKey && comparable === snippetKey && lines.length > 0) continue;

    const count = seen.get(comparable) || 0;
    if (count > 0 && shouldCollapseRepeatedBodyLine(line)) continue;
    seen.set(comparable, count + 1);
    lines.push(line);
  }

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isSourceChromeLine(line = "", source = null) {
  const text = String(line || "").trim();
  const compact = text.replace(/\s+/g, "");
  if (!text) return true;
  if (/^Audio(?:\s+\d+)?$/i.test(text)) return true;
  if (/^\/\s*(?:보\s*도|주요소식|혁명활동소식|분야별기사)\s*$/u.test(text)) return true;
  if (/^(?:첫페지로|어종선택|Deutsch|Русский|Français|العربية|English|Español)$/u.test(text)) return true;
  if (/^(?:汉语|日本語|中文|조선어)$/u.test(compact)) return true;
  if (/조선어방송편집부|www\.vok\.rep\.kp|vok@/i.test(text)) return true;
  if (source?.id === "voice-of-korea" && /^vok$/i.test(text)) return true;
  return false;
}

function shouldCollapseRepeatedBodyLine(line = "") {
  const text = String(line || "").trim();
  return text.length >= 8 || /[가-힣]/.test(text);
}

function normalizeBodyComparable(value = "") {
  return String(value || "")
    .replace(/^[\s·•\-–—]+/g, "")
    .replace(/\s*[\[(（]\s*\d{4}\s*[./년-]\s*\d{1,2}\s*[./월-]\s*\d{1,2}\s*일?\s*[\])）]\s*$/u, "")
    .replace(/[ \t\f\v\r\n]+/g, "")
    .replace(/[()[\]{}.,:;!?'"“”‘’《》〈〉「」『』·•\-–—_/\\|]+/g, "")
    .toLocaleLowerCase("ko-KR");
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
