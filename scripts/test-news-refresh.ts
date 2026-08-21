#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertFreshNewsSources,
  assertKcnaDesignCategoryCoverage,
  assertKcnaMediaPreviewCoverage,
  assertMirroredPreviewCoverage,
  enrichCandidateWithInlineImages,
  fetchArticleHtml,
  hasSubstantialArticleBody,
  inlineSameOriginRemoteImages,
  isValidExplicitDocumentDate,
  loadNewsInlineImageHelper,
  mergeDocumentQuality,
  mergeNewsMirrorDocuments,
  refreshNewsMirror,
} from "./refresh-news-mirror.ts";
import { extractDocumentFromHtml } from "./search-crawler-utils.ts";
import { SEARCH_SOURCES } from "../search/sourceConfig.js";

const TEST_NOW = new Date("2026-08-21T12:00:00.000Z");
const SUBSTANTIAL_BODY = [
  "첫 문단에서는 새로 진행된 사업의 구체적인 내용과 현장 상황을 상세히 전하고 있다.",
  "둘째 문단에서는 참가자들의 발언과 앞으로의 계획을 충분한 분량으로 설명하고 있다.",
  "마지막 문단에는 사업이 주민 생활에 미칠 영향과 후속 조치가 정리되어 있다.",
].join("\n\n");

function makeDocument({
  id,
  sourceId = "kcna",
  sourceName = sourceId === "kcna" ? "조선중앙통신" : "로동신문",
  host = sourceId === "kcna" ? "kcna.test" : "rodong.test",
  title = `${sourceName} 기사`,
  snippet = "기사의 핵심 내용을 설명하는 요약문",
  body = SUBSTANTIAL_BODY,
  date = "2026-08-20",
  cachedUrl = "",
  cachedThumbnailUrl = "",
  mediaType = "article",
} = {}) {
  return {
    id,
    title,
    snippet,
    date,
    sourceId,
    sourceName,
    sourceType: "official_site",
    displaySourceId: sourceId,
    displaySourceName: sourceName,
    displaySourceType: "official_site",
    mediaType,
    url: `https://${host}/article/${encodeURIComponent(id)}`,
    archiveUrl: "",
    originalSourceUrl: "",
    thumbnailUrl: "",
    cachedUrl,
    cachedThumbnailUrl,
    language: "ko",
    aliases: [],
    body,
    searchSnippet: "",
    searchBody: "",
    previewText: "",
    previewSourceName: "",
    previewDocumentId: "",
    searchTabs: mediaType === "image" ? ["all", "image"] : [],
  };
}

function makeReport(sourceId, overrides = {}) {
  return {
    sourceId,
    fetched: 2,
    indexed: 2,
    timedOut: false,
    errors: [],
    ...overrides,
  };
}

function jsonl(documents) {
  return `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`;
}

function lineForSource(text, sourceId) {
  return text.split("\n").find((line) => line && JSON.parse(line).sourceId === sourceId) || "";
}

function buildSnapshot(documents) {
  const selected = Object.fromEntries(["kcna", "rodong-sinmun"].map((sourceId) => [
    sourceId,
    documents
      .filter((document) => document.sourceId === sourceId && document.mediaType === "article" && document.language === "ko")
      .sort((left, right) => right.date.localeCompare(left.date))
      .slice(0, 120),
  ]));
  const newestDate = Object.values(selected).flat().map((document) => document.date).sort().at(-1);
  const version = `fixture-${Object.values(selected).flat().map((document) => document.id).join("-")}`;
  const feed = {
    generatedAt: `${newestDate}T00:00:00.000Z`,
    version,
    sources: {
      kcna: {
        id: "kcna",
        name: "조선중앙통신",
        articles: selected.kcna.map((document) => ({ id: document.id })),
      },
      "rodong-sinmun": {
        id: "rodong-sinmun",
        name: "로동신문",
        articles: selected["rodong-sinmun"].map((document) => ({ id: document.id })),
      },
    },
  };
  const details = {
    generatedAt: feed.generatedAt,
    version,
    articles: Object.fromEntries(Object.values(selected).flat().map((document) => [
      document.id,
      { id: document.id, body: document.body },
    ])),
  };
  return {
    feedText: `${JSON.stringify(feed, null, 2)}\n`,
    detailsText: `${JSON.stringify(details, null, 2)}\n`,
  };
}

async function writeFixtureRepository(rootDir) {
  const documents = [
    makeDocument({ id: "kcna-existing" }),
    makeDocument({ id: "rodong-existing", sourceId: "rodong-sinmun" }),
    makeDocument({ id: "other-existing", sourceId: "other", sourceName: "기타 출처", host: "other.test" }),
  ];
  const sources = [
    {
      id: "kcna",
      name: "조선중앙통신",
      sourceType: "official_site",
      baseUrl: "https://kcna.test/",
      languages: ["ko"],
      mediaTypes: ["article", "image"],
      aliases: [],
      searchTabs: [],
      crawler: { enabled: true, entryUrl: "https://kcna.test/", strategy: "html", schedule: "daily", robotsPolicy: "respect" },
    },
    {
      id: "rodong-sinmun",
      name: "로동신문",
      sourceType: "official_site",
      baseUrl: "https://rodong.test/",
      languages: ["ko"],
      mediaTypes: ["article", "image"],
      aliases: [],
      searchTabs: [],
      crawler: { enabled: true, entryUrl: "https://rodong.test/", strategy: "html", schedule: "daily", robotsPolicy: "respect" },
    },
    {
      id: "other",
      name: "기타 출처",
      sourceType: "official_site",
      baseUrl: "https://other.test/",
      languages: ["ko"],
      mediaTypes: ["article"],
      aliases: [],
      searchTabs: [],
      crawler: { enabled: true, entryUrl: "https://other.test/", strategy: "html", schedule: "manual", robotsPolicy: "respect" },
    },
  ];
  const health = {
    generatedAt: "2026-08-20T00:00:00.000Z",
    summary: {
      totalSources: 3,
      searchableSources: 3,
      healthySources: 3,
      warningSources: 0,
      unreachableSources: 0,
      totalDocuments: 3,
    },
    sources: sources.map((source) => ({
      sourceId: source.id,
      sourceName: source.name,
      indexedDocuments: 1,
      status: "indexed",
    })),
  };
  const snapshot = buildSnapshot(documents);
  await Promise.all([
    fs.mkdir(path.join(rootDir, "scripts"), { recursive: true }),
    fs.mkdir(path.join(rootDir, "search"), { recursive: true }),
    fs.mkdir(path.join(rootDir, "data/search"), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(rootDir, "package.json"), '{"private":true,"type":"module"}\n', "utf8"),
    fs.writeFile(path.join(rootDir, "scripts/generate-news-feed.ts"), "// test fixture generator\n", "utf8"),
    fs.writeFile(path.join(rootDir, "data/search/documents.jsonl"), jsonl(documents), "utf8"),
    fs.writeFile(path.join(rootDir, "data/search/sources.json"), `${JSON.stringify(sources, null, 2)}\n`, "utf8"),
    fs.writeFile(path.join(rootDir, "data/search/source-health.json"), `${JSON.stringify(health, null, 2)}\n`, "utf8"),
    fs.writeFile(path.join(rootDir, "data/news-feed.json"), snapshot.feedText, "utf8"),
    fs.writeFile(path.join(rootDir, "data/news-details.json"), snapshot.detailsText, "utf8"),
  ]);
  return { documents };
}

async function writeGeneratedSnapshot(cwd) {
  const text = await fs.readFile(path.join(cwd, "data/search/documents.jsonl"), "utf8");
  const documents = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const snapshot = buildSnapshot(documents);
  await fs.mkdir(path.join(cwd, "data"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(cwd, "data/news-feed.json"), snapshot.feedText, "utf8"),
    fs.writeFile(path.join(cwd, "data/news-details.json"), snapshot.detailsText, "utf8"),
  ]);
}

async function testQualityMergeAndSourceIsolation() {
  const existingKcna = makeDocument({
    id: "kcna-existing",
    cachedUrl: "/data/search/assets/kcna/article.html",
    cachedThumbnailUrl: "/data/search/assets/kcna/photo.jpg",
  });
  const existingRodong = makeDocument({ id: "rodong-existing", sourceId: "rodong-sinmun" });
  const incomingThinReplacement = {
    ...existingKcna,
    snippet: "짧은 요약",
    body: "제목과 목록만 있는 짧은 본문",
    cachedUrl: "",
    cachedThumbnailUrl: "",
  };
  const validNew = makeDocument({ id: "kcna-new", date: "2026-08-21" });
  const invalidDate = makeDocument({ id: "kcna-invalid-date", date: "2026-02-30" });
  const thinNew = makeDocument({ id: "kcna-thin", body: "짧은 목록 본문" });
  const failedSourceNew = makeDocument({ id: "rodong-untrusted", sourceId: "rodong-sinmun", date: "2026-08-21" });
  const result = mergeNewsMirrorDocuments({
    existingDocuments: [existingKcna, existingRodong],
    importedDocuments: [incomingThinReplacement, validNew, invalidDate, thinNew, existingRodong, failedSourceNew],
    importReport: {
      preservedSourceIds: ["rodong-sinmun"],
      reports: [
        makeReport("kcna", { indexed: 4 }),
        makeReport("rodong-sinmun", { timedOut: true, errors: ["network timeout"] }),
      ],
    },
    now: TEST_NOW,
  });

  const mergedExisting = result.documents.find((document) => document.id === existingKcna.id);
  assert.equal(mergedExisting.body, existingKcna.body, "a thin refresh body must not replace the richer body");
  assert.equal(mergedExisting.cachedUrl, existingKcna.cachedUrl, "cached article URL must be preserved");
  assert.equal(mergedExisting.cachedThumbnailUrl, existingKcna.cachedThumbnailUrl, "cached image URL must be preserved");
  assert.ok(result.documents.some((document) => document.id === validNew.id), "a valid new article should be appended");
  assert.ok(!result.documents.some((document) => document.id === invalidDate.id), "an impossible explicit date must be rejected");
  assert.ok(!result.documents.some((document) => document.id === thinNew.id), "a thin listing body must be rejected");
  assert.ok(!result.documents.some((document) => document.id === failedSourceNew.id), "a failed source must not append new records");
  assert.deepEqual(
    result.documents.filter((document) => document.sourceId === "rodong-sinmun"),
    [existingRodong],
    "the failed source must remain byte-serializable from its original objects",
  );
  assert.equal(result.sourceResults.find((source) => source.sourceId === "rodong-sinmun").status, "preserved");
}

function testDateAndBodyGates() {
  assert.equal(isValidExplicitDocumentDate("2026-02-29", { now: TEST_NOW }), false);
  assert.equal(isValidExplicitDocumentDate("2026-08-22", { now: TEST_NOW }), true);
  assert.equal(isValidExplicitDocumentDate("2026-08-23", { now: TEST_NOW }), false);
  assert.equal(hasSubstantialArticleBody(makeDocument({ id: "body-check" })), true);
  assert.equal(hasSubstantialArticleBody(makeDocument({ id: "listing", body: "오늘호 기사 분야별기사 검색 결과" })), false);

  const existing = makeDocument({ id: "kcna-newest", date: "2026-08-20" });
  const regression = mergeNewsMirrorDocuments({
    existingDocuments: [existing],
    importedDocuments: [makeDocument({ id: "kcna-older", date: "2026-08-19" })],
    importReport: { reports: [makeReport("kcna"), makeReport("rodong-sinmun")] },
    now: TEST_NOW,
  });
  const result = regression.sourceResults.find((source) => source.sourceId === "kcna");
  assert.equal(result.status, "preserved");
  assert.match(result.reason, /regressed/u);
  assert.deepEqual(regression.documents, [existing]);
}

function testRodongDirectArticlePreservesFullBodyAndExplicitDate() {
  const source = SEARCH_SOURCES.find((candidate) => candidate.id === "rodong-sinmun");
  assert.ok(source, "the Rodong source configuration must exist");
  const paragraph = "생산현장에서는 새로운 설비를 도입하고 공정별 기술지표를 높이기 위한 사업을 힘있게 추진하고있다.";
  const paragraphs = Array.from({ length: 24 }, (_, index) => (
    `<p class="TextP">${index + 1}. ${paragraph}</p>`
  )).join("");
  const datedUrl = `http://www.rodong.rep.kp/ko/index.php?${Buffer.from("8@2026-08-20-001@fixture").toString("base64")}`;
  const datedHtml = `<html><body>
    <div id="article-homepage">2026년 8월 20일</div>
    <p class="TitleP">새 설비도입과 생산공정의 현대화를 힘있게</p>
    ${paragraphs}
    <p class="WriterP">본사기자</p>
  </body></html>`;
  const document = extractDocumentFromHtml(datedHtml, datedUrl, source, {});
  assert.ok(document, "a structured Rodong detail page should be indexed");
  assert.equal(document.date, "2026-08-20");
  assert.equal(document.body.length > 900, true, "the former 900-character truncation must not return");
  assert.match(document.body, /24\. 생산현장/u, "the last source paragraph must survive direct extraction");
  assert.match(document.body, /본사기자/u, "the source writer line must survive direct extraction");

  const undatedUrl = "http://www.rodong.rep.kp/ko/index.php?OEA=";
  const undated = extractDocumentFromHtml(
    datedHtml.replace("<div id=\"article-homepage\">2026년 8월 20일</div>", ""),
    undatedUrl,
    source,
    {},
  );
  assert.ok(undated);
  assert.equal(undated.date, "", "a missing official date must not be replaced with the crawl date");
}

function testUnknownFieldsSurviveQualityMerge() {
  const existing = { ...makeDocument({ id: "kcna-fields" }), importerMetadata: { kept: true } };
  const incoming = { ...existing, body: `${SUBSTANTIAL_BODY}\n${SUBSTANTIAL_BODY}`, importerMetadata: undefined };
  const merged = mergeDocumentQuality(existing, incoming);
  assert.deepEqual(merged.importerMetadata, existing.importerMetadata);
  assert.equal(merged.body, incoming.body);

  const chrome = mergeDocumentQuality(existing, {
    ...incoming,
    body: "오늘호 기사 분야별기사 검색 결과 ".repeat(1000),
  });
  assert.equal(chrome.body, existing.body, "even a very long listing body must not replace a substantial article body");
}

async function testInlineImageHook() {
  const article = makeDocument({
    id: "kcna-inline",
    cachedThumbnailUrl: "/data/search/assets/kcna/existing-lead.png",
  });
  const video = {
    ...makeDocument({ id: "kcna-video", mediaType: "video" }),
    url: "https://kcna.test/video/kcna-video.mp4",
    archiveUrl: "https://kcna.test/gallery/detail/kcna-video",
  };
  const result = await enrichCandidateWithInlineImages({
    documents: [article, video],
    healthySourceIds: new Set(["kcna"]),
    stagedAssetDir: path.join(os.tmpdir(), "unused-news-assets"),
    helper: {
      async enrichNewsArticleWithInlineImages({ article: input }) {
        const imageDocument = makeDocument({ id: `${input.id}-image`, mediaType: "image" });
        return {
          article: { ...input, cachedThumbnailUrl: "/data/search/assets/kcna/hash.png" },
          imageDocuments: [{
            ...imageDocument,
            url: input.url,
            archiveUrl: input.url,
            cachedUrl: "/data/search/assets/kcna/hash.png",
            cachedThumbnailUrl: "/data/search/assets/kcna/hash.png",
          }],
          images: [{ publicUrl: "/data/search/assets/kcna/hash.png" }],
        };
      },
    },
    fetchHtmlImpl: async () => "<main><p>article</p></main>",
  });
  assert.equal(
    result.documents.find((document) => document.id === article.id).cachedThumbnailUrl,
    article.cachedThumbnailUrl,
    "an existing lead image remains preferred while the full gallery is added",
  );
  assert.ok(result.documents.some((document) => document.id === `${article.id}-image`));
  assert.ok(result.documents.some((document) => document.id === `${video.id}-image`));
  assert.equal(result.report.mirroredImages, 2);
  assert.equal(result.report.fetchedArticles, 2);
  assert.equal(result.report.completedDetails, 2);
  assert.deepEqual(
    assertMirroredPreviewCoverage(result.documents, {
      sourceIds: new Set(["kcna"]),
      minimumCounts: { kcna: 2 },
    }),
    [{ sourceId: "kcna", previewCount: 2, minimum: 2 }],
  );

  const rodongPreviewDocuments = Array.from({ length: 5 }, (_, index) => makeDocument({
    id: `rodong-preview-${index}`,
    sourceId: "rodong-sinmun",
    cachedThumbnailUrl: `/data/search/assets/rodong-sinmun/${String(index).padStart(64, "a")}.jpg`,
  }));
  assert.equal(
    assertMirroredPreviewCoverage(rodongPreviewDocuments, { sourceIds: new Set(["rodong-sinmun"]) })[0].previewCount,
    5,
  );
  assert.throws(
    () => assertMirroredPreviewCoverage(rodongPreviewDocuments.slice(0, 4), { sourceIds: new Set(["rodong-sinmun"]) }),
    /at least 5 are required/u,
  );

  await assert.rejects(
    enrichCandidateWithInlineImages({
      documents: [article],
      healthySourceIds: new Set(["kcna"]),
      stagedAssetDir: path.join(os.tmpdir(), "unused-news-assets"),
      helper: { enrichNewsArticleWithInlineImages: async () => ({ article }) },
      fetchHtmlImpl: async () => { throw new Error("blocked upstream"); },
    }),
    /could not fetch any kcna article HTML/u,
  );

  const missingPath = path.join(os.tmpdir(), `missing-news-image-helper-${process.pid}.ts`);
  assert.equal(await loadNewsInlineImageHelper(missingPath), null);
  await assert.rejects(loadNewsInlineImageHelper(missingPath, { required: true }), /helper is missing/u);
}

async function testHtmlFallbackAndRemoteImageMaterialization() {
  const calls = [];
  const html = await fetchArticleHtml("https://kcna.test/article/fallback", {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), headers: options.headers });
      if (calls.length === 1) throw new Error("official host unavailable");
      return new Response('<main><img src="/photo/hash"></main>', {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  assert.match(html, /\/photo\/hash/u);
  assert.equal(calls[1].url, "https://r.jina.ai/https://kcna.test/article/fallback");
  assert.equal(calls[1].headers["X-Return-Format"], "html");

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const materialized = await inlineSameOriginRemoteImages({
    html: '<main><img src="/photo/hash"><img src="/assets/logo.png"><img src="blob:forbidden"><img src="https://outside.test/photo"></main>',
    documentUrl: "https://kcna.test/gallery/detail/example",
    fetchImageImpl: async (url) => {
      assert.equal(url, "https://kcna.test/photo/hash");
      return png;
    },
  });
  assert.equal(materialized.inlined, 1);
  assert.match(materialized.html, /data:;base64,/u);
  assert.match(materialized.html, /blob:forbidden/u, "blob URLs are never fetched or materialized");
  assert.match(materialized.html, /https:\/\/outside\.test\/photo/u, "cross-origin images are never fetched");
}

function testFreshnessGate() {
  const fresh = [
    makeDocument({ id: "fresh-kcna", date: "2026-08-18" }),
    makeDocument({ id: "fresh-rodong", sourceId: "rodong-sinmun", date: "2026-08-17" }),
  ];
  assert.deepEqual(
    assertFreshNewsSources(fresh, { now: TEST_NOW, maxAgeDays: 4 }).map((result) => result.ageDays),
    [3, 4],
  );
  assert.throws(
    () => assertFreshNewsSources([
      fresh[0],
      makeDocument({ id: "stale-rodong", sourceId: "rodong-sinmun", date: "2026-08-16" }),
    ], { now: TEST_NOW, maxAgeDays: 4 }),
    /News mirror is stale for rodong-sinmun/u,
  );
}

function testKcnaDesignCategoryGate() {
  const requirements = {
    leadership: { mediaType: "article", count: 2 },
    photo: { mediaType: "image", count: 1 },
    video: { mediaType: "video", count: 1 },
  };
  const records = [
    makeDocument({ id: "kcna-leadership-1" }),
    makeDocument({ id: "kcna-leadership-2" }),
    makeDocument({ id: "kcna-photo", mediaType: "image" }),
    makeDocument({ id: "kcna-video-gate", mediaType: "video" }),
  ];
  records[0].aliases = ["news-category:leadership"];
  records[1].aliases = ["news-category:leadership"];
  records[2].aliases = ["news-category:photo"];
  records[3].aliases = ["news-category:video"];
  records[2].cachedThumbnailUrl = `/data/search/assets/kcna/${"b".repeat(64)}.jpg`;
  records[3].cachedThumbnailUrl = `/data/search/assets/kcna/${"c".repeat(64)}.jpg`;
  assert.equal(assertKcnaDesignCategoryCoverage(records, { requirements }).length, 3);
  assert.throws(
    () => assertKcnaDesignCategoryCoverage(records.slice(0, -1), { requirements }),
    /0\/1 KCNA video video/u,
  );
  assert.equal(
    assertKcnaMediaPreviewCoverage(records, { requirements: { photo: 1, video: 1 } }).length,
    2,
  );
  assert.throws(
    () => assertKcnaMediaPreviewCoverage(records, { requirements: { photo: 2, video: 1 } }),
    /photo has only 1\/2/u,
  );
}

async function testTransactionalRefresh({ failPromotion = false } = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-news-refresh-test-"));
  try {
    const fixture = await writeFixtureRepository(rootDir);
    const originalDocumentsText = await fs.readFile(path.join(rootDir, "data/search/documents.jsonl"), "utf8");
    const originalHealthText = await fs.readFile(path.join(rootDir, "data/search/source-health.json"), "utf8");
    const originalFeedText = await fs.readFile(path.join(rootDir, "data/news-feed.json"), "utf8");
    const originalDetailsText = await fs.readFile(path.join(rootDir, "data/news-details.json"), "utf8");
    let importerSawFullSeed = false;
    let importerSawIsolatedNewsSeed = false;
    const runImporterImpl = async ({ outputPath, reportPath }) => {
      const seeded = (await fs.readFile(outputPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      importerSawFullSeed = seeded.length === fixture.documents.length;
      const originalIds = new Set(fixture.documents.map((document) => document.id));
      importerSawIsolatedNewsSeed = seeded
        .filter((document) => ["kcna", "rodong-sinmun"].includes(document.sourceId))
        .every((document) => !originalIds.has(document.id) && document.id.startsWith("__news_refresh_seed_v1__"));
      const imported = [
        ...seeded,
        makeDocument({ id: "kcna-new", date: "2026-08-21" }),
        makeDocument({ id: "rodong-failed-new", sourceId: "rodong-sinmun", date: "2026-08-21" }),
      ];
      await fs.writeFile(outputPath, jsonl(imported), "utf8");
      await fs.writeFile(reportPath, `${JSON.stringify({
        preservedSourceIds: ["rodong-sinmun"],
        reports: [
          makeReport("kcna", { indexed: 2 }),
          makeReport("rodong-sinmun", { timedOut: true, errors: ["timeout"] }),
        ],
      })}\n`, "utf8");
    };
    const runCommandImpl = async (command, args, { cwd }) => {
      if (command === process.execPath) {
        await writeGeneratedSnapshot(cwd);
        return { code: 0 };
      }
      assert.equal(command, "npm");
      assert.deepEqual(args, ["run", "generate:news"]);
      if (failPromotion) return { code: 1 };
      await writeGeneratedSnapshot(cwd);
      return { code: 0 };
    };

    if (failPromotion) {
      await assert.rejects(
        refreshNewsMirror({ rootDir, runImporterImpl, runCommandImpl, now: TEST_NOW, categoryRequirements: {} }),
        /generation failed after document promotion/u,
      );
      assert.equal(await fs.readFile(path.join(rootDir, "data/search/documents.jsonl"), "utf8"), originalDocumentsText);
      assert.equal(await fs.readFile(path.join(rootDir, "data/search/source-health.json"), "utf8"), originalHealthText);
      assert.equal(await fs.readFile(path.join(rootDir, "data/news-feed.json"), "utf8"), originalFeedText);
      assert.equal(await fs.readFile(path.join(rootDir, "data/news-details.json"), "utf8"), originalDetailsText);
      return;
    }

    const result = await refreshNewsMirror({
      rootDir,
      runImporterImpl,
      runCommandImpl,
      now: TEST_NOW,
      categoryRequirements: {},
    });
    assert.equal(importerSawFullSeed, true, "the importer must be seeded with the complete current document corpus");
    assert.equal(importerSawIsolatedNewsSeed, true, "seed IDs must be distinguishable from genuinely crawled IDs");
    assert.equal(result.promoted, true);
    const promotedText = await fs.readFile(path.join(rootDir, "data/search/documents.jsonl"), "utf8");
    const promoted = promotedText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(promoted.some((document) => document.id === "kcna-new"));
    assert.ok(!promoted.some((document) => document.id === "rodong-failed-new"));
    assert.equal(
      lineForSource(promotedText, "rodong-sinmun"),
      lineForSource(originalDocumentsText, "rodong-sinmun"),
      "a failed source row must remain byte-identical",
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function main() {
  await testQualityMergeAndSourceIsolation();
  testDateAndBodyGates();
  testRodongDirectArticlePreservesFullBodyAndExplicitDate();
  testUnknownFieldsSurviveQualityMerge();
  await testInlineImageHook();
  await testHtmlFallbackAndRemoteImageMaterialization();
  testFreshnessGate();
  testKcnaDesignCategoryGate();
  await testTransactionalRefresh();
  await testTransactionalRefresh({ failPromotion: true });
  console.log("News refresh checks passed (quality merge, source isolation, inline images, transactional promotion). ");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
