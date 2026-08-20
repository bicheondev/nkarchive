#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [homeHtml, appSource, newsSource, css, feedText, vercelText, documentsText] = await Promise.all([
  read("index.html"),
  read("app.js"),
  read("news/news.js"),
  read("styles.css"),
  read("data/news-feed.json"),
  read("vercel.json"),
  read("data/search/documents.jsonl"),
]);
const feed = JSON.parse(feedText);
const vercel = JSON.parse(vercelText);
const documentsById = new Map(
  documentsText
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((document) => [document.id, document]),
);

assert.match(homeHtml, /<a href="\/news" data-route="news">뉴스<\/a>/u);
assert.match(homeHtml, /id="newsView"/u);
assert.match(homeHtml, /data-news-source="kcna">조선중앙통신<\/button>/u);
assert.match(homeHtml, /data-news-source="rodong-sinmun">로동신문<\/button>/u);
assert.match(appSource, /const ROUTE_NEWS = "news";/u);
assert.match(appSource, /const NEWS_PATH = "\/news";/u);
assert.match(newsSource, /"경애하는 김정은동지의 혁명활동소식"/u);
assert.match(newsSource, /"유구한 력사, 찬란한 문화"/u);
assert.match(css, /\.news-board\s*\{[\s\S]*?width: 1456px;/u);
assert.match(css, /\.news-source-switcher\s*\{[\s\S]*?width: 212px;[\s\S]*?height: 44px;/u);
assert.equal(
  vercel.rewrites.some((rewrite) => rewrite.source === "/news" && rewrite.destination === "/news/index.html"),
  true,
  "Vercel should route /news through the news entry point",
);

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
  for (const article of source.articles) {
    assert.equal(article.detailUrl, `/search/document?id=${encodeURIComponent(article.id)}`);
    assert.doesNotMatch(article.title, /\s*\[20\d{2}[./-]\d{2}[./-]\d{2}\.?\]\s*$/u);
    assert.ok(documentsById.get(article.id)?.body, `${article.id} should open an archived article body`);
  }
}

console.log(
  `News archive checks passed (${feed.sources.kcna.articles.length} KCNA, ${feed.sources["rodong-sinmun"].articles.length} Rodong articles).`,
);

function read(relativePath) {
  return fs.readFile(path.join(ROOT_DIR, relativePath), "utf8");
}
