import { groupResultsBySource, getResultDisplaySourceId } from "./resultFilters.js?v=search-20260823-7";

const DEFAULT_ENDPOINT = "/api/search-live";
const DEFAULT_MINIMUM_RESULTS = 12;
const LIVE_SOURCES = Object.freeze({
  "rodong-sinmun": { name: "로동신문", type: "official_site" },
  "choson-sinbo": { name: "조선신보", type: "archive" },
});
const LIVE_SOURCE_IDS = Object.keys(LIVE_SOURCES);

export class LiveSearchFallbackProvider {
  constructor(primary, {
    endpoint = DEFAULT_ENDPOINT,
    minimumResults = DEFAULT_MINIMUM_RESULTS,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.primary = primary;
    this.endpoint = endpoint || DEFAULT_ENDPOINT;
    this.minimumResults = Math.max(1, Number(minimumResults) || DEFAULT_MINIMUM_RESULTS);
    this.fetchImpl = fetchImpl;
    this.liveDocuments = new Map();
  }

  async searchDocuments(query, filters = {}) {
    const baseResult = await this.primary.searchDocuments(query, filters);
    if (!this.shouldSupplement(query, baseResult, filters)) return baseResult;

    try {
      const liveDocuments = await this.fetchLiveDocuments(query, baseResult.filters || filters);
      if (!liveDocuments.length) return baseResult;
      for (const document of liveDocuments) this.liveDocuments.set(document.id, document);
      return mergeLiveSearchResults(baseResult, liveDocuments, filters);
    } catch {
      return baseResult;
    }
  }

  async getSuggestions(query) {
    return this.primary.getSuggestions(query);
  }

  async getDocumentById(id) {
    const indexedDocument = await this.primary.getDocumentById(id);
    if (indexedDocument) return indexedDocument;
    if (this.liveDocuments.has(id)) return this.liveDocuments.get(id);
    if (!/^(?:rodong|choson)-live-/.test(String(id || ""))) return null;

    try {
      const fetchImpl = this.fetchImpl;
      const response = await fetchImpl(`${this.endpoint}?id=${encodeURIComponent(id)}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;
      const payload = await response.json();
      const document = normalizeLiveDocument(payload?.document);
      if (document) this.liveDocuments.set(document.id, document);
      return document;
    } catch {
      return null;
    }
  }

  shouldSupplement(query, result = {}, filters = {}) {
    if (!this.fetchImpl || Number(result.total || 0) >= this.minimumResults) return false;
    const tab = result.filters?.tab || filters.tab || "all";
    if (tab !== "all" && tab !== "image") return false;
    if ((result.filters?.offset ?? filters.offset ?? 0) > 0) return false;
    if (!normalizeLiveQuery(query)) return false;

    const sourceIds = result.filters?.sourceIds || filters.sourceIds || [];
    const excludedSourceIds = result.filters?.excludedSourceIds || filters.excludedSourceIds || [];
    const languages = result.filters?.languages || filters.languages || [];
    const excludedLanguages = result.filters?.excludedLanguages || filters.excludedLanguages || [];
    if (!getSelectedLiveSourceIds(sourceIds, excludedSourceIds).length) return false;
    if (languages.length && !languages.includes("ko")) return false;
    if (excludedLanguages.includes("ko")) return false;
    return true;
  }

  async fetchLiveDocuments(query, filters = {}) {
    const normalizedQuery = normalizeLiveQuery(query);
    if (!normalizedQuery) return [];
    const tab = filters.tab === "image" ? "image" : "all";
    const limit = Math.max(this.minimumResults, Math.min(Number(filters.limit) || 20, 24));
    const params = new URLSearchParams({ q: normalizedQuery, tab, limit: String(limit) });
    const selectedSourceIds = getSelectedLiveSourceIds(filters.sourceIds, filters.excludedSourceIds);
    if (!selectedSourceIds.length) return [];
    params.set("sources", selectedSourceIds.join(","));
    const fetchImpl = this.fetchImpl;
    const response = await fetchImpl(`${this.endpoint}?${params.toString()}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload?.documents)
      ? payload.documents
        .map(normalizeLiveDocument)
        .filter(Boolean)
        .filter((document) => selectedSourceIds.includes(getResultDisplaySourceId(document)))
      : [];
  }
}

export function mergeLiveSearchResults(baseResult = {}, liveDocuments = [], filters = {}) {
  const resultDocuments = Array.isArray(baseResult.documents) ? baseResult.documents : [];
  const mergedByIdentity = new Map();
  for (const document of resultDocuments) mergedByIdentity.set(getLiveDocumentIdentity(document), document);

  let addedCount = 0;
  const addedSourceCounts = new Map();
  for (const document of liveDocuments) {
    const identity = getLiveDocumentIdentity(document);
    if (!identity || mergedByIdentity.has(identity)) continue;
    mergedByIdentity.set(identity, document);
    addedCount += 1;
    const sourceId = getResultDisplaySourceId(document);
    addedSourceCounts.set(sourceId, (addedSourceCounts.get(sourceId) || 0) + 1);
  }
  if (!addedCount) return baseResult;

  const normalizedFilters = baseResult.filters || filters;
  const sort = normalizedFilters.sort === "latest" ? "latest" : "relevance";
  const mergedDocuments = [...mergedByIdentity.values()].sort((left, right) => (
    sort === "latest"
      ? String(right.date || "").localeCompare(String(left.date || ""))
      : Number(right.score ?? right.baseScore ?? 0) - Number(left.score ?? left.baseScore ?? 0)
        || String(right.date || "").localeCompare(String(left.date || ""))
  ));
  const limit = Math.max(1, Number(normalizedFilters.limit) || mergedDocuments.length);
  const pagedDocuments = mergedDocuments.slice(0, limit);
  const sourceFacets = mergeSourceFacets(baseResult.sourceFacets, addedSourceCounts);
  const sourceTotals = new Map(sourceFacets.map((facet) => [facet.sourceId, facet.count]));
  const sourceOrder = (baseResult.groupedSources || []).map((group) => group.sourceName).filter(Boolean);

  return {
    ...baseResult,
    documents: pagedDocuments,
    groupedSources: groupResultsBySource(pagedDocuments, sourceOrder, sourceTotals, { sort }),
    sourceFacets,
    total: Number(baseResult.total || 0) + addedCount,
    liveSupplemented: true,
  };
}

function mergeSourceFacets(sourceFacets = [], addedSourceCounts = new Map()) {
  const facets = new Map((sourceFacets || []).map((facet) => [facet.sourceId, { ...facet }]));
  for (const [sourceId, count] of addedSourceCounts) {
    const current = facets.get(sourceId);
    if (current) {
      current.count = Number(current.count || 0) + count;
    } else {
      facets.set(sourceId, {
        sourceId,
        sourceName: LIVE_SOURCES[sourceId]?.name || sourceId,
        sourceType: LIVE_SOURCES[sourceId]?.type || "",
        count,
      });
    }
  }
  return [...facets.values()].sort((left, right) => right.count - left.count || left.sourceName.localeCompare(right.sourceName, "ko-KR"));
}

function getSelectedLiveSourceIds(sourceIds = [], excludedSourceIds = []) {
  const included = Array.isArray(sourceIds) ? sourceIds : [];
  const excluded = new Set(Array.isArray(excludedSourceIds) ? excludedSourceIds : []);
  return LIVE_SOURCE_IDS
    .filter((sourceId) => !included.length || included.includes(sourceId))
    .filter((sourceId) => !excluded.has(sourceId));
}

function normalizeLiveDocument(document) {
  if (!document || !document.id || !document.title || !document.url || !document.mediaType) return null;
  return {
    ...document,
    aliases: Array.isArray(document.aliases) ? document.aliases : [],
    searchTabs: Array.isArray(document.searchTabs) ? document.searchTabs : [],
    highlightRanges: document.highlightRanges || { title: [], snippet: [] },
  };
}

function getLiveDocumentIdentity(document = {}) {
  if (!document.mediaType) return document.id || "";
  if (document.mediaType === "image" && document.thumbnailUrl) {
    return `${document.sourceId || document.sourceName || ""}:image:${document.thumbnailUrl}`;
  }
  const title = String(document.title || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[^0-9a-z가-힣]+/gi, "");
  if (title && document.date) {
    return `${document.sourceId || document.sourceName || ""}:${document.mediaType}:${document.date}:${title}`;
  }
  return `${document.mediaType}:${document.url || document.id || ""}`;
}

function normalizeLiveQuery(query = "") {
  const value = String(query || "").replace(/\s+/g, " ").trim();
  if (value.length < 2 || value.length > 80) return "";
  if (!/^[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ\s·]+$/u.test(value)) return "";
  if (/(?:^|\s)(?:AND|OR|NOT)(?=\s|$)/i.test(value)) return "";
  return value;
}
