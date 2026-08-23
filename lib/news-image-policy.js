import { createHash } from "node:crypto";

export const NEWS_IMAGE_PAIR_HASH_ALGORITHM = "sha256";
export const NEWS_IMAGE_PAIR_HASH_VERSION = 1;

const RODONG_QUERY_TOKEN_PATTERN = /^[A-Za-z0-9+/_=-]{8,8192}$/u;

/**
 * Canonicalize an exact official News image/referer pair. This policy is
 * shared by the snapshot generator and the standalone News image endpoint so
 * the generated hashes cannot drift from the runtime membership check.
 */
export function normalizePublishedNewsImagePair(imageValue, refererValue) {
  const imageUrl = parseOfficialNewsImageUrl(imageValue);
  if (!imageUrl) return null;
  const refererUrl = parseOfficialNewsRefererUrl(refererValue, imageUrl);
  if (!refererUrl) return null;
  return { imageUrl, refererUrl };
}

export function hashPublishedNewsImagePair(imageValue, refererValue) {
  const pair = normalizePublishedNewsImagePair(imageValue, refererValue);
  if (!pair) return "";
  return createHash(NEWS_IMAGE_PAIR_HASH_ALGORITHM)
    .update(`standalone-news-image-pair:${NEWS_IMAGE_PAIR_HASH_VERSION}\0`, "utf8")
    .update(pair.imageUrl.href, "utf8")
    .update("\0", "utf8")
    .update(pair.refererUrl.href, "utf8")
    .digest("hex");
}

export function parseOfficialNewsImageUrl(value) {
  const url = normalizeHttpUrl(value);
  if (!url || hasUnsafeUrlAuthority(url) || url.hash || url.port) return null;
  const host = normalizeHost(url.hostname);
  if (
    host === "kcna.kp"
    && /^\/photo\/[a-f0-9]{32,128}$/iu.test(url.pathname)
    && !url.search
  ) return url;
  if (
    host === "rodong.rep.kp"
    && /^\/ko\/index\.php$/u.test(url.pathname)
    && parseRodongNewsImageToken(url)
  ) return url;
  return null;
}

export function parseOfficialNewsRefererUrl(value, imageUrl) {
  const referer = normalizeHttpUrl(value);
  if (!referer || hasUnsafeUrlAuthority(referer) || referer.hash || referer.port) return null;
  if (normalizeHost(referer.hostname) !== normalizeHost(imageUrl?.hostname)) return null;
  const host = normalizeHost(referer.hostname);
  if (host === "kcna.kp" && /^\/kp\/(?:article|gallery|video)\/(?:detail|q)\/[-a-z0-9.]+\/?$/iu.test(referer.pathname)) {
    return referer;
  }
  if (
    host === "rodong.rep.kp"
    && /^\/ko\/index\.php$/u.test(referer.pathname)
    && parseRodongNewsRefererToken(referer)
  ) {
    return referer;
  }
  return null;
}

/**
 * Decode and classify only the opaque Rodong token families which return
 * image bytes.  The site serves articles, lists, videos, and images through
 * the same extensionless index.php path, so pathname/host checks alone are
 * not enough to establish that a URL is an image endpoint.
 */
export function parseRodongNewsImageToken(value) {
  const decoded = decodeRodongNewsToken(value);
  if (!decoded) return null;

  if (decoded.startsWith("2@@@@p@0@")) {
    const assetPath = decoded.slice("2@@@@p@0@".length);
    return isSafeDatedRodongImagePath(assetPath)
      ? { kind: "photo", decoded, assetPath }
      : null;
  }
  if (decoded.startsWith("02@@@u@0@")) {
    const assetPath = decoded.slice("02@@@u@0@".length);
    return isSafeDatedRodongImagePath(assetPath)
      ? { kind: "inline", decoded, assetPath }
      : null;
  }
  if (/^11@20\d{2}-\d{2}-\d{2}-\d{3}@{7}[1-9]\d{0,5}$/u.test(decoded)) {
    return { kind: "video-thumbnail", decoded, assetPath: "" };
  }
  return null;
}

function parseRodongNewsRefererToken(value) {
  const decoded = decodeRodongNewsToken(value);
  if (!decoded) return null;
  if (parseRodongNewsImageToken(value)) return { kind: "image", decoded };
  if (/^1@@[1-9]\d{0,4}@[1-9]\d{0,4}@(?:@0@)?$/u.test(decoded)) return { kind: "listing", decoded };
  if (/^12@20\d{2}-\d{2}-\d{2}-\d{3}@[1-9]\d{0,4}@/u.test(decoded)) return { kind: "article", decoded };
  if (/^10@20\d{2}-\d{2}-\d{2}-\d{3}@/u.test(decoded)) return { kind: "video", decoded };
  return null;
}

function decodeRodongNewsToken(value) {
  let token = "";
  if (value instanceof URL) {
    token = value.search.slice(1);
  } else {
    const candidate = String(value || "").trim();
    if (!candidate) return "";
    try {
      token = /^https?:/iu.test(candidate) ? new URL(candidate).search.slice(1) : candidate;
    } catch {
      return "";
    }
  }
  if (!token || token.includes("&")) return "";
  try {
    token = decodeURIComponent(token).replace(/ /gu, "+");
  } catch {
    return "";
  }
  if (!RODONG_QUERY_TOKEN_PATTERN.test(token)) return "";
  try {
    const decoded = Buffer.from(token.replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8");
    if (!decoded || decoded.includes("\uFFFD") || /[\u0000-\u001F\u007F]/u.test(decoded)) return "";
    return decoded;
  } catch {
    return "";
  }
}

function isSafeDatedRodongImagePath(value) {
  const assetPath = String(value || "");
  if (assetPath.length < 16 || assetPath.length > 2_048 || assetPath.includes("\\") || assetPath.includes("@")) return false;
  const segments = assetPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  if (!/^20\d{2}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\//u.test(assetPath)) return false;
  return /\.(?:gif|jpe?g|png|webp)$/iu.test(assetPath);
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return /^https?:$/u.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function hasUnsafeUrlAuthority(url) {
  return Boolean(url.username || url.password);
}

function normalizeHost(value) {
  return String(value || "").toLocaleLowerCase("en-US").replace(/^www\./u, "").replace(/\.$/u, "");
}
