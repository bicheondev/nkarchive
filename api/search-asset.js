import { ProxyAgent } from "undici";
import { SEARCH_SOURCES } from "../search/sourceConfig.js?v=search-20260823-7";

const ALLOWED_ASSET_HOSTS = new Set([
  ...createConfiguredAssetHosts(),
  "rodong.rep.kp",
  "www.rodong.rep.kp",
  "kcna.kp",
  "www.kcna.kp",
  "vok.rep.kp",
  "www.vok.rep.kp",
  "minju.rep.kp",
  "www.minju.rep.kp",
  "mediaryugyong.com.kp",
  "www.mediaryugyong.com.kp",
  "naenara.com.kp",
  "www.naenara.com.kp",
  "korean-books.com.kp",
  "www.korean-books.com.kp",
  "chosonsinbo.com",
  "www.chosonsinbo.com",
  "kcnawatch.org",
  "www.kcnawatch.org",
  "vod.koryo.tv",
]);

const MAX_ASSET_BYTES = 40 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT = "DPRKArchiveSearchBot/0.1 (+https://nkarchive.vercel.app/search)";
const ASSET_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox",
].join("; ");
let outboundProxyAgent = null;
let outboundProxyAgentUrl = "";

function createConfiguredAssetHosts() {
  const hosts = [];
  for (const source of SEARCH_SOURCES) {
    if (!source.mediaTypes?.some((mediaType) => ["image", "pdf", "video", "broadcast"].includes(mediaType))) continue;
    try {
      const hostname = new URL(source.baseUrl).hostname.toLocaleLowerCase("en-US");
      const bareHostname = hostname.replace(/^www\./, "");
      hosts.push(bareHostname, `www.${bareHostname}`);
    } catch {
      // Invalid source URLs are rejected by source validation before deployment.
    }
  }
  return [...new Set(hosts)];
}

export default async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
    return;
  }

  const sourceUrl = getRequestAssetUrl(request);
  const parsedUrl = parseAllowedAssetUrl(sourceUrl);
  if (!parsedUrl) {
    sendJson(response, 400, { error: "invalid_asset_url" });
    return;
  }

  try {
    const isHeadRequest = request.method === "HEAD";
    const rangeHeader = isHeadRequest ? "" : getRequestHeader(request, "range");
    const dispatcher = getOutboundProxyDispatcher(parsedUrl.href);
    const upstream = await fetchAssetUpstream(parsedUrl, {
      method: isHeadRequest ? "HEAD" : "GET",
      headers: {
        Accept: getAcceptHeader(parsedUrl.href),
        "User-Agent": USER_AGENT,
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (upstream.status === 416) {
      response.statusCode = 416;
      const contentRange = upstream.headers.get("content-range");
      if (contentRange) response.setHeader("Content-Range", contentRange);
      response.setHeader("Cache-Control", "no-store");
      setAssetSecurityHeaders(response);
      response.end();
      return;
    }
    if (!upstream.ok) {
      sendJson(response, 502, { error: "upstream_unavailable", status: upstream.status });
      return;
    }

    const contentLengthHeader = upstream.headers.get("content-length") || "";
    const contentLength = Number(contentLengthHeader || 0);
    if (contentLength > MAX_ASSET_BYTES) {
      sendJson(response, 413, { error: "asset_too_large" });
      return;
    }

    const contentType = upstream.headers.get("content-type") || inferContentType(parsedUrl.href);
    if (!isSafeAssetContentType(contentType)) {
      sendJson(response, 415, { error: "unsupported_asset_type" });
      return;
    }

    if (isHeadRequest) {
      response.statusCode = 200;
      response.setHeader("Content-Type", contentType || "application/octet-stream");
      if (contentLengthHeader) response.setHeader("Content-Length", String(contentLength));
      response.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800");
      setAssetSecurityHeaders(response);
      response.end();
      return;
    }

    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      sendJson(response, 413, { error: "asset_too_large" });
      return;
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", contentType || "application/octet-stream");
    response.setHeader("Content-Length", String(bytes.byteLength));
    if (upstream.status === 206) {
      response.statusCode = 206;
      const contentRange = upstream.headers.get("content-range");
      const acceptRanges = upstream.headers.get("accept-ranges") || "bytes";
      if (contentRange) response.setHeader("Content-Range", contentRange);
      if (acceptRanges) response.setHeader("Accept-Ranges", acceptRanges);
    }
    response.setHeader("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800");
    setAssetSecurityHeaders(response);
    response.end(bytes);
  } catch (error) {
    sendJson(response, error.name === "AbortError" ? 504 : 502, {
      error: error.name === "AbortError" ? "asset_timeout" : "asset_fetch_failed",
    });
  }
}

async function fetchAssetUpstream(sourceUrl, options = {}) {
  let sourceAttempt = null;
  const isDprkImage = isDprkImageUrl(sourceUrl);
  const shouldTrySourceFirst = isDprkImage && (options.method === "HEAD" || Boolean(options.dispatcher));
  if (shouldTrySourceFirst) {
    try {
      sourceAttempt = await fetchWithTimeout(sourceUrl.href, options);
      if (sourceAttempt.ok) return sourceAttempt;
    } catch {
      // A public image route remains available when the DPRK origin or proxy fails.
    }
  }
  if (isChosonSinboImageUrl(sourceUrl) || isDprkImage) {
    try {
      const fallback = await fetchWithTimeout(createChosonSinboImageFetchUrl(sourceUrl), {
        method: options.method,
        headers: options.headers,
      });
      if (fallback.ok) return fallback;
    } catch {
      // The original source remains the final route when the image CDN is unavailable.
    }
  }
  if (sourceAttempt) return sourceAttempt;
  return fetchWithTimeout(sourceUrl.href, options);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isChosonSinboImageUrl(url) {
  const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  return host === "chosonsinbo.com" && /^\/wp-content\/uploads\//i.test(url.pathname);
}

function isDprkImageUrl(url) {
  const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  return host.endsWith(".kp") && /\.(?:avif|gif|jpe?g|png|webp)$/i.test(url.pathname);
}

function createChosonSinboImageFetchUrl(sourceUrl) {
  const fallback = new URL("https://images.weserv.nl/");
  fallback.searchParams.set("url", sourceUrl.href.replace(/^https?:\/\//i, ""));
  return fallback.href;
}

function getOutboundProxyDispatcher(requestUrl = "") {
  const proxyUrl = getConfiguredOutboundProxyUrl(requestUrl);
  if (!proxyUrl) return null;
  if (outboundProxyAgent && outboundProxyAgentUrl === proxyUrl) return outboundProxyAgent;
  outboundProxyAgent = new ProxyAgent(proxyUrl);
  outboundProxyAgentUrl = proxyUrl;
  return outboundProxyAgent;
}

function getConfiguredOutboundProxyUrl(requestUrl = "") {
  if (shouldBypassConfiguredProxyForUrl(requestUrl)) return "";
  const preferredProtocol = getUrlProtocol(requestUrl);
  if (preferredProtocol === "http:") {
    return process.env.DPRK_SEARCH_ASSET_PROXY
      || process.env.HTTP_PROXY
      || process.env.http_proxy
      || process.env.ALL_PROXY
      || process.env.all_proxy
      || "";
  }
  return process.env.DPRK_SEARCH_ASSET_PROXY
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || process.env.ALL_PROXY
    || process.env.all_proxy
    || "";
}

function shouldBypassConfiguredProxyForUrl(requestUrl = "") {
  const rules = String(process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
  if (!rules.length) return false;
  const { hostname, port } = getUrlHostAndPort(requestUrl);
  if (!hostname) return false;
  return rules.some((rule) => proxyBypassRuleMatches(rule, hostname, port));
}

function getUrlHostAndPort(value = "") {
  try {
    const url = new URL(value);
    return {
      hostname: url.hostname.toLocaleLowerCase("en-US").replace(/\.$/, ""),
      port: url.port || (url.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    return { hostname: "", port: "" };
  }
}

function proxyBypassRuleMatches(rule = "", hostname = "", port = "") {
  if (rule === "*") return true;
  const [rawHost, rulePort = ""] = rule.toLocaleLowerCase("en-US").split(":");
  if (rulePort && rulePort !== port) return false;
  const hostRule = rawHost.replace(/^\*\./, ".").replace(/\.$/, "");
  if (!hostRule) return false;
  if (hostRule.startsWith(".")) {
    const suffix = hostRule.slice(1);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === hostRule || hostname.endsWith(`.${hostRule}`);
}

function getUrlProtocol(value = "") {
  try {
    return new URL(value).protocol;
  } catch {
    return "";
  }
}

function getRequestAssetUrl(request = {}) {
  const queryValue = request.query?.url;
  if (Array.isArray(queryValue)) return queryValue[0] || "";
  if (typeof queryValue === "string") return queryValue;
  try {
    return new URL(request.url || "", "http://localhost").searchParams.get("url") || "";
  } catch {
    return "";
  }
}

function getRequestHeader(request = {}, name = "") {
  const headerName = String(name || "").toLocaleLowerCase("en-US");
  const headers = request.headers || {};
  if (headers && typeof headers.get === "function") return headers.get(headerName) || "";
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLocaleLowerCase("en-US") === headerName) {
      return Array.isArray(value) ? String(value[0] || "") : String(value || "");
    }
  }
  return "";
}

function parseAllowedAssetUrl(value = "") {
  try {
    const parsed = new URL(value);
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    if (!ALLOWED_ASSET_HOSTS.has(parsed.hostname.toLocaleLowerCase("en-US"))) return null;
    if (!isDirectAssetUrl(parsed.href)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isDirectAssetUrl(value = "") {
  return /\.(?:avif|gif|jpe?g|pdf|png|svg|webp)(?:$|[?#])/i.test(value)
    || isKcnaImageEndpoint(value);
}

function isKcnaImageEndpoint(value = "") {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    return host === "kcna.kp"
      && /^\/(?:kp|en|jp|cn|ru|sp|es)\/image\/q\/[^/?#]+\.kcmsf$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function getAcceptHeader(url = "") {
  if (/\.pdf(?:$|[?#])/i.test(url)) return "application/pdf,*/*;q=0.8";
  return "image/avif,image/webp,image/png,image/jpeg,image/svg+xml,image/*,*/*;q=0.8";
}

function inferContentType(url = "") {
  if (/\.pdf(?:$|[?#])/i.test(url)) return "application/pdf";
  if (/\.svg(?:$|[?#])/i.test(url)) return "image/svg+xml";
  if (/\.png(?:$|[?#])/i.test(url)) return "image/png";
  if (/\.webp(?:$|[?#])/i.test(url)) return "image/webp";
  if (/\.gif(?:$|[?#])/i.test(url)) return "image/gif";
  return "image/jpeg";
}

function isSafeAssetContentType(contentType = "") {
  const normalized = String(contentType || "").toLocaleLowerCase("en-US");
  return normalized.startsWith("image/")
    || normalized.includes("application/pdf")
    || normalized.includes("octet-stream");
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  setAssetSecurityHeaders(response);
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(JSON.stringify(payload));
}

function setAssetSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", ASSET_CONTENT_SECURITY_POLICY);
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}
