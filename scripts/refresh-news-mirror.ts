#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crawlNewsMirror } from "./news-mirror-crawler.ts";
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
export const DEFAULT_PUBLIC_ASSET_BASE = "/data/news/assets";
export const DEFAULT_MAX_AGE_DAYS = 4;
const DAY_MS = 86_400_000;

export async function refreshNewsMirror({
  rootDir = ROOT_DIR,
  documentsPath = path.join(rootDir, "data/news/documents.jsonl"),
  feedPath = path.join(rootDir, "data/news-feed.json"),
  detailsPath = path.join(rootDir, "data/news-details.json"),
  assetDir = path.join(rootDir, "data/news/assets"),
  publicAssetBase = DEFAULT_PUBLIC_ASSET_BASE,
  reportPath = "",
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
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
    crawl: {},
    merge: {},
    snapshot: {},
    assets: {},
    error: "",
  };

  try {
    const existingText = await readOptionalText(documentsPath);
    const existingDocuments = existingText
      ? parseNewsDocumentsJsonl(existingText, path.relative(rootDir, documentsPath))
      : [];
    const crawled = await crawlImpl({
      ...crawlOptions,
      now: normalizedNow,
      kcna: kcna ? crawlOptions.kcna : false,
      rodong: rodong ? crawlOptions.rodong : false,
      assetDir: stagedAssetDir,
      publicAssetBase,
      proxyUrl,
    });
    const incomingDocuments = flattenCrawledNewsDocuments(crawled);
    assertCrawlProducedSources(incomingDocuments, requiredSourceIds);
    const sourceHeads = assertNewsFreshness(incomingDocuments, {
      sourceIds: requiredSourceIds,
      maxAgeDays,
      now: normalizedNow,
    });
    const merged = mergeFreshNewsDocuments(existingDocuments, incomingDocuments);
    const { documents, removed } = removeUnclassifiedSourceDocuments(merged.documents, requiredSourceIds);
    const mergeReport = { ...merged.report, removedUnclassified: removed.length };
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
    ];
    const changed = (await Promise.all(nextOutputs.map(async ([filePath, text]) => (
      (await readOptionalText(filePath)) !== text
    )))).some(Boolean) || copiedAssets.length > 0;
    if (!dryRun) await writeOutputsAtomically(nextOutputs);
    const removedAssets = dryRun
      ? []
      : await pruneUnreferencedNewsAssets(assetDir, canonicalAssetReferences, publicAssetBase);

    report.status = "success";
    report.changed = changed || removedAssets.length > 0;
    report.promoted = !dryRun;
    report.sourceHeads = sourceHeads;
    report.crawl = summarizeCrawl(crawled);
    report.merge = mergeReport;
    report.snapshot = {
      version: snapshot.feed.version,
      generatedAt: snapshot.feed.generatedAt,
      documents: documents.length,
      feedCounts: Object.fromEntries(Object.entries(snapshot.feed.sources).map(([id, source]) => [id, source.articles.length])),
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
    report.error = String(error?.message || error);
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

export function flattenCrawledNewsDocuments(crawled) {
  const flattened = [];
  for (const sourceDocument of crawled?.documents || []) {
    const sourceId = String(sourceDocument?.sourceId || "");
    const sourceName = sourceId === "rodong-sinmun" ? "로동신문" : "조선중앙통신";
    const categories = normalizeCrawledCategories(sourceDocument);
    const body = String(sourceDocument?.body || "").trim() || String(sourceDocument?.title || "").trim();
    const cachedThumbnailUrl = normalizeCachedAsset(sourceDocument?.thumbnailUrl);
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
      cachedThumbnailUrl,
    });
    flattened.push(article);

    const images = Array.isArray(sourceDocument?.images) ? sourceDocument.images : [];
    images.forEach((image, index) => {
      const cachedUrl = normalizeCachedAsset(image?.cachedUrl);
      if (!cachedUrl) return;
      const sha = String(image?.sha256 || cachedUrl.match(/\/([a-f0-9]{64})\.[a-z]+$/u)?.[1] || "");
      flattened.push(canonicalizeNewsDocument({
        schemaVersion: NEWS_DOCUMENT_SCHEMA_VERSION,
        id: `${article.id}:image:${sha || String(index).padStart(3, "0")}`,
        sourceId,
        sourceName,
        language: "ko",
        mediaType: "image",
        title: article.title,
        date: article.date,
        url: /^https?:/u.test(String(image?.originalUrl || "")) ? image.originalUrl : article.url,
        articleId: article.id,
        articleUrl: article.url,
        categories,
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

function summarizeCrawl(crawled) {
  return Object.fromEntries(Object.entries(crawled?.sources || {}).map(([sourceId, source]) => [sourceId, {
    documents: source?.documents?.length || 0,
    errors: source?.errors?.length || 0,
    stats: source?.stats || {},
  }]));
}

function normalizeCachedAsset(value) {
  const candidate = String(value || "").trim();
  return /^\/data\/news\/assets\/(?:kcna|rodong-sinmun)\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u.test(candidate)
    ? candidate
    : "";
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

function parseArguments(argv) {
  const options = { crawlOptions: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--report") options.reportPath = requireValue(argv, ++index, argument);
    else if (argument === "--max-age-days") options.maxAgeDays = Number(requireValue(argv, ++index, argument));
    else if (argument === "--max-list-pages") options.crawlOptions.maxListPages = Number(requireValue(argv, ++index, argument));
    else if (argument === "--max-documents") options.crawlOptions.maxDocuments = Number(requireValue(argv, ++index, argument));
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
