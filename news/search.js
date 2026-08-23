(function initializeNewsSearch() {
  const form = document.querySelector("#newsSearchForm");
  const input = document.querySelector("#newsSearchInput");
  const list = document.querySelector("#newsSearchResults");
  const pagination = document.querySelector("#newsSearchPagination");
  const status = document.querySelector("#newsSearchStatus");
  if (!form || !input || !list || !pagination || !status) return;

  const SEARCH_INDEX_URL = "/data/news/search-index.json";
  const SEARCH_INDEX_SCHEMA_VERSION = 1;
  const PAGE_SIZE = 5;
  const PAGE_WINDOW = 5;
  const SEARCH_DEBOUNCE_MS = 150;
  const MAX_QUERY_CODE_POINTS = 100;
  const MAX_QUERY_BYTES = 512;
  const MAX_INDEX_ITEMS = 20_000;
  const SOURCE_IDS = new Set(["kcna", "rodong-sinmun"]);
  const DISALLOWED_QUERY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u202a-\u202e\u2066-\u2069\ufeff]/u;

  let preparedArticles = [];
  let indexPromise = null;
  let currentQuery = "";
  let currentPage = 1;
  let debounceTimer = 0;
  let renderSequence = 0;

  bindSearchControls();
  syncFromLocation();

  function bindSearchControls() {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      clearTimeout(debounceTimer);
      commitSearch(input.value, 1, { historyMode: "push" });
    });
    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        commitSearch(input.value, 1, { historyMode: "replace" });
      }, SEARCH_DEBOUNCE_MS);
    });
    window.addEventListener("popstate", syncFromLocation);
  }

  function syncFromLocation() {
    clearTimeout(debounceTimer);
    const parameters = new URLSearchParams(window.location.search);
    currentQuery = String(parameters.get("q") || "").trim();
    currentPage = normalizePageNumber(parameters.get("page"));
    input.value = currentQuery;
    renderSearch();
    if (window.location.hash === "#search") requestAnimationFrame(() => input.focus());
  }

  function commitSearch(value, page, { historyMode = "replace" } = {}) {
    currentQuery = String(value || "").trim();
    currentPage = normalizePageNumber(page);
    input.value = currentQuery;
    const url = buildSearchUrl(currentQuery, currentPage);
    if (historyMode === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
    renderSearch();
  }

  async function renderSearch() {
    const sequence = ++renderSequence;
    const query = validateQuery(currentQuery);
    updateDocumentTitle(query.valid ? query.query : "");

    if (!query.valid) {
      renderEmpty(query.message);
      return;
    }
    if (!query.query) {
      renderEmpty("검색어를 입력해 주세요.");
      return;
    }

    if (!preparedArticles.length) renderLoading();
    try {
      const articles = await loadSearchIndex();
      if (sequence !== renderSequence) return;
      const matches = findMatchingArticles(articles, query.tokens);
      if (!matches.length) {
        renderEmpty("일치하는 기사가 없습니다.");
        status.textContent = `“${query.query}” 검색 결과가 없습니다.`;
        return;
      }

      const totalPages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
      const boundedPage = Math.min(currentPage, totalPages);
      if (boundedPage !== currentPage) {
        currentPage = boundedPage;
        window.history.replaceState(null, "", buildSearchUrl(currentQuery, currentPage));
      }
      const pageArticles = matches.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
      renderArticles(pageArticles.map((entry) => entry.article), query.query, matches.length);
      renderPagination(totalPages);
      status.textContent = `“${query.query}” 검색 결과 ${matches.length}건, ${currentPage}페이지입니다.`;
    } catch (error) {
      if (sequence !== renderSequence) return;
      console.error("[news/search] Unable to load the full news index.", error);
      renderEmpty("뉴스 아카이브를 불러오지 못했습니다.");
    }
  }

  async function loadSearchIndex() {
    if (!indexPromise) {
      indexPromise = fetch(SEARCH_INDEX_URL, {
        cache: "no-cache",
        headers: { Accept: "application/json" },
      }).then(async (response) => {
        if (!response.ok) throw new Error(`news_search_${response.status}`);
        const payload = await response.json();
        if (!isValidSearchIndex(payload)) throw new Error("invalid_news_search_index");
        preparedArticles = payload.articles.map(prepareSearchArticle);
        list.dataset.generatedAt = String(payload.generatedAt || "");
        list.dataset.snapshotVersion = payload.version;
        return preparedArticles;
      }).catch((error) => {
        indexPromise = null;
        throw error;
      });
    }
    return indexPromise;
  }

  function isValidSearchIndex(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || payload.schemaVersion !== SEARCH_INDEX_SCHEMA_VERSION
      || !/^[a-f0-9]{16}$/u.test(String(payload.version || ""))
      || typeof payload.generatedAt !== "string"
      || !Number.isSafeInteger(payload.totalItems)
      || payload.totalItems < 0
      || payload.totalItems > MAX_INDEX_ITEMS
      || !Array.isArray(payload.articles)
      || payload.articles.length !== payload.totalItems) return false;

    const ids = new Set();
    for (const article of payload.articles) {
      if (!isValidSearchArticle(article) || ids.has(article.id)) return false;
      ids.add(article.id);
    }
    return true;
  }

  function isValidSearchArticle(article) {
    if (!article || typeof article !== "object" || Array.isArray(article)) return false;
    const id = String(article.id || "");
    return /^[a-z0-9][a-z0-9._:-]{1,191}$/u.test(id)
      && typeof article.title === "string"
      && article.title.trim().length > 0
      && article.title.length <= 2_000
      && /^20\d{2}-\d{2}-\d{2}$/u.test(String(article.date || ""))
      && SOURCE_IDS.has(article.sourceId)
      && typeof article.sourceName === "string"
      && article.sourceName.length > 0
      && article.sourceName.length <= 80
      && typeof article.snippet === "string"
      && article.snippet.length <= 20_000
      && typeof article.url === "string"
      && article.url.length <= 20_000
      && typeof article.thumbnailUrl === "string"
      && article.thumbnailUrl.length <= 20_000
      && typeof article.cachedThumbnailUrl === "string"
      && article.cachedThumbnailUrl.length <= 512
      && article.detailUrl === `/news/document?id=${encodeURIComponent(id)}`;
  }

  function prepareSearchArticle(article) {
    const date = String(article.date || "");
    return {
      article,
      searchText: normalizeSearchText([
        article.title,
        article.snippet,
        article.sourceName,
        date,
        formatLongDate(date),
        formatCompactDate(date),
      ].join(" ")),
    };
  }

  function findMatchingArticles(articles, tokens) {
    if (!Array.isArray(tokens) || !tokens.length) return [];
    return articles.filter((entry) => tokens.every((token) => entry.searchText.includes(token)));
  }

  function validateQuery(value) {
    const query = String(value || "").trim();
    if (!query) return { valid: true, query: "", tokens: [], message: "" };
    if (DISALLOWED_QUERY_CHARACTERS.test(query)) {
      return { valid: false, query, tokens: [], message: "검색어에 사용할 수 없는 문자가 포함되어 있습니다." };
    }
    if ([...query].length > MAX_QUERY_CODE_POINTS || utf8ByteLength(query) > MAX_QUERY_BYTES) {
      return { valid: false, query, tokens: [], message: "검색어가 너무 깁니다." };
    }
    const normalized = normalizeSearchText(query);
    const tokens = [...new Set(normalized.split(" ").filter(Boolean))];
    return { valid: Boolean(tokens.length), query, tokens, message: tokens.length ? "" : "검색어를 입력해 주세요." };
  }

  function normalizeSearchText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\s+/gu, " ")
      .trim()
      .toLocaleLowerCase("ko-KR");
  }

  function utf8ByteLength(value) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(value).length;
    return unescape(encodeURIComponent(value)).length;
  }

  function renderArticles(articles, query, totalItems) {
    const fragment = document.createDocumentFragment();
    for (const article of articles) fragment.append(createArticle(article));
    list.replaceChildren(fragment);
    list.setAttribute("aria-busy", "false");
    list.setAttribute("aria-label", `“${query}” 검색 결과 ${totalItems}건`);
  }

  function createArticle(article) {
    const item = document.createElement("article");
    const link = document.createElement("a");
    const copy = document.createElement("div");
    const articleTitle = document.createElement("h2");
    const date = document.createElement("time");
    const imageSources = resolveArticleImageSources(article);

    item.className = "news-category-row";
    item.setAttribute("role", "listitem");
    link.className = "news-category-row-link";
    link.href = resolveDetailUrl(article);
    copy.className = "news-category-copy";
    articleTitle.className = "news-category-row-title";
    articleTitle.textContent = article.title || "기사";
    date.className = "news-category-row-date";
    date.dateTime = String(article.date || "");
    date.textContent = formatLongDate(article.date);
    copy.append(articleTitle, date);
    link.append(copy);

    if (imageSources.length) {
      const figure = document.createElement("div");
      const image = document.createElement("img");
      figure.className = "news-category-thumbnail";
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      loadFirstAvailableImage(image, imageSources, () => figure.remove());
      figure.append(image);
      link.append(figure);
    }

    item.append(link);
    return item;
  }

  function resolveDetailUrl(article) {
    const expected = `/news/document?id=${encodeURIComponent(article?.id || "")}`;
    return article?.detailUrl === expected ? expected : expected;
  }

  function resolveArticleImageSources(article) {
    const sources = [];
    const cachedSource = resolveCachedImageSource(article?.cachedThumbnailUrl, article?.sourceId);
    if (cachedSource) sources.push(cachedSource);
    const remoteSource = resolveNewsImageProxySource(article?.thumbnailUrl, article?.url);
    if (remoteSource && !sources.includes(remoteSource)) sources.push(remoteSource);
    return sources;
  }

  function resolveCachedImageSource(value, sourceId) {
    const candidate = String(value || "").trim();
    const prefix = `/data/news/assets/${sourceId}/`;
    if (!SOURCE_IDS.has(sourceId) || !candidate.startsWith(prefix)) return "";
    const fileName = candidate.slice(prefix.length);
    return /^[a-f0-9]{64}\.(?:jpe?g|png|gif|webp)$/u.test(fileName) ? candidate : "";
  }

  function resolveNewsImageProxySource(value, refererValue) {
    const candidate = String(value || "").trim();
    if (!isAllowedOfficialNewsImageUrl(candidate)) return "";
    const parameters = new URLSearchParams({ url: candidate });
    if (isSameOfficialNewsOrigin(refererValue, candidate)) parameters.set("referer", String(refererValue));
    return `/api/news-image?${parameters.toString()}`;
  }

  function isAllowedOfficialNewsImageUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "");
      if (host === "kcna.kp") return /^\/photo\/[a-f0-9]{32,128}$/iu.test(url.pathname) && !url.search;
      return host === "rodong.rep.kp"
        && /^\/ko\/index\.php$/u.test(url.pathname)
        && /^\?[A-Za-z0-9+/_=-]{8,8192}$/u.test(url.search);
    } catch {
      return false;
    }
  }

  function isSameOfficialNewsOrigin(value, imageValue) {
    try {
      const referer = new URL(String(value || ""));
      const image = new URL(imageValue);
      return referer.protocol === image.protocol
        && referer.hostname.replace(/^www\./u, "") === image.hostname.replace(/^www\./u, "")
        && referer.port === image.port;
    } catch {
      return false;
    }
  }

  function loadFirstAvailableImage(image, sources, onFailure) {
    let index = 0;
    const tryNext = () => {
      if (index >= sources.length) {
        image.removeAttribute("src");
        onFailure();
        return;
      }
      image.src = sources[index];
      index += 1;
    };
    image.addEventListener("error", tryNext);
    tryNext();
  }

  function renderPagination(totalPages) {
    pagination.replaceChildren();
    if (totalPages <= 1) {
      pagination.hidden = true;
      return;
    }

    pagination.hidden = false;
    pagination.append(createPaginationArrow(currentPage - 1, "이전 페이지", currentPage === 1));
    for (const page of getPaginationRange(currentPage, totalPages)) {
      if (page === currentPage) {
        const current = document.createElement("span");
        current.className = "news-category-page-number active";
        current.setAttribute("aria-current", "page");
        current.textContent = String(page);
        pagination.append(current);
      } else {
        pagination.append(createPaginationLink(page));
      }
    }
    pagination.append(createPaginationArrow(currentPage + 1, "다음 페이지", currentPage === totalPages, true));
  }

  function createPaginationLink(page) {
    const link = document.createElement("a");
    link.className = "news-category-page-number";
    link.href = buildSearchUrl(currentQuery, page);
    link.setAttribute("aria-label", `${page}페이지`);
    link.textContent = String(page);
    bindPaginationLink(link, page);
    return link;
  }

  function createPaginationArrow(page, label, disabled, next = false) {
    const control = document.createElement(disabled ? "span" : "a");
    const image = document.createElement("img");
    control.className = "news-category-page-arrow";
    control.setAttribute("aria-label", label);
    if (disabled) control.setAttribute("aria-disabled", "true");
    else {
      control.href = buildSearchUrl(currentQuery, page);
      bindPaginationLink(control, page);
    }
    image.className = `news-category-page-arrow-icon${next ? " next" : ""}`;
    image.src = "/assets/news-pagination-arrow-left.svg?v=news-20260822-1";
    image.alt = "";
    control.append(image);
    return control;
  }

  function bindPaginationLink(link, page) {
    link.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      commitSearch(currentQuery, page, { historyMode: "push" });
      window.scrollTo({ top: 0, behavior: "auto" });
    });
  }

  function buildSearchUrl(query, page) {
    const parameters = new URLSearchParams();
    const normalizedQuery = String(query || "").trim();
    if (normalizedQuery) parameters.set("q", normalizedQuery);
    const normalizedPage = normalizePageNumber(page);
    if (normalizedQuery && normalizedPage > 1) parameters.set("page", String(normalizedPage));
    const serialized = parameters.toString();
    return serialized ? `/news/search?${serialized}` : "/news/search";
  }

  function getPaginationRange(page, totalPages) {
    const visibleCount = Math.min(PAGE_WINDOW, totalPages);
    const maximumStart = Math.max(1, totalPages - visibleCount + 1);
    const start = Math.min(Math.max(1, page - Math.floor(visibleCount / 2)), maximumStart);
    return Array.from({ length: visibleCount }, (_, index) => start + index);
  }

  function normalizePageNumber(value) {
    const candidate = String(value || "").trim();
    if (!/^[1-9]\d{0,5}$/u.test(candidate)) return 1;
    return Number(candidate);
  }

  function renderLoading() {
    list.replaceChildren(...Array.from({ length: 3 }, () => {
      const loading = document.createElement("div");
      loading.className = "news-category-loading";
      loading.setAttribute("aria-hidden", "true");
      return loading;
    }));
    list.setAttribute("aria-busy", "true");
    pagination.replaceChildren();
    pagination.hidden = true;
    status.textContent = "전체 뉴스 기사를 검색하는 중입니다.";
  }

  function renderEmpty(message) {
    const empty = document.createElement("p");
    empty.className = "news-category-empty";
    empty.textContent = message;
    list.replaceChildren(empty);
    list.setAttribute("aria-busy", "false");
    list.setAttribute("aria-label", "뉴스 검색 결과");
    pagination.replaceChildren();
    pagination.hidden = true;
    status.textContent = message;
  }

  function updateDocumentTitle(query) {
    document.title = query
      ? `${query} 검색 | 북한뉴스아카이브`
      : "뉴스 검색 | 북한뉴스아카이브";
  }

  function formatLongDate(value) {
    const match = String(value || "").match(/^(20\d{2})-(\d{2})-(\d{2})$/u);
    return match ? `${match[1]}년 ${Number(match[2])}월 ${Number(match[3])}일` : String(value || "");
  }

  function formatCompactDate(value) {
    const match = String(value || "").match(/^(20\d{2})-(\d{2})-(\d{2})$/u);
    return match ? `${match[1]}.${match[2]}.${match[3]}.` : String(value || "");
  }
})();
