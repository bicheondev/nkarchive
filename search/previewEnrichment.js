import { createDocumentPresentation } from "./documentSearch.js?v=search-20260823-8";

const PREVIEW_CORPUS_INDEXES = new WeakMap();

export function enrichSearchResultPreviews(results = [], corpus = [], query = "") {
  if (!Array.isArray(results) || !results.length) return results;
  if (!Array.isArray(corpus) || !corpus.length) return results;

  return results.map((result) => {
    if (!isWeakDocumentPreview(result)) return result;
    const previewRecord = findRicherPreviewRecord(result, corpus);
    if (!previewRecord) return result;

    const previewText = cleanIndexedPreviewText(previewRecord.body || previewRecord.snippet || "");
    const presentation = createDocumentPresentation({
      ...result,
      snippet: "",
      body: previewText,
    }, query);
    const displaySnippet = presentation.displaySnippet || "";
    if (!displaySnippet || isWeakPreviewText(displaySnippet, result.title)) return result;

    return {
      ...result,
      displaySnippet,
      highlightRanges: {
        ...result.highlightRanges,
        snippet: presentation.highlightRanges?.snippet || [],
      },
      previewSourceName: previewRecord.sourceName || "",
      previewDocumentId: previewRecord.id || "",
    };
  });
}

export function findRicherPreviewRecord(record = {}, corpus = []) {
  if (!isWeakDocumentPreview(record)) return null;

  return getPreviewCandidates(record, corpus)
    .filter((candidate) => candidate?.id && candidate.id !== record.id)
    .filter((candidate) => isSameStoryCandidate(record, candidate))
    .filter((candidate) => !isWeakDocumentPreview(candidate))
    .sort((left, right) => getPreviewSelectionScore(record, right) - getPreviewSelectionScore(record, left))[0] || null;
}

function getPreviewCandidates(record = {}, corpus = []) {
  if (!Array.isArray(corpus) || !corpus.length) return [];

  const index = getPreviewCorpusIndex(corpus);
  const mediaType = String(record.mediaType || "");
  if (!record.date) return index.byMediaType.get(mediaType) || [];

  const sameDate = index.byMediaTypeAndDate.get(createPreviewBucketKey(mediaType, record.date)) || [];
  const undated = index.undatedByMediaType.get(mediaType) || [];
  if (!undated.length) return sameDate;
  return [...sameDate, ...undated];
}

function getPreviewCorpusIndex(corpus) {
  const cached = PREVIEW_CORPUS_INDEXES.get(corpus);
  if (cached) return cached;

  const index = {
    byMediaType: new Map(),
    byMediaTypeAndDate: new Map(),
    undatedByMediaType: new Map(),
  };

  for (const candidate of corpus) {
    const mediaType = String(candidate?.mediaType || "");
    appendPreviewBucket(index.byMediaType, mediaType, candidate);
    if (candidate?.date) {
      appendPreviewBucket(index.byMediaTypeAndDate, createPreviewBucketKey(mediaType, candidate.date), candidate);
    } else {
      appendPreviewBucket(index.undatedByMediaType, mediaType, candidate);
    }
  }

  PREVIEW_CORPUS_INDEXES.set(corpus, index);
  return index;
}

function appendPreviewBucket(buckets, key, candidate) {
  const bucket = buckets.get(key);
  if (bucket) {
    bucket.push(candidate);
    return;
  }
  buckets.set(key, [candidate]);
}

function createPreviewBucketKey(mediaType, date) {
  return `${mediaType}\u0000${date}`;
}

export function isWeakDocumentPreview(record = {}) {
  if (record.mediaType !== "article" && record.mediaType !== "broadcast") return false;
  return isWeakPreviewText(record.body || record.snippet || "", record.title);
}

function isSameStoryCandidate(record = {}, candidate = {}) {
  if (record.date && candidate.date && record.date !== candidate.date) return false;
  const recordTitle = normalizeStoryTitle(record.title);
  const candidateTitle = normalizeStoryTitle(candidate.title);
  if (!recordTitle || !candidateTitle) return false;
  return recordTitle === candidateTitle
    || recordTitle.includes(candidateTitle)
    || candidateTitle.includes(recordTitle)
    || hasStrongStoryTokenOverlap(record.title, candidate.title);
}

function isWeakPreviewText(text = "", title = "") {
  const normalizedText = cleanPreviewInlineText(text);
  const normalizedTitle = cleanPreviewInlineText(title);
  if (!normalizedText) return true;
  if (isVoiceOfKoreaChromeText(normalizedText)) return true;
  if (normalizedText.length >= 420) return false;
  if (isLikelyTruncatedArchivePreview(normalizedText, normalizedTitle)) return true;

  const withoutTitle = normalizedTitle
    ? cleanPreviewInlineText(normalizedText.replaceAll(normalizedTitle, ""))
    : normalizedText;
  const withoutDate = withoutTitle
    .replace(/\d{4}[.\-/년]\s*\d{1,2}[.\-/월]\s*\d{1,2}\s*일?/g, "")
    .replace(/\[\s*\d{4}[.\-/년]\s*\d{1,2}[.\-/월]\s*\d{1,2}\s*일?\s*\]/g, "")
    .trim();
  return normalizedText.length < 80 || withoutDate.length < 36;
}

function isLikelyTruncatedArchivePreview(normalizedText = "", normalizedTitle = "") {
  if (!normalizedTitle || normalizedText.length >= 300) return false;
  if (!normalizedText.startsWith(normalizedTitle)) return false;
  if (hasSentenceEnding(normalizedText)) return false;
  const withoutTitle = cleanPreviewInlineText(normalizedText.replaceAll(normalizedTitle, ""));
  return withoutTitle.length < 220;
}

function hasSentenceEnding(text = "") {
  return /(?:[.!?。！？]|다|였다|하였다|되였다|밝혔다|있다|없다|한다|했다)\s*$/u.test(String(text || "").trim());
}

function getPreviewTextLength(record = {}) {
  return cleanPreviewInlineText(cleanIndexedPreviewText(record.body || record.snippet || "")).length;
}

function getPreviewQualityScore(record = {}) {
  const rawText = String(record.body || record.snippet || "");
  const cleanedText = cleanIndexedPreviewText(rawText);
  const markdownPenalty = (rawText.match(/!?\[[^\]]*]\([^)]+\)/g) || []).length * 220;
  const navigationPenalty = /첫페지|언어선택|혁명활동소식|분야별기사/.test(cleanedText.slice(0, 120)) ? 180 : 0;
  const chromePenalty = isVoiceOfKoreaChromeText(cleanedText) ? 2000 : 0;
  return getPreviewTextLength(record) - markdownPenalty - navigationPenalty - chromePenalty;
}

function getPreviewSelectionScore(record = {}, candidate = {}) {
  return getPreviewQualityScore(candidate) + getPreviewSourceAffinityScore(record, candidate);
}

function getPreviewSourceAffinityScore(record = {}, candidate = {}) {
  const preferredSourceId = String(record.displaySourceId || "").trim();
  if (!preferredSourceId || preferredSourceId === "kcna-watch") return 0;
  return candidate.sourceId === preferredSourceId ? 10000 : 0;
}

function cleanIndexedPreviewText(text = "") {
  return String(text || "")
    .replace(/!\[([^\]]*)]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]*)]\([^)]+\)/g, "$1")
    .replace(/^\s*\/\s*/gm, "")
    .replace(/^(혁명활동소식|분야별기사|정치|경제|문화|국제|기사)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStoryTitle(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/김정은(?:총비서|위원장|국무위원장|최고령도자|원수님)?/g, "김정은")
    .replace(/총비서|위원장|국무위원장|최고령도자/g, "")
    .replace(/께서|께서는|동지|동지께서|동지께서는/g, "")
    .replace(/원수님/g, "")
    .replace(/[^\p{L}\p{N}가-힣]+/gu, "")
    .toLocaleLowerCase("ko-KR");
}

const STORY_TOKEN_STOPWORDS = new Set([
  "2025년",
  "2026년",
  "우리",
  "나라",
  "조선",
  "진행",
  "소식",
  "기사",
  "기념사진",
]);

function hasStrongStoryTokenOverlap(recordTitle = "", candidateTitle = "") {
  const recordTokens = createStoryTokenSet(recordTitle);
  const candidateTokens = createStoryTokenSet(candidateTitle);
  const smallerSize = Math.min(recordTokens.size, candidateTokens.size);
  if (smallerSize < 3) return false;

  const overlap = [...recordTokens].filter((token) => candidateTokens.has(token));
  const overlapRatio = overlap.length / smallerSize;
  const hasDistinctiveOverlap = overlap.some((token) => token.length >= 5);
  if (smallerSize === 3) {
    return overlap.length === 3 && hasDistinctiveOverlap;
  }
  if (overlap.length >= 3 && overlapRatio >= 0.75 && hasDistinctiveOverlap) {
    return true;
  }
  return overlap.length >= 4 && overlapRatio >= 0.58 && hasDistinctiveOverlap;
}

function createStoryTokenSet(value = "") {
  return new Set(String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/김정은\s*(?:동지|원수님)/g, "김정은")
    .replace(/총비서\s*동지|경애하는|존경하는|동지께서는|동지께서|동지/g, " ")
    .replace(/(\d+)\s*살\s*(?:미만|이하)/g, "$1살")
    .replace(/조선\s*선수들/g, "선수들")
    .split(/[^\p{L}\p{N}가-힣]+/gu)
    .map((token) => {
      const normalizedToken = token
        .replace(/김정은(?:총비서|위원장|국무위원장|최고령도자|원수님)?(?:께서|께서는)?$/u, "김정은")
        .replace(/(?:께서|께서는|동지께서|동지께서는|동지|총비서|위원장|국무위원장|최고령도자|원수님)$/u, "")
        .trim();
      if (normalizedToken === "김정은") return normalizedToken;
      return normalizedToken
        .replace(/(?:에서|으로|에게|들을|들이|에는|에도|와|과|의|을|를|은|는|이|가)$/u, "")
        .trim();
    })
    .filter((token) => token.length >= 2 && !STORY_TOKEN_STOPWORDS.has(token)));
}

function cleanPreviewInlineText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function isVoiceOfKoreaChromeText(text = "") {
  const normalized = cleanPreviewInlineText(text);
  if (!normalized) return false;
  return /vok\s+첫페지로\s+어종선택/i.test(normalized)
    || /어종선택\s+Deutsch\s+Русский/i.test(normalized)
    || /《조선의 소리》조선어방송편집부\s+www\.vok\.rep\.kp\s*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized)
    || /(?:Voice of Korea|English Language Service).*Languages.*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized)
    || /Languages.*English Language Service.*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized);
}
