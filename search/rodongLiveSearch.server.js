import * as cheerio from "cheerio";

export const RODONG_SOURCE = Object.freeze({
  id: "rodong-sinmun",
  name: "로동신문",
  type: "official_site",
  baseUrl: "http://www.rodong.rep.kp/ko/index.php",
});

const READABLE_BASE_URL = "https://r.jina.ai/http://www.rodong.rep.kp";
const FETCH_TIMEOUT_MS = 15000;
const SEARCH_PAGE_SIZE = 20;
const MAX_SEARCH_PAGES = 3;
const MAX_QUERY_LENGTH = 80;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const USER_AGENT = "DPRKArchiveSearchBot/0.1 (+https://nkarchive.vercel.app/search)";

export async function searchRodongDocuments(query, {
  tab = "all",
  limit = 20,
  fetchHtml = fetchRodongReadableHtml,
} = {}) {
  const normalizedQuery = normalizeLiveSearchQuery(query);
  if (!normalizedQuery) return [];

  const resultLimit = Math.max(1, Math.min(Number(limit) || 20, 24));
  const candidateLimit = tab === "image" ? 12 : resultLimit;
  const entries = new Map();

  for (let page = 1; page <= MAX_SEARCH_PAGES && entries.size < candidateLimit; page += 1) {
    const searchUrl = createRodongSearchUrl(normalizedQuery, page);
    const html = await fetchHtml(searchUrl);
    const pageEntries = parseRodongSearchResults(html);
    for (const entry of pageEntries) {
      if (!entries.has(entry.url)) entries.set(entry.url, entry);
      if (entries.size >= candidateLimit) break;
    }
    if (pageEntries.length < SEARCH_PAGE_SIZE) break;
  }

  const candidates = [...entries.values()].slice(0, candidateLimit);
  if (tab !== "image") {
    return candidates.map((entry) => createRodongArticleDocument(entry, normalizedQuery));
  }

  const details = await mapWithConcurrency(candidates, 3, async (entry) => {
    try {
      const html = await fetchRodongDetailHtmlWithRetry(entry.url, fetchHtml);
      return parseRodongDetailHtml(html, entry);
    } catch {
      return null;
    }
  });

  return details
    .filter(Boolean)
    .flatMap((detail) => createRodongImageDocuments(detail, normalizedQuery))
    .slice(0, resultLimit);
}

export async function getRodongLiveDocument(id, { fetchHtml = fetchRodongReadableHtml } = {}) {
  const identity = parseRodongLiveDocumentId(id);
  if (!identity) return null;

  const html = await fetchHtml(identity.url);
  const detail = parseRodongDetailHtml(html, { url: identity.url });
  if (!detail) return null;
  if (identity.mediaType === "image") {
    return createRodongImageDocuments(detail)[identity.imageIndex] || null;
  }
  return createRodongArticleDocument(detail);
}

export async function getRodongLiveImage(id, { fetchHtml = fetchRodongReadableHtml } = {}) {
  const identity = parseRodongLiveDocumentId(id);
  if (!identity || identity.mediaType !== "image") return null;

  const html = await fetchHtml(identity.url);
  const detail = parseRodongDetailHtml(html, { url: identity.url });
  return detail?.images?.[identity.imageIndex] || null;
}

export function createRodongSearchUrl(query, page = 1) {
  const normalizedQuery = normalizeLiveSearchQuery(query);
  if (!normalizedQuery) return "";
  const pageNumber = Math.max(1, Math.min(Number(page) || 1, MAX_SEARCH_PAGES));
  const token = Buffer.from(`19@@19@@${normalizedQuery}@${pageNumber}`).toString("base64");
  return `${RODONG_SOURCE.baseUrl}?${encodeURIComponent(token)}`;
}

export function parseRodongSearchResults(html = "") {
  const $ = cheerio.load(String(html || ""));
  const entries = [];

  $("#m_dayList li a[href]").each((_, element) => {
    const link = $(element);
    const url = resolveAllowedRodongArticleUrl(link.attr("href"));
    if (!url) return;

    const titleNode = link.find(".news_list_title").first().clone();
    titleNode.find(".news_list_date").remove();
    const title = cleanText(titleNode.text() || link.text());
    const date = parseKoreanDate(link.find(".news_list_date").text() || link.text());
    if (!title || !date) return;
    entries.push({ title, date, url });
  });

  return dedupeBy(entries, (entry) => entry.url);
}

export function parseRodongDetailHtml(html = "", fallback = {}) {
  const $ = cheerio.load(String(html || ""));
  const url = resolveAllowedRodongArticleUrl(fallback.url);
  if (!url) return null;

  const title = cleanText($(".TitleP").first().text() || fallback.title || "");
  const paragraphs = $(".TextP")
    .map((_, element) => cleanText($(element).text()))
    .get()
    .filter(Boolean);
  const writer = cleanText($(".WriterP").first().text());
  const body = [...paragraphs, writer].filter(Boolean).join("\n");
  const date = parseKoreanDate($("#article-homepage").text())
    || fallback.date
    || parseRodongArticleUrlDate(url);
  if (!title || !date) return null;

  const images = [];
  $("img[src^='data:']").each((_, element) => {
    const image = decodeDataImage($(element).attr("src") || "");
    if (image) images.push(image);
  });

  return {
    title,
    snippet: paragraphs[0] || title,
    body: body || title,
    date,
    url,
    images,
  };
}

export function createRodongArticleDocument(entry = {}, query = "") {
  const url = resolveAllowedRodongArticleUrl(entry.url);
  if (!url || !entry.title || !entry.date) return null;
  const aliases = query ? [query] : [];
  return {
    id: createRodongLiveDocumentId(url),
    title: cleanText(entry.title),
    snippet: cleanText(entry.snippet || entry.body || entry.title),
    body: cleanText(entry.body || entry.snippet || entry.title),
    date: entry.date,
    sourceId: RODONG_SOURCE.id,
    sourceName: RODONG_SOURCE.name,
    sourceType: RODONG_SOURCE.type,
    displaySourceId: RODONG_SOURCE.id,
    displaySourceName: RODONG_SOURCE.name,
    displaySourceType: RODONG_SOURCE.type,
    mediaType: "article",
    url,
    archiveUrl: "",
    originalSourceUrl: "",
    thumbnailUrl: "",
    cachedUrl: "",
    cachedThumbnailUrl: "",
    language: "ko",
    aliases,
    searchTabs: [],
    score: 1000,
    baseScore: 1000,
    scoreReason: "live:source-search",
    displaySnippet: cleanText(entry.snippet || entry.body || entry.title),
    highlightRanges: { title: [], snippet: [] },
  };
}

export function createRodongImageDocuments(detail = {}, query = "") {
  const url = resolveAllowedRodongArticleUrl(detail.url);
  if (!url || !detail.title || !detail.date || !Array.isArray(detail.images)) return [];
  const aliases = query ? [query] : [];
  return detail.images.map((_, index) => {
    const id = createRodongLiveDocumentId(url, { mediaType: "image", imageIndex: index });
    const assetUrl = `/api/search-live-image?id=${encodeURIComponent(id)}`;
    const title = detail.images.length > 1
      ? `${cleanText(detail.title)} (${index + 1}/${detail.images.length})`
      : cleanText(detail.title);
    return {
      id,
      title,
      snippet: cleanText(detail.snippet || detail.body || detail.title),
      body: cleanText(detail.body || detail.snippet || detail.title),
      date: detail.date,
      sourceId: RODONG_SOURCE.id,
      sourceName: RODONG_SOURCE.name,
      sourceType: RODONG_SOURCE.type,
      displaySourceId: RODONG_SOURCE.id,
      displaySourceName: RODONG_SOURCE.name,
      displaySourceType: RODONG_SOURCE.type,
      mediaType: "image",
      url,
      archiveUrl: url,
      originalSourceUrl: "",
      thumbnailUrl: "",
      cachedUrl: assetUrl,
      cachedThumbnailUrl: assetUrl,
      language: "ko",
      aliases,
      searchTabs: ["all", "image"],
      score: 1000,
      baseScore: 1000,
      scoreReason: "live:source-search",
      displaySnippet: cleanText(detail.snippet || detail.body || detail.title),
      highlightRanges: { title: [], snippet: [] },
    };
  });
}

export function createRodongLiveDocumentId(url, { mediaType = "article", imageIndex = 0 } = {}) {
  const normalizedUrl = resolveAllowedRodongArticleUrl(url);
  if (!normalizedUrl) return "";
  const token = Buffer.from(normalizedUrl).toString("base64url");
  return mediaType === "image"
    ? `rodong-live-image-${Math.max(0, Number(imageIndex) || 0)}-${token}`
    : `rodong-live-article-${token}`;
}

export function parseRodongLiveDocumentId(id = "") {
  const value = String(id || "");
  const imageMatch = value.match(/^rodong-live-image-(\d+)-([A-Za-z0-9_-]+)$/);
  const articleMatch = value.match(/^rodong-live-article-([A-Za-z0-9_-]+)$/);
  const token = imageMatch?.[2] || articleMatch?.[1] || "";
  if (!token) return null;

  try {
    const url = resolveAllowedRodongArticleUrl(Buffer.from(token, "base64url").toString("utf8"));
    if (!url) return null;
    return {
      url,
      mediaType: imageMatch ? "image" : "article",
      imageIndex: imageMatch ? Number(imageMatch[1]) : -1,
    };
  } catch {
    return null;
  }
}

export function normalizeLiveSearchQuery(query = "") {
  const value = cleanText(query);
  if (value.length < 2 || value.length > MAX_QUERY_LENGTH) return "";
  if (!/^[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ\s·]+$/u.test(value)) return "";
  if (/(?:^|\s)(?:AND|OR|NOT)(?=\s|$)/i.test(value)) return "";
  return value;
}

export async function fetchRodongReadableHtml(sourceUrl, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const url = resolveAllowedRodongPageUrl(sourceUrl);
  if (!url) throw new Error("invalid_rodong_url");
  const parsed = new URL(url);
  const readableUrl = `${READABLE_BASE_URL}${parsed.pathname}${parsed.search}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || FETCH_TIMEOUT_MS));
  try {
    const response = await fetch(readableUrl, {
      signal: controller.signal,
      headers: {
        Accept: "text/html,*/*;q=0.8",
        "Accept-Encoding": "identity",
        "User-Agent": USER_AGENT,
        "X-Return-Format": "html",
      },
    });
    if (!response.ok) throw new Error(`upstream_${response.status}`);
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function decodeDataImage(value = "") {
  const match = String(value || "").match(/^data:([^;,]*);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) return null;
    const contentType = normalizeImageContentType(match[1], bytes);
    if (!contentType) return null;
    return { bytes, contentType };
  } catch {
    return null;
  }
}

function normalizeImageContentType(value = "", bytes = Buffer.alloc(0)) {
  const declared = String(value || "").toLocaleLowerCase("en-US");
  if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(declared)) return declared;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}

function resolveAllowedRodongPageUrl(value = "") {
  try {
    const parsed = new URL(value, `${RODONG_SOURCE.baseUrl}?`);
    if (parsed.protocol !== "http:") return "";
    if (!/^(?:www\.)?rodong\.rep\.kp$/i.test(parsed.hostname)) return "";
    if (parsed.pathname !== "/ko/index.php") return "";
    if (!parsed.search || parsed.search.length > 900) return "";
    parsed.hostname = "www.rodong.rep.kp";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

function resolveAllowedRodongArticleUrl(value = "") {
  const url = resolveAllowedRodongPageUrl(value);
  if (!url) return "";
  try {
    const token = decodeURIComponent(new URL(url).search.slice(1));
    const decoded = Buffer.from(token, "base64").toString("utf8");
    return /^8@\d{4}-\d{2}-\d{2}-/u.test(decoded) ? url : "";
  } catch {
    return "";
  }
}

function parseRodongArticleUrlDate(value = "") {
  try {
    const url = resolveAllowedRodongPageUrl(value);
    if (!url) return "";
    const token = decodeURIComponent(new URL(url).search.slice(1));
    const decoded = Buffer.from(token, "base64").toString("utf8");
    return decoded.match(/^8@(20\d{2}-\d{2}-\d{2})-/u)?.[1] || "";
  } catch {
    return "";
  }
}

function parseKoreanDate(value = "") {
  const match = String(value || "").match(/(20\d{2})\s*(?:년|[.\/-])\s*(\d{1,2})\s*(?:월|[.\/-])\s*(\d{1,2})/u);
  if (!match) return "";
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function dedupeBy(values = [], getKey) {
  const seen = new Set();
  return values.filter((value) => {
    const key = getKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function mapWithConcurrency(values = [], concurrency = 4, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length || 1) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchRodongDetailHtmlWithRetry(url, fetchHtml) {
  try {
    return await fetchHtml(url);
  } catch (error) {
    if (!shouldRetryRodongDetail(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return fetchHtml(url);
  }
}

function shouldRetryRodongDetail(error) {
  if (error?.name === "AbortError") return false;
  if (error instanceof TypeError) return true;
  return /^upstream_(?:429|5\d\d)$/u.test(String(error?.message || ""));
}
