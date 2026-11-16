/**
 * Unified persistence for the character resource maxima (HP and MP).
 *
 * Both maxima are derived values (Adventurer Level × 3 + Vitality for HP;
 * wizard class levels × 3 + Spirit for MP — see `module/rules/resources.mjs`)
 * that are persisted on the actor (`system.hp.max` / `system.mp.max`) so
 * Foundry's native consumers — the token bar attributes declared in
 * `system.json` (`primaryTokenAttribute: "hp"`,
 * `secondaryTokenAttribute: "mp"`) — and any macro or integration can read
 * them directly.
 *
 * Policy (extends DEC-28 to the resource maxima):
 *   - The persisted maximum is ALWAYS the base maximum: effect modifiers
 *     never overwrite it. Effects that change a maximum apply on top through
 *     the effect ledger (`resource.hpMax` / `resource.mpMax` targets) as the
 *     effective maximum (see `sw25EffectiveResourceMaximum`).
 *   - Persistence is event-driven (lifecycle hooks), never a render side
 *     effect: the sheet's `getData` derives the maxima for presentation only.
 *   - A persistent maximum DECREASE clamps the current value to the new
 *     effective maximum (values that still fit are conserved). A persistent
 *     INCREASE never touches the current value.
 *   - A temporary effective-maximum decrease (effect) never destroys the
 *     current value: when the effect expires the maximum returns with no
 *     points lost. Writers (rest, recovery, gauge wheel) clamp against the
 *     effective maximum instead.
 *   - Natural Power MP (module/rules/spell-damage.mjs) intentionally stays
 *     unclamped: the spell grants temporary MP above the maximum that is
 *     lost at the end of the caster's turn (SW2.0/2.5 Natural Power rule,
 *     sw25.wikidot.com/spell:natural-power).
 *
 * Hook `change` shapes: the real v14 `updateActor` hook delivers the nested
 * expanded data diff (`{"system": {"abilityBases": {"body": 7}}}`); flat
 * dotted forms (`{"system.abilityBases.body": 7}`) occur from programmatic
 * callers. The change detector accepts both shapes (same convention as
 * `module/actor/defeated-status.mjs`).
 */

import { characterHPMaximum, characterMPMaximum } from "../rules/resources.mjs";
import { sw25EffectModifier } from "../effects/effective-values.mjs";

/**
 * Actor `system` keys whose change alters the maxima formulas.
 * @type {string[]}
 */
const FORMULA_SYSTEM_KEYS = ["abilityBases", "abilityAdjustments"];

/** Flat dotted-path form of the same keys (programmatic update callers). */
const FLAT_SYSTEM_PATTERN = /^system\.(abilityBases|abilityAdjustments)(\.|$)/;

/**
 * Item types whose change alters the maxima formulas (class levels/type,
 * racial ability adjustments).
 * @type {string[]}
 */
const FORMULA_ITEM_TYPES = ["class", "race"];

/* ═══════════════════════════ computation ═══════════════════════════ */

/**
 * Computes both base maxima from the actor's current source data.
 *
 * @param {object} actor Actor document (or stub) with `system` and `items`.
 * @returns {{hp: number, mp: number}} Non-negative base maxima.
 */
export function computeCharacterMaxima(actor) {
  const system = actor?.system ?? {};
  const items = actor?.items ?? [];
  return {
    hp: Math.max(0, Number(characterHPMaximum(system, items)) || 0),
    mp: Math.max(0, Number(characterMPMaximum(system, items)) || 0)
  };
}

/**
 * Effect-ledger modifier for one resource maximum.
 *
 * @param {object} actor Actor document (or stub) with a prepared ledger.
 * @param {"hp"|"mp"} resource Resource to read.
 * @returns {number}
 */
function resourceEffectMod(actor, resource) {
  return sw25EffectModifier(actor, resource === "hp" ? "resource.hpMax" : "resource.mpMax");
}

/**
 * Effective maximum for one resource from an explicit base (used by the
 * decrease clamp, where the base is the NEW computed maximum, not the
 * stored one).
 *
 * @param {object} actor Actor document (or stub).
 * @param {"hp"|"mp"} resource Resource.
 * @param {number} base Base maximum to apply the modifiers onto.
 * @returns {number} Non-negative effective maximum.
 */
function effectiveMaximumFromBase(actor, resource, base) {
  return Math.max(0, Math.max(0, Number(base) || 0) + resourceEffectMod(actor, resource));
}

/* ═══════════════════════════ change detection ═══════════════════════════ */

/**
 * Whether an `updateActor` change payload touches any data the maxima
 * formulas consume. Accepts the nested expanded diff (the real v14 hook
 * shape) and flat dotted paths (programmatic callers); anything else —
 * including HP/MP value writes and flag updates — is irrelevant.
 *
 * @param {object} changes Update delta handed to the `updateActor` hook.
 * @returns {boolean}
 */
export function maximaSyncRelevantChange(changes) {
  if (!changes || typeof changes !== "object") return false;
  for (const key of Object.keys(changes)) {
    if (key === "system") {
      /* Whole-system replacement or nested diff: search the subtree. */
      if (touchesFormulaKeys(changes.system, 0)) return true;
    } else if (FLAT_SYSTEM_PATTERN.test(key)) {
      return true;
    }
  }
  return false;
}

/**
 * Recursive search for formula keys inside a nested (expanded) diff.
 *
 * @param {object} node Diff node.
 * @param {number} depth Guard against pathological payloads.
 * @returns {boolean}
 */
function touchesFormulaKeys(node, depth) {
  if (!node || typeof node !== "object" || Array.isArray(node) || depth > 3) return false;
  for (const [key, value] of Object.entries(node)) {
    if (FORMULA_SYSTEM_KEYS.includes(key)) return true;
    if (touchesFormulaKeys(value, depth + 1)) return true;
  }
  return false;
}

/* ═══════════════════════════ synchronization ═══════════════════════════ */

/**
 * Recomputes both base maxima for a character and persists them when they
 * differ from the stored values. Writes only on a real diff (idempotent —
 * the write itself fires `updateActor` again, but the new payload carries
 * no formula keys so the listener never re-syncs: no loops).
 *
 * @param {object} actor Actor document.
 * @returns {Promise<boolean>} true when an update was written.
 */
export async function syncActorMaxima(actor) {
  if (!actor || actor.type !== "character" || !actor.isOwner) return false;
  const computed = computeCharacterMaxima(actor);
  const updates = {};
  for (const resource of ["hp", "mp"]) {
    const stored = Math.max(0, Number(actor.system?.[resource]?.max ?? 0) || 0);
    const target = computed[resource];
    if (target === stored) continue;
    updates[`system.${resource}.max`] = target;
    /* Persistent decrease: clamp the current value to the new EFFECTIVE
       maximum; a value that still fits is conserved. Persistent increase
       never modifies the current value. */
    if (stored > target) {
      const current = Number(actor.system?.[resource]?.value);
      if (Number.isFinite(current) && current > target) {
        const cap = effectiveMaximumFromBase(actor, resource, target);
        if (current > cap) updates[`system.${resource}.value`] = cap;
      }
    }
  }
  if (Object.keys(updates).length === 0) return false;
  /* Re-render open sheets only when a value was clamped (the input boxes
     show `system.*.value`); a maximum-only write needs no render because the
     sheet derives the displayed maxima on its own. */
  const clamped = Object.keys(updates).some(key => key.endsWith(".value"));
  await actor.update(updates, clamped ? {} : { render: false });
  return true;
}

/* ═══════════════════════════ lifecycle wiring ═══════════════════════════ */

let initialized = false;

/**
 * Registers the lifecycle hooks that keep both maxima persisted and in sync,
 * plus the GM-side initial migration. Called once from the system `init`
 * hook. Idempotent and safe to call in Node tests without a Hooks global
 * (returns false there).
 *
 * Triggers:
 *   - `updateActor` with `system.abilityBases` / `system.abilityAdjustments`
 *     changes (nested or flat key shapes).
 *   - `createItem` / `updateItem` / `deleteItem` for `class` and `race` items
 *     on a character (level changes, class add/remove, racial adjustments).
 *
 * @param {object} [hooks] Hooks implementation; defaults to the Foundry global.
 * @returns {boolean} true when the hooks were (or already had been) registered.
 */
export function initializeResourceMaxima(hooks = globalThis.Hooks) {
  if (initialized) return true;
  if (!hooks || typeof hooks.on !== "function" || typeof hooks.once !== "function") return false;
  initialized = true;

  hooks.on("updateActor", (actor, changes) => {
    if (!maximaSyncRelevantChange(changes)) return;
    syncActorMaxima(actor).catch(error => {
      console.warn("Sword World 2.5 | Resource maxima sync failed", error);
    });
  });

  const itemListener = item => {
    const parent = item?.parent ?? item?.actor;
    if (!parent || parent.type !== "character") return;
    if (!FORMULA_ITEM_TYPES.includes(item.type)) return;
    syncActorMaxima(parent).catch(error => {
      console.warn("Sword World 2.5 | Resource maxima sync failed", error);
    });
  };
  hooks.on("createItem", itemListener);
  hooks.on("updateItem", itemListener);
  hooks.on("deleteItem", itemListener);

  hooks.once("ready", () => {
    migrateResourceMaxima().catch(error => {
      console.warn("Sword World 2.5 | Resource maxima migration failed", error);
    });
  });
  return true;
}

/**
 * Initial migration: recompute and persist both maxima for every existing
 * character actor. Corrects actors whose `system.mp.max` is missing or zero
 * (the MP maximum was never persisted before this unification) and any
 * stale `system.hp.max`, without losing data (values are only clamped on a
 * persistent decrease).
 *
 * Runs on the active GM client only: the GM owns every actor, so one client
 * writes and every other client receives the same idempotent update through
 * the regular document-sync path.
 *
 * @param {Iterable<object>} [actors] Actor collection; defaults to game.actors.
 * @returns {Promise<number>} How many actors actually needed a write.
 */
export async function migrateResourceMaxima(actors = globalThis.game?.actors) {
  if (!actors || !globalThis.game?.user?.isGM) return 0;
  let count = 0;
  for (const actor of actors) {
    if (actor?.type !== "character") continue;
    try {
      if (await syncActorMaxima(actor)) count += 1;
    } catch (error) {
      console.warn(`Sword World 2.5 | Resource maxima migration failed for "${actor?.name ?? actor?.id ?? "?"}"`, error);
    }
  }
  if (count > 0) console.log(`Sword World 2.5 | Resource maxima migration synced ${count} character(s).`);
  return count;
}
