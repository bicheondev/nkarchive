(function initializeNewsIndex() {
  const board = document.querySelector("#newsBoard");
  const sourceTabs = [...document.querySelectorAll("[data-news-source]")];
  if (!board || !sourceTabs.length) return;

  const FEED_URL = "/data/news-feed.json";
  const SOURCE_IDS = new Set(["kcna", "rodong-sinmun"]);
  const SECTION_COLUMNS = {
    kcna: [
      ["leadership", "important", "international", "photo"],
      ["anecdote", "document", "foreign", "video"],
      ["memory", "domestic", "social"],
    ],
    "rodong-sinmun": [
      ["leadership", "important", "photo"],
      ["anecdote", "domestic", "video"],
      ["memory", "social"],
    ],
  };
  const SECTION_DEFINITIONS = {
    kcna: {
      leadership: {
        title: "경애하는 김정은동지의 혁명활동소식",
        limit: 6,
      },
      important: {
        title: "중요소식",
        limit: 6,
      },
      international: {
        title: "국제소식",
        limit: 2,
      },
      photo: {
        title: "사진",
        limit: 5,
        media: "image",
      },
      anecdote: {
        title: "혁명일화",
        limit: 5,
      },
      document: {
        title: "문건",
        limit: 6,
      },
      foreign: {
        title: "대외관계",
        limit: 6,
      },
      video: {
        title: "동화상",
        limit: 5,
        media: "video",
      },
      memory: {
        title: "인민은 못 잊습니다",
        limit: 5,
      },
      domestic: {
        title: "국내소식",
        limit: 5,
      },
      social: {
        title: "사회생활",
        limit: 5,
      },
    },
    "rodong-sinmun": {
      leadership: {
        title: "경애하는 김정은동지의 혁명활동소식",
        limit: 6,
      },
      important: { title: "오늘호 기사", limit: 6 },
      anecdote: {
        title: "인민을 위한 정치",
        limit: 5,
      },
      photo: {
        title: "사진",
        limit: 5,
        media: "image",
      },
      video: {
        title: "동영상",
        limit: 5,
        media: "video",
      },
      memory: {
        title: "사회문화생활",
        limit: 5,
      },
      domestic: {
        title: "전진하는 조선",
        limit: 5,
      },
      social: {
        title: "유구한 력사,찬란한 문화",
        limit: 5,
      },
    },
  };
  const SECTION_SLOTS = {
    leadership: [
      { height: 62, thumbnail: true },
      { height: 62, thumbnail: true },
      { height: 62 },
      { height: 40 },
      { height: 62, thumbnail: true },
      { height: 62, thumbnail: true },
    ],
    important: Array.from({ length: 6 }, () => ({ height: 80, thumbnail: true })),
    international: [
      { height: 80, thumbnail: true },
      { height: 80, thumbnail: true },
    ],
    photo: Array.from({ length: 5 }, () => ({ height: 80, thumbnail: true })),
    anecdote: Array.from({ length: 5 }, () => ({ height: 40 })),
    document: [
      { height: 40 },
      { height: 40 },
      { height: 40 },
      { height: 40 },
      { height: 62, thumbnail: true },
      { height: 62 },
    ],
    foreign: [
      { height: 40 },
      { height: 40 },
      { height: 40 },
      { height: 40 },
      { height: 62, thumbnail: true },
      { height: 62 },
    ],
    video: Array.from({ length: 5 }, () => ({ height: 62, thumbnail: true })),
    memory: Array.from({ length: 5 }, () => ({ height: 40 })),
    domestic: [
      { height: 40 },
      { height: 62 },
      { height: 40 },
      { height: 40 },
      { height: 62 },
    ],
    social: [
      { height: 40 },
      { height: 62 },
      { height: 40 },
      { height: 40 },
      { height: 62 },
    ],
  };

  let feed = null;
  let activeSourceId = "kcna";

  bindChrome();
  bindSourceTabs();
  updateTabs();
  loadFeed();

  async function loadFeed() {
    try {
    const response = await fetch(FEED_URL, { cache: "no-cache", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`news_feed_${response.status}`);
      const nextFeed = await response.json();
      if (!isValidFeed(nextFeed)) throw new Error("invalid_news_feed");
      feed = nextFeed;
      board.dataset.generatedAt = String(feed.generatedAt || "");
      renderActiveSource();
    } catch (error) {
      console.error("[news] Unable to load the news snapshot.", error);
      renderError();
    }
  }

  function bindChrome() {
    const toggle = document.querySelector("#newsMenuToggle");
    const navigation = document.querySelector(".news-navigation");
    const searchInput = document.querySelector("#newsSearchInput");
    searchInput?.addEventListener("input", () => applyNewsFilter(searchInput.value));
    searchInput?.addEventListener("search", () => applyNewsFilter(searchInput.value));
    if (window.location.hash === "#search") {
      requestAnimationFrame(() => searchInput?.focus());
    }
    toggle?.addEventListener("click", () => {
      const nextOpen = !document.body.classList.contains("news-menu-open");
      document.body.classList.toggle("news-menu-open", nextOpen);
      toggle.setAttribute("aria-expanded", String(nextOpen));
    });
    document.addEventListener("click", (event) => {
      if (!document.body.classList.contains("news-menu-open")) return;
      if (navigation?.contains(event.target)) return;
      document.body.classList.remove("news-menu-open");
      toggle?.setAttribute("aria-expanded", "false");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        document.body.classList.remove("news-menu-open");
        toggle?.setAttribute("aria-expanded", "false");
        if (document.activeElement === searchInput || searchInput?.value) {
          searchInput.value = "";
          applyNewsFilter("");
          searchInput?.blur();
        }
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLocaleLowerCase("en-US") === "k") {
        event.preventDefault();
        searchInput?.focus();
        searchInput?.select();
      }
    });
  }

  function applyNewsFilter(value) {
    const query = normalizeFilterText(value);
    for (const section of board.querySelectorAll(".news-section")) {
      let visibleCount = 0;
      for (const article of section.querySelectorAll(".news-article")) {
        const matches = !query || normalizeFilterText(article.textContent).includes(query);
        article.hidden = !matches;
        if (matches) visibleCount += 1;
      }
      section.hidden = Boolean(query) && visibleCount === 0;
    }
  }

  function normalizeFilterText(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("ko-KR");
  }

  function bindSourceTabs() {
    for (const tab of sourceTabs) {
      tab.addEventListener("click", () => selectSource(tab.dataset.newsSource));
      tab.addEventListener("keydown", handleTabKeydown);
    }
  }

  function selectSource(sourceId, { focus = false } = {}) {
    if (!SOURCE_IDS.has(sourceId)) return;
    activeSourceId = sourceId;
    updateTabs();
    if (feed) renderActiveSource();
    if (focus) getActiveTab()?.focus();
  }

  function updateTabs() {
    for (const tab of sourceTabs) {
      const isActive = tab.dataset.newsSource === activeSourceId;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
      tab.tabIndex = isActive ? 0 : -1;
      if (isActive) board.setAttribute("aria-labelledby", tab.id);
    }
  }

  function renderActiveSource() {
    const source = feed?.sources?.[activeSourceId];
    const definitions = SECTION_DEFINITIONS[activeSourceId];
    const sectionColumns = SECTION_COLUMNS[activeSourceId];
    if (!source || !Array.isArray(source.articles) || !definitions || !sectionColumns) {
      renderError();
      return;
    }

    const grid = document.createElement("div");
    grid.className = "news-board-grid";
    grid.dataset.source = activeSourceId;

    sectionColumns.forEach((sectionIds, columnIndex) => {
      const column = document.createElement("div");
      column.className = "news-column";
      column.dataset.newsColumn = String(columnIndex);
      for (const sectionId of sectionIds) {
        const definition = definitions[sectionId];
        column.append(createSection({
          id: sectionId,
          ...definition,
          articles: selectSectionArticles(source.articles, { ...definition, category: sectionId }),
        }, source, columnIndex));
      }
      grid.append(column);
    });

    board.replaceChildren(grid);
    applyNewsFilter(document.querySelector("#newsSearchInput")?.value || "");
    board.setAttribute("aria-busy", "false");
    board.setAttribute("aria-label", `${source.name} 기사`);
  }

  function createSection(section, source, columnIndex) {
    const element = document.createElement("section");
    const header = document.createElement("header");
    const rule = document.createElement("img");
    const heading = document.createElement("a");
    const title = document.createElement("h2");
    const more = document.createElement("span");
    const arrow = document.createElement("img");
    const list = document.createElement("div");
    const slots = SECTION_SLOTS[section.id] || [];

    element.className = "news-section";
    element.dataset.section = section.id;
    header.className = "news-section-header";
    rule.className = "news-section-rule";
    rule.src = columnIndex === 0
      ? "/assets/news-section-line-453.svg?v=news-20260822-1"
      : "/assets/news-section-line-454.svg?v=news-20260822-1";
    rule.alt = "";
    heading.className = "news-section-heading";
    heading.href = `/news/category?source=${encodeURIComponent(source.id)}&section=${encodeURIComponent(section.id)}`;
    heading.setAttribute("aria-label", `${source.name} ${section.title} 전체 기사 보기`);
    title.className = "news-section-title";
    title.textContent = section.title;
    more.className = "news-section-more";
    more.setAttribute("aria-hidden", "true");
    arrow.src = "/assets/news-arrow-forward-ios.svg?v=news-20260822-1";
    arrow.alt = "";
    arrow.width = 24;
    arrow.height = 24;
    more.append(arrow);
    heading.append(title, more);
    header.append(rule, heading);

    list.className = "news-list";
    slots.forEach((slot, index) => {
      const article = section.articles[index];
      if (article) list.append(createArticle(article, slot));
    });

    element.append(header, list);
    return element;
  }

  function createArticle(article, slot) {
    const item = document.createElement("article");
    const link = document.createElement("a");
    const copy = document.createElement("div");
    const title = document.createElement("p");
    const date = document.createElement("p");
    const imageSources = resolveArticleImageSources(article);

    item.className = `news-article news-slot-${slot.height}${imageSources.length ? " has-thumbnail" : ""}`;
    link.className = "news-article-link";
    link.href = article.detailUrl || `/news/document?id=${encodeURIComponent(article.id || "")}`;
    copy.className = "news-article-copy";
    title.className = "news-article-title";
    title.textContent = article.title || "기사";
    date.className = "news-article-date";
    date.textContent = formatCompactDate(article.date);
    copy.append(title, date);
    link.append(copy);

    if (imageSources.length) {
      const figure = document.createElement("div");
      const image = document.createElement("img");
      figure.className = "news-article-thumbnail";
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      loadFirstAvailableImage(image, imageSources, () => {
        figure.remove();
        item.classList.remove("has-thumbnail");
      });
      figure.append(image);
      link.append(figure);
    }

    item.append(link);
    return item;
  }

  function selectSectionArticles(articles, definition) {
    const sorted = [...articles].sort((left, right) => (
      compareArticlesNewestFirst(left, right, definition.category)
    ));
    const categorized = sorted.filter((article) => (
      Array.isArray(article?.featuredSections) && article.featuredSections.includes(definition.category)
    ));
    return categorized.slice(0, definition.limit);
  }

  function resolveArticleImageSources(article) {
    const sources = [];
    const cachedSource = resolveCachedImageSource(article?.cachedThumbnailUrl);
    if (cachedSource) sources.push(cachedSource);
    const remoteSource = resolveNewsImageProxySource(article?.thumbnailUrl, article?.url);
    if (remoteSource && !sources.includes(remoteSource)) sources.push(remoteSource);
    return sources;
  }

  function resolveCachedImageSource(value) {
    const candidate = normalizeImageCandidate(value);
    if (!candidate) return "";
    if (/^\/data\/news\/assets\/(?:kcna|rodong-sinmun)\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u.test(candidate)) {
      return candidate;
    }
    return "";
  }

  function normalizeImageCandidate(value) {
    const candidate = String(value || "").trim();
    if (!candidate || /\/newsf\.gif(?:$|[?#])/iu.test(candidate)) return "";
    return candidate;
  }

  function resolveNewsImageProxySource(value, refererValue) {
    const candidate = normalizeImageCandidate(value);
    if (!isAllowedOfficialNewsImageUrl(candidate)) return "";
    const parameters = new URLSearchParams({ url: candidate });
    if (isAllowedOfficialNewsRefererUrl(refererValue, candidate)) parameters.set("referer", String(refererValue));
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

  function isAllowedOfficialNewsRefererUrl(value, imageValue) {
    try {
      const referer = new URL(String(value || ""));
      const image = new URL(imageValue);
      return referer.origin === image.origin || (
        referer.protocol === image.protocol
        && referer.hostname.replace(/^www\./u, "") === image.hostname.replace(/^www\./u, "")
        && referer.port === image.port
      );
    } catch {
      return false;
    }
  }

  function loadFirstAvailableImage(image, sources, onFailure) {
    let sourceIndex = 0;
    const tryNextSource = () => {
      if (sourceIndex >= sources.length) {
        image.removeAttribute("src");
        onFailure();
        return;
      }
      image.src = sources[sourceIndex];
      sourceIndex += 1;
    };
    image.addEventListener("error", tryNextSource);
    tryNextSource();
  }

  function compareArticlesNewestFirst(left, right, sectionId = "") {
    return String(right?.date || "").localeCompare(String(left?.date || ""))
      || compareOfficialCategoryOrder(left, right, sectionId)
      || String(left?.id || "").localeCompare(String(right?.id || ""));
  }

  function compareOfficialCategoryOrder(left, right, sectionId) {
    const leftOrder = left?.categoryOrders?.[sectionId];
    const rightOrder = right?.categoryOrders?.[sectionId];
    const normalizedLeft = Number.isSafeInteger(leftOrder) && leftOrder >= 0
      ? leftOrder
      : Number.MAX_SAFE_INTEGER;
    const normalizedRight = Number.isSafeInteger(rightOrder) && rightOrder >= 0
      ? rightOrder
      : Number.MAX_SAFE_INTEGER;
    return normalizedLeft - normalizedRight;
  }

  function formatCompactDate(value) {
    const match = String(value || "").match(/^(20\d{2})-(\d{2})-(\d{2})$/u);
    return match ? `${match[1]}.${match[2]}.${match[3]}.` : String(value || "");
  }

  function handleTabKeydown(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const activeIndex = Math.max(0, sourceTabs.indexOf(getActiveTab()));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? sourceTabs.length - 1
        : (activeIndex + (event.key === "ArrowRight" ? 1 : -1) + sourceTabs.length) % sourceTabs.length;
    selectSource(sourceTabs[nextIndex].dataset.newsSource, { focus: true });
  }

  function getActiveTab() {
    return sourceTabs.find((tab) => tab.dataset.newsSource === activeSourceId) || sourceTabs[0];
  }

  function isValidFeed(value) {
    return value && typeof value === "object"
      && typeof value.version === "string"
      && value.version.length > 0
      && value.sources
      && [...SOURCE_IDS].every((sourceId) => {
        const source = value.sources[sourceId];
        return Array.isArray(source?.articles)
          && Number.isSafeInteger(source.totalItems)
          && source.totalItems >= source.articles.length
          && source.categoryCounts
          && typeof source.categoryCounts === "object";
      });
  }

  function renderError() {
    const message = document.createElement("div");
    message.className = "news-empty";
    message.textContent = "뉴스 아카이브를 불러오지 못했습니다.";
    board.replaceChildren(message);
    board.setAttribute("aria-busy", "false");
  }
})();
