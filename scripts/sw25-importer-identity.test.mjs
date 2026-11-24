// sw25-importer-identity.test.mjs — Phase 3 corrections (C4): the importer's
// spell identity is CANONICAL everywhere:
//   - spell imports always store the canonical name (leading ⏩/△ stripped,
//     `†`/`‡` preserved — they are not action markers);
//   - the refresh path RENAMES a legacy markered document name to canonical;
//   - duplicate detection compares canonical identity on both sides;
//   - multiple documents collapsing to ONE canonical identity are a CONFLICT:
//     detected, reported, and preserved — never merged, never deleted, and
//     nothing new is created while it stands;
//   - the read/matching layer (loading, special-spell matching) never renames.
// Run: node scripts/sw25-importer-identity.test.mjs
import assert from "node:assert/strict";
import { SW25Importer } from "../module/importer/sw25-importer.mjs";
import { canonicalSpellName, findSw25CanonicalSpellMatches } from "../module/rules/spell-data.mjs";
import { isExhaustiveSucking, regenerationSpellData } from "../module/rules/spell-effects.mjs";

let group = 0;
const record = message => console.log(`  ${++group}. ${message}`);

const parseSpell = (body, title, url, options = { classId: "sorcerer-id", className: "Sorcerer", featureType: "spell" }) =>
  SW25Importer.parseClassFeature(`
Title: ${title} - Sword World 2.5 Reference Wiki
Markdown Content:
# ${title}
Sorcerer, Level 1
MP: 4
Target: Caster
Range/Area: Caster
Duration: 3 rounds
Resistance: None
${body}
`, url, options);

// ── 1. Parse canonicalization: ⏩/△ stripped + persisted; †/‡ preserved ──────

{
  const marked = parseSpell("Creates a barrier.", "⏩△Quick Shield", "https://sw25.wikidot.com/spell:quick-shield");
  assert.equal(marked.name, "Quick Shield", "both leading markers are stripped from the stored name");
  assert.equal(marked.minorAction, true, "⏩ is persisted as system.minorAction");
  assert.equal(marked.combatPreparation, true, "△ is persisted as system.combatPreparation");

  const daggered = parseSpell("A fire storm.", "⏩Fire Storm†", "https://sw25.wikidot.com/spell:fire-storm");
  assert.equal(daggered.name, "Fire Storm†", "† is NOT an action marker: it stays in the canonical name");
  assert.equal(daggered.minorAction, true);
  const doubleDagger = parseSpell("A spell.", "‡Silent Cast‡", "https://sw25.wikidot.com/spell:silent-cast");
  assert.equal(doubleDagger.name, "‡Silent Cast‡", "‡ is preserved verbatim");

  const ability = SW25Importer.parseClassFeature(`
Title: ⏩Targeting - Sword World 2.5 Reference Wiki
Markdown Content:
# ⏩Targeting
Prerequisite: None
Summary: Removes the ranged-attack penalty.
`, "https://sw25.wikidot.com/feat:targeting", { classId: "fighter-id", className: "Fighter", featureType: "feat" });
  assert.equal(ability.name, "⏩Targeting", "abilities keep their authored names (canonicalization is spell-only)");

  record("parse canonicalization: ⏩/△ stripped + persisted, †/‡ preserved, abilities untouched");
}

// ── 2. Shared canonical-match helper (importer refresh + spell drop) ─────────

{
  const markered = { id: "aa", name: "⏩Quick Shield", type: "spell", system: { classId: "sorcerer-id" } };
  const clean = { id: "bb", name: "Quick Shield", type: "spell", system: { classId: "sorcerer-id" } };
  const otherClass = { id: "cc", name: "⏩Quick Shield", type: "spell", system: { classId: "wizard-id" } };
  const otherType = { id: "dd", name: "⏩Quick Shield", type: "ability", system: { classId: "sorcerer-id" } };
  const inventory = [markered, clean, otherClass, otherType];

  const matches = findSw25CanonicalSpellMatches(inventory, "Quick Shield", { classId: "sorcerer-id" });
  assert.deepEqual(matches.map(item => item.id), ["aa", "bb"], "canonical identity matches markered and clean spellings, same class only");

  assert.deepEqual(findSw25CanonicalSpellMatches(inventory, "Quick Shield", { classId: "wizard-id" }).map(item => item.id),
    ["cc"], "other classes are never matched");
  assert.equal(findSw25CanonicalSpellMatches([], "Quick Shield").length, 0, "an empty inventory matches nothing");

  const abilityMatch = findSw25CanonicalSpellMatches(
    [{ id: "ee", name: "⏩Targeting", type: "ability", system: { classId: "sorcerer-id" } }],
    "Targeting", { type: "ability", classId: "sorcerer-id" });
  assert.equal(abilityMatch.length, 1, "the type is part of the identity");

  // Loading never renames: the helper is read-only over the documents.
  assert.equal(markered.name, "⏩Quick Shield", "no document was renamed by a lookup");

  record("shared helper: canonical/type/class identity, 0..n matches, read-only");
}

// ── 3. Refresh: canonical duplicate detection + legacy rename ────────────────

{
  globalThis.Item = globalThis.Item || {};
  globalThis.Item.create = async data => ({ ...data, id: "item-created" });

  const quickShield = parseSpell("Creates a barrier.", "⏩Quick Shield", "https://sw25.wikidot.com/spell:quick-shield");

  // A legacy markered document is found by the canonical parse and REFRESHED —
  // and the refresh now also RENAMES it to the canonical name.
  const updates = [];
  const legacy = {
    id: "legacy-1", name: "⏩Quick Shield", type: "spell", system: { classId: "sorcerer-id" },
    update: async data => { updates.push(data); }
  };
  const refreshed = await SW25Importer.createClassFeature(quickShield, { items: [legacy] });
  assert.equal(refreshed, legacy, "the duplicate is refreshed, not duplicated");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].name, "Quick Shield", "the refresh renames the legacy ⏩ name to canonical");
  assert.equal(updates[0]["system.minorAction"], true, "the marker boolean is re-persisted through the refresh");

  // An already-canonical document is refreshed WITHOUT a gratuitous rename.
  const canonicalUpdates = [];
  const canonicalDoc = {
    id: "canonical-1", name: "Quick Shield", type: "spell", system: { classId: "sorcerer-id" },
    update: async data => { canonicalUpdates.push(data); }
  };
  await SW25Importer.createClassFeature(quickShield, { items: [canonicalDoc] });
  assert.equal(canonicalUpdates.length, 1);
  assert.equal("name" in canonicalUpdates[0], false, "no name key when the stored name is already canonical");

  // † survives the rename: a △-markered legacy name becomes "Fire Storm†".
  const fireStorm = parseSpell("A fire storm.", "⏩Fire Storm†", "https://sw25.wikidot.com/spell:fire-storm");
  const daggerUpdates = [];
  const daggered = {
    id: "legacy-2", name: "△Fire Storm†", type: "spell", system: { classId: "sorcerer-id" },
    update: async data => { daggerUpdates.push(data); }
  };
  await SW25Importer.createClassFeature(fireStorm, { items: [daggered] });
  assert.equal(daggerUpdates[0].name, "Fire Storm†", "the rename strips only the marker; † is preserved");

  // The marker rename is spell-only: abilities are never renamed on refresh.
  const abilityUpdates = [];
  const ability = {
    id: "legacy-3", name: "⏩Targeting", type: "ability", system: { classId: "fighter-id" },
    update: async data => { abilityUpdates.push(data); }
  };
  const abilityParsed = {
    name: "Targeting", type: "ability", classId: "fighter-id", className: "Fighter",
    requirement: "None", mpCost: 0, powerTable: null, critical: "", criticalModifier: "",
    hasPowerTable: false, specialDamageBands: [], metadata: "", description: "", sourceUrl: ""
  };
  await SW25Importer.createClassFeature(abilityParsed, { items: [ability] });
  assert.equal("name" in abilityUpdates[0], false, "abilities keep their authored names on refresh");

  record("refresh: canonical duplicate detection, legacy rename († kept), abilities never renamed");
}

// ── 4. Conflict guard: multiple documents → one canonical identity ───────────

{
  const quickShield = parseSpell("Creates a barrier.", "⏩Quick Shield", "https://sw25.wikidot.com/spell:quick-shield");
  const first = {
    id: "dup-aa", name: "⏩Quick Shield", type: "spell", system: { classId: "sorcerer-id" },
    update: async () => { throw new Error("MUST NOT BE UPDATED"); }
  };
  const second = {
    id: "dup-bb", name: "△Quick Shield", type: "spell", system: { classId: "sorcerer-id" },
    update: async () => { throw new Error("MUST NOT BE UPDATED"); }
  };
  let created = false;
  const actor = {
    items: [first, second],
    createEmbeddedDocuments: async () => { created = true; return []; }
  };
  await assert.rejects(
    () => SW25Importer.createClassFeature(quickShield, actor),
    error => error instanceof Error
      && error.message.includes("dup-aa") && error.message.includes("dup-bb")
      && error.message.includes("Quick Shield"),
    "the conflict is reported naming every colliding document"
  );
  assert.equal(created, false, "the conflict creates nothing");
  assert.deepEqual(actor.items, [first, second], "the conflict deletes/merges nothing: every document is preserved");

  // Same canonical name in a DIFFERENT class is not a conflict: the sorcerer
  // document refreshes while the wizard document is untouched.
  const wizardDoc = {
    id: "wizard-1", name: "Quick Shield", type: "spell", system: { classId: "wizard-id" },
    update: async () => { throw new Error("MUST NOT BE UPDATED"); }
  };
  const sorcererUpdates = [];
  const sorcererDoc = {
    id: "sorcerer-1", name: "⏩Quick Shield", type: "spell", system: { classId: "sorcerer-id" },
    update: async data => { sorcererUpdates.push(data); }
  };
  await SW25Importer.createClassFeature(quickShield, { items: [wizardDoc, sorcererDoc] });
  assert.equal(sorcererUpdates.length, 1, "the same-class document refreshes normally");

  record("conflict guard: detected + reported, nothing updated/created, all preserved; cross-class isolated");
}

// ── 5. Bulk spell-list import keys on canonical identity ─────────────────────

{
  const quickShield = parseSpell("Creates a barrier.", "⏩Quick Shield", "https://sw25.wikidot.com/spell:quick-shield");
  const energyBolt = parseSpell("A bolt of energy.", "Energy Bolt", "https://sw25.wikidot.com/spell:energy-bolt");

  const realFetchPage = SW25Importer.fetchPage;
  const realParseSpellList = SW25Importer.parseSpellList;
  const realParseClassFeature = SW25Importer.parseClassFeature;
  SW25Importer.fetchPage = async () => ({ text: "mock page" });
  SW25Importer.parseSpellList = () => [
    { url: "https://sw25.wikidot.com/spell:quick-shield", level: 1 },
    { url: "https://sw25.wikidot.com/spell:energy-bolt", level: 1 }
  ];
  SW25Importer.parseClassFeature = (text, url) => (String(url).includes("quick-shield") ? quickShield : energyBolt);

  try {
    // A legacy markered spell of the same class is recognized by CANONICAL
    // identity: the list entry is skipped instead of duplicating it.
    const legacy = { id: "bulk-legacy", name: "⏩Quick Shield", type: "spell", system: { classId: "sorcerer-id" } };
    const creations = [];
    const actor = {
      items: [legacy],
      createEmbeddedDocuments: async (type, docs) => {
        creations.push(...docs.map(doc => ({ ...doc, id: `created-${creations.length + 1}` })));
        return creations.slice();
      }
    };
    const result = await SW25Importer.importSpellList("https://sw25.wikidot.com/spells:sorcerer", 10, actor, {
      classId: "sorcerer-id", className: "Sorcerer"
    });
    assert.equal(result.imported, 1, "only the genuinely new spell imports");
    assert.equal(result.skipped, 1, "the markered duplicate is skipped by canonical key");
    assert.equal(creations.length, 1);
    assert.equal(creations[0].name, "Energy Bolt");
    assert.equal(creations[0].system.classId, "sorcerer-id");

    // The same canonical name in ANOTHER class does not block the import.
    const crossClass = { id: "bulk-cross", name: "⏩Quick Shield", type: "spell", system: { classId: "wizard-id" } };
    const crossCreations = [];
    const crossActor = {
      items: [crossClass],
      createEmbeddedDocuments: async (type, docs) => {
        crossCreations.push(...docs.map(doc => ({ ...doc, id: `created-${crossCreations.length + 1}` })));
        return crossCreations.slice();
      }
    };
    const crossResult = await SW25Importer.importSpellList("https://sw25.wikidot.com/spells:sorcerer", 10, crossActor, {
      classId: "sorcerer-id", className: "Sorcerer"
    });
    assert.equal(crossResult.imported, 2, "cross-class names never suppress the import");
    assert.equal(crossResult.skipped, 0);
  } finally {
    Reflect.deleteProperty(SW25Importer, "fetchPage");
    Reflect.deleteProperty(SW25Importer, "parseSpellList");
    Reflect.deleteProperty(SW25Importer, "parseClassFeature");
    void realFetchPage; void realParseSpellList; void realParseClassFeature;
  }

  record("bulk import: canonical keys skip markered duplicates; cross-class names isolated");
}

// ── 6. Special-spell matching runs on the canonical name; loading never renames

{
  assert.equal(isExhaustiveSucking({ name: "Exhaustive Sucking", system: {} }), true, "exact canonical match");
  assert.equal(isExhaustiveSucking({ name: "⏩Exhaustive Sucking", system: {} }), true,
    "a legacy markered name matches through its canonical identity");
  assert.equal(isExhaustiveSucking({
    name: "Unrelated Spell",
    system: { sourceUrl: "https://sw25.wikidot.com/spell:exhaustive-sucking" }
  }), true, "the sourceUrl path is unchanged");
  assert.equal(isExhaustiveSucking({ name: "⏩Other Spell", system: {} }), false);

  const regen = regenerationSpellData({ name: "⏩Bloody Petal", system: { sourceUrl: "" } });
  assert.ok(regen, "regeneration matching stays canonical (Phase 2 behavior)");

  // Loading never renames: the matching layer is read-only over the documents.
  const untouched = { name: "⏩Exhaustive Sucking", system: { sourceUrl: "" } };
  isExhaustiveSucking(untouched);
  regenerationSpellData(untouched);
  assert.equal(untouched.name, "⏩Exhaustive Sucking", "no document is renamed by loading/matching");

  assert.equal(canonicalSpellName("△Fire Storm†").name, "Fire Storm†", "†/‡ survive canonicalization itself");

  record("special matching: canonical name identity, read-only (loading never renames)");
}

console.log("sw25-importer-identity.test.mjs: all importer-identity assertions passed.");
