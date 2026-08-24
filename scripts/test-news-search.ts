#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const rootDir = process.cwd();
const html = fs.readFileSync(path.join(rootDir, "news/search/index.html"), "utf8");
const script = fs.readFileSync(path.join(rootDir, "news/search.js"), "utf8");
const styles = fs.readFileSync(path.join(rootDir, "news/category.css"), "utf8");
const searchStyles = fs.readFileSync(path.join(rootDir, "news/search.css"), "utf8");
const indexText = fs.readFileSync(path.join(rootDir, "data/news/search-index.json"), "utf8");
const searchIndex = JSON.parse(indexText);
const youtubeIndexText = fs.readFileSync(path.join(rootDir, "data/news/youtube-videos.json"), "utf8");
const youtubeIndex = JSON.parse(youtubeIndexText);
const feed = JSON.parse(fs.readFileSync(path.join(rootDir, "data/news-feed.json"), "utf8"));

assert.match(html, /<form class="news-search"[^>]*action="\/news\/search"[^>]*role="search"/u);
assert.match(html, /id="newsSearchInput"[^>]*name="q"[^>]*data-news-global-search/u);
assert.match(html, /id="newsSearchSource"[^>]*name="source"[^>]*type="hidden"[^>]*value="kcna"/u);
assert.match(html, /id="newsSearchResults"[^>]*role="list"/u);
assert.match(html, /id="newsSearchPagination"[^>]*aria-label="검색 결과 페이지"/u);
assert.match(html, /\/news\/category\.css\?v=news-category-20260823-3/u);
assert.match(html, /\/news\/news\.css\?v=news-20260823-7/u);
assert.match(html, /\/news\/header\.js\?v=news-header-20260823-2/u);
assert.match(html, /\/news\/search\.css\?v=news-search-20260823-1/u);
assert.match(html, /\/news\/search\.js\?v=news-search-20260824-1/u);
assert.match(html, /class="news-navigation-actions"/u);
assert.match(html, /class="news-navigation-disabled" aria-disabled="true"/u);
assert.match(html, /https:\/\/discord\.gg\/QT3T3JpeDD/u);
assert.match(html, /https:\/\/arca\.live\/b\/dprk\//u);
assert.match(html, /<a href="\/search">검색<\/a>/u);
assert.equal([...html.matchAll(/class="news-channel-content" aria-hidden="true"/gu)].length, 2);
assert.equal([...html.matchAll(/class="news-channel-arrow"/gu)].length, 2);
assert.match(html, /class="material-symbols-rounded news-menu-toggle-icon"[^>]*>drag_handle<\/span>/u);
assert.doesNotMatch(html, /<h1\b|news-category-title/u,
  "the search result view must omit the visible category heading");
assert.match(html, /class="news-source-switcher news-search-source-switcher"[^>]*role="tablist"[^>]*aria-label="검색 매체"/u);
for (const [sourceId, label] of [["kcna", "조선중앙통신"], ["rodong-sinmun", "로동신문"], ["youtube", "YouTube"]]) {
  assert.match(html, new RegExp(`data-news-search-source="${sourceId}"[^>]*>${label}<\\/a>`, "u"));
}
assert.equal([...html.matchAll(/data-news-search-source=/gu)].length, 3);
assert.match(searchStyles, /\.news-search-source-switcher\s*\{[^}]*width:\s*292px;/su,
  "the three-source search selector must reuse the exact shared floating pill width");

assert.match(styles, /\.news-category-view\s*\{[^}]*width:\s*800px/su,
  "category and search result views must use the exact 800px desktop width");
assert.match(styles, /\.news-search-results-list\s*\{[^}]*margin-top:\s*0/su,
  "the title-free search list must not retain the category heading offset");
assert.match(styles, /\.news-category-row\s*\{[^}]*height:\s*128px/su);
assert.match(styles, /\.news-category-list\s*\{[^}]*gap:\s*64px/su);
assert.match(styles, /\.news-category-thumbnail\s*\{[^}]*width:\s*228px[^}]*height:\s*128px/su);
assert.match(
  styles,
  /\.news-category-row-title\s*\{[^}]*-webkit-line-clamp:\s*2;[^}]*line-clamp:\s*2;[^}]*max-height:\s*2\.9em;/su,
  "search result titles must never occupy more than two lines",
);

assert.match(script, /const SEARCH_INDEX_URL = "\/data\/news\/search-index\.json"/u);
assert.match(script, /const YOUTUBE_INDEX_URL = "\/data\/news\/youtube-videos\.json"/u);
assert.match(script, /const LATEST_NEWS_URL = "\/api\/news-latest"/u);
assert.match(script, /const LATEST_YOUTUBE_URL = "\/api\/news-youtube-latest"/u);
assert.match(script, /queueLatestNews\(sourceId\)/u);
assert.match(script, /queueLatestYoutube\(\)/u);
assert.match(script, /await indexPromise;[\s\S]*?return filterArticlesBySource\(preparedArticles, sourceId\);/u,
  "News search rerenders must read the asynchronously merged overlay, not the original static promise value");
assert.match(script, /await youtubeIndexPromise;[\s\S]*?return preparedYoutubeVideos;/u,
  "YouTube search rerenders must read the asynchronously merged overlay, not the original static promise value");
assert.match(script, /\["live", "degraded", "fallback"\]\.includes\(source\.mode\)/u);
assert.match(script, /mergePreparedEntries\([\s\S]*?payload\.videos\.map\(prepareYoutubeVideo\),[\s\S]*?preparedYoutubeVideos/u,
  "YouTube search must merge the recent Atom overlay into the complete static index");
assert.match(script, /const PAGE_SIZE = 5/u);
assert.match(script, /const SEARCH_DEBOUNCE_MS = 150/u);
assert.match(script, /history\.replaceState/u);
assert.match(script, /history\.pushState/u);
assert.match(script, /window\.addEventListener\("popstate", syncFromLocation\)/u);
assert.match(script, /tokens\.every\(\(token\) => entry\.searchText\.includes\(token\)\)/u,
  "all normalized query tokens must match one article");
assert.match(script, /searchText:\s*normalizeSearchText\(article\.title\)/u,
  "full News search must index article titles only");
assert.match(script, /filterArticlesBySource\(articles, sourceId\)/u,
  "official News search must be restricted to the selected source");
assert.match(script, /payload\.videos\.map\(prepareYoutubeVideo\)/u,
  "YouTube search must index every video from the dedicated full-channel artifact");
assert.match(script, /data-news-search-source/u);
assert.match(script, /articleTitle\.textContent =/u);
assert.doesNotMatch(script, /innerHTML/u, "search results must never render source text as HTML");
assert.doesNotMatch(script, /news-menu-open/u,
  "the result script must leave shared menu behavior to news/header.js");
assert.doesNotMatch(script, /toLocaleLowerCase\("en-US"\) === "k"/u,
  "the result script must leave the shared keyboard shortcut to news/header.js");

const harnessScript = script.replace(
  "  bindSearchControls();",
  `  globalThis.__newsSearchTest = {
    buildSearchUrl,
    filterArticlesBySource,
    findMatchingArticles,
    getPaginationRange,
    isAllowedOfficialNewsImageUrl,
    isAllowedYoutubeThumbnailUrl,
    isAllowedYoutubeVideoUrl,
    isValidSearchIndex,
    isValidYoutubeIndex,
    loadSearchIndex,
    loadYoutubeIndex,
    normalizePageNumber,
    normalizeSearchText,
    normalizeSourceId,
    prepareSearchArticle,
    prepareYoutubeVideo,
    resolveCachedImageSource,
    resolveNewsImageProxySource,
    setCurrentSourceForOverlayTest: (sourceId) => { currentSourceId = sourceId; },
    validateQuery,
    waitForLatestNewsForOverlayTest: (sourceId) => latestNewsPromises.get(sourceId),
    waitForLatestYoutubeForOverlayTest: () => latestYoutubePromise,
  }; return;
  bindSearchControls();`,
);
assert.notEqual(harnessScript, script, "search test harness injection failed");

const placeholder = { dataset: {} };
const sandbox: Record<string, unknown> = {
  document: {
    querySelector: () => placeholder,
    querySelectorAll: () => [placeholder, placeholder, placeholder],
  },
  TextEncoder,
  URL,
  URLSearchParams,
  unescape,
};
vm.runInNewContext(harnessScript, sandbox, { filename: "news/search.js" });
const searchTest = sandbox.__newsSearchTest as {
  buildSearchUrl: (query: string, page: number, sourceId?: string) => string;
  filterArticlesBySource: (articles: Array<{ article: any; searchText: string }>, sourceId: string) => Array<{ article: any }>;
  findMatchingArticles: (articles: Array<{ article: unknown; searchText: string }>, tokens: string[]) => Array<{ article: any }>;
  getPaginationRange: (page: number, totalPages: number) => number[];
  isAllowedOfficialNewsImageUrl: (value: string) => boolean;
  isAllowedYoutubeThumbnailUrl: (value: string, expectedVideoId?: string) => boolean;
  isAllowedYoutubeVideoUrl: (value: string, expectedVideoId?: string) => boolean;
  isValidSearchIndex: (value: unknown) => boolean;
  isValidYoutubeIndex: (value: unknown) => boolean;
  loadSearchIndex: (sourceId: string) => Promise<Array<{ article: any }>>;
  loadYoutubeIndex: () => Promise<Array<{ article: any }>>;
  normalizePageNumber: (value: unknown) => number;
  normalizeSearchText: (value: unknown) => string;
  normalizeSourceId: (value: unknown) => string;
  prepareSearchArticle: (article: Record<string, unknown>) => { article: Record<string, unknown>; searchText: string };
  prepareYoutubeVideo: (video: Record<string, unknown>) => { article: Record<string, unknown>; searchText: string };
  resolveCachedImageSource: (value: string, sourceId: string) => string;
  resolveNewsImageProxySource: (value: string, referer: string) => string;
  setCurrentSourceForOverlayTest: (sourceId: string) => void;
  validateQuery: (value: unknown) => { valid: boolean; query: string; tokens: string[]; message: string };
  waitForLatestNewsForOverlayTest: (sourceId: string) => Promise<void> | undefined;
  waitForLatestYoutubeForOverlayTest: () => Promise<void> | null;
};

await testAsyncLatestOverlaysAppearInSearch();

async function testAsyncLatestOverlaysAppearInSearch() {
  const staticNewsUrl = `http://www.kcna.kp/kp/article/detail/${"a".repeat(32)}`;
  const latestNewsUrl = `http://www.kcna.kp/kp/article/detail/${"b".repeat(32)}`;
  const staticNewsId = `news:kcna:${"1".repeat(24)}`;
  const latestNewsId = `news:kcna:${"2".repeat(24)}`;
  const staticNewsPayload = {
    schemaVersion: 1,
    version: "1".repeat(16),
    generatedAt: "2026-08-24T00:00:00.000Z",
    totalItems: 1,
    articles: [{
      id: staticNewsId,
      title: "게시된 정적 뉴스",
      date: "2026-08-23",
      sourceId: "kcna",
      sourceName: "조선중앙통신",
      snippet: "",
      url: staticNewsUrl,
      thumbnailUrl: "",
      cachedThumbnailUrl: "",
      detailUrl: `/news/document?id=${encodeURIComponent(staticNewsId)}`,
    }],
  };
  const latestNewsPayload = {
    schemaVersion: 1,
    generatedAt: "2026-08-24T01:00:00.000Z",
    sources: {
      kcna: {
        id: "kcna",
        mode: "live",
        articles: [{
          id: latestNewsId,
          sourceId: "kcna",
          sourceName: "조선중앙통신",
          title: "접속 후 들어온 최신 뉴스",
          date: "2026-08-24",
          snippet: "",
          url: latestNewsUrl,
          thumbnailUrl: "",
          cachedThumbnailUrl: "",
          detailUrl: latestNewsUrl,
          archived: false,
        }],
      },
    },
  };
  const staticYoutubeId = "AAAAAAAAAAA";
  const latestYoutubeId = "BBBBBBBBBBB";
  const staticYoutubePayload = {
    schemaVersion: 1,
    version: "static-youtube",
    generatedAt: "2026-08-24T00:00:00.000Z",
    totalItems: 1,
    channelCounts: { 메아리: 1, supersuhui: 0 },
    videos: [makeOverlayVideo(staticYoutubeId, "메아리", "게시된 정적 영상", "2026-08-23T01:00:00.000Z")],
  };
  const latestYoutubePayload = {
    schemaVersion: 1,
    version: "latest-youtube",
    generatedAt: "2026-08-24T02:00:00.000Z",
    totalItems: 1,
    channelCounts: { 메아리: 0, supersuhui: 1 },
    videos: [makeOverlayVideo(latestYoutubeId, "supersuhui", "접속 후 들어온 최신 영상", "2026-08-24T02:00:00.000Z")],
    refresh: { status: "success", checkedAt: "2026-08-24T02:00:00.000Z" },
  };

  let releaseNewsLatest!: () => void;
  let releaseYoutubeLatest!: () => void;
  const newsLatestResponse = new Promise<any>((resolve) => {
    releaseNewsLatest = () => resolve(jsonResponse(latestNewsPayload));
  });
  const youtubeLatestResponse = new Promise<any>((resolve) => {
    releaseYoutubeLatest = () => resolve(jsonResponse(latestYoutubePayload));
  });
  sandbox.fetch = (url: string) => {
    if (url === "/data/news/search-index.json") return Promise.resolve(jsonResponse(staticNewsPayload));
    if (url === "/api/news-latest?source=kcna") return newsLatestResponse;
    if (url === "/data/news/youtube-videos.json") return Promise.resolve(jsonResponse(staticYoutubePayload));
    if (url === "/api/news-youtube-latest") return youtubeLatestResponse;
    return Promise.reject(new Error(`unexpected search fixture URL: ${url}`));
  };

  searchTest.setCurrentSourceForOverlayTest("youtube");
  const initialNews = await searchTest.loadSearchIndex("kcna");
  assert.deepEqual(Array.from(initialNews, (entry) => entry.article.id), [staticNewsId]);
  releaseNewsLatest();
  await searchTest.waitForLatestNewsForOverlayTest("kcna");
  const refreshedNews = await searchTest.loadSearchIndex("kcna");
  assert.deepEqual(Array.from(refreshedNews, (entry) => entry.article.id), [latestNewsId, staticNewsId],
    "the resolved access-time News overlay must be searchable on the next render");

  searchTest.setCurrentSourceForOverlayTest("kcna");
  const initialYoutube = await searchTest.loadYoutubeIndex();
  assert.deepEqual(Array.from(initialYoutube, (entry) => entry.article.id), [`youtube-${staticYoutubeId}`]);
  releaseYoutubeLatest();
  await searchTest.waitForLatestYoutubeForOverlayTest();
  const refreshedYoutube = await searchTest.loadYoutubeIndex();
  assert.deepEqual(Array.from(refreshedYoutube, (entry) => entry.article.id), [
    `youtube-${latestYoutubeId}`,
    `youtube-${staticYoutubeId}`,
  ], "the resolved access-time YouTube overlay must be searchable on the next render");
}

function makeOverlayVideo(videoId: string, channelName: string, title: string, publishedAt: string) {
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

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

assert.equal(indexText, `${JSON.stringify(searchIndex)}\n`, "the full search index must use compact deterministic JSON");
assert.equal(searchIndex.schemaVersion, 1);
assert.equal(searchIndex.version, feed.version);
assert.ok(searchIndex.totalItems >= 9_450, "the full index must never regress below the current 9,450-article archive");
assert.equal(searchIndex.articles.length, searchIndex.totalItems);
assert.equal(new Set(searchIndex.articles.map((article: { id: string }) => article.id)).size, searchIndex.totalItems);
assert.deepEqual(
  Object.fromEntries(["kcna", "rodong-sinmun"].map((sourceId) => [
    sourceId,
    searchIndex.articles.filter((article: { sourceId: string }) => article.sourceId === sourceId).length,
  ])),
  {
    kcna: feed.sources.kcna.totalItems,
    "rodong-sinmun": feed.sources["rodong-sinmun"].totalItems,
  },
);
assert.equal(searchTest.isValidSearchIndex(searchIndex), true);
assert.equal(searchTest.isValidSearchIndex({
  ...searchIndex,
  articles: [...searchIndex.articles.slice(0, -1), searchIndex.articles[0]],
}), false, "duplicate article ids must invalidate the browser index");
assert.equal(youtubeIndexText, `${JSON.stringify(youtubeIndex)}\n`, "the full YouTube search artifact must use compact deterministic JSON");
assert.equal(searchTest.isValidYoutubeIndex(youtubeIndex), true);
assert.equal(youtubeIndex.totalItems, youtubeIndex.videos.length);
assert.equal(youtubeIndex.channelCounts["메아리"] + youtubeIndex.channelCounts.supersuhui, youtubeIndex.totalItems);
assert.equal(youtubeIndex.channelCounts["메아리"] > 0, true);
assert.equal(youtubeIndex.channelCounts.supersuhui > 0, true);
const preparedYoutubeIndex = youtubeIndex.videos.map(searchTest.prepareYoutubeVideo);
assert.equal(preparedYoutubeIndex.length, youtubeIndex.totalItems,
  "every published video from both channels must be searchable, without a feature subset or cap");
const firstYoutubeTitleQuery = searchTest.validateQuery(youtubeIndex.videos[0].title);
assert.equal(searchTest.findMatchingArticles(preparedYoutubeIndex, firstYoutubeTitleQuery.tokens)
  .some((entry) => entry.article.id === youtubeIndex.videos[0].id), true);

const detailIds = new Set<string>();
for (const fileName of fs.readdirSync(path.join(rootDir, "data/news/details")).filter((name) => name.endsWith(".json"))) {
  const shard = JSON.parse(fs.readFileSync(path.join(rootDir, "data/news/details", fileName), "utf8"));
  for (const id of Object.keys(shard.articles)) detailIds.add(id);
}
assert.equal(detailIds.size, searchIndex.totalItems);
assert.deepEqual(
  [...new Set(searchIndex.articles.map((article: { id: string }) => article.id))].sort(),
  [...detailIds].sort(),
  "the search index and published detail shards must expose exactly the same article ids",
);

const preparedIndex = searchIndex.articles.map(searchTest.prepareSearchArticle);
for (const sourceId of ["kcna", "rodong-sinmun"]) {
  const selectedEntries = searchTest.filterArticlesBySource(preparedIndex, sourceId);
  assert.equal(selectedEntries.length, feed.sources[sourceId].totalItems);
  assert.equal(selectedEntries.every((entry) => entry.article.sourceId === sourceId), true,
    `${sourceId} search must never leak results from another medium`);
}
assert.equal(searchTest.normalizeSourceId("youtube"), "youtube");
assert.equal(searchTest.normalizeSourceId("rodong-sinmun"), "rodong-sinmun");
assert.equal(searchTest.normalizeSourceId("invalid"), "kcna");
const archivedOnlyId = "news:kcna:6317a9a751ba5e98c39aacef";
assert.equal(
  Object.values(feed.sources).some((source: any) => source.articles.some((article: any) => article.id === archivedOnlyId)),
  false,
  "the smoke-test article must remain outside homepage previews",
);
const archivedQuery = searchTest.validateQuery("특별손님 과학자들");
assert.equal(archivedQuery.valid, true);
assert.equal(
  searchTest.findMatchingArticles(preparedIndex, archivedQuery.tokens).some((entry) => entry.article.id === archivedOnlyId),
  true,
  "an older article absent from the homepage must be found through the full index",
);

const crossFieldArticle = searchTest.prepareSearchArticle({
  id: "news:rodong-sinmun:test-search",
  title: "과학기술의 힘",
  date: "2025-03-08",
  sourceId: "rodong-sinmun",
  sourceName: "로동신문",
  snippet: "교육사업을 개선하였다.",
  url: "http://www.rodong.rep.kp/ko/index.php?test-search",
  thumbnailUrl: "",
  cachedThumbnailUrl: "",
  detailUrl: "/news/document?id=news%3Arodong-sinmun%3Atest-search",
});
for (const query of ["과학기술 힘", "과학기술의 힘"]) {
  const validated = searchTest.validateQuery(query);
  assert.equal(searchTest.findMatchingArticles([crossFieldArticle], validated.tokens).length, 1, `${query} title-only token-AND search`);
}
for (const query of ["교육사업", "로동신문", "2025", "과학 교육"]) {
  const validated = searchTest.validateQuery(query);
  assert.equal(searchTest.findMatchingArticles([crossFieldArticle], validated.tokens).length, 0,
    `${query} must not match snippet, source, date, or a cross-field combination`);
}

const youtubeVideoId = "UPUkZp6_EXU";
const youtubeVideo = {
  id: `youtube:${youtubeVideoId}`,
  videoId: youtubeVideoId,
  title: "원산갈마해안관광지구 준공식",
  channelName: "메아리",
  publishedAt: "2026-08-22T12:00:00.000Z",
  date: "2026-08-22",
  url: `https://www.youtube.com/watch?v=${youtubeVideoId}`,
  thumbnailUrl: `https://i.ytimg.com/vi/${youtubeVideoId}/hqdefault.jpg`,
};
const supersuhuiVideoId = "43cor_kHqow";
const supersuhuiVideo = {
  id: `youtube:${supersuhuiVideoId}`,
  videoId: supersuhuiVideoId,
  title: "중앙텔레비죤 20시보도",
  channelName: "supersuhui",
  publishedAt: "2026-08-21T12:00:00.000Z",
  date: "2026-08-21",
  url: `https://www.youtube.com/watch?v=${supersuhuiVideoId}`,
  thumbnailUrl: `https://i1.ytimg.com/vi_webp/${supersuhuiVideoId}/maxresdefault.webp`,
};
const youtubePayload = {
  schemaVersion: 1,
  generatedAt: "2026-08-23T00:00:00.000Z",
  version: "fixture-youtube-v1",
  totalItems: 2,
  channelCounts: { 메아리: 1, supersuhui: 1 },
  videos: [youtubeVideo, supersuhuiVideo],
};
assert.equal(searchTest.isValidYoutubeIndex(youtubePayload), true);
assert.equal(searchTest.isValidYoutubeIndex({ ...youtubePayload, totalItems: 1 }), false);
assert.equal(searchTest.isValidYoutubeIndex({ ...youtubePayload, videos: [...youtubePayload.videos].reverse() }), false,
  "the full YouTube artifact must remain newest-first");
assert.equal(searchTest.isAllowedYoutubeVideoUrl(youtubeVideo.url, youtubeVideoId), true);
assert.equal(searchTest.isAllowedYoutubeVideoUrl("https://attacker.example/watch?v=UPUkZp6_EXU"), false);
assert.equal(searchTest.isAllowedYoutubeThumbnailUrl(youtubeVideo.thumbnailUrl, youtubeVideoId), true);
assert.equal(searchTest.isAllowedYoutubeThumbnailUrl("https://attacker.example/vi/UPUkZp6_EXU/hqdefault.jpg"), false);
const preparedYoutube = youtubePayload.videos.map(searchTest.prepareYoutubeVideo);
assert.equal(searchTest.findMatchingArticles(preparedYoutube, searchTest.validateQuery("원산갈마").tokens).length, 1);
assert.equal(searchTest.findMatchingArticles(preparedYoutube, searchTest.validateQuery("메아리").tokens).length, 0,
  "YouTube search must index titles only, not channel names");
assert.equal(preparedYoutube.every((entry) => entry.article.sourceId === "youtube"), true);
assert.equal(preparedYoutube[0].article.detailUrl, youtubeVideo.url);
assert.equal(
  searchTest.findMatchingArticles([crossFieldArticle], searchTest.validateQuery("과학 불일치").tokens).length,
  0,
);
assert.equal(searchTest.normalizeSearchText("  ＫＣＮＡ\n기사  "), "kcna 기사");
assert.equal(searchTest.validateQuery("정상\u202e검색").valid, false);
assert.equal(searchTest.validateQuery("가".repeat(101)).valid, false);

assert.equal(searchTest.buildSearchUrl("김정은 동지", 2, "rodong-sinmun"), "/news/search?source=rodong-sinmun&q=%EA%B9%80%EC%A0%95%EC%9D%80+%EB%8F%99%EC%A7%80&page=2");
assert.equal(searchTest.buildSearchUrl("", 9, "youtube"), "/news/search?source=youtube");
assert.equal(searchTest.buildSearchUrl("뉴스", 1, "invalid"), "/news/search?source=kcna&q=%EB%89%B4%EC%8A%A4");
assert.deepEqual(Array.from(searchTest.getPaginationRange(1, 8)), [1, 2, 3, 4, 5]);
assert.deepEqual(Array.from(searchTest.getPaginationRange(5, 8)), [3, 4, 5, 6, 7]);
assert.deepEqual(Array.from(searchTest.getPaginationRange(8, 8)), [4, 5, 6, 7, 8]);
for (const invalid of [undefined, null, "", "0", "-1", "2x", "1000000"]) {
  assert.equal(searchTest.normalizePageNumber(invalid), 1);
}

const cachedImage = `/data/news/assets/kcna/${"a".repeat(64)}.jpg`;
assert.equal(searchTest.resolveCachedImageSource(cachedImage, "kcna"), cachedImage);
assert.equal(searchTest.resolveCachedImageSource(cachedImage, "rodong-sinmun"), "");
assert.equal(searchTest.resolveCachedImageSource("/data/news/assets/kcna/../secret.jpg", "kcna"), "");
const officialImage = "http://www.kcna.kp/photo/0123456789abcdef0123456789abcdef";
const officialReferer = "http://www.kcna.kp/kp/article/detail/0123456789abcdef";
assert.equal(searchTest.isAllowedOfficialNewsImageUrl(officialImage), true);
assert.equal(searchTest.isAllowedOfficialNewsImageUrl("https://attacker.example/photo/0123456789abcdef0123456789abcdef"), false);
const proxyUrl = new URL(searchTest.resolveNewsImageProxySource(officialImage, officialReferer), "https://nkarchive.vercel.app");
assert.equal(proxyUrl.pathname, "/api/news-image");
assert.equal(proxyUrl.searchParams.get("url"), officialImage);
assert.equal(proxyUrl.searchParams.get("referer"), officialReferer);

console.log("Full News search tests passed.");
