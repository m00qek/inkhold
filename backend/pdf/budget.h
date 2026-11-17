/* A memory ceiling for one MuPDF context: the server's bound on what reading a
 * document may take, whatever the file says about itself. The pool behind it
 * is `pool.zig`; the hooks are `budget.c`. */

#ifndef INK_BUDGET_H
#define INK_BUDGET_H

#include <stddef.h>
#include <mupdf/fitz.h>

/* What one MuPDF context may have mapped at once, its cache included. The
 * whole server's budget is about 50 MB of anonymous memory
 * (`system-shape.md`); this leaves the rest for the idle process, the search
 * writers and the database. */
#define INK_MUPDF_BUDGET ((size_t)32 * 1024 * 1024)

/* What the last allocation request came to. MuPDF retries a refused request
 * after evicting its cache, so only a request that nothing has followed
 * successfully can be the reason it failed. */
enum ink_budget_last {
    INK_BUDGET_MET = 0,
    /* Refused at the ceiling: the file needs more than this server gives it. */
    INK_BUDGET_REFUSED,
    /* Under the ceiling, but the system had no memory: ours, and transient. */
    INK_BUDGET_SYSTEM,
};

/* Mirrors `pool.Budget` in `pool.zig`. */
struct ink_budget {
    /* Bytes the pool has mapped from the system: what the ceiling bounds. */
    size_t used;
    size_t peak;
    size_t cap;
    /* Bytes in blocks MuPDF holds; after `ink_budget_close`, what it leaked. */
    size_t live;
    /* Requests refused at the ceiling, recovered from or not. MuPDF recovers
     * from some by degrading instead (a page image it cannot load becomes an
     * empty page), which only this count shows. */
    unsigned refusals;
    int last; /* enum ink_budget_last */
    /* Requests the system had no memory for, whatever came after them. */
    unsigned system_failures;
    /* Refusals MuPDF's retry did not get past: it gave up on that request
     * and went on without it, or threw. `ink_budget_lost`. */
    unsigned unrecovered;
    /* The size of the last refused request, until a request is met: met at
     * that size, it was MuPDF's retry, and recovered. */
    size_t pending;
    void *pool;
};

/* A pool for one context, and `alloc` routing the context's every allocation
 * to it. Both must outlive the context. 0, or -1 when there is no memory for
 * the pool itself. */
int ink_budget_init(struct ink_budget *b, size_t cap, fz_alloc_context *alloc);

/* Once the context is dropped: gives every page the pool mapped back to the
 * system, whatever MuPDF still held in them. `live` keeps what it held. */
void ink_budget_close(struct ink_budget *b);

/* The result for an error MuPDF threw (`code`, from `fz_caught`) under `b`:
 * the ceiling's verdict (-6, too large) when the request that failed was
 * refused at it, or one that MuPDF's own retry made after a refusal failed the
 * same way; ours (-1, transient) when the system had no memory; otherwise the
 * file's (-2, unopenable). An early refusal MuPDF recovered from does not turn
 * a later, unrelated error (encryption, a syntax error) into the first. */
int ink_budget_failure(const struct ink_budget *b, int code);

/* Refusals MuPDF did not recover from so far, one still pending included.
 * Unlike `refusals`, a request refused and then met on MuPDF's retry, once
 * its cache was evicted, is not among them: nothing was lost to it. */
unsigned ink_budget_lost(const struct ink_budget *b);

/* Counts a still pending refusal as given up on: where no retry can follow. */
void ink_budget_settle(struct ink_budget *b);

/* For the tests and the build: the ceiling in bytes. */
size_t ink_mupdf_budget(void);

#endif
