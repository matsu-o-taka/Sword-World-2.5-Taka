import fs from 'node:fs';
const p = 'D:/Foundry Assets/sw25-library/packs/monsters-animals/000163.ldb';
try {
  const buf = fs.readFileSync(p);
  console.log('File size:', buf.length, 'bytes');
  // Show first 256 bytes as hex
  for (let i = 0; i < Math.min(256, buf.length); i += 16) {
    const hex = [];
    const ascii = [];
    for (let j = 0; j < 16 && i + j < buf.length; j++) {
      hex.push(buf[i + j].toString(16).padStart(2, '0'));
      const b = buf[i + j];
      ascii.push(b >= 32 && b < 127 ? String.fromCharCode(b) : '.');
    }
    console.log(i.toString(16).padStart(4, '0') + ': ' + hex.join(' ') + '  ' + ascii.join(''));
  }
} catch(e) {
  console.log('Error:', e.message);
}
