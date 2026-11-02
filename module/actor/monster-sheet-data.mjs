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

const normalizeSectionName = value => String(value ?? "").replace(/\s+x\s*.+$/i, "").trim();
const sectionIdForName = name => `section-${encodeURIComponent(normalizeSectionName(name).toLowerCase())}`;

export function getMonsterSectionChoices(sections = [], combatStyles = []) {
  const sourceSections = Array.isArray(sections) && sections.length
    ? sections
    : readMonsterCombatStyles(combatStyles)
      .map(style => normalizeSectionName(style.section || style.sectionLabel))
      .filter(Boolean)
      .filter((name, index, names) => names.findIndex(candidate => candidate.toLowerCase() === name.toLowerCase()) === index)
      .map(name => ({ name, id: sectionIdForName(name) }));
  const usedIds = new Set();
  return sourceSections.map((section, index) => {
    const name = String(section?.name ?? "").trim();
    const baseId = String(section?.id || (name ? sectionIdForName(name) : `section-${index + 1}`));
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    usedIds.add(id);
    return {
      id,
      name: name || `Section ${index + 1}`,
      label: name || `Section ${index + 1}`
    };
  });
}

export function createMonsterUniqueSkill(assignment, sectionChoices = [], skill = {}) {
  if (sectionChoices.length <= 1) {
    const { sectionId: _sectionId, ...withoutSectionId } = skill;
    return { ...withoutSectionId, sectionScope: "all" };
  }
  if (assignment === "all") {
    const { sectionId: _sectionId, ...withoutSectionId } = skill;
    return { ...withoutSectionId, sectionScope: "all" };
  }
  const section = sectionChoices.find(choice => choice.id === assignment);
  if (!section) return null;
  return { ...skill, sectionScope: "section", sectionId: section.id };
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
    const assignedSectionId = !isMultiSection
      ? null
      : skill?.sectionScope === "section" && validIds.has(skill.sectionId)
        ? skill.sectionId
        : null;
    const group = assignedSectionId
      ? groups.find(section => section.id === assignedSectionId)
      : allSections;
    const needsReview = skill?.sectionScope === "section" && !validIds.has(skill.sectionId);
    const assignmentChoices = isMultiSection
      ? [{ value: "all", label: "All Sections" }, ...sectionChoices.map(section => ({
        value: section.id,
        label: section.name
      }))].map(choice => ({
        ...choice,
        selected: !needsReview && choice.value === (assignedSectionId || "all")
      }))
      : [];
    group.skills.push({
      ...skill,
      index,
      sectionAssignment: skill?.sectionScope === "section" && !validIds.has(skill.sectionId)
        ? ""
        : assignedSectionId || "all",
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
