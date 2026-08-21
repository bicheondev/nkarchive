#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_DOCUMENTS_PATH = path.join(ROOT_DIR, "data", "search", "documents.jsonl");
const DEFAULT_FEED_OUTPUT_PATH = path.join(ROOT_DIR, "data", "news-feed.json");
const DEFAULT_DETAILS_OUTPUT_PATH = path.join(ROOT_DIR, "data", "news-details.json");
const MAX_ARTICLES_PER_SOURCE = 120;
const MAX_IMAGES_PER_SOURCE = 24;
const MAX_VIDEOS_PER_SOURCE = 24;
const KCNA_ARTICLE_CATEGORY_LIMITS = Object.freeze({
  leadership: 6,
  important: 2,
  international: 2,
  anecdote: 5,
  document: 6,
  foreign: 6,
  memory: 5,
  domestic: 5,
  social: 5,
});
export const NEWS_SNAPSHOT_SCHEMA_VERSION = 4;
const SOURCE_DEFINITIONS = [
  { id: "kcna", name: "조선중앙통신" },
  { id: "rodong-sinmun", name: "로동신문" },
];

export function generateNewsSnapshot(documents) {
  const selectedDocuments = Object.fromEntries(
    SOURCE_DEFINITIONS.map((source) => [source.id, selectSourceDocuments(source, documents)]),
  );
  const mediaIndex = createArticleMediaIndex(documents);
  const selectedRecords = Object.fromEntries(
    SOURCE_DEFINITIONS.map((source) => [
      source.id,
      selectedDocuments[source.id].map((document) => buildNewsRecord(document, source, mediaIndex)),
    ]),
  );
  const newestDate = SOURCE_DEFINITIONS.map(({ id }) => selectedDocuments[id][0]?.date || "")
    .sort()
    .at(-1);

  if (!newestDate) {
    throw new Error("No Korean news articles were found in the search document corpus");
  }

  const snapshotMaterial = Object.fromEntries(
    SOURCE_DEFINITIONS.map(({ id }) => [
      id,
      selectedRecords[id].map(({ document, images, videos }) => ({ document, images, videos })),
    ]),
  );
  const snapshotVersion = createHash("sha256")
    .update(`news-snapshot-schema:${NEWS_SNAPSHOT_SCHEMA_VERSION}\n`)
    .update(JSON.stringify(snapshotMaterial))
    .digest("hex")
    .slice(0, 16);
  const sources = Object.fromEntries(
    SOURCE_DEFINITIONS.map((source) => [
      source.id,
      {
        id: source.id,
        name: source.name,
        articles: selectedRecords[source.id].map((record) => toFeedArticle(record, snapshotVersion)),
      },
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
        selectedRecords[source.id].map((record) => [record.document.id, toDetailArticle(record)]),
      ),
    ),
  };

  return {
    feed,
    details,
    feedText: `${JSON.stringify(feed, null, 2)}\n`,
    detailsText: `${JSON.stringify(details, null, 2)}\n`,
    selectedDocuments,
    snapshotMaterial,
  };
}

export function parseJsonl(text, sourceLabel = "JSONL input") {
  return String(text || "")
    .split(/\r?\n/u)
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch (error) {
        throw new Error(`Invalid JSON on line ${index + 1} of ${sourceLabel}`, { cause: error });
      }
    });
}

function selectSourceDocuments(source, documents) {
  const sourceDocuments = documents.filter(
    (document) => document?.sourceId === source.id && document?.language === "ko",
  );
  const articleCandidates = sourceDocuments
    .filter((document) => document?.mediaType === "article")
    .sort(compareDocumentsNewestFirst);
  const articles = source.id === "kcna"
    ? selectKcnaCategoryCompleteArticles(articleCandidates)
    : articleCandidates.slice(0, MAX_ARTICLES_PER_SOURCE);
  const imageCandidates = sourceDocuments
    .filter((document) =>
      document?.mediaType === "image"
      && (!document?.archiveUrl || normalizeArticleUrl(document.url) !== normalizeArticleUrl(document.archiveUrl)),
    )
    .sort(compareDocumentsNewestFirst);
  const images = source.id === "kcna"
    ? selectCategoryCompleteMedia(imageCandidates, "photo", 2, MAX_IMAGES_PER_SOURCE)
    : imageCandidates.slice(0, MAX_IMAGES_PER_SOURCE);
  const videoCandidates = sourceDocuments
    .filter((document) => document?.mediaType === "video")
    .sort(compareDocumentsNewestFirst);
  const videos = source.id === "kcna"
    ? selectCategoryCompleteMedia(videoCandidates, "video", 6, MAX_VIDEOS_PER_SOURCE)
    : videoCandidates.slice(0, MAX_VIDEOS_PER_SOURCE);
  return [...articles, ...images, ...videos].sort(compareDocumentsNewestFirst);
}

function selectKcnaCategoryCompleteArticles(articleCandidates = []) {
  const selected = new Map();
  for (const [category, limit] of Object.entries(KCNA_ARTICLE_CATEGORY_LIMITS)) {
    for (const document of articleCandidates) {
      if (selected.size >= MAX_ARTICLES_PER_SOURCE) break;
      if (!extractNewsCategories(document?.aliases).includes(category)) continue;
      const categoryCount = [...selected.values()].filter((candidate) => (
        extractNewsCategories(candidate?.aliases).includes(category)
      )).length;
      if (categoryCount >= limit) break;
      selected.set(document.id, document);
    }
  }
  for (const document of articleCandidates) {
    if (selected.size >= MAX_ARTICLES_PER_SOURCE) break;
    selected.set(document.id, document);
  }
  return [...selected.values()].sort(compareDocumentsNewestFirst);
}

function selectCategoryCompleteMedia(candidates = [], category, requiredCount, limit) {
  const categorized = candidates.filter((document) => extractNewsCategories(document?.aliases).includes(category));
  const selected = new Map(categorized.slice(0, requiredCount).map((document) => [document.id, document]));
  for (const document of candidates) {
    if (selected.size >= limit) break;
    selected.set(document.id, document);
  }
  return [...selected.values()].sort(compareDocumentsNewestFirst);
}

function createArticleMediaIndex(documents) {
  const index = new Map();
  for (const document of documents) {
    if (!document || !["image", "video"].includes(document.mediaType)) continue;
    const articleUrl = normalizeArticleUrl(document.archiveUrl || document.originalSourceUrl);
    if (!articleUrl || !document.sourceId) continue;
    const key = `${document.sourceId}\u0000${articleUrl}`;
    const bucket = index.get(key) || { images: [], videos: [] };
    if (document.mediaType === "image") bucket.images.push(document);
    if (document.mediaType === "video") bucket.videos.push(document);
    index.set(key, bucket);
  }
  for (const bucket of index.values()) {
    bucket.images.sort(compareMediaDocuments);
    bucket.videos.sort(compareMediaDocuments);
  }
  return index;
}

function buildNewsRecord(document, source, mediaIndex) {
  const id = String(document?.id || "");
  const key = `${source.id}\u0000${normalizeArticleUrl(document?.url || document?.archiveUrl)}`;
  const associatedMedia = mediaIndex.get(key) || { images: [], videos: [] };
  const images = dedupeImageDescriptors([
    ...associatedMedia.images.map(toImageDescriptor),
    ...imageDescriptorsFromDocument(document),
  ]);
  const videos = associatedMedia.videos.map(toVideoDescriptor).filter(Boolean);
  const lead = normalizeLeadPair(document, images);
  return {
    document: {
      id,
      title: cleanArticleTitle(document?.title),
      date: String(document?.date || ""),
      snippet: String(document?.snippet || ""),
      body: String(document?.body || ""),
      url: String(document?.url || document?.archiveUrl || ""),
      mediaType: ["image", "video"].includes(document?.mediaType) ? document.mediaType : "article",
      sourceId: source.id,
      sourceName: source.name,
      categories: extractNewsCategories(document?.aliases),
    },
    images,
    videos,
    lead,
  };
}

function toFeedArticle(record, snapshotVersion) {
  const { document, images, videos, lead } = record;
  return {
    id: document.id,
    title: document.title,
    date: document.date,
    snippet: document.snippet,
    url: document.url,
    mediaType: document.mediaType,
    categories: document.categories,
    hasImage: images.length > 0,
    hasVideo: document.mediaType === "video" || videos.length > 0,
    thumbnailUrl: lead.thumbnailUrl,
    cachedThumbnailUrl: lead.cachedThumbnailUrl,
    detailUrl: `/news/document?id=${encodeURIComponent(document.id)}&v=${encodeURIComponent(snapshotVersion)}`,
  };
}

function toDetailArticle(record) {
  const { document, images, videos, lead } = record;
  return {
    ...document,
    thumbnailUrl: lead.thumbnailUrl,
    cachedThumbnailUrl: lead.cachedThumbnailUrl,
    images,
    videos,
  };
}

function imageDescriptorsFromDocument(document) {
  if (document?.mediaType === "image") return [toImageDescriptor(document)];
  const thumbnailUrl = normalizeImageReference(document?.thumbnailUrl);
  const cachedThumbnailUrl = normalizeImageReference(document?.cachedThumbnailUrl, { allowLocal: true });
  if (!thumbnailUrl && !cachedThumbnailUrl) return [];
  return [{
    id: `${String(document?.id || "article")}-lead`,
    url: thumbnailUrl,
    cachedUrl: cachedThumbnailUrl,
    thumbnailUrl,
    cachedThumbnailUrl,
    displayOrder: 0,
  }];
}

function toImageDescriptor(document) {
  const archiveUrl = normalizeArticleUrl(document?.archiveUrl);
  const primaryOriginalCandidate = normalizeImageReference(document?.url);
  const primaryOriginal = isLikelyImageAssetUrl(primaryOriginalCandidate) ? primaryOriginalCandidate : "";
  const thumbnailOriginal = normalizeImageReference(document?.thumbnailUrl);
  const url = primaryOriginal && normalizeArticleUrl(primaryOriginal) !== archiveUrl
    ? primaryOriginal
    : thumbnailOriginal;
  const cachedUrl = normalizeImageReference(document?.cachedUrl, { allowLocal: true });
  const cachedThumbnailUrl = normalizeImageReference(document?.cachedThumbnailUrl, { allowLocal: true });
  if (!url && !cachedUrl && !thumbnailOriginal && !cachedThumbnailUrl) return null;
  return {
    id: String(document?.id || ""),
    url,
    cachedUrl,
    thumbnailUrl: thumbnailOriginal || url,
    cachedThumbnailUrl: cachedThumbnailUrl || cachedUrl,
    displayOrder: Number.isFinite(Number(document?.displayOrder)) ? Number(document.displayOrder) : 999,
  };
}

function toVideoDescriptor(document) {
  const url = String(document?.url || "").trim();
  if (!/^https?:\/\//iu.test(url)) return null;
  return {
    id: String(document?.id || ""),
    url,
    title: cleanArticleTitle(document?.title),
    displayOrder: Number.isFinite(Number(document?.displayOrder)) ? Number(document.displayOrder) : 999,
  };
}

function dedupeImageDescriptors(descriptors) {
  const seen = new Set();
  return descriptors
    .filter(Boolean)
    .sort((left, right) => left.displayOrder - right.displayOrder || compareAscending(left.id, right.id))
    .filter((descriptor) => {
      const identity = descriptor.cachedUrl || descriptor.cachedThumbnailUrl || descriptor.url || descriptor.thumbnailUrl;
      if (!identity || seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}

function normalizeLeadPair(document, images) {
  const thumbnailUrl = normalizeImageReference(document?.thumbnailUrl);
  const cachedThumbnailUrl = normalizeImageReference(document?.cachedThumbnailUrl, { allowLocal: true });
  if (thumbnailUrl || cachedThumbnailUrl) return { thumbnailUrl, cachedThumbnailUrl };
  const firstImage = images[0];
  return {
    thumbnailUrl: firstImage?.thumbnailUrl || firstImage?.url || "",
    cachedThumbnailUrl: firstImage?.cachedThumbnailUrl || firstImage?.cachedUrl || "",
  };
}

function normalizeImageReference(value, { allowLocal = false } = {}) {
  const candidate = String(value || "").trim();
  if (!candidate || isGenericSourceArtwork(candidate) || /^data:|^blob:|^javascript:/iu.test(candidate)) return "";
  if (/^https?:\/\//iu.test(candidate)) return candidate;
  if (allowLocal && /^\/(?:data\/search\/assets|cached\/search-assets)(?:\/|$)/u.test(candidate)) return candidate;
  return "";
}

function isLikelyImageAssetUrl(value = "") {
  const candidate = String(value || "");
  if (!candidate) return false;
  try {
    const pathname = new URL(candidate).pathname;
    return /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(pathname)
      || /\/image\/q\/[^/]+\.kcmsf$/iu.test(pathname)
      || /\/photo\/[a-f0-9]{16,}$/iu.test(pathname);
  } catch {
    return false;
  }
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

function extractNewsCategories(aliases) {
  return [...new Set((Array.isArray(aliases) ? aliases : [])
    .map((alias) => String(alias || "").match(/^news-category:([a-z-]+)$/u)?.[1] || "")
    .filter(Boolean))];
}

function normalizeArticleUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return candidate;
  }
}

function compareMediaDocuments(left, right) {
  const leftOrder = Number.isFinite(Number(left?.displayOrder)) ? Number(left.displayOrder) : 999;
  const rightOrder = Number.isFinite(Number(right?.displayOrder)) ? Number(right.displayOrder) : 999;
  return leftOrder - rightOrder || compareAscending(left?.id, right?.id);
}

function compareDocumentsNewestFirst(left, right) {
  return compareDescending(left?.date, right?.date) || compareAscending(left?.id, right?.id);
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

function parseCliArguments(argv) {
  const options = {
    documentsPath: DEFAULT_DOCUMENTS_PATH,
    feedOutputPath: DEFAULT_FEED_OUTPUT_PATH,
    detailsOutputPath: DEFAULT_DETAILS_OUTPUT_PATH,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    const nextValue = argv[index + 1];
    if (["--documents", "--feed-out", "--details-out"].includes(argument) && !nextValue) {
      throw new Error(`${argument} requires a path`);
    }
    if (argument === "--documents") options.documentsPath = path.resolve(nextValue);
    else if (argument === "--feed-out") options.feedOutputPath = path.resolve(nextValue);
    else if (argument === "--details-out") options.detailsOutputPath = path.resolve(nextValue);
    else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else continue;
    index += 1;
  }
  return options;
}

function writeOrCheck(filePath, expectedText, check) {
  if (check) {
    const currentText = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    if (currentText !== expectedText) throw new Error(`${path.relative(ROOT_DIR, filePath)} is stale; run npm run generate:news`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, expectedText, "utf8");
}

function main() {
  const options = parseCliArguments(process.argv.slice(2));
  const documents = parseJsonl(fs.readFileSync(options.documentsPath, "utf8"), options.documentsPath);
  const result = generateNewsSnapshot(documents);
  writeOrCheck(options.feedOutputPath, result.feedText, options.check);
  writeOrCheck(options.detailsOutputPath, result.detailsText, options.check);
  const sourceCounts = SOURCE_DEFINITIONS.map(
    ({ id }) => `${result.feed.sources[id].articles.length} ${id} items`,
  ).join(" and ");
  console.log(
    options.check
      ? `News snapshot is current (${sourceCounts}).`
      : `Wrote ${path.relative(ROOT_DIR, options.feedOutputPath)} and ${path.relative(ROOT_DIR, options.detailsOutputPath)} (${sourceCounts}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
