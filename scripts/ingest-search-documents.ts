#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseJsonl,
  stringifyJsonl,
  toStoredSearchDocument,
  toStoredSearchSource,
  validateSearchIndex,
} from "../search/localIndex.js";
import { enrichArchiveOriginalSourceUrls } from "../search/originalSourceLinks.js";
import { SEARCH_SOURCES } from "../search/sourceConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_DOCUMENTS_PATH = path.join(ROOT_DIR, "data/search/documents.jsonl");
const DEFAULT_SOURCES_PATH = path.join(ROOT_DIR, "data/search/sources.json");

async function main() {
  const inputDocumentPaths = getArgumentValues("--documents")
    .concat(getArgumentValues("--input"))
    .flatMap(splitPathList);
  const documentPaths = inputDocumentPaths.length ? inputDocumentPaths : [DEFAULT_DOCUMENTS_PATH];
  const inputSourcesPath = getArgumentValue("--sources") || DEFAULT_SOURCES_PATH;
  const hasExplicitSourcesPath = Boolean(getArgumentValue("--sources"));
  const outputDocumentsPath = getArgumentValue("--out-documents") || DEFAULT_DOCUMENTS_PATH;
  const outputSourcesPath = getArgumentValue("--out-sources") || DEFAULT_SOURCES_PATH;

  const [rawDocumentGroups, rawSources] = await Promise.all([
    Promise.all(documentPaths.map(readDocumentInput)),
    hasExplicitSourcesPath ? readSourceInput(inputSourcesPath) : Promise.resolve(SEARCH_SOURCES),
  ]);
  const rawDocuments = enrichArchiveOriginalSourceUrls(rawDocumentGroups.flat());
  const { documents, sources, errors } = validateSearchIndex(rawDocuments, rawSources);

  if (errors.length) {
    console.error(`Search ingestion failed with ${errors.length} validation error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  await Promise.all([
    writeJsonl(outputDocumentsPath, documents.map(toStoredSearchDocument)),
    writeJson(outputSourcesPath, sources.map(toStoredSearchSource)),
  ]);

  console.log(`Ingested ${documents.length} documents and ${sources.length} sources.`);
  console.log(`- ${path.relative(ROOT_DIR, outputDocumentsPath)}`);
  console.log(`- ${path.relative(ROOT_DIR, outputSourcesPath)}`);
}

async function readDocumentInput(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    if (filePath.endsWith(".jsonl")) return parseJsonl(text);
    const parsed = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? parsed : parsed.documents || [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readSourceInput(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : parsed.sources || [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonl(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, stringifyJsonl(rows), "utf8");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function getArgumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function getArgumentValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

function splitPathList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
