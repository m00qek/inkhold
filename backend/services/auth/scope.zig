//! Who is calling: the route scope / caller audience, and the resolved caller.
//! An auth concept, so it lives here; `http/context.zig` re-exports both for
//! the handlers.

/// Route scope / caller audience. Device (`x-access-token`) and control-plane
/// (session cookie) authority are not interchangeable; `public` is a route
/// scope only; `pending` is the first-login token, accepted only by routes
/// that list it.
pub const Scope = enum { public, device, controlplane, pending };

pub const Caller = struct {
    user_id: u64,
    audience: Scope,
    is_admin: bool = false,
    /// The session's admin elevation (password re-entered recently), resolved
    /// per request so it lapses by itself. `require_admin` needs this and
    /// `is_admin`: an unlocked tablet still carries `is_admin`.
    elevated: bool = false,
    /// Device serial, copied inline because `json.readBody` invalidates head
    /// strings; read via `equipmentNo()`. `equipment_len == 0` means none.
    equipment_buf: [max_equipment_len]u8 = undefined,
    equipment_len: usize = 0,

    pub const max_equipment_len = 64;

    pub fn equipmentNo(self: *const Caller) ?[]const u8 {
        return if (self.equipment_len == 0) null else self.equipment_buf[0..self.equipment_len];
    }
};
