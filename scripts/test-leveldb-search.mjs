import fs from 'node:fs';

const filePath = 'D:/Foundry Assets/sw25-library/packs/monsters-animals/000163.ldb';
const buf = fs.readFileSync(filePath);

// Search for "Centipede" in raw bytes
let found = false;
for (let i = 0; i < buf.length - 8; i++) {
  if (buf[i] === 0x43 && buf[i+1] === 0x65 && buf[i+2] === 0x6e && 
      buf[i+3] === 0x74 && buf[i+4] === 0x69 && buf[i+5] === 0x70 &&
      buf[i+6] === 0x65 && buf[i+7] === 0x64 && buf[i+8] === 0x65) {
    console.log('Found "Centipede" at byte', i);
    // Show surrounding context
    const start = Math.max(0, i - 50);
    const end = Math.min(buf.length, i + 100);
    const context = buf.slice(start, end).toString('latin1');
    console.log('Context:', context);
    found = true;
    break;
  }
}
if (!found) {
  console.log('"Centipede" not found in raw bytes');
  // Check if file has readable text at all
  let printableCount = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] >= 32 && buf[i] < 127) printableCount++;
  }
  console.log('Printable chars:', printableCount, 'of', buf.length);
}
