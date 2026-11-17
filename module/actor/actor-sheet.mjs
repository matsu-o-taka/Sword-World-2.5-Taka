import { abilityBonus, isGunWeapon, isWarriorClass } from "../rules/weapon-damage.mjs";
import { resolveAttackingClass, rollWeaponDamage } from "../rules/weapon-roll.mjs";
import { playerInitiativeModifier, recordPlayerInitiative } from "../combat/side-initiative.mjs";
import { rememberMagicPowerRoll } from "../rules/spell-damage.mjs";
import { rollDeathCheck } from "../rules/death-check.mjs";
import { automaticFailureButton, criticalFailureHTML, isCriticalFailure } from "../rules/critical-failure.mjs";
import { recoveryPowerTableHTML } from "../rules/recovery-items.mjs";
import { characterHPMaximum, characterMPMaximum } from "../rules/resources.mjs";
import { featureDefenseModifier } from "../rules/feature-defense.mjs";
import { SKILL_DEFINITION_MAP, SKILL_DEFINITIONS } from "../rules/skill-definitions.mjs";
import { AUTO_SELECTION, resolveClassAssignment, resolveSkillClass } from "../rules/skill-resolution.mjs";
import { openRollModifiersDialog } from "../rules/roll-modifiers.mjs";
import { castSpellAsMajor, castSpellAsMinor, castSpellInCombatPreparation, isCombatPreparationSpell, isMinorActionSpell } from "../rules/spell-cast.mjs";
import { characterWeaponAttackFlow, resolveAttackTarget, describeTargetFailure } from "../combat/attack-resolution.mjs";
import { readMonsterActorCombatStyles } from "./monster-sheet-data.mjs";
import { rollMonsterKnowledge } from "../combat/monster-knowledge.mjs";
import { prepareSw25EffectsTab } from "../effects/effects-tab.mjs";
import { sw25EffectLedger, sw25EffectModifier, sw25EffectiveResourceMaximum } from "../effects/effective-values.mjs";
import { wireSw25EffectsTabHandlers } from "./effects-tab-ui.mjs";

// Combat feat that grants Marksman access to Evasion calculation. Identified
// by the feat item's canonical name (feats are matched by normalized name).
const ARCHERS_GRACE_FEAT = "Archer's Grace";

export class SW25ActorSheet extends foundry.appv1.sheets.ActorSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["sw25", "sheet", "actor"],
      width: 1120,
      height: 820,
      resizable: true,
      scrollY: [".tab-content"],
      dragDrop: [{ dragSelector:"[data-item-id]", dropSelector:".sw25-official-sheet" }]
    });
  }

  get template() {
    return "systems/sw25-taka/templates/actor/character-sheet.hbs";
  }

  /**
   * A race imported from the wiki is more than an owned Item: it initializes
   * the character's languages, racial abilities, ability corrections, and
   * background. Route dropped race Items through that same importer workflow.
   */
  async _onDropItemCreate(itemData, event) {
    const dropped = Array.isArray(itemData) ? itemData : [itemData];
    const created = [];
    for (const data of dropped) {
      if (data?.type !== "race" || this.actor.type !== "character") {
        created.push(...await super._onDropItemCreate(data, event));
        continue;
      }

      const importer = game.sw25?.importer;
      if (!importer) throw new Error("The Sword World 2.5 importer is not available.");
      const system = foundry.utils.deepClone(data.system || {});
      const sourceUrl = String(system.sourceUrl || "").trim();

      // Reparse from the source when possible. This recovers structured
      // background tables and racial abilities from compendiums created by
      // older import macros, which only stored the flattened raw text.
      let race;
      if (sourceUrl) {
        try {
          race = await importer.importUrl(sourceUrl, this.actor);
        } catch (error) {
          console.warn(`Sword World 2.5 | Could not refresh dropped race ${data.name} from ${sourceUrl}; using its stored data.`, error);
        }
      }

      if (!race) {
        const rawText = String(system.rawText || "");
        const abilitiesText = importer.extractRacialAbilitySection(rawText);
        const parsed = {
          name:String(data.name || "Imported Race"),
          sourceUrl,
          description:String(system.description || ""),
          languages:String(system.languages || ""),
          restrictedClasses:String(system.restrictedClasses || ""),
          lifespan:String(system.lifespan || ""),
          soulscars:Number(system.soulscars || 0),
          corrections:system.corrections || {},
          backgrounds:String(system.backgrounds || ""),
          backgroundTables:rawText ? importer.parseBackgroundTablesMarkdown(rawText, data.name) : [],
          rawText,
          abilities:abilitiesText ? importer.extractAbilities(abilitiesText) : []
        };
        race = await importer.createRace(parsed, this.actor);
      }
      if (race) created.push(race);
    }
    return created;
  }

  async getData(options = {}) {
    const context = await super.getData(options);
    context.actor = this.actor;
    context.system = this.actor.system;

    const soulscars = Number(this.actor.system.soulscars ?? 0);
    context.soulscarCircles = Array.from({ length: 5 }, (_, index) => ({
      value: index + 1,
      active: index < soulscars
    }));

    let savedSheetStyle = String(this.actor.getFlag("sw25-taka", "sheetStyle") ?? "light").toLowerCase();
    // Normalize legacy "paper" value to "light" for backward compatibility.
    if (savedSheetStyle === "paper") savedSheetStyle = "light";
    context.sheetStyle = ["light", "light-red"].includes(savedSheetStyle) ? savedSheetStyle : "light";
    // "light-red" is a Light variant: the form carries the light theme class as
    // well (see character-sheet.hbs), so Light-gated UI (portrait gauge toggle
    // tooltip, gauges) applies to it too.
    context.isLightStyle = true;
    context.isPlainLightStyle = context.sheetStyle === "light";
    context.isLightRedStyle = context.sheetStyle === "light-red";

    const byType = type => [...this.actor.items]
      .filter(item => item.type === type)
      .sort((a, b) => a.name.localeCompare(b.name));

    context.races = byType("race");
    context.race = context.races[0] ?? null;
    context.classes = byType("class").sort((a, b) =>
      Number(b.system.level ?? 0) - Number(a.system.level ?? 0) || a.name.localeCompare(b.name)
    );
    context.feats = byType("feat");
    context.racialAbilities = byType("ability").filter(item => item.system.source === "racial");
    context.classAbilities = byType("ability").filter(item => item.system.source === "class");
    context.weapons = byType("weapon");
    context.armour = byType("armour");
    context.skills = byType("skill");
    context.spells = byType("spell");
    context.favouriteSpells = context.spells.filter(item => Boolean(item.system.favourite));
    const groupSpellsByLevel = spells => {
      const levels = new Map();
      for (const spell of spells) {
        const level = Math.max(0, Number(spell.system.level ?? 0));
        if (!levels.has(level)) levels.set(level, []);
        levels.get(level).push(spell);
      }
      return [...levels.entries()]
        .sort(([a], [b]) => a - b)
        .map(([level, items]) => ({ level, label:`Level ${level}`, items }));
    };
    const classToSchool = {
      "sorcerer": "Truespeech Magic",
      "conjurer": "Spiritualism",
      "fairy tamer": "Fairy Magic",
      "priest": "Divine Magic"
    };
    const schoolOrder = ["Truespeech Magic", "Spiritualism", "Fairy Magic", "Divine Magic"];
    const schoolSpells = new Map();
    for (const spell of context.favouriteSpells) {
      const schoolKey = String(spell.system.school ?? "").trim() || "General";
      const school = classToSchool[schoolKey.toLowerCase()] || schoolKey;
      if (!schoolSpells.has(school)) schoolSpells.set(school, { spells: [], schoolKey });
      schoolSpells.get(school).spells.push(spell);
    }
    const favouriteSpellLevels = [];
    for (const [school, data] of schoolSpells) {
      const spells = data.spells;
      const schoolKey = data.schoolKey;
      const classNames = context.classes
        .filter(c => String(c.system.school ?? "").toLowerCase() === schoolKey.toLowerCase() ||
                     String(c.name ?? "").toLowerCase() === schoolKey.toLowerCase())
        .map(c => String(c.name ?? ""));
      const levels = new Map();
      for (const spell of spells) {
        const level = Math.max(0, Number(spell.system.level ?? 0));
        if (!levels.has(level)) levels.set(level, []);
        levels.get(level).push(spell);
      }
      favouriteSpellLevels.push({
        school,
        label: school,
        className: classNames.join(", "),
        levels: [...levels.entries()].sort(([a],[b]) => a - b).map(([level, items]) => ({level, label: `Lv ${level}`, items}))
      });
    }
    favouriteSpellLevels.sort((a, b) => {
      const ai = schoolOrder.indexOf(a.school);
      const bi = schoolOrder.indexOf(b.school);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.school.localeCompare(b.school);
    });
    context.favouriteSpellLevels = favouriteSpellLevels;
    // Casting modality capability for the sheet buttons: ⏩ Minor Action and
    // △ Combat Preparation are read from the authored name markers (the
    // importer keeps them; DEC-1). Major Action remains available for both.
    for (const spell of context.spells) {
      spell.castMinor = isMinorActionSpell(spell);
      spell.castPrep = isCombatPreparationSpell(spell);
    }
    context.equipment = byType("equipment");
    const correctedClassName = name => /^abyss gaer$/i.test(String(name ?? "").trim()) ? "Abyss Gazer" : String(name ?? "");
    const legacyClassUpdates = this.actor.isOwner ? [...this.actor.items].flatMap(item => {
      const update = { _id:item.id };
      let changed = false;
      if (item.type === "class" && correctedClassName(item.name) !== item.name) {
        update.name = correctedClassName(item.name);
        changed = true;
      }
      for (const field of ["className", "school"]) {
        const current = String(item.system?.[field] ?? "");
        const corrected = correctedClassName(current);
        if (corrected !== current) {
          update[`system.${field}`] = corrected;
          changed = true;
        }
      }
      return changed ? [update] : [];
    }) : [];
    if (legacyClassUpdates.length) await this.actor.updateEmbeddedDocuments("Item", legacyClassUpdates, { render:false });
    for (const item of context.classes) item.sheetDisplayName = correctedClassName(item.name);
    context.additionalItems = [...context.classAbilities, ...context.spells, ...context.feats];
    context.equippedGear = [...context.weapons, ...context.armour, ...context.equipment]
      .filter(item => item.system.equipped);
    context.equippedWeapons = context.weapons.filter(item => item.system.equipped);

    const system = this.actor.system;

    const classTypeForName = name => {
      const key = String(name ?? "").trim().toLowerCase().replace(/^abyss gaer$/, "abyss gazer");
      const warriors = new Set(["battle dancer","fencer","fighter","martial artist","grappler","marksman"]);
      const wizards = new Set(["abyss gazer","artificer","bibliomancer","conjurer","daemonologist","druid","fairy tamer","priest","sorcerer"]);
      const others = new Set(["alchemist","bard","dark hunter","enhancer","geomancer","heritor","ranger","rider","sage","scout","tactician"]);
      if (warriors.has(key)) return "Warrior";
      if (wizards.has(key)) return "Wizard";
      if (others.has(key)) return "Other";
      return "";
    };
    const base = system.abilityBases ?? {};
    const adj = system.abilityAdjustments ?? {};
    // Prepared effect ledger (DEC-28): assigned by the Actor preparation
    // pipeline (module/effects/effective-values.mjs). All-zero structure when
    // no system effect is active, so every formula below returns exactly the
    // pre-integration values in that case.
    const effectLedger = sw25EffectLedger(this.actor);
    const letterAbility = { a: "dexterity", b: "agility", c: "strength", d: "vitality", e: "intelligence", f: "spirit" };
    const score = (baseName, letter) =>
      Number(base[baseName] ?? 0) +
      Number(adj[letter]?.growth ?? 0) +
      Number(adj[letter]?.correction ?? 0) +
      Number(adj[letter]?.temporary ?? 0) +
      Number(effectLedger.abilities?.[letterAbility[letter]] ?? 0);

    const xpCosts = {
      A: [0, 1000, 2000, 3500, 5000, 7000, 9500, 12500, 16500, 21500, 27500, 35000, 44000, 54500, 66500, 80000, 95000, 125000],
      B: [0, 500, 1500, 2500, 4000, 5500, 7500, 10000, 13000, 17000, 22000, 28000, 35500, 44500, 55000, 67000, 80500, 105500]
    };

    for (const item of context.classes) {
      const category = String(item.system.category ?? "A").toUpperCase() === "B" ? "B" : "A";
      const level = Math.max(0, Math.min(17, Number(item.system.level ?? 0)));
      item.xpCost = xpCosts[category][level] ?? 0;
      item.displayClassType = classTypeForName(item.name) || String(item.system.classType ?? "").replace(/-type Class/i, "").trim() || "Other";
    }

    const featureSections = {
      alchemist: [{ key: "evocation", label: "Evocations", prefix: "evocation:" }],
      bard: [{ key: "spellsong", label: "Spellsongs", prefix: "spellsong:" }, { key: "finale", label: "Finales", prefix: "finale:" }],
      "dark hunter": [{ key: "weaving", label: "Essence Weavings", prefix: "weaving:" }],
      enhancer: [{ key: "technique", label: "Techniques", prefix: "technique:" }],
      geomancer: [{ key: "aspect", label: "Aspects", prefix: "aspect:" }],
      heritor: [{ key: "infusion", label: "Infusions", prefix: "infusion:" }],
      rider: [{ key: "stunt", label: "Stunts", prefix: "stunt:" }],
      tactician: [{ key: "stratagem", label: "Stratagems", prefix: "stratagem:" }, { key: "maneuver", label: "Maneuvers", prefix: "maneuver:" }]
    };
    const excludedOtherTabs = new Set(["ranger", "sage", "scout"]);
    const importedFeatures = [...context.spells, ...context.classAbilities];
    context.classTabs = context.classes.flatMap(classItem => {
      const displayName = correctedClassName(classItem.name);
      const nameKey = displayName.trim().toLowerCase();
      const type = String(classItem.displayClassType).trim().toLowerCase();
      if (type === "warrior" || (type === "other" && excludedOtherTabs.has(nameKey))) return [];
      let sections = type === "wizard" ? [{ key: "spell", label: "Spells", prefix: "spell:" }] : featureSections[nameKey];
      if (!sections && type === "other") sections = [{ key: "ability", label: "Class Abilities", prefix: "" }];
      if (!sections) return [];
      return [{
        id: `class-${classItem.id}`,
        label: displayName,
        pageClass: `class-page-${nameKey.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
        sections: sections.map(section => ({
          ...section,
          classId: classItem.id,
          className: displayName,
          items: importedFeatures.filter(item =>
            (String(item.system.classId || "") === classItem.id ||
              (!item.system.classId && String(item.system.className || item.system.school || "").toLowerCase() === nameKey)) &&
            String(item.system.featureType || (item.type === "spell" ? "spell" : "ability")).toLowerCase() === section.key
          ).map(item => {
            const featureType = String(item.system.featureType || "").toLowerCase();
            const edgeCost = String(item.system.metadata || "").match(/(?:^|\n)Edge Cost:\s*([^\n]+)/i)?.[1]?.trim();
            item.classFeatureCost = ["stratagem", "maneuver"].includes(featureType) ? (edgeCost || item.system.cost || "None") : item.system.cost;
            return item;
          })
        }))
      }];
    });
    for (const tab of context.classTabs) {
      for (const section of tab.sections) {
        if (section.key === "spell") section.levelGroups = groupSpellsByLevel(section.items);
      }
    }

    const spentXP = context.classes.reduce((total, item) => total + Number(item.xpCost ?? 0), 0);
    const totalXP = Number(system.xp?.total ?? 0);

    const abilities = {
      dexterity: score("skill", "a"),
      agility: score("skill", "b"),
      strength: score("body", "c"),
      vitality: score("body", "d"),
      intelligence: score("mind", "e"),
      spirit: score("mind", "f")
    };
    const bonuses = Object.fromEntries(Object.entries(abilities).map(([key, value]) => [key, Math.floor(Number(value) / 6)]));

    context.calculated = {
      adventurerLevel: context.classes.reduce(
        (highest, item) => Math.max(highest, Number(item.system.level ?? 0)), 0
      ),
      totalXP,
      spentXP,
      remainingXP: totalXP - spentXP,
      abilities,
      bonuses,
      normalMove: abilities.agility,
      fullMove: abilities.agility * 3
    };

    const classLevel = (...names) => context.classes
      .filter(item => names.some(name => item.name.toLowerCase() === name.toLowerCase()))
      .reduce((highest, item) => Math.max(highest, Number(item.system.level ?? 0)), 0);
    context.classLevels = {
      fighter: classLevel("Fighter"),
      fencer: classLevel("Fencer"),
      martialArtist: classLevel("Martial Artist", "Grappler"),
      marksman: classLevel("Marksman"),
      scout: classLevel("Scout"),
      tactician: classLevel("Tactician"),
      rider: classLevel("Rider"),
      sage: classLevel("Sage")
    };

    context.classChoices = context.classes.map(item => ({ value: item.id, label: `${item.sheetDisplayName || item.name} (Lv ${Number(item.system.level ?? 0)})` }));
    const allWarriorClasses = this._warriorClasses();
    // Marksman does not grant Evasion natively. It becomes available only when
    // the character has learned the Archer's Grace combat feat.
    const hasArchersGrace = this._hasFeat(ARCHERS_GRACE_FEAT);
    const warriorClasses = hasArchersGrace
      ? allWarriorClasses
      : allWarriorClasses.filter(item => String(item.name ?? "").trim().toLowerCase() !== "marksman");
    // Common class assignment: saved selection preserved only while valid,
    // otherwise the highest-level eligible class (order-independent). It is
    // re-derived on every render, so class level changes recalalculate it.
    const defenseResolved = resolveClassAssignment({
      classes: warriorClasses,
      savedValue: system.combat?.defenseClassId
    });
    context.defenseClassChoices = defenseResolved.options;
    const selectedDefenseClassId = defenseResolved.classId;
    const offenseResolved = resolveClassAssignment({
      classes: context.classes,
      eligible: isWarriorClass,
      savedValue: system.combat?.offenseClassId
    });
    context.offenseClassChoices = offenseResolved.options;
    const wizardClasses = context.classes.filter(item => String(item.displayClassType || item.system.classType || "").toLowerCase().includes("wizard"));
    const magicResolved = resolveClassAssignment({
      classes: wizardClasses,
      savedValue: system.combat?.magicClassId
    });
    context.magicClassChoices = magicResolved.options;
    const selectedMagicClassId = magicResolved.classId;
    const selectedClassLevel = id => Number(this.actor.items.get(id)?.system.level ?? 0);
    const adventurer = context.calculated.adventurerLevel;
    /* The maxima are persisted by module/actor/resource-maxima.mjs through
       lifecycle hooks — the sheet derives them here for presentation only
       (no render side effects ever write actor data). */
    const formulaHP = characterHPMaximum(system, context.classes);
    context.calculated.hpMax = formulaHP;
    const formulaMP = characterMPMaximum(system, context.classes);
    context.calculated.mpMax = formulaMP;
    const rawMpValue = system.mp?.value;
    const mpArray = Array.isArray(rawMpValue) ? rawMpValue : [rawMpValue];
    context.calculated.mpCurrent = mpArray.find(v => v != null && Number.isFinite(Number(v))) ?? 0;
    context.calculated.sageLevel = context.classLevels.sage;
    context.calculated.riderLevel = context.classLevels.rider;
    // Monster Knowledge resolves through the same production resolver as the
    // ordinary Skill Checks: automatic selection uses the normal associations
    // (Sage / Rider, highest level), Dark Hunter is manual-only (Abyss
    // Breaker, Daemons only — see the Monster Knowledge definition).
    // Monster Knowledge resolves through the same production resolver as the
    // ordinary Skill Checks: the tick checkbox exposes automatic mode (absent
    // selection, or the legacy "auto" marker) and re-derives the best valid
    // class immediately on every render; a picked class stays pinned while
    // the checkbox is off (Abyss Breaker: Dark Hunter Daemons only).
    const savedKnowledgeClass = system.combat?.monsterKnowledgeClassId ?? "";
    context.monsterKnowledgeAuto = !savedKnowledgeClass
      || String(savedKnowledgeClass) === AUTO_SELECTION;
    const monsterKnowledgeResolved = resolveSkillClass({
      classes: context.classes,
      def: SKILL_DEFINITION_MAP.get("monster-knowledge-intelligence"),
      savedValue: savedKnowledgeClass
    });
    context.monsterKnowledgeOptions = monsterKnowledgeResolved.options;
    context.calculated.monsterKnowledgeClassLevel = monsterKnowledgeResolved.level;
    context.calculated.scoutLevel = context.classLevels.scout;
    context.calculated.tacticianLevel = context.classLevels.tactician;

    // Initiative Class selector: offers only Scout and Tactician classes owned
    // by the character, through the common class-assignment rule (saved
    // selection while valid, otherwise the highest-level one). Falls back
    // automatically when the saved selection is no longer valid.
    const initiativeClasses = context.classes.filter(item =>
      /^(scout|tactician)$/i.test(String(item.name ?? "").trim())
    );
    const initiativeResolved = resolveClassAssignment({
      classes: initiativeClasses,
      savedValue: system.combat?.initiativeClassId
    });
    context.initiativeClassChoices = initiativeResolved.options;
    const selectedInitiativeClassId = initiativeResolved.classId;
    context.calculated.initiativeClassLevel = initiativeResolved.level;
    context.calculated.monsterKnowledgeBonus = Number(system.combat?.monsterKnowledgeBonus ?? 0);
    context.calculated.initiativeBonus = Number(system.combat?.initiativeBonus ?? 0);
    context.calculated.monsterKnowledge = (
      context.calculated.monsterKnowledgeClassLevel > 0
        ? context.calculated.monsterKnowledgeClassLevel + bonuses.intelligence
        : 0
    ) + context.calculated.monsterKnowledgeBonus;
    context.calculated.initiativeBase = playerInitiativeModifier(
      context.calculated.initiativeClassLevel,
      0,
      bonuses.agility,
      context.calculated.initiativeBonus
    );
    context.calculated.initiative = context.calculated.initiativeBase
      + Number((effectLedger.combat ?? {}).initiative ?? 0);
    // ── Effective combat values (T3.3, DEC-28) ──────────────────────────────
    // Each displayed value = base (existing formulas) + the prepared effect
    // ledger entry. Without active effects every value equals its base.
    const combatMods = effectLedger.combat ?? {};
    const resistanceMods = effectLedger.resistances ?? {};
    const resourceMods = effectLedger.resources ?? {};
    context.calculated.fortitudeBase = adventurer + bonuses.vitality;
    context.calculated.fortitude = context.calculated.fortitudeBase + Number(resistanceMods.fortitude ?? 0);
    context.calculated.willpowerBase = adventurer + bonuses.spirit;
    context.calculated.willpower = context.calculated.willpowerBase + Number(resistanceMods.willpower ?? 0);
    const equippedArmour = context.armour.filter(item => item.system.equipped);
    const defensiveFeatures = [...context.feats, ...context.racialAbilities, ...context.classAbilities];
    context.calculated.featureDefense = defensiveFeatures.reduce((sum, item) => sum + featureDefenseModifier(item), 0);
    context.calculated.defenseBase = equippedArmour.reduce((sum,item)=>sum+Number(item.system.defence ?? 0),0) + context.calculated.featureDefense;
    // Defense combines the passive featureDefenseModifier contributions (I7)
    // with the dynamic effect ledger: combined, never substituted and never
    // applied twice (no name matching beyond the existing feature rule).
    context.calculated.defense = context.calculated.defenseBase + Number(combatMods.defense ?? 0);
    context.calculated.magicalDefenseBase = equippedArmour.reduce((sum,item)=>sum+Number(item.system.magicalDefence ?? 0),0);
    context.calculated.magicalDefense = context.calculated.magicalDefenseBase + Number(combatMods.magicalDefense ?? 0);
    context.calculated.armourEvasion = equippedArmour.reduce((sum,item)=>sum+Number(item.system.evasion ?? 0),0);
    context.calculated.defenseClassLevel = selectedClassLevel(selectedDefenseClassId);
    context.calculated.offenseClassLevel = offenseResolved.level;
    context.calculated.situationalEvasion = Number(system.combat?.situationalEvasion ?? 0);
    context.calculated.evasionBase = context.calculated.defenseClassLevel + bonuses.agility + context.calculated.situationalEvasion + context.calculated.armourEvasion;
    context.calculated.evasion = context.calculated.evasionBase + Number(combatMods.evasion ?? 0);
    context.calculated.accuracyMod = Number(system.combat?.accuracyMod ?? 0);
    context.calculated.accuracyBase = context.calculated.offenseClassLevel + bonuses.dexterity + context.calculated.accuracyMod;
    context.calculated.accuracy = context.calculated.accuracyBase + Number(combatMods.accuracy ?? 0);
    context.calculated.extraDamageBase = context.calculated.offenseClassLevel + bonuses.strength + Number(system.combat?.additionalDamage ?? 0);
    context.calculated.extraDamage = context.calculated.extraDamageBase + Number(combatMods.additionalDamage ?? 0);
    context.calculated.magicPowerBase = magicResolved.level + bonuses.intelligence;
    context.calculated.magicPower = context.calculated.magicPowerBase + Number(combatMods.magicPower ?? 0);
    // HP/MP maxima: the bound inputs keep the BASE value (DEC-28: modifiers
    // never overwrite the stored base); the effective value is exposed
    // separately for identification only. Both formulas come from
    // rules/resources.mjs; the modifiers from the shared effect ledger.
    context.calculated.hpMaxEffective = formulaHP + Number(resourceMods.hpMax ?? 0);
    context.calculated.mpMaxEffective = formulaMP + Number(resourceMods.mpMax ?? 0);

    // Effect-modifier badges (DEC-29 presentation): only non-zero modifiers
    // get a badge; the redundant signed label is prepared here.
    const effectBadge = mod => {
      const value = Number(mod ?? 0);
      if (!Number.isFinite(value) || value === 0) return null;
      return { label: value > 0 ? `+${value}` : `${value}`, cls: value > 0 ? "up" : "down" };
    };
    context.effectBadges = {
      fortitude: effectBadge(context.calculated.fortitude - context.calculated.fortitudeBase),
      willpower: effectBadge(context.calculated.willpower - context.calculated.willpowerBase),
      defense: effectBadge(context.calculated.defense - context.calculated.defenseBase),
      magicalDefense: effectBadge(context.calculated.magicalDefense - context.calculated.magicalDefenseBase),
      evasion: effectBadge(context.calculated.evasion - context.calculated.evasionBase),
      accuracy: effectBadge(context.calculated.accuracy - context.calculated.accuracyBase),
      extraDamage: effectBadge(context.calculated.extraDamage - context.calculated.extraDamageBase),
      magicPower: effectBadge(context.calculated.magicPower - context.calculated.magicPowerBase),
      initiative: effectBadge(context.calculated.initiative - context.calculated.initiativeBase),
      hpMax: effectBadge(context.calculated.hpMaxEffective - context.calculated.hpMax),
      mpMax: effectBadge(context.calculated.mpMaxEffective - context.calculated.mpMax),
      abilityDexterity: effectBadge(effectLedger.abilities?.dexterity ?? 0),
      abilityAgility: effectBadge(effectLedger.abilities?.agility ?? 0),
      abilityStrength: effectBadge(effectLedger.abilities?.strength ?? 0),
      abilityVitality: effectBadge(effectLedger.abilities?.vitality ?? 0),
      abilityIntelligence: effectBadge(effectLedger.abilities?.intelligence ?? 0),
      abilitySpirit: effectBadge(effectLedger.abilities?.spirit ?? 0)
    };
    for (const tab of context.classTabs) {
      const classItem = context.classes.find(item => `class-${item.id}` === tab.id);
      const nameKey = String(classItem?.name || "").trim().toLowerCase();
      tab.classId = classItem?.id || "";
      tab.classLevel = Number(classItem?.system.level ?? 0);
      tab.isWizard = String(classItem?.system?.classType || "").trim().toLowerCase() === "wizard";
      tab.magicPower = tab.classLevel + bonuses.intelligence;
      tab.isGeomancer = nameKey === "geomancer";
      tab.isAlchemist = nameKey === "alchemist";
      tab.isBard = nameKey === "bard";
      tab.isDarkHunter = nameKey === "dark hunter";
      tab.isTactician = nameKey === "tactician";
      tab.mentalPower = tab.classLevel + bonuses.spirit;
      if (tab.isAlchemist) {
        const colors = ["red", "green", "blue", "white", "gold"];
        const ranks = [["b", "B"], ["a", "A"], ["s", "S"], ["ss", "SS"]];
        tab.materialCardRows = colors.map(color => ({
          label: color[0].toUpperCase() + color.slice(1),
          cells: ranks.map(([rankKey, rankLabel]) => ({
            rankLabel,
            path: `system.classResources.alchemist.cards.${color}.${rankKey}`,
            value: Number(system.classResources?.alchemist?.cards?.[color]?.[rankKey] ?? 0)
          }))
        }));
      }
    }
    context.wizardClassTabs = context.classTabs.filter(tab => tab.isWizard);
    context.accessoryRows = [
      ["head","Head"],["face","Face"],["ears","Ears"],["neck","Neck"],["back","Back"],
      ["rightHand","Right Hand"],["leftHand","Left Hand"],["waist","Waist"],["feet","Feet"],["other","Other"]
    ].map(([key,label])=>({key,label,value:system.accessories?.[key] ?? ""}));

    const abilityBadge = key => effectBadge(effectLedger.abilities?.[letterAbility[key]] ?? 0);
    context.officialAbilities = [
      { group: "Skill", baseKey: "skill", base: Number(base.skill ?? 0), abilities: [
        { key: "a", name: "Dexterity", score: abilities.dexterity, scoreBase: abilities.dexterity - Number(effectLedger.abilities?.dexterity ?? 0), mod: Number(effectLedger.abilities?.dexterity ?? 0), effectBadge: abilityBadge("a"), bonus: bonuses.dexterity, growth: Number(adj.a?.growth ?? 0), correction: Number(adj.a?.correction ?? 0), temporary: Number(adj.a?.temporary ?? 0) },
        { key: "b", name: "Agility", score: abilities.agility, scoreBase: abilities.agility - Number(effectLedger.abilities?.agility ?? 0), mod: Number(effectLedger.abilities?.agility ?? 0), effectBadge: abilityBadge("b"), bonus: bonuses.agility, growth: Number(adj.b?.growth ?? 0), correction: Number(adj.b?.correction ?? 0), temporary: Number(adj.b?.temporary ?? 0) }
      ]},
      { group: "Body", baseKey: "body", base: Number(base.body ?? 0), abilities: [
        { key: "c", name: "Strength", score: abilities.strength, scoreBase: abilities.strength - Number(effectLedger.abilities?.strength ?? 0), mod: Number(effectLedger.abilities?.strength ?? 0), effectBadge: abilityBadge("c"), bonus: bonuses.strength, growth: Number(adj.c?.growth ?? 0), correction: Number(adj.c?.correction ?? 0), temporary: Number(adj.c?.temporary ?? 0) },
        { key: "d", name: "Vitality", score: abilities.vitality, scoreBase: abilities.vitality - Number(effectLedger.abilities?.vitality ?? 0), mod: Number(effectLedger.abilities?.vitality ?? 0), effectBadge: abilityBadge("d"), bonus: bonuses.vitality, growth: Number(adj.d?.growth ?? 0), correction: Number(adj.d?.correction ?? 0), temporary: Number(adj.d?.temporary ?? 0) }
      ]},
      { group: "Mind", baseKey: "mind", base: Number(base.mind ?? 0), abilities: [
        { key: "e", name: "Intelligence", score: abilities.intelligence, scoreBase: abilities.intelligence - Number(effectLedger.abilities?.intelligence ?? 0), mod: Number(effectLedger.abilities?.intelligence ?? 0), effectBadge: abilityBadge("e"), bonus: bonuses.intelligence, growth: Number(adj.e?.growth ?? 0), correction: Number(adj.e?.correction ?? 0), temporary: Number(adj.e?.temporary ?? 0) },
        { key: "f", name: "Spirit", score: abilities.spirit, scoreBase: abilities.spirit - Number(effectLedger.abilities?.spirit ?? 0), mod: Number(effectLedger.abilities?.spirit ?? 0), effectBadge: abilityBadge("f"), bonus: bonuses.spirit, growth: Number(adj.f?.growth ?? 0), correction: Number(adj.f?.correction ?? 0), temporary: Number(adj.f?.temporary ?? 0) }
      ]}
    ];

    const savedLanguages = Array.isArray(system.languages) ? system.languages : [];
    const languageCatalog = ["Trade Common","Dwarven","Elvish","Grassrunner","Regional Dialect","Magitech","Dragonic","Lykant","Sylvan","Ancient Celestial","Daemonic","Barbaric","Miakisian","Arcana","Shadow","Soleilian","Giantish","Drakish","Youma","Centaurian","Vulcan","Androscorpion","Lycanthrope","Lizardman"];
    context.languageCatalog = languageCatalog;
    const languageEntry = raw => {
      const cleaned = String(raw ?? "").replace(/\s*\((?:speak|read) only\)\s*/ig, "").trim();
      const canonical = languageCatalog.find(name => name.toLowerCase() === cleaned.toLowerCase()) || cleaned;
      const speakOnly = /speak only/i.test(String(raw)) || ["sylvan","daemonic","youma"].includes(canonical.toLowerCase());
      const readOnly = /read only/i.test(String(raw)) || canonical.toLowerCase() === "ancient celestial";
      return { name: canonical, talk: !readOnly, read: !speakOnly };
    };
    const importedText = String(context.race?.system.languages ?? "");
    const importedNames = languageCatalog.filter(name => {
      const pattern = new RegExp(`(?:^|[^A-Za-z])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z])`, "i");
      return pattern.test(importedText);
    });
    const languageOverride = Boolean(system.languagesInitialized);
    context.languages = languageOverride ? savedLanguages : importedNames.map(languageEntry);
    this._sheetLanguages = foundry.utils.deepClone(context.languages);
    context.consumables = [...context.equipment, ...context.weapons].filter(item => item.system.consumable);
    context.inventoryItems = [
      ...context.equipment,
      ...context.weapons.filter(item => item.system.inventoryPrimary !== false),
      ...context.armour
    ].filter(item => !item.system.consumable);
    const automaticFailures = Array.isArray(system.automaticFailures) ? system.automaticFailures : [];
    const legacyAutomaticFailureCount = automaticFailures.filter(Boolean).length;
    context.automaticFailureCount = automaticFailures.length
      ? Math.max(Number(system.automaticFailureCount ?? 0) || 0, legacyAutomaticFailureCount)
      : Number(system.automaticFailureCount ?? 0) || 0;
    const workSkills = Array.isArray(system.workSkills) ? system.workSkills : [];
    context.workSkills = workSkills.map((skill, skillIndex) => ({
      ...skill,
      skillIndex,
      expanded: this._expandedWorkSkills?.has(skill.id),
      checks: (Array.isArray(skill.checks) ? skill.checks : []).map((check, checkIndex) => ({
        ...check,
        checkIndex,
        expanded: this._expandedWorkChecks?.has(`${skill.id}:${check.id}`),
        abilityOptions: ["dexterity", "agility", "strength", "vitality", "intelligence", "spirit"].map(ability => ({
          value: ability,
          label: `${ability[0].toUpperCase() + ability.slice(1)} (${Number(bonuses[ability] ?? 0) >= 0 ? "+" : ""}${Number(bonuses[ability] ?? 0)})`,
          selected: ability === check.ability
        }))
      }))
    }));

    // Ordinary Skill Checks are built straight from the central catalogue:
    // every name, time, ability and association comes from
    // rules/skill-definitions.mjs; the class selection is resolved by
    // rules/skill-resolution.mjs. Combat checks (Monster Knowledge) render in
    // the combat panel instead of this list.
    const skillAbilityOrder = ["dexterity", "agility", "strength", "intelligence", "spirit"];
    const buildSkillEntry = def => {
      const resolved = resolveSkillClass({
        classes: context.classes,
        def,
        savedValue: system.skillClasses?.[def.key],
        workSkills,
        adventurerLevel: context.calculated.adventurerLevel
      });
      // When no class is selected the class-based result is zero (the ability
      // modifier alone is never added).
      const classLevelValue = resolved.classId ? resolved.level : 0;
      return {
        name: def.displayName ?? def.name,
        time: def.time,
        ability: def.ability,
        key: def.key,
        classId: resolved.classId,
        level: classLevelValue,
        mod: Number(bonuses[def.ability] ?? 0) + classLevelValue,
        options: resolved.options,
        restriction: (def.restrictions ?? []).join(" ")
      };
    };
    context.skillsByAbility = Object.fromEntries(skillAbilityOrder.map(ability => [
      ability,
      SKILL_DEFINITIONS.filter(def => def.ability === ability && !def.combat).map(buildSkillEntry)
    ]));

    this._sheetCalculated = context.calculated;

    // Effects tab (T1.5): read-only display data of the actor's persistent
    // `sw25Effect` documents, plus the GM-only repair control flag. All values
    // are prepared by module/effects/effects-tab.mjs (T1.3/T1.4 contracts);
    // nothing here writes and no repair runs implicitly on render.
    context.effectsTab = prepareSw25EffectsTab(this.actor, game.user.isGM === true);

    return context;
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find('[data-action="delete-weapon"]').on("click", this._onDeleteWeapon.bind(this));
    html.find('[data-action="roll-attack"]').on("click", this._onRollAttack.bind(this));

    // Effects tab (T1.5): individual inspection is read-only and available to
    // every user who can see the sheet; repair is GM-only and delegates every
    // document write to the T1.3 repair contract (no render-path writes).
    // Shared with the monster sheet's identical Effects section.
    wireSw25EffectsTabHandlers(this, html);

    const setActiveTab = tabName => {
      html.find(".tab-button").removeClass("active");
      html.find(".sheet-tab").removeClass("active");
      html.find(`.tab-button[data-tab="${tabName}"]`).addClass("active");
      html.find(`.sheet-tab[data-tab-panel="${tabName}"]`).addClass("active");
      this._activeTab = tabName;
    };

    setActiveTab(this._activeTab ?? "overview");

    html.find(".tab-button").on("click", event => {
      event.preventDefault();
      setActiveTab(event.currentTarget.dataset.tab);
    });

    html.find("[data-action='set-sheet-style']").on("change", async event => {
      event.preventDefault();
      let style = String(event.currentTarget.value || "light").toLowerCase();
      // Normalize legacy "paper" value to "light" before saving.
      if (style === "paper") style = "light";
      if (!["light", "light-red"].includes(style)) style = "light";
      await this.actor.setFlag("sw25-taka", "sheetStyle", style);
      this.render(false);
    });

    html.find("[data-action='rest']").on("click", async event => {
      event.preventDefault();
      const hours = Number(event.currentTarget.dataset.hours);
      if (![3, 6].includes(hours)) return;
      /* Effective maxima (persisted base + effect modifiers): recovery pools
         and clamps follow the capacity that is actually available right now. */
      const hpMax = sw25EffectiveResourceMaximum(this.actor, "hp");
      const mpMax = sw25EffectiveResourceMaximum(this.actor, "mp");
      const currentHP = Number(this.actor.system.hp?.value ?? 0);
      const currentMP = Number(this.actor.system.mp?.value ?? 0);
      const hpRecovered = Math.ceil(hpMax * (hours === 3 ? 0.1 : 0.2));
      const mpRecovered = hours === 3 ? Math.ceil(mpMax / 2) : mpMax;
      const nextHP = Math.min(hpMax, currentHP + hpRecovered);
      const nextMP = Math.min(mpMax, currentMP + mpRecovered);
      await this.actor.update({ "system.hp.value":nextHP, "system.mp.value":nextMP });
      ui.notifications.info(`${this.actor.name} completes a ${hours}-hour rest and recovers ${Math.max(0, nextHP - currentHP)} HP and ${Math.max(0, nextMP - currentMP)} MP.`);
    });

    html.find("[data-action='roll-death-check']").on("click", event => {
      event.preventDefault();
      return rollDeathCheck(this.actor);
    });

    html.find("[data-action='toggle-race']").on("click", event => {
      event.preventDefault();
      const panel = html.find(".race-character-panel");
      const expanded = panel.toggleClass("expanded").hasClass("expanded");
      panel.find("[data-action='toggle-race'] i").toggleClass("fa-chevron-right", !expanded).toggleClass("fa-chevron-down", expanded);
      this._raceExpanded = expanded;
    });

    html.find("[data-action='import-class-feature']").on("click", async event => {
      event.preventDefault();
      const button = event.currentTarget;
      await game.sw25.importer.openClassFeature(this.actor, {
        classId: button.dataset.classId,
        className: button.dataset.className,
        featureType: button.dataset.featureType,
        featureLabel: button.dataset.featureLabel,
        prefix: button.dataset.prefix
      });
    });

    html.find("[data-action='bulk-import-spells']").on("click", async event => {
      event.preventDefault();
      const button = event.currentTarget;
      await game.sw25.importer.openSpellList(this.actor, {
        classId:button.dataset.classId,
        className:button.dataset.className
      });
    });

    html.find("[data-action='add-class-feature-manually']").on("click", async event => {
      event.preventDefault();
      const button = event.currentTarget;
      await this._openManualClassFeatureDialog({
        classId: button.dataset.classId,
        className: button.dataset.className,
        featureType: button.dataset.featureType,
        featureLabel: button.dataset.featureLabel
      });
    });

    html.find("[data-action='increase-all-qi']").on("click", async event => {
      event.preventDefault();
      const qi = this.actor.system.classResources?.geomancer ?? {};
      await this.actor.update({
        "system.classResources.geomancer.heavenly": Number(qi.heavenly ?? 0) + 1,
        "system.classResources.geomancer.earthly": Number(qi.earthly ?? 0) + 1,
        "system.classResources.geomancer.spirit": Number(qi.spirit ?? 0) + 1
      });
    });

    html.find("[data-action='increase-edge']").on("click", async event => {
      event.preventDefault();
      const edge = Number(this.actor.system.classResources?.tactician?.edge ?? 0);
      await this.actor.update({ "system.classResources.tactician.edge": edge + 1 });
    });

    html.find("[data-action='increase-rhythm']").on("click", async event => {
      event.preventDefault();
      const rhythm = event.currentTarget.dataset.rhythm;
      if (!["uplifting", "calming", "enchanting"].includes(rhythm)) return;
      const current = Number(this.actor.system.classResources?.bard?.[rhythm] ?? 0);
      await this.actor.update({ [`system.classResources.bard.${rhythm}`]: current + 1 });
    });

    html.find("[data-action='reset-qi']").on("click", async event => {
      event.preventDefault();
      await this.actor.update({
        "system.classResources.geomancer.heavenly": 0,
        "system.classResources.geomancer.earthly": 0,
        "system.classResources.geomancer.spirit": 0
      });
    });

    html.find("[data-action='post-class-feature']").on("click", this._onPostClassFeature.bind(this));
    html.find("[data-action='toggle-spell-favourite']").on("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
      const spell = this.actor.items.get(itemId);
      if (!spell || spell.type !== "spell") return;
      await spell.update({ "system.favourite":!Boolean(spell.system.favourite) });
    });

    const clonedWorkSkills = () => foundry.utils.deepClone(Array.isArray(this.actor.system.workSkills) ? this.actor.system.workSkills : []);
    this._expandedWorkSkills ??= new Set();
    this._expandedWorkChecks ??= new Set();
    html.find("[data-action='add-work-skill']").on("click", async event => {
      event.preventDefault();
      const skills = clonedWorkSkills();
      skills.push({ id: foundry.utils.randomID(), name: "New Work Skill", level: 1, xp: 0, description: "", checks: [] });
      await this.actor.update({ "system.workSkills": skills });
    });
    html.find("[data-action='delete-work-skill']").on("click", async event => {
      event.preventDefault();
      const skills = clonedWorkSkills();
      skills.splice(Number(event.currentTarget.dataset.skillIndex), 1);
      await this.actor.update({ "system.workSkills": skills });
    });
    html.find("[data-action='edit-work-skill']").on("change", async event => {
      const skills = clonedWorkSkills();
      const skill = skills[Number(event.currentTarget.dataset.skillIndex)];
      if (!skill) return;
      const field = event.currentTarget.dataset.field;
      skill[field] = event.currentTarget.type === "number" ? Number(event.currentTarget.value || 0) : String(event.currentTarget.value || "");
      await this.actor.update({ "system.workSkills": skills });
    });
    html.find("[data-action='toggle-work-skill']").on("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const entry = event.currentTarget.closest(".work-skill-entry");
      const id = entry?.dataset.workSkillId;
      const expanded = entry?.classList.toggle("expanded");
      if (id) expanded ? this._expandedWorkSkills.add(id) : this._expandedWorkSkills.delete(id);
    });
    html.find("[data-action='add-work-check']").on("click", async event => {
      event.preventDefault();
      const skills = clonedWorkSkills();
      const skill = skills[Number(event.currentTarget.dataset.skillIndex)];
      if (!skill) return;
      if (!Array.isArray(skill.checks)) skill.checks = [];
      skill.checks.push({ id: foundry.utils.randomID(), name: "New Check", time: "Instant", ability: "intelligence", description: "" });
      await this.actor.update({ "system.workSkills": skills });
    });
    html.find("[data-action='delete-work-check']").on("click", async event => {
      event.preventDefault();
      const skills = clonedWorkSkills();
      const skill = skills[Number(event.currentTarget.dataset.skillIndex)];
      if (!skill?.checks) return;
      skill.checks.splice(Number(event.currentTarget.dataset.checkIndex), 1);
      await this.actor.update({ "system.workSkills": skills });
    });
    html.find("[data-action='edit-work-check']").on("change", async event => {
      const skills = clonedWorkSkills();
      const check = skills[Number(event.currentTarget.dataset.skillIndex)]?.checks?.[Number(event.currentTarget.dataset.checkIndex)];
      if (!check) return;
      check[event.currentTarget.dataset.field] = String(event.currentTarget.value || "");
      await this.actor.update({ "system.workSkills": skills });
    });
    html.find("[data-action='toggle-work-check']").on("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const entry = event.currentTarget.closest(".work-check-entry");
      const key = entry?.dataset.workCheckKey;
      const expanded = entry?.classList.toggle("expanded");
      if (key) expanded ? this._expandedWorkChecks.add(key) : this._expandedWorkChecks.delete(key);
    });
    html.find("[data-action='roll-work-check']").on("click", async event => {
      event.preventDefault();
      const skill = this.actor.system.workSkills?.[Number(event.currentTarget.dataset.skillIndex)];
      const check = skill?.checks?.[Number(event.currentTarget.dataset.checkIndex)];
      if (!skill || !check) return;
      const modifier = Number(skill.level ?? 0) + Number(this._sheetCalculated?.bonuses?.[check.ability] ?? 0);
      const roll = await new Roll(`2d6 + ${modifier}`).evaluate();
      const criticalFailure = isCriticalFailure(roll);
      await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: this.actor }), flavor: `${skill.name}: ${check.name} (${check.time || "Instant"})${criticalFailure ? criticalFailureHTML() + automaticFailureButton(this.actor) : ""}` });
    });

    html.find("[data-action='edit-language']").on("change", async event => {
      const index = Number(event.currentTarget.dataset.index);
      const field = event.currentTarget.dataset.field;
      const list = foundry.utils.deepClone(Array.isArray(this.actor.system.languages) ? this.actor.system.languages : []);
      if (!list[index]) return;
      list[index][field] = event.currentTarget.type === "checkbox" ? event.currentTarget.checked : String(event.currentTarget.value || "");
      await this.actor.update({"system.languages": list, "system.languagesInitialized": true});
    });

    html.find("[data-action='edit-automatic-failures']").on("change", async event => {
      const count = Math.max(0, Number(event.currentTarget.value) || 0);
      await this.actor.update({ "system.automaticFailureCount":count, "system.automaticFailures":[] });
    });

    html.find("[data-action='adjust-currency']").on("change", async event => {
      const field = event.currentTarget.dataset.currency;
      if (!["gamels", "debt"].includes(field)) return;
      const raw = String(event.currentTarget.value || "").trim().replace(/,/g, "");
      if (!/^[+-]?\d+$/.test(raw)) {
        event.currentTarget.value = "";
        return ui.notifications.warn("Enter a whole-number adjustment such as +100 or -100.");
      }
      const current = Number(this.actor.system.currency?.[field] ?? 0);
      await this.actor.update({ [`system.currency.${field}`]: current + Number(raw) });
      event.currentTarget.value = "";
    });

    html.find("[data-action='remove-language']").on("click", async event => {
      event.preventDefault();
      const index = Number(event.currentTarget.dataset.index);
      const stored = Array.isArray(this.actor.system.languages) && this.actor.system.languages.length
        ? this.actor.system.languages
        : (this._sheetLanguages ?? []);
      const list = foundry.utils.deepClone(stored);
      if (index < 0 || index >= list.length) return;
      list.splice(index, 1);
      await this.actor.update({"system.languages": list, "system.languagesInitialized": true});
    });

    html.find("[data-action='select-skill-class']").on("change", async event => {
      await this.actor.update({ [`system.skillClasses.${event.currentTarget.dataset.skillKey}`]: event.currentTarget.value });
    });

    html.find("[data-action='select-monster-knowledge-class']").on("change", async event => {
      // Picking any value (a class, or "—" = explicit none) pins it manually:
      // the automatic tick unticks (rendered from the stored value).
      await this.actor.update({ "system.combat.monsterKnowledgeClassId": event.currentTarget.value });
    });

    html.find("[data-action='toggle-monster-knowledge-auto']").on("change", async event => {
      const select = html.find("[data-action='select-monster-knowledge-class']");
      if (event.currentTarget.checked) {
        // Tick ON: automatic mode — the best currently valid class is derived
        // immediately on the next render (stored as absent, "").
        await this.actor.update({ "system.combat.monsterKnowledgeClassId": "" });
      } else {
        // Tick OFF: pin the class currently shown by the automatic assignment.
        const current = select?.val() ?? "none";
        await this.actor.update({ "system.combat.monsterKnowledgeClassId": current });
      }
    });

    html.find("[data-action='select-defense-class']").on("change", async event => this.actor.update({"system.combat.defenseClassId":event.currentTarget.value}));
    html.find("[data-action='select-initiative-class']").on("change", async event => this.actor.update({"system.combat.initiativeClassId":event.currentTarget.value}));
    html.find("[data-action='select-offense-class']").on("change", async event => this.actor.update({"system.combat.offenseClassId":event.currentTarget.value}));
    html.find("[data-action='select-magic-class']").on("change", async event => this.actor.update({"system.combat.magicClassId":event.currentTarget.value}));

    html.find("[data-action='add-class']").on("click", async event => { event.preventDefault(); await this._openAddClassDialog(); });
    html.find("[data-action='import-accessory']").on("click", async event => {
      event.preventDefault();
      await game.sw25.importer.importUrl("http://sw25.wikidot.com/items:accessories", this.actor);
    });
    html.find("[data-action='add-inventory']").on("click", async event => { event.preventDefault(); await this._openAddInventoryDialog(); });
    html.find("[data-action='add-language']").on("click", async event => { event.preventDefault(); await this._openAddLanguageDialog(); });
    html.find("[data-action='add-armour']").on("click", async event => { event.preventDefault(); await this._openArmourDialog(); });
    html.find("[data-action='toggle-armour']").on("click", event => { event.preventDefault(); $(event.currentTarget).closest('.armour-entry').toggleClass('expanded'); });
    html.find("[data-action='toggle-armour-equipped']").on("change", async event => {
      const itemId = event.currentTarget.closest('.armour-entry')?.dataset.itemId;
      const item = this.actor.items.get(itemId);
      if (!item) return;
      await item.update({"system.equipped": event.currentTarget.checked});
    });
    html.find("[data-action='toggle-weapon-mods']").on("change", async event => {
      const itemId = event.currentTarget.closest('.combat-weapon-row')?.dataset.itemId;
      const item = this.actor.items.get(itemId);
      if (!item) return;
      await item.update({"system.modsEnabled": event.currentTarget.checked === true});
    });
    html.find("[data-action='delete-armour']").on("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const itemId = event.currentTarget.closest('.armour-entry')?.dataset.itemId;
      const item = this.actor.items.get(itemId);
      if (!item) return;
      const confirmed = await Dialog.confirm({
        title: "Delete Armour",
        content: `<p>Delete <strong>${foundry.utils.escapeHTML(item.name)}</strong>?</p>`
      });
      if (confirmed) await item.delete();
    });
    html.find("[data-action='add-weapon']").on("click", async event => { event.preventDefault(); await this._openWeaponDialog(); });
    html.find("[data-action='add-feat']").on("click", async event => { event.preventDefault(); await this._openFeatDialog(); });
    html.find("[data-action='add-additional']").on("click", async event => { event.preventDefault(); await this._openAdditionalDialog(); });
    html.find("[data-action='import-race']").on("click", async event => { event.preventDefault(); await this._openRaceImportDialog(); });
    html.find("[data-action='edit-race-name']").on("change", async event => {
      const name = String(event.currentTarget.value || "").trim();
      const race = [...this.actor.items].find(i => i.type === "race");
      if (race) await race.update({name});
      else if (name) await this.actor.createEmbeddedDocuments("Item", [{name,type:"race"}]);
    });
    html.find("[data-direct-path]").on("change", async event => {
      const path = event.currentTarget.dataset.directPath;
      let value = event.currentTarget.value;
      if (event.currentTarget.type === "number") value = Number(value || 0);
      await this.actor.update({[path]: value});
    });
    html.find("[data-action='toggle-feat']").on("click", event => event.currentTarget.closest(".feat-entry")?.classList.toggle("expanded"));

    html.find("[data-action='post-item']").on("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
      const item = this.actor.items.get(itemId);
      if (!item) return;
      const escape = value => foundry.utils.escapeHTML(String(value ?? "")).replace(/\n/g, "<br>");
      const description = item.system.summary || item.system.description || item.system.notes || "";
      const featDetails = item.type === "feat"
        ? `<p><strong>Prerequisite:</strong> ${escape(item.system.prerequisite || "—")} &nbsp; <strong>Use:</strong> ${escape(item.system.use || "—")}</p>`
        : `<p><strong>Type:</strong> ${escape(item.type)} &nbsp; <strong>Quantity:</strong> ${Math.max(0, Number(item.system.quantity ?? 1))}</p>`;
      const recoveryControls = recoveryPowerTableHTML(item, this.actor);
      await ChatMessage.create({
        speaker:ChatMessage.getSpeaker({ actor:this.actor }),
        content:`<div class="sw25-chat-card"><h3>${escape(item.name)}</h3>${featDetails}${description ? `<p>${escape(description)}</p>` : ""}${recoveryControls}</div>`
      });
    });

    html.find("[data-action='edit-class-level']").on("change", async event => {
      const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
      const item = this.actor.items.get(itemId);
      if (item) await item.update({"system.level": Number(event.currentTarget.value || 0)});
    });

    html.find("[data-action='delete-class']").on("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
      const item = this.actor.items.get(itemId);
      if (!item || item.type !== "class") return;
      const confirmed = await Dialog.confirm({
        title:"Delete Class",
        content:`<p>Delete <strong>${foundry.utils.escapeHTML(item.name)}</strong>?</p>`
      });
      if (confirmed) await item.delete();
    });

    html.find("[data-action='edit-item']").on("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
      this.actor.items.get(itemId)?.sheet.render(true);
    });

    html.find("[data-action='roll-skill']").on("click", async event => {
      event.preventDefault();
      const modifier = Number(event.currentTarget.dataset.mod ?? 0);
      const skillName = event.currentTarget.closest(".skill-line")?.querySelector(".skill-name-roll")?.textContent?.trim() || "Skill";
      const roll = await new Roll(`2d6 + ${modifier}`).evaluate();
      const criticalFailure = isCriticalFailure(roll);
      await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: this.actor }), flavor: `${skillName} Check${criticalFailure ? criticalFailureHTML() + automaticFailureButton(this.actor) : ""}` });
    });

    html.find("[data-action='roll-check']").on("click", async event => {
      event.preventDefault();
      const check = event.currentTarget.dataset.check;
      if (check === "monsterKnowledge") {
        const targetList = [...(game.user.targets || [])];
        const targetMonster = targetList.length === 1
          ? (targetList[0]?.actor ?? targetList[0]?.document?.actor ?? null)
          : null;
        await rollMonsterKnowledge({ actor: this.actor, targetMonster, shiftKey: event.shiftKey });
        return;
      }
      const labels = {
        accuracy: "Accuracy Check",
        evasion: "Evasion Check",
        initiative: "Initiative Check",
        magicPower: "Magic Power Check",
        fortitude: "Fortitude Check",
        willpower: "Willpower Check"
      };
      const dynamic = {
        initiative: this._sheetCalculated?.initiative,
        fortitude: this._sheetCalculated?.fortitude, willpower: this._sheetCalculated?.willpower,
        evasion: this._sheetCalculated?.evasion, accuracy: this._sheetCalculated?.accuracy, magicPower: this._sheetCalculated?.magicPower
      };
      const modifier = Number(dynamic[check] ?? this.actor.system.combat?.[check] ?? 0);
      const roll = await new Roll(`2d6 + ${modifier}`).evaluate();
      // Initiative is purely numeric: no Automatic Success/Failure detection,
      // no consequences and no Automatic Failure registration. Every other
      // 2d6 check detects the natural double 1 and offers the player the
      // registration button (the detection never writes the counter itself).
      const criticalFailure = check === "initiative" ? false : isCriticalFailure(roll);
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        flavor: `${labels[check] ?? "Check"}${criticalFailure ? criticalFailureHTML() + automaticFailureButton(this.actor) : ""}`
      });
      if (check === "magicPower") await rememberMagicPowerRoll(this.actor, roll, this.actor.system.combat?.magicClassId || "");
      if (check === "initiative") await recordPlayerInitiative(this.actor, roll.total);
    });

    html.find("[data-action='roll-class-magic-power']").on("click", async event => {
      event.preventDefault();
      const classItem = this.actor.items.get(event.currentTarget.dataset.classId);
      if (!classItem) return ui.notifications.warn("The casting class could not be found.");
      // Effective Magic Power (DEC-28): effective Intelligence bonus (already
      // ledger-aware) plus the prepared combat.magicPower ledger entry.
      const modifier = this._classLevel(classItem) + abilityBonus(this.actor.system, "intelligence")
        + sw25EffectModifier(this.actor, "combat.magicPower");
      const roll = await new Roll(`2d6 + ${modifier}`).evaluate();
      const criticalFailure = isCriticalFailure(roll);
      await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: this.actor }), flavor: `${classItem.name} Magic Power${criticalFailure ? criticalFailureHTML() + automaticFailureButton(this.actor) : ""}` });
      await rememberMagicPowerRoll(this.actor, roll, classItem.id);
    });

    html.find("[data-action='cast-spell']").on("click", async event => {
      event.preventDefault();
      const spell = this.actor.items.get(event.currentTarget.closest("[data-item-id]")?.dataset.itemId);
      if (!spell) return;
      // The full Major Action flow lives in rules/spell-cast.mjs: one shared
      // implementation of validation, MP deduction before the roll, the
      // Spellcasting check, the Success Value, per-target resistances, cast-
      // time effect creation and the independent Power Table damage. Sheets
      // never reimplement it.
      await castSpellAsMajor({ actor: this.actor, spell, applyCost: this.isEditable });
    });

    html.find("[data-action='cast-spell-minor']").on("click", async event => {
      event.preventDefault();
      const spell = this.actor.items.get(event.currentTarget.closest("[data-item-id]")?.dataset.itemId);
      if (!spell) return;
      // Minor Action (⏩): a SEPARATE flow — no Spellcasting check, SV 0,
      // castable repeatedly, MP per cast (CR1 p. 174).
      await castSpellAsMinor({ actor: this.actor, spell, applyCost: this.isEditable });
    });

    html.find("[data-action='cast-spell-prep']").on("click", async event => {
      event.preventDefault();
      const spell = this.actor.items.get(event.currentTarget.closest("[data-item-id]")?.dataset.itemId);
      if (!spell) return;
      // Combat Preparation (△): a SEPARATE flow — no Spellcasting check,
      // SV 0, once per name during the preparation (CR1 p. 175).
      await castSpellInCombatPreparation({ actor: this.actor, spell, applyCost: this.isEditable });
    });

    html.find("[data-action='cast-spell-legacy']").on("click", async event => {
      event.preventDefault();
      // Legacy cast entry point (no template writes this action anymore, but
      // external macros or modules may still trigger it). It is an alias of
      // the SAME centralized Major Action flow: no duplicated casting logic.
      const spell = this.actor.items.get(event.currentTarget.closest("[data-item-id]")?.dataset.itemId);
      if (!spell) return;
      await castSpellAsMajor({ actor: this.actor, spell, applyCost: this.isEditable });
    });

    if (!this.isEditable) return;

    html.find("[data-action='set-soulscars']").on("click", async event => {
      event.preventDefault();
      const selected = Number(event.currentTarget.dataset.value);
      const current = Number(this.actor.system.soulscars ?? 0);
      const next = selected === current ? selected - 1 : selected;
      await this.actor.update({ "system.soulscars": Math.max(0, next) });
    });

    html.find("[data-action='create-item']").on("click", async event => {
      event.preventDefault();
      const type = event.currentTarget.dataset.type;
      const source = event.currentTarget.dataset.source;
      const labels = {
        class: "Class", feat: "Feat", ability: "Ability", weapon: "Weapon",
        armour: "Armour", skill: "Skill", spell: "Spell", equipment: "Equipment"
      };
      const data = { name: `New ${labels[type] ?? "Item"}`, type };
      if (type === "ability" && source) data.system = { source };
      const [item] = await this.actor.createEmbeddedDocuments("Item", [data]);
      item?.sheet.render(true);
    });

    html.find("[data-action='delete-item']").on("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const itemId = event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
      const item = this.actor.items.get(itemId);
      if (!item) return;
      const confirmed = await Dialog.confirm({
        title: `Delete ${item.name}?`,
        content: `<p>Delete <strong>${item.name}</strong> from this character?</p>`
      });
      if (confirmed) await item.delete();
    });
  }

  async _openAddClassDialog() {
    const content = `<form><div class="form-group"><label>Name</label><input name="name"></div><div class="form-group"><label>Cost Type</label><select name="category"><option>A</option><option>B</option></select></div><div class="form-group"><label>Class Type</label><select name="classType"><option>Warrior</option><option>Wizard</option><option>Other</option></select></div><div class="form-group"><label>Level</label><input type="number" name="level" value="1" min="0"></div><hr><div class="form-group"><label>Import URL</label><input name="url" placeholder="http://sw25.wikidot.com/class:artificer"></div></form>`;
    new Dialog({title:"Add Class",content,buttons:{manual:{label:"Add Manually",callback:async h=>{await this.actor.createEmbeddedDocuments("Item",[{name:String(h.find('[name=name]').val()||'New Class'),type:'class',system:{category:h.find('[name=category]').val(),classType:h.find('[name=classType]').val(),level:Number(h.find('[name=level]').val()||1)}}]);}},import:{label:"Import Link",callback:async h=>{const url=String(h.find('[name=url]').val()||'').trim(); if(url) await game.sw25.importer.importUrl(url,this.actor);}}}}).render(true);
  }

  async _openAddInventoryDialog() {
    const content=`<form><div class="form-group"><label>Name</label><input name="name"></div><div class="form-group"><label>Type</label><select name="type"><option value="weapon">Weapon</option><option value="armour">Armour</option><option value="equipment" selected>Equipment</option></select></div><div class="form-group"><label>Quantity</label><input type="number" name="quantity" value="1" min="1"></div><label><input type="checkbox" name="consumable"> Consumable</label><hr><div class="form-group"><label>Import URL</label><input name="url" placeholder="http://sw25.wikidot.com/items:adventure-tools"></div></form>`;
    new Dialog({title:"Add Inventory Item",content,buttons:{manual:{label:"Add Manually",callback:async h=>{const type=h.find('[name=type]').val(); await this.actor.createEmbeddedDocuments("Item",[{name:String(h.find('[name=name]').val()||'New Item'),type,system:{quantity:Number(h.find('[name=quantity]').val()||1),consumable:h.find('[name=consumable]').is(':checked')}}]);}},import:{label:"Import Link",callback:async h=>{const url=String(h.find('[name=url]').val()||'').trim(); if(url){try{await game.sw25.importer.importUrl(url,this.actor);}catch(e){ui.notifications.warn('Item-page importing will be fleshed out next; add this item manually for now.');}}}}}}).render(true);
  }

  async _openAddLanguageDialog() {
    const languages = ["Trade Common","Dwarven","Elvish","Grassrunner","Regional Dialect","Magitech","Dragonic","Lykant","Sylvan","Ancient Celestial","Daemonic","Barbaric","Miakisian","Arcana","Shadow","Soleilian","Giantish","Drakish","Youma","Centaurian","Vulcan","Androscorpion","Lycanthrope","Lizardman"];
    const options = languages.map(name => `<option value="${name}">${name}</option>`).join("");
    const content=`<form><div class="form-group"><label>Language</label><select name="name">${options}</select></div><label><input type="checkbox" name="talk" checked> Talk</label><label><input type="checkbox" name="read" checked> Read</label></form>`;
    new Dialog({title:"Add Language",content,buttons:{add:{label:"Add",callback:async h=>{const list=Array.isArray(this.actor.system.languages)?foundry.utils.deepClone(this.actor.system.languages):[]; const name=String(h.find('[name=name]').val()||'Trade Common'); const speakOnly=["Sylvan","Daemonic","Youma"].includes(name); const readOnly=name==="Ancient Celestial"; list.push({name,talk:readOnly?false:h.find('[name=talk]').is(':checked'),read:speakOnly?false:h.find('[name=read]').is(':checked')}); await this.actor.update({'system.languages':list,'system.languagesInitialized':true});}}}}).render(true);
  }

  async _openSimpleItemDialog(type,label,example) {
    const content=`<form><div class="form-group"><label>${label} Name</label><input name="name"></div><div class="form-group"><label>Import URL</label><input name="url" placeholder="${example}"></div></form>`;
    new Dialog({title:`Add ${label}`,content,buttons:{manual:{label:"Add Manually",callback:async h=>this.actor.createEmbeddedDocuments('Item',[{name:String(h.find('[name=name]').val()||`New ${label}`),type}])},import:{label:"Import Link",callback:async h=>{const url=String(h.find('[name=url]').val()||'').trim(); if(url){try{await game.sw25.importer.importUrl(url,this.actor);}catch(e){ui.notifications.warn(`${label} importing will be fleshed out later; add it manually for now.`);}}}}}}).render(true);
  }


  async _onDeleteWeapon(event) {
    event.preventDefault();
    event.stopPropagation();

    const itemId =
      event.currentTarget.closest("[data-item-id]")?.dataset.itemId;
    const weapon = this.actor.items.get(itemId);
    if (!weapon || weapon.type !== "weapon") return;

    const confirmed = await Dialog.confirm({
      title: `Delete ${weapon.name}?`,
      content:
        `<p>Delete <strong>${foundry.utils.escapeHTML(weapon.name)}</strong> ` +
        `from ${foundry.utils.escapeHTML(this.actor.name)}?</p>` +
        `<p>This removes only this character's copy of the weapon.</p>`
    });

    if (confirmed) {
      await weapon.delete();
      ui.notifications.info(`${weapon.name} was deleted.`);
    }
  }

  _abilityModifier(key) {
    return abilityBonus(this.actor.system, key === "int" ? "intelligence" : "strength");
  }

  _classLevel(item) {
    return Number(
      item?.system?.level ??
      item?.system?.classLevel ??
      item?.system?.value ??
      0
    ) || 0;
  }

  _warriorClasses() {
    return this.actor.items.filter(isWarriorClass);
  }

  _hasFeat(featName) {
    const key = value => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    const target = key(featName);
    return (this.actor.items.filter(item => item.type === "feat") ?? []).some(item => key(item.name) === target);
  }

  _artificerClass() {
    return this.actor.items.find(item =>
      item.type === "class" &&
      /^(artificer|マギテック)$/i.test(item.name.trim())
    );
  }

  async _openManualClassFeatureDialog(options = {}) {
    const label = options.featureLabel || "Class Feature";
    const isSpell = options.featureType === "spell";
    const content = `<form><div class="form-group"><label>Name</label><input name="name" autofocus></div><div class="form-group"><label>Requirement</label><input name="requirement"></div><div class="form-group"><label>Cost</label><input name="cost" placeholder="${isSpell ? "MP 0" : "None"}"></div>${isSpell ? '<div class="form-group"><label>MP Cost</label><input type="number" name="mpCost" value="0" min="0"></div>' : ""}<div class="form-group"><label>Imported Details / Statistics</label><textarea name="metadata"></textarea></div><div class="form-group"><label>Effect</label><textarea name="description"></textarea></div></form>`;
    return new Promise(resolve => new Dialog({
      title: `Add ${label}`,
      content,
      buttons: {
        add: {
          label: `Add ${label}`,
          callback: async html => {
            const name = String(html.find('[name="name"]').val() || `New ${label}`).trim();
            const cost = String(html.find('[name="cost"]').val() || "").trim();
            const system = {
              source: "class", classId: options.classId || "", className: options.className || "",
              featureType: options.featureType || "ability", requirement: String(html.find('[name="requirement"]').val() || ""),
              cost, mpCost: isSpell ? Number(html.find('[name="mpCost"]').val() || 0) : 0,
              school: options.className || "", metadata: String(html.find('[name="metadata"]').val() || ""),
              description: String(html.find('[name="description"]').val() || ""), sourceUrl: ""
            };
            const [item] = await this.actor.createEmbeddedDocuments("Item", [{ name, type: isSpell ? "spell" : "ability", system }]);
            resolve(item);
          }
        },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      }, default: "add", close: () => resolve(null)
    }).render(true));
  }

  async _onPostClassFeature(event) {
    event.preventDefault();
    const item = this.actor.items.get(event.currentTarget.closest("[data-item-id]")?.dataset.itemId);
    if (!item) return;
    const featureType = String(item.system.featureType || "ability").toLowerCase();
    const storedResources = item.system.resourceData ?? {};
    const metadata = String(item.system.metadata || "");
    const labelled = label => metadata.match(new RegExp(`(?:^|\\n)${label}:\\s*([^\\n]+)`, "i"))?.[1]?.trim() || "";
    const rhythmValues = value => ({
      uplifting: Number(String(value).match(/⮭\s*(\d+)/)?.[1] || 0),
      calming: Number(String(value).match(/⮯\s*(\d+)/)?.[1] || 0),
      enchanting: Number(String(value).match(/♡\s*(\d+)/)?.[1] || 0)
    });
    const costText = String(item.system.cost || "");
    const qiMatch = costText.match(/^(Heavenly|Earthly|Spirit)\s+Qi\s+(\d+)(?:\s*-\s*(\d+))?/i);
    const cardsText = labelled("Cards?") || costText;
    const resources = {
      ...storedResources,
      baseRhythm: storedResources.baseRhythm ?? rhythmValues(labelled("Base Rhythm")),
      rhythmCost: storedResources.rhythmCost ?? rhythmValues(labelled("Rhythm Cost") || costText),
      qiType: storedResources.qiType || String(qiMatch?.[1] || "").toLowerCase(),
      qiMin: Number(storedResources.qiMin ?? qiMatch?.[2] ?? 0),
      qiMax: Number(storedResources.qiMax ?? qiMatch?.[3] ?? qiMatch?.[2] ?? 0),
      hpCost: storedResources.hpCost || (/^\s*(?:\d+d|\d+)\s*HP\s*$/i.test(costText) ? costText.replace(/\s*HP\s*$/i, "") : ""),
      cardCount: Number(storedResources.cardCount ?? cardsText.match(/x\s*(\d+)/i)?.[1] ?? 1),
      suggestedCardColor: storedResources.suggestedCardColor || String(cardsText.match(/Red|Green|Blue|White|Gold/i)?.[0] || "").toLowerCase(),
      edgeAccumulation: Number(storedResources.edgeAccumulation ?? labelled("Edge Accumulation").match(/[+-]?\d+/)?.[0] ?? 0),
      edgeCost: Number(storedResources.edgeCost ?? labelled("Edge Cost").match(/\d+/)?.[0] ?? 0)
    };
    const updates = {};
    const notices = [];

    if (featureType === "aspect") {
      const qiType = String(resources.qiType || "").toLowerCase();
      const min = Number(resources.qiMin ?? 0);
      const max = Number(resources.qiMax ?? min);
      if (qiType && max > 0) {
        let amount = min;
        if (max > min) {
          amount = await new Promise(resolve => new Dialog({
            title: `${item.name}: Qi Cost`,
            content: `<form><div class="form-group"><label>${qiType[0].toUpperCase() + qiType.slice(1)} Qi (${min}-${max})</label><input type="number" name="amount" value="${min}" min="${min}" max="${max}"></div></form>`,
            buttons: {
              use: { label: "Use Aspect", callback: html => resolve(Math.min(max, Math.max(min, Number(html.find('[name="amount"]').val()) || min))) },
              cancel: { label: "Cancel", callback: () => resolve(null) }
            },
            default: "use", close: () => resolve(null)
          }).render(true));
          if (amount === null) return;
        }
        const current = Number(this.actor.system.classResources?.geomancer?.[qiType] ?? 0);
        if (current < amount) return ui.notifications.warn(`Not enough ${qiType} Qi to use ${item.name}.`);
        updates[`system.classResources.geomancer.${qiType}`] = current - amount;
        notices.push(`${amount} ${qiType[0].toUpperCase() + qiType.slice(1)} Qi spent`);
      }
    }

    if (featureType === "evocation") {
      const count = Math.max(1, Number(resources.cardCount ?? 1));
      const suggested = String(resources.suggestedCardColor || "green");
      const selection = await new Promise(resolve => new Dialog({
        title: `${item.name}: Material Card`,
        content: `<form><div class="form-group"><label>Colour</label><select name="colour">${["red","green","blue","white","gold"].map(color => `<option value="${color}" ${color === suggested ? "selected" : ""}>${color[0].toUpperCase() + color.slice(1)}</option>`).join("")}</select></div><div class="form-group"><label>Rank</label><select name="rank"><option value="b">B-Rank</option><option value="a">A-Rank</option><option value="s">S-Rank</option><option value="ss">SS-Rank</option></select></div><p>${count} card${count === 1 ? "" : "s"} will be spent.</p></form>`,
        buttons: {
          use: { label: "Use Evocation", callback: html => resolve({ colour: String(html.find('[name="colour"]').val()), rank: String(html.find('[name="rank"]').val()) }) },
          cancel: { label: "Cancel", callback: () => resolve(null) }
        }, default: "use", close: () => resolve(null)
      }).render(true));
      if (!selection) return;
      const current = Number(this.actor.system.classResources?.alchemist?.cards?.[selection.colour]?.[selection.rank] ?? 0);
      if (current < count) return ui.notifications.warn(`Not enough ${selection.colour} ${selection.rank.toUpperCase()}-Rank cards.`);
      updates[`system.classResources.alchemist.cards.${selection.colour}.${selection.rank}`] = current - count;
      notices.push(`${count} ${selection.colour[0].toUpperCase() + selection.colour.slice(1)} ${selection.rank.toUpperCase()}-Rank card${count === 1 ? "" : "s"} spent`);
    }

    if (featureType === "spellsong" || featureType === "finale") {
      const source = featureType === "spellsong" ? resources.baseRhythm : resources.rhythmCost;
      const rhythm = this.actor.system.classResources?.bard ?? {};
      const labels = { uplifting: "Uplifting", calming: "Calming", enchanting: "Enchanting" };
      const symbols = { uplifting: "⮭", calming: "⮯", enchanting: "♡" };
      for (const key of Object.keys(labels)) {
        const amount = Number(source?.[key] ?? 0);
        if (!amount) continue;
        const current = Number(rhythm[key] ?? 0);
        if (featureType === "finale" && current < amount) return ui.notifications.warn(`Not enough ${labels[key]} Rhythm for ${item.name}.`);
        updates[`system.classResources.bard.${key}`] = featureType === "spellsong" ? current + amount : current - amount;
        notices.push(`${symbols[key]}${amount} ${featureType === "spellsong" ? "gained" : "spent"}`);
      }
    }

    if (featureType === "weaving" && resources.hpCost) {
      const costText = String(resources.hpCost).toLowerCase();
      const rollFormula = /^\d+d$/i.test(costText) ? `${costText}6` : costText;
      const hpRoll = /d/.test(costText) ? await new Roll(rollFormula).evaluate() : null;
      const hpCost = hpRoll ? Number(hpRoll.total ?? 0) : Number(costText) || 0;
      const currentHP = Number(this.actor.system.hp?.value ?? 0);
      updates["system.hp.value"] = currentHP - hpCost;
      notices.push(`${hpCost} HP spent${hpRoll ? ` (${costText})` : ""}`);
    }

    if (featureType === "technique") {
      const currentMP = Number(this.actor.system.mp?.value ?? 0);
      if (currentMP < 3) return ui.notifications.warn(`Not enough MP to use ${item.name}.`);
      updates["system.mp.value"] = currentMP - 3;
      notices.push("3 MP spent");
    }

    if (featureType === "stratagem" || featureType === "maneuver") {
      const current = Number(this.actor.system.classResources?.tactician?.edge ?? 0);
      const gain = featureType === "stratagem" ? Number(resources.edgeAccumulation ?? 0) : 0;
      const cost = featureType === "maneuver" ? Number(resources.edgeCost ?? 0) : 0;
      if (current < cost) return ui.notifications.warn(`Not enough Edge to use ${item.name}.`);
      updates["system.classResources.tactician.edge"] = current - cost + gain;
      if (gain) notices.push(`${gain} Edge gained`);
      if (cost) notices.push(`${cost} Edge spent`);
    }

    if (Object.keys(updates).length) await this.actor.update(updates);
    const escape = value => foundry.utils.escapeHTML(String(value || "")).replace(/\n/g, "<br>");
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: `<div class="sw25-chat-card class-feature-card"><h3>${escape(item.name)}</h3>${item.system.metadata ? `<p>${escape(item.system.metadata)}</p>` : ""}${item.system.description ? `<p>${escape(item.system.description)}</p>` : ""}${notices.length ? `<p><em>${escape(notices.join("; "))}.</em></p>` : ""}</div>`
    });
  }

  async _onRollAttack(event) {
    event.preventDefault();
    event.stopPropagation();
    const row = event.currentTarget.closest("[data-item-id]");
    const weapon = this.actor.items.get(row?.dataset.itemId);
    if (!weapon) return;
    if (isGunWeapon(weapon)) {
      ui.notifications.info(`${weapon.name} damage is rolled through its bullet spell.`);
      return;
    }

    const attackingClass = resolveAttackingClass(this.actor, weapon);
    if (!attackingClass) {
      const requirement = isGunWeapon(weapon) ? "an Artificer class" : "a selected warrior-type Attacking Class";
      ui.notifications.warn(`${weapon.name} requires ${requirement}.`);
      return;
    }

    // Resolver target usando el sistema de attack-resolution (usa game.user.targets)
    const targetResult = resolveAttackTarget({
      targets: game.user?.targets ?? [],
      controlled: [...(canvas?.tokens?.controlled || [])]
    });

    if (targetResult.status !== "ok") {
      ui.notifications.warn(describeTargetFailure(targetResult.status, "monster"));
      return;
    }

    const targetMonster = targetResult.actor;
    if (targetMonster.type !== "monster") {
      ui.notifications.warn("The attack target must be a monster.");
      return;
    }

    // Construir partes de Accuracy desde los valores del personaje
    const baseAccuracy = this._sheetCalculated?.accuracy ?? 0;
    const weaponAccuracy = Number(weapon.system?.accuracy ?? 0);
    // Active system effects (DEC-28): the prepared ledger's Accuracy entry
    // joins the roll as its own visible part, so the total agrees with the
    // effective Accuracy displayed on the sheet.
    const effectAccuracy = sw25EffectModifier(this.actor, "combat.accuracy");

    const accuracyParts = [
      { label: "Class level", value: Number(attackingClass?.system?.level ?? 0), enabled: true, temporary: false },
      { label: "Dexterity bonus", value: abilityBonus(this.actor.system, "dexterity"), enabled: true, temporary: false },
      { label: "Accuracy Mod", value: Number(this.actor.system.combat?.accuracyMod ?? 0), enabled: true, temporary: false },
      { label: "Weapon Accuracy", value: weaponAccuracy, enabled: true, temporary: false },
      { label: "Effects", value: effectAccuracy, enabled: effectAccuracy !== 0, temporary: false }
    ];

    // Shift+click opens the modifier dialog; normal click uses modsEnabled toggle
    const promptModifiers = event.shiftKey
      ? openRollModifiersDialog
      : (weapon.system?.modsEnabled === true
        ? openRollModifiersDialog
        : modifiersConfig => modifiersConfig.parts);

    const result = await characterWeaponAttackFlow({
      actor: this.actor,
      weapon,
      attackingClass,
      accuracyParts,
      targetMonster,
      promptModifiers
    });

    if (result.status === "cancelled") return;
    if (result.status === "no-defense") {
      ui.notifications.warn("The target monster has no usable Evasion value.");
      return;
    }
    if (result.status === "invalid-target") {
      ui.notifications.warn("Invalid attack target.");
      return;
    }
  }

  async _openFeatDialog() {
    const content = `<form>
      <div class="form-group"><label>Title</label><input name="name"></div>
      <div class="form-group"><label>Prerequisite</label><input name="prerequisite" placeholder="None"></div>
      <div class="form-group"><label>Use</label><input name="use" placeholder="Shield"></div>
      <div class="form-group"><label>Summary</label><textarea name="summary"></textarea></div>
      <hr>
      <div class="form-group"><label>Import URL</label><input name="url" placeholder="http://sw25.wikidot.com/feat:dodge"></div>
    </form>`;

    new Dialog({
      title: "Add Combat Feat",
      content,
      buttons: {
        manual: {
          label: "Add Manually",
          callback: async html => {
            const summary = String(html.find('[name="summary"]').val() || "");
            await this.actor.createEmbeddedDocuments("Item", [{
              name: String(html.find('[name="name"]').val() || "New Feat"),
              type: "feat",
              system: {
                category: "combat",
                prerequisite: String(html.find('[name="prerequisite"]').val() || "None"),
                use: String(html.find('[name="use"]').val() || ""),
                summary,
                description: summary
              }
            }]);
          }
        },
        import: {
          label: "Import Link",
          callback: async html => {
            const url = String(html.find('[name="url"]').val() || "").trim();
            if (url) await game.sw25.importer.importUrl(url, this.actor);
          }
        }
      },
      default: "import"
    }).render(true);
  }

  async _openRaceImportDialog() {
    const content = `<form><div class="form-group"><label>Race URL</label><input name="url" placeholder="http://sw25.wikidot.com/race:tabbit"></div></form>`;
    new Dialog({title:"Import Race",content,buttons:{import:{label:"Import",callback:async h=>{const url=String(h.find('[name=url]').val()||'').trim(); if(url) await game.sw25.importer.importUrl(url,this.actor);}}},default:"import"}).render(true);
  }

  async _openArmourDialog() {
    const content = `<form>
      <div class="form-group"><label>Armour</label><input name="name"></div>
      <div class="form-group"><label>Minimum Strength</label><input type="number" name="minStrength" value="0"></div>
      <div class="form-group"><label>Evasion</label><input type="number" name="evasion" value="0"></div>
      <div class="form-group"><label>Defense</label><input type="number" name="defence" value="0"></div>
      <div class="form-group"><label>Magical Defense</label><input type="number" name="magicalDefence" value="0"></div>
      <div class="form-group"><label>Notes</label><textarea name="description"></textarea></div>
      <hr><div class="form-group"><label>Import URL</label><input name="url" placeholder="http://sw25.wikidot.com/items:metal-armor"></div>
    </form>`;
    new Dialog({title:"Add Armour",content,buttons:{manual:{label:"Add Manually",callback:async h=>this.actor.createEmbeddedDocuments("Item",[{name:String(h.find('[name=name]').val()||'New Armour'),type:"armour",system:{minStrength:Number(h.find('[name=minStrength]').val()||0),evasion:Number(h.find('[name=evasion]').val()||0),defence:Number(h.find('[name=defence]').val()||0),magicalDefence:Number(h.find('[name=magicalDefence]').val()||0),description:String(h.find('[name=description]').val()||'')}}])},import:{label:"Import Link",callback:async h=>{const url=String(h.find('[name=url]').val()||'').trim(); if(url) await game.sw25.importer.importUrl(url,this.actor);}}}}).render(true);
  }

  async _openWeaponDialog() {
    const content = `<form>
      <div class="form-group"><label>Name</label><input name="name"></div>
      <div class="form-group"><label>Stance</label><select name="usage"><option>1H</option><option>2H</option></select></div>
      <div class="form-group"><label>Gun</label><input type="checkbox" name="isGun"></div>
      <div class="form-group"><label>Minimum Strength</label><input type="number" name="minStrength" value="0"></div>
      <div class="form-group"><label>Accuracy</label><input type="number" name="accuracy" value="0"></div>
      <div class="form-group"><label>Power</label><input type="number" name="power" value="0" min="0"></div>
      <div class="form-group"><label>Critical</label><input type="number" name="critical" value="10"></div>
      <div class="form-group"><label>Additional Damage</label><input type="number" name="additionalDamage" value="0"></div>
      <hr><div class="form-group"><label>Import URL</label><input name="url" placeholder="http://sw25.wikidot.com/items:swords"></div>
    </form>`;
    new Dialog({title:"Add Weapon",content,buttons:{manual:{label:"Add Manually",callback:async h=>{const gun=h.find('[name=isGun]').is(':checked'); return this.actor.createEmbeddedDocuments("Item",[{name:String(h.find('[name=name]').val()||'New Weapon'),type:"weapon",system:{usage:String(h.find('[name=usage]').val()||'1H'),minStrength:Number(h.find('[name=minStrength]').val()||0),accuracy:Number(h.find('[name=accuracy]').val()||0),power:Number(h.find('[name=power]').val()||0),critical:Number(h.find('[name=critical]').val()||10),additionalDamage:Number(h.find('[name=additionalDamage]').val()||0),category:gun?'Gun':'',artificerPowered:gun}}]);}},import:{label:"Import Link",callback:async h=>{const url=String(h.find('[name=url]').val()||'').trim(); if(url) await game.sw25.importer.importUrl(url,this.actor);}}}}).render(true);
  }

  async _openAdditionalDialog() {
    const content = `<form><div class="form-group"><label>Type</label><select name="type"><option value="ability">Ability</option><option value="spell">Spell</option><option value="feat">Feat</option></select></div><div class="form-group"><label>Title</label><input name="name"></div><div class="form-group"><label>Description</label><textarea name="description"></textarea></div><hr><div class="form-group"><label>Import URL</label><input name="url" placeholder="http://sw25.wikidot.com/"></div></form>`;
    new Dialog({title:"Add Ability, Spell, or Feat",content,buttons:{manual:{label:"Add Manually",callback:async h=>{const type=String(h.find('[name=type]').val()); const system={description:String(h.find('[name=description]').val()||'')}; if(type==='ability') system.source='class'; await this.actor.createEmbeddedDocuments('Item',[{name:String(h.find('[name=name]').val()||'New Entry'),type,system}]);}},import:{label:"Import Link",callback:async h=>{const url=String(h.find('[name=url]').val()||'').trim(); if(!url) return; try { await game.sw25.importer.importUrl(url,this.actor); } catch (error) { console.error(error); ui.notifications.warn("This page type is not supported by the importer yet."); }}}}}).render(true);
   }

  /**
   * Items may be dragged between actor sheets or from a compendium into this
   * actor's inventory. Dropped race Items are excluded from the transfer
   * path: they must keep flowing through _onDropItemCreate, where a race
   * initializes languages, racial abilities, ability corrections, and
   * background via the importer.
   * Spell Items additionally require a destination class association
   * (system.classId, system.className, system.school) so they appear on
   * the correct class spellcasting page.
   */
  async _onDropItem(event, data) {
    const fromDropData = Item.implementation?.fromDropData ?? Item.fromDropData;
    const source = await fromDropData.call(Item.implementation ?? Item, data);
    if (!source) return super._onDropItem(event, data);
    if (source.type === "race") return super._onDropItem(event, data);
    if (source.parent?.uuid === this.actor.uuid) return source;

    // Spell Items are never transferred by drag & drop; always copy.
    // Handle them before the generic move/copy dialog so they never show that prompt.
    if (source.type === "spell") {
      const destClass = await this._getSpellDestinationClass(source.name);
      if (!destClass) return null; // Cancelled, no classes, or no valid destination

      const itemData = source.toObject();
      delete itemData._id;
      itemData.system = itemData.system || {};
      itemData.system.classId = destClass.id;
      itemData.system.className = destClass.name;
      itemData.system.school = destClass.name;

      // Duplicate check: same spell name already associated with this class.
      const existing = this.actor.items.find(item =>
        item.type === "spell" &&
        item.name.toLowerCase() === source.name.toLowerCase() &&
        String(item.system.classId || "") === String(destClass.id)
      );
      if (existing) {
        ui.notifications.info(`${source.name} is already known by ${destClass.name}.`);
        return existing;
      }

      const [created] = await this.actor.createEmbeddedDocuments("Item", [itemData]);
      ui.notifications.info(`${source.name} was copied to ${this.actor.name}.`);
      return created;
    }

    // Generic Item handling (weapons, armour, equipment, etc.)
    let move = false;
    if (source.parent?.documentName === "Actor") {
      const choice = await new Promise(resolve => new Dialog({
        title:`Trade ${source.name}`,
        content:`<p>Transfer <strong>${foundry.utils.escapeHTML(source.name)}</strong> from <strong>${foundry.utils.escapeHTML(source.parent.name)}</strong> to <strong>${foundry.utils.escapeHTML(this.actor.name)}</strong>?</p>`,
        buttons:{
          move:{ icon:'<i class="fas fa-right-left"></i>', label:"Move", callback:()=>resolve("move") },
          copy:{ icon:'<i class="fas fa-copy"></i>', label:"Copy", callback:()=>resolve("copy") },
          cancel:{ label:"Cancel", callback:()=>resolve(null) }
        },
        default:"move",
        close:()=>resolve(null)
      }).render(true));
      if (!choice) return null;
      move = choice === "move";
      if (move && !source.isOwner) {
        ui.notifications.warn(`You cannot remove ${source.name} from ${source.parent.name}; it will be copied instead.`);
        move = false;
      }
    }

    const itemData = source.toObject();
    delete itemData._id;
    const [created] = await this.actor.createEmbeddedDocuments("Item", [itemData]);
    if (move) await source.delete();
    ui.notifications.info(`${source.name} was ${move ? "moved" : "copied"} to ${this.actor.name}.`);
    return created;
  }

  /**
   * Returns true when the class Item's stored type is the wizard category.
   * Uses the existing system.classType field; never the class name.
   *
   * @param {object} item - A class Item.
   * @returns {boolean}
   */
  _isWizardClass(item) {
    return String(item.system?.classType ?? "")
      .replace(/-type\s+class$/i, "")
      .trim()
      .toLowerCase() === "wizard";
  }

  /**
   * Determines the destination class for a dropped spell Item.
   *
   * Rules:
   *  - Exactly one class page: automatically assign to that class.
   *  - Multiple class pages with an active class page tab: assign to the active class.
   *  - Multiple class pages without an active class page: show a selection dialog
   *    offering only wizard-type classes.
   *  - No class pages, or no wizard-type classes: warn and return null.
   *
   * @param {string} spellName - The name of the spell being dropped (for the dialog).
   * @returns {Promise<object|null>} The destination class Item, or null if cancelled/none.
   */
  async _getSpellDestinationClass(spellName) {
    const classes = this.actor.items.filter(item => item.type === "class");

    if (classes.length === 0) {
      ui.notifications.warn("This character has no class pages. Spells cannot be added without a class.");
      return null;
    }

    // Spells can only be associated with wizard-type classes.
    const wizardClasses = classes.filter(item => this._isWizardClass(item));

    if (classes.length === 1) {
      return classes[0];
    }

    // Multiple classes - check if a class page tab is currently active.
    const activeTab = this._activeTab;
    if (activeTab && activeTab.startsWith("class-")) {
      const activeClassId = activeTab.slice("class-".length);
      const activeClass = classes.find(item => item.id === activeClassId);
      if (activeClass) return activeClass;
    }

    // Multiple classes, no active class page: show selection dialog (wizard classes only).
    if (wizardClasses.length === 0) {
      ui.notifications.warn("This character has no wizard classes. Spells can only be added to wizard classes.");
      return null;
    }

    return await this._selectSpellDestinationClassDialog(wizardClasses, spellName);
  }

  /**
   * Shows a dialog asking the user which class should receive a dropped spell.
   *
   * @param {object[]} classes - The character's class Items.
   * @param {string} spellName - The name of the spell being dropped.
   * @returns {Promise<object|null>} The selected class Item, or null if cancelled.
   */
  async _selectSpellDestinationClassDialog(classes, spellName) {
    const options = classes.map(item =>
      `<option value="${item.id}">${foundry.utils.escapeHTML(item.name)} (Lv ${Number(item.system.level ?? 0)})</option>`
    ).join("");

    const content = `<form>
      <div class="form-group">
        <label>Select destination class for "${foundry.utils.escapeHTML(spellName)}":</label>
        <select name="classId">${options}</select>
      </div>
    </form>`;

    return new Promise(resolve => new Dialog({
      title: "Select Destination Class",
      content,
      buttons: {
        select: {
          label: "Select",
          callback: html => {
            const classId = html.find('[name="classId"]').val();
            const selectedClass = classes.find(item => item.id === classId);
            resolve(selectedClass || null);
          }
        },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      close: () => resolve(null)
    }).render(true));
  }

}