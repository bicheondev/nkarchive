import * as cheerio from "cheerio";

const KCNA_ORIGIN = "http://www.kcna.kp";
const RODONG_HOME_URL = "http://www.rodong.rep.kp/ko/";
const RODONG_ORIGIN = new URL(RODONG_HOME_URL).origin;
const RODONG_JINA_ORIGIN = "https://r.jina.ai";
const DEFAULT_HTML_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 25_000;
const NEWS_USER_AGENT = "DPRKArchiveNewsLatest/1.0 (+https://nkarchive.vercel.app/news)";

/**
 * The exact official first-page listings used by the access-time freshness
 * endpoint. Keeping these explicit prevents an upstream page from expanding
 * the crawler's request surface.
 */
export const KCNA_CATEGORY_LISTS = Object.freeze([
  Object.freeze({ id: "leadership", label: "혁명활동소식", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/b0721b9f23054ddc7fe56c2811a12715` }),
  Object.freeze({ id: "important", label: "중요소식", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/6a47505ba5268fd7749c0fe11e4b24b4` }),
  Object.freeze({ id: "international", label: "국제소식", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/ecc14533d88be93068af4178946b1b05` }),
  Object.freeze({ id: "photo", label: "사진", kind: "photo", url: `${KCNA_ORIGIN}/kp/gallery/list/6837a75abf5c6249d0e39ee758e763ea` }),
  Object.freeze({ id: "anecdote", label: "혁명일화", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/503e9b606704f9b1c625fa5755928cd3` }),
  Object.freeze({ id: "document", label: "문건", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/1afa96195f9b303902490a126ab7285f` }),
  Object.freeze({ id: "foreign", label: "대외관계", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/e2f336db98b5e69c75e0da264e037e8d` }),
  Object.freeze({ id: "video", label: "동화상", kind: "video", url: `${KCNA_ORIGIN}/kp/video/list/6837a75abf5c6249d0e39ee758e763ea` }),
  Object.freeze({ id: "memory", label: "인민은 못 잊습니다", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/7bc083f00425be6aadfb828fba1cb5a7` }),
  Object.freeze({ id: "domestic", label: "국내소식", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/2f7d854121ccbbfbe6feae9fdcc3556e` }),
  Object.freeze({ id: "social", label: "사회생활", kind: "article", url: `${KCNA_ORIGIN}/kp/article/list/680e40b40899891bbe75a7072e3285e7` }),
]);

/** Only anchors bearing one of these visible labels can seed a Rodong request. */
export const RODONG_CATEGORY_LABELS = Object.freeze({
  "혁명활동소식": "leadership",
  "오늘호 기사": "important",
  "사진": "photo",
  "인민을 위한 정치": "anecdote",
  "동영상": "video",
  "사회문화생활": "memory",
  "전진하는 조선": "domestic",
  "유구한 력사,찬란한 문화": "social",
});

const DETAIL_PATH_PATTERNS = Object.freeze({
  article: /^\/(?:kp)\/article\/(?:q|detail)\/[-a-z0-9.]+\/?$/iu,
  photo: /^\/(?:kp)\/gallery\/detail\/[-a-z0-9.]+\/?$/iu,
  video: /^\/(?:kp)\/video\/detail\/[-a-z0-9.]+\/?$/iu,
});

export function parseKcnaListing(html = "", listingUrl = "", category = {}) {
  const safeListingUrl = normalizeHttpUrl(listingUrl);
  const origin = new URL(safeListingUrl).origin;
  const $ = cheerio.load(String(html || ""));
  const entries = [];
  const seen = new Set();

  if (["photo", "video"].includes(String(category.kind || ""))) {
    entries.push(...parseKcnaMediaListingEntries($, safeListingUrl, category, origin));
  } else {
    $("a[href]").each((_, element) => {
      const rawHref = String($(element).attr("href") || "").trim();
      const url = resolveSameOriginUrl(rawHref, safeListingUrl);
      if (!url || new URL(url).origin !== origin) return;
      const kind = classifyKcnaDetailPath(new URL(url).pathname);
      if (!kind || (category.kind && kind !== category.kind)) return;
      if (seen.has(url)) return;
      const scope = findListingItemScope($, element);
      const scopeText = normalizedText(scope.text());
      const rawTitle = normalizedTitleText(
        $(element).attr("title")
        || cloneTextWithoutMedia($, $(element))
        || firstCandidateText($, scope, "h1, h2, h3, h4, .title, [class*=title]"),
      );
      const title = stripTrailingDate(rawTitle);
      if (!isPlausibleTitle(title)) return;
      const date = normalizeDate(scopeText) || normalizeDate(rawTitle);
      const previewImageUrl = firstSameOriginImageUrl($, scope, safeListingUrl, { kcnaPhotoOnly: false });
      const hasCamera = hasCameraMarker($, scope) || Boolean(previewImageUrl) || kind === "photo";
      entries.push({
        sourceId: "kcna",
        category: { id: String(category.id || kind), label: String(category.label || "") },
        categories: [String(category.id || kind)],
        kind,
        title,
        date,
        url,
        previewImageUrl,
        markers: { camera: hasCamera, gallery: kind === "photo" || /gallery/iu.test(rawHref) },
      });
      seen.add(url);
    });
  }

  return {
    entries,
    pageUrls: discoverKcnaPageUrls($, safeListingUrl),
    pagination: parseKcnaPagination($, safeListingUrl),
  };
}

function parseKcnaMediaListingEntries($, listingUrl, category, origin) {
  const kind = String(category.kind || "");
  const itemClass = kind === "photo" ? "gallery" : "video";
  const mainItems = $(`main .${itemClass}`);
  const items = mainItems.length ? mainItems : $(`.${itemClass}`);
  const entries = [];
  const seen = new Set();

  items.each((_, element) => {
    const item = $(element);
    const anchorElements = [
      ...(item.is("a[href]") ? [element] : []),
      ...item.find("a[href]").toArray(),
    ];
    const matchingAnchors = anchorElements.flatMap((anchor) => {
      const url = resolveSameOriginUrl($(anchor).attr("href"), listingUrl);
      return Boolean(url)
        && new URL(url).origin === origin
        && classifyKcnaDetailPath(new URL(url).pathname) === kind
        ? [{ anchor, url }]
        : [];
    });
    if (!matchingAnchors.length) return;
    const uniqueUrls = [...new Set(matchingAnchors.map((record) => record.url))];
    if (uniqueUrls.length !== 1) return;
    const url = uniqueUrls[0];
    if (!url || seen.has(url)) return;

    const titleCandidates = [
      ...matchingAnchors.flatMap(({ anchor }) => [
        normalizedText($(anchor).attr("title")),
        cloneTextWithoutMedia($, $(anchor)),
      ]),
      ...item.find("h1, h2, h3, h4, h5, h6").map((__, heading) => normalizedText($(heading).text())).get(),
      ...item.find("img[alt]").map((__, image) => normalizedText($(image).attr("alt"))).get(),
    ];
    const title = titleCandidates
      .map((candidate) => stripTrailingDate(candidate))
      .find((candidate) => isPlausibleTitle(candidate) && normalizedLabel(candidate) !== "전체") || "";
    const dateScope = item.clone();
    dateScope.find("a[href], img, picture, video, source, svg").remove();
    const date = firstDateWithinNode($, item)
      || normalizeDate(dateScope.text())
      || normalizeDate(item.text());
    if (!title || !date) return;

    const previewOptions = { sourceId: "kcna", allowData: true };
    const previewImageUrl = matchingAnchors
      .map(({ anchor }) => firstSameOriginImageUrl($, $(anchor), listingUrl, previewOptions))
      .find(Boolean)
      || firstSameOriginImageUrl($, item, listingUrl, previewOptions);
    entries.push({
      sourceId: "kcna",
      category: { id: String(category.id || kind), label: String(category.label || "") },
      categories: [String(category.id || kind)],
      kind,
      title,
      date,
      url,
      previewImageUrl,
      previewReferer: listingUrl,
      markers: { camera: Boolean(previewImageUrl) || kind === "photo", gallery: kind === "photo" },
    });
    seen.add(url);
  });

  return entries;
}

function parseKcnaPagination(input, listingUrl = "") {
  const safeListingUrl = normalizeHttpUrl(listingUrl);
  const $ = typeof input === "function" && input.root ? input : cheerio.load(String(input || ""));
  const listingKind = new URL(safeListingUrl).pathname.match(/^\/(?:kp)\/(article|gallery|video)\/list\//iu)?.[1]?.toLowerCase();
  if (!listingKind) return null;
  const form = $(`form#${listingKind}_form[method]`).first();
  if (!form.length || String(form.attr("method") || "").toUpperCase() !== "POST") return null;
  const actionUrl = resolveSameOriginUrl(form.attr("action"), safeListingUrl);
  if (!actionUrl) return null;
  const action = new URL(actionUrl);
  const listing = new URL(safeListingUrl);
  if (action.pathname !== listing.pathname || action.search) return null;
  const valueOf = (name) => String(form.find(`input[name='${name}']`).first().attr("value") || "");
  const csrf = valueOf("_csrf");
  const keywordInput = form.find("input[name='keyword']").first();
  const keyword = keywordInput.length ? String(keywordInput.attr("value") || "") : null;
  const configuredPerPage = Number(valueOf("cnt_per_page") || 0);
  const scripts = $("script").map((_, element) => String($(element).html() || "")).get().join("\n");
  const declaredTotal = Number(scripts.match(/\bvar\s+total\s*=\s*(\d{1,7})\s*;/u)?.[1] ?? NaN);
  const currentPage = Number(scripts.match(/\bvar\s+cur_page\s*=\s*(\d{1,5})\s*;/u)?.[1] ?? NaN);
  const perPage = Number(scripts.match(/\bvar\s+per_page\s*=\s*(\d{1,4})\s*;/u)?.[1] ?? NaN);
  const pageCount = Number(scripts.match(/\bvar\s+page_cnt\s*=\s*(\d{1,5})\s*;/u)?.[1] ?? NaN);
  if (!/^[A-Za-z0-9_-]{8,512}$/u.test(csrf)
    || !Number.isInteger(declaredTotal) || declaredTotal < 0 || declaredTotal > 1_000_000
    || !Number.isInteger(currentPage) || currentPage < 1 || currentPage > 10_000
    || !Number.isInteger(perPage) || perPage < 1 || perPage > 1_000
    || configuredPerPage !== perPage
    || !Number.isInteger(pageCount) || pageCount < 0 || pageCount > 10_000
    || pageCount !== Math.ceil(declaredTotal / perPage)
    || (pageCount > 0 && currentPage > pageCount)) return null;
  return { actionUrl, csrf, currentPage, perPage, pageCount, declaredTotal, keyword };
}

export function parseRodongHomepageCategories(html = "", homepageUrl = "", categoryLabels = RODONG_CATEGORY_LABELS) {
  const safeHomepageUrl = normalizeHttpUrl(homepageUrl);
  const $ = cheerio.load(String(html || ""));
  const normalizedLabels = new Map(
    Object.entries(categoryLabels || {}).map(([label, id]) => [normalizedLabel(label), String(id)]),
  );
  const categories = [];
  const seenCodes = new Set();

  const appendCategory = (labelValue, rawHref) => {
    const label = normalizedLabel(labelValue);
    const id = normalizedLabels.get(label);
    if (!id) return;
    const url = resolveSameOriginUrl(rawHref, safeHomepageUrl);
    if (!url) return;
    const token = parseRodongCategoryToken(url);
    if (!token || token.page !== 1 || seenCodes.has(token.categoryCode)) return;
    categories.push({ id, label: normalizedText(labelValue), categoryCode: token.categoryCode, url });
    seenCodes.add(token.categoryCode);
  };

  $("a[href]").each((_, element) => {
    appendCategory($(element).text(), $(element).attr("href"));
  });

  $(".TopClassTitle").each((_, element) => {
    const heading = $(element);
    const sectionHeader = heading.closest(".TopClassBG");
    const moreLink = sectionHeader.find(".TopClassLink a[href], a.page_link[href]").first();
    if (!moreLink.length) return;
    appendCategory(heading.text(), moreLink.attr("href"));
  });

  return categories;
}

export function parseRodongListing(html = "", listingUrl = "", category = {}) {
  const safeListingUrl = normalizeHttpUrl(listingUrl);
  const $ = cheerio.load(String(html || ""));
  const entries = category.id === "photo"
    ? parseRodongPhotoListingEntries($, safeListingUrl, category)
    : [];
  const pageLinks = [];
  const seenEntries = new Set(entries.map((entry) => entry.url));
  const seenPages = new Set();

  $("a[href]").each((_, element) => {
    const url = resolveSameOriginUrl($(element).attr("href"), safeListingUrl);
    if (!url) return;
    const categoryToken = parseRodongCategoryToken(url);
    if (categoryToken) {
      const pageIdentity = `${categoryToken.categoryCode}:${categoryToken.page}`;
      if (!seenPages.has(pageIdentity)) {
        pageLinks.push({ ...categoryToken, url });
        seenPages.add(pageIdentity);
      }
    }
  });

  const entryAnchors = selectRodongListingEntryAnchors($, category);
  entryAnchors.each((_, element) => {
    const url = resolveSameOriginUrl($(element).attr("href"), safeListingUrl);
    if (!url || parseRodongCategoryToken(url)) return;
    const detailToken = category.id === "video"
      ? parseRodongVideoToken(url)
      : parseRodongDetailToken(url);
    if (!detailToken || seenEntries.has(url)) return;
    if (category.id !== "video"
      && category.categoryCode
      && detailToken.categoryCode !== String(category.categoryCode)) return;
    const scope = findListingItemScope($, element);
    const linkTitle = cloneTextWithoutMedia($, $(element));
    const scopedTitle = firstCandidateText($, scope, "h1, h2, h3, h4, .title, [class*=title]");
    const rawTitle = normalizedTitleText(category.id === "video"
      ? scopedTitle || $(element).attr("title") || linkTitle
      : linkTitle || $(element).attr("title") || scopedTitle);
    const title = stripTrailingDate(rawTitle);
    if (!isPlausibleTitle(title)) return;
    const date = normalizeDate(scope.text()) || detailToken.date;
    const previewImageUrl = firstSameOriginImageUrl($, scope, safeListingUrl, {
      sourceId: "rodong-sinmun",
      allowData: true,
    });
    entries.push({
      sourceId: "rodong-sinmun",
      category: { id: String(category.id || "uncategorized"), label: String(category.label || "") },
      categories: [String(category.id || "uncategorized")],
      categoryCode: String(category.categoryCode || detailToken.categoryCode || ""),
      kind: category.id === "photo" ? "photo" : category.id === "video" ? "video" : "article",
      title,
      date,
      url,
      previewImageUrl,
      markers: { camera: Boolean(previewImageUrl) || hasCameraMarker($, scope), gallery: category.id === "photo" },
    });
    seenEntries.add(url);
  });

  pageLinks.sort((left, right) => left.page - right.page);
  const currentPage = parseRodongCategoryToken(safeListingUrl)?.page || 1;
  const selectedCategoryCode = String(category.categoryCode || "");
  const categoryPageLinks = selectedCategoryCode
    ? pageLinks.filter((pageLink) => pageLink.categoryCode === selectedCategoryCode)
    : pageLinks;
  const declaredLastPage = Math.max(currentPage, ...categoryPageLinks.map((pageLink) => pageLink.page));
  const pathText = normalizedText($("#PathBar").first().text());
  const declaredTotalMatch = pathText.match(/(?:^|[>\s])([0-9]{1,7})\s*건(?:$|\s)/u);
  const declaredTotal = declaredTotalMatch ? Number(declaredTotalMatch[1]) : null;
  return { entries, pageLinks, pagination: { currentPage, declaredLastPage, declaredTotal } };
}

function selectRodongListingEntryAnchors($, category) {
  const categoryId = String(category.id || "");
  if (categoryId === "photo") return $([]);
  if (categoryId === "video" || categoryId === "social") return $("a[href]");
  let roots;
  if (categoryId === "leadership") roots = $("#RevoListDIV").first();
  else if (["anecdote", "domestic", "memory"].includes(categoryId)) roots = $("#ThemeListDIV").first();
  else if (categoryId === "important") roots = $("#revoList > .date_news_list .media-body");
  else return $("a[href]");
  if (!roots.length) throw new Error(`Rodong ${categoryId} listing is missing its official list root`);
  return roots.find("a[href]").add(roots.filter("a[href]"));
}

function parseRodongPhotoListingEntries($, listingUrl, category) {
  const entries = [];
  const seen = new Set();
  $("script").each((_, element) => {
    const source = String($(element).html() || "");
    const className = source.match(/\$\(["']\.([a-z0-9_-]+)["']\)\.click/iu)?.[1] || "";
    if (!className || !/^fancybox-[a-z0-9_-]+$/iu.test(className)) return;
    const scope = $(`a.${className}`).first().closest(".thumbnail");
    if (!scope.length) return;
    const title = titleTextFromNode($, scope.find(".span-title").first());
    const date = normalizeDate(scope.find(".gallery_cal, .artDate, .date").first().text())
      || normalizeDate(source.match(/his\(["']([^"']+)["']\)/u)?.[1] || "");
    if (!isPlausibleTitle(title) || !date) return;
    const imageReferences = [];
    for (const match of source.matchAll(/\bhref\s*:\s*["']([^"']+)["']/giu)) {
      const url = resolveSameOriginUrl(match[1], listingUrl);
      if (!url || imageReferences.some((reference) => reference.url === url)) continue;
      imageReferences.push({ url, referer: listingUrl, role: "gallery" });
    }
    if (!imageReferences.length) return;
    const url = imageReferences[0].url;
    if (seen.has(url)) return;
    entries.push({
      sourceId: "rodong-sinmun",
      category: { id: String(category.id || "photo"), label: String(category.label || "") },
      categories: [String(category.id || "photo")],
      categoryCode: String(category.categoryCode || "8"),
      kind: "photo",
      title,
      date,
      url,
      previewImageUrl: "",
      embeddedImageReferences: imageReferences,
      markers: { camera: true, gallery: true },
    });
    seen.add(url);
  });
  return entries;
}

function decodeRodongToken(input = "") {
  let token = String(input || "").trim();
  if (!token) return "";
  try {
    if (/^https?:/iu.test(token)) token = new URL(token).search.slice(1);
  } catch {
    return "";
  }
  if (token.includes("&")) token = token.split("&", 1)[0];
  try {
    token = decodeURIComponent(token).replace(/ /gu, "+");
  } catch {
    return "";
  }
  if (!/^[A-Za-z0-9+/_=-]{2,4096}$/u.test(token)) return "";
  try {
    const decoded = Buffer.from(token.replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8");
    if (!decoded || decoded.includes("\uFFFD") || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(decoded)) return "";
    return decoded;
  } catch {
    return "";
  }
}

function parseRodongCategoryToken(input = "") {
  const decoded = decodeRodongToken(input);
  const match = decoded.match(/^1@@([1-9]\d{0,4})@([1-9]\d{0,4})@(?:@0@)?$/u);
  if (!match) return null;
  return { page: Number(match[2]), categoryCode: match[1], decoded };
}

function parseRodongDetailToken(input = "") {
  const decoded = decodeRodongToken(input);
  const match = decoded.match(/^12@(20\d{2}-\d{2}-\d{2})-\d{3}@([1-9]\d{0,4})@/u);
  if (!match) return null;
  return { date: normalizeDate(match[1]), categoryCode: match[2], decoded };
}

function parseRodongVideoToken(input = "") {
  const decoded = decodeRodongToken(input);
  const match = decoded.match(/^10@(20\d{2}-\d{2}-\d{2})-\d{3}@/u);
  if (!match) return null;
  return { date: normalizeDate(match[1]), decoded };
}

function resolveSameOriginUrl(rawUrl = "", baseUrl = "") {
  const raw = String(rawUrl || "").trim();
  if (!raw || /^(?:data|blob|javascript|mailto|tel):/iu.test(raw)) return "";
  try {
    const base = new URL(normalizeHttpUrl(baseUrl));
    const target = new URL(raw, base);
    if (!/^https?:$/u.test(target.protocol) || target.origin !== base.origin) return "";
    target.hash = "";
    return target.href;
  } catch {
    return "";
  }
}

/**
 * Fetch an HTML response with a hard deadline, byte ceiling, explicit manual
 * redirects, and same-origin redirect enforcement. The endpoint supplies only
 * fixed official or fixed Jina URLs to this helper.
 */
export async function fetchBoundedHtml(url, options = {}) {
  const safeUrl = normalizeHttpUrl(url);
  const maxBytes = boundedInteger(options.htmlMaxBytes, 1_024, 64 * 1024 * 1024, DEFAULT_HTML_MAX_BYTES);
  const response = await fetchBoundedBytes(safeUrl, { ...options, maxBytes });
  if (/^(?:image|audio|video)\//iu.test(response.contentType)
    || /application\/(?:pdf|octet-stream)/iu.test(response.contentType)) {
    throw new Error(`Expected HTML from ${safeUrl}, received ${response.contentType}`);
  }
  return decodeHtml(response.bytes, response.contentType);
}

export function buildRodongHtmlFallbackUrl(url = "") {
  const officialUrl = normalizeHttpUrl(url);
  if (new URL(officialUrl).origin !== RODONG_ORIGIN) {
    throw new Error("Rodong HTML fallback accepts only the official origin");
  }
  return `${RODONG_JINA_ORIGIN}/${officialUrl}`;
}

async function fetchBoundedBytes(url, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Fetch implementation is required");
  const initialUrl = normalizeHttpUrl(url);
  const initialOrigin = new URL(initialUrl).origin;
  const timeoutMs = boundedInteger(options.timeoutMs, 100, 120_000, DEFAULT_TIMEOUT_MS);
  const maxRedirects = boundedInteger(options.maxRedirects, 0, 10, DEFAULT_MAX_REDIRECTS);
  const maxBytes = boundedInteger(options.maxBytes, 1_024, 64 * 1024 * 1024, DEFAULT_HTML_MAX_BYTES);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request exceeded ${timeoutMs}ms`)), timeoutMs);
  const headers = {
    Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    "Accept-Encoding": "identity",
    "User-Agent": NEWS_USER_AGENT,
    ...(options.extraHeaders || {}),
  };
  let currentUrl = initialUrl;
  let redirectCount = 0;
  try {
    while (true) {
      if (new URL(normalizeHttpUrl(currentUrl)).origin !== initialOrigin) {
        throw new Error(`Cross-origin redirect rejected: ${currentUrl}`);
      }
      const response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers,
        signal: controller.signal,
      });
      if (!response || typeof response.arrayBuffer !== "function") {
        throw new Error("Fetcher returned an invalid response");
      }
      if (response.redirected === true) {
        await cancelResponseBody(response);
        throw new Error("Fetcher followed a redirect despite manual redirect mode");
      }
      if (response.url) {
        const responseUrl = normalizeHttpUrl(response.url);
        if (new URL(responseUrl).origin !== initialOrigin) {
          await cancelResponseBody(response);
          throw new Error(`Cross-origin redirect rejected: ${responseUrl}`);
        }
        if (responseUrl !== currentUrl) {
          await cancelResponseBody(response);
          throw new Error(`Fetcher returned an unexpected response URL: ${responseUrl}`);
        }
      }
      const location = String(response.headers?.get?.("location") || "").trim();
      if (isRedirectStatus(response.status) && location) {
        if (redirectCount >= maxRedirects) {
          await cancelResponseBody(response);
          throw new Error(`Redirect limit of ${maxRedirects} exceeded for ${initialUrl}`);
        }
        await cancelResponseBody(response);
        currentUrl = resolveSameOriginRedirect(location, currentUrl, initialOrigin);
        redirectCount += 1;
        continue;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error(`HTTP ${response.status} for ${currentUrl}`);
      }
      const contentLength = Number(response.headers?.get?.("content-length") || 0);
      if (contentLength && contentLength > maxBytes) {
        await cancelResponseBody(response);
        throw new Error(`Response exceeds ${maxBytes} bytes`);
      }
      const bytes = await readResponseBytes(response, maxBytes);
      if (!bytes.length) throw new Error(`Empty response from ${currentUrl}`);
      return {
        bytes,
        contentType: String(response.headers?.get?.("content-type") || "").trim().toLowerCase(),
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

function resolveSameOriginRedirect(location, currentUrl, initialOrigin) {
  let nextUrl;
  try {
    nextUrl = normalizeHttpUrl(new URL(String(location || ""), currentUrl).href);
  } catch {
    throw new Error(`Invalid redirect target from ${currentUrl}`);
  }
  if (new URL(nextUrl).origin !== initialOrigin) throw new Error(`Cross-origin redirect rejected: ${nextUrl}`);
  return nextUrl;
}

async function cancelResponseBody(response) {
  if (typeof response.body?.cancel !== "function") return;
  await response.body.cancel().catch(() => {});
}

async function readResponseBytes(response, maxBytes) {
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function decodeHtml(bytes, contentType = "") {
  const charset = String(contentType).match(/charset=([^;\s]+)/iu)?.[1]?.toLowerCase() || "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString("utf8");
  }
}

function discoverKcnaPageUrls($, listingUrl) {
  const listing = new URL(listingUrl);
  const results = new Set();
  $("a[href]").each((_, element) => {
    const rawHref = String($(element).attr("href") || "").trim();
    const jsPage = rawHref.match(/^javascript:\s*page\((\d{1,4})\)\s*;?$/iu)?.[1];
    if (jsPage) {
      const pageUrl = new URL(listing.href);
      pageUrl.searchParams.set("page", jsPage);
      results.add(pageUrl.href);
      return;
    }
    const url = resolveSameOriginUrl(rawHref, listingUrl);
    if (!url) return;
    const candidate = new URL(url);
    if (candidate.pathname === listing.pathname
      && /^\d{1,4}$/u.test(candidate.searchParams.get("page") || "")) results.add(candidate.href);
  });
  results.delete(listing.href);
  return [...results].sort((left, right) => (
    Number(new URL(left).searchParams.get("page")) - Number(new URL(right).searchParams.get("page"))
  ));
}

function classifyKcnaDetailPath(pathname) {
  return Object.entries(DETAIL_PATH_PATTERNS).find(([, pattern]) => pattern.test(pathname))?.[0] || "";
}

function findListingItemScope($, element) {
  const direct = $(element).closest("li, article, tr, .thumbnail, .media, .article, .block, .list-item, .list_item, .news-item, .news_item, .item, .row");
  if (direct.length) return direct.first();
  let current = $(element);
  for (let depth = 0; depth < 4; depth += 1) {
    const parent = current.parent();
    if (!parent.length) break;
    current = parent;
    if (normalizeDate(current.text()) || current.find("time, .date, [class*=date]").length) return current;
  }
  return $(element).parent();
}

function cloneTextWithoutMedia($, node) {
  const clone = node.clone();
  clone.find("img, picture, video, svg, i, time, .date, [class*=date]").remove();
  return titleTextFromNode($, clone);
}

function firstCandidateText($, node, selectors) {
  let value = "";
  node.find(selectors).each((_, element) => {
    if (!value) value = titleTextFromNode($, $(element));
  });
  return value;
}

function hasCameraMarker($, node) {
  if (!node?.length) return false;
  return node.find("img, i, svg, a, [class]").toArray().some((element) => {
    const candidate = $(element);
    const metadata = normalizedText([
      candidate.attr("class"),
      candidate.attr("alt"),
      candidate.attr("title"),
      candidate.attr("href"),
    ].filter(Boolean).join(" "));
    const videoOnly = /(?:video[-_ ]?camera|video_button|\/video\/detail\/|동화상)/iu.test(metadata)
      || candidate.closest(".video_button, a[href*='/video/detail/']").length > 0;
    const explicitPhoto = /(?:📷|사진|(?:^|[-_\s])photo(?:[-_\s]|$)|(?:^|[-_\s])gallery(?:[-_\s]|$)|gallery_button)/iu.test(metadata)
      || candidate.closest(".gallery_button, a[href*='/gallery/detail/']").length > 0;
    if (videoOnly && !explicitPhoto) return false;
    return explicitPhoto || /(?:^|[-_\s])camera(?:[-_\s]|$)/iu.test(metadata);
  });
}

function firstSameOriginImageUrl($, node, baseUrl, options = {}) {
  return collectImageReferences($, node, baseUrl, { ...options, role: "preview" })[0]?.url || "";
}

function collectImageReferences($, node, baseUrl, options = {}) {
  const result = [];
  const seen = new Set();
  const root = node?.length ? node : $.root();
  root.find("img, source").each((_, element) => {
    const candidateValues = [
      $(element).attr("data-src"),
      $(element).attr("data-original"),
      $(element).attr("data-lazy-src"),
      $(element).attr("src"),
      firstSrcsetUrl($(element).attr("srcset")),
    ];
    for (const rawValue of candidateValues) {
      const raw = String(rawValue || "").trim();
      if (!raw) continue;
      if (options.allowData && /^data:(?:image\/[a-z0-9.+-]+)?;base64,/iu.test(raw)) {
        if (!seen.has(raw)) result.push({ url: raw, referer: baseUrl, role: options.role || "inline" });
        seen.add(raw);
        break;
      }
      const url = resolveSameOriginUrl(raw, baseUrl);
      if (!url || seen.has(url)) continue;
      const parsed = new URL(url);
      if (options.kcnaPhotoOnly && !/^\/photo\//iu.test(parsed.pathname)) continue;
      if (isDecorativeImageUrl(parsed, $, element, options.sourceId)) continue;
      result.push({ url, referer: baseUrl, role: options.role || "inline" });
      seen.add(url);
      break;
    }
  });
  return result;
}

function isDecorativeImageUrl(url, $, element, sourceId = "") {
  const metadata = normalizedText([
    url.pathname,
    $(element).attr("class"),
    $(element).attr("id"),
    $(element).attr("alt"),
    $(element).attr("title"),
  ].filter(Boolean).join(" "));
  if (/(?:^|[\s/_.-])(?:arrow|banner|button|calendar|icon|loader|logo|mark|newsf|page-bottom|share|spacer|sprite)(?:$|[\s/_.-])/iu.test(metadata)) return true;
  return sourceId === "rodong-sinmun" && /\/images\/(?:rodong_mark|newsf)\./iu.test(url.pathname);
}

function firstSrcsetUrl(value = "") {
  return String(value || "").split(",", 1)[0]?.trim().split(/\s+/u, 1)[0] || "";
}

function firstDateWithinNode($, node) {
  let date = "";
  const elements = [
    ...(node.is("time, .date, [class*=date], [id*=date]") ? node.toArray() : []),
    ...node.find("time, .date, [class*=date], [id*=date]").toArray(),
  ];
  elements.forEach((element) => {
    if (!date) date = normalizeDate($(element).attr("datetime") || $(element).text());
  });
  return date;
}

function normalizeDate(value = "") {
  const text = normalizedText(value);
  const match = text.match(/(?:^|\D)(20\d{2})\s*(?:[.\/-]|년)\s*(\d{1,2})\s*(?:[.\/-]|월)\s*(\d{1,2})(?:\s*일)?(?:\.|\b|$)/u);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function stripTrailingDate(value = "") {
  return normalizedTitleText(value)
    .replace(/\s*[\[(]?20\d{2}\s*[.\/-]\s*\d{1,2}\s*[.\/-]\s*\d{1,2}\s*\.?[\])]?\s*$/u, "")
    .replace(/\s*(?:📷|camera)\s*$/iu, "")
    .trim();
}

const TITLE_BREAK_SENTINEL = "\uE000";

function titleTextFromNode($, node) {
  if (!node?.length) return "";
  const clone = node.clone();
  clone.find("br").replaceWith(TITLE_BREAK_SENTINEL);
  return String(clone.text() || "")
    .split(TITLE_BREAK_SENTINEL)
    .map((line) => normalizedText(line))
    .filter(Boolean)
    .join("\n");
}

function normalizedTitleText(value = "") {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .split(/\n+/u)
    .map((line) => normalizedText(line))
    .filter(Boolean)
    .join("\n");
}

function normalizedText(value = "") {
  return String(value || "").replace(/\u00a0/gu, " ").replace(/[\t\r\n ]+/gu, " ").trim();
}

function normalizedLabel(value = "") {
  return normalizedText(value).replace(/\s*[,，]\s*/gu, ",");
}

function isPlausibleTitle(value = "") {
  const title = normalizedText(value);
  return title.length >= 2
    && title.length <= 500
    && !/^(?:조선중앙통신|로동신문|사진|동화상|다음|이전|＞+|<+)$/u.test(title);
}

function normalizeHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error(`Invalid URL: ${String(value || "")}`);
  }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password) {
    throw new Error(`Unsupported URL: ${url.href}`);
  }
  url.hash = "";
  return url.href;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}
