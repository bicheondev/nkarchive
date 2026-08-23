#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchYouTubeFeedDocuments } from "./import-youtube-metadata.ts";
import { SEARCH_SOURCES } from "../search/sourceConfig.js";

export const NEWS_YOUTUBE_SCHEMA_VERSION = 1;
export const NEWS_YOUTUBE_RELATIVE_PATH = "data/news/youtube-videos.json";
export const NEWS_YOUTUBE_CHANNELS = Object.freeze([
  Object.freeze({
    name: "메아리",
    channelId: "UC7CdB6acpJKKku-QfZ6QfMw",
    feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UC7CdB6acpJKKku-QfZ6QfMw",
  }),
  Object.freeze({
    name: "supersuhui",
    channelId: "UCBopKYmbS-Ki6ilhe1mT_nw",
    feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCBopKYmbS-Ki6ilhe1mT_nw",
  }),
]);

const CHANNEL_NAMES = NEWS_YOUTUBE_CHANNELS.map((channel) => channel.name);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const VERSION_PATTERN = /^[a-f0-9]{16}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_YTDLP_OUTPUT_BYTES = 128 * 1024 * 1024;
const DEFAULT_YTDLP_TIMEOUT_MS = 30 * 60 * 1000;

export async function refreshNewsYouTube({
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  outputPath = path.join(rootDir, NEWS_YOUTUBE_RELATIVE_PATH),
  reportPath = "",
  now = new Date(),
  timeoutMs = 20000,
  ytDlpTimeoutMs = DEFAULT_YTDLP_TIMEOUT_MS,
  fetchFeedDocumentsImpl = fetchYouTubeFeedDocuments,
  runYtDlpImpl = runYtDlpListing,
} = {}) {
  const checkedAt = toIsoTimestamp(now, "refresh time");
  const youtubeSource = getConfiguredYouTubeSource();
  const existing = await readExistingArtifact(outputPath);
  const previousByVideoId = new Map((existing.artifact?.videos || []).map((video) => [video.videoId, video]));
  const outcomes = [];
  for (const expectedChannel of NEWS_YOUTUBE_CHANNELS) {
    const channel = youtubeSource.crawler.channels.find((item) => item.channelId === expectedChannel.channelId);
    try {
      const rssResult = await fetchChannelRss(youtubeSource, channel, {
        fetchFeedDocumentsImpl,
        timeoutMs,
      });
      const playlistResult = await fetchCompleteChannelListing(channel, {
        runYtDlpImpl,
        ytDlpTimeoutMs,
      });
      const videos = mergeChannelMetadata({
        channel,
        rssVideos: rssResult.videos,
        datedEntries: playlistResult.datedEntries,
        localizedEntries: playlistResult.localizedEntries,
        previousByVideoId,
      });
      outcomes.push({
        channelName: channel.name,
        channelId: channel.channelId,
        status: "success",
        rssItems: rssResult.videos.length,
        listed: videos.length,
        expected: playlistResult.expected,
        frontierExhausted: true,
        capReached: false,
        videos,
        error: "",
      });
    } catch (error) {
      outcomes.push({
        channelName: expectedChannel.name,
        channelId: expectedChannel.channelId,
        status: "failed",
        rssItems: 0,
        listed: 0,
        expected: 0,
        frontierExhausted: false,
        capReached: false,
        videos: [],
        error: error.message,
      });
    }
  }

  const successful = outcomes.filter((outcome) => outcome.status === "success");
  const failed = outcomes.filter((outcome) => outcome.status === "failed");
  let status = "success";
  let artifact = null;
  let promoted = false;

  if (successful.length === 0) {
    status = "failure";
  } else {
    for (const outcome of failed) {
      const preserved = (existing.artifact?.videos || []).filter((video) => video.channelName === outcome.channelName);
      if (!preserved.length) {
        status = "failure";
        break;
      }
      outcome.status = "preserved";
      outcome.videos = preserved;
      outcome.listed = preserved.length;
      outcome.expected = preserved.length;
      outcome.frontierExhausted = false;
    }

    if (status !== "failure") {
      status = failed.length ? "degraded" : "success";
      const videos = sortAndDedupeVideos(outcomes.flatMap((outcome) => outcome.videos));
      artifact = createNewsYouTubeArtifact(videos, checkedAt, existing.artifact);
      const nextText = stringifyArtifact(artifact);
      promoted = nextText !== existing.text;
      if (promoted) await writeFileAtomically(outputPath, nextText);
    }
  }

  const report = {
    schemaVersion: 1,
    status,
    checkedAt,
    artifactVersion: artifact?.version || existing.artifact?.version || "",
    totalItems: artifact?.totalItems || existing.artifact?.totalItems || 0,
    promoted,
    existingArtifactError: existing.error,
    channels: outcomes.map(({ videos: _videos, ...outcome }) => outcome),
  };
  if (reportPath) await writeReport(reportPath, report);
  return { artifact, report };
}

export async function checkNewsYouTubeArtifact(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return validateNewsYouTubeArtifact(JSON.parse(text));
}

export function createNewsYouTubeArtifact(videos, generatedAt, existingArtifact = null) {
  const sortedVideos = sortAndDedupeVideos(videos);
  const version = calculateVersion(sortedVideos);
  const stableGeneratedAt = existingArtifact?.version === version
    ? existingArtifact.generatedAt
    : toIsoTimestamp(generatedAt, "generatedAt");
  const artifact = {
    schemaVersion: NEWS_YOUTUBE_SCHEMA_VERSION,
    generatedAt: stableGeneratedAt,
    version,
    totalItems: sortedVideos.length,
    channelCounts: Object.fromEntries(CHANNEL_NAMES.map((name) => [
      name,
      sortedVideos.filter((video) => video.channelName === name).length,
    ])),
    videos: sortedVideos,
  };
  return validateNewsYouTubeArtifact(artifact);
}

export function validateNewsYouTubeArtifact(value) {
  assertPlainObject(value, "YouTube artifact");
  assertExactKeys(value, [
    "schemaVersion",
    "generatedAt",
    "version",
    "totalItems",
    "channelCounts",
    "videos",
  ], "YouTube artifact");
  if (value.schemaVersion !== NEWS_YOUTUBE_SCHEMA_VERSION) throw new Error("YouTube artifact schemaVersion must be 1");
  toIsoTimestamp(value.generatedAt, "YouTube artifact generatedAt");
  if (!VERSION_PATTERN.test(value.version)) throw new Error("YouTube artifact version must be 16 lowercase hexadecimal characters");
  if (!Number.isSafeInteger(value.totalItems) || value.totalItems < 0) throw new Error("YouTube artifact totalItems must be a non-negative integer");
  if (!Array.isArray(value.videos)) throw new Error("YouTube artifact videos must be an array");
  if (value.totalItems !== value.videos.length) throw new Error("YouTube artifact totalItems does not match videos.length");
  assertPlainObject(value.channelCounts, "YouTube artifact channelCounts");
  assertExactKeys(value.channelCounts, CHANNEL_NAMES, "YouTube artifact channelCounts");

  const seen = new Set();
  let previous = null;
  const calculatedCounts = Object.fromEntries(CHANNEL_NAMES.map((name) => [name, 0]));
  for (const [index, video] of value.videos.entries()) {
    validateArtifactVideo(video, `YouTube artifact videos[${index}]`);
    if (seen.has(video.videoId)) throw new Error(`YouTube artifact contains duplicate videoId: ${video.videoId}`);
    seen.add(video.videoId);
    calculatedCounts[video.channelName] += 1;
    if (previous && compareVideos(previous, video) > 0) throw new Error("YouTube artifact videos must use stable newest-first ordering");
    previous = video;
  }
  for (const channelName of CHANNEL_NAMES) {
    if (!Number.isSafeInteger(value.channelCounts[channelName]) || value.channelCounts[channelName] < 0) {
      throw new Error(`YouTube artifact channelCounts.${channelName} must be a non-negative integer`);
    }
    if (value.channelCounts[channelName] !== calculatedCounts[channelName]) {
      throw new Error(`YouTube artifact channel count mismatch: ${channelName}`);
    }
  }
  if (calculateVersion(value.videos) !== value.version) throw new Error("YouTube artifact version does not match canonical video content");
  return value;
}

export async function runYtDlpListing({
  playlistUrl,
  phase,
  timeoutMs = DEFAULT_YTDLP_TIMEOUT_MS,
  binary = process.env.NEWS_YOUTUBE_YTDLP_BIN || "yt-dlp",
} = {}) {
  const extractorArgs = phase === "localized"
    ? "youtube:lang=ko"
    : "youtubetab:approximate_date";
  const args = [
    "--ignore-config",
    "--no-update",
    "--flat-playlist",
    "--dump-single-json",
    "--no-warnings",
    "--extractor-args",
    extractorArgs,
    playlistUrl,
  ];
  const stdout = await runProcess(binary, args, { timeoutMs });
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`yt-dlp returned invalid JSON for ${phase}: ${error.message}`);
  }
}

function getConfiguredYouTubeSource() {
  const source = SEARCH_SOURCES.find((item) => item.id === "youtube" && item.crawler?.importer === "youtube-metadata");
  if (!source) throw new Error("Configured YouTube search source is missing");
  const channels = Array.isArray(source.crawler.channels) ? source.crawler.channels : [];
  if (channels.length !== NEWS_YOUTUBE_CHANNELS.length) throw new Error("Configured YouTube channel set is not exact");
  for (const expected of NEWS_YOUTUBE_CHANNELS) {
    const channel = channels.find((item) => item.channelId === expected.channelId);
    if (!channel || channel.name !== expected.name || channel.feedUrl !== expected.feedUrl) {
      throw new Error(`Configured YouTube channel does not match the News contract: ${expected.name}`);
    }
  }
  return source;
}

async function fetchChannelRss(source, channel, { fetchFeedDocumentsImpl, timeoutMs }) {
  const scopedSource = {
    ...source,
    crawler: {
      ...source.crawler,
      channels: [channel],
      searchQueries: [],
      seedVideos: [],
    },
  };
  const result = await fetchFeedDocumentsImpl(scopedSource, {
    limitPerSource: 50,
    timeoutMs,
    retries: 2,
    useFetchCache: false,
  });
  if (!result || !Array.isArray(result.documents) || !result.report) throw new Error(`${channel.name} RSS fetch returned an invalid result`);
  if (result.report.errors?.length) throw new Error(`${channel.name} RSS fetch failed: ${result.report.errors.join("; ")}`);
  if (result.report.fetched !== 1) throw new Error(`${channel.name} RSS frontier was not fetched exactly once`);
  if (!result.documents.length) throw new Error(`${channel.name} RSS feed is empty`);
  const videos = result.documents.map((document) => canonicalizeRssDocument(document, channel));
  if (new Set(videos.map((video) => video.videoId)).size !== videos.length) throw new Error(`${channel.name} RSS feed contains duplicate video IDs`);
  return { videos };
}

async function fetchCompleteChannelListing(channel, { runYtDlpImpl, ytDlpTimeoutMs }) {
  const playlistId = `UU${channel.channelId.slice(2)}`;
  const playlistUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
  const datedPayload = await runYtDlpImpl({ channel, playlistUrl, playlistId, phase: "dated", timeoutMs: ytDlpTimeoutMs });
  const localizedPayload = await runYtDlpImpl({ channel, playlistUrl, playlistId, phase: "localized", timeoutMs: ytDlpTimeoutMs });
  const datedEntries = validatePlaylistPayload(datedPayload, channel, playlistId, "dated");
  const localizedEntries = validatePlaylistPayload(localizedPayload, channel, playlistId, "localized");
  if (datedEntries.length !== localizedEntries.length) throw new Error(`${channel.name} localized listing count does not match dated listing`);
  for (let index = 0; index < datedEntries.length; index += 1) {
    if (datedEntries[index].id !== localizedEntries[index].id) {
      throw new Error(`${channel.name} localized listing frontier does not match dated listing at item ${index + 1}`);
    }
  }
  return { datedEntries, localizedEntries, expected: datedEntries.length };
}

function validatePlaylistPayload(payload, channel, playlistId, phase) {
  assertPlainObject(payload, `${channel.name} ${phase} playlist`);
  if (payload.id !== playlistId) throw new Error(`${channel.name} ${phase} playlist ID mismatch`);
  if (payload.channel_id !== channel.channelId) throw new Error(`${channel.name} ${phase} channel ID mismatch`);
  if (payload.channel !== channel.name) throw new Error(`${channel.name} ${phase} channel name mismatch`);
  if (!Number.isSafeInteger(payload.playlist_count) || payload.playlist_count < 1) {
    throw new Error(`${channel.name} ${phase} playlist_count is missing`);
  }
  if (!Array.isArray(payload.entries)) throw new Error(`${channel.name} ${phase} listing entries are missing`);
  if (payload.entries.length !== payload.playlist_count) {
    throw new Error(`${channel.name} ${phase} listing frontier incomplete: ${payload.entries.length}/${payload.playlist_count}`);
  }
  const seen = new Set();
  for (const [index, entry] of payload.entries.entries()) {
    assertPlainObject(entry, `${channel.name} ${phase} item ${index + 1}`);
    if (!VIDEO_ID_PATTERN.test(entry.id || "")) throw new Error(`${channel.name} ${phase} item ${index + 1} has invalid video ID`);
    if (seen.has(entry.id)) throw new Error(`${channel.name} ${phase} listing contains duplicate video ID: ${entry.id}`);
    seen.add(entry.id);
    if (entry.channel_id !== channel.channelId || entry.channel !== channel.name) {
      throw new Error(`${channel.name} ${phase} item ${entry.id} has mismatched channel identity`);
    }
    validateYouTubeWatchUrl(entry.url, entry.id, `${channel.name} ${phase} item ${entry.id} URL`);
    validateListingThumbnail(entry.thumbnails, entry.id, `${channel.name} ${phase} item ${entry.id} thumbnail`);
    if (!cleanTitle(entry.title)) throw new Error(`${channel.name} ${phase} item ${entry.id} has no title`);
    if (phase === "dated" && entry.timestamp != null) timestampToIso(entry.timestamp, `${channel.name} item ${entry.id} timestamp`);
  }
  return payload.entries;
}

function mergeChannelMetadata({
  channel,
  rssVideos,
  datedEntries,
  localizedEntries,
  previousByVideoId,
}) {
  const rssById = new Map(rssVideos.map((video) => [video.videoId, video]));
  const localizedById = new Map(localizedEntries.map((entry) => [entry.id, entry]));
  const listedIds = new Set(datedEntries.map((entry) => entry.id));
  const missingRecentIds = rssVideos.map((video) => video.videoId).filter((videoId) => !listedIds.has(videoId));
  if (missingRecentIds.length) {
    throw new Error(`${channel.name} complete listing omitted RSS video(s): ${missingRecentIds.join(", ")}`);
  }
  return datedEntries.map((entry) => {
    const rssVideo = rssById.get(entry.id);
    const previous = previousByVideoId.get(entry.id);
    const localized = localizedById.get(entry.id);
    const title = cleanTitle(rssVideo?.title || localized?.title || entry.title);
    if (!title) throw new Error(`${channel.name} item ${entry.id} has no usable title`);
    const publishedAt = rssVideo?.publishedAt
      || extractLeadingTitleDate(title)
      || (previous?.channelName === channel.name ? previous.publishedAt : "")
      || timestampToIso(entry.timestamp ?? entry.release_timestamp, `${channel.name} item ${entry.id} timestamp`);
    return {
      id: `youtube-${entry.id}`,
      videoId: entry.id,
      title,
      channelName: channel.name,
      publishedAt,
      date: publishedAt.slice(0, 10),
      url: `https://www.youtube.com/watch?v=${entry.id}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
    };
  });
}

function canonicalizeRssDocument(document, channel) {
  const videoId = String(document.id || "").replace(/^youtube-/u, "");
  if (!VIDEO_ID_PATTERN.test(videoId) || document.id !== `youtube-${videoId}`) throw new Error(`${channel.name} RSS item has invalid stable ID`);
  if (document.sourceId !== "youtube" || document.sourceName !== "YouTube" || document.mediaType !== "video") {
    throw new Error(`${channel.name} RSS item has invalid source identity`);
  }
  if (document.youtubeFeedChannelId !== channel.channelId || document.youtubeFeedChannelName !== channel.name) {
    throw new Error(`${channel.name} RSS item has mismatched feed channel identity`);
  }
  validateYouTubeWatchUrl(document.url, videoId, `${channel.name} RSS URL`);
  validateThumbnailUrl(document.thumbnailUrl, videoId, `${channel.name} RSS thumbnail`);
  const publishedAt = toIsoTimestamp(document.publishedAt, `${channel.name} RSS publishedAt`);
  const title = cleanTitle(document.title);
  if (!title) throw new Error(`${channel.name} RSS item has no title`);
  return {
    videoId,
    title,
    publishedAt,
  };
}

function validateArtifactVideo(video, label) {
  assertPlainObject(video, label);
  assertExactKeys(video, [
    "id",
    "videoId",
    "title",
    "channelName",
    "publishedAt",
    "date",
    "url",
    "thumbnailUrl",
  ], label);
  if (!VIDEO_ID_PATTERN.test(video.videoId)) throw new Error(`${label}.videoId is invalid`);
  if (video.id !== `youtube-${video.videoId}`) throw new Error(`${label}.id does not match videoId`);
  if (video.title !== cleanTitle(video.title) || !video.title) throw new Error(`${label}.title is not canonical`);
  if (!CHANNEL_NAMES.includes(video.channelName)) throw new Error(`${label}.channelName is invalid`);
  const publishedAt = toIsoTimestamp(video.publishedAt, `${label}.publishedAt`);
  if (!DATE_PATTERN.test(video.date) || video.date !== publishedAt.slice(0, 10)) throw new Error(`${label}.date does not match publishedAt`);
  if (video.url !== `https://www.youtube.com/watch?v=${video.videoId}`) throw new Error(`${label}.url is not canonical`);
  if (video.thumbnailUrl !== `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`) throw new Error(`${label}.thumbnailUrl is not canonical`);
}

function validateYouTubeWatchUrl(value, videoId, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.protocol !== "https:" || url.hostname !== "www.youtube.com" || url.port || url.username || url.password
    || url.pathname !== "/watch" || url.searchParams.get("v") !== videoId || [...url.searchParams.keys()].some((key) => key !== "v") || url.hash) {
    throw new Error(`${label} must be an exact HTTPS YouTube watch URL for ${videoId}`);
  }
}

function validateThumbnailUrl(value, videoId, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  const hostAllowed = /^i(?:[1-4])?\.ytimg\.com$/u.test(url.hostname);
  const pathAllowed = new RegExp(`^/vi(?:_webp)?/${escapeRegExp(videoId)}/[A-Za-z0-9_-]+\\.(?:jpg|webp)$`, "u").test(url.pathname);
  if (url.protocol !== "https:" || !hostAllowed || !pathAllowed || url.port || url.username || url.password || url.hash) {
    throw new Error(`${label} must use a trusted ytimg host and matching video ID`);
  }
}

function validateListingThumbnail(thumbnails, videoId, label) {
  if (!Array.isArray(thumbnails) || !thumbnails.length) throw new Error(`${label} is missing`);
  const valid = thumbnails.some((thumbnail) => {
    try {
      validateThumbnailUrl(thumbnail?.url, videoId, label);
      return true;
    } catch {
      return false;
    }
  });
  if (!valid) throw new Error(`${label} has no trusted URL`);
}

function sortAndDedupeVideos(videos) {
  const byId = new Map();
  for (const video of videos) {
    validateArtifactVideo(video, `YouTube video ${video?.videoId || "unknown"}`);
    const existing = byId.get(video.videoId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(video)) {
        throw new Error(`YouTube channel listings conflict on videoId: ${video.videoId}`);
      }
      continue;
    }
    byId.set(video.videoId, video);
  }
  return [...byId.values()].sort(compareVideos);
}

function compareVideos(left, right) {
  if (left.publishedAt !== right.publishedAt) return left.publishedAt > right.publishedAt ? -1 : 1;
  if (left.videoId === right.videoId) return 0;
  return left.videoId < right.videoId ? -1 : 1;
}

function calculateVersion(videos) {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: NEWS_YOUTUBE_SCHEMA_VERSION, videos }))
    .digest("hex")
    .slice(0, 16);
}

async function readExistingArtifact(outputPath) {
  try {
    const text = await fs.readFile(outputPath, "utf8");
    return { artifact: validateNewsYouTubeArtifact(JSON.parse(text)), text, error: "" };
  } catch (error) {
    if (error.code === "ENOENT") return { artifact: null, text: "", error: "" };
    return { artifact: null, text: "", error: error.message };
  }
}

async function writeFileAtomically(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, text, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function writeReport(reportPath, report) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function stringifyArtifact(artifact) {
  return `${JSON.stringify(artifact)}\n`;
}

function cleanTitle(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function extractLeadingTitleDate(title) {
  const value = String(title || "");
  const jucheMatch = value.match(/^주체\s*\d{1,3}\s*\(\s*(\d{4})\s*\)\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/u);
  const gregorianMatch = value.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/u);
  const match = jucheMatch || gregorianMatch;
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return date.toISOString();
}

function timestampToIso(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} is missing or invalid`);
  return toIsoTimestamp(new Date(Math.floor(value) * 1000), label);
}

function toIsoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid ISO timestamp`);
  const iso = date.toISOString();
  if (typeof value === "string" && value !== iso) throw new Error(`${label} must use canonical ISO format`);
  return iso;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runProcess(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      finish(() => reject(new Error(`${command} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_YTDLP_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(() => reject(new Error(`${command} output exceeded ${MAX_YTDLP_OUTPUT_BYTES} bytes`)));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(() => reject(new Error(`${command} failed to start: ${error.message}`))));
    child.on("close", (code, signal) => finish(() => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(-2000);
        reject(new Error(`${command} failed (${signal || code}): ${detail || "no error output"}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    }));
  });
}

function parseCliArguments(argv) {
  const options = { check: false };
  const valueFlags = new Set(["--output", "--report", "--timeout-ms", "--yt-dlp-timeout-ms", "--now"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    if (!valueFlags.has(argument) || index + 1 >= argv.length) throw new Error(`Unknown or incomplete argument: ${argument}`);
    const value = argv[index + 1];
    index += 1;
    if (argument === "--output") options.outputPath = path.resolve(value);
    if (argument === "--report") options.reportPath = path.resolve(value);
    if (argument === "--timeout-ms") options.timeoutMs = parsePositiveInteger(value, argument);
    if (argument === "--yt-dlp-timeout-ms") options.ytDlpTimeoutMs = parsePositiveInteger(value, argument);
    if (argument === "--now") options.now = new Date(value);
  }
  return options;
}

function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

async function main(argv = process.argv.slice(2)) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const options = parseCliArguments(argv);
  const outputPath = options.outputPath || path.join(rootDir, NEWS_YOUTUBE_RELATIVE_PATH);
  if (options.check) {
    const artifact = await checkNewsYouTubeArtifact(outputPath);
    console.log(`News YouTube artifact passed: ${artifact.totalItems} videos, version ${artifact.version}.`);
    return;
  }
  const { report } = await refreshNewsYouTube({ rootDir, ...options, outputPath });
  console.log(`News YouTube refresh ${report.status}: ${report.totalItems} videos, version ${report.artifactVersion || "unchanged"}.`);
  for (const channel of report.channels) {
    console.log(`- ${channel.channelName}: ${channel.status}, ${channel.listed}/${channel.expected}, frontierExhausted=${channel.frontierExhausted}, capReached=${channel.capReached}`);
    if (channel.error) console.error(`  ${channel.error}`);
  }
  if (report.status !== "success") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
