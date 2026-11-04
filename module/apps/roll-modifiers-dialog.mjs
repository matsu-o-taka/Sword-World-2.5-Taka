// Sword World 2.5 - Temporary roll modifiers dialog
//
// ApplicationV1 dialog (foundry.appv1.api.Application), following the
// established v1 pattern of this system. Inspired by the Pathfinder 2e check
// modifiers dialog UX, reduced to SW2.5 needs:
//   - rows with an individually toggleable checkbox
//   - temporary rows with editable label/value and a remove button
//   - permanent rows (system-computed) shown for context, toggleable
//   - live total update
//   - confirm (resolve roll) or cancel (abort roll, no side effects)
//
// The result is a list of enabled modifiers for the current roll only:
// it never writes Actor data and never creates persistent effects.

import { registerRollModifiersDialog, signedValue } from "../rules/roll-modifiers.mjs";

const NUMBER_PATTERN = /^[+-]?\d+$/;

export class RollModifiersDialog extends foundry.appv1.api.Application {
  constructor(config = {}, options = {}) {
    super(options);
    let nextId = 1;
    const seed = Array.isArray(config.parts) ? config.parts : [];
    this._parts = seed.map(part => {
      const value = Number(part?.value ?? 0);
      return {
        id: nextId++,
        label: String(part?.label ?? `Modifier ${nextId}`),
        value: Number.isFinite(value) ? value : 0,
        enabled: part?.enabled !== false,
        temporary: part?.temporary === true
      };
    });
    this._diceFormula = String(config.diceFormula ?? "2d6");
    this._submitLabel = String(config.submitLabel ?? "Roll");
    this._resolve = null;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "sw25-roll-modifiers-dialog",
      classes: ["sw25", "sw25-roll-modifiers"],
      template: "systems/sword-world-25/templates/apps/roll-modifiers-dialog.hbs",
      width: 460,
      height: "auto",
      resizable: false
    });
  }

  static open(config = {}) {
    return new Promise(resolve => {
      const dialog = new this(config, { title: String(config.title ?? "Temporary Modifiers") });
      dialog._resolve = resolve;
      dialog.render(true);
    });
  }

  enabledTotal() {
    return this._parts
      .filter(part => part.enabled)
      .reduce((sum, part) => sum + Number(part.value ?? 0), 0);
  }

  async getData() {
    const total = this.enabledTotal();
    return {
      diceFormula: this._diceFormula,
      submitLabel: this._submitLabel,
      parts: this._parts,
      total,
      totalLabel: signedValue(total)
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-modifier-toggle]").on("change", event => {
      const row = this._findRow(event.currentTarget.dataset.modifierId);
      if (!row) return;
      row.enabled = Boolean(event.currentTarget.checked);
      this._refreshTotal(html);
    });

    html.find("[data-modifier-value]").on("change", event => {
      const row = this._findRow(event.currentTarget.dataset.modifierId);
      if (!row) return;
      const raw = String(event.currentTarget.value ?? "").trim();
      if (!NUMBER_PATTERN.test(raw)) {
        ui.notifications.warn("Enter an integer modifier value (for example 2 or -1).");
        event.currentTarget.value = row.value;
        return;
      }
      row.value = Number(raw);
      this._refreshTotal(html);
    });

    html.find("[data-modifier-label]").on("change", event => {
      const row = this._findRow(event.currentTarget.dataset.modifierId);
      if (!row) return;
      row.label = String(event.currentTarget.value ?? "").trim() || row.label;
    });

    html.find("[data-modifier-remove]").on("click", event => {
      const id = Number(event.currentTarget.dataset.modifierId);
      this._parts = this._parts.filter(part => part.id !== id);
      this.render(false);
    });

    html.find("[data-modifiers-add]").on("click", event => {
      event.preventDefault();
      const container = $(event.currentTarget).closest(".sw25-roll-modifiers-add");
      const label = String(container.find("[name='add-modifier-label']").val() ?? "").trim();
      const rawValue = String(container.find("[name='add-modifier-value']").val() ?? "").trim();
      if (!NUMBER_PATTERN.test(rawValue)) {
        ui.notifications.warn("Enter an integer modifier value (for example 2 or -1).");
        return;
      }
      const nextId = Math.max(0, ...this._parts.map(part => part.id)) + 1;
      this._parts.push({ id: nextId, label: label || `Modifier ${nextId}`, value: Number(rawValue), enabled: true, temporary: true });
      this.render(false);
    });

    html.find("[data-modifiers-cancel]").on("click", event => {
      event.preventDefault();
      this.resolveAndClose(null);
    });

    html.find("[data-modifiers-submit]").on("click", event => {
      event.preventDefault();
      const enabled = this._parts
        .filter(part => part.enabled)
        .map(part => ({ label: part.label, value: Number(part.value ?? 0), enabled: true, temporary: part.temporary }));
      this.resolveAndClose(enabled);
    });
  }

  _findRow(id) {
    const number = Number(id);
    return this._parts.find(part => part.id === number) ?? null;
  }

  _refreshTotal(html) {
    const totalNode = html.find(".sw25-roll-modifiers-total strong").get(0);
    if (totalNode) totalNode.textContent = this.enabledTotal();
  }

  resolveAndClose(result) {
    const resolve = this._resolve;
    this._resolve = null;
    this._closing = true;
    if (resolve) resolve(result);
    this.close().catch(error => console.error("Sword World 2.5 | Could not close the modifier dialog", error));
  }

  async close(options = {}) {
    if (this._closing) return super.close(options);
    // Closing the window directly (header bar, Escape) counts as a cancel:
    // the pending roll is aborted without data changes or other side effects.
    const resolve = this._resolve;
    this._resolve = null;
    if (resolve) resolve(null);
    return super.close(options);
  }
}

registerRollModifiersDialog(RollModifiersDialog);
