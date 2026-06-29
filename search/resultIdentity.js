const COLLAPSIBLE_MEDIA_TYPES = new Set(["article", "pdf", "broadcast"]);

export function collapseDuplicateResults(results = []) {
  const seen = new Set();
  const collapsed = [];

  for (const result of results) {
    const key = createResultStoryKey(result);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    collapsed.push(result);
  }

  return collapsed;
}

export function dedupeDocumentsByStory(documents = []) {
  const output = [];
  const idIndex = new Map();
  const storyIndex = new Map();

  for (const document of documents) {
    if (!document) continue;

    const id = String(document.id || "");
    if (id && idIndex.has(id)) {
      const index = idIndex.get(id);
      output[index] = choosePreferredDocument(output[index], document);
      continue;
    }

    const storyKey = createResultStoryKey(document);
    if (storyKey && storyIndex.has(storyKey)) {
      const index = storyIndex.get(storyKey);
      const preferred = choosePreferredDocument(output[index], document);
      output[index] = preferred;
      if (preferred.id && !idIndex.has(preferred.id)) idIndex.set(preferred.id, index);
      continue;
    }

    const index = output.length;
    output.push(document);
    if (id) idIndex.set(id, index);
    if (storyKey) storyIndex.set(storyKey, index);
  }

  return output;
}

export function createResultStoryKey(result = {}) {
  if (!COLLAPSIBLE_MEDIA_TYPES.has(result.mediaType)) return "";
  const titleKey = normalizeStoryText(result.title || "");
  if (!titleKey) return "";
  const dateKey = shouldCollapseAcrossDates(result) ? "" : normalizeStoryDate(result.date);
  return [
    result.displaySourceId || result.sourceId || result.sourceName || "",
    result.mediaType || "",
    dateKey,
    titleKey,
  ].join("|");
}

function shouldCollapseAcrossDates(result = {}) {
  return result.sourceId === "kcna-watch";
}

function normalizeStoryDate(value = "") {
  const date = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function normalizeStoryText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/\(\s*\d{4}\s*[./년-]\s*\d{1,2}\s*[./월-]\s*\d{1,2}\s*일?\s*\)$/g, "")
    .replace(/[^\p{L}\p{N}가-힣]+/gu, "")
    .trim();
}

function choosePreferredDocument(left = {}, right = {}) {
  const leftScore = getDocumentQualityScore(left);
  const rightScore = getDocumentQualityScore(right);
  if (rightScore !== leftScore) return rightScore > leftScore ? right : left;

  const rightDate = normalizeStoryDate(right.date);
  const leftDate = normalizeStoryDate(left.date);
  if (rightDate !== leftDate) return rightDate > leftDate ? right : left;

  return left;
}

function getDocumentQualityScore(document = {}) {
  const title = String(document.title || "");
  const snippet = String(document.snippet || "");
  const body = String(document.body || "");
  const text = `${title} ${snippet} ${body}`;
  const bodyLength = body.trim().length;
  const snippetLength = snippet.trim().length;
  const chromePenalty = /\b(?:Browse|KCNA Watch Logo)\b|Upgrade to NK PRO/i.test(text) || isVoiceOfKoreaChromeText(text) ? 2000 : 0;
  const titlePenalty = /^[·•]/.test(title.trim()) ? 80 : 0;

  return Math.min(bodyLength, 1800)
    + Math.min(snippetLength, 420)
    + (normalizeStoryDate(document.date) ? 40 : 0)
    - chromePenalty
    - titlePenalty;
}

function isVoiceOfKoreaChromeText(text = "") {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return /vok\s+첫페지로\s+어종선택/i.test(normalized)
    || /어종선택\s+Deutsch\s+Русский/i.test(normalized)
    || /《조선의 소리》조선어방송편집부\s+www\.vok\.rep\.kp\s*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized)
    || /(?:Voice of Korea|English Language Service).*Languages.*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized)
    || /Languages.*English Language Service.*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized);
}
