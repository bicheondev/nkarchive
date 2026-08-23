#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  NEWS_IMAGE_PAIR_HASH_ALGORITHM,
  NEWS_IMAGE_PAIR_HASH_VERSION,
} from "../lib/news-image-policy.js";
import { assertCanonicalNewsGeneratedPaths } from "./news-generated-paths.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const NEWS_REQUIRED_DEPLOY_FILES = [
  "index.html",
  "favicon.svg",
  "assets/fonts/PretendardVariable.woff2",
  "assets/news-arrow-forward-ios.svg",
  "assets/arca-channel.svg",
  "assets/discord-channel.svg",
  "assets/news-pagination-arrow-left.svg",
  "assets/news-search-detail.svg",
  "assets/news-search-list.svg",
  "assets/news-section-line-453.svg",
  "assets/news-section-line-454.svg",
  "assets/news-share-link.svg",
  "og.png",
  "api/news-comments.js",
  "api/news-document.js",
  "api/news-image.js",
  "lib/news-image-policy.js",
  "news/comments.js",
  "news/disclaimer.js",
  "news/header.js",
  "news/index.html",
  "news/category/index.html",
  "news/category.css",
  "news/category.js",
  "news/search/index.html",
  "news/search.css",
  "news/search.js",
  "news/youtube/index.html",
  "news/youtube.css",
  "news/youtube.js",
  "news/document-template.html",
  "news/news.css",
  "news/news.js",
  "news/detail.js",
  "data/news-feed.json",
  "data/news-details.json",
  "data/news/image-proxy-allowlist.json",
  "data/news/search-index.json",
  "data/news/youtube-videos.json",
  "package.json",
  "package-lock.json",
  "vercel.json",
];
const REQUIRED_DEPLOY_FILES = [
  ...NEWS_REQUIRED_DEPLOY_FILES,
  "search/index.html",
  "search/results/index.html",
  "search/document/index.html",
  "search/searchPortal.js",
  "search/search.css",
  "data/search/documents.jsonl",
  "data/search/sources.json",
  "data/search/source-health.json",
  "data/search/asset-cache-report.json",
  "api/search-asset.js",
  "api/search-live.js",
  "api/search-live-image.js",
  "search/LiveSearchFallbackProvider.js",
  "search/rodongLiveSearch.server.js",
];
const NEWS_FORBIDDEN_DEPLOY_FILES = [
  "assets/news-detail-hero.webp",
  "assets/news-list-image-1.webp",
  "assets/news-list-image-2.webp",
  "assets/news-list-image-3.webp",
  "assets/news-list-image-4.webp",
  "assets/news-list-image-5.webp",
  "data/news/documents.jsonl",
  ".env",
];
const FORBIDDEN_DEPLOY_FILES = [
  ...NEWS_FORBIDDEN_DEPLOY_FILES,
  "data/import/",
  "data/search/meilisearch-seed.json",
];
const NEWS_REQUIRED_REWRITES = new Map([
  ["/news", "/news/index.html"],
  ["/news/", "/news/index.html"],
  ["/news/category", "/news/category/index.html"],
  ["/news/category/", "/news/category/index.html"],
  ["/news/search", "/news/search/index.html"],
  ["/news/search/", "/news/search/index.html"],
  ["/news/youtube", "/news/youtube/index.html"],
  ["/news/youtube/", "/news/youtube/index.html"],
  ["/news/document", "/api/news-document"],
  ["/news/document/", "/api/news-document"],
]);
const REQUIRED_REWRITES = new Map([
  ...NEWS_REQUIRED_REWRITES,
  ["/search", "/search/index.html"],
  ["/search/", "/search/index.html"],
  ["/search/results", "/search/results/index.html"],
  ["/search/results/", "/search/results/index.html"],
  ["/search/document", "/search/document/index.html"],
  ["/search/document/", "/search/document/index.html"],
]);

async function main() {
  const scope = parseArguments(process.argv.slice(2));
  const result = await verifyVercelBundle({ scope });
  console.log(`Vercel ${scope} bundle verification passed:`);
  console.log(`- deployable files: ${result.includedFiles.length}`);
  console.log(`- deployable bytes: ${formatBytes(result.totalBytes)}`);
}

export async function verifyVercelBundle({
  rootDir = ROOT_DIR,
  ignoreText,
  scope = "all",
} = {}) {
  const normalizedScope = normalizeScope(scope);
  const requiredFiles = normalizedScope === "news" ? NEWS_REQUIRED_DEPLOY_FILES : REQUIRED_DEPLOY_FILES;
  const requiredRewrites = normalizedScope === "news" ? NEWS_REQUIRED_REWRITES : REQUIRED_REWRITES;
  const forbiddenFiles = normalizedScope === "news" ? NEWS_FORBIDDEN_DEPLOY_FILES : FORBIDDEN_DEPLOY_FILES;
  const ignoreRules = parseVercelIgnore(ignoreText ?? await readOptionalText(path.join(rootDir, ".vercelignore")));
  const includedFiles = [];
  let totalBytes = 0;
  const candidateFiles = normalizedScope === "news"
    ? await listNewsBundleCandidateFiles(rootDir)
    : await listFiles(rootDir);
  const candidateRelativePaths = candidateFiles.map((filePath) => toPosix(path.relative(rootDir, filePath)));
  if (normalizedScope === "news" || normalizedScope === "all") {
    assertCanonicalNewsGeneratedPaths(candidateRelativePaths.filter(isNewsGeneratedOwnedPath), {
      label: "News repository paths",
    });
  }

  for (const filePath of candidateFiles) {
    const relativePath = toPosix(path.relative(rootDir, filePath));
    if (!relativePath || shouldAlwaysSkip(relativePath)) continue;
    if (isIgnoredByRules(relativePath, ignoreRules)) continue;
    const stat = await fs.stat(filePath);
    includedFiles.push(relativePath);
    totalBytes += stat.size;
  }

  const included = new Set(includedFiles);
  for (const fileName of requiredFiles) {
    if (!included.has(fileName)) throw new Error(`Required Vercel deploy file is missing from the bundle: ${fileName}`);
  }
  const vercelConfig = JSON.parse(await fs.readFile(path.join(rootDir, "vercel.json"), "utf8"));
  if (normalizedScope === "news" || normalizedScope === "all") {
    const commentsFunction = vercelConfig.functions?.["api/news-comments.js"];
    if (commentsFunction?.maxDuration !== 30
      || commentsFunction?.includeFiles !== "data/news/details/*.json") {
      throw new Error("News comments function must include the published detail shards and use the bounded runtime");
    }
    const documentFunction = vercelConfig.functions?.["api/news-document.js"];
    if (documentFunction?.maxDuration !== 30
      || documentFunction?.includeFiles !== "{data/news/details/*.json,news/document-template.html}") {
      throw new Error("News document function must include its template and published detail shards within the bounded runtime");
    }
  }
  const rewriteMap = new Map((vercelConfig.rewrites || []).map((entry) => [entry.source, entry.destination]));
  for (const [source, destination] of requiredRewrites) {
    if (rewriteMap.get(source) !== destination) {
      throw new Error(`Vercel rewrite ${source} should point to ${destination}`);
    }
  }
  for (const fileName of forbiddenFiles) {
    const matched = fileName.endsWith("/")
      ? includedFiles.some((includedFile) => includedFile.startsWith(fileName))
      : included.has(fileName);
    if (matched) throw new Error(`Vercel deploy bundle should exclude ${fileName}`);
  }
  if (normalizedScope === "news" || normalizedScope === "all") {
    const publishedArticleIds = await assertNewsShardsIncluded(rootDir, included);
    await assertNewsSearchIndex(rootDir, included, publishedArticleIds);
    await assertNewsYouTubeIndex(rootDir, included);
    await assertNewsImageProxyAllowlist(rootDir, included);
    await assertReferencedNewsAssetsIncluded(rootDir, included, candidateRelativePaths);
    assertStaticNewsDataCacheHeader(vercelConfig, "/data/news/youtube-videos.json");
  }

  return {
    includedFiles,
    totalBytes,
  };
}

function parseArguments(argv) {
  let scope = "all";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--scope") scope = argv[++index] || "";
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return normalizeScope(scope);
}

function normalizeScope(value) {
  const scope = String(value || "").trim();
  if (!new Set(["all", "news"]).has(scope)) throw new Error(`Unsupported Vercel bundle scope: ${scope || "(empty)"}`);
  return scope;
}

export async function assertReferencedNewsAssetsIncluded(rootDir, included, candidateRelativePaths = []) {
  const values = [
    JSON.parse(await fs.readFile(path.join(rootDir, "data/news-feed.json"), "utf8")),
    JSON.parse(await fs.readFile(path.join(rootDir, "data/news-details.json"), "utf8")),
    ...(await fs.readFile(path.join(rootDir, "data/news/documents.jsonl"), "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line)),
  ];
  for (const relativePath of included) {
    if (!/^data\/news\/(?:details\/[a-f0-9]{2}|categories\/(?:kcna|rodong-sinmun)\/[a-z-]+\/page-[1-9][0-9]*)\.json$/u.test(relativePath)) continue;
    values.push(JSON.parse(await fs.readFile(path.join(rootDir, relativePath), "utf8")));
  }
  const references = new Set();
  for (const value of values) collectNewsAssetReferences(value, references);
  for (const reference of references) {
    const relativePath = reference.slice(1);
    if (!included.has(relativePath)) {
      throw new Error(`Referenced news asset is missing from the Vercel bundle: ${relativePath}`);
    }
  }
  for (const relativePath of candidateRelativePaths.filter(isCanonicalNewsAssetPath)) {
    if (!references.has(`/${relativePath}`)) {
      throw new Error(`Unreferenced news asset is present in the repository: ${relativePath}`);
    }
  }
}

export async function assertNewsImageProxyAllowlist(rootDir, included) {
  const relativePath = "data/news/image-proxy-allowlist.json";
  if (!included.has(relativePath)) throw new Error(`Required News image proxy allowlist is missing: ${relativePath}`);
  const text = await fs.readFile(path.join(rootDir, relativePath), "utf8");
  const payload = JSON.parse(text);
  const feed = JSON.parse(await fs.readFile(path.join(rootDir, "data/news-feed.json"), "utf8"));
  const expectedKeys = ["algorithm", "pairCount", "pairHashes", "schemaVersion", "snapshotVersion"];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("News image proxy allowlist has an invalid shape");
  }
  if (payload.schemaVersion !== NEWS_IMAGE_PAIR_HASH_VERSION
    || payload.algorithm !== NEWS_IMAGE_PAIR_HASH_ALGORITHM
    || !/^[a-f0-9]{16}$/u.test(String(payload.snapshotVersion || ""))
    || payload.snapshotVersion !== feed.version
    || !Number.isSafeInteger(payload.pairCount)
    || payload.pairCount < 0
    || !Array.isArray(payload.pairHashes)
    || payload.pairCount !== payload.pairHashes.length
    || payload.pairHashes.some((hash) => !/^[a-f0-9]{64}$/u.test(String(hash)))) {
    throw new Error("News image proxy allowlist metadata is invalid");
  }
  const normalizedHashes = [...new Set(payload.pairHashes)].sort(compareText);
  if (JSON.stringify(payload.pairHashes) !== JSON.stringify(normalizedHashes)) {
    throw new Error("News image proxy allowlist hashes must be sorted and unique");
  }
  if (text !== `${JSON.stringify(payload)}\n`) {
    throw new Error("News image proxy allowlist must use compact deterministic JSON");
  }
}

async function assertNewsShardsIncluded(rootDir, included) {
  const detailsManifest = JSON.parse(await fs.readFile(path.join(rootDir, "data/news-details.json"), "utf8"));
  if (detailsManifest.shardCount !== 256 || detailsManifest.shardPattern !== "/data/news/details/{shard}.json") {
    throw new Error("News detail shard manifest is invalid");
  }
  const publishedArticleIds = new Set();
  for (let index = 0; index < detailsManifest.shardCount; index += 1) {
    const shard = index.toString(16).padStart(2, "0");
    const relativePath = `data/news/details/${shard}.json`;
    if (!included.has(relativePath)) throw new Error(`Required News detail shard is missing: ${relativePath}`);
    const payload = JSON.parse(await fs.readFile(path.join(rootDir, relativePath), "utf8"));
    if (payload.version !== detailsManifest.version || payload.shard !== shard || !payload.articles) {
      throw new Error(`News detail shard is inconsistent: ${relativePath}`);
    }
    for (const articleId of Object.keys(payload.articles)) {
      if (publishedArticleIds.has(articleId)) throw new Error(`News detail id is duplicated across shards: ${articleId}`);
      publishedArticleIds.add(articleId);
    }
  }
  if (publishedArticleIds.size !== detailsManifest.totalItems) {
    throw new Error("News detail manifest total does not match the published shard union");
  }

  const feed = JSON.parse(await fs.readFile(path.join(rootDir, "data/news-feed.json"), "utf8"));
  for (const source of Object.values(feed.sources || {})) {
    for (const [section, totalItems] of Object.entries(source.categoryCounts || {})) {
      const totalPages = Math.max(1, Math.ceil(Number(totalItems) / 5));
      for (let page = 1; page <= totalPages; page += 1) {
        const relativePath = `data/news/categories/${source.id}/${section}/page-${page}.json`;
        if (!included.has(relativePath)) throw new Error(`Required News category page is missing: ${relativePath}`);
        const payload = JSON.parse(await fs.readFile(path.join(rootDir, relativePath), "utf8"));
        if (payload.version !== feed.version || payload.source?.id !== source.id || payload.section !== section
          || payload.page !== page || payload.totalItems !== totalItems || payload.pageSize !== 5) {
          throw new Error(`News category page is inconsistent: ${relativePath}`);
        }
      }
    }
  }
  return publishedArticleIds;
}

async function assertNewsSearchIndex(rootDir, included, publishedArticleIds) {
  const relativePath = "data/news/search-index.json";
  if (!included.has(relativePath)) throw new Error(`Required News search index is missing: ${relativePath}`);
  const text = await fs.readFile(path.join(rootDir, relativePath), "utf8");
  const payload = JSON.parse(text);
  const feed = JSON.parse(await fs.readFile(path.join(rootDir, "data/news-feed.json"), "utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.schemaVersion !== 1
    || payload.version !== feed.version
    || payload.generatedAt !== feed.generatedAt
    || !Number.isSafeInteger(payload.totalItems)
    || !Array.isArray(payload.articles)
    || payload.totalItems !== payload.articles.length
    || payload.totalItems !== publishedArticleIds.size) {
    throw new Error("News all-article search index metadata is invalid");
  }
  const ids = new Set();
  let previousDate = "9999-99-99";
  const expectedKeys = [
    "cachedThumbnailUrl", "date", "detailUrl", "id", "snippet",
    "sourceId", "sourceName", "thumbnailUrl", "title", "url",
  ];
  for (const article of payload.articles) {
    const keys = Object.keys(article || {}).sort(compareText);
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
      || !publishedArticleIds.has(article.id)
      || ids.has(article.id)
      || !/^(?:kcna|rodong-sinmun)$/u.test(String(article.sourceId || ""))
      || !/^20\d{2}-\d{2}-\d{2}$/u.test(String(article.date || ""))
      || article.date > previousDate
      || article.detailUrl !== `/news/document?id=${encodeURIComponent(article.id)}`) {
      throw new Error(`News all-article search entry is invalid: ${String(article?.id || "(missing)")}`);
    }
    ids.add(article.id);
    previousDate = article.date;
  }
  if (ids.size !== publishedArticleIds.size) throw new Error("News search index does not cover every published article exactly once");
  if (text !== `${JSON.stringify(payload)}\n`) throw new Error("News search index must use compact deterministic JSON");
}

async function assertNewsYouTubeIndex(rootDir, included) {
  const relativePath = "data/news/youtube-videos.json";
  if (!included.has(relativePath)) throw new Error(`Required News YouTube index is missing: ${relativePath}`);
  const text = await fs.readFile(path.join(rootDir, relativePath), "utf8");
  const payload = JSON.parse(text);
  const channelNames = new Set(["메아리", "supersuhui"]);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.schemaVersion !== 1
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(String(payload.generatedAt || ""))
    || !/^[a-f0-9]{16}$/u.test(String(payload.version || ""))
    || !Number.isSafeInteger(payload.totalItems)
    || payload.totalItems <= 0
    || !Array.isArray(payload.videos)
    || payload.totalItems !== payload.videos.length
    || !payload.channelCounts
    || Object.keys(payload.channelCounts).sort(compareText).join("\n") !== [...channelNames].sort(compareText).join("\n")) {
    throw new Error("News YouTube index metadata is invalid");
  }

  const ids = new Set();
  const channelCounts = { "메아리": 0, supersuhui: 0 };
  let previous = null;
  const expectedKeys = ["channelName", "date", "id", "publishedAt", "thumbnailUrl", "title", "url", "videoId"];
  for (const video of payload.videos) {
    const videoId = String(video?.videoId || "");
    const keys = Object.keys(video || {}).sort(compareText);
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
      || !/^[A-Za-z0-9_-]{11}$/u.test(videoId)
      || video.id !== `youtube-${videoId}`
      || ids.has(video.id)
      || !channelNames.has(video.channelName)
      || !String(video.title || "").trim()
      || !/^\d{4}-\d{2}-\d{2}$/u.test(String(video.date || ""))
      || !Number.isFinite(Date.parse(video.publishedAt))
      || video.date !== String(video.publishedAt).slice(0, 10)
      || video.url !== `https://www.youtube.com/watch?v=${videoId}`
      || video.thumbnailUrl !== `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`) {
      throw new Error(`News YouTube entry is invalid: ${String(video?.id || "(missing)")}`);
    }
    if (previous && (video.publishedAt > previous.publishedAt
      || (video.publishedAt === previous.publishedAt && videoId < previous.videoId))) {
      throw new Error(`News YouTube entries are not newest-first: ${video.id}`);
    }
    ids.add(video.id);
    channelCounts[video.channelName] += 1;
    previous = video;
  }
  for (const channelName of channelNames) {
    if (!Number.isSafeInteger(payload.channelCounts[channelName])
      || payload.channelCounts[channelName] <= 0
      || payload.channelCounts[channelName] !== channelCounts[channelName]) {
      throw new Error(`News YouTube channel count is invalid: ${channelName}`);
    }
  }
  if (text !== `${JSON.stringify(payload)}\n`) throw new Error("News YouTube index must use compact deterministic JSON");
}

function assertStaticNewsDataCacheHeader(vercelConfig, source) {
  const headerEntry = (vercelConfig.headers || []).find((entry) => entry.source === source);
  const cacheControl = (headerEntry?.headers || []).find((header) => header.key.toLowerCase() === "cache-control")?.value;
  if (cacheControl !== "public, max-age=0, s-maxage=60, stale-while-revalidate=60") {
    throw new Error(`News static data cache header is invalid: ${source}`);
  }
}

function collectNewsAssetReferences(value, references) {
  if (typeof value === "string") {
    if (!value.startsWith("/data/news/assets/")) return;
    if (!/^\/data\/news\/assets\/(?:kcna|rodong-sinmun)\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u.test(value)) {
      throw new Error(`Invalid news asset reference in deploy data: ${value}`);
    }
    references.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNewsAssetReferences(item, references);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectNewsAssetReferences(item, references);
  }
}

function isNewsGeneratedOwnedPath(relativePath) {
  return relativePath === "data/news-feed.json"
    || relativePath === "data/news-details.json"
    || relativePath.startsWith("data/news/");
}

function isCanonicalNewsAssetPath(relativePath) {
  return /^data\/news\/assets\/(?:kcna|rodong-sinmun)\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u.test(relativePath);
}

async function listNewsBundleCandidateFiles(rootDir) {
  const files = new Set();
  for (const directory of ["news", "data/news"]) {
    for (const filePath of await listOptionalFiles(path.join(rootDir, directory))) files.add(filePath);
  }
  const exactCandidates = new Set([
    ...NEWS_REQUIRED_DEPLOY_FILES,
    ...NEWS_FORBIDDEN_DEPLOY_FILES.filter((fileName) => !fileName.endsWith("/")),
  ]);
  for (const relativePath of exactCandidates) {
    const filePath = path.join(rootDir, relativePath);
    try {
      if ((await fs.stat(filePath)).isFile()) files.add(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return [...files].sort();
}

async function listOptionalFiles(dirPath) {
  try {
    return await listFiles(dirPath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export function parseVercelIgnore(text = "") {
  return String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function isIgnoredByRules(relativePath = "", rules = []) {
  return rules.some((rule) => ignoreRuleMatches(rule, relativePath));
}

function ignoreRuleMatches(rule = "", relativePath = "") {
  const posixRule = toPosix(rule);
  const anchored = posixRule.startsWith("/");
  const directoryOnly = posixRule.endsWith("/");
  const normalizedRule = posixRule.replace(/^\/+|\/+$/gu, "");
  if (!normalizedRule) return false;

  if (directoryOnly) {
    if (anchored || normalizedRule.includes("/")) {
      return relativePath.startsWith(normalizedRule + "/");
    }
    return relativePath.startsWith(normalizedRule + "/")
      || relativePath.includes("/" + normalizedRule + "/");
  }
  if (!normalizedRule.includes("/")) {
    return path.basename(relativePath) === normalizedRule
      || matchesSimpleGlob(normalizedRule, path.basename(relativePath));
  }
  return relativePath === normalizedRule || matchesSimpleGlob(normalizedRule, relativePath);
}

function matchesSimpleGlob(pattern = "", value = "") {
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function shouldAlwaysSkip(relativePath = "") {
  return relativePath.startsWith(".git/")
    || relativePath.startsWith("node_modules/")
    || relativePath.startsWith(".vercel/")
    || relativePath === ".DS_Store";
}

async function listFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && new Set([".git", ".vercel", "node_modules"]).has(entry.name)) continue;
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    } else {
      throw new Error(`Unexpected non-file entry in Vercel bundle candidates: ${entryPath}`);
    }
  }
  return files;
}

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function toPosix(value = "") {
  return String(value || "").split(path.sep).join("/");
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} TB`;
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), "en");
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
