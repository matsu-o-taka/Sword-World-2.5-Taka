# Sword World 2.5 (Taka fork)

This is a fork of [Sword-World-2.5-Foundry](https://github.com/DaedaIus/Sword-World-2.5-Foundry) by **Daedalus**, adding patches and new features on top of the original system.

A note from me: I am not a programmer. I am building and maintaining this fork as a hobby, with the help of AI, purely as a fan of Sword World 2.5. I test everything as I go hoping it works, but expect rough edges.

![Foundry VTT version](https://img.shields.io/badge/Foundry-V14%2B-orange) ![System](https://img.shields.io/badge/System-sword--world--25%200.16.2%2B-blue)

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