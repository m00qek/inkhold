/* What the server needs to know about a PDF, and nothing more: how many pages,
 * the shape of page 1, and whether the file opens at all.
 * See `docs/scratch/pdf-index.md`.
 *
 * WHY THIS IS C AT ALL — the same reason `webapp/wasm/pdf_shim.c` is. `fz_try`
 * and `fz_catch` are `setjmp`/`longjmp`, and a Zig frame between them is
 * undefined behaviour: Zig's error handling and MuPDF's longjmp cannot be
 * interleaved. So EVERY MuPDF call lives inside one C function that catches its
 * own exceptions and hands back a plain struct. No Zig frame is ever inside an
 * `fz_try`.
 *
 * It is deliberately NOT `pdf_shim.c`. That file is the browser's ABI —
 * JSPI-suspending reads, JSON payloads, a block cache — and shares with this one
 * only the library underneath. The agreement that matters (the server and the
 * browser reporting the same page size) comes from linking the same pinned
 * MuPDF, not from sharing a wrapper.
 */

#include <stdint.h>
#include <stdio.h>
#include <unistd.h>
#include <mupdf/fitz.h>
#include <mupdf/pdf.h>

/* Declared in MuPDF's `source/fitz/document-all.c`, not in any public header.
 *
 * Registering THIS handler alone rather than calling
 * `fz_register_document_handlers` is what keeps the other formats out of the
 * link: measured at 0.4 MB of binary (`pdf-index.md` §3). The server indexes
 * PDFs; the browser is the one that needs EPUB and CBZ. */
extern fz_document_handler pdf_document_handler;

struct ink_pdf_info {
    int32_t pages;
    /* The page-1 box in POINTS, already rotated and cropped — `fz_bound_page`
     * reports the TRANSFORMED box, so a `/Rotate 90` page reports its rotated
     * extent and a non-zero `/CropBox` origin is already accounted for.
     *
     * This is the whole reason we do not read `/MediaBox` ourselves. The export
     * put ink ninety degrees out on a rotated page, and `pdf-links.md` §2
     * records both traps; a raw MediaBox read looks right on most files and is
     * wrong on exactly the ones that matter. */
    float width;
    float height;
};

#define INK_PDF_OK 0
#define INK_PDF_NO_CONTEXT (-1)
#define INK_PDF_UNOPENABLE (-2)
#define INK_PDF_ENCRYPTED (-3)
#define INK_PDF_NO_PAGES (-4)

/* Fills `*out` for the PDF at `path`.
 *
 * Every negative result is a VERDICT, not a transient failure: the caller
 * records it so the file is never probed again. A tenant that retried an
 * unopenable file for ever is the failure mode `deferred.Tenant.run` warns
 * about. */
/* Swallows MuPDF's diagnostics — see the call sites in `ink_pdf_probe`. */
static void ink_pdf_silence(void *user, const char *message)
{
    (void)user;
    (void)message;
}

/* Fills `*out` for the PDF on the open descriptor `fd`.
 *
 * A DESCRIPTOR, NOT A PATH, and that is what makes this usable at all: the blob
 * store holds a directory HANDLE, and this `Io.Dir` has no `realpath`, so there
 * is no path to hand over without threading the store's root down from the
 * config. Taking the descriptor the store already opened also closes a TOCTOU
 * window and makes the answer independent of the working directory.
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

    /* FZ_STORE_DEFAULT, deliberately: it is what the measurement in
     * `pdf-index.md` §3.1 used (13.2 MB peak on a 1,703-page document), so the
     * shipped code and the recorded number describe the same thing. Tuning the
     * store down is a separate change with its own measurement. */
    fz_context *ctx = fz_new_context(NULL, NULL, FZ_STORE_DEFAULT);
    if (!ctx) return INK_PDF_NO_CONTEXT;

    /* SILENCE MuPDF's OWN STDERR. By default it prints "warning: UNHANDLED
     * EXCEPTION!" and the message for every file it cannot open — which for a
     * server means a library writing uncontrolled diagnostics to the operator's
     * terminal about routine, expected input. We return a verdict instead and
     * the caller logs it in the server's own voice, at the server's own level.
     *
     * This project already has the sharper version of the lesson: a stray
     * `printf` in a test binary breaks the Zig build runner's IPC and reports a
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
        /* The magic names the FORMAT, since a descriptor carries no extension.
         * Only the PDF handler is registered, so this is the only thing it
         * could be. */
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
 * DUPLICATED ON PURPOSE. Sharing them would mean a common C file linked into two
 * targets with different contracts, which is the coupling `pdf-index.md` argues
 * against for the sake of ten lines. MuPDF stays unpatched, and a JPX image
 * degrades to "unsupported" the way upstream intended. */

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
