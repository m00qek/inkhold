import { test, expect, type Page } from "@playwright/test";
import { signedIn } from "./helpers/app";

// Previews come back from the device's store on a later visit (IndexedDB).
// Installed on an iPhone they turned into broken images: WebKit handed back
// stored Blobs it could not read. Every preview must still draw after reloads.

async function previewsDrawn(page: Page): Promise<void> {
  const imgs = page.locator("#gallery .card img.thumb__img");
  await expect(imgs.first()).toBeVisible();
  await expect
    .poll(() =>
      imgs.evaluateAll((all) =>
        all
          .filter((i) => (i as HTMLImageElement).getBoundingClientRect().top < innerHeight)
          .every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0),
      ),
    )
    .toBe(true);
}

test("previews still draw when they come back from the device's store", async ({ page }) => {
  await signedIn(page);
  await page.goto("/#/folder/note");
  await previewsDrawn(page);
  for (let i = 0; i < 2; i++) {
    await page.reload();
    await previewsDrawn(page);
  }
});

test("a stored preview that can't be shown becomes a picture again, never a broken image", async ({ page }) => {
  await signedIn(page);
  await page.goto("/#/folder/note");
  await previewsDrawn(page);
  // Saving runs behind the paint (and slower in WebKit): wait until it has.
  const stored = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const open = indexedDB.open("sn-thumbs");
          open.onerror = () => resolve(0);
          open.onsuccess = () => {
            const req = open.result.transaction("thumbs", "readonly").objectStore("thumbs").count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(0);
          };
        }),
    );
  await expect.poll(stored, { timeout: 15_000 }).toBeGreaterThan(0);
  // Spoil every stored picture, as bytes (WebKit's private mode, which the
  // tests run in, refuses a Blob; reading the older Blob shape is unit-tested).
  const spoiled = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open("sn-thumbs");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("thumbs", "readwrite");
          const store = tx.objectStore("thumbs");
          let n = 0;
          store.openCursor().onsuccess = (e) => {
            const cur = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cur) return;
            const garbage = new Uint8Array([1, 2, 3, 4]);
            const { image: _drop, ...rest } = cur.value as Record<string, unknown>;
            cur.update({ ...rest, bytes: garbage.buffer, type: "image/webp" });
            n++;
            cur.continue();
          };
          tx.oncomplete = () => resolve(n);
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  expect(spoiled).toBeGreaterThan(0);
  await page.reload();
  await previewsDrawn(page);
});
