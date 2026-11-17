import { lootMatches, monsterDamageFormula } from "../importer/monster-parser.mjs";
import { damageApplicationButton } from "../combat/damage-application.mjs";
import { staticAccuracy } from "../combat/evasion-challenge.mjs";
import { monsterWeaponAttackFlow, getMonsterActiveCombatRolls, describeTargetFailure } from "../combat/attack-resolution.mjs";
import { openRollModifiersDialog } from "../rules/roll-modifiers.mjs";
import { criticalFailureHTML, markCriticalFailure, rollDiceResults } from "../rules/critical-failure.mjs";
import { appendMonsterCombatStyle, applyMonsterMainSectionPolicyToStyles, createMonsterUniqueSkill, getMonsterSectionChoices, hasValidMainCombatStyle, mergeMonsterCombatStyleFields, mergeMonsterUniqueSkillFields, prepareMonsterCombatStyles, prepareMonsterUniqueSkillGroups, readMonsterActorCombatStyles, setMonsterMainSectionFlag } from "./monster-sheet-data.mjs";
import { MONSTER_SPECIAL_RULES, SPECIAL_RULE_LABELS, MAIN_SECTION_POLICIES, resolveMonsterSectionPolicy, resolveMonsterSpecialRule } from "./monster-section-state.mjs";
import { concealedSelectionCandidates, getConcealedMainSectionConfig, getConcealedMainSectionSelection, getConcealedMainSectionPresentation, randomizeConcealedMainSection, setConcealedMainSectionSelection, selectConcealedMainSection, setConcealedMainSectionConfig } from "../combat/concealed-main-section.mjs";
import { prepareSw25EffectsTab, attachSw25ConcealedSelectionLabel, buildSw25BestiaryConcealedSectionRow } from "../effects/effects-tab.mjs";
import { wireSw25EffectsTabHandlers } from "./effects-tab-ui.mjs";
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
const SYSTEM_ID = "sw25-taka";

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

const capitalizedPolicy = policy => String(policy ?? "").replace(/^./, c => c.toUpperCase());

const POLICY_DESCRIPTIONS = {
  any: "Any one Main Section at 0 HP or fewer incapacitates the monster (single or several noted main sections).",
  all: "ALL sections of the monster are Main Sections: the monster is incapacitated only when every section is destroyed — the (All) notation.",
  none: "No Main Sections: the monster stays active until EVERY section is destroyed — the (None) notation.",
  special: "Defeat resolution is delegated to a special rule chosen below for this monster (not to the ordinary section markers)."
};

/** GM-facing special-rule choices for the Special policy (id + dialog copy). */
const SPECIAL_RULE_CHOICES = [
  {
    id: "concealedMainSection",
    description: "One eligible section is secretly chosen as the monster's concealed Main Section. Defeating that hidden section incapacitates the monster. All sections are candidates by default."
  },
  {
    id: "manual",
    description: "The monster follows special rules to determine its Main Section; defeat is resolved by hand rather than from section markers."
  }
];

/**
 * Open the Main Section policy dialog (GM only).
 *
 * Selects the interpretation mode for the monster's sections: `any`, `all`,
 * `none`, or `special`. Special is a policy CATEGORY, not a rule: when it is
 * selected the dialog offers the special-rule choices (Concealed Main
 * Section, Manual Resolution — see `SPECIAL_RULE_CHOICES`) and persists the
 * chosen rule INDEPENDENTLY in `system.mainSectionSpecialRule`, so switching
 * to another policy and back restores it without regenerating anything.
 * Only the Concealed Main Section rule shows its candidate configuration;
 * saving it activates the feature (candidate config + plaintext selection in
 * the GM-only concealed ActiveEffect). Manual Resolution
 * never touches a concealed selection.
 *
 * Switching to All persists `isMainSection: true` on every section row and
 * switching to None clears every row flag (whole-array updates); Any and
 * Special preserve the current row configuration. The random concealed
 * choice is persisted as a plaintext record in the concealed ActiveEffect,
 * which carries `system.gmOnly: true`: the system's own effect interfaces
 * (Effects tab, inspector) hide it from players. Candidates and the current
 * assignment are fetched at click time, not during sheet render.
 * @param {Actor} actor - The monster actor being configured.
 * @param {{policy: string, source: string}} current - Resolved current policy.
 * @returns {Promise<string|null>} The saved policy, or null when cancelled.
 */
async function openMainSectionPolicyDialog(actor, current) {
  const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
  const sourceNote = current.source === "explicit"
    ? "Currently set explicitly for this monster."
    : current.source === "derived"
      ? "Currently recovered from the imported Main Section data ((All)/(None)/(Special)); no explicit value is stored yet."
      : "Currently the documented default; no explicit value is stored yet.";

  // GM-click-time data: the candidate sections are public monster data, the
  // current assignment comes from the GM-only ActiveEffect record (null for
  // players — this dialog is never opened by them). The candidate config
  // (exclusions) is read from the actor to pre-fill the inclusion checkboxes.
  // An unresolvable selection (malformed record, section removed) is
  // surfaced as an explicit note — never silently as "not assigned".
  const [candidates, config] = await Promise.all([
    Promise.resolve(concealedSelectionCandidates(actor)),
    Promise.resolve(getConcealedMainSectionConfig(actor))
  ]);
  let assigned = null;
  let assignmentProblem = null;
  try {
    assigned = await getConcealedMainSectionSelection(actor);
  } catch (error) {
    assignmentProblem = String(error?.message ?? error);
  }
  const excludedIds = new Set(config?.excluded ?? []);
  const assignedNote = assignmentProblem
    ? `<p class="monster-policy-note">A concealed section is assigned but currently UNREADABLE: ${escape(assignmentProblem)}</p>`
    : assigned?.section
      ? `<p class="monster-policy-note">A concealed section is already assigned. Re-saving Special keeps the current selection.</p>`
      : "";
  const persistedRule = resolveMonsterSpecialRule(actor.system).rule;
  const radios = MAIN_SECTION_POLICIES.map(policy => `
    <label class="monster-policy-option">
      <input type="radio" name="mainSectionPolicy" value="${policy}" ${current.policy === policy ? "checked" : ""}>
      <span class="monster-policy-name">${capitalizedPolicy(policy)}</span>
      <span class="monster-policy-description">${escape(POLICY_DESCRIPTIONS[policy])}</span>
    </label>`).join("");
  const specialRuleRadios = SPECIAL_RULE_CHOICES.map(rule => `
    <label class="monster-policy-option">
      <input type="radio" name="mainSectionSpecialRule" value="${rule.id}" ${persistedRule === rule.id ? "checked" : ""}>
      <span class="monster-policy-name">${escape(SPECIAL_RULE_LABELS[rule.id])}</span>
      <span class="monster-policy-description">${escape(rule.description)}</span>
    </label>`).join("");
  const specialRules = `
    <div class="monster-special-rules" data-special-rules>
      <fieldset>
        <legend class="monster-policy-name">Special Rule</legend>
        <p class="monster-policy-description">Special is a policy category, not a rule: choose WHICH special rule resolves this monster's defeat. The choice is saved separately from the policy and survives policy switches.</p>
        <div class="monster-policy-options">${specialRuleRadios}</div>
      </fieldset>
    </div>`;
  const concealedChoice = `
    <div class="monster-concealed-choice" data-concealed-choice>
      <fieldset>
        <legend class="monster-policy-name">Concealed Candidates</legend>
        <p class="monster-policy-description">All sections are candidates by default. Uncheck sections to exclude them. At least two candidates are required; one will be selected at random when this rule is saved.</p>
        <div class="monster-concealed-candidates">
          ${candidates.map(row => `
            <label class="monster-concealed-candidate">
              <input type="checkbox" name="concealedInclude" value="${escape(row.id ?? "")}" ${!excludedIds.has(row.id ?? "") ? "checked" : ""}>
              <span>${escape(row.section)}</span>
            </label>
          `).join("")}
        </div>
      </fieldset>
    </div>`;
  return new Promise(resolve => {
    const dialog = new Dialog({
      title: "Main Sections Interpretation",
      content: `
        <form>
          <p class="monster-policy-intro">How the Main Sections of <strong>${escape(actor.name)}</strong> incapacitate the monster:</p>
          <div class="monster-policy-options">${radios}</div>
          ${specialRules}
          ${concealedChoice}
          ${assignedNote}
          <p class="monster-policy-note">${escape(sourceNote)}</p>
        </form>`,
      buttons: {
        save: {
          label: "Save",
          callback: async dialogHtml => {
            const value = String(dialogHtml.find("[name='mainSectionPolicy']:checked").val() || "").trim();
            const policy = MAIN_SECTION_POLICIES.includes(value) ? value : null;
            if (!policy) return resolve(null);
            const updates = {};
            if (policy !== current.policy) updates["system.mainSectionPolicy"] = policy;
            if (policy === "special") {
              // The special rule is persisted independently from the policy
              // value. Saving Special without choosing a rule is allowed and
              // produces the controlled unconfigured state (the sheet labels
              // it and the DEFEATED sync refuses to guess).
              const ruleValue = String(dialogHtml.find("[name='mainSectionSpecialRule']:checked").val() || "").trim();
              if (MONSTER_SPECIAL_RULES.includes(ruleValue) && ruleValue !== persistedRule) {
                updates["system.mainSectionSpecialRule"] = ruleValue;
              }
              if (ruleValue === "concealedMainSection") {
                // Collect which sections the GM kept included (checked
                // boxes). Unchecked sections become exclusions in the
                // candidate config.
                const includedIds = new Set();
                dialogHtml.find("[name='concealedInclude']:checked").each((_i, el) => {
                  const id = String(el.value ?? "").trim();
                  if (id) includedIds.add(id);
                });
                const allIds = candidates.map(c => c.id ?? "");
                const excluded = allIds.filter(id => !includedIds.has(id));
                try {
                  // Real persisted write (candidate config survives reloads).
                  await setConcealedMainSectionConfig(actor, { excluded });
                } catch (error) {
                  ui.notifications.warn(error.message || "The concealed Main Section cannot be activated with fewer than two candidates.");
                  return resolve(null);
                }
                try {
                  // Auto-random selection once per instance; result persisted
                  // in an ActiveEffect via EffectService. An existing,
                  // resolvable selection is kept (never re-rolled); an
                  // unresolvable one is an explicit error — never replaced.
                  await selectConcealedMainSection(actor);
                } catch (error) {
                  console.error("Sword World 2.5 | Concealed Main Section selection failed", error);
                  ui.notifications.error(error.message || "The hidden Main Section could not be assigned.");
                  return resolve(null);
                }
              }
              // Manual Resolution persists the rule only: no concealed
              // candidate config write, no selection, no reroll.
            } else {
              // Explicit All/None rewrite the section markers coherently
              // (whole-array update); Any and Special preserve them.
              const sectionRows = applyMonsterMainSectionPolicyToStyles(readMonsterActorCombatStyles(actor), policy);
              if (sectionRows) updates["system.combatStyles"] = sectionRows;
              // The special-rule configuration is deliberately NOT cleared:
              // switching back to Special restores the previously chosen rule.
            }
            try {
              if (Object.keys(updates).length) await actor.update(updates);
            } catch (error) {
              console.error("Sword World 2.5 | Main Section policy save failed", error);
              ui.notifications.error(error.message || "The Main Section policy could not be saved.");
              return resolve(null);
            }
            resolve(policy);
          }
        },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "save",
      close: () => resolve(null),
      render: dialogHtml => {
        // The special-rule chooser belongs to the Special policy only, and
        // the concealed candidate config belongs ONLY to the Concealed Main
        // Section rule (selecting Special alone must not activate it).
        const updateChoice = () => {
          const special = dialogHtml.find("[name='mainSectionPolicy']:checked").val() === "special";
          const rule = special
            ? String(dialogHtml.find("[name='mainSectionSpecialRule']:checked").val() || "")
            : "";
          const concealed = special && rule === "concealedMainSection";
          dialogHtml.find("[data-special-rules]").toggleClass("monster-dialog-hidden", !special);
          dialogHtml.find("[name='mainSectionSpecialRule']").prop("disabled", !special);
          dialogHtml.find("[data-concealed-choice]").toggleClass("monster-dialog-hidden", !concealed);
          dialogHtml.find("[name='concealedInclude']").prop("disabled", !concealed);
        };
        dialogHtml.find("[name='mainSectionPolicy'], [name='mainSectionSpecialRule']").on("change", updateChoice);
        updateChoice();
      }
    }).render(true);
  });
}

function promptMonsterSkillSection(sectionChoices, currentAssignment = "", title = "Choose Unique Skill Section") {  const options = [
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

  get template() { return "systems/sw25-taka/templates/actor/monster-sheet.hbs"; }

  // Live consumer sync (F2-T2): rendered instances join the knowledge
  // indicator refresh set. Registration happens per render, never per
  // construction, so invisible applications cannot be repainted.
  render(force, options) {
    activeMkKnowledgeSheets.add(this);
    return super.render(force, options);
  }

  _hasInvalidMonsterSheetForm() {
    const actor = this.actor;
    if (!actor) return false;
    return !hasValidMainCombatStyle(readMonsterActorCombatStyles(actor), actor.system)
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
    if (!hasValidMainCombatStyle(readMonsterActorCombatStyles(this.actor), this.actor.system)) {
      event?.preventDefault();
      ui.notifications.warn("Select a Main Section before saving this monster.");
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
    // Main Section policy (any/all/none/special) driving the global
    // incapacitation sync: resolved read-only from the persisted data
    // (explicit property, recovered (All)/(None) meaning, or the documented
    // default). The indicator text reflects how main sections are
    // interpreted — for Special it names the persisted special rule, or the
    // controlled unconfigured state when none was chosen.
    context.sectionPolicy = resolveMonsterSectionPolicy(this.actor.system);
    context.sectionSpecialRule = context.sectionPolicy.policy === "special"
      ? resolveMonsterSpecialRule(this.actor.system).rule
      : null;
    context.concealedMainSectionActive = context.sectionSpecialRule === "concealedMainSection";
    context.mainSectionSpecialUnconfigured = context.sectionPolicy.policy === "special"
      && context.sectionPolicy.source === "explicit"
      && !context.sectionSpecialRule;
    const specialRuleSuffix = context.sectionSpecialRule === "manual"
      ? " (Manual Resolution)"
      : context.sectionSpecialRule === "concealedMainSection"
        ? " (Concealed)"
        : "";
    context.mainSectionPolicyLabel = `Main Sections: ${capitalizedPolicy(context.sectionPolicy.policy)}${specialRuleSuffix}`;
    context.combatStyles = prepareMonsterCombatStyles(combatStyles, [], {
      policy: context.sectionPolicy.policy,
      source: context.sectionPolicy.source
    });
    context.mainCombatStyleIncomplete = combatStyles.length > 1 && !hasValidMainCombatStyle(combatStyles, this.actor.system);
    context.uniqueSkillSectionChoices = getMonsterSectionChoices(combatStyles);
    context.uniqueSkillGroups = prepareMonsterUniqueSkillGroups(
      this.actor.system.uniqueSkills,
      context.uniqueSkillSectionChoices
    );
    context.lootTable = (Array.isArray(this.actor.system.lootTable) ? this.actor.system.lootTable : []).map((entry, index) => ({ ...entry, index }));

    // Effects section: the same read-only display data the character sheet's
    // Effects tab renders (module/effects/effects-tab.mjs), reusing its
    // markup, helpers and styling. Same gmOnly presentation rules: players
    // never see `system.gmOnly` effects (the Concealed Main Section among
    // them); the GM sees and can inspect them.
    context.effectsTab = prepareSw25EffectsTab(this.actor, context.isGM === true);
    if (context.isGM === true) {
      // GM-only readability adaptation: the row of the concealed effect
      // carries a badge naming the currently selected section (or the
      // explicit unresolved state). Pure attachment over the prepared rows;
      // never a player-visible value (the presentation read is GM-gated).
      attachSw25ConcealedSelectionLabel(
        context.effectsTab.rows,
        getConcealedMainSectionPresentation(this.actor)
      );
    }
    // Bestiary copies reveal their discovered concealed Main Section through
    // flags (persisted by createBestiaryActorCopy), not through the concealed
    // ActiveEffect (which lives only on the original monster). Surface it for
    // all viewers — the Bestiary copy grants OBSERVER ownership and the
    // discovered section is player-facing knowledge.
    const systemFlags = this.actor.flags?.[SYSTEM_ID] ?? {};
    if (systemFlags.mkbestiary === true) {
      const concealedMainSection = systemFlags.mkbestiaryConcealedMainSection;
      if (concealedMainSection && concealedMainSection.section) {
        const row = buildSw25BestiaryConcealedSectionRow(concealedMainSection.section);
        if (row) context.effectsTab.rows.push(row);
      }
    }
    return context;
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Shared Effects-section listeners (inspect + GM repair), identical to
    // the character sheet's — see module/actor/effects-tab-ui.mjs.
    wireSw25EffectsTabHandlers(this, html);

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

    // Main-section marking. The interaction follows the resolved policy:
    //   - explicit Any (and derived import policies): INDEPENDENT toggles —
    //     checking/unchecking one row never touches the others (several
    //     noted main sections are legitimate, CR I p. 387);
    //   - explicit All: every row is marked and the checkboxes are locked
    //     (rendered checked + disabled by prepareMonsterCombatStyles);
    //   - explicit None: no row is marked and the checkboxes are locked
    //     (rendered unchecked + disabled);
    //   - Special: the ordinary markers never drive the special rule's
    //     resolution, so they stay freely editable but inert.
    html.find("[data-action='select-main-combat-style']").on("change", async event => {
      event.preventDefault();
      event.stopPropagation();
      if (!game.user.isGM) return;
      const { policy, source } = resolveMonsterSectionPolicy(this.actor.system);
      const explicitAll = source === "explicit" && policy === "all";
      const explicitNone = source === "explicit" && policy === "none";
      const selectedIndex = Number(event.currentTarget.dataset.index);
      const checked = event.currentTarget.checked === true;
      if (explicitAll || explicitNone) {
        // Locked display: restore the rendered state (a disabled checkbox
        // should never fire, but a stale or programmatic event must not
        // introduce a contradictory partial selection).
        event.currentTarget.checked = explicitAll;
        return;
      }
      const currentStyles = readMonsterActorCombatStyles(this.actor);
      const updatedStyles = setMonsterMainSectionFlag(currentStyles, selectedIndex, checked);
      // Invariant for multi-section profiles: at least one Main Section
      // stays marked under the flag-reading policies (the submit validation
      // enforces the same rule). Unchecking the LAST marked row is refused.
      if (!checked && updatedStyles.length > 1 && !updatedStyles.some(style => style.isMainSection === true)) {
        event.currentTarget.checked = true;
        ui.notifications.warn("At least one Main Section must remain marked for this monster.");
        return;
      }
      if (updatedStyles.every((style, index) => style.isMainSection === currentStyles[index]?.isMainSection)) return;
      await this.actor.update({ "system.combatStyles": updatedStyles });
    });

    // Main Section policy configuration (any/all/none/special). The gear
    // button lives next to the policy indicator in the Combat Statistics
    // heading and is only rendered for the GM; the check here mirrors the
    // other GM handlers. Saving updates `system.mainSectionPolicy` (and, for
    // Special, the persisted candidate config plus the GM-only concealed
    // selection record), which re-renders the sheet through the standard
    // update flow and refreshes the indicator.
    html.find("[data-action='configure-main-sections']").on("click", async event => {
      event.preventDefault();
      if (!game.user.isGM) return;
      const policy = await openMainSectionPolicyDialog(this.actor, resolveMonsterSectionPolicy(this.actor.system));
      if (policy) this.render(false);
    });

    // Re-randomize the concealed Main Section of this monster (GM only).
    // Replaces the existing concealed effect with a new random selection —
    // never accumulates, never touches other effects, never touches other
    // individuals that share this Actor.
    html.find("[data-action='randomize-concealed-main-section']").on("click", async event => {
      event.preventDefault();
      if (!game.user.isGM) return;
      try {
        await randomizeConcealedMainSection(this.actor);
        this.render(false);
        ui.notifications.info(`Concealed Main Section of ${this.actor.name} re-randomized.`);
      } catch (error) {
        ui.notifications.error(error.message || "The concealed Main Section could not be re-randomized.");
      }
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
