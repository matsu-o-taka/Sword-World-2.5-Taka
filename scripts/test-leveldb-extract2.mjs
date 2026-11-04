import fs from 'node:fs';

const packDir = 'D:/Foundry Assets/sw25-library/packs/monsters-animals';
const files = fs.readdirSync(packDir).filter(f => f.endsWith('.ldb'));

console.log(`Found ${files.length} .ldb files in monsters-animals`);

for (const file of files) {
  const filePath = `${packDir}/${file}`;
  const buf = fs.readFileSync(filePath);
  const text = buf.toString('latin1');
  
  // Search for "name":" pattern
  const namePattern = /"name":"([^"]+)"/g;
  let match;
  let count = 0;
  
  while ((match = namePattern.exec(text)) !== null) {
    count++;
    const name = match[1];
    // Try to find weakPoint near this name
    const start = match.index;
    const end = Math.min(text.length, start + 2000);
    const window = text.substring(start, end);
    const wpMatch = window.match(/"weakPoint":"([^"]*)"/);
    const repMatch = window.match(/"reputation":(\d+)/);
    const weaknessMatch = window.match(/"weakness":(\d+)/);
    const idMatch = window.match(/"id":"([^"]+)"/);
    const typeMatch = window.match(/"type":"([^"]+)"/);
    
    console.log(`  Name: ${name}`);
    console.log(`    ID: ${idMatch ? idMatch[1] : 'N/A'}`);
    console.log(`    Type: ${typeMatch ? typeMatch[1] : 'N/A'}`);
    console.log(`    Reputation: ${repMatch ? repMatch[1] : 'N/A'}`);
    console.log(`    Weakness: ${weaknessMatch ? weaknessMatch[1] : 'N/A'}`);
    console.log(`    WeakPoint: ${wpMatch ? wpMatch[1] : 'N/A'}`);
    console.log('');
  }
  
  console.log(`File ${file}: ${count} names found`);
}
