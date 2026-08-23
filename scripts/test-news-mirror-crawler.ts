#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  buildRodongHtmlFallbackUrl,
  cacheNewsImage,
  crawlKcnaNews,
  crawlNewsMirror,
  crawlRodongNews,
  decodeRodongToken,
  detectImageFormat,
  encodeRodongCategoryToken,
  fetchBoundedForm,
  fetchBoundedHtml,
  fetchBoundedImage,
  findKcnaGalleryUrl,
  parseKcnaDetail,
  parseKcnaGalleryImages,
  parseKcnaListing,
  parseKcnaPagination,
  parseRodongCategoryToken,
  parseRodongAjaxDescriptor,
  parseRodongAjaxResponse,
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
await testBoundedFormPostPolicy();
await testKcnaPostPaginationAndFrontierStats();
await testKcnaListingRetries();
await testKcnaGalleryAndVideoPaginationProof();
await testKcnaMediaPreviewFallback();
await testKcnaMediaKnownReuseRequiresExactPreview();
await testKcnaPhotoListingPreviewIdentityFallback();
await testMissingImageDiagnosticSamples();
await testPerCategoryOfficialListOrder();
await testIncrementalDetailReuseAndBackfill();
await testSuspiciousKnownImageReuseGuard();
await testTransientDetailRetries();
await testKcnaDetailIdentityVariants();
await testKcnaCrawlWithGalleryAssets();
await testImageCrawlQuotas();
await testImageRetryAndFailureRelease();
await testSharedRunImageQuota();
await testCategoryMergingAndFairLimit();
await testRodongCrawlPageIterationAndInlineAssets();
await testRodongHomepageRetries();
await testRodongListingRetries();
await testRodongOfficialListRootOrdering();
await testRodongDetailRetryCeiling();
await testRodongExpandedInlineImageDetails();
await testRodongDetailNeverUsesPartialHtmlFallback();
await testRodongHtmlFallbackAndOfficialImageProvenance();
await testRemoteImageDescriptorMode();
await testRodongAjaxGalleryCrawl();
await testInvalidImageMagic();
await testNodeAddressFailoverAffinity();

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

  const mediaPreview = `data:;base64,${JPEG_A.toString("base64")}`;
  const mediaListing = parseKcnaListing(`
    <main>
      <div class="category_title">전체</div>
      <div class="video">
        <a href="/kp/video/detail/${"4".repeat(32)}"><img class="thumb" src="${mediaPreview}" alt="축산에 힘을 넣어 성과 이룩"></a>
        <h5><a href="/kp/video/detail/${"4".repeat(32)}">축산에 힘을 넣어 성과 이룩</a><span>[2026.8.20.]</span></h5>
      </div>
    </main>
  `, "http://kcna.test/kp/video/list/media-id", { id: "video", label: "동화상", kind: "video" });
  assert.equal(mediaListing.entries.length, 1, "duplicate thumbnail/title anchors must produce one media entry");
  assert.equal(mediaListing.entries[0].title, "축산에 힘을 넣어 성과 이룩");
  assert.notEqual(mediaListing.entries[0].title, "전체", "a page heading must never become a media title");
  assert.equal(mediaListing.entries[0].date, "2026-08-20");
  assert.equal(mediaListing.entries[0].previewImageUrl, mediaPreview);
  assert.equal(mediaListing.entries[0].previewReferer, "http://kcna.test/kp/video/list/media-id");
  const datedTitleMediaListing = parseKcnaListing(`
    <main><div class="video">
      <a href="/kp/video/detail/${"7".repeat(32)}">2025.1.1.에 진행된 축산부문 행사</a>
      <span>[2026.8.20.]</span>
    </div></main>
  `, "http://kcna.test/kp/video/list/media-id", { id: "video", label: "동화상", kind: "video" });
  assert.equal(
    datedTitleMediaListing.entries[0].date,
    "2026-08-20",
    "a date mentioned in the linked media title must not override the item-scoped publication date",
  );
  const mixedMediaListing = parseKcnaListing(`
    <main><div class="video">
      <a href="/kp/video/detail/${"5".repeat(32)}"><img src="${mediaPreview}" alt=""></a>
      <a href="/kp/video/detail/${"6".repeat(32)}">다른 동화상의 제목</a>
      <span>[2026.8.20.]</span>
    </div></main>
  `, "http://kcna.test/kp/video/list/media-id", { id: "video", label: "동화상", kind: "video" });
  assert.equal(
    mixedMediaListing.entries.length,
    0,
    "one media item containing different detail URLs must be rejected instead of cross-pairing URL, title, date, and preview",
  );

  const detailUrl = parsed.entries[0].url;
  const detailHtml = `
    <main><article>
      <h1>경애하는 <strong>김정은</strong>동지께서 공연을 관람하시였다</h1>
      <div class="date">2026.08.17.</div>
      <div class="article_body">
        <p>경애하는 총비서동지께서 뜻깊은 공연을 관람하시였다.</p>
        <p>공연은 관람자들의 절찬을 받았다.</p>
        <a class="gallery_button" href="/kp/gallery/detail/gallery-one">사진보기</a>
        <a class="gallery_button" href="https://outside.test/kp/gallery/detail/rejected">거부</a>
      </div>
    </article></main>`;
  const detail = parseKcnaDetail(detailHtml, detailUrl, parsed.entries[0]);
  assert.equal(detail.title, "경애하는 김정은동지께서 공연을 관람하시였다");
  assert.equal(detail.date, "2026-08-17");
  assert.match(detail.body, /공연은 관람자들의 절찬을 받았다/u);
  assert.equal(detail.galleryUrl, "http://kcna.test/kp/gallery/detail/gallery-one");
  assert.equal(detail.markers.camera, true);
  assert.equal(detail.markers.gallery, true);
  assert.equal(findKcnaGalleryUrl(detailHtml, detailUrl), detail.galleryUrl);
  const newspaperOverviewTitle = "2026년 7월 24일 신문개관";
  const newspaperOverview = parseKcnaDetail(`
    <main><article><h1>${newspaperOverviewTitle}</h1>
      <p>(평양 7월 24일발 조선중앙통신)</p><p>24일 중앙신문들의 주요소식이다.</p>
      <aside>무관한 최신 날짜 2026.8.17.</aside>
    </article></main>
  `, detailUrl, { title: newspaperOverviewTitle, date: "2026-07-24" });
  assert.equal(
    newspaperOverview.date,
    "2026-07-24",
    "a date-like newspaper title or arbitrary root text must not override the authoritative listing date",
  );
  const explicitDetailDate = parseKcnaDetail(`
    <main><article><h1>명시적인 상세 날짜가 있는 기사</h1>
      <time>2026.8.18.</time><p>상세 날짜를 검증하는 본문이다.</p>
    </article></main>
  `, detailUrl, { title: "명시적인 상세 날짜가 있는 기사", date: "2026-08-17" });
  assert.equal(explicitDetailDate.date, "2026-08-18", "an explicit detail date remains authoritative when present");
  assert.equal(findKcnaGalleryUrl(`
    <main><article><h1>사진 단추가 없는 기사</h1><p>기사 본문이다.</p></article></main>
    <aside><a href="/kp/gallery/detail/unrelated-strip">무관한 사진 띠</a></aside>
  `, detailUrl), "", "page-wide gallery links outside the article must never attach to it");
  const relatedArticleGalleryUrl = "http://kcna.test/kp/gallery/detail/related-article";
  const primaryWithoutGallery = parseKcnaDetail(`
    <main>
      <article class="related-card"><a class="gallery_button" href="${relatedArticleGalleryUrl}">관련 기사 사진</a></article>
      <article class="primary"><h1>사진이 없는 대상 기사</h1><time>2026.8.17.</time>
        <p>대상 기사만의 충분히 긴 공식 본문이며 사진 연결은 없다.</p></article>
    </main>
  `, detailUrl, { title: "사진이 없는 대상 기사", date: "2026-08-17" });
  assert.match(primaryWithoutGallery.body, /대상 기사만의 충분히 긴 공식 본문/u);
  assert.equal(
    primaryWithoutGallery.galleryUrl,
    "",
    "a gallery button in a different article element must never attach to the selected primary article",
  );

  const mediaMarkerListing = parseKcnaListing(`
    <div class="article"><a href="/kp/article/detail/${"1".repeat(32)}">실제 사진 표식 기사</a><i class="fa fa-camera"></i><time>2026.8.17.</time></div>
    <div class="article"><a href="/kp/article/detail/${"2".repeat(32)}">동화상만 있는 기사</a><i class="fa fa-video-camera"></i><time>2026.8.17.</time></div>
  `, listingUrl, { id: "important", label: "중요소식", kind: "article" });
  assert.deepEqual(mediaMarkerListing.entries.map((entry) => entry.markers.camera), [true, false]);
  const videoOnlyDetail = parseKcnaDetail(`
    <article><h1>동화상만 있는 기사</h1><time>2026.8.17.</time><p>사진 없이 동화상만 련결된 본문이다.</p>
      <a class="right_button video_button" href="/kp/video/detail/${"3".repeat(32)}"><i class="fa fa-video-camera"></i></a>
    </article>
  `, `http://kcna.test/kp/article/detail/${"2".repeat(32)}`, {});
  assert.equal(videoOnlyDetail.markers.camera, false);
  assert.equal(videoOnlyDetail.markers.gallery, false);
  assert.equal(videoOnlyDetail.imageUrls.length, 0);

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

  const unrelatedImages = Array.from({ length: 19 }, (_, index) => `<img src="/photo/unrelated-${index + 1}.jpg">`).join("");
  const scopedDetail = parseKcnaDetail(`
    <main>
      <article><h1>짧지만 독립된 기사 본문</h1><p>이 기사의 고유한 짧은 본문이다.</p></article>
      <aside class="latest-photo-strip">${unrelatedImages}</aside>
    </main>`, "http://kcna.test/kp/article/detail/scoped-article", {
    title: "짧지만 독립된 기사 본문",
    date: "2026-08-17",
  });
  assert.equal(scopedDetail.imageUrls.length, 0, "whole-page photo strips must never leak into a short article");
  assert.deepEqual(parseKcnaGalleryImages(`
    <aside class="gallery">${unrelatedImages}</aside>
    <main><div class="gallery"><img src="/photo/owned.jpg"></div></main>
  `, "http://kcna.test/kp/gallery/detail/scoped-gallery"), [
    { url: "http://kcna.test/photo/owned.jpg", referer: "http://kcna.test/kp/gallery/detail/scoped-gallery", role: "gallery" },
  ], "gallery extraction must stay inside the official gallery container");
  const associatedGalleryUrl = "http://kcna.test/kp/gallery/detail/associated-gallery";
  assert.deepEqual(parseKcnaGalleryImages(`
    <main>
      <aside class="gallery"><a href="/kp/gallery/detail/unrelated-gallery"><img src="/photo/unrelated.jpg"></a></aside>
      <section class="gallery" data-gallery-id="associated-gallery"><img src="/photo/associated.jpg"></section>
    </main>
  `, associatedGalleryUrl), [
    { url: "http://kcna.test/photo/associated.jpg", referer: associatedGalleryUrl, role: "gallery" },
  ], "multiple gallery roots must select only the container structurally associated with the requested detail URL");
  assert.deepEqual(parseKcnaGalleryImages(`
    <main>
      <section class="gallery"><img src="/photo/ambiguous-one.jpg"></section>
      <section class="gallery"><img src="/photo/ambiguous-two.jpg"></section>
    </main>
  `, associatedGalleryUrl), [], "ambiguous gallery roots without an exact URL or hash association must fail closed");
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
      <div id="PathBar">홈 &gt; 혁명활동소식 &gt; 2건</div>
      <div id="RevoListDIV"><ul><li>
          <a href="/index.php?${detailToken}">경애하는 <b>김정은</b>동지께서 공연을 관람하시였다 <img src="/images/newsf.gif"></a>
          <span class="date">2026.8.17.</span>
      </li></ul></div>
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
  assert.deepEqual(listing.pagination, { currentPage: 1, declaredLastPage: 2, declaredTotal: 2 });

  const todayDetailToken = rodongDetailToken("2026-08-22", "2", "023");
  const auxiliaryThumbnailToken = rodongDetailToken("2026-08-22", "15", "023");
  const todayListing = parseRodongListing(`
    <main><div id="PathBar">홈 &gt; 오늘호 기사 &gt; 1건</div>
      <div id="revoList"><div class="date_news_list"><div class="media">
        <div class="media-left"><a class="media-heading" href="/index.php?${auxiliaryThumbnailToken}"><img src="data:image/png;base64,${PNG_A.toString("base64")}"></a></div>
        <div class="media-body"><a class="media-heading" href="/index.php?${todayDetailToken}">인민을 위한 헌신적복무의 길을 이어갈 열의에 넘쳐있다.</a></div>
        <time>2026.8.22.</time>
      </div></div></div>
    </main>`, `http://rodong.test/index.php?${todayToken}`, {
    id: "important",
    label: "오늘호 기사",
    categoryCode: "2",
  });
  assert.equal(todayListing.entries.length, 1, "category-15 thumbnail links must not become separate category-2 articles");
  assert.equal(parseRodongDetailToken(todayListing.entries[0].url)?.categoryCode, "2");
  assert.match(todayListing.entries[0].previewImageUrl, /^data:image\/png;base64,/u);
  assert.deepEqual(todayListing.pagination, { currentPage: 1, declaredLastPage: 1, declaredTotal: 1 });

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

  const ajaxPhotoOneToken = Buffer.from("2@@@@p@0@2026/08/17/1/2026-08-17-001/photo-1.jpg", "utf8").toString("base64");
  const ajaxPhotoTwoToken = Buffer.from("2@@@@p@0@2026/08/17/1/2026-08-17-001/photo-2.jpg", "utf8").toString("base64");
  const ajaxDetailHtml = `
    <main><h1>경애하는 김정은동지께서 공연을 관람하시였다</h1>
      <div id="articleContent" class="article-content"><p>공식 사진묶음이 있는 기사 본문이다.</p>
        <script>$.revo_fancybox.open([{href:"index.php?${ajaxPhotoOneToken}"},{href:"index.php?${ajaxPhotoTwoToken}"}]);</script>
      </div>
    </main>
    <script>
      var iType = 3; var iThemeID = 1;
      jQuery.ajax({type:"POST",url:"index.php?MDVAQEBA",
        data:"chAction=C&strSchKey=&strNewsID=2026-08-17-001&iThemeID=1&iPhotoNo=1&iSelType="+iSelType+"&dPublish=2026-08-22&iViewWidth="+iViewWidth+"&iViewHeight="+iViewHeight});
    </script>`;
  const ajaxDescriptor = parseRodongAjaxDescriptor(ajaxDetailHtml, detailUrl);
  assert.deepEqual(ajaxDescriptor, {
    endpointUrl: "http://rodong.test/index.php?MDVAQEBA",
    detailUrl,
    newsId: "2026-08-17-001",
    themeId: 1,
    publishDate: "2026-08-22",
    mediaType: 3,
  });
  const ajaxDetail = parseRodongDetail(ajaxDetailHtml, detailUrl, listing.entries[0]);
  assert.deepEqual(ajaxDetail.imageUrls.map((reference) => reference.url), [
    `http://rodong.test/index.php?${ajaxPhotoOneToken}`,
    `http://rodong.test/index.php?${ajaxPhotoTwoToken}`,
  ], "extensionless official script endpoints must be preserved as source provenance");
  assert.equal(ajaxDetail.markers.gallery, true);
  assert.equal(parseRodongAjaxDescriptor(ajaxDetailHtml.replace("2026-08-17-001", "2026-08-17-999"), detailUrl), null);
  assert.equal(parseRodongAjaxDescriptor(ajaxDetailHtml.replace("index.php?MDVAQEBA", "https://outside.test/index.php?MDVAQEBA"), detailUrl), null);

  const ajaxRow = {
    rows: [{ iType: "3", strNewsID: "2026-08-17-001", strHTML: "<div class='photo-carousel'></div>", iPhotoCnt: "2" }],
  };
  assert.deepEqual(parseRodongAjaxResponse(JSON.stringify(JSON.stringify(ajaxRow)), "2026-08-17-001"), {
    newsId: "2026-08-17-001",
    mediaType: 3,
    photoCount: 2,
    html: "<div class='photo-carousel'></div>",
  });
  assert.equal(parseRodongAjaxResponse(JSON.stringify(ajaxRow), "2026-08-17-001").photoCount, 2);
  assert.throws(
    () => parseRodongAjaxResponse(JSON.stringify(JSON.stringify(JSON.stringify(ajaxRow))), "2026-08-17-001"),
    /invalid envelope/iu,
  );
  assert.throws(
    () => parseRodongAjaxResponse(JSON.stringify({ rows: [{ ...ajaxRow.rows[0], strNewsID: "2026-08-17-999" }] }), "2026-08-17-001"),
    /does not match/iu,
  );
  assert.throws(
    () => parseRodongAjaxResponse(JSON.stringify({ rows: [{ ...ajaxRow.rows[0], iPhotoCnt: "101" }] }), "2026-08-17-001"),
    /photo count/iu,
  );
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

async function testBoundedFormPostPolicy() {
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      assert.equal(request.method, "POST");
      assert.equal(request.headers["x-requested-with"], "XMLHttpRequest");
      assert.match(String(request.headers["content-type"]), /^application\/x-www-form-urlencoded/iu);
      assert.deepEqual(Object.fromEntries(new URLSearchParams(body)), { chAction: "C", strNewsID: "2026-08-17-001" });
      response.writeHead(200, { "Content-Type": "text/html; charset=UTF-8" });
      response.end(JSON.stringify("bounded form response"));
    });
  });
  await listenOnLoopback(server);
  try {
    const endpoint = `${serverUrl(server)}/index.php?MDVAQEBA`;
    assert.equal(await fetchBoundedForm(endpoint, {
      chAction: "C",
      strNewsID: "2026-08-17-001",
    }, {
      fetchImpl: globalThis.fetch,
      preferNodeDirect: true,
      referer: `${serverUrl(server)}/article`,
      timeoutMs: 1_000,
    }), JSON.stringify("bounded form response"));
  } finally {
    await closeServer(server);
  }

  let dispatched = 0;
  await assert.rejects(
    fetchBoundedForm("http://rodong-form.test/index.php?MDVAQEBA", { chAction: "C" }, {
      fetchImpl: async () => {
        dispatched += 1;
        return htmlResponse("must not be reached");
      },
      referer: "http://outside.test/article",
    }),
    /must share the request origin/iu,
  );
  assert.equal(dispatched, 0, "cross-origin form metadata must fail before dispatch");
  await assert.rejects(
    fetchBoundedForm("http://rodong-form.test/index.php?MDVAQEBA", { field: "x".repeat(20_000) }, {
      fetchImpl: async () => {
        dispatched += 1;
        return htmlResponse("must not be reached");
      },
      referer: "http://rodong-form.test/article",
    }),
    /Form field is invalid|Form body is too large/iu,
  );
  assert.equal(dispatched, 0, "oversized form metadata must fail before dispatch");

  const redirectEndpoint = "http://rodong-form.test/index.php?MDVAQEBA";
  let redirectTargetHits = 0;
  await assert.rejects(
    fetchBoundedForm(redirectEndpoint, { chAction: "C" }, {
      fetchImpl: fixtureFetch(new Map([
        [redirectEndpoint, redirectResponse("http://outside.test/collector", 307)],
        ["http://outside.test/collector", () => {
          redirectTargetHits += 1;
          return htmlResponse("must not be reached");
        }],
      ]), []),
      referer: "http://rodong-form.test/article",
      timeoutMs: 1_000,
    }),
    /Redirect limit of 0 exceeded/iu,
  );
  assert.equal(redirectTargetHits, 0, "form POST redirects must never be followed or replayed");
}

async function testKcnaPostPaginationAndFrontierStats() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-kcna-pages-"));
  const origin = "http://kcna-pages.test";
  const listingUrl = `${origin}/kp/article/list/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
  const csrf = "csrf-token-20260822";
  const detailUrls = [1, 2, 3].map((page) => `${origin}/kp/article/detail/${String(page).repeat(32)}`);
  const makeListing = (page) => `
    <form id="article_form" method="POST" action="/kp/article/list/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">
      <input type="hidden" name="page_num" value="${page}">
      <input type="hidden" name="cnt_per_page" value="1">
      <input type="hidden" name="keyword" value="">
      <input type="hidden" name="_csrf" value="${csrf}">
    </form>
    <script>var total=3; var cur_page=${page}; var per_page=1; var page_cnt=3;</script>
    <div class="article"><h5 class="block"><a href="${detailUrls[page - 1]}">공식 ${page}페지 기사</a><span>[2026.8.${18 - page}.]</span></h5></div>`;
  const requests = [];
  const fixtures = new Map([
    [listingUrl, (_url, init) => {
      if (String(init.method || "GET").toUpperCase() !== "POST") {
        return htmlResponse(makeListing(1), {
          "Set-Cookie": "lang=ko; Expires=Sat, 22-Aug-2026 10:22:21 GMT; Path=/, JSESSIONID=official-session; Path=/; HttpOnly",
        });
      }
      assert.equal(init.headers["X-Requested-With"], undefined, "KCNA's official page form is not the Rodong AJAX API");
      assert.equal(init.headers.Cookie, "lang=ko; JSESSIONID=official-session", "KCNA's CSRF form must retain its same-origin session cookies");
      const fields = Object.fromEntries(new URLSearchParams(String(init.body || "")));
      assert.deepEqual(Object.keys(fields), ["page_num", "cnt_per_page", "keyword", "_csrf"]);
      assert.equal(fields.keyword, "", "KCNA pagination must never inherit a product search term");
      assert.equal(fields.cnt_per_page, "1");
      assert.equal(fields._csrf, csrf);
      const page = Number(fields.page_num);
      assert.ok(page === 2 || page === 3, `unexpected official page: ${page}`);
      return htmlResponse(makeListing(page));
    }],
  ]);
  detailUrls.forEach((detailUrl, index) => fixtures.set(
    detailUrl,
    htmlResponse(kcnaArticleDetailHtml(
      detailUrl,
      `공식 ${index + 1}페지 기사`,
      `<time>2026.8.${17 - index}.</time><p>POST로 순회한 공식 기사 본문 ${index + 1}이다.</p>`,
    )),
  ));
  const fetchImpl = fixtureFetch(fixtures, requests);

  try {
    const parsed = parseKcnaPagination(makeListing(1), listingUrl);
    assert.deepEqual(parsed, {
      actionUrl: listingUrl,
      csrf,
      currentPage: 1,
      perPage: 1,
      pageCount: 3,
      declaredTotal: 3,
      keyword: "",
    });
    assert.equal(
      parseKcnaPagination(makeListing(1).replace('action="/kp/article/list/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', 'action="https://outside.test/collect"'), listingUrl),
      null,
      "cross-origin pagination forms must never be dispatched",
    );
    assert.equal(
      parseKcnaPagination(makeListing(1).replace("var page_cnt=3", "var page_cnt=2"), listingUrl),
      null,
      "declared total and page count must agree",
    );

    const result = await crawlKcnaNews({
      categoryLists: [{ id: "leadership", label: "혁명활동소식", kind: "article", url: listingUrl }],
      fetchImpl,
      assetDir,
      now: TEST_NOW,
      maxListPages: 3,
      maxDocuments: 10,
      maxDocumentsPerCategory: 10,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.documents.length, 3);
    assert.equal(result.stats.detailsComplete, true);
    assert.equal(result.stats.listingFrontierExhausted, true);
    assert.equal(result.stats.capReached, false);
    assert.deepEqual(result.stats.categories.map((category) => ({
      pagesDiscovered: category.pagesDiscovered,
      pagesAttempted: category.pagesAttempted,
      pagesFetched: category.pagesFetched,
      entriesDiscovered: category.entriesDiscovered,
      declaredTotal: category.declaredTotal,
      declaredLastPage: category.declaredLastPage,
      declaredTotalMismatch: category.declaredTotalMismatch,
      frontierExhausted: category.frontierExhausted,
    })), [{
      pagesDiscovered: 3,
      pagesAttempted: 3,
      pagesFetched: 3,
      entriesDiscovered: 3,
      declaredTotal: 3,
      declaredLastPage: 3,
      declaredTotalMismatch: false,
      frontierExhausted: true,
    }]);
    assert.deepEqual(
      requests.filter((request) => request.url === listingUrl).map((request) => ({
        method: request.init.method || "GET",
        page: new URLSearchParams(String(request.init.body || "")).get("page_num") || "1",
      })),
      [{ method: "GET", page: "1" }, { method: "POST", page: "2" }, { method: "POST", page: "3" }],
      "KCNA's form must visit every declared page exactly once",
    );

    const capped = await crawlKcnaNews({
      categoryLists: [{ id: "leadership", label: "혁명활동소식", kind: "article", url: listingUrl }],
      fetchImpl,
      assetDir,
      now: TEST_NOW,
      maxListPages: 2,
      maxDocuments: 10,
      maxDocumentsPerCategory: 10,
    });
    assert.equal(capped.stats.listingFrontierExhausted, false);
    assert.equal(capped.stats.capReached, true);
    assert.equal(capped.stats.categories[0].pageCapReached, true);
    assert.equal(capped.stats.categories[0].declaredTotalMismatch, true);
    assert.equal(capped.stats.categories[0].frontierExhausted, false);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testKcnaListingRetries() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-kcna-list-retry-"));
  const origin = "http://kcna-list-retry.test";
  const listingUrl = `${origin}/kp/article/list/${"a".repeat(32)}`;
  const detailUrls = [
    `${origin}/kp/article/detail/${"1".repeat(32)}`,
    `${origin}/kp/article/detail/${"2".repeat(32)}`,
  ];
  const csrf = "kcna-list-retry-csrf";
  const makeListing = (page) => `
    <form id="article_form" method="POST" action="${new URL(listingUrl).pathname}">
      <input name="page_num" value="${page}"><input name="cnt_per_page" value="1">
      <input name="keyword" value=""><input name="_csrf" value="${csrf}">
    </form>
    <script>var total=2; var cur_page=${page}; var per_page=1; var page_cnt=2;</script>
    <div class="article"><h5 class="block"><a href="${detailUrls[page - 1]}">목록 재시도 ${page}페지 기사</a>
      <span>[2026.8.${19 - page}.]</span></h5></div>`;
  let getAttempts = 0;
  let postAttempts = 0;
  const requests = [];
  const fixtures = new Map([
    [listingUrl, (_url, init) => {
      if (String(init.method || "GET").toUpperCase() !== "POST") {
        getAttempts += 1;
        if (getAttempts === 1) throw new TypeError("fetch failed: transient KCNA listing GET");
        return htmlResponse(makeListing(1));
      }
      postAttempts += 1;
      const fields = Object.fromEntries(new URLSearchParams(String(init.body || "")));
      assert.equal(fields.page_num, "2", "POST retries must preserve the exact official page form");
      assert.equal(fields._csrf, csrf, "POST retries must preserve the same CSRF form value");
      if (postAttempts === 1) throw new TypeError("fetch failed: transient KCNA listing POST");
      if (postAttempts === 2) return htmlResponse(makeListing(1));
      return htmlResponse(makeListing(2));
    }],
    ...detailUrls.map((detailUrl, index) => [
      detailUrl,
      htmlResponse(kcnaArticleDetailHtml(
        detailUrl,
        `목록 재시도 ${index + 1}페지 기사`,
        `<time>2026.8.${18 - index}.</time><p>목록 재시도 후 받은 공식 본문 ${index + 1}이다.</p>`,
      )),
    ]),
  ]);

  try {
    const recovered = await crawlKcnaNews({
      categoryLists: [{ id: "important", label: "중요소식", kind: "article", url: listingUrl }],
      fetchImpl: fixtureFetch(fixtures, requests),
      assetDir,
      now: TEST_NOW,
      retryDelayMs: 0,
      maxListPages: 2,
      maxDocuments: 10,
    });
    assert.equal(getAttempts, 2, "a transient GET must receive one bounded retry before succeeding");
    assert.equal(postAttempts, 3, "a transient POST and wrong-page response must be retried within the bounded budget");
    assert.equal(recovered.errors.length, 0);
    assert.equal(recovered.stats.listingPagesFetched, 2, "page statistics count unique successful pages, not attempts");
    assert.equal(recovered.stats.categories[0].pagesAttempted, 2);
    assert.equal(recovered.stats.categories[0].pagesFetched, 2);
    assert.equal(recovered.stats.categories[0].listingErrors, 0);
    assert.equal(recovered.stats.listingFrontierExhausted, true);
    assert.equal(recovered.documents.length, 2);

    const failedListingUrl = `${origin}/kp/article/list/${"f".repeat(32)}`;
    const failedRequests = [];
    const exhausted = await crawlKcnaNews({
      categoryLists: [{ id: "important", label: "중요소식", kind: "article", url: failedListingUrl }],
      fetchImpl: fixtureFetch(new Map([[
        failedListingUrl,
        new Response("temporary", { status: 503, headers: { "Content-Type": "text/plain" } }),
      ]]), failedRequests),
      assetDir,
      now: TEST_NOW,
      retryDelayMs: 0,
      maxListPages: 1,
    });
    assert.equal(failedRequests.length, 3, "a permanently transient listing failure gets exactly two retries");
    assert.equal(exhausted.errors.length, 1, "only final retry exhaustion becomes a listing error");
    assert.equal(exhausted.errors[0].stage, "listing");
    assert.equal(exhausted.stats.listingPagesFetched, 0);
    assert.equal(exhausted.stats.categories[0].pagesAttempted, 1, "attempt statistics remain unique-page based");
    assert.equal(exhausted.stats.categories[0].pagesFetched, 0);
    assert.equal(exhausted.stats.categories[0].listingErrors, 1);
    assert.equal(exhausted.stats.listingFrontierExhausted, false);

    const forbiddenListingUrl = `${origin}/kp/article/list/${"e".repeat(32)}`;
    const forbiddenRequests = [];
    const forbidden = await crawlKcnaNews({
      categoryLists: [{ id: "important", label: "중요소식", kind: "article", url: forbiddenListingUrl }],
      fetchImpl: fixtureFetch(new Map([[
        forbiddenListingUrl,
        new Response("forbidden", { status: 403, headers: { "Content-Type": "text/plain" } }),
      ]]), forbiddenRequests),
      assetDir,
      now: TEST_NOW,
      retryDelayMs: 0,
      maxListPages: 1,
    });
    assert.equal(forbiddenRequests.length, 1, "a rejected CSRF/session response must fail safely instead of replaying stale credentials");
    assert.equal(forbidden.stats.categories[0].listingErrors, 1);
    assert.equal(forbidden.stats.listingFrontierExhausted, false);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testKcnaGalleryAndVideoPaginationProof() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-kcna-media-pages-"));
  const origin = "http://kcna-media-pages.test";
  try {
    for (const kind of ["gallery", "video"]) {
      const categoryKind = kind === "gallery" ? "photo" : "video";
      const categoryId = categoryKind;
      const listingUrl = `${origin}/kp/${kind}/list/${kind.repeat(32).slice(0, 32)}`;
      const detailUrls = ["a", "b"].map((letter) => `${origin}/kp/${kind}/detail/${letter.repeat(32)}`);
      const csrf = `${kind}-csrf-token`;
      const preview = (page) => `data:;base64,${Buffer.concat([JPEG_A, Buffer.from([page])]).toString("base64")}`;
      const makeListing = (page) => `
        <form id="${kind}_form" method="POST" action="${new URL(listingUrl).pathname}">
          <input type="hidden" name="page_num" value="${page}">
          <input type="hidden" name="cnt_per_page" value="1">
          <input type="hidden" name="_csrf" value="${csrf}">
        </form>
        <script>var total=2; var cur_page=${page}; var per_page=1; var page_cnt=2;</script>
        <main><div class="category_title">전체</div><div class="${kind}">
          <a href="${detailUrls[page - 1]}"><img class="thumb" src="${preview(page)}" alt="${kind} 공식 ${page}페지 기록"></a>
          <h5 class="block"><a href="${detailUrls[page - 1]}">${kind} 공식 ${page}페지 기록</a><span>[2026.1.${4 - page}.]</span></h5>
        </div></main>`;
      const requests = [];
      const fixtures = new Map([
        [listingUrl, (_url, init) => {
          if (String(init.method || "GET").toUpperCase() !== "POST") return htmlResponse(makeListing(1));
          const fields = Object.fromEntries(new URLSearchParams(String(init.body || "")));
          assert.deepEqual(Object.keys(fields), ["page_num", "cnt_per_page", "_csrf"]);
          assert.equal(fields._csrf, csrf);
          assert.equal(fields.page_num, "2");
          return htmlResponse(makeListing(2));
        }],
      ]);
      detailUrls.forEach((detailUrl, index) => fixtures.set(detailUrl, htmlResponse(kcnaMediaDetailHtml(
        categoryKind,
        `${kind} 공식 ${index + 1}페지 기록`,
        kind === "gallery"
          ? `<time>2026.1.${3 - index}.</time><img src="${origin}/photo/${String(index + 1).repeat(32)}">`
          : `<time>2026.1.${3 - index}.</time><p>공식 동화상 설명 본문이다.</p>`,
      ))));
      const result = await crawlKcnaNews({
        categoryLists: [{ id: categoryId, label: categoryId, kind: categoryKind, url: listingUrl }],
        fetchImpl: fixtureFetch(fixtures, requests),
        cacheRemoteImages: false,
        assetDir,
        now: TEST_NOW,
        maxListPages: 2,
        maxDocuments: 10,
      });
      assert.equal(result.errors.length, 0, `${kind} pages must crawl without diagnostics`);
      assert.equal(result.documents.length, 2);
      assert.equal(result.stats.categories[0].declaredTotal, 2);
      assert.equal(result.stats.categories[0].declaredLastPage, 2);
      assert.equal(result.stats.categories[0].paginationProofObserved, true);
      assert.equal(result.stats.categories[0].frontierExhausted, true);
      assert.equal(result.stats.listingFrontierExhausted, true);
      assert.equal(requests.filter((request) => request.url === listingUrl).length, 2);
      assert.deepEqual(
        [...result.documents].sort((left, right) => left.categoryOrders[categoryId] - right.categoryOrders[categoryId])
          .map((document) => [document.title, document.date]),
        [[`${kind} 공식 1페지 기록`, "2026-01-03"], [`${kind} 공식 2페지 기록`, "2026-01-02"]],
        "media titles and dates must come from their own official item, never the page-wide 전체 heading",
      );
      assert.ok(
        result.documents.every((document) => document.images.some((image) => image.cachedUrl && image.role === "preview")),
        `${kind} inline list previews must be materialized even when remote downloads are deferred`,
      );
      assert.ok(
        result.documents.every((document) => (
          document.images[0]?.role === "preview"
          && /^\/data\/news\/assets\/kcna\/[a-f0-9]{64}\.jpg$/u.test(document.thumbnailUrl)
        )),
        `${kind} exact list previews must be the cached lead thumbnail when remote images are deferred`,
      );
      assert.ok(
        result.documents.every((document) => document.body === ""),
        `${kind} media records must not retain unverified detail or homepage chrome as article body`,
      );
      assert.deepEqual(
        [...result.documents].sort((left, right) => left.categoryOrders[categoryId] - right.categoryOrders[categoryId])
          .map((document) => document.url),
        detailUrls,
      );
    }

    const unprovenListingUrl = `${origin}/kp/gallery/list/${"c".repeat(32)}`;
    const unprovenDetailUrl = `${origin}/kp/gallery/detail/${"d".repeat(32)}`;
    const unprovenKnown = makeKnownKcnaDocument({
      url: unprovenDetailUrl,
      title: "페이지 증명이 없는 사진 기록",
      date: "2026-01-01",
      images: [{
        originalUrl: `${origin}/photo/${"e".repeat(32)}`,
        cachedUrl: "",
        sha256: "",
        mimeType: "image/jpeg",
        bytes: 0,
        role: "gallery",
      }],
      kind: "photo",
    });
    const unproven = await crawlKcnaNews({
      categoryLists: [{ id: "photo", label: "사진", kind: "photo", url: unprovenListingUrl }],
      fetchImpl: fixtureFetch(new Map([
        [unprovenListingUrl, htmlResponse(`<div class="gallery"><a href="${unprovenDetailUrl}">${unprovenKnown.title}</a><time>2026.1.1.</time></div>`)],
      ]), []),
      knownDocuments: [unprovenKnown],
      assetDir,
      now: TEST_NOW,
      maxListPages: 1,
      maxDocuments: 10,
    });
    assert.equal(unproven.stats.categories[0].capReached, false);
    assert.equal(unproven.stats.categories[0].paginationProofMissing, true);
    assert.equal(unproven.stats.categories[0].frontierExhausted, false);
    assert.equal(unproven.stats.listingFrontierExhausted, false, "page one without totals or continuation cannot prove exhaustion");
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testKcnaMediaPreviewFallback() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-kcna-media-preview-"));
  const origin = "http://kcna-media-preview.test";
  const articleList = `${origin}/kp/article/list/${"1".repeat(32)}`;
  const photoList = `${origin}/kp/gallery/list/${"2".repeat(32)}`;
  const articleUrl = `${origin}/kp/article/detail/${"3".repeat(32)}`;
  const staleGalleryUrl = `${origin}/kp/gallery/detail/${"4".repeat(32)}`;
  const unrelatedGalleryUrl = `${origin}/kp/gallery/detail/${"5".repeat(32)}`;
  const stalePreview = `data:;base64,${JPEG_A.toString("base64")}`;
  const unrelatedPreview = `data:image/png;base64,${PNG_A.toString("base64")}`;
  const articleListing = `
    <form id="article_form" method="POST" action="${new URL(articleList).pathname}">
      <input name="page_num" value="1"><input name="cnt_per_page" value="1">
      <input name="keyword" value=""><input name="_csrf" value="article-preview-csrf">
    </form>
    <script>var total=1; var cur_page=1; var per_page=1; var page_cnt=1;</script>
    <main><div class="article"><h5><a href="${articleUrl}">정확한 사진목록 미리보기를 쓰는 기사</a>
      <i class="fa fa-camera"></i><span>[2026.7.23.]</span></h5></div></main>`;
  const photoListing = `
    <form id="gallery_form" method="POST" action="${new URL(photoList).pathname}">
      <input name="page_num" value="1"><input name="cnt_per_page" value="2">
      <input name="_csrf" value="gallery-preview-csrf">
    </form>
    <script>var total=2; var cur_page=1; var per_page=2; var page_cnt=1;</script>
    <main><div class="category_title">전체</div>
      <div class="gallery">
        <a href="${staleGalleryUrl}"><img src="${stalePreview}" alt="에짚트대사관 연회 사진"></a>
        <h5><a href="${staleGalleryUrl}">에짚트대사관 연회 사진</a><span>[2026.7.23.]</span></h5>
      </div>
      <div class="gallery">
        <a href="${unrelatedGalleryUrl}"><img src="${unrelatedPreview}" alt="서로 무관한 사진"></a>
        <h5><a href="${unrelatedGalleryUrl}">서로 무관한 사진</a><span>[2026.7.22.]</span></h5>
      </div>
    </main>`;
  const fixtures = new Map([
    [articleList, htmlResponse(articleListing)],
    [photoList, htmlResponse(photoListing)],
    [articleUrl, htmlResponse(kcnaArticleDetailHtml(articleUrl, "정확한 사진목록 미리보기를 쓰는 기사", `
      <time>2026.7.23.</time><p>공식 사진 상세의 기사 본문이다.</p>
      <a class="right_button gallery_button" href="${staleGalleryUrl}"><i class="fa fa-camera"></i></a>
    `))],
    [staleGalleryUrl, htmlResponse(kcnaMediaDetailHtml("photo", "에짚트대사관 연회 사진"))],
    [unrelatedGalleryUrl, htmlResponse(kcnaMediaDetailHtml("photo", "서로 무관한 사진"))],
  ]);

  try {
    const result = await crawlKcnaNews({
      categoryLists: [
        { id: "important", label: "중요소식", kind: "article", url: articleList },
        { id: "photo", label: "사진", kind: "photo", url: photoList },
      ],
      fetchImpl: fixtureFetch(fixtures, []),
      cacheRemoteImages: false,
      assetDir,
      now: TEST_NOW,
      maxListPages: 1,
      maxDocuments: 10,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.stats.documentsMissingExpectedImages, 0, "exact media-list previews must preserve the strict image gate");
    const article = result.documents.find((document) => document.url === articleUrl);
    const stalePhoto = result.documents.find((document) => document.url === staleGalleryUrl);
    const unrelatedPhoto = result.documents.find((document) => document.url === unrelatedGalleryUrl);
    assert.equal(article.images.length, 1);
    assert.equal(stalePhoto.images.length, 1);
    assert.equal(unrelatedPhoto.images.length, 1);
    assert.equal(article.images[0].sha256, stalePhoto.images[0].sha256, "an article may use only its exact gallery URL's official list preview");
    assert.notEqual(article.images[0].sha256, unrelatedPhoto.images[0].sha256, "an unrelated gallery preview must never attach by proximity or title");
    assert.equal(stalePhoto.title, "에짚트대사관 연회 사진");
    assert.equal(stalePhoto.date, "2026-07-23", "gallery detail content must not override item-scoped media metadata");
    assert.equal(stalePhoto.body, "", "gallery detail chrome must not become the media record body");
    assert.equal(unrelatedPhoto.body, "", "media records use safe empty bodies instead of unverified page chrome");
    assert.match(article.images[0].cachedUrl, /^\/data\/news\/assets\/kcna\/[a-f0-9]{64}\.jpg$/u);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testKcnaMediaKnownReuseRequiresExactPreview() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-kcna-media-reuse-"));
  const origin = "http://kcna-media-reuse.test";
  try {
    for (const [index, fixture] of [
      { pathKind: "gallery", kind: "photo" },
      { pathKind: "video", kind: "video" },
    ].entries()) {
      const listingUrl = `${origin}/kp/${fixture.pathKind}/list/${String(index + 1).repeat(32)}`;
      const detailUrl = `${origin}/kp/${fixture.pathKind}/detail/${String(index + 3).repeat(32)}`;
      const wrongImageUrl = `${origin}/photo/${String(index + 7).repeat(32)}`;
      const title = `${fixture.kind} 정확 미리보기 재사용 검증`;
      const exactPreviewBytes = Buffer.concat([JPEG_A, Buffer.from([index + 1])]);
      const exactPreviewHash = createHash("sha256").update(exactPreviewBytes).digest("hex");
      const exactPreview = `data:;base64,${exactPreviewBytes.toString("base64")}`;
      const listingHtml = `
        <form id="${fixture.pathKind}_form" method="POST" action="${new URL(listingUrl).pathname}">
          <input name="page_num" value="1"><input name="cnt_per_page" value="1">
          <input name="_csrf" value="${fixture.kind}-reuse-csrf-token">
        </form>
        <script>var total=1; var cur_page=1; var per_page=1; var page_cnt=1;</script>
        <main><div class="${fixture.pathKind}">
          <a href="${detailUrl}"><img src="${exactPreview}" alt="${title}"></a>
          <h5><a href="${detailUrl}">${title}</a><span>[2026.1.1.]</span></h5>
        </div></main>`;
      const staleKnown = makeKnownKcnaDocument({
        url: detailUrl,
        title,
        date: "2026-01-01",
        kind: fixture.kind,
        images: [
          {
            originalUrl: "",
            cachedUrl: `/data/news/assets/kcna/${exactPreviewHash}.jpg`,
            sha256: exactPreviewHash,
            mimeType: "image/jpeg",
            bytes: exactPreviewBytes.length,
            role: "preview",
          },
          {
            originalUrl: wrongImageUrl,
            cachedUrl: "",
            sha256: "",
            mimeType: "image/jpeg",
            bytes: 0,
            role: "gallery",
          },
        ],
      });
      const detailHtml = kcnaMediaDetailHtml(
        fixture.kind,
        title,
        fixture.kind === "photo"
          ? "<time>2026.1.1.</time>"
          : "<time>2026.1.1.</time><p>검증된 동화상 설명이다.</p>",
      );
      const firstRequests = [];
      const first = await crawlKcnaNews({
        categoryLists: [{ id: fixture.kind, label: fixture.kind, kind: fixture.kind, url: listingUrl }],
        fetchImpl: fixtureFetch(new Map([
          [listingUrl, htmlResponse(listingHtml)],
          [detailUrl, htmlResponse(detailHtml)],
        ]), firstRequests),
        knownDocuments: [staleKnown],
        cacheRemoteImages: false,
        assetDir,
        now: TEST_NOW,
        maxListPages: 1,
        maxDocuments: 2,
      });
      assert.equal(first.errors.length, 0);
      assert.equal(first.stats.detailsFetched, 1);
      assert.equal(first.stats.detailsReused, 0, "a stale media image cannot be reused without the current exact list preview");
      assert.equal(firstRequests.some((request) => request.url === detailUrl), true);
      assert.equal(first.documents[0].images.some((image) => image.originalUrl === wrongImageUrl), false);
      assert.equal(first.documents[0].images[0].role, "preview");
      assert.match(first.documents[0].thumbnailUrl, /^\/data\/news\/assets\/kcna\/[a-f0-9]{64}\.jpg$/u);
      assert.equal(first.documents[0].body, "");

      const secondRequests = [];
      const second = await crawlKcnaNews({
        categoryLists: [{ id: fixture.kind, label: fixture.kind, kind: fixture.kind, url: listingUrl }],
        fetchImpl: fixtureFetch(new Map([[listingUrl, htmlResponse(listingHtml)]]), secondRequests),
        knownDocuments: first.documents,
        cacheRemoteImages: false,
        assetDir,
        now: TEST_NOW,
        maxListPages: 1,
        maxDocuments: 2,
      });
      assert.equal(second.errors.length, 0);
      assert.equal(second.stats.detailsFetched, 0);
      assert.equal(second.stats.detailsReused, 1, "a media record with the exact current list preview may be reused");
      assert.equal(secondRequests.some((request) => request.url === detailUrl), false);
      assert.equal(second.documents[0].images[0].role, "preview");
      assert.equal(second.documents[0].thumbnailUrl, first.documents[0].thumbnailUrl);
      assert.equal(second.documents[0].body, "");
    }
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testKcnaPhotoListingPreviewIdentityFallback() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-kcna-photo-identity-fallback-"));
  const origin = "http://kcna-photo-identity-fallback.test";
  const photoList = `${origin}/kp/gallery/list/${"1".repeat(32)}`;
  const videoList = `${origin}/kp/video/list/${"2".repeat(32)}`;
  const photoUrl = `${origin}/kp/gallery/detail/${"3".repeat(32)}`;
  const videoUrl = `${origin}/kp/video/detail/${"4".repeat(32)}`;
  const photoTitle = "상세페지가 고장난 공식 사진자료";
  const videoTitle = "상세페지가 고장난 공식 동화상자료";
  const photoPreviewBytes = Buffer.concat([JPEG_A, Buffer.from([0x31])]);
  const videoPreviewBytes = Buffer.concat([JPEG_A, Buffer.from([0x32])]);
  const photoPreview = `data:image/jpeg;base64,${photoPreviewBytes.toString("base64")}`;
  const videoPreview = `data:image/jpeg;base64,${videoPreviewBytes.toString("base64")}`;
  const listingHtml = (kind, listingUrl, detailUrl, title, preview, csrf) => `
    <form id="${kind}_form" method="POST" action="${new URL(listingUrl).pathname}">
      <input name="page_num" value="1"><input name="cnt_per_page" value="1">
      <input name="_csrf" value="${csrf}">
    </form>
    <script>var total=1; var cur_page=1; var per_page=1; var page_cnt=1;</script>
    <main><div class="${kind}">
      <a href="${detailUrl}"><img src="${preview}" alt="${title}"></a>
      <h5><a href="${detailUrl}">${title}</a><span>[2026.7.23.]</span></h5>
    </div></main>`;
  let photoAttempts = 0;
  let videoAttempts = 0;
  const fixtures = new Map([
    [photoList, htmlResponse(listingHtml("gallery", photoList, photoUrl, photoTitle, photoPreview, "photo-fallback-csrf"))],
    [videoList, htmlResponse(listingHtml("video", videoList, videoUrl, videoTitle, videoPreview, "video-fallback-csrf"))],
    [photoUrl, () => {
      photoAttempts += 1;
      return htmlResponse(`<html><head><title>조선중앙통신 | 첫페지</title></head><body lang="ko">
        <main><div class="gallery"><h1>첫페지 사진소식</h1></div></main>
      </body></html>`);
    }],
    [videoUrl, () => {
      videoAttempts += 1;
      return htmlResponse(`<html><head><title>조선중앙통신 | 첫페지</title></head><body lang="ko">
        <main><div class="video"><h1>첫페지 동화상소식</h1></div></main>
      </body></html>`);
    }],
  ]);

  try {
    const result = await crawlKcnaNews({
      categoryLists: [
        { id: "photo", label: "사진", kind: "photo", url: photoList },
        { id: "video", label: "동화상", kind: "video", url: videoList },
      ],
      fetchImpl: fixtureFetch(fixtures, []),
      cacheRemoteImages: false,
      assetDir,
      publicAssetBase: "/data/news/assets",
      now: TEST_NOW,
      retryDelayMs: 0,
      imageRetryAttempts: 0,
      detailConcurrency: 1,
      maxListPages: 1,
      maxDocuments: 10,
    });
    assert.equal(photoAttempts, 3, "a broken photo detail must exhaust the bounded identity retries before fallback");
    assert.equal(videoAttempts, 3, "the same identity failure must never enable the photo-only fallback for video");
    assert.equal(result.documents.length, 1);
    assert.equal(result.stats.detailsFetched, 1);
    assert.equal(result.stats.detailsUnresolved, 1);
    assert.equal(result.errors.filter((error) => error.stage === "detail").length, 1);
    assert.equal(result.errors.find((error) => error.stage === "detail")?.url, videoUrl);
    const [photo] = result.documents;
    assert.equal(photo.url, photoUrl);
    assert.equal(photo.kind, "photo");
    assert.equal(photo.title, photoTitle, "the exact official listing title must be retained");
    assert.equal(photo.date, "2026-07-23", "the exact official listing date must be retained");
    assert.equal(photo.body, "", "homepage chrome must never become a photo body");
    assert.equal(photo.galleryUrl, photoUrl);
    assert.deepEqual(photo.markers, { camera: true, gallery: true });
    assert.equal(photo.images.length, 1);
    assert.equal(photo.images[0].role, "preview");
    assert.equal(
      photo.images[0].sha256,
      createHash("sha256").update(photoPreviewBytes).digest("hex"),
      "fallback must materialize only the exact item-scoped official list preview",
    );
    assert.equal(photo.thumbnailUrl, photo.images[0].cachedUrl);
    assert.match(photo.thumbnailUrl, /^\/data\/news\/assets\/kcna\/[a-f0-9]{64}\.jpg$/u);
    assert.equal(result.stats.documentsMissingExpectedImages, 0);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testMissingImageDiagnosticSamples() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-missing-image-diagnostic-"));
  const origin = "http://kcna-missing-image.test";
  const listingUrl = `${origin}/kp/article/list/${"a".repeat(32)}`;
  const detailUrls = Array.from({ length: 22 }, (_, index) => (
    `${origin}/kp/article/detail/${(index + 1).toString(16).padStart(32, "0")}`
  ));
  const csrf = "missing-image-csrf";
  const listingRows = detailUrls.map((detailUrl, index) => (
    `<div class="article"><h5><a href="${detailUrl}">사진 표식만 남은 진단 기사 ${index + 1}</a><i class="camera"></i><span>[2026.1.5.]</span></h5></div>`
  )).join("");
  const fixtures = new Map([
    [listingUrl, htmlResponse(`
      <form id="article_form" method="POST" action="${new URL(listingUrl).pathname}">
        <input type="hidden" name="page_num" value="1"><input type="hidden" name="cnt_per_page" value="22">
        <input type="hidden" name="keyword" value=""><input type="hidden" name="_csrf" value="${csrf}">
      </form>
      <script>var total=22; var cur_page=1; var per_page=22; var page_cnt=1;</script>
      ${listingRows}`)],
    ...detailUrls.map((detailUrl, index) => [
      detailUrl,
      htmlResponse(kcnaArticleDetailHtml(
        detailUrl,
        `사진 표식만 남은 진단 기사 ${index + 1}`,
        "<time>2026.1.5.</time><p>사진 주소를 찾지 못한 공식 본문이다.</p>",
      )),
    ]),
  ]);
  try {
    const result = await crawlKcnaNews({
      categoryLists: [{ id: "important", label: "중요소식", kind: "article", url: listingUrl }],
      fetchImpl: fixtureFetch(fixtures, []),
      cacheRemoteImages: false,
      assetDir,
      now: TEST_NOW,
      maxListPages: 1,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.stats.documentsMissingExpectedImages, 22);
    assert.equal(result.stats.missingExpectedImageSamples.length, 20, "diagnostic samples must remain bounded");
    assert.deepEqual(result.stats.missingExpectedImageSamples[0], {
      url: detailUrls[0],
      title: "사진 표식만 남은 진단 기사 1",
      date: "2026-01-05",
      kind: "article",
      categories: ["important"],
      markers: { camera: true, gallery: false },
      galleryUrl: "",
    });
    assert.equal(result.stats.missingExpectedImageSamplesOmitted, 2);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testPerCategoryOfficialListOrder() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-official-order-"));
  const origin = "http://kcna-official-order.test";
  const importantList = `${origin}/kp/article/list/important`;
  const domesticList = `${origin}/kp/article/list/domestic`;
  const officialFirstUrl = `${origin}/kp/article/detail/${"f".repeat(32)}`;
  const officialSecondUrl = `${origin}/kp/article/detail/${"a".repeat(32)}`;
  const titleByUrl = new Map([
    [officialFirstUrl, "공식 목록 첫째 기사"],
    [officialSecondUrl, "공식 목록 둘째 기사"],
  ]);
  const listing = (urls) => htmlResponse(urls.map((url) => (
    `<div class="article"><h5 class="block"><a href="${url}">${titleByUrl.get(url)}</a><span>[2026.8.17.]</span></h5></div>`
  )).join(""));
  const fixtures = new Map([
    [importantList, listing([officialFirstUrl, officialSecondUrl])],
    [domesticList, listing([officialSecondUrl, officialFirstUrl])],
    ...[officialFirstUrl, officialSecondUrl].map((url) => [
      url,
      htmlResponse(kcnaArticleDetailHtml(
        url,
        titleByUrl.get(url),
        `<time>2026.8.17.</time><p>${titleByUrl.get(url)}의 공식 본문이다.</p>`,
      )),
    ]),
  ]);
  try {
    const result = await crawlKcnaNews({
      categoryLists: [
        { id: "important", label: "중요소식", kind: "article", url: importantList },
        { id: "domestic", label: "국내소식", kind: "article", url: domesticList },
      ],
      fetchImpl: fixtureFetch(fixtures, []),
      assetDir,
      now: TEST_NOW,
      maxListPages: 1,
      maxDocuments: 10,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.documents.length, 2);
    const byUrl = new Map(result.documents.map((document) => [document.url, document]));
    assert.deepEqual(byUrl.get(officialFirstUrl).categoryOrders, { domestic: 1, important: 0 });
    assert.deepEqual(byUrl.get(officialSecondUrl).categoryOrders, { domestic: 0, important: 1 });
    const orderFor = (category) => [...result.documents]
      .sort((left, right) => left.categoryOrders[category] - right.categoryOrders[category])
      .map((document) => document.url);
    assert.deepEqual(
      orderFor("important"),
      [officialFirstUrl, officialSecondUrl],
      "same-date category order must follow official DOM order instead of URL order",
    );
    assert.deepEqual(
      orderFor("domestic"),
      [officialSecondUrl, officialFirstUrl],
      "one article may retain a different official rank in another category",
    );
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testIncrementalDetailReuseAndBackfill() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-incremental-"));
  const origin = "http://kcna-incremental.test";
  const listingUrl = `${origin}/kp/article/list/incremental`;
  const oldUrl = `${origin}/kp/article/detail/${"a".repeat(32)}`;
  const recentUrl = `${origin}/kp/article/detail/${"b".repeat(32)}`;
  const listing = htmlResponse(`
    <div class="article"><h5 class="block"><a href="${recentUrl}">최근 변경 확인 기사</a><span>[2026.8.20.]</span></h5></div>
    <div class="article"><h5 class="block"><a href="${oldUrl}">변경 없는 보관 기사</a><span>[2026.1.2.]</span></h5></div>`);
  const oldKnown = {
    schemaVersion: NEWS_MIRROR_SCHEMA_VERSION,
    id: `news:kcna:${createHash("sha256").update(oldUrl).digest("hex").slice(0, 24)}`,
    sourceId: "kcna",
    sourceName: "조선중앙통신",
    language: "ko",
    category: { id: "important", label: "중요소식" },
    categories: ["important"],
    kind: "article",
    title: "변경 없는 보관 기사",
    date: "2026-01-02",
    url: oldUrl,
    body: "이미 보관된 충분한 공식 기사 본문이다.",
    images: [],
    thumbnailUrl: "",
    markers: { camera: false, gallery: false },
    galleryUrl: "",
    mirroredAt: "2026-01-02T00:00:00.000Z",
  };
  const recentDetail = htmlResponse(kcnaArticleDetailHtml(
    recentUrl,
    "최근 변경 확인 기사",
    "<time>2026.8.20.</time><p>최근 변경 창에서 다시 받은 본문이다.</p>",
  ));

  try {
    const requests = [];
    const result = await crawlKcnaNews({
      categoryLists: [{ id: "leadership", label: "혁명활동소식", kind: "article", url: listingUrl }],
      fetchImpl: fixtureFetch(new Map([[listingUrl, listing], [recentUrl, recentDetail]]), requests),
      knownDocuments: [oldKnown],
      recentDetailDays: 7,
      retryDelayMs: 0,
      assetDir,
      now: TEST_NOW,
      maxListPages: 1,
      maxDocuments: 10,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.stats.entriesSelected, 2);
    assert.equal(result.stats.detailsFetched, 1);
    assert.equal(result.stats.detailsReused, 1);
    assert.equal(result.stats.detailsUnresolved, 0);
    assert.equal(result.stats.detailsComplete, true);
    assert.equal(requests.some((request) => request.url === oldUrl), false, "unchanged old detail must be reused without a request");
    const reused = result.documents.find((document) => document.url === oldUrl);
    assert.equal(reused.body, oldKnown.body);
    assert.deepEqual(reused.categories, ["leadership"], "listing categories remain authoritative for reused details");

    const backfillRequests = [];
    const backfill = await crawlKcnaNews({
      categoryLists: [{ id: "leadership", label: "혁명활동소식", kind: "article", url: listingUrl }],
      fetchImpl: fixtureFetch(new Map([
        [listingUrl, listing],
        [recentUrl, recentDetail],
        [oldUrl, htmlResponse(kcnaArticleDetailHtml(
          oldUrl,
          "변경 없는 보관 기사",
          "<time>2026.1.2.</time><p>전체 백필로 다시 받은 공식 본문이다.</p>",
        ))],
      ]), backfillRequests),
      knownDocuments: [oldKnown],
      fullBackfill: true,
      retryDelayMs: 0,
      assetDir,
      now: TEST_NOW,
      maxListPages: 1,
      maxDocuments: 10,
    });
    assert.equal(backfill.stats.detailsFetched, 2);
    assert.equal(backfill.stats.detailsReused, 0);
    assert.equal(backfillRequests.some((request) => request.url === oldUrl), true, "manual backfill must bypass reuse");
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testSuspiciousKnownImageReuseGuard() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-image-collision-"));
  const origin = "http://kcna-image-collision.test";
  const listingUrl = `${origin}/kp/article/list/collision`;
  const firstUrl = `${origin}/kp/article/detail/${"d".repeat(32)}`;
  const secondUrl = `${origin}/kp/article/detail/${"e".repeat(32)}`;
  const sharedImages = Array.from({ length: 8 }, (_, index) => ({
    originalUrl: `${origin}/photo/shared-${index + 1}.jpg`,
    cachedUrl: "",
    sha256: "",
    mimeType: "image/jpeg",
    bytes: 0,
    role: "gallery",
  }));
  const firstKnown = makeKnownKcnaDocument({
    url: firstUrl,
    title: "서로 다른 첫 보관 기사",
    date: "2026-01-02",
    images: sharedImages,
  });
  const secondKnown = makeKnownKcnaDocument({
    url: secondUrl,
    title: "서로 다른 둘째 보관 기사",
    date: "2026-01-03",
    images: sharedImages,
  });
  const requests = [];
  try {
    const result = await crawlKcnaNews({
      categoryLists: [{ id: "important", label: "중요소식", kind: "article", url: listingUrl }],
      fetchImpl: fixtureFetch(new Map([
        [listingUrl, htmlResponse(`
          <div class="article"><h5 class="block"><a href="${firstUrl}">${firstKnown.title}</a><span>[2026.1.2.]</span></h5></div>
          <div class="article"><h5 class="block"><a href="${secondUrl}">${secondKnown.title}</a><span>[2026.1.3.]</span></h5></div>`)],
        [firstUrl, htmlResponse(kcnaArticleDetailHtml(
          firstUrl,
          firstKnown.title,
          "<time>2026.1.2.</time><p>첫 기사의 오염되지 않은 공식 본문이다.</p>",
        ))],
        [secondUrl, htmlResponse(kcnaArticleDetailHtml(
          secondUrl,
          secondKnown.title,
          "<time>2026.1.3.</time><p>둘째 기사의 오염되지 않은 공식 본문이다.</p>",
        ))],
      ]), requests),
      knownDocuments: [firstKnown, secondKnown],
      recentDetailDays: 7,
      retryDelayMs: 0,
      cacheRemoteImages: false,
      assetDir,
      now: TEST_NOW,
      maxListPages: 1,
      maxDocuments: 10,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.stats.detailsFetched, 2);
    assert.equal(result.stats.detailsReused, 0);
    assert.equal(result.stats.knownDetailsBlockedByImageCollision, 2);
    assert.equal(requests.some((request) => request.url === firstUrl), true);
    assert.equal(requests.some((request) => request.url === secondUrl), true);

    const articleListingUrl = `${origin}/kp/article/list/legitimate`;
    const galleryListingUrl = `${origin}/kp/gallery/list/legitimate`;
    const articleUrl = `${origin}/kp/article/detail/${"f".repeat(32)}`;
    const galleryUrl = `${origin}/kp/gallery/detail/${"1".repeat(32)}`;
    const pairedTitle = "같은 기사와 화보 짝";
    const pairedDate = "2026-01-04";
    const pairedArticle = makeKnownKcnaDocument({
      url: articleUrl,
      title: pairedTitle,
      date: pairedDate,
      images: sharedImages,
      kind: "article",
    });
    const pairedGallery = makeKnownKcnaDocument({
      url: galleryUrl,
      title: pairedTitle,
      date: pairedDate,
      images: sharedImages,
      kind: "photo",
    });
    const pairedRequests = [];
    const paired = await crawlKcnaNews({
      categoryLists: [
        { id: "important", label: "중요소식", kind: "article", url: articleListingUrl },
        { id: "photo", label: "사진", kind: "photo", url: galleryListingUrl },
      ],
      fetchImpl: fixtureFetch(new Map([
        [articleListingUrl, htmlResponse(`<div class="article"><h5 class="block"><a href="${articleUrl}">${pairedTitle}</a><span>[2026.1.4.]</span></h5></div>`)],
        [galleryListingUrl, htmlResponse(`<main><div class="gallery"><a href="${galleryUrl}"><img src="${sharedImages[0].originalUrl}" alt="${pairedTitle}"></a><h5 class="block"><a href="${galleryUrl}">${pairedTitle}</a><span>[2026.1.4.]</span></h5></div></main>`)],
        [galleryUrl, htmlResponse(kcnaMediaDetailHtml(
          "photo",
          pairedTitle,
          `<time>2026.1.4.</time>${sharedImages.map((image) => `<img src="${image.originalUrl}">`).join("")}`,
        ))],
      ]), pairedRequests),
      knownDocuments: [pairedArticle, pairedGallery],
      recentDetailDays: 7,
      cacheRemoteImages: false,
      assetDir,
      now: TEST_NOW,
      maxListPages: 1,
      maxDocuments: 10,
    });
    assert.equal(paired.errors.length, 0);
    assert.equal(paired.stats.detailsFetched, 1, "media records with unverified extra images are refreshed even for a legitimate article/gallery pair");
    assert.equal(paired.stats.detailsReused, 1);
    assert.equal(paired.stats.knownDetailsBlockedByImageCollision, 0);
    assert.equal(pairedRequests.some((request) => request.url === articleUrl), false);
    assert.equal(pairedRequests.some((request) => request.url === galleryUrl), true);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

function makeKnownKcnaDocument({ url, title, date, images, kind = "article" }) {
  const categoryId = kind === "photo" ? "photo" : kind === "video" ? "video" : "important";
  const categoryLabel = kind === "photo" ? "사진" : kind === "video" ? "동화상" : "중요소식";
  return {
    schemaVersion: NEWS_MIRROR_SCHEMA_VERSION,
    id: `news:kcna:${createHash("sha256").update(url).digest("hex").slice(0, 24)}`,
    sourceId: "kcna",
    sourceName: "조선중앙통신",
    language: "ko",
    category: { id: categoryId, label: categoryLabel },
    categories: [categoryId],
    kind,
    title,
    date,
    url,
    body: `${title}의 이미 보관된 충분한 공식 본문이다.`,
    images: images.map((image) => ({ ...image })),
    thumbnailUrl: images[0]?.originalUrl || "",
    markers: { camera: images.length > 0, gallery: images.length > 1 },
    galleryUrl: kind === "photo" ? url : "",
    mirroredAt: `${date}T00:00:00.000Z`,
  };
}

async function testTransientDetailRetries() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-detail-retry-"));
  const origin = "http://kcna-detail-retry.test";
  const listingUrl = `${origin}/kp/article/list/retry`;
  const detailUrl = `${origin}/kp/article/detail/${"c".repeat(32)}`;
  let attempts = 0;
  const requests = [];
  const fetchImpl = fixtureFetch(new Map([
    [listingUrl, htmlResponse(`<div class="article"><h5 class="block"><a href="${detailUrl}">상세 재시도 기사</a><span>[2026.8.18.]</span></h5></div>`)],
    [detailUrl, () => {
      attempts += 1;
      if (attempts < 3) return htmlResponse(`<html><head><title>조선중앙통신 | 첫페지</title></head><body lang="ko">
        <main><h1>첫페지 최신소식</h1><div class="data_kind"><i class="fa fa-camera"></i></div>
          <time>2026.8.17.</time><p>요청 기사와 무관한 홈페이지 본문이다.</p></main>
      </body></html>`);
      return htmlResponse(kcnaArticleDetailHtml(
        detailUrl,
        "상세 재시도 기사",
        "<time>2026.8.18.</time><p>세번째 시도에서 받은 본문이다.</p>",
      ));
    }],
  ]), requests);
  try {
    const result = await crawlKcnaNews({
      categoryLists: [{ id: "important", label: "중요소식", kind: "article", url: listingUrl }],
      fetchImpl,
      assetDir,
      now: TEST_NOW,
      retryDelayMs: 0,
      maxListPages: 1,
    });
    assert.equal(attempts, 3, "HTTP 200 homepage identity mismatches must receive two bounded retries");
    assert.equal(result.errors.length, 0);
    assert.equal(result.stats.detailsFetched, 1);
    assert.equal(result.stats.detailRetryAttempts, 2);
    assert.equal(result.documents[0].date, "2026-08-18");
    assert.doesNotMatch(result.documents[0].body, /홈페이지 본문/u);
    assert.equal(result.documents[0].markers.camera, false, "homepage camera chrome must never contaminate the article");
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testKcnaDetailIdentityVariants() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-kcna-detail-identity-"));
  const origin = "http://kcna-detail-identity.test";
  const listingUrl = `${origin}/kp/article/list/identity`;
  const multiTitleUrl = `${origin}/kp/article/detail/${"1".repeat(32)}`;
  const noLanguageUrl = `${origin}/kp/article/detail/${"2".repeat(32)}`;
  const wrongActiveUrl = `${origin}/kp/article/detail/${"3".repeat(32)}`;
  const homepageUrl = `${origin}/kp/article/detail/${"4".repeat(32)}`;
  const metadataMarkupUrl = `${origin}/kp/article/detail/${"5".repeat(32)}`;
  const multiTitle = "당,정,군련합회의에 관한 보도";
  const noLanguageTitle = "로씨야에서 위대한 조국전쟁승리 81돐경축 열병식 진행";
  const wrongActiveTitle = "다른 언어련결을 가진 기사";
  const homepageTitle = "홈페이지로 잘못 응답된 기사";
  const metadataMarkupTitle = "2025년 국가최우수과학자,기술자들--김일성종합대학 재료과학부 실장 김성무";
  const listingHtml = [
    [multiTitleUrl, multiTitle, "2026.8.18."],
    [noLanguageUrl, noLanguageTitle, "2026.8.17."],
    [wrongActiveUrl, wrongActiveTitle, "2026.8.16."],
    [homepageUrl, homepageTitle, "2026.8.15."],
    [metadataMarkupUrl, metadataMarkupTitle, "2026.5.4."],
  ].map(([url, title, date]) => (
    `<div class="article"><h5 class="block"><a href="${url}">${title}</a><span>[${date}]</span></h5></div>`
  )).join("");
  let wrongActiveAttempts = 0;
  let homepageAttempts = 0;
  const requests = [];
  const fixtures = new Map([
    [listingUrl, htmlResponse(listingHtml)],
    [multiTitleUrl, htmlResponse(`<html><head><title>조선중앙통신 | ${multiTitle}</title></head><body lang="ko">
      <a class="active" lang="ko" href="${multiTitleUrl}">조선어</a>
      <main><article>
        <h1>강건한 규률과 엄격한 법적기강으로 혁명의 승리적진군을 담보하자</h1>
        <h1>${multiTitle}</h1><p>두번째 제목이 listing과 정확히 일치하는 공식 본문이다.</p>
      </article></main>
    </body></html>`)],
    [noLanguageUrl, htmlResponse(`<html><head>
      <title>조선중앙통신 | ${noLanguageTitle}</title>
      <link href="/css/article_detail.min.css" rel="stylesheet">
    </head><body lang="ko"><main><article>
      <h1>${noLanguageTitle}</h1><p>언어련결이 없지만 상세 구조가 완전한 오래된 공식 본문이다.</p>
    </article></main></body></html>`)],
    [metadataMarkupUrl, htmlResponse(`<html><head>
      <title>조선중앙통신 | 2025년 국가최우수과학자,기술자들<b>--</b>김일성종합대학 재료과학부 실장 김성무</title>
    </head><body lang="ko">
      <a class="active" lang="ko" href="${metadataMarkupUrl}">조선어</a>
      <main><article>
        <h1>2025년 국가최우수과학자,기술자들</h1>
        <h1>김일성종합대학 재료과학부 실장 김성무</h1>
        <p>문서 제목의 안전한 서식 토큰을 제거해야만 목록 제목과 일치하는 공식 본문이다.</p>
      </article></main>
    </body></html>`)],
    [wrongActiveUrl, () => {
      wrongActiveAttempts += 1;
      return htmlResponse(`<html><head><title>조선중앙통신 | ${wrongActiveTitle}</title>
        <link href="/css/article_detail.min.css" rel="stylesheet"></head><body lang="ko">
        <a class="active" lang="ko" href="${multiTitleUrl}">조선어</a>
        <main><article><h1>${wrongActiveTitle}</h1><p>활성 련결은 다른 기사를 가리킨다.</p></article></main>
      </body></html>`);
    }],
    [homepageUrl, () => {
      homepageAttempts += 1;
      return htmlResponse(`<html><head><title>조선중앙통신 | 첫페지</title></head><body lang="ko">
        <main><h1>첫페지 최신소식</h1><div class="data_kind"><i class="fa fa-camera"></i></div>
          <time>2026.8.17.</time><p>요청 기사와 무관한 홈페이지 본문이다.</p></main>
      </body></html>`);
    }],
  ]);

  try {
    const result = await crawlKcnaNews({
      categoryLists: [{ id: "important", label: "중요소식", kind: "article", url: listingUrl }],
      fetchImpl: fixtureFetch(fixtures, requests),
      assetDir,
      now: TEST_NOW,
      retryDelayMs: 0,
      detailConcurrency: 1,
      maxListPages: 1,
      maxDocuments: 10,
    });
    assert.equal(result.documents.length, 3);
    assert.equal(result.stats.detailsFetched, 3);
    assert.equal(result.stats.detailsUnresolved, 2);
    assert.equal(result.errors.filter((error) => error.stage === "detail").length, 2);
    assert.equal(wrongActiveAttempts, 3, "a mismatched active detail link must remain rejected through the bounded retries");
    assert.equal(homepageAttempts, 3, "an HTTP 200 homepage must remain rejected through the bounded retries");
    assert.match(result.errors.find((error) => error.url === wrongActiveUrl)?.error || "", /language link does not match/iu);
    assert.match(result.errors.find((error) => error.url === homepageUrl)?.error || "", /missing its article detail root/iu);
    const multiTitleDocument = result.documents.find((document) => document.url === multiTitleUrl);
    assert.equal(multiTitleDocument?.title, multiTitle, "the exact matching second h1 must be stored instead of the first kicker");
    assert.doesNotMatch(multiTitleDocument?.title || "", /강건한 규률/u);
    assert.equal(
      result.documents.find((document) => document.url === noLanguageUrl)?.title,
      noLanguageTitle,
      "an older detail without language links is valid only with its exact stylesheet, root, and title identity",
    );
    assert.equal(
      result.documents.find((document) => document.url === metadataMarkupUrl)?.title,
      metadataMarkupTitle,
      "literal safe formatting tags in metadata must be stripped before exact title matching",
    );
    assert.doesNotMatch(
      result.documents.find((document) => document.url === metadataMarkupUrl)?.title || "",
      /<\/?b>/iu,
    );
    assert.equal(result.documents.some((document) => /홈페이지 본문/u.test(document.body)), false);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testKcnaCrawlWithGalleryAssets() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-kcna-"));
  const listingUrl = "http://kcna.test/kp/article/list/fixture-category";
  const detailUrl = "http://kcna.test/kp/article/q/article-one.kcmsf";
  const galleryUrl = "http://kcna.test/kp/gallery/detail/gallery-one";
  const galleryImages = Array.from({ length: 20 }, (_, index) => ({
    url: `http://kcna.test/photo/photo-${index + 1}.jpg`,
    bytes: Buffer.concat([JPEG_A, Buffer.from([index + 1])]),
  }));
  const requests = [];
  const fixtures = new Map([
    [listingUrl, htmlResponse(`<ul><li><a href="${detailUrl}">새 기사</a><time>2026.08.17.</time><i class="camera"></i></li></ul>`)],
    [detailUrl, htmlResponse(kcnaArticleDetailHtml(
      detailUrl,
      "새 기사",
      `<time>2026.08.17.</time><div class="article_body"><p>새 기사의 충분한 본문입니다.</p><a class="gallery_button" href="${galleryUrl}">사진</a></div>`,
    ))],
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
    assert.equal(document.images.length, 20, "a legitimate gallery larger than 16 images must fit under the safe document cap");
    assert.ok(document.images.every((image) => /^\/data\/news\/assets\/kcna\/[a-f0-9]{64}\.jpg$/u.test(image.cachedUrl)));
    assert.deepEqual(
      requests.filter((request) => request.url.startsWith("http://kcna.test/photo/")).map((request) => request.init.headers.Referer),
      Array.from({ length: 20 }, () => galleryUrl),
      "each KCNA /photo/ request must carry its same-origin gallery Referer",
    );
    const files = await fs.readdir(path.join(assetDir, "kcna"));
    assert.equal(files.length, 20);
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

async function testImageRetryAndFailureRelease() {
  const retryAssetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-image-retry-"));
  const origin = "http://image-retry.test";
  const listingUrl = `${origin}/kp/article/list/retry`;
  const detailUrl = `${origin}/kp/article/q/retry.kcmsf`;
  const imageUrl = `${origin}/photo/retry.jpg`;
  let imageAttempts = 0;
  const retryFetch = fixtureFetch(new Map([
    [listingUrl, htmlResponse(`<a href="${detailUrl}">재시도 기사</a><time>2026.08.17.</time>`)],
    [detailUrl, htmlResponse(kcnaArticleDetailHtml(
      detailUrl,
      "재시도 기사",
      `<p>일시적인 사진 응답 실패를 검증하는 본문이다.</p><img src="${imageUrl}">`,
    ))],
    [imageUrl, () => {
      imageAttempts += 1;
      return imageAttempts === 1
        ? new Response("temporary", { status: 503, headers: { "Content-Type": "text/plain" } })
        : imageResponse(JPEG_A, "image/jpeg");
    }],
  ]), []);
  try {
    const result = await crawlKcnaNews({
      categoryLists: [{ id: "important", label: "중요소식", kind: "article", url: listingUrl }],
      fetchImpl: retryFetch,
      assetDir: retryAssetDir,
      now: TEST_NOW,
      maxListPages: 1,
      imageRetryAttempts: 1,
      retryDelayMs: 0,
    });
    assert.equal(result.documents[0].images.length, 1);
    assert.equal(imageAttempts, 2);
    assert.equal(result.stats.imageQuota.failedAttempts, 1);
    assert.equal(result.stats.imageQuota.retryAttempts, 1);
    assert.equal(result.stats.imageQuota.failedReferences, 0);
    assert.equal(result.stats.imageQuota.quotaBytesCharged, JPEG_A.length, "failed attempts must not consume byte quota");
  } finally {
    await fs.rm(retryAssetDir, { recursive: true, force: true });
  }

  const releaseAssetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-image-release-"));
  const releaseOrigin = "http://image-release.test";
  const releaseList = `${releaseOrigin}/kp/article/list/release`;
  const releaseDetail = `${releaseOrigin}/kp/article/q/release.kcmsf`;
  const failedImage = `${releaseOrigin}/photo/failed.jpg`;
  const successfulImage = `${releaseOrigin}/photo/success.jpg`;
  const releaseRequests = [];
  const releaseFetch = fixtureFetch(new Map([
    [releaseList, htmlResponse(`<a href="${releaseDetail}">예약 해제 기사</a><time>2026.08.17.</time>`)],
    [releaseDetail, htmlResponse(kcnaArticleDetailHtml(
      releaseDetail,
      "예약 해제 기사",
      `<p>실패한 예약이 다음 사진을 막지 않는지 검증한다.</p><img src="${failedImage}"><img src="${successfulImage}">`,
    ))],
    [failedImage, new Response("temporary", { status: 503, headers: { "Content-Type": "text/plain" } })],
    [successfulImage, imageResponse(JPEG_A, "image/jpeg")],
  ]), releaseRequests);
  try {
    const result = await crawlKcnaNews({
      categoryLists: [{ id: "important", label: "중요소식", kind: "article", url: releaseList }],
      fetchImpl: releaseFetch,
      assetDir: releaseAssetDir,
      now: TEST_NOW,
      maxListPages: 1,
      imageConcurrency: 1,
      imageRetryAttempts: 0,
      imageMaxBytes: 64,
      maxImageBytesPerCrawl: 64,
    });
    assert.equal(result.documents[0].images.length, 1);
    assert.equal(releaseRequests.some((request) => request.url === successfulImage), true);
    assert.equal(result.stats.imageQuota.failedReferences, 1);
    assert.equal(result.stats.imageQuota.failedAttempts, 1);
    assert.equal(result.stats.imageQuota.quotaBytesCharged, JPEG_A.length);
  } finally {
    await fs.rm(releaseAssetDir, { recursive: true, force: true });
  }
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
    [kcnaDetailUrl, htmlResponse(kcnaArticleDetailHtml(
      kcnaDetailUrl,
      "공유 제한 중앙통신 기사",
      `<time>2026.08.17.</time><div class="article_body"><p>공유 제한을 검증하는 중앙통신 기사 본문입니다.</p><img src="${kcnaImageUrl}"></div>`,
    ))],
    [kcnaImageUrl, imageResponse(JPEG_A, "image/jpeg")],
    [rodongHomepageUrl, htmlResponse(`<nav><a href="/index.php?${rodongPageToken}">혁명활동소식</a></nav>`)],
    [rodongListUrl, htmlResponse(`<main><div id="RevoListDIV"><a href="/index.php?${rodongArticleToken}">공유 제한 로동신문 기사</a><time>2026.08.17.</time></div></main>`)],
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
    [detailUrl, htmlResponse(kcnaArticleDetailHtml(
      detailUrl,
      "화상 제한 시험 기사",
      `<time>2026.08.17.</time><div class="article_body"><p>화상 제한을 검증하기 위한 충분한 본문입니다.</p>${imageTags}</div>`,
    ))],
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
  const alternateFirstPageToken = Buffer.from("1@@1@1@@0@", "utf8").toString("base64");
  const secondPageToken = encodeRodongCategoryToken("1", 2);
  const wrongCategoryToken = encodeRodongCategoryToken("3", 2);
  const firstPageUrl = `http://rodong.test/index.php?${firstPageToken}`;
  const alternateFirstPageUrl = `http://rodong.test/index.php?${alternateFirstPageToken}`;
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
    [firstPageUrl, htmlResponse(`<main><div id="PathBar">홈 &gt; 혁명활동소식 &gt; 2건</div><div id="RevoListDIV"><ul><li><a href="/index.php?${detailOneToken}">경애하는 <b>김정은</b>동지께서 공연을 관람하시였다</a><time>2026.8.17.</time></li></ul></div><a href="/index.php?${secondPageToken}">2</a><a href="/index.php?${wrongCategoryToken}">다른 분류</a></main>`)],
    [secondPageUrl, htmlResponse(`<main><div id="PathBar">홈 &gt; 혁명활동소식 &gt; 2건</div><div id="RevoListDIV"><ul><li><a href="/index.php?${detailTwoToken}">조국해방을 경축하는 행사 진행</a><time>2026.8.15.</time></li></ul></div><a href="/index.php?${alternateFirstPageToken}">1</a></main>`)],
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
    assert.equal(result.stats.listingFrontierExhausted, true);
    assert.equal(result.stats.capReached, false);
    assert.deepEqual(result.stats.categories.map((categoryStats) => ({
      id: categoryStats.id,
      pagesDiscovered: categoryStats.pagesDiscovered,
      pagesFetched: categoryStats.pagesFetched,
      declaredTotal: categoryStats.declaredTotal,
      declaredLastPage: categoryStats.declaredLastPage,
      listingErrors: categoryStats.listingErrors,
      frontierExhausted: categoryStats.frontierExhausted,
    })), [{
      id: "leadership",
      pagesDiscovered: 2,
      pagesFetched: 2,
      declaredTotal: 2,
      declaredLastPage: 2,
      listingErrors: 0,
      frontierExhausted: true,
    }]);
    assert.deepEqual(result.documents.map((document) => document.date), ["2026-08-17", "2026-08-15"]);
    assert.equal(result.documents[0].title, "경애하는 김정은동지께서 공연을 관람하시였다");
    assert.equal(result.documents[0].images.length, 2);
    assert.ok(result.documents[0].images.some((image) => image.mimeType === "image/jpeg"));
    assert.ok(result.documents[0].images.some((image) => image.mimeType === "image/png"));
    assert.ok(result.documents[0].images.every((image) => image.cachedUrl.startsWith("/data/news/assets/rodong-sinmun/")));
    assert.equal(requests.some((request) => request.url === queryLikeUrl), false, "an unrelated query-like token must never seed a request");
    assert.equal(requests.some((request) => request.url.includes(wrongCategoryToken)), false, "pagination must retain the selected category code");
    assert.equal(
      requests.some((request) => request.url === alternateFirstPageUrl),
      false,
      "equivalent short and extended page-one tokens must share one semantic frontier identity",
    );
    assert.equal(requests.find((request) => request.url === imageUrl)?.init.headers.Referer, detailOneUrl);
    assert.deepEqual(
      requests.filter((request) => request.url === firstPageUrl || request.url === secondPageUrl).map((request) => request.url),
      [firstPageUrl, secondPageUrl],
      "the decoded `1@@category@page@` ordering must drive page iteration",
    );

    const capped = await crawlRodongNews({
      homepageUrl,
      fetchImpl,
      assetDir,
      publicAssetBase: "/data/news/assets",
      now: TEST_NOW,
      maxListPages: 1,
      imageRetryAttempts: 0,
    });
    assert.equal(capped.stats.listingFrontierExhausted, false);
    assert.equal(capped.stats.capReached, true);
    assert.equal(capped.stats.categories[0].pageCapReached, true);
    assert.equal(capped.stats.categories[0].frontierExhausted, false);

    const unprovenFetch = fixtureFetch(new Map([
      [homepageUrl, htmlResponse(`<nav><a href="/index.php?${firstPageToken}">혁명활동소식</a></nav>`)],
      [firstPageUrl, htmlResponse(`<main><div id="RevoListDIV"><ul><li><a href="/index.php?${detailOneToken}">경애하는 김정은동지께서 공연을 관람하시였다</a><time>2026.8.17.</time></li></ul></div></main>`)],
      [detailOneUrl, htmlResponse(`<main><h1>경애하는 김정은동지께서 공연을 관람하시였다</h1><div class="rodong_view"><p>공연이 성황리에 진행되였다.</p></div></main>`)],
    ]), []);
    const unproven = await crawlRodongNews({
      homepageUrl,
      fetchImpl: unprovenFetch,
      assetDir,
      publicAssetBase: "/data/news/assets",
      now: TEST_NOW,
      maxListPages: 3,
    });
    assert.equal(unproven.stats.capReached, false);
    assert.equal(unproven.stats.listingFrontierExhausted, false);
    assert.equal(unproven.stats.categories[0].paginationProofRequired, true);
    assert.equal(unproven.stats.categories[0].paginationProofObserved, false);
    assert.equal(unproven.stats.categories[0].paginationProofMissing, true);
    assert.equal(
      unproven.stats.categories[0].frontierExhausted,
      false,
      "a Rodong page-one response without a declared total or continuation must never prove the listing frontier",
    );
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testRodongHomepageRetries() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-rodong-home-retry-"));
  const origin = "http://www.rodong.rep.kp";
  const homepageUrl = `${origin}/ko/`;
  const fallbackHomepageUrl = buildRodongHtmlFallbackUrl(homepageUrl);
  const pageToken = encodeRodongCategoryToken("1", 1);
  const listingUrl = `${origin}/index.php?${pageToken}`;
  const detailToken = rodongDetailToken("2026-08-17", "1", "030");
  const detailUrl = `${origin}/index.php?${detailToken}`;
  const homepage = () => htmlResponse(`<nav><a href="/index.php?${pageToken}">혁명활동소식</a></nav>`);
  const listing = htmlResponse(`<main>
    <div id="PathBar">홈 &gt; 혁명활동소식 &gt; 1건</div>
    <div id="RevoListDIV"><a href="/index.php?${detailToken}">홈페이지 재시도 후 받은 기사</a><time>2026.8.17.</time></div>
  </main>`);
  const detail = htmlResponse(`<main><h1>홈페이지 재시도 후 받은 기사</h1>
    <div id="articleContent"><p>공식 홈페이지 복구 후 받은 기사 본문이다.</p></div></main>`);
  const timeoutFailure = () => {
    const error = new TypeError("fetch failed");
    error.cause = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
    throw error;
  };

  try {
    let directAttempts = 0;
    let homepageSuccesses = 0;
    let fallbackAttempts = 0;
    const recoveryRequests = [];
    const recovered = await crawlRodongNews({
      homepageUrl,
      fetchImpl: fixtureFetch(new Map([
        [homepageUrl, () => {
          directAttempts += 1;
          if (directAttempts <= 4) return timeoutFailure();
          homepageSuccesses += 1;
          return homepage();
        }],
        [fallbackHomepageUrl, () => {
          fallbackAttempts += 1;
          return new Response("unprocessable", {
            status: 422,
            headers: { "Content-Type": "text/plain" },
          });
        }],
        [listingUrl, listing],
        [detailUrl, detail],
      ]), recoveryRequests),
      assetDir,
      now: TEST_NOW,
      retryDelayMs: 0,
      listingRetryAttempts: 99,
      detailConcurrency: 1,
      maxListPages: 1,
    });
    assert.equal(directAttempts, 5, "the Rodong homepage may recover on its fifth bounded attempt");
    assert.equal(fallbackAttempts, 4, "each failed official homepage attempt may exhaust its one bounded fallback");
    assert.equal(homepageSuccesses, 1, "category discovery must use exactly one successful homepage response");
    assert.equal(recovered.errors.length, 0, "transient homepage failures must not leak as final crawl errors");
    assert.equal(recovered.stats.categoriesDiscovered, 1);
    assert.equal(recovered.stats.listingPagesFetched, 1, "homepage retries must not inflate logical listing counts");
    assert.equal(recovered.stats.categories[0].pagesFetched, 1);
    assert.equal(recovered.stats.categories[0].listingErrors, 0);
    assert.equal(recovered.stats.listingFrontierExhausted, true);
    assert.equal(recovered.documents.length, 1);
    assert.equal(recoveryRequests.filter((request) => request.url === homepageUrl).length, 5);
    assert.equal(recoveryRequests.filter((request) => request.url === listingUrl).length, 1);

    let exhaustedDirectAttempts = 0;
    let exhaustedFallbackAttempts = 0;
    const exhausted = await crawlRodongNews({
      homepageUrl,
      fetchImpl: fixtureFetch(new Map([
        [homepageUrl, () => {
          exhaustedDirectAttempts += 1;
          return timeoutFailure();
        }],
        [fallbackHomepageUrl, () => {
          exhaustedFallbackAttempts += 1;
          return new Response("unprocessable", {
            status: 422,
            headers: { "Content-Type": "text/plain" },
          });
        }],
      ]), []),
      assetDir,
      now: TEST_NOW,
      retryDelayMs: 0,
      listingRetryAttempts: 99,
      maxListPages: 1,
    });
    assert.equal(exhaustedDirectAttempts, 5, "Rodong homepage retries must remain capped at five total attempts");
    assert.equal(exhaustedFallbackAttempts, 5);
    assert.equal(exhausted.errors.length, 1, "only final homepage retry exhaustion becomes a crawl error");
    assert.equal(exhausted.errors[0].stage, "homepage");
    assert.match(exhausted.errors[0].error, /official HTML failed directly and via bounded fallback/iu);
    assert.equal(exhausted.stats.categoriesDiscovered, 0);
    assert.equal(exhausted.stats.listingPagesFetched, 0);
    assert.equal(exhausted.stats.listingFrontierExhausted, false, "homepage exhaustion must remain fail-closed");
    assert.equal(exhausted.documents.length, 0);

    let permanentAttempts = 0;
    const permanent = await crawlRodongNews({
      homepageUrl,
      fetchImpl: fixtureFetch(new Map([
        [homepageUrl, () => {
          permanentAttempts += 1;
          return new Response("not found", {
            status: 404,
            headers: { "Content-Type": "text/plain" },
          });
        }],
      ]), []),
      assetDir,
      now: TEST_NOW,
      retryDelayMs: 0,
      listingRetryAttempts: 99,
      maxListPages: 1,
    });
    assert.equal(permanentAttempts, 1, "non-retryable homepage HTTP failures must not be redispatched");
    assert.equal(permanent.errors.length, 1);
    assert.equal(permanent.errors[0].stage, "homepage");
    assert.equal(permanent.stats.categoriesDiscovered, 0);
    assert.equal(permanent.stats.listingFrontierExhausted, false);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testRodongListingRetries() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-rodong-list-retry-"));
  const origin = "http://rodong-list-retry.test";
  const homepageUrl = `${origin}/ko/`;
  const firstPageToken = encodeRodongCategoryToken("1", 1);
  const secondPageToken = encodeRodongCategoryToken("1", 2);
  const firstPageUrl = `${origin}/index.php?${firstPageToken}`;
  const secondPageUrl = `${origin}/index.php?${secondPageToken}`;
  const firstDetailToken = rodongDetailToken("2026-08-17", "1", "031");
  const secondDetailToken = rodongDetailToken("2026-08-16", "1", "032");
  const firstDetailUrl = `${origin}/index.php?${firstDetailToken}`;
  const secondDetailUrl = `${origin}/index.php?${secondDetailToken}`;
  const homepage = htmlResponse(`<nav><a href="/index.php?${firstPageToken}">혁명활동소식</a></nav>`);
  const listing = (page) => htmlResponse(`<main>
    <div id="PathBar">홈 &gt; 혁명활동소식 &gt; 2건</div>
    <div id="RevoListDIV"><a href="/index.php?${page === 1 ? firstDetailToken : secondDetailToken}">
      목록 재시도 ${page}페지 기사</a><time>2026.8.${18 - page}.</time></div>
    <a href="/index.php?${page === 1 ? secondPageToken : firstPageToken}">${page === 1 ? 2 : 1}</a>
  </main>`);
  const detail = (page) => htmlResponse(`<main><h1>목록 재시도 ${page}페지 기사</h1>
    <div id="articleContent"><p>목록 재시도 후 받은 공식 본문 ${page}이다.</p></div></main>`);

  try {
    let recoveryAttempts = 0;
    const recoveryRequests = [];
    const recovered = await crawlRodongNews({
      homepageUrl,
      fetchImpl: fixtureFetch(new Map([
        [homepageUrl, homepage],
        [firstPageUrl, listing(1)],
        [secondPageUrl, () => {
          recoveryAttempts += 1;
          if (recoveryAttempts === 1) throw new TypeError("fetch failed: getaddrinfo ENOTFOUND rodong-list-retry.test");
          if (recoveryAttempts === 2) {
            const error = new TypeError("fetch failed");
            error.cause = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
            throw error;
          }
          if (recoveryAttempts === 3) throw new TypeError("fetch failed: ECONNRESET");
          if (recoveryAttempts === 4) {
            return new Response("temporary", { status: 503, headers: { "Content-Type": "text/plain" } });
          }
          return listing(2);
        }],
        [firstDetailUrl, detail(1)],
        [secondDetailUrl, detail(2)],
      ]), recoveryRequests),
      assetDir,
      now: TEST_NOW,
      retryDelayMs: 0,
      detailConcurrency: 1,
      maxListPages: 2,
    });
    assert.equal(recoveryAttempts, 5, "a Rodong logical list page may recover on its fifth bounded attempt");
    assert.equal(recovered.errors.length, 0);
    assert.equal(recovered.stats.listingPagesFetched, 2, "successful page statistics count logical pages, not retries");
    assert.equal(recovered.stats.categories[0].pagesAttempted, 2);
    assert.equal(recovered.stats.categories[0].pagesFetched, 2);
    assert.equal(recovered.stats.categories[0].listingErrors, 0);
    assert.equal(recovered.stats.categories[0].frontierExhausted, true);
    assert.equal(recovered.stats.listingFrontierExhausted, true);
    assert.equal(recovered.documents.length, 2);
    assert.equal(
      recoveryRequests.filter((request) => request.url === secondPageUrl).length,
      5,
      "retries must redispatch only the same official logical page",
    );

    let exhaustedAttempts = 0;
    const exhaustedRequests = [];
    const exhausted = await crawlRodongNews({
      homepageUrl,
      fetchImpl: fixtureFetch(new Map([
        [homepageUrl, homepage],
        [firstPageUrl, listing(1)],
        [secondPageUrl, () => {
          exhaustedAttempts += 1;
          return new Response("temporary", { status: 503, headers: { "Content-Type": "text/plain" } });
        }],
        [firstDetailUrl, detail(1)],
      ]), exhaustedRequests),
      assetDir,
      now: TEST_NOW,
      retryDelayMs: 0,
      listingRetryAttempts: 99,
      detailConcurrency: 1,
      maxListPages: 2,
    });
    assert.equal(exhaustedAttempts, 5, "Rodong listing retries must remain capped at five total attempts");
    assert.equal(exhausted.errors.length, 1, "only final retry exhaustion becomes a listing error");
    assert.equal(exhausted.errors[0].stage, "listing");
    assert.equal(exhausted.stats.listingPagesFetched, 1);
    assert.equal(exhausted.stats.categories[0].pagesAttempted, 2, "attempt statistics remain logical-page based");
    assert.equal(exhausted.stats.categories[0].pagesFetched, 1);
    assert.equal(exhausted.stats.categories[0].listingErrors, 1);
    assert.equal(exhausted.stats.categories[0].frontierExhausted, false);
    assert.equal(exhausted.stats.listingFrontierExhausted, false, "a missing list page must still fail closed");
    assert.equal(exhausted.stats.categories[0].declaredTotalMismatch, true);
    assert.equal(exhausted.stats.categories[0].declaredPageCountMismatch, true);
    assert.equal(exhausted.documents.length, 1);
    assert.equal(exhaustedRequests.filter((request) => request.url === secondPageUrl).length, 5);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testRodongOfficialListRootOrdering() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-rodong-list-root-"));
  const origin = "http://rodong-list-root.test";
  const homepageUrl = `${origin}/ko/`;
  const pageToken = encodeRodongCategoryToken("3", 1);
  const listingUrl = `${origin}/index.php?${pageToken}`;
  const firstToken = rodongDetailToken("2026-08-17", "3", "001");
  const secondToken = rodongDetailToken("2026-08-17", "3", "002");
  const firstUrl = `${origin}/index.php?${firstToken}`;
  const secondUrl = `${origin}/index.php?${secondToken}`;
  const listingHtml = `<html><main>
    <div id="PathBar">홈 &gt; 인민을 위한 정치 &gt; 2건</div>
    <aside><a href="/index.php?${secondToken}">사이드바의 잘못된 중복 제목</a><time>2026.8.17.</time></aside>
    <div id="ThemeListDIV">
      <article><a href="/index.php?${firstToken}">공식 목록 첫째 기사</a><time>2026.8.17.</time></article>
      <article><a href="/index.php?${secondToken}">공식 목록 둘째 기사</a><time>2026.8.17.</time></article>
    </div>
  </main></html>`;
  const parsed = parseRodongListing(listingHtml, listingUrl, {
    id: "anecdote",
    label: "인민을 위한 정치",
    categoryCode: "3",
  });
  assert.deepEqual(parsed.entries.map((entry) => entry.title), ["공식 목록 첫째 기사", "공식 목록 둘째 기사"]);
  assert.deepEqual(parsed.entries.map((entry) => entry.url), [firstUrl, secondUrl]);

  const requests = [];
  const fixtures = new Map([
    [homepageUrl, htmlResponse(`<nav><a href="/index.php?${pageToken}">인민을 위한 정치</a></nav>`)],
    [listingUrl, htmlResponse(listingHtml)],
    [firstUrl, htmlResponse(`<main><h1>공식 목록 첫째 기사</h1><div id="articleContent"><p>공식 첫째 기사의 본문이다.</p></div></main>`)],
    [secondUrl, htmlResponse(`<main><h1>공식 목록 둘째 기사</h1><div id="articleContent"><p>공식 둘째 기사의 본문이다.</p></div></main>`)],
  ]);
  try {
    const result = await crawlRodongNews({
      homepageUrl,
      fetchImpl: fixtureFetch(fixtures, requests),
      assetDir,
      now: TEST_NOW,
      detailConcurrency: 1,
      maxListPages: 1,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.stats.listingFrontierExhausted, true);
    assert.deepEqual(result.documents.map((document) => document.url), [firstUrl, secondUrl]);
    assert.deepEqual(result.documents.map((document) => document.title), ["공식 목록 첫째 기사", "공식 목록 둘째 기사"]);
    assert.deepEqual(result.documents.map((document) => document.categoryOrders.anecdote), [0, 1]);
    assert.deepEqual(
      requests.filter((request) => request.url === firstUrl || request.url === secondUrl).map((request) => request.url),
      [firstUrl, secondUrl],
      "an earlier sidebar duplicate must not alter official detail dispatch order",
    );
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testRodongDetailRetryCeiling() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-rodong-detail-retries-"));
  const origin = "http://rodong-detail-retries.test";
  const homepageUrl = `${origin}/ko/`;
  const pageToken = encodeRodongCategoryToken("1", 1);
  const listingUrl = `${origin}/index.php?${pageToken}`;
  const detailToken = rodongDetailToken("2026-08-17", "1", "001");
  const detailUrl = `${origin}/index.php?${detailToken}`;
  const homepage = htmlResponse(`<nav><a href="/index.php?${pageToken}">혁명활동소식</a></nav>`);
  const listing = htmlResponse(`<main><div id="PathBar">홈 &gt; 혁명활동소식 &gt; 1건</div><div id="RevoListDIV">
    <a href="/index.php?${detailToken}">다섯번째 시도에서 복구되는 기사</a><time>2026.8.17.</time>
  </div></main>`);
  try {
    let recoveryAttempts = 0;
    const recovered = await crawlRodongNews({
      homepageUrl,
      fetchImpl: fixtureFetch(new Map([
        [homepageUrl, homepage],
        [listingUrl, listing],
        [detailUrl, () => {
          recoveryAttempts += 1;
          if (recoveryAttempts < 5) throw new TypeError("fetch failed: ETIMEDOUT");
          return htmlResponse(`<main><h1>다섯번째 시도에서 복구되는 기사</h1><div id="articleContent"><p>공식 상세가 복구되였다.</p></div></main>`);
        }],
      ]), []),
      assetDir,
      now: TEST_NOW,
      retryDelayMs: 0,
      detailConcurrency: 1,
      maxListPages: 1,
    });
    assert.equal(recoveryAttempts, 5);
    assert.equal(recovered.errors.length, 0);
    assert.equal(recovered.stats.detailsFetched, 1);
    assert.equal(recovered.stats.detailRetryAttempts, 4);

    let cappedAttempts = 0;
    const capped = await crawlRodongNews({
      homepageUrl,
      fetchImpl: fixtureFetch(new Map([
        [homepageUrl, homepage],
        [listingUrl, listing],
        [detailUrl, () => {
          cappedAttempts += 1;
          throw new TypeError("fetch failed: ETIMEDOUT");
        }],
      ]), []),
      assetDir,
      now: TEST_NOW,
      retryDelayMs: 0,
      detailRetryAttempts: 99,
      detailConcurrency: 1,
      maxListPages: 1,
    });
    assert.equal(cappedAttempts, 5, "Rodong detail recovery must remain bounded to five total attempts");
    assert.equal(capped.stats.detailsUnresolved, 1);
    assert.equal(capped.errors.filter((error) => error.stage === "detail").length, 1);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testRodongExpandedInlineImageDetails() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-rodong-expanded-detail-"));
  const origin = "http://rodong-expanded-detail.test";
  const homepageUrl = `${origin}/ko/`;
  const pageToken = encodeRodongCategoryToken("1", 1);
  const listingUrl = `${origin}/index.php?${pageToken}`;
  const safeToken = rodongDetailToken("2026-02-03", "1", "021");
  const unsafeToken = rodongDetailToken("2026-02-04", "1", "022");
  const cappedToken = rodongDetailToken("2026-02-05", "1", "023");
  const safeUrl = `${origin}/index.php?${safeToken}`;
  const unsafeUrl = `${origin}/index.php?${unsafeToken}`;
  const cappedUrl = `${origin}/index.php?${cappedToken}`;
  const inlineImages = [1, 2].map((fill) => {
    const bytes = Buffer.concat([JPEG_A, Buffer.alloc(2_500, fill)]);
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  });
  const safeHtml = `<html><main><h1>대용량 공식 화상자료 기사</h1><div id="articleContent">
    <p>공식 본문에 포함된 화상자료 때문에 일반 HTML 한도를 넘는 기사이다.</p>
    ${inlineImages.map((source) => `<img src="${source}">`).join("")}
  </div></main></html>`;
  const unsafeChromeImage = `data:image/jpeg;base64,${Buffer.concat([
    JPEG_A,
    Buffer.alloc(5_000, 3),
  ]).toString("base64")}`;
  const unsafeHtml = `<html><aside><img src="${unsafeChromeImage}"></aside><main>
    <h1>페이지 장식만 큰 기사</h1><div id="articleContent"><p>기사 본문에는 화상이 없다.</p></div>
  </main></html>`;
  assert.ok(Buffer.byteLength(safeHtml) > 4_096);
  assert.ok(Buffer.byteLength(unsafeHtml) > 4_096);
  const requests = [];
  const fixtures = new Map([
    [homepageUrl, htmlResponse(`<nav><a href="/index.php?${pageToken}">혁명활동소식</a></nav>`)],
    [listingUrl, htmlResponse(`<main><div id="PathBar">홈 &gt; 혁명활동소식 &gt; 3건</div><div id="RevoListDIV">
      <a href="/index.php?${safeToken}">대용량 공식 화상자료 기사</a><time>2026.2.3.</time>
      <a href="/index.php?${unsafeToken}">페이지 장식만 큰 기사</a><time>2026.2.4.</time>
      <a href="/index.php?${cappedToken}">절대 상한을 넘는 기사</a><time>2026.2.5.</time>
    </div></main>`)],
    [safeUrl, htmlResponse(safeHtml, { "Content-Length": String(Buffer.byteLength(safeHtml)) })],
    [unsafeUrl, htmlResponse(unsafeHtml, { "Content-Length": String(Buffer.byteLength(unsafeHtml)) })],
    [cappedUrl, htmlResponse("<main><h1>절대 상한을 넘는 기사</h1></main>", {
      "Content-Length": String(16 * 1024 * 1024 + 1),
    })],
  ]);

  try {
    const result = await crawlRodongNews({
      homepageUrl,
      fetchImpl: fixtureFetch(fixtures, requests),
      cacheRemoteImages: false,
      assetDir,
      publicAssetBase: "/data/news/assets",
      now: TEST_NOW,
      htmlMaxBytes: 4_096,
      rodongDetailHtmlMaxBytes: 64 * 1024 * 1024,
      imageRetryAttempts: 0,
      detailConcurrency: 1,
      maxListPages: 1,
    });
    assert.equal(result.stats.listingFrontierExhausted, true);
    assert.equal(result.stats.detailsFetched, 1);
    assert.equal(result.stats.detailsUnresolved, 2);
    assert.equal(result.documents.length, 1);
    assert.equal(result.documents[0].url, safeUrl);
    assert.equal(result.documents[0].images.length, 2);
    assert.ok(result.documents[0].images.every((image) => image.role === "inline"));
    assert.equal(requests.filter((request) => request.url === safeUrl).length, 2);
    assert.equal(requests.filter((request) => request.url === unsafeUrl).length, 2);
    assert.equal(requests.filter((request) => request.url === cappedUrl).length, 2);
    assert.match(
      result.errors.find((error) => error.url === unsafeUrl)?.error || "",
      /not predominantly item-scoped inline image data/iu,
      "large page chrome must not justify the expanded detail allowance",
    );
    assert.match(
      result.errors.find((error) => error.url === cappedUrl)?.error || "",
      /Response exceeds 16777216 bytes/iu,
      "the Rodong detail expansion must retain its 16 MiB absolute cap",
    );
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testRodongDetailNeverUsesPartialHtmlFallback() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-rodong-authoritative-detail-"));
  const origin = "http://www.rodong.rep.kp";
  const homepageUrl = `${origin}/ko/`;
  const pageToken = encodeRodongCategoryToken("1", 1);
  const listingUrl = `${origin}/ko/index.php?${pageToken}`;
  const detailToken = rodongDetailToken("2026-02-03", "1", "021");
  const detailUrl = `${origin}/ko/index.php?${detailToken}`;
  const fallbackDetailUrl = buildRodongHtmlFallbackUrl(detailUrl);
  const sources = [1, 2, 3].map((fill) => `data:image/jpeg;base64,${Buffer.concat([
    JPEG_A,
    Buffer.alloc(2_000, fill),
  ]).toString("base64")}`);
  const fullHtml = `<html><main><h1>공식 원문의 전체 화상자료 기사</h1><div id="articleContent">
    <p>공식 원문이 제공하는 모든 화상을 보존해야 하는 기사이다.</p>
    ${sources.map((source) => `<img src="${source}">`).join("")}
  </div></main></html>`;
  const partialFallbackHtml = `<html><main><h1>공식 원문의 전체 화상자료 기사</h1><div id="articleContent">
    <p>보조 HTML에는 화상 일부만 남아있다.</p><img src="${sources[0]}">
  </div></main></html>`;
  assert.ok(Buffer.byteLength(fullHtml) > 4_096);
  assert.ok(Buffer.byteLength(partialFallbackHtml) < 4_096);
  let directDetailAttempts = 0;
  const requests = [];
  const fixtures = new Map([
    [homepageUrl, htmlResponse(`<nav><a href="/ko/index.php?${pageToken}">혁명활동소식</a></nav>`)],
    [listingUrl, htmlResponse(`<main><div id="PathBar">홈 &gt; 혁명활동소식 &gt; 1건</div><div id="RevoListDIV">
      <a href="/ko/index.php?${detailToken}">공식 원문의 전체 화상자료 기사</a><time>2026.2.3.</time>
    </div></main>`)],
    [detailUrl, () => {
      directDetailAttempts += 1;
      return htmlResponse(fullHtml, { "Content-Length": String(Buffer.byteLength(fullHtml)) });
    }],
    [fallbackDetailUrl, htmlResponse(partialFallbackHtml)],
  ]);

  try {
    const result = await crawlRodongNews({
      homepageUrl,
      fetchImpl: fixtureFetch(fixtures, requests),
      cacheRemoteImages: false,
      assetDir,
      publicAssetBase: "/data/news/assets",
      now: TEST_NOW,
      htmlMaxBytes: 4_096,
      rodongDetailHtmlMaxBytes: 32 * 1024,
      imageRetryAttempts: 0,
      detailConcurrency: 1,
      maxListPages: 1,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.stats.detailsComplete, true);
    assert.equal(result.stats.htmlFallbacks, 0);
    assert.equal(directDetailAttempts, 2, "an oversized official detail must retry directly at the expanded bound");
    assert.equal(
      requests.some((request) => request.url === fallbackDetailUrl),
      false,
      "partial auxiliary HTML must never determine or replace a Rodong detail image set",
    );
    assert.equal(result.documents.length, 1);
    assert.equal(result.documents[0].images.length, sources.length);
    assert.deepEqual(result.documents[0].images.map((image) => image.originalUrl), sources);
    assert.equal(result.stats.documentsMissingExpectedImages, 0);
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testRodongHtmlFallbackAndOfficialImageProvenance() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-rodong-html-fallback-"));
  const origin = "http://www.rodong.rep.kp";
  const homepageUrl = `${origin}/ko/`;
  const pageToken = encodeRodongCategoryToken("1", 1);
  const listingUrl = `${origin}/index.php?${pageToken}`;
  const detailToken = rodongDetailToken("2026-08-17", "1", "013");
  const detailUrl = `${origin}/index.php?${detailToken}`;
  const newsId = "2026-08-17-013";
  const imageToken = Buffer.from(
    `2@@@@p@0@2026/08/17/1/${newsId}/official-photo.jpg`,
    "utf8",
  ).toString("base64");
  const imageUrl = `${origin}/index.php?${imageToken}`;
  const fallbackHomepage = buildRodongHtmlFallbackUrl(homepageUrl);
  const fallbackListing = buildRodongHtmlFallbackUrl(listingUrl);
  const fallbackDetail = buildRodongHtmlFallbackUrl(detailUrl);
  const directFailure = () => {
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND www.rodong.rep.kp");
  };
  const requests = [];
  const fixtures = new Map([
    [homepageUrl, directFailure],
    [listingUrl, directFailure],
    [detailUrl, htmlResponse(`<html><main><h1>공식 HTML 대체 경로 기사</h1><div id="articleContent"><p>공식 원문 HTML을 복원한 기사 본문이다.</p></div></main>
      <script>$.revo_fancybox.open([{href:"index.php?${imageToken}"}]);</script></html>`)],
    [fallbackHomepage, (_url, init) => {
      assert.equal(init.headers["X-Return-Format"], "html");
      return htmlResponse(`<html><nav><a href="/index.php?${pageToken}">혁명활동소식</a></nav></html>`);
    }],
    [fallbackListing, (_url, init) => {
      assert.equal(init.headers["X-Return-Format"], "html");
      return htmlResponse(`<html><main><div id="RevoListDIV"><a href="/index.php?${detailToken}">공식 HTML 대체 경로 기사</a><time>2026.08.17.</time></div></main></html>`);
    }],
    [fallbackDetail, htmlResponse("<html><main><p>부분 보조 본문</p></main></html>")],
    [imageUrl, imageResponse(JPEG_A, "image/jpeg")],
  ]);

  try {
    const result = await crawlRodongNews({
      homepageUrl,
      fetchImpl: fixtureFetch(fixtures, requests),
      assetDir,
      publicAssetBase: "/data/news/assets",
      now: TEST_NOW,
      maxListPages: 1,
      imageRetryAttempts: 0,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.stats.htmlFallbacks, 2, "homepage and listing may use the bounded HTML fallback");
    assert.equal(result.stats.detailsComplete, true);
    assert.equal(result.documents.length, 1);
    assert.equal(result.documents[0].images.length, 1);
    assert.equal(result.documents[0].images[0].originalUrl, imageUrl, "the opaque official source endpoint must remain image provenance");
    assert.equal(requests.find((request) => request.url === imageUrl)?.init.headers.Referer, detailUrl);
    assert.deepEqual(
      requests.filter((request) => request.url.startsWith("https://r.jina.ai/")).map((request) => request.url),
      [fallbackHomepage, fallbackListing],
      "the HTML fallback must never determine detail media, binary images, or unrelated sources",
    );
    assert.equal(requests.some((request) => request.url === fallbackDetail), false);
    assert.equal(requests.filter((request) => request.url === imageUrl).length, 1, "official binary media stays on the source origin");
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testRemoteImageDescriptorMode() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-remote-images-"));
  const origin = "http://rodong-remote.test";
  const homepageUrl = `${origin}/ko/`;
  const pageToken = encodeRodongCategoryToken("1", 1);
  const listingUrl = `${origin}/index.php?${pageToken}`;
  const detailToken = rodongDetailToken("2026-08-17", "1", "021");
  const detailUrl = `${origin}/index.php?${detailToken}`;
  const remoteTokens = [1, 2].map((index) => Buffer.from(
    `02@@@u@0@2026/08/17/remote-${index}.jpg`,
    "utf8",
  ).toString("base64"));
  const remoteUrls = remoteTokens.map((token) => `${origin}/index.php?${token}`);
  const requests = [];
  const fetchImpl = fixtureFetch(new Map([
    [homepageUrl, htmlResponse(`<nav><a href="/index.php?${pageToken}">혁명활동소식</a></nav>`)],
    [listingUrl, htmlResponse(`<main><div id="RevoListDIV"><a href="/index.php?${detailToken}">원격 화상 서술자 기사</a><time>2026.08.17.</time></div></main>`)],
    [detailUrl, htmlResponse(`<main><h1>원격 화상 서술자 기사</h1><div id="articleContent">
      <p>대규모 공식 화상 자료를 내려받지 않고 원본 주소로 보존하는 기사이다.</p>
      <img src="${remoteUrls[0]}">
      <img src="data:image/png;base64,${PNG_A.toString("base64")}">
      <img data-src="${remoteUrls[1]}">
    </div></main>`)],
  ]), requests);

  try {
    const result = await crawlRodongNews({
      homepageUrl,
      fetchImpl,
      assetDir,
      publicAssetBase: "/data/news/assets",
      now: TEST_NOW,
      maxListPages: 1,
      cacheRemoteImages: false,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.stats.detailsComplete, true);
    assert.equal(result.stats.imagesCached, 1);
    assert.equal(result.stats.remoteImagesReferenced, 2);
    assert.equal(result.stats.imageQuota.cacheRemoteImages, false);
    assert.equal(result.stats.imageQuota.referencesDiscovered, 3);
    assert.equal(result.stats.imageQuota.remoteReferencesEmitted, 2);
    assert.equal(result.stats.imageQuota.requestsStarted, 1, "only the inline data image may reserve local binary budget");
    const [document] = result.documents;
    assert.equal(document.images.length, 3, "every bounded official reference must remain attached to the article");
    assert.equal(document.thumbnailUrl, remoteUrls[0], "a remote-only first image must remain usable as the thumbnail source");
    assert.deepEqual(document.images.filter((image) => !image.cachedUrl), remoteUrls.map((originalUrl) => ({
      originalUrl,
      cachedUrl: "",
      sha256: "",
      mimeType: "",
      bytes: 0,
      role: "inline",
    })));
    assert.equal(document.images.filter((image) => image.cachedUrl).length, 1, "inline data images must still be materialized locally");
    assert.equal((await fs.readdir(path.join(assetDir, "rodong-sinmun"))).length, 1);
    assert.equal(requests.some((request) => remoteUrls.includes(request.url)), false, "remote mode must not download official binary refs");
  } finally {
    await fs.rm(assetDir, { recursive: true, force: true });
  }
}

async function testRodongAjaxGalleryCrawl() {
  const assetDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-rodong-ajax-"));
  const origin = "http://rodong-ajax.test";
  const homepageUrl = `${origin}/ko/`;
  const pageToken = encodeRodongCategoryToken("1", 1);
  const listingUrl = `${origin}/index.php?${pageToken}`;
  const detailToken = rodongDetailToken("2026-08-17", "1", "013");
  const detailUrl = `${origin}/index.php?${detailToken}`;
  const ajaxUrl = `${origin}/index.php?MDVAQEBA`;
  const newsId = "2026-08-17-013";
  const imageTokens = Array.from({ length: 3 }, (_, index) => Buffer.from(
    `2@@@@p@0@2026/08/17/1/${newsId}/photo-${index + 1}.jpg`,
    "utf8",
  ).toString("base64"));
  const imageUrls = imageTokens.map((token) => `${origin}/index.php?${token}`);
  const ajaxRequests = [];
  const requests = [];
  const fixtures = new Map([
    [homepageUrl, htmlResponse(`<nav><a href="/index.php?${pageToken}">혁명활동소식</a></nav>`)],
    [listingUrl, htmlResponse(`<main><div id="PathBar">홈 &gt; 혁명활동소식 &gt; 1건</div><div id="RevoListDIV"><a href="/index.php?${detailToken}">공식 AJAX 사진묶음 기사</a><time>2026.08.17.</time></div></main>`)],
    [detailUrl, htmlResponse(`
      <main><h1>공식 AJAX 사진묶음 기사</h1><div id="articleContent" class="article-content"><p>공식 AJAX 사진묶음을 검증하는 충분한 기사 본문이다.</p></div></main>
      <script>
        var iType = 3; var iThemeID = 1;
        jQuery.ajax({type:"POST",url:"index.php?MDVAQEBA",data:"chAction=C&strSchKey=&strNewsID=${newsId}&iThemeID=1&iPhotoNo=1&iSelType="+iSelType+"&dPublish=2026-08-22&iViewWidth="+iViewWidth+"&iViewHeight="+iViewHeight});
      </script>`)],
    [ajaxUrl, (_url, init) => {
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers.Referer, detailUrl);
      assert.equal(init.headers["X-Requested-With"], "XMLHttpRequest");
      const fields = Object.fromEntries(new URLSearchParams(String(init.body || "")));
      ajaxRequests.push(fields);
      assert.deepEqual(Object.keys(fields), [
        "chAction", "strSchKey", "strNewsID", "iThemeID", "iPhotoNo",
        "iSelType", "dPublish", "iViewWidth", "iViewHeight",
      ]);
      assert.equal(fields.strSchKey, "", "official gallery requests must not inherit any search term");
      assert.equal(fields.strNewsID, newsId);
      assert.equal(fields.iSelType, "3");
      const photoNumber = Number(fields.iPhotoNo);
      if (fields.chAction === "C") {
        return htmlResponse(JSON.stringify(JSON.stringify({
          rows: [{
            iType: "3",
            strNewsID: newsId,
            strHTML: `<div class="photo-carousel"><span>1 / 3</span><img src="index.php?${imageTokens[0]}"></div>`,
            iPhotoCnt: "3",
          }],
        })));
      }
      assert.equal(fields.chAction, "P");
      assert.ok([2, 3].includes(photoNumber));
      return htmlResponse(`<div class="slide"><img src="index.php?${imageTokens[photoNumber - 1]}"></div>`);
    }],
  ]);
  imageUrls.forEach((url, index) => fixtures.set(
    url,
    imageResponse(Buffer.concat([JPEG_A, Buffer.from([index + 1])]), "image/jpeg"),
  ));

  try {
    const result = await crawlRodongNews({
      homepageUrl,
      fetchImpl: fixtureFetch(fixtures, requests),
      assetDir,
      publicAssetBase: "/data/news/assets",
      now: TEST_NOW,
      maxListPages: 2,
      imageRetryAttempts: 0,
      ajaxRetryAttempts: 0,
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.stats.detailsFetched, result.stats.entriesSelected);
    assert.equal(result.stats.listingFrontierExhausted, true);
    assert.equal(result.stats.capReached, false);
    assert.equal(result.stats.documentsWithExpectedImages, 1);
    assert.equal(result.stats.documentsMissingExpectedImages, 0);
    assert.equal(result.documents.length, 1);
    assert.deepEqual(result.documents[0].images.map((image) => image.originalUrl), imageUrls);
    assert.equal(result.documents[0].images.length, 3);
    assert.deepEqual(ajaxRequests.map((fields) => `${fields.chAction}${fields.iPhotoNo}`), ["C1", "P2", "P3"]);
    assert.equal(requests.some((request) => /MDlA/iu.test(request.url)), false, "the news gallery must never call Rodong search");
    assert.equal(result.stats.imageQuota.referencesDiscovered, 3);
    assert.equal(result.stats.imageQuota.failedReferences, 0);
    assert.equal(result.stats.imageQuota.skippedReferences, 0);
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
    [sharedDetail, htmlResponse(kcnaArticleDetailHtml(
      sharedDetail,
      "공동 기사",
      "<time>2026.08.22.</time><div class=\"article_body\"><p>두 공식 분류에 함께 게재된 기사의 본문이다.</p></div>",
    ))],
    [secondOnlyDetail, htmlResponse(kcnaArticleDetailHtml(
      secondOnlyDetail,
      "둘째 분류 기사",
      "<time>2026.08.20.</time><div class=\"article_body\"><p>뒤쪽 공식 분류에서 수집한 기사의 본문이다.</p></div>",
    ))],
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
    assert.equal(result.stats.documentCapReached, true);
    assert.equal(result.stats.capReached, true);
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

async function testNodeAddressFailoverAffinity() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><main>주소 장애조치 성공</main>");
  });
  await listenOnLoopback(server);
  const { port } = server.address();
  const attempts = [];
  const resolver = async () => [
    { address: "10.255.255.1", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  const url = `http://node-address-affinity.test:${port}/fixture`;
  try {
    const options = {
      preferNodeDirect: true,
      nodeAddressResolver: resolver,
      nodeAddressAttemptTimeoutMs: 100,
      nodeAddressAttemptObserver: ({ address }) => attempts.push(address),
      timeoutMs: 2_000,
    };
    assert.match(await fetchBoundedHtml(url, options), /주소 장애조치 성공/u);
    assert.match(await fetchBoundedHtml(url, options), /주소 장애조치 성공/u);
    assert.deepEqual(
      attempts,
      ["10.255.255.1", "127.0.0.1", "127.0.0.1"],
      "a failed address must fall through once and the working address must be preferred thereafter",
    );
  } finally {
    await closeServer(server);
  }
}

function rodongDetailToken(date, categoryCode, sequence) {
  return Buffer.from(`12@${date}-${sequence}@${categoryCode}@1@@0@1@`, "utf8").toString("base64");
}

function htmlResponse(html, headers = {}) {
  return new Response(String(html), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

function kcnaArticleDetailHtml(url, title, innerHtml) {
  return `<html><body lang="ko">
    <header><a class="active" lang="ko" href="${url}">조선어</a></header>
    <main><article><h1>${title}</h1>${innerHtml}</article></main>
  </body></html>`;
}

function kcnaMediaDetailHtml(kind, title, innerHtml = "") {
  const rootClass = kind === "photo" ? "gallery" : "video";
  return `<html><head><title>조선중앙통신 | ${title}</title></head><body lang="ko">
    <main><div class="${rootClass}"><h1>${title}</h1>${innerHtml}</div></main>
  </body></html>`;
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
