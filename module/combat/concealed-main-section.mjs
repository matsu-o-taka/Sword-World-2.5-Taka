// Sword World 2.5 - Concealed Main Section (ActiveEffect-based).
//
// Replaces the Journal-based concealed main section storage with an
// ActiveEffect persisted via EffectService. Three distinct responsibilities:
//
//   - Candidate configuration (Actor config): which sections are eligible
//     for the concealed role. All sections included by default; GM may
//     exclude individually. Persisted on the actor with a real write
//     (`actor.update`) — section names are public monster data, so this
//     part is not secret.
//
//   - Random selection (this module): one uniform pick from the active
//     candidates per monster instance, once, cryptographically random.
//
//   - Selection persistence (this module, plaintext): the chosen section id
//     is stored UNENCRYPTED in the concealed effect's flags and the effect
//     carries `system.gmOnly: true`.
//
// Visibility model (the agreed `gmOnly` presentation model):
//
//   - The concealed effect is a normal system-managed ActiveEffect written
//     through EffectService (the only authorized write path, GM authority).
//   - Its `system.gmOnly: true` makes the system's own effect interfaces
//     (Effects tab rows, the inspector) list and open it ONLY for GM users:
//     `prepareSw25EffectRows` filters it out for players and the sheet's
//     inspect listener refuses non-GM access.
//   - This is presentation-layer hiding, NOT data protection: the document
//     (flags and all) still replicates to every client like any other
//     ActiveEffect, and a player deliberately inspecting the raw replicated
//     data could read the section id. The GM accepted this trade-off
//     explicitly ("no encryption, use a flag").
//   - The mechanical consumers (DEFEATED sync, knowledge checks, the GM
//     dialog) are GM-side and read the effect document directly, exactly as
//     before; players never read the selection through our code.
//   - Every unresolvable state is an EXPLICIT error — never null, never a
//     fallback, never an automatic re-roll: a removed/excluded section is
//     "selection-invalid"; a malformed record (including a legacy ENCRYPTED
//     record from the previous implementation) is "record-invalid" and is
//     replaced only by an explicit new selection.

import { applySw25Effect, removeSw25Effect } from "../effects/effect-service.mjs";
import { SW25_EFFECT_SUBTYPE } from "../effects/effect-model.mjs";
import { normalizeSpeciesId, speciesId } from "../knowledge/mk-identity.mjs";

/** Stable stacking family of the concealed selection effect. */
export const CONCEALED_EFFECT_FAMILY = "Concealed Main Section";

/** Effect flag namespace and key that carry the plaintext selection record. */
export const CONCEALED_FLAG_NAMESPACE = "sw25-taka";
export const CONCEALED_FLAG_RECORD_KEY = "concealedSection";

/**
 * Explicit failure of the concealed selection layer. `code` lets consumers
 * distinguish an invalid selection from a malformed record without ever
 * guessing. (Replaces the former ConcealedSectionSecretError of the removed
 * encryption module; the codes are GM-facing diagnostics only.)
 */
export class ConcealedSectionError extends Error {
  /**
   * @param {string} code - One of: "record-invalid", "selection-invalid".
   * @param {string} message - GM-facing description.
   */
  constructor(code, message) {
    super(message);
    this.name = "ConcealedSectionError";
    this.code = code;
  }
}

const STATE_KEY = "concealedMainSection";
const EFFECT_FAMILY = CONCEALED_EFFECT_FAMILY;
const CONFIG_KEY = "concealedMainSectionConfig";
const CONFIG_VERSION = 1;
const MIN_CANDIDATES = 2;

const normalized = value => String(value ?? "").trim().toLowerCase();

// ── Combat style rows ──────────────────────────────────────────────────
//
// Foundry v14 persists embedded combat-style collections as an object with
// numeric keys (`{"0": {...}, "1": {...}}`), never as a real array. Normalise
// both shapes so the concealed module works with live actor data as well as
// with the plain-array fixtures used by headless tests.

function styleRows(system) {
  const styles = system?.combatStyles;
  if (Array.isArray(styles)) return styles;
  if (!styles || typeof styles !== "object") return [];
  return Object.entries(styles)
    .map(([, row]) => row)
    .sort((a, b) => {
      const ai = Number(a._index ?? a.id ?? 0);
      const bi = Number(b._index ?? b.id ?? 0);
      return ai - bi;
    });
}

/**
 * All HP-bearing sections of a monster. This is the public candidate pool:
 * any section with a usable HP value can be a concealed main section. No
 * dependence on creature name, source, Cursed Artist, or specific section
 * names/IDs.
 * @param {Actor} actor - The monster actor.
 * @returns {Array<{id: string|null, section: string, hp: number}>}
 */
export function getConcealedMainSectionSections(actor) {
  const system = actor?.system;
  if (actor?.type !== "monster" || !system) return [];
  return styleRows(system)
    .map(row => ({
      id: row?.id ?? null,
      section: String(row?.section ?? row?.sectionLabel ?? "").trim(),
      hp: Number(row?.hp?.value)
    }))
    .filter(row => row.section && Number.isFinite(row.hp));
}

// ── Candidate configuration (Actor-level, public, REALLY persisted) ────

function readConfig(actor) {
  const system = actor?.system;
  if (!system) return null;
  const raw = system[CONFIG_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.version !== CONFIG_VERSION) return null;
  return {
    version: raw.version,
    excluded: Array.isArray(raw.excluded) ? [...raw.excluded].map(String) : []
  };
}

/**
 * Read the persisted candidate configuration from the actor. A null or
 * malformed configuration reads as the documented default (all sections
 * included); it never silently reverts an existing selection.
 * @param {Actor} actor - The monster actor.
 * @returns {{version: number, excluded: string[]}|null}
 */
export function getConcealedMainSectionConfig(actor) {
  return readConfig(actor);
}

/**
 * Set the candidate configuration on the actor through a real persisted
 * write (`actor.update`). Validates that at least MIN_CANDIDATES sections
 * remain active after exclusions. Changing the configuration never rerolls
 * an existing selection: the selection effect is untouched here.
 * @param {Actor} actor - The monster actor.
 * @param {{excluded: string[]}} config - Sections to exclude by id.
 * @returns {Promise<{version: number, excluded: string[]}>} The persisted config.
 */
export async function setConcealedMainSectionConfig(actor, { excluded } = {}) {
  if (!actor || actor.type !== "monster") {
    throw new Error("Concealed Main Section config requires a monster actor.");
  }
  const allSections = getConcealedMainSectionSections(actor);
  const excludedIds = new Set(Array.isArray(excluded) ? excluded.map(String) : []);
  const active = allSections.filter(section => !excludedIds.has(section.id ?? ""));
  if (active.length < MIN_CANDIDATES) {
    throw new Error(
      `At least ${MIN_CANDIDATES} candidate sections are required for the concealed Main Section feature; ${active.length} remain.`
    );
  }
  const config = { version: CONFIG_VERSION, excluded: [...excludedIds] };
  // Real database write (audit §4 fix): the previous in-memory mutation
  // never reached `_source` and reverted silently on every reload.
  await actor.update({ [`system.${CONFIG_KEY}`]: config });
  return config;
}

/**
 * Return the currently active candidates (all HP-bearing sections minus GM
 * exclusions). Computed dynamically from system.combatStyles and the config.
 * @param {Actor} actor - The monster actor.
 * @returns {Array<{id: string|null, section: string}>}
 */
export function getActiveCandidates(actor) {
  const config = readConfig(actor);
  const excludedIds = new Set(config?.excluded ?? []);
  return getConcealedMainSectionSections(actor)
    .filter(section => !excludedIds.has(section.id ?? ""))
    .map(section => ({ id: section.id, section: section.section }));
}

/**
 * Return candidates with exclusion status, for the shared policy dialog.
 * @param {Actor} actor - The monster actor.
 * @returns {Array<{id: string|null, section: string, excluded: boolean}>}
 */
export function concealedSelectionCandidates(actor) {
  const config = readConfig(actor);
  const excludedIds = new Set(config?.excluded ?? []);
  return getConcealedMainSectionSections(actor).map(section => ({
    id: section.id,
    section: section.section,
    excluded: excludedIds.has(section.id ?? "")
  }));
}

// ── Selection via ActiveEffect (EffectService) ─────────────────────────
//
// The ActiveEffect is the persistent per-instance record. Its flags carry
// the plaintext selection record (`{ sectionId }`) — hidden from players by
// the effect's `system.gmOnly: true` presentation flag, NOT by encryption
// (the agreed trade-off; see the module header). The effect is written only
// through EffectService, so it remains a normal system-managed effect the
// GM can inspect and manage in the Effects tab.

function cryptoRandomIndex(length) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("A secure random source is unavailable for concealed Main Section selection.");
  }
  const range = 0x100000000;
  const limit = Math.floor(range / length) * length;
  const values = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(values); while (values[0] >= limit);
  return values[0] % length;
}

/**
 * Find the concealed Main Section effect on an actor, if any.
 * @param {Actor} actor - The monster actor.
 * @returns {object|null} The sw25Effect document, or null.
 */
function findConcealedEffect(actor) {
  if (!actor?.effects) return null;
  return [...actor.effects].find(
    effect => effect.type === SW25_EFFECT_SUBTYPE && effect.system?.family === EFFECT_FAMILY
  ) ?? null;
}

function candidateMatch(candidates, sectionId) {
  return candidates.find(
    section => section.id === sectionId || normalized(section.section) === normalized(sectionId)
  ) ?? null;
}

/**
 * Synchronous GM-facing presentation state of the concealed Main Section.
 *
 * The read-only twin of `getConcealedMainSectionSelection` for render paths
 * (sheet `getData`) that cannot await: it reads the SAME plaintext record
 * with the SAME explicit-state policy, but reports unresolvable states as
 * data instead of throwing. GM-only: non-GM callers receive "none" without
 * reading anything (identical gate to the async reader).
 *   - "none"     → no selection effect, a legacy marker effect without a
 *                  record, or a non-GM/non-monster caller.
 *   - "assigned" → a valid selection; `section`/`sectionId` are populated.
 *   - "error"    → malformed/legacy-encrypted record ("record-invalid") or
 *                  removed/excluded section ("selection-invalid"); `code`
 *                  and `message` carry the explicit state. Never a fallback,
 *                  never a re-roll (same contract as the async reader).
 * @param {Actor} actor - The monster actor.
 * @returns {{status: "none"|"assigned"|"error", section: string|null,
 *   sectionId: string|null, effectId: string|null, code: string|null,
 *   message: string|null}}
 */
export function getConcealedMainSectionPresentation(actor) {
  if (game?.user?.isGM !== true || actor?.type !== "monster") {
    return { status: "none", section: null, sectionId: null, effectId: null, code: null, message: null };
  }
  const effect = findConcealedEffect(actor);
  if (!effect) {
    return { status: "none", section: null, sectionId: null, effectId: null, code: null, message: null };
  }
  const record = effect.flags?.[CONCEALED_FLAG_NAMESPACE]?.[CONCEALED_FLAG_RECORD_KEY];
  if (!record) {
    // Legacy marker effect without any selection record: controlled "no
    // valid selection" state; an explicit Special save replaces the marker
    // with a real record.
    return { status: "none", section: null, sectionId: null, effectId: effect.id ?? null, code: null, message: null };
  }
  if (typeof record !== "object" || Array.isArray(record)
    || typeof record.sectionId !== "string" || record.sectionId === "") {
    const message = `The concealed Main Section record of ${actor.name} is malformed (or is a legacy encrypted record from the previous implementation). Re-save the rule in the Main Sections dialog to replace it.`;
    return { status: "error", section: null, sectionId: null, effectId: effect.id ?? null, code: "record-invalid", message };
  }
  const match = candidateMatch(getActiveCandidates(actor), record.sectionId);
  if (!match) {
    const message = `The concealed Main Section selection of ${actor.name} is no longer valid (the selected section was removed or excluded). The controlled invalid state is preserved; no automatic re-selection.`;
    return { status: "error", section: null, sectionId: null, effectId: effect.id ?? null, code: "selection-invalid", message };
  }
  return { status: "assigned", section: match.section, sectionId: match.id, effectId: effect.id ?? null, code: null, message: null };
}

/**
 * Read the concealed Main Section selection.
 *
 * GM-only: non-GM callers receive null without ever reading the record.
 * Resolves the PLAINTEXT record stored in the effect flags and validates the
 * section against the current candidates. Every unresolvable state is an
 * EXPLICIT error — never null, never a fallback, never a re-roll:
 *   - malformed record (or a legacy ENCRYPTED record from the previous
 *     implementation) → "record-invalid"
 *   - section removed/excluded → "selection-invalid"
 * @param {Actor} actor - The monster actor.
 * @returns {Promise<{section: string, sectionId: string}|null>} null only
 *   when there is no selection effect at all (feature not activated), or for
 *   a legacy marker effect without any record (the next explicit Special
 *   save replaces it).
 */
export async function getConcealedMainSectionSelection(actor) {
  const presentation = getConcealedMainSectionPresentation(actor);
  if (presentation.status === "assigned") {
    return { section: presentation.section, sectionId: presentation.sectionId };
  }
  if (presentation.status === "error") {
    throw new ConcealedSectionError(presentation.code, presentation.message);
  }
  return null;
}

/**
 * Assign (or explicitly change) the concealed Main Section via an
 * ActiveEffect. GM-only. Removes any existing concealed effect first,
 * maintaining a single stable selection per actor. The selection is
 * persisted as a PLAINTEXT record in the effect flags, and the effect is
 * created with `system.gmOnly: true` (players never see it in the system's
 * effect interfaces). Triggers a DEFEATED status re-sync. Every persistence
 * failure propagates: a failed write is never reported as success.
 * @param {Actor} actor - The monster actor being configured.
 * @param {string} sectionName - The section name to assign.
 * @returns {Promise<{section: string, sectionId: string}>}
 */
export async function setConcealedMainSectionSelection(actor, sectionName) {
  if (game?.user?.isGM !== true) throw new Error("Only a GM can select a concealed Main Section.");
  if (!actor || actor.type !== "monster") throw new Error("Concealed Main Section requires a monster actor.");

  const candidates = getActiveCandidates(actor);
  const chosen = candidateMatch(candidates, sectionName);
  if (!chosen || normalized(chosen.section) !== normalized(sectionName)) {
    throw new Error(`${actor.name} does not have an active candidate section named "${sectionName ?? ""}".`);
  }

  // Remove any existing concealed selection effect to maintain one stable
  // identity per actor (no contradictory selections).
  const existing = findConcealedEffect(actor);
  if (existing) {
    const removed = await removeSw25Effect(actor, existing.id);
    if (!removed?.ok) {
      throw new Error(`The previous concealed Main Section effect of ${actor.name} could not be removed (${removed?.code ?? "unknown"}).`);
    }
  }

  // Persist the plaintext selection record inside the effect via
  // EffectService (the only authorized write path). The record is hidden
  // from players by the effect's gmOnly presentation flag, not by
  // encryption (presentation-layer trade-off; see the module header).
  const result = await applySw25Effect(actor, {
    family: EFFECT_FAMILY,
    rank: 0,
    cast: { mode: "minor" },
    gmOnly: true,
    flags: { [CONCEALED_FLAG_NAMESPACE]: { [CONCEALED_FLAG_RECORD_KEY]: { sectionId: String(chosen.id) } } }
  });

  if (!result.ok) {
    throw new Error(`The concealed Main Section selection of ${actor.name} could not be persisted: ${result.error || "unknown write failure"}`);
  }

  // Re-run the DEFEATED sync so incapacitation follows the new selection.
  try {
    const sync = await import("../actor/defeated-status.mjs");
    await sync.syncSw25DefeatedStatus(actor);
  } catch (error) {
    console.warn("Sword World 2.5 | Concealed-section change could not re-sync the DEFEATED status", error);
  }

  return { section: chosen.section, sectionId: chosen.id };
}

/**
 * Auto-random selection once per instance. Picks uniformly from the active
 * candidates using a cryptographically secure random source. Stable: an
 * existing, resolvable selection is returned as-is — opening the sheet,
 * preparing the actor, unrelated updates, saves and reloads never reroll.
 * A failed persistence operation propagates (the feature never reports
 * success without a persisted record), and an existing but UNRESOLVABLE
 * selection is an explicit invalid state — never replaced automatically.
 * @param {Actor} actor - The monster actor.
 * @param {Function} [randomIndex] - Random index provider (default: crypto).
 * @returns {Promise<{section: string, sectionId: string}>}
 */
export async function selectConcealedMainSection(actor, randomIndex = cryptoRandomIndex) {
  if (game?.user?.isGM !== true) throw new Error("Only a GM can select a concealed Main Section.");
  // Stable identity: if a selection already exists and can be resolved,
  // return it without re-rolling (auto-random selection happens once per
  // instance). If it exists but cannot be resolved, the read throws the
  // explicit invalid state — no replacement selection is generated.
  const existingEffect = findConcealedEffect(actor);
  if (existingEffect) {
    const existing = await getConcealedMainSectionSelection(actor);
    if (existing) return existing;
    // null here means a legacy marker effect without any selection record; the
    // fresh selection below replaces it (explicit GM action path only).
  }
  const candidates = getActiveCandidates(actor);
  if (candidates.length < MIN_CANDIDATES) {
    throw new Error(
      `${actor.name} has fewer than ${MIN_CANDIDATES} candidate sections; the concealed Main Section cannot be activated.`
    );
  }
  const index = randomIndex(candidates.length);
  if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
    throw new Error("Concealed Main Section selection returned an invalid index.");
  }
  return setConcealedMainSectionSelection(actor, candidates[index].section);
}

// ── Monster Knowledge check ────────────────────────────────────────────

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Resolve a concealed Main Section knowledge check for a token.
 * GM-only. Reveals the selected section on success. An unresolvable selection
 * never reveals and never fabricates a section: the GM is notified.
 * @param {object} token - The token whose actor has the concealed selection.
 * @param {number} successValue - The knowledge check success value.
 * @param {boolean} [criticalFailure] - Whether the roll was a critical failure.
 * @returns {Promise<{status: string, section?: string, weakPoint?: string}>}
 */
export async function resolveConcealedMainSectionKnowledgeCheck(token, successValue, criticalFailure = false) {
  if (!game.user.isGM) throw new Error("Only a GM can resolve a concealed Main Section.");
  const actor = token?.actor;
  if (!getConcealedMainSectionSections(actor).length) return { status: "not-applicable" };
  if (criticalFailure) return { status: "not-revealed" };
  const success = finiteNumber(successValue);
  const weakness = finiteNumber(actor?.system?.weakness);
  if (success === null || weakness === null) {
    throw new Error(`${token.name} has an invalid Monster Knowledge success or Weakness value.`);
  }
  if (success < weakness) return { status: "not-revealed" };

  let selection = null;
  try {
    selection = await getConcealedMainSectionSelection(actor);
  } catch (error) {
    ui.notifications.error(
      `Sword World 2.5 | The concealed Main Section of ${actor?.name ?? "the target"} could not be resolved; the knowledge check reveals nothing: ${String(error?.message ?? error)}`
    );
    return { status: "not-revealed" };
  }
  if (!selection) return { status: "not-revealed" };

  return {
    status: "revealed",
    section: selection.section,
    weakPoint: String(actor?.system?.weakPoint ?? "")
  };
}

// ── Hooks ──────────────────────────────────────────────────────────────

/**
 * Initialize concealed Main Section support:
 *   - updateActor: when combatStyles change, validate the current selection
 *     is still resolvable; unresolvable states notify the GM (controlled
 *     state, never a re-selection).
 *
 * The former client-scope key setting of the encryption implementation is
 * gone with it (no key exists anymore). Candidate configuration needs no
 * seeding hook: new monsters get the field from template.json and an absent
 * config reads as the documented default (all sections included); the GM
 * dialog persists it with a real write when the GM saves Special.
 */
export function initializeConcealedMainSection() {
  if (game?.user?.isGM !== true) return;

  Hooks.on("updateActor", async (actor, change) => {
    if (actor?.type !== "monster") return;
    const changeStr = JSON.stringify(change ?? {});
    if (!/combatStyles/.test(changeStr)) return;
    if (!findConcealedEffect(actor)) return;
    try {
      await getConcealedMainSectionSelection(actor);
    } catch (error) {
      ui.notifications.warn(
        `Sword World 2.5 | The concealed Main Section state of ${actor.name} could not be validated: ${String(error?.message ?? error)}`
      );
    }
  });
}

// ── End of module ──────────────────────────────────────────────────────

// Re-exported so other modules (e.g. mk-identity) share a single authority.
export { normalizeSpeciesId, speciesId };
