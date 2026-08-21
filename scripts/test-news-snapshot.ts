#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  NEWS_ASSET_PUBLIC_PREFIX,
  NEWS_DOCUMENT_SCHEMA_VERSION,
  NEWS_SECTION_IDS,
  NEWS_SECTION_QUOTAS,
  assertNewsSectionQuotaReadiness,
  buildNewsSnapshot,
  canonicalizeNewsDocument,
  mergeFreshNewsDocuments,
  parseNewsDocumentsJsonl,
  stringifyNewsDocumentsJsonl,
  validateNewsDocuments,
} from "./news-snapshot.ts";

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
assert.equal(snapshot.feed.generatedAt, "2026-08-22T00:00:00.000Z");
assert.match(snapshot.feed.version, /^[a-f0-9]{16}$/u);
assert.equal(snapshot.feed.version, snapshot.details.version);

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

const attachmentDetail = snapshot.details.articles[attachmentArticle.id];
assert.equal(attachmentDetail.images.length, 2, "media must attach by exact article id and normalized article URL");
assert.deepEqual(
  attachmentDetail.images.map((image) => image.id),
  [urlImage.id, idImage.id],
  "attached media must respect displayOrder",
);
assert.equal(attachmentDetail.images.every((image) => image.cachedUrl.startsWith(NEWS_ASSET_PUBLIC_PREFIX)), true);

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

console.log("Standalone news snapshot tests passed.");
