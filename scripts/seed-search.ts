#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseJsonl, toStoredSearchSource, validateSearchIndex } from "../search/localIndex.js";
import { DEFAULT_SEARCH_INDEX_NAME, DEFAULT_SUGGESTION_INDEX_NAME } from "../search/SearchProvider.js";
import { getSearchableBodyText, getSearchableSnippetText } from "../search/documentSearch.js";
import { KNOWN_SEARCH_ENTITIES } from "../search/knownEntities.js";
import { normalizeWidthText, simplifyText } from "../search/normalizeQuery.js";
import { findRicherPreviewRecord } from "../search/previewEnrichment.js";
import { createResultStoryKey } from "../search/resultIdentity.js";
import { buildSuggestionEntries } from "../search/suggestions.js";
import { loadDotEnvFile } from "./script-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
export const DEFAULT_DOCUMENTS_PATH = path.join(ROOT_DIR, "data/search/documents.jsonl");
export const DEFAULT_SOURCES_PATH = path.join(ROOT_DIR, "data/search/sources.json");
export const DEFAULT_OUTPUT_PATH = path.join(ROOT_DIR, "data/search/meilisearch-seed.json");
const HANGUL_SEARCH_NGRAM_LENGTHS = [2, 3, 4];
const HANGUL_SEARCH_TOKEN_LIMIT = 240;

async function main() {
  loadDotEnvFile();
  const shouldWrite = process.argv.includes("--write");
  const documentsPath = getArgumentValue("--documents") || DEFAULT_DOCUMENTS_PATH;
  const sourcesPath = getArgumentValue("--sources") || DEFAULT_SOURCES_PATH;
  const outputPath = getArgumentValue("--out") || DEFAULT_OUTPUT_PATH;
  const payload = await buildSearchSeed({ documentsPath, sourcesPath });

  if (shouldWrite) {
    await writeSearchSeed(payload, outputPath);
    console.log(`Wrote Meilisearch seed payload to ${outputPath}`);
    return;
  }

  console.log(`Prepared search seed payload from indexed storage:`);
  console.log(`- documents: ${payload.documents.length}`);
  console.log(`- suggestions: ${payload.suggestions.length}`);
  console.log(`- sources: ${payload.sources.length}`);
  console.log("Run with --write to emit data/search/meilisearch-seed.json.");
}

export async function buildSearchSeed({
  documentsPath = DEFAULT_DOCUMENTS_PATH,
  sourcesPath = DEFAULT_SOURCES_PATH,
} = {}) {
  const [rawDocuments, rawSources] = await Promise.all([
    readJsonlFile(documentsPath),
    readJsonFile(sourcesPath, []),
  ]);
  const { documents, sources, errors } = validateSearchIndex(rawDocuments, rawSources);

  if (errors.length) {
    throw new Error(`Cannot prepare search seed. Validation failed with ${errors.length} error(s):\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }

  return {
    documentIndexName: process.env.MEILI_DOCUMENT_INDEX || DEFAULT_SEARCH_INDEX_NAME,
    suggestionIndexName: process.env.MEILI_SUGGESTION_INDEX || DEFAULT_SUGGESTION_INDEX_NAME,
    generatedAt: new Date().toISOString(),
    settings: buildMeilisearchSettings(),
    sources: sources.map(toStoredSearchSource),
    documents: documents.map((document) => addMeilisearchVisibilityFields(document, documents)),
    suggestions: buildMeilisearchSuggestions(documents, sources),
  };
}

export async function writeSearchSeed(payload, outputPath = DEFAULT_OUTPUT_PATH) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function buildMeilisearchSettings() {
  return {
    documents: {
      searchableAttributes: [
        "title",
        "searchSnippet",
        "searchBody",
        "normalizedText",
        "url",
        "archiveUrl",
        "cachedUrl",
        "thumbnailUrl",
        "cachedThumbnailUrl",
        "aliases",
        "sourceName",
        "displaySourceName",
      ],
      displayedAttributes: [
        "id",
        "title",
        "snippet",
        "body",
        "searchSnippet",
        "searchBody",
        "normalizedText",
        "previewText",
        "previewSourceName",
        "previewDocumentId",
        "date",
        "sourceId",
        "sourceName",
        "sourceType",
        "displaySourceId",
        "displaySourceName",
        "displaySourceType",
        "originalSourceUrl",
        "mediaType",
        "url",
        "archiveUrl",
        "thumbnailUrl",
        "cachedUrl",
        "cachedThumbnailUrl",
        "language",
        "aliases",
        "searchTabs",
        "visibleTabs",
        "integratedRank",
        "storyKey",
      ],
      filterableAttributes: [
        "sourceId",
        "displaySourceId",
        "sourceType",
        "displaySourceType",
        "mediaType",
        "date",
        "language",
        "searchTabs",
        "visibleTabs",
        "storyKey",
      ],
      distinctAttribute: "storyKey",
      sortableAttributes: [
        "integratedRank",
        "date",
        "displayOrder",
      ],
      rankingRules: [
        "words",
        "proximity",
        "attribute",
        "sort",
        "exactness",
      ],
      typoTolerance: {
        enabled: false,
      },
      synonyms: {},
    },
    suggestions: {
      searchableAttributes: [
        "label",
        "aliases",
      ],
      displayedAttributes: [
        "id",
        "label",
        "aliases",
        "type",
        "description",
        "sourceId",
        "sourceName",
        "sourceType",
        "mediaType",
        "documentId",
      ],
      filterableAttributes: [
        "type",
        "sourceId",
      ],
      rankingRules: [
        "words",
        "typo",
        "proximity",
        "attribute",
        "exactness",
      ],
      synonyms: buildKnownEntitySynonyms(),
    },
  };
}

export function addMeilisearchVisibilityFields(document, corpus = []) {
  const { searchFields, ...searchableDocument } = document;
  const previewRecord = findRicherPreviewRecord(searchableDocument, corpus);
  const previewText = cleanSeedPreviewText(previewRecord?.body || previewRecord?.snippet || "");
  const searchSnippet = getSearchableSnippetText(searchableDocument.snippet || "");
  const searchBody = getSearchableBodyText(searchableDocument.body || "");
  return {
    ...searchableDocument,
    aliases: createMeilisearchDocumentAliases(searchableDocument),
    searchSnippet,
    searchBody,
    normalizedText: createMeilisearchNormalizedText(searchableDocument, { searchSnippet, searchBody }),
    previewText,
    previewSourceName: previewRecord?.sourceName || "",
    previewDocumentId: previewRecord?.id || "",
    visibleTabs: getVisibleTabs(document),
    integratedRank: getIntegratedRank(document),
    storyKey: createResultStoryKey(searchableDocument) || searchableDocument.id,
  };
}

function createMeilisearchNormalizedText(document = {}, { searchSnippet = "", searchBody = "" } = {}) {
  const values = [
    document.title,
    searchSnippet || getSearchableSnippetText(document.snippet || ""),
    searchBody || getSearchableBodyText(document.body || ""),
    document.sourceName,
    document.displaySourceName,
    ...(Array.isArray(document.aliases) ? document.aliases : []),
  ].map(normalizeWidthText);
  return uniqueStrings([
    ...values,
    ...values.map(simplifyText),
    ...createHangulSearchTokens(values),
  ]).join(" ");
}

function createHangulSearchTokens(values = []) {
  const tokens = [];
  for (const value of values) {
    const sequences = String(value || "").match(/[가-힣]{2,}/g) || [];
    for (const sequence of sequences) {
      for (const length of HANGUL_SEARCH_NGRAM_LENGTHS) {
        if (sequence.length < length) continue;
        for (let index = 0; index <= sequence.length - length; index += 1) {
          tokens.push(sequence.slice(index, index + length));
          if (tokens.length >= HANGUL_SEARCH_TOKEN_LIMIT) return uniqueStrings(tokens);
        }
      }
    }
  }
  return uniqueStrings(tokens);
}

function cleanSeedPreviewText(text = "") {
  return String(text || "")
    .replace(/!\[([^\]]*)]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]*)]\([^)]+\)/g, "$1")
    .replace(/^\s*\/\s*/gm, "")
    .replace(/^(혁명활동소식|분야별기사|정치|경제|문화|국제|기사)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function createMeilisearchDocumentAliases(document = {}) {
  return uniqueStrings([
    ...(Array.isArray(document.aliases) ? document.aliases : []),
    ...extractDecoratedTitleAliases(document.title),
    ...extractDecoratedTitleAliases(document.snippet),
  ]).filter(isUsefulGeneratedAlias);
}

function extractDecoratedTitleAliases(text = "") {
  const aliases = [];
  const decoratedNamePattern = /[《〈「『“"]\s*([^》〉」』”"]{1,32}?)\s*[》〉」』”"]\s*([가-힣A-Za-z0-9]{1,4}?)(?=(?:은|는|이|가|을|를|의|에|에서|와|과|도|,|\.|\s|\)|$))/gu;
  let match;
  while ((match = decoratedNamePattern.exec(String(text || "")))) {
    aliases.push(simplifyText(`${match[1]}${match[2]}`));
  }
  return aliases;
}

function isUsefulGeneratedAlias(value = "") {
  const alias = String(value || "").trim();
  return alias.length >= 2 && alias.length <= 32;
}

function getIntegratedRank(document) {
  if (document.mediaType === "article") return 0;
  if (document.mediaType === "pdf") return 1;
  if (document.mediaType === "broadcast") return 2;
  if (document.mediaType === "image") return 3;
  if (document.mediaType === "video") return 4;
  return 9;
}

function getVisibleTabs(document) {
  const tabs = ["all"];
  if (Array.isArray(document.searchTabs) && document.searchTabs.length) {
    for (const tab of document.searchTabs.map(String).filter(Boolean)) tabs.push(tab);
    return [...new Set(tabs)];
  }
  if (document.mediaType === "image") tabs.push("image");
  if (document.mediaType === "pdf") tabs.push("pdf");
  if (document.mediaType === "video" || document.mediaType === "broadcast") tabs.push("video");
  return tabs;
}

export function buildMeilisearchSuggestions(documents, sources) {
  return buildSuggestionEntries(documents, sources).map((entry) => ({
    id: entry.id,
    label: entry.label,
    aliases: entry.aliases || [],
    type: entry.type,
    description: entry.description || "",
    sourceId: entry.sourceId || inferSuggestionSourceId(entry, documents, sources),
    sourceName: entry.sourceName || inferSuggestionSource(entry, documents, sources)?.name || "",
    sourceType: entry.sourceType || inferSuggestionSource(entry, documents, sources)?.sourceType || "",
    mediaType: entry.mediaType || "",
    documentId: entry.type === "document_title" ? String(entry.id || "").replace(/^title:/, "") : "",
  }));
}

function inferSuggestionSourceId(entry, documents, sources) {
  return inferSuggestionSource(entry, documents, sources)?.id || "";
}

function inferSuggestionSource(entry, documents, sources) {
  if (entry.type === "source") {
    return sources.find((source) => `source:${source.id || source.name}` === entry.id) || null;
  }
  if (entry.type === "document_title") {
    const document = documents.find((candidate) => `title:${candidate.id}` === entry.id);
    if (!document) return null;
    return sources.find((source) => source.id === document.sourceId || source.name === document.sourceName) || null;
  }
  return null;
}

function buildKnownEntitySynonyms() {
  return Object.fromEntries(KNOWN_SEARCH_ENTITIES.map((entity) => [
    entity.canonical,
    [entity.canonical, ...entity.aliases],
  ]));
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
