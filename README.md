# Sword World 2.5 (Taka fork)

This is a fork of [Sword-World-2.5-Foundry](https://github.com/DaedaIus/Sword-World-2.5-Foundry) by **Daedalus**, adding patches and new features on top of the original system.

A note from me: I am not a programmer. I am building and maintaining this fork as a hobby, with the help of AI, purely as a fan of Sword World 2.5. I test everything as I go hoping it works, but expect rough edges.

## v0.14.25 - Fixes

Fixed Foundry VTT 13+ deprecation warnings for global Actors/Items access

## Race Item Drop

The first patch allows dropping race Items onto sheets. On a **character sheet** a dropped race Item runs the full race import (languages, racial abilities, ability corrections, and background). On the **Fellow sheet** the race Item's name is simply copied into the Race field.

## New Actor Types

- **NPC** — a descriptive, non-combat actor for scene characters. Its sheet includes identity, portrait, appearance, personality, goals, and notes.
- **Fellow** — a separate actor format with profile details and the four-row Fellow Action Table. The roll button opens a dropdown to order one of the table's actions, rolls 1d6, and resolves the order per Core Rulebook I: if the rolled row matches the ordered one the Fellow performs it (action, dialogue, value, and effect are posted to chat, and any MP cost is deducted), otherwise the order is not followed and the action is cancelled without spending MP. Rolling also refuses the action outright when the Fellow does not have enough MP.

The Fellow action roller does not resolve attacks, spell effects, or combat turns automatically; the GM and party adjudicate the action using its listed value and effect.

## Installation

In Foundry VTT, open Game Systems → Install System and paste this Manifest URL:

https://raw.githubusercontent.com/matsu-o-taka/Sword-World-2.5-Taka/main/system.json

---

O-Taka
