// The `.spd` viewer's Download menu: the current or the original view as a
// flattened PNG or a layered ORA, and the file itself.

import { el } from "../../ui/dom";
import { download } from "../../export/exporter";
import type { LayeredExportModel } from "../../export/layered";
import { createViewerExportMenu, type ViewerExportMenu, type ViewerRawItem } from "../viewer/viewerExportMenu";
import { exportSpdOra, exportSpdPng, type ExportWhich } from "./spdExport";
import type { LayerView } from "./spdViewer";

export interface SpdExportMenu {
  menu: ViewerExportMenu;
  /** The original file; its link is set per open. */
  raw: ViewerRawItem;
}

/**
 * The layers as an export, bottom first, each with its authored and its
 * current look; null when there is nothing to export.
 */
export function spdExportModel(views: readonly LayerView[], dims: { w: number; h: number } | null): LayeredExportModel | null {
  if (!dims || views.length === 0) return null;
  return {
    width: dims.w,
    height: dims.h,
    layers: [...views].reverse().map((v) => ({
      id: v.layer.id,
      name: v.layer.name,
      canvas: v.canvas,
      authored: { opacity: v.layer.opacity / 255, visible: v.layer.visible },
      current: { opacity: v.current.opacity, visible: v.current.visible },
    })),
  };
}

export function createSpdExportMenu(deps: {
  toast: (message: string) => void;
  /** The sketch's name, or null while none is open. */
  name: () => string | null;
  model: () => LayeredExportModel | null;
}): SpdExportMenu {
  const menu = createViewerExportMenu({ toast: deps.toast, className: "viewer__export" });
  const raw = menu.rawItem("Atelier sketch", ".spd");

  const baseName = (): string => (deps.name() ?? "sketch").replace(/\.spd$/i, "") || "sketch";
  const flatten = (kind: "png" | "ora", which: ExportWhich) => async (): Promise<void> => {
    const model = deps.model();
    if (!model) return;
    const blob = kind === "png" ? await exportSpdPng(model, which) : await exportSpdOra(model, which);
    download(`${baseName()}_${which}.${kind}`, blob);
  };

  menu.pop.append(
    el("div", { class: "menu__head", text: "Current view" }),
    menu.item("Flattened image", ".png", flatten("png", "current")),
    menu.item("Layered image", ".ora", flatten("ora", "current")),
    el("div", { class: "menu__sep" }),
    el("div", { class: "menu__head", text: "Original view" }),
    menu.item("Flattened image", ".png", flatten("png", "original")),
    menu.item("Layered image", ".ora", flatten("ora", "original")),
    el("div", { class: "menu__sep" }),
    el("div", { class: "menu__head", text: "Original file" }),
    raw.el,
  );
  return { menu, raw };
}
