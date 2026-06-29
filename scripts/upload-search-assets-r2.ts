#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseJsonl,
  stringifyJsonl,
  toStoredSearchDocument,
  validateSearchIndex,
} from "../search/localIndex.js";
import {
  DEFAULT_ASSET_DIR,
  DEFAULT_DOCUMENTS_PATH,
  DEFAULT_SOURCES_PATH,
  createAssetFileName,
  createAssetPath,
  getAssetCacheCandidates,
  sanitizePathSegment,
} from "./cache-search-assets.ts";
import { loadDotEnvFile } from "./script-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_REPORT_PATH = path.join(ROOT_DIR, "data/search/asset-r2-upload-report.json");
const DEFAULT_OBJECT_PREFIX = "search/assets";
const DEFAULT_REGION = "auto";
const DEFAULT_SERVICE = "s3";
const SHA256_EMPTY = hashHex(Buffer.alloc(0));

export async function uploadSearchAssetsToR2({
  documentsPath = DEFAULT_DOCUMENTS_PATH,
  sourcesPath = DEFAULT_SOURCES_PATH,
  outDocumentsPath = documentsPath,
  assetDir = DEFAULT_ASSET_DIR,
  reportPath = DEFAULT_REPORT_PATH,
  publicBaseUrl = process.env.R2_PUBLIC_BASE_URL || "",
  objectPrefix = process.env.R2_OBJECT_PREFIX || DEFAULT_OBJECT_PREFIX,
  endpoint = process.env.R2_ENDPOINT || "",
  accountId = process.env.R2_ACCOUNT_ID || "",
  bucket = process.env.R2_BUCKET || "",
  accessKeyId = process.env.R2_ACCESS_KEY_ID || "",
  secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "",
  region = process.env.R2_REGION || DEFAULT_REGION,
  limit = Infinity,
  refresh = false,
  dryRun = false,
  putObjectImpl = putR2Object,
  headObjectImpl = headR2Object,
} = {}) {
  const [rawDocuments, sources] = await Promise.all([
    readJsonlFile(documentsPath),
    readJsonFile(sourcesPath, []),
  ]);
  const { documents, errors } = validateSearchIndex(rawDocuments, sources);
  if (errors.length) {
    throw new Error(`Cannot upload search assets. Validation failed with ${errors.length} error(s):\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }

  const config = normalizeR2Config({
    publicBaseUrl,
    objectPrefix,
    endpoint,
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    region,
  });
  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    documents: documents.length,
    attempted: 0,
    uploaded: 0,
    kept: 0,
    skipped: 0,
    failed: 0,
    bucket: config.bucket,
    objectPrefix: config.objectPrefix,
    publicBaseUrl: config.publicBaseUrl,
    failures: [],
  };
  const updatedDocuments = documents.map((document) => ({ ...document }));
  let remaining = normalizeLimit(limit);

  for (const document of updatedDocuments) {
    if (remaining <= 0) break;
    const candidates = getAssetCacheCandidates(document);
    if (!candidates.length) {
      report.skipped += 1;
      continue;
    }

    for (const candidate of candidates) {
      if (remaining <= 0) break;
      remaining -= 1;
      report.attempted += 1;
      try {
        const localPath = createAssetPath(document, candidate, assetDir);
        const bytes = await fs.readFile(localPath);
        const key = createR2ObjectKey(document, candidate, config.objectPrefix);
        const publicUrl = createR2PublicUrl(key, config.publicBaseUrl);

        if (dryRun) {
          document[candidate.targetField] = publicUrl;
          continue;
        }

        const exists = refresh ? false : await objectExists(config, key, { headObjectImpl });
        if (exists) {
          report.kept += 1;
        } else {
          await putObjectImpl({
            config,
            key,
            bytes,
            contentType: inferContentType(createAssetFileName(document, candidate), candidate.mediaType),
          });
          report.uploaded += 1;
        }
        document[candidate.targetField] = publicUrl;
      } catch (error) {
        report.failed += 1;
        report.failures.push({
          documentId: document.id,
          sourceId: document.sourceId,
          field: candidate.sourceField,
          url: candidate.url,
          error: error.message,
        });
      }
    }
  }

  if (!dryRun) {
    await Promise.all([
      writeJsonl(outDocumentsPath, updatedDocuments.map(toStoredSearchDocument)),
      writeJson(reportPath, report),
    ]);
  }

  return { documents: updatedDocuments, report };
}

export function createR2ObjectKey(document = {}, candidate = {}, objectPrefix = DEFAULT_OBJECT_PREFIX) {
  const prefix = String(objectPrefix || "").replace(/^\/+|\/+$/g, "");
  const key = [
    sanitizePathSegment(document.sourceId || "unknown-source"),
    createAssetFileName(document, candidate),
  ].join("/");
  return prefix ? `${prefix}/${key}` : key;
}

export function createR2PublicUrl(key = "", publicBaseUrl = "") {
  const base = String(publicBaseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("R2_PUBLIC_BASE_URL or --public-base-url is required");
  return `${base}/${String(key || "").split("/").map(encodeURIComponent).join("/")}`;
}

export function normalizeR2Config(config = {}) {
  const accountId = String(config.accountId || "").trim();
  const endpoint = String(config.endpoint || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "")).replace(/\/+$/, "");
  const normalized = {
    publicBaseUrl: String(config.publicBaseUrl || "").replace(/\/+$/, ""),
    objectPrefix: String(config.objectPrefix || DEFAULT_OBJECT_PREFIX).replace(/^\/+|\/+$/g, ""),
    endpoint,
    bucket: String(config.bucket || "").trim(),
    accessKeyId: String(config.accessKeyId || "").trim(),
    secretAccessKey: String(config.secretAccessKey || ""),
    region: String(config.region || DEFAULT_REGION),
    service: DEFAULT_SERVICE,
  };

  const missing = [];
  if (!normalized.publicBaseUrl) missing.push("R2_PUBLIC_BASE_URL");
  if (!normalized.endpoint) missing.push("R2_ENDPOINT or R2_ACCOUNT_ID");
  if (!normalized.bucket) missing.push("R2_BUCKET");
  if (!normalized.accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!normalized.secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  if (missing.length) throw new Error(`Missing R2 upload config: ${missing.join(", ")}`);
  return normalized;
}

async function objectExists(config, key, { headObjectImpl = headR2Object } = {}) {
  try {
    await headObjectImpl({ config, key });
    return true;
  } catch (error) {
    if (error.status === 404 || /HTTP 404/.test(error.message)) return false;
    throw error;
  }
}

async function putR2Object({ config, key, bytes, contentType }) {
  const request = createSignedR2Request({
    config,
    key,
    method: "PUT",
    payload: bytes,
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.byteLength),
    },
  });
  const response = await fetch(request.url, {
    method: "PUT",
    headers: request.headers,
    body: bytes,
  });
  if (!response.ok) throw createHttpError(response);
}

async function headR2Object({ config, key }) {
  const request = createSignedR2Request({
    config,
    key,
    method: "HEAD",
    payload: Buffer.alloc(0),
  });
  const response = await fetch(request.url, {
    method: "HEAD",
    headers: request.headers,
  });
  if (!response.ok) throw createHttpError(response);
}

export function createSignedR2Request({
  config,
  key,
  method = "PUT",
  payload = Buffer.alloc(0),
  headers = {},
  now = new Date(),
} = {}) {
  const endpoint = new URL(config.endpoint);
  const pathName = `/${encodePathSegment(config.bucket)}/${encodeObjectKey(key)}`;
  const url = `${endpoint.origin}${pathName}`;
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hashHex(payload);
  const signedHeadersInput = {
    host: endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...normalizeHeaders(headers),
  };
  const signedHeaderNames = Object.keys(signedHeadersInput).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(signedHeadersInput[name]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    pathName,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash || SHA256_EMPTY,
  ].join("\n");
  const credentialScope = `${dateStamp}/${config.region}/${config.service || DEFAULT_SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    hashHex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(getSigningKey(config.secretAccessKey, dateStamp, config.region, config.service || DEFAULT_SERVICE), stringToSign);
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url,
    headers: {
      ...signedHeadersInput,
      authorization,
    },
    canonicalRequest,
    stringToSign,
  };
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([name, value]) => [name.toLocaleLowerCase("en-US"), String(value)]));
}

function getSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

function hashHex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodePathSegment(value = "") {
  return encodeURIComponent(String(value || ""));
}

function encodeObjectKey(key = "") {
  return String(key || "").split("/").map(encodePathSegment).join("/");
}

function inferContentType(fileName = "", mediaType = "") {
  const lower = String(fileName || "").toLocaleLowerCase("en-US");
  if (mediaType === "pdf" || lower.endsWith(".pdf")) return "application/pdf";
  if (mediaType === "video" || mediaType === "broadcast") {
    if (lower.endsWith(".webm")) return "video/webm";
    if (lower.endsWith(".mov")) return "video/quicktime";
    return "video/mp4";
  }
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function createHttpError(response) {
  const error = new Error(`HTTP ${response.status}`);
  error.status = response.status;
  return error;
}

async function readJsonlFile(filePath) {
  try {
    return parseJsonl(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonl(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, stringifyJsonl(rows), "utf8");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeLimit(value) {
  if (value === Infinity) return Infinity;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : Infinity;
}

function getArgumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  loadDotEnvFile();
  const { report } = await uploadSearchAssetsToR2({
    documentsPath: getArgumentValue("--documents") || DEFAULT_DOCUMENTS_PATH,
    sourcesPath: getArgumentValue("--sources") || DEFAULT_SOURCES_PATH,
    outDocumentsPath: getArgumentValue("--out-documents") || getArgumentValue("--documents") || DEFAULT_DOCUMENTS_PATH,
    assetDir: path.resolve(getArgumentValue("--asset-dir") || DEFAULT_ASSET_DIR),
    reportPath: getArgumentValue("--report") || DEFAULT_REPORT_PATH,
    publicBaseUrl: getArgumentValue("--public-base-url") || process.env.R2_PUBLIC_BASE_URL || "",
    objectPrefix: getArgumentValue("--prefix") || process.env.R2_OBJECT_PREFIX || DEFAULT_OBJECT_PREFIX,
    endpoint: getArgumentValue("--endpoint") || process.env.R2_ENDPOINT || "",
    accountId: getArgumentValue("--account-id") || process.env.R2_ACCOUNT_ID || "",
    bucket: getArgumentValue("--bucket") || process.env.R2_BUCKET || "",
    accessKeyId: getArgumentValue("--access-key-id") || process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: getArgumentValue("--secret-access-key") || process.env.R2_SECRET_ACCESS_KEY || "",
    region: getArgumentValue("--region") || process.env.R2_REGION || DEFAULT_REGION,
    limit: getArgumentValue("--limit") || Infinity,
    refresh: hasFlag("--refresh"),
    dryRun: hasFlag("--dry-run"),
  });

  console.log(`Search asset R2 upload ${report.dryRun ? "dry run" : "updated"}:`);
  console.log(`- documents: ${report.documents}`);
  console.log(`- attempted: ${report.attempted}`);
  console.log(`- uploaded: ${report.uploaded}`);
  console.log(`- kept: ${report.kept}`);
  console.log(`- failed: ${report.failed}`);
  if (report.failed && !report.dryRun) console.log(`- report: ${path.relative(ROOT_DIR, getArgumentValue("--report") || DEFAULT_REPORT_PATH)}`);
}

const entryPointUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";

if (import.meta.url === entryPointUrl) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
