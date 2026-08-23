#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const rootDir = process.cwd();
const html = fs.readFileSync(path.join(rootDir, "news/search/index.html"), "utf8");
const script = fs.readFileSync(path.join(rootDir, "news/search.js"), "utf8");
const styles = fs.readFileSync(path.join(rootDir, "news/category.css"), "utf8");
const indexText = fs.readFileSync(path.join(rootDir, "data/news/search-index.json"), "utf8");
const searchIndex = JSON.parse(indexText);
const feed = JSON.parse(fs.readFileSync(path.join(rootDir, "data/news-feed.json"), "utf8"));

assert.match(html, /<form class="news-search"[^>]*action="\/news\/search"[^>]*role="search"/u);
assert.match(html, /id="newsSearchInput"[^>]*name="q"[^>]*data-news-global-search/u);
assert.match(html, /id="newsSearchResults"[^>]*role="list"/u);
assert.match(html, /id="newsSearchPagination"[^>]*aria-label="검색 결과 페이지"/u);
assert.match(html, /\/news\/category\.css\?v=news-category-20260823-2/u);
assert.match(html, /\/news\/news\.css\?v=news-20260823-4/u);
assert.match(html, /\/news\/header\.js\?v=news-header-20260823-2/u);
assert.match(html, /\/news\/search\.js\?v=news-search-20260823-1/u);
assert.match(html, /class="news-navigation-actions"/u);
assert.match(html, /class="news-navigation-disabled" aria-disabled="true"/u);
assert.match(html, /https:\/\/discord\.gg\/QT3T3JpeDD/u);
assert.match(html, /https:\/\/arca\.live\/b\/dprk\//u);
assert.match(html, /class="material-symbols-rounded news-menu-toggle-icon"[^>]*>drag_handle<\/span>/u);
assert.doesNotMatch(html, /<h1\b|news-category-title|news-source-switcher|newsSourceKcna|newsSourceRodong/u,
  "the search result view must omit the visible category heading and source switcher");

assert.match(styles, /\.news-category-view\s*\{[^}]*width:\s*800px/su,
  "category and search result views must use the exact 800px desktop width");
assert.match(styles, /\.news-search-results-list\s*\{[^}]*margin-top:\s*0/su,
  "the title-free search list must not retain the category heading offset");
assert.match(styles, /\.news-category-row\s*\{[^}]*height:\s*128px/su);
assert.match(styles, /\.news-category-list\s*\{[^}]*gap:\s*64px/su);
assert.match(styles, /\.news-category-thumbnail\s*\{[^}]*width:\s*228px[^}]*height:\s*128px/su);

assert.match(script, /const SEARCH_INDEX_URL = "\/data\/news\/search-index\.json"/u);
assert.match(script, /const PAGE_SIZE = 5/u);
assert.match(script, /const SEARCH_DEBOUNCE_MS = 150/u);
assert.match(script, /history\.replaceState/u);
assert.match(script, /history\.pushState/u);
assert.match(script, /window\.addEventListener\("popstate", syncFromLocation\)/u);
assert.match(script, /tokens\.every\(\(token\) => entry\.searchText\.includes\(token\)\)/u,
  "all normalized query tokens must match one article");
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
    findMatchingArticles,
    getPaginationRange,
    isAllowedOfficialNewsImageUrl,
    isValidSearchIndex,
    normalizePageNumber,
    normalizeSearchText,
    prepareSearchArticle,
    resolveCachedImageSource,
    resolveNewsImageProxySource,
    validateQuery,
  }; return;
  bindSearchControls();`,
);
assert.notEqual(harnessScript, script, "search test harness injection failed");

const placeholder = {};
const sandbox: Record<string, unknown> = {
  document: { querySelector: () => placeholder },
  TextEncoder,
  URL,
  URLSearchParams,
  unescape,
};
vm.runInNewContext(harnessScript, sandbox, { filename: "news/search.js" });
const searchTest = sandbox.__newsSearchTest as {
  buildSearchUrl: (query: string, page: number) => string;
  findMatchingArticles: (articles: Array<{ article: unknown; searchText: string }>, tokens: string[]) => Array<{ article: any }>;
  getPaginationRange: (page: number, totalPages: number) => number[];
  isAllowedOfficialNewsImageUrl: (value: string) => boolean;
  isValidSearchIndex: (value: unknown) => boolean;
  normalizePageNumber: (value: unknown) => number;
  normalizeSearchText: (value: unknown) => string;
  prepareSearchArticle: (article: Record<string, unknown>) => { article: Record<string, unknown>; searchText: string };
  resolveCachedImageSource: (value: string, sourceId: string) => string;
  resolveNewsImageProxySource: (value: string, referer: string) => string;
  validateQuery: (value: unknown) => { valid: boolean; query: string; tokens: string[]; message: string };
};

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
for (const query of ["과학 교육", "로동신문 2025년", "2025.03.08."]) {
  const validated = searchTest.validateQuery(query);
  assert.equal(searchTest.findMatchingArticles([crossFieldArticle], validated.tokens).length, 1, `${query} token-AND search`);
}
assert.equal(
  searchTest.findMatchingArticles([crossFieldArticle], searchTest.validateQuery("과학 불일치").tokens).length,
  0,
);
assert.equal(searchTest.normalizeSearchText("  ＫＣＮＡ\n기사  "), "kcna 기사");
assert.equal(searchTest.validateQuery("정상\u202e검색").valid, false);
assert.equal(searchTest.validateQuery("가".repeat(101)).valid, false);

assert.equal(searchTest.buildSearchUrl("김정은 동지", 2), "/news/search?q=%EA%B9%80%EC%A0%95%EC%9D%80+%EB%8F%99%EC%A7%80&page=2");
assert.equal(searchTest.buildSearchUrl("", 9), "/news/search");
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
