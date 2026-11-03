import { test, expect, type Page } from "@playwright/test";
import { signedIn, cardButton, railSettled } from "./helpers/app";
import { mockApi } from "./helpers/mockApi";
import { recordText } from "./helpers/recordText";

/** ~2.9 s transfer under the fake's 120 ms per 64 KB step, wide enough to click Cancel. */
const SLOW_UPLOAD_BYTES = 2 * 1024 * 1024;

/** A live `DataTransfer`: drop and the picker enter the app through different events. */
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
    // Recorded: a retrying matcher would wait out the `sending` window.
    const transfers = await recordText(page, ".transfers");
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);

    await dropFiles(page, "#gallery", [{ name: "Scan.pdf", size: SLOW_UPLOAD_BYTES }]);
    await expect(cardButton(page, "Scan.pdf")).toBeVisible({ timeout: 15_000 });

    expect(await transfers.everShowed("Sending")).toBe(true);
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
    // A refusal after the transfer would have shown `Sending` on its way past.
    expect(await transfers.everShowed("Sending")).toBe(false);
    await expect(cardButton(page, "recording.xyz")).toHaveCount(0);
  });

  test("an over-quota file is refused BEFORE anything is transferred", async ({ page }) => {
    await signedInWithQuota(page, 9_500_000, 10_000_000);
    const transfers = await recordText(page, ".transfers");
    await page.goto("/#/folder/note");
    await railSettled(page);
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

    // A cancel that only relabelled the row would still land the file. Re-list rather than
    // reload, which re-mints the fake's fixture.
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

  // --- the name conflict ---
  // A clash is made by uploading twice; seeded fixture files carry no extension.
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

    await expect(page.locator("dialog.conflict")).toBeVisible();
    await expect(page.locator(".conflict__title")).toHaveText("'Trip notes.pdf' is already here");
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
    await expect(cardButton(page, "Trip notes (2).pdf")).toHaveCount(0);
    await expect(cardButton(page, CLASHING)).toBeVisible();
    await expect(page.locator(".card")).toHaveCount(before);
  });

  test("Cancel transfers nothing at all", async ({ page }) => {
    // The fake `Api` makes no HTTP requests, so the tree is checked via a real `listFolder`.
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);
    await expect(cardButton(page, "Ideas & scratch")).toBeVisible();
    await seedFile(page, CLASHING);
    // Recording starts after the seeding upload.
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
    const seen = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
    expect(seen.some((t) => t.includes("Sending"))).toBe(false);

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
    const dialogs = await recordText(page, "dialog.conflict");
    await signedIn(page);
    await page.goto("/#/folder/note");
    await railSettled(page);

    await dropFiles(page, "#gallery", [{ name: "Something new.pdf" }]);
    await expect(cardButton(page, "Something new.pdf")).toBeVisible();
    // Recorded: a dialog that appeared and was dismissed leaves no trace afterwards.
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

    await expect(page.locator("dialog.conflict")).toHaveCount(1);
    await expect(page.locator(".conflict__rest")).toContainText("Do the same for the other file");
    await page.locator(".conflict__rest-box").check();
    await page.locator("dialog.conflict").getByRole("button", { name: "Keep both" }).click();

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

    await page.locator("#search").fill("sketch");
    await expect(upload).toBeHidden();
  });
});
