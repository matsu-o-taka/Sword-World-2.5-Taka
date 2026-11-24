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
//     roll Willpower or Fortitude; monsters resolve the selected X(Y) stat
//     passively or actively, with automatic results); Optional decisions and
//     strict ties remain independent per target.
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
const dialogV2Calls = [];
const dialogV2Answers = [];
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
  applications: {
    api: {
      DialogV2: class MockDialogV2 {
        static async wait(config) {
          dialogV2Calls.push(config);
          if (dialogV2Answers.length) return dialogV2Answers.shift();
          return "passive";
        }
      }
    }
  },
  data: { ActiveEffectTypeDataModel: class ActiveEffectTypeDataModelStub {} },
  utils: {
    escapeHTML: value => String(value ?? ""),
    randomID() { return `r${Math.random().toString(36).slice(2, 12)}`; }
  }
};

// The effect service and relay enforce GM authority, so the tests need to
// switch client role on demand (default: GM, the normal headless case).
let mockUserIsGM = true;
let mockActiveGm = { id: "gm-user" };

globalThis.game = {
  get user() {
    return { get isGM() { return mockUserIsGM; }, id: "gm-user", get targets() { return gameTargets; } };
  },
  actors: actorsCollection,
  items: { get: uuid => spellCollection.get(uuid) ?? null },
  get targets() { return gameTargets; },
  users: { get activeGM() { return mockActiveGm; } },
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
  metadata: "Target: 1 enemy\nDuration: Instant/2 rounds\nResistance: Half",
  target: "character",
  duration: "Instant/2 rounds",
  resistance: "half"
});

// Same Half/Damage route, with the structured defensive characteristic set
// to Fortitude. This must change only the target defense, not the outcome rules.
const fortitudeWave = SPELL("fortitude-wave", "Fortitude Wave", {
  ...frostWave.system,
  metadata: "Target: 1 enemy\nDuration: Instant/2 rounds\nResistance: Fortitude/Half",
  resistance: "half",
  usesFortitude: true
});

// Unresistable self-buff, Instant/X (3 rounds), ⏩ Minor Action.
const quickShield = SPELL("quick-shield", "⏩Quick Shield", {
  mpCost: 4,
  hasPowerTable: false,
  metadata: "Target: Self\nDuration: Instant/3 rounds\nResistance: Can't",
  target: "caster",
  duration: "Instant/3 rounds",
  resistance: "cant",
  minorAction: true
});

// Same spell without the ⏩ marker (to prove the marker is required).
const quickShieldCopy = SPELL("quick-shield-copy", "Quick Shield", {
  mpCost: 4,
  metadata: "Target: Self\nDuration: Instant/3 rounds\nResistance: Can't",
  target: "caster",
  duration: "Instant/3 rounds",
  resistance: "cant"
});

// △ Combat Preparation spell, Instant/X (2 turns).
const wardSigil = SPELL("ward-sigil", "△Ward Sigil", {
  mpCost: 5,
  metadata: "Target: Self\nDuration: Instant/2 turns\nResistance: Can't",
  target: "caster",
  duration: "Instant/2 turns",
  resistance: "cant",
  combatPreparation: true
});

// Neg spell with a persistent part, for resisted/created-per-target checks.
const venomMark = SPELL("venom-mark", "Venom Mark", {
  mpCost: 8,
  hasPowerTable: false,
  metadata: "Target: 1 enemy\nDuration: Instant/3 rounds\nResistance: Negates\nType: Poison",
  target: "character",
  duration: "Instant/3 rounds",
  resistance: "neg",
  damageType: { nature: null, attribute: "Poison" }
});

// Simple non-persistent damage spell, Resistance: Half.
const fireBolt = SPELL("fire-bolt", "Fire Bolt", {
  mpCost: 6,
  hasPowerTable: true,
  critical: 10,
  powerTable: { 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 12, 11: 14, 12: 16 },
  metadata: "Target: 1 enemy\nDuration: Instant\nResistance: Half",
  target: "character",
  duration: "Instant",
  resistance: "half"
});

const healingWater = SPELL("healing-water", "Healing Water", {
  mpCost: 3,
  hasPowerTable: false,
  target: "character",
  duration: "Instant/3 minutes (18 rounds)",
  resistance: "none"
});
const chillingBreath = SPELL("chilling-breath", "Chilling Breath", {
  mpCost: 11,
  hasPowerTable: true,
  critical: 10,
  powerTable: { 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 6, 9: 7, 10: 8, 11: 9, 12: 10 },
  target: "character",
  duration: "Instant/10 seconds (1 round)",
  resistance: "half",
  damageType: { nature: "magical", attribute: "Water/Ice" }
});

const monsterOf = (id, name, willpower, activeCombatRolls) => {
  const monster = new MockActor(id, name, {
    type: "monster",
    willpower,
    combatStyles: [{ id: "s1", style: "Weapon", hp: { value: 20 } }],
    mp: { value: 0 },
    hp: { value: 20 },
    // Omitted by default to exercise combat's established legacy default.
    ...(activeCombatRolls === undefined ? {} : { activeCombatRolls })
  });
  actorsCollection.push(monster);
  return monster;
};

const record = label => console.log(`  ${label}`);

const lastCard = () => chatCreations.at(-1)?.content ?? "";
const cardCount = () => chatCreations.length;
const castCards = () => chatCreations.filter(c => String(c.content ?? "").includes("spell-card"));
const lastCastCard = () => castCards().at(-1)?.content ?? "";
const assertOutcomeBadge = (card, label, className) => {
  assert.ok(
    card.includes(`sw25-spell-outcome-badge ${className}">${label}</span>`),
    `the prominent outcome badge is ${label} (${className})`
  );
};
const assertSingleSv = (card, value) => {
  assert.equal((card.match(new RegExp(`SV ${value}`, "g")) ?? []).length, 1, `SV ${value} appears only in the check explanation`);
};

// Dialog override so each scenario controls Optional decisions without UI.
// Monster defense is configuration-driven and has no dialog override.
const dialogs = {
  askOptional: async (_target, _spell) => dialogs.optionalAnswer ?? false,
  // Dispel Magic declares its target effect BEFORE the roll (T6.1). The
  // default test declaration picks the first eligible candidate; scenarios
  // that need another choice override it.
  declareEffect: async ({ candidates }) => {
    const candidate = candidates[0] ?? null;
    return { selection: candidate ? { actorUuid: candidate.target.uuid, effectId: candidate.effect.id } : null };
  }
};
function resetDialogs() {
  dialogs.optionalAnswer = null;
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
  deductCastMP,
  getSpellResistance,
  isMinorActionSpell,
  isCombatPreparationSpell,
  parseMonsterResistance,
  prepareSpellCast,
  characterWillpower,
  characterFortitude,
  resolveTargetResistance,
  resolveCastingClass,
  spellAlreadyCastInCombatPreparation,
  registerSw25InstantXImmediateHandler
} = spellCastModule;
const { addNaturalPowerMP, expireNaturalPower, rollSpellPowerTableDamage } = spellDamageModule;
const { registerAutomaticFailure } = criticalModule;

registerSw25StackingResolver(() => ({ outcome: "accumulate" }));
initializeEffectService();

// ── Pure helpers ───────────────────────────────────────────────────────────

// Resistance reads the structured field (vocabulary + parsing in
// rules/spell-data.mjs, covered by spell-data.test.mjs).
assert.equal(getSpellResistance(frostWave), "half");
assert.equal(getSpellResistance({ system: { resistance: "neg" } }), "neg");
assert.equal(getSpellResistance({ system: { resistance: "cant" } }), "cant");
assert.equal(getSpellResistance({ system: { resistance: "optional" } }), "optional");
assert.equal(getSpellResistance({ system: { resistance: "none" } }), "none");
assert.equal(getSpellResistance({ system: { resistance: "temporary" } }), "temporary");
assert.equal(getSpellResistance({ system: {} }), null);
assert.equal(getSpellResistance({ system: { resistance: "bogus" } }), null);
record("resistance structured field (approved ids, null for absent/bogus)");

// Modality comes from the structured boolean fields (importer-populated).
assert.ok(isMinorActionSpell(quickShield));
assert.ok(!isMinorActionSpell(quickShieldCopy));
assert.ok(isCombatPreparationSpell(wardSigil));
assert.ok(!isCombatPreparationSpell(quickShield));
record("structured minorAction/combatPreparation booleans");

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

// Character resistances: highest class level + ability + their own ledger.
{
  const actor = new MockActor("w1", "Resistance One", {
    items: [CLASS("c1", "Sorcerer", 5)],
    abilityBases: { mind: 13, body: 13 },
    abilityAdjustments: {}
  });
  assert.equal(characterWillpower(actor), 5 + 2, "Willpower = level 5 + Spirit 2");
  assert.equal(characterFortitude(actor), 5 + 2, "Fortitude = level 5 + Vitality 2");
  actor.system.sw25EffectMods = { resistances: { willpower: 1, fortitude: 2 } };
  assert.equal(characterWillpower(actor), 8, "the Willpower ledger adds only to Willpower");
  assert.equal(characterFortitude(actor), 9, "the Fortitude ledger adds only to Fortitude");
  record("character Willpower/Fortitude = highest class level + ability + corresponding ledger");
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

// Legacy duplicate sheet inputs could persist MP as an array. All casting
// arithmetic and Natural Power writes must use the shared scalar boundary.
{
  const legacyCaster = new MockActor("legacy-array-caster", "Legacy Array Caster", {
    abilityBases: { mind: 12 },
    abilityAdjustments: {},
    mp: { value: [20, 20], max: 20 },
    combat: {},
    items: [CLASS("cls-sorcerer", "Sorcerer", 5)]
  });
  const prepared = prepareSpellCast({ actor: legacyCaster, spell: fireBolt });
  assert.equal(prepared.blocked, false, "an array-valued 20 MP pool still validates against a cost of 6");
  await deductCastMP(legacyCaster, 6, fireBolt);
  assert.equal(legacyCaster.system.mp.value, 14, "casting deducts from normalized MP and repairs the persisted scalar");
  legacyCaster.system.mp.value = [2, 2];
  assert.equal(prepareSpellCast({ actor: legacyCaster, spell: fireBolt }).blocked, true, "normalized insufficient MP blocks the cast");

  legacyCaster.system.mp.value = [20, 20];
  await addNaturalPowerMP(legacyCaster, 5);
  assert.equal(legacyCaster.system.mp.value, 25, "Natural Power adds to normalized MP without NaN");
  assert.equal(await expireNaturalPower(legacyCaster), 5, "the unused Natural Power remainder is expired");
  assert.equal(legacyCaster.system.mp.value, 20, "Natural Power expiry persists a finite scalar");
  record("legacy array MP is normalized for casting and Natural Power");
}

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
  assert.equal(result.targetResults[0].mode, "passive", "a missing activeCombatRolls property uses combat's passive default");
  assert.ok(!("activeCombatRolls" in gameTargets[0].actor.system), "the legacy fixture really has no mode property");
  const card = lastCastCard();
  assertOutcomeBadge(card, "SUCCESS", "sw25-spell-outcome-success");
  assert.ok(card.includes("natural 8"), "the natural result is preserved separately");
  assert.ok(card.includes("Magic Power 7"), "the effective Magic Power is preserved separately");
  assert.ok(card.includes("SV 15"), "the SV is computed once from natural + Magic Power");
  assertSingleSv(card, 15);
  assert.ok(card.includes("<strong>Goblin (Willpower 10) affected!</strong> The target takes full damage."), "the passive target shows its actual defense and full damage");
  assert.ok(!card.includes("Passive difficulty"), "the target line omits the internal numerical comparison");
  assert.ok(card.indexOf("sw25-resistance-results") < card.indexOf("sw25-spell-cast-meta"), "target results precede the metadata");
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
  assertOutcomeBadge(card, "FAILED", "sw25-spell-outcome-failure");
  assert.ok(card.includes("CRITICAL FAILURE"), "the card retains the critical-failure notice");
  assert.ok(card.includes("natural 2 + Magic Power 7"), "the failed cast keeps its compact check explanation");
  assertSingleSv(card, 0);
  assert.ok(card.includes("The spell fizzles; its effects are not produced."));
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
  assertOutcomeBadge(card, "AUTOMATIC SUCCESS", "sw25-spell-outcome-automatic");
  assert.ok(card.includes("+5 (automatic success)"), "the card shows the automatic-success bonus");
  assert.ok(card.includes(`SV ${12 + 5 + 7}`));
  assertSingleSv(card, 24);
  assert.ok(card.includes("<strong>Hydra (Willpower 12) affected!</strong> The target takes full damage."));
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
  assertOutcomeBadge(card, "RESISTED", "sw25-spell-outcome-resisted");
  assert.ok(card.includes("SV 12"));
  assertSingleSv(card, 12);
  assert.ok(card.includes("<strong>Kobold (Willpower 20) resisted!</strong> The target takes half damage. Additional effects are nullified."));
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
  assert.equal(caster.effects[0].system.family, "Quick Shield", "Phase 2: the leading ⏩ is authoring metadata, never identity");
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
  const other = SPELL("other-ward", "△Other Ward", { mpCost: 1, metadata: "Duration: Instant\nResistance: Can't", duration: "Instant", resistance: "cant", combatPreparation: true });
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
  assert.equal(result.targetResults[0].mode, "active", "non-monster target A keeps its active Willpower roll");
  assert.equal(result.targetResults[1].mode, "active", "non-monster target B keeps its active Willpower roll");
  const card = lastCastCard();
  assertOutcomeBadge(card, "SUCCESS", "sw25-spell-outcome-success");
  assert.ok(card.includes("<strong>Target A (Willpower 14) affected!</strong>"), "A shows the actual active defense total");
  assert.ok(card.includes("<strong>Target B (Willpower 15) resisted!</strong> The spell has no effect."), "B shows its independent negated outcome");
  assert.ok(!card.includes("Resistance total"), "active target lines omit the internal comparison");
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
  assertOutcomeBadge(card, "SUCCESS", "sw25-spell-outcome-success");
  assert.ok(card.includes("<strong>Griffin A (Willpower 8) affected!</strong> The target takes full damage."), "A keeps full damage");
  assert.ok(card.includes("<strong>Griffin B (Willpower 16) resisted!</strong> The target takes half damage. Additional effects are nullified."), "B's Half outcome nullifies the extras");
  assert.ok(!card.includes("Passive difficulty"), "neither target line exposes the internal comparison");
  assert.ok(card.includes('data-success-value="16"'), "the damage button carries the authentic SV 16");
  record("case 9: Half — strict per-target comparison, persistent effect only for the non-resisted target");
}

// ── 10. Monster active resistance: automatic success and failure ───────────

{
  resetDialogs();
  clearCombat();
  caster.system.mp.value = 20;
  const lucky = monsterOf("act-a", "Lucky Beast", "2 (8)", true);
  const doomed = monsterOf("act-b", "Doomed Beast", "2 (8)", true);
  gameTargets = [{ actor: lucky }];
  rollQueue = [[3, 4], [6, 6]]; // cast natural 7 + 7 = 14; resistance 2d6+2 → 14 double 6 → auto success → resisted
  chatCreations.length = 0;
  let result = await castSpellAsMajor({ actor: caster, spell: venomMark, dialogs });
  assert.equal(result.targetResults[0].mode, "active", "activeCombatRolls=true selects active defense without a mode override");
  assert.equal(result.targetResults[0].resisted, true, "double 6 on the active resistance is an automatic resistance success");
  assert.equal(result.targetResults[0].automaticSuccess, true);
  const resistedCard = lastCastCard();
  assertOutcomeBadge(resistedCard, "FAILED", "sw25-spell-outcome-failure");
  assert.ok(resistedCard.includes("<strong>Lucky Beast (Willpower 14) resisted!</strong> The spell has no effect."), "the active target shows the actual defense total and absent effect");
  assert.ok(resistedCard.includes("automatic success (natural double 6)"), "the card retains the resistance automatic-success note");
  assert.ok(!resistedCard.includes("Resistance total"), "the automatic target line omits the internal comparison");

  gameTargets = [{ actor: doomed }];
  rollQueue = [[3, 4], [1, 1]]; // cast SV 14; resistance double 1 → automatic resistance failure → affected
  chatCreations.length = 0;
  result = await castSpellAsMajor({ actor: caster, spell: venomMark, dialogs });
  assert.equal(result.targetResults[0].mode, "active", "the second active monster also uses its own configuration");
  assert.equal(result.targetResults[0].resisted, false, "double 1 on the active resistance is an automatic resistance failure");
  assert.equal(result.targetResults[0].automaticFailure, true);
  const affectedCard = lastCastCard();
  assertOutcomeBadge(affectedCard, "SUCCESS", "sw25-spell-outcome-success");
  assert.ok(affectedCard.includes("<strong>Doomed Beast (Willpower 4) affected!</strong>"), "the active target shows the actual defense total after its automatic failure");
  assert.ok(affectedCard.includes("automatic failure (natural double 1)"), "the card retains the resistance automatic-failure note");
  record("case 10: monster active resistance 2d6+X with automatic results");
}

// ── 10b. Mixed monsters: independent configuration, no defense dialog ─────

{
  resetDialogs();
  clearCombat();
  caster.system.mp.value = 20;
  const active = monsterOf("mixed-active", "Active Beast", "2 (8)", true);
  const passive = monsterOf("mixed-passive", "Passive Beast", "4 (20)", false);
  gameTargets = [{ actor: active }, { actor: passive }];
  // Cast SV 14; only the active monster rolls: 2d6(9) + 2 = 11 (affected).
  // The passive monster uses its fixed 20 with no roll (14 does not exceed it).
  rollQueue = [[3, 4], [4, 5]];
  chatCreations.length = 0;
  const dialogsBefore = dialogV2Calls.length;
  const resistanceMessagesBefore = rollMessages.length;
  const result = await castSpellAsMajor({ actor: caster, spell: venomMark });
  assert.equal(result.cast, true);
  assert.equal(result.check.successValue, 14);
  assert.deepEqual(result.targetResults.map(entry => entry.mode), ["active", "passive"], "each target uses its own activeCombatRolls value");
  assert.equal(result.targetResults[0].targetTotal, 11, "the active target rolled its own 2d6 + X resistance");
  assert.equal(result.targetResults[0].resisted, false, "SV 14 exceeds the active target's 11");
  assert.equal(result.targetResults[1].passiveDifficulty, 20, "the passive target uses its own fixed Y");
  assert.equal(result.targetResults[1].resisted, true, "SV 14 does not exceed the passive target's 20");
  assert.equal(result.targetResults[1].targetTotal, null, "the passive target rolled no resistance dice");
  assert.equal(rollMessages.length - resistanceMessagesBefore, 1, "only the active monster posted a resistance roll");
  assert.ok(rollMessages.at(-1).message.flavor.includes("Active Beast"), "the sole resistance roll belongs to the active monster");
  assert.equal(dialogV2Calls.length, dialogsBefore, "no active/passive defense dialog opens for either monster");
  assert.equal(rollQueue.length, 0, "exactly the cast check and one active resistance roll were consumed");
  const card = lastCastCard();
  assertOutcomeBadge(card, "SUCCESS", "sw25-spell-outcome-success");
  assert.ok(card.includes("<strong>Active Beast (Willpower 11) affected!</strong>"), "the active monster displays its roll total");
  assert.ok(card.includes("<strong>Passive Beast (Willpower 20) resisted!</strong> The spell has no effect."), "the passive monster displays its fixed difficulty");
  assertSingleSv(card, 14);
  record("case 10b: mixed active/passive monsters resolve independently with no defense dialog");
}

// ── 10c. Fortitude: character + active/passive monsters, same Half rules ───

{
  resetDialogs();
  setCombat();
  caster.system.mp.value = 20;
  const character = new MockActor("fort-character", "Fortitude Hero", {
    type: "character",
    items: [CLASS("fort-class", "Fighter", 4)],
    abilityBases: { body: 6, mind: 24 }, // Fortitude 5; Willpower 8 (deliberately different)
    abilityAdjustments: {},
    hp: { value: 10 }
  });
  actorsCollection.push(character);
  const active = monsterOf("fort-active", "Active Fortitude", "9 (30)", true);
  active.system.fortitude = "2 (8)";
  const passive = monsterOf("fort-passive", "Passive Fortitude", "0 (8)", false);
  passive.system.fortitude = "4 (20)";
  gameTargets = [{ actor: character }, { actor: active }, { actor: passive }];

  // SV 14. Character: natural 7 + Fortitude 5 = 12 (affected); using its
  // Willpower 8 instead would tie at 15 and resist. Active monster: natural
  // 9 + Fortitude 2 = 11 (affected); Willpower would total 18 and resist.
  // Passive monster: fixed Fortitude 20 resists; Willpower 8 would be affected.
  rollQueue = [[3, 4], [3, 4], [4, 5]];
  chatCreations.length = 0;
  const dialogsBefore = dialogV2Calls.length;
  const resistanceMessagesBefore = rollMessages.length;
  const result = await castSpellAsMajor({ actor: caster, spell: fortitudeWave, dialogs });
  assert.equal(result.cast, true);
  assert.equal(result.check.successValue, 14);
  assert.deepEqual(result.targetResults.map(entry => entry.mode), ["active", "active", "passive"]);
  assert.deepEqual(result.targetResults.map(entry => entry.targetTotal), [12, 11, null]);
  assert.deepEqual(result.targetResults.map(entry => entry.passiveDifficulty), [null, null, 20]);
  assert.deepEqual(result.targetResults.map(entry => entry.resisted), [false, false, true], "each target uses Fortitude, not its deliberately different Willpower");
  assert.equal(result.targetResults[2].halfDamage, true, "Fortitude resistance preserves Half damage");
  assert.equal(result.targetResults[2].effectsNullified, true, "Fortitude resistance preserves additional-effect nullification");
  assert.equal(character.effects.length, 1, "the affected character receives the persistent component");
  assert.equal(active.effects.length, 1, "the affected active monster receives the persistent component");
  assert.equal(passive.effects.length, 0, "the resisted passive monster receives no persistent component");
  assert.equal(rollQueue.length, 0, "only the cast, character, and active monster roll dice");
  const defenseRolls = rollMessages.slice(resistanceMessagesBefore);
  assert.deepEqual(defenseRolls.map(entry => entry.formula), ["2d6 + 5", "2d6 + 2"]);
  assert.ok(defenseRolls.every(entry => entry.message.flavor.includes("Fortitude")), "both roll messages identify Fortitude");
  assert.ok(defenseRolls.every(entry => !entry.message.flavor.includes("Willpower")), "no Fortitude roll is mislabeled Willpower");
  assert.equal(dialogV2Calls.length, dialogsBefore, "Fortitude adds no defense dialog");
  const card = lastCastCard();
  assert.ok(card.includes("<strong>Fortitude Hero (Fortitude 12) affected!</strong> The target takes full damage."));
  assert.ok(card.includes("<strong>Active Fortitude (Fortitude 11) affected!</strong> The target takes full damage."));
  assert.ok(card.includes("<strong>Passive Fortitude (Fortitude 20) resisted!</strong> The target takes half damage. Additional effects are nullified."));
  assert.ok(!card.includes("(Willpower"), "the card never displays the unused defensive characteristic");
  assert.ok(card.includes('data-success-value="14"'), "Fortitude leaves the damage interaction and SV transport unchanged");
  record("case 10c: Fortitude — character, active/passive monsters, Half outcomes, effects and chat labels");
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
    metadata: "Target: 1 character\nDuration: Instant/1 hour\nResistance: Optional",
    target: "character",
    duration: "Instant/1 hour",
    resistance: "optional",
    combatPreparation: true
  });
  const decisions = [true, false]; // first target rejects, second accepts
  rollQueue = [[4, 3]]; // cast natural 7 + Magic Power 7 = SV 14
  chatCreations.length = 0;
  const asked = [];
  const result = await castSpellAsMajor({
    actor: caster,
    spell: optionalSpell,
    dialogs: {
      askOptional: async target => { asked.push(target.name); return decisions.shift(); }
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
  const targetUuid = result.targetResults[0]?.target?.uuid;
  assert.equal(targetUuid, "Actor.sv-m", "the single-target spell retains its original target context");
  assert.ok(lastCastCard().includes(`data-target-id="${targetUuid}"`), "the spell damage action carries that target explicitly");

  // The damage roll is independent: its dice never enter the SV. A Power
  // Table critical (natural 11 ≥ crit 10) automatically continues.
  rollQueue = [[6, 5], [4, 5]];
  chatCreations.length = 0;
  const damage = await rollSpellPowerTableDamage({
    actor: caster, spell: frostWave, castingClass: result.castingClass ?? resolveCastingClass(caster, frostWave),
    successValue: castSv, targetActorUuid: targetUuid
  });
  assert.equal(damage.critical, true, "the damage roll triggered a Power Table critical");
  assert.equal(damage.spellSuccessValue, 16, "the transported SV is the CAST SV, untouched by the damage roll");
  assert.ok(lastCard().includes("Critical continuation"), "the chain is shown without a follow-up button");
  assert.ok(lastCard().includes(`data-actor-id="${targetUuid}"`), "damage application retains the originating spell target");
  record("case 12: the damage roll preserves the cast SV and automatically resolves its critical continuation");
}

// ── 12b. Targetless spell attack still offers a manual damage roll ──────────

{
  resetDialogs();
  clearCombat();
  caster.system.mp.value = 20;
  gameTargets = [];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor:caster, spell:frostWave, dialogs });
  assert.equal(result.cast, true);
  const castCard = chatCreations.at(-1)?.content ?? "";
  assert.ok(castCard.includes("Roll Damage"), "a spell card without targets still offers damage initiation");
  assert.ok(!castCard.includes('data-target-id="Actor.'), "no arbitrary target is attached to a targetless spell card");
  rollQueue = [[5, 4]];
  const damage = await rollSpellPowerTableDamage({
    actor:caster, spell:frostWave, castingClass:resolveCastingClass(caster, frostWave),
    successValue:result.check.successValue
  });
  assert.equal(damage.criticalFailure, false);
  assert.ok(lastCard().includes("Apply Magical Damage"), "targetless spell damage still offers explicit application");
  assert.ok(!lastCard().includes('data-actor-id="Actor.'), "targetless damage application does not capture an arbitrary actor");
  record("case 12b: targetless spell card retains Roll Damage without target association");
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

// ── 16. Combat Preparation strict mode validation ────────────────────────

{
  // Mutable strict-mode setting. game.settings does not exist in the mock
  // environment, so we add it here to drive isStrictCombatPreparationEnabled().
  let strict = false;
  Object.defineProperty(game, "settings", {
    configurable: true,
    get() {
      return {
        get: (_ns, key) =>
          key === "enforceStrictCombatPreparationRules" ? strict : undefined,
        set: () => {}
      };
    }
  });

  const setupPrep = () => {
    setCombat();
    caster.flags["sw25-taka:combatPreparationCasts"] = undefined;
    caster.system.mp.value = 20;
    rollQueue = [];
    chatCreations.length = 0;
    uiMessages.length = 0;
  };

  const expectRejected = async (label, fn, modality) => {
    const mpBefore = caster.system.mp.value;
    const result = await fn();
    assert.equal(result.cast, false, `${label}: ${modality} should be rejected`);
    assert.equal(
      caster.system.mp.value,
      mpBefore,
      `${label}: no MP spent on rejected ${modality}`
    );
    return result;
  };

  const expectPermitted = async (label, fn, modality) => {
    const mpBefore = caster.system.mp.value;
    const result = await fn();
    assert.equal(result.cast, true, `${label}: ${modality} should be permitted`);
    assert.equal(
      caster.system.mp.value,
      mpBefore - (result.mpSpent ?? 0),
      `${label}: MP spent on permitted ${modality}`
    );
    return result;
  };

  // ── Strict mode ON, during Combat Preparation ──────────────────────────

  {
    strict = true;
    setupPrep();

    // Conjuro sin △ mediante Major Action → Rechazado
    await expectRejected("strict: no-△ Major", () =>
      castSpellAsMajor({ actor: caster, spell: fireBolt }), "Major");

    // Conjuro con △ mediante Major Action → Rechazado
    await expectRejected("strict: △ Major", () =>
      castSpellAsMajor({ actor: caster, spell: wardSigil }), "Major");

    // Conjuro con △ mediante Combat Preparation → Permitido (SV 0)
    {
      gameTargets = [];
      const result = await expectPermitted("strict: △ Combat Prep", () =>
        castSpellInCombatPreparation({ actor: caster, spell: wardSigil }), "Combat Preparation");
      assert.equal(result.successValue, 0, "strict: Combat Preparation SV is 0");
    }

    // Conjuro sin △ mediante Combat Preparation → Rechazado
    await expectRejected("strict: no-△ Combat Prep", () =>
      castSpellInCombatPreparation({ actor: caster, spell: quickShieldCopy }), "Combat Preparation");

    // Conjuro con ⏩ mediante Minor Action → Permitido (reglas normales)
    {
      gameTargets = [];
      const result = await expectPermitted("strict: ⏩ Minor", () =>
        castSpellAsMinor({ actor: caster, spell: quickShield }), "Minor");
      assert.equal(result.successValue, 0, "strict: Minor SV is 0");
    }

    // Conjuro sin ⏩ mediante Minor Action → Rechazado
    await expectRejected("strict: no-⏩ Minor", () =>
      castSpellAsMinor({ actor: caster, spell: quickShieldCopy }), "Minor");

    strict = false;
    record("case 16a: strict mode ON during Combat Preparation — all routes validated");
  }

  // ── Strict mode OFF, during Combat Preparation ─────────────────────────

  {
    strict = false;
    setupPrep();

    // Conjuro sin △ mediante Major Action → Permitido
    {
      gameTargets = [{ actor: monsterOf("m-prep-a", "Prep Target A", "0 (10)") }];
      rollQueue = [[4, 4]]; // natural 8 + MP 7 = SV 15 > passive 10 → affected
      await expectPermitted("flexible: no-△ Major", () =>
        castSpellAsMajor({ actor: caster, spell: fireBolt }), "Major");
    }

    // Conjuro con △ mediante Major Action → Permitido
    {
      gameTargets = [];
      rollQueue = [[4, 4]]; // natural 8 + MP 7 = SV 15
      await expectPermitted("flexible: △ Major", () =>
        castSpellAsMajor({ actor: caster, spell: wardSigil }), "Major");
    }

    // Conjuro con △ mediante Combat Preparation → Permitido
    {
      gameTargets = [];
      const result = await expectPermitted("flexible: △ Combat Prep", () =>
        castSpellInCombatPreparation({ actor: caster, spell: wardSigil }), "Combat Preparation");
      assert.equal(result.successValue, 0, "flexible: Combat Preparation SV is 0");
    }

    // Conjuro sin △ mediante Combat Preparation → Rechazado
    await expectRejected("flexible: no-△ Combat Prep", () =>
      castSpellInCombatPreparation({ actor: caster, spell: quickShieldCopy }), "Combat Preparation");

    // Minor Action sin cambios respecto a sus reglas normales
    {
      gameTargets = [];
      const result = await expectPermitted("flexible: ⏩ Minor", () =>
        castSpellAsMinor({ actor: caster, spell: quickShield }), "Minor");
      assert.equal(result.successValue, 0);
    }

    record("case 16b: strict mode OFF during Combat Preparation — flexible behavior validated");
  }

  // ── After initiative started ───────────────────────────────────────────

  {
    strict = true;
    setCombat();
    combatState.started = true; // initiative rolled, preparation over
    caster.flags["sw25-taka:combatPreparationCasts"] = undefined;
    caster.system.mp.value = 20;
    rollQueue = [];
    chatCreations.length = 0;
    uiMessages.length = 0;

    // Major Action permitida para todos los conjuros
    {
      gameTargets = [{ actor: monsterOf("m-post", "Post Target", "0 (10)") }];
      rollQueue = [[4, 4]]; // natural 8 + MP 7 = SV 15 > passive 10 → affected
      await expectPermitted("post-initiative: Major", () =>
        castSpellAsMajor({ actor: caster, spell: fireBolt }), "Major");
    }

    // Modalidad especial Combat Preparation rechazada después de la iniciativa
    await expectRejected("post-initiative: Combat Prep", () =>
      castSpellInCombatPreparation({ actor: caster, spell: wardSigil }), "Combat Preparation");

    // Minor Action conserva sus reglas normales
    {
      gameTargets = [];
      const result = await expectPermitted("post-initiative: Minor", () =>
        castSpellAsMinor({ actor: caster, spell: quickShield }), "Minor");
      assert.equal(result.successValue, 0);
    }

    record("case 16c: after initiative — normal modalities restored, preparation rejected");
  }

  // ── Out of combat ──────────────────────────────────────────────────────

  {
    clearCombat();
    caster.system.mp.value = 20;
    rollQueue = [];
    chatCreations.length = 0;
    uiMessages.length = 0;

    // Todos los conjuros con modalidades normales, sin △ restricción
    {
      gameTargets = [{ actor: monsterOf("m-oc-a", "OC Target A", "0 (10)") }];
      rollQueue = [[4, 4]]; // natural 8 + MP 7 = SV 15 > passive 10 → affected
      await expectPermitted("out-of-combat: Major (no △)", () =>
        castSpellAsMajor({ actor: caster, spell: fireBolt }), "Major");
    }

    {
      gameTargets = [];
      rollQueue = [[4, 4]]; // natural 8 + MP 7 = SV 15
      await expectPermitted("out-of-combat: Major (△)", () =>
        castSpellAsMajor({ actor: caster, spell: wardSigil }), "Major");
    }

    // Combat Preparation modalidad rechazada fuera de combate (no hay preparación)
    await expectRejected("out-of-combat: Combat Prep", () =>
      castSpellInCombatPreparation({ actor: caster, spell: wardSigil }), "Combat Preparation");

    record("case 16d: out of combat — normal modalities for all, preparation unavailable");
  }
}

// ── 17. Temporary modifiers: the SHARED dialog seeds the Magic Power parts ─

{
  // The prompt is the SHARED dialog of rules/roll-modifiers.mjs: the sheets
  // inject openRollModifiersDialog on Shift+click; tests inject a mock. The
  // roll stays a plain 2d6 — the enabled modifiers join the EFFECTIVE Magic
  // Power of the SV, never the dice.
  clearCombat();
  caster.system.mp.value = 20;
  gameTargets = [];
  rollQueue = [[4, 4]]; // natural 8
  chatCreations.length = 0;
  uiMessages.length = 0;

  const prompted = [];
  const promptModifiers = async config => {
    prompted.push(config);
    // The player keeps the permanent parts and adds a temporary +2 blessing.
    return [
      ...config.parts.map(part => ({ ...part })),
      { label: "Blessing", value: 2, enabled: true, temporary: true }
    ];
  };

  const result = await castSpellAsMajor({ actor: caster, spell: fireBolt, promptModifiers });
  assert.equal(result.cast, true);
  assert.equal(result.check.magicPower, 9, "the temporary modifier joins the effective Magic Power (7 + 2)");
  assert.equal(result.check.successValue, 17, "SV = natural 8 + effective Magic Power 9");
  assert.equal(caster.system.mp.value, 14, "the MP cost is paid only after the dialog confirmed");
  // The dialog was seeded with the PERMANENT Magic Power composition.
  assert.equal(prompted.length, 1, "the shared dialog was opened once, seeded with permanent parts");
  const seededLabels = prompted[0].parts.map(part => part.label);
  assert.ok(seededLabels.includes("Sorcerer level"), "the casting class level is a seeded permanent part");
  assert.ok(seededLabels.includes("Intelligence bonus"), "the Intelligence bonus is a seeded permanent part");
  assert.ok(seededLabels.includes("Effects"), "the effect ledger's combat.magicPower is a seeded permanent part");
  assert.equal(prompted[0].diceFormula, "2d6", "the dialog shows the plain 2d6 roll");
  const card = lastCastCard();
  assert.ok(card.includes("SV 17"), "the card shows the SV with the temporary modifier applied");
  assert.ok(card.includes("Blessing"), "the card breakdown shows the temporary modifier");
  assert.ok(card.includes('data-success-value="17"'), "the damage button carries the SV WITH the temporary modifier");
  record("case 17a: temporary modifiers join the effective Magic Power of the SV");
}

{
  // Closing/cancelling the shared dialog aborts the cast BEFORE the MP cost:
  // no MP is spent and no card is posted (mirrors the attack flow contract).
  clearCombat();
  caster.system.mp.value = 20;
  gameTargets = [];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const before = caster.system.mp.value;
  const result = await castSpellAsMajor({ actor: caster, spell: fireBolt, promptModifiers: async () => null });
  assert.equal(result.cast, false, "cancelling the shared dialog aborts the cast");
  assert.equal(result.cancelled, true, "the abort is a clean cancellation");
  assert.equal(caster.system.mp.value, before, "a cancelled cast spends NO MP");
  assert.equal(chatCreations.length, 0, "a cancelled cast posts no card");
  record("case 17b: cancelling the shared dialog aborts the cast before the MP cost");
}

{
  // Without a prompt (the default), the cast behaves exactly as before: the
  // permanent Magic Power composition feeds the SV and no dialog opens.
  clearCombat();
  caster.system.mp.value = 20;
  gameTargets = [];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: fireBolt });
  assert.equal(result.cast, true);
  assert.equal(result.check.magicPower, 7, "no prompt: the permanent Magic Power 7 is used unchanged");
  assert.equal(result.check.successValue, 15);
  assert.equal(caster.system.mp.value, 14);
  record("case 17c: no prompt injected — the permanent Magic Power is used unchanged");
}

// ── 18. Damage-card detail anchors stay unique across module reloads ───────

{
  clearCombat();
  chatCreations.length = 0;
  rollQueue = [[3, 2]];
  await rollSpellPowerTableDamage({ actor: caster, spell: fireBolt, castingClass: resolveCastingClass(caster, fireBolt) });

  // A Foundry reload keeps old chat messages but evaluates this module again.
  // A module-local counter would restart at zero and reuse their detail ids.
  const reloadedDamageModule = await import(`../module/rules/spell-damage.mjs?reload=${Date.now()}`);
  rollQueue = [[4, 3]];
  await reloadedDamageModule.rollSpellPowerTableDamage({ actor: caster, spell: fireBolt, castingClass: resolveCastingClass(caster, fireBolt) });

  const detailIds = chatCreations.flatMap(message =>
    Array.from(String(message.content).matchAll(/id="(spell-damage-card-[^"]+)"/g), match => match[1])
  );
  assert.equal(detailIds.length, 2, "each damage card has one expandable final-damage breakdown");
  assert.equal(new Set(detailIds).size, detailIds.length, "old and new damage cards never reuse detail ids");
  record("case 18: spell-damage detail anchors remain unique across module reloads");
}

// ── 19. Explicit Instant/X immediate components stay transient ─────────────

{
  setCombat();
  combatState.started = true;
  caster.system.mp.value = 20;
  const target = monsterOf("instant-x-chilling", "Ice Troll", "1 (1)");
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: chillingBreath, dialogs });
  assert.equal(result.cast, true);
  const card = lastCastCard();
  assert.ok(card.includes("Roll Damage"), "Chilling Breath keeps its manual damage action");
  assert.ok(card.includes(`data-target-id="${target.uuid}"`), "the immediate damage component enables a target-specific manual roll");
  assert.equal(target.effects.length, 1, "the persistent Instant/X component is still created");
  assert.equal(target.effects[0].system.changes.length, 0, "immediate data is not stored in the ActiveEffect");
  assert.ok(!("instantX" in target.effects[0].system), "DEC-49 schema remains unchanged");
  assert.equal(rollQueue.length, 0, "casting consumed only its spellcasting check; damage was not rolled automatically");

  caster.system.mp.value = 20;
  const waterRecipient = monsterOf("instant-x-water", "Thirsty Ally", "1 (1)");
  gameTargets = [{ actor: waterRecipient }];
  rollQueue = [[3, 4]];
  chatCreations.length = 0;
  const waterResult = await castSpellAsMajor({ actor: caster, spell: healingWater, dialogs });
  assert.equal(waterResult.cast, true);
  assert.ok(lastCastCard().includes("The Healing Water is created now."), "the non-damage immediate component is resolved during casting");
  assert.ok(lastCastCard().includes("not automatic"), "drinking and healing remain a later manual action");
  assert.equal(waterRecipient.effects.length, 1, "the persistent water duration queue remains intact");
  assert.equal(waterRecipient.effects[0].system.changes.length, 0);
  assert.equal(rollQueue.length, 0);
  record("case 19: damage and non-damage immediate components resolve at cast; only persistent data is stored");
}

{
  const failingSpell = SPELL("instant-x-failure", "Immediate Failure Probe", {
    target: "character",
    duration: "Instant/3 minutes (18 rounds)",
    resistance: "none"
  });
  let attempts = 0;
  const unregister = registerSw25InstantXImmediateHandler(failingSpell.name, async () => {
    attempts += 1;
    throw new Error("simulated immediate failure");
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    caster.system.mp.value = 20;
    const target = monsterOf("instant-x-failure-target", "Failure Probe Target", "1 (1)");
    gameTargets = [{ actor: target }];
    rollQueue = [[3, 4]];
    const result = await castSpellAsMajor({ actor: caster, spell: failingSpell, dialogs });
    assert.equal(result.cast, true, "an immediate-component failure does not abort the cast");
    assert.equal(attempts, 1, "the failed immediate action is not retried");
    assert.equal(target.effects.length, 1, "persistent creation continues after an immediate failure");
  } finally {
    unregister();
    console.error = originalError;
  }
  record("case 20: immediate failure is not replayed and does not prevent the persistent component");
}

// ── 21. Dispel Magic: eligibility, strict SV comparison, EffectService ─────

const dispelMagic = SPELL("dispel-magic", "Dispel Magic", {
  mpCost: 3,
  hasPowerTable: false,
  metadata: "Target: 1 Spell\nDuration: Instant\nResistance: Neg",
  target: "spell",
  duration: "Instant",
  resistance: "neg"
});

const addProbeEffect = (actor, id, overrides = {}) => {
  const effect = new MockEffect({
    type: "sw25Effect",
    id,
    name: overrides.name ?? id,
    system: {
      family: overrides.family ?? id,
      rank: 0,
      successValue: 10,
      durationScale: "rounds",
      initialDuration: 3,
      remainingDuration: 3,
      isMagical: true,
      resistance: "neg",
      effectType: null,
      successValueSource: "check",
      castId: null,
      effectScope: null,
      gmOnly: false,
      ...overrides.system
    }
  });
  actor.effects.push(effect);
  return effect;
};

{
  clearCombat();
  const target = monsterOf("dispel-target-a", "Dispel Target", "1 (1)");
  const effect = addProbeEffect(target, "probe-shield", { name: "Shield Probe" });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]]; // natural 8 + Magic Power 7 = SV 15
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
  assert.equal(result.cast, true);
  assert.equal(result.check.successValue, 15);
  assert.equal(target.effects.length, 0, "the eligible effect was removed through the effect service");
  assert.equal(effect.system.successValue, 10, "the stored effect SV was read, never rewritten");
  const card = lastCastCard();
  assert.ok(card.includes("Neg (target effect SV comparison)"), "the card states that Dispel Magic compares the effect SV, not a creature resistance");
  assert.ok(card.includes("Shield Probe"), "the targeted effect is named");
  assert.ok(card.includes("SV 15 exceeds the effect's SV 10"), "the strict comparison result is explained");
  assertOutcomeBadge(card, "SUCCESS", "sw25-spell-outcome-success");
  assert.equal(rollQueue.length, 0, "no resistance roll was made");
  record("case 21a: Dispel Magic — eligible magical effect removed by a higher SV");
}

{
  const target = monsterOf("dispel-target-b", "Dispel Target B", "1 (1)");
  addProbeEffect(target, "probe-equal", { name: "Equal Probe", system: { successValue: 15 } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]]; // SV 15 — exactly equal
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
  assert.equal(result.cast, true);
  assert.equal(target.effects.length, 1, "an equal SV does NOT remove the effect");
  const card = lastCastCard();
  assert.ok(card.includes("does not exceed the effect's SV 15 (ties do not cancel)"));
  assertOutcomeBadge(card, "FAILED", "sw25-spell-outcome-failure");
  record("case 21b: Dispel Magic — equality resists; the effect remains untouched");
}

{
  const target = monsterOf("dispel-target-c", "Dispel Target C", "1 (1)");
  addProbeEffect(target, "probe-magical", { name: "Magical Probe", system: { successValue: 2 } });
  addProbeEffect(target, "probe-nonmagical", { name: "Technique Probe", system: { isMagical: false, successValue: 2 } });
  addProbeEffect(target, "probe-curse", { name: "Curse Probe", system: { effectType: "Curse", successValue: 2 } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[5, 5]]; // SV 17
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
  assert.equal(result.cast, true);
  assert.equal(target.effects.length, 2, "only the eligible magical effect was removed");
  assert.ok(target.effects.some(effect => effect.id === "probe-nonmagical"), "non-magical effects are never targeted");
  assert.ok(target.effects.some(effect => effect.id === "probe-curse"), "Curse effects are never targeted");
  const card = lastCastCard();
  assert.ok(card.includes("Technique Probe"), "the ineligible non-magical effect is reported");
  assert.ok(card.includes("Curse Probe"), "the ineligible Curse effect is reported");
  assert.ok(card.includes("cannot be removed"));
  assertOutcomeBadge(card, "SUCCESS", "sw25-spell-outcome-success");
  record("case 21c: Dispel Magic — non-magical and Curse effects stay untouched regardless of SV");
}

{
  const target = monsterOf("dispel-target-d", "Dispel Target D", "1 (1)");
  addProbeEffect(target, "probe-low", { name: "Low Probe", system: { successValue: 5 } });
  addProbeEffect(target, "probe-high", { name: "High Probe", system: { successValue: 29 } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]]; // SV 15
  chatCreations.length = 0;
  const chooserCalls = [];
  const result = await castSpellAsMajor({
    actor: caster,
    spell: dispelMagic,
    dialogs: {
      ...dialogs,
      declareEffect: async ({ candidates }) => {
        chooserCalls.push({ owners: candidates.map(candidate => candidate.target.name), names: candidates.map(candidate => candidate.effect.name) });
        const chosen = candidates.find(candidate => candidate.effect.id === "probe-low");
        return { selection: { actorUuid: chosen.target.uuid, effectId: chosen.effect.id } };
      }
    }
  });
  assert.equal(result.cast, true);
  assert.equal(chooserCalls.length, 1, "multiple eligible effects require an explicit single target");
  assert.deepEqual(chooserCalls[0].names, ["Low Probe", "High Probe"]);
  assert.equal(target.effects.length, 1);
  assert.equal(target.effects[0].id, "probe-high", "only the chosen effect is compared and removed");
  const card = lastCastCard();
  assert.ok(card.includes("High Probe"), "the unchosen eligible effect is reported");
  assert.ok(card.includes("was not targeted and remains in place"));
  record("case 21d: Dispel Magic — the chooser selects the single spell targeted ('Target: 1 spell')");
}

{
  const target = monsterOf("dispel-target-e", "Dispel Target E", "1 (1)");
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
  assert.equal(result.cast, true);
  assert.equal(target.effects.length, 0);
  const card = lastCastCard();
  assert.ok(card.includes("there is no system effect to target"));
  assertOutcomeBadge(card, "NO VALID TARGET", "sw25-spell-outcome-failure");
  record("case 21e: Dispel Magic — a target with no system effects produces NO VALID TARGET");
}

{
  caster.system.mp.value = 20;
  gameTargets = [];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
  assert.equal(result.cast, true, "no target does not abort the cast after the MP cost");
  const card = lastCastCard();
  assert.ok(card.includes("no effect owner was targeted"), "a targetless Dispel explains that nothing was removed");
  assertOutcomeBadge(card, "NO VALID TARGET", "sw25-spell-outcome-failure");
  record("case 21e-bis: Dispel Magic — no selected effect owner is explicit, not a misleading success");
}

{
  const target = monsterOf("dispel-target-f", "Dispel Target F", "1 (1)");
  addProbeEffect(target, "probe-unrecorded", { name: "Unrecorded Probe", system: { isMagical: null, successValue: 1 } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
  assert.equal(result.cast, true);
  assert.equal(target.effects.length, 1, "an unrecorded magical status is not guessed as magical");
  assert.ok(lastCastCard().includes("explicitly classified as magical"));
  record("case 21f: Dispel Magic — legacy/unrecorded magical status is never inferred");
}

{
  const target = monsterOf("dispel-target-g", "Dispel Target G", "1 (1)");
  addProbeEffect(target, "probe-very-high", { name: "Very High Probe", system: { successValue: 30 } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[6, 6]]; // natural double 6: automatic success, SV 12+7+5 = 24
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
  assert.equal(result.cast, true);
  assert.equal(target.effects.length, 0, "automatic success cancels even below the stored SV (CR I p. 166)");
  const card = lastCastCard();
  assert.ok(card.includes("Automatic success (natural double 6)"));
  assertOutcomeBadge(card, "AUTOMATIC SUCCESS", "sw25-spell-outcome-automatic");
  record("case 21g: Dispel Magic — natural double 6 is an automatic cancellation success");
}

{
  // The removal is GM-authoritative: a rejected write is reported, the effect
  // survives, and the outcome is never presented as a successful cancellation.
  const target = monsterOf("dispel-target-h", "Dispel Target H", "1 (1)");
  const effect = addProbeEffect(target, "probe-locked", { name: "Locked Probe", system: { successValue: 2 } });
  const realDelete = effect.delete.bind(effect);
  effect.delete = async () => { throw new Error("Database locked"); };
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]]; // SV 15 > 2
  chatCreations.length = 0;
  try {
    const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
    assert.equal(result.cast, true);
    assert.equal(target.effects.length, 1, "a failed authoritative removal leaves the effect untouched");
    const card = lastCastCard();
    assert.ok(card.includes("The removal failed (write-failed)"), "the card reports the rejected write");
    assertOutcomeBadge(card, "FAILED", "sw25-spell-outcome-failure");
  } finally {
    effect.delete = realDelete;
  }
  record("case 21h: Dispel Magic — a rejected removal is reported and the effect survives");
}

{
  // A player client must not write effects locally. With no connected GM the
  // relay refuses up front (`no-gm`); nothing is deleted and nothing hangs.
  const target = monsterOf("dispel-target-i", "Dispel Target I", "1 (1)");
  addProbeEffect(target, "probe-player", { name: "Player Probe", system: { successValue: 2 } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  mockUserIsGM = false;
  mockActiveGm = null;
  try {
    const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
    assert.equal(result.cast, true);
    assert.equal(target.effects.length, 1, "a player client never deletes the effect directly");
    assert.ok(lastCastCard().includes("The removal failed (no-gm)"), "the missing GM is reported as the removal failure");
    assert.ok(socketEmissions.length === 0, "without a connected GM no relay request is emitted");
  } finally {
    mockUserIsGM = true;
    mockActiveGm = { id: "gm-user" };
  }
  record("case 21i: Dispel Magic — a player client delegates to the relay and never writes locally");
}

{
  // CR I p. 167: "only one magic or effect can be removed" — even when the
  // caster has several effect owners selected, a single cast removes ONE.
  const first = monsterOf("dispel-owner-1", "Owner One", "1 (1)");
  const second = monsterOf("dispel-owner-2", "Owner Two", "1 (1)");
  addProbeEffect(first, "probe-owner-1", { name: "Owner One Probe", system: { successValue: 2 } });
  addProbeEffect(second, "probe-owner-2", { name: "Owner Two Probe", system: { successValue: 2 } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: first }, { actor: second }];
  rollQueue = [[5, 5]]; // SV 17 beats both
  chatCreations.length = 0;
  const seen = [];
  const result = await castSpellAsMajor({
    actor: caster,
    spell: dispelMagic,
    dialogs: {
      ...dialogs,
      declareEffect: async ({ candidates }) => {
        seen.push(candidates.map(candidate => `${candidate.target.name}/${candidate.effect.name}`));
        const chosen = candidates.find(candidate => candidate.effect.id === "probe-owner-2");
        return { selection: { actorUuid: chosen.target.uuid, effectId: chosen.effect.id } };
      }
    }
  });
  assert.equal(result.cast, true);
  assert.deepEqual(seen, [["Owner One/Owner One Probe", "Owner Two/Owner Two Probe"]],
    "one chooser sees every eligible effect across the selected owners");
  assert.equal(first.effects.length, 1, "the effects on the unselected owner survive");
  assert.equal(second.effects.length, 0, "the chosen effect is removed once");
  assert.ok(lastCastCard().includes("Owner One Probe"), "the untouched eligible effect is still reported");
  record("case 21j: Dispel Magic — one cast removes exactly one effect across all selected owners");
}

// ── 21k. Declaration timing and information hiding ─────────────────────────

{
  // CR I p. 167: the effect is declared IN ADVANCE, so the declaration runs
  // before the Spellcasting roll and never shows the passive Success Values.
  const target = monsterOf("dispel-target-k", "Dispel Target K", "1 (1)");
  addProbeEffect(target, "probe-declare", { name: "Declared Probe", system: { successValue: 30 } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const rollMessagesBefore = rollMessages.length;
  let rollsAtDeclaration = null;
  const result = await castSpellAsMajor({
    actor: caster,
    spell: dispelMagic,
    dialogs: {
      ...dialogs,
      declareEffect: async ({ candidates }) => {
        rollsAtDeclaration = rollMessages.length - rollMessagesBefore;
        const chosen = candidates[0];
        return { selection: { actorUuid: chosen.target.uuid, effectId: chosen.effect.id } };
      }
    }
  });
  assert.equal(result.cast, true);
  assert.equal(rollsAtDeclaration, 0, "the effect is declared BEFORE the Spellcasting roll");
  assert.equal(target.effects.length, 1, "SV 15 does not beat the declared SV 30");
  record("case 21k: Dispel Magic — the target effect is declared before the roll");
}

{
  // The DEFAULT declaration dialog lists owners and effect names only: no
  // passive Success Value is displayed before the attempt.
  const target = monsterOf("dispel-target-k2", "Dispel Target K2", "1 (1)");
  addProbeEffect(target, "probe-secret-sv", { name: "Hidden SV Probe", system: { successValue: 30 } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const dialogsBefore = dialogV2Calls.length;
  dialogV2Answers.push("effect-0");
  const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs: { askOptional: dialogs.askOptional } });
  assert.equal(result.cast, true);
  const declaration = dialogV2Calls[dialogsBefore];
  assert.ok(declaration, "the default declaration dialog was used");
  assert.ok(declaration.content.includes("BEFORE the Spellcasting check"));
  for (const button of declaration.buttons) {
    assert.ok(!/SV\s*\d/.test(button.label), `the declaration hides passive Success Values ("${button.label}")`);
    assert.ok(!button.label.includes("30"), "the stored SV never appears in a declaration label");
  }
  assert.equal(target.effects.length, 1, "SV 15 does not beat SV 30");
  record("case 21k-bis: Dispel Magic — the declaration never reveals passive Success Values");
}

// ── 21l. gmOnly effects are never exposed ──────────────────────────────────

{
  const target = monsterOf("dispel-target-l", "Dispel Target L", "1 (1)");
  addProbeEffect(target, "probe-visible", { name: "Visible Probe", system: { successValue: 30 } });
  addProbeEffect(target, "probe-concealed", { name: "Concealed Main Section", system: { successValue: 2, gmOnly: true } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  let offered = null;
  mockUserIsGM = false;
  try {
    const result = await castSpellAsMajor({
      actor: caster,
      spell: dispelMagic,
      dialogs: {
        ...dialogs,
        declareEffect: async ({ candidates }) => {
          offered = candidates.map(candidate => candidate.effect.id);
          return { selection: null }; // no removal: no GM relay is needed
        }
      }
    });
    assert.equal(result.cast, true);
    assert.deepEqual(offered, ["probe-visible"], "a player is never offered gmOnly effects");
    const card = lastCastCard();
    assert.ok(!card.includes("Concealed Main Section"), "the public card never names the hidden effect");
    assert.ok(card.includes("Visible Probe"), "the visible effect is still reported");
    assert.equal(target.effects.length, 2, "nothing was removed without a declaration");
  } finally {
    mockUserIsGM = true;
  }
  record("case 21l: Dispel Magic — gmOnly effects are hidden from the player selection and the card");
}

{
  // The GM view keeps gmOnly effects: they can be declared and removed
  // through the same GM-authoritative path.
  const target = monsterOf("dispel-target-l2", "Dispel Target L2", "1 (1)");
  addProbeEffect(target, "probe-gm-concealed", { name: "Concealed Main Section", system: { successValue: 2, gmOnly: true } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
  assert.equal(result.cast, true);
  assert.equal(target.effects.length, 0, "the GM can declare and remove a gmOnly effect");
  record("case 21l-bis: Dispel Magic — the GM view can still declare gmOnly effects");
}

// ── 21m. Stale or forged declarations are rejected ─────────────────────────

{
  const target = monsterOf("dispel-target-m", "Dispel Target M", "1 (1)");
  const declared = addProbeEffect(target, "probe-stale", { name: "Stale Probe", system: { successValue: 2 } });
  addProbeEffect(target, "probe-survivor", { name: "Survivor Probe", system: { successValue: 2 } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[5, 5]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({
    actor: caster,
    spell: dispelMagic,
    dialogs: {
      ...dialogs,
      declareEffect: async () => {
        const selection = { actorUuid: target.uuid, effectId: declared.id };
        await declared.delete(); // the effect disappears between declare and result
        return { selection };
      }
    }
  });
  assert.equal(result.cast, true);
  assert.ok(lastCastCard().includes("no longer a valid target"), "a stale declaration is rejected, not trusted");
  assert.deepEqual(target.effects.map(effect => effect.id), ["probe-survivor"], "no other effect is removed by a stale declaration");
  record("case 21m: Dispel Magic — a stale declaration removes nothing");
}

{
  const target = monsterOf("dispel-target-m2", "Dispel Target M2", "1 (1)");
  addProbeEffect(target, "probe-real", { name: "Real Probe", system: { successValue: 2 } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[5, 5]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({
    actor: caster,
    spell: dispelMagic,
    dialogs: {
      ...dialogs,
      declareEffect: async () => ({ selection: { actorUuid: target.uuid, effectId: "forged-effect-id" } })
    }
  });
  assert.equal(result.cast, true);
  assert.ok(lastCastCard().includes("no longer a valid target"), "a forged effect id is rejected");
  assert.equal(target.effects.length, 1, "a forged id never removes an effect");
  record("case 21m-bis: Dispel Magic — a forged client selection is rejected");
}

// ── 21n/21o. Area scope: /Space vs /All and /Z ─────────────────────────────

{
  const first = monsterOf("dispel-space-a", "Space Owner A", "1 (1)");
  const second = monsterOf("dispel-space-b", "Space Owner B", "1 (1)");
  const third = monsterOf("dispel-space-c", "Space Owner C", "1 (1)");
  addProbeEffect(first, "probe-space-a", { name: "Area Spell", system: { successValue: 2, castId: "cast-space-1", effectScope: "space" } });
  addProbeEffect(second, "probe-space-b", { name: "Area Spell", system: { successValue: 2, castId: "cast-space-1", effectScope: "space" } });
  addProbeEffect(third, "probe-space-c", { name: "Area Spell", system: { successValue: 2, castId: "cast-space-2", effectScope: "space" } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: first }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
  assert.equal(result.cast, true);
  assert.equal(first.effects.length, 0, "the declared representation is removed");
  assert.equal(second.effects.length, 0, "the SAME casting's other Actor representation is removed too (CR I p. 167)");
  assert.equal(third.effects.length, 1, "a different casting of the same spell is untouched");
  assert.ok(lastCastCard().includes("one effect for the whole area"), "the card explains the shared /Space removal");
  record("case 21n: Dispel Magic — /Space removes every representation of the declared casting");
}

{
  const first = monsterOf("dispel-all-a", "All Owner A", "1 (1)");
  const second = monsterOf("dispel-all-b", "All Owner B", "1 (1)");
  addProbeEffect(first, "probe-all-a", { name: "Area Spell", system: { successValue: 2, castId: "cast-all-1", effectScope: "all" } });
  addProbeEffect(second, "probe-all-b", { name: "Area Spell", system: { successValue: 2, castId: "cast-all-1", effectScope: "all" } });
  addProbeEffect(second, "probe-limited-b", { name: "Limited Spell", system: { successValue: 2, castId: "cast-all-1", effectScope: "limited" } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: first }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
  assert.equal(result.cast, true);
  assert.equal(first.effects.length, 0, "the declared character's effect is removed");
  assert.equal(second.effects.length, 2, "/All and /Z effects on other characters are NEVER removed together");
  record("case 21o: Dispel Magic — /All and /Z stay individual per character");
}

// ── 21p/21q. Unrecorded Success Value vs legitimate zero ───────────────────

{
  const target = monsterOf("dispel-target-p", "Dispel Target P", "1 (1)");
  addProbeEffect(target, "probe-unknown-sv", { name: "Unknown SV Probe", system: { successValue: 0, successValueSource: null } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  let recoverCalls = 0;
  const result = await castSpellAsMajor({
    actor: caster,
    spell: dispelMagic,
    dialogs: {
      ...dialogs,
      recoverSuccessValue: async () => { recoverCalls += 1; return 20; }
    }
  });
  assert.equal(result.cast, true);
  assert.equal(recoverCalls, 1, "the unrecorded SV is determined again at cancellation time (CR I p. 167)");
  assert.equal(target.effects.length, 1, "the re-determined SV 20 resists SV 15 — no silent zero was used");
  assert.ok(lastCastCard().includes("does not exceed the effect's SV 20"));
  record("case 21p: Dispel Magic — an unrecorded SV is re-determined, never treated as 0");
}

{
  const target = monsterOf("dispel-target-p2", "Dispel Target P2", "1 (1)");
  addProbeEffect(target, "probe-no-recovery", { name: "No Recovery Probe", system: { successValue: 0, successValueSource: null } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({
    actor: caster,
    spell: dispelMagic,
    dialogs: { ...dialogs, recoverSuccessValue: async () => null }
  });
  assert.equal(result.cast, true);
  assert.equal(target.effects.length, 1, "without a re-determined value nothing is removed");
  assert.ok(lastCastCard().includes("not recorded"), "the card explains the missing Success Value");
  record("case 21p-bis: Dispel Magic — an unrecoverable SV removes nothing");
}

{
  const target = monsterOf("dispel-target-q", "Dispel Target Q", "1 (1)");
  addProbeEffect(target, "probe-zero", { name: "Zero SV Probe", system: { successValue: 0, successValueSource: "none" } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  let recoverCalls = 0;
  const result = await castSpellAsMajor({
    actor: caster,
    spell: dispelMagic,
    dialogs: { ...dialogs, recoverSuccessValue: async () => { recoverCalls += 1; return 99; } }
  });
  assert.equal(result.cast, true);
  assert.equal(recoverCalls, 0, "a recorded SV 0 is authoritative: no recovery is requested");
  assert.equal(target.effects.length, 0, "SV 15 beats the legitimate SV 0");
  record("case 21q: Dispel Magic — a legitimate SV 0 is not confused with a missing value");
}

// ── 21r. Passive-side automatic success (+5 already stored) ────────────────

{
  const target = monsterOf("dispel-target-r", "Dispel Target R", "1 (1)");
  addProbeEffect(target, "probe-auto-origin", { name: "Automatic Origin Probe", system: { successValue: 21, successValueSource: "automatic" } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[7, 7]]; // natural 14 + Magic Power 7 = SV 21, exactly the +5 value
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
  assert.equal(result.cast, true);
  assert.equal(target.effects.length, 1, "equality with the automatic-success SV does not cancel");
  assert.ok(lastCastCard().includes("does not exceed the effect's SV 21"));
  record("case 21r: Dispel Magic — a passive automatic success keeps its +5 SV and resists equality");
}

{
  const target = monsterOf("dispel-target-r2", "Dispel Target R2", "1 (1)");
  addProbeEffect(target, "probe-auto-origin-2", { name: "Automatic Origin Probe", system: { successValue: 21, successValueSource: "automatic" } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[7, 8]]; // SV 22 > 21
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: dispelMagic, dialogs });
  assert.equal(result.cast, true);
  assert.equal(target.effects.length, 0, "an automatic-success effect is NOT immune: exceeding its +5 SV cancels it");
  record("case 21r-bis: Dispel Magic — exceeding the +5 SV cancels an automatic-success effect");
}

// ── 21s. Separate castings of the same spell stay identifiable ─────────────

{
  const target = monsterOf("dispel-target-s", "Dispel Target S", "1 (1)");
  addProbeEffect(target, "probe-cast-1", { name: "Repeated Spell", family: "Repeated Spell", system: { successValue: 2, castId: "cast-repeat-1" } });
  addProbeEffect(target, "probe-cast-2", { name: "Repeated Spell", family: "Repeated Spell", system: { successValue: 2, castId: "cast-repeat-2" } });
  caster.system.mp.value = 20;
  gameTargets = [{ actor: target }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  let offered = null;
  const result = await castSpellAsMajor({
    actor: caster,
    spell: dispelMagic,
    dialogs: {
      ...dialogs,
      declareEffect: async ({ candidates }) => {
        offered = candidates.map(candidate => candidate.effect.system.castId);
        const chosen = candidates.find(candidate => candidate.effect.system.castId === "cast-repeat-2");
        return { selection: { actorUuid: chosen.target.uuid, effectId: chosen.effect.id } };
      }
    }
  });
  assert.equal(result.cast, true);
  assert.deepEqual(offered, ["cast-repeat-1", "cast-repeat-2"], "two castings of one spell are separate declarations");
  assert.deepEqual(target.effects.map(effect => effect.id), ["probe-cast-1"], "only the declared casting is removed");
  record("case 21s: Dispel Magic — separate castings of the same spell remain independently identifiable");
}

// ── 22. Cancellation eligibility data is recorded when effects are created ─

{
  setCombat();
  combatState.started = true;
  caster.effects = [];
  caster.system.mp.value = 20;
  gameTargets = [];
  rollQueue = [];
  chatCreations.length = 0;
  const result = await castSpellAsMinor({ actor: caster, spell: quickShield, applyCost: true });
  assert.equal(result.cast, true);
  assert.equal(caster.effects.length, 1);
  assert.equal(caster.effects[0].system.isMagical, true, "spell effects record their magical status");
  assert.equal(caster.effects[0].system.resistance, "cant", "the emitting resistance notation is stored as provenance (not as an eligibility condition)");
  assert.equal(caster.effects[0].system.successValueSource, "none", "a no-check cast records its SV provenance");
  assert.equal(caster.effects[0].system.successValue, 0, "SV 0 with a recorded source is authoritative");
  assert.equal(typeof caster.effects[0].system.castId, "string", "every cast records its casting identity");
  assert.ok(caster.effects[0].system.castId.length > 0);
  assert.equal(caster.effects[0].system.effectScope, null, "a non-area spell has no area scope");
  record("case 22: created effects record isMagical, resistance provenance, SV provenance and castId");
}

// ── 23. Success Value provenance and casting identity at creation ─────────

{
  setCombat();
  combatState.started = true;
  caster.effects = [];
  caster.system.mp.value = 20;
  gameTargets = [];
  rollQueue = [[6, 6]]; // natural double 6: SV 12 + 5 + Magic Power 7 = 24
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: quickShield, dialogs });
  assert.equal(result.cast, true);
  assert.equal(caster.effects.length, 1);
  assert.equal(caster.effects[0].system.successValue, 24, "the +5 automatic-success bonus is stored inside the SV (DEC-6)");
  assert.equal(caster.effects[0].system.successValueSource, "automatic", "the automatic origin is recorded explicitly");
  record("case 23a: an automatic-success cast stores SV+5 and the automatic provenance");
}

{
  caster.effects = [];
  caster.system.mp.value = 20;
  gameTargets = [];
  rollQueue = [[4, 4]]; // SV 15, ordinary check
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: quickShield, dialogs });
  assert.equal(result.cast, true);
  assert.equal(caster.effects[0].system.successValue, 15);
  assert.equal(caster.effects[0].system.successValueSource, "check", "an ordinary check records its own provenance");
  const firstCastId = caster.effects[0].system.castId;
  caster.system.mp.value = 20;
  rollQueue = [[4, 4]];
  await castSpellAsMajor({ actor: caster, spell: quickShield, dialogs });
  const newEffects = caster.effects.filter(effect => effect.system.castId !== firstCastId);
  assert.ok(newEffects.length >= 1, "the second casting created its own effect representation");
  assert.ok(newEffects.every(effect => typeof effect.system.castId === "string" && effect.system.castId === newEffects[0].system.castId),
    "one casting shares one castId, and it is never the previous casting's id");
  record("case 23b: ordinary casts record check provenance and distinct casting identities");
}

{
  // The area selection mode of the spell is copied onto every representation
  // of the cast, and one cast shares ONE castId across all its targets.
  const areaSpell = SPELL("area-space-probe", "Area Space Probe", {
    mpCost: 4,
    hasPowerTable: false,
    metadata: "Target: 1 area (3m radius)/Space\nDuration: Instant/3 rounds\nResistance: Can't",
    target: { type: "area", areaCount: 1, radius: 3, selection: "space", maxTargets: null },
    duration: "Instant/3 rounds",
    resistance: "cant"
  });
  const first = monsterOf("area-space-target-1", "Area Target One", "1 (1)");
  const second = monsterOf("area-space-target-2", "Area Target Two", "1 (1)");
  caster.system.mp.value = 20;
  gameTargets = [{ actor: first }, { actor: second }];
  rollQueue = [[4, 4]];
  chatCreations.length = 0;
  const result = await castSpellAsMajor({ actor: caster, spell: areaSpell, dialogs });
  assert.equal(result.cast, true);
  assert.equal(first.effects.length, 1);
  assert.equal(second.effects.length, 1);
  assert.equal(first.effects[0].system.effectScope, "space", "the /Space selection mode is recorded");
  assert.equal(first.effects[0].system.castId, second.effects[0].system.castId,
    "one area cast shares one castId across all its Actor representations");
  record("case 23c: area casts record their scope and share one castId across targets");
}

// ── Completion ─────────────────────────────────────────────────────────────

console.log("Spellcasting flow: all cases passed.");
process.exit(0);
