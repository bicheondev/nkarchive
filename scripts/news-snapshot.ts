import { createHash } from "node:crypto";
import {
  NEWS_IMAGE_PAIR_HASH_ALGORITHM,
  NEWS_IMAGE_PAIR_HASH_VERSION,
  hashPublishedNewsImagePair,
  parseOfficialNewsImageUrl,
} from "../lib/news-image-policy.js";

export const NEWS_DOCUMENT_SCHEMA_VERSION = 1;
export const NEWS_SNAPSHOT_SCHEMA_VERSION = 3;
export const DEFAULT_MAX_NEWS_ITEMS_PER_SOURCE = 20_000;
export const NEWS_DETAIL_SHARD_COUNT = 256;
export const NEWS_CATEGORY_PAGE_SIZE = 5;
export const NEWS_SEARCH_INDEX_SCHEMA_VERSION = 1;
export const NEWS_ASSET_PUBLIC_PREFIX = "/data/news/assets/";
export const NEWS_DOCUMENTS_PUBLIC_PATH = "/data/news/documents.jsonl";
export const NEWS_FEED_PUBLIC_PATH = "/data/news-feed.json";
export const NEWS_DETAILS_PUBLIC_PATH = "/data/news-details.json";
export const NEWS_DETAIL_SHARD_PUBLIC_PATTERN = "/data/news/details/{shard}.json";
export const NEWS_CATEGORY_PAGE_PUBLIC_PATTERN = "/data/news/categories/{source}/{section}/page-{page}.json";
export const NEWS_SEARCH_INDEX_PUBLIC_PATH = "/data/news/search-index.json";
export const NEWS_IMAGE_PROXY_ALLOWLIST_PUBLIC_PATH = "/data/news/image-proxy-allowlist.json";
export const NEWS_MEDIA_TYPES = Object.freeze(["article", "image", "video"]);
export const NEWS_SECTION_IDS = Object.freeze([
  "leadership",
  "important",
  "international",
  "photo",
  "anecdote",
  "document",
  "foreign",
  "video",
  "memory",
  "domestic",
  "social",
]);
export const NEWS_SOURCE_SECTION_IDS = Object.freeze({
  kcna: NEWS_SECTION_IDS,
  "rodong-sinmun": Object.freeze([
    "leadership",
    "important",
    "photo",
    "anecdote",
    "video",
    "memory",
    "domestic",
    "social",
  ]),
});
export const NEWS_SECTION_QUOTAS = Object.freeze({
  leadership: 6,
  important: 6,
  international: 2,
  photo: 5,
  anecdote: 5,
  document: 6,
  foreign: 6,
  video: 5,
  memory: 5,
  domestic: 5,
  social: 5,
});
export const NEWS_SOURCE_SECTION_QUOTAS = Object.freeze({
  kcna: NEWS_SECTION_QUOTAS,
  "rodong-sinmun": Object.freeze({
    ...NEWS_SECTION_QUOTAS,
    // These sections do not exist in the official Rodong category navigation.
    international: 0,
    document: 0,
    foreign: 0,
  }),
});
export const NEWS_SOURCE_SECTION_READINESS_MINIMUMS = Object.freeze({
  kcna: NEWS_SECTION_QUOTAS,
  "rodong-sinmun": Object.freeze({
    ...NEWS_SOURCE_SECTION_QUOTAS["rodong-sinmun"],
    // The live official category-7 index currently declares and exposes 4 total records,
    // while the homepage design reserves up to 5 preview slots.
    social: 4,
  }),
});
export const DEFAULT_NEWS_SOURCE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "kcna", name: "조선중앙통신" }),
  Object.freeze({ id: "rodong-sinmun", name: "로동신문" }),
]);

/**
 * Stable browser/Node-compatible detail shard for a canonical article id.
 * FNV-1a is applied to JavaScript UTF-16 code units and the low byte selects
 * one of the fixed 256 shards.
 */
export function newsDetailShardForId(value) {
  const text = String(value || "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) & 0xff).toString(16).padStart(2, "0");
}

const SECTION_MEDIA_TYPES = Object.freeze({ photo: "image", video: "video" });
const DOCUMENT_KEYS = new Set([
  "schemaVersion",
  "id",
  "sourceId",
  "sourceName",
  "language",
  "mediaType",
  "title",
  "date",
  "url",
  "articleId",
  "articleUrl",
  "snippet",
  "body",
  "categories",
  "categoryOrders",
  "thumbnailUrl",
  "cachedUrl",
  "cachedThumbnailUrl",
  "displayOrder",
]);
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,191}$/u;
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const LOCAL_ASSET_PATTERN = /^\/data\/news\/assets\/[a-z0-9][a-z0-9-]{1,63}\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u;

/**
 * Canonical standalone news row used by data/news/documents.jsonl.
 * Unknown upstream fields are intentionally not carried into this shape.
 */
export function canonicalizeNewsDocument(value = {}) {
  const mediaType = normalizeText(value.mediaType || "article").toLocaleLowerCase("en-US");
  const sourceId = normalizeText(value.sourceId).toLocaleLowerCase("en-US");
  const body = normalizeBody(value.body);
  return {
    schemaVersion: NEWS_DOCUMENT_SCHEMA_VERSION,
    id: normalizeText(value.id),
    sourceId,
    sourceName: normalizeText(value.sourceName),
    language: normalizeText(value.language || "ko").toLocaleLowerCase("en-US"),
    mediaType,
    title: normalizeTitle(value.title, { sourceId, body }),
    date: normalizeText(value.date),
    url: normalizeRemoteUrl(value.url),
    articleId: normalizeText(value.articleId),
    articleUrl: normalizeRemoteUrl(value.articleUrl),
    snippet: normalizeText(value.snippet),
    body,
    categories: normalizeCategories(value.categories),
    categoryOrders: normalizeCategoryOrders(value.categoryOrders),
    thumbnailUrl: normalizeRemoteUrl(value.thumbnailUrl),
    cachedUrl: normalizeLocalAssetUrl(value.cachedUrl),
    cachedThumbnailUrl: normalizeLocalAssetUrl(value.cachedThumbnailUrl),
    displayOrder: normalizeDisplayOrder(value.displayOrder),
  };
}

export function validateNewsDocument(value, {
  label = "news document",
  rejectUnknownFields = true,
  requireArticleBody = true,
} = {}) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  if (rejectUnknownFields) {
    const unknown = Object.keys(value).filter((key) => !DOCUMENT_KEYS.has(key));
    if (unknown.length) throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
  }
  const document = canonicalizeNewsDocument(value);
  if (Number(value.schemaVersion ?? NEWS_DOCUMENT_SCHEMA_VERSION) !== NEWS_DOCUMENT_SCHEMA_VERSION) {
    throw new Error(`${label} has unsupported schemaVersion`);
  }
  if (!ID_PATTERN.test(document.id)) throw new Error(`${label} has an invalid id`);
  if (!SOURCE_ID_PATTERN.test(document.sourceId)) throw new Error(`${label} has an invalid sourceId`);
  if (!document.sourceName) throw new Error(`${label} is missing sourceName`);
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u.test(document.language)) {
    throw new Error(`${label} has an invalid language`);
  }
  if (!NEWS_MEDIA_TYPES.includes(document.mediaType)) throw new Error(`${label} has an invalid mediaType`);
  if (!document.title) throw new Error(`${label} is missing title`);
  if (!isIsoDate(document.date)) throw new Error(`${label} has an invalid date; expected YYYY-MM-DD`);
  if (!document.url) throw new Error(`${label} is missing an http(s) url`);
  if (document.articleId && !ID_PATTERN.test(document.articleId)) throw new Error(`${label} has an invalid articleId`);
  if (document.mediaType === "article" && requireArticleBody && !document.body) {
    throw new Error(`${label} article is missing body`);
  }
  if (document.mediaType === "image" && ![
    document.cachedUrl,
    document.cachedThumbnailUrl,
    document.thumbnailUrl,
    resolveOfficialImageOriginUrl(document),
  ].some(Boolean)) {
    throw new Error(`${label} image has no usable image asset`);
  }
  const rawCategories = Array.isArray(value.categories) ? value.categories.map((item) => normalizeText(item)) : [];
  const unknownCategories = rawCategories.filter((category) => category && !NEWS_SECTION_IDS.includes(category));
  if (unknownCategories.length) throw new Error(`${label} has an unknown category: ${unknownCategories[0]}`);
  for (const category of document.categories) {
    if (!NEWS_SECTION_IDS.includes(category)) throw new Error(`${label} has an unknown category: ${category}`);
  }
  if (value.categoryOrders !== undefined && !isPlainObject(value.categoryOrders)) {
    throw new Error(`${label} categoryOrders must be an object`);
  }
  const unknownOrderCategories = Object.keys(value.categoryOrders || {})
    .filter((category) => !NEWS_SECTION_IDS.includes(category));
  if (unknownOrderCategories.length) {
    throw new Error(`${label} has an unknown categoryOrders key: ${unknownOrderCategories[0]}`);
  }
  for (const [category, order] of Object.entries(value.categoryOrders || {})) {
    if (!Number.isSafeInteger(order) || order < 0) {
      throw new Error(`${label} has an invalid categoryOrders value for ${category}`);
    }
  }
  for (const [field, raw] of [
    ["cachedUrl", value.cachedUrl],
    ["cachedThumbnailUrl", value.cachedThumbnailUrl],
  ]) {
    if (raw && !isLocalNewsAssetUrl(raw)) {
      throw new Error(`${label} ${field} must live below ${NEWS_ASSET_PUBLIC_PREFIX}`);
    }
  }
  return document;
}

export function validateNewsDocuments(values, {
  label = "news documents",
  checkReferences = true,
  rejectUnknownFields = true,
  requireArticleBody = true,
} = {}) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const documents = values.map((value, index) => validateNewsDocument(value, {
    label: `${label}[${index}]`,
    rejectUnknownFields,
    requireArticleBody,
  }));
  const byId = new Map();
  for (const document of documents) {
    if (byId.has(document.id)) throw new Error(`${label} contains duplicate id: ${document.id}`);
    byId.set(document.id, document);
  }
  if (checkReferences) {
    const articlesByUrl = new Map(documents
      .filter((document) => document.mediaType === "article")
      .map((document) => [createSourceUrlKey(document.sourceId, document.url), document]));
    for (const document of documents) {
      if (document.mediaType === "article" || (!document.articleId && !document.articleUrl)) continue;
      const idTarget = document.articleId ? byId.get(document.articleId) : null;
      const urlTarget = document.articleUrl
        ? articlesByUrl.get(createSourceUrlKey(document.sourceId, document.articleUrl))
        : null;
      const target = idTarget || urlTarget;
      if (!target || target.mediaType !== "article" || target.sourceId !== document.sourceId) {
        throw new Error(`${label} has dangling media reference: ${document.id}`);
      }
      if (idTarget && document.articleUrl && normalizeAssociationUrl(idTarget.url) !== normalizeAssociationUrl(document.articleUrl)) {
        throw new Error(`${label} has conflicting articleId/articleUrl reference: ${document.id}`);
      }
    }
  }
  return documents;
}

export function parseNewsDocumentsJsonl(text, sourceLabel = "news JSONL") {
  const rows = String(text || "")
    .split(/\r?\n/u)
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch (error) {
        throw new Error(`Invalid JSON on line ${index + 1} of ${sourceLabel}`, { cause: error });
      }
    });
  return validateNewsDocuments(rows, { label: sourceLabel });
}

export function stringifyNewsDocumentsJsonl(values) {
  const documents = validateNewsDocuments(values)
    .sort(compareCanonicalDocuments);
  return documents.length ? `${documents.map((document) => JSON.stringify(document)).join("\n")}\n` : "";
}

export function mergeFreshNewsDocuments(existingValues, incomingValues, {
  requireFreshSourceHead = true,
} = {}) {
  const existing = validateNewsDocuments(existingValues, { label: "existing news documents" });
  const incoming = validateNewsDocuments(incomingValues, {
    label: "incoming news documents",
    checkReferences: false,
  });
  if (requireFreshSourceHead) assertSourceHeadDoesNotRegress(existing, incoming);

  const output = [...existing];
  const idIndex = new Map(output.map((document, index) => [document.id, index]));
  const identityIndex = new Map(output.map((document, index) => [createDocumentIdentity(document), index]));
  const idAliases = new Map();
  const report = { added: 0, updated: 0, unchanged: 0, preservedIds: [] };

  for (const rawNext of incoming) {
    const next = rawNext.articleId && idAliases.has(rawNext.articleId)
      ? canonicalizeNewsDocument({ ...rawNext, articleId: idAliases.get(rawNext.articleId) })
      : rawNext;
    const index = idIndex.get(next.id) ?? identityIndex.get(createDocumentIdentity(next));
    if (index === undefined) {
      output.push(next);
      const addedIndex = output.length - 1;
      idIndex.set(next.id, addedIndex);
      identityIndex.set(createDocumentIdentity(next), addedIndex);
      report.added += 1;
      continue;
    }
    const current = output[index];
    if (current.sourceId !== next.sourceId || current.mediaType !== next.mediaType) {
      throw new Error(`Incoming news identity collides with another source/type: ${next.id}`);
    }
    const merged = mergeDocumentQuality(current, next);
    if (next.id !== current.id) {
      report.preservedIds.push({ incomingId: next.id, id: current.id });
      idAliases.set(next.id, current.id);
    }
    if (JSON.stringify(merged) === JSON.stringify(current)) report.unchanged += 1;
    else report.updated += 1;
    identityIndex.delete(createDocumentIdentity(current));
    output[index] = merged;
    idIndex.set(current.id, index);
    identityIndex.set(createDocumentIdentity(merged), index);
  }

  const documents = validateNewsDocuments(output, { label: "merged news documents" })
    .sort(compareCanonicalDocuments);
  return { documents, report };
}

export function assertNewsSectionQuotaReadiness(values, {
  sourceDefinitions,
  sectionQuotas = NEWS_SECTION_QUOTAS,
  quotasBySource = NEWS_SOURCE_SECTION_QUOTAS,
  readinessMinimumsBySource,
  throwOnError = true,
} = {}) {
  const documents = validateNewsDocuments(values, { label: "news quota documents" });
  const sources = normalizeSourceDefinitions(sourceDefinitions, documents);
  const mediaIndex = createArticleMediaIndex(documents);
  const results = [];
  const assignments = new Map();
  const defaultReadinessMinimums = readinessMinimumsBySource === undefined
    && quotasBySource === NEWS_SOURCE_SECTION_QUOTAS
    ? NEWS_SOURCE_SECTION_READINESS_MINIMUMS
    : {};
  for (const source of sources) {
    const sourceDocuments = documents
      .filter((document) => document.sourceId === source.id && document.language === "ko")
      .sort(compareNewestFirst);
    const quotas = normalizeSectionQuotas(quotasBySource[source.id] || sectionQuotas);
    const readinessMinimums = normalizeSectionQuotas(
      readinessMinimumsBySource?.[source.id]
        || defaultReadinessMinimums[source.id]
        || quotas,
    );
    const selection = selectOfficialSectionRecords(sourceDocuments, quotas, readinessMinimums, mediaIndex);
    results.push(...selection.results.map((result) => ({ sourceId: source.id, ...result })));
    assignments.set(source.id, selection.assignments);
  }
  const missing = results.filter((result) => result.count < result.minimum);
  if (missing.length && throwOnError) {
    throw new Error(`News section quota is not ready: ${missing.map((item) => (
      `${item.sourceId}/${item.section} ${item.count}/${item.minimum}`
    )).join(", ")}`);
  }
  return { ready: missing.length === 0, results, missing, assignments };
}

export function buildNewsSnapshot(values, {
  sourceDefinitions,
  sectionQuotas = NEWS_SECTION_QUOTAS,
  quotasBySource = NEWS_SOURCE_SECTION_QUOTAS,
  readinessMinimumsBySource,
  maxItemsPerSource,
  requireQuotaReady = true,
} = {}) {
  const documents = validateNewsDocuments(values, { label: "news snapshot documents" });
  const sources = normalizeSourceDefinitions(sourceDefinitions, documents);
  if (!sources.length) throw new Error("No standalone news sources were found");
  const readiness = assertNewsSectionQuotaReadiness(documents, {
    sourceDefinitions: sources,
    sectionQuotas,
    quotasBySource,
    readinessMinimumsBySource,
    throwOnError: requireQuotaReady,
  });
  const mediaIndex = createArticleMediaIndex(documents);
  const selectedBySource = new Map();
  const snapshotSources = {};
  const detailArticles = {};
  const sourceRecords = new Map();
  const categoryRecords = new Map();

  for (const source of sources) {
    const sourceDocuments = documents
      .filter((document) => document.sourceId === source.id && document.language === "ko")
      .sort(compareNewestFirst);
    const assignments = readiness.assignments.get(source.id) || new Map();
    const assignedIds = new Set(assignments.keys());
    const selected = sourceDocuments
      .filter(isFeedCandidate)
      .filter(uniqueBy((document) => document.id))
      .sort(compareNewestFirst);
    const selectionLimit = normalizeOptionalPositiveInteger(maxItemsPerSource);
    if (selectionLimit !== null && selected.length > selectionLimit) {
      throw new Error(
        `${source.id} has ${selected.length} records, exceeding explicit maxItemsPerSource ${selectionLimit}`,
      );
    }
    selectedBySource.set(source.id, selected);
    const records = selected.map((document) => buildSnapshotRecord(document, source, mediaIndex));
    sourceRecords.set(source.id, records);
    const previewRecords = records.filter((record) => assignedIds.has(record.document.id));
    const categoryCounts = {};
    for (const section of sectionIdsForSource(source.id)) {
      const recordsForCategory = records.filter((record) => (
        isSnapshotRecordInSection(record, section)
      )).sort((left, right) => compareNewestFirst(left.document, right.document, section));
      categoryRecords.set(createCategoryKey(source.id, section), recordsForCategory);
      categoryCounts[section] = recordsForCategory.length;
    }
    snapshotSources[source.id] = {
      id: source.id,
      name: source.name,
      totalItems: records.length,
      categoryCounts,
      articles: previewRecords.map((record) => toFeedArticle(record, assignments)),
    };
    for (const record of records) detailArticles[record.document.id] = toDetailArticle(record, assignments);
  }

  const newestDate = [...selectedBySource.values()]
    .flat()
    .map((document) => document.date)
    .sort()
    .at(-1);
  if (!newestDate) throw new Error("No Korean news records were selected");
  const versionMaterial = sources.map((source) => ({
    source: snapshotSources[source.id],
    details: sourceRecords.get(source.id).map((record) => detailArticles[record.document.id]),
  }));
  const version = createHash("sha256")
    .update(`standalone-news-snapshot:${NEWS_SNAPSHOT_SCHEMA_VERSION}\n`)
    .update(stableStringify(versionMaterial))
    .digest("hex")
    .slice(0, 16);

  for (const source of Object.values(snapshotSources)) {
    for (const article of source.articles) {
      article.detailUrl = `/news/document?id=${encodeURIComponent(article.id)}`;
    }
  }
  const generatedAt = `${newestDate}T00:00:00.000Z`;
  const feed = { generatedAt, version, sources: snapshotSources };
  const details = {
    generatedAt,
    version,
    totalItems: Object.keys(detailArticles).length,
    shardCount: NEWS_DETAIL_SHARD_COUNT,
    shardPattern: NEWS_DETAIL_SHARD_PUBLIC_PATTERN,
  };
  const searchArticles = [...sourceRecords.values()]
    .flat()
    .sort((left, right) => compareNewestFirst(left.document, right.document))
    .map(toSearchArticle);
  const searchIndex = {
    schemaVersion: NEWS_SEARCH_INDEX_SCHEMA_VERSION,
    generatedAt,
    version,
    totalItems: searchArticles.length,
    articles: searchArticles,
  };
  const detailShards = buildDetailShards(detailArticles, { generatedAt, version });
  const categoryPages = buildCategoryPages(categoryRecords, sources, readiness.assignments, {
    generatedAt,
    version,
  });
  const imageProxyAllowlist = buildNewsImageProxyAllowlist(detailArticles, { version });
  const detailShardTexts = new Map([...detailShards].map(([shard, payload]) => [
    shard,
    `${JSON.stringify(payload, null, 2)}\n`,
  ]));
  const categoryPageTexts = new Map([...categoryPages].map(([relativePath, payload]) => [
    relativePath,
    `${JSON.stringify(payload, null, 2)}\n`,
  ]));
  return {
    feed,
    details,
    searchIndex,
    feedText: `${JSON.stringify(feed, null, 2)}\n`,
    detailsText: `${JSON.stringify(details, null, 2)}\n`,
    searchIndexText: `${JSON.stringify(searchIndex)}\n`,
    detailShards,
    detailShardTexts,
    categoryPages,
    categoryPageTexts,
    imageProxyAllowlist: imageProxyAllowlist.payload,
    imageProxyAllowlistText: imageProxyAllowlist.text,
    readiness,
    selectedBySource,
  };
}

/**
 * Hash only pairs that are actually published to the browser in this
 * snapshot. Cached assets remain first-choice in clients, while this compact
 * artifact authorizes the exact official fallback URL and its exact referer.
 */
export function buildNewsImageProxyAllowlist(detailArticles, { version } = {}) {
  const pairHashes = new Set();
  const addPair = (imageUrl, refererUrl) => {
    const hash = hashPublishedNewsImagePair(imageUrl, refererUrl);
    if (hash) pairHashes.add(hash);
  };
  for (const article of Object.values(detailArticles || {})) {
    addPair(article?.thumbnailUrl, article?.url);
    for (const image of article?.images || []) {
      addPair(image?.url, image?.refererUrl);
      addPair(image?.thumbnailUrl, image?.refererUrl);
    }
  }
  const hashes = [...pairHashes].sort(compareText);
  const payload = {
    schemaVersion: NEWS_IMAGE_PAIR_HASH_VERSION,
    snapshotVersion: String(version || ""),
    algorithm: NEWS_IMAGE_PAIR_HASH_ALGORITHM,
    pairCount: hashes.length,
    pairHashes: hashes,
  };
  return { payload, text: `${JSON.stringify(payload)}\n` };
}

export const parseNewsJsonl = parseNewsDocumentsJsonl;
export const stringifyNewsJsonl = stringifyNewsDocumentsJsonl;
export const generateNewsSnapshot = buildNewsSnapshot;

function buildDetailShards(detailArticles, { generatedAt, version }) {
  const shards = new Map();
  for (let index = 0; index < NEWS_DETAIL_SHARD_COUNT; index += 1) {
    const shard = index.toString(16).padStart(2, "0");
    shards.set(shard, { generatedAt, version, shard, articles: {} });
  }
  for (const [id, article] of Object.entries(detailArticles)) {
    const shard = newsDetailShardForId(id);
    shards.get(shard).articles[id] = article;
  }
  return shards;
}

function buildCategoryPages(categoryRecords, sources, assignmentsBySource, { generatedAt, version }) {
  const pages = new Map();
  for (const source of sources) {
    const assignments = assignmentsBySource.get(source.id) || new Map();
    for (const section of sectionIdsForSource(source.id)) {
      const records = categoryRecords.get(createCategoryKey(source.id, section)) || [];
      const articles = records.map((record) => {
        const article = toFeedArticle(record, assignments);
        article.detailUrl = `/news/document?id=${encodeURIComponent(article.id)}`;
        return article;
      });
      const totalPages = Math.max(1, Math.ceil(articles.length / NEWS_CATEGORY_PAGE_SIZE));
      for (let page = 1; page <= totalPages; page += 1) {
        const relativePath = `${source.id}/${section}/page-${page}.json`;
        pages.set(relativePath, {
          generatedAt,
          version,
          source: { id: source.id, name: source.name },
          section,
          page,
          pageSize: NEWS_CATEGORY_PAGE_SIZE,
          totalItems: articles.length,
          totalPages,
          articles: articles.slice(
            (page - 1) * NEWS_CATEGORY_PAGE_SIZE,
            page * NEWS_CATEGORY_PAGE_SIZE,
          ),
        });
      }
    }
  }
  return pages;
}

function createCategoryKey(sourceId, section) {
  return `${sourceId}\u0000${section}`;
}

function assertSourceHeadDoesNotRegress(existing, incoming) {
  const incomingSourceIds = new Set(incoming
    .filter((document) => document.mediaType === "article")
    .map((document) => document.sourceId));
  for (const sourceId of incomingSourceIds) {
    const currentHead = newestArticleDate(existing, sourceId);
    const nextHead = newestArticleDate(incoming, sourceId);
    if (currentHead && nextHead && nextHead < currentHead) {
      throw new Error(`Incoming ${sourceId} source head regressed from ${currentHead} to ${nextHead}`);
    }
  }
}

function newestArticleDate(documents, sourceId) {
  return documents
    .filter((document) => document.sourceId === sourceId && document.mediaType === "article")
    .map((document) => document.date)
    .sort()
    .at(-1) || "";
}

function mergeDocumentQuality(current, incoming) {
  return canonicalizeNewsDocument({
    ...current,
    sourceName: incoming.sourceName || current.sourceName,
    language: incoming.language || current.language,
    title: chooseRicherText(current.title, incoming.title),
    date: current.date >= incoming.date ? current.date : incoming.date,
    url: incoming.url || current.url,
    articleId: incoming.articleId || current.articleId,
    articleUrl: incoming.articleUrl || current.articleUrl,
    snippet: chooseRicherText(current.snippet, incoming.snippet),
    body: chooseRicherText(current.body, incoming.body),
    categories: [...current.categories, ...incoming.categories],
    categoryOrders: Object.keys(incoming.categoryOrders).length
      ? incoming.categoryOrders
      : current.categoryOrders,
    thumbnailUrl: incoming.thumbnailUrl || current.thumbnailUrl,
    cachedUrl: incoming.cachedUrl || current.cachedUrl,
    cachedThumbnailUrl: incoming.cachedThumbnailUrl || current.cachedThumbnailUrl,
    displayOrder: incoming.displayOrder ?? current.displayOrder,
  });
}

function selectOfficialSectionRecords(documents, quotas, readinessMinimums, mediaIndex) {
  const assignments = new Map();
  const results = [];
  for (const section of NEWS_SECTION_IDS) {
    const uniqueCandidates = [];
    const seenIds = new Set();
    const seenTitles = new Set();
    const officialOrder = [...documents].sort((left, right) => compareNewestFirst(left, right, section));
    for (const document of officialOrder) {
      if (!isSectionCandidate(document, section, mediaIndex)) continue;
      const titleKey = createTitleIdentity(document.title);
      if (seenIds.has(document.id) || seenTitles.has(titleKey)) continue;
      seenIds.add(document.id);
      seenTitles.add(titleKey);
      uniqueCandidates.push(document);
    }
    const selected = uniqueCandidates.slice(0, quotas[section]);
    for (const document of selected) {
      const currentSections = assignments.get(document.id) || [];
      assignments.set(document.id, [...currentSections, section]);
    }
    results.push({
      section,
      mediaType: SECTION_MEDIA_TYPES[section] || "article",
      count: selected.length,
      minimum: readinessMinimums[section],
      available: uniqueCandidates.length,
    });
  }
  return { assignments, results };
}

function sectionIdsForSource(sourceId) {
  return NEWS_SOURCE_SECTION_IDS[sourceId] || NEWS_SECTION_IDS;
}

function isSectionCandidate(document, section, mediaIndex) {
  if (!document.categories.includes(section)) return false;
  if (document.mediaType !== "article" && (document.articleId || document.articleUrl)) return false;
  if (section === "photo") return hasImage(document, mediaIndex);
  if (section === "video") return hasVideo(document, mediaIndex);
  return document.mediaType === "article";
}

function isSnapshotRecordInSection(record, section) {
  if (!record.document.categories.includes(section)) return false;
  if (section === "photo") return record.images.length > 0;
  if (section === "video") return record.document.mediaType === "video" || record.videos.length > 0;
  return record.document.mediaType === "article";
}

function isFeedCandidate(document) {
  if (document.mediaType === "article") return true;
  if (document.articleId || document.articleUrl) return false;
  if (document.mediaType === "image") return document.categories.includes("photo");
  if (document.mediaType === "video") return document.categories.includes("video");
  return false;
}

function createArticleMediaIndex(documents) {
  const byArticleId = new Map();
  const byArticleUrl = new Map();
  for (const document of documents) {
    if (document.mediaType === "article") continue;
    if (document.articleId) addToMediaIndex(byArticleId, `${document.sourceId}\u0000${document.articleId}`, document);
    if (document.articleUrl) addToMediaIndex(
      byArticleUrl,
      createSourceUrlKey(document.sourceId, document.articleUrl),
      document,
    );
  }
  for (const index of [byArticleId, byArticleUrl]) {
    for (const records of index.values()) records.sort(compareMediaOrder);
  }
  return { byArticleId, byArticleUrl };
}

function addToMediaIndex(index, key, document) {
  const records = index.get(key) || [];
  records.push(document);
  index.set(key, records);
}

function associatedMedia(document, mediaIndex) {
  if (document.mediaType !== "article") return [];
  const byId = mediaIndex.byArticleId.get(`${document.sourceId}\u0000${document.id}`) || [];
  const byUrl = mediaIndex.byArticleUrl.get(createSourceUrlKey(document.sourceId, document.url)) || [];
  return [...byId, ...byUrl].filter(uniqueBy((media) => media.id)).sort(compareMediaOrder);
}

function hasImage(document, mediaIndex) {
  if (document.mediaType === "image") return true;
  if (document.cachedThumbnailUrl || document.thumbnailUrl || document.cachedUrl) return true;
  return associatedMedia(document, mediaIndex).some((media) => media.mediaType === "image");
}

function hasVideo(document, mediaIndex) {
  if (document.mediaType === "video") return true;
  return associatedMedia(document, mediaIndex).some((media) => media.mediaType === "video");
}

function buildSnapshotRecord(document, source, mediaIndex) {
  const media = associatedMedia(document, mediaIndex);
  const images = dedupeDescriptors([
    ...media.filter((item) => item.mediaType === "image").map(toImageDescriptor),
    ...media.filter((item) => item.mediaType === "video").flatMap(imageDescriptorsFromDocument),
    ...imageDescriptorsFromDocument(document),
  ]);
  const videos = media.filter((item) => item.mediaType === "video").map(toVideoDescriptor);
  if (document.mediaType === "image") images.unshift(toImageDescriptor(document));
  if (document.mediaType === "video") videos.unshift(toVideoDescriptor(document));
  const dedupedImages = dedupeDescriptors(images);
  const dedupedVideos = videos.filter(uniqueBy((video) => video.id || video.url));
  const firstImage = dedupedImages[0];
  return {
    document: {
      id: document.id,
      title: document.title,
      date: document.date,
      snippet: document.snippet,
      body: document.body || document.snippet,
      url: document.mediaType === "article" ? document.url : document.articleUrl || document.url,
      mediaType: document.mediaType,
      sourceId: source.id,
      sourceName: source.name,
      categories: document.categories,
      categoryOrders: document.categoryOrders,
    },
    images: dedupedImages,
    videos: dedupedVideos,
    lead: {
      thumbnailUrl: document.thumbnailUrl || firstImage?.thumbnailUrl || firstImage?.url || "",
      cachedThumbnailUrl: document.cachedThumbnailUrl || firstImage?.cachedThumbnailUrl || firstImage?.cachedUrl || "",
    },
  };
}

function toFeedArticle(record, assignments) {
  const { document, images, videos, lead } = record;
  const sections = assignments.get(document.id) || [];
  return {
    id: document.id,
    title: document.title,
    date: document.date,
    snippet: document.snippet,
    url: document.url,
    mediaType: document.mediaType,
    categories: document.categories,
    categoryOrders: document.categoryOrders,
    featuredSections: sections,
    hasImage: images.length > 0,
    hasVideo: document.mediaType === "video" || videos.length > 0,
    thumbnailUrl: lead.thumbnailUrl,
    cachedThumbnailUrl: lead.cachedThumbnailUrl,
    detailUrl: "",
  };
}

function toSearchArticle(record) {
  const { document, lead } = record;
  return {
    id: document.id,
    title: document.title,
    date: document.date,
    sourceId: document.sourceId,
    sourceName: document.sourceName,
    snippet: document.snippet,
    url: document.url,
    thumbnailUrl: lead.thumbnailUrl,
    cachedThumbnailUrl: lead.cachedThumbnailUrl,
    detailUrl: `/news/document?id=${encodeURIComponent(document.id)}`,
  };
}

function toDetailArticle(record, assignments) {
  return {
    ...record.document,
    categories: record.document.categories,
    featuredSections: assignments.get(record.document.id) || [],
    thumbnailUrl: record.lead.thumbnailUrl,
    cachedThumbnailUrl: record.lead.cachedThumbnailUrl,
    images: record.images,
    videos: record.videos,
  };
}

function imageDescriptorsFromDocument(document) {
  if (!document.thumbnailUrl && !document.cachedThumbnailUrl && !document.cachedUrl) return [];
  return [{
    id: `${document.id}:lead`,
    url: document.thumbnailUrl,
    cachedUrl: document.cachedUrl,
    thumbnailUrl: document.thumbnailUrl,
    cachedThumbnailUrl: document.cachedThumbnailUrl || document.cachedUrl,
    refererUrl: document.mediaType === "article" ? document.url : document.articleUrl,
    displayOrder: document.displayOrder,
  }];
}

function toImageDescriptor(document) {
  const originUrl = resolveOfficialImageOriginUrl(document);
  return {
    id: document.id,
    url: originUrl || document.thumbnailUrl,
    cachedUrl: document.cachedUrl,
    thumbnailUrl: document.thumbnailUrl || originUrl,
    cachedThumbnailUrl: document.cachedThumbnailUrl || document.cachedUrl,
    refererUrl: document.articleUrl,
    displayOrder: document.displayOrder,
  };
}

function toVideoDescriptor(document) {
  return {
    id: document.id,
    url: document.url,
    title: document.title,
    displayOrder: document.displayOrder,
  };
}

function dedupeDescriptors(values) {
  return values
    .filter(Boolean)
    .sort((left, right) => left.displayOrder - right.displayOrder || compareText(left.id, right.id))
    .filter(uniqueBy((descriptor) => (
      descriptor.cachedUrl || descriptor.cachedThumbnailUrl || descriptor.url || descriptor.thumbnailUrl
    )));
}

function normalizeSourceDefinitions(sourceDefinitions, documents) {
  const knownNames = new Map(DEFAULT_NEWS_SOURCE_DEFINITIONS.map((source) => [source.id, source.name]));
  const documentNames = new Map(documents.map((document) => [document.sourceId, document.sourceName]));
  const definitions = sourceDefinitions || [...new Set(documents.map((document) => document.sourceId))]
    .sort((left, right) => {
      const leftKnown = DEFAULT_NEWS_SOURCE_DEFINITIONS.findIndex((source) => source.id === left);
      const rightKnown = DEFAULT_NEWS_SOURCE_DEFINITIONS.findIndex((source) => source.id === right);
      return (leftKnown < 0 ? 999 : leftKnown) - (rightKnown < 0 ? 999 : rightKnown)
        || compareText(left, right);
    })
    .map((id) => ({ id, name: knownNames.get(id) || documentNames.get(id) || id }));
  const seen = new Set();
  return definitions.map((source, index) => {
    const id = normalizeText(source?.id).toLocaleLowerCase("en-US");
    const name = normalizeText(source?.name || documentNames.get(id) || knownNames.get(id));
    if (!SOURCE_ID_PATTERN.test(id) || !name) throw new Error(`Invalid news source definition at index ${index}`);
    if (seen.has(id)) throw new Error(`Duplicate news source definition: ${id}`);
    seen.add(id);
    return { id, name };
  });
}

function normalizeSectionQuotas(value) {
  const unknown = Object.keys(value || {}).filter((key) => !NEWS_SECTION_IDS.includes(key));
  if (unknown.length) throw new Error(`Unknown news section quota(s): ${unknown.join(", ")}`);
  return Object.fromEntries(NEWS_SECTION_IDS.map((section) => [
    section,
    normalizeNonNegativeInteger(value?.[section] ?? NEWS_SECTION_QUOTAS[section]),
  ]));
}

function normalizeCategories(value) {
  const values = Array.isArray(value) ? value : [];
  const unique = new Set(values.map((item) => normalizeText(item)).filter(Boolean));
  return NEWS_SECTION_IDS.filter((category) => unique.has(category));
}

function normalizeCategoryOrders(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(NEWS_SECTION_IDS.flatMap((category) => {
    const order = value[category];
    return Number.isSafeInteger(order) && order >= 0 ? [[category, order]] : [];
  }));
}

function normalizeRemoteUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    if (!/^https?:$/u.test(url.protocol)) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeAssociationUrl(value) {
  const url = normalizeRemoteUrl(value);
  if (!url) return "";
  const parsed = new URL(url);
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.toString();
}

function normalizeLocalAssetUrl(value) {
  const candidate = String(value || "").trim();
  return isLocalNewsAssetUrl(candidate) ? candidate : "";
}

export function isLocalNewsAssetUrl(value) {
  const candidate = String(value || "").trim();
  if (!LOCAL_ASSET_PATTERN.test(candidate) || candidate.includes("//") || candidate.includes("\\")) return false;
  try {
    return !decodeURIComponent(candidate).split("/").includes("..");
  } catch {
    return false;
  }
}

function isLikelyImageUrl(value) {
  try {
    return /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/iu.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function resolveOfficialImageOriginUrl(document) {
  const candidate = normalizeRemoteUrl(document?.url);
  if (!candidate || document?.mediaType !== "image") return "";
  // Rodong uses the same index.php route for lists, articles, videos, and
  // binary media.  An exact decoded image token is authoritative even when a
  // photo-only record necessarily uses its first image as the synthetic
  // parent URL as well.
  if (parseOfficialNewsImageUrl(candidate)) return candidate;
  if (
    document.articleUrl
    && normalizeAssociationUrl(candidate) === normalizeAssociationUrl(document.articleUrl)
  ) return "";
  if (isLikelyImageUrl(candidate)) return candidate;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLocaleLowerCase("en-US");
    if (
      document.sourceId === "kcna"
      && (host === "kcna.kp" || host === "www.kcna.kp")
      && /^\/photo\/[a-f0-9]{32,128}$/iu.test(url.pathname)
      && !url.search
    ) return candidate;
  } catch {
    return "";
  }
  return "";
}

function isIsoDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function createDocumentIdentity(document) {
  const remoteUrl = normalizeAssociationUrl(document.url);
  if (document.mediaType === "article") {
    return `${document.sourceId}\u0000${document.mediaType}\u0000${remoteUrl}`;
  }
  const articleUrl = normalizeAssociationUrl(document.articleUrl);
  const association = articleUrl || `id:${document.articleId}`;
  const originalAssetUrl = remoteUrl && remoteUrl !== articleUrl ? remoteUrl : "";
  const thumbnailAssetUrl = normalizeAssociationUrl(document.thumbnailUrl);
  const cachedAssetUrl = document.cachedUrl || document.cachedThumbnailUrl;
  const asset = originalAssetUrl || thumbnailAssetUrl || cachedAssetUrl || document.mediaType;
  return [
    document.sourceId,
    document.mediaType,
    association,
    asset,
    `slot:${document.displayOrder}`,
  ].join("\u0000");
}

function createSourceUrlKey(sourceId, url) {
  return `${sourceId}\u0000${normalizeAssociationUrl(url)}`;
}

function createTitleIdentity(value) {
  return normalizeText(value).normalize("NFKC").toLocaleLowerCase("ko-KR");
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizeTitle(value, { sourceId = "", body = "" } = {}) {
  const title = String(value || "")
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .split(/\n+/u)
    .map((line) => line.replace(/[\t\u00a0 ]+/gu, " ").trim())
    .filter(Boolean)
    .join("\n");
  if (sourceId !== "rodong-sinmun" || title.includes("\n")) return title;

  const pageSuffixMatch = title.match(/\s+(\[[1-9]\d*면\])$/u);
  const comparableTitle = pageSuffixMatch
    ? title.slice(0, -pageSuffixMatch[0].length)
    : title;
  const pageSuffix = pageSuffixMatch ? ` ${pageSuffixMatch[1]}` : "";

  const leadingParagraphs = String(body || "")
    .split(/\n+/u)
    .map((paragraph) => normalizeText(paragraph))
    .filter(Boolean)
    .slice(0, 5);
  for (let lineCount = 2; lineCount <= leadingParagraphs.length; lineCount += 1) {
    const lines = leadingParagraphs.slice(0, lineCount);
    if (comparableTitle === lines.join("")) return `${lines.join("\n")}${pageSuffix}`;
  }
  return title;
}

function normalizeBody(value) {
  return String(value || "").normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
}

function chooseRicherText(left, right) {
  const current = String(left || "");
  const incoming = String(right || "");
  return normalizeText(incoming).length >= normalizeText(current).length ? incoming : current;
}

function normalizeDisplayOrder(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function normalizeOptionalPositiveInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Invalid maxItemsPerSource: ${value}`);
  }
  return number;
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`Invalid non-negative quota: ${value}`);
  return number;
}

function compareCanonicalDocuments(left, right) {
  return compareText(left.sourceId, right.sourceId)
    || compareNewestFirst(left, right)
    || compareText(left.mediaType, right.mediaType);
}

function compareNewestFirst(left, right, section = "") {
  return compareText(right.date, left.date)
    || compareCategoryOrder(left, right, section)
    || compareText(left.id, right.id);
}

function compareCategoryOrder(left, right, section) {
  const leftOrder = categoryOrderValue(left, section);
  const rightOrder = categoryOrderValue(right, section);
  return leftOrder - rightOrder;
}

function categoryOrderValue(document, section) {
  const orders = isPlainObject(document?.categoryOrders) ? document.categoryOrders : {};
  if (section) {
    return Number.isSafeInteger(orders[section]) && orders[section] >= 0
      ? orders[section]
      : Number.MAX_SAFE_INTEGER;
  }
  const values = Object.values(orders).filter((value) => Number.isSafeInteger(value) && value >= 0);
  return values.length ? Math.min(...values) : Number.MAX_SAFE_INTEGER;
}

function compareMediaOrder(left, right) {
  return left.displayOrder - right.displayOrder || compareText(left.id, right.id);
}

function compareText(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueBy(getKey) {
  const seen = new Set();
  return (value) => {
    const key = getKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
