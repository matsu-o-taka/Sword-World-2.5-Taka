const fs = require('fs');
const p = 'D:/Foundry Assets/sw25-library/packs/monsters-animals/000163.ldb';
try {
  const buf = fs.readFileSync(p);
  console.log('File size:', buf.length, 'bytes');
  // Look for printable ASCII sequences
  let printable = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 32 && b < 127) {
      printable += String.fromCharCode(b);
    } else {
      if (printable.length > 3) {
        console.log('Printable seq:', printable);
      }
      printable = '';
    }
  }
  if (printable.length > 3) {
    console.log('Printable seq:', printable);
  }
} catch(e) {
  console.log('Error:', e.message);
}
