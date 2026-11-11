import { test, expect } from "@playwright/test";
import { mockApi } from "./helpers/mockApi";

test.describe("session restore on load", () => {
  test("a valid /me profile lands on home (not login)", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
    });

    await page.goto("/");

    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
  });

  test("a pending /me profile lands on change-password", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: true } },
    });

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();
  });

  test("a 401 from /me falls back to login", async ({ page }) => {
    await mockApi(page, { "user/me": { status: 401, json: { success: false } } });

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  // `?real` swaps in the HTTP client: the fake `Api` cannot express an expired cookie.
  test("a session that expires while the library is open routes back to login", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
      "controlplane/tree": { status: 401, json: { success: false } },
    });

    await page.goto("/?real");

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page).toHaveURL(/#\/login$/);
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toHaveCount(0);
  });

  test("sign out from home returns to login", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
      "user/logout": { json: { success: true } },
    });

    await page.goto("/");
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();

    // `exact`: "Sign out everywhere" also matches as a substring.
    await page.getByRole("link", { name: "Your account" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("signing out leaves nothing of the person's in the browser's storage, and keeps the device's preferences (#17)", async ({ page }) => {
    await mockApi(page, {
      "user/me": { json: { success: true, email: "ana@household.lan", isAdmin: false, mustChangePassword: false } },
      "user/logout": { json: { success: true } },
    });
    await page.goto("/");
    await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
    // Something in each of the person's databases, their key, and a preference of the device's.
    const names = ["sn-terms", "sn-doctext", "sn-thumbs", "sn-dims", "sn-nocover"];
    await page.evaluate(async (dbs) => {
      for (const name of dbs) {
        await new Promise<void>((resolve, reject) => {
          const open = indexedDB.open(name);
          open.onupgradeneeded = () => open.result.createObjectStore("probe");
          // Left open and giving way when asked, as the app's own stores are.
          open.onsuccess = () => {
            const db = open.result;
            db.onversionchange = () => db.close();
            resolve();
          };
          open.onerror = () => reject(open.error);
        });
      }
      localStorage.setItem("inkhold:text-refused", JSON.stringify(["a-file"]));
      localStorage.setItem("sn.theme", "dark");
    }, names);

    await page.getByRole("link", { name: "Your account" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    // The sign-in page may open a store of its own again: new and empty, never what was there.
    const left = await page.evaluate(async () => {
      const held: string[] = [];
      for (const d of await indexedDB.databases()) {
        if (!d.name?.startsWith("sn-")) continue;
        const db = await new Promise<IDBDatabase>((resolve) => {
          const open = indexedDB.open(d.name!);
          open.onsuccess = () => resolve(open.result);
        });
        if (db.objectStoreNames.contains("probe")) held.push(d.name);
        db.close();
      }
      return { held, refused: localStorage.getItem("inkhold:text-refused"), theme: localStorage.getItem("sn.theme") };
    });
    expect(left.held).toEqual([]);
    expect(left.refused).toBeNull();
    expect(left.theme).toBe("dark");
  });
});
