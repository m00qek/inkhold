// The layers panel, shared across file formats — the FORMAT-NEUTRAL half of the
// `.spd` viewer's panel, split out (like toolbar.ts before it) so the `.note`
// reader can grow the SAME panel without a second implementation (the extraction
// `docs/scratch/archive/note-layers-panel.md` decides). What lives here is everything a
// layers panel is regardless of format: a semantic `<aside>` holding a real
// `<ul>` of layer rows, each with a LEADING thumbnail, a name, a visibility eye,
// and — only when the layer carries opacity — a draggable FILL BAR.
//
// THE ROW (variant C — "length carries the number"). The thumbnail LEADS; a
// middle column holds a top line (name + eye) and, beneath it, a slim opacity
// FILL BAR: a thin track whose fill WIDTH == the opacity %, with a mono `%`
// readout at its right. Dragging the bar sets opacity — the bar's LENGTH is the
// value, the app's signature (the same idea as the bin's retention rule). The
// bar is a real `role="slider"` (arrow-key operable, focusable) so keyboard and
// assistive tech reach it exactly as they reached the ± stepper it replaces.
//
// WHAT STAYS FORMAT-SPECIFIC, BY DESIGN:
//   - How a toggle repaints pixels. The panel only calls `onToggle`/`onOpacity`;
//     the `.spd` viewer maps those onto its stacked canvases (style.display /
//     style.opacity), and a `.note` reader will do the same over its own stack.
//   - The thumbnail's pixels. `paintThumb` is caller-supplied because only the
//     format knows what a layer looks like (and its special cases — the `.spd`
//     blank Reference Layer stays on the `.spd` side). The panel adds the
//     `layers-panel__thumb` class so the shared sizing (14-layers-panel.css,
//     `--preview-h-panel`) applies to whatever comes back.
//   - Whether opacity EXISTS. The fill bar renders only when the layer model
//     carries `opacity` — data-driven, no format flags. `.spd` layers do
//     (0..255 on the wire, 0..1 here); `.note` layers have none
//     (device-confirmed, note-layers-panel.md) and simply omit the field, so the
//     row is just thumb + name + eye.
//
// STATE MODEL. The panel is handed the CURRENT view state and owns its own DOM
// from there: the eye and the bar mutate rows locally and report through the
// callbacks; `setLayers` rebuilds the list wholesale (each open). It never
// persists anything — layer tuning is view-only everywhere, always.
//
// CHROME. The docked card and its `[layers] Layers` head are the SHARED side
// panel (src/ui/sidePanel.ts) — the exact chrome the reader's "Recognized text"
// aside rides, so the two panels can't drift. This module fills that panel's
// body with the `<ul>` of rows; the row look rides the neutral `layers-panel__*`
// classes (styled in 14-layers-panel.css).
//
// CLASSES. A format passes `hookPrefix` to ALSO stamp its own namespace
// (`spd` → `spd-layers` on the card/head, `spd-layer__eye`, … on the rows) — the
// stable hooks its tests and any format-specific rules (e.g.
// `.spd-layer__thumb--blank`) select on, kept mechanical so `.note` gets
// `note-layers`/`note-layer__…` for free.

import { el } from "../ui/dom";
import { createSidePanel, sidePanelState, type SidePanelStateKind } from "../ui/sidePanel";
import { svg, VIEWER_IC } from "./viewerChrome";

/**
 * One layer as the panel shows it: identity plus the state being VIEWED (the
 * live tuning, not necessarily the authored file state — the caller decides
 * what to feed). `opacity` present (0..1) means the format has per-layer
 * opacity and the row grows a fill bar; absent means it does not (`.note`).
 *
 * Related to the export side's `ExportLayer` (src/export/layered.ts): same
 * `id`/`name` identity, but exports carry BOTH states (authored + current)
 * with opacity resolved to a number — a format without opacity exports 1.
 */
export interface PanelLayer {
  id: number;
  /** May be empty — the panel then shows `Layer <id>`, matching exports. */
  name: string;
  visible: boolean;
  /** 0..1. Present → the row renders the opacity fill bar. */
  opacity?: number;
}

export interface LayersPanelOptions {
  /** `id` for the `<aside>`, the target of the opener's `aria-controls`. */
  id?: string;
  /**
   * Format namespace for hook classes (`"spd"` → `spd-layers`, `spd-layer`,
   * `spd-layer__eye`, …). Purely additional — the shared look stays on the
   * neutral classes.
   */
  hookPrefix?: string;
  /** Paint one layer's thumbnail. The panel sizes it via `layers-panel__thumb`. */
  paintThumb: (layer: PanelLayer) => HTMLElement;
  /** A row's eye was toggled. `visible` is the new state. */
  onToggle: (id: number, visible: boolean) => void;
  /** A row's fill bar moved. `opacity01` is the new value, 0..1. */
  onOpacity?: (id: number, opacity01: number) => void;
}

export interface LayersPanel {
  /** The `<aside>` — mounted and shown/hidden (`.hidden`) by the caller. */
  el: HTMLElement;
  /** Rebuild the rows (top-first, Z-order) — called on each document open. */
  setLayers(layers: PanelLayer[]): void;
  /**
   * Replace the rows with the SHARED side-panel state line (src/ui/sidePanel.ts)
   * — the same "still loading / nothing here / that failed" vocabulary the OCR
   * panel speaks. A panel left open across a page turn must say it is loading
   * the new page, not keep listing the PREVIOUS page's layers and thumbnails.
   */
  setState(kind: SidePanelStateKind, message: string): void;
}

export function createLayersPanel(opts: LayersPanelOptions): LayersPanel {
  // Neutral class + the format's hook class, mechanically namespaced: the panel
  // level hooks as `<prefix>-layers[__part]`, the row level as
  // `<prefix>-layer[__part]` — exactly the `.spd` viewer's historical names. The
  // panel-level chrome (card + head) is the shared primitive's now; what stays
  // here are the list and row hooks.
  const p = opts.hookPrefix;
  const cls = {
    list: `layers-panel__list${p ? ` ${p}-layers__list` : ""}`,
    row: `layers-panel__row${p ? ` ${p}-layer` : ""}`,
    mid: `layers-panel__mid${p ? ` ${p}-layer__mid` : ""}`,
    top: `layers-panel__top${p ? ` ${p}-layer__top` : ""}`,
    name: `layers-panel__name${p ? ` ${p}-layer__name` : ""}`,
    eye: `layers-panel__eye${p ? ` ${p}-layer__eye` : ""}`,
    barwrap: `layers-panel__barwrap${p ? ` ${p}-layer__barwrap` : ""}`,
    bar: `layers-panel__bar${p ? ` ${p}-layer__bar` : ""}`,
    barFill: `layers-panel__bar-fill${p ? ` ${p}-layer__bar-fill` : ""}`,
    pct: `layers-panel__pct${p ? ` ${p}-layer__pct` : ""}`,
    thumb: ["layers-panel__thumb", ...(p ? [`${p}-layer__thumb`] : [])],
  };

  // A real <ul>: the panel IS a list of layers, and a list element is what says
  // so to assistive tech (row count, item position) — the classes carry the look.
  const list = el("ul", { class: cls.list });
  // The docked card + `[layers] Layers` head is the SHARED side-panel primitive
  // (src/ui/sidePanel.ts) — the same chrome the reader's "Recognized text" aside
  // rides. The layers panel is the WIDE variant (rows carry a thumbnail + name +
  // fill bar + eye); the format's namespace hooks the card/head as
  // `<prefix>-layers[__…]` so the `.spd` tests and the blank-thumb rule still
  // select on it. The rows go INTO its body.
  const panel = createSidePanel({
    id: opts.id,
    ariaLabel: "Layers",
    icon: svg(VIEWER_IC.layers, 1.7),
    label: "Layers",
    wide: true,
    hookPrefix: p ? `${p}-layers` : undefined,
  });
  panel.body.append(list);

  /**
   * One row: the caller-painted thumbnail LEADS, then a middle column with a top
   * line (name + visibility eye) and — only when the layer carries opacity — a
   * draggable fill bar with a mono `%` readout. The eye drives `onToggle`; the
   * bar drives `onOpacity` (0..1), clamped 0–100, continuous on drag and 1% per
   * arrow key (Home/End → 0/100). Hiding a layer DISABLES its bar (opacity is
   * meaningless on an invisible layer); toggling it back on re-enables it.
   */
  function buildRow(layer: PanelLayer): HTMLElement {
    const shown = layer.visible;

    const eye = el("button", {
      class: cls.eye,
      type: "button",
      "aria-pressed": String(shown),
      "aria-label": `Toggle ${layer.name || `layer ${layer.id}`}`,
      title: "Toggle visibility",
      html: svg(shown ? VIEWER_IC.eye : VIEWER_IC.eyeOff, 1.9),
    }) as HTMLButtonElement;
    const nameEl = el("span", { class: cls.name, text: layer.name || `Layer ${layer.id}` });
    const top = el("div", { class: cls.top }, nameEl, eye);

    // Opacity is data-driven: no `opacity` on the model → no fill bar in the row
    // (a `.note` layer is just thumb + name + eye).
    let setBarEnabled: (enabled: boolean) => void = () => {};
    const midKids: HTMLElement[] = [top];
    if (layer.opacity !== undefined) {
      let now = Math.round(layer.opacity * 100);
      const fill = el("div", { class: cls.barFill });
      fill.style.width = `${now}%`;
      const pctEl = el("span", { class: cls.pct, text: `${now}%` });
      const bar = el("div", {
        class: cls.bar,
        role: "slider",
        "aria-label": "Opacity",
        "aria-valuenow": String(now),
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        tabindex: "0",
      }, fill);
      const barwrap = el("div", { class: cls.barwrap }, bar, pctEl);

      // The bar is disabled while its layer is hidden — the interlock below flips
      // this; every input path bails on it (no drag, no keyboard, no focus).
      let disabled = !shown;

      // Set the value from a % (clamped, rounded), pushing the change to the fill
      // WIDTH (the visible length), the readout, the ARIA value, and the caller.
      const setValue = (pct: number): void => {
        const next = Math.max(0, Math.min(100, Math.round(pct)));
        if (next === now) return; // at a bound / no movement — silent no-op.
        now = next;
        fill.style.width = `${next}%`;
        pctEl.textContent = `${next}%`;
        bar.setAttribute("aria-valuenow", String(next));
        opts.onOpacity?.(layer.id, next / 100);
      };
      // Map a pointer's X within the track to a 0–100 value (0 at the left edge,
      // 100 at the right) — the drag reads position as the number, continuously.
      const setFromClientX = (clientX: number): void => {
        const rect = bar.getBoundingClientRect();
        if (rect.width <= 0) return;
        setValue(((clientX - rect.left) / rect.width) * 100);
      };

      // Mouse drag: press to seize, then track document-wide moves until release
      // (the pointer can leave the thin bar mid-drag and must keep steering).
      bar.addEventListener("mousedown", (e) => {
        const ev = e as MouseEvent;
        if (disabled || ev.button !== 0) return;
        ev.preventDefault(); // don't start a text selection / steal focus oddly.
        bar.focus();
        setFromClientX(ev.clientX);
        const move = (m: MouseEvent): void => setFromClientX(m.clientX);
        const up = (): void => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
      // Touch drag: same mapping, but preventDefault so dragging the bar doesn't
      // also scroll the panel (the exact care the old ± ramp took).
      const onTouch = (e: TouchEvent): void => {
        if (disabled) return;
        const t = e.touches[0];
        if (!t) return;
        if (e.cancelable) e.preventDefault();
        setFromClientX(t.clientX);
      };
      bar.addEventListener("touchstart", onTouch, { passive: false });
      bar.addEventListener("touchmove", onTouch, { passive: false });

      // Keyboard: arrows step 1%, Home/End jump to the bounds — the fine control
      // the ± buttons used to give, now on the slider itself.
      bar.addEventListener("keydown", (e) => {
        if (disabled) return;
        let handled = true;
        switch ((e as KeyboardEvent).key) {
          case "ArrowRight":
          case "ArrowUp":
            setValue(now + 1);
            break;
          case "ArrowLeft":
          case "ArrowDown":
            setValue(now - 1);
            break;
          case "Home":
            setValue(0);
            break;
          case "End":
            setValue(100);
            break;
          default:
            handled = false;
        }
        if (handled) e.preventDefault();
      });

      // Hidden-disables-opacity interlock: a hidden layer's bar is dimmed and
      // inert — no pointer, no keyboard, dropped from the tab order. Seeded from
      // the handed-in visibility, flipped by the eye handler.
      setBarEnabled = (enabled: boolean): void => {
        disabled = !enabled;
        barwrap.classList.toggle("is-disabled", !enabled);
        bar.setAttribute("aria-disabled", String(!enabled));
        if (enabled) bar.setAttribute("tabindex", "0");
        else bar.removeAttribute("tabindex");
      };
      setBarEnabled(shown);
      midKids.push(barwrap);
    }

    const mid = el("div", { class: cls.mid }, ...midKids);

    // The caller paints the pixels; the panel stamps the shared sizing class
    // (and the format hook) on whatever element comes back. The thumb LEADS.
    const thumb = opts.paintThumb(layer);
    thumb.classList.add(...cls.thumb);

    const row = el("li", { class: shown ? cls.row : `${cls.row} is-hidden` }, thumb, mid);

    let visibleNow = shown;
    eye.addEventListener("click", () => {
      visibleNow = !visibleNow;
      opts.onToggle(layer.id, visibleNow);
      eye.setAttribute("aria-pressed", String(visibleNow));
      eye.innerHTML = svg(visibleNow ? VIEWER_IC.eye : VIEWER_IC.eyeOff, 1.9);
      row.classList.toggle("is-hidden", !visibleNow);
      setBarEnabled(visibleNow); // opacity is meaningless while hidden.
    });
    return row;
  }

  return {
    el: panel.el,
    setLayers(layers: PanelLayer[]): void {
      list.replaceChildren(...layers.map(buildRow));
      // Re-seats the <ul> after a `setState` swapped it out for the state line.
      panel.body.replaceChildren(list);
    },
    setState(kind: SidePanelStateKind, message: string): void {
      // The line REPLACES the list rather than sitting beside it: a <p> is not a
      // valid child of a <ul>, and a stale row under a "loading" line would be
      // the very claim this exists to retract. The rows are dropped too, so the
      // previous page's thumbnail canvases are not held alive off-screen.
      list.replaceChildren();
      panel.body.replaceChildren(sidePanelState(kind, message));
    },
  };
}
