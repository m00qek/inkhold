// The live-freshness seam: pushes the user's `syncVersion` when a device
// upload changes their files. SSE, since traffic is one-way server to client.

/**
 * The `event: index` frame. `pending` is transient derive work and is never
 * added to the permanent "no recognised text" count.
 */
export interface IndexStatus {
  /** Never negative. */
  pending: number;
  /** Moves when a derive completes; restart-relative. */
  version: number;
}

export interface LiveChannel {
  /**
   * Returns an unsubscribe that closes the connection. `onIndex` rides the same
   * connection: a held stream takes one of four per-user server slots.
   */
  subscribe(onBump: (syncVersion: number) => void, onIndex?: (status: IndexStatus) => void): () => void;
}
