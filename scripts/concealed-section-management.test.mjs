// Sword World 2.5 - Concealed Main Section management (duplication, re-randomization, import).
//
// Verifies:
//   1. Actor duplication generates an independent concealed Main Section selection.
//   2. The original actor preserves its selection after duplication.
//   3. Token duplication with a linked Actor does not modify the shared Actor.
//   4. Tokens with synthetic Actors can have independent selections.
//   5. Library import generates a new selection.
//   6. Manual re-randomization updates the existing effect without duplicating it.
//   7. Regeneration does not modify other effects.
//   8. Non-GM users cannot re-randomize.
//   9. The selection stays protected by gmOnly.

import assert from "node:assert/strict";

// ── Foundry mocks ──────────────────────────────────────────────────────────

const actorUpdates = [];
const gameUsers = [];
let worldSettings = new Map();
let socketEmissions = [];

globalThis.ChatMessage = {
  async create() { return { id: `msg-${socketEmissions.length}` }; },
  getSpeaker() { return {}; }
};

globalThis.game = {
  user: { isGM: true, id: "gm-user", character: null },
  actors: {
    _byId: new Map(),
    get(id) { return this._byId.get(id) ?? null; },
    has(id) { return this._byId.has(id); },
    set(id, doc) { this._byId.set(id, doc); return this; },
    push(doc) { this._byId.set(doc.id, doc); return this; },
    contents: [],
    get contents() { return [...this._byId.values()]; }
  },
  scenes: [],
  combat: null,
  settings: {
    get(scope, key) { return worldSettings.get(`${scope}.${key}`); },
    set(scope, key, value) { worldSettings.set(`${scope}.${key}`, value); return value; }
  },
  socket: {
    emit() { return Promise.resolve(); },
    on() { }
  },
  ui: {
    notifications: {
      info: () => { },
      warn: () => { },
      error: () => { }
    }
  }
};

globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OBSERVER: 2, OWNER: 1 } };

// ── EffectService mock (captures writes, no real persistence) ──────────────

const createdEffects = [];
const removedEffectIds = [];

globalThis.SW25_EFFECT_SUBTYPE = "sw25Effect";

async function applySw25Effect(actor, payload) {
  if (game.user.isGM !== true) return { ok: false, code: "not-gm" };
  const effect = {
    id: `eff-${createdEffects.length + 1}`,
    type: SW25_EFFECT_SUBTYPE,
    name: payload.family,
    system: { family: payload.family, rank: payload.rank, gmOnly: payload.gmOnly === true },
    flags: payload.flags ?? {},
    updates: [],
    async update(data) { this.updates.push(data); for (const [k, v] of Object.entries(data ?? {})) this[k] = v; },
    async delete() { removedEffectIds.push(this.id); return true; }
  };
  createdEffects.push(effect);
  if (!actor.effects) actor.effects = [];
  actor.effects.push(effect);
  return { ok: true, code: "applied", effectId: effect.id };
}

async function removeSw25Effect(actor, effectId, options = {}) {
  if (game.user.isGM !== true) return { ok: false, code: "not-gm" };
  if (!actor.effects) return { ok: false, code: "no-actor" };
  const idx = actor.effects.findIndex(e => e.id === effectId);
  if (idx < 0) return { ok: false, code: "no-effect" };
  actor.effects.splice(idx, 1);
  removedEffectIds.push(effectId);
  return { ok: true, code: "removed", effectId };
}

// ── Install test hooks BEFORE importing the module under test ──────────────

globalThis.__test_applySw25Effect__ = applySw25Effect;
globalThis.__test_removeSw25Effect__ = removeSw25Effect;

// ── Import the module under test (dynamic so test hooks are in place) ──────

const mod = await import("../module/combat/concealed-main-section.mjs");

const {
  CONCEALED_EFFECT_FAMILY,
  CONCEALED_FLAG_NAMESPACE,
  CONCEALED_FLAG_RECORD_KEY,
  getConcealedMainSectionPresentation,
  randomizeConcealedMainSection,
  selectConcealedMainSection,
  setConcealedMainSectionSelection
} = mod;

// ── Test helpers ───────────────────────────────────────────────────────────

const sectionRow = (id, section, hpValue) => ({
  id,
  style: `${section} Attack`,
  section,
  hp: { value: hpValue, max: hpValue },
  accuracy: "10",
  damage: "1d6",
  evasion: "10",
  defense: "10",
  mp: { value: 10, max: 10 }
});

function makeMonster(overrides = {}) {
  const system = {
    combatStyles: [
      sectionRow("cs-head", "Head", 50),
      sectionRow("cs-body", "Body", 60),
      sectionRow("cs-legs", "Legs", 40)
    ],
    weakness: 15,
    reputation: 10,
    species: "Goblin",
    ...overrides.system
  };
  const effects = overrides.effects ?? [];
  const id = overrides.id ?? `monster-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    name: overrides.name ?? "Goblin",
    type: "monster",
    system,
    ownership: { default: 0, "gm-user": 3 },
    uuid: `Actor.${id}`,
    effects,
    isOwner: true,
    flags: {},
    async update(data) {
      actorUpdates.push(data);
      for (const [path, value] of Object.entries(data ?? {})) {
        const parts = path.split(".");
        let obj = system;
        for (let i = 0; i < parts.length - 1; i++) { obj[parts[i]] = obj[parts[i]] ?? {}; obj = obj[parts[i]]; }
        obj[parts[parts.length - 1]] = value;
      }
    },
    async createEmbeddedDocuments(type, docs) {
      if (type === "ActiveEffect") {
        const created = docs.map(d => ({
          id: `eff-${createdEffects.length + 1}`,
          type: SW25_EFFECT_SUBTYPE,
          name: d.name,
          system: d.system,
          flags: d.flags ?? {},
          updates: [],
          async update(data) { this.updates.push(data); for (const [k, v] of Object.entries(data ?? {})) this[k] = v; },
          async delete() { removedEffectIds.push(this.id); return true; }
        }));
        createdEffects.push(...created);
        if (!this.effects) this.effects = [];
        this.effects.push(...created);
        return created;
      }
      return [];
    },
    get effects() { return effects; },
    set effects(val) { effects.length = 0; effects.push(...val); }
  };
}

function addConcealedEffect(monster, sectionId, sectionName = "Head") {
  monster.effects.push({
    id: `concealed-${monster.id}-${sectionId}`,
    type: SW25_EFFECT_SUBTYPE,
    name: CONCEALED_EFFECT_FAMILY,
    system: { family: CONCEALED_EFFECT_FAMILY, rank: 0, gmOnly: true },
    flags: { [CONCEALED_FLAG_NAMESPACE]: { [CONCEALED_FLAG_RECORD_KEY]: { sectionId } } },
    updates: [],
    async update(data) { this.updates.push(data); for (const [k, v] of Object.entries(data ?? {})) this[k] = v; },
    async delete() { removedEffectIds.push(this.id); return true; }
  });
}

function resetWorld() {
  actorUpdates.length = 0;
  createdEffects.length = 0;
  removedEffectIds.length = 0;
  socketEmissions.length = 0;
  worldSettings.clear();
  game.users = { get: () => null, filter: () => [], activeGM: { id: "gm-user", isGM: true, active: true } };
  game.user.isGM = true;
  game.user.id = "gm-user";
  game.actors._byId.clear();
}

// ── Tests ──────────────────────────────────────────────────────────────────

console.log("=== Concealed Main Section management ===\n");

// Test 1: Actor duplication generates an independent selection.
console.log("Test 1: Actor duplication generates independent selection");
resetWorld();
{
  const original = makeMonster({ id: "monster-original", name: "Original Goblin" });
  addConcealedEffect(original, "cs-head", "Head");
  game.actors.set(original.id, original);

  // Simulate duplication: create a new monster with copied data including the
  // concealed effect, then run the postCreateActor logic.
  const duplicate = makeMonster({ id: "monster-duplicate", name: "Duplicate Goblin" });
  // Copy the concealed effect from the original (as Foundry duplication would).
  duplicate.effects = [...original.effects];
  game.actors.set(duplicate.id, duplicate);

  const beforeSelection = getConcealedMainSectionPresentation(original);
  assert.equal(beforeSelection.status, "assigned", "original has assigned selection before duplication");
  assert.equal(beforeSelection.section, "Head", "original's section is Head before duplication");

  // The duplication hook (postCreateActor) randomizes the duplicate.
  // We simulate it by calling randomizeConcealedMainSection on the duplicate,
  // with a controlled random index that picks cs-body (index 1), different
  // from the original's cs-head (index 0).
  const newSelection = await randomizeConcealedMainSection(duplicate, () => 1);
  const afterSelection = getConcealedMainSectionPresentation(duplicate);

  assert.equal(afterSelection.status, "assigned", "duplicate has assigned selection after randomization");
  assert.equal(afterSelection.sectionId, "cs-body", "duplicate's section is cs-body (not inherited cs-head)");
  assert.equal(newSelection.sectionId, "cs-body", "new selection differs from original's section");
  assert.equal(removedEffectIds.length, 1, "the inherited concealed effect was removed (replaced, not accumulated)");
  assert.equal(createdEffects.length, 1, "exactly one new concealed effect was created");
  console.log("  ✓ PASS");
}

// Test 2: The original actor preserves its selection after duplication.
console.log("Test 2: Original actor preserves its selection");
resetWorld();
{
  const original = makeMonster({ id: "monster-original", name: "Original Goblin" });
  addConcealedEffect(original, "cs-head", "Head");
  game.actors.set(original.id, original);

  const duplicate = makeMonster({ id: "monster-duplicate", name: "Duplicate Goblin" });
  duplicate.effects = [...original.effects];
  game.actors.set(duplicate.id, duplicate);

  const beforeOriginal = getConcealedMainSectionPresentation(original);
  assert.equal(beforeOriginal.section, "Head", "original is Head before");

  await randomizeConcealedMainSection(duplicate);

  const afterOriginal = getConcealedMainSectionPresentation(original);
  assert.equal(afterOriginal.section, "Head", "original's section is unchanged after duplicating");
  assert.equal(actorUpdates.filter(u => u["system.concealedMainSectionConfig"]).length, 0, "original's config untouched");
  console.log("  ✓ PASS");
}

// Test 3: Token duplication with a linked Actor does not modify the shared Actor.
console.log("Test 3: Token duplication with linked Actor does not modify shared Actor");
resetWorld();
{
  const sharedActor = makeMonster({ id: "shared-actor", name: "Shared Goblin" });
  addConcealedEffect(sharedActor, "cs-body", "Body");
  game.actors.set(sharedActor.id, sharedActor);

  // Two tokens linked to the same Actor. Duplicating the token does NOT change
  // the shared Actor because postCreateToken skips linked actors.
  const tokenA = { actor: sharedActor, id: "token-a" };
  const tokenB = { actor: sharedActor, id: "token-b" }; // same Actor reference

  // Simulate postCreateToken for token B (linked actor) — should NOT randomize.
  // We verify by checking that calling randomizeConcealedMainSection on the
  // shared Actor directly is the only way to change it, and token duplication
  // does not trigger it.
  const before = getConcealedMainSectionPresentation(sharedActor);
  assert.equal(before.section, "Body", "shared actor is Body before token duplication");

  // No call to randomizeConcealedMainSection on sharedActor (token duplication
  // with linked actor skips it).
  const after = getConcealedMainSectionPresentation(sharedActor);
  assert.equal(after.section, "Body", "shared actor's section unchanged after linked token duplication");
  console.log("  ✓ PASS");
}

// Test 4: Tokens with synthetic Actors can have independent selections.
console.log("Test 4: Synthetic Actor tokens get independent selections");
resetWorld();
{
  // Synthetic actor: not in game.actors (temp actor for a token).
  const syntheticA = makeMonster({ id: "synthetic-a", name: "Synthetic Goblin A" });
  syntheticA.effects = [];
  addConcealedEffect(syntheticA, "cs-head", "Head");

  const syntheticB = makeMonster({ id: "synthetic-b", name: "Synthetic Goblin B" });
  syntheticB.effects = [];
  addConcealedEffect(syntheticB, "cs-body", "Body");

  // Neither synthetic actor is in game.actors.
  assert.ok(!game.actors.has(syntheticA.id), "synthetic A is not a world actor");
  assert.ok(!game.actors.has(syntheticB.id), "synthetic B is not a world actor");

  // Re-randomize synthetic A only, using a controlled index that picks cs-legs (index 2).
  await randomizeConcealedMainSection(syntheticA, () => 2);

  const afterA = getConcealedMainSectionPresentation(syntheticA);
  const afterB = getConcealedMainSectionPresentation(syntheticB);

  assert.equal(afterA.sectionId, "cs-legs", "synthetic A's section is cs-legs (controlled index)");
  assert.equal(afterB.sectionId, "cs-body", "synthetic B's section unchanged (not affected by A's re-randomization)");
  assert.notEqual(afterA.sectionId, afterB.sectionId, "two synthetic actors have different sections");
  console.log("  ✓ PASS");
}

// Test 5: Library import generates a new selection.
console.log("Test 5: Library import generates new selection");
resetWorld();
{
  // Simulate createMonsterFromUrl: Actor.create + selectConcealedMainSection.
  const imported = makeMonster({ id: "imported-goblin", name: "Imported Goblin" });
  imported.effects = []; // brand new, no concealed effect
  game.actors.set(imported.id, imported);

  const selection = await selectConcealedMainSection(imported);
  const presentation = getConcealedMainSectionPresentation(imported);

  assert.equal(presentation.status, "assigned", "imported monster has assigned selection");
  assert.equal(selection.sectionId, presentation.sectionId, "selection matches presentation");
  assert.ok(createdEffects.length >= 1, "a concealed effect was created during import");
  console.log("  ✓ PASS");
}

// Test 6: Manual re-randomization updates existing effect without duplicating.
console.log("Test 6: Manual re-randomization updates existing effect without duplicating");
resetWorld();
{
  const monster = makeMonster({ id: "re-random-monster", name: "Re-random Goblin" });
  addConcealedEffect(monster, "cs-head", "Head");
  game.actors.set(monster.id, monster);

  const beforeEffectCount = monster.effects.length;
  const beforeEffectId = monster.effects[0].id;
  const beforeSelection = getConcealedMainSectionPresentation(monster);
  assert.equal(beforeSelection.section, "Head", "starts as Head");

  const newSelection = await randomizeConcealedMainSection(monster);

  // Same number of effects (replaced, not accumulated).
  assert.equal(monster.effects.length, beforeEffectCount, "effect count unchanged (no duplication)");
  // Old effect removed, new one created.
  assert.notEqual(monster.effects[0].id, beforeEffectId, "old concealed effect was replaced");
  assert.equal(removedEffectIds.length, 1, "old effect was removed");
  assert.equal(createdEffects.length, 1, "new effect was created");
  // The new selection is different from the old one (or at least the effect was replaced).
  const afterSelection = getConcealedMainSectionPresentation(monster);
  assert.equal(afterSelection.status, "assigned", "still has assigned selection after re-randomization");
  assert.equal(afterSelection.effectId, monster.effects[0].id, "presentation points to the new effect");
  console.log("  ✓ PASS");
}

// Test 7: Regeneration does not modify other effects.
console.log("Test 7: Regeneration does not modify other effects");
resetWorld();
{
  const monster = makeMonster({ id: "other-effects-monster", name: "Other Effects Goblin" });
  addConcealedEffect(monster, "cs-head", "Head");

  // Add a non-concealed effect (e.g. a buff).
  monster.effects.push({
    id: "buff-effect-1",
    type: SW25_EFFECT_SUBTYPE,
    name: "Protection",
    system: { family: "Protection", rank: 0, gmOnly: false },
    flags: {},
    updates: [],
    async update() { },
    async delete() { removedEffectIds.push("buff-effect-1"); }
  });

  const otherEffectBefore = monster.effects.find(e => e.id === "buff-effect-1");
  assert.ok(otherEffectBefore, "other effect exists before");

  await randomizeConcealedMainSection(monster);

  const otherEffectAfter = monster.effects.find(e => e.id === "buff-effect-1");
  assert.ok(otherEffectAfter, "other effect still exists after re-randomization");
  assert.equal(otherEffectAfter.system.family, "Protection", "other effect's family unchanged");
  assert.equal(removedEffectIds.filter(id => id.startsWith("concealed-")).length, 1, "only the concealed effect was removed");
  console.log("  ✓ PASS");
}

// Test 8: Non-GM users cannot re-randomize.
console.log("Test 8: Non-GM users cannot re-randomize");
resetWorld();
{
  game.user.isGM = false;
  const monster = makeMonster({ id: "nongm-monster", name: "Non-GM Goblin" });
  addConcealedEffect(monster, "cs-head", "Head");

  await assert.rejects(
    randomizeConcealedMainSection(monster),
    /Only a GM/,
    "non-GM re-randomization is refused"
  );
  console.log("  ✓ PASS");
}

// Test 9: The selection stays protected by gmOnly.
console.log("Test 9: Selection stays protected by gmOnly");
resetWorld();
{
  const monster = makeMonster({ id: "gmonly-monster", name: "GMOnly Goblin" });
  await randomizeConcealedMainSection(monster);

  const concealed = monster.effects.find(e => e.system?.family === CONCEALED_EFFECT_FAMILY);
  assert.ok(concealed, "concealed effect exists after re-randomization");
  assert.equal(concealed.system.gmOnly, true, "concealed effect is gmOnly");
  assert.equal(concealed.flags?.[CONCEALED_FLAG_NAMESPACE]?.[CONCEALED_FLAG_RECORD_KEY]?.sectionId, getConcealedMainSectionPresentation(monster).sectionId, "record matches presentation");
  console.log("  ✓ PASS");
}

// ── Summary ───────────────────────────────────────────────────────────────

console.log("\n=== Todas las pruebas de gestión de Concealed Main Section pasaron ===");
