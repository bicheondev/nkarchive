#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DOCUMENTS_PATH = path.join(ROOT_DIR, "data", "search", "documents.jsonl");
const OUTPUT_PATH = path.join(ROOT_DIR, "data", "news-feed.json");
const DETAILS_OUTPUT_PATH = path.join(ROOT_DIR, "data", "news-details.json");
const MAX_ARTICLES_PER_SOURCE = 120;
const NEWS_SNAPSHOT_SCHEMA_VERSION = 3;
const SOURCE_DEFINITIONS = [
  { id: "kcna", name: "조선중앙통신" },
  { id: "rodong-sinmun", name: "로동신문" },
];

const documents = parseJsonl(fs.readFileSync(DOCUMENTS_PATH, "utf8"));
const selectedDocuments = Object.fromEntries(
  SOURCE_DEFINITIONS.map((source) => [source.id, selectSourceDocuments(source, documents)]),
);
const newestDate = SOURCE_DEFINITIONS.map(({ id }) => selectedDocuments[id][0]?.date || "")
  .sort()
  .at(-1);

if (!newestDate) {
  throw new Error("No Korean news articles were found in data/search/documents.jsonl");
}

const snapshotVersion = createHash("sha256")
  .update(`news-snapshot-schema:${NEWS_SNAPSHOT_SCHEMA_VERSION}\n`)
  .update(JSON.stringify(selectedDocuments))
  .digest("hex")
  .slice(0, 16);
const sources = Object.fromEntries(
  SOURCE_DEFINITIONS.map((source) => [
    source.id,
    buildSource(source, selectedDocuments[source.id], snapshotVersion),
  ]),
);

const feed = {
  generatedAt: `${newestDate}T00:00:00.000Z`,
  version: snapshotVersion,
  sources,
};
const details = {
  generatedAt: feed.generatedAt,
  version: snapshotVersion,
  articles: Object.fromEntries(
    SOURCE_DEFINITIONS.flatMap((source) =>
      selectedDocuments[source.id].map((document) => [document.id, toDetailArticle(document, source)]),
    ),
  ),
};

fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
fs.writeFileSync(DETAILS_OUTPUT_PATH, `${JSON.stringify(details, null, 2)}\n`, "utf8");
console.log(
  `Wrote data/news-feed.json with ${SOURCE_DEFINITIONS.map(
    ({ id }) => `${sources[id].articles.length} ${id} articles`,
  ).join(" and ")} and data/news-details.json with ${Object.keys(details.articles).length} article bodies.`,
);

function parseJsonl(text) {
  return String(text || "")
    .split(/\r?\n/u)
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch (error) {
        throw new Error(`Invalid JSON on line ${index + 1} of data/search/documents.jsonl`, {
          cause: error,
        });
      }
    });
}

function selectSourceDocuments(source, documents) {
  return documents
    .filter(
      (document) =>
        document?.sourceId === source.id && document?.language === "ko" && document?.mediaType === "article",
    )
    .sort((left, right) => compareDescending(left?.date, right?.date) || compareAscending(left?.id, right?.id))
    .slice(0, MAX_ARTICLES_PER_SOURCE);
}

function buildSource(source, documents, snapshotVersion) {
  return {
    id: source.id,
    name: source.name,
    articles: documents.map((document) => toFeedArticle(document, snapshotVersion)),
  };
}

function toFeedArticle(document, snapshotVersion) {
  const id = String(document?.id || "");
  const thumbnails = normalizeThumbnailPair(document);
  return {
    id,
    title: cleanArticleTitle(document?.title),
    date: String(document?.date || ""),
    snippet: String(document?.snippet || ""),
    url: String(document?.url || ""),
    ...thumbnails,
    detailUrl: `/news/document?id=${encodeURIComponent(id)}&v=${encodeURIComponent(snapshotVersion)}`,
  };
}

function toDetailArticle(document, source) {
  const id = String(document?.id || "");
  const thumbnails = normalizeThumbnailPair(document);
  return {
    id,
    sourceId: source.id,
    sourceName: source.name,
    title: cleanArticleTitle(document?.title),
    date: String(document?.date || ""),
    snippet: String(document?.snippet || ""),
    body: String(document?.body || ""),
    url: String(document?.url || ""),
    ...thumbnails,
  };
}

function normalizeThumbnailPair(document) {
  const thumbnailUrl = String(document?.thumbnailUrl || "").trim();
  if (!thumbnailUrl || isGenericSourceArtwork(thumbnailUrl)) {
    return { thumbnailUrl: "", cachedThumbnailUrl: "" };
  }
  return {
    thumbnailUrl,
    cachedThumbnailUrl: String(document?.cachedThumbnailUrl || "").trim(),
  };
}

function isGenericSourceArtwork(value) {
  try {
    const pathname = decodeURIComponent(new URL(value, "https://archive.invalid").pathname).toLocaleLowerCase("en-US");
    const fileName = pathname.split("/").at(-1) || "";
    return /(?:^|[-_.])(?:newsf|logo|mark|calendar|page[-_]?bottom|icon|arrow|button|banner|spacer|loader)(?:[-_.]|$)/iu.test(fileName);
  } catch {
    return true;
  }
}

function cleanArticleTitle(value) {
  return String(value || "")
    .replace(/\s*\[20\d{2}[./-]\d{2}[./-]\d{2}\.?\]\s*$/u, "")
    .trim();
}

function compareAscending(left, right) {
  const leftText = String(left || "");
  const rightText = String(right || "");
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

function compareDescending(left, right) {
  return compareAscending(right, left);
}
