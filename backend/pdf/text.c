/* One PDF page's text, and nothing more.
 *
 * WHY THIS IS C AT ALL — the same reason `probe.c` is, and the reason is not
 * stylistic: `fz_try`/`fz_catch` are `setjmp`/`longjmp`, and a Zig frame between
 * them is undefined behaviour. So EVERY MuPDF call lives on this side and only a
 * pointer-and-length crosses. `text.zig` owns page iteration, batching and the
 * reopen schedule, where a loop is readable and testable.
 *
 * It is NOT part of `probe.c` because the two have opposite memory contracts.
 * The probe opens, counts, bounds page 1 and closes; it never approaches the
 * store and deliberately runs at `FZ_STORE_DEFAULT` (`probe.c:87-96`). A full
 * text pass is the case that comment warns about, and it needs a handle that
 * OUTLIVES a single call so `text.zig` can walk pages without reopening for each
 * one. Sharing a file would mean one of the two contracts written down twice.
 *
 * THREE RULES, each of which cost a measurement or a day (`mupdf.md` §9.6-9.9):
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

/* The store CEILING for a text pass, in bytes. See rule 1 above; this is the
 * single most load-bearing constant in the file and the only reason a 446 MB
 * book fits inside the server's budget on a Pi 1 B+. */
#define INK_PDF_TEXT_STORE (4 * 1024 * 1024)

/* Mirrors `probe.c`'s codes, so `text.zig` and `probe.zig` map the same integer
 * to the same verdict. Kept in step by the tests on both sides rather than by a
 * shared header, which would be a header for five integers. */
#define INK_PDF_OK 0
#define INK_PDF_NO_CONTEXT (-1)
#define INK_PDF_UNOPENABLE (-2)
#define INK_PDF_ENCRYPTED (-3)
#define INK_PDF_NO_PAGES (-4)

/* One page failed to extract, on a document that opened. A RESULT, not a
 * verdict about the file: `text.zig` counts it and carries on, exactly as the
 * measurement harness did ("zero failed pages" is a reported fact, so there has
 * to be something to report). */
#define INK_PDF_PAGE_FAILED (-5)

/* An open document, plus everything that has to die with it.
 *
 * `buf` is the LAST page's text and is owned here: it is dropped at the top of
 * the next `ink_pdf_text_page` call. That is what lets the boundary hand Zig a
 * borrowed pointer with no allocation dance in either direction — the caller
 * copies what it wants before asking for the next page, which is exactly what a
 * segment upsert does anyway. */
struct ink_pdf_text {
    fz_context *ctx;
    fz_document *doc;
    fz_stream *stm;
    FILE *fp;
    fz_buffer *buf;
};

/* Swallows MuPDF's diagnostics — same reasoning as `probe.c`: a library must not
 * write uncontrolled text to the operator's terminal about routine input, and a
 * stray write from a test binary breaks the Zig build runner's IPC. */
static void ink_pdf_text_silence(void *user, const char *message)
{
    (void)user;
    (void)message;
}

void ink_pdf_text_close(struct ink_pdf_text *t)
{
    if (!t) return;
    /* EVERY drop is outside a `fz_try`. `fz_drop_*` does not throw, and rule 3
     * says the context in particular must not be freed while a construct is
     * unwinding. There is no construct here at all, which is the strongest form
     * of that rule. */
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
 * A DESCRIPTOR, NOT A PATH, for the reasons `probe.c` records: the blob store
 * holds a directory handle with no `realpath`, the descriptor closes a TOCTOU
 * window, and the answer does not depend on the working directory. The fd is
 * DUPPED because `fclose` closes whatever `fdopen` wrapped, and closing the
 * caller's descriptor would be a double close.
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
        /* The magic names the FORMAT — a descriptor carries no extension, and
         * only the PDF handler is registered, so this is the only thing it could
         * be. */
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
     * call, so there is nothing to release here; on failure the release is
     * `ink_pdf_text_close`, which drops the context — and rule 3 forbids doing
     * that from inside the construct. Both halves are therefore below it. */

    if (rc != INK_PDF_OK) {
        ink_pdf_text_close(t);
        return rc;
    }
    *out = t;
    return pages;
}

/* One page's text, UTF-8, as MuPDF's structured-text pass flattens it.
 *
 * Returns the byte length (>= 0) and points `*out` at a buffer OWNED BY `t`,
 * valid only until the next call on `t` (see the struct comment). Returns
 * `INK_PDF_PAGE_FAILED` for a page this document could not render to text, with
 * `*out` an empty string — a page-level result, never fatal to the pass.
 *
 * `number` is 0-based, as `fz_load_page` counts.
 */
int32_t ink_pdf_text_page(struct ink_pdf_text *t, int32_t number, const char **out)
{
    *out = "";

    /* Last page's text goes now, not at close: the handle holds at most ONE
     * page's worth at a time, which is the whole per-page memory story. */
    fz_drop_buffer(t->ctx, t->buf);
    t->buf = NULL;

    int32_t len = INK_PDF_PAGE_FAILED;
    fz_try(t->ctx) {
        t->buf = fz_new_buffer_from_page_number(t->ctx, t->doc, (int)number, NULL);
        unsigned char *data = NULL;
        const size_t n = fz_buffer_storage(t->ctx, t->buf, &data);
        /* An int32 length is the boundary's contract, and a page whose text
         * exceeds 2 GB is not a page. Clamped rather than truncated silently at
         * a random byte: `text.zig` would see a length it can trust either way,
         * and this branch is unreachable on anything real. */
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
