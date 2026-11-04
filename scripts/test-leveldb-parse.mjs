import fs from 'node:fs';

const filePath = 'D:/Foundry Assets/sw25-library/packs/monsters-animals/000163.ldb';
const buf = fs.readFileSync(filePath);

// Strategy: Extract all printable sequences that look like JSON key-value pairs
// LevelDB stores data with binary length-prefixes between fields.
// We can try to reconstruct JSON by finding "key":"value" patterns.

const text = buf.toString('latin1');

// Look for patterns like "key":"value" where key is a known monster field
const fields = ['name', 'type', 'reputation', 'weakness', 'weakPoint', 'sourceUrl', 'level', 'system'];
const results = [];

for (const field of fields) {
  const pattern = new RegExp(`"${field}":"([^"]*)"`, 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    results.push({
      field: field,
      value: match[1],
      position: match.index
    });
  }
}

console.log(`Found ${results.length} field-value pairs:`);
for (const r of results) {
  console.log(`  ${r.field}: "${r.value}" (at byte ${r.position})`);
}

// Also try to find complete "name":"..." followed by "weakPoint":"..." patterns
console.log('\n--- Attempting to reconstruct monster documents ---');

// Find all "name":"..." positions
const nameMatches = [];
const namePattern = /"name":"([^"]+)"/g;
let nm;
while ((nm = namePattern.exec(text)) !== null) {
  nameMatches.push({ name: nm[1], pos: nm.index });
}

console.log(`\nFound ${nameMatches.length} name fields:`);
for (const nm of nameMatches) {
  console.log(`  "${nm.name}" at byte ${nm.pos}`);
  // Look for weakPoint within 500 bytes after this name
  const window = text.substring(nm.pos, Math.min(text.length, nm.pos + 1000));
  const wpMatch = window.match(/"weakPoint":"([^"]*)"/);
  const repMatch = window.match(/"reputation":(\d+)/);
  const weaknessMatch = window.match(/"weakness":(\d+)/);
  if (wpMatch) {
    console.log(`    weakPoint: "${wpMatch[1]}"`);
  }
  if (repMatch) {
    console.log(`    reputation: ${repMatch[1]}`);
  }
  if (weaknessMatch) {
    console.log(`    weakness: ${weaknessMatch[1]}`);
  }
}
