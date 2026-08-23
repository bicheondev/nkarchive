#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

const NEWS_SECTIONS_BY_SOURCE = Object.freeze({
  kcna: new Set([
    "leadership",
    "important",
    "international",
    "photo",
    "anecdote",
    "document",
    "foreign",
    "video",
    "memory",
    "domestic",
    "social",
  ]),
  "rodong-sinmun": new Set([
    "leadership",
    "important",
    "photo",
    "anecdote",
    "video",
    "memory",
    "domestic",
    "social",
  ]),
});

const EXACT_NEWS_GENERATED_PATHS = new Set([
  "data/news-feed.json",
  "data/news-details.json",
  "data/news/documents.jsonl",
  "data/news/image-proxy-allowlist.json",
  "data/news/search-index.json",
]);

/**
 * Return true only for the canonical generated files that the standalone News
 * refresh owns. In particular, transactional .tmp/.old trees and arbitrary
 * files below data/news are never treated as releasable output.
 */
export function isCanonicalNewsGeneratedPath(value) {
  const relativePath = normalizeRelativePath(value);
  if (EXACT_NEWS_GENERATED_PATHS.has(relativePath)) return true;
  if (/^data\/news\/details\/[a-f0-9]{2}\.json$/u.test(relativePath)) return true;
  if (/^data\/news\/assets\/(?:kcna|rodong-sinmun)\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u.test(relativePath)) {
    return true;
  }
  const categoryMatch = relativePath.match(
    /^data\/news\/categories\/(kcna|rodong-sinmun)\/([a-z-]+)\/page-([1-9][0-9]*)\.json$/u,
  );
  return Boolean(categoryMatch && NEWS_SECTIONS_BY_SOURCE[categoryMatch[1]]?.has(categoryMatch[2]));
}

export function assertCanonicalNewsGeneratedPaths(values, { label = "News generated paths" } = {}) {
  const unexpected = [...new Set(Array.from(values || [], normalizeRelativePath))]
    .filter(Boolean)
    .filter((relativePath) => !isCanonicalNewsGeneratedPath(relativePath))
    .sort(compareText);
  if (unexpected.length) {
    throw new Error(`${label} contain unexpected path(s): ${unexpected.join(", ")}`);
  }
  return true;
}

function normalizeRelativePath(value) {
  return String(value || "")
    .replaceAll(path.sep, "/")
    .replace(/^\.\//u, "");
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), "en");
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== "--stdin0") {
    throw new Error("Usage: node scripts/news-generated-paths.ts --stdin0");
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = Buffer.concat(chunks);
  const relativePaths = input.toString("utf8").split("\0").filter(Boolean);
  assertCanonicalNewsGeneratedPaths(relativePaths, { label: "Refresh changes" });
  console.log(`Canonical News generated path gate passed: ${relativePaths.length} changed path(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
