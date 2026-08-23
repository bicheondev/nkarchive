import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  NEWS_IMAGE_PAIR_HASH_ALGORITHM,
  NEWS_IMAGE_PAIR_HASH_VERSION,
  hashPublishedNewsImagePair,
  parseOfficialNewsImageUrl,
  parseOfficialNewsRefererUrl,
} from "../lib/news-image-policy.js";

export { parseOfficialNewsImageUrl, parseOfficialNewsRefererUrl } from "../lib/news-image-policy.js";

// Keep the binary response below Vercel Functions' 4.5 MB payload ceiling.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 25_000;
const MAX_REDIRECTS = 3;
const FETCH_ATTEMPTS = 2;
const OVERALL_FETCH_TIMEOUT_MS = 27_000;
const NEWS_IMAGE_USER_AGENT = "DPRKArchiveNewsMirror/2.0 (+https://nkarchive.vercel.app/news)";
const CACHE_CONTROL = "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=31536000, immutable";
const DEFAULT_ALLOWLIST_PATH = fileURLToPath(new URL("../data/news/image-proxy-allowlist.json", import.meta.url));
let defaultPairHashes;
let defaultPairHashesError;

export default async function handler(request, response) {
  return createNewsImageHandler()(request, response);
}

export function createNewsImageHandler({
  fetchImageImpl = fetchOfficialNewsImage,
  publishedPairHashes,
  allowlistPath = DEFAULT_ALLOWLIST_PATH,
} = {}) {
  let allowedPairs = null;
  try {
    allowedPairs = publishedPairHashes === undefined
      ? loadPublishedNewsImagePairHashes(allowlistPath)
      : normalizePublishedPairHashes(publishedPairHashes);
  } catch {}
  return async function newsImageHandler(request, response) {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" }, { Allow: "GET" });
      return;
    }

    const query = parseExactNewsImageQuery(request);
    if (!query) {
      sendJson(response, 400, { error: "invalid_news_image_query" });
      return;
    }
    const imageUrl = parseOfficialNewsImageUrl(query.url);
    if (!imageUrl) {
      sendJson(response, 400, { error: "invalid_news_image_url" });
      return;
    }
    const refererUrl = parseOfficialNewsRefererUrl(query.referer, imageUrl);
    if (!refererUrl) {
      sendJson(response, 400, { error: "invalid_news_image_referer" });
      return;
    }
    if (query.rawQuery !== null && query.rawQuery !== serializeNewsImageQuery(imageUrl.href, refererUrl.href)) {
      sendJson(response, 400, { error: "invalid_news_image_query" });
      return;
    }
    if (!allowedPairs) {
      sendJson(response, 503, { error: "news_image_allowlist_unavailable" });
      return;
    }
    const pairHash = hashPublishedNewsImagePair(imageUrl.href, refererUrl.href);
    if (!pairHash || !allowedPairs.has(pairHash)) {
      sendJson(response, 403, { error: "news_image_not_published" });
      return;
    }

    try {
      const result = await fetchImageImpl(imageUrl, { refererUrl });
      const format = detectImageFormat(result?.bytes);
      if (!format) throw new Error("invalid_image_bytes");
      const bytes = Buffer.from(result.bytes);
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("invalid_image_size");

      response.statusCode = 200;
      response.setHeader("Content-Type", format.mimeType);
      response.setHeader("Content-Length", String(bytes.length));
      response.setHeader("Cache-Control", CACHE_CONTROL);
      response.setHeader("Content-Disposition", `inline; filename="news-image.${format.extension}"`);
      setSecurityHeaders(response);
      response.end(bytes);
    } catch (error) {
      const timeout = /timeout|timed out|aborted/iu.test(String(error?.message || error));
      sendJson(response, timeout ? 504 : 502, { error: timeout ? "news_image_timeout" : "news_image_unavailable" });
    }
  };
}

export function loadPublishedNewsImagePairHashes(filePath = DEFAULT_ALLOWLIST_PATH) {
  if (filePath === DEFAULT_ALLOWLIST_PATH && defaultPairHashes) return defaultPairHashes;
  if (filePath === DEFAULT_ALLOWLIST_PATH && defaultPairHashesError) throw defaultPairHashesError;
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (payload?.schemaVersion !== NEWS_IMAGE_PAIR_HASH_VERSION
      || payload?.algorithm !== NEWS_IMAGE_PAIR_HASH_ALGORITHM
      || !/^[a-f0-9]{16}$/u.test(String(payload?.snapshotVersion || ""))
      || !Array.isArray(payload?.pairHashes)
      || payload?.pairCount !== payload.pairHashes.length) {
      throw new Error("invalid_news_image_allowlist");
    }
    const pairHashes = normalizePublishedPairHashes(payload.pairHashes);
    if (pairHashes.size !== payload.pairHashes.length) throw new Error("invalid_news_image_allowlist");
    if (JSON.stringify([...pairHashes]) !== JSON.stringify([...pairHashes].sort())) {
      throw new Error("invalid_news_image_allowlist");
    }
    if (filePath === DEFAULT_ALLOWLIST_PATH) defaultPairHashes = pairHashes;
    return pairHashes;
  } catch (error) {
    if (filePath === DEFAULT_ALLOWLIST_PATH) defaultPairHashesError = error;
    throw error;
  }
}

export async function fetchOfficialNewsImage(imageUrl, { refererUrl } = {}) {
  let lastError = null;
  const deadline = Date.now() + OVERALL_FETCH_TIMEOUT_MS;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetchOfficialNewsImageAttempt(imageUrl, { refererUrl, deadline });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < FETCH_ATTEMPTS && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(125 * (attempt + 1), Math.max(0, deadline - Date.now()))));
      }
    }
  }
  throw lastError || new Error("news_image_fetch_failed");
}

async function fetchOfficialNewsImageAttempt(imageUrl, { refererUrl, deadline } = {}) {
  let currentUrl = new URL(imageUrl);
  const origin = currentUrl.origin;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const remainingMs = Number(deadline) - Date.now();
    if (remainingMs <= 0) throw new Error("news_image_timeout");
    const result = await requestImageHop(currentUrl, {
      refererUrl,
      timeoutMs: Math.min(FETCH_TIMEOUT_MS, remainingMs),
    });
    if (result.redirectUrl) {
      const redirectUrl = new URL(result.redirectUrl, currentUrl);
      if (redirectUrl.origin !== origin || !parseOfficialNewsImageUrl(redirectUrl.href)) {
        throw new Error("cross_origin_redirect_rejected");
      }
      currentUrl = redirectUrl;
      continue;
    }
    return result;
  }
  throw new Error("too_many_redirects");
}

function requestImageHop(url, { refererUrl, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClockTimer);
      callback(value);
    };
    const succeed = (value) => finish(resolve, value);
    const fail = (error) => finish(reject, error);
    const wallClockTimer = setTimeout(() => {
      const error = new Error("news_image_timeout");
      request?.destroy(error);
      fail(error);
    }, timeoutMs);
    const client = url.protocol === "https:" ? https : http;
    request = client.request(url, {
      method: "GET",
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
        Referer: String(refererUrl || new URL("/", url)),
        "User-Agent": NEWS_IMAGE_USER_AGENT,
      },
    }, (upstream) => {
      const status = Number(upstream.statusCode || 0);
      const location = String(upstream.headers.location || "");
      if (status >= 300 && status < 400 && location) {
        upstream.resume();
        succeed({ redirectUrl: location });
        return;
      }
      if (status < 200 || status >= 300) {
        upstream.resume();
        fail(new Error(`upstream_status_${status}`));
        return;
      }
      const declaredLength = Number(upstream.headers["content-length"] || 0);
      if (declaredLength > MAX_IMAGE_BYTES) {
        upstream.destroy();
        fail(new Error("news_image_too_large"));
        return;
      }
      const chunks = [];
      let size = 0;
      upstream.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) {
          upstream.destroy(new Error("news_image_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      upstream.on("end", () => succeed({
        bytes: Buffer.concat(chunks),
        contentType: String(upstream.headers["content-type"] || ""),
      }));
      upstream.on("error", fail);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("news_image_timeout")));
    request.on("error", fail);
    request.end();
  });
}

export function detectImageFormat(value) {
  const bytes = Buffer.from(value || []);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    return { mimeType: "image/gif", extension: "gif" };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return null;
}

function normalizePublishedPairHashes(value) {
  const hashes = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
  if (!hashes.every((hash) => /^[a-f0-9]{64}$/u.test(String(hash)))) {
    throw new Error("invalid_news_image_pair_hashes");
  }
  return new Set(hashes.map(String));
}

function parseExactNewsImageQuery(request) {
  const requestUrl = String(request?.url || "");
  if (requestUrl.includes("?")) {
    try {
      const parsed = new URL(requestUrl, "https://nkarchive.invalid");
      const entries = [...parsed.searchParams.entries()];
      if (entries.length !== 2
        || entries[0][0] !== "url"
        || entries[1][0] !== "referer"
        || !entries[0][1]
        || !entries[1][1]) return null;
      return { url: entries[0][1], referer: entries[1][1], rawQuery: parsed.search.slice(1) };
    } catch {
      return null;
    }
  }

  // Unit and platform adapters may expose only a parsed query object. Arrays
  // are rejected because they represent duplicate keys in common runtimes.
  const query = request?.query;
  if (!query || typeof query !== "object" || Array.isArray(query)) return null;
  const keys = Object.keys(query).sort();
  if (keys.length !== 2 || keys[0] !== "referer" || keys[1] !== "url") return null;
  if (Array.isArray(query.url) || Array.isArray(query.referer)) return null;
  const url = String(query.url || "");
  const referer = String(query.referer || "");
  return url && referer ? { url, referer, rawQuery: null } : null;
}

function serializeNewsImageQuery(imageUrl, refererUrl) {
  try {
    return new URLSearchParams({ url: imageUrl, referer: refererUrl }).toString();
  } catch {
    return "";
  }
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  setSecurityHeaders(response);
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(JSON.stringify(payload));
}
