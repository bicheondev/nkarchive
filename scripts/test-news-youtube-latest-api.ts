#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  NEWS_YOUTUBE_LATEST_CACHE_CONTROL,
  NEWS_YOUTUBE_LATEST_CHANNELS,
  createNewsYouTubeLatestHandler,
  fetchNewsYouTubeLatestChannel,
  parseNewsYouTubeAtomFeed,
} from "../api/news-youtube-latest.js";

const NOW = "2026-08-24T04:00:00.000Z";
const IDS = Object.freeze({
  meariOld: "AAAAAAAAAAA",
  meariNew: "BBBBBBBBBBB",
  supersuhuiOld: "CCCCCCCCCCC",
  supersuhuiNew: "DDDDDDDDDDD",
});

const feedEntries = {
  "메아리": [
    { videoId: IDS.meariNew, title: "메아리 새 영상", publishedAt: "2026-08-24T02:00:00+00:00" },
    { videoId: IDS.meariOld, title: "RSS가 덮어쓴 메아리 제목", publishedAt: "2026-08-20T02:00:00+00:00" },
  ],
  supersuhui: [
    { videoId: IDS.supersuhuiNew, title: "supersuhui 새 영상", publishedAt: "2026-08-24T03:00:00+00:00" },
    { videoId: IDS.supersuhuiOld, title: "기존 supersuhui 영상", publishedAt: "2026-08-21T03:00:00+00:00" },
  ],
};

await testHealthyOverlayAndHead();
await testPerChannelAndCompleteFallback();
await testStrictRequestContractAndFatalStaticFailure();
await testTimeoutAndBodyBounds();
testStrictAtomValidation();

console.log("News YouTube latest API tests passed.");

async function testHealthyOverlayAndHead() {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const channel = NEWS_YOUTUBE_LATEST_CHANNELS.find((item) => item.feedUrl === url);
    assert.ok(channel, "the endpoint must fetch only a fixed configured feed URL");
    return atomResponse(makeFeed(channel, feedEntries[channel.channelName]));
  };
  const handler = createNewsYouTubeLatestHandler({
    fetchImpl,
    now: () => new Date(NOW),
  });
  const response = await invoke(handler, { method: "GET", url: "/api/news-youtube-latest" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers.get("cache-control"), NEWS_YOUTUBE_LATEST_CACHE_CONTROL);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(response.body));
  assert.equal(Buffer.byteLength(response.body) < 32 * 1024, true, "the endpoint must return only the bounded recent overlay");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.url).sort(), NEWS_YOUTUBE_LATEST_CHANNELS.map((channel) => channel.feedUrl).sort());
  assert.equal(calls.every((call) => call.options.method === "GET" && call.options.redirect === "error"), true);
  assert.equal(calls.every((call) => call.options.cache === "no-store" && call.options.signal instanceof AbortSignal), true);

  const payload = JSON.parse(response.body);
  assert.deepEqual(Object.keys(payload), [
    "schemaVersion",
    "generatedAt",
    "version",
    "totalItems",
    "channelCounts",
    "videos",
    "refresh",
  ]);
  assert.equal(payload.generatedAt, NOW);
  assert.equal(payload.totalItems, 4);
  assert.equal(payload.totalItems <= 30, true);
  assert.deepEqual(payload.channelCounts, { "메아리": 2, supersuhui: 2 });
  assert.deepEqual(payload.videos.map((video) => video.videoId), [
    IDS.supersuhuiNew,
    IDS.meariNew,
    IDS.supersuhuiOld,
    IDS.meariOld,
  ]);
  assert.equal(payload.videos.find((video) => video.videoId === IDS.meariOld).title, "RSS가 덮어쓴 메아리 제목");
  assert.equal(payload.version, calculateVersion(payload.videos));
  assert.deepEqual(payload.refresh, {
    status: "success",
    checkedAt: NOW,
    fetchedItems: 4,
    channels: NEWS_YOUTUBE_LATEST_CHANNELS.map((channel) => ({
      channelName: channel.channelName,
      channelId: channel.channelId,
      status: "success",
      fetchedItems: 2,
      error: "",
    })),
  });

  const head = await invoke(handler, { method: "HEAD", url: "/api/news-youtube-latest" });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers.get("cache-control"), NEWS_YOUTUBE_LATEST_CACHE_CONTROL);
  assert.equal(head.headers.has("content-length"), false);
  assert.equal(calls.length, 2, "HEAD must not perform live Atom feed requests");
}

async function testPerChannelAndCompleteFallback() {
  const partialHandler = createNewsYouTubeLatestHandler({
    now: () => NOW,
    fetchImpl: async (url) => {
      const channel = NEWS_YOUTUBE_LATEST_CHANNELS.find((item) => item.feedUrl === url);
      if (channel.channelName === "supersuhui") {
        const error = new Error("fixture outage must not leak");
        error.code = "upstream_status";
        throw error;
      }
      return atomResponse(makeFeed(channel, feedEntries[channel.channelName]));
    },
  });
  const partial = JSON.parse((await invoke(partialHandler, {
    method: "GET",
    url: "/api/news-youtube-latest",
  })).body);
  assert.equal(partial.refresh.status, "degraded");
  assert.equal(partial.refresh.fetchedItems, 2);
  assert.equal(partial.totalItems, 2);
  assert.deepEqual(partial.channelCounts, { "메아리": 2, supersuhui: 0 });
  assert.deepEqual(partial.refresh.channels.map((channel) => [channel.status, channel.error]), [
    ["success", ""],
    ["fallback", "upstream_status"],
  ]);
  assert.equal(partial.videos.some((video) => video.videoId === IDS.meariNew), true);
  assert.equal(partial.videos.some((video) => video.videoId === IDS.supersuhuiNew), false);
  assert.equal(partial.videos.some((video) => video.videoId === IDS.supersuhuiOld), false);

  const fallbackHandler = createNewsYouTubeLatestHandler({
    now: () => NOW,
    fetchImpl: async () => { throw new Error("private network detail"); },
  });
  const fallbackResponse = await invoke(fallbackHandler, { method: "GET", url: "/api/news-youtube-latest" });
  const fallback = JSON.parse(fallbackResponse.body);
  assert.equal(fallbackResponse.statusCode, 200);
  assert.equal(fallbackResponse.headers.get("cache-control"), NEWS_YOUTUBE_LATEST_CACHE_CONTROL);
  assert.equal(fallback.refresh.status, "fallback");
  assert.equal(fallback.refresh.fetchedItems, 0);
  assert.equal(fallback.generatedAt, NOW);
  assert.equal(fallback.version, calculateVersion([]));
  assert.equal(fallback.totalItems, 0);
  assert.deepEqual(fallback.channelCounts, { "메아리": 0, supersuhui: 0 });
  assert.deepEqual(fallback.videos, []);
  assert.equal(fallback.refresh.channels.every((channel) => channel.error === "feed_unavailable"), true);
  assert.doesNotMatch(fallbackResponse.body, /private network detail/u);
}

async function testStrictRequestContractAndFatalStaticFailure() {
  let fetches = 0;
  const handler = createNewsYouTubeLatestHandler({
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("not reached for invalid requests");
    },
  });
  for (const request of [
    { method: "GET", url: "/api/news-youtube-latest?channel=메아리" },
    { method: "GET", url: "/api/news-youtube-latest?" },
    { method: "GET", url: "/api/news-youtube-latest", query: { channel: "메아리" } },
  ]) {
    const response = await invoke(handler, request);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), { error: "invalid_query" });
    assert.equal(response.headers.get("cache-control"), "private, max-age=0");
  }
  const post = await invoke(handler, { method: "POST", url: "/api/news-youtube-latest" });
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  assert.equal(fetches, 0);

  const fatal = await invoke(createNewsYouTubeLatestHandler({
    now: () => new Date(Number.NaN),
    fetchImpl: async () => {
      fetches += 1;
      return atomResponse("");
    },
  }), { method: "GET", url: "/api/news-youtube-latest" });
  assert.equal(fatal.statusCode, 503);
  assert.equal(fatal.headers.get("cache-control"), "no-store");
  assert.deepEqual(JSON.parse(fatal.body), { error: "news_youtube_latest_unavailable" });
  assert.equal(fetches, 0, "an internal validation failure must happen before any upstream fetch");
}

async function testTimeoutAndBodyBounds() {
  const startedAt = Date.now();
  const timeoutHandler = createNewsYouTubeLatestHandler({
    now: () => NOW,
    feedTimeoutMs: 10,
    fetchChannelImpl: async () => new Promise(() => {}),
  });
  const timedOut = await invoke(timeoutHandler, { method: "GET", url: "/api/news-youtube-latest" });
  assert.equal(Date.now() - startedAt < 1_000, true, "an uncooperative fetch must remain wall-clock bounded");
  assert.equal(timedOut.statusCode, 200);
  const timeoutPayload = JSON.parse(timedOut.body);
  assert.equal(timeoutPayload.refresh.status, "fallback");
  assert.equal(timeoutPayload.totalItems, 0);
  assert.deepEqual(timeoutPayload.videos, []);
  assert.equal(timeoutPayload.refresh.channels.every((channel) => channel.error === "timeout"), true);

  const channel = NEWS_YOUTUBE_LATEST_CHANNELS[0];
  await assert.rejects(
    fetchNewsYouTubeLatestChannel(channel, {
      maxBytes: 64,
      fetchImpl: async () => atomResponse("<feed/>", { "Content-Length": "65" }),
    }),
    (error) => error?.code === "feed_too_large",
  );
  await assert.rejects(
    fetchNewsYouTubeLatestChannel(channel, {
      maxBytes: 64,
      fetchImpl: async () => atomResponse("x".repeat(65)),
    }),
    (error) => error?.code === "feed_too_large",
  );
}

function testStrictAtomValidation() {
  const channel = NEWS_YOUTUBE_LATEST_CHANNELS[0];
  const validXml = makeFeed(channel, feedEntries[channel.channelName]);
  const parsed = parseNewsYouTubeAtomFeed(validXml, channel);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], makeVideo(IDS.meariNew, "메아리", "2026-08-24T02:00:00.000Z", "메아리 새 영상"));

  assert.throws(
    () => parseNewsYouTubeAtomFeed(validXml.replace(channel.channelId, NEWS_YOUTUBE_LATEST_CHANNELS[1].channelId), channel),
    (error) => /identity|channel/u.test(error?.code || ""),
  );
  assert.throws(
    () => parseNewsYouTubeAtomFeed(validXml.replace(`yt:video:${IDS.meariNew}`, `yt:video:${IDS.meariOld}`), channel),
    (error) => error?.code === "entry_identity_mismatch",
  );
  assert.throws(
    () => parseNewsYouTubeAtomFeed(validXml.replace(`https://www.youtube.com/watch?v=${IDS.meariNew}`, `https://youtu.be/${IDS.meariNew}`), channel),
    (error) => error?.code === "invalid_watch_url",
  );
  const duplicate = makeFeed(channel, [feedEntries[channel.channelName][0], feedEntries[channel.channelName][0]]);
  assert.throws(
    () => parseNewsYouTubeAtomFeed(duplicate, channel),
    (error) => error?.code === "invalid_video_id",
  );
  const oversized = makeFeed(channel, Array.from({ length: 16 }, (_, index) => ({
    videoId: `X${String(index).padStart(10, "0")}`,
    title: `bounded item ${index}`,
    publishedAt: "2026-08-24T01:00:00+00:00",
  })));
  assert.throws(
    () => parseNewsYouTubeAtomFeed(oversized, channel),
    (error) => error?.code === "too_many_entries",
  );
}

function makeFeed(channel, entries) {
  const channelUrl = `https://www.youtube.com/channel/${channel.channelId}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <id>yt:channel:${channel.channelId.slice(2)}</id>
  <yt:channelId>${channel.channelId.slice(2)}</yt:channelId>
  <title>${escapeXml(channel.channelName)}</title>
  <link rel="alternate" href="${channelUrl}"/>
  <author><name>${escapeXml(channel.channelName)}</name><uri>${channelUrl}</uri></author>
  ${entries.map((entry) => `
  <entry>
    <id>yt:video:${entry.videoId}</id>
    <yt:videoId>${entry.videoId}</yt:videoId>
    <yt:channelId>${channel.channelId}</yt:channelId>
    <title>${escapeXml(entry.title)}</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${entry.videoId}"/>
    <author><name>${escapeXml(channel.channelName)}</name><uri>${channelUrl}</uri></author>
    <published>${entry.publishedAt}</published>
  </entry>`).join("")}
</feed>`;
}

function makeVideo(videoId, channelName, publishedAt, title) {
  return {
    id: `youtube-${videoId}`,
    videoId,
    title,
    channelName,
    publishedAt,
    date: publishedAt.slice(0, 10),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

function calculateVersion(videos) {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, videos }))
    .digest("hex")
    .slice(0, 16);
}

function atomResponse(body, extraHeaders = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/atom+xml; charset=UTF-8",
      ...extraHeaders,
    },
  });
}

async function invoke(handler, request) {
  const headers = new Map();
  const response = {
    statusCode: 200,
    body: undefined,
    setHeader(name, value) {
      headers.set(String(name).toLocaleLowerCase("en-US"), String(value));
    },
    end(body = "") {
      this.body = String(body);
    },
  };
  await handler(request, response);
  assert.notEqual(response.body, undefined, "handler must end every response");
  return { statusCode: response.statusCode, headers, body: response.body };
}

function escapeXml(value) {
  return String(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}
