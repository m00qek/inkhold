// `.spd`-named surface over the shared layered-export core (src/export/layered.ts,
// src/export/zip.ts); `spdViewer.ts`'s `exportModel()` feeds it.

export {
  exportFlatPng as exportSpdPng,
  exportOra as exportSpdOra,
  buildStackXml,
  type ExportWhich,
  type CanvasFactory,
} from "../export/layered";
export { crc32, writeStoredZip } from "../export/zip";
