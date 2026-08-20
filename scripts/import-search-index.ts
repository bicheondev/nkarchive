#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseJsonl,
  stringifyJsonl,
  toStoredSearchDocument,
  toStoredSearchSource,
  validateSearchIndex,
} from "../search/localIndex.js";
import { preserveCachedAssetFields } from "../search/cachedAssetFields.js";
import { enrichArchiveOriginalSourceUrls } from "../search/originalSourceLinks.js";
import { dedupeDocumentsByStory } from "../search/resultIdentity.js";
import { SEARCH_SOURCES } from "../search/sourceConfig.js";
import { loadDotEnvFile } from "./script-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const IMPORT_DIR = path.join(DATA_DIR, "import");
const SEARCH_DIR = path.join(DATA_DIR, "search");
const DEFAULT_SOURCES_PATH = path.join(SEARCH_DIR, "sources.json");
const DEFAULT_DOCUMENTS_PATH = path.join(SEARCH_DIR, "documents.jsonl");
const DEFAULT_HEALTH_PATH = path.join(SEARCH_DIR, "source-health.json");
const MAX_FUTURE_DATE_SKEW_DAYS = 1;

const IMPORT_JOBS = [
  {
    name: "official-sites",
    script: "import:official-sites",
    documentsPath: path.join(IMPORT_DIR, "official-sites.documents.jsonl"),
    reportPath: path.join(IMPORT_DIR, "official-sites.report.json"),
  },
  {
    name: "kcna-watch",
    script: "import:kcna-watch",
    documentsPath: path.join(IMPORT_DIR, "kcna-watch.documents.jsonl"),
    reportPath: path.join(IMPORT_DIR, "kcna-watch.report.json"),
  },
  {
    name: "koryo-vod",
    script: "import:koryo-vod",
    documentsPath: path.join(IMPORT_DIR, "koryo-vod.documents.jsonl"),
    reportPath: path.join(IMPORT_DIR, "koryo-vod.report.json"),
  },
  {
    name: "youtube-metadata",
    script: "import:youtube-metadata",
    documentsPath: path.join(IMPORT_DIR, "youtube-metadata.documents.jsonl"),
    reportPath: path.join(IMPORT_DIR, "youtube-metadata.report.json"),
  },
];

async function main() {
  loadDotEnvFile();
  const shouldSkipImport = hasFlag("--skip-import");
  const documentsPath = path.resolve(getArgumentValue("--out-documents") || DEFAULT_DOCUMENTS_PATH);
  const sourcesPathArg = getArgumentValue("--sources");
  const sourcesPath = path.resolve(sourcesPathArg || DEFAULT_SOURCES_PATH);
  const healthPath = path.resolve(getArgumentValue("--health-out") || DEFAULT_HEALTH_PATH);
  const timeoutMs = getArgumentValue("--timeout-ms") || "15000";
  const maxSourceMs = getArgumentValue("--max-source-ms") || "180000";
  const limit = getArgumentValue("--limit") || "80";
  const concurrency = getArgumentValue("--concurrency") || "4";
  const pageSize = getArgumentValue("--page-size") || limit;
  const maxLinksPerSource = getArgumentValue("--max-links-per-source") || getArgumentValue("--max-links") || "400";
  const maxDiscoveryPages = getArgumentValue("--max-discovery-pages") || "60";
  const maxDetailFetchesPerSource = getArgumentValue("--max-detail-fetches-per-source") || "0";
  const maxPdfTextFetchesPerSource = getArgumentValue("--max-pdf-text-fetches-per-source") || "0";
  const retries = getArgumentValue("--retries") || "1";
  const requestDelayMs = getArgumentValue("--request-delay-ms") || "0";
  const discoveryReserveMs = getArgumentValue("--discovery-reserve-ms") || "0";
  const proxyUrl = getArgumentValue("--proxy") || "";
  const cacheDir = getArgumentValue("--cache-dir") || "";
  const sourceIds = getArgumentValue("--source") || getArgumentValue("--source-ids");
  const noFetchCache = hasFlag("--no-fetch-cache");
  const noReadableFallback = hasFlag("--no-readable-fallback");
  const allowShrinkSource = hasFlag("--allow-shrink-source");
  const explicitImportArgs = {
    timeoutMs: hasArgument("--timeout-ms"),
    maxSourceMs: hasArgument("--max-source-ms"),
    limit: hasArgument("--limit"),
    concurrency: hasArgument("--concurrency"),
    pageSize: hasArgument("--page-size") || hasArgument("--limit"),
    maxLinksPerSource: hasArgument("--max-links-per-source") || hasArgument("--max-links"),
    maxDiscoveryPages: hasArgument("--max-discovery-pages"),
    maxDetailFetchesPerSource: hasArgument("--max-detail-fetches-per-source"),
    maxPdfTextFetchesPerSource: hasArgument("--max-pdf-text-fetches-per-source"),
    retries: hasArgument("--retries"),
    requestDelayMs: hasArgument("--request-delay-ms"),
    discoveryReserveMs: hasArgument("--discovery-reserve-ms"),
  };

  if (!shouldSkipImport) {
    await runImportJobs({
      timeoutMs,
      maxSourceMs,
      limit,
      concurrency,
      pageSize,
      maxLinksPerSource,
      maxDiscoveryPages,
      maxDetailFetchesPerSource,
      maxPdfTextFetchesPerSource,
      retries,
      requestDelayMs,
      discoveryReserveMs,
      proxyUrl,
      cacheDir,
      sourceIds,
      noFetchCache,
      noReadableFallback,
      allowShrinkSource,
      explicitImportArgs,
    });
  }

  const [documentGroups, rawSources, importReports, existingSearchDocuments] = await Promise.all([
    Promise.all(IMPORT_JOBS.map((job) => readJsonl(job.documentsPath))),
    sourcesPathArg ? readJson(sourcesPath, []) : Promise.resolve(SEARCH_SOURCES),
    Promise.all(IMPORT_JOBS.map(readJobReport)),
    readJsonl(documentsPath),
  ]);
  const rawDocuments = dedupeDocumentsByStory(enrichArchiveOriginalSourceUrls(filterProductionDocuments(documentGroups.flat())));
  const { documents: validatedDocuments, sources, errors } = validateSearchIndex(rawDocuments, rawSources);

  if (errors.length) {
    console.error(`Search index import failed validation with ${errors.length} error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  const documents = preserveCachedAssetFields(validatedDocuments, existingSearchDocuments);

  const health = buildSourceHealth({
    documents,
    sources,
    rawSources,
    jobs: IMPORT_JOBS,
    importReports,
  });

  await Promise.all([
    writeJsonl(documentsPath, documents.map(toStoredSearchDocument)),
    writeJson(sourcesPath, sources.map(toStoredSearchSource)),
    writeJson(healthPath, health),
  ]);

  if (documentsPath === DEFAULT_DOCUMENTS_PATH) {
    const newsResult = await runCommand("npm", ["run", "generate:news"]);
    if (newsResult.code !== 0) {
      throw new Error(`News feed generation failed with exit code ${newsResult.code}`);
    }
  }

  console.log(`Search import completed.`);
  console.log(`- documents: ${documents.length}`);
  console.log(`- sources: ${sources.length}`);
  console.log(`- searchable sources: ${health.summary.searchableSources}/${health.summary.totalSources}`);
  console.log(`- healthy sources: ${health.summary.healthySources}/${health.summary.totalSources}`);
  console.log(`- warning sources: ${health.summary.warningSources}`);
  console.log(`- ${path.relative(ROOT_DIR, documentsPath)}`);
  console.log(`- ${path.relative(ROOT_DIR, healthPath)}`);
}

function filterProductionDocuments(documents = []) {
  const maxAllowedDate = getMaxAllowedDocumentDate();
  return documents.filter((document) => {
    const date = String(document?.date || "");
    return !/^\d{4}-\d{2}-\d{2}$/.test(date) || date <= maxAllowedDate;
  });
}

function getMaxAllowedDocumentDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + MAX_FUTURE_DATE_SKEW_DAYS);
  return date.toISOString().slice(0, 10);
}

async function runImportJobs({
  timeoutMs,
  maxSourceMs,
  limit,
  concurrency,
  pageSize,
  maxLinksPerSource,
  maxDiscoveryPages,
  maxDetailFetchesPerSource,
  maxPdfTextFetchesPerSource,
  retries,
  requestDelayMs,
  discoveryReserveMs,
  proxyUrl,
  cacheDir,
  sourceIds,
  noFetchCache,
  noReadableFallback,
  allowShrinkSource,
  explicitImportArgs = {},
}) {
  for (const job of IMPORT_JOBS) {
    const args = [
      "run",
      job.script,
      "--",
      "--out",
      job.documentsPath,
      "--report",
      job.reportPath,
    ];
    pushArgument(args, explicitImportArgs.limit, "--limit", limit);
    pushArgument(args, explicitImportArgs.timeoutMs, "--timeout-ms", timeoutMs);
    pushArgument(args, explicitImportArgs.maxSourceMs, "--max-source-ms", maxSourceMs);
    pushArgument(args, explicitImportArgs.maxLinksPerSource, "--max-links-per-source", maxLinksPerSource);
    pushArgument(args, explicitImportArgs.maxDiscoveryPages, "--max-discovery-pages", maxDiscoveryPages);
    pushArgument(args, explicitImportArgs.maxDetailFetchesPerSource, "--max-detail-fetches-per-source", maxDetailFetchesPerSource);
    pushArgument(args, explicitImportArgs.maxPdfTextFetchesPerSource, "--max-pdf-text-fetches-per-source", maxPdfTextFetchesPerSource);
    pushArgument(args, explicitImportArgs.retries, "--retries", retries);
    pushArgument(args, explicitImportArgs.requestDelayMs, "--request-delay-ms", requestDelayMs);
    pushArgument(args, explicitImportArgs.discoveryReserveMs, "--discovery-reserve-ms", discoveryReserveMs);
    if (proxyUrl) args.push("--proxy", proxyUrl);
    if (cacheDir) args.push("--cache-dir", cacheDir);
    if (sourceIds && job.name === "official-sites") {
      args.push("--source", sourceIds, "--merge-existing-output");
      if (allowShrinkSource) args.push("--allow-shrink-source");
    }
    if (noFetchCache) args.push("--no-fetch-cache");
    if (noReadableFallback) args.push("--no-readable-fallback");
    if (job.name !== "koryo-vod" && job.name !== "youtube-metadata") {
      pushArgument(args, explicitImportArgs.concurrency, "--concurrency", concurrency);
    } else if (job.name === "koryo-vod") {
      pushArgument(args, explicitImportArgs.pageSize, "--page-size", pageSize);
    }

    const result = await runCommand("npm", args);
    if (result.code !== 0) {
      console.warn(`${job.script} exited with ${result.code}; continuing with available import artifacts.`);
    }
  }
}

function pushArgument(args, condition, name, value) {
  if (!condition) return;
  args.push(name, value);
}

function buildSourceHealth({ documents, sources, rawSources = sources, jobs, importReports }) {
  const documentCountBySourceId = countDocumentsBySourceId(documents);
  const reportBySourceId = new Map();
  const rawSourceById = new Map(rawSources.map((source) => [source.id, source]));

  for (const jobReport of importReports) {
    for (const report of jobReport.reports) {
      reportBySourceId.set(report.sourceId, {
        ...report,
        importJob: jobReport.job.name,
        preservedExistingDocuments: jobReport.preservedExistingDocuments
          || (Array.isArray(jobReport.preservedSourceIds) && jobReport.preservedSourceIds.includes(report.sourceId)),
      });
    }
  }

  const sourceHealth = sources.map((source) => {
    const sourceConfig = rawSourceById.get(source.id) || source;
    const report = reportBySourceId.get(source.id);
    const indexedDocuments = documentCountBySourceId.get(source.id) || 0;
    const rawErrors = Array.isArray(report?.errors) ? report.errors : [];
    const detailLimitWarning = report?.detailFetchLimitReached
      ? [`detail fetch limit reached; ${report.detailFetchLimitFallbacks || 0} documents indexed from listing metadata`]
      : [];
    const { errors, warnings } = classifyImportDiagnostics([...rawErrors, ...detailLimitWarning], sourceConfig, indexedDocuments);
    const hasPartialImportWarning = Boolean(report?.timedOut) || warnings.some(isPartialIndexedWarning);
    const status = indexedDocuments > 0
      ? (errors.length || hasPartialImportWarning ? "indexed_with_warnings" : "indexed")
      : (errors.length ? "unreachable" : "empty");

    return {
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.sourceType,
      mediaTypes: source.mediaTypes || [],
      indexedDocuments,
      status,
      lastImporter: report?.importJob || "",
      discovered: report?.discovered ?? null,
      discoveryFetched: report?.discoveryFetched ?? null,
      apiFetched: report?.apiFetched ?? null,
      sitemapFetched: report?.sitemapFetched ?? null,
      searchFetched: report?.searchFetched ?? null,
      searchResultFallbacks: report?.searchResultFallbacks ?? null,
      listingFallbacks: report?.listingFallbacks ?? null,
      deadlineFallbacks: report?.deadlineFallbacks ?? null,
      fetched: report?.fetched ?? null,
      robotsDisallowed: report?.robotsDisallowed ?? null,
      robotsWarning: report?.robotsWarning || "",
      maxSourceMs: report?.maxSourceMs ?? null,
      maxDetailFetchesPerSource: report?.maxDetailFetchesPerSource ?? null,
      maxPdfTextFetchesPerSource: report?.maxPdfTextFetchesPerSource ?? null,
      detailFetchAttempts: report?.detailFetchAttempts ?? null,
      detailFetchLimitFallbacks: report?.detailFetchLimitFallbacks ?? null,
      pdfTextFetchAttempts: report?.pdfTextFetchAttempts ?? null,
      pdfTextFetchLimitFallbacks: report?.pdfTextFetchLimitFallbacks ?? null,
      timedOut: Boolean(report?.timedOut),
      importedThisRun: report?.indexed ?? null,
      preservedExistingDocuments: Boolean(report?.preservedExistingDocuments),
      warnings,
      errors,
    };
  });

  const searchableSources = sourceHealth.filter((source) => source.indexedDocuments > 0).length;
  const healthySources = sourceHealth.filter((source) => source.status === "indexed").length;
  const warningSources = sourceHealth.filter((source) => source.status === "indexed_with_warnings").length;
  const unreachableSources = sourceHealth.filter((source) => source.status === "unreachable").length;

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalSources: sources.length,
      searchableSources,
      healthySources,
      warningSources,
      unreachableSources,
      totalDocuments: documents.length,
    },
    sources: sourceHealth,
  };
}

function classifyImportDiagnostics(errors, source, indexedDocuments) {
  if (!indexedDocuments || !Array.isArray(errors) || !errors.length) {
    return { errors: Array.isArray(errors) ? errors : [], warnings: [] };
  }

  const warnings = [];
  const blockingErrors = [];

  for (const error of errors) {
    if (indexedDocuments && isPartialIndexedWarning(error)) {
      warnings.push(error);
    } else if (isOptionalDiscoveryFailure(error, source)) {
      warnings.push(error);
    } else if (indexedDocuments && isDiscoveryPageFailure(error, source)) {
      warnings.push(error);
    } else {
      blockingErrors.push(error);
    }
  }

  return { errors: blockingErrors, warnings };
}

function isPartialIndexedWarning(error) {
  return /source time budget exceeded|detail fetch limit reached/i.test(String(error || ""));
}

function isOptionalDiscoveryFailure(error, source) {
  const errorUrl = extractDiagnosticUrl(error);
  if (!errorUrl) return false;

  const optionalUrls = [
    source.crawler?.feedUrl,
    ...(source.crawler?.sitemapUrls || []),
  ]
    .map((url) => resolveMaybeUrl(url, source.baseUrl))
    .filter(Boolean);

  return optionalUrls.some((optionalUrl) => urlsMatch(errorUrl, optionalUrl));
}

function isDiscoveryPageFailure(error, source) {
  const errorText = String(error || "");
  const errorUrl = extractDiagnosticUrl(errorText);
  if (!errorUrl || !isTransientDiscoveryDiagnostic(errorText)) return false;
  if (matchesAnyUrlPattern(errorUrl, source.crawler?.includeUrlPatterns || [])) return false;
  return matchesAnyUrlPattern(errorUrl, source.crawler?.discoverUrlPatterns || []);
}

function isTransientDiscoveryDiagnostic(error) {
  return /HTTP\s+(?:408|425|429|5\d\d)\b|timed?\s*out|timeout|fetch failed|network/i.test(String(error || ""));
}

function matchesAnyUrlPattern(url, patterns = []) {
  return (patterns || []).some((pattern) => urlPatternMatches(url, pattern));
}

function urlPatternMatches(url, pattern) {
  if (!pattern) return false;
  if (pattern instanceof RegExp) return pattern.test(url);
  return String(url).includes(String(pattern));
}

function extractDiagnosticUrl(error) {
  const match = String(error || "").match(/^(https?:\/\/[^:\s]+(?:\/[^\s:]*)?)(?::\s|$)/i);
  return match?.[1] || "";
}

function resolveMaybeUrl(url, baseUrl) {
  if (!url) return "";
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return String(url || "");
  }
}

function urlsMatch(actual, expected) {
  try {
    const actualUrl = new URL(actual);
    const expectedUrl = new URL(expected);
    return actualUrl.origin === expectedUrl.origin
      && stripTrailingSlash(actualUrl.pathname) === stripTrailingSlash(expectedUrl.pathname);
  } catch {
    return String(actual) === String(expected);
  }
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/g, "");
}

async function readJobReport(job) {
  const parsed = await readJson(job.reportPath, []);
  if (Array.isArray(parsed)) {
    return { job, preservedExistingDocuments: false, reports: parsed };
  }
  return {
    job,
    preservedExistingDocuments: Boolean(parsed.preservedExistingDocuments),
    preservedSourceIds: Array.isArray(parsed.preservedSourceIds) ? parsed.preservedSourceIds : [],
    reports: Array.isArray(parsed.reports) ? parsed.reports : [],
  };
}

function countDocumentsBySourceId(documents) {
  const counts = new Map();
  for (const document of documents) {
    counts.set(document.sourceId, (counts.get(document.sourceId) || 0) + 1);
  }
  return counts;
}

async function readJsonl(filePath) {
  try {
    return parseJsonl(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readJson(filePath, fallback) {
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

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      stdio: "inherit",
      shell: false,
    });
    child.on("close", (code) => resolve({ code }));
  });
}

function getArgumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function hasArgument(name) {
  return process.argv.includes(name);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
