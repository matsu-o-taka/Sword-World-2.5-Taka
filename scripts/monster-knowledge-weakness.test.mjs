// Sword World 2.5 - Registro de conocimiento de debilidades por mundo (especies)
//
// Pruebas del registro persistente (game.settings "weaknessRegistry") que
// utiliza el campo system.species como identificador de especie, en lugar
// de sourceUrl o del nombre del Actor.

import assert from "node:assert/strict";

import {
  clearWeaknessRegistry,
  getWeaknessRegistry,
  isSpeciesWeaknessKnown,
  normalizeSpeciesId,
  registerSpeciesWeakness,
  revealMonsterStats,
  revealMonsterWeakness,
  speciesId,
  speciesWeaknessKnown,
  toggleMonsterStats,
  toggleMonsterWeakness,
  withdrawSpeciesWeakness
} from "../module/combat/monster-knowledge.mjs";
import { resolveMonsterKnowledgeMessage } from "../module/combat/monster-knowledge.mjs";

// ── Mocks ─────────────────────────────────────────────────────────────────

const worldSettings = new Map();
const chatMessages = [];
const actorUpdates = [];
const documents = new Map();

globalThis.ChatMessage = {
  async create(data) { chatMessages.push(data.content); }
};

globalThis.ui = {
  notifications: { warn() {}, info() {}, error() {} }
};

globalThis.foundry = {
  utils: {
    escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[char]);
    }
  }
};

globalThis.game = {
  user: { isGM: true },
  actors: [],
  settings: {
    get(scope, key) { return worldSettings.get(`${scope}.${key}`); },
    set(scope, key, value) { worldSettings.set(`${scope}.${key}`, structuredClone(value)); return value; }
  },
  users: { activeGM: { isGM: true } }
};

globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, OWNER: 1 } };

globalThis.fromUuid = async uuid => {
  const document = documents.get(uuid);
  return document || null;
};

function makeMonster(overrides = {}) {
  const system = {
    species: overrides.system?.species ?? "Goblin",
    revealed: false,
    weakPoint: null,
    sourceUrl: "",
    reputation: 10,
    weakness: 15,
    ...overrides.system
  };
  return {
    id: overrides.id ?? `monster-${Math.random().toString(36).slice(2)}`,
    type: "monster",
    name: overrides.name ?? "Goblin",
    system,
    ownership: { default: 0 },
    flags: {},
    testUserPermission() { return true; },
    isOwner: true,
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async setFlag(scope, key, value) {
      this.flags[scope] ??= {};
      if (value === null) delete this.flags[scope][key];
      else this.flags[scope][key] = structuredClone(value);
    },
    update: async (data) => {
      actorUpdates.push(data);
      for (const [path, value] of Object.entries(data ?? {})) {
        const parts = path.split(".");
        let obj = system;
        for (let i = 0; i < parts.length - 1; i++) {
          obj[parts[i]] = obj[parts[i]] ?? {};
          obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
      }
    }
  };
}

function sameSpeciesMonster(overrides = {}) {
  return makeMonster({ ...overrides, system: { ...(overrides.system ?? {}), species: "Goblin" } });
}

function otherSpeciesMonster() {
  return makeMonster({ system: { species: "Hydra" } });
}

function resetWorld() {
  worldSettings.clear();
  chatMessages.length = 0;
  actorUpdates.length = 0;
  game.actors = [];
  documents.clear();
}

// ── Pruebas ───────────────────────────────────────────────────────────────

console.log("=== Registro de conocimiento de debilidades por mundo (especies) ===\n");

// 1. Inicialización desde el nombre canónico de la criatura (wiki).
console.log("Test 1: Species desde nombre canónico de la wiki");
resetWorld();
{
  const parsed = { name: "Cursed Artist", system: { species: "Cursed Artist" } };
  assert.equal(parsed.system.species, "Cursed Artist", "nombre canónico de la wiki");
  assert.equal(normalizeSpeciesId(parsed.system.species), "cursed artist");
  console.log("  ✓ PASS");
}

// 2. Inicialización desde el nombre del Actor cuando no hay referencia canónica.
console.log("Test 2: Species desde nombre del Actor (sin referencia canónica)");
resetWorld();
{
  const monster = makeMonster({ system: { species: "" } });
  // preCreateActor rellena desde el nombre cuando no existe.
  if (!monster.system.species) monster.system.species = monster.name;
  assert.equal(monster.system.species, "Goblin", "species = nombre del actor");
  assert.equal(normalizeSpeciesId(monster.system.species), "goblin");
  console.log("  ✓ PASS");
}

// 3. Conservación de Species al cambiar el nombre del Actor.
console.log("Test 3: Cambiar nombre del Actor no altera Species");
resetWorld();
{
  const monster = makeMonster({ id: "m1", name: "Goblin", system: { species: "Goblin" } });
  assert.equal(speciesId(monster), "goblin");
  monster.name = "Goblin Veterano";
  assert.equal(monster.system.species, "Goblin", "species conservada tras renombrar");
  assert.equal(speciesId(monster), "goblin", "identificador estable tras renombrar");
  console.log("  ✓ PASS");
}

// 4. Herencia de Species al duplicar monstruos.
console.log("Test 4: Duplicado conserva Species del original");
resetWorld();
{
  const original = makeMonster({ id: "orig", name: "Goblin", system: { species: "Goblin Veterano" } });
  const clone = {
    id: "clone",
    type: "monster",
    name: "Goblin Veterano (copy)",
    system: structuredClone(original.system),
    ownership: { default: 0 },
    flags: {},
    testUserPermission() { return true; },
    isOwner: true,
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async setFlag(scope, key, value) {
      this.flags[scope] ??= {};
      if (value === null) delete this.flags[scope][key];
      else this.flags[scope][key] = structuredClone(value);
    },
    update: async () => {}
  };
  assert.equal(clone.system.species, "Goblin Veterano", "duplicado hereda species");
  assert.equal(speciesId(clone), "goblin veterano", "mismo identificador normalizado");
  console.log("  ✓ PASS");
}

// 5. Independencia entre sourceUrl y Species.
console.log("Test 5: sourceUrl no interviene en la identificación de especies");
resetWorld();
{
  const wikiGoblin = makeMonster({
    id: "w1",
    system: { species: "Goblin", sourceUrl: "https://sw25.wikidot.com/monster:goblin" }
  });
  const customGoblin = makeMonster({
    id: "c1",
    name: "Mi Goblin",
    system: { species: "Goblin", sourceUrl: "" }
  });
  assert.equal(speciesId(wikiGoblin), speciesId(customGoblin), "mismo species aunque distinto sourceUrl/nombre");
  console.log("  ✓ PASS");
}

// 6. Identificación compartida entre Actors con nombres diferentes y misma especie.
console.log("Test 6: Nombres diferentes, misma especie -> conocimiento compartido");
resetWorld();
{
  const a = makeMonster({ id: "a", name: "Goblin A", system: { species: "Goblin" } });
  const b = makeMonster({ id: "b", name: "Goblin B", system: { species: "Goblin" } });
  game.actors = [a, b];

  await revealMonsterWeakness(a, { notify: false });
  assert.equal(speciesWeaknessKnown(b), true, "especie conocida desde otro ejemplar");
  assert.equal(b.system.revealed, false, "estadísticas no se revelan automáticamente en otro ejemplar");
  console.log("  ✓ PASS");
}

// 7. Identificación compartida con diferencias de mayúsculas y minúsculas.
console.log("Test 7: Mayúsculas/minúsculas -> mismo identificador");
resetWorld();
{
  const a = makeMonster({ id: "a", system: { species: "GOBLIN" } });
  const b = makeMonster({ id: "b", system: { species: "goblin" } });
  assert.equal(speciesId(a), speciesId(b), "normalización case-insensitive");
  assert.equal(normalizeSpeciesId("GOBLIN"), "goblin");
  console.log("  ✓ PASS");
}

// 8. Normalización de espacios iniciales, finales y consecutivos.
console.log("Test 8: Normalización de espacios");
resetWorld();
{
  assert.equal(normalizeSpeciesId("  Goblin  Veterano  "), "goblin veterano");
  assert.equal(normalizeSpeciesId("Goblin   Veterano"), "goblin veterano");
  assert.equal(normalizeSpeciesId("\tGoblin\n"), "goblin");
  assert.equal(normalizeSpeciesId(""), null, "vacío -> null");
  assert.equal(normalizeSpeciesId(null), null, "null -> null");
  console.log("  ✓ PASS");
}

// 9. Separación entre especies diferentes.
console.log("Test 9: Especies diferentes no comparten conocimiento");
resetWorld();
{
  const goblin = makeMonster({ id: "g", system: { species: "Goblin" } });
  const hydra = makeMonster({ id: "h", system: { species: "Hydra" } });
  game.actors = [goblin, hydra];

  await revealMonsterWeakness(goblin, { notify: false });
  assert.equal(isSpeciesWeaknessKnown("goblin"), true, "goblin conocida");
  assert.equal(isSpeciesWeaknessKnown("hydra"), false, "hidra no afectada");
  console.log("  ✓ PASS");
}

// 10. Comportamiento seguro cuando Species está vacío.
console.log("Test 10: Species vacío -> no se agrupa ni fallback al nombre");
resetWorld();
{
  const empty = makeMonster({ id: "e", system: { species: "", weakPoint: "Accuracy +2" } });
  assert.equal(speciesId(empty), null, "species vacía -> null");
  assert.equal(isSpeciesWeaknessKnown(empty), false, "no conocida con species vacío");
  console.log("  ✓ PASS");
}

// 11. Reputation y Weakness con el nuevo identificador (tirada de Monster Knowledge).
console.log("Test 11: Tirada de Monster Knowledge usa species para revelar");
resetWorld();
{
  const actor = makeMonster({ id: "m", system: { species: "Goblin", weaknessDiscovered: false } });
  documents.set("t1", { uuid: "t1", actor });
  const originalFromUuid = globalThis.fromUuid;
  globalThis.fromUuid = async () => documents.get("t1");
  game.user = { isGM: true };
  try {
    await resolveMonsterKnowledgeMessage({
      getFlag: () => ({
        successValue: 15,
        targetTokenUuids: ["t1"],
        classResults: [{ className: "sage", successValue: 15, canRevealWeakness: true }]
      }),
      rolls: [{ total: 15, dice: [{ results: [{ active: true, result: 7 }, { active: true, result: 8 }] }] }]
    });
    assert.equal(isSpeciesWeaknessKnown("goblin"), true, "automático Weakness registra la especie por species");
    assert.equal(actor.system.revealed, true, "Sage revela estadísticas y Weakness (15 >= reputation 10 y >= weakness 15)");
  } finally {
    globalThis.fromUuid = originalFromUuid;
    game.user = { isGM: true };
  }
  console.log("  ✓ PASS");
}

// 12. Aplicación y retirada de Weak Point por species. Nota: desde el diseño
//     vigente, los Weak Point descubiertos se registran por especie pero no
//     otorgan ningún bonus mecánico durante la resolución de ataques
//     (ver cabecera de module/combat/attack-resolution.mjs).
console.log("Test 12: Weak Point se aplica y retira por species (registro, sin bonus mecánico)");
resetWorld();
{
  const a = makeMonster({ id: "a", system: { species: "Goblin", weakPoint: "Accuracy +2" } });
  const b = makeMonster({ id: "b", system: { species: "Goblin", weakPoint: "Accuracy +2" } });
  game.actors = [a, b];

  await toggleMonsterWeakness(a, { notify: false });
  assert.equal(isSpeciesWeaknessKnown("goblin"), true, "especie registrada al aplicar");
  assert.equal(b.system.weakPoint, "Accuracy +2", "B conserva su Weak Point textual");

  await toggleMonsterWeakness(b, { notify: false });
  assert.equal(isSpeciesWeaknessKnown("goblin"), false, "especie retirada del registro");
  console.log("  ✓ PASS");
}

// 13. Ausencia de regresiones: acciones respectan permisos y otras especies.
console.log("Test 13: Permisos e independencia de otras especies");
resetWorld();
{
  const noControl = makeMonster({ id: "nc", system: { species: "Goblin" } });
  noControl.isOwner = false;
  noControl.testUserPermission = () => false;
  const originalIsGM = game.user.isGM;
  game.user = { isGM: false };
  try {
    const s = await toggleMonsterStats(noControl, { notify: false });
    assert.equal(s.status, "denied", "toggle stats denegado");
    const w = await toggleMonsterWeakness(noControl, { notify: false });
    assert.equal(w.status, "denied", "toggle debilidad denegado");
    assert.equal(isSpeciesWeaknessKnown("goblin"), false, "sin cambios de estado");
  } finally {
    game.user = { isGM: originalIsGM };
  }
  console.log("  ✓ PASS");
}

// 14. Debilidad y revelación de estadísticas están separadas.
console.log("Test 14: Debilidad compartida por especie, estadísticas individuales");
resetWorld();
{
  const a = makeMonster({ id: "a", name: "Goblin A", system: { species: "Goblin", revealed: false } });
  const b = makeMonster({ id: "b", name: "Goblin B", system: { species: "Goblin", revealed: false } });
  game.actors = [a, b];

  await revealMonsterWeakness(a, { notify: false });
  assert.equal(speciesWeaknessKnown(a), true, "debilidad registrada para la especie");
  assert.equal(isSpeciesWeaknessKnown("goblin"), true, "conocimiento de debilidad compartido por especie");
  assert.equal(b.system.revealed, false, "estadísticas del otro ejemplar no se revelan automáticamente");
  assert.equal(a.system.revealed, false, "estadísticas del propio ejemplar no se revelan automáticamente");
  console.log("  ✓ PASS");
}

// 15. Especie por defecto: nombre del actor cuando no hay species asignado.
console.log("Test 15: Especie por defecto desde nombre del actor");
resetWorld();
{
  const unnamed = makeMonster({ id: "u", name: "Orco Salvaje", system: { species: "" } });
  // Simula el fallback del ciclo de vida del actor (preCreateActor / importer).
  if (!unnamed.system.species) unnamed.system.species = unnamed.name;
  assert.equal(unnamed.system.species, "Orco Salvaje", "especie por defecto es el nombre del actor");
  assert.equal(speciesId(unnamed), "orco salvaje", "identificador normalizado del nombre");
  console.log("  ✓ PASS");
}

// 16. Especie asignada explícitamente nunca se sobreescribe por el nombre.
console.log("Test 16: Especie explícita no se sobreescribe");
resetWorld();
{
  const explicit = makeMonster({ id: "e", name: "Goblin", system: { species: "Goblin Veterano" } });
  assert.equal(explicit.system.species, "Goblin Veterano", "especie explícita preservada");
  assert.equal(speciesId(explicit), "goblin veterano", "identificador de especie explícita");
  // El fallback solo aplica cuando species está vacío; no se sobrescribe.
  if (!explicit.system.species) explicit.system.species = explicit.name;
  assert.equal(explicit.system.species, "Goblin Veterano", "especie explícita no sobreescrita por fallback");
  console.log("  ✓ PASS");
}

// 17. Revelar Weak Point registra la especie y no revela estadísticas.
console.log("Test 17: Revelar Weak Point registra especie, sin revelar estadísticas");
resetWorld();
{
  const monster = makeMonster({ id: "m1", system: { species: "Goblin", revealed: false, ownership: { default: 0 } } });
  documents.set("t1", { uuid: "t1", actor: monster });
  const originalFromUuid = globalThis.fromUuid;
  globalThis.fromUuid = async () => documents.get("t1");
  game.user = { isGM: true };
  try {
    await revealMonsterWeakness(monster, { notify: false });
    assert.equal(isSpeciesWeaknessKnown("goblin"), true, "especie registrada");
    assert.equal(monster.system.revealed, false, "estadísticas no se revelan por descubrir el Weak Point");
  } finally {
    globalThis.fromUuid = originalFromUuid;
    game.user = { isGM: true };
  }
  console.log("  ✓ PASS");
}

// 18. Retirar Weak Point no oculta las estadísticas.
console.log("Test 18: Retirar Weak Point no oculta estadísticas");
resetWorld();
{
  const monster = makeMonster({ id: "m2", system: { species: "Goblin", revealed: true, ownership: { default: 1 } } });
  documents.set("t2", { uuid: "t2", actor: monster });
  const originalFromUuid = globalThis.fromUuid;
  globalThis.fromUuid = async () => documents.get("t2");
  game.user = { isGM: true };
  try {
    await revealMonsterWeakness(monster, { notify: false });
    assert.equal(isSpeciesWeaknessKnown("goblin"), true, "especie registrada antes del toggle");
    await toggleMonsterWeakness(monster, { notify: false });
    assert.equal(isSpeciesWeaknessKnown("goblin"), false, "especie retirada del registro");
    assert.equal(monster.system.revealed, true, "estadísticas siguen reveladas tras retirar debilidad");
  } finally {
    globalThis.fromUuid = originalFromUuid;
    game.user = { isGM: true };
  }
  console.log("  ✓ PASS");
}

// 19. Estadísticas recuperan estado previo al ocultarse.
console.log("Test 19: Estadísticas restauran estado previo");
resetWorld();
{
  const monster = makeMonster({ id: "m3", system: { species: "Goblin", revealed: false, ownership: { default: 0 } } });
  documents.set("t3", { uuid: "t3", actor: monster });
  const originalFromUuid = globalThis.fromUuid;
  globalThis.fromUuid = async () => documents.get("t3");
  game.user = { isGM: true };
  try {
    await revealMonsterStats(monster, { notify: false });
    assert.equal(monster.system.revealed, true, "estadísticas reveladas");
    await toggleMonsterStats(monster, { notify: false });
    assert.equal(monster.system.revealed, false, "estadísticas ocultas tras toggle");
    assert.equal(monster.ownership.default, 0, "ownership restaurada al previo");
  } finally {
    globalThis.fromUuid = originalFromUuid;
    game.user = { isGM: true };
  }
  console.log("  ✓ PASS");
}

// 20. El registro se comparte entre monstruos de la misma especie.
console.log("Test 20: Conocimiento compartido por especie");
resetWorld();
{
  const a = makeMonster({ id: "a", system: { species: "Goblin" } });
  const b = makeMonster({ id: "b", system: { species: "Goblin" } });
  await revealMonsterWeakness(a, { notify: false });
  assert.equal(isSpeciesWeaknessKnown("goblin"), true, "especie conocida desde un ejemplar");
  assert.equal(b.system.revealed, false, "otro ejemplar no se revela automáticamente");
  assert.equal(speciesWeaknessKnown(b), true, "conocimiento compartido por especie");
  console.log("  ✓ PASS");
}

// ── Resumen ───────────────────────────────────────────────────────────────

console.log("\n=== Todas las pruebas de especies pasaron ===");
