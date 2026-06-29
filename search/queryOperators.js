import { createSearchToken } from "./normalizeQuery.js?v=search-20260630-1";
import { SEARCH_LANGUAGES } from "./schemas.js?v=search-20260630-1";
import { SEARCH_SOURCES } from "./sourceConfig.js?v=search-20260630-1";

export const SITE_OPERATOR_NAMES = ["site", "domain", "host", "사이트", "도메인"];
export const SOURCE_OPERATOR_NAMES = ["source", "src", "출처", "자료원"];
export const MEDIA_OPERATOR_NAMES = ["filetype", "ext", "extension", "type", "media", "format", "mime", "파일형식", "파일", "형식", "매체", "종류"];
export const LANGUAGE_OPERATOR_NAMES = ["lang", "language", "언어"];
export const DATE_START_OPERATOR_NAMES = ["after", "since", "from", "이후", "부터"];
export const DATE_END_OPERATOR_NAMES = ["before", "until", "to", "이전", "까지"];
export const DATE_RANGE_OPERATOR_NAMES = ["date", "daterange", "기간", "날짜"];
const QUERY_OPERATOR_NAMES = [
  ...SITE_OPERATOR_NAMES,
  ...SOURCE_OPERATOR_NAMES,
  ...MEDIA_OPERATOR_NAMES,
  ...LANGUAGE_OPERATOR_NAMES,
  ...DATE_START_OPERATOR_NAMES,
  ...DATE_END_OPERATOR_NAMES,
  ...DATE_RANGE_OPERATOR_NAMES,
].join("|");
const QUERY_OPERATOR_NAME_SET = new Set(QUERY_OPERATOR_NAMES.split("|"));
const QUERY_OPERATOR_PATTERN = new RegExp(`(^|\\s)(-?)\\(?(${QUERY_OPERATOR_NAMES}):\\(?(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’|([^\\s)]+))\\)?`, "giu");
const SITE_OPERATOR_NAME_SET = new Set(SITE_OPERATOR_NAMES);
const SOURCE_OPERATOR_NAME_SET = new Set(SOURCE_OPERATOR_NAMES);
const MEDIA_OPERATOR_NAME_SET = new Set(MEDIA_OPERATOR_NAMES);
const LANGUAGE_OPERATOR_NAME_SET = new Set(LANGUAGE_OPERATOR_NAMES);
const DATE_START_OPERATOR_NAME_SET = new Set(DATE_START_OPERATOR_NAMES);
const DATE_END_OPERATOR_NAME_SET = new Set(DATE_END_OPERATOR_NAMES);
const DATE_RANGE_OPERATOR_NAME_SET = new Set(DATE_RANGE_OPERATOR_NAMES);

const MEDIA_OPERATOR_TABS = new Map([
  ["pdf", "pdf"],
  ["문헌", "pdf"],
  ["document", "pdf"],
  ["documents", "pdf"],
  ["doc", "pdf"],
  ["image", "image"],
  ["images", "image"],
  ["img", "image"],
  ["사진", "image"],
  ["이미지", "image"],
  ["jpg", "image"],
  ["jpeg", "image"],
  ["png", "image"],
  ["gif", "image"],
  ["webp", "image"],
  ["video", "video"],
  ["videos", "video"],
  ["movie", "video"],
  ["broadcast", "video"],
  ["동영상", "video"],
  ["방송", "video"],
  ["mp4", "video"],
  ["webm", "video"],
  ["mov", "video"],
  ["m4v", "video"],
]);

const MEDIA_OPERATOR_TYPES_BY_TAB = {
  image: ["image"],
  pdf: ["pdf"],
  video: ["video", "broadcast"],
};

const LANGUAGE_OPERATOR_VALUES = new Map([
  ["ko", "ko"], ["kor", "ko"], ["kr", "ko"], ["korean", "ko"], ["한국어", "ko"], ["조선어", "ko"], ["조선말", "ko"],
  ["en", "en"], ["eng", "en"], ["english", "en"], ["영어", "en"],
  ["ja", "ja"], ["jp", "ja"], ["jpn", "ja"], ["japanese", "ja"], ["일본어", "ja"],
  ["zh", "zh"], ["cn", "zh"], ["chi", "zh"], ["zho", "zh"], ["chinese", "zh"], ["중국어", "zh"],
  ["ru", "ru"], ["rus", "ru"], ["russian", "ru"], ["러시아어", "ru"],
  ["es", "es"], ["spa", "es"], ["spanish", "es"], ["스페인어", "es"],
  ["fr", "fr"], ["fra", "fr"], ["fre", "fr"], ["french", "fr"], ["프랑스어", "fr"],
  ["ar", "ar"], ["ara", "ar"], ["arabic", "ar"], ["아랍어", "ar"],
  ["de", "de"], ["ger", "de"], ["deu", "de"], ["german", "de"], ["독일어", "de"],
  ["multi", "multi"], ["multiple", "multi"], ["multilingual", "multi"], ["다국어", "multi"],
  ["unknown", "unknown"], ["unk", "unknown"], ["미상", "unknown"],
]);

export function parseSearchQueryOperators(query = "", sources = SEARCH_SOURCES) {
  const text = normalizeStructuredNotOperators(query);
  const sourceIds = [];
  const excludedSourceIds = [];
  const excludedMediaTypes = [];
  const languages = [];
  const excludedLanguages = [];
  let tab = "";
  let dateFrom = "";
  let dateTo = "";
  let cleaned = "";
  let cursor = 0;
  let match;
  let strippedStructuredOperator = false;

  while ((match = QUERY_OPERATOR_PATTERN.exec(text)) !== null) {
    const [rawMatch, leadingSpace, negation, rawOperator, doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted, bareValue] = match;
    const operator = String(rawOperator || "").toLocaleLowerCase("en-US");
    const isNegated = negation === "-";
    const rawValue = normalizeOperatorValue(doubleQuoted || singleQuoted || curlyDoubleQuoted || curlySingleQuoted || bareValue || "");
    const sourceMatches = isSourceFilterOperator(operator)
      ? resolveSourceOperatorValues(rawValue, sources)
      : [];
    const mediaTab = isMediaOperator(operator)
      ? resolveMediaOperatorTab(rawValue)
      : "";
    const mediaTypes = mediaTab ? resolveMediaOperatorMediaTypes(rawValue) : [];
    const language = isLanguageOperator(operator)
      ? resolveLanguageOperatorValue(rawValue)
      : "";
    const dateValue = isDateStartOperator(operator)
      ? resolveDateOperatorValue(rawValue, "start")
      : (isDateEndOperator(operator) ? resolveDateOperatorValue(rawValue, "end") : "");
    const dateRange = isDateRangeOperator(operator)
      ? resolveDateRangeOperatorValue(rawValue)
      : null;

    cleaned += text.slice(cursor, match.index);
    if (sourceMatches.length && isNegated) {
      for (const source of sourceMatches) {
        if (!excludedSourceIds.includes(source.id)) excludedSourceIds.push(source.id);
      }
      strippedStructuredOperator = true;
      if (leadingSpace) cleaned += " ";
    } else if (sourceMatches.length) {
      for (const source of sourceMatches) {
        if (!sourceIds.includes(source.id)) sourceIds.push(source.id);
      }
      strippedStructuredOperator = true;
      if (leadingSpace) cleaned += " ";
    } else if (mediaTab && isNegated) {
      for (const mediaType of mediaTypes) {
        if (!excludedMediaTypes.includes(mediaType)) excludedMediaTypes.push(mediaType);
      }
      strippedStructuredOperator = true;
      if (leadingSpace) cleaned += " ";
    } else if (mediaTab) {
      tab = mediaTab;
      strippedStructuredOperator = true;
      if (leadingSpace) cleaned += " ";
    } else if (language && isNegated) {
      if (!excludedLanguages.includes(language)) excludedLanguages.push(language);
      strippedStructuredOperator = true;
      if (leadingSpace) cleaned += " ";
    } else if (language) {
      if (!languages.includes(language)) languages.push(language);
      strippedStructuredOperator = true;
      if (leadingSpace) cleaned += " ";
    } else if (dateRange?.dateFrom && dateRange.dateTo && !isNegated) {
      dateFrom = dateRange.dateFrom;
      dateTo = dateRange.dateTo;
      strippedStructuredOperator = true;
      if (leadingSpace) cleaned += " ";
    } else if (dateValue && !isNegated) {
      if (isDateStartOperator(operator)) {
        dateFrom = dateValue;
      } else {
        dateTo = dateValue;
      }
      strippedStructuredOperator = true;
      if (leadingSpace) cleaned += " ";
    } else {
      cleaned += rawMatch;
    }
    cursor = QUERY_OPERATOR_PATTERN.lastIndex;
  }

  cleaned += text.slice(cursor);
  const normalizedQuery = cleanStructuredOperatorQueryText(cleaned, strippedStructuredOperator);

  return {
    query: normalizedQuery,
    sourceIds,
    excludedSourceIds,
    excludedMediaTypes,
    languages,
    excludedLanguages,
    tab,
    dateFrom,
    dateTo,
  };
}

function cleanStructuredOperatorQueryText(value = "", shouldClean = false) {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  if (!shouldClean) return compact;
  let cleaned = compact;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = cleaned
      .replace(/^(?:OR|AND|\||&&)(?:\s+|$)/iu, "")
      .replace(/(?:^|\s+)(?:OR|AND|\||&&)$/iu, "")
      .replace(/\s+/g, " ")
      .trim();
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned;
}

function normalizeStructuredNotOperators(value = "") {
  return transformUnquotedSegments(value, (segment) => segment.replace(/(^|\s)NOT\s+(?=\(?\s*([A-Za-z가-힣]+):)/gu, (match, leadingSpace, operator) => (
    QUERY_OPERATOR_NAME_SET.has(String(operator || "").toLocaleLowerCase("en-US"))
      ? `${leadingSpace || ""}-`
      : match
  )));
}

function transformUnquotedSegments(value = "", transform = (segment) => segment) {
  let output = "";
  let current = "";
  let closingQuote = "";
  const text = String(value || "");

  const flushCurrent = () => {
    output += transform(current);
    current = "";
  };

  for (const char of text) {
    if (closingQuote) {
      output += char;
      if (char === closingQuote) closingQuote = "";
      continue;
    }

    const quoteEnd = getClosingQuote(char);
    if (quoteEnd) {
      flushCurrent();
      closingQuote = quoteEnd;
      output += char;
      continue;
    }

    current += char;
  }

  flushCurrent();
  return output;
}

function getClosingQuote(char = "") {
  if (char === "\"") return "\"";
  if (char === "'") return "'";
  if (char === "“") return "”";
  if (char === "‘") return "’";
  return "";
}

function normalizeOperatorValue(value = "") {
  let text = String(value || "").trim();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = text
      .replace(/^\(+\s*/u, "")
      .replace(/\s*\)+$/u, "")
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

export function hasStructuredSearchOperators(parsedQuery = {}) {
  return Boolean(
    parsedQuery.tab
      || parsedQuery.dateFrom
      || parsedQuery.dateTo
      || parsedQuery.sourceIds?.length
      || parsedQuery.excludedSourceIds?.length
      || parsedQuery.excludedMediaTypes?.length
      || parsedQuery.languages?.length
      || parsedQuery.excludedLanguages?.length,
  );
}

export function resolveSourceOperatorValue(value = "", sources = SEARCH_SOURCES) {
  return resolveSourceOperatorValues(value, sources)[0] || null;
}

export function resolveSourceOperatorValues(value = "", sources = SEARCH_SOURCES) {
  const selector = String(value || "").trim().replace(/\/+$/, "");
  if (!selector) return [];

  const selectorHost = getCanonicalHost(selector) || getBareHostSuffixSelector(selector);
  if (selectorHost) {
    const hostMatches = sources.filter((source) => sourceHostMatches(getCanonicalHost(source.baseUrl), selectorHost));
    if (hostMatches.length) return hostMatches;
  }

  const selectorToken = createSearchToken(selector);

  for (const source of sources) {
    const labels = [
      source.id,
      source.name,
      source.baseUrl,
      getCanonicalHost(source.baseUrl),
      ...(source.aliases || []),
    ].filter(Boolean);

    if (labels.some((label) => createSearchToken(label).compactLower === selectorToken.compactLower)) {
      return [source];
    }
  }

  return [];
}

export function resolveLanguageOperatorValue(value = "") {
  const selector = String(value || "")
    .trim()
    .replace(/[_\s]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!selector) return "";

  const normalized = selector.toLocaleLowerCase("en-US");
  const language = LANGUAGE_OPERATOR_VALUES.get(normalized) || "";
  if (language && SEARCH_LANGUAGES.includes(language)) return language;
  return SEARCH_LANGUAGES.includes(normalized) ? normalized : "";
}

export function resolveMediaOperatorTab(value = "") {
  const selector = String(value || "")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\/+$/, "");
  if (!selector) return "";

  const normalized = selector.toLocaleLowerCase("en-US");
  return MEDIA_OPERATOR_TABS.get(normalized) || "";
}

function isMediaOperator(operator = "") {
  return MEDIA_OPERATOR_NAME_SET.has(operator);
}

function isSourceFilterOperator(operator = "") {
  return SITE_OPERATOR_NAME_SET.has(operator) || SOURCE_OPERATOR_NAME_SET.has(operator);
}

function isLanguageOperator(operator = "") {
  return LANGUAGE_OPERATOR_NAME_SET.has(operator);
}

function isDateStartOperator(operator = "") {
  return DATE_START_OPERATOR_NAME_SET.has(operator);
}

function isDateEndOperator(operator = "") {
  return DATE_END_OPERATOR_NAME_SET.has(operator);
}

function isDateRangeOperator(operator = "") {
  return DATE_RANGE_OPERATOR_NAME_SET.has(operator);
}

export function resolveMediaOperatorMediaTypes(value = "") {
  const tab = resolveMediaOperatorTab(value);
  return tab ? [...(MEDIA_OPERATOR_TYPES_BY_TAB[tab] || [])] : [];
}

export function resolveDateOperatorValue(value = "", boundary = "start") {
  const selector = String(value || "")
    .trim()
    .replace(/[()[\]{}]/g, "")
    .replace(/년|월/g, "-")
    .replace(/일/g, "")
    .replace(/[./]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const match = selector.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/);
  if (!match) return "";

  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : (boundary === "end" ? 12 : 1);
  const day = match[3] ? Number(match[3]) : (boundary === "end" ? getLastDayOfMonth(year, month) : 1);
  if (!isValidDatePart(year, month, day)) return "";

  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

export function resolveDateRangeOperatorValue(value = "") {
  const selector = String(value || "")
    .trim()
    .replace(/[()[\]{}]/g, "")
    .replace(/\s+/g, "");
  if (!selector) return { dateFrom: "", dateTo: "" };

  const parts = selector.includes("..")
    ? selector.split(/\.\.+/u, 2)
    : [selector, selector];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { dateFrom: "", dateTo: "" };

  const dateFrom = resolveDateOperatorValue(parts[0], "start");
  const dateTo = resolveDateOperatorValue(parts[1], "end");
  if (!dateFrom || !dateTo || dateFrom > dateTo) return { dateFrom: "", dateTo: "" };
  return { dateFrom, dateTo };
}

function isValidDatePart(year, month, day) {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > getLastDayOfMonth(year, month)) return false;
  return true;
}

function getLastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function getCanonicalHost(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";

  try {
    return normalizeHost(new URL(text).hostname);
  } catch {
    // Try plain host-like input such as rodong.rep.kp or rodong.rep.kp/index.php.
  }

  const leadingDotHost = text.replace(/^\.+/, "");
  if (leadingDotHost !== text && /^[a-z0-9.-]+$/i.test(leadingDotHost)) {
    return normalizeHost(leadingDotHost);
  }

  const wildcardHost = text.replace(/^\*\.+/, "");
  if (wildcardHost !== text && /^[a-z0-9.-]+$/i.test(wildcardHost)) {
    return normalizeHost(wildcardHost);
  }

  if (!/[./]/.test(text) || /\s/.test(text)) return "";
  try {
    return normalizeHost(new URL(`https://${text}`).hostname);
  } catch {
    return "";
  }
}

function getBareHostSuffixSelector(value = "") {
  const text = String(value || "").trim().replace(/\.$/, "");
  if (!/^[a-z]{2,63}$/i.test(text)) return "";
  return normalizeHost(text);
}

function sourceHostMatches(sourceHost = "", selectorHost = "") {
  if (!sourceHost || !selectorHost) return false;
  return sourceHost === selectorHost || sourceHost.endsWith(`.${selectorHost}`);
}

function normalizeHost(value = "") {
  return String(value || "")
    .toLocaleLowerCase("en-US")
    .replace(/^www\./, "");
}
