#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertNewsFreshness,
  flattenCrawledNewsDocuments,
  refreshNewsMirror,
} from "./refresh-news-mirror.ts";
import {
  NEWS_DOCUMENT_SCHEMA_VERSION,
  canonicalizeNewsDocument,
  stringifyNewsDocumentsJsonl,
} from "./news-snapshot.ts";

const fixtureBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const fixtureHash = createHash("sha256").update(fixtureBytes).digest("hex");
const fixtureAsset = `/data/news/assets/rodong-sinmun/${fixtureHash}.jpg`;
const stagedOrphanBytes = Buffer.from([...fixtureBytes, 0x01]);
const stagedOrphanHash = createHash("sha256").update(stagedOrphanBytes).digest("hex");
const existingOrphanBytes = Buffer.from([...fixtureBytes, 0x02]);
const existingOrphanHash = createHash("sha256").update(existingOrphanBytes).digest("hex");

const nested = {
  documents: [{
    id: "news:rodong-sinmun:fixture001",
    sourceId: "rodong-sinmun",
    sourceName: "로동신문",
    category: { id: "today", label: "오늘호 기사" },
    categories: [{ id: "social-culture", label: "사회문화생활" }],
    kind: "article",
    title: "독립 뉴스 수집 시험 기사",
    date: "2026-08-22",
    url: "http://www.rodong.rep.kp/ko/index.php?fixture",
    body: "검색 인덱스를 거치지 않고 공식 상세면에서 직접 보관한 기사 본문이다.",
    thumbnailUrl: fixtureAsset,
    images: [{ sha256: fixtureHash, cachedUrl: fixtureAsset, originalUrl: "", role: "inline" }],
  }],
};
const completeRodongDocuments = createCompleteRodongFixtureDocuments();

const flattened = flattenCrawledNewsDocuments(nested);
assert.equal(flattened.length, 2);
assert.deepEqual(flattened[0].categories, ["important", "memory"]);
assert.equal(flattened[0].cachedThumbnailUrl, fixtureAsset);
assert.equal(flattened[1].articleId, flattened[0].id);
assert.equal(flattened[1].cachedUrl, fixtureAsset);
assert.deepEqual(
  assertNewsFreshness(flattened, { sourceIds: ["rodong-sinmun"], maxAgeDays: 4, now: "2026-08-22T12:00:00Z" }),
  { "rodong-sinmun": { newest: "2026-08-22", ageDays: 0, maxAgeDays: 4 } },
);
assert.throws(
  () => assertNewsFreshness(flattened, { sourceIds: ["rodong-sinmun"], maxAgeDays: 1, now: "2026-08-25T00:00:00Z" }),
  /stale/u,
);

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "standalone-news-refresh-test-"));
try {
  const crawlImpl = async (options) => {
    const output = path.join(options.assetDir, "rodong-sinmun", `${fixtureHash}.jpg`);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, fixtureBytes);
    await fs.writeFile(path.join(path.dirname(output), `${stagedOrphanHash}.jpg`), stagedOrphanBytes);
    return {
      generatedAt: "2026-08-22T12:00:00.000Z",
      sources: {
        kcna: { documents: [], errors: [], stats: {} },
        "rodong-sinmun": {
          documents: completeRodongDocuments,
          errors: [],
          stats: { detailsFetched: completeRodongDocuments.length, imagesCached: 2 },
        },
      },
      documents: completeRodongDocuments,
    };
  };
  const sparseCrawlImpl = async () => ({
    generatedAt: "2026-08-22T12:00:00.000Z",
    sources: {
      kcna: { documents: [], errors: [], stats: {} },
      "rodong-sinmun": { documents: nested.documents, errors: [], stats: { detailsFetched: 1 } },
    },
    documents: nested.documents,
  });
  await assert.rejects(
    refreshNewsMirror({
      rootDir,
      now: "2026-08-22T12:00:00Z",
      maxAgeDays: 4,
      kcna: false,
      crawlImpl: sparseCrawlImpl,
    }),
    /rodong-sinmun\/leadership 0\/6/u,
    "a fresh Rodong head must not hide an empty official category crawl",
  );
  const reportPath = path.join(rootDir, "report.json");
  const existingOrphanPath = path.join(rootDir, "data/news/assets/rodong-sinmun", `${existingOrphanHash}.jpg`);
  await fs.mkdir(path.dirname(existingOrphanPath), { recursive: true });
  await fs.writeFile(existingOrphanPath, existingOrphanBytes);
  const legacyUnclassified = canonicalizeNewsDocument({
    schemaVersion: NEWS_DOCUMENT_SCHEMA_VERSION,
    id: "news:rodong-sinmun:legacy-unclassified",
    sourceId: "rodong-sinmun",
    sourceName: "로동신문",
    language: "ko",
    mediaType: "article",
    title: "이전 검색 결과에서 넘어온 무분류 기사",
    date: "2026-08-20",
    url: "http://www.rodong.rep.kp/ko/index.php?legacy-unclassified",
    snippet: "공식 분류가 없어 새 뉴스 미러에서는 제거해야 하는 기사이다.",
    body: "공식 분류가 없어 새 뉴스 미러에서는 제거해야 하는 기사이다.",
    categories: [],
    cachedThumbnailUrl: `/data/news/assets/rodong-sinmun/${existingOrphanHash}.jpg`,
  });
  const documentsPath = path.join(rootDir, "data/news/documents.jsonl");
  await fs.mkdir(path.dirname(documentsPath), { recursive: true });
  await fs.writeFile(documentsPath, stringifyNewsDocumentsJsonl([legacyUnclassified]), "utf8");
  const result = await refreshNewsMirror({
    rootDir,
    now: "2026-08-22T12:00:00Z",
    maxAgeDays: 4,
    kcna: false,
    crawlImpl,
    reportPath,
  });
  assert.equal(result.report.status, "success");
  assert.equal(result.report.promoted, true);
  assert.equal(result.report.assets.copied, 1);
  assert.equal(result.report.assets.removed, 1);
  assert.equal(result.report.merge.removedUnclassified, 1);
  assert.deepEqual(result.report.assets.removedFiles, [`rodong-sinmun/${existingOrphanHash}.jpg`]);
  assert.equal(result.documents.some((document) => document.id === legacyUnclassified.id), false);
  const rodongFeed = result.snapshot.feed.sources["rodong-sinmun"].articles;
  assert.equal(rodongFeed.some((article) => article.cachedThumbnailUrl === fixtureAsset), true);
  assert.equal(rodongFeed.filter((article) => article.featuredSections.includes("leadership")).length, 6);
  assert.equal(rodongFeed.filter((article) => article.featuredSections.includes("video")).length, 5);
  assert.equal(rodongFeed.filter((article) => article.featuredSections.includes("social")).length, 4);
  assert.equal(JSON.parse(await fs.readFile(reportPath, "utf8")).status, "success");
  await fs.access(path.join(rootDir, fixtureAsset));
  await assert.rejects(fs.access(existingOrphanPath), { code: "ENOENT" });
  await assert.rejects(
    fs.access(path.join(rootDir, "data/news/assets/rodong-sinmun", `${stagedOrphanHash}.jpg`)),
    { code: "ENOENT" },
  );
  await fs.access(path.join(rootDir, "data/news/documents.jsonl"));
  await fs.access(path.join(rootDir, "data/news-feed.json"));
  await fs.access(path.join(rootDir, "data/news-details.json"));

  const before = await fs.readFile(path.join(rootDir, "data/news/documents.jsonl"), "utf8");
  await assert.rejects(
    refreshNewsMirror({
      rootDir,
      now: "2026-08-30T00:00:00Z",
      maxAgeDays: 1,
      kcna: false,
      crawlImpl,
    }),
    /stale/u,
  );
  assert.equal(await fs.readFile(path.join(rootDir, "data/news/documents.jsonl"), "utf8"), before);
} finally {
  await fs.rm(rootDir, { recursive: true, force: true });
}

function createCompleteRodongFixtureDocuments() {
  const quotas = {
    leadership: 6,
    important: 6,
    anecdote: 5,
    domestic: 5,
    memory: 5,
    // The official live category-7 index currently declares only four records.
    social: 4,
    photo: 5,
    video: 5,
  };
  const output = [];
  let sequence = 0;
  for (const [categoryId, count] of Object.entries(quotas)) {
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      const suffix = createHash("sha256").update(`${categoryId}:${index}`).digest("hex").slice(0, 24);
      const hasImage = categoryId === "photo";
      output.push({
        id: `news:rodong-sinmun:${suffix}`,
        sourceId: "rodong-sinmun",
        sourceName: "로동신문",
        category: { id: categoryId, label: categoryId },
        categories: [categoryId],
        kind: categoryId === "photo" ? "photo" : categoryId === "video" ? "video" : "article",
        title: `${categoryId} 공식 분류 기사 ${index + 1}`,
        date: "2026-08-22",
        url: `http://www.rodong.rep.kp/ko/index.php?fixture-${sequence}`,
        body: `${categoryId} 공식 분류에서 직접 수집한 시험 기사 본문이다.`,
        thumbnailUrl: hasImage ? fixtureAsset : "",
        images: hasImage
          ? [{ sha256: fixtureHash, cachedUrl: fixtureAsset, originalUrl: "", role: "inline" }]
          : [],
      });
    }
  }
  return output;
}

for (const source of [
  await fs.readFile(new URL("./refresh-news-mirror.ts", import.meta.url), "utf8"),
  await fs.readFile(new URL("./news-mirror-crawler.ts", import.meta.url), "utf8"),
  await fs.readFile(new URL("./news-snapshot.ts", import.meta.url), "utf8"),
]) {
  assert.equal(/data\/search|\.\.\/search|api\/search|meilisearch/iu.test(source), false, "standalone news code must not depend on the search product");
}

console.log("Standalone news refresh tests passed.");
