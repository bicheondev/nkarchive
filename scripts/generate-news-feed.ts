#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DOCUMENTS_PATH = path.join(ROOT_DIR, "data", "search", "documents.jsonl");
const OUTPUT_PATH = path.join(ROOT_DIR, "data", "news-feed.json");
const MAX_ARTICLES_PER_SOURCE = 120;
const SOURCE_DEFINITIONS = [
  { id: "kcna", name: "조선중앙통신" },
  { id: "rodong-sinmun", name: "로동신문" },
];

const documents = parseJsonl(fs.readFileSync(DOCUMENTS_PATH, "utf8"));
const sources = Object.fromEntries(
  SOURCE_DEFINITIONS.map((source) => [source.id, buildSource(source, documents)]),
);
const newestDate = SOURCE_DEFINITIONS.map(({ id }) => sources[id].articles[0]?.date || "")
  .sort()
  .at(-1);

if (!newestDate) {
  throw new Error("No Korean news articles were found in data/search/documents.jsonl");
}

const feed = {
  generatedAt: `${newestDate}T00:00:00.000Z`,
  sources,
};

fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
console.log(
  `Wrote data/news-feed.json with ${SOURCE_DEFINITIONS.map(
    ({ id }) => `${sources[id].articles.length} ${id} articles`,
  ).join(" and ")}.`,
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

function buildSource(source, documents) {
  const articles = documents
    .filter(
      (document) =>
        document?.sourceId === source.id && document?.language === "ko" && document?.mediaType === "article",
    )
    .sort((left, right) => compareDescending(left?.date, right?.date) || compareAscending(left?.id, right?.id))
    .slice(0, MAX_ARTICLES_PER_SOURCE)
    .map(toFeedArticle);

  return {
    id: source.id,
    name: source.name,
    articles,
  };
}

function toFeedArticle(document) {
  const id = String(document?.id || "");
  return {
    id,
    title: cleanArticleTitle(document?.title),
    date: String(document?.date || ""),
    snippet: String(document?.snippet || ""),
    url: String(document?.url || ""),
    thumbnailUrl: String(document?.thumbnailUrl || ""),
    cachedThumbnailUrl: String(document?.cachedThumbnailUrl || ""),
    detailUrl: `/search/document?id=${encodeURIComponent(id)}`,
  };
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
