#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseYouTubeFeed } from "./import-youtube-metadata.ts";
import {
  NEWS_YOUTUBE_CHANNELS,
  NEWS_YOUTUBE_RELATIVE_PATH,
  checkNewsYouTubeArtifact,
  createNewsYouTubeArtifact,
  refreshNewsYouTube,
  validateNewsYouTubeArtifact,
} from "./refresh-news-youtube.ts";

const CHANNEL_BY_NAME = new Map(NEWS_YOUTUBE_CHANNELS.map((channel) => [channel.name, channel]));
const VIDEO_IDS = {
  meariOld: "AAAAAAAAAAA",
  meariNew: "BBBBBBBBBBB",
  supersuhuiOld: "CCCCCCCCCCC",
  supersuhuiNew: "DDDDDDDDDDD",
};

function makeArtifactVideo(videoId, channelName, publishedAt, title = `${channelName} ${videoId}`) {
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

function makeRssFetch(fixturesByChannel) {
  return async (source) => {
    const channel = source.crawler.channels[0];
    const videos = fixturesByChannel[channel.name] || [];
    return {
      documents: videos.map((video) => ({
        ...makeArtifactVideo(video.videoId, channel.name, video.publishedAt, video.title),
        sourceId: "youtube",
        sourceName: "YouTube",
        mediaType: "video",
        youtubeFeedChannelId: channel.channelId,
        youtubeFeedChannelName: channel.name,
        thumbnailUrl: `https://i4.ytimg.com/vi/${video.videoId}/hqdefault.jpg`,
      })),
      report: {
        fetched: 1,
        errors: [],
      },
    };
  };
}

function makePlaylist(channel, entries, phase, { expected = entries.length } = {}) {
  const playlistId = `UU${channel.channelId.slice(2)}`;
  return {
    id: playlistId,
    title: `Uploads from ${channel.name}`,
    channel: channel.name,
    channel_id: channel.channelId,
    playlist_count: expected,
    entries: entries.map((entry) => ({
      id: entry.videoId,
      title: phase === "localized" ? entry.localizedTitle : entry.title,
      url: `https://www.youtube.com/watch?v=${entry.videoId}`,
      channel: channel.name,
      channel_id: channel.channelId,
      timestamp: phase === "dated" ? Date.parse(entry.publishedAt) / 1000 : null,
      thumbnails: [{
        url: `https://i2.ytimg.com/vi/${entry.videoId}/hqdefault.jpg?sqp=fixture`,
      }],
    })),
  };
}

const listingFixtures = {
  "메아리": [
    {
      videoId: VIDEO_IDS.meariNew,
      title: "Translated Meari new",
      localizedTitle: "메아리 새 영상",
      publishedAt: "2026-08-22T00:00:00.000Z",
    },
    {
      videoId: VIDEO_IDS.meariOld,
      title: "Translated Meari old",
      localizedTitle: "메아리 지난 영상",
      publishedAt: "2026-08-20T00:00:00.000Z",
    },
  ],
  supersuhui: [
    {
      videoId: VIDEO_IDS.supersuhuiNew,
      title: "Translated supersuhui new",
      localizedTitle: "슈퍼수희 새 영상",
      publishedAt: "2026-08-23T00:00:00.000Z",
    },
    {
      videoId: VIDEO_IDS.supersuhuiOld,
      title: "Translated supersuhui old",
      localizedTitle: "2026년 8월 18일 슈퍼수희 지난 영상",
      publishedAt: "2026-08-19T00:00:00.000Z",
    },
  ],
};

function successfulListingRunner({ channel, phase }) {
  return makePlaylist(channel, listingFixtures[channel.name], phase);
}

const rssFixtures = {
  "메아리": [{
    videoId: VIDEO_IDS.meariNew,
    title: "RSS가 보존한 메아리 원제",
    publishedAt: "2026-08-22T12:34:56.000Z",
  }],
  supersuhui: [{
    videoId: VIDEO_IDS.supersuhuiNew,
    title: "RSS가 보존한 supersuhui 원제",
    publishedAt: "2026-08-23T01:02:03.000Z",
  }],
};

async function testHealthyCompleteRefresh() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "news-youtube-healthy-"));
  try {
    const { artifact, report } = await refreshNewsYouTube({
      rootDir,
      now: "2026-08-23T08:00:00.000Z",
      fetchFeedDocumentsImpl: makeRssFetch(rssFixtures),
      runYtDlpImpl: successfulListingRunner,
    });
    assert.equal(report.status, "success");
    assert.equal(report.promoted, true);
    assert.equal(artifact.totalItems, 4);
    assert.deepEqual(artifact.channelCounts, { "메아리": 2, supersuhui: 2 });
    assert.deepEqual(artifact.videos.map((video) => video.videoId), [
      VIDEO_IDS.supersuhuiNew,
      VIDEO_IDS.meariNew,
      VIDEO_IDS.meariOld,
      VIDEO_IDS.supersuhuiOld,
    ]);
    assert.equal(artifact.videos[0].title, "RSS가 보존한 supersuhui 원제");
    assert.equal(artifact.videos.find((video) => video.videoId === VIDEO_IDS.meariOld).title, "메아리 지난 영상");
    assert.equal(
      artifact.videos.find((video) => video.videoId === VIDEO_IDS.supersuhuiOld).publishedAt,
      "2026-08-18T00:00:00.000Z",
      "a leading source title date should beat an approximate listing date",
    );
    assert.equal(report.channels.every((channel) => channel.frontierExhausted && !channel.capReached), true);
    const checked = await checkNewsYouTubeArtifact(path.join(rootDir, NEWS_YOUTUBE_RELATIVE_PATH));
    assert.deepEqual(checked, artifact);

    const second = await refreshNewsYouTube({
      rootDir,
      now: "2026-08-24T08:00:00.000Z",
      fetchFeedDocumentsImpl: makeRssFetch(rssFixtures),
      runYtDlpImpl: successfulListingRunner,
    });
    assert.equal(second.report.promoted, false, "unchanged canonical videos must retain generatedAt and avoid refresh churn");
    assert.equal(second.artifact.generatedAt, artifact.generatedAt);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function testPerChannelLastKnownGood() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "news-youtube-degraded-"));
  try {
    const initial = await refreshNewsYouTube({
      rootDir,
      now: "2026-08-23T08:00:00.000Z",
      fetchFeedDocumentsImpl: makeRssFetch(rssFixtures),
      runYtDlpImpl: successfulListingRunner,
    });
    const previousMeari = initial.artifact.videos.filter((video) => video.channelName === "메아리");
    const changedSupersuhuiFixtures = {
      ...listingFixtures,
      supersuhui: listingFixtures.supersuhui.map((entry) => ({
        ...entry,
        localizedTitle: `${entry.localizedTitle} 갱신`,
      })),
    };
    const degraded = await refreshNewsYouTube({
      rootDir,
      now: "2026-08-24T08:00:00.000Z",
      fetchFeedDocumentsImpl: makeRssFetch(rssFixtures),
      runYtDlpImpl: ({ channel, phase }) => {
        if (channel.name === "메아리") {
          if (phase === "dated") return makePlaylist(channel, listingFixtures[channel.name], phase, { expected: 3 });
          return makePlaylist(channel, listingFixtures[channel.name], phase);
        }
        return makePlaylist(channel, changedSupersuhuiFixtures[channel.name], phase);
      },
    });
    assert.equal(degraded.report.status, "degraded");
    assert.equal(degraded.report.promoted, true);
    assert.equal(degraded.report.channels.find((channel) => channel.channelName === "메아리").status, "preserved");
    assert.deepEqual(
      degraded.artifact.videos.filter((video) => video.channelName === "메아리"),
      previousMeari,
      "a failed channel must retain its exact last-known-good rows",
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function testBothFailuresPreserveBytes() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "news-youtube-failure-"));
  try {
    await refreshNewsYouTube({
      rootDir,
      now: "2026-08-23T08:00:00.000Z",
      fetchFeedDocumentsImpl: makeRssFetch(rssFixtures),
      runYtDlpImpl: successfulListingRunner,
    });
    const outputPath = path.join(rootDir, NEWS_YOUTUBE_RELATIVE_PATH);
    const before = await fs.readFile(outputPath);
    const failed = await refreshNewsYouTube({
      rootDir,
      now: "2026-08-24T08:00:00.000Z",
      fetchFeedDocumentsImpl: async () => {
        throw new Error("fixture feed outage");
      },
      runYtDlpImpl: async () => {
        throw new Error("must not run after RSS failure");
      },
    });
    const after = await fs.readFile(outputPath);
    assert.equal(failed.report.status, "failure");
    assert.equal(failed.report.promoted, false);
    assert.deepEqual(after, before, "both-channel failure must preserve the artifact byte-for-byte");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

function testStrictArtifactValidationAndDedupe() {
  const video = makeArtifactVideo(VIDEO_IDS.meariNew, "메아리", "2026-08-22T00:00:00.000Z");
  const deduped = createNewsYouTubeArtifact([video, { ...video }], "2026-08-23T08:00:00.000Z");
  assert.equal(deduped.totalItems, 1);
  assert.throws(
    () => validateNewsYouTubeArtifact({
      ...deduped,
      videos: [{ ...deduped.videos[0], url: "http://youtube.com/watch?v=BBBBBBBBBBB" }],
    }),
    /url is not canonical/u,
  );
  assert.throws(
    () => validateNewsYouTubeArtifact({
      ...deduped,
      videos: [{ ...deduped.videos[0], thumbnailUrl: "https://example.com/BBBBBBBBBBB.jpg" }],
    }),
    /thumbnailUrl is not canonical/u,
  );
}

function testRssParserPreservesFullPublishedAtAndIdentity() {
  const channel = CHANNEL_BY_NAME.get("메아리");
  const source = {
    id: "youtube",
    name: "YouTube",
    sourceType: "video_archive",
    mediaTypes: ["video"],
    languages: ["ko"],
    searchTabs: ["all", "video"],
  };
  const documents = parseYouTubeFeed(`
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
      <entry>
        <yt:videoId>${VIDEO_IDS.meariNew}</yt:videoId>
        <yt:channelId>${channel.channelId}</yt:channelId>
        <title>RSS 전체 시각 시험</title>
        <link rel="alternate" href="https://www.youtube.com/watch?v=${VIDEO_IDS.meariNew}" />
        <author><name>${channel.name}</name></author>
        <published>2026-08-22T12:34:56+00:00</published>
        <media:group><media:thumbnail url="https://i4.ytimg.com/vi/${VIDEO_IDS.meariNew}/hqdefault.jpg" /></media:group>
      </entry>
    </feed>
  `, source, channel);
  assert.equal(documents[0].publishedAt, "2026-08-22T12:34:56.000Z");
  assert.equal(documents[0].youtubeFeedChannelId, channel.channelId);
  assert.equal(documents[0].youtubeFeedChannelName, channel.name);
}

async function testYouTubeUiConsumesTheCompleteArtifactSafely() {
  const [html, css, javascript, sharedCss, artifactText] = await Promise.all([
    fs.readFile(new URL("../news/youtube/index.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../news/youtube.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../news/youtube.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../news/news.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../data/news/youtube-videos.json", import.meta.url), "utf8"),
  ]);
  const artifact = validateNewsYouTubeArtifact(JSON.parse(artifactText));

  assert.equal(artifact.totalItems, artifact.videos.length, "the checked-in artifact must expose every canonical video row");
  assert.equal(artifact.totalItems >= 7000, true, "the complete two-channel artifact must not regress to an RSS-sized sample");
  assert.equal(artifact.channelCounts["메아리"] > 15, true, "메아리 coverage must extend past the 15-row RSS window");
  assert.equal(artifact.channelCounts.supersuhui > 15, true, "supersuhui coverage must extend past the 15-row RSS window");
  assert.match(javascript, /const DATA_URL = "\/data\/news\/youtube-videos\.json"/u);
  assert.match(javascript, /const videos = \[\.\.\.payload\.videos\]\.sort\(compareNewestFirst\)/u);
  assert.doesNotMatch(javascript, /\.slice\(\s*0\s*,\s*(?:6|15)\s*\)/u, "the UI must not cap the artifact to a teaser or RSS window");

  assert.match(javascript, /const RENDER_BATCH_SIZE = 24/u);
  assert.match(javascript, /videos\.slice\(renderedCount, renderedCount \+ RENDER_BATCH_SIZE\)/u);
  assert.match(javascript, /moreButton\.onclick = appendNextBatch/u);
  assert.match(javascript, /new IntersectionObserver\(/u);
  assert.match(javascript, /renderObserver\.observe\(moreButton\)/u);
  assert.match(html, /id="newsYoutubeMore"[^>]*hidden/u);

  assert.doesNotMatch(`${html}\n${javascript}`, /<iframe\b|\.innerHTML\b|insertAdjacentHTML\b|document\.write\b/iu);
  assert.match(javascript, /document\.createElement\("a"\)/u);
  assert.match(javascript, /link\.href = video\.url/u);
  assert.match(javascript, /link\.target = "_blank"/u);
  assert.match(javascript, /link\.rel = "noopener noreferrer"/u);
  assert.match(javascript, /video\.url === `https:\/\/www\.youtube\.com\/watch\?v=\$\{video\.videoId\}`/u);
  assert.match(javascript, /title\.textContent = video\.title/u);
  assert.match(javascript, /channel\.textContent = video\.channelName/u);
  assert.match(javascript, /relativeDate\.textContent = formatRelativeDate\(video\.publishedAt\)/u);

  assert.match(css, /grid-template-columns:\s*repeat\(3, minmax\(0, 347px\)\)/u);
  assert.match(css, /\.news-youtube-section\s*\{[\s\S]*?width:\s*min\(1073px, 100%\)/u);
  assert.match(css, /aspect-ratio:\s*347 \/ 195/u);
  assert.match(css, /-webkit-line-clamp:\s*2/u);
  assert.match(css, /line-clamp:\s*2/u);
  assert.match(css, /max-height:\s*44px/u);

  const switcherTabs = [...html.matchAll(/<a class="news-source-tab[^"]*"[^>]*data-news-media="([^"]+)"/gu)]
    .map((match) => match[1]);
  assert.deepEqual(switcherTabs, ["kcna", "rodong-sinmun", "youtube"], "the floating switcher must expose all three media sources");
  assert.match(sharedCss, /\.news-source-switcher\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?bottom:\s*calc\(32px/u);
  assert.match(html, /<header class="news-navigation">[\s\S]*?class="news-navigation-inner"/u);
  assert.match(html, /\/news\/news\.css\?v=news-20260823-7/u);
  assert.match(html, /class="news-logo" href="\/news"/u);
  assert.match(html, /class="news-navigation-links" id="newsNavigationLinks"/u);
  assert.match(html, /class="news-navigation-actions"/u);
  assert.match(html, /class="news-menu-toggle" id="newsMenuToggle"/u);
  assert.match(html, /<input name="source" type="hidden" value="youtube" \/>/u);
  assert.match(html, /<script src="\/news\/header\.js\?[^"]+" defer><\/script>/u);
}

await testHealthyCompleteRefresh();
await testPerChannelLastKnownGood();
await testBothFailuresPreserveBytes();
testStrictArtifactValidationAndDedupe();
testRssParserPreservesFullPublishedAtAndIdentity();
await testYouTubeUiConsumesTheCompleteArtifactSafely();

console.log("News YouTube pipeline tests passed.");
