const DEFAULT_SAMPLE = "동해 물과 백두산이\n마르고 닳도록";
const CARD_WIDTH = 235;
const CARD_HEIGHT = 255;
const GRID_GAP = 20;
const OVERSCAN_ROWS = 2;
const INITIAL_RESULT_COUNT = 24;
const RESULT_BATCH_SIZE = 24;
const LOAD_MORE_THRESHOLD = 300;
const MAX_CONCURRENT_FONT_LOADS = 4;
const ROUTE_FONT = "font";
const ROUTE_KCTV = "kctv";
const LIVE_PATH = "/live";
const KORYO_PLAYER_BASE_WIDTH = 962;
const KCTV_PLAYER_BASE_HEIGHT = 541.125;
const KCNA_PLAYER_WIDTH = 721.5;
const RADIO_PLAYER_BASE_WIDTH = 700;
const RADIO_PLAYER_BASE_HEIGHT = 400;
const KORYO_RADIO_PLAYER_BASE_WIDTH = 500;
const KORYO_RADIO_PLAYER_BASE_HEIGHT = 74;
const HLS_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js";
const TIMETABLE_API_URL = "https://apis.data.go.kr/1250000/tvprgm/getTvprgm";
const TIMETABLE_HTML_DETAIL_URL = "https://nkinfo.unikorea.go.kr/nkp/tvPrgr/view.do";
const TIMETABLE_SERVICE_KEY = "9ccb05895cd315a40c686700a2a76479251510c26798b5ee6a112e1faaa37829";
const TIMETABLE_ROWS_PER_DAY = 200;
const CORS_PROXY_URL = "https://api.allorigins.win/raw?url=";
const READABLE_PROXY_URL = "https://r.jina.ai/http://";
const FONT_FOOTER_COPY = [
  "본 사이트는 북한 정부 또는 조선노동당과는 전혀 관계가 없으며, 이들을 지지하지도 옹호하지도 않고 오로지 학문적인 목적으로 개설되었음을 알려드립니다. 간첩 신고는 국번 없이 111",
  "모든 폰트의 저작권은 평양정보쎈터(Pyongyang Informatics Centre Font Developer Group), 조선콤퓨터쎈터(Korea Computer Centre), 출판인쇄과학연구소(Scientific Institute for Publication and Printing) 등 각 저작권자에게 있습니다. 상업적 이용을 권장하지 않습니다.",
];
const KCTV_FOOTER_COPY = [
  "본 사이트는 북한 정부 또는 조선노동당, 조성중앙텔레비전과는 전혀 관계가 없으며, 이들을 지지하지도 옹호하지도 않고 오로지 학문적인 목적으로 개설되었음을 알려드립니다. 간첩 신고는 국번 없이 111",
];
const KCTV_BROADCASTS = {
  kctv: {
    label: "조선중앙TV",
    type: "tv",
    defaultSource: "koryo",
    sources: {
      koryo: {
        label: "고려TV",
        type: "iframe",
        src: "https://koryo.tv/channel/kctv",
      },
      intchoson: {
        label: "인트조선",
        type: "hls",
        media: "video",
        src: "https://tv.intchoson.com/kctv/main_stream.m3u8",
      },
      kcna: {
        label: "KCNA Watch",
        type: "hls",
        media: "video",
        src: "https://streamer.nknews.org/tvhls/stream.m3u8",
      },
    },
  },
  kcbs: {
    label: "조선중앙방송",
    type: "radio",
    defaultSource: "intchoson",
    sources: {
      koryo: {
        label: "고려TV",
        type: "iframe",
        src: "https://koryo.tv/channel/kcbs",
      },
      intchoson: {
        label: "인트조선",
        type: "hls",
        media: "audio",
        src: "https://radio.intchoson.com/kcbs/index.m3u8",
      },
    },
  },
  vok: {
    label: "조선의 소리",
    type: "radio",
    defaultSource: "intchoson",
    sources: {
      koryo: {
        label: "고려TV",
        type: "iframe",
        src: "https://koryo.tv/channel/vok",
      },
      intchoson: {
        label: "인트조선",
        type: "hls",
        media: "audio",
        src: "https://radio.intchoson.com/vok/index.m3u8",
      },
    },
  },
};
const logoLink = document.querySelector(".logo");
const navLinks = [...document.querySelectorAll(".site-nav a")];
const archiveView = document.querySelector("#archiveView");
const kctvView = document.querySelector("#kctvView");
const siteFooter = document.querySelector("#siteFooter");
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
const kctvTabs = [...document.querySelectorAll(".kctv-tab")];
const kctvSourceControl = document.querySelector("#kctvSourceControl");
const kctvSourceButton = document.querySelector("#kctvSourceButton");
const kctvSourceButtonText = document.querySelector("#kctvSourceButtonText");
const kctvSourceMenu = document.querySelector("#kctvSourceMenu");
const kctvPlayerLayout = document.querySelector("#kctvPlayerLayout");
const kctvPlayerFrame = document.querySelector("#kctvPlayerFrame");
const kctvSchedulePanel = document.querySelector("#kctvSchedulePanel");
const kctvScheduleToggle = document.querySelector("#kctvScheduleToggle");
const kctvScheduleClose = document.querySelector("#kctvScheduleClose");
const kctvScheduleDate = document.querySelector("#kctvScheduleDate");
const kctvProgramList = document.querySelector("#kctvProgramList");
const kctvDatePrev = document.querySelector("#kctvDatePrev");
const kctvDateNext = document.querySelector("#kctvDateNext");

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
let fontArchiveReady = false;
let activeKctvBroadcast = "kctv";
let activeKctvSource = "koryo";
let renderedKctvChannel = null;
let kctvScheduleOpen = true;
let hlsScriptLoad = null;
let kctvPlayerResizeObserver = null;
let kctvPlayerRenderToken = 0;
let activeTimetableYmd = koreaTodayYmd();
let activeTimetableEntries = [];
let timetableCache = new Map();
let timetableLoadStarted = false;
let timetableLoadToken = 0;

const sampleOverrides = new Map();
const fontLoadStates = new Map();
const fontLoadQueue = [];
const kctvPlayerCache = new Map();
const kctvSourceByBroadcast = new Map(
  Object.entries(KCTV_BROADCASTS).map(([broadcastKey, broadcast]) => [broadcastKey, broadcast.defaultSource]),
);
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
  bindRouteEvents();
  bindKctvEvents();
  renderRoute();

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
  fontArchiveReady = true;
  debugSummary("metadata loaded");
  if (currentRoute() === ROUTE_FONT) renderVirtualGrid(true);
  window.setTimeout(() => debugSummary("initial visible window"), 1200);
}

function bindRouteEvents() {
  window.addEventListener("popstate", renderRoute);
  for (const link of navLinks) {
    if (!link.dataset.route) continue;
    link.addEventListener("click", navigateRoute);
  }
  logoLink.addEventListener("click", navigateRoute);
}

function navigateRoute(event) {
  const url = new URL(event.currentTarget.href, window.location.href);
  if (url.origin !== window.location.origin) return;

  event.preventDefault();
  const route =
    event.currentTarget.dataset.route ||
    url.searchParams.get("route") ||
    (url.pathname.replace(/\/+$/, "") === LIVE_PATH ? ROUTE_KCTV : ROUTE_FONT);
  const pathname = route === ROUTE_KCTV ? LIVE_PATH : "/font";

  if (pathname !== window.location.pathname.replace(/\/+$/, "")) {
    window.history.pushState(null, "", pathname);
  }
  renderRoute();
}

function currentRoute() {
  const initialRoute = window.__INITIAL_ROUTE__;
  window.__INITIAL_ROUTE__ = null;
  const queryRoute = new URLSearchParams(window.location.search).get("route");
  const requestedRoute = queryRoute || initialRoute;
  if (requestedRoute === ROUTE_KCTV) return ROUTE_KCTV;
  if (requestedRoute === ROUTE_FONT) return ROUTE_FONT;

  const path = window.location.pathname.replace(/\/+$/, "") || "/font";
  if (path === LIVE_PATH) return ROUTE_KCTV;
  return ROUTE_FONT;
}

function renderRoute() {
  const route = currentRoute();
  const isKctv = route === ROUTE_KCTV;

  const currentPath = window.location.pathname.replace(/\/+$/, "") || "/";
  if (currentPath === "/" || window.location.search) {
    window.history.replaceState(null, "", isKctv ? LIVE_PATH : "/font");
  }
  document.title = isKctv ? "북한방송아카이브" : "북한폰트아카이브";
  document.documentElement.dataset.route = route;
  document.body.dataset.view = route;
  archiveView.hidden = isKctv;
  kctvView.hidden = !isKctv;
  if (!isKctv) silenceAllKctvPlayers();
  logoLink.textContent = isKctv ? "★Live" : "★Font";
  logoLink.setAttribute("aria-label", isKctv ? "KCTV live home" : "Font archive home");
  logoLink.href = isKctv ? LIVE_PATH : "/font";
  siteFooter.dataset.view = route;
  renderFooterCopy(isKctv ? KCTV_FOOTER_COPY : FONT_FOOTER_COPY);

  for (const link of navLinks) {
    const isActive = link.dataset.route === route;
    link.classList.toggle("active", isActive);
    if (link.dataset.route) link.setAttribute("aria-current", isActive ? "page" : "false");
  }

  if (isKctv) {
    renderKctvView();
  } else if (fontArchiveReady) {
    renderVirtualGrid(true);
  }
}

function renderFooterCopy(lines) {
  siteFooter.replaceChildren(
    ...lines.map((line) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = line;
      return paragraph;
    }),
  );
}

function bindKctvEvents() {
  for (const tab of kctvTabs) {
    tab.addEventListener("click", () => {
      const broadcast = tab.dataset.broadcast;
      if (!KCTV_BROADCASTS[broadcast] || broadcast === activeKctvBroadcast) return;
      kctvSourceByBroadcast.set(activeKctvBroadcast, activeKctvSource);
      activeKctvBroadcast = broadcast;
      activeKctvSource = kctvSourceByBroadcast.get(broadcast) || KCTV_BROADCASTS[broadcast].defaultSource;
      ensureActiveKctvSource();
      renderedKctvChannel = null;
      closeKctvSourceMenu();
      renderKctvTabs();
      renderKctvSourceMenu();
      renderKctvPlayer();
      setKctvScheduleOpen(kctvScheduleOpen);
      renderTimetable();
    });
  }

  kctvSourceButton.addEventListener("click", toggleKctvSourceMenu);
  kctvScheduleToggle.addEventListener("click", () => setKctvScheduleOpen(true));
  kctvScheduleClose.addEventListener("click", () => setKctvScheduleOpen(false));
  kctvDatePrev.addEventListener("click", () => moveTimetableDate(-1));
  kctvDateNext.addEventListener("click", () => moveTimetableDate(1));
  document.addEventListener("click", closeKctvSourceMenuOnOutsideClick);
  document.addEventListener("keydown", closeKctvSourceMenuOnEscape);

  if (typeof ResizeObserver !== "undefined") {
    kctvPlayerResizeObserver = new ResizeObserver(updateKctvPlayerScale);
    kctvPlayerResizeObserver.observe(kctvPlayerFrame);
  }
  window.addEventListener("resize", debounce(updateKctvPlayerScale, 80));
}

function renderKctvView() {
  renderKctvTabs();
  renderKctvSourceMenu();
  renderKctvPlayer();
  setKctvScheduleOpen(kctvScheduleOpen);
  renderTimetable();
  if (!timetableLoadStarted) {
    timetableLoadStarted = true;
    loadLatestTimetable();
  }
}

function renderKctvTabs() {
  for (const tab of kctvTabs) {
    const selected = tab.dataset.broadcast === activeKctvBroadcast;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
  }
}

function renderKctvSourceMenu() {
  ensureActiveKctvSource();
  const broadcast = activeKctvBroadcastConfig();
  const sourceEntries = Object.entries(broadcast.sources);

  kctvSourceButtonText.textContent = broadcast.sources[activeKctvSource].label;
  kctvSourceMenu.replaceChildren(
    ...sourceEntries.map(([sourceKey, source]) => {
      const button = document.createElement("button");
      const label = document.createElement("span");

      button.className = "category-option";
      button.type = "button";
      button.setAttribute("role", "option");
      button.dataset.source = sourceKey;
      button.setAttribute("aria-selected", String(sourceKey === activeKctvSource));
      label.textContent = source.label;
      button.append(label);
      button.addEventListener("click", () => selectKctvSourceOption(sourceKey));
      return button;
    }),
  );
}

function toggleKctvSourceMenu() {
  const isOpen = kctvSourceControl.classList.toggle("open");
  kctvSourceButton.setAttribute("aria-expanded", String(isOpen));
}

function closeKctvSourceMenu() {
  kctvSourceControl.classList.remove("open");
  kctvSourceButton.setAttribute("aria-expanded", "false");
}

function closeKctvSourceMenuOnOutsideClick(event) {
  if (kctvSourceControl.contains(event.target)) return;
  closeKctvSourceMenu();
}

function closeKctvSourceMenuOnEscape(event) {
  if (event.key === "Escape") closeKctvSourceMenu();
}

function selectKctvSourceOption(sourceKey) {
  const broadcast = activeKctvBroadcastConfig();
  if (!broadcast.sources[sourceKey]) return;

  closeKctvSourceMenu();
  if (sourceKey === activeKctvSource) return;

  activeKctvSource = sourceKey;
  kctvSourceByBroadcast.set(activeKctvBroadcast, sourceKey);
  renderedKctvChannel = null;
  renderKctvSourceMenu();
  renderKctvPlayer();
}

function activeKctvBroadcastConfig() {
  return KCTV_BROADCASTS[activeKctvBroadcast] || KCTV_BROADCASTS.kctv;
}

function activeKctvSourceConfig() {
  const broadcast = activeKctvBroadcastConfig();
  return broadcast.sources[activeKctvSource] || broadcast.sources[broadcast.defaultSource];
}

function activeKctvPlayerKey() {
  return `${activeKctvBroadcast}:${activeKctvSource}`;
}

function ensureActiveKctvSource() {
  const broadcast = activeKctvBroadcastConfig();
  if (broadcast.sources[activeKctvSource]) return;
  activeKctvSource = broadcast.defaultSource;
  kctvSourceByBroadcast.set(activeKctvBroadcast, activeKctvSource);
}

function renderKctvPlayer() {
  ensureActiveKctvSource();
  const playerKey = activeKctvPlayerKey();

  const sourceKey = activeKctvSource;
  const channel = activeKctvSourceConfig();
  const playerKind = activeKctvPlayerKind(channel);
  kctvView.dataset.playerKind = playerKind;
  kctvPlayerLayout.dataset.broadcast = activeKctvBroadcast;
  kctvPlayerLayout.dataset.source = sourceKey;
  kctvPlayerLayout.dataset.playerKind = playerKind;
  kctvPlayerFrame.dataset.broadcast = activeKctvBroadcast;
  kctvPlayerFrame.dataset.channel = sourceKey;
  kctvPlayerFrame.dataset.source = sourceKey;
  kctvPlayerFrame.dataset.playerKind = playerKind;

  if (!kctvPlayerCache.has(playerKey)) {
    const player =
      channel.type === "iframe"
        ? createKoryoPlayer(channel, playerKey, playerKind)
        : createHlsPlayer(channel, playerKey, ++kctvPlayerRenderToken);
    kctvPlayerCache.set(playerKey, player);
    kctvPlayerFrame.append(player.node);
  }

  showKctvPlayer(playerKey);
  renderedKctvChannel = playerKey;
  updateKctvPlayerScale();
}

function createKctvStreamLayer(channelKey) {
  const layer = document.createElement("div");
  layer.className = "kctv-stream-layer";
  layer.dataset.channel = channelKey;
  return layer;
}

function activeKctvPlayerKind(channel = activeKctvSourceConfig()) {
  if (channel.type === "iframe" && activeKctvBroadcastConfig().type === "radio") return "koryo-radio";
  if (channel.media === "audio") return "radio";
  return "video";
}

function createKoryoPlayer(channel, channelKey, playerKind) {
  const layer = createKctvStreamLayer(channelKey);
  const iframe = document.createElement("iframe");
  const isRadioIframe = playerKind === "koryo-radio";
  iframe.className = isRadioIframe ? "kctv-koryo-frame kctv-koryo-radio-frame" : "kctv-koryo-frame";
  layer.classList.toggle("kctv-koryo-radio-layer", isRadioIframe);
  iframe.src = channel.src;
  iframe.width = "1649";
  iframe.height = isRadioIframe ? "322" : "685";
  iframe.frameBorder = "0";
  iframe.scrolling = "no";
  iframe.setAttribute("scrolling", "no");
  iframe.allowFullscreen = true;
  iframe.allow = "fullscreen";
  iframe.title = channel.label;
  layer.append(iframe);
  return { node: layer, iframe, iframeSrc: channel.src };
}

function showKctvPlayer(channelKey) {
  for (const [key, player] of kctvPlayerCache) {
    const selected = key === channelKey;
    if (selected) restoreKctvPlayer(player);
    player.node.hidden = !selected;
    player.node.setAttribute("aria-hidden", String(!selected));

    if (selected && player.autoplay) {
      playKctvPlayerSilently(player);
    } else if (!selected) {
      silenceKctvPlayer(player);
    }
  }
}

function restoreKctvPlayer(player) {
  if (!player.iframe) return;
  if (player.iframe.getAttribute("src") !== player.iframeSrc) {
    player.iframe.src = player.iframeSrc;
  }
}

function playKctvPlayerSilently(player) {
  if (!player.video) return;
  player.video.muted = true;
  player.video.play().catch(() => {});
}

function silenceKctvPlayer(player) {
  if (player.video) {
    player.video.pause();
    player.video.muted = true;
  }
  if (player.iframe && player.iframe.getAttribute("src") !== "about:blank") {
    player.iframe.src = "about:blank";
  }
}

function silenceAllKctvPlayers() {
  for (const player of kctvPlayerCache.values()) {
    silenceKctvPlayer(player);
  }
}

function createHlsPlayer(channel, channelKey, renderToken) {
  const layer = createKctvStreamLayer(channelKey);
  const media = document.createElement(channel.media === "audio" ? "audio" : "video");
  media.className = channel.media === "audio" ? "kctv-audio" : "kctv-video";
  media.controls = channel.media !== "audio";
  media.autoplay = channel.media !== "audio";
  media.muted = channel.media !== "audio";
  if (channel.media !== "audio") media.playsInline = true;
  media.setAttribute("aria-label", `${channel.label} 라이브`);
  layer.classList.toggle("kctv-audio-layer", channel.media === "audio");
  layer.append(media);
  if (channel.media === "audio") {
    layer.append(createRadioPlayer(channel, media));
  }

  const player = { node: layer, video: media, hlsInstance: null, renderToken, autoplay: channel.media !== "audio" };
  const mediaErrorMessage = channel.media === "audio" ? "라이브 오디오를 불러오지 못했습니다." : "라이브 영상을 불러오지 못했습니다.";

  const isValidPlayer = () =>
    kctvPlayerCache.get(channelKey) === player &&
    player.renderToken === renderToken &&
    kctvPlayerFrame.contains(layer);

  if (media.canPlayType("application/vnd.apple.mpegurl")) {
    media.src = channel.src;
    if (player.autoplay) playKctvPlayerSilently(player);
    return player;
  }

  ensureHlsScript()
    .then(() => {
      if (!isValidPlayer()) return;

      if (!window.Hls?.isSupported()) {
        showKctvPlayerMessage("이 브라우저에서 재생할 수 없습니다.", player);
        return;
      }

      const nextHlsInstance = new window.Hls({ enableWorker: true });
      player.hlsInstance = nextHlsInstance;
      nextHlsInstance.loadSource(channel.src);
      nextHlsInstance.attachMedia(media);
      nextHlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
        if (!isValidPlayer()) return;
        if (player.autoplay) playKctvPlayerSilently(player);
      });
      nextHlsInstance.on(window.Hls.Events.ERROR, (_event, data) => {
        if (data?.fatal && isValidPlayer()) showKctvPlayerMessage(mediaErrorMessage, player);
      });
    })
    .catch(() => {
      if (isValidPlayer()) showKctvPlayerMessage(mediaErrorMessage, player);
    });

  return player;
}

function createRadioPlayer(channel, media) {
  const player = document.createElement("div");
  const copy = document.createElement("div");
  const time = document.createElement("p");
  const status = document.createElement("div");
  const statusIcon = document.createElement("span");
  const statusLabel = document.createElement("span");
  const volume = document.createElement("label");
  const volumeIcon = document.createElement("span");
  const volumeRange = document.createElement("input");
  const actions = document.createElement("div");
  const playButton = document.createElement("button");
  const playIcon = document.createElement("span");
  const stopButton = document.createElement("button");
  const stopIcon = document.createElement("span");
  const record = document.createElement("div");

  player.className = "kctv-radio-player";
  copy.className = "kctv-radio-copy";
  time.className = "kctv-radio-time";
  status.className = "kctv-radio-status";
  statusIcon.className = "material-symbols-rounded";
  statusIcon.setAttribute("aria-hidden", "true");
  statusLabel.className = "kctv-radio-status-label";
  volume.className = "kctv-radio-volume";
  volumeIcon.className = "material-symbols-rounded";
  volumeIcon.setAttribute("aria-hidden", "true");
  volumeIcon.textContent = "volume_down";
  volumeRange.className = "kctv-radio-volume-range";
  volumeRange.type = "range";
  volumeRange.min = "0";
  volumeRange.max = "1";
  volumeRange.step = "0.01";
  volumeRange.value = "0.75";
  volumeRange.setAttribute("aria-label", "음량");
  actions.className = "kctv-radio-actions";
  playButton.className = "kctv-radio-action kctv-radio-action-play";
  playButton.type = "button";
  playButton.setAttribute("aria-label", `${channel.label} 재생`);
  playIcon.className = "material-symbols-rounded";
  playIcon.setAttribute("aria-hidden", "true");
  playIcon.textContent = "play_arrow";
  stopButton.className = "kctv-radio-action kctv-radio-action-stop";
  stopButton.type = "button";
  stopButton.setAttribute("aria-label", `${channel.label} 정지`);
  stopIcon.className = "material-symbols-rounded";
  stopIcon.setAttribute("aria-hidden", "true");
  stopIcon.textContent = "stop";
  record.className = "kctv-radio-record";
  record.setAttribute("aria-hidden", "true");

  media.volume = Number(volumeRange.value);
  time.textContent = formatRadioElapsed(media.currentTime);
  status.append(statusIcon, statusLabel);
  volume.append(volumeIcon, volumeRange);
  playButton.append(playIcon);
  stopButton.append(stopIcon);
  actions.append(playButton, stopButton);
  copy.append(time, status, volume, actions);
  player.append(copy, record);

  const updateVolume = () => {
    const volumeValue = media.muted ? 0 : media.volume;
    volumeRange.value = String(volumeValue);
    volumeRange.style.setProperty("--kctv-radio-volume", `${volumeValue * 100}%`);
    volumeIcon.textContent = volumeValue <= 0 ? "volume_off" : "volume_down";
    volume.classList.toggle("is-muted", volumeValue <= 0);
    volume.classList.toggle("is-high", volumeValue > 0.75);
    if (volumeValue > 0.75) volumeIcon.textContent = "volume_up";
  };
  const updateTime = () => {
    time.textContent = formatRadioElapsed(media.currentTime);
  };
  const updatePlayback = () => {
    const isPlaying = !media.paused && !media.ended;
    statusIcon.textContent = isPlaying ? "play_arrow" : "stop";
    statusLabel.textContent = isPlaying ? "PLAY" : "STOP";
    player.classList.toggle("is-playing", isPlaying);
    playButton.classList.toggle("active", isPlaying);
    stopButton.classList.toggle("active", !isPlaying);
  };

  playButton.addEventListener("click", () => {
    media.muted = false;
    media.play().catch(() => {});
  });
  stopButton.addEventListener("click", () => media.pause());
  volumeRange.addEventListener("input", () => {
    media.muted = false;
    media.volume = Number(volumeRange.value);
    updateVolume();
  });
  media.addEventListener("play", updatePlayback);
  media.addEventListener("pause", updatePlayback);
  media.addEventListener("ended", updatePlayback);
  media.addEventListener("timeupdate", updateTime);
  media.addEventListener("loadedmetadata", updateTime);
  media.addEventListener("volumechange", updateVolume);
  updateVolume();
  updatePlayback();

  return player;
}

function formatRadioElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function ensureHlsScript() {
  if (window.Hls) return Promise.resolve();
  if (hlsScriptLoad) return hlsScriptLoad;

  hlsScriptLoad = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = HLS_SCRIPT_URL;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });

  return hlsScriptLoad;
}

function showKctvPlayerMessage(message, player = null) {
  const host = player?.node || kctvPlayerFrame;
  host.querySelector(".kctv-player-message")?.remove();
  const node = document.createElement("div");
  node.className = "kctv-player-message";
  node.textContent = message;
  host.append(node);
}

function setKctvScheduleOpen(isOpen) {
  const supportsSchedule = activeKctvSupportsSchedule();
  if (supportsSchedule) kctvScheduleOpen = isOpen;
  const shouldOpen = supportsSchedule && kctvScheduleOpen;
  kctvSchedulePanel.hidden = !shouldOpen;
  kctvScheduleToggle.hidden = !supportsSchedule || shouldOpen;
  kctvPlayerLayout.classList.toggle("schedule-open", shouldOpen);
  kctvScheduleToggle.setAttribute("aria-expanded", String(shouldOpen));
  updateKctvPlayerScale();
  if (shouldOpen) scrollActiveProgramIntoView();
}

function activeKctvSupportsSchedule() {
  return activeKctvBroadcastConfig().type === "tv";
}

function updateKctvPlayerScale() {
  const source = activeKctvSourceConfig();
  const playerKind = activeKctvPlayerKind(source);
  const size = kctvPlayerBaseSize(playerKind);
  const shellHeight = kctvView.clientHeight || size.height;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const maxPlayerHeight = Math.min(size.height, Math.max(220, shellHeight - 160));
  const widthFromHeight = maxPlayerHeight * (size.width / size.height);
  const fitWidth = Math.min(size.width, Math.max(0, viewportWidth - 48), widthFromHeight);
  const fitHeight = fitWidth > 0 ? fitWidth * (size.height / size.width) : size.height;

  if (fitWidth > 0) {
    kctvPlayerFrame.style.setProperty("--kctv-player-fit-width", `${fitWidth.toFixed(3)}px`);
  }
  kctvView.style.setProperty("--kctv-player-half-height", `${(fitHeight / 2).toFixed(3)}px`);

  const width = kctvPlayerFrame.clientWidth || fitWidth || size.width;
  const scaleBase = size.width;
  const scale = Math.max(0.1, width / scaleBase);
  kctvPlayerFrame.style.setProperty("--kctv-player-scale", scale.toFixed(6));
  kctvPlayerFrame.classList.toggle("radio", playerKind === "radio");
  kctvPlayerFrame.classList.toggle("koryo-radio", playerKind === "koryo-radio");
}

function kctvPlayerBaseSize(playerKind) {
  if (playerKind === "radio") {
    return { width: RADIO_PLAYER_BASE_WIDTH, height: RADIO_PLAYER_BASE_HEIGHT };
  }
  if (playerKind === "koryo-radio") {
    return { width: KORYO_RADIO_PLAYER_BASE_WIDTH, height: KORYO_RADIO_PLAYER_BASE_HEIGHT };
  }
  return {
    width: activeKctvSource === "kcna" ? KCNA_PLAYER_WIDTH : KORYO_PLAYER_BASE_WIDTH,
    height: KCTV_PLAYER_BASE_HEIGHT,
  };
}

function moveTimetableDate(delta) {
  if (activeKctvBroadcastConfig().type === "radio") return;
  const nextYmd = addDaysToYmd(activeTimetableYmd, delta);
  if (nextYmd > koreaTodayYmd() || nextYmd === activeTimetableYmd) return;
  loadTimetableForDate(nextYmd);
}

async function loadLatestTimetable() {
  const today = koreaTodayYmd();
  await loadTimetableForDate(today);
}

async function loadTimetableForDate(ymd) {
  const loadToken = ++timetableLoadToken;
  activeTimetableYmd = ymd;
  renderTimetableState("편성표를 불러오는 중입니다.");

  try {
    const entries = await fetchTimetableEntries(ymd);
    if (loadToken !== timetableLoadToken || activeTimetableYmd !== ymd) return;
    activeTimetableEntries = entries;
  } catch (error) {
    if (loadToken !== timetableLoadToken || activeTimetableYmd !== ymd) return;
    console.warn("Failed to load timetable", error);
    activeTimetableEntries = [];
    renderTimetableState("편성표를 불러오지 못했습니다.");
    return;
  }

  renderTimetable();
}

async function fetchTimetableEntries(ymd) {
  if (timetableCache.has(ymd)) return timetableCache.get(ymd);

  let entries = [];

  try {
    const data = await fetchTimetableJson(buildTimetableApiUrl(ymd));
    entries = extractTimetableItems(data)
      .filter((item) => String(item.frmtn_ymd || "") === ymd)
      .map((item) => ({
        time: formatApiTime(item.frmtn_time),
        title: normalizeText(item.sj),
      }))
      .filter((entry) => /^\d{2}:\d{2}$/.test(entry.time) && entry.title)
      .sort((left, right) => left.time.localeCompare(right.time));
  } catch (error) {
    console.warn("Failed to load timetable from OpenAPI", error);
  }

  if (!entries.length) {
    entries = await fetchTimetableEntriesFromHtml(ymd);
  }

  timetableCache.set(ymd, entries);
  return entries;
}

function buildTimetableApiUrl(ymd) {
  const params = new URLSearchParams({
    ServiceKey: TIMETABLE_SERVICE_KEY,
    pageNo: "1",
    numOfRows: String(TIMETABLE_ROWS_PER_DAY),
    bgng_ymd: ymd,
    end_ymd: ymd,
    bgng_time: "0000",
    end_time: "2359",
  });

  return `${TIMETABLE_API_URL}?${params.toString()}`;
}

async function fetchTimetableJson(url) {
  const text = await fetchTextWithFallback(url);
  return JSON.parse(text);
}

async function fetchTimetableEntriesFromHtml(ymd) {
  const url = buildTimetableHtmlUrl(ymd);
  const source = await fetchTextFromCandidates([
    `${READABLE_PROXY_URL}${url}`,
    url,
    `${CORS_PROXY_URL}${encodeURIComponent(url)}`,
  ]);
  const entries = parseLiveTimetableEntries(source);
  return entries.sort((left, right) => left.time.localeCompare(right.time));
}

function buildTimetableHtmlUrl(ymd) {
  const params = new URLSearchParams({
    brdcstYmd: ymd,
    pageIndex: "1",
    menuId: "",
  });

  return `${TIMETABLE_HTML_DETAIL_URL}?${params.toString()}`;
}

async function fetchTextWithFallback(url) {
  return fetchTextFromCandidates([url, `${CORS_PROXY_URL}${encodeURIComponent(url)}`]);
}

async function fetchTextFromCandidates(candidates) {
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Timetable request failed");
}

function parseLiveTimetableEntries(source) {
  const htmlEntries = parseHtmlTimetableEntries(source);
  if (htmlEntries.length) return htmlEntries;
  return parseMarkdownTimetableEntries(source);
}

function parseHtmlTimetableEntries(html) {
  const documentNode = new DOMParser().parseFromString(html, "text/html");
  return [...documentNode.querySelectorAll("#index tbody tr")]
    .map((row) => {
      const cells = [...row.querySelectorAll("td")];
      const time = normalizeText(cells[0]?.textContent);
      const title = normalizeText(cells[1]?.textContent);
      return /^\d{2}:\d{2}$/.test(time) && title ? { time, title } : null;
    })
    .filter(Boolean);
}

function parseMarkdownTimetableEntries(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\|\s*(\d{2}:\d{2})\s*\|\s*(.*?)\s*\|$/);
      if (!match) return null;

      const title = normalizeText(match[2]);
      return title && title !== "---" ? { time: match[1], title } : null;
    })
    .filter(Boolean);
}

function extractTimetableItems(data) {
  const items =
    data?.items ||
    data?.response?.body?.items?.item ||
    data?.response?.body?.items ||
    data?.body?.items?.item ||
    data?.body?.items ||
    [];

  if (Array.isArray(items)) return items;
  if (items && typeof items === "object") return [items];
  return [];
}

function renderTimetableState(message) {
  if (activeKctvBroadcastConfig().type === "radio") {
    renderTimetable();
    return;
  }

  kctvScheduleDate.textContent = formatTimetableDate(activeTimetableYmd);
  kctvProgramList.replaceChildren(createTimetableState(message));
  updateTimetableButtons();
}

function renderTimetable() {
  if (activeKctvBroadcastConfig().type === "radio") {
    kctvScheduleDate.textContent = activeKctvBroadcastConfig().label;
    kctvProgramList.replaceChildren(createTimetableState("라디오 편성표는 제공되지 않습니다."));
    updateTimetableButtons();
    return;
  }

  kctvScheduleDate.textContent = formatTimetableDate(activeTimetableYmd);
  const entries = activeTimetableEntries;
  const activeIndex = currentProgramIndex(entries, activeTimetableYmd);

  if (!entries.length) {
    kctvProgramList.replaceChildren(createTimetableState("해당 날짜의 편성표가 없습니다."));
    updateTimetableButtons();
    return;
  }

  kctvProgramList.replaceChildren(
    ...entries.map((entry, index) => {
      const item = document.createElement("div");
      const time = document.createElement("p");
      const title = document.createElement("p");

      item.className = "kctv-program-entry";
      item.classList.toggle("active", index === activeIndex);
      time.className = "kctv-program-time";
      title.className = "kctv-program-title";
      time.textContent = entry.time;
      title.textContent = entry.title;
      item.append(time, title);
      return item;
    }),
  );
  updateTimetableButtons();
  scrollActiveProgramIntoView();
}

function createTimetableState(message) {
  const node = document.createElement("p");
  node.className = "kctv-program-state";
  node.textContent = message;
  return node;
}

function updateTimetableButtons() {
  const isRadio = activeKctvBroadcastConfig().type === "radio";
  kctvDatePrev.disabled = isRadio;
  kctvDateNext.disabled = isRadio || activeTimetableYmd >= koreaTodayYmd();
}

function currentProgramIndex(entries, ymd) {
  if (!entries.length) return -1;
  const now = koreaNowParts();
  if (now.ymd !== ymd) return -1;

  const currentMinutes = now.hour * 60 + now.minute;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (timeToMinutes(entries[index].time) <= currentMinutes) return index;
  }
  return -1;
}

function scrollActiveProgramIntoView() {
  if (!activeKctvSupportsSchedule() || !kctvScheduleOpen) return;

  window.requestAnimationFrame(() => {
    const activeItem = kctvProgramList.querySelector(".kctv-program-entry.active");
    if (!activeItem) return;

    activeItem.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  });
}

function koreaNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(new Date())
    .reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});

  return {
    ymd: `${parts.year}${parts.month}${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function timeToMinutes(time) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function koreaTodayYmd() {
  return koreaNowParts().ymd;
}

function addDaysToYmd(ymd, delta) {
  if (!/^\d{8}$/.test(ymd)) return koreaTodayYmd();
  const date = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))));
  date.setUTCDate(date.getUTCDate() + delta);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
}

function formatApiTime(value) {
  const digits = String(value || "").replace(/\D/g, "").padStart(4, "0").slice(-4);
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
}

function formatTimetableDate(ymd) {
  if (!/^\d{8}$/.test(ymd)) return "편성표";
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  return `${year}년 ${month}월 ${day}일`;
}

function normalizeText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
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
