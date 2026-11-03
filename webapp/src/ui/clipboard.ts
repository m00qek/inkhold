// Clipboard writes that work over plain HTTP: `navigator.clipboard` is absent
// outside a secure context (the usual LAN deployment; localhost is exempt), so
// it falls back to `execCommand("copy")`, and reports whether either worked.

/** Resolves `true` if the text landed; never throws. */
export async function copyText(text: string): Promise<boolean> {
  if (text === "") return false;
  try {
    // On a plain-HTTP LAN address `navigator.clipboard` is undefined.
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied: the legacy path follows different rules and often still works.
  }
  return legacyCopy(text);
}

/**
 * `execCommand("copy")` over a mounted, selected `<textarea>`, positioned
 * off-screen because `display: none`/`visibility: hidden` make it unselectable.
 */
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.tabIndex = -1;
  const st = ta.style;
  st.position = "fixed";
  st.top = "0";
  st.left = "0";
  st.width = "1px";
  st.height = "1px";
  st.padding = "0";
  st.border = "0";
  st.opacity = "0";
  st.pointerEvents = "none";
  document.body.append(ta);
  const had = document.activeElement as HTMLElement | null;
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    ta.remove();
    had?.focus?.();
  }
  return ok;
}
