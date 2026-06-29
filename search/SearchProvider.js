export const DEFAULT_SEARCH_INDEX_NAME = "dprk_documents";
export const DEFAULT_SUGGESTION_INDEX_NAME = "dprk_suggestions";

/**
 * @typedef {Object} SearchFilters
 * @property {string=} tab
 * @property {string[]=} mediaTypes
 * @property {string[]=} excludedMediaTypes
 * @property {string[]=} sourceTypes
 * @property {string[]=} sourceIds
 * @property {string[]=} excludedSourceIds
 * @property {string[]=} languages
 * @property {string[]=} excludedLanguages
 * @property {string=} dateFrom
 * @property {string=} dateTo
 * @property {"relevance"|"latest"=} sort
 * @property {number=} limit
 * @property {number=} offset
 */

/**
 * @typedef {Object} SearchProvider
 * @property {(query: string, filters?: SearchFilters) => Promise<Object>} searchDocuments
 * @property {(query: string) => Promise<Array>} getSuggestions
 * @property {(id: string) => Promise<Object | null>} getDocumentById
 */

export function normalizeSearchFilters(filters = {}) {
  return {
    tab: filters.tab || "all",
    mediaTypes: normalizeStringList(filters.mediaTypes),
    excludedMediaTypes: normalizeStringList(filters.excludedMediaTypes),
    sourceTypes: normalizeStringList(filters.sourceTypes),
    sourceIds: normalizeStringList(filters.sourceIds),
    excludedSourceIds: normalizeStringList(filters.excludedSourceIds),
    languages: normalizeStringList(filters.languages),
    excludedLanguages: normalizeStringList(filters.excludedLanguages),
    dateFrom: normalizeDate(filters.dateFrom),
    dateTo: normalizeDate(filters.dateTo),
    sort: normalizeSearchSort(filters.sort),
    limit: normalizeNumber(filters.limit, 50),
    offset: normalizeNumber(filters.offset, 0),
  };
}

export function createEmptySearchResult(query = "", filters = {}, status = "ok") {
  return {
    query: String(query || ""),
    filters: normalizeSearchFilters(filters),
    documents: [],
    groupedSources: [],
    sourceFilters: [],
    sourceFacets: [],
    total: 0,
    status,
  };
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function normalizeSearchSort(value) {
  return value === "latest" ? "latest" : "relevance";
}
