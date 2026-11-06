// The reader's non-`.note` stage, shown instead of the canvas: an `<img>`, or
// the no-preview block with a download.

import { el } from "../ui/dom";
import { svg, VIEWER_IC } from "./viewer/viewerIcons";
import type { Id, NoteMeta } from "../core/types";

export interface FileStageDeps {
  /** Whether `id` is still the open file; a late load must not paint over another. */
  isCurrent: (id: Id) => boolean;
  /** Re-fit the zoom once the image has layout. */
  onSized: () => void;
}

export interface FileStage {
  el: HTMLElement;
  img: HTMLImageElement;
  /** `title`/`body` vary so a failed image load says so. */
  showNoPreview(m: NoteMeta, title: string, body: string, downloadUrl: string | null): void;
  /**
   * Image mode. The old `src` is cleared first, or the previous image stays
   * painted under the new title until the new bytes arrive. `fallback` is the
   * no-preview shown if the bytes don't load.
   */
  showImage(m: NoteMeta, url: string, fallback: () => void): void;
  clear(): void;
}

export function createFileStage(deps: FileStageDeps): FileStage {
  const img = el("img", { class: "filestage__img", alt: "" }) as HTMLImageElement;
  // `naturalWidth` is 0 until load, so re-apply the zoom then.
  img.addEventListener("load", () => deps.onSized());
  const body = el("div", { class: "empty filestage__empty" });
  const stage = el("div", { class: "filestage", hidden: true }, img, body);

  function showNoPreview(m: NoteMeta, title: string, text: string, downloadUrl: string | null): void {
    img.hidden = true;
    img.removeAttribute("src"); // stop a pending load painting over this
    body.hidden = false;
    body.replaceChildren(
      el("div", { class: "empty__mark", text: m.fileType.toUpperCase() }),
      // Device-authored: textContent, like every other name on this surface.
      el("h2", { text: title }),
      el("p", { text }),
      ...(downloadUrl
        ? [el("a", { class: "btn filestage__download", href: downloadUrl, download: "", html: svg(VIEWER_IC.down, 1.8) + "Download" })]
        : []),
    );
  }

  /** The no-preview layout minus the download, while an image loads. */
  function showImageLoading(m: NoteMeta): void {
    body.hidden = false;
    body.replaceChildren(
      el("div", { class: "empty__mark", text: m.fileType.toUpperCase() }),
      el("h2", { text: m.name }),
      el("p", { text: "Loading this picture…" }),
    );
  }

  return {
    el: stage,
    img,
    showNoPreview,
    showImage(m, url, fallback) {
      img.onload = null;
      img.onerror = null;
      img.removeAttribute("src");
      img.hidden = true;
      showImageLoading(m);
      // Empty alt: the file name is already the heading.
      img.alt = "";
      img.onload = () => {
        if (!deps.isCurrent(m.id)) return; // moved on while loading
        body.hidden = true;
        body.replaceChildren();
        img.hidden = false;
        // Re-fit now that the image has layout.
        deps.onSized();
      };
      // An <img> error carries no status for `dispatchApiFailure`; fall back to no-preview.
      img.onerror = () => {
        if (!deps.isCurrent(m.id)) return; // moved on while loading
        fallback();
      };
      img.src = url;
    },
    clear() {
      img.onload = null;
      img.onerror = null;
      img.removeAttribute("src");
      body.replaceChildren();
    },
  };
}
