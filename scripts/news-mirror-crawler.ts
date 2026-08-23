#!/usr/bin/env node
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { parseRodongNewsImageToken } from "../lib/news-image-policy.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(MODULE_DIR, "..");

export const NEWS_MIRROR_SCHEMA_VERSION = 1;
export const DEFAULT_NEWS_ASSET_DIR = path.join(PROJECT_DIR, "data/news/assets");
export const DEFAULT_NEWS_PUBLIC_ASSET_BASE = "/data/news/assets";

const KCNA_ORIGIN = "http://www.kcna.kp";
const RODONG_HOME_URL = "http://www.rodong.rep.kp/ko/";
const RODONG_ORIGIN = new URL(RODONG_HOME_URL).origin;
const RODONG_JINA_ORIGIN = "https://r.jina.ai";
const DEFAULT_HTML_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_RODONG_DETAIL_HTML_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_IMAGES_PER_DOCUMENT = 100;
const DEFAULT_MAX_IMAGES_PER_CRAWL = 512;
const DEFAULT_MAX_IMAGE_BYTES_PER_CRAWL = 256 * 1024 * 1024;
const DEFAULT_IMAGE_RETRY_ATTEMPTS = 2;
const DEFAULT_IMAGE_RETRY_DELAY_MS = 100;
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_LIST_PAGES = 8;
const DEFAULT_MAX_DOCUMENTS = 260;
const DEFAULT_MAX_DOCUMENTS_PER_CATEGORY = 10_000;
const DEFAULT_DETAIL_CONCURRENCY = 4;
const DEFAULT_IMAGE_CONCURRENCY = 3;
const DEFAULT_LISTING_RETRY_ATTEMPTS = 2;
const DEFAULT_RODONG_LISTING_RETRY_ATTEMPTS = 4;
const DEFAULT_DETAIL_RETRY_ATTEMPTS = 2;
const DEFAULT_RECENT_DETAIL_DAYS = 7;
const DEFAULT_NODE_ADDRESS_ATTEMPT_MS = 4_000;
const SUSPICIOUS_SHARED_IMAGE_SET_MINIMUM = 8;
const MAX_MISSING_IMAGE_DIAGNOSTIC_SAMPLES = 20;
const MAX_KCNA_GALLERY_ROOT_CANDIDATES = 64;
const NODE_DNS_CACHE_MS = 10 * 60 * 1_000;
const NODE_ADDRESS_AFFINITY_MS = 30 * 60 * 1_000;
const NEWS_USER_AGENT = "DPRKArchiveNewsMirror/2.0 (+https://nkarchive.vercel.app/news)";
const RODONG_AJAX_QUERY = "MDVAQEBA";
const RODONG_AJAX_MAX_FORM_BYTES = 16 * 1024;
const RODONG_AJAX_VIEW_WIDTH = 1_200;
const RODONG_AJAX_VIEW_HEIGHT = 800;
const RODONG_LARGE_DETAIL_DATA_RATIO = 0.75;
const nodeDnsCache = new Map();
const nodeAddressAffinity = new Map();

/**
 * The identifiers are KCNA's own stable Korean list identifiers. These are
 * deliberately explicit: the news mirror never derives its corpus from a
 * query endpoint or another product's index.
 */
export const KCNA_CATEGORY_LISTS = Object.freeze([
  Object.freeze({ id: "leadership", label: "혁명활동소식", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/b0721b9f23054ddc7fe56c2811a12715` }),
  Object.freeze({ id: "important", label: "중요소식", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/6a47505ba5268fd7749c0fe11e4b24b4` }),
  Object.freeze({ id: "international", label: "국제소식", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/ecc14533d88be93068af4178946b1b05` }),
  Object.freeze({ id: "photo", label: "사진", kind: "photo", url: `${KCNA_ORIGIN}/kp/gallery/list/6837a75abf5c6249d0e39ee758e763ea` }),
  Object.freeze({ id: "anecdote", label: "혁명일화", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/503e9b606704f9b1c625fa5755928cd3` }),
  Object.freeze({ id: "document", label: "문건", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/1afa96195f9b303902490a126ab7285f` }),
  Object.freeze({ id: "foreign", label: "대외관계", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/e2f336db98b5e69c75e0da264e037e8d` }),
  Object.freeze({ id: "video", label: "동화상", kind: "video", url: `${KCNA_ORIGIN}/kp/video/list/6837a75abf5c6249d0e39ee758e763ea` }),
  Object.freeze({ id: "memory", label: "인민은 못 잊습니다", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/7bc083f00425be6aadfb828fba1cb5a7` }),
  Object.freeze({ id: "domestic", label: "국내소식", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/2f7d854121ccbbfbe6feae9fdcc3556e` }),
  Object.freeze({ id: "social", label: "사회생활", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/680e40b40899891bbe75a7072e3285e7` }),
]);

/** Only anchors bearing one of these visible labels can seed a Rodong crawl. */
export const RODONG_CATEGORY_LABELS = Object.freeze({
  "혁명활동소식": "leadership",
  "오늘호 기사": "important",
  "사진": "photo",
  "인민을 위한 정치": "anecdote",
  "동영상": "video",
  "사회문화생활": "memory",
  "전진하는 조선": "domestic",
  "유구한 력사,찬란한 문화": "social",
});

const DETAIL_PATH_PATTERNS = Object.freeze({
  article: /^\/(?:kp)\/article\/(?:q|detail)\/[-a-z0-9.]+\/?$/iu,
  photo: /^\/(?:kp)\/gallery\/detail\/[-a-z0-9.]+\/?$/iu,
  video: /^\/(?:kp)\/video\/detail\/[-a-z0-9.]+\/?$/iu,
});

export async function crawlNewsMirror(options = {}) {
  const now = normalizeNow(options.now);
  const proxyUrl = normalizeOptionalProxyUrl(options.proxyUrl);
  const dispatcher = !options.fetchImpl && proxyUrl ? new ProxyAgent(proxyUrl) : null;
  const imageBudget = createImageBudget(options, true);
  const fetchImpl = options.fetchImpl || (dispatcher
    ? (url, init = {}) => undiciFetch(url, { ...init, dispatcher })
    : globalThis.fetch);
  try {
    const shared = {
      ...options,
      fetchImpl,
      preferNodeDirect: !dispatcher && !options.fetchImpl,
      allowNodeFallback: !dispatcher && !options.fetchImpl,
      imageBudget,
      now,
    };
    const [kcna, rodong] = await Promise.all([
      options.kcna === false
        ? emptySourceResult("kcna")
        : crawlKcnaNews({ ...shared, ...(options.kcna || {}), imageBudget }),
      options.rodong === false
        ? emptySourceResult("rodong-sinmun")
        : crawlRodongNews({ ...shared, ...(options.rodong || {}), imageBudget }),
    ]);
    const documents = dedupeDocuments([...kcna.documents, ...rodong.documents]);
    sortNewsDocuments(documents);
    return {
      schemaVersion: NEWS_MIRROR_SCHEMA_VERSION,
      generatedAt: now.toISOString(),
      sources: { kcna, "rodong-sinmun": rodong },
      documents,
    };
  } finally {
    await dispatcher?.close();
  }
}

export async function crawlKcnaNews(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  assertFetch(fetchImpl);
  const categoryLists = normalizeKcnaCategoryLists(options.categoryLists || KCNA_CATEGORY_LISTS);
  const maxListPages = boundedInteger(options.maxListPages, 1, 400, DEFAULT_MAX_LIST_PAGES);
  const maxDocuments = boundedInteger(options.maxDocuments, 1, 20_000, DEFAULT_MAX_DOCUMENTS);
  const maxDocumentsPerCategory = boundedInteger(
    options.maxDocumentsPerCategory,
    1,
    10_000,
    DEFAULT_MAX_DOCUMENTS_PER_CATEGORY,
  );
  const context = createCrawlContext({ ...options, fetchImpl, sourceId: "kcna" });
  const entriesByUrl = new Map();
  const errors = [];
  const categoryStats = [];
  let listingPagesFetched = 0;

  for (const category of categoryLists) {
    const initialTask = { key: `GET ${category.url}`, url: category.url, form: null, expectedPage: 1 };
    const queue = [initialTask];
    const visited = new Set();
    const discoveredPages = new Set([initialTask.key]);
    const categoryEntryUrls = new Set();
    let listingErrors = 0;
    let entryCapReached = false;
    let declaredTotal = null;
    let declaredLastPage = null;
    let declaredPerPage = null;
    while (queue.length && visited.size < maxListPages && categoryEntryUrls.size < maxDocumentsPerCategory) {
      const task = queue.shift();
      if (visited.has(task.key)) continue;
      visited.add(task.key);
      try {
        const parsed = await fetchKcnaListingWithRetries(task, category, context);
        listingPagesFetched += 1;
        if (parsed.pagination) {
          if (declaredTotal !== null && (
            declaredTotal !== parsed.pagination.declaredTotal
            || declaredLastPage !== parsed.pagination.pageCount
            || declaredPerPage !== parsed.pagination.perPage
          )) throw new Error("KCNA pagination metadata changed during the crawl");
          declaredTotal ??= parsed.pagination.declaredTotal;
          declaredLastPage ??= parsed.pagination.pageCount;
          declaredPerPage ??= parsed.pagination.perPage;
          for (let page = 1; page <= parsed.pagination.pageCount; page += 1) {
            // Page one is the initial GET. Never enqueue it again as a POST
            // when parsing a later response, or it can consume the final
            // bounded page slot.
            if (page === 1 || page === parsed.pagination.currentPage) continue;
            const key = `POST ${parsed.pagination.actionUrl} page=${page}`;
            discoveredPages.add(key);
            if (queue.length + visited.size >= maxListPages) continue;
            if (visited.has(key) || queue.some((queued) => queued.key === key)) continue;
            queue.push({
              key,
              url: parsed.pagination.actionUrl,
              expectedPage: page,
              form: {
                page_num: page,
                cnt_per_page: parsed.pagination.perPage,
                ...(parsed.pagination.keyword !== null ? { keyword: parsed.pagination.keyword } : {}),
                _csrf: parsed.pagination.csrf,
              },
            });
          }
        }
        for (const [index, entry] of parsed.entries.entries()) {
          if (categoryEntryUrls.size >= maxDocumentsPerCategory) {
            entryCapReached = true;
            break;
          }
          const categoryOrder = categoryEntryUrls.has(entry.url)
            ? entriesByUrl.get(entry.url)?.categoryOrders?.[category.id]
            : categoryEntryUrls.size;
          const orderedEntry = withOfficialCategoryOrder(entry, category.id, categoryOrder);
          categoryEntryUrls.add(entry.url);
          entriesByUrl.set(entry.url, mergeNewsEntry(entriesByUrl.get(entry.url), orderedEntry));
          if (categoryEntryUrls.size >= maxDocumentsPerCategory && index + 1 < parsed.entries.length) {
            entryCapReached = true;
          }
        }
        for (const pageUrl of parsed.pageUrls) {
          const key = `GET ${pageUrl}`;
          discoveredPages.add(key);
          if (queue.length + visited.size >= maxListPages) continue;
          if (!visited.has(key) && !queue.some((queued) => queued.key === key)) {
            queue.push({ key, url: pageUrl, form: null, expectedPage: Number(new URL(pageUrl).searchParams.get("page") || 0) });
          }
        }
        if (categoryEntryUrls.size >= maxDocumentsPerCategory
          && [...discoveredPages].some((pageKey) => !visited.has(pageKey))) entryCapReached = true;
      } catch (error) {
        listingErrors += 1;
        errors.push(makeCrawlError("listing", `${task.url}${task.expectedPage ? `#page=${task.expectedPage}` : ""}`, error));
      }
    }
    categoryStats.push(makeListingCategoryStats({
      category,
      visited,
      discoveredPages,
      entries: categoryEntryUrls,
      maxListPages,
      maxDocumentsPerCategory,
      entryCapReached,
      listingErrors,
      declaredTotal,
      declaredLastPage,
      paginationProofRequired: true,
    }));
  }

  context.kcnaMediaPreviews = new Map(
    [...entriesByUrl.values()]
      .filter((entry) => ["photo", "video"].includes(entry.kind) && entry.previewImageUrl)
      .map((entry) => [
        createNewsUrlIdentity(entry.url),
        {
          url: entry.previewImageUrl,
          referer: entry.previewReferer || entry.url,
          role: "preview",
        },
      ]),
  );
  const entries = selectEntriesAcrossCategories(entriesByUrl, categoryLists.map((category) => category.id), maxDocuments);
  const documentCapReached = entriesByUrl.size > maxDocuments;
  const documents = [];
  let detailsFetched = 0;
  let detailsReused = 0;
  const detailResults = await mapLimit(entries, context.detailConcurrency, async (entry) => {
    const reusable = findReusableKnownDocument(entry, context);
    if (reusable) return { document: makeReusedDocument(entry, reusable, context), reused: true };
    try {
      return { document: await crawlDetailWithRetries(entry, context, crawlKcnaDetail), reused: false };
    } catch (error) {
      errors.push(makeCrawlError("detail", entry.url, error));
      return null;
    }
  });
  for (const result of detailResults) {
    if (!result?.document) continue;
    documents.push(result.document);
    if (result.reused) detailsReused += 1;
    else detailsFetched += 1;
  }
  errors.push(...context.imageErrors.map((error) => ({ stage: "image", url: error.url, error: error.error, documentUrl: error.documentUrl })));
  sortNewsDocuments(documents);

  return {
    sourceId: "kcna",
    documents,
    errors,
    stats: {
      listingPagesFetched,
      entriesDiscovered: entriesByUrl.size,
      entriesSelected: entries.length,
      detailsFetched,
      detailsReused,
      detailsUnresolved: Math.max(0, entries.length - detailsFetched - detailsReused),
      detailRetryAttempts: context.detailRetryCount,
      knownDetailsBlockedByImageCollision: context.knownReuseBlocked.size,
      detailsComplete: detailsFetched + detailsReused === entries.length,
      imagesCached: documents.reduce((sum, item) => sum + item.images.filter((image) => image.cachedUrl).length, 0),
      remoteImagesReferenced: documents.reduce((sum, item) => sum + item.images.filter((image) => image.originalUrl && !image.cachedUrl).length, 0),
      imageErrors: context.imageErrors.length,
      htmlFallbacks: context.htmlFallbacks.length,
      ...makeDocumentImageStats(documents),
      listingFrontierExhausted: categoryStats.length === categoryLists.length
        && categoryStats.every((category) => category.frontierExhausted),
      capReached: documentCapReached || categoryStats.some((category) => category.capReached),
      documentCapReached,
      categories: categoryStats,
      imageQuota: makeImageQuotaStats(context),
    },
  };
}

export async function crawlRodongNews(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  assertFetch(fetchImpl);
  const homepageUrl = normalizeHttpUrl(options.homepageUrl || RODONG_HOME_URL);
  const maxListPages = boundedInteger(options.maxListPages, 1, 400, DEFAULT_MAX_LIST_PAGES);
  const maxDocuments = boundedInteger(options.maxDocuments, 1, 20_000, DEFAULT_MAX_DOCUMENTS);
  const maxDocumentsPerCategory = boundedInteger(
    options.maxDocumentsPerCategory,
    1,
    10_000,
    DEFAULT_MAX_DOCUMENTS_PER_CATEGORY,
  );
  const context = createCrawlContext({ ...options, fetchImpl, sourceId: "rodong-sinmun" });
  const errors = [];
  const entriesByUrl = new Map();
  const categoryStats = [];
  let listingPagesFetched = 0;
  let categories = [];

  try {
    categories = await fetchRodongHomepageWithRetries(
      homepageUrl,
      options.categoryLabels || RODONG_CATEGORY_LABELS,
      context,
    );
  } catch (error) {
    errors.push(makeCrawlError("homepage", homepageUrl, error));
  }

  for (const category of categories) {
    const initialTask = makeRodongListingPageTask(category.url, category.categoryCode);
    const queue = [initialTask];
    const visited = new Set();
    const discoveredPages = new Set([initialTask.key]);
    const categoryEntryUrls = new Set();
    let listingErrors = 0;
    let entryCapReached = false;
    let declaredTotal = null;
    let declaredLastPage = null;
    while (queue.length && visited.size < maxListPages && categoryEntryUrls.size < maxDocumentsPerCategory) {
      const task = queue.shift();
      if (visited.has(task.key)) continue;
      visited.add(task.key);
      const listingUrl = task.url;
      try {
        const parsed = await fetchRodongListingWithRetries(task, category, context);
        listingPagesFetched += 1;
        if (parsed.pagination?.declaredTotal !== null) {
          if (declaredTotal !== null && declaredTotal !== parsed.pagination.declaredTotal) {
            throw new Error("Rodong declared category total changed during the crawl");
          }
          declaredTotal ??= parsed.pagination.declaredTotal;
        }
        declaredLastPage = Math.max(declaredLastPage || 0, parsed.pagination?.declaredLastPage || 0) || null;
        for (const [index, entry] of parsed.entries.entries()) {
          if (categoryEntryUrls.size >= maxDocumentsPerCategory) {
            entryCapReached = true;
            break;
          }
          const categoryOrder = categoryEntryUrls.has(entry.url)
            ? entriesByUrl.get(entry.url)?.categoryOrders?.[category.id]
            : categoryEntryUrls.size;
          const orderedEntry = withOfficialCategoryOrder(entry, category.id, categoryOrder);
          categoryEntryUrls.add(entry.url);
          entriesByUrl.set(entry.url, mergeNewsEntry(entriesByUrl.get(entry.url), orderedEntry));
          if (categoryEntryUrls.size >= maxDocumentsPerCategory && index + 1 < parsed.entries.length) {
            entryCapReached = true;
          }
        }
        for (const pageLink of parsed.pageLinks) {
          if (pageLink.categoryCode !== category.categoryCode) continue;
          const pageTask = makeRodongListingPageTask(pageLink.url, category.categoryCode);
          discoveredPages.add(pageTask.key);
          if (queue.length + visited.size >= maxListPages) continue;
          if (!visited.has(pageTask.key) && !queue.some((queued) => queued.key === pageTask.key)) {
            queue.push(pageTask);
          }
        }
        if (categoryEntryUrls.size >= maxDocumentsPerCategory
          && [...discoveredPages].some((pageKey) => !visited.has(pageKey))) entryCapReached = true;
      } catch (error) {
        listingErrors += 1;
        errors.push(makeCrawlError("listing", listingUrl, error));
      }
    }
    categoryStats.push(makeListingCategoryStats({
      category,
      visited,
      discoveredPages,
      entries: categoryEntryUrls,
      maxListPages,
      maxDocumentsPerCategory,
      entryCapReached,
      listingErrors,
      declaredTotal,
      declaredLastPage,
      paginationProofRequired: true,
    }));
  }

  const entries = selectEntriesAcrossCategories(entriesByUrl, categories.map((category) => category.id), maxDocuments);
  const documentCapReached = entriesByUrl.size > maxDocuments;
  let detailsFetched = 0;
  let detailsReused = 0;
  const detailResults = await mapLimit(entries, context.detailConcurrency, async (entry) => {
    const reusable = findReusableKnownDocument(entry, context);
    if (reusable) return { document: makeReusedDocument(entry, reusable, context), reused: true };
    try {
      return { document: await crawlDetailWithRetries(entry, context, crawlRodongDetail), reused: false };
    } catch (error) {
      errors.push(makeCrawlError("detail", entry.url, error));
      return null;
    }
  });
  const documents = [];
  for (const result of detailResults) {
    if (!result?.document) continue;
    documents.push(result.document);
    if (result.reused) detailsReused += 1;
    else detailsFetched += 1;
  }
  errors.push(...context.imageErrors.map((error) => ({ stage: "image", url: error.url, error: error.error, documentUrl: error.documentUrl })));
  sortNewsDocuments(documents);

  return {
    sourceId: "rodong-sinmun",
    documents,
    errors,
    stats: {
      categoriesDiscovered: categories.length,
      listingPagesFetched,
      entriesDiscovered: entriesByUrl.size,
      entriesSelected: entries.length,
      detailsFetched,
      detailsReused,
      detailsUnresolved: Math.max(0, entries.length - detailsFetched - detailsReused),
      detailRetryAttempts: context.detailRetryCount,
      knownDetailsBlockedByImageCollision: context.knownReuseBlocked.size,
      detailsComplete: detailsFetched + detailsReused === entries.length,
      imagesCached: documents.reduce((sum, item) => sum + item.images.filter((image) => image.cachedUrl).length, 0),
      remoteImagesReferenced: documents.reduce((sum, item) => sum + item.images.filter((image) => image.originalUrl && !image.cachedUrl).length, 0),
      imageErrors: context.imageErrors.length,
      htmlFallbacks: context.htmlFallbacks.length,
      ...makeDocumentImageStats(documents),
      listingFrontierExhausted: categoryStats.length > 0
        && categoryStats.length === categories.length
        && categoryStats.every((category) => category.frontierExhausted),
      capReached: documentCapReached || categoryStats.some((category) => category.capReached),
      documentCapReached,
      categories: categoryStats,
      imageQuota: makeImageQuotaStats(context),
    },
  };
}

export function parseKcnaListing(html = "", listingUrl = "", category = {}) {
  const safeListingUrl = normalizeHttpUrl(listingUrl);
  const origin = new URL(safeListingUrl).origin;
  const $ = cheerio.load(String(html || ""));
  const entries = [];
  const seen = new Set();

  if (["photo", "video"].includes(String(category.kind || ""))) {
    entries.push(...parseKcnaMediaListingEntries($, safeListingUrl, category, origin));
  } else {
    $("a[href]").each((_, element) => {
      const rawHref = String($(element).attr("href") || "").trim();
      const url = resolveSameOriginUrl(rawHref, safeListingUrl);
      if (!url || new URL(url).origin !== origin) return;
      const kind = classifyKcnaDetailPath(new URL(url).pathname);
      if (!kind || (category.kind && kind !== category.kind)) return;
      if (seen.has(url)) return;
      const scope = findListingItemScope($, element);
      const scopeText = normalizedText(scope.text());
      const rawTitle = normalizedText(
        $(element).attr("title")
        || cloneTextWithoutMedia($, $(element))
        || firstCandidateText($, scope, "h1, h2, h3, h4, .title, [class*=title]"),
      );
      const title = stripTrailingDate(rawTitle);
      if (!isPlausibleTitle(title)) return;
      const date = normalizeDate(scopeText) || normalizeDate(rawTitle);
      const previewImageUrl = firstSameOriginImageUrl($, scope, safeListingUrl, { kcnaPhotoOnly: false });
      const hasCamera = hasCameraMarker($, scope) || Boolean(previewImageUrl) || kind === "photo";
      entries.push({
        sourceId: "kcna",
        category: { id: String(category.id || kind), label: String(category.label || "") },
        categories: [String(category.id || kind)],
        kind,
        title,
        date,
        url,
        previewImageUrl,
        markers: { camera: hasCamera, gallery: kind === "photo" || /gallery/iu.test(rawHref) },
      });
      seen.add(url);
    });
  }

  const pageUrls = discoverKcnaPageUrls($, safeListingUrl);
  const pagination = parseKcnaPagination($, safeListingUrl);
  return { entries, pageUrls, pagination };
}

function parseKcnaMediaListingEntries($, listingUrl, category, origin) {
  const kind = String(category.kind || "");
  const itemClass = kind === "photo" ? "gallery" : "video";
  const mainItems = $(`main .${itemClass}`);
  const items = mainItems.length ? mainItems : $(`.${itemClass}`);
  const entries = [];
  const seen = new Set();

  items.each((_, element) => {
    const item = $(element);
    const anchorElements = [
      ...(item.is("a[href]") ? [element] : []),
      ...item.find("a[href]").toArray(),
    ];
    const matchingAnchors = anchorElements.flatMap((anchor) => {
      const url = resolveSameOriginUrl($(anchor).attr("href"), listingUrl);
      return Boolean(url)
        && new URL(url).origin === origin
        && classifyKcnaDetailPath(new URL(url).pathname) === kind
        ? [{ anchor, url }]
        : [];
    });
    if (!matchingAnchors.length) return;
    const uniqueUrls = [...new Set(matchingAnchors.map((record) => record.url))];
    if (uniqueUrls.length !== 1) return;
    const url = uniqueUrls[0];
    if (!url || seen.has(url)) return;

    const titleCandidates = [
      ...matchingAnchors.flatMap(({ anchor }) => [
        normalizedText($(anchor).attr("title")),
        cloneTextWithoutMedia($, $(anchor)),
      ]),
      ...item.find("h1, h2, h3, h4, h5, h6").map((__, heading) => normalizedText($(heading).text())).get(),
      ...item.find("img[alt]").map((__, image) => normalizedText($(image).attr("alt"))).get(),
    ];
    const title = titleCandidates
      .map((candidate) => stripTrailingDate(candidate))
      .find((candidate) => isPlausibleTitle(candidate) && normalizedLabel(candidate) !== "전체") || "";
    const dateScope = item.clone();
    dateScope.find("a[href], img, picture, video, source, svg").remove();
    const date = firstDateWithinNode($, item)
      || normalizeDate(dateScope.text())
      || normalizeDate(item.text());
    if (!title || !date) return;

    const previewOptions = { sourceId: "kcna", allowData: true };
    const previewImageUrl = matchingAnchors
      .map(({ anchor }) => firstSameOriginImageUrl($, $(anchor), listingUrl, previewOptions))
      .find(Boolean)
      || firstSameOriginImageUrl($, item, listingUrl, previewOptions);
    entries.push({
      sourceId: "kcna",
      category: { id: String(category.id || kind), label: String(category.label || "") },
      categories: [String(category.id || kind)],
      kind,
      title,
      date,
      url,
      previewImageUrl,
      previewReferer: listingUrl,
      markers: { camera: Boolean(previewImageUrl) || kind === "photo", gallery: kind === "photo" },
    });
    seen.add(url);
  });

  return entries;
}

export function parseKcnaPagination(input, listingUrl = "") {
  const safeListingUrl = normalizeHttpUrl(listingUrl);
  const $ = typeof input === "function" && input.root ? input : cheerio.load(String(input || ""));
  const listingKind = new URL(safeListingUrl).pathname.match(/^\/(?:kp)\/(article|gallery|video)\/list\//iu)?.[1]?.toLowerCase();
  if (!listingKind) return null;
  const form = $(`form#${listingKind}_form[method]`).first();
  if (!form.length || String(form.attr("method") || "").toUpperCase() !== "POST") return null;
  const actionUrl = resolveSameOriginUrl(form.attr("action"), safeListingUrl);
  if (!actionUrl) return null;
  const action = new URL(actionUrl);
  const listing = new URL(safeListingUrl);
  if (action.pathname !== listing.pathname || action.search) return null;
  const valueOf = (name) => String(form.find(`input[name='${name}']`).first().attr("value") || "");
  const csrf = valueOf("_csrf");
  const keywordInput = form.find("input[name='keyword']").first();
  const keyword = keywordInput.length ? String(keywordInput.attr("value") || "") : null;
  const configuredPerPage = Number(valueOf("cnt_per_page") || 0);
  const scripts = $("script").map((_, element) => String($(element).html() || "")).get().join("\n");
  const declaredTotal = Number(scripts.match(/\bvar\s+total\s*=\s*(\d{1,7})\s*;/u)?.[1] ?? NaN);
  const currentPage = Number(scripts.match(/\bvar\s+cur_page\s*=\s*(\d{1,5})\s*;/u)?.[1] ?? NaN);
  const perPage = Number(scripts.match(/\bvar\s+per_page\s*=\s*(\d{1,4})\s*;/u)?.[1] ?? NaN);
  const pageCount = Number(scripts.match(/\bvar\s+page_cnt\s*=\s*(\d{1,5})\s*;/u)?.[1] ?? NaN);
  if (!/^[A-Za-z0-9_-]{8,512}$/u.test(csrf)
    || !Number.isInteger(declaredTotal) || declaredTotal < 0 || declaredTotal > 1_000_000
    || !Number.isInteger(currentPage) || currentPage < 1 || currentPage > 10_000
    || !Number.isInteger(perPage) || perPage < 1 || perPage > 1_000
    || configuredPerPage !== perPage
    || !Number.isInteger(pageCount) || pageCount < 0 || pageCount > 10_000
    || pageCount !== Math.ceil(declaredTotal / perPage)
    || (pageCount > 0 && currentPage > pageCount)) return null;
  return { actionUrl, csrf, currentPage, perPage, pageCount, declaredTotal, keyword };
}

export function parseKcnaDetail(html = "", detailUrl = "", fallback = {}) {
  const safeDetailUrl = normalizeHttpUrl(detailUrl);
  const $ = cheerio.load(String(html || ""));
  removeNonContentNodes($);
  const title = stripTrailingDate(
    fallback.confirmedTitle
    || bestTitle($, [".article_title", ".article-title", ".news_title", ".news-title", "main h1", "article h1", "h1", "h2"])
    || fallback.title
    || "",
  );
  const content = extractArticleContent($, [
    ".article_body", ".article-body", ".news_body", ".news-body", ".detail_content", ".detail-content",
    "article", "main .content", "main",
  ]);
  const containingArticle = content.node.is("article")
    ? content.node
    : content.node.closest("article").first();
  const date = firstDateWithinNode($, containingArticle.length ? containingArticle : content.node)
    || normalizeDate(fallback.date);
  const galleryUrl = findKcnaGalleryUrl($, safeDetailUrl, content.node);
  const imageUrls = collectImageReferences($, content.node, safeDetailUrl, {
    sourceId: "kcna",
    kcnaPhotoOnly: true,
  });
  return {
    title: title || String(fallback.title || ""),
    date,
    body: content.body,
    galleryUrl,
    imageUrls,
    markers: {
      camera: hasCameraMarker($, content.node) || Boolean(galleryUrl) || imageUrls.length > 0 || fallback.markers?.camera === true,
      gallery: Boolean(galleryUrl) || fallback.markers?.gallery === true,
    },
  };
}

export function findKcnaGalleryUrl(input, detailUrl = "", contentNode = null) {
  const safeDetailUrl = normalizeHttpUrl(detailUrl);
  const $ = typeof input === "function" && input.root ? input : cheerio.load(String(input || ""));
  const selectedContent = contentNode?.length
    ? contentNode
    : selectBestContentNode($, [
      ".article_body", ".article-body", ".news_body", ".news-body", ".detail_content", ".detail-content",
      "article", "main .content", "main",
    ]);
  const containingArticle = selectedContent.is("article")
    ? selectedContent
    : selectedContent.closest("article").first();
  const scope = containingArticle.length ? containingArticle : selectedContent;
  let result = "";
  scope.find("a.gallery_button[href]").each((_, element) => {
    if (result) return;
    const candidate = resolveSameOriginUrl($(element).attr("href"), safeDetailUrl);
    if (!candidate) return;
    if (/^\/kp\/gallery\/detail\/[-a-z0-9.]+\/?$/iu.test(new URL(candidate).pathname)) result = candidate;
  });
  return result;
}

export function parseKcnaGalleryImages(html = "", galleryUrl = "") {
  const safeGalleryUrl = normalizeHttpUrl(galleryUrl);
  const $ = cheerio.load(String(html || ""));
  removeNonContentNodes($);
  const candidateElements = [...new Set($("main.gallery, main .gallery").toArray())];
  if (!candidateElements.length || candidateElements.length > MAX_KCNA_GALLERY_ROOT_CANDIDATES) return [];
  const candidates = candidateElements
    .map((element) => {
      const root = $(element);
      const references = collectImageReferences($, root, safeGalleryUrl, {
        sourceId: "kcna",
        kcnaPhotoOnly: true,
        role: "gallery",
      });
      return { root, references };
    })
    .filter(({ root, references }) => (
      references.length > 0 && !hasForeignKcnaDetailLink($, root, safeGalleryUrl)
    ));
  if (candidates.length === 1) return candidates[0].references;
  if (candidates.length < 2) return [];
  const associated = candidates.filter(({ root }) => (
    isKcnaGalleryRootAssociated($, root, safeGalleryUrl)
  ));
  if (associated.length === 1) return associated[0].references;
  const mostSpecific = associated.filter(({ root }) => {
    const descendants = new Set(root.find("*").toArray());
    return !associated.some(({ root: otherRoot }) => (
      otherRoot.get(0) !== root.get(0) && descendants.has(otherRoot.get(0))
    ));
  });
  return mostSpecific.length === 1 ? mostSpecific[0].references : [];
}

function hasForeignKcnaDetailLink($, root, galleryUrl) {
  const expectedIdentity = createNewsUrlIdentity(galleryUrl);
  const anchors = [
    ...(root.is("a[href]") ? root.toArray() : []),
    ...root.find("a[href]").toArray(),
  ];
  return anchors.some((anchor) => {
    const candidate = resolveSameOriginUrl($(anchor).attr("href"), galleryUrl);
    if (!candidate || !classifyKcnaDetailPath(new URL(candidate).pathname)) return false;
    return createNewsUrlIdentity(candidate) !== expectedIdentity;
  });
}

function isKcnaGalleryRootAssociated($, root, galleryUrl) {
  const expectedIdentity = createNewsUrlIdentity(galleryUrl);
  const expectedHash = new URL(galleryUrl).pathname.split("/").filter(Boolean).at(-1) || "";
  const linkedNodes = [
    ...(root.is("[href]") ? root.toArray() : []),
    ...root.find("[href]").toArray(),
  ];
  if (linkedNodes.some((element) => {
    const candidate = resolveSameOriginUrl($(element).attr("href"), galleryUrl);
    return candidate && createNewsUrlIdentity(candidate) === expectedIdentity;
  })) return true;
  if (!expectedHash) return false;
  const identityAttributes = [
    "id", "data-id", "data-gallery-id", "data-gallery", "data-url", "data-href",
  ];
  return [
    root,
    ...root.find("[id], [data-id], [data-gallery-id], [data-gallery], [data-url], [data-href]")
      .toArray()
      .map((element) => $(element)),
  ]
    .some((node) => identityAttributes.some((attribute) => (
      String(node.attr(attribute) || "").includes(expectedHash)
    )));
}

export function parseRodongHomepageCategories(html = "", homepageUrl = "", categoryLabels = RODONG_CATEGORY_LABELS) {
  const safeHomepageUrl = normalizeHttpUrl(homepageUrl);
  const $ = cheerio.load(String(html || ""));
  const normalizedLabels = new Map(
    Object.entries(categoryLabels || {}).map(([label, id]) => [normalizedLabel(label), String(id)]),
  );
  const categories = [];
  const seenCodes = new Set();

  const appendCategory = (labelValue, rawHref) => {
    const label = normalizedLabel(labelValue);
    const id = normalizedLabels.get(label);
    if (!id) return;
    const url = resolveSameOriginUrl(rawHref, safeHomepageUrl);
    if (!url) return;
    const token = parseRodongCategoryToken(url);
    if (!token || token.page !== 1 || seenCodes.has(token.categoryCode)) return;
    categories.push({ id, label: normalizedText(labelValue), categoryCode: token.categoryCode, url });
    seenCodes.add(token.categoryCode);
  };

  $("a[href]").each((_, element) => {
    appendCategory($(element).text(), $(element).attr("href"));
  });

  // Some official homepage sections (notably "오늘호 기사") expose their
  // category label as a heading and put the list URL on the adjacent 더보기
  // anchor.  Treat that visible heading/link pair as the authority instead of
  // inventing a category from article text.
  $(".TopClassTitle").each((_, element) => {
    const heading = $(element);
    const sectionHeader = heading.closest(".TopClassBG");
    const moreLink = sectionHeader.find(".TopClassLink a[href], a.page_link[href]").first();
    if (!moreLink.length) return;
    appendCategory(heading.text(), moreLink.attr("href"));
  });

  return categories;
}

export function parseRodongListing(html = "", listingUrl = "", category = {}) {
  const safeListingUrl = normalizeHttpUrl(listingUrl);
  const $ = cheerio.load(String(html || ""));
  const entries = category.id === "photo"
    ? parseRodongPhotoListingEntries($, safeListingUrl, category)
    : [];
  const pageLinks = [];
  const seenEntries = new Set(entries.map((entry) => entry.url));
  const seenPages = new Set();

  $("a[href]").each((_, element) => {
    const url = resolveSameOriginUrl($(element).attr("href"), safeListingUrl);
    if (!url) return;
    const categoryToken = parseRodongCategoryToken(url);
    if (categoryToken) {
      const pageIdentity = `${categoryToken.categoryCode}:${categoryToken.page}`;
      if (!seenPages.has(pageIdentity)) {
        pageLinks.push({ ...categoryToken, url });
        seenPages.add(pageIdentity);
      }
    }
  });

  const entryAnchors = selectRodongListingEntryAnchors($, category);
  entryAnchors.each((_, element) => {
    const url = resolveSameOriginUrl($(element).attr("href"), safeListingUrl);
    if (!url || parseRodongCategoryToken(url)) return;
    const detailToken = category.id === "video"
      ? parseRodongVideoToken(url)
      : parseRodongDetailToken(url);
    if (!detailToken || seenEntries.has(url)) return;
    if (category.id !== "video"
      && category.categoryCode
      && detailToken.categoryCode !== String(category.categoryCode)) return;
    const scope = findListingItemScope($, element);
    const linkTitle = cloneTextWithoutMedia($, $(element));
    const scopedTitle = firstCandidateText($, scope, "h1, h2, h3, h4, .title, [class*=title]");
    const rawTitle = normalizedText(category.id === "video"
      ? scopedTitle || $(element).attr("title") || linkTitle
      : linkTitle || $(element).attr("title") || scopedTitle);
    const title = stripTrailingDate(rawTitle);
    if (!isPlausibleTitle(title)) return;
    const date = normalizeDate(scope.text()) || detailToken.date;
    const previewImageUrl = firstSameOriginImageUrl($, scope, safeListingUrl, {
      sourceId: "rodong-sinmun",
      allowData: true,
    });
    entries.push({
      sourceId: "rodong-sinmun",
      category: { id: String(category.id || "uncategorized"), label: String(category.label || "") },
      categories: [String(category.id || "uncategorized")],
      categoryCode: String(category.categoryCode || detailToken.categoryCode || ""),
      kind: category.id === "photo" ? "photo" : category.id === "video" ? "video" : "article",
      title,
      date,
      url,
      previewImageUrl,
      markers: { camera: Boolean(previewImageUrl) || hasCameraMarker($, scope), gallery: category.id === "photo" },
    });
    seenEntries.add(url);
  });

  pageLinks.sort((left, right) => left.page - right.page);
  const currentPage = parseRodongCategoryToken(safeListingUrl)?.page || 1;
  const selectedCategoryCode = String(category.categoryCode || "");
  const categoryPageLinks = selectedCategoryCode
    ? pageLinks.filter((pageLink) => pageLink.categoryCode === selectedCategoryCode)
    : pageLinks;
  const declaredLastPage = Math.max(currentPage, ...categoryPageLinks.map((pageLink) => pageLink.page));
  const pathText = normalizedText($("#PathBar").first().text());
  const declaredTotalMatch = pathText.match(/(?:^|[>\s])([0-9]{1,7})\s*건(?:$|\s)/u);
  const declaredTotal = declaredTotalMatch ? Number(declaredTotalMatch[1]) : null;
  return { entries, pageLinks, pagination: { currentPage, declaredLastPage, declaredTotal } };
}

function selectRodongListingEntryAnchors($, category) {
  const categoryId = String(category.id || "");
  if (categoryId === "photo") return $([]);
  if (categoryId === "video" || categoryId === "social") return $("a[href]");
  let roots;
  if (categoryId === "leadership") roots = $("#RevoListDIV").first();
  else if (["anecdote", "domestic", "memory"].includes(categoryId)) roots = $("#ThemeListDIV").first();
  else if (categoryId === "important") roots = $("#revoList > .date_news_list .media-body");
  else return $("a[href]");
  if (!roots.length) throw new Error(`Rodong ${categoryId} listing is missing its official list root`);
  return roots.find("a[href]").add(roots.filter("a[href]"));
}

function parseRodongPhotoListingEntries($, listingUrl, category) {
  const entries = [];
  const seen = new Set();
  $("script").each((_, element) => {
    const source = String($(element).html() || "");
    const className = source.match(/\$\(["']\.([a-z0-9_-]+)["']\)\.click/iu)?.[1] || "";
    if (!className || !/^fancybox-[a-z0-9_-]+$/iu.test(className)) return;
    const scope = $(`a.${className}`).first().closest(".thumbnail");
    if (!scope.length) return;
    const title = normalizedText(scope.find(".span-title").first().text());
    const date = normalizeDate(scope.find(".gallery_cal, .artDate, .date").first().text())
      || normalizeDate(source.match(/his\(["']([^"']+)["']\)/u)?.[1] || "");
    if (!isPlausibleTitle(title) || !date) return;
    const imageReferences = [];
    for (const match of source.matchAll(/\bhref\s*:\s*["']([^"']+)["']/giu)) {
      const url = resolveSameOriginUrl(match[1], listingUrl);
      if (!url || imageReferences.some((reference) => reference.url === url)) continue;
      imageReferences.push({ url, referer: listingUrl, role: "gallery" });
    }
    if (!imageReferences.length) return;
    const url = imageReferences[0].url;
    if (seen.has(url)) return;
    entries.push({
      sourceId: "rodong-sinmun",
      category: { id: String(category.id || "photo"), label: String(category.label || "") },
      categories: [String(category.id || "photo")],
      categoryCode: String(category.categoryCode || "8"),
      kind: "photo",
      title,
      date,
      url,
      previewImageUrl: "",
      embeddedImageReferences: imageReferences,
      markers: { camera: true, gallery: true },
    });
    seen.add(url);
  });
  return entries;
}

export function parseRodongDetail(html = "", detailUrl = "", fallback = {}) {
  const safeDetailUrl = normalizeHttpUrl(detailUrl);
  const sourceHtml = String(html || "");
  const ajaxDescriptor = parseRodongAjaxDescriptor(sourceHtml, safeDetailUrl);
  const scriptedImageUrls = parseRodongScriptGalleryReferences(sourceHtml, safeDetailUrl, ajaxDescriptor?.newsId || "");
  const $ = cheerio.load(sourceHtml);
  removeNonContentNodes($);
  const title = stripTrailingDate(
    bestTitle($, [".article_title", ".article-title", ".rodong_title", ".view_title", "article h1", "main h1", "h1", "h2"])
    || fallback.title
    || "",
  );
  const date = firstDateFromSelectors($, ["time", ".date", "[class*=date]", "[id*=date]"])
    || parseRodongDetailToken(safeDetailUrl)?.date
    || normalizeDate(fallback.date);
  const content = extractArticleContent($, [
    "#ContDIV", "#articleContent", ".article-content", ".article_body", ".article-body",
    ".rodong_view", ".rodong-view", ".view_content", ".view-content",
    "article", "main .content", "main",
  ]);
  const inlineImageUrls = collectImageReferences($, content.node, safeDetailUrl, {
    sourceId: "rodong-sinmun",
    role: "inline",
    allowData: true,
  });
  const imageUrls = dedupeImageReferences([...inlineImageUrls, ...scriptedImageUrls]);
  return {
    title: title || String(fallback.title || ""),
    date,
    body: content.body,
    imageUrls,
    ajaxDescriptor,
    markers: {
      camera: imageUrls.length > 0 || hasCameraMarker($, content.node) || fallback.markers?.camera === true,
      gallery: imageUrls.some((reference) => reference.role === "gallery")
        || ajaxDescriptor?.mediaType === 3
        || fallback.markers?.gallery === true,
    },
  };
}

export function parseRodongAjaxDescriptor(html = "", detailUrl = "") {
  const safeDetailUrl = normalizeHttpUrl(detailUrl);
  const detailIdentity = parseRodongArticleIdentity(safeDetailUrl);
  if (!detailIdentity) return null;
  const $ = cheerio.load(String(html || ""));
  const scripts = $("script").map((_, element) => String($(element).html() || "")).get();
  for (const script of scripts) {
    if (!script.includes(RODONG_AJAX_QUERY)) continue;
    const endpointRaw = script.match(/\burl\s*:\s*["']([^"']{1,2048})["']/iu)?.[1] || "";
    const endpointUrl = resolveSameOriginUrl(endpointRaw, safeDetailUrl);
    if (!isRodongAjaxEndpoint(endpointUrl, safeDetailUrl)) continue;
    const newsId = script.match(/strNewsID\s*=\s*(20\d{2}-\d{2}-\d{2}-\d{3})/u)?.[1] || "";
    const themeId = Number(script.match(/iThemeID\s*=\s*(\d{1,5})/u)?.[1] || 0);
    const publishDate = normalizeDate(script.match(/dPublish\s*=\s*(20\d{2}-\d{2}-\d{2})/u)?.[1] || "");
    const mediaType = Number(script.match(/\bvar\s+iType\s*=\s*([1-4])\s*;/u)?.[1] || 0);
    if (newsId !== detailIdentity.newsId || !themeId || !publishDate || ![1, 2, 3, 4].includes(mediaType)) continue;
    return {
      endpointUrl,
      detailUrl: safeDetailUrl,
      newsId,
      themeId,
      publishDate,
      mediaType,
    };
  }
  return null;
}

export function parseRodongScriptGalleryReferences(html = "", detailUrl = "", expectedNewsId = "") {
  const safeDetailUrl = normalizeHttpUrl(detailUrl);
  const newsId = String(expectedNewsId || parseRodongArticleIdentity(safeDetailUrl)?.newsId || "");
  if (!/^20\d{2}-\d{2}-\d{2}-\d{3}$/u.test(newsId)) return [];
  const $ = cheerio.load(String(html || ""));
  const references = [];
  $("script").each((_, element) => {
    const script = String($(element).html() || "");
    if (!/(?:revo_)?fancybox\.open\s*\(/u.test(script)) return;
    for (const match of script.matchAll(/\bhref\s*:\s*["']([^"'\\]{1,4096})["']/giu)) {
      const url = resolveSameOriginUrl(match[1], safeDetailUrl);
      if (!url) continue;
      const decoded = decodeRodongToken(url);
      if (!/^2@@@@p@0@/u.test(decoded) || !decoded.includes(`/${newsId}/`)) continue;
      references.push({ url, referer: safeDetailUrl, role: "gallery" });
    }
  });
  return dedupeImageReferences(references);
}

export function parseRodongAjaxResponse(value = "", expectedNewsId = "") {
  let parsed = value;
  let decodes = 0;
  while (typeof parsed === "string" && decodes < 2) {
    if (!parsed.length || parsed.length > DEFAULT_HTML_MAX_BYTES) throw new Error("Rodong gallery AJAX response is invalid");
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error("Rodong gallery AJAX response is not valid JSON");
    }
    decodes += 1;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed === "string") {
    throw new Error("Rodong gallery AJAX response has an invalid envelope");
  }
  if (!Array.isArray(parsed.rows) || parsed.rows.length !== 1 || !parsed.rows[0] || typeof parsed.rows[0] !== "object") {
    throw new Error("Rodong gallery AJAX response must contain exactly one row");
  }
  const row = parsed.rows[0];
  const newsId = String(row.strNewsID || "");
  const mediaType = Number(row.iType);
  const photoCount = Number(row.iPhotoCnt || 0);
  const html = String(row.strHTML || "");
  if (newsId !== String(expectedNewsId || "") || !/^20\d{2}-\d{2}-\d{2}-\d{3}$/u.test(newsId)) {
    throw new Error("Rodong gallery AJAX response news id does not match the article");
  }
  if (![1, 2, 3, 4].includes(mediaType)) throw new Error("Rodong gallery AJAX response has an invalid media type");
  if (!Number.isInteger(photoCount) || photoCount < 0 || photoCount > 100) {
    throw new Error("Rodong gallery AJAX response has an invalid photo count");
  }
  if (Buffer.byteLength(html, "utf8") > DEFAULT_HTML_MAX_BYTES) throw new Error("Rodong gallery AJAX HTML is too large");
  return { newsId, mediaType, photoCount, html };
}

/** Decode the opaque Rodong query token without assigning it any product-level meaning. */
export function decodeRodongToken(input = "") {
  let token = String(input || "").trim();
  if (!token) return "";
  try {
    if (/^https?:/iu.test(token)) token = new URL(token).search.slice(1);
  } catch {
    return "";
  }
  if (token.includes("&")) token = token.split("&", 1)[0];
  try {
    token = decodeURIComponent(token).replace(/ /gu, "+");
  } catch {
    return "";
  }
  if (!/^[A-Za-z0-9+/_=-]{2,4096}$/u.test(token)) return "";
  try {
    const decoded = Buffer.from(token.replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8");
    if (!decoded || decoded.includes("\uFFFD") || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(decoded)) return "";
    return decoded;
  } catch {
    return "";
  }
}

/** Rodong list tokens encode `1@@category@page@`; category is never the page. */
export function parseRodongCategoryToken(input = "") {
  const decoded = decodeRodongToken(input);
  const match = decoded.match(/^1@@([1-9]\d{0,4})@([1-9]\d{0,4})@(?:@0@)?$/u);
  if (!match) return null;
  return { page: Number(match[2]), categoryCode: match[1], decoded };
}

export function encodeRodongCategoryToken(categoryCode, page = 1) {
  const safeCategory = String(categoryCode || "").trim();
  const safePage = boundedInteger(page, 1, 99_999, 1);
  if (!/^[1-9]\d{0,4}$/u.test(safeCategory)) throw new Error("Invalid Rodong category code");
  return Buffer.from(`1@@${safeCategory}@${safePage}@`, "utf8").toString("base64");
}

function makeRodongListingPageTask(value, expectedCategoryCode = "") {
  const url = normalizeHttpUrl(value);
  const token = parseRodongCategoryToken(url);
  const expected = String(expectedCategoryCode || "");
  if (!token || (expected && token.categoryCode !== expected)) {
    throw new Error(`Rodong listing page identity is invalid: ${url}`);
  }
  return { key: `${token.categoryCode}:${token.page}`, url };
}

export function parseRodongDetailToken(input = "") {
  const decoded = decodeRodongToken(input);
  const match = decoded.match(/^12@(20\d{2}-\d{2}-\d{2})-\d{3}@([1-9]\d{0,4})@/u);
  if (!match) return null;
  return { date: normalizeDate(match[1]), categoryCode: match[2], decoded };
}

function parseRodongArticleIdentity(input = "") {
  const decoded = decodeRodongToken(input);
  const match = decoded.match(/^12@(20\d{2}-\d{2}-\d{2}-\d{3})@([1-9]\d{0,4})@/u);
  if (!match) return null;
  return { newsId: match[1], categoryCode: match[2], decoded };
}

function isRodongAjaxEndpoint(candidate = "", detailUrl = "") {
  if (!candidate) return false;
  try {
    const endpoint = new URL(normalizeHttpUrl(candidate));
    const detail = new URL(normalizeHttpUrl(detailUrl));
    return endpoint.origin === detail.origin
      && endpoint.pathname === detail.pathname
      && endpoint.search === `?${RODONG_AJAX_QUERY}`;
  } catch {
    return false;
  }
}

export function parseRodongVideoToken(input = "") {
  const decoded = decodeRodongToken(input);
  const match = decoded.match(/^10@(20\d{2}-\d{2}-\d{2})-\d{3}@/u);
  if (!match) return null;
  return { date: normalizeDate(match[1]), decoded };
}

export function resolveSameOriginUrl(rawUrl = "", baseUrl = "") {
  const raw = String(rawUrl || "").trim();
  if (!raw || /^(?:data|blob|javascript|mailto|tel):/iu.test(raw)) return "";
  try {
    const base = new URL(normalizeHttpUrl(baseUrl));
    const target = new URL(raw, base);
    if (!/^https?:$/u.test(target.protocol) || target.origin !== base.origin) return "";
    target.hash = "";
    return target.href;
  } catch {
    return "";
  }
}

export async function fetchBoundedHtml(url, options = {}) {
  const safeUrl = normalizeHttpUrl(url);
  const maxBytes = boundedInteger(options.htmlMaxBytes, 1_024, 64 * 1024 * 1024, DEFAULT_HTML_MAX_BYTES);
  const response = await fetchBoundedBytes(safeUrl, {
    ...options,
    maxBytes,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    referer: "",
  });
  const contentType = response.contentType;
  if (/^(?:image|audio|video)\//iu.test(contentType) || /application\/(?:pdf|octet-stream)/iu.test(contentType)) {
    throw new Error(`Expected HTML from ${safeUrl}, received ${contentType}`);
  }
  return decodeHtml(response.bytes, contentType);
}

export function buildRodongHtmlFallbackUrl(url = "") {
  const officialUrl = normalizeHttpUrl(url);
  if (new URL(officialUrl).origin !== RODONG_ORIGIN) throw new Error("Rodong HTML fallback accepts only the official origin");
  return `${RODONG_JINA_ORIGIN}/${officialUrl}`;
}

async function fetchRodongHtml(url, context) {
  const officialUrl = normalizeHttpUrl(url);
  try {
    return await fetchBoundedHtml(officialUrl, context);
  } catch (directError) {
    if (new URL(officialUrl).origin !== RODONG_ORIGIN || !isRodongHtmlFallbackError(directError)) throw directError;
    const fallbackUrl = buildRodongHtmlFallbackUrl(officialUrl);
    try {
      const html = await fetchBoundedHtml(fallbackUrl, {
        ...context,
        extraHeaders: { "X-Return-Format": "html" },
      });
      if (!/<(?:!doctype|html|main|article|nav|div)\b/iu.test(html)) {
        throw new Error("Rodong HTML fallback returned a non-HTML payload");
      }
      context.htmlFallbacks.push(officialUrl);
      return html;
    } catch (fallbackError) {
      const exhaustedError = new Error(
        `Rodong official HTML failed directly and via bounded fallback: ${String(directError?.message || directError)}; ${String(fallbackError?.message || fallbackError)}`,
        { cause: directError },
      );
      exhaustedError.code = "RODONG_HTML_FALLBACK_EXHAUSTED";
      exhaustedError.fallbackError = fallbackError;
      throw exhaustedError;
    }
  }
}

export async function fetchBoundedForm(url, formValues, options = {}) {
  const safeUrl = normalizeHttpUrl(url);
  const referer = normalizeHttpUrl(options.referer || safeUrl);
  if (new URL(safeUrl).origin !== new URL(referer).origin) {
    throw new Error("Form Referer must share the request origin");
  }
  const form = makeBoundedFormBody(formValues);
  const maxBytes = boundedInteger(options.htmlMaxBytes, 1_024, 64 * 1024 * 1024, DEFAULT_HTML_MAX_BYTES);
  const response = await fetchBoundedBytes(safeUrl, {
    ...options,
    method: "POST",
    body: form,
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    maxRedirects: 0,
    maxBytes,
    accept: "application/json,text/html;q=0.9,*/*;q=0.1",
    referer,
    allowNodeFallback: false,
    extraHeaders: options.requestedWith === false
      ? {}
      : { "X-Requested-With": "XMLHttpRequest" },
  });
  if (/^(?:image|audio|video)\//iu.test(response.contentType) || /application\/(?:pdf|octet-stream)/iu.test(response.contentType)) {
    throw new Error(`Expected a text form response from ${safeUrl}, received ${response.contentType}`);
  }
  return decodeHtml(response.bytes, response.contentType);
}

export async function fetchBoundedImage(url, options = {}) {
  const safeUrl = normalizeHttpUrl(url);
  const referer = normalizeHttpUrl(options.referer || safeUrl);
  if (new URL(safeUrl).origin !== new URL(referer).origin) throw new Error("Image Referer must share the image origin");
  const maxBytes = boundedInteger(options.imageMaxBytes, 32, 64 * 1024 * 1024, DEFAULT_IMAGE_MAX_BYTES);
  const response = await fetchBoundedBytes(safeUrl, {
    ...options,
    maxBytes,
    accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
    referer,
  });
  const detected = detectImageFormat(response.bytes);
  if (!detected) throw new Error(`Image magic is invalid: ${safeUrl}`);
  if (response.contentType && !/^image\//iu.test(response.contentType)) {
    throw new Error(`Expected an image from ${safeUrl}, received ${response.contentType}`);
  }
  return { ...response, ...detected };
}

export function detectImageFormat(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: "png", mimeType: "image/png" };
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    return { extension: "gif", mimeType: "image/gif" };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: "webp", mimeType: "image/webp" };
  }
  return null;
}

export async function cacheNewsImage(reference, options = {}) {
  const sourceId = normalizeSourceId(options.sourceId);
  const assetDir = path.resolve(options.assetDir || DEFAULT_NEWS_ASSET_DIR);
  const publicBase = normalizePublicBase(options.publicAssetBase || DEFAULT_NEWS_PUBLIC_ASSET_BASE);
  const role = String(reference?.role || "inline");
  const originalUrl = String(reference?.url || "").trim();
  let bytes;
  let format;

  if (/^data:/iu.test(originalUrl)) {
    bytes = decodeBoundedDataImage(originalUrl, boundedInteger(options.imageMaxBytes, 32, 64 * 1024 * 1024, DEFAULT_IMAGE_MAX_BYTES));
    format = detectImageFormat(bytes);
    if (!format) throw new Error("Inline image magic is invalid");
  } else {
    const downloaded = await fetchBoundedImage(originalUrl, {
      ...options,
      referer: reference.referer,
    });
    bytes = downloaded.bytes;
    format = { extension: downloaded.extension, mimeType: downloaded.mimeType };
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sourceDir = path.join(assetDir, sourceId);
  const filename = `${sha256}.${format.extension}`;
  const destination = path.join(sourceDir, filename);
  await fs.mkdir(sourceDir, { recursive: true });
  try {
    await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await fs.access(destination, fsConstants.R_OK);
    const existing = await fs.readFile(destination);
    const existingHash = createHash("sha256").update(existing).digest("hex");
    if (existingHash !== sha256) throw new Error(`Cached news asset failed its content hash: ${destination}`);
  }
  return {
    originalUrl,
    cachedUrl: `${publicBase}/${encodeURIComponent(sourceId)}/${filename}`,
    sha256,
    mimeType: format.mimeType,
    bytes: bytes.length,
    role,
  };
}

export function assertNormalizedNewsDocument(document) {
  if (!document || typeof document !== "object") throw new Error("News document must be an object");
  if (document.schemaVersion !== NEWS_MIRROR_SCHEMA_VERSION) throw new Error("Invalid news document schema version");
  if (!/^news:(?:kcna|rodong-sinmun):[a-f0-9]{24}$/u.test(String(document.id || ""))) throw new Error("Invalid news document id");
  if (!["kcna", "rodong-sinmun"].includes(document.sourceId)) throw new Error("Invalid news source id");
  if (!isPlausibleTitle(document.title)) throw new Error("Invalid news document title");
  if (!/^20\d{2}-\d{2}-\d{2}$/u.test(String(document.date || ""))) throw new Error("Invalid news document date");
  if (!/^https?:\/\//u.test(String(document.url || ""))) throw new Error("Invalid news document URL");
  if (!Array.isArray(document.images)) throw new Error("News document images must be an array");
  if (!Array.isArray(document.categories) || !document.categories.length) throw new Error("News document categories are required");
  if (!document.category?.id) throw new Error("News document category is required");
  return true;
}

async function crawlKcnaDetail(entry, context) {
  const html = await fetchBoundedHtml(entry.url, context);
  const confirmedTitle = assertKcnaDetailResponseIdentity(html, entry);
  const detail = parseKcnaDetail(html, entry.url, { ...entry, confirmedTitle });
  const parsed = entry.kind === "article"
    ? detail
    : {
      ...detail,
      title: entry.title,
      date: entry.date,
      body: "",
      galleryUrl: "",
      imageUrls: [],
      markers: {
        camera: Boolean(entry.previewImageUrl) || entry.kind === "photo",
        gallery: entry.kind === "photo",
      },
    };
  let imageReferences = parsed.imageUrls.map((reference) => ({ ...reference, referer: entry.url }));
  const preferredPreviewReferences = [];
  let galleryUrl = parsed.galleryUrl;

  if (entry.kind === "photo") {
    galleryUrl = entry.url;
    imageReferences = parseKcnaGalleryImages(html, entry.url);
  } else if (galleryUrl) {
    const galleryHtml = await fetchBoundedHtml(galleryUrl, context);
    imageReferences.push(...parseKcnaGalleryImages(galleryHtml, galleryUrl));
    const officialListPreview = context.kcnaMediaPreviews.get(createNewsUrlIdentity(galleryUrl));
    if (officialListPreview) preferredPreviewReferences.push({ ...officialListPreview });
  }
  if (entry.previewImageUrl) {
    preferredPreviewReferences.push({
      url: entry.previewImageUrl,
      referer: entry.previewReferer || entry.url,
      role: "preview",
    });
  }
  imageReferences = dedupeImageReferences(context.cacheRemoteImages
    ? [...imageReferences, ...preferredPreviewReferences]
    : [...preferredPreviewReferences, ...imageReferences]);
  const { images, errors } = await cacheDocumentImages(imageReferences, context);
  context.imageErrors.push(...errors.map((error) => ({ documentUrl: entry.url, ...error })));
  return makeNormalizedDocument({
    entry,
    parsed,
    sourceId: "kcna",
    sourceName: "조선중앙통신",
    images,
    galleryUrl,
    mirroredAt: context.now,
  });
}

async function crawlRodongDetail(entry, context) {
  if (entry.kind === "photo" && Array.isArray(entry.embeddedImageReferences) && entry.embeddedImageReferences.length) {
    const { images, errors } = await cacheDocumentImages(entry.embeddedImageReferences, context);
    context.imageErrors.push(...errors.map((error) => ({ documentUrl: entry.url, ...error })));
    return makeNormalizedDocument({
      entry,
      parsed: {
        title: entry.title,
        date: entry.date,
        body: entry.title,
        markers: { camera: true, gallery: true },
      },
      sourceId: "rodong-sinmun",
      sourceName: "로동신문",
      images,
      galleryUrl: entry.url,
      mirroredAt: context.now,
    });
  }
  const detailResponse = await fetchRodongDetailHtml(entry.url, context);
  const html = detailResponse.html;
  const parsed = parseRodongDetail(html, entry.url, entry);
  if (detailResponse.expandedFromBytes > 0) {
    assertRodongExpandedDetailIsImageBacked(html, parsed, detailResponse.expandedFromBytes, context);
  }
  const references = [...parsed.imageUrls];
  if (parsed.ajaxDescriptor?.mediaType === 3
    && !references.some((reference) => reference.role === "gallery")) {
    const ajaxGallery = await crawlRodongAjaxGallery(parsed.ajaxDescriptor, context);
    references.push(...ajaxGallery.references);
    context.imageErrors.push(...ajaxGallery.errors.map((error) => ({ documentUrl: entry.url, ...error })));
  }
  if (entry.previewImageUrl) references.push({ url: entry.previewImageUrl, referer: entry.url, role: "preview" });
  const { images, errors } = await cacheDocumentImages(dedupeImageReferences(references), context);
  context.imageErrors.push(...errors.map((error) => ({ documentUrl: entry.url, ...error })));
  return makeNormalizedDocument({
    entry,
    parsed,
    sourceId: "rodong-sinmun",
    sourceName: "로동신문",
    images,
    galleryUrl: "",
    mirroredAt: context.now,
  });
}

async function fetchRodongDetailHtml(url, context) {
  // The auxiliary HTML renderer can preserve readable body text while
  // truncating an inline photo set. Detail media authority therefore stays
  // on the official response; homepage/listing fallback remains separate.
  const regularLimit = Math.min(context.htmlMaxBytes, context.rodongDetailHtmlMaxBytes);
  try {
    return {
      html: await fetchBoundedHtml(url, { ...context, htmlMaxBytes: regularLimit }),
      expandedFromBytes: 0,
    };
  } catch (error) {
    if (context.rodongDetailHtmlMaxBytes <= regularLimit
      || !String(error?.message || error).includes(`Response exceeds ${regularLimit} bytes`)) throw error;
  }
  return {
    html: await fetchBoundedHtml(url, {
      ...context,
      htmlMaxBytes: context.rodongDetailHtmlMaxBytes,
    }),
    expandedFromBytes: regularLimit,
  };
}

function assertRodongExpandedDetailIsImageBacked(html, parsed, regularLimit, context) {
  const htmlBytes = Buffer.byteLength(String(html || ""), "utf8");
  const dataImages = (parsed.imageUrls || []).filter((reference) => (
    /^data:/iu.test(String(reference?.url || ""))
  ));
  const scopedDataBytes = dataImages.reduce((sum, reference) => (
    sum + Buffer.byteLength(String(reference.url), "utf8")
  ), 0);
  if (htmlBytes <= regularLimit
    || dataImages.length === 0
    || scopedDataBytes < Math.ceil(htmlBytes * RODONG_LARGE_DETAIL_DATA_RATIO)) {
    throw new Error("Expanded Rodong detail HTML is not predominantly item-scoped inline image data");
  }
  for (const reference of dataImages) {
    const bytes = decodeBoundedDataImage(reference.url, context.imageMaxBytes);
    if (!detectImageFormat(bytes)) {
      throw new Error("Expanded Rodong detail HTML contains invalid inline image data");
    }
  }
}

async function crawlRodongAjaxGallery(descriptor, context) {
  const references = [];
  const errors = [];
  let envelope;
  try {
    const response = await fetchRodongAjax(descriptor, { action: "C", photoNumber: 1 }, context);
    envelope = parseRodongAjaxResponse(response, descriptor.newsId);
    references.push(...parseRodongAjaxGalleryReferences(envelope.html, descriptor));
  } catch (error) {
    errors.push({ url: descriptor.endpointUrl, error: `Rodong gallery metadata failed: ${String(error?.message || error)}` });
    return { references, errors };
  }

  const targetCount = Math.min(envelope.photoCount, context.maxImagesPerDocument);
  if (envelope.photoCount > targetCount) {
    const skipped = envelope.photoCount - targetCount;
    recordSkippedImageReferences(context, skipped);
    errors.push({
      url: descriptor.endpointUrl,
      error: `Document image limit is ${context.maxImagesPerDocument}; skipped ${skipped} Rodong gallery reference(s)`,
    });
  }
  for (let photoNumber = references.length ? 2 : 1;
    photoNumber <= targetCount && dedupeImageReferences(references).length < targetCount;
    photoNumber += 1) {
    try {
      const html = await fetchRodongAjax(descriptor, { action: "P", photoNumber }, context);
      references.push(...parseRodongAjaxGalleryReferences(html, descriptor));
    } catch (error) {
      errors.push({
        url: descriptor.endpointUrl,
        error: `Rodong gallery photo ${photoNumber} failed: ${String(error?.message || error)}`,
      });
    }
  }
  const deduped = dedupeImageReferences(references);
  if (deduped.length < targetCount) {
    errors.push({
      url: descriptor.endpointUrl,
      error: `Rodong gallery exposed ${deduped.length}/${targetCount} bounded image reference(s)`,
    });
  }
  return { references: deduped, errors };
}

async function fetchRodongAjax(descriptor, { action, photoNumber }, context) {
  if (!isRodongAjaxEndpoint(descriptor.endpointUrl, descriptor.detailUrl)) {
    throw new Error("Rodong gallery AJAX endpoint is invalid");
  }
  const form = {
    chAction: action,
    strSchKey: "",
    strNewsID: descriptor.newsId,
    iThemeID: descriptor.themeId,
    iPhotoNo: photoNumber,
    iSelType: 3,
    dPublish: descriptor.publishDate,
    iViewWidth: RODONG_AJAX_VIEW_WIDTH,
    iViewHeight: RODONG_AJAX_VIEW_HEIGHT,
  };
  let lastError;
  for (let attempt = 0; attempt <= context.ajaxRetryAttempts; attempt += 1) {
    try {
      return await fetchBoundedForm(descriptor.endpointUrl, form, {
        ...context,
        referer: descriptor.detailUrl,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= context.ajaxRetryAttempts || !isRetryableRequestError(error)) break;
      await retryDelay(context.retryDelayMs, attempt);
    }
  }
  throw lastError;
}

function parseRodongAjaxGalleryReferences(html, descriptor) {
  const scripted = parseRodongScriptGalleryReferences(html, descriptor.detailUrl, descriptor.newsId);
  const $ = cheerio.load(String(html || ""));
  removeNonContentNodes($);
  const root = $(".photo-carousel, #carouselData, .slide").first().length
    ? $(".photo-carousel, #carouselData, .slide").first()
    : $("body").first();
  const inline = collectImageReferences($, root, descriptor.detailUrl, {
    sourceId: "rodong-sinmun",
    role: "gallery",
  }).filter((reference) => {
    const decoded = decodeRodongToken(reference.url);
    return /^2@@@@p@0@/u.test(decoded) && decoded.includes(`/${descriptor.newsId}/`);
  });
  return dedupeImageReferences([...scripted, ...inline]);
}

async function cacheDocumentImages(references, context) {
  const errors = [];
  const candidates = Array.from(references || []);
  recordDiscoveredImageReferences(context, candidates.length);
  const limitedReferences = candidates.slice(0, context.maxImagesPerDocument);
  if (candidates.length > limitedReferences.length) {
    const skipped = candidates.length - limitedReferences.length;
    recordSkippedImageReferences(context, skipped);
    errors.push({
      url: redactDataUrl(candidates[limitedReferences.length]?.url),
      error: `Document image limit is ${context.maxImagesPerDocument}; skipped ${skipped} reference(s)`,
    });
  }
  const results = await mapLimit(limitedReferences, context.imageConcurrency, async (reference) => {
    if (!context.cacheRemoteImages && !/^data:/iu.test(String(reference?.url || ""))) {
      try {
        const image = makeRemoteImageDescriptor(reference, context.sourceId);
        recordRemoteImageReference(context);
        return image;
      } catch (error) {
        recordFailedImageReference(context);
        errors.push({ url: redactDataUrl(reference?.url), error: String(error?.message || error) });
        return null;
      }
    }
    let lastError;
    for (let attempt = 0; attempt <= context.imageRetryAttempts; attempt += 1) {
      const reservation = reserveImageBudget(context);
      if (!reservation.ok) {
        recordSkippedImageReferences(context, 1);
        errors.push({ url: redactDataUrl(reference.url), error: reservation.error });
        return null;
      }
      if (attempt > 0) recordImageRetry(context);
      try {
        const image = await cacheNewsImage(reference, {
          ...context,
          imageMaxBytes: reservation.maxBytes,
        });
        finishImageBudgetReservation(reservation, image.bytes, true);
        return image;
      } catch (error) {
        if (!reservation.finished) finishImageBudgetReservation(reservation, 0, false);
        lastError = error;
        if (attempt >= context.imageRetryAttempts || !isRetryableRequestError(error)) break;
        await retryDelay(context.retryDelayMs, attempt);
      }
    }
    recordFailedImageReference(context);
    errors.push({ url: redactDataUrl(reference.url), error: String(lastError?.message || lastError) });
    return null;
  });
  const images = [];
  const seen = new Set();
  for (const image of results) {
    const key = String(image?.sha256 || image?.cachedUrl || image?.originalUrl || "");
    if (!image || !key || seen.has(key)) continue;
    images.push(image);
    seen.add(key);
  }
  return { images, errors };
}

function makeRemoteImageDescriptor(reference, sourceId = "") {
  const originalUrl = normalizeHttpUrl(reference?.url);
  const referer = normalizeHttpUrl(reference?.referer || "");
  if (new URL(originalUrl).origin !== new URL(referer).origin) {
    throw new Error("Remote image must share its article or gallery origin");
  }
  if (sourceId === "rodong-sinmun" && !parseRodongNewsImageToken(originalUrl)) {
    throw new Error("Remote Rodong reference is not an official image token");
  }
  return {
    originalUrl,
    cachedUrl: "",
    sha256: "",
    mimeType: "",
    bytes: 0,
    role: String(reference?.role || "inline"),
  };
}

function makeNormalizedDocument({ entry, parsed, sourceId, sourceName, images, galleryUrl, mirroredAt }) {
  const title = normalizedText(parsed.title || entry.title);
  const date = normalizeDate(parsed.date || entry.date);
  const body = normalizedBody(parsed.body);
  if (!isPlausibleTitle(title)) throw new Error(`Detail title is missing: ${entry.url}`);
  if (!date) throw new Error(`Detail date is missing: ${entry.url}`);
  if (entry.kind === "article" && !body) throw new Error(`Detail body is missing: ${entry.url}`);
  const document = {
    schemaVersion: NEWS_MIRROR_SCHEMA_VERSION,
    id: `news:${sourceId}:${createHash("sha256").update(entry.url).digest("hex").slice(0, 24)}`,
    sourceId,
    sourceName,
    language: "ko",
    category: { id: String(entry.category?.id || "uncategorized"), label: String(entry.category?.label || "") },
    categories: normalizeEntryCategories(entry),
    categoryOrders: mergeOfficialCategoryOrders(entry.categoryOrders),
    kind: ["article", "photo", "video"].includes(entry.kind) ? entry.kind : "article",
    title,
    date,
    url: entry.url,
    body,
    images,
    thumbnailUrl: images[0]?.cachedUrl || images[0]?.originalUrl || "",
    markers: {
      camera: parsed.markers?.camera === true || entry.markers?.camera === true || images.length > 0,
      gallery: parsed.markers?.gallery === true || entry.markers?.gallery === true || Boolean(galleryUrl),
    },
    galleryUrl: galleryUrl || "",
    mirroredAt: mirroredAt.toISOString(),
  };
  assertNormalizedNewsDocument(document);
  return document;
}

async function crawlDetailWithRetries(entry, context, crawler) {
  let lastError;
  for (let attempt = 0; attempt <= context.detailRetryAttempts; attempt += 1) {
    if (attempt > 0) {
      context.detailRetryCount += 1;
      await retryDelay(context.retryDelayMs, attempt - 1);
    }
    try {
      return await crawler(entry, context);
    } catch (error) {
      lastError = error;
      if (attempt >= context.detailRetryAttempts || !isRetryableRequestError(error)) break;
    }
  }
  if (context.sourceId === "kcna"
    && entry.kind === "photo"
    && lastError?.code === "KCNA_UPSTREAM_IDENTITY_MISMATCH"
    && isKcnaPhotoListingPreviewFallbackEligible(entry, context)) {
    return crawlKcnaPhotoListingPreviewFallback(entry, context, lastError);
  }
  throw lastError || new Error(`Detail crawl failed: ${entry.url}`);
}

async function crawlKcnaPhotoListingPreviewFallback(entry, context, identityError) {
  if (!isKcnaPhotoListingPreviewFallbackEligible(entry, context)) throw identityError;
  const previewIdentity = createKcnaPreviewIdentity(entry.previewImageUrl, context.imageMaxBytes);
  const { images, errors } = await cacheDocumentImages([{
    url: entry.previewImageUrl,
    referer: entry.previewReferer || entry.url,
    role: "preview",
  }], context);
  context.imageErrors.push(...errors.map((error) => ({ documentUrl: entry.url, ...error })));
  if (images.length !== 1 || !imageMatchesPreviewIdentity(images[0], previewIdentity)) throw identityError;
  return makeNormalizedDocument({
    entry,
    parsed: {
      title: entry.title,
      date: entry.date,
      body: "",
      markers: { camera: true, gallery: true },
    },
    sourceId: "kcna",
    sourceName: "조선중앙통신",
    images,
    galleryUrl: entry.url,
    mirroredAt: context.now,
  });
}

function isKcnaPhotoListingPreviewFallbackEligible(entry, context) {
  try {
    const detailUrl = new URL(normalizeHttpUrl(entry?.url));
    const listingUrl = new URL(normalizeHttpUrl(entry?.previewReferer));
    if (context?.sourceId !== "kcna"
      || entry?.kind !== "photo"
      || classifyKcnaDetailPath(detailUrl.pathname) !== "photo"
      || detailUrl.origin !== listingUrl.origin
      || !/^\/kp\/gallery\/list\/[-a-z0-9.]+\/?$/iu.test(listingUrl.pathname)) return false;
    const preview = String(entry?.previewImageUrl || "").trim();
    if (!/^data:/iu.test(preview) && new URL(normalizeHttpUrl(preview)).origin !== detailUrl.origin) return false;
    return Boolean(createKcnaPreviewIdentity(preview, context.imageMaxBytes));
  } catch {
    return false;
  }
}

async function fetchKcnaListingWithRetries(task, category, context) {
  let lastError;
  for (let attempt = 0; attempt <= context.listingRetryAttempts; attempt += 1) {
    if (attempt > 0) await retryDelay(context.retryDelayMs, attempt - 1);
    try {
      const html = task.form
        ? await fetchBoundedForm(task.url, task.form, {
          ...context,
          referer: category.url,
          requestedWith: false,
        })
        : await fetchBoundedHtml(task.url, context);
      const parsed = parseKcnaListing(html, task.url, category);
      if (task.expectedPage && parsed.pagination
        && parsed.pagination.currentPage !== task.expectedPage) {
        throw makeKcnaUpstreamIdentityError(
          `pagination returned page ${parsed.pagination.currentPage}, expected ${task.expectedPage}`,
        );
      }
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt >= context.listingRetryAttempts || !isRetryableRequestError(error)) break;
    }
  }
  throw lastError || new Error(`KCNA listing crawl failed: ${task.url}`);
}

async function fetchRodongHomepageWithRetries(homepageUrl, categoryLabels, context) {
  let lastError;
  for (let attempt = 0; attempt <= context.listingRetryAttempts; attempt += 1) {
    if (attempt > 0) await retryDelay(context.retryDelayMs, attempt - 1);
    try {
      const html = await fetchRodongHtml(homepageUrl, context);
      return parseRodongHomepageCategories(html, homepageUrl, categoryLabels);
    } catch (error) {
      lastError = error;
      if (attempt >= context.listingRetryAttempts || !isRetryableRequestError(error)) break;
    }
  }
  throw lastError || new Error(`Rodong homepage crawl failed: ${homepageUrl}`);
}

async function fetchRodongListingWithRetries(task, category, context) {
  let lastError;
  for (let attempt = 0; attempt <= context.listingRetryAttempts; attempt += 1) {
    if (attempt > 0) await retryDelay(context.retryDelayMs, attempt - 1);
    try {
      const html = await fetchRodongHtml(task.url, context);
      return parseRodongListing(html, task.url, category);
    } catch (error) {
      lastError = error;
      if (attempt >= context.listingRetryAttempts || !isRetryableRequestError(error)) break;
    }
  }
  throw lastError || new Error(`Rodong listing crawl failed: ${task.url}`);
}

function assertKcnaDetailResponseIdentity(html, entry) {
  const detailUrl = normalizeHttpUrl(entry?.url);
  const expectedKind = String(entry?.kind || classifyKcnaDetailPath(new URL(detailUrl).pathname));
  const actualPathKind = classifyKcnaDetailPath(new URL(detailUrl).pathname);
  if (!actualPathKind || actualPathKind !== expectedKind) {
    throw makeKcnaUpstreamIdentityError(`requested detail kind does not match ${expectedKind}`);
  }

  const $ = cheerio.load(String(html || ""));
  if (normalizedLabel($("body").first().attr("lang")).toLowerCase() !== "ko") {
    throw makeKcnaUpstreamIdentityError("response language is not Korean");
  }

  const expectedRoot = expectedKind === "article"
    ? $("main article")
    : expectedKind === "photo"
      ? $("main.gallery, main .gallery")
      : $("main.video, main .video");
  if (!expectedRoot.length) {
    throw makeKcnaUpstreamIdentityError(`response is missing its ${expectedKind} detail root`);
  }

  if (expectedKind === "article") {
    const activeDetailLinks = $("a.active[lang='ko'][href]").toArray().flatMap((element) => {
      const candidate = resolveSameOriginUrl($(element).attr("href"), detailUrl);
      return candidate && classifyKcnaDetailPath(new URL(candidate).pathname)
        ? [candidate]
        : [];
    });
    if (activeDetailLinks.length) {
      if (activeDetailLinks.some((candidate) => (
        classifyKcnaDetailPath(new URL(candidate).pathname) !== "article"
        || createNewsUrlIdentity(candidate) !== createNewsUrlIdentity(detailUrl)
      ))) {
        throw makeKcnaUpstreamIdentityError("article language link does not match the requested detail URL");
      }
    } else if (!hasKcnaArticleDetailStylesheet($, detailUrl)) {
      throw makeKcnaUpstreamIdentityError("article response has neither an exact language link nor its detail stylesheet");
    }
  }

  const expectedTitle = normalizedText(stripTrailingDate(entry?.title));
  const responseTitle = collectKcnaResponseTitleCandidates($, expectedRoot)
    .find((candidate) => normalizedText(candidate) === expectedTitle);
  if (!responseTitle) {
    throw makeKcnaUpstreamIdentityError("response title does not match the requested listing item");
  }
  return responseTitle;
}

function collectKcnaResponseTitleCandidates($, root) {
  const result = [];
  const seen = new Set();
  const append = (value, metadata = false) => {
    const candidate = stripTrailingDate(metadata ? stripKcnaMetadataTitleMarkup(value) : value);
    const identity = normalizedText(candidate);
    if (!isPlausibleTitle(candidate) || seen.has(identity)) return;
    result.push(candidate);
    seen.add(identity);
  };
  const selectors = [
    ".article_title", ".article-title", ".news_title", ".news-title", "h1", "h2",
  ];
  for (const selector of selectors) {
    const elements = [
      ...(root.is(selector) ? root.toArray() : []),
      ...root.find(selector).toArray(),
    ];
    elements.forEach((element) => append($(element).text()));
  }
  append(
    normalizedText($("title").first().text()).replace(/^조선중앙통신\s*\|\s*/u, ""),
    true,
  );
  return result;
}

function stripKcnaMetadataTitleMarkup(value) {
  return String(value || "").replace(/<\/?(?:b|strong|em|i|nobr|august_name)\s*>/giu, "");
}

function hasKcnaArticleDetailStylesheet($, detailUrl) {
  return $("link[rel~='stylesheet'][href]").toArray().some((element) => {
    const candidate = resolveSameOriginUrl($(element).attr("href"), detailUrl);
    return candidate && /\/css\/article_detail(?:\.min)?\.css$/iu.test(new URL(candidate).pathname);
  });
}

function makeKcnaUpstreamIdentityError(message) {
  const error = new Error(`KCNA upstream identity mismatch: ${message}`);
  error.code = "KCNA_UPSTREAM_IDENTITY_MISMATCH";
  return error;
}

function findReusableKnownDocument(entry, context) {
  if (context.fullBackfill) return null;
  const identity = createNewsUrlIdentity(entry.url);
  const known = context.knownDocuments.get(identity);
  if (!known || known.sourceId !== context.sourceId) return null;
  if (context.knownReuseBlocked.has(identity)) return null;
  if (normalizeDate(known.date) !== normalizeDate(entry.date)) return null;
  if (normalizedText(known.title) !== normalizedText(entry.title)) return null;
  if (String(known.kind || "article") !== String(entry.kind || "article")) return null;
  const body = normalizedBody(known.body);
  if (entry.kind === "article" && (!body || body === normalizedText(known.title))) return null;
  const images = Array.isArray(known.images) ? known.images.filter(isReusableImageDescriptor) : [];
  const expectsImages = entry.kind === "photo"
    || entry.markers?.camera === true
    || entry.markers?.gallery === true
    || Boolean(entry.previewImageUrl);
  if (expectsImages && images.length === 0) return null;
  let exactPreviewIdentity = "";
  if (context.sourceId === "kcna" && ["photo", "video"].includes(entry.kind)) {
    exactPreviewIdentity = createKcnaPreviewIdentity(entry.previewImageUrl, context.imageMaxBytes);
    const exactPreviewImages = images.filter((image) => (
      imageMatchesPreviewIdentity(image, exactPreviewIdentity)
    ));
    if (!exactPreviewIdentity
      || exactPreviewImages.length === 0
      || exactPreviewImages.length !== images.length) {
      return null;
    }
  }
  if (isWithinRecentDetailWindow(entry.date, context.now, context.recentDetailDays)) return null;
  return { ...known, body, images, exactPreviewIdentity };
}

function makeReusedDocument(entry, known, context) {
  const images = known.images.map((image) => ({ ...image }));
  if (known.exactPreviewIdentity) {
    const previewIndex = images.findIndex((image) => (
      imageMatchesPreviewIdentity(image, known.exactPreviewIdentity)
    ));
    if (previewIndex > 0) images.unshift(images.splice(previewIndex, 1)[0]);
    if (images[0]) images[0].role = "preview";
  }
  const isKcnaMedia = context.sourceId === "kcna" && ["photo", "video"].includes(entry.kind);
  const document = {
    schemaVersion: NEWS_MIRROR_SCHEMA_VERSION,
    id: `news:${context.sourceId}:${createHash("sha256").update(entry.url).digest("hex").slice(0, 24)}`,
    sourceId: context.sourceId,
    sourceName: context.sourceId === "rodong-sinmun" ? "로동신문" : "조선중앙통신",
    language: "ko",
    category: { id: String(entry.category?.id || "uncategorized"), label: String(entry.category?.label || "") },
    categories: normalizeEntryCategories(entry),
    categoryOrders: mergeOfficialCategoryOrders(entry.categoryOrders),
    kind: ["article", "photo", "video"].includes(entry.kind) ? entry.kind : "article",
    title: normalizedText(entry.title),
    date: normalizeDate(entry.date),
    url: entry.url,
    body: isKcnaMedia ? "" : normalizedBody(known.body),
    images,
    thumbnailUrl: String(known.exactPreviewIdentity
      ? images[0]?.cachedUrl || images[0]?.originalUrl || ""
      : known.thumbnailUrl || images[0]?.cachedUrl || images[0]?.originalUrl || ""),
    markers: {
      camera: entry.markers?.camera === true || known.markers?.camera === true || images.length > 0,
      gallery: entry.markers?.gallery === true || known.markers?.gallery === true || Boolean(known.galleryUrl),
    },
    galleryUrl: String(known.galleryUrl || ""),
    mirroredAt: context.now.toISOString(),
  };
  assertNormalizedNewsDocument(document);
  return document;
}

function createKnownDocumentReuseState(value, sourceId) {
  const index = new Map();
  for (const candidate of Array.isArray(value) ? value : []) {
    if (!candidate || candidate.sourceId !== sourceId) continue;
    try {
      assertNormalizedNewsDocument(candidate);
      index.set(createNewsUrlIdentity(candidate.url), candidate);
    } catch {
      // An incomplete legacy record is deliberately ignored and fetched again.
    }
  }
  const documentsByImageSet = new Map();
  for (const [identity, document] of index) {
    const imageSet = createKnownImageSetIdentity(document.images);
    if (!imageSet) continue;
    const records = documentsByImageSet.get(imageSet) || [];
    records.push({ identity, document });
    documentsByImageSet.set(imageSet, records);
  }
  const blocked = new Set();
  for (const records of documentsByImageSet.values()) {
    if (records.length < 2) continue;
    const articleSignatures = new Set(records.map(({ document }) => (
      `${normalizedText(document.title)}\u0000${normalizeDate(document.date)}`
    )));
    // The same official story may legitimately appear as an article and a
    // gallery. Only cross-title/date collisions are treated as contamination.
    if (articleSignatures.size < 2) continue;
    for (const { identity } of records) blocked.add(identity);
  }
  return { index, blocked };
}

function createKnownImageSetIdentity(images) {
  const identities = new Set();
  for (const image of Array.isArray(images) ? images : []) {
    const sha256 = String(image?.sha256 || "").toLowerCase();
    if (/^[a-f0-9]{64}$/u.test(sha256)) {
      identities.add(`sha256:${sha256}`);
      continue;
    }
    const cachedHash = String(image?.cachedUrl || "").match(/\/([a-f0-9]{64})\.(?:jpg|png|gif|webp)(?:$|[?#])/iu)?.[1]?.toLowerCase();
    if (cachedHash) {
      identities.add(`sha256:${cachedHash}`);
      continue;
    }
    try {
      identities.add(`url:${normalizeHttpUrl(image?.originalUrl)}`);
    } catch {
      // Descriptors without a stable content or official URL identity do not
      // participate in the collision guard.
    }
  }
  if (identities.size < SUSPICIOUS_SHARED_IMAGE_SET_MINIMUM) return "";
  return [...identities].sort().join("\n");
}

function createKcnaPreviewIdentity(value, maxBytes) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  if (/^data:/iu.test(candidate)) {
    try {
      const bytes = decodeBoundedDataImage(candidate, maxBytes);
      if (!detectImageFormat(bytes)) return "";
      return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    } catch {
      return "";
    }
  }
  try {
    return `url:${normalizeHttpUrl(candidate)}`;
  } catch {
    return "";
  }
}

function imageMatchesPreviewIdentity(image, identity) {
  const expected = String(identity || "");
  if (!expected) return false;
  if (expected.startsWith("sha256:")) {
    const expectedHash = expected.slice("sha256:".length);
    const descriptorHash = String(image?.sha256 || "").toLowerCase();
    if (descriptorHash === expectedHash) return true;
    const cachedHash = String(image?.cachedUrl || "")
      .match(/\/([a-f0-9]{64})\.(?:jpg|png|gif|webp)(?:$|[?#])/iu)?.[1]?.toLowerCase();
    return cachedHash === expectedHash;
  }
  if (!expected.startsWith("url:")) return false;
  try {
    return `url:${normalizeHttpUrl(image?.originalUrl)}` === expected;
  } catch {
    return false;
  }
}

function createNewsUrlIdentity(value) {
  const url = new URL(normalizeHttpUrl(value));
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.href;
}

function isReusableImageDescriptor(value) {
  return Boolean(String(value?.cachedUrl || "").trim() || String(value?.originalUrl || "").trim());
}

function isWithinRecentDetailWindow(date, now, days) {
  const timestamp = Date.parse(`${normalizeDate(date)}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return true;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageDays = Math.floor((today - timestamp) / 86_400_000);
  return ageDays <= days;
}

function createCrawlContext(options) {
  const now = normalizeNow(options.now);
  const sourceId = normalizeSourceId(options.sourceId);
  const imageBudget = isImageBudget(options.imageBudget)
    ? options.imageBudget
    : createImageBudget(options, false);
  const knownDocumentState = createKnownDocumentReuseState(options.knownDocuments, sourceId);
  return {
    sourceId,
    fetchImpl: options.fetchImpl,
    assetDir: path.resolve(options.assetDir || DEFAULT_NEWS_ASSET_DIR),
    publicAssetBase: normalizePublicBase(options.publicAssetBase || DEFAULT_NEWS_PUBLIC_ASSET_BASE),
    timeoutMs: boundedInteger(options.timeoutMs, 100, 120_000, DEFAULT_TIMEOUT_MS),
    htmlMaxBytes: boundedInteger(options.htmlMaxBytes, 1_024, 64 * 1024 * 1024, DEFAULT_HTML_MAX_BYTES),
    rodongDetailHtmlMaxBytes: boundedInteger(
      options.rodongDetailHtmlMaxBytes,
      1_024,
      DEFAULT_RODONG_DETAIL_HTML_MAX_BYTES,
      DEFAULT_RODONG_DETAIL_HTML_MAX_BYTES,
    ),
    imageMaxBytes: boundedInteger(options.imageMaxBytes, 32, 64 * 1024 * 1024, DEFAULT_IMAGE_MAX_BYTES),
    maxRedirects: boundedInteger(options.maxRedirects, 0, 10, DEFAULT_MAX_REDIRECTS),
    maxImagesPerDocument: boundedInteger(
      options.maxImagesPerDocument,
      0,
      100,
      DEFAULT_MAX_IMAGES_PER_DOCUMENT,
    ),
    detailConcurrency: boundedInteger(options.detailConcurrency, 1, 16, DEFAULT_DETAIL_CONCURRENCY),
    imageConcurrency: boundedInteger(options.imageConcurrency, 1, 12, DEFAULT_IMAGE_CONCURRENCY),
    listingRetryAttempts: boundedInteger(
      options.listingRetryAttempts,
      0,
      4,
      sourceId === "rodong-sinmun"
        ? DEFAULT_RODONG_LISTING_RETRY_ATTEMPTS
        : DEFAULT_LISTING_RETRY_ATTEMPTS,
    ),
    detailRetryAttempts: boundedInteger(
      options.detailRetryAttempts,
      1,
      4,
      sourceId === "rodong-sinmun" ? 4 : DEFAULT_DETAIL_RETRY_ATTEMPTS,
    ),
    detailRetryCount: 0,
    imageRetryAttempts: boundedInteger(options.imageRetryAttempts, 0, 3, DEFAULT_IMAGE_RETRY_ATTEMPTS),
    ajaxRetryAttempts: boundedInteger(options.ajaxRetryAttempts, 0, 2, 1),
    retryDelayMs: boundedInteger(options.retryDelayMs, 0, 5_000, DEFAULT_IMAGE_RETRY_DELAY_MS),
    recentDetailDays: boundedInteger(options.recentDetailDays, 0, 3_650, DEFAULT_RECENT_DETAIL_DAYS),
    fullBackfill: options.fullBackfill === true,
    knownDocuments: knownDocumentState.index,
    knownReuseBlocked: knownDocumentState.blocked,
    preferNodeDirect: options.preferNodeDirect === true
      || (options.preferNodeDirect !== false && options.fetchImpl === globalThis.fetch),
    allowNodeFallback: options.allowNodeFallback === true,
    cacheRemoteImages: options.cacheRemoteImages !== false,
    cookieJar: options.cookieJar instanceof Map ? options.cookieJar : new Map(),
    nodeAddressResolver: typeof options.nodeAddressResolver === "function" ? options.nodeAddressResolver : undefined,
    nodeAddressAttemptObserver: typeof options.nodeAddressAttemptObserver === "function"
      ? options.nodeAddressAttemptObserver
      : undefined,
    nodeAddressAttemptTimeoutMs: boundedInteger(
      options.nodeAddressAttemptTimeoutMs,
      100,
      30_000,
      DEFAULT_NODE_ADDRESS_ATTEMPT_MS,
    ),
    imageBudget,
    now,
    imageErrors: [],
    htmlFallbacks: [],
    kcnaMediaPreviews: new Map(),
  };
}

function createImageBudget(options = {}, sharedAcrossSources = false) {
  const maxImages = boundedInteger(
    options.maxImagesPerCrawl,
    0,
    20_000,
    DEFAULT_MAX_IMAGES_PER_CRAWL,
  );
  const maxBytes = boundedInteger(
    options.maxImageBytesPerCrawl,
    0,
    8 * 1024 * 1024 * 1024,
    DEFAULT_MAX_IMAGE_BYTES_PER_CRAWL,
  );
  return {
    kind: "news-image-budget-v1",
    maxImages,
    maxBytes,
    maxImagesPerSource: boundedInteger(
      options.maxImagesPerSource,
      0,
      20_000,
      maxImages,
    ),
    maxBytesPerSource: boundedInteger(
      options.maxImageBytesPerSource,
      0,
      8 * 1024 * 1024 * 1024,
      maxBytes,
    ),
    requestsStarted: 0,
    bytesCharged: 0,
    bytesReserved: 0,
    sharedAcrossSources,
    sources: new Map(),
  };
}

function isImageBudget(value) {
  return value?.kind === "news-image-budget-v1"
    && value.sources instanceof Map
    && Number.isInteger(value.maxImages)
    && Number.isInteger(value.maxBytes)
    && Number.isInteger(value.maxImagesPerSource)
    && Number.isInteger(value.maxBytesPerSource);
}

function getImageBudgetSourceStats(context) {
  const budget = context.imageBudget;
  let stats = budget.sources.get(context.sourceId);
  if (!stats) {
    stats = {
      requestsStarted: 0,
      successfulImages: 0,
      acceptedBytes: 0,
      quotaBytesCharged: 0,
      bytesReserved: 0,
      referencesDiscovered: 0,
      skippedReferences: 0,
      remoteReferencesEmitted: 0,
      failedReferences: 0,
      failedAttempts: 0,
      retryAttempts: 0,
    };
    budget.sources.set(context.sourceId, stats);
  }
  return stats;
}

function reserveImageBudget(context) {
  const budget = context.imageBudget;
  const sourceStats = getImageBudgetSourceStats(context);
  if (budget.requestsStarted >= budget.maxImages) {
    return { ok: false, error: `Crawl image request limit of ${budget.maxImages} reached` };
  }
  if (sourceStats.requestsStarted >= budget.maxImagesPerSource) {
    return { ok: false, error: `Source image request limit of ${budget.maxImagesPerSource} reached` };
  }
  const availableBytes = budget.maxBytes - budget.bytesCharged - budget.bytesReserved;
  if (availableBytes < 32) {
    return { ok: false, error: `Crawl image byte limit of ${budget.maxBytes} reached` };
  }
  const sourceAvailableBytes = budget.maxBytesPerSource - sourceStats.quotaBytesCharged - sourceStats.bytesReserved;
  if (sourceAvailableBytes < 32) {
    return { ok: false, error: `Source image byte limit of ${budget.maxBytesPerSource} reached` };
  }
  const maxBytes = Math.min(context.imageMaxBytes, availableBytes, sourceAvailableBytes);
  budget.requestsStarted += 1;
  budget.bytesReserved += maxBytes;
  sourceStats.requestsStarted += 1;
  sourceStats.bytesReserved += maxBytes;
  return {
    ok: true,
    budget,
    sourceStats,
    maxBytes,
    finished: false,
  };
}

function finishImageBudgetReservation(reservation, acceptedBytes, succeeded) {
  if (reservation.finished) throw new Error("Image budget reservation was already finished");
  const byteLength = Number(acceptedBytes);
  if (succeeded && (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > reservation.maxBytes)) {
    throw new Error("Cached image exceeded its crawl budget reservation");
  }
  reservation.finished = true;
  const chargedBytes = succeeded ? byteLength : 0;
  reservation.budget.bytesReserved -= reservation.maxBytes;
  reservation.budget.bytesCharged += chargedBytes;
  reservation.sourceStats.bytesReserved -= reservation.maxBytes;
  reservation.sourceStats.quotaBytesCharged += chargedBytes;
  if (succeeded) {
    reservation.sourceStats.successfulImages += 1;
    reservation.sourceStats.acceptedBytes += byteLength;
  } else {
    reservation.sourceStats.failedAttempts += 1;
  }
}

function recordDiscoveredImageReferences(context, count) {
  getImageBudgetSourceStats(context).referencesDiscovered += count;
}

function recordSkippedImageReferences(context, count) {
  getImageBudgetSourceStats(context).skippedReferences += count;
}

function recordRemoteImageReference(context) {
  getImageBudgetSourceStats(context).remoteReferencesEmitted += 1;
}

function recordFailedImageReference(context) {
  getImageBudgetSourceStats(context).failedReferences += 1;
}

function recordImageRetry(context) {
  getImageBudgetSourceStats(context).retryAttempts += 1;
}

function makeImageQuotaStats(context) {
  const budget = context.imageBudget;
  const sourceStats = getImageBudgetSourceStats(context);
  return {
    maxImagesPerDocument: context.maxImagesPerDocument,
    maxImagesPerCrawl: budget.maxImages,
    maxBytesPerCrawl: budget.maxBytes,
    maxImagesPerSource: budget.maxImagesPerSource,
    maxBytesPerSource: budget.maxBytesPerSource,
    sharedAcrossSources: budget.sharedAcrossSources,
    cacheRemoteImages: context.cacheRemoteImages,
    requestsStarted: sourceStats.requestsStarted,
    successfulImages: sourceStats.successfulImages,
    acceptedBytes: sourceStats.acceptedBytes,
    quotaBytesCharged: sourceStats.quotaBytesCharged,
    referencesDiscovered: sourceStats.referencesDiscovered,
    skippedReferences: sourceStats.skippedReferences,
    remoteReferencesEmitted: sourceStats.remoteReferencesEmitted,
    failedReferences: sourceStats.failedReferences,
    failedAttempts: sourceStats.failedAttempts,
    retryAttempts: sourceStats.retryAttempts,
  };
}

async function fetchBoundedBytes(url, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  assertFetch(fetchImpl);
  const initialUrl = normalizeHttpUrl(url);
  const initialOrigin = new URL(initialUrl).origin;
  const controller = new AbortController();
  const timeoutMs = boundedInteger(options.timeoutMs, 100, 120_000, DEFAULT_TIMEOUT_MS);
  const maxRedirects = boundedInteger(options.maxRedirects, 0, 10, DEFAULT_MAX_REDIRECTS);
  const method = String(options.method || "GET").toUpperCase();
  if (!["GET", "POST"].includes(method)) throw new Error(`Unsupported request method: ${method}`);
  const body = method === "POST" ? String(options.body || "") : "";
  if (method === "POST" && !body) throw new Error("POST request body is required");
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(new Error(`Request exceeded ${timeoutMs}ms`)), timeoutMs);
  try {
    const headers = {
      Accept: options.accept,
      "Accept-Encoding": "identity",
      Connection: "close",
      "User-Agent": NEWS_USER_AGENT,
      ...(options.extraHeaders || {}),
    };
    if (options.referer) headers.Referer = options.referer;
    if (method === "POST") {
      headers["Content-Type"] = String(options.contentType || "application/x-www-form-urlencoded; charset=UTF-8");
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    if (options.preferNodeDirect) {
      return await fetchBoundedNodeBytes(initialUrl, {
        ...options,
        deadline,
        headers,
        initialOrigin,
        maxRedirects,
        method,
        body,
        cookieJar: options.cookieJar,
        timeoutMs,
      });
    }
    try {
      return await fetchBoundedFetchBytes(initialUrl, {
        controller,
        fetchImpl,
        headers,
        initialOrigin,
        maxBytes: options.maxBytes,
        maxRedirects,
        method,
        body,
        cookieJar: options.cookieJar,
      });
    } catch (error) {
      if (!options.allowNodeFallback) throw error;
      return await fetchBoundedNodeBytes(initialUrl, {
        ...options,
        deadline,
        headers,
        initialOrigin,
        maxRedirects,
        method,
        body,
        cookieJar: options.cookieJar,
        timeoutMs,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBoundedFetchBytes(initialUrl, {
  controller,
  fetchImpl,
  headers,
  initialOrigin,
  maxBytes,
  maxRedirects,
  method,
  body,
  cookieJar,
}) {
  let currentUrl = initialUrl;
  let redirectCount = 0;
  while (true) {
    assertSameOriginDispatch(currentUrl, initialOrigin);
    const response = await fetchImpl(currentUrl, {
      method,
      ...(method === "POST" ? { body } : {}),
      redirect: "manual",
      headers: withCookieHeader(headers, cookieJar, initialOrigin),
      signal: controller.signal,
    });
    if (!response || typeof response.arrayBuffer !== "function") throw new Error("Fetcher returned an invalid response");
    if (response.redirected === true) throw new Error("Fetcher followed a redirect despite manual redirect mode");
    if (response.url) {
      const responseUrl = normalizeHttpUrl(response.url);
      if (new URL(responseUrl).origin !== initialOrigin) throw new Error(`Cross-origin redirect rejected: ${responseUrl}`);
      if (responseUrl !== currentUrl) throw new Error(`Fetcher returned an unexpected response URL: ${responseUrl}`);
    }
    recordResponseCookies(cookieJar, initialOrigin, response.headers);
    const location = String(response.headers?.get?.("location") || "").trim();
    if (isRedirectStatus(response.status) && location) {
      if (redirectCount >= maxRedirects) {
        await cancelResponseBody(response);
        throw new Error(`Redirect limit of ${maxRedirects} exceeded for ${initialUrl}`);
      }
      const nextUrl = resolveSameOriginRedirect(location, currentUrl, initialOrigin);
      await cancelResponseBody(response);
      currentUrl = nextUrl;
      redirectCount += 1;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${currentUrl}`);
    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (contentLength && contentLength > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
    const bytes = await readResponseBytes(response, maxBytes);
    if (!bytes.length) throw new Error(`Empty response from ${currentUrl}`);
    return {
      bytes,
      contentType: String(response.headers?.get?.("content-type") || "").trim().toLowerCase(),
      finalUrl: currentUrl,
    };
  }
}

async function fetchBoundedNodeBytes(url, {
  deadline,
  headers,
  initialOrigin,
  maxBytes,
  maxRedirects,
  method,
  body,
  cookieJar,
  timeoutMs,
  nodeAddressResolver,
  nodeAddressAttemptTimeoutMs,
  nodeAddressAttemptObserver,
}) {
  const initialUrl = normalizeHttpUrl(url);
  let currentUrl = initialUrl;
  let redirectCount = 0;
  const stopAt = Number.isFinite(deadline) ? deadline : Date.now() + timeoutMs;
  while (true) {
    assertSameOriginDispatch(currentUrl, initialOrigin);
    const remainingMs = Math.floor(stopAt - Date.now());
    if (remainingMs < 1) throw new Error(`Request exceeded ${timeoutMs}ms`);
    const result = await fetchBoundedNodeHop(currentUrl, {
      headers: withCookieHeader(headers, cookieJar, initialOrigin),
      maxBytes,
      method,
      body,
      timeoutMs: remainingMs,
      nodeAddressResolver,
      nodeAddressAttemptTimeoutMs,
      nodeAddressAttemptObserver,
    });
    recordSetCookieValues(cookieJar, initialOrigin, result.setCookies);
    if (!result.redirectLocation) return result;
    if (redirectCount >= maxRedirects) throw new Error(`Redirect limit of ${maxRedirects} exceeded for ${initialUrl}`);
    currentUrl = resolveSameOriginRedirect(result.redirectLocation, currentUrl, initialOrigin);
    redirectCount += 1;
  }
}

async function fetchBoundedNodeHop(url, {
  timeoutMs,
  maxBytes,
  headers,
  method,
  body,
  nodeAddressResolver,
  nodeAddressAttemptTimeoutMs = DEFAULT_NODE_ADDRESS_ATTEMPT_MS,
  nodeAddressAttemptObserver,
}) {
  const target = new URL(normalizeHttpUrl(url));
  const addresses = prioritizeHostAddresses(
    target.hostname,
    await resolveHostAddresses(target.hostname, nodeAddressResolver),
  );
  const stopAt = Date.now() + timeoutMs;
  let lastError = null;
  for (let index = 0; index < addresses.length; index += 1) {
    const remainingMs = stopAt - Date.now();
    if (remainingMs < 1) break;
    try {
      nodeAddressAttemptObserver?.({ hostname: target.hostname, ...addresses[index] });
      const result = await fetchBoundedNodeAddressHop(target, {
        timeoutMs: remainingMs,
        connectTimeoutMs: addresses.length > 1
          ? Math.min(remainingMs, nodeAddressAttemptTimeoutMs)
          : remainingMs,
        maxBytes,
        headers,
        method,
        body,
        address: addresses[index],
      });
      rememberWorkingHostAddress(target.hostname, addresses[index]);
      return result;
    } catch (error) {
      lastError = error;
      forgetWorkingHostAddress(target.hostname, addresses[index]);
      if (!isRetryableAddressError(error) || index + 1 >= addresses.length) throw error;
    }
  }
  throw lastError || new Error(`Request exceeded ${timeoutMs}ms`);
}

async function resolveHostAddresses(hostname, resolver) {
  if (typeof resolver === "function") return normalizeResolvedHostAddresses(await resolver(hostname));
  const now = Date.now();
  const cached = nodeDnsCache.get(hostname);
  if (cached && cached.expiresAt > now) return await cached.promise;
  const promise = new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(normalizeResolvedHostAddresses(addresses, hostname));
      } catch (normalizeError) {
        reject(normalizeError);
      }
    });
  });
  nodeDnsCache.set(hostname, { expiresAt: now + NODE_DNS_CACHE_MS, promise });
  try {
    return await promise;
  } catch (error) {
    nodeDnsCache.delete(hostname);
    throw error;
  }
}

function normalizeResolvedHostAddresses(addresses, hostname = "host") {
  const unique = [];
  const seen = new Set();
  for (const entry of addresses || []) {
    const address = String(entry?.address || "");
    const family = Number(entry?.family || 0);
    const key = `${family}:${address}`;
    if (!address || ![4, 6].includes(family) || seen.has(key)) continue;
    seen.add(key);
    unique.push({ address, family });
  }
  if (!unique.length) throw new Error(`DNS returned no usable addresses for ${hostname}`);
  return unique;
}

function prioritizeHostAddresses(hostname, addresses) {
  const affinity = nodeAddressAffinity.get(hostname);
  if (!affinity || affinity.expiresAt <= Date.now()) {
    if (affinity) nodeAddressAffinity.delete(hostname);
    return addresses;
  }
  const preferredIndex = addresses.findIndex((entry) => (
    entry.address === affinity.address && entry.family === affinity.family
  ));
  if (preferredIndex <= 0) return addresses;
  return [addresses[preferredIndex], ...addresses.slice(0, preferredIndex), ...addresses.slice(preferredIndex + 1)];
}

function rememberWorkingHostAddress(hostname, address) {
  nodeAddressAffinity.set(hostname, { ...address, expiresAt: Date.now() + NODE_ADDRESS_AFFINITY_MS });
}

function forgetWorkingHostAddress(hostname, address) {
  const affinity = nodeAddressAffinity.get(hostname);
  if (affinity?.address === address.address && affinity?.family === address.family) {
    nodeAddressAffinity.delete(hostname);
  }
}

function isRetryableAddressError(error) {
  const code = String(error?.code || "");
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT"].includes(code)) return true;
  return /empty response|request exceeded|socket hang up|timed? ?out/iu.test(String(error?.message || error));
}

async function fetchBoundedNodeAddressHop(target, {
  timeoutMs,
  connectTimeoutMs,
  maxBytes,
  headers,
  method,
  body,
  address,
}) {
  const requestModule = target.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let connectTimer;
    const wallClockTimer = setTimeout(() => {
      const error = new Error(`Request exceeded ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      request?.destroy(error);
      finish(error);
    }, timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClockTimer);
      clearTimeout(connectTimer);
      if (error) reject(error);
      else resolve(result);
    };
    request = requestModule.request(target, {
      method,
      agent: false,
      headers,
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options?.all) {
          callback(null, [{ address: address.address, family: address.family }]);
          return;
        }
        callback(null, address.address, address.family);
      },
    }, (response) => {
      const status = Number(response.statusCode || 0);
      const redirectLocation = String(response.headers.location || "").trim();
      const setCookies = response.headers["set-cookie"];
      if (isRedirectStatus(status) && redirectLocation) {
        response.resume();
        finish(null, { redirectLocation, setCookies });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        finish(new Error(`HTTP ${status || "unknown"} for ${target.href}`));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength && declaredLength > maxBytes) {
        response.destroy();
        finish(new Error(`Response exceeds ${maxBytes} bytes`));
        return;
      }
      const chunks = [];
      let byteLength = 0;
      response.on("data", (chunkValue) => {
        if (settled) return;
        const chunk = Buffer.from(chunkValue || []);
        byteLength += chunk.length;
        if (byteLength > maxBytes) {
          response.destroy();
          finish(new Error(`Response exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (!byteLength) {
          finish(new Error(`Empty response from ${target.href}`));
          return;
        }
        finish(null, {
          bytes: Buffer.concat(chunks, byteLength),
          contentType: String(response.headers["content-type"] || "").trim().toLowerCase(),
          finalUrl: target.href,
          setCookies,
        });
      });
      response.on("error", (error) => finish(error));
    });
    request.on("socket", (socket) => {
      const connectedEvent = target.protocol === "https:" ? "secureConnect" : "connect";
      if (!socket.connecting) return;
      connectTimer = setTimeout(() => {
        const error = new Error(`Address connection exceeded ${connectTimeoutMs}ms`);
        error.code = "ETIMEDOUT";
        request.destroy(error);
      }, connectTimeoutMs);
      socket.once(connectedEvent, () => clearTimeout(connectTimer));
    });
    request.setTimeout(timeoutMs, () => {
      const error = new Error(`Request exceeded ${timeoutMs}ms`);
      error.code = "ETIMEDOUT";
      request.destroy(error);
    });
    request.on("error", (error) => finish(error));
    request.end(method === "POST" ? body : undefined);
  });
}

function withCookieHeader(headers, cookieJar, origin) {
  const result = { ...headers };
  if (!(cookieJar instanceof Map)) return result;
  const cookies = cookieJar.get(origin);
  if (!(cookies instanceof Map) || !cookies.size) return result;
  result.Cookie = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  return result;
}

function recordResponseCookies(cookieJar, origin, headers) {
  if (!(cookieJar instanceof Map) || !headers) return;
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : headers.get?.("set-cookie");
  recordSetCookieValues(cookieJar, origin, values);
}

function recordSetCookieValues(cookieJar, origin, values) {
  if (!(cookieJar instanceof Map) || !values) return;
  const headers = Array.isArray(values) ? values : [values];
  let cookies = cookieJar.get(origin);
  if (!(cookies instanceof Map)) {
    cookies = new Map();
    cookieJar.set(origin, cookies);
  }
  for (const header of headers) {
    const source = String(header || "");
    for (const match of source.matchAll(/(?:^|,\s*)([!#$%&'*+.^_`|~0-9A-Za-z-]{1,64})=([^;,\r\n]{0,4096})/gu)) {
      const [, name, value] = match;
      if (!/^[\x21-\x3A\x3C-\x7E]*$/u.test(value)) continue;
      if (!value) {
        cookies.delete(name);
        continue;
      }
      if (!cookies.has(name) && cookies.size >= 16) continue;
      cookies.set(name, value);
    }
  }
  if (!cookies.size) cookieJar.delete(origin);
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function assertSameOriginDispatch(url, initialOrigin) {
  const safeUrl = normalizeHttpUrl(url);
  if (new URL(safeUrl).origin !== initialOrigin) throw new Error(`Cross-origin redirect rejected: ${safeUrl}`);
}

function resolveSameOriginRedirect(location, currentUrl, initialOrigin) {
  let nextUrl;
  try {
    nextUrl = normalizeHttpUrl(new URL(String(location || ""), currentUrl).href);
  } catch {
    throw new Error(`Invalid redirect target from ${currentUrl}`);
  }
  if (new URL(nextUrl).origin !== initialOrigin) throw new Error(`Cross-origin redirect rejected: ${nextUrl}`);
  return nextUrl;
}

async function cancelResponseBody(response) {
  if (typeof response.body?.cancel !== "function") return;
  await response.body.cancel().catch(() => {});
}

async function readResponseBytes(response, maxBytes) {
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

function decodeHtml(bytes, contentType = "") {
  const charset = String(contentType).match(/charset=([^;\s]+)/iu)?.[1]?.toLowerCase() || "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString("utf8");
  }
}

function makeBoundedFormBody(value) {
  const entries = value instanceof URLSearchParams
    ? [...value.entries()]
    : Object.entries(value && typeof value === "object" && !Array.isArray(value) ? value : {});
  if (!entries.length || entries.length > 32) throw new Error("Form fields are invalid");
  const form = new URLSearchParams();
  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey || "");
    const fieldValue = String(rawValue ?? "");
    if (!(key === "_csrf" || /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)) || fieldValue.length > 4_096) {
      throw new Error("Form field is invalid");
    }
    form.append(key, fieldValue);
  }
  const body = form.toString();
  if (!body || Buffer.byteLength(body) > RODONG_AJAX_MAX_FORM_BYTES) throw new Error("Form body is too large");
  return body;
}

function decodeBoundedDataImage(value, maxBytes) {
  const match = String(value || "").match(/^data:(?:image\/[a-z0-9.+-]+)?;base64,([a-z0-9+/=\s]+)$/iu);
  if (!match) throw new Error("Only base64 inline images are supported");
  const payload = match[1].replace(/\s/gu, "");
  if (payload.length > Math.ceil(maxBytes * 4 / 3) + 8) throw new Error(`Inline image exceeds ${maxBytes} bytes`);
  const bytes = Buffer.from(payload, "base64");
  if (!bytes.length || bytes.length > maxBytes) throw new Error(`Inline image exceeds ${maxBytes} bytes`);
  return bytes;
}

function normalizeKcnaCategoryLists(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("KCNA category list configuration is empty");
  return value.map((category) => {
    const url = normalizeHttpUrl(category?.url);
    const kind = String(category?.kind || "article");
    if (!["article", "photo", "video"].includes(kind)) throw new Error(`Invalid KCNA category kind: ${kind}`);
    return { id: String(category?.id || kind), label: String(category?.label || ""), kind, url };
  });
}

function mergeNewsEntry(current, incoming) {
  if (!current) return { ...incoming, categories: normalizeEntryCategories(incoming) };
  const categories = [...new Set([...normalizeEntryCategories(current), ...normalizeEntryCategories(incoming)])];
  return {
    ...current,
    title: current.title.length >= incoming.title.length ? current.title : incoming.title,
    date: current.date || incoming.date,
    previewImageUrl: current.previewImageUrl || incoming.previewImageUrl,
    previewReferer: current.previewReferer || incoming.previewReferer,
    categories,
    categoryOrders: mergeOfficialCategoryOrders(current.categoryOrders, incoming.categoryOrders),
    markers: {
      camera: current.markers?.camera === true || incoming.markers?.camera === true,
      gallery: current.markers?.gallery === true || incoming.markers?.gallery === true,
    },
  };
}

function withOfficialCategoryOrder(entry, categoryId, order) {
  const id = String(categoryId || "").trim();
  const normalizedOrder = Number(order);
  if (!id || !Number.isSafeInteger(normalizedOrder) || normalizedOrder < 0) return entry;
  return {
    ...entry,
    categoryOrders: mergeOfficialCategoryOrders(entry.categoryOrders, { [id]: normalizedOrder }),
  };
}

function mergeOfficialCategoryOrders(left, right) {
  const merged = {};
  for (const source of [left, right]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const [category, rawOrder] of Object.entries(source)) {
      const order = Number(rawOrder);
      if (!category || !Number.isSafeInteger(order) || order < 0) continue;
      merged[category] = merged[category] === undefined ? order : Math.min(merged[category], order);
    }
  }
  return Object.fromEntries(Object.entries(merged).sort(([leftCategory], [rightCategory]) => (
    leftCategory.localeCompare(rightCategory, "en")
  )));
}

function normalizeEntryCategories(entry = {}) {
  return [...new Set([
    ...(Array.isArray(entry.categories) ? entry.categories : []),
    entry.category?.id,
  ].map((category) => String(category || "").trim()).filter(Boolean))];
}

function selectEntriesAcrossCategories(entriesByUrl, categoryIds, limit) {
  const entries = [...entriesByUrl.values()];
  if (entries.length <= limit) return entries;
  const selected = [];
  const selectedUrls = new Set();
  const categoryQueues = [...new Set(categoryIds.map((id) => String(id || "")).filter(Boolean))]
    .map((categoryId) => entries.filter((entry) => normalizeEntryCategories(entry).includes(categoryId)));
  let progressed = true;
  while (selected.length < limit && progressed) {
    progressed = false;
    for (const queue of categoryQueues) {
      while (queue.length && selectedUrls.has(queue[0].url)) queue.shift();
      const entry = queue.shift();
      if (!entry) continue;
      selected.push(entry);
      selectedUrls.add(entry.url);
      progressed = true;
      if (selected.length >= limit) break;
    }
  }
  for (const entry of entries) {
    if (selected.length >= limit) break;
    if (selectedUrls.has(entry.url)) continue;
    selected.push(entry);
    selectedUrls.add(entry.url);
  }
  return selected;
}

function makeListingCategoryStats({
  category,
  visited,
  discoveredPages,
  entries,
  maxListPages,
  maxDocumentsPerCategory,
  entryCapReached,
  listingErrors,
  declaredTotal = null,
  declaredLastPage = null,
  paginationProofRequired = false,
}) {
  const undispatchedPages = [...discoveredPages].filter((pageUrl) => !visited.has(pageUrl));
  const pageCapReached = undispatchedPages.length > 0 && visited.size >= maxListPages;
  const documentCapReached = entryCapReached === true;
  const capReached = pageCapReached || documentCapReached;
  const pagesFetched = Math.max(0, visited.size - listingErrors);
  const declaredTotalMismatch = declaredTotal !== null && entries.size !== declaredTotal;
  const declaredPageCountMismatch = declaredLastPage !== null
    && pagesFetched !== Math.max(1, declaredLastPage);
  const paginationProofObserved = declaredTotal !== null || discoveredPages.size > 1;
  const paginationProofMissing = paginationProofRequired && !paginationProofObserved;
  return {
    id: String(category.id || ""),
    categoryCode: String(category.categoryCode || ""),
    pagesDiscovered: discoveredPages.size,
    pagesAttempted: visited.size,
    pagesFetched,
    entriesDiscovered: entries.size,
    declaredTotal,
    declaredLastPage,
    declaredTotalMismatch,
    declaredPageCountMismatch,
    listingErrors,
    paginationProofRequired,
    paginationProofObserved,
    paginationProofMissing,
    frontierExhausted: listingErrors === 0
      && !capReached
      && !declaredTotalMismatch
      && !declaredPageCountMismatch
      && !paginationProofMissing
      && undispatchedPages.length === 0,
    capReached,
    pageCapReached,
    documentCapReached,
    maxListPages,
    maxDocumentsPerCategory,
  };
}

function makeDocumentImageStats(documents) {
  const expected = documents.filter((document) => document.markers?.camera === true || document.markers?.gallery === true);
  const missing = expected.filter((document) => document.images.length === 0);
  return {
    documentsWithImages: documents.filter((document) => document.images.length > 0).length,
    documentsWithExpectedImages: expected.length,
    documentsMissingExpectedImages: missing.length,
    missingExpectedImageSamples: missing.slice(0, MAX_MISSING_IMAGE_DIAGNOSTIC_SAMPLES).map((document) => ({
      url: document.url,
      title: document.title,
      date: document.date,
      kind: document.kind,
      categories: [...document.categories],
      markers: { ...document.markers },
      galleryUrl: document.galleryUrl || "",
    })),
    missingExpectedImageSamplesOmitted: Math.max(0, missing.length - MAX_MISSING_IMAGE_DIAGNOSTIC_SAMPLES),
  };
}

function discoverKcnaPageUrls($, listingUrl) {
  const listing = new URL(listingUrl);
  const results = new Set();
  $("a[href]").each((_, element) => {
    const rawHref = String($(element).attr("href") || "").trim();
    const jsPage = rawHref.match(/^javascript:\s*page\((\d{1,4})\)\s*;?$/iu)?.[1];
    if (jsPage) {
      const pageUrl = new URL(listing.href);
      pageUrl.searchParams.set("page", jsPage);
      results.add(pageUrl.href);
      return;
    }
    const url = resolveSameOriginUrl(rawHref, listingUrl);
    if (!url) return;
    const candidate = new URL(url);
    if (candidate.pathname === listing.pathname && /^\d{1,4}$/u.test(candidate.searchParams.get("page") || "")) results.add(candidate.href);
  });
  results.delete(listing.href);
  return [...results].sort((left, right) => Number(new URL(left).searchParams.get("page")) - Number(new URL(right).searchParams.get("page")));
}

function classifyKcnaDetailPath(pathname) {
  return Object.entries(DETAIL_PATH_PATTERNS).find(([, pattern]) => pattern.test(pathname))?.[0] || "";
}

function findListingItemScope($, element) {
  const direct = $(element).closest("li, article, tr, .thumbnail, .media, .article, .block, .list-item, .list_item, .news-item, .news_item, .item, .row");
  if (direct.length) return direct.first();
  let current = $(element);
  for (let depth = 0; depth < 4; depth += 1) {
    const parent = current.parent();
    if (!parent.length) break;
    current = parent;
    if (normalizeDate(current.text()) || current.find("time, .date, [class*=date]").length) return current;
  }
  return $(element).parent();
}

function cloneTextWithoutMedia($, node) {
  const clone = node.clone();
  clone.find("img, picture, video, svg, i, time, .date, [class*=date]").remove();
  return normalizedText(clone.text());
}

function firstCandidateText($, node, selectors) {
  let value = "";
  node.find(selectors).each((_, element) => {
    if (!value) value = normalizedText($(element).text());
  });
  return value;
}

function hasCameraMarker($, node) {
  if (!node?.length) return false;
  return node.find("img, i, svg, a, [class]").toArray().some((element) => {
    const candidate = $(element);
    const metadata = normalizedText([
      candidate.attr("class"),
      candidate.attr("alt"),
      candidate.attr("title"),
      candidate.attr("href"),
    ].filter(Boolean).join(" "));
    const videoOnly = /(?:video[-_ ]?camera|video_button|\/video\/detail\/|동화상)/iu.test(metadata)
      || candidate.closest(".video_button, a[href*='/video/detail/']").length > 0;
    const explicitPhoto = /(?:📷|사진|(?:^|[-_\s])photo(?:[-_\s]|$)|(?:^|[-_\s])gallery(?:[-_\s]|$)|gallery_button)/iu.test(metadata)
      || candidate.closest(".gallery_button, a[href*='/gallery/detail/']").length > 0;
    if (videoOnly && !explicitPhoto) return false;
    return explicitPhoto || /(?:^|[-_\s])camera(?:[-_\s]|$)/iu.test(metadata);
  });
}

function firstSameOriginImageUrl($, node, baseUrl, options = {}) {
  return collectImageReferences($, node, baseUrl, { ...options, role: "preview" })[0]?.url || "";
}

function collectImageReferences($, node, baseUrl, options = {}) {
  const result = [];
  const seen = new Set();
  const root = node?.length ? node : $.root();
  root.find("img, source").each((_, element) => {
    const candidateValues = [
      $(element).attr("data-src"),
      $(element).attr("data-original"),
      $(element).attr("data-lazy-src"),
      $(element).attr("src"),
      firstSrcsetUrl($(element).attr("srcset")),
    ];
    for (const rawValue of candidateValues) {
      const raw = String(rawValue || "").trim();
      if (!raw) continue;
      if (options.allowData && /^data:(?:image\/[a-z0-9.+-]+)?;base64,/iu.test(raw)) {
        if (!seen.has(raw)) result.push({ url: raw, referer: baseUrl, role: options.role || "inline" });
        seen.add(raw);
        break;
      }
      const url = resolveSameOriginUrl(raw, baseUrl);
      if (!url || seen.has(url)) continue;
      const parsed = new URL(url);
      if (options.kcnaPhotoOnly && !/^\/photo\//iu.test(parsed.pathname)) continue;
      if (isDecorativeImageUrl(parsed, $, element, options.sourceId)) continue;
      result.push({ url, referer: baseUrl, role: options.role || "inline" });
      seen.add(url);
      break;
    }
  });
  return result;
}

function isDecorativeImageUrl(url, $, element, sourceId = "") {
  const metadata = normalizedText([
    url.pathname,
    $(element).attr("class"),
    $(element).attr("id"),
    $(element).attr("alt"),
    $(element).attr("title"),
  ].filter(Boolean).join(" "));
  if (/(?:^|[\s/_.-])(?:arrow|banner|button|calendar|icon|loader|logo|mark|newsf|page-bottom|share|spacer|sprite)(?:$|[\s/_.-])/iu.test(metadata)) return true;
  if (sourceId === "rodong-sinmun" && /\/images\/(?:rodong_mark|newsf)\./iu.test(url.pathname)) return true;
  return false;
}

function firstSrcsetUrl(value = "") {
  return String(value || "").split(",", 1)[0]?.trim().split(/\s+/u, 1)[0] || "";
}

function removeNonContentNodes($) {
  $("script, style, noscript, template, nav, header, footer, form, iframe, object, .menu, .nav, .footer, .header, .pagination").remove();
}

function extractArticleContent($, selectors) {
  const node = selectBestContentNode($, selectors);
  const body = extractParagraphText($, node);
  return { node, body };
}

function selectBestContentNode($, selectors) {
  for (const selector of selectors) {
    let best = null;
    let bestScore = -Infinity;
    $(selector).each((_, element) => {
      const node = $(element);
      const text = normalizedText(node.text());
      if (!text) return;
      const linkText = normalizedText(node.find("a").text());
      const linkRatio = linkText.length / Math.max(1, text.length);
      const paragraphBonus = node.find("p, br").length * 12;
      const score = text.length + paragraphBonus - linkRatio * text.length * 1.5;
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    });
    if (best) return best;
  }
  return $("body").first() || $.root();
}

function extractParagraphText($, node) {
  if (!node?.length) return "";
  const clone = node.clone();
  clone.find("script, style, noscript, nav, header, footer, form, iframe, .menu, .pagination").remove();
  clone.find("br").replaceWith("\n");
  const paragraphs = clone.find("p, blockquote").map((_, element) => normalizedText($(element).text())).get().filter(Boolean);
  if (paragraphs.length) return normalizedBody(paragraphs.join("\n\n"));
  return normalizedBody(clone.text());
}

function bestTitle($, selectors) {
  for (const selector of selectors) {
    const values = $(selector).map((_, element) => normalizedText($(element).text())).get();
    const title = values.find(isPlausibleTitle);
    if (title) return title;
  }
  const meta = normalizedText($("meta[property='og:title']").attr("content") || "");
  return isPlausibleTitle(meta) ? meta : "";
}

function firstDateFromSelectors($, selectors) {
  for (const selector of selectors) {
    let date = "";
    $(selector).each((_, element) => {
      if (!date) date = normalizeDate($(element).attr("datetime") || $(element).text());
    });
    if (date) return date;
  }
  return "";
}

function firstDateWithinNode($, node) {
  let date = "";
  const elements = [
    ...(node.is("time, .date, [class*=date], [id*=date]") ? node.toArray() : []),
    ...node.find("time, .date, [class*=date], [id*=date]").toArray(),
  ];
  elements.forEach((element) => {
    if (!date) date = normalizeDate($(element).attr("datetime") || $(element).text());
  });
  return date;
}

function normalizeDate(value = "") {
  const text = normalizedText(value);
  const match = text.match(/(?:^|\D)(20\d{2})\s*(?:[.\/-]|년)\s*(\d{1,2})\s*(?:[.\/-]|월)\s*(\d{1,2})(?:\s*일)?(?:\.|\b|$)/u);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function stripTrailingDate(value = "") {
  return normalizedText(value)
    .replace(/\s*[\[(]?20\d{2}\s*[.\/-]\s*\d{1,2}\s*[.\/-]\s*\d{1,2}\s*\.?[\])]?\s*$/u, "")
    .replace(/\s*(?:📷|camera)\s*$/iu, "")
    .trim();
}

function normalizedText(value = "") {
  return String(value || "").replace(/\u00a0/gu, " ").replace(/[\t\r\n ]+/gu, " ").trim();
}

function normalizedLabel(value = "") {
  return normalizedText(value).replace(/\s*[,，]\s*/gu, ",");
}

function normalizedBody(value = "") {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\u00a0 ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function isPlausibleTitle(value = "") {
  const title = normalizedText(value);
  return title.length >= 2 && title.length <= 500 && !/^(?:조선중앙통신|로동신문|사진|동화상|다음|이전|＞+|<+)$/u.test(title);
}

function normalizeHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error(`Invalid URL: ${String(value || "")}`);
  }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password) throw new Error(`Unsupported URL: ${url.href}`);
  url.hash = "";
  return url.href;
}

function normalizePublicBase(value) {
  const base = String(value || "").trim().replace(/\/+$/u, "");
  if (!/^\/[A-Za-z0-9/_-]*$/u.test(base) || base.includes("..")) throw new Error("Invalid public news asset base");
  return base || "/data/news/assets";
}

function normalizeSourceId(value) {
  const sourceId = String(value || "");
  if (!["kcna", "rodong-sinmun"].includes(sourceId)) throw new Error(`Unsupported news source: ${sourceId}`);
  return sourceId;
}

function normalizeNow(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid crawl time");
  return date;
}

function normalizeOptionalProxyUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  const parsed = new URL(candidate);
  if (!/^https?:$/u.test(parsed.protocol)) throw new Error("DPRK_NEWS_CRAWL_PROXY must use http or https");
  parsed.hash = "";
  return parsed.href;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function isRetryableRequestError(error) {
  if (error?.code === "KCNA_UPSTREAM_IDENTITY_MISMATCH") return true;
  if (error?.code === "RODONG_HTML_FALLBACK_EXHAUSTED") return true;
  const chain = [error, error?.cause, error?.cause?.cause, error?.fallbackError].filter(Boolean);
  const message = chain.map((item) => [item?.name, item?.code, item?.message || item]
    .filter(Boolean)
    .join(" "))
    .join("; ");
  const status = Number(message.match(/\bHTTP\s+(\d{3})\b/iu)?.[1] || 0);
  return status === 408
    || status === 429
    || status >= 500
    || /(?:abort|EAI_AGAIN|ECONN|ENET|ENOTFOUND|EHOSTUNREACH|EPIPE|fetch failed|request exceeded|socket|timed?\s*out|timeout|UND_ERR_(?:CONNECT|HEADERS|BODY|SOCKET))/iu.test(message);
}

function isRodongHtmlFallbackError(error) {
  const message = String(error?.message || error || "");
  const status = Number(message.match(/\bHTTP\s+(\d{3})\b/iu)?.[1] || 0);
  return status === 403 || isRetryableRequestError(error);
}

async function retryDelay(baseDelayMs, attempt) {
  const delayMs = Math.min(5_000, Number(baseDelayMs || 0) * (2 ** attempt));
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function assertFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("A Fetch-compatible implementation is required");
}

function dedupeImageReferences(references) {
  const result = [];
  const seen = new Set();
  for (const reference of references || []) {
    const key = String(reference?.url || "");
    if (!key || seen.has(key)) continue;
    result.push(reference);
    seen.add(key);
  }
  return result;
}

function dedupeDocuments(documents) {
  const byUrl = new Map();
  for (const document of documents) {
    const existing = byUrl.get(document.url);
    if (!existing || document.images.length > existing.images.length || document.body.length > existing.body.length) byUrl.set(document.url, document);
  }
  return [...byUrl.values()];
}

function sortNewsDocuments(documents) {
  documents.sort((left, right) => (
    right.date.localeCompare(left.date)
    || compareSharedOfficialCategoryOrder(left, right)
    || left.url.localeCompare(right.url)
  ));
  return documents;
}

function compareSharedOfficialCategoryOrder(left, right) {
  const leftOrders = left?.categoryOrders && typeof left.categoryOrders === "object" ? left.categoryOrders : {};
  const rightOrders = right?.categoryOrders && typeof right.categoryOrders === "object" ? right.categoryOrders : {};
  const sharedCategories = Object.keys(leftOrders)
    .filter((category) => Number.isSafeInteger(rightOrders[category]))
    .sort((leftCategory, rightCategory) => leftCategory.localeCompare(rightCategory, "en"));
  for (const category of sharedCategories) {
    const difference = leftOrders[category] - rightOrders[category];
    if (difference) return difference;
  }
  return 0;
}

function redactDataUrl(value = "") {
  return /^data:/iu.test(String(value)) ? "data:image/*;base64,[redacted]" : String(value || "");
}

function makeCrawlError(stage, url, error) {
  return { stage, url, error: String(error?.message || error) };
}

function emptySourceResult(sourceId) {
  return { sourceId, documents: [], errors: [], stats: {} };
}

async function mapLimit(values, limit, worker) {
  const items = Array.from(values || []);
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function writeJsonAtomic(outputPath, value) {
  const destination = path.resolve(outputPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, destination);
}

function parseCliArguments(argv) {
  const result = { output: "", assetDir: DEFAULT_NEWS_ASSET_DIR, publicAssetBase: DEFAULT_NEWS_PUBLIC_ASSET_BASE };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") result.output = argv[++index] || "";
    else if (argument === "--asset-dir") result.assetDir = argv[++index] || "";
    else if (argument === "--public-asset-base") result.publicAssetBase = argv[++index] || "";
    else if (argument === "--kcna-only") result.rodong = false;
    else if (argument === "--rodong-only") result.kcna = false;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!result.output) throw new Error("Usage: node scripts/news-mirror-crawler.ts --output <news-json> [--asset-dir <directory>]");
  return result;
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  const snapshot = await crawlNewsMirror(options);
  await writeJsonAtomic(options.output, snapshot);
  console.log(`Mirrored ${snapshot.documents.length} official news document(s) to ${path.resolve(options.output)}.`);
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
