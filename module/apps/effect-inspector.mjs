// Sword World 2.5 - Individual persistent-effect inspection dialog (T1.5).
//
// ApplicationV2 dialog using the official Foundry v14 Handlebars rendering
// mixin (foundry.applications.api.HandlebarsApplicationMixin + static PARTS),
// consulted in foundry-api-docs before implementation, per AGENTS.md.
// ApplicationV2 is chosen for a NEW application per the system's architecture
// rules; ApplicationV1 sheets remain untouched.
//
// Strictly read-only: it renders the real persisted document data prepared by
// buildSw25EffectInspection (module/effects/effects-tab.mjs) and performs no
// write of any kind. There is deliberately no delete/toggle/edit control:
// basic management writes must wait for the future EffectService write
// circuit (DEC-36) and would otherwise bypass the approved architecture.

import { buildSw25EffectInspection } from "../effects/effects-tab.mjs";

const HandlebarsApplicationV2 =
  foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.api.ApplicationV2);

/**
 * Default UUID resolver: official v14 synchronous resolution
 * (foundry.utils.fromUuidSync resolves world documents and compendium index
 * entries). Unresolvable or invalid UUIDs degrade to null — the raw UUID is
 * then displayed, so the persisted value is never hidden.
 * @param {string} uuid
 * @returns {object|null}
 */
function defaultResolve(uuid) {
  try {
    return foundry.utils.fromUuidSync?.(uuid) ?? null;
  } catch {
    return null;
  }
}

export class Sw25EffectInspector extends HandlebarsApplicationV2 {
  static PARTS = {
    main: { template: "systems/sw25-taka/templates/apps/effect-inspector.hbs" }
  };

  static get DEFAULT_OPTIONS() {
    return foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
      classes: ["sw25", "sw25-effect-inspector"],
      // No fixed `id`: every instance gets a unique auto id so several
      // effects can be inspected at once without replacing each other.
      // v14 ApplicationConfiguration has no top-level `width`/`height`: the
      // size belongs to `position` (official docs, ApplicationConfiguration /
      // ApplicationPosition); `resizable` belongs to the window config.
      position: { width: 540 },
      window: { icon: "fas fa-magnifying-glass", resizable: false }
    });
  }

  /**
   * @param {object} effect - The effect document (or plain stub) to inspect.
   * @param {Function|null} [resolve] - Optional UUID resolver override; by
   *   default foundry.utils.fromUuidSync is used (official v14 API).
   */
  constructor(effect, resolve = null) {
    super({ window: { title: effect?.name ? `Effect: ${effect.name}` : "Effect Inspection" } });
    this._effect = effect;
    this._resolve = resolve ?? defaultResolve;
  }

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      effect: buildSw25EffectInspection(this._effect, this._resolve, { combat: game.combat ?? null })
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    // Listeners bind to the live element on every render (the DOM is replaced
    // by the Handlebars mixin on re-render). Read-only: only the Close button.
    this.element?.querySelectorAll("[data-inspector-close]").forEach(button => {
      button.addEventListener("click", () => {
        this.close().catch(error =>
          console.error("Sword World 2.5 | Could not close the effect inspector", error));
      });
    });
  }
}
