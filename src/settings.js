export function setupSettings({ openButton, drawer, backdrop, closeButton }) {
  let returnFocus = openButton;
  const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

  function open() {
    returnFocus = document.activeElement;
    drawer.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add("settings-open");
    openButton.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => closeButton.focus());
  }

  function close() {
    if (drawer.hidden) return;
    drawer.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove("settings-open");
    openButton.setAttribute("aria-expanded", "false");
    returnFocus?.focus?.({ preventScroll: true });
  }

  function onKeydown(event) {
    if (drawer.hidden) return;
    if (event.key === "Escape") return close();
    if (event.key !== "Tab") return;
    const focusable = [...drawer.querySelectorAll(focusableSelector)].filter(node => !node.hidden && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  openButton.addEventListener("click", open);
  closeButton.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  document.addEventListener("keydown", onKeydown);

  return { open, close, destroy() { document.removeEventListener("keydown", onKeydown); } };
}
