// An open IndexedDB connection that gives way. A database can't be deleted
// while a connection to it is open: the delete waits, and these connections
// live as long as the page. So every store closes its connection when it is
// asked to (`versionchange`, sent by a delete or by a newer version opening it,
// in this tab or another), and its later calls fail into its own fallback
// (each store never throws). Sign-out (`forget.ts`) relies on this.

/** Close `db` when another connection deletes or upgrades its database. */
export function yieldOnVersionChange(db: IDBDatabase): IDBDatabase {
  db.onversionchange = () => db.close();
  return db;
}
