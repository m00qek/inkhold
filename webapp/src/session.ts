// In-memory auth hint for the current page life. The real session lives in the
// HttpOnly `sn_session` cookie, which JS cannot read — this flag just lets the
// shell trust a login that happened this session without re-probing the server
// (which would otherwise bounce right after a successful login). On a fresh page
// load the flag starts false and the shell verifies with `api.me()`.

let authed = false;

export const session = {
  get authed(): boolean {
    return authed;
  },
  markSignedIn(): void {
    authed = true;
  },
  clear(): void {
    authed = false;
  },
};
