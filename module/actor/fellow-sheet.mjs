/** Fellow-format sheet and action-table roller. */
export class SW25FellowSheet extends ActorSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["sw25", "sheet", "actor", "fellow-sheet"],
      width: 1240,
      height: 900,
      resizable: true
    });
  }

  get template() {
    return "systems/sword-world-25/templates/actor/fellow-sheet.hbs";
  }

  _getSubmitData(updateData = {}) {
    const data = super._getSubmitData(updateData);
    const prefix = "system.fellow.actions.";
    const fields = Object.entries(data).filter(([key]) => key.startsWith(prefix));
    if (!fields.length) return data;
    const actions = foundry.utils.deepClone(Array.isArray(this.actor.system.fellow?.actions) ? this.actor.system.fellow.actions : []);
    for (const [key, value] of fields) {
      foundry.utils.setProperty(actions, key.slice(prefix.length), value);
      delete data[key];
    }
    data["system.fellow.actions"] = actions;
    return data;
  }

  async getData(options = {}) {
    const context = await super.getData(options);
    context.actor = this.actor;
    context.system = this.actor.system;
    const labels = ["1-2", "3-4", "5", "6"];
    const results = [7, 8, 9, 10];
    const actions = Array.isArray(this.actor.system.fellow?.actions) ? this.actor.system.fellow.actions : [];
    context.fellowActions = labels.map((dieLabel, index) => ({
      ...(actions[index] || {}),
      index,
      dieLabel,
      resultValue: results[index]
    }));
    return context;
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-action='roll-fellow-action']").on("click", event => {
      event.preventDefault();
      return this._onRollFellowAction();
    });
  }

  /** Dropping a race Item fills the fellow's race field with the race name. */
  async _onDrop(event) {
    let dragData = null;
    try {
      dragData = JSON.parse(event.dataTransfer.getData("text/plain"));
    } catch (error) {
      dragData = null;
    }
    if (dragData?.type === "Item") {
      let raceName = null;
      if ([dragData?.itemType, dragData?.data?.type, dragData?.document?.type].includes("race")) {
        raceName = dragData?.data?.name || dragData?.name || "";
      } else if (dragData?.uuid) {
        try {
          const item = await Item.implementation.fromDropData(dragData);
          if (item?.type === "race") raceName = item.name;
        } catch (error) {
          // Not resolvable; fall through to default drop handling.
        }
      }
      if (raceName) {
        const name = String(raceName).trim();
        if (name) {
          await this.actor.update({ "system.fellow.race": name });
          return;
        }
      }
    }
    return super._onDrop(event);
  }

  async _onRollFellowAction() {
    if (!this.actor.isOwner && !game.user.isGM) return ui.notifications.warn("You do not have permission to use this Fellow.");
    const actions = Array.isArray(this.actor.system.fellow?.actions) ? this.actor.system.fellow.actions : [];
    const dieLabels = ["1-2", "3-4", "5", "6"];
    const options = actions
      .map((action, index) => ({ index, action: action || {} }))
      .filter(entry => String(entry.action.action || "").trim())
      .map(entry => `<option value="${entry.index}">(${dieLabels[entry.index]}) ${foundry.utils.escapeHTML(String(entry.action.action || "").trim())}</option>`)
      .join("");
    if (!options) return ui.notifications.warn("This Fellow's Action Table has no actions to order yet.");

    const orderedIndex = await new Promise(resolve => new Dialog({
      title: `${this.actor.name}: Order a Fellow Action`,
      content: `<form><div class="form-group"><label>Which action should the Fellow attempt?</label><select name="order" autofocus>${options}</select></div><p>Roll 1d; the Fellow carries out the order only if the rolled row matches it.</p></form>`,
      buttons: {
        roll: { label: "Roll 1d6", callback: html => resolve(Number(html.find('[name="order"]').val())) },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "roll",
      close: () => resolve(null)
    }).render(true));
    if (!Number.isInteger(orderedIndex)) return;

    const roll = await new Roll("1d6").evaluate();
    const total = Number(roll.total || 0);
    const index = total <= 2 ? 0 : total <= 4 ? 1 : total - 3;
    const matched = index === orderedIndex;
    const chosen = actions[orderedIndex] || {};
    const escape = value => foundry.utils.escapeHTML(String(value || ""));
    const line = value => escape(value).replace(/\n/g, "<br>");
    const card = (heading, extra = "") => `<div class="sw25-chat-card fellow-action-card"><h3>${heading}</h3><p><strong>Ordered:</strong> ${line(chosen.action || dieLabels[orderedIndex])}</p><p><strong>1d6:</strong> ${total} &nbsp; <strong>Table row:</strong> ${dieLabels[index]}</p>${extra}</div>`;
    const details = `${chosen.dialogue ? `<p class="sw25-fellow-dialogue">${line(chosen.dialogue)}</p>` : ""}${chosen.value ? `<p><strong>Value:</strong> ${line(chosen.value)}</p>` : ""}${chosen.effect ? `<p><strong>Effect:</strong> ${line(chosen.effect)}</p>` : ""}`;

    if (!matched) {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        content: card("Order Not Followed", "<p>The rolled row does not match the ordered action; the Fellow is unable to perform it and no MP is spent.</p>"),
        rolls: [roll]
      });
      return;
    }

    const currentMP = Math.max(0, Number(this.actor.system.fellow?.mp ?? 0));
    const mpCost = Math.max(0, Number(chosen.mpCost ?? 0));
    if (mpCost > currentMP) {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        content: card("Action Not Possible: Not Enough MP", `<p>The ordered action cannot be carried out: the Fellow has ${currentMP} MP and the action requires ${mpCost} MP.</p>`),
        rolls: [roll]
      });
      return;
    }

    if (mpCost) {
      await this.actor.update({ "system.fellow.mp": currentMP - mpCost });
    }
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: card("Fellow Action", `${details}${mpCost ? `<p><em>${this.actor.name} spends ${mpCost} MP (now ${currentMP - mpCost}).</em></p>` : ""}`),
      rolls: [roll]
    });
  }
}
