// Sword World 2.5 - Target section selection dialog (ApplicationV2).
//
// ApplicationV2 dialog using the official Foundry v14 Handlebars rendering
// mixin (foundry.applications.api.HandlebarsApplicationMixin + static PARTS),
// consulted in foundry-api-docs before implementation, per AGENTS.md.
// A plain ApplicationV2 subclass is NOT renderable in v14: the abstract
// methods _renderHTML AND _replaceHTML must both be implemented, which is why
// the previous hand-rolled _renderHTML-only version threw
// "not renderable ... does not implement the abstract methods" and never
// opened over multi-section monsters.
//
// Registered through registerTargetSelectionDialog (module/rules/
// target-selection.mjs) so the rules layer stays independent of the UI class.

import { registerTargetSelectionDialog } from "../rules/target-selection.mjs";

const HandlebarsApplicationV2 =
  foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2);

export class TargetSelectionDialog extends HandlebarsApplicationV2 {
  static PARTS = {
    main: { template: "systems/sw25-taka/templates/apps/target-selection-dialog.hbs" }
  };

  static get DEFAULT_OPTIONS() {
    return foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
      id: "sw25-target-selection-dialog",
      classes: ["sw25", "sw25-target-selection"],
      // v14 ApplicationConfiguration has no top-level `width`/`height`: the
      // size belongs to `position` (official docs, ApplicationConfiguration /
      // ApplicationPosition); `resizable` belongs to the window config. A
      // top-level `width: 460` was silently ignored and the dialog rendered
      // at the core default of 300px.
      position: { width: 460, height: "auto" },
      window: { resizable: false }
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

  _onRender(context, options) {
    super._onRender(context, options);
    // The Handlebars mixin replaces the part DOM on every render, so listeners
    // are re-registered against the live element each time (this covers first
    // render and any subsequent re-render). Listeners live in _onRender —
    // never in a first-render hook — so they cannot be duplicated.
    this._activateListeners(this.element);
  }

  _activateListeners(root) {
    root.querySelectorAll("[data-section-toggle]").forEach(radio => {
      radio.addEventListener("change", event => {
        const id = event.currentTarget.dataset.sectionId;
        const row = this._findOption(id);
        if (!row) return;
        // Radio behavior: only one selected at a time
        this._options.forEach(o => { o.selected = false; });
        row.selected = true;
      });
    });

    root.querySelectorAll("[data-section-cancel]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        this.resolveAndClose(null);
      });
    });

    root.querySelectorAll("[data-section-submit]").forEach(button => {
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
