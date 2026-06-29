import { groupResultsBySource, filterDocumentsForTab, getResultDisplaySourceId, hasSearchQuery, RESULT_TABS } from "./resultFilters.js?v=search-20260629-1";
import { collapseDuplicateResults } from "./resultIdentity.js?v=search-20260629-1";
import { createEmptySearchResult, normalizeSearchFilters } from "./SearchProvider.js?v=search-20260629-1";
import { getSearchSuggestions } from "./suggestions.js?v=search-20260629-1";
import { enrichSearchResultPreviews } from "./previewEnrichment.js?v=search-20260629-1";
import { hasStructuredSearchOperators, parseSearchQueryOperators } from "./queryOperators.js?v=search-20260629-1";
import { filterDocumentsForExcludedTerms, hasExcludedTermQuery, hasPositiveDocumentQuery } from "./documentSearch.js?v=search-20260629-1";
import {
  DEFAULT_LOCAL_DOCUMENTS_URL,
  DEFAULT_LOCAL_SOURCES_URL,
  parseJsonl,
  validateSearchIndex,
} from "./localIndex.js?v=search-20260629-1";

export class LocalJsonSearchProvider {
  constructor({
    documents,
    sources,
    documentsUrl = DEFAULT_LOCAL_DOCUMENTS_URL,
    sourcesUrl = DEFAULT_LOCAL_SOURCES_URL,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.documents = Array.isArray(documents) ? documents : null;
    this.sources = Array.isArray(sources) ? sources : null;
    this.documentsUrl = documentsUrl;
    this.sourcesUrl = sourcesUrl;
    this.fetchImpl = fetchImpl;
    this.index = null;
    this.loadPromise = null;
  }

  async searchDocuments(query, filters = {}) {
    const startedAt = getCurrentTimeMs();
    const index = await this.loadIndex();
    const parsedQuery = parseSearchQueryOperators(query, index.sources);
    const normalizedFilters = normalizeSearchFilters({
      ...filters,
      tab: parsedQuery.tab || filters.tab,
      excludedMediaTypes: mergeFilterValues(filters.excludedMediaTypes, parsedQuery.excludedMediaTypes),
      sourceIds: mergeFilterValues(filters.sourceIds, parsedQuery.sourceIds),
      excludedSourceIds: mergeFilterValues(filters.excludedSourceIds, parsedQuery.excludedSourceIds),
      languages: mergeFilterValues(filters.languages, parsedQuery.languages),
      excludedLanguages: mergeFilterValues(filters.excludedLanguages, parsedQuery.excludedLanguages),
      dateFrom: parsedQuery.dateFrom || filters.dateFrom,
      dateTo: parsedQuery.dateTo || filters.dateTo,
    });
    const hasFilterOnlyQuery = !hasPositiveDocumentQuery(parsedQuery.query)
      && (hasStructuredSearchOperators(parsedQuery) || hasActiveStructuredFilters(normalizedFilters));
    const effectiveQuery = hasFilterOnlyQuery ? parsedQuery.query : (parsedQuery.query || query);
    const hasQuerySourceOperator = parsedQuery.sourceIds.length > 0;

    if (!index.documents.length) return createTimedEmptySearchResult(query, normalizedFilters, "empty_index", startedAt);
    if (!hasSearchQuery(effectiveQuery) && !hasFilterOnlyQuery) return createTimedEmptySearchResult(query, normalizedFilters, "empty_query", startedAt);

    const tabbedDocuments = hasFilterOnlyQuery
      ? collapseDuplicateResults(filterDocumentsByTab(index.documents, normalizedFilters.tab))
      : filterDocumentsForTab(index.documents, effectiveQuery, normalizedFilters.tab);
    let sourceFacetDocuments = applyStructuredFilters(tabbedDocuments, normalizedFilters, {
      includeSourceIds: hasQuerySourceOperator,
    });
    let documents = applyStructuredFilters(tabbedDocuments, normalizedFilters);
    if (hasFilterOnlyQuery && hasExcludedTermQuery(effectiveQuery)) {
      documents = filterDocumentsForExcludedTerms(documents, effectiveQuery);
      sourceFacetDocuments = filterDocumentsForExcludedTerms(sourceFacetDocuments, effectiveQuery);
    }
    if (hasFilterOnlyQuery) documents = documents.map(createFilterOnlyResult);
    documents = sortDocumentsForSearch(documents, normalizedFilters, { filterOnly: hasFilterOnlyQuery });
    documents = enrichSearchResultPreviews(documents, index.documents, effectiveQuery);

    const total = documents.length;
    const pagedDocuments = documents.slice(
      normalizedFilters.offset,
      normalizedFilters.offset + normalizedFilters.limit,
    );

    return {
      query: String(effectiveQuery || ""),
      filters: normalizedFilters,
      documents: pagedDocuments,
      groupedSources: groupResultsBySource(pagedDocuments, index.sourceOrder, documents, normalizedFilters),
      sourceFilters: normalizedFilters.sourceIds.map((sourceId) => ({
        sourceId,
        sourceName: index.sourceById.get(sourceId)?.name || sourceId,
      })),
      sourceFacets: createSourceFacets(sourceFacetDocuments, index.sources),
      total,
      indexSize: index.documents.length,
      processingTimeMs: getElapsedTimeMs(startedAt),
      status: "ok",
    };
  }

  async getSuggestions(query) {
    if (!hasSearchQuery(query)) return [];
    const index = await this.loadIndex();
    return getSearchSuggestions(query, {
      documents: index.documents,
      sources: index.sources,
    });
  }

  async getDocumentById(id) {
    const index = await this.loadIndex();
    return index.documents.find((document) => document.id === id) || null;
  }

  async loadIndex() {
    if (this.index) return this.index;
    if (!this.loadPromise) {
      this.loadPromise = this.readIndex()
        .then((index) => {
          this.index = index;
          return index;
        })
        .catch((error) => {
          this.loadPromise = null;
          if (this.index) return this.index;
          throw error;
        });
    }
    return this.loadPromise;
  }

  async readIndex() {
    const [rawDocuments, rawSources] = await Promise.all([
      this.documents ? Promise.resolve(this.documents) : this.fetchDocuments(),
      this.sources ? Promise.resolve(this.sources) : this.fetchSources(),
    ]);
    const { documents, sources, errors } = validateSearchIndex(rawDocuments, rawSources);
    if (errors.length) throw new Error(`Local search index is invalid:\n${errors.join("\n")}`);

    return {
      documents,
      sources,
      sourceOrder: sources.map((source) => source.name),
      sourceById: new Map(sources.map((source) => [source.id, source])),
    };
  }

  async fetchDocuments() {
    const text = await fetchText(this.fetchImpl, this.documentsUrl);
    return parseJsonl(text);
  }

  async fetchSources() {
    const text = await fetchText(this.fetchImpl, this.sourcesUrl);
    return JSON.parse(text || "[]");
  }
}

async function fetchText(fetchImpl, url) {
  if (!fetchImpl) throw new Error("No fetch implementation is available for LocalJsonSearchProvider.");
  const response = await fetchImpl(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to load local search index ${url}: ${response.status}`);
  return response.text();
}

function createTimedEmptySearchResult(query, filters, status, startedAt) {
  return {
    ...createEmptySearchResult(query, filters, status),
    processingTimeMs: getElapsedTimeMs(startedAt),
  };
}

function getCurrentTimeMs() {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

function getElapsedTimeMs(startedAt) {
  return Math.max(0, Math.round((getCurrentTimeMs() - startedAt) * 10) / 10);
}

function hasActiveStructuredFilters(filters = {}) {
  return Boolean(
    (filters.tab && filters.tab !== "all")
      || filters.mediaTypes.length
      || filters.excludedMediaTypes.length
      || filters.sourceTypes.length
      || filters.sourceIds.length
      || filters.excludedSourceIds.length
      || filters.languages.length
      || filters.excludedLanguages.length
      || filters.dateFrom
      || filters.dateTo,
  );
}

function filterDocumentsByTab(documents = [], activeTab = "all") {
  const tab = RESULT_TABS[activeTab] || RESULT_TABS.all;
  return documents.filter((document) => {
    if (!tab.mediaTypes.includes(document.mediaType)) return false;
    if (tab.id === "all") return true;
    if (!Array.isArray(document.searchTabs) || document.searchTabs.length === 0) return true;
    return document.searchTabs.includes(tab.id);
  });
}

function createFilterOnlyResult(document = {}) {
  return {
    ...document,
    score: 0,
    baseScore: 0,
    scoreReason: "filter:match",
    displaySnippet: document.snippet || document.body || "",
    highlightRanges: {
      title: [],
      snippet: [],
    },
  };
}

function applyStructuredFilters(documents, filters, { includeSourceIds = true } = {}) {
  return documents.filter((document) => {
    if (filters.mediaTypes.length && !filters.mediaTypes.includes(document.mediaType)) return false;
    if (filters.excludedMediaTypes.length && filters.excludedMediaTypes.includes(document.mediaType)) return false;
    if (filters.sourceTypes.length && !filters.sourceTypes.includes(document.sourceType)) return false;
    if (filters.languages.length && !filters.languages.includes(document.language)) return false;
    if (filters.excludedLanguages.length && filters.excludedLanguages.includes(document.language)) return false;
    if (filters.dateFrom && String(document.date || "") < filters.dateFrom) return false;
    if (filters.dateTo && String(document.date || "") > filters.dateTo) return false;
    if (filters.excludedSourceIds.length && documentMatchesSourceFilter(document, filters.excludedSourceIds)) return false;
    if (includeSourceIds && filters.sourceIds.length && !documentMatchesSourceFilter(document, filters.sourceIds)) return false;
    return true;
  });
}

function createSourceFacets(documents = [], sources = []) {
  const counts = new Map();
  for (const document of documents) {
    const sourceId = getResultDisplaySourceId(document);
    if (!sourceId) continue;
    counts.set(sourceId, (counts.get(sourceId) || 0) + 1);
  }

  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return [...counts.entries()]
    .map(([sourceId, count]) => {
      const source = sourceById.get(sourceId);
      return {
        sourceId,
        sourceName: source?.name || sourceId,
        sourceType: source?.sourceType || "",
        count,
        order: source ? sources.indexOf(source) : sources.length,
      };
    })
    .sort((left, right) => right.count - left.count || left.order - right.order || left.sourceName.localeCompare(right.sourceName, "ko-KR"))
    .map(({ order, ...facet }) => facet);
}

function documentMatchesSourceFilter(document = {}, sourceIds = []) {
  return sourceIds.includes(getResultDisplaySourceId(document));
}

function mergeFilterValues(left = [], right = []) {
  return [...new Set([
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : []),
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function sortDocumentsForSearch(documents = [], filters = {}, { filterOnly = false } = {}) {
  if (filterOnly && filters.sort !== "latest") {
    return [...documents].sort((left, right) => (
      getIntegratedRank(left) - getIntegratedRank(right)
      || String(right.date || "").localeCompare(String(left.date || ""))
      || getDisplayOrder(left) - getDisplayOrder(right)
      || String(left.title || "").localeCompare(String(right.title || ""), "ko-KR")
    ));
  }
  if (filters.sort !== "latest") return documents;
  return [...documents].sort((left, right) => (
    String(right.date || "").localeCompare(String(left.date || ""))
    || getIntegratedRank(left) - getIntegratedRank(right)
    || Number(right.score ?? right.baseScore ?? 0) - Number(left.score ?? left.baseScore ?? 0)
    || getDisplayOrder(left) - getDisplayOrder(right)
    || String(left.title || "").localeCompare(String(right.title || ""), "ko-KR")
  ));
}

function getIntegratedRank(document = {}) {
  if (document.mediaType === "article") return 0;
  if (document.mediaType === "pdf") return 1;
  if (document.mediaType === "broadcast") return 2;
  if (document.mediaType === "image") return 3;
  if (document.mediaType === "video") return 4;
  return 9;
}

function getDisplayOrder(document = {}) {
  const order = Number(document.displayOrder);
  return Number.isFinite(order) ? order : 999;
}
