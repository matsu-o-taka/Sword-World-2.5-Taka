import { lootMatches, monsterDamageFormula } from "../importer/monster-parser.mjs";
import { damageApplicationButton } from "../combat/damage-application.mjs";
import { staticAccuracy } from "../combat/evasion-challenge.mjs";
import { monsterWeaponAttackFlow, getMonsterActiveCombatRolls, describeTargetFailure } from "../combat/attack-resolution.mjs";
import { openRollModifiersDialog } from "../rules/roll-modifiers.mjs";
import { criticalFailureHTML, markCriticalFailure, rollDiceResults } from "../rules/critical-failure.mjs";
import { appendMonsterCombatStyle, createMonsterUniqueSkill, getMainCombatStyleIndex, getMonsterSectionChoices, hasValidMainCombatStyle, mergeMonsterCombatStyleFields, mergeMonsterUniqueSkillFields, prepareMonsterCombatStyles, prepareMonsterUniqueSkillGroups, readMonsterActorCombatStyles, selectMainCombatStyle } from "./monster-sheet-data.mjs";
import { rollMonsterKnowledge, findMonsterKnowledgeRoller, speciesWeaknessKnown } from "../combat/monster-knowledge.mjs";

// ── Live Monster Knowledge indicator sync (F2-T2 consumer integration) ─────
//
// `context.weaknessKnown` is recomputed on every render from the Monster
// Knowledge Registry (world setting `mkRegistry`), so the Weak Point check on
// this sheet reflects the record the registry currently points at: a session
// switch or campaign activation changes the visible knowledge when the
// registry changes. Since F2-T1 the GM may also persist a discovery through
// the player relay; after every registry commit the world setting updates on
// every client and the documented v14 ClientSettings event hook
// (`clientSettingChanged`, foundry-api-docs/official-v14/functions/
// hookEvents.clientSettingChanged.html: "A hook event that fires when a
// client setting changes") lets the open sheets repaint their indicator
// without the previous manual close/reopen.
//
// Rendered sheets are tracked HERE (not via any window global): registration
// happens when the sheet actually renders, so a constructed-but-never-shown
// application is never repainted.

const MK_REGISTRY_SETTING_KEY = "mkRegistry";

const activeMkKnowledgeSheets = new Set();

function mkRegistrySettingChanged(key) {
  const settingKey = String(key ?? "");
  // Tolerant match: the hook may name the bare key or the "scope.key" form.
  return settingKey === MK_REGISTRY_SETTING_KEY
    || settingKey.endsWith(`.${MK_REGISTRY_SETTING_KEY}`);
}

function refreshMkKnowledgeIndicators() {
  for (const sheet of [...activeMkKnowledgeSheets]) {
    if (typeof sheet?.render !== "function") {
      activeMkKnowledgeSheets.delete(sheet);
      continue;
    }
    try {
      sheet.render(false);
    } catch (error) {
      // A failed repaint leaves this tab's indicator stale; the knowledge
      // itself is correct on the next render (close/reopen or any re-render),
      // so the failure is logged but never blocks the other windows.
      console.error("Sword World 2.5 | Monster Knowledge indicator refresh failed for an open monster sheet", error);
    }
  }
}

/**
 * Subscribe every client to Monster Knowledge registry changes so open
 * monster sheets reflect discoveries (direct GM write or F2-T1 relay) and
 * session/campaign switches on their Weak Point indicator at once.
 * Wired from sw25.mjs; tolerant to headless environments without Hooks.
 * @returns {void}
 */
export function initializeMonsterSheetKnowledgeSync() {
  if (typeof Hooks?.on !== "function") return;
  Hooks.on("clientSettingChanged", (key, value, options) => {
    if (!mkRegistrySettingChanged(key)) return;
    refreshMkKnowledgeIndicators();
  });
}

function promptMonsterSkillSection(sectionChoices, currentAssignment = "", title = "Choose Unique Skill Section") {
  const options = [
    `<option value="all" ${currentAssignment === "all" ? "selected" : ""}>All Sections</option>`,
    ...sectionChoices.map(section => `<option value="${foundry.utils.escapeHTML(section.id)}" ${currentAssignment === section.id ? "selected" : ""}>${foundry.utils.escapeHTML(section.name)}</option>`)
  ].join("");
  return new Promise(resolve => new Dialog({
    title,
    content: `<form><div class="form-group"><label>Section</label><select name="assignment" required><option value="" ${currentAssignment ? "" : "selected"} disabled>Choose a section</option>${options}</select></div></form>`,
    buttons: {
      choose: {
        label: "Choose",
        callback: html => resolve(String(html.find("[name='assignment']").val() || "") || null)
      },
      cancel: { label: "Cancel", callback: () => resolve(null) }
    },
    default: "choose",
    close: () => resolve(null)
  }).render(true));
}

export class SW25MonsterSheet extends foundry.appv1.sheets.ActorSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["sw25", "sheet", "actor", "monster-sheet"],
      width: 850,
      height: 780,
      resizable: true,
      scrollY: [".monster-sheet-body"]
    });
  }

  get template() { return "systems/sword-world-25/templates/actor/monster-sheet.hbs"; }

  // Live consumer sync (F2-T2): rendered instances join the knowledge
  // indicator refresh set. Registration happens per render, never per
  // construction, so invisible applications cannot be repainted.
  render(force, options) {
    activeMkKnowledgeSheets.add(this);
    return super.render(force, options);
  }

  _hasInvalidMonsterSheetForm() {
    return !hasValidMainCombatStyle(readMonsterActorCombatStyles(this.actor))
      || Boolean(this.form?.querySelector("[data-monster-skill-assignment-invalid]"));
  }

  async close(options = {}) {
    activeMkKnowledgeSheets.delete(this);
    if (!this._hasInvalidMonsterSheetForm()) return super.close(options);

    // FormApplication normally submits the form while closing. Do not let an
    // invalid profile block the window from closing or save its invalid edits.
    const submitOnClose = this.options.submitOnClose;
    this.options.submitOnClose = false;
    try {
      return await super.close(options);
    } finally {
      if (submitOnClose === undefined) delete this.options.submitOnClose;
      else this.options.submitOnClose = submitOnClose;
    }
  }

  async _onSubmit(event, options = {}) {
    if (!hasValidMainCombatStyle(readMonsterActorCombatStyles(this.actor))) {
      event?.preventDefault();
      ui.notifications.warn("Select exactly one Main Section before saving this monster.");
      return false;
    }
    if (this.form?.querySelector("[data-monster-skill-assignment-invalid]")) {
      event?.preventDefault();
      ui.notifications.warn("Assign each Unique Skill to a current section or All Sections before saving.");
      return false;
    }
    return super._onSubmit(event, options);
  }

  _getSubmitData(updateData = {}) {
    const data = super._getSubmitData(updateData);
    // Foundry V14 does not safely rebuild arrays from dotted form paths such as
    // system.combatStyles.0.damage. Reassemble each editable collection before
    // updating the Actor so editing one field cannot replace the array with an
    // object (which made every combat-stat row disappear on the next render).
    for (const collection of ["combatStyles", "uniqueSkills", "lootTable"]) {
      const prefix = `system.${collection}.`;
      const fields = Object.entries(data).filter(([key]) => key.startsWith(prefix));
      if (!fields.length) continue;
      if (collection === "uniqueSkills") {
        const sectionChoices = getMonsterSectionChoices(readMonsterActorCombatStyles(this.actor));
        data[`system.${collection}`] = mergeMonsterUniqueSkillFields(
          Array.isArray(this.actor.system.uniqueSkills) ? this.actor.system.uniqueSkills : [],
          fields.map(([key, value]) => [key.slice(prefix.length), value]),
          sectionChoices
        );
        for (const [key] of fields) delete data[key];
        continue;
      }
      if (collection === "combatStyles") {
        data[`system.${collection}`] = mergeMonsterCombatStyleFields(
          readMonsterActorCombatStyles(this.actor),
          fields.map(([key, value]) => [key.slice(prefix.length), value])
        );
        for (const [key] of fields) delete data[key];
        continue;
      }
      const list = foundry.utils.deepClone(Array.isArray(this.actor.system[collection]) ? this.actor.system[collection] : []);
      for (const [key, value] of fields) {
        foundry.utils.setProperty(list, key.slice(prefix.length), value);
        delete data[key];
      }
      data[`system.${collection}`] = list;
    }
    return data;
  }

  async getData(options = {}) {
    const context = await super.getData(options);
    context.actor = this.actor;
    context.system = this.actor.system;
    context.isGM = game.user.isGM;
    context.isOwner = Boolean(this.actor.isOwner);
    context.canManage = game.user.isGM || Boolean(this.actor.isOwner);
    context.weaknessKnown = speciesWeaknessKnown(this.actor);
    const combatStyles = readMonsterActorCombatStyles(this.actor);
    context.combatStyles = prepareMonsterCombatStyles(combatStyles);
    context.mainCombatStyleIncomplete = combatStyles.length > 1 && getMainCombatStyleIndex(combatStyles) === null;
    context.uniqueSkillSectionChoices = getMonsterSectionChoices(combatStyles);
    context.uniqueSkillGroups = prepareMonsterUniqueSkillGroups(
      this.actor.system.uniqueSkills,
      context.uniqueSkillSectionChoices
    );
    context.lootTable = (Array.isArray(this.actor.system.lootTable) ? this.actor.system.lootTable : []).map((entry, index) => ({ ...entry, index }));
    return context;
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-action='import-monster']").on("click", event => {
      event.preventDefault();
      new Dialog({
        title: "Import Monster",
        content: `<form><div class="form-group"><label>Monster URL</label><input type="url" name="url" value="${foundry.utils.escapeHTML(this.actor.system.sourceUrl || "http://sw25.wikidot.com/monster:goblin")}"></div></form>`,
        buttons: { import: { label: "Import", callback: async dialogHtml => {
          const url = String(dialogHtml.find("[name='url']").val() || "").trim();
          try { await game.sw25.importer.importUrl(url, this.actor); ui.notifications.info(`Imported ${this.actor.name}.`); }
          catch (error) { console.error("Sword World 2.5 | Monster import failed", error); ui.notifications.error(error.message || "Monster import failed."); }
        } }, cancel: { label: "Cancel" } },
        default: "import"
      }).render(true);
    });

    html.find("[data-action='roll-monster-damage']").on("click", async event => {
      event.preventDefault();
      const index = Number(event.currentTarget.dataset.index);
      const style = readMonsterActorCombatStyles(this.actor)[index];
      if (!style) return;
      try {
        const roll = await new Roll(monsterDamageFormula(style.damage)).evaluate();
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: this.actor }), flavor: `<div>${foundry.utils.escapeHTML(this.actor.name)} — ${foundry.utils.escapeHTML(style.style || "Attack")} Damage${damageApplicationButton(roll.total, "physical")}</div>` });
      } catch (error) { ui.notifications.error(`Invalid monster damage formula: ${style.damage}`); }
    });

    html.find("[data-action='select-main-combat-style']").on("change", async event => {
      event.preventDefault();
      event.stopPropagation();
      if (!game.user.isGM) return;
      const selectedIndex = Number(event.currentTarget.dataset.index);
      const currentStyles = readMonsterActorCombatStyles(this.actor);
      const updatedStyles = selectMainCombatStyle(currentStyles, selectedIndex, event.currentTarget.checked);
      if (!event.currentTarget.checked) {
        event.currentTarget.checked = true;
        return;
      }
      if (getMainCombatStyleIndex(updatedStyles) === getMainCombatStyleIndex(currentStyles)
        && updatedStyles.every((style, index) => style.isMainSection === currentStyles[index]?.isMainSection)) return;
      await this.actor.update({ "system.combatStyles": updatedStyles });
    });

    html.find("[data-action='roll-monster-accuracy']").on("click", async event => {
      event.preventDefault();
      // Accuracy initiates attacks (and the manual roll fallback); both are
      // explicitly GM-initiated actions on the monster side.
      if (!game.user.isGM) return;
      const style = readMonsterActorCombatStyles(this.actor)[Number(event.currentTarget.dataset.index)];
      if (!style) return;

      // When one character is targeted, resolve a full monster attack against
      // the target's Evasion using the monster's configured combat mode.
      const targetList = [...(game.user?.targets || [])];
      if (targetList.length === 1) {
        const targetToken = targetList[0];
        const targetActor = targetToken?.actor ?? targetToken?.document?.actor ?? null;
        if (targetActor?.type === "character") {
          const result = await monsterWeaponAttackFlow({
            monsterActor: this.actor,
            style,
            targetActor,
            promptModifiers: openRollModifiersDialog
          });
          if (result.status === "cancelled") return;
          if (result.status === "no-attack") return ui.notifications.warn(`${style.style || "This attack"} has no usable Accuracy value.`);
          if (result.status === "invalid-target") return ui.notifications.warn(describeTargetFailure("not-character"));
          if (result.status === "no-defense") return ui.notifications.warn(describeTargetFailure("no-defense"));
          return;
        }
        return ui.notifications.warn(describeTargetFailure("not-character"));
      }
      if (targetList.length > 1) return ui.notifications.warn(describeTargetFailure("multiple"));

      // Manual accuracy roll (no target): respects fixed/active mode for display only.
      const useActiveRolls = getMonsterActiveCombatRolls(this.actor);
      let rollTotal, rollNatural, roll;
      if (useActiveRolls) {
        const modifier = Number(String(style.accuracy || "").match(/-?\d+/)?.[0] ?? null);
        if (!Number.isFinite(modifier)) {
          return ui.notifications.warn(`${style.style || "This attack"} has no usable Accuracy modifier.`);
        }
        roll = await new Roll(`2d6 + ${modifier}`).evaluate();
        rollTotal = Number(roll.total);
        rollNatural = rollDiceResults(roll).reduce((sum, value) => sum + Number(value || 0), 0);
      } else {
        const fixedValue = staticAccuracy(style.accuracy);
        if (fixedValue === null) {
          return ui.notifications.warn(`${style.style || "This attack"} has no usable fixed Accuracy value.`);
        }
        rollTotal = fixedValue;
        rollNatural = null;
        roll = null;
      }
      const criticalFailure = roll ? await markCriticalFailure(this.actor, roll) : false;
      const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
      const flavor = roll
        ? `${this.actor.name} — ${escape(style.style || "Attack")} Accuracy${criticalFailure ? criticalFailureHTML() : ""}`
        : `${this.actor.name} — ${escape(style.style || "Attack")} Accuracy (fixed ${rollTotal})${criticalFailure ? criticalFailureHTML() : ""}`;
      if (roll) {
        await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: this.actor }), flavor });
      } else {
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: this.actor }), content: `<div>${flavor}</div>` });
      }
    });

    html.find("[data-action='roll-monster-resistance']").on("click", async event => {
      event.preventDefault();
      const check = event.currentTarget.dataset.check;
      const labels = { fortitude: "Fortitude", willpower: "Willpower" };
      if (!labels[check]) return;
      const rawValue = String(this.actor.system[check] ?? "0");
      const modifier = Number(rawValue.match(/-?\d+/)?.[0] ?? 0);
      const roll = await new Roll(`2d6 + ${modifier}`).evaluate();
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        flavor: `${this.actor.name} — ${labels[check]} Check`
      });
    });

    html.find("[data-action='post-monster-skill']").on("click", async event => {
      event.preventDefault();
      const skill = this.actor.system.uniqueSkills?.[Number(event.currentTarget.dataset.index)];
      if (!skill) return;
      const escape = value => foundry.utils.escapeHTML(String(value || "")).replace(/\n/g, "<br>");
      await ChatMessage.create({
        speaker:ChatMessage.getSpeaker({ actor:this.actor }),
        content:`<div class="sw25-chat-card monster-ability-card"><h3>${escape(skill.title || "Monster Ability")}</h3>${skill.description ? `<p>${escape(skill.description)}</p>` : ""}</div>`
      });
    });

    html.find("[data-action='roll-monster-loot']").on("click", async event => {
      event.preventDefault();
      const roll = await new Roll("2d6").evaluate();
      const total = Number(roll.total || 0);
      const matches = (this.actor.system.lootTable || []).filter(entry => lootMatches(entry.roll, total));
      const rows = matches.length ? matches.map(entry => `<li><strong>${foundry.utils.escapeHTML(entry.roll)}:</strong> ${foundry.utils.escapeHTML(entry.loot)}</li>`).join("") : "<li>Nothing</li>";
      await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: this.actor }), content: `<div class="sw25-chat-card"><h3>${foundry.utils.escapeHTML(this.actor.name)} Loot</h3><p><strong>2d:</strong> ${total}</p><ul>${rows}</ul></div>`, rolls: [roll] });
    });

    html.find("[data-action='roll-monster-knowledge']").on("click", async event => {
      event.preventDefault();
      // Roller resolution: one selected character token, one targeted
      // character token, or the assigned character — so the GM can roll for
      // any player character as needed.
      const roller = findMonsterKnowledgeRoller();
      if (roller.actor) {
        await rollMonsterKnowledge({ actor: roller.actor, targetMonster: this.actor, shiftKey: true });
        return;
      }
      if (roller.status === "ambiguous") {
        ui.notifications.warn("Select exactly one character token to roll Monster Knowledge.");
        return;
      }
      // No active character or selection: publish a chat request so any player can roll with their own character.
      await this._publishMonsterKnowledgeRequest();
    });

    const mutate = async (collection, callback) => {
      const source = collection === "combatStyles"
        ? readMonsterActorCombatStyles(this.actor)
        : Array.isArray(this.actor.system[collection]) ? this.actor.system[collection] : [];
      const list = foundry.utils.deepClone(source);
      callback(list);
      await this.actor.update({ [`system.${collection}`]: list });
    };
    html.find("[data-action='add-monster-style']").on("click", async event => {
      event.preventDefault();
      const currentStyles = readMonsterActorCombatStyles(this.actor);
      const newId = `cs-${Date.now()}`;
      await this.actor.update({
        "system.combatStyles": appendMonsterCombatStyle(currentStyles, {
          id: newId,
          style:"New Attack", accuracy:"0", damage:"2d", evasion:"0", defense:0,
          hp:{value:0,max:0}, mp:{value:0,max:0}, isMainSection:false
        })
      });
    });
    html.find("[data-action='delete-monster-style']").on("click", event => { event.preventDefault(); return mutate("combatStyles", list => list.splice(Number(event.currentTarget.dataset.index), 1)); });
    html.find("[data-action='add-monster-skill']").on("click", async event => {
      event.preventDefault();
      const sectionChoices = getMonsterSectionChoices(readMonsterActorCombatStyles(this.actor));
      let assignment = "all";
      if (sectionChoices.length > 1) {
        assignment = await promptMonsterSkillSection(sectionChoices, "", "Assign Unique Skill");
        if (!assignment) return;
      }
      const skill = createMonsterUniqueSkill(assignment, sectionChoices, {
        title: "New Ability",
        description: ""
      });
      if (!skill) {
        ui.notifications.warn("Choose a current section or All Sections.");
        return;
      }
      return mutate("uniqueSkills", list => list.push(skill));
    });
    html.find("[data-action='choose-monster-skill-section']").on("click", async event => {
      event.preventDefault();
      if (!game.user.isGM) return;
      const index = Number(event.currentTarget.dataset.index);
      const skills = Array.isArray(this.actor.system.uniqueSkills) ? this.actor.system.uniqueSkills : [];
      const currentSkill = skills[index];
      if (!currentSkill) return;
      const sectionChoices = getMonsterSectionChoices(readMonsterActorCombatStyles(this.actor));
      if (sectionChoices.length <= 1) return;
      const currentAssignment = currentSkill.sectionScope === "section"
        && sectionChoices.some(section => section.id === currentSkill.combatStyleId)
        ? currentSkill.combatStyleId
        : currentSkill.sectionScope === "section" ? "" : "all";
      const assignment = await promptMonsterSkillSection(sectionChoices, currentAssignment);
      if (!assignment) return;
      const updatedSkill = createMonsterUniqueSkill(assignment, sectionChoices, currentSkill);
      if (!updatedSkill) {
        ui.notifications.warn("Choose a current section or All Sections.");
        return;
      }
      const updatedSkills = foundry.utils.deepClone(skills);
      updatedSkills[index] = updatedSkill;
      await this.actor.update({ "system.uniqueSkills": updatedSkills });
    });
    html.find("[data-action='delete-monster-skill']").on("click", event => { event.preventDefault(); return mutate("uniqueSkills", list => list.splice(Number(event.currentTarget.dataset.index), 1)); });
    html.find("[data-action='add-monster-loot']").on("click", event => { event.preventDefault(); return mutate("lootTable", list => list.push({ roll:"2-12", loot:"New Loot" })); });
    html.find("[data-action='delete-monster-loot']").on("click", event => { event.preventDefault(); return mutate("lootTable", list => list.splice(Number(event.currentTarget.dataset.index), 1)); });
  }

  async _publishMonsterKnowledgeRequest() {
    const monster = this.actor;
    if (!monster || monster.type !== "monster") return;
    const content = `
      <div class="sw25-chat-card sw25-mk-request-card" data-mk-monster-uuid="${monster.uuid}">
        <h3>Monster Knowledge — ${foundry.utils.escapeHTML(monster.name)}</h3>
        <p>Make a roll to discover information about this monster.</p>
        <button type="button" data-sw25-chat-action="roll-monster-knowledge-request" data-mk-monster-uuid="${monster.uuid}">
          <i class="fas fa-search"></i> Roll Monster Knowledge
        </button>
      </div>`;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: monster }),
      content
    });
  }
}
