import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_ORIGIN = "https://nkarchive.vercel.app";
const SITE_NAME = "북한뉴스아카이브";
const SHARE_IMAGE_URL = `${PUBLIC_ORIGIN}/og.png`;
const GENERIC_DESCRIPTION = "조선중앙통신과 로동신문의 보관 기사입니다.";
const META_START = "<!-- NEWS_DOCUMENT_META_START -->";
const META_END = "<!-- NEWS_DOCUMENT_META_END -->";
const ARTICLE_ID_PATTERN = /^(?:news:(?:kcna|rodong-sinmun):[a-f0-9]{24}|kcna-[a-f0-9]{16})$/u;
const PUBLISHED_DATE_PATTERN = /^20\d{2}-\d{2}-\d{2}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/gu;
const DEFAULT_DETAILS_ROOT = fileURLToPath(new URL("../data/news/details", import.meta.url));
const DEFAULT_TEMPLATE_PATH = fileURLToPath(new URL("../news/document-template.html", import.meta.url));
const DEFAULT_TEMPLATE_HTML = fs.readFileSync(DEFAULT_TEMPLATE_PATH, "utf8");

export default function handler(request, response) {
  return createNewsDocumentHandler()(request, response);
}

export function createNewsDocumentHandler({
  detailsRoot = DEFAULT_DETAILS_ROOT,
  templateHtml = DEFAULT_TEMPLATE_HTML,
} = {}) {
  assertMetadataBlock(templateHtml);

  return function newsDocumentHandler(request, response) {
    const method = String(request?.method || "GET").toLocaleUpperCase("en-US");
    if (method !== "GET" && method !== "HEAD") {
      sendHtml(response, {
        body: templateHtml,
        method,
        statusCode: 405,
        cacheControl: "no-store",
        headers: { Allow: "GET, HEAD", "X-Robots-Tag": "noindex, follow" },
      });
      return;
    }

    const articleId = parseArticleId(request?.url);
    if (!articleId) {
      sendHtml(response, {
        body: templateHtml,
        method,
        statusCode: 404,
        cacheControl: "no-store",
        headers: { "X-Robots-Tag": "noindex, follow" },
      });
      return;
    }

    try {
      const article = readPublishedArticle(detailsRoot, articleId);
      if (!article) {
        sendHtml(response, {
          body: templateHtml,
          method,
          statusCode: 404,
          cacheControl: "no-store",
          headers: { "X-Robots-Tag": "noindex, follow" },
        });
        return;
      }

      const metadata = createArticleMetadata(article);
      sendHtml(response, {
        body: replaceMetadataBlock(templateHtml, renderArticleMetadata(metadata)),
        method,
        statusCode: 200,
        cacheControl: "public, max-age=0, s-maxage=86400",
      });
    } catch {
      sendHtml(response, {
        body: templateHtml,
        method,
        statusCode: 503,
        cacheControl: "no-store",
        headers: { "X-Robots-Tag": "noindex, follow" },
      });
    }
  };
}

export function newsDetailShardForId(value) {
  const normalizedId = String(value || "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalizedId.length; index += 1) {
    hash ^= normalizedId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) & 0xff).toString(16).padStart(2, "0");
}

export function createArticleMetadata(article) {
  const articleId = String(article?.id || "");
  if (!ARTICLE_ID_PATTERN.test(articleId)) throw new Error("invalid_article_id");
  const title = normalizeInlineText(article?.title) || "뉴스 기사";
  const canonicalUrl = new URL("/news/document", PUBLIC_ORIGIN);
  canonicalUrl.searchParams.set("id", articleId);
  return {
    canonicalUrl: canonicalUrl.href,
    description: createMeaningfulDescription(article, title),
    publishedTime: PUBLISHED_DATE_PATTERN.test(String(article?.date || ""))
      ? `${article.date}T00:00:00+09:00`
      : "",
    title,
  };
}

function parseArticleId(requestUrl) {
  try {
    const url = new URL(String(requestUrl || ""), PUBLIC_ORIGIN);
    const values = url.searchParams.getAll("id");
    if (values.length !== 1) return "";
    const articleId = values[0];
    if (!ARTICLE_ID_PATTERN.test(articleId)) return "";
    const canonicalSearch = `?id=${encodeURIComponent(articleId)}`;
    return url.search === canonicalSearch ? articleId : "";
  } catch {
    return "";
  }
}

function readPublishedArticle(detailsRoot, articleId) {
  const shard = newsDetailShardForId(articleId);
  const shardPath = path.join(detailsRoot, `${shard}.json`);
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(shardPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (payload?.shard !== shard || !payload.articles || !Object.hasOwn(payload.articles, articleId)) return null;
  const article = payload.articles[articleId];
  if (!article || article.id !== articleId || article.mediaType !== "article") return null;
  return article;
}

function createMeaningfulDescription(article, normalizedTitle) {
  const titleLines = normalizeMultilineText(article?.title)
    .split("\n")
    .map(normalizeInlineText)
    .filter(Boolean);
  const comparableTitleLines = titleLines.map((line, index) => (
    article?.sourceId === "rodong-sinmun" && index === titleLines.length - 1
      ? line.replace(/\s+\[[1-9]\d*면\]$/u, "").trim()
      : line
  ));
  const comparableInlineTitle = normalizeInlineText(comparableTitleLines.join(" "));
  const bodyParagraphs = normalizeMultilineText(article?.body)
    .split(/\n+/u)
    .map(normalizeInlineText)
    .filter(Boolean);

  let paragraphIndex = 0;
  const titlePrefixMatches = titleLines.length > 0 && titleLines.every((line, index) => (
    bodyParagraphs[index] === line || bodyParagraphs[index] === comparableTitleLines[index]
  ));
  if (titlePrefixMatches) paragraphIndex = titleLines.length;
  else if (bodyParagraphs[0] === normalizedTitle || bodyParagraphs[0] === comparableInlineTitle) paragraphIndex = 1;
  while (paragraphIndex < bodyParagraphs.length && isSourceDateline(bodyParagraphs[paragraphIndex])) {
    paragraphIndex += 1;
  }

  let description = bodyParagraphs[paragraphIndex] || "";
  if (!description) {
    const snippet = normalizeInlineText(article?.snippet);
    const snippetRepeatsTitle = titleLines.includes(snippet)
      || comparableTitleLines.includes(snippet)
      || snippet === normalizedTitle
      || snippet === comparableInlineTitle;
    if (snippet && !snippetRepeatsTitle && !isSourceDateline(snippet)) description = snippet;
  }
  if (!description) {
    const sourceName = normalizeInlineText(article?.sourceName);
    description = sourceName ? `${sourceName}의 보관 기사입니다.` : GENERIC_DESCRIPTION;
  }
  return truncateDescription(description, 180);
}

function isSourceDateline(value) {
  const text = normalizeInlineText(value);
  if (!/^\([^()]{1,180}\)$/u.test(text)) return false;
  return /(?:\d{1,2}월\s*\d{1,2}일|조선중앙통신|로동신문|발\s)/u.test(text);
}

function truncateDescription(value, maximumLength) {
  const characters = Array.from(normalizeInlineText(value));
  if (characters.length <= maximumLength) return characters.join("");
  let truncated = characters.slice(0, maximumLength).join("");
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maximumLength * 0.7)) truncated = truncated.slice(0, lastSpace);
  return `${truncated.replace(/[\s,.;:!?·]+$/gu, "")}…`;
}

function normalizeMultilineText(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(CONTROL_CHARACTER_PATTERN, (character) => character === "\n" ? "\n" : " ")
    .replace(/[\t ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .trim();
}

function normalizeInlineText(value) {
  return normalizeMultilineText(value).replace(/\s+/gu, " ").trim();
}

function renderArticleMetadata({ canonicalUrl, description, publishedTime, title }) {
  const pageTitle = `${title} · ${SITE_NAME}`;
  const lines = [
    `<title>${escapeHtml(pageTitle)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`,
    '<meta property="og:type" content="article" />',
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    '<meta property="og:locale" content="ko_KR" />',
    `<meta property="og:image" content="${SHARE_IMAGE_URL}" />`,
    `<meta property="og:image:secure_url" content="${SHARE_IMAGE_URL}" />`,
    '<meta property="og:image:type" content="image/png" />',
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    `<meta property="og:image:alt" content="${SITE_NAME}" />`,
  ];
  if (publishedTime) lines.push(`<meta property="article:published_time" content="${escapeHtml(publishedTime)}" />`);
  lines.push(
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${SHARE_IMAGE_URL}" />`,
    `<meta name="twitter:image:alt" content="${SITE_NAME}" />`,
  );
  return lines.join("\n    ");
}

function replaceMetadataBlock(templateHtml, metadataHtml) {
  const startIndex = templateHtml.indexOf(META_START);
  const endIndex = templateHtml.indexOf(META_END, startIndex + META_START.length);
  if (startIndex < 0 || endIndex < 0) throw new Error("missing_news_document_metadata_block");
  const contentStart = startIndex + META_START.length;
  return `${templateHtml.slice(0, contentStart)}\n    ${metadataHtml}\n    ${templateHtml.slice(endIndex)}`;
}

function assertMetadataBlock(templateHtml) {
  const startIndex = templateHtml.indexOf(META_START);
  const endIndex = templateHtml.indexOf(META_END);
  if (startIndex < 0 || endIndex <= startIndex
    || templateHtml.indexOf(META_START, startIndex + META_START.length) !== -1
    || templateHtml.indexOf(META_END, endIndex + META_END.length) !== -1) {
    throw new Error("invalid_news_document_metadata_block");
  }
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function sendHtml(response, {
  body,
  method,
  statusCode,
  cacheControl,
  headers = {},
}) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Language", "ko");
  response.setHeader("Cache-Control", cacheControl);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(method === "HEAD" ? "" : body);
}
