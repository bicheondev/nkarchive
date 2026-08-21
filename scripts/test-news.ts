#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateNewsSnapshot } from "./generate-news-feed.ts";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [
  homeHtml,
  appSource,
  sharedCss,
  newsHtml,
  detailHtml,
  newsSource,
  detailSource,
  newsCss,
  feedText,
  detailsText,
  vercelText,
  documentsText,
  generatorSource,
  sourceConfigSource,
  crawlerSource,
  sourceCatalogText,
] = await Promise.all([
  read("index.html"),
  read("app.js"),
  read("styles.css"),
  read("news/index.html"),
  read("news/document/index.html"),
  read("news/news.js"),
  read("news/detail.js"),
  read("news/news.css"),
  read("data/news-feed.json"),
  read("data/news-details.json"),
  read("vercel.json"),
  read("data/search/documents.jsonl"),
  read("scripts/generate-news-feed.ts"),
  read("search/sourceConfig.js"),
  read("scripts/search-crawler-utils.ts"),
  read("data/search/sources.json"),
]);
const feed = JSON.parse(feedText);
const details = JSON.parse(detailsText);
const vercel = JSON.parse(vercelText);
const documents = documentsText
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const documentsById = new Map(documents.map((document) => [document.id, document]));
const sourceCatalog = JSON.parse(sourceCatalogText);

assert.match(homeHtml, /<a href="\/news">뉴스<\/a>/u);
assert.match(homeHtml, /window\.__INITIAL_ROUTE__ === "news"[\s\S]*?window\.location\.replace\("\/news"\)/u);
assert.doesNotMatch(homeHtml, /id="newsView"|\/news\/news\.js/u);
assert.doesNotMatch(appSource, /ROUTE_NEWS|NEWS_PATH|newsView|isNews/u);
assert.doesNotMatch(sharedCss, /data-route="news"|\.news-shell|\.news-board/u);

assert.match(newsHtml, /class="news-page news-index-page"/u);
assert.match(newsHtml, /id="newsBoard"/u);
assert.match(newsHtml, /data-news-source="kcna">조선중앙통신<\/button>/u);
assert.match(newsHtml, /data-news-source="rodong-sinmun">로동신문<\/button>/u);
assert.match(newsHtml, /각 기사의 저작권은 조선중앙통신 및 로동신문에게 있습니다\./u);
assert.match(detailHtml, /class="news-page news-document-page"/u);
assert.match(detailHtml, /id="newsDocument"/u);
assert.match(detailHtml, /class="news-document-hero" hidden/u);
assert.doesNotMatch(detailHtml, /id="newsDocumentImage"[^>]+src=/u);

assert.match(newsCss, /\.news-board\s*\{[\s\S]*?width: 1457px;/u);
assert.match(newsCss, /grid-template-columns: 453px 454px 454px;/u);
assert.match(newsCss, /\.news-index-main\s*\{[\s\S]*?min-height: 2523px;[\s\S]*?padding-top: 135px;/u);
assert.match(newsCss, /\.news-board\s*\{[\s\S]*?min-height: 2224px;/u);
assert.match(newsCss, /\.news-source-switcher\s*\{[\s\S]*?position: fixed;[\s\S]*?top: auto;[\s\S]*?bottom: calc\(32px \+ env\(safe-area-inset-bottom, 0px\)\);[\s\S]*?width: 212px;[\s\S]*?height: 44px;/u);
assert.match(newsCss, /@media \(max-width: 1100px\)\s*\{[\s\S]*?\.news-source-switcher\s*\{[\s\S]*?bottom: calc\(20px \+ env\(safe-area-inset-bottom, 0px\)\);/u);
assert.match(newsCss, /\.news-index-page \.news-footer\s*\{[\s\S]*?padding-bottom: calc\(80px \+ env\(safe-area-inset-bottom, 0px\)\);/u);
assert.match(newsCss, /\.news-footer\s*\{[\s\S]*?height: 88px;/u);
assert.match(newsCss, /\.news-document-main\s*\{[\s\S]*?min-height: 1581px;[\s\S]*?padding: 135px 0 155\.084px;/u);
assert.match(newsCss, /\.news-document\s*\{[\s\S]*?width: 700px;/u);
assert.match(newsCss, /\.news-document-hero\s*\{[\s\S]*?width: 700px;[\s\S]*?height: 465\.916px;/u);
assert.match(newsCss, /\.news-document-header h1\s*\{[\s\S]*?font-size: 48px;[\s\S]*?line-height: 1\.25;/u);
assert.match(newsCss, /\.news-section-rule\s*\{[\s\S]*?height: 2px;[\s\S]*?margin-bottom: -2px;/u);
assert.match(newsCss, /\.news-slot-40 \.news-article-title\s*\{[\s\S]*?white-space: nowrap;/u);
for (const sectionTitle of [
  "경애하는 김정은동지의 혁명활동소식",
  "중요소식",
  "국제소식",
  "사진",
  "혁명일화",
  "문건",
  "대외관계",
  "동화상",
  "인민은 못 잊습니다",
  "국내소식",
  "사회생활",
]) {
  assert.match(newsSource, new RegExp(sectionTitle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
}
assert.match(newsSource, /\["leadership", "important", "international", "photo"\]/u);
assert.match(newsSource, /\["anecdote", "document", "foreign", "video"\]/u);
assert.match(newsSource, /\["memory", "domestic", "social"\]/u);
assert.match(newsSource, /photo:\s*\[[\s\S]*?height: 80[\s\S]*?height: 80/u);
assert.match(newsSource, /document:\s*\[[\s\S]*?height: 40[\s\S]*?height: 62/u);
assert.match(newsSource, /const article = section\.articles\[index\];/u);
assert.doesNotMatch(newsSource, /section\.articles\[index\]\s*\|\|\s*source\.articles/u);
assert.match(newsSource, /const categorized = sorted\.filter/u);
assert.match(newsSource, /const semanticMatches = sorted\.filter/u);
assert.doesNotMatch(newsSource, /right\.score - left\.score/u);
assert.match(newsSource, /cachedThumbnailUrl|thumbnailUrl/u);
assert.match(newsSource, /fetch\(FEED_URL, \{ cache: "no-cache"/u);
assert.match(newsSource, /figure\.remove\(\);[\s\S]*?item\.classList\.remove\("has-thumbnail"\)/u);
assert.doesNotMatch(newsSource, /news-list-image-/u);
assert.match(detailSource, /data\/news-details\.json/u);
assert.match(detailSource, /formatKoreanDate/u);
assert.match(detailSource, /Object\.hasOwn\(payload\.articles, articleId\)/u);
assert.match(detailSource, /heroElement\.hidden = true;[\s\S]*?imageElement\.removeAttribute\("src"\)/u);
assert.match(detailSource, /collectArticleImages|renderGallery/u);
assert.match(detailSource, /cache: "reload"[\s\S]*?news_snapshot_mismatch/u);
assert.match(detailHtml, /id="newsDocumentGallery"/u);
assert.match(newsCss, /\.news-document-gallery/u);
assert.doesNotMatch(detailSource, /news-detail-hero/u);

for (const assetPath of [
  "assets/news-arrow-forward-ios.svg",
  "assets/news-search-list.svg",
  "assets/news-search-detail.svg",
  "assets/news-section-line-453.svg",
  "assets/news-section-line-454.svg",
]) {
  const stat = await fs.stat(path.join(ROOT_DIR, assetPath));
  assert.ok(stat.size > 0, `${assetPath} should contain the exported Figma asset`);
}

for (const [source, destination] of [
  ["/news", "/news/index.html"],
  ["/news/", "/news/index.html"],
  ["/news/document", "/news/document/index.html"],
  ["/news/document/", "/news/document/index.html"],
]) {
  assert.equal(
    vercel.rewrites.some((rewrite) => rewrite.source === source && rewrite.destination === destination),
    true,
    `Vercel should rewrite ${source} to ${destination}`,
  );
}
assert.equal(
  vercel.headers.some((entry) => entry.source === "/data/news-details.json"),
  true,
  "news detail data should use an explicit cache policy",
);
for (const dataPath of ["/data/news-feed.json", "/data/news-details.json"]) {
  const policy = vercel.headers.find((entry) => entry.source === dataPath)?.headers
    ?.find((header) => header.key === "Cache-Control")?.value;
  assert.equal(policy, "public, max-age=0, s-maxage=60, stale-while-revalidate=60");
}

let articleCount = 0;
assert.match(feed.version, /^[a-f0-9]{16}$/u);
assert.equal(details.version, feed.version);
assert.match(generatorSource, /NEWS_SNAPSHOT_SCHEMA_VERSION = 4;/u);
assert.match(generatorSource, /createArticleMediaIndex|archiveUrl|displayOrder/u);
assert.match(generatorSource, /KCNA_ARTICLE_CATEGORY_LIMITS/u);
assert.match(generatorSource, /--documents|--feed-out|--details-out|--check/u);
assert.match(sourceConfigSource, /\/article\/list\/b0721b9f23054ddc7fe56c2811a12715/u);
assert.match(sourceConfigSource, /\/gallery\/list\/6837a75abf5c6249d0e39ee758e763ea/u);
assert.match(sourceConfigSource, /\/video\/list\/6837a75abf5c6249d0e39ee758e763ea/u);
assert.match(sourceConfigSource, /article\\\/\(\?:q\|detail\)/u);
assert.match(crawlerSource, /news-category:\$\{category\}/u);
assert.match(crawlerSource, /gallery\\\/detail|video\\\/detail/u);
assert.deepEqual(sourceCatalog.find((source) => source.id === "kcna")?.mediaTypes, ["article", "image", "video"]);
const expectedSnapshot = generateNewsSnapshot(documents);
assert.equal(feedText, expectedSnapshot.feedText, "news-feed.json should be the exact generated snapshot");
assert.equal(detailsText, expectedSnapshot.detailsText, "news-details.json should be the exact generated snapshot");
const categoryOutsideLatestWindow = {
  id: "kcna-category-outside-latest-window",
  title: "오래된 문건 분류 기사",
  snippet: "문건 분류 보존 검사",
  body: "문건 분류에 속한 기사가 최신 120건 밖에 있어도 뉴스 화면 자료 집합에는 포함되어야 한다.",
  date: "2020-01-01",
  sourceId: "kcna",
  sourceName: "조선중앙통신",
  sourceType: "official_site",
  mediaType: "article",
  url: "https://kcna.example/article/category-window",
  archiveUrl: "",
  thumbnailUrl: "",
  cachedThumbnailUrl: "",
  language: "ko",
  aliases: ["news-category:document"],
};
const categoryWindowFixture = [
  ...Array.from({ length: 120 }, (_, index) => ({
    ...categoryOutsideLatestWindow,
    id: `kcna-latest-${String(index).padStart(3, "0")}`,
    title: `최신 기사 ${index}`,
    date: "2026-08-21",
    url: `https://kcna.example/article/latest-${index}`,
    aliases: [],
  })),
  categoryOutsideLatestWindow,
  {
    ...categoryOutsideLatestWindow,
    id: "rodong-category-window-fixture",
    sourceId: "rodong-sinmun",
    sourceName: "로동신문",
    url: "https://rodong.example/article/fixture",
    aliases: [],
  },
];
const categoryWindowSnapshot = generateNewsSnapshot(categoryWindowFixture);
assert.equal(categoryWindowSnapshot.feed.sources.kcna.articles.length, 120);
assert.equal(
  categoryWindowSnapshot.feed.sources.kcna.articles.some((article) => article.id === categoryOutsideLatestWindow.id),
  true,
  "KCNA category quota candidates outside the latest 120 articles must remain selectable",
);
for (const sourceId of ["kcna", "rodong-sinmun"]) {
  const source = feed.sources[sourceId];
  assert.equal(source.id, sourceId);
  assert.ok(source.articles.length > 0, `${sourceId} should include articles`);
  assert.ok(source.articles.length <= 168, `${sourceId} should keep the lightweight article and media caps`);
  assert.deepEqual(
    source.articles.map((article) => article.date),
    [...source.articles].map((article) => article.date).sort().reverse(),
    `${sourceId} should be newest first`,
  );
  articleCount += source.articles.length;
  for (const article of source.articles) {
    assert.equal(
      article.detailUrl,
      `/news/document?id=${encodeURIComponent(article.id)}&v=${encodeURIComponent(feed.version)}`,
    );
    assert.doesNotMatch(article.title, /\s*\[20\d{2}[./-]\d{2}[./-]\d{2}\.?\]\s*$/u);
    const detail = details.articles[article.id];
    const sourceDocument = documentsById.get(article.id);
    assert.equal(detail?.id, article.id);
    assert.equal(detail?.sourceId, sourceId);
    assert.ok(detail?.sourceName);
    assert.ok(detail?.body, `${article.id} should include an archived article body`);
    assert.ok(sourceDocument?.body, `${article.id} should exist in the search archive`);
    assert.equal(article.title, cleanArticleTitle(sourceDocument?.title));
    assert.equal(article.date, String(sourceDocument?.date || ""));
    assert.equal(article.snippet, String(sourceDocument?.snippet || ""));
    assert.equal(article.url, String(sourceDocument?.url || ""));
    assert.equal(article.mediaType, ["image", "video"].includes(sourceDocument?.mediaType) ? sourceDocument.mediaType : "article");
    assert.equal(article.hasImage, Array.isArray(detail.images) && detail.images.length > 0);
    assert.equal(article.hasVideo, detail.mediaType === "video" || (Array.isArray(detail.videos) && detail.videos.length > 0));
    assert.equal(typeof article.thumbnailUrl, "string");
    assert.equal(typeof article.cachedThumbnailUrl, "string");
    assert.equal(detail.title, cleanArticleTitle(sourceDocument?.title));
    assert.equal(detail.date, String(sourceDocument?.date || ""));
    assert.equal(detail.snippet, String(sourceDocument?.snippet || ""));
    assert.equal(detail.body, String(sourceDocument?.body || ""));
    assert.equal(detail.url, String(sourceDocument?.url || ""));
    assert.equal(detail.thumbnailUrl, article.thumbnailUrl);
    assert.equal(detail.cachedThumbnailUrl, article.cachedThumbnailUrl);
    assert.ok(Array.isArray(detail.images));
    assert.ok(Array.isArray(detail.videos));
    for (const image of detail.images) {
      assert.ok(image.cachedUrl || image.cachedThumbnailUrl || image.url || image.thumbnailUrl);
      assert.doesNotMatch(JSON.stringify(image), /^data:|blob:/iu);
      const imageDocument = documentsById.get(image.id);
      if (imageDocument?.mediaType === "image") {
        assert.equal(imageDocument.sourceId, sourceId);
        assert.equal(imageDocument.archiveUrl, sourceDocument.url);
      }
    }
    assert.doesNotMatch(JSON.stringify(article), /\/assets\/news-(?:detail-hero|list-image-)/u);
    assert.doesNotMatch(JSON.stringify(detail), /\/assets\/news-(?:detail-hero|list-image-)/u);
    assert.doesNotMatch(article.thumbnailUrl, /\/newsf\.gif(?:$|[?#])/iu);
    assert.doesNotMatch(detail.thumbnailUrl, /\/newsf\.gif(?:$|[?#])/iu);
  }
}
assert.equal(Object.keys(details.articles).length, articleCount);
assert.equal(details.generatedAt, feed.generatedAt);

console.log(
  `News archive checks passed (${feed.sources.kcna.articles.length} KCNA, ${feed.sources["rodong-sinmun"].articles.length} Rodong articles, ${articleCount} detail bodies).`,
);

function read(relativePath) {
  return fs.readFile(path.join(ROOT_DIR, relativePath), "utf8");
}

function cleanArticleTitle(value) {
  return String(value || "")
    .replace(/\s*\[20\d{2}[./-]\d{2}[./-]\d{2}\.?\]\s*$/u, "")
    .trim();
}
