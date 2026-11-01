#!/usr/bin/env node
// Pruebas de regresión para la migración de Fighting Styles.
// Usa datos reales de Wyvern extraídos del paquete de la biblioteca.
// Comprueba:
// 1. Datos reales de Wyvern en la biblioteca tienen style, section, isMainSection separados
// 2. prepareMonsterCombatStyles los procesa correctamente
// 3. Las seis estadísticas se conservan
// 4. Compatibilidad con formato antiguo (nombres combinados)
// 5. Un monstruo con una única entrada
// 6. Un monstruo con varias entradas y Main Section identificada
// 7. Un monstruo con varias entradas sin Main Section identificada

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  prepareMonsterCombatStyles,
  readMonsterCombatStyles,
  readMonsterActorCombatStyles,
  getMainCombatStyleIndex,
  hasValidMainCombatStyle,
  appendMonsterCombatStyle,
  mergeMonsterCombatStyleFields
} from "../module/actor/monster-sheet-data.mjs";
import { parseMonsterPage as importParseMonsterPage } from "../module/importer/monster-parser.mjs";

const __dirname = path.resolve("..");
const packsDir = path.resolve(__dirname, "sw25-library", "packs");

function readPack(pack) {
  const content = fs.readFileSync(path.join(packsDir, `${pack}.db`), "utf8");
  return content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

// Leer Wyvern real de la biblioteca
const wyvernPack = readPack("monsters-mythical-beasts");
const wyvern = wyvernPack.find(a => a.name === "Wyvern");
assert.ok(wyvern, "Wyvern no encontrado en la biblioteca");

console.log("=== Fase 1: Datos reales de Wyvern en la biblioteca ===");
console.log(`Nombre: ${wyvern.name}`);
console.log(`_id: ${wyvern._id}`);
console.log(`Pack: monsters-mythical-beasts`);
console.log(`Combat styles: ${JSON.stringify(wyvern.system.combatStyles.map(s => ({
  style: s.style, section: s.section, isMainSection: s.isMainSection,
  accuracy: s.accuracy, damage: s.damage, evasion: s.evasion,
  defense: s.defense, hp: s.hp, mp: s.mp
})), null, 2)}`);

// 1. Cada entrada tiene style, section, isMainSection separados
for (const [i, s] of wyvern.system.combatStyles.entries()) {
  assert.ok("style" in s, `Wyvern[${i}]: tiene campo style`);
  assert.ok("section" in s, `Wyvern[${i}]: tiene campo section`);
  assert.ok("isMainSection" in s, `Wyvern[${i}]: tiene campo isMainSection`);
  assert.ok("accuracy" in s, `Wyvern[${i}]: tiene campo accuracy`);
  assert.ok("damage" in s, `Wyvern[${i}]: tiene campo damage`);
  assert.ok("evasion" in s, `Wyvern[${i}]: tiene campo evasion`);
  assert.ok("defense" in s, `Wyvern[${i}]: tiene campo defense`);
  assert.ok("hp" in s, `Wyvern[${i}]: tiene campo hp`);
  assert.ok("mp" in s, `Wyvern[${i}]: tiene campo mp`);
}

// 2. Primera entrada tiene isMainSection=true, resto=false
assert.strictEqual(wyvern.system.combatStyles[0].isMainSection, true, "Wyvern[0]: isMainSection=true");
for (let i = 1; i < wyvern.system.combatStyles.length; i++) {
  assert.strictEqual(wyvern.system.combatStyles[i].isMainSection, false, `Wyvern[${i}]: isMainSection=false`);
}

// 3. style y section están separados (no combinados)
assert.strictEqual(wyvern.system.combatStyles[0].style, "Bite", "Wyvern[0].style = 'Bite'");
assert.strictEqual(wyvern.system.combatStyles[0].section, "Head", "Wyvern[0].section = 'Head'");
assert.strictEqual(wyvern.system.combatStyles[1].style, "Talon", "Wyvern[1].style = 'Talon'");
assert.strictEqual(wyvern.system.combatStyles[1].section, "Wing", "Wyvern[1].section = 'Wing'");
assert.strictEqual(wyvern.system.combatStyles[3].style, "Tail", "Wyvern[3].style = 'Tail'");
assert.strictEqual(wyvern.system.combatStyles[3].section, "Tail", "Wyvern[3].section = 'Tail'");

console.log("\n=== Fase 2: prepareMonsterCombatStyles con datos de Wyvern ===");
const prepared = prepareMonsterCombatStyles(wyvern.system.combatStyles, []);

for (let i = 0; i < prepared.length; i++) {
  const p = prepared[i];
  console.log(`  [${i}] styleName="${p.styleName}" section="${p.section}" isMainSection=${p.isMainSection}`);
}

// 4. styleName y section están separados correctamente
assert.strictEqual(prepared[0].styleName, "Bite", "prepared[0].styleName = 'Bite'");
assert.strictEqual(prepared[0].section, "Head", "prepared[0].section = 'Head'");
assert.strictEqual(prepared[0].isMainSection, true, "prepared[0].isMainSection = true");
assert.strictEqual(prepared[1].styleName, "Talon", "prepared[1].styleName = 'Talon'");
assert.strictEqual(prepared[1].section, "Wing", "prepared[1].section = 'Wing'");
assert.strictEqual(prepared[1].isMainSection, false, "prepared[1].isMainSection = false");
assert.strictEqual(prepared[2].styleName, "Talon", "prepared[2].styleName = 'Talon'");
assert.strictEqual(prepared[2].section, "Wing", "prepared[2].section = 'Wing'");
assert.strictEqual(prepared[2].isMainSection, false, "prepared[2].isMainSection = false");
assert.strictEqual(prepared[3].styleName, "Tail", "prepared[3].styleName = 'Tail'");
assert.strictEqual(prepared[3].section, "Tail", "prepared[3].section = 'Tail'");
assert.strictEqual(prepared[3].isMainSection, false, "prepared[3].isMainSection = false");

// 5. getMainCombatStyleIndex devuelve 0 (primera entrada)
assert.strictEqual(getMainCombatStyleIndex(wyvern.system.combatStyles), 0, "getMainCombatStyleIndex = 0");

// 6. hasValidMainCombatStyle devuelve true
assert.strictEqual(hasValidMainCombatStyle(wyvern.system.combatStyles), true, "hasValidMainCombatStyle = true");

// 7. Las seis estadísticas se conservan en cada entrada
const expectedStats = [
  { accuracy: "11 (18)", damage: "2d+9", evasion: "10 (17)", defense: 7, hp: { value: 38, max: 38 }, mp: { value: 31, max: 31 } },
  { accuracy: "10 (17)", damage: "2d+7", evasion: "9 (16)", defense: 5, hp: { value: 29, max: 29 }, mp: { value: 29, max: 29 } },
  { accuracy: "10 (17)", damage: "2d+7", evasion: "9 (16)", defense: 5, hp: { value: 29, max: 29 }, mp: { value: 29, max: 29 } },
  { accuracy: "10 (17)", damage: "2d+6", evasion: "8 (15)", defense: 6, hp: { value: 33, max: 33 }, mp: { value: 26, max: 26 } }
];
for (let i = 0; i < wyvern.system.combatStyles.length; i++) {
  const s = wyvern.system.combatStyles[i];
  const e = expectedStats[i];
  assert.strictEqual(s.accuracy, e.accuracy, `Wyvern[${i}].accuracy`);
  assert.strictEqual(s.damage, e.damage, `Wyvern[${i}].damage`);
  assert.strictEqual(s.evasion, e.evasion, `Wyvern[${i}].evasion`);
  assert.strictEqual(s.defense, e.defense, `Wyvern[${i}].defense`);
  assert.deepStrictEqual(s.hp, e.hp, `Wyvern[${i}].hp`);
  assert.deepStrictEqual(s.mp, e.mp, `Wyvern[${i}].mp`);
  // También en prepared
  assert.strictEqual(prepared[i].accuracy, e.accuracy, `prepared[${i}].accuracy`);
  assert.strictEqual(prepared[i].damage, e.damage, `prepared[${i}].damage`);
  assert.strictEqual(prepared[i].evasion, e.evasion, `prepared[${i}].evasion`);
  assert.strictEqual(prepared[i].defense, e.defense, `prepared[${i}].defense`);
  assert.deepStrictEqual(prepared[i].hp, e.hp, `prepared[${i}].hp`);
  assert.deepStrictEqual(prepared[i].mp, e.mp, `prepared[${i}].mp`);
}

console.log("\n=== Fase 3: Compatibilidad con formato antiguo (nombres combinados) ===");

// Monstruo antiguo con nombres combinados
const oldMonsterStyles = [
  { style: "Bite (Head)", accuracy: "8 (15)", damage: "2d+9", evasion: "9 (16)", defense: 5, hp: { value: 52, max: 52 }, mp: { value: 43, max: 43 } },
  { style: "Vine (Body)", accuracy: "9 (16)", damage: "2d+7", evasion: "8 (15)", defense: 6, hp: { value: 58, max: 58 }, mp: { value: 34, max: 34 } }
];
const oldPrepared = prepareMonsterCombatStyles(oldMonsterStyles, ["Head", "Body"]);

assert.strictEqual(oldPrepared[0].styleName, "Bite (Head)", "Old[0].styleName = 'Bite (Head)' (no se reconstruye)");
assert.strictEqual(oldPrepared[0].section, "", "Old[0].section = '' (sin campo section)");
assert.strictEqual(oldPrepared[1].styleName, "Vine (Body)", "Old[1].styleName = 'Vine (Body)' (no se reconstruye)");
assert.strictEqual(oldPrepared[1].section, "", "Old[1].section = '' (sin campo section)");

console.log("  Formato antiguo: styleName conserva nombre combinado, section vacío (correcto)");

console.log("\n=== Fase 4: Monstruo con una única entrada ===");
const singleEntryStyles = [
  { style: "Slam", accuracy: "3 (10)", damage: "2d-1", evasion: "2 (9)", defense: 2, hp: { value: 20, max: 20 }, mp: { value: 5, max: 5 } }
];
const singlePrepared = prepareMonsterCombatStyles(singleEntryStyles, []);
assert.strictEqual(singlePrepared[0].styleName, "Slam", "Single[0].styleName = 'Slam'");
assert.strictEqual(singlePrepared[0].section, "", "Single[0].section = ''");
assert.strictEqual(singlePrepared[0].isMainSection, true, "Single[0].isMainSection = true (automático)");
assert.strictEqual(singlePrepared[0].mainSectionCheckboxDisabled, true, "Single[0].mainSectionCheckboxDisabled = true");
assert.strictEqual(getMainCombatStyleIndex(singleEntryStyles), 0, "Single: getMainCombatStyleIndex = 0");

console.log("  Entrada única: isMainSection automático, checkbox deshabilitado");

console.log("\n=== Fase 5: Monstruo con varias entradas y Main Section identificada ===");
const multiIdentifiedStyles = [
  { style: "Bite", accuracy: "11 (18)", damage: "2d+9", evasion: "10 (17)", defense: 7, hp: { value: 38, max: 38 }, mp: { value: 31, max: 31 }, section: "Head", isMainSection: true },
  { style: "Talon", accuracy: "10 (17)", damage: "2d+7", evasion: "9 (16)", defense: 5, hp: { value: 29, max: 29 }, mp: { value: 29, max: 29 }, section: "Wing", isMainSection: false }
];
const multiIdentifiedPrepared = prepareMonsterCombatStyles(multiIdentifiedStyles, ["Head", "Wing"]);
assert.strictEqual(multiIdentifiedPrepared[0].isMainSection, true, "Multi[0].isMainSection = true");
assert.strictEqual(multiIdentifiedPrepared[1].isMainSection, false, "Multi[1].isMainSection = false");
assert.strictEqual(getMainCombatStyleIndex(multiIdentifiedStyles), 0, "Multi: getMainCombatStyleIndex = 0");
assert.strictEqual(hasValidMainCombatStyle(multiIdentifiedStyles), true, "Multi: hasValidMainCombatStyle = true");

console.log("  Varias entradas con Main Section: exactamente una isMainSection=true");

console.log("\n=== Fase 6: Monstruo con varias entradas sin Main Section identificada ===");
const multiUnidentifiedStyles = [
  { style: "Bite", accuracy: "11 (18)", damage: "2d+9", evasion: "10 (17)", defense: 7, hp: { value: 38, max: 38 }, mp: { value: 31, max: 31 }, section: "Head" },
  { style: "Talon", accuracy: "10 (17)", damage: "2d+7", evasion: "9 (16)", defense: 5, hp: { value: 29, max: 29 }, mp: { value: 29, max: 29 }, section: "Wing" }
];
// Sin isMainSection en ninguna entrada
const multiUnidentifiedPrepared = prepareMonsterCombatStyles(multiUnidentifiedStyles, ["Head", "Wing"]);
assert.strictEqual(multiUnidentifiedPrepared[0].isMainSection, false, "MultiUnidentified[0].isMainSection = false");
assert.strictEqual(multiUnidentifiedPrepared[1].isMainSection, false, "MultiUnidentified[1].isMainSection = false");
assert.strictEqual(getMainCombatStyleIndex(multiUnidentifiedStyles), null, "MultiUnidentified: getMainCombatStyleIndex = null");
assert.strictEqual(hasValidMainCombatStyle(multiUnidentifiedStyles), false, "MultiUnidentified: hasValidMainCombatStyle = false");

console.log("  Varias entradas sin Main Section: sin isMainSection, getMainCombatStyleIndex = null");

console.log("\n=== Fase 7: parseMonsterPage del sistema (importación) produce section e isMainSection ===");
// Simular datos de wiki de Wyvern con Main Section
const wyvernWikiSource = `Wyvern
Level 5 Barbarous

Sections: 2 (Head / Wing)
Main Section: Head

Fighting Style | Accuracy | Damage | Evasion | Defense | HP | MP
Bite (Head) | 11 (18) | 2d+9 | 10 (17) | 7 | 38 | 31
Talon (Wing) | 10 (17) | 2d+7 | 9 (16) | 5 | 29 | 29
Talon (Wing) | 10 (17) | 2d+7 | 9 (16) | 5 | 29 | 29
Tail (Tail) | 10 (17) | 2d+6 | 8 (15) | 6 | 33 | 33

Unique Skills
#### Winged
Vuela.

#### Poisonous Sting
Venenoso.

Loot
2 - 6 | Nothing
7+ | Wyvern Stinger (100G/Red S)`;

const parsed = importParseMonsterPage(wyvernWikiSource, "https://sw25.wikidot.com/monster:wyvern");

console.log(`  combatStyles del parser: ${JSON.stringify(parsed.system.combatStyles.map(s => ({
  style: s.style, section: s.section, isMainSection: s.isMainSection
})), null, 2)}`);

// Cada entrada del parser debe tener section
for (const cs of parsed.system.combatStyles) {
  assert.ok("section" in cs, "Parser output: tiene campo section");
  assert.ok(cs.section !== "", `Parser output: section no vacío para ${cs.style}`);
}

// Primera entrada debe tener isMainSection=true (Main Section: Head)
assert.strictEqual(parsed.system.combatStyles[0].isMainSection, true, "Parser[0]: isMainSection=true (Head es Main Section)");
for (let i = 1; i < parsed.system.combatStyles.length; i++) {
  assert.strictEqual(parsed.system.combatStyles[i].isMainSection, false, `Parser[${i}]: isMainSection=false`);
}

// style en el parser puede ser combinado (sourceStyle) para retrocompatibilidad
// pero section está separado
assert.strictEqual(parsed.system.combatStyles[0].section, "Head", "Parser[0].section = 'Head'");
assert.strictEqual(parsed.system.combatStyles[1].section, "Wing", "Parser[1].section = 'Wing'");
assert.strictEqual(parsed.system.combatStyles[3].section, "Tail", "Parser[3].section = 'Tail'");

console.log("  Parser del sistema: produce section e isMainSection correctamente");

console.log("\n=== Todas las pruebas de regresión pasaron ===");
