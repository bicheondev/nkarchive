(function initializeNewsSearch() {
  const form = document.querySelector("#newsSearchForm");
  const input = document.querySelector("#newsSearchInput");
  const list = document.querySelector("#newsSearchResults");
  const pagination = document.querySelector("#newsSearchPagination");
  const status = document.querySelector("#newsSearchStatus");
  const sourceInput = document.querySelector("#newsSearchSource");
  const sourceTabs = [...document.querySelectorAll("[data-news-search-source]")];
  if (!form || !input || !list || !pagination || !status || !sourceInput || sourceTabs.length !== 3) return;

  const SEARCH_INDEX_URL = "/data/news/search-index.json";
  const YOUTUBE_INDEX_URL = "/data/news/youtube-videos.json";
  const SEARCH_INDEX_SCHEMA_VERSION = 1;
  const YOUTUBE_INDEX_SCHEMA_VERSION = 1;
  const PAGE_SIZE = 5;
  const PAGE_WINDOW = 5;
  const SEARCH_DEBOUNCE_MS = 150;
  const MAX_QUERY_CODE_POINTS = 100;
  const MAX_QUERY_BYTES = 512;
  const MAX_INDEX_ITEMS = 20_000;
  const SOURCE_IDS = new Set(["kcna", "rodong-sinmun"]);
  const SEARCH_SOURCE_IDS = new Set([...SOURCE_IDS, "youtube"]);
  const SOURCE_NAMES = Object.freeze({
    kcna: "조선중앙통신",
    "rodong-sinmun": "로동신문",
    youtube: "YouTube",
  });
  const YOUTUBE_CHANNEL_NAMES = new Set(["메아리", "supersuhui"]);
  const DISALLOWED_QUERY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u202a-\u202e\u2066-\u2069\ufeff]/u;

  let preparedArticles = [];
  let indexPromise = null;
  let preparedYoutubeVideos = [];
  let youtubeIndexPromise = null;
  let currentQuery = "";
  let currentPage = 1;
  let currentSourceId = "kcna";
  let debounceTimer = 0;
  let renderSequence = 0;

  bindSearchControls();
  bindSourceControls();
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

  function bindSourceControls() {
    for (const tab of sourceTabs) {
      tab.addEventListener("click", (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const sourceId = normalizeSourceId(tab.dataset.newsSearchSource);
        event.preventDefault();
        if (sourceId === currentSourceId) return;
        commitSearch(currentQuery, 1, { historyMode: "push", sourceId });
      });
    }
  }

  function syncFromLocation() {
    clearTimeout(debounceTimer);
    const parameters = new URLSearchParams(window.location.search);
    currentQuery = String(parameters.get("q") || "").trim();
    currentPage = normalizePageNumber(parameters.get("page"));
    currentSourceId = normalizeSourceId(parameters.get("source"));
    input.value = currentQuery;
    updateSourceControls();
    renderSearch();
    if (window.location.hash === "#search") requestAnimationFrame(() => input.focus());
  }

  function commitSearch(value, page, { historyMode = "replace", sourceId = currentSourceId } = {}) {
    currentQuery = String(value || "").trim();
    currentPage = normalizePageNumber(page);
    currentSourceId = normalizeSourceId(sourceId);
    input.value = currentQuery;
    updateSourceControls();
    const url = buildSearchUrl(currentQuery, currentPage, currentSourceId);
    if (historyMode === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
    renderSearch();
  }

  async function renderSearch() {
    const sequence = ++renderSequence;
    const query = validateQuery(currentQuery);
    updateDocumentTitle(query.valid ? query.query : "", currentSourceId);

    if (!query.valid) {
      renderEmpty(query.message);
      return;
    }
    if (!query.query) {
      renderEmpty("검색어를 입력해 주세요.");
      return;
    }

    const sourceIsLoaded = currentSourceId === "youtube"
      ? preparedYoutubeVideos.length > 0
      : preparedArticles.length > 0;
    if (!sourceIsLoaded) renderLoading();
    try {
      const articles = await loadSearchIndex(currentSourceId);
      if (sequence !== renderSequence) return;
      const matches = findMatchingArticles(articles, query.tokens);
      if (!matches.length) {
        renderEmpty("일치하는 검색 결과가 없습니다.");
        status.textContent = `“${query.query}” 검색 결과가 없습니다.`;
        return;
      }

      const totalPages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
      const boundedPage = Math.min(currentPage, totalPages);
      if (boundedPage !== currentPage) {
        currentPage = boundedPage;
        window.history.replaceState(null, "", buildSearchUrl(currentQuery, currentPage, currentSourceId));
      }
      const pageArticles = matches.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
      renderArticles(pageArticles.map((entry) => entry.article), query.query, matches.length);
      renderPagination(totalPages);
      status.textContent = `“${query.query}” ${SOURCE_NAMES[currentSourceId]} 검색 결과 ${matches.length}건, ${currentPage}페이지입니다.`;
    } catch (error) {
      if (sequence !== renderSequence) return;
      console.error("[news/search] Unable to load the full news index.", error);
      renderEmpty("뉴스 아카이브를 불러오지 못했습니다.");
    }
  }

  async function loadSearchIndex(sourceId = currentSourceId) {
    if (sourceId === "youtube") return loadYoutubeIndex();
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
    const articles = await indexPromise;
    return filterArticlesBySource(articles, sourceId);
  }

  async function loadYoutubeIndex() {
    if (!youtubeIndexPromise) {
      youtubeIndexPromise = fetch(YOUTUBE_INDEX_URL, {
        cache: "no-cache",
        headers: { Accept: "application/json" },
      }).then(async (response) => {
        if (!response.ok) throw new Error(`news_youtube_search_${response.status}`);
        const payload = await response.json();
        if (!isValidYoutubeIndex(payload)) throw new Error("invalid_news_youtube_search_index");
        preparedYoutubeVideos = payload.videos.map(prepareYoutubeVideo);
        list.dataset.generatedAt = String(payload.generatedAt || "");
        list.dataset.snapshotVersion = payload.version;
        return preparedYoutubeVideos;
      }).catch((error) => {
        youtubeIndexPromise = null;
        throw error;
      });
    }
    return youtubeIndexPromise;
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

  function isValidYoutubeIndex(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || payload.schemaVersion !== YOUTUBE_INDEX_SCHEMA_VERSION
      || typeof payload.generatedAt !== "string"
      || typeof payload.version !== "string"
      || payload.version.length < 1
      || payload.version.length > 128
      || !Number.isSafeInteger(payload.totalItems)
      || payload.totalItems < 0
      || payload.totalItems > MAX_INDEX_ITEMS
      || !payload.channelCounts
      || typeof payload.channelCounts !== "object"
      || Array.isArray(payload.channelCounts)
      || !Array.isArray(payload.videos)
      || payload.videos.length !== payload.totalItems) return false;

    const expectedChannels = [...YOUTUBE_CHANNEL_NAMES];
    if (Object.keys(payload.channelCounts).sort().join("\n") !== expectedChannels.sort().join("\n")) return false;
    if (expectedChannels.some((channelName) => !Number.isSafeInteger(payload.channelCounts[channelName])
      || payload.channelCounts[channelName] < 0)) return false;
    if (expectedChannels.reduce((total, channelName) => total + payload.channelCounts[channelName], 0) !== payload.totalItems) return false;

    const ids = new Set();
    const videoIds = new Set();
    let previousTimestamp = Number.POSITIVE_INFINITY;
    for (const video of payload.videos) {
      if (!isValidYoutubeVideo(video) || ids.has(video.id) || videoIds.has(video.videoId)) return false;
      const publishedTimestamp = Date.parse(video.publishedAt);
      if (!Number.isFinite(publishedTimestamp) || publishedTimestamp > previousTimestamp) return false;
      previousTimestamp = publishedTimestamp;
      ids.add(video.id);
      videoIds.add(video.videoId);
    }
    return expectedChannels.every((channelName) => payload.videos.filter((video) => video.channelName === channelName).length === payload.channelCounts[channelName]);
  }

  function isValidYoutubeVideo(video) {
    if (!video || typeof video !== "object" || Array.isArray(video)) return false;
    const videoId = String(video.videoId || "");
    return /^[A-Za-z0-9_-]{11}$/u.test(videoId)
      && typeof video.id === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/u.test(video.id)
      && typeof video.title === "string"
      && video.title.trim().length > 0
      && video.title.length <= 2_000
      && YOUTUBE_CHANNEL_NAMES.has(video.channelName)
      && typeof video.publishedAt === "string"
      && /^20\d{2}-\d{2}-\d{2}T/u.test(video.publishedAt)
      && /^20\d{2}-\d{2}-\d{2}$/u.test(String(video.date || ""))
      && video.publishedAt.slice(0, 10) === video.date
      && isAllowedYoutubeVideoUrl(video.url, videoId)
      && isAllowedYoutubeThumbnailUrl(video.thumbnailUrl, videoId);
  }

  function prepareSearchArticle(article) {
    return {
      article,
      searchText: normalizeSearchText(article.title),
    };
  }

  function prepareYoutubeVideo(video) {
    const article = {
      id: video.id,
      title: video.title,
      date: video.date,
      sourceId: "youtube",
      sourceName: video.channelName,
      snippet: "",
      url: video.url,
      thumbnailUrl: video.thumbnailUrl,
      cachedThumbnailUrl: "",
      detailUrl: video.url,
      external: true,
    };
    return {
      article,
      searchText: normalizeSearchText(article.title),
    };
  }

  function findMatchingArticles(articles, tokens) {
    if (!Array.isArray(tokens) || !tokens.length) return [];
    return articles.filter((entry) => tokens.every((token) => entry.searchText.includes(token)));
  }

  function filterArticlesBySource(articles, sourceId) {
    const normalizedSourceId = normalizeSourceId(sourceId);
    return articles.filter((entry) => entry?.article?.sourceId === normalizedSourceId);
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
    if (article.sourceId === "youtube") {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `${article.title || "영상"} YouTube에서 보기`);
    }
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
    if (article?.sourceId === "youtube" && isAllowedYoutubeVideoUrl(article?.url)) return String(article.url);
    const expected = `/news/document?id=${encodeURIComponent(article?.id || "")}`;
    return article?.detailUrl === expected ? expected : expected;
  }

  function resolveArticleImageSources(article) {
    if (article?.sourceId === "youtube") {
      return isAllowedYoutubeThumbnailUrl(article?.thumbnailUrl) ? [String(article.thumbnailUrl)] : [];
    }
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

  function isAllowedYoutubeVideoUrl(value, expectedVideoId = "") {
    try {
      const url = new URL(String(value || ""));
      const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "");
      if (url.protocol !== "https:" || host !== "youtube.com" || url.pathname !== "/watch") return false;
      const videoId = url.searchParams.get("v") || "";
      return /^[A-Za-z0-9_-]{11}$/u.test(videoId) && (!expectedVideoId || videoId === expectedVideoId);
    } catch {
      return false;
    }
  }

  function isAllowedYoutubeThumbnailUrl(value, expectedVideoId = "") {
    try {
      const url = new URL(String(value || ""));
      const host = url.hostname.toLocaleLowerCase("en-US");
      if (url.protocol !== "https:" || !/^(?:i\d*\.)?ytimg\.com$/u.test(host) || url.search || url.hash) return false;
      const match = url.pathname.match(/^\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\/[A-Za-z0-9._-]{1,80}$/u);
      return Boolean(match && (!expectedVideoId || match[1] === expectedVideoId));
    } catch {
      return false;
    }
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
    link.href = buildSearchUrl(currentQuery, page, currentSourceId);
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
      control.href = buildSearchUrl(currentQuery, page, currentSourceId);
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

  function buildSearchUrl(query, page, sourceId = currentSourceId) {
    const parameters = new URLSearchParams({ source: normalizeSourceId(sourceId) });
    const normalizedQuery = String(query || "").trim();
    if (normalizedQuery) parameters.set("q", normalizedQuery);
    const normalizedPage = normalizePageNumber(page);
    if (normalizedQuery && normalizedPage > 1) parameters.set("page", String(normalizedPage));
    const serialized = parameters.toString();
    return `/news/search?${serialized}`;
  }

  function normalizeSourceId(value) {
    const sourceId = String(value || "").trim();
    return SEARCH_SOURCE_IDS.has(sourceId) ? sourceId : "kcna";
  }

  function updateSourceControls() {
    sourceInput.value = currentSourceId;
    for (const tab of sourceTabs) {
      const sourceId = normalizeSourceId(tab.dataset.newsSearchSource);
      const selected = sourceId === currentSourceId;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
      if (selected) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
      tab.href = buildSearchUrl(currentQuery, 1, sourceId);
    }
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
    status.textContent = `${SOURCE_NAMES[currentSourceId]} 제목을 검색하는 중입니다.`;
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

  function updateDocumentTitle(query, sourceId = currentSourceId) {
    const sourceName = SOURCE_NAMES[normalizeSourceId(sourceId)];
    document.title = query
      ? `${query} ${sourceName} 검색 | 북한뉴스아카이브`
      : `${sourceName} 검색 | 북한뉴스아카이브`;
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
