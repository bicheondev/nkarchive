#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const REQUIRED_DEPLOY_FILES = [
  "index.html",
  "search/index.html",
  "search/results/index.html",
  "search/document/index.html",
  "search/searchPortal.js",
  "search/search.css",
  "news/index.html",
  "news/document/index.html",
  "news/news.css",
  "news/news.js",
  "news/detail.js",
  "data/news-feed.json",
  "data/news-details.json",
  "data/search/documents.jsonl",
  "data/search/sources.json",
  "data/search/source-health.json",
  "data/search/asset-cache-report.json",
  "api/search-asset.js",
  "api/search-live.js",
  "api/search-live-image.js",
  "search/LiveSearchFallbackProvider.js",
  "search/rodongLiveSearch.server.js",
  "vercel.json",
];
const FORBIDDEN_DEPLOY_FILES = [
  "assets/news-detail-hero.webp",
  "assets/news-list-image-1.webp",
  "assets/news-list-image-2.webp",
  "assets/news-list-image-3.webp",
  "assets/news-list-image-4.webp",
  "assets/news-list-image-5.webp",
  "data/import/",
  "data/search/meilisearch-seed.json",
  ".env",
];
const REQUIRED_REWRITES = new Map([
  ["/search", "/search/index.html"],
  ["/search/", "/search/index.html"],
  ["/search/results", "/search/results/index.html"],
  ["/search/results/", "/search/results/index.html"],
  ["/search/document", "/search/document/index.html"],
  ["/search/document/", "/search/document/index.html"],
  ["/news", "/news/index.html"],
  ["/news/", "/news/index.html"],
  ["/news/document", "/news/document/index.html"],
  ["/news/document/", "/news/document/index.html"],
]);

async function main() {
  const result = await verifyVercelBundle();
  console.log("Vercel bundle verification passed:");
  console.log(`- deployable files: ${result.includedFiles.length}`);
  console.log(`- deployable bytes: ${formatBytes(result.totalBytes)}`);
}

export async function verifyVercelBundle({
  rootDir = ROOT_DIR,
  ignoreText,
} = {}) {
  const ignoreRules = parseVercelIgnore(ignoreText ?? await readOptionalText(path.join(rootDir, ".vercelignore")));
  const includedFiles = [];
  let totalBytes = 0;

  for (const filePath of await listFiles(rootDir)) {
    const relativePath = toPosix(path.relative(rootDir, filePath));
    if (!relativePath || shouldAlwaysSkip(relativePath)) continue;
    if (isIgnoredByRules(relativePath, ignoreRules)) continue;
    const stat = await fs.stat(filePath);
    includedFiles.push(relativePath);
    totalBytes += stat.size;
  }

  const included = new Set(includedFiles);
  for (const fileName of REQUIRED_DEPLOY_FILES) {
    if (!included.has(fileName)) throw new Error(`Required Vercel deploy file is missing from the bundle: ${fileName}`);
  }
  const vercelConfig = JSON.parse(await fs.readFile(path.join(rootDir, "vercel.json"), "utf8"));
  const rewriteMap = new Map((vercelConfig.rewrites || []).map((entry) => [entry.source, entry.destination]));
  for (const [source, destination] of REQUIRED_REWRITES) {
    if (rewriteMap.get(source) !== destination) {
      throw new Error(`Vercel rewrite ${source} should point to ${destination}`);
    }
  }
  for (const fileName of FORBIDDEN_DEPLOY_FILES) {
    const matched = fileName.endsWith("/")
      ? includedFiles.some((includedFile) => includedFile.startsWith(fileName))
      : included.has(fileName);
    if (matched) throw new Error(`Vercel deploy bundle should exclude ${fileName}`);
  }

  return {
    includedFiles,
    totalBytes,
  };
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
  const normalizedRule = toPosix(rule).replace(/^\/+/u, "");
  if (!normalizedRule) return false;
  if (normalizedRule.endsWith("/")) return relativePath.startsWith(normalizedRule);
  if (!normalizedRule.includes("/")) return path.basename(relativePath) === normalizedRule || matchesSimpleGlob(normalizedRule, path.basename(relativePath));
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
