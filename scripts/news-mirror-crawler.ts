#!/usr/bin/env node
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as cheerio from "cheerio";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(MODULE_DIR, "..");

export const NEWS_MIRROR_SCHEMA_VERSION = 1;
export const DEFAULT_NEWS_ASSET_DIR = path.join(PROJECT_DIR, "data/news/assets");
export const DEFAULT_NEWS_PUBLIC_ASSET_BASE = "/data/news/assets";

const KCNA_ORIGIN = "http://www.kcna.kp";
const RODONG_HOME_URL = "http://www.rodong.rep.kp/ko/";
const DEFAULT_HTML_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_IMAGES_PER_DOCUMENT = 16;
const DEFAULT_MAX_IMAGES_PER_CRAWL = 512;
const DEFAULT_MAX_IMAGE_BYTES_PER_CRAWL = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_LIST_PAGES = 8;
const DEFAULT_MAX_DOCUMENTS = 260;
const DEFAULT_MAX_DOCUMENTS_PER_CATEGORY = 120;
const DEFAULT_DETAIL_CONCURRENCY = 4;
const DEFAULT_IMAGE_CONCURRENCY = 3;
const NEWS_USER_AGENT = "DPRKArchiveNewsMirror/2.0 (+https://nkarchive.vercel.app/news)";

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
  const maxListPages = boundedInteger(options.maxListPages, 1, 50, DEFAULT_MAX_LIST_PAGES);
  const maxDocuments = boundedInteger(options.maxDocuments, 1, 2_000, DEFAULT_MAX_DOCUMENTS);
  const maxDocumentsPerCategory = boundedInteger(
    options.maxDocumentsPerCategory,
    1,
    1_000,
    DEFAULT_MAX_DOCUMENTS_PER_CATEGORY,
  );
  const context = createCrawlContext({ ...options, fetchImpl, sourceId: "kcna" });
  const entriesByUrl = new Map();
  const errors = [];
  let listingPagesFetched = 0;

  for (const category of categoryLists) {
    const queue = [category.url];
    const visited = new Set();
    const categoryEntryUrls = new Set();
    while (queue.length && visited.size < maxListPages && categoryEntryUrls.size < maxDocumentsPerCategory) {
      const listingUrl = queue.shift();
      if (visited.has(listingUrl)) continue;
      visited.add(listingUrl);
      try {
        const html = await fetchBoundedHtml(listingUrl, context);
        listingPagesFetched += 1;
        const parsed = parseKcnaListing(html, listingUrl, category);
        for (const entry of parsed.entries) {
          categoryEntryUrls.add(entry.url);
          entriesByUrl.set(entry.url, mergeNewsEntry(entriesByUrl.get(entry.url), entry));
          if (categoryEntryUrls.size >= maxDocumentsPerCategory) break;
        }
        for (const pageUrl of parsed.pageUrls) {
          if (queue.length + visited.size >= maxListPages) break;
          if (!visited.has(pageUrl)) queue.push(pageUrl);
        }
      } catch (error) {
        errors.push(makeCrawlError("listing", listingUrl, error));
      }
    }
  }

  const entries = selectEntriesAcrossCategories(entriesByUrl, categoryLists.map((category) => category.id), maxDocuments);
  const documents = [];
  const detailResults = await mapLimit(entries, context.detailConcurrency, async (entry) => {
    try {
      return await crawlKcnaDetail(entry, context);
    } catch (error) {
      errors.push(makeCrawlError("detail", entry.url, error));
      return null;
    }
  });
  for (const document of detailResults) if (document) documents.push(document);
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
      detailsFetched: documents.length,
      imagesCached: documents.reduce((sum, item) => sum + item.images.length, 0),
      imageQuota: makeImageQuotaStats(context),
    },
  };
}

export async function crawlRodongNews(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  assertFetch(fetchImpl);
  const homepageUrl = normalizeHttpUrl(options.homepageUrl || RODONG_HOME_URL);
  const maxListPages = boundedInteger(options.maxListPages, 1, 100, DEFAULT_MAX_LIST_PAGES);
  const maxDocuments = boundedInteger(options.maxDocuments, 1, 2_000, DEFAULT_MAX_DOCUMENTS);
  const maxDocumentsPerCategory = boundedInteger(
    options.maxDocumentsPerCategory,
    1,
    1_000,
    DEFAULT_MAX_DOCUMENTS_PER_CATEGORY,
  );
  const context = createCrawlContext({ ...options, fetchImpl, sourceId: "rodong-sinmun" });
  const errors = [];
  const entriesByUrl = new Map();
  let listingPagesFetched = 0;
  let categories = [];

  try {
    const homepageHtml = await fetchBoundedHtml(homepageUrl, context);
    categories = parseRodongHomepageCategories(homepageHtml, homepageUrl, options.categoryLabels || RODONG_CATEGORY_LABELS);
  } catch (error) {
    errors.push(makeCrawlError("homepage", homepageUrl, error));
  }

  for (const category of categories) {
    const queue = [category.url];
    const visited = new Set();
    const categoryEntryUrls = new Set();
    while (queue.length && visited.size < maxListPages && categoryEntryUrls.size < maxDocumentsPerCategory) {
      const listingUrl = queue.shift();
      if (visited.has(listingUrl)) continue;
      visited.add(listingUrl);
      try {
        const html = await fetchBoundedHtml(listingUrl, context);
        listingPagesFetched += 1;
        const parsed = parseRodongListing(html, listingUrl, category);
        for (const entry of parsed.entries) {
          categoryEntryUrls.add(entry.url);
          entriesByUrl.set(entry.url, mergeNewsEntry(entriesByUrl.get(entry.url), entry));
          if (categoryEntryUrls.size >= maxDocumentsPerCategory) break;
        }
        for (const pageLink of parsed.pageLinks) {
          if (pageLink.categoryCode !== category.categoryCode) continue;
          if (queue.length + visited.size >= maxListPages) break;
          if (!visited.has(pageLink.url)) queue.push(pageLink.url);
        }
      } catch (error) {
        errors.push(makeCrawlError("listing", listingUrl, error));
      }
    }
  }

  const entries = selectEntriesAcrossCategories(entriesByUrl, categories.map((category) => category.id), maxDocuments);
  const detailResults = await mapLimit(entries, context.detailConcurrency, async (entry) => {
    try {
      return await crawlRodongDetail(entry, context);
    } catch (error) {
      errors.push(makeCrawlError("detail", entry.url, error));
      return null;
    }
  });
  const documents = detailResults.filter(Boolean);
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
      detailsFetched: documents.length,
      imagesCached: documents.reduce((sum, item) => sum + item.images.length, 0),
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

  const pageUrls = discoverKcnaPageUrls($, safeListingUrl);
  return { entries, pageUrls };
}

export function parseKcnaDetail(html = "", detailUrl = "", fallback = {}) {
  const safeDetailUrl = normalizeHttpUrl(detailUrl);
  const $ = cheerio.load(String(html || ""));
  removeNonContentNodes($);
  const title = stripTrailingDate(
    bestTitle($, [".article_title", ".article-title", ".news_title", ".news-title", "main h1", "article h1", "h1", "h2"])
    || fallback.title
    || "",
  );
  const date = firstDateFromSelectors($, ["time", ".date", "[class*=date]", "[id*=date]"])
    || normalizeDate($.root().text())
    || normalizeDate(fallback.date);
  const content = extractArticleContent($, [
    ".article_body", ".article-body", ".news_body", ".news-body", ".detail_content", ".detail-content",
    "article", "main .content", "main",
  ]);
  const galleryUrl = findKcnaGalleryUrl($, safeDetailUrl);
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

export function findKcnaGalleryUrl(input, detailUrl = "") {
  const safeDetailUrl = normalizeHttpUrl(detailUrl);
  const $ = typeof input === "function" && input.root ? input : cheerio.load(String(input || ""));
  let result = "";
  $("a.gallery_button[href], a[href*='/gallery/detail/']").each((_, element) => {
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
  const root = selectBestContentNode($, [
    ".gallery", "[class*=gallery]", ".photo", "[class*=photo]", "main", "body",
  ]);
  return collectImageReferences($, root, safeGalleryUrl, {
    sourceId: "kcna",
    kcnaPhotoOnly: true,
    role: "gallery",
  });
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
      if (!seenPages.has(url)) {
        pageLinks.push({ ...categoryToken, url });
        seenPages.add(url);
      }
      return;
    }
    const detailToken = category.id === "video"
      ? parseRodongVideoToken(url)
      : parseRodongDetailToken(url);
    if (!detailToken || seenEntries.has(url)) return;
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
  return { entries, pageLinks };
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
  const $ = cheerio.load(String(html || ""));
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
    ".article_body", ".article-body", ".rodong_view", ".rodong-view", ".view_content", ".view-content",
    "article", "main .content", "main",
  ]);
  const imageUrls = collectImageReferences($, content.node, safeDetailUrl, {
    sourceId: "rodong-sinmun",
    role: "inline",
    allowData: true,
  });
  return {
    title: title || String(fallback.title || ""),
    date,
    body: content.body,
    imageUrls,
    markers: {
      camera: imageUrls.length > 0 || hasCameraMarker($, content.node) || fallback.markers?.camera === true,
      gallery: fallback.markers?.gallery === true,
    },
  };
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

export function parseRodongDetailToken(input = "") {
  const decoded = decodeRodongToken(input);
  const match = decoded.match(/^12@(20\d{2}-\d{2}-\d{2})-\d{3}@([1-9]\d{0,4})@/u);
  if (!match) return null;
  return { date: normalizeDate(match[1]), categoryCode: match[2], decoded };
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
  const parsed = parseKcnaDetail(html, entry.url, entry);
  let imageReferences = parsed.imageUrls.map((reference) => ({ ...reference, referer: entry.url }));
  let galleryUrl = parsed.galleryUrl;

  if (entry.kind === "photo") {
    galleryUrl = entry.url;
    imageReferences = parseKcnaGalleryImages(html, entry.url);
  } else if (galleryUrl) {
    const galleryHtml = await fetchBoundedHtml(galleryUrl, context);
    imageReferences.push(...parseKcnaGalleryImages(galleryHtml, galleryUrl));
  }
  if (entry.previewImageUrl) {
    imageReferences.push({ url: entry.previewImageUrl, referer: entry.url, role: "preview" });
  }
  imageReferences = dedupeImageReferences(imageReferences);
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
  const html = await fetchBoundedHtml(entry.url, context);
  const parsed = parseRodongDetail(html, entry.url, entry);
  const references = [...parsed.imageUrls];
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

async function cacheDocumentImages(references, context) {
  const errors = [];
  const candidates = Array.from(references || []);
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
    const reservation = reserveImageBudget(context);
    if (!reservation.ok) {
      recordSkippedImageReferences(context, 1);
      errors.push({ url: redactDataUrl(reference.url), error: reservation.error });
      return null;
    }
    try {
      const image = await cacheNewsImage(reference, {
        ...context,
        imageMaxBytes: reservation.maxBytes,
      });
      finishImageBudgetReservation(reservation, image.bytes, true);
      return image;
    } catch (error) {
      if (!reservation.finished) finishImageBudgetReservation(reservation, 0, false);
      errors.push({ url: redactDataUrl(reference.url), error: String(error?.message || error) });
      return null;
    }
  });
  const images = [];
  const seen = new Set();
  for (const image of results) {
    if (!image || seen.has(image.sha256)) continue;
    images.push(image);
    seen.add(image.sha256);
  }
  return { images, errors };
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
    kind: ["article", "photo", "video"].includes(entry.kind) ? entry.kind : "article",
    title,
    date,
    url: entry.url,
    body,
    images,
    thumbnailUrl: images[0]?.cachedUrl || "",
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

function createCrawlContext(options) {
  const now = normalizeNow(options.now);
  const imageBudget = isImageBudget(options.imageBudget)
    ? options.imageBudget
    : createImageBudget(options, false);
  return {
    sourceId: normalizeSourceId(options.sourceId),
    fetchImpl: options.fetchImpl,
    assetDir: path.resolve(options.assetDir || DEFAULT_NEWS_ASSET_DIR),
    publicAssetBase: normalizePublicBase(options.publicAssetBase || DEFAULT_NEWS_PUBLIC_ASSET_BASE),
    timeoutMs: boundedInteger(options.timeoutMs, 100, 120_000, DEFAULT_TIMEOUT_MS),
    htmlMaxBytes: boundedInteger(options.htmlMaxBytes, 1_024, 64 * 1024 * 1024, DEFAULT_HTML_MAX_BYTES),
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
    preferNodeDirect: options.preferNodeDirect === true
      || (options.allowNodeFallback === true && options.fetchImpl === globalThis.fetch),
    allowNodeFallback: options.allowNodeFallback === true,
    imageBudget,
    now,
    imageErrors: [],
  };
}

function createImageBudget(options = {}, sharedAcrossSources = false) {
  return {
    kind: "news-image-budget-v1",
    maxImages: boundedInteger(
      options.maxImagesPerCrawl,
      0,
      20_000,
      DEFAULT_MAX_IMAGES_PER_CRAWL,
    ),
    maxBytes: boundedInteger(
      options.maxImageBytesPerCrawl,
      0,
      8 * 1024 * 1024 * 1024,
      DEFAULT_MAX_IMAGE_BYTES_PER_CRAWL,
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
    && Number.isInteger(value.maxBytes);
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
      skippedReferences: 0,
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
  const availableBytes = budget.maxBytes - budget.bytesCharged - budget.bytesReserved;
  if (availableBytes < 32) {
    return { ok: false, error: `Crawl image byte limit of ${budget.maxBytes} reached` };
  }
  const maxBytes = Math.min(context.imageMaxBytes, availableBytes);
  budget.requestsStarted += 1;
  budget.bytesReserved += maxBytes;
  sourceStats.requestsStarted += 1;
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
  const chargedBytes = succeeded ? byteLength : reservation.maxBytes;
  reservation.budget.bytesReserved -= reservation.maxBytes;
  reservation.budget.bytesCharged += chargedBytes;
  reservation.sourceStats.quotaBytesCharged += chargedBytes;
  if (succeeded) {
    reservation.sourceStats.successfulImages += 1;
    reservation.sourceStats.acceptedBytes += byteLength;
  }
}

function recordSkippedImageReferences(context, count) {
  getImageBudgetSourceStats(context).skippedReferences += count;
}

function makeImageQuotaStats(context) {
  const budget = context.imageBudget;
  const sourceStats = getImageBudgetSourceStats(context);
  return {
    maxImagesPerDocument: context.maxImagesPerDocument,
    maxImagesPerCrawl: budget.maxImages,
    maxBytesPerCrawl: budget.maxBytes,
    sharedAcrossSources: budget.sharedAcrossSources,
    requestsStarted: sourceStats.requestsStarted,
    successfulImages: sourceStats.successfulImages,
    acceptedBytes: sourceStats.acceptedBytes,
    quotaBytesCharged: sourceStats.quotaBytesCharged,
    skippedReferences: sourceStats.skippedReferences,
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
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(new Error(`Request exceeded ${timeoutMs}ms`)), timeoutMs);
  try {
    const headers = {
      Accept: options.accept,
      "Accept-Encoding": "identity",
      Connection: "close",
      "User-Agent": NEWS_USER_AGENT,
    };
    if (options.referer) headers.Referer = options.referer;
    if (options.preferNodeDirect) {
      return await fetchBoundedNodeBytes(initialUrl, {
        ...options,
        deadline,
        headers,
        initialOrigin,
        maxRedirects,
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
      });
    } catch (error) {
      if (!options.allowNodeFallback) throw error;
      return await fetchBoundedNodeBytes(initialUrl, {
        ...options,
        deadline,
        headers,
        initialOrigin,
        maxRedirects,
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
}) {
  let currentUrl = initialUrl;
  let redirectCount = 0;
  while (true) {
    assertSameOriginDispatch(currentUrl, initialOrigin);
    const response = await fetchImpl(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers,
      signal: controller.signal,
    });
    if (!response || typeof response.arrayBuffer !== "function") throw new Error("Fetcher returned an invalid response");
    if (response.redirected === true) throw new Error("Fetcher followed a redirect despite manual redirect mode");
    if (response.url) {
      const responseUrl = normalizeHttpUrl(response.url);
      if (new URL(responseUrl).origin !== initialOrigin) throw new Error(`Cross-origin redirect rejected: ${responseUrl}`);
      if (responseUrl !== currentUrl) throw new Error(`Fetcher returned an unexpected response URL: ${responseUrl}`);
    }
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
  timeoutMs,
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
      headers,
      maxBytes,
      timeoutMs: remainingMs,
    });
    if (!result.redirectLocation) return result;
    if (redirectCount >= maxRedirects) throw new Error(`Redirect limit of ${maxRedirects} exceeded for ${initialUrl}`);
    currentUrl = resolveSameOriginRedirect(result.redirectLocation, currentUrl, initialOrigin);
    redirectCount += 1;
  }
}

async function fetchBoundedNodeHop(url, { timeoutMs, maxBytes, headers }) {
  const target = new URL(normalizeHttpUrl(url));
  const requestModule = target.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    const request = requestModule.request(target, { method: "GET", agent: false, headers }, (response) => {
      const status = Number(response.statusCode || 0);
      const redirectLocation = String(response.headers.location || "").trim();
      if (isRedirectStatus(status) && redirectLocation) {
        response.resume();
        finish(null, { redirectLocation });
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
        });
      });
      response.on("error", (error) => finish(error));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Request exceeded ${timeoutMs}ms`)));
    request.on("error", (error) => finish(error));
    request.end();
  });
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
    categories,
    markers: {
      camera: current.markers?.camera === true || incoming.markers?.camera === true,
      gallery: current.markers?.gallery === true || incoming.markers?.gallery === true,
    },
  };
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
  if (node.find(".camera, [class*=camera], [class*=photo], [class*=gallery], a.gallery_button").length) return true;
  return /(?:📷|사진|화상|camera|gallery)/iu.test(normalizedText(node.find("img, i, svg, a").map((_, element) => (
    `${$(element).attr("class") || ""} ${$(element).attr("alt") || ""} ${$(element).attr("title") || ""}`
  )).get().join(" ")));
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
  let best = null;
  let bestScore = -Infinity;
  for (const selector of selectors) {
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
    if (best && bestScore >= 200) break;
  }
  return best || $("body").first() || $.root();
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
  documents.sort((left, right) => right.date.localeCompare(left.date) || left.url.localeCompare(right.url));
  return documents;
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
