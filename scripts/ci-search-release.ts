#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CHECKED_JSON_FILES = ["package.json", "vercel.json"];
const SEARCH_SCRIPT_FILES = [
  "audit-search-production.ts",
  "cache-search-assets.ts",
  "ci-search-release.ts",
  "import-kcna-watch.ts",
  "import-koryo-vod.ts",
  "import-official-sites.ts",
  "import-search-index.ts",
  "import-youtube-metadata.ts",
  "ingest-search-documents.ts",
  "preflight-search-release.ts",
  "release-search-production.ts",
  "script-env.ts",
  "search-crawler-utils.ts",
  "search-local.ts",
  "seed-search.ts",
  "smoke-search-crawl.ts",
  "sync-meilisearch.ts",
  "test-search-correctness.ts",
  "upload-search-assets-r2.ts",
  "validate-search-index.ts",
  "verify-search-production.ts",
];
const SEARCH_AUTOMATION_FILES = [
  ".github/workflows/search-ci.yml",
  ".github/workflows/search-production-release.yml",
  "scripts/ci-search-release.ts",
  "scripts/import-search-index.ts",
  "scripts/preflight-search-release.ts",
  "scripts/release-search-production.ts",
];

async function main() {
  await checkJsonFiles();
  await checkProductSeparation();
  await checkJavaScriptSyntax();
  await runStep("search correctness tests", "npm", ["run", "test:search"]);
  await runStep("search release dry run", "npm", ["run", "release:search", "--", "--skip-smoke", "--skip-tests"]);
  console.log("\nSearch CI release gate passed.");
}

async function checkJsonFiles() {
  console.log("\n[ci] JSON manifests");
  for (const fileName of CHECKED_JSON_FILES) {
    JSON.parse(await fs.readFile(path.join(ROOT_DIR, fileName), "utf8"));
    console.log(`- ${fileName}`);
  }
}

async function checkJavaScriptSyntax() {
  console.log("\n[ci] JavaScript syntax");
  const files = [
    ...SEARCH_SCRIPT_FILES.map((fileName) => path.join(ROOT_DIR, "scripts", fileName)),
    ...(await listFiles(path.join(ROOT_DIR, "search"))).filter((filePath) => /\.(?:js|mjs|ts)$/u.test(filePath)),
    ...(await listFiles(path.join(ROOT_DIR, "components"))).filter((filePath) => /\.js$/u.test(filePath)),
    ...(await listFiles(path.join(ROOT_DIR, "api"))).filter((filePath) => /\/search-[^/]+\.js$/u.test(filePath)),
  ].sort();
  for (const filePath of files) {
    await runCommand("node", ["--check", filePath], { quiet: true });
  }
  console.log(`- checked ${files.length} script file(s)`);
}

async function checkProductSeparation() {
  console.log("\n[ci] Product pipeline separation");
  const product = ["ne", "ws"].join("");
  const forbiddenFragments = [
    `generate:${product}`,
    `refresh:${product}`,
    `test:${product}`,
    `generate-${product}`,
    `refresh-${product}`,
    `test-${product}`,
    `data/${product}`,
    `${product}/`,
    ["verify:vercel", "bundle"].join("-"),
  ];
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT_DIR, "package.json"), "utf8"));
  const searchCommands = Object.entries(packageJson.scripts || {})
    .filter(([name]) => name.includes("search") && !name.includes("news-search"))
    .map(([name, command]) => `${name}: ${command}`)
    .join("\n");
  const automationSources = await Promise.all(
    SEARCH_AUTOMATION_FILES.map(async (fileName) => [
      fileName,
      await fs.readFile(path.join(ROOT_DIR, fileName), "utf8"),
    ]),
  );
  for (const [fileName, source] of [["package.json search commands", searchCommands], ...automationSources]) {
    const forbidden = forbiddenFragments.find((fragment) => source.includes(fragment));
    if (forbidden) throw new Error(`${fileName} is coupled to a separate product pipeline (${forbidden})`);
  }
  console.log(`- checked ${automationSources.length + 1} search automation source(s)`);
}

async function listFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function runStep(label, command, args) {
  console.log(`\n[ci] ${label}`);
  await runCommand(command, args);
}

function runCommand(command, args, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: quiet ? "pipe" : "inherit",
    });
    let stderr = "";
    if (quiet) {
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${code}${stderr ? `:\n${stderr}` : ""}`));
      }
    });
    child.on("error", reject);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
