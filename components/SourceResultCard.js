const SOURCE_LABELS = {
  official_site: "공식",
  archive: "아카이브",
  youtube: "YouTube",
  video_archive: "영상",
  pdf: "PDF",
  image: "이미지",
};

const MEDIA_LABELS = {
  article: "기사",
  image: "이미지",
  video: "동영상",
  pdf: "문헌",
  broadcast: "방송",
};

const SOURCE_LOGO_ASSETS = {
  로동신문: {
    src: "/assets/search-rodong-logo.svg?v=search-20260803-6",
    className: "source-result-logo-artwork-rodong",
  },
  조선중앙통신: {
    src: "/assets/search-kcna-logo.svg?v=search-20260803-6",
    className: "source-result-logo-artwork-kcna",
  },
  YouTube: {
    src: "/assets/search-youtube-logo.svg?v=search-20260803-6",
    className: "source-result-logo-artwork-youtube",
  },
};

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

export function createSourceResultCard({ sourceId = "", sourceName, sourceType, total, results = [] }, options = {}) {
  const card = document.createElement("section");
  const header = document.createElement("div");
  const logo = document.createElement("div");
  const sourceCopy = document.createElement("div");
  const sourceTitle = document.createElement("h2");
  const sourceMeta = document.createElement("p");
  const more = document.createElement("a");
  const list = document.createElement("div");
  const resultLimit = Number.isFinite(Number(options.resultLimit)) ? Number(options.resultLimit) : 5;
  const isYouTube = isYouTubeSource(sourceId, sourceName);
  const isVideoPreview = isVideoPreviewSource({ sourceId, sourceName, sourceType, results });
  const totalCount = Number.isFinite(Number(total)) ? Number(total) : results.length;
  const visibleLimit = Math.max(0, isVideoPreview ? getVideoResultLimit(resultLimit) : resultLimit);
  const visibleResults = getVisibleSourceResults(results, visibleLimit, { sourceId, sourceName, showMore: options.showMore });
  const shouldShowMore = options.showMore !== false && totalCount > visibleResults.length;

  card.className = [
    "source-result-card",
    isVideoPreview ? "source-result-card-video source-result-card-youtube" : "",
    isYouTube ? "source-result-card-video-youtube" : "",
  ].filter(Boolean).join(" ");
  if (sourceId) card.dataset.sourceId = sourceId;
  header.className = "source-result-header";
  logo.className = `source-result-logo source-result-logo-${slugSource(sourceName)}`;
  logo.setAttribute("aria-hidden", "true");
  appendSourceLogo(logo, sourceName);
  sourceCopy.className = "source-result-source";
  sourceTitle.textContent = sourceName;
  sourceMeta.textContent = `${SOURCE_LABELS[sourceType] || "자료"} · ${formatCount(totalCount)}건`;
  more.className = "source-result-more";
  configureResultLink(more, options.moreHref || results[0]?.archiveUrl || results[0]?.url || "");
  more.textContent = "더 보기";
  more.setAttribute("aria-label", createMoreLinkAccessibleLabel({
    sourceName,
    query: options.query,
    totalCount,
    visibleCount: visibleResults.length,
  }));
  if (shouldShowMore && typeof options.onMore === "function") {
    more.addEventListener("click", (event) => {
      event.preventDefault();
      options.onMore({ sourceId, sourceName, sourceType, results });
    });
  }
  sourceCopy.append(sourceTitle, sourceMeta);
  header.append(logo, sourceCopy);
  if (shouldShowMore) header.append(more);

  list.className = isVideoPreview ? "source-result-video-grid source-result-youtube-grid" : "source-result-list";
  for (const result of visibleResults) {
    list.append(isVideoPreview ? createVideoResultItem(result, options, { sourceName }) : createResultItem(result, options));
  }

  card.append(header, list);
  return card;
}

function appendSourceLogo(parent, sourceName) {
  const asset = SOURCE_LOGO_ASSETS[sourceName];
  if (!asset) {
    parent.classList.add("source-result-logo-fallback");
    parent.textContent = sourceLogoText(sourceName);
    return;
  }

  const image = document.createElement("img");
  image.alt = "";
  image.decoding = "async";
  configureMediaElement(image);
  image.src = asset.src;
  parent.classList.add("source-result-logo-artwork", asset.className);
  parent.append(image);
}

function createResultItem(result, options = {}) {
  const item = document.createElement("article");
  const title = document.createElement("a");
  const metadata = createResultMetadata(result);
  const snippet = document.createElement("p");
  const snippetText = getResultSnippetText(result);
  const documentHref = typeof options.getDocumentHref === "function"
    ? options.getDocumentHref(result)
    : "";

  item.className = "source-result-item";
  title.className = "source-result-title";
  configureResultLink(title, documentHref || result.archiveUrl || result.url || "");
  appendHighlightedText(title, result.title || "", result.highlightRanges?.title || []);
  if (snippetText) {
    snippet.className = "source-result-snippet";
    const snippetRanges = result.highlightRanges?.snippet || [];
    appendHighlightedText(snippet, snippetText, snippetRanges);
  }
  item.append(title);
  if (metadata) item.append(metadata);
  if (snippetText) item.append(snippet);

  return item;
}

function getResultSnippetText(result = {}) {
  return Object.hasOwn(result, "displaySnippet")
    ? String(result.displaySnippet || "")
    : String(result.snippet || "");
}

function getVisibleSourceResults(results = [], visibleLimit = 5, { sourceId = "", sourceName = "", showMore = true } = {}) {
  const limit = Math.max(0, Number(visibleLimit) || 0);
  const visible = Array.isArray(results) ? results.slice(0, limit) : [];
  if (!shouldCompactArchiveDuplicates({ sourceId, sourceName, showMore })) return visible;
  return compactArchiveDuplicateResults(visible);
}

function shouldCompactArchiveDuplicates({ sourceId = "", sourceName = "", showMore = true } = {}) {
  return showMore !== false && (sourceId === "kcna-watch" || sourceName === "KCNA Watch");
}

function compactArchiveDuplicateResults(results = []) {
  const grouped = new Map();

  for (const result of results) {
    const key = createArchiveDuplicateKey(result);
    if (!key) {
      grouped.set(Symbol("result"), [result]);
      continue;
    }
    const group = grouped.get(key) || [];
    group.push(result);
    grouped.set(key, group);
  }

  return [...grouped.values()].map(mergeArchiveDuplicateGroup);
}

function mergeArchiveDuplicateGroup(group = []) {
  if (group.length <= 1) return group[0];
  return {
    ...group[0],
    duplicateArchiveCount: group.length,
    relatedOriginNames: getRelatedOriginNames(group),
  };
}

function getRelatedOriginNames(results = []) {
  const names = [];
  const seen = new Set();
  for (const result of results) {
    const name = getDistinctOriginalSourceName(result);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function createVideoResultItem(result, options = {}, { sourceName = "" } = {}) {
  const item = document.createElement("article");
  const link = document.createElement("a");
  const thumbnail = document.createElement("div");
  const image = document.createElement("img");
  const copy = document.createElement("div");
  const title = document.createElement("h3");
  const channel = document.createElement("p");
  const date = document.createElement("p");
  const documentHref = typeof options.getDocumentHref === "function"
    ? options.getDocumentHref(result)
    : "";
  const thumbnailSrc = getThumbnailSrc(result);
  const fallbackThumbnailSrc = getFallbackThumbnailSrc(result, thumbnailSrc);

  item.className = "source-result-video-item source-result-youtube-item";
  link.className = "source-result-video-link source-result-youtube-link";
  configureResultLink(link, documentHref || result.archiveUrl || result.url || "");
  thumbnail.className = "source-result-video-thumbnail source-result-youtube-thumbnail";
  if (thumbnailSrc) {
    let retriedFallback = false;
    image.alt = result.title || "";
    image.loading = "lazy";
    image.decoding = "async";
    configureMediaElement(image);
    image.src = thumbnailSrc;
    image.addEventListener("error", () => {
      if (!retriedFallback && fallbackThumbnailSrc) {
        retriedFallback = true;
        image.src = fallbackThumbnailSrc;
        return;
      }
      thumbnail.classList.add("source-result-video-thumbnail-empty", "source-result-youtube-thumbnail-empty");
      image.remove();
    });
    thumbnail.append(image);
  } else {
    thumbnail.classList.add("source-result-video-thumbnail-empty", "source-result-youtube-thumbnail-empty");
  }

  copy.className = "source-result-video-copy source-result-youtube-copy";
  title.className = "source-result-video-title source-result-youtube-title";
  title.textContent = result.title || "동영상";
  channel.className = "source-result-video-channel source-result-youtube-channel";
  channel.textContent = getVideoSourceLabel(result, sourceName);
  date.className = "source-result-video-date source-result-youtube-date";
  date.textContent = formatDate(result.date);
  copy.append(title, channel, date);
  link.append(thumbnail, copy);
  item.append(link);
  return item;
}

function createYouTubeResultItem(result, options = {}) {
  return createVideoResultItem(result, options, { sourceName: "YouTube" });
}

function createResultMetadata(result = {}) {
  const metadata = document.createElement("p");
  const mediaType = MEDIA_LABELS[result.mediaType] || "";
  const date = formatDate(result.date);
  const originalHref = getOriginalSourceHref(result);
  const sourceOriginalHref = getSourceOriginalHref(result);
  const url = formatDisplayUrl(originalHref);
  const originSourceName = getOriginalSourceName(result);
  const parts = [mediaType, date, url].filter(Boolean);
  if (!parts.length && !originSourceName && !originalHref && !sourceOriginalHref) return null;

  metadata.className = "source-result-metadata";
  if (parts.length) {
    const summary = document.createElement("span");
    summary.className = "source-result-metadata-text";
    summary.textContent = parts.join(" · ");
    metadata.append(summary);
  }
  if (originSourceName) {
    if (parts.length) metadata.append(createMetadataSeparator());
    const origin = sourceOriginalHref ? document.createElement("a") : document.createElement("span");
    origin.className = "source-result-origin-pill";
    origin.textContent = `원출처 ${originSourceName}`;
    if (sourceOriginalHref) {
      origin.setAttribute("aria-label", createOriginalSourceAccessibleLabel(result, `원출처 ${originSourceName}`));
      configureResultLink(origin, sourceOriginalHref);
    }
    metadata.append(origin);
  }
  if (result.duplicateArchiveCount > 1) {
    if (parts.length || originSourceName) metadata.append(createMetadataSeparator());
    const duplicateCount = document.createElement("span");
    duplicateCount.className = "source-result-archive-count";
    duplicateCount.textContent = `보존본 ${formatCount(result.duplicateArchiveCount)}건`;
    metadata.append(duplicateCount);
  }
  if (originalHref) {
    if (parts.length || originSourceName || result.duplicateArchiveCount > 1) metadata.append(createMetadataSeparator());
    const sourceLabel = getSourceLinkLabel(result);
    const original = document.createElement("a");
    original.className = "source-result-original";
    original.textContent = sourceLabel;
    original.setAttribute("aria-label", createOriginalSourceAccessibleLabel(result, sourceLabel));
    configureResultLink(original, originalHref);
    metadata.append(original);
  }
  return metadata;
}

function createMetadataSeparator() {
  const separator = document.createElement("span");
  separator.className = "source-result-metadata-separator";
  separator.textContent = " · ";
  return separator;
}

function getOriginalSourceHref(result = {}) {
  return result.url || result.archiveUrl || "";
}

function getSourceOriginalHref(result = {}) {
  const href = String(result.originalSourceUrl || "").trim();
  if (!href || !hasDistinctPhysicalSource(result)) return "";
  if (getRelatedOriginNameList(result).length > 1) return "";
  const physicalHref = getOriginalSourceHref(result);
  return href === physicalHref ? "" : href;
}

function getSourceLinkLabel(result = {}) {
  if (!hasDistinctPhysicalSource(result)) return "원문 사이트";
  const sourceName = String(result.sourceName || "").trim();
  return sourceName ? `${sourceName} 보존본` : "보존본";
}

function getOriginalSourceName(result = {}) {
  const relatedOriginNames = getRelatedOriginNameList(result);
  if (relatedOriginNames.length) return formatRelatedOriginNames(relatedOriginNames);
  return getDistinctOriginalSourceName(result);
}

function getDistinctOriginalSourceName(result = {}) {
  if (!hasDistinctPhysicalSource(result)) return "";
  const sourceName = String(result.sourceName || "").trim();
  const displaySourceName = String(result.displaySourceName || "").trim();
  if (!displaySourceName || displaySourceName === sourceName) return "";
  return displaySourceName;
}

function getRelatedOriginNameList(result = {}) {
  return Array.isArray(result.relatedOriginNames)
    ? result.relatedOriginNames.map((name) => String(name || "").trim()).filter(Boolean)
    : [];
}

function formatRelatedOriginNames(names = []) {
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length <= 2) return uniqueNames.join(", ");
  return `${uniqueNames.slice(0, 2).join(", ")} 외 ${formatCount(uniqueNames.length - 2)}곳`;
}

function createOriginalSourceAccessibleLabel(result = {}, sourceLabel = getSourceLinkLabel(result)) {
  const title = String(result.title || "").trim();
  return title ? `${sourceLabel}: ${title}` : sourceLabel;
}

function createMoreLinkAccessibleLabel({
  sourceName = "",
  query = "",
  totalCount = 0,
  visibleCount = 0,
} = {}) {
  const source = String(sourceName || "").trim() || "자료원";
  const normalizedQuery = String(query || "").trim();
  const scope = normalizedQuery ? `${normalizedQuery} 검색에서 ${source}` : source;
  return `${scope} 결과 ${formatCount(totalCount)}건 모두 보기, 현재 ${formatCount(visibleCount)}건 표시됨`;
}

function hasDistinctPhysicalSource(result = {}) {
  const sourceId = String(result.sourceId || "").trim();
  const displaySourceId = String(result.displaySourceId || "").trim();
  const sourceName = String(result.sourceName || "").trim();
  const displaySourceName = String(result.displaySourceName || "").trim();
  return Boolean(sourceId && displaySourceId && sourceId !== displaySourceId)
    || Boolean(sourceName && displaySourceName && sourceName !== displaySourceName);
}

function configureResultLink(link, href = "") {
  const value = String(href || "").trim();
  if (!value) {
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
    return;
  }
  link.href = value;
  if (!isExternalHref(value)) return;
  link.rel = "noreferrer";
  link.referrerPolicy = "no-referrer";
}

function configureMediaElement(element) {
  element.referrerPolicy = "no-referrer";
}

function isExternalHref(href = "") {
  return /^https?:\/\//i.test(String(href || ""));
}

function appendHighlightedText(parent, text = "", ranges = []) {
  let cursor = 0;
  const value = String(text || "");

  for (const range of ranges) {
    const start = Math.max(0, Math.min(value.length, Number(range.start)));
    const end = Math.max(start, Math.min(value.length, Number(range.end)));
    if (start > cursor) parent.append(document.createTextNode(value.slice(cursor, start)));
    if (end > start) {
      const mark = document.createElement("mark");
      mark.textContent = value.slice(start, end);
      parent.append(mark);
    }
    cursor = end;
  }

  if (cursor < value.length) parent.append(document.createTextNode(value.slice(cursor)));
}

function formatDate(date) {
  if (!date) return "";
  const [year, month, day] = String(date).split("-");
  if (!year || !month || !day) return date;
  return `${Number(year)}. ${Number(month)}. ${Number(day)}.`;
}

function formatCount(value) {
  return new Intl.NumberFormat("ko-KR").format(Math.max(0, Number(value) || 0));
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

function sourceLogoText(sourceName) {
  const compactLabels = {
    "조선의 소리": "VOK",
    "민주조선": "민주",
    "류경": "류",
    "내나라": "내",
    "조선신보": "신보",
    "조선의 출판물": "책",
    "KCNA Watch": "KW",
    "고려TV VOD": "VOD",
  };
  if (compactLabels[sourceName]) return compactLabels[sourceName];
  if (sourceName === "로동신문") return "로동신문";
  if (sourceName === "조선중앙통신") return "KCNA";
  if (String(sourceName || "").startsWith("YouTube")) return "YouTube";
  return sourceName;
}

function slugSource(sourceName) {
  return String(sourceName).toLocaleLowerCase("en-US").replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-|-$/g, "");
}

function isYouTubeSource(sourceId = "", sourceName = "") {
  return sourceId === "youtube" || String(sourceName || "").startsWith("YouTube");
}

function isVideoPreviewSource({ sourceId = "", sourceName = "", sourceType = "", results = [] } = {}) {
  if (isYouTubeSource(sourceId, sourceName) || sourceType === "video_archive") return true;
  return Array.isArray(results)
    && results.some((result) => result?.mediaType === "video" && getThumbnailSrc(result));
}

function createArchiveDuplicateKey(result = {}) {
  const title = normalizeArchiveDuplicateText(result.title || "");
  if (!title) return "";
  const date = String(result.date || "").trim();
  return [date, title].join("|");
}

function normalizeArchiveDuplicateText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[^\p{L}\p{N}가-힣]+/gu, "")
    .trim();
}

function getThumbnailSrc(result = {}) {
  return result.cachedThumbnailUrl || createSearchAssetDisplayUrl(result.thumbnailUrl);
}

function getFallbackThumbnailSrc(result = {}, primarySrc = "") {
  const thumbnailUrl = String(result.thumbnailUrl || "");
  const displayUrl = createSearchAssetDisplayUrl(thumbnailUrl);
  if (!displayUrl || displayUrl === primarySrc) return "";
  return displayUrl;
}

function createSearchAssetDisplayUrl(value = "") {
  if (!isRemotePreviewAssetUrl(value)) return "";
  return isPublicDirectAssetUrl(value) ? value : createSearchAssetProxyUrl(value);
}

function createSearchAssetProxyUrl(value = "") {
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

function isRemotePreviewAssetUrl(value = "") {
  try {
    const url = new URL(value);
    return /^https?:$/i.test(url.protocol) && isPreviewAssetUrl(url.href);
  } catch {
    return false;
  }
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

function getYouTubeChannelName(result = {}) {
  const aliases = Array.isArray(result.aliases) ? result.aliases : [];
  if (aliases.some((alias) => /supersuhui|슈퍼수희/i.test(alias))) return "supersuhui";
  if (aliases.some((alias) => /메아리|meari/i.test(alias))) return "메아리";
  return "YouTube";
}

function getVideoResultLimit(resultLimit) {
  return resultLimit > 5 ? resultLimit : 4;
}

function getVideoSourceLabel(result = {}, sourceName = "") {
  if (isYouTubeSource(result.sourceId, result.sourceName)) return getYouTubeChannelName(result);
  return String(result.sourceName || sourceName || "동영상").trim();
}
