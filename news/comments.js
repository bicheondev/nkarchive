(function initializeNewsComments() {
  const section = document.querySelector("#newsComments");
  const countElement = document.querySelector("#newsCommentsCount");
  const form = document.querySelector("#newsCommentsForm");
  const nameInput = document.querySelector("#newsCommentName");
  const contentInput = document.querySelector("#newsCommentContent");
  const websiteInput = document.querySelector("#newsCommentWebsite");
  const submitButton = document.querySelector("#newsCommentsSubmit");
  const statusElement = document.querySelector("#newsCommentsStatus");
  const listElement = document.querySelector("#newsCommentsList");
  const moreButton = document.querySelector("#newsCommentsMore");
  if (!section || !countElement || !form || !nameInput || !contentInput || !websiteInput || !submitButton || !statusElement || !listElement || !moreButton) return;

  const COMMENTS_URL = "/api/news-comments";
  const PAGE_SIZE = 20;
  let articleId = "";
  let comments = [];
  let total = 0;
  let nextCursor = "";
  let loading = false;

  window.NewsComments = Object.freeze({ initialize });
  form.addEventListener("submit", submitComment);
  moreButton.addEventListener("click", () => loadComments({ reset: false }));
  contentInput.addEventListener("input", () => contentInput.setCustomValidity(""));

  function initialize(value) {
    const nextArticleId = String(value || "").trim();
    if (!nextArticleId || articleId) return;
    articleId = nextArticleId;
    section.hidden = false;
    loadComments({ reset: true });
  }

  async function loadComments({ reset }) {
    if (!articleId || loading || (!reset && !nextCursor)) return;
    loading = true;
    section.setAttribute("aria-busy", "true");
    moreButton.disabled = true;
    if (reset) {
      submitButton.disabled = true;
      statusElement.hidden = false;
      statusElement.textContent = "댓글을 불러오는 중입니다.";
    }

    try {
      const parameters = new URLSearchParams({ articleId, limit: String(PAGE_SIZE) });
      if (!reset && nextCursor) parameters.set("cursor", nextCursor);
      const response = await fetch(`${COMMENTS_URL}?${parameters.toString()}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw createResponseError(response, payload);
      if (!isCommentsPayload(payload)) throw new Error("invalid_comments_payload");

      const knownIds = new Set(reset ? [] : comments.map((comment) => comment.id));
      const nextComments = payload.comments.filter((comment) => !knownIds.has(comment.id));
      comments = reset ? nextComments : [...comments, ...nextComments];
      total = payload.total;
      nextCursor = payload.nextCursor || "";
      renderComments();
      submitButton.disabled = false;
    } catch (error) {
      console.error("[news] Unable to load comments.", error);
      statusElement.hidden = false;
      statusElement.textContent = "댓글을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
      if (reset) {
        comments = [];
        total = 0;
        nextCursor = "";
        renderComments({ preserveStatus: true });
      }
    } finally {
      loading = false;
      moreButton.disabled = false;
      section.setAttribute("aria-busy", "false");
    }
  }

  async function submitComment(event) {
    event.preventDefault();
    if (!articleId || submitButton.disabled) return;

    const name = normalizeName(nameInput.value);
    const content = normalizeContent(contentInput.value);
    if (!content) {
      contentInput.setCustomValidity("댓글 내용을 입력해 주세요.");
      contentInput.reportValidity();
      contentInput.focus();
      return;
    }

    submitButton.disabled = true;
    submitButton.setAttribute("aria-busy", "true");
    statusElement.hidden = false;
    statusElement.textContent = "댓글을 등록하는 중입니다.";

    try {
      const response = await fetch(COMMENTS_URL, {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": createRequestId(),
        },
        body: JSON.stringify({
          articleId,
          name,
          content,
          website: String(websiteInput.value || ""),
        }),
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw createResponseError(response, payload);
      if (!isComment(payload?.comment)) throw new Error("invalid_comment_payload");

      if (!comments.some((comment) => comment.id === payload.comment.id)) comments.unshift(payload.comment);
      total = Number.isSafeInteger(payload.total) && payload.total >= comments.length
        ? payload.total
        : Math.max(total + 1, comments.length);
      contentInput.value = "";
      websiteInput.value = "";
      renderComments({ preserveStatus: true });
      statusElement.hidden = false;
      statusElement.textContent = "댓글을 남겼습니다.";
    } catch (error) {
      console.error("[news] Unable to submit comment.", error);
      statusElement.hidden = false;
      statusElement.textContent = error?.status === 429
        ? "댓글을 너무 빠르게 등록했습니다. 잠시 후 다시 시도해 주세요."
        : "댓글을 등록하지 못했습니다. 작성한 내용은 그대로 보관했습니다.";
    } finally {
      submitButton.disabled = false;
      submitButton.removeAttribute("aria-busy");
    }
  }

  function renderComments({ preserveStatus = false } = {}) {
    countElement.textContent = String(total);
    listElement.replaceChildren(...comments.map(createCommentItem));
    moreButton.hidden = !nextCursor;
    if (preserveStatus) return;
    statusElement.hidden = comments.length > 0;
    statusElement.textContent = comments.length ? "" : "아직 댓글이 없습니다. 첫 댓글을 남겨 주세요.";
  }

  function createCommentItem(comment) {
    const item = document.createElement("li");
    const name = document.createElement("p");
    const content = document.createElement("p");
    item.className = "news-comment";
    name.className = "news-comment-name";
    name.textContent = comment.name;
    content.className = "news-comment-content";
    content.textContent = comment.content;
    item.append(name, content);
    return item;
  }

  function normalizeName(value) {
    const normalized = normalizeText(value).replace(/\s+/gu, " ");
    return normalized || "익명";
  }

  function normalizeContent(value) {
    return normalizeText(value)
      .replace(/\r\n?/gu, "\n")
      .replace(/[ \t]+\n/gu, "\n")
      .trim();
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFC")
      .replace(/[\u200b\ufeff]/gu, "")
      .trim();
  }

  function createRequestId() {
    const cryptoApi = globalThis.crypto;
    if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
    if (typeof cryptoApi?.getRandomValues !== "function") {
      throw new Error("secure_random_unavailable");
    }
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function readJsonResponse(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  function createResponseError(response, payload) {
    const error = new Error(String(payload?.error || `news_comments_${response.status}`));
    error.status = response.status;
    return error;
  }

  function isCommentsPayload(payload) {
    return Boolean(payload
      && Array.isArray(payload.comments)
      && payload.comments.every(isComment)
      && Number.isSafeInteger(payload.total)
      && payload.total >= payload.comments.length
      && (payload.nextCursor === null || typeof payload.nextCursor === "string"));
  }

  function isComment(comment) {
    return Boolean(comment
      && typeof comment.id === "string"
      && typeof comment.name === "string"
      && typeof comment.content === "string"
      && typeof comment.createdAt === "string");
  }
})();
