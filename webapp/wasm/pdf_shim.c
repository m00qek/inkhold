/* MuPDF <-> Zig shim for the browser PDF viewer (`zig build wasm-pdf-decode`).
 *
 * WHY THIS FILE EXISTS AT ALL. MuPDF's error handling is `fz_try`/`fz_catch`,
 * which is `setjmp`/`longjmp` under a macro. Zig has no `setjmp`, so no Zig
 * code may sit *inside* an `fz_try` block — a `longjmp` past a Zig frame would
 * skip its `defer`s and unwind state Zig believes it owns. Every MuPDF call is
 * therefore made here, and every function below is exception-free at its
 * boundary: it returns NULL or a negative int instead of throwing. `pdf_decode.zig`
 * owns the handle table, the ABI and the pointer hygiene; this file owns MuPDF.
 *
 * The only other thing here is a `mkstemp` stub (bottom): wasi-libc lacks it,
 * MuPDF references it from a path we never take, and clang 21 makes an implicit
 * declaration a hard error.
 */

#include <mupdf/fitz.h>

#include <stdio.h> /* EOF, SEEK_CUR, SEEK_END — for the callback stream */
#include <stdlib.h>

/* Resource store cap. MuPDF's default (FZ_STORE_DEFAULT) is 256 MB, which is a
 * server number: it is the cache of decoded images/fonts, and on a page-at-a-time
 * browser viewer it buys almost nothing while being the one allocation that can
 * grow a wasm heap without bound. `mupdf.md` §9 measured 4 MB as enough to bound
 * a 1,450-page book; 16 MB leaves room for one large photographic page's
 * resources to survive a re-render at a new zoom. */
#define INK_STORE_LIMIT (16 << 20)

static fz_context *g_ctx;

/* Last MuPDF error message. The ABI's negative return codes say WHICH call
 * failed but not why, and "this PDF will not open" is exactly the report where
 * the reason matters (encrypted? truncated? unsupported filter?). MuPDF has the
 * sentence already; this keeps the most recent one for the browser to log. */
static char g_error[256];

static void ink_record_error(fz_context *ctx)
{
	const char *msg = fz_caught_message(ctx);
	size_t i = 0;

	if (!msg)
		msg = "unknown error";
	while (i + 1 < sizeof(g_error) && msg[i]) {
		g_error[i] = msg[i];
		i++;
	}
	g_error[i] = 0;
}

/* NUL-terminated; valid until the next failing call. Never NULL. */
const char *ink_shim_error(void)
{
	return g_error;
}

/* Lazily create the single context, with the document handlers registered.
 * Returns NULL if either step fails; callers must tolerate that. */
fz_context *ink_shim_context(void)
{
	if (g_ctx)
		return g_ctx;
	g_ctx = fz_new_context(NULL, NULL, INK_STORE_LIMIT);
	if (!g_ctx)
		return NULL;
	fz_try(g_ctx)
		fz_register_document_handlers(g_ctx);
	fz_catch(g_ctx)
	{
		ink_record_error(g_ctx);
		fz_drop_context(g_ctx);
		g_ctx = NULL;
	}
	return g_ctx;
}

/* Open a document from bytes the caller allocated with `ink_alloc` (= libc
 * `malloc`, which is also what MuPDF's default allocator frees with).
 *
 * OWNERSHIP: on every path this function consumes `data` — either the fz_buffer
 * takes it (and frees it when the document is dropped) or we free it here. The
 * caller must not touch `data` afterwards. Returns NULL if the bytes are not a
 * document we can open.
 *
 * The magic is the EMPTY STRING, not NULL: MuPDF rejects a NULL magic outright
 * ("missing file type", `document.c:449`), while an empty one means "no filename
 * hint, recognise by content" — which is what a memory-only ABI has to do, and
 * what lets one entry point serve PDF/EPUB/FB2/CBZ/XPS without the caller having
 * to classify the bytes first. */
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
	}
	fz_always(ctx)
		fz_drop_buffer(ctx, buf);
	fz_catch(ctx)
	{
		ink_record_error(ctx);
		free(data); /* non-NULL only if the buffer itself could not be made */
		return NULL;
	}
	return doc;
}

/* --- The callback stream (`docs/scratch/pdf-ranges.md` §4) ---------------- */

/* Fill `dst` with `len` bytes from `off`; return the count written, or <0.
 *
 * IMPORTED FROM JS. The two attributes are not decoration: without them wasm-ld
 * reports `undefined symbol: ink_host_read` and the link fails, because a plain
 * `extern` is a promise that some object file defines it, not a request for an
 * import. With them the module declares `(import "ink" "host_read" ...)`, which
 * every embedder must then supply — see `decoderImports` in `pdfDecode.ts`.
 *
 * On the JSPI path the JS side is wrapped in `WebAssembly.Suspending`, so this
 * ordinary-looking synchronous call MAY SUSPEND THE WHOLE WASM STACK and resume
 * when a `fetch` settles. That is safe inside `fz_try`: proven in
 * `pdf-ranges.md` §4.1 against this very module. */
__attribute__((import_module("ink"), import_name("host_read")))
extern int ink_host_read(long long off, unsigned char *dst, int len);

/* How much one `next` pulls. This is NOT the network block size — the block
 * cache in the worker owns that. It is the granularity of the JS<->wasm hop, so
 * it wants to be big enough that walking a 2 MB content stream is not 500 calls
 * and small enough that a seek-then-read-20-bytes does not memcpy a megabyte.
 * 32 KB is 64 hops per megabyte and 1/16th of a 512 KB block. */
#define INK_STREAM_CHUNK (32 * 1024)

typedef struct {
	long long total;   /* the document's length, from `NoteMeta.size` */
	long long pos;     /* the next byte the host will be asked for */
	long long win_off; /* file offset of `buf[0]` */
	int win_len;       /* valid bytes in `buf` */
	unsigned char buf[INK_STREAM_CHUNK];
} ink_stream_state;

/* `stm->pos` is the file offset of `wp` — the END of what is buffered — which is
 * what `fz_tell` subtracts `wp - rp` from. Getting that backwards silently
 * offsets every object in the file.
 *
 * The window is tracked in `win_off`/`win_len` RATHER THAN read back off
 * `rp`/`wp`, because MuPDF resets those (at EOF, and on the seek below) and we
 * would then have forgotten which bytes we are still holding. */
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
		/* `%ld`, NOT `%lld`: MuPDF has its own printf, and one `l` there already
		 * means 64 bits. `%lld` comes out as the literal "%ld" in the message. */
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

/* `fz_seek` resolves SEEK_CUR into an absolute offset before calling us, so in
 * practice this sees whence 0 and 2. All three are handled anyway — a stream
 * whose seek quietly mishandles a whence is a bug that shows up only on the one
 * document that uses it.
 *
 * THE IN-WINDOW CASE IS NOT AN OPTIMISATION WE COULD SKIP. `fz_seek` has no
 * fast path of its own (unlike `fz_read`), so a PDF parser walking an xref
 * table — seek, read a 20-byte entry, seek, read — would otherwise discard the
 * window on every entry and pull a fresh 32 KB chunk through the host for each
 * one. Same bytes and the same cache hit, but thousands of pointless copies:
 * the 688-byte fixture alone went from 7 host reads to 2. */
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

/* Open a document that pulls its bytes through `ink_host_read`. `total` is the
 * document's length, known up front (the file listing already carries it), so
 * MuPDF's seek-to-end-and-find-startxref costs no round trip of its own.
 *
 * NULL if the bytes at the front are not a document we can open — which on this
 * path also covers "the host could not read them". */
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
	}
	fz_always(ctx)
		fz_drop_stream(ctx, stm);
	fz_catch(ctx)
	{
		ink_record_error(ctx);
		fz_free(ctx, st); /* non-NULL only if `fz_new_stream` itself failed */
		return NULL;
	}
	return doc;
}

/* Page count, or -1 if the document refuses to report one. */
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

/* Page size in points. 0 on success, -1 on failure (`*w`/`*h` untouched). */
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

/* Render one page at `scale` into a fresh RGBA pixmap. NULL on failure.
 *
 * WHY THE PIXMAP IS CLEARED TO 0xFF RATHER THAN RENDERED WITHOUT ALPHA. The
 * ABI promises straight (non-premultiplied) RGBA, and MuPDF's alpha pixmaps are
 * premultiplied. Clearing to opaque white first makes every pixel fully opaque,
 * and premultiplied == straight exactly when alpha is 255 — so the browser gets
 * a buffer it can hand to `ImageData` unconverted, with no second copy to strip
 * premultiplication. It also matches what a PDF page *is*: ink on white paper. */
fz_pixmap *ink_shim_render(fz_document *doc, int number, float scale)
{
	fz_context *ctx = g_ctx;
	fz_page *page = NULL;
	fz_device *dev = NULL;
	fz_pixmap *pix = NULL;

	if (!ctx || !doc || !(scale > 0))
		return NULL;
	fz_var(page);
	fz_var(dev);
	fz_var(pix);
	fz_try(ctx)
	{
		fz_matrix ctm = fz_scale(scale, scale);
		fz_irect bbox;

		page = fz_load_page(ctx, doc, number);
		bbox = fz_round_rect(fz_transform_rect(fz_bound_page(ctx, page), ctm));
		pix = fz_new_pixmap_with_bbox(ctx, fz_device_rgb(ctx), bbox, NULL, 1);
		fz_clear_pixmap_with_value(ctx, pix, 0xff);
		dev = fz_new_draw_device(ctx, fz_identity, pix);
		fz_run_page(ctx, page, dev, ctm, NULL);
		fz_close_device(ctx, dev);
	}
	fz_always(ctx)
	{
		fz_drop_device(ctx, dev);
		fz_drop_page(ctx, page);
	}
	fz_catch(ctx)
	{
		ink_record_error(ctx);
		fz_drop_pixmap(ctx, pix);
		return NULL;
	}

	/* Force the alpha channel fully opaque.
	 *
	 * Clearing to white above makes the page opaque in principle, but MuPDF's
	 * 8-bit compositing rounds: on real documents a few thousand pixels out of
	 * two million come back with alpha 254, not 255. That is invisible, yet it
	 * is the difference between "premultiplied and straight RGBA are the same
	 * buffer" and "they differ by a rounding error" — and the ABI promises
	 * straight. One pass over the alpha bytes buys the promise outright; the
	 * residual colour error is the 1/255 the premultiply already lost. */
	{
		unsigned char *row = pix->samples;
		int y, x;

		for (y = 0; y < pix->h; y++) {
			for (x = 0; x < pix->w; x++)
				row[x * 4 + 3] = 255;
			row += pix->stride;
		}
	}
	return pix;
}

/* Pixmap accessors: `fz_pixmap` is opaque to Zig, so its fields are read here. */
unsigned char *ink_shim_pixmap_samples(fz_pixmap *pix) { return pix->samples; }
int ink_shim_pixmap_width(fz_pixmap *pix) { return pix->w; }
int ink_shim_pixmap_height(fz_pixmap *pix) { return pix->h; }
int ink_shim_pixmap_components(fz_pixmap *pix) { return pix->n; }
int ink_shim_pixmap_stride(fz_pixmap *pix) { return (int)pix->stride; }

void ink_shim_drop_pixmap(fz_pixmap *pix)
{
	if (g_ctx)
		fz_drop_pixmap(g_ctx, pix);
}

void ink_shim_drop_document(fz_document *doc)
{
	if (g_ctx)
		fz_drop_document(g_ctx, doc);
}

/* Drop everything cached that is not currently referenced. Called after the
 * last document closes, so a viewer that opened one big book does not keep its
 * decoded images resident for the rest of the tab's life. */
void ink_shim_shrink_store(void)
{
	if (g_ctx)
		fz_shrink_store(g_ctx, 0);
}

/* --- JPX stubs (upstream bug workaround) --------------------------------- */

/* MuPDF 1.28.1's `source/fitz/load-jpx.c` has a real bug: its
 * `FZ_ENABLE_JPX == 0` stub for `fz_load_jpx_info` is missing the trailing
 * `fz_colorspace *defcs` parameter that the declaration in `image-imp.h` — and
 * the enabled definition — both have. On x86 the extra argument is harmlessly
 * ignored; on wasm, `wasm-ld` sees the signature mismatch and substitutes a
 * TRAPPING stub, so a JPX-bearing PDF would abort the module instead of raising
 * `FZ_ERROR_UNSUPPORTED`. Zig additionally refuses to link through the warning.
 *
 * `load-jpx.c` is therefore excluded from the build (`build.zig`) and its two
 * disabled-path stubs are supplied here with the CORRECT signatures. MuPDF stays
 * unpatched, and a JPX image degrades to "unsupported" the way it was meant to.
 * Worth reporting upstream; the fix there is one line. */

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

/* --- wasi-libc gap ------------------------------------------------------- */

/* MuPDF calls `mkstemp` only from the temporary-file path used when writing
 * output documents; the viewer never writes. wasi-libc has no filesystem-creating
 * `mkstemp`, so this stub keeps the module linkable and fails honestly if it
 * were ever reached. */
int mkstemp(char *template)
{
	(void)template;
	return -1;
}
