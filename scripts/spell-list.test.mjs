import assert from "node:assert/strict";
import { SW25Importer } from "../module/importer/sw25-importer.mjs";

const parse = SW25Importer.parseSpellList.bind(SW25Importer);

const LIST = [
  "# Level 1",
  "- [Fire Bolt](https://sw25.wikidot.com/spell:fire-bolt)",
  "- [Missile](https://sw25.wikidot.com/spell:missile)",
  "https://sw25.wikidot.com/spell:torch-light",
  "",
  "## Level 2",
  "- [Spark](http://sw25.wikidot.com/spell:spark)",
  "[Grip Vine](https://sw25.wikidot.com/spell:grip-vine#lore)",
  "",
  "### Level 3",
  "- [Fire Storm](https://sw25.wikidot.com/spell:fire-storm)",
  "### Level 4",
  "- [Cataclysm](https://sw25.wikidot.com/spell:cataclysm)",
  "",
  "See also [Equipment](https://sw25.wikidot.com/items:swords) and [More Magic](https://example.com/spell:nope)."
].join("\n");

{
  const entries = parse(LIST, "https://sw25.wikidot.com/spells:magitech", Infinity);
  assert.ok(Array.isArray(entries));
  // Only spell: links on the SW25 wiki are collected; items:/external links are dropped.
  assert.equal(entries.length, 7);
  // Entries are sorted by level first.
  assert.deepEqual(entries.slice(0, 3).map(e => e.level), [1, 1, 1]);
  // The same slug reached via http, https, and a #anchor collapses to one entry,
  // canonicalized to https and without the fragment.
  const unique = new Set(entries.map(e => e.url));
  assert.equal(unique.size, entries.length);
  const names = entries.map(e => e.url);
  assert(names.includes("https://sw25.wikidot.com/spell:fire-bolt"));
  assert(names.includes("https://sw25.wikidot.com/spell:torch-light"));
  assert(!names.includes("https://sw25.wikidot.com/spell:grip-vine#lore"));
  for (const entry of entries) assert(/^https:/.test(entry.url));
}

{
  // A level cap stops collection at headings above the chosen level.
  const entries = parse(LIST, "https://sw25.wikidot.com/spells:magitech", 2);
  assert.deepEqual(entries.map(e => e.level), [1, 1, 1, 2, 2]);
}

{
  // Links seen before the first "Level N" heading are dropped (level 0).
  const entries = parse("- [Early](https://sw25.wikidot.com/spell:early)\n# Level 1\n- [Late](https://sw25.wikidot.com/spell:late)", "", 9);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, "https://sw25.wikidot.com/spell:late");
}

{
  // Markdown headings without "Level N" never escalate the tracked level.
  const entries = parse("## Casting\n- [A](https://sw25.wikidot.com/spell:a)\n# Level 5\n- [B](https://sw25.wikidot.com/spell:b)", "", 9);
  assert.deepEqual(entries.map(e => e.level), [5]);
  assert.equal(entries[0].url, "https://sw25.wikidot.com/spell:b");
}

{
  // Relative spell URLs resolve against the list page. Links before the first
  // "Level N" heading stay at level 0 and are dropped, so provide the heading.
  const entries = parse("# Level 1\n[H](/spell:haze)", "https://sw25.wikidot.com/spells:druid", 9);
  assert.deepEqual(entries.map(e => e.level), [1]);
  assert.equal(entries[0].url, "https://sw25.wikidot.com/spell:haze");
}

{
  // Nothing to collect.
  assert.deepEqual(parse("", "", 9), []);
  assert.deepEqual(parse("[X](https://sw25.wikidot.com/item:sword)", "", 9), []);
}

console.log("Spell list parser tests passed.");
