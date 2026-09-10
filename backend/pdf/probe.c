/* What the server needs to know about a PDF, and nothing more: how many pages,
 * the shape of page 1, and whether the file opens at all.
 *
 * WHY THIS IS C AT ALL — the same reason `webapp/wasm/pdf_shim.c` is. `fz_try`
 * and `fz_catch` are `setjmp`/`longjmp`, and a Zig frame between them is
 * undefined behaviour. So EVERY MuPDF call lives inside one C function that
 * catches its own exceptions and hands back a plain struct.
 *
 * It is deliberately NOT `pdf_shim.c`, which is the browser's ABI —
 * JSPI-suspending reads, JSON payloads, a block cache. The agreement that
 * matters (server and browser reporting the same page size) comes from linking
 * the same pinned MuPDF, not from sharing a wrapper.
 */

#include <stdint.h>
#include <stdio.h>
#include <unistd.h>
#include <mupdf/fitz.h>
#include <mupdf/pdf.h>

/* Declared in MuPDF's `source/fitz/document-all.c`, not in any public header.
 * Registering THIS handler alone rather than calling
 * `fz_register_document_handlers` keeps the other formats out of the link:
 * measured at 0.4 MB of binary. */
extern fz_document_handler pdf_document_handler;

struct ink_pdf_info {
    int32_t pages;
    /* The page-1 box in POINTS, already rotated and cropped — `fz_bound_page`
     * reports the TRANSFORMED box. This is why we do not read `/MediaBox`
     * ourselves: a raw MediaBox read looks right on most files and is wrong on
     * exactly the ones that matter (a `/Rotate 90` page, a non-zero
     * `/CropBox` origin). */
    float width;
    float height;
};

#define INK_PDF_OK 0
#define INK_PDF_NO_CONTEXT (-1)
#define INK_PDF_UNOPENABLE (-2)
#define INK_PDF_ENCRYPTED (-3)
#define INK_PDF_NO_PAGES (-4)

/* Swallows MuPDF's diagnostics — see the call sites in `ink_pdf_probe`. */
static void ink_pdf_silence(void *user, const char *message)
{
    (void)user;
    (void)message;
}

/* Fills `*out` for the PDF on the open descriptor `fd`.
 *
 * A DESCRIPTOR, NOT A PATH: the blob store holds a directory HANDLE, and this
 * `Io.Dir` has no `realpath`, so there is no path to hand over without threading
 * the store's root down from the config. It also closes a TOCTOU window.
 *
 * The fd is DUPPED, because `fclose` closes whatever `fdopen` wrapped and
 * closing the caller's descriptor out from under Zig would be a double close.
 * MuPDF is given `..._no_close`, so it never touches it either.
 *
 * Every negative result is a VERDICT about the file, not a transient failure:
 * the caller records it so the file is never probed again. A tenant that retried
 * an unopenable file for ever is the failure mode `deferred.Tenant.run` warns
 * about. */
int ink_pdf_probe(int fd, struct ink_pdf_info *out)
{
    out->pages = 0;
    out->width = 0;
    out->height = 0;

    /* FZ_STORE_DEFAULT (256 MB) is a CEILING, not an allocation: the store grows
     * as MuPDF caches parsed objects and evicts at the limit. It is left at the
     * default here because this probe never gets near it — measured at 8.78 MB
     * peak on ARM for a 1,703-page document, 13.2 MB on x86.
     *
     * A TEXT PASS IS THE OPPOSITE CASE and must cap the store: §9.6 measured a
     * 76 MB file peaking at 55 MB with the default and 16.5 MB with a 4 MB cap
     * — the difference between fitting the 50 MB budget and blowing it. */
    fz_context *ctx = fz_new_context(NULL, NULL, FZ_STORE_DEFAULT);
    if (!ctx) return INK_PDF_NO_CONTEXT;

    /* SILENCE MuPDF's OWN STDERR. By default it prints "warning: UNHANDLED
     * EXCEPTION!" for every file it cannot open — a library writing
     * uncontrolled diagnostics about routine, expected input. Worse, a stray
     * write from a test binary breaks the Zig build runner's IPC and reports a
     * bogus failure (`services/txt_index.zig`'s bench line still does). */
    fz_set_error_callback(ctx, ink_pdf_silence, NULL);
    fz_set_warning_callback(ctx, ink_pdf_silence, NULL);

    fz_register_document_handler(ctx, &pdf_document_handler);

    const int dupfd = dup(fd);
    if (dupfd < 0) { fz_drop_context(ctx); return INK_PDF_UNOPENABLE; }
    FILE *fp = fdopen(dupfd, "rb");
    if (!fp) { close(dupfd); fz_drop_context(ctx); return INK_PDF_UNOPENABLE; }

    fz_document *doc = NULL;
    fz_page *page = NULL;
    fz_stream *stm = NULL;
    int rc = INK_PDF_OK;

    fz_try(ctx) {
        stm = fz_open_file_ptr_no_close(ctx, fp);
        /* The magic names the FORMAT, since a descriptor carries no
         * extension. */
        doc = fz_open_document_with_stream(ctx, ".pdf", stm);
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
        rc = INK_PDF_UNOPENABLE;
    }

    fz_drop_context(ctx);
    fclose(fp); /* closes `dupfd`; MuPDF was given `..._no_close` */

    /* A document that opened but reported a degenerate box is not usable as a
     * shape. Treated as "no pages" rather than stored as a zero, because a zero
     * width would reach `aspectOf` and divide. */
    if (rc == INK_PDF_OK && !(out->width > 0 && out->height > 0)) {
        out->pages = 0;
        return INK_PDF_NO_PAGES;
    }
    return rc;
}

/* --- JPX stubs (upstream bug workaround) ---------------------------------
 *
 * MuPDF 1.28.1's `source/fitz/load-jpx.c` is excluded from the build
 * (`build.zig`, `mupdf_excluded_sources`) because its `FZ_ENABLE_JPX == 0` stub
 * for `fz_load_jpx_info` is missing the trailing `fz_colorspace *defcs`
 * parameter its own declaration has. `webapp/wasm/pdf_shim.c` supplies correctly
 * typed replacements for the browser; this file does the same for the server.
 *
 * DUPLICATED ON PURPOSE: sharing them would mean a common C file linked into
 * two targets with different contracts, for the sake of ten lines. MuPDF stays
 * unpatched, and a JPX image degrades to "unsupported" as upstream intended. */

fz_pixmap *fz_load_jpx(fz_context *ctx, const unsigned char *data, size_t size, fz_colorspace *defcs)
{
    (void)data;
    (void)size;
    (void)defcs;
    fz_throw(ctx, FZ_ERROR_UNSUPPORTED, "JPX support disabled");
}

void fz_load_jpx_info(fz_context *ctx, const unsigned char *data, size_t size,
    int *wp, int *hp, int *xresp, int *yresp, fz_colorspace **cspacep, fz_colorspace *defcs)
{
    (void)data;
    (void)size;
    (void)wp;
    (void)hp;
    (void)xresp;
    (void)yresp;
    (void)cspacep;
    (void)defcs;
    fz_throw(ctx, FZ_ERROR_UNSUPPORTED, "JPX support disabled");
}
