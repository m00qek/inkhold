// One change to the server, said the same way in every app: the call, and on
// failure the words for it, unless the shell already handled it (a session
// that ended). What surrounds it (busy marks, a fresh read) is the caller's.

export interface AttemptDeps {
  /** True when the shell took care of the failure (session expiry and the like). */
  handled(e: unknown): boolean;
  say(message: string): void;
  /** Words of its own for a failure the server explains (a name taken); null: the general ones. */
  explain?(e: unknown): string | null;
}

/** True when `op` went through; on failure the person is told, and nothing else happens. */
export async function attempt(what: string, op: () => Promise<unknown>, d: AttemptDeps): Promise<boolean> {
  try {
    await op();
    return true;
  } catch (e) {
    if (!d.handled(e)) d.say(d.explain?.(e) ?? `Couldn't ${what}. Check your connection and try again.`);
    return false;
  }
}
