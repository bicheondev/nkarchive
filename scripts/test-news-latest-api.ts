#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createNewsLatestHandler,
} from "../api/news-latest.js";
import { KCNA_CATEGORY_LISTS } from "./news-mirror-crawler.ts";

const NOW = new Date("2026-08-25T01:02:03.000Z");
const KCNA_FEED_URL = `http://www.kcna.kp/kp/article/detail/${"a".repeat(32)}`;
const KCNA_INDEXED_URL = `http://www.kcna.kp/kp/article/detail/${"b".repeat(32)}`;
const KCNA_NEW_URL = `http://www.kcna.kp/kp/article/detail/${"c".repeat(32)}`;
const CACHED_THUMBNAIL = `/data/news/assets/kcna/${"d".repeat(64)}.jpg`;
const STATIC_FEED = {
  sources: {
    kcna: {
      articles: [{
        id: "kcna-aaaaaaaaaaaaaaaa",
        title: "정적 피드 기사",
        date: "2026-08-23",
        snippet: "정적 설명",
        url: KCNA_FEED_URL,
        mediaType: "article",
        categories: ["important"],
        categoryOrders: { important: 0 },
        featuredSections: ["important"],
        hasImage: false,
        hasVideo: false,
        thumbnailUrl: "",
        cachedThumbnailUrl: "",
      }],
    },
    "rodong-sinmun": { articles: [] },
  },
};
const STATIC_SEARCH_INDEX = {
  articles: [{
    id: "kcna-bbbbbbbbbbbbbbbb",
    sourceId: "kcna",
    sourceName: "조선중앙통신",
    title: "전체 색인에만 있는 기사",
    date: "2026-08-24",
    snippet: "색인 설명",
    url: KCNA_INDEXED_URL,
    thumbnailUrl: `http://www.kcna.kp/photo/${"e".repeat(64)}`,
    cachedThumbnailUrl: CACHED_THUMBNAIL,
  }],
};

await testLiveKcnaMergeAndBounds();
await testCompleteKcnaMode();
await testKcnaJinaFallbackBounds();
await testFallbackAndHttpContract();
await testOverallRefreshDeadline();
await testRodongFixedOriginAndArchiveMatch();
await testRodongJinaFallbackBounds();

console.log("News latest API tests passed.");

async function testLiveKcnaMergeAndBounds() {
  const calls = [];
  const fetchHtmlImpl = async (url, options) => {
    calls.push({ url, options });
    assert.match(url, /^http:\/\/www\.kcna\.kp\/kp\/(?:article|gallery|video)\/list\/[a-f0-9]{32}$/u);
    assert.ok(options.timeoutMs <= 3_500 && options.timeoutMs >= 100);
    assert.ok(options.htmlMaxBytes <= 768 * 1024);
    assert.ok(options.maxRedirects <= 2);
    if (!url.includes("b0721b9f23054ddc7fe56c2811a12715")) return "<main></main>";
    return `
      <main>
        <div class="article"><h5 class="block">
          <a href="/kp/article/detail/${"b".repeat(32)}">색인보다 새 목록 제목</a>
          <span>[2026.08.24.]</span>
        </h5></div>
        <div class="article">
          <a href="/kp/article/detail/${"c".repeat(32)}"><img src="/photo/${"f".repeat(64)}">처음 본 기사<i class="camera-icon" title="사진"></i></a>
          <time>[2026.08.25.]</time>
        </div>
      </main>`;
  };
  const handler = createNewsLatestHandler({
    fetchHtmlImpl,
    staticFeed: STATIC_FEED,
    staticSearchIndex: STATIC_SEARCH_INDEX,
    now: () => NOW,
  });
  const response = await invoke(handler, { method: "GET", url: "/api/news-latest?source=kcna" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "public, max-age=0, s-maxage=300, stale-while-revalidate=3600");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(calls.length, 11, "only the eleven fixed KCNA first listing pages may be requested");
  assert.deepEqual(Object.keys(response.json.sources), ["kcna"]);
  assert.equal(response.json.schemaVersion, 1);
  assert.equal(response.json.generatedAt, NOW.toISOString());
  assert.equal(response.json.sources.kcna.mode, "degraded", "partial fixed-category success must be explicit");

  const byUrl = new Map(response.json.sources.kcna.articles.map((article) => [article.url, article]));
  const indexed = byUrl.get(KCNA_INDEXED_URL);
  assert.equal(indexed.archived, true, "the full archive index must identify published rows omitted from the homepage feed");
  assert.equal(indexed.id, "kcna-bbbbbbbbbbbbbbbb", "legacy KCNA archive ids must remain valid");
  assert.equal(indexed.detailUrl, "/news/document?id=kcna-bbbbbbbbbbbbbbbb");
  assert.equal(indexed.cachedThumbnailUrl, CACHED_THUMBNAIL);
  assert.deepEqual(indexed.categories, ["leadership"]);
  assert.deepEqual(indexed.categoryOrders, { leadership: 0 });
  assert.deepEqual(indexed.featuredSections, ["leadership"]);
  assert.equal(indexed.sourceId, "kcna");
  assert.equal(indexed.sourceName, "조선중앙통신");

  const fresh = byUrl.get(KCNA_NEW_URL);
  assert.equal(fresh.archived, false);
  assert.equal(
    fresh.id,
    `news:kcna:${createHash("sha256").update(KCNA_NEW_URL).digest("hex").slice(0, 24)}`,
  );
  assert.equal(fresh.detailUrl, KCNA_NEW_URL, "an unpublished listing must open its fixed official URL, not a missing archive page");
  assert.equal(fresh.thumbnailUrl, "", "unpublished HTTP thumbnails must not be exposed on the HTTPS site");
  assert.equal(fresh.cachedThumbnailUrl, "");
  assert.equal(fresh.hasImage, true);
  assert.deepEqual(fresh.categoryOrders, { leadership: 1 });
  assert.deepEqual(fresh.featuredSections, ["leadership"]);

  const staticArticle = byUrl.get(KCNA_FEED_URL);
  assert.equal(staticArticle.archived, true, "the live response must retain bounded static fallback rows");
  assert.equal(staticArticle.sourceId, "kcna");
}

async function testCompleteKcnaMode() {
  let calls = 0;
  const handler = createNewsLatestHandler({
    fetchHtmlImpl: async (url) => {
      calls += 1;
      if (url.includes("/gallery/list/")) {
        return `<main><div class="gallery">
          <a href="/kp/gallery/detail/${"2".repeat(32)}"><img alt="최신 사진 기사"></a>
          <h5>최신 사진 기사 <span>[2026.08.25.]</span></h5>
        </div></main>`;
      }
      if (url.includes("/video/list/")) {
        return `<main><div class="video">
          <a href="/kp/video/detail/${"3".repeat(32)}"><img alt="최신 동영상 기사"></a>
          <h5>최신 동영상 기사 <span>[2026.08.25.]</span></h5>
        </div></main>`;
      }
      return `<main><div class="article"><a href="/kp/article/detail/${"4".repeat(32)}">최신 일반 기사</a>
        <time>[2026.08.25.]</time></div></main>`;
    },
    staticFeed: { sources: {} },
    staticSearchIndex: { articles: [] },
    now: () => NOW,
  });
  const response = await invoke(handler, { method: "GET", url: "/api/news-latest?source=kcna" });
  assert.equal(calls, 11);
  assert.equal(response.json.sources.kcna.mode, "live", "all fixed category listings must be required for fully live mode");
  assert.deepEqual(
    new Set(response.json.sources.kcna.articles.flatMap((article) => article.categories)),
    new Set(["leadership", "important", "international", "photo", "anecdote", "document", "foreign", "video", "memory", "domestic", "social"]),
  );
}

async function testKcnaJinaFallbackBounds() {
  const officialUrls = new Set(KCNA_CATEGORY_LISTS.map((category) => category.url));
  const calls = [];
  let activeDirects = 0;
  let maximumDirects = 0;
  let activeFallbacks = 0;
  let maximumFallbacks = 0;
  const handler = createNewsLatestHandler({
    fetchHtmlImpl: async (url, options) => {
      calls.push({ url, options });
      if (officialUrls.has(url)) {
        assert.equal(options.timeoutMs, 3_500);
        assert.equal(options.htmlMaxBytes, 768 * 1024);
        assert.equal(options.maxRedirects, 2);
        assert.equal(options.extraHeaders, undefined);
        activeDirects += 1;
        maximumDirects = Math.max(maximumDirects, activeDirects);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          throw new Error("direct KCNA route unavailable");
        } finally {
          activeDirects -= 1;
        }
      }
      assert.ok(url.startsWith("https://r.jina.ai/http://www.kcna.kp/"), `unexpected KCNA fallback URL: ${url}`);
      const officialUrl = url.slice("https://r.jina.ai/".length);
      assert.ok(officialUrls.has(officialUrl), `fallback target must be one of the eleven fixed listings: ${officialUrl}`);
      assert.equal(options.timeoutMs, 6_000);
      assert.equal(options.htmlMaxBytes, 768 * 1024);
      assert.equal(options.maxRedirects, 2);
      assert.deepEqual(options.extraHeaders, { "X-Return-Format": "html" });
      activeFallbacks += 1;
      maximumFallbacks = Math.max(maximumFallbacks, activeFallbacks);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        if (officialUrl.includes("/gallery/list/")) {
          return `<main><div class="gallery">
            <a href="/kp/gallery/detail/${"5".repeat(32)}"><img alt="KCNA HTML 대체경로 사진"></a>
            <h5>KCNA HTML 대체경로 사진 <span>[2026.08.25.]</span></h5>
          </div></main>`;
        }
        if (officialUrl.includes("/video/list/")) {
          return `<main><div class="video">
            <a href="/kp/video/detail/${"6".repeat(32)}"><img alt="KCNA HTML 대체경로 영상"></a>
            <h5>KCNA HTML 대체경로 영상 <span>[2026.08.25.]</span></h5>
          </div></main>`;
        }
        return `<main><div class="article">
          <a href="/kp/article/detail/${"7".repeat(32)}">KCNA HTML 대체경로 기사</a>
          <time>[2026.08.25.]</time>
        </div></main>`;
      } finally {
        activeFallbacks -= 1;
      }
    },
    staticFeed: { sources: {} },
    staticSearchIndex: { articles: [] },
    now: () => NOW,
  });
  const response = await invoke(handler, { method: "GET", url: "/api/news-latest?source=kcna" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.sources.kcna.mode, "live");
  assert.equal(calls.length, KCNA_CATEGORY_LISTS.length * 2);
  assert.equal(maximumDirects, 3, "official KCNA requests must share a three-request concurrency ceiling");
  assert.equal(maximumFallbacks, 3, "Jina fallbacks must share a three-request concurrency ceiling");
  assert.deepEqual(
    new Set(calls.filter((call) => call.url.startsWith("https://r.jina.ai/")).map((call) => call.url)),
    new Set(KCNA_CATEGORY_LISTS.map((category) => `https://r.jina.ai/${category.url}`)),
  );
}

async function testFallbackAndHttpContract() {
  let calls = 0;
  const handler = createNewsLatestHandler({
    fetchHtmlImpl: async () => {
      calls += 1;
      throw new Error("upstream unavailable");
    },
    staticFeed: STATIC_FEED,
    staticSearchIndex: STATIC_SEARCH_INDEX,
    now: () => NOW,
  });
  const fallback = await invoke(handler, { method: "GET", url: "/api/news-latest?source=kcna" });
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.json.sources.kcna.mode, "fallback");
  assert.deepEqual(fallback.json.sources.kcna.articles.map((article) => article.id), ["kcna-aaaaaaaaaaaaaaaa"]);
  assert.ok(calls > 0);

  const beforeHead = calls;
  const head = await invoke(handler, { method: "HEAD", url: "/api/news-latest?source=kcna" });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers["cache-control"], fallback.headers["cache-control"]);
  assert.equal(calls, beforeHead, "HEAD must not contact either upstream");

  const post = await invoke(handler, { method: "POST", url: "/api/news-latest?source=kcna" });
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  assert.equal(post.headers["cache-control"], "no-store");
  assert.equal(calls, beforeHead);

  for (const url of [
    "/api/news-latest?source=both",
    "/api/news-latest?source=kcna&extra=1",
    "/api/news-latest?source=kcna&source=kcna",
    "/api/news-latest?%73ource=kcna",
    "/api/news-latest?source=kcna&",
  ]) {
    const invalid = await invoke(handler, { method: "GET", url });
    assert.equal(invalid.statusCode, 400, `noncanonical query must be rejected: ${url}`);
    assert.equal(invalid.json.error, "invalid_news_latest_query");
    assert.equal(invalid.headers["cache-control"], "no-store");
  }
  assert.equal(calls, beforeHead, "invalid cache-key variants must not contact an upstream");

  const both = await invoke(handler, { method: "GET", url: "/api/news-latest" });
  assert.deepEqual(Object.keys(both.json.sources), ["kcna", "rodong-sinmun"]);
  assert.equal(both.json.sources.kcna.mode, "fallback");
  assert.equal(both.json.sources["rodong-sinmun"].mode, "fallback");
}

async function testOverallRefreshDeadline() {
  let starts = 0;
  const handler = createNewsLatestHandler({
    refreshSourceImpl: () => {
      starts += 1;
      return new Promise(() => {});
    },
    refreshDeadlineMs: 5,
    staticFeed: STATIC_FEED,
    staticSearchIndex: STATIC_SEARCH_INDEX,
    now: () => NOW,
  });
  const startedAt = Date.now();
  const response = await invoke(handler, { method: "GET", url: "/api/news-latest" });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 100, `both source refreshes must share the overall response deadline: ${elapsedMs}ms`);
  assert.equal(starts, 2);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.sources.kcna.mode, "fallback");
  assert.equal(response.json.sources["rodong-sinmun"].mode, "fallback");

  const synchronousFailure = createNewsLatestHandler({
    refreshSourceImpl: () => { throw new Error("synchronous refresh failure"); },
    refreshDeadlineMs: 20,
    staticFeed: STATIC_FEED,
    staticSearchIndex: STATIC_SEARCH_INDEX,
    now: () => NOW,
  });
  const failed = await invoke(synchronousFailure, { method: "GET", url: "/api/news-latest?source=kcna" });
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.json.sources.kcna.mode, "fallback");
  assert.throws(
    () => createNewsLatestHandler({ refreshDeadlineMs: 24_001 }),
    /invalid_news_latest_refresh_deadline/u,
  );
}

async function testRodongFixedOriginAndArchiveMatch() {
  const categoryToken = encodeRodongCategoryToken("1", 1);
  const detailToken = Buffer.from("12@2026-08-25-001@1@1@@0@1@", "utf8").toString("base64");
  const detailUrl = `http://www.rodong.rep.kp/ko/index.php?${detailToken}`;
  const calls = [];
  const fetchHtmlImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok([
      "http://www.rodong.rep.kp",
      "https://r.jina.ai",
    ].includes(new URL(url).origin), `unexpected upstream origin: ${url}`);
    assert.ok(options.timeoutMs <= 6_000);
    assert.ok(options.htmlMaxBytes <= 4 * 1024 * 1024);
    assert.ok(options.maxRedirects <= 2);
    if (url === "http://www.rodong.rep.kp/ko/") {
      return `<nav><a href="/ko/index.php?${categoryToken}">혁명활동소식</a></nav>`;
    }
    if (url === `http://www.rodong.rep.kp/ko/index.php?${categoryToken}`) {
      return `<main><div id="RevoListDIV"><ul><li>
        <a href="/ko/index.php?${detailToken}">로동신문 최신 기사</a>
        <time>2026.8.25.</time>
      </li></ul></div></main>`;
    }
    throw new Error("unexpected fixture URL");
  };
  const handler = createNewsLatestHandler({
    fetchHtmlImpl,
    staticFeed: STATIC_FEED,
    staticSearchIndex: {
      articles: [{
        id: `news:rodong-sinmun:${"1".repeat(24)}`,
        sourceId: "rodong-sinmun",
        sourceName: "로동신문",
        title: "로동신문 최신 기사",
        date: "2026-08-25",
        snippet: "기사 설명",
        url: detailUrl,
        thumbnailUrl: "",
        cachedThumbnailUrl: "",
      }],
    },
    now: () => NOW,
  });
  const response = await invoke(handler, { method: "GET", url: "/api/news-latest?source=rodong-sinmun" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.sources["rodong-sinmun"].mode, "degraded");
  assert.equal(response.json.sources["rodong-sinmun"].articles[0].archived, true);
  assert.equal(response.json.sources["rodong-sinmun"].articles[0].detailUrl, `/news/document?id=${encodeURIComponent(`news:rodong-sinmun:${"1".repeat(24)}`)}`);
  assert.deepEqual(response.json.sources["rodong-sinmun"].articles[0].categoryOrders, { leadership: 0 });
  assert.deepEqual(calls.map((call) => call.url), [
    "http://www.rodong.rep.kp/ko/",
    `http://www.rodong.rep.kp/ko/index.php?${categoryToken}`,
  ]);
}

async function testRodongJinaFallbackBounds() {
  const categoryToken = encodeRodongCategoryToken("1", 1);
  const detailToken = Buffer.from("12@2026-08-25-002@1@1@@0@1@", "utf8").toString("base64");
  const officialHomepage = "http://www.rodong.rep.kp/ko/";
  const officialListing = `http://www.rodong.rep.kp/ko/index.php?${categoryToken}`;
  const expectedFallbacks = new Map([
    [`https://r.jina.ai/${officialHomepage}`, `<nav><a href="/ko/index.php?${categoryToken}">혁명활동소식</a></nav>`],
    [`https://r.jina.ai/${officialListing}`, `<main><div id="RevoListDIV"><ul><li>
      <a href="/ko/index.php?${detailToken}">고정된 HTML 대체경로 기사</a><time>2026.8.25.</time>
    </li></ul></div></main>`],
  ]);
  const calls = [];
  const handler = createNewsLatestHandler({
    fetchHtmlImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith("http://www.rodong.rep.kp/")) {
        assert.equal(options.timeoutMs, 4_000);
        assert.equal(options.htmlMaxBytes, 4 * 1024 * 1024);
        assert.equal(options.extraHeaders, undefined);
        throw new Error("direct official route unavailable");
      }
      assert.ok(expectedFallbacks.has(url), `fallback must use only the exact fixed Jina URL: ${url}`);
      assert.equal(options.timeoutMs, 6_000);
      assert.equal(options.htmlMaxBytes, 4 * 1024 * 1024);
      assert.equal(options.maxRedirects, 2);
      assert.deepEqual(options.extraHeaders, { "X-Return-Format": "html" });
      return expectedFallbacks.get(url);
    },
    staticFeed: { sources: {} },
    staticSearchIndex: { articles: [] },
    now: () => NOW,
  });
  const response = await invoke(handler, { method: "GET", url: "/api/news-latest?source=rodong-sinmun" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.sources["rodong-sinmun"].mode, "degraded");
  assert.equal(response.json.sources["rodong-sinmun"].articles[0].title, "고정된 HTML 대체경로 기사");
  assert.deepEqual(calls.map((call) => call.url), [
    officialHomepage,
    `https://r.jina.ai/${officialHomepage}`,
    officialListing,
    `https://r.jina.ai/${officialListing}`,
  ]);
}

function encodeRodongCategoryToken(categoryCode, page) {
  return Buffer.from(`1@@${categoryCode}@${page}@`, "utf8").toString("base64");
}

async function invoke(handler, request) {
  const response = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[String(name).toLocaleLowerCase("en-US")] = String(value);
    },
    end(value = "") {
      this.body = String(value);
    },
  };
  await handler(request, response);
  assert.notEqual(response.body, undefined, "handler must end every response");
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    json: response.body ? JSON.parse(response.body) : null,
  };
}
