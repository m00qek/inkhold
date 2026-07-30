import { test, expect, type Page } from "@playwright/test";
import { signedIn, cardButton, railSettled } from "./helpers/app";
import { mockApi } from "./helpers/mockApi";
import { recordText } from "./helpers/recordText";

// Uploading a file from the web (docs/scratch/upload.md): the drop target over
// the gallery, the toolbar's Upload button, the per-file progress rows, and the
// two refusals that must happen BEFORE any bytes move. These drive it end to end
// against the in-memory fake `Api`, which mutates the fixture tree, reports
// progress in steps scaled by file size, and answers the real 415/413 refusals.
//
// WHAT EACH TEST PINS (so a future refactorer can tell whether it still bites):
//   drop            → the drop path reaches the seam, the row is spliced in, the
//                     toast names the device payoff.
//   picker          → the toolbar button is the same code path.
//   progress        → the row is really painted as `sending` with a percentage
//                     while bytes move — RECORDED, not sampled, because a fast
//                     link makes that window a flash.
//   off-list type   → refused with NO transfer: the queue never showed "Sending".
//   over quota      → same, from the shell's own usage figures.
//   MyStyle         → the template copy, on both the dropzone and the toast.
//   cancel          → the transfer stops; nothing is added, nothing claims it was.
//
// FIXTURE FACTS. `#/folder/note` holds `Projects`, `Weekly review`, `Ideas &
// scratch`, `Sketch — kitchen layout` and `Layered field sketch`; `#/folder/
// mystyle` is the device's TEMPLATE folder (`NOTE/MyStyle`), holding three
// templates. Nothing here adds a fixture file, so no other spec's counts move.

/** The fake's per-step latency is 120 ms and a file is sent in ⌈size/64 KB⌉ steps
 *  (4–24), so this is roughly a 2.9 s transfer — a window wide enough to click
 *  Cancel in, deterministically, rather than a race against a fast link. */
const SLOW_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Drop `name` onto `selector`, as a real drag: `dragenter` → `dragover` → `drop`,
 * carrying a genuine `File` of `size` bytes.
 *
 * Built with a live `DataTransfer` rather than Playwright's file-chooser plumbing
 * because THE DROP IS THE FEATURE — the picker is the fallback — and the two enter
 * the app through different browser events.
 */
async function dropFiles(page: Page, selector: string, files: { name: string; size?: number }[]): Promise<void> {
  await page.evaluate(
    ({ selector, files }) => {
      const target = document.querySelector(selector);
      if (!target) throw new Error(`no drop target: ${selector}`);
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([new Uint8Array(f.size ?? 2048)], f.name));
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    },
    { selector, files },
  );
}

/** Hold a file OVER the target without dropping it — what the dropzone copy is for. */
async function hoverFiles(page: Page, selector: string, name: string): Promise<void> {
  await page.evaluate(
    ({ selector, name }) => {
      const target = document.querySelector(selector)!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(16)], name));
      for (const type of ["dragenter", "dragover"]) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    },
    { selector, name },
  );
}

/** Signed in, with the rail's storage meter answering real numbers — which is
 *  also what the client-side over-quota pre-flight charges against. */
async function signedInWithQuota(page: Page, usedBytes: number, totalBytes: number): Promise<void> {
  await mockApi(page, {
    "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
    "controlplane/usage": { json: { success: true, used_bytes: usedBytes, total_bytes: totalBytes } },
  });
}

test.describe("upload", () => {
  test("a PDF dropped on the gallery lands in the folder, with the device promise", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);
    await expect(cardButton(page, "Ideas & scratch")).toBeVisible();

    await dropFiles(page, "#gallery", [{ name: "Field guide.pdf" }]);

    await expect(page.locator(".toast")).toContainText(
      "Uploaded 'Field guide.pdf'. It'll be on your Nomad after the next sync.",
    );
    await expect(cardButton(page, "Field guide.pdf")).toBeVisible();
  });

  test("the toolbar's Upload button is the same path", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: "Upload a file to this folder" }).click(),
    ]);
    await chooser.setFiles([{ name: "Manual.epub", mimeType: "application/epub+zip", buffer: Buffer.alloc(4096) }]);

    await expect(cardButton(page, "Manual.epub")).toBeVisible();
    await expect(page.locator(".toast")).toContainText("Uploaded 'Manual.epub'.");
  });

  test("progress is PAINTED while the bytes are moving", async ({ page }) => {
    // RECORDED, NOT SAMPLED. `sending` is a window that closes on its own, and a
    // retrying `expect(locator)` is built to wait for the settled state — it
    // would happily poll until the upload finished and then report the good
    // state. The recorder reads the mutation records, so a row replaced a moment
    // later still reports the text it showed.
    const transfers = await recordText(page, ".transfers");
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);

    await dropFiles(page, "#gallery", [{ name: "Scan.pdf", size: SLOW_UPLOAD_BYTES }]);
    await expect(cardButton(page, "Scan.pdf")).toBeVisible({ timeout: 15_000 });

    expect(await transfers.everShowed("Sending")).toBe(true);
    // A percentage, not just the word: the bar has to be reporting a real
    // fraction of the bytes sent, which is the whole reason this call is an
    // XMLHttpRequest rather than a fetch.
    expect((await transfers.history()).some((t) => /Sending \d+%/.test(t))).toBe(true);
    expect(await transfers.everShowed("Uploaded")).toBe(true);
  });

  test("an off-list type is refused BEFORE anything is transferred", async ({ page }) => {
    const transfers = await recordText(page, ".transfers");
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);

    await dropFiles(page, "#gallery", [{ name: "recording.xyz" }]);

    await expect(page.locator(".toast")).toContainText("The Nomad can't open .xyz");
    await expect(page.locator(".transfer.is-failed")).toBeVisible();
    // THE TEETH: not "it failed", but "it was never sent". A refusal that
    // happened after the transfer would have shown `Sending` on its way past.
    expect(await transfers.everShowed("Sending")).toBe(false);
    await expect(cardButton(page, "recording.xyz")).toHaveCount(0);
  });

  test("an over-quota file is refused BEFORE anything is transferred", async ({ page }) => {
    // 512 KB of room left; the file is 1 MB.
    await signedInWithQuota(page, 9_500_000, 10_000_000);
    const transfers = await recordText(page, ".transfers");
    await page.goto("/#/folder/note");
    await railSettled(page);
    // The meter has to have answered before the pre-flight can charge against it.
    await expect(page.locator(".quota")).toBeVisible();

    await dropFiles(page, "#gallery", [{ name: "Big scan.pdf", size: 1024 * 1024 }]);

    await expect(page.locator(".toast")).toContainText("There isn't room for 'Big scan.pdf'");
    expect(await transfers.everShowed("Sending")).toBe(false);
    await expect(cardButton(page, "Big scan.pdf")).toHaveCount(0);
  });

  test("MyStyle: the dropzone offers a TEMPLATE, and so does the toast", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/mystyle");
    await railSettled(page);
    await expect(cardButton(page, "Cornell notes")).toBeVisible();

    // Holding a file over the gallery names what dropping it here would MEAN.
    await hoverFiles(page, "#gallery", "Ruled 7mm.png");
    await expect(page.locator(".dropzone__title")).toHaveText("Drop an image or PDF to add a template");

    await dropFiles(page, "#gallery", [{ name: "Ruled 7mm.png" }]);
    await expect(page.locator(".toast")).toContainText(
      "Added 'Ruled 7mm.png' as a template. Pick it on your Nomad after the next sync.",
    );
    await expect(cardButton(page, "Ruled 7mm.png")).toBeVisible();
  });

  test("the generic copy stands OUTSIDE the template folder", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);

    await hoverFiles(page, "#gallery", "Ruled 7mm.png");
    await expect(page.locator(".dropzone__title")).toHaveText("Drop files to add them here");
  });

  test("cancel stops the transfer, and nothing claims it arrived", async ({ page }) => {
    const toasts = await recordText(page, ".toast");
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);

    await dropFiles(page, "#gallery", [{ name: "Huge.pdf", size: SLOW_UPLOAD_BYTES }]);
    const cancel = page.getByRole("button", { name: "Cancel upload of Huge.pdf" });
    await expect(cancel).toBeVisible();
    await cancel.click();

    await expect(page.locator(".transfer.is-cancelled")).toBeVisible();
    expect(await toasts.everShowed("Uploaded 'Huge.pdf'")).toBe(false);

    // THE TEETH, and the reason this is not simply `toHaveCount(0)` on the card:
    // a cancel that only RELABELLED the row would leave the transfer running to
    // completion, and the file would exist on the server while this screen said
    // "Cancelled". So wait past when the untouched upload would have finished,
    // then leave the folder and come back — a real `listFolder` — and check the
    // server never got it. (A reload would prove nothing: it re-mints the fake's
    // fixture, so the file would be gone either way.)
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      location.hash = "#/folder/document";
    });
    await expect(cardButton(page, "Apartment lease — signed")).toBeVisible();
    await page.evaluate(() => {
      location.hash = "#/folder/note";
    });
    await expect(cardButton(page, "Ideas & scratch")).toBeVisible();
    await page.waitForTimeout(1000); // let the revalidating listing land
    await expect(cardButton(page, "Huge.pdf")).toHaveCount(0);
  });

  // --- the name conflict ----------------------------------------------------
  //
  // A clash is a QUESTION, not a silent " (2)". The main use of web upload is
  // updating a file you edited on your laptop, and quietly keeping both gets that
  // wrong twice over — two files, both syncing to a device where clutter costs.
  //
  // THE CLASH IS MADE BY UPLOADING TWICE, which is not a workaround — it is
  // precisely the case the whole change is about: you drop a PDF, edit it on your
  // laptop, and drop it again to UPDATE the copy in your library. (It is also the
  // only way to get a clash from this fixture, whose seeded files carry no
  // extension in their names; an uploaded file keeps its real filename.)
  const CLASHING = "Trip notes.pdf";

  /** Upload `name` once, and wait until it is really in the listing. */
  async function seedFile(page: Page, name: string): Promise<void> {
    await dropFiles(page, "#gallery", [{ name }]);
    await expect(cardButton(page, name)).toBeVisible();
  }

  test("a clashing name ASKS rather than silently renaming", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);
    await expect(cardButton(page, "Ideas & scratch")).toBeVisible();
    await seedFile(page, CLASHING);

    await dropFiles(page, "#gallery", [{ name: CLASHING }]);

    // THE BEHAVIOUR CHANGE, pinned: the prompt, before anything is sent.
    await expect(page.locator("dialog.conflict")).toBeVisible();
    await expect(page.locator(".conflict__title")).toHaveText("'Trip notes.pdf' is already here");
    // Both facts the choice turns on: what Keep both produces, and that Replace
    // is reversible.
    await expect(page.locator(".conflict__body")).toContainText("Trip notes (2).pdf");
    await expect(page.locator(".conflict__body")).toContainText("a version you can restore");
  });

  test("Keep both creates the suffixed file and leaves the original", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);
    await expect(cardButton(page, "Ideas & scratch")).toBeVisible();
    await seedFile(page, CLASHING);

    await dropFiles(page, "#gallery", [{ name: CLASHING }]);
    await page.locator("dialog.conflict").getByRole("button", { name: "Keep both" }).click();

    await expect(cardButton(page, "Trip notes (2).pdf")).toBeVisible();
    // The original is untouched — that is the whole meaning of "keep both".
    await expect(cardButton(page, CLASHING)).toBeVisible();
    await expect(page.locator(".toast")).toContainText("Uploaded 'Trip notes (2).pdf'");
  });

  test("Replace leaves ONE row and names the version it kept", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);
    await expect(cardButton(page, "Ideas & scratch")).toBeVisible();
    await seedFile(page, CLASHING);
    const before = await page.locator(".card").count();

    await dropFiles(page, "#gallery", [{ name: CLASHING }]);
    await page.locator("dialog.conflict").getByRole("button", { name: "Replace" }).click();

    await expect(page.locator(".toast")).toContainText(
      "Replaced 'Trip notes.pdf'. The previous file is in its version history.",
    );
    // NOTHING WAS ADDED: a replace supersedes in place, so the file kept its id
    // and the folder is exactly as long as it was.
    await expect(cardButton(page, "Trip notes (2).pdf")).toHaveCount(0);
    await expect(cardButton(page, CLASHING)).toBeVisible();
    await expect(page.locator(".card")).toHaveCount(before);
  });

  test("Cancel transfers nothing at all", async ({ page }) => {
    // NO REQUEST TO COUNT, and that is a fact about this suite rather than a
    // dodge: the library runs against the in-memory fake `Api`, so an upload is
    // never an HTTP request that `page.route` could tally. What CAN be observed
    // is stronger than a DOM check — whether the seam was reached at all — and
    // the folder's own listing is where that shows: leave, come back (a real
    // `listFolder`) and see whether the tree grew. The recorder covers the
    // in-between window that a settled assertion cannot see.
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);
    await expect(cardButton(page, "Ideas & scratch")).toBeVisible();
    await seedFile(page, CLASHING);
    // Recording starts AFTER the seeding upload, so the "never sent" assertion is
    // about the cancelled drop alone.
    const sending = await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __sent: string[] }).__sent = seen;
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of Array.from(r.addedNodes)) if (n.textContent) seen.push(n.textContent);
          if (r.type === "characterData" && r.target.textContent) seen.push(r.target.textContent);
        }
      }).observe(document.querySelector(".transfers")!, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      return true;
    });
    expect(sending).toBe(true);

    await dropFiles(page, "#gallery", [{ name: CLASHING }]);
    await page.locator("dialog.conflict").getByRole("button", { name: "Cancel" }).click();

    await expect(page.locator("dialog.conflict")).toBeHidden();
    await expect(page.locator(".transfer.is-cancelled")).toBeVisible();
    // It never started: nothing painted into the queue ever said it was sending.
    const seen = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
    expect(seen.some((t) => t.includes("Sending"))).toBe(false);

    // And the tree never got it, on a real listing rather than a repaint.
    await page.evaluate(() => {
      location.hash = "#/folder/document";
    });
    await expect(cardButton(page, "Apartment lease — signed")).toBeVisible();
    await page.evaluate(() => {
      location.hash = "#/folder/note";
    });
    await expect(cardButton(page, "Ideas & scratch")).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(cardButton(page, "Trip notes (2).pdf")).toHaveCount(0);
    await expect(cardButton(page, CLASHING)).toHaveCount(1);
  });

  test("a NON-conflicting drop is never interrupted", async ({ page }) => {
    // The prompt must be the exception. A dialog on an ordinary drop would make
    // the hero interaction cost two clicks.
    const dialogs = await recordText(page, "dialog.conflict");
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);

    await dropFiles(page, "#gallery", [{ name: "Something new.pdf" }]);
    await expect(cardButton(page, "Something new.pdf")).toBeVisible();
    // RECORDED: a dialog that appeared and was dismissed would leave no trace for
    // a `toHaveCount(0)` taken afterwards.
    expect(await dialogs.history()).toEqual([]);
  });

  test("one answer covers a whole batch of conflicts", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);
    await expect(cardButton(page, "Ideas & scratch")).toBeVisible();
    await seedFile(page, "Alpha.pdf");
    await seedFile(page, "Beta.pdf");

    await dropFiles(page, "#gallery", [{ name: "Alpha.pdf" }, { name: "Beta.pdf" }]);

    // ONE dialog for two clashes, and it says how many the box would cover — ten
    // dropped files must not become ten dialogs.
    await expect(page.locator("dialog.conflict")).toHaveCount(1);
    await expect(page.locator(".conflict__rest")).toContainText("Do the same for the other file");
    await page.locator(".conflict__rest-box").check();
    await page.locator("dialog.conflict").getByRole("button", { name: "Keep both" }).click();

    // No second dialog — both files went through on the one answer.
    await expect(cardButton(page, "Alpha (2).pdf")).toBeVisible();
    await expect(cardButton(page, "Beta (2).pdf")).toBeVisible();
    await expect(page.locator("dialog.conflict")).toHaveCount(0);
  });

  test("no Upload control where there is nothing to upload into", async ({ page }) => {
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);
    const upload = page.getByRole("button", { name: "Upload a file to this folder" });
    await expect(upload).toBeVisible();

    // Search results are library-wide — they are not a folder, so there is no
    // "here" for a file to land in.
    await page.locator("#search").fill("sketch");
    await expect(upload).toBeHidden();
  });
});
