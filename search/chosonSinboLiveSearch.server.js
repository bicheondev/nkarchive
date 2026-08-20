import * as cheerio from "cheerio";

export const CHOSON_SINBO_SOURCE = Object.freeze({
  id: "choson-sinbo",
  name: "조선신보",
  type: "archive",
  baseUrl: "https://www.chosonsinbo.com/",
});

const API_BASE_URL = "https://www.chosonsinbo.com/wp-json/wp/v2/posts";
const READABLE_BASE_URL = "https://r.jina.ai/http://www.chosonsinbo.com";
const FETCH_TIMEOUT_MS = 15000;
const SEARCH_POST_LIMIT = 12;
const MAX_RESPONSE_LENGTH = 2 * 1024 * 1024;
const MAX_IMAGES_PER_POST = 24;
const CACHE_TTL_MS = 5 * 60 * 1000;
const USER_AGENT = "DPRKArchiveSearchBot/0.1 (+https://nkarchive.vercel.app/search)";
const POST_FIELDS = "id,date,link,title,excerpt,content";
const postCache = new Map();

export async function searchChosonSinboDocuments(query, {
  tab = "all",
  limit = 20,
  fetchText = fetchChosonSinboReadableText,
} = {}) {
  const normalizedQuery = normalizeChosonSinboLiveQuery(query);
  if (!normalizedQuery) return [];

  const resultLimit = Math.max(1, Math.min(Number(limit) || 20, 24));
  const payload = await fetchText(createChosonSinboSearchUrl(normalizedQuery));
  const posts = parseChosonSinboPostsPayload(payload)
    .map(normalizeChosonSinboPost)
    .filter(Boolean);

  for (const post of posts) cachePost(post);

  const documents = tab === "image"
    ? posts.flatMap((post) => createChosonSinboImageDocuments(post, normalizedQuery))
    : posts.map((post) => createChosonSinboArticleDocument(post, normalizedQuery)).filter(Boolean);

  return documents
    .sort(compareLiveDocuments)
    .slice(0, resultLimit);
}

export async function getChosonSinboLiveDocument(id, {
  fetchText = fetchChosonSinboReadableText,
} = {}) {
  const identity = parseChosonSinboLiveDocumentId(id);
  if (!identity) return null;

  const post = await getChosonSinboPost(identity.postId, fetchText);
  if (!post) return null;
  if (identity.mediaType === "image") {
    return createChosonSinboImageDocuments(post, "", { includeAll: true })
      .find((document) => document.id === id) || null;
  }
  return createChosonSinboArticleDocument(post);
}

export function createChosonSinboSearchUrl(query) {
  const normalizedQuery = normalizeChosonSinboLiveQuery(query);
  if (!normalizedQuery) return "";
  const url = new URL(API_BASE_URL);
  url.searchParams.set("per_page", String(SEARCH_POST_LIMIT));
  url.searchParams.set("search", normalizedQuery);
  url.searchParams.set("orderby", "relevance");
  url.searchParams.set("_fields", POST_FIELDS);
  return url.href;
}

export function parseChosonSinboPostsPayload(text = "") {
  const parsed = parseReadableJsonPayload(text, "array");
  return Array.isArray(parsed) ? parsed : [];
}

export function createChosonSinboArticleDocument(post = {}, query = "") {
  const normalized = normalizeChosonSinboPost(post);
  if (!normalized) return null;
  const score = scoreArticleMatch(normalized, query);
  return {
    id: createChosonSinboLiveDocumentId(normalized.id),
    title: normalized.title,
    snippet: normalized.snippet,
    body: normalized.body,
    date: normalized.date,
    sourceId: CHOSON_SINBO_SOURCE.id,
    sourceName: CHOSON_SINBO_SOURCE.name,
    sourceType: CHOSON_SINBO_SOURCE.type,
    displaySourceId: CHOSON_SINBO_SOURCE.id,
    displaySourceName: CHOSON_SINBO_SOURCE.name,
    displaySourceType: CHOSON_SINBO_SOURCE.type,
    mediaType: "article",
    url: normalized.url,
    archiveUrl: "",
    originalSourceUrl: "",
    thumbnailUrl: normalized.images[0]?.url || "",
    cachedUrl: "",
    cachedThumbnailUrl: "",
    language: "ko",
    aliases: query ? [query] : [],
    searchTabs: [],
    score,
    baseScore: score,
    scoreReason: "live:source-search",
    displaySnippet: normalized.snippet,
    highlightRanges: { title: [], snippet: [] },
  };
}

export function createChosonSinboImageDocuments(post = {}, query = "", { includeAll = false } = {}) {
  const normalized = normalizeChosonSinboPost(post);
  if (!normalized) return [];

  return normalized.images
    .map((image) => ({
      image,
      score: scoreImageMatch(normalized, image, query, includeAll),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.image.index - right.image.index)
    .slice(0, MAX_IMAGES_PER_POST)
    .map(({ image, score }) => {
      const id = createChosonSinboLiveDocumentId(normalized.id, {
        mediaType: "image",
        imageIndex: image.index,
      });
      const assetUrl = `/api/search-asset?url=${encodeURIComponent(image.url)}`;
      const caption = cleanText(image.caption);
      const titleBase = caption || normalized.title;
      const title = normalized.images.length > 1
        ? `${titleBase} (${image.index + 1}/${normalized.images.length})`
        : titleBase;
      const body = [normalized.title, caption, normalized.body].filter(Boolean).join("\n");
      return {
        id,
        title,
        snippet: normalized.title,
        body,
        date: normalized.date,
        sourceId: CHOSON_SINBO_SOURCE.id,
        sourceName: CHOSON_SINBO_SOURCE.name,
        sourceType: CHOSON_SINBO_SOURCE.type,
        displaySourceId: CHOSON_SINBO_SOURCE.id,
        displaySourceName: CHOSON_SINBO_SOURCE.name,
        displaySourceType: CHOSON_SINBO_SOURCE.type,
        mediaType: "image",
        url: normalized.url,
        archiveUrl: "",
        originalSourceUrl: "",
        thumbnailUrl: image.url,
        cachedUrl: assetUrl,
        cachedThumbnailUrl: assetUrl,
        language: "ko",
        aliases: [query, caption].filter(Boolean),
        searchTabs: ["all", "image"],
        score,
        baseScore: score,
        scoreReason: image.matchReason || "live:image-context",
        displaySnippet: normalized.title,
        highlightRanges: { title: [], snippet: [] },
      };
    });
}

export function createChosonSinboLiveDocumentId(postId, {
  mediaType = "article",
  imageIndex = 0,
} = {}) {
  const normalizedPostId = normalizePostId(postId);
  if (!normalizedPostId) return "";
  return mediaType === "image"
    ? `choson-live-image-${normalizedPostId}-${Math.max(0, Number(imageIndex) || 0)}`
    : `choson-live-article-${normalizedPostId}`;
}

export function parseChosonSinboLiveDocumentId(id = "") {
  const value = String(id || "");
  const imageMatch = value.match(/^choson-live-image-(\d{1,9})-(\d{1,3})$/);
  const articleMatch = value.match(/^choson-live-article-(\d{1,9})$/);
  const postId = normalizePostId(imageMatch?.[1] || articleMatch?.[1]);
  if (!postId) return null;
  const imageIndex = imageMatch ? Number(imageMatch[2]) : -1;
  if (imageIndex > 99) return null;
  return {
    postId,
    mediaType: imageMatch ? "image" : "article",
    imageIndex,
  };
}

export function normalizeChosonSinboLiveQuery(query = "") {
  const value = cleanText(query);
  if (value.length < 2 || value.length > 80) return "";
  if (!/^[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ\s·]+$/u.test(value)) return "";
  if (/(?:^|\s)(?:AND|OR|NOT)(?=\s|$)/i.test(value)) return "";
  return value;
}

export async function fetchChosonSinboReadableText(sourceUrl, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const url = resolveAllowedChosonSinboApiUrl(sourceUrl);
  if (!url) throw new Error("invalid_choson_sinbo_api_url");
  const parsed = new URL(url);
  const readableUrl = `${READABLE_BASE_URL}${parsed.pathname}${parsed.search}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || FETCH_TIMEOUT_MS));
  try {
    const response = await fetch(readableUrl, {
      signal: controller.signal,
      headers: {
        Accept: "application/json,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "identity",
        "User-Agent": USER_AGENT,
        "X-Return-Format": "text",
      },
    });
    if (!response.ok) throw new Error(`upstream_${response.status}`);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_LENGTH) throw new Error("upstream_response_too_large");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeChosonSinboPost(post = {}) {
  if (post?.isNormalizedChosonSinboPost) return post;
  const id = normalizePostId(post.id);
  const url = resolveAllowedChosonSinboArticleUrl(post.link || post.url);
  const title = cleanWordPressText(getRenderedField(post.title));
  const contentHtml = getRenderedField(post.content);
  const excerpt = cleanWordPressText(getRenderedField(post.excerpt));
  const body = cleanWordPressText(contentHtml) || excerpt;
  const date = normalizeDate(post.date);
  if (!id || !url || !title || !body || !date) return null;
  return {
    isNormalizedChosonSinboPost: true,
    id,
    url,
    title,
    snippet: (excerpt || body).slice(0, 320),
    body,
    date,
    images: extractPostImages(contentHtml, url),
  };
}

function extractPostImages(html = "", articleUrl = "") {
  const $ = cheerio.load(String(html || ""));
  const images = [];
  const seen = new Set();
  $("img").each((_, element) => {
    const node = $(element);
    const url = resolveAllowedChosonSinboImageUrl(
      node.attr("src")
      || node.attr("data-src")
      || node.attr("data-lazy-src")
      || node.attr("data-original")
      || "",
      articleUrl,
    );
    if (!url || seen.has(url)) return;
    seen.add(url);

    const context = node.closest("figure, .wp-caption, dl.gallery-item");
    const caption = cleanText(
      context.find("figcaption, .wp-caption-text, .gallery-caption, dd").first().text()
      || node.next(".wp-caption-text, figcaption").first().text()
      || node.attr("alt")
      || node.attr("title")
      || "",
    );
    images.push({ url, caption, index: images.length });
  });
  return images;
}

function scoreArticleMatch(post, query = "") {
  if (!query) return 2200;
  const titleScore = scoreTextMatch(post.title, query, 5200, 4700);
  const snippetScore = scoreTextMatch(post.snippet, query, 3900, 3400);
  const bodyScore = scoreTextMatch(post.body, query, 2400, 2000);
  return Math.max(titleScore, snippetScore, bodyScore, 1200);
}

function scoreImageMatch(post, image, query = "", includeAll = false) {
  if (!query) return includeAll ? 2400 - image.index : 0;
  const captionScore = scoreTextMatch(image.caption, query, 6800, 6300)
    + getCaptionFocusBonus(image.caption, query);
  const titleScore = scoreTextMatch(post.title, query, 5900, 5500);
  const bodyScore = scoreTextMatch(post.body, query, 1900, 1600);
  if (!captionScore && !titleScore && !bodyScore) return 0;
  if (captionScore >= titleScore && captionScore >= bodyScore) {
    image.matchReason = "live:image-caption-match";
  } else if (titleScore >= bodyScore) {
    image.matchReason = "live:image-article-title-match";
  } else {
    image.matchReason = "live:image-article-body-match";
  }
  return Math.max(captionScore, titleScore, bodyScore) - image.index;
}

function getCaptionFocusBonus(caption = "", query = "") {
  const comparableCaption = normalizeComparableText(caption);
  const comparableQuery = normalizeComparableText(query);
  if (!comparableCaption.includes(comparableQuery)) return 0;
  const extraLength = Math.max(0, comparableCaption.length - comparableQuery.length);
  return Math.max(0, 500 - extraLength * 15);
}

function scoreTextMatch(text = "", query = "", phraseScore = 1, termScore = 1) {
  const comparableText = normalizeComparableText(text);
  const comparableQuery = normalizeComparableText(query);
  if (!comparableText || !comparableQuery) return 0;
  if (comparableText.includes(comparableQuery)) return phraseScore;
  const terms = cleanText(query)
    .split(/\s+/)
    .map(normalizeComparableText)
    .filter((term) => term.length >= 2);
  return terms.length && terms.every((term) => comparableText.includes(term)) ? termScore : 0;
}

function compareLiveDocuments(left, right) {
  return Number(right.score || 0) - Number(left.score || 0)
    || String(right.date || "").localeCompare(String(left.date || ""));
}

async function getChosonSinboPost(postId, fetchText) {
  const cached = postCache.get(postId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.post;
  const url = new URL(`${API_BASE_URL}/${postId}`);
  url.searchParams.set("_fields", POST_FIELDS);
  const payload = await fetchText(url.href);
  const parsed = parseReadableJsonPayload(payload, "object");
  const post = normalizeChosonSinboPost(parsed);
  if (post) cachePost(post);
  return post;
}

function cachePost(post) {
  if (!post?.id) return;
  postCache.set(post.id, { post, cachedAt: Date.now() });
  if (postCache.size <= 120) return;
  const oldestKey = postCache.keys().next().value;
  if (oldestKey) postCache.delete(oldestKey);
}

function parseReadableJsonPayload(text = "", expectedType = "array") {
  const value = String(text || "");
  const markerIndex = value.lastIndexOf("Markdown Content:");
  const candidate = markerIndex >= 0 ? value.slice(markerIndex + "Markdown Content:".length) : value;
  const startPattern = expectedType === "array" ? /\[\s*\{/ : /\{\s*"(?:id|code)"/;
  const startMatch = startPattern.exec(candidate);
  if (!startMatch || startMatch.index < 0) return expectedType === "array" ? [] : null;
  const start = startMatch.index;
  const closing = expectedType === "array" ? "]" : "}";
  const end = candidate.lastIndexOf(closing);
  if (end < start) return expectedType === "array" ? [] : null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return expectedType === "array" ? [] : null;
  }
}

function resolveAllowedChosonSinboApiUrl(value = "") {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return "";
    if (!/^(?:www\.)?chosonsinbo\.com$/i.test(parsed.hostname)) return "";
    if (!/^\/wp-json\/wp\/v2\/posts(?:\/\d{1,9})?\/?$/i.test(parsed.pathname)) return "";
    parsed.hostname = "www.chosonsinbo.com";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

function resolveAllowedChosonSinboArticleUrl(value = "") {
  try {
    const parsed = new URL(value, CHOSON_SINBO_SOURCE.baseUrl);
    if (parsed.protocol !== "https:") return "";
    if (!/^(?:www\.)?chosonsinbo\.com$/i.test(parsed.hostname)) return "";
    if (!/^\/(?:jp\/)?20\d{2}\/\d{2}\/[A-Za-z0-9_-]+\/?$/i.test(parsed.pathname)) return "";
    parsed.hostname = "chosonsinbo.com";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

function resolveAllowedChosonSinboImageUrl(value = "", articleUrl = "") {
  try {
    const parsed = new URL(String(value || "").replace(/&amp;/g, "&"), articleUrl || CHOSON_SINBO_SOURCE.baseUrl);
    if (parsed.protocol !== "https:") return "";
    if (!/^(?:www\.)?chosonsinbo\.com$/i.test(parsed.hostname)) return "";
    if (!/^\/wp-content\/uploads\/.+\.(?:avif|gif|jpe?g|png|webp)$/i.test(parsed.pathname)) return "";
    parsed.hostname = "chosonsinbo.com";
    parsed.pathname = parsed.pathname.replace(/-\d{2,5}x\d{2,5}(?=\.(?:avif|gif|jpe?g|png|webp)$)/i, "");
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

function getRenderedField(value) {
  return typeof value === "string" ? value : String(value?.rendered || "");
}

function cleanWordPressText(value = "") {
  const $ = cheerio.load(`<main>${String(value || "")}</main>`);
  $("style, script, noscript").remove();
  return cleanText($("main").text());
}

function normalizeDate(value = "") {
  return String(value || "").match(/^(20\d{2}-\d{2}-\d{2})/)?.[1] || "";
}

function normalizePostId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 999999999 ? String(number) : "";
}

function normalizeComparableText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[^0-9a-z가-힣]+/gi, "");
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}
