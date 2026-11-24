// ---------------------------------------------------------------------------
// spell-normalization.test.mjs — Phase 1 canonical spell data normalization
// (rules/spell-data.mjs: canonicalSpellName + parseSpellDurationData and
// their integration into deriveSpellFields / normalizeSpellData).
//
// Validated against the FULL audited compendium corpus
// (spell-normalization-corpus.json: all 656 Spell Items of sw25-library
// v1.3.0 packs/spells, extracted read-only) plus synthetic cases the corpus
// cannot express (fractional rounds, marker orders, stale durationData
// repair, hours/days shapes).
//
// Pinned corpus invariants (audit spell-data-parsing-normalization-audit.md):
//   - 61 Instant/X spells, 23 of them written with a space before the slash
//     (all previously missed by the strict Effects-engine detector).
//   - 100 marker-bearing names (93 ⏩, 46 △, 39 both), zero canonical-name
//     collisions, †/‡ preserved.
//   - 319 seconds/minutes expressions agreeing with the canonical
//     10 s = 1 round arithmetic (0 parenthetical mismatches, 0 fractional).
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canonicalSpellName,
  parseSpellDurationData,
  SPELL_DURATION_SCALES,
  deriveSpellFields,
  normalizeSpellData
} from "../module/rules/spell-data.mjs";

let passed = 0;
const record = label => { passed++; console.log(`  PASS: ${label}`); };

const corpus = JSON.parse(readFileSync(new URL("./spell-normalization-corpus.json", import.meta.url), "utf8"));
const spells = corpus.spells;

// ── 1. Corpus integrity ────────────────────────────────────────────────────

assert.equal(spells.length, 656, "the corpus carries all 656 audited Spell Items");
assert.equal(new Set(spells.map(spell => spell.name)).size, 656, "all authored names are unique");
assert.ok(spells.every(spell => typeof spell.name === "string" && spell.name.length > 0));
record("corpus integrity: 656 spells, unique authored names");

// ── 2. canonicalSpellName over the full corpus ─────────────────────────────

{
  let minor = 0;
  let prep = 0;
  let either = 0;
  let both = 0;
  let daggers = 0;
  const canonicalNames = new Set();
  for (const spell of spells) {
    const canonical = canonicalSpellName(spell.name);

    // The marker metadata matches the stored booleans on every record.
    assert.equal(canonical.minorAction, spell.minorAction, `⏩ metadata for ${spell.name}`);
    assert.equal(canonical.combatPreparation, spell.combatPreparation, `△ metadata for ${spell.name}`);

    // The canonical name never carries a leading action marker, and
    // canonicalizing again is a no-op.
    assert.ok(!/^[⏩△]/.test(canonical.name), `no leading action marker in "${canonical.name}"`);
    const again = canonicalSpellName(canonical.name);
    assert.equal(again.name, canonical.name, `idempotent for ${spell.name}`);
    assert.equal(again.changed, false, `second pass reports changed:false for ${spell.name}`);

    // †/‡ are preserved verbatim (not action markers).
    if (/^[†‡]/.test(spell.name)) {
      daggers++;
      assert.equal(canonical.changed, false, `†/‡ name is untouched: ${spell.name}`);
      assert.equal(canonical.name, spell.name);
    }

    if (canonical.minorAction) minor++;
    if (canonical.combatPreparation) prep++;
    if (canonical.minorAction || canonical.combatPreparation) either++;
    if (canonical.minorAction && canonical.combatPreparation) both++;
    canonicalNames.add(canonical.name);
  }
  assert.equal(minor, 93, "93 ⏩ names in the corpus");
  assert.equal(prep, 46, "46 △ names in the corpus");
  assert.equal(either, 100, "100 names carry one or both markers");
  assert.equal(both, 39, "39 names carry both markers");
  assert.equal(daggers, 12, "the 12 †/‡ names are tracked");
  assert.equal(canonicalNames.size, 656, "zero canonical-name collisions across the corpus");
  record("canonical names over 656 spells: 93⏩/46△/100 either, 39 both, 12 †/‡ kept, 0 collisions, idempotent");
}

// ── 3. canonicalSpellName contract (synthetic) ─────────────────────────────

{
  assert.deepEqual(canonicalSpellName("⏩Healing Bullet"), { name: "Healing Bullet", minorAction: true, combatPreparation: false, changed: true });
  assert.deepEqual(canonicalSpellName("△Berserk"), { name: "Berserk", minorAction: false, combatPreparation: true, changed: true });
  assert.deepEqual(canonicalSpellName("⏩△Hyper Acceleration"), { name: "Hyper Acceleration", minorAction: true, combatPreparation: true, changed: true });
  assert.equal(canonicalSpellName("△⏩Hyper Acceleration").name, "Hyper Acceleration", "both markers in either order");
  assert.equal(canonicalSpellName("⏩ △Hyper Acceleration").name, "Hyper Acceleration", "whitespace between markers");
  assert.equal(canonicalSpellName("⏩△ Hyper Acceleration").name, "Hyper Acceleration", "whitespace left behind is consumed");
  assert.equal(canonicalSpellName("⏩⏩Fire Bolt").name, "Fire Bolt", "repeated markers");
  assert.equal(canonicalSpellName("Fire Bolt").changed, false, "clean names pass through untouched");
  assert.equal(canonicalSpellName(" Fire Bolt").name, " Fire Bolt", "authored leading whitespace without markers is preserved");
  assert.equal(canonicalSpellName("†Sacred Field").name, "†Sacred Field", "† is not an action marker");
  assert.equal(canonicalSpellName("‡Vice Field").name, "‡Vice Field", "‡ is not an action marker");
  assert.equal(canonicalSpellName("Fire⏩Bolt").changed, false, "a marker mid-name is authored content, not a prefix");
  assert.equal(canonicalSpellName(null).name, "", "null input is tolerated");
  assert.deepEqual(canonicalSpellName(null), { name: "", minorAction: false, combatPreparation: false, changed: false });
  record("canonicalSpellName contract: leading run only, both orders, whitespace, †/‡ preserved, idempotent");
}

// ── 4. parseSpellDurationData over the full corpus (schema + distribution) ─

{
  const scaleCounts = {};
  let pureInstant = 0;
  let instantX = 0;
  let spaceSlash = 0;
  for (const spell of spells) {
    const raw = String(spell.duration ?? "").trim();
    const data = parseSpellDurationData(spell.duration);

    // The source expression is preserved verbatim (trimmed).
    assert.equal(data.raw, raw, `raw preserved for ${spell.name}`);
    assert.equal(typeof data.immediate, "boolean", `immediate is boolean for ${spell.name}`);

    if (data.persistent === null) {
      assert.equal(data.immediate, true, `persistent null means pure Instant: ${spell.name}`);
      pureInstant++;
    } else {
      const persistent = data.persistent;
      assert.deepEqual(
        Object.keys(persistent).sort(),
        ["amount", "nonIntegerRounds", "scale", "sourceAmount", "sourceUnit", "unit"],
        `persistent schema keys for ${spell.name}`
      );
      assert.ok(SPELL_DURATION_SCALES.includes(persistent.scale), `approved scale for ${spell.name}`);
      assert.equal(typeof persistent.nonIntegerRounds, "boolean", `nonIntegerRounds is boolean for ${spell.name}`);
      if (data.immediate) instantX++;
      if (data.immediate && /^instant\s+\//i.test(raw)) spaceSlash++;
    }
    const key = data.persistent ? data.persistent.scale : "null";
    scaleCounts[key] = (scaleCounts[key] ?? 0) + 1;
  }
  assert.equal(pureInstant, 192, "192 pure Instant expressions");
  assert.equal(instantX, 61, "all 61 Instant/X spells are identified");
  assert.equal(spaceSlash, 23, "the 23 space-before-slash expressions are accepted");
  assert.deepEqual(scaleCounts, { null: 192, rounds: 319, hours: 63, days: 40, permanent: 25, other: 17 });
  record("durations over 656 spells: 61 Instant/X identified (23 space-slash), scale distribution pinned");
}

// ── 5. Round conversion over the corpus: arithmetic, parenthetical agrees ──

{
  let withParenthetical = 0;
  for (const spell of spells) {
    const persistent = parseSpellDurationData(spell.duration).persistent;
    if (!persistent || persistent.scale !== "rounds") continue;
    const parenthetical = String(spell.duration ?? "").match(/\((\d+)\s*rounds?\)/i);
    if (parenthetical) {
      withParenthetical++;
      assert.equal(persistent.amount, Number(parenthetical[1]),
        `computed rounds agree with the "(N rounds)" annotation: ${spell.name}`);
    }
    assert.equal(persistent.nonIntegerRounds, false, `no fractional rounds in the corpus: ${spell.name}`);
    if (persistent.sourceUnit.startsWith("second")) {
      assert.equal(persistent.amount, persistent.sourceAmount / 10, `seconds arithmetic for ${spell.name}`);
    } else if (persistent.sourceUnit.startsWith("minute")) {
      assert.equal(persistent.amount, persistent.sourceAmount * 6, `minutes arithmetic for ${spell.name}`);
    } else {
      assert.equal(persistent.amount, persistent.sourceAmount, `rounds/turns keep the authored amount: ${spell.name}`);
    }
  }
  assert.equal(withParenthetical, 317, "317 of the 319 rounds expressions carry the (N rounds) annotation");
  record("round conversion over corpus: arithmetic only, parenthetical agrees everywhere (0 mismatches)");
}

// ── 6. Hours and days retain their original scale ──────────────────────────

{
  assert.deepEqual(parseSpellDurationData("2 hours").persistent,
    { scale: "hours", amount: 2, unit: "hours", sourceUnit: "hours", sourceAmount: 2, nonIntegerRounds: false });
  assert.deepEqual(parseSpellDurationData("1 day").persistent,
    { scale: "days", amount: 1, unit: "days", sourceUnit: "day", sourceAmount: 1, nonIntegerRounds: false });
  assert.equal(parseSpellDurationData("Instant / 2 days").immediate, true, "Instant/X with days");
  let checked = 0;
  for (const spell of spells) {
    const persistent = parseSpellDurationData(spell.duration).persistent;
    if (persistent && (persistent.scale === "hours" || persistent.scale === "days")) {
      checked++;
      assert.equal(persistent.amount, persistent.sourceAmount, "non-combat scales keep the authored amount");
      assert.equal(persistent.unit, persistent.scale);
      assert.equal(persistent.nonIntegerRounds, false, "no conversion, no fraction");
    }
  }
  assert.equal(checked, 103, "63 hours + 40 days corpus records keep their scale");
  record("hours/days retain their original scale (63 + 40 corpus records)");
}

// ── 7. Permanent / Special / unknown durations ─────────────────────────────

{
  assert.deepEqual(parseSpellDurationData("Permanent"),
    { raw: "Permanent", immediate: false, persistent: { scale: "permanent", amount: null, unit: null, sourceUnit: null, sourceAmount: null, nonIntegerRounds: false } });
  assert.equal(parseSpellDurationData("Permanent (but see below)").persistent.scale, "permanent");
  assert.equal(parseSpellDurationData("Special").persistent.scale, "other");
  assert.equal(parseSpellDurationData("Various (see below)").persistent.scale, "other");
  assert.equal(parseSpellDurationData("1 year").persistent.scale, "other", "unknown units are not converted");
  const conditional = parseSpellDurationData("One day or until order is completed");
  assert.equal(conditional.persistent.scale, "other", "conditional durations are not silently interpreted");
  assert.equal(conditional.raw, "One day or until order is completed", "raw preserved for the GM");
  const otherRaws = [...new Set(spells
    .map(spell => parseSpellDurationData(spell.duration))
    .filter(data => data.persistent?.scale === "other")
    .map(data => data.raw))].sort();
  assert.deepEqual(otherRaws,
    ["1 year", "Instant/Various", "Instant/Various (see below)", "One day or until order is completed", "Special"]);
  record("Permanent/Special/unknown durations: permanent scale or conservative other, raw always preserved");
}

// ── 8. Conversion examples + Instant / Instant-X variants ──────────────────

{
  const rounds = text => parseSpellDurationData(text).persistent?.amount;
  assert.equal(rounds("10 seconds"), 1);
  assert.equal(rounds("30 seconds"), 3);
  assert.equal(rounds("1 minute"), 6);
  assert.equal(rounds("3 minutes"), 18);
  assert.equal(rounds("Instant / 10 seconds (1 round)"), 1);
  assert.equal(rounds("Instant/10 seconds"), 1, "no parenthetical needed (Daemon Buster)");
  assert.equal(rounds("3 minutes"), 18, "no parenthetical needed (Holography)");
  assert.equal(rounds("Instant / 3 minutes (18 rounds)"), 18);
  for (const text of ["Instant/3 minutes", "Instant / 3 minutes", "Instant/ 3 minutes", "Instant /3 minutes"]) {
    assert.equal(rounds(text), 18, `whitespace around the slash is harmless: ${text}`);
  }
  assert.deepEqual(parseSpellDurationData("Instant"), { raw: "Instant", immediate: true, persistent: null });
  const combined = parseSpellDurationData("Instant / 10 seconds (1 round)");
  assert.equal(combined.immediate, true);
  assert.deepEqual(combined.persistent,
    { scale: "rounds", amount: 1, unit: "rounds", sourceUnit: "seconds", sourceAmount: 10, nonIntegerRounds: false });
  const various = parseSpellDurationData("Instant/Various (see below)");
  assert.equal(various.immediate, true);
  assert.equal(various.persistent.scale, "other");
  const instantPermanent = parseSpellDurationData("Instant / Permanent");
  assert.equal(instantPermanent.immediate, true);
  assert.equal(instantPermanent.persistent.scale, "permanent");
  assert.deepEqual(parseSpellDurationData("Instant/3 rounds").persistent,
    { scale: "rounds", amount: 3, unit: "rounds", sourceUnit: "rounds", sourceAmount: 3, nonIntegerRounds: false });
  assert.deepEqual(parseSpellDurationData("2 turns").persistent,
    { scale: "turns", amount: 2, unit: "turns", sourceUnit: "turns", sourceAmount: 2, nonIntegerRounds: false });
  assert.deepEqual(parseSpellDurationData(null), { raw: "", immediate: false, persistent: null });
  assert.equal(parseSpellDurationData("").persistent, null);
  record("conversion examples + Instant/Instant-X variants (whitespace-tolerant)");
}

// ── 9. Fractional round results: exact and flagged, never rounded ──────────

{
  const half = parseSpellDurationData("5 seconds");
  assert.equal(half.persistent.amount, 0.5);
  assert.equal(half.persistent.nonIntegerRounds, true, "fractional rounds are flagged");
  const fortyFive = parseSpellDurationData("45 seconds");
  assert.equal(fortyFive.persistent.amount, 4.5);
  assert.equal(fortyFive.persistent.nonIntegerRounds, true);
  const oneSecond = parseSpellDurationData("1 second");
  assert.equal(oneSecond.persistent.amount, 0.1);
  assert.equal(oneSecond.persistent.nonIntegerRounds, true);
  // Whole minutes are always integral (N × 60 ÷ 10 = N × 6).
  const minutes = parseSpellDurationData("7 minutes");
  assert.equal(minutes.persistent.amount, 42);
  assert.equal(minutes.persistent.nonIntegerRounds, false);
  // Hours/days never convert, so they are never fractional.
  const hours = parseSpellDurationData("1 hour");
  assert.equal(hours.persistent.scale, "hours");
  assert.equal(hours.persistent.nonIntegerRounds, false);
  record("fractional round results: preserved exactly and flagged, never rounded");
}

// ── 10. deriveSpellFields integration ──────────────────────────────────────

{
  const derived = deriveSpellFields({
    name: "⏩△Hyper Acceleration",
    metadata: "Target: Caster\nDuration: Instant / 10 seconds (1 round)\nResistance: None",
    specialDamageBands: [],
    hasPowerTable: false
  });
  // Booleans derive from the ORIGINAL name, before canonicalization.
  assert.equal(derived.minorAction, true);
  assert.equal(derived.combatPreparation, true);
  // durationData derived from the extracted Duration text; raw text unchanged.
  assert.deepEqual(derived.durationData,
    { raw: "Instant / 10 seconds (1 round)", immediate: true, persistent: { scale: "rounds", amount: 1, unit: "rounds", sourceUnit: "seconds", sourceAmount: 10, nonIntegerRounds: false } });
  assert.equal(derived.duration, "Instant / 10 seconds (1 round)");
  // The output contract is the previous one plus `durationData` — no Power
  // inference, no invented target/range/resistance data.
  assert.deepEqual(Object.keys(derived).sort(),
    ["area", "combatPreparation", "damageType", "duration", "durationData", "effectType", "minorAction", "range", "rank", "resistance", "target", "usesFortitude", "warnings"]);
  assert.ok(!("power" in derived) && !("powerTable" in derived), "Power extraction is not part of this layer");
  // Unrelated derivations still behave identically.
  assert.equal(derived.target, "caster");
  assert.equal(derived.resistance, "none");
  assert.equal(derived.rank, 0);
  assert.deepEqual(derived.warnings, []);
  record("deriveSpellFields: durationData added, markers from the original name, contract otherwise unchanged");
}

// ── 11. normalizeSpellData integration ─────────────────────────────────────

{
  // Absent durationData is derived from the stored duration expression.
  const first = normalizeSpellData(
    { metadata: "Duration: Instant / 3 minutes (18 rounds)", duration: "Instant / 3 minutes (18 rounds)" },
    { name: "⏩△Hyper Acceleration" }
  );
  assert.equal(first.system.durationData.raw, "Instant / 3 minutes (18 rounds)");
  assert.equal(first.system.durationData.persistent.amount, 18);
  assert.equal(first.system.minorAction, true);
  assert.equal(first.system.combatPreparation, true);
  // The canonical name is REPORTED (marker-stripped); applying it is the caller's job.
  assert.equal(first.name, "Hyper Acceleration");
  assert.equal(first.nameChanged, true);

  // Idempotent: a second pass changes nothing.
  const second = normalizeSpellData({ ...first.system }, { name: "Hyper Acceleration" });
  assert.deepEqual(second.system, first.system, "normalization stays idempotent with durationData");
  assert.equal(second.name, "Hyper Acceleration");
  assert.equal(second.nameChanged, false);

  // A matching durationData is kept byte-for-byte.
  assert.deepEqual(normalizeSpellData({ ...first.system }, { name: "Hyper Acceleration" }).system.durationData, first.system.durationData);

  // Stale durationData (duration edited after a previous normalization) is
  // re-derived from the stored expression; the stored text is never rewritten.
  const repaired = normalizeSpellData({ ...first.system, duration: "Instant / 2 hours" }, { name: "Hyper Acceleration" });
  assert.equal(repaired.system.duration, "Instant / 2 hours");
  assert.equal(repaired.system.durationData.raw, "Instant / 2 hours");
  assert.equal(repaired.system.durationData.persistent.scale, "hours");
  assert.equal(repaired.system.durationData.persistent.amount, 2);

  // A stored true without a marker remains a user edit (existing rule).
  const manual = normalizeSpellData({ metadata: "Duration: Instant", minorAction: true }, { name: "Energy Bolt" });
  assert.equal(manual.system.minorAction, true);
  assert.equal(manual.name, "Energy Bolt");
  assert.equal(manual.nameChanged, false);

  // Unrelated fields pass through untouched (Power, tables, legacy cleanup).
  const withPower = normalizeSpellData({
    metadata: "Duration: Instant\nResistance: Half",
    power: 10,
    powerTable: { "3": 1, "12": 7 },
    hasPowerTable: true,
    school: "Sorcerer"
  }, { name: "Energy Bolt" });
  assert.equal(withPower.system.power, 10, "Power is retained");
  assert.deepEqual(withPower.system.powerTable, { "3": 1, "12": 7 }, "Power Table is retained");
  assert.equal(withPower.system.school, undefined, "obsolete fields are still removed");
  assert.equal(withPower.system.durationData.persistent, null);
  assert.equal(withPower.system.resistance, "half");
  record("normalizeSpellData: durationData derived/repaired idempotently, canonical name reported, everything else unchanged");
}

// ── 12. normalizeSpellData over the full corpus ────────────────────────────

{
  let renamed = 0;
  for (const spell of spells) {
    const normalized = normalizeSpellData(
      {
        duration: spell.duration ?? undefined,
        minorAction: spell.minorAction,
        combatPreparation: spell.combatPreparation,
        metadata: ""
      },
      { name: spell.name }
    );
    assert.ok(normalized.system.durationData, `durationData derived for ${spell.name}`);
    assert.equal(normalized.system.duration, String(spell.duration ?? "").trim(), `duration text preserved for ${spell.name}`);
    assert.ok(!normalized.name.includes("⏩") && !normalized.name.includes("△"), `canonical name for ${spell.name}`);
    assert.equal(normalized.system.minorAction, spell.minorAction, `minorAction preserved through normalization for ${spell.name}`);
    assert.equal(normalized.system.combatPreparation, spell.combatPreparation, `combatPreparation preserved for ${spell.name}`);
    if (normalized.nameChanged) renamed++;
    // Idempotence, corpus-wide.
    const second = normalizeSpellData({ ...normalized.system }, { name: normalized.name });
    assert.deepEqual(second.system, normalized.system, `idempotent for ${spell.name}`);
  }
  assert.equal(renamed, 100, "exactly the 100 marker-bearing names are reported as changed");
  record("normalizeSpellData over 656 spells: durationData everywhere, 100 canonical renames reported, idempotent");
}

console.log(`spell-normalization.test.mjs: ${passed} groups passed.`);
