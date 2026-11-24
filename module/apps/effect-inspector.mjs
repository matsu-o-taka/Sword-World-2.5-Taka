// Sword World 2.5 - Individual persistent-effect inspection dialog (T1.5).
//
// ApplicationV2 dialog using the official Foundry v14 Handlebars rendering
// mixin (foundry.applications.api.HandlebarsApplicationMixin + static PARTS),
// consulted in foundry-api-docs before implementation, per AGENTS.md.
// ApplicationV2 is chosen for a NEW application per the system's architecture
// rules; ApplicationV1 sheets remain untouched.
//
// Inspection renders the real persisted document data prepared by
// buildSw25EffectInspection (module/effects/effects-tab.mjs). Two write actions
// exist, both delegated to EffectService (the sole semantic validator and
// document writer, DEC-36): GM removal of the inspected sw25Effect and, for
// the unified NON-COMBAT time counter (minutes/hours/days), the GM-or-owner
// duration edit. No direct ActiveEffect mutation or separate lifecycle is
// introduced.
//
// Phase 3 (U6): the duration editor lives here because the inspector is the
// existing per-effect detail surface. It edits ONE counter — amount + unit —
// through `setSw25EffectTimeDuration` (GM) or the `set-duration` relay
// operation (owning user); unit conversion is the service's job, never the
// UI's.

import { buildSw25EffectInspection, buildSw25TimeCounterEditor, convertSw25TimeAmount } from "../effects/effects-tab.mjs";
import { removeSw25Effect, setSw25EffectTimeDuration } from "../effects/effect-service.mjs";
import { requestSw25EffectOperation } from "../effects/effect-relay.mjs";

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
    const editableDocument = this._effect?.type === "sw25Effect"
      && typeof this._effect?.id === "string" && !!this._effect?.parent;
    // Editable wherever the existing effect UI already permits a write: the GM
    // always, and the owning user (isOwner, verified in the v14 document API).
    const timeCounter = buildSw25TimeCounterEditor(this._effect?.system ?? {}, {
      isGM: game?.user?.isGM === true,
      isOwner: this._effect?.parent?.isOwner === true,
      editableDocument
    });
    return {
      ...context,
      effect: buildSw25EffectInspection(this._effect, this._resolve, { combat: game.combat ?? null }),
      canRemove: game?.user?.isGM === true && this._effect?.type === "sw25Effect"
        && typeof this._effect?.id === "string" && !!this._effect?.parent,
      canEditDuration: timeCounter?.canEdit === true,
      timeCounter
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    // Listeners bind to the live element on every render (the DOM is replaced
    // by the Handlebars mixin on re-render).
    this.element?.querySelectorAll("[data-inspector-close]").forEach(button => {
      button.addEventListener("click", () => {
        this.close().catch(error =>
          console.error("Sword World 2.5 | Could not close the effect inspector", error));
      });
    });
    this.element?.querySelector("[data-inspector-remove]")?.addEventListener("click", () => {
      void this._removeEffect();
    });
    this.element?.querySelector("[data-inspector-duration-save]")?.addEventListener("click", () => {
      void this._saveDuration();
    });
    // Unit switch (Phase 3 corrections): re-express the current amount in the
    // newly selected unit so a unit change never alters the duration behind
    // the user's back. Exact equivalents convert exactly; inexact ones show a
    // display-only rounding that the service refuses to persist
    // (`unrepresentable`) — nothing inexact is ever stored silently.
    const unitSelect = this.element?.querySelector('select[name="duration-unit"]');
    const amountInput = this.element?.querySelector('input[name="duration-amount"]');
    if (unitSelect && amountInput) {
      this._durationEntryUnit = unitSelect.value;
      unitSelect.addEventListener("change", () => {
        const previousUnit = this._durationEntryUnit;
        this._durationEntryUnit = unitSelect.value;
        const current = String(amountInput.value).trim();
        const numeric = Number(current);
        if (current === "" || !Number.isFinite(numeric) || !previousUnit || previousUnit === unitSelect.value) return;
        amountInput.value = String(convertSw25TimeAmount(numeric, previousUnit, unitSelect.value));
      });
    }
  }

  /**
   * Persist the unified non-combat time counter from the inspector form.
   * The GM writes locally through EffectService; the owning user sends the
   * same request through the effect relay (the GM still performs the write).
   * Unit conversion and every rejection stay in the service.
   * @returns {Promise<object>} The operation result.
   */
  async _saveDuration() {
    const root = this.element;
    const unit = root?.querySelector('select[name="duration-unit"]')?.value ?? "";
    const rawAmount = root?.querySelector('input[name="duration-amount"]')?.value ?? "";
    const amount = String(rawAmount).trim() === "" ? undefined : Number(rawAmount);
    if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
      ui.notifications.warn("Sword World 2.5 | The duration amount must be a positive number.");
      return { ok: false, code: "invalid-amount" };
    }
    const actor = this._effect?.parent;
    const effectId = this._effect?.id;
    const isGm = game?.user?.isGM === true;
    const result = isGm
      ? await setSw25EffectTimeDuration(actor, effectId, { unit, amount }, { notify: true })
      : await requestSw25EffectOperation("set-duration", {
        actorUuid: actor?.uuid,
        effectId,
        unit,
        amount
      });
    if (!result?.ok) {
      ui.notifications.warn(result?.error ?? "The effect duration could not be updated.");
      return result ?? { ok: false, code: "update-failed" };
    }
    await this.render(false);
    return result;
  }

  /** Remove this system effect through the authoritative GM service path. */
  async _removeEffect() {
    if (game?.user?.isGM !== true) {
      ui.notifications.warn("Only the Game Master can remove effects.");
      return { ok: false, code: "not-gm", error: "Only the Game Master can remove effects." };
    }
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Remove Effect" },
      content: `<p>Remove <strong>${foundry.utils.escapeHTML(this._effect?.name || "this effect")}</strong>? This cannot be undone.</p>`,
      rejectClose: false,
      modal: true
    });
    if (confirmed !== true) return { ok: false, code: "cancelled" };

    const result = await removeSw25Effect(this._effect?.parent, this._effect?.id, { notify: true });
    if (result.ok) {
      await this.close();
    } else {
      ui.notifications.error(result.error ?? "The effect could not be removed.");
    }
    return result;
  }
}
