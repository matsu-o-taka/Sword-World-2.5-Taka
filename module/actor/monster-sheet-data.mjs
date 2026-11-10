const numericValue = value => {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim());
};

const setPath = (target, path, value) => {
  const [property, ...nested] = path.split(".");
  if (!nested.length) {
    target[property] = value;
    return;
  }
  target[property] ??= {};
  setPath(target[property], nested.join("."), value);
};

export function readMonsterCombatStyles(styles) {
  if (Array.isArray(styles)) return styles;
  if (!styles || typeof styles !== "object") return [];

  const indexedRows = Object.entries(styles)
    .filter(([key, value]) => /^\d+$/.test(key) && value && typeof value === "object")
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, value]) => value);
  if (indexedRows.length) return indexedRows;

  const flattenedRows = [];
  for (const [path, value] of Object.entries(styles)) {
    const match = path.match(/^(\d+)\.(.+)$/);
    if (!match) continue;
    const index = Number(match[1]);
    flattenedRows[index] ??= {};
    setPath(flattenedRows[index], match[2], value);
  }
  if (flattenedRows.length) return flattenedRows.filter(Boolean);

  return ["style", "section", "sectionLabel", "accuracy", "damage", "evasion", "defense", "hp", "mp"]
    .some(key => Object.hasOwn(styles, key)) ? [styles] : [];
}

export function readMonsterActorCombatStyles(actor) {
  const candidates = [
    actor?.system?.combatStyles,
    actor?._source?.system?.combatStyles,
    actor?.toObject?.()?.system?.combatStyles
  ];
  let emptyStyles = [];
  for (const candidate of candidates) {
    const styles = readMonsterCombatStyles(candidate);
    if (styles.length) return styles;
    if (!emptyStyles.length && Array.isArray(candidate)) emptyStyles = styles;
  }
  return emptyStyles;
}

function splitLegacyStyle(style = {}, sectionNames = []) {
  const combinedStyle = String(style.style ?? "");
  const match = combinedStyle.match(/^(.*?)\s+\(([^()]+)\)\s*$/);
  const sectionLabel = String(String(style.section ?? "").trim() || String(style.sectionLabel ?? "").trim());
  const normalizeSectionLabel = value => String(value).replace(/\s+x\s*.+$/i, "").trim().toLowerCase();
  const matchingSection = sectionLabel && sectionNames.find(name =>
    String(name).trim().toLowerCase() === normalizeSectionLabel(sectionLabel)
  );
  const section = String(style.section?.trim?.() || matchingSection || sectionLabel);
  const annotationMatchesMetadata = Boolean(match && sectionLabel
    && normalizeSectionLabel(match[2]) === normalizeSectionLabel(sectionLabel));
  const styleName = annotationMatchesMetadata ? match[1].trim() : combinedStyle;
  return { styleName, section, legacyCombinedStyle: match ? combinedStyle : null };
}

export function prepareMonsterCombatStyles(styles = [], sectionNames = []) {
  const rows = readMonsterCombatStyles(styles);
  const mainSectionIndex = getMainCombatStyleIndex(rows);
  return rows.map((style, index) => {
    const { styleName, section, legacyCombinedStyle } = splitLegacyStyle(style, sectionNames);
    return {
      ...style,
      index,
      styleName,
      section,
      legacyCombinedStyle,
      isMainSection: mainSectionIndex === index,
      mainSectionCheckboxDisabled: rows.length === 1,
      defenseEditable: numericValue(style.defense),
      hpValueEditable: numericValue(style.hp?.value),
      hpMaxEditable: numericValue(style.hp?.max),
      mpValueEditable: numericValue(style.mp?.value),
      mpMaxEditable: numericValue(style.mp?.max)
    };
  });
}

export function getMainCombatStyleIndex(styles = []) {
  if (!Array.isArray(styles) || styles.length === 0) return null;
  if (styles.length === 1) return 0;
  const selected = styles.flatMap((style, index) => style?.isMainSection === true ? [index] : []);
  return selected.length === 1 ? selected[0] : null;
}

export function hasValidMainCombatStyle(styles = []) {
  return !Array.isArray(styles) || styles.length <= 1 || getMainCombatStyleIndex(styles) !== null;
}

export function selectMainCombatStyle(styles = [], selectedIndex, selected = true) {
  const rows = (Array.isArray(styles) ? styles : []).map(style => ({ ...style }));
  for (const style of rows) {
    if (style.hp) style.hp = { ...style.hp };
    if (style.mp) style.mp = { ...style.mp };
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= rows.length || rows.length < 2) return rows;
  if (!selected) return rows;
  return rows.map((style, index) => ({
    ...style,
    isMainSection: index === selectedIndex
  }));
}

export function appendMonsterCombatStyle(styles = [], newStyle = {}) {
  const rows = readMonsterCombatStyles(styles).map(style => ({ ...style }));
  if (rows.length === 1) rows[0].isMainSection = true;
  rows.push({ ...newStyle });
  return rows;
}

export function mergeMonsterCombatStyleFields(currentStyles = [], fields = [], sectionNames = []) {
  const styles = readMonsterCombatStyles(currentStyles).map(style => ({
    ...style,
    hp: style.hp ? { ...style.hp } : style.hp,
    mp: style.mp ? { ...style.mp } : style.mp
  }));
  for (const [path, value] of fields) {
    const match = path.match(/^(\d+)\.(.+)$/);
    if (!match) continue;
    const index = Number(match[1]);
    const propertyPath = match[2];
    if (!styles[index]) continue;

    if (propertyPath === "style" || propertyPath === "section") {
      const { legacyCombinedStyle } = splitLegacyStyle(styles[index], sectionNames);
      if (legacyCombinedStyle && !styles[index].sourceStyle) styles[index].sourceStyle = legacyCombinedStyle;
    }

    if (/^(?:defense|hp\.(?:value|max)|mp\.(?:value|max))$/.test(propertyPath)) {
      const currentValue = propertyPath.split(".").reduce((object, key) => object?.[key], styles[index]);
      if (!numericValue(currentValue) || !numericValue(value)) continue;
    }
    setPath(styles[index], propertyPath, value);
  }
  return styles;
}

export function getMonsterSectionChoices(combatStyles = []) {
  const rows = readMonsterCombatStyles(combatStyles);
  const usedIds = new Set();
  return rows.map((row, index) => {
    const name = String(row?.section || row?.sectionLabel || row?.style || `Section ${index + 1}`).trim();
    const id = row.id || `cs-${index + 1}`;
    let finalId = id;
    let suffix = 2;
    while (usedIds.has(finalId)) finalId = `${id}-${suffix++}`;
    usedIds.add(finalId);
    return {
      id: finalId,
      name: name || `Section ${index + 1}`,
      label: name || `Section ${index + 1}`
    };
  });
}

export function createMonsterUniqueSkill(assignment, sectionChoices = [], skill = {}) {
  if (sectionChoices.length <= 1) {
    const { combatStyleId: _combatStyleId, ...withoutCombatStyleId } = skill;
    return { ...withoutCombatStyleId, sectionScope: "all" };
  }
  if (assignment === "all") {
    const { combatStyleId: _combatStyleId, ...withoutCombatStyleId } = skill;
    return { ...withoutCombatStyleId, sectionScope: "all" };
  }
  const choice = sectionChoices.find(c => c.id === assignment);
  if (!choice) return null;
  return { ...skill, sectionScope: "section", combatStyleId: choice.id };
}

export function prepareMonsterUniqueSkillGroups(skills = [], sectionChoices = []) {
  const rows = Array.isArray(skills) ? skills : [];
  const isMultiSection = sectionChoices.length > 1;
  const groups = sectionChoices.map(section => ({
    id: section.id,
    title: section.name,
    showHeading: isMultiSection,
    skills: []
  }));
  const allSections = { id: "all", title: "All Sections", showHeading: isMultiSection, skills: [] };
  const validIds = new Set(sectionChoices.map(section => section.id));

  rows.forEach((skill, index) => {
    const assignedCombatStyleId = !isMultiSection
      ? null
      : skill?.sectionScope === "section" && validIds.has(skill.combatStyleId)
        ? skill.combatStyleId
        : null;
    const group = assignedCombatStyleId
      ? groups.find(section => section.id === assignedCombatStyleId)
      : allSections;
    const needsReview = skill?.sectionScope === "section" && !validIds.has(skill.combatStyleId);
    const assignmentChoices = isMultiSection
      ? [{ value: "all", label: "All Sections" }, ...sectionChoices.map(section => ({
        value: section.id,
        label: section.name
      }))].map(choice => ({
        ...choice,
        selected: !needsReview && choice.value === (assignedCombatStyleId || "all")
      }))
      : [];
    group.skills.push({
      ...skill,
      index,
      sectionAssignment: skill?.sectionScope === "section" && !validIds.has(skill.combatStyleId)
        ? ""
        : assignedCombatStyleId || "all",
      sectionAssignmentLabel: needsReview ? "Reassign section" : group.title,
      sectionAssignmentChoices: assignmentChoices,
      sectionAssignmentNeedsReview: needsReview
    });
  });

  return [...(allSections.skills.length ? [allSections] : []), ...groups.filter(group => group.skills.length)];
}

export function mergeMonsterUniqueSkillFields(currentSkills = [], fields = [], sectionChoices = []) {
  const skills = (Array.isArray(currentSkills) ? currentSkills : []).map(skill => ({ ...skill }));
  for (const [path, value] of fields) {
    const match = path.match(/^(\d+)\.(.+)$/);
    if (!match) continue;
    const index = Number(match[1]);
    const propertyPath = match[2];
    if (!skills[index]) continue;
    if (propertyPath === "assignment") {
      const assigned = createMonsterUniqueSkill(value, sectionChoices, skills[index]);
      if (!assigned) throw new Error(`Unique Skill ${index + 1} must be assigned to an existing section or All Sections.`);
      skills[index] = assigned;
      continue;
    }
    setPath(skills[index], propertyPath, value);
  }
  return skills;
}
