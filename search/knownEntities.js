import { createSearchToken, normalizeQuery } from "./normalizeQuery.js?v=search-20260629-1";

export const KNOWN_SEARCH_ENTITIES = [
  {
    id: "kim-jong-un",
    canonical: "김정은",
    aliases: ["김정은동지", "김정은 총비서", "총비서", "국무위원장", "Kim Jong Un"],
  },
  {
    id: "kcna",
    canonical: "조선중앙통신",
    aliases: ["KCNA", "Korean Central News Agency", "조선중앙통신사"],
  },
  {
    id: "rodong-sinmun",
    canonical: "노동신문",
    aliases: ["로동신문", "Rodong Sinmun"],
  },
  {
    id: "pyongyang",
    canonical: "평양",
    aliases: ["Pyongyang", "평양시", "수도 평양"],
  },
  {
    id: "wonsan-kalma",
    canonical: "원산갈마해안관광지구",
    aliases: [
      "원산갈마",
      "원산 갈마",
      "갈마해안관광지구",
      "갈마반도",
      "명사십리",
      "Wonsan",
      "Kalma",
      "Wonsan Kalma",
      "Wonsan Kalma Coastal Tourist Area",
      "Kalma Coastal Tourist Area",
    ],
  },
  {
    id: "kim-wonsan-kalma",
    canonical: "김정은 원산갈마해안관광지구",
    disablePartialCompletion: true,
    aliases: [
      "김정은 원산갈마",
      "김정은 원산갈마해안관광지구",
      "Kim Jong Un Wonsan",
      "Kim Jong Un Kalma",
      "Kim Jong Un Wonsan Kalma",
      "Kim Jong Un Wonsan Kalma Coastal Tourist Area",
    ],
  },
  {
    id: "hwaseong",
    canonical: "화성",
    aliases: ["Hwasong"],
  },
  {
    id: "hwaseong-district",
    canonical: "화성지구",
    aliases: ["화성", "Hwasong District"],
  },
  {
    id: "hwaseong-street",
    canonical: "화성거리",
    aliases: ["화성", "Hwasong Street"],
  },
  {
    id: "hwaseong-district-stage-1",
    canonical: "화성지구 1단계",
    aliases: ["화성 1단계", "Hwasong District Stage 1"],
  },
  {
    id: "hwaseong-district-stage-2",
    canonical: "화성지구 2단계",
    aliases: ["화성 2단계", "Hwasong District Stage 2"],
  },
  {
    id: "hwaseong-district-stage-3",
    canonical: "화성지구 3단계",
    aliases: ["화성 3단계", "Hwasong District Stage 3"],
  },
  {
    id: "hwaseong-district-stage-4",
    canonical: "화성지구 4단계",
    aliases: ["화성 4단계", "Hwasong District Stage 4"],
  },
  {
    id: "hwaseong-ragwon-bulgogi",
    canonical: "화성락원불고기식당",
    aliases: ["화성 락원불고기식당", "Hwasong Ragwon Bulgogi Restaurant"],
  },
];

export function getKnownEntitySuggestionEntries() {
  return KNOWN_SEARCH_ENTITIES.map((entity) => ({
    id: `entity:${entity.id}`,
    label: entity.canonical,
    aliases: entity.aliases,
    type: "entity",
  }));
}

const MINIMUM_COMPLETION_LENGTH = 3;

export function resolveKnownEntityQuery(query) {
  const normalized = normalizeQuery(query);
  if (!normalized.raw) return null;

  const rawToken = createSearchToken(normalized.qwerty || normalized.raw);
  if (rawToken.isStandaloneConsonantOnly) return null;

  const matches = [];
  for (const entity of KNOWN_SEARCH_ENTITIES) {
    const certainty = getEntityCertainty(entity, normalized);
    if (certainty > 0) matches.push({ entity, certainty });
  }

  matches.sort((left, right) => right.certainty - left.certainty);
  const top = matches[0];
  if (!top) return null;
  if (matches[1] && matches[1].certainty === top.certainty) return null;

  return {
    id: top.entity.id,
    canonical: top.entity.canonical,
    certainty: top.certainty,
  };
}

export function resolveKnownEntityDocumentQuery(query) {
  const normalized = normalizeQuery(query);
  if (!normalized.raw) return "";

  const resolvedEntity = resolveKnownEntityQuery(query);
  if (shouldUseResolvedEntityForDocumentSearch(normalized.raw, resolvedEntity)) {
    return resolvedEntity.canonical;
  }

  const entities = segmentKnownEntityQuery(normalized.raw);
  return entities.length ? entities.map((entity) => entity.canonical).join(" ") : "";
}

export function shouldUseResolvedEntityForDocumentSearch(rawQuery = "", resolvedEntity) {
  if (!resolvedEntity) return false;
  if (resolvedEntity.certainty >= 100) return true;
  return /[ㄱ-ㅎㅏ-ㅣ]/.test(String(rawQuery));
}

function getEntityCertainty(entity, normalized) {
  let best = 0;
  for (const label of [entity.canonical, ...entity.aliases]) {
    const labelToken = createSearchToken(label);
    for (const variant of normalized.variants) {
      if (!variant.compactLower || variant.isStandaloneConsonantOnly) continue;
      if (labelToken.compactLower === variant.compactLower || labelToken.lower === variant.lower) {
        best = Math.max(best, 100);
      }
      if (!entity.disablePartialCompletion && isDeterministicPartialCompletion(labelToken, variant)) {
        best = Math.max(best, 80);
      }
    }
  }
  return best;
}

function isDeterministicPartialCompletion(labelToken, variant) {
  if (variant.compact.length < MINIMUM_COMPLETION_LENGTH) return false;
  if (!variant.disassembled || !labelToken.disassembled) return false;
  if (labelToken.compactLower.startsWith(variant.compactLower)) return true;
  return labelToken.disassembled.startsWith(variant.disassembled);
}

let entityLabelCandidates = null;

function segmentKnownEntityQuery(query = "") {
  const key = createEntityMatchKey(query);
  if (!key) return [];

  const segments = [];
  let cursor = 0;
  while (cursor < key.length) {
    const candidate = getEntityLabelCandidates().find((entry) => key.startsWith(entry.key, cursor));
    if (!candidate) return [];
    segments.push(candidate.entity);
    cursor += candidate.key.length;
  }

  return segments;
}

function getEntityLabelCandidates() {
  if (entityLabelCandidates) return entityLabelCandidates;

  const candidatesByKey = new Map();
  for (const entity of KNOWN_SEARCH_ENTITIES) {
    for (const label of [entity.canonical, ...entity.aliases]) {
      const key = createEntityMatchKey(label);
      if (!key) continue;
      if (!candidatesByKey.has(key)) candidatesByKey.set(key, new Map());
      candidatesByKey.get(key).set(entity.id, entity);
    }
  }

  entityLabelCandidates = [...candidatesByKey.entries()]
    .filter(([, entities]) => entities.size === 1)
    .map(([key, entities]) => ({ key, entity: [...entities.values()][0] }))
    .sort((left, right) => right.key.length - left.key.length || left.key.localeCompare(right.key));
  return entityLabelCandidates;
}

function createEntityMatchKey(value = "") {
  return createSearchToken(value).simplified.toLocaleLowerCase("ko-KR");
}
