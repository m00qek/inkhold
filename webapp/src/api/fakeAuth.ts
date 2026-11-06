// Who is signed in, for the dev server on test data (`?fake`): the test
// household's "ana", an admin, so every screen can be seen without a backend.
// The real app asks the server (`api.me()`); e2e answers that call with a
// mock instead (`tests/e2e/helpers/mockApi.ts`), so this is the dev's only.

import type { Me } from "./client";

export interface AuthApi {
  me(): Promise<Me>;
  logout(): Promise<void>;
}

export function createFakeAuth(): AuthApi {
  return {
    me: async () => ({ email: "ana@household.lan", isAdmin: true, mustChangePassword: false }),
    logout: async () => {},
  };
}
