import { searchDocuments } from "./documentSearch.js?v=search-20260629-1";
import { collapseDuplicateResults } from "./resultIdentity.js?v=search-20260629-1";

export const RESULT_TABS = {
  all: {
    id: "all",
    label: "전체",
    mediaTypes: ["article", "image", "video", "pdf", "broadcast"],
  },
  image: {
    id: "image",
    label: "이미지",
    mediaTypes: ["image"],
  },
  video: {
    id: "video",
    label: "동영상",
    mediaTypes: ["video", "broadcast"],
  },
  pdf: {
    id: "pdf",
    label: "문헌",
    mediaTypes: ["pdf"],
  },
};

export function filterDocumentsForTab(documents, query, activeTab = "all") {
  const tab = RESULT_TABS[activeTab] || RESULT_TABS.all;
  return collapseDuplicateResults(
    searchDocuments(documents, query, { mediaTypes: tab.mediaTypes, tab: tab.id })
      .filter((document) => isDocumentVisibleInTab(document, tab.id)),
  );
}

export function groupResultsBySource(results, sourceOrder = [], countResults = results, options = {}) {
  const grouped = new Map();
  const sourceTotals = countResultsBySource(countResults);

  for (const result of results) {
    const key = getResultDisplaySourceId(result);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(result);
  }

  return [...grouped.values()].sort((left, right) => compareSourceGroups(left, right, sourceOrder, options)).map((sourceResults) => ({
    sourceId: getResultDisplaySourceId(sourceResults[0]),
    sourceName: getResultDisplaySourceName(sourceResults[0]),
    sourceType: getResultDisplaySourceType(sourceResults[0]),
    total: sourceTotals.get(getResultDisplaySourceId(sourceResults[0])) || sourceResults.length,
    results: sourceResults,
  }));
}

export function hasSearchQuery(query) {
  return String(query || "").trim().length > 0;
}

function isDocumentVisibleInTab(document, activeTab) {
  if (activeTab === "all") return true;
  if (!Array.isArray(document.searchTabs) || document.searchTabs.length === 0) return true;
  return document.searchTabs.includes(activeTab);
}

function countResultsBySource(results = []) {
  if (results instanceof Map) {
    return new Map([...results.entries()].map(([key, value]) => [String(key), Number(value) || 0]));
  }
  if (!Array.isArray(results) && results && typeof results === "object") {
    return new Map(Object.entries(results).map(([key, value]) => [String(key), Number(value) || 0]));
  }

  const counts = new Map();
  for (const result of results) {
    const key = getResultDisplaySourceId(result);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

export function getResultDisplaySourceId(result = {}) {
  return result?.sourceId || result?.displaySourceId || result?.sourceName || "";
}

export function getResultDisplaySourceName(result = {}) {
  return result?.sourceName || result?.displaySourceName || result?.sourceId || "";
}

export function getResultDisplaySourceType(result = {}) {
  return result?.sourceType || result?.displaySourceType || "";
}

function getGroupRank(sourceResults = []) {
  return Math.max(...sourceResults.map((result) => Number(result.score ?? result.baseScore ?? 0)), 0);
}

function compareSourceGroups(left = [], right = [], sourceOrder = [], options = {}) {
  if (options.sort === "latest") {
    const latestComparison = String(getGroupLatestDate(right)).localeCompare(String(getGroupLatestDate(left)));
    if (latestComparison) return latestComparison;
  }

  return getGroupRank(right) - getGroupRank(left)
    || getSourceOrderIndex(getResultDisplaySourceName(left[0]), sourceOrder) - getSourceOrderIndex(getResultDisplaySourceName(right[0]), sourceOrder)
    || String(getResultDisplaySourceName(left[0])).localeCompare(String(getResultDisplaySourceName(right[0])), "ko-KR");
}

function getGroupLatestDate(sourceResults = []) {
  return sourceResults.reduce((latest, result) => {
    const date = String(result?.date || "");
    return date > latest ? date : latest;
  }, "");
}

function getSourceOrderIndex(sourceName = "", sourceOrder = []) {
  const index = sourceOrder.indexOf(sourceName);
  return index >= 0 ? index : sourceOrder.length;
}
