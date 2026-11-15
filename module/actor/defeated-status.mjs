// Sword World 2.5 - Automatic HP → DEFEATED status synchronization.
//
// Single centralized mechanism keeping the NATIVE Foundry DEFEATED status in
// step with an actor's real condition:
//
//   - Characters (and any actor with a numeric `system.hp.value`): HP ≤ 0
//     applies it, HP > 0 removes it. Negative HP are preserved exactly as
//     stored — this module only reads them.
//   - Multi-section monsters: each section is destroyed at 0 or fewer HP
//     (never clamped, never duplicated as state) and the global incapacitation
//     follows the monster's Main Section policy (any / all / none, Core
//     Rulebook I p. 387) derived by module/actor/monster-section-state.mjs.
//
// The status is never represented as an `sw25Effect`, never enters the
// duration engine, and never modifies HP itself. The T5.3 engine keeps
// consuming `Combatant#isDefeated` untouched: the applied native status IS
// that signal.
//
// Why `updateActor` keyed on the relevant changed paths: every HP write path
// in the system (damage application, regeneration/exhaustive healing, sheet
// rest and HP-cost lines, recovery items, death-check auto success, manual
// sheet edits) ends in `Actor.update` carrying `system.hp.value`, and every
// section-HP path (damage application, monster-sheet form submits, manual
// edits) ends in `Actor.update` carrying `system.combatStyles` (whole array
// or dotted per-row HP). One hook covers all of them without polling. The
// resulting status write is an embedded native ActiveEffect create/delete,
// which cannot fire `updateActor` with any of those paths, so the hook
// cannot recurse.
//
// IMPORTANT (verified live in v14): the hook's `change` is the nested
// (expanded) data DIFF, e.g. `{"system":{"mainSectionPolicy":"none"}}` even
// when the caller passed dotted keys. Detection therefore covers BOTH the
// nested form (the real hook) and the flat dotted form (programmatic callers
// and headless environments). The listener is fire-and-forget by design; the
// status write is awaited inside the handler.
//
// Deliberate contract points:
//   - GM-gated: status writes follow the same authority pattern as the
//     damage-application relay. Without a connected GM the sync waits until
//     the next GM-side update of a relevant path.
//   - Idempotent: when the status already matches the condition, nothing is
//     written (no redundant effect create/delete churn).
//   - `overlay: true`, matching what the core combat tracker itself does when
//     a combatant is defeated manually (Combatant tracker coupling in core).
//   - Only the STATUS is managed. The combatant `defeated` flag is never
//     touched; the tracker's `Combatant#isDefeated` reads both, so manual
//     tracker decisions remain authoritative in either direction.

import { readMonsterSectionState, resolveMonsterSectionPolicy, resolveMonsterSpecialRule } from "./monster-section-state.mjs";
import { getConcealedMainSectionSelection } from "../combat/concealed-main-section.mjs";

const DEFEATED_FALLBACK_ID = "dead";

// Reentrancy guard: one in-flight sync per actor. Status application is an
// embedded ActiveEffect operation that does not re-enter this module, but the
// guard makes concurrent triggers (hook + direct call) strictly serialized.
const syncingActors = new WeakSet();

// Dotted monster-section HP keys (`system.combatStyles.0.hp.value`) that can
// appear in flattened update payloads (programmatic updates; the sheet's
// submit path reassembles the whole array instead).
const SECTION_HP_KEY = /^system\.combatStyles\.\d+\.hp\.value$/;

/**
 * Resolve the DEFEATED status id from the live Foundry configuration, with a
 * stable fallback for headless/mock environments.
 * @returns {string}
 */
function defeatedStatusId() {
  const configured = globalThis.CONFIG?.specialStatusEffects?.DEFEATED;
  return typeof configured === "string" && configured ? configured : DEFEATED_FALLBACK_ID;
}

/**
 * Synchronize one actor's DEFEATED status with its current real condition.
 *
 * Characters follow their HP; monsters follow their section condition
 * (Main Section policy). Pure decision + single native write, idempotent,
 * recursion-safe. Never writes HP, never creates an `sw25Effect`, never
 * touches the duration engine, and never touches the combat tracker's
 * `defeated` flag.
 * @param {Actor} actor - Actor whose condition changed (or any actor to re-sync).
 * @returns {Promise<{ok: boolean, code: string, changed: boolean,
 *   defeated: boolean|null}>}
 *   `code` is one of: "in-sync" (no write needed), "applied", "removed",
 *   "no-actor", "not-gm", "no-hp", "reentrancy", "error",
 *   "concealed-selection-unavailable" (special policy with an unresolvable
 *   concealed selection — explicitly not evaluated, GM notified).
 */
export async function syncSw25DefeatedStatus(actor) {
  if (!actor) return { ok: false, code: "no-actor", changed: false, defeated: null };
  if (globalThis.game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", changed: false, defeated: null };
  }

  // Character path: the single `system.hp.value`.
  let expected;
  if (actor.type === "monster") {
    // Multi-section monster path: derive the global incapacitation from the
    // persisted section HP (no state duplication, no clamping anywhere).
    // Monsters never fall back to `system.hp.value`: their condition is the
    // section condition, and an empty section list means "no condition".
    //
    // Special policy is a CATEGORY: the persisted special rule
    // (`system.mainSectionSpecialRule`) decides what happens.
    //   - `manual` (Manual Resolution): the system does not implement the
    //     rule and NEVER derives DEFEATED from section destruction — the GM
    //     resolves it by hand. The sync deliberately does nothing (it also
    //     never removes a status the GM applied themselves in the tracker).
    //   - `concealedMainSection` (or a legacy special identification without
    //     a persisted rule): the secret selection lives encrypted in a
    //     sw25Effect ActiveEffect persisted via EffectService; this GM-side
    //     sync is the only place that resolves it and injects it into the
    //     pure state (module/actor/monster-section-state.mjs documents the
    //     degradation when no valid selection exists). This is NOT a second
    //     sync mechanism — the condition and the native DEFEATED write below
    //     are unchanged.
    //   - explicit Special with NO rule: controlled unconfigured state —
    //     the sync refuses to evaluate and informs the GM instead of
    //     silently resolving as Any. Legacy imports identified as special
    //     (derived) keep the pre-rule degraded behavior.
    //
    // An UNRESOLVABLE concealed selection (missing/wrong key, corrupted
    // record, or a selected section that no longer exists) is an explicit
    // invalid state: the sync refuses to evaluate instead of silently
    // degrading to the ordinary all-sections behaviour (which would skip a
    // DEFEATED the rules demand or apply an incorrect mechanical result).
    const resolvedPolicy = resolveMonsterSectionPolicy(actor.system);
    const sectionOptions = {};
    if (resolvedPolicy.policy === "special") {
      const { rule } = resolveMonsterSpecialRule(actor.system);
      if (rule === "manual") {
        return { ok: true, code: "manual-resolution", changed: false, defeated: null };
      }
      const derivedSpecial = String(actor.system?.mainSection?.type ?? "").trim().toLowerCase() === "special";
      if (rule === "concealedMainSection") {
        let selection = null;
        try {
          selection = await getConcealedMainSectionSelection(actor);
        } catch (error) {
          ui.notifications.error(
            `Sword World 2.5 | The concealed Main Section of ${actor.name} could not be resolved; DEFEATED was NOT re-evaluated: ${String(error?.message ?? error)}`
          );
          return { ok: false, code: "concealed-selection-unavailable", changed: false, defeated: null };
        }
        if (!selection) {
          // The Concealed Main Section rule is selected but no usable
          // selection exists: controlled invalid configuration, never a
          // silent fallback.
          ui.notifications.warn(
            `Sword World 2.5 | ${actor.name} uses the Concealed Main Section rule but has no usable selection; DEFEATED was NOT re-evaluated. Re-save the rule in the Main Sections dialog.`
          );
          return { ok: false, code: "concealed-selection-missing", changed: false, defeated: null };
        }
        sectionOptions.concealedSectionId = selection.sectionId;
      } else if (derivedSpecial) {
        // Legacy fallback: a special-identified profile (`mainSection.type =
        // "special"`) without a persisted rule. Resolve the concealed
        // selection if one exists; degrades to the all-sections-destroyed
        // condition when absent (never instant defeat, never immortal). An
        // unresolvable selection is an explicit invalid state.
        try {
          const selection = await getConcealedMainSectionSelection(actor);
          if (selection?.sectionId) sectionOptions.concealedSectionId = selection.sectionId;
        } catch (error) {
          ui.notifications.error(
            `Sword World 2.5 | The concealed Main Section of ${actor.name} could not be resolved; DEFEATED was NOT re-evaluated: ${String(error?.message ?? error)}`
          );
          return { ok: false, code: "concealed-selection-unavailable", changed: false, defeated: null };
        }
      } else {
        // Explicit Special with NO selected rule and no legacy special
        // identification: controlled unconfigured state. Never silently
        // resolved as Any — the GM must choose a rule first.
        ui.notifications.warn(
          `Sword World 2.5 | ${actor.name} has the Special policy but no special rule selected; DEFEATED was NOT re-evaluated. Choose a special rule in the Main Sections dialog.`
        );
        return { ok: false, code: "special-unconfigured", changed: false, defeated: null };
      }
    }
    const state = readMonsterSectionState(actor.system, sectionOptions);
    if (!state.sections.length) {
      return { ok: false, code: "no-hp", changed: false, defeated: null };
    }
    expected = state.incapacitated;
  } else {
    const characterHP = Number(foundry.utils.getProperty(actor, "system.hp.value"));
    if (!Number.isFinite(characterHP)) {
      return { ok: false, code: "no-hp", changed: false, defeated: null };
    }
    expected = characterHP <= 0;
  }

  if (syncingActors.has(actor)) {
    return { ok: false, code: "reentrancy", changed: false, defeated: null };
  }

  const statusId = defeatedStatusId();
  const current = actor.statuses?.has?.(statusId) === true;

  // No redundant writes: the state already matches, do nothing.
  if (current === expected) {
    return { ok: true, code: "in-sync", changed: false, defeated: expected };
  }

  syncingActors.add(actor);
  try {
    await actor.toggleStatusEffect(statusId, { active: expected, overlay: true });
    return {
      ok: true,
      code: expected ? "applied" : "removed",
      changed: true,
      defeated: expected
    };
  } catch (error) {
    console.warn("Sword World 2.5 | DEFEATED status sync failed:", error);
    return { ok: false, code: "error", changed: false, defeated: null };
  } finally {
    syncingActors.delete(actor);
  }
}

/**
 * Whether an `updateActor` payload touches any path this sync reacts to:
 * character HP, monster section HP (whole array, nested object, or dotted
 * per-row HP), the imported Main Section record, or the Main Section policy.
 *
 * The REAL v14 hook delivers the nested expanded data diff
 * (`{"system":{"mainSectionPolicy":"none"}}`); flat dotted forms are also
 * accepted for programmatic/headless callers. Either shape reacts.
 * @param {object} change - The (usually nested) update payload.
 * @returns {boolean}
 */
export function defeatedSyncRelevantChange(change) {
  if (change == null || typeof change !== "object") return false;
  const nestedSystem = typeof change.system === "object" && change.system !== null ? change.system : null;
  if (change["system.hp.value"] !== undefined) return true;
  if (change["system.combatStyles"] !== undefined) return true;
  if (change["system.mainSection"] !== undefined) return true;
  if (change["system.mainSectionPolicy"] !== undefined) return true;
  if (Object.keys(change).some(key => SECTION_HP_KEY.test(key))) return true;
  if (!nestedSystem) return false;
  // Nested (expanded) forms — the real hook shape.
  if (nestedSystem.hp !== undefined) return true;
  if (nestedSystem.combatStyles !== undefined) return true;
  if (nestedSystem.mainSection !== undefined) return true;
  if (nestedSystem.mainSectionPolicy !== undefined) return true;
  return false;
}

/**
 * Install the centralized `updateActor` listener driving the sync.
 *
 * Only updates that actually carry a relevant path trigger a sync attempt;
 * everything else is ignored without any read or write. GM-gated inside
 * `syncSw25DefeatedStatus` itself, so direct callers get the same authority
 * contract.
 * @returns {void}
 */
export function initializeDefeatedStatusSync() {
  Hooks.on("updateActor", (actor, change) => {
    if (!actor || !defeatedSyncRelevantChange(change)) return;
    syncSw25DefeatedStatus(actor);
  });
}
