#!/usr/bin/env node
// Verificación de otros monstruos migrados de la biblioteca SW25.
// Comprueba:
// - Monstruo con dos secciones distintas
// - Monstruo con tres o más secciones
// - Monstruo con secciones repetidas
// - Monstruo con una única entrada
// - Monstruo de los 144 casos cuya Main Section fue identificada

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { prepareMonsterCombatStyles, getMainCombatStyleIndex, hasValidMainCombatStyle } from "../module/actor/monster-sheet-data.mjs";

const packsDir = path.resolve("..", "sw25-library", "packs");

function readPack(pack) {
  const content = fs.readFileSync(path.join(packsDir, `${pack}.db`), "utf8");
  return content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function findActor(pack, name) {
  return readPack(pack).find(a => a.name === name);
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS: ${name}`); }
  catch (e) { failed++; console.log(`  FAIL: ${name} — ${e.message}`); }
}

console.log("=== Verificación de monstruos migrados ===\n");

// 1. Monstruo con dos secciones distintas (Missile Dolphin: Head, Body)
console.log("1. Monstruo con dos secciones distintas:");
const missileDolphin = findActor("monsters-animals", "Missile Dolphin");
assert.ok(missileDolphin, "Missile Dolphin encontrado");
test("Missile Dolphin tiene 2 estilos", () => {
  assert.strictEqual(missileDolphin.system.combatStyles.length, 2);
});
test("Missile Dolphin: style y section separados", () => {
  assert.strictEqual(missileDolphin.system.combatStyles[0].style, "Headbutt");
  assert.strictEqual(missileDolphin.system.combatStyles[0].section, "Head");
  assert.strictEqual(missileDolphin.system.combatStyles[1].style, "Slam");
  assert.strictEqual(missileDolphin.system.combatStyles[1].section, "Body");
});
test("Missile Dolphin: Head es Main Section", () => {
  assert.strictEqual(missileDolphin.system.combatStyles[0].isMainSection, true);
  assert.strictEqual(missileDolphin.system.combatStyles[1].isMainSection, false);
});
test("Missile Dolphin: estadísticas preservadas", () => {
  assert.strictEqual(missileDolphin.system.combatStyles[0].hp.value, 68);
  assert.strictEqual(missileDolphin.system.combatStyles[1].hp.value, 60);
});

// 2. Monstruo con tres o más secciones (Brafotes: Head, Body, Wing)
console.log("\n2. Monstruo con tres o más secciones:");
const brafotes = findActor("monsters-animals", "Brafotes");
assert.ok(brafotes, "Brafotes encontrado");
test("Brafotes tiene 4 estilos", () => {
  assert.strictEqual(brafotes.system.combatStyles.length, 4);
});
test("Brafotes: 3 secciones distintas", () => {
  const sections = brafotes.system.combatStyles.map(s => s.section);
  assert.ok(sections.includes("Head"));
  assert.ok(sections.includes("Body"));
  assert.ok(sections.includes("Wing"));
});
test("Brafotes: Head es Main Section", () => {
  assert.strictEqual(brafotes.system.combatStyles[0].isMainSection, true);
});

// 3. Monstruo con secciones repetidas (Roc: Body x2, Wing x2, Leg x2)
console.log("\n3. Monstruo con secciones repetidas:");
const roc = findActor("monsters-animals", "Roc");
assert.ok(roc, "Roc encontrado");
test("Roc tiene 7 estilos", () => {
  assert.strictEqual(roc.system.combatStyles.length, 7);
});
test("Roc: secciones repetidas preservadas", () => {
  const sections = roc.system.combatStyles.map(s => s.section);
  assert.strictEqual(sections.filter(s => s === "Body").length, 2);
  assert.strictEqual(sections.filter(s => s === "Wing").length, 2);
  assert.strictEqual(sections.filter(s => s === "Leg").length, 2);
});
test("Roc: Head es Main Section", () => {
  assert.strictEqual(roc.system.combatStyles[0].isMainSection, true);
});

// 4. Monstruo con una única entrada (Poison Toad)
console.log("\n4. Monstruo con una única entrada:");
const poisonToad = findActor("monsters-animals", "Poison Toad");
assert.ok(poisonToad, "Poison Toad encontrado");
test("Poison Toad tiene 1 estilo", () => {
  assert.strictEqual(poisonToad.system.combatStyles.length, 1);
});
test("Poison Toad: sin isMainSection (entrada única)", () => {
  assert.strictEqual(poisonToad.system.combatStyles[0].isMainSection, undefined);
});
test("Poison Toad: sección vacía (sin paréntesis en nombre)", () => {
  assert.strictEqual(poisonToad.system.combatStyles[0].section, "");
});
test("Poison Toad: estadísticas preservadas", () => {
  assert.strictEqual(poisonToad.system.combatStyles[0].hp.value, 20);
});

// 5. Monstruo de los 144 casos con Main Section identificada (Missile Dolphin - animals)
console.log("\n5. Monstruo con Main Section identificada (varias entradas):");
const missileDolphin2 = findActor("monsters-animals", "Missile Dolphin");
assert.ok(missileDolphin2, "Missile Dolphin encontrado");
test("Missile Dolphin tiene 2 estilos", () => {
  assert.strictEqual(missileDolphin2.system.combatStyles.length, 2);
});
test("Missile Dolphin: exactamente una isMainSection=true", () => {
  const mainCount = missileDolphin2.system.combatStyles.filter(s => s.isMainSection === true).length;
  assert.strictEqual(mainCount, 1);
});
test("Missile Dolphin: todas las entradas tienen section", () => {
  for (const s of missileDolphin2.system.combatStyles) {
    assert.ok(s.section !== "", "section no vacío");
  }
});

// 6. Verificación general: todos los monstruos multi-entrada tienen sección en cada estilo
console.log("\n6. Verificación general de integridad:");
let totalMulti = 0;
let totalWithAllSections = 0;
let totalMainIdentified = 0;
let totalMainPending = 0;
let totalStyles = 0;
let totalStylesWithSection = 0;
const packs = ["monsters-animals","monsters-barbarous","monsters-constructs","monsters-daemons","monsters-fairies","monsters-golems","monsters-humanoids","monsters-magitech","monsters-mythical-beasts","monsters-plants","monsters-undead"];
for (const pack of packs) {
  const actors = readPack(pack);
  for (const actor of actors) {
    const styles = actor.system?.combatStyles || [];
    if (styles.length > 1) {
      totalMulti++;
      const allHaveSection = styles.every(s => s.section !== "");
      if (allHaveSection) totalWithAllSections++;
      for (const s of styles) {
        totalStyles++;
        if (s.section !== "") totalStylesWithSection++;
      }
      const mainCount = styles.filter(s => s.isMainSection === true).length;
      if (mainCount === 1) totalMainIdentified++;
      else totalMainPending++;
    }
  }
}
console.log(`  Multi-entrada: ${totalMulti}`);
console.log(`  Todos los estilos con sección: ${totalWithAllSections}/${totalMulti}`);
console.log(`  Total estilos: ${totalStyles}`);
console.log(`  Estilos con sección: ${totalStylesWithSection}`);
console.log(`  Estilos sin sección (paréntesis anidados o sin info): ${totalStyles - totalStylesWithSection}`);
console.log(`  Con Main Section identificada: ${totalMainIdentified}`);
console.log(`  Sin Main Section (pendiente): ${totalMainPending}`);
test("Casi todos los estilos tienen sección (salvo paréntesis anidados)", () => {
  assert.strictEqual(totalStyles - totalStylesWithSection, 1, "Solo Casting Hand tiene estilo sin sección (paréntesis anidados)");
});

console.log(`\n=== Resultado: ${passed} pruebas pasaron, ${failed} fallaron ===`);
process.exitCode = failed > 0 ? 1 : 0;
