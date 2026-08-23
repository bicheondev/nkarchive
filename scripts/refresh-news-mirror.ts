#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crawlNewsMirror } from "./news-mirror-crawler.ts";
import { parseOfficialNewsImageUrl } from "../lib/news-image-policy.js";
import {
  NEWS_DOCUMENT_SCHEMA_VERSION,
  buildNewsSnapshot,
  canonicalizeNewsDocument,
  mergeFreshNewsDocuments,
  parseNewsDocumentsJsonl,
  stringifyNewsDocumentsJsonl,
  validateNewsDocuments,
} from "./news-snapshot.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_DOCUMENTS_PATH = path.join(ROOT_DIR, "data/news/documents.jsonl");
export const DEFAULT_FEED_PATH = path.join(ROOT_DIR, "data/news-feed.json");
export const DEFAULT_DETAILS_PATH = path.join(ROOT_DIR, "data/news-details.json");
export const DEFAULT_ASSET_DIR = path.join(ROOT_DIR, "data/news/assets");
export const DEFAULT_DETAIL_SHARDS_DIR = path.join(ROOT_DIR, "data/news/details");
export const DEFAULT_CATEGORY_PAGES_DIR = path.join(ROOT_DIR, "data/news/categories");
export const DEFAULT_IMAGE_PROXY_ALLOWLIST_PATH = path.join(ROOT_DIR, "data/news/image-proxy-allowlist.json");
export const DEFAULT_PUBLIC_ASSET_BASE = "/data/news/assets";
export const DEFAULT_MAX_AGE_DAYS = 4;
export const DEFAULT_RECENT_DETAIL_DAYS = 7;
export const MAX_REPORTED_CRAWL_ERRORS_PER_SOURCE = 20;
const DAY_MS = 86_400_000;
const MAX_REPORTED_STAT_KEYS = 40;
const MAX_REPORTED_STAT_DEPTH = 4;
const MAX_REPORTED_STRING_LENGTH = 2_000;

export async function refreshNewsMirror({
  rootDir = ROOT_DIR,
  documentsPath = path.join(rootDir, "data/news/documents.jsonl"),
  feedPath = path.join(rootDir, "data/news-feed.json"),
  detailsPath = path.join(rootDir, "data/news-details.json"),
  detailShardsDir = path.join(rootDir, "data/news/details"),
  categoryPagesDir = path.join(rootDir, "data/news/categories"),
  imageProxyAllowlistPath = path.join(rootDir, "data/news/image-proxy-allowlist.json"),
  assetDir = path.join(rootDir, "data/news/assets"),
  publicAssetBase = DEFAULT_PUBLIC_ASSET_BASE,
  reportPath = "",
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  recentDetailDays = DEFAULT_RECENT_DETAIL_DAYS,
  fullBackfill = false,
  now = new Date(),
  kcna = true,
  rodong = true,
  dryRun = false,
  crawlImpl = crawlNewsMirror,
  crawlOptions = {},
  proxyUrl = process.env.DPRK_NEWS_CRAWL_PROXY || "",
} = {}) {
  const startedAt = new Date();
  const normalizedNow = normalizeNow(now);
  const requiredSourceIds = [kcna ? "kcna" : "", rodong ? "rodong-sinmun" : ""].filter(Boolean);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-refresh-"));
  const stagedAssetDir = path.join(temporaryRoot, "assets");
  const report = {
    status: "running",
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    changed: false,
    promoted: false,
    sourceHeads: {},
    crawl: summarizeCrawl({}, requiredSourceIds),
    merge: {},
    snapshot: {},
    assets: {},
    refreshMode: fullBackfill ? "full-backfill" : "incremental",
    knownDetailsOffered: 0,
    error: "",
  };

  try {
    const existingText = await readOptionalText(documentsPath);
    const existingDocuments = existingText
      ? parseNewsDocumentsJsonl(existingText, path.relative(rootDir, documentsPath))
      : [];
    const knownDocuments = fullBackfill
      ? []
      : reconstructKnownCrawlerDocuments(existingDocuments, requiredSourceIds);
    report.knownDetailsOffered = knownDocuments.length;
    const crawled = await crawlImpl({
      ...crawlOptions,
      now: normalizedNow,
      kcna: kcna ? crawlOptions.kcna : false,
      rodong: rodong ? crawlOptions.rodong : false,
      assetDir: stagedAssetDir,
      publicAssetBase,
      proxyUrl,
      knownDocuments,
      fullBackfill: fullBackfill === true,
      recentDetailDays: normalizeNonNegativeInteger(recentDetailDays, DEFAULT_RECENT_DETAIL_DAYS),
    });
    report.crawl = summarizeCrawl(crawled, requiredSourceIds);
    assertCrawlFrontierExhausted(crawled, requiredSourceIds);
    assertCrawlSourceCompleteness(crawled, requiredSourceIds);
    const incomingDocuments = flattenCrawledNewsDocuments(crawled);
    assertCrawlProducedSources(incomingDocuments, requiredSourceIds);
    const sourceHeads = assertNewsFreshness(incomingDocuments, {
      sourceIds: requiredSourceIds,
      maxAgeDays,
      now: normalizedNow,
    });
    // Check head regression and identity collisions before authoritative pruning can hide them.
    mergeFreshNewsDocuments(existingDocuments, incomingDocuments);
    const unclassifiedExisting = removeUnclassifiedSourceDocuments(existingDocuments, requiredSourceIds);
    const authoritativeExisting = retainConfirmedSourceDocuments(
      unclassifiedExisting.documents,
      incomingDocuments,
      requiredSourceIds,
    );
    const merged = mergeFreshNewsDocuments(authoritativeExisting.documents, incomingDocuments);
    const authoritativeDocuments = applyAuthoritativeSourceFields(
      merged.documents,
      incomingDocuments,
      requiredSourceIds,
      authoritativeExisting.documents,
    );
    const { documents, removed } = removeUnclassifiedSourceDocuments(authoritativeDocuments, requiredSourceIds);
    const mergeReport = {
      ...merged.report,
      removedUnclassified: unclassifiedExisting.removed.length + removed.length,
      removedAuthoritative: authoritativeExisting.removed.length,
      removedAuthoritativeBySource: countDocumentsBySource(authoritativeExisting.removed),
    };
    const snapshot = buildNewsSnapshot(documents, { requireQuotaReady: false });
    const missingRequired = snapshot.readiness.missing.filter((item) => requiredSourceIds.includes(item.sourceId));
    if (missingRequired.length) {
      throw new Error(`Official news category quota is incomplete: ${missingRequired.map((item) => (
        `${item.sourceId}/${item.section} ${item.count}/${item.minimum}`
      )).join(", ")}`);
    }

    const documentsText = stringifyNewsDocumentsJsonl(documents);
    await assertReferencedAssetsExist(documents, { assetDir, stagedAssetDir, publicAssetBase });
    const canonicalAssetReferences = collectCanonicalAssetReferences(documents, publicAssetBase);
    const copiedAssets = dryRun
      ? []
      : await promoteStagedAssets(stagedAssetDir, assetDir, canonicalAssetReferences, publicAssetBase);
    const nextOutputs = [
      [documentsPath, documentsText],
      [feedPath, snapshot.feedText],
      [detailsPath, snapshot.detailsText],
      [imageProxyAllowlistPath, snapshot.imageProxyAllowlistText],
    ];
    const detailShardFiles = new Map([...snapshot.detailShardTexts].map(([shard, text]) => [`${shard}.json`, text]));
    const categoryPageFiles = snapshot.categoryPageTexts;
    const changed = (await Promise.all(nextOutputs.map(async ([filePath, text]) => (
      (await readOptionalText(filePath)) !== text
    )))).some(Boolean)
      || !await generatedDirectoryMatches(detailShardsDir, detailShardFiles)
      || !await generatedDirectoryMatches(categoryPagesDir, categoryPageFiles)
      || copiedAssets.length > 0;
    if (!dryRun) {
      // Complete immutable payload sets are visible before the small manifests
      // that advertise their version. Replacing each directory also removes
      // pages and shards that disappeared from the authoritative frontier.
      await replaceGeneratedDirectoriesAtomically([
        [detailShardsDir, detailShardFiles],
        [categoryPagesDir, categoryPageFiles],
      ]);
      await writeOutputsAtomically(nextOutputs);
    }
    const removedAssets = dryRun
      ? []
      : await pruneUnreferencedNewsAssets(assetDir, canonicalAssetReferences, publicAssetBase);

    report.status = "success";
    report.changed = changed || removedAssets.length > 0;
    report.promoted = !dryRun;
    report.sourceHeads = sourceHeads;
    report.merge = mergeReport;
    report.snapshot = {
      version: snapshot.feed.version,
      generatedAt: snapshot.feed.generatedAt,
      documents: documents.length,
      feedCounts: Object.fromEntries(Object.entries(snapshot.feed.sources).map(([id, source]) => [id, source.articles.length])),
      detailShards: detailShardFiles.size,
      categoryPages: categoryPageFiles.size,
      imageProxyPairs: snapshot.imageProxyAllowlist.pairCount,
      missingQuotas: snapshot.readiness.missing.map(({ sourceId, section, count, minimum }) => ({ sourceId, section, count, minimum })),
    };
    report.assets = {
      copied: copiedAssets.length,
      removed: removedAssets.length,
      files: copiedAssets,
      removedFiles: removedAssets,
    };
    return { report, documents, snapshot, crawled };
  } catch (error) {
    report.status = "failed";
    report.error = boundedReportString(error?.message || error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    if (reportPath) await writeTextAtomic(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function removeUnclassifiedSourceDocuments(documents, sourceIds) {
  const refreshedSources = new Set(sourceIds);
  const removed = [];
  const retained = [];
  for (const document of documents) {
    if (refreshedSources.has(document.sourceId) && document.categories.length === 0) removed.push(document);
    else retained.push(document);
  }
  return { documents: retained, removed };
}

function retainConfirmedSourceDocuments(existingDocuments, incomingDocuments, sourceIds) {
  const refreshedSources = new Set(sourceIds);
  const incomingIds = new Set(incomingDocuments.map((document) => document.id));
  const incomingArticleIdentities = new Set(incomingDocuments
    .filter((document) => document.mediaType === "article")
    .map(createRefreshDocumentIdentity));
  const incomingIdentityCounts = countDocumentIdentities(incomingDocuments);
  const existingIdentityCounts = countDocumentIdentities(existingDocuments);
  const documents = [];
  const removed = [];
  for (const document of existingDocuments) {
    const identity = createRefreshDocumentIdentity(document);
    const uniqueConfirmedIdentity = incomingIdentityCounts.get(identity) === 1
      && existingIdentityCounts.get(identity) === 1;
    const confirmed = incomingIds.has(document.id)
      || (document.mediaType === "article" && incomingArticleIdentities.has(identity))
      || uniqueConfirmedIdentity;
    if (refreshedSources.has(document.sourceId) && !confirmed) removed.push(document);
    else documents.push(document);
  }
  return { documents, removed };
}

function applyAuthoritativeSourceFields(documents, incomingDocuments, sourceIds, existingDocuments = []) {
  const refreshedSources = new Set(sourceIds);
  const incomingById = new Map(incomingDocuments.map((document) => [document.id, document]));
  const incomingArticlesByIdentity = new Map(incomingDocuments
    .filter((document) => document.mediaType === "article")
    .map((document) => [createRefreshDocumentIdentity(document), document]));
  const incomingIdentityCounts = countDocumentIdentities(incomingDocuments);
  const incomingByUniqueIdentity = new Map(incomingDocuments
    .filter((document) => incomingIdentityCounts.get(createRefreshDocumentIdentity(document)) === 1)
    .map((document) => [createRefreshDocumentIdentity(document), document]));
  const existingById = new Map(existingDocuments.map((document) => [document.id, document]));
  const existingArticlesByIdentity = new Map(existingDocuments
    .filter((document) => document.mediaType === "article")
    .map((document) => [createRefreshDocumentIdentity(document), document]));
  const existingIdentityCounts = countDocumentIdentities(existingDocuments);
  const existingByUniqueIdentity = new Map(existingDocuments
    .filter((document) => existingIdentityCounts.get(createRefreshDocumentIdentity(document)) === 1)
    .map((document) => [createRefreshDocumentIdentity(document), document]));
  return documents.map((document) => {
    if (!refreshedSources.has(document.sourceId)) return document;
    const incoming = incomingById.get(document.id)
      || (document.mediaType === "article"
        ? incomingArticlesByIdentity.get(createRefreshDocumentIdentity(document))
        : incomingByUniqueIdentity.get(createRefreshDocumentIdentity(document)));
    if (!incoming) return document;
    const incomingIdentity = createRefreshDocumentIdentity(incoming);
    const existing = existingById.get(document.id)
      || (incoming.mediaType === "article"
        ? existingArticlesByIdentity.get(incomingIdentity)
        : existingByUniqueIdentity.get(incomingIdentity));
    const sameRemoteThumbnail = Boolean(existing && incoming.thumbnailUrl)
      && incoming.thumbnailUrl === existing.thumbnailUrl;
    const sameImageIdentity = incoming.mediaType === "image"
      && Boolean(existing)
      && createRefreshDocumentIdentity(existing) === incomingIdentity;
    return canonicalizeNewsDocument({
      ...incoming,
      // A regenerated upstream id may have been aliased to a stable archive id
      // by mergeFreshNewsDocuments. Keep only those archive identities; all
      // source-owned content and metadata come from the confirmed fresh row.
      id: document.id,
      articleId: document.articleId || incoming.articleId,
      cachedUrl: incoming.cachedUrl || (sameImageIdentity ? existing.cachedUrl : ""),
      cachedThumbnailUrl: incoming.cachedThumbnailUrl
        || (sameImageIdentity || sameRemoteThumbnail ? existing.cachedThumbnailUrl : ""),
    });
  });
}

export function createRefreshDocumentIdentity(document) {
  const documentUrl = normalizeRefreshIdentityUrl(document.url);
  if (document.mediaType === "article") {
    return `${document.sourceId}\u0000article\u0000${documentUrl}`;
  }
  const articleAssociation = normalizeRefreshIdentityUrl(document.articleUrl)
    || (document.articleId ? `id:${document.articleId}` : "standalone");
  const remoteAssetUrl = document.mediaType === "video"
    ? documentUrl
    : documentUrl && documentUrl !== articleAssociation ? documentUrl : "";
  const cachedAssetHash = String(document.cachedUrl || document.cachedThumbnailUrl || "")
    .match(/\/([a-f0-9]{64})\.(?:jpg|png|gif|webp)$/u)?.[1] || "";
  const thumbnailAssetUrl = normalizeRefreshIdentityUrl(document.thumbnailUrl);
  const assetIdentity = remoteAssetUrl
    ? `url:${remoteAssetUrl}`
    : cachedAssetHash
      ? `sha256:${cachedAssetHash}`
      : thumbnailAssetUrl
        ? `thumbnail:${thumbnailAssetUrl}`
        : `id:${document.id}`;
  const slot = Number.isSafeInteger(document.displayOrder) && document.displayOrder >= 0
    ? document.displayOrder
    : 0;
  return `${document.sourceId}\u0000${document.mediaType}\u0000article:${articleAssociation}\u0000asset:${assetIdentity}\u0000slot:${slot}`;
}

function normalizeRefreshIdentityUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (!/^https?:$/u.test(parsed.protocol)) return "";
    parsed.hash = "";
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
    return parsed.toString();
  } catch {
    return "";
  }
}

function countDocumentIdentities(documents) {
  const counts = new Map();
  for (const document of documents) {
    const identity = createRefreshDocumentIdentity(document);
    counts.set(identity, (counts.get(identity) || 0) + 1);
  }
  return counts;
}

function countDocumentsBySource(documents) {
  const counts = {};
  for (const document of documents) counts[document.sourceId] = (counts[document.sourceId] || 0) + 1;
  return counts;
}

export function reconstructKnownCrawlerDocuments(documents, sourceIds = ["kcna", "rodong-sinmun"]) {
  const allowedSources = new Set(sourceIds);
  const articles = documents.filter((document) => (
    allowedSources.has(document.sourceId) && document.mediaType === "article"
  ));
  const mediaByArticleId = new Map();
  const mediaByArticleUrl = new Map();
  for (const document of documents) {
    if (!allowedSources.has(document.sourceId) || document.mediaType === "article") continue;
    if (document.articleId) appendMapArray(mediaByArticleId, document.articleId, document);
    if (document.articleUrl) appendMapArray(mediaByArticleUrl, document.articleUrl, document);
  }
  return articles.map((article) => {
    const media = dedupeCanonicalMedia([
      ...(mediaByArticleId.get(article.id) || []),
      ...(mediaByArticleUrl.get(article.url) || []),
    ]);
    const images = media
      .filter((document) => document.mediaType === "image")
      .sort((left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id))
      .map((image) => {
        const cachedUrl = normalizeCachedAsset(image.cachedUrl || image.cachedThumbnailUrl);
        const originalUrl = normalizeOfficialRemoteImageUrl(image.url, article.sourceId);
        const sha256 = cachedUrl.match(/\/([a-f0-9]{64})\.(?:jpg|png|gif|webp)$/u)?.[1] || "";
        return {
          originalUrl,
          cachedUrl,
          sha256,
          mimeType: "",
          bytes: 0,
          role: image.displayOrder === 0 ? "preview" : "inline",
        };
      })
      .filter((image) => image.cachedUrl || image.originalUrl);
    const categories = Array.isArray(article.categories) ? [...article.categories] : [];
    const hasVideo = media.some((document) => document.mediaType === "video")
      || /\/video\/detail\//u.test(article.url)
      || categories.includes("video");
    const hasPhoto = /\/gallery\/detail\//u.test(article.url) || categories.includes("photo");
    const kind = hasVideo ? "video" : hasPhoto ? "photo" : "article";
    const primaryCategory = categories[0] || (kind === "video" ? "video" : kind === "photo" ? "photo" : "uncategorized");
    const hash = createHash("sha256").update(article.url).digest("hex").slice(0, 24);
    return {
      schemaVersion: NEWS_DOCUMENT_SCHEMA_VERSION,
      id: `news:${article.sourceId}:${hash}`,
      sourceId: article.sourceId,
      sourceName: article.sourceName,
      language: "ko",
      category: { id: primaryCategory, label: primaryCategory },
      categories,
      categoryOrders: article.categoryOrders,
      kind,
      title: article.title,
      date: article.date,
      url: article.url,
      body: article.body,
      images,
      thumbnailUrl: article.cachedThumbnailUrl || article.thumbnailUrl
        || images[0]?.cachedUrl || images[0]?.originalUrl || "",
      markers: { camera: images.length > 0, gallery: hasPhoto || images.length > 1 },
      galleryUrl: "",
      mirroredAt: "",
    };
  });
}

function appendMapArray(map, key, value) {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function dedupeCanonicalMedia(documents) {
  return [...new Map(documents.map((document) => [document.id, document])).values()];
}

export function flattenCrawledNewsDocuments(crawled) {
  const flattened = [];
  for (const sourceDocument of crawled?.documents || []) {
    const sourceId = String(sourceDocument?.sourceId || "");
    const sourceName = sourceId === "rodong-sinmun" ? "로동신문" : "조선중앙통신";
    const categories = normalizeCrawledCategories(sourceDocument);
    const body = String(sourceDocument?.body || "").trim() || String(sourceDocument?.title || "").trim();
    const images = Array.isArray(sourceDocument?.images) ? sourceDocument.images : [];
    const cachedThumbnailUrl = normalizeCachedAsset(sourceDocument?.thumbnailUrl);
    const thumbnailUrl = normalizeOfficialRemoteImageUrl(sourceDocument?.thumbnailUrl, sourceId)
      || images.map((image) => normalizeOfficialRemoteImageUrl(image?.originalUrl, sourceId)).find(Boolean)
      || "";
    const article = canonicalizeNewsDocument({
      schemaVersion: NEWS_DOCUMENT_SCHEMA_VERSION,
      id: sourceDocument?.id,
      sourceId,
      sourceName,
      language: "ko",
      mediaType: "article",
      title: sourceDocument?.title,
      date: sourceDocument?.date,
      url: sourceDocument?.url,
      snippet: firstParagraph(body) || sourceDocument?.title,
      body,
      categories,
      categoryOrders: sourceDocument?.categoryOrders,
      thumbnailUrl,
      cachedThumbnailUrl,
    });
    flattened.push(article);

    images.forEach((image, index) => {
      const cachedUrl = normalizeCachedAsset(image?.cachedUrl);
      const originalUrl = normalizeOfficialRemoteImageUrl(image?.originalUrl, sourceId);
      if (!cachedUrl && !originalUrl) return;
      const sha = String(image?.sha256 || cachedUrl.match(/\/([a-f0-9]{64})\.[a-z]+$/u)?.[1] || "");
      const stableImageId = sha || createHash("sha256").update(originalUrl).digest("hex");
      flattened.push(canonicalizeNewsDocument({
        schemaVersion: NEWS_DOCUMENT_SCHEMA_VERSION,
        id: `${article.id}:image:${stableImageId || String(index).padStart(3, "0")}`,
        sourceId,
        sourceName,
        language: "ko",
        mediaType: "image",
        title: article.title,
        date: article.date,
        url: originalUrl || article.url,
        articleId: article.id,
        articleUrl: article.url,
        categories,
        categoryOrders: article.categoryOrders,
        cachedUrl,
        cachedThumbnailUrl: cachedUrl,
        displayOrder: index,
      }));
    });

    if (String(sourceDocument?.kind || "") === "video") {
      const videoId = createHash("sha256").update(article.url).digest("hex").slice(0, 24);
      flattened.push(canonicalizeNewsDocument({
        schemaVersion: NEWS_DOCUMENT_SCHEMA_VERSION,
        id: `${article.id}:video:${videoId}`,
        sourceId,
        sourceName,
        language: "ko",
        mediaType: "video",
        title: article.title,
        date: article.date,
        url: article.url,
        articleId: article.id,
        articleUrl: article.url,
        categories: categories.includes("video") ? categories : [...categories, "video"],
        categoryOrders: article.categoryOrders,
        thumbnailUrl,
        cachedThumbnailUrl,
      }));
    }
  }
  return validateNewsDocuments(dedupeFlatDocuments(flattened), { label: "crawled standalone news" });
}

export function assertNewsFreshness(documents, {
  sourceIds = ["kcna", "rodong-sinmun"],
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  now = new Date(),
} = {}) {
  const normalizedNow = normalizeNow(now);
  const today = Date.UTC(normalizedNow.getUTCFullYear(), normalizedNow.getUTCMonth(), normalizedNow.getUTCDate());
  const maximumAge = normalizeNonNegativeInteger(maxAgeDays, DEFAULT_MAX_AGE_DAYS);
  const result = {};
  for (const sourceId of sourceIds) {
    const newest = documents
      .filter((document) => document.sourceId === sourceId && document.mediaType === "article")
      .map((document) => document.date)
      .sort()
      .at(-1) || "";
    if (!newest) throw new Error(`News crawl produced no ${sourceId} articles`);
    const timestamp = Date.parse(`${newest}T00:00:00.000Z`);
    const ageDays = Math.max(0, Math.floor((today - timestamp) / DAY_MS));
    if (!Number.isFinite(timestamp) || ageDays > maximumAge) {
      throw new Error(`Standalone news mirror is stale for ${sourceId}: ${newest} (${ageDays} day(s), max ${maximumAge})`);
    }
    result[sourceId] = { newest, ageDays, maxAgeDays: maximumAge };
  }
  return result;
}

function normalizeCrawledCategories(document) {
  const raw = [
    ...(Array.isArray(document?.categories) ? document.categories : []),
    document?.category,
  ];
  const mapped = raw.flatMap((category) => {
    const value = typeof category === "object" ? category?.id : category;
    return mapCrawledCategory(String(value || ""));
  }).filter(Boolean);
  return [...new Set(mapped)];
}

function mapCrawledCategory(value) {
  const mapping = {
    leadership: "leadership",
    important: "important",
    today: "important",
    international: "international",
    photo: "photo",
    anecdote: "anecdote",
    politics: "anecdote",
    document: "document",
    editorial: "document",
    foreign: "foreign",
    video: "video",
    memory: "memory",
    "social-culture": "memory",
    domestic: "domestic",
    "advancing-korea": "domestic",
    social: "social",
    "history-culture": "social",
  };
  return mapping[value] || "";
}

function dedupeFlatDocuments(documents) {
  const byId = new Map();
  for (const document of documents) {
    const current = byId.get(document.id);
    if (!current) {
      byId.set(document.id, document);
      continue;
    }
    byId.set(document.id, canonicalizeNewsDocument({
      ...current,
      categories: [...current.categories, ...document.categories],
      categoryOrders: Object.keys(document.categoryOrders || {}).length
        ? document.categoryOrders
        : current.categoryOrders,
      body: document.body.length > current.body.length ? document.body : current.body,
      cachedUrl: document.cachedUrl || current.cachedUrl,
      cachedThumbnailUrl: document.cachedThumbnailUrl || current.cachedThumbnailUrl,
    }));
  }
  return [...byId.values()];
}

function assertCrawlProducedSources(documents, sourceIds) {
  for (const sourceId of sourceIds) {
    if (!documents.some((document) => document.sourceId === sourceId && document.mediaType === "article")) {
      throw new Error(`Official crawl produced no ${sourceId} article details`);
    }
  }
}

async function assertReferencedAssetsExist(documents, { assetDir, stagedAssetDir, publicAssetBase }) {
  const references = collectCanonicalAssetReferences(documents, publicAssetBase);
  for (const reference of references) {
    if (!reference.startsWith(`${publicAssetBase}/`)) throw new Error(`Unexpected news asset reference: ${reference}`);
    const relative = reference.slice(publicAssetBase.length + 1);
    const candidates = [path.join(stagedAssetDir, relative), path.join(assetDir, relative)];
    let found = "";
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        found = candidate;
        break;
      }
    }
    if (!found) throw new Error(`Standalone news asset is missing: ${reference}`);
    await assertContentAddressedAsset(found);
  }
}

function collectCanonicalAssetReferences(documents, publicAssetBase) {
  const references = new Set();
  for (const document of documents) {
    for (const reference of [document.cachedUrl, document.cachedThumbnailUrl]) {
      if (!reference) continue;
      if (!reference.startsWith(`${publicAssetBase}/`)) throw new Error(`Unexpected news asset reference: ${reference}`);
      references.add(reference);
    }
  }
  return references;
}

async function promoteStagedAssets(stagedAssetDir, assetDir, references, publicAssetBase) {
  if (!await fileExists(stagedAssetDir)) return [];
  const copied = [];
  for (const filePath of await listFiles(stagedAssetDir)) {
    await assertContentAddressedAsset(filePath);
    const relative = path.relative(stagedAssetDir, filePath);
    assertCanonicalNewsAssetRelativePath(relative);
    const reference = `${publicAssetBase}/${relative.split(path.sep).join("/")}`;
    if (!references.has(reference)) continue;
    const destination = path.join(assetDir, relative);
    if (await fileExists(destination)) continue;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(filePath, destination, fs.constants.COPYFILE_EXCL);
    copied.push(relative.split(path.sep).join("/"));
  }
  return copied.sort();
}

async function pruneUnreferencedNewsAssets(assetDir, references, publicAssetBase) {
  if (!await fileExists(assetDir)) return [];
  const removed = [];
  for (const filePath of await listFiles(assetDir)) {
    const relative = path.relative(assetDir, filePath);
    assertCanonicalNewsAssetRelativePath(relative);
    await assertContentAddressedAsset(filePath);
    const normalizedRelative = relative.split(path.sep).join("/");
    if (references.has(`${publicAssetBase}/${normalizedRelative}`)) continue;
    await fs.rm(filePath);
    removed.push(normalizedRelative);
  }
  return removed.sort();
}

function assertCanonicalNewsAssetRelativePath(relative) {
  const normalized = String(relative || "").split(path.sep).join("/");
  if (!/^(?:kcna|rodong-sinmun)\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u.test(normalized)) {
    throw new Error(`Invalid standalone news asset path: ${relative}`);
  }
}

async function assertContentAddressedAsset(filePath) {
  const match = path.basename(filePath).match(/^([a-f0-9]{64})\.(?:jpg|png|gif|webp)$/u);
  if (!match) throw new Error(`Invalid content-addressed news asset name: ${filePath}`);
  const bytes = await fs.readFile(filePath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== match[1]) throw new Error(`News asset hash mismatch: ${filePath}`);
}

async function generatedDirectoryMatches(directoryPath, expectedFiles) {
  const actualFiles = await listRelativeFilesOptional(directoryPath);
  const expectedPaths = [...expectedFiles.keys()].sort(compareText);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedPaths)) return false;
  for (const relativePath of expectedPaths) {
    if (await readOptionalText(safeGeneratedFilePath(directoryPath, relativePath)) !== expectedFiles.get(relativePath)) {
      return false;
    }
  }
  return true;
}

async function replaceGeneratedDirectoriesAtomically(directories) {
  const transactions = [];
  try {
    for (const [rawDirectoryPath, files] of directories) {
      const directoryPath = path.resolve(rawDirectoryPath);
      const parentPath = path.dirname(directoryPath);
      const baseName = path.basename(directoryPath);
      const nonce = `${process.pid}.${Date.now()}.${transactions.length}`;
      const stagedPath = path.join(parentPath, `.${baseName}.${nonce}.tmp`);
      const backupPath = path.join(parentPath, `.${baseName}.${nonce}.old`);
      await fs.mkdir(parentPath, { recursive: true });
      await fs.mkdir(stagedPath, { recursive: true });
      for (const [relativePath, text] of files) {
        const filePath = safeGeneratedFilePath(stagedPath, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, text, "utf8");
      }
      transactions.push({ directoryPath, stagedPath, backupPath, movedExisting: false, promoted: false });
    }

    for (const transaction of transactions) {
      try {
        await fs.rename(transaction.directoryPath, transaction.backupPath);
        transaction.movedExisting = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    for (const transaction of transactions) {
      await fs.rename(transaction.stagedPath, transaction.directoryPath);
      transaction.promoted = true;
    }
    await Promise.all(transactions
      .filter((transaction) => transaction.movedExisting)
      .map((transaction) => fs.rm(transaction.backupPath, { recursive: true, force: true })));
  } catch (error) {
    for (const transaction of [...transactions].reverse()) {
      if (transaction.promoted) await fs.rm(transaction.directoryPath, { recursive: true, force: true }).catch(() => {});
      if (transaction.movedExisting) {
        await fs.rename(transaction.backupPath, transaction.directoryPath).catch(() => {});
      }
    }
    throw error;
  } finally {
    await Promise.all(transactions.flatMap((transaction) => [
      fs.rm(transaction.stagedPath, { recursive: true, force: true }),
      fs.rm(transaction.backupPath, { recursive: true, force: true }),
    ]));
  }
}

function safeGeneratedFilePath(directoryPath, relativePath) {
  const normalized = String(relativePath || "").replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Invalid generated news path: ${relativePath}`);
  }
  const root = path.resolve(directoryPath);
  const destination = path.resolve(root, ...normalized.split("/"));
  if (!destination.startsWith(`${root}${path.sep}`)) throw new Error(`Generated news path escaped its directory: ${relativePath}`);
  return destination;
}

async function listRelativeFilesOptional(directoryPath) {
  const root = path.resolve(directoryPath);
  const output = [];
  async function visit(currentPath, prefix) {
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) output.push(relativePath);
      else throw new Error(`Unexpected generated news filesystem entry: ${absolutePath}`);
    }
  }
  await visit(root, "");
  return output.sort(compareText);
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), "en");
}

async function writeOutputsAtomically(outputs) {
  const staged = [];
  try {
    for (const [filePath, text] of outputs) {
      const destination = path.resolve(filePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, text, "utf8");
      staged.push([temporary, destination]);
    }
    for (const [temporary, destination] of staged) await fs.rename(temporary, destination);
  } catch (error) {
    await Promise.all(staged.map(([temporary]) => fs.rm(temporary, { force: true })));
    throw error;
  }
}

async function writeTextAtomic(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, text, "utf8");
  await fs.rename(temporary, filePath);
}

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(filePath));
    else if (entry.isFile()) output.push(filePath);
  }
  return output;
}

export function assertCrawlFrontierExhausted(crawled, sourceIds = ["kcna", "rodong-sinmun"]) {
  for (const sourceId of sourceIds) {
    const source = crawled?.sources?.[sourceId] || {};
    const stats = source?.stats && typeof source.stats === "object" ? source.stats : {};
    const discovered = Number(stats.entriesDiscovered);
    const selected = Number(stats.entriesSelected);
    const selectionWasTruncated = Number.isFinite(discovered)
      && Number.isFinite(selected)
      && discovered > selected;
    if (source.capReached === true || stats.capReached === true || selectionWasTruncated) {
      const counts = Number.isFinite(discovered) && Number.isFinite(selected)
        ? ` (${selected}/${discovered} entries selected)`
        : "";
      throw new Error(`Official news crawl capReached for ${sourceId}${counts}; source was not promoted`);
    }
    const listingFrontierExhausted = stats.listingFrontierExhausted
      ?? source.listingFrontierExhausted
      ?? stats.frontierExhausted
      ?? source.frontierExhausted;
    if (listingFrontierExhausted !== true) {
      throw new Error(`Official news crawl did not prove frontier exhaustion for ${sourceId}; source was not promoted`);
    }
  }
}

export function assertCrawlSourceCompleteness(crawled, sourceIds = ["kcna", "rodong-sinmun"]) {
  for (const sourceId of sourceIds) {
    const source = crawled?.sources?.[sourceId] || {};
    const stats = source?.stats && typeof source.stats === "object" ? source.stats : {};
    const selected = Number(stats.entriesSelected);
    const fetched = Number(stats.detailsFetched);
    const reused = stats.detailsReused === undefined ? 0 : Number(stats.detailsReused);
    const unresolved = stats.detailsUnresolved === undefined
      ? selected - fetched - reused
      : Number(stats.detailsUnresolved);
    if (!Number.isInteger(selected)
      || !Number.isInteger(fetched)
      || !Number.isInteger(reused)
      || !Number.isInteger(unresolved)
      || fetched < 0
      || reused < 0
      || unresolved !== 0
      || fetched + reused !== selected) {
      throw new Error(`Official news crawl detail coverage is incomplete for ${sourceId}: fetched=${fetched}, reused=${reused}, unresolved=${unresolved}, selected=${selected}; source was not promoted`);
    }

    if (!Array.isArray(stats.categories) || !stats.categories.length) {
      throw new Error(`Official news crawl has no category checkpoints for ${sourceId}; source was not promoted`);
    }
    const failedCategories = stats.categories.filter((category) => Number(category?.listingErrors) !== 0);
    if (failedCategories.length) {
      throw new Error(`Official news crawl has listing errors for ${sourceId}: ${failedCategories.map((category) => (
        `${category?.id || "unknown"}=${category?.listingErrors ?? "missing"}`
      )).join(", ")}; source was not promoted`);
    }
    const unprovenPagination = stats.categories.filter((category) => (
      category?.paginationProofRequired === true
      && (category?.paginationProofObserved !== true
        || category?.paginationProofMissing === true
        || category?.declaredTotalMismatch === true
        || category?.declaredPageCountMismatch === true)
    ));
    if (unprovenPagination.length) {
      throw new Error(`Official news crawl has unproven pagination for ${sourceId}: ${unprovenPagination.map((category) => (
        `${category?.id || "unknown"} pages=${category?.pagesFetched ?? "missing"}/${category?.declaredLastPage ?? "unknown"} entries=${category?.entriesDiscovered ?? "missing"}/${category?.declaredTotal ?? "unknown"}`
      )).join(", ")}; source was not promoted`);
    }

    if (!Array.isArray(source.errors)) {
      throw new Error(`Official news crawl error diagnostics are missing for ${sourceId}; source was not promoted`);
    }
    if (source.errors.length) {
      const stages = countValues(source.errors.map((error) => String(error?.stage || "unknown")));
      throw new Error(`Official news crawl reported ${source.errors.length} error(s) for ${sourceId}: ${Object.entries(stages)
        .map(([stage, count]) => `${stage}=${count}`).join(", ")}; source was not promoted`);
    }

    const imageQuota = stats.imageQuota;
    if (!imageQuota || typeof imageQuota !== "object") {
      throw new Error(`Official news crawl has no image checkpoint for ${sourceId}; source was not promoted`);
    }
    for (const counter of ["skippedReferences", "failedReferences"]) {
      const value = Number(imageQuota[counter]);
      if (!Number.isInteger(value) || value !== 0) {
        throw new Error(`Official news crawl image checkpoint ${counter}=${imageQuota[counter] ?? "missing"} for ${sourceId}; source was not promoted`);
      }
    }
    const sourceDocuments = Array.isArray(source.documents) ? source.documents : [];
    const invalidImageDescriptors = sourceDocuments.flatMap((document) => (
      Array.isArray(document?.images) ? document.images.map((image) => ({ document, image })) : []
    )).filter(({ image }) => (
      !normalizeCachedAsset(image?.cachedUrl)
      && !normalizeOfficialRemoteImageUrl(image?.originalUrl, sourceId)
    ));
    if (invalidImageDescriptors.length) {
      throw new Error(`Official news crawl emitted ${invalidImageDescriptors.length} unusable image descriptor(s) for ${sourceId}; source was not promoted`);
    }
    const missingMarkedMedia = sourceDocuments.filter((document) => (
      (document?.markers?.camera === true || document?.markers?.gallery === true)
      && (!Array.isArray(document.images) || document.images.length === 0)
    ));
    if (missingMarkedMedia.length) {
      throw new Error(`Official news crawl left ${missingMarkedMedia.length} camera/gallery document(s) without image descriptors for ${sourceId}; source was not promoted`);
    }
  }
}

function countValues(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

function summarizeCrawl(crawled, sourceIds = Object.keys(crawled?.sources || {})) {
  return Object.fromEntries(sourceIds.map((sourceId) => {
    const source = crawled?.sources?.[sourceId] || {};
    const rawErrors = Array.isArray(source.errors) ? source.errors : [];
    const errors = rawErrors
      .slice(0, MAX_REPORTED_CRAWL_ERRORS_PER_SOURCE)
      .map(summarizeCrawlError);
    return [sourceId, {
      documents: Array.isArray(source.documents) ? source.documents.length : 0,
      errorCount: rawErrors.length,
      errors,
      errorsOmitted: Math.max(0, rawErrors.length - errors.length),
      stats: boundedReportValue(source.stats || {}, 0),
    }];
  }));
}

function summarizeCrawlError(value) {
  if (!value || typeof value !== "object") return { error: boundedReportString(value) };
  return Object.fromEntries([
    ["stage", value.stage],
    ["url", value.url],
    ["documentUrl", value.documentUrl],
    ["error", value.error || value.message],
  ].filter(([, item]) => item !== undefined && item !== "")
    .map(([key, item]) => [key, boundedReportString(item)]));
}

function boundedReportValue(value, depth) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return boundedReportString(value);
  if (depth >= MAX_REPORTED_STAT_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_REPORTED_STAT_KEYS).map((item) => boundedReportValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") return boundedReportString(value);
  return Object.fromEntries(Object.entries(value)
    .slice(0, MAX_REPORTED_STAT_KEYS)
    .map(([key, item]) => [boundedReportString(key), boundedReportValue(item, depth + 1)]));
}

function boundedReportString(value) {
  const text = String(value ?? "");
  return text.length <= MAX_REPORTED_STRING_LENGTH
    ? text
    : `${text.slice(0, MAX_REPORTED_STRING_LENGTH)}...[truncated]`;
}

function normalizeCachedAsset(value) {
  const candidate = String(value || "").trim();
  return /^\/data\/news\/assets\/(?:kcna|rodong-sinmun)\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u.test(candidate)
    ? candidate
    : "";
}

function normalizeOfficialRemoteImageUrl(value, sourceId) {
  const url = parseOfficialNewsImageUrl(value);
  if (!url) return "";
  const hostname = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "").replace(/\.$/u, "");
  if (sourceId === "kcna" && hostname === "kcna.kp") return url.toString();
  if (sourceId === "rodong-sinmun" && hostname === "rodong.rep.kp") return url.toString();
  return "";
}

function firstParagraph(value) {
  return String(value || "").split(/\n+/u).map((part) => part.trim()).find(Boolean) || "";
}

function normalizeNow(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value || Date.now());
  if (!Number.isFinite(date.valueOf())) throw new Error("Invalid refresh time");
  return date;
}

function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

export function parseArguments(argv) {
  const options = { crawlOptions: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--report") options.reportPath = requireValue(argv, ++index, argument);
    else if (argument === "--max-age-days") options.maxAgeDays = Number(requireValue(argv, ++index, argument));
    else if (argument === "--recent-detail-days") options.recentDetailDays = Number(requireValue(argv, ++index, argument));
    else if (argument === "--max-list-pages") options.crawlOptions.maxListPages = Number(requireValue(argv, ++index, argument));
    else if (argument === "--max-documents") options.crawlOptions.maxDocuments = Number(requireValue(argv, ++index, argument));
    else if (argument === "--max-documents-per-category") options.crawlOptions.maxDocumentsPerCategory = Number(requireValue(argv, ++index, argument));
    else if (argument === "--max-images-per-document") options.crawlOptions.maxImagesPerDocument = Number(requireValue(argv, ++index, argument));
    else if (argument === "--max-images-per-crawl") options.crawlOptions.maxImagesPerCrawl = Number(requireValue(argv, ++index, argument));
    else if (argument === "--max-image-bytes-per-crawl") options.crawlOptions.maxImageBytesPerCrawl = Number(requireValue(argv, ++index, argument));
    else if (argument === "--detail-concurrency") options.crawlOptions.detailConcurrency = Number(requireValue(argv, ++index, argument));
    else if (argument === "--defer-remote-images") options.crawlOptions.cacheRemoteImages = false;
    else if (argument === "--full-backfill") options.fullBackfill = true;
    else if (argument === "--timeout-ms") options.crawlOptions.timeoutMs = Number(requireValue(argv, ++index, argument));
    else if (argument === "--kcna-only") options.rodong = false;
    else if (argument === "--rodong-only") options.kcna = false;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--enrich-inline-images") continue;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function requireValue(argv, index, argument) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
  return value;
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  refreshNewsMirror(parseArguments(process.argv.slice(2)))
    .then(({ report }) => {
      console.log(`Standalone news refresh ${report.status}: ${report.snapshot.version || "no snapshot"}.`);
    })
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    });
}
