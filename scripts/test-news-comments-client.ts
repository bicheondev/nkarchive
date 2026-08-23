#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const commentsScript = await fs.readFile(path.join(ROOT_DIR, "news/comments.js"), "utf8");

assert.doesNotMatch(
  commentsScript,
  /(?:innerHTML|insertAdjacentHTML|outerHTML)/u,
  "comment content must never be rendered through an HTML parser",
);

const INITIAL_COMMENT = {
  id: "comment-existing",
  name: '<img src=x onerror="globalThis.compromised=true">',
  content: "<script>globalThis.compromised = true</script>",
  createdAt: "2026-08-23T00:00:00.000Z",
};
const POSTED_COMMENT = {
  id: "comment-posted",
  name: "익명",
  content: "새 댓글\n둘째 줄",
  createdAt: "2026-08-23T00:01:00.000Z",
};
const PAGINATED_COMMENT = {
  id: "comment-next",
  name: "다음 작성자",
  content: "다음 페이지 댓글",
  createdAt: "2026-08-23T00:02:00.000Z",
};

const responses = [
  response(200, {
    comments: [INITIAL_COMMENT],
    total: 3,
    nextCursor: "cursor-existing",
  }),
  response(201, {
    comment: POSTED_COMMENT,
    total: 4,
  }),
  response(500, { error: "storage_unavailable" }),
  response(200, {
    comments: [INITIAL_COMMENT, PAGINATED_COMMENT],
    total: 4,
    nextCursor: null,
  }),
];

const elements = new Map([
  ["#newsComments", createFakeElement("section", { hidden: true })],
  ["#newsCommentsCount", createFakeElement("span")],
  ["#newsCommentsForm", createFakeElement("form")],
  ["#newsCommentName", createFakeElement("input", { value: "익명" })],
  ["#newsCommentContent", createFakeElement("textarea")],
  ["#newsCommentWebsite", createFakeElement("input")],
  ["#newsCommentsSubmit", createFakeElement("button", { disabled: true })],
  ["#newsCommentsStatus", createFakeElement("p")],
  ["#newsCommentsList", createFakeElement("ol")],
  ["#newsCommentsMore", createFakeElement("button", { hidden: true })],
]);
const createdElements = [];
const document = {
  querySelector(selector) {
    return elements.get(selector) || null;
  },
  createElement(tagName) {
    const element = createFakeElement(tagName);
    createdElements.push(element);
    return element;
  },
};
const fetchCalls = [];
const consoleErrors = [];
const context = {
  URLSearchParams,
  Uint8Array,
  compromised: false,
  console: {
    ...console,
    error(...values) {
      consoleErrors.push(values);
    },
  },
  crypto: {
    randomUUID() {
      return "11111111-1111-4111-8111-111111111111";
    },
  },
  document,
  async fetch(url, init = {}) {
    fetchCalls.push({ url: String(url), init });
    const nextResponse = responses.shift();
    assert.ok(nextResponse, `unexpected request: ${init.method || "GET"} ${url}`);
    return nextResponse;
  },
  window: {},
};

vm.runInNewContext(commentsScript, context, { filename: "news/comments.js" });
assert.equal(typeof context.window.NewsComments?.initialize, "function", "client must expose an initialize hook");

context.window.NewsComments.initialize("  kcna-test-article  ");
await waitFor(() => elements.get("#newsComments").attributes.get("aria-busy") === "false");

assert.equal(elements.get("#newsComments").hidden, false, "initialization must reveal the comments section");
assert.equal(elements.get("#newsCommentsCount").textContent, "3", "initial GET must render the server count");
assert.equal(elements.get("#newsCommentsSubmit").disabled, false, "successful loading must enable submission");
assert.equal(elements.get("#newsCommentsMore").hidden, false, "a next cursor must reveal the more button");
assert.deepEqual(
  pickRequest(fetchCalls[0]),
  {
    url: "/api/news-comments?articleId=kcna-test-article&limit=20",
    method: "GET",
    cache: "no-store",
    accept: "application/json",
  },
  "initialization must request the normalized article id without using a cached response",
);

const initialItem = elements.get("#newsCommentsList").children[0];
assert.equal(initialItem.className, "news-comment");
assert.equal(initialItem.children[0].textContent, INITIAL_COMMENT.name);
assert.equal(initialItem.children[1].textContent, INITIAL_COMMENT.content);
assert.equal(createdElements.some((element) => element.innerHTMLWrites > 0), false, "user strings must stay inert text");
assert.equal(context.compromised, false, "rendering hostile strings must not execute them");

const form = elements.get("#newsCommentsForm");
const nameInput = elements.get("#newsCommentName");
const contentInput = elements.get("#newsCommentContent");
const websiteInput = elements.get("#newsCommentWebsite");
const submitButton = elements.get("#newsCommentsSubmit");
let prevented = false;
nameInput.value = " \u200b ";
contentInput.value = "  새 댓글  \r\n둘째 줄  ";
websiteInput.value = "";
await form.dispatch("submit", { preventDefault() { prevented = true; } });

assert.equal(prevented, true, "native form submission must be prevented");
assert.equal(fetchCalls.length, 2);
assert.deepEqual(
  pickRequest(fetchCalls[1]),
  {
    url: "/api/news-comments",
    method: "POST",
    cache: "no-store",
    accept: "application/json",
    contentType: "application/json",
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    body: {
      articleId: "kcna-test-article",
      name: "익명",
      content: "새 댓글\n둘째 줄",
      website: "",
    },
  },
  "submission must normalize text, default an empty name, and carry an idempotency key",
);
assert.equal(elements.get("#newsCommentsCount").textContent, "4");
assert.deepEqual(
  elements.get("#newsCommentsList").children.map((item) => item.children[1].textContent),
  [POSTED_COMMENT.content, INITIAL_COMMENT.content],
  "a successful comment must be prepended without discarding loaded comments",
);
assert.equal(contentInput.value, "", "the draft must clear only after a successful response");
assert.equal(submitButton.disabled, false);
assert.equal(submitButton.attributes.has("aria-busy"), false);
assert.equal(elements.get("#newsCommentsStatus").textContent, "댓글을 남겼습니다.");

contentInput.value = " \u200b\r\n ";
const requestsBeforeEmptySubmission = fetchCalls.length;
await form.dispatch("submit", { preventDefault() {} });
assert.equal(fetchCalls.length, requestsBeforeEmptySubmission, "an empty normalized body must not issue a request");
assert.equal(contentInput.customValidity, "댓글 내용을 입력해 주세요.");
assert.equal(contentInput.reportValidityCalls, 1);
assert.equal(contentInput.focusCalls, 1);
await contentInput.dispatch("input");
assert.equal(contentInput.customValidity, "", "editing must clear the custom validation message");

nameInput.value = "테스터";
contentInput.value = "  실패해도 남아야 하는 댓글  ";
await form.dispatch("submit", { preventDefault() {} });
assert.equal(fetchCalls.length, 3);
assert.equal(contentInput.value, "  실패해도 남아야 하는 댓글  ", "a failed submission must retain the exact draft");
assert.equal(submitButton.disabled, false, "a failed submission must restore the submit control");
assert.equal(submitButton.attributes.has("aria-busy"), false);
assert.equal(
  elements.get("#newsCommentsStatus").textContent,
  "댓글을 등록하지 못했습니다. 작성한 내용은 그대로 보관했습니다.",
);
assert.equal(consoleErrors.length, 1, "a failed request should be reported once for diagnostics");

await elements.get("#newsCommentsMore").dispatch("click");
await waitFor(() => fetchCalls.length === 4 && elements.get("#newsComments").attributes.get("aria-busy") === "false");
assert.deepEqual(
  pickRequest(fetchCalls[3]),
  {
    url: "/api/news-comments?articleId=kcna-test-article&limit=20&cursor=cursor-existing",
    method: "GET",
    cache: "no-store",
    accept: "application/json",
  },
  "pagination must send the cursor returned by the previous page",
);
assert.deepEqual(
  elements.get("#newsCommentsList").children.map((item) => item.children[1].textContent),
  [POSTED_COMMENT.content, INITIAL_COMMENT.content, PAGINATED_COMMENT.content],
  "pagination must append unseen comments and discard duplicate ids",
);
assert.equal(elements.get("#newsCommentsCount").textContent, "4");
assert.equal(elements.get("#newsCommentsMore").hidden, true, "the more button must hide after the final page");
assert.equal(responses.length, 0, "all expected requests must have been exercised");

console.log("News comments client tests passed.");

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function pickRequest(call) {
  const method = call.init.method || "GET";
  const headers = call.init.headers || {};
  const request = {
    url: call.url,
    method,
    cache: call.init.cache,
    accept: headers.Accept,
  };
  if (method === "POST") {
    request.contentType = headers["Content-Type"];
    request.idempotencyKey = headers["Idempotency-Key"];
    request.body = JSON.parse(call.init.body);
  }
  return request;
}

function createFakeElement(tagName, initial = {}) {
  const element = {
    attributes: new Map(),
    children: [],
    className: "",
    customValidity: "",
    disabled: false,
    focusCalls: 0,
    hidden: false,
    innerHTMLWrites: 0,
    listeners: new Map(),
    reportValidityCalls: 0,
    tagName: String(tagName).toUpperCase(),
    textContent: "",
    value: "",
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    },
    append(...children) {
      this.children.push(...children);
    },
    async dispatch(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) await listener(event);
    },
    focus() {
      this.focusCalls += 1;
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    replaceChildren(...children) {
      this.children = children;
    },
    reportValidity() {
      this.reportValidityCalls += 1;
      return false;
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    setCustomValidity(message) {
      this.customValidity = String(message);
    },
    ...initial,
  };
  Object.defineProperty(element, "innerHTML", {
    configurable: false,
    enumerable: false,
    get() {
      return "";
    },
    set() {
      this.innerHTMLWrites += 1;
      throw new Error("unsafe_inner_html_write");
    },
  });
  return element;
}

async function waitFor(predicate, message = "timed out waiting for comments client") {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}
