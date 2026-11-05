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
  await expect(page.locator(".todo-row").first()).toBeVisible();
}

const rail = (page: Page) => page.locator(".rail");
const row = (page: Page, title: string) => page.locator(".todo-row").filter({ hasText: title });

test.describe("To-Do", () => {
  test("lives in the rail: unfolded on its pages, folded elsewhere", async ({ page }) => {
    await openTodo(page);
    // The bare route lands on the overview.
    await expect(page.locator(".crumbs__here")).toHaveText("All");
    const nav = rail(page);
    // Views first, then the lists under their own label, Inbox at their head.
    const names = await nav.locator(".nav__item.is-nested .nav__name, .nav__label.is-nested").allInnerTexts();
    expect(names.map((n) => n.trim().toLowerCase())).toEqual(["all", "planned", "completed", "lists", "inbox", "français", "casa"]);
    await expect(nav.getByRole("button", { name: /^Planned/ })).toBeVisible();
    await expect(nav.getByRole("button", { name: /^Français/ })).toBeVisible();
    await nav.getByRole("button", { name: /^Planned/ }).click();
    await expect(page).toHaveURL(/#\/todo\/planned$/);
    await expect(page.locator(".todo-group__head", { hasText: "Overdue" })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/planned.png` });

    // The chevron folds the views away while staying on To-Do.
    await nav.getByRole("button", { name: "Fold the To-Do lists" }).click();
    await expect(nav.getByRole("button", { name: /^Planned/ })).toHaveCount(0);
    await nav.getByRole("button", { name: "Unfold the To-Do lists" }).click();

    // Leaving To-Do folds it.
    await nav.getByRole("button", { name: /^Note/ }).click();
    await expect(page.locator(".todo")).toBeHidden();
    await expect(nav.getByRole("button", { name: /^Planned/ })).toHaveCount(0);
    await expect(nav.getByRole("button", { name: /^To-Do/ })).toBeVisible();
  });

  test("adds a task to a list, marked as waiting for the tablet", async ({ page }) => {
    await openTodo(page);
    await rail(page).getByRole("button", { name: /^Français/ }).click();
    // A draft belongs to its view: type only once the list is on screen.
    await expect(page.locator(".crumbs__here")).toHaveText("Français");
    await page.getByLabel("New task").fill("Fazer os exercícios");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const added = row(page, "Fazer os exercícios");
    await expect(added).toBeVisible();
    await expect(added).toContainText("Waiting for the tablet");
    await expect(page.locator(".todo-sync")).toContainText("next sync");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/list.png` });
  });

  test("completing a task moves it to the list's completed section", async ({ page }) => {
    await openTodo(page, "/inbox");
    await page.getByRole("button", { name: "Mark as done: after snapshot" }).click();
    await expect(page.locator(".todo-group__head", { hasText: "Completed" })).toContainText("2");
    await expect(page.locator(".todo-empty")).toContainText("Nothing in the Inbox");
  });

  test("selecting a task shows its actions: move, date, delete with undo", async ({ page }) => {
    await openTodo(page, "/inbox");
    await row(page, "after snapshot").click();
    await expect(page.getByRole("toolbar", { name: "Actions for after snapshot" })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/selected.png` });

    await page.getByRole("button", { name: "Date", exact: true }).click();
    await page.getByRole("menuitem", { name: "Tomorrow" }).click();
    await expect(row(page, "after snapshot")).toContainText("Tomorrow");

    // Still selected after the edit: the actions stay put.
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await page.getByRole("menuitem", { name: "Casa" }).click();
    await expect(row(page, "after snapshot")).toHaveCount(0);
    await rail(page).getByRole("button", { name: /^Casa/ }).click();
    await expect(row(page, "after snapshot")).toBeVisible();

    await row(page, "after snapshot").click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(row(page, "after snapshot")).toHaveCount(0);
    await expect(page.locator(".bin-toast.is-shown")).toContainText('Deleted "after snapshot"');
    await page.locator(".todo-undo").getByRole("button", { name: "Undo" }).click();
    await expect(row(page, "after snapshot")).toBeVisible();
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

  test("Planned: no reorder, no repeated Overdue, and the notebook link opens its page", async ({ page }) => {
    await openTodo(page, "/planned");
    const overdue = page.locator(".todo-group", { has: page.locator(".todo-group__head", { hasText: "Overdue" }) });
    await expect(overdue.locator(".todo-meta")).not.toContainText("Overdue");
    await overdue.locator(".todo-row").first().click();
    await expect(page.getByRole("button", { name: "Move up" })).toHaveCount(0);

    await openTodo(page, "/list/" + "1".padStart(32, "0"));
    const link = page.locator(".todo-meta__note").first();
    await expect(link).toHaveText(/^From .+, page \d+$/);
    await link.click();
    await expect(page).toHaveURL(/#\/note\/101\/page\/2$/);
  });

  test("the list's options live in the topbar: rename the list", async ({ page }) => {
    await openTodo(page, "/list/" + "1".padStart(32, "0"));
    await expect(page.locator("#todo-new-list")).toBeVisible();
    await page.locator("#todo-list-options").click();
    await page.getByRole("menuitem", { name: "Rename list" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Francês");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.locator(".crumbs__here")).toHaveText("Francês");
    await expect(rail(page).getByRole("button", { name: /^Francês/ })).toBeVisible();

    // Off To-Do, the topbar is the library's again.
    await rail(page).getByRole("button", { name: /^Note/ }).click();
    await expect(page.locator("#todo-new-list")).toBeHidden();
    await expect(page.locator("#todo-list-options")).toBeHidden();
  });

  test("New list asks for a name and opens the list", async ({ page }) => {
    await openTodo(page);
    await page.getByRole("button", { name: "New list" }).click();
    await page.getByLabel("Name").fill("Trabalho");
    await page.getByRole("button", { name: "Create list" }).click();
    await expect(page.locator(".crumbs__here")).toHaveText("Trabalho");
    await expect(page.locator(".todo-empty")).toContainText("This list is empty");
    await expect(rail(page).getByRole("button", { name: /^Trabalho/ })).toBeVisible();
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
