import { test, expect, type Page } from "@playwright/test";
import { signedIn } from "./helpers/app";

// To-Do against the fake API (`api/fakeTodo.ts`): Inbox "after snapshot" and a
// completed "Haus of gabin"; lists "Français" (Estudar, Ler, Revisar…) and
// "Casa" (an overdue, a today, a completed task).

const SHOTS = process.env.TODO_SHOTS;

async function openTodo(page: Page, path = ""): Promise<void> {
  await signedIn(page);
  await page.goto(`/#/todo${path}`);
  await expect(page.locator(".todo")).toBeVisible();
  await expect(page.locator(".todo-row, .todo-card").first()).toBeVisible();
}

const rail = (page: Page) => page.locator(".rail");
/** A list is reached through the overview's cards; only the Inbox is in the rail. */
async function openList(page: Page, name: string): Promise<void> {
  await rail(page).getByRole("button", { name: /^To-Do/ }).click();
  await page.locator(".todo-card", { hasText: name }).click();
  await expect(page.locator(".todo-place__name")).toHaveText(name);
}
const row = (page: Page, title: string) => page.locator(".todo-row").filter({ hasText: title });

test.describe("To-Do", () => {
  test("lives in the rail: unfolded on its pages, folded elsewhere", async ({ page }) => {
    await openTodo(page);
    // The bare route lands on the lists' cards.
    await expect(page.locator(".todo-place__name")).toHaveText("Lists");
    const nav = rail(page);
    // The tablet's order; the other lists are the overview's cards.
    const names = await nav.locator(".nav__item.is-nested .nav__name").allInnerTexts();
    expect(names.map((n) => n.trim())).toEqual(["Inbox", "Planned", "All", "Completed"]);
    await expect(nav.getByRole("button", { name: /^Planned/ })).toBeVisible();
    await nav.getByRole("button", { name: /^Planned/ }).click();
    await expect(page).toHaveURL(/#\/todo\/planned$/);
    await expect(page.locator(".todo-group__head", { hasText: "Overdue" })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/planned.png` });

    // The chevron folds the views away while staying on To-Do.
    await nav.getByRole("button", { name: "Fold To-Do" }).click();
    await expect(nav.getByRole("button", { name: /^Planned/ })).toHaveCount(0);
    await nav.getByRole("button", { name: "Unfold To-Do" }).click();

    // Leaving To-Do folds it.
    await nav.getByRole("button", { name: /^Note/ }).click();
    await expect(page.locator(".todo")).toBeHidden();
    await expect(nav.getByRole("button", { name: /^Planned/ })).toHaveCount(0);
    await expect(nav.getByRole("button", { name: /^To-Do/ })).toBeVisible();
  });

  test("the overview: a card per list, Inbox first, each opening its list", async ({ page }) => {
    await openTodo(page);
    const cards = page.locator(".todo-card");
    await expect(cards.locator(".todo-card__name")).toHaveText(["Inbox", "Français", "Casa"]);
    await expect(cards.nth(2)).toContainText("1 overdue");
    await expect(cards.nth(1).locator(".todo-card__peek li").first()).toHaveText("Estudar");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/overview.png` });
    await cards.nth(1).click();
    await expect(page).toHaveURL(/#\/todo\/list\//);
    await expect(page.locator(".todo-place__name")).toHaveText("Français");
  });

  test("every card has a ⋯: Rename and Delete on one's own lists, the Inbox's disabled", async ({ page }) => {
    await openTodo(page);
    await expect(page.getByRole("button", { name: "Inbox can't be renamed or deleted" })).toBeDisabled();
    await page.getByRole("button", { name: "Actions for Casa" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Rename list", "Delete list"]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/card-menu.png` });
  });

  test("adds a task to a list; the topbar says the tablet is waiting for it", async ({ page }) => {
    await openTodo(page);
    await openList(page, "Français");
    // A draft belongs to its view: type only once the list is on screen.
    await expect(page.locator(".todo-place__name")).toHaveText("Français");
    await page.getByLabel("New task").fill("Fazer os exercícios");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const added = row(page, "Fazer os exercícios");
    await expect(added).toBeVisible();
    await expect(page.locator(".todo-sync")).toHaveText("Waiting for the tablet");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/list.png` });
  });

  test("completing a task moves it to the list's completed section", async ({ page }) => {
    await openTodo(page, "/inbox");
    await page.getByRole("button", { name: "Mark as done: after snapshot" }).click();
    await expect(page.locator(".todo-group__head", { hasText: "Completed" })).toContainText("2");
    await expect(page.locator(".todo-empty")).toContainText("Nothing in the Inbox");
  });

  test("every task has a ⋯: rename, date, move, delete with undo", async ({ page }) => {
    await openTodo(page, "/inbox");
    const more = (title: string) => page.getByRole("button", { name: `Actions for ${title}` });

    await more("after snapshot").click();
    await expect(page.getByRole("menuitem")).toHaveText(["Rename", "Move to…", "Add a date…", "Delete"]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/row-menu.png` });
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.getByLabel("Task name").fill("after the snapshot");
    await page.keyboard.press("Enter");
    await expect(row(page, "after the snapshot")).toBeVisible();

    await more("after the snapshot").click();
    await page.getByRole("menuitem", { name: "Add a date…" }).click();
    await page.getByRole("menuitem", { name: "Tomorrow" }).click();
    await expect(row(page, "after the snapshot")).toContainText("Tomorrow");

    await more("after the snapshot").click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    // Back returns to the ⋯ menu; then on to Move to… again.
    await page.getByRole("menuitem", { name: "Back" }).click();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    await page.getByRole("menuitem", { name: "Casa" }).click();
    await expect(row(page, "after the snapshot")).toHaveCount(0);
    await openList(page, "Casa");

    await more("after the snapshot").click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(row(page, "after the snapshot")).toHaveCount(0);
    await expect(page.locator(".bin-toast.is-shown")).toContainText('Deleted "after the snapshot"');
    await page.locator(".todo-undo").getByRole("button", { name: "Undo" }).click();
    await expect(row(page, "after the snapshot")).toBeVisible();
  });

  test("a task is dragged by its grip to a new place in its list", async ({ page }) => {
    await openTodo(page, "/list/" + "1".padStart(32, "0"));
    const titles = page.locator(".todo-row .todo-title");
    await expect(titles).toHaveText(["Estudar", "Ler", "Revisar o passé composé"]);
    const grip = row(page, "Revisar o passé composé").locator(".todo-grip");
    await row(page, "Revisar o passé composé").hover();
    const from = (await grip.boundingBox())!;
    const to = (await row(page, "Estudar").boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 12 });
    await page.mouse.up();
    await expect(titles).toHaveText(["Revisar o passé composé", "Estudar", "Ler"]);
    // Planned has no order of its own: no grips.
    await page.goto("/#/todo/planned");
    await expect(page.locator(".todo-row").first()).toBeVisible();
    await expect(page.locator(".todo-grip")).toHaveCount(0);
  });

  test("in All a task is dragged into another list's group, at the place it is dropped", async ({ page }) => {
    await openTodo(page, "/all");
    const r = row(page, "after snapshot");
    await r.hover();
    const g = (await r.locator(".todo-grip").boundingBox())!;
    const ler = (await row(page, "Ler").boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, ler.y + 6, { steps: 15 });
    await page.mouse.up();
    const fr = page.locator(".todo-group", { has: page.locator(".todo-group__head", { hasText: "Français" }) });
    await expect(fr.locator(".todo-title")).toHaveText(["Estudar", "after snapshot", "Ler", "Revisar o passé composé"]);
    await expect(page.locator(".todo-group__head", { hasText: "Inbox" })).toHaveCount(0);
  });

  test("clicking a selected task keeps it selected; Escape lets go; Enter selects from Tab", async ({ page }) => {
    await openTodo(page, "/inbox");
    await row(page, "after snapshot").click();
    await row(page, "after snapshot").click();
    await expect(row(page, "after snapshot")).toHaveClass(/is-selected/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".todo-row.is-selected")).toHaveCount(0);
    await row(page, "after snapshot").focus();
    await page.keyboard.press("Enter");
    await expect(row(page, "after snapshot")).toHaveClass(/is-selected/);
    // Backspace is not delete: only the Delete key is.
    await page.keyboard.press("Backspace");
    await expect(row(page, "after snapshot")).toBeVisible();
  });

  test("Planned: no reorder, no repeated Overdue, and the note chip opens its page", async ({ page }) => {
    await openTodo(page, "/planned");
    const overdue = page.locator(".todo-group", { has: page.locator(".todo-group__head", { hasText: "Overdue" }) });
    await expect(overdue.locator(".todo-meta")).not.toContainText("Overdue");
    await page.getByRole("button", { name: /^Actions for / }).first().click();
    await expect(page.getByRole("menuitem", { name: /^Move (up|down)$/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await openTodo(page, "/list/" + "1".padStart(32, "0"));
    const chip = row(page, "Revisar o passé composé").getByRole("button", { name: /^Open .+, page 2$/ });
    await expect(row(page, "Revisar o passé composé")).not.toContainText("From");
    await chip.click();
    await expect(page).toHaveURL(/#\/note\/101\/page\/2$/);
    // The note takes To-Do's place, and Back says where it returns to.
    await expect(page.locator(".todo")).toBeHidden();
    await expect(page.locator(".reader")).toBeVisible();
    const back = page.locator(".backbtn");
    await expect(back).toContainText("To-Do");
    await back.click();
    await expect(page.locator(".todo-place__name")).toHaveText("Français");
    await expect(row(page, "Revisar o passé composé")).toHaveClass(/is-selected/);
  });

  test("the list's options live in the topbar: rename the list", async ({ page }) => {
    await openTodo(page, "/list/" + "1".padStart(32, "0"));
    // A list of one's own: its menu, no New list (that is the overview's).
    await expect(page.locator("#todo-new-list")).toBeHidden();
    await page.locator("#todo-list-options").click();
    await page.getByRole("menuitem", { name: "Rename list" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Francês");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.locator(".todo-place__name")).toHaveText("Francês");
    await expect(rail(page).getByRole("button", { name: /^Francês/ })).toHaveCount(0);

    // Off To-Do, the topbar is the library's again.
    await rail(page).getByRole("button", { name: /^Note/ }).click();
    await expect(page.locator("#todo-new-list")).toBeHidden();
    await expect(page.locator("#todo-list-options")).toBeHidden();
  });

  test("each page's topbar: search and New list on the overview only, the menu on a list", async ({ page }) => {
    await openTodo(page);
    const search = page.getByRole("searchbox", { name: "Search notes and to-dos" });
    await expect(search).toBeVisible();
    await expect(page.locator("#todo-new-list")).toBeVisible();
    await expect(page.locator("#todo-list-options")).toBeHidden();
    // The sync status only shows while a change waits for the tablet.
    await expect(page.locator(".todo-sync")).toBeHidden();
    for (const name of ["Inbox", "Planned"]) {
      await rail(page).locator(".nav__item.is-nested", { hasText: name }).click();
      await expect(page.locator(".todo-place__name")).toHaveText(name);
      await expect(search).toBeHidden();
      await expect(page.locator("#todo-new-list")).toBeHidden();
      await expect(page.locator("#todo-list-options")).toBeHidden();
    }
  });

  test("search finds to-dos, done ones after, and opens a done one in its list", async ({ page }) => {
    await openTodo(page);
    await page.getByRole("searchbox", { name: "Search notes and to-dos" }).fill("weekly review");
    const hits = page.locator(".todo-hits .todo-hit");
    // Matched through the notebook they came from; the open one first.
    await expect(hits.locator(".todo-hit__title")).toHaveText(["Revisar o passé composé", "Haus of gabin"]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/search.png` });
    await hits.nth(1).click();
    await expect(page.locator(".todo-place__name")).toHaveText("Inbox");
    await expect(row(page, "Haus of gabin")).toHaveClass(/is-selected/);
  });

  test("Download: this list on a list's page, all lists in All, none elsewhere", async ({ page }) => {
    await openTodo(page, "/list/" + "1".padStart(32, "0"));
    const btn = page.locator("#todo-download");
    await btn.click();
    await expect(page.locator(".todo-pop .menu__section")).toHaveText(["This list"]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/download.png` });
    const saving = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: /^Tasks/ }).click();
    const file = await saving;
    expect(file.suggestedFilename()).toBe("Français.ics");
    const text = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8"));
    expect(text.match(/BEGIN:VTODO/g)).toHaveLength(3);

    await page.goto("/#/todo/all");
    await btn.click();
    await expect(page.locator(".todo-pop .menu__section")).toHaveText(["All lists"]);
    const saving2 = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: /^Plain text/ }).click();
    expect((await saving2).suggestedFilename()).toBe("To-Do.txt");

    for (const where of ["", "/planned", "/completed"]) {
      await page.goto(`/#/todo${where}`);
      await expect(page.locator(".todo-place__name")).toBeVisible();
      await expect(btn).toBeHidden();
    }
  });

  test("a lassoed task shows its handwriting in a chip; no recognized words, the page number", async ({ page }) => {
    await openTodo(page, "/list/" + "1".padStart(32, "0"));
    const revisar = row(page, "Revisar o passé composé");
    await expect(revisar.locator(".todo-chip .todo-ink")).toBeVisible();
    await expect(row(page, "Estudar").locator(".todo-chip")).toHaveCount(0);
    // "Haus of gabin" was lassoed on page 3, which has no recognized text in the
    // fixture: its chip keeps the page number, and still opens the note.
    await openTodo(page, "/completed");
    const haus = row(page, "Haus of gabin");
    await expect(haus).toBeVisible();
    const chip = haus.getByRole("button", { name: /^Open .*, page 3$/ });
    await expect(chip).toHaveText("3");
    await page.waitForTimeout(500);
    await expect(haus.locator(".todo-ink")).toHaveCount(0);
  });

  test("New list asks for a name and opens the list", async ({ page }) => {
    await openTodo(page);
    await page.getByRole("button", { name: "New list" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Trabalho");
    await page.getByRole("button", { name: "Create list" }).click();
    await expect(page.locator(".todo-place__name")).toHaveText("Trabalho");
    await expect(page.locator(".todo-empty")).toContainText("This list is empty");
    await rail(page).getByRole("button", { name: /^To-Do/ }).click();
    await expect(page.locator(".todo-card", { hasText: "Trabalho" })).toBeVisible();
  });

  test("the keyboard: N adds, arrows select, X completes", async ({ page }) => {
    await openTodo(page, "/list/" + "1".padStart(32, "0"));
    await page.locator("body").press("ArrowDown");
    await expect(page.locator(".todo-row.is-selected")).toHaveCount(1);
    const title = await page.locator(".todo-row.is-selected .todo-title").innerText();
    await page.locator("body").press("x");
    // Done tasks wait in the folded Completed section.
    await page.locator(".todo-group__head", { hasText: "Completed" }).click();
    await expect(row(page, title.trim())).toHaveClass(/is-done/);
    await page.locator("body").press("n");
    await expect(page.getByLabel("New task")).toBeFocused();
  });
});
