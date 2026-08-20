#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CHECKED_JSON_FILES = ["package.json", "vercel.json"];

async function main() {
  await checkJsonFiles();
  await checkJavaScriptSyntax();
  await runStep("news snapshot generation", "npm", ["run", "generate:news"]);
  await runStep("news archive checks", "npm", ["run", "test:news"]);
  await runStep("search correctness tests", "npm", ["run", "test:search"]);
  await runStep("Vercel bundle verification", "npm", ["run", "verify:vercel-bundle"]);
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
  const files = (await listFiles(path.join(ROOT_DIR, "scripts")))
    .filter((filePath) => /\.(?:js|mjs|ts)$/u.test(filePath))
    .sort();
  for (const filePath of files) {
    await runCommand("node", ["--check", filePath], { quiet: true });
  }
  console.log(`- checked ${files.length} script file(s)`);
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
