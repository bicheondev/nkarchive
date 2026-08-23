import { createSearchToken, getSearchScore, isStandaloneConsonantOnlySearch, normalizeQuery } from "./normalizeQuery.js?v=search-20260823-7";
import { getKnownEntitySuggestionEntries } from "./knownEntities.js?v=search-20260823-7";
import {
  DATE_END_OPERATOR_NAMES,
  DATE_RANGE_OPERATOR_NAMES,
  DATE_START_OPERATOR_NAMES,
  LANGUAGE_OPERATOR_NAMES,
  MEDIA_OPERATOR_NAMES,
  SITE_OPERATOR_NAMES,
  SOURCE_OPERATOR_NAMES,
} from "./queryOperators.js?v=search-20260823-7";

const SOURCE_TYPE_LABELS = {
  official_site: "공식 자료원",
  archive: "아카이브 자료원",
  video_archive: "영상 자료원",
  pdf: "문헌 자료원",
  image: "이미지 자료원",
};

const MEDIA_TYPE_LABELS = {
  article: "기사",
  image: "이미지",
  video: "동영상",
  pdf: "문헌",
  broadcast: "방송",
};

const OPERATOR_SUGGESTION_PATTERN = /(^|\s)(-?)\(?([A-Za-z가-힣]+):(?:"([^"]*)|'([^']*)|“([^”]*)|‘([^’]*)|([^\s)]*))$/u;
const KOREAN_OPERATOR_NAMES = new Set([
  "사이트",
  "도메인",
  "출처",
  "자료원",
  "파일형식",
  "파일",
  "형식",
  "매체",
  "종류",
  "언어",
  "이후",
  "부터",
  "이전",
  "까지",
  "기간",
  "날짜",
]);
const OPERATOR_KIND_BY_NAME = new Map([
  ...SITE_OPERATOR_NAMES.map((name) => [name, "site"]),
  ...SOURCE_OPERATOR_NAMES.map((name) => [name, "source"]),
  ...MEDIA_OPERATOR_NAMES.map((name) => [name, "media"]),
  ...LANGUAGE_OPERATOR_NAMES.map((name) => [name, "language"]),
  ...DATE_START_OPERATOR_NAMES.map((name) => [name, "date_start"]),
  ...DATE_END_OPERATOR_NAMES.map((name) => [name, "date_end"]),
  ...DATE_RANGE_OPERATOR_NAMES.map((name) => [name, "date_range"]),
]);
const ENGLISH_MEDIA_OPERATOR_VALUES = [
  { value: "pdf", description: "문헌 탭" },
  { value: "image", description: "이미지 탭" },
  { value: "video", description: "동영상 탭" },
  { value: "broadcast", description: "동영상 탭" },
];
const KOREAN_MEDIA_OPERATOR_VALUES = [
  { value: "문헌", description: "문헌 탭" },
  { value: "이미지", description: "이미지 탭" },
  { value: "동영상", description: "동영상 탭" },
  { value: "방송", description: "동영상 탭" },
];
const ENGLISH_LANGUAGE_OPERATOR_VALUES = [
  { value: "ko", description: "한국어" },
  { value: "en", description: "영어" },
  { value: "ja", description: "일본어" },
  { value: "zh", description: "중국어" },
  { value: "ru", description: "러시아어" },
  { value: "es", description: "스페인어" },
  { value: "fr", description: "프랑스어" },
  { value: "ar", description: "아랍어" },
  { value: "de", description: "독일어" },
];
const KOREAN_LANGUAGE_OPERATOR_VALUES = [
  { value: "한국어", description: "한국어" },
  { value: "영어", description: "영어" },
  { value: "일본어", description: "일본어" },
  { value: "중국어", description: "중국어" },
  { value: "러시아어", description: "러시아어" },
  { value: "스페인어", description: "스페인어" },
  { value: "프랑스어", description: "프랑스어" },
  { value: "아랍어", description: "아랍어" },
  { value: "독일어", description: "독일어" },
];
const DATE_OPERATOR_VALUES = [
  { value: "2025-06-01", description: "시작일" },
  { value: "2025-06-26", description: "준공식 보도일" },
  { value: "2025-06-30", description: "종료일" },
];
const DATE_RANGE_OPERATOR_VALUES = [
  { value: "2025-06-01..2025-06-30", description: "2025년 6월" },
  { value: "2025-06-26..2025-06-26", description: "준공식 보도일" },
];

export function getSearchSuggestions(query, { documents = [], sources = [], limit = 8 } = {}) {
  const normalized = normalizeQuery(query);
  if (!normalized.raw) return [];
  if (isStandaloneConsonantOnlySearch(normalized)) return [];

  const operatorSuggestions = getOperatorSearchSuggestions(query, { sources, limit });
  if (operatorSuggestions.length) return operatorSuggestions;

  return buildSuggestionEntries(documents, sources).map((entry, index) => {
    const score = getSuggestionScore(entry, normalized);
    return score > 0 ? { ...entry, score, index, highlightRanges: getHighlightRanges(entry.label, normalized) } : null;
  })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit);
}

export function getOperatorSearchSuggestions(query, { sources = [], limit = 8 } = {}) {
  const context = getOperatorSuggestionContext(query);
  if (!context) return [];

  return createOperatorSuggestionCandidates(context, sources)
    .map((candidate, index) => {
      const score = getOperatorSuggestionScore(candidate, context);
      return score > 0 ? createOperatorSuggestion(candidate, context, score, index) : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit);
}

function getOperatorSuggestionContext(query = "") {
  const text = String(query || "");
  const match = text.match(OPERATOR_SUGGESTION_PATTERN);
  if (!match) return null;

  const [rawMatch, leadingSpace, negation, rawOperator, doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted, bareValue] = match;
  const operator = String(rawOperator || "").toLocaleLowerCase("en-US");
  const kind = OPERATOR_KIND_BY_NAME.get(operator);
  if (!kind) return null;

  const operatorStart = match.index + String(leadingSpace || "").length;
  return {
    kind,
    text,
    prefix: text.slice(0, operatorStart),
    negation: negation || "",
    operator: rawOperator,
    operatorKey: `${negation || ""}${rawOperator}:`,
    partial: String(doubleQuoted ?? singleQuoted ?? curlyDoubleQuoted ?? curlySingleQuoted ?? bareValue ?? "").trim(),
    isKoreanOperator: KOREAN_OPERATOR_NAMES.has(operator),
  };
}

function createOperatorSuggestionCandidates(context, sources = []) {
  if (context.kind === "site") return createSiteOperatorSuggestionCandidates(sources);
  if (context.kind === "source") return createSourceOperatorSuggestionCandidates(sources);
  if (context.kind === "media") return context.isKoreanOperator ? KOREAN_MEDIA_OPERATOR_VALUES : ENGLISH_MEDIA_OPERATOR_VALUES;
  if (context.kind === "language") return context.isKoreanOperator ? KOREAN_LANGUAGE_OPERATOR_VALUES : ENGLISH_LANGUAGE_OPERATOR_VALUES;
  if (context.kind === "date_range") return DATE_RANGE_OPERATOR_VALUES;
  if (context.kind === "date_start" || context.kind === "date_end") return DATE_OPERATOR_VALUES;
  return [];
}

function createSiteOperatorSuggestionCandidates(sources = []) {
  const candidates = new Map();
  const kpSources = sources.filter((source) => getSourceHost(source).endsWith(".kp"));
  if (kpSources.length) {
    candidates.set("kp", {
      value: "kp",
      description: `.kp 전체 · ${kpSources.length}개 자료원`,
    });
  }

  for (const source of sources) {
    const host = getSourceHost(source);
    if (!host || candidates.has(host)) continue;
    candidates.set(host, {
      value: host,
      description: [source.name, SOURCE_TYPE_LABELS[source.sourceType] || "자료원"].filter(Boolean).join(" · "),
      sourceId: source.id || "",
      sourceName: source.name || "",
      sourceType: source.sourceType || "",
      aliases: [source.name, source.id, ...(source.aliases || [])].filter(Boolean),
    });
  }

  return [...candidates.values()];
}

function createSourceOperatorSuggestionCandidates(sources = []) {
  return sources.map((source) => ({
    value: source.name,
    description: SOURCE_TYPE_LABELS[source.sourceType] || "자료원",
    sourceId: source.id || "",
    sourceName: source.name || "",
    sourceType: source.sourceType || "",
    aliases: [source.id, source.baseUrl, getSourceHost(source), ...(source.aliases || [])].filter(Boolean),
    quoteValue: true,
  }));
}

function getOperatorSuggestionScore(candidate = {}, context = {}) {
  const rawPartial = String(context.partial || "").trim();
  if (!rawPartial) return 100 - getOperatorCandidatePenalty(candidate, context);

  const aliases = [
    candidate.value,
    candidate.sourceName,
    ...(candidate.aliases || []),
  ].filter(Boolean);
  const scores = aliases.map((alias) => getStrictOperatorCompletionScore(alias, rawPartial));
  return Math.max(0, ...scores) - getOperatorCandidatePenalty(candidate, context);
}

function getStrictOperatorCompletionScore(value = "", partial = "") {
  const target = createSearchToken(value);
  const query = createSearchToken(partial);
  if (!target.compactLower || !query.compactLower) return 0;
  if (target.compactLower === query.compactLower || target.lower === query.lower) return 120;
  if (target.compactLower.startsWith(query.compactLower) || target.lower.startsWith(query.lower)) return 105;
  if (target.compactLower.includes(query.compactLower) || target.lower.includes(query.lower)) return 92;
  return 0;
}

function getOperatorCandidatePenalty(candidate = {}, context = {}) {
  if (context.kind === "site" && candidate.value === "kp") return 0;
  if (context.kind === "date_start" && candidate.value === "2025-06-01") return 0;
  if (context.kind === "date_end" && candidate.value === "2025-06-30") return 0;
  return 1;
}

function createOperatorSuggestion(candidate = {}, context = {}, score = 0, index = 0) {
  const operatorValue = formatOperatorSuggestionValue(candidate.value, {
    quoteValue: candidate.quoteValue,
  });
  const label = `${context.operatorKey}${operatorValue}`;
  const value = `${context.prefix}${label}`;
  return {
    id: `operator:${context.operator}:${candidate.value}`,
    label,
    value,
    type: "operator",
    sourceId: candidate.sourceId || "",
    sourceName: candidate.sourceName || "",
    sourceType: candidate.sourceType || "",
    description: candidate.description || "검색 연산자",
    score,
    index,
    highlightRanges: getOperatorSuggestionHighlightRanges(label, context),
  };
}

function formatOperatorSuggestionValue(value = "", { quoteValue = false } = {}) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!quoteValue || !/\s/.test(text)) return text;
  return `"${text.replace(/"/g, "\\\"")}"`;
}

function getOperatorSuggestionHighlightRanges(label = "", context = {}) {
  const partial = String(context.partial || "").trim().toLocaleLowerCase("ko-KR");
  if (!partial) return [];

  const lowerLabel = String(label || "").toLocaleLowerCase("ko-KR");
  const index = lowerLabel.indexOf(partial);
  return index >= 0 ? [{ start: index, end: index + partial.length }] : [];
}

function getSourceHost(source = {}) {
  const value = String(source.baseUrl || "").trim();
  if (!value) return "";
  try {
    return new URL(value).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  } catch {
    return value.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].toLocaleLowerCase("en-US").replace(/^www\./, "");
  }
}

function getSuggestionScore(entry, normalized) {
  if (entry.type === "document_title") return getStrictIndexedTitleScore(entry.label, normalized);
  return Math.max(
    getSearchScore(entry.label, normalized),
    ...entry.aliases.map((alias) => getSearchScore(alias, normalized) - 8),
  );
}

function getStrictIndexedTitleScore(label, normalized) {
  const target = createSearchToken(label);
  let bestScore = 0;

  for (const variant of normalized.variants) {
    if (!variant.compactLower) continue;

    if (target.compactLower === variant.compactLower || target.lower === variant.lower) {
      bestScore = Math.max(bestScore, 120);
    }
    if (target.compactLower.startsWith(variant.compactLower)) {
      bestScore = Math.max(bestScore, 105);
    }
    if (target.compactLower.includes(variant.compactLower) || target.lower.includes(variant.lower)) {
      bestScore = Math.max(bestScore, 92);
    }
    if (!variant.isStandaloneConsonantOnly && containsCompatibilityJamo(variant.original) && target.disassembled.includes(variant.disassembled)) {
      bestScore = Math.max(bestScore, 104);
    }
  }

  return bestScore;
}

function containsCompatibilityJamo(value = "") {
  return /[ㄱ-ㅎㅏ-ㅣ]/.test(String(value));
}

export function buildSuggestionEntries(documents = [], sources = []) {
  const entries = new Map();

  for (const entity of getKnownEntitySuggestionEntries()) addSuggestionEntry(entries, entity);
  for (const source of sources) {
    addSuggestionEntry(entries, {
      id: `source:${source.id || source.name}`,
      label: source.name,
      aliases: source.aliases || [],
      type: "source",
      sourceId: source.id || "",
      sourceName: source.name,
      sourceType: source.sourceType || "",
      description: SOURCE_TYPE_LABELS[source.sourceType] || "자료원",
    });
  }
  for (const document of documents) {
    addSuggestionEntry(entries, {
      id: `title:${document.id}`,
      label: document.title,
      aliases: [],
      type: "document_title",
      sourceId: document.sourceId || "",
      sourceName: document.sourceName || "",
      sourceType: document.sourceType || "",
      mediaType: document.mediaType || "",
      documentId: document.id || "",
      description: [document.sourceName, MEDIA_TYPE_LABELS[document.mediaType] || "자료"].filter(Boolean).join(" · "),
    });
  }

  return [...entries.values()];
}

function addSuggestionEntry(entries, entry) {
  const label = String(entry.label || "").trim();
  if (!label || entries.has(label)) return;
  entries.set(label, {
    ...entry,
    label,
    aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
    description: String(entry.description || getSuggestionTypeLabel(entry.type)).trim(),
  });
}

function getSuggestionTypeLabel(type = "") {
  if (type === "entity") return "추천어";
  if (type === "source") return "자료원";
  if (type === "document_title") return "색인 문서";
  return "";
}

function getHighlightRanges(label, normalized) {
  const lowerLabel = label.toLocaleLowerCase("ko-KR");
  for (const variant of normalized.variants) {
    const needle = getVisibleHighlightNeedle(variant);
    if (!needle) continue;
    const index = lowerLabel.indexOf(needle);
    if (index >= 0) return [{ start: index, end: index + needle.length }];
  }
  return [];
}

function getVisibleHighlightNeedle(variant = {}) {
  const original = String(variant.original || variant.raw || "").trim().toLocaleLowerCase("ko-KR");
  const leadingText = original.match(/^[^\u3131-\u318e]+/u)?.[0] || "";
  if (leadingText) return leadingText.replace(/\s+/g, "");
  if (variant.isStandaloneConsonantOnly || containsCompatibilityJamo(original)) return "";
  return variant.compactLower || variant.lower || "";
}
