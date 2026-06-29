#!/usr/bin/env node
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildSearchSeed, DEFAULT_OUTPUT_PATH } from "./seed-search.ts";
import { loadDotEnvFile } from "./script-env.ts";

async function main() {
  loadDotEnvFile();
  const dryRun = process.argv.includes("--dry-run");
  const wait = process.argv.includes("--wait");
  const seedPath = getArgumentValue("--seed") || "";
  const host = String(process.env.MEILISEARCH_HOST || process.env.MEILI_HOST || "").replace(/\/+$/, "");
  const apiKey = String(process.env.MEILISEARCH_KEY || process.env.MEILI_MASTER_KEY || process.env.MEILI_API_KEY || "");
  const payload = seedPath ? await readSeed(seedPath) : await buildSearchSeed();

  if (dryRun) {
    console.log("Meilisearch sync dry run:");
    console.log(`- document index: ${payload.documentIndexName}`);
    console.log(`- suggestion index: ${payload.suggestionIndexName}`);
    console.log(`- documents: ${payload.documents.length}`);
    console.log(`- suggestions: ${payload.suggestions.length}`);
    console.log(`- sources: ${payload.sources.length}`);
    console.log(`- document filterable attributes: ${payload.settings.documents.filterableAttributes.join(", ")}`);
    return;
  }

  if (!host || !apiKey) {
    console.error("MEILISEARCH_HOST and MEILISEARCH_KEY are required. Use --dry-run to validate the local payload without a server.");
    process.exitCode = 1;
    return;
  }

  const result = await syncMeilisearchPayload(payload, { host, apiKey, wait });

  console.log("Meilisearch sync submitted:");
  console.log(`- document index: ${payload.documentIndexName} (${payload.documents.length} documents)`);
  console.log(`- suggestion index: ${payload.suggestionIndexName} (${payload.suggestions.length} suggestions)`);
  console.log(`- tasks: ${result.tasks.map((task) => task?.taskUid ?? task?.uid).filter((task) => task !== undefined).join(", ")}`);
}

export async function syncMeilisearchPayload(payload, {
  host = "",
  apiKey = "",
  wait = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!host || !apiKey) {
    throw new Error("MEILISEARCH_HOST and MEILISEARCH_KEY are required.");
  }

  const client = new MeilisearchAdminClient({ host, apiKey, fetchImpl });
  await client.ensureIndex(payload.documentIndexName, "id");
  await client.ensureIndex(payload.suggestionIndexName, "id");

  const tasks = [];
  tasks.push(...await client.replaceIndexAtomically(payload.documentIndexName, payload.documents, payload.settings.documents, { waitCleanup: wait }));
  tasks.push(...await client.replaceIndexAtomically(payload.suggestionIndexName, payload.suggestions, payload.settings.suggestions, { waitCleanup: wait }));

  return { tasks };
}

export class MeilisearchAdminClient {
  constructor({ host, apiKey, fetchImpl = globalThis.fetch }) {
    this.host = host;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async ensureIndex(uid, primaryKey) {
    const existing = await this.request(`/indexes/${encodeURIComponent(uid)}`, { method: "GET", allow404: true });
    if (existing) return existing;
    return this.request("/indexes", {
      method: "POST",
      body: { uid, primaryKey },
    });
  }

  async patchSettings(uid, settings) {
    return this.request(`/indexes/${encodeURIComponent(uid)}/settings`, {
      method: "PATCH",
      body: settings,
    });
  }

  async replaceIndexAtomically(uid, documents, settings, { waitCleanup = false } = {}) {
    const stagingUid = getStagingIndexUid(uid);
    await this.ensureIndex(stagingUid, "id");

    const stagingTasks = [
      await this.patchSettings(stagingUid, settings),
      ...await this.replaceAllDocumentsExact(stagingUid, documents),
    ];
    for (const task of stagingTasks.filter(Boolean)) {
      await this.waitForTask(task.taskUid ?? task.uid);
    }

    const swapTask = await this.swapIndexes(uid, stagingUid);
    await this.waitForTask(swapTask.taskUid ?? swapTask.uid);
    const cleanupTask = await this.deleteIndex(stagingUid);
    if (waitCleanup) await this.waitForTask(cleanupTask.taskUid ?? cleanupTask.uid);

    return [...stagingTasks, swapTask, cleanupTask];
  }

  async replaceAllDocumentsExact(uid, documents) {
    const deleteTask = await this.deleteAllDocuments(uid);
    const addTask = await this.addDocuments(uid, documents);
    return [deleteTask, addTask];
  }

  async deleteAllDocuments(uid) {
    return this.request(`/indexes/${encodeURIComponent(uid)}/documents`, {
      method: "DELETE",
    });
  }

  async addDocuments(uid, documents) {
    return this.request(`/indexes/${encodeURIComponent(uid)}/documents?primaryKey=id`, {
      method: "PUT",
      body: documents,
    });
  }

  async swapIndexes(leftUid, rightUid) {
    return this.request("/swap-indexes", {
      method: "POST",
      body: [{ indexes: [leftUid, rightUid] }],
    });
  }

  async deleteIndex(uid) {
    return this.request(`/indexes/${encodeURIComponent(uid)}`, {
      method: "DELETE",
    });
  }

  async waitForTask(taskUid) {
    if (taskUid === undefined || taskUid === null) return null;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 120000) {
      const task = await this.request(`/tasks/${encodeURIComponent(taskUid)}`, { method: "GET" });
      if (task.status === "succeeded") return task;
      if (task.status === "failed" || task.status === "canceled") {
        throw new Error(`Meilisearch task ${taskUid} ${task.status}: ${task.error?.message || "unknown error"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for Meilisearch task ${taskUid}`);
  }

  async request(path, { method = "GET", body, allow404 = false } = {}) {
    const response = await this.fetchImpl(`${this.host}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Meilisearch ${method} ${path} failed: ${response.status}${text ? ` ${text.slice(0, 300)}` : ""}`);
    }
    if (response.status === 204) return {};
    return response.json();
  }
}

async function readSeed(filePath = DEFAULT_OUTPUT_PATH) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function getArgumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function getStagingIndexUid(uid) {
  return `${uid}__next`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
