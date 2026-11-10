const plain = value => String(value ?? "")
  .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;|&#32;|&#x20;/gi, " ")
  .replace(/[`*_~]/g, "")
  .replace(/[ \t]+/g, " ")
  .trim();

const markdownLinks = sourceText => [...String(sourceText ?? "").matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map(match => {
  const [destination, title = ""] = match[2].split(/\s+"(.+)"\s*$/s);
  const identifier = destination.trim().match(/(?:^|\/)([a-z][a-z0-9-]*:[^/?#]+)/i)?.[1] || null;
  return {
    sourceText: match[0],
    label: match[1],
    destination: destination.trim().replace(/^<|>$/g, ""),
    title: title || "",
    skillIdentifier: identifier
  };
});

const numeric = value => Number(String(value ?? "").match(/-?\d+/)?.[0] ?? 0);
const sourceValue = value => String(value ?? "").trim();
const normalizedSectionName = value => sourceValue(value).replace(/\s+/g, " ").toLowerCase();
const singularForm = name => /^[A-Za-z]+s$/.test(name) ? name.replace(/s$/, "") : name;
const parenFreeStem = name => normalizedSectionName(String(name ?? "").replace(/\([^()]*\)/g, " "));
const sectionNamesEquivalent = (left, right) => {
  const leftName = normalizedSectionName(left);
  const rightName = normalizedSectionName(right);
  if (!leftName || !rightName) return false;
  if (leftName === rightName) return true;
  const leftStem = parenFreeStem(leftName);
  const rightStem = parenFreeStem(rightName);
  if (leftStem === rightStem) return true;
  return leftStem === singularForm(rightStem) || rightStem === singularForm(leftStem);
};
const legacyStatisticValue = value => {
  const raw = sourceValue(value);
  return /^[+-]?\d+$/.test(raw) ? Number(raw) : raw;
};

const tableCells = line => String(line).split("|").map(plain).filter((cell, index, cells) =>
  cell || (index > 0 && index < cells.length - 1)
);

export function parseSectionCombatStatistics(cells = [], headers = []) {
  const values = cells.map(sourceValue);
  return {
    style: values[0] || "",
    accuracy: values[1] || "",
    damage: values[2] || "",
    evasion: values[3] || "",
    defense: values[4] || "",
    hp: values[5] || "",
    mp: values[6] || "",
    additionalStatistics: values.slice(7).map((value, index) => ({
      name: sourceValue(headers[index + 7]),
      value
    })),
    sourceValues: values
  };
}

export function parseSectionDeclaration(value = "") {
  const sourceValue = String(value ?? "").trim();
  const match = sourceValue.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  const labels = match
    ? match[2].split(/\s*\/\s*|\s*,\s*/).map(label => label.trim()).filter(Boolean)
    : [];
  const sections = labels.map(label => {
    const count = label.match(/\s+x\s*(.+)$/i)?.[1]?.trim() || "";
    return {
      name: label.replace(/\s+x\s*.+$/i, "").trim(),
      label,
      count
    };
  });
  return { sourceValue, count: match ? match[1].trim() : sourceValue, sections };
}

export function parseMainSection(value = "", uniqueSkills = [], combatStyles = []) {
  const sourceValue = String(value ?? "").trim();
  let type = "unspecified";
  let combatStyleIds = [];
  if (/^none$/i.test(sourceValue)) type = "none";
  else if (/^special(?:\s*,?\s*see below)?$/i.test(sourceValue)) type = "special";
  else if (/\(\s*all\s*\)\s*$/i.test(sourceValue)) {
    type = "all";
    combatStyleIds = combatStyles.map(cs => cs.id).filter(Boolean);
  } else if (sourceValue) {
    type = "named";
    const names = sourceValue.split(",").map(name => name.trim()).filter(Boolean);
    for (const name of names) {
      const match = combatStyles.find(cs => sectionNamesEquivalent(cs.section || cs.sectionLabel || cs.style, name));
      if (match && match.id) combatStyleIds.push(match.id);
    }
  }
  const associatedSkills = type === "special"
    ? uniqueSkills.filter(skill => /concealed main section/i.test(skill.title || "")).map(skill => ({
      skillId: skill.id || "",
      title: skill.title
    }))
    : [];
  return { type, sourceValue, combatStyleIds, associatedSkills };
}

export function associatedSkillReferences(mainSection, uniqueSkills = []) {
  if (mainSection?.type !== "special") return [];
  return uniqueSkills
    .filter(skill => /concealed main section/i.test(skill.title || ""))
    .map(skill => ({ skillId: skill.id, title: skill.title }));
}

function normalizeMonsterSource(input) {
  let source = String(input ?? "").replace(/\r/g, "");
  const contentStart = source.indexOf('id="page-content"');
  const contentEnd = source.indexOf('id="pagetags"');
  if (contentStart >= 0 && contentEnd > contentStart) source = source.slice(contentStart, contentEnd);
  return source
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, inner) => `\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]+>/g, "").trim()}\n`)
    .replace(/(?<=<\/t[dh]>)\s*\n\s*(?=<t[dh])/gi, " ")
    .replace(/(<tr[^>]*>)\s*\n\s*(?=<t[dh])/gi, "$1")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/(?:p|div|li)>/gi, "\n")
    .replace(/<\/(?:td|th)>/gi, " | ");
}

export function parseMonsterPage(input = "", url = "") {
  const source = normalizeMonsterSource(input);
  const sourceLines = source.split("\n")
    .map((rawText, index) => ({ text: rawText.trim(), rawText, lineNumber: index + 1 }))
    .filter(line => line.text && plain(line.text));
  const rawLines = sourceLines.map(line => line.text);
  const lines = rawLines.map(plain).filter(Boolean);
  const slugName = (() => {
    try { return decodeURIComponent(new URL(url).pathname.split(":").pop() || "Monster").replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }
    catch { return "Monster"; }
  })();
  const readerTitle = plain(lines.find(line => /^Title:/i.test(line))?.replace(/^Title:\s*/i, "").replace(/\s+-\s+Sword World.*$/i, ""));
  const levelLine = lines.find(line => /^(?:#{1,6}\s*)?Level\s+\d+\b/i.test(line)) || "";
  const levelMatch = levelLine.match(/Level\s+(\d+)\s+(.+?)\s*$/i);
  const createAt = lines.findIndex(line => /^#{0,6}\s*Create a Page$/i.test(line));
  const pageName = createAt >= 0 ? lines.slice(createAt + 1).find(line => !/^Home\b|^#{1,6}/i.test(line)) : "";
  const heading = lines.find(line => /^#{1,3}\s+/.test(line) && !/Sword World|Level\s+\d+|Create a Page|Site Navigation/i.test(line));
  const usefulReaderTitle = /Sword World 2\.5 Reference Wiki/i.test(readerTitle) ? "" : readerTitle;
  const name = usefulReaderTitle || plain(pageName) || plain(String(heading || slugName).replace(/^#{1,6}\s+/, "")) || slugName;
  const field = label => {
    const match = lines.find(line => new RegExp(`^${label}\\s*:`, "i").test(line));
    return plain(match?.replace(/^[^:]+:\s*/, "") || "");
  };

  const reputationWeakness = field("Reputation\\s*\\/\\s*Weakness");
  const [reputation = "0", weakness = "0"] = reputationWeakness.split("/").map(value => value.trim());
  const combatHeader = rawLines.findIndex(line => /Accuracy/i.test(line) && /Damage/i.test(line) && /Evasion/i.test(line) && /Defense/i.test(line) && /\bHP\b/i.test(line));
  const combatStyles = [];
  const declaredSections = parseSectionDeclaration(field("Sections"));
  const sectionParseErrors = [];
  let combatStyleCounter = 0;
  if (combatHeader >= 0) {
    for (let index = combatHeader + 1; index < rawLines.length; index++) {
      const line = rawLines[index];
      const sourceLineNumber = sourceLines[index].lineNumber;
      if (/^(?:#{1,6}|\*\s*\*\s*\*)/.test(plain(line)) || /Unique Skills|\bLoot\b/i.test(plain(line))) break;
      if (/^(?:Sections|Main Section)\s*:/i.test(plain(line))) break;
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue;
      const cells = tableCells(line);
      if (/Accuracy|Fighting Style/i.test(cells.join(" "))) continue;
      let compact = cells.filter(cell => cell !== "");
      const sectionAnnotation = line.match(/\(([^()]*)\)/)?.[1]?.replace(/\s+x\s*.+$/i, "").trim();
      const statisticToken = String.raw`(?:※(?:\s*[+-]\s*\d+)?|[-–—]|[-+]?\d+(?:\s*\(\s*[-+]?\d+\s*\))?|\d+d(?:6)?(?:\s*[+-]\s*\d+)?)`;
      const sourceStatisticCount = [...plain(line).matchAll(new RegExp(`(?:^|[\\s|])${statisticToken}(?=$|[\\s|])`, "gi"))].length;
      const looksLikeCombatRow = (line.includes("|") && cells.some(Boolean)) || Boolean(sectionAnnotation) || sourceStatisticCount >= 4;
      if (compact.length < 7) {
        const flatLine = plain(line);
        const stat = String.raw`(?:※(?:\s*[+-]\s*\d+)?|[-–—]|[-+]?\d+(?:\s*\(\s*[-+]?\d+\s*\))?|\d+d(?:6)?(?:\s*[+-]\s*\d+)?)`;
        const flat = flatLine.match(new RegExp(`^(.+?)\\s+(${stat})\\s+(${stat})\\s+(${stat})\\s+(${stat})\\s+(${stat})\\s+(${stat})$`, "i"));
        if (!flat) {
          if (looksLikeCombatRow && /[\p{L}]/u.test(compact[0] || "")) {
            sectionParseErrors.push(`line ${sourceLineNumber}: malformed combat row for ${sectionAnnotation || "unknown section"}; expected a style plus Accuracy, Damage, Evasion, Defense, HP and MP, got "${plain(line)}".`);
          }
          continue;
        }
        compact = flat.slice(1);
      }
      if (compact.length < 7) {
        if (looksLikeCombatRow && /[\p{L}]/u.test(compact[0] || "")) {
          sectionParseErrors.push(`line ${sourceLineNumber}: malformed combat row for ${sectionAnnotation || "unknown section"}; expected a style plus Accuracy, Damage, Evasion, Defense, HP and MP, got "${plain(line)}".`);
        }
        continue;
      }
      if (!/[\p{L}]/u.test(String(compact[0] ?? ""))) continue;
      const sourceStyle = sourceValue(compact[0]);
      const matchSource = sourceStyle.replace(/\)\s+x\s*[^()]+$/i, ")");
      const annotation = matchSource.match(/^(.*?)\s*\((.*)\)\s*$/);
      const sourceSectionLabel = annotation?.[2]?.trim() || "";
      const sourceSectionName = sourceSectionLabel.replace(/\s+x\s*.+$/i, "").trim();
      const attackStyle = annotation?.[1]?.trim() || sourceStyle;
      const sourceHeaders = tableCells(rawLines[combatHeader]).filter(Boolean);
      const rawStatistics = parseSectionCombatStatistics([attackStyle, ...compact.slice(1)], sourceHeaders);
      rawStatistics.sourceStyle = sourceStyle;
      rawStatistics.sectionLabel = sourceSectionLabel;
      rawStatistics.sourceLine = sourceLineNumber;

      combatStyleCounter += 1;
      combatStyles.push({
        id: `cs-${combatStyleCounter}`,
        style: attackStyle || "Attack",
        accuracy: compact[1] || "0",
        damage: compact[2] || "2d",
        evasion: compact[3] || "0",
        defense: legacyStatisticValue(compact[4]),
        hp: { value: legacyStatisticValue(compact[5]), max: legacyStatisticValue(compact[5]) },
        mp: { value: legacyStatisticValue(compact[6]), max: legacyStatisticValue(compact[6]) },
        sourceValues: compact.map(sourceValue),
        sectionLabel: sourceSectionLabel,
        section: sourceSectionLabel,
        sourceStyle: sourceStyle
      });
    }
  }
  const mainSection = parseMainSection(field("Main Section"), [], combatStyles);

  // Asignar isMainSection en cada entrada de combatStyles según la Main Section declarada.
  // Sólo se marca una entrada como Main Section (la primera que coincida).
  if (mainSection.type === "named" && mainSection.combatStyleIds.length > 0) {
    let mainSectionAssigned = false;
    for (const cs of combatStyles) {
      const isMain = mainSection.combatStyleIds.includes(cs.id) && !mainSectionAssigned;
      cs.isMainSection = isMain;
      if (isMain) mainSectionAssigned = true;
    }
  } else if (mainSection.type === "all") {
    for (const cs of combatStyles) {
      cs.isMainSection = true;
    }
  } else {
    for (const cs of combatStyles) {
      cs.isMainSection = false;
    }
  }

  const lootHeader = rawLines.findIndex(line => /\b2d\b/i.test(line) && /\bLoot\b/i.test(line));
  const lootTable = [];
  if (lootHeader >= 0) {
    for (let index = lootHeader + 1; index < rawLines.length; index++) {
      const line = rawLines[index];
      if (/^#{1,6}\s/.test(line)) break;
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue;
      let cells = tableCells(line).filter(Boolean);
      if (cells.length < 2) {
        const flat = plain(line).match(/^(Always|\d+\s*(?:[-–]\s*\d+|\+))\s*(.+)$/i);
        if (!flat) continue;
        cells = [flat[1], flat[2]];
      }
      const roll = cells[0];
      if (!/^(?:Always|\d+\s*(?:[-–]\s*\d+|\+)?)$/i.test(roll)) continue;
      lootTable.push({ roll, loot: cells.slice(1).join(" | ") });
    }
  }

  const uniqueStart = lines.findIndex(line => /^(?:#{1,6}\s*)?Unique Skills$/i.test(line));
  const uniqueEnd = lines.findIndex((line, index) => index > uniqueStart && /\b2d\b.*\bLoot\b/i.test(line));
  const uniqueSkills = [];
  const skillParseErrors = [];
  if (uniqueStart >= 0) {
    const blockEnd = uniqueEnd > uniqueStart ? uniqueEnd : lines.length;
    const block = sourceLines.slice(uniqueStart + 1, blockEnd);
    let current = null;
    let sectionScope = "unspecified";
    let combatStyleId;
    for (const sourceLine of block) {
      const line = sourceLine.text;
      const visibleLine = plain(line);
      const markdownHeading = visibleLine.match(/^(#{4,6})\s+(.+)$/);
      const headingText = markdownHeading ? plain(markdownHeading[2]) : "";
      const isAllSectionsHeading = markdownHeading && /^All Sections$/i.test(headingText);
      const matchedCombatStyle = markdownHeading
        ? combatStyles.find(cs => cs.section && sectionNamesEquivalent(cs.section, headingText))
        : null;
      if (isAllSectionsHeading || matchedCombatStyle) {
        if (current) uniqueSkills.push(current);
        current = null;
        sectionScope = isAllSectionsHeading ? "all" : "section";
        combatStyleId = matchedCombatStyle?.id;
        continue;
      }
      if (markdownHeading?.[1] === "######" && combatStyles.length > 1) {
        if (current) uniqueSkills.push(current);
        current = null;
        sectionScope = "unspecified";
        combatStyleId = undefined;
        skillParseErrors.push(
          `line ${sourceLine.lineNumber}: unique skills heading "${headingText}" does not match "All Sections" or a declared monster section.`
        );
        continue;
      }
      const headingLine = Boolean(markdownHeading) || /^(?:[◯○▶►△⏩🗨])/.test(visibleLine) || /^Concealed Main Section$/i.test(visibleLine);
      if (headingLine) {
        if (current) uniqueSkills.push(current);
        const titleSource = sourceLine.rawText;
        current = {
          title: plain(visibleLine.replace(/^#{1,6}\s+/, "")),
          titleSource,
          description: "",
          descriptionSource: "",
          sourceLine: sourceLine.lineNumber,
          sectionScope,
          ...(sectionScope === "section" ? { combatStyleId } : {})
        };
      } else if (current && !/^Source:/i.test(plain(line))) {
        current.descriptionSource += `${current.descriptionSource ? "\n" : ""}${sourceLine.rawText}`;
        current.description = current.description
          ? `${current.description}\n${plain(line)}`
          : plain(line);
      }
    }
    if (current) uniqueSkills.push(current);
  }
  const usedSkillIds = new Map();
  for (const skill of uniqueSkills) {
    const baseId = skill.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "monster-skill";
    const occurrence = (usedSkillIds.get(baseId) || 0) + 1;
    usedSkillIds.set(baseId, occurrence);
    skill.id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;
    skill.sourceText = `${skill.titleSource}${skill.descriptionSource ? `\n${skill.descriptionSource}` : ""}`;
    skill.references = [...markdownLinks(skill.titleSource), ...markdownLinks(skill.descriptionSource)];
  }
  mainSection.associatedSkills = mainSection.type === "special"
    ? associatedSkillReferences(mainSection, uniqueSkills)
    : [];

  const descriptionStart = lines.findIndex(line => /^Willpower:/i.test(line));
  const descriptionEnd = lines.findIndex((line, index) => index > descriptionStart && (/^Source:/i.test(line) || /Accuracy.*Damage.*Evasion/i.test(line)));
  const description = descriptionStart >= 0
    ? lines.slice(descriptionStart + 1, descriptionEnd > descriptionStart ? descriptionEnd : combatHeader).filter(line => !/^#{1,6}/.test(line)).join("\n\n")
    : "";

  return {
    name,
    system: {
      sourceUrl: url,
      level: numeric(levelMatch?.[1]),
      monsterType: plain(levelMatch?.[2]),
      intelligence: field("Intelligence"), perception: field("Perception"), disposition: field("Disposition"),
      soulscars: numeric(field("Soulscars")), languages: field("Language"), habitat: field("Habitat"),
      species: field("Species"),
      reputation: numeric(reputation), weakness: numeric(weakness), weakPoint: field("Weak Point"),
      initiative: numeric(field("Initiative")), movementSpeed: field("Movement Speed"),
      fortitude: field("Fortitude"), willpower: field("Willpower"), source: field("Source"), description,
      sectionCount: declaredSections.count,
      sectionSource: declaredSections.sourceValue,
      sectionParseErrors, skillParseErrors, mainSection, combatStyles, uniqueSkills, lootTable
    }
  };
}

export function validateMonsterProfile(parsed) {
  const name = String(parsed?.name || "Monster");
  const system = parsed?.system;
  const errors = [];
  if (!Array.isArray(system?.combatStyles) || !system.combatStyles.length) {
    errors.push("combatStyles: no complete Fighting Style statistics were parsed");
  } else {
    for (const [styleIndex, style] of system.combatStyles.entries()) {
      if (!style.id) {
        errors.push(`combatStyles.${styleIndex}: missing stable id`);
      }
      if (!Array.isArray(style.sourceValues) || style.sourceValues.length < 7) {
        errors.push(`combatStyles.${styleIndex}: incomplete source statistics`);
      }
    }
  }
  if (Array.isArray(system?.sectionParseErrors)) errors.push(...system.sectionParseErrors);
  if (Array.isArray(system?.skillParseErrors)) errors.push(...system.skillParseErrors);
  const combatStyleIds = new Set((system?.combatStyles ?? []).map(cs => cs.id));
  for (const skill of system.uniqueSkills ?? []) {
    if (skill.sectionScope === "section" && !combatStyleIds.has(skill.combatStyleId)) {
      errors.push(`uniqueSkills.${skill.title || "untitled"}: combatStyleId "${skill.combatStyleId ?? ""}" does not reference a parsed combat style`);
    }
  }
  if (!system?.mainSection || typeof system.mainSection.sourceValue !== "string") {
    errors.push("mainSection: designation is missing or malformed");
  } else {
    const combatStyleCount = system.combatStyles?.length ?? 0;
    if (combatStyleCount > 1 && !system.mainSection.sourceValue) {
      errors.push("mainSection: designation is required for a multi-section profile");
    } else if (system.mainSection.type === "named") {
      for (const id of system.mainSection.combatStyleIds ?? []) {
        if (!combatStyleIds.has(id)) {
          errors.push(`mainSection: combatStyleId "${id}" does not match a parsed combat style`);
        }
      }
    }
  }
  if (errors.length) throw new Error(`${name}: ${errors.join("; ")}`);
  return true;
}

export function monsterDamageFormula(value = "2d") {
  return String(value || "2d").trim().replace(/(\d+)d(?!\d)/gi, "$1d6").replace(/\s+/g, "");
}

export function lootMatches(value, roll) {
  const label = String(value || "").trim();
  if (/^always$/i.test(label)) return true;
  const range = label.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (range) return roll >= Number(range[1]) && roll <= Number(range[2]);
  const plus = label.match(/^(\d+)\s*\+$/);
  if (plus) return roll >= Number(plus[1]);
  return Number(label) === roll;
}
