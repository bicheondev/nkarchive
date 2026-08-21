#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_NEWS_PUBLIC_ASSET_BASE,
  KCNA_CATEGORY_LISTS,
  NEWS_MIRROR_SCHEMA_VERSION,
  RODONG_CATEGORY_LABELS,
  assertNormalizedNewsDocument,
  cacheNewsImage,
  crawlKcnaNews,
  crawlNewsMirror,
  crawlRodongNews,
  decodeRodongToken,
  detectImageFormat,
  encodeRodongCategoryToken,
  fetchBoundedHtml,
  fetchBoundedImage,
  findKcnaGalleryUrl,
  parseKcnaDetail,
  parseKcnaGalleryImages,
  parseKcnaListing,
  parseRodongCategoryToken,
  parseRodongDetail,
  parseRodongDetailToken,
  parseRodongHomepageCategories,
  parseRodongListing,
  parseRodongVideoToken,
  resolveSameOriginUrl,
} from "./news-mirror-crawler.ts";

const TEST_NOW = new Date("2026-08-22T00:00:00.000Z");
const JPEG_A = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);

const modulePath = fileURLToPath(new URL("./news-mirror-crawler.ts", import.meta.url));
const moduleSource = await fs.readFile(modulePath, "utf8");
const unrelatedProductName = ["sea", "rch"].join("");
assert.doesNotMatch(moduleSource, new RegExp(`from\\s+["'][^"']*${unrelatedProductName}[^"']*["']`, "iu"), "the news crawler must not import an unrelated index module");
assert.doesNotMatch(moduleSource, new RegExp(`data/${unrelatedProductName}`, "iu"), "the news crawler must not use an unrelated data tree");

testConstants();
testKcnaParsers();
testRodongTokensAndParsers();
testUrlAndImageGuards();
await testManualRedirectPolicy();
await testNodeRedirectPolicy();
await testKcnaCrawlWithGalleryAssets();
await testImageCrawlQuotas();
await testSharedRunImageQuota();
await testCategoryMergingAndFairLimit();
await testRodongCrawlPageIterationAndInlineAssets();
await testInvalidImageMagic();

console.log("Independent official news mirror crawler tests passed.");

function testConstants() {
  assert.equal(NEWS_MIRROR_SCHEMA_VERSION, 1);
  assert.equal(DEFAULT_NEWS_PUBLIC_ASSET_BASE, "/data/news/assets");
  assert.deepEqual(KCNA_CATEGORY_LISTS.map((item) => item.id), [
    "leadership", "important", "international", "photo", "anecdote", "document",
    "foreign", "video", "memory", "domestic", "social",
  ]);
  assert.equal(new Set(KCNA_CATEGORY_LISTS.map((item) => item.url)).size, 11);
  assert.ok(KCNA_CATEGORY_LISTS.every((item) => /^http:\/\/www\.kcna\.kp\/kp\/(?:article|gallery|video)\/list\/[a-f0-9]{32}$/u.test(item.url)));
  assert.equal(RODONG_CATEGORY_LABELS["혁명활동소식"], "leadership");
  assert.deepEqual(
    [...new Set(Object.values(RODONG_CATEGORY_LABELS))].sort(),
    ["leadership", "important", "photo", "anecdote", "video", "memory", "domestic", "social"].sort(),
    "Rodong labels must contain only its eight official visible sections",
  );
  assert.deepEqual({
    today: RODONG_CATEGORY_LABELS["오늘호 기사"],
    photo: RODONG_CATEGORY_LABELS["사진"],
    politics: RODONG_CATEGORY_LABELS["인민을 위한 정치"],
    video: RODONG_CATEGORY_LABELS["동영상"],
    culture: RODONG_CATEGORY_LABELS["사회문화생활"],
    advancing: RODONG_CATEGORY_LABELS["전진하는 조선"],
    history: RODONG_CATEGORY_LABELS["유구한 력사,찬란한 문화"],
  }, {
    today: "important",
    photo: "photo",
    politics: "anecdote",
    video: "video",
    culture: "memory",
    advancing: "domestic",
    history: "social",
  });
}

function testKcnaParsers() {
  const listingUrl = "http://kcna.test/kp/article/list/category-id";
  const listingHtml = `
    <main>
      <ul>
        <li class="news-item">
          <a href="/kp/article/q/article-one.kcmsf">
            경애하는 <b>김정은</b>동지께서 공연을 관람하시였다
            <i class="camera-icon" title="사진"></i>
          </a>
          <time>[2026.08.17.]</time>
        </li>
        <li><a href="https://outside.test/kp/article/q/rejected.kcmsf">외부 기사</a> [2026.08.18.]</li>
      </ul>
      <a href="javascript:page(2);">다음페지</a>
    </main>`;
  const parsed = parseKcnaListing(listingHtml, listingUrl, { id: "leadership", label: "혁명활동소식", kind: "article" });
  assert.equal(parsed.entries.length, 1);
  assert.deepEqual(parsed.entries[0], {
    sourceId: "kcna",
    category: { id: "leadership", label: "혁명활동소식" },
    categories: ["leadership"],
    kind: "article",
    title: "경애하는 김정은동지께서 공연을 관람하시였다",
    date: "2026-08-17",
    url: "http://kcna.test/kp/article/q/article-one.kcmsf",
    previewImageUrl: "",
    markers: { camera: true, gallery: false },
  });
  assert.deepEqual(parsed.pageUrls, ["http://kcna.test/kp/article/list/category-id?page=2"]);

  const officialShape = parseKcnaListing(`
    <div class="article"><h5 class="block"><a href="/kp/article/detail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">첫 기사</a><span>[2026.8.17.]</span></h5></div>
    <div class="article"><h5 class="block"><a href="/kp/article/detail/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">둘째 기사</a><span>[2026.8.15.]</span></h5></div>
  `, listingUrl, { id: "leadership", label: "혁명활동소식", kind: "article" });
  assert.deepEqual(officialShape.entries.map((entry) => entry.date), ["2026-08-17", "2026-08-15"], "each official .article row must keep its own date");

  const detailUrl = parsed.entries[0].url;
  const detailHtml = `
    <main>
      <h1>경애하는 <strong>김정은</strong>동지께서 공연을 관람하시였다</h1>
      <div class="date">2026.08.17.</div>
      <div class="article_body">
        <p>경애하는 총비서동지께서 뜻깊은 공연을 관람하시였다.</p>
        <p>공연은 관람자들의 절찬을 받았다.</p>
        <a class="gallery_button" href="/kp/gallery/detail/gallery-one">사진보기</a>
        <a class="gallery_button" href="https://outside.test/kp/gallery/detail/rejected">거부</a>
      </div>
    </main>`;
  const detail = parseKcnaDetail(detailHtml, detailUrl, parsed.entries[0]);
  assert.equal(detail.title, "경애하는 김정은동지께서 공연을 관람하시였다");
  assert.equal(detail.date, "2026-08-17");
  assert.match(detail.body, /공연은 관람자들의 절찬을 받았다/u);
  assert.equal(detail.galleryUrl, "http://kcna.test/kp/gallery/detail/gallery-one");
  assert.equal(detail.markers.gallery, true);
  assert.equal(findKcnaGalleryUrl(detailHtml, detailUrl), detail.galleryUrl);

  const galleryHtml = `
    <main class="gallery">
      <img src="/photo/photo-one.jpg" alt="첫 사진">
      <img data-src="/photo/photo-two.jpg" alt="둘째 사진">
      <img src="/assets/logo.png" alt="장식">
      <img src="https://outside.test/photo/rejected.jpg" alt="외부 사진">
    </main>`;
  assert.deepEqual(parseKcnaGalleryImages(galleryHtml, detail.galleryUrl), [
    { url: "http://kcna.test/photo/photo-one.jpg", referer: detail.galleryUrl, role: "gallery" },
    { url: "http://kcna.test/photo/photo-two.jpg", referer: detail.galleryUrl, role: "gallery" },
  ]);
}

function testRodongTokensAndParsers() {
  const pageOneToken = encodeRodongCategoryToken("1", 1);
  const pageTwoToken = encodeRodongCategoryToken("1", 2);
  assert.equal(decodeRodongToken(pageOneToken), "1@@1@1@");
  assert.deepEqual(parseRodongCategoryToken(pageTwoToken), { page: 2, categoryCode: "1", decoded: "1@@1@2@" });
  assert.equal(
    encodeRodongCategoryToken("7", 5),
    Buffer.from("1@@7@5@", "utf8").toString("base64"),
    "the official category number must occupy the first token field",
  );
  const archivedPageToken = Buffer.from("1@@3@18@@0@", "utf8").toString("base64");
  assert.deepEqual(parseRodongCategoryToken(archivedPageToken), {
    page: 18,
    categoryCode: "3",
    decoded: "1@@3@18@@0@",
  });

  const detailToken = rodongDetailToken("2026-08-17", "1", "001");
  assert.deepEqual(parseRodongDetailToken(detailToken), {
    date: "2026-08-17",
    categoryCode: "1",
    decoded: "12@2026-08-17-001@1@1@@0@1@",
  });
  const queryLikeToken = Buffer.from("8@2026-08-17-001@19@@표현@1", "utf8").toString("base64");
  assert.equal(parseRodongDetailToken(queryLikeToken), null, "only source-visible article tokens are detail records");

  const homepageUrl = "http://rodong.test/ko/";
  const todayToken = encodeRodongCategoryToken("2", 1);
  const homepageHtml = `
    <nav>
      <a href="/index.php?${pageOneToken}"><b>혁명활동소식</b></a>
      <a href="/index.php?${encodeRodongCategoryToken("3", 1)}">인민을 위한 정치</a>
      <a href="/index.php?${encodeRodongCategoryToken("4", 1)}">전진하는 조선</a>
      <a href="/index.php?${encodeRodongCategoryToken("5", 1)}">사회문화생활</a>
      <a href="/index.php?${encodeRodongCategoryToken("7", 1)}">유구한 력사, 찬란한 문화</a>
      <a href="/index.php?${encodeRodongCategoryToken("8", 1)}">사진</a>
      <a href="/index.php?${encodeRodongCategoryToken("9", 1)}">동영상</a>
      <a href="/index.php?${queryLikeToken}">검색</a>
      <a href="https://outside.test/index.php?${pageOneToken}">사진</a>
    </nav>
    <div class="TopClassBG">
      <span class="TopClassTitle">오늘호 기사</span>
      <div class="TopClassLink"><a class="page_link" href="/index.php?${todayToken}">＞＞＞</a></div>
    </div>`;
  assert.deepEqual(parseRodongHomepageCategories(homepageHtml, homepageUrl), [
    { id: "leadership", label: "혁명활동소식", categoryCode: "1", url: `http://rodong.test/index.php?${pageOneToken}` },
    { id: "anecdote", label: "인민을 위한 정치", categoryCode: "3", url: `http://rodong.test/index.php?${encodeRodongCategoryToken("3", 1)}` },
    { id: "domestic", label: "전진하는 조선", categoryCode: "4", url: `http://rodong.test/index.php?${encodeRodongCategoryToken("4", 1)}` },
    { id: "memory", label: "사회문화생활", categoryCode: "5", url: `http://rodong.test/index.php?${encodeRodongCategoryToken("5", 1)}` },
    { id: "social", label: "유구한 력사, 찬란한 문화", categoryCode: "7", url: `http://rodong.test/index.php?${encodeRodongCategoryToken("7", 1)}` },
    { id: "photo", label: "사진", categoryCode: "8", url: `http://rodong.test/index.php?${encodeRodongCategoryToken("8", 1)}` },
    { id: "video", label: "동영상", categoryCode: "9", url: `http://rodong.test/index.php?${encodeRodongCategoryToken("9", 1)}` },
    { id: "important", label: "오늘호 기사", categoryCode: "2", url: `http://rodong.test/index.php?${todayToken}` },
  ]);

  const listingUrl = `http://rodong.test/index.php?${pageOneToken}`;
  const listingHtml = `
    <main>
      <ul><li>
        <a href="/index.php?${detailToken}">경애하는 <b>김정은</b>동지께서 공연을 관람하시였다 <img src="/images/newsf.gif"></a>
        <span class="date">2026.8.17.</span>
      </li></ul>
      <a href="/index.php?${pageTwoToken}">＞＞＞</a>
      <a href="/index.php?${queryLikeToken}">임의 질의 결과</a>
    </main>`;
  const category = { id: "leadership", label: "혁명활동소식", categoryCode: "1", url: listingUrl };
  const listing = parseRodongListing(listingHtml, listingUrl, category);
  assert.equal(listing.entries.length, 1);
  assert.equal(listing.entries[0].title, "경애하는 김정은동지께서 공연을 관람하시였다");
  assert.equal(listing.entries[0].date, "2026-08-17");
  assert.equal(listing.entries[0].previewImageUrl, "", "site chrome artwork must not become a news image");
  assert.deepEqual(listing.pageLinks.map(({ page, categoryCode }) => ({ page, categoryCode })), [
    { page: 2, categoryCode: "1" },
  ]);

  const photoOneToken = Buffer.from("2@@@@p@0@2026/08/15/gallery/one.jpg", "utf8").toString("base64");
  const photoTwoToken = Buffer.from("2@@@@p@0@2026/08/15/gallery/two.jpg", "utf8").toString("base64");
  const photoListing = parseRodongListing(`
    <script>
      $(".fancybox-800").click(function () { his("2026-08-15-004");
        $.fancybox.open([{href:"index.php?${photoOneToken}"}, {href:"index.php?${photoTwoToken}"}]);
      });
    </script>
    <div class="thumbnail">
      <a class="fancybox-800"><img src="data:image/png;base64,${PNG_A.toString("base64")}"></a>
      <div class="caption"><a class="fancybox-800"><p class="span-title">선렬들의 고결한 혁명정신을 새겨안으며</p></a>
        <span class="gallery_cal">2026.8.15.</span>
      </div>
    </div>`, `http://rodong.test/index.php?${encodeRodongCategoryToken("8", 1)}`, {
    id: "photo",
    label: "사진",
    categoryCode: "8",
  });
  assert.equal(photoListing.entries.length, 1);
  assert.equal(photoListing.entries[0].kind, "photo");
  assert.equal(photoListing.entries[0].title, "선렬들의 고결한 혁명정신을 새겨안으며");
  assert.equal(photoListing.entries[0].date, "2026-08-15");
  assert.equal(photoListing.entries[0].embeddedImageReferences.length, 2);

  const videoToken = Buffer.from("10@2026-04-12-016@@@@@@@21", "utf8").toString("base64");
  assert.deepEqual(parseRodongVideoToken(videoToken), {
    date: "2026-04-12",
    decoded: "10@2026-04-12-016@@@@@@@21",
  });
  const videoListing = parseRodongListing(`
    <div class="thumbnail">
      <div class="ui-desc"><a href="/index.php?${videoToken}"><img src="data:image/png;base64,${PNG_A.toString("base64")}"></a></div>
      <div class="caption"><a href="/index.php?${videoToken}"><p class="span-title">조선의 특산 개성고려인삼</p></a>
        <span class="gallery_cal">2026.4.12.</span>
      </div>
    </div>`, `http://rodong.test/index.php?${encodeRodongCategoryToken("9", 1)}`, {
    id: "video",
    label: "동영상",
    categoryCode: "9",
  });
  assert.equal(videoListing.entries.length, 1);
  assert.equal(videoListing.entries[0].kind, "video");
  assert.equal(videoListing.entries[0].title, "조선의 특산 개성고려인삼");
  assert.equal(videoListing.entries[0].previewImageUrl.startsWith("data:image/png;base64,"), true);

  const inlinePng = `data:image/png;base64,${PNG_A.toString("base64")}`;
  const detailUrl = listing.entries[0].url;
  const detailHtml = `
    <main>
      <h1>경애하는 <b>김정은</b>동지께서 공연을 관람하시였다</h1>
      <div class="rodong_view">
        <p>뜻깊은 공연이 성황리에 진행되였다.</p>
        <img data-src="/index.php?${Buffer.from("02@@@u@0@2026/08/17/photo", "utf8").toString("base64")}" alt="기사 사진">
        <img src="${inlinePng}" alt="본문 자료 사진">
      </div>
    </main>`;
  const detail = parseRodongDetail(detailHtml, detailUrl, listing.entries[0]);
  assert.equal(detail.title, "경애하는 김정은동지께서 공연을 관람하시였다");
  assert.equal(detail.date, "2026-08-17");
  assert.equal(detail.imageUrls.length, 2);
  assert.equal(detail.markers.camera, true);
}

function testUrlAndImageGuards() {
  assert.equal(resolveSameOriginUrl("/photo/a.jpg", "http://kcna.test/kp/article/q/a.kcmsf"), "http://kcna.test/photo/a.jpg");
  assert.equal(resolveSameOriginUrl("https://kcna.test/photo/a.jpg", "http://kcna.test/kp/article/q/a.kcmsf"), "");
  assert.equal(resolveSameOriginUrl("https://outside.test/photo/a.jpg", "http://kcna.test/kp/article/q/a.kcmsf"), "");
  assert.equal(resolveSameOriginUrl("javascript:alert(1)", "http://kcna.test/kp/article/q/a.kcmsf"), "");
  assert.deepEqual(detectImageFormat(JPEG_A), { extension: "jpg", mimeType: "image/jpeg" });
  assert.deepEqual(detectImageFormat(PNG_A), { extension: "png", mimeType: "image/png" });
  assert.equal(detectImageFormat(Buffer.from("not an image")), null);
}

async function testManualRedirectPolicy() {
  const startUrl = "http://redirect.test/start";
  const middleUrl = "http://redirect.test/middle";
  const finalUrl = "http://redirect.test/final";
  const requests = [];
  const fetchImpl = fixtureFetch(new Map([
    [startUrl, redirectResponse("/middle")],
    [middleUrl, redirectResponse("/final", 307)],
    [finalUrl, htmlResponse("<main>same-origin redirect result</main>")],
  ]), requests);
  const html = await fetchBoundedHtml(startUrl, { fetchImpl, maxRedirects: 2, timeoutMs: 1_000 });
  assert.match(html, /same-origin redirect result/u);
  assert.deepEqual(requests.map((request) => request.url), [startUrl, middleUrl, finalUrl]);
  assert.ok(requests.every((request) => request.init.redirect === "manual"), "every fetch hop must disable automatic redirects");

  const crossOriginStart = "http://redirect.test/cross-origin";
  const crossOriginTarget = "http://outside.test/secret";
  let crossOriginTargetHits = 0;
  const crossOriginRequests = [];
  const crossOriginFetch = fixtureFetch(new Map([
    [crossOriginStart, redirectResponse(crossOriginTarget)],
    [crossOriginTarget, () => {
      crossOriginTargetHits += 1;
      return htmlResponse("must not be reached");
    }],
  ]), crossOriginRequests);
  await assert.rejects(
    fetchBoundedHtml(crossOriginStart, { fetchImpl: crossOriginFetch, timeoutMs: 1_000 }),
    /Cross-origin redirect rejected/iu,
  );
  assert.equal(crossOriginTargetHits, 0, "a cross-origin redirect target must be rejected before dispatch");
  assert.deepEqual(crossOriginRequests.map((request) => request.url), [crossOriginStart]);

  const limitedRequests = [];
  const limitedFetch = fixtureFetch(new Map([
    [startUrl, redirectResponse("/middle")],
    [middleUrl, redirectResponse("/final")],
    [finalUrl, htmlResponse("must not be reached")],
  ]), limitedRequests);
  await assert.rejects(
    fetchBoundedHtml(startUrl, { fetchImpl: limitedFetch, maxRedirects: 1, timeoutMs: 1_000 }),
    /Redirect limit of 1 exceeded/iu,
  );
  assert.deepEqual(limitedRequests.map((request) => request.url), [startUrl, middleUrl]);
}

async function testNodeRedirectPolicy() {
  let targetHits = 0;
  const targetServer = http.createServer((_, response) => {
    targetHits += 1;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("must not be reached");
  });
  const redirectServer = http.createServer((_, response) => {
    response.writeHead(302, { Location: serverUrl(targetServer) });
    response.end();
  });
  await listenOnLoopback(targetServer);
  await listenOnLoopback(redirectServer);
  try {
    await assert.rejects(
      fetchBoundedHtml(`${serverUrl(redirectServer)}/start`, {
        fetchImpl: globalThis.fetch,
        preferNodeDirect: true,
        timeoutMs: 1_000,
      }),
      /Cross-origin redirect rejected/iu,
    );
    assert.equal(targetHits, 0, "the direct HTTP path must validate a redirect before opening the next connection");
  } finally {
    await Promise.all([closeServer(redirectServer), closeServer(targetServer)]);
  }
}

async function testKcnaCrawlWithGalleryAssets() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-kcna-"));
  const listingUrl = "http://kcna.test/kp/article/list/fixture-category";
  const detailUrl = "http://kcna.test/kp/article/q/article-one.kcmsf";
  const galleryUrl = "http://kcna.test/kp/gallery/detail/gallery-one";
  const galleryImages = Array.from({ length: 11 }, (_, index) => ({
    url: `http://kcna.test/photo/photo-${index + 1}.jpg`,
    bytes: Buffer.concat([JPEG_A, Buffer.from([index + 1])]),
  }));
  const requests = [];
  const fixtures = new Map([
    [listingUrl, htmlResponse(`<ul><li><a href="${detailUrl}">새 기사</a><time>2026.08.17.</time><i class="camera"></i></li></ul>`)],
    [detailUrl, htmlResponse(`<main><h1>새 기사</h1><time>2026.08.17.</time><div class="article_body"><p>새 기사의 충분한 본문입니다.</p><a class="gallery_button" href="${galleryUrl}">사진</a></div></main>`)],
    [galleryUrl, htmlResponse(`<main class="gallery">${galleryImages.map((image) => `<img src="${image.url}">`).join("")}<img src="https://outside.test/photo/no.jpg"></main>`)],
  ]);
  for (const image of galleryImages) fixtures.set(image.url, imageResponse(image.bytes, "image/jpeg"));
  const fetchImpl = fixtureFetch(fixtures, requests);

  try {
    const result = await crawlKcnaNews({
      categoryLists: [{ id: "leadership", label: "혁명활동소식", kind: "article", url: listingUrl }],
      fetchImpl,
      assetDir,
      publicAssetBase: "/data/news/assets",
      now: TEST_NOW,
      maxListPages: 1,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.documents.length, 1);
    const [document] = result.documents;
    assert.equal(assertNormalizedNewsDocument(document), true);
    assert.equal(document.title, "새 기사");
    assert.equal(document.date, "2026-08-17");
    assert.equal(document.galleryUrl, galleryUrl);
    assert.equal(document.images.length, 11, "a legitimate 11-image KCNA gallery must fit under the document cap");
    assert.ok(document.images.every((image) => /^\/data\/news\/assets\/kcna\/[a-f0-9]{64}\.jpg$/u.test(image.cachedUrl)));
    assert.deepEqual(
      requests.filter((request) => request.url.startsWith("http://kcna.test/photo/")).map((request) => request.init.headers.Referer),
      Array.from({ length: 11 }, () => galleryUrl),
      "each KCNA /photo/ request must carry its same-origin gallery Referer",
    );
    const files = await fs.readdir(path.join(assetDir, "kcna"));
    assert.equal(files.length, 11);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testImageCrawlQuotas() {
  await withKcnaImageFixture("document-cap", 20, {
    maxImagesPerDocument: 3,
  }, async ({ assetDir, imageUrls, requests, result }) => {
    assert.equal(result.documents[0].images.length, 3);
    assert.equal(countRequestedImages(requests, imageUrls), 3);
    assert.match(result.errors.find((error) => /Document image limit/iu.test(error.error))?.error || "", /skipped 17/iu);
    assert.equal(result.stats.imageQuota.skippedReferences, 17);
    assert.equal((await fs.readdir(path.join(assetDir, "kcna"))).length, 3);
  });

  await withKcnaImageFixture("crawl-count-cap", 5, {
    imageConcurrency: 1,
    maxImagesPerCrawl: 2,
  }, async ({ assetDir, imageUrls, requests, result }) => {
    assert.equal(result.documents[0].images.length, 2);
    assert.equal(countRequestedImages(requests, imageUrls), 2, "the crawl count ceiling must stop requests, not only writes");
    assert.equal(result.stats.imageQuota.requestsStarted, 2);
    assert.equal(result.stats.imageQuota.skippedReferences, 3);
    assert.ok(result.errors.some((error) => /Crawl image request limit of 2 reached/iu.test(error.error)));
    assert.equal((await fs.readdir(path.join(assetDir, "kcna"))).length, 2);
  });

  await withKcnaImageFixture("crawl-byte-cap", 5, {
    imageConcurrency: 1,
    imageMaxBytes: 64,
    maxImageBytesPerCrawl: 100,
  }, async ({ assetDir, imageUrls, requests, result }) => {
    assert.equal(result.documents[0].images.length, 2);
    assert.equal(countRequestedImages(requests, imageUrls), 2, "the aggregate byte ceiling must prevent further downloads");
    assert.equal(result.stats.imageQuota.acceptedBytes, 80);
    assert.equal(result.stats.imageQuota.quotaBytesCharged, 80);
    assert.equal(result.stats.imageQuota.maxBytesPerCrawl, 100);
    assert.ok(result.errors.some((error) => /Crawl image byte limit of 100 reached/iu.test(error.error)));
    assert.equal((await fs.readdir(path.join(assetDir, "kcna"))).length, 2);
  });
}

async function testSharedRunImageQuota() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-shared-cap-"));
  const kcnaListUrl = "http://kcna-shared.test/kp/article/list/fixture-category";
  const kcnaDetailUrl = "http://kcna-shared.test/kp/article/q/article-one.kcmsf";
  const kcnaImageUrl = "http://kcna-shared.test/photo/image-one.jpg";
  const rodongHomepageUrl = "http://rodong-shared.test/ko/";
  const rodongPageToken = encodeRodongCategoryToken("1", 1);
  const rodongListUrl = `http://rodong-shared.test/index.php?${rodongPageToken}`;
  const rodongArticleToken = rodongDetailToken("2026-08-17", "1", "001");
  const rodongDetailUrl = `http://rodong-shared.test/index.php?${rodongArticleToken}`;
  const rodongImageToken = Buffer.from("02@@@u@0@2026/08/17/shared-image", "utf8").toString("base64");
  const rodongImageUrl = `http://rodong-shared.test/index.php?${rodongImageToken}`;
  const requests = [];
  const fetchImpl = fixtureFetch(new Map([
    [kcnaListUrl, htmlResponse(`<ul><li><a href="${kcnaDetailUrl}">공유 제한 중앙통신 기사</a><time>2026.08.17.</time></li></ul>`)],
    [kcnaDetailUrl, htmlResponse(`<main><h1>공유 제한 중앙통신 기사</h1><time>2026.08.17.</time><div class="article_body"><p>공유 제한을 검증하는 중앙통신 기사 본문입니다.</p><img src="${kcnaImageUrl}"></div></main>`)],
    [kcnaImageUrl, imageResponse(JPEG_A, "image/jpeg")],
    [rodongHomepageUrl, htmlResponse(`<nav><a href="/index.php?${rodongPageToken}">혁명활동소식</a></nav>`)],
    [rodongListUrl, htmlResponse(`<main><a href="/index.php?${rodongArticleToken}">공유 제한 로동신문 기사</a><time>2026.08.17.</time></main>`)],
    [rodongDetailUrl, htmlResponse(`<main><h1>공유 제한 로동신문 기사</h1><div class="rodong_view"><p>공유 제한을 검증하는 로동신문 기사 본문입니다.</p><img src="/index.php?${rodongImageToken}"></div></main>`)],
    [rodongImageUrl, imageResponse(Buffer.concat([JPEG_A, Buffer.from([0x01])]), "image/jpeg")],
  ]), requests);
  try {
    const result = await crawlNewsMirror({
      fetchImpl,
      assetDir,
      now: TEST_NOW,
      maxImagesPerCrawl: 1,
      imageConcurrency: 1,
      kcna: {
        categoryLists: [{ id: "leadership", label: "혁명활동소식", kind: "article", url: kcnaListUrl }],
        maxListPages: 1,
      },
      rodong: { homepageUrl: rodongHomepageUrl, maxListPages: 1 },
    });
    assert.equal(result.documents.length, 2);
    assert.equal(countRequestedImages(requests, [kcnaImageUrl, rodongImageUrl]), 1, "both sources must share one run-level request ceiling");
    assert.equal(result.documents.reduce((sum, document) => sum + document.images.length, 0), 1);
    assert.equal(
      result.sources.kcna.stats.imageQuota.requestsStarted
        + result.sources["rodong-sinmun"].stats.imageQuota.requestsStarted,
      1,
    );
    assert.equal(result.sources.kcna.stats.imageQuota.sharedAcrossSources, true);
    assert.equal(result.sources["rodong-sinmun"].stats.imageQuota.sharedAcrossSources, true);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function withKcnaImageFixture(name, imageCount, crawlOptions, verify) {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), `nkarchive-news-${name}-`));
  const origin = `http://${name}.test`;
  const listingUrl = `${origin}/kp/article/list/fixture-category`;
  const detailUrl = `${origin}/kp/article/q/article-one.kcmsf`;
  const imageUrls = Array.from({ length: imageCount }, (_, index) => `${origin}/photo/image-${index + 1}.jpg`);
  const imageTags = imageUrls.map((url) => `<img src="${url}">`).join("");
  const fixtures = new Map([
    [listingUrl, htmlResponse(`<ul><li><a href="${detailUrl}">화상 제한 시험 기사</a><time>2026.08.17.</time></li></ul>`)],
    [detailUrl, htmlResponse(`<main><h1>화상 제한 시험 기사</h1><time>2026.08.17.</time><div class="article_body"><p>화상 제한을 검증하기 위한 충분한 본문입니다.</p>${imageTags}</div></main>`)],
  ]);
  imageUrls.forEach((url, index) => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, index + 1]),
      Buffer.alloc(33, index + 1),
      Buffer.from([0xff, 0xd9]),
    ]);
    assert.equal(bytes.length, 40);
    fixtures.set(url, imageResponse(bytes, "image/jpeg"));
  });
  const requests = [];
  try {
    const result = await crawlKcnaNews({
      categoryLists: [{ id: "leadership", label: "혁명활동소식", kind: "article", url: listingUrl }],
      fetchImpl: fixtureFetch(fixtures, requests),
      assetDir,
      now: TEST_NOW,
      maxListPages: 1,
      ...crawlOptions,
    });
    assert.equal(result.documents.length, 1);
    await verify({ assetDir, imageUrls, requests, result });
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

function countRequestedImages(requests, imageUrls) {
  const imageUrlSet = new Set(imageUrls);
  return requests.filter((request) => imageUrlSet.has(request.url)).length;
}

async function testRodongCrawlPageIterationAndInlineAssets() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-rodong-"));
  const homepageUrl = "http://rodong.test/ko/";
  const firstPageToken = encodeRodongCategoryToken("1", 1);
  const secondPageToken = encodeRodongCategoryToken("1", 2);
  const wrongCategoryToken = encodeRodongCategoryToken("3", 2);
  const firstPageUrl = `http://rodong.test/index.php?${firstPageToken}`;
  const secondPageUrl = `http://rodong.test/index.php?${secondPageToken}`;
  const detailOneToken = rodongDetailToken("2026-08-17", "1", "001");
  const detailTwoToken = rodongDetailToken("2026-08-15", "1", "002");
  const detailOneUrl = `http://rodong.test/index.php?${detailOneToken}`;
  const detailTwoUrl = `http://rodong.test/index.php?${detailTwoToken}`;
  const imageToken = Buffer.from("02@@@u@0@2026/08/17/1/article_label", "utf8").toString("base64");
  const imageUrl = `http://rodong.test/index.php?${imageToken}`;
  const queryLikeToken = Buffer.from("8@2026-08-17-001@19@@임의@1", "utf8").toString("base64");
  const queryLikeUrl = `http://rodong.test/index.php?${queryLikeToken}`;
  const requests = [];
  const fetchImpl = fixtureFetch(new Map([
    [homepageUrl, htmlResponse(`<nav><a href="/index.php?${firstPageToken}">혁명활동소식</a><a href="/index.php?${queryLikeToken}">검색</a></nav>`)],
    [firstPageUrl, htmlResponse(`<main><ul><li><a href="/index.php?${detailOneToken}">경애하는 <b>김정은</b>동지께서 공연을 관람하시였다</a><time>2026.8.17.</time></li></ul><a href="/index.php?${secondPageToken}">2</a><a href="/index.php?${wrongCategoryToken}">다른 분류</a></main>`)],
    [secondPageUrl, htmlResponse(`<main><ul><li><a href="/index.php?${detailTwoToken}">조국해방을 경축하는 행사 진행</a><time>2026.8.15.</time></li></ul><a href="/index.php?${firstPageToken}">1</a></main>`)],
    [detailOneUrl, htmlResponse(`<main><h1>경애하는 <b>김정은</b>동지께서 공연을 관람하시였다</h1><div class="rodong_view"><p>공연이 성황리에 진행되였다.</p><img data-src="/index.php?${imageToken}"><img src="data:image/png;base64,${PNG_A.toString("base64")}"></div></main>`)],
    [detailTwoUrl, htmlResponse(`<main><h1>조국해방을 경축하는 행사 진행</h1><div class="rodong_view"><p>뜻깊은 경축행사가 진행되였다.</p></div></main>`)],
    [imageUrl, imageResponse(JPEG_A, "image/jpeg")],
  ]), requests);

  try {
    const result = await crawlRodongNews({
      homepageUrl,
      fetchImpl,
      assetDir,
      publicAssetBase: "/data/news/assets",
      now: TEST_NOW,
      maxListPages: 3,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.stats.listingPagesFetched, 2, "only page links from the same visible category may be followed");
    assert.deepEqual(result.documents.map((document) => document.date), ["2026-08-17", "2026-08-15"]);
    assert.equal(result.documents[0].title, "경애하는 김정은동지께서 공연을 관람하시였다");
    assert.equal(result.documents[0].images.length, 2);
    assert.ok(result.documents[0].images.some((image) => image.mimeType === "image/jpeg"));
    assert.ok(result.documents[0].images.some((image) => image.mimeType === "image/png"));
    assert.ok(result.documents[0].images.every((image) => image.cachedUrl.startsWith("/data/news/assets/rodong-sinmun/")));
    assert.equal(requests.some((request) => request.url === queryLikeUrl), false, "an unrelated query-like token must never seed a request");
    assert.equal(requests.some((request) => request.url.includes(wrongCategoryToken)), false, "pagination must retain the selected category code");
    assert.equal(requests.find((request) => request.url === imageUrl)?.init.headers.Referer, detailOneUrl);
    assert.deepEqual(
      requests.filter((request) => request.url === firstPageUrl || request.url === secondPageUrl).map((request) => request.url),
      [firstPageUrl, secondPageUrl],
      "the decoded `1@@category@page@` ordering must drive page iteration",
    );
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testCategoryMergingAndFairLimit() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-fairness-"));
  const firstList = "http://kcna.test/kp/article/list/first-category";
  const secondList = "http://kcna.test/kp/article/list/second-category";
  const sharedDetail = "http://kcna.test/kp/article/q/shared.kcmsf";
  const firstOnlyDetail = "http://kcna.test/kp/article/q/first-only.kcmsf";
  const secondOnlyDetail = "http://kcna.test/kp/article/q/second-only.kcmsf";
  const fetchImpl = fixtureFetch(new Map([
    [firstList, htmlResponse(`<ul><li><a href="${sharedDetail}">공동 기사</a><time>2026.08.22.</time></li><li><a href="${firstOnlyDetail}">첫 분류 기사</a><time>2026.08.21.</time></li></ul>`)],
    [secondList, htmlResponse(`<ul><li><a href="${sharedDetail}">공동 기사</a><time>2026.08.22.</time></li><li><a href="${secondOnlyDetail}">둘째 분류 기사</a><time>2026.08.20.</time></li></ul>`)],
    [sharedDetail, htmlResponse(`<main><h1>공동 기사</h1><time>2026.08.22.</time><div class="article_body"><p>두 공식 분류에 함께 게재된 기사의 본문이다.</p></div></main>`)],
    [secondOnlyDetail, htmlResponse(`<main><h1>둘째 분류 기사</h1><time>2026.08.20.</time><div class="article_body"><p>뒤쪽 공식 분류에서 수집한 기사의 본문이다.</p></div></main>`)],
  ]), []);

  try {
    const result = await crawlKcnaNews({
      categoryLists: [
        { id: "leadership", label: "혁명활동소식", kind: "article", url: firstList },
        { id: "important", label: "중요소식", kind: "article", url: secondList },
      ],
      fetchImpl,
      assetDir,
      now: TEST_NOW,
      maxDocuments: 2,
      maxDocumentsPerCategory: 10,
      maxListPages: 1,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.stats.entriesDiscovered, 3, "all categories must be collected before the global cap is applied");
    assert.equal(result.stats.entriesSelected, 2);
    assert.deepEqual(result.documents.map((document) => document.url).sort(), [secondOnlyDetail, sharedDetail].sort(), "the first category must not consume the entire global cap");
    assert.deepEqual(result.documents.find((document) => document.url === sharedDetail)?.categories, ["leadership", "important"], "one official URL must retain every category in which it appeared");
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testInvalidImageMagic() {
  const fetchImpl = fixtureFetch(new Map([
    ["http://images.test/not-image", new Response(Buffer.from("plain text"), { status: 200, headers: { "Content-Type": "image/jpeg" } })],
  ]), []);
  await assert.rejects(
    fetchBoundedImage("http://images.test/not-image", {
      fetchImpl,
      referer: "http://images.test/article",
      timeoutMs: 1_000,
    }),
    /magic is invalid/iu,
  );
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-data-image-"));
  try {
    const cached = await cacheNewsImage({
      url: `data:image/png;base64,${PNG_A.toString("base64")}`,
      referer: "http://rodong.test/article",
      role: "inline",
    }, {
      sourceId: "rodong-sinmun",
      assetDir,
      publicAssetBase: "/data/news/assets",
    });
    assert.equal(cached.mimeType, "image/png");
    assert.match(cached.cachedUrl, /^\/data\/news\/assets\/rodong-sinmun\/[a-f0-9]{64}\.png$/u);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

function rodongDetailToken(date, categoryCode, sequence) {
  return Buffer.from(`12@${date}-${sequence}@${categoryCode}@1@@0@1@`, "utf8").toString("base64");
}

function htmlResponse(html) {
  return new Response(String(html), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function imageResponse(bytes, contentType) {
  return new Response(bytes, { status: 200, headers: { "Content-Type": contentType, "Content-Length": String(bytes.length) } });
}

function redirectResponse(location, status = 302) {
  return new Response(null, { status, headers: { Location: location } });
}

async function listenOnLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function serverUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test HTTP server is not listening");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function fixtureFetch(fixtures, requests) {
  return async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (!fixtures.has(url)) throw new Error(`Unexpected fixture request: ${url}`);
    const fixture = fixtures.get(url);
    if (typeof fixture === "function") return fixture(url, init);
    return fixture.clone();
  };
}
