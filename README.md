# Sword World 2.5: Taka Edition

> **Disclaimer:** Sword World 2.5: Taka Edition is an unofficial, independently maintained community fork of Daedalus's Sword World 2.5 Foundry system. It is not an official product of Group SNE or KADOKAWA, nor is it affiliated with or endorsed by either organization.

This is a fork of [Sword-World-2.5-Foundry](https://github.com/DaedaIus/Sword-World-2.5-Foundry) by **Daedalus**, adding patches and new features on top of the original system.

A note from me: I am not a programmer. I am building and maintaining this fork as a hobby, with the help of AI, purely as a fan of Sword World 2.5. I test everything as I go hoping it works, but expect rough edges.

![Foundry VTT version](https://img.shields.io/badge/Foundry-V14%2B-orange) ![System](https://img.shields.io/badge/System-sw25--taka%200.18.0%2B-blue)

## Features at a glance

- **Character sheets** — four actor types (`character`, `monster`, `npc`, `fellow`) and nine item types (race, class, feat, ability, weapon, armour, skill, spell, equipment), each with its own sheet.
- **Weapons and attacks** — attack rolls with a temporary modifier dialog (class level, Dexterity, Accuracy Mod, weapon accuracy), power-table damage, critical hits with accumulated power, and per-defense damage application.
- **Monster actors** — wiki import preserving multi-section statistics with per-section combat styles and Unique Skill assignments, active/passive evasion (real 2d6 vs fixed value), and validated imports.
- **Target selection** — when attacking a multi-section monster the player picks the targeted section; that choice decides which evasion answers the accuracy contest and which combat style row takes the damage.
- **Monster Knowledge** — per-class rolls (Sage, Rider, Dark Hunter, plus Druid/Daemonologist spells) reveal Statistics, Classification and Weak Points; knowledge is shared per species and discoveries are shared between players via whispered Bestiary links.
- **Bestiary copies** — every discovery creates an independent Bestiary copy Actor readable by all players (OBSERVER), leaving the original monster untouched.
- **Skill checks** — reorganized catalogue with per-check class lists and automatic highest-level selection.
- **Spell drag & drop** — spells dropped on a character go straight to the viewed class page or open a wizard-type picker.
- **Standard combat maps** — Combat A, Combat B and Coliseum scenes auto-created in a Simplified Combat Battlefields folder.

## v0.18.0 - Monster Knowledge Manager, Bestiary copies and target selection

- **Monster Knowledge Manager** — new GM settings-menu application (`MKRegistryManagerApp`) to manage Weak Point discoveries: session and campaign records with a **single active register** (defaults to a session; the toggle only activates records and is disabled on the active row), per-species removal (any knowledge level, deletes the Bestiary copy and keeps the original monster), record reset/deletion with re-pointing of the active pointer, manual **Add Monster** (creates the copy and reveals it to players) and Bestiary copy reconciliation. GM-manual entries are attributed as "GM" instead of a raw user id.
- **Authoritative registry persistence** — discoveries live in the versioned `mkRegistry` world setting (integrity checks and auto-repair, newest-wins pointer: exactly one active record at any time), written only through the GM service. Player discoveries travel to the GM through a validated socket relay and the requester is acknowledged before anything is written.
- **Reveal whisper, once for the table** — a Monster Knowledge roll posts a single whisper per monster to **every** connected active player with a clickable link to the Bestiary copy; a roll that crosses both the Reputation and Weak Point thresholds sends exactly one notice for the highest level reached.
- **Target selection for multi-section monsters** — attack flows now prompt which section of a multi-section monster is targeted; the selection determines the Evasion used in the accuracy contest and the combat style row that receives the damage.
- **Damage card redesign** — collapsible roll breakdowns with signed values, and damage application targeting a specific combat style row of the defending monster.
- **Migrated chat hooks** — healing and regeneration chat buttons moved to the native `renderChatMessageHTML` hook, removing jQuery-only assumptions.
- **Character sheet cleanup** — the situational extra damage field is now labeled "Damage Bonus (Circumstantial Damage)" on attacks.
- **Species identity centralized** — species normalization lives in `module/knowledge/mk-identity.mjs`, consumed by combat, knowledge and importer code (`system.json` also declares `socket: true` for cross-client operations).

## v0.17.2 - Monster Knowledge: per-class results and class selector tick

- **Monster Knowledge card improvements** — the single chat message now shows a large centered main result (the class achieving the highest applicable effect), below it the outcome verdict, and underneath every evaluated class with its individual calculated result (dice + class level + Intelligence modifier). No lower results are discarded because another class achieved a superior effect.
- **Per-class resolution** — every eligible native Monster Knowledge class (Sage, Rider, Dark Hunter) is evaluated from the single shared roll, plus Druid or Daemonologist when manually selected through their spells. Effects (statistics, classification, Weak Point) are resolved independently per class, crediting which class achieved each effect.
- **Automatic class tick** — the Monster Knowledge Class selector gains an "Automatic" tick (on by default). When ticked the best currently valid class is used and recalculated immediately whenever class levels change; picking a class in the dropdown unticks it and pins that manual choice until ticked again.
- **Manual class visibility** — manually selecting a restricted class (e.g. Dark Hunter) against an ineligible target publishes the card showing that class's result as the main result with a restriction warning, instead of refusing in silence.
- **Fixed monster sheet opening** — monster sheets failed to open after assigning a `species` because the `weaknessRegistry` game setting was never registered, causing `speciesWeaknessKnown()` to throw during sheet rendering. The setting is now registered at init.

## v0.17.1 - Character Sheet UI Improvements

Reorganized character sheet panels to improve usability and make better use of available space.

- Moved Work Skills and Racial Abilities to Adventurer Data.
- Removed their duplicate panels from Combat Data.
- Expanded Weapons to full width in Combat Data.
- Improved panel layout and spacing across both tabs.

## v0.17.0 - Monster active/passive evasion, weapon modifiers and damage resolution

- **Monster active/passive evasion** — each monster has a per-actor `Active Combat Rolls` toggle on its sheet header. When enabled, Accuracy and Evasion resolve with real `2d6 + base` rolls; when disabled they use the fixed parenthesized value (base + 7). New monsters default to fixed rolls.
- **Weapon attack modifiers** — the character attack opens a temporary modifier dialog (class level, Dexterity, Accuracy Mod, weapon accuracy). Each weapon has a per-weapon `Mods?` tick that opens or skips the dialog on every attack.
- **Damage, critical hits and defense** — hitting a monster posts a "Roll Damage" button. Damage cards show total damage and `Apply Damage` reduces monster HP subtracting Defense. Critical hits (e.g. crit 10 on a 12) open a "Roll Damage Again" card carrying accumulated power to the next roll.
- **Monster Knowledge and Weak Points** — Monster Knowledge shares weakness discoveries between monsters of the same species; a discovered "Accuracy" Weak Point grants the attacker a permanent accuracy bonus on attacks against that monster.
- **Foundry V14 compatibility** — chat-hook HTML is normalized with `$(html)` before querying elements, fixing `html.find is not a function` on buttons rendered in chat ("Roll Damage", "Apply Damage", etc.).

## v0.16.3 - Species logic for Monster Knowledge and standard combat maps

- **Species logic for Monster Knowledge** — new `system.species` field on monsters, used by Monster Knowledge to share weakness discoveries between monsters of the same species. The species name is shown on the monster sheet header and defaults to the monster's own name when not explicitly set (for newly created or compendium-imported monsters). Weakness knowledge is shared per species; statistics revelation remains per-actor.
- **Standard combat maps** — Combat A, Combat B and Coliseum scenes created in a "Simplified Combat Battlefields" folder on first world setup; all maps normalized to `.webp` format with short side ≈1200 px (Combat A: 1200×1688, Combat B: 1709×1200, Coliseum: 794×1123 at grid 50). Existing scenes are not moved.- **Map normalization** — all standard combat maps use `.webp` format; Combat A (1200×1688) and Combat B (1709×1200) resized with short side ≈1200 px preserving aspect ratio; Coliseum keeps 794×1123 with grid 50.

## v0.16.2 - Monster section identity and parser fixes

- **Section Source Data panel removed** — the internal debug panel that exposed raw section source data on the monster sheet has been removed; section identities, combat styles and Unique Skill associations are preserved.
- **Duplicate-named sections** — monsters whose wiki declares multiple sections with the same name (Amphisbaena two "Head", Dragon Corpse two "Wing", Dullahan two "Horse") now get distinct section IDs so each section keeps its own combat styles and Unique Skill assignments.
- **Parser fixes** — `&#32;` spacer cells no longer misalign combat statistics (Spinel Hood); stats-only modifier rows are skipped; `Sections:`/`Main Section:` footer lines after the combat table no longer break parsing; nested style annotations such as `Play (Fingers (1-5))` and `Legs (Body) x 1-4` parse correctly.
- **Corrected compendium data** — Casting Hand (sections "Fingers (1-5)" + "Wrist", style "Play", stats per wiki, Unique Skills scoped per wiki headings), Amphisbaena (two independent Head sections), Dragon Corpse (Body + two Wing sections), Dullahan (two Horse sections, pseudo-skills removed), Plain Centipede (pseudo-skill "Body" removed), Spinel Hood (combat statistics fixed to wiki values).

## v0.16.1 - Monster unique skills by section

- **Unique Skills per monster section** — on multi-section monsters, each Unique Skill can now be assigned to a specific combat section or to "All Sections". Skills are displayed grouped by section on the monster sheet, with a section heading per group.
- **Section assignment picker** — the GM can change a skill's section assignment from the sheet. If a skill was previously assigned to a section that no longer exists, it is flagged for reassignment and shows a warning until assigned to a current section or All Sections.
- **Single-section monsters** — Unique Skills are not sectioned and apply to all sections, keeping the existing behavior unchanged.

## v0.16.0 - Skill checks, spell drops and combat class selectors

- **Skill Checks** — the ordinary skill check catalogue was reorganized and its class selection centralized: each check offers only its associated classes, picks the highest-level one automatically, and keeps manual selections while they remain valid.
- **New skill checks** — additional skills incorporated, with some resolution times adjusted to the rulebooks.
- **Spell drag & drop** — dropping a spell onto a character now either sends it straight to the class page being viewed or opens a picker restricted to wizard-type classes; spells are never lost if the character has no eligible class.
- **Defensive Combat Stats** — the Defense Class selector lists only warrior-type classes and selects one automatically; Marksman can also be used for Evasion once the Archer's Grace combat feat is learned.
- **Initiative** — the manual Scout/Tactician level field was replaced by an "Initiative Class" picker offering only the character's Scout and Tactician classes, defaulting to the highest level.

### Monster Actors

- **Multi-section monsters** — imported profiles retain each section's individual statistics and preserve the Main Section as named, all, none, special, or unspecified.
- **Special source values** — notations such as `-`, `※` and `※+20` are preserved as written rather than automatically treated as zero.
- **Validated imports** — monster profiles and their section statistics are checked before an Actor is updated, so incomplete section data is not silently imported.
- **Skill references** — unique-skill descriptions retain their original wording and Markdown link references.
- **Combat Statistics compatibility** — existing monster records with combined Style/Section text remain readable, while the sheet presents these as separate fields and preserves each combat statistic.

## v0.15.2 - Monster combat statistics and sections

- **Monster Combat Statistics** — Fighting Styles from the monster compendium are displayed with separate editable Style and Section fields, alongside their Accuracy, Damage, Evasion, Defense, HP and MP.
- **Main Section selection** — multi-section monsters can mark exactly one Combat Statistics row as the Main Section; a single row remains implicitly selected, and existing combined Style/Section records remain readable.
- **Section-aware imports** — imported profiles retain per-section statistics, source notations and Main Section designations, with validation before updating an Actor.

## v0.15.1 - Deprecation and chat hooks fixes

- **Actor/Item sheet classes** — `ActorSheet` and `ItemSheet` globals replaced with `foundry.appv1.sheets.ActorSheet` and `foundry.appv1.sheets.ItemSheet` in `actor-sheet.mjs`, `monster-sheet.mjs`, `npc-sheet.mjs`, `fellow-sheet.mjs` and `item-sheet.mjs` to remove Foundry V14 deprecation warnings.
- **Chat message HTML hook** — `renderChatMessageHTML` now wraps `html` in `$(html)` before calling `.find()`, fixing `html.find is not a function` errors when buttons like "Roll Damage" or "Add Natural Power" are rendered in chat.

## v0.15.0 - Features carried over from Daedalus v0.15.3

- **Adventurer sheet theme** — character, NPC and Fellow sheets can switch between the classic "Paper" look and a dark "Adventurer" theme via a selector on the sheet. The choice is stored per actor.
- **Standard combat maps** — two ready-made combat scenes ("Combat A" and "Combat B", matching the combat maps in Core Rulebook Vol. 1) using a 1 m gridless background, created automatically for new worlds and repairable from the System Settings. (Updated in this release: Combat A now uses a new, higher-resolution battlemap.)
- **Item transfer between actors** — Items can be dragged from one actor to another (via the Actor Directory or sheet header), and class/exp changes follow the target actor. Race items still run their dedicated import.
- **Bulk spell importer** — open a class's spell tab and click "Import SW2.5 Spells" to import the full spell list of every class on the character from the wiki, with a concurrent pre-fetch pool for speed. A single `spell:` URL also imports as one spell.
- **Import SW2.5 Item** — a button in the Item Directory imports a single item from a wiki page ID or URL.
- **"Abyss Gaer" → "Abyss Gazer"** — the old misspelling in imported wiki text is corrected automatically, and legacy flagged imports get updated names/classes.
- Three truncated legacy stub files that the base imports referenced but that never existed upstream were removed; nothing else was dropped from Daedalus v0.15.3 except the Portrait/Token toggle (compatibility issues).

## v0.14.24

- **Race Item Drop** - The first patch allows dropping race Items onto sheets. On a **character sheet** a dropped race Item runs the full race import (languages, racial abilities, ability corrections, and background). On the **Fellow sheet** the race Item's name is simply copied into the Race field.

- **New Actor Types**:

- **NPC** — a descriptive, non-combat actor for scene characters. Its sheet includes identity, portrait, appearance, personality, goals, and notes.
- **Fellow** — a separate actor format with profile details and the four-row Fellow Action Table. The roll button opens a dropdown to order one of the table's actions, rolls 1d6, and resolves the order per Core Rulebook I: if the rolled row matches the ordered one the Fellow performs it (action, dialogue, value, and effect are posted to chat, and any MP cost is deducted), otherwise the order is not followed and the action is cancelled without spending MP. Rolling also refuses the action outright when the Fellow does not have enough MP.

The Fellow action roller does not resolve attacks, spell effects, or combat turns automatically; the GM and party adjudicate the action using its listed value and effect.

## Installation

In Foundry VTT, open Game Systems → Install System and paste this Manifest URL:

https://raw.githubusercontent.com/matsu-o-taka/Sword-World-2.5-Taka/main/system.json

---

O-Taka