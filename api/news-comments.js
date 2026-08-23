import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash, createHmac, randomUUID as nodeRandomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  BlobPreconditionFailedError,
  get as getBlob,
  put as putBlob,
} from "@vercel/blob";

const COMMENTS_SCHEMA_VERSION = 1;
const DETAILS_ROOT = fileURLToPath(new URL("../data/news/details", import.meta.url));
const COMMENTS_ROOT = "news-comments/v1";
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_BLOB_BYTES = 4 * 1024 * 1024;
const MAX_NAME_GRAPHEMES = 20;
const MAX_NAME_BYTES = 80;
const MAX_CONTENT_GRAPHEMES = 500;
const MAX_CONTENT_BYTES = 2 * 1024;
const MAX_CONTENT_NEWLINES = 10;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_COMMENTS_PER_ARTICLE = 1_000;
const MAX_WRITE_ATTEMPTS = 8;
const IP_COOLDOWN_MS = 15_000;
const IP_TEN_MINUTE_MS = 10 * 60_000;
const IP_DAY_MS = 24 * 60 * 60_000;
const IP_TEN_MINUTE_LIMIT = 5;
const IP_DAY_LIMIT = 20;
const ARTICLE_TEN_MINUTE_LIMIT = 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ARTICLE_ID_PATTERN = /^(?:news:(?:kcna|rodong-sinmun):[a-f0-9]{24}|kcna-[a-f0-9]{16})$/u;
const FORBIDDEN_TEXT_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u;
const LONE_SURROGATE_PATTERN = /[\ud800-\udfff]/u;

export default async function handler(request, response) {
  return createNewsCommentsHandler()(request, response);
}

export function createNewsCommentsHandler({
  storage,
  validateArticleId = createPublishedArticleValidator(),
  token = process.env.BLOB_READ_WRITE_TOKEN,
  now = () => Date.now(),
  randomUUID = nodeRandomUUID,
} = {}) {
  const storageToken = String(token || "").trim();
  const commentsStorage = storage || (storageToken ? createVercelBlobStorage({ token: storageToken }) : null);

  return async function newsCommentsHandler(request, response) {
    if (request.method !== "GET" && request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" }, { Allow: "GET, POST" });
      return;
    }

    try {
      if (request.method === "GET") {
        const query = parseGetQuery(request);
        if (!query) throw new HttpError(400, "invalid_comments_query");
        if (!storageToken || !commentsStorage) throw new HttpError(503, "comments_unavailable");
        await assertPublishedArticle(validateArticleId, query.articleId);
        const aggregate = await readArticleAggregate(commentsStorage, query.articleId);
        const visibleComments = aggregate.comments.filter((comment) => comment.status === "visible");
        const startIndex = resolveCursorIndex(visibleComments, query.cursor);
        const page = visibleComments.slice(startIndex, startIndex + query.limit + 1);
        const hasMore = page.length > query.limit;
        const selected = page.slice(0, query.limit);
        sendJson(response, 200, {
          comments: selected.map(toPublicComment),
          total: visibleComments.length,
          nextCursor: hasMore && selected.length ? selected[selected.length - 1].id : null,
        });
        return;
      }

      if (!parsePostQuery(request)) throw new HttpError(400, "invalid_comments_query");
      if (!isSameOriginPost(request)) throw new HttpError(403, "comment_origin_forbidden");
      if (!isJsonContentType(getHeader(request, "content-type"))) {
        throw new HttpError(415, "unsupported_media_type");
      }
      const idempotencyKey = normalizeIdempotencyKey(getHeader(request, "idempotency-key"));
      if (!idempotencyKey) throw new HttpError(400, "invalid_idempotency_key");
      const input = normalizeCommentInput(await readRequestJson(request));
      if (!input) throw new HttpError(400, "invalid_comment");
      if (!storageToken || !commentsStorage) throw new HttpError(503, "comments_unavailable");
      await assertPublishedArticle(validateArticleId, input.articleId);
      const clientIp = getClientIp(request);
      if (!clientIp) throw new HttpError(400, "invalid_client_ip");

      const timestamp = normalizeNow(now());
      const ipHash = hashClientIp(clientIp, storageToken);
      const requestHash = hashCommentRequest(input);
      const existing = await findIdempotentComment(commentsStorage, input, idempotencyKey);
      if (existing) {
        sendJson(response, 200, {
          comment: toPublicComment(existing.comment),
          total: existing.total,
          created: false,
        });
        return;
      }

      await reserveIpRateLimit(commentsStorage, {
        ipHash,
        idempotencyKey,
        requestHash,
        timestamp,
      });

      const comment = {
        id: String(randomUUID()).toLocaleLowerCase("en-US"),
        idempotencyKey,
        name: input.name,
        content: input.content,
        createdAt: new Date(timestamp).toISOString(),
        status: "visible",
      };
      if (!UUID_PATTERN.test(comment.id)) throw new HttpError(503, "comments_unavailable");

      const result = await appendArticleComment(commentsStorage, input.articleId, comment, timestamp);
      sendJson(response, result.created ? 201 : 200, {
        comment: toPublicComment(result.comment),
        total: result.total,
        created: result.created,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        const headers = error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {};
        sendJson(response, error.statusCode, { error: error.code }, headers);
        return;
      }
      sendJson(response, 503, { error: "comments_unavailable" });
    }
  };
}

export function createPublishedArticleValidator({ detailsRoot = DETAILS_ROOT } = {}) {
  return async function validatePublishedArticleId(articleId) {
    if (!ARTICLE_ID_PATTERN.test(String(articleId || ""))) return false;
    const shard = newsDetailShardForId(articleId);
    const filePath = path.join(detailsRoot, `${shard}.json`);
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return payload?.shard === shard
      && payload?.articles
      && Object.hasOwn(payload.articles, articleId);
  };
}

export function createVercelBlobStorage({ token } = {}) {
  const storageToken = String(token || "").trim();
  return {
    async read(pathname) {
      const result = await getBlob(pathname, {
        access: "private",
        useCache: false,
        token: storageToken,
      });
      if (!result) return null;
      if (result.statusCode !== 200 || result.blob.size > MAX_BLOB_BYTES) {
        throw new Error("invalid_comments_blob");
      }
      const text = await readStreamText(result.stream, MAX_BLOB_BYTES);
      return { etag: result.blob.etag, value: JSON.parse(text) };
    },
    async write(pathname, value, { etag = null } = {}) {
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body, "utf8") > MAX_BLOB_BYTES) throw new Error("comments_blob_too_large");
      try {
        const result = await putBlob(pathname, body, {
          access: "private",
          addRandomSuffix: false,
          contentType: "application/json; charset=utf-8",
          cacheControlMaxAge: 60,
          token: storageToken,
          ...(etag ? { ifMatch: etag } : { allowOverwrite: false }),
        });
        return { etag: result.etag };
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) throw new StorageConflictError();
        throw error;
      }
    },
  };
}

export function newsDetailShardForId(value) {
  const normalizedId = String(value || "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalizedId.length; index += 1) {
    hash ^= normalizedId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) & 0xff).toString(16).padStart(2, "0");
}

class HttpError extends Error {
  constructor(statusCode, code, { retryAfter = 0 } = {}) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class StorageConflictError extends Error {
  constructor() {
    super("comments_storage_conflict");
    this.code = "comments_storage_conflict";
  }
}

async function assertPublishedArticle(validateArticleId, articleId) {
  try {
    if (!await validateArticleId(articleId)) throw new HttpError(404, "article_not_found");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "comments_unavailable");
  }
}

function parseGetQuery(request) {
  const entries = getQueryEntries(request);
  if (!entries || entries.some(([name]) => !["articleId", "limit", "cursor"].includes(name))) return null;
  const values = uniqueQueryValues(entries);
  if (!values || !values.articleId || !ARTICLE_ID_PATTERN.test(values.articleId)) return null;
  const limit = values.limit === undefined ? DEFAULT_PAGE_SIZE : parsePageSize(values.limit);
  if (!limit) return null;
  const cursor = values.cursor === undefined ? "" : normalizeIdempotencyKey(values.cursor);
  if (values.cursor !== undefined && !cursor) return null;
  return { articleId: values.articleId, limit, cursor };
}

function parsePostQuery(request) {
  const entries = getQueryEntries(request);
  return Boolean(entries && entries.length === 0);
}

function getQueryEntries(request) {
  try {
    const requestUrl = String(request?.url || "");
    if (requestUrl) return [...new URL(requestUrl, "https://nkarchive.invalid").searchParams.entries()];
  } catch {
    return null;
  }
  const query = request?.query;
  if (!query || typeof query !== "object" || Array.isArray(query)) return [];
  return Object.entries(query).flatMap(([name, value]) => Array.isArray(value)
    ? value.map((entry) => [name, String(entry)])
    : [[name, String(value)]]);
}

function uniqueQueryValues(entries) {
  const values = {};
  for (const [name, value] of entries) {
    if (Object.hasOwn(values, name)) return null;
    values[name] = value;
  }
  return values;
}

function parsePageSize(value) {
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/u.test(String(value || ""))) return 0;
  return Number(value);
}

async function readRequestJson(request) {
  const declaredLength = getHeader(request, "content-length");
  if (declaredLength && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)) {
    throw new HttpError(413, "comment_too_large");
  }

  let rawBody;
  if (request?.body !== undefined) {
    if (Buffer.isBuffer(request.body) || request.body instanceof Uint8Array) {
      if (request.body.byteLength > MAX_REQUEST_BYTES) throw new HttpError(413, "comment_too_large");
      rawBody = Buffer.from(request.body).toString("utf8");
    } else if (typeof request.body === "string") {
      if (Buffer.byteLength(request.body, "utf8") > MAX_REQUEST_BYTES) throw new HttpError(413, "comment_too_large");
      rawBody = request.body;
    } else {
      const serialized = JSON.stringify(request.body);
      if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
        throw new HttpError(413, "comment_too_large");
      }
      return request.body;
    }
  } else if (request && typeof request[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_REQUEST_BYTES) throw new HttpError(413, "comment_too_large");
      chunks.push(bytes);
    }
    rawBody = Buffer.concat(chunks).toString("utf8");
  } else {
    throw new HttpError(400, "invalid_comment_json");
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, "invalid_comment_json");
  }
}

function normalizeCommentInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["articleId", "content", "name", "website"])) return null;
  if (typeof value.articleId !== "string"
    || typeof value.name !== "string"
    || typeof value.content !== "string"
    || typeof value.website !== "string"
    || value.website !== ""
    || !ARTICLE_ID_PATTERN.test(value.articleId)) return null;

  const nameCandidate = normalizeName(value.name);
  const content = normalizeContent(value.content);
  if (!content) return null;
  const name = nameCandidate || "익명";
  if (FORBIDDEN_TEXT_PATTERN.test(name)
    || name.includes("\n")
    || LONE_SURROGATE_PATTERN.test(name)
    || FORBIDDEN_TEXT_PATTERN.test(content)
    || LONE_SURROGATE_PATTERN.test(content)
    || countGraphemes(name) > MAX_NAME_GRAPHEMES
    || Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES
    || countGraphemes(content) > MAX_CONTENT_GRAPHEMES
    || Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES
    || (content.match(/\n/gu)?.length || 0) > MAX_CONTENT_NEWLINES) return null;
  return { articleId: value.articleId, name, content };
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFC")
    .trim()
    .replace(/[ \t]+/gu, " ");
}

function normalizeContent(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .trim();
}

function countGraphemes(value) {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(value)].length;
  }
  return Array.from(value).length;
}

function isJsonContentType(value) {
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(String(value || "").trim());
}

function normalizeIdempotencyKey(value) {
  const candidate = String(value || "").trim().toLocaleLowerCase("en-US");
  return UUID_PATTERN.test(candidate) ? candidate : "";
}

function isSameOriginPost(request) {
  const origin = getHeader(request, "origin");
  if (!origin || origin === "null" || origin.includes(",")) return false;
  const fetchSite = getHeader(request, "sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;
  const host = getHeader(request, "x-forwarded-host") || getHeader(request, "host");
  if (!host || /[\s,\\/]/u.test(host)) return false;
  const forwardedProto = getHeader(request, "x-forwarded-proto");
  const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/iu.test(host);
  const protocol = forwardedProto || (localHost ? "http" : "https");
  if (!/^(?:http|https)$/u.test(protocol)) return false;
  try {
    const parsedOrigin = new URL(origin);
    const expectedOrigin = new URL(`${protocol}://${host}`).origin;
    return origin === parsedOrigin.origin && parsedOrigin.origin === expectedOrigin;
  } catch {
    return false;
  }
}

function getClientIp(request) {
  const raw = getHeader(request, "x-vercel-forwarded-for")
    || getHeader(request, "x-forwarded-for")
    || getHeader(request, "x-real-ip");
  const candidate = String(raw || "").split(",", 1)[0].trim().toLocaleLowerCase("en-US");
  return net.isIP(candidate) ? candidate : "";
}

function getHeader(request, name) {
  const expected = String(name).toLocaleLowerCase("en-US");
  const headers = request?.headers || {};
  if (typeof headers.get === "function") return String(headers.get(expected) || "").trim();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLocaleLowerCase("en-US") !== expected) continue;
    if (Array.isArray(value)) return value.length === 1 ? String(value[0] || "").trim() : "";
    return String(value || "").trim();
  }
  return "";
}

function hashClientIp(clientIp, token) {
  return createHmac("sha256", token)
    .update("nkarchive-news-comments-ip-v1\0", "utf8")
    .update(clientIp, "utf8")
    .digest("hex");
}

function hashCommentRequest(input) {
  return createHash("sha256")
    .update("nkarchive-news-comment-request-v1\0", "utf8")
    .update(input.articleId, "utf8")
    .update("\0", "utf8")
    .update(input.name, "utf8")
    .update("\0", "utf8")
    .update(input.content, "utf8")
    .digest("hex");
}

function articleBlobPath(articleId) {
  const digest = createHash("sha256").update(articleId, "utf8").digest("hex");
  return `${COMMENTS_ROOT}/articles/${digest}.json`;
}

function ipRateBlobPath(ipHash) {
  return `${COMMENTS_ROOT}/rates/${ipHash}.json`;
}

async function readArticleAggregate(storage, articleId) {
  const snapshot = await storage.read(articleBlobPath(articleId));
  if (!snapshot) return createEmptyArticleAggregate(articleId);
  if (!isArticleAggregate(snapshot.value, articleId)) throw new Error("invalid_comments_blob");
  return snapshot.value;
}

async function findIdempotentComment(storage, input, idempotencyKey) {
  const aggregate = await readArticleAggregate(storage, input.articleId);
  const existing = aggregate.comments.find((comment) => comment.idempotencyKey === idempotencyKey);
  if (!existing) return null;
  if (existing.name !== input.name || existing.content !== input.content) {
    throw new HttpError(409, "idempotency_conflict");
  }
  return {
    comment: existing,
    total: aggregate.comments.filter((comment) => comment.status === "visible").length,
  };
}

async function reserveIpRateLimit(storage, { ipHash, idempotencyKey, requestHash, timestamp }) {
  const pathname = ipRateBlobPath(ipHash);
  await mutateWithOptimisticConcurrency(storage, pathname, {
    createValue: () => createEmptyRateAggregate(),
    validateValue: isRateAggregate,
    mutate(value) {
      const retainedEvents = value.events.filter((event) => event.at > timestamp - IP_DAY_MS);
      const existing = retainedEvents.find((event) => event.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new HttpError(409, "idempotency_conflict");
        return { value: { ...value, events: retainedEvents }, write: false, result: true };
      }

      const tenMinuteEvents = retainedEvents.filter((event) => event.at > timestamp - IP_TEN_MINUTE_MS);
      const mostRecentAt = retainedEvents.reduce((latest, event) => Math.max(latest, event.at), 0);
      const retryTimes = [];
      if (mostRecentAt && mostRecentAt + IP_COOLDOWN_MS > timestamp) retryTimes.push(mostRecentAt + IP_COOLDOWN_MS);
      if (tenMinuteEvents.length >= IP_TEN_MINUTE_LIMIT) {
        retryTimes.push(Math.min(...tenMinuteEvents.map((event) => event.at)) + IP_TEN_MINUTE_MS);
      }
      if (retainedEvents.length >= IP_DAY_LIMIT) {
        retryTimes.push(Math.min(...retainedEvents.map((event) => event.at)) + IP_DAY_MS);
      }
      if (retryTimes.length) {
        const retryAfter = Math.max(1, Math.ceil((Math.max(...retryTimes) - timestamp) / 1_000));
        throw new HttpError(429, "comment_rate_limited", { retryAfter });
      }

      retainedEvents.push({ idempotencyKey, requestHash, at: timestamp });
      retainedEvents.sort((left, right) => left.at - right.at
        || left.idempotencyKey.localeCompare(right.idempotencyKey, "en"));
      return {
        value: { schemaVersion: COMMENTS_SCHEMA_VERSION, events: retainedEvents },
        write: true,
        result: true,
      };
    },
  });
}

async function appendArticleComment(storage, articleId, comment, timestamp) {
  return mutateWithOptimisticConcurrency(storage, articleBlobPath(articleId), {
    createValue: () => createEmptyArticleAggregate(articleId),
    validateValue: (value) => isArticleAggregate(value, articleId),
    mutate(value) {
      const existing = value.comments.find((entry) => entry.idempotencyKey === comment.idempotencyKey);
      if (existing) {
        if (existing.name !== comment.name || existing.content !== comment.content) {
          throw new HttpError(409, "idempotency_conflict");
        }
        return {
          value,
          write: false,
          result: {
            comment: existing,
            total: value.comments.filter((entry) => entry.status === "visible").length,
            created: false,
          },
        };
      }
      const recentCount = value.comments.filter((entry) => {
        const createdAt = Date.parse(entry.createdAt);
        return Number.isFinite(createdAt) && createdAt > timestamp - IP_TEN_MINUTE_MS;
      }).length;
      if (recentCount >= ARTICLE_TEN_MINUTE_LIMIT) {
        const recentTimes = value.comments
          .map((entry) => Date.parse(entry.createdAt))
          .filter((createdAt) => Number.isFinite(createdAt) && createdAt > timestamp - IP_TEN_MINUTE_MS);
        const retryAfter = Math.max(1, Math.ceil((Math.min(...recentTimes) + IP_TEN_MINUTE_MS - timestamp) / 1_000));
        throw new HttpError(429, "comment_rate_limited", { retryAfter });
      }
      if (value.comments.length >= MAX_COMMENTS_PER_ARTICLE) {
        throw new HttpError(409, "comment_capacity_reached");
      }
      const comments = [comment, ...value.comments].sort(compareStoredComments);
      const next = {
        schemaVersion: COMMENTS_SCHEMA_VERSION,
        articleId,
        updatedAt: comments[0].createdAt,
        comments,
      };
      return {
        value: next,
        write: true,
        result: { comment, total: comments.length, created: true },
      };
    },
  });
}

async function mutateWithOptimisticConcurrency(storage, pathname, {
  createValue,
  validateValue,
  mutate,
}) {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const snapshot = await storage.read(pathname);
    const currentValue = snapshot ? snapshot.value : createValue();
    if (!validateValue(currentValue)) throw new Error("invalid_comments_blob");
    const outcome = mutate(currentValue);
    if (!outcome.write) return outcome.result;
    try {
      await storage.write(pathname, outcome.value, { etag: snapshot?.etag || null });
      return outcome.result;
    } catch (error) {
      if (isStorageConflict(error)) continue;
      throw error;
    }
  }
  throw new Error("comments_storage_busy");
}

function isStorageConflict(error) {
  return error instanceof StorageConflictError
    || error instanceof BlobPreconditionFailedError
    || error?.code === "comments_storage_conflict";
}

function createEmptyArticleAggregate(articleId) {
  return {
    schemaVersion: COMMENTS_SCHEMA_VERSION,
    articleId,
    updatedAt: null,
    comments: [],
  };
}

function createEmptyRateAggregate() {
  return { schemaVersion: COMMENTS_SCHEMA_VERSION, events: [] };
}

function isArticleAggregate(value, articleId) {
  if (!value
    || !hasExactKeys(value, ["articleId", "comments", "schemaVersion", "updatedAt"])) return false;
  if (value.schemaVersion !== COMMENTS_SCHEMA_VERSION
    || value.articleId !== articleId
    || (value.updatedAt !== null && !isIsoTimestamp(value.updatedAt))
    || !Array.isArray(value.comments)
    || value.comments.length > MAX_COMMENTS_PER_ARTICLE
    || !value.comments.every(isStoredComment)) return false;
  const ids = new Set(value.comments.map((comment) => comment.id));
  const idempotencyKeys = new Set(value.comments.map((comment) => comment.idempotencyKey));
  if (ids.size !== value.comments.length || idempotencyKeys.size !== value.comments.length) return false;
  if (value.updatedAt !== (value.comments[0]?.createdAt || null)) return false;
  return value.comments.every((comment, index) => index === 0
    || compareStoredComments(value.comments[index - 1], comment) <= 0);
}

function compareStoredComments(left, right) {
  return String(right.createdAt).localeCompare(String(left.createdAt), "en")
    || String(right.id).localeCompare(String(left.id), "en");
}

function isStoredComment(value) {
  if (!value
    || !hasExactKeys(value, ["content", "createdAt", "id", "idempotencyKey", "name", "status"])
    || !UUID_PATTERN.test(String(value.id || ""))
    || !UUID_PATTERN.test(String(value.idempotencyKey || ""))
    || typeof value.name !== "string"
    || typeof value.content !== "string"
    || !value.name
    || normalizeName(value.name) !== value.name
    || normalizeContent(value.content) !== value.content
    || !value.content
    || FORBIDDEN_TEXT_PATTERN.test(value.name)
    || value.name.includes("\n")
    || LONE_SURROGATE_PATTERN.test(value.name)
    || FORBIDDEN_TEXT_PATTERN.test(value.content)
    || LONE_SURROGATE_PATTERN.test(value.content)
    || countGraphemes(value.name) > MAX_NAME_GRAPHEMES
    || Buffer.byteLength(value.name, "utf8") > MAX_NAME_BYTES
    || countGraphemes(value.content) > MAX_CONTENT_GRAPHEMES
    || Buffer.byteLength(value.content, "utf8") > MAX_CONTENT_BYTES
    || (value.content.match(/\n/gu)?.length || 0) > MAX_CONTENT_NEWLINES
    || !isIsoTimestamp(value.createdAt)
    || value.status !== "visible") return false;
  return true;
}

function isRateAggregate(value) {
  if (!value
    || !hasExactKeys(value, ["events", "schemaVersion"])
    || value.schemaVersion !== COMMENTS_SCHEMA_VERSION
    || !Array.isArray(value.events)
    || value.events.length > IP_DAY_LIMIT
    || !value.events.every((event) => event
      && hasExactKeys(event, ["at", "idempotencyKey", "requestHash"])
      && UUID_PATTERN.test(String(event.idempotencyKey || ""))
      && /^[a-f0-9]{64}$/u.test(String(event.requestHash || ""))
      && Number.isSafeInteger(event.at)
      && event.at >= 0)) return false;
  const keys = new Set(value.events.map((event) => event.idempotencyKey));
  if (keys.size !== value.events.length) return false;
  return value.events.every((event, index) => index === 0 || value.events[index - 1].at <= event.at);
}

function hasExactKeys(value, expectedKeys) {
  return Boolean(value
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expectedKeys));
}

function isIsoTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(String(value || ""))
    && Number.isFinite(Date.parse(value));
}

function normalizeNow(value) {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isFinite(new Date(timestamp).getTime())) {
    throw new HttpError(503, "comments_unavailable");
  }
  return timestamp;
}

function resolveCursorIndex(comments, cursor) {
  if (!cursor) return 0;
  const index = comments.findIndex((comment) => comment.id === cursor);
  if (index < 0) throw new HttpError(400, "invalid_comment_cursor");
  return index + 1;
}

function toPublicComment(comment) {
  return {
    id: comment.id,
    name: comment.name,
    content: comment.content,
    createdAt: comment.createdAt,
  };
}

async function readStreamText(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const bytes = Buffer.from(value);
    total += bytes.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("comments_blob_too_large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox");
  response.setHeader("Vary", "Origin");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(JSON.stringify(payload));
}
