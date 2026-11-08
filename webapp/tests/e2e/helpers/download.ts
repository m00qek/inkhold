import type { Download } from "@playwright/test";

/**
 * The name a download is saved under, for the name the app asks for. WebKit on
 * Linux (Playwright's) saves "Ideas & scratch.pdf" as "Ideas_&_scratch.pdf";
 * Chromium and Safari keep the spaces. Chromium still checks the exact name.
 */
export function asSaved(download: Download, name: string): string {
  const browser = download.page().context().browser()?.browserType().name();
  return browser === "webkit" ? name.replaceAll(" ", "_") : name;
}
