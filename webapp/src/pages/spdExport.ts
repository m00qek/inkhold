// The `.spd` EXPORT — now an ADAPTER over the shared layered-export core
// (src/export/layered.ts + src/export/zip.ts), where the flatten, the ORA
// `stack.xml` builder and the STORE-only zip writer moved so the `.note` reader
// can export the same matrix (docs/scratch/archive/note-layers-panel.md §Exports).
//
// What is `.spd` about this file is the MODEL FEEDING, and that lives in the
// viewer: `spdViewer.ts`'s `exportModel()` snapshots the per-layer canvas stack
// into a {@link LayeredExportModel} — wire opacity 0..255 normalised to 0..1,
// `authored` from the file, `current` from the live panel tuning — and hands it
// straight to the core. Nothing needed re-shaping, so the adapter is the
// `.spd`-named surface (the names the viewer and the unit tests bind) over the
// neutral functions; the behaviour is pinned byte-for-byte by
// `tests/unit/spdExport.test.ts` across the extraction.

export {
  exportFlatPng as exportSpdPng,
  exportOra as exportSpdOra,
  buildStackXml,
  type ExportWhich,
  type CanvasFactory,
} from "../export/layered";
export { crc32, writeStoredZip } from "../export/zip";
