# Sword World 2.5 (Taka fork)

This is a fork of [Sword-World-2.5-Foundry](https://github.com/DaedaIus/Sword-World-2.5-Foundry) by **Daedalus**, adding patches and new features on top of the original system.

A note from me: I am not a programmer. I am building and maintaining this fork as a hobby, with the help of AI, purely as a fan of Sword World 2.5. I test everything as I go hoping it works, but expect rough edges.

## v0.14.24

- **Race Item Drop** - The first patch allows dropping race Items onto sheets. On a **character sheet** a dropped race Item runs the full race import (languages, racial abilities, ability corrections, and background). On the **Fellow sheet** the race Item's name is simply copied into the Race field.

- **New Actor Types**:

- **NPC** — a descriptive, non-combat actor for scene characters. Its sheet includes identity, portrait, appearance, personality, goals, and notes.
- **Fellow** — a separate actor format with profile details and the four-row Fellow Action Table. The roll button opens a dropdown to order one of the table's actions, rolls 1d6, and resolves the order per Core Rulebook I: if the rolled row matches the ordered one the Fellow performs it (action, dialogue, value, and effect are posted to chat, and any MP cost is deducted), otherwise the order is not followed and the action is cancelled without spending MP. Rolling also refuses the action outright when the Fellow does not have enough MP.

The Fellow action roller does not resolve attacks, spell effects, or combat turns automatically; the GM and party adjudicate the action using its listed value and effect.

## v0.14.25 - Fixes

Fixed Foundry VTT 13+ deprecation warnings for global Actors/Items access

## v0.15.0 - Features carried over from Daedalus v0.15.3

- **Adventurer sheet theme** — character, NPC and Fellow sheets can switch between the classic "Paper" look and a dark "Adventurer" theme via a selector on the sheet. The choice is stored per actor.
- **Standard combat maps** — two ready-made combat scenes ("Combat A" and "Combat B", matching the combat maps in Core Rulebook Vol. 1) using a 1 m gridless background, created automatically for new worlds and repairable from the System Settings. (Updated in this release: Combat A now uses a new, higher-resolution battlemap.)
- **Item transfer between actors** — Items can be dragged from one actor to another (via the Actor Directory or sheet header), and class/exp changes follow the target actor. Race items still run their dedicated import.
- **Bulk spell importer** — open a class's spell tab and click "Import SW2.5 Spells" to import the full spell list of every class on the character from the wiki, with a concurrent pre-fetch pool for speed. A single `spell:` URL also imports as one spell.
- **Import SW2.5 Item** — a button in the Item Directory imports a single item from a wiki page ID or URL.
- **"Abyss Gaer" → "Abyss Gazer"** — the old misspelling in imported wiki text is corrected automatically, and legacy flagged imports get updated names/classes.
- Mini fixes: class tab styling hooks, higher-accuracy feature section names on the character sheet (`sheetDisplayName`), corrected data checks.

Three truncated legacy stub files that the base imports referenced but that never existed upstream were removed; nothing else was dropped from Daedalus v0.15.3 except the Portrait/Token toggle (compatibility issues).

## Installation

In Foundry VTT, open Game Systems → Install System and paste this Manifest URL:

https://raw.githubusercontent.com/matsu-o-taka/Sword-World-2.5-Taka/main/system.json

---

O-Taka
