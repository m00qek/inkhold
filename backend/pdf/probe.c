/* Server-side probe of a paged document (PDF, XPS, CBZ): page count and
 * page-1 box. In C because `fz_try` is setjmp/longjmp, and a Zig frame
 * between them is undefined behaviour. */

#include <stdint.h>
#include <stdio.h>
#include <unistd.h>
#include <mupdf/fitz.h>
#include <mupdf/pdf.h>
#include "budget.h"
#include "open.h"

/* Not in any public header (`source/fitz/document-all.c`). Only the paged
 * formats are registered (PDF, XPS, CBZ), which keeps the other handlers out
 * of the link and EPUB and FB2 off the server: they reflow, and laying a book
 * out is far too much for a Pi. */
extern fz_document_handler pdf_document_handler;
extern fz_document_handler xps_document_handler;
extern fz_document_handler cbz_document_handler;

struct ink_pdf_info {
    int32_t pages;
    /* Page-1 box in points, rotated and cropped by `fz_bound_page`; a raw
     * `/MediaBox` read is wrong for `/Rotate` and non-zero `/CropBox` pages. */
    float width;
    float height;
    /* The most this probe's MuPDF context held at once (`budget.h`). */
    uint64_t peak_bytes;
    /* What MuPDF still held once its context was dropped: 0, unless it
     * forgot a block (which the pool then gives back). For the tests and the
     * bench. */
    uint64_t held_after;
};

#define INK_PDF_OK 0
#define INK_PDF_NO_CONTEXT (-1)
#define INK_PDF_UNOPENABLE (-2)
#define INK_PDF_ENCRYPTED (-3)
#define INK_PDF_NO_PAGES (-4)
/* Opening it needed more than `INK_MUPDF_BUDGET`. */
#define INK_PDF_TOO_LARGE (-6)

/* The probe's cache, well under the ceiling (see `ink_pdf_probe`). */
#define INK_PDF_PROBE_STORE (8 * 1024 * 1024)

static void ink_pdf_silence(void *user, const char *message)
{
    (void)user;
    (void)message;
}

/* Fills `*out` for the PDF on `fd`. The fd is dupped because `fclose` closes
 * what `fdopen` wrapped. Every negative result is a verdict about the file,
 * never transient (except NO_CONTEXT). */
int ink_pdf_probe(int fd, struct ink_pdf_info *out)
{
    out->pages = 0;
    out->width = 0;
    out->height = 0;
    out->peak_bytes = 0;
    out->held_after = 0;

    /* Every allocation in the context's pool, under the ceiling (`budget.c`),
     * the store included: the store's own size is a ceiling for its cache, and
     * is evicted under the budget's pressure. The probe stays far below (~9-13
     * MB on 1,700 pages). The store is capped, as the text pass's is: HarfBuzz's
     * blocks are refused without that eviction, so a full cache must never be
     * what leaves no room for them. */
    struct ink_budget budget;
    fz_alloc_context alloc;
    if (ink_budget_init(&budget, INK_MUPDF_BUDGET, &alloc) != 0) return INK_PDF_NO_CONTEXT;
    fz_context *ctx = fz_new_context(&alloc, NULL, INK_PDF_PROBE_STORE);
    if (!ctx) {
        ink_budget_close(&budget);
        return INK_PDF_NO_CONTEXT;
    }

    /* Silence MuPDF's stderr: a stray write from a test binary breaks the Zig
     * build runner's IPC. */
    fz_set_error_callback(ctx, ink_pdf_silence, NULL);
    fz_set_warning_callback(ctx, ink_pdf_silence, NULL);

    fz_register_document_handler(ctx, &pdf_document_handler);
    fz_register_document_handler(ctx, &xps_document_handler);
    fz_register_document_handler(ctx, &cbz_document_handler);

    const int dupfd = dup(fd);
    if (dupfd < 0) {
        fz_drop_context(ctx);
        ink_budget_close(&budget);
        return INK_PDF_UNOPENABLE;
    }
    FILE *fp = fdopen(dupfd, "rb");
    if (!fp) {
        close(dupfd);
        fz_drop_context(ctx);
        ink_budget_close(&budget);
        return INK_PDF_UNOPENABLE;
    }

    /* `volatile`: set inside `fz_try` and read in `fz_always` after a longjmp,
     * where an optimised build may otherwise see their old NULLs, leaving
     * the whole document undropped (C11 7.13.2.1). */
    fz_document *volatile doc = NULL;
    fz_page *volatile page = NULL;
    fz_stream *volatile stm = NULL;
    volatile int rc = INK_PDF_OK;

    fz_try(ctx) {
        stm = fz_open_file_ptr_no_close(ctx, fp);
        doc = ink_open_document(ctx, stm);
        if (fz_needs_password(ctx, doc)) {
            rc = INK_PDF_ENCRYPTED;
        } else {
            const int n = fz_count_pages(ctx, doc);
            if (n <= 0) {
                rc = INK_PDF_NO_PAGES;
            } else {
                page = fz_load_page(ctx, doc, 0);
                const fz_rect r = fz_bound_page(ctx, page);
                out->pages = (int32_t)n;
                out->width = r.x1 - r.x0;
                out->height = r.y1 - r.y0;
            }
        }
    }
    fz_always(ctx) {
        fz_drop_page(ctx, page);
        fz_drop_document(ctx, doc);
        fz_drop_stream(ctx, stm);
    }
    fz_catch(ctx) {
        rc = ink_budget_failure(&budget, fz_caught(ctx));
    }

    fz_drop_context(ctx);
    fclose(fp); /* closes `dupfd` */
    out->peak_bytes = budget.peak;
    out->held_after = budget.live;
    ink_budget_close(&budget);

    /* A degenerate box would reach `aspectOf` and divide by zero. */
    if (rc == INK_PDF_OK && !(out->width > 0 && out->height > 0)) {
        out->pages = 0;
        rc = INK_PDF_NO_PAGES;
    }
    /* MuPDF goes on without memory it was refused, degrading what it reads (a
     * page it could not load becomes an empty one), so a count or a shape read
     * that way, or "no pages", is the ceiling's verdict too. A refusal its
     * retry got past costs nothing (`ink_budget_lost`). */
    if ((rc == INK_PDF_OK || rc == INK_PDF_NO_PAGES) && ink_budget_lost(&budget) > 0) return INK_PDF_TOO_LARGE;
    return rc;
}
