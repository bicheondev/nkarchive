(function initializeNewsYouTube() {
  const DATA_URL = "/data/news/youtube-videos.json";
  const LATEST_DATA_URL = "/api/news-youtube-latest";
  const RENDER_BATCH_SIZE = 24;
  const CHANNEL_NAMES = new Set(["메아리", "supersuhui"]);
  const section = document.querySelector(".news-youtube-section");
  const grid = document.querySelector("#newsYoutubeGrid");
  const status = document.querySelector("#newsYoutubeStatus");
  const moreButton = document.querySelector("#newsYoutubeMore");
  if (!section || !grid || !status || !moreButton) return;

  let renderObserver = null;
  let renderedSignature = "";
  let publishedVideos = [];

  loadVideos();

  async function loadVideos() {
    try {
      const response = await fetch(DATA_URL, {
        cache: "no-cache",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`youtube_feed_${response.status}`);
      const payload = await response.json();
      if (!isValidPayload(payload)) throw new Error("invalid_youtube_feed");
      const videos = [...payload.videos].sort(compareNewestFirst);
      if (!videos.length) throw new Error("empty_youtube_feed");
      renderVideos(videos);
      status.hidden = true;
      void refreshLatestVideos();
    } catch (error) {
      console.error(error);
      status.textContent = "YouTube 영상 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
      status.classList.add("news-youtube-error");
    } finally {
      section.setAttribute("aria-busy", "false");
    }
  }

  async function refreshLatestVideos() {
    try {
      const response = await fetch(LATEST_DATA_URL, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`youtube_latest_${response.status}`);
      const payload = await response.json();
      if (!isValidPayload(payload)) throw new Error("invalid_youtube_latest");
      const videos = mergeLatestVideos(payload.videos, publishedVideos);
      if (!videos.length) throw new Error("empty_youtube_latest");
      const nextSignature = createVideoSignature(videos);
      if (nextSignature !== renderedSignature) renderVideos(videos);
      section.dataset.latestCheckedAt = String(payload.refresh?.checkedAt || payload.generatedAt || "");
      section.dataset.latestMode = String(payload.refresh?.status || "success");
    } catch (error) {
      console.warn("[news/youtube] Live freshness check failed; keeping the published list.", error);
    }
  }

  function renderVideos(videos) {
    publishedVideos = videos;
    renderedSignature = createVideoSignature(videos);
    let renderedCount = 0;
    grid.replaceChildren();
    renderObserver?.disconnect();

    const appendNextBatch = () => {
      const nextVideos = videos.slice(renderedCount, renderedCount + RENDER_BATCH_SIZE);
      const fragment = document.createDocumentFragment();
      nextVideos.forEach((video, offset) => fragment.append(createVideoCard(video, renderedCount + offset, videos.length)));
      grid.append(fragment);
      renderedCount += nextVideos.length;
      const hasMore = renderedCount < videos.length;
      moreButton.hidden = !hasMore;
      moreButton.textContent = hasMore
        ? `영상 더 보기 (${renderedCount.toLocaleString("ko-KR")}/${videos.length.toLocaleString("ko-KR")})`
        : "모든 영상을 불러왔습니다.";
      if (!hasMore) renderObserver?.disconnect();
    };

    moreButton.onclick = appendNextBatch;
    appendNextBatch();
    if ("IntersectionObserver" in window) {
      renderObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !moreButton.hidden) appendNextBatch();
      }, { rootMargin: "600px 0px" });
      renderObserver.observe(moreButton);
    }
  }

  function createVideoSignature(videos) {
    const frontier = videos.slice(0, 30).map((video) => (
      `${video.videoId}:${video.publishedAt}:${video.title}`
    )).join("|");
    return `${videos.length}:${frontier}`;
  }

  function mergeLatestVideos(latestVideos, staticVideos) {
    const byId = new Map();
    for (const video of [...latestVideos, ...staticVideos]) {
      if (!byId.has(video.videoId)) byId.set(video.videoId, video);
    }
    return [...byId.values()].sort(compareNewestFirst);
  }

  function createVideoCard(video, index, totalItems) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    const thumbnail = document.createElement("span");
    const image = document.createElement("img");
    const copy = document.createElement("span");
    const title = document.createElement("span");
    const meta = document.createElement("span");
    const channel = document.createElement("span");
    const separator = document.createElement("span");
    const relativeDate = document.createElement("time");

    item.className = "news-youtube-card";
    item.setAttribute("aria-posinset", String(index + 1));
    item.setAttribute("aria-setsize", String(totalItems));
    link.className = "news-youtube-card-link";
    link.href = video.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `${video.title} — ${video.channelName}, ${formatAbsoluteDate(video.date)}`);
    thumbnail.className = "news-youtube-thumbnail";
    image.src = video.thumbnailUrl;
    image.alt = "";
    image.loading = index < 3 ? "eager" : "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove(), { once: true });
    copy.className = "news-youtube-copy";
    title.className = "news-youtube-title";
    title.textContent = video.title;
    meta.className = "news-youtube-meta";
    channel.className = "news-youtube-channel";
    channel.textContent = video.channelName;
    separator.className = "news-youtube-separator";
    separator.textContent = "•";
    relativeDate.className = "news-youtube-relative-date";
    relativeDate.dateTime = video.publishedAt;
    relativeDate.textContent = formatRelativeDate(video.publishedAt);

    thumbnail.append(image);
    meta.append(channel, separator, relativeDate);
    copy.append(title, meta);
    link.append(thumbnail, copy);
    item.append(link);
    return item;
  }

  function isValidPayload(payload) {
    if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.videos)) return false;
    if (payload.totalItems !== payload.videos.length) return false;
    return payload.videos.every(isValidVideo);
  }

  function isValidVideo(video) {
    if (!video || !/^[A-Za-z0-9_-]{11}$/.test(String(video.videoId || ""))) return false;
    if (!CHANNEL_NAMES.has(video.channelName) || !String(video.title || "").trim()) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(video.date || "")) || Number.isNaN(Date.parse(video.publishedAt))) return false;
    return video.url === `https://www.youtube.com/watch?v=${video.videoId}`
      && video.thumbnailUrl === `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`;
  }

  function compareNewestFirst(left, right) {
    return String(right.publishedAt).localeCompare(String(left.publishedAt))
      || String(left.videoId).localeCompare(String(right.videoId));
  }

  function formatAbsoluteDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return "";
    return `${Number(match[1])}년 ${Number(match[2])}월 ${Number(match[3])}일`;
  }

  function formatRelativeDate(value) {
    const published = new Date(value);
    if (Number.isNaN(published.getTime())) return "";
    const elapsedMs = Math.max(0, Date.now() - published.getTime());
    const days = Math.floor(elapsedMs / 86400000);
    if (days < 1) return "오늘";
    if (days < 7) return `${days}일 전`;
    if (days < 30) return `${Math.floor(days / 7)}주 전`;
    if (days < 365) return `${Math.floor(days / 30)}개월 전`;
    return `${Math.floor(days / 365)}년 전`;
  }
})();
