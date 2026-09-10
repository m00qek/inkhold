// Putting text on the clipboard, on the connection this app is actually served
// over.
//
// `navigator.clipboard` REQUIRES A SECURE CONTEXT, and this app's normal
// deployment is not one. TLS is opt-in here (README: "Set `tls.enabled = true`"),
// so the household case is a Pi answering plain HTTP on a home network address —
// where `navigator.clipboard` is not merely blocked but ABSENT, on every browser,
// with no prompt and no permission the user could grant. `localhost` is exempt
// from that rule, which is exactly why a developer never meets it: it works on
// the machine you build on and fails on the machine you use.
//
// So the async API is the PREFERRED path, not the path. The fallback is the
// deprecated `execCommand("copy")` over a throwaway <textarea>, which predates
// secure contexts and is still implemented by every browser that matters.
//
// AND IT REPORTS WHETHER IT WORKED, because a caller that cannot tell success
// from failure cannot tell the user either — and the text a PDF selection copies
// is painted on a canvas, so a silent failure leaves nothing on screen to fall
// back to reading by hand.

/**
 * Put `text` on the system clipboard. Resolves `true` if it landed; never
 * throws — a clipboard that will not take the text is a result, not an error.
 */
export async function copyText(text: string): Promise<boolean> {
  if (text === "") return false;
  try {
    // The optional chain is load-bearing, not defensive: on the plain-HTTP LAN
    // address the whole object is undefined.
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied. Fall through: the older path answers to different rules and often
    // still works.
  }
  return legacyCopy(text);
}

/**
 * `execCommand("copy")` over a hidden `<textarea>`.
 *
 * The element has to be IN THE DOCUMENT and its text SELECTED for the command to
 * have anything to copy, which is the whole reason for the mount/remove dance.
 * It is positioned off-screen rather than hidden: `display: none` (and
 * `visibility: hidden`) make it unselectable, and an unselectable textarea
 * copies nothing.
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
  // So a click landing during its brief life reaches what is under it. It is
  // the fixed position above, not this, that stops the page scrolling to it.
  st.pointerEvents = "none";
  document.body.append(ta);
  // Where the focus was, so a copy does not move it: the find field is the
  // caller most likely to be focused.
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
