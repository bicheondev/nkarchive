#!/usr/bin/env node
import * as cheerio from "cheerio";
import { SEARCH_SOURCES } from "../search/sourceConfig.js";
import {
  fetchTextResource,
  getArgumentValue,
  parseImporterOptions,
  stripRuntimeSourceConfig,
  writeImportOutput,
} from "./search-crawler-utils.ts";
import { loadDotEnvFile } from "./script-env.ts";

export async function importYouTubeMetadata() {
  loadDotEnvFile();
  const options = parseImporterOptions("youtube-metadata.documents.jsonl");
  const sources = SEARCH_SOURCES.filter((source) => source.crawler?.importer === "youtube-metadata");
  const reports = [];
  const documents = [];

  for (const source of sources) {
    const { documents: sourceDocuments, report } = await fetchYouTubeFeedDocuments(source, options);
    documents.push(...sourceDocuments);
    reports.push(report);
  }

  await writeImportOutput({
    documents,
    sources: sources.map(stripRuntimeSourceConfig),
    reports,
    outputPath: options.outputPath,
    sourcesPath: options.sourcesPath,
    reportPath: options.reportPath,
  });

  console.log(`Imported ${documents.length} YouTube video metadata records.`);
  console.log(`Documents: ${options.outputPath}`);
  console.log(`Report: ${options.reportPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  importYouTubeMetadata()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export async function fetchYouTubeFeedDocuments(source, options = {}) {
  const requestedLimit = Math.max(1, Number(options.limitPerSource || getArgumentValue("--limit") || 25));
  const report = { sourceId: source.id, sourceName: source.name, fetched: 0, indexed: 0, errors: [] };
  const documents = [];
  const channels = getYouTubeChannels(source);
  const seedVideos = getYouTubeSeedVideos(source);
  const fetchTextResourceImpl = options.fetchTextResourceImpl || fetchTextResource;

  if (!channels.length) {
    report.errors.push("missing YouTube channelId/feedUrl");
  }

  for (const channel of channels) {
    try {
      const xml = await fetchTextResourceImpl(channel.feedUrl, {
        timeoutMs: options.timeoutMs || 12000,
        accept: "application/atom+xml,application/xml,text/xml,*/*;q=0.8",
        useFetchCache: options.useFetchCache !== false,
        cacheDir: options.cacheDir,
        cacheNamespace: "youtube-feed",
        retries: options.retries ?? 1,
      });
      report.fetched += 1;
      documents.push(...parseYouTubeFeed(xml, source, channel).slice(0, requestedLimit));
    } catch (error) {
      report.errors.push(`${channel.feedUrl}: ${error.message}`);
    }
  }

  for (const seedVideo of seedVideos) {
    try {
      const document = await fetchYouTubeSeedVideoDocument(seedVideo, source, {
        ...options,
        fetchTextResourceImpl,
      });
      if (document) documents.push(document);
    } catch (error) {
      report.errors.push(`${seedVideo.url}: ${error.message}`);
    }
  }

  const dedupedDocuments = dedupeDocuments(documents);
  report.indexed = dedupedDocuments.length;
  return { documents: dedupedDocuments, report };
}

function getYouTubeChannels(source = {}) {
  const configuredChannels = Array.isArray(source.crawler?.channels) ? source.crawler.channels : [];
  const channels = configuredChannels.length ? configuredChannels : [{
    name: source.name,
    entryUrl: source.crawler?.entryUrl || source.baseUrl || "",
    channelId: source.crawler?.channelId || "",
    feedUrl: source.crawler?.feedUrl || "",
    aliases: source.aliases || [],
  }];

  return channels.map((channel) => {
    const channelId = cleanText(channel.channelId);
    const feedUrl = cleanText(channel.feedUrl) || (channelId ? `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}` : "");
    return {
      name: cleanText(channel.name || source.name),
      entryUrl: cleanText(channel.entryUrl || source.crawler?.entryUrl || source.baseUrl || ""),
      channelId,
      feedUrl,
      aliases: Array.isArray(channel.aliases) ? channel.aliases.map(cleanText).filter(Boolean) : [],
    };
  }).filter((channel) => channel.channelId && channel.feedUrl);
}

function getYouTubeSeedVideos(source = {}) {
  const videos = Array.isArray(source.crawler?.seedVideos) ? source.crawler.seedVideos : [];
  return videos
    .map((video) => {
      const item = typeof video === "string" ? { url: video } : (video || {});
      const videoId = getYouTubeVideoId(item.url || item.videoId || "");
      if (!videoId) return null;
      return {
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: cleanText(item.title || ""),
        description: cleanText(item.description || ""),
        date: cleanText(item.date || ""),
        channelName: cleanText(item.channelName || item.authorName || ""),
        aliases: Array.isArray(item.aliases) ? item.aliases.map(cleanText).filter(Boolean) : [],
      };
    })
    .filter(Boolean);
}

async function fetchYouTubeSeedVideoDocument(seedVideo, source, {
  timeoutMs = 12000,
  useFetchCache = true,
  cacheDir,
  retries = 1,
  fetchTextResourceImpl = fetchTextResource,
} = {}) {
  const oembedUrl = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(seedVideo.url)}`;
  const oembed = JSON.parse(await fetchTextResourceImpl(oembedUrl, {
    timeoutMs,
    accept: "application/json,*/*;q=0.8",
    useFetchCache,
    cacheDir,
    cacheNamespace: "youtube-oembed",
    retries,
  }));
  let watchMetadata = {};
  try {
    const watchHtml = await fetchTextResourceImpl(seedVideo.url, {
      timeoutMs,
      accept: "text/html,*/*;q=0.8",
      useFetchCache,
      cacheDir,
      cacheNamespace: "youtube-watch",
      retries,
    });
    watchMetadata = extractYouTubeWatchMetadata(watchHtml);
  } catch {
    watchMetadata = {};
  }

  return createYouTubeDocument({
    videoId: seedVideo.videoId,
    title: cleanText(seedVideo.title || oembed.title || watchMetadata.title),
    description: cleanText(seedVideo.description || watchMetadata.description || ""),
    date: normalizeDate(seedVideo.date || watchMetadata.date || ""),
    url: seedVideo.url,
    thumbnailUrl: cleanText(oembed.thumbnail_url || `https://i.ytimg.com/vi/${seedVideo.videoId}/hqdefault.jpg`),
    source,
    channel: {
      name: seedVideo.channelName || cleanText(oembed.author_name || ""),
      aliases: seedVideo.aliases,
    },
  });
}

function extractYouTubeWatchMetadata(html = "") {
  const title = unescapeJsonString(String(html).match(/"title":"([^"]+)"/)?.[1] || "");
  const description = unescapeJsonString(String(html).match(/"shortDescription":"([\s\S]*?)","isCrawlable"/)?.[1] || "");
  const date = String(html).match(/"publishDate":"([^"]+)"/)?.[1]
    || String(html).match(/"datePublished":"([^"]+)"/)?.[1]
    || "";
  return { title, description, date };
}

function createYouTubeDocument({
  videoId,
  title,
  description = "",
  date = "",
  url = "",
  thumbnailUrl = "",
  source,
  channel = {},
}) {
  if (!videoId || !title || !url) return null;

  const aliases = uniqueStrings([
    source.name,
    channel.name,
    ...(channel.aliases || []),
  ]);
  const snippet = description || title;
  return {
    id: `${source.id}-${videoId}`,
    title,
    snippet,
    body: [title, description, aliases.join(" ")].filter(Boolean).join(" "),
    date: normalizeDate(date),
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
    mediaType: "video",
    url,
    archiveUrl: "",
    thumbnailUrl,
    language: detectLanguage([title, description].join(" "), source),
    aliases,
    searchTabs: source.searchTabs || ["all", "video"],
  };
}

export function parseYouTubeFeed(xml = "", source, channel = {}) {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $("entry").toArray().map((entry) => {
    const node = $(entry);
    const videoId = cleanText(node.find("yt\\:videoId, videoId").first().text());
    const title = cleanText(node.find("title").first().text());
    const description = cleanText(node.find("media\\:description, description").first().text());
    const published = cleanText(node.find("published").first().text() || node.find("updated").first().text());
    const url = cleanText(node.find("link[rel='alternate']").first().attr("href")) || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
    const thumbnailUrl = cleanText(node.find("media\\:thumbnail, thumbnail").first().attr("url")) || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "");
    if (!videoId || !title || !url) return null;

    return createYouTubeDocument({
      videoId,
      title,
      date: normalizeDate(published),
      url,
      thumbnailUrl,
      description,
      source,
      channel,
    });
  }).filter(Boolean);
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function detectLanguage(text = "", source = {}) {
  const value = String(text || "");
  const hasHangul = /[가-힣]/.test(value);
  const hasKana = /[\u3040-\u30ff]/.test(value);
  const hasHan = /[\u3400-\u9fff]/.test(value);
  const hasLatin = /[a-z]/i.test(value);
  const detected = [];
  if (hasHangul) detected.push("ko");
  if (hasKana) detected.push("ja");
  if (hasHan && !hasHangul && !hasKana) detected.push("zh");
  if (hasLatin) detected.push("en");
  if (detected.length === 1) return detected[0];
  if (detected.length > 1) return "multi";
  return source.languages?.[0] || "unknown";
}

function normalizeDate(value = "") {
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getYouTubeVideoId(value = "") {
  const text = cleanText(value);
  if (/^[a-zA-Z0-9_-]{11}$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.hostname.includes("youtu.be")) return cleanText(url.pathname.split("/").filter(Boolean)[0] || "");
    if (url.searchParams.get("v")) return cleanText(url.searchParams.get("v"));
    const embedMatch = url.pathname.match(/\/(?:embed|shorts)\/([a-zA-Z0-9_-]{11})/);
    return embedMatch?.[1] || "";
  } catch {
    return "";
  }
}

function unescapeJsonString(value = "") {
  return String(value || "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function dedupeDocuments(documents = []) {
  return [...new Map(documents.filter(Boolean).map((document) => [document.id, document])).values()];
}
