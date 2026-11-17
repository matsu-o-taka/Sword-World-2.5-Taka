import { SW25ActorSheet } from "./module/actor/actor-sheet.mjs";
import { SW25MonsterSheet, initializeMonsterSheetKnowledgeSync } from "./module/actor/monster-sheet.mjs";
import { SW25NPCSheet } from "./module/actor/npc-sheet.mjs";
import { SW25FellowSheet } from "./module/actor/fellow-sheet.mjs";
import { SW25ItemSheet } from "./module/item/item-sheet.mjs";
import { SW25Importer } from "./module/importer/sw25-importer.mjs";
import { resolveAttackingClass, rollWeaponDamage } from "./module/rules/weapon-roll.mjs";
import { rollMonsterKnowledge, findMonsterKnowledgeRoller } from "./module/combat/monster-knowledge.mjs";
import { initializeConcealedMainSection } from "./module/combat/concealed-main-section.mjs";
import { abilityBonus } from "./module/rules/weapon-damage.mjs";
import { RollModifiersDialog } from "./module/apps/roll-modifiers-dialog.mjs";
import { TargetSelectionDialog } from "./module/apps/target-selection-dialog.mjs";
import { initializeSideInitiative } from "./module/combat/side-initiative.mjs";
import { damageApplicationButton, initializeDamageApplication } from "./module/combat/damage-application.mjs";
import { addNaturalPowerMP } from "./module/rules/spell-damage.mjs";
import { initializeSpellEffects } from "./module/rules/spell-effects.mjs";
import { initializeEvasionChallenges } from "./module/combat/evasion-challenge.mjs";
import { criticalFailureHTML, markCriticalFailure } from "./module/rules/critical-failure.mjs";
import { initializeRecoveryItems } from "./module/rules/recovery-items.mjs";
import { initializeClassGrants } from "./module/rules/class-grants.mjs";
import { initializeStandardScenes } from "./module/scenes/standard-scenes.mjs";
import { initializeMonsterKnowledgeRegistry, getOrCreateMkRegistryFolder, getOrCreateSessionFolder, getOrCreateCampaignFolder } from "./module/knowledge/monster-knowledge-registry.mjs";
import { initializeMonsterKnowledgeRelay } from "./module/knowledge/mk-relay.mjs";
import { MKRegistryManagerApp } from "./module/ui/mk-registry-manager.mjs";
import { SW25EffectModel } from "./module/effects/effect-model.mjs";
import { initializeEffectService, registerSw25StackingResolver } from "./module/effects/effect-service.mjs";
import { initializeEffectRelay } from "./module/effects/effect-relay.mjs";
import { resolveSw25Stacking } from "./module/effects/stacking-resolver.mjs";
import { installSw25EffectiveValues, sw25EffectModifier } from "./module/effects/effective-values.mjs";
import { initializeDefeatedStatusSync } from "./module/actor/defeated-status.mjs";
import { initializePortraitGauges } from "./module/actor/portrait-gauges.mjs";
import { initializeResourceMaxima } from "./module/actor/resource-maxima.mjs";


Hooks.once("init", () => {
  game.sw25 = { importer: SW25Importer, mkRegistry: MKRegistryManagerApp };
  console.log("Sword World 2.5 | Initializing");

  // Register the system's ActiveEffect subtype data model (T1.2). The subtype
  // "sw25Effect" is declared in system.json documentTypes; this registration
  // must happen at init, before any effect of the subtype can be created.
  Object.assign(CONFIG.ActiveEffect.dataModels, {
    sw25Effect: SW25EffectModel
  });

  // Effective values pipeline (T3.2): the single processing point for the
  // system's persistent effects inside the Actor preparation flow (DEC-28).
  installSw25EffectiveValues();

  // HP → DEFEATED status sync: one GM-side `updateActor` listener keeps the
  // native Foundry DEFEATED status aligned with HP (≤ 0 applied, > 0
  // removed) across every HP write path. Native status only — it never
  // creates `sw25Effect` documents and never enters the duration engine,
  // which keeps consuming `Combatant#isDefeated` untouched.
  initializeDefeatedStatusSync();

  // Unified HP/MP maximum persistence (DEC-28 extension): both maxima are
  // derived by module/rules/resources.mjs, persisted on the actor by
  // lifecycle hooks (never a render side effect) so the native token bar
  // attributes can use both resources, and the GM-side initial migration
  // repairs existing actors (missing/zero `system.mp.max`).
  initializeResourceMaxima();

  // Central stacking resolver (Bloque 4/T4.4): the production registration of
  // the versioned policy resolver (DEC-44). With it, EffectService.apply
  // consults the approved stacking policies before any write; suites that
  // never register a resolver keep the documented "accumulate" default.
  registerSw25StackingResolver(resolveSw25Stacking);

  // Keep the system stylesheet after Foundry's core theme styles. Foundry V14
  // otherwise allows core form/button rules to win depending on load order.
  const stylesheetPath = "systems/sw25-taka/styles/sw25.css";
  const existingStylesheet = document.querySelector(`link[data-sw25-stylesheet]`);
  if (!existingStylesheet) {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = stylesheetPath;
    stylesheet.dataset.sw25Stylesheet = "true";
    document.head.appendChild(stylesheet);
  }

  CONFIG.Actor.trackableAttributes = {
    character: {
      bar: ["hp", "mp"],
      value: ["xp.total", "currency.gamels"]
    },
    monster: { bar: [], value: ["level", "initiative"] },
    npc: { bar: [], value: [] },
    fellow: { bar: [], value: [] }
  };

  foundry.documents.collections.Actors.unregisterSheet("core", foundry.appv1.sheets.ActorSheet);
  foundry.documents.collections.Actors.registerSheet("sw25-taka", SW25ActorSheet, {
    types: ["character"],
    makeDefault: true
  });
  foundry.documents.collections.Actors.registerSheet("sw25-taka", SW25MonsterSheet, {
    types: ["monster"],
    makeDefault: true
  });
  foundry.documents.collections.Actors.registerSheet("sw25-taka", SW25NPCSheet, {
    types: ["npc"],
    makeDefault: true
  });
  foundry.documents.collections.Actors.registerSheet("sw25-taka", SW25FellowSheet, {
    types: ["fellow"],
    makeDefault: true
  });

  foundry.documents.collections.Items.unregisterSheet("core", foundry.appv1.sheets.ItemSheet);
  foundry.documents.collections.Items.registerSheet("sw25-taka", SW25ItemSheet, {
    types: ["race", "class", "feat", "ability", "weapon", "armour", "skill", "spell", "equipment"],
    makeDefault: true
  });

  game.settings.register("sw25-taka", "standardScenesCreated", {
    scope:"world",
    config:false,
    type:Boolean,
    default:false
  });
  // Monster Knowledge Registry (module/knowledge/): schema v2 store. Only the
  // registry service writes this setting.
  game.settings.register("sw25-taka", "mkRegistry", {
    scope:"world",
    config:false,
    type:Object,
    default:{}
  });

  // Monster Knowledge Manager menu (F3): opens the GM-only registry
  // management window from Configure Settings → Sword World 2.5.
  game.settings.registerMenu("sw25-taka", "mkRegistryManager", {
    name: "Monster Knowledge Manager",
    label: "Open MKM",
    hint: "Manage Monster Knowledge discoveries by session and campaign.",
    icon: "fa-solid fa-book-open",
    type: MKRegistryManagerApp,
    restricted: true
  });
});

Hooks.on("preCreateActor", actor => {
  if (actor.type === "character") actor.updateSource({ "prototypeToken.actorLink":true });
});

Hooks.on("preCreateToken", token => {
  const actor = token.actor ?? game.actors.get(token.actorId);
  if (actor?.type === "character") token.updateSource({ actorLink:true });
});

Hooks.once("ready", initializeSideInitiative);
Hooks.once("ready", initializeDamageApplication);
Hooks.once("ready", initializeSpellEffects);
Hooks.once("ready", initializeEvasionChallenges);
Hooks.once("ready", initializeRecoveryItems);
Hooks.once("ready", initializeClassGrants);
Hooks.once("ready", initializeStandardScenes);
Hooks.once("ready", initializeConcealedMainSection);
Hooks.once("ready", initializeMonsterKnowledgeRegistry);
Hooks.once("ready", initializeMonsterKnowledgeRelay);
// EffectService (T2.1): write guards for the system's sw25Effect subtype.
// Effect relay (T2.2): player -> GM transport for persistent effect writes.
// Both are wired separately from the Monster Knowledge relay (functional
// separation required by DEC-36); they register on the same shared socket
// channel but dispatch by their own `effect-*` actions.
Hooks.once("ready", initializeEffectService);
Hooks.once("ready", initializeEffectRelay);
// F2-T2 consumer integration: open monster sheets repaint their Weak Point
// indicator when the Monster Knowledge Registry setting changes on this client.
Hooks.once("ready", initializeMonsterSheetKnowledgeSync);
// Portrait resource gauges (Light character sheet): draws the HP/MP arcs
// around the portrait frame and wires the discrete logo toggle that switches
// between the rectangular frame and the circular medallion variants.
Hooks.once("ready", initializePortraitGauges);

Hooks.on("renderItemDirectory", (_application, html) => {
  if (!game.user.can("ITEM_CREATE")) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector("[data-sw25-directory-import]")) return;
  const actions = root.querySelector(".header-actions") || root.querySelector(".directory-header");
  if (!actions) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sw25-directory-import";
  button.dataset.sw25DirectoryImport = "true";
  button.innerHTML = '<i class="fas fa-file-import"></i> Import SW2.5 Item';
  button.title = "Import an item from the Sword World 2.5 Reference Wiki";
  button.addEventListener("click", event => {
    event.preventDefault();
    SW25Importer.open(null);
  });
  actions.append(button);
});

// GM-only "Import Monster" entry point on the Actors directory. Opens the
// existing monster import selection interface and creates a new Actor from the
// imported data, which then appears in the Actors directory automatically.
Hooks.on("renderActorDirectory", (_application, html) => {
  if (!game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector("[data-sw25-directory-import-monster]")) return;
  const actions = root.querySelector(".header-actions") || root.querySelector(".directory-header");
  if (!actions) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sw25-directory-import-monster";
  button.dataset.sw25DirectoryImportMonster = "true";
  button.innerHTML = '<i class="fas fa-file-import"></i> Import Monster';
  button.title = "Import a monster from the Sword World 2.5 Reference Wiki as a new Actor";
  button.addEventListener("click", event => {
    event.preventDefault();
    SW25Importer.openMonsterImport();
  });
  actions.append(button);
});

Hooks.on("renderChatMessageHTML", (message, html) => {
  if (message.getFlag("sw25-taka", "naturalPowerAdded")) {
    const button = html.querySelector("[data-sw25-chat-action='add-natural-power']");
    if (button) {
      button.disabled = true;
      button.innerHTML = '<i class="fas fa-check"></i> MP Added';
    }
  }

  html.querySelectorAll("[data-sw25-chat-action='add-natural-power']").forEach(button => {
    button.addEventListener("click", async event => {
      event.preventDefault();
      const actor = game.actors.get(button.dataset.actorId);
      if (!actor?.isOwner) return ui.notifications.warn("You do not own the character receiving this MP.");
      if (message.getFlag("sw25-taka", "naturalPowerAdded")) return ui.notifications.warn("This Natural Power result has already been added.");
      button.disabled = true;
      await addNaturalPowerMP(actor, Number(button.dataset.mp || 0));
      await message.setFlag("sw25-taka", "naturalPowerAdded", true);
      button.innerHTML = '<i class="fas fa-check"></i> MP Added';
    });
  });

  html.querySelectorAll("[data-sw25-chat-action='roll-spell-damage']").forEach(button => {
    button.addEventListener("click", async event => {
      event.preventDefault();
      const actor = game.actors.get(button.dataset.actorId);
      const spell = actor?.items.get(button.dataset.itemId);
      const castingClass = actor?.items.get(button.dataset.classId);
      if (!actor || !spell || !castingClass) return ui.notifications.warn("The actor, spell, or casting class could not be found.");
      button.disabled = true;
      const roll = await new Roll("2d6").evaluate();
      const criticalFailure = await markCriticalFailure(actor, roll);
      if (criticalFailure) {
        await roll.toMessage({ speaker:ChatMessage.getSpeaker({ actor }), flavor:`<div class="sw25-chat-card"><h3>${foundry.utils.escapeHTML(spell.name)} Damage</h3>${criticalFailureHTML()}<p>No damage is dealt.</p></div>` });
        return;
      }
      const diceTotal = Number(roll.total ?? 0);
      const lookup = String(Math.min(12, Math.max(3, diceTotal)));
      const tableValue = Number(spell.system.powerTable?.[lookup] ?? 0);
      // Effective Magic Power (DEC-28): base formula + the prepared effect
      // ledger's combat.magicPower entry (ability mods already flow through
      // abilityBonus). No independent effect reconstruction here.
      const magicPower = Number(castingClass.system.level ?? 0)
        + abilityBonus(actor.system, "intelligence")
        + sw25EffectModifier(actor, "combat.magicPower");
      const total = tableValue + magicPower;
      // DEC-6: the Success Value is the result of the CASTING roll (this 2d6
      // + Magic Power), never the damage total. A natural 12 (double 6s) is
      // an automatic success and adds the +5 critical rule (Core Rulebook I
      // pp. 91/167). The spell's own critical threshold affects damage only,
      // not the SV. Critical failure (double 1s) already returned above.
      const spellSuccessValue = diceTotal + (diceTotal === 12 ? 5 : 0) + magicPower;
      const critical = Number(spell.system.critical ?? 0);
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="sw25-chat-card sw25-spell-power-result"><h3>${foundry.utils.escapeHTML(spell.name)} Damage</h3><p><strong>Power roll:</strong> ${diceTotal} â†’ ${tableValue}</p><p><strong>Magic Power:</strong> ${magicPower}</p><p class="sw25-weapon-total"><strong>Total:</strong> ${total}</p>${damageApplicationButton(total, "magical", true, null, null, spell.uuid, { successValue: spellSuccessValue, casterUuid: actor.uuid })}${critical && diceTotal >= critical ? '<p class="sw25-critical">CRITICAL</p>' : ""}</div>`
      });
    });
  });

  html.querySelectorAll("[data-sw25-chat-action='roll-critical-damage']").forEach(button => {
    button.addEventListener("click", async event => {
      event.preventDefault();
      const actor = game.actors.get(button.dataset.actorId);
      const weapon = actor?.items.get(button.dataset.itemId);
      const attackingClass = actor && weapon
        ? resolveAttackingClass(actor, weapon, button.dataset.classId)
        : null;
      if (!actor || !weapon || !attackingClass) {
        ui.notifications.warn("The actor, weapon, or attacking class could not be found.");
        return;
      }
      if (weapon.system?.artificerPowered) return ui.notifications.info("Gun damage is rolled through its bullet spell.");
      button.disabled = true;
      await rollWeaponDamage({
        actor,
        weapon,
        attackingClass,
        accumulatedPower: Number(button.dataset.accumulatedPower ?? 0),
        combatStyleId: button.dataset.combatStyleId ?? null,
        targetActorUuid: button.dataset.targetId ?? null
      });
    });
  });

  html.querySelectorAll("[data-sw25-chat-action='roll-weapon-damage']").forEach(button => {
    button.addEventListener("click", async event => {
      event.preventDefault();
      const card = event.currentTarget.closest(".sw25-chat-card");
      const actor = game.actors.get(card?.dataset.actorId);
      const weapon = actor?.items.get(card?.dataset.itemId);
      if (!actor || !weapon) {
        ui.notifications.warn("The weapon or actor could not be found.");
        return;
      }
      if (weapon.system?.artificerPowered) return ui.notifications.info("Gun damage is rolled through its bullet spell.");

      const formula = weapon.system.damageFormula || "2d6";
      try {
        const roll = await new Roll(formula).evaluate();
        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor }),
          flavor: `${weapon.name} Damage â€” Power ${Number(weapon.system.power ?? 0)}, Critical ${Number(weapon.system.critical ?? 10)}`
        });
      } catch (error) {
        console.error("Sword World 2.5 | Invalid weapon damage formula", error);
        ui.notifications.error(`Invalid damage formula: ${formula}`);
      }
    });
  });

  html.querySelectorAll("[data-sw25-chat-action='roll-monster-knowledge-request']").forEach(button => {
    button.addEventListener("click", async event => {
      event.preventDefault();
      const monsterUuid = button.dataset.mkMonsterUuid;
      let monster = null;
      if (typeof fromUuid === "function") {
        monster = await fromUuid(monsterUuid);
      } else {
        monster = game.actors.get(monsterUuid);
      }
      if (!monster || monster.type !== "monster") {
        ui.notifications.warn("The target monster could not be found.");
        return;
      }
      const roller = findMonsterKnowledgeRoller();
      if (!roller.actor) {
        ui.notifications.warn(roller.status === "ambiguous"
          ? "Select exactly one character token to make this Monster Knowledge roll."
          : "No active character assigned. Assign a character or select one character token first.");
        return;
      }
      await rollMonsterKnowledge({
        actor: roller.actor,
        targetMonster: monster,
        shiftKey: Boolean(event.shiftKey)
      });
    });
  });

  html.querySelectorAll("[data-target]").forEach(button => {
    button.addEventListener("click", event => {
      const target = event.currentTarget.dataset.target;
      const detail = document.getElementById(target);
      if (detail) {
        const hidden = detail.style.display === "none";
        detail.style.display = hidden ? "block" : "none";
      }
    });
  });
});