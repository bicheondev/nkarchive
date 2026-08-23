(function initializeNewsDisclaimer() {
  const STORAGE_KEY = "news-disclaimer-dismissed";
  const disclaimer = document.querySelector("#newsDisclaimer");
  const closeButton = document.querySelector("#newsDisclaimerClose");
  const dontShowAgain = document.querySelector("#newsDisclaimerDontShow");
  let previousFocus = null;

  if (!disclaimer || !closeButton || isDismissedPermanently()) return;

  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  disclaimer.hidden = false;
  window.requestAnimationFrame(() => closeButton.focus());

  closeButton.addEventListener("click", dismiss);
  disclaimer.addEventListener("keydown", handleKeydown);

  function dismiss() {
    if (dontShowAgain?.checked) persistDismissal();
    const shouldRestoreFocus = disclaimer.contains(document.activeElement);
    disclaimer.hidden = true;
    if (shouldRestoreFocus) previousFocus?.focus?.();
    previousFocus = null;
  }

  function handleKeydown(event) {
    if (disclaimer.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = [...disclaimer.querySelectorAll("button, input, a, [tabindex]:not([tabindex='-1'])")].filter(
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

  function isDismissedPermanently() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  }

  function persistDismissal() {
    try {
      window.localStorage.setItem(STORAGE_KEY, "true");
    } catch {}
  }
})();
