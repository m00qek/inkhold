// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { FIT_PAGE, FIT_WIDTH } from "../../src/pages/viewer/viewerControls";
import { createTxtViewer, TxtLoadError } from "../../src/pages/txt/txtViewer";
import { synthesizeSummary } from "../../src/pages/library/library";
import { deps, meta, FOLDER, HISTORY_VERSION, HISTORY, flush, fakeSeam, mount, q } from "./txtViewer.shared";

describe("txt viewer — render", () => {
  it("fetches the INLINE raw url (no download flag) and lays the decoded text out", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta({ id: "n-1", fileHash: "b".repeat(32) })), Promise.resolve(meta({ id: "n-1", fileHash: "b".repeat(32) })), 0, FOLDER, "");

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(`/file/n-1?v=${"b".repeat(32)}`);
    expect(q(v, ".viewer__placeholder")).not.toBeNull();
    expect(q(v, ".txt__sheet")).toBeNull();

    f.calls[0]!.d.resolve("Line one\n  indented\nLine three");
    await flush();

    const pre = q(v, ".txt__sheet")!;
    expect(pre).not.toBeNull();
    expect(pre.textContent).toBe("Line one\n  indented\nLine three");
    expect(q(v, ".viewer__placeholder")).toBeNull();
    v.destroy();
  });

  it("in a HISTORY preview: fetches the version's raw bytes, shows the banner + Versions, hides Move to bin", async () => {
    const onVersions = vi.fn();
    const onRestoreVersion = vi.fn();
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps({ onVersions, onRestoreVersion }), f.seam));
    await v.open(synthesizeSummary(meta({ id: "n-1", fileHash: "b".repeat(32) })), Promise.resolve(meta({ id: "n-1", fileHash: "b".repeat(32) })), 0, HISTORY, "");

    // The version-scoped history raw route, not the live `/file/:id?v=`.
    expect(f.calls[0]!.url).toBe(`/api/controlplane/note/n-1/history/${"e".repeat(32)}/raw`);

    const banner = q(v, ".version-banner") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("not the current note");
    expect((v.el.querySelector('button[aria-label="Move to bin"]') as HTMLElement).hidden).toBe(true);
    const versions = v.el.querySelector('button[aria-label="Version history"]') as HTMLElement;
    expect(versions.hidden).toBe(false);

    versions.click();
    expect(onVersions).toHaveBeenCalledOnce();
    (banner.querySelector(".version-banner__restore") as HTMLElement).click();
    expect(onRestoreVersion).toHaveBeenCalledWith(expect.objectContaining({ id: "n-1" }), HISTORY_VERSION);
    v.destroy();
  });

  it("renders device text as TEXT, never markup (no injection)", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("<img src=x onerror=alert(1)> & <b>bold</b>");
    await flush();
    const pre = q(v, ".txt__sheet")!;
    expect(pre.querySelector("img")).toBeNull();
    expect(pre.querySelector("b")).toBeNull();
    expect(pre.textContent).toContain("<img src=x onerror=alert(1)>");
    v.destroy();
  });

  it("shows an honest error state when the fetch fails (no throw)", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.reject(new TxtLoadError(500));
    await flush();

    expect(q(v, ".txt__sheet")).toBeNull();
    const ph = q(v, ".viewer__placeholder")!;
    expect(ph.textContent).toContain("read this file");
    expect((q(v, '[aria-label="Download"]') as HTMLAnchorElement).hidden).toBe(false);
    v.destroy();
  });

  it("routes a 401/403 to the shell's re-auth, not the error state", async () => {
    const onSessionExpired = vi.fn();
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps({ onSessionExpired }), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.reject(new TxtLoadError(401));
    await flush();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    v.destroy();
  });

  it("with no content hash, reads as unreadable without a fetch", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta({ fileHash: null })), Promise.resolve(meta({ fileHash: null })), 0, FOLDER, "");
    expect(f.calls).toHaveLength(0);
    expect(q(v, ".viewer__placeholder")!.textContent).toContain("read this file");
    v.destroy();
  });
});

describe("txt viewer — font size", () => {
  const smaller = (v: ReturnType<typeof createTxtViewer>) =>
    q(v, '[aria-label="Smaller text"]') as HTMLButtonElement;
  const larger = (v: ReturnType<typeof createTxtViewer>) =>
    q(v, '[aria-label="Larger text"]') as HTMLButtonElement;
  const label = (v: ReturnType<typeof createTxtViewer>) => q(v, ".pager .zoom")!;

  it("defaults to 16px and steps the label + persists on each change", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    expect(label(v).textContent).toBe("16px");

    larger(v).click();
    expect(label(v).textContent).toBe("18px");
    smaller(v).click();
    smaller(v).click();
    expect(label(v).textContent).toBe("14px");
    expect(f.saves).toEqual([18, 16, 14]);
    v.destroy();
  });

  it("applies the size to the live text and to text opened later", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("hello");
    await flush();

    const pre = q(v, ".txt__sheet") as HTMLPreElement;
    expect(pre.style.fontSize).toBe("16px");
    larger(v).click();
    expect(pre.style.fontSize).toBe("18px");
    v.destroy();
  });

  it("clamps at the 10–32px bounds and does not persist a no-op", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    for (let i = 0; i < 20; i++) larger(v).click();
    expect(label(v).textContent).toBe("32px");
    const savesAtMax = f.saves.length;
    larger(v).click();
    expect(f.saves.length).toBe(savesAtMax);

    for (let i = 0; i < 40; i++) smaller(v).click();
    expect(label(v).textContent).toBe("10px");
    v.destroy();
  });

  it("restores the persisted size on construction (survives a reload)", async () => {
    const f = fakeSeam(24);
    const v = mount(createTxtViewer(deps(), f.seam));
    expect(label(v).textContent).toBe("24px");
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("hi");
    await flush();
    expect((q(v, ".txt__sheet") as HTMLPreElement).style.fontSize).toBe("24px");
    v.destroy();
  });

  it("clamps an out-of-range persisted value into bounds", async () => {
    const v = mount(createTxtViewer(deps(), fakeSeam(9999).seam));
    expect(q(v, ".pager .zoom")!.textContent).toBe("32px");
    v.destroy();
  });
});

describe("txt viewer — zoom (reading column, distinct from font size)", () => {
  const zoomOut = (v: ReturnType<typeof createTxtViewer>) => q(v, '[aria-label="Zoom out"]') as HTMLButtonElement;
  const zoomIn = (v: ReturnType<typeof createTxtViewer>) => q(v, '[aria-label="Zoom in"]') as HTMLButtonElement;
  // `.txt-zoom`, not `.zoom`, so the two `.pager`s stay addressable.
  const zoomLabel = (v: ReturnType<typeof createTxtViewer>) => q(v, ".pager .txt-zoom")!;

  it("renders as a `−` [Fit] `+` control in the view zone, defaulting to Fit", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    expect(zoomOut(v)).not.toBeNull();
    expect(zoomIn(v)).not.toBeNull();
    expect(zoomLabel(v).textContent).toBe(FIT_PAGE);
    v.destroy();
  });

  it("steps the label and persists on each change, clamping silently at Fit", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));

    zoomIn(v).click();
    expect(zoomLabel(v).textContent).toBe("125%");
    zoomIn(v).click();
    expect(zoomLabel(v).textContent).toBe("150%");
    zoomOut(v).click();
    expect(zoomLabel(v).textContent).toBe("125%");
    expect(f.zoomSaves).toEqual([1, 2, 1]);

    zoomOut(v).click();
    const at = f.zoomSaves.length;
    zoomOut(v).click();
    expect(zoomLabel(v).textContent).toBe(FIT_PAGE);
    expect(f.zoomSaves.length).toBe(at);
    v.destroy();
  });

  it("scales the reading COLUMN via --txt-zoom, on the live text and text opened later", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("hello");
    await flush();

    const pre = q(v, ".txt__sheet") as HTMLPreElement;
    expect(pre.style.getPropertyValue("--txt-zoom")).toBe("1");
    zoomIn(v).click();
    expect(pre.style.getPropertyValue("--txt-zoom")).toBe("1.25");
    v.destroy();
  });

  it("tops out at `Fit ⇔`, which swaps the MECHANISM rather than raising the factor", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("hi");
    await flush();
    const pre = q(v, ".txt__sheet") as HTMLPreElement;

    for (const factor of ["1.25", "1.5", "1.75"]) {
      zoomIn(v).click();
      expect(pre.style.getPropertyValue("--txt-zoom")).toBe(factor);
      expect(pre.classList.contains("txt__sheet--wide")).toBe(false);
    }

    // The top rung drops `--txt-zoom`; a stale one would decide the aspect later.
    zoomIn(v).click();
    expect(zoomLabel(v).textContent).toBe(FIT_WIDTH);
    expect(pre.classList.contains("txt__sheet--wide")).toBe(true);
    expect(pre.style.getPropertyValue("--txt-zoom")).toBe("");

    const at = f.zoomSaves.length;
    zoomIn(v).click();
    expect(zoomLabel(v).textContent).toBe(FIT_WIDTH);
    expect(f.zoomSaves.length).toBe(at);

    zoomOut(v).click();
    expect(zoomLabel(v).textContent).toBe("175%");
    expect(pre.classList.contains("txt__sheet--wide")).toBe(false);
    expect(pre.style.getPropertyValue("--txt-zoom")).toBe("1.75");
    v.destroy();
  });

  it("text arriving LATER opens at the fit-width rung, not at a bare factor", async () => {
    // Regression: text landing afterwards wrote `--txt-zoom` directly, ignoring fit-width.
    const f = fakeSeam(null, 4);
    const v = mount(createTxtViewer(deps(), f.seam));
    expect(zoomLabel(v).textContent).toBe(FIT_WIDTH);
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("hi");
    await flush();
    const pre = q(v, ".txt__sheet") as HTMLPreElement;
    expect(pre.classList.contains("txt__sheet--wide")).toBe(true);
    expect(pre.style.getPropertyValue("--txt-zoom")).toBe("");
    v.destroy();
  });

  it("restores the persisted zoom on construction (survives a reload)", async () => {
    const f = fakeSeam(null, 2);
    const v = mount(createTxtViewer(deps(), f.seam));
    expect(zoomLabel(v).textContent).toBe("150%");
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("hi");
    await flush();
    expect((q(v, ".txt__sheet") as HTMLPreElement).style.getPropertyValue("--txt-zoom")).toBe("1.5");
    v.destroy();
  });

  it("zoom and font size are INDEPENDENT knobs — one moves without disturbing the other", async () => {
    const f = fakeSeam();
    const v = mount(createTxtViewer(deps(), f.seam));
    await v.open(synthesizeSummary(meta()), Promise.resolve(meta()), 0, FOLDER, "");
    f.calls[0]!.d.resolve("body");
    await flush();
    const pre = q(v, ".txt__sheet") as HTMLPreElement;

    (q(v, '[aria-label="Zoom in"]') as HTMLButtonElement).click();
    expect(pre.style.getPropertyValue("--txt-zoom")).toBe("1.25");
    expect(pre.style.fontSize).toBe("16px");
    expect(q(v, ".pager .zoom")!.textContent).toBe("16px");

    (q(v, '[aria-label="Larger text"]') as HTMLButtonElement).click();
    expect(pre.style.fontSize).toBe("18px");
    expect(pre.style.getPropertyValue("--txt-zoom")).toBe("1.25");
    expect(zoomLabel(v).textContent).toBe("125%");
    v.destroy();
  });
});
