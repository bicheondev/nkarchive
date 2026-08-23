#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const readText = (relativePath) => fs.readFile(path.join(ROOT_DIR, relativePath), "utf8");

const [html, script, css, icon] = await Promise.all([
  readText("news/document-template.html"),
  readText("news/detail.js"),
  readText("news/news.css"),
  fs.readFile(path.join(ROOT_DIR, "assets/news-share-link.svg")),
]);

assert.equal(
  createHash("sha256").update(icon).digest("hex"),
  "971081017fea2066a6bdd389954a97c9adae9a6c4a8d679ad30edc99f7076865",
  "share icon must preserve the exact exported Figma asset",
);
assert.match(html, /<div class="news-document-article">[\s\S]*?<button class="news-document-share"/u);
assert.match(html, /\/news\/comments\.js\?v=news-comments-20260823-1/u);
assert.match(html, /\/news\/news\.css\?v=news-20260823-6/u);
assert.match(html, /\/news\/header\.js\?v=news-header-20260823-2/u);
assert.match(html, /\/news\/detail\.js\?v=news-detail-20260823-2/u);
assert.doesNotMatch(html, /data-news-global-search/u, "article pages only need the shared channel buttons");
assert.match(html, /https:\/\/discord\.gg\/QT3T3JpeDD/u);
assert.match(html, /https:\/\/arca\.live\/b\/dprk\//u);
assert.match(html, /<a href="\/search">검색<\/a>/u);
assert.equal([...html.matchAll(/class="news-channel-content" aria-hidden="true"/gu)].length, 2);
assert.equal([...html.matchAll(/class="news-channel-arrow"/gu)].length, 2);
assert.match(html, /class="material-symbols-rounded news-menu-toggle-icon"[^>]*>drag_handle<\/span>/u);
assert.match(html, /id="newsShareButton"[^>]*type="button"[^>]*aria-describedby="newsShareStatus"[^>]*disabled/u);
assert.match(html, /<img src="\/assets\/news-share-link\.svg" alt="" aria-hidden="true" \/>[\s\S]*?<span>공유하기<\/span>/u);
assert.match(html, /id="newsShareStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u);
assert.match(html, /<hr class="news-comments-divider" \/>/u);
assert.match(html, /<section class="news-comments" id="newsComments"[^>]*aria-labelledby="newsCommentsTitle"/u);
assert.match(html, /id="newsCommentName"[^>]*value="익명"[^>]*maxlength="20"/u);
assert.match(html, /id="newsCommentContent"[^>]*maxlength="500"[^>]*placeholder="자유롭게 의견을 남겨 주세요\."/u);
assert.match(html, /id="newsCommentsSubmit"[^>]*type="submit"[^>]*disabled>댓글 남기기<\/button>/u);

assert.match(css, /\.news-document\s*\{[\s\S]*?gap:\s*54px;/u, "share action must sit 54px below the article stack");
assert.match(css, /\.news-document-article\s*\{[\s\S]*?gap:\s*36px;/u, "hero and article content must keep the Figma spacing");
const shareRule = css.match(/\.news-document-share\s*\{([\s\S]*?)\}/u)?.[1] || "";
for (const expectedStyle of [
  /display:\s*inline-flex;/u,
  /gap:\s*6px;/u,
  /padding:\s*9px 12px;/u,
  /border-radius:\s*10px;/u,
  /color:\s*var\(--news-gray-600\);/u,
  /font-size:\s*15px;/u,
  /font-weight:\s*600;/u,
  /line-height:\s*1\.5;/u,
]) {
  assert.match(shareRule, expectedStyle, `share control is missing ${expectedStyle}`);
}
assert.match(css, /\.news-document-share img\s*\{[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;/u);
assert.match(css, /\.news-document-header h1\s*\{[^}]*white-space:\s*pre-line/su, "detail titles must render source-authored line breaks");
assert.match(css, /\.news-comments-divider\s*\{[^}]*height:\s*1px;[^}]*background:\s*var\(--news-gray-300\)/su);
assert.match(css, /\.news-comments-compose\s*\{[^}]*gap:\s*40px/su);
assert.match(css, /\.news-comments-name\s*\{[^}]*height:\s*40px;[^}]*padding:\s*0 12px/su);
assert.match(css, /\.news-comments-content\s*\{[^}]*height:\s*104px;[^}]*padding:\s*8px 12px/su);
assert.match(css, /\.news-comments-submit\s*\{[^}]*padding:\s*9px 12px;[^}]*border-radius:\s*10px;[^}]*background:\s*#3b82f6/su);
assert.match(css, /\.news-comment\s*\{[^}]*gap:\s*10px;[^}]*padding:\s*20px;[^}]*border-radius:\s*20px;[^}]*background:\s*var\(--news-gray-50\)/su);

assert.match(script, /typeof navigator\.share === "function"/u);
assert.match(script, /const currentUrl = createStableArticleUrl\(\)/u);
assert.match(script, /await navigator\.share\(\{ title, text: title, url: currentUrl \}\)/u);
assert.match(script, /await navigator\.clipboard\.writeText\(currentUrl\)/u);
assert.match(script, /shareStatus\.textContent = "기사 주소를 복사했습니다\."/u);
assert.match(script, /const DETAILS_ROOT_URL = "\/data\/news\/details"/u);
assert.match(script, /newsDetailShardForId\(articleId\)/u);
assert.match(script, /`\$\{shardUrl\}\?refresh=\$\{Date\.now\(\)\}`/u, "a missing article may retry its deterministic shard with an internal cache buster");
assert.doesNotMatch(script, /\/data\/news-details\.json/u, "detail pages must not download a whole-corpus payload");
assert.doesNotMatch(script, /requestedVersion|news_snapshot_mismatch/u, "detail loading must not reject a stable link after a snapshot rollover");
assert.equal(/(?:\/search|data\/search|api\/search|meilisearch)/iu.test(script), false, "article sharing must remain independent of Search");
assert.match(script, /cachedPrimarySource[\s\S]*?cachedSource[\s\S]*?resolveNewsImageProxySource/u,
  "article images must prefer cached files before the official News proxy");
assert.match(script, /`\/api\/news-image\?\$\{parameters\.toString\(\)\}`/u);
assert.match(script, /window\.NewsComments\?\.initialize\(articleId\)/u, "comments must initialize only after a published article renders");

assert.deepEqual(
  await renderBodyParagraphs({
    title: "반복 제목",
    body: "\u200b반복\u00a0제목\ufeff\n(평양 8월 17일발 조선중앙통신)\n기사 본문",
  }),
  ["(평양 8월 17일발 조선중앙통신)", "기사 본문"],
  "a normalized leading paragraph identical to the title must be removed",
);
assert.deepEqual(
  await renderBodyParagraphs({ title: "반복 제목", body: "반복 제목 부제\n기사 본문" }),
  ["반복 제목 부제", "기사 본문"],
  "a partial leading title match must be preserved",
);
assert.deepEqual(
  await renderBodyParagraphs({ title: "반복 제목", body: "기사 머리말\n반복 제목\n기사 본문" }),
  ["기사 머리말", "반복 제목", "기사 본문"],
  "title-equivalent paragraphs after the first one must be preserved",
);
assert.deepEqual(
  await renderBodyParagraphs({ title: "반복 제목", body: "반복 제목" }),
  ["본문이 보관되지 않은 기사입니다."],
  "title-only bodies must render the empty-body fallback",
);
assert.deepEqual(
  await renderBodyParagraphs({
    title: "첫째 제목줄\n둘째 제목줄",
    body: "첫째 제목줄\n\n둘째 제목줄\n\n실제 기사 본문",
  }),
  ["실제 기사 본문"],
  "every canonical title line must be removed from the body prefix without hiding the article text",
);

const rolloverArticle = { title: "오래 공유되는 기사", body: "새 스냅샷에서도 읽히는 본문" };
const rollover = await runDetailPage({
  article: rolloverArticle,
  search: "?id=focused-test-article&v=retired-snapshot",
  href: "https://nkarchive.vercel.app/news/document?id=focused-test-article&v=retired-snapshot&utm_source=test#fragment",
  payloads: [{ version: "current-snapshot", shard: "6a", articles: { "focused-test-article": rolloverArticle } }],
});
assert.deepEqual(
  rollover.elements.get("#newsDocumentBody").children.map((child) => child.textContent),
  ["새 스냅샷에서도 읽히는 본문"],
  "a link carrying an obsolete snapshot hint must still load the current retained article",
);
assert.deepEqual(rollover.fetchCalls.map(({ url, init }) => ({ url, cache: init.cache })), [
  { url: "/data/news/details/6a.json", cache: "no-cache" },
]);
await rollover.elements.get("#newsShareButton").dispatch("click");
assert.deepEqual(
  rollover.copiedUrls,
  ["https://nkarchive.vercel.app/news/document?id=focused-test-article"],
  "sharing must remove snapshot, tracking, and fragment parameters from the durable article URL",
);

const retry = await runDetailPage({
  article: rolloverArticle,
  payloads: [
    { version: "stale-edge", shard: "6a", articles: {} },
    { version: "current-snapshot", shard: "6a", articles: { "focused-test-article": rolloverArticle } },
  ],
});
assert.equal(retry.fetchCalls.length, 2, "a stale details response missing the retained id must be retried once");
assert.equal(retry.fetchCalls[0].url, "/data/news/details/6a.json");
assert.match(retry.fetchCalls[1].url, /^\/data\/news\/details\/6a\.json\?refresh=\d+$/u);
assert.equal(retry.fetchCalls[1].init.cache, "reload");

console.log("News article detail and share button tests passed.");

async function renderBodyParagraphs(article) {
  const result = await runDetailPage({ article });
  return result.elements.get("#newsDocumentBody").children.map((child) => child.textContent);
}

async function runDetailPage({
  article,
  search = "?id=focused-test-article",
  href = `https://nkarchive.vercel.app/news/document${search}`,
  payloads = [{ shard: "6a", articles: { "focused-test-article": article } }],
} = {}) {
  const elements = new Map([
    ["#newsDocument", createFakeElement()],
    ["#newsDocumentTitle", createFakeElement()],
    ["#newsDocumentSource", createFakeElement()],
    ["#newsDocumentDate", createFakeElement()],
    ["#newsDocumentBody", createFakeElement()],
    ["#newsDocumentGallery", createFakeElement()],
    [".news-document-hero", createFakeElement()],
    ["#newsDocumentImage", createFakeElement()],
    ["#newsShareButton", createFakeElement()],
    ["#newsShareStatus", createFakeElement()],
  ]);
  const document = {
    body: { classList: createFakeClassList() },
    title: "",
    querySelector: (selector) => elements.get(selector) || null,
    createElement: () => createFakeElement(),
    addEventListener() {},
  };
  const window = {
    location: {
      search,
      href,
      assign() {},
    },
  };
  const fetchCalls = [];
  const copiedUrls = [];
  let payloadIndex = 0;
  const context = {
    URL,
    URLSearchParams,
    document,
    window,
    navigator: { clipboard: { async writeText(value) { copiedUrls.push(value); } } },
    fetch: async (url, init) => ({
      ok: true,
      async json() {
        fetchCalls.push({ url, init });
        const payload = payloads[Math.min(payloadIndex, payloads.length - 1)];
        payloadIndex += 1;
        return payload;
      },
    }),
    console,
  };

  vm.runInNewContext(script, context, { filename: "news/detail.js" });
  await new Promise((resolve) => setImmediate(resolve));
  return { copiedUrls, elements, fetchCalls };
}

function createFakeElement() {
  return {
    attributes: new Map(),
    children: [],
    classList: createFakeClassList(),
    disabled: false,
    hidden: false,
    listeners: new Map(),
    textContent: "",
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    },
    append(...children) {
      this.children.push(...children);
    },
    focus() {},
    remove() {},
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    async dispatch(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) await listener(event);
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
  };
}

function createFakeClassList() {
  return {
    contains: () => false,
    remove() {},
    toggle() {},
  };
}
