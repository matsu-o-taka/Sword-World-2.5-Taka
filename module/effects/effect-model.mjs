// Sword World 2.5 - ActiveEffect type data model (effects engine foundations).
//
// The system's persistent effects are native Foundry ActiveEffect documents with
// their system-specific data stored under `system.*`, per the approved effects
// architecture (see reports/sw25-effects-stacking-design-decisions.md,
// DEC-1..DEC-52; persistence criteria in DEC-49, schema versioning in DEC-41).
//
// This module defines ONLY the type data model class. The subtype is
// registered in sw25.mjs (Hooks.once("init")) under
// `CONFIG.ActiveEffect.dataModels["sw25Effect"]`, and the subtype key is
// declared in system.json `documentTypes.ActiveEffect`. The model is active
// at runtime: every `sw25Effect` ActiveEffect carries `effect.system` as an
// instance of this class.
//
// Registration mechanism verified against the installed Foundry v14 client and
// the official v14 API documentation (see reports/sw25-t1-0-...):
//   - The model class MUST extend `foundry.data.ActiveEffectTypeDataModel`
//     (the documented exception to TypeDataModel for ActiveEffect subtypes).
//   - `ActiveEffectTypeDataModel.defineSchema()` already defines the native
//     `changes` ArrayField (key/type/value/phase/priority). This subclass
//     spreads the parent schema so the native changes structure is preserved
//     untouched; it must NOT be redefined here.
//   - The document-level schema of BaseActiveEffect already carries the native
//     `duration` (EffectDurationData), `start` (EffectStartData: combat /
//     combatant / initiative / round / turn / time) and `origin`
//     (DocumentUUIDField) fields. This model deliberately does NOT duplicate
//     any of them: the native `origin` document field IS the effect's source
//     document UUID, and turn anchoring details stay pending until the
//     duration/expiry integration design (T5.0) is done.
//
// Deliberately absent fields (each with its DEC reference):
//   - `stackKey`, duplicated `canonicalName` — DEC-49: `family` is the only
//     stacking identity; the canonical name is reconstructed from
//     family + rank, never stored twice.
//   - `stackable`, `replaceOnRecast`, `survivesCombatEnd` — DEC-49: stacking
//     outcomes come from the central policies and duration rules, not from
//     per-effect booleans.
//   - `casterIsMinorPrep` — DEC-49: the casting mode is decided during the
//     casting process and its result is already reflected in `successValue`.
//   - `instantX` marker — DEC-49: the ActiveEffect of an Instant/X spell only
//     represents the persistent queue; the immediate part is resolved during
//     casting.
//   - custom anchor fields — DEC-51: RESOLVED by the T5.0-R consolidation
//     (D1–D12): the system duration scale and the combat anchor are modeled by
//     the additive `durationScale`/`durationAnchor` fields below (T5.2), which
//     REPLACE the previously pending "casterTurn"/"targetTurn"/"anchor" ideas.
//     The native document `duration` field is NEVER populated with a finite
//     `value` or an `expiry` for system effects (native isolation, D1/D6/D11);
//     `duration.units` may carry presentation-only data.

/**
 * Schema version of the sw25 effect data model. The first real schema version
 * is 1 (DEC-41); any later incompatible change to the persisted structure or
 * semantics introduces a new sequential version.
 * @type {number}
 */
export const SW25_EFFECT_SCHEMA_VERSION = 1;

/**
 * The system's registered ActiveEffect subtype. Lives next to its data model
 * so low-level modules (catalog, effective values) can reference the subtype
 * without importing UI modules; `effects-tab.mjs` re-exports it.
 * @type {string}
 */
export const SW25_EFFECT_SUBTYPE = "sw25Effect";

// ── Duration scale and combat anchor (Bloque 5, T5.2) ───────────────────────
// Approved by the T5.0-R consolidation (D1–D12; design in
// reports/sw25-t5.0-r-duration-design-consolidation.md §3.1/§3.3/§3.5).

/**
 * Approved duration scale ids (T5.2). `rounds` is the combat scale counted in
 * rounds (DEC-23 bookkeeping: initial/remaining duration in rounds); `turns`
 * is the turn-edge condition scale for feat/Riesgo conditions (no numeric
 * count — the expiry condition lives in the anchor regime/edge, not in a
 * counter); the remaining scales are MANUAL (GM-managed, no timers, no
 * `worldTime`/`dawn`/calendar) and never require a combat anchor.
 * @type {string[]}
 */
export const SW25_DURATION_SCALES = [
  "rounds", "turns", "minutes", "hours", "days", "permanent", "other"
];

/**
 * The subset of duration scales that REQUIRE a combat anchor (`durationAnchor`)
 * at application time (D4). Manual scales are deliberately excluded.
 * @type {string[]}
 */
export const SW25_COMBAT_DURATION_SCALES = ["rounds", "turns"];

/**
 * The unified NON-COMBAT time counter units (minutes / hours / days). An
 * effect on one of these scales carries its single editable remaining amount
 * in `initialDuration` / `remainingDuration`, expressed in that unit (DEC-23
 * bookkeeping under GM management: no timers, no `worldTime`, no calendar,
 * no automatic expiry). Rounds are a SEPARATE combat-only representation and
 * never share this counter.
 * @type {string[]}
 */
export const SW25_TIME_DURATION_SCALES = ["minutes", "hours", "days"];

/**
 * Minutes per unit of each unified time scale: 60 minutes = 1 hour,
 * 24 hours = 1 day (1440 minutes). Unit edits convert mathematically, so the
 * equivalent duration is preserved.
 * @type {Record<string, number>}
 */
export const SW25_TIME_SCALE_UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 };

/**
 * Combat-entry threshold (strictly below): an effect whose non-combat
 * remaining duration is under this many minutes converts to counted rounds
 * when combat starts; at or above it the effect stays on the time counter.
 * @type {number}
 */
export const SW25_COMBAT_ENTRY_THRESHOLD_MINUTES = 10;

/**
 * Combat rounds per minute (1 round = 10 seconds → 1 minute = 6 rounds).
 * Shared by the combat-entry conversion (minutes → rounds, ×6) and the
 * combat-end conversion (rounds → minutes, ÷6).
 * @type {number}
 */
export const SW25_ROUNDS_PER_MINUTE = 6;

/**
 * Seconds per combat round (Sword World 2.5: 1 round = 10 seconds). Shared by
 * the Instant/X out-of-combat fallback identity (`system.sourceDuration`) and
 * the combat-entry conversion of seconds-based effects (seconds → rounds, ÷10).
 * @type {number}
 */
export const SW25_SECONDS_PER_ROUND = 10;

/**
 * Approved anchor regimes (D5/T5.0-R §3.3): `casterTurn` is the DEFAULT
 * regime for round-scale spells; `targetTurn` is the exceptional regime used
 * only when a concrete rule requires it; `roundEnd` is the degradation regime
 * for when the anchor combatant can no longer act (degradation itself is
 * processed by the T5.3 engine — the field structure only represents it).
 * @type {string[]}
 */
export const SW25_ANCHOR_REGIMES = ["casterTurn", "targetTurn", "roundEnd"];

/**
 * Approved anchor edges: which edge of the anchor's turn the expiry condition
 * refers to ("begin" is the approved default, e.g. "until the beginning of
 * the declarer's next turn"). Evaluation of the edge belongs to T5.3.
 * @type {string[]}
 */
export const SW25_ANCHOR_EDGES = ["begin", "end"];

/**
 * Approved anchor states: `resolved` (the anchor combatant is already known:
 * `combatantId` is present) and `deferred` (the anchor combatant will be
 * resolved at the first relevant turn edge — reserved for the future
 * preparation flow, consolidation §3.5; ordinary applications never use it).
 * @type {string[]}
 */
export const SW25_ANCHOR_STATES = ["resolved", "deferred"];

// ── Cancellation identity (Bloque 6, T6.1) ─────────────────────────────────
// Casting instance identity and target scope for the forced-removal rules
// (DEC-7/DEC-8; CR I pp. 166-167). `family` + `rank` remains the ONLY stacking
// identity (DEC-1/DEC-16): `castId` identifies one CASTING of the source, so
// two castings of the same spell stay distinguishable even when they share a
// family, and every Actor-side representation of one area spell shares the id.

/**
 * Approved Success Value provenance ids (T6.1, DEC-7). The stored
 * `successValue` alone cannot answer the forced-removal questions:
 *   - `check`:     an ordinary Spellcasting/Skill check produced the value.
 *   - `automatic`: the originating check was an automatic success (natural
 *                  double 6); the stored value ALREADY includes the +5 bonus
 *                  (DEC-6), and the effect can still be cancelled by exceeding
 *                  that value or by an automatic success (CR I p. 166).
 *   - `fixed`:     a fixed/passive value supplied by the source (no roll).
 *   - `none`:      no check was made for the originating action (Minor Action
 *                  / Combat Preparation casting); SV 0 is the legitimate value.
 * null means "not recorded" (legacy effects): the Success Value provenance is
 * unknown, so cancellation must re-determine the value at removal time
 * (CR I p. 167) instead of silently substituting zero.
 * @type {string[]}
 */
export const SW25_SUCCESS_VALUE_SOURCES = ["check", "automatic", "fixed", "none"];

/**
 * Approved target-scope ids of a casting (T6.1, CR I pp. 161-162/167):
 *   - `space`:   `Target: X area (YY radius)/Space` — ONE global effect for
 *                the whole area; cancelling it removes every Actor-side
 *                representation of that casting.
 *   - `all`:     `/All` — an individual effect on each affected character.
 *   - `limited`: `/Z` — an individual effect on each of the Z characters.
 * null means the casting has no area selection mode (individual targets) or
 * the scope was not recorded; cancellation then treats the effect as an
 * individual one and never groups it with other effects.
 * @type {string[]}
 */
export const SW25_EFFECT_SCOPES = ["space", "all", "limited"];

/**
 * Type data model for the system's persistent ActiveEffects.
 *
 * Instance shape once registered (T1.2): every effect document created with the
 * system's subtype carries `effect.system` as an instance of this class.
 */
// Load-safety shim (same pattern as side-initiative.mjs `SideTurnApplication`):
// the class extension evaluates `foundry.data` at MODULE LOAD time. In the
// production client the real base class is always used; in headless test
// environments that do not mock `foundry.data` the model degrades to a plain
// subclass so the effects module chain stays importable (T5.3: the duration
// engine chain now reaches this module from side-initiative.mjs). The schema
// (`defineSchema`) is untouched by this shim.
const Sw25EffectBaseClass = globalThis.foundry?.data?.ActiveEffectTypeDataModel ?? class ActiveEffectBaseStub {};

export class SW25EffectModel extends Sw25EffectBaseClass {

  /** @inheritdoc */
  static defineSchema() {
    const fields = foundry.data.fields;
    return {
      // Native changes structure inherited from ActiveEffectTypeDataModel:
      // { key, type, value, phase, priority }. The `key` will reference
      // EFFECT_TARGETS catalog entries (DEC-44) once the catalog lands;
      // conflicts between changes are resolved by the central stacking
      // policies (DEC-37/DEC-44), never by per-change flags.
      ...super.defineSchema(),

      // ── Schema versioning ────────────────────────────────────────────────
      // DEC-41: first real version is 1; migrations (later versions) will be
      // sequential, deterministic and idempotent.
      schemaVersion: new fields.NumberField({
        required: true, nullable: false, integer: true, initial: SW25_EFFECT_SCHEMA_VERSION
      }),

      // ── Stacking identity ────────────────────────────────────────────────
      // DEC-1/DEC-16: `family` is the ONLY stacking identity: the family's
      // canonical base name as authored (e.g. "Protection"), without any rank
      // numeral. Comparison never uses the stored spelling directly: the
      // stable rule key (lowercase / NFKD / no diacritics — DEC-1) is derived
      // at comparison time by normalizeSw25FamilyKey
      // (module/effects/effect-identity.mjs) and is NEVER persisted (DEC-49:
      // no duplicated `canonicalName`/`familyKey`/`stackKey` field). The full
      // canonical name ("Protection II") is presentation, reconstructed from
      // family + rank by buildSw25CanonicalName. No `rank`, `sourceType`,
      // `sourceUUID` or `casterUUID` participates in the identity.
      family: new fields.StringField({
        required: true, nullable: false, blank: false
      }),
      // DEC-1: parsed Roman numeral (0 = no numeral). Hierarchy label, never
      // part of the stacking identity (DEC-49).
      rank: new fields.NumberField({
        required: true, nullable: false, integer: true, min: 0, initial: 0
      }),

      // ── Success Value ────────────────────────────────────────────────────
      // DEC-6: the SV belongs to the effect's own data and is preserved for the
      // effect's whole life. 0 is a legitimate value (minor-action casting);
      // the +5 critical bonus is part of the value itself, never a flag.
      successValue: new fields.NumberField({
        required: true, nullable: false, integer: true, initial: 0
      }),
      // T6.1/DEC-7: provenance of the stored Success Value
      // (SW25_SUCCESS_VALUE_SOURCES). Additive optional field, schema stays v1
      // (DEC-41). null = "not recorded": a legacy effect whose value cannot be
      // trusted as a re-derivable SV, so forced removal re-determines it at
      // cancellation time (CR I p. 167) rather than treating it as 0. A
      // recorded "none"/"check"/"fixed"/"automatic" source makes the stored
      // numeric value authoritative, INCLUDING a legitimate 0.
      successValueSource: new fields.StringField({
        required: false, nullable: true, blank: false, initial: null
      }),

      // ── Casting instance identity and target scope (Bloque 6, T6.1) ──────
      // DEC-7/DEC-8 (CR I pp. 166-167): `castId` groups every effect created
      // by ONE casting (across every receiving Actor) without participating
      // in the stacking identity. Two castings of the same spell therefore
      // keep separate `castId`s even when their family/rank coincide.
      // `effectScope` records the target selection mode of that casting
      // (SW25_EFFECT_SCOPES) so forced removal can apply the area rule:
      // `/Space` is ONE global effect removed with all its representations;
      // `/All` and `/Z` stay individual per character. Both are additive
      // optional fields, schema stays v1 (DEC-41); null = not recorded.
      castId: new fields.StringField({
        required: false, nullable: true, blank: false, initial: null
      }),
      effectScope: new fields.StringField({
        required: false, nullable: true, blank: false, initial: null
      }),

      // ── Duration bookkeeping ─────────────────────────────────────────────
      // DEC-23: effects whose duration is managed by a counted scale keep an
      // initial effective duration and a remaining duration; the application
      // order is derivable from the elapsed time. Both are nullable: null
      // means the effect is NOT counted (manual scales — minutes/hours/days/
      // permanent — stay under manual GM management, DEC-39/DEC-42 — and the
      // native document `duration` field keeps the original scale for
      // display).
      // The values are expressed in the unit of `durationScale`: combat
      // rounds for rounds/turns-counted effects (integral there, enforced at
      // the service layer), MINUTES for minute-managed ones. The combat-end
      // conversion (purgeSw25CombatDurationEffects) writes fractional minutes
      // (rounds ÷ 6, e.g. 17 → 2.8333…), so the schema accepts any finite
      // value ≥ 0; no expiry logic belongs to the schema (DEC-45: expiry runs
      // through EffectService; integration designed in T5.0).
      initialDuration: new fields.NumberField({
        required: false, nullable: true, min: 0, initial: null
      }),
      remainingDuration: new fields.NumberField({
        required: false, nullable: true, min: 0, initial: null
      }),

      // ── Provenance ───────────────────────────────────────────────────────
      // DEC-49: provenance metadata for identification, inspection and specific
      // rules; NEVER a stacking identity criterion.
      // `sourceUUID` is intentionally absent: the native document-level
      // `origin` field (DocumentUUIDField in BaseActiveEffect) carries the
      // emitting document's UUID.
      // `casterUUID` has no native equivalent: who cast the effect (used later
      // for caster-turn anchoring and minor-action cancellation).
      casterUUID: new fields.DocumentUUIDField({
        required: false, nullable: true, initial: null
      }),

      // ── Normative classification ─────────────────────────────────────────
      // DEC-9/DEC-10: optional normative effect classification, distinct from
      // the Damage Type and from the document-level technical `type` (the
      // registered subtype). Not every effect needs one.
      effectType: new fields.StringField({
        required: false, nullable: true, blank: false, initial: null
      }),

      // ── Cancellation eligibility (DEC-7 / §55) ──────────────────────────
      // Stored answers for the forced-removal rules (Dispel Magic,
      // Wordbreak), never inferred from names at cancellation time.
      // `isMagical` distinguishes confirmed magical effects (true) from
      // non-magical or unconfirmed effects (false): Dispel Magic can only
      // target true, while Wordbreak accepts both. The field is always a
      // boolean; legacy absent/null values normalize to false through the
      // existing repair path, and the schema initial covers loading before
      // that repair runs. Additive field, schema stays v1.
      isMagical: new fields.BooleanField({
        required: true, nullable: false, initial: false
      }),
      // The emitting effect's Resistance notation (the approved resistance id,
      // e.g. "cant"), stored as provenance of the source. It is NOT an
      // intrinsic defensive property of the applied effect (DEC-15): the
      // resistance resolution happened on the emitter side and its outcome
      // already travelled as the `resisted` transport boolean. It is NOT a
      // cancellation-eligibility condition either (T6.1 correction): CR I
      // p. 264 prints no `Resistance: Can't` exclusion for Wordbreak, so
      // neither Dispel Magic nor Wordbreak consults this field.
      resistance: new fields.StringField({
        required: false, nullable: true, blank: false, initial: null
      }),

      // ── Stacking policy family (Bloque 4, T4.4) ──────────────────────────
      // DEC-3 (contract note): the stacking-policy classification of this
      // effect ("spell", "feat", "technique", "stratagem", "spellsong",
      // "aspect", "weaponEnchant"). It is NOT an identity field (DEC-1/16/44:
      // `family` remains the only stacking identity): it selects WHICH central
      // policy the resolver applies to interactions of this effect. DEC-3
      // "Implementación inicial: solo `spell` usa este flujo": absent/null is
      // treated as "spell" by the resolver. Persisted because the resolver
      // must classify the actor's EXISTING effects too, not only the incoming
      // application; additive optional field, schema stays v1 (DEC-41).
      familyPolicy: new fields.StringField({
        required: false, nullable: true, blank: false, initial: null
      }),

      // ── Damage Type (DEC-9/DEC-20) ───────────────────────────────────────
      // Two-dimensional classification of the damage the effect produces:
      // `nature` ("Physical"|"Magical", optional here — not every effect
      // damages) and `attribute` (e.g. "Fire", "Lightning", "Poison"). The
      // weapon-enchantment policy (DEC-20) compares the `attribute` to resolve
      // elemental incompatibilities. Never a stacking identity; additive
      // optional field, schema stays v1 (DEC-41).
      damageType: new fields.SchemaField({
        nature: new fields.StringField({
          required: false, nullable: true, blank: false, initial: null
        }),
        attribute: new fields.StringField({
          required: false, nullable: true, blank: false, initial: null
        })
      }, { required: false, nullable: true, initial: null }),

      // ── Duration scale and combat anchor (Bloque 5, T5.2) ────────────────
      // T5.0-R consolidation (D3/D4/D5; §3.1/§3.3/§3.5): additive optional
      // fields, schema stays v1 (DEC-41). `durationScale` selects which
      // approved scale manages the effect's duration (SW25_DURATION_SCALES;
      // null = legacy effect before the field existed — never auto-stamped,
      // existing callers keep working). `durationAnchor` identifies WHOSE turn
      // the duration is anchored to, per combatant — never per Actor: two
      // tokens of the same Actor are independent combatants (no inheritance).
      //
      // Anchor identity: `combatantId` is the combatant's id within the
      // encounter (the turn-state key of the T5.1 side initiative); `tokenId`
      // is the optional token identity; the ORIGIN ACTOR identity is NOT
      // duplicated here — its canonical representation already exists
      // (`casterUUID` for casterTurn/roundEnd anchors; the effect's parent
      // Actor for targetTurn anchors).
      //
      // Native isolation (D1/D6/D11): nothing in these fields touches the
      // native document `duration` (no finite `value`, no `expiry`), the
      // global `expiryAction` or `CONFIG.ActiveEffect.expiryEvents`; expiry
      // processing belongs to the T5.3 engine, not to this schema.
      durationScale: new fields.StringField({
        required: false, nullable: true, blank: false, initial: null
      }),
      durationAnchor: new fields.SchemaField({
        // The anchor regime (SW25_ANCHOR_REGIMES).
        regime: new fields.StringField({
          required: false, nullable: true, blank: false, initial: null
        }),
        // The anchor turn edge (SW25_ANCHOR_EDGES; approved default "begin").
        edge: new fields.StringField({
          required: false, nullable: true, blank: false, initial: null
        }),
        // Combatant id within the encounter (T5.1 turn-state key); null for a
        // deferred anchor (state: "deferred").
        combatantId: new fields.StringField({
          required: false, nullable: true, blank: false, initial: null
        }),
        // Optional token identity of the anchor.
        tokenId: new fields.StringField({
          required: false, nullable: true, blank: false, initial: null
        }),
        // Anchor resolution state (SW25_ANCHOR_STATES); null reads as
        // "resolved" (an absent state on a payload with combatantId).
        state: new fields.StringField({
          required: false, nullable: true, blank: false, initial: null
        })
      }, { required: false, nullable: true, initial: null }),

      // ── Authored source duration identity (Phase 3 corrections) ──────────
      // Minimal provenance for an effect whose duration was AUTHORED in a
      // unit that has no counters of its own on the manual scales: today the
      // out-of-combat fallback of a seconds-based Instant/X component stores
      // `durationScale: "other"` with NO counters, which is indistinguishable
      // from any unrelated "other" effect. `sourceDuration` preserves that
      // identity from the normalized spell data (`durationData.persistent.
      // sourceUnit`/`sourceAmount`) so the combat-entry confirmation flow can
      // offer the effect its combat-equivalent rounds — it is NEVER inferred
      // from display text. Currently written only for seconds (`unit:
      // "seconds"`); the shape stays unit/amount so later units need no
      // schema change. The field carries NO countdown semantics of its own:
      // an "other" effect with a sourceDuration still has no automation
      // outside the explicit combat-entry conversion. Additive optional
      // field, schema stays v1 (DEC-41).
      sourceDuration: new fields.SchemaField({
        // The unit the duration was authored in (e.g. "seconds").
        unit: new fields.StringField({
          required: false, nullable: true, blank: false, initial: null
        }),
        // The authored amount in that unit (positive, finite).
        amount: new fields.NumberField({
          required: false, nullable: true, initial: null, min: 0
        })
      }, { required: false, nullable: true, initial: null }),

      // ── Presentation visibility (gmOnly) ─────────────────────────────────
      // Presentation-layer visibility flag for the system's own effect
      // interfaces (the Effects tab, the inspector): when true, the effect is
      // listed and inspectable ONLY for GM users; players never see it there.
      // The DOCUMENT still replicates to every client like any other
      // ActiveEffect — this flag hides presentation, it does NOT protect
      // replicated data from deliberate inspection. System-side mechanical
      // consumers (duration engine, effective values, GM-side repair) read
      // the documents directly and are unaffected. Backward compatible:
      // effects written before the field load with the `false` initial, and
      // an absent field never changes their visibility. Additive optional
      // field, schema stays v1 (DEC-41).
      gmOnly: new fields.BooleanField({
        required: false, nullable: false, initial: false
      }),

      // ── Configured rule elements (reusable effects architecture) ─────────
      // PF2e-inspired additive field: an array of rule element payloads, each
      // selected by its `key` (see module/effects/rule-elements.mjs). The
      // effective rule set of a `sw25Effect` lives here; the native `changes`
      // array is untouched and keeps its own meaning.
      //
      // The array element is a plain ObjectField because every rule element
      // family owns a different parameter set (like PF2e's discriminated rule
      // schema). Semantic validation belongs to the rule-element registry at
      // the single write path (EffectService) and to the repair layer on read;
      // the schema only guarantees "array of objects".
      //
      // Additive optional field, schema stays v1 (DEC-41): effects written
      // before the field existed load with an empty array, and no legacy
      // `changes`-based consumer is affected.
      rules: new fields.ArrayField(new fields.ObjectField(), {
        required: false, nullable: false, initial: []
      })
    };
  }
}
