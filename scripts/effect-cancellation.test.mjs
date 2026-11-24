// Sword World 2.5 - forced cancellation rules test suite (T6.1, DEC-7/DEC-8).
//
// Exercises module/effects/effect-cancellation.mjs headlessly. This suite is
// deliberately pure: no Foundry document writes, no socket relay, no effect
// service. The integration of the same rules into the Dispel Magic cast flow
// (including the GM-authoritative removal) is covered by spell-cast.test.mjs.
//
// Scope:
//   - Mechanism identity (Dispel Magic / Wordbreak).
//   - The two SEPARATE eligibility rules (DEC-8.B):
//       Dispel: magical only, Curse excluded, no duration restriction.
//       Wordbreak: magical and non-magical, >10 seconds or Instant/X,
//       Permanent/Instant/bare-turn excluded, physical states excluded,
//       Curse excluded (CR I p. 174). `Resistance: Can't` is NOT an
//       eligibility condition for either mechanism (T6.1 correction).
//   - The shared strict comparison (attempt SV > effect SV) and automatic
//     success (natural double 6) per CR I pp. 166-167, including the
//     passive-side automatic success (+5 already stored) and the
//     unrecorded-SV fallback (CR I p. 167).
//   - Casting identity (`castId`) and the area rule (`/Space` vs `/All`/`/Z`).
//   - `gmOnly` effects are hidden from non-GM candidate lists.
//   - Ineligible effects are never cancelled regardless of the attempt SV.

import assert from "node:assert/strict";

const {
  SW25_CANCELLATION_MECHANISMS,
  SW25_CURSE_EFFECT_TYPE,
  SW25_WORDBREAK_PHYSICAL_STATE_TYPES,
  collectCancellationCandidates,
  collectCancellationRemovalGroup,
  compareCancellationSuccessValues,
  effectCancellationEligibility,
  effectRecordedSuccessValue,
  isCurseEffect,
  isDispelMagicSpell,
  isPhysicalStateEffect,
  isSharedSpaceEffect,
  isWordbreakFeat,
  resolveCancellationAttempt,
  sameCasting,
  wordbreakDurationEligibility
} = await import("../module/effects/effect-cancellation.mjs");
const { SW25_EFFECT_SUBTYPE } = await import("../module/effects/effect-model.mjs");

const record = label => console.log(`  ${label}`);

// ── Mechanism identity (explicit identity, never parsed descriptions) ──────

{
  assert.deepEqual(SW25_CANCELLATION_MECHANISMS, ["dispel", "wordbreak"]);
  assert.equal(isDispelMagicSpell({ name: "Dispel Magic", system: {} }), true);
  assert.equal(isDispelMagicSpell({ name: "  dispel magic  ", system: {} }), true);
  assert.equal(isDispelMagicSpell({ name: "Dispel Magic", system: { sourceUrl: "https://sw25.wikidot.com/spell:dispel-magic" } }), true);
  assert.equal(isDispelMagicSpell({ name: "Dispel", system: {} }), false);
  assert.equal(isDispelMagicSpell({ name: "Dispel Magic II", system: { sourceUrl: "https://sw25.wikidot.com/spell:dispel-magic-ii" } }), false,
    "a longer source key is a different spell");

  assert.equal(isWordbreakFeat({ name: "Wordbreak", system: {} }), true);
  assert.equal(isWordbreakFeat({ name: "Word Break", system: {} }), false, "the authored name is Wordbreak");
  assert.equal(isWordbreakFeat({ name: "Wordbreak", system: { sourceUrl: "https://sw25.wikidot.com/feat:wordbreak" } }), true);
  assert.equal(isWordbreakFeat({ name: "Other Feat", system: {} }), false);

  record("mechanism identity: exact names/source keys, no description parsing");
}

// ── Curse and physical-state classification ────────────────────────────────

{
  assert.equal(SW25_CURSE_EFFECT_TYPE, "curse");
  assert.equal(isCurseEffect({ effectType: "Curse" }), true);
  assert.equal(isCurseEffect({ effectType: " curse " }), true);
  assert.equal(isCurseEffect({ effectType: "Maldición" }), false, "no invented translation");
  assert.equal(isCurseEffect({ effectType: null }), false);
  assert.equal(isCurseEffect(undefined), false);

  for (const type of SW25_WORDBREAK_PHYSICAL_STATE_TYPES) {
    assert.equal(isPhysicalStateEffect({ effectType: type }), true, `${type} is an explicit physical state`);
    assert.equal(isPhysicalStateEffect({ effectType: type.toUpperCase() }), true);
  }
  assert.equal(isPhysicalStateEffect({ effectType: "Grappled-ish" }), false, "unclassified text is never guessed");
  assert.equal(isPhysicalStateEffect({ effectType: null }), false);

  record("classification: Curse is case-insensitive; physical states are an explicit vocabulary");
}

// ── Dispel Magic eligibility (DEC-7.2 / CR I p. 220) ───────────────────────

{
  const magical = { isMagical: true, successValue: 12, durationScale: "permanent" };
  assert.equal(effectCancellationEligibility(magical, "dispel").eligible, true,
    "a magical effect is eligible regardless of duration");

  const nonMagical = { isMagical: false, successValue: 12, durationScale: "rounds" };
  assert.equal(effectCancellationEligibility(nonMagical, "dispel").eligible, false,
    "Dispel Magic cannot remove non-magical effects");

  const unrecorded = { successValue: 12, durationScale: "rounds" };
  assert.equal(effectCancellationEligibility(unrecorded, "dispel").eligible, false,
    "a missing legacy magical status is not guessed as magical");
  assert.equal(effectCancellationEligibility({ ...unrecorded, isMagical: null }, "dispel").eligible, false,
    "a null legacy magical status is not guessed as magical");
  assert.equal(effectCancellationEligibility({ ...unrecorded, isMagical: "true" }, "dispel").eligible, false,
    "only the explicit boolean true qualifies");

  const curse = { isMagical: true, effectType: "Curse", successValue: 12, durationScale: "rounds" };
  const curseEligibility = effectCancellationEligibility(curse, "dispel");
  assert.equal(curseEligibility.eligible, false);
  assert.ok(curseEligibility.reasons.some(reason => /Curse/.test(reason)));

  assert.equal(effectCancellationEligibility({ isMagical: true, successValue: 12, resistance: "cant" }, "dispel").eligible, true,
    "Dispel Magic has no Resistance: Can't restriction");

  assert.equal(effectCancellationEligibility({ isMagical: true, successValue: 12, durationScale: "permanent", successValueSource: "check" }, "dispel").eligible, true,
    "a Permanent magical effect is Dispel-eligible (no duration restriction)");

  record("Dispel Magic: magical only, Curse excluded, duration/resistance unrestricted (Permanent eligible)");
}

// ── Wordbreak duration rules (DEC-7.3 / CR I p. 264) ───────────────────────

{
  const cases = [
    [{ durationScale: "rounds", initialDuration: 3 }, false, true, "3 rounds > 10 seconds"],
    [{ durationScale: "rounds", initialDuration: 2 }, false, true, "2 rounds > 10 seconds"],
    [{ durationScale: "rounds", initialDuration: 1 }, false, false, "1 round is not longer than 10 seconds"],
    [{ durationScale: "rounds", initialDuration: null }, false, false, "a missing counter proves nothing"],
    [{ durationScale: "turns" }, false, false, "a turn edge is at most one round"],
    [{ durationScale: "minutes" }, false, true, "minutes exceed 10 seconds"],
    [{ durationScale: "hours" }, false, true, "hours exceed 10 seconds"],
    [{ durationScale: "days" }, false, true, "days exceed 10 seconds"],
    [{ durationScale: "permanent" }, false, false, "Permanent is excluded"],
    [{ durationScale: "other" }, false, false, "unverifiable duration is not guessed"],
    [{}, false, false, "legacy duration is not guessed"],
    [{ durationScale: "rounds", initialDuration: 1 }, true, true, "Instant/1 round is the printed Instant/X exception"],
    [{ durationScale: "turns" }, true, true, "Instant/X turns is cancellable"],
    [{ durationScale: "other" }, true, true, "Instant/X bare seconds (other) is cancellable"],
    [{ durationScale: "permanent" }, true, false, "Instant/X never overrides the Permanent exclusion"]
  ];
  for (const [system, instantX, expected, label] of cases) {
    assert.equal(wordbreakDurationEligibility(system, { instantX }).eligible, expected, label);
  }
  record("Wordbreak duration: >1 round / manual scales / Instant-X exception; Permanent and bare-turn excluded");
}

// ── Wordbreak eligibility (magic-agnostic, physical and resistance rules) ──

{
  const base = { successValue: 12, durationScale: "rounds", initialDuration: 3, resistance: "neg" };
  assert.equal(effectCancellationEligibility({ ...base, isMagical: true }, "wordbreak").eligible, true);
  assert.equal(effectCancellationEligibility({ ...base, isMagical: false }, "wordbreak").eligible, true,
    "Wordbreak accepts non-magical effects too");
  assert.equal(effectCancellationEligibility({ ...base }, "wordbreak").eligible, true,
    "the magical flag is not a Wordbreak restriction");

  const curse = { ...base, isMagical: true, effectType: "Curse" };
  const curseEligibility = effectCancellationEligibility(curse, "wordbreak");
  assert.equal(curseEligibility.eligible, false,
    "Curse effects are excluded from Wordbreak too (CR I p. 174: only [Remove Curse])");
  assert.ok(curseEligibility.reasons.some(reason => /Curse/.test(reason)));

  const cant = { ...base, isMagical: true, resistance: "cant" };
  assert.equal(effectCancellationEligibility(cant, "wordbreak").eligible, true,
    "Resistance: Can't does NOT prevent cancellation (T6.1 correction)");
  const cantNonMagical = { ...base, isMagical: false, resistance: "cant" };
  assert.equal(effectCancellationEligibility(cantNonMagical, "wordbreak").eligible, true,
    "resistance is never a substitute for magical classification or duration");

  const prone = { ...base, effectType: "Prone" };
  assert.equal(effectCancellationEligibility(prone, "wordbreak").eligible, false);
  const grabbed = { ...base, effectType: "grabbed" };
  assert.equal(effectCancellationEligibility(grabbed, "wordbreak").eligible, false);

  const short = { ...base, durationScale: "rounds", initialDuration: 1 };
  assert.equal(effectCancellationEligibility(short, "wordbreak").eligible, false);
  assert.equal(effectCancellationEligibility(short, "wordbreak", { instantX: true }).eligible, true);

  record("Wordbreak: magic-agnostic; Curse excluded; Can't irrelevant; continuous physical states excluded");
}

// ── Shared strict comparison and automatic success (DEC-7.1) ───────────────

{
  assert.equal(compareCancellationSuccessValues(15, 14), true);
  assert.equal(compareCancellationSuccessValues(14, 14), false, "equality does not cancel");
  assert.equal(compareCancellationSuccessValues(13, 14), false);
  assert.equal(compareCancellationSuccessValues("15", "14"), true, "numeric strings compare numerically");

  const magical = { isMagical: true, successValue: 14, successValueSource: "check", durationScale: "rounds", initialDuration: 3 };
  const higher = resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 15, system: magical });
  assert.equal(higher.eligible, true);
  assert.equal(higher.cancelled, true);
  assert.equal(higher.effectSuccessValue, 14);

  const equal = resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 14, system: magical });
  assert.equal(equal.eligible, true);
  assert.equal(equal.cancelled, false, "an equal SV must not remove the effect");

  const lower = resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 13, system: magical });
  assert.equal(lower.cancelled, false);

  const auto = resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 10, system: magical, automaticSuccess: true });
  assert.equal(auto.cancelled, true, "a natural double 6 cancels even below the stored SV (CR I p. 166)");
  assert.equal(auto.automaticSuccess, true);

  const ineligibleHigh = resolveCancellationAttempt({
    mechanism: "dispel",
    attemptSuccessValue: 999,
    system: { isMagical: false, successValue: 1 }
  });
  assert.equal(ineligibleHigh.eligible, false);
  assert.equal(ineligibleHigh.cancelled, false, "ineligible effects are never cancelled, whatever the SV");
  assert.equal(ineligibleHigh.reasons.length > 0, true);

  record("comparison: strict >, equality resists, auto-success cancels, ineligible never cancels");
}

// ── Success Value provenance: automatic origin, missing vs legitimate 0 ────

{
  // CR I p. 166: an effect created by an automatic success keeps its original
  // SV ALREADY increased by +5 (DEC-6); it is NOT immune to cancellation.
  const automatic = { isMagical: true, successValue: 21, successValueSource: "automatic", durationScale: "rounds", initialDuration: 3 };
  assert.equal(effectRecordedSuccessValue(automatic), 21, "the stored SV already carries the +5 automatic-success bonus");
  assert.equal(resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 21, system: automatic }).cancelled, false,
    "equality with the +5 value does not cancel");
  assert.equal(resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 22, system: automatic }).cancelled, true,
    "exceeding the +5 value cancels an automatic-success effect");
  const automaticVsAutomatic = resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 12, system: automatic, automaticSuccess: true });
  assert.equal(automaticVsAutomatic.cancelled, true, "an active automatic success also cancels it");
  assert.equal(automaticVsAutomatic.needsSuccessValue, false);

  // Unrecorded provenance: the value is NOT silently read as 0 (CR I p. 167).
  const legacy = { isMagical: true, successValue: 0, durationScale: "rounds", initialDuration: 3 };
  assert.equal(effectRecordedSuccessValue(legacy), null, "no recorded provenance means the SV is not recorded");
  const missing = resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 15, system: legacy });
  assert.equal(missing.eligible, true);
  assert.equal(missing.cancelled, false, "an unrecorded SV is never beaten by substituting zero");
  assert.equal(missing.needsSuccessValue, true);
  assert.equal(missing.effectSuccessValue, null);
  const recovered = resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 15, system: legacy, effectSuccessValue: 12 });
  assert.equal(recovered.needsSuccessValue, false);
  assert.equal(recovered.effectSuccessValue, 12, "the re-determined value is used for the comparison");
  assert.equal(recovered.cancelled, true);
  const recoveredHigher = resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 15, system: legacy, effectSuccessValue: 20 });
  assert.equal(recoveredHigher.cancelled, false, "the re-determined value can also resist");
  const missingAuto = resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 15, system: legacy, automaticSuccess: true });
  assert.equal(missingAuto.cancelled, true, "an active automatic success needs no passive value");
  assert.equal(missingAuto.needsSuccessValue, false);

  // A legitimate 0 with a recorded no-check source is authoritative.
  const minor = { isMagical: true, successValue: 0, successValueSource: "none", durationScale: "rounds", initialDuration: 3 };
  assert.equal(effectRecordedSuccessValue(minor), 0, "SV 0 with a recorded source is NOT missing");
  assert.equal(resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 1, system: minor }).cancelled, true);
  assert.equal(resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 0, system: minor }).cancelled, false,
    "even against SV 0 the comparison stays strict");

  const fixed = { isMagical: true, successValue: 17, successValueSource: "fixed", durationScale: "permanent" };
  assert.equal(effectRecordedSuccessValue(fixed), 17, "a fixed/passive value is authoritative");
  assert.equal(resolveCancellationAttempt({ mechanism: "dispel", attemptSuccessValue: 18, system: fixed }).cancelled, true);

  record("SV provenance: automatic +5 still cancellable; unrecorded needs re-determination; recorded 0 is authoritative");
}

// ── Casting identity and the area rule (CR I p. 167) ───────────────────────

{
  assert.equal(sameCasting({ castId: "cast-1" }, { castId: "cast-1" }), true);
  assert.equal(sameCasting({ castId: "cast-1" }, { castId: "cast-2" }), false, "separate castings stay independent");
  assert.equal(sameCasting({ castId: null }, { castId: null }), false, "an absent castId never groups effects");
  assert.equal(sameCasting({}, {}), false);
  assert.equal(isSharedSpaceEffect({ effectScope: "space" }), true);
  assert.equal(isSharedSpaceEffect({ effectScope: "all" }), false);
  assert.equal(isSharedSpaceEffect({ effectScope: "limited" }), false);
  assert.equal(isSharedSpaceEffect({}), false);

  const owner = (id, effects) => ({ uuid: `Actor.${id}`, effects });
  const rep = (id, castId, scope) => ({
    type: SW25_EFFECT_SUBTYPE,
    id,
    system: { family: "Area Spell", castId, effectScope: scope, successValue: 10, successValueSource: "check", isMagical: true }
  });
  const first = owner("a", [rep("a-1", "cast-space", "space")]);
  const second = owner("b", [rep("b-1", "cast-space", "space")]);
  const third = owner("c", [rep("c-1", "cast-other", "space")]);
  const actors = [first, second, third];
  const space = collectCancellationRemovalGroup({ target: first, effect: first.effects[0] }, actors);
  assert.equal(space.shared, true);
  assert.equal(space.incomplete, false);
  assert.deepEqual(space.members.map(member => member.effect.id).sort(), ["a-1", "b-1"],
    "cancelling a /Space casting removes all of its representations");
  assert.ok(!space.members.some(member => member.effect.id === "c-1"), "a different casting is untouched");

  const allEffect = rep("a-2", "cast-all", "all");
  first.effects.push(allEffect);
  const all = collectCancellationRemovalGroup({ target: first, effect: allEffect }, actors);
  assert.equal(all.shared, false);
  assert.deepEqual(all.members.map(member => member.effect.id), ["a-2"], "/All stays individual per character");
  const limited = collectCancellationRemovalGroup({ target: first, effect: rep("a-3", "cast-all", "limited") }, actors);
  assert.equal(limited.members.length, 1, "/Z stays individual per character");

  const legacySpace = rep("a-4", null, "space");
  const incomplete = collectCancellationRemovalGroup({ target: first, effect: legacySpace }, actors);
  assert.equal(incomplete.shared, true);
  assert.equal(incomplete.incomplete, true, "a /Space effect without castId cannot be grouped");
  assert.equal(incomplete.members.length, 1);

  record("identity: castId groups one casting; /Space removes all representations; /All and /Z stay individual");
}

// ── gmOnly effects never reach a non-GM candidate list ─────────────────────

{
  const actor = {
    effects: [
      { type: SW25_EFFECT_SUBTYPE, id: "open", system: { isMagical: true, successValue: 5, successValueSource: "check" } },
      { type: SW25_EFFECT_SUBTYPE, id: "secret", system: { isMagical: true, successValue: 5, successValueSource: "check", gmOnly: true } }
    ]
  };
  const playerView = collectCancellationCandidates(actor, "dispel");
  assert.deepEqual(playerView.map(candidate => candidate.effect.id), ["open"], "a player never sees gmOnly candidates");
  const gmView = collectCancellationCandidates(actor, "dispel", undefined, { includeGmOnly: true });
  assert.deepEqual(gmView.map(candidate => candidate.effect.id), ["open", "secret"], "the GM view keeps them");

  record("visibility: gmOnly effects are excluded for players and listed for the GM");
}

// ── Candidate collection only reads system effects ─────────────────────────

{
  const actor = {
    effects: [
      { type: SW25_EFFECT_SUBTYPE, id: "e1", system: { isMagical: true, successValue: 5 } },
      { type: "base", id: "e2", system: { isMagical: true, successValue: 5 } },
      { type: SW25_EFFECT_SUBTYPE, id: "e3", system: { isMagical: false, successValue: 5 } }
    ]
  };
  const candidates = collectCancellationCandidates(actor, "dispel");
  assert.equal(candidates.length, 2, "native non-system effects are outside cancellation");
  assert.equal(candidates[0].eligibility.eligible, true);
  assert.equal(candidates[1].eligibility.eligible, false);

  const wordbreak = collectCancellationCandidates(actor, "wordbreak", effect => effect.id === "e3");
  assert.equal(wordbreak[0].eligibility.eligible, false, "e1 has no provable Wordbreak duration");
  assert.equal(wordbreak[1].eligibility.eligible, true, "e3 is Instant/X through the supplied origin resolver");

  record("candidate collection: system subtype only, mechanism-specific eligibility");
}

console.log("Forced cancellation: all cases passed.");
process.exit(0);
