#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildNewsSnapshot,
  parseNewsDocumentsJsonl,
} from "./news-snapshot.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_NEWS_DOCUMENTS_PATH = path.join(ROOT_DIR, "data/news/documents.jsonl");
export const DEFAULT_NEWS_FEED_PATH = path.join(ROOT_DIR, "data/news-feed.json");
export const DEFAULT_NEWS_DETAILS_PATH = path.join(ROOT_DIR, "data/news-details.json");
export const DEFAULT_NEWS_DETAIL_SHARDS_DIR = path.join(ROOT_DIR, "data/news/details");
export const DEFAULT_NEWS_CATEGORY_PAGES_DIR = path.join(ROOT_DIR, "data/news/categories");
export const DEFAULT_NEWS_SEARCH_INDEX_PATH = path.join(ROOT_DIR, "data/news/search-index.json");
export const DEFAULT_NEWS_IMAGE_PROXY_ALLOWLIST_PATH = path.join(ROOT_DIR, "data/news/image-proxy-allowlist.json");

export async function generateNewsFiles({
  documentsPath = DEFAULT_NEWS_DOCUMENTS_PATH,
  feedPath = DEFAULT_NEWS_FEED_PATH,
  detailsPath = DEFAULT_NEWS_DETAILS_PATH,
  detailShardsDir,
  categoryPagesDir,
  searchIndexPath,
  imageProxyAllowlistPath,
  check = false,
  requireQuotaReady = false,
} = {}) {
  const resolvedDocumentsPath = path.resolve(documentsPath);
  const resolvedFeedPath = path.resolve(feedPath);
  const resolvedDetailsPath = path.resolve(detailsPath);
  const generatedDataRoot = path.join(path.dirname(resolvedDetailsPath), "news");
  const resolvedDetailShardsDir = path.resolve(detailShardsDir || path.join(generatedDataRoot, "details"));
  const resolvedCategoryPagesDir = path.resolve(categoryPagesDir || path.join(generatedDataRoot, "categories"));
  const resolvedSearchIndexPath = path.resolve(searchIndexPath || path.join(generatedDataRoot, "search-index.json"));
  const resolvedImageProxyAllowlistPath = path.resolve(
    imageProxyAllowlistPath || path.join(generatedDataRoot, "image-proxy-allowlist.json"),
  );
  const documentsText = await fs.readFile(resolvedDocumentsPath, "utf8");
  const documents = parseNewsDocumentsJsonl(documentsText, path.relative(ROOT_DIR, resolvedDocumentsPath));
  const snapshot = buildNewsSnapshot(documents, { requireQuotaReady });
  const outputs = [
    [resolvedFeedPath, snapshot.feedText],
    [resolvedDetailsPath, snapshot.detailsText],
    [resolvedSearchIndexPath, snapshot.searchIndexText],
    [resolvedImageProxyAllowlistPath, snapshot.imageProxyAllowlistText],
  ];
  const detailShardFiles = new Map([...snapshot.detailShardTexts].map(([shard, text]) => [
    `${shard}.json`,
    text,
  ]));
  const categoryPageFiles = snapshot.categoryPageTexts;

  if (check) {
    for (const [filePath, expectedText] of outputs) {
      const currentText = await readOptionalText(filePath);
      if (currentText !== expectedText) {
        throw new Error(`${path.relative(ROOT_DIR, filePath)} is stale; run npm run generate:news`);
      }
    }
    await verifyGeneratedDirectory(resolvedDetailShardsDir, detailShardFiles);
    await verifyGeneratedDirectory(resolvedCategoryPagesDir, categoryPageFiles);
  } else {
    // Publish complete directories before the small manifests that reference
    // them. Directory replacement also prunes files from older snapshots.
    await replaceGeneratedDirectoryAtomic(resolvedDetailShardsDir, detailShardFiles);
    await replaceGeneratedDirectoryAtomic(resolvedCategoryPagesDir, categoryPageFiles);
    await Promise.all(outputs.map(([filePath, text]) => writeTextAtomic(filePath, text)));
  }

  return {
    ...snapshot,
    documentCount: documents.length,
    documentsPath: resolvedDocumentsPath,
    feedPath: resolvedFeedPath,
    detailsPath: resolvedDetailsPath,
    detailShardsDir: resolvedDetailShardsDir,
    categoryPagesDir: resolvedCategoryPagesDir,
    searchIndexPath: resolvedSearchIndexPath,
    imageProxyAllowlistPath: resolvedImageProxyAllowlistPath,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--require-quota-ready") options.requireQuotaReady = true;
    else if (argument === "--documents") options.documentsPath = requireValue(argv, ++index, argument);
    else if (argument === "--feed-out") options.feedPath = requireValue(argv, ++index, argument);
    else if (argument === "--details-out") options.detailsPath = requireValue(argv, ++index, argument);
    else if (argument === "--detail-shards-out") options.detailShardsDir = requireValue(argv, ++index, argument);
    else if (argument === "--category-pages-out") options.categoryPagesDir = requireValue(argv, ++index, argument);
    else if (argument === "--search-index-out") options.searchIndexPath = requireValue(argv, ++index, argument);
    else if (argument === "--image-proxy-allowlist-out") options.imageProxyAllowlistPath = requireValue(argv, ++index, argument);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function requireValue(argv, index, argument) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
  return value;
}

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function writeTextAtomic(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, text, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function verifyGeneratedDirectory(directoryPath, expectedFiles) {
  const actualFiles = await listRelativeFiles(directoryPath);
  const expectedPaths = [...expectedFiles.keys()].sort(compareText);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedPaths)) {
    throw new Error(`${path.relative(ROOT_DIR, directoryPath)} is stale; run npm run generate:news`);
  }
  for (const relativePath of expectedPaths) {
    const currentText = await readOptionalText(path.join(directoryPath, ...relativePath.split("/")));
    if (currentText !== expectedFiles.get(relativePath)) {
      throw new Error(`${path.relative(ROOT_DIR, path.join(directoryPath, relativePath))} is stale; run npm run generate:news`);
    }
  }
}

async function replaceGeneratedDirectoryAtomic(directoryPath, files) {
  const parentPath = path.dirname(directoryPath);
  const baseName = path.basename(directoryPath);
  const nonce = `${process.pid}.${Date.now()}`;
  const stagedPath = path.join(parentPath, `.${baseName}.${nonce}.tmp`);
  const backupPath = path.join(parentPath, `.${baseName}.${nonce}.old`);
  await fs.mkdir(parentPath, { recursive: true });
  await fs.rm(stagedPath, { recursive: true, force: true });
  await fs.mkdir(stagedPath, { recursive: true });
  try {
    for (const [relativePath, text] of files) {
      const filePath = path.join(stagedPath, ...relativePath.split("/"));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, text, "utf8");
    }
    let movedExisting = false;
    try {
      await fs.rename(directoryPath, backupPath);
      movedExisting = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(stagedPath, directoryPath);
    } catch (error) {
      if (movedExisting) await fs.rename(backupPath, directoryPath);
      throw error;
    }
    if (movedExisting) await fs.rm(backupPath, { recursive: true, force: true });
  } finally {
    await fs.rm(stagedPath, { recursive: true, force: true });
  }
}

async function listRelativeFiles(directoryPath) {
  const output = [];
  async function visit(currentPath, prefix) {
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else output.push(relativePath);
    }
  }
  await visit(directoryPath, "");
  return output.sort(compareText);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  generateNewsFiles(parseArguments(process.argv.slice(2)))
    .then((result) => {
      const action = process.argv.includes("--check") ? "Verified" : "Generated";
      console.log(`${action} standalone news snapshot ${result.feed.version} from ${result.documentCount} document(s).`);
    })
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    });
}
