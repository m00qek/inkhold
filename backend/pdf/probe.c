/* Server-side PDF probe: page count and page-1 box. In C because `fz_try` is
 * setjmp/longjmp, and a Zig frame between them is undefined behaviour. */

#include <stdint.h>
#include <stdio.h>
#include <unistd.h>
#include <mupdf/fitz.h>
#include <mupdf/pdf.h>

/* Not in any public header (`source/fitz/document-all.c`). Registering only
 * this handler keeps the other formats out of the link (~0.4 MB). */
extern fz_document_handler pdf_document_handler;

struct ink_pdf_info {
    int32_t pages;
    /* Page-1 box in points, rotated and cropped by `fz_bound_page`; a raw
     * `/MediaBox` read is wrong for `/Rotate` and non-zero `/CropBox` pages. */
    float width;
    float height;
};

#define INK_PDF_OK 0
#define INK_PDF_NO_CONTEXT (-1)
#define INK_PDF_UNOPENABLE (-2)
#define INK_PDF_ENCRYPTED (-3)
#define INK_PDF_NO_PAGES (-4)

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

    /* The default store size is a ceiling, not an allocation; the probe stays
     * far below it (~9-13 MB peak on 1,700 pages). A text pass must cap it. */
    fz_context *ctx = fz_new_context(NULL, NULL, FZ_STORE_DEFAULT);
    if (!ctx) return INK_PDF_NO_CONTEXT;

    /* Silence MuPDF's stderr: a stray write from a test binary breaks the Zig
     * build runner's IPC. */
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
        /* A descriptor carries no extension, so name the format. */
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
    fclose(fp); /* closes `dupfd` */

    /* A degenerate box would reach `aspectOf` and divide by zero. */
    if (rc == INK_PDF_OK && !(out->width > 0 && out->height > 0)) {
        out->pages = 0;
        return INK_PDF_NO_PAGES;
    }
    return rc;
}

/* JPX stubs. MuPDF 1.28.1's `load-jpx.c` is excluded from the build because
 * its `FZ_ENABLE_JPX == 0` stub for `fz_load_jpx_info` lacks the `defcs`
 * parameter its declaration has; these are correctly typed replacements. */

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
