// Sword World 2.5 - centralized Spellcasting flow tests.
//
// Exercises the COMPLETE cast operation of rules/spell-cast.mjs end to end
// (Core Rulebook I pp. 159-175), with the real effect service underneath:
//   - Ordinary Major Action cast with effective Magic Power; the SV is
//     computed ONCE from the natural 2d6 + Magic Power and never re-derived.
//   - Natural double 1: automatic failure — MP stay spent, no effects, no
//     damage, the card offers the voluntary Automatic Failure registration.
//   - Natural double 6: automatic success and +5 SV.
//   - A modified total of 12 built WITHOUT a natural double 6 never adds
//     the +5.
//   - Minor Action (⏩) and Combat Preparation (△): no check, SV 0, separate
//     flows; the preparation is once per name.
//   - Resistances: Neg/Half per target with different outcomes (characters
//     roll Willpower; monsters resolve X(Y) passively or actively, with
//     automatic results); Optional accepts/rejects per target; ties resist.
//   - Instant/X persistent components are created at CAST time (SV 0 for
//     the no-check modalities), never for a resisted target, and never by
//     the damage path; a Power Table fumble never cancels them.
//   - The Power Table damage transports the AUTHENTIC cast SV and never
//     derives one; a fumble of the table is only a damage fumble.
//   - Automatic Failure registration is voluntary (button, no auto counter,
//     no auto experience).

import assert from "node:assert/strict";

// ── Global Foundry environment mock (before any module import) ─────────────

let rollQueue = [];
const chatCreations = [];
const rollMessages = [];
const socketEmissions = [];
const registeredHooks = new Map();

class MockRoll {
  constructor(formula) {
    this.formula = formula;
    this.dice = [];
  }

  async evaluate() {
    const script = rollQueue.shift();
    assert.ok(script, `No scripted roll for "${this.formula}" (queue empty)`);
    this.dice = [{ results: script.map(value => ({ result: value, active: true })) }];
    // Foundry's Roll.total is the FULL formula total: the natural dice plus
    // every constant modifier in the formula (e.g. "2d6 + 6"). The natural
    // dice alone stay available on this.dice for the automatic-result
    // detection, exactly like the real Roll.
    const diceSum = script.reduce((sum, value) => sum + value, 0);
    const constants = String(this.formula)
      .replace(/\d*d\d+/gi, " ")
      .match(/[+-]?\d+/g) ?? [];
    this._total = diceSum + constants.reduce((sum, term) => sum + Number(term), 0);
    this._diceTotal = diceSum;
    return this;
  }

  get total() { return this._total; }
  get diceTotal() { return this._diceTotal; }

  async toMessage(message) { rollMessages.push({ formula: this.formula, total: this.total, message }); }
}

MockRoll.messages = rollMessages;

let nextMockId = 1;

class MockEffect {
  constructor(data) {
    Object.assign(this, data);
    this.id = data.id ?? `ef-${nextMockId++}`;
    this.system = data.system ?? {};
  }
  async delete() {
    const owner = actorsCollection.find(actor => actor.effects.includes(this));
    if (owner) owner.effects = owner.effects.filter(effect => effect !== this);
    return this;
  }
}

class MockItemCollection extends Array {
  get(id) { return this.find(item => item.id === id) ?? null; }
}

class MockActor {
  constructor(id, name, system = {}) {
    this.id = id;
    this.uuid = `Actor.${id}`;
    this.name = name;
    this.type = system.type ?? "character";
    this.isOwner = true;
    this.items = MockItemCollection.from(system.items ?? []);
    this.effects = [];
    this.flags = {};
    this.system = system;
  }
  getFlag(scope, key) { return this.flags[`${scope}:${key}`]; }
  async setFlag(scope, key, value) { this.flags[`${scope}:${key}`] = value; return this; }
  async unsetFlag(scope, key) { delete this.flags[`${scope}:${key}`]; return this; }
  async createEmbeddedDocuments(type, dataArray) {
    const created = [];
    for (const data of dataArray) {
      const effect = new MockEffect({ ...data, id: `ef-${nextMockId++}` });
      this.effects.push(effect);
      created.push(effect);
    }
    return created;
  }
  async deleteEmbeddedDocuments(type, ids) {
    const removed = [];
    for (const id of ids) {
      const effect = this.effects.find(candidate => candidate.id === id);
      if (effect) removed.push(effect);
    }
    this.effects = this.effects.filter(effect => !removed.includes(effect));
    return removed;
  }
  async update(changes) { applyFlattened(this, changes); return this; }
}

function applyFlattened(target, changes) {
  for (const [key, value] of Object.entries(changes)) {
    const path = key.split(".");
    let node = target;
    for (const part of path.slice(0, -1)) node = node[part] ?? (node[part] = {});
    node[path.at(-1)] = value;
  }
}

const actorsCollection = [];
const spellCollection = new Map();
let gameTargets = [];
let combatState = null;

globalThis.Roll = MockRoll;
globalThis.ChatMessage = {
  getSpeaker({ actor } = {}) { return { actor }; },
  async create(data) {
    chatCreations.push(data);
    return { id: `create-${chatCreations.length}` };
  }
};
globalThis.fromUuid = async uuid => spellCollection.get(uuid)
  ?? actorsCollection.find(a => a.uuid === uuid) ?? null;
globalThis.Hooks = {
  on(name, fn) {
    const list = registeredHooks.get(name) ?? [];
    list.push(fn);
    registeredHooks.set(name, list);
  }
};
globalThis.ui = {
  notifications: {
    warn(message) { uiMessages.push({ kind: "warn", message }); },
    info() {},
    error() {}
  }
};
const uiMessages = [];
globalThis.foundry = {
  data: { ActiveEffectTypeDataModel: class ActiveEffectTypeDataModelStub {} },
  utils: {
    escapeHTML: value => String(value ?? ""),
    randomID() { return `r${Math.random().toString(36).slice(2, 12)}`; }
  }
};

globalThis.game = {
  get user() {
    return { isGM: true, id: "gm-user", get targets() { return gameTargets; } };
  },
  actors: actorsCollection,
  items: { get: uuid => spellCollection.get(uuid) ?? null },
  get targets() { return gameTargets; },
  users: { get activeGM() { return { id: "gm-user" }; } },
  socket: {
    async emit(_channel, payload) { socketEmissions.push(payload); },
    on() {}
  },
  get combat() { return combatState; },
  combats: { get: () => null }
};

// ── Fixtures ───────────────────────────────────────────────────────────────

const CLASS = (id, name, level) => ({ type: "class", id, name, system: { level, category: "B", classType: "Wizard" } });
const SPELL = (id, name, system) => {
  const spell = { type: "spell", id, name, system: { className: "Sorcerer", specialDamageBands: [], ...system } };
  spell.uuid = `Actor.caster.Item.${id}`;
  spellCollection.set(spell.uuid, spell);
  return spell;
};

// Caster: Sorcerer 5, Intelligence 12 (bonus 2) → Magic Power 7 (no ledger).
const caster = new MockActor("caster", "Caster", {
  type: "character",
  abilityBases: { mind: 12 },
  abilityAdjustments: {},
  mp: { value: 20, max: 20 },
  hp: { value: 20, max: 20 },
  combat: {},
  items: [CLASS("cls-sorcerer", "Sorcerer", 5)]
});
actorsCollection.push(caster);

const setCombat = () => {
  combatState = {
    id: "combat-1",
    round: 1,
    combatants: [{ id: "cmbt-caster", actorUuid: caster.uuid, tokenId: "tkn-caster", actor: caster }]
  };
};
const clearCombat = () => { combatState = null; };

// Generic Power Table spell, Resistance: Half, Instant/X (2 rounds).
const frostWave = SPELL("frost-wave", "Frost Wave", {
  mpCost: 6,
  hasPowerTable: true,
  critical: 10,
  powerTable: { 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 12, 11: 14, 12: 16 },
  metadata: "Target: 1 enemy\nDuration: Instant/2 rounds\nResistance: Half"
});

// Unresistable self-buff, Instant/X (3 rounds), ⏩ Minor Action.
const quickShield = SPELL("quick-shield", "⏩Quick Shield", {
  mpCost: 4,
  hasPowerTable: false,
  metadata: "Target: Self\nDuration: Instant/3 rounds\nResistance: Can't"
});

// Same spell without the ⏩ marker (to prove the marker is required).
const quickShieldCopy = SPELL("quick-shield-copy", "Quick Shield", {
  mpCost: 4,
  metadata: "Target: Self\nDuration: Instant/3 rounds\nResistance: Can't"
});

// △ Combat Preparation spell, Instant/X (2 turns).
const wardSigil = SPELL("ward-sigil", "△Ward Sigil", {
  mpCost: 5,
  metadata: "Target: Self\nDuration: Instant/2 turns\nResistance: Can't"
});

// Neg spell with a persistent part, for resisted/created-per-target checks.
const venomMark = SPELL("venom-mark", "Venom Mark", {
  mpCost: 8,
  hasPowerTable: false,
  metadata: "Target: 1 enemy\nDuration: Instant/3 rounds\nResistance: Negates\nType: Poison"
});

// Simple non-persistent damage spell, Resistance: Half.
const fireBolt = SPELL("fire-bolt", "Fire Bolt", {
  mpCost: 6,
  hasPowerTable: true,
  critical: 10,
  powerTable: { 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 12, 11: 14, 12: 16 },
  metadata: "Target: 1 enemy\nDuration: Instant\nResistance: Half"
});

const monsterOf = (id, name, willpower) => {
  const monster = new MockActor(id, name, {
    type: "monster",
    willpower,
    combatStyles: [{ id: "s1", style: "Weapon", hp: { value: 20 } }],
    mp: { value: 0 },
    hp: { value: 20 }
  });
  actorsCollection.push(monster);
  return monster;
};

const record = label => console.log(`  ${label}`);

const lastCard = () => chatCreations.at(-1)?.content ?? "";
const cardCount = () => chatCreations.length;
const castCards = () => chatCreations.filter(c => String(c.content ?? "").includes("spell-card"));
const lastCastCard = () => castCards().at(-1)?.content ?? "";

// Dialog overrides so each scenario controls Optional decisions and monster
// modes without UI.
const dialogs = {
  askOptional: async (_target, _spell) => dialogs.optionalAnswer ?? false,
  askMonsterMode: async (_monster, _check) => dialogs.monsterMode ?? "passive"
};
function resetDialogs() {
  dialogs.optionalAnswer = null;
  dialogs.monsterMode = "passive";
}

// ── Module imports (after the environment mock) ────────────────────────────

const service = await import("../module/effects/effect-service.mjs");
const spellCastModule = await import("../module/rules/spell-cast.mjs");
const spellDamageModule = await import("../module/rules/spell-damage.mjs");
const criticalModule = await import("../module/rules/critical-failure.mjs");

const { registerSw25StackingResolver, initializeEffectService } = service;
const {
  castSpellAsMajor,
  castSpellAsMinor,
  castSpellInCombatPreparation,
  computeSpellcastingValue,
  getSpellResistance,
  isMinorActionSpell,
  isCombatPreparationSpell,
  parseMonsterResistance,
  characterWillpower,
  resolveTargetResistance,
  resolveCastingClass,
  spellAlreadyCastInCombatPreparation
} = spellCastModule;
const { rollSpellPowerTableDamage } = spellDamageModule;
const { registerAutomaticFailure } = criticalModule;

registerSw25StackingResolver(() => ({ outcome: "accumulate" }));
initializeEffectService();

// ── Pure helpers ───────────────────────────────────────────────────────────

// Resistance parsing (imported wiki variants normalize to approved ids).
assert.equal(getSpellResistance(frostWave), "half");
assert.equal(getSpellResistance({ system: { metadata: "Resistance: Negates" } }), "neg");
assert.equal(getSpellResistance({ system: { metadata: "Resistance: Can't" } }), "cant");
assert.equal(getSpellResistance({ system: { metadata: "Resistance: Can’t" } }), "cant");
assert.equal(getSpellResistance({ system: { metadata: "Resistance: Optional" } }), "optional");
assert.equal(getSpellResistance({ system: { metadata: "Resistance: None" } }), "none");
assert.equal(getSpellResistance({ system: { metadata: "Resistance: Temporary" } }), "temporary");
assert.equal(getSpellResistance({ system: { metadata: "Cost: MP6" } }), null);
record("resistance field parsing (Negates/Can't/Can’t/Optional/None/Temporary)");

// Modality markers come from the authored name.
assert.ok(isMinorActionSpell(quickShield));
assert.ok(!isMinorActionSpell(quickShieldCopy));
assert.ok(isCombatPreparationSpell(wardSigil));
assert.ok(!isCombatPreparationSpell(quickShield));
record("⏩/△ modality markers detected from the authored name");

// Pure SV computation: the +5 is a declared automatic-success input, never
// derived from a modified total.
assert.deepEqual(computeSpellcastingValue({ natural: 8, magicPower: 4 }), { natural: 8, magicPower: 4, automaticSuccess: false, successValue: 12 });
assert.deepEqual(computeSpellcastingValue({ natural: 12, magicPower: 4, automaticSuccess: true }), { natural: 12, magicPower: 4, automaticSuccess: true, successValue: 21 });
record("SV computation keeps natural, Magic Power and SV separate");

// Monster X(Y) parsing.
assert.deepEqual(parseMonsterResistance("3 (10)"), { active: 3, passive: 10 });
assert.deepEqual(parseMonsterResistance("-1 (6)"), { active: -1, passive: 6 });
assert.deepEqual(parseMonsterResistance("2"), { active: 2, passive: null });
assert.equal(parseMonsterResistance("garbled"), null);
record("monster X(Y) resistance notation parsed (active/passive)");

// Character Willpower: highest class level + Spirit + ledger resistances.
{
  const actor = new MockActor("w1", "Willpower One", {
    items: [CLASS("c1", "Sorcerer", 5)],
    abilityBases: { mind: 13 },
    abilityAdjustments: {}
  });
  assert.equal(characterWillpower(actor), 5 + 2, "level 5 + Spirit 2");
  actor.system.sw25EffectMods = { resistances: { willpower: 1 } };
  assert.equal(characterWillpower(actor), 8, "the effect ledger adds to Willpower");
  record("character Willpower = highest class level + Spirit + ledger");
}

// Pure resistance resolution: ordinary comparison is STRICT (ties resist).
{
  const affected = resolveTargetResistance({ type: "neg", successValue: 15, roll: { dice: [{ results: [{ result: 5, active: true }, { result: 5, active: true }] }], total: 10 } });
  assert.equal(affected.resisted, false, "SV 15 beats total 10");
  const tie = resolveTargetResistance({ type: "neg", successValue: 15, roll: { dice: [{ results: [{ result: 7, active: true }, { result: 8, active: true }] }], total: 15 } });
  assert.equal(tie.resisted, true, "a tie resists (SV must strictly exceed)");
  const autoFail = resolveTargetResistance({ type: "neg", successValue: 5, roll: { dice: [{ results: [{ result: 1, active: true }, { result: 1, active: true }] }], total: 2 } });
  assert.equal(autoFail.resisted, false, "resistance double 1 is an automatic resistance failure");
  assert.equal(autoFail.automaticFailure, true);
  const autoSuccess = resolveTargetResistance({ type: "neg", successValue: 30, roll: { dice: [{ results: [{ result: 6, active: true }, { result: 6, active: true }] }], total: 12 } });
  assert.equal(autoSuccess.resisted, true, "resistance double 6 is an automatic resistance success");
  const passive = resolveTargetResistance({ type: "half", successValue: 10, passiveDifficulty: 10 });
  assert.equal(passive.resisted, true, "SV 10 does not strictly exceed passive 10");
  assert.equal(passive.halfDamage, true, "a resisted Half outcome halves the damage");
  assert.equal(passive.effectsNullified, true, "a resisted Half outcome nullifies extra effects");
  const passiveHit = resolveTargetResistance({ type: "half", successValue: 11, passiveDifficulty: 10 });
  assert.equal(passiveHit.resisted, false);
  assert.equal(passiveHit.halfDamage, false, "a non-resisted Half outcome keeps full damage");
  const pending = resolveTargetResistance({ type: "temporary" });
  assert.equal(pending.pending, true, "Temporary stays pending (no invented rule)");
  const optionalReject = resolveTargetResistance({ type: "optional", decision: true });
  assert.equal(optionalReject.resisted, true, "an Optional target that wants to resist automatically succeeds");
  const optionalAccept = resolveTargetResistance({ type: "optional", decision: false });
  assert.equal(optionalAccept.resisted, false);
  record("pure resistance outcomes (strict comparison, automatics, Half, Temporary, Optional)");
}

// Casting class resolution.
assert.equal(resolveCastingClass(caster, fireBolt)?.id, "cls-sorcerer");
record("casting class resolved from the spell assignment");

// ── 1. Ordinary Major Action cast: effective Magic Power, SV computed once ──

{
  resetDialogs();
  clearCombat();
  gameTargets = [{ actor: monsterOf("m1", "Goblin", "3 (10)") }];
  rollQueue = [[4, 4]]; // natural 8 → SV 8 + 7 = 15 > passive 10 → affected
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: fireBolt, dialogs });
  assert.equal(result.cast, true);
  assert.equal(result.check.natural, 8);
  assert.equal(result.check.magicPower, 7);
  assert.equal(result.check.automaticFailure, false);
  assert.equal(result.check.automaticSuccess, false);
  assert.equal(result.check.successValue, 15);
  assert.equal(caster.system.mp.value, 14, "MP deducted before the roll (20 - 6)");
  assert.equal(result.targetResults[0].resisted, false, "SV 15 beats the passive difficulty 10");
  const card = lastCastCard();
  assert.ok(card.includes("natural 8"), "the natural result is preserved separately");
  assert.ok(card.includes("Magic Power 7"), "the effective Magic Power is preserved separately");
  assert.ok(card.includes("SV 15"), "the SV is computed once from natural + Magic Power");
  assert.ok(!card.includes("+5"), "an ordinary cast never adds the automatic +5");
  assert.ok(card.includes("data-success-value=\"15\""), "the Roll Damage button carries the AUTHENTIC cast SV");
  assert.equal(result.mpSpent, 6);
  record("case 1: ordinary Major cast — SV 15 = natural 8 + Magic Power 7, MP spent before the roll");
}

// ── 2. Natural double 1: automatic failure, MP spent, nothing else ─────────

{
  resetDialogs();
  setCombat(); // anchor would be available, but a failure creates nothing
  gameTargets = [{ actor: monsterOf("m2", "Orc", "2 (9)") }];
  rollQueue = [[1, 1]];
  chatCreations.length = 0;
  const before = cardCount();
  const result = await castSpellAsMajor({ actor: caster, spell: venomMark, dialogs });
  assert.equal(result.cast, false);
  assert.equal(result.automaticFailure, true);
  assert.equal(caster.system.mp.value, 6, "the MP cost is still paid (14 - 8)");
  assert.equal(rollQueue.length, 0, "no resistance rolls and no damage rolls after a failed cast");
  const card = lastCastCard();
  assert.ok(card.includes("CRITICAL FAILURE"), "the card marks the automatic failure");
  assert.ok(card.includes("register-automatic-failure"), "the card offers the voluntary Automatic Failure registration");
  const target = gameTargets[0].actor;
  assert.equal(target.effects.length, 0, "a failed cast creates NO persistent effect");
  assert.ok(!card.includes("Roll Damage"), "a failed cast offers no damage roll");
  assert.equal(chatCreations.length - before, 1, "exactly the failure card was posted");
  record("case 2: natural double 1 — automatic failure, MP spent, no effects, registration offered");
}

// ── 3. Natural double 6: automatic success and +5 SV ───────────────────────

{
  resetDialogs();
  clearCombat();
  gameTargets = [{ actor: monsterOf("m3", "Hydra", "1 (12)") }];
  rollQueue = [[6, 6]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: fireBolt, dialogs });
  assert.equal(result.cast, true);
  assert.equal(result.check.automaticSuccess, true);
  assert.equal(result.check.successValue, 12 + 5 + 7, "SV = natural 12 + 5 (automatic success) + Magic Power 7");
  const card = lastCastCard();
  assert.ok(card.includes("+5 (automatic success)"), "the card shows the automatic-success bonus");
  assert.ok(card.includes(`SV ${12 + 5 + 7}`));
  assert.ok(card.includes('data-success-value="' + (12 + 5 + 7) + '"'), "the +5 SV is the transported cast SV");
  assert.equal(result.targetResults[0].resisted, false, "SV 24 beats the passive difficulty 12");
  record("case 3: natural double 6 — automatic success, +5 SV");
}

// ── 4. A modified total of 12 WITHOUT a natural double 6 adds no +5 ────────

{
  resetDialogs();
  clearCombat();
  // Level 3 Sorcerer + Intelligence 6 (bonus 1) → Magic Power 4; natural
  // 8 + 4 = 12.
  const lowCaster = new MockActor("low", "Low Caster", {
    type: "character",
    abilityBases: { mind: 6 },
    abilityAdjustments: {},
    mp: { value: 20, max: 20 },
    combat: {},
    items: [CLASS("cls-low", "Sorcerer", 3)]
  });
  actorsCollection.push(lowCaster);
  gameTargets = [{ actor: monsterOf("m4", "Kobold", "0 (20)") }];
  rollQueue = [[5, 3]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: lowCaster, spell: fireBolt, dialogs });
  assert.equal(result.cast, true);
  assert.equal(result.check.automaticSuccess, false, "8 is not a natural double 6");
  assert.equal(result.check.successValue, 12, "the SV 12 is ordinary: natural 8 + Magic Power 4, no +5");
  const card = lastCastCard();
  assert.ok(card.includes("SV 12"));
  assert.ok(!card.includes("automatic success"), "no automatic-success text without natural double 6");
  record("case 4: modified total 12 without a natural double 6 — no +5");
}

// ── 5. Minor Action (⏩): no check, SV 0, persistent component with SV 0 ────

{
  resetDialogs();
  setCombat(); // rounds scale needs the caster anchor
  caster.system.mp.value = 20; // fresh resource for this scenario
  gameTargets = []; // self-cast: a Can't spell resolves onto the caster
  rollQueue = []; // NO roll may be consumed
  chatCreations.length = 0;
  const result = await castSpellAsMinor({ actor: caster, spell: quickShield, dialogs });
  assert.equal(result.cast, true);
  assert.equal(result.successValue, 0, "the Minor Action SV is 0");
  assert.equal(rollQueue.length, 0, "no dice are rolled (no Spellcasting check, no resistance roll for Can't)");
  assert.equal(caster.system.mp.value, 16, "MP per cast (20 - 4)");
  const card = lastCastCard();
  assert.ok(card.includes("Minor Action"), "the card states the modality");
  assert.ok(card.includes("SV 0"));
  assert.equal(caster.effects.length, 1, "the persistent component IS created at cast time");
  assert.equal(caster.effects[0].system.successValue, 0, "the persistent component carries SV 0");
  assert.equal(caster.effects[0].system.family, "⏩Quick Shield", "DEC-1 family keeps the authoring marker");
  assert.equal(caster.effects[0].system.durationScale, "rounds");
  assert.equal(caster.effects[0].system.remainingDuration, 3);
  record("case 5: Minor Action — no check, SV 0, MP spent, persistent component with SV 0");
}

// ── 6. A spell without the ⏩ marker cannot use the Minor Action flow ───────

{
  resetDialogs();
  clearCombat();
  gameTargets = [];
  chatCreations.length = 0;
  const mpBefore = caster.system.mp.value;
  const result = await castSpellAsMinor({ actor: caster, spell: quickShieldCopy, dialogs });
  assert.equal(result.cast, false, "the copy without ⏩ is rejected");
  assert.equal(caster.system.mp.value, mpBefore, "no MP is spent on a rejected modality");
  assert.ok(uiMessages.some(m => m.kind === "warn" && m.message.includes("Minor Action")));
  record("case 6: the ⏩ marker is mandatory for the Minor Action flow");
}

// ── 7. Combat Preparation (△): SV 0, once per name per preparation ─────────

{
  resetDialogs();
  setCombat();
  gameTargets = [];
  chatCreations.length = 0;
  caster.flags["sw25-taka:combatPreparationCasts"] = undefined;
  rollQueue = [];
  const first = await castSpellInCombatPreparation({ actor: caster, spell: wardSigil, dialogs });
  assert.equal(first.cast, true);
  assert.equal(first.successValue, 0, "the Combat Preparation SV is 0");
  assert.equal(rollQueue.length, 0, "no Spellcasting check during Combat Preparation");
  assert.equal(caster.effects.length, 2, "the second persistent component (2 turns) was created");
  assert.equal(caster.effects[1].system.durationScale, "turns");
  const mpAfterFirst = caster.system.mp.value;

  chatCreations.length = 0;
  const second = await castSpellInCombatPreparation({ actor: caster, spell: wardSigil, dialogs });
  assert.equal(second.cast, false, "the same name cannot be cast twice in one Combat Preparation");
  assert.equal(caster.system.mp.value, mpAfterFirst, "the blocked cast spends no MP");
  assert.ok(uiMessages.some(m => m.kind === "warn" && m.message.includes("already been cast")));

  // A different name is still allowed in the same preparation.
  const other = SPELL("other-ward", "△Other Ward", { mpCost: 1, metadata: "Duration: Instant\nResistance: Can't" });
  const third = await castSpellInCombatPreparation({ actor: caster, spell: other, dialogs });
  assert.equal(third.cast, true, "a different spell may still be cast during the same preparation");

  assert.equal(spellAlreadyCastInCombatPreparation(caster, wardSigil), true);
  record("case 7: Combat Preparation — no check, SV 0, once per name, different names allowed");
}

// ── 8. Neg resistance: per-target Willpower with independent results ───────

{
  resetDialogs();
  clearCombat();
  const targetA = new MockActor("neg-a", "Target A", {
    type: "character",
    items: [CLASS("c-a", "Fighter", 4)],
    abilityBases: { mind: 12 },
    abilityAdjustments: {},
    hp: { value: 10 }
  });
  const targetB = new MockActor("neg-b", "Target B", {
    type: "character",
    items: [CLASS("c-b", "Fighter", 3)],
    abilityBases: { mind: 6 },
    abilityAdjustments: {},
    hp: { value: 10 }
  });
  actorsCollection.push(targetA, targetB);
  gameTargets = [{ actor: targetA }, { actor: targetB }];
  // Cast check: natural 10 + Magic Power 5 = 15. Target A (Willpower
  // 4 + 2 = 6): 2d6+6 → 14 (affected); target B (Willpower 3 + 1 = 4):
  // 2d6+4 → 15 (tie → resists).
  const negCaster = new MockActor("negcaster", "Neg Caster", {
    type: "character",
    abilityBases: { mind: 5 },
    abilityAdjustments: {},
    mp: { value: 20 },
    combat: {},
    items: [CLASS("cls-neg", "Sorcerer", 5)]
  });
  actorsCollection.push(negCaster);
  rollQueue = [[5, 5], [3, 5], [5, 6]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: negCaster, spell: venomMark, dialogs });
  assert.equal(result.cast, true);
  assert.equal(result.check.successValue, 15, "SV 15 = natural 10 + Magic Power 5");
  assert.equal(result.targetResults[0].resisted, false, "SV 15 beats A's total 10");
  assert.equal(result.targetResults[1].resisted, true, "A tie resists: B's total 15 equals SV 15");
  const card = lastCastCard();
  assert.ok(card.includes("<strong>Target A:</strong> affected"), "A's independent outcome");
  assert.ok(card.includes("<strong>Target B:</strong> resisted"), "B's independent outcome");
  assert.equal(rollMessages.length, 2, "each target rolled its own Willpower check (the cast check posts no roll message)");
  assert.ok(rollMessages.at(-2).message.flavor.includes("Target A"), "A's Willpower roll message");
  assert.ok(rollMessages.at(-1).message.flavor.includes("Target B"), "B's Willpower roll message");
  record("case 8: Neg — one shared cast check, independent per-target Willpower, ties resist");
}

// ── 9. Half resistance with different per-target outcomes and effects ──────

{
  resetDialogs();
  setCombat();
  const monsterA = monsterOf("half-a", "Griffin A", "0 (8)");  // SV 16 > 8 → affected
  const monsterB = monsterOf("half-b", "Griffin B", "0 (16)"); // SV 16 ≤ 16 (tie) → resisted
  gameTargets = [{ actor: monsterA }, { actor: monsterB }];
  rollQueue = [[6, 3]]; // cast natural 9 + Magic Power 7 = SV 16
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: frostWave, dialogs });
  // natural 9 + Magic Power 7 = SV 16; vs A passive 8 → affected; vs B
  // passive 16 → tie → resisted.  assert.equal(result.cast, true);
  assert.equal(result.check.successValue, 16);
  assert.equal(result.targetResults[0].resisted, false, "SV 16 exceeds A's passive 8");
  assert.equal(result.targetResults[1].resisted, true, "SV 16 does not STRICTLY exceed B's passive 16");
  assert.equal(monsterA.effects.length, 1, "the non-resisted target received the persistent component");
  assert.equal(monsterB.effects.length, 0, "the resisted target received NOTHING");
  const card = lastCastCard();
  assert.ok(card.includes("<strong>Griffin A:</strong> affected"), "A keeps full damage");
  assert.ok(card.includes("<strong>Griffin B:</strong> resisted — half damage, extra effects nullified"), "B's Half outcome nullifies the extras");
  assert.ok(card.includes('data-success-value="16"'), "the damage button carries the authentic SV 16");
  record("case 9: Half — strict per-target comparison, persistent effect only for the non-resisted target");
}

// ── 10. Monster active resistance: automatic success and failure ───────────

{
  resetDialogs();
  clearCombat();
  caster.system.mp.value = 20;
  dialogs.monsterMode = "active";
  const lucky = monsterOf("act-a", "Lucky Beast", "2 (8)");
  const doomed = monsterOf("act-b", "Doomed Beast", "2 (8)");
  gameTargets = [{ actor: lucky }];
  rollQueue = [[3, 4], [6, 6]]; // cast natural 7 + 7 = 14; resistance 2d6+2 → 14 double 6 → auto success → resisted
  chatCreations.length = 0;
  let result = await castSpellAsMajor({ actor: caster, spell: venomMark, dialogs });
  assert.equal(result.targetResults[0].resisted, true, "double 6 on the active resistance is an automatic resistance success");
  assert.equal(result.targetResults[0].automaticSuccess, true);
  assert.ok(lastCastCard().includes("automatic success (natural double 6)"), "the card reports the resistance automatic success");

  gameTargets = [{ actor: doomed }];
  rollQueue = [[3, 4], [1, 1]]; // cast SV 14; resistance double 1 → automatic resistance failure → affected
  chatCreations.length = 0;
  result = await castSpellAsMajor({ actor: caster, spell: venomMark, dialogs });
  assert.equal(result.targetResults[0].resisted, false, "double 1 on the active resistance is an automatic resistance failure");
  assert.equal(result.targetResults[0].automaticFailure, true);
  assert.ok(lastCastCard().includes("automatic failure (natural double 1)"), "the card reports the resistance automatic failure");
  record("case 10: monster active resistance 2d6+X with automatic results");
}

// ── 11. Optional: independent accept/reject decisions per target ───────────

{
  resetDialogs();
  setCombat();
  caster.system.mp.value = 20;
  const accepting = new MockActor("opt-a", "Accepting", {
    type: "character", items: [], hp: { value: 10 }, abilityBases: {}, abilityAdjustments: {}
  });
  const rejecting = new MockActor("opt-b", "Rejecting", {
    type: "character", items: [], hp: { value: 10 }, abilityBases: {}, abilityAdjustments: {}
  });
  actorsCollection.push(accepting, rejecting);
  gameTargets = [{ actor: accepting }, { actor: rejecting }];
  const optionalSpell = SPELL("charm", "△Charm Person", {
    mpCost: 5,
    metadata: "Target: 1 character\nDuration: Instant/1 hour\nResistance: Optional"
  });
  const decisions = [true, false]; // first target rejects, second accepts
  rollQueue = [[4, 3]]; // cast natural 7 + Magic Power 7 = SV 14
  chatCreations.length = 0;
  const asked = [];
  const result = await castSpellAsMajor({
    actor: caster,
    spell: optionalSpell,
    dialogs: {
      askOptional: async target => { asked.push(target.name); return decisions.shift(); },
      askMonsterMode: dialogs.askMonsterMode
    }
  });
  assert.equal(result.cast, true);
  assert.deepEqual(asked, ["Accepting", "Rejecting"], "each target decided independently");
  assert.equal(result.targetResults[0].resisted, true, "the rejecting target automatically succeeds at resisting");
  assert.equal(result.targetResults[1].resisted, false, "the accepting target is affected");
  assert.equal(accepting.effects.length, 0, "no persistent component for the resisted target");
  assert.equal(rejecting.effects.length, 1, "the accepting target received the persistent component");
  assert.equal(rejecting.effects[0].system.successValue, 14, "the effect carries the authentic cast SV");
  record("case 11: Optional — independent decisions, effect only for the accepting target");
}

// ── 12. SV is computed ONCE and never re-derived from the damage roll ──────

{
  resetDialogs();
  clearCombat();
  caster.system.mp.value = 20;
  gameTargets = [{ actor: monsterOf("sv-m", "Target Beast", "0 (20)") }];
  rollQueue = [[5, 4]]; // natural 9 + Magic Power 7 = SV 16
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: frostWave, dialogs });
  const castSv = result.check.successValue;
  assert.equal(castSv, 16);

  // The damage roll is independent: its dice never enter the SV. A Power
  // Table critical (natural 11 ≥ crit 10) re-rolls through
  // roll-critical-damage carrying the SAME authentic SV.
  rollQueue = [[6, 5]]; // damage table roll 11 → critical → the SV must stay 16
  chatCreations.length = 0;
  const damage = await rollSpellPowerTableDamage({ actor: caster, spell: frostWave, castingClass: result.castingClass ?? resolveCastingClass(caster, frostWave), successValue: castSv });
  assert.equal(damage.critical, true, "the damage roll triggered a Power Table critical");
  assert.equal(damage.spellSuccessValue, 16, "the transported SV is the CAST SV, untouched by the damage roll");
  assert.ok(lastCard().includes('data-success-value="16"'), "the critical button preserves the authentic SV 16");
  record("case 12: the damage roll preserves the cast SV and never derives one");
}

// ── 13. Power Table fumble: only the damage fumbles, the cast survives ─────

{
  resetDialogs();
  setCombat();
  caster.system.mp.value = 20;
  const target = monsterOf("pt-f", "Fumble Beast", "0 (5)");
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]]; // cast SV 15 > passive 5 → affected → persistent component created
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: frostWave, dialogs });
  assert.equal(result.targetResults[0].resisted, false);
  assert.equal(target.effects.length, 1, "the cast created the persistent component");

  // Power Table double 1: no damage — but the cast's effects REMAIN.
  rollQueue = [[1, 1]];
  chatCreations.length = 0;
  const damage = await rollSpellPowerTableDamage({ actor: caster, spell: frostWave, castingClass: resolveCastingClass(caster, frostWave), successValue: result.check.successValue });
  assert.equal(damage.criticalFailure, true);
  assert.equal(damage.total, 0, "the Power Table fumble deals no damage");
  const fumbleCard = rollMessages.at(-1).message.flavor;
  assert.ok(fumbleCard.includes("CRITICAL FAILURE"), "the damage fumble is reported as a table fumble");
  assert.ok(fumbleCard.includes("register-automatic-failure"), "the player may voluntarily register the table Automatic Failure");
  assert.equal(target.effects.length, 1, "the Power Table fumble NEVER cancels the cast's valid effects");
  record("case 13: Power Table fumble — damage zero, cast effects intact");
}

// ── 14. The damage roll carries no SV when posted outside a cast ───────────

{
  resetDialogs();
  clearCombat();
  rollQueue = [[3, 2]];
  chatCreations.length = 0;
  const damage = await rollSpellPowerTableDamage({ actor: caster, spell: fireBolt, castingClass: resolveCastingClass(caster, fireBolt) });
  assert.equal(damage.spellSuccessValue, null, "no SV is fabricated outside a cast");
  assert.ok(!lastCard().includes("data-success-value"), "no SV attribute is written without an authentic cast SV");
  record("case 14: no provisional SV derivation — the T5.7-C workaround is gone");
}

// ── 15. Voluntary Automatic Failure registration (flow level) ──────────────

{
  const before = Number(caster.system.automaticFailureCount ?? 0);
  const registered = await registerAutomaticFailure(caster);
  assert.equal(registered, true);
  assert.equal(Number(caster.system.automaticFailureCount), before + 1, "registration is explicit and increments once");
  assert.ok(caster.system.automaticFailures.length === 0, "the legacy list stays empty");
  record("case 15: Automatic Failure registration is voluntary and explicit");
}

// ── Completion ─────────────────────────────────────────────────────────────

console.log("Spellcasting flow: all cases passed.");
process.exit(0);
