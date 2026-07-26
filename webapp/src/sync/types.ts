// The live-freshness seam (layer L1). A `LiveChannel` pushes the user's current
// `syncVersion` whenever a device upload changes their files, so the gallery and
// reader refresh the moment a note syncs from the Nomad — no manual reload. The
// real implementation wraps `EventSource` (SSE) over GET /api/controlplane/events; a fake
// lets tests drive bumps deterministically.
//
// SSE (not WebSocket) because the traffic is one-directional server→client: it's
// simpler, auto-reconnects, and works over plain HTTP — the web analogue of the
// device's Socket.IO channel.

export interface LiveChannel {
  /**
   * Subscribe to sync-version bumps. `onBump` fires with the new version each
   * time the server signals a change. Returns an unsubscribe function that
   * closes the underlying connection.
   */
  subscribe(onBump: (syncVersion: number) => void): () => void;
}
