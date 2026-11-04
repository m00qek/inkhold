// The format-neutral layers panel (`.spd` and `.note`): a list of rows with a
// caller-painted thumbnail, name, eye and, only when the layer has opacity, a
// `role="slider"` fill bar whose width is the value. Never persists anything:
// layer tuning is view-only. `hookPrefix` adds format hook classes.

import { el } from "../ui/dom";
import { createSidePanel, sidePanelState, type SidePanelStateKind } from "../ui/sidePanel";
import { svg, VIEWER_IC } from "./viewer/viewerIcons";

/** One layer's viewed state; `opacity` (0..1) present means the row gets a fill bar. */
export interface PanelLayer {
  id: number;
  /** May be empty; the panel then shows `Layer <id>`, matching exports. */
  name: string;
  visible: boolean;
  opacity?: number;
}

export interface LayersPanelOptions {
  id?: string;
  hookPrefix?: string;
  paintThumb: (layer: PanelLayer) => HTMLElement;
  onToggle: (id: number, visible: boolean) => void;
  onOpacity?: (id: number, opacity01: number) => void;
}

export interface LayersPanel {
  el: HTMLElement;
  /** Rebuild the rows (top-first, Z-order). */
  setLayers(layers: PanelLayer[]): void;
  /** Replace the rows with a side-panel state line, so a page turn never shows the previous page's layers. */
  setState(kind: SidePanelStateKind, message: string): void;
}

export function createLayersPanel(opts: LayersPanelOptions): LayersPanel {
  // Hook names match the `.spd` viewer's historical `<prefix>-layer[__part]` classes.
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

  const list = el("ul", { class: cls.list });
  const panel = createSidePanel({
    id: opts.id,
    ariaLabel: "Layers",
    icon: svg(VIEWER_IC.layers, 1.7),
    label: "Layers",
    wide: true,
    hookPrefix: p ? `${p}-layers` : undefined,
  });
  panel.body.append(list);

  /** Hiding a layer disables its opacity bar. */
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

      let disabled = !shown;

      const setValue = (pct: number): void => {
        const next = Math.max(0, Math.min(100, Math.round(pct)));
        if (next === now) return; // at a bound / no movement — silent no-op.
        now = next;
        fill.style.width = `${next}%`;
        pctEl.textContent = `${next}%`;
        bar.setAttribute("aria-valuenow", String(next));
        opts.onOpacity?.(layer.id, next / 100);
      };
      const setFromClientX = (clientX: number): void => {
        const rect = bar.getBoundingClientRect();
        if (rect.width <= 0) return;
        setValue(((clientX - rect.left) / rect.width) * 100);
      };

      // Track document-wide so a drag that leaves the thin bar keeps steering.
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
      // preventDefault so dragging does not also scroll the panel.
      const onTouch = (e: TouchEvent): void => {
        if (disabled) return;
        const t = e.touches[0];
        if (!t) return;
        if (e.cancelable) e.preventDefault();
        setFromClientX(t.clientX);
      };
      bar.addEventListener("touchstart", onTouch, { passive: false });
      bar.addEventListener("touchmove", onTouch, { passive: false });

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
      panel.body.replaceChildren(list);
    },
    setState(kind: SidePanelStateKind, message: string): void {
      // Replace, not append: a <p> is not a valid <ul> child, and dropping rows
      // releases the previous page's thumbnail canvases.
      list.replaceChildren();
      panel.body.replaceChildren(sidePanelState(kind, message));
    },
  };
}
