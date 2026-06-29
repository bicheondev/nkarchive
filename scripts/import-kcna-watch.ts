#!/usr/bin/env node
import { SEARCH_SOURCES } from "../search/sourceConfig.js";
import {
  crawlSources,
  parseImporterOptions,
  stripRuntimeSourceConfig,
  writeImportOutput,
} from "./search-crawler-utils.ts";
import { loadDotEnvFile } from "./script-env.ts";

async function main() {
  loadDotEnvFile();
  const options = parseImporterOptions("kcna-watch.documents.jsonl");
  const sources = SEARCH_SOURCES.filter((source) => source.crawler?.importer === "kcna-watch");
  const { documents, crawlReports } = await crawlSources(sources, options);
  await writeImportOutput({
    documents,
    sources: sources.map(stripRuntimeSourceConfig),
    reports: crawlReports,
    outputPath: options.outputPath,
    sourcesPath: options.sourcesPath,
    reportPath: options.reportPath,
  });

  console.log(`Imported ${documents.length} real KCNA Watch documents.`);
  console.log(`Documents: ${options.outputPath}`);
  console.log(`Report: ${options.reportPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
