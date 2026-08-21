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

export async function generateNewsFiles({
  documentsPath = DEFAULT_NEWS_DOCUMENTS_PATH,
  feedPath = DEFAULT_NEWS_FEED_PATH,
  detailsPath = DEFAULT_NEWS_DETAILS_PATH,
  check = false,
  requireQuotaReady = false,
} = {}) {
  const documentsText = await fs.readFile(path.resolve(documentsPath), "utf8");
  const documents = parseNewsDocumentsJsonl(documentsText, path.relative(ROOT_DIR, documentsPath));
  const snapshot = buildNewsSnapshot(documents, { requireQuotaReady });
  const outputs = [
    [path.resolve(feedPath), snapshot.feedText],
    [path.resolve(detailsPath), snapshot.detailsText],
  ];

  if (check) {
    for (const [filePath, expectedText] of outputs) {
      const currentText = await readOptionalText(filePath);
      if (currentText !== expectedText) {
        throw new Error(`${path.relative(ROOT_DIR, filePath)} is stale; run npm run generate:news`);
      }
    }
  } else {
    await Promise.all(outputs.map(([filePath, text]) => writeTextAtomic(filePath, text)));
  }

  return {
    ...snapshot,
    documentCount: documents.length,
    documentsPath: path.resolve(documentsPath),
    feedPath: path.resolve(feedPath),
    detailsPath: path.resolve(detailsPath),
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
