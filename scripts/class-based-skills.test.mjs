import assert from "node:assert/strict";
import { SKILL_DEFINITIONS, SKILL_DEFINITION_MAP, skillKey, skillsByAbility, adventurerLevelSkills, classBasedSkills } from "../module/rules/skill-definitions.mjs";
import { classEditorSkillOptions, highestLevelClass, manualOnlyClasses, normalEligibleClasses, resolveSkillClass, resolvedSkillLevel } from "../module/rules/skill-resolution.mjs";
import { abilityBonus, isWarriorClass } from "../module/rules/weapon-damage.mjs";
import { playerInitiativeModifier } from "../module/combat/side-initiative.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Plain stand-ins for real class Items: the resolver must work on exactly the
// shape the sheet passes to it (id, name, system.level, system.skillChecks).
const cls = (id, name, level, skillChecks = []) => ({ id, name, system: { level, skillChecks } });

const classPool = levels => Object.entries(levels).map(([name, level], index) =>
  cls(`${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${index}`, name, level)
);

const defOf = key => {
  const def = SKILL_DEFINITION_MAP.get(key);
  assert.ok(def, `Skill definition must exist: ${key}`);
  return def;
};

// Association names a skill grants within a pool of standard classes
// (no skillChecks configured, so the rulebook associations drive the result).
const ASSOC_CLASSES = { Fighter: 9, Scout: 3, Ranger: 2, Sage: 1, Rider: 1, Alchemist: 1, Geomancer: 1, Tactician: 1, Bard: 1, "Dark Hunter": 1 };
const assocPool = classPool(ASSOC_CLASSES);
const grantedClassNames = key => normalEligibleClasses(assocPool, defOf(key)).map(item => item.name).sort();

// ---------------------------------------------------------------------------
// 1. Catalogue integrity
// ---------------------------------------------------------------------------

console.log("Catalogue integrity...");

// No duplicated definitions and stable canonical keys.
assert.equal(SKILL_DEFINITIONS.length, SKILL_DEFINITION_MAP.size, "No duplicated skill definitions");
assert.equal(skillKey("Climb", "agility"), "climb-agility");
assert.equal(skillKey("Climb", "strength"), "climb-strength");
assert.notEqual(defOf("climb-agility").key, defOf("climb-strength").key, "Climb variants remain separate entries");
assert.equal(defOf("climb-agility").ability, "agility");
assert.equal(defOf("climb-strength").ability, "strength");

// Grouping by ability covers every definition exactly once.
const groupedCount = Object.values(skillsByAbility).reduce((total, list) => total + list.length, 0);
assert.equal(groupedCount, SKILL_DEFINITIONS.length, "skillsByAbility covers the whole catalogue");

// ---------------------------------------------------------------------------

console.log("Core Rulebook I associations...");

assert.deepEqual(grantedClassNames("concealment-dexterity"), ["Ranger", "Scout"]);
assert.deepEqual(grantedClassNames("disable-dexterity"), ["Ranger", "Scout"]);
assert.deepEqual(grantedClassNames("first-aid-dexterity"), ["Ranger"]);
assert.deepEqual(grantedClassNames("pickpocket-dexterity"), ["Scout"]);
assert.deepEqual(grantedClassNames("disguise-dexterity"), ["Scout"]);
assert.deepEqual(grantedClassNames("set-trap-dexterity"), ["Ranger", "Scout"]);
assert.deepEqual(grantedClassNames("acrobatics-agility"), ["Ranger", "Scout"]);
assert.deepEqual(grantedClassNames("climb-agility"), ["Ranger", "Scout"]);
assert.deepEqual(grantedClassNames("follow-agility"), ["Ranger", "Scout"]);
assert.deepEqual(grantedClassNames("stealth-agility"), ["Ranger", "Scout"]);
assert.deepEqual(grantedClassNames("listen-intelligence"), ["Ranger", "Scout"]);
assert.deepEqual(grantedClassNames("appraisal-intelligence"), ["Sage", "Scout"]);

// ---------------------------------------------------------------------------

console.log("Core Rulebook II and III associations...");

assert.deepEqual(grantedClassNames("performance-spirit"), ["Bard"]);
assert.deepEqual(grantedClassNames("ride-agility"), ["Rider"], "Riding uses Rider level + Agility");
assert.deepEqual(grantedClassNames("weakness-intelligence"), ["Rider"]);
assert.deepEqual(grantedClassNames("evocation-intelligence"), ["Alchemist"]);

// ---------------------------------------------------------------------------

console.log("Aditive package results...");

const FINAL_ASSOCIATIONS = {
  "insight-intelligence": ["Alchemist", "Sage"],
  "literature-intelligence": ["Alchemist", "Sage"],
  "herbology-intelligence": ["Alchemist", "Ranger", "Sage"],
  "cartography-intelligence": ["Ranger", "Rider", "Sage", "Scout"],
  "tumble-agility": ["Ranger", "Rider", "Scout"],
  "track-intelligence": ["Ranger", "Rider", "Scout"],
  "perception-intelligence": ["Ranger", "Rider", "Scout"],
  "sense-danger-intelligence": ["Ranger", "Rider", "Scout"],
  "spot-traps-intelligence": ["Ranger", "Rider", "Scout"],
  "search-intelligence": ["Geomancer", "Ranger", "Rider", "Scout"],
  "weather-intelligence": ["Geomancer", "Ranger", "Scout"]
};
for (const [key, expected] of Object.entries(FINAL_ASSOCIATIONS)) {
  assert.deepEqual(grantedClassNames(key), expected, `${key} final associations`);
}

// Monster Knowledge normal associations and manual-only layer.
assert.deepEqual(grantedClassNames("monster-knowledge-intelligence"), ["Rider", "Sage"]);
assert.deepEqual(manualOnlyClasses(assocPool, defOf("monster-knowledge-intelligence")).map(item => item.name), ["Dark Hunter"]);

// ---------------------------------------------------------------------------

console.log("Preserved extra entries and exclusions...");

for (const key of ["knowledge-intelligence", "reference-intelligence", "medicine-intelligence", "archaeology-intelligence", "evade-trap-intelligence", "swim-combat--agility"]) {
  assert.ok(SKILL_DEFINITION_MAP.has(key), `Extra entry preserved: ${key}`);
}
assert.deepEqual(grantedClassNames("evade-trap-intelligence"), []);

// Banish and Magitech Object Repair must not exist in the catalogue.
const bannedNames = ["Banish", "Magitech Object Repair"];
for (const skill of SKILL_DEFINITIONS) {
  assert.ok(!bannedNames.some(name => skill.name.toLowerCase() === name.toLowerCase()), `No banned entry: ${skill.name}`);
}

// Resistances and special combat checks stay outside the ordinary catalogue.
for (const name of ["Death Check", "Fortitude", "Willpower", "Accuracy (skill)", "Evasion (skill)", "Initiative (skill)"]) {
  assert.ok(!SKILL_DEFINITIONS.some(skill => skill.name.startsWith(name.split(" (")[0])), `Not an ordinary catalogue entry: ${name}`);
}

// Work Skills are not catalogue entries; their integration stays untouched.
assert.ok(!SKILL_DEFINITIONS.some(skill => /work/i.test(skill.name)), "No Work Skill entries in the catalogue");

// Reference times for the entries added with Core Rulebook III.
const EXPECTED_TIMES = {
  "detect-intelligence": "10 sec",
  "literature-intelligence": "10 min",
  "engineering-intelligence": "10 min",
  "pathology-intelligence": "10 min",
  "spot-traps-intelligence": "Instant"
};
for (const [key, time] of Object.entries(EXPECTED_TIMES)) {
  assert.equal(defOf(key).time, time, `${key} time required`);
}

// ---------------------------------------------------------------------------

console.log("Contextual restriction metadata (informational only)...");

assert.ok(defOf("disable-dexterity").restrictions.some(note => /natural environments/i.test(note)));
assert.ok(defOf("set-trap-dexterity").restrictions.some(note => /natural environments/i.test(note)));
assert.ok(defOf("cartography-intelligence").restrictions.some(note => /natural environments/i.test(note)));
assert.ok(defOf("perception-intelligence").restrictions.some(note => /Search Command/i.test(note)));
assert.ok(defOf("search-intelligence").restrictions.some(note => /Search Command/i.test(note)));
assert.ok(defOf("monster-knowledge-intelligence").restrictions.some(note => /Daemons/i.test(note)));
assert.ok(defOf("investigation-intelligence").restrictions.some(note => /GM/i.test(note)));

// ---------------------------------------------------------------------------
// 2. Class resolution through the production resolver
// ---------------------------------------------------------------------------

console.log("Automatic selection by level (order-independent)...");

// Sage Lv3 and Alchemist Lv1 both provide Insight; array order is scrambled.
const scrambled = classPool({ Alchemist: 1, Fighter: 9, Sage: 3 });
const insight = resolveSkillClass({ classes: scrambled, def: "insight-intelligence" });
assert.equal(insight.classId, "sage-2", "Automatic selection is the explicitly highest-level association");
assert.equal(insight.level, 3);
assert.equal(insight.options.find(option => option.value === insight.classId).selected, true);
assert.equal(highestLevelClass(scrambled).name, "Fighter", "highestLevelClass is explicit, not array order");

// Normal association: manual selection and automatic selection both work.
const manualInsight = resolveSkillClass({ classes: scrambled, def: "insight-intelligence", savedValue: "alchemist-0" });
assert.equal(manualInsight.classId, "alchemist-0", "Valid manual selection is preserved");
assert.equal(manualInsight.preserved, true);

// ---------------------------------------------------------------------------

console.log("Invalid manual selections fall back automatically...");

const withoutSage = classPool({ Alchemist: 1, Fighter: 9 });
const staleInsight = resolveSkillClass({ classes: withoutSage, def: "insight-intelligence", savedValue: "sage-2" });
assert.equal(staleInsight.classId, "alchemist-0", "Stale selection is replaced by the highest-level remaining class");
assert.equal(staleInsight.preserved, false);

// Custom classes may add associations through skillChecks.
const customGrant = classPool({ Fighter: 5, "Hero Guild": 1 });
customGrant[0].system.skillChecks = ["climb-agility"];
const customClimb = resolveSkillClass({ classes: customGrant, def: "climb-agility" });
assert.equal(customClimb.classId, "fighter-0", "skillChecks adds an association for custom classes");

// ---------------------------------------------------------------------------

console.log("No eligible class yields zero...");

const uneligible = resolveSkillClass({ classes: classPool({ Fighter: 5 }), def: "concealment-dexterity" });
assert.equal(uneligible.classId, "", "No class is selected when none is eligible");
assert.equal(uneligible.level, 0, "Level is zero, not the ability modifier alone");
assert.equal(resolvedSkillLevel({ classId: "", classes: classPool({ Fighter: 5 }), adventurerLevel: 7 }), 0);

// ---------------------------------------------------------------------------

console.log("Explicit none versus absent selection...");

const candidates = classPool({ Sage: 4, Alchemist: 2 });
const absent = resolveSkillClass({ classes: candidates, def: "insight-intelligence" });
assert.equal(absent.classId, "sage-0", "Absent selection falls back to the automatic class");
const explicitNone = resolveSkillClass({ classes: candidates, def: "insight-intelligence", savedValue: "none" });
assert.equal(explicitNone.classId, "", "Explicit none keeps no class even when candidates exist");
assert.equal(explicitNone.explicitNone, true);
assert.equal(explicitNone.level, 0);
const legacyEmpty = resolveSkillClass({ classes: candidates, def: "insight-intelligence", savedValue: "" });
assert.equal(legacyEmpty.classId, "sage-0", "Legacy empty string is treated as absent (non-destructive)");

// ---------------------------------------------------------------------------

console.log("Adventurer Level skills...");

assert.ok(adventurerLevelSkills.has("jump-agility"), "Jump");
assert.ok(adventurerLevelSkills.has("climb-strength"), "Climb (Strength)");
assert.ok(adventurerLevelSkills.has("strength-strength"), "Strength");
assert.ok(adventurerLevelSkills.has("detect-intelligence"), "Detect");
assert.ok(adventurerLevelSkills.has("swim-agility"), "Swim");
assert.ok(adventurerLevelSkills.has("swim-combat--agility"), "Swim (Combat)");
assert.ok(!adventurerLevelSkills.has("insight-intelligence"), "Insight is NOT Adventurer Level");
assert.ok(!adventurerLevelSkills.has("ride-agility"), "Riding is NOT Adventurer Level");

const fighterWithJump = classPool({ Fighter: 5 });
fighterWithJump[0].system.skillChecks = ["jump-agility"];
const jumpAuto = resolveSkillClass({ classes: fighterWithJump, def: "jump-agility", adventurerLevel: 7 });
assert.equal(jumpAuto.classId, "adventurer", "Unselected Adventurer skill defaults to Adventurer Level");
assert.equal(jumpAuto.level, 7);
const jumpPreserved = resolveSkillClass({ classes: fighterWithJump, def: "jump-agility", savedValue: "adventurer", adventurerLevel: 7 });
assert.equal(jumpPreserved.classId, "adventurer", "Saved 'adventurer' is preserved without a class Item lookup");
assert.equal(jumpPreserved.preserved, true);
const jumpManual = resolveSkillClass({ classes: fighterWithJump, def: "jump-agility", savedValue: "fighter-0", adventurerLevel: 7 });
assert.equal(jumpManual.classId, "fighter-0", "A valid class may still be selected manually for an Adventurer skill");

// ---------------------------------------------------------------------------

console.log("Dark Hunter Monster Knowledge (manual only)...");

const hunterPool = classPool({ Sage: 3, "Dark Hunter": 9, Scout: 6 });
const monsterDef = defOf("monster-knowledge-intelligence");
const monsterAuto = resolveSkillClass({ classes: hunterPool, def: monsterDef });
assert.equal(monsterAuto.classId, "sage-0", "Dark Hunter is never auto-selected despite its higher level");
assert.equal(monsterAuto.level, 3);
assert.ok(monsterAuto.options.some(option => option.value === "dark-hunter-1" && option.label === "Dark Hunter"), "Dark Hunter appears as a manual option");

const monsterManual = resolveSkillClass({ classes: hunterPool, def: monsterDef, savedValue: "dark-hunter-1" });
assert.equal(monsterManual.classId, "dark-hunter-1", "Manual Dark Hunter selection is preserved");
assert.equal(monsterManual.level, 9);
assert.equal(monsterManual.preserved, true);

// skillChecks cannot promote a manual-only class to an automatic one.
const promotedHunter = classPool({ "Dark Hunter": 9 });
promotedHunter[0].system.skillChecks = ["monster-knowledge-intelligence"];
assert.deepEqual(normalEligibleClasses(promotedHunter, monsterDef), [], "Manual-only classes stay out of automatic resolution");

// Dark Hunter is not offered elsewhere because of this change.
assert.deepEqual(manualOnlyClasses(hunterPool, defOf("performance-spirit")), []);
for (const key of ["concealment-dexterity", "climb-agility", "insight-intelligence", "search-intelligence"]) {
  assert.equal(manualOnlyClasses(hunterPool, defOf(key)).length, 0, `No manual-only Dark Hunter layer on ${key}`);
}

// ---------------------------------------------------------------------------

console.log("Investigation special selection...");

const investigationDef = defOf("investigation-intelligence");
assert.equal(investigationDef.classMode, "any");

const investigationPool = classPool({ Fighter: 2, Sage: 5 });
investigationPool.forEach(item => item.system.skillChecks.length = 0); // deliberately empty skillChecks
const investigationAuto = resolveSkillClass({ classes: investigationPool, def: investigationDef });
assert.equal(investigationAuto.classId, "sage-1", "Investigation defaults to the highest-level class of the character");
assert.ok(investigationAuto.options.some(option => option.value === "fighter-0"), "Every class of the character is offered");
assert.ok(investigationAuto.options.some(option => option.value === "sage-1"), "Every class of the character is offered");

const investigationManual = resolveSkillClass({ classes: investigationPool, def: investigationDef, savedValue: "fighter-0" });
assert.equal(investigationManual.classId, "fighter-0", "Manual Investigation selection is preserved");

const investigationAfterRemoval = resolveSkillClass({ classes: [investigationPool[1]], def: investigationDef, savedValue: "fighter-0" });
assert.equal(investigationAfterRemoval.classId, "sage-1", "When the selected class disappears the highest remaining one is used");

const investigationEmpty = resolveSkillClass({ classes: [], def: investigationDef });
assert.equal(investigationEmpty.classId, "", "Investigation without classes resolves to zero");
assert.equal(investigationEmpty.level, 0);

// ---------------------------------------------------------------------------

console.log("Special formulas and regressions...");

// Performance: Bard level + Spirit modifier (ordinary class resolution).
const bardSystem = { abilityBases: { mind: 12 }, abilityAdjustments: {} };
assert.equal(abilityBonus(bardSystem, "spirit"), 2);
const performanceResolve = resolveSkillClass({ classes: classPool({ Bard: 4 }), def: "performance-spirit" });
assert.equal(performanceResolve.level, 4);
assert.equal(defOf("performance-spirit").ability, "spirit");

// Swim, Climb (Strength), Strength: Adventurer Level + ability modifier.
const swimResolve = resolveSkillClass({ classes: classPool({ Sage: 3 }), def: "swim-agility", adventurerLevel: 6 });
assert.equal(swimResolve.classId, "adventurer");
assert.equal(swimResolve.level, 6, "Swim uses Adventurer Level, not the highest class level");

// Riding, Weakness, Evocation package formulas through ordinary resolution.
assert.equal(resolveSkillClass({ classes: classPool({ Rider: 2 }), def: "ride-agility" }).level, 2);
assert.equal(resolveSkillClass({ classes: classPool({ Rider: 2 }), def: "weakness-intelligence" }).level, 2);
assert.equal(resolveSkillClass({ classes: classPool({ Alchemist: 1 }), def: "evocation-intelligence" }).level, 1);

// Geomancer Observation (Search, Meteorology) uses the Geomancer association.
const geomancerSearch = resolveSkillClass({ classes: classPool({ Geomancer: 2, Fighter: 9 }), def: "search-intelligence" });
assert.equal(geomancerSearch.classId, "geomancer-0", "Geomancer provides Search for its Observation check");
const geomancerOnly = resolveSkillClass({ classes: classPool({ Geomancer: 2 }), def: "weather-intelligence", savedValue: "geomancer-0" });
assert.equal(geomancerOnly.classId, "geomancer-0");
assert.equal(geomancerOnly.level, 2);

// Preserved special formulas keep their production functions.
assert.equal(playerInitiativeModifier(3, 1, 2, 0), 5, "Initiative remains Scout/Tactician level + Agility");
assert.equal(isWarriorClass({ type: "class", name: "Fighter", system: { classType: "" } }), true, "Accuracy still uses warrior-type classes");
assert.equal(isWarriorClass({ type: "class", name: "Sage", system: { classType: "" } }), false);

// ---------------------------------------------------------------------------

console.log("Work Skills integration stays intact...");

const workSkills = [{ id: "w1", name: "Farmhand", level: 3 }];
const workResolve = resolveSkillClass({ classes: classPool({ Sage: 4 }), def: "insight-intelligence", savedValue: "work:w1", workSkills });
assert.equal(workResolve.classId, "work:w1", "A saved Work Skill source is preserved");
assert.equal(workResolve.level, 3, "The Work Skill level feeds the check");
const workOption = resolveSkillClass({ classes: classPool({ Sage: 4 }), def: "insight-intelligence", workSkills });
assert.ok(workResolve.options.some(option => option.value === "work:w1" && option.label === "Work: Farmhand"));
assert.ok(workOption.options.some(option => option.value === "work:w1"));

// ---------------------------------------------------------------------------

console.log("Class editor options...");

const editorOptions = classEditorSkillOptions(["climb-agility", "literature-intelligence"]);
assert.equal(editorOptions.length, SKILL_DEFINITIONS.length);
for (const option of editorOptions) {
  assert.ok(SKILL_DEFINITION_MAP.has(option.value), `Editor values are canonical keys: ${option.value}`);
  assert.ok(option.label.length > 0, "Labels are readable");
}
const climbOption = editorOptions.find(option => option.value === "climb-agility");
assert.equal(climbOption.selected, true, "Saved canonical key is shown as selected");
assert.equal(climbOption.label, "Climb (Agility)");
const disableOption = editorOptions.find(option => option.value === "disable-dexterity");
assert.equal(disableOption.label, "Disable* (Dexterity)");
assert.ok(disableOption.title.includes("natural environments"), "Restrictions surface as tooltips only");
const literatureOption = editorOptions.find(option => option.value === "literature-intelligence");
assert.equal(literatureOption.selected, true, "New associations are configurable in the editor");
const monsterOption = editorOptions.find(option => option.value === "monster-knowledge-intelligence");
assert.ok(monsterOption.title.includes("Daemons"));

// ---------------------------------------------------------------------------

console.log("\nAll class-based skill availability tests passed.");
