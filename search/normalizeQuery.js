const SPACE_PATTERN = /\s+/g;
const SOFT_PUNCTUATION_PATTERN = /[\p{P}\p{S}]+/gu;
const STANDALONE_CONSONANT_PATTERN = /^[ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ]+$/;
const HANGUL_BASE_CODE = 0xac00;
const HANGUL_END_CODE = 0xd7a3;
const HANGUL_MEDIAL_COUNT = 21;
const HANGUL_FINAL_COUNT = 28;
const HANGUL_INITIALS = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const HANGUL_MEDIALS = ["ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ", "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ"];
const HANGUL_FINALS = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const QWERTY_TO_JAMO = new Map(Object.entries({
  r: "ㄱ", R: "ㄲ", s: "ㄴ", e: "ㄷ", E: "ㄸ", f: "ㄹ", a: "ㅁ", q: "ㅂ", Q: "ㅃ", t: "ㅅ", T: "ㅆ", d: "ㅇ", w: "ㅈ", W: "ㅉ", c: "ㅊ", z: "ㅋ", x: "ㅌ", v: "ㅍ", g: "ㅎ",
  k: "ㅏ", o: "ㅐ", i: "ㅑ", O: "ㅒ", j: "ㅓ", p: "ㅔ", u: "ㅕ", P: "ㅖ", h: "ㅗ", y: "ㅛ", n: "ㅜ", b: "ㅠ", m: "ㅡ", l: "ㅣ",
}));
const COMBINED_MEDIALS = new Map([
  ["ㅗㅏ", "ㅘ"], ["ㅗㅐ", "ㅙ"], ["ㅗㅣ", "ㅚ"],
  ["ㅜㅓ", "ㅝ"], ["ㅜㅔ", "ㅞ"], ["ㅜㅣ", "ㅟ"],
  ["ㅡㅣ", "ㅢ"],
]);
const COMBINED_FINALS = new Map([
  ["ㄱㅅ", "ㄳ"], ["ㄴㅈ", "ㄵ"], ["ㄴㅎ", "ㄶ"],
  ["ㄹㄱ", "ㄺ"], ["ㄹㅁ", "ㄻ"], ["ㄹㅂ", "ㄼ"], ["ㄹㅅ", "ㄽ"], ["ㄹㅌ", "ㄾ"], ["ㄹㅍ", "ㄿ"], ["ㄹㅎ", "ㅀ"],
  ["ㅂㅅ", "ㅄ"],
]);
const SPLIT_FINALS = new Map([...COMBINED_FINALS.entries()].map(([key, value]) => [value, [...key]]));

export function normalizeQuery(input = "") {
  const raw = String(input).trim();
  const qwerty = safeConvertQwertyToHangul(raw);
  const variants = uniqueStrings([
    raw,
    qwerty,
    compactText(raw),
    compactText(qwerty),
    simplifyText(raw),
    simplifyText(qwerty),
  ]).filter(Boolean);

  return {
    raw,
    qwerty,
    compact: compactText(raw),
    variants: variants.map(createSearchToken),
  };
}

export function createSearchToken(text = "") {
  const original = String(text);
  const compact = compactText(original);
  const simplified = simplifyText(original);
  const lower = simplified.toLocaleLowerCase("ko-KR");
  const compactLower = compact.toLocaleLowerCase("ko-KR");
  const disassembled = safeDisassemble(compactLower);

  return {
    original,
    compact,
    simplified,
    lower,
    compactLower,
    disassembled,
    isStandaloneConsonantOnly: STANDALONE_CONSONANT_PATTERN.test(compact),
  };
}

export function getSearchScore(targetText, query) {
  const normalized = typeof query === "string" ? normalizeQuery(query) : query;
  if (!normalized?.variants?.length) return 1;

  const target = createSearchToken(targetText);
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
    if (!variant.isStandaloneConsonantOnly && variant.disassembled && target.disassembled.includes(variant.disassembled)) {
      bestScore = Math.max(bestScore, 104);
    }
  }

  return bestScore;
}

export function isStandaloneConsonantOnlySearch(query) {
  const normalized = typeof query === "string" ? normalizeQuery(query) : query;
  const rawToken = createSearchToken(normalized?.raw || "");
  return rawToken.isStandaloneConsonantOnly;
}

export function compactText(text = "") {
  return normalizeWidth(text).replace(SPACE_PATTERN, "");
}

export function simplifyText(text = "") {
  return compactText(text).replace(SOFT_PUNCTUATION_PATTERN, "");
}

export function normalizeWidthText(text = "") {
  return String(text)
    .replace(/\u3000/g, " ")
    .replace(/[\uff01-\uff5e]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function normalizeWidth(text = "") {
  return normalizeWidthText(text);
}

function safeDisassemble(text) {
  return disassembleHangul(text);
}

function safeConvertQwertyToHangul(text) {
  return convertQwertyToHangulText(text);
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || "").trim()))];
}

function disassembleHangul(text = "") {
  return Array.from(String(text || "")).map((char) => {
    const code = char.charCodeAt(0);
    if (code < HANGUL_BASE_CODE || code > HANGUL_END_CODE) return char;

    const offset = code - HANGUL_BASE_CODE;
    const initialIndex = Math.floor(offset / (HANGUL_MEDIAL_COUNT * HANGUL_FINAL_COUNT));
    const medialIndex = Math.floor((offset % (HANGUL_MEDIAL_COUNT * HANGUL_FINAL_COUNT)) / HANGUL_FINAL_COUNT);
    const finalIndex = offset % HANGUL_FINAL_COUNT;
    return `${HANGUL_INITIALS[initialIndex]}${HANGUL_MEDIALS[medialIndex]}${HANGUL_FINALS[finalIndex] || ""}`;
  }).join("");
}

function convertQwertyToHangulText(text = "") {
  const chars = Array.from(String(text || ""));
  let output = "";
  let initial = "";
  let medial = "";
  let final = "";

  const flush = () => {
    output += composeHangulSyllable(initial, medial, final);
    initial = "";
    medial = "";
    final = "";
  };

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const jamo = QWERTY_TO_JAMO.get(char);
    if (!jamo) {
      flush();
      output += char;
      continue;
    }

    const nextJamo = QWERTY_TO_JAMO.get(chars[index + 1] || "");
    const followingJamo = QWERTY_TO_JAMO.get(chars[index + 2] || "");
    if (isHangulVowelJamo(jamo)) {
      if (!initial) {
        output += jamo;
        continue;
      }
      if (!medial) {
        medial = jamo;
        continue;
      }
      if (!final) {
        const combinedMedial = COMBINED_MEDIALS.get(`${medial}${jamo}`);
        if (combinedMedial) {
          medial = combinedMedial;
        } else {
          flush();
          output += jamo;
        }
        continue;
      }

      const [keptFinal, movedInitial] = splitFinalForNextSyllable(final);
      output += composeHangulSyllable(initial, medial, keptFinal);
      initial = movedInitial;
      medial = jamo;
      final = "";
      continue;
    }

    if (!initial) {
      initial = jamo;
      continue;
    }
    if (!medial) {
      flush();
      initial = jamo;
      continue;
    }
    if (!final) {
      if (isHangulVowelJamo(nextJamo)) {
        flush();
        initial = jamo;
      } else {
        final = jamo;
      }
      continue;
    }
    if (isHangulVowelJamo(nextJamo)) {
      flush();
      initial = jamo;
      continue;
    }

    const combinedFinal = !isHangulVowelJamo(followingJamo) ? COMBINED_FINALS.get(`${final}${jamo}`) : "";
    if (combinedFinal) {
      final = combinedFinal;
    } else {
      flush();
      initial = jamo;
    }
  }

  flush();
  return output;
}

function composeHangulSyllable(initial = "", medial = "", final = "") {
  if (!initial && !medial && !final) return "";
  const initialIndex = HANGUL_INITIALS.indexOf(initial);
  const medialIndex = HANGUL_MEDIALS.indexOf(medial);
  if (initialIndex < 0 || medialIndex < 0) return `${initial}${medial}${final}`;
  const finalIndex = Math.max(0, HANGUL_FINALS.indexOf(final));
  return String.fromCharCode(HANGUL_BASE_CODE + ((initialIndex * HANGUL_MEDIAL_COUNT) + medialIndex) * HANGUL_FINAL_COUNT + finalIndex);
}

function splitFinalForNextSyllable(final = "") {
  const split = SPLIT_FINALS.get(final);
  if (split) return split;
  return ["", final];
}

function isHangulVowelJamo(value = "") {
  return HANGUL_MEDIALS.includes(value);
}
