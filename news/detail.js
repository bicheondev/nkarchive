(function initializeNewsDocument() {
  const documentRoot = document.querySelector("#newsDocument");
  const titleElement = document.querySelector("#newsDocumentTitle");
  const sourceElement = document.querySelector("#newsDocumentSource");
  const dateElement = document.querySelector("#newsDocumentDate");
  const bodyElement = document.querySelector("#newsDocumentBody");
  const galleryElement = document.querySelector("#newsDocumentGallery");
  const heroElement = document.querySelector(".news-document-hero");
  const imageElement = document.querySelector("#newsDocumentImage");
  const shareButton = document.querySelector("#newsShareButton");
  const shareStatus = document.querySelector("#newsShareStatus");
  if (!documentRoot || !titleElement || !sourceElement || !dateElement || !bodyElement || !galleryElement || !heroElement || !imageElement || !shareButton || !shareStatus) return;

  const params = new URLSearchParams(window.location.search);
  const articleId = params.get("id") || "";
  const DETAILS_ROOT_URL = "/data/news/details";

  bindChrome();
  bindShare();
  loadArticle();

  async function loadArticle() {
    if (!articleId) {
      renderError("기사 주소가 올바르지 않습니다.");
      return;
    }

    try {
      const articleShard = newsDetailShardForId(articleId);
      const shardUrl = `${DETAILS_ROOT_URL}/${articleShard}.json`;
      let payload = await fetchDetails(shardUrl, "no-cache");
      if (!hasArticle(payload, articleShard)) {
        payload = await fetchDetails(`${shardUrl}?refresh=${Date.now()}`, "reload");
      }
      if (!hasArticle(payload, articleShard)) {
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

  async function fetchDetails(url, cache) {
    const response = await fetch(url, { cache, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`news_details_${response.status}`);
    return response.json();
  }

  function hasArticle(payload, expectedShard) {
    return Boolean(payload?.shard === expectedShard
      && payload.articles
      && Object.hasOwn(payload.articles, articleId));
  }

  function newsDetailShardForId(value) {
    const normalizedId = String(value || "");
    let hash = 0x811c9dc5;
    for (let index = 0; index < normalizedId.length; index += 1) {
      hash ^= normalizedId.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return ((hash >>> 0) & 0xff).toString(16).padStart(2, "0");
  }

  function renderArticle(article) {
    const title = String(article.title || "뉴스 기사");
    const body = String(article.body || article.snippet || "").trim();
    titleElement.textContent = title;
    sourceElement.textContent = article.sourceName || sourceNameForId(article.sourceId);
    dateElement.textContent = formatKoreanDate(article.date);
    document.title = `${title} · 북한뉴스아카이브`;

    const paragraphs = stripLeadingTitleParagraph(splitParagraphs(body), title);
    bodyElement.replaceChildren(
      ...paragraphs.map((paragraphText) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = paragraphText;
        return paragraph;
      }),
    );

    renderArticleImages(article);
    shareButton.disabled = false;
    documentRoot.setAttribute("aria-busy", "false");
    window.NewsComments?.initialize(articleId);
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

  function stripLeadingTitleParagraph(paragraphs, title) {
    const normalizedTitleLines = String(title || "")
      .replace(/\r\n?/gu, "\n")
      .split(/\n+/u)
      .map((line) => normalizeParagraphForTitleComparison(line))
      .filter(Boolean);
    if (!normalizedTitleLines.length) return paragraphs;

    const matchesTitleLinePrefix = normalizedTitleLines.every((line, index) => (
      normalizeParagraphForTitleComparison(paragraphs[index]) === line
    ));
    const normalizedTitle = normalizeParagraphForTitleComparison(title);
    const titleParagraphCount = matchesTitleLinePrefix
      ? normalizedTitleLines.length
      : normalizeParagraphForTitleComparison(paragraphs[0]) === normalizedTitle ? 1 : 0;
    if (!titleParagraphCount) return paragraphs;
    const remainingParagraphs = paragraphs.slice(titleParagraphCount);
    return remainingParagraphs.length ? remainingParagraphs : ["본문이 보관되지 않은 기사입니다."];
  }

  function normalizeParagraphForTitleComparison(value) {
    return String(value || "")
      .normalize("NFC")
      .replace(/[\u200b\ufeff]/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
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
      refererUrl: article?.url,
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
    if (cachedPrimarySource) sources.push(cachedPrimarySource);
    if (cachedSource && !sources.includes(cachedSource)) sources.push(cachedSource);
    for (const value of [article?.url, article?.thumbnailUrl]) {
      const remoteSource = resolveNewsImageProxySource(value, article?.refererUrl);
      if (remoteSource && !sources.includes(remoteSource)) sources.push(remoteSource);
    }
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

  function formatKoreanDate(value) {
    const match = String(value || "").match(/^(20\d{2})-(\d{2})-(\d{2})$/u);
    if (!match) return String(value || "");
    return `${match[1]}년 ${Number(match[2])}월 ${Number(match[3])}일`;
  }

  function sourceNameForId(sourceId) {
    return sourceId === "rodong-sinmun" ? "로동신문" : "조선중앙통신";
  }

  function bindShare() {
    shareButton.addEventListener("click", async () => {
      const currentUrl = createStableArticleUrl();
      const title = titleElement.textContent?.trim() || "북한뉴스아카이브 기사";
      shareButton.disabled = true;
      shareButton.setAttribute("aria-busy", "true");
      shareStatus.textContent = "";

      try {
        if (typeof navigator.share === "function") {
          await navigator.share({ title, text: title, url: currentUrl });
          shareStatus.textContent = "기사를 공유했습니다.";
        } else {
          if (typeof navigator.clipboard?.writeText !== "function") throw new Error("clipboard_unavailable");
          await navigator.clipboard.writeText(currentUrl);
          shareStatus.textContent = "기사 주소를 복사했습니다.";
        }
      } catch (error) {
        if (error?.name === "AbortError") {
          shareStatus.textContent = "공유를 취소했습니다.";
        } else {
          console.error("[news] Unable to share the archived article.", error);
          shareStatus.textContent = "공유하지 못했습니다. 다시 시도해 주세요.";
        }
      } finally {
        shareButton.disabled = false;
        shareButton.removeAttribute("aria-busy");
      }
    });
  }

  function createStableArticleUrl() {
    const url = new URL(window.location.href);
    url.pathname = "/news/document";
    url.search = "";
    url.hash = "";
    url.searchParams.set("id", articleId);
    return url.href;
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
        window.location.assign("/news#search");
      }
    });
  }
})();
