import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  associatedSkillReferences,
  parseMainSection,
  parseMonsterPage,
  parseSectionCombatStatistics,
  validateMonsterProfile
} from "../module/importer/monster-parser.mjs";
import { SW25Importer } from "../module/importer/sw25-importer.mjs";

const goblinSource = await readFile(new URL("./fixtures/monster-goblin.md", import.meta.url), "utf8");
const hydraSource = await readFile(new URL("./fixtures/monster-hydra.md", import.meta.url), "utf8");
const cursedArtistSource = await readFile(new URL("./fixtures/monster-cursed-artist.md", import.meta.url), "utf8");
const barraganbukSource = await readFile(new URL("./fixtures/monster-barraganbuk.md", import.meta.url), "utf8");
const speciesExampleSource = await readFile(new URL("./fixtures/monster-species-example.md", import.meta.url), "utf8");
const goblin = parseMonsterPage(goblinSource, "https://sw25.wikidot.com/monster:goblin");
const hydra = parseMonsterPage(hydraSource, "https://sw25.wikidot.com/monster:hydra");
const cursedArtist = parseMonsterPage(cursedArtistSource, "https://sw25.wikidot.com/monster:cursed-artist");
const barraganbuk = parseMonsterPage(barraganbukSource, "https://sw25.wikidot.com/monster:barraganbuk");
const speciesExample = parseMonsterPage(speciesExampleSource, "https://sw25.wikidot.com/monster:species-example");

assert.equal(validateMonsterProfile(goblin), true);
assert.equal(goblin.system.combatStyles.length, 1);
assert.equal(goblin.system.combatStyles[0].section, "");
assert.equal(goblin.system.combatStyles[0].damage, "2d+2");
assert.equal(goblin.system.mainSection.type, "unspecified");

const multilineHtml = parseMonsterPage(
  `<div id="page-content"><h3>Level 2 Barbarous</h3><table>
<tr>
<th>Fighting Style</th>
<th>Accuracy</th>
<th>Damage</th>
<th>Evasion</th>
<th>Defense</th>
<th>HP</th>
<th>MP</th>
</tr>
<tr>
<td>Weapon</td>
<td>3 (10)</td>
<td>2d+2</td>
<td>3 (10)</td>
<td>2</td>
<td>16</td>
<td>12</td>
</tr>
</table></div><div id="pagetags">Accuracy | Damage | bogus row</div>`,
  "https://sw25.wikidot.com/monster:goblin"
);
assert.equal(validateMonsterProfile(multilineHtml), true);
assert.deepEqual(multilineHtml.system.combatStyles[0].sourceValues, [
  "Weapon", "3 (10)", "2d+2", "3 (10)", "2", "16", "12"
]);

assert.equal(validateMonsterProfile(hydra), true);
assert.deepEqual(hydra.system.combatStyles.map(cs => cs.section), ["Body", "Neck x 7-9"]);
assert.equal(hydra.system.combatStyles[0].style, "None");
assert.equal(hydra.system.combatStyles[0].accuracy, "-");
assert.equal(hydra.system.combatStyles[0].damage, "-");
assert.deepEqual(hydra.system.combatStyles[1].sourceValues, [
  "Bite (Neck x 7-9)", "14 (21)", "2d+15", "13 (20)", "9", "86", "29"
]);
assert.deepEqual(hydra.system.mainSection, {
  type: "all",
  sourceValue: "Neck (All)",
  combatStyleIds: ["cs-1", "cs-2"],
  associatedSkills: []
});
assert.equal(hydra.system.sectionSource, "8-10 (Body / Neck x 7-9)");
assert.deepEqual(hydra.system.skillParseErrors, []);

assert.deepEqual(parseMainSection("Head"), {
  type: "named", sourceValue: "Head", combatStyleIds: [], associatedSkills: []
});
assert.deepEqual(parseMainSection("Head, Body").combatStyleIds, []);
assert.deepEqual(parseMainSection("Body (All)").combatStyleIds, []);
assert.equal(parseMainSection("None").type, "none");
assert.equal(parseMainSection("Special").type, "special");
assert.deepEqual(parseMainSection("Special, see below"), {
  type: "special",
  sourceValue: "Special, see below",
  combatStyleIds: [],
  associatedSkills: []
});

assert.equal(validateMonsterProfile(cursedArtist), true);
assert.equal(cursedArtist.name, "Cursed Artist");
assert.equal(cursedArtist.system.monsterType, "Undead");
assert.equal(cursedArtist.system.level, 12);
assert.equal(cursedArtist.system.reputation, 19);
assert.equal(cursedArtist.system.weakness, 22);
assert.equal(cursedArtist.system.weakPoint, "Accuracy +1");
assert.equal(cursedArtist.system.source, "CR III p. 368");
assert.deepEqual(cursedArtist.system.combatStyles.map(cs => cs.section), ["Musician", "Instrument"]);
assert.deepEqual(cursedArtist.system.mainSection, {
  type: "special",
  sourceValue: "Special, see below",
  combatStyleIds: [],
  associatedSkills: [{ skillId: "concealed-main-section", title: "◯Concealed Main Section" }]
});
assert.deepEqual(cursedArtist.system.combatStyles.map(cs => cs.sourceValues), [
  ["Bow for Playing (Musician)", "15 (22)", "2d+15", "14 (21)", "9", "115", "88"],
  ["None (Instrument)", "-", "-", "15 (22)", "10", "106", "48"]
]);
assert.equal(
  cursedArtist.system.uniqueSkills.find(skill => /Concealed Main Section/i.test(skill.title)).description,
  "The Main Section of this monster is randomly selected from Musician and Instrument section at the time of its appearance and is kept secret.\nIn the Monster Knowledge check during Combat Preparation, if the success value is equal to or greater than the Weakness, in addition to applying weak points, Main Section will be identified."
);
assert.ok(cursedArtist.system.uniqueSkills.find(skill => /Magic Aptitude/i.test(skill.title)).references.length >= 5);
assert.deepEqual(JSON.parse(JSON.stringify(cursedArtist.system.combatStyles)), cursedArtist.system.combatStyles);
const concealedMainSectionSkill = cursedArtist.system.uniqueSkills.find(skill => /Concealed Main Section/i.test(skill.title));
assert.equal(concealedMainSectionSkill.sectionScope, "all");

assert.deepEqual(barraganbuk.system.combatStyles.map(cs => ({ section: cs.section, id: cs.id })), [
  { section: "Head", id: "cs-1" },
  { section: "Body", id: "cs-2" }
]);
assert.equal(new Set(barraganbuk.system.combatStyles.map(cs => cs.id)).size, 2);
const reorderedBarraganbuk = parseMonsterPage(
  barraganbukSource.replace(
    "Bite (Head) | 8 (15) | 2d+9 | 9 (16) | 5 | 52 | 43\nVine (Body) | 9 (16) | 2d+7 | 8 (15) | 6 | 58 | 34",
    "Vine (Body) | 9 (16) | 2d+7 | 8 (15) | 6 | 58 | 34\nBite (Head) | 8 (15) | 2d+9 | 9 (16) | 5 | 52 | 43"
  ),
  "https://sw25.wikidot.com/monster:barraganbuk"
);
assert.deepEqual(
  Object.fromEntries(reorderedBarraganbuk.system.combatStyles.map(cs => [cs.section, cs.id])),
  { Body: "cs-2", Head: "cs-1" }
);
assert.equal(barraganbuk.system.skillParseErrors.length, 0);
assert.deepEqual(barraganbuk.system.uniqueSkills.map(skill => skill.title), [
  "◯Normal Weapon Immunity",
  "◯Poison, Disease Immunity",
  "⏩△Mimicry (Incomplete)",
  "◯Daemon's Cuisine / 9 (16) / Fortitude / Negates",
  "◯Delicate Loot",
  "🗨◯Magic Aptitude",
  "◯Spiritualism Magic 7 Level/Magic Power 9(16)",
  "►Engulf and Dissolve / 9 (16) / Fortitude / Negates",
  "►Twin Strike & Double Attack"
]);
assert.deepEqual(barraganbuk.system.uniqueSkills.map(skill => skill.sectionScope), [
  "all", "all", "all", "all", "all", "section", "section", "section", "section"
]);
assert.deepEqual(barraganbuk.system.uniqueSkills.slice(5, 7).map(skill => skill.combatStyleId), [
  "cs-1", "cs-1"
]);
assert.deepEqual(barraganbuk.system.uniqueSkills.slice(7).map(skill => skill.combatStyleId), [
  "cs-2", "cs-2"
]);

// Species extraction from wiki page
assert.equal(speciesExample.system.species, "Goblin", "Wiki Species field is extracted");
assert.equal(speciesExample.name, "Species Example");

// Monsters without an explicit Species field have no species in parsed data
assert.equal(goblin.system.species, "", "Goblin wiki page has no Species field");
assert.equal(hydra.system.species, "", "Hydra wiki page has no Species field");
assert.ok(barraganbuk.system.uniqueSkills.every(skill =>
  skill.sourceText && skill.titleSource && skill.descriptionSource !== undefined
));
const daemonCuisine = barraganbuk.system.uniqueSkills.find(skill => /Daemon's Cuisine/.test(skill.title));
assert.match(daemonCuisine.description, /Using this ability decreases the Barraganbuk's HP by 10 points/);
const spiritualism = barraganbuk.system.uniqueSkills.find(skill => /Spiritualism Magic/.test(skill.title));
assert.deepEqual(spiritualism.references.map(reference => ({
  label: reference.label,
  destination: reference.destination
})), [{ label: "Spiritualism Magic", destination: "/spells:spiritualism" }]);
assert.match(spiritualism.titleSource, /\[Spiritualism Magic\]\(\/spells:spiritualism\)/);
assert.deepEqual(JSON.parse(JSON.stringify(barraganbuk.system.uniqueSkills)), barraganbuk.system.uniqueSkills);
assert.deepEqual(barraganbuk.system.uniqueSkills.filter(skill =>
  /^(?:All Sections)$/i.test(skill.title)
), []);

const unknownScope = parseMonsterPage(
  barraganbukSource.replace("###### Body", "###### Tail"),
  "https://sw25.wikidot.com/monster:barraganbuk"
);
assert.throws(
  () => validateMonsterProfile(unknownScope),
  /Barraganbuk: line \d+: unique skills heading "Tail" does not match "All Sections" or a declared monster section/
);
assert.equal(unknownScope.system.uniqueSkills.some(skill => skill.title === "Tail"), false);

const unscopedSkillProfile = parseMonsterPage(
  `Level 2 Example
Fighting Style | Accuracy | Damage | Evasion | Defense | HP | MP
Attack | 3 (10) | 2d+2 | 3 (10) | 2 | 16 | 12
#### Unique Skills
#### Example Skill
A single-section ability with a [reference](/skill:example).`,
  "https://sw25.wikidot.com/monster:example"
);
assert.equal(validateMonsterProfile(unscopedSkillProfile), true);
assert.deepEqual(unscopedSkillProfile.system.combatStyles.map(cs => cs.id), ["cs-1"]);
assert.equal(unscopedSkillProfile.system.uniqueSkills.length, 1);
assert.equal(unscopedSkillProfile.system.uniqueSkills[0].sectionScope, "unspecified");
assert.equal("combatStyleId" in unscopedSkillProfile.system.uniqueSkills[0], false);
assert.equal(unscopedSkillProfile.system.uniqueSkills[0].references[0].destination, "/skill:example");

const unscopedMultiSectionProfile = parseMonsterPage(
  `Level 3 Example
Sections: 2 (Claw / Tail)
Main Section: Claw
Fighting Style | Accuracy | Damage | Evasion | Defense | HP | MP
Claw (Claw) | 5 (12) | 2d+3 | 4 (11) | 3 | 24 | 10
Tail (Tail) | 4 (11) | 2d+2 | 5 (12) | 2 | 18 | 8
#### Unique Skills
#### Unscoped Ability
This ability has no explicit section heading.`,
  "https://sw25.wikidot.com/monster:example"
);
assert.equal(validateMonsterProfile(unscopedMultiSectionProfile), true);
assert.equal(unscopedMultiSectionProfile.system.uniqueSkills[0].sectionScope, "unspecified");
assert.equal("combatStyleId" in unscopedMultiSectionProfile.system.uniqueSkills[0], false);

assert.deepEqual(parseMainSection("Special"), {
  type: "special", sourceValue: "Special", combatStyleIds: [], associatedSkills: []
});
assert.deepEqual(
  associatedSkillReferences(
    { type: "special" },
    [{ id: "concealed-main-section", title: "Concealed Main Section" }]
  ),
  [{ skillId: "concealed-main-section", title: "Concealed Main Section" }]
);
const specialSectionExcerpt = parseMonsterPage(
  "Main Section: Special\n#### Unique Skills\n**►Concealed Main Section**",
  "https://sw25.wikidot.com/monster:doubleburg"
).system;
assert.deepEqual(specialSectionExcerpt.mainSection.associatedSkills, [
  { skillId: "concealed-main-section", title: "►Concealed Main Section" }
]);

const skillWithoutLinks = parseMonsterPage(
  "#### Unique Skills\n#### Example Skill\nA plain description without links.",
  "https://sw25.wikidot.com/monster:example"
).system.uniqueSkills[0];
assert.equal(skillWithoutLinks.description, "A plain description without links.");
assert.deepEqual(skillWithoutLinks.references, []);

const linkedSkill = parseMonsterPage(
  "#### Unique Skills\n**►Sample Skill**\nOne [first reference](/skill:first) and [second reference](/skill:second \"Second rule\").",
  "https://sw25.wikidot.com/monster:example"
).system;
const linkedSkillRecord = linkedSkill.uniqueSkills[0];
assert.equal(linkedSkillRecord.title, "►Sample Skill");
assert.equal(linkedSkillRecord.titleSource, "**►Sample Skill**");
assert.equal(linkedSkillRecord.description, "One first reference and second reference.");
assert.equal(linkedSkillRecord.descriptionSource, "One [first reference](/skill:first) and [second reference](/skill:second \"Second rule\").");
assert.deepEqual(linkedSkillRecord.references, [
  {
    sourceText: "[first reference](/skill:first)",
    label: "first reference",
    destination: "/skill:first",
    title: "",
    skillIdentifier: "skill:first"
  },
  {
    sourceText: "[second reference](/skill:second \"Second rule\")",
    label: "second reference",
    destination: "/skill:second",
    title: "Second rule",
    skillIdentifier: "skill:second"
  }
]);
assert.deepEqual(JSON.parse(JSON.stringify(linkedSkill.uniqueSkills)), linkedSkill.uniqueSkills);

const sourceNotation = parseSectionCombatStatistics(["Test", "0", "※+20", "※", "-", "0", "-"]);
assert.equal(sourceNotation.accuracy, "0");
assert.equal(sourceNotation.damage, "※+20");
assert.equal(sourceNotation.evasion, "※");
assert.equal(sourceNotation.defense, "-");
assert.equal(sourceNotation.hp, "0");
assert.equal(sourceNotation.mp, "-");
const specialStatProfile = parseMonsterPage(
  hydraSource.replace(
    "None (Body) | - | - | 12 (19) | 13 | 106 | 44",
    "None (Body) | 0 | ※+20 | ※ | ※+20 | 0 | -"
  ),
  "https://sw25.wikidot.com/monster:hydra"
);
assert.deepEqual(
  {
    accuracy: specialStatProfile.system.combatStyles[0].accuracy,
    damage: specialStatProfile.system.combatStyles[0].damage,
    evasion: specialStatProfile.system.combatStyles[0].evasion,
    defense: specialStatProfile.system.combatStyles[0].defense,
    hp: specialStatProfile.system.combatStyles[0].hp.value,
    mp: specialStatProfile.system.combatStyles[0].mp.value
  },
  { accuracy: "0", damage: "※+20", evasion: "※", defense: "※+20", hp: 0, mp: "-" }
);
assert.deepEqual(JSON.parse(JSON.stringify(hydra.system.combatStyles)), hydra.system.combatStyles);

const missingSectionStats = parseMonsterPage(
  `### Level 11 Animal
**Intelligence:** Animal
**Perception:** Five Senses
**Disposition:** Hostile
**Language:** None
**Habitat:** Lakes, Swamps
**Reputation/Weakness:** 17/20
**Weak Point:** Physical damage +3 points
**Initiative:** 16
**Movement Speed:** 12 (Crawling)/12(Swimming)
**Fortitude:** 14 (21)
**Willpower:** 13 (20)

**Source:** CR II, p. 362
**Sections:** 8-10 (Body / Neck x 7-9)
**Main Section:** Neck (All)

Fighting Style | Accuracy | Damage | Evasion | Defense | HP | MP
--- | --- | --- | --- | --- | --- | ---

#### Unique Skills
◯Limited Attacks
Necks can only make two Bite attacks against the same target during a single round.`,
  "https://sw25.wikidot.com/monster:hydra"
);
assert.throws(
  () => validateMonsterProfile(missingSectionStats),
  /Hydra: combatStyles: no complete Fighting Style statistics were parsed/
);

const malformedSection = parseMonsterPage(
  hydraSource.replace("None (Body) | - | - | 12 (19) | 13 | 106 | 44", "None (Body) | - | - | 12 (19)"),
  "https://sw25.wikidot.com/monster:hydra"
);
assert.throws(
  () => validateMonsterProfile(malformedSection),
  /line \d+: malformed combat row/
);

const malformedWithoutSeparators = parseMonsterPage(
  hydraSource.replace("None (Body) | - | - | 12 (19) | 13 | 106 | 44", "None (Body) - - 12 (19) 13"),
  "https://sw25.wikidot.com/monster:hydra"
);
assert.throws(
  () => validateMonsterProfile(malformedWithoutSeparators),
  /line \d+: malformed combat row for Body/
);

const malformedAfterValidRow = parseMonsterPage(
  hydraSource.replace(
    "None (Body) | - | - | 12 (19) | 13 | 106 | 44",
    "None (Body) | - | - | 12 (19) | 13 | 106 | 44\nBite (Neck x 7-9) 14 (21) 2d+15 13 (20)"
  ),
  "https://sw25.wikidot.com/monster:hydra"
);
assert.throws(
  () => validateMonsterProfile(malformedAfterValidRow),
  /line \d+: malformed combat row for Neck/
);

const surroundingProse = parseMonsterPage(
  hydraSource.replace(
    "None (Body) | - | - | 12 (19) | 13 | 106 | 44",
    "A descriptive note mentions 2 heads across 3 caves.\nNone (Body) | - | - | 12 (19) | 13 | 106 | 44"
  ),
  "https://sw25.wikidot.com/monster:hydra"
);
assert.equal(validateMonsterProfile(surroundingProse), true);

const missingMainSection = parseMonsterPage(
  hydraSource.replace("**Main Section:** Neck (All)", ""),
  "https://sw25.wikidot.com/monster:hydra"
);
assert.throws(
  () => validateMonsterProfile(missingMainSection),
  /Hydra: mainSection: designation is required for a multi-section profile/
);

const originalFetchPage = SW25Importer.fetchPage;
const invalidActor = {
  name: "Existing Hydra",
  type: "monster",
  system: { description: "Preserve me", customField: 17, combatStyles: [{ style: "Existing", hp: { value: 5, max: 5 } }] },
  async update() { actorWasUpdated = true; }
};
const existingActorBefore = { name: invalidActor.name, system: structuredClone(invalidActor.system) };
let actorWasUpdated = false;

// Con el modelo unificado, eliminar una entrada de combate no invalida el monstruo
// si queda al menos una entrada válida.
const removeCombatRow = (source, rowText) => {
  const lines = source.split('\n');
  const filtered = lines.filter(line => line.trimEnd() !== rowText);
  return filtered.join('\n');
};

SW25Importer.fetchPage = async () => ({ kind: "markdown", text: removeCombatRow(hydraSource, "None (Body) | - | - | 12 (19) | 13 | 106 | 44") });
try {
  await SW25Importer.importUrl("https://sw25.wikidot.com/monster:hydra", invalidActor);
} finally {
  SW25Importer.fetchPage = originalFetchPage;
}
assert.equal(actorWasUpdated, true);

// Si se eliminan todas las entradas de combate, la validación debe rechazar el monstruo.
SW25Importer.fetchPage = async () => ({ kind: "markdown", text: removeCombatRow(removeCombatRow(hydraSource, "None (Body) | - | - | 12 (19) | 13 | 106 | 44"), "Bite (Neck x 7-9) | 14 (21) | 2d+15 | 13 (20) | 9 | 86 | 29") });
actorWasUpdated = false;
try {
  await assert.rejects(
    SW25Importer.importUrl("https://sw25.wikidot.com/monster:hydra", invalidActor),
    /Hydra: combatStyles: no complete Fighting Style statistics were parsed/
  );
} finally {
  SW25Importer.fetchPage = originalFetchPage;
}
assert.equal(actorWasUpdated, false);
assert.deepEqual({ name: invalidActor.name, system: invalidActor.system }, existingActorBefore);

SW25Importer.fetchPage = async () => ({ kind: "markdown", text: barraganbukSource.replace("###### Body", "###### Tail") });
try {
  await assert.rejects(
    SW25Importer.importUrl("https://sw25.wikidot.com/monster:barraganbuk", invalidActor),
    /Barraganbuk: .*unique skills heading "Tail" does not match/
  );
} finally {
  SW25Importer.fetchPage = originalFetchPage;
}
assert.equal(actorWasUpdated, false);
assert.deepEqual({ name: invalidActor.name, system: invalidActor.system }, existingActorBefore);

let importUpdate;
SW25Importer.fetchPage = async () => ({ kind: "markdown", text: hydraSource });
try {
  await SW25Importer.importUrl("https://sw25.wikidot.com/monster:hydra", {
    type: "monster",
    update: async data => { importUpdate = data; }
  });
} finally {
  SW25Importer.fetchPage = originalFetchPage;
}
assert.equal("system" in importUpdate, false);
assert.deepEqual(importUpdate["system.combatStyles"].map(cs => cs.section), ["Body", "Neck x 7-9"]);
assert.equal(importUpdate["system.mainSection"].sourceValue, "Neck (All)");
const serializedImport = JSON.parse(JSON.stringify({
  combatStyles: importUpdate["system.combatStyles"],
  sectionSource: importUpdate["system.sectionSource"],
  sectionCount: importUpdate["system.sectionCount"],
  mainSection: importUpdate["system.mainSection"]
}));
assert.deepEqual(serializedImport.combatStyles, hydra.system.combatStyles);
assert.equal(serializedImport.sectionSource, "8-10 (Body / Neck x 7-9)");
assert.deepEqual(serializedImport.mainSection, hydra.system.mainSection);

let singleSectionUpdate;
SW25Importer.fetchPage = async () => ({ kind: "markdown", text: goblinSource });
try {
  await SW25Importer.importUrl("https://sw25.wikidot.com/monster:goblin", {
    type: "monster",
    update: async data => { singleSectionUpdate = data; }
  });
} finally {
  SW25Importer.fetchPage = originalFetchPage;
}
assert.equal(singleSectionUpdate["system.combatStyles"].length, 1);
assert.equal(singleSectionUpdate["system.combatStyles"][0].damage, "2d+2");
assert.equal(singleSectionUpdate["system.combatStyles"].length, 1);

// Importer species assignment: wiki-provided species is stored
let speciesImportUpdate;
SW25Importer.fetchPage = async () => ({ kind: "markdown", text: speciesExampleSource });
try {
  await SW25Importer.importUrl("https://sw25.wikidot.com/monster:species-example", {
    type: "monster",
    update: async data => { speciesImportUpdate = data; }
  });
} finally {
  SW25Importer.fetchPage = originalFetchPage;
}
assert.equal(speciesImportUpdate["system.species"], "Goblin", "Importer stores wiki-assigned species");

// Importer species fallback: wiki without species defaults to monster name
let fallbackImportUpdate;
SW25Importer.fetchPage = async () => ({ kind: "markdown", text: goblinSource });
try {
  await SW25Importer.importUrl("https://sw25.wikidot.com/monster:goblin", {
    type: "monster",
    name: "Goblin",
    update: async data => { fallbackImportUpdate = data; }
  });
} finally {
  SW25Importer.fetchPage = originalFetchPage;
}
assert.equal(fallbackImportUpdate["system.species"], "Goblin", "Importer defaults species to monster name when wiki provides none");

console.log("Monster parser/import validation tests passed.");
