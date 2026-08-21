#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const NEWS_REQUIRED_DEPLOY_FILES = [
  "index.html",
  "favicon.svg",
  "assets/fonts/PretendardVariable.woff2",
  "assets/news-arrow-forward-ios.svg",
  "assets/news-search-detail.svg",
  "assets/news-search-list.svg",
  "assets/news-section-line-453.svg",
  "assets/news-section-line-454.svg",
  "assets/news-share-link.svg",
  "news/index.html",
  "news/category/index.html",
  "news/category.css",
  "news/category.js",
  "news/document/index.html",
  "news/news.css",
  "news/news.js",
  "news/detail.js",
  "data/news-feed.json",
  "data/news-details.json",
  "data/news/documents.jsonl",
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
  ["/news/document", "/news/document/index.html"],
  ["/news/document/", "/news/document/index.html"],
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
    await assertReferencedNewsAssetsIncluded(rootDir, included);
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

async function assertReferencedNewsAssetsIncluded(rootDir, included) {
  const values = [
    JSON.parse(await fs.readFile(path.join(rootDir, "data/news-feed.json"), "utf8")),
    JSON.parse(await fs.readFile(path.join(rootDir, "data/news-details.json"), "utf8")),
    ...(await fs.readFile(path.join(rootDir, "data/news/documents.jsonl"), "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line)),
  ];
  const references = new Set();
  for (const value of values) collectNewsAssetReferences(value, references);
  for (const reference of references) {
    const relativePath = reference.slice(1);
    if (!included.has(relativePath)) {
      throw new Error(`Referenced news asset is missing from the Vercel bundle: ${relativePath}`);
    }
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
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
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

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
