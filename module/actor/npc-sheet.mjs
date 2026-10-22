/** Lightweight descriptive sheet for non-combat NPCs. */
export class SW25NPCSheet extends ActorSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["sw25", "sheet", "actor", "npc-sheet"],
      width: 1120,
      height: 820,
      resizable: true
    });
  }

  get template() {
    return "systems/sword-world-25/templates/actor/npc-sheet.hbs";
  }

  async getData(options = {}) {
    const context = await super.getData(options);
    context.actor = this.actor;
    context.system = this.actor.system;
    return context;
  }
}
