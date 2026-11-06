// The account page's Devices section: the Supernotes linked to this account,
// each with when it last synced and an Unlink behind a confirmation. Owns its
// list and the unlinks in flight; the page decides when it loads.

import { el } from "../../ui/dom";
import { openDialog } from "../../ui/confirm";
import { absoluteTime } from "../../ui/relativeTime";
import type { MyDevice } from "../../api/accountTypes";
import type { AccountApi } from "./account";
import { button, failed, pending, type Load } from "./accountDom";
import { deviceSeenLabel, failureMessage } from "./accountCopy";

export interface DevicesDeps {
  api: Pick<AccountApi, "myDevices" | "unlinkMyDevice">;
  body: HTMLElement;
  /** Where the confirmation dialog mounts. */
  root: HTMLElement;
  toast: (message: string) => void;
  handled: (e: unknown) => boolean;
  generation: () => number;
  /** The linked devices, whenever they are known (the password warning names them). */
  onDevices: (devices: MyDevice[]) => void;
}

export interface DevicesSection {
  render(): void;
  isReady(): boolean;
  load(generation: number): Promise<void>;
}

export function createDevicesSection(deps: DevicesDeps): DevicesSection {
  const body = deps.body;
  let devices: Load<MyDevice[]> = { kind: "loading" };
  /** In-flight guard against a second unlink of the same device. */
  const unlinking = new Set<string>();

  function render(): void {
    if (devices.kind === "loading") {
      body.replaceChildren(pending());
      return;
    }
    if (devices.kind === "failed") {
      body.replaceChildren(failed(devices.message));
      return;
    }
    if (devices.data.length === 0) {
      // Only claimed once the data that could disprove it has arrived.
      body.replaceChildren(el("p", { class: "acct-empty", text: "No Supernote is linked to this account yet." }));
      return;
    }
    body.replaceChildren(...devices.data.map(deviceRow));
    deps.onDevices(devices.data);
  }

  function deviceRow(device: MyDevice): HTMLElement {
    const unlink = button("Unlink", () => void unlinkDevice(device), {
      danger: true,
      ariaLabel: `Unlink ${device.name || device.equipmentNo}`,
    });
    unlink.disabled = unlinking.has(device.equipmentNo);
    const seen = el("span", { class: "acct-device__sync acct-data", text: deviceSeenLabel(device) });
    if (device.lastSeenAt !== null) seen.title = absoluteTime(device.lastSeenAt * 1000);
    return el(
      "div",
      { class: "acct-row acct-device" },
      // Named as an object; the serial only when the device never sent its name.
      el(
        "div",
        { class: "acct-row__k acct-device__name" },
        el("span", { text: device.name || device.equipmentNo }),
        el("span", { class: "acct-device__dot", "aria-hidden": "true", text: "·" }),
        seen,
      ),
      el("div", { class: "acct-row__v acct-data acct-device__serial", text: device.name ? device.equipmentNo : "" }),
      el("div", { class: "acct-row__acts" }, unlink),
    );
  }

  async function unlinkDevice(device: MyDevice): Promise<void> {
    if (unlinking.has(device.equipmentNo)) return;

    // Confirmed because it can't be undone here: re-pairing happens on the tablet.
    // Cancel is the autofocused default.
    const name = device.name || device.equipmentNo;
    const ok = await openDialog({
      host: deps.root,
      classes: { dialog: "confirm", body: "confirm__body", actions: "confirm__actions", cancel: "btn", go: "btn is-danger" },
      goLabel: "Unlink",
      cancelLabel: "Cancel",
      labelledBy: "acct-unlink-title",
      build: (dialogBody, { go }) => {
        go.setAttribute("aria-label", `Unlink ${name}`);
        dialogBody.append(
          el("h2", { id: "acct-unlink-title", text: `Unlink ${name}?` }),
          // Both halves: what stops and what is safe.
          el("p", {
            text: `${name} will stop syncing until you pair it again from the device itself. Nothing already synced is removed.`,
          }),
        );
      },
    }).done;
    if (!ok) return;

    unlinking.add(device.equipmentNo);
    render();
    const mine = deps.generation();
    try {
      await deps.api.unlinkMyDevice(device.equipmentNo);
      if (mine !== deps.generation()) return;
      deps.toast(`${name} won't sync until it's paired again.`);
      // Re-read rather than splice: the server's answer is what's bound.
      await load(mine);
    } catch (e) {
      if (mine !== deps.generation()) return;
      if (!deps.handled(e)) deps.toast(failureMessage(e));
    } finally {
      unlinking.delete(device.equipmentNo);
      if (mine === deps.generation()) render();
    }
  }

  function load(mine: number): Promise<void> {
    return deps.api.myDevices().then(
      (data) => {
        if (mine !== deps.generation()) return;
        devices = { kind: "ready", data };
        render();
      },
      (e: unknown) => {
        if (mine !== deps.generation()) return;
        if (deps.handled(e)) return;
        devices = { kind: "failed", message: failureMessage(e) };
        render();
      },
    );
  }

  return { render, isReady: () => devices.kind === "ready", load };
}
