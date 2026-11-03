// In-memory auth hint for this page life. The real session is the HttpOnly
// `sn_session` cookie; this avoids re-probing (and bouncing) right after login.

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
