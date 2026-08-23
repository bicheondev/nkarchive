#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LocalJsonSearchProvider } from "../search/LocalJsonSearchProvider.js";
import { getSearchableBodyText, getSearchableSnippetText } from "../search/documentSearch.js";
import { getResolvedEntitySearchTerms, resolveKnownEntityQuery } from "../search/knownEntities.js";
import { parseJsonl, validateSearchIndex } from "../search/localIndex.js";
import { createSearchToken } from "../search/normalizeQuery.js";
import { SEARCH_SOURCES } from "../search/sourceConfig.js";
import { buildSearchSeed } from "./seed-search.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_DOCUMENTS_PATH = path.join(ROOT_DIR, "data/search/documents.jsonl");
const DEFAULT_SOURCES_PATH = path.join(ROOT_DIR, "data/search/sources.json");
const DEFAULT_HEALTH_PATH = path.join(ROOT_DIR, "data/search/source-health.json");
const DEFAULT_SEED_PATH = path.join(ROOT_DIR, "data/search/meilisearch-seed.json");
const DEFAULT_ASSET_CACHE_REPORT_PATH = path.join(ROOT_DIR, "data/search/asset-cache-report.json");
const DEFAULT_RUNTIME_DIRS = [
  path.join(ROOT_DIR, "search"),
  path.join(ROOT_DIR, "components"),
  path.join(ROOT_DIR, "api/search-asset.js"),
  path.join(ROOT_DIR, "api/search-live.js"),
  path.join(ROOT_DIR, "api/search-live-image.js"),
];
const DEFAULT_ASSET_PROXY_PATH = path.join(ROOT_DIR, "api/search-asset.js");
const DEFAULT_ROUTE_SHELLS = [
  { filePath: path.join(ROOT_DIR, "search/index.html"), page: "home", route: "/search" },
  { filePath: path.join(ROOT_DIR, "search/results/index.html"), page: "results", route: "/search/results" },
  { filePath: path.join(ROOT_DIR, "search/document/index.html"), page: "document", route: "/search/document" },
];
const SEARCH_ASSET_VERSION_PATTERN = /\bsearch-\d{8}-\d+\b/g;
const TEST_OR_MOCK_DOCUMENT_PATTERN = /\b(?:fixture|mock|placeholder)\b|example\.test|localhost|127\.0\.0\.1/i;
const MAX_FUTURE_DATE_SKEW_DAYS = 1;
const EXPECTED_SEED_CACHE = new Map();
const CRITICAL_QUERY_COVERAGE_CACHE = new Map();
const AUDIT_CACHE_ENTRY_LIMIT = 2;
const KP_SOURCE_IDS = SEARCH_SOURCES
  .filter((source) => getSourceHostname(source.baseUrl).endsWith(".kp"))
  .map((source) => source.id);
const OLD_MOCK_RESULT_TITLES = [
  "끝없이 넘쳐나는 인민의 행복 화성지구의 새 거리가 새집들이 ...",
  "화성지구 4단계 거리 사진 모음",
  "평양 새 살림집 입주 소식",
  "Respected Comrade Kim Jong Un Guides Construction Sector",
];
const FORBIDDEN_MANUAL_WONSAN_BACKFILL_IDS = new Set([
  "rodong-sinmun-wonsan-kalma-ceremony-2025-06-26",
  "voice-of-korea-wonsan-kalma-ceremony-2025-06-26",
  "kcna-wonsan-kalma-ceremony-2025-06-26",
  "kcna-wonsan-kalma-kim-jong-un-ceremony-2025-06-26",
]);
const MIN_SOURCE_DOCUMENT_COUNTS = {
  kcna: 240,
};
const KCNA_WONSAN_KALMA_CEREMONY_URL = "http://www.kcna.kp/kp/article/q/39fe6d16626f743979dbf8421474aca9.kcmsf";
const KCNA_WONSAN_KALMA_SERVICE_URL = "http://www.kcna.kp/kp/article/q/7814962e12328ec63931b157c5b3d5ceae3d0eb9cfe8dcd1cfb706a70acfaa0f2a339be80aceaeaf7192c1713ecd8235.kcmsf";
const KCNA_WONSAN_KALMA_CATEGORY_SEED_URLS = [
  "http://www.kcna.kp/kp/category/articles/q/54c0ca4ca013a92cc9cf95bd4004c61a.kcmsf?page=16",
  "http://www.kcna.kp/kp/category/articles/q/5394b80bdae203fadef02522cfb578c0.kcmsf?page=33",
];
const VOK_WONSAN_KALMA_CEREMONY_URL_PATTERN = /\/revo_de\/getDetail\/i[ek]n250625008\/(?:ko|en)$/i;
const KCNA_WATCH_WONSAN_KALMA_SERVICE_TITLE_PATTERN = /원산갈마해안관광지구\s*봉사\s*시작/;
const KCNA_WATCH_WONSAN_KALMA_CEREMONY_TITLE_PATTERN = /원산갈마해안관광지구\s*준공식/;
const CRITICAL_QUERY_COVERAGE_CHECKS = [
  {
    id: "wonsan",
    query: "원산",
    minTotal: 20,
    minSourceFacets: 5,
    requiredDisplaySourceIds: ["kcna-watch", "kcna", "choson-sinbo", "korean-books", "ryugyong"],
    requiredDocumentDisplaySourceIds: ["kcna", "rodong-sinmun", "voice-of-korea", "choson-sinbo"],
  },
  {
    id: "wonsan-kalma",
    query: "원산갈마",
    minTotal: 20,
    minSourceFacets: 5,
    requiredDisplaySourceIds: ["kcna-watch", "kcna", "choson-sinbo", "korean-books", "ryugyong"],
    requiredDocumentDisplaySourceIds: ["kcna", "rodong-sinmun", "voice-of-korea", "choson-sinbo"],
    requiredPhysicalSourceIds: ["kcna-watch"],
  },
  {
    id: "wonsan-kalma-ceremony",
    query: "원산갈마해안관광지구 준공식",
    minTotal: 6,
    minSourceFacets: 3,
    requiredDisplaySourceIds: ["kcna-watch", "choson-sinbo", "kcna"],
    requiredDocumentDisplaySourceIds: ["kcna", "rodong-sinmun", "voice-of-korea", "choson-sinbo", "kcna-watch"],
    requiredPhysicalSourceIds: ["kcna-watch", "choson-sinbo", "kcna", "voice-of-korea"],
    requireStrictMultiTerm: true,
  },
  {
    id: "wonsan-kalma-spaced",
    query: "원산 갈마",
    minTotal: 20,
    minSourceFacets: 5,
    sameFacetDistributionAs: "wonsan-kalma",
  },
  {
    id: "wonsan-exclude-kcna",
    query: "-site:kcna.kp 원산",
    minTotal: 15,
    minSourceFacets: 4,
    requiredDisplaySourceIds: ["kcna-watch", "choson-sinbo", "korean-books", "ryugyong"],
    forbiddenDisplaySourceIds: ["kcna"],
  },
  {
    id: "wonsan-not-kcna-site",
    query: "원산 NOT site:kcna.kp",
    minTotal: 15,
    minSourceFacets: 4,
    requiredDisplaySourceIds: ["kcna-watch", "choson-sinbo", "korean-books", "ryugyong"],
    forbiddenDisplaySourceIds: ["kcna"],
    expectedEffectiveQuery: "원산",
    sameFacetDistributionAs: "wonsan-exclude-kcna",
  },
  {
    id: "source-only-rodong",
    query: "site:rodong.rep.kp",
    minTotal: 10,
    minSourceFacets: 1,
    maxSourceFacets: 1,
    requiredDisplaySourceIds: ["rodong-sinmun"],
    onlyDocumentDisplaySourceIds: ["rodong-sinmun"],
    expectedEffectiveQuery: "",
  },
  {
    id: "source-only-rodong-exclude-wonsan",
    query: "site:rodong.rep.kp -원산",
    minTotal: 8,
    minSourceFacets: 1,
    maxSourceFacets: 1,
    requiredDisplaySourceIds: ["rodong-sinmun"],
    onlyDocumentDisplaySourceIds: ["rodong-sinmun"],
    expectedEffectiveQuery: "-원산",
    forbiddenDocumentTerms: ["원산"],
  },
  {
    id: "wonsan-exclude-kalma",
    query: "원산 -갈마",
    minTotal: 20,
    minSourceFacets: 3,
    forbiddenDocumentTerms: ["갈마"],
  },
  {
    id: "wonsan-not-kalma",
    query: "원산 NOT 갈마",
    minTotal: 20,
    minSourceFacets: 3,
    forbiddenDocumentTerms: ["갈마"],
    sameFacetDistributionAs: "wonsan-exclude-kalma",
  },
  {
    id: "source-vok-wonsan-kalma-ceremony",
    query: "site:vok.rep.kp 원산갈마해안관광지구 준공식",
    minTotal: 1,
    minSourceFacets: 1,
    maxSourceFacets: 1,
    requiredDisplaySourceIds: ["voice-of-korea"],
    onlyDocumentDisplaySourceIds: ["voice-of-korea"],
    requiredPreviewSourceNames: ["로동신문"],
    minDisplaySnippetLength: 180,
    requireStrictMultiTerm: true,
  },
  {
    id: "site-rep-kp-wonsan-kalma",
    query: "site:rep.kp 원산갈마",
    minTotal: 20,
    minSourceFacets: 3,
    requiredDisplaySourceIds: ["rodong-sinmun", "voice-of-korea", "minju-choson"],
    onlyDocumentDisplaySourceIds: ["rodong-sinmun", "voice-of-korea", "minju-choson"],
    requiredDocumentTerms: ["원산갈마"],
  },
  {
    id: "site-parenthesized-value-rep-kp-wonsan-kalma",
    query: "site:(rep.kp) 원산갈마",
    minTotal: 20,
    minSourceFacets: 3,
    requiredDisplaySourceIds: ["rodong-sinmun", "voice-of-korea", "minju-choson"],
    onlyDocumentDisplaySourceIds: ["rodong-sinmun", "voice-of-korea", "minju-choson"],
    requiredDocumentTerms: ["원산갈마"],
    expectedEffectiveQuery: "원산갈마",
    sameFacetDistributionAs: "site-rep-kp-wonsan-kalma",
  },
  {
    id: "site-tld-kp-wonsan-kalma",
    query: "site:kp 원산갈마",
    minTotal: 50,
    minSourceFacets: 5,
    requiredDisplaySourceIds: ["rodong-sinmun", "kcna", "voice-of-korea", "minju-choson", "ryugyong", "korean-books"],
    forbiddenDisplaySourceIds: ["kcna-watch", "choson-sinbo", "koryo-vod", "youtube"],
    onlyDocumentDisplaySourceIds: KP_SOURCE_IDS,
    requiredDocumentTerms: ["원산갈마"],
    expectedEffectiveQuery: "원산갈마",
  },
  {
    id: "site-korean-alias-kp-wonsan-kalma",
    query: "사이트:kp 원산갈마",
    minTotal: 50,
    minSourceFacets: 5,
    requiredDisplaySourceIds: ["rodong-sinmun", "kcna", "voice-of-korea", "minju-choson", "ryugyong", "korean-books"],
    forbiddenDisplaySourceIds: ["kcna-watch", "choson-sinbo", "koryo-vod", "youtube"],
    onlyDocumentDisplaySourceIds: KP_SOURCE_IDS,
    requiredDocumentTerms: ["원산갈마"],
    expectedEffectiveQuery: "원산갈마",
    sameFacetDistributionAs: "site-tld-kp-wonsan-kalma",
  },
  {
    id: "site-korean-alias-only-kp",
    query: "사이트:kp",
    minTotal: 1000,
    minSourceFacets: 6,
    requiredDisplaySourceIds: ["rodong-sinmun", "kcna", "voice-of-korea", "minju-choson", "ryugyong", "korean-books"],
    forbiddenDisplaySourceIds: ["kcna-watch", "choson-sinbo", "koryo-vod", "youtube"],
    onlyDocumentDisplaySourceIds: KP_SOURCE_IDS,
    expectedEffectiveQuery: "",
  },
  {
    id: "source-korean-alias-rodong-wonsan-kalma",
    query: "출처:로동신문 원산갈마",
    minTotal: 20,
    minSourceFacets: 1,
    maxSourceFacets: 1,
    requiredDisplaySourceIds: ["rodong-sinmun"],
    onlyDocumentDisplaySourceIds: ["rodong-sinmun"],
    requiredDocumentTerms: ["원산갈마"],
    expectedEffectiveQuery: "원산갈마",
  },
  {
    id: "site-or-sources-wonsan-kalma",
    query: "site:rodong.rep.kp OR site:vok.rep.kp 원산갈마",
    minTotal: 10,
    minSourceFacets: 2,
    maxSourceFacets: 2,
    requiredDisplaySourceIds: ["rodong-sinmun", "voice-of-korea"],
    onlyDocumentDisplaySourceIds: ["rodong-sinmun", "voice-of-korea"],
    requiredDocumentTerms: ["원산갈마"],
    expectedEffectiveQuery: "원산갈마",
  },
  {
    id: "site-or-sources-parenthesized-wonsan-kalma",
    query: "(site:rodong.rep.kp OR site:vok.rep.kp) 원산갈마",
    minTotal: 10,
    minSourceFacets: 2,
    maxSourceFacets: 2,
    requiredDisplaySourceIds: ["rodong-sinmun", "voice-of-korea"],
    onlyDocumentDisplaySourceIds: ["rodong-sinmun", "voice-of-korea"],
    requiredDocumentTerms: ["원산갈마"],
    expectedEffectiveQuery: "원산갈마",
    sameFacetDistributionAs: "site-or-sources-wonsan-kalma",
  },
  {
    id: "date-range-wonsan-kalma-june-2025",
    query: "date:2025-06-01..2025-06-30 원산갈마",
    minTotal: 5,
    minSourceFacets: 3,
    requiredDisplaySourceIds: ["kcna-watch", "rodong-sinmun", "choson-sinbo"],
    requiredDocumentTerms: ["원산갈마"],
    requiredDocumentDateFrom: "2025-06-01",
    requiredDocumentDateTo: "2025-06-30",
  },
  {
    id: "inurl-kcna-wonsan-kalma",
    query: "inurl:kcna.kp 원산갈마",
    minTotal: 1,
    minSourceFacets: 1,
    maxSourceFacets: 1,
    requiredDisplaySourceIds: ["kcna"],
    onlyDocumentDisplaySourceIds: ["kcna"],
    requiredDocumentTerms: ["원산갈마"],
  },
  {
    id: "filetype-only-pdf",
    query: "filetype:pdf",
    minTotal: 5,
    minSourceFacets: 1,
    requiredDisplaySourceIds: ["korean-books"],
    onlyDocumentMediaTypes: ["pdf"],
    expectedEffectiveQuery: "",
  },
  {
    id: "filetype-parenthesized-value-pdf",
    query: "filetype:(pdf)",
    minTotal: 5,
    minSourceFacets: 1,
    requiredDisplaySourceIds: ["korean-books"],
    onlyDocumentMediaTypes: ["pdf"],
    expectedEffectiveQuery: "",
    sameFacetDistributionAs: "filetype-only-pdf",
  },
  {
    id: "filetype-korean-alias-pdf",
    query: "파일형식:pdf",
    minTotal: 5,
    minSourceFacets: 1,
    requiredDisplaySourceIds: ["korean-books"],
    onlyDocumentMediaTypes: ["pdf"],
    expectedEffectiveQuery: "",
    sameFacetDistributionAs: "filetype-only-pdf",
  },
  {
    id: "filetype-negative-pdf",
    query: "-filetype:pdf",
    minTotal: 100,
    minSourceFacets: 5,
    forbiddenDocumentMediaTypes: ["pdf"],
    expectedEffectiveQuery: "",
  },
  {
    id: "language-negative-english",
    query: "-lang:en",
    minTotal: 100,
    minSourceFacets: 5,
    forbiddenDocumentLanguages: ["en"],
    expectedEffectiveQuery: "",
  },
  {
    id: "date-korean-alias-wonsan-kalma-june-2025",
    query: "이후:2025-06-01 이전:2025-06-30 원산갈마",
    minTotal: 5,
    minSourceFacets: 3,
    requiredDisplaySourceIds: ["kcna-watch", "rodong-sinmun", "choson-sinbo"],
    requiredDocumentTerms: ["원산갈마"],
    requiredDocumentDateFrom: "2025-06-01",
    requiredDocumentDateTo: "2025-06-30",
    expectedEffectiveQuery: "원산갈마",
    sameFacetDistributionAs: "date-range-wonsan-kalma-june-2025",
  },
  {
    id: "wonsan-english",
    query: "Wonsan",
    minTotal: 20,
    minSourceFacets: 5,
    requiredDisplaySourceIds: ["kcna-watch", "kcna", "choson-sinbo", "korean-books", "ryugyong"],
    requiredDocumentDisplaySourceIds: ["kcna", "rodong-sinmun", "voice-of-korea", "choson-sinbo"],
  },
  {
    id: "kalma-english",
    query: "Kalma",
    minTotal: 20,
    minSourceFacets: 5,
    requiredDisplaySourceIds: ["kcna-watch", "kcna", "choson-sinbo", "korean-books", "ryugyong"],
    requiredDocumentDisplaySourceIds: ["kcna", "rodong-sinmun", "voice-of-korea", "choson-sinbo"],
    requiredPhysicalSourceIds: ["kcna-watch"],
  },
  {
    id: "kim-wonsan-kalma",
    query: "김정은 원산갈마",
    minTotal: 1,
    requireStrictMultiTerm: true,
  },
  {
    id: "kim-wonsan-kalma-english",
    query: "Kim Jong Un Wonsan Kalma",
    minTotal: 1,
    requireStrictMultiTerm: true,
  },
];

async function main() {
  const result = await auditSearchProductionBundle();
  if (result.errors.length) {
    console.error(`Search production audit failed with ${result.errors.length} error(s):`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log("Search production audit passed:");
  console.log(`- sources: ${result.summary.sources}`);
  console.log(`- documents: ${result.summary.documents}`);
  console.log(`- suggestions: ${result.summary.suggestions}`);
  console.log(`- searchable sources: ${result.summary.searchableSources}/${result.summary.sources}`);
  console.log(`- healthy sources: ${result.summary.healthySources}/${result.summary.sources}`);
  console.log(`- warning sources: ${result.summary.warningSources}`);
  if (result.assetCacheCoverage?.after) {
    const coverage = result.assetCacheCoverage.after;
    console.log(`- asset cache: ${coverage.cached}/${coverage.candidates} cached, ${coverage.missing} missing`);
    console.log(`- selected asset cache: ${coverage.selectedCached}/${coverage.selectedCandidates} cached, ${coverage.selectedMissing} missing`);
    if (result.assetCacheCoverage.topMissingSources.length) {
      const sources = result.assetCacheCoverage.topMissingSources
        .map((source) => `${source.sourceId}:${source.missing}`)
        .join(", ");
      console.log(`- asset cache missing by source: ${sources}`);
    }
  }
  if (result.queryCoverage.length) {
    console.log("- critical query coverage:");
    for (const coverage of result.queryCoverage) {
      const facets = coverage.sourceFacets.map((facet) => `${facet.sourceName}:${facet.count}`).join(", ");
      console.log(`  - ${coverage.query}: ${coverage.total} results across ${coverage.sourceFacets.length} source(s)${facets ? ` (${facets})` : ""}`);
    }
  }
  if (result.sourceWarnings.length) {
    console.log("- warning source details:");
    for (const source of result.sourceWarnings) {
      console.log(`  - ${source.sourceName} (${source.status}): ${source.reason}`);
    }
  }
}

export async function auditSearchProductionBundle({
  documentsPath = DEFAULT_DOCUMENTS_PATH,
  sourcesPath = DEFAULT_SOURCES_PATH,
  healthPath = DEFAULT_HEALTH_PATH,
  seedPath = DEFAULT_SEED_PATH,
  assetCacheReportPath = DEFAULT_ASSET_CACHE_REPORT_PATH,
  runtimeDirs = DEFAULT_RUNTIME_DIRS,
  assetProxyPath = DEFAULT_ASSET_PROXY_PATH,
  routeShells = DEFAULT_ROUTE_SHELLS,
} = {}) {
  const [rawDocuments, rawSources, health, seedFromDisk, assetCacheReport] = await Promise.all([
    readJsonlFile(documentsPath),
    readJsonFile(sourcesPath, []),
    readJsonFile(healthPath, null),
    readJsonFile(seedPath, null),
    readJsonFile(assetCacheReportPath, null),
  ]);
  const validation = validateSearchIndex(rawDocuments, rawSources);
  const errors = [...validation.errors];
  const corpusFingerprint = createCorpusFingerprint(validation.documents, validation.sources);
  let seed = seedFromDisk;
  if (!seed) {
    try {
      seed = await buildSearchSeed({ documentsPath, sourcesPath });
    } catch (error) {
      errors.push(`Meilisearch seed payload could not be generated from the current production index: ${error.message}`);
    }
  }

  auditStoredIndexPayload(rawDocuments, rawSources, errors);
  await auditCachedAssetFiles(rawDocuments, errors);
  auditCanonicalSources(validation.sources, errors);
  auditIndexedDocumentLanguages(validation.documents, validation.sources, errors);
  auditSourceHealth(validation.documents, validation.sources, health, errors);
  auditAssetCacheReport(assetCacheReport, errors);
  auditMeilisearchSeed(validation.documents, validation.sources, seed, errors);
  await auditMeilisearchSeedPayload(documentsPath, sourcesPath, seed, errors, corpusFingerprint);
  await auditSearchAssetVersions(runtimeDirs, errors);
  await auditSearchAssetProxy(assetProxyPath, errors);
  await auditSearchRouteShells(routeShells, errors);
  const queryCoverage = await auditCriticalQueryCoverage(validation.documents, validation.sources, errors, corpusFingerprint);

  const sourceWarnings = createSourceWarningDetails(health);
  const assetCacheCoverage = createAssetCacheCoverageSummary(assetCacheReport);
  return {
    errors,
    queryCoverage,
    sourceWarnings,
    assetCacheCoverage,
    summary: {
      sources: validation.sources.length,
      documents: validation.documents.length,
      suggestions: Array.isArray(seed?.suggestions) ? seed.suggestions.length : 0,
      searchableSources: Number(health?.summary?.searchableSources || 0),
      healthySources: Number(health?.summary?.healthySources || 0),
      warningSources: Number(health?.summary?.warningSources || 0),
    },
  };
}

async function auditSearchRouteShells(routeShells = DEFAULT_ROUTE_SHELLS, errors) {
  for (const shell of routeShells) {
    const filePath = typeof shell === "string" ? shell : shell.filePath;
    const route = typeof shell === "string" ? path.relative(ROOT_DIR, shell) : shell.route;
    const page = typeof shell === "string" ? "" : shell.page;
    let html = "";
    try {
      html = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        errors.push(`[route:${route}] search route shell is missing: ${path.relative(ROOT_DIR, filePath)}`);
        continue;
      }
      throw error;
    }

    const label = route || path.relative(ROOT_DIR, filePath);
    const requiredSignals = [
      ["<!doctype html>", "ship as a standalone static HTML route"],
      ['<html lang="ko">', "preserve Korean document language"],
      ['<base href="/" />', "resolve shared absolute search assets consistently"],
      ["data-search-root", "mount the search portal runtime"],
      ['src="/search/search-config.js?v=search-', "load runtime search configuration with the cache key"],
      ['type="module" src="/search/searchPortal.js?v=search-', "load the search portal runtime with the cache key"],
    ];
    if (page) requiredSignals.push([`data-search-page="${page}"`, `identify the ${page} route to CSS and runtime code`]);
    for (const [needle, reason] of requiredSignals) {
      if (!html.includes(needle)) errors.push(`[route:${label}] route shell must include ${needle} to ${reason}`);
    }
  }
}

async function auditCriticalQueryCoverage(documents = [], sources = [], errors, corpusFingerprint = "") {
  const cacheKey = corpusFingerprint || createCorpusFingerprint(documents, sources);
  let cachedPromise = CRITICAL_QUERY_COVERAGE_CACHE.get(cacheKey);
  if (!cachedPromise) {
    cachedPromise = computeCriticalQueryCoverage(documents, sources);
    setBoundedAuditCache(CRITICAL_QUERY_COVERAGE_CACHE, cacheKey, cachedPromise);
  }

  try {
    const result = await cachedPromise;
    errors.push(...result.errors);
    return cloneJsonValue(result.coverage);
  } catch (error) {
    CRITICAL_QUERY_COVERAGE_CACHE.delete(cacheKey);
    throw error;
  }
}

async function computeCriticalQueryCoverage(documents = [], sources = []) {
  const provider = new LocalJsonSearchProvider({ documents, sources });
  const coverage = [];
  const coverageById = new Map();
  const errors = [];

  for (const check of CRITICAL_QUERY_COVERAGE_CHECKS) {
    let result;
    try {
      result = await provider.searchDocuments(check.query, {
        tab: "all",
        limit: 200,
        offset: 0,
      });
    } catch (error) {
      errors.push(`[critical-query:${check.id}] search failed for ${check.query}: ${error.message}`);
      continue;
    }

    const entry = createQueryCoverageEntry(check, result);
    coverage.push(entry);
    coverageById.set(check.id, entry);
    auditQueryCoverageEntry(check, entry, errors);
  }

  for (const check of CRITICAL_QUERY_COVERAGE_CHECKS) {
    if (!check.sameFacetDistributionAs) continue;
    const entry = coverageById.get(check.id);
    const expected = coverageById.get(check.sameFacetDistributionAs);
    if (!entry || !expected) continue;
    if (stableStringify(entry.sourceFacets) !== stableStringify(expected.sourceFacets)) {
      errors.push(`[critical-query:${check.id}] source-facet distribution must match ${check.sameFacetDistributionAs}; got ${formatFacetSummary(entry.sourceFacets)}, expected ${formatFacetSummary(expected.sourceFacets)}`);
    }
  }

  return { coverage, errors };
}

function createQueryCoverageEntry(check, result = {}) {
  const documents = Array.isArray(result.documents) ? result.documents : [];
  const sourceFacets = (result.sourceFacets || []).map((facet) => ({
    sourceId: facet.sourceId,
    sourceName: facet.sourceName,
    count: Number(facet.count) || 0,
  }));

  return {
    id: check.id,
    query: check.query,
    effectiveQuery: String(result.query || ""),
    total: Number(result.total || 0),
    sourceFacets,
    documentDisplaySourceIds: [...new Set(documents.map((document) => document.displaySourceId || document.sourceId).filter(Boolean))].sort(),
    documentMediaTypes: [...new Set(documents.map((document) => document.mediaType).filter(Boolean))].sort(),
    documentLanguages: [...new Set(documents.map((document) => document.language).filter(Boolean))].sort(),
    previewSourceNames: [...new Set(documents.map((document) => document.previewSourceName).filter(Boolean))].sort(),
    minDisplaySnippetLength: documents.length
      ? Math.min(...documents.map((document) => String(document.displaySnippet || "").trim().length))
      : 0,
    forbiddenTermMatches: Object.fromEntries((check.forbiddenDocumentTerms || []).map((term) => [
      term,
      documents.filter((document) => documentContainsTerm(document, term)).map((document) => document.id || "unknown"),
    ])),
    requiredTermMisses: Object.fromEntries((check.requiredDocumentTerms || []).map((term) => [
      term,
      documents.filter((document) => !documentContainsTerm(document, term)).map((document) => document.id || "unknown"),
    ])),
    requiredDateRangeMisses: documents
      .filter((document) => !documentDateIsWithinRange(document, check.requiredDocumentDateFrom, check.requiredDocumentDateTo))
      .map((document) => document.id || "unknown"),
    physicalSourceIds: [...new Set(documents.map((document) => document.sourceId).filter(Boolean))].sort(),
    strictMultiTerm: documents.length > 0 && documents.every((document) => String(document.scoreReason || "").startsWith("multi:")),
  };
}

function auditQueryCoverageEntry(check, entry, errors) {
  if (entry.total < Number(check.minTotal || 0)) {
    errors.push(`[critical-query:${check.id}] ${check.query} should return at least ${check.minTotal} real result(s), got ${entry.total}`);
  }
  if (Object.hasOwn(check, "expectedEffectiveQuery") && entry.effectiveQuery !== check.expectedEffectiveQuery) {
    errors.push(`[critical-query:${check.id}] ${check.query} should strip to backend query ${JSON.stringify(check.expectedEffectiveQuery)}, got ${JSON.stringify(entry.effectiveQuery)}`);
  }
  if (entry.sourceFacets.length < Number(check.minSourceFacets || 0)) {
    errors.push(`[critical-query:${check.id}] ${check.query} should span at least ${check.minSourceFacets} source(s), got ${formatFacetSummary(entry.sourceFacets)}`);
  }
  if (Object.hasOwn(check, "maxSourceFacets") && entry.sourceFacets.length > Number(check.maxSourceFacets)) {
    errors.push(`[critical-query:${check.id}] ${check.query} should expose at most ${check.maxSourceFacets} source facet(s), got ${formatFacetSummary(entry.sourceFacets)}`);
  }

  const displaySourceIds = new Set(entry.sourceFacets.map((facet) => facet.sourceId));
  for (const sourceId of check.requiredDisplaySourceIds || []) {
    if (!displaySourceIds.has(sourceId)) {
      errors.push(`[critical-query:${check.id}] ${check.query} must expose source ${sourceId}; got ${formatFacetSummary(entry.sourceFacets)}`);
    }
  }
  for (const sourceId of check.forbiddenDisplaySourceIds || []) {
    if (displaySourceIds.has(sourceId)) {
      errors.push(`[critical-query:${check.id}] ${check.query} must exclude source ${sourceId}; got ${formatFacetSummary(entry.sourceFacets)}`);
    }
  }

  const documentDisplaySourceIds = new Set(entry.documentDisplaySourceIds);
  for (const sourceId of check.requiredDocumentDisplaySourceIds || []) {
    if (!documentDisplaySourceIds.has(sourceId)) {
      errors.push(`[critical-query:${check.id}] ${check.query} must expose original-source provenance ${sourceId} on result cards; got ${entry.documentDisplaySourceIds.join(", ") || "none"}`);
    }
  }

  const physicalSourceIds = new Set(entry.physicalSourceIds);
  for (const sourceId of check.requiredPhysicalSourceIds || []) {
    if (!physicalSourceIds.has(sourceId)) {
      errors.push(`[critical-query:${check.id}] ${check.query} must include physical source ${sourceId}; got ${entry.physicalSourceIds.join(", ") || "none"}`);
    }
  }

  const previewSourceNames = new Set(entry.previewSourceNames || []);
  for (const sourceName of check.requiredPreviewSourceNames || []) {
    if (!previewSourceNames.has(sourceName)) {
      errors.push(`[critical-query:${check.id}] ${check.query} must use enriched preview provenance ${sourceName}; got ${(entry.previewSourceNames || []).join(", ") || "none"}`);
    }
  }

  if (check.minDisplaySnippetLength && entry.minDisplaySnippetLength < Number(check.minDisplaySnippetLength)) {
    errors.push(`[critical-query:${check.id}] ${check.query} must render substantive enriched snippets at least ${check.minDisplaySnippetLength} characters, got ${entry.minDisplaySnippetLength}`);
  }

  if (check.requireStrictMultiTerm && !entry.strictMultiTerm) {
    errors.push(`[critical-query:${check.id}] ${check.query} must use strict multi-term matching for returned documents`);
  }

  if (check.onlyDocumentDisplaySourceIds?.length) {
    const allowed = new Set(check.onlyDocumentDisplaySourceIds);
    const unexpected = entry.documentDisplaySourceIds.filter((sourceId) => !allowed.has(sourceId));
    if (unexpected.length) {
      errors.push(`[critical-query:${check.id}] ${check.query} returned documents outside allowed sources ${check.onlyDocumentDisplaySourceIds.join(", ")}: ${unexpected.join(", ")}`);
    }
  }

  if (check.onlyDocumentMediaTypes?.length) {
    const allowed = new Set(check.onlyDocumentMediaTypes);
    const unexpected = entry.documentMediaTypes.filter((mediaType) => !allowed.has(mediaType));
    if (unexpected.length) {
      errors.push(`[critical-query:${check.id}] ${check.query} returned documents outside allowed media types ${check.onlyDocumentMediaTypes.join(", ")}: ${unexpected.join(", ")}`);
    }
  }

  if (check.forbiddenDocumentMediaTypes?.length) {
    const forbidden = new Set(check.forbiddenDocumentMediaTypes);
    const unexpected = entry.documentMediaTypes.filter((mediaType) => forbidden.has(mediaType));
    if (unexpected.length) {
      errors.push(`[critical-query:${check.id}] ${check.query} returned forbidden media types ${check.forbiddenDocumentMediaTypes.join(", ")}: ${unexpected.join(", ")}`);
    }
  }

  if (check.forbiddenDocumentLanguages?.length) {
    const forbidden = new Set(check.forbiddenDocumentLanguages);
    const unexpected = entry.documentLanguages.filter((language) => forbidden.has(language));
    if (unexpected.length) {
      errors.push(`[critical-query:${check.id}] ${check.query} returned forbidden languages ${check.forbiddenDocumentLanguages.join(", ")}: ${unexpected.join(", ")}`);
    }
  }

  for (const term of check.forbiddenDocumentTerms || []) {
    const matches = entry.forbiddenTermMatches?.[term] || [];
    if (matches.length) {
      errors.push(`[critical-query:${check.id}] ${check.query} returned documents containing excluded term ${term}: ${matches.join(", ")}`);
    }
  }

  for (const term of check.requiredDocumentTerms || []) {
    const misses = entry.requiredTermMisses?.[term] || [];
    if (misses.length) {
      errors.push(`[critical-query:${check.id}] ${check.query} returned documents missing required term ${term}: ${misses.join(", ")}`);
    }
  }

  if ((check.requiredDocumentDateFrom || check.requiredDocumentDateTo) && entry.requiredDateRangeMisses?.length) {
    errors.push(`[critical-query:${check.id}] ${check.query} returned documents outside required date range ${check.requiredDocumentDateFrom || "*"}..${check.requiredDocumentDateTo || "*"}: ${entry.requiredDateRangeMisses.join(", ")}`);
  }
}

function documentDateIsWithinRange(document = {}, dateFrom = "", dateTo = "") {
  if (!dateFrom && !dateTo) return true;
  const date = String(document.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  if (dateFrom && date < dateFrom) return false;
  if (dateTo && date > dateTo) return false;
  return true;
}

function documentContainsTerm(document = {}, term = "") {
  const normalizedTerm = String(term || "").trim();
  const resolvedEntity = resolveKnownEntityQuery(normalizedTerm);
  const needles = resolvedEntity?.certainty >= 100
    ? getResolvedEntitySearchTerms(resolvedEntity)
    : [normalizedTerm];
  const haystack = [
    document.title,
    getSearchableSnippetText(document.snippet),
    getSearchableBodyText(document.body),
    document.searchSnippet,
    document.searchBody,
    document.previewText,
    ...(Array.isArray(document.aliases) ? document.aliases : []),
  ].join("\n");
  const token = createSearchToken(haystack);
  return needles.some((value) => {
    const needle = createSearchToken(value);
    if (!needle.compactLower) return false;
    return token.compactLower.includes(needle.compactLower)
      || token.lower.includes(needle.lower);
  });
}

function getSourceHostname(value = "") {
  try {
    return new URL(value).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  } catch {
    return "";
  }
}

function formatFacetSummary(sourceFacets = []) {
  return sourceFacets.length
    ? sourceFacets.map((facet) => `${facet.sourceId}:${facet.count}`).join(", ")
    : "none";
}

function createSourceWarningDetails(health = {}) {
  if (!Array.isArray(health?.sources)) return [];
  return health.sources
    .filter((source) => source.status && source.status !== "indexed")
    .map((source) => {
      const errors = Array.isArray(source.errors) ? source.errors : [];
      const warnings = Array.isArray(source.warnings) ? source.warnings : [];
      const reasons = [];
      if (source.preservedExistingDocuments) reasons.push("using preserved documents from an earlier successful import");
      if (source.timedOut) reasons.push("current import timed out");
      if (errors.length) reasons.push(`${errors.length} current import error${errors.length === 1 ? "" : "s"}`);
      if (warnings.length) reasons.push(`${warnings.length} non-blocking warning${warnings.length === 1 ? "" : "s"}`);
      if (!Number(source.indexedDocuments || 0)) reasons.push("no indexed documents");
      return {
        sourceId: source.sourceId || "",
        sourceName: source.sourceName || source.sourceId || "unknown source",
        status: source.status || "unknown",
        indexedDocuments: Number(source.indexedDocuments || 0),
        importedThisRun: source.importedThisRun,
        preservedExistingDocuments: Boolean(source.preservedExistingDocuments),
        reason: reasons.join("; ") || source.status || "warning",
        errors,
        warnings,
      };
    });
}

async function auditMeilisearchSeedPayload(documentsPath, sourcesPath, seed, errors, corpusFingerprint = "") {
  if (!seed) return;

  let expectedSeed;
  const cacheKey = [
    corpusFingerprint,
    process.env.MEILI_DOCUMENT_INDEX || "",
    process.env.MEILI_SUGGESTION_INDEX || "",
  ].join("\u0000");
  try {
    let expectedSeedPromise = EXPECTED_SEED_CACHE.get(cacheKey);
    if (!expectedSeedPromise) {
      expectedSeedPromise = buildSearchSeed({ documentsPath, sourcesPath });
      setBoundedAuditCache(EXPECTED_SEED_CACHE, cacheKey, expectedSeedPromise);
    }
    expectedSeed = await expectedSeedPromise;
  } catch (error) {
    EXPECTED_SEED_CACHE.delete(cacheKey);
    errors.push(`Meilisearch seed builder must accept the current production index: ${error.message}`);
    return;
  }
  const comparableSeed = stripGeneratedFields(seed);
  const comparableExpectedSeed = stripGeneratedFields(expectedSeed);
  if (!isDeepStrictEqual(comparableSeed.settings, comparableExpectedSeed.settings)) {
    errors.push("Meilisearch seed settings must match the current seed builder output");
  }
  if (!isDeepStrictEqual(comparableSeed.sources, comparableExpectedSeed.sources)) {
    errors.push("Meilisearch seed sources must match data/search/sources.json content");
  }
  if (!isDeepStrictEqual(comparableSeed.documents, comparableExpectedSeed.documents)) {
    const difference = findFirstSeedDifference(comparableSeed.documents, comparableExpectedSeed.documents);
    errors.push(`Meilisearch seed documents must match data/search/documents.jsonl content and generated fields${difference ? `; first difference: ${difference}` : ""}`);
  }
  if (!isDeepStrictEqual(comparableSeed.suggestions, comparableExpectedSeed.suggestions)) {
    errors.push("Meilisearch seed suggestions must match the current indexed corpus");
  }
}

function createCorpusFingerprint(documents = [], sources = []) {
  return createHash("sha256")
    .update(JSON.stringify(documents))
    .update("\u0000")
    .update(JSON.stringify(sources))
    .digest("hex");
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function findFirstSeedDifference(actual, expected, pathLabel = "documents") {
  if (Object.is(actual, expected)) return "";
  if (typeof actual !== typeof expected || actual === null || expected === null) {
    return `${pathLabel} (${formatDifferenceValue(actual)} != ${formatDifferenceValue(expected)})`;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return `${pathLabel} (array type mismatch)`;
    if (actual.length !== expected.length) return `${pathLabel}.length (${actual.length} != ${expected.length})`;
    for (let index = 0; index < actual.length; index += 1) {
      const difference = findFirstSeedDifference(actual[index], expected[index], `${pathLabel}[${index}]`);
      if (difference) return difference;
    }
    return "";
  }
  if (typeof actual === "object") {
    const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
    for (const key of keys) {
      if (!Object.hasOwn(actual, key) || !Object.hasOwn(expected, key)) return `${pathLabel}.${key} (missing property)`;
      const difference = findFirstSeedDifference(actual[key], expected[key], `${pathLabel}.${key}`);
      if (difference) return difference;
    }
    return "";
  }
  return `${pathLabel} (${formatDifferenceValue(actual)} != ${formatDifferenceValue(expected)})`;
}

function formatDifferenceValue(value) {
  const serialized = JSON.stringify(value);
  return String(serialized === undefined ? value : serialized).slice(0, 160);
}

function setBoundedAuditCache(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > AUDIT_CACHE_ENTRY_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
}

function stripGeneratedFields(seed = {}) {
  const { generatedAt, ...stableSeed } = seed || {};
  return stableSeed;
}

function stableStringify(value) {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortObjectKeys(nestedValue)]),
  );
}

async function auditSearchAssetVersions(runtimeDirs, errors) {
  const files = await listRuntimeFiles(runtimeDirs);
  const versions = new Map();

  for (const filePath of files) {
    const text = await fs.readFile(filePath, "utf8");
    const relativePath = path.relative(ROOT_DIR, filePath);

    auditRuntimeExternalDependencies(text, relativePath, errors);
    if (filePath.endsWith(".css")) auditCssCustomProperties(text, relativePath, errors);

    for (const version of text.match(SEARCH_ASSET_VERSION_PATTERN) || []) {
      if (!versions.has(version)) versions.set(version, []);
      versions.get(version).push(relativePath);
    }

    for (const importPath of getRelativeRuntimeImports(text)) {
      if (!/\?v=search-\d{8}-\d+\b/.test(importPath)) {
        errors.push(`[asset:${relativePath}] relative runtime import must include the search cache key: ${importPath}`);
      }
    }

    for (const assetPath of getRuntimeAssetUrls(text)) {
      if (!/\?v=search-\d{8}-\d+\b/.test(assetPath)) {
        errors.push(`[asset:${relativePath}] runtime asset URL must include the search cache key: ${assetPath}`);
      }
    }
  }

  if (!versions.size) {
    errors.push("search runtime assets must use a cache-busting search-* version key");
  }
  if (versions.size > 1) {
    errors.push(`search runtime asset cache key must be consistent: ${[...versions.keys()].join(", ")}`);
  }
}

function auditCssCustomProperties(css = "", relativePath = "", errors) {
  const definitions = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
  const references = [...new Set([...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]))];
  const missing = references.filter((name) => !definitions.has(name));
  if (missing.length) {
    errors.push(`[asset:${relativePath}] CSS custom properties must be defined before use: ${missing.join(", ")}`);
  }
}

async function auditSearchAssetProxy(assetProxyPath, errors) {
  let source = "";
  try {
    source = await fs.readFile(assetProxyPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      errors.push("api/search-asset.js is required for same-origin search asset fallback proxying");
      return;
    }
    throw error;
  }

  const requiredSignals = [
    ["ALLOWED_ASSET_HOSTS", "restrict upstream hosts to the configured search scope"],
    ["isDirectAssetUrl", "reject non-asset article/page URLs"],
    ["MAX_ASSET_BYTES", "cap proxied asset response size"],
    ["setAssetSecurityHeaders", "centralize response security headers"],
    ["Content-Security-Policy", "sandbox proxied SVG/PDF responses"],
    ["Cross-Origin-Resource-Policy", "prevent cross-origin embedding abuse"],
    ["X-Content-Type-Options", "disable content sniffing"],
    ["method: isHeadRequest ? \"HEAD\" : \"GET\"", "forward HEAD metadata checks without downloading asset bodies"],
    ["getRequestHeader(request, \"range\")", "read browser Range requests for PDF/image previews"],
    ["Content-Range", "preserve partial-content metadata for PDF previews"],
    ["Accept-Ranges", "preserve byte-range support metadata for PDF previews"],
  ];
  for (const [needle, reason] of requiredSignals) {
    if (!source.includes(needle)) errors.push(`[asset-proxy] same-origin asset proxy must include ${needle} to ${reason}`);
  }
  if (/\bvideo\//i.test(source) || /\bmp4\b/i.test(source)) {
    errors.push("[asset-proxy] same-origin asset proxy must not allow video originals");
  }
}

function auditAssetCacheReport(report, errors) {
  if (!report) {
    errors.push("data/search/asset-cache-report.json is required so production asset mirroring status is auditable");
    return;
  }
  if (report.dryRun) {
    errors.push("[asset-cache] latest asset cache report must come from a real mirror pass, not --dry-run");
  }
  const failed = Number(report.failed || 0);
  const failures = Array.isArray(report.failures) ? report.failures : [];
  if (failed > 0 || failures.length > 0) {
    const sample = failures
      .slice(0, 3)
      .map((failure) => `${failure.sourceId || "unknown"}/${failure.field || "asset"}: ${failure.error || failure.url || "failed"}`)
      .join("; ");
    errors.push(`[asset-cache] latest asset cache report must not contain failed mirror attempts${sample ? ` (${sample})` : ""}`);
  }
  const coverage = getAssetCacheAfterCoverage(report);
  if (!coverage) {
    errors.push("[asset-cache] latest asset cache report must include assetCoverage.after so uncached preview gaps are auditable");
    return;
  }
  const selectedMissing = Number(coverage.selectedMissing || 0);
  if (selectedMissing > 0) {
    errors.push(`[asset-cache] selected mirror scope still has ${selectedMissing} uncached asset candidate(s)`);
  }
}

function createAssetCacheCoverageSummary(report = null) {
  const after = getAssetCacheAfterCoverage(report);
  if (!after) return null;
  const bySource = Array.isArray(after.bySource) ? after.bySource : [];
  return {
    after,
    topMissingSources: bySource
      .filter((source) => Number(source?.missing || 0) > 0)
      .sort((left, right) => Number(right.missing || 0) - Number(left.missing || 0)
        || String(left.sourceId || "").localeCompare(String(right.sourceId || ""), "en-US"))
      .slice(0, 5)
      .map((source) => ({
        sourceId: String(source.sourceId || ""),
        missing: Number(source.missing || 0),
        cached: Number(source.cached || 0),
        candidates: Number(source.candidates || 0),
      })),
  };
}

function getAssetCacheAfterCoverage(report = null) {
  const coverage = report?.assetCoverage?.after;
  return coverage && typeof coverage === "object" ? coverage : null;
}

async function auditCachedAssetFiles(documents = [], errors, rootDir = ROOT_DIR) {
  const checks = [];
  for (const document of documents) {
    for (const field of ["cachedUrl", "cachedThumbnailUrl"]) {
      const value = String(document[field] || "").trim();
      if (!value) continue;
      const resolvedPath = resolveLocalSearchAssetPath(value, rootDir);
      if (resolvedPath === null) {
        errors.push(`[asset-cache:${document.id || "unknown"}] ${field} must stay under /data/search/assets: ${value}`);
        continue;
      }
      if (!resolvedPath) continue;
      checks.push({
        documentId: document.id || "unknown",
        field,
        value,
        resolvedPath,
      });
    }
  }

  const missing = await Promise.all(checks.map(async (check) => {
    try {
      await fs.access(check.resolvedPath);
      return null;
    } catch (error) {
      if (error.code === "ENOENT") return check;
      throw error;
    }
  }));

  for (const check of missing.filter(Boolean)) {
    errors.push(`[asset-cache:${check.documentId}] ${check.field} points to missing local asset: ${check.value}`);
  }
}

function resolveLocalSearchAssetPath(value = "", rootDir = ROOT_DIR) {
  const rawPath = String(value || "").trim().split(/[?#]/)[0];
  if (!rawPath.startsWith("/data/search/assets/")) return "";
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    decodedPath = rawPath;
  }
  const assetRoot = path.resolve(rootDir, "data/search/assets");
  const resolvedPath = path.resolve(rootDir, decodedPath.replace(/^\/+/, ""));
  if (resolvedPath !== assetRoot && !resolvedPath.startsWith(`${assetRoot}${path.sep}`)) {
    return null;
  }
  return resolvedPath;
}

function auditRuntimeExternalDependencies(text = "", relativePath = "", errors) {
  const blockedPatterns = [
    /https:\/\/esm\.sh\b/i,
    /https:\/\/cdn\.jsdelivr\.net\b/i,
    /type=["']importmap["']/i,
    /@toss\/es-hangul/i,
  ];
  if (blockedPatterns.some((pattern) => pattern.test(text))) {
    errors.push(`[asset:${relativePath}] search runtime must not depend on external CDN modules or stylesheet imports`);
  }
}

function auditStoredIndexPayload(rawDocuments, rawSources, errors) {
  if (rawDocuments.some((document) => "searchFields" in document)) {
    errors.push("data/search/documents.jsonl must not ship generated searchFields");
  }
  if (rawSources.some((source) => "searchFields" in source)) {
    errors.push("data/search/sources.json must not ship generated searchFields");
  }
  for (const document of rawDocuments) {
    const markerText = [
      document.id,
      document.url,
      document.archiveUrl,
      document.thumbnailUrl,
      document.cachedUrl,
      document.cachedThumbnailUrl,
    ].filter(Boolean).join(" ");
    if (TEST_OR_MOCK_DOCUMENT_PATTERN.test(markerText)) {
      errors.push(`[document:${document.id || "unknown"}] production index must not include fixture/mock/placeholder document markers`);
    }
    const visibleText = [document.title, document.snippet].filter(Boolean).join(" ");
    if (OLD_MOCK_RESULT_TITLES.some((title) => visibleText.includes(title))) {
      errors.push(`[document:${document.id || "unknown"}] production index must not include old mock result titles`);
    }
    const maxAllowedDate = getMaxAllowedDocumentDate();
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(document.date || "")) && !isValidDocumentDate(document.date)) {
      errors.push(`[document:${document.id || "unknown"}] document.date must be a valid calendar date: ${document.date}`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(document.date || "")) && document.date > maxAllowedDate) {
      errors.push(`[document:${document.id || "unknown"}] document.date must not be in the future: ${document.date}`);
    }
    if (FORBIDDEN_MANUAL_WONSAN_BACKFILL_IDS.has(document.id)) {
      errors.push(`[document:${document.id}] production index must not include configured Wonsan Kalma backfill documents`);
    }
  }

  const hasDiscoveredKcnaCeremonyArticle = rawDocuments.some((document) => (
    document.sourceId === "kcna"
    && document.url === KCNA_WONSAN_KALMA_CEREMONY_URL
  ));
  if (!hasDiscoveredKcnaCeremonyArticle) {
    errors.push("[document:kcna-wonsan-kalma-ceremony] production index must include the KCNA Wonsan Kalma ceremony article discovered from source-visible paginated listings");
  }
  const serviceArticle = rawDocuments.find((document) => (
    document.sourceId === "kcna"
    && document.url === KCNA_WONSAN_KALMA_SERVICE_URL
  ));
  if (!serviceArticle) {
    errors.push("[document:kcna-wonsan-kalma-service] production index must include the KCNA Wonsan Kalma service-start article");
  } else if (String(serviceArticle.body || "").length < 500) {
    errors.push("[document:kcna-wonsan-kalma-service] KCNA Wonsan Kalma service-start article must use readable detail body, not listing fallback text");
  }
  const wonsanKalmaGuidePdf = rawDocuments.find((document) => (
    document.sourceId === "korean-books"
    && document.mediaType === "pdf"
    && /원산갈마해안관광지구안내/.test(String(document.title || ""))
  ));
  if (!wonsanKalmaGuidePdf) {
    errors.push("[document:korean-books-wonsan-kalma-guide] production index must include the Wonsan Kalma guide PDF from 조선의 출판물");
  } else if (!/Wonsan Kalma Tour Information Office|명사십리휴양구역/.test(String(wonsanKalmaGuidePdf.body || ""))) {
    errors.push("[document:korean-books-wonsan-kalma-guide] Wonsan Kalma guide PDF must include extracted readable PDF text, not only title/URL metadata");
  }
}

function isValidDocumentDate(value = "") {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Number.isInteger(day) && day >= 1 && day <= daysInMonth;
}

function getMaxAllowedDocumentDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + MAX_FUTURE_DATE_SKEW_DAYS);
  return date.toISOString().slice(0, 10);
}

function auditCanonicalSources(sources, errors) {
  const expectedIds = SEARCH_SOURCES.map((source) => source.id);
  const actualIds = sources.map((source) => source.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    errors.push(`source catalog must exactly match requested sources: ${actualIds.join(", ")}`);
  }

  const configuredBackfillSourceIds = SEARCH_SOURCES
    .filter((source) => Array.isArray(source.crawler?.backfillDocuments) && source.crawler.backfillDocuments.length > 0)
    .map((source) => source.id);
  if (configuredBackfillSourceIds.length) {
    errors.push(`source catalog must not ship configured backfillDocuments; use crawler discovery and source-visible seed URLs instead: ${configuredBackfillSourceIds.join(", ")}`);
  }

  for (const expected of SEARCH_SOURCES) {
    const source = sources.find((candidate) => candidate.id === expected.id);
    if (!source) continue;
    if (source.name !== expected.name) errors.push(`[source:${source.id}] name must be ${expected.name}`);
    if (source.baseUrl !== expected.baseUrl) errors.push(`[source:${source.id}] baseUrl must be ${expected.baseUrl}`);
    if (JSON.stringify(source.mediaTypes) !== JSON.stringify(expected.mediaTypes)) {
      errors.push(`[source:${source.id}] mediaTypes must match sourceConfig`);
    }
  }

  const kcnaSource = SEARCH_SOURCES.find((source) => source.id === "kcna");
  for (const seedUrl of KCNA_WONSAN_KALMA_CATEGORY_SEED_URLS) {
    if (!kcnaSource?.crawler?.seedUrls?.includes(seedUrl)) {
      errors.push(`[source:kcna] seedUrls must include source-visible Wonsan Kalma category listing ${seedUrl}`);
    }
  }
}

function auditIndexedDocumentLanguages(documents, sources, errors) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const languagesBySourceId = new Map();

  for (const document of documents) {
    const language = String(document.language || "").trim();
    if (!language || language === "multi") continue;
    const languages = languagesBySourceId.get(document.sourceId) || new Set();
    languages.add(language);
    languagesBySourceId.set(document.sourceId, languages);
  }

  for (const [sourceId, languages] of languagesBySourceId) {
    const declaredLanguages = new Set((sourceById.get(sourceId)?.languages || []).map(String));
    const missing = [...languages].filter((language) => !declaredLanguages.has(language));
    if (missing.length) {
      errors.push(`[source:${sourceId}] languages must include indexed document language(s): ${missing.join(", ")}`);
    }
  }
}

function auditSourceHealth(documents, sources, health, errors) {
  if (!health || !Array.isArray(health.sources)) {
    errors.push("source-health.json is required for production search deploys");
    return;
  }

  const expectedIds = sources.map((source) => source.id);
  const healthIds = health.sources.map((source) => source.sourceId);
  if (JSON.stringify(healthIds) !== JSON.stringify(expectedIds)) {
    errors.push(`source health must cover sources in catalog order: ${healthIds.join(", ")}`);
  }
  if (health.summary?.totalSources !== sources.length) {
    errors.push(`source health totalSources should be ${sources.length}`);
  }
  if (health.summary?.totalDocuments !== documents.length) {
    errors.push(`source health totalDocuments should be ${documents.length}`);
  }

  const counts = countBy(documents, (document) => document.sourceId);
  const missingSourceIds = sources
    .filter((source) => (counts.get(source.id) || 0) === 0)
    .map((source) => source.id);
  if (missingSourceIds.length) {
    errors.push(`every configured source must have at least one indexed real document: ${missingSourceIds.join(", ")}`);
  }
  const expectedSearchableSources = health.sources.filter((source) => Number(source.indexedDocuments || 0) > 0).length;
  const expectedHealthySources = health.sources.filter((source) => source.status === "indexed").length;
  const expectedWarningSources = health.sources.filter((source) => source.status === "indexed_with_warnings").length;
  const expectedUnreachableSources = health.sources.filter((source) => source.status === "unreachable").length;
  if (health.summary?.searchableSources !== sources.length) {
    errors.push(`source health searchableSources should cover every configured source (${sources.length})`);
  }
  if (health.summary?.searchableSources !== expectedSearchableSources) {
    errors.push(`source health searchableSources should be ${expectedSearchableSources}`);
  }
  if (health.summary?.healthySources !== expectedHealthySources) {
    errors.push(`source health healthySources should be ${expectedHealthySources}`);
  }
  if (health.summary?.warningSources !== expectedWarningSources) {
    errors.push(`source health warningSources should be ${expectedWarningSources}`);
  }
  if (health.summary?.unreachableSources !== expectedUnreachableSources) {
    errors.push(`source health unreachableSources should be ${expectedUnreachableSources}`);
  }

  for (const source of sources) {
    const healthSource = health.sources.find((entry) => entry.sourceId === source.id);
    const actualCount = counts.get(source.id) || 0;
    if (!healthSource) continue;
    if (healthSource.indexedDocuments !== actualCount) {
      errors.push(`[source:${source.id}] health indexedDocuments should be ${actualCount}`);
    }
    const minSourceDocuments = Number(MIN_SOURCE_DOCUMENT_COUNTS[source.id] || 0);
    if (minSourceDocuments && actualCount < minSourceDocuments) {
      errors.push(`[source:${source.id}] production index should include at least ${minSourceDocuments} real document(s), got ${actualCount}`);
    }
    const healthWarnings = Array.isArray(healthSource.warnings) ? healthSource.warnings : [];
    const healthErrors = Array.isArray(healthSource.errors) ? healthSource.errors : [];
    const hasPartialImportWarning = Boolean(healthSource.timedOut) || healthWarnings.some(isPartialIndexedWarning);
    if (actualCount > 0 && (healthErrors.length || hasPartialImportWarning) && healthSource.status !== "indexed_with_warnings") {
      errors.push(`[source:${source.id}] health status must be indexed_with_warnings when a searchable source has current import errors or timeouts`);
    }
    if (!Object.hasOwn(healthSource, "robotsDisallowed")) {
      errors.push(`[source:${source.id}] health must include robotsDisallowed diagnostics`);
    }
    if (!Object.hasOwn(healthSource, "robotsWarning")) {
      errors.push(`[source:${source.id}] health must include robotsWarning diagnostics`);
    }
    if (!Object.hasOwn(healthSource, "warnings")) {
      errors.push(`[source:${source.id}] health must include non-blocking warning diagnostics`);
    }
    if (!Object.hasOwn(healthSource, "sitemapFetched")) {
      errors.push(`[source:${source.id}] health must include sitemap fetch diagnostics`);
    }
    if (!Object.hasOwn(healthSource, "apiFetched")) {
      errors.push(`[source:${source.id}] health must include API/list fetch diagnostics`);
    }
    if (!Object.hasOwn(healthSource, "searchFetched")) {
      errors.push(`[source:${source.id}] health must include source-search fetch diagnostics`);
    }
  }
}

function isPartialIndexedWarning(warning) {
  return /source time budget exceeded|detail fetch limit reached/i.test(String(warning || ""));
}

function auditMeilisearchSeed(documents, sources, seed, errors) {
  if (!seed) {
    errors.push("meilisearch-seed.json is required for backend search deploys");
    return;
  }

  if (seed.documentIndexName !== "dprk_documents") errors.push("Meilisearch document index name must be dprk_documents");
  if (seed.suggestionIndexName !== "dprk_suggestions") errors.push("Meilisearch suggestion index name must be dprk_suggestions");
  if (!Array.isArray(seed.documents) || seed.documents.length !== documents.length) {
    errors.push(`Meilisearch seed document count should be ${documents.length}`);
  } else {
    const expectedDocumentIds = documents.map((document) => document.id);
    const actualDocumentIds = seed.documents.map((document) => document.id);
    if (JSON.stringify(actualDocumentIds) !== JSON.stringify(expectedDocumentIds)) {
      errors.push("Meilisearch seed documents must match data/search/documents.jsonl in order and identity");
    }
  }
  if (!Array.isArray(seed.sources) || seed.sources.length !== sources.length) {
    errors.push(`Meilisearch seed source count should be ${sources.length}`);
  } else {
    const expectedSourceIds = sources.map((source) => source.id);
    const actualSourceIds = seed.sources.map((source) => source.id);
    if (JSON.stringify(actualSourceIds) !== JSON.stringify(expectedSourceIds)) {
      errors.push("Meilisearch seed sources must match data/search/sources.json in order and identity");
    }
  }
  if (!Array.isArray(seed.suggestions) || seed.suggestions.length === 0) {
    errors.push("Meilisearch seed must include suggestion records");
  }
  auditUniqueMeilisearchSettingLists(seed.settings, errors);
  if (!seed.settings?.documents?.displayedAttributes?.includes("body")) {
    errors.push("Meilisearch document settings must display body for cropped formatted snippets");
  }
  if (!seed.settings?.documents?.displayedAttributes?.includes("searchSnippet")) {
    errors.push("Meilisearch document settings must display searchSnippet for dateline-stripped backend retrieval diagnostics");
  }
  if (!seed.settings?.documents?.displayedAttributes?.includes("searchBody")) {
    errors.push("Meilisearch document settings must display searchBody for dateline-stripped backend retrieval diagnostics");
  }
  if (Array.isArray(seed.settings?.documents?.searchableAttributes) && seed.settings.documents.searchableAttributes.includes("body")) {
    errors.push("Meilisearch document index must search searchBody instead of raw body to avoid dateline-only location matches");
  }
  if (!seed.settings?.documents?.displayedAttributes?.includes("previewText")) {
    errors.push("Meilisearch document settings must display previewText for enriched backend snippets");
  }
  if (!seed.settings?.documents?.displayedAttributes?.includes("previewSourceName")) {
    errors.push("Meilisearch document settings must display previewSourceName for enriched backend snippet provenance");
  }
  if (!seed.settings?.documents?.displayedAttributes?.includes("previewDocumentId")) {
    errors.push("Meilisearch document settings must display previewDocumentId for enriched backend snippet provenance");
  }
  if (!seed.settings?.documents?.displayedAttributes?.includes("integratedRank")) {
    errors.push("Meilisearch document settings must display integratedRank for backend ranking diagnostics");
  }
  if (!seed.settings?.documents?.displayedAttributes?.includes("sourceId")) {
    errors.push("Meilisearch document settings must display source ids for source facet diagnostics");
  }
  if (!seed.settings?.documents?.displayedAttributes?.includes("displaySourceName")) {
    errors.push("Meilisearch document settings must display original source names for KCNA Watch archive-origin pills");
  }
  if (!seed.settings?.documents?.displayedAttributes?.includes("originalSourceUrl")) {
    errors.push("Meilisearch document settings must display original source URLs for linked KCNA Watch origin pills");
  }
  if (!seed.settings?.documents?.filterableAttributes?.includes("sourceId")) {
    errors.push("Meilisearch document settings must filter by sourceId for source filters and -site: exclusions");
  }
  if (!seed.settings?.documents?.filterableAttributes?.includes("mediaType")) {
    errors.push("Meilisearch document settings must filter by mediaType for media/filetype tabs");
  }
  if (!seed.settings?.documents?.filterableAttributes?.includes("language")) {
    errors.push("Meilisearch document settings must filter by language for Google-like lang: operators");
  }
  if (!seed.settings?.documents?.filterableAttributes?.includes("visibleTabs")) {
    errors.push("Meilisearch document settings must filter by visibleTabs");
  }
  if (!seed.settings?.documents?.filterableAttributes?.includes("date")) {
    errors.push("Meilisearch document settings must filter by date for Google-like after:/before: operators");
  }
  if (!seed.settings?.documents?.sortableAttributes?.includes("integratedRank")) {
    errors.push("Meilisearch document settings must sort by integratedRank for 전체 result quality");
  }
  if (seed.settings?.documents?.distinctAttribute !== "storyKey") {
    errors.push("Meilisearch document settings must collapse duplicate article/story hits by storyKey");
  }
  if (Object.keys(seed.settings?.documents?.synonyms || {}).length > 0) {
    errors.push("Meilisearch document index must not use broad known-entity synonyms; keep expansion in suggestions");
  }
  if (seed.settings?.documents?.rankingRules?.includes("typo")) {
    errors.push("Meilisearch document index must not use typo ranking; document retrieval should stay strict");
  }
  if (seed.settings?.documents?.typoTolerance?.enabled !== false) {
    errors.push("Meilisearch document typo tolerance must be disabled for strict retrieval");
  }
  if (!Array.isArray(seed.settings?.suggestions?.synonyms?.["김정은"])) {
    errors.push("Meilisearch suggestion index must include known-entity synonyms");
  }
  if (Array.isArray(seed.documents) && seed.documents.some((document) => "searchFields" in document)) {
    errors.push("Meilisearch seed must not upload local-only searchFields");
  }
  if (Array.isArray(seed.sources) && seed.sources.some((source) => "searchFields" in source)) {
    errors.push("Meilisearch seed sources must not upload local-only searchFields");
  }
  if (Array.isArray(seed.documents) && seed.documents.some((document) => typeof document.body !== "string")) {
    errors.push("Meilisearch seed documents must keep body strings for backend snippets");
  }
  if (Array.isArray(seed.documents) && seed.documents.some((document) => typeof document.searchSnippet !== "string" || typeof document.searchBody !== "string")) {
    errors.push("Meilisearch seed documents must include dateline-stripped searchSnippet and searchBody strings");
  }
  if (Array.isArray(seed.documents) && seed.documents.some((document) => typeof document.previewText !== "string")) {
    errors.push("Meilisearch seed documents must keep previewText strings for enriched backend snippets");
  }
  if (Array.isArray(seed.documents) && seed.documents.some((document) => document.previewText && (!document.previewSourceName || !document.previewDocumentId))) {
    errors.push("Meilisearch seed documents with previewText must keep previewSourceName and previewDocumentId provenance");
  }
  auditCriticalPreviewDocuments(seed.documents, errors);
  if (Array.isArray(seed.documents) && seed.documents.some((document) => !document.visibleTabs?.includes("all"))) {
    errors.push("Every Meilisearch document must appear in 전체 results");
  }
  if (Array.isArray(seed.documents) && seed.documents.some((document) => (
    (document.mediaType === "video" || document.mediaType === "broadcast")
    && (!Array.isArray(document.visibleTabs) || !document.visibleTabs.includes("all") || !document.visibleTabs.includes("video"))
  ))) {
    errors.push("Every Meilisearch video document must appear in both 전체 and 동영상 results");
  }
  if (Array.isArray(seed.documents) && seed.documents.some((document) => typeof document.integratedRank !== "number")) {
    errors.push("Meilisearch seed documents must include numeric integratedRank values");
  }
  if (Array.isArray(seed.documents)) {
    for (const document of seed.documents) {
      const expectedVisibleTabs = getExpectedVisibleTabs(document);
      if (JSON.stringify(document.visibleTabs || []) !== JSON.stringify(expectedVisibleTabs)) {
        errors.push(`[document:${document.id}] Meilisearch visibleTabs must be ${expectedVisibleTabs.join(", ")}`);
      }
      const expectedRank = getExpectedIntegratedRank(document);
      if (document.integratedRank !== expectedRank) {
        errors.push(`[document:${document.id}] Meilisearch integratedRank should be ${expectedRank}`);
      }
    }
  }
}

function auditCriticalPreviewDocuments(documents = [], errors) {
  if (!Array.isArray(documents)) return;
  const vokCeremonyDocuments = documents.filter((document) => (
    document.sourceId === "voice-of-korea"
    && VOK_WONSAN_KALMA_CEREMONY_URL_PATTERN.test(String(document.url || ""))
  ));
  if (vokCeremonyDocuments.length < 2) {
    errors.push("Meilisearch seed must include Korean and English Voice of Korea Wonsan Kalma ceremony detail records");
  }
  for (const document of vokCeremonyDocuments) {
    if (String(document.previewText || "").length < 300 || !document.previewSourceName || !document.previewDocumentId) {
      errors.push(`[document:${document.id || "unknown"}] Voice of Korea Wonsan Kalma ceremony records must keep enriched previewText provenance for backend snippets`);
    }
  }

  const kcnaWatchServiceDocuments = documents.filter((document) => (
    document.sourceId === "kcna-watch"
    && document.displaySourceId === "kcna"
    && document.date === "2025-07-02"
    && KCNA_WATCH_WONSAN_KALMA_SERVICE_TITLE_PATTERN.test(String(document.title || ""))
  ));
  if (!kcnaWatchServiceDocuments.length) {
    errors.push("Meilisearch seed must include KCNA Watch preserved KCNA Wonsan Kalma service-start records");
  }
  for (const document of kcnaWatchServiceDocuments) {
    if (String(document.previewText || "").length < 500 || document.previewSourceName !== "조선중앙통신" || !document.previewDocumentId) {
      errors.push(`[document:${document.id || "unknown"}] KCNA Watch preserved service-start records must keep official KCNA enriched previewText provenance`);
    }
  }

  const kcnaWatchCeremonyDocuments = documents.filter((document) => (
    document.sourceId === "kcna-watch"
    && document.date === "2025-06-26"
    && KCNA_WATCH_WONSAN_KALMA_CEREMONY_TITLE_PATTERN.test(String(document.title || ""))
  ));
  if (!kcnaWatchCeremonyDocuments.length) {
    errors.push("Meilisearch seed must include KCNA Watch preserved Wonsan Kalma ceremony records");
  }
  for (const document of kcnaWatchCeremonyDocuments) {
    if (String(document.previewText || "").length < 500 || !document.previewSourceName || !document.previewDocumentId) {
      errors.push(`[document:${document.id || "unknown"}] KCNA Watch preserved ceremony records must keep richer same-story previewText provenance`);
    }
  }
}

function auditUniqueMeilisearchSettingLists(settings = {}, errors) {
  const listKeys = [
    "searchableAttributes",
    "displayedAttributes",
    "filterableAttributes",
    "sortableAttributes",
    "rankingRules",
  ];

  for (const [indexName, indexSettings] of Object.entries(settings || {})) {
    for (const key of listKeys) {
      const values = indexSettings?.[key];
      if (!Array.isArray(values)) continue;
      const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
      if (duplicates.length) {
        errors.push(`Meilisearch ${indexName}.${key} must not contain duplicate values: ${[...new Set(duplicates)].join(", ")}`);
      }
    }
  }
}

function getExpectedVisibleTabs(document = {}) {
  const tabs = ["all"];
  if (Array.isArray(document.searchTabs) && document.searchTabs.length) {
    for (const tab of document.searchTabs.map(String).filter(Boolean)) tabs.push(tab);
    return [...new Set(tabs)];
  }
  if (document.mediaType === "image") tabs.push("image");
  if (document.mediaType === "pdf") tabs.push("pdf");
  if (document.mediaType === "video" || document.mediaType === "broadcast") tabs.push("video");
  return tabs;
}

function getExpectedIntegratedRank(document = {}) {
  if (document.mediaType === "article") return 0;
  if (document.mediaType === "pdf") return 1;
  if (document.mediaType === "broadcast") return 2;
  if (document.mediaType === "image") return 3;
  if (document.mediaType === "video") return 4;
  return 9;
}

function countBy(items, getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

async function listRuntimeFiles(directories) {
  const files = [];
  for (const directory of directories) {
    let candidateStat;
    try {
      candidateStat = await fs.stat(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (candidateStat.isFile()) {
      if (/\.(js|html|css)$/u.test(path.basename(directory))) files.push(directory);
      continue;
    }
    if (!candidateStat.isDirectory()) continue;
    let entries = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...await listRuntimeFiles([entryPath]));
      } else if (/\.(js|html|css)$/.test(entry.name)) {
        files.push(entryPath);
      }
    }
  }
  return files.sort();
}

function getRelativeRuntimeImports(text = "") {
  const imports = [];
  const pattern = /from\s+["']([^"']+\.js(?:\?[^"']*)?)["']/g;
  let match;
  while ((match = pattern.exec(text))) {
    if (match[1].startsWith(".")) imports.push(match[1]);
  }
  return imports;
}

function getRuntimeAssetUrls(text = "") {
  const assets = [];
  const patterns = [
    /\b(?:src|href)=["'](\/(?:search|components)\/[^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g,
    /["'](\/assets\/search-[^"']+\.svg(?:\?[^"']*)?)["']/g,
  ];
  let match;
  for (const pattern of patterns) {
    while ((match = pattern.exec(text))) {
      assets.push(match[1]);
    }
  }
  return assets;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
