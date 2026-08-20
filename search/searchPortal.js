import { createSearchBar } from "../components/SearchBar.js?v=search-20260803-6";
import { createSearchTabId, createSearchTabs } from "../components/SearchTabs.js?v=search-20260803-6";
import { createSourceResultCard } from "../components/SourceResultCard.js?v=search-20260803-6";
import { connectSearchSuggestions, createSearchSuggestions, updateSearchSuggestions } from "../components/SearchSuggestions.js?v=search-20260803-6";
import { searchProvider } from "./provider.js?v=search-20260803-6";
import { hasSearchQuery, RESULT_TABS } from "./resultFilters.js?v=search-20260803-6";
import { hasStructuredSearchOperators, parseSearchQueryOperators } from "./queryOperators.js?v=search-20260803-6";
import { SEARCH_LANGUAGES } from "./schemas.js?v=search-20260803-6";
import { SOURCE_BY_ID } from "./sourceConfig.js?v=search-20260803-6";

const DEFAULT_QUERY = "";
const RESULTS_PATH = "/search/results";
const DOCUMENT_PATH = "/search/document";
const RESULTS_PANEL_ID = "search-results-panel";
const DOCUMENT_TITLE_ID = "search-document-title";
const RESULTS_PAGE_SIZE = 10;
const RESULTS_OVERVIEW_LIMIT = 100;
const RESULT_TAB_ITEMS = Object.values(RESULT_TABS).map(({ id, label }) => ({ id, label }));
const SEARCH_SORTS = {
  relevance: {
    id: "relevance",
    label: "관련도순",
  },
  latest: {
    id: "latest",
    label: "최신순",
  },
};
const SEARCH_SORT_ITEMS = Object.values(SEARCH_SORTS);
const LANGUAGE_LABELS = {
  ko: "한국어",
  en: "영어",
  ja: "일본어",
  zh: "중국어",
  ru: "러시아어",
  es: "스페인어",
  fr: "프랑스어",
  ar: "아랍어",
  de: "독일어",
  multi: "다국어",
  unknown: "언어 미상",
};
const MEDIA_TYPE_LABELS = {
  article: "기사",
  image: "이미지",
  video: "동영상",
  pdf: "문헌",
  broadcast: "방송",
};
const CANONICAL_RESULT_PARAMS = new Set(["q", "tab", "source", "exclude_source", "exclude_type", "lang", "exclude_lang", "page", "sort", "after", "before"]);
const CANONICAL_DOCUMENT_PARAMS = new Set(["q", "tab", "source", "exclude_source", "exclude_type", "lang", "exclude_lang", "page", "sort", "after", "before", "id"]);
const YOUTUBE_LOGO_SRC = "/assets/search-youtube-logo.svg?v=search-20260803-6";
const PUBLIC_DIRECT_ASSET_HOSTS = new Set([
  "kcnawatch.org",
  "www.kcnawatch.org",
  "assets.korearisk.com",
  "vod.koryo.tv",
  "i.ytimg.com",
  "i1.ytimg.com",
  "i2.ytimg.com",
  "i3.ytimg.com",
  "i4.ytimg.com",
]);

const root = document.querySelector("[data-search-root]");
let activeRenderToken = 0;
let activeSuggestionToken = 0;

initializeSearchNavigation();
initializeSearchShortcut();

if (root) {
  renderPortalFromLocation();
  window.addEventListener("popstate", renderPortalFromLocation);
}

function initializeSearchNavigation() {
  const menuButton = document.querySelector(".search-menu-button");
  const menu = document.getElementById(menuButton?.getAttribute("aria-controls") || "");
  if (!menuButton || !menu) return;

  const setMenuOpen = (isOpen) => {
    document.body.classList.toggle("search-nav-open", isOpen);
    menuButton.setAttribute("aria-expanded", String(isOpen));
  };

  menuButton.addEventListener("click", () => {
    setMenuOpen(menuButton.getAttribute("aria-expanded") !== "true");
  });

  menu.addEventListener("click", (event) => {
    if (event.target.closest("a")) setMenuOpen(false);
  });

  const closeFromEscape = (event) => {
    if (event.key === "Escape" && menuButton.getAttribute("aria-expanded") === "true") {
      setMenuOpen(false);
      menuButton.focus();
    }
  };

  document.addEventListener("keydown", closeFromEscape);
  window.addEventListener("keydown", closeFromEscape);

  window.matchMedia("(min-width: 1181px)").addEventListener("change", (event) => {
    if (event.matches) setMenuOpen(false);
  });
}

function initializeSearchShortcut() {
  document.addEventListener("keydown", (event) => {
    if (!isSearchShortcut(event) || shouldIgnoreSearchShortcut(event.target)) return;
    const input = document.querySelector(".portal-search-input");
    if (!input) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    input.select();
  });
}

function isSearchShortcut(event) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLocaleLowerCase() === "k";
}

function shouldIgnoreSearchShortcut(target) {
  if (!(target instanceof Element)) return false;
  if (target.classList.contains("portal-search-input")) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function renderPortalFromLocation() {
  const pathname = location.pathname.replace(/\/+$/, "");
  const isResults = pathname === RESULTS_PATH;
  const isDocument = pathname === DOCUMENT_PATH;
  if (isResults && location.pathname.endsWith("/")) {
    history.replaceState(null, "", `${RESULTS_PATH}${location.search}`);
  }
  if (isDocument && location.pathname.endsWith("/")) {
    history.replaceState(null, "", `${DOCUMENT_PATH}${location.search}`);
  }
  document.body.dataset.searchPage = isResults ? "results" : (isDocument ? "document" : "home");
  document.title = isResults
    ? createResultsDocumentTitle(new URLSearchParams(location.search))
    : (isDocument ? "자료 보기 - 북한 공개자료 통합검색" : "북한 공개자료 통합검색");
  if (isDocument) {
    renderDocumentPage();
  } else if (isResults) {
    renderResultsPage();
  } else {
    renderHomePage();
  }
}

function createResultsDocumentTitle(paramsOrQuery = "") {
  const params = paramsOrQuery instanceof URLSearchParams ? paramsOrQuery : null;
  const rawQuery = params ? params.get("q") : paramsOrQuery;
  const parsedQuery = parseSearchQueryOperators(rawQuery);
  const query = getRouteQuery(rawQuery, parsedQuery, params || new URLSearchParams());
  const normalizedQuery = String(query || "").trim();
  const parts = normalizedQuery ? [normalizedQuery] : [];

  if (params) {
    const activeTab = getValidResultTab(parsedQuery.tab) || getValidResultTab(params.get("tab")) || "all";
    const sourceId = getRouteSourceId(params, parsedQuery);
    const excludedSourceIds = getActiveExcludedSourceIds(params, parsedQuery);
    const excludedMediaTypes = getActiveExcludedMediaTypes(params, parsedQuery);
    const activeSort = getValidSearchSort(params.get("sort"));
    const dateRange = getActiveDateRange(params, parsedQuery);
    const activeLanguage = getActiveLanguage(params, parsedQuery);
    const excludedLanguages = getActiveExcludedLanguages(params, parsedQuery);
    const page = normalizePage(params.get("page"));
    const hasIntent = normalizedQuery || hasStructuredSearchOperators(parsedQuery) || hasActiveResultFilters({
      activeTab,
      activeSourceId: sourceId,
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
      language: activeLanguage,
      excludedSourceIds,
      excludedMediaTypes,
      excludedLanguages,
    });
    if (!hasIntent) {
      parts.push("검색 결과", "북한 공개자료 통합검색");
      return parts.join(" - ");
    }
    if (activeTab !== "all") parts.push(`${RESULT_TABS[activeTab].label} 탭`);
    if (sourceId) parts.push(`${SOURCE_BY_ID[sourceId]?.name || sourceId} 자료원`);
    parts.push(...createExcludedSourceLabels(excludedSourceIds));
    parts.push(...createExcludedMediaTypeLabels(excludedMediaTypes));
    parts.push(...createLanguageLabels(activeLanguage));
    parts.push(...createExcludedLanguageLabels(excludedLanguages));
    if (activeSort !== "relevance") parts.push(SEARCH_SORTS[activeSort].label);
    parts.push(...createDateRangeLabels(dateRange));
    if (page > 1) parts.push(`${formatCount(page)}페이지`);
  }

  parts.push("검색 결과", "북한 공개자료 통합검색");
  return parts.join(" - ");
}

function createDocumentDocumentTitle(record) {
  const title = String(record?.title || "").trim();
  return title
    ? `${title} - 자료 보기 - 북한 공개자료 통합검색`
    : "자료 보기 - 북한 공개자료 통합검색";
}

function renderHomePage() {
  activeRenderToken += 1;
  const params = new URLSearchParams(location.search);
  const initialQuery = params.get("q") || DEFAULT_QUERY;
  const submitInContext = createContextualSearchSubmit();
  const hero = document.createElement("section");
  const logo = document.createElement("h1");
  const searchCluster = document.createElement("div");
  const suggestions = createSearchSuggestions({
    suggestions: [],
    onSelect: submitInContext,
  });
  const bar = createSearchBar({
    value: initialQuery,
    variant: "home",
    onInput: (value) => refreshSuggestions(suggestions, value, submitInContext),
    onSubmit: submitInContext,
  });
  connectSearchSuggestions(bar.input, suggestions, { onSelect: submitInContext });

  hero.className = "search-hero";
  logo.className = "search-hero-logo";
  logo.textContent = "★Search";
  searchCluster.className = "search-hero-cluster";

  searchCluster.append(bar.element, suggestions);
  hero.append(logo, searchCluster);
  root.replaceChildren(hero);
  refreshSuggestions(suggestions, initialQuery);
  bar.input.focus({ preventScroll: true });
  bar.input.setSelectionRange(bar.input.value.length, bar.input.value.length);
}

function renderResultsPage() {
  const renderToken = ++activeRenderToken;
  const params = new URLSearchParams(location.search);
  const rawQuery = params.get("q") || "";
  const parsedQuery = parseSearchQueryOperators(rawQuery);
  const query = getRouteQuery(rawQuery, parsedQuery, params);
  const routeTab = getValidResultTab(parsedQuery.tab) || getValidResultTab(params.get("tab")) || "all";
  const routeSourceId = getRouteSourceId(params, parsedQuery);
  const routeSort = getValidSearchSort(params.get("sort"));
  const routeFilters = getActiveFilters(params, parsedQuery);
  const hasResultIntent = hasSearchQuery(query) || hasStructuredSearchOperators(parsedQuery) || hasActiveResultFilters({
    activeTab: routeTab,
    activeSourceId: routeSourceId,
    ...routeFilters,
  });
  const activeTab = hasResultIntent ? routeTab : "all";
  const activeSourceId = hasResultIntent ? routeSourceId : "";
  const activeSort = hasResultIntent ? routeSort : "relevance";
  const activeDateRange = hasResultIntent ? routeFilters : { dateFrom: "", dateTo: "", language: "", excludedSourceIds: [], excludedMediaTypes: [], excludedLanguages: [] };
  const activePage = hasResultIntent ? normalizePage(params.get("page")) : 1;
  const submitInContext = createContextualSearchSubmit(activeTab, activeSourceId, activeSort, activeDateRange);
  canonicalizeResultsUrl(params, { query, activeTab, activeSourceId, activeSort, activePage, ...activeDateRange });
  const header = document.createElement("section");
  const content = document.createElement("section");
  const heading = createResultsHeading(query, activeTab, activeSourceId, activeSort, activePage, activeDateRange);
  const searchWrap = document.createElement("div");
  const bar = createSearchBar({
    value: query,
    variant: "results",
    onInput: (value) => refreshSuggestions(suggestions, value, submitInContext),
    onSubmit: submitInContext,
  });
  const suggestions = createSearchSuggestions({ suggestions: [], onSelect: submitInContext });
  connectSearchSuggestions(bar.input, suggestions, { onSelect: submitInContext });
  const tabs = createSearchTabs({ tabs: RESULT_TAB_ITEMS, activeTab, controlsId: RESULTS_PANEL_ID, onChange: (nextTab) => {
    const nextQuery = bar.input.value.trim();
    const nextHasIntent = hasSearchQuery(nextQuery) || hasActiveResultFilters({
      activeTab: nextTab,
      activeSourceId,
      ...activeDateRange,
    });
    if (!nextHasIntent) return;
    const params = createResultParams(
      nextQuery,
      nextTab,
      activeSourceId,
      1,
      activeSort,
      activeDateRange,
    );
    navigateToResults(params);
  } });

  header.className = "search-results-header";
  searchWrap.className = "search-results-search";
  content.id = RESULTS_PANEL_ID;
  content.className = "search-results-content";
  content.setAttribute("role", "tabpanel");
  content.setAttribute("aria-labelledby", `${heading.id} ${createSearchTabId(activeTab)}`);
  content.setAttribute("aria-busy", "true");
  searchWrap.append(bar.element, suggestions);
  header.append(heading, searchWrap, tabs);
  content.append(createLoadingState());
  root.replaceChildren(header, content);

  renderResultContent(content, query, activeTab, {
    page: activePage,
    sort: activeSort,
    ...activeDateRange,
    limit: activeSourceId ? RESULTS_PAGE_SIZE : RESULTS_OVERVIEW_LIMIT,
    sourceIds: activeSourceId ? [activeSourceId] : [],
  }, renderToken);
}

function createResultsHeading(query, activeTab, activeSourceId = "", activeSort = "relevance", activePage = 1, dateRange = {}) {
  const heading = document.createElement("h1");
  const normalizedQuery = String(query || "").trim();
  const parts = [normalizedQuery ? `${normalizedQuery} 검색 결과` : "검색 결과"];

  if (activeTab !== "all") parts.push(`${RESULT_TABS[activeTab]?.label || activeTab} 탭`);
  if (activeSourceId) parts.push(`${SOURCE_BY_ID[activeSourceId]?.name || activeSourceId} 자료원`);
  parts.push(...createExcludedSourceLabels(dateRange.excludedSourceIds));
  parts.push(...createExcludedMediaTypeLabels(dateRange.excludedMediaTypes));
  parts.push(...createLanguageLabels(dateRange.language));
  parts.push(...createExcludedLanguageLabels(dateRange.excludedLanguages));
  if (activeSort !== "relevance") parts.push(SEARCH_SORTS[activeSort].label);
  parts.push(...createDateRangeLabels(dateRange));
  if (activePage > 1) parts.push(`${formatCount(activePage)}페이지`);

  heading.id = "search-results-heading";
  heading.className = "search-results-heading";
  heading.textContent = parts.join(", ");
  return heading;
}

function renderDocumentPage() {
  const renderToken = ++activeRenderToken;
  const params = new URLSearchParams(location.search);
  const rawQuery = params.get("q") || "";
  const parsedQuery = parseSearchQueryOperators(rawQuery);
  const query = getRouteQuery(rawQuery, parsedQuery, params);
  const id = String(params.get("id") || "").trim();
  const routeTab = getValidResultTab(parsedQuery.tab) || getValidResultTab(params.get("tab")) || "all";
  const routeSourceId = getRouteSourceId(params, parsedQuery);
  const routeSort = getValidSearchSort(params.get("sort"));
  const routeFilters = getActiveFilters(params, parsedQuery);
  const hasResultIntent = hasSearchQuery(query) || hasStructuredSearchOperators(parsedQuery) || hasActiveResultFilters({
    activeTab: routeTab,
    activeSourceId: routeSourceId,
    ...routeFilters,
  });
  const activeTab = hasResultIntent ? routeTab : "all";
  const activeSourceId = hasResultIntent ? routeSourceId : "";
  const activeSort = hasResultIntent ? routeSort : "relevance";
  const activeDateRange = hasResultIntent ? routeFilters : { dateFrom: "", dateTo: "", language: "", excludedSourceIds: [], excludedMediaTypes: [], excludedLanguages: [] };
  const activePage = hasResultIntent ? normalizePage(params.get("page")) : 1;
  const submitInContext = createContextualSearchSubmit(activeTab, activeSourceId, activeSort, activeDateRange);
  const header = document.createElement("section");
  const content = document.createElement("section");
  const searchWrap = document.createElement("div");
  const bar = createSearchBar({
    value: query,
    variant: "results",
    onInput: (value) => refreshSuggestions(suggestions, value, submitInContext),
    onSubmit: submitInContext,
  });
  const suggestions = createSearchSuggestions({ suggestions: [], onSelect: submitInContext });
  connectSearchSuggestions(bar.input, suggestions, { onSelect: submitInContext });
  canonicalizeDocumentUrl(params, { query, activeTab, activeSourceId, activeSort, activePage, ...activeDateRange, id });

  header.className = "search-results-header search-document-header-bar";
  searchWrap.className = "search-results-search";
  content.className = "search-results-content search-document-content";
  content.setAttribute("role", "region");
  content.setAttribute("aria-label", "자료 보기");
  content.setAttribute("aria-busy", "true");
  searchWrap.append(bar.element, suggestions);
  header.append(searchWrap);
  content.append(createLoadingState());
  root.replaceChildren(header, content);

  renderDocumentContent(content, id, params, renderToken);
}

function canonicalizeResultsUrl(params, { query, activeTab, activeSourceId, activeSort, activePage, dateFrom = "", dateTo = "", language = "", excludedSourceIds = [], excludedMediaTypes = [], excludedLanguages = [] }) {
  const canonicalParams = new URLSearchParams(params);
  const currentTab = params.get("tab");
  const currentPage = params.get("page");
  const currentSort = params.get("sort");
  const currentDateFrom = params.get("after");
  const currentDateTo = params.get("before");
  const currentLanguage = params.get("lang");
  const normalizedQuery = String(query || "").trim();
  const normalizedDateFrom = getValidSearchDate(dateFrom);
  const normalizedDateTo = getValidSearchDate(dateTo);
  const normalizedLanguage = getValidSearchLanguage(language);
  const normalizedExcludedSourceIds = normalizeSourceIds(excludedSourceIds)
    .filter((sourceId) => sourceId !== activeSourceId);
  const normalizedExcludedMediaTypes = normalizeMediaTypes(excludedMediaTypes);
  const normalizedExcludedLanguages = normalizeLanguages(excludedLanguages)
    .filter((excludedLanguage) => excludedLanguage !== normalizedLanguage);
  const hasFilterState = hasActiveResultFilters({
    activeTab,
    activeSourceId,
    dateFrom: normalizedDateFrom,
    dateTo: normalizedDateTo,
    language: normalizedLanguage,
    excludedSourceIds: normalizedExcludedSourceIds,
    excludedMediaTypes: normalizedExcludedMediaTypes,
    excludedLanguages: normalizedExcludedLanguages,
  });

  for (const key of [...canonicalParams.keys()]) {
    if (!CANONICAL_RESULT_PARAMS.has(key)) canonicalParams.delete(key);
  }
  if (normalizedQuery) {
    canonicalParams.set("q", normalizedQuery);
  } else {
    canonicalParams.delete("q");
  }
  if (!normalizedQuery && !hasFilterState) {
    canonicalParams.delete("tab");
    canonicalParams.delete("source");
    canonicalParams.delete("exclude_source");
    canonicalParams.delete("exclude_type");
    canonicalParams.delete("exclude_lang");
    canonicalParams.delete("page");
    canonicalParams.delete("sort");
    canonicalParams.delete("after");
    canonicalParams.delete("before");
    canonicalParams.delete("lang");
  } else {
    if (activeTab === "all") {
      if (currentTab) canonicalParams.delete("tab");
    } else if (currentTab !== activeTab) {
      canonicalParams.set("tab", activeTab);
    }
    if (activeSourceId) {
      canonicalParams.set("source", activeSourceId);
    } else if (params.get("source")) {
      canonicalParams.delete("source");
    }
    setCanonicalExcludedSourceIds(canonicalParams, normalizedExcludedSourceIds);
    setCanonicalExcludedMediaTypes(canonicalParams, normalizedExcludedMediaTypes);
    setCanonicalExcludedLanguages(canonicalParams, normalizedExcludedLanguages);
    if (activeSort === "relevance") {
      if (currentSort) canonicalParams.delete("sort");
    } else if (currentSort !== activeSort) {
      canonicalParams.set("sort", activeSort);
    }
    if (normalizedDateFrom) {
      if (currentDateFrom !== normalizedDateFrom) canonicalParams.set("after", normalizedDateFrom);
    } else if (currentDateFrom) {
      canonicalParams.delete("after");
    }
    if (normalizedDateTo) {
      if (currentDateTo !== normalizedDateTo) canonicalParams.set("before", normalizedDateTo);
    } else if (currentDateTo) {
      canonicalParams.delete("before");
    }
    if (normalizedLanguage) {
      if (currentLanguage !== normalizedLanguage) canonicalParams.set("lang", normalizedLanguage);
    } else if (currentLanguage) {
      canonicalParams.delete("lang");
    }
    if (activePage <= 1) {
      canonicalParams.delete("page");
    } else if (currentPage !== String(activePage)) {
      canonicalParams.set("page", String(activePage));
    }
  }

  const queryString = canonicalParams.toString();
  const canonicalUrl = `${RESULTS_PATH}${queryString ? `?${queryString}` : ""}`;
  if (`${location.pathname}${location.search}` !== canonicalUrl) {
    history.replaceState(null, "", canonicalUrl);
  }
}

function canonicalizeDocumentUrl(params, { query, activeTab, activeSourceId, activeSort, activePage, dateFrom = "", dateTo = "", language = "", excludedSourceIds = [], excludedMediaTypes = [], excludedLanguages = [], id }) {
  const canonicalParams = new URLSearchParams(params);
  const currentTab = params.get("tab");
  const currentPage = params.get("page");
  const currentSort = params.get("sort");
  const currentDateFrom = params.get("after");
  const currentDateTo = params.get("before");
  const currentLanguage = params.get("lang");
  const normalizedQuery = String(query || "").trim();
  const normalizedDateFrom = getValidSearchDate(dateFrom);
  const normalizedDateTo = getValidSearchDate(dateTo);
  const normalizedLanguage = getValidSearchLanguage(language);
  const normalizedExcludedSourceIds = normalizeSourceIds(excludedSourceIds)
    .filter((sourceId) => sourceId !== activeSourceId);
  const normalizedExcludedMediaTypes = normalizeMediaTypes(excludedMediaTypes);
  const normalizedExcludedLanguages = normalizeLanguages(excludedLanguages)
    .filter((excludedLanguage) => excludedLanguage !== normalizedLanguage);
  const documentId = String(id || "").trim();
  const hasFilterState = hasActiveResultFilters({
    activeTab,
    activeSourceId,
    dateFrom: normalizedDateFrom,
    dateTo: normalizedDateTo,
    language: normalizedLanguage,
    excludedSourceIds: normalizedExcludedSourceIds,
    excludedMediaTypes: normalizedExcludedMediaTypes,
    excludedLanguages: normalizedExcludedLanguages,
  });

  for (const key of [...canonicalParams.keys()]) {
    if (!CANONICAL_DOCUMENT_PARAMS.has(key)) canonicalParams.delete(key);
  }

  if (normalizedQuery) {
    canonicalParams.set("q", normalizedQuery);
  } else {
    canonicalParams.delete("q");
  }

  if (documentId) {
    canonicalParams.set("id", documentId);
  } else {
    canonicalParams.delete("id");
  }

  if (!normalizedQuery && !hasFilterState) {
    canonicalParams.delete("tab");
    canonicalParams.delete("source");
    canonicalParams.delete("exclude_source");
    canonicalParams.delete("exclude_type");
    canonicalParams.delete("exclude_lang");
    canonicalParams.delete("page");
    canonicalParams.delete("sort");
    canonicalParams.delete("after");
    canonicalParams.delete("before");
    canonicalParams.delete("lang");
  } else {
    if (activeTab === "all") {
      if (currentTab) canonicalParams.delete("tab");
    } else if (currentTab !== activeTab) {
      canonicalParams.set("tab", activeTab);
    }
    if (activeSourceId) {
      canonicalParams.set("source", activeSourceId);
    } else if (params.get("source")) {
      canonicalParams.delete("source");
    }
    setCanonicalExcludedSourceIds(canonicalParams, normalizedExcludedSourceIds);
    setCanonicalExcludedMediaTypes(canonicalParams, normalizedExcludedMediaTypes);
    setCanonicalExcludedLanguages(canonicalParams, normalizedExcludedLanguages);
    if (activeSort === "relevance") {
      if (currentSort) canonicalParams.delete("sort");
    } else if (currentSort !== activeSort) {
      canonicalParams.set("sort", activeSort);
    }
    if (normalizedDateFrom) {
      if (currentDateFrom !== normalizedDateFrom) canonicalParams.set("after", normalizedDateFrom);
    } else if (currentDateFrom) {
      canonicalParams.delete("after");
    }
    if (normalizedDateTo) {
      if (currentDateTo !== normalizedDateTo) canonicalParams.set("before", normalizedDateTo);
    } else if (currentDateTo) {
      canonicalParams.delete("before");
    }
    if (normalizedLanguage) {
      if (currentLanguage !== normalizedLanguage) canonicalParams.set("lang", normalizedLanguage);
    } else if (currentLanguage) {
      canonicalParams.delete("lang");
    }
    if (activePage <= 1) {
      canonicalParams.delete("page");
    } else if (currentPage !== String(activePage)) {
      canonicalParams.set("page", String(activePage));
    }
  }

  const queryString = canonicalParams.toString();
  const canonicalUrl = `${DOCUMENT_PATH}${queryString ? `?${queryString}` : ""}`;
  if (`${location.pathname}${location.search}` !== canonicalUrl) {
    history.replaceState(null, "", canonicalUrl);
  }
}

async function renderResultContent(content, query, activeTab, filters, renderToken) {
  const [nodes] = await Promise.all([
    createResultContent(query, activeTab, filters),
    new Promise((resolve) => window.setTimeout(resolve, 80)),
  ]);
  if (renderToken !== activeRenderToken) return;
  content.setAttribute("aria-busy", "false");
  content.replaceChildren(...nodes);
}

async function renderDocumentContent(content, id, params, renderToken) {
  let record = null;
  let previewRecord = null;
  let loadError = null;
  try {
    record = id ? await searchProvider.getDocumentById(id) : null;
    previewRecord = record
      ? createEmbeddedPreviewRecord(record) || await findRicherIndexedPreview(record)
      : null;
  } catch (error) {
    loadError = error;
  }
  await new Promise((resolve) => window.setTimeout(resolve, 80));
  if (renderToken !== activeRenderToken) return;
  content.setAttribute("aria-busy", "false");

  if (loadError) {
    content.replaceChildren(createEmptyState("자료를 불러오지 못했습니다.", "잠시 후 다시 시도하거나 검색 결과에서 다시 열어보세요."));
    return;
  }
  if (!record) {
    content.replaceChildren(createEmptyState("자료를 찾을 수 없습니다.", "색인에서 해당 자료를 찾지 못했습니다."));
    return;
  }

  document.title = createDocumentDocumentTitle(record);
  content.removeAttribute("aria-label");
  content.setAttribute("aria-labelledby", DOCUMENT_TITLE_ID);
  content.replaceChildren(createDocumentView(record, params, previewRecord || record));
}

async function createResultContent(query, activeTab, filters = {}) {
  const hasResultIntent = hasSearchQuery(query) || hasActiveResultFilters({
    activeTab,
    activeSourceId: filters.sourceIds?.[0] || "",
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    language: filters.language || filters.languages?.[0],
    excludedSourceIds: filters.excludedSourceIds,
    excludedMediaTypes: filters.excludedMediaTypes,
    excludedLanguages: filters.excludedLanguages,
  });
  if (!hasResultIntent) {
    return [createEmptyState("검색어를 입력하세요.", "검색어를 입력하면 북한 공개자료 통합검색 결과가 이곳에 표시됩니다.")];
  }

  let searchResult;
  try {
    searchResult = await searchProvider.searchDocuments(query, {
      tab: activeTab,
      excludedMediaTypes: filters.excludedMediaTypes || [],
      sourceIds: filters.sourceIds || [],
      excludedSourceIds: filters.excludedSourceIds || [],
      sort: filters.sort,
      languages: filters.languages || (filters.language ? [filters.language] : []),
      excludedLanguages: filters.excludedLanguages || [],
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      limit: filters.limit || RESULTS_PAGE_SIZE,
      offset: getPageOffset(filters.page || 1, filters.limit || RESULTS_PAGE_SIZE),
    });
  } catch {
    return [createEmptyState("검색을 불러오지 못했습니다.", "잠시 후 다시 시도하거나 다른 검색어로 검색해보세요.")];
  }

  if (shouldRedirectOutOfRangePage(searchResult, filters)) {
    const page = getLastResultPage(searchResult.total, filters.limit || RESULTS_PAGE_SIZE);
    replaceResults(createResultParams(query, activeTab, filters.sourceIds?.[0] || "", page, filters.sort, filters));
    return [createLoadingState()];
  }

  const groupedCards = searchResult.groupedSources || [];
  const sourceFilter = searchResult.sourceFilters?.[0] || (filters.sourceIds?.[0]
    ? { sourceId: filters.sourceIds[0], sourceName: filters.sourceIds[0] }
    : null);
  const queryHasSourceOperator = hasPositiveSourceOperator(parseSearchQueryOperators(query));
  const visibleSourceFilter = queryHasSourceOperator && !filters.sourceIds?.length ? null : sourceFilter;
  const isSourceScopedResult = Boolean(sourceFilter);
  const filterState = visibleSourceFilter
    ? createSourceFilterState(query, activeTab, visibleSourceFilter, filters)
    : null;
  const dateFilterState = createDateFilterState(query, activeTab, filters);
  const languageFilterState = createLanguageFilterState(query, activeTab, filters);
  const excludedLanguageFilterState = createExcludedLanguageFilterState(query, activeTab, filters);
  const excludedSourceFilterState = createExcludedSourceFilterState(query, activeTab, filters);
  const excludedMediaFilterState = createExcludedMediaFilterState(query, activeTab, filters);
  const appliedFilterStates = createAppliedFilterStates([filterState, excludedSourceFilterState, excludedMediaFilterState, languageFilterState, excludedLanguageFilterState, dateFilterState]);
  const activeFacetSourceId = getActiveFacetSourceId(visibleSourceFilter, groupedCards);
  const sourceFacets = createSourceFacetFilters(
    query,
    activeTab,
    searchResult.sourceFacets || [],
    activeFacetSourceId,
    filters,
  );
  if (searchResult.status === "empty_index") {
    return [createEmptyState("아직 색인된 문서가 없습니다.", "문서를 수집하고 색인하면 검색 결과가 이곳에 표시됩니다.")];
  }
  if (!groupedCards.length) {
    const recoverySuggestions = await getNoResultSuggestions(query);
    return [
      ...(appliedFilterStates ? [appliedFilterStates] : []),
      ...(sourceFacets ? [sourceFacets] : []),
      createNoResultsState("검색 결과가 없습니다.", "다른 검색어나 더 넓은 탭으로 다시 검색해보세요.", recoverySuggestions, activeTab, query, filters),
    ];
  }

  const resultSummary = createResultSummary(searchResult, activeTab, visibleSourceFilter);
  const sortControls = createSortControls(query, activeTab, filters);
  if (activeTab === "image") {
    return [
      ...(appliedFilterStates ? [appliedFilterStates] : []),
      resultSummary,
      sortControls,
      ...(sourceFacets ? [sourceFacets] : []),
      createImageResultsGrid(searchResult.documents || [], query, activeTab, filters),
      ...createPaginationNodes(searchResult, query, activeTab, filters),
    ];
  }

  return [
    ...(appliedFilterStates ? [appliedFilterStates] : []),
    resultSummary,
    sortControls,
    ...(sourceFacets ? [sourceFacets] : []),
    ...groupedCards.map((group) => createSourceResultCard(group, {
      query,
      moreHref: createSourceFilterHref(query, activeTab, group.sourceId, filters),
      getDocumentHref: (result) => createDocumentHref(result, query, activeTab, filters),
      resultLimit: isSourceScopedResult ? group.results.length : getSourcePreviewLimit(groupedCards, group),
      showMore: !isSourceScopedResult,
      onMore: ({ sourceId }) => {
        if (!sourceId) return;
        const params = createSourceDrilldownParams(query, activeTab, sourceId, 1, filters.sort, filters);
        navigateToResults(params);
      },
    })),
    ...createPaginationNodes(searchResult, query, activeTab, filters),
  ];
}

function getSourcePreviewLimit(groupedCards = [], group = {}) {
  const groupCount = groupedCards.length;
  const total = Number(group.total || group.results?.length || 0);
  if (groupCount <= 1) return Math.min(12, Math.max(8, total));
  if (groupCount <= 3) return Math.min(8, Math.max(5, total));
  return 5;
}

function getActiveFacetSourceId(sourceFilter = null, groupedCards = []) {
  if (!sourceFilter?.sourceId) return "";
  const visibleSourceIds = new Set(groupedCards.map((group) => group.sourceId).filter(Boolean));
  if (!visibleSourceIds.size) return sourceFilter.sourceId;
  if (visibleSourceIds.size !== 1) return "";
  return visibleSourceIds.has(sourceFilter.sourceId) ? sourceFilter.sourceId : "";
}

function createImageResultsGrid(results = [], query, activeTab, filters = {}) {
  const grid = document.createElement("section");
  grid.className = "search-image-grid";
  grid.setAttribute("aria-label", "이미지 검색 결과");

  for (const result of results) {
    grid.append(createImageResultCard(result, query, activeTab, filters));
  }

  return grid;
}

function createImageResultCard(result, query, activeTab, filters = {}) {
  const card = document.createElement("article");
  const link = document.createElement("a");
  const imageWrap = document.createElement("div");
  const image = document.createElement("img");
  const title = document.createElement("h2");
  const meta = document.createElement("p");
  const originalHref = result.url || result.archiveUrl || "";
  const imageSrc = getImageDisplaySrc(result);
  const fallbackImageSrc = getFallbackAssetSrc(result, imageSrc);

  card.className = "search-image-card";
  link.className = "search-image-card-link";
  link.href = createDocumentHref(result, query, activeTab, filters);
  imageWrap.className = "search-image-card-media";
  if (imageSrc) {
    image.alt = result.title || "";
    image.loading = "lazy";
    image.decoding = "async";
    configureEmbeddedMedia(image);
    image.src = imageSrc;
    attachMediaFallback(image, imageWrap, "이미지 미러링 필요", fallbackImageSrc);
    imageWrap.append(image);
  } else {
    imageWrap.classList.add("search-media-missing");
    imageWrap.dataset.fallback = "이미지 미러링 필요";
  }
  title.textContent = result.title || "이미지";
  meta.textContent = [getDisplaySourceName(result), formatDate(result.date)].filter(Boolean).join(" · ");
  link.append(imageWrap, title, meta);
  card.append(link);

  if (originalHref) {
    const original = document.createElement("a");
    original.className = "search-image-card-original";
    original.textContent = "원문";
    original.setAttribute("aria-label", createImageOriginalAccessibleLabel(result));
    configureExternalDocumentLink(original, originalHref);
    card.append(original);
  }

  return card;
}

function createImageOriginalAccessibleLabel(result = {}) {
  const title = String(result.title || "").trim();
  return title ? `원문: ${title}` : "원문";
}

async function findRicherIndexedPreview(record = {}) {
  if (!isWeakArticlePreview(record)) return record;
  const candidates = await findIndexedPreviewCandidates(record);
  const richerRecord = candidates
    .filter((candidate) => candidate.id !== record.id)
    .filter((candidate) => candidate.mediaType === record.mediaType)
    .filter((candidate) => isSameStoryCandidate(record, candidate))
    .filter((candidate) => !isWeakArticlePreview(candidate))
    .sort((left, right) => getIndexedPreviewSelectionScore(record, right) - getIndexedPreviewSelectionScore(record, left))[0];
  return richerRecord || record;
}

function createEmbeddedPreviewRecord(record = {}) {
  const previewText = cleanPreviewBlockText(record.previewText || "");
  if (!previewText || !isWeakArticlePreview(record)) return null;
  return {
    ...record,
    id: record.previewDocumentId || `${record.id || "document"}:preview`,
    sourceName: record.previewSourceName || record.sourceName || "",
    body: previewText,
    snippet: previewText,
  };
}

async function findIndexedPreviewCandidates(record = {}) {
  const queries = [
    record.title,
    record.snippet,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const candidates = [];
  const seen = new Set();

  for (const query of queries) {
    try {
      const result = await searchProvider.searchDocuments(query, {
        tab: "all",
        limit: 16,
        offset: 0,
      });
      for (const candidate of result.documents || []) {
        if (!candidate?.id || seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        candidates.push(candidate);
      }
    } catch {
      return candidates;
    }
  }

  return candidates;
}

function isSameStoryCandidate(record = {}, candidate = {}) {
  if (record.date && candidate.date && record.date !== candidate.date) return false;
  const recordTitle = normalizeStoryTitle(record.title);
  const candidateTitle = normalizeStoryTitle(candidate.title);
  if (!recordTitle || !candidateTitle) return false;
  return recordTitle === candidateTitle
    || recordTitle.includes(candidateTitle)
    || candidateTitle.includes(recordTitle)
    || hasStrongStoryTokenOverlap(record.title, candidate.title);
}

function normalizeStoryTitle(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/김정은(?:총비서|위원장|국무위원장|최고령도자|원수님)?/g, "김정은")
    .replace(/총비서|위원장|국무위원장|최고령도자/g, "")
    .replace(/께서|께서는|동지|동지께서|동지께서는/g, "")
    .replace(/원수님/g, "")
    .replace(/[^\p{L}\p{N}가-힣]+/gu, "")
    .toLocaleLowerCase("ko-KR");
}

const STORY_TOKEN_STOPWORDS = new Set([
  "2025년",
  "2026년",
  "우리",
  "나라",
  "조선",
  "진행",
  "소식",
  "기사",
  "기념사진",
]);

function hasStrongStoryTokenOverlap(recordTitle = "", candidateTitle = "") {
  const recordTokens = createStoryTokenSet(recordTitle);
  const candidateTokens = createStoryTokenSet(candidateTitle);
  const smallerSize = Math.min(recordTokens.size, candidateTokens.size);
  if (smallerSize < 3) return false;

  const overlap = [...recordTokens].filter((token) => candidateTokens.has(token));
  const overlapRatio = overlap.length / smallerSize;
  const hasDistinctiveOverlap = overlap.some((token) => token.length >= 5);
  if (smallerSize === 3) {
    return overlap.length === 3 && hasDistinctiveOverlap;
  }
  if (overlap.length >= 3 && overlapRatio >= 0.75 && hasDistinctiveOverlap) {
    return true;
  }
  return overlap.length >= 4 && overlapRatio >= 0.58 && hasDistinctiveOverlap;
}

function createStoryTokenSet(value = "") {
  return new Set(String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/김정은\s*(?:동지|원수님)/g, "김정은")
    .replace(/총비서\s*동지|경애하는|존경하는|동지께서는|동지께서|동지/g, " ")
    .replace(/(\d+)\s*살\s*(?:미만|이하)/g, "$1살")
    .replace(/조선\s*선수들/g, "선수들")
    .split(/[^\p{L}\p{N}가-힣]+/gu)
    .map((token) => {
      const normalizedToken = token
        .replace(/김정은(?:총비서|위원장|국무위원장|최고령도자|원수님)?(?:께서|께서는)?$/u, "김정은")
        .replace(/(?:께서|께서는|동지께서|동지께서는|동지|총비서|위원장|국무위원장|최고령도자|원수님)$/u, "")
        .trim();
      if (normalizedToken === "김정은") return normalizedToken;
      return normalizedToken
        .replace(/(?:에서|으로|에게|들을|들이|에는|에도|와|과|의|을|를|은|는|이|가)$/u, "")
        .trim();
    })
    .filter((token) => token.length >= 2 && !STORY_TOKEN_STOPWORDS.has(token)));
}

function isWeakArticlePreview(record = {}) {
  if (record.mediaType !== "article" && record.mediaType !== "broadcast") return false;
  const body = cleanPreviewInlineText(record.body || "");
  const snippet = cleanPreviewInlineText(record.snippet || "");
  const title = cleanPreviewInlineText(record.title || "");
  const text = body || snippet;
  if (!text) return true;
  if (isVoiceOfKoreaChromeText(text)) return true;
  if (text.length >= 420) return false;
  if (isLikelyTruncatedArchivePreview(text, title)) return true;
  const withoutTitle = title ? cleanPreviewInlineText(text.replaceAll(title, "")) : text;
  const withoutDate = withoutTitle.replace(/\d{4}[.\-/년]\s*\d{1,2}[.\-/월]\s*\d{1,2}\s*일?/g, "").trim();
  return text.length < 80 || withoutDate.length < 36;
}

function isLikelyTruncatedArchivePreview(normalizedText = "", normalizedTitle = "") {
  if (!normalizedTitle || normalizedText.length >= 300) return false;
  if (!normalizedText.startsWith(normalizedTitle)) return false;
  if (hasSentenceEnding(normalizedText)) return false;
  const withoutTitle = cleanPreviewInlineText(normalizedText.replaceAll(normalizedTitle, ""));
  return withoutTitle.length < 220;
}

function hasSentenceEnding(text = "") {
  return /(?:[.!?。！？]|다|였다|하였다|되였다|밝혔다|있다|없다|한다|했다)\s*$/u.test(String(text || "").trim());
}

function getPreviewTextLength(record = {}) {
  return cleanPreviewInlineText(record.body || record.snippet || "").length;
}

function getIndexedPreviewSelectionScore(record = {}, candidate = {}) {
  const preferredSourceId = String(record.displaySourceId || "").trim();
  const sourceBoost = preferredSourceId && preferredSourceId !== "kcna-watch" && candidate.sourceId === preferredSourceId
    ? 10000
    : 0;
  return getPreviewTextLength(candidate) + sourceBoost;
}

function isVoiceOfKoreaChromeText(text = "") {
  const normalized = cleanPreviewInlineText(text);
  if (!normalized) return false;
  return /vok\s+첫페지로\s+어종선택/i.test(normalized)
    || /어종선택\s+Deutsch\s+Русский/i.test(normalized)
    || /《조선의 소리》조선어방송편집부\s+www\.vok\.rep\.kp\s*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized)
    || /(?:Voice of Korea|English Language Service).*Languages.*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized)
    || /Languages.*English Language Service.*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized);
}

function createDocumentView(record, params, previewRecord = record) {
  const article = document.createElement("article");
  const back = document.createElement("a");
  const header = document.createElement("header");
  const brand = createDocumentSourceBrand(record);
  const kicker = document.createElement("p");
  const title = document.createElement("h1");
  const metadata = createDocumentMetadata(record);
  const actions = createDocumentActions(record);
  const media = createDocumentMedia(record);
  const notice = createDocumentPreviewNotice(record, previewRecord);
  const body = createDocumentBody(record, previewRecord);

  article.className = "search-document-view";
  back.className = "search-document-back";
  back.href = createDocumentBackHref(params);
  back.textContent = hasResultRouteParams(params) ? "검색 결과로 돌아가기" : "검색 홈으로 이동";
  back.setAttribute("aria-label", createDocumentBackAccessibleLabel(params));
  back.addEventListener("click", (event) => {
    event.preventDefault();
    history.pushState(null, "", back.getAttribute("href"));
    renderPortalFromLocation();
  });

  header.className = "search-document-header";
  if (brand) header.append(brand);
  kicker.className = "search-document-kicker";
  kicker.textContent = "색인된 미리보기";
  title.id = DOCUMENT_TITLE_ID;
  title.className = "search-document-title";
  title.textContent = record.title || "제목 없음";
  header.append(kicker, title);
  if (metadata) header.append(metadata);
  if (actions) header.append(actions);

  article.append(back, header);
  if (notice) article.append(notice);
  if (media) article.append(media);
  article.append(body);
  return article;
}

function createDocumentSourceBrand(record = {}) {
  if (!isYouTubeDocument(record)) return null;

  const brand = document.createElement("div");
  const image = document.createElement("img");
  brand.className = "search-document-source-brand search-document-source-brand-youtube";
  image.alt = "YouTube";
  image.decoding = "async";
  configureEmbeddedMedia(image);
  image.src = YOUTUBE_LOGO_SRC;
  brand.append(image);
  return brand;
}

function isYouTubeDocument(record = {}) {
  const sourceId = String(record.sourceId || "").toLocaleLowerCase("en-US");
  const sourceName = String(record.sourceName || "");
  const url = String(record.url || "");
  return sourceId.startsWith("youtube-")
    || sourceName.startsWith("YouTube")
    || /(?:^|\.)youtube\.com\//i.test(url)
    || /(?:^|\.)youtu\.be\//i.test(url);
}

function createDocumentPreviewNotice(record = {}, previewRecord = record) {
  if (previewRecord?.id && previewRecord.id !== record.id) {
    const notice = document.createElement("p");
    notice.className = "search-document-preview-notice";
    notice.textContent = `이 자료원 본문이 아직 충분히 색인되지 않아 같은 기사로 색인된 ${previewRecord.sourceName} 본문을 함께 표시합니다.`;
    return notice;
  }
  if (isWeakArticlePreview(record)) {
    const notice = document.createElement("p");
    notice.className = "search-document-preview-notice";
    notice.textContent = "아직 이 자료의 본문이 충분히 색인되지 않았습니다. 수집기가 본문을 확보하면 이 영역에 표시됩니다.";
    return notice;
  }
  return null;
}

function createDocumentMetadata(record = {}) {
  const metadata = document.createElement("p");
  const parts = [
    getMediaLabel(record.mediaType),
    getDisplaySourceName(record),
    formatDate(record.date),
    formatDisplayUrl(record.url || record.archiveUrl || ""),
  ].filter(Boolean);
  const originPill = createDocumentOriginPill(record);
  if (!parts.length && !originPill) return null;

  metadata.className = "search-document-metadata";
  if (parts.length) {
    const summary = document.createElement("span");
    summary.className = "search-document-metadata-text";
    summary.textContent = parts.join(" · ");
    metadata.append(summary);
  }
  if (originPill) metadata.append(originPill);
  return metadata;
}

function getDisplaySourceName(record = {}) {
  return record.sourceName || record.displaySourceName || "";
}

function createDocumentOriginPill(record = {}) {
  const originSourceName = getDocumentOriginalSourceName(record);
  if (!originSourceName) return null;
  const sourceOriginalHref = getDocumentOriginalSourceHref(record);
  const origin = sourceOriginalHref ? document.createElement("a") : document.createElement("span");
  origin.className = "search-document-origin-pill";
  origin.textContent = `원출처 ${originSourceName}`;
  if (sourceOriginalHref) {
    origin.setAttribute("aria-label", createDocumentActionAccessibleLabel(record, `원출처 ${originSourceName}`));
    configureExternalDocumentLink(origin, sourceOriginalHref);
  }
  return origin;
}

function createDocumentActions(record = {}) {
  const originalHref = record.url || record.archiveUrl || "";
  const sourceOriginalHref = getDocumentOriginalSourceHref(record);
  const archiveHref = record.archiveUrl && record.archiveUrl !== record.url ? record.archiveUrl : "";
  if (!originalHref && !sourceOriginalHref && !archiveHref) return null;

  const actions = document.createElement("div");
  actions.className = "search-document-actions";
  if (originalHref) {
    const original = document.createElement("a");
    const originalLabel = getDocumentActionLabel(record);
    original.className = "search-document-action search-document-action-primary";
    original.textContent = originalLabel;
    original.setAttribute("aria-label", createDocumentActionAccessibleLabel(record, originalLabel));
    configureExternalDocumentLink(original, originalHref);
    actions.append(original);
  }
  if (sourceOriginalHref) {
    const sourceOriginal = document.createElement("a");
    const sourceOriginalLabel = "원출처 열기";
    sourceOriginal.className = "search-document-action";
    sourceOriginal.textContent = sourceOriginalLabel;
    sourceOriginal.setAttribute("aria-label", createDocumentActionAccessibleLabel(record, sourceOriginalLabel));
    configureExternalDocumentLink(sourceOriginal, sourceOriginalHref);
    actions.append(sourceOriginal);
  }
  if (archiveHref) {
    const archive = document.createElement("a");
    const archiveLabel = "보존 링크 열기";
    archive.className = "search-document-action";
    archive.textContent = archiveLabel;
    archive.setAttribute("aria-label", createDocumentActionAccessibleLabel(record, archiveLabel));
    configureExternalDocumentLink(archive, archiveHref);
    actions.append(archive);
  }
  return actions;
}

function getDocumentOriginalSourceHref(record = {}) {
  const href = String(record.originalSourceUrl || "").trim();
  if (!href || !hasDistinctPhysicalSource(record)) return "";
  const physicalHref = record.url || record.archiveUrl || "";
  return href === physicalHref ? "" : href;
}

function getDocumentActionLabel(record = {}) {
  if (!hasDistinctPhysicalSource(record)) return "원문 사이트로 이동";
  const sourceName = String(record.sourceName || "").trim();
  return sourceName ? `${sourceName} 보존본 열기` : "보존본 열기";
}

function getDocumentOriginalSourceName(record = {}) {
  if (!hasDistinctPhysicalSource(record)) return "";
  const sourceName = String(record.sourceName || "").trim();
  const displaySourceName = String(record.displaySourceName || "").trim();
  if (!displaySourceName || displaySourceName === sourceName) return "";
  return displaySourceName;
}

function createDocumentActionAccessibleLabel(record = {}, label = getDocumentActionLabel(record)) {
  const title = String(record.title || "").trim();
  return title ? `${label}: ${title}` : label;
}

function hasDistinctPhysicalSource(record = {}) {
  const sourceId = String(record.sourceId || "").trim();
  const displaySourceId = String(record.displaySourceId || "").trim();
  const sourceName = String(record.sourceName || "").trim();
  const displaySourceName = String(record.displaySourceName || "").trim();
  return Boolean(sourceId && displaySourceId && sourceId !== displaySourceId)
    || Boolean(sourceName && displaySourceName && sourceName !== displaySourceName);
}

function createDocumentMedia(record = {}) {
  const imageHref = getImageDisplaySrc(record);
  const pdfHref = getPdfDisplaySrc(record);
  if (record.mediaType === "image" && imageHref) return createImagePreview(record, imageHref);
  if (record.mediaType === "video" || record.mediaType === "broadcast") return createVideoPreview(record, imageHref);
  if (record.mediaType === "pdf" && pdfHref) return createPdfPreview(record, pdfHref);
  return null;
}

function createImagePreview(record, src) {
  const figure = document.createElement("figure");
  const image = document.createElement("img");
  figure.className = "search-document-media search-document-media-image";
  image.alt = record.title || "";
  image.loading = "lazy";
  image.decoding = "async";
  configureEmbeddedMedia(image);
  image.src = src;
  attachMediaFallback(image, figure, "이미지 미러링 필요", getFallbackAssetSrc(record, src));
  figure.append(image);
  return figure;
}

function createVideoPreview(record, posterSrc = "") {
  const embedSrc = getKoryoVodEmbedSrc(record);
  if (embedSrc) return createKoryoVodEmbed(record, embedSrc);
  const youtubeEmbedSrc = getYouTubeEmbedSrc(record);
  if (youtubeEmbedSrc) return createYouTubeEmbed(record, youtubeEmbedSrc);

  const figure = document.createElement("figure");
  figure.className = "search-document-media search-document-media-video";

  if (posterSrc || record.cachedThumbnailUrl || record.thumbnailUrl) {
    const image = document.createElement("img");
    const imageSrc = posterSrc || record.cachedThumbnailUrl || record.thumbnailUrl;
    image.alt = record.title || "";
    image.loading = "lazy";
    image.decoding = "async";
    configureEmbeddedMedia(image);
    image.src = imageSrc;
    attachMediaFallback(image, figure, "영상 썸네일 미러링 필요", getFallbackAssetSrc(record, imageSrc));
    figure.append(image);
    return figure;
  }

  return null;
}

function createYouTubeEmbed(record, src) {
  const figure = document.createElement("figure");
  const frame = document.createElement("iframe");
  figure.className = "search-document-media search-document-media-video search-document-media-youtube";
  frame.title = record.title || "YouTube 영상";
  frame.loading = "lazy";
  configureEmbeddedMedia(frame);
  frame.src = src;
  frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  frame.allowFullscreen = true;
  figure.append(frame);
  return figure;
}

function getYouTubeEmbedSrc(record = {}) {
  const videoId = getYouTubeVideoId(record.url || "");
  return videoId ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}` : "";
}

function getYouTubeVideoId(value = "") {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "").toLocaleLowerCase("en-US");
    if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
    if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "m.youtube.com") {
      if (url.pathname.startsWith("/watch")) return url.searchParams.get("v") || "";
      const embedMatch = url.pathname.match(/\/(?:embed|shorts)\/([^/?#]+)/);
      return embedMatch?.[1] || "";
    }
  } catch {
    return "";
  }
  return "";
}

function createKoryoVodEmbed(record, src) {
  const figure = document.createElement("figure");
  const viewport = document.createElement("div");
  const frame = document.createElement("iframe");

  figure.className = "search-document-media search-document-media-video search-document-media-koryo kctv";
  viewport.className = "kctv-vp";
  frame.title = record.title || "고려TV 영상";
  frame.loading = "lazy";
  configureEmbeddedMedia(frame);
  frame.src = src;
  frame.allow = "fullscreen; picture-in-picture";
  frame.allowFullscreen = true;
  viewport.append(frame);
  figure.append(viewport);
  return figure;
}

function getKoryoVodEmbedSrc(record = {}) {
  if (record.sourceId !== "koryo-vod") return "";
  try {
    const url = new URL(record.url || "");
    if (url.hostname !== "vod.koryo.tv" || !url.pathname.startsWith("/view")) return "";
    return url.href;
  } catch {
    return "";
  }
}

function attachMediaFallback(media, container, message, fallbackSrc = "") {
  let didFallback = false;
  let retriedFallback = false;
  let fallbackTimer = 0;
  const showFallback = () => {
    if (didFallback) return;
    didFallback = true;
    container.classList.add("search-media-missing");
    container.dataset.fallback = message;
  };
  const retryFallback = () => {
    if (retriedFallback || !fallbackSrc || media.getAttribute("src") === fallbackSrc) return false;
    retriedFallback = true;
    media.src = fallbackSrc;
    scheduleFallbackTimer();
    return true;
  };
  const handleFailure = () => {
    if (retryFallback()) return;
    showFallback();
  };
  const scheduleFallbackTimer = () => {
    if (!shouldUseMediaFallbackTimer(media)) return;
    if (fallbackTimer) window.clearTimeout(fallbackTimer);
    fallbackTimer = window.setTimeout(() => {
      if (!media.complete || !media.naturalWidth) handleFailure();
    }, 7000);
  };
  scheduleFallbackTimer();
  media.addEventListener("load", () => window.clearTimeout(fallbackTimer), { once: true });
  media.addEventListener("error", () => {
    window.clearTimeout(fallbackTimer);
    handleFailure();
  });
}

function shouldUseMediaFallbackTimer(media) {
  return media.loading !== "lazy";
}

function getFallbackAssetSrc(record = {}, primarySrc = "") {
  const candidates = [
    record.thumbnailUrl,
    getSourceImageUrl(record),
    record.url,
    record.archiveUrl,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "");
    const displayUrl = createSearchAssetDisplayUrl(value);
    if (displayUrl && displayUrl !== primarySrc) return displayUrl;
  }
  return "";
}

function isRemotePreviewAssetUrl(value = "") {
  try {
    const url = new URL(value);
    return /^https?:$/i.test(url.protocol) && isPreviewAssetUrl(url.href);
  } catch {
    return false;
  }
}

function configureEmbeddedMedia(element) {
  element.referrerPolicy = "no-referrer";
}

function getImageDisplaySrc(record = {}) {
  if (record.mediaType === "video" || record.mediaType === "broadcast") {
    return record.cachedThumbnailUrl || createSearchAssetDisplayUrl(record.thumbnailUrl);
  }
  return record.cachedThumbnailUrl
    || record.cachedUrl
    || createSearchAssetDisplayUrl(record.thumbnailUrl)
    || createSearchAssetDisplayUrl(getSourceImageUrl(record));
}

function getSourceImageUrl(record = {}) {
  if (record.mediaType === "image" || record.mediaType === "video" || record.mediaType === "broadcast") {
    return record.thumbnailUrl || (record.mediaType === "image" ? record.url || record.archiveUrl || "" : "");
  }
  return "";
}

function getPdfDisplaySrc(record = {}) {
  return record.cachedUrl
    || createSearchAssetDisplayUrl(record.url)
    || createSearchAssetDisplayUrl(record.archiveUrl);
}

function createSearchAssetDisplayUrl(value = "") {
  if (!isRemotePreviewAssetUrl(value)) return "";
  return isPublicDirectAssetUrl(value) ? value : createSearchAssetProxyUrl(value);
}

function createSearchAssetProxyUrl(value = "") {
  if (!isRemotePreviewAssetUrl(value)) return "";
  const configuredProxy = getConfiguredAssetProxyUrl(value);
  return configuredProxy || `/api/search-asset?url=${encodeURIComponent(value)}`;
}

function getConfiguredAssetProxyUrl(value = "") {
  const config = getSearchRuntimeConfig();
  const proxy = config?.assetProxy || {};
  const template = String(proxy.template || "");
  const baseUrl = String(proxy.baseUrl || "");
  const urlParam = String(proxy.urlParam || "url");
  const encodedValue = encodeURIComponent(value);

  if (template) return template.replaceAll("{url}", encodedValue);
  if (!baseUrl) return "";

  try {
    const url = new URL(baseUrl, location.origin);
    url.searchParams.set(urlParam, value);
    return url.href;
  } catch {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}${encodeURIComponent(urlParam)}=${encodedValue}`;
  }
}

function getSearchRuntimeConfig() {
  if (typeof globalThis !== "undefined" && globalThis.DPRK_SEARCH_CONFIG) return globalThis.DPRK_SEARCH_CONFIG;
  if (typeof window !== "undefined" && window.DPRK_SEARCH_CONFIG) return window.DPRK_SEARCH_CONFIG;
  return {};
}

function isPublicDirectAssetUrl(value = "") {
  try {
    const url = new URL(value);
    return PUBLIC_DIRECT_ASSET_HOSTS.has(url.hostname.toLocaleLowerCase("en-US"));
  } catch {
    return false;
  }
}

function isPreviewAssetUrl(value = "") {
  return /\.(?:avif|gif|jpe?g|pdf|png|svg|webp)(?:$|[?#])/i.test(value)
    || isKcnaImageEndpoint(value);
}

function isKcnaImageEndpoint(value = "") {
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    return host === "kcna.kp"
      && /^\/(?:kp|en|jp|cn|ru|sp|es)\/image\/q\/[^/?#]+\.kcmsf$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function createPdfPreview(record, src) {
  const wrapper = document.createElement("section");
  const frame = document.createElement("iframe");
  const fallback = document.createElement("p");
  wrapper.className = "search-document-media search-document-media-pdf";
  frame.title = `${record.title || "문헌"} 미리보기`;
  frame.loading = "lazy";
  configureEmbeddedMedia(frame);
  frame.src = src;
  fallback.textContent = "브라우저에서 파일 미리보기가 제한되면 위의 외부 링크로 열어보세요.";
  wrapper.append(frame, fallback);
  return wrapper;
}

function createDocumentBody(record = {}, previewRecord = record) {
  const section = document.createElement("section");
  const bodyText = isWeakArticlePreview(previewRecord)
    ? ""
    : previewRecord.body || previewRecord.snippet || "";
  const paragraphs = splitDocumentParagraphs(bodyText);

  section.className = "search-document-body";
  if (!paragraphs.length) {
    const empty = document.createElement("p");
    empty.className = "search-document-body-empty";
    empty.textContent = "색인된 본문 미리보기가 없습니다.";
    section.append(empty);
    return section;
  }

  for (const paragraph of paragraphs) {
    const p = document.createElement("p");
    p.textContent = paragraph;
    section.append(p);
  }
  return section;
}

function splitDocumentParagraphs(text = "") {
  const normalized = cleanPreviewBlockText(text);
  if (!normalized) return [];
  return normalized.split(/\n+/).map(cleanPreviewInlineText).filter(Boolean);
}

function cleanPreviewBlockText(text = "") {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanPreviewInlineText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function createDocumentHref(result, query, activeTab, filters = {}) {
  if (!result?.id) return result?.archiveUrl || result?.url || "";
  const params = createResultParams(query, activeTab, filters.sourceIds?.[0] || "", filters.page || 1, filters.sort, filters);
  params.set("id", result.id);
  return `${DOCUMENT_PATH}?${params.toString()}`;
}

function createPaginationNodes(searchResult, query, activeTab, filters = {}) {
  const total = Number(searchResult.total || 0);
  const limit = Number(filters.limit || RESULTS_PAGE_SIZE);
  const page = Number(filters.page || 1);
  if (!Number.isFinite(total) || !Number.isFinite(limit) || total <= limit) return [];

  return [createPagination(query, activeTab, {
    page,
    limit,
    total,
    sourceId: filters.sourceIds?.[0] || "",
    sort: filters.sort,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    language: filters.language || filters.languages?.[0] || "",
    excludedSourceIds: filters.excludedSourceIds || [],
    excludedMediaTypes: filters.excludedMediaTypes || [],
    excludedLanguages: filters.excludedLanguages || [],
  })];
}

function createPagination(query, activeTab, { page, limit, total, sourceId = "", sort = "relevance", dateFrom = "", dateTo = "", language = "", excludedSourceIds = [], excludedMediaTypes = [], excludedLanguages = [] }) {
  const nav = document.createElement("nav");
  const count = document.createElement("span");
  const previous = document.createElement("a");
  const next = document.createElement("a");
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const start = Math.min(total, getPageOffset(page, limit) + 1);
  const end = Math.min(total, getPageOffset(page, limit) + limit);

  nav.className = "search-pagination";
  nav.setAttribute("aria-label", "검색 결과 페이지");
  count.className = "search-pagination-count";
  count.textContent = `${formatCount(start)}-${formatCount(end)} / ${formatCount(total)}`;

  configurePaginationLink(previous, "이전", page > 1, query, activeTab, sourceId, page - 1, sort, { dateFrom, dateTo, language, excludedSourceIds, excludedMediaTypes, excludedLanguages });
  configurePaginationLink(next, "다음", page < pageCount, query, activeTab, sourceId, page + 1, sort, { dateFrom, dateTo, language, excludedSourceIds, excludedMediaTypes, excludedLanguages });
  nav.append(previous, count, next);

  return nav;
}

function configurePaginationLink(link, label, enabled, query, activeTab, sourceId, page, sort = "relevance", dateRange = {}) {
  link.className = "search-pagination-link";
  link.textContent = label;
  link.setAttribute("aria-disabled", String(!enabled));
  link.setAttribute("aria-label", createPaginationAccessibleLabel(label, page, enabled));
  if (!enabled) {
    link.removeAttribute("href");
    link.tabIndex = -1;
    return;
  }
  link.href = `${RESULTS_PATH}?${createResultParams(query, activeTab, sourceId, page, sort, dateRange).toString()}`;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    navigateToResults(createResultParams(query, activeTab, sourceId, page, sort, dateRange));
  });
}

function createPaginationAccessibleLabel(label, page, enabled) {
  if (!enabled) return `${label} 검색 결과 페이지 없음`;
  return `${label} 검색 결과 페이지, ${formatCount(page)}페이지`;
}

function createSourceFilterState(query, activeTab, { sourceId, sourceName }, filters = {}) {
  const state = document.createElement("div");
  const badge = document.createElement("span");
  const label = document.createElement("span");
  const clear = document.createElement("a");
  const params = createResultParams(query, activeTab, "", 1, filters.sort, filters);
  const name = sourceName || sourceId;

  state.className = "search-filter-state";
  state.dataset.sourceId = sourceId || "";
  state.setAttribute("aria-label", `${name} 자료원 필터 적용됨`);
  badge.className = "search-filter-badge";
  badge.textContent = "자료원 필터";
  label.className = "search-filter-name";
  label.textContent = name;
  clear.href = `${RESULTS_PATH}?${params.toString()}`;
  clear.textContent = "전체 결과";
  clear.setAttribute("aria-label", createSourceFilterClearAccessibleLabel(name));
  clear.addEventListener("click", (event) => {
    event.preventDefault();
    navigateToResults(params);
  });
  state.append(badge, label, clear);

  return state;
}

function createExcludedSourceFilterState(query, activeTab, filters = {}) {
  const excludedSourceIds = normalizeSourceIds(filters.excludedSourceIds);
  if (!excludedSourceIds.length) return null;

  const state = document.createElement("div");
  const badge = document.createElement("span");
  const label = document.createElement("span");
  const clear = document.createElement("a");
  const names = excludedSourceIds.map((sourceId) => SOURCE_BY_ID[sourceId]?.name || sourceId);
  const params = createResultParams(query, activeTab, filters.sourceIds?.[0] || "", 1, filters.sort, {
    ...filters,
    excludedSourceIds: [],
  });

  state.className = "search-filter-state search-filter-state-excluded-source";
  badge.className = "search-filter-badge";
  badge.textContent = "제외";
  label.className = "search-filter-name";
  label.textContent = `${names.join(", ")} 제외`;
  clear.href = `${RESULTS_PATH}?${params.toString()}`;
  clear.textContent = "해제";
  clear.setAttribute("aria-label", `${names.join(", ")} 제외 필터 해제`);
  clear.addEventListener("click", (event) => {
    event.preventDefault();
    navigateToResults(params);
  });
  state.append(badge, label, clear);

  return state;
}

function createExcludedMediaFilterState(query, activeTab, filters = {}) {
  const excludedMediaTypes = normalizeMediaTypes(filters.excludedMediaTypes);
  if (!excludedMediaTypes.length) return null;

  const state = document.createElement("div");
  const badge = document.createElement("span");
  const label = document.createElement("span");
  const clear = document.createElement("a");
  const names = excludedMediaTypes.map(getMediaLabel).filter(Boolean);
  const params = createResultParams(query, activeTab, filters.sourceIds?.[0] || "", 1, filters.sort, {
    ...filters,
    excludedMediaTypes: [],
  });
  const name = `${names.join(", ")} 제외`;

  state.className = "search-filter-state search-filter-state-excluded-media";
  badge.className = "search-filter-badge";
  badge.textContent = "형식 제외";
  label.className = "search-filter-name";
  label.textContent = name;
  clear.href = `${RESULTS_PATH}?${params.toString()}`;
  clear.textContent = "해제";
  clear.setAttribute("aria-label", createExcludedMediaFilterClearAccessibleLabel(name));
  clear.addEventListener("click", (event) => {
    event.preventDefault();
    navigateToResults(params);
  });
  state.append(badge, label, clear);

  return state;
}

function createDateFilterState(query, activeTab, filters = {}) {
  const dateFrom = getValidSearchDate(filters.dateFrom);
  const dateTo = getValidSearchDate(filters.dateTo);
  const labels = createDateRangeLabels({ dateFrom, dateTo });
  if (!labels.length) return null;

  const state = document.createElement("div");
  const badge = document.createElement("span");
  const label = document.createElement("span");
  const clear = document.createElement("a");
  const params = createResultParams(query, activeTab, filters.sourceIds?.[0] || "", 1, filters.sort, { ...filters, dateFrom: "", dateTo: "" });
  const language = getActiveFilterLanguage(filters);
  if (language) params.set("lang", language);
  const name = labels.join(" · ");

  state.className = "search-filter-state search-filter-state-date";
  state.setAttribute("aria-label", `${name} 기간 필터 적용됨`);
  badge.className = "search-filter-badge";
  badge.textContent = "기간 필터";
  label.className = "search-filter-name";
  label.textContent = name;
  clear.href = `${RESULTS_PATH}?${params.toString()}`;
  clear.textContent = "기간 해제";
  clear.setAttribute("aria-label", createDateFilterClearAccessibleLabel(name));
  clear.addEventListener("click", (event) => {
    event.preventDefault();
    navigateToResults(params);
  });
  state.append(badge, label, clear);

  return state;
}

function createLanguageFilterState(query, activeTab, filters = {}) {
  const language = getActiveFilterLanguage(filters);
  if (!language) return null;

  const state = document.createElement("div");
  const badge = document.createElement("span");
  const label = document.createElement("span");
  const clear = document.createElement("a");
  const params = createResultParams(query, activeTab, filters.sourceIds?.[0] || "", 1, filters.sort, { ...filters, language: "", languages: [] });
  const name = getLanguageLabel(language);

  state.className = "search-filter-state search-filter-state-language";
  state.setAttribute("aria-label", `${name} 언어 필터 적용됨`);
  badge.className = "search-filter-badge";
  badge.textContent = "언어 필터";
  label.className = "search-filter-name";
  label.textContent = name;
  clear.href = `${RESULTS_PATH}?${params.toString()}`;
  clear.textContent = "언어 해제";
  clear.setAttribute("aria-label", createLanguageFilterClearAccessibleLabel(name));
  clear.addEventListener("click", (event) => {
    event.preventDefault();
    navigateToResults(params);
  });
  state.append(badge, label, clear);

  return state;
}

function createExcludedLanguageFilterState(query, activeTab, filters = {}) {
  const excludedLanguages = normalizeLanguages(filters.excludedLanguages);
  if (!excludedLanguages.length) return null;

  const state = document.createElement("div");
  const badge = document.createElement("span");
  const label = document.createElement("span");
  const clear = document.createElement("a");
  const names = excludedLanguages.map(getLanguageLabel).filter(Boolean);
  const params = createResultParams(query, activeTab, filters.sourceIds?.[0] || "", 1, filters.sort, {
    ...filters,
    excludedLanguages: [],
  });
  const name = `${names.join(", ")} 제외`;

  state.className = "search-filter-state search-filter-state-excluded-language";
  state.setAttribute("aria-label", `${name} 언어 제외 필터 적용됨`);
  badge.className = "search-filter-badge";
  badge.textContent = "언어 제외";
  label.className = "search-filter-name";
  label.textContent = name;
  clear.href = `${RESULTS_PATH}?${params.toString()}`;
  clear.textContent = "해제";
  clear.setAttribute("aria-label", createExcludedLanguageFilterClearAccessibleLabel(name));
  clear.addEventListener("click", (event) => {
    event.preventDefault();
    navigateToResults(params);
  });
  state.append(badge, label, clear);

  return state;
}

function createAppliedFilterStates(states = []) {
  const visibleStates = states.filter(Boolean);
  if (!visibleStates.length) return null;

  const group = document.createElement("div");
  group.className = "search-filter-states";
  group.setAttribute("aria-label", "적용된 검색 필터");
  group.append(...visibleStates);
  return group;
}

function createSourceFilterClearAccessibleLabel(sourceName = "") {
  const name = String(sourceName || "").trim();
  return name ? `${name} 자료원 필터 해제하고 전체 결과 보기` : "자료원 필터 해제하고 전체 결과 보기";
}

function createDateFilterClearAccessibleLabel(dateLabel = "") {
  const label = String(dateLabel || "").trim();
  return label ? `${label} 기간 필터 해제` : "기간 필터 해제";
}

function createLanguageFilterClearAccessibleLabel(languageLabel = "") {
  const label = String(languageLabel || "").trim();
  return label ? `${label} 언어 필터 해제` : "언어 필터 해제";
}

function createExcludedMediaFilterClearAccessibleLabel(mediaLabel = "") {
  const label = String(mediaLabel || "").trim();
  return label ? `${label} 필터 해제` : "형식 제외 필터 해제";
}

function createExcludedLanguageFilterClearAccessibleLabel(languageLabel = "") {
  const label = String(languageLabel || "").trim();
  return label ? `${label} 필터 해제` : "언어 제외 필터 해제";
}

function createResultSummary(searchResult, activeTab, sourceFilter = null) {
  const summary = document.createElement("p");
  const total = Math.max(0, Number(searchResult.total) || 0);
  const tabLabel = RESULT_TABS[activeTab]?.label || RESULT_TABS.all.label;
  const sourceCount = Number(searchResult.sourceFacets?.length || searchResult.groupedSources?.length || 0);
  const sourceFacetTotal = getSourceFacetTotal(searchResult.sourceFacets);
  const processingTimeMs = Number(searchResult.processingTimeMs);
  const parts = [];

  summary.className = "search-result-summary";
  summary.setAttribute("role", "status");
  summary.setAttribute("aria-live", "polite");
  parts.push(sourceFilter
    ? `${sourceFilter.sourceName || sourceFilter.sourceId}에서 ${formatCount(total)}건`
    : `${tabLabel} 검색결과 ${formatCount(total)}건`);
  if (sourceFilter && sourceFacetTotal > total) parts.push(`전체 ${formatCount(sourceFacetTotal)}건`);
  if (sourceCount > 1) parts.push(`${formatCount(sourceCount)}개 자료원`);
  if (Number.isFinite(processingTimeMs) && processingTimeMs >= 0) {
    parts.push(`${formatSearchSeconds(processingTimeMs)}초`);
  }
  summary.textContent = parts.join(" · ");

  return summary;
}

function getSourceFacetTotal(sourceFacets = []) {
  if (!Array.isArray(sourceFacets)) return 0;
  return sourceFacets.reduce((sum, facet) => sum + Math.max(0, Number(facet?.count) || 0), 0);
}

function createSortControls(query, activeTab, filters = {}) {
  const nav = document.createElement("nav");
  const label = document.createElement("span");
  const activeSort = getValidSearchSort(filters.sort);

  nav.className = "search-sort-controls";
  nav.setAttribute("aria-label", "검색 결과 정렬");
  label.className = "search-sort-label";
  label.textContent = "정렬";
  nav.append(label);

  for (const item of SEARCH_SORT_ITEMS) {
    const link = document.createElement("a");
    const isActive = item.id === activeSort;
    const params = createResultParams(query, activeTab, filters.sourceIds?.[0] || "", 1, item.id, filters);

    link.className = ["search-sort-link", isActive ? "active" : ""].filter(Boolean).join(" ");
    link.href = `${RESULTS_PATH}?${params.toString()}`;
    link.textContent = item.label;
    link.setAttribute("aria-label", createSortAccessibleLabel(item.label, isActive));
    if (isActive) link.setAttribute("aria-current", "true");
    link.addEventListener("click", (event) => {
      event.preventDefault();
      if (isActive) return;
      navigateToResults(params);
    });
    nav.append(link);
  }

  return nav;
}

function createSortAccessibleLabel(label, isActive = false) {
  return isActive ? `${label} 정렬, 선택됨` : `${label} 정렬로 보기`;
}

function createSourceFacetFilters(query, activeTab, sourceFacets = [], activeSourceId = "", filters = {}) {
  const visibleFacets = sourceFacets.filter((facet) => facet.sourceId && Number(facet.count) > 0);
  if (visibleFacets.length <= 1) return null;

  const nav = document.createElement("nav");
  const allParams = createResultParams(query, activeTab, "", 1, filters.sort, filters);
  const allCount = visibleFacets.reduce((sum, facet) => sum + (Number(facet.count) || 0), 0);
  nav.className = "search-source-facets";
  nav.setAttribute("aria-label", "자료원 필터");
  nav.append(createSourceFacetLink({
    label: "전체",
    count: allCount,
    params: allParams,
    isActive: !activeSourceId,
    className: "search-source-facet-all",
  }));

  for (const facet of visibleFacets) {
    const params = createSourceDrilldownParams(query, activeTab, facet.sourceId, 1, filters.sort, filters);
    const isActive = facet.sourceId === activeSourceId;

    nav.append(createSourceFacetLink({
      label: facet.sourceName,
      count: Number(facet.count) || 0,
      params,
      isActive,
    }));
  }

  return nav;
}

function createSourceFacetLink({ label, count, params, isActive = false, className = "" }) {
  const link = document.createElement("a");
  const labelNode = document.createElement("span");
  const countNode = document.createElement("span");

  link.className = ["search-source-facet", className, isActive ? "active" : ""].filter(Boolean).join(" ");
  link.href = `${RESULTS_PATH}?${params.toString()}`;
  link.setAttribute("aria-label", createSourceFacetAccessibleLabel(label, count, isActive));
  if (isActive) link.setAttribute("aria-current", "true");
  labelNode.textContent = label;
  countNode.className = "search-source-facet-count";
  countNode.textContent = formatCount(count);
  link.append(labelNode, countNode);
  link.addEventListener("click", (event) => {
    event.preventDefault();
    if (isActive) return;
    navigateToResults(params);
  });

  return link;
}

function createSourceFacetAccessibleLabel(label, count, isActive = false) {
  const parts = [`${label} ${formatCount(count)}건`];
  if (isActive) parts.push("선택됨");
  return parts.join(", ");
}

function createContextualSearchSubmit(activeTab = "all", sourceId = "", activeSort = "relevance", dateRange = {}) {
  return (value, suggestion = {}) => {
    const suggestionSourceId = suggestion?.type === "source" ? suggestion.sourceId : "";
    submitSearch(value, { activeTab, sourceId: suggestionSourceId || sourceId, sort: activeSort, ...dateRange });
  };
}

function submitSearch(value, context = {}) {
  const rawQuery = String(value || "").trim();
  const parsedQuery = parseSearchQueryOperators(rawQuery);
  const preserveSourceOperator = hasPositiveSourceOperator(parsedQuery);
  const query = preserveSourceOperator ? rawQuery : getDisplayQuery(rawQuery, parsedQuery);
  const operatorTab = getValidResultTab(parsedQuery.tab);
  const activeTab = operatorTab || getValidResultTab(context.activeTab) || "all";
  const operatorSourceId = getValidSourceId(parsedQuery.sourceIds[0]);
  const sourceId = preserveSourceOperator ? "" : (operatorSourceId || getValidSourceId(context.sourceId));
  const excludedSourceIds = normalizeSourceIds([
    ...(context.excludedSourceIds || []),
    ...(parsedQuery.excludedSourceIds || []),
  ]).filter((excludedSourceId) => excludedSourceId !== sourceId);
  const excludedMediaTypes = normalizeMediaTypes([
    ...(context.excludedMediaTypes || []),
    ...(parsedQuery.excludedMediaTypes || []),
  ]);
  const language = getValidSearchLanguage(parsedQuery.languages?.[0]) || getValidSearchLanguage(context.language);
  const excludedLanguages = normalizeLanguages([
    ...(context.excludedLanguages || []),
    ...(parsedQuery.excludedLanguages || []),
  ]).filter((excludedLanguage) => excludedLanguage !== language);
  const dateFrom = getValidSearchDate(parsedQuery.dateFrom) || getValidSearchDate(context.dateFrom);
  const dateTo = getValidSearchDate(parsedQuery.dateTo) || getValidSearchDate(context.dateTo);
  const sort = getValidSearchSort(context.sort);
  const hasResultIntent = hasSearchQuery(query) || hasStructuredSearchOperators(parsedQuery) || hasActiveResultFilters({
    activeTab,
    activeSourceId: sourceId,
    dateFrom,
    dateTo,
    language,
    excludedSourceIds,
    excludedMediaTypes,
    excludedLanguages,
  });
  if (!hasResultIntent) {
    document.querySelector(".portal-search-input")?.focus({ preventScroll: true });
    return;
  }
  const params = createResultParams(query, activeTab, sourceId, 1, sort, { dateFrom, dateTo, language, excludedSourceIds, excludedMediaTypes, excludedLanguages });
  navigateToResults(params);
}

function navigateToResults(params) {
  const queryString = params.toString();
  history.pushState(null, "", `${RESULTS_PATH}${queryString ? `?${queryString}` : ""}`);
  renderPortalFromLocation();
}

function replaceResults(params) {
  const queryString = params.toString();
  history.replaceState(null, "", `${RESULTS_PATH}${queryString ? `?${queryString}` : ""}`);
  renderPortalFromLocation();
}

function createSourceFilterHref(query, activeTab, sourceId, filters = {}) {
  const params = createSourceDrilldownParams(query, activeTab, sourceId, 1, filters.sort, filters);
  return `${RESULTS_PATH}?${params.toString()}`;
}

function createSourceDrilldownParams(query, activeTab, sourceId = "", page = 1, sort = "relevance", dateRange = {}) {
  return createResultParams(getSourceDrilldownQuery(query, sourceId), activeTab, sourceId, page, sort, dateRange);
}

function getSourceDrilldownQuery(query = "", sourceId = "") {
  if (!sourceId) return String(query || "").trim();
  const parsedQuery = parseSearchQueryOperators(query);
  return hasPositiveSourceOperator(parsedQuery) ? getDisplayQuery(query, parsedQuery) : String(query || "").trim();
}

function createResultParams(query, activeTab, sourceId = "", page = 1, sort = "relevance", dateRange = {}) {
  const params = new URLSearchParams();
  const normalizedSort = getValidSearchSort(sort);
  const dateFrom = getValidSearchDate(dateRange.dateFrom);
  const dateTo = getValidSearchDate(dateRange.dateTo);
  const language = getValidSearchLanguage(dateRange.language || dateRange.languages?.[0]);
  const excludedSourceIds = normalizeSourceIds(dateRange.excludedSourceIds)
    .filter((excludedSourceId) => excludedSourceId !== sourceId);
  const excludedMediaTypes = normalizeMediaTypes(dateRange.excludedMediaTypes);
  const excludedLanguages = normalizeLanguages(dateRange.excludedLanguages)
    .filter((excludedLanguage) => excludedLanguage !== language);
  const normalizedQuery = String(query || "").trim();
  if (normalizedQuery) params.set("q", normalizedQuery);
  if (activeTab && activeTab !== "all") params.set("tab", activeTab);
  if (sourceId) params.set("source", sourceId);
  for (const excludedSourceId of excludedSourceIds) params.append("exclude_source", excludedSourceId);
  for (const excludedMediaType of excludedMediaTypes) params.append("exclude_type", excludedMediaType);
  if (language) params.set("lang", language);
  for (const excludedLanguage of excludedLanguages) params.append("exclude_lang", excludedLanguage);
  if (normalizedSort !== "relevance") params.set("sort", normalizedSort);
  if (dateFrom) params.set("after", dateFrom);
  if (dateTo) params.set("before", dateTo);
  if (Number(page) > 1) params.set("page", String(Number(page)));
  return params;
}

function createDocumentBackHref(params) {
  const rawQuery = params.get("q") || "";
  const parsedQuery = parseSearchQueryOperators(rawQuery);
  const query = getRouteQuery(rawQuery, parsedQuery, params);
  if (!hasResultRouteParams(params)) return "/search";
  const activeTab = getValidResultTab(parsedQuery.tab) || getValidResultTab(params.get("tab")) || "all";
  const sourceId = getRouteSourceId(params, parsedQuery);
  const sort = getValidSearchSort(params.get("sort"));
  const dateRange = getActiveFilters(params, parsedQuery);
  const page = normalizePage(params.get("page"));
  const backParams = createResultParams(query, activeTab, sourceId, page, sort, dateRange);
  return `${RESULTS_PATH}?${backParams.toString()}`;
}

function createDocumentBackAccessibleLabel(params) {
  const rawQuery = params.get("q") || "";
  const parsedQuery = parseSearchQueryOperators(rawQuery);
  const query = getRouteQuery(rawQuery, parsedQuery, params);
  if (!hasResultRouteParams(params)) return "검색 홈으로 이동";

  const activeTab = getValidResultTab(parsedQuery.tab) || getValidResultTab(params.get("tab")) || "all";
  const sourceId = getRouteSourceId(params, parsedQuery);
  const sort = getValidSearchSort(params.get("sort"));
  const dateRange = getActiveFilters(params, parsedQuery);
  const page = normalizePage(params.get("page"));
  const parts = [query ? `${query} 검색 결과로 돌아가기` : "검색 결과로 돌아가기"];
  if (activeTab !== "all") parts.push(`${RESULT_TABS[activeTab].label} 탭`);
  if (sourceId) parts.push(`${SOURCE_BY_ID[sourceId]?.name || sourceId} 자료원`);
  parts.push(...createExcludedSourceLabels(dateRange.excludedSourceIds));
  parts.push(...createExcludedMediaTypeLabels(dateRange.excludedMediaTypes));
  parts.push(...createLanguageLabels(dateRange.language));
  parts.push(...createExcludedLanguageLabels(dateRange.excludedLanguages));
  if (sort !== "relevance") parts.push(SEARCH_SORTS[sort].label);
  parts.push(...createDateRangeLabels(dateRange));
  if (page > 1) parts.push(`${formatCount(page)}페이지`);
  return parts.join(", ");
}

function configureExternalDocumentLink(link, href = "") {
  const value = String(href || "").trim();
  if (!value) {
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
    return;
  }
  link.href = value;
  if (!/^https?:\/\//i.test(value)) return;
  link.rel = "noreferrer";
  link.referrerPolicy = "no-referrer";
}

function getMediaLabel(mediaType = "") {
  return MEDIA_TYPE_LABELS[String(mediaType || "").trim()] || "";
}

function formatDate(date) {
  if (!date) return "";
  const [year, month, day] = String(date).split("-");
  if (!year || !month || !day) return date;
  return `${Number(year)}. ${Number(month)}. ${Number(day)}.`;
}

function formatDisplayUrl(value = "") {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    const segments = url.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean)
      .slice(0, 3);
    return [host, ...segments].join(" › ");
  } catch {
    return "";
  }
}

function isVideoFile(value = "") {
  try {
    return /\.(?:mp4|webm|ogg)(?:$|[?#])/i.test(new URL(value).pathname);
  } catch {
    return /\.(?:mp4|webm|ogg)(?:$|[?#])/i.test(String(value || ""));
  }
}

function normalizePage(value) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function getActiveDateRange(params = new URLSearchParams(), parsedQuery = {}) {
  return {
    dateFrom: getValidSearchDate(parsedQuery.dateFrom) || getValidSearchDate(params.get("after")),
    dateTo: getValidSearchDate(parsedQuery.dateTo) || getValidSearchDate(params.get("before")),
  };
}

function getActiveFilters(params = new URLSearchParams(), parsedQuery = {}) {
  return {
    ...getActiveDateRange(params, parsedQuery),
    language: getActiveLanguage(params, parsedQuery),
    excludedSourceIds: getActiveExcludedSourceIds(params, parsedQuery),
    excludedMediaTypes: getActiveExcludedMediaTypes(params, parsedQuery),
    excludedLanguages: getActiveExcludedLanguages(params, parsedQuery),
  };
}

function getDisplayQuery(rawQuery = "", parsedQuery = parseSearchQueryOperators(rawQuery)) {
  return parsedQuery.query || (hasStructuredSearchOperators(parsedQuery) ? "" : rawQuery);
}

function getRouteQuery(rawQuery = "", parsedQuery = parseSearchQueryOperators(rawQuery), params = new URLSearchParams()) {
  return hasPositiveSourceOperator(parsedQuery) && !getValidSourceId(params.get("source"))
    ? String(rawQuery || "").trim()
    : String(getDisplayQuery(rawQuery, parsedQuery) || "").trim();
}

function getRouteSourceId(params = new URLSearchParams(), parsedQuery = {}) {
  const explicitSourceId = getValidSourceId(params.get("source"));
  if (explicitSourceId) return explicitSourceId;
  return hasPositiveSourceOperator(parsedQuery) ? "" : getValidSourceId(parsedQuery.sourceIds?.[0]);
}

function hasPositiveSourceOperator(parsedQuery = {}) {
  return Array.isArray(parsedQuery.sourceIds) && parsedQuery.sourceIds.length > 0;
}

function hasResultRouteParams(params = new URLSearchParams()) {
  const rawQuery = params.get("q") || "";
  const parsedQuery = parseSearchQueryOperators(rawQuery);
  const query = getRouteQuery(rawQuery, parsedQuery, params);
  const activeTab = getValidResultTab(parsedQuery.tab) || getValidResultTab(params.get("tab")) || "all";
  const activeSourceId = getRouteSourceId(params, parsedQuery);
  const activeFilters = getActiveFilters(params, parsedQuery);
  return hasSearchQuery(query) || hasStructuredSearchOperators(parsedQuery) || hasActiveResultFilters({
    activeTab,
    activeSourceId,
    ...activeFilters,
  });
}

function hasActiveResultFilters({
  activeTab = "all",
  activeSourceId = "",
  dateFrom = "",
  dateTo = "",
  language = "",
  excludedSourceIds = [],
  excludedMediaTypes = [],
  excludedLanguages = [],
} = {}) {
  return Boolean(
    (activeTab && activeTab !== "all")
      || activeSourceId
      || getValidSearchDate(dateFrom)
      || getValidSearchDate(dateTo)
      || getValidSearchLanguage(language)
      || normalizeSourceIds(excludedSourceIds).length
      || normalizeMediaTypes(excludedMediaTypes).length
      || normalizeLanguages(excludedLanguages).length,
  );
}

function getActiveLanguage(params = new URLSearchParams(), parsedQuery = {}) {
  return getValidSearchLanguage(parsedQuery.languages?.[0]) || getValidSearchLanguage(params.get("lang"));
}

function getActiveExcludedSourceIds(params = new URLSearchParams(), parsedQuery = {}) {
  return normalizeSourceIds([
    ...(parsedQuery.excludedSourceIds || []),
    ...params.getAll("exclude_source").flatMap((value) => String(value || "").split(",")),
  ]);
}

function getActiveExcludedMediaTypes(params = new URLSearchParams(), parsedQuery = {}) {
  return normalizeMediaTypes([
    ...(parsedQuery.excludedMediaTypes || []),
    ...params.getAll("exclude_type").flatMap((value) => String(value || "").split(",")),
  ]);
}

function getActiveExcludedLanguages(params = new URLSearchParams(), parsedQuery = {}) {
  const language = getActiveLanguage(params, parsedQuery);
  return normalizeLanguages([
    ...(parsedQuery.excludedLanguages || []),
    ...params.getAll("exclude_lang").flatMap((value) => String(value || "").split(",")),
  ]).filter((excludedLanguage) => excludedLanguage !== language);
}

function normalizeSourceIds(sourceIds = []) {
  return [...new Set(
    (Array.isArray(sourceIds) ? sourceIds : [sourceIds])
      .map(getValidSourceId)
      .filter(Boolean),
  )];
}

function normalizeMediaTypes(mediaTypes = []) {
  return [...new Set(
    (Array.isArray(mediaTypes) ? mediaTypes : [mediaTypes])
      .map(getValidMediaType)
      .filter(Boolean),
  )];
}

function normalizeLanguages(languages = []) {
  return [...new Set(
    (Array.isArray(languages) ? languages : [languages])
      .map(getValidSearchLanguage)
      .filter(Boolean),
  )];
}

function setCanonicalExcludedSourceIds(params, sourceIds = []) {
  params.delete("exclude_source");
  for (const sourceId of normalizeSourceIds(sourceIds)) {
    params.append("exclude_source", sourceId);
  }
}

function setCanonicalExcludedMediaTypes(params, mediaTypes = []) {
  params.delete("exclude_type");
  for (const mediaType of normalizeMediaTypes(mediaTypes)) {
    params.append("exclude_type", mediaType);
  }
}

function setCanonicalExcludedLanguages(params, languages = []) {
  params.delete("exclude_lang");
  for (const language of normalizeLanguages(languages)) {
    params.append("exclude_lang", language);
  }
}

function getActiveFilterLanguage(filters = {}) {
  return getValidSearchLanguage(filters.language || filters.languages?.[0]);
}

function createDateRangeLabels({ dateFrom = "", dateTo = "" } = {}) {
  const labels = [];
  if (getValidSearchDate(dateFrom)) labels.push(`${dateFrom} 이후`);
  if (getValidSearchDate(dateTo)) labels.push(`${dateTo} 이전`);
  return labels;
}

function createExcludedSourceLabels(sourceIds = []) {
  return normalizeSourceIds(sourceIds).map((sourceId) => `${SOURCE_BY_ID[sourceId]?.name || sourceId} 제외`);
}

function createExcludedMediaTypeLabels(mediaTypes = []) {
  return normalizeMediaTypes(mediaTypes).map((mediaType) => `${getMediaLabel(mediaType) || mediaType} 제외`);
}

function createLanguageLabels(language = "") {
  const label = getLanguageLabel(language);
  return label ? [`${label} 언어`] : [];
}

function createExcludedLanguageLabels(languages = []) {
  return normalizeLanguages(languages).map((language) => `${getLanguageLabel(language) || language} 제외`);
}

function getLanguageLabel(language = "") {
  const value = getValidSearchLanguage(language);
  return value ? (LANGUAGE_LABELS[value] || value) : "";
}

function getValidResultTab(tab) {
  const value = String(tab || "").trim();
  return value && RESULT_TABS[value] ? value : "";
}

function getValidSourceId(sourceId) {
  const value = String(sourceId || "").trim();
  return value && SOURCE_BY_ID[value] ? value : "";
}

function getValidMediaType(mediaType) {
  const value = String(mediaType || "").trim();
  return value && RESULT_TABS.all.mediaTypes.includes(value) ? value : "";
}

function getValidSearchSort(sort) {
  const value = String(sort || "").trim();
  return SEARCH_SORTS[value] ? value : "relevance";
}

function getValidSearchDate(date) {
  const value = String(date || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function getValidSearchLanguage(language) {
  const value = String(language || "").trim();
  return value && SEARCH_LANGUAGES.includes(value) ? value : "";
}

function getPageOffset(page, limit) {
  return (Math.max(1, Number(page) || 1) - 1) * Math.max(1, Number(limit) || RESULTS_PAGE_SIZE);
}

function shouldRedirectOutOfRangePage(searchResult = {}, filters = {}) {
  const total = Number(searchResult.total || 0);
  const page = Number(filters.page || 1);
  const limit = Number(filters.limit || RESULTS_PAGE_SIZE);
  return page > 1
    && total > 0
    && getPageOffset(page, limit) >= total
    && !(searchResult.documents || []).length;
}

function getLastResultPage(total, limit) {
  return Math.max(1, Math.ceil((Number(total) || 0) / Math.max(1, Number(limit) || RESULTS_PAGE_SIZE)));
}

function formatCount(value) {
  return new Intl.NumberFormat("ko-KR").format(Number(value) || 0);
}

function formatSearchSeconds(milliseconds) {
  return (Math.max(0, milliseconds) / 1000).toLocaleString("ko-KR", {
    maximumFractionDigits: 3,
    minimumFractionDigits: 0,
  });
}

async function refreshSuggestions(list, value, onSelect = submitSearch) {
  const suggestionToken = ++activeSuggestionToken;
  if (!hasSearchQuery(value)) {
    updateSearchSuggestions(list, [], onSelect);
    return;
  }
  try {
    const suggestions = await searchProvider.getSuggestions(value);
    if (suggestionToken !== activeSuggestionToken) return;
    updateSearchSuggestions(list, suggestions, onSelect);
  } catch {
    if (suggestionToken === activeSuggestionToken) updateSearchSuggestions(list, [], onSelect);
  }
}

function createLoadingState() {
  const state = document.createElement("section");
  const message = document.createElement("p");
  state.className = "search-state search-loading-state";
  state.setAttribute("role", "status");
  state.setAttribute("aria-live", "polite");
  state.setAttribute("aria-busy", "true");
  message.className = "search-state-message";
  message.textContent = "검색 결과를 불러오는 중입니다.";
  state.append(message);

  for (let index = 0; index < 3; index += 1) {
    const line = document.createElement("span");
    line.className = "search-loading-line";
    line.setAttribute("aria-hidden", "true");
    state.append(line);
  }

  return state;
}

function createEmptyState(title, description) {
  const state = document.createElement("section");
  const heading = document.createElement("h2");
  const copy = document.createElement("p");

  state.className = "search-state search-empty-state";
  state.setAttribute("role", "status");
  state.setAttribute("aria-live", "polite");
  heading.textContent = title;
  copy.textContent = description;
  state.append(heading, copy);

  return state;
}

function createNoResultsState(title, description, suggestions = [], activeTab = "all", query = "", filters = {}) {
  const state = createEmptyState(title, description);
  const usableSuggestions = suggestions
    .filter((suggestion) => suggestion?.label)
    .slice(0, 5);
  const tabRecovery = createTabRecoveryLink(query, activeTab, filters);
  if (!usableSuggestions.length && !tabRecovery) return state;

  const suggestionWrap = document.createElement("div");
  const label = document.createElement("span");
  const links = document.createElement("div");

  state.classList.add("search-no-results-state");
  suggestionWrap.className = "search-state-suggestions";
  label.className = "search-state-suggestion-label";
  label.textContent = usableSuggestions.length ? "추천 검색어" : "다시 검색";
  links.className = "search-state-suggestion-links";

  for (const suggestion of usableSuggestions) {
    const link = document.createElement("a");
    const params = createSuggestionResultParams(suggestion, activeTab, filters);

    link.className = "search-state-suggestion";
    link.href = `${RESULTS_PATH}?${params.toString()}`;
    link.textContent = suggestion.label;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigateToResults(params);
    });
    links.append(link);
  }
  if (tabRecovery) links.append(tabRecovery);

  suggestionWrap.append(label, links);
  state.append(suggestionWrap);

  return state;
}

function createSuggestionResultParams(suggestion = {}, activeTab = "all", filters = {}) {
  const sourceId = getSuggestionResultSourceId(suggestion, filters);
  return createResultParams(getSuggestionSearchValue(suggestion), activeTab, sourceId, 1, filters.sort, filters);
}

function getSuggestionResultSourceId(suggestion = {}, filters = {}) {
  if (suggestion.type === "source") return suggestion.sourceId;
  const parsedSuggestionQuery = parseSearchQueryOperators(getSuggestionSearchValue(suggestion));
  return hasPositiveSourceOperator(parsedSuggestionQuery) ? "" : filters.sourceIds?.[0] || "";
}

function createTabRecoveryLink(query, activeTab = "all", filters = {}) {
  if (activeTab === "all" || !hasSearchQuery(query)) return null;
  const link = document.createElement("a");
  const params = createResultParams(query, "all", filters.sourceIds?.[0] || "", 1, filters.sort, filters);

  link.className = "search-state-suggestion search-state-tab-recovery";
  link.href = `${RESULTS_PATH}?${params.toString()}`;
  link.textContent = "전체 탭에서 보기";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    navigateToResults(params);
  });
  return link;
}

async function getNoResultSuggestions(query) {
  try {
    const currentQuery = String(query || "").trim();
    return (await searchProvider.getSuggestions(query))
      .filter((suggestion) => getSuggestionSearchValue(suggestion) !== currentQuery);
  } catch {
    return [];
  }
}

function getSuggestionSearchValue(suggestion = {}) {
  return String(suggestion?.value || suggestion?.label || "").trim();
}
