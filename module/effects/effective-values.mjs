// Sword World 2.5 - Effective values pipeline (T3.2/T3.3).
//
// Single authority for the mechanical modifications of the system's
// persistent effects (DEC-28): the Actor's PREPARATION. Active effects of the
// system's `sw25Effect` subtype are processed inside the Actor preparation
// flow and produce a prepared modifier ledger; the base values remain stored
// intact and every calculation (sheets, items, rolls) consults the effective
// values read from that ledger. No consumer reconstructs effect modifiers on
// its own (invariant 5 of the research report; anti sw25-ru `_reprepareItems`).
//
// Directional flow (research §9.1, adapted to sw25-taka's existing
// architecture where the sheet's getData derives the displayed values):
//
//   installSw25EffectiveValues() patches `Actor#prepareData` once at init:
//
//   pre-step    prepareSw25EffectiveValues RESETS nothing before core — the
//               ledger is REPLACED (not accumulated) after core preparation,
//               so re-preparation can never double-count (DEC-28 criterion).
//   core        super.prepareData(): prepareBaseData → prepareEmbeddedDocuments
//               → native ActiveEffect application (other subtypes untouched —
//               the system's `sw25Effect` changes carry catalog keys that core
//               does not apply, so there is exactly ONE application path).
//   post-step   the active `sw25Effect` documents' `system.changes` are
//               resolved through EFFECT_TARGETS and accumulated over a fresh
//               ledger assigned to `actor.system.sw25EffectMods`. Unknown
//               keys, unsupported change types and reserved special targets
//               are diagnosed and skipped, never silently applied (T3.4).
//   consumers   sheet getData merges the ledger into its calculated values;
//               rolls read the effective ability bonuses and ledger entries;
//               items read the actor's prepared ledger at interaction time.
//
// Errors from malformed effect content NEVER break the Actor's preparation:
// the offending change/effect is skipped with a diagnostic (PF2e lesson).

import { SW25_EFFECT_SUBTYPE } from "./effect-model.mjs";
import { resolveSw25EffectTargetKey } from "./targets.mjs";
import { characterResourceMaximum } from "../rules/resources.mjs";

/**
 * Property under `actor.system` where the prepared ledger is exposed.
 * @type {string}
 */
export const SW25_EFFECT_MODS_KEY = "sw25EffectMods";

/**
 * Change types the pipeline applies within this block. Standard add/subtract
 * accumulate over the ledger. Every other change type (upgrade, override,
 * multiply, custom...) belongs to the central policy layer (DEC-37/DEC-44 —
 * no `maxOfGroup`, no provisional rules) and is diagnosed, not applied.
 * @type {Set<string>}
 */
export const APPLIED_SW25_CHANGE_TYPES = new Set(["add", "subtract"]);

/** Ledger ability keys (same names as the sheet's ability map). */
const LEDGER_ABILITIES = ["strength", "agility", "dexterity", "vitality", "intelligence", "spirit"];
const LEDGER_RESISTANCES = ["fortitude", "willpower"];
const LEDGER_COMBAT = ["accuracy", "evasion", "defense", "magicalDefense", "initiative", "magicPower", "additionalDamage"];
const LEDGER_RESOURCES = ["hpMax", "mpMax"];

/**
 * Build a fresh zero ledger with the full declared structure (arithmetic
 * groups always present; `skills` grows only when a skill check receives a
 * modifier). A fresh object per preparation makes the operation idempotent:
 * replacing the property can never accumulate previous results.
 * @returns {object}
 */
export function buildEmptySw25EffectLedger() {
  const zero = keys => Object.fromEntries(keys.map(key => [key, 0]));
  return {
    abilities: zero(LEDGER_ABILITIES),
    resistances: zero(LEDGER_RESISTANCES),
    combat: zero(LEDGER_COMBAT),
    resources: zero(LEDGER_RESOURCES),
    skills: {}
  };
}

/**
 * Write a numeric modifier onto a ledger path like "abilities.strength".
 * @param {object} ledger - Ledger object (mutated).
 * @param {string} path - Dot path declared by the catalog entry.
 * @param {number} amount - Signed amount to add.
 * @returns {boolean} false when the path does not exist in the ledger.
 */
function addToLedgerPath(ledger, path, amount) {
  const [group, key] = String(path).split(".");
  const holder = ledger[group];
  if (!holder || typeof holder !== "object") return false;
  holder[key] = Number(holder[key] ?? 0) + amount;
  return true;
}

/**
 * Read the prepared ledger of an actor (read-only view for consumers).
 * Actors prepared by the patched pipeline always carry the fresh structure;
 * unprepared actors/stubs get the zero structure.
 * @param {object} actor - Actor document or plain stub with `system`.
 * @returns {object} The prepared ledger.
 */
export function sw25EffectLedger(actor) {
  const ledger = actor?.system?.[SW25_EFFECT_MODS_KEY];
  return ledger && typeof ledger === "object" ? ledger : buildEmptySw25EffectLedger();
}

/**
 * Effective resource maximum for one actor: the base maximum (persisted
 * `system.hp.max` / `system.mp.max`, formula fallback for unsynced actors)
 * plus the active effect modifier for the resource (catalog targets
 * `resource.hpMax` / `resource.mpMax`).
 *
 * This is THE common accessor for consumers that write or clamp resource
 * values (rest, recovery items, gauge wheel): they must not reconstruct
 * base+modifier arithmetic on their own (single authority, DEC-28).
 *
 * @param {object} actor - Actor document (or stub) with `system` and `items`.
 * @param {"hp"|"mp"} resource - Resource to read.
 * @returns {number} The effective maximum, never negative.
 */
export function sw25EffectiveResourceMaximum(actor, resource) {
  if (resource !== "hp" && resource !== "mp") return 0;
  const base = characterResourceMaximum(actor, resource);
  const mod = sw25EffectModifier(actor, resource === "hp" ? "resource.hpMax" : "resource.mpMax");
  return Math.max(0, base + mod);
}

/**
 * Read one prepared modifier from the actor's ledger by catalog key.
 *
 * Consumers MUST use this accessor (or the ledger) instead of reading raw
 * ActiveEffect documents. Unknown keys warn and return 0: no consumer can
 * invent a target outside the catalog (T3.1 contract).
 *
 * @param {object} actor - Actor document (or stub) with a prepared ledger.
 * @param {string} key - Catalog key (e.g. "combat.defense").
 * @returns {number} The accumulated modifier (0 when none).
 */
export function sw25EffectModifier(actor, key) {
  const { ok, target } = resolveSw25EffectTargetKey(key);
  if (!ok || !target) {
    console.warn(`Sword World 2.5 | "${key}" is not a declared EFFECT_TARGETS destination; returning 0.`);
    return 0;
  }
  const ledger = sw25EffectLedger(actor);
  const [group, entry] = String(target.ledger).split(".");
  const value = Number(ledger[group]?.[entry] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Process the active system effects of one actor into the prepared ledger.
 *
 * Only `sw25Effect` documents participate (disabled ones are skipped; other
 * subtypes are never incorporated — native core handling covers them). Each
 * change entry is resolved through EFFECT_TARGETS:
 *   - known arithmetic target + add/subtract + finite value → accumulated;
 *   - reserved special target → diagnosed (`reserved-target`), never applied;
 *   - unknown key → diagnosed (`unknown-target`), never applied;
 *   - unsupported change type → diagnosed (`unsupported-change-type`);
 *   - non-numeric value → diagnosed (`unsupported-value`).
 *
 * @param {object} actor - Actor document or plain stub exposing `effects`
 *   (array or Foundry Collection with `contents`) and a writable `system`.
 * @returns {{ledger: object, diagnostics: Array<object>}} The fresh ledger
 *   (also assigned to `actor.system.sw25EffectMods`) and the diagnostics
 *   collected while processing.
 */
export function prepareSw25EffectiveValues(actor) {
  const ledger = buildEmptySw25EffectLedger();
  const diagnostics = [];
  if (!actor?.system || typeof actor.system !== "object") {
    return { ledger, diagnostics };
  }

  const effects = actor.effects instanceof Map
    ? [...actor.effects.values()]
    : Array.isArray(actor.effects)
      ? actor.effects
      : Array.isArray(actor.effects?.contents)
        ? actor.effects.contents
        : [];
  for (const effect of effects) {
    if (!effect || effect.type !== SW25_EFFECT_SUBTYPE) continue;
    if (effect.disabled === true) continue;
    const changes = Array.isArray(effect.system?.changes) ? effect.system.changes : [];
    for (const change of changes) {
      try {
        const diagnostic = applySw25EffectChange(ledger, change);
        if (diagnostic) diagnostics.push({ effectId: effect.id ?? null, effectName: effect.name ?? null, ...diagnostic });
      } catch (error) {
        diagnostics.push({ effectId: effect.id ?? null, effectName: effect.name ?? null, code: "processing-error", key: null, error: String(error?.message ?? error) });
      }
    }
  }

  // REPLACE the ledger: re-preparation replaces instead of accumulating
  // (DEC-28: modifiers never overwrite the stored base, and a fresh object
  // can never double-count across preparations).
  actor.system[SW25_EFFECT_MODS_KEY] = ledger;

  // Prepared (NOT persisted) effective resource maxima: base + ledger. Only
  // character actors carry the unified hp/mp maxima; other actor types keep
  // their own resource layout untouched. Consumers read
  // `actor.system.hp.maxEffective` / `actor.system.mp.maxEffective` (or the
  // sw25EffectiveResourceMaximum accessor) instead of re-deriving the sum.
  if (actor.type === "character") {
    for (const [resource, key] of [["hp", "hpMax"], ["mp", "mpMax"]]) {
      const holder = actor.system[resource];
      if (!holder || typeof holder !== "object") continue;
      const base = characterResourceMaximum(actor, resource);
      holder.maxEffective = Math.max(0, base + Number(ledger.resources?.[key] ?? 0));
    }
  }

  if (diagnostics.length > 0) {
    console.warn(`Sword World 2.5 | ${diagnostics.length} effect change(s) were not applied to "${actor.name ?? "?"}" (unknown targets, reserved special destinations or unsupported types).`);
  }
  return { ledger, diagnostics };
}

/**
 * Apply one change entry onto the ledger.
 * @param {object} ledger - Fresh ledger (mutated).
 * @param {object} change - `{ key, type, value }` change entry.
 * @returns {object|null} Diagnostic when the change is not applied.
 */
function applySw25EffectChange(ledger, change) {
  const key = change?.key ?? null;
  const { ok, code, target } = resolveSw25EffectTargetKey(key);
  if (!ok) {
    return { code: code === "reserved-target" ? "reserved-target" : "unknown-target", key, value: change?.value ?? null };
  }
  if (code === "reserved-target") {
    return { code: "reserved-target", key, value: change?.value ?? null };
  }
  if (!APPLIED_SW25_CHANGE_TYPES.has(change?.type)) {
    return { code: "unsupported-change-type", key, type: change?.type ?? null, value: change?.value ?? null };
  }
  const amount = Number(change?.value);
  if (!Number.isFinite(amount)) {
    return { code: "unsupported-value", key, value: change?.value ?? null };
  }
  const signed = change.type === "subtract" ? -amount : amount;
  if (!addToLedgerPath(ledger, target.ledger, signed)) {
    return { code: "unknown-ledger-path", key, value: change?.value ?? null };
  }
  return null;
}

// ── Installation into the Actor preparation flow ────────────────────────────

let installed = false;

/**
 * Install the effective-values step into the Actor preparation (once).
 *
 * Patches `foundry.documents.Actor.prototype.prepareData` with a wrapper that
 * runs the core preparation untouched (native ActiveEffect application for
 * other subtypes preserved — no duplication) and then processes the system's
 * `sw25Effect` documents into the prepared ledger. The wrapper never lets an
 * error from effect content break preparation.
 *
 * Wired from sw25.mjs `Hooks.once("init", ...)`. Idempotent; callable in
 * tests without a Foundry global (the patch is skipped there).
 *
 * @returns {boolean} true when the patch is (or already was) installed.
 */
export function installSw25EffectiveValues() {
  if (installed) return true;
  const actorProto = globalThis.foundry?.documents?.Actor?.prototype;
  if (!actorProto || typeof actorProto.prepareData !== "function") {
    console.warn("Sword World 2.5 | Actor preparation unavailable; effective values pipeline NOT installed.");
    return false;
  }
  const basePrepareData = actorProto.prepareData;
  actorProto.prepareData = function prepareDataWithEffectiveValues(...args) {
    const result = basePrepareData.apply(this, args);
    try {
      prepareSw25EffectiveValues(this);
    } catch (error) {
      console.error("Sword World 2.5 | Effective values preparation failed; actors keep unmodified values.", error);
    }
    return result;
  };
  installed = true;
  return true;
}
