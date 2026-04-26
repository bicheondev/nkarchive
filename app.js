const DEFAULT_SAMPLE = "동해 물과 백두산이\n마르고 닳도록";
const CARD_WIDTH = 235;
const CARD_HEIGHT = 255;
const GRID_GAP = 20;
const OVERSCAN_ROWS = 2;
const INITIAL_RESULT_COUNT = 24;
const RESULT_BATCH_SIZE = 24;
const LOAD_MORE_THRESHOLD = 300;
const MAX_CONCURRENT_FONT_LOADS = 4;

const grid = document.querySelector("#fontGrid");
const template = document.querySelector("#cardTemplate");
const searchForm = document.querySelector("#searchForm");
const searchInput = document.querySelector("#searchInput");
const searchButton = document.querySelector(".search-button");
const phraseInput = document.querySelector("#phraseInput");
const categoryControl = document.querySelector("#categoryControl");
const seriesButton = document.querySelector("#seriesButton");
const seriesButtonText = document.querySelector("#seriesButtonText");
const seriesMenu = document.querySelector("#seriesMenu");

let fonts = [];
let filteredFonts = [];
let loadedResultCount = 0;
let selectedSeriesFilter = null;
let preparedWebFonts = new Map();
let previewWebFonts = new Map();
let virtualLayout = null;
let renderFrame = 0;
let activeFontLoads = 0;
let lastRenderDebugAt = 0;

const sampleOverrides = new Map();
const fontLoadStates = new Map();
const fontLoadQueue = [];
const fontDebugCounters = {
  fontFacesCreated: 0,
  previewRequested: 0,
  previewLoaded: 0,
  previewFailed: 0,
  fullRequested: 0,
  fullLoaded: 0,
  fullFailed: 0,
};

init();

async function init() {
  [fonts, preparedWebFonts, previewWebFonts] = await Promise.all([
    loadFontOrder(),
    loadPreparedWebFonts(),
    loadPreviewWebFonts(),
  ]);
  filteredFonts = fonts;
  resetLoadedResults();
  populateSeriesMenu();
  bindEvents();
  exposeDebugHelpers();
  debugSummary("metadata loaded");
  renderVirtualGrid(true);
  window.setTimeout(() => debugSummary("initial visible window"), 1200);
}

async function loadFontOrder() {
  const response = await fetch("font_order.md", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load font_order.md: ${response.status}`);
  }

  const markdown = await response.text();
  return markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|") && !line.includes("---") && !line.includes("번호"))
    .map(parseMarkdownRow)
    .filter(Boolean)
    .map((row, index) => ({
      order: Number(row[0]),
      series: row[1],
      group: row[2],
      fileName: row[3],
      name: row[4],
      path: row[5],
      cssFamily: `ArchiveFont${String(index + 1).padStart(3, "0")}`,
      previewFamily: `ArchiveFont${String(index + 1).padStart(3, "0")}Preview`,
      fullFamily: `ArchiveFont${String(index + 1).padStart(3, "0")}Full`,
    }));
}

async function loadPreparedWebFonts() {
  try {
    const response = await fetch("webfonts/font_manifest.json", { cache: "no-store" });
    if (!response.ok) return new Map();

    const manifest = await response.json();
    if (manifest.formats && typeof manifest.formats === "object") {
      return new Map(
        Object.entries(manifest.formats).map(([family, formats]) => [
          family,
          new Set(Array.isArray(formats) ? formats : []),
        ]),
      );
    }

    return new Map(
      (Array.isArray(manifest.fonts) ? manifest.fonts : []).map((family) => [family, new Set(["ttf"])]),
    );
  } catch {
    return new Map();
  }
}

async function loadPreviewWebFonts() {
  try {
    const response = await fetch("webfonts-preview/preview_manifest.json", { cache: "no-store" });
    if (!response.ok) return new Map();

    const manifest = await response.json();
    if (!manifest.previews || typeof manifest.previews !== "object") return new Map();

    return new Map(
      Object.entries(manifest.previews)
        .filter(([, preview]) => preview && typeof preview.url === "string")
        .map(([family, preview]) => [family, preview]),
    );
  } catch {
    return new Map();
  }
}

function parseMarkdownRow(line) {
  const cells = line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
  return cells.length === 6 ? cells : null;
}

function populateSeriesMenu() {
  seriesMenu.replaceChildren();

  for (const option of buildSeriesOptions()) {
    const button = document.createElement("button");
    const label = document.createElement("span");

    button.className = "category-option";
    button.type = "button";
    button.setAttribute("role", "option");
    button.dataset.filterType = option.type;
    button.dataset.filterValue = option.value;
    button.dataset.label = option.label;
    button.setAttribute("aria-selected", "false");
    label.textContent = option.label;
    button.append(label);
    button.addEventListener("click", () => selectSeriesOption(option));
    seriesMenu.append(button);
  }
}

function buildSeriesOptions() {
  return [
    { label: "전체", value: "", type: "all" },
    { label: "KCC-R 계열", value: "KCC-R", type: "prefix" },
    { label: "KP 계열", value: "KP ", type: "prefix" },
    { label: "PnP 계열", value: "PnP", type: "prefix" },
    { label: "KPA 계열", value: "KPA", type: "prefix" },
    { label: "PKS 계열", value: "PKS", type: "prefix" },
    { label: "PRK 계열", value: "PRK", type: "prefix" },
    { label: "WK 계열", value: "WK", type: "prefix" },
  ];
}

function bindEvents() {
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
  });

  searchButton.addEventListener("click", applyFilters);
  phraseInput.addEventListener("input", debounce(resetVisibleSamples, 80));
  seriesButton.addEventListener("click", toggleSeriesMenu);
  document.addEventListener("click", closeSeriesMenuOnOutsideClick);
  document.addEventListener("keydown", closeSeriesMenuOnEscape);
  window.addEventListener("scroll", scheduleVirtualRender, { passive: true });
  window.addEventListener("resize", debounce(() => renderVirtualGrid(true), 120));
}

function applyFilters() {
  const query = searchInput.value.trim().toLocaleLowerCase("ko-KR");

  filteredFonts = fonts.filter((font) => {
    const matchesSeries = matchesSelectedSeries(font);
    const haystack = `${font.name} ${font.series} ${font.fileName}`.toLocaleLowerCase("ko-KR");
    const matchesQuery = !query || haystack.includes(query);
    return matchesSeries && matchesQuery;
  });

  resetLoadedResults();
  renderVirtualGrid(true);
}

function matchesSelectedSeries(font) {
  if (!selectedSeriesFilter) return true;
  if (selectedSeriesFilter.type === "all") return true;
  if (selectedSeriesFilter.type === "prefix") return font.series.startsWith(selectedSeriesFilter.value);
  return font.series === selectedSeriesFilter.value;
}

function toggleSeriesMenu() {
  const isOpen = categoryControl.classList.toggle("open");
  seriesButton.setAttribute("aria-expanded", String(isOpen));
}

function closeSeriesMenu() {
  categoryControl.classList.remove("open");
  seriesButton.setAttribute("aria-expanded", "false");
}

function closeSeriesMenuOnOutsideClick(event) {
  if (categoryControl.contains(event.target)) return;
  closeSeriesMenu();
}

function closeSeriesMenuOnEscape(event) {
  if (event.key === "Escape") closeSeriesMenu();
}

function selectSeriesOption(option) {
  const isSelected =
    selectedSeriesFilter &&
    selectedSeriesFilter.type === option.type &&
    selectedSeriesFilter.value === option.value;
  selectedSeriesFilter = isSelected ? null : option;
  seriesButtonText.textContent = selectedSeriesFilter ? option.label : "종류";
  closeSeriesMenu();
  updateSelectedSeriesOption();
}

function updateSelectedSeriesOption() {
  for (const optionNode of seriesMenu.querySelectorAll(".category-option")) {
    const selected =
      selectedSeriesFilter &&
      optionNode.dataset.filterType === selectedSeriesFilter.type &&
      optionNode.dataset.filterValue === selectedSeriesFilter.value;
    optionNode.setAttribute("aria-selected", String(Boolean(selected)));
  }
}

function scheduleVirtualRender() {
  if (renderFrame) return;
  renderFrame = window.requestAnimationFrame(() => {
    renderFrame = 0;
    renderVirtualGrid(false);
  });
}

function renderVirtualGrid(force) {
  extendLoadedResultsForScroll();
  const metrics = getGridMetrics(loadedResultCount);
  const range = getVisibleRange(metrics, loadedResultCount);
  const unchanged =
    !force &&
    virtualLayout &&
    virtualLayout.columns === metrics.columns &&
    virtualLayout.loadedResultCount === loadedResultCount &&
    virtualLayout.startIndex === range.startIndex &&
    virtualLayout.endIndex === range.endIndex &&
    virtualLayout.totalHeight === metrics.totalHeight;

  grid.style.height = `${metrics.totalHeight}px`;
  virtualLayout = { ...metrics, ...range, loadedResultCount };
  if (unchanged) return;

  const fragment = document.createDocumentFragment();
  const visibleRequests = [];
  for (let index = range.startIndex; index < range.endIndex; index += 1) {
    const font = filteredFonts[index];
    if (!font) continue;
    const request = activeFontRequest(font);
    const card = createFontCard(font, index, metrics, request);
    fragment.append(card);
    visibleRequests.push(request);
  }

  grid.replaceChildren(fragment);
  pruneQueuedFontLoads(new Set(visibleRequests.map((request) => request.family)));
  for (const request of visibleRequests) enqueueFontLoad(request);
  debugSummary("render window");
}

function resetLoadedResults() {
  loadedResultCount = Math.min(INITIAL_RESULT_COUNT, filteredFonts.length);
}

function extendLoadedResultsForScroll() {
  if (loadedResultCount >= filteredFonts.length) return;

  while (loadedResultCount < filteredFonts.length) {
    const metrics = getGridMetrics(loadedResultCount);
    const rect = grid.getBoundingClientRect();
    const viewportBottom = window.innerHeight - rect.top;
    if (metrics.totalHeight && viewportBottom + LOAD_MORE_THRESHOLD < metrics.totalHeight) break;
    loadedResultCount = Math.min(filteredFonts.length, loadedResultCount + RESULT_BATCH_SIZE);
  }
}

function getGridMetrics(itemCount) {
  const gridWidth = grid.clientWidth || Number.parseFloat(getComputedStyle(grid).width) || CARD_WIDTH;
  const columns = Math.max(1, Math.floor((gridWidth + GRID_GAP) / (CARD_WIDTH + GRID_GAP)));
  const rows = Math.ceil(itemCount / columns);
  const totalHeight = rows ? rows * CARD_HEIGHT + (rows - 1) * GRID_GAP : 0;
  const usedWidth = columns * CARD_WIDTH + (columns - 1) * GRID_GAP;
  const horizontalOffset = Math.max(0, (gridWidth - usedWidth) / 2);

  return {
    columns,
    rows,
    totalHeight,
    horizontalOffset,
  };
}

function getVisibleRange(metrics, itemCount) {
  if (!itemCount) return { startIndex: 0, endIndex: 0 };

  const rowPitch = CARD_HEIGHT + GRID_GAP;
  const rect = grid.getBoundingClientRect();
  const viewportTop = Math.max(0, -rect.top);
  const viewportBottom = Math.min(metrics.totalHeight, window.innerHeight - rect.top);
  const endRow = Math.min(
    metrics.rows - 1,
    Math.ceil(viewportBottom / rowPitch) + OVERSCAN_ROWS,
  );
  const startRow = Math.min(
    endRow,
    Math.max(0, Math.floor(viewportTop / rowPitch) - OVERSCAN_ROWS),
  );

  return {
    startIndex: startRow * metrics.columns,
    endIndex: Math.min(itemCount, (endRow + 1) * metrics.columns),
  };
}

function createFontCard(font, index, metrics, request) {
  const card = template.content.firstElementChild.cloneNode(true);
  const sampleNode = card.querySelector(".sample-text");
  const row = Math.floor(index / metrics.columns);
  const column = index % metrics.columns;

  card.style.left = `${metrics.horizontalOffset + column * (CARD_WIDTH + GRID_GAP)}px`;
  card.style.top = `${row * (CARD_HEIGHT + GRID_GAP)}px`;
  applyFontRequestToCard(card, request);

  card.querySelector(".font-name").textContent = font.name;
  card.querySelector(".font-series").textContent = font.series;
  card.querySelector(".download-button").href = encodeFontUrl(font.path);
  card.querySelector(".download-button").setAttribute("download", font.fileName);
  card.querySelector(".download-button").setAttribute("aria-label", `${font.name} 내려받기`);

  sampleNode.dataset.fontOrder = String(font.order);
  sampleNode.dataset.placeholder = currentSample();
  if (sampleOverrides.has(font.order)) setSample(sampleNode, sampleOverrides.get(font.order));
  sampleNode.addEventListener("input", () => handleSampleInput(sampleNode, font));
  sampleNode.addEventListener("paste", pastePlainText);

  return card;
}

function applyFontRequestToCard(card, request) {
  const status = fontLoadStates.get(request.family)?.status;
  card.style.setProperty("--font-family", request.family);
  card.dataset.family = request.family;
  card.dataset.fontVariant = request.variant;
  if (status) {
    card.dataset.fontStatus = status;
  } else {
    delete card.dataset.fontStatus;
  }
}

function activeFontRequest(font) {
  const variant = shouldUseFullFont(font) ? "full" : "preview";
  const family = fontFamilyForVariant(font, variant);
  return {
    font,
    variant,
    family,
    source: fontFaceSource(font, variant),
  };
}

function shouldUseFullFont(font) {
  return Boolean(phraseInput.value.trim() || sampleOverrides.has(font.order));
}

function fontFamilyForVariant(font, variant) {
  return variant === "full" ? font.fullFamily : font.previewFamily;
}

function enqueueFontLoad(request) {
  const { family } = request;
  if (fontLoadStates.has(family)) return;

  fontLoadStates.set(family, { status: "queued", variant: request.variant });
  fontLoadQueue.push(request);
  recordFontRequest(request.variant);
  pumpFontLoadQueue();
}

function pruneQueuedFontLoads(visibleFamilies) {
  for (let index = fontLoadQueue.length - 1; index >= 0; index -= 1) {
    const family = fontLoadQueue[index].family;
    const state = fontLoadStates.get(family);
    if (state?.status !== "queued" || visibleFamilies.has(family)) continue;
    fontLoadQueue.splice(index, 1);
    fontLoadStates.delete(family);
  }
}

function pumpFontLoadQueue() {
  while (activeFontLoads < MAX_CONCURRENT_FONT_LOADS && fontLoadQueue.length) {
    const request = fontLoadQueue.shift();
    const state = fontLoadStates.get(request.family);
    if (!state || state.status !== "queued") continue;

    activeFontLoads += 1;
    startFontLoad(request).finally(() => {
      activeFontLoads -= 1;
      pumpFontLoadQueue();
    });
  }
}

async function startFontLoad(request) {
  const state = fontLoadStates.get(request.family);
  state.status = "loading";
  updateRenderedFontStatus(request.family, "loading");

  try {
    if (typeof FontFace === "undefined" || !document.fonts) {
      throw new Error("FontFace API is unavailable");
    }

    const fontFace = new FontFace(request.family, request.source, { display: "swap" });
    fontDebugCounters.fontFacesCreated += 1;
    document.fonts.add(fontFace);
    await fontFace.load();
    state.status = "loaded";
    state.fontFace = fontFace;
    recordFontResult(request.variant, "loaded");
    updateRenderedFontStatus(request.family, "loaded");
  } catch (error) {
    state.status = "failed";
    state.error = error;
    recordFontResult(request.variant, "failed");
    updateRenderedFontStatus(request.family, "failed");
    debugWarn(`Failed to load ${request.family}`, error);
  }
}

function updateRenderedFontStatus(family, status) {
  for (const card of grid.querySelectorAll(`[data-family="${family}"]`)) {
    card.dataset.fontStatus = status;
  }
}

function fontFaceSource(font, variant) {
  if (variant === "preview") {
    const preview = previewWebFonts.get(font.cssFamily);
    if (preview?.url) {
      return `url("${encodeFontUrl(preview.url)}") format("woff2")`;
    }
  }

  return fullFontFaceSource(font);
}

function fullFontFaceSource(font) {
  const formats = preparedWebFonts.get(font.cssFamily);
  if (formats?.has("woff2")) {
    return `url("webfonts/${font.cssFamily}.woff2") format("woff2")`;
  }
  if (formats?.has("ttf")) {
    return `url("webfonts/${font.cssFamily}.ttf") format("truetype")`;
  }

  return `url("${encodeFontUrl(font.path)}") format("${fontFormat(font.path)}")`;
}

function fontFormat(path) {
  return path.toLocaleLowerCase("en-US").endsWith(".otf") ? "opentype" : "truetype";
}

function resetVisibleSamples() {
  sampleOverrides.clear();
  renderVirtualGrid(true);
}

function setSample(node, value) {
  node.replaceChildren();
  for (const line of value.split(/\r?\n/)) {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    node.append(paragraph);
  }
}

function readSample(node) {
  return node.innerText.replace(/\n{3,}/g, "\n\n").trim();
}

function handleSampleInput(node, font) {
  const value = readSample(node);
  if (!value) {
    sampleOverrides.delete(font.order);
    node.replaceChildren();
    const card = node.closest(".font-card");
    if (card) {
      const request = activeFontRequest(font);
      applyFontRequestToCard(card, request);
      enqueueFontLoad(request);
    }
    return;
  }

  sampleOverrides.set(font.order, value);
  const card = node.closest(".font-card");
  if (card) {
    const request = activeFontRequest(font);
    applyFontRequestToCard(card, request);
    enqueueFontLoad(request);
  }
}

function currentSample() {
  return phraseInput.value.trim() || DEFAULT_SAMPLE;
}

function pastePlainText(event) {
  event.preventDefault();
  const text = event.clipboardData.getData("text/plain");
  document.execCommand("insertText", false, text);
}

function encodeFontUrl(value) {
  return encodeURI(value).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

function exposeDebugHelpers() {
  window.fontArchiveDebug = () => debugSummary("manual", true);
  window.fontArchiveSetDebug = (enabled = true) => {
    try {
      localStorage.setItem("fontArchiveDebug", enabled ? "1" : "0");
    } catch {
      return false;
    }
    return true;
  };
}

function recordFontRequest(variant) {
  if (variant === "full") {
    fontDebugCounters.fullRequested += 1;
  } else {
    fontDebugCounters.previewRequested += 1;
  }
}

function recordFontResult(variant, status) {
  const key = `${variant}${status.charAt(0).toUpperCase()}${status.slice(1)}`;
  if (Object.prototype.hasOwnProperty.call(fontDebugCounters, key)) {
    fontDebugCounters[key] += 1;
  }
}

function debugSummary(label, force = false) {
  if (!force && !isFontDebugEnabled()) return;
  if (!force && label === "render window") {
    const now = Date.now();
    if (now - lastRenderDebugAt < 1200) return;
    lastRenderDebugAt = now;
  }

  const stateCounts = { queued: 0, loading: 0, loaded: 0, failed: 0 };
  for (const state of fontLoadStates.values()) {
    if (Object.prototype.hasOwnProperty.call(stateCounts, state.status)) {
      stateCounts[state.status] += 1;
    }
  }

  console.info(`[FontArchive] ${label}`, {
    totalFonts: fonts.length,
    filteredFonts: filteredFonts.length,
    revealedResults: loadedResultCount,
    mountedCards: grid.childElementCount,
    staticFontFaceRulesAtStartup: 0,
    previewManifestFonts: previewWebFonts.size,
    fullManifestFonts: preparedWebFonts.size,
    queueLength: fontLoadQueue.length,
    activeFontLoads,
    stateCounts,
    counters: { ...fontDebugCounters },
    resources: fontResourceSummary(),
  });
}

function debugWarn(message, error) {
  if (isFontDebugEnabled()) console.warn(message, error);
}

function isFontDebugEnabled() {
  const isLocalHost = ["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname);
  if (isLocalHost) return true;
  try {
    return localStorage.getItem("fontArchiveDebug") === "1";
  } catch {
    return false;
  }
}

function fontResourceSummary() {
  if (!window.performance?.getEntriesByType) {
    return { count: 0, transferBytes: 0, encodedBytes: 0 };
  }

  const resources = window.performance
    .getEntriesByType("resource")
    .filter((entry) => /\/(webfonts-preview|webfonts|fonts)\//.test(entry.name))
    .filter((entry) => /\.(woff2|woff|ttf|otf)(\?|$)/i.test(entry.name));

  return {
    count: resources.length,
    transferBytes: resources.reduce((total, entry) => total + (entry.transferSize || 0), 0),
    encodedBytes: resources.reduce((total, entry) => total + (entry.encodedBodySize || 0), 0),
  };
}

function debounce(callback, delay) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  };
}
