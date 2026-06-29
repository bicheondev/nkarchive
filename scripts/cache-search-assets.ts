#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProxyAgent } from "undici";
import {
  parseJsonl,
  stringifyJsonl,
  toStoredSearchDocument,
  validateSearchIndex,
} from "../search/localIndex.js";
import { DEFAULT_USER_AGENT } from "./search-crawler-utils.ts";
import { loadDotEnvFile } from "./script-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
export const DEFAULT_DOCUMENTS_PATH = path.join(ROOT_DIR, "data/search/documents.jsonl");
export const DEFAULT_SOURCES_PATH = path.join(ROOT_DIR, "data/search/sources.json");
export const DEFAULT_ASSET_DIR = path.join(ROOT_DIR, "data/search/assets");
export const DEFAULT_REPORT_PATH = path.join(ROOT_DIR, "data/search/asset-cache-report.json");
export const DEFAULT_PUBLIC_ASSET_BASE_URL = "/data/search/assets";
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;
const KNOWN_ASSET_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpg",
  ".jpeg",
  ".png",
  ".svg",
  ".webp",
  ".pdf",
  ".m4v",
  ".mov",
  ".mp4",
  ".webm",
]);
let assetProxyAgent = null;
let assetProxyAgentUrl = "";

export async function cacheSearchAssets({
  documentsPath = DEFAULT_DOCUMENTS_PATH,
  sourcesPath = DEFAULT_SOURCES_PATH,
  outDocumentsPath = documentsPath,
  assetDir = DEFAULT_ASSET_DIR,
  publicBaseUrl = DEFAULT_PUBLIC_ASSET_BASE_URL,
  reportPath = DEFAULT_REPORT_PATH,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  limit = Infinity,
  concurrency = 4,
  refresh = false,
  dryRun = false,
  fetchProxyTemplate = "",
  fetchProxyBaseUrl = "",
  fetchProxyUrlParam = "url",
  sourceIds = [],
  excludedSourceIds = [],
  fetchImpl = globalThis.fetch,
} = {}) {
  const [rawDocuments, sources] = await Promise.all([
    readJsonlFile(documentsPath),
    readJsonFile(sourcesPath, []),
  ]);
  const { documents, errors } = validateSearchIndex(rawDocuments, sources);
  if (errors.length) {
    throw new Error(`Cannot cache search assets. Validation failed with ${errors.length} error(s):\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }

  const assetFetchProxy = normalizeAssetFetchProxyConfig({
    template: fetchProxyTemplate,
    baseUrl: fetchProxyBaseUrl,
    urlParam: fetchProxyUrlParam,
  });
  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    fetchProxy: {
      enabled: Boolean(assetFetchProxy),
      mode: assetFetchProxy?.mode || "direct",
    },
    outboundProxy: createOutboundProxyReport(assetFetchProxy),
    documents: documents.length,
    selectedDocuments: 0,
    sourceIds: normalizeStringList(sourceIds),
    excludedSourceIds: normalizeStringList(excludedSourceIds),
    concurrency: normalizeConcurrency(concurrency),
    attempted: 0,
    cached: 0,
    kept: 0,
    skipped: 0,
    failed: 0,
    failures: [],
    failureSummary: {
      bySource: [],
      byError: [],
    },
  };
  const updatedDocuments = documents.map((document) => ({ ...document }));
  const selectedSourceIds = normalizeStringList(sourceIds);
  const selectedExcludedSourceIds = normalizeStringList(excludedSourceIds);
  const selectedDocuments = updatedDocuments.filter((document) => shouldProcessAssetDocument(document, {
    sourceIds: selectedSourceIds,
    excludedSourceIds: selectedExcludedSourceIds,
  }));
  report.assetCoverage = {
    before: summarizeAssetCacheCoverage(updatedDocuments, {
      sourceIds: selectedSourceIds,
      excludedSourceIds: selectedExcludedSourceIds,
    }),
    after: null,
  };
  report.selectedDocuments = selectedDocuments.length;
  const workItems = createAssetCacheWorkItems(selectedDocuments, limit);
  report.attempted = workItems.length;
  await runConcurrent(workItems, report.concurrency, async ({ document, candidate }) => {
    try {
      const result = await cacheAssetCandidate(document, candidate, {
        assetDir,
        publicBaseUrl,
        timeoutMs,
        maxBytes,
        refresh,
        dryRun,
        assetFetchProxy,
        fetchImpl,
      });
      if (result.status === "kept") report.kept += 1;
      if (result.status === "cached") report.cached += 1;
      if (result.publicUrl) {
        for (const targetField of getCandidateTargetFields(candidate)) {
          document[targetField] = result.publicUrl;
        }
      }
    } catch (error) {
      const errorType = classifyAssetFailureError(error);
      report.failed += 1;
      report.failures.push({
        documentId: document.id,
        sourceId: document.sourceId,
        field: candidate.sourceField,
        url: candidate.url,
        errorType,
        error: error.message,
      });
    }
  });

  const skippedDocuments = selectedDocuments.filter((document) => !getAssetCacheCandidates(document).length).length;
  report.skipped = skippedDocuments;
  report.assetCoverage.after = summarizeAssetCacheCoverage(updatedDocuments, {
    sourceIds: selectedSourceIds,
    excludedSourceIds: selectedExcludedSourceIds,
  });
  report.failureSummary = summarizeAssetCacheFailures(report.failures);

  if (!dryRun) {
    await Promise.all([
      writeJsonl(outDocumentsPath, updatedDocuments.map(toStoredSearchDocument)),
      writeJson(reportPath, report),
    ]);
  }

  return { documents: updatedDocuments, report };
}

function summarizeAssetCacheFailures(failures = []) {
  const bySource = new Map();
  const byError = new Map();

  for (const failure of failures) {
    const sourceId = String(failure.sourceId || "unknown-source").trim() || "unknown-source";
    const errorType = String(failure.errorType || classifyAssetFailureError(failure.error || "")).trim() || "unknown";
    const error = String(failure.error || "").trim();
    const sourceSummary = bySource.get(sourceId) || {
      sourceId,
      failed: 0,
      fields: [],
      errorTypes: [],
      sampleError: "",
    };
    sourceSummary.failed += 1;
    sourceSummary.fields = addUniqueSorted(sourceSummary.fields, failure.field || "asset");
    sourceSummary.errorTypes = addUniqueSorted(sourceSummary.errorTypes, errorType);
    if (!sourceSummary.sampleError && error) sourceSummary.sampleError = error;
    bySource.set(sourceId, sourceSummary);

    const errorSummary = byError.get(errorType) || {
      errorType,
      failed: 0,
      sources: [],
      sampleError: "",
    };
    errorSummary.failed += 1;
    errorSummary.sources = addUniqueSorted(errorSummary.sources, sourceId);
    if (!errorSummary.sampleError && error) errorSummary.sampleError = error;
    byError.set(errorType, errorSummary);
  }

  return {
    bySource: [...bySource.values()].sort(compareFailureSummaryRows("sourceId")),
    byError: [...byError.values()].sort(compareFailureSummaryRows("errorType")),
  };
}

function compareFailureSummaryRows(tiebreakerField) {
  return (left, right) => (
    right.failed - left.failed
    || String(left[tiebreakerField] || "").localeCompare(String(right[tiebreakerField] || ""), "en-US")
  );
}

function addUniqueSorted(values = [], value = "") {
  const nextValue = String(value || "").trim();
  const nextValues = nextValue ? [...values, nextValue] : values;
  return [...new Set(nextValues)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function classifyAssetFailureError(error) {
  const message = String(error?.message || error || "");
  if (/unexpected content type/i.test(message)) return "unexpected_content_type";
  const httpStatus = message.match(/HTTP\s+(\d{3})\b/i);
  if (httpStatus) return `http_${httpStatus[1]}`;
  if (/too large|MAX_ASSET_BYTES|asset too large/i.test(message)) return "asset_too_large";
  if (/empty asset response/i.test(message)) return "empty_response";
  if (/aborted|abort|timeout|timed out/i.test(message)) return "timeout";
  if (/fetch failed|network/i.test(message)) return "network";
  return "unknown";
}

function createAssetCacheWorkItems(documents = [], limit = Infinity) {
  const workItems = [];
  const maxItems = normalizeLimit(limit);
  for (const document of documents) {
    if (workItems.length >= maxItems) break;
    for (const candidate of getAssetCacheCandidates(document)) {
      if (workItems.length >= maxItems) break;
      workItems.push({ document, candidate });
    }
  }
  return workItems;
}

async function runConcurrent(items = [], concurrency = 4, handler) {
  const workerCount = Math.min(normalizeConcurrency(concurrency), items.length || 1);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await handler(item);
    }
  }));
}

function shouldProcessAssetDocument(document = {}, { sourceIds = [], excludedSourceIds = [] } = {}) {
  const sourceId = String(document.sourceId || "").trim();
  if (sourceIds.length && !sourceIds.includes(sourceId)) return false;
  if (excludedSourceIds.length && excludedSourceIds.includes(sourceId)) return false;
  return true;
}

function summarizeAssetCacheCoverage(documents = [], { sourceIds = [], excludedSourceIds = [] } = {}) {
  const summary = {
    documents: documents.length,
    documentsWithCandidates: 0,
    candidates: 0,
    cached: 0,
    missing: 0,
    selectedDocumentsWithCandidates: 0,
    selectedCandidates: 0,
    selectedCached: 0,
    selectedMissing: 0,
    bySource: [],
  };
  const bySource = new Map();

  for (const document of documents) {
    const candidates = getAssetCacheCandidates(document);
    if (!candidates.length) continue;

    const sourceId = String(document.sourceId || "unknown-source");
    const selected = shouldProcessAssetDocument(document, { sourceIds, excludedSourceIds });
    const sourceSummary = bySource.get(sourceId) || {
      sourceId,
      documentsWithCandidates: 0,
      candidates: 0,
      cached: 0,
      missing: 0,
      selectedDocumentsWithCandidates: 0,
      selectedCandidates: 0,
      selectedCached: 0,
      selectedMissing: 0,
    };
    summary.documentsWithCandidates += 1;
    sourceSummary.documentsWithCandidates += 1;
    if (selected) {
      summary.selectedDocumentsWithCandidates += 1;
      sourceSummary.selectedDocumentsWithCandidates += 1;
    }

    for (const candidate of candidates) {
      const isCached = Boolean(document[candidate.targetField]);
      summary.candidates += 1;
      sourceSummary.candidates += 1;
      if (isCached) {
        summary.cached += 1;
        sourceSummary.cached += 1;
      } else {
        summary.missing += 1;
        sourceSummary.missing += 1;
      }
      if (selected) {
        summary.selectedCandidates += 1;
        sourceSummary.selectedCandidates += 1;
        if (isCached) {
          summary.selectedCached += 1;
          sourceSummary.selectedCached += 1;
        } else {
          summary.selectedMissing += 1;
          sourceSummary.selectedMissing += 1;
        }
      }
    }

    bySource.set(sourceId, sourceSummary);
  }

  summary.bySource = [...bySource.values()].sort((left, right) => (
    right.missing - left.missing
    || right.candidates - left.candidates
    || left.sourceId.localeCompare(right.sourceId, "en-US")
  ));
  return summary;
}

function createOutboundProxyReport(assetFetchProxy = null) {
  if (assetFetchProxy) {
    return {
      enabled: false,
      mode: "backend-proxy",
    };
  }
  const proxyUrl = getConfiguredAssetFetchProxyUrl("https://source.example/");
  return {
    enabled: Boolean(proxyUrl),
    mode: proxyUrl ? getConfiguredAssetFetchProxyMode() : "direct",
  };
}

export function getAssetCacheCandidates(document = {}) {
  const candidates = [];

  if (isCacheableRemoteThumbnail(document.thumbnailUrl)) {
    candidates.push({
      sourceField: "thumbnailUrl",
      targetField: "cachedThumbnailUrl",
      url: document.thumbnailUrl,
      mediaType: "image",
    });
  }

  if (shouldCachePrimaryUrl(document.url, document.mediaType)) {
    candidates.push({
      sourceField: "url",
      targetField: "cachedUrl",
      url: document.url,
      mediaType: document.mediaType,
    });
  } else if (!document.url && shouldCachePrimaryUrl(document.archiveUrl, document.mediaType)) {
    candidates.push({
      sourceField: "archiveUrl",
      targetField: "cachedUrl",
      url: document.archiveUrl,
      mediaType: document.mediaType,
    });
  }

  return dedupeCandidates(candidates);
}

async function cacheAssetCandidate(document, candidate, {
  assetDir,
  publicBaseUrl,
  timeoutMs,
  maxBytes,
  refresh,
  dryRun,
  assetFetchProxy,
  fetchImpl,
} = {}) {
  const existingPublicUrl = getExistingCandidatePublicUrl(document, candidate);
  if (!refresh && existingPublicUrl) {
    return { status: "kept", publicUrl: existingPublicUrl };
  }
  const assetPath = createAssetPath(document, candidate, assetDir);
  const publicUrl = createPublicAssetUrl(document, candidate, publicBaseUrl);
  if (!refresh && await fileExists(assetPath)) {
    return { status: "kept", publicUrl, assetPath };
  }

  const response = await fetchAssetBytes(candidate.url, {
    fetchImpl,
    timeoutMs,
    maxBytes,
    mediaType: candidate.mediaType,
    assetFetchProxy,
  });
  if (!response.bytes.byteLength) throw new Error("empty asset response");
  if (!dryRun) {
    await fs.mkdir(path.dirname(assetPath), { recursive: true });
    await fs.writeFile(assetPath, response.bytes);
  }
  return { status: "cached", publicUrl, assetPath, contentType: response.contentType };
}

async function fetchAssetBytes(url, {
  fetchImpl,
  timeoutMs,
  maxBytes,
  mediaType,
  assetFetchProxy,
} = {}) {
  if (!fetchImpl) throw new Error("No fetch implementation is available.");
  const fetchUrl = createAssetFetchUrl(url, assetFetchProxy);
  const dispatcher = assetFetchProxy ? null : getAssetFetchProxyDispatcher(url);
  try {
    return await fetchAssetBytesWithDispatcher(fetchUrl, {
      fetchImpl,
      timeoutMs,
      maxBytes,
      mediaType,
      dispatcher,
    });
  } catch (error) {
    if (!dispatcher || !shouldAllowAssetProxyDirectFallback() || !isRetryableAssetProxyRouteError(error)) throw error;
    try {
      return await fetchAssetBytesWithDispatcher(fetchUrl, {
        fetchImpl,
        timeoutMs: getAssetProxyDirectFallbackTimeoutMs(timeoutMs),
        maxBytes,
        mediaType,
        dispatcher: null,
      });
    } catch (fallbackError) {
      throw new Error(`${error.message}; direct retry without proxy failed: ${fallbackError.message}`);
    }
  }
}

async function fetchAssetBytesWithDispatcher(fetchUrl, {
  fetchImpl,
  timeoutMs,
  maxBytes,
  mediaType,
  dispatcher = null,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(fetchUrl, {
      signal: controller.signal,
      headers: {
        Accept: getAcceptHeader(mediaType),
        "User-Agent": DEFAULT_USER_AGENT,
      },
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength && contentLength > maxBytes) throw new Error(`asset too large: ${contentLength} bytes`);
    const contentType = response.headers.get("content-type") || "";
    if (!isExpectedAssetContentType(contentType, mediaType)) {
      throw new Error(`unexpected content type: ${contentType || "unknown"}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`asset too large: ${bytes.byteLength} bytes`);
    return { bytes, contentType };
  } finally {
    clearTimeout(timeout);
  }
}

function getAssetFetchProxyDispatcher(requestUrl = "") {
  const proxyUrl = getConfiguredAssetFetchProxyUrl(requestUrl);
  if (!proxyUrl) return null;
  if (assetProxyAgent && assetProxyAgentUrl === proxyUrl) return assetProxyAgent;
  assetProxyAgent = new ProxyAgent(proxyUrl);
  assetProxyAgentUrl = proxyUrl;
  return assetProxyAgent;
}

function getConfiguredAssetFetchProxyUrl(requestUrl = "") {
  if (hasFlag("--no-proxy")) return "";
  if (shouldBypassConfiguredProxyForUrl(requestUrl)) return "";
  const preferredProtocol = getUrlProtocol(requestUrl);
  if (preferredProtocol === "http:") {
    return getArgumentValue("--proxy")
      || process.env.HTTP_PROXY
      || process.env.http_proxy
      || process.env.ALL_PROXY
      || process.env.all_proxy
      || "";
  }
  return getArgumentValue("--proxy")
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || process.env.ALL_PROXY
    || process.env.all_proxy
    || "";
}

function getConfiguredAssetFetchProxyMode() {
  if (getArgumentValue("--proxy")) return "cli";
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) return "env";
  if (process.env.ALL_PROXY || process.env.all_proxy) return "all_proxy";
  return "direct";
}

function shouldAllowAssetProxyDirectFallback() {
  if (hasFlag("--no-proxy-direct-fallback")) return false;
  const configured = String(process.env.DPRK_SEARCH_PROXY_DIRECT_FALLBACK || "").trim();
  return !/^(0|false|no|off)$/i.test(configured);
}

function getAssetProxyDirectFallbackTimeoutMs(timeoutMs) {
  const timeout = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
  return Math.max(3000, Math.min(timeout, Math.ceil(timeout * 0.5)));
}

function isRetryableAssetProxyRouteError(error) {
  const message = String(error?.message || error || "");
  if (/HTTP \d{3}\b/.test(message)) return false;
  return /fetch failed|aborted|timeout|network/i.test(message)
    || error?.name === "AbortError";
}

function shouldBypassConfiguredProxyForUrl(requestUrl = "") {
  const rules = String(process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
  if (!rules.length) return false;
  const { hostname, port } = getUrlHostAndPort(requestUrl);
  if (!hostname) return false;
  return rules.some((rule) => proxyBypassRuleMatches(rule, hostname, port));
}

function getUrlHostAndPort(value = "") {
  try {
    const url = new URL(value);
    return {
      hostname: url.hostname.toLocaleLowerCase("en-US").replace(/\.$/, ""),
      port: url.port || (url.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    return { hostname: "", port: "" };
  }
}

function proxyBypassRuleMatches(rule = "", hostname = "", port = "") {
  if (rule === "*") return true;
  const [rawHost, rulePort = ""] = rule.toLocaleLowerCase("en-US").split(":");
  if (rulePort && rulePort !== port) return false;
  const hostRule = rawHost.replace(/^\*\./, ".").replace(/\.$/, "");
  if (!hostRule) return false;
  if (hostRule.startsWith(".")) {
    const suffix = hostRule.slice(1);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === hostRule || hostname.endsWith(`.${hostRule}`);
}

function getUrlProtocol(value = "") {
  try {
    return new URL(value).protocol;
  } catch {
    return "";
  }
}

function shouldCachePrimaryUrl(url = "", mediaType = "") {
  if (!isCacheableRemoteAsset(url)) return false;
  if (mediaType === "image") return isImageAssetUrl(url);
  if (mediaType === "pdf") return isPdfAssetUrl(url);
  return false;
}

function isCacheableRemoteAsset(url = "") {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) return false;
    return isImageAssetUrl(url) || isPdfAssetUrl(url) || isVideoAssetUrl(url);
  } catch {
    return false;
  }
}

function isCacheableRemoteThumbnail(url = "") {
  try {
    const parsed = new URL(url);
    return /^https?:$/i.test(parsed.protocol);
  } catch {
    return false;
  }
}

function isImageAssetUrl(url = "") {
  return /\.(?:avif|gif|jpe?g|png|svg|webp)(?:$|[?#])/i.test(url);
}

function isPdfAssetUrl(url = "") {
  return /\.pdf(?:$|[?#])/i.test(url);
}

function isVideoAssetUrl(url = "") {
  return /\.(?:m4v|mov|mp4|webm)(?:$|[?#])/i.test(url);
}

export function createAssetPath(document, candidate, assetDir) {
  return path.join(
    assetDir,
    sanitizePathSegment(document.sourceId || "unknown-source"),
    createAssetFileName(document, candidate),
  );
}

export function createPublicAssetUrl(document, candidate, publicBaseUrl = DEFAULT_PUBLIC_ASSET_BASE_URL) {
  return [
    String(publicBaseUrl || DEFAULT_PUBLIC_ASSET_BASE_URL).replace(/\/+$/, ""),
    encodeURIComponent(sanitizePathSegment(document.sourceId || "unknown-source")),
    encodeURIComponent(createAssetFileName(document, candidate)),
  ].join("/");
}

export function createAssetFileName(document, candidate) {
  const sourceField = sanitizePathSegment(candidate.sourceField || "asset");
  const hash = crypto.createHash("sha256").update(candidate.url).digest("hex").slice(0, 16);
  return `${sourceField}-${hash}${inferExtension(candidate.url, candidate.mediaType)}`;
}

export function inferExtension(url = "", mediaType = "") {
  try {
    const extension = path.extname(new URL(url).pathname).toLocaleLowerCase("en-US");
    if (KNOWN_ASSET_EXTENSIONS.has(extension)) return extension;
  } catch {
    // fall through
  }
  if (mediaType === "pdf") return ".pdf";
  if (mediaType === "video" || mediaType === "broadcast") return ".mp4";
  return ".jpg";
}

export function sanitizePathSegment(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "asset";
}

export function getAcceptHeader(mediaType = "") {
  if (mediaType === "pdf") return "application/pdf,*/*;q=0.8";
  if (mediaType === "video" || mediaType === "broadcast") return "video/*,*/*;q=0.8";
  return "image/avif,image/webp,image/png,image/jpeg,image/svg+xml,image/*,*/*;q=0.8";
}

export function normalizeAssetFetchProxyConfig(config = {}) {
  const template = String(config?.template || "").trim();
  const baseUrl = String(config?.baseUrl || "").trim();
  const urlParam = String(config?.urlParam || "url").trim() || "url";
  if (template) return { mode: "template", template, urlParam };
  if (baseUrl) return { mode: "baseUrl", baseUrl, urlParam };
  return null;
}

export function createAssetFetchUrl(assetUrl = "", proxyConfig = null) {
  const config = normalizeAssetFetchProxyConfig(proxyConfig);
  if (!config) return assetUrl;
  if (config.template) {
    if (config.template.includes("{url}")) {
      return config.template.replaceAll("{url}", encodeURIComponent(assetUrl));
    }
    return appendProxyUrlParam(config.template, config.urlParam, assetUrl);
  }
  return appendProxyUrlParam(config.baseUrl, config.urlParam, assetUrl);
}

function appendProxyUrlParam(endpoint = "", paramName = "url", assetUrl = "") {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint);
  const parsed = new URL(endpoint, absolute ? undefined : "http://asset-proxy.local");
  parsed.searchParams.set(paramName, assetUrl);
  if (absolute) return parsed.href;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function isExpectedAssetContentType(contentType = "", mediaType = "") {
  const normalized = String(contentType || "").toLocaleLowerCase("en-US");
  if (!normalized) return true;
  if (mediaType === "pdf") return normalized.includes("application/pdf") || normalized.includes("octet-stream");
  if (mediaType === "video" || mediaType === "broadcast") return normalized.startsWith("video/") || normalized.includes("octet-stream");
  return normalized.startsWith("image/") || normalized.includes("octet-stream");
}

function dedupeCandidates(candidates = []) {
  const merged = [];
  const byAssetUrl = new Map();

  for (const candidate of candidates) {
    const key = `${candidate.mediaType}:${candidate.url}`;
    const existing = byAssetUrl.get(key);
    if (!existing) {
      const normalized = {
        ...candidate,
        targetFields: getCandidateTargetFields(candidate),
      };
      byAssetUrl.set(key, normalized);
      merged.push(normalized);
      continue;
    }

    existing.targetFields = [...new Set([
      ...getCandidateTargetFields(existing),
      ...getCandidateTargetFields(candidate),
    ])];
  }

  return merged;
}

function getCandidateTargetFields(candidate = {}) {
  const fields = Array.isArray(candidate.targetFields) && candidate.targetFields.length
    ? candidate.targetFields
    : [candidate.targetField];
  return [...new Set(fields.map((field) => String(field || "").trim()).filter(Boolean))];
}

function getExistingCandidatePublicUrl(document = {}, candidate = {}) {
  for (const targetField of getCandidateTargetFields(candidate)) {
    const value = String(document[targetField] || "").trim();
    if (value) return value;
  }
  return "";
}

async function readJsonlFile(filePath) {
  try {
    return parseJsonl(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonl(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, stringifyJsonl(rows), "utf8");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeLimit(value) {
  if (value === Infinity) return Infinity;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : Infinity;
}

function normalizeConcurrency(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : 1;
}

function normalizeStringList(value = []) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))];
}

function getArgumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function getArgumentList(...names) {
  return names
    .flatMap((name) => String(getArgumentValue(name) || "").split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  loadDotEnvFile();
  const { report } = await cacheSearchAssets({
    documentsPath: getArgumentValue("--documents") || DEFAULT_DOCUMENTS_PATH,
    sourcesPath: getArgumentValue("--sources") || DEFAULT_SOURCES_PATH,
    outDocumentsPath: getArgumentValue("--out-documents") || getArgumentValue("--documents") || DEFAULT_DOCUMENTS_PATH,
    assetDir: path.resolve(getArgumentValue("--asset-dir") || DEFAULT_ASSET_DIR),
    publicBaseUrl: getArgumentValue("--public-base-url") || DEFAULT_PUBLIC_ASSET_BASE_URL,
    reportPath: getArgumentValue("--report") || DEFAULT_REPORT_PATH,
    timeoutMs: Number(getArgumentValue("--timeout-ms") || DEFAULT_TIMEOUT_MS),
    maxBytes: Number(getArgumentValue("--max-bytes") || DEFAULT_MAX_BYTES),
    limit: getArgumentValue("--limit") || Infinity,
    concurrency: Number(getArgumentValue("--concurrency") || 4),
    refresh: hasFlag("--refresh"),
    dryRun: hasFlag("--dry-run"),
    fetchProxyTemplate: getArgumentValue("--fetch-proxy-template"),
    fetchProxyBaseUrl: getArgumentValue("--fetch-proxy-base-url"),
    fetchProxyUrlParam: getArgumentValue("--fetch-proxy-url-param") || "url",
    sourceIds: getArgumentList("--source", "--sources"),
    excludedSourceIds: getArgumentList("--exclude-source", "--exclude-sources"),
  });

  console.log(`Search asset cache ${report.dryRun ? "dry run" : "updated"}:`);
  console.log(`- documents: ${report.documents}`);
  console.log(`- selected documents: ${report.selectedDocuments}`);
  console.log(`- concurrency: ${report.concurrency}`);
  console.log(`- attempted: ${report.attempted}`);
  console.log(`- cached: ${report.cached}`);
  console.log(`- kept: ${report.kept}`);
  console.log(`- failed: ${report.failed}`);
  if (report.assetCoverage?.after) {
    console.log(`- asset coverage: ${report.assetCoverage.after.cached}/${report.assetCoverage.after.candidates} cached, ${report.assetCoverage.after.missing} missing`);
    console.log(`- selected asset coverage: ${report.assetCoverage.after.selectedCached}/${report.assetCoverage.after.selectedCandidates} cached, ${report.assetCoverage.after.selectedMissing} missing`);
  }
  console.log(`- fetch proxy: ${report.fetchProxy.enabled ? report.fetchProxy.mode : "disabled"}`);
  console.log(`- outbound proxy: ${report.outboundProxy.enabled ? report.outboundProxy.mode : "disabled"}`);
  if (report.failureSummary?.bySource?.length) {
    console.log(`- failed by source: ${report.failureSummary.bySource.slice(0, 5).map((item) => `${item.sourceId}:${item.failed}`).join(", ")}`);
  }
  if (report.failureSummary?.byError?.length) {
    console.log(`- failed by error: ${report.failureSummary.byError.slice(0, 5).map((item) => `${item.errorType}:${item.failed}`).join(", ")}`);
  }
  for (const failure of report.failures.slice(0, 3)) {
    console.log(`- failure: ${failure.sourceId}/${failure.field}: ${failure.errorType || "unknown"}: ${failure.error}`);
  }
  if (report.failed && !report.dryRun) console.log(`- report: ${path.relative(ROOT_DIR, getArgumentValue("--report") || DEFAULT_REPORT_PATH)}`);
  if (report.failed && !report.dryRun && !hasFlag("--allow-failures")) {
    console.error(`Asset cache failed for ${report.failed} asset(s). Re-run with --allow-failures only when preserving a partial report is intentional.`);
    process.exit(1);
  }
}

const entryPointUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";

if (import.meta.url === entryPointUrl) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
