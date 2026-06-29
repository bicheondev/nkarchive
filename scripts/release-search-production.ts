#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSearchSeed } from "./seed-search.ts";
import { loadDotEnvFile } from "./script-env.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const MEILISEARCH_ENV_GROUPS = [
  ["MEILISEARCH_HOST", "MEILI_HOST"],
  ["MEILISEARCH_KEY", "MEILI_MASTER_KEY", "MEILI_API_KEY"],
];
const R2_ENV_GROUPS = [
  ["R2_PUBLIC_BASE_URL"],
  ["R2_BUCKET"],
  ["R2_ACCESS_KEY_ID"],
  ["R2_SECRET_ACCESS_KEY"],
  ["R2_ENDPOINT", "R2_ACCOUNT_ID"],
];
const VERCEL_ENV_GROUPS = [
  ["VERCEL_TOKEN"],
  ["VERCEL_ORG_ID"],
  ["VERCEL_PROJECT_ID"],
];
const VERIFY_ENV_GROUPS = [
  ["DPRK_SEARCH_PUBLIC_BASE_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"],
];
const FORWARDED_PREFLIGHT_OPTIONS = [
  "--proxy",
  "--source",
  "--sources",
  "--limit",
  "--max-links-per-source",
  "--max-discovery-pages",
  "--max-detail-fetches-per-source",
  "--max-source-ms",
  "--timeout-ms",
  "--request-delay-ms",
  "--discovery-reserve-ms",
  "--concurrency",
  "--min-documents",
];
const FORWARDED_PREFLIGHT_FLAGS = [
  "--skip-smoke",
  "--skip-tests",
  "--all-official-sites",
  "--no-readable-fallback",
  "--no-fetch-cache",
  "--no-proxy-direct-fallback",
];

async function main() {
  loadDotEnvFile();
  const options = parseReleaseOptions(process.argv.slice(2), process.env);
  const seed = await buildSearchSeed();
  const missingEnv = getMissingReleaseEnvironment(options, process.env);

  printReleaseHeader({ options, seed, missingEnv });
  if (options.confirmProduction && missingEnv.length) {
    console.error("Production release cannot continue because required environment is missing:");
    for (const item of missingEnv) console.error(`- ${item}`);
    process.exitCode = 1;
    return;
  }

  const steps = createReleaseSteps(options, missingEnv);
  for (const step of steps) {
    if (step.skipReason) {
      console.log(`\n[release] skip ${step.label}: ${step.skipReason}`);
      continue;
    }
    console.log(`\n[release] ${step.label}`);
    const result = await runCommand(step.command, step.args);
    if (result.code !== 0) {
      throw new Error(`${step.label} failed with exit code ${result.code}`);
    }
  }

  if (!options.confirmProduction) {
    console.log("\nSearch release dry run finished. Re-run with --confirm-production after the required Meilisearch/R2 environment is set to mutate production.");
  } else {
    console.log("\nSearch production release finished.");
  }
}

export function parseReleaseOptions(argv = [], env = process.env) {
  const confirmProduction = argv.includes("--confirm-production");
  if (confirmProduction && argv.includes("--dry-run")) {
    throw new Error("Use either --dry-run or --confirm-production, not both.");
  }
  return {
    confirmProduction,
    dryRun: !confirmProduction,
    skipPreflight: argv.includes("--skip-preflight"),
    skipMeilisearch: argv.includes("--skip-meilisearch"),
    skipR2: argv.includes("--skip-r2"),
    skipVerify: argv.includes("--skip-verify"),
    deployVercel: argv.includes("--deploy-vercel"),
    verifyUrl: getArgumentValue("--verify-url", argv) || getArgumentValue("--base-url", argv) || getProductionVerifyUrl(env),
    forwardedPreflightArgs: createForwardedPreflightArgs(argv),
  };
}

export function createReleaseSteps(options = {}, missingEnv = []) {
  const missing = new Set(missingEnv);
  const steps = [];
  if (!options.skipPreflight) {
    steps.push({
      label: "search release preflight",
      command: "npm",
      args: ["run", "preflight:search", "--", ...options.forwardedPreflightArgs],
    });
  }
  if (!options.skipR2) {
    steps.push({
      label: options.dryRun ? "search asset R2 upload dry run" : "search asset R2 upload",
      command: "npm",
      args: ["run", "upload:search-assets", "--", ...(options.dryRun ? ["--dry-run"] : [])],
      skipReason: options.dryRun && hasAnyMissingGroup(missing, R2_ENV_GROUPS)
        ? "R2 environment is not fully configured"
        : "",
    });
  }
  if (!options.skipMeilisearch) {
    steps.push({
      label: options.dryRun ? "Meilisearch sync dry run" : "Meilisearch sync",
      command: "npm",
      args: ["run", "sync:meilisearch", "--", ...(options.dryRun ? ["--dry-run"] : ["--wait"])],
    });
  }
  if (options.deployVercel) {
    steps.push({
      label: options.dryRun ? "Vercel project link check" : "Vercel project link",
      command: "npx",
      args: ["--yes", "vercel", "pull", "--yes", "--environment=production", "--token", process.env.VERCEL_TOKEN || ""],
      skipReason: options.dryRun
        ? "dry run does not pull Vercel project settings"
        : "",
    });
    steps.push({
      label: options.dryRun ? "Vercel production deploy check" : "Vercel production deploy",
      command: "npx",
      args: ["--yes", "vercel", "deploy", "--prod", "--yes", "--token", process.env.VERCEL_TOKEN || ""],
      skipReason: options.dryRun
        ? "dry run does not invoke Vercel deployment"
        : "",
    });
  }
  if (!options.skipVerify) {
    steps.push({
      label: options.dryRun ? "production search verification check" : "production search verification",
      command: "npm",
      args: ["run", "verify:search-production", "--", "--base-url", options.verifyUrl || ""],
      skipReason: options.dryRun && !options.verifyUrl
        ? "production search URL is not configured"
        : "",
    });
  }
  return steps;
}

export function getMissingReleaseEnvironment(options = {}, env = process.env) {
  const missing = [];
  if (!options.skipMeilisearch) collectMissingGroups(missing, MEILISEARCH_ENV_GROUPS, env);
  if (!options.skipR2) collectMissingGroups(missing, R2_ENV_GROUPS, env);
  if (options.deployVercel) collectMissingGroups(missing, VERCEL_ENV_GROUPS, env);
  if (!options.skipVerify && !options.verifyUrl) collectMissingGroups(missing, VERIFY_ENV_GROUPS, env);
  return missing;
}

function collectMissingGroups(missing, groups, env) {
  for (const group of groups) {
    if (!group.some((name) => env[name])) missing.push(group.join(" or "));
  }
}

function hasAnyMissingGroup(missingSet, groups) {
  return groups.some((group) => missingSet.has(group.join(" or ")));
}

function printReleaseHeader({ options, seed, missingEnv }) {
  console.log(`Search production release ${options.confirmProduction ? "mode" : "dry run"}:`);
  console.log(`- documents: ${seed.documents.length}`);
  console.log(`- suggestions: ${seed.suggestions.length}`);
  console.log(`- sources: ${seed.sources.length}`);
  console.log(`- document index: ${seed.documentIndexName}`);
  console.log(`- suggestion index: ${seed.suggestionIndexName}`);
  if (missingEnv.length) {
    console.log("- missing production environment:");
    for (const item of missingEnv) console.log(`  - ${item}`);
  } else {
    console.log("- production environment: ready");
  }
}

function createForwardedPreflightArgs(argv = []) {
  const args = [];
  for (const flag of FORWARDED_PREFLIGHT_FLAGS) {
    if (argv.includes(flag)) args.push(flag);
  }
  for (const option of FORWARDED_PREFLIGHT_OPTIONS) {
    const value = getArgumentValue(option, argv);
    if (value) args.push(option, value);
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

function getArgumentValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : "";
}

function getProductionVerifyUrl(env = process.env) {
  return env.DPRK_SEARCH_PUBLIC_BASE_URL
    || env.VERCEL_PROJECT_PRODUCTION_URL
    || env.VERCEL_URL
    || "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
