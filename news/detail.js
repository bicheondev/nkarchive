(function initializeNewsDocument() {
  const documentRoot = document.querySelector("#newsDocument");
  const titleElement = document.querySelector("#newsDocumentTitle");
  const sourceElement = document.querySelector("#newsDocumentSource");
  const dateElement = document.querySelector("#newsDocumentDate");
  const bodyElement = document.querySelector("#newsDocumentBody");
  const galleryElement = document.querySelector("#newsDocumentGallery");
  const heroElement = document.querySelector(".news-document-hero");
  const imageElement = document.querySelector("#newsDocumentImage");
  if (!documentRoot || !titleElement || !sourceElement || !dateElement || !bodyElement || !galleryElement || !heroElement || !imageElement) return;

  const params = new URLSearchParams(window.location.search);
  const articleId = params.get("id") || "";
  const requestedVersion = params.get("v") || "";
  const DETAILS_URL = requestedVersion
    ? `/data/news-details.json?v=${encodeURIComponent(requestedVersion)}`
    : "/data/news-details.json";

  bindChrome();
  loadArticle();

  async function loadArticle() {
    if (!articleId) {
      renderError("기사 주소가 올바르지 않습니다.");
      return;
    }

    try {
      let response = await fetch(DETAILS_URL, { cache: "no-cache", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`news_details_${response.status}`);
      let payload = await response.json();
      if (requestedVersion && payload?.version !== requestedVersion) {
        response = await fetch(`${DETAILS_URL}&refresh=${Date.now()}`, {
          cache: "reload",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`news_details_${response.status}`);
        payload = await response.json();
      }
      if (requestedVersion && payload?.version !== requestedVersion) {
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

    renderArticleImages(article);
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

  function renderArticleImages(article) {
    const imageRecords = collectArticleImages(article);
    heroElement.hidden = true;
    imageElement.alt = "";
    imageElement.removeAttribute("src");
    galleryElement.replaceChildren();
    galleryElement.hidden = true;
    if (!imageRecords.length) return;

    let recordIndex = 0;
    let sourceIndex = 0;
    let currentSources = [];
    const tryNextHero = () => {
      if (sourceIndex < currentSources.length) {
        imageElement.src = currentSources[sourceIndex];
        sourceIndex += 1;
        return;
      }
      if (recordIndex >= imageRecords.length) {
        heroElement.hidden = true;
        imageElement.removeAttribute("src");
        return;
      }
      currentSources = resolveArticleImageSources(imageRecords[recordIndex]);
      sourceIndex = 0;
      recordIndex += 1;
      tryNextHero();
    };
    imageElement.onload = () => {
      const heroRecordIndex = recordIndex - 1;
      heroElement.hidden = false;
      renderGallery(imageRecords.filter((_, index) => index !== heroRecordIndex));
    };
    imageElement.onerror = tryNextHero;
    imageElement.decoding = "async";
    imageElement.referrerPolicy = "no-referrer";
    tryNextHero();
  }

  function collectArticleImages(article) {
    const imageRecords = Array.isArray(article?.images) ? article.images.filter(Boolean) : [];
    const legacyLead = {
      id: `${String(article?.id || "article")}-lead`,
      thumbnailUrl: article?.thumbnailUrl,
      cachedThumbnailUrl: article?.cachedThumbnailUrl,
    };
    const records = resolveArticleImageSources(legacyLead).length ? [legacyLead, ...imageRecords] : imageRecords;
    const seen = new Set();
    return records.filter((record) => {
      const identity = resolveArticleImageSources(record)[0] || "";
      if (!identity || seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }

  function renderGallery(records) {
    const figures = records.flatMap((record) => {
      const sources = resolveArticleImageSources(record);
      if (!sources.length) return [];
      const figure = document.createElement("figure");
      const image = document.createElement("img");
      let sourceIndex = 0;
      const tryNextSource = () => {
        if (sourceIndex >= sources.length) {
          figure.remove();
          if (!galleryElement.children.length) galleryElement.hidden = true;
          return;
        }
        image.src = sources[sourceIndex];
        sourceIndex += 1;
      };
      figure.className = "news-document-gallery-item";
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", tryNextSource);
      figure.append(image);
      tryNextSource();
      return [figure];
    });
    if (!figures.length) return;
    galleryElement.replaceChildren(...figures);
    galleryElement.hidden = false;
  }

  function resolveArticleImageSources(article) {
    const sources = [];
    const cachedPrimarySource = resolveCachedImageSource(article?.cachedUrl);
    const cachedSource = resolveCachedImageSource(article?.cachedThumbnailUrl);
    const originalPrimarySource = resolveOriginalImageSource(article?.url);
    const originalSource = resolveOriginalImageSource(article?.thumbnailUrl);
    if (cachedPrimarySource) sources.push(cachedPrimarySource);
    if (cachedSource) sources.push(cachedSource);
    if (originalPrimarySource && !sources.includes(originalPrimarySource)) sources.push(originalPrimarySource);
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
