import { createSearchToken } from "./normalizeQuery.js?v=search-20260803-6";
import { SOURCE_BY_ID } from "./sourceConfig.js?v=search-20260803-6";

export function resolveExactSourceQuery(query = "") {
  const queryToken = createSearchToken(String(query || "").trim());
  if (!queryToken.compactLower) return null;

  for (const source of Object.values(SOURCE_BY_ID)) {
    const sourceLabels = [source.name, ...(source.aliases || [])];
    if (sourceLabels.some((label) => createSearchToken(label).compactLower === queryToken.compactLower)) {
      return source;
    }
  }

  return null;
}

export function isExactSourceDocumentMatch(document = {}, source = null) {
  return Boolean(source?.id && document?.sourceId === source.id);
}
