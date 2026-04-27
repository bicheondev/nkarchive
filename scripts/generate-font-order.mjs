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
  ["PnP\u7b26?", "PnP부호"],
  ["PRK P KPA", "KPA"],
]);
const pathSegmentMap = new Map([
  ["PnP\u9752\u5cf0", "PnP청봉"],
  ["PnP\u5343\u91cc\u9a6c", "PnP천리마"],
  ["PnP\u5149\u660e", "PnP광명"],
  ["PnP\u7b14\u4e66", "PnP붓글"],
  ["PnP\u65b0\u65e5", "PnP새날"],
  ["PnP\u7b26\u53f7", "PnP부호"],
  ["PRK P \u57fa\u672c", "PRK P 기본"],
  ["PRK P \u7b14\u4e66", "PRK P 붓글"],
  ["PRK P \u9752\u5cf0", "PRK P 청봉"],
  ["PRK P \u7ae5\u5fc3", "PRK P 동심"],
  ["PRK P \u53e4\u5178", "PRK P 고전"],
  ["PRK P \u5149\u660e", "PRK P 광명"],
  ["PRK P \u54e5\u7279", "PRK P 고직"],
  ["PRK P \u7b14\u8bb0", "PRK P 필기"],
  ["PRK P \u7acb\u4f53", "PRK P 입체"],
  ["PRK P \u88c5\u9970", "PRK P 장식"],
  ["WK\u7b14\u4e66", "WK붓글"],
  ["WK\u80cc\u666f", "WK바탕장식"],
  ["WK\u9752\u5cf0", "WK청봉"],
  ["WK\u7ae5\u5fc3", "WK동심"],
  ["WK\u57fa\u672c", "WK기본"],
  ["WK\u53e4\u5178", "WK고전"],
  ["WK\u5149\u660e", "WK광명"],
  ["WK\u54e5\u7279", "WK고직"],
  ["WK\u5706\u54e5\u7279", "WK환고직"],
  ["WK\u88c5\u9970", "WK장식"],
  ["WK\u7b14\u8bb0", "WK필기"],
  ["WK\u5f8b\u52a8", "WK률동"],
  ["WK\u65b0\u65e5", "WK새날"],
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
    path: assetUrl(`fonts/${normalizeAssetPath(zipPath)}`),
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

function normalizeAssetPath(value) {
  return value
    .split("/")
    .map((segment) => pathSegmentMap.get(segment) || segment)
    .join("/");
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

function assetUrl(localPath) {
  return `${R2_ASSET_BASE_URL}/${localPath.replace(/^\/+/, "")}`;
}
