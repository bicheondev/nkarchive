#!/usr/bin/env node
import assert from "node:assert/strict";
import { hashPublishedNewsImagePair } from "../lib/news-image-policy.js";
import {
  createNewsImageHandler,
  detectImageFormat,
  parseOfficialNewsImageUrl,
  parseOfficialNewsRefererUrl,
} from "../api/news-image.js";

const kcnaImage = "http://www.kcna.kp/photo/0123456789abcdef0123456789abcdef";
const kcnaReferer = "http://www.kcna.kp/kp/article/detail/0123456789abcdef";
const rodongImage = "http://www.rodong.rep.kp/ko/index.php?MkBAQEBwQDBAMjAyNi8wOC8xNS8yMS8yMDI2LTA4LTE1LTAwMi5qcGc==";
const rodongArticleToken = Buffer.from("12@2026-08-15-002@1@1@@0@1@", "utf8").toString("base64");
const rodongVideoToken = Buffer.from("10@2026-04-12-016@@@@@@@21", "utf8").toString("base64");
const rodongVideoImageToken = Buffer.from("11@2026-04-12-016@@@@@@@21", "utf8").toString("base64");
const rodongReferer = `http://www.rodong.rep.kp/ko/index.php?${rodongArticleToken}`;
const rodongVideoImage = `http://www.rodong.rep.kp/ko/index.php?${rodongVideoImageToken}`;
const publishedPairHashes = new Set([
  hashPublishedNewsImagePair(kcnaImage, kcnaReferer),
  hashPublishedNewsImagePair(rodongImage, rodongReferer),
]);

assert.equal(parseOfficialNewsImageUrl(kcnaImage)?.href, kcnaImage);
assert.equal(parseOfficialNewsImageUrl(rodongImage)?.href, rodongImage);
assert.equal(parseOfficialNewsImageUrl(rodongVideoImage)?.href, rodongVideoImage);
assert.equal(
  parseOfficialNewsImageUrl(`http://www.rodong.rep.kp/ko/index.php?${rodongArticleToken}`),
  null,
  "a Rodong article token must not masquerade as an image endpoint",
);
assert.equal(
  parseOfficialNewsImageUrl(`http://www.rodong.rep.kp/ko/index.php?${rodongVideoToken}`),
  null,
  "a Rodong video-page token must not masquerade as its image endpoint",
);
assert.equal(parseOfficialNewsImageUrl("https://example.com/photo/0123456789abcdef0123456789abcdef"), null);
assert.equal(parseOfficialNewsImageUrl("http://user:pass@www.kcna.kp/photo/0123456789abcdef0123456789abcdef"), null);
assert.equal(parseOfficialNewsImageUrl("data:image/jpeg;base64,/9j/"), null);
assert.equal(parseOfficialNewsRefererUrl(kcnaReferer, new URL(kcnaImage))?.href, kcnaReferer);
assert.equal(parseOfficialNewsRefererUrl(rodongReferer, new URL(rodongImage))?.href, rodongReferer);
assert.equal(parseOfficialNewsRefererUrl("http://example.com/article", new URL(kcnaImage)), null);
assert.equal(
  parseOfficialNewsImageUrl("http://www.kcna.kp:8080/photo/0123456789abcdef0123456789abcdef"),
  null,
  "official hosts with non-default ports must be rejected",
);
assert.equal(
  parseOfficialNewsRefererUrl(
    "http://www.kcna.kp:8080/kp/article/detail/0123456789abcdef",
    new URL(kcnaImage),
  ),
  null,
  "official referers with non-default ports must be rejected",
);

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
assert.deepEqual(detectImageFormat(jpeg), { mimeType: "image/jpeg", extension: "jpg" });
assert.equal(detectImageFormat(Buffer.from("not an image")), null);

const calls = [];
const handler = createNewsImageHandler({
  publishedPairHashes,
  fetchImageImpl: async (url, options) => {
    calls.push({ url: url.href, referer: options.refererUrl.href });
    return { bytes: jpeg, contentType: "image/jpeg" };
  },
});
const getResponse = createResponse();
await handler(createRequest("GET", kcnaImage, kcnaReferer), getResponse);
assert.equal(getResponse.statusCode, 200);
assert.equal(getResponse.headers["Content-Type"], "image/jpeg");
assert.match(getResponse.headers["Cache-Control"], /s-maxage=31536000/u);
assert.deepEqual(getResponse.body, jpeg);
assert.deepEqual(calls, [{ url: kcnaImage, referer: kcnaReferer }]);

const rodongResponse = createResponse();
await handler(createRequest("GET", rodongImage, rodongReferer), rodongResponse);
assert.equal(rodongResponse.statusCode, 200);
assert.equal(calls.length, 2, "both exact published pairs may reach the upstream fetcher");

for (const method of ["HEAD", "OPTIONS", "POST"]) {
  const methodResponse = createResponse();
  await handler(createRequest(method, rodongImage, rodongReferer), methodResponse);
  assert.equal(methodResponse.statusCode, 405);
  assert.equal(methodResponse.headers.Allow, "GET");
  assert.equal(methodResponse.headers["Cache-Control"], "no-store");
}
assert.equal(calls.length, 2, "non-GET methods must make zero upstream calls");

const callsBeforeRejectedPairs = calls.length;
for (const [url, referer, expectedError] of [
  [
    "http://www.kcna.kp/photo/ffffffffffffffffffffffffffffffff",
    kcnaReferer,
    "news_image_not_published",
  ],
  [
    `http://www.rodong.rep.kp/ko/index.php?${Buffer.from("2@@@@p@0@2026/08/15/21/2026-08-15-999.jpg", "utf8").toString("base64")}`,
    rodongReferer,
    "news_image_not_published",
  ],
  [
    kcnaImage,
    "http://www.kcna.kp/kp/article/detail/ffffffffffffffffffffffffffffffff",
    "news_image_not_published",
  ],
]) {
  const rejectedResponse = createResponse();
  await handler(createRequest("GET", url, referer), rejectedResponse);
  assert.equal(rejectedResponse.statusCode, 403);
  assert.equal(JSON.parse(String(rejectedResponse.body)).error, expectedError);
}
assert.equal(calls.length, callsBeforeRejectedPairs, "unpublished or referer-mismatched pairs must make zero upstream calls");

for (const query of [
  { url: "http://www.kcna.kp:8080/photo/0123456789abcdef0123456789abcdef", referer: kcnaReferer },
  { url: kcnaImage, referer: "http://www.kcna.kp:8080/kp/article/detail/0123456789abcdef" },
  { url: kcnaImage },
]) {
  const portResponse = createResponse();
  await handler(query.referer
    ? createRequest("GET", query.url, query.referer)
    : { method: "GET", url: `/api/news-image?url=${encodeURIComponent(query.url)}` }, portResponse);
  assert.equal(portResponse.statusCode, 400);
}
assert.equal(calls.length, callsBeforeRejectedPairs, "invalid ports or a missing referer must make zero upstream calls");

const canonicalRequest = createRequest("GET", kcnaImage, kcnaReferer);
const canonicalQuery = canonicalRequest.url.slice(canonicalRequest.url.indexOf("?") + 1);
const queryShapeVariants = [
  `${canonicalRequest.url}&cache-bust=1`,
  `${canonicalRequest.url}&url=${encodeURIComponent(kcnaImage)}`,
  `${canonicalRequest.url}&referer=${encodeURIComponent(kcnaReferer)}`,
  `${canonicalRequest.url}&=empty-key`,
  `${canonicalRequest.url}&`,
  `/api/news-image?referer=${encodeURIComponent(kcnaReferer)}&url=${encodeURIComponent(kcnaImage)}`,
  `/api/news-image?%75rl=${encodeURIComponent(kcnaImage)}&referer=${encodeURIComponent(kcnaReferer)}`,
  `/api/news-image?${canonicalQuery.replace("%3A", "%3a")}`,
];
for (const url of queryShapeVariants) {
  const shapeResponse = createResponse();
  await handler({ method: "GET", url }, shapeResponse);
  assert.equal(shapeResponse.statusCode, 400, `non-canonical query must be rejected: ${url}`);
  assert.equal(JSON.parse(String(shapeResponse.body)).error, "invalid_news_image_query");
  assert.equal(shapeResponse.headers["Cache-Control"], "no-store");
}
for (const query of [
  { url: [kcnaImage, kcnaImage], referer: kcnaReferer },
  { url: kcnaImage, referer: [kcnaReferer, kcnaReferer] },
  { url: kcnaImage, referer: kcnaReferer, extra: "1" },
  { url: kcnaImage, referer: kcnaReferer, "": "empty-key" },
]) {
  const shapeResponse = createResponse();
  await handler({ method: "GET", query }, shapeResponse);
  assert.equal(shapeResponse.statusCode, 400);
  assert.equal(JSON.parse(String(shapeResponse.body)).error, "invalid_news_image_query");
}
assert.equal(calls.length, callsBeforeRejectedPairs, "cache-key query variants must make zero upstream calls");

const invalidResponse = createResponse();
await handler(createRequest("GET", "http://127.0.0.1/private", kcnaReferer), invalidResponse);
assert.equal(invalidResponse.statusCode, 400);
assert.equal(JSON.parse(String(invalidResponse.body)).error, "invalid_news_image_url");

const oversizedHandler = createNewsImageHandler({
  publishedPairHashes,
  fetchImageImpl: async () => {
    const bytes = Buffer.alloc((4 * 1024 * 1024) + 1);
    jpeg.copy(bytes);
    return { bytes, contentType: "image/jpeg" };
  },
});
const oversizedResponse = createResponse();
await oversizedHandler(createRequest("GET", kcnaImage, kcnaReferer), oversizedResponse);
assert.equal(oversizedResponse.statusCode, 502);
assert.equal(JSON.parse(String(oversizedResponse.body)).error, "news_image_unavailable");

console.log("Standalone news image proxy tests passed.");

function createRequest(method, imageUrl, refererUrl) {
  const query = new URLSearchParams({ url: imageUrl, referer: refererUrl });
  return { method, url: `/api/news-image?${query.toString()}` };
}

function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(value) {
      this.body = value;
    },
  };
}
