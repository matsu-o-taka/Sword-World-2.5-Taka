// Class resolution for Skill Checks.
//
// Pure data-in/data-out logic shared by the character sheet and reviewed by
// tests. Classes are resolved from the character's class Items, never from
// array order: the automatic selection is computed explicitly by level.
//
// Association model (per skill definition):
//   classes.normal     — class names available for manual AND automatic use.
//   classes.manualOnly — class names available for manual selection only,
//                        never auto-selected (e.g. Dark Hunter for Monster
//                        Knowledge). A manualOnly match always wins over a
//                        normal association for that class.
//   fixedClassName "Adventurer" — the pseudo-class "adventurer" uses the
//                        character's Adventurer Level; it is not a class Item
//                        and is never looked up as one.
//   classMode "any"    — every class of the character is eligible and the
//                        automatic selection is simply the highest-level class
//                        (Investigation); skillChecks are ignored.
//
// Class Items may add associations beyond the rulebook lists by declaring the
// canonical skill key in system.skillChecks. They can never turn a manual-only
// association into an automatic one.
//
// Explicit "no class" is stored as "none" so it can be distinguished from the
// absence of a saved selection (undefined or legacy ""), which falls back to
// the automatic selection.

import { SKILL_DEFINITIONS, SKILL_DEFINITION_MAP } from "./skill-definitions.mjs";

export const ADVENTURER_SELECTION = "adventurer";
export const NONE_SELECTION = "none";

const normalizeName = value => String(value ?? "").trim().toLowerCase();

const byLevelDesc = (a, b) =>
  Number(b?.system?.level ?? 0) - Number(a?.system?.level ?? 0)
  || String(a?.name ?? "").localeCompare(String(b?.name ?? ""));

function definitionOf(reference) {
  const def = reference instanceof Object ? reference : SKILL_DEFINITION_MAP.get(reference);
  if (!SKILL_DEFINITION_MAP.has(def?.key)) {
    throw new Error(`Unknown skill definition: ${typeof reference === "string" ? reference : def?.key ?? reference}`);
  }
  return def;
}

export function declaresSkillCheck(classItem, key) {
  return Array.isArray(classItem?.system?.skillChecks) && classItem.system.skillChecks.includes(key);
}

export function manualOnlyClasses(classes, def) {
  const names = (def.classes?.manualOnly ?? []).map(normalizeName);
  if (!names.length) return [];
  return (classes ?? []).filter(item => names.includes(normalizeName(item.name)));
}

export function normalEligibleClasses(classes, def) {
  const names = (def.classes?.normal ?? []).map(normalizeName);
  const excluded = new Set(manualOnlyClasses(classes, def));
  return (classes ?? []).filter(item =>
    !excluded.has(item)
    && (def.classMode === "any"
      || names.includes(normalizeName(item.name))
      || declaresSkillCheck(item, def.key))
  );
}

// The automatic selection is the explicitly highest-level candidate.
export function highestLevelClass(classes) {
  return [...(classes ?? [])].sort(byLevelDesc)[0] ?? null;
}

function workSkillExists(workSkills, savedValue) {
  const id = String(savedValue).slice("work:".length);
  return (workSkills ?? []).some(work => String(work?.id) === id);
}

/**
 * Resolve which class (or pseudo-class) provides a Skill Check.
 *
 * @param {Array}   classes         The character's class Items (any order).
 * @param {Object|string} def       Skill definition object or canonical key.
 * @param {string}  [savedValue]    Saved selection: class id, "adventurer",
 *                                  "none", "work:<id>" or ""/undefined (absent).
 * @param {Array}   [workSkills]    Work Skills offered as class sources
 *                                  (existing integration, unchanged).
 * @param {number}  [adventurerLevel] The character's Adventurer Level.
 * @returns {{ classId: string, level: number, preserved: boolean,
 *            explicitNone: boolean, options: Array<{value,label,selected}> }}
 */
export function resolveSkillClass({ classes = [], def, savedValue, workSkills = [], adventurerLevel = 0 } = {}) {
  const definition = definitionOf(def);
  const all = (classes ?? []).filter(Boolean);
  const adventurerMode = definition.fixedClassName === "Adventurer";
  const anyMode = definition.classMode === "any";
  const normal = anyMode ? all : normalEligibleClasses(all, definition);
  const manual = manualOnlyClasses(all, definition);

  const autoClassId = () => {
    if (adventurerMode) return ADVENTURER_SELECTION;
    const best = highestLevelClass(normal);
    return best ? String(best.id) : "";
  };

  let classId;
  let preserved = false;
  let explicitNone = false;
  if (savedValue === NONE_SELECTION) {
    explicitNone = true;
    classId = "";
  } else if (adventurerMode && savedValue === ADVENTURER_SELECTION) {
    classId = ADVENTURER_SELECTION;
    preserved = true;
  } else if (typeof savedValue === "string"
    && savedValue.startsWith("work:")
    && workSkillExists(workSkills, savedValue)) {
    classId = String(savedValue);
    preserved = true;
  } else if (savedValue) {
    const saved = all.find(item => String(item.id) === String(savedValue));
    if (saved && (anyMode || normal.includes(saved) || manual.includes(saved))) {
      classId = String(saved.id);
      preserved = true;
    } else {
      classId = autoClassId();
    }
  } else {
    classId = autoClassId();
  }

  // Option list: explicit "—", Adventurer (only where applicable), eligible
  // classes (highest level first) and Work Skills.
  const options = [
    { value: NONE_SELECTION, label: "—", selected: classId === "" },
    ...(adventurerMode ? [{ value: ADVENTURER_SELECTION, label: "Adventurer", selected: classId === ADVENTURER_SELECTION }] : []),
    ...[...normal].sort(byLevelDesc).map(item => ({ value: String(item.id), label: item.name, selected: String(item.id) === classId })),
    ...[...manual].sort(byLevelDesc).map(item => ({ value: String(item.id), label: item.name, selected: String(item.id) === classId })),
    ...(workSkills ?? []).map(work => ({ value: `work:${work.id}`, label: `Work: ${work.name}`, selected: `work:${work.id}` === classId }))
  ];

  return {
    classId,
    level: resolvedSkillLevel({ classId, classes: all, workSkills, adventurerLevel }),
    preserved,
    explicitNone,
    options
  };
}

/**
 * Level provided by a resolved selection: Work Skill level, Adventurer Level
 * for the "adventurer" pseudo-class, the class Item level, or zero when no
 * class is selected. A class-based check with no class is zero (the ability
 * modifier alone is never added).
 */
export function resolvedSkillLevel({ classId, classes = [], workSkills = [], adventurerLevel = 0 } = {}) {
  if (!classId) return 0;
  if (classId === ADVENTURER_SELECTION) return Math.max(0, Number(adventurerLevel) || 0);
  if (classId.startsWith("work:")) {
    const work = (workSkills ?? []).find(entry => String(entry?.id) === classId.slice("work:".length));
    return work ? Math.max(0, Number(work.level ?? 0) || 0) : 0;
  }
  const item = (classes ?? []).find(candidate => String(candidate?.id) === classId);
  return Math.max(0, Number(item?.system?.level ?? 0) || 0);
}

/**
 * Options for the class Item editor: readable labels, canonical keys saved in
 * system.skillChecks, and contextual restriction notes as tooltips only
 * (manual/automatic association layers are internal metadata, not editor
 * options).
 */
export function classEditorSkillOptions(savedChecks = []) {
  const saved = Array.isArray(savedChecks) ? savedChecks : [];
  const capitalise = ability => ability.charAt(0).toUpperCase() + ability.slice(1);
  return SKILL_DEFINITIONS.map(skill => ({
    value: skill.key,
    label: skill.displayName
      ? `${skill.displayName} (${capitalise(skill.ability)})`
      : `${skill.name} (${capitalise(skill.ability)})`,
    title: (skill.restrictions ?? []).join(" "),
    selected: saved.includes(skill.key)
  }));
}
