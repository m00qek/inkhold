/* MuPDF <-> Zig shim for the browser PDF viewer. `fz_try` is setjmp/longjmp,
 * so every MuPDF call lives here and every function is exception-free at its
 * boundary (NULL or a negative int). `pdf_decode.zig` owns the ABI. */

#include "pdf_shim.h"

/* Store cap. MuPDF's 256 MB default can grow a wasm heap without bound; 16 MB
 * keeps one large page's resources across a re-render. */
#define INK_STORE_LIMIT (16 << 20)

/* A book (EPUB, FB2: reflowable) is laid out as the tablet's reader lays it
 * out, so its pages are the tablet's pages and its ink lands where it was
 * written: a 1200 x 1600 box with a 100/3 em, the numbers at which stock
 * MuPDF 1.17 (the reader's) reproduces the tablet's own page 33 of Moby Dick.
 * Layout is not scale-invariant: 288 x 384 with 8, the same proportions,
 * paginates differently, and an em of 33 or 33.4 does too. Never applied to
 * a PDF, XPS or CBZ: their pages are fixed. */
#define INK_BOOK_WIDTH 1200.0f
#define INK_BOOK_HEIGHT 1600.0f
#define INK_BOOK_EM (100.0f / 3.0f)

/* What our MuPDF does that the tablet's 1.17 does not, undone before layout.
 * 1.17 ignores `hyphens: auto` (books ask for it; we would break words where
 * the tablet doesn't) but breaks at a soft hyphen (U+00AD), which `manual`
 * keeps and `none` would not; and it doesn't know `hgroup`, so gives it no
 * margins. Each
 * rule here moved real line or page breaks; more will join as books show
 * them. A user stylesheet: it applies to every HTML document, and only those. */
static const char ink_tablet_css[] =
	"* { hyphens: manual !important }\n"
	"hgroup { margin-top: 0 !important; margin-bottom: 0 !important }\n";

/* Noto Serif, from book_fonts.zig: MuPDF's own fallback face for a character
 * Charis lacks in these scripts (fitz/font-table.h), which TOFU_NOTO leaves
 * out with every other Noto face. Handed back through MuPDF's public
 * system-fallback hook, so its layout is untouched: the same face it would
 * have picked, for the same scripts; any other script finds none, as before. */
extern const unsigned char ink_noto_serif[];
extern const unsigned int ink_noto_serif_size;
static fz_font *g_noto_serif;

static fz_font *ink_fallback_font(fz_context *ctx, int script, int language, int serif, int bold, int italic)
{
	(void)language;
	(void)serif;
	(void)bold;
	(void)italic;
	switch (script)
	{
	case UCDN_SCRIPT_LATIN:
	case UCDN_SCRIPT_GREEK:
	case UCDN_SCRIPT_CYRILLIC:
	case UCDN_SCRIPT_COMMON:
	case UCDN_SCRIPT_INHERITED:
	case UCDN_SCRIPT_UNKNOWN:
		break;
	default:
		return NULL;
	}
	/* One font for every script slot: MuPDF keeps what it gets per slot. */
	if (!g_noto_serif)
	{
		g_noto_serif = fz_new_font_from_memory(ctx, "Noto Serif", ink_noto_serif, (int)ink_noto_serif_size, 0, 0);
		fz_set_font_embedding(ctx, g_noto_serif, 1);
	}
	return fz_keep_font(ctx, g_noto_serif);
}

fz_context *g_ctx;

/* Last MuPDF error message: return codes say which call failed, not why. */
static char g_error[256];

void ink_set_error(const char *msg)
{
	size_t i = 0;

	if (!msg)
		msg = "unknown error";
	while (i + 1 < sizeof(g_error) && msg[i]) {
		g_error[i] = msg[i];
		i++;
	}
	g_error[i] = 0;
}

/* Only valid inside `fz_catch`; our own refusals use `ink_set_error`. */
void ink_record_error(fz_context *ctx)
{
	ink_set_error(fz_caught_message(ctx));
}

const char *ink_shim_error(void)
{
	return g_error;
}

/* Lazily creates the single context; NULL on failure. */
fz_context *ink_shim_context(void)
{
	if (g_ctx)
		return g_ctx;
	g_ctx = fz_new_context(NULL, NULL, INK_STORE_LIMIT);
	if (!g_ctx)
		return NULL;
	fz_try(g_ctx)
	{
		fz_register_document_handlers(g_ctx);
		fz_set_user_css(g_ctx, ink_tablet_css);
		fz_install_load_system_font_funcs(g_ctx, NULL, NULL, ink_fallback_font);
	}
	fz_catch(g_ctx)
	{
		ink_record_error(g_ctx);
		fz_drop_context(g_ctx);
		g_ctx = NULL;
	}
	return g_ctx;
}

/* Lays a book out at the tablet's page size (see INK_BOOK_WIDTH); a fixed-page
 * document is left as it is. Throws, as MuPDF does: callers are in `fz_try`. */
static void ink_layout_book(fz_context *ctx, fz_document *doc)
{
	if (fz_is_document_reflowable(ctx, doc))
		fz_layout_document(ctx, doc, INK_BOOK_WIDTH, INK_BOOK_HEIGHT, INK_BOOK_EM);
}

/* Opens bytes allocated with libc `malloc`, consuming `data` on every path.
 * The magic is "" not NULL: NULL is rejected ("missing file type"), "" means
 * recognise by content (PDF/EPUB/FB2/CBZ/XPS). */
fz_document *ink_shim_open(void *data, unsigned int len)
{
	fz_context *ctx = ink_shim_context();
	fz_buffer *buf = NULL;
	fz_document *doc = NULL;

	if (!ctx) {
		free(data);
		return NULL;
	}
	fz_var(buf);
	fz_var(data);
	fz_var(doc);
	fz_try(ctx)
	{
		buf = fz_new_buffer_from_data(ctx, (unsigned char *)data, (size_t)len);
		data = NULL; /* the buffer owns the bytes from here on */
		doc = fz_open_document_with_buffer(ctx, "", buf);
		ink_layout_book(ctx, doc);
	}
	fz_always(ctx)
		fz_drop_buffer(ctx, buf);
	fz_catch(ctx)
	{
		ink_record_error(ctx);
		fz_drop_document(ctx, doc); /* open, if laying the book out failed */
		free(data); /* non-NULL only if the buffer itself could not be made */
		return NULL;
	}
	return doc;
}

/* --- the callback stream --- */

/* Imported from JS as `ink.host_read`; without the import attributes wasm-ld
 * reports an undefined symbol. May suspend the whole wasm stack under JSPI,
 * which is safe inside `fz_try`. */
__attribute__((import_module("ink"), import_name("host_read")))
extern int ink_host_read(long long off, unsigned char *dst, int len);

/* Granularity of the JS<->wasm hop, not the network block size (the worker's
 * block cache owns that). */
#define INK_STREAM_CHUNK (32 * 1024)

typedef struct {
	long long total;   /* the document's length, from `NoteMeta.size` */
	long long pos;     /* the next byte the host will be asked for */
	long long win_off; /* file offset of `buf[0]` */
	int win_len;       /* valid bytes in `buf` */
	unsigned char buf[INK_STREAM_CHUNK];
} ink_stream_state;

/* `stm->pos` is the file offset of `wp` (the end of the buffer); `fz_tell`
 * subtracts `wp - rp`. The window is tracked in `win_off`/`win_len` because
 * MuPDF resets `rp`/`wp` at EOF and on seek. */
static int ink_stream_next(fz_context *ctx, fz_stream *stm, size_t max)
{
	ink_stream_state *st = stm->state;
	int want = INK_STREAM_CHUNK;
	int got;

	(void)max; /* a hint only, as in MuPDF's own file stream */
	if (st->pos >= st->total) {
		stm->rp = stm->wp = st->buf;
		return EOF;
	}
	if (st->total - st->pos < (long long)want)
		want = (int)(st->total - st->pos);
	got = ink_host_read(st->pos, st->buf, want);
	if (got < 0)
		/* `%ld`, not `%lld`: in MuPDF's printf one `l` is already 64 bits. */
		fz_throw(ctx, FZ_ERROR_SYSTEM, "cannot read %d bytes at %ld", want, st->pos);
	st->win_off = st->pos;
	st->win_len = got;
	st->pos += got;
	stm->rp = st->buf;
	stm->wp = st->buf + got;
	stm->pos = st->pos;
	if (got == 0)
		return EOF;
	return *stm->rp++;
}

/* `fz_seek` has no fast path, so an in-window seek must keep the window or an
 * xref walk pulls a fresh chunk per entry. */
static void ink_stream_seek(fz_context *ctx, fz_stream *stm, int64_t offset, int whence)
{
	ink_stream_state *st = stm->state;
	long long target = offset;

	if (whence == SEEK_CUR)
		target = (long long)fz_tell(ctx, stm) + offset;
	else if (whence == SEEK_END)
		target = st->total + offset;
	if (target < 0)
		target = 0;
	if (target > st->total)
		target = st->total;
	if (st->win_len > 0 && target >= st->win_off && target <= st->win_off + st->win_len) {
		stm->rp = st->buf + (target - st->win_off);
		stm->wp = st->buf + st->win_len;
		st->pos = st->win_off + st->win_len;
		stm->pos = st->pos;
		return;
	}
	st->pos = target;
	st->win_off = target;
	st->win_len = 0;
	stm->pos = target;
	stm->rp = stm->wp = st->buf; /* nothing buffered at the new position */
}

static void ink_stream_drop(fz_context *ctx, void *state)
{
	fz_free(ctx, state);
}

/* Opens a document that pulls bytes through `ink_host_read`. `total` is known
 * up front, so finding startxref costs no extra round trip. */
fz_document *ink_shim_open_stream(long long total)
{
	fz_context *ctx = ink_shim_context();
	ink_stream_state *st = NULL;
	fz_stream *stm = NULL;
	fz_document *doc = NULL;

	if (!ctx || total <= 0)
		return NULL;
	fz_var(st);
	fz_var(stm);
	fz_var(doc);
	fz_try(ctx)
	{
		st = fz_malloc_struct(ctx, ink_stream_state);
		st->total = total;
		st->pos = 0;
		stm = fz_new_stream(ctx, st, ink_stream_next, ink_stream_drop);
		st = NULL; /* the stream owns it, and drops it with `ink_stream_drop` */
		stm->seek = ink_stream_seek;
		doc = fz_open_document_with_stream(ctx, "", stm);
		ink_layout_book(ctx, doc);
	}
	fz_always(ctx)
		fz_drop_stream(ctx, stm);
	fz_catch(ctx)
	{
		ink_record_error(ctx);
		fz_drop_document(ctx, doc); /* open, if laying the book out failed */
		fz_free(ctx, st); /* non-NULL only if `fz_new_stream` itself failed */
		return NULL;
	}
	return doc;
}

int ink_shim_page_count(fz_document *doc)
{
	fz_context *ctx = g_ctx;
	int n = -1;

	if (!ctx || !doc)
		return -1;
	fz_var(n);
	fz_try(ctx)
		n = fz_count_pages(ctx, doc);
	fz_catch(ctx)
	{
		ink_record_error(ctx);
		return -1;
	}
	return n;
}

/* Page size in points; 0 on success, -1 on failure. */
int ink_shim_page_size(fz_document *doc, int number, float *w, float *h)
{
	fz_context *ctx = g_ctx;
	fz_page *page = NULL;
	fz_rect box = fz_empty_rect;

	if (!ctx || !doc)
		return -1;
	fz_var(page);
	fz_var(box);
	fz_try(ctx)
	{
		page = fz_load_page(ctx, doc, number);
		box = fz_bound_page(ctx, page);
	}
	fz_always(ctx)
		fz_drop_page(ctx, page);
	fz_catch(ctx)
	{
		ink_record_error(ctx);
		return -1;
	}
	*w = box.x1 - box.x0;
	*h = box.y1 - box.y0;
	return 0;
}


/* --- setjmp tag ---
 * Zig 0.17's wasi-libc setjmp runtime (`rt.c`) throws the C_LONGJMP tag but no
 * longer defines it, so `fz_try`/`fz_throw` link against an undefined
 * `__c_longjmp`. Its payload is the jmp_buf argument pointer (i32 on wasm32).
 */
__asm__(".globl __c_longjmp\n.tagtype __c_longjmp i32\n__c_longjmp:\n");

/* --- wasi-libc gap --- */

/* wasi-libc has no `mkstemp`; MuPDF only uses it on a save-to-path we never
 * take, so this stub keeps the module linkable and fails if reached. */
int mkstemp(char *template)
{
	(void)template;
	return -1;
}
