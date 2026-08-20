(function initializeNewsIndex() {
  const board = document.querySelector("#newsBoard");
  const sourceTabs = [...document.querySelectorAll("[data-news-source]")];
  if (!board || !sourceTabs.length) return;

  const FEED_URL = "/data/news-feed.json?v=news-20260821-4";
  const SOURCE_STORAGE_KEY = "nkarchive-news-source";
  const SOURCE_IDS = new Set(["kcna", "rodong-sinmun"]);
  const SECTION_COLUMNS = [
    ["leadership", "important"],
    ["anecdote", "latest"],
    ["memory", "foreign"],
  ];
  const SECTION_DEFINITIONS = {
    kcna: {
      leadership: {
        title: "경애하는 김정은동지의 혁명활동소식",
        limit: 6,
        patterns: [/김정은/u, /총비서/u, /원수님/u],
      },
      important: { title: "중요소식", limit: 2, mode: "latest" },
      anecdote: {
        title: "혁명일화",
        limit: 5,
        patterns: [/사랑/u, /은정/u, /어버이/u, /현지지도/u, /찾으시/u, /참관하시/u, /방문하시/u],
      },
      latest: { title: "최신소식", limit: 6, mode: "latest" },
      memory: {
        title: "인민은 못 잊습니다",
        limit: 5,
        patterns: [/추모/u, /추억/u, /기념/u, /렬사/u, /위훈/u, /궁전/u, /해방/u, /묘/u],
      },
      foreign: {
        title: "대외관계",
        limit: 5,
        patterns: [/외무/u, /대사/u, /대표단/u, /로씨야/u, /중국/u, /윁남/u, /국제/u, /친선/u, /축전/u, /회담/u],
      },
    },
    "rodong-sinmun": {
      leadership: {
        title: "경애하는 김정은동지의 혁명활동소식",
        limit: 6,
        patterns: [/김정은/u, /총비서/u, /원수님/u, /어버이/u],
      },
      important: { title: "오늘호 기사", limit: 2, mode: "latest-day" },
      anecdote: {
        title: "인민을 위한 정치",
        limit: 5,
        patterns: [/인민/u, /이민위천/u, /정책/u, /당대회/u, /멸사복무/u, /복리/u, /은정/u],
      },
      latest: {
        title: "전진하는 조선",
        limit: 6,
        patterns: [/생산/u, /건설/u, /공장/u, /농장/u, /과학기술/u, /경제/u, /전력/u, /혁신/u, /발전/u],
      },
      memory: {
        title: "사회문화생활",
        limit: 5,
        patterns: [/교육/u, /문화/u, /체육/u, /보건/u, /학교/u, /청년/u, /녀성/u, /예술/u, /생활/u, /료리/u],
      },
      foreign: {
        title: "유구한 력사, 찬란한 문화",
        limit: 5,
        patterns: [/력사/u, /유적/u, /문화유산/u, /민족/u, /고구려/u, /고려/u, /고조선/u, /발굴/u, /전통/u, /기념/u],
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
    important: [
      { height: 80, thumbnail: true },
      { height: 80, thumbnail: true },
    ],
    anecdote: Array.from({ length: 5 }, () => ({ height: 40 })),
    latest: [
      { height: 40 },
      { height: 40 },
      { height: 40 },
      { height: 40 },
      { height: 62, thumbnail: true },
      { height: 62 },
    ],
    memory: Array.from({ length: 5 }, () => ({ height: 40 })),
    foreign: [
      { height: 40 },
      { height: 62 },
      { height: 40 },
      { height: 40 },
      { height: 62 },
    ],
  };

  let feed = null;
  let activeSourceId = readStoredSource();

  bindChrome();
  bindSourceTabs();
  updateTabs();
  loadFeed();

  async function loadFeed() {
    try {
      const response = await fetch(FEED_URL, { headers: { Accept: "application/json" } });
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
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLocaleLowerCase("en-US") === "k") {
        event.preventDefault();
        window.location.assign("/search");
      }
    });
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
    writeStoredSource(sourceId);
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
    if (!source || !Array.isArray(source.articles) || !definitions) {
      renderError();
      return;
    }

    const grid = document.createElement("div");
    grid.className = "news-board-grid";
    grid.dataset.source = activeSourceId;

    SECTION_COLUMNS.forEach((sectionIds, columnIndex) => {
      const column = document.createElement("div");
      column.className = "news-column";
      column.dataset.newsColumn = String(columnIndex);
      for (const sectionId of sectionIds) {
        const definition = definitions[sectionId];
        column.append(createSection({
          id: sectionId,
          ...definition,
          articles: selectSectionArticles(source.articles, definition),
        }, source, columnIndex));
      }
      grid.append(column);
    });

    board.replaceChildren(grid);
    board.setAttribute("aria-busy", "false");
    board.setAttribute("aria-label", `${source.name} 기사`);
  }

  function createSection(section, source, columnIndex) {
    const element = document.createElement("section");
    const header = document.createElement("header");
    const rule = document.createElement("img");
    const heading = document.createElement("div");
    const title = document.createElement("h2");
    const more = document.createElement("a");
    const arrow = document.createElement("img");
    const list = document.createElement("div");
    const slots = SECTION_SLOTS[section.id] || [];

    element.className = "news-section";
    element.dataset.section = section.id;
    header.className = "news-section-header";
    rule.className = "news-section-rule";
    rule.src = columnIndex === 0
      ? "/assets/news-section-line-453.svg?v=news-20260821-4"
      : "/assets/news-section-line-454.svg?v=news-20260821-4";
    rule.alt = "";
    heading.className = "news-section-heading";
    title.className = "news-section-title";
    title.textContent = section.title;
    more.className = "news-section-more";
    more.href = createSourceBrowseHref(source.id);
    more.setAttribute("aria-label", `${source.name} ${section.title} 전체 기사 보기`);
    arrow.src = "/assets/news-arrow-forward-ios.svg?v=news-20260821-4";
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
    const imageSources = slot.thumbnail ? resolveArticleImageSources(article) : [];

    item.className = `news-article news-slot-${slot.height}${imageSources.length ? " has-thumbnail" : ""}`;
    link.className = "news-article-link";
    link.href = article.detailUrl || `/news/document?id=${encodeURIComponent(article.id || "")}`;
    copy.className = "news-article-copy";
    title.className = "news-article-title";
    appendHighlightedTitle(title, article.title || "기사");
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
    const sorted = [...articles].sort(compareArticlesNewestFirst);
    if (definition.mode === "latest") return sorted.slice(0, definition.limit);
    if (definition.mode === "latest-day") {
      const newestDate = sorted[0]?.date || "";
      return sorted.filter((article) => article.date === newestDate).slice(0, definition.limit);
    }

    const scored = sorted
      .map((article) => ({ article, score: scoreArticle(article, definition.patterns || []) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || compareArticlesNewestFirst(left.article, right.article))
      .map(({ article }) => article);
    return scored.slice(0, definition.limit);
  }

  function resolveArticleImageSources(article) {
    const sources = [];
    const cachedSource = resolveCachedImageSource(article?.cachedThumbnailUrl);
    const originalSource = resolveOriginalImageSource(article?.thumbnailUrl);
    if (cachedSource) sources.push(cachedSource);
    if (originalSource && !sources.includes(originalSource)) sources.push(originalSource);
    return sources;
  }

  function resolveCachedImageSource(value) {
    const candidate = normalizeImageCandidate(value);
    if (!candidate) return "";
    if (/^\/(?:data\/search\/assets|cached\/search-assets|api\/search-asset)(?:\/|\?)/u.test(candidate)) {
      return candidate;
    }
    if (/^https:\/\//iu.test(candidate)) return candidate;
    if (/^http:\/\//iu.test(candidate)) return createAssetProxyUrl(candidate);
    return "";
  }

  function resolveOriginalImageSource(value) {
    const candidate = normalizeImageCandidate(value);
    return /^https?:\/\//iu.test(candidate) ? createAssetProxyUrl(candidate) : "";
  }

  function normalizeImageCandidate(value) {
    const candidate = String(value || "").trim();
    if (!candidate || /\/newsf\.gif(?:$|[?#])/iu.test(candidate)) return "";
    return candidate;
  }

  function createAssetProxyUrl(value) {
    return `/api/search-asset?url=${encodeURIComponent(value)}`;
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

  function scoreArticle(article, patterns) {
    const title = String(article.title || "");
    const snippet = String(article.snippet || "");
    return patterns.reduce((score, pattern) => score + (pattern.test(title) ? 4 : 0) + (pattern.test(snippet) ? 1 : 0), 0);
  }

  function compareArticlesNewestFirst(left, right) {
    return String(right?.date || "").localeCompare(String(left?.date || ""))
      || String(left?.id || "").localeCompare(String(right?.id || ""));
  }

  function appendHighlightedTitle(parent, value) {
    for (const part of String(value || "").split(/(김정은)/u)) {
      if (!part) continue;
      if (part === "김정은") {
        const strong = document.createElement("strong");
        strong.textContent = part;
        parent.append(strong);
      } else {
        parent.append(document.createTextNode(part));
      }
    }
  }

  function createSourceBrowseHref(sourceId) {
    const params = new URLSearchParams({ source: sourceId, lang: "ko", sort: "latest" });
    return `/search/results?${params.toString()}`;
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

  function readStoredSource() {
    try {
      const stored = localStorage.getItem(SOURCE_STORAGE_KEY);
      return SOURCE_IDS.has(stored) ? stored : "kcna";
    } catch {
      return "kcna";
    }
  }

  function writeStoredSource(sourceId) {
    try {
      localStorage.setItem(SOURCE_STORAGE_KEY, sourceId);
    } catch {
      // The in-memory selection still works when storage is unavailable.
    }
  }

  function isValidFeed(value) {
    return value && typeof value === "object"
      && typeof value.version === "string"
      && value.version.length > 0
      && value.sources
      && [...SOURCE_IDS].every((sourceId) => Array.isArray(value.sources[sourceId]?.articles));
  }

  function renderError() {
    const message = document.createElement("div");
    message.className = "news-empty";
    message.textContent = "뉴스 아카이브를 불러오지 못했습니다.";
    board.replaceChildren(message);
    board.setAttribute("aria-busy", "false");
  }
})();
