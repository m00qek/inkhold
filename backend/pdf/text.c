/* One PDF page's text, and nothing more.
 *
 * WHY THIS IS C AT ALL — the same reason `probe.c` is: a Zig frame between
 * `fz_try` and `fz_catch` is undefined behaviour. `text.zig` owns page
 * iteration, batching and the reopen schedule.
 *
 * It is NOT part of `probe.c` because the two have opposite memory contracts.
 * The probe never approaches the store and runs at `FZ_STORE_DEFAULT`; a full
 * text pass is the case that file's comment warns about, and it needs a handle
 * that OUTLIVES a single call.
 *
 * THREE RULES, each of which cost a measurement or a day (§9.6-9.9):
 *
 *   1. THE STORE IS CAPPED AT 4 MB, not left at the default. Uncapped, the
 *      446 MB Wok book peaks at 29.12 MB on the Pi against 12.90 MB capped —
 *      over the whole server's ~50 MB budget on its own.
 *   2. THE DOCUMENT IS REOPENED EVERY `batch` PAGES, never held open. That is
 *      `text.zig`'s job, but it is why the handle is cheap to close and reopen:
 *      held open the same book costs +6.5 MB and leaves 0.3 MB of headroom.
 *   3. THE CONTEXT IS DROPPED OUTSIDE `fz_try`/`fz_always`/`fz_catch`. The
 *      exception stack lives IN the context, so freeing it while the construct
 *      is still unwinding is a use-after-free. x86-64 tolerated it through
 *      months of measurement (the freed memory stayed readable); armv6 faults
 *      immediately — on a 481-byte three-page PDF, not on a large one.
 *
 * And, as in `probe.c`: register ONLY `pdf_document_handler`.
 * `fz_register_document_handlers` drags in the html/mobi document types the trim
 * flags disabled, and the link then fails on `fz_extract_html_from_mobi`.
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <mupdf/fitz.h>
#include <mupdf/pdf.h>

/* Declared in MuPDF's `source/fitz/document-all.c`, not in any public header —
 * see the note in `probe.c`, which declares it for the same reason. */
extern fz_document_handler pdf_document_handler;

/* The store CEILING for a text pass, in bytes. See rule 1 above: the only
 * reason a 446 MB book fits the server's budget on a Pi 1 B+. */
#define INK_PDF_TEXT_STORE (4 * 1024 * 1024)

/* Mirrors `probe.c`'s codes, so `text.zig` and `probe.zig` map the same integer
 * to the same verdict. Kept in step by the tests on both sides rather than by a
 * shared header for five integers. */
#define INK_PDF_OK 0
#define INK_PDF_NO_CONTEXT (-1)
#define INK_PDF_UNOPENABLE (-2)
#define INK_PDF_ENCRYPTED (-3)
#define INK_PDF_NO_PAGES (-4)

/* One page failed to extract, on a document that opened. A RESULT, not a
 * verdict about the file: `text.zig` counts it and carries on. */
#define INK_PDF_PAGE_FAILED (-5)

/* `buf` is the LAST page's text and is owned here, dropped at the top of the
 * next `ink_pdf_text_page` call. That is what lets the boundary hand Zig a
 * BORROWED pointer with no allocation dance in either direction. */
struct ink_pdf_text {
    fz_context *ctx;
    fz_document *doc;
    fz_stream *stm;
    FILE *fp;
    fz_buffer *buf;
};

/* Swallows MuPDF's diagnostics — same reasoning as `probe.c`. */
static void ink_pdf_text_silence(void *user, const char *message)
{
    (void)user;
    (void)message;
}

void ink_pdf_text_close(struct ink_pdf_text *t)
{
    if (!t) return;
    /* EVERY drop is outside a `fz_try` — rule 3. `fz_drop_*` does not throw. */
    if (t->ctx) {
        fz_drop_buffer(t->ctx, t->buf);
        fz_drop_document(t->ctx, t->doc);
        fz_drop_stream(t->ctx, t->stm);
        fz_drop_context(t->ctx);
    }
    if (t->fp) fclose(t->fp); /* closes our dup; MuPDF was given `..._no_close` */
    free(t);
}

/* Opens the PDF on `fd` for a text pass and reports its page count.
 *
 * A DESCRIPTOR, NOT A PATH, and DUPPED, for the reasons `probe.c` records.
 *
 * Returns the page count (> 0) and fills `*out`, or one of the negative codes
 * above with `*out` NULL. Every negative is a verdict about the FILE except
 * `INK_PDF_NO_CONTEXT`, which is about us.
 */
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
        /* The magic names the FORMAT — a descriptor carries no extension. */
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
    /* NO `fz_always` CLAUSE, DELIBERATELY. On success the handle survives the
     * call; on failure the release is `ink_pdf_text_close`, which drops the
     * context — and rule 3 forbids doing that from inside the construct. */

    if (rc != INK_PDF_OK) {
        ink_pdf_text_close(t);
        return rc;
    }
    *out = t;
    return pages;
}

/* One page's text, UTF-8. Returns the byte length (>= 0) and points `*out` at a
 * buffer OWNED BY `t`, valid only until the next call on `t`. Returns
 * `INK_PDF_PAGE_FAILED` for a page this document could not render to text, with
 * `*out` an empty string — a page-level result, never fatal to the pass.
 *
 * `number` is 0-based, as `fz_load_page` counts.
 */
int32_t ink_pdf_text_page(struct ink_pdf_text *t, int32_t number, const char **out)
{
    *out = "";

    /* Last page's text goes now, not at close: the handle holds at most ONE
     * page's worth at a time. */
    fz_drop_buffer(t->ctx, t->buf);
    t->buf = NULL;

    int32_t len = INK_PDF_PAGE_FAILED;
    fz_try(t->ctx) {
        t->buf = fz_new_buffer_from_page_number(t->ctx, t->doc, (int)number, NULL);
        unsigned char *data = NULL;
        const size_t n = fz_buffer_storage(t->ctx, t->buf, &data);
        /* An int32 length is the boundary's contract; a page whose text exceeds
         * 2 GB is not a page. Unreachable on anything real. */
        len = n > (size_t)INT32_MAX ? INT32_MAX : (int32_t)n;
        *out = (const char *)data;
    }
    fz_catch(t->ctx) {
        /* `fz_new_buffer_from_page_number` throws before it returns, so `t->buf`
         * is still NULL and there is nothing to release. */
        len = INK_PDF_PAGE_FAILED;
        *out = "";
    }
    return len;
}
