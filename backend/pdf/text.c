/* One PDF page's text, behind a handle that outlives a call. In C for the same
 * setjmp/longjmp reason as `probe.c`. The store is capped (see below), and the
 * context is never dropped inside `fz_try`/`fz_always`/`fz_catch`: the
 * exception stack lives in it, and armv6 faults on that use-after-free. Only
 * `pdf_document_handler` is registered; the full set fails to link with the
 * trimmed build (`fz_extract_html_from_mobi`). */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <mupdf/fitz.h>
#include <mupdf/pdf.h>

/* Not in any public header (`source/fitz/document-all.c`). */
extern fz_document_handler pdf_document_handler;

/* Store ceiling for a text pass. Uncapped, a 446 MB book peaks at ~29 MB on a
 * Pi against ~13 MB capped. */
#define INK_PDF_TEXT_STORE (4 * 1024 * 1024)

/* Same codes as `probe.c`. */
#define INK_PDF_OK 0
#define INK_PDF_NO_CONTEXT (-1)
#define INK_PDF_UNOPENABLE (-2)
#define INK_PDF_ENCRYPTED (-3)
#define INK_PDF_NO_PAGES (-4)

/* A page-level result, not a verdict about the file. */
#define INK_PDF_PAGE_FAILED (-5)

/* `buf` is the last page's text, owned here and dropped at the next
 * `ink_pdf_text_page` call, so Zig gets a borrowed pointer. */
struct ink_pdf_text {
    fz_context *ctx;
    fz_document *doc;
    fz_stream *stm;
    FILE *fp;
    fz_buffer *buf;
};

static void ink_pdf_text_silence(void *user, const char *message)
{
    (void)user;
    (void)message;
}

void ink_pdf_text_close(struct ink_pdf_text *t)
{
    if (!t) return;
    /* Drops stay outside any `fz_try`; `fz_drop_*` does not throw. */
    if (t->ctx) {
        fz_drop_buffer(t->ctx, t->buf);
        fz_drop_document(t->ctx, t->doc);
        fz_drop_stream(t->ctx, t->stm);
        fz_drop_context(t->ctx);
    }
    if (t->fp) fclose(t->fp); /* closes our dup */
    free(t);
}

/* Opens the PDF on `fd` (dupped) for a text pass. Returns the page count (> 0)
 * and fills `*out`, or a negative code with `*out` NULL. */
int ink_pdf_text_open(int fd, struct ink_pdf_text **out)
{
    *out = NULL;

    struct ink_pdf_text *t = calloc(1, sizeof *t);
    if (!t) return INK_PDF_NO_CONTEXT;

    t->ctx = fz_new_context(NULL, NULL, INK_PDF_TEXT_STORE);
    if (!t->ctx) {
        free(t);
        return INK_PDF_NO_CONTEXT;
    }
    fz_set_error_callback(t->ctx, ink_pdf_text_silence, NULL);
    fz_set_warning_callback(t->ctx, ink_pdf_text_silence, NULL);
    fz_register_document_handler(t->ctx, &pdf_document_handler);

    const int dupfd = dup(fd);
    if (dupfd < 0) {
        ink_pdf_text_close(t);
        return INK_PDF_UNOPENABLE;
    }
    t->fp = fdopen(dupfd, "rb");
    if (!t->fp) {
        close(dupfd);
        ink_pdf_text_close(t);
        return INK_PDF_UNOPENABLE;
    }

    int rc = INK_PDF_OK;
    int pages = 0;
    fz_try(t->ctx) {
        t->stm = fz_open_file_ptr_no_close(t->ctx, t->fp);
        /* A descriptor carries no extension, so name the format. */
        t->doc = fz_open_document_with_stream(t->ctx, ".pdf", t->stm);
        if (fz_needs_password(t->ctx, t->doc)) {
            rc = INK_PDF_ENCRYPTED;
        } else {
            pages = fz_count_pages(t->ctx, t->doc);
            if (pages <= 0) rc = INK_PDF_NO_PAGES;
        }
    }
    fz_catch(t->ctx) {
        rc = INK_PDF_UNOPENABLE;
    }
    /* No `fz_always`: on success the handle survives, and on failure the
     * release drops the context, which must not happen inside the construct. */

    if (rc != INK_PDF_OK) {
        ink_pdf_text_close(t);
        return rc;
    }
    *out = t;
    return pages;
}

/* One page's text (0-based `number`), UTF-8. Returns the byte length and points
 * `*out` at a buffer owned by `t`, valid until the next call; or
 * `INK_PDF_PAGE_FAILED` with `*out` empty. */
int32_t ink_pdf_text_page(struct ink_pdf_text *t, int32_t number, const char **out)
{
    *out = "";

    /* Drop the last page now, so at most one page is held. */
    fz_drop_buffer(t->ctx, t->buf);
    t->buf = NULL;

    int32_t len = INK_PDF_PAGE_FAILED;
    fz_try(t->ctx) {
        t->buf = fz_new_buffer_from_page_number(t->ctx, t->doc, (int)number, NULL);
        unsigned char *data = NULL;
        const size_t n = fz_buffer_storage(t->ctx, t->buf, &data);
        len = n > (size_t)INT32_MAX ? INT32_MAX : (int32_t)n;
        *out = (const char *)data;
    }
    fz_catch(t->ctx) {
        /* Throws before returning, so `t->buf` is still NULL. */
        len = INK_PDF_PAGE_FAILED;
        *out = "";
    }
    return len;
}
