import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const R2_ASSET_BASE_URL = "https://pub-a12b2bbd25db44479f7ca23251a65bef.r2.dev";
const fontDb = readFileSync("font_db.md", "utf8").split(/\r?\n/);
const zipEntries = execFileSync("unzip", ["-Z1", "font.zip"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split(/\r?\n/)
  .filter((entry) => /\.(ttf|otf)$/i.test(entry));

const pathByFileName = new Map();
for (const entry of zipEntries) {
  pathByFileName.set(path.posix.basename(entry), entry);
}

const topLevelSeries = new Set(["KCC-R", "KP V3.0", "KP V4.0"]);
const seriesNameMap = new Map([
  ["PnP符?", "PnP부호"],
  ["PRK P KPA", "KPA"],
]);
const fileNameMap = new Map([
  ["WKJS-Sonbikkim A Regular.ttf", "WKJSSbkk_2.TTF"],
]);

let currentSection = "";
let currentSubsection = "";
const rows = [];

for (const line of fontDb) {
  const topHeading = line.match(/^##\s+(.+)$/);
  if (topHeading) {
    currentSection = topHeading[1].trim();
    currentSubsection = "";
    continue;
  }

  const subHeading = line.match(/^###\s+(.+)$/);
  if (subHeading) {
    currentSubsection = subHeading[1].trim();
    continue;
  }

  const row = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|$/);
  if (!row) continue;

  const group = row[1].trim();
  const fileName = row[2].trim();
  const displayName = cleanupCell(row[3]);
  const rawSeries = topLevelSeries.has(currentSection) ? currentSection : currentSubsection || currentSection;
  const series = `${normalizeSeries(rawSeries)} 계열`;
  const zipFileName = fileNameMap.get(fileName) || fileName;
  const zipPath = pathByFileName.get(zipFileName);

  if (!zipPath) {
    throw new Error(`No matching font file in font.zip for ${fileName}`);
  }

  rows.push({
    index: rows.length + 1,
    series,
    group,
    fileName,
    displayName,
    path: assetUrl(`fonts/${zipPath}`),
  });
}

if (rows.length !== zipEntries.length) {
  throw new Error(`font_db.md has ${rows.length} rows, but font.zip has ${zipEntries.length} fonts`);
}

const tableRows = rows
  .map((row) => {
    return [
      row.index,
      escapeCell(row.series),
      escapeCell(row.group),
      escapeCell(row.fileName),
      escapeCell(row.displayName),
      escapeCell(row.path),
    ].join(" | ");
  })
  .map((line) => `| ${line} |`)
  .join("\n");

const output = `# DPRK Font Order

Generated from \`font_db.md\` and \`font.zip\`. The website reads this file directly and renders cards in this order.

| 번호 | 계열 | 그룹화 | 파일명 | 이름 | 경로 |
|---:|---|---|---|---|---|
${tableRows}
`;

writeFileSync("font_order.md", output, "utf8");
console.log(`Wrote font_order.md with ${rows.length} fonts.`);

function cleanupCell(value) {
  return value.trim().replace(/\?$/u, "");
}

function normalizeSeries(value) {
  const normalized = seriesNameMap.get(value) || value;
  return normalized.replace(/\?$/u, "");
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

function assetUrl(localPath) {
  return `${R2_ASSET_BASE_URL}/${localPath.replace(/^\/+/, "")}`;
}
