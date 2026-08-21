#!/usr/bin/env node
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProxyAgent } from "undici";
import * as cheerio from "cheerio";
import {
  parseJsonl,
  stringifyJsonl,
  validateSearchIndex,
} from "../search/localIndex.js";
import { loadDotEnvFile } from "./script-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

export const NEWS_SOURCE_IDS = Object.freeze(["kcna", "rodong-sinmun"]);
export const DEFAULT_DOCUMENTS_PATH = path.join(ROOT_DIR, "data/search/documents.jsonl");
export const DEFAULT_SOURCES_PATH = path.join(ROOT_DIR, "data/search/sources.json");
export const DEFAULT_HEALTH_PATH = path.join(ROOT_DIR, "data/search/source-health.json");
export const DEFAULT_FEED_PATH = path.join(ROOT_DIR, "data/news-feed.json");
export const DEFAULT_DETAILS_PATH = path.join(ROOT_DIR, "data/news-details.json");
export const DEFAULT_GENERATOR_PATH = path.join(ROOT_DIR, "scripts/generate-news-feed.ts");
export const DEFAULT_INLINE_IMAGE_MODULE_PATH = path.join(ROOT_DIR, "scripts/news-inline-images.ts");
export const DEFAULT_ASSET_DIR = path.join(ROOT_DIR, "data/search/assets");
export const DEFAULT_PUBLIC_ASSET_BASE_URL = "/data/search/assets";
export const MIN_SUBSTANTIAL_ARTICLE_BODY_LENGTH = 80;
export const DEFAULT_MAX_NEWS_AGE_DAYS = 4;
const DEFAULT_INLINE_IMAGE_LIMIT = 336;
const DEFAULT_INLINE_IMAGE_CONCURRENCY = 3;
const DEFAULT_INLINE_FETCH_TIMEOUT_MS = 25000;
const DEFAULT_INLINE_HTML_MAX_BYTES = 48 * 1024 * 1024;
const DEFAULT_REMOTE_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_NEWS_RECORDS_PER_SOURCE = 168;
const MAX_FUTURE_DATE_SKEW_DAYS = 1;
const MIN_MIRRORED_PREVIEW_COUNTS = Object.freeze({ kcna: 2, "rodong-sinmun": 5 });
const KCNA_DESIGN_CATEGORY_REQUIREMENTS = Object.freeze({
  leadership: { mediaType: "article", count: 6 },
  important: { mediaType: "article", count: 2 },
  international: { mediaType: "article", count: 2 },
  photo: { mediaType: "image", count: 2 },
  anecdote: { mediaType: "article", count: 5 },
  document: { mediaType: "article", count: 6 },
  foreign: { mediaType: "article", count: 6 },
  video: { mediaType: "video", count: 6 },
  memory: { mediaType: "article", count: 5 },
  domestic: { mediaType: "article", count: 5 },
  social: { mediaType: "article", count: 5 },
});
const GENERIC_ARTWORK_PATTERN = /(?:^|[-_.])(?:newsf|logo|mark|calendar|page[-_]?bottom|icon|arrow|button|banner|spacer|loader)(?:[-_.]|$)/iu;
const REMOTE_DECORATIVE_IMAGE_PATTERN = /(?:^|[\s_.-])(?:ad|advert|arrow|avatar|banner|button|calendar|icon|loader|logo|mark|newsf|page[-_]?bottom|share|spacer|sprite)(?:$|[\s_.-])/iu;
const LISTING_CHROME_PATTERN = /(?:^|\s)(?:검색 결과|오늘호 기사|혁명활동소식|분야별기사|Copyright @|Browse|KCNA Watch Logo)(?:\s|$)/iu;

export async function refreshNewsMirror({
  rootDir = ROOT_DIR,
  documentsPath = path.join(rootDir, "data/search/documents.jsonl"),
  sourcesPath = path.join(rootDir, "data/search/sources.json"),
  healthPath = path.join(rootDir, "data/search/source-health.json"),
  feedPath = path.join(rootDir, "data/news-feed.json"),
  detailsPath = path.join(rootDir, "data/news-details.json"),
  generatorPath = path.join(rootDir, "scripts/generate-news-feed.ts"),
  inlineImageModulePath = path.join(rootDir, "scripts/news-inline-images.ts"),
  assetDir = path.join(rootDir, "data/search/assets"),
  publicAssetBaseUrl = DEFAULT_PUBLIC_ASSET_BASE_URL,
  reportPath = "",
  proxyUrl = "",
  enrichInlineImages = false,
  inlineImageLimit = DEFAULT_INLINE_IMAGE_LIMIT,
  inlineImageConcurrency = DEFAULT_INLINE_IMAGE_CONCURRENCY,
  maxAgeDays = DEFAULT_MAX_NEWS_AGE_DAYS,
  categoryRequirements = KCNA_DESIGN_CATEGORY_REQUIREMENTS,
  promote = true,
  now = new Date(),
  runImporterImpl = runOfficialNewsImporter,
  runCommandImpl = runCommand,
  fetchHtmlImpl = fetchArticleHtml,
  fetchImageImpl = fetchRemoteImageBytes,
  inlineImageHelper = null,
} = {}) {
  const startedAt = new Date().toISOString();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-refresh-"));
  const operationReport = {
    startedAt,
    finishedAt: "",
    status: "running",
    changed: false,
    promoted: false,
    sources: [],
    freshness: [],
    inlineImages: null,
    error: "",
  };

  try {
    const [originalDocumentsText, sourcesText, originalHealthText, originalFeedText, originalDetailsText] = await Promise.all([
      fs.readFile(documentsPath, "utf8"),
      fs.readFile(sourcesPath, "utf8"),
      fs.readFile(healthPath, "utf8"),
      readOptionalText(feedPath),
      readOptionalText(detailsPath),
    ]);
    const existingDocuments = parseJsonl(originalDocumentsText);
    const sources = JSON.parse(sourcesText);
    const existingHealth = JSON.parse(originalHealthText);
    assertValidIndex(existingDocuments, sources, "existing search index");
    assertCanonicalNewsSources(sources);
    if (stringifyJsonl(existingDocuments) !== originalDocumentsText) {
      throw new Error("Search documents must use canonical JSONL before a byte-preserving news refresh");
    }

    const importDocumentsPath = path.join(tempDir, "official-sites.documents.jsonl");
    const importReportPath = path.join(tempDir, "official-sites.report.json");
    const importCacheDir = path.join(tempDir, "fetch-cache");
    const importerSeed = createImporterSeed(existingDocuments);
    await fs.writeFile(importDocumentsPath, stringifyJsonl(importerSeed.documents), "utf8");

    await runImporterImpl({
      rootDir,
      outputPath: importDocumentsPath,
      reportPath: importReportPath,
      cacheDir: importCacheDir,
      proxyUrl,
      runCommandImpl,
    });

    const [importedDocumentsText, rawImportReport] = await Promise.all([
      fs.readFile(importDocumentsPath, "utf8"),
      readJson(importReportPath),
    ]);
    const importOutputDocuments = parseJsonl(importedDocumentsText);
    const importedDocuments = importOutputDocuments.filter((document) => (
      NEWS_SOURCE_IDS.includes(document.sourceId)
      && !importerSeed.newsSeedIds.has(String(document.id || ""))
    ));
    const mergeResult = mergeNewsMirrorDocuments({
      existingDocuments,
      importedDocuments,
      importReport: rawImportReport,
      now,
    });
    let candidateDocuments = mergeResult.documents;
    operationReport.sources = mergeResult.sourceResults;
    assertValidIndex(candidateDocuments, sources, "merged news candidate before enrichment");
    operationReport.freshness = assertFreshNewsSources(candidateDocuments, { now, maxAgeDays });
    operationReport.categoryCoverage = assertKcnaDesignCategoryCoverage(candidateDocuments, {
      label: "candidate search documents",
      requirements: categoryRequirements,
    });

    const stagedAssetDir = path.join(tempDir, "assets");
    if (enrichInlineImages) {
      const helper = inlineImageHelper || await loadNewsInlineImageHelper(inlineImageModulePath, { required: true });
      const enrichment = await enrichCandidateWithInlineImages({
        documents: candidateDocuments,
        healthySourceIds: mergeResult.healthySourceIds,
        helper,
        stagedAssetDir,
        publicAssetBaseUrl,
        proxyUrl,
        limit: inlineImageLimit,
        concurrency: inlineImageConcurrency,
        fetchHtmlImpl,
        fetchImageImpl,
      });
      candidateDocuments = enrichment.documents;
      operationReport.inlineImages = enrichment.report;
      operationReport.inlineImages.previewCoverage = assertMirroredPreviewCoverage(candidateDocuments, {
        sourceIds: mergeResult.healthySourceIds,
        publicAssetBaseUrl,
      });
      operationReport.inlineImages.kcnaMediaPreviewCoverage = assertKcnaMediaPreviewCoverage(candidateDocuments, {
        publicAssetBaseUrl,
      });
    }

    assertValidIndex(candidateDocuments, sources, "candidate search index");
    await assertLocalAssetReferencesExist(candidateDocuments, {
      rootAssetDir: assetDir,
      stagedAssetDir,
      publicAssetBaseUrl,
    });

    const candidateDocumentsText = stringifyJsonl(candidateDocuments);
    const documentsChanged = candidateDocumentsText !== originalDocumentsText;
    const candidateHealth = documentsChanged
      ? updateSourceHealth(existingHealth, candidateDocuments, now)
      : existingHealth;
    const candidateHealthText = documentsChanged
      ? `${JSON.stringify(candidateHealth, null, 2)}\n`
      : originalHealthText;
    validateSourceHealth(candidateHealth, candidateDocuments, sources);

    const stagedSnapshot = await generateStagedNewsSnapshot({
      rootDir,
      tempDir,
      generatorPath,
      documentsText: candidateDocumentsText,
      runCommandImpl,
    });
    validateNewsSnapshot(stagedSnapshot.feedText, stagedSnapshot.detailsText, candidateDocuments, { categoryRequirements });

    const stagedAssetFiles = await listFiles(stagedAssetDir);
    await validateStagedNewsAssets(stagedAssetFiles, {
      stagedAssetDir,
      documents: candidateDocuments,
      publicAssetBaseUrl,
    });
    const assetChanges = await getAssetChanges(stagedAssetFiles, stagedAssetDir, assetDir);
    const feedChanged = stagedSnapshot.feedText !== originalFeedText;
    const detailsChanged = stagedSnapshot.detailsText !== originalDetailsText;
    const changed = documentsChanged || candidateHealthText !== originalHealthText || feedChanged || detailsChanged || assetChanges.length > 0;
    operationReport.changed = changed;
    operationReport.counts = {
      documentsBefore: existingDocuments.length,
      documentsAfter: candidateDocuments.length,
      stagedAssets: stagedAssetFiles.length,
      newAssets: assetChanges.length,
    };

    if (changed && promote) {
      await promoteNewsMirrorCandidate({
        rootDir,
        documentsPath,
        healthPath,
        feedPath,
        detailsPath,
        assetDir,
        stagedAssetDir,
        stagedAssetFiles,
        candidateDocumentsText,
        candidateHealthText,
        expectedFeedText: stagedSnapshot.feedText,
        expectedDetailsText: stagedSnapshot.detailsText,
        originals: {
          documentsText: originalDocumentsText,
          healthText: originalHealthText,
          feedText: originalFeedText,
          detailsText: originalDetailsText,
        },
        runCommandImpl,
      });
      operationReport.promoted = true;
    }

    operationReport.status = changed ? (promote ? "promoted" : "staged") : "no_change";
    operationReport.finishedAt = new Date().toISOString();
    await writeOperationReport(reportPath, operationReport);
    return {
      changed,
      promoted: operationReport.promoted,
      documents: candidateDocuments,
      sourceResults: mergeResult.sourceResults,
      inlineImages: operationReport.inlineImages,
      report: operationReport,
      stagedSnapshot,
    };
  } catch (error) {
    operationReport.status = "failed";
    operationReport.error = String(error?.message || error);
    operationReport.finishedAt = new Date().toISOString();
    await writeOperationReport(reportPath, operationReport).catch(() => {});
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export function mergeNewsMirrorDocuments({
  existingDocuments = [],
  importedDocuments = [],
  importReport = {},
  now = new Date(),
} = {}) {
  const reports = normalizeImportReports(importReport);
  const reportBySource = new Map(reports.map((report) => [report.sourceId, report]));
  const preservedSourceIds = new Set(Array.isArray(importReport?.preservedSourceIds) ? importReport.preservedSourceIds : []);
  const existingIdOwners = new Map(existingDocuments.map((document) => [String(document.id || ""), document.sourceId]));
  const replacements = new Map();
  const appended = [];
  const sourceResults = [];
  const healthySourceIds = new Set();

  for (const sourceId of NEWS_SOURCE_IDS) {
    const existingForSource = existingDocuments.filter((document) => document.sourceId === sourceId);
    const importedForSource = importedDocuments.filter((document) => document.sourceId === sourceId);
    const report = reportBySource.get(sourceId);
    const failureReason = getSourceFailureReason({
      sourceId,
      report,
      existingDocuments: existingForSource,
      importedDocuments: importedForSource,
      preservedSourceIds,
      now,
    });
    const existingNewestDate = getNewestKoreanArticleDate(existingForSource);
    const freshImportedNewestDate = getNewestKoreanArticleDate(importedForSource);
    const importedNewestDate = getNewestKoreanArticleDate(importedForSource);
    const dateRegression = existingNewestDate && (!freshImportedNewestDate || freshImportedNewestDate < existingNewestDate)
      ? `newest freshly crawled Korean article date regressed from ${existingNewestDate} to ${freshImportedNewestDate || "missing"}`
      : "";

    if (failureReason || dateRegression) {
      sourceResults.push({
        sourceId,
        status: "preserved",
        reason: failureReason || dateRegression,
        existingDocuments: existingForSource.length,
        importedDocuments: importedForSource.length,
        acceptedNewDocuments: 0,
        updatedDocuments: 0,
        rejectedDocuments: 0,
        newestBefore: existingNewestDate,
        newestAfter: existingNewestDate,
      });
      continue;
    }

    const existingById = new Map(existingForSource.map((document) => [String(document.id || ""), document]));
    let acceptedNewDocuments = 0;
    let updatedDocuments = 0;
    let rejectedDocuments = 0;
    const rejectionReasons = {};

    for (const importedDocument of importedForSource) {
      const id = String(importedDocument?.id || "").trim();
      const existing = existingById.get(id);
      const rejection = validateImportedNewsDocument(importedDocument, { now, isNew: !existing });
      if (rejection) {
        rejectedDocuments += 1;
        rejectionReasons[rejection] = (rejectionReasons[rejection] || 0) + 1;
        continue;
      }

      if (existing) {
        const merged = mergeDocumentQuality(existing, importedDocument);
        if (!jsonEqual(existing, merged)) {
          replacements.set(id, merged);
          updatedDocuments += 1;
        }
        continue;
      }

      const owner = existingIdOwners.get(id);
      if (!id || (owner && owner !== sourceId)) {
        rejectedDocuments += 1;
        rejectionReasons.id_collision = (rejectionReasons.id_collision || 0) + 1;
        continue;
      }
      existingIdOwners.set(id, sourceId);
      appended.push(importedDocument);
      acceptedNewDocuments += 1;
    }

    healthySourceIds.add(sourceId);
    sourceResults.push({
      sourceId,
      status: "accepted",
      reason: "",
      existingDocuments: existingForSource.length,
      importedDocuments: importedForSource.length,
      acceptedNewDocuments,
      updatedDocuments,
      rejectedDocuments,
      rejectionReasons,
      newestBefore: existingNewestDate,
      newestAfter: importedNewestDate || existingNewestDate,
      warnings: Array.isArray(report?.errors) ? report.errors.length : 0,
    });
  }

  return {
    documents: [
      ...existingDocuments.map((document) => replacements.get(String(document.id || "")) || document),
      ...appended,
    ],
    sourceResults,
    healthySourceIds,
  };
}

export function mergeDocumentQuality(existing = {}, incoming = {}) {
  const existingBody = String(existing.body || "");
  const incomingBody = String(incoming.body || "");
  const existingIsSubstantial = hasSubstantialArticleBody({ ...existing, body: existingBody });
  const incomingIsSubstantial = hasSubstantialArticleBody({ ...incoming, body: incomingBody });
  const incomingIsRicher = existingIsSubstantial && !incomingIsSubstantial
    ? false
    : (!existingIsSubstantial && incomingIsSubstantial)
      || getBodyQualityScore(incomingBody, incoming) > getBodyQualityScore(existingBody, existing);
  const merged = { ...existing, ...incoming };

  for (const [field, value] of Object.entries(existing)) {
    const incomingValue = incoming[field];
    if (
      incomingValue === undefined
      || incomingValue === null
      || (typeof incomingValue === "string" && !incomingValue.trim())
      || (Array.isArray(incomingValue) && !incomingValue.length)
    ) {
      merged[field] = value;
    }
  }
  merged.body = incomingIsRicher ? incoming.body : existing.body;
  merged.snippet = chooseRicherSnippet(existing.snippet, incoming.snippet);
  merged.date = chooseNonRegressingDate(existing.date, incoming.date);
  merged.cachedUrl = String(existing.cachedUrl || "").trim() || String(incoming.cachedUrl || "").trim();
  merged.cachedThumbnailUrl = String(existing.cachedThumbnailUrl || "").trim()
    || String(incoming.cachedThumbnailUrl || "").trim();
  merged.thumbnailUrl = chooseThumbnailUrl(existing.thumbnailUrl, incoming.thumbnailUrl);
  merged.aliases = [...new Set([...(existing.aliases || []), ...(incoming.aliases || [])].map(String).filter(Boolean))];
  merged.id = existing.id || incoming.id;
  merged.sourceId = existing.sourceId || incoming.sourceId;
  merged.sourceName = existing.sourceName || incoming.sourceName;
  merged.sourceType = existing.sourceType || incoming.sourceType;
  merged.mediaType = existing.mediaType || incoming.mediaType;
  return merged;
}

export function validateImportedNewsDocument(document = {}, {
  now = new Date(),
  isNew = true,
} = {}) {
  if (!NEWS_SOURCE_IDS.includes(document.sourceId)) return "unexpected_source";
  if (!isValidExplicitDocumentDate(document.date, { now })) return "invalid_date";
  if (!String(document.id || "").trim()) return "missing_id";
  if (!String(document.title || "").trim()) return "missing_title";
  if (!String(document.url || "").trim()) return "missing_url";
  if (isNew && document.mediaType === "article" && document.language === "ko" && !hasSubstantialArticleBody(document)) {
    return "thin_listing_body";
  }
  return "";
}

export function hasSubstantialArticleBody(document = {}) {
  const body = normalizeComparableText(document.body);
  const title = normalizeComparableText(document.title);
  const snippet = normalizeComparableText(document.snippet);
  if (body.length < MIN_SUBSTANTIAL_ARTICLE_BODY_LENGTH) return false;
  if (LISTING_CHROME_PATTERN.test(body)) return false;
  const residual = removeComparableText(removeComparableText(body, title), snippet)
    .replace(/\b20\d{2}[./-]\d{1,2}[./-]\d{1,2}\b/gu, "")
    .replace(/[^\p{L}\p{N}가-힣]+/gu, "")
    .trim();
  return residual.length >= 24 || body.length >= 200;
}

export function isValidExplicitDocumentDate(value = "", {
  now = new Date(),
  maxFutureSkewDays = MAX_FUTURE_DATE_SKEW_DAYS,
} = {}) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return false;
  const maxDate = new Date(now);
  maxDate.setUTCDate(maxDate.getUTCDate() + Number(maxFutureSkewDays || 0));
  return String(value) <= maxDate.toISOString().slice(0, 10);
}

export function getSourceFailureReason({
  sourceId,
  report,
  existingDocuments = [],
  importedDocuments = [],
  preservedSourceIds = new Set(),
  now = new Date(),
} = {}) {
  if (!report) return "crawler report is missing";
  const errors = Array.isArray(report.errors) ? report.errors : [];
  const indexed = Number(report.indexed || 0);
  const fetched = Number(report.fetched || 0);
  const usablePartialOutput = report.timedOut && hasUsableTimedOutSourceOutput(importedDocuments, {
    indexed,
    now,
  });
  if (report.timedOut && !usablePartialOutput) return "crawler timed out";
  if (!importedDocuments.length && existingDocuments.length) return "crawler output lost the existing source";
  if (indexed <= 0) return errors.length
    ? `crawler indexed no documents (${errors[0]})`
    : "crawler indexed no documents";
  if (errors.length && fetched <= 0 && preservedSourceIds.has(sourceId) && !usablePartialOutput) {
    return `crawler failed before fetching source documents (${errors[0]})`;
  }
  return "";
}

export function hasUsableTimedOutSourceOutput(documents = [], {
  indexed = 0,
  now = new Date(),
  minimumDocuments = 10,
  maxAgeDays = DEFAULT_MAX_NEWS_AGE_DAYS,
} = {}) {
  const substantialDocuments = documents.filter((document) => (
    NEWS_SOURCE_IDS.includes(document?.sourceId)
    && document.mediaType === "article"
    && document.language === "ko"
    && isValidExplicitDocumentDate(document.date, { now })
    && hasSubstantialArticleBody(document)
  ));
  if (Number(indexed || 0) < minimumDocuments || substantialDocuments.length < minimumDocuments) return false;
  const newestDate = getNewestKoreanArticleDate(substantialDocuments);
  if (!newestDate) return false;
  const today = new Date(now);
  if (Number.isNaN(today.getTime())) return false;
  const ageDays = Math.floor((
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    - Date.parse(`${newestDate}T00:00:00.000Z`)
  ) / 86400000);
  return ageDays >= -MAX_FUTURE_DATE_SKEW_DAYS && ageDays <= normalizeNonNegativeInteger(maxAgeDays, DEFAULT_MAX_NEWS_AGE_DAYS);
}

export function assertFreshNewsSources(documents = [], {
  now = new Date(),
  maxAgeDays = DEFAULT_MAX_NEWS_AGE_DAYS,
} = {}) {
  const normalizedMaxAgeDays = normalizeNonNegativeInteger(maxAgeDays, DEFAULT_MAX_NEWS_AGE_DAYS);
  const today = new Date(now);
  if (Number.isNaN(today.getTime())) throw new Error("News freshness gate received an invalid current date");
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const results = [];
  for (const sourceId of NEWS_SOURCE_IDS) {
    const newestDate = getNewestKoreanArticleDate(documents.filter((document) => document.sourceId === sourceId));
    if (!newestDate || !isValidExplicitDocumentDate(newestDate, { now })) {
      throw new Error(`News freshness gate could not find a valid newest Korean article date for ${sourceId}`);
    }
    const newest = Date.parse(`${newestDate}T00:00:00.000Z`);
    const ageDays = Math.floor((todayUtc - newest) / 86400000);
    results.push({ sourceId, newestDate, ageDays, maxAgeDays: normalizedMaxAgeDays });
    if (ageDays > normalizedMaxAgeDays) {
      throw new Error(`News mirror is stale for ${sourceId}: newest article ${newestDate} is ${ageDays} day(s) old (max ${normalizedMaxAgeDays})`);
    }
  }
  return results;
}

export async function loadNewsInlineImageHelper(modulePath = DEFAULT_INLINE_IMAGE_MODULE_PATH, {
  required = false,
} = {}) {
  try {
    await fs.access(modulePath);
  } catch (error) {
    if (!required && error?.code === "ENOENT") return null;
    if (error?.code === "ENOENT") {
      throw new Error(`Inline image enrichment was requested, but the helper is missing: ${modulePath}`);
    }
    throw error;
  }

  let module;
  try {
    module = await import(pathToFileURL(path.resolve(modulePath)).href);
  } catch (error) {
    throw new Error(`Could not load inline image helper ${modulePath}: ${error.message}`, { cause: error });
  }
  const preferredEnrich = module.enrichNewsArticleWithInlineImages;
  const mirror = module.mirrorNewsInlineImages;
  if (typeof preferredEnrich !== "function" && typeof mirror !== "function") {
    throw new Error(`Inline image helper must export enrichNewsArticleWithInlineImages or mirrorNewsInlineImages: ${modulePath}`);
  }
  const enrich = typeof preferredEnrich === "function"
    ? preferredEnrich
    : (options = {}) => mirror({
      ...options,
      publicAssetBaseUrl: options.publicBase,
    });
  return { ...module, enrichNewsArticleWithInlineImages: enrich };
}

export async function enrichCandidateWithInlineImages({
  documents = [],
  healthySourceIds = new Set(NEWS_SOURCE_IDS),
  helper,
  stagedAssetDir,
  publicAssetBaseUrl = DEFAULT_PUBLIC_ASSET_BASE_URL,
  proxyUrl = "",
  limit = DEFAULT_INLINE_IMAGE_LIMIT,
  concurrency = DEFAULT_INLINE_IMAGE_CONCURRENCY,
  fetchHtmlImpl = fetchArticleHtml,
  fetchImageImpl = fetchRemoteImageBytes,
} = {}) {
  if (typeof helper?.enrichNewsArticleWithInlineImages !== "function") {
    throw new Error("Inline image helper is unavailable or has an invalid API");
  }
  const maxArticles = normalizePositiveInteger(limit, DEFAULT_INLINE_IMAGE_LIMIT);
  const candidates = selectInlineImageCandidates(documents, {
    healthySourceIds,
    publicAssetBaseUrl,
  }).slice(0, maxArticles);
  const proxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  const enrichments = [];
  const failures = [];
  const remoteImageFailures = [];
  const fetchedBySource = new Map();
  const attemptedBySource = new Map();
  const completedBySource = new Map();
  const mediaAttemptedBySource = new Map();
  const mediaImagesBySource = new Map();
  const mirroredImagesBySource = new Map();
  let remoteImagesFetched = 0;

  try {
    await runConcurrent(candidates, concurrency, async (article) => {
      attemptedBySource.set(article.sourceId, (attemptedBySource.get(article.sourceId) || 0) + 1);
      if (article.mediaType !== "article") {
        mediaAttemptedBySource.set(article.sourceId, (mediaAttemptedBySource.get(article.sourceId) || 0) + 1);
      }
      try {
        const documentUrl = getInlineImageDetailUrl(article);
        const html = await fetchHtmlImpl(documentUrl, {
          dispatcher: proxyAgent,
          timeoutMs: DEFAULT_INLINE_FETCH_TIMEOUT_MS,
          maxBytes: DEFAULT_INLINE_HTML_MAX_BYTES,
        });
        fetchedBySource.set(article.sourceId, (fetchedBySource.get(article.sourceId) || 0) + 1);
        const materialized = await inlineSameOriginRemoteImages({
          html,
          documentUrl,
          dispatcher: proxyAgent,
          fetchImageImpl,
          concurrency,
        });
        remoteImagesFetched += materialized.inlined;
        remoteImageFailures.push(...materialized.failures.map((failure) => ({
          sourceId: article.sourceId,
          documentId: article.id,
          ...failure,
        })));
        const result = await helper.enrichNewsArticleWithInlineImages({
          article,
          html: materialized.html,
          sourceId: article.sourceId,
          assetDir: stagedAssetDir,
          publicBase: publicAssetBaseUrl,
        });
        if (!result || !Array.isArray(result.imageDocuments) || !Array.isArray(result.images)) {
          throw new Error("inline image helper returned an invalid result");
        }
        completedBySource.set(article.sourceId, (completedBySource.get(article.sourceId) || 0) + 1);
        const resultImageCount = Array.isArray(result?.images) ? result.images.length : 0;
        mirroredImagesBySource.set(
          article.sourceId,
          (mirroredImagesBySource.get(article.sourceId) || 0) + resultImageCount,
        );
        if (article.mediaType !== "article") {
          mediaImagesBySource.set(article.sourceId, (mediaImagesBySource.get(article.sourceId) || 0) + resultImageCount);
        }
        enrichments.push({ original: article, result });
      } catch (error) {
        failures.push({
          sourceId: article.sourceId,
          documentId: article.id,
          error: String(error?.message || error),
        });
      }
    });
  } finally {
    await proxyAgent?.close?.().catch(() => {});
  }

  for (const sourceId of healthySourceIds) {
    const attempted = attemptedBySource.get(sourceId) || 0;
    const fetched = fetchedBySource.get(sourceId) || 0;
    const completed = completedBySource.get(sourceId) || 0;
    if (attempted > 0 && fetched === 0) {
      const sample = failures.find((failure) => failure.sourceId === sourceId)?.error || "no HTML responses";
      throw new Error(`Inline image enrichment could not fetch any ${sourceId} article HTML: ${sample}`);
    }
    if (attempted > 0 && completed === 0) {
      const sample = failures.find((failure) => failure.sourceId === sourceId)?.error || "image helper returned no successful results";
      throw new Error(`Inline image enrichment could not process any ${sourceId} detail HTML: ${sample}`);
    }
    const mediaAttempted = mediaAttemptedBySource.get(sourceId) || 0;
    if (mediaAttempted > 0 && (mediaImagesBySource.get(sourceId) || 0) === 0) {
      throw new Error(`Inline image enrichment produced no static previews for ${sourceId} photo/video details`);
    }
    const minimumMirroredImages = Number(MIN_MIRRORED_PREVIEW_COUNTS[sourceId] || 0);
    if ((mirroredImagesBySource.get(sourceId) || 0) < minimumMirroredImages) {
      throw new Error(
        `Inline image enrichment rediscovered only ${mirroredImagesBySource.get(sourceId) || 0} ${sourceId} image(s); at least ${minimumMirroredImages} are required for this refresh`,
      );
    }
  }

  const updatedById = new Map();
  const imageDocuments = [];
  let mirroredImages = 0;
  for (const { original, result } of enrichments) {
    const updatedArticle = result?.article || original;
    updatedById.set(original.id, {
      ...original,
      ...updatedArticle,
      cachedUrl: String(original.cachedUrl || "").trim() || String(updatedArticle.cachedUrl || "").trim(),
      cachedThumbnailUrl: String(original.cachedThumbnailUrl || "").trim()
        || String(updatedArticle.cachedThumbnailUrl || "").trim(),
    });
    for (const imageDocument of result?.imageDocuments || []) imageDocuments.push(imageDocument);
    mirroredImages += Array.isArray(result?.images) ? result.images.length : 0;
  }

  const baseDocuments = documents.map((document) => updatedById.get(document.id) || document);
  const merge = mergeSupplementalImageDocuments(baseDocuments, imageDocuments);
  return {
    documents: merge.documents,
    report: {
      attemptedArticles: candidates.length,
      fetchedArticles: [...fetchedBySource.values()].reduce((sum, count) => sum + count, 0),
      completedDetails: [...completedBySource.values()].reduce((sum, count) => sum + count, 0),
      failedArticles: failures.length,
      mirroredImages,
      remoteImagesFetched,
      mirroredImagesBySource: Object.fromEntries(mirroredImagesBySource),
      imageDocumentsAdded: merge.added,
      failures: failures.slice(0, 20),
      remoteImageFailures: remoteImageFailures.slice(0, 20),
    },
  };
}

export async function fetchArticleHtml(url, {
  dispatcher = null,
  timeoutMs = DEFAULT_INLINE_FETCH_TIMEOUT_MS,
  maxBytes = DEFAULT_INLINE_HTML_MAX_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const sourceUrl = new URL(String(url || ""));
  if (!/^https?:$/u.test(sourceUrl.protocol)) throw new Error(`Unsupported article URL protocol: ${sourceUrl.protocol}`);
  try {
    return await fetchBoundedHtml(sourceUrl.href, {
      dispatcher,
      timeoutMs,
      maxBytes,
      fetchImpl,
    });
  } catch (primaryError) {
    const fallbackUrl = `https://r.jina.ai/${sourceUrl.href}`;
    try {
      return await fetchBoundedHtml(fallbackUrl, {
        timeoutMs,
        maxBytes,
        fetchImpl,
        headers: { "X-Return-Format": "html" },
      });
    } catch (fallbackError) {
      throw new Error(`Article HTML fetch failed (${primaryError.message}); Jina HTML fallback failed (${fallbackError.message})`, {
        cause: fallbackError,
      });
    }
  }
}

async function fetchBoundedHtml(url, {
  dispatcher = null,
  timeoutMs = DEFAULT_INLINE_FETCH_TIMEOUT_MS,
  maxBytes = DEFAULT_INLINE_HTML_MAX_BYTES,
  fetchImpl = globalThis.fetch,
  headers = {},
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizePositiveInteger(timeoutMs, DEFAULT_INLINE_FETCH_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Encoding": "identity",
        "User-Agent": "DPRKArchiveNewsMirror/1.0 (+https://nkarchive.vercel.app/news)",
        ...headers,
      },
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (/^(?:image|audio|video)\//iu.test(contentType) || /application\/(?:pdf|octet-stream)/iu.test(contentType)) {
      throw new Error(`expected HTML but received ${contentType}`);
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength && contentLength > maxBytes) throw new Error(`article HTML exceeds ${maxBytes} bytes`);
    const bytes = await readResponseBytes(response, maxBytes);
    return decodeHtmlBytes(bytes, contentType);
  } finally {
    clearTimeout(timeout);
  }
}

export async function inlineSameOriginRemoteImages({
  html = "",
  documentUrl = "",
  dispatcher = null,
  fetchImageImpl = fetchRemoteImageBytes,
  concurrency = DEFAULT_INLINE_IMAGE_CONCURRENCY,
  maxImages = 64,
} = {}) {
  const baseUrl = new URL(String(documentUrl || ""));
  const $ = cheerio.load(String(html || ""));
  const root = findNewsArticleContainer($);
  if (!root?.length) return { html: String(html || ""), inlined: 0, failures: [] };
  const elementsByUrl = new Map();
  root.find("img[src]").each((_, element) => {
    const rawSource = String($(element).attr("src") || "").trim();
    if (!rawSource || /^(?:data|blob):/iu.test(rawSource)) return;
    let remoteUrl;
    try {
      remoteUrl = new URL(rawSource, baseUrl);
    } catch {
      return;
    }
    if (
      !/^https?:$/u.test(remoteUrl.protocol)
      || remoteUrl.origin !== baseUrl.origin
      || isGenericArtworkUrl(remoteUrl.href)
      || isDecorativeRemoteImage($, element, remoteUrl)
    ) return;
    const key = remoteUrl.href;
    if (!elementsByUrl.has(key)) elementsByUrl.set(key, []);
    elementsByUrl.get(key).push(element);
  });

  const urls = [...elementsByUrl.keys()].slice(0, normalizePositiveInteger(maxImages, 64));
  const dataUriByUrl = new Map();
  const failures = [];
  await runConcurrent(urls, concurrency, async (remoteUrl) => {
    try {
      const bytes = await fetchImageImpl(remoteUrl, {
        dispatcher,
        timeoutMs: DEFAULT_INLINE_FETCH_TIMEOUT_MS,
        maxBytes: DEFAULT_REMOTE_IMAGE_MAX_BYTES,
      });
      dataUriByUrl.set(remoteUrl, `data:;base64,${Buffer.from(bytes).toString("base64")}`);
    } catch (error) {
      failures.push({ url: remoteUrl, error: String(error?.message || error) });
    }
  });
  for (const [remoteUrl, dataUri] of dataUriByUrl) {
    for (const element of elementsByUrl.get(remoteUrl) || []) $(element).attr("src", dataUri);
  }
  return {
    html: $.html(),
    inlined: dataUriByUrl.size,
    failures,
  };
}

export async function fetchRemoteImageBytes(url, {
  dispatcher = null,
  timeoutMs = DEFAULT_INLINE_FETCH_TIMEOUT_MS,
  maxBytes = DEFAULT_REMOTE_IMAGE_MAX_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    return await fetchBoundedBinary(url, { dispatcher, timeoutMs, maxBytes, fetchImpl });
  } catch (proxyError) {
    if (!dispatcher) throw proxyError;
    try {
      return await fetchBoundedBinary(url, { timeoutMs, maxBytes, fetchImpl });
    } catch (directError) {
      throw new Error(`Remote image fetch failed through configured proxy (${proxyError.message}) and directly (${directError.message})`, {
        cause: directError,
      });
    }
  }
}

async function fetchBoundedBinary(url, {
  dispatcher = null,
  timeoutMs = DEFAULT_INLINE_FETCH_TIMEOUT_MS,
  maxBytes = DEFAULT_REMOTE_IMAGE_MAX_BYTES,
  fetchImpl = globalThis.fetch,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizePositiveInteger(timeoutMs, DEFAULT_INLINE_FETCH_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
        "Accept-Encoding": "identity",
        "User-Agent": "DPRKArchiveNewsMirror/1.0 (+https://nkarchive.vercel.app/news)",
      },
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength && contentLength > maxBytes) throw new Error(`remote image exceeds ${maxBytes} bytes`);
    return readResponseBytes(response, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function runOfficialNewsImporter({
  rootDir,
  outputPath,
  reportPath,
  cacheDir,
  proxyUrl = "",
  runCommandImpl = runCommand,
} = {}) {
  const args = [
    "run",
    "import:official-sites",
    "--",
    "--source",
    NEWS_SOURCE_IDS.join(","),
    "--out",
    outputPath,
    "--report",
    reportPath,
    "--cache-dir",
    cacheDir,
    "--merge-existing-output",
  ];
  if (proxyUrl) args.push("--proxy", proxyUrl);
  const result = await runCommandImpl("npm", args, { cwd: rootDir });
  if (result.code !== 0) throw new Error(`Official news importer failed with exit code ${result.code}`);
}

async function generateStagedNewsSnapshot({
  rootDir,
  tempDir,
  generatorPath,
  documentsText,
  runCommandImpl = runCommand,
} = {}) {
  try {
    await fs.access(generatorPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`News generator is missing: ${generatorPath}`);
    }
    throw error;
  }

  const stagingRoot = path.join(tempDir, "snapshot-site");
  await fs.mkdir(stagingRoot, { recursive: true });
  await Promise.all([
    fs.cp(path.join(rootDir, "scripts"), path.join(stagingRoot, "scripts"), { recursive: true }),
    fs.cp(path.join(rootDir, "search"), path.join(stagingRoot, "search"), { recursive: true }),
    fs.copyFile(path.join(rootDir, "package.json"), path.join(stagingRoot, "package.json")),
    fs.mkdir(path.join(stagingRoot, "data/search"), { recursive: true }),
  ]);
  const rootNodeModules = path.join(rootDir, "node_modules");
  try {
    await fs.symlink(rootNodeModules, path.join(stagingRoot, "node_modules"), "dir");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await fs.writeFile(path.join(stagingRoot, "data/search/documents.jsonl"), documentsText, "utf8");
  const stagedGeneratorPath = path.join(stagingRoot, "scripts", path.basename(generatorPath));
  const result = await runCommandImpl(process.execPath, [stagedGeneratorPath], { cwd: stagingRoot });
  if (result.code !== 0) throw new Error(`Staged news generation failed with exit code ${result.code}`);
  const [feedText, detailsText] = await Promise.all([
    fs.readFile(path.join(stagingRoot, "data/news-feed.json"), "utf8"),
    fs.readFile(path.join(stagingRoot, "data/news-details.json"), "utf8"),
  ]);
  return { feedText, detailsText };
}

async function promoteNewsMirrorCandidate({
  rootDir,
  documentsPath,
  healthPath,
  feedPath,
  detailsPath,
  assetDir,
  stagedAssetDir,
  stagedAssetFiles,
  candidateDocumentsText,
  candidateHealthText,
  expectedFeedText,
  expectedDetailsText,
  originals,
  runCommandImpl = runCommand,
} = {}) {
  const createdAssets = [];
  try {
    for (const stagedPath of stagedAssetFiles) {
      const relativePath = path.relative(stagedAssetDir, stagedPath);
      const targetPath = path.join(assetDir, relativePath);
      const existing = await readOptionalBuffer(targetPath);
      const staged = await fs.readFile(stagedPath);
      if (existing) {
        if (!existing.equals(staged)) throw new Error(`Refusing to overwrite different mirrored asset: ${targetPath}`);
        continue;
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(stagedPath, targetPath, fsConstants.COPYFILE_EXCL);
      createdAssets.push(targetPath);
    }

    await Promise.all([
      atomicWrite(documentsPath, candidateDocumentsText),
      atomicWrite(healthPath, candidateHealthText),
    ]);
    const generation = await runCommandImpl("npm", ["run", "generate:news"], { cwd: rootDir });
    if (generation.code !== 0) throw new Error(`News generation failed after document promotion with exit code ${generation.code}`);
    const [actualFeedText, actualDetailsText] = await Promise.all([
      fs.readFile(feedPath, "utf8"),
      fs.readFile(detailsPath, "utf8"),
    ]);
    if (actualFeedText !== expectedFeedText || actualDetailsText !== expectedDetailsText) {
      throw new Error("Promoted news snapshot differs from the validated staged snapshot");
    }
  } catch (error) {
    await Promise.all([
      atomicWrite(documentsPath, originals.documentsText),
      atomicWrite(healthPath, originals.healthText),
      restoreOptionalText(feedPath, originals.feedText),
      restoreOptionalText(detailsPath, originals.detailsText),
    ]).catch(() => {});
    await Promise.all(createdAssets.map((assetPath) => fs.rm(assetPath, { force: true }))).catch(() => {});
    throw error;
  }
}

function updateSourceHealth(existingHealth = {}, documents = [], now = new Date()) {
  const health = structuredClone(existingHealth);
  if (!Array.isArray(health.sources)) throw new Error("data/search/source-health.json must include sources");
  const counts = countBy(documents, (document) => document.sourceId);
  health.generatedAt = new Date(now).toISOString();
  health.sources = health.sources.map((source) => ({
    ...source,
    indexedDocuments: counts.get(source.sourceId) || 0,
  }));
  health.summary = {
    ...health.summary,
    totalSources: health.sources.length,
    searchableSources: health.sources.filter((source) => source.indexedDocuments > 0).length,
    healthySources: health.sources.filter((source) => source.status === "indexed").length,
    warningSources: health.sources.filter((source) => source.status === "indexed_with_warnings").length,
    unreachableSources: health.sources.filter((source) => source.status === "unreachable").length,
    totalDocuments: documents.length,
  };
  return health;
}

function validateSourceHealth(health = {}, documents = [], sources = []) {
  if (!Array.isArray(health.sources)) throw new Error("Candidate source health is missing sources");
  const expectedIds = sources.map((source) => source.id);
  const actualIds = health.sources.map((source) => source.sourceId);
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) throw new Error("Candidate source health source order changed");
  const counts = countBy(documents, (document) => document.sourceId);
  if (Number(health.summary?.totalDocuments) !== documents.length) throw new Error("Candidate source health document total is stale");
  for (const source of health.sources) {
    if (Number(source.indexedDocuments) !== (counts.get(source.sourceId) || 0)) {
      throw new Error(`Candidate source health count is stale for ${source.sourceId}`);
    }
  }
}

function validateNewsSnapshot(feedText, detailsText, documents = [], {
  categoryRequirements = KCNA_DESIGN_CATEGORY_REQUIREMENTS,
} = {}) {
  let feed;
  let details;
  try {
    feed = JSON.parse(feedText);
    details = JSON.parse(detailsText);
  } catch (error) {
    throw new Error(`Generated news snapshot is not valid JSON: ${error.message}`);
  }
  if (!feed?.version || feed.version !== details?.version) throw new Error("Generated news feed/detail versions do not match");
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  for (const sourceId of NEWS_SOURCE_IDS) {
    const articles = feed?.sources?.[sourceId]?.articles;
    if (!Array.isArray(articles) || !articles.length) throw new Error(`Generated news feed has no ${sourceId} articles`);
    if (articles.length > MAX_NEWS_RECORDS_PER_SOURCE) {
      throw new Error(`Generated news feed exceeds the ${sourceId} record cap`);
    }
    for (const article of articles) {
      const detail = details?.articles?.[article.id];
      const document = documentsById.get(article.id);
      if (!detail || !String(detail.body || "").trim()) throw new Error(`Generated news detail is missing a body: ${article.id}`);
      if (!document || document.sourceId !== sourceId) throw new Error(`Generated news article is missing from candidate documents: ${article.id}`);
    }
  }
  assertKcnaDesignCategoryCoverage(feed.sources.kcna.articles, {
    label: "generated KCNA feed",
    requirements: categoryRequirements,
  });
}

export function assertKcnaDesignCategoryCoverage(records = [], {
  label = "KCNA records",
  requirements = KCNA_DESIGN_CATEGORY_REQUIREMENTS,
} = {}) {
  const results = [];
  for (const [category, requirement] of Object.entries(requirements)) {
    const matching = records.filter((record) => {
      if (record.sourceId && record.sourceId !== "kcna") return false;
      if (record.language && record.language !== "ko") return false;
      if (String(record.mediaType || "article") !== requirement.mediaType) return false;
      return getRecordNewsCategories(record).includes(category);
    });
    results.push({
      category,
      mediaType: requirement.mediaType,
      count: matching.length,
      minimum: requirement.count,
    });
    if (matching.length < requirement.count) {
      throw new Error(
        `${label} has only ${matching.length}/${requirement.count} KCNA ${category} ${requirement.mediaType} record(s)`,
      );
    }
  }
  return results;
}

function getRecordNewsCategories(record = {}) {
  if (Array.isArray(record.categories)) return record.categories.map(String).filter(Boolean);
  return (Array.isArray(record.aliases) ? record.aliases : [])
    .map((alias) => String(alias || "").match(/^news-category:([a-z-]+)$/u)?.[1] || "")
    .filter(Boolean);
}

function mergeSupplementalImageDocuments(documents = [], imageDocuments = []) {
  const idIndex = new Map(documents.map((document, index) => [String(document.id || ""), index]));
  const output = [...documents];
  let added = 0;
  for (const imageDocument of imageDocuments) {
    const id = String(imageDocument?.id || "").trim();
    if (!id || !NEWS_SOURCE_IDS.includes(imageDocument.sourceId) || imageDocument.mediaType !== "image") continue;
    if (!id.startsWith(`${imageDocument.sourceId}-`)) {
      throw new Error(`Inline image document ID is not namespaced to its source: ${id}`);
    }
    const index = idIndex.get(id);
    if (index !== undefined) {
      const existing = output[index];
      if (
        existing.sourceId !== imageDocument.sourceId
        || existing.mediaType !== "image"
        || String(existing.url || "") !== String(imageDocument.url || "")
        || String(existing.archiveUrl || "") !== String(imageDocument.archiveUrl || "")
      ) {
        throw new Error(`Inline image document ID collides with a different document: ${id}`);
      }
      output[index] = mergeDocumentQuality(existing, imageDocument);
      continue;
    }
    idIndex.set(id, output.length);
    output.push(imageDocument);
    added += 1;
  }
  return { documents: output, added };
}

function normalizeImportReports(value = {}) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.reports) ? value.reports : [];
}

function getNewestKoreanArticleDate(documents = []) {
  return documents
    .filter((document) => document.mediaType === "article" && document.language === "ko")
    .map((document) => String(document.date || ""))
    .filter(Boolean)
    .sort()
    .at(-1) || "";
}

function createImporterSeed(documents = []) {
  const newsSeedIds = new Set();
  const seededDocuments = documents.map((document, index) => {
    if (!NEWS_SOURCE_IDS.includes(document.sourceId)) return document;
    const originalId = String(document.id || "");
    const encodedId = Buffer.from(originalId, "utf8").toString("base64url");
    const seedId = `__news_refresh_seed_v1__${index.toString(36)}_${encodedId}`;
    newsSeedIds.add(seedId);
    return { ...document, id: seedId };
  });
  return { documents: seededDocuments, newsSeedIds };
}

function chooseNonRegressingDate(existingDate = "", incomingDate = "") {
  if (!existingDate) return incomingDate;
  if (!incomingDate) return existingDate;
  return incomingDate >= existingDate ? incomingDate : existingDate;
}

function chooseRicherSnippet(existing = "", incoming = "") {
  const left = String(existing || "");
  const right = String(incoming || "");
  return normalizeComparableText(right).length > normalizeComparableText(left).length ? right : left;
}

function chooseThumbnailUrl(existing = "", incoming = "") {
  const left = String(existing || "").trim();
  const right = String(incoming || "").trim();
  if (left && !isGenericArtworkUrl(left)) return left;
  if (right && !isGenericArtworkUrl(right)) return right;
  return left || right;
}

function isGenericArtworkUrl(value = "") {
  try {
    const filename = decodeURIComponent(new URL(value, "https://archive.invalid").pathname).split("/").at(-1) || "";
    return GENERIC_ARTWORK_PATTERN.test(filename.toLocaleLowerCase("en-US"));
  } catch {
    return true;
  }
}

function getBodyQualityScore(body = "", document = {}) {
  const text = normalizeComparableText(body);
  const residualBonus = hasSubstantialArticleBody({ ...document, body }) ? 1000 : 0;
  const chromePenalty = LISTING_CHROME_PATTERN.test(text) ? 2000 : 0;
  return Math.min(text.length, 14000) + residualBonus - chromePenalty;
}

function normalizeComparableText(value = "") {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function removeComparableText(value = "", target = "") {
  if (!target) return value;
  return String(value).split(target).join(" ");
}

function compareNewestDocuments(left, right) {
  return String(right.date || "").localeCompare(String(left.date || ""), "en-US")
    || String(left.id || "").localeCompare(String(right.id || ""), "en-US");
}

function selectInlineImageCandidates(documents = [], {
  healthySourceIds = new Set(NEWS_SOURCE_IDS),
} = {}) {
  return NEWS_SOURCE_IDS
    .filter((sourceId) => healthySourceIds.has(sourceId))
    .flatMap((sourceId) => {
      const sourceDocuments = documents.filter((document) => (
        document.sourceId === sourceId
        && document.language === "ko"
        && String(document.url || document.archiveUrl || "").trim()
      ));
      const articleCandidates = sourceDocuments
        .filter((document) => document.mediaType === "article")
        .sort(compareNewestDocuments);
      const articles = sourceId === "kcna"
        ? selectKcnaCategoryCompleteCandidates(articleCandidates, "article", 120)
        : articleCandidates.slice(0, 120);
      const standaloneMedia = ["image", "video"].flatMap((mediaType) => {
        const mediaCandidates = sourceDocuments
          .filter((document) => document.mediaType === mediaType && isStandaloneNewsMediaDocument(document))
          .sort(compareNewestDocuments);
        return sourceId === "kcna"
          ? selectKcnaCategoryCompleteCandidates(mediaCandidates, mediaType, 24)
          : mediaCandidates.slice(0, 24);
      });
      return [...articles, ...standaloneMedia];
    });
}

function selectKcnaCategoryCompleteCandidates(candidates = [], mediaType, limit) {
  const selected = new Map();
  for (const [category, requirement] of Object.entries(KCNA_DESIGN_CATEGORY_REQUIREMENTS)) {
    if (requirement.mediaType !== mediaType) continue;
    let selectedForCategory = 0;
    for (const document of candidates) {
      if (!getRecordNewsCategories(document).includes(category)) continue;
      selected.set(document.id, document);
      selectedForCategory += 1;
      if (selectedForCategory >= requirement.count) break;
    }
  }
  for (const document of candidates) {
    if (selected.size >= limit) break;
    selected.set(document.id, document);
  }
  return [...selected.values()].sort(compareNewestDocuments).slice(0, limit);
}

export function assertMirroredPreviewCoverage(documents = [], {
  sourceIds = new Set(NEWS_SOURCE_IDS),
  publicAssetBaseUrl = DEFAULT_PUBLIC_ASSET_BASE_URL,
  minimumCounts = MIN_MIRRORED_PREVIEW_COUNTS,
} = {}) {
  const localPrefix = `${String(publicAssetBaseUrl).replace(/\/+$/u, "")}/`;
  const results = [];
  for (const sourceId of sourceIds) {
    const minimum = Number(minimumCounts?.[sourceId] || 0);
    if (!minimum) continue;
    const previewDocuments = documents.filter((document) => {
      if (document.sourceId !== sourceId || document.language !== "ko") return false;
      if (document.mediaType === "image" && !isStandaloneNewsMediaDocument(document)) return false;
      if (!["article", "image", "video"].includes(document.mediaType)) return false;
      return [document.cachedThumbnailUrl, document.cachedUrl]
        .some((value) => String(value || "").startsWith(localPrefix));
    });
    const uniquePreviews = new Set(previewDocuments.map((document) => document.id)).size;
    results.push({ sourceId, previewCount: uniquePreviews, minimum });
    if (uniquePreviews < minimum) {
      throw new Error(
        `Inline image enrichment produced only ${uniquePreviews} static ${sourceId} preview(s); at least ${minimum} are required`,
      );
    }
  }
  return results;
}

export function assertKcnaMediaPreviewCoverage(documents = [], {
  publicAssetBaseUrl = DEFAULT_PUBLIC_ASSET_BASE_URL,
  requirements = { photo: 2, video: 1 },
} = {}) {
  const localPrefix = `${String(publicAssetBaseUrl).replace(/\/+$/u, "")}/`;
  const results = [];
  for (const [category, minimum] of Object.entries(requirements)) {
    const mediaType = category === "photo" ? "image" : "video";
    const count = documents.filter((document) => (
      document.sourceId === "kcna"
      && document.language === "ko"
      && document.mediaType === mediaType
      && getRecordNewsCategories(document).includes(category)
      && [document.cachedThumbnailUrl, document.cachedUrl]
        .some((value) => String(value || "").startsWith(localPrefix))
    )).length;
    results.push({ category, mediaType, count, minimum });
    if (count < minimum) {
      throw new Error(`KCNA ${category} has only ${count}/${minimum} static preview(s)`);
    }
  }
  return results;
}

function isStandaloneNewsMediaDocument(document = {}) {
  const url = String(document.url || "").trim();
  const archiveUrl = String(document.archiveUrl || "").trim();
  return Boolean(url) && (!archiveUrl || url !== archiveUrl);
}

function getInlineImageDetailUrl(document = {}) {
  if (document.mediaType === "article") {
    return String(document.url || document.archiveUrl || "").trim();
  }
  return String(document.archiveUrl || document.originalSourceUrl || document.url || "").trim();
}

function findNewsArticleContainer($) {
  for (const selector of ["#news_view", "article", "main", ".article", ".content", "body"]) {
    const candidate = $(selector).first();
    if (candidate.length) return candidate;
  }
  return null;
}

function isDecorativeRemoteImage($, element, remoteUrl) {
  const image = $(element);
  let fileName = remoteUrl.pathname.split("/").at(-1) || "";
  try {
    fileName = decodeURIComponent(fileName);
  } catch {
    // Keep the encoded filename for conservative marker matching.
  }
  const marker = [
    image.attr("id"),
    image.attr("class"),
    image.attr("alt"),
    image.attr("title"),
    image.attr("role"),
    fileName,
  ].filter(Boolean).join(" ");
  if (REMOTE_DECORATIVE_IMAGE_PATTERN.test(marker)) return true;
  if (String(image.attr("aria-hidden") || "").toLocaleLowerCase("en-US") === "true") return true;
  return image.closest("header, nav, footer, aside, [role='banner'], [role='navigation']").length > 0;
}

function assertValidIndex(documents, sources, label) {
  const { errors } = validateSearchIndex(documents, sources);
  if (!errors.length) return;
  throw new Error(`${label} failed validation with ${errors.length} error(s):\n${errors.slice(0, 20).map((error) => `- ${error}`).join("\n")}`);
}

function assertCanonicalNewsSources(sources = []) {
  const sourceIds = new Set(sources.map((source) => source.id));
  const missing = NEWS_SOURCE_IDS.filter((sourceId) => !sourceIds.has(sourceId));
  if (missing.length) throw new Error(`Search source catalog is missing news source(s): ${missing.join(", ")}`);
}

async function assertLocalAssetReferencesExist(documents = [], {
  rootAssetDir,
  stagedAssetDir,
  publicAssetBaseUrl = DEFAULT_PUBLIC_ASSET_BASE_URL,
} = {}) {
  const prefix = `${String(publicAssetBaseUrl).replace(/\/+$/u, "")}/`;
  for (const document of documents) {
    for (const field of ["cachedUrl", "cachedThumbnailUrl"]) {
      const value = String(document[field] || "").split(/[?#]/u)[0];
      if (!value.startsWith(prefix)) continue;
      const relativePath = decodeURIComponent(value.slice(prefix.length));
      if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error(`Unsafe local asset reference in ${document.id}/${field}: ${value}`);
      }
      const rootPath = path.resolve(rootAssetDir, relativePath);
      const stagedPath = path.resolve(stagedAssetDir, relativePath);
      if (!isPathInside(rootAssetDir, rootPath) || !isPathInside(stagedAssetDir, stagedPath)) {
        throw new Error(`Local asset reference escapes the asset directory: ${value}`);
      }
      if (!await fileExists(rootPath) && !await fileExists(stagedPath)) {
        throw new Error(`Local asset reference has no staged or existing file: ${value}`);
      }
    }
  }
}

async function validateStagedNewsAssets(stagedFiles = [], {
  stagedAssetDir,
  documents = [],
  publicAssetBaseUrl = DEFAULT_PUBLIC_ASSET_BASE_URL,
} = {}) {
  const prefix = `${String(publicAssetBaseUrl).replace(/\/+$/u, "")}/`;
  const referencedPaths = new Set();
  for (const document of documents) {
    for (const field of ["cachedUrl", "cachedThumbnailUrl"]) {
      const value = String(document[field] || "").split(/[?#]/u)[0];
      if (!value.startsWith(prefix)) continue;
      referencedPaths.add(decodeURIComponent(value.slice(prefix.length)));
    }
  }

  for (const stagedPath of stagedFiles) {
    const relativePath = path.relative(stagedAssetDir, stagedPath).split(path.sep).join("/");
    const match = relativePath.match(/^(kcna|rodong-sinmun)\/([a-f0-9]{64})\.(jpg|png|gif|webp)$/u);
    if (!match) throw new Error(`Unexpected staged news asset path: ${relativePath}`);
    if (!referencedPaths.has(relativePath)) throw new Error(`Staged news asset is not referenced by a candidate document: ${relativePath}`);
    const bytes = await fs.readFile(stagedPath);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== match[2]) throw new Error(`Staged news asset filename does not match its content hash: ${relativePath}`);
  }
}

async function getAssetChanges(stagedFiles = [], stagedAssetDir, assetDir) {
  const changes = [];
  for (const stagedPath of stagedFiles) {
    const targetPath = path.join(assetDir, path.relative(stagedAssetDir, stagedPath));
    const existing = await readOptionalBuffer(targetPath);
    const staged = await fs.readFile(stagedPath);
    if (!existing || !existing.equals(staged)) changes.push(targetPath);
  }
  return changes;
}

async function readResponseBytes(response, maxBytes) {
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`article HTML exceeds ${maxBytes} bytes`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`article HTML exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function decodeHtmlBytes(bytes, contentType = "") {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  const charset = String(contentType).match(/charset=["']?\s*([^"'>;\s]+)/iu)?.[1]
    || new TextDecoder("utf-8").decode(bytes.subarray(0, 4096)).match(/charset=["']?\s*([^"'>;\s]+)/iu)?.[1]
    || "utf-8";
  try {
    return new TextDecoder(normalizeCharset(charset)).decode(bytes).replace(/\u0000/gu, "");
  } catch {
    return new TextDecoder("utf-8").decode(bytes).replace(/\u0000/gu, "");
  }
}

function normalizeCharset(value = "") {
  const charset = String(value).toLocaleLowerCase("en-US");
  if (["cp949", "x-windows-949", "ks_c_5601-1987", "ks_c_5601"].includes(charset)) return "windows-949";
  if (charset === "utf8") return "utf-8";
  return charset || "utf-8";
}

async function runConcurrent(items = [], concurrency = 1, handler) {
  const workerCount = Math.min(normalizePositiveInteger(concurrency, 1), items.length || 1);
  let index = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await handler(item);
    }
  }));
}

function countBy(items = [], getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function listFiles(directoryPath) {
  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files.sort((left, right) => left.localeCompare(right, "en-US"));
}

function isPathInside(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function atomicWrite(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, text, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function restoreOptionalText(filePath, text) {
  if (text === null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await atomicWrite(filePath, text);
}

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readOptionalBuffer(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeOperationReport(reportPath, report) {
  if (!reportPath) return;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function runCommand(command, args, { cwd = ROOT_DIR } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
    child.on("close", (code) => resolve({ code: code ?? 1 }));
    child.on("error", (error) => {
      console.error(error.message);
      resolve({ code: 1 });
    });
  });
}

function getArgumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return "";
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  loadDotEnvFile();
  const result = await refreshNewsMirror({
    documentsPath: getArgumentValue("--documents") || DEFAULT_DOCUMENTS_PATH,
    sourcesPath: getArgumentValue("--sources") || DEFAULT_SOURCES_PATH,
    healthPath: getArgumentValue("--health") || DEFAULT_HEALTH_PATH,
    feedPath: getArgumentValue("--feed") || DEFAULT_FEED_PATH,
    detailsPath: getArgumentValue("--details") || DEFAULT_DETAILS_PATH,
    generatorPath: getArgumentValue("--generator") || DEFAULT_GENERATOR_PATH,
    inlineImageModulePath: getArgumentValue("--inline-image-module") || DEFAULT_INLINE_IMAGE_MODULE_PATH,
    assetDir: getArgumentValue("--asset-dir") || DEFAULT_ASSET_DIR,
    reportPath: getArgumentValue("--report"),
    proxyUrl: getArgumentValue("--proxy") || process.env.DPRK_SEARCH_CRAWL_PROXY || "",
    enrichInlineImages: hasFlag("--enrich-inline-images"),
    inlineImageLimit: Number(getArgumentValue("--inline-image-limit") || DEFAULT_INLINE_IMAGE_LIMIT),
    inlineImageConcurrency: Number(getArgumentValue("--inline-image-concurrency") || DEFAULT_INLINE_IMAGE_CONCURRENCY),
    maxAgeDays: Number(getArgumentValue("--max-age-days") || DEFAULT_MAX_NEWS_AGE_DAYS),
    promote: !hasFlag("--dry-run"),
  });
  console.log("News mirror refresh completed:");
  console.log(`- status: ${result.report.status}`);
  console.log(`- documents: ${result.report.counts?.documentsBefore ?? 0} -> ${result.report.counts?.documentsAfter ?? 0}`);
  for (const source of result.sourceResults) {
    console.log(`- ${source.sourceId}: ${source.status}; +${source.acceptedNewDocuments}, updated ${source.updatedDocuments}, rejected ${source.rejectedDocuments}`);
  }
  if (result.inlineImages) {
    console.log(`- inline images: ${result.inlineImages.mirroredImages} mirrored from ${result.inlineImages.fetchedArticles}/${result.inlineImages.attemptedArticles} fetched articles`);
  }
}

const entryPointUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPointUrl) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
