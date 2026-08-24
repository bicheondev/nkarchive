(function initializeNewsCategory() {
  const title = document.querySelector("#newsCategoryTitle");
  const list = document.querySelector("#newsCategoryList");
  const pagination = document.querySelector("#newsCategoryPagination");
  const searchSource = document.querySelector("#newsCategorySearchSource");
  if (!title || !list || !pagination) return;

  const CATEGORY_ROOT_URL = "/data/news/categories";
  const LATEST_NEWS_URL = "/api/news-latest";
  const PAGE_SIZE = 5;
  const PAGE_WINDOW = 5;
  const SOURCE_DEFINITIONS = Object.freeze({
    kcna: {
      name: "조선중앙통신",
      sections: {
        leadership: "혁명활동소식",
        important: "중요소식",
        international: "국제소식",
        photo: "사진",
        anecdote: "혁명일화",
        document: "문건",
        foreign: "대외관계",
        video: "동화상",
        memory: "인민은 못 잊습니다",
        domestic: "국내소식",
        social: "사회생활",
      },
    },
    "rodong-sinmun": {
      name: "로동신문",
      sections: {
        leadership: "혁명활동소식",
        important: "오늘호 기사",
        photo: "사진",
        anecdote: "인민을 위한 정치",
        video: "동영상",
        memory: "사회문화생활",
        domestic: "전진하는 조선",
        social: "유구한 력사,찬란한 문화",
      },
    },
  });

  const context = readCategoryContext();
  let currentPage = context?.page || 1;
  let totalPages = 1;

  if (!context) {
    renderError("카테고리를 찾을 수 없습니다.");
    return;
  }

  title.textContent = context.sectionTitle;
  if (searchSource) searchSource.value = context.sourceId;
  document.title = `${context.sectionTitle} | 북한뉴스아카이브`;
  list.dataset.source = context.sourceId;
  list.dataset.section = context.sectionId;
  loadCategoryPage();

  async function loadCategoryPage() {
    try {
      const pageUrl = buildCategoryDataUrl(context, currentPage);
      const response = await fetch(pageUrl, {
        cache: "no-cache",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`news_category_${response.status}`);
      const payload = await response.json();
      if (!isValidCategoryPage(payload, context, currentPage)) throw new Error("invalid_news_category");

      currentPage = payload.page;
      totalPages = payload.totalPages;
      list.dataset.generatedAt = String(payload.generatedAt || "");
      renderArticles(payload.articles);
      renderPagination(totalPages);
      if (currentPage === 1) void refreshLatestCategory(payload.articles);
    } catch (error) {
      console.error("[news/category] Unable to load the category page.", error);
      renderError("뉴스 아카이브를 불러오지 못했습니다.");
    }
  }

  async function refreshLatestCategory(staticArticles) {
    try {
      const response = await fetch(`${LATEST_NEWS_URL}?source=${context.sourceId}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`news_category_latest_${response.status}`);
      const payload = await response.json();
      const source = payload?.sources?.[context.sourceId];
      if (!isValidLatestSource(payload, source)) throw new Error("invalid_news_category_latest");
      const latestArticles = source.articles.filter((article) => (
        article.featuredSections.includes(context.sectionId)
        || article.categories.includes(context.sectionId)
      )).sort(compareLatestCategoryArticles);
      renderArticles(mergeLatestCategoryArticles(staticArticles, latestArticles, source.mode));
      list.dataset.latestCheckedAt = payload.generatedAt;
      list.dataset.latestMode = source.mode;
    } catch (error) {
      console.warn("[news/category] Live freshness check failed; keeping the published page.", error);
    }
  }

  function buildCategoryDataUrl(category, page) {
    return `${CATEGORY_ROOT_URL}/${encodeURIComponent(category.sourceId)}/${encodeURIComponent(category.sectionId)}/page-${page}.json`;
  }

  function isValidCategoryPage(payload, category, requestedPage) {
    const hasValidShape = Boolean(payload && typeof payload === "object"
      && typeof payload.version === "string"
      && payload.version.length > 0
      && payload.source?.id === category.sourceId
      && payload.section === category.sectionId
      && payload.pageSize === PAGE_SIZE
      && payload.page === requestedPage
      && Number.isSafeInteger(payload.totalItems)
      && payload.totalItems >= 0
      && Number.isSafeInteger(payload.totalPages)
      && payload.totalPages >= 1
      && Array.isArray(payload.articles)
      && payload.articles.length <= PAGE_SIZE);
    if (!hasValidShape) return false;
    const expectedTotalPages = Math.max(1, Math.ceil(payload.totalItems / PAGE_SIZE));
    const expectedItemsOnPage = Math.max(0, Math.min(
      PAGE_SIZE,
      payload.totalItems - ((payload.page - 1) * PAGE_SIZE),
    ));
    return payload.totalPages === expectedTotalPages
      && payload.page <= payload.totalPages
      && payload.articles.length === expectedItemsOnPage;
  }

  function readCategoryContext() {
    const parameters = new URLSearchParams(window.location.search);
    const sourceId = parameters.get("source") || "";
    const sectionId = parameters.get("section") || "";
    const page = normalizePageNumber(parameters.get("page"));
    const source = SOURCE_DEFINITIONS[sourceId];
    const sectionTitle = source?.sections?.[sectionId];
    if (!source || !sectionTitle) return null;
    return { sourceId, sectionId, sectionTitle, sourceName: source.name, page };
  }

  function renderArticles(articles) {
    const fragment = document.createDocumentFragment();
    for (const article of articles) fragment.append(createArticle(article));
    list.replaceChildren(fragment);
    list.setAttribute("aria-busy", "false");
    list.setAttribute("aria-label", `${context.sourceName} ${context.sectionTitle} 기사`);
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
        const link = document.createElement("a");
        link.className = "news-category-page-number";
        link.href = buildPageUrl(page);
        link.setAttribute("aria-label", `${page}페이지`);
        link.textContent = String(page);
        pagination.append(link);
      }
    }
    pagination.append(createPaginationArrow(currentPage + 1, "다음 페이지", currentPage === totalPages, true));
  }

  function createPaginationArrow(page, label, disabled, next = false) {
    const control = document.createElement(disabled ? "span" : "a");
    const image = document.createElement("img");
    control.className = "news-category-page-arrow";
    control.setAttribute("aria-label", label);
    if (disabled) control.setAttribute("aria-disabled", "true");
    else control.href = buildPageUrl(page);
    image.className = `news-category-page-arrow-icon${next ? " next" : ""}`;
    image.src = "/assets/news-pagination-arrow-left.svg?v=news-20260822-1";
    image.alt = "";
    control.append(image);
    return control;
  }

  function buildPageUrl(page) {
    const parameters = new URLSearchParams({
      source: context.sourceId,
      section: context.sectionId,
      page: String(page),
    });
    return `/news/category?${parameters.toString()}`;
  }

  function getPaginationRange(page, totalPages) {
    const visibleCount = Math.min(PAGE_WINDOW, totalPages);
    const maximumStart = Math.max(1, totalPages - visibleCount + 1);
    const start = Math.min(Math.max(1, page - Math.floor(visibleCount / 2)), maximumStart);
    return Array.from({ length: visibleCount }, (_, index) => start + index);
  }

  function createArticle(article) {
    const item = document.createElement("article");
    const link = document.createElement("a");
    const copy = document.createElement("div");
    const articleTitle = document.createElement("h2");
    const date = document.createElement("time");
    const imageSources = resolveArticleImageSources(article, context.sourceId);

    item.className = "news-category-row";
    item.setAttribute("role", "listitem");
    link.className = "news-category-row-link";
    link.href = resolveDetailUrl(article);
    if (article?.archived === false) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    copy.className = "news-category-copy";
    articleTitle.className = "news-category-row-title";
    articleTitle.textContent = article?.title || "기사";
    date.className = "news-category-row-date";
    date.dateTime = String(article?.date || "");
    date.textContent = formatLongDate(article?.date);
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
    const candidate = String(article?.detailUrl || "").trim();
    if (article?.archived === false && isOfficialArticleUrl(context.sourceId, candidate)) return candidate;
    const expected = `/news/document?id=${encodeURIComponent(article?.id || "")}`;
    return expected;
  }

  function isValidLatestSource(payload, source) {
    return payload?.schemaVersion === 1
      && typeof payload.generatedAt === "string"
      && source?.id === context.sourceId
      && ["live", "degraded", "fallback"].includes(source.mode)
      && Array.isArray(source.articles)
      && source.articles.length <= 256
      && source.articles.every((article) => isValidLatestArticle(article, context.sourceId));
  }

  function isValidLatestArticle(article, sourceId) {
    const id = String(article?.id || "");
    const detailUrl = String(article?.detailUrl || "");
    const expectedDetailUrl = `/news/document?id=${encodeURIComponent(id)}`;
    const validDetailUrl = article?.archived === false
      ? detailUrl === article.url && isOfficialArticleUrl(sourceId, detailUrl)
      : detailUrl === expectedDetailUrl;
    return article?.sourceId === sourceId
      && isValidPublishedIdForSource(id, sourceId)
      && typeof article.title === "string"
      && article.title.trim().length > 0
      && /^20\d{2}-\d{2}-\d{2}$/u.test(String(article.date || ""))
      && isOfficialArticleUrl(sourceId, article.url)
      && typeof article.archived === "boolean"
      && Array.isArray(article.categories)
      && Array.isArray(article.featuredSections)
      && validDetailUrl;
  }

  function isValidPublishedIdForSource(id, sourceId) {
    if (/^news:(?:kcna|rodong-sinmun):[a-f0-9]{24}$/u.test(id)) return id.startsWith(`news:${sourceId}:`);
    return sourceId === "kcna" && /^kcna-[a-f0-9]{16}$/u.test(id);
  }

  function isOfficialArticleUrl(sourceId, value) {
    try {
      const url = new URL(String(value || ""));
      if (url.username || url.password || url.port) return false;
      if (sourceId === "kcna") {
        return url.origin === "http://www.kcna.kp"
          && /^\/kp\/(?:article|gallery|video)\/detail\/[a-f0-9]{32}$/u.test(url.pathname)
          && !url.search;
      }
      return sourceId === "rodong-sinmun"
        && url.origin === "http://www.rodong.rep.kp"
        && url.pathname === "/ko/index.php"
        && /^\?[A-Za-z0-9+/]+={0,2}$/u.test(url.search);
    } catch {
      return false;
    }
  }

  function compareLatestCategoryArticles(left, right) {
    const leftOrder = left?.categoryOrders?.[context.sectionId];
    const rightOrder = right?.categoryOrders?.[context.sectionId];
    return String(right?.date || "").localeCompare(String(left?.date || ""))
      || (Number.isSafeInteger(leftOrder) ? leftOrder : Number.MAX_SAFE_INTEGER)
        - (Number.isSafeInteger(rightOrder) ? rightOrder : Number.MAX_SAFE_INTEGER)
      || String(left?.id || "").localeCompare(String(right?.id || ""));
  }

  function mergeLatestCategoryArticles(staticArticles, latestArticles, mode) {
    const publishedRows = Array.isArray(staticArticles) ? staticArticles.slice(0, PAGE_SIZE) : [];
    if (mode === "fallback") return publishedRows;
    const staticUrls = new Set(publishedRows.map((article) => String(article?.url || "")));
    const latestByUrl = new Map(latestArticles.map((article) => [String(article?.url || ""), article]));
    const newcomers = latestArticles.filter((article) => (
      article?.archived === false && !staticUrls.has(String(article?.url || ""))
    ));
    const refreshedStatic = publishedRows.map((article) => (
      latestByUrl.get(String(article?.url || "")) || article
    ));
    const seenUrls = new Set();
    return [...newcomers, ...refreshedStatic]
      .filter((article) => {
        const url = String(article?.url || "");
        if (!url || seenUrls.has(url)) return false;
        seenUrls.add(url);
        return true;
      })
      .sort(compareLatestCategoryArticles)
      .slice(0, PAGE_SIZE);
  }

  function resolveCachedImageSource(value, sourceId) {
    const candidate = String(value || "").trim();
    const prefix = `/data/news/assets/${sourceId}/`;
    if (!candidate.startsWith(prefix)) return "";
    const fileName = candidate.slice(prefix.length);
    return /^[a-f0-9]{64}\.(?:jpe?g|png|gif|webp)$/u.test(fileName) ? candidate : "";
  }

  function resolveArticleImageSources(article, sourceId) {
    const sources = [];
    const cachedSource = resolveCachedImageSource(article?.cachedThumbnailUrl, sourceId);
    if (cachedSource) sources.push(cachedSource);
    const remoteSource = resolveNewsImageProxySource(article?.thumbnailUrl, article?.url);
    if (remoteSource && !sources.includes(remoteSource)) sources.push(remoteSource);
    return sources;
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

  function formatLongDate(value) {
    const match = String(value || "").match(/^(20\d{2})-(\d{2})-(\d{2})$/u);
    return match ? `${match[1]}년 ${Number(match[2])}월 ${Number(match[3])}일` : String(value || "");
  }

  function normalizePageNumber(value) {
    const candidate = String(value || "").trim();
    if (!/^[1-9]\d{0,5}$/u.test(candidate)) return 1;
    return Number(candidate);
  }

  function renderEmpty(message) {
    const empty = document.createElement("p");
    empty.className = "news-category-empty";
    empty.textContent = message;
    list.replaceChildren(empty);
    list.setAttribute("aria-busy", "false");
    pagination.replaceChildren();
    pagination.hidden = true;
  }

  function renderError(message) {
    const empty = document.createElement("p");
    const back = document.createElement("a");
    empty.className = "news-category-empty";
    empty.append(document.createTextNode(`${message} `));
    back.href = "/news";
    back.textContent = "뉴스로 돌아가기";
    empty.append(back);
    list.replaceChildren(empty);
    list.setAttribute("aria-busy", "false");
    pagination.replaceChildren();
    pagination.hidden = true;
  }
})();
