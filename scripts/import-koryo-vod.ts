#!/usr/bin/env node
import crypto from "node:crypto";
import { SEARCH_SOURCES } from "../search/sourceConfig.js";
import {
  fetchTextResource,
  getArgumentValue,
  isRobotsAllowed,
  loadRobotsRules,
  parseImporterOptions,
  stripRuntimeSourceConfig,
  writeImportOutput,
} from "./search-crawler-utils.ts";
import { loadDotEnvFile } from "./script-env.ts";

export async function importKoryoVod() {
  loadDotEnvFile();
  const options = parseImporterOptions("koryo-vod.documents.jsonl");
  const sources = SEARCH_SOURCES.filter((source) => source.crawler?.importer === "koryo-vod");
  const source = sources[0];
  const { documents, report } = await fetchKoryoVodDocuments(source, options);
  await writeImportOutput({
    documents,
    sources: sources.map(stripRuntimeSourceConfig),
    reports: [report],
    outputPath: options.outputPath,
    sourcesPath: options.sourcesPath,
    reportPath: options.reportPath,
  });

  console.log(`Imported ${documents.length} real 고려TV VOD records for video search.`);
  console.log(`Documents: ${options.outputPath}`);
  console.log(`Report: ${options.reportPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  importKoryoVod()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export async function fetchKoryoVodDocuments(source, options) {
  if (!source) throw new Error("고려TV VOD source is not configured.");

  const requestedLimit = Math.max(1, Number(options.limitPerSource || 25));
  const pageSize = Math.min(Math.max(Number(getArgumentValue("--page-size") || requestedLimit), 1), 100);
  const report = { sourceId: source.id, sourceName: source.name, fetched: 0, indexed: 0, robotsDisallowed: 0, errors: [] };
  const documents = [];
  const robotsRules = await loadRobotsRules(source, { ...options, report });
  let nextUrl = `${source.crawler?.apiUrl || "https://vod.koryo.tv/api/v1/media"}?limit=${pageSize}`;

  while (nextUrl && documents.length < requestedLimit) {
    try {
      if (!isRobotsAllowed(nextUrl, source, robotsRules)) {
        reportRobotsSkip(report, nextUrl);
        break;
      }
      const payload = await fetchJson(nextUrl, options);
      report.fetched += 1;
      const results = Array.isArray(payload.results) ? payload.results : [];
      for (const item of results) {
        const document = mapKoryoVodItem(item, source);
        if (!document) continue;
        if (!isRobotsAllowed(document.url, source, robotsRules)) {
          reportRobotsSkip(report, document.url);
          continue;
        }
        documents.push(document);
        report.indexed += 1;
        if (documents.length >= requestedLimit) break;
      }
      nextUrl = payload.next || "";
    } catch (error) {
      report.errors.push(`${nextUrl}: ${error.message}`);
      break;
    }
  }

  return { documents: dedupeDocuments(documents), report };
}

async function fetchJson(url, {
  timeoutMs = 12000,
  useFetchCache = true,
  cacheDir,
  retries = 1,
  fetchTextResourceImpl = fetchTextResource,
} = {}) {
  const text = await fetchTextResourceImpl(url, {
    timeoutMs,
    accept: "application/json",
    useFetchCache,
    cacheDir,
    cacheNamespace: "json",
    retries,
  });
  return JSON.parse(text);
}

function reportRobotsSkip(report, url) {
  report.robotsDisallowed = (report.robotsDisallowed || 0) + 1;
  if (!Array.isArray(report.robotsSkippedUrls)) report.robotsSkippedUrls = [];
  if (report.robotsSkippedUrls.length < 12) report.robotsSkippedUrls.push(url);
}

function mapKoryoVodItem(item, source) {
  const title = cleanText(item.title);
  const url = cleanText(item.url);
  if (!title || !url || item.state !== "public") return null;

  const description = cleanText(item.description);
  const date = normalizeDate(item.add_date);
  const aliases = getTitleAliases(title);
  const duration = Number(item.duration || 0);
  const durationText = duration > 0 ? `상영시간 ${formatDuration(duration)}.` : "";
  const snippet = description || [title, durationText].filter(Boolean).join(" ");

  return {
    id: `koryo-vod-${cleanText(item.friendly_token) || hashText(url)}`,
    title,
    snippet,
    body: [title, description, aliases.join(" "), item.author_name, item.media_type].filter(Boolean).join(" "),
    date,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
    mediaType: "video",
    url,
    archiveUrl: "",
    thumbnailUrl: cleanText(item.thumbnail_url),
    language: detectLanguage([title, description].join(" ")),
    aliases,
    searchTabs: source.searchTabs || ["all", "video"],
  };
}

function getTitleAliases(title) {
  return [...new Set(String(title)
    .split(/\s+\/\s+|\/| - /)
    .map(cleanText)
    .filter((part) => part && part !== title && part.length >= 2))];
}

function detectLanguage(text) {
  const hasHangul = /[가-힣]/.test(text);
  const hasLatin = /[a-z]/i.test(text);
  if (hasHangul && hasLatin) return "multi";
  return hasLatin ? "en" : "ko";
}

function normalizeDate(value = "") {
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const remainingSeconds = Math.floor(total % 60);
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hashText(text) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function dedupeDocuments(documents) {
  return [...new Map(documents.map((document) => [document.id, document])).values()];
}
