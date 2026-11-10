// Sword World 2.5 - Monster Knowledge Registry management UI (F3).
//
// A single GM-owned ApplicationV1 window for consulting and managing the
// Monster Knowledge Registry (module/knowledge/). It is the only UI surface
// for the registry; it reads and writes exclusively through the F1 service
// (module/knowledge/monster-knowledge-registry.mjs) and never touches
// game.settings directly.
//
// Two views:
//   - "records": initial screen listing sessions and campaigns together,
//     with the Active/Inactive label, the Active toggle and the red record
//     delete X per row. Actions: New Campaign, New Session, toggle active,
//     delete record, open detail.
//   - "detail": reusable detail for one record (session or campaign),
//     showing its discoveries with a per-species red X (direct entry
//     removal, any level), a manual "Add Monster" action (Actor pick or
//     species text) and a full reset, all with confirmation.
//
// Singleton: a second opening re-renders the live instance. GM-only access
// is enforced at open time and re-checked inside every internal operation.

import {
  readMkRegistry,
  readMkActiveRecord,
  readMkSessions,
  readMkCampaigns,
  readMkDiscoveries,
  startMkSession,
  createMkCampaign,
  activateMkCampaign,
  activateMkSession,
  deleteMkCampaign,
  deleteMkRecord,
  deleteMkDiscovery,
  registerMkDiscovery,
  resetMkKnowledge,
  mkCapabilitiesOf,
  monsterKnowledgeRegistry,
  getMkSpeciesLevel,
  countSpeciesWithKnowledge
} from "../knowledge/monster-knowledge-registry.mjs";
import { normalizeSpeciesId } from "../knowledge/mk-identity.mjs";
import { publishMkBestiaryReveal } from "../knowledge/mk-relay.mjs";

const APP_ID = "sw25-mk-registry-manager";
const TITLE = "Monster Knowledge Manager";

const TYPE_LABELS = {
  session: "Session",
  campaign: "Campaign"
};

const TYPE_CHIPS = {
  session: "sw25-mk-chip session",
  campaign: "sw25-mk-chip campaign"
};

/**
 * Human-friendly timestamp for the detail header (single line, e.g.
 * "Nov 10, 2026, 9:35 PM"). Returns null for records without a parseable
 * creation date so the template omits the chip instead of printing "Invalid
 * Date". Locale-tolerant: never throws on exotic dates.
 * @param {unknown} value - Raw createdAt epoch (or null/undefined).
 * @returns {string|null} Formatted date/time label or null.
 */
function formatMkTimestamp(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return null;
  }
}

// ── Confirmation dialog (reusable, promise-based) ─────────────────────────

function confirmDialog({ title, message, confirmLabel, cancelLabel, destructive = false }) {
  return new Promise(resolve => {
    new Dialog({
      title,
      content: `<p>${foundry.utils.escapeHTML(message)}</p>`,
      buttons: {
        cancel: {
          label: cancelLabel ?? "Cancel",
          callback: () => resolve(false),
          icon: '<i class="fas fa-ban"></i>'
        },
        confirm: {
          label: confirmLabel ?? "Confirm",
          callback: () => resolve(true),
          icon: destructive ? '<i class="fas fa-trash"></i>' : '<i class="fas fa-check"></i>'
        }
      },
      default: "cancel",
      close: () => resolve(false)
    }).render(true);
  });
}

// ── Name input dialog (reusable, promise-based) ───────────────────────────

function inputNameDialog({ title, placeholder, confirmLabel }) {
  return new Promise(resolve => {
    const content = `
      <form class="sw25-mk-name-form">
        <div class="form-group">
          <label>${foundry.utils.escapeHTML(title)}</label>
          <input type="text" name="record-name" placeholder="${foundry.utils.escapeHTML(placeholder ?? "")}" />
        </div>
      </form>
    `;
    new Dialog({
      title,
      content,
      buttons: {
        cancel: {
          label: "Cancel",
          callback: () => resolve(null),
          icon: '<i class="fas fa-ban"></i>'
        },
        confirm: {
          label: confirmLabel ?? "Create",
          callback: html => {
            const input = html.find("[name='record-name']").get(0);
            resolve(input ? String(input.value ?? "").trim() : null);
          },
          icon: '<i class="fas fa-plus"></i>'
        }
      },
      default: "confirm",
      close: () => resolve(null)
    }).render(true);
  });
}

// ── Error translation ─────────────────────────────────────────────────────

// ── Add Monster dialog (reusable, promise-based) ─────────────────────────

/**
 * Modal to add a monster manually to the target record, with two coexisting
 * modes: select a monster Actor of the world (the species is derived from it,
 * and the Bestiary copy follows like in the roll flow), or enter species free
 * text (no Actor: the entry is registered without a Bestiary copy). Always
 * asks for the knowledge level to set.
 * @param {object} [param] - Parameters.
 * @param {Array<{id: string, name: string}>} [param.monsterOptions] - Monster Actor choices.
 * @returns {Promise<{monsterId: string, speciesText: string, level: string}|null>}
 */
function addMonsterDialog({ monsterOptions = [] } = {}) {
  return new Promise(resolve => {
    const optionHtml = monsterOptions
      .map(entry => `<option value="${foundry.utils.escapeHTML(entry.id)}">${foundry.utils.escapeHTML(entry.name)}</option>`)
      .join("");
    const content = `
      <form class="sw25-mk-name-form">
        <div class="form-group">
          <label>Monster Actor (optional: its species is registered and a Bestiary copy is created)</label>
          <select name="mk-monster">
            <option value="">— No Actor: species text only —</option>
            ${optionHtml}
          </select>
        </div>
        <div class="form-group">
          <label>Species (used when no Actor is selected)</label>
          <input type="text" name="mk-species" placeholder="e.g. Goblin" />
        </div>
        <div class="form-group">
          <label>Knowledge level</label>
          <select name="mk-level">
            <option value="reputation">Reputation</option>
            <option value="weakness">Weakness</option>
          </select>
        </div>
      </form>
    `;
    new Dialog({
      title: "Add Monster",
      content,
      buttons: {
        cancel: {
          label: "Cancel",
          callback: () => resolve(null),
          icon: '<i class="fas fa-ban"></i>'
        },
        confirm: {
          label: "Add",
          callback: html => {
            const monsterSelect = html.find("[name='mk-monster']").get(0);
            const speciesInput = html.find("[name='mk-species']").get(0);
            const levelSelect = html.find("[name='mk-level']").get(0);
            resolve({
              monsterId: monsterSelect ? String(monsterSelect.value ?? "").trim() : "",
              speciesText: speciesInput ? String(speciesInput.value ?? "").trim() : "",
              level: levelSelect?.value === "weakness" ? "weakness" : "reputation"
            });
          },
          icon: '<i class="fas fa-plus"></i>'
        }
      },
      default: "confirm",
      close: () => resolve(null)
    }).render(true);
  });
}

function serviceErrorMessage(result) {
  const code = result.code ?? "error";
  const detail = result.error ?? "";
  const map = {
    "not-gm": "Only the Game Master can modify the Monster Knowledge Registry.",
    "version-too-new": "The registry was written by a newer schema version; writes are refused until the system is updated.",
    "no-species": "A monster species identifier is required.",
    "no-active-record": "The registry has no active record to operate on.",
    "record-not-found": "No registry record matches that identifier.",
    "capability-denied": "This model does not allow that operation.",
    "persist-failed": "Could not save the change to the Monster Knowledge Registry.",
    "mutation-failed": "The registry operation failed.",
    "missing-name": "A campaign requires a visible name.",
    "folder-creation-failed": "Could not create the Monster Knowledge Bestiary folder.",
    "folder-deletion-failed": "Could not delete the Monster Knowledge Bestiary folder.",
    "folder-reconciliation-failed": "Could not reconcile the Monster Knowledge Bestiary folders.",
    "folder-conflict": "Multiple 'Current Session' folders found; reconciliation is required."
  };
  const base = map[code] ?? detail ?? "Operation failed.";
  return `${base} ${code !== "error" ? `(${code})` : ""}`.trim();
}

/**
 * Legacy Observer ownership note (Fase 4).
 *
 * The pre-Bestiary mechanism granted and revoked OBSERVER ownership directly
 * on the ORIGINAL monster Actors. The approved Fase 4 model replaces it:
 * discoveries are represented by independent Bestiary copies (default
 * OBSERVER ownership) and the original Actors are never modified by Monster
 * Knowledge operations — including withdrawals, resets and campaign
 * deletions. Historical Actor permissions granted by the legacy flow cannot
 * be safely distinguished from GM-manual grants, so they are NOT modified
 * automatically and require manual migration if desired.
 */

// ── Application ───────────────────────────────────────────────────────────

export class MKRegistryManagerApp extends foundry.appv1.api.FormApplication {
  static instance = null;

  constructor(...args) {
    super(...args);
    this._view = "records";
    this._targetRecord = null;
    this._closing = false;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: APP_ID,
      classes: ["sw25", "sw25-mk-registry-manager"],
      template: "systems/sword-world-25/templates/ui/mk-registry-manager.hbs",
      title: TITLE,
      width: 900,
      height: 650,
      resizable: true,
      minimizable: true,
      popOut: true,
      submitOnClose: false
    });
  }

  /** Open (or re-render) the singleton window. GM-only. */
  static async open() {
    if (game?.user?.isGM !== true) {
      ui.notifications.warn("Only the Game Master can open the Monster Knowledge Manager.");
      return null;
    }
    if (!MKRegistryManagerApp.instance) {
      MKRegistryManagerApp.instance = new MKRegistryManagerApp({}, {});
    }
    MKRegistryManagerApp.instance._view = "records";
    MKRegistryManagerApp.instance._targetRecord = null;
    await MKRegistryManagerApp.instance.render(true);
    return MKRegistryManagerApp.instance;
  }

  /** Guard: reject any internal write when the current user is not GM. */
  _assertGm() {
    if (game?.user?.isGM !== true) {
      throw new Error("not-gm");
    }
  }

  /**
   * No persistent object to update: this window manages the registry through
   * the F1 service directly, not through a FormApplication data object.
   */
  _updateObject(formData) {
    // Intentionally empty: no object to persist.
  }

  async getData() {
    const state = { view: this._view, target: this._targetRecord };
    if (this._view === "records") {
      const registry = readMkRegistry();
      const active = readMkActiveRecord();
      const sessions = readMkSessions();
      const campaigns = readMkCampaigns();
      // readMkActiveRecord returns the {ok, data} contract envelope.
      const activeKind = active.ok ? (active.data?.kind ?? null) : null;
      const activeId = active.ok ? (active.data?.id ?? null) : null;
      const records = [];
      for (const session of sessions.data ?? []) {
        const isActive = activeKind === "session" && activeId === session.id;
        records.push({
          kind: "session",
          id: session.id,
          name: session.name,
          active: isActive,
          // Active/Inactive label shown in the main list, right of the Open
          // button (moved here from the detail header).
          statusLabel: isActive ? "Active" : "Inactive",
          statusClass: isActive ? "sw25-mk-record-status active" : "sw25-mk-record-status inactive",
          discoveries: Array.isArray(session.discoveries) ? session.discoveries.length : 0,
          status: session.status,
          chipClass: TYPE_CHIPS.session,
          typeLabel: TYPE_LABELS.session,
          isSession: true,
          isCampaign: false,
          isSingular: Array.isArray(session.discoveries) ? session.discoveries.length === 1 : true
        });
      }
      for (const campaign of campaigns.data ?? []) {
        const isActive = activeKind === "campaign" && activeId === campaign.id;
        records.push({
          kind: "campaign",
          id: campaign.id,
          name: campaign.name,
          active: isActive,
          statusLabel: isActive ? "Active" : "Inactive",
          statusClass: isActive ? "sw25-mk-record-status active" : "sw25-mk-record-status inactive",
          discoveries: campaign.discoveriesCount ?? 0,
          status: campaign.status,
          chipClass: TYPE_CHIPS.campaign,
          typeLabel: TYPE_LABELS.campaign,
          isSession: false,
          isCampaign: true,
          isSingular: campaign.discoveriesCount === 1
        });
      }
      // Most recent first (by createdAt when available).
      records.sort((a, b) => {
        const ta = a.createdAt ?? 0;
        const tb = b.createdAt ?? 0;
        return tb - ta;
      });
      state.records = records;
      state.activeKind = activeKind;
      state.activeId = activeId;
    } else if (this._view === "detail" && this._targetRecord) {
      const recordId = this._targetRecord.id;
      const discoveries = readMkDiscoveries(recordId);
      const capabilities = mkCapabilitiesOf(this._targetRecord);
      const record = this._targetRecord;
      state.record = {
        kind: record.kind,
        id: record.id,
        name: record.name,
        active: record.active ?? false,
        // Session registry line: the Session chip plus the session's start
        // date/time (record creation). Campaigns show name + Active state.
        startedAtLabel: formatMkTimestamp(record.createdAt),
        typeLabel: TYPE_LABELS[record.kind] ?? record.kind,
        chipClass: TYPE_CHIPS[record.kind] ?? "sw25-mk-chip",
        isSession: record.kind === "session",
        isCampaign: record.kind === "campaign",
        isCampaignAndCanDelete: record.kind === "campaign" && Boolean(capabilities.deleteRecord)
      };
      state.discoveries = (discoveries.ok ? discoveries.data : []).map(d => {
        // The discoverer is the CHARACTER that made the roll (actorUuid /
        // actorName), never the original monster Actor (monsterUuid) nor the
        // Bestiary copy. Fall back to resolving the character Actor document.
        // GM-manual entries never credit a character: they render as "GM"
        // instead of exposing the raw registering user id.
        const discoverer = d.actorUuid && game?.actors ? game.actors.get(d.actorUuid) : null;
        const discovererName = d.actorName ?? discoverer?.name ?? null;
        const fallbackName = d.source === "gm-manual" ? "GM" : (d.discoveredBy ?? "");
        return {
          ...d,
          isRoll: d.source === "roll",
          isGm: d.source === "gm-manual",
          discoveredByActorName: discovererName ?? fallbackName,
          // The knowledge level is communicated ONLY by the species pill
          // colour; the row keeps a neutral background.
          levelLabel: d.level === "weakness" ? "Weakness discovered" : "Reputation identified",
          levelPillClass: d.level === "weakness" ? "sw25-mk-level-weakness" : "sw25-mk-level-reputation"
        };
      });
      state.capabilities = capabilities;
      state.canWithdraw = Boolean(capabilities.individualWithdraw);
      state.canReset = Boolean(capabilities.restart);
      state.canDelete = Boolean(capabilities.deleteRecord);
    }
    state.viewIsRecords = this._view === "records";
    state.viewIsDetail = this._view === "detail";
    return state;
  }

  activateListeners(html) {
    super.activateListeners(html);

    // ── Global: close returns to the initial screen from a detail view ──
    html.find("[data-action='mk-back']").on("click", event => {
      event.preventDefault();
      this._view = "records";
      this._targetRecord = null;
      this.render(false);
    });

    // ── Global: open detail for a record ──
    html.find("[data-action='mk-open-record']").on("click", event => {
      event.preventDefault();
      const button = event.currentTarget;
      const kind = button.dataset.mkKind;
      const id = button.dataset.mkId;
      if (!kind || !id) return;
      this._openRecord(kind, id);
    });

    // ── New Campaign ──
    html.find("[data-action='mk-new-campaign']").on("click", async event => {
      event.preventDefault();
      this._assertGm();
      const name = await inputNameDialog({
        title: "New Campaign",
        placeholder: "Campaign name",
        confirmLabel: "Create Campaign"
      });
      if (name === null || !name) return; // cancelled or empty
      try {
        const result = await createMkCampaign({ name });
        if (!result.ok) {
          ui.notifications.warn(serviceErrorMessage(result));
          return;
        }
        ui.notifications.info(`Campaign "${foundry.utils.escapeHTML(name)}" created.`);
        this._view = "records";
        this._targetRecord = null;
        this.render(false);
      } catch (error) {
        ui.notifications.error(serviceErrorMessage({ code: error?.code ?? "mutation-failed", error: error?.message ?? String(error) }));
      }
    });

    // ── New Session ──
    html.find("[data-action='mk-new-session']").on("click", async event => {
      event.preventDefault();
      this._assertGm();
      const active = readMkActiveRecord();
      // readMkActiveRecord returns the {ok, data} contract envelope.
      const activeData = active.ok ? (active.data ?? null) : null;
      const currentSession = activeData?.kind === "session" && activeData?.record ? activeData.record : null;
      let warning = "Creating a new active session. The previous session record is not preserved.";
      if (currentSession && Array.isArray(currentSession.discoveries) && currentSession.discoveries.length > 0) {
        warning += ` The current active session (${foundry.utils.escapeHTML(currentSession.name)}) has ${currentSession.discoveries.length} discovery(dies) that will be lost.`;
      }
      const confirmed = await confirmDialog({
        title: "New Session",
        message: warning,
        confirmLabel: "Create Session",
        cancelLabel: "Cancel",
        destructive: true
      });
      if (!confirmed) return;
      try {
        const result = await startMkSession({ name: null });
        if (!result.ok) {
          ui.notifications.warn(serviceErrorMessage(result));
          return;
        }
        ui.notifications.info(`New active session: ${foundry.utils.escapeHTML(result.data.name)}.`);
        this._view = "records";
        this._targetRecord = null;
        this.render(false);
      } catch (error) {
        ui.notifications.error(serviceErrorMessage({ code: error?.code ?? "mutation-failed", error: error?.message ?? String(error) }));
      }
    });

    // ── List: set the row's record as the active register ──
    html.find("[data-action='mk-toggle-record']").on("click", async event => {
      event.preventDefault();
      const button = event.currentTarget;
      const kind = button.dataset.mkKind;
      const id = button.dataset.mkId;
      // The active register is never cleared from the list: the toggle only
      // ACTIVATES an inactive record (the active row's button is disabled).
      // Exactly one register is active at all times, defaulting to a session.
      if (!kind || !id || button.dataset.mkActive === "1") return;
      this._assertGm();
      try {
        // Activating moves the single active pointer to this record, which
        // takes it away from whichever record was active before.
        const result = kind === "campaign" ? await activateMkCampaign(id) : await activateMkSession(id);
        if (!result.ok) {
          ui.notifications.warn(serviceErrorMessage(result));
          return;
        }
        this.render(false);
      } catch (error) {
        ui.notifications.error(serviceErrorMessage({ code: error?.code ?? "mutation-failed", error: error?.message ?? String(error) }));
      }
    });

    // ── List: red X — delete the whole record as a GM correction ──
    html.find("[data-action='mk-delete-record']").on("click", async event => {
      event.preventDefault();
      this._assertGm();
      const button = event.currentTarget;
      const kind = button.dataset.mkKind;
      const id = button.dataset.mkId;
      const name = String(button.dataset.mkName ?? kind);
      const removed = Number(button.dataset.mkDiscoveries ?? 0) || 0;
      if (!kind || !id) return;
      const kindLabel = kind === "campaign" ? "campaign" : "session";
      const confirmed = await confirmDialog({
        title: "Delete Record",
        message: `Delete the ${kindLabel} "${foundry.utils.escapeHTML(name)}" and its ${removed} discovery(dies), together with their managed Bestiary copies? This action cannot be undone.`,
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        destructive: true
      });
      if (!confirmed) return;
      try {
        // deleteMkRecord is the manager red X: an explicit GM correction, not
        // gated by the record policy (sessions are removable too). Original
        // monster Actors are never touched.
        const result = await deleteMkRecord(id);
        if (!result.ok) {
          ui.notifications.warn(serviceErrorMessage(result));
          return;
        }
        ui.notifications.info(`Record "${foundry.utils.escapeHTML(name)}" deleted.`);
        if (this._view === "detail" && this._targetRecord?.id === id) {
          this._view = "records";
          this._targetRecord = null;
        }
        this.render(false);
      } catch (error) {
        ui.notifications.error(serviceErrorMessage({ code: error?.code ?? "mutation-failed", error: error?.message ?? String(error) }));
      }
    });

    // ── Detail: Activate record (session or campaign) ──
    html.find("[data-action='mk-activate-record']").on("click", async event => {
      event.preventDefault();
      this._assertGm();
      if (!this._targetRecord) return;
      const kind = this._targetRecord.kind;
      const id = this._targetRecord.id;
      try {
        // Activating one record moves the single active pointer to it, which
        // deactivates whichever record was active before (D6).
        const result = kind === "campaign" ? await activateMkCampaign(id) : await activateMkSession(id);
        if (!result.ok) {
          ui.notifications.warn(serviceErrorMessage(result));
          return;
        }
        const label = kind === "campaign" ? "Campaign" : "Session";
        ui.notifications.info(`${label} activated: ${foundry.utils.escapeHTML(this._targetRecord.name)}.`);
        this.render(false);
      } catch (error) {
        ui.notifications.error(serviceErrorMessage({ code: error?.code ?? "mutation-failed", error: error?.message ?? String(error) }));
      }
    });

    // ── Detail: Delete Campaign ──
    html.find("[data-action='mk-delete-campaign']").on("click", async event => {
      event.preventDefault();
      this._assertGm();
      if (!this._targetRecord || this._targetRecord.kind !== "campaign") return;
      const removed = this._targetRecord.discoveries ?? 0;
      const confirmed = await confirmDialog({
        title: "Delete Campaign",
        message: `Delete the campaign "${foundry.utils.escapeHTML(this._targetRecord.name)}" and its ${removed} discovery(dies)? This action cannot be undone.`,
        confirmLabel: "Delete Campaign",
        cancelLabel: "Cancel",
        destructive: true
      });
      if (!confirmed) return;
      try {
        // Legacy behaviour retired (Fase 4): withdrawing, resetting or
        // deleting knowledge no longer touches the ownership of the original
        // monster Actors. Only the Registry and the managed Bestiary copies
        // change.
        const result = await deleteMkCampaign(this._targetRecord.id);
        if (!result.ok) {
          ui.notifications.warn(serviceErrorMessage(result));
          return;
        }
        ui.notifications.info(`Campaign "${foundry.utils.escapeHTML(this._targetRecord.name)}" deleted.`);
        this._view = "records";
        this._targetRecord = null;
        this.render(false);
      } catch (error) {
        ui.notifications.error(serviceErrorMessage({ code: error?.code ?? "mutation-failed", error: error?.message ?? String(error) }));
      }
    });

    // ── Detail: Remove Species (direct removal, any knowledge level) ──
    html.find("[data-action='mk-remove-species']").on("click", async event => {
      event.preventDefault();
      // Without GM authority the removal cannot run: inform clearly and
      // change NOTHING locally (the registry service stays the only writer).
      if (game?.user?.isGM !== true) {
        ui.notifications.warn("Only the Game Master can remove Monster Knowledge entries. No change was made.");
        return;
      }
      this._assertGm();
      if (!this._targetRecord) return;
      const button = event.currentTarget;
      const speciesId = button.dataset.mkSpeciesId;
      const speciesLabel = button.dataset.mkSpeciesLabel;
      if (!speciesId) return;
      const confirmed = await confirmDialog({
        title: "Remove Species",
        message: `Remove "${foundry.utils.escapeHTML(speciesLabel ?? speciesId)}" from "${foundry.utils.escapeHTML(this._targetRecord.name)}"? The discovery entry is deleted at ANY knowledge level (reputation or weakness) and its Bestiary copy is deleted; the original monster Actor is untouched. This is intended to correct roll errors.`,
        confirmLabel: "Remove",
        cancelLabel: "Cancel",
        destructive: true
      });
      if (!confirmed) return;
      try {
        // deleteMkDiscovery deletes the entry entirely (reputation OR
        // weakness) and the service deletes its Bestiary copy with it. The
        // original monster Actor ownership is never modified.
        const result = await deleteMkDiscovery({ speciesIdentifier: speciesId, recordId: this._targetRecord.id });
        if (!result.ok) {
          ui.notifications.warn(serviceErrorMessage(result));
          return;
        }
        ui.notifications.info(`Entry for "${foundry.utils.escapeHTML(speciesLabel ?? speciesId)}" removed.`);
        this._refreshDetail();
      } catch (error) {
        ui.notifications.error(serviceErrorMessage({ code: error?.code ?? "mutation-failed", error: error?.message ?? String(error) }));
      }
    });

    // ── Detail: Add Monster manually (Actor pick or species text) ──
    html.find("[data-action='mk-add-monster']").on("click", async event => {
      event.preventDefault();
      this._assertGm();
      if (!this._targetRecord) return;
      // Monster Actors of the world are candidates; free species text is the
      // fallback when the species has no Actor (then no Bestiary copy).
      let monsterOptions = [];
      try {
        monsterOptions = [...(game?.actors?.values?.() ?? [])]
          .filter(entry => entry?.type === "monster")
          .map(entry => ({ id: entry.id, name: entry.name ?? entry.id }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      } catch {
        monsterOptions = [];
      }
      const input = await addMonsterDialog({ monsterOptions });
      if (!input) return; // cancelled
      this._assertGm();
      const level = input.level === "weakness" ? "weakness" : "reputation";
      // Attribution: GM-manual entries never credit a character; the GM is
      // only the registering user.
      const baseEvidence = {
        className: null,
        classResult: null,
        actorUuid: null,
        actorName: null,
        level,
        source: "gm-manual",
        discoveredBy: game?.user?.id ?? null
      };
      let speciesLabel = null;
      let result = null;

      if (input.monsterId) {
        // Actor mode: the species is derived from the chosen monster Actor
        // (same derivation as the roll flow) and the Bestiary copy follows
        // the normal discovery path (registered/promoted/already-known).
        const actor = game?.actors?.get?.(input.monsterId) ?? null;
        if (!actor) {
          ui.notifications.warn("The selected monster Actor could not be resolved.");
          return;
        }
        const speciesRaw = actor?.system?.species ?? null;
        if (!speciesRaw) {
          ui.notifications.warn("The selected monster Actor has no species data. Add the species manually instead.");
          return;
        }
        speciesLabel = String(speciesRaw);
        result = await registerMkDiscovery({
          ...baseEvidence,
          speciesId: normalizeSpeciesId(speciesRaw),
          speciesLabel,
          monsterUuid: actor.uuid ?? null,
          monsterName: actor.name ?? null
        }, { recordId: this._targetRecord.id });
      } else {
        // Text mode: no source Actor, so no Bestiary copy can be created.
        const speciesText = String(input.speciesText ?? "").trim();
        if (!normalizeSpeciesId(speciesText)) {
          ui.notifications.warn("Enter a species name or select a monster Actor.");
          return;
        }
        speciesLabel = speciesText;
        result = await registerMkDiscovery({
          ...baseEvidence,
          speciesId: normalizeSpeciesId(speciesText),
          speciesLabel,
          monsterUuid: null,
          monsterName: null
        }, { recordId: this._targetRecord.id });
      }
      if (!result.ok) {
        ui.notifications.warn(serviceErrorMessage(result));
        return;
      }
      if (result.data?.bestiaryCopyFailed) {
        // Copy failures are action-relevant (players never get the actor
        // link) and must be visibly escalated, never silent.
        ui.notifications.warn(`Monster Knowledge Bestiary copy failed for species ${result.data.speciesId}: ${result.data.bestiaryCopyFailed}`);
      } else {
        const already = result.data.status === "already-known";
        ui.notifications.info(already
          ? `"${foundry.utils.escapeHTML(speciesLabel)}" was already registered in "${foundry.utils.escapeHTML(this._targetRecord.name)}".`
          : `"${foundry.utils.escapeHTML(speciesLabel)}" added to "${foundry.utils.escapeHTML(this._targetRecord.name)}" (${level}).`);
        // Manual additions reveal to players exactly like roll-flow
        // discoveries: the Bestiary copy grants default OBSERVER to ALL
        // players, so deliver the same reveal whisper to every active
        // player (no copy is published for the text mode / failures).
        if (result.data.bestiaryActorUuid) {
          await publishMkBestiaryReveal({
            speciesId: result.data.speciesId,
            bestiaryActorUuid: result.data.bestiaryActorUuid
          });
        }
      }
      this._refreshDetail();
    });

    // ── Detail: Reset Record ──
    html.find("[data-action='mk-reset-record']").on("click", async event => {
      event.preventDefault();
      this._assertGm();
      if (!this._targetRecord) return;
      const removed = this._targetRecord.discoveriesCount ?? this._targetRecord.discoveries?.length ?? 0;
      const confirmed = await confirmDialog({
        title: "Reset Record",
        message: `Remove all ${removed} discovery(dies) from "${foundry.utils.escapeHTML(this._targetRecord.name)}"? The record is kept empty. This action cannot be undone.`,
        confirmLabel: "Reset",
        cancelLabel: "Cancel",
        destructive: true
      });
      if (!confirmed) return;
      try {
        // Legacy behaviour retired (Fase 4): a reset only clears the Registry
        // record and deletes the managed Bestiary copies; the ownership of
        // the original monster Actors is never modified.
        const result = await resetMkKnowledge({ recordId: this._targetRecord.id });
        if (!result.ok) {
          ui.notifications.warn(serviceErrorMessage(result));
          return;
        }
        ui.notifications.info(`Record "${foundry.utils.escapeHTML(this._targetRecord.name)}" reset.`);
        this._refreshDetail();
      } catch (error) {
        ui.notifications.error(serviceErrorMessage({ code: error?.code ?? "mutation-failed", error: error?.message ?? String(error) }));
      }
    });
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  async _openRecord(kind, id) {
    this._assertGm();
    // Read the latest state for this record to display current data.
    let record = null;
    if (kind === "session") {
      const sessions = readMkSessions();
      record = (sessions.data ?? []).find(r => r.id === id) ?? null;
    } else if (kind === "campaign") {
      const campaigns = readMkCampaigns();
      record = (campaigns.data ?? []).find(r => r.id === id) ?? null;
    }
    if (!record) {
      ui.notifications.warn("The requested record was not found.");
      return;
    }
    const active = readMkActiveRecord();
    // readMkActiveRecord returns the {ok, data} contract envelope.
    const activeData = active.ok ? (active.data ?? null) : null;
    this._targetRecord = {
      kind: record.kind,
      id: record.id,
      name: record.name,
      active: activeData?.kind === record.kind && activeData?.id === record.id,
      createdAt: record.createdAt ?? null,
      discoveriesCount: Array.isArray(record.discoveries) ? record.discoveries.length : 0
    };
    this._view = "detail";
    this.render(false);
  }

  async _refreshDetail() {
    if (this._view !== "detail" || !this._targetRecord) return;
    // Re-read fresh data for the current record and re-render without
    // losing the user's place in the detail view.
    this.render(false);
  }

  async close(options = {}) {
    if (this._closing) return super.close(options);
    this._closing = true;
    MKRegistryManagerApp.instance = null;
    return super.close(options);
  }
}
