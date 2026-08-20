import {
  getRodongLiveDocument,
  normalizeLiveSearchQuery,
  searchRodongDocuments,
} from "../search/rodongLiveSearch.server.js?v=search-20260803-6";
import {
  getChosonSinboLiveDocument,
  searchChosonSinboDocuments,
} from "../search/chosonSinboLiveSearch.server.js?v=search-20260803-6";

const CACHE_CONTROL = "public, max-age=0, s-maxage=300, stale-while-revalidate=3600";
const LIVE_SOURCE_IDS = ["rodong-sinmun", "choson-sinbo"];

export default async function handler(request, response) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" }, { Allow: "GET" });
    return;
  }

  try {
    const id = getQueryValue(request, "id");
    if (id) {
      const document = await getLiveDocument(id);
      if (!document) {
        sendJson(response, 404, { error: "document_not_found" });
        return;
      }
      sendJson(response, 200, { document }, { "Cache-Control": CACHE_CONTROL });
      return;
    }

    const query = normalizeLiveSearchQuery(getQueryValue(request, "q"));
    const tab = getQueryValue(request, "tab") === "image" ? "image" : "all";
    const limit = Math.max(1, Math.min(Number(getQueryValue(request, "limit")) || 20, 24));
    const sourceIds = getRequestedSourceIds(getQueryValue(request, "sources"));
    if (!query) {
      sendJson(response, 400, { error: "invalid_query" });
      return;
    }

    const searches = sourceIds.map((sourceId) => searchLiveSource(sourceId, query, { tab, limit }));
    const settled = await Promise.allSettled(searches);
    const successful = settled.filter((result) => result.status === "fulfilled");
    if (!successful.length && searches.length) throw settled[0]?.reason || new Error("live_search_unavailable");
    const documents = successful
      .flatMap((result) => result.value)
      .sort(compareLiveDocuments)
      .slice(0, limit);
    sendJson(response, 200, {
      query,
      tab,
      sources: sourceIds,
      documents,
      total: documents.length,
    }, { "Cache-Control": CACHE_CONTROL });
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    sendJson(response, timedOut ? 504 : 502, {
      error: timedOut ? "live_search_timeout" : "live_search_unavailable",
    });
  }
}

function getLiveDocument(id = "") {
  if (String(id).startsWith("rodong-live-")) return getRodongLiveDocument(id);
  if (String(id).startsWith("choson-live-")) return getChosonSinboLiveDocument(id);
  return null;
}

function searchLiveSource(sourceId, query, options) {
  if (sourceId === "rodong-sinmun") return searchRodongDocuments(query, options);
  if (sourceId === "choson-sinbo") return searchChosonSinboDocuments(query, options);
  return Promise.resolve([]);
}

function getRequestedSourceIds(value = "") {
  const requested = String(value || "")
    .split(",")
    .map((sourceId) => sourceId.trim())
    .filter(Boolean);
  if (!requested.length) return [...LIVE_SOURCE_IDS];
  return LIVE_SOURCE_IDS.filter((sourceId) => requested.includes(sourceId));
}

function compareLiveDocuments(left, right) {
  return Number(right.score ?? right.baseScore ?? 0) - Number(left.score ?? left.baseScore ?? 0)
    || String(right.date || "").localeCompare(String(left.date || ""));
}

function getQueryValue(request = {}, name = "") {
  const value = request.query?.[name];
  if (Array.isArray(value)) return String(value[0] || "");
  if (typeof value === "string") return value;
  try {
    return new URL(request.url || "", "http://localhost").searchParams.get(name) || "";
  } catch {
    return "";
  }
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(JSON.stringify(payload));
}
