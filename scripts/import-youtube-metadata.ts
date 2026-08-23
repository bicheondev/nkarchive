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
  const report = {
    sourceId: source.id,
    sourceName: source.name,
    fetched: 0,
    searchFetched: 0,
    searchCandidates: 0,
    indexed: 0,
    errors: [],
  };
  const documents = [];
  const channels = getYouTubeChannels(source);
  const seedVideos = getYouTubeSeedVideos(source);
  const searchTargets = getYouTubeSearchTargets(source, channels);
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

  const searchTargetConcurrency = getPositiveInteger(source.crawler?.searchTargetConcurrency || options.concurrency, 3);
  for (let index = 0; index < searchTargets.length; index += searchTargetConcurrency) {
    const batch = searchTargets.slice(index, index + searchTargetConcurrency);
    const searchResults = await Promise.all(batch.map(async (target) => {
      try {
        return await fetchYouTubeSearchDocuments(target, source, {
          ...options,
          fetchTextResourceImpl,
        });
      } catch (error) {
        report.errors.push(`${target.searchUrl}: ${error.message}`);
        return null;
      }
    }));
    for (const searchResult of searchResults.filter(Boolean)) {
      report.searchFetched += 1;
      report.searchCandidates += searchResult.candidateCount;
      documents.push(...searchResult.documents);
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

function getYouTubeSearchTargets(source = {}, channels = getYouTubeChannels(source)) {
  const searchQueries = getYouTubeSearchQueries(source);
  if (!searchQueries.length || !channels.length) return [];

  const defaultLimit = getPositiveInteger(source.crawler?.searchResultsPerQuery, 6);
  const defaultCandidateLimit = getPositiveInteger(source.crawler?.searchCandidateLimitPerQuery, Math.max(defaultLimit * 4, 12));
  const defaultCandidateConcurrency = getPositiveInteger(source.crawler?.searchCandidateConcurrency, 4);
  const defaultCandidateTimeoutMs = getPositiveInteger(source.crawler?.searchCandidateTimeoutMs, 6000);
  const defaultCandidateRetries = getNonNegativeInteger(source.crawler?.searchCandidateRetries, 0);
  const targets = [];

  for (const query of searchQueries) {
    const targetChannels = query.channelName
      ? channels.filter((channel) => matchesYouTubeChannelName(channel, query.channelName))
      : channels;

    for (const channel of targetChannels) {
      const limit = getPositiveInteger(query.limit, defaultLimit);
      targets.push({
        query: query.query,
        searchUrl: createYouTubeSearchUrl(query.query, channel),
        channel,
        limit,
        candidateLimit: getPositiveInteger(query.candidateLimit || query.maxCandidates, defaultCandidateLimit),
        candidateConcurrency: getPositiveInteger(query.candidateConcurrency, defaultCandidateConcurrency),
        candidateTimeoutMs: getPositiveInteger(query.candidateTimeoutMs, defaultCandidateTimeoutMs),
        candidateRetries: getNonNegativeInteger(query.candidateRetries, defaultCandidateRetries),
        allowedAuthorNames: getYouTubeAllowedAuthorNames(channel),
        aliases: uniqueStrings([query.query, ...(query.aliases || []), ...(channel.aliases || [])]),
      });
    }
  }

  return targets;
}

function getYouTubeSearchQueries(source = {}) {
  const configuredQueries = Array.isArray(source.crawler?.searchQueries) ? source.crawler.searchQueries : [];
  return configuredQueries
    .map((item) => {
      const queryItem = typeof item === "string" ? { query: item } : (item || {});
      const query = cleanText(queryItem.query || queryItem.term || queryItem.q || "");
      if (!query) return null;
      return {
        query,
        channelName: cleanText(queryItem.channelName || queryItem.channel || ""),
        aliases: Array.isArray(queryItem.aliases) ? queryItem.aliases.map(cleanText).filter(Boolean) : [],
        limit: queryItem.limit,
        candidateLimit: queryItem.candidateLimit || queryItem.maxCandidates,
        candidateConcurrency: queryItem.candidateConcurrency,
        candidateTimeoutMs: queryItem.candidateTimeoutMs,
        candidateRetries: queryItem.candidateRetries,
      };
    })
    .filter(Boolean);
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

async function fetchYouTubeSearchDocuments(target, source, {
  timeoutMs = 12000,
  useFetchCache = true,
  cacheDir,
  retries = 1,
  fetchTextResourceImpl = fetchTextResource,
} = {}) {
  const searchHtml = await fetchTextResourceImpl(target.searchUrl, {
    timeoutMs,
    accept: "text/html,*/*;q=0.8",
    useFetchCache,
    cacheDir,
    cacheNamespace: "youtube-search",
    retries,
  });
  const videoIds = extractYouTubeSearchVideoIds(searchHtml).slice(0, target.candidateLimit);
  const documents = [];
  const candidateConcurrency = Math.max(1, target.candidateConcurrency || 4);
  const candidateTimeoutMs = Math.min(timeoutMs, getPositiveInteger(target.candidateTimeoutMs, 6000));
  const candidateRetries = getNonNegativeInteger(target.candidateRetries, 0);

  for (let index = 0; index < videoIds.length && documents.length < target.limit; index += candidateConcurrency) {
    const batch = videoIds.slice(index, index + candidateConcurrency);
    const batchDocuments = await Promise.all(batch.map(async (videoId) => {
      try {
        return await fetchYouTubeSeedVideoDocument({
          videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          channelName: target.channel?.name || "",
          aliases: target.aliases,
        }, source, {
          timeoutMs: candidateTimeoutMs,
          useFetchCache,
          cacheDir,
          retries: candidateRetries,
          fetchTextResourceImpl,
          allowedAuthorNames: target.allowedAuthorNames,
        });
      } catch {
        return null;
      }
    }));
    for (const document of batchDocuments.filter(Boolean)) {
      if (documents.length >= target.limit) break;
      documents.push(document);
    }
  }

  return { documents, candidateCount: videoIds.length };
}

async function fetchYouTubeSeedVideoDocument(seedVideo, source, {
  timeoutMs = 12000,
  useFetchCache = true,
  cacheDir,
  retries = 1,
  fetchTextResourceImpl = fetchTextResource,
  allowedAuthorNames = [],
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
  const oembedAuthorName = cleanText(oembed.author_name || "");
  if (!matchesAllowedYouTubeAuthor(oembedAuthorName, allowedAuthorNames)) return null;

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
    publishedAt: normalizePublishedAt(seedVideo.date || watchMetadata.date || ""),
    url: seedVideo.url,
    thumbnailUrl: cleanText(oembed.thumbnail_url || `https://i.ytimg.com/vi/${seedVideo.videoId}/hqdefault.jpg`),
    source,
    channel: {
      name: seedVideo.channelName || oembedAuthorName,
      aliases: seedVideo.aliases,
    },
  });
}

function extractYouTubeSearchVideoIds(html = "") {
  const text = String(html || "");
  const ids = [];
  const patterns = [
    /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g,
    /watch\?v=([a-zA-Z0-9_-]{11})/g,
    /\/shorts\/([a-zA-Z0-9_-]{11})/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      ids.push(match[1]);
    }
  }

  return uniqueStrings(ids);
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
  publishedAt = "",
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
    publishedAt: normalizePublishedAt(publishedAt || date),
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.sourceType,
    youtubeChannelId: cleanText(channel.channelId || ""),
    youtubeChannelName: cleanText(channel.name || ""),
    youtubeFeedChannelId: cleanText(channel.feedChannelId || ""),
    youtubeFeedChannelName: cleanText(channel.feedChannelName || ""),
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
    const channelId = cleanText(node.find("yt\\:channelId, channelId").first().text());
    const channelName = cleanText(node.find("author > name").first().text());
    const url = cleanText(node.find("link[rel='alternate']").first().attr("href")) || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
    const thumbnailUrl = cleanText(node.find("media\\:thumbnail, thumbnail").first().attr("url")) || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "");
    if (!videoId || !title || !url) return null;

    return createYouTubeDocument({
      videoId,
      title,
      date: normalizeDate(published),
      publishedAt: normalizePublishedAt(published),
      url,
      thumbnailUrl,
      description,
      source,
      channel: {
        ...channel,
        channelId: channelId || channel.channelId,
        name: channelName || channel.name,
        feedChannelId: channelId,
        feedChannelName: channelName,
      },
    });
  }).filter(Boolean);
}

function createYouTubeSearchUrl(query = "", channel = {}) {
  const searchQuery = [query, channel.name].map(cleanText).filter(Boolean).join(" ");
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`;
}

function getYouTubeAllowedAuthorNames(channel = {}) {
  return uniqueStrings([channel.name, ...(channel.aliases || [])]);
}

function matchesYouTubeChannelName(channel = {}, name = "") {
  const normalizedName = normalizeYouTubeAuthorName(name);
  return getYouTubeAllowedAuthorNames(channel)
    .map(normalizeYouTubeAuthorName)
    .some((allowedName) => allowedName && allowedName === normalizedName);
}

function matchesAllowedYouTubeAuthor(authorName = "", allowedAuthorNames = []) {
  if (!allowedAuthorNames.length) return true;
  const normalizedAuthor = normalizeYouTubeAuthorName(authorName);
  return Boolean(normalizedAuthor) && allowedAuthorNames
    .map(normalizeYouTubeAuthorName)
    .some((allowedName) => allowedName && allowedName === normalizedAuthor);
}

function normalizeYouTubeAuthorName(value = "") {
  return cleanText(value).replace(/^@+/, "").toLocaleLowerCase("ko-KR").replace(/\s+/g, "");
}

function getPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function getNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
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

function normalizePublishedAt(value = "") {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
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
