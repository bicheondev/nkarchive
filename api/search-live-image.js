import { getRodongLiveImage } from "../search/rodongLiveSearch.server.js?v=search-20260823-7";

const CACHE_CONTROL = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800";
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox",
].join("; ");

export default async function handler(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
    return;
  }

  const id = getQueryValue(request, "id");
  if (!id) {
    sendJson(response, 400, { error: "invalid_image_id" });
    return;
  }

  try {
    const image = await getRodongLiveImage(id);
    if (!image) {
      sendJson(response, 404, { error: "image_not_found" });
      return;
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", image.contentType);
    response.setHeader("Content-Length", String(image.bytes.byteLength));
    response.setHeader("Cache-Control", CACHE_CONTROL);
    setSecurityHeaders(response);
    response.end(request.method === "HEAD" ? undefined : image.bytes);
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    sendJson(response, timedOut ? 504 : 502, {
      error: timedOut ? "image_timeout" : "image_unavailable",
    });
  }
}

function getQueryValue(request = {}, name = "") {
  const value = request.query?.[name];
  if (Array.isArray(value)) return String(value[0] || "");
  if (typeof value === "string") return value;
  try {
    return new URL(request.url || "", "http://localhost").searchParams.get(name) || "";
  } catch {
    return "";
  }
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  setSecurityHeaders(response);
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(JSON.stringify(payload));
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}
