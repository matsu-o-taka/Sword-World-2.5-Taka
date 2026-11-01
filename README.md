# Sword World 2.5 (Taka fork)

This is a fork of [Sword-World-2.5-Foundry](https://github.com/DaedaIus/Sword-World-2.5-Foundry) by **Daedalus**, adding patches and new features on top of the original system.

A note from me: I am not a programmer. I am building and maintaining this fork as a hobby, with the help of AI, purely as a fan of Sword World 2.5. I test everything as I go hoping it works, but expect rough edges.

![Foundry VTT version](https://img.shields.io/badge/Foundry-V14%2B-orange)

## v0.14.24

- **Race Item Drop** - The first patch allows dropping race Items onto sheets. On a **character sheet** a dropped race Item runs the full race import (languages, racial abilities, ability corrections, and background). On the **Fellow sheet** the race Item's name is simply copied into the Race field.

- **New Actor Types**:

- **NPC** — a descriptive, non-combat actor for scene characters. Its sheet includes identity, portrait, appearance, personality, goals, and notes.
- **Fellow** — a separate actor format with profile details and the four-row Fellow Action Table. The roll button opens a dropdown to order one of the table's actions, rolls 1d6, and resolves the order per Core Rulebook I: if the rolled row matches the ordered one the Fellow performs it (action, dialogue, value, and effect are posted to chat, and any MP cost is deducted), otherwise the order is not followed and the action is cancelled without spending MP. Rolling also refuses the action outright when the Fellow does not have enough MP.

The Fellow action roller does not resolve attacks, spell effects, or combat turns automatically; the GM and party adjudicate the action using its listed value and effect.

## v0.15.0 - Features carried over from Daedalus v0.15.3

- **Adventurer sheet theme** — character, NPC and Fellow sheets can switch between the classic "Paper" look and a dark "Adventurer" theme via a selector on the sheet. The choice is stored per actor.
- **Standard combat maps** — two ready-made combat scenes ("Combat A" and "Combat B", matching the combat maps in Core Rulebook Vol. 1) using a 1 m gridless background, created automatically for new worlds and repairable from the System Settings. (Updated in this release: Combat A now uses a new, higher-resolution battlemap.)
- **Item transfer between actors** — Items can be dragged from one actor to another (via the Actor Directory or sheet header), and class/exp changes follow the target actor. Race items still run their dedicated import.
- **Bulk spell importer** — open a class's spell tab and click "Import SW2.5 Spells" to import the full spell list of every class on the character from the wiki, with a concurrent pre-fetch pool for speed. A single `spell:` URL also imports as one spell.
- **Import SW2.5 Item** — a button in the Item Directory imports a single item from a wiki page ID or URL.
- **"Abyss Gaer" → "Abyss Gazer"** — the old misspelling in imported wiki text is corrected automatically, and legacy flagged imports get updated names/classes.
- Mini fixes: class tab styling hooks, higher-accuracy feature section names on the character sheet (`sheetDisplayName`), corrected data checks.

Three truncated legacy stub files that the base imports referenced but that never existed upstream were removed; nothing else was dropped from Daedalus v0.15.3 except the Portrait/Token toggle (compatibility issues).

## v0.15.1 - Deprecation and chat hooks fixes

- **Actor/Item sheet classes** — `ActorSheet` and `ItemSheet` globals replaced with `foundry.appv1.sheets.ActorSheet` and `foundry.appv1.sheets.ItemSheet` in `actor-sheet.mjs`, `monster-sheet.mjs`, `npc-sheet.mjs`, `fellow-sheet.mjs` and `item-sheet.mjs` to remove Foundry V14 deprecation warnings.
- **Chat message HTML hook** — `renderChatMessageHTML` now wraps `html` in `$(html)` before calling `.find()`, fixing `html.find is not a function` errors when buttons like "Roll Damage" or "Add Natural Power" are rendered in chat.

## v0.15.2 - Monster combat statistics and sections

- **Monster Combat Statistics** — Fighting Styles from the monster compendium are displayed with separate editable Style and Section fields, alongside their Accuracy, Damage, Evasion, Defense, HP and MP.
- **Main Section selection** — multi-section monsters can mark exactly one Combat Statistics row as the Main Section; a single row remains implicitly selected, and existing combined Style/Section records remain readable.
- **Section-aware imports** — imported profiles retain per-section statistics, source notations and Main Section designations, with validation before updating an Actor.

## Monster Actors

- **Multi-section monsters** — imported profiles retain each section's individual statistics and preserve the Main Section as named, all, none, special, or unspecified.
- **Special source values** — notations such as `-`, `※` and `※+20` are preserved as written rather than automatically treated as zero.
- **Validated imports** — monster profiles and their section statistics are checked before an Actor is updated, so incomplete section data is not silently imported.
- **Skill references** — unique-skill descriptions retain their original wording and Markdown link references.
- **Combat Statistics compatibility** — existing monster records with combined Style/Section text remain readable, while the sheet presents these as separate fields and preserves each combat statistic.
- **Cursed Artist's concealed Main Section** — for the imported [Cursed Artist profile](https://sw25.wikidot.com/monster:cursed-artist) (CR III p. 368), a Musician or Instrument section is selected once per scene token. The GM can resolve targeted Monster Knowledge rolls from their chat card; meeting the profile's Weakness reveals the selected section and posts its existing Weak Point text. Other monsters marked `Special` are not automatically assigned this behavior.

The selection is stored in a JournalEntry with Foundry's default ownership set to `NONE`; the token flag contains only its Journal UUID until revelation. This permission design is covered by code and mock tests, but has **not** been verified with separate GM and player clients, so do not rely on secrecy until that live check is completed. Weak Point text is shown for the group to apply; the system does not derive damage modifiers from it. Section-specific HP damage, zero-HP Main Section handling, and Death Checks are not implemented.

## Installation

In Foundry VTT, open Game Systems → Install System and paste this Manifest URL:

https://raw.githubusercontent.com/matsu-o-taka/Sword-World-2.5-Taka/main/system.json

---

O-Taka
