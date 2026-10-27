/** Lightweight descriptive sheet for non-combat NPCs. */
export class SW25NPCSheet extends foundry.appv1.sheets.ActorSheet {
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
    const savedSheetStyle = String(this.actor.getFlag("sword-world-25", "sheetStyle") ?? "paper").toLowerCase();
    context.sheetStyle = ["paper", "adventurer"].includes(savedSheetStyle) ? savedSheetStyle : "paper";
    context.isPaperStyle = context.sheetStyle === "paper";
    context.isAdventurerStyle = context.sheetStyle === "adventurer";
    return context;
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-action='set-sheet-style']").on("change", async event => {
      event.preventDefault();
      const style = String(event.currentTarget.value || "paper").toLowerCase();
      await this.actor.setFlag("sword-world-25", "sheetStyle", style === "adventurer" ? "adventurer" : "paper");
      this.render(false);
    });
  }
}
