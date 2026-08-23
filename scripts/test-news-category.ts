import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const rootDir = process.cwd();
const html = fs.readFileSync(path.join(rootDir, "news/category/index.html"), "utf8");
const script = fs.readFileSync(path.join(rootDir, "news/category.js"), "utf8");
const styles = fs.readFileSync(path.join(rootDir, "news/category.css"), "utf8");
const indexScript = fs.readFileSync(path.join(rootDir, "news/news.js"), "utf8");
const vercel = JSON.parse(fs.readFileSync(path.join(rootDir, "vercel.json"), "utf8"));

assert.match(html, /id="newsCategoryTitle"/u);
assert.match(html, /id="newsCategoryList"/u);
assert.match(html, /id="newsCategorySearchInput"/u);
assert.match(html, /<form class="news-search" action="\/news\/search"/u);
assert.match(html, /name="q"[^>]*data-news-global-search/u);
assert.match(html, /\/news\/header\.js\?v=news-header-20260823-2/u);
assert.match(html, /\/news\/news\.css\?v=news-20260823-7/u);
assert.match(html, /https:\/\/discord\.gg\/QT3T3JpeDD/u);
assert.match(html, /https:\/\/arca\.live\/b\/dprk\//u);
assert.match(html, /<a href="\/search">검색<\/a>/u);
assert.equal([...html.matchAll(/class="news-channel-content" aria-hidden="true"/gu)].length, 2);
assert.equal([...html.matchAll(/class="news-channel-arrow"/gu)].length, 2);
assert.match(html, /class="news-navigation-disabled" aria-disabled="true">사전/u);
assert.match(html, /class="material-symbols-rounded news-menu-toggle-icon"[^>]*>drag_handle<\/span>/u);
assert.match(html, /id="newsCategoryPagination"[^>]*aria-label="카테고리 페이지"/u);
assert.match(html, /\/news\/category\.css/u);
assert.match(html, /\/news\/category\.js/u);
assert.match(html, /category\.js\?v=news-category-20260823-3/u);
assert.match(html, /category\.css\?v=news-category-20260823-3/u);

assert.match(script, /const CATEGORY_ROOT_URL = "\/data\/news\/categories"/u);
assert.doesNotMatch(script, /\/data\/news-feed\.json/u, "category pages must not download the homepage preview feed");
assert.match(script, /buildCategoryDataUrl\(context, currentPage\)/u);
assert.match(script, /page-\$\{page\}\.json/u);
assert.match(script, /\/data\/news\/assets\//u);
assert.match(script, /sources\.push\(cachedSource\)[\s\S]*?resolveNewsImageProxySource/u);
assert.match(script, /`\/api\/news-image\?\$\{parameters\.toString\(\)\}`/u);
assert.match(script, /\/news\/document/u);
assert.match(script, /parameters\.get\("source"\)/u);
assert.match(script, /parameters\.get\("section"\)/u);
assert.match(script, /parameters\.get\("page"\)/u);
assert.doesNotMatch(script, /parameters\.get\("q"\)|applyFilter/u,
  "category pages must send searches to the all-article results page instead of filtering five rows");
assert.match(script, /const PAGE_SIZE = 5/u);
assert.match(script, /const PAGE_WINDOW = 5/u);
assert.equal(
  [...script.matchAll(/leadership:\s*"혁명활동소식"/gu)].length,
  2,
  "both category sources must use the concise leadership label",
);
assert.doesNotMatch(script, /경애하는 김정은동지의 혁명활동소식/u);
assert.match(script, /news-pagination-arrow-left\.svg/u);
assert.doesNotMatch(script, /\/data\/search|\/api\/search|\/search\/results|meilisearch/iu);
assert.doesNotMatch(script, /latest-day|category\.sourceId\s*===\s*["']rodong-sinmun["']/u);
const rodongDefinitionsMatch = script.match(/"rodong-sinmun":\s*\{([\s\S]*?)\n\s*\},\n\s*\}\);/u);
assert.ok(rodongDefinitionsMatch, "Rodong category definitions must be present");
assert.doesNotMatch(
  rodongDefinitionsMatch[1],
  /^\s*(?:international|document|foreign):/mu,
  "category routes must expose only Rodong's eight official sections",
);

const harnessScript = script.replace(
  "  const context = readCategoryContext();",
  "  globalThis.__newsCategoryTest = { buildCategoryDataUrl, isValidCategoryPage, getPaginationRange, normalizePageNumber }; return;\n  const context = readCategoryContext();",
);
assert.notEqual(harnessScript, script, "category test harness injection failed");

const sandbox: Record<string, unknown> = {
  document: { querySelector: () => ({}) },
};
vm.runInNewContext(harnessScript, sandbox, { filename: "news/category.js" });
const categoryTest = sandbox.__newsCategoryTest as {
  buildCategoryDataUrl: (category: { sourceId: string; sectionId: string }, page: number) => string;
  isValidCategoryPage: (
    payload: Record<string, unknown>,
    category: { sourceId: string; sectionId: string },
    requestedPage: number,
  ) => boolean;
  getPaginationRange: (page: number, totalPages: number) => number[];
  normalizePageNumber: (value: unknown) => number;
};

const categoryContext = {
  sourceId: "rodong-sinmun",
  sectionId: "important",
};
assert.equal(
  categoryTest.buildCategoryDataUrl(categoryContext, 27),
  "/data/news/categories/rodong-sinmun/important/page-27.json",
  "category navigation must fetch only the requested five-row static shard",
);
const validPage = {
  version: "0123456789abcdef",
  generatedAt: "2026-08-22T00:00:00.000Z",
  source: { id: "rodong-sinmun", name: "로동신문" },
  section: "important",
  page: 27,
  pageSize: 5,
  totalItems: 139,
  totalPages: 28,
  articles: Array.from({ length: 5 }, (_, index) => ({ id: `today-${index}` })),
};
assert.equal(categoryTest.isValidCategoryPage(validPage, categoryContext, 27), true);
assert.equal(categoryTest.isValidCategoryPage({ ...validPage, page: 26 }, categoryContext, 27), false);
assert.equal(categoryTest.isValidCategoryPage({ ...validPage, source: { id: "kcna", name: "조선중앙통신" } }, categoryContext, 27), false);
assert.equal(categoryTest.isValidCategoryPage({ ...validPage, articles: [...validPage.articles, { id: "overflow" }] }, categoryContext, 27), false);

assert.deepEqual(Array.from(categoryTest.getPaginationRange(1, 7)), [1, 2, 3, 4, 5]);
assert.deepEqual(Array.from(categoryTest.getPaginationRange(4, 7)), [2, 3, 4, 5, 6]);
assert.deepEqual(Array.from(categoryTest.getPaginationRange(7, 7)), [3, 4, 5, 6, 7]);
assert.deepEqual(Array.from(categoryTest.getPaginationRange(2, 3)), [1, 2, 3]);
assert.equal(categoryTest.normalizePageNumber("3"), 3);
for (const invalid of [undefined, null, "", "0", "-1", "2x", "1000000"]) {
  assert.equal(categoryTest.normalizePageNumber(invalid), 1);
}

assert.match(indexScript, /\/news\/category\?source=\$\{encodeURIComponent\(source\.id\)\}&section=\$\{encodeURIComponent\(section\.id\)\}/u);
assert.match(indexScript, /const heading = document\.createElement\("a"\)/u);
assert.match(indexScript, /const more = document\.createElement\("span"\)/u);
assert.match(indexScript, /heading\.href = `\/news\/category\?source=/u);
assert.match(indexScript, /heading\.setAttribute\("aria-label", `\$\{source\.name\} \$\{section\.title\} 전체 기사 보기`\)/u);
assert.doesNotMatch(indexScript, /more\.href\s*=/u);

assert.match(styles, /\.news-category-view\s*\{[^}]*width:\s*800px/su);
assert.match(styles, /\.news-category-title\s*\{[^}]*font-size:\s*36px[^}]*line-height:\s*1\.35/su);
assert.match(styles, /\.news-category-list\s*\{[^}]*gap:\s*64px[^}]*margin-top:\s*86px/su);
assert.match(styles, /\.news-category-row\s*\{[^}]*height:\s*128px/su);
assert.match(
  styles,
  /\.news-category-row-title\s*\{[^}]*white-space:\s*pre-line/su,
  "category titles must render canonical source line breaks",
);
assert.match(
  styles,
  /\.news-category-row-title\s*\{[^}]*-webkit-line-clamp:\s*2;[^}]*line-clamp:\s*2;[^}]*max-height:\s*2\.9em;/su,
  "category titles must never occupy more than two lines",
);
assert.match(styles, /\.news-category-thumbnail\s*\{[^}]*width:\s*228px[^}]*height:\s*128px[^}]*border-radius:\s*12px/su);
assert.match(styles, /\.news-category-pagination\s*\{[^}]*min-height:\s*36px[^}]*gap:\s*6px[^}]*margin-top:\s*54px/su);
assert.match(styles, /\.news-category-page-number\.active\s*\{[^}]*background:\s*var\(--news-gray-200\)[^}]*color:\s*var\(--news-gray-700\)/su);
assert.match(styles, /\.news-category-page-arrow,[\s\S]*?\.news-category-page-number\s*\{[^}]*width:\s*36px[^}]*height:\s*36px[^}]*border-radius:\s*18px[^}]*font-size:\s*17px[^}]*font-weight:\s*500/su);
assert.match(styles, /\.news-category-page-arrow-icon\.next\s*\{[^}]*transform:\s*scaleX\(-1\)/su);

const paginationAsset = fs.readFileSync(path.join(rootDir, "assets/news-pagination-arrow-left.svg"), "utf8");
assert.match(paginationAsset, /width="36" height="36" viewBox="0 0 36 36"/u);
assert.match(paginationAsset, /fill="#9CA3AF"/u);

const rewrites = Array.isArray(vercel.rewrites) ? vercel.rewrites : [];
for (const route of ["/news/category", "/news/category/"]) {
  assert.ok(
    rewrites.some((rewrite: { source?: string; destination?: string }) => (
      rewrite.source === route && rewrite.destination === "/news/category/index.html"
    )),
    `missing Vercel rewrite for ${route}`,
  );
}

console.log("News category page tests passed.");
