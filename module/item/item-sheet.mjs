import { classEditorSkillOptions } from "../rules/skill-resolution.mjs";
import { castSpellAsMajor } from "../rules/spell-cast.mjs";

export class SW25ItemSheet extends foundry.appv1.sheets.ItemSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["sw25", "sheet", "item"],
      width: 540,
      height: 560,
      resizable: true
    });
  }

  get template() {
    return "systems/sw25-taka/templates/item/item-sheet.hbs";
  }

  async getData(options = {}) {
    const context = await super.getData(options);
    context.item = this.item;
    context.system = this.item.system;
    context.isRace = this.item.type === "race";
    context.isClass = this.item.type === "class";
    context.isFeat = this.item.type === "feat";
    context.isAbility = this.item.type === "ability";
    context.isWeapon = this.item.type === "weapon";
    context.isArmour = this.item.type === "armour";
    context.isSkill = this.item.type === "skill";
    context.isSpell = this.item.type === "spell";
    context.isEquipment = this.item.type === "equipment";

    if (context.isClass) {
      context.skillOptions = classEditorSkillOptions(context.system.skillChecks);
    }

    return context;
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-action='cast-spell-from-item']").on("click", this._onCastSpell.bind(this));
  }

  async _onCastSpell(event) {
    event.preventDefault();
    const spell = this.item;
    const actor = spell.parent;
    if (!actor || actor.documentName !== "Actor") {
      return ui.notifications.warn("Open this spell from a character to cast it.");
    }
    // The item sheet's Cast button is an entry point to the SAME centralized
    // Spellcasting flow as the character sheet's Cast button: Major Action
    // with its Spellcasting check (validation, MP deduction before the roll,
    // SV, per-target resistances, cast-time effects, Power Table damage).
    // This handler owns NO casting logic of its own.
    await castSpellAsMajor({ actor, spell, applyCost: this.isEditable });
  }
}
