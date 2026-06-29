#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SEARCH_SOURCES } from "../search/sourceConfig.js";
import { loadDotEnvFile } from "./script-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_SMOKE_SOURCE_IDS = ["kcna", "rodong-sinmun", "voice-of-korea"];
const ALL_OFFICIAL_SITE_SOURCE_IDS = SEARCH_SOURCES
  .filter((source) => source.crawler?.importer === "official-sites")
  .map((source) => source.id);

async function main() {
  loadDotEnvFile();
  const skipSmoke = hasFlag("--skip-smoke");
  const skipTests = hasFlag("--skip-tests");
  const sourceIds = getSourceIds();
  const proxyUrl = getArgumentValue("--proxy") || "";
  const minDocuments = getArgumentValue("--min-documents") || "1";
  const steps = [];

  if (!skipSmoke) {
    steps.push({
      label: "live crawler smoke",
      command: "npm",
      args: createSmokeArgs({ sourceIds, proxyUrl, minDocuments }),
    });
  }

  if (!skipTests) {
    steps.push({ label: "search correctness tests", command: "npm", args: ["run", "test:search"] });
  }

  steps.push(
    { label: "index schema validation", command: "npm", args: ["run", "validate:search"] },
    { label: "Meilisearch seed build", command: "npm", args: ["run", "seed:search"] },
    { label: "production search audit", command: "npm", args: ["run", "audit:search"] },
    { label: "Meilisearch sync dry run", command: "npm", args: ["run", "sync:meilisearch", "--", "--dry-run"] },
  );

  for (const step of steps) {
    console.log(`\n[preflight] ${step.label}`);
    const result = await runCommand(step.command, step.args);
    if (result.code !== 0) {
      throw new Error(`${step.label} failed with exit code ${result.code}`);
    }
  }

  console.log("\nSearch release preflight passed.");
}

function createSmokeArgs({ sourceIds, proxyUrl, minDocuments }) {
  const args = [
    "run",
    "smoke:search-crawl",
    "--",
    "--sources",
    sourceIds.join(","),
    "--min-documents",
    minDocuments,
  ];
  if (proxyUrl) args.push("--proxy", proxyUrl);

  for (const option of [
    "--limit",
    "--max-links-per-source",
    "--max-discovery-pages",
    "--max-detail-fetches-per-source",
    "--max-source-ms",
    "--timeout-ms",
    "--request-delay-ms",
    "--discovery-reserve-ms",
    "--concurrency",
  ]) {
    const value = getArgumentValue(option);
    if (value) args.push(option, value);
  }
  for (const flag of ["--no-readable-fallback", "--no-fetch-cache", "--no-proxy-direct-fallback"]) {
    if (hasFlag(flag)) args.push(flag);
  }
  return args;
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: "inherit",
    });
    child.on("close", (code) => resolve({ code: code ?? 1 }));
    child.on("error", (error) => {
      console.error(error);
      resolve({ code: 1 });
    });
  });
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function getSourceIds() {
  const rawValue = getArgumentValue("--source") || getArgumentValue("--sources");
  const sourceIds = splitList(rawValue);
  if (sourceIds.length) return sourceIds;
  if (hasFlag("--all-official-sites")) return ALL_OFFICIAL_SITE_SOURCE_IDS;
  return DEFAULT_SMOKE_SOURCE_IDS;
}

function splitList(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getArgumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return "";
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
