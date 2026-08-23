#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertCanonicalNewsGeneratedPaths,
  isCanonicalNewsGeneratedPath,
} from "./news-generated-paths.ts";
import {
  MAX_REPORTED_CRAWL_ERRORS_PER_SOURCE,
  assertCrawlFrontierExhausted,
  assertCrawlSourceCompleteness,
  assertNewsFreshness,
  createRefreshDocumentIdentity,
  flattenCrawledNewsDocuments,
  parseArguments,
  reconstructKnownCrawlerDocuments,
  refreshNewsMirror,
} from "./refresh-news-mirror.ts";
import { parseOfficialNewsImageUrl } from "../api/news-image.js";
import {
  NEWS_DOCUMENT_SCHEMA_VERSION,
  canonicalizeNewsDocument,
  stringifyNewsDocumentsJsonl,
} from "./news-snapshot.ts";
import {
  assertNewsImageProxyAllowlist,
  assertReferencedNewsAssetsIncluded,
} from "./verify-vercel-bundle.ts";

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
    categoryOrders: { important: 3, memory: 7 },
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
assert.deepEqual(flattened[0].categoryOrders, { important: 3, memory: 7 });
assert.equal(flattened[0].cachedThumbnailUrl, fixtureAsset);
assert.equal(flattened[1].articleId, flattened[0].id);
assert.equal(flattened[1].cachedUrl, fixtureAsset);
assert.deepEqual(flattened[1].categoryOrders, { important: 3, memory: 7 });
const remoteImageUrl = "http://www.rodong.rep.kp/ko/index.php?MkBAQEBwQDBAMjAyNi8wOC8xNS8yMS8yMDI2LTA4LTE1LTAwMi5qcGc==";
const remoteOnlyNested = {
  documents: [{
    ...nested.documents[0],
    thumbnailUrl: remoteImageUrl,
    images: [{ sha256: "", cachedUrl: "", originalUrl: remoteImageUrl, role: "inline" }],
  }],
};
const remoteOnlyFlattened = flattenCrawledNewsDocuments(remoteOnlyNested);
assert.equal(remoteOnlyFlattened.length, 2, "remote-only image descriptors must survive refresh flattening");
assert.equal(remoteOnlyFlattened[0].thumbnailUrl, remoteImageUrl);
assert.equal(remoteOnlyFlattened[0].cachedThumbnailUrl, "");
assert.equal(remoteOnlyFlattened[1].url, remoteImageUrl);
assert.equal(remoteOnlyFlattened[1].cachedUrl, "");
assert.equal(parseOfficialNewsImageUrl(remoteOnlyFlattened[1].url)?.href, remoteImageUrl);
assert.match(remoteOnlyFlattened[1].id, /:image:[a-f0-9]{64}$/u);
const remotePhotoParent = {
  documents: [{
    ...nested.documents[0],
    id: "news:rodong-sinmun:remotephotofixture",
    category: { id: "photo", label: "사진" },
    categories: ["photo"],
    categoryOrders: { photo: 0 },
    kind: "photo",
    url: remoteImageUrl,
    thumbnailUrl: remoteImageUrl,
    images: [{ sha256: "", cachedUrl: "", originalUrl: remoteImageUrl, role: "gallery" }],
  }],
};
const remotePhotoFlattened = flattenCrawledNewsDocuments(remotePhotoParent);
assert.equal(remotePhotoFlattened.length, 2);
assert.equal(remotePhotoFlattened[1].url, remoteImageUrl);
assert.equal(
  remotePhotoFlattened[1].articleUrl,
  remoteImageUrl,
  "a photo-only Rodong record may use its exact first image endpoint as its synthetic parent URL",
);
assert.equal(remotePhotoFlattened[1].cachedUrl, "");
assert.equal(parseOfficialNewsImageUrl(remotePhotoFlattened[1].url)?.href, remoteImageUrl);
const reconstructedRemote = reconstructKnownCrawlerDocuments(remoteOnlyFlattened, ["rodong-sinmun"]);
assert.equal(reconstructedRemote.length, 1);
assert.equal(reconstructedRemote[0].body, remoteOnlyNested.documents[0].body);
assert.equal(reconstructedRemote[0].images[0].originalUrl, remoteImageUrl);
assert.equal(reconstructedRemote[0].images[0].cachedUrl, "");
assert.deepEqual(reconstructedRemote[0].categoryOrders, { important: 3, memory: 7 });
const sharedOfficialAssetUrl = "http://www.kcna.kp/photo/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const sharedAssetFirstArticle = canonicalizeNewsDocument({
  schemaVersion: NEWS_DOCUMENT_SCHEMA_VERSION,
  id: "shared-asset-first:image:0",
  sourceId: "kcna",
  sourceName: "조선중앙통신",
  mediaType: "image",
  title: "첫 기사 공유 사진",
  date: "2026-08-10",
  url: sharedOfficialAssetUrl,
  articleId: "shared-asset-first",
  articleUrl: "http://www.kcna.kp/kp/article/detail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  categories: ["important"],
  displayOrder: 0,
});
const sharedAssetSecondArticle = canonicalizeNewsDocument({
  ...sharedAssetFirstArticle,
  id: "shared-asset-second:image:0",
  articleId: "shared-asset-second",
  articleUrl: "http://www.kcna.kp/kp/article/detail/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
});
assert.notEqual(
  createRefreshDocumentIdentity(sharedAssetFirstArticle),
  createRefreshDocumentIdentity(sharedAssetSecondArticle),
  "one official image URL associated with two articles must remain two media records",
);
const cachedOnlyGalleryFirst = canonicalizeNewsDocument({
  ...sharedAssetFirstArticle,
  id: "cached-gallery:image:0",
  url: sharedAssetFirstArticle.articleUrl,
  cachedUrl: `/data/news/assets/kcna/${"1".repeat(64)}.jpg`,
  displayOrder: 0,
});
const cachedOnlyGallerySecond = canonicalizeNewsDocument({
  ...cachedOnlyGalleryFirst,
  id: "cached-gallery:image:1",
  cachedUrl: `/data/news/assets/kcna/${"2".repeat(64)}.jpg`,
  displayOrder: 1,
});
assert.notEqual(
  createRefreshDocumentIdentity(cachedOnlyGalleryFirst),
  createRefreshDocumentIdentity(cachedOnlyGallerySecond),
  "cached-only gallery assets and slots must not collapse during authoritative replacement",
);
assert.notEqual(
  createRefreshDocumentIdentity(sharedAssetFirstArticle),
  createRefreshDocumentIdentity(canonicalizeNewsDocument({ ...sharedAssetFirstArticle, id: "shared-asset-first:image:1", displayOrder: 1 })),
  "the same asset in two official gallery slots must retain both slots",
);
assert.deepEqual(
  assertNewsFreshness(flattened, { sourceIds: ["rodong-sinmun"], maxAgeDays: 4, now: "2026-08-22T12:00:00Z" }),
  { "rodong-sinmun": { newest: "2026-08-22", ageDays: 0, maxAgeDays: 4 } },
);
assert.throws(
  () => assertNewsFreshness(flattened, { sourceIds: ["rodong-sinmun"], maxAgeDays: 1, now: "2026-08-25T00:00:00Z" }),
  /stale/u,
);
assert.throws(
  () => assertCrawlFrontierExhausted({
    sources: { "rodong-sinmun": { stats: { capReached: true, frontierExhausted: false } } },
  }, ["rodong-sinmun"]),
  /capReached.*rodong-sinmun/u,
);
assert.throws(
  () => assertCrawlFrontierExhausted({
    sources: { kcna: { stats: { entriesDiscovered: 11, entriesSelected: 10 } } },
  }, ["kcna"]),
  /capReached.*10\/11/u,
);
assert.throws(
  () => assertCrawlFrontierExhausted({
    sources: { kcna: { stats: { capReached: false, listingFrontierExhausted: false } } },
  }, ["kcna"]),
  /did not prove frontier exhaustion/u,
);
assert.throws(
  () => assertCrawlSourceCompleteness({
    sources: {
      kcna: {
        documents: [],
        errors: [],
        stats: { entriesSelected: 2, detailsFetched: 1, categories: [{ id: "important", listingErrors: 0 }] },
      },
    },
  }, ["kcna"]),
  /detail coverage is incomplete/u,
);
assert.throws(
  () => assertCrawlSourceCompleteness({
    sources: {
      kcna: {
        documents: [],
        errors: [],
        stats: {
          entriesSelected: 0,
          detailsFetched: 0,
          categories: [{
            id: "photo",
            listingErrors: 0,
            paginationProofRequired: true,
            paginationProofObserved: false,
            paginationProofMissing: true,
            pagesFetched: 1,
            declaredLastPage: null,
            entriesDiscovered: 10,
            declaredTotal: null,
          }],
          imageQuota: { skippedReferences: 0, failedReferences: 0 },
        },
      },
    },
  }, ["kcna"]),
  /unproven pagination.*photo pages=1\/unknown entries=10\/unknown/u,
);
assert.throws(
  () => assertCrawlSourceCompleteness({
    sources: {
      kcna: {
        documents: [{ id: "camera-without-cache", markers: { camera: true }, images: [] }],
        errors: [],
        stats: {
          entriesSelected: 1,
          detailsFetched: 1,
          categories: [{ id: "important", listingErrors: 0 }],
          imageQuota: { skippedReferences: 0, failedReferences: 0 },
        },
      },
    },
  }, ["kcna"]),
  /camera\/gallery document.*without image descriptors/u,
);
assert.throws(
  () => assertCrawlSourceCompleteness({
    sources: {
      kcna: {
        documents: [],
        errors: [],
        stats: { entriesSelected: 0, detailsFetched: 0, categories: [{ id: "important", listingErrors: 0 }] },
      },
    },
  }, ["kcna"]),
  /no image checkpoint/u,
);
assert.doesNotThrow(() => assertCrawlSourceCompleteness({
  sources: {
    "rodong-sinmun": {
      documents: remoteOnlyNested.documents.map((document) => ({ ...document, markers: { camera: true, gallery: false } })),
      errors: [],
      stats: {
        entriesSelected: 1,
        detailsFetched: 1,
        categories: [{ id: "important", listingErrors: 0 }],
        imageQuota: { skippedReferences: 0, failedReferences: 0 },
      },
    },
  },
}, ["rodong-sinmun"]));
assert.doesNotThrow(() => assertCrawlSourceCompleteness({
  sources: {
    "rodong-sinmun": {
      documents: remoteOnlyNested.documents,
      errors: [],
      stats: {
        entriesSelected: 1,
        detailsFetched: 0,
        detailsReused: 1,
        detailsUnresolved: 0,
        categories: [{ id: "important", listingErrors: 0 }],
        imageQuota: { skippedReferences: 0, failedReferences: 0 },
      },
    },
  },
}, ["rodong-sinmun"]));
assert.deepEqual(
  parseArguments([
    "--kcna-only",
    "--max-list-pages", "400",
    "--max-documents", "20000",
    "--max-documents-per-category", "10000",
    "--max-images-per-document", "100",
    "--max-images-per-crawl", "20000",
    "--max-image-bytes-per-crawl", "8589934592",
    "--detail-concurrency", "2",
    "--defer-remote-images",
    "--recent-detail-days", "7",
    "--full-backfill",
  ]),
  {
    crawlOptions: {
      maxListPages: 400,
      maxDocuments: 20_000,
      maxDocumentsPerCategory: 10_000,
      maxImagesPerDocument: 100,
      maxImagesPerCrawl: 20_000,
      maxImageBytesPerCrawl: 8 * 1024 * 1024 * 1024,
      detailConcurrency: 2,
      cacheRemoteImages: false,
    },
    recentDetailDays: 7,
    fullBackfill: true,
    rodong: false,
  },
  "refresh CLI must pass the exhaustive crawl ceilings through to the crawler",
);
assert.throws(
  () => assertCrawlFrontierExhausted({
    sources: { kcna: { stats: { capReached: false } } },
  }, ["kcna"]),
  /did not prove frontier exhaustion/u,
);

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "standalone-news-refresh-test-"));
try {
  const oversizedFailureReportPath = path.join(rootDir, "oversized-failure-report.json");
  const oversizedFailure = "x".repeat(10_000);
  await assert.rejects(
    refreshNewsMirror({
      rootDir,
      kcna: false,
      crawlImpl: async () => { throw new Error(oversizedFailure); },
      reportPath: oversizedFailureReportPath,
    }),
    /x{100}/u,
  );
  const oversizedFailureReport = JSON.parse(await fs.readFile(oversizedFailureReportPath, "utf8"));
  assert.ok(oversizedFailureReport.error.length < oversizedFailure.length, "top-level report errors must be bounded");
  assert.match(oversizedFailureReport.error, /\.\.\.\[truncated\]$/u);

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
          stats: {
            capReached: false,
            listingFrontierExhausted: true,
            entriesDiscovered: completeRodongDocuments.length,
            entriesSelected: completeRodongDocuments.length,
            detailsFetched: completeRodongDocuments.length,
            imagesCached: 2,
            categories: [{ id: "fixture", listingErrors: 0 }],
            imageQuota: { skippedReferences: 0, failedReferences: 0 },
          },
        },
      },
      documents: completeRodongDocuments,
    };
  };
  const createSparseCrawl = (errors = []) => ({
    generatedAt: "2026-08-22T12:00:00.000Z",
    sources: {
      kcna: { documents: [], errors: [], stats: {} },
      "rodong-sinmun": {
        documents: nested.documents,
        errors,
        stats: {
          capReached: false,
          listingFrontierExhausted: true,
          entriesDiscovered: 1,
          entriesSelected: 1,
          detailsFetched: 1,
          categories: [{ id: "fixture", listingErrors: 0 }],
          imageQuota: { skippedReferences: 0, failedReferences: 0 },
        },
      },
    },
    documents: nested.documents,
  });
  const sparseCrawlImpl = async () => createSparseCrawl();
  const sparseReportPath = path.join(rootDir, "sparse-report.json");
  await assert.rejects(
    refreshNewsMirror({
      rootDir,
      now: "2026-08-22T12:00:00Z",
      maxAgeDays: 4,
      kcna: false,
      crawlImpl: sparseCrawlImpl,
      reportPath: sparseReportPath,
    }),
    /rodong-sinmun\/leadership 0\/6/u,
    "a fresh Rodong head must not hide an empty official category crawl",
  );
  const sparseReport = JSON.parse(await fs.readFile(sparseReportPath, "utf8"));
  assert.equal(sparseReport.status, "failed");
  assert.match(sparseReport.error, /official news category quota is incomplete/iu);
  assert.equal(sparseReport.crawl["rodong-sinmun"].errorCount, 0);
  assert.equal(sparseReport.crawl["rodong-sinmun"].stats.listingFrontierExhausted, true);

  const diagnosticErrors = Array.from({ length: MAX_REPORTED_CRAWL_ERRORS_PER_SOURCE + 3 }, (_, index) => ({
    stage: "detail",
    url: `http://www.rodong.rep.kp/ko/index.php?failed-${index}`,
    error: `fixture detail failure ${index}`,
  }));
  const diagnosticReportPath = path.join(rootDir, "diagnostic-report.json");
  const diagnosticCrawl = createSparseCrawl(diagnosticErrors);
  diagnosticCrawl.sources["rodong-sinmun"].stats.missingExpectedImageSamples = [{
    url: nested.documents[0].url,
    title: nested.documents[0].title,
    date: nested.documents[0].date,
    kind: nested.documents[0].kind,
    categories: ["important", "memory"],
    markers: { camera: true, gallery: false },
    galleryUrl: "",
  }];
  diagnosticCrawl.sources["rodong-sinmun"].stats.missingExpectedImageSamplesOmitted = 37;
  await assert.rejects(
    refreshNewsMirror({
      rootDir,
      now: "2026-08-22T12:00:00Z",
      maxAgeDays: 4,
      kcna: false,
      crawlImpl: async () => diagnosticCrawl,
      reportPath: diagnosticReportPath,
    }),
    /reported 23 error\(s\).*detail=23/u,
  );
  const diagnosticReport = JSON.parse(await fs.readFile(diagnosticReportPath, "utf8"));
  assert.equal(diagnosticReport.status, "failed");
  assert.equal(diagnosticReport.crawl["rodong-sinmun"].errorCount, MAX_REPORTED_CRAWL_ERRORS_PER_SOURCE + 3);
  assert.equal(diagnosticReport.crawl["rodong-sinmun"].errors.length, MAX_REPORTED_CRAWL_ERRORS_PER_SOURCE);
  assert.equal(diagnosticReport.crawl["rodong-sinmun"].errorsOmitted, 3);
  assert.deepEqual(diagnosticReport.crawl["rodong-sinmun"].stats.missingExpectedImageSamples, [{
    url: nested.documents[0].url,
    title: nested.documents[0].title,
    date: nested.documents[0].date,
    kind: nested.documents[0].kind,
    categories: ["important", "memory"],
    markers: { camera: true, gallery: false },
    galleryUrl: "",
  }], "bounded reports must retain actionable sample fields without article body or image payloads");
  assert.equal(diagnosticReport.crawl["rodong-sinmun"].stats.missingExpectedImageSamplesOmitted, 37);
  const reportPath = path.join(rootDir, "report.json");
  const existingOrphanPath = path.join(rootDir, "data/news/assets/rodong-sinmun", `${existingOrphanHash}.jpg`);
  const staleDetailShardPath = path.join(rootDir, "data/news/details/stale.json");
  const staleCategoryPagePath = path.join(rootDir, "data/news/categories/stale/page-99.json");
  const imageProxyAllowlistPath = path.join(rootDir, "data/news/image-proxy-allowlist.json");
  await fs.mkdir(path.dirname(existingOrphanPath), { recursive: true });
  await fs.writeFile(existingOrphanPath, existingOrphanBytes);
  await fs.mkdir(path.dirname(staleDetailShardPath), { recursive: true });
  await fs.writeFile(staleDetailShardPath, "stale\n", "utf8");
  await fs.mkdir(path.dirname(staleCategoryPagePath), { recursive: true });
  await fs.writeFile(staleCategoryPagePath, "stale\n", "utf8");
  await fs.writeFile(imageProxyAllowlistPath, "stale\n", "utf8");
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
  const incomingLeadershipArticle = flattenCrawledNewsDocuments({ documents: [completeRodongDocuments[0]] })[0];
  const staleLeadershipTitle = `${incomingLeadershipArticle.title} - 이전 수집기가 잘못 덧붙인 긴 제목`;
  const staleLeadershipSnippet = `${incomingLeadershipArticle.snippet} 이전 수집기가 잘못 덧붙인 긴 요약문이다.`;
  const staleLeadershipBody = `${incomingLeadershipArticle.body}\n\n이전 수집기가 잘못 덧붙인 더 긴 본문은 새 공식 원문으로 교체되어야 한다.`;
  const staleLeadershipArticle = canonicalizeNewsDocument({
    ...incomingLeadershipArticle,
    sourceName: "잘못 보관된 원천명",
    title: staleLeadershipTitle,
    snippet: staleLeadershipSnippet,
    body: staleLeadershipBody,
    categoryOrders: { leadership: 99 },
    cachedThumbnailUrl: `/data/news/assets/rodong-sinmun/${existingOrphanHash}.jpg`,
  });
  const staleAssociatedImage = canonicalizeNewsDocument({
    schemaVersion: NEWS_DOCUMENT_SCHEMA_VERSION,
    id: `${incomingLeadershipArticle.id}:image:${existingOrphanHash}`,
    sourceId: "rodong-sinmun",
    sourceName: "로동신문",
    language: "ko",
    mediaType: "image",
    title: incomingLeadershipArticle.title,
    date: incomingLeadershipArticle.date,
    url: incomingLeadershipArticle.url,
    articleId: incomingLeadershipArticle.id,
    articleUrl: incomingLeadershipArticle.url,
    categories: incomingLeadershipArticle.categories,
    cachedUrl: `/data/news/assets/rodong-sinmun/${existingOrphanHash}.jpg`,
    cachedThumbnailUrl: `/data/news/assets/rodong-sinmun/${existingOrphanHash}.jpg`,
    displayOrder: 0,
  });
  const documentsPath = path.join(rootDir, "data/news/documents.jsonl");
  await fs.mkdir(path.dirname(documentsPath), { recursive: true });
  await fs.writeFile(
    documentsPath,
    stringifyNewsDocumentsJsonl([legacyUnclassified, staleLeadershipArticle, staleAssociatedImage]),
    "utf8",
  );
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
  assert.equal(result.report.merge.removedAuthoritative, 1);
  assert.deepEqual(result.report.assets.removedFiles, [`rodong-sinmun/${existingOrphanHash}.jpg`]);
  assert.equal(result.documents.some((document) => document.id === legacyUnclassified.id), false);
  assert.equal(result.documents.some((document) => document.id === staleAssociatedImage.id), false);
  const refreshedLeadershipArticle = result.documents.find((document) => document.id === incomingLeadershipArticle.id);
  assert.equal(refreshedLeadershipArticle.sourceName, incomingLeadershipArticle.sourceName, "the confirmed source name must replace stale archive chrome");
  assert.equal(refreshedLeadershipArticle.title, incomingLeadershipArticle.title, "the confirmed official title must replace a stale longer title");
  assert.equal(refreshedLeadershipArticle.snippet, incomingLeadershipArticle.snippet, "the confirmed official snippet must replace a stale longer snippet");
  assert.equal(refreshedLeadershipArticle.body, incomingLeadershipArticle.body, "the confirmed official body must replace a stale longer body");
  assert.deepEqual(refreshedLeadershipArticle.categoryOrders, { leadership: 0 }, "official list rank must be replaced authoritatively");
  assert.equal(refreshedLeadershipArticle.cachedThumbnailUrl, "", "stale article media fields must not survive an authoritative source refresh");
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
  await fs.access(path.join(rootDir, "data/news/details/00.json"));
  await fs.access(path.join(rootDir, "data/news/categories/rodong-sinmun/leadership/page-1.json"));
  assert.equal(
    await fs.readFile(imageProxyAllowlistPath, "utf8"),
    result.snapshot.imageProxyAllowlistText,
    "refresh promotion must atomically replace the stale proxy allowlist from the canonical snapshot",
  );
  await assert.rejects(fs.access(staleDetailShardPath), { code: "ENOENT" });
  await assert.rejects(fs.access(staleCategoryPagePath), { code: "ENOENT" });
  assert.equal(result.report.snapshot.detailShards, 256);
  assert.ok(result.report.snapshot.categoryPages > 0);
  assert.equal(result.report.snapshot.imageProxyPairs, result.snapshot.imageProxyAllowlist.pairCount);

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

await testIncrementalKnownDocumentHandoff();
await testSourceIsolatedPromotion();
await testGeneratedPathReleaseGates();
await testRefreshWorkflowIsolation();

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
  const categoryCodes = {
    leadership: "1",
    important: "2",
    anecdote: "3",
    domestic: "4",
    memory: "5",
    social: "7",
    photo: "8",
    video: "9",
  };
  const output = [];
  let sequence = 0;
  for (const [categoryId, count] of Object.entries(quotas)) {
    for (let index = 0; index < count; index += 1) {
      sequence += 1;
      const suffix = createHash("sha256").update(`${categoryId}:${index}`).digest("hex").slice(0, 24);
      const hasImage = categoryId === "photo";
      const newsId = `2026-08-22-${String(sequence).padStart(3, "0")}`;
      const articleToken = Buffer.from(
        `12@${newsId}@${categoryCodes[categoryId]}@1@@0@1@`,
        "utf8",
      ).toString("base64");
      const imageToken = Buffer.from(
        `2@@@@p@0@2026/08/22/1/${newsId}/${newsId}.jpg`,
        "utf8",
      ).toString("base64");
      const originalImageUrl = `http://www.rodong.rep.kp/ko/index.php?${imageToken}`;
      output.push({
        id: `news:rodong-sinmun:${suffix}`,
        sourceId: "rodong-sinmun",
        sourceName: "로동신문",
        category: { id: categoryId, label: categoryId },
        categories: [categoryId],
        categoryOrders: { [categoryId]: index },
        kind: categoryId === "photo" ? "photo" : categoryId === "video" ? "video" : "article",
        title: `${categoryId} 공식 분류 기사 ${index + 1}`,
        date: "2026-08-22",
        url: `http://www.rodong.rep.kp/ko/index.php?${articleToken}`,
        body: `${categoryId} 공식 분류에서 직접 수집한 시험 기사 본문이다.`,
        thumbnailUrl: hasImage ? fixtureAsset : "",
        images: hasImage
          ? [{ sha256: fixtureHash, cachedUrl: fixtureAsset, originalUrl: originalImageUrl, role: "inline" }]
          : [],
      });
    }
  }
  return output;
}

async function testIncrementalKnownDocumentHandoff() {
  const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "standalone-news-incremental-handoff-"));
  try {
    const existing = flattenCrawledNewsDocuments({ documents: completeRodongDocuments });
    const documentsPath = path.join(isolatedRoot, "data/news/documents.jsonl");
    await fs.mkdir(path.dirname(documentsPath), { recursive: true });
    await fs.writeFile(documentsPath, stringifyNewsDocumentsJsonl(existing), "utf8");
    const assetPath = path.join(isolatedRoot, fixtureAsset);
    await fs.mkdir(path.dirname(assetPath), { recursive: true });
    await fs.writeFile(assetPath, fixtureBytes);

    let incrementalOptions;
    const incrementalResult = await refreshNewsMirror({
      rootDir: isolatedRoot,
      now: "2026-08-22T12:00:00Z",
      maxAgeDays: 4,
      kcna: false,
      recentDetailDays: 7,
      crawlImpl: async (options) => {
        incrementalOptions = options;
        return {
          generatedAt: "2026-08-22T12:00:00.000Z",
          sources: {
            kcna: { documents: [], errors: [], stats: {} },
            "rodong-sinmun": {
              documents: options.knownDocuments,
              errors: [],
              stats: {
                capReached: false,
                listingFrontierExhausted: true,
                entriesDiscovered: options.knownDocuments.length,
                entriesSelected: options.knownDocuments.length,
                detailsFetched: 0,
                detailsReused: options.knownDocuments.length,
                detailsUnresolved: 0,
                categories: [{ id: "fixture", listingErrors: 0 }],
                imageQuota: { skippedReferences: 0, failedReferences: 0 },
              },
            },
          },
          documents: options.knownDocuments,
        };
      },
    });
    assert.equal(incrementalOptions.fullBackfill, false);
    assert.equal(incrementalOptions.recentDetailDays, 7);
    assert.equal(incrementalOptions.knownDocuments.length, completeRodongDocuments.length);
    assert.equal(incrementalResult.report.refreshMode, "incremental");
    assert.equal(incrementalResult.report.knownDetailsOffered, completeRodongDocuments.length);

    let backfillOptions;
    await refreshNewsMirror({
      rootDir: isolatedRoot,
      now: "2026-08-22T12:00:00Z",
      maxAgeDays: 4,
      kcna: false,
      fullBackfill: true,
      crawlImpl: async (options) => {
        backfillOptions = options;
        return {
          generatedAt: "2026-08-22T12:00:00.000Z",
          sources: {
            kcna: { documents: [], errors: [], stats: {} },
            "rodong-sinmun": {
              documents: completeRodongDocuments,
              errors: [],
              stats: {
                capReached: false,
                listingFrontierExhausted: true,
                entriesDiscovered: completeRodongDocuments.length,
                entriesSelected: completeRodongDocuments.length,
                detailsFetched: completeRodongDocuments.length,
                detailsReused: 0,
                detailsUnresolved: 0,
                categories: [{ id: "fixture", listingErrors: 0 }],
                imageQuota: { skippedReferences: 0, failedReferences: 0 },
              },
            },
          },
          documents: completeRodongDocuments,
        };
      },
    });
    assert.equal(backfillOptions.fullBackfill, true);
    assert.deepEqual(backfillOptions.knownDocuments, []);
  } finally {
    await fs.rm(isolatedRoot, { recursive: true, force: true });
  }
}

async function testSourceIsolatedPromotion() {
  const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "standalone-news-source-isolation-test-"));
  try {
    const documentsPath = path.join(isolatedRoot, "data/news/documents.jsonl");
    const preservedKcna = canonicalizeNewsDocument({
      schemaVersion: NEWS_DOCUMENT_SCHEMA_VERSION,
      id: "news:kcna:preserved-source-fixture",
      sourceId: "kcna",
      sourceName: "조선중앙통신",
      language: "ko",
      mediaType: "article",
      title: "실패한 조선중앙통신 갱신에서 보존할 기사",
      date: "2026-08-21",
      url: "http://www.kcna.kp/kp/article/q/preserved-source-fixture.kcmsf",
      snippet: "실패한 원천의 기존 자료는 그대로 보존되어야 한다.",
      body: "실패한 원천의 기존 자료는 그대로 보존되어야 한다.",
      categories: ["important"],
    });
    const cachedPhotoSource = completeRodongDocuments.find((document) => document.category.id === "photo");
    const cachedPhotoDocuments = flattenCrawledNewsDocuments({ documents: [cachedPhotoSource] });
    const originalDocumentsText = stringifyNewsDocumentsJsonl([preservedKcna, ...cachedPhotoDocuments]);
    await fs.mkdir(path.dirname(documentsPath), { recursive: true });
    await fs.writeFile(documentsPath, originalDocumentsText, "utf8");
    const existingCachedPhotoPath = path.join(isolatedRoot, fixtureAsset);
    await fs.mkdir(path.dirname(existingCachedPhotoPath), { recursive: true });
    await fs.writeFile(existingCachedPhotoPath, fixtureBytes);

    const kcnaReportPath = path.join(isolatedRoot, "reports/kcna.json");
    const cappedKcnaCrawl = async () => ({
      generatedAt: "2026-08-22T12:00:00.000Z",
      sources: {
        kcna: {
          documents: [],
          errors: [{ stage: "listing", url: "http://www.kcna.kp/kp/article/list/fixture", error: "fixture cap" }],
          stats: { capReached: true, listingFrontierExhausted: false, entriesDiscovered: 2_001, entriesSelected: 2_000 },
        },
        "rodong-sinmun": { documents: [], errors: [], stats: {} },
      },
      documents: [],
    });
    await assert.rejects(
      refreshNewsMirror({
        rootDir: isolatedRoot,
        now: "2026-08-22T12:00:00Z",
        rodong: false,
        crawlImpl: cappedKcnaCrawl,
        reportPath: kcnaReportPath,
      }),
      /capReached.*kcna/u,
    );
    assert.equal(
      await fs.readFile(documentsPath, "utf8"),
      originalDocumentsText,
      "a capped KCNA transaction must not modify the existing KCNA corpus",
    );
    const kcnaReport = JSON.parse(await fs.readFile(kcnaReportPath, "utf8"));
    assert.equal(kcnaReport.status, "failed");
    assert.equal(kcnaReport.promoted, false);
    assert.equal(kcnaReport.crawl.kcna.stats.capReached, true);
    assert.equal(kcnaReport.crawl.kcna.errorCount, 1);

    const rodongReportPath = path.join(isolatedRoot, "reports/rodong-sinmun.json");
    const remoteOnlyRodongDocuments = completeRodongDocuments.map((document) => ({
      ...document,
      thumbnailUrl: document.images[0]?.originalUrl || "",
      images: document.images.map((image) => ({ ...image, sha256: "", cachedUrl: "" })),
    }));
    const successfulRodongCrawl = async () => {
      return {
        generatedAt: "2026-08-22T12:00:00.000Z",
        sources: {
          kcna: { documents: [], errors: [], stats: {} },
          "rodong-sinmun": {
            documents: remoteOnlyRodongDocuments,
            errors: [],
            stats: {
              capReached: false,
              listingFrontierExhausted: true,
              entriesDiscovered: remoteOnlyRodongDocuments.length,
              entriesSelected: remoteOnlyRodongDocuments.length,
              detailsFetched: remoteOnlyRodongDocuments.length,
              categories: [{ id: "fixture", listingErrors: 0 }],
              imageQuota: { skippedReferences: 0, failedReferences: 0 },
            },
          },
        },
        documents: remoteOnlyRodongDocuments,
      };
    };
    const rodongResult = await refreshNewsMirror({
      rootDir: isolatedRoot,
      now: "2026-08-22T12:00:00Z",
      kcna: false,
      crawlImpl: successfulRodongCrawl,
      reportPath: rodongReportPath,
    });
    assert.equal(rodongResult.report.status, "success");
    assert.equal(rodongResult.report.promoted, true);
    assert.equal(rodongResult.documents.some((document) => document.id === preservedKcna.id), true);
    assert.equal(
      rodongResult.documents.some((document) => document.sourceId === "rodong-sinmun"),
      true,
      "a successful Rodong transaction must promote even after KCNA failed",
    );
    const preservedCachedPhoto = rodongResult.documents.find((document) => (
      document.mediaType === "image" && document.url === cachedPhotoSource.images[0].originalUrl
    ));
    assert.equal(preservedCachedPhoto.cachedUrl, fixtureAsset, "a confirmed remote image must retain its existing local cache");
    const preservedCachedArticle = rodongResult.documents.find((document) => document.id === cachedPhotoSource.id);
    assert.equal(preservedCachedArticle.thumbnailUrl, cachedPhotoSource.images[0].originalUrl);
    assert.equal(preservedCachedArticle.cachedThumbnailUrl, fixtureAsset);
    await fs.access(existingCachedPhotoPath);
    assert.equal(JSON.parse(await fs.readFile(rodongReportPath, "utf8")).status, "success");
  } finally {
    await fs.rm(isolatedRoot, { recursive: true, force: true });
  }
}

async function testRefreshWorkflowIsolation() {
  const workflow = await fs.readFile(new URL("../.github/workflows/news-mirror-refresh.yml", import.meta.url), "utf8");
  const newsCiWorkflow = await fs.readFile(new URL("../.github/workflows/news-ci.yml", import.meta.url), "utf8");
  const kcnaIndex = workflow.indexOf("--kcna-only");
  const rodongIndex = workflow.indexOf("--rodong-only");
  const commitIndex = workflow.indexOf("- name: Commit refreshed mirror");
  const failureIndex = workflow.indexOf("- name: Fail after preserving successful source refreshes");
  assert.ok(kcnaIndex >= 0 && rodongIndex > kcnaIndex, "workflow must refresh KCNA and Rodong as sequential source transactions");
  const kcnaTransaction = workflow.slice(kcnaIndex, rodongIndex);
  const rodongTransaction = workflow.slice(rodongIndex, commitIndex);
  assert.match(workflow, /timeout --foreground --signal=TERM --kill-after=30s 240m npm run refresh:news --[\s\S]*--kcna-only/u);
  assert.match(workflow, /timeout --foreground --signal=TERM --kill-after=30s 80m npm run refresh:news --[\s\S]*--rodong-only/u);
  assert.match(kcnaTransaction, /--max-list-pages 400[\s\S]*--max-documents 20000[\s\S]*--max-documents-per-category 10000/u);
  assert.match(rodongTransaction, /--max-list-pages 400[\s\S]*--max-documents 20000[\s\S]*--max-documents-per-category 10000/u);
  assert.doesNotMatch(kcnaTransaction, /--detail-concurrency/u, "KCNA must retain its source-specific concurrency default");
  assert.match(rodongTransaction, /--detail-concurrency 2/u, "Rodong production refresh must limit direct detail concurrency to two");
  for (const transaction of [kcnaTransaction, rodongTransaction]) {
    assert.match(transaction, /--max-images-per-document 100[\s\S]*--max-images-per-crawl 20000[\s\S]*--max-image-bytes-per-crawl 8589934592/u);
    assert.match(transaction, /--defer-remote-images/u);
    assert.match(transaction, /--recent-detail-days 7/u);
    assert.match(transaction, /"\$\{refresh_mode_args\[@\]\}"/u);
  }
  assert.match(workflow, /workflow_dispatch:[\s\S]*full_backfill:[\s\S]*type: boolean/u);
  assert.match(workflow, /NEWS_MIRROR_FULL_BACKFILL:[\s\S]*refresh_mode_args=\(\)[\s\S]*refresh_mode_args\+=\(--full-backfill\)/u);
  assert.doesNotMatch(workflow, /--max-list-pages 1(?:\s|\\)|--max-documents 96(?:\s|\\)/u, "production refresh must not retain the shallow 1-page/96-document crawl");
  assert.match(workflow, /NEWS_MIRROR_REPORT_DIR[\s\S]*kcna\.json[\s\S]*rodong-sinmun\.json/u, "workflow must retain separate source reports");
  assert.equal(
    (workflow.match(/sort -zu \| node scripts\/news-generated-paths\.ts --stdin0/gu) || []).length,
    2,
    "workflow must fail closed on non-canonical generated paths before and after release gates",
  );
  assert.doesNotMatch(workflow, /data\/news\/\*/u, "workflow must not use a broad generated-path allow rule");
  assert.match(newsCiWorkflow, /- "lib\/news-image-policy\.js"/u, "News CI must run when the shared image policy changes");
  assert.ok(commitIndex >= 0 && failureIndex > commitIndex, "workflow must commit successful source transactions before reporting a sibling source failure");
  assert.match(workflow.slice(failureIndex), /if:\s*always\(\)/u);
}

async function testGeneratedPathReleaseGates() {
  for (const relativePath of [
    "data/news-feed.json",
    "data/news-details.json",
    "data/news/documents.jsonl",
    "data/news/image-proxy-allowlist.json",
    "data/news/details/0a.json",
    `data/news/assets/kcna/${"a".repeat(64)}.jpg`,
    "data/news/categories/kcna/international/page-12.json",
    "data/news/categories/rodong-sinmun/social/page-1.json",
  ]) {
    assert.equal(isCanonicalNewsGeneratedPath(relativePath), true, `${relativePath} must be a canonical News output`);
  }
  for (const relativePath of [
    "data/news/.details.123.tmp/00.json",
    "data/news/.categories.123.old/kcna/important/page-1.json",
    "data/news/details/stale.json",
    "data/news/categories/rodong-sinmun/international/page-1.json",
    "data/news/categories/kcna/important/page-0.json",
    `data/news/assets/kcna/${"A".repeat(64)}.jpg`,
    "data/news/unknown.json",
  ]) {
    assert.equal(isCanonicalNewsGeneratedPath(relativePath), false, `${relativePath} must fail the News output gate`);
  }
  assert.throws(
    () => assertCanonicalNewsGeneratedPaths(["data/news-feed.json", "data/news/.details.123.tmp/00.json"]),
    /unexpected path.*\.tmp/iu,
  );

  const verifierRoot = await fs.mkdtemp(path.join(os.tmpdir(), "news-generated-path-verifier-"));
  try {
    const newsDataDir = path.join(verifierRoot, "data/news");
    await fs.mkdir(newsDataDir, { recursive: true });
    const snapshotVersion = "1".repeat(16);
    await fs.writeFile(path.join(verifierRoot, "data/news-feed.json"), `${JSON.stringify({ version: snapshotVersion })}\n`, "utf8");
    await fs.writeFile(path.join(verifierRoot, "data/news-details.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(newsDataDir, "documents.jsonl"), "", "utf8");
    const pairHashes = ["1".repeat(64), "a".repeat(64)];
    const allowlist = {
      schemaVersion: 1,
      snapshotVersion,
      algorithm: "sha256",
      pairCount: pairHashes.length,
      pairHashes,
    };
    const allowlistPath = path.join(newsDataDir, "image-proxy-allowlist.json");
    await fs.writeFile(allowlistPath, `${JSON.stringify(allowlist)}\n`, "utf8");
    await assertNewsImageProxyAllowlist(verifierRoot, new Set(["data/news/image-proxy-allowlist.json"]));

    await fs.writeFile(allowlistPath, `${JSON.stringify({ ...allowlist, pairHashes: [...pairHashes].reverse() })}\n`, "utf8");
    await assert.rejects(
      assertNewsImageProxyAllowlist(verifierRoot, new Set(["data/news/image-proxy-allowlist.json"])),
      /sorted and unique/u,
    );

    const orphanAsset = `data/news/assets/kcna/${"b".repeat(64)}.jpg`;
    await assert.rejects(
      assertReferencedNewsAssetsIncluded(verifierRoot, new Set([orphanAsset]), [orphanAsset]),
      /Unreferenced news asset/u,
    );
  } finally {
    await fs.rm(verifierRoot, { recursive: true, force: true });
  }
}

for (const source of [
  await fs.readFile(new URL("./refresh-news-mirror.ts", import.meta.url), "utf8"),
  await fs.readFile(new URL("./news-mirror-crawler.ts", import.meta.url), "utf8"),
  await fs.readFile(new URL("./news-snapshot.ts", import.meta.url), "utf8"),
  await fs.readFile(new URL("./news-generated-paths.ts", import.meta.url), "utf8"),
  await fs.readFile(new URL("../.github/workflows/news-mirror-refresh.yml", import.meta.url), "utf8"),
]) {
  assert.equal(/data\/search|\.\.\/search|api\/search|meilisearch/iu.test(source), false, "standalone news code must not depend on the search product");
}

console.log("Standalone news refresh tests passed.");
