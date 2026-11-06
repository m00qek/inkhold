// Links that the app follows itself. Anything that goes somewhere is an
// `<a href>`, so it can open in a new tab, be copied and say where it leads;
// a plain click still runs the app's own action (which may do more than
// change the address), and a click with a modifier or another button is left
// to the browser.

/** The main button, no modifier: the app's to handle; anything else opens a tab or window. */
export function isPlainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** Runs `action` on a plain click on `link` instead of following it. */
export function onPlainClick(link: HTMLElement, action: (e: MouseEvent) => void): void {
  link.addEventListener("click", (e) => {
    if (!isPlainClick(e)) return;
    e.preventDefault();
    action(e);
  });
}
