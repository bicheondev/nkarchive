#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonl, validateSearchIndex } from "../search/localIndex.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_DOCUMENTS_PATH = path.join(ROOT_DIR, "data/search/documents.jsonl");
const DEFAULT_SOURCES_PATH = path.join(ROOT_DIR, "data/search/sources.json");

async function main() {
  const documentsPath = getArgumentValue("--documents") || DEFAULT_DOCUMENTS_PATH;
  const sourcesPath = getArgumentValue("--sources") || DEFAULT_SOURCES_PATH;
  const [documents, sources] = await Promise.all([
    readJsonlFile(documentsPath),
    readJsonFile(sourcesPath, []),
  ]);
  const { errors } = validateSearchIndex(documents, sources);

  if (errors.length) {
    console.error(`Search index validation failed with ${errors.length} error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Search index validation passed: ${sources.length} sources, ${documents.length} documents.`);
}

async function readJsonlFile(filePath) {
  try {
    return parseJsonl(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function getArgumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
