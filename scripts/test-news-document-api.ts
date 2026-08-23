#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createNewsDocumentHandler,
  newsDetailShardForId,
} from "../api/news-document.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const templateHtml = await fs.readFile(path.join(ROOT_DIR, "news/document-template.html"), "utf8");
const SAMPLE_ID = "kcna-7d168175803e5a17";

assert.equal(countOccurrences(templateHtml, "<!-- NEWS_DOCUMENT_META_START -->"), 1);
assert.equal(countOccurrences(templateHtml, "<!-- NEWS_DOCUMENT_META_END -->"), 1);
assert.match(templateHtml, /<meta name="robots" content="noindex, follow" \/>/u);
assert.match(templateHtml, /<meta property="og:image" content="https:\/\/nkarchive\.vercel\.app\/og\.png" \/>/u);

const productionHandler = createNewsDocumentHandler();
const browserResponse = invoke(productionHandler, {
  method: "GET",
  url: `/news/document?id=${SAMPLE_ID}`,
  headers: { host: "attacker.example", "user-agent": "Mozilla/5.0" },
});
const discordResponse = invoke(productionHandler, {
  method: "GET",
  url: `/news/document?id=${SAMPLE_ID}`,
  headers: { host: "attacker.example", "user-agent": "Discordbot/2.0" },
});

assert.equal(browserResponse.statusCode, 200);
assert.equal(browserResponse.headers.get("content-type"), "text/html; charset=utf-8");
assert.equal(browserResponse.headers.get("cache-control"), "public, max-age=0, s-maxage=86400");
assert.equal(browserResponse.body, discordResponse.body, "bots and browsers must receive identical metadata HTML");
assert.match(browserResponse.body, /<title>경애하는 김정은동지께서 조국해방 81돐경축 국립교예단 종합교예공연을 관람하시였다 · 북한뉴스아카이브<\/title>/u);
assert.match(browserResponse.body, /<meta property="og:type" content="article" \/>/u);
assert.match(browserResponse.body, /<meta property="og:title" content="경애하는 김정은동지께서 조국해방 81돐경축 국립교예단 종합교예공연을 관람하시였다" \/>/u);
assert.match(browserResponse.body, /<meta property="og:description" content="위대한 우리 조국의 신생을 긍지높이 떠올린 뜻깊은 날을 맞이한 인민의 기쁨과 환희가/u);
assert.doesNotMatch(browserResponse.body, /<meta property="og:description" content="\(평양 8월 17일발 조선중앙통신\)"/u);
assert.match(browserResponse.body, /<link rel="canonical" href="https:\/\/nkarchive\.vercel\.app\/news\/document\?id=kcna-7d168175803e5a17" \/>/u);
assert.match(browserResponse.body, /<meta property="og:url" content="https:\/\/nkarchive\.vercel\.app\/news\/document\?id=kcna-7d168175803e5a17" \/>/u);
assert.doesNotMatch(browserResponse.body, /attacker\.example/u);
assert.equal(countOccurrences(browserResponse.body, '<meta property="og:image" content="https://nkarchive.vercel.app/og.png" />'), 1);
assert.doesNotMatch(browserResponse.body, /<meta property="og:image" content="https:\/\/nkarchive\.vercel\.app\/data\/news\/assets/u);
assert.match(browserResponse.body, /<meta name="twitter:card" content="summary_large_image" \/>/u);
assert.match(browserResponse.body, /<meta name="twitter:image" content="https:\/\/nkarchive\.vercel\.app\/og\.png" \/>/u);
assert.match(browserResponse.body, /<meta property="article:published_time" content="2026-08-17T00:00:00\+09:00" \/>/u);
assert.doesNotMatch(browserResponse.body, /<meta name="robots"/u, "published articles must replace the generic noindex block");

const headResponse = invoke(productionHandler, {
  method: "HEAD",
  url: `/news/document?id=${SAMPLE_ID}`,
});
assert.equal(headResponse.statusCode, 200);
assert.equal(headResponse.body, "");
assert.equal(headResponse.headers.get("cache-control"), browserResponse.headers.get("cache-control"));

for (const url of [
  "/news/document",
  "/news/document?id=../../etc/passwd",
  "/news/document?id=kcna-0000000000000000",
  `/news/document?id=${SAMPLE_ID}&id=${SAMPLE_ID}`,
  `/news/document?id=${SAMPLE_ID}&utm_source=test`,
  `/news/document?%69d=${SAMPLE_ID}`,
]) {
  const response = invoke(productionHandler, { method: "GET", url });
  assert.equal(response.statusCode, 404, `invalid or unpublished article must be rejected: ${url}`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, follow");
  assert.match(response.body, /<meta name="robots" content="noindex, follow" \/>/u);
  assert.match(response.body, /<meta property="og:title" content="뉴스 기사 · 북한뉴스아카이브" \/>/u);
}

const postResponse = invoke(productionHandler, { method: "POST", url: `/news/document?id=${SAMPLE_ID}` });
assert.equal(postResponse.statusCode, 405);
assert.equal(postResponse.headers.get("allow"), "GET, HEAD");
assert.equal(postResponse.headers.get("x-robots-tag"), "noindex, follow");

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "news-document-api-"));
try {
  const articleId = "news:kcna:000000000000000000000001";
  const shard = newsDetailShardForId(articleId);
  await fs.writeFile(path.join(fixtureRoot, `${shard}.json`), JSON.stringify({
    shard,
    articles: {
      [articleId]: {
        id: articleId,
        mediaType: "article",
        title: "첫째 제목줄\n둘째 \"제목\"><script>alert(1)</script>",
        date: "2026-08-23",
        sourceName: "조선중앙통신",
        snippet: "(평양 8월 23일발 조선중앙통신)",
        body: "첫째 제목줄\n둘째 \"제목\"><script>alert(1)</script>\n(평양 8월 23일발 조선중앙통신)\n실제 <본문> & \"인용\"이 들어간 첫 문단입니다.",
      },
    },
  }));

  const fixtureHandler = createNewsDocumentHandler({ detailsRoot: fixtureRoot, templateHtml });
  const response = invoke(fixtureHandler, { method: "GET", url: `/news/document?id=${encodeURIComponent(articleId)}` });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /<meta property="og:title" content="첫째 제목줄 둘째 &quot;제목&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;" \/>/u);
  assert.match(response.body, /<meta property="og:description" content="실제 &lt;본문&gt; &amp; &quot;인용&quot;이 들어간 첫 문단입니다\." \/>/u);
  assert.doesNotMatch(response.body, /<script>alert\(1\)<\/script>/u);
  assert.match(response.body, /<link rel="canonical" href="https:\/\/nkarchive\.vercel\.app\/news\/document\?id=news%3Akcna%3A000000000000000000000001" \/>/u);

  const printArticleId = "news:rodong-sinmun:000000000000000000000001";
  const printShard = newsDetailShardForId(printArticleId);
  await fs.writeFile(path.join(fixtureRoot, `${printShard}.json`), JSON.stringify({
    shard: printShard,
    articles: {
      [printArticleId]: {
        id: printArticleId,
        mediaType: "article",
        sourceId: "rodong-sinmun",
        sourceName: "로동신문",
        title: "첫째 인쇄 제목줄\n둘째 인쇄 제목 [2면]",
        date: "2026-08-23",
        snippet: "첫째 인쇄 제목줄",
        body: "첫째 인쇄 제목줄\n둘째 인쇄 제목\n실제 인쇄 기사 본문입니다.",
      },
    },
  }));
  const printResponse = invoke(fixtureHandler, {
    method: "GET",
    url: `/news/document?id=${encodeURIComponent(printArticleId)}`,
  });
  assert.equal(printResponse.statusCode, 200);
  assert.match(printResponse.body, /<meta property="og:title" content="첫째 인쇄 제목줄 둘째 인쇄 제목 \[2면\]" \/>/u);
  assert.match(printResponse.body, /<meta property="og:description" content="실제 인쇄 기사 본문입니다\." \/>/u);
  assert.doesNotMatch(printResponse.body, /<meta property="og:description" content="첫째 인쇄 제목줄" \/>/u);

  const printOnlyArticleId = "news:rodong-sinmun:000000000000000000000002";
  const printOnlyShard = newsDetailShardForId(printOnlyArticleId);
  await fs.writeFile(path.join(fixtureRoot, `${printOnlyShard}.json`), JSON.stringify({
    shard: printOnlyShard,
    articles: {
      [printOnlyArticleId]: {
        id: printOnlyArticleId,
        mediaType: "article",
        sourceId: "rodong-sinmun",
        sourceName: "로동신문",
        title: "본문 없는 인쇄 제목 [6면]",
        date: "2026-08-23",
        snippet: "본문 없는 인쇄 제목",
        body: "본문 없는 인쇄 제목",
      },
    },
  }));
  const printOnlyResponse = invoke(fixtureHandler, {
    method: "GET",
    url: `/news/document?id=${encodeURIComponent(printOnlyArticleId)}`,
  });
  assert.equal(printOnlyResponse.statusCode, 200);
  assert.match(printOnlyResponse.body, /<meta property="og:title" content="본문 없는 인쇄 제목 \[6면\]" \/>/u);
  assert.match(printOnlyResponse.body, /<meta property="og:description" content="로동신문의 보관 기사입니다\." \/>/u);
  assert.doesNotMatch(printOnlyResponse.body, /<meta property="og:description" content="본문 없는 인쇄 제목" \/>/u);

  await fs.writeFile(path.join(fixtureRoot, `${shard}.json`), "{not valid json");
  const unavailable = invoke(fixtureHandler, { method: "GET", url: `/news/document?id=${encodeURIComponent(articleId)}` });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  assert.match(unavailable.body, /<meta name="robots" content="noindex, follow" \/>/u);
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}

assert.throws(
  () => createNewsDocumentHandler({ templateHtml: "<html><head></head></html>" }),
  /invalid_news_document_metadata_block/u,
);

console.log("News document metadata API tests passed.");

function invoke(handler, request) {
  const headers = new Map();
  const response = {
    body: undefined,
    statusCode: 200,
    setHeader(name, value) {
      headers.set(String(name).toLocaleLowerCase("en-US"), String(value));
    },
    end(body = "") {
      this.body = String(body);
    },
  };
  handler({ headers: request.headers || {}, ...request }, response);
  assert.notEqual(response.body, undefined, "handler must end every response");
  return { body: response.body, headers, statusCode: response.statusCode };
}

function countOccurrences(text, value) {
  return text.split(value).length - 1;
}
