import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

export const NEWS_YOUTUBE_LATEST_CACHE_CONTROL = "public, max-age=0, s-maxage=300, stale-while-revalidate=300";
export const NEWS_YOUTUBE_LATEST_CHANNELS = Object.freeze([
  Object.freeze({
    channelName: "메아리",
    channelId: "UC7CdB6acpJKKku-QfZ6QfMw",
    feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UC7CdB6acpJKKku-QfZ6QfMw",
  }),
  Object.freeze({
    channelName: "supersuhui",
    channelId: "UCBopKYmbS-Ki6ilhe1mT_nw",
    feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCBopKYmbS-Ki6ilhe1mT_nw",
  }),
]);

export const NEWS_YOUTUBE_LATEST_LIMITS = Object.freeze({
  feedBytes: 512 * 1024,
  feedEntries: 15,
  feedTimeoutMs: 5_000,
  responseBytes: 512 * 1024,
  titleCharacters: 512,
});

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CHANNEL_NAMES = NEWS_YOUTUBE_LATEST_CHANNELS.map((channel) => channel.channelName);
const PRIVATE_ERROR_CACHE_CONTROL = "private, max-age=0";
const USER_AGENT = "DPRKArchiveNewsLatest/1.0 (+https://nkarchive.vercel.app/news/youtube)";

export default async function handler(request, response) {
  return createNewsYouTubeLatestHandler()(request, response);
}

export function createNewsYouTubeLatestHandler({
  fetchImpl = globalThis.fetch,
  fetchChannelImpl,
  now = () => new Date(),
  feedTimeoutMs = NEWS_YOUTUBE_LATEST_LIMITS.feedTimeoutMs,
  feedBytes = NEWS_YOUTUBE_LATEST_LIMITS.feedBytes,
} = {}) {
  const fetchChannel = fetchChannelImpl || ((channel, options) => (
    fetchNewsYouTubeLatestChannel(channel, { ...options, fetchImpl })
  ));
  const boundedTimeoutMs = positiveBoundedInteger(
    feedTimeoutMs,
    NEWS_YOUTUBE_LATEST_LIMITS.feedTimeoutMs,
    NEWS_YOUTUBE_LATEST_LIMITS.feedTimeoutMs,
  );
  const boundedFeedBytes = positiveBoundedInteger(
    feedBytes,
    NEWS_YOUTUBE_LATEST_LIMITS.feedBytes,
    NEWS_YOUTUBE_LATEST_LIMITS.feedBytes,
  );

  return async function newsYouTubeLatestHandler(request, response) {
    const method = String(request?.method || "GET").toLocaleUpperCase("en-US");
    if (method !== "GET" && method !== "HEAD") {
      sendJson(response, method, 405, { error: "method_not_allowed" }, {
        Allow: "GET, HEAD",
        "Cache-Control": PRIVATE_ERROR_CACHE_CONTROL,
      });
      return;
    }
    if (!hasExactEmptyQuery(request)) {
      sendJson(response, method, 400, { error: "invalid_query" }, {
        "Cache-Control": PRIVATE_ERROR_CACHE_CONTROL,
      });
      return;
    }
    if (method === "HEAD") {
      sendHead(response, 200, {
        "Cache-Control": NEWS_YOUTUBE_LATEST_CACHE_CONTROL,
      });
      return;
    }

    try {
      const checkedAt = toIsoTimestamp(typeof now === "function" ? now() : now, "refresh checkedAt");
      const settled = await Promise.allSettled(NEWS_YOUTUBE_LATEST_CHANNELS.map((channel) => (
        withDeadline(
          () => fetchChannel(channel, {
            maxBytes: boundedFeedBytes,
            timeoutMs: boundedTimeoutMs,
          }),
          boundedTimeoutMs,
        ).then((value) => normalizeFetchedChannel(value, channel, checkedAt))
      )));
      const outcomes = settled.map((result, index) => {
        const channel = NEWS_YOUTUBE_LATEST_CHANNELS[index];
        if (result.status === "fulfilled") {
          return {
            channelName: channel.channelName,
            channelId: channel.channelId,
            status: "success",
            fetchedItems: result.value.length,
            error: "",
            videos: result.value,
          };
        }
        return {
          channelName: channel.channelName,
          channelId: channel.channelId,
          status: "fallback",
          fetchedItems: 0,
          error: publicFeedError(result.reason),
          videos: [],
        };
      });
      const successful = outcomes.filter((outcome) => outcome.status === "success");
      const overlay = createLatestOverlay(
        successful.flatMap((outcome) => outcome.videos),
        checkedAt,
      );
      const status = successful.length === NEWS_YOUTUBE_LATEST_CHANNELS.length
        ? "success"
        : successful.length
          ? "degraded"
          : "fallback";
      const payload = {
        ...overlay,
        refresh: {
          status,
          checkedAt,
          fetchedItems: successful.reduce((total, outcome) => total + outcome.fetchedItems, 0),
          channels: outcomes.map(({ videos: _videos, ...outcome }) => outcome),
        },
      };
      sendJson(response, method, 200, payload, {
        "Cache-Control": NEWS_YOUTUBE_LATEST_CACHE_CONTROL,
      }, { maximumBytes: NEWS_YOUTUBE_LATEST_LIMITS.responseBytes });
    } catch {
      sendJson(response, method, 503, { error: "news_youtube_latest_unavailable" }, {
        "Cache-Control": "no-store",
      });
    }
  };
}

export async function fetchNewsYouTubeLatestChannel(channel, {
  fetchImpl = globalThis.fetch,
  maxBytes = NEWS_YOUTUBE_LATEST_LIMITS.feedBytes,
  timeoutMs = NEWS_YOUTUBE_LATEST_LIMITS.feedTimeoutMs,
} = {}) {
  if (!NEWS_YOUTUBE_LATEST_CHANNELS.includes(channel)) throw feedError("invalid_channel");
  if (typeof fetchImpl !== "function") throw feedError("fetch_unavailable");
  const controller = new AbortController();
  return withDeadline(async () => {
    const upstream = await fetchImpl(channel.feedUrl, {
      method: "GET",
      headers: {
        Accept: "application/atom+xml,application/xml,text/xml;q=0.9",
        "User-Agent": USER_AGENT,
      },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!upstream || !upstream.ok || Number(upstream.status) !== 200) throw feedError("upstream_status");
    const contentType = String(upstream.headers?.get?.("content-type") || "").toLocaleLowerCase("en-US");
    if (contentType && !/(?:application\/(?:atom\+xml|xml)|text\/xml)/u.test(contentType)) {
      throw feedError("invalid_content_type");
    }
    const xml = await readTextBodyBounded(upstream, maxBytes);
    return parseNewsYouTubeAtomFeed(xml, channel);
  }, timeoutMs, () => controller.abort());
}

export function parseNewsYouTubeAtomFeed(xml, channel) {
  if (!NEWS_YOUTUBE_LATEST_CHANNELS.includes(channel)) throw feedError("invalid_channel");
  const source = String(xml || "");
  if (!source.trim()) throw feedError("empty_feed");
  if (Buffer.byteLength(source, "utf8") > NEWS_YOUTUBE_LATEST_LIMITS.feedBytes) throw feedError("feed_too_large");

  let $;
  try {
    $ = cheerio.load(source, { xmlMode: true });
  } catch {
    throw feedError("invalid_xml");
  }
  const feeds = $("feed");
  if (feeds.length !== 1) throw feedError("invalid_feed_root");
  const feed = feeds.first();
  const channelTail = channel.channelId.slice(2);
  if (oneDirectText(feed, "id", "feed_id") !== `yt:channel:${channelTail}`
    || oneDirectText(feed, "yt\\:channelId", "feed_channel_id") !== channelTail
    || oneDirectText(feed, "title", "feed_title") !== channel.channelName
    || oneDirectText(feed.children("author").first(), "name", "feed_author") !== channel.channelName
    || oneDirectText(feed.children("author").first(), "uri", "feed_author_uri") !== `https://www.youtube.com/channel/${channel.channelId}`) {
    throw feedError("channel_identity_mismatch");
  }
  const channelLinks = feed.children("link[rel='alternate']");
  const feedAuthors = feed.children("author");
  if (feedAuthors.length !== 1 || channelLinks.length !== 1
    || String(channelLinks.first().attr("href") || "") !== `https://www.youtube.com/channel/${channel.channelId}`) {
    throw feedError("channel_identity_mismatch");
  }

  const entries = feed.children("entry");
  if (!entries.length) throw feedError("empty_feed");
  if (entries.length > NEWS_YOUTUBE_LATEST_LIMITS.feedEntries) throw feedError("too_many_entries");
  const videos = [];
  const seen = new Set();
  for (const entryElement of entries.toArray()) {
    const entry = $(entryElement);
    const entryAuthors = entry.children("author");
    if (entryAuthors.length !== 1) throw feedError("entry_identity_mismatch");
    const videoId = oneDirectText(entry, "yt\\:videoId", "video_id");
    if (!VIDEO_ID_PATTERN.test(videoId) || seen.has(videoId)) throw feedError("invalid_video_id");
    seen.add(videoId);
    if (oneDirectText(entry, "id", "entry_id") !== `yt:video:${videoId}`
      || oneDirectText(entry, "yt\\:channelId", "entry_channel_id") !== channel.channelId
      || oneDirectText(entry.children("author").first(), "name", "entry_author") !== channel.channelName
      || oneDirectText(entry.children("author").first(), "uri", "entry_author_uri") !== `https://www.youtube.com/channel/${channel.channelId}`) {
      throw feedError("entry_identity_mismatch");
    }
    const links = entry.children("link[rel='alternate']");
    if (links.length !== 1 || !isExactWatchUrl(links.first().attr("href"), videoId)) {
      throw feedError("invalid_watch_url");
    }
    const title = cleanTitle(oneDirectText(entry, "title", "entry_title"));
    if (!title || Array.from(title).length > NEWS_YOUTUBE_LATEST_LIMITS.titleCharacters) throw feedError("invalid_title");
    const publishedAt = toIsoTimestamp(oneDirectText(entry, "published", "entry_published"), "entry publishedAt");
    videos.push(canonicalVideo({ videoId, title, publishedAt, channelName: channel.channelName }));
  }
  return videos;
}

function normalizeFetchedChannel(value, channel, checkedAt) {
  if (!Array.isArray(value) || !value.length || value.length > NEWS_YOUTUBE_LATEST_LIMITS.feedEntries) {
    throw feedError("invalid_feed_result");
  }
  const seen = new Set();
  return value.map((input) => {
    const video = canonicalVideo(input);
    validateCanonicalVideo(video);
    if (video.channelName !== channel.channelName || seen.has(video.videoId)) throw feedError("invalid_feed_result");
    if (new Date(video.publishedAt).getTime() > new Date(checkedAt).getTime() + (48 * 60 * 60 * 1000)) {
      throw feedError("invalid_published_time");
    }
    seen.add(video.videoId);
    return video;
  });
}

function createLatestOverlay(recentVideos, checkedAt) {
  const videosById = new Map();
  for (const video of recentVideos) {
    const existing = videosById.get(video.videoId);
    if (existing && existing.channelName !== video.channelName) throw new Error("cross_channel_video_collision");
    videosById.set(video.videoId, video);
  }
  const videos = [...videosById.values()].sort(compareVideos);
  if (videos.length > NEWS_YOUTUBE_LATEST_CHANNELS.length * NEWS_YOUTUBE_LATEST_LIMITS.feedEntries) {
    throw new Error("overlay_too_large");
  }
  const version = calculateVersion(videos);
  return {
    schemaVersion: 1,
    generatedAt: checkedAt,
    version,
    totalItems: videos.length,
    channelCounts: Object.fromEntries(CHANNEL_NAMES.map((name) => [
      name,
      videos.filter((video) => video.channelName === name).length,
    ])),
    videos,
  };
}

function canonicalVideo({ videoId, title, publishedAt, channelName }) {
  const normalizedVideoId = String(videoId || "");
  const normalizedPublishedAt = toIsoTimestamp(publishedAt, "video publishedAt");
  return {
    id: `youtube-${normalizedVideoId}`,
    videoId: normalizedVideoId,
    title: cleanTitle(title),
    channelName: String(channelName || ""),
    publishedAt: normalizedPublishedAt,
    date: normalizedPublishedAt.slice(0, 10),
    url: `https://www.youtube.com/watch?v=${normalizedVideoId}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${normalizedVideoId}/hqdefault.jpg`,
  };
}

function validateCanonicalVideo(video) {
  assertPlainObject(video, "video");
  assertExactKeys(video, ["id", "videoId", "title", "channelName", "publishedAt", "date", "url", "thumbnailUrl"], "video");
  if (!VIDEO_ID_PATTERN.test(video.videoId) || video.id !== `youtube-${video.videoId}`) throw new Error("invalid_video_id");
  if (!video.title || video.title !== cleanTitle(video.title)
    || Array.from(video.title).length > NEWS_YOUTUBE_LATEST_LIMITS.titleCharacters) throw new Error("invalid_video_title");
  if (!CHANNEL_NAMES.includes(video.channelName)) throw new Error("invalid_video_channel");
  const publishedAt = toIsoTimestamp(video.publishedAt, "video publishedAt");
  if (video.publishedAt !== publishedAt
    || !DATE_PATTERN.test(video.date) || video.date !== publishedAt.slice(0, 10)) throw new Error("invalid_video_date");
  if (video.url !== `https://www.youtube.com/watch?v=${video.videoId}`
    || video.thumbnailUrl !== `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`) throw new Error("invalid_video_url");
}

async function readTextBodyBounded(response, maximumBytes) {
  const maxBytes = positiveBoundedInteger(maximumBytes, NEWS_YOUTUBE_LATEST_LIMITS.feedBytes, NEWS_YOUTUBE_LATEST_LIMITS.feedBytes);
  const lengthHeader = String(response.headers?.get?.("content-length") || "");
  if (lengthHeader) {
    const declared = Number(lengthHeader);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) throw feedError("feed_too_large");
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw feedError("feed_too_large");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value || []);
      size += chunk.length;
      if (size > maxBytes) throw feedError("feed_too_large");
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw feedError("invalid_encoding");
  }
}

function oneDirectText(parent, selector, label) {
  const elements = parent.children(selector);
  if (elements.length !== 1) throw feedError(`invalid_${label}`);
  return String(elements.first().text() || "").normalize("NFC").trim();
}

function isExactWatchUrl(value, videoId) {
  try {
    const url = new URL(String(value || ""));
    const keys = [...url.searchParams.keys()];
    return url.protocol === "https:" && url.hostname === "www.youtube.com" && !url.port
      && !url.username && !url.password && url.pathname === "/watch" && keys.length === 1
      && keys[0] === "v" && url.searchParams.get("v") === videoId && !url.hash;
  } catch {
    return false;
  }
}

function hasExactEmptyQuery(request) {
  const rawUrl = String(request?.url || "");
  if (rawUrl.includes("?") || rawUrl.includes("#")) return false;
  const query = request?.query;
  return query == null || (typeof query === "object" && !Array.isArray(query) && Object.keys(query).length === 0);
}

function cleanTitle(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function compareVideos(left, right) {
  if (left.publishedAt !== right.publishedAt) return left.publishedAt > right.publishedAt ? -1 : 1;
  if (left.videoId === right.videoId) return 0;
  return left.videoId < right.videoId ? -1 : 1;
}

function calculateVersion(videos) {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, videos }))
    .digest("hex")
    .slice(0, 16);
}

function toIsoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  const iso = date.toISOString();
  if (typeof value === "string" && value !== iso && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return iso;
}

function positiveBoundedInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return Math.min(number, maximum);
}

function withDeadline(operation, timeoutMs, onTimeout = () => {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try { onTimeout(); } catch {}
      finish(reject, feedError("timeout"));
    }, positiveBoundedInteger(timeoutMs, NEWS_YOUTUBE_LATEST_LIMITS.feedTimeoutMs, NEWS_YOUTUBE_LATEST_LIMITS.feedTimeoutMs));
    Promise.resolve()
      .then(operation)
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function publicFeedError(error) {
  const code = String(error?.code || "feed_unavailable");
  return /^[a-z0-9_]{1,64}$/u.test(code) ? code : "feed_unavailable";
}

function feedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
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

function sendJson(response, method, statusCode, payload, headers = {}, { maximumBytes = Infinity } = {}) {
  const body = JSON.stringify(payload);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > maximumBytes) throw new Error("response_too_large");
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(bytes));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(method === "HEAD" ? "" : body);
}

function sendHead(response, statusCode, headers = {}) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end();
}
