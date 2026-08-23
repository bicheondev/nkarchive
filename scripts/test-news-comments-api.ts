#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  StorageConflictError,
  createNewsCommentsHandler,
  createPublishedArticleValidator,
} from "../api/news-comments.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const API_SOURCE = await fs.readFile(path.join(ROOT_DIR, "api/news-comments.js"), "utf8");
const ARTICLE_ID = "news:kcna:02e33bd2374532c90987cc46";
const OTHER_ARTICLE_ID = "news:kcna:03c96066fe06922d9af4d297";
const TOKEN = "vercel_blob_rw_test_secret_that_is_never_deployed";
const BASE_TIME = Date.parse("2026-08-23T06:00:00.000Z");

assert.match(API_SOURCE, /getBlob\(pathname, \{[\s\S]*?access: "private",[\s\S]*?useCache: false,/u,
  "private aggregate reads must bypass the Blob CDN cache");
assert.match(API_SOURCE, /putBlob\(pathname, body, \{[\s\S]*?access: "private",[\s\S]*?ifMatch: etag/u,
  "aggregate overwrites must use the prior ETag");
assert.match(API_SOURCE, /etag \? \{ ifMatch: etag \} : \{ allowOverwrite: false \}/u,
  "first writes must be create-only so a raced creator is retried");
assert.doesNotMatch(API_SOURCE, /Access-Control-Allow-Origin/iu, "the comments API must remain same-origin");

const actualValidator = createPublishedArticleValidator();
assert.equal(await actualValidator(ARTICLE_ID), true, "the validator must read the deterministic real detail shard");
assert.equal(await actualValidator("news:kcna:ffffffffffffffffffffffff"), false);
assert.equal(await actualValidator("../../private"), false);

async function testMethodsAndConfiguration() {
  const storage = new MemoryStorage();
  const handler = createHandler({ storage });
  for (const method of ["HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"]) {
    const response = await invoke(handler, createRequest({ method }));
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.Allow, "GET, POST");
    assert.equal(response.headers["Cache-Control"], "no-store");
    assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(response.headers["Cross-Origin-Resource-Policy"], "same-origin");
  }
  assert.equal(storage.operations.length, 0, "unsupported methods must never reach storage");

  const unavailable = createNewsCommentsHandler({
    storage,
    token: "",
    validateArticleId: async () => true,
  });
  const unavailableGet = await invoke(unavailable, createRequest({ method: "GET", query: { articleId: ARTICLE_ID } }));
  assertResponseError(unavailableGet, 503, "comments_unavailable");
  const unavailablePost = await invoke(unavailable, createRequest());
  assertResponseError(unavailablePost, 503, "comments_unavailable");
  assert.equal(storage.operations.length, 0, "a missing Blob token must fail closed before storage access");
}

async function testSuccessfulPostAndPlainTextRoundTrip() {
  const storage = new MemoryStorage();
  let now = BASE_TIME;
  const handler = createHandler({ storage, now: () => now });
  const idempotencyKey = uuid(1);
  const rawContent = "<img src=x onerror=alert(1)>\r\n</script>은 문자로 표시";
  const created = await invoke(handler, createRequest({
    idempotencyKey,
    body: commentBody({ name: "  연구자\t이름  ", content: rawContent }),
  }));
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json, {
    comment: {
      id: uuid(501),
      name: "연구자 이름",
      content: "<img src=x onerror=alert(1)>\n</script>은 문자로 표시",
      createdAt: new Date(BASE_TIME).toISOString(),
    },
    total: 1,
    created: true,
  });
  assertSecurityHeaders(created);
  assert.equal(created.headers["Access-Control-Allow-Origin"], undefined);

  const storedText = JSON.stringify([...storage.entries.values()].map((entry) => entry.value));
  assert.equal(storedText.includes("203.0.113.10"), false, "raw client IPs must never enter Blob storage");
  assert.equal(storedText.includes(idempotencyKey), true, "private aggregates retain retry identity");
  for (const pathname of storage.entries.keys()) {
    assert.equal(pathname.includes("203.0.113.10"), false, "raw client IPs must not enter Blob pathnames");
  }

  const listed = await invoke(handler, createRequest({ method: "GET", query: { articleId: ARTICLE_ID } }));
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json, {
    comments: [created.json.comment],
    total: 1,
    nextCursor: null,
  });
  assert.equal(JSON.stringify(listed.json).includes("idempotencyKey"), false);
  assert.equal(JSON.stringify(listed.json).includes("ipHash"), false);

  now += 15_000;
  const anonymous = await invoke(handler, createRequest({
    idempotencyKey: uuid(2),
    body: commentBody({ name: " \t ", content: "익명 의견" }),
  }));
  assert.equal(anonymous.statusCode, 201);
  assert.equal(anonymous.json.comment.name, "익명");
}

async function testPostOriginAndContentTypeProtection() {
  const cases = [
    [{ origin: "" }, 403, "comment_origin_forbidden"],
    [{ origin: "null" }, 403, "comment_origin_forbidden"],
    [{ origin: "https://evil.example" }, 403, "comment_origin_forbidden"],
    [{ origin: "https://preview.nkarchive.vercel.app" }, 403, "comment_origin_forbidden"],
    [{ origin: "https://nkarchive.vercel.app/path" }, 403, "comment_origin_forbidden"],
    [{ secFetchSite: "cross-site" }, 403, "comment_origin_forbidden"],
    [{ forwardedProto: "http" }, 403, "comment_origin_forbidden"],
    [{ host: "nkarchive.vercel.app,evil.example" }, 403, "comment_origin_forbidden"],
    [{ contentType: "text/plain" }, 415, "unsupported_media_type"],
    [{ contentType: "application/x-www-form-urlencoded" }, 415, "unsupported_media_type"],
    [{ contentType: "application/json; charset=iso-8859-1" }, 415, "unsupported_media_type"],
    [{ idempotencyKey: "not-a-uuid" }, 400, "invalid_idempotency_key"],
  ];
  for (const [overrides, status, code] of cases) {
    const storage = new MemoryStorage();
    const response = await invoke(createHandler({ storage }), createRequest(overrides));
    assertResponseError(response, status, code);
    assert.equal(storage.operations.length, 0, `rejected POST must not use storage: ${JSON.stringify(overrides)}`);
  }

  const charsetResponse = await invoke(createHandler({ storage: new MemoryStorage() }), createRequest({
    contentType: "application/json; charset=UTF-8",
  }));
  assert.equal(charsetResponse.statusCode, 201);

  const localResponse = await invoke(createHandler({ storage: new MemoryStorage() }), createRequest({
    host: "127.0.0.1:4173",
    origin: "http://127.0.0.1:4173",
    forwardedProto: "",
  }));
  assert.equal(localResponse.statusCode, 201, "same-origin local development must remain testable");
}

async function testInputValidationBoundaries() {
  const invalidBodies = [
    null,
    [],
    {},
    { articleId: ARTICLE_ID, name: "익명", content: "내용" },
    { ...commentBody(), extra: true },
    commentBody({ website: "bot.example" }),
    commentBody({ name: "가".repeat(21) }),
    commentBody({ name: "두\n줄" }),
    commentBody({ content: "" }),
    commentBody({ content: " \r\n " }),
    commentBody({ content: "가".repeat(501) }),
    commentBody({ content: `a${"\u0301".repeat(4)}`.repeat(300) }),
    commentBody({ content: "a\n".repeat(11) + "끝" }),
    commentBody({ content: "제어\u0000문자" }),
    commentBody({ content: "방향\u202e전환" }),
    commentBody({ content: "숨은\u2028줄바꿈" }),
    commentBody({ content: `잘못된${String.fromCharCode(0xd800)}` }),
    commentBody({ articleId: "news:kcna:../../private" }),
  ];
  for (let index = 0; index < invalidBodies.length; index += 1) {
    const storage = new MemoryStorage();
    const response = await invoke(createHandler({ storage }), createRequest({
      idempotencyKey: uuid(100 + index),
      body: invalidBodies[index],
    }));
    assertResponseError(response, 400, "invalid_comment");
    assert.equal(storage.operations.length, 0);
  }

  const maxName = await invoke(createHandler({ storage: new MemoryStorage() }), createRequest({
    body: commentBody({ name: "가".repeat(20), content: "가".repeat(500) }),
  }));
  assert.equal(maxName.statusCode, 201, "valid grapheme boundaries must be accepted");
  const emojiName = await invoke(createHandler({ storage: new MemoryStorage() }), createRequest({
    body: commentBody({ name: "😀".repeat(20), content: "이모지 이름" }),
  }));
  assert.equal(emojiName.statusCode, 201, "the exact 80-byte name boundary must be accepted");
  const emojiContent = await invoke(createHandler({ storage: new MemoryStorage() }), createRequest({
    body: commentBody({ content: "😀".repeat(500) }),
  }));
  assert.equal(emojiContent.statusCode, 201, "the exact 500-grapheme/2000-byte body boundary must be accepted");

  const malformed = await invoke(createHandler({ storage: new MemoryStorage() }), createRequest({ body: "{" }));
  assertResponseError(malformed, 400, "invalid_comment_json");
  const oversizedHeader = await invoke(createHandler({ storage: new MemoryStorage() }), createRequest({
    contentLength: "4097",
  }));
  assertResponseError(oversizedHeader, 413, "comment_too_large");
  const invalidLength = await invoke(createHandler({ storage: new MemoryStorage() }), createRequest({
    contentLength: "not-a-number",
  }));
  assertResponseError(invalidLength, 413, "comment_too_large");

  const streamedRequest = createRequest();
  delete streamedRequest.body;
  streamedRequest[Symbol.asyncIterator] = async function* streamBody() {
    yield Buffer.alloc(4097, 0x61);
  };
  const streamed = await invoke(createHandler({ storage: new MemoryStorage() }), streamedRequest);
  assertResponseError(streamed, 413, "comment_too_large");
}

async function testPublishedArticleAndClientIpValidation() {
  const rejectedStorage = new MemoryStorage();
  const unpublishedHandler = createHandler({ storage: rejectedStorage, validateArticleId: async () => false });
  assertResponseError(await invoke(unpublishedHandler, createRequest()), 404, "article_not_found");
  assert.equal(rejectedStorage.operations.length, 0);

  const failingStorage = new MemoryStorage();
  const failingValidator = createHandler({
    storage: failingStorage,
    validateArticleId: async () => { throw new Error("detail shard unavailable"); },
  });
  assertResponseError(await invoke(failingValidator, createRequest()), 503, "comments_unavailable");
  assert.equal(failingStorage.operations.length, 0);

  for (const clientIp of ["", "unknown", "999.1.1.1", "203.0.113.10,invalid"] ) {
    const storage = new MemoryStorage();
    const request = createRequest({ clientIp });
    if (clientIp.includes(",")) {
      request.headers["x-vercel-forwarded-for"] = "";
      request.headers["x-forwarded-for"] = clientIp;
    }
    const response = await invoke(createHandler({ storage }), request);
    if (clientIp.includes(",")) {
      assert.equal(response.statusCode, 201, "the first trusted forwarding address is used");
    } else {
      assertResponseError(response, 400, "invalid_client_ip");
      assert.equal(storage.operations.length, 0);
    }
  }
}

async function testGetQueryAndStableCursorPagination() {
  const badQueries = [
    {},
    { articleId: ARTICLE_ID, extra: "1" },
    { articleId: [ARTICLE_ID, ARTICLE_ID] },
    { articleId: ARTICLE_ID, limit: "0" },
    { articleId: ARTICLE_ID, limit: "01" },
    { articleId: ARTICLE_ID, limit: "51" },
    { articleId: ARTICLE_ID, cursor: "bad" },
  ];
  for (const query of badQueries) {
    const storage = new MemoryStorage();
    const response = await invoke(createHandler({ storage }), createRequest({ method: "GET", query }));
    assertResponseError(response, 400, "invalid_comments_query");
    assert.equal(storage.operations.length, 0);
  }

  const storage = new MemoryStorage();
  let now = BASE_TIME;
  let generatedId = 600;
  const handler = createHandler({ storage, now: () => now, randomUUID: () => uuid(generatedId++) });
  const created = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await invoke(handler, createRequest({
      idempotencyKey: uuid(200 + index),
      clientIp: `203.0.113.${20 + index}`,
      body: commentBody({ content: `댓글 ${index + 1}` }),
    }));
    assert.equal(response.statusCode, 201);
    created.push(response.json.comment);
    now += 1_000;
  }

  const firstPage = await invoke(handler, createRequest({
    method: "GET",
    query: { articleId: ARTICLE_ID, limit: "2" },
  }));
  assert.deepEqual(firstPage.json.comments.map((comment) => comment.content), ["댓글 3", "댓글 2"]);
  assert.equal(firstPage.json.nextCursor, created[1].id);

  const inserted = await invoke(handler, createRequest({
    idempotencyKey: uuid(210),
    clientIp: "203.0.113.30",
    body: commentBody({ content: "페이지 사이 새 댓글" }),
  }));
  assert.equal(inserted.statusCode, 201);
  const secondPage = await invoke(handler, createRequest({
    method: "GET",
    query: { articleId: ARTICLE_ID, limit: "2", cursor: firstPage.json.nextCursor },
  }));
  assert.deepEqual(secondPage.json.comments.map((comment) => comment.content), ["댓글 1"]);
  assert.equal(secondPage.json.nextCursor, null);
  assert.equal(secondPage.json.total, 4);

  const foreignCursor = await invoke(handler, createRequest({
    method: "GET",
    query: { articleId: ARTICLE_ID, cursor: uuid(999) },
  }));
  assertResponseError(foreignCursor, 400, "invalid_comment_cursor");
}

async function testOptimisticConcurrencyAndIdempotency() {
  const storage = new MemoryStorage({ yieldBeforeWrite: true });
  let nextId = 700;
  const handler = createHandler({ storage, randomUUID: () => uuid(nextId++) });
  const [first, second] = await Promise.all([
    invoke(handler, createRequest({
      idempotencyKey: uuid(301),
      clientIp: "203.0.113.101",
      body: commentBody({ content: "동시 댓글 1" }),
    })),
    invoke(handler, createRequest({
      idempotencyKey: uuid(302),
      clientIp: "203.0.113.102",
      body: commentBody({ content: "동시 댓글 2" }),
    })),
  ]);
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.ok(storage.conflicts > 0, "concurrent aggregate writes must exercise ETag retries");
  const list = await invoke(handler, createRequest({ method: "GET", query: { articleId: ARTICLE_ID } }));
  assert.deepEqual(new Set(list.json.comments.map((comment) => comment.content)), new Set(["동시 댓글 1", "동시 댓글 2"]));

  const beforeWrites = storage.operations.filter((operation) => operation.type === "write").length;
  const retry = await invoke(handler, createRequest({
    idempotencyKey: uuid(301),
    clientIp: "203.0.113.101",
    body: commentBody({ content: "동시 댓글 1" }),
  }));
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json.created, false);
  assert.equal(storage.operations.filter((operation) => operation.type === "write").length, beforeWrites,
    "a completed idempotent retry must not consume rate or write another aggregate");

  const changedRetry = await invoke(handler, createRequest({
    idempotencyKey: uuid(301),
    clientIp: "203.0.113.101",
    body: commentBody({ content: "다른 내용" }),
  }));
  assertResponseError(changedRetry, 409, "idempotency_conflict");

  const conflictStorage = new MemoryStorage({ conflictsRemaining: 2 });
  const conflictResponse = await invoke(createHandler({ storage: conflictStorage }), createRequest());
  assert.equal(conflictResponse.statusCode, 201, "bounded optimistic conflicts must be retried");

  const permanentlyBusy = new MemoryStorage({ alwaysConflict: true });
  const busyResponse = await invoke(createHandler({ storage: permanentlyBusy }), createRequest());
  assertResponseError(busyResponse, 503, "comments_unavailable");
  assert.equal(permanentlyBusy.entries.size, 0);
}

async function testIpAndArticleRateLimits() {
  const storage = new MemoryStorage();
  let now = BASE_TIME;
  let nextId = 800;
  const handler = createHandler({ storage, now: () => now, randomUUID: () => uuid(nextId++) });
  assert.equal((await invoke(handler, createRequest({ idempotencyKey: uuid(401) }))).statusCode, 201);
  now += 1_000;
  const cooldown = await invoke(handler, createRequest({
    idempotencyKey: uuid(402),
    body: commentBody({ content: "너무 빠른 댓글" }),
  }));
  assertResponseError(cooldown, 429, "comment_rate_limited");
  assert.equal(cooldown.headers["Retry-After"], "14");
  assertSecurityHeaders(cooldown);

  now = BASE_TIME + 15_000;
  for (let index = 0; index < 4; index += 1) {
    const response = await invoke(handler, createRequest({
      idempotencyKey: uuid(403 + index),
      body: commentBody({ content: `10분 제한 ${index}` }),
    }));
    assert.equal(response.statusCode, 201);
    now += 15_000;
  }
  const tenMinuteLimited = await invoke(handler, createRequest({
    idempotencyKey: uuid(410),
    body: commentBody({ content: "여섯번째" }),
  }));
  assertResponseError(tenMinuteLimited, 429, "comment_rate_limited");
  assert.ok(Number(tenMinuteLimited.headers["Retry-After"]) >= 1);

  const dayStorage = new MemoryStorage();
  let dayNow = BASE_TIME;
  let dayId = 900;
  const dayHandler = createHandler({ dayStorage, storage: dayStorage, now: () => dayNow, randomUUID: () => uuid(dayId++) });
  for (let index = 0; index < 20; index += 1) {
    const response = await invoke(dayHandler, createRequest({
      idempotencyKey: uuid(500 + index),
      body: commentBody({ content: `일일 제한 ${index}` }),
    }));
    assert.equal(response.statusCode, 201);
    dayNow += 10 * 60_000;
  }
  const dayLimited = await invoke(dayHandler, createRequest({
    idempotencyKey: uuid(530),
    body: commentBody({ content: "스물한번째" }),
  }));
  assertResponseError(dayLimited, 429, "comment_rate_limited");

  const articleStorage = new MemoryStorage();
  let articleId = 1_000;
  const articleHandler = createHandler({ articleStorage, storage: articleStorage, randomUUID: () => uuid(articleId++) });
  for (let index = 0; index < 60; index += 1) {
    const response = await invoke(articleHandler, createRequest({
      idempotencyKey: uuid(600 + index),
      clientIp: ipForIndex(index),
      body: commentBody({ content: `기사 전체 제한 ${index}` }),
    }));
    assert.equal(response.statusCode, 201);
  }
  const articleLimited = await invoke(articleHandler, createRequest({
    idempotencyKey: uuid(699),
    clientIp: "198.51.100.250",
    body: commentBody({ content: "예순한번째" }),
  }));
  assertResponseError(articleLimited, 429, "comment_rate_limited");
}

async function testStorageFailureAndCorruption() {
  const failingStorage = {
    async read() { throw new Error("blob offline"); },
    async write() { throw new Error("blob offline"); },
  };
  assertResponseError(await invoke(createHandler({ storage: failingStorage }), createRequest()), 503, "comments_unavailable");
  assertResponseError(await invoke(createHandler({ storage: failingStorage }), createRequest({
    method: "GET",
    query: { articleId: ARTICLE_ID },
  })), 503, "comments_unavailable");

  const corruptStorage = new MemoryStorage();
  await invoke(createHandler({ storage: corruptStorage }), createRequest());
  const articleEntry = [...corruptStorage.entries.entries()].find(([pathname]) => pathname.includes("/articles/"));
  assert.ok(articleEntry);
  articleEntry[1].value.comments[0].id = "corrupt";
  const corruptRead = await invoke(createHandler({ storage: corruptStorage }), createRequest({
    method: "GET",
    query: { articleId: ARTICLE_ID },
  }));
  assertResponseError(corruptRead, 503, "comments_unavailable");
}

function createHandler({
  storage = new MemoryStorage(),
  dayStorage,
  token = TOKEN,
  validateArticleId = async (articleId) => articleId === ARTICLE_ID || articleId === OTHER_ARTICLE_ID,
  now = () => BASE_TIME,
  randomUUID = () => uuid(501),
} = {}) {
  return createNewsCommentsHandler({
    storage: dayStorage || storage,
    token,
    validateArticleId,
    now,
    randomUUID,
  });
}

function createRequest({
  method = "POST",
  query,
  body = commentBody(),
  idempotencyKey = uuid(1),
  contentType = "application/json",
  contentLength,
  origin = "https://nkarchive.vercel.app",
  host = "nkarchive.vercel.app",
  forwardedProto = "https",
  secFetchSite = "same-origin",
  clientIp = "203.0.113.10",
} = {}) {
  const url = new URL("https://nkarchive.invalid/api/news-comments");
  if (query) {
    for (const [name, rawValue] of Object.entries(query)) {
      for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) url.searchParams.append(name, String(value));
    }
  }
  const headers = {
    host,
    origin,
    "content-type": contentType,
    "idempotency-key": idempotencyKey,
    "sec-fetch-site": secFetchSite,
    "x-forwarded-proto": forwardedProto,
    "x-vercel-forwarded-for": clientIp,
  };
  if (contentLength !== undefined) headers["content-length"] = contentLength;
  return { method, url: `${url.pathname}${url.search}`, headers, body };
}

function commentBody({
  articleId = ARTICLE_ID,
  name = "익명",
  content = "자유로운 의견",
  website = "",
} = {}) {
  return { articleId, name, content, website };
}

async function invoke(handler, request) {
  const response = createResponse();
  await handler(request, response);
  response.json = response.body ? JSON.parse(String(response.body)) : null;
  return response;
}

function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(value) {
      this.body = value;
    },
  };
}

function assertResponseError(response, statusCode, code) {
  assert.equal(response.statusCode, statusCode);
  assert.deepEqual(response.json, { error: code });
  assertSecurityHeaders(response);
}

function assertSecurityHeaders(response) {
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(response.headers["Referrer-Policy"], "no-referrer");
  assert.equal(response.headers["Cross-Origin-Resource-Policy"], "same-origin");
  assert.match(response.headers["Content-Security-Policy"], /default-src 'none'/u);
  assert.equal(response.headers["Vary"], "Origin");
}

function uuid(index) {
  return `00000000-0000-4000-8000-${Number(index).toString(16).padStart(12, "0")}`;
}

function ipForIndex(index) {
  const third = Math.floor(index / 250);
  const fourth = (index % 250) + 1;
  return `198.51.${third}.${fourth}`;
}

class MemoryStorage {
  constructor({ yieldBeforeWrite = false, conflictsRemaining = 0, alwaysConflict = false } = {}) {
    this.entries = new Map();
    this.operations = [];
    this.version = 0;
    this.yieldBeforeWrite = yieldBeforeWrite;
    this.conflictsRemaining = conflictsRemaining;
    this.alwaysConflict = alwaysConflict;
    this.conflicts = 0;
  }

  async read(pathname) {
    this.operations.push({ type: "read", pathname });
    const entry = this.entries.get(pathname);
    return entry ? { etag: entry.etag, value: structuredClone(entry.value) } : null;
  }

  async write(pathname, value, { etag = null } = {}) {
    this.operations.push({ type: "write", pathname, etag, value: structuredClone(value) });
    if (this.yieldBeforeWrite) await new Promise((resolve) => setImmediate(resolve));
    const existing = this.entries.get(pathname);
    if (this.alwaysConflict || this.conflictsRemaining > 0) {
      this.conflictsRemaining = Math.max(0, this.conflictsRemaining - 1);
      this.conflicts += 1;
      throw new StorageConflictError();
    }
    if ((existing && etag !== existing.etag) || (!existing && etag)) {
      this.conflicts += 1;
      throw new StorageConflictError();
    }
    this.version += 1;
    const nextEtag = `etag-${this.version}`;
    this.entries.set(pathname, { etag: nextEtag, value: structuredClone(value) });
    return { etag: nextEtag };
  }
}

await testMethodsAndConfiguration();
await testSuccessfulPostAndPlainTextRoundTrip();
await testPostOriginAndContentTypeProtection();
await testInputValidationBoundaries();
await testPublishedArticleAndClientIpValidation();
await testGetQueryAndStableCursorPagination();
await testOptimisticConcurrencyAndIdempotency();
await testIpAndArticleRateLimits();
await testStorageFailureAndCorruption();

console.log("Standalone news comments API tests passed.");
