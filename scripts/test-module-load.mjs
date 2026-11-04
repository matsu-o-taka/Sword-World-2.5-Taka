import("./module/combat/monster-knowledge.mjs")
  .then(() => { require('fs').appendFileSync('/tmp/result.txt', 'Module loaded OK\n'); })
  .catch(e => { require('fs').appendFileSync('/tmp/result.txt', 'Error: ' + e.message + '\n'); });