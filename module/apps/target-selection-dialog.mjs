// Sword World 2.5 - Target selection dialog for multi-section monsters.
//
// ApplicationV2 dialog (foundry.applications.api.ApplicationV2), following the
// v2 pattern of Foundry VTT v14. Allows the player to declare which section
// of a multi-section monster is being targeted before resolving the attack.
//
//   - rows with an individually selectable radio button
//   - section name and optional description (HP, evasion, etc.) shown per row
//   - confirm (resolve with combatStyleId) or cancel (abort attack, no side effects)
//
// The result is a single combatStyleId string for the current attack only:
// it never writes Actor data and never creates persistent effects.

import { registerTargetSelectionDialog } from "../rules/target-selection.mjs";

export class TargetSelectionDialog extends foundry.applications.api.ApplicationV2 {
  static get DEFAULT_OPTIONS() {
    return foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
      id: "sw25-target-selection-dialog",
      classes: ["sw25", "sw25-target-selection"],
      template: "systems/sword-world-25/templates/apps/target-selection-dialog.hbs",
      width: 460,
      height: "auto",
      resizable: false
    });
  }

  constructor(options = {}) {
    super(options);
    const seed = Array.isArray(options.options) ? options.options : [];
    this._options = seed.map(opt => ({
      id: String(opt.id ?? ""),
      label: String(opt.label ?? `Section ${opt.id ?? ""}`),
      description: String(opt.description ?? ""),
      selected: opt.selected === true
    }));
    this._title = String(options.title ?? "Select Target Section");
    this._submitLabel = String(options.submitLabel ?? "Confirm");
    this._minSelections = Number(options.minSelections ?? 1);
    this._resolve = null;
    this._closing = false;
  }

  static async open(config = {}) {
    return new Promise(resolve => {
      const dialog = new this(config);
      dialog._resolve = resolve;
      return dialog.render(true);
    });
  }

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      title: this._title,
      submitLabel: this._submitLabel,
      options: this._options,
      minSelections: this._minSelections
    };
  }

  async _renderHTML(options = {}) {
    const context = await this._prepareContext(options);
    return await renderTemplate("systems/sword-world-25/templates/apps/target-selection-dialog.hbs", context);
  }

  _onFirstRender(html) {
    super._onFirstRender(html);
    // Listeners are registered in _onRender instead. ApplicationV2 runs
    // _onRender on every render (including the first), right after
    // _replaceHTML has inserted the rendered HTML into the DOM. Keeping
    // registration here avoids duplicating listeners on the first render
    // while still covering subsequent renders where the DOM is replaced.
  }

  _onRender(html) {
    super._onRender(html);
    this._activateListeners(html);
  }

  _activateListeners(html) {
    html.querySelectorAll("[data-section-toggle]").forEach(radio => {
      radio.addEventListener("change", event => {
        const id = event.currentTarget.dataset.sectionId;
        const row = this._findOption(id);
        if (!row) return;
        // Radio behavior: only one selected at a time
        this._options.forEach(o => { o.selected = false; });
        row.selected = true;
      });
    });

    html.querySelectorAll("[data-section-cancel]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        this.resolveAndClose(null);
      });
    });

    html.querySelectorAll("[data-section-submit]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        const selected = this._options.filter(opt => opt.selected);
        if (selected.length < this._minSelections) {
          ui.notifications.warn("Please select at least one section.");
          return;
        }
        const id = selected[0].id;
        this.resolveAndClose(id);
      });
    });
  }

  _findOption(id) {
    return this._options.find(opt => opt.id === id) ?? null;
  }

  resolveAndClose(result) {
    const resolve = this._resolve;
    this._resolve = null;
    this._closing = true;
    if (resolve) resolve(result);
    this.close().catch(error => console.error("Sword World 2.5 | Could not close the target selection dialog", error));
  }

  async close(options = {}) {
    if (this._closing) return super.close(options);
    const resolve = this._resolve;
    this._resolve = null;
    if (resolve) resolve(null);
    return super.close(options);
  }
}

registerTargetSelectionDialog(TargetSelectionDialog);
