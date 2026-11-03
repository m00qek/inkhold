/*
 * Null SQLite VFS for the WebAssembly `.spd` decoder. `SQLITE_OS_OTHER=1`
 * removes the built-in OS layer, but `sqlite3_initialize` still needs a
 * default VFS. The read path only deserializes into `:memory:`, so every file
 * method is an unreachable stub and randomness/time are fixed.
 */
#include "sqlite3.h"
#include <string.h>

static int nullOpen(sqlite3_vfs *v, sqlite3_filename n, sqlite3_file *f, int fl, int *out) {
    (void)v; (void)n; (void)f; (void)fl;
    if (out) *out = 0;
    return SQLITE_IOERR; /* unreachable: :memory: never opens a file */
}
static int nullDelete(sqlite3_vfs *v, const char *n, int s) {
    (void)v; (void)n; (void)s;
    return SQLITE_IOERR;
}
static int nullAccess(sqlite3_vfs *v, const char *n, int f, int *r) {
    (void)v; (void)n; (void)f;
    if (r) *r = 0; /* nothing exists on this filesystem */
    return SQLITE_OK;
}
static int nullFullPathname(sqlite3_vfs *v, const char *n, int sz, char *out) {
    (void)v;
    size_t l = strlen(n);
    if ((int)l >= sz) l = (size_t)sz - 1;
    memcpy(out, n, l);
    out[l] = 0;
    return SQLITE_OK;
}
/* A fixed seed: reading a memory image needs no entropy. */
static int nullRandomness(sqlite3_vfs *v, int n, char *out) {
    (void)v;
    memset(out, 0, (size_t)n);
    return n;
}
static int nullSleep(sqlite3_vfs *v, int micro) {
    (void)v; (void)micro;
    return 0;
}
static int nullCurrentTime(sqlite3_vfs *v, double *t) {
    (void)v;
    *t = 2440587.5;
    return SQLITE_OK;
}
static int nullCurrentTimeInt64(sqlite3_vfs *v, sqlite3_int64 *t) {
    (void)v;
    *t = (sqlite3_int64)(2440587.5 * 86400000.0);
    return SQLITE_OK;
}
static int nullGetLastError(sqlite3_vfs *v, int n, char *b) {
    (void)v; (void)n; (void)b;
    return 0;
}

static sqlite3_vfs g_null_vfs = {
    .iVersion = 2,
    .szOsFile = 0,
    .mxPathname = 512,
    .pNext = 0,
    .zName = "wasm-null",
    .pAppData = 0,
    .xOpen = nullOpen,
    .xDelete = nullDelete,
    .xAccess = nullAccess,
    .xFullPathname = nullFullPathname,
    .xDlOpen = 0,
    .xDlError = 0,
    .xDlSym = 0,
    .xDlClose = 0,
    .xRandomness = nullRandomness,
    .xSleep = nullSleep,
    .xCurrentTime = nullCurrentTime,
    .xGetLastError = nullGetLastError,
    .xCurrentTimeInt64 = nullCurrentTimeInt64,
};

int sqlite3_os_init(void) {
    return sqlite3_vfs_register(&g_null_vfs, 1 /* make default */);
}
int sqlite3_os_end(void) {
    return SQLITE_OK;
}
