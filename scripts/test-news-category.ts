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
assert.match(html, /id="newsCategoryPagination"[^>]*aria-label="카테고리 페이지"/u);
assert.match(html, /\/news\/category\.css/u);
assert.match(html, /\/news\/category\.js/u);
assert.match(html, /news-category-20260822-2/u);

assert.match(script, /const FEED_URL = "\/data\/news-feed\.json"/u);
assert.match(script, /\/data\/news\/assets\//u);
assert.match(script, /\/news\/document/u);
assert.match(script, /parameters\.get\("source"\)/u);
assert.match(script, /parameters\.get\("section"\)/u);
assert.match(script, /parameters\.get\("page"\)/u);
assert.match(script, /parameters\.get\("q"\)/u);
assert.match(script, /const PAGE_SIZE = 5/u);
assert.match(script, /const PAGE_WINDOW = 5/u);
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
  "  globalThis.__newsCategoryTest = { selectCategoryArticles, compareArticlesNewestFirst, getPaginationRange, normalizePageNumber, paginateArticles }; return;\n  const context = readCategoryContext();",
);
assert.notEqual(harnessScript, script, "category test harness injection failed");

const sandbox: Record<string, unknown> = {
  document: { querySelector: () => ({}) },
};
vm.runInNewContext(harnessScript, sandbox, { filename: "news/category.js" });
const categoryTest = sandbox.__newsCategoryTest as {
  compareArticlesNewestFirst: (left: Record<string, unknown>, right: Record<string, unknown>) => number;
  selectCategoryArticles: (
    articles: Array<Record<string, unknown>>,
    category: { sourceId: string; sectionId: string },
  ) => Array<Record<string, unknown>>;
  getPaginationRange: (page: number, totalPages: number) => number[];
  normalizePageNumber: (value: unknown) => number;
  paginateArticles: (
    articles: Array<Record<string, unknown>>,
    page: number,
  ) => { articles: Array<Record<string, unknown>>; page: number; totalPages: number };
};

const importantArticles = [
  { id: "unrelated", title: "중요해 보이지만 국내소식", date: "2026-08-22", categories: ["domestic"] },
  { id: "day-21", title: "전국당간부양성부문교원강습회 진행", date: "2026-08-21", categories: ["important"] },
  { id: "day-20", title: "김여정 조선로동당 중앙위원회 부장 담화 발표", date: "2026-08-20", categories: ["important"] },
  { id: "commentary", title: "조선중앙통신사 론평", date: "2026-08-19", categories: ["important"] },
  { id: "kim", title: "김여정 조선로동당 중앙위원회 부장 주요국제문제들에 대한 립장 발표", date: "2026-08-19", categories: ["important"] },
  { id: "day-18", title: "박태성 내각총리 여러 부문 사업 현지료해", date: "2026-08-18", categories: ["important"] },
  { id: "day-17", title: "여섯번째 기사", date: "2026-08-17", categories: ["important"] },
];
const selectedImportant = categoryTest.selectCategoryArticles(importantArticles, {
  sourceId: "kcna",
  sectionId: "important",
});
assert.deepEqual(
  Array.from(selectedImportant, (article) => article.id),
  ["day-21", "day-20", "kim", "commentary", "day-18", "day-17"],
  "category selection must retain every exact official article before pagination",
);
assert.deepEqual(
  Array.from(categoryTest.paginateArticles(selectedImportant, 1).articles, (article) => article.id),
  ["day-21", "day-20", "kim", "commentary", "day-18"],
  "the first category page must match the Figma frame's latest five",
);
assert.deepEqual(
  Array.from(categoryTest.paginateArticles(selectedImportant, 2).articles, (article) => article.id),
  ["day-17"],
  "later pages must expose the remaining exact-category articles",
);

assert.ok(
  categoryTest.compareArticlesNewestFirst(
    { id: "a", title: "같은 제목", date: "2026-08-19" },
    { id: "b", title: "같은 제목", date: "2026-08-19" },
  ) < 0,
  "article id must be the final deterministic tie-breaker",
);

const rodongToday = Array.from({ length: 6 }, (_, index) => ({
  id: `today-${index}`,
  title: `오늘 기사 ${index}`,
  date: "2026-08-21",
  categories: ["important"],
  mediaType: "article",
}));
rodongToday.push({
  id: "yesterday",
  title: "어제 기사",
  date: "2026-08-20",
  categories: ["important"],
  mediaType: "article",
});
const selectedRodong = categoryTest.selectCategoryArticles(rodongToday, {
  sourceId: "rodong-sinmun",
  sectionId: "important",
});
assert.equal(selectedRodong.length, 7);
assert.equal(categoryTest.paginateArticles(selectedRodong, 1).articles.length, 5);
assert.equal(categoryTest.paginateArticles(selectedRodong, 2).articles.length, 2);

assert.deepEqual(Array.from(categoryTest.getPaginationRange(1, 7)), [1, 2, 3, 4, 5]);
assert.deepEqual(Array.from(categoryTest.getPaginationRange(4, 7)), [2, 3, 4, 5, 6]);
assert.deepEqual(Array.from(categoryTest.getPaginationRange(7, 7)), [3, 4, 5, 6, 7]);
assert.deepEqual(Array.from(categoryTest.getPaginationRange(2, 3)), [1, 2, 3]);
assert.equal(categoryTest.normalizePageNumber("3"), 3);
for (const invalid of [undefined, null, "", "0", "-1", "2x", "1000000"]) {
  assert.equal(categoryTest.normalizePageNumber(invalid), 1);
}

assert.match(indexScript, /\/news\/category\?source=\$\{encodeURIComponent\(source\.id\)\}&section=\$\{encodeURIComponent\(section\.id\)\}/u);

assert.match(styles, /\.news-category-view\s*\{[^}]*width:\s*1024px/su);
assert.match(styles, /\.news-category-title\s*\{[^}]*font-size:\s*36px[^}]*line-height:\s*1\.35/su);
assert.match(styles, /\.news-category-list\s*\{[^}]*gap:\s*64px[^}]*margin-top:\s*86px/su);
assert.match(styles, /\.news-category-row\s*\{[^}]*height:\s*128px/su);
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
