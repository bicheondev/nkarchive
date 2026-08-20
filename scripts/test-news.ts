#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
]);
const feed = JSON.parse(feedText);
const details = JSON.parse(detailsText);
const vercel = JSON.parse(vercelText);
const documentsById = new Map(
  documentsText
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((document) => [document.id, document]),
);

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
assert.doesNotMatch(detailHtml, /id="newsDocumentImage"[^>]+src=/u);

assert.match(newsCss, /\.news-board\s*\{[\s\S]*?width: 1457px;/u);
assert.match(newsCss, /grid-template-columns: 453px 454px 454px;/u);
assert.match(newsCss, /\.news-index-main\s*\{[\s\S]*?min-height: 1222px;[\s\S]*?padding-top: 135px;/u);
assert.match(newsCss, /\.news-source-switcher\s*\{[\s\S]*?top: 1234px;[\s\S]*?width: 212px;[\s\S]*?height: 44px;/u);
assert.match(newsCss, /\.news-footer\s*\{[\s\S]*?height: 88px;/u);
assert.match(newsCss, /\.news-document-main\s*\{[\s\S]*?min-height: 1581px;[\s\S]*?padding: 135px 0 155\.084px;/u);
assert.match(newsCss, /\.news-document\s*\{[\s\S]*?width: 700px;/u);
assert.match(newsCss, /\.news-document-hero\s*\{[\s\S]*?width: 700px;[\s\S]*?height: 465\.916px;/u);
assert.match(newsCss, /\.news-document-header h1\s*\{[\s\S]*?font-size: 48px;[\s\S]*?line-height: 1\.25;/u);
assert.match(newsCss, /\.news-section-rule\s*\{[\s\S]*?height: 2px;[\s\S]*?margin-bottom: -2px;/u);
assert.match(newsCss, /\.news-slot-40 \.news-article-title\s*\{[\s\S]*?white-space: nowrap;/u);
assert.match(newsSource, /"경애하는 김정은동지의 혁명활동소식"/u);
assert.equal(newsSource.includes("news-list-image-${slot.image}"), true);
assert.match(detailSource, /data\/news-details\.json/u);
assert.match(detailSource, /formatKoreanDate/u);
assert.match(detailSource, /Object\.hasOwn\(payload\.articles, articleId\)/u);

for (const assetPath of [
  "assets/news-arrow-forward-ios.svg",
  "assets/news-search-list.svg",
  "assets/news-search-detail.svg",
  "assets/news-section-line-453.svg",
  "assets/news-section-line-454.svg",
  "assets/news-detail-hero.webp",
  ...Array.from({ length: 5 }, (_, index) => `assets/news-list-image-${index + 1}.webp`),
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

let articleCount = 0;
assert.match(feed.version, /^[a-f0-9]{16}$/u);
assert.equal(details.version, feed.version);
for (const sourceId of ["kcna", "rodong-sinmun"]) {
  const source = feed.sources[sourceId];
  assert.equal(source.id, sourceId);
  assert.ok(source.articles.length > 0, `${sourceId} should include articles`);
  assert.ok(source.articles.length <= 120, `${sourceId} should keep the lightweight article cap`);
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
    assert.equal(detail?.id, article.id);
    assert.equal(detail?.sourceId, sourceId);
    assert.ok(detail?.sourceName);
    assert.ok(detail?.body, `${article.id} should include an archived article body`);
    assert.ok(documentsById.get(article.id)?.body, `${article.id} should exist in the search archive`);
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
