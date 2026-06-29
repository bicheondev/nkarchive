#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";
import { LocalJsonSearchProvider } from "../search/LocalJsonSearchProvider.js";
import { parseJsonl, validateSearchIndex } from "../search/localIndex.js";
import { loadDotEnvFile } from "./script-env.ts";

const CRITICAL_DEPLOYED_QUERIES = [
  {
    id: "wonsan",
    query: "원산",
    minTotal: 100,
    minSourceFacets: 5,
    requiredSourceIds: ["rodong-sinmun", "kcna-watch", "kcna"],
  },
  {
    id: "wonsan-kalma-ceremony",
    query: "원산갈마해안관광지구 준공식",
    minTotal: 5,
    minSourceFacets: 3,
    requiredSourceIds: ["kcna-watch", "kcna", "voice-of-korea"],
  },
  {
    id: "site-kp",
    query: "사이트:kp",
    minTotal: 1000,
    minSourceFacets: 5,
    requiredSourceIds: ["rodong-sinmun", "kcna", "voice-of-korea"],
  },
];

async function main() {
  loadDotEnvFile();
  const baseUrl = getProductionBaseUrl();
  if (!baseUrl) {
    console.error("A production search URL is required. Pass --base-url or set DPRK_SEARCH_PUBLIC_BASE_URL, VERCEL_PROJECT_PRODUCTION_URL, or VERCEL_URL.");
    process.exitCode = 1;
    return;
  }

  const result = await verifyProductionSearch({ baseUrl });
  console.log("Production search verification passed:");
  console.log(`- base URL: ${result.baseUrl}`);
  console.log(`- sources: ${result.sources.length}`);
  console.log(`- documents: ${result.documents.length}`);
  for (const coverage of result.coverage) {
    console.log(`  - ${coverage.query}: ${coverage.total} results across ${coverage.sourceFacets.length} source(s)`);
  }
}

export async function verifyProductionSearch({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) throw new Error("baseUrl is required");

  const [homeHtml, resultsHtml, sourcesText, documentsText] = await Promise.all([
    fetchText(fetchImpl, createUrl(normalizedBaseUrl, "/search/")),
    fetchText(fetchImpl, createUrl(normalizedBaseUrl, "/search/results/?q=%EC%9B%90%EC%82%B0")),
    fetchText(fetchImpl, createUrl(normalizedBaseUrl, "/data/search/sources.json")),
    fetchText(fetchImpl, createUrl(normalizedBaseUrl, "/data/search/documents.jsonl")),
  ]);

  if (!homeHtml.includes("/search/searchPortal.js")) {
    throw new Error("Deployed /search/ route does not load the search portal runtime.");
  }
  if (!resultsHtml.includes("/search/searchPortal.js")) {
    throw new Error("Deployed /search/results/ route does not load the search portal runtime.");
  }

  const rawSources = JSON.parse(sourcesText || "[]");
  const rawDocuments = parseJsonl(documentsText);
  const { documents, sources, errors } = validateSearchIndex(rawDocuments, rawSources);
  if (errors.length) {
    throw new Error(`Deployed search index is invalid:\n${errors.join("\n")}`);
  }

  const provider = new LocalJsonSearchProvider({ documents, sources });
  const coverage = [];
  for (const check of CRITICAL_DEPLOYED_QUERIES) {
    const result = await provider.searchDocuments(check.query, { limit: 10 });
    const sourceIds = new Set(result.sourceFacets.map((facet) => facet.sourceId));
    if (result.total < check.minTotal) {
      throw new Error(`[${check.id}] ${check.query} should return at least ${check.minTotal} result(s), got ${result.total}`);
    }
    if (result.sourceFacets.length < check.minSourceFacets) {
      throw new Error(`[${check.id}] ${check.query} should span at least ${check.minSourceFacets} source(s), got ${result.sourceFacets.length}`);
    }
    for (const sourceId of check.requiredSourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new Error(`[${check.id}] ${check.query} must expose source ${sourceId}`);
      }
    }
    coverage.push({
      query: check.query,
      total: result.total,
      sourceFacets: result.sourceFacets,
    });
  }

  const kcnaWatch = await provider.searchDocuments("원산", { sourceIds: ["kcna-watch"], limit: 10 });
  if (kcnaWatch.total < 1 || kcnaWatch.documents.some((document) => document.sourceId !== "kcna-watch")) {
    throw new Error("KCNA Watch source-filtered verification should return only KCNA Watch preserved records.");
  }
  if (!kcnaWatch.documents.some((document) => document.originalSourceName || document.displaySourceName !== document.sourceName)) {
    throw new Error("KCNA Watch deployed records should preserve original-source pill metadata.");
  }

  return {
    baseUrl: normalizedBaseUrl,
    sources,
    documents,
    coverage,
  };
}

export function normalizeBaseUrl(value = "") {
  const rawValue = String(value || "").trim();
  if (!rawValue) return "";
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//iu.test(rawValue) ? rawValue : `https://${rawValue}`;
  try {
    const url = new URL(withProtocol);
    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/+$/u, "");
  } catch {
    return "";
  }
}

function getProductionBaseUrl() {
  return getArgumentValue("--base-url")
    || process.env.DPRK_SEARCH_PUBLIC_BASE_URL
    || process.env.VERCEL_PROJECT_PRODUCTION_URL
    || process.env.VERCEL_URL
    || "";
}

async function fetchText(fetchImpl, url) {
  if (!fetchImpl) throw new Error("No fetch implementation is available for production verification.");
  const response = await fetchImpl(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to fetch ${url}: ${response.status}`);
  return response.text();
}

function createUrl(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`).href;
}

function getArgumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
