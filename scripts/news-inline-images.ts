import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

export const MAX_INLINE_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_INLINE_IMAGE_COUNT = 64;
export const DEFAULT_PUBLIC_ASSET_BASE_URL = "/data/search/assets";
export const DEFAULT_REMOTE_IMAGE_TIMEOUT_MS = 15000;
export const DEFAULT_REMOTE_IMAGE_CONCURRENCY = 4;
const MAX_REMOTE_IMAGE_TIMEOUT_MS = 120000;

const DEFAULT_ARTICLE_CONTAINER_SELECTORS = [
  "#news_view",
  "article",
  "main",
  ".article",
  ".content",
  "body",
];
const DECORATIVE_IMAGE_PATTERN = /(?:^|[\s_-])(?:ad|advert|arrow|avatar|banner|button|calendar|icon|loader|logo|mark|newsf|page[-_]?bottom|share|spacer|sprite)(?:$|[\s_.-])/iu;
const IMAGE_FORMATS = Object.freeze({
  "image/jpeg": { extension: ".jpg", declaredTypes: new Set(["image/jpeg", "image/jpg", "image/pjpeg"]) },
  "image/png": { extension: ".png", declaredTypes: new Set(["image/png", "image/x-png"]) },
  "image/gif": { extension: ".gif", declaredTypes: new Set(["image/gif"]) },
  "image/webp": { extension: ".webp", declaredTypes: new Set(["image/webp"]) },
});

/**
 * Decode an inline raster image without trusting its declared MIME type.
 * Returns null for malformed, unsupported, mismatched, empty, or oversized data.
 */
export function decodeInlineImageDataUri(value = "", {
  maxBytes = MAX_INLINE_IMAGE_BYTES,
} = {}) {
  const parsed = parseBase64DataUri(value);
  if (!parsed) return null;

  const byteLimit = Math.min(
    normalizePositiveInteger(maxBytes, MAX_INLINE_IMAGE_BYTES),
    MAX_INLINE_IMAGE_BYTES,
  );
  if (estimateDecodedBase64Bytes(parsed.payload) > byteLimit) return null;

  try {
    return decodeFetchedImageBytes(Buffer.from(parsed.payload, "base64"), {
      declaredType: parsed.declaredType,
      maxBytes: byteLimit,
    });
  } catch {
    return null;
  }
}

/**
 * Normalize fetched bytes using the same hard size limit and magic sniffing as
 * inline data. A declared image MIME, when present, must match the bytes.
 */
export function decodeFetchedImageBytes(value, {
  declaredType = "",
  maxBytes = MAX_INLINE_IMAGE_BYTES,
} = {}) {
  const byteLimit = Math.min(
    normalizePositiveInteger(maxBytes, MAX_INLINE_IMAGE_BYTES),
    MAX_INLINE_IMAGE_BYTES,
  );
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (!bytes.byteLength || bytes.byteLength > byteLimit) return null;

  const contentType = sniffImageContentType(bytes);
  if (!contentType) return null;
  const normalizedDeclaredType = normalizeDeclaredImageType(declaredType);
  if (normalizedDeclaredType && !IMAGE_FORMATS[contentType].declaredTypes.has(normalizedDeclaredType)) return null;

  return {
    bytes,
    contentType,
    extension: IMAGE_FORMATS[contentType].extension,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * Extract article-owned inline images in DOM order. Source chrome is excluded by
 * choosing the most specific article container and rejecting decorative markers.
 */
export function extractNewsInlineImages(html = "", {
  articleUrl = "",
  containerSelectors = DEFAULT_ARTICLE_CONTAINER_SELECTORS,
  maxBytes = MAX_INLINE_IMAGE_BYTES,
  maxImages = MAX_INLINE_IMAGE_COUNT,
} = {}) {
  const imageLimit = Math.min(
    normalizePositiveInteger(maxImages, MAX_INLINE_IMAGE_COUNT),
    MAX_INLINE_IMAGE_COUNT,
  );
  const candidates = extractNewsImageCandidates(html, {
    articleUrl,
    containerSelectors,
    maxImages: MAX_INLINE_IMAGE_COUNT,
  });
  const images = [];
  for (const candidate of candidates) {
    if (images.length >= imageLimit) break;
    if (candidate.kind !== "inline") continue;
    const decoded = decodeInlineImageDataUri(candidate.dataUri, { maxBytes });
    if (!decoded) continue;
    images.push({
      ...decoded,
      elementId: candidate.elementId,
      alt: candidate.alt,
      domOrder: candidate.domOrder,
      galleryIndex: images.length,
      displayOrder: images.length,
    });
  }
  return images;
}

/**
 * Collect inline and same-origin remote article images in a single DOM-ordered
 * candidate list. Remote URLs are resolved against the canonical article URL.
 */
export function extractNewsImageCandidates(html = "", {
  articleUrl = "",
  containerSelectors = DEFAULT_ARTICLE_CONTAINER_SELECTORS,
  maxImages = MAX_INLINE_IMAGE_COUNT,
} = {}) {
  const $ = cheerio.load(String(html || ""));
  const root = findArticleContainer($, containerSelectors);
  if (!root?.length) return [];

  const imageLimit = Math.min(
    normalizePositiveInteger(maxImages, MAX_INLINE_IMAGE_COUNT),
    MAX_INLINE_IMAGE_COUNT,
  );
  const articleBaseUrl = normalizeArticleHttpUrl(articleUrl);
  const candidates = [];
  root.find("img[src]").each((domOrder, element) => {
    if (candidates.length >= imageLimit || isDecorativeImageElement($, element)) return;
    const src = String($(element).attr("src") || "").trim();
    if (!src) return;

    const metadata = {
      elementId: String($(element).attr("id") || ""),
      alt: cleanText($(element).attr("alt") || $(element).attr("title") || ""),
      domOrder,
    };
    if (/^data:/iu.test(src)) {
      candidates.push({ kind: "inline", dataUri: src, ...metadata });
      return;
    }
    if (/^blob:/iu.test(src) || !articleBaseUrl) return;

    const remoteUrl = resolveSameOriginImageUrl(src, articleBaseUrl);
    if (!remoteUrl || isDecorativeImageUrl(remoteUrl)) return;
    candidates.push({ kind: "remote", url: remoteUrl, ...metadata });
  });
  return candidates;
}

/**
 * Fetch a remote image with a hard byte cap, then validate its real format by
 * magic bytes. The injected implementation may be a standard fetch or a proxy
 * wrapper that honors the supplied signal and maxBytes options.
 */
export async function fetchNewsRemoteImage(url, {
  fetchImageImpl = globalThis.fetch,
  maxBytes = MAX_INLINE_IMAGE_BYTES,
  timeoutMs = DEFAULT_REMOTE_IMAGE_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImageImpl !== "function") throw new Error("fetchImageImpl is required for remote images");
  const remoteUrl = normalizeArticleHttpUrl(url);
  if (!remoteUrl) throw new Error("remote image URL must use http or https");

  const byteLimit = Math.min(
    normalizePositiveInteger(maxBytes, MAX_INLINE_IMAGE_BYTES),
    MAX_INLINE_IMAGE_BYTES,
  );
  const boundedTimeoutMs = Math.min(
    normalizePositiveInteger(timeoutMs, DEFAULT_REMOTE_IMAGE_TIMEOUT_MS),
    MAX_REMOTE_IMAGE_TIMEOUT_MS,
  );
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`remote image fetch timed out after ${boundedTimeoutMs}ms`));
    }, boundedTimeoutMs);
  });
  const task = (async () => {
    const response = await fetchImageImpl(remoteUrl.href, {
      signal: controller.signal,
      maxBytes: byteLimit,
      timeoutMs: boundedTimeoutMs,
      redirect: "error",
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1",
      },
    });
    const { bytes, declaredType } = await readRemoteImageResponse(response, {
      maxBytes: byteLimit,
      controller,
    });
    const decoded = decodeFetchedImageBytes(bytes, { declaredType, maxBytes: byteLimit });
    if (!decoded) throw new Error("remote response is not a supported image");
    return { ...decoded, sourceUrl: remoteUrl.href };
  })();
  task.catch(() => {});

  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Decode/fetch candidates with bounded concurrency. Individual failures are
 * returned separately so a broken gallery item cannot discard the article.
 */
export async function materializeNewsImageCandidates(candidates = [], {
  fetchImageImpl = globalThis.fetch,
  maxBytes = MAX_INLINE_IMAGE_BYTES,
  timeoutMs = DEFAULT_REMOTE_IMAGE_TIMEOUT_MS,
  concurrency = DEFAULT_REMOTE_IMAGE_CONCURRENCY,
} = {}) {
  const limitedCandidates = Array.isArray(candidates)
    ? candidates.slice(0, MAX_INLINE_IMAGE_COUNT)
    : [];
  const workerCount = Math.min(
    normalizePositiveInteger(concurrency, DEFAULT_REMOTE_IMAGE_CONCURRENCY),
    8,
    Math.max(limitedCandidates.length, 1),
  );
  const results = new Array(limitedCandidates.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < limitedCandidates.length) {
      const index = nextIndex;
      nextIndex += 1;
      const candidate = limitedCandidates[index] || {};
      try {
        const decoded = candidate.kind === "inline"
          ? decodeInlineImageDataUri(candidate.dataUri, { maxBytes })
          : await fetchNewsRemoteImage(candidate.url, {
            fetchImageImpl,
            maxBytes,
            timeoutMs,
          });
        if (!decoded) throw new Error("unsupported or invalid image data");
        results[index] = {
          ok: true,
          image: {
            ...decoded,
            elementId: String(candidate.elementId || ""),
            alt: cleanText(candidate.alt || ""),
            domOrder: Number.isInteger(candidate.domOrder) ? candidate.domOrder : index,
            originalImageUrl: candidate.kind === "remote" ? String(candidate.url || "") : "",
          },
        };
      } catch (error) {
        results[index] = {
          ok: false,
          failure: {
            kind: candidate.kind === "remote" ? "remote" : "inline",
            url: candidate.kind === "remote" ? String(candidate.url || "") : "",
            elementId: String(candidate.elementId || ""),
            message: String(error?.message || error || "image materialization failed"),
          },
        };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const images = results
    .filter((result) => result?.ok)
    .map((result, index) => ({
      ...result.image,
      galleryIndex: index,
      displayOrder: index,
    }));
  const failures = results.filter((result) => result && !result.ok).map((result) => result.failure);
  return { images, failures };
}

/**
 * Write content-addressed image assets below assetDir/sourceId. Existing files
 * are retained because the SHA-256 filename already identifies their contents.
 */
export async function writeNewsInlineImageAssets(images = [], {
  assetDir,
  sourceId,
  publicAssetBaseUrl = DEFAULT_PUBLIC_ASSET_BASE_URL,
} = {}) {
  const normalizedSourceId = normalizeSourceId(sourceId);
  if (!assetDir) throw new Error("assetDir is required");

  const rootDir = path.resolve(String(assetDir));
  const sourceDir = path.join(rootDir, normalizedSourceId);
  await fs.mkdir(sourceDir, { recursive: true });
  const publicBase = normalizePublicAssetBaseUrl(publicAssetBaseUrl);

  return Promise.all(images.map(async (image, index) => {
    const normalizedImage = normalizeExtractedImage(image, index);
    const fileName = `${normalizedImage.sha256}${normalizedImage.extension}`;
    const assetPath = path.join(sourceDir, fileName);
    await writeContentAddressedFile(assetPath, normalizedImage.bytes);
    return {
      ...normalizedImage,
      fileName,
      assetPath,
      publicUrl: `${publicBase}/${encodeURIComponent(normalizedSourceId)}/${fileName}`,
    };
  }));
}

/**
 * Purely attach mirrored assets to a source article and create associated image
 * documents. The article URL remains the canonical URL for every gallery item.
 */
export function buildNewsInlineImageDocuments(article = {}, images = [], {
  sourceId = article?.sourceId,
} = {}) {
  const normalizedSourceId = normalizeSourceId(sourceId);
  const articleUrl = String(article?.url || "").trim();
  if (!articleUrl) throw new Error("article.url is required");

  const normalizedImages = images.map((image, index) => normalizeMirroredImage(image, index));
  const originalThumbnailUrl = String(article?.thumbnailUrl || "").trim();
  const updatedArticle = normalizedImages.length
    ? {
      ...article,
      ...(normalizedSourceId === "kcna"
        && article?.mediaType === "video"
        && /^data:(?:image\/[^;,]+)?;base64,/iu.test(originalThumbnailUrl)
        ? { thumbnailUrl: "" }
        : {}),
      cachedThumbnailUrl: normalizedImages[0].publicUrl,
    }
    : { ...article };
  const imageDocuments = normalizedImages.map((image, index) => {
    const galleryIndex = Number.isInteger(image.galleryIndex) ? image.galleryIndex : index;
    const displayOrder = Number.isFinite(image.displayOrder) ? Number(image.displayOrder) : galleryIndex;
    const idHash = createHash("sha256")
      .update(`${article?.id || articleUrl}|inline-image|${image.sha256}|${galleryIndex}`)
      .digest("hex")
      .slice(0, 16);
    const title = normalizedImages.length > 1
      ? `${cleanText(article?.title)} (${index + 1}/${normalizedImages.length})`
      : cleanText(article?.title);
    return {
      id: `${normalizedSourceId}-${idHash}`,
      title: title || `기사 사진 ${index + 1}`,
      snippet: cleanText(article?.snippet || article?.body || article?.title || "기사 사진"),
      body: cleanText([article?.title, article?.snippet, "사진 이미지"].filter(Boolean).join("\n")),
      date: String(article?.date || ""),
      sourceId: normalizedSourceId,
      sourceName: String(article?.sourceName || ""),
      sourceType: String(article?.sourceType || "official_site"),
      displaySourceId: String(article?.displaySourceId || normalizedSourceId),
      displaySourceName: String(article?.displaySourceName || article?.sourceName || ""),
      displaySourceType: String(article?.displaySourceType || article?.sourceType || "official_site"),
      mediaType: "image",
      url: articleUrl,
      archiveUrl: articleUrl,
      originalSourceUrl: String(article?.originalSourceUrl || ""),
      thumbnailUrl: "",
      cachedUrl: image.publicUrl,
      cachedThumbnailUrl: image.publicUrl,
      language: String(article?.language || "ko"),
      aliases: Array.isArray(article?.aliases) ? [...article.aliases] : [],
      searchTabs: ["all", "image"],
      galleryIndex,
      displayOrder,
    };
  });

  return { article: updatedArticle, imageDocuments };
}

/**
 * End-to-end helper for an importer or refresh job. This does not expose a live
 * image proxy; it returns static, content-addressed mirror URLs only.
 */
export async function mirrorNewsInlineImages({
  html = "",
  article = {},
  assetDir,
  sourceId = article?.sourceId,
  publicAssetBaseUrl = DEFAULT_PUBLIC_ASSET_BASE_URL,
  containerSelectors = DEFAULT_ARTICLE_CONTAINER_SELECTORS,
  maxBytes = MAX_INLINE_IMAGE_BYTES,
  maxImages = MAX_INLINE_IMAGE_COUNT,
  fetchImageImpl = globalThis.fetch,
  fetchTimeoutMs = DEFAULT_REMOTE_IMAGE_TIMEOUT_MS,
  fetchConcurrency = DEFAULT_REMOTE_IMAGE_CONCURRENCY,
} = {}) {
  const candidates = extractNewsImageCandidates(html, {
    articleUrl: article?.url,
    containerSelectors,
    maxImages,
  });
  const listingThumbnail = String(article?.thumbnailUrl || "").trim();
  if (
    candidates.length === 0
    && String(sourceId || article?.sourceId || "") === "kcna"
    && article?.mediaType === "video"
    && /^data:(?:image\/[^;,]+)?;base64,/iu.test(listingThumbnail)
  ) {
    candidates.push({
      kind: "inline",
      dataUri: listingThumbnail,
      elementId: "listing-thumbnail",
      alt: cleanText(article?.title || ""),
      domOrder: 0,
    });
  }
  const materialized = await materializeNewsImageCandidates(candidates, {
    fetchImageImpl,
    maxBytes,
    timeoutMs: fetchTimeoutMs,
    concurrency: fetchConcurrency,
  });
  const extractedImages = materialized.images;
  const images = await writeNewsInlineImageAssets(extractedImages, {
    assetDir,
    sourceId,
    publicAssetBaseUrl,
  });
  const linked = buildNewsInlineImageDocuments(article, images, { sourceId });
  return { ...linked, images, failures: materialized.failures };
}

/**
 * Refresh-job-friendly alias using the shorter publicBase option name.
 */
export async function enrichNewsArticleWithInlineImages({
  article = {},
  html = "",
  sourceId = article?.sourceId,
  assetDir,
  publicBase = DEFAULT_PUBLIC_ASSET_BASE_URL,
  containerSelectors = DEFAULT_ARTICLE_CONTAINER_SELECTORS,
  maxBytes = MAX_INLINE_IMAGE_BYTES,
  maxImages = MAX_INLINE_IMAGE_COUNT,
  fetchImageImpl = globalThis.fetch,
  fetchTimeoutMs = DEFAULT_REMOTE_IMAGE_TIMEOUT_MS,
  fetchConcurrency = DEFAULT_REMOTE_IMAGE_CONCURRENCY,
} = {}) {
  return mirrorNewsInlineImages({
    article,
    html,
    sourceId,
    assetDir,
    publicAssetBaseUrl: publicBase,
    containerSelectors,
    maxBytes,
    maxImages,
    fetchImageImpl,
    fetchTimeoutMs,
    fetchConcurrency,
  });
}

function parseBase64DataUri(value = "") {
  const text = String(value || "").trim();
  if (!/^data:/iu.test(text)) return null;
  const commaIndex = text.indexOf(",");
  if (commaIndex < 0) return null;

  const metadata = text.slice(5, commaIndex).split(";");
  const declaredType = String(metadata.shift() || "").trim().toLocaleLowerCase("en-US");
  if (declaredType && !/^image\//iu.test(declaredType)) return null;
  if (!metadata.some((part) => String(part).trim().toLocaleLowerCase("en-US") === "base64")) return null;

  const rawPayload = text.slice(commaIndex + 1).replace(/\s+/gu, "");
  if (!rawPayload || !/^[A-Za-z0-9+/]*={0,2}$/u.test(rawPayload) || rawPayload.length % 4 === 1) return null;
  const payload = rawPayload.padEnd(Math.ceil(rawPayload.length / 4) * 4, "=");
  return { declaredType, payload };
}

function estimateDecodedBase64Bytes(payload = "") {
  const padding = String(payload).endsWith("==") ? 2 : (String(payload).endsWith("=") ? 1 : 0);
  return Math.max(0, Math.floor(String(payload).length * 3 / 4) - padding);
}

function sniffImageContentType(bytes = Buffer.alloc(0)) {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.byteLength >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.byteLength >= 6) {
    const gifSignature = bytes.subarray(0, 6).toString("ascii");
    if (gifSignature === "GIF87a" || gifSignature === "GIF89a") return "image/gif";
  }
  if (
    bytes.byteLength >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  return "";
}

function normalizeDeclaredImageType(value = "") {
  const contentType = String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLocaleLowerCase("en-US");
  if ([
    "application/octet-stream",
    "application/x-octet-stream",
    "binary/octet-stream",
  ].includes(contentType)) return "";
  return contentType;
}

async function readRemoteImageResponse(response, {
  maxBytes = MAX_INLINE_IMAGE_BYTES,
  controller,
} = {}) {
  if (response == null) throw new Error("remote image fetch returned no response");
  const byteLimit = Math.min(
    normalizePositiveInteger(maxBytes, MAX_INLINE_IMAGE_BYTES),
    MAX_INLINE_IMAGE_BYTES,
  );

  if (Buffer.isBuffer(response) || response instanceof Uint8Array || response instanceof ArrayBuffer) {
    return { bytes: enforceFetchedByteLimit(response, byteLimit), declaredType: "" };
  }
  if (response?.ok === false || (Number(response?.status) >= 400 && Number(response?.status) <= 599)) {
    throw new Error(`remote image fetch failed with status ${Number(response?.status) || "unknown"}`);
  }

  const declaredType = String(
    response?.contentType
    || getResponseHeader(response?.headers, "content-type")
    || "",
  );
  const declaredLength = Number(getResponseHeader(response?.headers, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > byteLimit) {
    controller?.abort();
    throw new Error(`remote image exceeds ${byteLimit} bytes`);
  }

  if (response?.bytes != null && typeof response.bytes !== "function") {
    return {
      bytes: enforceFetchedByteLimit(response.bytes, byteLimit),
      declaredType,
    };
  }
  if (response?.body?.getReader && typeof response.body.getReader === "function") {
    return {
      bytes: await readWebStreamWithLimit(response.body, byteLimit, controller),
      declaredType,
    };
  }
  if (response?.body?.[Symbol.asyncIterator]) {
    return {
      bytes: await readAsyncIterableWithLimit(response.body, byteLimit, controller),
      declaredType,
    };
  }
  if (typeof response?.arrayBuffer === "function") {
    return {
      bytes: enforceFetchedByteLimit(await response.arrayBuffer(), byteLimit),
      declaredType,
    };
  }
  throw new Error("remote image response has no readable body");
}

async function readWebStreamWithLimit(stream, byteLimit, controller) {
  const reader = stream.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value || []);
      byteLength += chunk.byteLength;
      if (byteLength > byteLimit) {
        controller?.abort();
        await reader.cancel("remote image byte limit exceeded").catch(() => {});
        throw new Error(`remote image exceeds ${byteLimit} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled/errored stream may already have released its lock.
    }
  }
  return Buffer.concat(chunks, byteLength);
}

async function readAsyncIterableWithLimit(stream, byteLimit, controller) {
  const chunks = [];
  let byteLength = 0;
  for await (const value of stream) {
    const chunk = Buffer.from(value || []);
    byteLength += chunk.byteLength;
    if (byteLength > byteLimit) {
      controller?.abort();
      if (typeof stream.destroy === "function") stream.destroy();
      throw new Error(`remote image exceeds ${byteLimit} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, byteLength);
}

function enforceFetchedByteLimit(value, byteLimit) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (bytes.byteLength > byteLimit) throw new Error(`remote image exceeds ${byteLimit} bytes`);
  return bytes;
}

function getResponseHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const expectedName = String(name || "").toLocaleLowerCase("en-US");
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLocaleLowerCase("en-US") === expectedName) return String(value || "");
  }
  return "";
}

function findArticleContainer($, selectors = DEFAULT_ARTICLE_CONTAINER_SELECTORS) {
  const candidates = Array.isArray(selectors) ? selectors : [selectors];
  for (const selector of candidates.map(String).map((value) => value.trim()).filter(Boolean)) {
    const candidate = $(selector).first();
    if (candidate.length) return candidate;
  }
  return null;
}

function isDecorativeImageElement($, element) {
  const image = $(element);
  const marker = [
    image.attr("id"),
    image.attr("class"),
    image.attr("alt"),
    image.attr("title"),
    image.attr("role"),
  ].filter(Boolean).join(" ");
  if (DECORATIVE_IMAGE_PATTERN.test(marker)) return true;
  if (String(image.attr("aria-hidden") || "").toLocaleLowerCase("en-US") === "true") return true;
  const width = Number.parseInt(String(image.attr("width") || ""), 10);
  const height = Number.parseInt(String(image.attr("height") || ""), 10);
  if (Number.isFinite(width) && Number.isFinite(height) && width <= 64 && height <= 64) return true;
  return image.closest("header, nav, footer, aside, [role='banner'], [role='navigation']").length > 0;
}

function normalizeArticleHttpUrl(value = "") {
  try {
    const url = value instanceof URL ? new URL(value.href) : new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function resolveSameOriginImageUrl(value, articleBaseUrl) {
  try {
    const url = new URL(String(value || "").trim(), articleBaseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    if (url.origin !== articleBaseUrl.origin) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function isDecorativeImageUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    let pathMarker = url.pathname;
    try {
      pathMarker = decodeURIComponent(pathMarker);
    } catch {
      // Keep the encoded path when it contains malformed escapes.
    }
    return DECORATIVE_IMAGE_PATTERN.test(pathMarker.replace(/[^\p{L}\p{N}_-]+/gu, " "));
  } catch {
    return true;
  }
}

function normalizeExtractedImage(image = {}, index = 0) {
  const bytes = Buffer.isBuffer(image.bytes) ? image.bytes : Buffer.from(image.bytes || []);
  if (!bytes.byteLength || bytes.byteLength > MAX_INLINE_IMAGE_BYTES) throw new Error("invalid inline image bytes");
  const contentType = sniffImageContentType(bytes);
  if (!contentType) throw new Error("unsupported inline image bytes");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    ...image,
    bytes,
    contentType,
    extension: IMAGE_FORMATS[contentType].extension,
    sha256,
    galleryIndex: Number.isInteger(image.galleryIndex) ? image.galleryIndex : index,
    displayOrder: Number.isFinite(image.displayOrder) ? Number(image.displayOrder) : index,
  };
}

function normalizeMirroredImage(image = {}, index = 0) {
  const publicUrl = String(image.publicUrl || image.cachedUrl || image.cachedThumbnailUrl || "").trim();
  const sha256 = String(image.sha256 || "").toLocaleLowerCase("en-US");
  if (!publicUrl.startsWith("/data/search/assets/")) throw new Error("image.publicUrl must be a static search asset URL");
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("image.sha256 is required");
  return {
    ...image,
    publicUrl,
    sha256,
    galleryIndex: Number.isInteger(image.galleryIndex) ? image.galleryIndex : index,
    displayOrder: Number.isFinite(image.displayOrder) ? Number(image.displayOrder) : index,
  };
}

async function writeContentAddressedFile(assetPath, bytes) {
  try {
    await fs.writeFile(assetPath, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existingBytes = await fs.readFile(assetPath);
    if (!existingBytes.equals(bytes)) {
      throw new Error(`content-addressed asset mismatch: ${assetPath}`);
    }
  }
}

function normalizeSourceId(value = "") {
  const sourceId = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(sourceId)) throw new Error("valid sourceId is required");
  return sourceId;
}

function normalizePublicAssetBaseUrl(value = DEFAULT_PUBLIC_ASSET_BASE_URL) {
  const publicBase = String(value || DEFAULT_PUBLIC_ASSET_BASE_URL).trim().replace(/\/+$/u, "");
  if (publicBase !== DEFAULT_PUBLIC_ASSET_BASE_URL) {
    throw new Error(`publicAssetBaseUrl must be ${DEFAULT_PUBLIC_ASSET_BASE_URL}`);
  }
  return publicBase;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/gu, " ").trim();
}
