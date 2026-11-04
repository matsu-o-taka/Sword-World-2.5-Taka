import fs from 'node:fs';

const packDir = 'D:/Foundry Assets/sw25-library/packs/monsters-animals';
const files = fs.readdirSync(packDir).filter(f => f.endsWith('.ldb'));

console.log(`Found ${files.length} .ldb files in monsters-animals`);

let totalDocs = 0;
let parsedDocs = 0;

for (const file of files) {
  const filePath = `${packDir}/${file}`;
  const buf = fs.readFileSync(filePath);
  const text = buf.toString('latin1'); // Read as latin1 to preserve all bytes
  
  // Find JSON objects - look for {"key" pattern
  const jsonPattern = /\{[^{}]*"key"[^{}]*\}/g;
  let match;
  
  while ((match = jsonPattern.exec(text)) !== null) {
    totalDocs++;
    try {
      const doc = JSON.parse(match[0]);
      if (doc.id && doc.system) {
        parsedDocs++;
        const wp = doc.system.weakPoint || null;
        const rep = doc.system.reputation || null;
        const weakness = doc.system.weakness || null;
        console.log(`  ${doc.name} (${doc.id}) - Rep:${rep} Weak:${weakness} WP:${wp}`);
      }
    } catch(e) {
      // Not valid JSON, skip
    }
  }
}

console.log(`\nTotal JSON objects found: ${totalDocs}`);
console.log(`Successfully parsed: ${parsedDocs}`);
