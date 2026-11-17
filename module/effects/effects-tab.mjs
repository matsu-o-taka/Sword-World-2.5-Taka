// Sword World 2.5 - Effects tab data preparation and repair orchestration (T1.5).
//
// Pure, framework-independent preparation of the per-effect display data shown
// by the character sheet's Effects tab (DEC-48), plus the GM-only repair
// orchestration that delegates every write to the T1.3 repair contract.
//
// Separation of responsibilities:
//   - This module NEVER writes to documents from a render path. The only write
//     path is `repairActorSw25Effects`, which is GM-gated and delegates each
//     document to `repairSw25Effect` (module/effects/effect-repair.mjs) with
//     its full contract intact: no write when nothing changed, future schema
//     versions protected, irrecoverable data kept and reported (DEC-41).
//   - `repairActorEffects` (T1.3) deliberately sweeps ALL of an actor's effects
//     including native ones; the tab must only repair `sw25Effect` documents,
//     so it iterates and calls the per-document `repairSw25Effect` itself.
//   - The canonical name is reconstructed on demand from the persisted
//     `family` + `rank` through buildSw25CanonicalName (T1.4) — never stored,
//     never duplicated here (DEC-49).
//   - No stacking, expiry or EffectService logic belongs here: the tab is
//     read-only inspection; basic management writes wait for the future
//     EffectService write circuit (DEC-36) and are deliberately absent.
//
// The module is importable headless (no Foundry global is touched at import
// time; document globals are only accessed inside functions passed in by the
// caller).

import { buildSw25CanonicalName, sw25RankToRoman } from "./effect-identity.mjs";
import { normalizeSw25EffectSystem, SEVERITY_REVIEW, repairSw25Effect } from "./effect-repair.mjs";
import {
  SW25_EFFECT_SUBTYPE, SW25_DURATION_SCALES, SW25_COMBAT_DURATION_SCALES,
  SW25_ANCHOR_REGIMES, SW25_ANCHOR_EDGES, SW25_ANCHOR_STATES
} from "./effect-model.mjs";
import { sw25AnchorAvailability } from "./duration-engine.mjs";

/** The system's registered ActiveEffect subtype shown by the tab. */
export { SW25_EFFECT_SUBTYPE } from "./effect-model.mjs";

// ── Pure source reading ──────────────────────────────────────────────────────

/**
 * Read the persisted source data of one effect document without mutating it.
 *
 * Live ActiveEffect documents expose their clean source through `toObject()`
 * (verified in T1.3: `_source`-shaped, plain data). Plain stub objects (test
 * harnesses) expose their data directly. Both shapes are accepted.
 * @param {object} effect - Effect document or plain stub.
 * @returns {{system: object, duration: object|null, transfer: *,
 *   origin: string|null, img: string|null}}
 */
function readEffectSource(effect) {
  try {
    if (effect && typeof effect.toObject === "function") {
      const source = effect.toObject();
      if (source && typeof source === "object") {
        return {
          system: source.system && typeof source.system === "object" && !Array.isArray(source.system)
            ? structuredClone(source.system) : {},
          duration: source.duration && typeof source.duration === "object"
            ? structuredClone(source.duration) : null,
          transfer: source.transfer,
          origin: typeof source.origin === "string" ? source.origin : null,
          img: typeof source.img === "string" ? source.img : null
        };
      }
    }
  } catch {
    // Fall through to direct property access (plain stub objects).
  }
  const system = effect?.system;
  return {
    system: system && typeof system === "object" && !Array.isArray(system) ? structuredClone(system) : {},
    duration: effect?.duration && typeof effect.duration === "object" ? { ...effect.duration } : null,
    transfer: effect?.transfer,
    origin: typeof effect?.origin === "string" ? effect.origin : null,
    img: typeof effect?.img === "string" ? effect.img : null
  };
}

/**
 * Describe the duration bookkeeping of one effect (DEC-23), extended with the
 * full duration scale model (T5.2).
 *
 * Two clearly distinguished modes:
 *   - "rounds": the system's round-managed bookkeeping
 *     (`system.initialDuration` / `system.remainingDuration`, both nullable);
 *   - "turns": the turn-edge condition scale (no numeric count);
 *   - "minutes" / "hours" / "days": manual scales — GM-managed, no timers,
 *     no `worldTime`, no calendar expiry, no automation of any kind;
 *   - "permanent": permanent duration, no expiry;
 *   - "other": non-standard / non-normalized duration, no automation;
 *   - "native": the effect carries a native document duration (rounds, turns
 *     or seconds scale kept in the native `duration` field for display);
 *   - "none": the effect has no duration by rounds and no native duration
 *     value (indefinite / permanent).
 *
 * Only real document data is used; nothing is invented. Manual scales never
 * acquire automation. The prepared `effect.duration` (Foundry's
 * ActiveEffectDuration: `label`, `value`, `units`, `remaining`, `expired`)
 * is preferred for the native mode when the live document provides it; the
 * raw source duration is the fallback.
 *
 * When `scale` is a combat scale (`rounds`/`turns`), the returned `anchor`
 * carries the persisted `system.durationAnchor` (regime, edge, combatantId,
 * tokenId, state) so the caller can present anchor information.
 * @param {object} system - Persisted `system.*` payload.
 * @param {object|null} nativeDuration - Native duration data (prepared or raw).
 * @returns {{mode: string, label: string, title: string, scale: string|null,
 *   anchor: object|null}}
 */
function describeDuration(system, nativeDuration) {
  const scale = typeof system.durationScale === "string" && system.durationScale !== ""
    ? system.durationScale : null;
  const initial = typeof system.initialDuration === "number" ? system.initialDuration : null;
  const remaining = typeof system.remainingDuration === "number" ? system.remainingDuration : null;

  // Combat scale: rounds (system bookkeeping). A legacy effect without a
  // declared scale but with round counters is treated the same.
  if (scale === "rounds" || (scale === null && (initial !== null || remaining !== null))) {
    let label;
    if (remaining !== null && initial !== null) label = `Remaining ${remaining} of ${initial} rounds`;
    else if (remaining !== null) label = `Remaining ${remaining} rounds`;
    else if (initial !== null) label = `Initial ${initial} rounds`;
    else label = "Rounds";
    return {
      mode: "rounds",
      label,
      title: "Round-managed effect duration (system bookkeeping).",
      scale: "rounds",
      anchor: system.durationAnchor ?? null
    };
  }

  // Combat scale: turns (condition-based, no numeric counter).
  if (scale === "turns") {
    return {
      mode: "turns",
      label: "Turns",
      title: "Turn-edge condition duration (no numeric counter; expires at the anchor edge).",
      scale: "turns",
      anchor: system.durationAnchor ?? null
    };
  }

  // Manual scales: GM-managed, no timers, no `worldTime`, no calendar, no
  // automation of any kind.
  if (scale === "minutes") {
    return {
      mode: "minutes",
      label: "Minutes",
      title: "Manual duration (minutes). GM-managed; no automatic discounting or expiry.",
      scale: "minutes",
      anchor: null
    };
  }
  if (scale === "hours") {
    return {
      mode: "hours",
      label: "Hours",
      title: "Manual duration (hours). GM-managed; no automatic discounting or expiry.",
      scale: "hours",
      anchor: null
    };
  }
  if (scale === "days") {
    return {
      mode: "days",
      label: "Days",
      title: "Manual duration (days). GM-managed; no automatic discounting or expiry.",
      scale: "days",
      anchor: null
    };
  }
  if (scale === "permanent") {
    return {
      mode: "permanent",
      label: "Permanent",
      title: "Permanent duration; no expiry.",
      scale: "permanent",
      anchor: null
    };
  }
  if (scale === "other") {
    return {
      mode: "other",
      label: "Other",
      title: "Non-standard duration scale; no system automation.",
      scale: "other",
      anchor: null
    };
  }

  // Native duration: prefer the prepared ActiveEffectDuration, fall back to
  // the raw document scale (rounds / turns / seconds).
  const preparedValue = typeof nativeDuration?.value === "number" ? nativeDuration.value : null;
  const preparedLabel = typeof nativeDuration?.label === "string" && nativeDuration.label !== ""
    ? nativeDuration.label : null;
  if (preparedValue !== null) {
    return {
      mode: "native",
      label: preparedLabel ?? `${preparedValue} ${nativeDuration.units ?? ""}`.trim(),
      title: "Native document duration.",
      scale: typeof nativeDuration?.units === "string" ? nativeDuration.units : null,
      anchor: null
    };
  }
  const raw = nativeDuration ?? {};
  if (typeof raw.rounds === "number" && raw.rounds > 0) {
    return { mode: "native", label: `${raw.rounds} rounds`, title: "Native document duration.", scale: "rounds", anchor: null };
  }
  if (typeof raw.turns === "number" && raw.turns > 0) {
    return { mode: "native", label: `${raw.turns} turns`, title: "Native document duration.", scale: "turns", anchor: null };
  }
  if (typeof raw.seconds === "number" && raw.seconds > 0) {
    return { mode: "native", label: `${raw.seconds} seconds`, title: "Native document duration.", scale: "seconds", anchor: null };
  }
  return { mode: "none", label: "—", title: "No duration by rounds and no native duration (indefinite).", scale: null, anchor: null };
}

/**
 * Describe the activation state from native document truth. The live document
 * exposes the `active` getter (Foundry computes it); stub objects fall back to
 * the `disabled` field. Unknown state is displayed honestly as "—".
 * @param {object} effect - Effect document or stub.
 * @returns {{active: boolean|null, disabled: boolean, temporary: boolean|null, label: string}}
 */
function describeState(effect) {
  const disabled = effect?.disabled === true;
  const active = typeof effect?.active === "boolean" ? effect.active : (effect?.disabled === true ? false : null);
  const temporary = effect?.isTemporary === true ? true : (typeof effect?.isTemporary === "boolean" ? false : null);
  let label = "—";
  if (active === true) label = "Active";
  else if (disabled) label = "Disabled";
  else if (active === false) label = "Inactive";
  return { active, disabled, temporary, label };
}

/**
 * Resolve one UUID into a display label through the injected resolver.
 * The raw UUID is shown when the document cannot be resolved — the persisted
 * value is real document data and is never hidden or replaced by an invention.
 * @param {string|null} uuid
 * @param {Function|null} resolve
 * @returns {{label: string|null, uuid: string|null}}
 */
function describeUuid(uuid, resolve) {
  if (typeof uuid !== "string" || uuid === "") return { label: null, uuid: null };
  let name = null;
  if (typeof resolve === "function") {
    try {
      const resolved = resolve(uuid);
      if (typeof resolved?.name === "string" && resolved.name !== "") name = resolved.name;
    } catch {
      // Resolution failures degrade to the raw UUID; never throw from display.
    }
  }
  return { label: name ?? uuid, uuid };
}

/**
 * Build a human-readable label for one effect's `durationAnchor`, or null
 * when there is no anchor data. Pure presentation: nothing invented.
 * @param {object|null} anchor - The persisted `system.durationAnchor`.
 * @returns {string|null}
 */
function describeAnchorLabel(anchor) {
  if (!anchor || typeof anchor !== "object") return null;
  const parts = [];
  if (typeof anchor.regime === "string" && anchor.regime !== "") parts.push(anchor.regime);
  if (typeof anchor.edge === "string" && anchor.edge !== "") parts.push(anchor.edge);
  if (typeof anchor.combatantId === "string" && anchor.combatantId !== "") parts.push(`combatant ${anchor.combatantId}`);
  if (anchor.tokenId) parts.push(`token ${anchor.tokenId}`);
  if (typeof anchor.state === "string" && anchor.state !== "") parts.push(`state: ${anchor.state}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Full inspection description of one effect document (pure).
 *
 * Used both for the list rows (via `prepareSw25EffectRows`) and the individual
 * inspection dialog (`buildSw25EffectInspection`). Every field is read from
 * the real document; absent data stays null/"—" and is never invented.
 * @param {object} effect - Effect document or plain stub.
 * @param {Function|null} [resolve] - UUID → document/index-entry resolver.
 * @param {{combat?: Combat}} [options] - Optional combat encounter used to
 *   compute anchor availability (D5). When absent, availability is not
 *   computed and stays null.
 * @returns {object} Full display description.
 */
export function describeSw25Effect(effect, resolve = null, options = {}) {
  const source = readEffectSource(effect);
  const system = source.system;

  // T1.3 pure normalizer run as a READ-ONLY audit: identical logic the GM
  // repair applies, used here only to flag "needs review" rows. It performs
  // no write and no render path ever calls the repair layer implicitly.
  const audit = normalizeSw25EffectSystem(structuredClone(system));
  const reviewIssues = audit.issues.filter(issue => issue.severity === SEVERITY_REVIEW);

  const canonical = buildSw25CanonicalName(system.family ?? null, system.rank ?? null);
  const duration = describeDuration(system, source.duration ?? effect?.duration);
  const state = describeState(effect);
  const origin = describeUuid(source.origin, resolve);
  const caster = describeUuid(typeof system.casterUUID === "string" ? system.casterUUID : null, resolve);

  // Anchor presentation and availability (D5). Availability is only computed
  // when a combat encounter is supplied and the effect carries a combat
  // duration scale with an anchor.
  const anchor = system.durationAnchor ?? null;
  const anchorLabel = describeAnchorLabel(anchor);
  const anchorAvailability = options.combat && anchor
    && typeof system.durationScale === "string"
    && SW25_COMBAT_DURATION_SCALES.includes(system.durationScale)
    ? sw25AnchorAvailability(options.combat, anchor)
    : null;

  const changes = Array.isArray(system.changes)
    ? system.changes.map(change => ({
      key: typeof change?.key === "string" ? change.key : null,
      type: typeof change?.type === "string" ? change.type : null,
      value: change?.value ?? null,
      phase: typeof change?.phase === "string" ? change.phase : null,
      priority: typeof change?.priority === "number" ? change.priority : null
    }))
    : [];

  return {
    id: effect?.id ?? null,
    name: effect?.name ?? null,
    img: source.img,
    // Canonical name (T1.4): presentation reconstructed from family + rank.
    // When the persisted data cannot reconstruct it, the document's own name
    // is shown instead (real document data; nothing invented) and the row is
    // flagged for review by the audit above.
    canonicalName: canonical,
    displayName: canonical ?? effect?.name ?? "(unnamed effect)",
    family: typeof system.family === "string" ? system.family : null,
    rank: typeof system.rank === "number" ? system.rank : null,
    rankRoman: sw25RankToRoman(system.rank ?? null),
    // Precomputed display labels: Handlebars treats 0 as falsy, but SV 0 is a
    // legitimate value (DEC-6, minor-action casting) and remaining/initial 0
    // rounds are meaningful bookkeeping (DEC-23). Null stays "—".
    successValueLabel: typeof system.successValue === "number" ? String(system.successValue) : "—",
    initialDurationLabel: typeof system.initialDuration === "number" ? `${system.initialDuration} rounds` : "—",
    remainingDurationLabel: typeof system.remainingDuration === "number" ? `${system.remainingDuration} rounds` : "—",
    rankLabel: typeof system.rank === "number" && system.rank > 0
      ? `${sw25RankToRoman(system.rank)} (${system.rank})` : "—",
    successValue: typeof system.successValue === "number" ? system.successValue : null,
    effectType: typeof system.effectType === "string" ? system.effectType : null,
    // Presentation visibility (gmOnly): the row consumers decide whether to
    // list the effect (players never see gmOnly effects in the tab).
    gmOnly: system.gmOnly === true,
    // Duration bookkeeping (DEC-23), native duration, and the full scale
    // model (T5.2): manual scales never acquire automation.
    initialDuration: typeof system.initialDuration === "number" ? system.initialDuration : null,
    remainingDuration: typeof system.remainingDuration === "number" ? system.remainingDuration : null,
    durationMode: duration.mode,
    durationLabel: duration.label,
    durationTitle: duration.title,
    durationScale: duration.scale,
    nativeDuration: source.duration ?? effect?.duration ?? null,
    // Anchor (T5.2): regime, edge, combatantId, tokenId, state. Only combat
    // scales (`rounds`/`turns`) carry an anchor; manual scales never do.
    durationAnchor: anchor,
    anchorLabel,
    anchorAvailable: anchorAvailability?.available ?? null,
    anchorUnavailableReason: anchorAvailability?.reason ?? null,
    // Provenance (DEC-49: metadata, never identity).
    originUUID: origin.uuid,
    originName: origin.label,
    casterUUID: caster.uuid,
    casterName: caster.label,
    // Activation state (native truth).
    active: state.active,
    disabled: state.disabled,
    temporary: state.temporary,
    transfer: source.transfer === true ? true : (source.transfer === false ? false : null),
    stateLabel: state.label,
    // Mechanical changes.
    changes,
    // Read-only audit result (T1.3 contract, no write).
    needsReview: reviewIssues.length > 0 || audit.futureVersion,
    futureVersion: audit.futureVersion,
    reviewDetails: reviewIssues.map(issue => issue.detail)
  };
}

/**
 * Prepare the list rows of the Effects tab (pure).
 *
 * ONLY `sw25Effect` documents are listed: native effects of other subtypes are
 * invisible to the tab and are never mixed with the system's managed effects.
 *
 * Presentation visibility (gmOnly): effects carrying `system.gmOnly === true`
 * are listed ONLY when `options.includeGmOnly` is true — `prepareSw25EffectsTab`
 * passes the viewing user's GM state there. This is strictly presentation-layer
 * filtering: the underlying ActiveEffect documents are never removed or hidden
 * from the collection, and GM-side mechanical consumers (duration engine,
 * effective values, repair) read them directly and keep working.
 * @param {Array<object>} effects - Effect documents (or plain stubs) to list.
 * @param {Function|null} [resolve] - UUID → document/index-entry resolver.
 * @param {{includeGmOnly?: boolean, combat?: Combat}} [options] - `includeGmOnly`
 *   lists `system.gmOnly` effects too (GM view). Default false (player view).
 *   `combat` is an optional combat encounter used to compute anchor
 *   availability (D5) for combat-scale effects.
 * @returns {{rows: Array<object>, needsReviewCount: number, futureCount: number}}
 */
export function prepareSw25EffectRows(effects, resolve = null, options = {}) {
  const includeGmOnly = options?.includeGmOnly === true;
  const rows = [];
  let needsReviewCount = 0;
  let futureCount = 0;
  for (const effect of Array.isArray(effects) ? effects : []) {
    if (!effect || effect.type !== SW25_EFFECT_SUBTYPE) continue;
    const description = describeSw25Effect(effect, resolve, options);
    if (description.gmOnly === true && !includeGmOnly) continue;
    rows.push({
      id: description.id,
      name: description.name,
      img: description.img,
      displayName: description.displayName,
      // Identity and Success Value fields for programmatic consumers (the
      // EffectService read APIs): the UI rows only ever show the labels.
      family: description.family,
      rank: description.rank,
      successValue: description.successValue,
      successValueLabel: description.successValueLabel,
      gmOnly: description.gmOnly,
      // Duration (T5.2): full scale model, manual scales without automation.
      durationMode: description.durationMode,
      durationLabel: description.durationLabel,
      durationTitle: description.durationTitle,
      durationScale: description.durationScale,
      // Anchor (T5.2): only combat scales carry an anchor.
      durationAnchor: description.durationAnchor,
      anchorLabel: description.anchorLabel,
      anchorAvailable: description.anchorAvailable,
      anchorUnavailableReason: description.anchorUnavailableReason,
      originUUID: description.originUUID,
      originLabel: description.originName,
      casterLabel: description.casterName,
      stateLabel: description.stateLabel,
      needsReview: description.needsReview,
      futureVersion: description.futureVersion,
      reviewDetails: description.reviewDetails
    });
    if (description.needsReview) needsReviewCount++;
    if (description.futureVersion) futureCount++;
  }
  return { rows, needsReviewCount, futureCount };
}

// ── Native status row (DEFEATED) ─────────────────────────────────────────────

/**
 * Build the display row for the native Foundry DEFEATED status when it is
 * active on the actor, `null` otherwise.
 *
 * Pure: reads only `actor.statuses`, the status definition and (guarded)
 * core i18n. The DEFEATED status is a NATIVE Foundry status applied by the
 * HP sync (module/actor/defeated-status.mjs) — it is deliberately shown
 * without SV, duration, anchor or stacking information (it has none) and
 * without an inspect/management affordance: nothing in the tab can or
 * should manage it. Its display never creates or references an
 * `sw25Effect` document.
 * @param {Actor} actor - Actor whose sheet renders the tab.
 * @returns {object|null} Row: `{id, name, displayName, img, stateLabel,
 *   native: true}`, or null when DEFEATED is not active.
 */
export function describeSw25NativeStatus(actor) {
  const statusId = globalThis.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
  if (actor?.statuses?.has?.(statusId) !== true) return null;
  const definition = globalThis.CONFIG?.statusEffects?.[statusId] ?? {};
  let displayName = "Defeated";
  try {
    const localized = globalThis.game?.i18n?.localize?.(definition.name ?? "");
    if (typeof localized === "string" && localized !== "") displayName = localized;
  } catch { /* Headless environments degrade to the fallback label. */ }
  return {
    id: `native-status:${statusId}`,
    name: definition.name ?? statusId,
    displayName,
    img: definition.img ?? "icons/svg/skull.svg",
    stateLabel: "Active",
    native: true
  };
}

// ── Tab context preparation (sheet-facing) ───────────────────────────────────

/**
 * Prepare the full Effects-tab context for the character sheet's `getData`.
 *
 * This is the only non-pure wrapper: it reads `actor.effects` and resolves
 * UUIDs synchronously through `foundry.utils.fromUuidSync` (official v14 API:
 * resolves world documents and compendium index entries). Every display value
 * itself is still computed by the pure functions above.
 * @param {Actor} actor - The actor whose sheet renders the tab.
 * @param {boolean} isGM - Whether the viewing user is the GM. Players never
 *   see `system.gmOnly` effects (presentation filtering); the GM does.
 * @returns {{rows: Array, nativeStatusRow: object|null, needsReviewCount: number,
 *   futureCount: number, canRepair: boolean, reviewNote: string|null}}
 */
export function prepareSw25EffectsTab(actor, isGM) {
  const resolve = uuid => {
    if (typeof uuid !== "string" || uuid === "") return null;
    try {
      return foundry.utils.fromUuidSync?.(uuid) ?? null;
    } catch {
      return null; // Unresolvable UUIDs degrade to their raw value in display.
    }
  };
  const { rows, needsReviewCount, futureCount } = prepareSw25EffectRows(
    actor?.effects ? [...actor.effects] : [], resolve,
    { includeGmOnly: isGM === true, combat: game.combat ?? null }
  );

  // Native DEFEATED status row (HP sync): presented above the persistent
  // `sw25Effect` rows when active. Read-only, no management, no duration
  // data — see `describeSw25NativeStatus`.
  const nativeStatusRow = describeSw25NativeStatus(actor);

  let reviewNote = null;
  if (isGM === true && needsReviewCount > 0) {
    reviewNote = futureCount > 0
      ? `${needsReviewCount} effect(s) need review; ${futureCount} of them were written by a newer schema version and repair is refused until the system is updated. Inspect the flagged rows for details.`
      : `${needsReviewCount} effect(s) have data needing review — inspect the flagged rows or run Repair Data.`;
  }

  return {
    rows,
    nativeStatusRow,
    needsReviewCount,
    futureCount,
    canRepair: isGM === true,
    reviewNote
  };
}

/**
 * Attach the Concealed Main Section selection label to its list row (pure).
 *
 * Monster-sheet adaptation of the shared Effects section: the GM must be able
 * to identify WHICH combat section the concealed rule currently selected, so
 * the row of the concealed effect carries a readable badge instead of a bare
 * "Concealed Main Section" name. The presentation argument is the GM-only
 * sync state from `getConcealedMainSectionPresentation`
 * (module/combat/concealed-main-section.mjs): it is already "none" for
 * non-GM callers, so the label can never reach a player's render. Rows are
 * mutated in place (the preparation above produced them fresh); a
 * presentation without a matching row id (or any "none" state) touches
 * nothing.
 * @param {Array<object>} rows - Prepared rows from `prepareSw25EffectRows`.
 * @param {{status: "none"|"assigned"|"error", section: string|null,
 *   sectionId: string|null, effectId: string|null, code: string|null,
 *   message: string|null}} presentation - Sync presentation state.
 * @returns {Array<object>} The same rows (mutated in place when applicable).
 */
export function attachSw25ConcealedSelectionLabel(rows, presentation) {
  if (!Array.isArray(rows) || !presentation || presentation.status === "none") return rows;
  const row = rows.find(candidate => candidate?.id === presentation.effectId);
  if (!row) return rows;
  row.sectionSelectionLabel = presentation.status === "assigned"
    ? `Currently: ${presentation.section}`
    : "Selection unresolved";
  row.sectionSelectionTitle = presentation.status === "assigned"
    ? "Section chosen by this monster's Concealed Main Section rule (the selection is GM-only)."
    : (presentation.message ?? "The concealed selection is unresolvable; re-save the rule in the Main Sections dialog.");
  return rows;
}

/**
 * Build a synthetic Effects-tab row revealing a Bestiary copy's discovered
 * concealed Main Section.
 *
 * Bestiary copies do not carry the concealed ActiveEffect (it lives only on
 * the original monster), so there is no effect row to attach a label to.
 * Instead we fabricate a read-only row carrying the discovered section name,
 * surfaced to ALL viewers — the Bestiary copy grants OBSERVER ownership and
 * the discovered section is player-facing knowledge.
 *
 * Pure: returns a row object compatible with `effectsTab.rows`, or null when
 * no section is disclosed.
 * @param {string|null} section - The discovered section name, or null.
 * @returns {object|null} A row compatible with `effectsTab.rows`, or null.
 */
export function buildSw25BestiaryConcealedSectionRow(section) {
  if (!section || typeof section !== "string" || section === "") return null;
  return {
    id: "bestiary-concealed-main-section",
    name: "Concealed Main Section",
    img: "icons/svg/magic.svg",
    displayName: "Concealed Main Section",
    sectionSelectionLabel: `Revealed: ${section}`,
    sectionSelectionTitle: "The discovered Main Section for this species, revealed through a successful Monster Knowledge Weakness discovery.",
    successValueLabel: "—",
    durationLabel: "—",
    durationTitle: "No duration.",
    originLabel: "—",
    originUUID: null,
    stateLabel: "Active",
    needsReview: false,
    futureVersion: false
  };
}

/**
 * Prepare the individual inspection dialog context (pure; UI framework free).
 * @param {object} effect - Effect document or plain stub.
 * @param {Function|null} [resolve] - UUID → document/index-entry resolver.
 * @param {{combat?: Combat}} [options] - Optional combat encounter used to
 *   compute anchor availability (D5).
 * @returns {object} Inspection context (see `describeSw25Effect`).
 */
export function buildSw25EffectInspection(effect, resolve = null, options = {}) {
  return describeSw25Effect(effect, resolve, options);
}

// ── GM-only repair orchestration (the tab's single write path) ───────────────

/**
 * Repair every `sw25Effect` of one actor through the T1.3 per-document
 * contract (GM-only).
 *
 * Deliberately NOT `repairActorEffects`: that helper sweeps ALL effects —
 * including native ones — and would write `system.schemaVersion` onto effect
 * documents outside the system's subtype. The tab filters to `sw25Effect`
 * documents first and repairs each one individually, so every write goes
 * through `repairSw25Effect` with its contract intact (GM authority, no write
 * when nothing changed, future versions protected, irrecoverable data kept
 * and reported). Non-GM callers receive a refusal and nothing is written.
 * @param {Actor} actor - The actor whose system effects are repaired.
 * @returns {Promise<{ok: boolean, code: string?, results: Array,
 *   repaired: number, refused: number, total: number}>}
 */
export async function repairActorSw25Effects(actor) {
  if (game?.user?.isGM !== true) {
    return { ok: false, code: "not-gm", results: [], repaired: 0, refused: 0, total: 0 };
  }
  if (!actor?.effects) {
    return { ok: false, code: "no-actor", results: [], repaired: 0, refused: 0, total: 0 };
  }
  const targets = [...actor.effects].filter(effect => effect.type === SW25_EFFECT_SUBTYPE);
  const results = [];
  for (const effect of targets) {
    const result = await repairSw25Effect(effect);
    results.push({ effectId: effect.id ?? null, effectName: effect.name ?? null, ...result });
  }
  return {
    ok: results.every(result => result.ok),
    results,
    repaired: results.filter(result => result.code === "repaired").length,
    refused: results.filter(result => !result.ok).length,
    total: targets.length
  };
}
