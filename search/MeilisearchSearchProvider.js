import { groupResultsBySource } from "./resultFilters.js?v=search-20260823-7";
import { collapseDuplicateResults } from "./resultIdentity.js?v=search-20260823-7";
import { SOURCE_BY_ID, SOURCE_ORDER } from "./sourceConfig.js?v=search-20260823-7";
import { resolveKnownEntityDocumentQuery } from "./knownEntities.js?v=search-20260823-7";
import { isStandaloneConsonantOnlySearch, normalizeQuery, normalizeWidthText } from "./normalizeQuery.js?v=search-20260823-7";
import { isExactSourceDocumentMatch, resolveExactSourceQuery } from "./sourceQuery.js?v=search-20260823-7";
import { cleanDisplaySnippetText, createDocumentPresentation, filterDocumentsForExactPhraseQuery, filterDocumentsForExcludedTerms, filterDocumentsForTextQuery, filterDocumentsForTitleQuery, filterDocumentsForUrlQuery, getDocumentSearchTextQueries, hasAlternativeQuery, hasExactPhraseQuery, hasExcludedTermQuery, hasPositiveDocumentQuery, hasTextQuery, hasTitleQuery, hasUrlQuery } from "./documentSearch.js?v=search-20260823-7";
import { hasStructuredSearchOperators, parseSearchQueryOperators } from "./queryOperators.js?v=search-20260823-7";
import { getOperatorSearchSuggestions } from "./suggestions.js?v=search-20260823-7";
import {
  createEmptySearchResult,
  DEFAULT_SEARCH_INDEX_NAME,
  DEFAULT_SUGGESTION_INDEX_NAME,
  normalizeSearchFilters,
} from "./SearchProvider.js?v=search-20260823-7";
import { normalizeSearchDocument } from "./schemas.js?v=search-20260823-7";

const HIGHLIGHT_PRE_TAG = "___DPRK_SEARCH_HIGHLIGHT_START___";
const HIGHLIGHT_POST_TAG = "___DPRK_SEARCH_HIGHLIGHT_END___";
const MEILI_DOCUMENT_SEARCH_ATTRIBUTES = ["title", "searchSnippet", "searchBody", "normalizedText", "url", "archiveUrl", "cachedUrl", "thumbnailUrl", "cachedThumbnailUrl", "aliases", "sourceName", "displaySourceName"];
const CLIENT_SIDE_REWRITE_CANDIDATE_LIMIT = 500;
export const DEFAULT_MEILI_RANKING_SCORE_THRESHOLD = 0.2;

export class MeilisearchSearchProvider {
  constructor({
    host = "",
    apiKey = "",
    documentIndex = DEFAULT_SEARCH_INDEX_NAME,
    suggestionIndex = DEFAULT_SUGGESTION_INDEX_NAME,
    fetchImpl = globalThis.fetch,
    rankingScoreThreshold = DEFAULT_MEILI_RANKING_SCORE_THRESHOLD,
  } = {}) {
    this.host = String(host || "").replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.documentIndex = documentIndex;
    this.suggestionIndex = suggestionIndex;
    this.fetchImpl = fetchImpl;
    this.rankingScoreThreshold = normalizeRankingScoreThreshold(rankingScoreThreshold);
  }

  get isConfigured() {
    return Boolean(this.host && this.fetchImpl);
  }

  async searchDocuments(query, filters = {}) {
    const parsedQuery = parseSearchQueryOperators(query);
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
    const shouldFetchUnscopedSourceFacets = normalizedFilters.sourceIds.length > 0 && !hasQuerySourceOperator;
    const backendQueries = getMeilisearchQueries(effectiveQuery);
    const requestBackendQueries = backendQueries.length ? backendQueries : (hasFilterOnlyQuery ? [""] : []);
    if (!this.isConfigured) {
      return createEmptySearchResult(query, normalizedFilters, "meilisearch_not_configured");
    }
    if (!requestBackendQueries.length) return createEmptySearchResult(query, normalizedFilters, "empty_query");

    const exactSource = resolveExactSourceQuery(effectiveQuery);
    const shouldUseAlternativeQueries = backendQueries.length > 1 || hasAlternativeQuery(effectiveQuery);
    const shouldFilterExactPhrase = hasExactPhraseQuery(effectiveQuery);
    const shouldFilterExcludedTerms = hasExcludedTermQuery(effectiveQuery);
    const shouldFilterTitle = hasTitleQuery(effectiveQuery);
    const shouldFilterText = hasTextQuery(effectiveQuery);
    const shouldFilterUrl = hasUrlQuery(effectiveQuery);
    const shouldPromoteExactSource = Boolean(exactSource && !normalizedFilters.sourceIds.length);
    const clientSideOptions = {
      exactSource,
      shouldFilterExactPhrase,
      shouldFilterExcludedTerms,
      shouldFilterTitle,
      shouldFilterText,
      shouldFilterUrl,
      shouldPromoteExactSource,
      shouldUseAlternativeQueries,
    };
    const shouldUseClientWindow = usesClientSideResultRewrites(clientSideOptions);
    const backendLimit = shouldUseClientWindow
      ? Math.max(normalizedFilters.limit + normalizedFilters.offset, CLIENT_SIDE_REWRITE_CANDIDATE_LIMIT)
      : normalizedFilters.limit;
    const backendOffset = shouldUseClientWindow ? 0 : normalizedFilters.offset;
    const payloads = await Promise.all(requestBackendQueries.map((backendQuery) => this.searchDocumentPayload(backendQuery, normalizedFilters, {
      limit: backendLimit,
      offset: backendOffset,
    })));
    const fallbackSourceFacetDistribution = mergeSourceFacetDistributions(payloads.map(getPayloadSourceFacetDistribution));
    const sourceFacetDistribution = shouldFetchUnscopedSourceFacets
      ? (shouldUseClientWindow
          ? await this.fetchUnscopedClientFilteredSourceFacetDistribution(requestBackendQueries, normalizedFilters, effectiveQuery, clientSideOptions, fallbackSourceFacetDistribution)
          : await this.fetchUnscopedSourceFacetDistribution(requestBackendQueries, normalizedFilters, fallbackSourceFacetDistribution))
      : mergeSourceFacetDistributions(payloads.map(getPayloadSourceFacetDistribution));
    const backendDocuments = collapseDuplicateResults(payloads.flatMap((payload) => (
      (payload.hits || []).map((hit) => formatMeilisearchDocumentHit(hit, effectiveQuery))
    )));
    const candidateDocuments = applyClientSideResultRewrites(backendDocuments, effectiveQuery, normalizedFilters, clientSideOptions);
    const documents = shouldUseClientWindow
      ? candidateDocuments.slice(normalizedFilters.offset, normalizedFilters.offset + normalizedFilters.limit)
      : candidateDocuments;
    const effectiveSourceFacetDistribution = shouldFilterExactPhrase || shouldFilterExcludedTerms || shouldFilterTitle || shouldFilterText || shouldFilterUrl || shouldUseAlternativeQueries
      ? (shouldFetchUnscopedSourceFacets ? sourceFacetDistribution : countSourceFacetsFromDocuments(candidateDocuments))
      : sourceFacetDistribution;
    const processingTimeMs = payloads.reduce((total, payload) => total + (Number(payload.processingTimeMs) || 0), 0);

    return {
      query: String(effectiveQuery || ""),
      filters: normalizedFilters,
      documents,
      groupedSources: groupResultsBySource(documents, SOURCE_ORDER, effectiveSourceFacetDistribution, normalizedFilters),
      sourceFilters: getSourceFilters(normalizedFilters),
      sourceFacets: getSourceFacets(effectiveSourceFacetDistribution),
      total: shouldUseClientWindow ? candidateDocuments.length : getTotalHits(payloads, documents.length),
      processingTimeMs,
      status: "ok",
    };
  }

  async searchDocumentPayload(backendQuery, filters, { limit, offset, includeSourceIds = true }) {
    return this.postJson(`/indexes/${encodeURIComponent(this.documentIndex)}/search`, {
      q: backendQuery,
      filter: buildMeilisearchFilters(filters, { includeSourceIds }),
      limit,
      offset,
      attributesToHighlight: ["title", "searchSnippet", "previewText", "searchBody", "aliases"],
      attributesToSearchOn: MEILI_DOCUMENT_SEARCH_ATTRIBUTES,
      attributesToCrop: ["previewText", "searchBody"],
      cropLength: 36,
      facets: ["sourceId"],
      highlightPreTag: HIGHLIGHT_PRE_TAG,
      highlightPostTag: HIGHLIGHT_POST_TAG,
      matchingStrategy: "all",
      showRankingScore: true,
      ...(this.rankingScoreThreshold === null ? {} : { rankingScoreThreshold: this.rankingScoreThreshold }),
      sort: buildMeilisearchSort(filters),
    });
  }

  async fetchUnscopedSourceFacetDistribution(backendQueryOrQueries, filters, fallbackDistribution = {}) {
    const backendQueries = Array.isArray(backendQueryOrQueries) ? backendQueryOrQueries : [backendQueryOrQueries];
    try {
      const payloads = await Promise.all(backendQueries.map((backendQuery) => this.postJson(`/indexes/${encodeURIComponent(this.documentIndex)}/search`, {
        q: backendQuery,
        filter: buildMeilisearchFilters(filters, { includeSourceIds: false }),
        limit: 0,
        offset: 0,
        attributesToSearchOn: MEILI_DOCUMENT_SEARCH_ATTRIBUTES,
        facets: ["sourceId"],
        matchingStrategy: "all",
        ...(this.rankingScoreThreshold === null ? {} : { rankingScoreThreshold: this.rankingScoreThreshold }),
      })));
      const merged = mergeSourceFacetDistributions(payloads.map(getPayloadSourceFacetDistribution));
      return Object.keys(merged).length ? merged : (fallbackDistribution || {});
    } catch {
      return fallbackDistribution || {};
    }
  }

  async fetchUnscopedClientFilteredSourceFacetDistribution(backendQueryOrQueries, filters, effectiveQuery, clientSideOptions, fallbackDistribution = {}) {
    const backendQueries = Array.isArray(backendQueryOrQueries) ? backendQueryOrQueries : [backendQueryOrQueries];
    try {
      const payloads = await Promise.all(backendQueries.map((backendQuery) => this.searchDocumentPayload(backendQuery, filters, {
        limit: CLIENT_SIDE_REWRITE_CANDIDATE_LIMIT,
        offset: 0,
        includeSourceIds: false,
      })));
      const documents = collapseDuplicateResults(payloads.flatMap((payload) => (
        (payload.hits || []).map((hit) => formatMeilisearchDocumentHit(hit, effectiveQuery))
      )));
      return countSourceFacetsFromDocuments(applyClientSideResultRewrites(documents, effectiveQuery, filters, clientSideOptions));
    } catch {
      return fallbackDistribution || {};
    }
  }

  async getSuggestions(query) {
    const operatorSuggestions = getOperatorSearchSuggestions(query, {
      sources: Object.values(SOURCE_BY_ID),
    });
    if (operatorSuggestions.length) return operatorSuggestions;

    const backendQuery = getMeilisearchQueries(query)[0] || "";
    if (!backendQuery) return [];
    if (!this.isConfigured) return [];
    const payload = await this.postJson(`/indexes/${encodeURIComponent(this.suggestionIndex)}/search`, {
      q: backendQuery,
      limit: 8,
      attributesToHighlight: ["label", "aliases"],
      highlightPreTag: HIGHLIGHT_PRE_TAG,
      highlightPostTag: HIGHLIGHT_POST_TAG,
      showRankingScore: true,
    });

    return (payload.hits || []).map(formatMeilisearchSuggestionHit);
  }

  async getDocumentById(id) {
    if (!this.isConfigured || !id) return null;
    const response = await this.fetchImpl(`${this.host}/indexes/${encodeURIComponent(this.documentIndex)}/documents/${encodeURIComponent(id)}`, {
      headers: this.createHeaders(),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Meilisearch document lookup failed: ${response.status}`);
    return normalizeSearchDocument(await response.json());
  }

  async postJson(path, body) {
    const response = await this.fetchImpl(`${this.host}${path}`, {
      method: "POST",
      headers: this.createHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Meilisearch request failed: ${response.status}`);
    return response.json();
  }

  createHeaders() {
    return {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }
}

function promoteExactSourceDocuments(documents = [], exactSource = null) {
  if (!exactSource) return documents;
  return documents.map((document) => (
    isExactSourceDocumentMatch(document, exactSource)
      ? {
          ...document,
          backendScore: document.score,
          score: Number(document.score ?? 0) + 2,
          scoreReason: "sourceName:exact",
        }
      : document
  )).sort((left, right) => (
    Number(isExactSourceDocumentMatch(right, exactSource)) - Number(isExactSourceDocumentMatch(left, exactSource))
    || Number(right.score ?? 0) - Number(left.score ?? 0)
  ));
}

function formatMeilisearchDocumentHit(hit = {}, query = "") {
  const document = normalizeSearchDocument(hit);
  const formatted = hit._formatted || {};
  const title = parseFormattedText(formatted.title);
  const snippet = parseFormattedText(formatted.snippet);
  const searchSnippet = parseFormattedText(formatted.searchSnippet);
  const previewText = parseFormattedText(formatted.previewText);
  const body = parseFormattedText(formatted.body);
  const searchBody = parseFormattedText(formatted.searchBody);
  const displaySnippet = chooseFormattedDisplaySnippet({
    snippet,
    searchSnippet,
    previewText,
    body,
    searchBody,
    fallbackPreviewText: hit.previewText,
    title: document.title,
  });
  const fallbackPresentation = createDocumentPresentation(document, query);
  const useFallbackSnippet = !displaySnippet.ranges.length && fallbackPresentation.highlightRanges.snippet.length;

  return {
    ...document,
    score: hit._rankingScore,
    displaySnippet: useFallbackSnippet
      ? fallbackPresentation.displaySnippet
      : (displaySnippet.text || fallbackPresentation.displaySnippet || cleanDisplaySnippetText(document.snippet || "", document.title || "")),
    previewSourceName: hit.previewSourceName || "",
    previewDocumentId: hit.previewDocumentId || "",
    highlightRanges: {
      title: title.ranges.length ? title.ranges : fallbackPresentation.highlightRanges.title,
      snippet: useFallbackSnippet ? fallbackPresentation.highlightRanges.snippet : displaySnippet.ranges,
    },
  };
}

function chooseFormattedDisplaySnippet({ snippet, searchSnippet, previewText, body, searchBody, fallbackPreviewText, title }) {
  const cleanedPreviewText = cleanFormattedSnippetCandidate(previewText, title);
  const cleanedSearchSnippet = cleanFormattedSnippetCandidate(searchSnippet, title);
  const cleanedSnippet = cleanFormattedSnippetCandidate(snippet, title);
  const cleanedSearchBody = cleanFormattedSnippetCandidate(searchBody, title);
  const cleanedBody = cleanFormattedSnippetCandidate(body, title);
  if (cleanedPreviewText.text && previewText.ranges.length) return cleanedPreviewText;
  if (cleanedSearchSnippet.ranges.length) return cleanedSearchSnippet;
  if (cleanedSnippet.ranges.length) return cleanedSnippet;
  if (cleanedSearchBody.ranges.length) return cleanedSearchBody;
  if (cleanedBody.ranges.length) return cleanedBody;
  if (fallbackPreviewText) return { text: cleanDisplaySnippetText(fallbackPreviewText, title), ranges: [] };
  return cleanedSnippet;
}

function cleanFormattedSnippetCandidate(candidate = {}, title = "") {
  const text = cleanDisplaySnippetText(candidate.text || "", title);
  return {
    text,
    ranges: text === candidate.text
      ? candidate.ranges || []
      : remapFormattedRanges(candidate.text || "", text, candidate.ranges || []),
  };
}

function remapFormattedRanges(originalText = "", cleanedText = "", ranges = []) {
  if (!cleanedText || !Array.isArray(ranges) || !ranges.length) return [];

  const remapped = [];
  let searchFrom = 0;
  for (const range of ranges) {
    const start = Math.max(0, Math.min(originalText.length, Number(range.start)));
    const end = Math.max(start, Math.min(originalText.length, Number(range.end)));
    const needle = originalText.slice(start, end);
    if (!needle) continue;

    let index = cleanedText.indexOf(needle, searchFrom);
    if (index < 0) index = cleanedText.indexOf(needle);
    if (index < 0) continue;

    remapped.push({ start: index, end: index + needle.length });
    searchFrom = index + needle.length;
  }

  return dedupeHighlightRanges(remapped);
}

function dedupeHighlightRanges(ranges = []) {
  return ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce((merged, range) => {
      const previous = merged[merged.length - 1];
      if (!previous || range.start >= previous.end) merged.push(range);
      return merged;
    }, []);
}

function formatMeilisearchSuggestionHit(hit = {}) {
  const formattedLabel = parseFormattedText(hit._formatted?.label);
  const source = hit.sourceId ? SOURCE_BY_ID[hit.sourceId] : null;
  return {
    id: hit.id,
    label: hit.label,
    aliases: hit.aliases || [],
    type: hit.type || "",
    description: hit.description || getSuggestionDescription(hit, source),
    sourceId: hit.sourceId || "",
    sourceName: hit.sourceName || source?.name || "",
    sourceType: hit.sourceType || source?.sourceType || "",
    mediaType: hit.mediaType || "",
    documentId: hit.documentId || "",
    score: hit._rankingScore,
    highlightRanges: formattedLabel.ranges,
  };
}

function getSuggestionDescription(hit = {}, source = null) {
  if (hit.type === "entity") return "추천어";
  if (hit.type === "source") return source ? `${source.name} 자료원` : "자료원";
  if (hit.type === "document_title") {
    return [hit.sourceName || source?.name, getMediaLabel(hit.mediaType)].filter(Boolean).join(" · ");
  }
  return "";
}

function getMediaLabel(mediaType = "") {
  if (mediaType === "article") return "기사";
  if (mediaType === "image") return "이미지";
  if (mediaType === "video") return "동영상";
  if (mediaType === "pdf") return "문헌";
  if (mediaType === "broadcast") return "방송";
  return "";
}

function getMeilisearchQuery(searchText) {
  const normalized = normalizeQuery(searchText);
  if (!normalized.raw || isStandaloneConsonantOnlySearch(normalized)) return "";

  const resolvedDocumentQuery = resolveKnownEntityDocumentQuery(normalized.raw);
  if (resolvedDocumentQuery) return resolvedDocumentQuery;

  return normalizeWidthText(normalized.raw);
}

function getMeilisearchQueries(query) {
  return [...new Set(
    getDocumentSearchTextQueries(query)
      .map(getMeilisearchQuery)
      .filter(Boolean),
  )];
}

function getTotalHits(payloads = [], fallback = 0) {
  if (!payloads.length) return fallback;
  return payloads.reduce((total, payload) => (
    total + Number(payload.estimatedTotalHits ?? payload.totalHits ?? 0)
  ), 0) || fallback;
}

function mergeSourceFacetDistributions(distributions = []) {
  const merged = {};
  for (const distribution of distributions) {
    for (const [sourceId, count] of Object.entries(distribution || {})) {
      merged[sourceId] = (merged[sourceId] || 0) + (Number(count) || 0);
    }
  }
  return merged;
}

function getPayloadSourceFacetDistribution(payload = {}) {
  return payload.facetDistribution?.sourceId || payload.facetDistribution?.displaySourceId || {};
}

function countSourceFacetsFromDocuments(documents = []) {
  const counts = {};
  for (const document of documents) {
    const sourceId = document.sourceId || "";
    if (!sourceId) continue;
    counts[sourceId] = (counts[sourceId] || 0) + 1;
  }
  return counts;
}

function usesClientSideResultRewrites(options = {}) {
  return Boolean(
    options.shouldUseAlternativeQueries
      || options.shouldPromoteExactSource
      || options.shouldFilterExactPhrase
      || options.shouldFilterExcludedTerms
      || options.shouldFilterTitle
      || options.shouldFilterText
      || options.shouldFilterUrl,
  );
}

function applyClientSideResultRewrites(documents = [], effectiveQuery = "", filters = {}, options = {}) {
  let candidateDocuments = documents;
  if (options.shouldPromoteExactSource) candidateDocuments = promoteExactSourceDocuments(candidateDocuments, options.exactSource);
  if (options.shouldFilterExactPhrase) candidateDocuments = filterDocumentsForExactPhraseQuery(candidateDocuments, effectiveQuery);
  if (options.shouldFilterExcludedTerms) candidateDocuments = filterDocumentsForExcludedTerms(candidateDocuments, effectiveQuery);
  if (options.shouldFilterTitle) candidateDocuments = filterDocumentsForTitleQuery(candidateDocuments, effectiveQuery);
  if (options.shouldFilterText) candidateDocuments = filterDocumentsForTextQuery(candidateDocuments, effectiveQuery);
  if (options.shouldFilterUrl) candidateDocuments = filterDocumentsForUrlQuery(candidateDocuments, effectiveQuery);
  if (options.shouldUseAlternativeQueries) candidateDocuments = sortMergedMeilisearchDocuments(candidateDocuments, filters);
  return candidateDocuments;
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

function sortMergedMeilisearchDocuments(documents = [], filters = {}) {
  return [...documents].sort((left, right) => {
    if (filters.sort === "latest") {
      const dateComparison = String(right.date || "").localeCompare(String(left.date || ""));
      if (dateComparison) return dateComparison;
    }

    return Number(right.score ?? 0) - Number(left.score ?? 0)
      || Number(left.integratedRank ?? left.displayOrder ?? 999) - Number(right.integratedRank ?? right.displayOrder ?? 999)
      || Number(left.displayOrder ?? 999) - Number(right.displayOrder ?? 999)
      || String(right.date || "").localeCompare(String(left.date || ""))
      || String(left.title || "").localeCompare(String(right.title || ""), "ko-KR");
  });
}

function buildMeilisearchFilters(filters, { includeSourceIds = true } = {}) {
  const clauses = [];
  if (filters.tab) clauses.push(`visibleTabs = ${JSON.stringify(filters.tab)}`);
  if (filters.mediaTypes.length) clauses.push(`mediaType IN [${quoteList(filters.mediaTypes)}]`);
  if (filters.excludedMediaTypes.length) clauses.push(`mediaType NOT IN [${quoteList(filters.excludedMediaTypes)}]`);
  if (filters.sourceTypes.length) clauses.push(`sourceType IN [${quoteList(filters.sourceTypes)}]`);
  if (filters.languages.length) clauses.push(`language IN [${quoteList(filters.languages)}]`);
  if (filters.excludedLanguages.length) clauses.push(`language NOT IN [${quoteList(filters.excludedLanguages)}]`);
  if (filters.dateFrom) clauses.push(`date >= ${JSON.stringify(filters.dateFrom)}`);
  if (filters.dateTo) clauses.push(`date <= ${JSON.stringify(filters.dateTo)}`);
  if (filters.excludedSourceIds.length) clauses.push(`sourceId NOT IN [${quoteList(filters.excludedSourceIds)}]`);
  if (includeSourceIds && filters.sourceIds.length) clauses.push(`sourceId IN [${quoteList(filters.sourceIds)}]`);
  return clauses.length ? clauses.join(" AND ") : undefined;
}

function buildMeilisearchSort(filters) {
  if (filters.sort === "latest") {
    return filters.tab === "all"
      ? ["date:desc", "integratedRank:asc", "displayOrder:asc"]
      : ["date:desc", "displayOrder:asc"];
  }
  return filters.tab === "all"
    ? ["integratedRank:asc", "date:desc"]
    : ["date:desc"];
}

function getSourceFilters(filters) {
  return filters.sourceIds.map((sourceId) => ({
    sourceId,
    sourceName: SOURCE_BY_ID[sourceId]?.name || sourceId,
  }));
}

function getSourceFacets(distribution = {}) {
  return Object.entries(distribution || {})
    .map(([sourceId, count]) => {
      const source = SOURCE_BY_ID[sourceId];
      return {
        sourceId,
        sourceName: source?.name || sourceId,
        sourceType: source?.sourceType || "",
        count: Number(count) || 0,
        order: source ? SOURCE_ORDER.indexOf(source.name) : SOURCE_ORDER.length,
      };
    })
    .filter((facet) => facet.count > 0)
    .sort((left, right) => right.count - left.count || left.order - right.order || left.sourceName.localeCompare(right.sourceName, "ko-KR"))
    .map(({ order, ...facet }) => facet);
}

function quoteList(values) {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function mergeFilterValues(left = [], right = []) {
  return [...new Set([
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : []),
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeRankingScoreThreshold(value) {
  if (value === null) return null;
  const threshold = Number(value);
  if (!Number.isFinite(threshold)) return DEFAULT_MEILI_RANKING_SCORE_THRESHOLD;
  return Math.min(1, Math.max(0, threshold));
}

function parseFormattedText(value) {
  if (typeof value !== "string") return { text: "", ranges: [] };

  let text = "";
  const ranges = [];
  let cursor = 0;
  let activeStart = -1;

  while (cursor < value.length) {
    if (value.startsWith(HIGHLIGHT_PRE_TAG, cursor)) {
      if (activeStart < 0) activeStart = text.length;
      cursor += HIGHLIGHT_PRE_TAG.length;
      continue;
    }
    if (value.startsWith(HIGHLIGHT_POST_TAG, cursor)) {
      if (activeStart >= 0 && text.length > activeStart) {
        ranges.push({ start: activeStart, end: text.length });
      }
      activeStart = -1;
      cursor += HIGHLIGHT_POST_TAG.length;
      continue;
    }

    const codePoint = value.codePointAt(cursor);
    const char = String.fromCodePoint(codePoint);
    text += char;
    cursor += char.length;
  }

  if (activeStart >= 0 && text.length > activeStart) {
    ranges.push({ start: activeStart, end: text.length });
  }

  return { text, ranges: dedupeRanges(ranges) };
}

function dedupeRanges(ranges = []) {
  return ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce((merged, range) => {
      const previous = merged[merged.length - 1];
      if (!previous || range.start >= previous.end) {
        merged.push({ start: range.start, end: range.end });
      }
      return merged;
    }, []);
}
