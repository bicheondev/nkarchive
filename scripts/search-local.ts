#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalJsonSearchProvider } from "../search/LocalJsonSearchProvider.js";
import { parseJsonl } from "../search/localIndex.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_DOCUMENTS_PATH = path.join(ROOT_DIR, "data/search/documents.jsonl");
const DEFAULT_SOURCES_PATH = path.join(ROOT_DIR, "data/search/sources.json");

async function main() {
  const query = getQuery();
  if (!query) {
    console.error('Usage: npm run search:local -- "검색어" [--tab all|image|pdf|video] [--source source-id] [--sort relevance|latest] (operators: AND, +term, OR, |, NOT, intitle:, allintitle:, title:, intext:, allintext:, inurl:, allinurl:, url:, site:/domain:/사이트:, source:/출처:, -site:, -source:, lang:/언어:, -lang:, filetype:/파일형식:, ext:, extension:, -filetype:, -ext:, after:/이후:, before:/이전:, date:/날짜:, daterange:/기간:, "phrase", -term)');
    process.exitCode = 1;
    return;
  }

  const [documents, sources] = await Promise.all([
    readJsonlFile(getArgumentValue("--documents") || DEFAULT_DOCUMENTS_PATH),
    readJsonFile(getArgumentValue("--sources") || DEFAULT_SOURCES_PATH, []),
  ]);
  const provider = new LocalJsonSearchProvider({ documents, sources });
  const sourceId = getArgumentValue("--source");
  const result = await provider.searchDocuments(query, {
    tab: getArgumentValue("--tab") || "all",
    sourceIds: sourceId ? [sourceId] : [],
    sort: getArgumentValue("--sort") || "relevance",
  });

  if (result.status === "empty_index") {
    console.log("아직 색인된 문서가 없습니다.");
    return;
  }
  if (!result.documents.length) {
    console.log("검색 결과가 없습니다.");
    return;
  }

  for (const document of result.documents) {
    console.log(`${document.score}\t${document.sourceName || document.displaySourceName}\t${document.title}`);
    console.log(`  ${document.url || document.archiveUrl}`);
  }
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

function getQuery() {
  const parts = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const part = process.argv[index];
    if (part === "--documents" || part === "--sources" || part === "--tab" || part === "--source" || part === "--sort") {
      index += 1;
      continue;
    }
    if (part.startsWith("--")) continue;
    parts.push(part);
  }
  return parts.join(" ").trim();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
