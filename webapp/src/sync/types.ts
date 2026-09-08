// The live-freshness seam (layer L1). A `LiveChannel` pushes the user's current
// `syncVersion` whenever a device upload changes their files, so the gallery and
// reader refresh the moment a note syncs from the Nomad — no manual reload. The
// real implementation wraps `EventSource` (SSE) over GET /api/controlplane/events; a fake
// lets tests drive bumps deterministically.
//
// SSE (not WebSocket) because the traffic is one-directional server→client: it's
// simpler, auto-reconnects, and works over plain HTTP — the web analogue of the
// device's Socket.IO channel.

/**
 * The server's `event: index` frame: how much of your library is still being
 * derived, and a version that moves when a derive lands.
 *
 * Both numbers describe the INDEX, not the files: `pending` is transient and
 * resolves without anyone doing anything, which is what makes it a different
 * claim from `Coverage.unsearchable` and why the two are never added together.
 */
export interface IndexStatus {
  /** Documents of yours whose derive has not finished. Never negative. */
  pending: number;
  /** Moves when a derive completes. Restart-relative; not a total of anything. */
  version: number;
}

export interface LiveChannel {
  /**
   * Subscribe to sync-version bumps. `onBump` fires with the new version each
   * time the server signals a change. Returns an unsubscribe function that
   * closes the underlying connection.
   *
   * `onIndex` rides the SAME connection rather than opening a second one, and
   * that is not an optimization: a held stream costs the caller one of four
   * per-user slots on the server, so a second subscription would halve how many
   * tabs can stay live to deliver a fact the first stream is already carrying.
   * Optional because most callers do not want it — the reader and the connect
   * page care only about freshness.
   */
  subscribe(onBump: (syncVersion: number) => void, onIndex?: (status: IndexStatus) => void): () => void;
}
