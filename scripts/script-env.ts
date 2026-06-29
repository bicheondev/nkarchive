import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

export function loadDotEnvFile({
  filePath = path.join(ROOT_DIR, ".env"),
  env = process.env,
  override = false,
} = {}) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { loaded: false, values: {} };
    throw error;
  }

  const values = parseDotEnv(text);
  for (const [key, value] of Object.entries(values)) {
    if (override || env[key] === undefined) env[key] = value;
  }
  return { loaded: true, values };
}

export function parseDotEnv(text = "") {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;
    const [, key, rawValue = ""] = match;
    values[key] = parseDotEnvValue(rawValue);
  }
  return values;
}

function parseDotEnvValue(rawValue = "") {
  const value = String(rawValue || "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1);
    if (value.startsWith("'")) return inner;
    return inner
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return value.replace(/\s+#.*$/u, "").trim();
}
