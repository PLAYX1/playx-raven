import { t } from "./i18n";

const STORAGE = "ravenvault-ravi-panel";
export function createRaviPanel(send: () => void, changed: () => void, afterLanding: (run: () => void) => void = run => run()) {
  const el = (id: string) => document.getElementById(id)!;
  const panel = el("ravi-panel"), launcher = el("ravi-launcher"), log = el("chat-log");
  const input = el("chat-q") as HTMLTextAreaElement, fresh = el("ravi-new");
  panel.append(el("ravi-chatwrap"));
  let open = false, large = false, suspended = false, following = true, pending = false;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) || "{}");
    large = saved.large === true; // Only size survives a restart, never visibility.
  } catch { /* Storage is optional; the current session still works. */ }
  const atBottom = () => log.scrollHeight - log.clientHeight - log.scrollTop <= 32;
  const bottom = () => { log.scrollTop = log.scrollHeight; following = true; pending = false; fresh.hidden = true; };
  function paint() {
    panel.hidden = !open || suspended;
    launcher.hidden = open || suspended;
    panel.classList.toggle("large", large);
    el("ravi-expand").setAttribute("aria-pressed", String(large));
    el("ravi-expand").textContent = t(large ? "작게" : "크게");
    for (const id of ["ravi-launcher", "rv-header-ravi", "ravi-open", "ravi-menu-open"]) {
      el(id).setAttribute("aria-expanded", String(open));
      el(id).setAttribute("aria-controls", "ravi-panel");
    }
    changed();
  }
  function save() {
    try { localStorage.setItem(STORAGE, JSON.stringify({ open, large })); } catch { /* Best effort. */ }
  }
  function show(focus = true) {
    afterLanding(() => {
      open = true; paint(); save();
      if (following) bottom();
      if (focus && !suspended) input.focus({ preventScroll: true });
    });
  }
  function collapse() {
    const ownedFocus = panel.contains(document.activeElement);
    open = false; paint(); save();
    if (ownedFocus && !suspended) launcher.focus({ preventScroll: true });
  }
  for (const id of ["ravi-launcher", "ravi-open", "ravi-menu-open"]) el(id).onclick = () => show();
  el("ravi-collapse").onclick = collapse;
  el("ravi-expand").onclick = () => { large = !large; paint(); save(); if (following) bottom(); };
  log.addEventListener("scroll", () => { following = atBottom(); if (following) { pending = false; fresh.hidden = true; } }, { passive: true });
  fresh.onclick = bottom;
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !suspended && !panel.classList.contains("reviewing")) { event.preventDefault(); send(); }
  });
  document.addEventListener("keydown", event => {
    // External approval dialogs own Escape. The conversation never traps page focus.
    if (event.key === "Escape" && open && !suspended) {
      event.preventDefault(); collapse();
    }
  });
  // Layout changes and translated/dynamic message content may increase history height.
  const resize = new ResizeObserver(() => { if (following && open && !suspended) bottom(); });
  resize.observe(log); resize.observe(panel);
  const content = new MutationObserver(() => { if (following && open && !suspended) bottom(); });
  content.observe(log, { childList: true, subtree: true, characterData: true });
  paint();
  return {
    open: show,
    visible: () => open && !suspended,
    suspend(value: boolean) { if (value !== suspended) { suspended = value; paint(); if (!value && following) bottom(); } },
    message(answer: boolean) {
      if (following && open && !suspended) bottom();
      else if (answer) {
        pending = true; fresh.hidden = false;
        el("ravi-announcement").textContent = t("새 답이 왔어요");
      }
      if (!pending) fresh.hidden = true;
    },
    sent() { bottom(); if (open && !suspended) input.focus({ preventScroll: true }); },
  };
}
