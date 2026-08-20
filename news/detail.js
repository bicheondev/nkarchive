(function initializeNewsDocument() {
  const documentRoot = document.querySelector("#newsDocument");
  const titleElement = document.querySelector("#newsDocumentTitle");
  const sourceElement = document.querySelector("#newsDocumentSource");
  const dateElement = document.querySelector("#newsDocumentDate");
  const bodyElement = document.querySelector("#newsDocumentBody");
  const imageElement = document.querySelector("#newsDocumentImage");
  if (!documentRoot || !titleElement || !sourceElement || !dateElement || !bodyElement || !imageElement) return;

  const params = new URLSearchParams(window.location.search);
  const articleId = params.get("id") || "";
  const requestedVersion = params.get("v") || "news-20260821-3";
  const DETAILS_URL = `/data/news-details.json?v=${encodeURIComponent(requestedVersion)}`;
  const FALLBACK_IMAGE = "/assets/news-detail-hero.webp?v=news-20260821-3";

  bindChrome();
  loadArticle();

  async function loadArticle() {
    if (!articleId) {
      renderError("기사 주소가 올바르지 않습니다.");
      return;
    }

    try {
      const response = await fetch(DETAILS_URL, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`news_details_${response.status}`);
      const payload = await response.json();
      if (params.has("v") && payload?.version !== requestedVersion) {
        throw new Error("news_snapshot_mismatch");
      }
      if (!payload?.articles || !Object.hasOwn(payload.articles, articleId)) {
        renderError("보관된 기사를 찾지 못했습니다.");
        return;
      }
      const article = payload.articles[articleId];
      renderArticle(article);
    } catch (error) {
      console.error("[news] Unable to load the archived article.", error);
      renderError("기사를 불러오지 못했습니다.");
    }
  }

  function renderArticle(article) {
    const title = String(article.title || "뉴스 기사");
    const body = String(article.body || article.snippet || "").trim();
    titleElement.textContent = title;
    sourceElement.textContent = article.sourceName || sourceNameForId(article.sourceId);
    dateElement.textContent = formatKoreanDate(article.date);
    document.title = `${title} · 북한뉴스아카이브`;

    const paragraphs = splitParagraphs(body);
    bodyElement.replaceChildren(
      ...paragraphs.map((paragraphText) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = paragraphText;
        return paragraph;
      }),
    );

    const heroSource = resolveHeroSource(article);
    imageElement.alt = heroSource ? title : "";
    imageElement.addEventListener("error", () => {
      if (!imageElement.src.endsWith("/assets/news-detail-hero.webp?v=news-20260821-3")) {
        imageElement.alt = "";
        imageElement.src = FALLBACK_IMAGE;
      }
    }, { once: true });
    imageElement.src = heroSource || FALLBACK_IMAGE;
    documentRoot.setAttribute("aria-busy", "false");
  }

  function splitParagraphs(value) {
    const normalized = String(value || "")
      .replace(/\r\n?/gu, "\n")
      .replace(/[\u200b\ufeff]/gu, "")
      .trim();
    if (!normalized) return ["본문이 보관되지 않은 기사입니다."];
    const blocks = normalized
      .split(/\n+/u)
      .map((block) => block.trim())
      .filter(Boolean);
    return blocks.length ? blocks : [normalized];
  }

  function resolveHeroSource(article) {
    const candidate = String(article.cachedThumbnailUrl || article.thumbnailUrl || "").trim();
    if (!candidate || /\/newsf\.gif(?:$|\?)/iu.test(candidate)) return "";
    if (candidate.startsWith("/")) return candidate;
    if (!/^https?:\/\//iu.test(candidate)) return "";
    return `/api/search-asset?url=${encodeURIComponent(candidate)}`;
  }

  function formatKoreanDate(value) {
    const match = String(value || "").match(/^(20\d{2})-(\d{2})-(\d{2})$/u);
    if (!match) return String(value || "");
    return `${match[1]}년 ${Number(match[2])}월 ${Number(match[3])}일`;
  }

  function sourceNameForId(sourceId) {
    return sourceId === "rodong-sinmun" ? "로동신문" : "조선중앙통신";
  }

  function renderError(messageText) {
    const error = document.createElement("div");
    const message = document.createElement("h1");
    const back = document.createElement("a");
    error.className = "news-document-error";
    error.setAttribute("role", "status");
    error.tabIndex = -1;
    message.textContent = messageText;
    back.href = "/news";
    back.textContent = "뉴스 목록으로 돌아가기";
    error.append(message, back);
    documentRoot.replaceChildren(error);
    documentRoot.setAttribute("aria-busy", "false");
    document.title = "기사를 찾지 못했습니다 · 북한뉴스아카이브";
    error.focus({ preventScroll: true });
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
})();
