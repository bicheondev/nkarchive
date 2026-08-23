import { createSearchToken, normalizeQuery } from "./normalizeQuery.js?v=search-20260823-7";
import { getResolvedEntitySearchTerms, resolveKnownEntityDocumentQuery, resolveKnownEntityQuery, shouldUseResolvedEntityForDocumentSearch } from "./knownEntities.js?v=search-20260823-7";
import { isExactSourceDocumentMatch, resolveExactSourceQuery } from "./sourceQuery.js?v=search-20260823-7";

export const DOCUMENT_MINIMUM_SCORE = 100;
export const BODY_SEARCH_CHARACTER_LIMIT = 1400;
export const RESULT_SNIPPET_LENGTH = 190;

export const DOCUMENT_SCORE = Object.freeze({
  exactTitle: 1000,
  titleContains: 780,
  snippetContains: 620,
  bodyContains: 520,
  datelineContains: 180,
  aliasExact: 540,
  aliasContains: 420,
  sourceExact: 920,
  sourceContains: 120,
  urlContains: 360,
});

const MEDIA_TYPE_PRIORITY = {
  article: 1,
  pdf: 2,
  image: 3,
  video: 4,
  broadcast: 5,
};

const INTEGRATED_MEDIA_SCORE_BOOST = {
  article: 260,
  pdf: 180,
  broadcast: 120,
  image: 0,
  video: 0,
};

const TITLE_SCOPED_OPERATORS = ["intitle", "title", "제목"];
const ALL_TITLE_SCOPED_OPERATORS = ["allintitle", "alltitle", "전체제목"];
const TEXT_SCOPED_OPERATORS = ["intext", "text", "body", "본문", "내용"];
const ALL_TEXT_SCOPED_OPERATORS = ["allintext", "alltext", "전체본문", "전체내용"];
const URL_SCOPED_OPERATORS = ["inurl", "url", "주소"];
const ALL_URL_SCOPED_OPERATORS = ["allinurl", "allurl", "전체주소"];

export function searchDocuments(documents, query, options = {}) {
  const preparedQuery = prepareDocumentQuery(query);
  if (!hasPreparedDocumentQuery(preparedQuery)) return [];

  const mediaTypes = normalizeList(options.mediaTypes);
  const minimumScore = Number.isFinite(Number(options.minimumScore))
    ? Number(options.minimumScore)
    : DOCUMENT_MINIMUM_SCORE;

  return documents
    .filter((document) => !mediaTypes.length || mediaTypes.includes(document.mediaType))
    .map((document) => {
      const score = scoreDocument(document, preparedQuery);
      const adjustedScore = adjustDocumentScoreForContext(score.value, document, options);
      return score.value >= minimumScore
        ? {
            ...document,
            score: adjustedScore,
            baseScore: score.value,
            scoreReason: adjustedScore === score.value
              ? score.reason
              : `${score.reason}+integrated:${document.mediaType}`,
            resolvedQuery: preparedQuery.resolvedEntity?.canonical || "",
            ...createDocumentPresentation(document, preparedQuery),
          }
        : null;
    })
    .filter(Boolean)
    .sort(sortDocumentResults);
}

export function scoreDocument(document, preparedQueryOrText) {
  const preparedQuery = typeof preparedQueryOrText === "string"
    ? prepareDocumentQuery(preparedQueryOrText)
    : preparedQueryOrText;
  if (documentMatchesExcludedTerms(document, preparedQuery)) {
    return { value: 0, reason: "exclude:match" };
  }
  if (preparedQuery.alternatives?.length) {
    return scoreAlternativeDocumentQuery(document, preparedQuery);
  }
  if (!documentMatchesUrlRequirements(document, preparedQuery)) {
    return { value: 0, reason: "url_required:no_match" };
  }
  if (!documentMatchesTitleRequirements(document, preparedQuery)) {
    return { value: 0, reason: "title_required:no_match" };
  }
  if (!documentMatchesTextRequirements(document, preparedQuery)) {
    return { value: 0, reason: "text_required:no_match" };
  }
  if (hasOnlyUrlRequirements(preparedQuery)) {
    return scoreUrlRequirements(document, preparedQuery);
  }
  if (isExactSourceDocumentMatch(document, preparedQuery.exactSource)) {
    return { value: DOCUMENT_SCORE.sourceExact, reason: "sourceName:exact" };
  }
  if (preparedQuery.exactPhrases?.length) {
    const exactPhraseScore = scoreExactPhraseRequirements(document, preparedQuery);
    if (exactPhraseScore.value <= 0) return exactPhraseScore;
    if (preparedQuery.requiredTermGroups?.length > 1) {
      const requiredTermScore = scoreRequiredTermGroups(document, preparedQuery);
      if (requiredTermScore.value <= 0) return requiredTermScore;
      return exactPhraseScore.value > requiredTermScore.value
        ? exactPhraseScore
        : { ...requiredTermScore, reason: `${requiredTermScore.reason}+phrase_required` };
    }
    return exactPhraseScore;
  }
  if (preparedQuery.requiredTermGroups?.length > 1) {
    return scoreRequiredTermGroups(document, preparedQuery);
  }

  const scores = [];

  for (const term of preparedQuery.terms) {
    scores.push(scoreIndexedTextField(document, "title", document.title, term, DOCUMENT_SCORE.exactTitle, DOCUMENT_SCORE.titleContains, "title"));
    scores.push(scoreSnippetField(document.snippet, term, document.searchFields?.snippet));
    scores.push(scoreBodyField(document.body, term, document.searchFields?.body));
    scores.push(scoreAliases(document.aliases || [], term, document.searchFields?.aliases));
    scores.push(scoreIndexedTextField(document, "sourceName", document.sourceName, term, DOCUMENT_SCORE.sourceExact, DOCUMENT_SCORE.sourceContains, "sourceName"));
    scores.push(scoreIndexedTextField(document, "displaySourceName", document.displaySourceName, term, DOCUMENT_SCORE.sourceExact, DOCUMENT_SCORE.sourceContains, "displaySourceName"));
  }

  return scores.reduce((best, next) => (next.value > best.value ? next : best), { value: 0, reason: "no_match" });
}

export function prepareDocumentQuery(query) {
  const syntaxQuery = createDocumentSyntaxQuery(query);
  const excludedTerms = syntaxQuery.exclusions
    .filter(isUsableDocumentTerm)
    .map((exclusion) => createDocumentTerm(exclusion, "exclude"));
  const excludedTitleTerms = syntaxQuery.titleExclusions
    .filter(isUsableDocumentTerm)
    .map((exclusion) => createDocumentTerm(exclusion, "exclude_title"));
  const excludedTextTerms = syntaxQuery.textExclusions
    .filter(isUsableDocumentTerm)
    .map((exclusion) => createDocumentTerm(exclusion, "exclude_text"));
  const excludedUrlTerms = syntaxQuery.urlExclusions
    .filter(isUsableDocumentTerm)
    .map((exclusion) => createDocumentTerm(exclusion, "exclude_url"));
  const exclusionTerms = {
    excludedTerms,
    excludedTitleTerms,
    excludedTextTerms,
    excludedUrlTerms,
  };
  const alternatives = syntaxQuery.alternatives
    .map((alternative) => prepareDocumentBranchQuery(alternative, exclusionTerms))
    .filter(hasPreparedDocumentQuery);

  if (alternatives.length > 1) {
    const normalized = normalizeQuery(syntaxQuery.searchableQuery);
    return {
      raw: normalized.raw,
      terms: dedupeTerms(alternatives.flatMap((alternative) => alternative.terms || [])),
      exactPhrases: dedupeTerms(alternatives.flatMap((alternative) => alternative.exactPhrases || [])),
      titleTerms: dedupeTerms(alternatives.flatMap((alternative) => alternative.titleTerms || [])),
      textTerms: dedupeTerms(alternatives.flatMap((alternative) => alternative.textTerms || [])),
      urlTerms: dedupeTerms(alternatives.flatMap((alternative) => alternative.urlTerms || [])),
      excludedTerms: dedupeTerms(excludedTerms),
      excludedTitleTerms: dedupeTerms(excludedTitleTerms),
      excludedTextTerms: dedupeTerms(excludedTextTerms),
      excludedUrlTerms: dedupeTerms(excludedUrlTerms),
      requiredTermGroups: [],
      resolvedEntity: null,
      exactSource: resolveExactSourceQuery(normalized.raw),
      alternatives,
    };
  }

  if (alternatives.length === 1) return alternatives[0];
  return createEmptyPreparedDocumentQuery(exclusionTerms);
}

function prepareDocumentBranchQuery(syntaxQuery, exclusionTerms = {}) {
  const normalizedExclusionTerms = normalizePreparedExclusionTerms(exclusionTerms);
  const normalized = normalizeQuery(syntaxQuery.searchableQuery);
  const urlTerms = syntaxQuery.urlRequirements
    .filter(isUsableDocumentTerm)
    .map((requirement) => createDocumentTerm(requirement, "url"));
  if (!normalized.raw && !urlTerms.length) return createEmptyPreparedDocumentQuery(normalizedExclusionTerms);
  const rawToken = createSearchToken(normalized.raw);
  const resolvedEntity = resolveKnownEntityQuery(syntaxQuery.searchableQuery);
  const resolvedDocumentQuery = resolveKnownEntityDocumentQuery(syntaxQuery.searchableQuery);
  const requiredTermQuery = resolvedDocumentQuery ? normalizeQuery(resolvedDocumentQuery) : normalized;
  const exactSource = resolveExactSourceQuery(normalized.raw);
  const exactPhrases = syntaxQuery.phrases
    .filter(isUsableDocumentTerm)
    .map((phrase) => createDocumentTerm(phrase, "exact_phrase"));
  const titleTerms = syntaxQuery.titleRequirements
    .filter(isUsableDocumentTerm)
    .map((requirement) => createDocumentTerm(requirement, "title"));
  const textTerms = syntaxQuery.textRequirements
    .filter(isUsableDocumentTerm)
    .map((requirement) => createDocumentTerm(requirement, "text"));
  const terms = [];
  const requiredTermGroups = [];

  if (!rawToken.isStandaloneConsonantOnly && isUsableDocumentTerm(normalized.raw)) {
    terms.push(createDocumentTerm(normalized.raw, "raw"));
  }
  if (normalized.qwerty !== normalized.raw && isUsableDocumentTerm(normalized.qwerty)) {
    terms.push(createDocumentTerm(normalized.qwerty, "qwerty"));
  }
  if (shouldUseResolvedEntityForDocumentSearch(normalized.raw, resolvedEntity)) {
    for (const entityTerm of getResolvedEntitySearchTerms(resolvedEntity)) {
      terms.push(createDocumentTerm(entityTerm, "known_entity"));
    }
  }
  terms.push(...titleTerms);
  terms.push(...textTerms);
  terms.push(...exactPhrases);
  requiredTermGroups.push(...createRequiredTermGroups(requiredTermQuery, resolvedEntity));
  for (const group of requiredTermGroups) terms.push(...group);

  return {
    raw: normalized.raw,
    terms: dedupeTerms(terms),
    exactPhrases: dedupeTerms(exactPhrases),
    titleTerms: dedupeTerms(titleTerms),
    textTerms: dedupeTerms(textTerms),
    urlTerms: dedupeTerms(urlTerms),
    ...dedupePreparedExclusionTerms(normalizedExclusionTerms),
    requiredTermGroups: dedupeTermGroups(requiredTermGroups),
    resolvedEntity,
    exactSource,
  };
}

export function getDocumentSearchTextQuery(query = "") {
  return createDocumentSyntaxQuery(query).backendSearchableQuery;
}

export function getDocumentSearchTextQueries(query = "") {
  const syntaxQuery = createDocumentSyntaxQuery(query);
  return [...new Set(
    syntaxQuery.alternatives
      .map((alternative) => alternative.backendSearchableQuery)
      .filter(Boolean),
  )];
}

export function hasExactPhraseQuery(queryOrPrepared = "") {
  const preparedQuery = typeof queryOrPrepared === "string"
    ? prepareDocumentQuery(queryOrPrepared)
    : queryOrPrepared;
  return Boolean(preparedQuery?.exactPhrases?.length);
}

export function filterDocumentsForExactPhraseQuery(documents = [], queryOrPrepared = "") {
  const preparedQuery = typeof queryOrPrepared === "string"
    ? prepareDocumentQuery(queryOrPrepared)
    : queryOrPrepared;
  if (!preparedQuery.exactPhrases?.length) return documents;
  if (preparedQuery.alternatives?.length) {
    return documents.filter((document) => scoreDocument(document, preparedQuery).value > 0);
  }
  return documents.filter((document) => scoreExactPhraseRequirements(document, preparedQuery).value > 0);
}

export function hasExcludedTermQuery(queryOrPrepared = "") {
  const preparedQuery = typeof queryOrPrepared === "string"
    ? prepareDocumentQuery(queryOrPrepared)
    : queryOrPrepared;
  return Boolean(
    preparedQuery?.excludedTerms?.length
      || preparedQuery?.excludedTitleTerms?.length
      || preparedQuery?.excludedTextTerms?.length
      || preparedQuery?.excludedUrlTerms?.length,
  );
}

export function hasPositiveDocumentQuery(queryOrPrepared = "") {
  const preparedQuery = typeof queryOrPrepared === "string"
    ? prepareDocumentQuery(queryOrPrepared)
    : queryOrPrepared;
  return hasPreparedDocumentQuery(preparedQuery);
}

export function filterDocumentsForExcludedTerms(documents = [], queryOrPrepared = "") {
  const preparedQuery = typeof queryOrPrepared === "string"
    ? prepareDocumentQuery(queryOrPrepared)
    : queryOrPrepared;
  if (!hasExcludedTermQuery(preparedQuery)) return documents;
  return documents.filter((document) => !documentMatchesExcludedTerms(document, preparedQuery));
}

export function hasTitleQuery(queryOrPrepared = "") {
  const preparedQuery = typeof queryOrPrepared === "string"
    ? prepareDocumentQuery(queryOrPrepared)
    : queryOrPrepared;
  return Boolean(preparedQuery?.titleTerms?.length);
}

export function filterDocumentsForTitleQuery(documents = [], queryOrPrepared = "") {
  const preparedQuery = typeof queryOrPrepared === "string"
    ? prepareDocumentQuery(queryOrPrepared)
    : queryOrPrepared;
  if (!preparedQuery.titleTerms?.length) return documents;
  return documents.filter((document) => scoreDocument(document, preparedQuery).value > 0);
}

export function hasTextQuery(queryOrPrepared = "") {
  const preparedQuery = typeof queryOrPrepared === "string"
    ? prepareDocumentQuery(queryOrPrepared)
    : queryOrPrepared;
  return Boolean(preparedQuery?.textTerms?.length);
}

export function filterDocumentsForTextQuery(documents = [], queryOrPrepared = "") {
  const preparedQuery = typeof queryOrPrepared === "string"
    ? prepareDocumentQuery(queryOrPrepared)
    : queryOrPrepared;
  if (!preparedQuery.textTerms?.length) return documents;
  return documents.filter((document) => scoreDocument(document, preparedQuery).value > 0);
}

export function hasUrlQuery(queryOrPrepared = "") {
  const preparedQuery = typeof queryOrPrepared === "string"
    ? prepareDocumentQuery(queryOrPrepared)
    : queryOrPrepared;
  return Boolean(preparedQuery?.urlTerms?.length);
}

export function filterDocumentsForUrlQuery(documents = [], queryOrPrepared = "") {
  const preparedQuery = typeof queryOrPrepared === "string"
    ? prepareDocumentQuery(queryOrPrepared)
    : queryOrPrepared;
  if (!preparedQuery.urlTerms?.length) return documents;
  return documents.filter((document) => scoreDocument(document, preparedQuery).value > 0);
}

export function hasAlternativeQuery(queryOrPrepared = "") {
  const preparedQuery = typeof queryOrPrepared === "string"
    ? prepareDocumentQuery(queryOrPrepared)
    : queryOrPrepared;
  return Boolean(preparedQuery?.alternatives?.length);
}

export function createDocumentPresentation(document, preparedQueryOrText) {
  const preparedQuery = typeof preparedQueryOrText === "string"
    ? prepareDocumentQuery(preparedQueryOrText)
    : preparedQueryOrText;
  const displaySnippet = chooseDisplaySnippet(document, preparedQuery);

  return {
    displaySnippet,
    highlightRanges: {
      title: getHighlightRanges(document.title || "", preparedQuery),
      snippet: getHighlightRanges(displaySnippet, preparedQuery),
    },
  };
}

export function getHighlightRanges(text = "", preparedQueryOrText) {
  const preparedQuery = typeof preparedQueryOrText === "string"
    ? prepareDocumentQuery(preparedQueryOrText)
    : preparedQueryOrText;
  const ranges = [];

  for (const term of preparedQuery.terms || []) {
    const range = findFirstTokenRange(text, term.token);
    if (range) ranges.push(range);
  }

  return dedupeRanges(ranges).slice(0, 4);
}

function scoreTextField(text, term, exactScore, containsScore, reason, indexedField = null) {
  const field = indexedField || createSearchToken(text || "");
  if (!field.compactLower || !term.token.compactLower) return { value: 0, reason: "no_match" };

  if (exactScore > 0 && (field.compactLower === term.token.compactLower || field.lower === term.token.lower)) {
    return { value: exactScore, reason: `${reason}:exact` };
  }
  if (containsScore > 0 && (field.compactLower.includes(term.token.compactLower) || field.lower.includes(term.token.lower))) {
    return { value: containsScore, reason: `${reason}:contains` };
  }
  return { value: 0, reason: "no_match" };
}

function scoreIndexedTextField(document, fieldName, text, term, exactScore, containsScore, reason) {
  return scoreTextField(text, term, exactScore, containsScore, reason, document.searchFields?.[fieldName]);
}

function scoreAliases(aliases, term, indexedAliases = []) {
  let best = { value: 0, reason: "no_match" };
  for (let index = 0; index < aliases.length; index += 1) {
    const score = scoreTextField(aliases[index], term, DOCUMENT_SCORE.aliasExact, DOCUMENT_SCORE.aliasContains, "alias", indexedAliases[index]);
    if (score.value > best.value) best = score;
  }
  return best;
}

function scoreSnippetField(text, term, indexedField = null) {
  const searchableText = stripSearchDatelines(text);
  const score = scoreTextField(searchableText, term, 0, DOCUMENT_SCORE.snippetContains, "snippet", indexedField);
  if (score.value > 0 && isDatelineOnlyMatch(searchableText, term)) {
    return { value: DOCUMENT_SCORE.datelineContains, reason: "snippet:dateline" };
  }
  return score;
}

function scoreBodyField(body, term, indexedField = null) {
  const focusedBody = getSearchableBodyText(body);
  const score = scoreTextField(focusedBody, term, 0, DOCUMENT_SCORE.bodyContains, "body", indexedField);
  if (score.value > 0 && isDatelineOnlyMatch(focusedBody, term)) {
    return { value: DOCUMENT_SCORE.datelineContains, reason: "body:dateline" };
  }
  return score;
}

function scoreExactPhraseRequirements(document, preparedQuery) {
  const scores = [];
  for (const phrase of preparedQuery.exactPhrases || []) {
    const score = scoreExactPhraseAcrossFields(document, phrase);
    if (score.value <= 0) return { value: 0, reason: "phrase:no_match" };
    scores.push(score);
  }

  const averageScore = Math.round(scores.reduce((sum, score) => sum + score.value, 0) / scores.length);
  const coverageBonus = Math.min(160, Math.max(0, scores.length - 1) * 60);
  return {
    value: averageScore + coverageBonus,
    reason: `phrase:${scores.map((score) => score.reason).join("+")}`,
  };
}

function scoreExactPhraseAcrossFields(document, term) {
  const scores = [
    scoreIndexedTextField(document, "title", document.title, term, DOCUMENT_SCORE.exactTitle, DOCUMENT_SCORE.titleContains, "title"),
    scoreSnippetField(document.snippet, term, document.searchFields?.snippet),
    scoreBodyField(document.body, term, document.searchFields?.body),
    scoreAliases(document.aliases || [], term, document.searchFields?.aliases),
    scoreIndexedTextField(document, "sourceName", document.sourceName, term, DOCUMENT_SCORE.sourceExact, DOCUMENT_SCORE.sourceContains, "sourceName"),
    scoreIndexedTextField(document, "displaySourceName", document.displaySourceName, term, DOCUMENT_SCORE.sourceExact, DOCUMENT_SCORE.sourceContains, "displaySourceName"),
  ];
  return scores.reduce((best, next) => (next.value > best.value ? next : best), { value: 0, reason: "no_match" });
}

function documentMatchesExcludedTerms(document = {}, preparedQuery = {}) {
  const matchesGenericExclusion = (preparedQuery.excludedTerms || []).some((term) => {
    return documentContainsSearchToken(document, term, [
      document.title,
      document.snippet,
      document.body,
      ...(Array.isArray(document.aliases) ? document.aliases : []),
      document.sourceName,
      document.displaySourceName,
    ], ["title", "snippet", "body", "aliases", "sourceName", "displaySourceName"]);
  });
  if (matchesGenericExclusion) return true;
  if ((preparedQuery.excludedTitleTerms || []).some((term) => (
    documentContainsSearchToken(document, term, [document.title], ["title"])
  ))) return true;
  if ((preparedQuery.excludedTextTerms || []).some((term) => documentContainsSearchToken(document, term, [document.title, document.snippet, document.body], ["title", "snippet", "body"]))) return true;
  if ((preparedQuery.excludedUrlTerms || []).some((term) => scoreUrlFields(document, term).value > 0)) return true;
  return false;
}

function documentContainsSearchToken(document = {}, term = {}, fields = [], indexedFieldNames = []) {
  const token = term?.token || createSearchToken(term?.value || term || "");
  if (!token.compactLower) return false;
  const indexedFields = indexedFieldNames.flatMap((fieldName) => {
    const field = document.searchFields?.[fieldName];
    return Array.isArray(field) ? field : (field ? [field] : []);
  });
  const fieldTokens = indexedFields.length
    ? indexedFields
    : fields.map((field) => createSearchToken(String(field || "")));
  return fieldTokens.some((fieldToken) => {
    if (!fieldToken.compactLower) return false;
    return fieldToken.compactLower.includes(token.compactLower)
      || fieldToken.lower.includes(token.lower);
  });
}

function documentMatchesTitleRequirements(document = {}, preparedQuery = {}) {
  const titleTerms = preparedQuery.titleTerms || [];
  if (!titleTerms.length) return true;
  return titleTerms.every((term) => (
    scoreIndexedTextField(document, "title", document.title, term, DOCUMENT_SCORE.exactTitle, DOCUMENT_SCORE.titleContains, "title").value > 0
  ));
}

function documentMatchesTextRequirements(document = {}, preparedQuery = {}) {
  const textTerms = preparedQuery.textTerms || [];
  if (!textTerms.length) return true;
  return textTerms.every((term) => scoreDocumentTextFields(document, term).value > 0);
}

function documentMatchesUrlRequirements(document = {}, preparedQuery = {}) {
  const urlTerms = preparedQuery.urlTerms || [];
  if (!urlTerms.length) return true;
  return urlTerms.every((term) => scoreUrlFields(document, term).value > 0);
}

function scoreUrlRequirements(document = {}, preparedQuery = {}) {
  const scores = (preparedQuery.urlTerms || []).map((term) => scoreUrlFields(document, term));
  if (!scores.length || scores.some((score) => score.value <= 0)) return { value: 0, reason: "url_required:no_match" };
  const averageScore = Math.round(scores.reduce((sum, score) => sum + score.value, 0) / scores.length);
  return {
    value: averageScore,
    reason: `url:${scores.map((score) => score.reason).join("+")}`,
  };
}

function scoreUrlFields(document = {}, term) {
  return [
    scoreTextField(document.url, term, 0, DOCUMENT_SCORE.urlContains, "url"),
    scoreTextField(document.archiveUrl, term, 0, DOCUMENT_SCORE.urlContains, "archiveUrl"),
    scoreTextField(document.cachedUrl, term, 0, DOCUMENT_SCORE.urlContains, "cachedUrl"),
    scoreTextField(document.thumbnailUrl, term, 0, DOCUMENT_SCORE.urlContains, "thumbnailUrl"),
    scoreTextField(document.cachedThumbnailUrl, term, 0, DOCUMENT_SCORE.urlContains, "cachedThumbnailUrl"),
  ].reduce((best, next) => (next.value > best.value ? next : best), { value: 0, reason: "no_match" });
}

function scoreDocumentTextFields(document = {}, term) {
  return [
    scoreSnippetField(document.snippet, term, document.searchFields?.snippet),
    scoreBodyField(document.body, term, document.searchFields?.body),
    scoreTextField(document.searchSnippet, term, 0, DOCUMENT_SCORE.snippetContains, "searchSnippet"),
    scoreTextField(document.searchBody, term, 0, DOCUMENT_SCORE.bodyContains, "searchBody"),
    scoreTextField(document.previewText, term, 0, DOCUMENT_SCORE.bodyContains, "previewText"),
  ].reduce((best, next) => (next.value > best.value ? next : best), { value: 0, reason: "no_match" });
}

function hasOnlyUrlRequirements(preparedQuery = {}) {
  return Boolean(preparedQuery.urlTerms?.length)
    && !preparedQuery.requiredTermGroups?.length
    && !preparedQuery.exactPhrases?.length
    && (preparedQuery.terms || []).every((term) => term.source === "url");
}

function scoreAlternativeDocumentQuery(document, preparedQuery) {
  let best = { value: 0, reason: "or:no_match" };
  for (const alternative of preparedQuery.alternatives || []) {
    const score = scoreDocument(document, { ...alternative, excludedTerms: [] });
    if (score.value > best.value) {
      best = {
        ...score,
        reason: `or:${score.reason}`,
      };
    }
  }
  return best;
}

function scoreRequiredTermGroups(document, preparedQuery) {
  const groupScores = [];

  for (const group of preparedQuery.requiredTermGroups) {
    const scores = group.flatMap((term) => scoreDocumentTermAcrossFields(document, term));
    const best = scores.reduce((currentBest, next) => (next.value > currentBest.value ? next : currentBest), { value: 0, reason: "no_match" });
    if (best.value <= 0) return { value: 0, reason: "multi:no_match" };
    groupScores.push(best);
  }

  const phraseScore = scorePhraseTerms(document, preparedQuery.terms.filter((term) => term.source !== "split"));
  const averageScore = Math.round(groupScores.reduce((sum, score) => sum + score.value, 0) / groupScores.length);
  const coverageBonus = Math.min(220, (groupScores.length - 1) * 80);
  const multiScore = {
    value: averageScore + coverageBonus,
    reason: `multi:${groupScores.map((score) => score.reason).join("+")}`,
  };

  return phraseScore.value > multiScore.value
    ? { ...phraseScore, reason: `${phraseScore.reason}+multi_exact` }
    : multiScore;
}

function scorePhraseTerms(document, terms = []) {
  const scores = terms.flatMap((term) => scoreDocumentTermAcrossFields(document, term));
  return scores.reduce((best, next) => (next.value > best.value ? next : best), { value: 0, reason: "no_match" });
}

function scoreDocumentTermAcrossFields(document, term) {
  return [
    scoreIndexedTextField(document, "title", document.title, term, DOCUMENT_SCORE.exactTitle, DOCUMENT_SCORE.titleContains, "title"),
    scoreSnippetField(document.snippet, term, document.searchFields?.snippet),
    scoreBodyField(document.body, term, document.searchFields?.body),
    scoreAliases(document.aliases || [], term, document.searchFields?.aliases),
    scoreIndexedTextField(document, "sourceName", document.sourceName, term, DOCUMENT_SCORE.sourceExact, DOCUMENT_SCORE.sourceContains, "sourceName"),
    scoreIndexedTextField(document, "displaySourceName", document.displaySourceName, term, DOCUMENT_SCORE.sourceExact, DOCUMENT_SCORE.sourceContains, "displaySourceName"),
  ];
}

function createRequiredTermGroups(normalized, resolvedEntity) {
  if (shouldUseResolvedEntityForDocumentSearch(normalized.raw, resolvedEntity) && splitDocumentQueryParts(normalized.raw).length <= 1) {
    return [getResolvedEntitySearchTerms(resolvedEntity)
      .map((term) => createDocumentTerm(term, "known_entity"))];
  }

  const splitSource = chooseSplitQuerySource(normalized);
  const parts = splitDocumentQueryParts(splitSource);
  if (parts.length <= 1) return [];

  return parts
    .map((part) => createDocumentTerm(part, "split"))
    .filter((term) => isUsableDocumentTerm(term.value))
    .map((term) => [term]);
}

function chooseSplitQuerySource(normalized) {
  const raw = String(normalized.raw || "");
  const qwerty = String(normalized.qwerty || "");
  if (
    qwerty !== raw
    && containsHangulSyllable(qwerty)
    && !containsHangulSyllable(raw)
    && !looksLikeNaturalLatinQuery(raw)
  ) {
    return qwerty;
  }
  return raw;
}

function looksLikeNaturalLatinQuery(value = "") {
  const text = String(value || "").trim();
  if (!/^[\p{Script=Latin}0-9\s'"’.-]+$/u.test(text)) return false;
  const letters = Array.from(text).filter((char) => /\p{Script=Latin}/u.test(char));
  if (letters.length < 4) return false;
  const vowels = letters.filter((char) => /[aeiou]/i.test(char)).length;
  return vowels / letters.length >= 0.2;
}

function splitDocumentQueryParts(value = "") {
  return String(value)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function createDocumentSyntaxQuery(query = "") {
  const raw = String(query || "");
  const exclusions = [];
  const titleExclusions = [];
  const textExclusions = [];
  const urlExclusions = [];
  const branchQueries = expandDocumentOrBranches(raw);
  const normalizedBranchQueries = (branchQueries.length ? branchQueries : [raw])
    .map((branch) => cleanDocumentOrBranchBoundary(branch, {
      isAlternativeBranch: branchQueries.length > 1,
    }))
    .filter(Boolean);
  const withoutExclusionBranches = normalizedBranchQueries.map((branch) => {
    const withoutScopedExclusions = extractNegativeScopedOperators(branch, {
      titleExclusions,
      textExclusions,
      urlExclusions,
    });
    const withoutNotOperators = normalizeGoogleNotOperators(withoutScopedExclusions);
    return extractGenericExclusions(withoutNotOperators, exclusions);
  });
  const alternatives = withoutExclusionBranches
    .map(createDocumentSyntaxBranch)
    .filter(hasDocumentSyntaxBranchQuery);
  const normalizedAlternatives = alternatives.length ? alternatives : [createDocumentSyntaxBranch(withoutExclusionBranches.join(" "))];
  const phrases = normalizedAlternatives.flatMap((alternative) => alternative.phrases);
  const titleRequirements = normalizedAlternatives.flatMap((alternative) => alternative.titleRequirements);
  const textRequirements = normalizedAlternatives.flatMap((alternative) => alternative.textRequirements);
  const urlRequirements = normalizedAlternatives.flatMap((alternative) => alternative.urlRequirements);

  return {
    searchableQuery: normalizedAlternatives.map((alternative) => alternative.searchableQuery).join(" ").replace(/\s+/g, " ").trim(),
    backendSearchableQuery: normalizedAlternatives.map((alternative) => alternative.backendSearchableQuery).join(" ").replace(/\s+/g, " ").trim(),
    phrases: [...new Set(phrases)],
    titleRequirements: [...new Set(titleRequirements)],
    textRequirements: [...new Set(textRequirements)],
    urlRequirements: [...new Set(urlRequirements)],
    exclusions: [...new Set(exclusions)],
    titleExclusions: [...new Set(titleExclusions)],
    textExclusions: [...new Set(textExclusions)],
    urlExclusions: [...new Set(urlExclusions)],
    alternatives: normalizedAlternatives,
  };
}

function hasDocumentSyntaxBranchQuery(branch = {}) {
  return Boolean(branch.searchableQuery || branch.textRequirements?.length || branch.urlRequirements?.length);
}

function createDocumentSyntaxBranch(query = "") {
  const phrases = [];
  const titleRequirements = [];
  const textRequirements = [];
  const urlRequirements = [];
  const withoutAllTitleOperators = extractAllTitleOperators(query, titleRequirements);
  const withoutTitleOperators = extractTitleOperators(withoutAllTitleOperators, titleRequirements);
  const withoutAllTextOperators = extractAllTextOperators(withoutTitleOperators, textRequirements);
  const withoutTextOperators = extractTextOperators(withoutAllTextOperators, textRequirements);
  const withoutAllUrlOperators = extractAllUrlOperators(withoutTextOperators, urlRequirements);
  const withoutUrlOperators = extractUrlOperators(withoutAllUrlOperators, urlRequirements);
  const withoutRequiredOperators = normalizeGoogleRequiredOperators(withoutUrlOperators);
  const searchableQuery = withoutRequiredOperators.replace(/"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’/gu, (match, doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted) => {
    const phrase = [doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted]
      .find((value) => String(value || "").trim());
    const normalizedPhrase = String(phrase || "").replace(/\s+/g, " ").trim();
    if (normalizedPhrase) phrases.push(normalizedPhrase);
    return normalizedPhrase ? ` ${normalizedPhrase} ` : " ";
  }).replace(/["'“”‘’]/gu, " ");

  const normalizedSearchableQuery = searchableQuery.replace(/\s+/g, " ").trim();
  return {
    searchableQuery: normalizedSearchableQuery,
    backendSearchableQuery: [normalizedSearchableQuery, ...urlRequirements].join(" ").replace(/\s+/g, " ").trim(),
    phrases: [...new Set(phrases)],
    titleRequirements: [...new Set(titleRequirements)],
    textRequirements: [...new Set(textRequirements)],
    urlRequirements: [...new Set(urlRequirements)],
  };
}

function extractGenericExclusions(query = "", exclusions = []) {
  return String(query || "").replace(/(^|\s)-(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’|([^\s]+))/gu, (match, leadingSpace, doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted, bareValue) => {
    const exclusion = [doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted, bareValue]
      .find((value) => String(value || "").trim());
    const normalizedExclusion = String(exclusion || "").replace(/\s+/g, " ").trim();
    if (!normalizedExclusion) return match;
    exclusions.push(normalizedExclusion);
    return leadingSpace || " ";
  });
}

function extractNegativeScopedOperators(query = "", {
  titleExclusions = [],
  textExclusions = [],
  urlExclusions = [],
} = {}) {
  const withoutAllTitleOperators = extractAllNegativeScopedOperators(query, ALL_TITLE_SCOPED_OPERATORS, titleExclusions);
  const withoutTitleOperators = extractNegativeScopedOperator(withoutAllTitleOperators, TITLE_SCOPED_OPERATORS, titleExclusions);
  const withoutAllTextOperators = extractAllNegativeScopedOperators(withoutTitleOperators, ALL_TEXT_SCOPED_OPERATORS, textExclusions);
  const withoutTextOperators = extractNegativeScopedOperator(withoutAllTextOperators, TEXT_SCOPED_OPERATORS, textExclusions);
  const withoutAllUrlOperators = extractAllNegativeScopedOperators(withoutTextOperators, ALL_URL_SCOPED_OPERATORS, urlExclusions);
  return extractNegativeScopedOperator(withoutAllUrlOperators, URL_SCOPED_OPERATORS, urlExclusions);
}

function extractNegativeScopedOperator(query = "", operatorNames = [], exclusions = []) {
  const operatorPattern = operatorNames
    .map((name) => escapeRegExp(name))
    .join("|");
  return String(query || "").replace(new RegExp(`(^|\\s)-(?:${operatorPattern}):(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’|(\\S+))`, "giu"), (match, leadingSpace, doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted, bareValue) => {
    const exclusion = [doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted, bareValue]
      .find((value) => String(value || "").trim());
    const normalizedExclusion = String(exclusion || "").replace(/\s+/g, " ").trim();
    if (!normalizedExclusion) return match;
    exclusions.push(normalizedExclusion);
    return leadingSpace || " ";
  });
}

function extractAllNegativeScopedOperators(query = "", operatorNames = [], exclusions = []) {
  const text = String(query || "");
  const operatorPattern = operatorNames
    .map((name) => escapeRegExp(name))
    .join("|");
  const match = new RegExp(`(^|\\s)-(?:${operatorPattern}):`, "iu").exec(text);
  if (!match) return text;

  const tailStart = match.index + match[0].length;
  const scopedTerms = splitScopedOperatorTerms(text.slice(tailStart));
  if (!scopedTerms.length) return text;
  exclusions.push(...scopedTerms);
  return `${text.slice(0, match.index)}${match[1] || ""} `;
}

function normalizeGoogleRequiredOperators(query = "") {
  return transformUnquotedSegments(query, (segment) => segment
    .replace(/(^|\s)\+(?=\S)/gu, "$1")
    .replace(/(^|\s)\+\s*$/gu, "$1")
    .replace(/(^|\s)(?:AND|&&)(?=\s|$)/gu, "$1 "));
}

function normalizeGoogleNotOperators(query = "") {
  let output = "";
  let closingQuote = "";
  const text = String(query || "");

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (closingQuote) {
      output += char;
      if (char === closingQuote) closingQuote = "";
      continue;
    }

    const quoteEnd = getClosingQuote(char);
    if (quoteEnd) {
      closingQuote = quoteEnd;
      output += char;
      continue;
    }

    if (isNotOperatorAt(text, index)) {
      let nextIndex = index + 3;
      while (nextIndex < text.length && /\s/u.test(text[nextIndex])) nextIndex += 1;
      if (nextIndex < text.length) {
        output += "-";
        index = nextIndex - 1;
        continue;
      }
    }

    output += char;
  }

  return output;
}

function extractAllTitleOperators(query = "", titleRequirements = []) {
  return extractAllScopedOperators(query, ALL_TITLE_SCOPED_OPERATORS, titleRequirements, { keepTermsInSearchableQuery: true });
}

function extractTitleOperators(query = "", titleRequirements = []) {
  const operatorPattern = TITLE_SCOPED_OPERATORS
    .map((name) => escapeRegExp(name))
    .join("|");
  return String(query || "").replace(new RegExp(`(^|\\s)(?:${operatorPattern}):(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’|(\\S+))`, "giu"), (match, leadingSpace, doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted, bareValue) => {
    const requirement = [doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted, bareValue]
      .find((value) => String(value || "").trim());
    const normalizedRequirement = String(requirement || "").replace(/\s+/g, " ").trim();
    if (!normalizedRequirement) return match;
    titleRequirements.push(normalizedRequirement);
    return `${leadingSpace || " "}${normalizedRequirement} `;
  });
}

function extractAllTextOperators(query = "", textRequirements = []) {
  return extractAllScopedOperators(query, ALL_TEXT_SCOPED_OPERATORS, textRequirements, { keepTermsInSearchableQuery: true });
}

function extractTextOperators(query = "", textRequirements = []) {
  const operatorPattern = TEXT_SCOPED_OPERATORS
    .map((name) => escapeRegExp(name))
    .join("|");
  return String(query || "").replace(new RegExp(`(^|\\s)(?:${operatorPattern}):(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’|(\\S+))`, "giu"), (match, leadingSpace, doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted, bareValue) => {
    const requirement = [doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted, bareValue]
      .find((value) => String(value || "").trim());
    const normalizedRequirement = String(requirement || "").replace(/\s+/g, " ").trim();
    if (!normalizedRequirement) return match;
    textRequirements.push(normalizedRequirement);
    return `${leadingSpace || " "}${normalizedRequirement} `;
  });
}

function extractAllUrlOperators(query = "", urlRequirements = []) {
  return extractAllScopedOperators(query, ALL_URL_SCOPED_OPERATORS, urlRequirements, { keepTermsInSearchableQuery: false });
}

function extractUrlOperators(query = "", urlRequirements = []) {
  const operatorPattern = URL_SCOPED_OPERATORS
    .map((name) => escapeRegExp(name))
    .join("|");
  return String(query || "").replace(new RegExp(`(^|\\s)(?:${operatorPattern}):(?:"([^"]+)"|'([^']+)'|“([^”]+)”|‘([^’]+)’|(\\S+))`, "giu"), (match, leadingSpace, doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted, bareValue) => {
    const requirement = [doubleQuoted, singleQuoted, curlyDoubleQuoted, curlySingleQuoted, bareValue]
      .find((value) => String(value || "").trim());
    const normalizedRequirement = String(requirement || "").replace(/\s+/g, " ").trim();
    if (!normalizedRequirement) return match;
    urlRequirements.push(normalizedRequirement);
    return leadingSpace || " ";
  });
}

function extractAllScopedOperators(query = "", operatorNames = [], requirements = [], options = {}) {
  const text = String(query || "");
  const operatorPattern = operatorNames
    .map((name) => escapeRegExp(name))
    .join("|");
  const match = new RegExp(`(^|\\s)(?:${operatorPattern}):`, "iu").exec(text);
  if (!match) return text;

  const tailStart = match.index + match[0].length;
  const tail = text.slice(tailStart);
  const scopedTerms = splitScopedOperatorTerms(tail);
  if (!scopedTerms.length) return text;
  requirements.push(...scopedTerms);

  const prefix = `${text.slice(0, match.index)}${match[1] || ""}`;
  const searchableTail = options.keepTermsInSearchableQuery ? tail : "";
  return `${prefix}${searchableTail ? ` ${searchableTail}` : " "}`;
}

function splitScopedOperatorTerms(value = "") {
  const terms = [];
  let current = "";
  let closingQuote = "";
  const text = String(value || "");

  const pushCurrent = () => {
    const normalized = current.replace(/\s+/g, " ").trim();
    if (normalized) terms.push(normalized);
    current = "";
  };

  for (const char of text) {
    if (closingQuote) {
      if (char === closingQuote) {
        pushCurrent();
        closingQuote = "";
      } else {
        current += char;
      }
      continue;
    }

    const quoteEnd = getClosingQuote(char);
    if (quoteEnd) {
      pushCurrent();
      closingQuote = quoteEnd;
      continue;
    }

    if (/\s/u.test(char)) {
      pushCurrent();
      continue;
    }

    current += char;
  }

  pushCurrent();
  return terms;
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

function splitDocumentOrBranches(value = "") {
  const branches = [];
  let current = "";
  let closingQuote = "";
  let parenthesisDepth = 0;
  const text = String(value || "");

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (closingQuote) {
      current += char;
      if (char === closingQuote) closingQuote = "";
      continue;
    }

    const quoteEnd = getClosingQuote(char);
    if (quoteEnd) {
      closingQuote = quoteEnd;
      current += char;
      continue;
    }

    if (char === "(") {
      parenthesisDepth += 1;
      current += char;
      continue;
    }

    if (char === ")") {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      current += char;
      continue;
    }

    if (parenthesisDepth === 0 && char === "|") {
      branches.push(current);
      current = "";
      continue;
    }

    if (parenthesisDepth === 0 && isOrOperatorAt(text, index)) {
      branches.push(current);
      current = "";
      index += 1;
      continue;
    }

    current += char;
  }

  branches.push(current);
  return branches.map((branch) => branch.trim()).filter(Boolean);
}

function expandDocumentOrBranches(value = "") {
  const expanded = expandFirstParenthesizedDocumentOrGroup(value);
  if (expanded.length > 1) {
    return expanded.flatMap((branch) => expandDocumentOrBranches(branch));
  }
  return splitDocumentOrBranches(value);
}

function expandFirstParenthesizedDocumentOrGroup(value = "") {
  const text = String(value || "");
  let closingQuote = "";
  let parenthesisDepth = 0;
  let groupStart = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (closingQuote) {
      if (char === closingQuote) closingQuote = "";
      continue;
    }

    const quoteEnd = getClosingQuote(char);
    if (quoteEnd) {
      closingQuote = quoteEnd;
      continue;
    }

    if (char === "(") {
      if (parenthesisDepth === 0) groupStart = index;
      parenthesisDepth += 1;
      continue;
    }

    if (char !== ")" || parenthesisDepth === 0) continue;

    parenthesisDepth -= 1;
    if (parenthesisDepth !== 0 || groupStart < 0) continue;

    const inner = text.slice(groupStart + 1, index);
    const innerBranches = splitDocumentOrBranches(inner);
    if (innerBranches.length > 1) {
      const prefix = text.slice(0, groupStart);
      const suffix = text.slice(index + 1);
      return innerBranches.map((branch) => [prefix, branch, suffix]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim());
    }

    groupStart = -1;
  }

  return [];
}

function cleanDocumentOrBranchBoundary(value = "", { isAlternativeBranch = false } = {}) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";

  if (isAlternativeBranch) {
    for (let index = 0; index < 8; index += 1) {
      const balance = getDocumentParenthesisBalance(text);
      if (balance > 0 && text.startsWith("(")) {
        text = text.slice(1).trim();
        continue;
      }
      if (balance < 0 && text.endsWith(")")) {
        text = text.slice(0, -1).trim();
        continue;
      }
      break;
    }
  }

  return stripBalancedDocumentGroupingParentheses(text).replace(/\s+/g, " ").trim();
}

function stripBalancedDocumentGroupingParentheses(value = "") {
  let text = String(value || "").trim();
  for (let index = 0; index < 8; index += 1) {
    const stripped = stripSingleBalancedDocumentGroupingParentheses(text);
    if (stripped === text) break;
    text = stripped.trim();
  }
  return text;
}

function stripSingleBalancedDocumentGroupingParentheses(value = "") {
  const text = String(value || "").trim();
  if (!text.startsWith("(") || !text.endsWith(")")) return text;

  let closingQuote = "";
  let parenthesisDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (closingQuote) {
      if (char === closingQuote) closingQuote = "";
      continue;
    }

    const quoteEnd = getClosingQuote(char);
    if (quoteEnd) {
      closingQuote = quoteEnd;
      continue;
    }

    if (char === "(") {
      parenthesisDepth += 1;
      continue;
    }

    if (char !== ")") continue;
    parenthesisDepth -= 1;
    if (parenthesisDepth < 0) return text;
    if (parenthesisDepth === 0 && index < text.length - 1) return text;
  }

  return parenthesisDepth === 0 ? text.slice(1, -1).trim() : text;
}

function getDocumentParenthesisBalance(value = "") {
  let closingQuote = "";
  let balance = 0;
  for (const char of String(value || "")) {
    if (closingQuote) {
      if (char === closingQuote) closingQuote = "";
      continue;
    }

    const quoteEnd = getClosingQuote(char);
    if (quoteEnd) {
      closingQuote = quoteEnd;
      continue;
    }

    if (char === "(") balance += 1;
    if (char === ")") balance -= 1;
  }
  return balance;
}

function getClosingQuote(char = "") {
  if (char === "\"") return "\"";
  if (char === "'") return "'";
  if (char === "“") return "”";
  if (char === "‘") return "’";
  return "";
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isOrOperatorAt(value = "", index = 0) {
  if (!/^or$/i.test(value.slice(index, index + 2))) return false;
  const previous = index > 0 ? value[index - 1] : "";
  const next = index + 2 < value.length ? value[index + 2] : "";
  return (!previous || /\s/u.test(previous)) && (!next || /\s/u.test(next));
}

function isNotOperatorAt(value = "", index = 0) {
  if (value.slice(index, index + 3) !== "NOT") return false;
  const previous = index > 0 ? value[index - 1] : "";
  const next = index + 3 < value.length ? value[index + 3] : "";
  return (!previous || /\s/u.test(previous)) && (!next || /\s/u.test(next));
}

function normalizePreparedExclusionTerms(exclusionTerms = {}) {
  if (Array.isArray(exclusionTerms)) {
    return {
      excludedTerms: exclusionTerms,
      excludedTitleTerms: [],
      excludedTextTerms: [],
      excludedUrlTerms: [],
    };
  }
  return {
    excludedTerms: Array.isArray(exclusionTerms.excludedTerms) ? exclusionTerms.excludedTerms : [],
    excludedTitleTerms: Array.isArray(exclusionTerms.excludedTitleTerms) ? exclusionTerms.excludedTitleTerms : [],
    excludedTextTerms: Array.isArray(exclusionTerms.excludedTextTerms) ? exclusionTerms.excludedTextTerms : [],
    excludedUrlTerms: Array.isArray(exclusionTerms.excludedUrlTerms) ? exclusionTerms.excludedUrlTerms : [],
  };
}

function dedupePreparedExclusionTerms(exclusionTerms = {}) {
  const normalized = normalizePreparedExclusionTerms(exclusionTerms);
  return {
    excludedTerms: dedupeTerms(normalized.excludedTerms),
    excludedTitleTerms: dedupeTerms(normalized.excludedTitleTerms),
    excludedTextTerms: dedupeTerms(normalized.excludedTextTerms),
    excludedUrlTerms: dedupeTerms(normalized.excludedUrlTerms),
  };
}

function createEmptyPreparedDocumentQuery(exclusionTerms = {}) {
  const dedupedExclusionTerms = dedupePreparedExclusionTerms(exclusionTerms);
  return {
    raw: "",
    terms: [],
    exactPhrases: [],
    titleTerms: [],
    textTerms: [],
    urlTerms: [],
    ...dedupedExclusionTerms,
    requiredTermGroups: [],
    resolvedEntity: null,
    exactSource: null,
  };
}

function hasPreparedDocumentQuery(preparedQuery = {}) {
  return Boolean(
    preparedQuery.terms?.length
    || preparedQuery.requiredTermGroups?.length
    || preparedQuery.exactPhrases?.length
    || preparedQuery.titleTerms?.length
    || preparedQuery.textTerms?.length
    || preparedQuery.urlTerms?.length
    || preparedQuery.alternatives?.length,
  );
}

function createDocumentTerm(value, source) {
  return {
    value,
    source,
    token: createSearchToken(value),
  };
}

function isUsableDocumentTerm(value) {
  const token = createSearchToken(value);
  if (!token.compactLower) return false;
  if (/^[a-z0-9]+$/i.test(token.compactLower)) return token.compactLower.length >= 3;
  return token.compact.length >= 2;
}

function dedupeTerms(terms) {
  const seen = new Set();
  return terms.filter((term) => {
    if (!term.token.compactLower || seen.has(term.token.compactLower)) return false;
    seen.add(term.token.compactLower);
    return true;
  });
}

function dedupeTermGroups(groups) {
  const seen = new Set();
  const deduped = [];
  for (const group of groups) {
    const terms = dedupeTerms(group);
    const key = terms.map((term) => term.token.compactLower).join("|");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(terms);
  }
  return deduped;
}

function containsHangulSyllable(value = "") {
  return /[가-힣]/.test(String(value));
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function adjustDocumentScoreForContext(score, document, options = {}) {
  if (options.tab !== "all") return score;
  return score + (INTEGRATED_MEDIA_SCORE_BOOST[document.mediaType] || 0);
}

export function getSearchableSnippetText(snippet = "") {
  return stripSearchDatelines(snippet);
}

export function getSearchableBodyText(body = "") {
  return stripSearchDatelines(getFocusedBodySearchText(body));
}

function getFocusedBodySearchText(body = "") {
  const text = String(body || "");
  if (text.length <= BODY_SEARCH_CHARACTER_LIMIT * 1.25) return text;
  return text.slice(0, BODY_SEARCH_CHARACTER_LIMIT);
}

function isDatelineOnlyMatch(text = "", term) {
  const matchRanges = findDirectTokenRanges(text, term?.token);
  if (!matchRanges.length) return false;

  const datelineRanges = findKoreanDatelineRanges(text);
  if (!datelineRanges.length) return false;

  return matchRanges.every((match) => (
    datelineRanges.some((dateline) => match.start >= dateline.start && match.end <= dateline.end)
  ));
}

function findDirectTokenRanges(text = "", token) {
  const lowerText = String(text || "").toLocaleLowerCase("ko-KR");
  const needles = [
    token?.original,
    token?.simplified,
    token?.compact,
    token?.lower,
    token?.compactLower,
  ].map((value) => String(value || "").toLocaleLowerCase("ko-KR")).filter(Boolean);
  const ranges = [];

  for (const needle of [...new Set(needles)]) {
    let index = lowerText.indexOf(needle);
    while (index >= 0) {
      ranges.push({ start: index, end: index + needle.length });
      index = lowerText.indexOf(needle, index + needle.length);
    }
  }

  return dedupeRanges(ranges);
}

function findKoreanDatelineRanges(text = "") {
  const ranges = [];
  const patterns = [
    /[（(【][^）)】]{0,80}[\p{N}]{1,2}월\s*[\p{N}]{1,2}일발\s*조선중앙통신[^）)】]{0,40}[）)】]/gu,
    /(^|\n)\s*[가-힣]{2,16}\s*[\p{N}]{1,2}월\s*[\p{N}]{1,2}일발\s*조선중앙통신(?:\s*보도입니다)?[.。]?/gu,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(String(text || ""))) !== null) {
      const prefixLength = match[1]?.length || 0;
      ranges.push({
        start: match.index + prefixLength,
        end: match.index + match[0].length,
      });
    }
  }
  return dedupeRanges(ranges);
}

export function stripSearchDatelines(text = "") {
  const value = String(text || "");
  const ranges = findKoreanDatelineRanges(value);
  if (!ranges.length) return value;
  let cleaned = "";
  let cursor = 0;
  for (const range of ranges) {
    cleaned += value.slice(cursor, range.start);
    cursor = range.end;
  }
  cleaned += value.slice(cursor);
  return cleanInlineText(cleaned);
}

function chooseDisplaySnippet(document, preparedQuery) {
  const snippet = cleanDisplaySnippetText(getSearchableSnippetText(document.snippet || ""), document.title || "");
  const snippetRanges = getHighlightRanges(snippet, preparedQuery);
  if (snippetRanges.length) return createExcerpt(snippet, snippetRanges[0]);

  const body = cleanDisplaySnippetText(getSearchableBodyText(document.body || ""), document.title || "");
  if (body) {
    const bodyRanges = getHighlightRanges(body, preparedQuery);
    if (bodyRanges.length) return createExcerpt(body, bodyRanges[0]);
  }

  return snippet || createExcerpt(body, null);
}

function createExcerpt(text = "", firstRange = null) {
  const cleaned = cleanInlineText(text);
  if (cleaned.length <= RESULT_SNIPPET_LENGTH) return cleaned;

  const anchor = firstRange ? firstRange.start : 0;
  const halfWindow = Math.floor(RESULT_SNIPPET_LENGTH / 2);
  let start = Math.max(0, anchor - halfWindow);
  let end = Math.min(cleaned.length, start + RESULT_SNIPPET_LENGTH);
  start = Math.max(0, end - RESULT_SNIPPET_LENGTH);

  if (start > 0) {
    const nextSpace = cleaned.indexOf(" ", start);
    if (nextSpace > start && nextSpace < anchor) start = nextSpace + 1;
  }
  if (end < cleaned.length) {
    const previousSpace = cleaned.lastIndexOf(" ", end);
    if (previousSpace > anchor) end = previousSpace;
  }

  const prefix = start > 0 ? "... " : "";
  const suffix = end < cleaned.length ? " ..." : "";
  return `${prefix}${cleaned.slice(start, end).trim()}${suffix}`;
}

export function cleanDisplaySnippetText(text = "", title = "") {
  let cleaned = cleanInlineText(text);
  if (isVoiceOfKoreaChromeText(cleaned)) return "";
  cleaned = stripLeadingTitle(cleaned, title);
  cleaned = collapseEnglishDateSeparatedDuplicate(cleaned);
  cleaned = stripLeadingTitle(cleaned, title);
  cleaned = stripStandaloneDateSnippet(cleaned);
  if (isVoiceOfKoreaChromeText(cleaned)) return "";
  return cleanInlineText(cleaned);
}

function isVoiceOfKoreaChromeText(text = "") {
  const normalized = cleanInlineText(text);
  if (!normalized) return false;
  return /vok\s+첫페지로\s+어종선택/i.test(normalized)
    || /어종선택\s+Deutsch\s+Русский/i.test(normalized)
    || /《조선의 소리》조선어방송편집부\s+www\.vok\.rep\.kp\s*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized)
    || /(?:Voice of Korea|English Language Service).*Languages.*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized)
    || /Languages.*English Language Service.*E\s*mail:\s*vok@star[\s-]*co\.net\.kp/i.test(normalized);
}

function stripLeadingTitle(text = "", title = "") {
  const cleaned = cleanInlineText(text);
  const normalizedTitle = cleanInlineText(title);
  if (!cleaned || normalizedTitle.length < 8) return cleaned;
  if (cleaned === normalizedTitle) return "";
  if (cleaned.startsWith(`${normalizedTitle} `)) return cleaned.slice(normalizedTitle.length).trim();
  if (cleaned.startsWith(normalizedTitle)) {
    const next = cleaned.slice(normalizedTitle.length).trim();
    if (next.length >= 20) return next;
  }
  return cleaned;
}

function stripStandaloneDateSnippet(text = "") {
  const cleaned = cleanInlineText(text);
  const datePattern = /^(?:[\[(【]\s*)?\d{4}\s*(?:[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}|년\s*\d{1,2}\s*월\s*\d{1,2}\s*일?)\s*(?:[\])】.]|\.)?$/u;
  return datePattern.test(cleaned) ? "" : cleaned;
}

function collapseEnglishDateSeparatedDuplicate(text = "") {
  const cleaned = cleanInlineText(text);
  const datePattern = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i;
  const match = cleaned.match(datePattern);
  if (!match || match.index === undefined) return cleaned;

  const before = cleanInlineText(cleaned.slice(0, match.index));
  const after = cleanInlineText(cleaned.slice(match.index + match[0].length));
  if (!before) return after;
  if (!after) return before;
  if (isSubstantiallyRepeatedText(before, after)) return before.length <= after.length ? before : after;
  return cleanInlineText(`${before} ${after}`);
}

function isSubstantiallyRepeatedText(left = "", right = "") {
  const compactLeft = createComparisonText(left);
  const compactRight = createComparisonText(right);
  if (compactLeft.length < 20 || compactRight.length < 20) return false;
  return compactLeft === compactRight
    || compactLeft.startsWith(compactRight)
    || compactRight.startsWith(compactLeft);
}

function createComparisonText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}가-힣]+/gu, "")
    .toLocaleLowerCase("ko-KR");
}

function findFirstTokenRange(text = "", token) {
  if (!text || !token?.compactLower) return null;

  const directNeedles = [
    token.original,
    token.simplified,
    token.compact,
    token.lower,
    token.compactLower,
  ].map((value) => String(value || "").toLocaleLowerCase("ko-KR")).filter(Boolean);
  const lowerText = String(text).toLocaleLowerCase("ko-KR");

  for (const needle of [...new Set(directNeedles)].sort((left, right) => right.length - left.length)) {
    const index = lowerText.indexOf(needle);
    if (index >= 0) return { start: index, end: index + needle.length };
  }

  const compactMap = createCompactTextMap(text);
  const compactNeedle = token.compactLower;
  const compactIndex = compactMap.text.indexOf(compactNeedle);
  if (compactIndex < 0) return null;

  const start = compactMap.positions[compactIndex];
  const endPosition = compactMap.positions[compactIndex + Array.from(compactNeedle).length - 1];
  return Number.isFinite(start) && Number.isFinite(endPosition)
    ? { start, end: endPosition + 1 }
    : null;
}

function createCompactTextMap(text = "") {
  const chars = Array.from(String(text));
  const pieces = [];
  const positions = [];
  let offset = 0;

  for (const char of chars) {
    const length = char.length;
    const normalized = normalizeComparableChar(char);
    if (normalized) {
      pieces.push(normalized);
      positions.push(offset);
    }
    offset += length;
  }

  return {
    text: pieces.join("").toLocaleLowerCase("ko-KR"),
    positions,
  };
}

function normalizeComparableChar(char = "") {
  if (/[\s\p{P}\p{S}]/u.test(char)) return "";
  return char;
}

function dedupeRanges(ranges = []) {
  return ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce((merged, range) => {
      const previous = merged[merged.length - 1];
      if (!previous || range.start >= previous.end) {
        merged.push({ start: range.start, end: range.end });
      }
      return merged;
    }, []);
}

function cleanInlineText(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function sortDocumentResults(left, right) {
  return right.score - left.score
    || (MEDIA_TYPE_PRIORITY[left.mediaType] ?? 99) - (MEDIA_TYPE_PRIORITY[right.mediaType] ?? 99)
    || (left.displayOrder ?? 999) - (right.displayOrder ?? 999)
    || String(right.date).localeCompare(String(left.date));
}
