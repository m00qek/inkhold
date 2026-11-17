/* The server's memory bound on MuPDF. Every allocation MuPDF makes, its
 * third-party libraries' included (zlib, libjpeg, openjpeg, FreeType,
 * HarfBuzz, jbig2dec, lcms2 all allocate through the context), comes through
 * here into the context's own pool (`pool.zig`), which counts the pages it
 * maps. A request past the ceiling is refused: MuPDF then evicts its cache and
 * retries (`do_scavenging_malloc`), and throws only if it still cannot have
 * it. So a document that needs more than the ceiling, by any route (a zip
 * entry read whole, a decompression bomb, a huge image or font, a page of a
 * hundred thousand small objects), ends as an error the caller records, never
 * as the Pi's memory; and once the context is dropped, the pool gives all of
 * it back.
 *
 * Why here and not in a check before opening: such a check is a second parser
 * of the same file, and every place it reads the file differently from MuPDF
 * (tar flavours, a zip's end records, letter case) is a way past it. */

#include <stdlib.h>
#include <string.h>
#include "budget.h"

int ink_pool_open(struct ink_budget *b, size_t cap);
void *ink_pool_alloc(struct ink_budget *b, size_t size);
void *ink_pool_realloc(struct ink_budget *b, void *ptr, size_t size);
void ink_pool_free(struct ink_budget *b, void *ptr);
void ink_pool_close(struct ink_budget *b);

/* What a request came to, for `ink_budget_lost` and `ink_budget_failure`.
 * MuPDF retries a refused request at the same size after each eviction
 * (`do_scavenging_malloc`); any other request after a refusal means it went
 * on without it. */
static void *noted(struct ink_budget *b, void *p, size_t size)
{
    if (p) {
        if (b->pending && b->pending != size) b->unrecovered++;
        b->pending = 0;
    } else if (b->last == INK_BUDGET_REFUSED) {
        if (b->pending && b->pending != size) b->unrecovered++;
        b->pending = size ? size : 1;
    } else if (b->last == INK_BUDGET_SYSTEM) {
        b->system_failures++;
    }
    return p;
}

static void *budget_malloc(void *user, size_t size)
{
    return noted(user, ink_pool_alloc(user, size), size);
}

static void *budget_realloc(void *user, void *ptr, size_t size)
{
    void *p = ink_pool_realloc(user, ptr, size);
    /* A realloc to 0 is a free, never a request. */
    return size ? noted(user, p, size) : p;
}

static void budget_free(void *user, void *ptr)
{
    ink_pool_free(user, ptr);
}

/* HarfBuzz, which MuPDF calls to shape text, keeps a few hundred bytes in statics for
 * the life of the process (MuPDF's `fitz/harfbuzz.c` says as much), so they
 * cannot come from a pool that is unmapped when its document closes. Its
 * blocks come from `malloc`, each counted against the document open when it
 * was had: refused past the ceiling like any other, uncounted again when
 * freed while that document is still open. One a closed document left behind
 * (those statics) is simply not counted any more. One document at a time:
 * the server's one MuPDF thread (`build_mupdf.zig`, openjpeg). */
static struct ink_budget *hb_budget;
static unsigned long hb_generation;
/* For the tests: HarfBuzz blocks alive (what a run of documents leaves), and
 * ever had (whether a document reached HarfBuzz at all). */
static long hb_blocks;
static unsigned long hb_allocs;

long ink_hb_blocks(void);
long ink_hb_blocks(void)
{
    return hb_blocks;
}

unsigned long ink_hb_allocs(void);
unsigned long ink_hb_allocs(void)
{
    return hb_allocs;
}

/* In front of each HarfBuzz block; 16 bytes, so the block keeps `malloc`'s
 * alignment. */
struct hb_head {
    unsigned long generation;
    size_t size;
};
#define HB_HEAD ((size_t)16)
_Static_assert(sizeof(struct hb_head) <= HB_HEAD, "hb_head fits its slot");

void *ink_hb_malloc(size_t size);
void *ink_hb_calloc(size_t n, size_t size);
void *ink_hb_realloc(void *ptr, size_t size);
void ink_hb_free(void *ptr);

void *ink_hb_malloc(size_t size)
{
    struct ink_budget *b = hb_budget;
    if (size > (size_t)-1 - HB_HEAD) return NULL;
    const size_t total = size + HB_HEAD;
    if (b && total > b->cap - b->used) {
        b->refusals++;
        b->last = INK_BUDGET_REFUSED;
        return noted(b, NULL, size);
    }
    unsigned char *raw = malloc(total);
    if (!raw) {
        if (b) b->last = INK_BUDGET_SYSTEM;
        return b ? noted(b, NULL, size) : NULL;
    }
    hb_blocks++;
    hb_allocs++;
    struct hb_head *h = (struct hb_head *)raw;
    h->generation = b ? hb_generation : 0;
    h->size = total;
    if (b) {
        b->used += total;
        if (b->used > b->peak) b->peak = b->used;
        b->last = INK_BUDGET_MET;
        noted(b, raw, size);
    }
    return raw + HB_HEAD;
}

void ink_hb_free(void *ptr)
{
    if (!ptr) return;
    struct hb_head *h = (struct hb_head *)((unsigned char *)ptr - HB_HEAD);
    if (hb_budget && h->generation != 0 && h->generation == hb_generation) hb_budget->used -= h->size;
    hb_blocks--;
    free(h);
}

void *ink_hb_calloc(size_t n, size_t size)
{
    if (size && n > (size_t)-1 / size) return NULL;
    void *p = ink_hb_malloc(n * size);
    if (p) memset(p, 0, n * size);
    return p;
}

void *ink_hb_realloc(void *ptr, size_t size)
{
    if (!ptr) return ink_hb_malloc(size);
    if (size == 0) {
        ink_hb_free(ptr);
        return NULL;
    }
    /* New, copy, free: the old block stays whole when the new is refused. */
    void *p = ink_hb_malloc(size);
    if (!p) return NULL;
    const struct hb_head *h = (const struct hb_head *)((unsigned char *)ptr - HB_HEAD);
    const size_t old = h->size - HB_HEAD;
    memcpy(p, ptr, old < size ? old : size);
    ink_hb_free(ptr);
    return p;
}

int ink_budget_init(struct ink_budget *b, size_t cap, fz_alloc_context *alloc)
{
    alloc->user = b;
    alloc->malloc = budget_malloc;
    alloc->realloc = budget_realloc;
    alloc->free = budget_free;
    const int rc = ink_pool_open(b, cap);
    if (rc == 0) {
        hb_budget = b;
        hb_generation++;
        if (hb_generation == 0) hb_generation = 1; /* 0 marks an uncounted block */
    }
    return rc;
}

void ink_budget_close(struct ink_budget *b)
{
    if (hb_budget == b) {
        hb_budget = NULL;
        hb_generation++;
        if (hb_generation == 0) hb_generation = 1;
    }
    ink_pool_close(b);
}

int ink_budget_failure(const struct ink_budget *b, int code)
{
    if (b->last == INK_BUDGET_REFUSED) return -6;
    if (b->last == INK_BUDGET_SYSTEM) return -1;
    /* MuPDF went without memory it was refused, then failed as memory: still
     * the ceiling's. A refusal its retry got past does not count, so a read
     * error (also FZ_ERROR_SYSTEM) after one stays what it is. */
    if (code == FZ_ERROR_SYSTEM && ink_budget_lost(b) > 0) return -6;
    /* The system's, though MuPDF allocated again before rethrowing it. */
    if (code == FZ_ERROR_SYSTEM && b->system_failures > 0) return -1;
    return -2;
}

void ink_budget_settle(struct ink_budget *b)
{
    if (b->pending) b->unrecovered++;
    b->pending = 0;
}

unsigned ink_budget_lost(const struct ink_budget *b)
{
    return b->unrecovered + (b->pending ? 1u : 0u);
}

size_t ink_mupdf_budget(void)
{
    return INK_MUPDF_BUDGET;
}
