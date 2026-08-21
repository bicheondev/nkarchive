#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNewsSnapshot, parseNewsDocumentsJsonl } from "./news-snapshot.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const read = (relativePath) => fs.readFile(path.join(ROOT_DIR, relativePath), "utf8");

const [documentsText, feedText, detailsText, indexHtml, documentHtml, newsJs, detailJs, newsCss] = await Promise.all([
  read("data/news/documents.jsonl"),
  read("data/news-feed.json"),
  read("data/news-details.json"),
  read("news/index.html"),
  read("news/document/index.html"),
  read("news/news.js"),
  read("news/detail.js"),
  read("news/news.css"),
]);

const documents = parseNewsDocumentsJsonl(documentsText, "data/news/documents.jsonl");
const feed = JSON.parse(feedText);
const details = JSON.parse(detailsText);
const expected = buildNewsSnapshot(documents, { requireQuotaReady: false });
assert.equal(feedText, expected.feedText, "news feed must be generated only from data/news/documents.jsonl");
assert.equal(detailsText, expected.detailsText, "news details must be generated only from data/news/documents.jsonl");
assert.equal(feed.version, details.version);
assert.equal(feed.generatedAt, details.generatedAt);
assert.match(feed.version, /^[a-f0-9]{16}$/u);

for (const sourceId of ["kcna", "rodong-sinmun"]) {
  const source = feed.sources[sourceId];
  assert.ok(source && Array.isArray(source.articles) && source.articles.length, `${sourceId} feed must not be empty`);
  for (const article of source.articles) {
    assert.equal(Object.hasOwn(details.articles, article.id), true, `${article.id} must have standalone details`);
    assert.equal(/^\s*(?:조선중앙통신|KCNA)\s*\|/iu.test(article.title), false, "source chrome must not appear in titles");
    assert.equal(
      article.detailUrl,
      `/news/document?id=${encodeURIComponent(article.id)}`,
      `${article.id} must use a snapshot-independent detail URL`,
    );
    for (const localUrl of [article.cachedThumbnailUrl].filter(Boolean)) assertNewsAssetUrl(localUrl);
  }

  for (const section of new Set(source.articles.flatMap((article) => article.categories || []))) {
    const sectionArticles = source.articles.filter((article) => article.categories?.includes(section));
    const dates = sectionArticles.map((article) => article.date);
    assert.deepEqual(dates, [...dates].sort().reverse(), `${sourceId}/${section} must be newest first`);
    assert.equal(new Set(sectionArticles.map((article) => article.id)).size, sectionArticles.length, `${sourceId}/${section} must not repeat ids`);
  }
}

for (const article of Object.values(details.articles)) {
  assert.equal(article.sourceId === "kcna" || article.sourceId === "rodong-sinmun", true);
  for (const record of [article, ...(article.images || [])]) {
    for (const localUrl of [record.cachedUrl, record.cachedThumbnailUrl].filter(Boolean)) {
      assertNewsAssetUrl(localUrl);
      await assertAssetIntegrity(localUrl);
    }
  }
}

const standaloneSources = [indexHtml, documentHtml, newsJs, detailJs];
for (const source of standaloneSources) {
  assert.equal(/(?:href|src)=["']\/search|data\/search|api\/search|meilisearch/iu.test(source), false, "news runtime must not depend on Search");
}
assert.match(indexHtml, /id="newsSearchInput"/u, "news search must be a page-local filter");
assert.equal(newsJs.includes("localStorage"), false, "KCNA must be the deterministic default source");
assert.match(newsJs, /let activeSourceId = "kcna"/u);
assert.equal(newsJs.includes("appendHighlightedTitle"), false, "article names must not receive person-specific bold markup");
assert.equal(newsJs.includes("createElement(\"strong\")"), false);
assert.equal(newsJs.includes("patterns:"), false, "official categories must never be filled by title-keyword guessing");
assert.equal(newsJs.includes("latest-day"), false, "Rodong today articles must come from the exact official category");
assert.match(
  newsJs,
  /kcna:\s*\[\s*\["leadership", "important", "international", "photo"\],\s*\["anecdote", "document", "foreign", "video"\],\s*\["memory", "domestic", "social"\],\s*\]/u,
  "KCNA must keep the exact eleven Figma sections in their three columns",
);
assert.match(
  newsJs,
  /"rodong-sinmun":\s*\[\s*\["leadership", "important", "photo"\],\s*\["anecdote", "domestic", "video"\],\s*\["memory", "social"\],\s*\]/u,
  "Rodong Sinmun must render only its official standalone section buckets",
);
const rodongDefinitionsMatch = newsJs.match(/"rodong-sinmun":\s*\{([\s\S]*?)\n\s*\},\n\s*\};/u);
assert.ok(rodongDefinitionsMatch, "Rodong Sinmun section definitions must be present");
const rodongDefinitions = rodongDefinitionsMatch[1];
assert.doesNotMatch(
  rodongDefinitions,
  /^\s*(?:international|document|foreign):/mu,
  "Rodong Sinmun must not define invented empty sections",
);
assert.match(newsJs, /const sectionColumns = SECTION_COLUMNS\[activeSourceId\]/u);
assert.match(newsJs, /sectionColumns\.forEach\(\(sectionIds, columnIndex\)/u);
assert.match(newsCss, /\.news-source-switcher\s*\{[\s\S]*?position:\s*fixed/u, "source selector must remain floating");
assert.match(newsCss, /bottom:\s*calc\(32px \+ env\(safe-area-inset-bottom, 0px\)\)/u);

console.log(`Standalone news tests passed: ${documents.length} records, version ${feed.version}.`);

function assertNewsAssetUrl(value) {
  assert.match(
    String(value),
    /^\/data\/news\/assets\/(?:kcna|rodong-sinmun)\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u,
    "cached news media must use the standalone news asset namespace",
  );
}

async function assertAssetIntegrity(publicUrl) {
  const filePath = path.join(ROOT_DIR, publicUrl);
  const bytes = await fs.readFile(filePath);
  const expectedHash = path.basename(filePath).split(".", 1)[0];
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(actualHash, expectedHash, `${publicUrl} must be content-addressed`);
}
