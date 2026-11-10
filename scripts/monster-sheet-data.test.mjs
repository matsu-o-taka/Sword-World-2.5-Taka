import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  appendMonsterCombatStyle,
  createMonsterUniqueSkill,
  getMainCombatStyleIndex,
  getMonsterSectionChoices,
  hasValidMainCombatStyle,
  mergeMonsterCombatStyleFields,
  mergeMonsterUniqueSkillFields,
  prepareMonsterCombatStyles,
  prepareMonsterUniqueSkillGroups,
  readMonsterActorCombatStyles,
  readMonsterCombatStyles,
  selectMainCombatStyle
} from "../module/actor/monster-sheet-data.mjs";
import { parseMonsterPage } from "../module/importer/monster-parser.mjs";

const styles = [{
  style: "Bite",
  defense: "※+20",
  hp: { value: "-", max: "※" },
  mp: { value: "12", max: "12" }
}];
const prepared = prepareMonsterCombatStyles(styles);
assert.equal(prepared[0].defenseEditable, false);
assert.equal(prepared[0].hpValueEditable, false);
assert.equal(prepared[0].hpMaxEditable, false);
assert.equal(prepared[0].mpValueEditable, true);

const updated = mergeMonsterCombatStyleFields(styles, [
  ["0.defense", "5"],
  ["0.hp.value", "6"],
  ["0.hp.max", ""],
  ["0.mp.value", ""],
  ["0.mp.max", "20"]
]);
assert.deepEqual(updated[0], {
  style: "Bite",
  defense: "※+20",
  hp: { value: "-", max: "※" },
  mp: { value: "12", max: "20" }
});

const numericStyle = [{ defense: 0, hp: { value: 10, max: 10 }, mp: { value: 4, max: 4 } }];
assert.deepEqual(
  mergeMonsterCombatStyleFields(numericStyle, [
    ["0.defense", "0"],
    ["0.hp.value", ""],
    ["0.hp.max", "12"]
  ]),
  [{ defense: "0", hp: { value: 10, max: "12" }, mp: { value: 4, max: 4 } }]
);

const singleStyleWithoutSection = [{ style: "Bite", sectionLabel: "" }];
assert.equal(getMainCombatStyleIndex(singleStyleWithoutSection), 0);
assert.equal(hasValidMainCombatStyle(singleStyleWithoutSection), true);
assert.equal(prepareMonsterCombatStyles(singleStyleWithoutSection)[0].isMainSection, true);
assert.equal(prepareMonsterCombatStyles(singleStyleWithoutSection)[0].mainSectionCheckboxDisabled, true);
assert.equal(singleStyleWithoutSection[0].isMainSection, undefined);

const singleStyleWithSection = [{ style: "Claw", sectionLabel: "Head" }];
assert.equal(getMainCombatStyleIndex(singleStyleWithSection), 0);

const singleBecameMultiple = appendMonsterCombatStyle(singleStyleWithoutSection, { style: "New Attack" });
assert.deepEqual(singleBecameMultiple.map(style => style.isMainSection), [true, undefined]);
assert.equal(getMainCombatStyleIndex(singleBecameMultiple), 0);

const multipleStyles = [
  { style: "Bite", sectionLabel: "Head", isMainSection: false },
  { style: "Tail", sectionLabel: "Body", isMainSection: true }
];
assert.equal(getMainCombatStyleIndex(multipleStyles), 1);
assert.equal(prepareMonsterCombatStyles(multipleStyles)[1].isMainSection, true);

const incompleteStyles = [{ style: "Bite" }, { style: "Tail" }];
assert.equal(getMainCombatStyleIndex(incompleteStyles), null);
assert.equal(hasValidMainCombatStyle(incompleteStyles), false);
assert.deepEqual(prepareMonsterCombatStyles(incompleteStyles).map(style => style.isMainSection), [false, false]);
assert.equal(getMainCombatStyleIndex(appendMonsterCombatStyle(incompleteStyles, { style: "Wing" })), null);
assert.equal(getMainCombatStyleIndex(appendMonsterCombatStyle(multipleStyles, { style: "Wing" })), 1);

const selectedSecond = selectMainCombatStyle(multipleStyles, 0, true);
assert.deepEqual(selectedSecond.map(style => style.isMainSection), [true, false]);
assert.equal(getMainCombatStyleIndex(selectedSecond), 0);
assert.equal(hasValidMainCombatStyle(selectedSecond), true);

const clickedSelectedRow = selectMainCombatStyle(selectedSecond, 0, false);
assert.deepEqual(clickedSelectedRow.map(style => style.isMainSection), [true, false]);
assert.equal(getMainCombatStyleIndex(clickedSelectedRow), 0);
assert.equal(hasValidMainCombatStyle(clickedSelectedRow), true);

const selectionCounts = [multipleStyles, selectedSecond, clickedSelectedRow].map(styles =>
  styles.filter(style => style.isMainSection === true).length
);
assert.deepEqual(selectionCounts, [1, 1, 1]);
assert.equal(selectMainCombatStyle(incompleteStyles, 1, true).filter(style => style.isMainSection).length, 1);
assert.equal(hasValidMainCombatStyle([{ isMainSection: true }, { isMainSection: true }]), false);

const removedSelectedStyle = multipleStyles.slice(1);
assert.equal(getMainCombatStyleIndex(removedSelectedStyle), 0);
assert.equal(removedSelectedStyle[0].isMainSection, true);
const selectedAmongThree = selectMainCombatStyle([...multipleStyles, { style: "Wing" }], 1, true);
const removedSelectionWithSeveralRemaining = selectedAmongThree.filter((_, index) => index !== 1);
assert.equal(getMainCombatStyleIndex(removedSelectionWithSeveralRemaining), null);
assert.deepEqual(removedSelectionWithSeveralRemaining.map(style => style.isMainSection), [false, false]);

const oldActorStyles = [{ style: "Bite" }, { style: "Tail" }];
assert.equal(getMainCombatStyleIndex(JSON.parse(JSON.stringify(oldActorStyles))), null);
assert.equal(hasValidMainCombatStyle(oldActorStyles), false);
const incompleteActor = { system: { combatStyles: structuredClone(oldActorStyles) } };
if (hasValidMainCombatStyle(incompleteStyles)) incompleteActor.system.combatStyles = structuredClone(incompleteStyles);
assert.deepEqual(incompleteActor.system.combatStyles, oldActorStyles);
const storedSelection = selectMainCombatStyle(oldActorStyles, 1, true);
const actor = { system: { combatStyles: oldActorStyles } };
if (hasValidMainCombatStyle(storedSelection)) actor.system.combatStyles = structuredClone(storedSelection);
const readSelection = JSON.parse(JSON.stringify(actor.system.combatStyles));
assert.equal(getMainCombatStyleIndex(readSelection), 1);
assert.equal(readSelection[1].isMainSection, true);
assert.equal(hasValidMainCombatStyle(readSelection), true);
const mergedSelection = mergeMonsterCombatStyleFields(readSelection, [["1.damage", "2d+8"]]);
assert.equal(mergedSelection[0].isMainSection, false);
assert.equal(mergedSelection[1].isMainSection, true);
assert.equal(mergedSelection[1].damage, "2d+8");

const oldCombinedStyle = {
  style: "Sword (Head)",
  accuracy: "12 (19)",
  damage: "2d+10",
  evasion: "11 (18)",
  defense: 8,
  hp: { value: 40, max: 40 },
  mp: { value: 12, max: 12 }
};
const oldCombinedActorStyles = { 0: oldCombinedStyle };
const oldCombinedPrepared = prepareMonsterCombatStyles(oldCombinedActorStyles);
assert.equal(oldCombinedPrepared.length, 1);
assert.equal(oldCombinedPrepared[0].styleName, "Sword (Head)");
assert.equal(oldCombinedPrepared[0].section, "");
assert.deepEqual(readMonsterCombatStyles(oldCombinedActorStyles)[0], oldCombinedStyle);
assert.equal(oldCombinedStyle.style, "Sword (Head)");
assert.deepEqual(oldCombinedPrepared[0], {
  ...oldCombinedStyle,
  index: 0,
  styleName: "Sword (Head)",
  section: "",
  legacyCombinedStyle: "Sword (Head)",
  isMainSection: true,
  mainSectionCheckboxDisabled: true,
  defenseEditable: true,
  hpValueEditable: true,
  hpMaxEditable: true,
  mpValueEditable: true,
  mpMaxEditable: true
});

const oldCombinedMultiple = {
  1: { style: "Tail (Body)", accuracy: "10", damage: "2d+4", evasion: "9", defense: 5, hp: { value: 20, max: 20 }, mp: { value: 0, max: 0 } },
  0: { style: "Bite (Head)", accuracy: "11", damage: "2d+6", evasion: "10", defense: 6, hp: { value: 30, max: 30 }, mp: { value: 2, max: 2 } }
};
const oldMultiplePrepared = prepareMonsterCombatStyles(oldCombinedMultiple);
assert.deepEqual(oldMultiplePrepared.map(style => style.styleName), ["Bite (Head)", "Tail (Body)"]);
assert.deepEqual(oldMultiplePrepared.map(style => style.section), ["", ""]);
assert.deepEqual(oldMultiplePrepared.map(style => style.isMainSection), [false, false]);
assert.equal(readMonsterCombatStyles(oldCombinedMultiple)[0], oldCombinedMultiple[0]);
assert.equal(oldCombinedMultiple[0].style, "Bite (Head)");

const manuallyAdded = appendMonsterCombatStyle([], {
  style: "Claw",
  section: "Arm",
  accuracy: "10",
  damage: "2d+3",
  evasion: "9",
  defense: 4,
  hp: { value: 15, max: 15 },
  mp: { value: 3, max: 3 },
  isMainSection: false
});
assert.equal(manuallyAdded[0].style, "Claw");
assert.equal(manuallyAdded[0].section, "Arm");
const editedLegacyStyles = mergeMonsterCombatStyleFields(oldCombinedMultiple, [
  ["0.style", "Fanged Bite"],
  ["0.section", "Skull"],
  ["0.accuracy", "13"],
  ["0.damage", "2d+7"],
  ["0.evasion", "12"],
  ["0.defense", "7"],
  ["0.hp.value", "31"],
  ["0.hp.max", "32"],
  ["0.mp.value", "5"],
  ["0.mp.max", "6"],
  ["0.isMainSection", true]
], ["Head", "Body"]);
assert.equal(editedLegacyStyles[0].style, "Fanged Bite");
assert.equal(editedLegacyStyles[0].section, "Skull");
assert.equal(editedLegacyStyles[0].sourceStyle, "Bite (Head)");
assert.deepEqual(editedLegacyStyles[0], {
  style: "Fanged Bite",
  accuracy: "13",
  damage: "2d+7",
  evasion: "12",
  defense: "7",
  hp: { value: "31", max: "32" },
  mp: { value: "5", max: "6" },
  section: "Skull",
  sourceStyle: "Bite (Head)",
  isMainSection: true
});
const rereadEdited = prepareMonsterCombatStyles(JSON.parse(JSON.stringify(editedLegacyStyles)), ["Skull", "Body"]);
assert.equal(rereadEdited[0].styleName, "Fanged Bite");
assert.equal(rereadEdited[0].section, "Skull");
assert.equal(rereadEdited[0].isMainSection, true);

const flattenedOldRows = readMonsterCombatStyles({
  "0.style": "Staff (Torso)",
  "0.accuracy": "8",
  "1.style": "Stomp (Torso)",
  "1.damage": "2d+1"
});
assert.deepEqual(flattenedOldRows.map(style => style.style), ["Staff (Torso)", "Stomp (Torso)"]);
assert.equal(prepareMonsterCombatStyles(flattenedOldRows)[1].styleName, "Stomp (Torso)");
assert.equal(prepareMonsterCombatStyles(flattenedOldRows)[1].section, "");
const noAnnotationLegacyStyle = prepareMonsterCombatStyles([{ style: "Staff" }]);
assert.equal(noAnnotationLegacyStyle[0].styleName, "Staff");
assert.equal(noAnnotationLegacyStyle[0].section, "");
const countedLegacySection = prepareMonsterCombatStyles(
  [{ style: "Bite (Head x 2)", sectionLabel: "Head x 2" }]
);
assert.equal(countedLegacySection[0].styleName, "Bite");
assert.equal(countedLegacySection[0].section, "Head x 2");
const explicitlyEmptySection = prepareMonsterCombatStyles(
  [{ style: "Bite (Head)", section: "", sectionLabel: "Head" }]
);
assert.equal(explicitlyEmptySection[0].styleName, "Bite");
assert.equal(explicitlyEmptySection[0].section, "Head");

const hydraSource = await readFile(new URL("./fixtures/monster-hydra.md", import.meta.url), "utf8");
const importedHydra = parseMonsterPage(hydraSource, "https://sw25.wikidot.com/monster:hydra");
const legacyHydraCombatStyles = importedHydra.system.combatStyles.map(style => ({
  style: style.style,
  accuracy: style.accuracy,
  damage: style.damage,
  evasion: style.evasion,
  defense: style.defense,
  hp: structuredClone(style.hp),
  mp: structuredClone(style.mp)
}));
const oldHydraActor = {
  system: {
    combatStyles: structuredClone(legacyHydraCombatStyles)
  },
  _source: {
    system: {
      combatStyles: structuredClone(legacyHydraCombatStyles)
    }
  },
  toObject() {
    return { system: this._source.system };
  }
};
const normalizedEmptyActor = {
  system: { combatStyles: [] },
  _source: { system: { combatStyles: structuredClone(legacyHydraCombatStyles) } },
  toObject() {
    return { system: this._source.system };
  }
};
const foundrySourceRows = readMonsterActorCombatStyles(normalizedEmptyActor);
assert.equal(foundrySourceRows.length, 2);
assert.equal(prepareMonsterCombatStyles(foundrySourceRows)[1].styleName, "Bite");
const originalHydraRows = structuredClone(oldHydraActor.system.combatStyles);
assert.deepEqual(Object.keys(oldHydraActor.system.combatStyles[0]).sort(), [
  "accuracy", "damage", "defense", "evasion", "hp", "mp", "style"
]);
assert.deepEqual(oldHydraActor.system.combatStyles, originalHydraRows);
const hydraRowsForSheet = prepareMonsterCombatStyles(oldHydraActor.system.combatStyles);
assert.equal(hydraRowsForSheet.length, 2);
assert.deepEqual(hydraRowsForSheet.map(row => [row.styleName, row.section]), [
  ["None", ""],
  ["Bite", ""]
]);
for (const [index, raw] of oldHydraActor.system.combatStyles.entries()) {
  const row = hydraRowsForSheet[index];
  assert.equal(row.accuracy, raw.accuracy);
  assert.equal(row.damage, raw.damage);
  assert.equal(row.evasion, raw.evasion);
  assert.equal(row.defense, raw.defense);
  assert.deepEqual(row.hp, raw.hp);
  assert.deepEqual(row.mp, raw.mp);
}
assert.equal(hydraRowsForSheet[0].accuracy, "-");
assert.equal(hydraRowsForSheet[0].damage, "-");
assert.equal(hydraRowsForSheet[0].evasion, "12 (19)");
assert.equal(hydraRowsForSheet[0].defense, 13);
assert.deepEqual(hydraRowsForSheet[0].hp, { value: 106, max: 106 });
assert.deepEqual(hydraRowsForSheet[0].mp, { value: 44, max: 44 });

const savedHydraRows = mergeMonsterCombatStyleFields(oldHydraActor.system.combatStyles, [
  ["1.style", "Bite"],
  ["1.section", "Neck"],
  ["1.accuracy", "14 (21)"],
  ["1.damage", "2d+15"],
  ["1.evasion", "13 (20)"],
  ["1.defense", "9"],
  ["1.hp.value", "86"],
  ["1.hp.max", "86"],
  ["1.mp.value", "29"],
  ["1.mp.max", "29"],
  ["1.isMainSection", true]
]);
const storedHydraActor = {
  system: { combatStyles: JSON.parse(JSON.stringify(savedHydraRows)) }
};
const reopenedHydraRows = prepareMonsterCombatStyles(storedHydraActor.system.combatStyles);
assert.equal(reopenedHydraRows.length, 2);
assert.equal(reopenedHydraRows[1].styleName, "Bite");
assert.equal(reopenedHydraRows[1].section, "Neck");
assert.deepEqual([
  reopenedHydraRows[1].accuracy,
  reopenedHydraRows[1].damage,
  reopenedHydraRows[1].evasion,
  reopenedHydraRows[1].defense,
  reopenedHydraRows[1].hp.value,
  reopenedHydraRows[1].mp.value,
  reopenedHydraRows[1].isMainSection
], ["14 (21)", "2d+15", "13 (20)", "9", "86", "29", true]);
assert.equal(getMainCombatStyleIndex(storedHydraActor.system.combatStyles), 1);
assert.deepEqual(oldHydraActor.system.combatStyles, originalHydraRows);

const template = await readFile(new URL("../templates/actor/monster-sheet.hbs", import.meta.url), "utf8");
assert.match(template, /<span>Style<\/span><span>Section<\/span>/);
assert.match(template, /name="system\.combatStyles\.\{\{style\.index\}\}\.style" value="\{\{style\.styleName\}\}"/);
assert.match(template, /name="system\.combatStyles\.\{\{style\.index\}\}\.section" value="\{\{style\.section\}\}"/);
assert.match(template, /data-action="select-main-combat-style"/);
assert.match(template, /uniqueSkillGroups as \|group\|/);
assert.match(template, /data-action="choose-monster-skill-section"/);
assert.doesNotMatch(template, /monster-skill-assignment">Section/);

const combatStylesForChoices = [
  { id: "cs-head", style: "Head Attack", section: "Head", sectionLabel: "Head" },
  { id: "cs-body", style: "Body Attack", section: "Body", sectionLabel: "Body" },
  { id: "cs-wing", style: "Wing Attack", section: "Wing", sectionLabel: "Wing" }
];
const sectionChoices = getMonsterSectionChoices(combatStylesForChoices);
assert.deepEqual(sectionChoices.map(section => section.id), ["cs-head", "cs-body", "cs-wing"]);

const legacyUniqueSkills = [
  { title: "Shared legacy skill", description: "Shared details", references: [{ destination: "/skill:shared" }] },
  { title: "Another legacy skill", description: "More details" }
];
const originalLegacyUniqueSkills = structuredClone(legacyUniqueSkills);
const singleSectionChoices = getMonsterSectionChoices([combatStylesForChoices[0]]);
const singleSectionGroups = prepareMonsterUniqueSkillGroups(legacyUniqueSkills, singleSectionChoices);
assert.equal(singleSectionGroups.length, 1);
assert.equal(singleSectionGroups[0].id, "all");
assert.equal(singleSectionGroups[0].showHeading, false);
assert.deepEqual(singleSectionGroups[0].skills.map(skill => skill.title), [
  "Shared legacy skill",
  "Another legacy skill"
]);
assert.deepEqual(legacyUniqueSkills, originalLegacyUniqueSkills);
assert.deepEqual(
  createMonsterUniqueSkill(undefined, singleSectionChoices, { title: "New single-section skill" }),
  { title: "New single-section skill", sectionScope: "all" }
);

const twoSectionSkills = [
  { title: "Head skill", description: "Head details", sectionScope: "section", combatStyleId: "cs-head" },
  { title: "Shared skill", description: "Shared details", sectionScope: "all" },
  { title: "Body skill", description: "Body details", sectionScope: "section", combatStyleId: "cs-body" },
  { title: "Legacy skill", description: "Old data" }
];
const twoSectionGroups = prepareMonsterUniqueSkillGroups(twoSectionSkills, sectionChoices.slice(0, 2));
assert.deepEqual(twoSectionGroups.map(group => [group.id, group.showHeading, group.skills.map(skill => skill.title)]), [
  ["all", true, ["Shared skill", "Legacy skill"]],
  ["cs-head", true, ["Head skill"]],
  ["cs-body", true, ["Body skill"]]
]);
assert.equal(twoSectionGroups[0].title, "All Sections");
assert.equal(twoSectionGroups.flatMap(group => group.skills).length, twoSectionSkills.length);
assert.deepEqual(
  createMonsterUniqueSkill("cs-body", sectionChoices.slice(0, 2), { title: "New body skill" }),
  { title: "New body skill", sectionScope: "section", combatStyleId: "cs-body" }
);
assert.deepEqual(
  createMonsterUniqueSkill("all", sectionChoices.slice(0, 2), { title: "New shared skill" }),
  { title: "New shared skill", sectionScope: "all" }
);
assert.equal(createMonsterUniqueSkill(null, sectionChoices.slice(0, 2), { title: "Cancelled" }), null);

const threeSectionGroups = prepareMonsterUniqueSkillGroups([
  ...twoSectionSkills,
  { title: "Wing skill", description: "Wing details", sectionScope: "section", combatStyleId: "cs-wing" }
], sectionChoices);
assert.deepEqual(threeSectionGroups.map(group => group.id), [
  "all",
  "cs-head",
  "cs-body",
  "cs-wing"
]);
assert.deepEqual(
  threeSectionGroups.find(group => group.id === "cs-wing").skills.map(skill => skill.title),
  ["Wing skill"]
);
assert.equal(threeSectionGroups.flatMap(group => group.skills).length, 5);
assert.equal(sectionChoices.length, 3);

const reassignedUniqueSkills = mergeMonsterUniqueSkillFields(twoSectionSkills, [
  ["0.assignment", "cs-body"],
  ["0.title", "Renamed Head Skill"],
  ["0.description", "Updated details"]
], sectionChoices.slice(0, 2));
assert.deepEqual(reassignedUniqueSkills[0], {
  title: "Renamed Head Skill",
  description: "Updated details",
  sectionScope: "section",
  combatStyleId: "cs-body"
});
assert.equal(reassignedUniqueSkills[0].references, twoSectionSkills[0].references);
assert.deepEqual(
  prepareMonsterUniqueSkillGroups(reassignedUniqueSkills, sectionChoices.slice(0, 2))
    .find(group => group.id === "cs-body").skills.map(skill => skill.title),
  ["Renamed Head Skill", "Body skill"]
);

const removedSectionSkill = {
  title: "Former Wing skill",
  description: "Keep these details",
  sectionScope: "section",
  combatStyleId: "cs-wing",
  sourceText: "Original source text",
  references: [{ destination: "/skill:wing" }]
};
const afterSectionRemoval = prepareMonsterUniqueSkillGroups([removedSectionSkill], sectionChoices.slice(0, 2));
assert.equal(afterSectionRemoval.length, 1);
assert.equal(afterSectionRemoval[0].id, "all");
assert.equal(afterSectionRemoval[0].skills[0].sectionAssignmentNeedsReview, true);
assert.equal(afterSectionRemoval[0].skills[0].sectionAssignment, "");
assert.equal(afterSectionRemoval[0].skills[0].sectionAssignmentChoices.some(choice => choice.selected), false);
assert.throws(
  () => mergeMonsterUniqueSkillFields([removedSectionSkill], [["0.assignment", ""]], sectionChoices.slice(0, 2)),
  /must be assigned to an existing section or All Sections/
);
const reassignedRemovedSection = mergeMonsterUniqueSkillFields(
  [removedSectionSkill],
  [["0.assignment", "all"]],
  sectionChoices.slice(0, 2)
);
assert.deepEqual(reassignedRemovedSection[0], {
  title: "Former Wing skill",
  description: "Keep these details",
  sectionScope: "all",
  sourceText: "Original source text",
  references: [{ destination: "/skill:wing" }]
});
const oneSectionAfterRemoval = prepareMonsterUniqueSkillGroups([removedSectionSkill], [combatStylesForChoices[0]]);
assert.equal(oneSectionAfterRemoval.length, 1);
assert.equal(oneSectionAfterRemoval[0].id, "all");
assert.equal(oneSectionAfterRemoval[0].showHeading, false);
const afterSectionAddition = prepareMonsterUniqueSkillGroups(twoSectionSkills, sectionChoices);
assert.deepEqual(afterSectionAddition.map(group => group.id), [
  "all",
  "cs-head",
  "cs-body"
]);

console.log("Monster sheet source-value, Main Section selection, and Unique Skill section tests passed.");
