// The one door the e2e tests read runtime counters through: a named property
// on `globalThis`, set by the module that owns the number. Keeping the cast
// here means no other file writes to `window` by hand.

export function exposeForTests<T>(name: `__inkhold${string}`, value: T): void {
  (globalThis as unknown as Record<string, T>)[name] = value;
}
