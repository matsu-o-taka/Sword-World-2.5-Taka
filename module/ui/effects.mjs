// Sword World 2.5 - GM-only Effects menu and Damage Vulnerability configurator.
//
// ApplicationV2 with the official Foundry v14 Handlebars mixin, following the
// system's other new applications. The window is only a configurator: preview,
// HTML generation and application all delegate to the configured-effect and
// EffectService implementation. No documents or settings back the editor.

import {
  applySw25ConfiguredEffect,
  renderSw25ConfiguredEffectEntry
} from "../effects/configured-effect.mjs";
import {
  DAMAGE_VULNERABILITY_CATEGORIES
} from "../effects/damage-vulnerability.mjs";
import {
  buildSw25DamageVulnerabilityConfiguration,
  buildSw25GenericEffectConfiguration,
  resolveSw25ControlledActor,
  SW25_DAMAGE_VULNERABILITY_DEFAULTS,
  SW25_GENERIC_DURATION_OPTIONS,
  SW25_GENERIC_EFFECT_DEFAULTS,
  SW25_GENERIC_EFFECT_TYPE_OPTIONS,
  SW25_GENERIC_MAGICAL_OPTIONS
} from "../effects/effect-configurator.mjs";
import {
  listSw25DamageElementOptions
} from "../rules/damage-elements.mjs";

const HandlebarsApplicationV2 =
  foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2);

const CATEGORY_LABELS = Object.freeze({
  physical: "Physical",
  magical: "Magical",
  any: "Any"
});

/** Effect types offered by the creator. */
const EFFECT_TYPES = Object.freeze([
  { id: "generic", label: "Generic Effect" },
  { id: "damageVulnerability", label: "Damage Vulnerability" }
]);

export class EffectsApp extends HandlebarsApplicationV2 {
  static PARTS = {
    main: { template: "systems/sw25-taka/templates/apps/effects.hbs" }
  };

  static get DEFAULT_OPTIONS() {
    return foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
      id: "sw25-effects-menu",
      classes: ["sw25", "sw25-effects-menu"],
      position: { width: 760, height: 720 },
      window: {
        title: "Effects",
        icon: "fa-solid fa-hand-sparkles",
        resizable: true
      }
    });
  }

  constructor(options = {}) {
    super(options);
    // Each effect type keeps its own form state so switching types never
    // mixes unrelated controls or loses the values typed in the other form.
    this._effectType = "damageVulnerability";
    this._dvState = { ...SW25_DAMAGE_VULNERABILITY_DEFAULTS };
    this._genericState = { ...SW25_GENERIC_EFFECT_DEFAULTS };
    // One editing session keeps one configured-effect identity while its
    // parameters change. This id is serialized into preview/copied HTML and
    // carried into the configuredEffectId flag on direct application.
    this._effectId = foundry.utils.randomID();
    this._configured = null;
    this._html = "";
    this._applying = false;
  }

  /** The settings menu is restricted; this is the programmatic-access gate. */
  _canRender(options) {
    if (game?.user?.isGM !== true) {
      ui.notifications.warn("Only the Game Master can open the Effects configurator.");
      return false;
    }
    return super._canRender(options);
  }

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    const isDamageVulnerability = this._effectType === "damageVulnerability";
    return {
      ...context,
      effectType: this._effectType,
      isGeneric: !isDamageVulnerability,
      isDamageVulnerability,
      effectTypes: EFFECT_TYPES.map(type => ({
        ...type,
        selected: this._effectType === type.id
      })),
      // Damage Vulnerability form values.
      values: this._dvState,
      categories: DAMAGE_VULNERABILITY_CATEGORIES.map(id => ({
        id,
        label: CATEGORY_LABELS[id] ?? id,
        selected: this._dvState.category === id
      })),
      elements: listSw25DamageElementOptions().map(option => ({
        ...option,
        selected: this._dvState.element === option.id
      })),
      // Generic Effect form values.
      genericValues: this._genericState,
      genericRounds: this._genericState.durationScale === "rounds",
      magicalOptions: SW25_GENERIC_MAGICAL_OPTIONS.map(option => ({
        ...option,
        selected: this._genericState.magical === option.id
      })),
      effectTypeOptions: SW25_GENERIC_EFFECT_TYPE_OPTIONS.map(option => ({
        ...option,
        selected: this._genericState.effectType === option.id
      })),
      durationOptions: SW25_GENERIC_DURATION_OPTIONS.map(option => ({
        ...option,
        selected: this._genericState.durationScale === option.id
      }))
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this._activateListeners(this.element);
    this._refreshPreview();
  }

  _activateListeners(root) {
    const form = root.querySelector("[data-effect-configurator-form]");
    if (!form) return;
    form.addEventListener("submit", event => event.preventDefault());
    const refresh = () => {
      this._refreshPreview();
      this._setActionStatus("");
    };
    form.addEventListener("input", refresh);
    form.addEventListener("change", refresh);

    root.querySelector("[data-effect-copy]")?.addEventListener("click", event => {
      event.preventDefault();
      void this._copyHtml();
    });
    root.querySelector("[data-effect-apply]")?.addEventListener("click", event => {
      event.preventDefault();
      void this._applyToSelectedActor();
    });
  }

  _readForm() {
    const form = this.element.querySelector("[data-effect-configurator-form]");
    if (!form) return;
    const data = new FormData(form);
    const effectType = String(data.get("effectType") ?? "");
    this._effectType = EFFECT_TYPES.some(type => type.id === effectType)
      ? effectType : "damageVulnerability";
    // Both sections stay in the DOM while one is hidden, so each type's raw
    // values are preserved when the GM switches between them.
    this._dvState = {
      name: String(data.get("name") ?? ""),
      description: String(data.get("description") ?? ""),
      additionalDamage: String(data.get("additionalDamage") ?? ""),
      category: String(data.get("category") ?? ""),
      element: String(data.get("element") ?? ""),
      source: String(data.get("source") ?? "")
    };
    this._genericState = {
      name: String(data.get("genericName") ?? ""),
      description: String(data.get("genericDescription") ?? ""),
      magical: String(data.get("genericMagical") ?? "nonmagical"),
      successValue: String(data.get("genericSuccessValue") ?? "0"),
      effectType: String(data.get("genericEffectType") ?? ""),
      durationScale: String(data.get("genericDurationScale") ?? ""),
      durationValue: String(data.get("genericDurationValue") ?? "1")
    };
  }

  /** Show exactly the section of the selected effect type. */
  _syncEffectTypeSections() {
    const root = this.element;
    if (!root?.querySelectorAll) return;
    root.querySelectorAll("[data-effect-section]").forEach(section => {
      section.hidden = section.dataset.effectSection !== this._effectType;
    });
    root.querySelectorAll("[data-generic-rounds]").forEach(field => {
      field.hidden = this._genericState.durationScale !== "rounds";
    });
  }

  /** Refresh only the preview, leaving every raw form value untouched. */
  _refreshPreview() {
    this._readForm();
    this._syncEffectTypeSections();
    const built = this._effectType === "damageVulnerability"
      ? buildSw25DamageVulnerabilityConfiguration({ ...this._dvState, id: this._effectId })
      : buildSw25GenericEffectConfiguration({ ...this._genericState, id: this._effectId });
    const preview = this.element.querySelector("[data-effect-preview]");
    const output = this.element.querySelector("[data-effect-html]");
    const validation = this.element.querySelector("[data-effect-validation]");

    if (built.ok) {
      this._configured = built.configured;
      this._html = renderSw25ConfiguredEffectEntry(this._configured);
      if (preview) preview.innerHTML = this._html;
      if (output) output.value = this._html;
      if (validation) {
        validation.textContent = "";
        validation.hidden = true;
      }
    } else {
      this._configured = null;
      this._html = "";
      if (preview) preview.textContent = "The preview will appear when the configuration is valid.";
      if (output) output.value = "";
      if (validation) {
        validation.textContent = built.error;
        validation.hidden = false;
      }
    }
    this._updateActionButtons();
  }

  _updateActionButtons() {
    const copy = this.element.querySelector("[data-effect-copy]");
    const apply = this.element.querySelector("[data-effect-apply]");
    if (copy) copy.disabled = !this._configured;
    if (apply) apply.disabled = !this._configured || this._applying;
  }

  _setActionStatus(message, state = "") {
    const status = this.element.querySelector("[data-effect-action-status]");
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
    status.hidden = !message;
  }

  async _copyHtml() {
    if (!this._configured || !this._html) {
      ui.notifications.warn("Correct the configuration before copying its HTML.");
      return false;
    }
    const html = this._html;
    const output = this.element.querySelector("[data-effect-html]");
    try {
      if (!globalThis.navigator?.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await globalThis.navigator.clipboard.writeText(html);
      ui.notifications.info("Configured-effect HTML copied to the clipboard.");
      this._setActionStatus("HTML copied. Paste it into a content document's description.", "success");
      return true;
    } catch (error) {
      // Clipboard permissions are browser-controlled. The read-only output is
      // always available as a manual copy path, selected here for convenience.
      if (output) {
        output.focus();
        output.select();
      }
      ui.notifications.warn("Automatic clipboard access failed. The generated HTML is selected; press Ctrl+C to copy it.");
      this._setActionStatus("Automatic copy failed. Press Ctrl+C while the generated HTML is selected.", "error");
      return false;
    }
  }

  async _applyToSelectedActor() {
    if (game?.user?.isGM !== true) {
      const result = { ok: false, code: "not-gm", error: "Only the Game Master can apply effects from this configurator." };
      ui.notifications.warn(result.error);
      this._setActionStatus(result.error, "error");
      return result;
    }
    if (!this._configured) {
      const result = { ok: false, code: "invalid-configuration", error: "Correct the configuration before applying the effect." };
      ui.notifications.warn(result.error);
      this._setActionStatus(result.error, "error");
      return result;
    }

    const selection = resolveSw25ControlledActor(globalThis.canvas?.tokens?.controlled ?? []);
    if (!selection.ok) {
      ui.notifications.warn(selection.error);
      this._setActionStatus(selection.error, "error");
      return selection;
    }

    const configured = this._configured;
    const actor = selection.actor;
    this._applying = true;
    this._updateActionButtons();
    try {
      // This is the same entry point used by configured-effect drag-and-drop.
      // A GM therefore writes through EffectService with the normal stacking,
      // validation, provenance, duration and removal lifecycle.
      const result = await applySw25ConfiguredEffect(actor, configured, { notify: false });
      if (result.ok) {
        ui.notifications.info(`${configured.name} applied to ${actor.name}.`);
        this._setActionStatus(`${configured.name} applied to ${actor.name}. Open the Actor's Effects tab to inspect or remove it.`, "success");
      } else {
        const message = result.error ?? "The configured effect could not be applied.";
        ui.notifications.error(message);
        this._setActionStatus(message, "error");
      }
      return result;
    } catch (error) {
      const message = `The configured effect could not be applied: ${String(error?.message ?? error)}`;
      console.error("Sword World 2.5 | Effects configurator application failed", error);
      ui.notifications.error(message);
      this._setActionStatus(message, "error");
      return { ok: false, code: "application-failed", error: message };
    } finally {
      this._applying = false;
      this._updateActionButtons();
    }
  }
}
