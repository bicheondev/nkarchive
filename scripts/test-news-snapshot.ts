#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashPublishedNewsImagePair } from "../lib/news-image-policy.js";
import { loadPublishedNewsImagePairHashes } from "../api/news-image.js";
import {
  NEWS_ASSET_PUBLIC_PREFIX,
  NEWS_CATEGORY_PAGE_SIZE,
  NEWS_DETAIL_SHARD_COUNT,
  NEWS_DETAIL_SHARD_PUBLIC_PATTERN,
  NEWS_DOCUMENT_SCHEMA_VERSION,
  DEFAULT_MAX_NEWS_ITEMS_PER_SOURCE,
  NEWS_SECTION_IDS,
  NEWS_SECTION_QUOTAS,
  NEWS_SOURCE_SECTION_IDS,
  assertNewsSectionQuotaReadiness,
  buildNewsSnapshot,
  canonicalizeNewsDocument,
  mergeFreshNewsDocuments,
  newsDetailShardForId,
  parseNewsDocumentsJsonl,
  stringifyNewsDocumentsJsonl,
  validateNewsDocuments,
} from "./news-snapshot.ts";
import { generateNewsFiles } from "./generate-news-feed.ts";
import { isCanonicalNewsGeneratedPath } from "./news-generated-paths.ts";

function article(overrides = {}) {
  const id = overrides.id || "wire-article";
  return canonicalizeNewsDocument({
    schemaVersion: NEWS_DOCUMENT_SCHEMA_VERSION,
    id,
    sourceId: "wire",
    sourceName: "통신사",
    language: "ko",
    mediaType: "article",
    title: `기사 ${id}`,
    date: "2026-08-22",
    url: `https://wire.example/articles/${id}`,
    snippet: `요약 ${id}`,
    body: `본문 ${id} `.repeat(20),
    categories: [],
    ...overrides,
  });
}

function media(mediaType, overrides = {}) {
  const id = overrides.id || `wire-${mediaType}`;
  const extension = mediaType === "image" ? "jpg" : "mp4";
  return canonicalizeNewsDocument({
    schemaVersion: NEWS_DOCUMENT_SCHEMA_VERSION,
    id,
    sourceId: "wire",
    sourceName: "통신사",
    language: "ko",
    mediaType,
    title: `매체 ${id}`,
    date: "2026-08-22",
    url: `https://wire.example/media/${id}.${extension}`,
    snippet: `설명 ${id}`,
    body: "",
    categories: mediaType === "image" ? ["photo"] : ["video"],
    cachedUrl: mediaType === "image" ? newsAsset(id) : "",
    cachedThumbnailUrl: newsAsset(id),
    ...overrides,
  });
}

function newsAsset(value) {
  return `${NEWS_ASSET_PUBLIC_PREFIX}wire/${createHash("sha256").update(String(value)).digest("hex")}.jpg`;
}

function createQuotaFixture() {
  const records = [];
  let sequence = 0;
  for (const section of NEWS_SECTION_IDS) {
    const quota = NEWS_SECTION_QUOTAS[section];
    for (let index = 0; index < quota; index += 1) {
      sequence += 1;
      const date = `2026-08-${String(22 - Math.floor(sequence / 20)).padStart(2, "0")}`;
      if (section === "photo") {
        records.push(media("image", {
          id: `wire-photo-${index}`,
          title: `사진 기사 ${index}`,
          date,
          categories: [section],
        }));
      } else if (section === "video") {
        records.push(media("video", {
          id: `wire-video-${index}`,
          title: `동화상 기사 ${index}`,
          date,
          categories: [section],
        }));
      } else {
        records.push(article({
          id: `wire-${section}-${index}`,
          title: `${section} 기사 ${index}`,
          date,
          categories: [section],
        }));
      }
    }
  }
  return records;
}

const base = article({
  id: "wire-merge",
  title: "기존 기사",
  date: "2026-08-21",
  categories: ["domestic"],
  cachedThumbnailUrl: newsAsset("existing"),
});
const incomingUpdate = article({
  id: base.id,
  title: "더 자세한 기존 기사 제목",
  date: "2026-08-20",
  body: `${base.body} 추가 본문`,
  categories: ["important"],
  cachedThumbnailUrl: "",
});
const incomingHead = article({ id: "wire-new", date: "2026-08-22" });
const merged = mergeFreshNewsDocuments([base], [incomingUpdate, incomingHead]);
const mergedUpdate = merged.documents.find((document) => document.id === base.id);
assert.equal(merged.report.added, 1);
assert.equal(merged.report.updated, 1);
assert.equal(mergedUpdate.date, "2026-08-21", "an item update must not regress its date");
assert.equal(mergedUpdate.title, incomingUpdate.title);
assert.equal(mergedUpdate.cachedThumbnailUrl, base.cachedThumbnailUrl, "missing fresh assets must not erase cached assets");
assert.deepEqual(mergedUpdate.categories, ["important", "domestic"]);
assert.throws(
  () => mergeFreshNewsDocuments([incomingHead], [article({ id: "wire-stale-head", date: "2026-08-20" })]),
  /source head regressed/u,
);

const preservedArticle = article({ id: "wire-preserved", url: "https://wire.example/articles/shared" });
const incomingRenamedArticle = article({ id: "wire-renamed", url: preservedArticle.url });
const incomingRenamedImage = media("image", {
  id: "wire-renamed-image",
  articleId: incomingRenamedArticle.id,
  articleUrl: incomingRenamedArticle.url,
});
const aliasMerge = mergeFreshNewsDocuments([preservedArticle], [incomingRenamedArticle, incomingRenamedImage]);
assert.equal(aliasMerge.documents.find((document) => document.id === incomingRenamedImage.id).articleId, preservedArticle.id);

const sharedPhotoUrl = "https://wire.example/photo/shared.jpg";
const sharedPhotoArticleA = article({ id: "wire-shared-photo-a" });
const sharedPhotoArticleB = article({ id: "wire-shared-photo-b" });
const sharedPhotoA = media("image", {
  id: "wire-shared-photo-a-image",
  title: "공유 사진",
  url: sharedPhotoUrl,
  articleId: sharedPhotoArticleA.id,
  articleUrl: sharedPhotoArticleA.url,
  displayOrder: 0,
});
const sharedPhotoB = media("image", {
  id: "wire-shared-photo-b-image",
  title: "공유 사진",
  url: sharedPhotoUrl,
  articleId: sharedPhotoArticleB.id,
  articleUrl: sharedPhotoArticleB.url,
  displayOrder: 0,
});
const sharedPhotoMerge = mergeFreshNewsDocuments([], [
  sharedPhotoArticleA,
  sharedPhotoA,
  sharedPhotoArticleB,
  sharedPhotoB,
]);
assert.deepEqual(
  sharedPhotoMerge.documents
    .filter((document) => document.mediaType === "image")
    .map((document) => document.articleId)
    .sort(),
  [sharedPhotoArticleA.id, sharedPhotoArticleB.id],
  "the same official photo URL must survive independently for each associated article",
);
const mediaIdentityZeroQuotas = Object.fromEntries(NEWS_SECTION_IDS.map((section) => [section, 0]));
const sharedPhotoSnapshot = buildNewsSnapshot(sharedPhotoMerge.documents, {
  quotasBySource: { wire: mediaIdentityZeroQuotas },
});
for (const linkedArticle of [sharedPhotoArticleA, sharedPhotoArticleB]) {
  const linkedDetail = sharedPhotoSnapshot.detailShards
    .get(newsDetailShardForId(linkedArticle.id)).articles[linkedArticle.id];
  assert.equal(linkedDetail.images.length, 1, `${linkedArticle.id} must retain its own shared-URL media link`);
}

const cachedGalleryArticle = article({ id: "wire-cached-gallery" });
const cachedGalleryOne = media("image", {
  id: "wire-cached-gallery-one",
  title: "캐시 전용 사진",
  url: cachedGalleryArticle.url,
  articleId: cachedGalleryArticle.id,
  articleUrl: cachedGalleryArticle.url,
  cachedUrl: newsAsset("cached-gallery-one"),
  cachedThumbnailUrl: newsAsset("cached-gallery-one"),
  displayOrder: 0,
});
const cachedGalleryTwo = media("image", {
  id: "wire-cached-gallery-two",
  title: "캐시 전용 사진",
  url: cachedGalleryArticle.url,
  articleId: cachedGalleryArticle.id,
  articleUrl: cachedGalleryArticle.url,
  cachedUrl: newsAsset("cached-gallery-two"),
  cachedThumbnailUrl: newsAsset("cached-gallery-two"),
  displayOrder: 1,
});
const cachedGalleryMerge = mergeFreshNewsDocuments([], [
  cachedGalleryArticle,
  cachedGalleryOne,
  cachedGalleryTwo,
]);
assert.equal(
  cachedGalleryMerge.documents.filter((document) => document.mediaType === "image").length,
  2,
  "multiple cached-only gallery items under one article must not collapse onto its article URL",
);
const cachedGallerySnapshot = buildNewsSnapshot(cachedGalleryMerge.documents, {
  quotasBySource: { wire: mediaIdentityZeroQuotas },
});
assert.equal(
  cachedGallerySnapshot.detailShards
    .get(newsDetailShardForId(cachedGalleryArticle.id)).articles[cachedGalleryArticle.id].images.length,
  2,
  "both cached-only gallery items must remain attached in the detail shard",
);

const exactDuplicateImage = media("image", {
  ...cachedGalleryOne,
  id: "wire-cached-gallery-one-duplicate-id",
});
const exactDuplicateMerge = mergeFreshNewsDocuments([], [
  cachedGalleryArticle,
  cachedGalleryOne,
  exactDuplicateImage,
]);
assert.equal(
  exactDuplicateMerge.documents.filter((document) => document.mediaType === "image").length,
  1,
  "an exact media identity with only a regenerated id must dedupe deterministically",
);

const canonicalText = stringifyNewsDocumentsJsonl(merged.documents);
assert.deepEqual(parseNewsDocumentsJsonl(canonicalText), merged.documents);
assert.throws(() => parseNewsDocumentsJsonl("{not json}\n", "fixture"), /line 1 of fixture/u);
assert.throws(
  () => validateNewsDocuments([{ ...base, cachedThumbnailUrl: "/data/other/assets/wire/wrong.jpg" }]),
  /must live below \/data\/news\/assets\//u,
);
assert.throws(
  () => validateNewsDocuments([{ ...base, upstreamScore: 1 }]),
  /unknown field/u,
);
assert.throws(
  () => validateNewsDocuments([{ ...base, categoryOrders: { invented: 0 } }]),
  /unknown categoryOrders key/u,
);
assert.throws(
  () => validateNewsDocuments([{ ...base, categoryOrders: { domestic: -1 } }]),
  /invalid categoryOrders value/u,
);

const quotaFixture = createQuotaFixture();
const attachmentArticle = article({
  id: "wire-attachment",
  title: "첨부 사진 기사",
  date: "2026-08-22",
  categories: [],
});
const idImage = media("image", {
  id: "wire-attached-by-id",
  articleId: attachmentArticle.id,
  articleUrl: attachmentArticle.url,
  title: attachmentArticle.title,
  categories: [],
  displayOrder: 2,
});
const urlImage = media("image", {
  id: "wire-attached-by-url",
  articleUrl: `${attachmentArticle.url}/`,
  title: attachmentArticle.title,
  categories: [],
  displayOrder: 1,
});
const documents = [...quotaFixture, attachmentArticle, idImage, urlImage];
const readiness = assertNewsSectionQuotaReadiness(documents);
assert.equal(readiness.ready, true);
for (const result of readiness.results) assert.equal(result.count, result.minimum, `${result.section} quota`);

const snapshot = buildNewsSnapshot(documents);
const reversedSnapshot = buildNewsSnapshot([...documents].reverse());
assert.equal(snapshot.feed.version, reversedSnapshot.feed.version, "snapshot version must ignore input order");
assert.equal(snapshot.feedText, reversedSnapshot.feedText, "snapshot JSON must be deterministic");
assert.equal(snapshot.detailsText, reversedSnapshot.detailsText, "detail JSON must be deterministic");
assert.deepEqual(
  [...snapshot.detailShardTexts],
  [...reversedSnapshot.detailShardTexts],
  "detail shard JSON must be deterministic",
);
assert.deepEqual(
  [...snapshot.categoryPageTexts],
  [...reversedSnapshot.categoryPageTexts],
  "category page JSON must be deterministic",
);
assert.equal(
  snapshot.imageProxyAllowlistText,
  reversedSnapshot.imageProxyAllowlistText,
  "image proxy allowlist JSON must be deterministic",
);
assert.equal(snapshot.feed.generatedAt, "2026-08-22T00:00:00.000Z");
assert.match(snapshot.feed.version, /^[a-f0-9]{16}$/u);
assert.equal(snapshot.feed.version, snapshot.details.version);
assert.equal(snapshot.details.shardCount, NEWS_DETAIL_SHARD_COUNT);
assert.equal(snapshot.details.shardPattern, NEWS_DETAIL_SHARD_PUBLIC_PATTERN);
assert.equal(snapshot.details.articles, undefined, "the detail manifest must not embed every article");
assert.equal(snapshot.detailShards.size, NEWS_DETAIL_SHARD_COUNT);
assert.equal(newsDetailShardForId("wire-attachment"), "ca");
assert.equal(newsDetailShardForId("kcna-한글"), "b1", "the shard hash must use JavaScript UTF-16 code units");

const largeSourceFixture = [
  ...quotaFixture,
  ...Array.from({ length: 2_001 }, (_, index) => article({
    id: `wire-complete-${String(index).padStart(4, "0")}`,
    title: `전체 기사 ${index}`,
    date: "2026-08-22",
  })),
];
const largeSourceSnapshot = buildNewsSnapshot(largeSourceFixture);
assert.equal(
  largeSourceSnapshot.details.totalItems,
  largeSourceFixture.length,
  "detail shards must retain every record beyond the legacy 500/2,000-item boundaries",
);
assert.equal(
  [...largeSourceSnapshot.detailShards.values()]
    .reduce((total, shard) => total + Object.keys(shard.articles).length, 0),
  largeSourceFixture.length,
  "every selected record must appear in exactly one detail shard",
);
assert.equal(
  largeSourceSnapshot.feed.sources.wire.articles.length,
  new Set([...largeSourceSnapshot.readiness.assignments.get("wire").keys()]).size,
  "the homepage manifest must contain only deduplicated section previews",
);
assert.throws(
  () => buildNewsSnapshot(largeSourceFixture, { maxItemsPerSource: 2_000 }),
  /exceeding explicit maxItemsPerSource 2000/u,
  "an explicit cap must fail instead of silently slicing the archive",
);
assert.equal(DEFAULT_MAX_NEWS_ITEMS_PER_SOURCE, 20_000);

const feedArticles = snapshot.feed.sources.wire.articles;
for (const article of feedArticles) {
  assert.equal(
    article.detailUrl,
    `/news/document?id=${encodeURIComponent(article.id)}`,
    "detail URLs must remain stable across snapshot versions",
  );
}
const rolloverDocuments = documents.map((document, index) => (
  index === 0 ? { ...document, body: `${document.body}\n새 스냅샷 본문` } : document
));
const rolloverSnapshot = buildNewsSnapshot(rolloverDocuments);
assert.notEqual(rolloverSnapshot.feed.version, snapshot.feed.version, "the rollover fixture must change the snapshot version");
assert.equal(
  rolloverSnapshot.feed.sources.wire.articles.find((article) => article.id === feedArticles[0].id)?.detailUrl,
  feedArticles[0].detailUrl,
  "a retained article URL must not change when the snapshot version changes",
);
assert.deepEqual(
  feedArticles.map((item) => item.date),
  [...feedArticles.map((item) => item.date)].sort().reverse(),
  "feed must be latest first",
);
for (const section of NEWS_SECTION_IDS) {
  assert.equal(
    feedArticles.filter((item) => item.featuredSections.includes(section)).length,
    NEWS_SECTION_QUOTAS[section],
    `${section} feed quota`,
  );
}
const assigned = feedArticles.filter((item) => item.featuredSections.length);
for (const section of NEWS_SECTION_IDS) {
  const sectionTitles = assigned
    .filter((item) => item.featuredSections.includes(section))
    .map((item) => item.title);
  assert.equal(new Set(sectionTitles).size, sectionTitles.length, `${section} must deduplicate titles internally`);
}
assert.equal(feedArticles.some((item) => item.cachedThumbnailUrl.startsWith(NEWS_ASSET_PUBLIC_PREFIX)), true);
assert.equal(snapshot.feed.sources.wire.totalItems, quotaFixture.length + 1);
assert.equal(snapshot.feed.sources.wire.categoryCounts.important, NEWS_SECTION_QUOTAS.important);
const importantPageOne = snapshot.categoryPages.get("wire/important/page-1.json");
const importantPageTwo = snapshot.categoryPages.get("wire/important/page-2.json");
assert.equal(importantPageOne.pageSize, NEWS_CATEGORY_PAGE_SIZE);
assert.equal(importantPageOne.totalItems, NEWS_SECTION_QUOTAS.important);
assert.equal(importantPageOne.totalPages, 2);
assert.equal(importantPageOne.articles.length, 5);
assert.equal(importantPageTwo.articles.length, 1);
assert.deepEqual(
  [...importantPageOne.articles, ...importantPageTwo.articles].map((item) => item.date),
  [...importantPageOne.articles, ...importantPageTwo.articles].map((item) => item.date).sort().reverse(),
  "category shards must already be ordered newest first",
);
const photoPage = snapshot.categoryPages.get("wire/photo/page-1.json");
assert.equal(photoPage.articles.length, NEWS_SECTION_QUOTAS.photo);
assert.equal(
  photoPage.articles.every((item) => item.thumbnailUrl && item.cachedThumbnailUrl),
  true,
  "category rows must preserve remote and cached thumbnail fields",
);

const rodongSocialFixture = Array.from({ length: 5 }, (_, index) => article({
  id: `rodong-social-${index}`,
  sourceId: "rodong-sinmun",
  sourceName: "로동신문",
  title: `로동신문 사회문화 기사 ${index}`,
  url: `http://www.rodong.rep.kp/ko/index.php?OEAyMDI2MDgyMi0w${index}`,
  categories: ["social"],
}));
const rodongSnapshot = buildNewsSnapshot(rodongSocialFixture, { requireQuotaReady: false });
const rodongReadiness = rodongSnapshot.readiness.results.find((result) => (
  result.sourceId === "rodong-sinmun" && result.section === "social"
));
assert.deepEqual(
  { count: rodongReadiness.count, minimum: rodongReadiness.minimum },
  { count: 5, minimum: 4 },
  "Rodong social readiness must accept the official four-item floor while publishing all five design slots when available",
);
assert.deepEqual(
  Object.keys(rodongSnapshot.feed.sources["rodong-sinmun"].categoryCounts),
  NEWS_SOURCE_SECTION_IDS["rodong-sinmun"],
  "Rodong must publish only its eight official category counts",
);
assert.equal(
  rodongSnapshot.feed.sources["rodong-sinmun"].articles.filter((item) => (
    item.featuredSections.includes("social")
  )).length,
  5,
  "Rodong social homepage previews must fill all five design slots when official records exist",
);
for (const section of ["international", "document", "foreign"]) {
  assert.equal(
    [...rodongSnapshot.categoryPages.keys()].some((relativePath) => relativePath.includes(`/${section}/`)),
    false,
    `Rodong must not generate a non-official ${section} category shard`,
  );
}
for (const relativePath of rodongSnapshot.categoryPageTexts.keys()) {
  assert.equal(
    isCanonicalNewsGeneratedPath(`data/news/categories/${relativePath}`),
    true,
    `Rodong snapshot output must pass the release path gate: ${relativePath}`,
  );
}

const attachmentShard = newsDetailShardForId(attachmentArticle.id);
const attachmentDetail = snapshot.detailShards.get(attachmentShard).articles[attachmentArticle.id];
assert.equal(attachmentDetail.images.length, 2, "media must attach by exact article id and normalized article URL");
assert.deepEqual(
  attachmentDetail.images.map((image) => image.id),
  [urlImage.id, idImage.id],
  "attached media must respect displayOrder",
);
assert.equal(attachmentDetail.images.every((image) => image.cachedUrl.startsWith(NEWS_ASSET_PUBLIC_PREFIX)), true);
assert.equal(
  attachmentDetail.images.every((image) => image.refererUrl.startsWith(attachmentArticle.url)),
  true,
  "detail shards must preserve the official image referer",
);

const zeroQuotas = Object.fromEntries(NEWS_SECTION_IDS.map((section) => [section, 0]));
const kcnaOriginArticle = canonicalizeNewsDocument({
  ...article({ id: "kcna-origin-article" }),
  sourceId: "kcna",
  sourceName: "조선중앙통신",
  url: "http://www.kcna.kp/kp/article/detail/origin-article",
});
const kcnaOriginUrl = "http://www.kcna.kp/photo/0123456789abcdef0123456789abcdef";
const kcnaOriginImage = canonicalizeNewsDocument({
  ...media("image", { id: "kcna-origin-image" }),
  sourceId: "kcna",
  sourceName: "조선중앙통신",
  url: kcnaOriginUrl,
  articleId: kcnaOriginArticle.id,
  articleUrl: kcnaOriginArticle.url,
  cachedUrl: `${NEWS_ASSET_PUBLIC_PREFIX}kcna/${createHash("sha256").update("kcna-origin").digest("hex")}.jpg`,
  cachedThumbnailUrl: "",
});
const kcnaOriginSnapshot = buildNewsSnapshot([kcnaOriginArticle, kcnaOriginImage], {
  quotasBySource: { kcna: zeroQuotas },
});
assert.equal(
  kcnaOriginSnapshot.detailShards
    .get(newsDetailShardForId(kcnaOriginArticle.id)).articles[kcnaOriginArticle.id].images[0].url,
  kcnaOriginUrl,
  "KCNA extensionless official photo endpoints must remain available as provenance/fallback",
);
assert.equal(
  kcnaOriginSnapshot.imageProxyAllowlist.pairHashes.includes(
    hashPublishedNewsImagePair(kcnaOriginUrl, kcnaOriginArticle.url),
  ),
  true,
  "the exact published KCNA image/referer pair must be allowlisted",
);

const rodongOriginArticle = canonicalizeNewsDocument({
  ...article({ id: "rodong-origin-article" }),
  sourceId: "rodong-sinmun",
  sourceName: "로동신문",
  url: `http://www.rodong.rep.kp/ko/index.php?${Buffer.from("12@2026-08-22-001@1@1@@0@1@", "utf8").toString("base64")}`,
});
const rodongOriginUrl = `http://www.rodong.rep.kp/ko/index.php?${Buffer.from(
  "2@@@@p@0@2026/08/22/1/2026-08-22-001/2026-08-22-001.jpg",
  "utf8",
).toString("base64")}`;
const rodongOriginImage = canonicalizeNewsDocument({
  ...media("image", { id: "rodong-origin-image" }),
  sourceId: "rodong-sinmun",
  sourceName: "로동신문",
  url: rodongOriginUrl,
  articleId: rodongOriginArticle.id,
  articleUrl: rodongOriginArticle.url,
  cachedUrl: `${NEWS_ASSET_PUBLIC_PREFIX}rodong-sinmun/${createHash("sha256").update("rodong-origin").digest("hex")}.jpg`,
  cachedThumbnailUrl: "",
});
const rodongOriginSnapshot = buildNewsSnapshot([rodongOriginArticle, rodongOriginImage], {
  quotasBySource: { "rodong-sinmun": zeroQuotas },
});
assert.equal(
  rodongOriginSnapshot.detailShards
    .get(newsDetailShardForId(rodongOriginArticle.id)).articles[rodongOriginArticle.id].images[0].url,
  rodongOriginUrl,
  "Rodong official opaque image endpoints must remain available as provenance/fallback",
);
assert.equal(
  rodongOriginSnapshot.imageProxyAllowlist.pairHashes.includes(
    hashPublishedNewsImagePair(rodongOriginUrl, rodongOriginArticle.url),
  ),
  true,
  "the exact published Rodong image/referer pair must be allowlisted",
);

const rodongPhotoParent = canonicalizeNewsDocument({
  ...rodongOriginArticle,
  id: "rodong-photo-parent",
  url: rodongOriginUrl,
  categories: ["photo"],
});
const rodongPhotoLead = canonicalizeNewsDocument({
  ...rodongOriginImage,
  id: "rodong-photo-parent-image",
  url: rodongOriginUrl,
  articleId: rodongPhotoParent.id,
  articleUrl: rodongPhotoParent.url,
  cachedUrl: "",
});
const rodongPhotoSnapshot = buildNewsSnapshot([rodongPhotoParent, rodongPhotoLead], {
  quotasBySource: { "rodong-sinmun": zeroQuotas },
});
assert.equal(
  rodongPhotoSnapshot.detailShards
    .get(newsDetailShardForId(rodongPhotoParent.id)).articles[rodongPhotoParent.id].images[0].url,
  rodongOriginUrl,
  "an exact Rodong photo token must remain usable when it also identifies the synthetic photo parent",
);
assert.equal(
  rodongPhotoSnapshot.imageProxyAllowlist.pairHashes.includes(
    hashPublishedNewsImagePair(rodongOriginUrl, rodongOriginUrl),
  ),
  true,
  "the exact first-photo/self-referer pair must be published for photo-only records",
);

const articleUrlImage = canonicalizeNewsDocument({
  ...kcnaOriginImage,
  id: "kcna-article-url-image",
  url: kcnaOriginArticle.url,
  cachedUrl: `${NEWS_ASSET_PUBLIC_PREFIX}kcna/${createHash("sha256").update("article-url-image").digest("hex")}.jpg`,
});
const articleUrlSnapshot = buildNewsSnapshot([kcnaOriginArticle, articleUrlImage], {
  quotasBySource: { kcna: zeroQuotas },
});
assert.equal(
  articleUrlSnapshot.detailShards
    .get(newsDetailShardForId(kcnaOriginArticle.id)).articles[kcnaOriginArticle.id].images[0].url,
  "",
  "an article page URL must never be emitted as an image origin",
);

const duplicateTitleFixture = createQuotaFixture();
const duplicateDomestic = duplicateTitleFixture.find((document) => document.categories.includes("domestic"));
const duplicateSocial = duplicateTitleFixture.find((document) => document.categories.includes("social"));
duplicateSocial.title = duplicateDomestic.title;
assert.equal(
  assertNewsSectionQuotaReadiness(duplicateTitleFixture, { throwOnError: false }).ready,
  true,
  "the same official title may appear independently in different sections",
);

const duplicateWithinSectionFixture = createQuotaFixture();
const duplicateSocialRecords = duplicateWithinSectionFixture.filter((document) => document.categories.includes("social"));
duplicateSocialRecords[1].title = duplicateSocialRecords[0].title;
const duplicateWithinSectionReadiness = assertNewsSectionQuotaReadiness(duplicateWithinSectionFixture, { throwOnError: false });
assert.equal(duplicateWithinSectionReadiness.ready, false, "duplicate titles must not fill a section quota");
assert.deepEqual(
  duplicateWithinSectionReadiness.missing.map(({ sourceId, section, count, minimum }) => ({ sourceId, section, count, minimum })),
  [{ sourceId: "wire", section: "social", count: 4, minimum: 5 }],
);

const sharedRecord = article({
  id: "wire-shared-section-record",
  categories: ["important", "international"],
});
const sharedReadiness = assertNewsSectionQuotaReadiness([sharedRecord], {
  sectionQuotas: Object.fromEntries(NEWS_SECTION_IDS.map((section) => [
    section,
    ["important", "international"].includes(section) ? 1 : 0,
  ])),
});
assert.deepEqual(
  sharedReadiness.assignments.get("wire").get(sharedRecord.id),
  ["important", "international"],
  "one canonical record must remain featured in every exact official category it belongs to",
);

const officialOrderQuotas = Object.fromEntries(NEWS_SECTION_IDS.map((section) => [
  section,
  ["important", "domestic"].includes(section) ? 2 : 0,
]));
const officialOrderAlpha = article({
  id: "wire-official-alpha",
  title: "공식 순서 알파",
  date: "2026-08-22",
  categories: ["important", "domestic"],
  categoryOrders: { important: 1, domestic: 0 },
});
const officialOrderBeta = article({
  id: "wire-official-beta",
  title: "공식 순서 베타",
  date: "2026-08-22",
  categories: ["important", "domestic"],
  categoryOrders: { important: 0, domestic: 1 },
});
const officialOrderSnapshot = buildNewsSnapshot([officialOrderAlpha, officialOrderBeta], {
  sectionQuotas: officialOrderQuotas,
  quotasBySource: { wire: officialOrderQuotas },
});
assert.deepEqual(
  officialOrderSnapshot.categoryPages.get("wire/important/page-1.json").articles.map((item) => item.id),
  [officialOrderBeta.id, officialOrderAlpha.id],
  "same-date category rows must use that official category's rank before id",
);
assert.deepEqual(
  officialOrderSnapshot.categoryPages.get("wire/domestic/page-1.json").articles.map((item) => item.id),
  [officialOrderAlpha.id, officialOrderBeta.id],
  "one article may preserve a different official rank in another category",
);
assert.deepEqual(
  officialOrderSnapshot.feed.sources.wire.articles
    .find((item) => item.id === officialOrderAlpha.id).categoryOrders,
  { important: 1, domestic: 0 },
  "homepage previews must carry canonical category order metadata to the browser",
);

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "news-snapshot-shards-"));
try {
  const dataDir = path.join(temporaryRoot, "data");
  const documentsPath = path.join(dataDir, "news/documents.jsonl");
  const feedPath = path.join(dataDir, "news-feed.json");
  const detailsPath = path.join(dataDir, "news-details.json");
  await fs.mkdir(path.dirname(documentsPath), { recursive: true });
  await fs.writeFile(documentsPath, stringifyNewsDocumentsJsonl(documents), "utf8");
  const generated = await generateNewsFiles({ documentsPath, feedPath, detailsPath });
  assert.equal((await fs.readdir(generated.detailShardsDir)).filter((name) => name.endsWith(".json")).length, 256);
  assert.equal(
    JSON.parse(await fs.readFile(detailsPath, "utf8")).shardPattern,
    "/data/news/details/{shard}.json",
  );
  await generateNewsFiles({ documentsPath, feedPath, detailsPath, check: true });
  assert.equal(
    await fs.readFile(generated.imageProxyAllowlistPath, "utf8"),
    generated.imageProxyAllowlistText,
    "the generated compact allowlist must exactly match the canonical snapshot",
  );
  assert.deepEqual(
    [...loadPublishedNewsImagePairHashes(generated.imageProxyAllowlistPath)],
    generated.imageProxyAllowlist.pairHashes,
    "the runtime must load the exact sorted hashes emitted by the generator",
  );

  await fs.appendFile(generated.imageProxyAllowlistPath, " ", "utf8");
  await assert.rejects(
    generateNewsFiles({ documentsPath, feedPath, detailsPath, check: true }),
    /image-proxy-allowlist\.json is stale/u,
    "--check must byte-verify the image proxy allowlist",
  );
  await generateNewsFiles({ documentsPath, feedPath, detailsPath });

  const staleCategoryPath = path.join(generated.categoryPagesDir, "stale.json");
  await fs.writeFile(staleCategoryPath, "stale\n", "utf8");
  await assert.rejects(
    generateNewsFiles({ documentsPath, feedPath, detailsPath, check: true }),
    /is stale/u,
    "--check must reject an unexpected stale category page",
  );
  await generateNewsFiles({ documentsPath, feedPath, detailsPath });
  await assert.rejects(fs.access(staleCategoryPath), { code: "ENOENT" });

  const detailShardPath = path.join(generated.detailShardsDir, `${attachmentShard}.json`);
  await fs.appendFile(detailShardPath, " \n", "utf8");
  await assert.rejects(
    generateNewsFiles({ documentsPath, feedPath, detailsPath, check: true }),
    /is stale/u,
    "--check must byte-verify every detail shard",
  );
  await generateNewsFiles({ documentsPath, feedPath, detailsPath });
  await generateNewsFiles({ documentsPath, feedPath, detailsPath, check: true });
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Standalone news snapshot tests passed.");
