import assert from "node:assert/strict";
import { resolveCriticalDamageChain } from "../module/rules/critical-damage.mjs";

const run = async outcomes => {
  let index = 0;
  return resolveCriticalDamageChain({
    rollDamage:async () => outcomes[index++],
    resolveRoll:roll => roll
  });
};

const noCritical = await run([{ tableValue:8, critical:false }]);
assert.equal(noCritical.accumulated, 8);
assert.equal(noCritical.rolls.length, 1, "noncritical damage ends the chain");

const oneCritical = await run([
  { tableValue:8, critical:true },
  { tableValue:5, critical:false }
]);
assert.equal(oneCritical.accumulated, 13);
assert.equal(oneCritical.rolls.length, 2, "one critical automatically rolls one continuation");

const repeatedCritical = await run([
  { tableValue:8, critical:true },
  { tableValue:5, critical:true },
  { tableValue:3, critical:false }
]);
assert.equal(repeatedCritical.accumulated, 16);
assert.equal(repeatedCritical.rolls.length, 3, "critical continuations repeat until noncritical");

const failure = await run([
  { tableValue:8, critical:true },
  { automaticFailure:true, diceTotal:2 }
]);
assert.equal(failure.automaticFailure, true);
assert.equal(failure.total, 0);
assert.equal(failure.accumulated, 0, "automatic failure discards the chain's damage");
assert.equal(failure.rolls.length, 2, "automatic failure terminates without another continuation");

console.log("Critical damage chain tests passed.");
