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
const ROUTE_MUSIC = "music";
const ROUTE_NEWS = "news";
const ROUTE_LIVE = "live";
const ROUTE_SEARCH = "search";
const MUSIC_PATH = "/music";
const NEWS_PATH = "/news";
const LIVE_PATH = "/live";
const SEARCH_PATH = "/search";
const LIVE_DISCLAIMER_STORAGE_KEY = "live-disclaimer-dismissed";
const R2_ASSET_BASE_URL = "https://pub-a12b2bbd25db44479f7ca23251a65bef.r2.dev";
const MUSIC_ASSET_BASE_URL = "https://pub-442c73edbe954e7fa0b162c33f3fc7d8.r2.dev";
const MUSIC_LIST_CANDIDATE_PATHS = ["music/musiclist", "music-list.json", "music.json", "music/music-list.json", "list.json"];
const MUSIC_PLAYLIST_CANDIDATE_PATHS = ["music/playlists.json", "music/playlistlist", "music/playlists", "playlists.json"];
const MUSIC_RECENT_STORAGE_KEY = "nkarchive-music-recent-track-ids";
const MUSIC_RECENT_LIMIT = 24;
const KORYO_PLAYER_BASE_WIDTH = 962;
const KORYO_IFRAME_DESKTOP_WIDTH = 1649;
const KORYO_IFRAME_DESKTOP_HEIGHT = 685;
const KORYO_IFRAME_DESKTOP_CROP_LEFT = -157;
const KORYO_IFRAME_DESKTOP_CROP_TOP = -144;
const KORYO_MOBILE_IFRAME_MIN_WIDTH = 320;
const KORYO_MOBILE_IFRAME_MAX_WIDTH = 430;
const KORYO_MOBILE_IFRAME_HEIGHT = 760;
const KORYO_MOBILE_PAGE_PADDING_X = 16;
const KORYO_MOBILE_PLAYER_TOP = 72;
const VIDEO_PLAYER_BASE_HEIGHT = 541.125;
const KCNA_PLAYER_WIDTH = 721.5;
const RADIO_PLAYER_BASE_WIDTH = 700;
const RADIO_PLAYER_BASE_HEIGHT = 400;
const KORYO_RADIO_PLAYER_BASE_WIDTH = 500;
const KORYO_RADIO_PLAYER_BASE_HEIGHT = 74;
const KORYO_RADIO_IFRAME_HEIGHT = 322;
const KORYO_RADIO_CROP_LEFT = -573.5;
const KORYO_RADIO_KCBS_CROP_TOP = -248;
const KORYO_RADIO_VOK_CROP_TOP = -224;
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
const LIVE_FOOTER_COPY = [
  "본 사이트는 북한 정부 또는 조선노동당, 조성중앙텔레비전과는 전혀 관계가 없으며, 이들을 지지하지도 옹호하지도 않고 오로지 학문적인 목적으로 개설되었음을 알려드립니다. 간첩 신고는 국번 없이 111",
  "Livestream sources from https://koryofront.org/ and https://www.intchoson.com/. Timetable from [통일부 북한정보포털](https://nkinfo.unikorea.go.kr/nkp/tvPrgr/list.do?menuId=NK_TVPRGR).",
];
const MUSIC_ARCHIVE_ARTIST = "북한음악아카이브";
const MUSIC_FOOTER_COPY = [
  "본 사이트는 북한 정부 또는 조선노동당과는 전혀 관계가 없으며, 이들을 지지하지도 옹호하지도 않고 오로지 학문적인 목적으로 개설되었음을 알려드립니다. 간첩 신고는 국번 없이 111",
  "Music, sheet, and list assets are loaded from the configured R2 music storage.",
];
const MUSIC_FALLBACK_TRACKS = [
  {
    id: "janggunim-chukjibeop-sseusinda",
    title: "장군님 축지법 쓰신다",
    artist: "보천보전자악단",
    album: "왕재산 선곡 1",
    year: "2024",
    duration: 179,
    audio: "music/janggunim-chukjibeop-sseusinda.mp3",
    cover: "covers/janggunim-chukjibeop-sseusinda.png",
    sheet: "sheets/janggunim-chukjibeop-sseusinda.png",
    lyrics: [
      "방선천리 주름잡아",
      "장군님 가신다",
      "수령님 쓰시던 축지법",
      "오늘은 장군님 쓰신다",
      "백두의 전법 신묘한 전법",
      "장군님 쓰신다",
      "동에 번쩍 서에 번쩍",
      "천하를 쥐락펴락",
      "구름타고 오르신다",
      "최전연고지우에",
      "수령님  쓰시던 축지법",
      "오늘은 장군님 쓰신다",
      "백두의 전법 신묘한 전법",
    ],
  },
  {
    id: "eodie-gyesimnikka-geuriun-janggunim",
    title: "어디에 계십니까 그리운 장군님",
    artist: "왕재산예술단",
    album: "그리움을 담아",
    year: "2024",
    duration: 299,
    audio: "music/eodie-gyesimnikka-geuriun-janggunim.mp3",
    cover: "covers/eodie-gyesimnikka-geuriun-janggunim.png",
  },
  {
    id: "nae-nara-jeillo-joa",
    title: "내 나라 제일로 좋아",
    artist: "보천보전자악단",
    album: "추억의 노래",
    year: "2023",
    duration: 241,
    audio: "music/nae-nara-jeillo-joa.mp3",
    cover: "covers/nae-nara-jeillo-joa.png",
  },
  {
    id: "hwiparam",
    title: "휘파람",
    artist: "전혜영",
    album: "추억의 노래",
    year: "2023",
    duration: 214,
    audio: "music/hwiparam.mp3",
    cover: "covers/hwiparam.png",
  },
  {
    id: "cheonrima-dallinda",
    title: "천리마 달린다",
    artist: "보천보전자악단",
    album: "천리마의 노래",
    year: "2023",
    duration: 223,
    audio: "music/cheonrima-dallinda.mp3",
    cover: "covers/cheonrima-dallinda.png",
  },
  {
    id: "urireul-bureowohara",
    title: "우리를 부러워하라",
    artist: "왕재산예술단",
    album: "우리의 노래",
    year: "2022",
    duration: 246,
    audio: "music/urireul-bureowohara.mp3",
    cover: "covers/urireul-bureowohara.png",
  },
  {
    id: "aegukka",
    title: "조선민주주의인민공화국 국가",
    artist: "국립교향악단",
    album: "국가",
    year: "2024",
    duration: 189,
    audio: "music/aegukka.mp3",
    cover: "covers/aegukka.png",
  },
  {
    id: "seolnuna-naeryeora",
    title: "설눈아 내려라",
    artist: "보천보전자악단",
    album: "겨울 선곡",
    year: "2023",
    duration: 205,
    audio: "music/seolnuna-naeryeora.mp3",
    cover: "covers/seolnuna-naeryeora.png",
  },
  {
    id: "gonggyeokjeonida",
    title: "공격전이다",
    artist: "보천보전자악단",
    album: "전투적 노래",
    year: "2023",
    duration: 232,
    audio: "music/gonggyeokjeonida.mp3",
    cover: "covers/gonggyeokjeonida.png",
  },
  {
    id: "arirang",
    title: "아리랑",
    artist: "민요",
    album: "민요 선곡",
    year: "2022",
    duration: 198,
    audio: "music/arirang.mp3",
    cover: "covers/arirang.png",
  },
  {
    id: "urineun-joseon-saram",
    title: "우리는 조선사람",
    artist: "왕재산예술단",
    album: "최신 발매곡",
    year: "2024",
    duration: 226,
    audio: "music/urineun-joseon-saram.mp3",
    cover: "covers/urineun-joseon-saram.png",
  },
  {
    id: "chingeunhan-eobeoi",
    title: "친근한 어버이",
    artist: "보천보전자악단",
    album: "최신 발매곡",
    year: "2024",
    duration: 236,
    audio: "music/chingeunhan-eobeoi.mp3",
    cover: "covers/chingeunhan-eobeoi.png",
  },
  {
    id: "uriui-727",
    title: "우리의 7.27",
    artist: "왕재산예술단",
    album: "최신 발매곡",
    year: "2024",
    duration: 217,
    audio: "music/uriui-727.mp3",
    cover: "covers/uriui-727.png",
  },
  {
    id: "uriui-sowoneun-tongil",
    title: "우리의 소원은 통일",
    artist: "합창",
    album: "통일 선곡",
    year: "2023",
    duration: 210,
    audio: "music/uriui-sowoneun-tongil.mp3",
    cover: "covers/uriui-sowoneun-tongil.png",
  },
];
const BROADCASTS = {
  kctv: {
    label: "조선중앙TV",
    type: "tv",
    defaultSource: "koryo",
    sources: {
      koryo: {
        label: "고려전선",
        type: "hls",
        media: "video",
        src: "https://kctv.koryofront.org/stream/index.m3u8",
      },
      intchoson: {
        label: "인트조선",
        type: "hls",
        media: "video",
        src: "https://stream.intchoson.com/kctv/index.m3u8",
      },
    },
  },
  kcbs: {
    label: "조선중앙방송",
    type: "radio",
    defaultSource: "koryo",
    sources: {
      koryo: {
        label: "고려전선",
        type: "hls",
        media: "audio",
        src: "https://kctv.koryofront.org/stream/kcradio1/index.m3u8",
      },
      intchoson: {
        label: "인트조선",
        type: "hls",
        media: "audio",
        src: "https://stream.intchoson.com/kcbs/index.m3u8",
      },
    },
  },
  vok: {
    label: "조선의 소리",
    type: "radio",
    defaultSource: "koryo",
    sources: {
      koryo: {
        label: "고려전선",
        type: "hls",
        media: "audio",
        src: "https://kctv.koryofront.org/stream/kcradio2/index.m3u8",
      },
      intchoson: {
        label: "인트조선",
        type: "hls",
        media: "audio",
        src: "https://stream.intchoson.com/vok/index.m3u8",
      },
    },
  },
};
const logoLink = document.querySelector(".logo");
const navigationBar = document.querySelector(".navigation-bar");
const menuToggle = document.querySelector("#siteMenuToggle");
const menuToggleIcon = menuToggle?.querySelector(".menu-toggle-icon");
const navLinks = [...document.querySelectorAll(".site-nav a")];
const archiveView = document.querySelector("#archiveView");
const newsView = document.querySelector("#newsView");
const liveView = document.querySelector("#liveView");
const musicView = document.querySelector("#musicView");
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
const liveTabs = [...document.querySelectorAll(".live-tab")];
const liveSourceControl = document.querySelector("#liveSourceControl");
const liveSourceButton = document.querySelector("#liveSourceButton");
const liveSourceButtonText = document.querySelector("#liveSourceButtonText");
const liveSourceMenu = document.querySelector("#liveSourceMenu");
const livePlayerLayout = document.querySelector("#livePlayerLayout");
const livePlayerFrame = document.querySelector("#livePlayerFrame");
const liveSchedulePanel = document.querySelector("#liveSchedulePanel");
const liveScheduleToggle = document.querySelector("#liveScheduleToggle");
const liveScheduleClose = document.querySelector("#liveScheduleClose");
const liveScheduleDate = document.querySelector("#liveScheduleDate");
const liveProgramList = document.querySelector("#liveProgramList");
const liveDatePrev = document.querySelector("#liveDatePrev");
const liveDateNext = document.querySelector("#liveDateNext");
const liveDisclaimer = document.querySelector("#liveDisclaimer");
const liveDisclaimerClose = document.querySelector("#liveDisclaimerClose");
const liveDisclaimerDontShow = document.querySelector("#liveDisclaimerDontShow");
const musicHeaderSearch = document.querySelector("#musicHeaderSearch");
const musicHomeSections = document.querySelector("#musicHomeSections");
const musicLibraryContent = document.querySelector("#musicLibraryContent");
const musicSearchOverlay = document.querySelector("#musicSearchOverlay");
const musicSearchInput = document.querySelector("#musicSearchInput");
const musicSearchClose = document.querySelector("#musicSearchClose");
const musicSearchResults = document.querySelector("#musicSearchResults");
const musicSidebarItems = [...document.querySelectorAll(".music-sidebar-item")];
const musicModeButtons = [...document.querySelectorAll(".music-mode-button")];
const musicLyricsPanel = document.querySelector("#musicLyricsPanel");
const musicQueuePanel = document.querySelector("#musicQueuePanel");
const musicLargeCover = document.querySelector("#musicLargeCover");
const musicSheetImage = document.querySelector("#musicSheetImage");
const musicSheetFallback = document.querySelector("#musicSheetFallback");
const musicProgressFill = document.querySelector("#musicProgressFill");
const musicPrevButton = document.querySelector("#musicPrevButton");
const musicPlayButton = document.querySelector("#musicPlayButton");
const musicNextButton = document.querySelector("#musicNextButton");
const musicTimeLabel = document.querySelector("#musicTimeLabel");
const musicNowTitle = document.querySelector("#musicNowTitle");
const musicNowMeta = document.querySelector("#musicNowMeta");
const musicMiniCover = document.querySelector("#musicMiniCover");
const musicExpandButton = document.querySelector("#musicExpandButton");
const musicBottomPlayer = document.querySelector(".music-bottom-player");
const musicAudio = document.querySelector("#musicAudio");

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
let activeBroadcast = "kctv";
let activeSource = "koryo";
let renderedPlayerKey = null;
let liveScheduleOpen = false;
let hlsScriptLoad = null;
let livePlayerResizeObserver = null;
let livePlayerRenderToken = 0;
let livePlayerSlideAnimation = null;
let activeTimetableYmd = koreaTodayYmd();
let activeTimetableEntries = [];
let timetableCache = new Map();
let timetableLoadStarted = false;
let timetableLoadToken = 0;
let liveDisclaimerDismissedForVisit = false;
let liveDisclaimerPreviousFocus = null;
let recentMusicTrackIds = readRecentMusicTrackIds();
let musicPlaylists = [];
let musicLibrary = createFallbackMusicLibrary();
let activeMusicTrackId = "";
let activeMusicMode = "home";
let musicSearchOpen = false;
let activeMusicLyricIndex = 0;
const musicSheetAvailability = new Map();
const mobileMenuMediaQuery = window.matchMedia("(max-width: 1100px)");
const koryoMobileMediaQuery = window.matchMedia("(max-width: 768px)");

const sampleOverrides = new Map();
const fontLoadStates = new Map();
const fontLoadQueue = [];
const livePlayerCache = new Map();
const sourceByBroadcast = new Map(
  Object.entries(BROADCASTS).map(([broadcastKey, broadcast]) => [broadcastKey, broadcast.defaultSource]),
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
  bindLiveEvents();
  bindMusicEvents();
  renderRoute();
  loadMusicLibrary()
    .then((library) => {
      musicLibrary = library;
      renderMusicView();
    })
    .catch(() => renderMusicView());

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
    if (link.dataset.route === ROUTE_SEARCH) continue;
    link.addEventListener("click", navigateRoute);
  }
  for (const link of navLinks) link.addEventListener("click", closeMobileMenu);
  logoLink.addEventListener("click", navigateRoute);
  menuToggle?.addEventListener("click", toggleMobileMenu);
  document.addEventListener("click", closeMobileMenuOnOutsideClick);
  document.addEventListener("keydown", handleMobileMenuKeydown);
  const closeMenuOnDesktop = (event) => {
    if (!event.matches) closeMobileMenu();
  };
  if (typeof mobileMenuMediaQuery.addEventListener === "function") {
    mobileMenuMediaQuery.addEventListener("change", closeMenuOnDesktop);
  } else {
    mobileMenuMediaQuery.addListener(closeMenuOnDesktop);
  }
}

function navigateRoute(event) {
  const url = new URL(event.currentTarget.href, window.location.href);
  if (url.origin !== window.location.origin) return;

  event.preventDefault();
  const route =
    event.currentTarget.dataset.route ||
    url.searchParams.get("route") ||
    (url.pathname.replace(/\/+$/, "") === LIVE_PATH
      ? ROUTE_LIVE
      : url.pathname.replace(/\/+$/, "") === MUSIC_PATH
        ? ROUTE_MUSIC
        : url.pathname.replace(/\/+$/, "") === NEWS_PATH
          ? ROUTE_NEWS
          : ROUTE_FONT);
  const pathname = route === ROUTE_LIVE
    ? LIVE_PATH
    : route === ROUTE_MUSIC
      ? MUSIC_PATH
      : route === ROUTE_NEWS
        ? NEWS_PATH
        : "/font";
  if (route === ROUTE_MUSIC && currentRoute() === ROUTE_MUSIC) collapseMusicToHome();

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
  if (requestedRoute === ROUTE_LIVE) return ROUTE_LIVE;
  if (requestedRoute === ROUTE_MUSIC) return ROUTE_MUSIC;
  if (requestedRoute === ROUTE_NEWS) return ROUTE_NEWS;
  if (requestedRoute === ROUTE_SEARCH) return ROUTE_SEARCH;
  if (requestedRoute === ROUTE_FONT) return ROUTE_FONT;

  const path = window.location.pathname.replace(/\/+$/, "") || "/font";
  if (path === LIVE_PATH) return ROUTE_LIVE;
  if (path === MUSIC_PATH) return ROUTE_MUSIC;
  if (path === NEWS_PATH) return ROUTE_NEWS;
  if (path === SEARCH_PATH) return ROUTE_SEARCH;
  return ROUTE_FONT;
}

function renderRoute() {
  closeMobileMenu();
  const route = currentRoute();
  const isLive = route === ROUTE_LIVE;
  const isMusic = route === ROUTE_MUSIC;
  const isNews = route === ROUTE_NEWS;
  const isSearch = route === ROUTE_SEARCH;

  const currentPath = window.location.pathname.replace(/\/+$/, "") || "/";
  if (currentPath === "/" || window.location.search) {
    window.history.replaceState(null, "", isLive ? LIVE_PATH : isMusic ? MUSIC_PATH : isNews ? NEWS_PATH : isSearch ? SEARCH_PATH : "/font");
  }
  document.title = isLive ? "북한방송아카이브" : isMusic ? "북한음악아카이브" : isNews ? "북한뉴스아카이브" : isSearch ? "북한 공개자료 통합검색" : "북한폰트아카이브";
  document.documentElement.dataset.route = route;
  document.body.dataset.view = route;
  archiveView.hidden = isLive || isMusic || isNews || isSearch;
  if (newsView) newsView.hidden = !isNews;
  if (liveView) liveView.hidden = !isLive;
  if (musicView) musicView.hidden = !isMusic;
  if (!isLive) silenceAllLivePlayers();
  if (!isMusic) pauseMusic(false);
  logoLink.textContent = isLive ? "★Live" : isMusic ? "★Music" : isNews ? "★News" : isSearch ? "★Search" : "★Font";
  logoLink.setAttribute("aria-label", isLive ? "방송 홈" : isMusic ? "음악 홈" : isNews ? "뉴스 홈" : isSearch ? "검색 홈" : "폰트 아카이브 홈");
  logoLink.href = isLive ? LIVE_PATH : isMusic ? MUSIC_PATH : isNews ? NEWS_PATH : isSearch ? SEARCH_PATH : "/font";
  siteFooter.dataset.view = route;
  siteFooter.hidden = isMusic || isNews || isSearch;
  if (!isMusic && !isNews) renderFooterCopy(isLive ? LIVE_FOOTER_COPY : FONT_FOOTER_COPY);

  for (const link of navLinks) {
    const isActive = link.dataset.route === route;
    link.classList.toggle("active", isActive);
    if (link.dataset.route) link.setAttribute("aria-current", isActive ? "page" : "false");
  }

  if (isLive) {
    renderLiveView();
    showLiveDisclaimerIfNeeded();
  } else if (isMusic) {
    hideLiveDisclaimer(false);
    liveDisclaimerDismissedForVisit = false;
    renderMusicView();
  } else if (!isNews && fontArchiveReady) {
    hideLiveDisclaimer(false);
    liveDisclaimerDismissedForVisit = false;
    renderVirtualGrid(true);
  } else {
    hideLiveDisclaimer(false);
    liveDisclaimerDismissedForVisit = false;
  }
}

function toggleMobileMenu() {
  setMobileMenuOpen(!document.body.classList.contains("mobile-menu-open"));
}

function closeMobileMenu() {
  setMobileMenuOpen(false);
}

function setMobileMenuOpen(open) {
  const shouldOpen = Boolean(open) && mobileMenuMediaQuery.matches;
  document.body.classList.toggle("mobile-menu-open", shouldOpen);
  navigationBar?.classList.toggle("menu-open", shouldOpen);
  menuToggle?.classList.toggle("active", shouldOpen);
  menuToggle?.setAttribute("aria-expanded", String(shouldOpen));
  menuToggle?.setAttribute("aria-label", shouldOpen ? "메뉴 닫기" : "메뉴 열기");
  if (menuToggleIcon) menuToggleIcon.textContent = shouldOpen ? "close" : "drag_handle";
}

function closeMobileMenuOnOutsideClick(event) {
  if (!document.body.classList.contains("mobile-menu-open")) return;
  if (navigationBar?.contains(event.target)) return;
  closeMobileMenu();
}

function handleMobileMenuKeydown(event) {
  if (event.key === "Escape") closeMobileMenu();
}

function renderFooterCopy(lines) {
  siteFooter.replaceChildren(
    ...lines.map((line) => {
      const paragraph = document.createElement("p");
      appendLinkedFooterText(paragraph, line);
      return paragraph;
    }),
  );
}

function appendLinkedFooterText(paragraph, line) {
  const markdownLinkPattern = /\[([^\]]+)]\((https?:\/\/[^)]+)\)/g;
  let cursor = 0;

  for (const match of line.matchAll(markdownLinkPattern)) {
    if (match.index > cursor) appendAutoLinkedFooterText(paragraph, line.slice(cursor, match.index));

    const anchor = document.createElement("a");
    anchor.href = match[2];
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = match[1];
    paragraph.append(anchor);
    cursor = match.index + match[0].length;
  }

  if (cursor < line.length) appendAutoLinkedFooterText(paragraph, line.slice(cursor));
}

function appendAutoLinkedFooterText(paragraph, line) {
  const urlPattern = /https?:\/\/[^\s,]+/g;
  let cursor = 0;

  for (const match of line.matchAll(urlPattern)) {
    if (match.index > cursor) paragraph.append(document.createTextNode(line.slice(cursor, match.index)));

    const fullMatch = match[0];
    const url = fullMatch.replace(/[.)\]]+$/, "");
    const trailingText = fullMatch.slice(url.length);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = url;
    paragraph.append(anchor);
    if (trailingText) paragraph.append(document.createTextNode(trailingText));
    cursor = match.index + fullMatch.length;
  }

  if (cursor < line.length) paragraph.append(document.createTextNode(line.slice(cursor)));
}

function bindLiveEvents() {
  for (const tab of liveTabs) {
    tab.addEventListener("click", () => {
      const broadcast = tab.dataset.broadcast;
      if (!BROADCASTS[broadcast] || broadcast === activeBroadcast) return;
      sourceByBroadcast.set(activeBroadcast, activeSource);
      activeBroadcast = broadcast;
      activeSource = sourceByBroadcast.get(broadcast) || BROADCASTS[broadcast].defaultSource;
      ensureActiveSource();
      renderedPlayerKey = null;
      closeSourceMenu();
      renderBroadcastTabs();
      renderSourceMenu();
      renderLivePlayer();
      setLiveScheduleOpen(liveScheduleOpen);
      renderTimetable();
    });
  }

  liveSourceButton.addEventListener("click", toggleSourceMenu);
  liveScheduleToggle.addEventListener("click", () => setLiveScheduleOpen(true));
  liveScheduleClose.addEventListener("click", () => setLiveScheduleOpen(false));
  liveDatePrev.addEventListener("click", () => moveTimetableDate(-1));
  liveDateNext.addEventListener("click", () => moveTimetableDate(1));
  document.addEventListener("click", closeSourceMenuOnOutsideClick);
  document.addEventListener("keydown", closeSourceMenuOnEscape);
  liveDisclaimerClose?.addEventListener("click", dismissLiveDisclaimer);
  liveDisclaimer?.addEventListener("keydown", handleLiveDisclaimerKeydown);

  if (typeof ResizeObserver !== "undefined") {
    livePlayerResizeObserver = new ResizeObserver(updateLivePlayerScale);
    livePlayerResizeObserver.observe(livePlayerFrame);
  }
  window.addEventListener("resize", debounce(updateLivePlayerScale, 80));
  addMediaQueryChangeListener(koryoMobileMediaQuery, updateLivePlayerScale);
}

function showLiveDisclaimerIfNeeded() {
  if (!liveDisclaimer || liveDisclaimerDismissedForVisit || isLiveDisclaimerDismissedPermanently()) return;
  if (!liveDisclaimer.hidden) return;

  liveDisclaimerPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  liveDisclaimer.hidden = false;
  window.requestAnimationFrame(() => liveDisclaimerClose?.focus());
}

function dismissLiveDisclaimer() {
  liveDisclaimerDismissedForVisit = true;
  if (liveDisclaimerDontShow?.checked) persistLiveDisclaimerDismissal();
  hideLiveDisclaimer(true);
}

function hideLiveDisclaimer(restoreFocus) {
  if (!liveDisclaimer || liveDisclaimer.hidden) return;
  const shouldRestoreFocus = restoreFocus && liveDisclaimer.contains(document.activeElement);
  liveDisclaimer.hidden = true;
  if (shouldRestoreFocus) liveDisclaimerPreviousFocus?.focus?.();
  liveDisclaimerPreviousFocus = null;
}

function handleLiveDisclaimerKeydown(event) {
  if (liveDisclaimer?.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    dismissLiveDisclaimer();
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = [...liveDisclaimer.querySelectorAll("button, input, a, [tabindex]:not([tabindex='-1'])")].filter(
    (node) => !node.disabled && node.offsetParent !== null,
  );
  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function isLiveDisclaimerDismissedPermanently() {
  try {
    return window.localStorage.getItem(LIVE_DISCLAIMER_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function persistLiveDisclaimerDismissal() {
  try {
    window.localStorage.setItem(LIVE_DISCLAIMER_STORAGE_KEY, "true");
  } catch {}
}

function renderLiveView() {
  renderBroadcastTabs();
  renderSourceMenu();
  renderLivePlayer();
  setLiveScheduleOpen(liveScheduleOpen);
  renderTimetable();
  if (!timetableLoadStarted) {
    timetableLoadStarted = true;
    loadLatestTimetable();
  }
}

function renderBroadcastTabs() {
  for (const tab of liveTabs) {
    const selected = tab.dataset.broadcast === activeBroadcast;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
  }
}

function renderSourceMenu() {
  ensureActiveSource();
  const broadcast = activeBroadcastConfig();
  const sourceEntries = Object.entries(broadcast.sources);

  liveSourceButtonText.textContent = broadcast.sources[activeSource].label;
  liveSourceMenu.replaceChildren(
    ...sourceEntries.map(([sourceKey, source]) => {
      const button = document.createElement("button");
      const label = document.createElement("span");

      button.className = "category-option";
      button.type = "button";
      button.setAttribute("role", "option");
      button.dataset.source = sourceKey;
      button.setAttribute("aria-selected", String(sourceKey === activeSource));
      label.textContent = source.label;
      button.append(label);
      button.addEventListener("click", () => selectSourceOption(sourceKey));
      return button;
    }),
  );
}

function toggleSourceMenu() {
  const isOpen = liveSourceControl.classList.toggle("open");
  liveSourceButton.setAttribute("aria-expanded", String(isOpen));
}

function closeSourceMenu() {
  liveSourceControl.classList.remove("open");
  liveSourceButton.setAttribute("aria-expanded", "false");
}

function closeSourceMenuOnOutsideClick(event) {
  if (liveSourceControl.contains(event.target)) return;
  closeSourceMenu();
}

function closeSourceMenuOnEscape(event) {
  if (event.key === "Escape") closeSourceMenu();
}

function selectSourceOption(sourceKey) {
  const broadcast = activeBroadcastConfig();
  if (!broadcast.sources[sourceKey]) return;

  closeSourceMenu();
  if (sourceKey === activeSource) return;

  activeSource = sourceKey;
  sourceByBroadcast.set(activeBroadcast, sourceKey);
  renderedPlayerKey = null;
  renderSourceMenu();
  renderLivePlayer();
}

function activeBroadcastConfig() {
  return BROADCASTS[activeBroadcast] || BROADCASTS.kctv;
}

function activeSourceConfig() {
  const broadcast = activeBroadcastConfig();
  return broadcast.sources[activeSource] || broadcast.sources[broadcast.defaultSource];
}

function activePlayerKey() {
  return `${activeBroadcast}:${activeSource}`;
}

function ensureActiveSource() {
  const broadcast = activeBroadcastConfig();
  if (broadcast.sources[activeSource]) return;
  activeSource = broadcast.defaultSource;
  sourceByBroadcast.set(activeBroadcast, activeSource);
}

function renderLivePlayer() {
  ensureActiveSource();
  const playerKey = activePlayerKey();

  const sourceKey = activeSource;
  const channel = activeSourceConfig();
  const playerKind = activePlayerKind(channel);
  liveView.dataset.playerKind = playerKind;
  livePlayerLayout.dataset.broadcast = activeBroadcast;
  livePlayerLayout.dataset.source = sourceKey;
  livePlayerLayout.dataset.playerKind = playerKind;
  livePlayerFrame.dataset.broadcast = activeBroadcast;
  livePlayerFrame.dataset.channel = sourceKey;
  livePlayerFrame.dataset.source = sourceKey;
  livePlayerFrame.dataset.playerKind = playerKind;

  if (!livePlayerCache.has(playerKey)) {
    const player =
      channel.type === "iframe"
        ? createKoryoPlayer(channel, playerKey, playerKind)
        : createHlsPlayer(channel, playerKey, ++livePlayerRenderToken);
    livePlayerCache.set(playerKey, player);
    livePlayerFrame.append(player.node);
  }

  showLivePlayer(playerKey);
  renderedPlayerKey = playerKey;
  updateLivePlayerScale();
}

function createLiveStreamLayer(channelKey) {
  const layer = document.createElement("div");
  layer.className = "live-stream-layer";
  layer.dataset.channel = channelKey;
  return layer;
}

function activePlayerKind(channel = activeSourceConfig()) {
  if (channel.type === "iframe" && activeBroadcastConfig().type === "radio") return "koryo-radio";
  if (channel.media === "audio") return "radio";
  return "video";
}

function createKoryoPlayer(channel, channelKey, playerKind) {
  const layer = createLiveStreamLayer(channelKey);
  const iframe = document.createElement("iframe");
  const isRadioIframe = playerKind === "koryo-radio";
  iframe.className = isRadioIframe ? "live-koryo-frame live-koryo-radio-frame" : "live-koryo-frame";
  layer.classList.toggle("live-koryo-radio-layer", isRadioIframe);
  iframe.src = channel.src;
  iframe.width = String(KORYO_IFRAME_DESKTOP_WIDTH);
  iframe.height = String(isRadioIframe ? KORYO_RADIO_IFRAME_HEIGHT : KORYO_IFRAME_DESKTOP_HEIGHT);
  iframe.frameBorder = "0";
  iframe.scrolling = "no";
  iframe.setAttribute("scrolling", "no");
  iframe.allowFullscreen = true;
  iframe.allow = "fullscreen";
  iframe.title = channel.label;
  layer.append(iframe);
  return { node: layer, iframe, iframeSrc: channel.src, playerKind };
}

function showLivePlayer(channelKey) {
  for (const [key, player] of livePlayerCache) {
    const selected = key === channelKey;
    if (selected) restoreLivePlayer(player);
    player.node.hidden = !selected;
    player.node.setAttribute("aria-hidden", String(!selected));

    if (selected && player.autoplay) {
      playLivePlayerSilently(player);
    } else if (!selected) {
      silenceLivePlayer(player);
    }
  }
}

function restoreLivePlayer(player) {
  if (!player.iframe) return;
  if (player.iframe.getAttribute("src") !== player.iframeSrc) {
    player.iframe.src = player.iframeSrc;
  }
}

function playLivePlayerSilently(player) {
  if (!player.video) return;
  player.video.muted = true;
  player.video.play().catch(() => {});
}

function silenceLivePlayer(player) {
  if (player.video) {
    player.video.pause();
    player.video.muted = true;
  }
  if (player.iframe && player.iframe.getAttribute("src") !== "about:blank") {
    player.iframe.src = "about:blank";
  }
}

function silenceAllLivePlayers() {
  for (const player of livePlayerCache.values()) {
    silenceLivePlayer(player);
  }
}

function createHlsPlayer(channel, channelKey, renderToken) {
  const layer = createLiveStreamLayer(channelKey);
  const media = document.createElement(channel.media === "audio" ? "audio" : "video");
  media.className = channel.media === "audio" ? "live-audio" : "live-video";
  media.controls = channel.media !== "audio";
  media.autoplay = channel.media !== "audio";
  media.muted = channel.media !== "audio";
  if (channel.media !== "audio") media.playsInline = true;
  media.setAttribute("aria-label", `${channel.label} 라이브`);
  layer.classList.toggle("live-audio-layer", channel.media === "audio");
  layer.append(media);
  if (channel.media === "audio") {
    layer.append(createRadioPlayer(channel, media));
  }

  const player = { node: layer, video: media, hlsInstance: null, renderToken, autoplay: channel.media !== "audio" };
  const mediaErrorMessage = channel.media === "audio" ? "라이브 오디오를 불러오지 못했습니다." : "라이브 영상을 불러오지 못했습니다.";

  const isValidPlayer = () =>
    livePlayerCache.get(channelKey) === player &&
    player.renderToken === renderToken &&
    livePlayerFrame.contains(layer);

  if (media.canPlayType("application/vnd.apple.mpegurl")) {
    media.src = channel.src;
    if (player.autoplay) playLivePlayerSilently(player);
    return player;
  }

  ensureHlsScript()
    .then(() => {
      if (!isValidPlayer()) return;

      if (!window.Hls?.isSupported()) {
        showLivePlayerMessage("이 브라우저에서 재생할 수 없습니다.", player);
        return;
      }

      const nextHlsInstance = new window.Hls({ enableWorker: true });
      player.hlsInstance = nextHlsInstance;
      nextHlsInstance.loadSource(channel.src);
      nextHlsInstance.attachMedia(media);
      nextHlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
        if (!isValidPlayer()) return;
        if (player.autoplay) playLivePlayerSilently(player);
      });
      nextHlsInstance.on(window.Hls.Events.ERROR, (_event, data) => {
        if (data?.fatal && isValidPlayer()) showLivePlayerMessage(mediaErrorMessage, player);
      });
    })
    .catch(() => {
      if (isValidPlayer()) showLivePlayerMessage(mediaErrorMessage, player);
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

  player.className = "live-radio-player";
  copy.className = "live-radio-copy";
  time.className = "live-radio-time";
  status.className = "live-radio-status";
  statusIcon.className = "material-symbols-rounded";
  statusIcon.setAttribute("aria-hidden", "true");
  statusLabel.className = "live-radio-status-label";
  volume.className = "live-radio-volume";
  volumeIcon.className = "material-symbols-rounded";
  volumeIcon.setAttribute("aria-hidden", "true");
  volumeIcon.textContent = "volume_down";
  volumeRange.className = "live-radio-volume-range";
  volumeRange.type = "range";
  volumeRange.min = "0";
  volumeRange.max = "1";
  volumeRange.step = "0.01";
  volumeRange.value = "1";
  volumeRange.setAttribute("aria-label", "음량");
  actions.className = "live-radio-actions";
  playButton.className = "live-radio-action live-radio-action-play";
  playButton.type = "button";
  playButton.setAttribute("aria-label", `${channel.label} 재생`);
  playIcon.className = "material-symbols-rounded";
  playIcon.setAttribute("aria-hidden", "true");
  playIcon.textContent = "play_arrow";
  stopButton.className = "live-radio-action live-radio-action-stop";
  stopButton.type = "button";
  stopButton.setAttribute("aria-label", `${channel.label} 정지`);
  stopIcon.className = "material-symbols-rounded";
  stopIcon.setAttribute("aria-hidden", "true");
  stopIcon.textContent = "stop";
  record.className = "live-radio-record";
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
    volumeRange.style.setProperty("--live-radio-volume", `${volumeValue * 100}%`);
    volumeIcon.textContent = volumeValue <= 0 ? "volume_mute" : "volume_down";
    volume.classList.toggle("is-muted", volumeValue <= 0);
    volume.classList.toggle("is-high", volumeValue > 0.75);
    if (volumeValue > 0.75) volumeIcon.textContent = "volume_up";
  };
  const updateTime = () => {
    time.textContent = formatRadioElapsed(media.currentTime);
  };
  const isMediaPlaying = () => !media.paused && !media.ended;
  const updatePlayback = (nextIsPlaying = isMediaPlaying()) => {
    const isPlaying = Boolean(nextIsPlaying);
    statusIcon.textContent = isPlaying ? "play_arrow" : "stop";
    statusLabel.textContent = isPlaying ? "PLAY" : "STOP";
    player.classList.toggle("is-playing", isPlaying);
    playButton.classList.toggle("active", isPlaying);
    stopButton.classList.toggle("active", !isPlaying);
  };

  playButton.addEventListener("click", () => {
    media.muted = false;
    updatePlayback(true);
    media.play().then(() => updatePlayback(true)).catch(() => updatePlayback(false));
  });
  stopButton.addEventListener("click", () => media.pause());
  volumeRange.addEventListener("input", () => {
    media.muted = false;
    media.volume = Number(volumeRange.value);
    updateVolume();
  });
  media.addEventListener("play", () => updatePlayback());
  media.addEventListener("playing", () => updatePlayback(true));
  media.addEventListener("pause", () => updatePlayback());
  media.addEventListener("ended", () => updatePlayback());
  media.addEventListener("error", () => updatePlayback(false));
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

function showLivePlayerMessage(message, player = null) {
  const host = player?.node || livePlayerFrame;
  host.querySelector(".live-player-message")?.remove();
  const node = document.createElement("div");
  node.className = "live-player-message";
  node.textContent = message;
  host.append(node);
}

function setLiveScheduleOpen(isOpen) {
  const supportsSchedule = activeBroadcastSupportsSchedule();
  if (supportsSchedule) liveScheduleOpen = isOpen;
  const shouldOpen = supportsSchedule && liveScheduleOpen;
  const wasOpen = livePlayerLayout.classList.contains("schedule-open");
  const shouldAnimate = shouldAnimateLivePlayerSlide(wasOpen, shouldOpen);
  const beforeRect = shouldAnimate ? livePlayerFrame.getBoundingClientRect() : null;

  liveSchedulePanel.hidden = !shouldOpen;
  liveScheduleToggle.hidden = !supportsSchedule || shouldOpen;
  liveView.classList.toggle("schedule-open", shouldOpen);
  livePlayerLayout.classList.toggle("schedule-open", shouldOpen);
  liveScheduleToggle.setAttribute("aria-expanded", String(shouldOpen));
  updateLivePlayerScale();
  if (beforeRect) animateLivePlayerSlide(beforeRect, livePlayerFrame.getBoundingClientRect());
  if (shouldOpen) scrollActiveProgramIntoView();
}

function shouldAnimateLivePlayerSlide(wasOpen, shouldOpen) {
  if (wasOpen === shouldOpen) return false;
  if (liveView.hidden || !livePlayerFrame.isConnected || typeof livePlayerFrame.animate !== "function") return false;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return false;
  const rect = livePlayerFrame.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function animateLivePlayerSlide(beforeRect, afterRect) {
  const deltaX = beforeRect.left - afterRect.left;
  const deltaY = beforeRect.top - afterRect.top;
  if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;

  livePlayerSlideAnimation?.cancel();
  livePlayerSlideAnimation = livePlayerFrame.animate(
    [
      { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
      { transform: "translate3d(0, 0, 0)" },
    ],
    {
      duration: 560,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    },
  );
  livePlayerSlideAnimation.addEventListener("finish", clearLivePlayerSlideAnimation);
  livePlayerSlideAnimation.addEventListener("cancel", clearLivePlayerSlideAnimation);
}

function clearLivePlayerSlideAnimation(event) {
  if (event.target === livePlayerSlideAnimation) livePlayerSlideAnimation = null;
}

function activeBroadcastSupportsSchedule() {
  return activeBroadcastConfig().type === "tv";
}

function updateLivePlayerScale() {
  const source = activeSourceConfig();
  const playerKind = activePlayerKind(source);
  syncActiveKoryoViewport(playerKind);
  const size = livePlayerBaseSize(playerKind);
  const shellHeight = liveView.clientHeight || size.height;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const maxPlayerHeight = Math.min(size.height, Math.max(220, shellHeight - 160));
  const widthFromHeight = maxPlayerHeight * (size.width / size.height);
  const fitWidth = Math.min(size.width, Math.max(0, viewportWidth - 48), widthFromHeight);
  const fitHeight = fitWidth > 0 ? fitWidth * (size.height / size.width) : size.height;

  if (fitWidth > 0) {
    liveView.style.setProperty("--live-player-fit-width", `${fitWidth.toFixed(3)}px`);
    livePlayerFrame.style.setProperty("--live-player-fit-width", `${fitWidth.toFixed(3)}px`);
  }
  liveView.style.setProperty("--live-player-half-height", `${(fitHeight / 2).toFixed(3)}px`);

  const width = livePlayerFrame.clientWidth || fitWidth || size.width;
  const scaleBase = size.width;
  const scale = Math.max(0.1, width / scaleBase);
  livePlayerFrame.style.setProperty("--live-player-scale", scale.toFixed(6));
  livePlayerFrame.classList.toggle("radio", playerKind === "radio");
  livePlayerFrame.classList.toggle("koryo-radio", playerKind === "koryo-radio");
  livePlayerFrame.dataset.koryoViewport = isMobileKoryoVideoViewport(playerKind) ? "mobile" : "desktop";
}

function livePlayerBaseSize(playerKind) {
  if (playerKind === "radio") {
    return { width: RADIO_PLAYER_BASE_WIDTH, height: RADIO_PLAYER_BASE_HEIGHT };
  }
  if (playerKind === "koryo-radio") {
    return { width: KORYO_RADIO_PLAYER_BASE_WIDTH, height: KORYO_RADIO_PLAYER_BASE_HEIGHT };
  }
  if (isMobileKoryoVideoViewport(playerKind)) {
    const metrics = koryoMobileVideoMetrics();
    return { width: metrics.playerWidth, height: metrics.playerHeight };
  }
  return {
    width: activeSource === "kcna" ? KCNA_PLAYER_WIDTH : KORYO_PLAYER_BASE_WIDTH,
    height: VIDEO_PLAYER_BASE_HEIGHT,
  };
}

function syncActiveKoryoViewport(playerKind) {
  const player = livePlayerCache.get(activePlayerKey());
  if (!player?.iframe) return;

  const metrics = koryoIframeViewportMetrics(playerKind);
  livePlayerFrame.style.setProperty("--live-koryo-iframe-width", `${metrics.iframeWidth}px`);
  livePlayerFrame.style.setProperty("--live-koryo-iframe-height", `${metrics.iframeHeight}px`);
  livePlayerFrame.style.setProperty("--live-koryo-crop-left", `${metrics.cropLeft}px`);
  livePlayerFrame.style.setProperty("--live-koryo-crop-top", `${metrics.cropTop}px`);

  player.iframe.width = String(metrics.iframeWidth);
  player.iframe.height = String(metrics.iframeHeight);
  player.iframe.dataset.viewport = metrics.viewport;
}

function koryoIframeViewportMetrics(playerKind) {
  if (playerKind === "koryo-radio") {
    return {
      viewport: "desktop",
      iframeWidth: KORYO_IFRAME_DESKTOP_WIDTH,
      iframeHeight: KORYO_RADIO_IFRAME_HEIGHT,
      cropLeft: KORYO_RADIO_CROP_LEFT,
      cropTop: activeBroadcast === "vok" ? KORYO_RADIO_VOK_CROP_TOP : KORYO_RADIO_KCBS_CROP_TOP,
    };
  }

  if (isMobileKoryoVideoViewport(playerKind)) {
    const metrics = koryoMobileVideoMetrics();
    return {
      viewport: "mobile",
      iframeWidth: metrics.iframeWidth,
      iframeHeight: KORYO_MOBILE_IFRAME_HEIGHT,
      cropLeft: -KORYO_MOBILE_PAGE_PADDING_X,
      cropTop: -KORYO_MOBILE_PLAYER_TOP,
    };
  }

  return {
    viewport: "desktop",
    iframeWidth: KORYO_IFRAME_DESKTOP_WIDTH,
    iframeHeight: KORYO_IFRAME_DESKTOP_HEIGHT,
    cropLeft: KORYO_IFRAME_DESKTOP_CROP_LEFT,
    cropTop: KORYO_IFRAME_DESKTOP_CROP_TOP,
  };
}

function isMobileKoryoVideoViewport(playerKind = activePlayerKind()) {
  return activeSource === "koryo" && playerKind === "video" && koryoMobileMediaQuery.matches;
}

function koryoMobileVideoMetrics() {
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth || KORYO_MOBILE_IFRAME_MAX_WIDTH;
  const iframeWidth = clampNumber(viewportWidth, KORYO_MOBILE_IFRAME_MIN_WIDTH, KORYO_MOBILE_IFRAME_MAX_WIDTH);
  const playerWidth = Math.max(1, iframeWidth - KORYO_MOBILE_PAGE_PADDING_X * 2);
  return {
    iframeWidth,
    playerWidth,
    playerHeight: playerWidth * (9 / 16),
  };
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function addMediaQueryChangeListener(mediaQuery, listener) {
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", listener);
  } else {
    mediaQuery.addListener(listener);
  }
}

function moveTimetableDate(delta) {
  if (activeBroadcastConfig().type === "radio") return;
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
  if (activeBroadcastConfig().type === "radio") {
    renderTimetable();
    return;
  }

  liveScheduleDate.textContent = formatTimetableDate(activeTimetableYmd);
  liveProgramList.replaceChildren(createTimetableState(message));
  updateTimetableButtons();
}

function renderTimetable() {
  if (activeBroadcastConfig().type === "radio") {
    liveScheduleDate.textContent = activeBroadcastConfig().label;
    liveProgramList.replaceChildren(createTimetableState("라디오 편성표는 제공되지 않습니다."));
    updateTimetableButtons();
    return;
  }

  liveScheduleDate.textContent = formatTimetableDate(activeTimetableYmd);
  const entries = activeTimetableEntries;
  const activeIndex = currentProgramIndex(entries, activeTimetableYmd);

  if (!entries.length) {
    liveProgramList.replaceChildren(createTimetableState("해당 날짜의 편성표가 없습니다."));
    updateTimetableButtons();
    return;
  }

  liveProgramList.replaceChildren(
    ...entries.map((entry, index) => {
      const item = document.createElement("div");
      const time = document.createElement("p");
      const title = document.createElement("p");

      item.className = "live-program-entry";
      item.classList.toggle("active", index === activeIndex);
      time.className = "live-program-time";
      title.className = "live-program-title";
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
  node.className = "live-program-state";
  node.textContent = message;
  return node;
}

function updateTimetableButtons() {
  const isRadio = activeBroadcastConfig().type === "radio";
  liveDatePrev.disabled = isRadio;
  liveDateNext.disabled = isRadio || activeTimetableYmd >= koreaTodayYmd();
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
  if (!activeBroadcastSupportsSchedule() || !liveScheduleOpen) return;

  window.requestAnimationFrame(() => {
    const activeItem = liveProgramList.querySelector(".live-program-entry.active");
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

function bindMusicEvents() {
  for (const item of musicSidebarItems) {
    item.addEventListener("click", () => setMusicMode(item.dataset.musicMode || "home"));
  }
  for (const button of musicModeButtons) {
    button.addEventListener("click", () => setMusicMode(button.dataset.musicMode || "home"));
  }

  musicHeaderSearch?.addEventListener("click", openMusicSearch);
  musicSearchClose?.addEventListener("click", closeMusicSearch);
  musicSearchOverlay?.addEventListener("click", (event) => {
    if (event.target === musicSearchOverlay) closeMusicSearch();
  });
  musicSearchInput?.addEventListener("input", renderMusicSearchResults);
  musicExpandButton?.addEventListener("click", () => {
    const track = getActiveMusicTrack();
    setMusicMode(activeMusicMode === "home" ? resolveMusicModeForTrack(track, "lyrics") : "home");
  });
  musicPrevButton?.addEventListener("click", () => moveActiveMusicTrack(-1));
  musicNextButton?.addEventListener("click", () => moveActiveMusicTrack(1));
  musicPlayButton?.addEventListener("click", toggleMusicPlayback);
  musicAudio?.addEventListener("loadedmetadata", updateMusicProgress);
  musicAudio?.addEventListener("timeupdate", updateMusicProgress);
  musicAudio?.addEventListener("play", renderMusicPlaybackState);
  musicAudio?.addEventListener("pause", renderMusicPlaybackState);
  musicAudio?.addEventListener("ended", () => {
    renderMusicPlaybackState();
    moveActiveMusicTrack(1);
  });
  document.addEventListener("keydown", handleMusicKeydown);
}

async function loadMusicLibrary() {
  const [source, playlists] = await Promise.all([
    fetchTextFromCandidates(musicTextCandidates(MUSIC_LIST_CANDIDATE_PATHS)),
    loadMusicPlaylists(),
  ]);
  const tracks = source
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line && !line.startsWith("#"))
    .map(({ line, index }) => createMusicTrackFromListLine(line, index));

  if (!tracks.length) return createFallbackMusicLibrary();

  musicPlaylists = playlists;
  const sections = createMusicSectionsFromTracks(tracks, playlists);
  return { tracks, sections, playlists };
}

async function loadMusicPlaylists() {
  try {
    const source = await fetchTextFromCandidates(musicTextCandidates(MUSIC_PLAYLIST_CANDIDATE_PATHS));
    return parseMusicPlaylists(source);
  } catch {
    return [];
  }
}

function musicTextCandidates(paths) {
  return paths.flatMap((path) => {
    const url = musicAssetUrl(path);
    return [url, `${CORS_PROXY_URL}${encodeURIComponent(url)}`];
  });
}

function parseMusicPlaylists(source) {
  const text = source.trim();
  if (!text) return [];
  if (/^<!doctype html/i.test(text) || /^<html[\s>]/i.test(text)) return [];

  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed.playlists || parsed.items || [];
    return list.map(normalizeMusicPlaylist).filter(Boolean);
  } catch {
    return text
      .split(/\r?\n/)
      .map((line, index) => normalizeMusicPlaylist(line, index))
      .filter(Boolean);
  }
}

function normalizeMusicPlaylist(item, index) {
  if (typeof item === "string") {
    const line = item.trim();
    if (!line || line.startsWith("#")) return null;
    const [title, cover, trackIds] = line.split("@").map((part) => normalizeText(part));
    if (!title) return null;
    return {
      type: "playlist",
      id: `admin-playlist-${index + 1}`,
      title,
      cover,
      trackIds: trackIds ? trackIds.split(",").map((id) => normalizeText(id)).filter(Boolean) : [],
    };
  }

  const title = normalizeText(item?.title || item?.name);
  if (!title) return null;
  return {
    type: "playlist",
    id: String(item.id || item.slug || `admin-playlist-${index + 1}`),
    title,
    cover: item.cover || item.image || item.thumbnail || "",
    trackIds: Array.isArray(item.trackIds) ? item.trackIds.map(String) : [],
  };
}

function createFallbackMusicLibrary() {
  const tracks = MUSIC_FALLBACK_TRACKS.map((track, index) =>
    normalizeMusicTrack({
      no: index + 1,
      ...track,
    }),
  );
  return {
    tracks,
    sections: createMusicSectionsFromTracks(tracks, []),
    playlists: [],
  };
}

function createMusicTrackFromListLine(line, index) {
  const no = index + 1;
  const [title, artist, album, year] = line.split("@").map((part) => normalizeText(part));
  return normalizeMusicTrack({
    no,
    id: `music-${no}`,
    title,
    artist,
    album,
    year,
    duration: 179,
    audio: `music/audio/${no}.mp3`,
    sheet: `music/image/${no}.gif`,
    sheetFallback: `music/image/${no}.jpg`,
    ...knownMusicMeta(title),
  });
}

function normalizeMusicTrack(track) {
  return {
    no: track.no || 0,
    id: String(track.id || `music-${track.no || track.title}`),
    title: normalizeMusicTitle(track.title || track.name || "제목 없음"),
    artist: MUSIC_ARCHIVE_ARTIST,
    album: normalizeText(track.album) || "음악마당",
    year: normalizeText(track.year) || "2024",
    duration: Number(track.duration) || 179,
    elapsed: Number(track.elapsed) || 0,
    audio: track.audio || "",
    cover: track.cover || "",
    sheet: track.sheet || "",
    sheetFallback: track.sheetFallback || "",
    lyrics: Array.isArray(track.lyrics) ? track.lyrics : knownMusicMeta(track.title || track.name).lyrics || [],
  };
}

function createMusicSectionsFromTracks(tracks, playlists = musicPlaylists) {
  const byTitle = new Map(tracks.map((track) => [track.title, track]));
  const pickTitles = (titles, fallbackStart = 0, count = 18) => {
    const picked = titles.map((title) => byTitle.get(title)).filter(Boolean);
    const fallback = [];
    for (let index = 0; tracks.length && fallback.length < Math.max(0, count - picked.length); index += 1) {
      fallback.push(tracks[(fallbackStart + index) % tracks.length]);
      if (index > tracks.length + count) break;
    }
    return [...picked, ...fallback].filter((track, index, list) => list.findIndex((item) => item.id === track.id) === index).slice(0, count);
  };
  const sections = [];
  const recentItems = recentMusicTrackIds
    .map((trackId) => tracks.find((track) => track.id === trackId))
    .filter(Boolean)
    .slice(0, MUSIC_RECENT_LIMIT);

  if (recentItems.length) {
    sections.push({
      title: "최근 재생한 음악",
      items: recentItems,
    });
  }

  sections.push(
    {
      title: "인기 추천곡",
      items: pickTitles(["애국가", "설눈아 내려라", "공격전이다", "아리랑", "휘파람", "장군님 축지법 쓰신다"], 36),
    },
    {
      title: "최신 발매곡",
      items: pickTitles(["우리는 조선사람", "친근한 어버이", "우리의 7.27", "아리랑", "우리의 소원은 통일", "조선민주주의인민공화국 국가"], Math.max(0, tracks.length - 12)),
    },
  );

  if (playlists.length) {
    sections.push({
      title: "추천 플레이리스트",
      items: playlists.slice(0, 18),
    });
  }

  return sections;
}

function knownMusicMeta(title) {
  const normalizedTitle = normalizeMusicTitle(title);
  if (normalizedTitle !== "장군님 축지법 쓰신다") return {};
  return {
    artist: "보천보전자악단",
    album: "왕재산 선곡 1",
    year: "2024",
    duration: 179,
    lyrics: MUSIC_FALLBACK_TRACKS[0].lyrics,
  };
}

function normalizeMusicTitle(value) {
  return normalizeText(value).split("@")[0];
}

function renderMusicView() {
  if (!musicView) return;
  const hasActiveTrack = Boolean(getActiveMusicTrack());
  if (!hasActiveTrack && ["lyrics", "sheet", "queue"].includes(activeMusicMode)) activeMusicMode = "home";
  musicView.dataset.mode = activeMusicMode;
  musicView.classList.toggle("has-track", hasActiveTrack);
  if (musicBottomPlayer) musicBottomPlayer.hidden = !hasActiveTrack;
  renderMusicHomeSections();
  renderMusicLibrary();
  renderMusicPlayer();
  renderMusicQueue();
  renderMusicSearchResults();
  renderMusicModeState();
  syncMusicSearchState();
}

function renderMusicHomeSections() {
  if (!musicHomeSections) return;
  musicHomeSections.replaceChildren(...musicLibrary.sections.map(createMusicSectionNode));
}

function renderMusicLibrary() {
  if (!musicLibraryContent) return;
  const title = document.createElement("div");
  const heading = document.createElement("h1");
  const actions = document.createElement("div");
  const playAll = document.createElement("button");
  const shuffle = document.createElement("button");
  const chips = document.createElement("div");
  const playlistGrid = document.createElement("div");
  const table = document.createElement("div");

  title.className = "music-library-header";
  heading.textContent = "내 음악";
  actions.className = "music-library-actions";
  playAll.className = "music-pill-button active";
  playAll.type = "button";
  playAll.textContent = "재생";
  playAll.addEventListener("click", () => selectMusicTrack(musicLibrary.tracks[0]?.id || activeMusicTrackId, "lyrics"));
  shuffle.className = "music-pill-button";
  shuffle.type = "button";
  shuffle.textContent = "셔플";
  shuffle.addEventListener("click", () => {
    const randomTrack = musicLibrary.tracks[Math.floor(Math.random() * musicLibrary.tracks.length)];
    if (randomTrack) selectMusicTrack(randomTrack.id, "lyrics");
  });
  actions.append(playAll, shuffle);
  title.append(heading, actions);

  chips.className = "music-library-chips";
  for (const label of ["노래", "앨범", "재생목록", "아티스트"]) {
    const chip = document.createElement("button");
    chip.className = "music-filter-chip";
    chip.classList.toggle("active", label === "노래");
    chip.type = "button";
    chip.textContent = label;
    chips.append(chip);
  }

  playlistGrid.className = "music-library-playlists";
  playlistGrid.replaceChildren(...(musicLibrary.playlists || []).slice(0, 4).map(createLibraryPlaylistNode));

  table.className = "music-track-table";
  table.replaceChildren(...musicLibrary.tracks.slice(0, 36).map((track, index) => createTrackRow(track, index + 1)));
  musicLibraryContent.replaceChildren(title, chips, ...((musicLibrary.playlists || []).length ? [playlistGrid] : []), table);
}

function createLibraryPlaylistNode(playlist) {
  const button = document.createElement("button");
  const art = document.createElement("span");
  const copy = document.createElement("span");
  const title = document.createElement("span");
  const meta = document.createElement("span");

  button.className = "music-library-playlist";
  button.type = "button";
  art.className = "music-library-playlist-art";
  copy.className = "music-library-playlist-copy";
  title.className = "music-library-playlist-title";
  meta.className = "music-library-playlist-meta";
  title.textContent = playlist.title;
  meta.textContent = "재생목록";
  setMusicArtwork(art, playlist.cover);
  copy.append(title, meta);
  button.append(art, copy);
  return button;
}

function createTrackRow(track, index) {
  const row = document.createElement("button");
  const number = document.createElement("span");
  const art = document.createElement("span");
  const copy = document.createElement("span");
  const title = document.createElement("span");
  const meta = document.createElement("span");
  const album = document.createElement("span");
  const duration = document.createElement("span");

  row.className = "music-track-row";
  row.type = "button";
  row.dataset.trackId = track.id;
  number.className = "music-track-number";
  art.className = "music-track-art";
  copy.className = "music-track-copy";
  title.className = "music-track-title";
  meta.className = "music-track-meta";
  album.className = "music-track-album";
  duration.className = "music-track-duration";
  number.textContent = String(index);
  title.textContent = track.title;
  meta.textContent = track.artist;
  album.textContent = track.album;
  duration.textContent = formatMusicTime(track.duration);
  setMusicArtwork(art, track.cover);
  copy.append(title, meta);
  row.append(number, art, copy, album, duration);
  row.addEventListener("click", () => selectMusicTrack(track.id, "lyrics"));
  return row;
}

function createMusicSectionNode(section) {
  const node = document.createElement("section");
  const header = document.createElement("div");
  const title = document.createElement("h2");
  const headerButton = document.createElement("button");
  const headerIcon = document.createElement("span");
  const listWrap = document.createElement("div");
  const list = document.createElement("div");
  const fade = document.createElement("div");
  const arrowButton = document.createElement("button");
  const arrowIcon = document.createElement("span");

  node.className = "music-section";
  header.className = "music-section-header";
  title.textContent = section.title;
  headerButton.className = "music-section-title-button";
  headerButton.type = "button";
  headerButton.setAttribute("aria-label", `${section.title} 더보기`);
  headerIcon.className = "material-symbols-rounded";
  headerIcon.setAttribute("aria-hidden", "true");
  headerIcon.textContent = "chevron_right";
  headerButton.append(headerIcon);
  header.append(title, headerButton);

  listWrap.className = "music-album-list-wrap";
  list.className = "music-album-list";
  list.replaceChildren(...section.items.map(createMusicAlbumNode));
  fade.className = "music-list-fade";
  fade.setAttribute("aria-hidden", "true");
  arrowButton.className = "music-list-arrow";
  arrowButton.type = "button";
  arrowButton.setAttribute("aria-label", `${section.title} 오른쪽으로 보기`);
  arrowIcon.className = "material-symbols-rounded";
  arrowIcon.setAttribute("aria-hidden", "true");
  arrowIcon.textContent = "chevron_right";
  arrowButton.append(arrowIcon);
  arrowButton.addEventListener("click", () => {
    list.scrollLeft += 360;
  });
  listWrap.append(list, fade, arrowButton);
  node.append(header, listWrap);
  return node;
}

function createMusicAlbumNode(item) {
  const isTrack = !item.type || item.audio || item.no;
  const button = document.createElement("button");
  const art = document.createElement("span");
  const title = document.createElement("span");

  button.className = "music-album-card";
  button.type = "button";
  art.className = "music-album-art";
  title.className = "music-album-title";
  title.textContent = item.title;
  button.append(art, title);

  setMusicArtwork(art, item.cover);
  if (isTrack) {
    button.dataset.trackId = item.id;
    button.addEventListener("click", () => selectMusicTrack(item.id, "lyrics"));
  } else {
    button.addEventListener("click", () => setMusicMode("home"));
  }

  return button;
}

function renderMusicPlayer() {
  const track = getActiveMusicTrack();
  if (!track) {
    if (musicNowTitle) musicNowTitle.textContent = "";
    if (musicNowMeta) musicNowMeta.textContent = "";
    if (musicLyricsPanel) musicLyricsPanel.replaceChildren();
    if (musicQueuePanel) musicQueuePanel.replaceChildren();
    if (musicLargeCover) {
      musicLargeCover.hidden = true;
      musicLargeCover.removeAttribute("src");
    }
    if (musicSheetImage) {
      musicSheetImage.hidden = true;
      musicSheetImage.removeAttribute("src");
    }
    if (musicMiniCover) clearMusicArtwork(musicMiniCover);
    updateMusicProgress();
    renderMusicPlaybackState();
    return;
  }

  musicNowTitle.textContent = track.title;
  musicNowMeta.textContent = musicMetaText(track);
  renderMusicLyrics(track);
  renderMusicImages(track);
  syncMusicAudioSource(track);
  updateMusicProgress();
  renderMusicPlaybackState();
}

function renderMusicQueue() {
  if (!musicQueuePanel) return;
  const track = getActiveMusicTrack();
  if (!track) {
    musicQueuePanel.replaceChildren();
    return;
  }

  const header = document.createElement("div");
  const title = document.createElement("h2");
  const chips = document.createElement("div");
  const current = document.createElement("div");
  const list = document.createElement("div");
  const tracks = musicLibrary.tracks;
  const activeIndex = Math.max(0, tracks.findIndex((item) => item.id === track.id));
  const nextTracks = [...tracks.slice(activeIndex + 1), ...tracks.slice(0, activeIndex)].slice(0, 18);

  header.className = "music-queue-header";
  title.textContent = "재생목록";
  chips.className = "music-queue-chips";
  for (const label of ["다음 트랙", "관련", "가사"]) {
    const chip = document.createElement("button");
    chip.className = "music-filter-chip";
    chip.classList.toggle("active", label === "다음 트랙");
    chip.type = "button";
    chip.textContent = label;
    chips.append(chip);
  }
  header.append(title, chips);

  current.className = "music-queue-current";
  current.append(createTrackRow(track, activeIndex + 1));

  list.className = "music-queue-list";
  list.replaceChildren(...nextTracks.map((item, index) => createTrackRow(item, index + 1)));
  musicQueuePanel.replaceChildren(header, current, list);
}

function renderMusicLyrics(track) {
  const lyrics = track.lyrics?.length ? track.lyrics : [];
  const activeIndex = 0;
  activeMusicLyricIndex = activeIndex;
  musicLyricsPanel.style.setProperty("--music-lyric-shift", String(6 - activeIndex));
  musicLyricsPanel.replaceChildren(
    ...lyrics.map((line, index) => {
      const row = document.createElement("div");
      const text = document.createElement("p");
      row.className = "music-lyrics-line";
      row.style.setProperty("--lyric-distance", String(Math.abs(index - activeIndex)));
      row.classList.toggle("active", index === activeIndex);
      text.textContent = line;
      row.append(text);
      return row;
    }),
  );
}

function renderMusicImages(track) {
  musicLargeCover.hidden = true;
  musicLargeCover.removeAttribute("src");
  if (track.cover) {
    setImageFromCandidates(musicLargeCover, [musicAssetUrl(track.cover)]);
  }

  setMusicArtwork(musicMiniCover, track.cover);
  const sheetCandidates = getMusicSheetCandidates(track);
  if (!sheetCandidates.length) {
    if (!musicSheetAvailability.has(track.id)) musicSheetAvailability.set(track.id, false);
    musicSheetImage.hidden = true;
    musicSheetImage.removeAttribute("src");
    musicSheetFallback.hidden = true;
    renderMusicModeState();
    return;
  }
  setImageFromCandidates(musicSheetImage, sheetCandidates, () => {
    musicSheetAvailability.set(track.id, true);
    musicSheetFallback.hidden = true;
    renderMusicModeState();
  }, () => {
    musicSheetAvailability.set(track.id, false);
    musicSheetFallback.hidden = true;
    if (activeMusicMode === "sheet") {
      activeMusicMode = resolveMusicModeForTrack(track, "queue");
      renderMusicView();
      return;
    }
    renderMusicModeState();
  });
}

function setImageFromCandidates(image, candidates, onLoad, onFail) {
  const queue = [...new Set(candidates.filter(Boolean))];
  const next = () => {
    const src = queue.shift();
    if (!src) {
      image.hidden = true;
      image.removeAttribute("src");
      onFail?.();
      return;
    }

    image.onload = () => {
      image.hidden = false;
      onLoad?.();
    };
    image.onerror = next;
    image.src = src;
  };
  next();
}

function setMusicArtwork(node, cover) {
  if (!node) return;
  clearMusicArtwork(node);
  if (!cover) return;

  const src = musicAssetUrl(cover);
  node.dataset.coverSrc = src;
  const image = new Image();
  image.onload = () => {
    if (node.dataset.coverSrc !== src) return;
    node.style.backgroundImage = `url("${src}")`;
    node.classList.add("has-cover");
  };
  image.onerror = () => {
    if (node.dataset.coverSrc !== src) return;
    clearMusicArtwork(node);
  };
  image.src = src;
}

function clearMusicArtwork(node) {
  if (!node) return;
  node.style.backgroundImage = "";
  node.classList.remove("has-cover");
  delete node.dataset.coverSrc;
}

function syncMusicAudioSource(track) {
  if (!musicAudio) return;
  const nextSrc = track.audio ? musicAssetUrl(track.audio) : "";
  if (musicAudio.dataset.trackId === track.id && musicAudio.getAttribute("src") === nextSrc) return;
  musicAudio.dataset.trackId = track.id;
  musicAudio.src = nextSrc;
  try {
    musicAudio.currentTime = 0;
  } catch {
    // The browser may reject seeking until metadata is available.
  }
}

function getMusicSheetCandidates(track) {
  if (!track || musicSheetAvailability.get(track.id) === false) return [];
  const candidates = [track.sheet, track.sheetFallback].filter(Boolean).map(musicAssetUrl);
  if (!candidates.length && track.no) {
    candidates.push(musicAssetUrl(`music/image/${track.no}.gif`), musicAssetUrl(`music/image/${track.no}.jpg`));
  }
  return [...new Set(candidates)];
}

function hasMusicLyrics(track) {
  return Boolean(track?.lyrics?.length);
}

function hasPotentialMusicSheet(track) {
  return musicSheetAvailability.get(track?.id) === true;
}

function canUseMusicMode(mode, track = getActiveMusicTrack()) {
  if (mode === "lyrics") return hasMusicLyrics(track);
  if (mode === "sheet") return hasPotentialMusicSheet(track);
  if (mode === "queue") return Boolean(track);
  return true;
}

function resolveMusicModeForTrack(track, requestedMode = "lyrics") {
  if (canUseMusicMode(requestedMode, track)) return requestedMode;
  if (hasMusicLyrics(track)) return "lyrics";
  return "queue";
}

function renderMusicModeState() {
  const track = getActiveMusicTrack();
  for (const item of musicSidebarItems) {
    const sidebarMode = activeMusicMode === "library" ? "library" : "home";
    const selected = item.dataset.musicMode === sidebarMode;
    item.classList.toggle("active", selected);
  }
  for (const button of musicModeButtons) {
    const mode = button.dataset.musicMode || "";
    const disabled = !canUseMusicMode(mode, track);
    const selected = !disabled && mode === activeMusicMode;
    button.classList.toggle("active", selected);
    button.disabled = disabled;
    button.setAttribute("aria-disabled", String(disabled));
    button.setAttribute("aria-pressed", String(selected));
  }
}

function renderMusicSearchResults() {
  if (!musicSearchResults) return;
  const query = normalizeText(musicSearchInput?.value || "").toLocaleLowerCase("ko-KR");
  const results = musicLibrary.tracks
    .filter((track) => {
      if (!query) return true;
      return `${track.title} ${track.artist} ${track.album}`.toLocaleLowerCase("ko-KR").includes(query);
    })
    .slice(0, 24);

  const chips = document.createElement("div");
  const list = document.createElement("div");
  chips.className = "music-search-chips";
  for (const label of ["노래", "앨범", "재생목록", "아티스트"]) {
    const chip = document.createElement("button");
    chip.className = "music-filter-chip";
    chip.classList.toggle("active", label === "노래");
    chip.type = "button";
    chip.textContent = label;
    chips.append(chip);
  }
  list.className = "music-search-list";
  list.replaceChildren(...results.map((track, index) => createTrackRow(track, index + 1)));
  musicSearchResults.replaceChildren(chips, list);
}

function renderMusicPlaybackState() {
  if (!musicPlayButton || !musicAudio) return;
  const icon = musicPlayButton.querySelector(".material-symbols-rounded");
  const isPlaying = !musicAudio.paused && !musicAudio.ended;
  if (icon) icon.textContent = isPlaying ? "pause" : "play_arrow";
  musicPlayButton.setAttribute("aria-label", isPlaying ? "일시정지" : "재생");
}

function updateMusicProgress() {
  const track = getActiveMusicTrack();
  if (!track) {
    if (musicProgressFill) musicProgressFill.style.width = "0%";
    if (musicTimeLabel) musicTimeLabel.textContent = "0:00 / 0:00";
    return;
  }
  const duration = Number.isFinite(musicAudio?.duration) && musicAudio.duration > 0 ? musicAudio.duration : track.duration;
  const current = Number.isFinite(musicAudio?.currentTime) && musicAudio.currentTime > 0 ? musicAudio.currentTime : 0;
  const progress = duration > 0 ? Math.min(100, Math.max(0, (current / duration) * 100)) : 0;
  musicProgressFill.style.width = `${progress}%`;
  musicTimeLabel.textContent = `${formatMusicTime(current)} / ${formatMusicTime(duration)}`;
}

function setMusicMode(mode) {
  if (!["home", "library", "lyrics", "sheet", "queue"].includes(mode)) return;
  if (!canUseMusicMode(mode)) return;
  activeMusicMode = mode;
  closeMusicSearch();
  renderMusicView();
}

function selectMusicTrack(trackId, mode = activeMusicMode) {
  const track = musicLibrary.tracks.find((item) => item.id === trackId);
  if (!track) return;
  activeMusicTrackId = trackId;
  activeMusicMode = resolveMusicModeForTrack(track, mode);
  activeMusicLyricIndex = 0;
  rememberRecentMusicTrack(trackId);
  closeMusicSearch();
  renderMusicView();
}

function moveActiveMusicTrack(delta) {
  const tracks = musicLibrary.tracks;
  const index = tracks.findIndex((track) => track.id === activeMusicTrackId);
  if (!tracks.length) return;
  if (index < 0) {
    selectMusicTrack(tracks[0].id, "lyrics");
    return;
  }
  const next = tracks[(index + delta + tracks.length) % tracks.length];
  selectMusicTrack(next.id);
}

function toggleMusicPlayback() {
  if (!musicAudio?.src) return;
  if (musicAudio.paused || musicAudio.ended) {
    musicAudio.play().catch(() => renderMusicPlaybackState());
  } else {
    musicAudio.pause();
  }
}

function pauseMusic(resetTime) {
  if (!musicAudio) return;
  musicAudio.pause();
  if (resetTime) musicAudio.currentTime = 0;
  renderMusicPlaybackState();
}

function collapseMusicToHome() {
  activeMusicMode = "home";
  closeMusicSearch();
}

function rememberRecentMusicTrack(trackId) {
  recentMusicTrackIds = [trackId, ...recentMusicTrackIds.filter((id) => id !== trackId)].slice(0, MUSIC_RECENT_LIMIT);
  writeRecentMusicTrackIds();
  musicLibrary.sections = createMusicSectionsFromTracks(musicLibrary.tracks, musicLibrary.playlists || []);
}

function readRecentMusicTrackIds() {
  try {
    const value = JSON.parse(window.localStorage.getItem(MUSIC_RECENT_STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.map(String).slice(0, MUSIC_RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function writeRecentMusicTrackIds() {
  try {
    window.localStorage.setItem(MUSIC_RECENT_STORAGE_KEY, JSON.stringify(recentMusicTrackIds));
  } catch {
    // Private browsing or storage-disabled contexts can still use the in-memory list.
  }
}

function openMusicSearch() {
  musicSearchOpen = true;
  syncMusicSearchState();
  renderMusicSearchResults();
  window.requestAnimationFrame(() => musicSearchInput?.focus());
}

function closeMusicSearch() {
  if (!musicSearchOpen) return;
  musicSearchOpen = false;
  if (musicSearchInput) musicSearchInput.value = "";
  syncMusicSearchState();
}

function syncMusicSearchState() {
  if (!musicSearchOverlay) return;
  musicSearchOverlay.hidden = !musicSearchOpen;
}

function handleMusicKeydown(event) {
  if (currentRoute() !== ROUTE_MUSIC) return;
  const isMetaSearch = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
  if (isMetaSearch) {
    event.preventDefault();
    openMusicSearch();
    return;
  }
  if (event.key === "Escape") closeMusicSearch();
}

function getActiveMusicTrack() {
  if (!activeMusicTrackId) return null;
  return musicLibrary.tracks.find((track) => track.id === activeMusicTrackId) || null;
}

function musicMetaText(track) {
  return track?.artist || MUSIC_ARCHIVE_ARTIST;
}

function formatMusicTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function musicAssetUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `${MUSIC_ASSET_BASE_URL}/${path.replace(/^\/+/, "")}`;
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
      path: assetUrl(row[5]),
      cssFamily: `ArchiveFont${String(index + 1).padStart(3, "0")}`,
      previewFamily: `ArchiveFont${String(index + 1).padStart(3, "0")}Preview`,
      fullFamily: `ArchiveFont${String(index + 1).padStart(3, "0")}Full`,
    }));
}

async function loadPreparedWebFonts() {
  try {
    const response = await fetch(assetUrl("webfonts/font_manifest.json"), { cache: "no-store" });
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
    const response = await fetch(assetUrl("webfonts-preview/preview_manifest.json"), { cache: "no-store" });
    if (!response.ok) return new Map();

    const manifest = await response.json();
    if (!manifest.previews || typeof manifest.previews !== "object") return new Map();

    return new Map(
      Object.entries(manifest.previews)
        .filter(([, preview]) => preview && typeof preview.url === "string")
        .map(([family, preview]) => [family, { ...preview, url: assetUrl(preview.url) }]),
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
  card.querySelector(".download-button").href = encodeFontUrl(assetUrl(font.path));
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
    return `url("${encodeFontUrl(assetUrl(`webfonts/${font.cssFamily}.woff2`))}") format("woff2")`;
  }
  if (formats?.has("ttf")) {
    return `url("${encodeFontUrl(assetUrl(`webfonts/${font.cssFamily}.ttf`))}") format("truetype")`;
  }

  return `url("${encodeFontUrl(assetUrl(font.path))}") format("${fontFormat(font.path)}")`;
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

function assetUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${R2_ASSET_BASE_URL}/${path.replace(/^\/+/, "")}`;
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
