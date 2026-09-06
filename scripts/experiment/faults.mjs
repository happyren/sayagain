// The seeded draws the harness, the fault server and the chaos shim share, so the same seed gives
// the same fault to the same call whichever of them is asked.

/** mulberry32 over a string seed: small, fast, and the same everywhere. */
export const rng = (seedText) => {
  let a = 0;
  for (let i = 0; i < seedText.length; i++) a = (Math.imul(a, 31) + seedText.charCodeAt(i)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** One class from a mix of shares that sum to one. */
export const drawClass = (rnd, mix) => {
  let u = rnd();
  for (const [cls, share] of Object.entries(mix)) {
    if (u < share) return cls;
    u -= share;
  }
  return "other";
};

/** The classes a server injects from its side; the others are the caller's own mistakes. */
export const SERVER_SIDE = new Set(["other", "blocked", "retryable"]);

/**
 * The fault for a call that arrived without one: the boundary's own reads and its re-sends of
 * repaired calls. Drawn from the same mix at the same rate as the agent's calls, on the seed, the
 * call and its attempt, so a boundary that reads before it decides meets the same server the agent
 * does. A caller-side class cannot be injected into a call the caller made correctly, so those
 * draws are no fault: a well-formed read fails less often than the agent's, and that is true.
 */
export function faultFor(settings, key, attempt) {
  if (!settings) return "none";
  const rnd = rng(`${settings.seed}:own:${key}:${attempt}`);
  if (rnd() >= settings.rate) return "none";
  const cls = drawClass(rnd, settings.mix);
  return SERVER_SIDE.has(cls) ? cls : "none";
}

/** The settings the harness hands a server through its environment, or nothing outside a run. */
export const settingsFromEnv = (env) =>
  env.FAULT_MIX
    ? {
        seed: env.FAULT_SEED ?? "",
        rate: Number(env.FAULT_RATE ?? 0),
        mix: JSON.parse(env.FAULT_MIX),
      }
    : undefined;
