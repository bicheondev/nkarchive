#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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
  const sourceIds = getSourceIds();
  const proxyUrl = getArgumentValue("--proxy") || "";
  const minDocuments = getPositiveIntegerArgument("--min-documents", 1);
  const keepOutput = hasFlag("--keep-output");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nkarchive-search-crawl-smoke-"));
  const outputPath = path.resolve(getArgumentValue("--out") || path.join(tempDir, `${createFileLabel(sourceIds)}.documents.jsonl`));
  const reportPath = path.resolve(getArgumentValue("--report") || path.join(tempDir, `${createFileLabel(sourceIds)}.report.json`));

  try {
    const args = createImporterArgs({
      sourceIds,
      proxyUrl,
      outputPath,
      reportPath,
    });
    const result = await runCommand("npm", args);
    if (result.code !== 0) {
      throw new Error(`import:official-sites exited with ${result.code}`);
    }

    const [documentsText, report] = await Promise.all([
      fs.readFile(outputPath, "utf8"),
      readJson(reportPath, {}),
    ]);
    const documents = parseJsonl(documentsText);
    const reports = getSourceReports(report);
    const reportsBySource = new Map(reports.map((item) => [item?.sourceId, item]));
    const smokeWarnings = [];

    for (const sourceId of sourceIds) {
      const sourceDocuments = documents.filter((document) => document?.sourceId === sourceId);
      const sourceReport = reportsBySource.get(sourceId);
      const errors = Array.isArray(sourceReport?.errors) ? sourceReport.errors : [];
      const blockingErrors = errors.filter((error) => !isNonBlockingSmokeError(error));
      const nonBlockingErrors = errors.filter(isNonBlockingSmokeError);
      if (!sourceReport) {
        throw new Error(`Source ${sourceId} did not produce a crawl report.`);
      }
      if (sourceDocuments.length < minDocuments) {
        throw new Error(`Source ${sourceId} expected at least ${minDocuments} document(s), but imported ${sourceDocuments.length}.`);
      }
      if (blockingErrors.length) {
        throw new Error(`Source ${sourceId} reported ${blockingErrors.length} blocking error(s): ${blockingErrors.join("; ")}`);
      }
      if (nonBlockingErrors.length) {
        smokeWarnings.push({ sourceId, errors: nonBlockingErrors });
      }
    }

    console.log("Search crawl smoke passed.");
    console.log(`- sources: ${sourceIds.join(", ")}`);
    console.log(`- documents: ${documents.length}`);
    for (const sourceId of sourceIds) {
      const sourceReport = reportsBySource.get(sourceId) || {};
      const sourceDocuments = documents.filter((document) => document?.sourceId === sourceId);
      console.log(`  - ${sourceId}: ${sourceDocuments.length} documents, ${sourceReport.discovered ?? "unknown"} discovered, ${sourceReport.fetched ?? "unknown"} fetched`);
    }
    if (smokeWarnings.length) {
      console.log("- warnings:");
      for (const warning of smokeWarnings) {
        console.log(`  - ${warning.sourceId}: ${warning.errors.join("; ")}`);
      }
    }
    console.log(`- proxy: ${reports.find((item) => item?.proxy)?.proxy || proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "direct/env"}`);
    if (keepOutput || hasArgument("--out") || hasArgument("--report")) {
      console.log(`- documents path: ${outputPath}`);
      console.log(`- report path: ${reportPath}`);
    } else {
      console.log("- output: temporary files removed");
    }
  } finally {
    if (!keepOutput && !hasArgument("--out") && !hasArgument("--report")) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

function createImporterArgs({ sourceIds, proxyUrl, outputPath, reportPath }) {
  const args = [
    "run",
    "import:official-sites",
    "--",
    "--source",
    sourceIds.join(","),
    "--out",
    outputPath,
    "--report",
    reportPath,
  ];

  pushOption(args, "--limit", "12");
  pushOption(args, "--max-links-per-source", "60");
  pushOption(args, "--max-discovery-pages", "4");
  pushOption(args, "--max-detail-fetches-per-source", "12");
  pushOption(args, "--max-source-ms", "60000");
  pushOption(args, "--timeout-ms", "12000");
  pushOption(args, "--request-delay-ms", "250");
  pushOption(args, "--discovery-reserve-ms", "20000");
  pushOption(args, "--concurrency", "2");
  if (proxyUrl) args.push("--proxy", proxyUrl);
  for (const flag of ["--no-readable-fallback", "--no-fetch-cache", "--no-proxy-direct-fallback"]) {
    if (hasFlag(flag)) args.push(flag);
  }
  return args;
}

function pushOption(args, name, defaultValue) {
  args.push(name, getArgumentValue(name) || defaultValue);
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

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function parseJsonl(text = "") {
  return String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function getSourceReports(report = {}) {
  return Array.isArray(report.reports)
    ? report.reports
    : (Array.isArray(report.sources) ? report.sources : []);
}

function isNonBlockingSmokeError(error) {
  return /source time budget exceeded|detail fetch limit reached/i.test(String(error || ""));
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

function createFileLabel(sourceIds = []) {
  const label = sourceIds.length === 1 ? sourceIds[0] : sourceIds.join("+");
  return label.replace(/[^a-z0-9_-]+/gi, "-") || "sources";
}

function getPositiveIntegerArgument(name, fallback) {
  const value = Number(getArgumentValue(name));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function hasArgument(name) {
  return process.argv.includes(name);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function getArgumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return "";
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
