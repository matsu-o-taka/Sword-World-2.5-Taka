// Shared skill definitions for Sword World 2.5.
// This is the sole source of truth for Skill Check metadata used by the
// character sheet (actor-sheet.mjs) and the class Item editor (item-sheet.mjs).
//
// Each skill definition includes:
//   key:            Internal identifier (name + ability, e.g. "climb-agility")
//   name:           Display name
//   ability:        Characteristic (dexterity, agility, strength, intelligence, spirit)
//   time:           Time required to use
//   displayName:    Override display name (e.g. "Disable*" instead of "Disable")
//   fixedClassName: When "Adventurer", the standard value is Adventurer Level.
//   classMode:      "any" — any of the character's classes may be used for the
//                   check (Investigation); resolution ignores skillChecks.
//   combat:         Special combat-panel check (Monster Knowledge). Rendered with
//                   its own control instead of the ordinary skill list.
//   classes:        Rulebook associations, split into:
//                     normal:     available for manual and automatic selection
//                     manualOnly: available for manual selection only and never
//                                 auto-selected (Dark Hunter / Monster Knowledge)
//                   Class Items may add further associations through
//                   system.skillChecks; they never override a manualOnly match.
//   restrictions:   Contextual, informational notes only. No automatic logic
//                   enforces them (natural environments, Search Command, Daemons).

export const skillKey = (name, ability) =>
  String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + String(ability).toLowerCase();

const NATURAL_ENVIRONMENT = "Ranger checks apply only in natural environments.";
const SEARCH_COMMAND = "Rider use requires the Search Command stunt.";
const DARK_HUNTER_DAEMONS = "Dark Hunter use is limited to Daemons (Abyss Breaker).";
const INVESTIGATION_CONTEXT = "The class depends on the situation and is chosen per check (GM).";

export const SKILL_DEFINITIONS = [
  // Dexterity
  { key: skillKey("Concealment", "dexterity"), name: "Concealment", ability: "dexterity", time: "1 min", classes: { normal: ["Scout", "Ranger"] } },
  { key: skillKey("Disable", "dexterity"), name: "Disable", ability: "dexterity", time: "1 min", displayName: "Disable*", classes: { normal: ["Scout", "Ranger"] }, restrictions: [NATURAL_ENVIRONMENT] },
  { key: skillKey("Disguise", "dexterity"), name: "Disguise", ability: "dexterity", time: "10 min", classes: { normal: ["Scout"] } },
  { key: skillKey("First Aid", "dexterity"), name: "First Aid", ability: "dexterity", time: "10 min", classes: { normal: ["Ranger"] } },
  { key: skillKey("Pickpocket", "dexterity"), name: "Pickpocket", ability: "dexterity", time: "10 sec", classes: { normal: ["Scout"] } },
  { key: skillKey("Set Trap", "dexterity"), name: "Set Trap", ability: "dexterity", time: "10 min", displayName: "Set Trap*", classes: { normal: ["Scout", "Ranger"] }, restrictions: [NATURAL_ENVIRONMENT] },

  // Agility
  { key: skillKey("Acrobatics", "agility"), name: "Acrobatics", ability: "agility", time: "1 min", classes: { normal: ["Scout", "Ranger"] } },
  { key: skillKey("Climb", "agility"), name: "Climb", ability: "agility", time: "1 min", classes: { normal: ["Scout", "Ranger"] } },
  { key: skillKey("Follow", "agility"), name: "Follow", ability: "agility", time: "10 min", classes: { normal: ["Scout", "Ranger"] } },
  { key: skillKey("Stealth", "agility"), name: "Stealth", ability: "agility", time: "1 min", classes: { normal: ["Scout", "Ranger"] } },
  { key: skillKey("Jump", "agility"), name: "Jump", ability: "agility", time: "10 sec", fixedClassName: "Adventurer" },
  { key: skillKey("Ride", "agility"), name: "Ride", ability: "agility", time: "1 min", classes: { normal: ["Rider"] } },
  { key: skillKey("Swim", "agility"), name: "Swim", ability: "agility", time: "1 min", fixedClassName: "Adventurer" },
  { key: skillKey("Swim (Combat)", "agility"), name: "Swim (Combat)", ability: "agility", time: "10 sec", fixedClassName: "Adventurer" },
  { key: skillKey("Tumble", "agility"), name: "Tumble", ability: "agility", time: "Instant", classes: { normal: ["Scout", "Ranger", "Rider"] } },

  // Strength
  { key: skillKey("Climb", "strength"), name: "Climb", ability: "strength", time: "1 min", fixedClassName: "Adventurer" },
  { key: skillKey("Strength", "strength"), name: "Strength", ability: "strength", time: "10 sec", fixedClassName: "Adventurer" },

  // Intelligence
  { key: skillKey("Appraisal", "intelligence"), name: "Appraisal", ability: "intelligence", time: "10 min", classes: { normal: ["Scout", "Sage"] } },
  { key: skillKey("Archaeology", "intelligence"), name: "Archaeology", ability: "intelligence", time: "10 min" },
  { key: skillKey("Cartography", "intelligence"), name: "Cartography", ability: "intelligence", time: "10 min", displayName: "Cartography*", classes: { normal: ["Scout", "Ranger", "Sage", "Rider"] }, restrictions: [NATURAL_ENVIRONMENT] },
  { key: skillKey("Detect", "intelligence"), name: "Detect", ability: "intelligence", time: "10 sec", fixedClassName: "Adventurer" },
  { key: skillKey("Engineering", "intelligence"), name: "Engineering", ability: "intelligence", time: "10 min", classes: { normal: ["Sage"] } },
  { key: skillKey("Evade Trap", "intelligence"), name: "Evade Trap", ability: "intelligence", time: "Instant", displayName: "Evade Trap*", restrictions: [NATURAL_ENVIRONMENT] },
  { key: skillKey("Evocation", "intelligence"), name: "Evocation", ability: "intelligence", time: "Instant", classes: { normal: ["Alchemist"] } },
  { key: skillKey("Herbology", "intelligence"), name: "Herbology", ability: "intelligence", time: "1 min", classes: { normal: ["Sage", "Ranger", "Alchemist"] } },
  { key: skillKey("Insight", "intelligence"), name: "Insight", ability: "intelligence", time: "10 sec", classes: { normal: ["Sage", "Alchemist"] } },
  { key: skillKey("Investigation", "intelligence"), name: "Investigation", ability: "intelligence", time: "1 hour", classMode: "any", restrictions: [INVESTIGATION_CONTEXT] },
  { key: skillKey("Knowledge", "intelligence"), name: "Knowledge", ability: "intelligence", time: "Instant" },
  { key: skillKey("Literature", "intelligence"), name: "Literature", ability: "intelligence", time: "10 min", classes: { normal: ["Sage", "Alchemist"] } },
  { key: skillKey("Listen", "intelligence"), name: "Listen", ability: "intelligence", time: "10 sec", classes: { normal: ["Scout", "Ranger"] } },
  { key: skillKey("Medicine", "intelligence"), name: "Medicine", ability: "intelligence", time: "10 min" },
  { key: skillKey("Pathology", "intelligence"), name: "Pathology", ability: "intelligence", time: "10 min", classes: { normal: ["Sage", "Ranger"] } },
  { key: skillKey("Perception", "intelligence"), name: "Perception", ability: "intelligence", time: "Instant", displayName: "Perception*", classes: { normal: ["Scout", "Ranger", "Rider"] }, restrictions: [NATURAL_ENVIRONMENT, SEARCH_COMMAND] },
  { key: skillKey("Reference", "intelligence"), name: "Reference", ability: "intelligence", time: "10 min" },
  { key: skillKey("Search", "intelligence"), name: "Search", ability: "intelligence", time: "10 min", displayName: "Search*", classes: { normal: ["Scout", "Ranger", "Rider", "Geomancer"] }, restrictions: [NATURAL_ENVIRONMENT, SEARCH_COMMAND] },
  { key: skillKey("Sense Danger", "intelligence"), name: "Sense Danger", ability: "intelligence", time: "Instant", classes: { normal: ["Scout", "Ranger", "Rider"] }, restrictions: [SEARCH_COMMAND] },
  { key: skillKey("Spot Traps", "intelligence"), name: "Spot Traps", ability: "intelligence", time: "Instant", classes: { normal: ["Scout", "Ranger", "Rider"] }, restrictions: [SEARCH_COMMAND] },
  { key: skillKey("Track", "intelligence"), name: "Track", ability: "intelligence", time: "1 min", classes: { normal: ["Scout", "Ranger", "Rider"] }, restrictions: [SEARCH_COMMAND] },
  { key: skillKey("Weakness", "intelligence"), name: "Weakness", ability: "intelligence", time: "Instant", classes: { normal: ["Rider"] } },
  { key: skillKey("Weather", "intelligence"), name: "Weather", ability: "intelligence", time: "1 min", classes: { normal: ["Scout", "Ranger", "Geomancer"] } },
  { key: skillKey("Monster Knowledge", "intelligence"), name: "Monster Knowledge", ability: "intelligence", time: "10 min", combat: true, classes: { normal: ["Sage", "Rider"], manualOnly: ["Dark Hunter"] }, restrictions: [DARK_HUNTER_DAEMONS] },

  // Spirit
  { key: skillKey("Performance", "spirit"), name: "Performance", ability: "spirit", time: "Instant", classes: { normal: ["Bard"] } },
];

// Build a map from key to definition for fast lookup.
export const SKILL_DEFINITION_MAP = new Map(SKILL_DEFINITIONS.map(s => [s.key, s]));

// Return all skills grouped by ability, matching the layout used by the
// character sheet. Combat checks (Monster Knowledge) are included here so the
// catalogue stays complete; the sheet filters them out of the ordinary list.
export const skillsByAbility = {
  dexterity: SKILL_DEFINITIONS.filter(s => s.ability === "dexterity"),
  agility: SKILL_DEFINITIONS.filter(s => s.ability === "agility"),
  strength: SKILL_DEFINITIONS.filter(s => s.ability === "strength"),
  intelligence: SKILL_DEFINITIONS.filter(s => s.ability === "intelligence"),
  spirit: SKILL_DEFINITIONS.filter(s => s.ability === "spirit"),
};

// Skills that use Adventurer Level instead of a class level.
export const adventurerLevelSkills = new Set(
  SKILL_DEFINITIONS.filter(s => s.fixedClassName === "Adventurer").map(s => s.key)
);

// Skills that are class-based (no fixedClassName, so they use a class level).
export const classBasedSkills = new Set(
  SKILL_DEFINITIONS.filter(s => s.fixedClassName !== "Adventurer").map(s => s.key)
);
