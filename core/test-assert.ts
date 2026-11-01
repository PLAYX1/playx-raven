/** Small portable assertions for fixtures; no Node dependency in the core build. */
const check = (value: unknown, message = 'Assertion failed'): void => { if (!value) throw new Error(message); };
export const assert = Object.assign(check, {
  equal: (a: unknown, b: unknown, message?: string) => check(Object.is(a, b), message),
  deepEqual: (a: unknown, b: unknown, message?: string) => check(JSON.stringify(a) === JSON.stringify(b), message),
  throws: (fn: () => unknown, message?: string) => { let threw = false; try { fn(); } catch { threw = true; } check(threw, message ?? 'Expected rejection'); },
  rejects: async (fn: () => Promise<unknown>, message?: string) => { let threw = false; try { await fn(); } catch { threw = true; } check(threw, message ?? 'Expected async rejection'); },
});
