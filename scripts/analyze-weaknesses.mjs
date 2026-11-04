import fs from 'node:fs';

const filePath = 'D:/Foundry Assets/sword-world-25/docs/sw25-monster-weakness-extraction.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const monsters = data.monsters;

console.log('=== ANÁLISIS EXHAUSTIVO DE DEBILIDADES ===\n');

// 1. Todos los valores únicos de weakPoint
const wpValues = {};
for (const m of monsters) {
  const wp = m.weakPoint;
  if (!wpValues[wp]) {
    wpValues[wp] = { count: 0, monsters: [] };
  }
  wpValues[wp].count++;
  wpValues[wp].monsters.push({ name: m.name, id: m.id, pack: m.pack, sourceUrl: m.sourceUrl, reputation: m.reputation, weakness: m.weakness });
}

console.log(`Total valores únicos de weakPoint: ${Object.keys(wpValues).length}\n`);

// Sort by count descending
const sortedWPs = Object.entries(wpValues).sort((a, b) => b[1].count - a[1].count);

for (const [wp, info] of sortedWPs) {
  console.log(`\n"${wp}" (${info.count} monstruos)`);
  for (const m of info.monsters) {
    console.log(`  - ${m.name} (${m.id}, ${m.pack}, Rep:${m.reputation}, Weak:${m.weakness})`);
  }
}

// 2. Los 49 registros con weakness=0
console.log('\n=== REGISTROS CON weakness=0 ===');
const zeroWeakness = monsters.filter(m => m.weakness === 0);
console.log(`Total: ${zeroWeakness.length}\n`);
for (const m of zeroWeakness) {
  console.log(`  ${m.name} (${m.id}, ${m.pack}, Rep:${m.reputation}, Weak:${m.weakness}, WP:${m.weakPoint || 'null'}, URL:${m.sourceUrl}`);
}
