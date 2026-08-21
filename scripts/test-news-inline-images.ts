#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_INLINE_IMAGE_BYTES,
  buildNewsInlineImageDocuments,
  decodeInlineImageDataUri,
  enrichNewsArticleWithInlineImages,
  extractNewsImageCandidates,
  extractNewsInlineImages,
  fetchNewsRemoteImage,
  mirrorNewsInlineImages,
} from "./news-inline-images.ts";

const jpegBytes = Buffer.from("/9j/4AAQSkZJRg==", "base64");
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlZ/pAAAAAASUVORK5CYII=",
  "base64",
);
const gifBytes = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const webpBytes = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

assert.equal(MAX_INLINE_IMAGE_BYTES, 16 * 1024 * 1024);
assertDecodedImage(`data:;base64,${jpegBytes.toString("base64")}`, "image/jpeg", ".jpg");
assertDecodedImage(`data:image/png;base64,${pngBytes.toString("base64")}`, "image/png", ".png");
assertDecodedImage(`data:image/gif;base64,${gifBytes.toString("base64")}`, "image/gif", ".gif");
assertDecodedImage(`data:image/webp;base64,${webpBytes.toString("base64")}`, "image/webp", ".webp");
assert.equal(
  decodeInlineImageDataUri(`data:image/png;base64,${jpegBytes.toString("base64")}`),
  null,
  "declared and magic-sniffed image formats must agree",
);
assert.equal(
  decodeInlineImageDataUri(`data:;base64,${jpegBytes.toString("base64")}`, { maxBytes: jpegBytes.byteLength - 1 }),
  null,
  "the decoded-byte limit must be checked before returning image bytes",
);
assert.equal(decodeInlineImageDataUri("data:text/html;base64,PGgxPm5vPC9oMT4="), null);
assert.equal(decodeInlineImageDataUri("data:image/jpeg;base64,not-valid-%"), null);

const html = `<!doctype html><html><body>
  <header><img id="header-logo" src="data:image/png;base64,${pngBytes.toString("base64")}"></header>
  <div id="news_view">
    <img id="article-logo-mark" src="data:image/png;base64,${pngBytes.toString("base64")}">
    <p class="TextP">기사 본문</p>
    <img id="Img20260505-042314-01" alt="첫 사진" src="data:;base64,${jpegBytes.toString("base64")}">
    <img id="Img20260505-042314-02" alt="둘째 사진" src="data:image/png;base64,${pngBytes.toString("base64")}">
    <footer><img src="data:image/gif;base64,${gifBytes.toString("base64")}"></footer>
  </div>
  <img id="outside-photo" src="data:image/gif;base64,${gifBytes.toString("base64")}">
</body></html>`;

const extracted = extractNewsInlineImages(html);
assert.deepEqual(extracted.map((image) => image.contentType), ["image/jpeg", "image/png"]);
assert.deepEqual(extracted.map((image) => image.elementId), [
  "Img20260505-042314-01",
  "Img20260505-042314-02",
]);
assert.deepEqual(extracted.map((image) => image.galleryIndex), [0, 1]);
assert.deepEqual(extracted.map((image) => image.displayOrder), [0, 1]);
assert.equal(extractNewsInlineImages(html, { maxImages: 1 }).length, 1);

const remoteArticleUrl = "http://www.kcna.kp/kp/article/q/fixture?lang=kor";
const remoteHtml = `<!doctype html><html><body>
  <header><img src="/assets/img/home/logo.png"></header>
  <main>
    <img id="remote-lead" alt="현지지도 사진" src="/photo/lead-hash">
    <img id="inline-middle" alt="본문 사진" src="data:image/png;base64,${pngBytes.toString("base64")}">
    <img id="remote-gallery" src="http://www.kcna.kp/photo/gallery-hash#viewer">
    <img id="article-logo" src="/assets/img/home/mark.png">
    <nav><img id="nav-photo" src="/photo/nav-photo"></nav>
    <img id="external-photo" src="https://cdn.example/photo/external">
    <img id="different-scheme" src="https://www.kcna.kp/photo/https-origin">
    <img id="blob-photo" src="blob:http://www.kcna.kp/local-object">
    <img id="oversized-photo" src="./photo/too-large">
    <img id="invalid-photo" src="/photo/not-an-image">
  </main>
  <img id="outside-main" src="/photo/outside-main">
</body></html>`;

const remoteCandidates = extractNewsImageCandidates(remoteHtml, { articleUrl: remoteArticleUrl });
assert.deepEqual(remoteCandidates.map((candidate) => candidate.kind), [
  "remote",
  "inline",
  "remote",
  "remote",
  "remote",
]);
assert.deepEqual(remoteCandidates.map((candidate) => candidate.elementId), [
  "remote-lead",
  "inline-middle",
  "remote-gallery",
  "oversized-photo",
  "invalid-photo",
]);
assert.deepEqual(
  remoteCandidates.filter((candidate) => candidate.kind === "remote").map((candidate) => candidate.url),
  [
    "http://www.kcna.kp/photo/lead-hash",
    "http://www.kcna.kp/photo/gallery-hash",
    "http://www.kcna.kp/kp/article/q/photo/too-large",
    "http://www.kcna.kp/photo/not-an-image",
  ],
  "relative paths must resolve against the article and URL fragments must be removed",
);
assert.equal(
  extractNewsImageCandidates(remoteHtml, { articleUrl: "not-a-url" })
    .every((candidate) => candidate.kind === "inline"),
  true,
  "remote candidates require a valid HTTP article base URL",
);

await assert.rejects(
  fetchNewsRemoteImage("http://www.kcna.kp/photo/stream-too-large", {
    maxBytes: jpegBytes.byteLength - 1,
    timeoutMs: 1000,
    fetchImageImpl: async () => new Response(jpegBytes, {
      status: 200,
      headers: { "Content-Type": "image/jpeg" },
    }),
  }),
  /exceeds/u,
  "streamed response bodies must stop at the byte limit",
);

const article = {
  id: "rodong-sinmun-fixture",
  title: "생산현장에서 혁신의 불길을 세차게 지펴올리고있다",
  snippet: "생산현장 기사",
  body: "기사 본문",
  date: "2026-05-05",
  sourceId: "rodong-sinmun",
  sourceName: "로동신문",
  sourceType: "official_site",
  mediaType: "article",
  url: "http://www.rodong.rep.kp/ko/index.php?fixture",
  archiveUrl: "",
  thumbnailUrl: "",
  cachedThumbnailUrl: "",
  language: "ko",
  aliases: ["로동신문 기사"],
};

const tempAssetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-inline-"));
try {
  const mirrored = await mirrorNewsInlineImages({ html, article, assetDir: tempAssetDir });
  assert.equal(mirrored.images.length, 2);
  assert.equal(mirrored.article.cachedThumbnailUrl, mirrored.images[0].publicUrl);
  assert.match(
    mirrored.article.cachedThumbnailUrl,
    /^\/data\/search\/assets\/rodong-sinmun\/[a-f0-9]{64}\.jpg$/u,
  );
  assert.deepEqual(mirrored.imageDocuments.map((document) => document.galleryIndex), [0, 1]);
  assert.deepEqual(mirrored.imageDocuments.map((document) => document.displayOrder), [0, 1]);
  assert.equal(new Set(mirrored.imageDocuments.map((document) => document.id)).size, 2);

  for (const [index, document] of mirrored.imageDocuments.entries()) {
    const image = mirrored.images[index];
    assert.equal(document.sourceId, article.sourceId);
    assert.equal(document.mediaType, "image");
    assert.equal(document.url, article.url);
    assert.equal(document.archiveUrl, article.url);
    assert.equal(document.thumbnailUrl, "");
    assert.equal(document.cachedUrl, image.publicUrl);
    assert.equal(document.cachedThumbnailUrl, image.publicUrl);
    assert.equal(document.searchTabs.includes("image"), true);
    assert.equal(path.dirname(image.assetPath), path.join(tempAssetDir, article.sourceId));
    assert.equal(image.sha256, createHash("sha256").update(image.bytes).digest("hex"));
    assert.equal(path.basename(image.assetPath), `${image.sha256}${image.extension}`);
    assert.deepEqual(await fs.readFile(image.assetPath), image.bytes);
  }

  const repeated = await enrichNewsArticleWithInlineImages({
    html,
    article,
    sourceId: article.sourceId,
    assetDir: tempAssetDir,
    publicBase: "/data/search/assets",
  });
  assert.deepEqual(
    repeated.images.map((image) => image.publicUrl),
    mirrored.images.map((image) => image.publicUrl),
    "reruns should keep the same content-addressed static asset URLs",
  );

  const duplicateGallery = buildNewsInlineImageDocuments(article, [
    mirrored.images[0],
    { ...mirrored.images[0], galleryIndex: 1, displayOrder: 1 },
  ]);
  assert.equal(new Set(duplicateGallery.imageDocuments.map((document) => document.id)).size, 2);
  assert.deepEqual(duplicateGallery.imageDocuments.map((document) => document.displayOrder), [0, 1]);

  const existingThumbnail = "/data/search/assets/rodong-sinmun/existing.jpg";
  const empty = buildNewsInlineImageDocuments({ ...article, cachedThumbnailUrl: existingThumbnail }, []);
  assert.equal(empty.article.cachedThumbnailUrl, existingThumbnail);
  assert.deepEqual(empty.imageDocuments, []);

  const kcnaVideoThumbnail = `data:;base64,${jpegBytes.toString("base64")}`;
  const kcnaVideo = {
    ...article,
    id: "kcna-video-listing-thumbnail",
    title: "조선중앙통신 동화상",
    sourceId: "kcna",
    sourceName: "조선중앙통신",
    mediaType: "video",
    url: "http://www.kcna.kp/kp/video/detail/fixture",
    thumbnailUrl: kcnaVideoThumbnail,
  };
  const mirroredVideo = await mirrorNewsInlineImages({
    html: '<main><div class="video"><video><source src="/kp/video/stream/fixture" type="video/mp4"></video></div></main>',
    article: kcnaVideo,
    assetDir: tempAssetDir,
  });
  assert.equal(mirroredVideo.images.length, 1, "a KCNA video listing thumbnail should become its static preview");
  assert.equal(mirroredVideo.images[0].elementId, "listing-thumbnail");
  assert.match(mirroredVideo.article.cachedThumbnailUrl, /^\/data\/search\/assets\/kcna\/[a-f0-9]{64}\.jpg$/u);
  assert.equal(mirroredVideo.article.thumbnailUrl, "", "the source data URL must not survive after static mirroring");
  assert.equal(mirroredVideo.imageDocuments.length, 1);
  assert.equal(mirroredVideo.imageDocuments[0].archiveUrl, kcnaVideo.url);

  const kcnaArticle = {
    ...article,
    id: "kcna-remote-fixture",
    title: "조선중앙통신 원격 사진 기사",
    sourceId: "kcna",
    sourceName: "조선중앙통신",
    url: remoteArticleUrl,
  };
  const fetchedUrls = [];
  let oversizedBodyRead = false;
  const fetchImageImpl = async (url, options) => {
    fetchedUrls.push(url);
    assert.equal(options.maxBytes, MAX_INLINE_IMAGE_BYTES);
    assert.equal(options.timeoutMs, 1000);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    if (url.endsWith("/photo/lead-hash")) {
      return new Response(jpegBytes, {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg; charset=binary",
          "Content-Length": String(jpegBytes.byteLength),
        },
      });
    }
    if (url.endsWith("/photo/gallery-hash")) {
      return {
        ok: true,
        status: 200,
        contentType: "application/octet-stream",
        bytes: gifBytes,
      };
    }
    if (url.endsWith("/photo/too-large")) {
      return {
        ok: true,
        status: 200,
        headers: { "content-length": String(MAX_INLINE_IMAGE_BYTES + 1) },
        async arrayBuffer() {
          oversizedBodyRead = true;
          return Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1);
        },
      };
    }
    if (url.endsWith("/photo/not-an-image")) {
      return new Response("<html>not an image</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const remoteMirrored = await enrichNewsArticleWithInlineImages({
    html: remoteHtml,
    article: kcnaArticle,
    sourceId: kcnaArticle.sourceId,
    assetDir: tempAssetDir,
    publicBase: "/data/search/assets",
    fetchImageImpl,
    fetchTimeoutMs: 1000,
    fetchConcurrency: 2,
  });
  assert.deepEqual(remoteMirrored.images.map((image) => image.contentType), [
    "image/jpeg",
    "image/png",
    "image/gif",
  ]);
  assert.deepEqual(remoteMirrored.images.map((image) => image.elementId), [
    "remote-lead",
    "inline-middle",
    "remote-gallery",
  ]);
  assert.deepEqual(remoteMirrored.images.map((image) => image.galleryIndex), [0, 1, 2]);
  assert.deepEqual(remoteMirrored.images.map((image) => image.displayOrder), [0, 1, 2]);
  assert.equal(remoteMirrored.failures.length, 2);
  assert.equal(oversizedBodyRead, false, "an oversized Content-Length must reject before reading the body");
  assert.deepEqual([...fetchedUrls].sort(), [
    "http://www.kcna.kp/kp/article/q/photo/too-large",
    "http://www.kcna.kp/photo/gallery-hash",
    "http://www.kcna.kp/photo/lead-hash",
    "http://www.kcna.kp/photo/not-an-image",
  ].sort());
  assert.match(
    remoteMirrored.article.cachedThumbnailUrl,
    /^\/data\/search\/assets\/kcna\/[a-f0-9]{64}\.jpg$/u,
  );
  assert.equal(remoteMirrored.article.cachedThumbnailUrl, remoteMirrored.images[0].publicUrl);
  for (const [index, document] of remoteMirrored.imageDocuments.entries()) {
    assert.equal(document.url, kcnaArticle.url);
    assert.equal(document.archiveUrl, kcnaArticle.url);
    assert.equal(document.cachedUrl, remoteMirrored.images[index].publicUrl);
    assert.equal(document.cachedThumbnailUrl, remoteMirrored.images[index].publicUrl);
    assert.equal(document.galleryIndex, index);
    assert.equal(document.displayOrder, index);
    assert.deepEqual(await fs.readFile(remoteMirrored.images[index].assetPath), remoteMirrored.images[index].bytes);
  }
} finally {
  await fs.rm(tempAssetDir, { recursive: true, force: true });
}

console.log("News image checks passed (inline/remote decode, DOM order, static assets, article linkage).");

function assertDecodedImage(dataUri, contentType, extension) {
  const decoded = decodeInlineImageDataUri(dataUri);
  assert.ok(decoded);
  assert.equal(decoded.contentType, contentType);
  assert.equal(decoded.extension, extension);
  assert.match(decoded.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(decoded.bytes.byteLength > 0);
}
