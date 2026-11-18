/**
 * Resolve a Power Table critical chain. Each roll contributes only its table
 * result; callers apply their attack-type-specific modifier once afterward.
 */
export async function resolveCriticalDamageChain({ rollDamage, resolveRoll }) {
  const rolls = [];
  let accumulated = 0;
  while (true) {
    const roll = await rollDamage();
    const resolved = resolveRoll(roll);
    rolls.push({ ...resolved, roll });
    if (resolved.automaticFailure) {
      return { automaticFailure:true, rolls, accumulated:0, total:0 };
    }
    accumulated += Number(resolved.tableValue ?? 0);
    if (!resolved.critical) return { automaticFailure:false, rolls, accumulated };
  }
}
