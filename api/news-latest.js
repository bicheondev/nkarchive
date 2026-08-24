import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KCNA_CATEGORY_LISTS,
  RODONG_CATEGORY_LABELS,
  buildRodongHtmlFallbackUrl,
  fetchBoundedHtml,
  parseKcnaListing,
  parseRodongHomepageCategories,
  parseRodongListing,
} from "../scripts/news-mirror-crawler.ts";

const PUBLIC_ORIGIN = "https://nkarchive.vercel.app";
const RODONG_HOME_URL = "http://www.rodong.rep.kp/ko/";
const RODONG_ORIGIN = new URL(RODONG_HOME_URL).origin;
const KCNA_ORIGIN = "http://www.kcna.kp";
const KCNA_LIST_URLS = new Set(KCNA_CATEGORY_LISTS.map((category) => category.url));
const STATIC_FEED_PATH = fileURLToPath(new URL("../data/news-feed.json", import.meta.url));
const STATIC_SEARCH_INDEX_PATH = fileURLToPath(new URL("../data/news/search-index.json", import.meta.url));
const CACHE_CONTROL = "public, max-age=0, s-maxage=300, stale-while-revalidate=3600";
const SOURCE_NAMES = Object.freeze({
  kcna: "조선중앙통신",
  "rodong-sinmun": "로동신문",
});
const ALLOWED_SOURCE_IDS = Object.freeze(Object.keys(SOURCE_NAMES));
const RESPONSE_SCHEMA_VERSION = 1;
const MAX_ARTICLES_PER_SOURCE = 256;
const MAX_ENTRIES_PER_LISTING = 20;
const MAX_RODONG_CATEGORIES = 8;
const RODONG_EXPECTED_CATEGORY_COUNT = new Set(Object.values(RODONG_CATEGORY_LABELS)).size;
const SOURCE_REFRESH_DEADLINE_MS = 24_000;
const SOURCE_REFRESH_CACHE_MS = 5 * 60 * 1_000;
const KCNA_FETCH_OPTIONS = Object.freeze({
  // The official video list currently renders just under 600 KiB through
  // the fixed HTML fallback, while the other lists are substantially smaller.
  htmlMaxBytes: 768 * 1024,
  maxRedirects: 2,
});
const KCNA_DIRECT_TIMEOUT_MS = 3_500;
const KCNA_FALLBACK_TIMEOUT_MS = 6_000;
const RODONG_FETCH_OPTIONS = Object.freeze({
  htmlMaxBytes: 4 * 1024 * 1024,
  maxRedirects: 2,
});
const RODONG_DIRECT_TIMEOUT_MS = 4_000;
const RODONG_FALLBACK_TIMEOUT_MS = 6_000;
const runKcnaDirect = createAsyncLimiter(3, { maximumQueueWaitMs: 12_000 });
const runJinaFallback = createAsyncLimiter(3, { maximumQueueWaitMs: 12_000 });

let defaultStaticFeed;
let defaultStaticSearchIndex;
let defaultNewsLatestHandler;
const defaultSourceRefreshes = new Map();

export default async function handler(request, response) {
  defaultNewsLatestHandler ||= createNewsLatestHandler({ refreshSourceImpl: getCachedDefaultSourceRefresh });
  return defaultNewsLatestHandler(request, response);
}

export function createNewsLatestHandler({
  fetchHtmlImpl = fetchBoundedHtml,
  staticFeed = loadDefaultStaticFeed(),
  staticSearchIndex = loadDefaultStaticSearchIndex(),
  now = () => new Date(),
  refreshSourceImpl = fetchSourceLatest,
  refreshDeadlineMs = SOURCE_REFRESH_DEADLINE_MS,
} = {}) {
  const fallbackSources = normalizeStaticSources(staticFeed);
  const publishedByUrl = normalizePublishedIndex(staticSearchIndex, fallbackSources);
  const boundedRefreshDeadlineMs = normalizeRefreshDeadline(refreshDeadlineMs);

  return async function newsLatestHandler(request, response) {
    const method = String(request?.method || "GET").toLocaleUpperCase("en-US");
    if (method !== "GET" && method !== "HEAD") {
      sendJson(response, {
        method,
        statusCode: 405,
        payload: { error: "method_not_allowed" },
        cacheControl: "no-store",
        headers: { Allow: "GET, HEAD" },
      });
      return;
    }

    const sourceIds = parseExactSourceQuery(request);
    if (!sourceIds) {
      sendJson(response, {
        method,
        statusCode: 400,
        payload: { error: "invalid_news_latest_query" },
        cacheControl: "no-store",
      });
      return;
    }

    if (method === "HEAD") {
      sendJson(response, {
        method,
        statusCode: 200,
        payload: {},
        cacheControl: CACHE_CONTROL,
      });
      return;
    }

    const generatedAt = normalizeNow(now()).toISOString();
    const settled = await Promise.allSettled(sourceIds.map((sourceId) => withDeadline(
      Promise.resolve().then(() => refreshSourceImpl(sourceId, { fetchHtmlImpl })),
      boundedRefreshDeadlineMs,
    )));
    const sources = {};
    for (let index = 0; index < sourceIds.length; index += 1) {
      const sourceId = sourceIds[index];
      const fallbackArticles = fallbackSources[sourceId]?.articles || [];
      const result = settled[index];
      const refresh = result.status === "fulfilled"
        ? result.value
        : { complete: false, entries: [] };
      const liveEntries = refresh.entries;
      const mode = !liveEntries.length ? "fallback" : refresh.complete ? "live" : "degraded";
      const articles = liveEntries.length
        ? mergeLiveAndFallbackArticles(sourceId, liveEntries, fallbackArticles, publishedByUrl)
        : fallbackArticles.slice(0, MAX_ARTICLES_PER_SOURCE).map((article) => ({ ...article, archived: true }));
      sources[sourceId] = {
        id: sourceId,
        name: SOURCE_NAMES[sourceId],
        mode,
        articles,
      };
    }

    sendJson(response, {
      method,
      statusCode: 200,
      payload: {
        schemaVersion: RESPONSE_SCHEMA_VERSION,
        generatedAt,
        cacheSeconds: 300,
        sources,
      },
      cacheControl: CACHE_CONTROL,
    });
  };
}

function fetchSourceLatest(sourceId, { fetchHtmlImpl = fetchBoundedHtml } = {}) {
  if (sourceId === "kcna") return fetchKcnaLatest({ fetchHtmlImpl });
  if (sourceId === "rodong-sinmun") return fetchRodongLatest({ fetchHtmlImpl });
  return Promise.reject(new Error("invalid_news_latest_source"));
}

function getCachedDefaultSourceRefresh(sourceId, options) {
  const timestamp = Date.now();
  const cached = defaultSourceRefreshes.get(sourceId);
  if (cached && cached.expiresAt > timestamp) return cached.promise;
  const promise = Promise.resolve().then(() => fetchSourceLatest(sourceId, options));
  // Retain both success and failure for the same five-minute freshness window;
  // the public fallback response is cached for the same interval and should not
  // trigger a warm-instance retry stampede through a different query shape.
  promise.catch(() => {});
  defaultSourceRefreshes.set(sourceId, {
    expiresAt: timestamp + SOURCE_REFRESH_CACHE_MS,
    promise,
  });
  return promise;
}

export async function fetchKcnaLatest({ fetchHtmlImpl = fetchBoundedHtml } = {}) {
  const results = await Promise.allSettled(KCNA_CATEGORY_LISTS.map(async (category) => {
    const html = await fetchKcnaOfficialHtml(
      category.url,
      fetchHtmlImpl,
      runKcnaDirect,
      runJinaFallback,
    );
    return parseKcnaListing(html, category.url, category).entries
      .slice(0, MAX_ENTRIES_PER_LISTING)
      .map((entry, index) => ({
        ...entry,
        categoryOrders: { [category.id]: index },
        featuredSections: [category.id],
      }));
  }));
  return {
    complete: results.every((result) => result.status === "fulfilled" && result.value.length > 0),
    entries: mergeListingEntries(results.flatMap((result) => result.status === "fulfilled" ? result.value : [])),
  };
}

async function fetchKcnaOfficialHtml(url, fetchHtmlImpl, directLimiter, fallbackLimiter) {
  const officialUrl = new URL(String(url || ""));
  if (officialUrl.origin !== KCNA_ORIGIN
    || officialUrl.username
    || officialUrl.password
    || officialUrl.port
    || !KCNA_LIST_URLS.has(officialUrl.href)) {
    throw new Error("invalid_kcna_latest_url");
  }
  try {
    return await directLimiter(() => fetchHtmlImpl(officialUrl.href, {
      ...KCNA_FETCH_OPTIONS,
      timeoutMs: KCNA_DIRECT_TIMEOUT_MS,
    }));
  } catch (directError) {
    const fallbackUrl = `https://r.jina.ai/${officialUrl.href}`;
    try {
      return await fallbackLimiter(() => fetchHtmlImpl(fallbackUrl, {
        ...KCNA_FETCH_OPTIONS,
        extraHeaders: { "X-Return-Format": "html" },
        timeoutMs: KCNA_FALLBACK_TIMEOUT_MS,
      }));
    } catch {
      throw directError;
    }
  }
}

export async function fetchRodongLatest({ fetchHtmlImpl = fetchBoundedHtml } = {}) {
  const homepageHtml = await fetchRodongOfficialHtml(RODONG_HOME_URL, fetchHtmlImpl, runJinaFallback);
  const categories = parseRodongHomepageCategories(
    homepageHtml,
    RODONG_HOME_URL,
    RODONG_CATEGORY_LABELS,
  ).filter(isAllowedRodongCategory).slice(0, MAX_RODONG_CATEGORIES);
  if (!categories.length) throw new Error("rodong_latest_categories_unavailable");
  const results = await Promise.allSettled(categories.map(async (category) => {
    const html = await fetchRodongOfficialHtml(category.url, fetchHtmlImpl, runJinaFallback);
    return parseRodongListing(html, category.url, category).entries
      .slice(0, MAX_ENTRIES_PER_LISTING)
      .map((entry, index) => ({
        ...entry,
        categoryOrders: { [category.id]: index },
        featuredSections: [category.id],
      }));
  }));
  return {
    complete: categories.length === RODONG_EXPECTED_CATEGORY_COUNT
      && results.every((result) => result.status === "fulfilled" && result.value.length > 0),
    entries: mergeListingEntries(results.flatMap((result) => result.status === "fulfilled" ? result.value : [])),
  };
}

async function fetchRodongOfficialHtml(url, fetchHtmlImpl, fallbackLimiter) {
  const officialUrl = new URL(String(url || ""));
  if (officialUrl.origin !== RODONG_ORIGIN || officialUrl.username || officialUrl.password || officialUrl.port) {
    throw new Error("invalid_rodong_latest_url");
  }
  try {
    return await fetchHtmlImpl(officialUrl.href, {
      ...RODONG_FETCH_OPTIONS,
      timeoutMs: RODONG_DIRECT_TIMEOUT_MS,
    });
  } catch (directError) {
    const fallbackUrl = buildRodongHtmlFallbackUrl(officialUrl.href);
    try {
      return await fallbackLimiter(() => fetchHtmlImpl(fallbackUrl, {
        ...RODONG_FETCH_OPTIONS,
        extraHeaders: { "X-Return-Format": "html" },
        timeoutMs: RODONG_FALLBACK_TIMEOUT_MS,
      }));
    } catch {
      throw directError;
    }
  }
}

function isAllowedRodongCategory(category) {
  if (!category || !Object.values(RODONG_CATEGORY_LABELS).includes(String(category.id || ""))) return false;
  try {
    const url = new URL(String(category.url || ""));
    return url.origin === RODONG_ORIGIN
      && !url.username
      && !url.password
      && !url.port
      && url.pathname === "/ko/index.php";
  } catch {
    return false;
  }
}

function createAsyncLimiter(maximumConcurrency, { maximumQueueWaitMs = 12_000 } = {}) {
  const limit = Number(maximumConcurrency);
  const queueWaitMs = Number(maximumQueueWaitMs);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid_news_latest_concurrency");
  if (!Number.isSafeInteger(queueWaitMs) || queueWaitMs < 1 || queueWaitMs > SOURCE_REFRESH_DEADLINE_MS) {
    throw new Error("invalid_news_latest_queue_wait");
  }
  let active = 0;
  const waiters = [];
  const acquire = () => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("news_latest_queue_timeout"));
      }, queueWaitMs);
      waiters.push(waiter);
    });
  };
  const release = () => {
    const next = waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    }
    else active -= 1;
  };
  return async function run(task) {
    if (typeof task !== "function") throw new Error("invalid_news_latest_task");
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function withDeadline(value, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("news_latest_refresh_timeout")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function normalizeRefreshDeadline(value) {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SOURCE_REFRESH_DEADLINE_MS) {
    throw new Error("invalid_news_latest_refresh_deadline");
  }
  return timeoutMs;
}

export function mergeLiveAndFallbackArticles(sourceId, liveEntries, fallbackArticles, publishedByUrl = new Map()) {
  const liveArticles = mergeListingEntries(liveEntries).map((entry) => {
    const archived = publishedByUrl.get(canonicalUrl(entry.url))
      || fallbackArticles.find((article) => canonicalUrl(article.url) === canonicalUrl(entry.url));
    return archived
      ? {
        ...archived,
        sourceId,
        sourceName: SOURCE_NAMES[sourceId],
        mediaType: archived.mediaType || entry.mediaType,
        categories: mergeCategories(archived.categories, entry.categories),
        categoryOrders: mergeCategoryOrders(archived.categoryOrders, entry.categoryOrders),
        featuredSections: mergeCategories(archived.featuredSections, entry.featuredSections, entry.categories),
        hasImage: archived.hasImage || entry.hasImage,
        hasVideo: archived.hasVideo || entry.hasVideo,
        archived: true,
      }
      : makeLivePreview(sourceId, entry);
  });
  const seenUrls = new Set(liveArticles.map((article) => canonicalUrl(article.url)));
  const combined = [
    ...liveArticles,
    ...fallbackArticles
      .filter((article) => !seenUrls.has(canonicalUrl(article.url)))
      .map((article) => ({ ...article, archived: true })),
  ];
  combined.sort(compareLatestArticles);
  return combined.slice(0, MAX_ARTICLES_PER_SOURCE);
}

function mergeListingEntries(entries) {
  const byUrl = new Map();
  for (const rawEntry of Array.isArray(entries) ? entries : []) {
    const entry = normalizeListingEntry(rawEntry);
    if (!entry) continue;
    const key = canonicalUrl(entry.url);
    const current = byUrl.get(key);
    if (!current) {
      byUrl.set(key, entry);
      continue;
    }
    byUrl.set(key, {
      ...current,
      categories: mergeCategories(current.categories, entry.categories),
      categoryOrders: mergeCategoryOrders(current.categoryOrders, entry.categoryOrders),
      featuredSections: mergeCategories(current.featuredSections, entry.featuredSections, entry.categories),
      hasImage: current.hasImage || entry.hasImage,
      hasVideo: current.hasVideo || entry.hasVideo,
    });
  }
  return [...byUrl.values()].sort(compareLatestArticles);
}

function normalizeListingEntry(value) {
  const sourceId = String(value?.sourceId || "");
  if (!ALLOWED_SOURCE_IDS.includes(sourceId)) return null;
  const title = normalizeTitle(value?.title);
  const date = String(value?.date || "");
  const url = canonicalUrl(value?.url);
  if (!title || !/^20\d{2}-\d{2}-\d{2}$/u.test(date) || !isOfficialArticleUrl(sourceId, url)) return null;
  const kind = String(value?.kind || (value?.mediaType === "image" ? "photo" : value?.mediaType) || "article");
  return {
    sourceId,
    title,
    date,
    url,
    mediaType: kind === "photo" ? "image" : kind === "video" ? "video" : "article",
    categories: mergeCategories(value?.categories, [value?.category?.id]),
    categoryOrders: mergeCategoryOrders(value?.categoryOrders),
    featuredSections: mergeCategories(value?.featuredSections, value?.categories, [value?.category?.id]),
    hasImage: value?.hasImage === true || value?.markers?.camera === true || kind === "photo",
    hasVideo: value?.hasVideo === true || kind === "video",
  };
}

function makeLivePreview(sourceId, entry) {
  const id = `news:${sourceId}:${createHash("sha256").update(entry.url).digest("hex").slice(0, 24)}`;
  return {
    id,
    sourceId,
    sourceName: SOURCE_NAMES[sourceId],
    title: entry.title,
    date: entry.date,
    snippet: "",
    url: entry.url,
    mediaType: entry.mediaType,
    categories: entry.categories,
    categoryOrders: entry.categoryOrders,
    featuredSections: mergeCategories(entry.featuredSections, entry.categories),
    hasImage: entry.hasImage,
    hasVideo: entry.hasVideo,
    thumbnailUrl: "",
    cachedThumbnailUrl: "",
    detailUrl: entry.url,
    archived: false,
  };
}

function normalizeStaticSources(feed) {
  const sources = {};
  for (const sourceId of ALLOWED_SOURCE_IDS) {
    const rawArticles = Array.isArray(feed?.sources?.[sourceId]?.articles)
      ? feed.sources[sourceId].articles
      : [];
    const articles = rawArticles.flatMap((article) => {
      const normalized = normalizeStaticArticle(sourceId, article);
      return normalized ? [normalized] : [];
    });
    articles.sort(compareLatestArticles);
    sources[sourceId] = { articles };
  }
  return sources;
}

function normalizeStaticArticle(sourceId, value) {
  const id = String(value?.id || "");
  const title = normalizeTitle(value?.title);
  const date = String(value?.date || "");
  const url = canonicalUrl(value?.url);
  if (!isPublishedIdForSource(id, sourceId)
    || !title
    || !/^20\d{2}-\d{2}-\d{2}$/u.test(date)
    || !isOfficialArticleUrl(sourceId, url)) return null;
  return {
    id,
    sourceId,
    sourceName: SOURCE_NAMES[sourceId],
    title,
    date,
    snippet: normalizeInlineText(value?.snippet),
    url,
    mediaType: ["article", "image", "video"].includes(value?.mediaType) ? value.mediaType : "article",
    categories: mergeCategories(value?.categories),
    categoryOrders: normalizeCategoryOrders(value?.categoryOrders),
    featuredSections: mergeCategories(value?.featuredSections),
    hasImage: value?.hasImage === true,
    hasVideo: value?.hasVideo === true,
    thumbnailUrl: normalizeHttpUrl(value?.thumbnailUrl),
    cachedThumbnailUrl: normalizeCachedThumbnail(value?.cachedThumbnailUrl),
    detailUrl: `/news/document?id=${encodeURIComponent(id)}`,
  };
}

function normalizePublishedIndex(searchIndex, fallbackSources) {
  const publishedByUrl = new Map();
  const searchArticles = Array.isArray(searchIndex?.articles) ? searchIndex.articles : [];
  for (const value of searchArticles) {
    const sourceId = String(value?.sourceId || "");
    if (!ALLOWED_SOURCE_IDS.includes(sourceId)) continue;
    const id = String(value?.id || "");
    const title = normalizeTitle(value?.title);
    const date = String(value?.date || "");
    const url = canonicalUrl(value?.url);
    if (!isPublishedIdForSource(id, sourceId)
      || !title
      || !/^20\d{2}-\d{2}-\d{2}$/u.test(date)
      || !isOfficialArticleUrl(sourceId, url)) continue;
    publishedByUrl.set(url, {
      id,
      sourceId,
      sourceName: SOURCE_NAMES[sourceId],
      title,
      date,
      snippet: normalizeInlineText(value?.snippet),
      url,
      mediaType: "",
      categories: [],
      categoryOrders: {},
      featuredSections: [],
      hasImage: Boolean(value?.thumbnailUrl || value?.cachedThumbnailUrl),
      hasVideo: false,
      thumbnailUrl: normalizeHttpUrl(value?.thumbnailUrl),
      cachedThumbnailUrl: normalizeCachedThumbnail(value?.cachedThumbnailUrl),
      detailUrl: `/news/document?id=${encodeURIComponent(id)}`,
    });
  }
  for (const sourceId of ALLOWED_SOURCE_IDS) {
    for (const article of fallbackSources[sourceId]?.articles || []) {
      publishedByUrl.set(canonicalUrl(article.url), { ...publishedByUrl.get(canonicalUrl(article.url)), ...article });
    }
  }
  return publishedByUrl;
}

function normalizeCategoryOrders(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, order] of Object.entries(value)) {
    if (/^[a-z][a-z-]{1,31}$/u.test(key) && Number.isSafeInteger(order) && order >= 0) result[key] = order;
  }
  return result;
}

function mergeCategoryOrders(...values) {
  const result = {};
  for (const value of values) {
    for (const [category, order] of Object.entries(normalizeCategoryOrders(value))) {
      result[category] = Object.hasOwn(result, category) ? Math.min(result[category], order) : order;
    }
  }
  return result;
}

function mergeCategories(...values) {
  const result = [];
  for (const value of values) {
    for (const category of Array.isArray(value) ? value : []) {
      const normalized = String(category || "");
      if (/^[a-z][a-z-]{1,31}$/u.test(normalized) && !result.includes(normalized)) result.push(normalized);
    }
  }
  return result;
}

function compareLatestArticles(left, right) {
  return String(right?.date || "").localeCompare(String(left?.date || ""), "en")
    || String(left?.title || "").localeCompare(String(right?.title || ""), "ko");
}

function isOfficialArticleUrl(sourceId, value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port) return false;
    if (sourceId === "kcna") {
      return url.origin === "http://www.kcna.kp"
        && /^\/kp\/(?:article|gallery|video)\/detail\/[a-f0-9]{32}$/u.test(url.pathname)
        && !url.search;
    }
    return url.origin === RODONG_ORIGIN && url.pathname === "/ko/index.php" && /^\?[A-Za-z0-9+/]+={0,2}$/u.test(url.search);
  } catch {
    return false;
  }
}

function isPublishedIdForSource(id, sourceId) {
  if (/^news:(?:kcna|rodong-sinmun):[a-f0-9]{24}$/u.test(id)) return id.startsWith(`news:${sourceId}:`);
  return sourceId === "kcna" && /^kcna-[a-f0-9]{16}$/u.test(id);
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/u.test(url.protocol)) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function normalizeHttpUrl(value) {
  const url = canonicalUrl(value);
  return url || "";
}

function normalizeCachedThumbnail(value) {
  const normalized = String(value || "");
  return /^\/data\/news\/assets\/(?:kcna|rodong-sinmun)\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u.test(normalized)
    ? normalized
    : "";
}

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/gu, " ")
    .replace(/[\t ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .trim()
    .slice(0, 500);
}

function normalizeInlineText(value) {
  return normalizeTitle(value).replace(/\s+/gu, " ").slice(0, 500);
}

function parseExactSourceQuery(request) {
  try {
    const url = new URL(String(request?.url || "/api/news-latest"), PUBLIC_ORIGIN);
    if (!url.search) return [...ALLOWED_SOURCE_IDS];
    if (url.search === "?source=kcna") return ["kcna"];
    if (url.search === "?source=rodong-sinmun") return ["rodong-sinmun"];
    return null;
  } catch {
    return null;
  }
}

function loadDefaultStaticFeed() {
  if (defaultStaticFeed !== undefined) return defaultStaticFeed;
  try {
    defaultStaticFeed = JSON.parse(fs.readFileSync(STATIC_FEED_PATH, "utf8"));
  } catch {
    defaultStaticFeed = { sources: {} };
  }
  return defaultStaticFeed;
}

function loadDefaultStaticSearchIndex() {
  if (defaultStaticSearchIndex !== undefined) return defaultStaticSearchIndex;
  try {
    defaultStaticSearchIndex = JSON.parse(fs.readFileSync(STATIC_SEARCH_INDEX_PATH, "utf8"));
  } catch {
    defaultStaticSearchIndex = { articles: [] };
  }
  return defaultStaticSearchIndex;
}

function normalizeNow(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_news_latest_time");
  return date;
}

function sendJson(response, { method, statusCode, payload, cacheControl, headers = {} }) {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", cacheControl);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(method === "HEAD" ? "" : body);
}
