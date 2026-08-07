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
#include <mupdf/pdf.h> /* the export path builds a PDF, not just reads one */

#include <stdio.h> /* EOF, SEEK_CUR, SEEK_END — for the callback stream */
#include <stdlib.h>
#include <string.h> /* strlen, for the ink's content-stream fragment */

/* Resource store cap. MuPDF's default (FZ_STORE_DEFAULT) is 256 MB, which is a
 * server number: it is the cache of decoded images/fonts, and on a page-at-a-time
 * browser viewer it buys almost nothing while being the one allocation that can
 * grow a wasm heap without bound. as enough to bound
 * a 1,450-page book; 16 MB leaves room for one large photographic page's
 * resources to survive a re-render at a new zoom. */
#define INK_STORE_LIMIT (16 << 20)

static fz_context *g_ctx;

/* Last MuPDF error message. The ABI's negative return codes say WHICH call
 * failed but not why, and "this PDF will not open" is exactly the report where
 * the reason matters (encrypted? truncated? unsupported filter?). MuPDF has the
 * sentence already; this keeps the most recent one for the browser to log. */
static char g_error[256];

static void ink_set_error(const char *msg)
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

/* Only valid inside an `fz_catch` — `fz_caught_message` reads the context's
 * current exception. A refusal we decide ourselves (see `ink_shim_export_page`,
 * which turns down anything that is not a PDF) goes through `ink_set_error`
 * instead, so the browser gets a sentence either way. */
static void ink_record_error(fz_context *ctx)
{
	ink_set_error(fz_caught_message(ctx));
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

/* --- The callback stream ------------------------------------------------- */

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
 * when a `fetch` settles. That is safe inside `fz_try`: proven
 * against this very module. */
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

/* --- Links on a page ------------------------------------------------------ */

/* WHY JSON AND NOT A PACKED STRUCT ARRAY. A page carries a handful of records
 * whose only interesting field is a VARIABLE-LENGTH STRING, and this project
 * already moves JSON across boundaries where the shape is irregular (LAYERINFO,
 * RECOGNTEXT and HIGHLIGHTINFO are all base64 JSON inside the container itself).
 * A binary record format plus a string blob would be more code on both sides for
 * a payload measured in hundreds of bytes.
 *
 * A URI THAT IS NOT http/https/mailto NEVER APPEARS HERE. The uri is
 * attacker-controlled text out of a file that arrived by device sync, and
 * `javascript:` above all — but also `file:` and `data:` — has no business
 * becoming a link. It is DROPPED rather than emitted with a flag, so nothing
 * downstream can forget to check. The client refuses the same set again before
 * it builds an `<a href>`; the duplication is deliberate, because these are two
 * different trust boundaries and the browser only ever sees the second one.
 */

/* Longer than this and the link is dropped rather than truncated: a truncated
 * URI is a link that goes somewhere other than where it says, which is worse
 * than no link. Real http URLs do not approach this. */
#define INK_MAX_URI 4096

/* Rects come out of a file we did not write. An infinite one (`fz_infinite_rect`
 * is what a malformed /Rect degrades to) would reach the client as a box the
 * size of the universe, and MuPDF's own float formatter turns a NaN into 0 and
 * an infinity into FLT_MAX rather than refusing — so the refusing happens here.
 * 1e6 pt is 350 metres; the largest page PDF allows is 14400. */
static int ink_finite(float v)
{
	return v > -1e6f && v < 1e6f;
}

/* Append `v` as a JSON number.
 *
 * NOT `%g`, AND THIS IS NOT A STYLE PREFERENCE. MuPDF has its own printf, and
 * its `fmtfloat` (`source/fitz/printf.c`) writes 0.5 as `.5` — which C's printf
 * would never do and which JSON.parse rejects outright. One link rect with a
 * half-point edge would make the whole page's payload unparseable. So the number
 * is written here: a sign, an integer part, and at most three decimals. A
 * thousandth of a point is 0.35 microns, which is far below anything a rect
 * needs to be right about. */
static void ink_json_number(fz_context *ctx, fz_buffer *out, float v)
{
	int neg = v < 0;
	long long scaled = (long long)((neg ? -v : v) * 1000.0f + 0.5f);
	long long whole = scaled / 1000;
	int frac = (int)(scaled % 1000);
	char digits[24];
	int n = 0;

	if (neg && scaled != 0)
		fz_append_byte(ctx, out, '-');
	if (whole == 0) {
		fz_append_byte(ctx, out, '0');
	} else {
		while (whole > 0 && n < (int)sizeof(digits)) {
			digits[n++] = (char)('0' + (int)(whole % 10));
			whole /= 10;
		}
		while (n > 0)
			fz_append_byte(ctx, out, digits[--n]);
	}
	if (frac != 0) {
		/* Trailing zeros are legal JSON but noise on the wire, and the payload
		 * is read by a human as often as by a parser. `10.5`, not `10.500`. */
		fz_append_byte(ctx, out, '.');
		fz_append_byte(ctx, out, (char)('0' + frac / 100));
		if (frac % 100 != 0) {
			fz_append_byte(ctx, out, (char)('0' + (frac / 10) % 10));
			if (frac % 10 != 0)
				fz_append_byte(ctx, out, (char)('0' + frac % 10));
		}
	}
}

/* Append `s` as a JSON string literal.
 *
 * Escapes the two characters JSON reserves and every C0 control, which is what
 * keeps a hostile uri from closing the string and writing its own fields. Bytes
 * at or above 0x80 pass through: MuPDF hands back UTF-8 (a /URI is read with
 * `pdf_to_text_string`), and anything malformed becomes U+FFFD in the browser's
 * `TextDecoder` rather than breaking the parse. */
static void ink_json_string(fz_context *ctx, fz_buffer *out, const char *s)
{
	static const char hex[] = "0123456789abcdef";

	fz_append_byte(ctx, out, '"');
	for (; *s; s++) {
		unsigned char c = (unsigned char)*s;
		if (c == '"' || c == '\\') {
			fz_append_byte(ctx, out, '\\');
			fz_append_byte(ctx, out, (char)c);
		} else if (c < 0x20 || c == 0x7f) {
			fz_append_string(ctx, out, "\\u00");
			fz_append_byte(ctx, out, hex[(c >> 4) & 15]);
			fz_append_byte(ctx, out, hex[c & 15]);
		} else {
			fz_append_byte(ctx, out, (char)c);
		}
	}
	fz_append_byte(ctx, out, '"');
}

/* Is `uri`'s scheme one a viewer may follow? http, https, mailto and nothing
 * else — see the section header. Case-insensitive, because a scheme is, and
 * anchored at byte zero, so a leading space or a `\njavascript:` cannot sneak
 * past the way it can past a naive "contains". */
static int ink_allowed_scheme(const char *uri)
{
	static const char *const allowed[] = { "http://", "https://", "mailto:" };
	size_t i, j;

	for (i = 0; i < sizeof(allowed) / sizeof(allowed[0]); i++) {
		for (j = 0; allowed[i][j]; j++) {
			char c = uri[j];
			if (c >= 'A' && c <= 'Z')
				c = (char)(c - 'A' + 'a');
			if (c != allowed[i][j])
				break; /* stops at the NUL too — never reads past it */
		}
		if (allowed[i][j] == 0)
			return 1;
	}
	return 0;
}

/* The links on `number`, as a UTF-8 JSON array. NULL on failure.
 *
 *     [{"x":72,"y":118.5,"w":180,"h":12,"page":11,"uri":"#page=12"}]
 *
 * `x,y,w,h` are in THE SAME SPACE `ink_shim_page_size` reports — top-left
 * origin, y down, points — so the client's whole transform is one uniform
 * scale. Two things have to be true for that, and both are load-bearing:
 *
 *  1. THE BOX ORIGIN. `ink_shim_page_size` hands over `fz_bound_page`'s EXTENT
 *     and throws its origin away, so a page whose box does not start at (0,0)
 *     would put link rects in a space the client has never heard of.
 *     `box.x0`/`box.y0` are subtracted here so the two agree BY CONSTRUCTION.
 *     For a PDF this is arithmetic on zero — `pdf_page_obj_transform_box`
 *     translates the crop box's corner to the origin, under a comment reading
 *     "Always use CropBox to set origin to top left" — but `fz_bound_page` is a
 *     document-type-agnostic call and nothing promises that of an EPUB or an
 *     XPS page. Agreeing by luck is how the export put ink ninety degrees out.
 *
 *  2. ROTATION. `fz_bound_page` reports the TRANSFORMED box, and
 *     `pdf_load_link_annots` (`source/pdf/pdf-link.c:768`) builds link rects
 *     through the very same `pdf_page_transform`. So a /Rotate 90 page reports
 *     its rotated extent and its links land in that rotated space. Verified on
 *     a fixture rather than reasoned about (`pdf_decode_abi.mjs`).
 *
 * `page` is the resolved 0-based target of an INTERNAL link, or -1 for an
 * external one. Resolved HERE, with `fz_resolve_link`, because this is where the
 * document is; making the client resolve would be a round trip per link.
 *
 * A link is DROPPED — never emitted degraded — when its uri is empty, longer
 * than `INK_MAX_URI`, of a scheme we will not follow, or (for an internal one)
 * points at a page that does not resolve; and when its rect is empty or not
 * finite. An empty page answers `[]`.
 *
 * ON THE STREAMED PATH THIS CAN SUSPEND: loading the page and resolving a
 * destination both walk the xref, which pulls through `ink_host_read`. Same
 * proven arrangement as everything else here — no Zig frame inside the `fz_try`.
 */
fz_buffer *ink_shim_page_links(fz_document *doc, int number)
{
	fz_context *ctx = g_ctx;
	fz_page *page = NULL;
	fz_link *links = NULL;
	fz_buffer *out = NULL;

	if (!ctx || !doc || number < 0)
		return NULL;
	fz_var(page);
	fz_var(links);
	fz_var(out);
	fz_try(ctx)
	{
		fz_link *link;
		fz_rect box;
		int first = 1;

		out = fz_new_buffer(ctx, 256);
		page = fz_load_page(ctx, doc, number);
		box = fz_bound_page(ctx, page);
		links = fz_load_links(ctx, page);
		fz_append_byte(ctx, out, '[');
		for (link = links; link; link = link->next) {
			float x = link->rect.x0 - box.x0;
			float y = link->rect.y0 - box.y0;
			float w = link->rect.x1 - link->rect.x0;
			float h = link->rect.y1 - link->rect.y0;
			int target = -1;

			if (!link->uri || !link->uri[0])
				continue;
			if (strlen(link->uri) > INK_MAX_URI)
				continue;
			if (!(w > 0) || !(h > 0))
				continue;
			if (!ink_finite(x) || !ink_finite(y) || !ink_finite(w) || !ink_finite(h))
				continue;
			if (fz_is_external_link(ctx, link->uri)) {
				if (!ink_allowed_scheme(link->uri))
					continue;
			} else {
				fz_location loc = fz_resolve_link(ctx, doc, link->uri, NULL, NULL);
				if (loc.chapter < 0 || loc.page < 0)
					continue;
				target = fz_page_number_from_location(ctx, doc, loc);
				if (target < 0)
					continue;
			}

			if (!first)
				fz_append_byte(ctx, out, ',');
			first = 0;
			fz_append_string(ctx, out, "{\"x\":");
			ink_json_number(ctx, out, x);
			fz_append_string(ctx, out, ",\"y\":");
			ink_json_number(ctx, out, y);
			fz_append_string(ctx, out, ",\"w\":");
			ink_json_number(ctx, out, w);
			fz_append_string(ctx, out, ",\"h\":");
			ink_json_number(ctx, out, h);
			fz_append_printf(ctx, out, ",\"page\":%d,\"uri\":", target);
			ink_json_string(ctx, out, link->uri);
			fz_append_byte(ctx, out, '}');
		}
		fz_append_byte(ctx, out, ']');
	}
	fz_always(ctx)
	{
		fz_drop_link(ctx, links);
		fz_drop_page(ctx, page);
	}
	fz_catch(ctx)
	{
		ink_record_error(ctx);
		fz_drop_buffer(ctx, out);
		return NULL;
	}
	return out;
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

/* --- Structure-preserving single-page export ----------------------------- */

/* Export ONE page as a one-page PDF holding the ORIGINAL page plus our ink.
 *
 * WHY THIS EXISTS BESIDE `webapp/src/export/pdf.ts`. That writer rasterises: it
 * emits a new document made of grayscale images at A4 width. The pixels are
 * right and the text layer it fakes is searchable, but the page's real text is
 * gone, its vectors are gone, and its geometry has been replaced by "A4 wide,
 * aspect preserved". `pdf_graft_page` instead deep-copies the page's own
 * /Contents, /Resources and boxes into a fresh document, so what comes out is
 * the publisher's page — selectable text, embedded fonts, vectors, page size —
 * with the `.mark` ink drawn over it.
 *
 * KNOWN LIMITATION: /Annots ARE SILENTLY DROPPED. `pdf_graft_mapped_page`
 * (`source/pdf/pdf-graft.c`) copies a fixed list and nothing else: /Contents,
 * /Resources, /MediaBox, /CropBox, /BleedBox, /TrimBox, /ArtBox, /Rotate,
 * /UserUnit. So LINKS, form fields and any highlights the source PDF already
 * carried do not survive into the exported page, and neither does a page-level
 * /Group (transparency group). That is defensible — an /Annot can reference
 * other pages, which a one-page document no longer has — but it is a real loss
 * and nothing in the file warns about it, so it is stated here. OUR ink is not
 * affected: it goes into the content stream, not into an annotation.
 */

/* Build the ink as an image XObject in `dst`. Returns a reference the caller
 * must `pdf_drop_obj`. `alpha` is w*h coverage bytes, 255 = full ink.
 *
 * /DEVICEGRAY + AN 8-BIT /SMASK, NOT A 1-BIT /IMAGEMASK. A stencil mask is the
 * obvious encoding for "black ink or nothing" and is about ten times smaller —
 * but the real ink is anti-aliased with 16 grey levels, and at export resolution
 * a stencil is visibly staircased. That would be a REGRESSION against the
 * rasterising exporter that ships today. So: an all-black image whose /SMask
 * carries the coverage.
 *
 * WHAT IT COSTS, deflated: ~7.6 KB over the bare page on a real annotated page,
 * and 29.9 KB on a synthetic worst case (1240x1754 coverage — A4 at 150 dpi —
 * with 150,000 pixels inked by 30 full-width feathered strokes). It scales with
 * how much was written, and both ends of that are small beside the page.
 *
 * THE BLACK PLANE IS 1 BIT PER COMPONENT, THE MASK IS 8. Both are w x h, which
 * matters: a /SMask whose dimensions differ from the base image's is resampled
 * to them, so a cheap 1x1 black base would throw the ink's resolution away.
 * Keeping the dimensions equal and shrinking the base's DEPTH instead costs
 * w*h/8 transient bytes rather than w*h — 329 KB instead of 2.6 MB on a
 * 1404x1872 page — and all-zero 1-bit DeviceGray samples are black under the
 * default /Decode, so the result is identical. Both streams deflate to almost
 * nothing at write time (`do_compress_images`), so the file is the same size.
 */
static pdf_obj *ink_shim_add_ink_image(fz_context *ctx, pdf_document *dst,
	const unsigned char *alpha, int w, int h)
{
	size_t plane = (size_t)((w + 7) / 8) * (size_t)h;
	size_t coverage = (size_t)w * (size_t)h;
	unsigned char *black_bytes = NULL;
	fz_buffer *black = NULL;
	fz_buffer *soft = NULL;
	pdf_obj *image = NULL;
	pdf_obj *mask = NULL;

	fz_var(black_bytes);
	fz_var(black);
	fz_var(soft);
	fz_var(image);
	fz_var(mask);
	fz_try(ctx)
	{
		black_bytes = fz_calloc(ctx, plane, 1);
		black = fz_new_buffer_from_data(ctx, black_bytes, plane);
		black_bytes = NULL; /* the buffer owns it now */
		soft = fz_new_buffer_from_copied_data(ctx, alpha, coverage);

		mask = pdf_add_new_dict(ctx, dst, 6);
		pdf_dict_put(ctx, mask, PDF_NAME(Type), PDF_NAME(XObject));
		pdf_dict_put(ctx, mask, PDF_NAME(Subtype), PDF_NAME(Image));
		pdf_dict_put_int(ctx, mask, PDF_NAME(Width), w);
		pdf_dict_put_int(ctx, mask, PDF_NAME(Height), h);
		pdf_dict_put_int(ctx, mask, PDF_NAME(BitsPerComponent), 8);
		pdf_dict_put(ctx, mask, PDF_NAME(ColorSpace), PDF_NAME(DeviceGray));
		pdf_update_stream(ctx, dst, mask, soft, 0);

		image = pdf_add_new_dict(ctx, dst, 7);
		pdf_dict_put(ctx, image, PDF_NAME(Type), PDF_NAME(XObject));
		pdf_dict_put(ctx, image, PDF_NAME(Subtype), PDF_NAME(Image));
		pdf_dict_put_int(ctx, image, PDF_NAME(Width), w);
		pdf_dict_put_int(ctx, image, PDF_NAME(Height), h);
		pdf_dict_put_int(ctx, image, PDF_NAME(BitsPerComponent), 1);
		pdf_dict_put(ctx, image, PDF_NAME(ColorSpace), PDF_NAME(DeviceGray));
		pdf_dict_put(ctx, image, PDF_NAME(SMask), mask);
		pdf_update_stream(ctx, dst, image, black, 0);
	}
	fz_always(ctx)
	{
		fz_free(ctx, black_bytes); /* non-NULL only if the buffer could not be made */
		fz_drop_buffer(ctx, black);
		fz_drop_buffer(ctx, soft);
		pdf_drop_obj(ctx, mask);
	}
	fz_catch(ctx)
	{
		pdf_drop_obj(ctx, image);
		fz_rethrow(ctx);
	}
	return image;
}

/* Add `text` to `dst` as a content stream object. Returns a reference the caller
 * must drop (or push with `pdf_array_push_drop`). Uncompressed: `do_compress`
 * deflates it at write time, and these fragments are a few dozen bytes. */
static pdf_obj *ink_shim_add_ops(fz_context *ctx, pdf_document *dst, const char *text)
{
	fz_buffer *buf = fz_new_buffer_from_copied_data(ctx,
		(const unsigned char *)text, strlen(text));
	pdf_obj *obj = NULL;

	fz_try(ctx)
		obj = pdf_add_stream(ctx, dst, buf, NULL, 0);
	fz_always(ctx)
		fz_drop_buffer(ctx, buf);
	fz_catch(ctx)
		fz_rethrow(ctx);
	return obj;
}

/* The XObject name the ink is drawn through, for page `number`.
 *
 * PER-PAGE, AND THAT IS NOT COSMETIC. A page's /Resources dictionary is
 * frequently SHARED between pages — one real document gives all 26 of its pages
 * the same object (see the write options below) — so a fixed `/InkholdInk` would
 * have page 7's ink OVERWRITE page 3's entry in the dictionary they share, and
 * page 3's content stream, still saying `/InkholdInk Do`, would then draw page
 * 7's handwriting. Invisible on the single-page export, which touches one page;
 * fatal on the whole-document one, which touches seven.
 *
 * `dst` must have room for ~24 bytes.
 */
static void ink_shim_xobject_name(char *dst, size_t len, int number)
{
	fz_snprintf(dst, len, "InkholdInk%d", number);
}

/* Put the ink into the page's own /Contents, as `[ (q) original… (Q + ink) ]`.
 *
 * A CONTENT STREAM RATHER THAN AN ANNOTATION. Both were prototyped and they
 * render identically, so the tie-breakers are what a viewer can do to them: an
 * annotation can be hidden by a "show/hide annotations" toggle, may not print
 * depending on its flags, and is discarded by anything that flattens. Ink the
 * user drew is part of the page, so it goes in the page.
 *
 * THE BRACKETING `q`/`Q` protects the ink from whatever graphics state the
 * original content leaves behind — a stray `cm`, a clip, a non-default blend
 * mode — because the ink's `cm` below is RELATIVE to the CTM in force when it
 * runs. It covers one level of imbalance, which is what a stream that forgets a
 * `Q` produces; `do_sanitize` (see the write options) re-parses and rebalances
 * the concatenation on the way out, which covers the rest. The bulletproof
 * variant is to wrap the original in a Form XObject, whose `Do` saves and
 * restores unconditionally — it was not taken because it means decompressing and
 * concatenating the original content into one buffer (heap we would rather not
 * spend) and because the array form is what was verified end to end. If ink ever
 * turns up displaced on a real document, that is the thing to try.
 *
 * PDF concatenates the streams of a /Contents array into ONE stream, with
 * whitespace between them, so splitting our additions into their own objects
 * costs nothing and leaves the original's bytes untouched and unparsed. */
static void ink_shim_wrap_contents(fz_context *ctx, pdf_document *dst,
	pdf_obj *page_obj, pdf_obj *image, const char *name, const char *tail)
{
	pdf_obj *resources;
	pdf_obj *xobjects;
	pdf_obj *old;
	pdf_obj *contents = NULL;

	/* INHERITABLE, not `pdf_dict_get`. /Resources is one of the five keys a page
	 * may inherit from its /Pages node, and a great many real documents put it
	 * there once rather than on every page. Reading only the page's own key
	 * finds nothing on those, and the `put_dict` below then writes an EMPTY
	 * /Resources onto the page — which does not merely fail to help, it SHADOWS
	 * the inherited one, and the page's original text loses every font it was
	 * using. */
	resources = pdf_dict_get_inheritable(ctx, page_obj, PDF_NAME(Resources));
	if (!pdf_is_dict(ctx, resources))
		resources = pdf_dict_put_dict(ctx, page_obj, PDF_NAME(Resources), 2);
	xobjects = pdf_dict_get(ctx, resources, PDF_NAME(XObject));
	if (!pdf_is_dict(ctx, xobjects))
		xobjects = pdf_dict_put_dict(ctx, resources, PDF_NAME(XObject), 1);
	pdf_dict_puts(ctx, xobjects, name, image);

	old = pdf_dict_get(ctx, page_obj, PDF_NAME(Contents));
	fz_var(contents);
	fz_try(ctx)
	{
		contents = pdf_new_array(ctx, dst, 4);
		pdf_array_push_drop(ctx, contents, ink_shim_add_ops(ctx, dst, "q\n"));
		/* The old streams are pushed BEFORE /Contents is replaced: pushing keeps
		 * a reference, and the only one holding them until then is `page_obj`. */
		if (pdf_is_array(ctx, old)) {
			int i, n = pdf_array_len(ctx, old);
			for (i = 0; i < n; i++)
				pdf_array_push(ctx, contents, pdf_array_get(ctx, old, i));
		} else if (old) {
			pdf_array_push(ctx, contents, old);
		}
		pdf_array_push_drop(ctx, contents, ink_shim_add_ops(ctx, dst, tail));
		pdf_dict_put(ctx, page_obj, PDF_NAME(Contents), contents);
	}
	fz_always(ctx)
		pdf_drop_obj(ctx, contents);
	fz_catch(ctx)
		fz_rethrow(ctx);
}

/* Draw `alpha` onto page `number` of the ALREADY-OPEN `doc`, in place.
 *
 * The whole of the ink work, shared by the two export routes: the single-page
 * one draws onto page 0 of the fresh document it grafted into, the incremental
 * one draws onto page N of the document the user opened. Throws on failure.
 *
 * `a`..`f` map the ALPHA IMAGE'S OWN PIXEL SPACE — (0,0) at its top-left pixel,
 * (w,h) at its bottom-right, y downwards — onto the page in DISPLAY SPACE, the
 * top-left-origin cropped-and-rotated box the viewer already draws in.
 */
static void ink_shim_draw_ink(fz_context *ctx, pdf_document *doc, int number,
	const unsigned char *alpha, int w, int h,
	float a, float b, float c, float d, float e, float f)
{
	pdf_obj *image = NULL;
	pdf_page *page = NULL;

	fz_var(image);
	fz_var(page);
	fz_try(ctx)
	{
		fz_rect box;
		fz_matrix display, unit, place;
		char name[24];
		char tail[256];

		image = ink_shim_add_ink_image(ctx, doc, alpha, w, h);

		/* PLACEMENT, AND THE BUG IT EXISTS TO AVOID. A content stream is written
		 * in the page's UNROTATED, MediaBox-origin user space. Every coordinate
		 * the viewer — and therefore the caller — works in is display space: the
		 * CROPPED, ROTATED box `fz_bound_page` reports, y downwards. Placing the
		 * ink naively drew it 90 degrees out on a `/Rotate 90` page, and it would
		 * also have been offset on any page whose /CropBox or /MediaBox does not
		 * start at the origin. `pdf_page_transform_box` produces exactly the
		 * matrix MuPDF applies when it renders, so its INVERSE takes display
		 * space back to user space, and all three cases fall out of the one call.
		 *
		 * FZ_CROP_BOX IS DOCUMENTATION HERE, NOT A CHOICE. Read
		 * `pdf_page_obj_transform_box` (`source/pdf/pdf-page.c`): the box
		 * argument selects only the RECT it hands back, and the matrix is built
		 * under a comment reading "Always use CropBox to set origin to top left".
		 * Passing FZ_MEDIA_BOX yields a different `box` and an IDENTICAL `place`.
		 * So the crop box is what display space is anchored to whatever we ask
		 * for — which is also what `fz_bound_page`, and therefore `ink_render`
		 * and `ink_page_size`, already agree on. Naming it keeps the call site
		 * honest about which box the ink is being placed against.
		 *
		 * `unit` is the other half: `Do` paints an image into the UNIT SQUARE
		 * with the image's first row along the top edge, so a caller who thinks
		 * in image pixels needs (u,v) -> (u*w, (1-v)*h) in front of their matrix.
		 * MuPDF's `fz_concat(A, B)` means "A, then B". */
		page = pdf_load_page(ctx, doc, number);
		pdf_page_transform_box(ctx, page, &box, &place, FZ_CROP_BOX);
		display = fz_make_matrix(a, b, c, d, e, f);
		unit = fz_make_matrix((float)w, 0, 0, -(float)h, 0, (float)h);
		place = fz_concat(fz_concat(unit, display), fz_invert_matrix(place));

		ink_shim_xobject_name(name, sizeof(name), number);
		fz_snprintf(tail, sizeof(tail),
			"Q\nq %g %g %g %g %g %g cm /%s Do Q\n",
			place.a, place.b, place.c, place.d, place.e, place.f, name);
		ink_shim_wrap_contents(ctx, doc, pdf_lookup_page_obj(ctx, doc, number),
			image, name, tail);
	}
	fz_always(ctx)
	{
		pdf_drop_page(ctx, page);
		pdf_drop_obj(ctx, image);
	}
	fz_catch(ctx)
		fz_rethrow(ctx);
}

/* Export page `number` of `doc` as a one-page PDF with `alpha` (w*h coverage
 * bytes) drawn over it. `a`..`f` map the ALPHA IMAGE'S OWN PIXEL SPACE — (0,0)
 * at its top-left pixel, (w,h) at its bottom-right, y downwards — onto the page
 * in DISPLAY SPACE, the top-left-origin cropped-and-rotated box the viewer
 * already draws in. Covering the whole page is therefore `pageW/w, 0, 0,
 * pageH/h, 0, 0`. Returns a buffer the caller must drop, or NULL (message in
 * `ink_shim_error`).
 *
 * ON THE STREAMED PATH THIS CAN SUSPEND: the graft reads the source document,
 * which pulls through `ink_host_read`. That is the same proven arrangement as
 * everything else here — no Zig frame is on the stack inside the `fz_try`.
 */
fz_buffer *ink_shim_export_page(fz_document *doc, int number,
	const unsigned char *alpha, int w, int h,
	float a, float b, float c, float d, float e, float f)
{
	fz_context *ctx = g_ctx;
	pdf_document *src;
	pdf_document *dst = NULL;
	fz_buffer *out_buf = NULL;
	fz_output *out = NULL;

	if (!ctx || !doc || !alpha || w <= 0 || h <= 0)
		return NULL;

	/* REFUSE ANYTHING THAT IS NOT A PDF. `pdf_specifics` answers NULL for EPUB,
	 * CBZ, XPS and friends, and there is no page to graft out of a document that
	 * has no PDF objects. The caller's fallback is the rasterising exporter, and
	 * it needs a sentence to show for why. */
	src = pdf_specifics(ctx, doc);
	if (!src) {
		ink_set_error("only a PDF can be exported with its page structure intact");
		return NULL;
	}

	fz_var(dst);
	fz_var(out_buf);
	fz_var(out);
	fz_try(ctx)
	{
		pdf_write_options opts = pdf_default_write_options;

		dst = pdf_create_document(ctx);
		pdf_graft_page(ctx, dst, 0, src, number);
		ink_shim_draw_ink(ctx, dst, 0, alpha, w, h, a, b, c, d, e, f);

		/* WRITE OPTIONS, AND WHY THE CLEANING IS NOT OPTIONAL. `do_clean` +
		 * `do_sanitize` re-parse every content stream and rebuild each one's
		 * /Resources from what it actually references; `do_garbage = 3` then
		 * drops whatever that detached and de-duplicates the rest.
		 *
		 * That matters because a page's /Resources are frequently SHARED. One
		 * real document gives all 26 pages the same dictionary, so grafting a
		 * single page dragged the whole document's fonts with it: 175 KB, cut to
		 * 53 KB by the cleaning, pixel-identical either way. A synthetic case —
		 * two pages sharing a resource dict with two fat form XObjects, one of
		 * them unused by the page being exported — pins down which option does
		 * what:
		 *
		 *     compress only .................... 20,547 B
		 *     + garbage 3, no clean/sanitize ... 20,547 B  (nothing to collect:
		 *                                        the copied /Resources still
		 *                                        references the unused form)
		 *     + clean/sanitize, no garbage ..... 20,724 B  (BIGGER)
		 *     all three ........................ 10,724 B
		 *
		 * So: TAKE ALL THREE OR NONE. Cleaning alone rewrites tidy content into
		 * longer equivalents and has nothing to prune; collecting alone finds
		 * nothing unreferenced. Only together do they pay. */
		opts.do_compress = 1;
		opts.do_compress_images = 1;
		opts.do_compress_fonts = 1;
		opts.do_clean = 1;
		opts.do_sanitize = 1;
		opts.do_garbage = 3;

		out_buf = fz_new_buffer(ctx, 8192);
		out = fz_new_output_with_buffer(ctx, out_buf);
		pdf_write_document(ctx, dst, out, &opts);
		fz_close_output(ctx, out);
	}
	fz_always(ctx)
	{
		fz_drop_output(ctx, out);
		pdf_drop_document(ctx, dst);
	}
	fz_catch(ctx)
	{
		ink_record_error(ctx);
		fz_drop_buffer(ctx, out_buf);
		return NULL;
	}
	return out_buf;
}

/* --- Whole-document export, as an INCREMENTAL UPDATE --------------------- */

/* WHY THIS IS NOT "LOOP THE ONE ABOVE". `pdf_graft_page` silently drops
 * /Annots, so grafting all 77 pages of a document would lose every link and
 * highlight the original carried, 77 times over. An incremental update instead
 * keeps the ORIGINAL FILE'S BYTES VERBATIM and appends only the objects that
 * changed: nothing is re-encoded, so the export keeps its text, vectors,
 * bookmarks, forms, metadata, structure tree AND its own annotations. The bigger
 * export is the one that loses less.
 *
 * It is also the only shape that fits the memory budget. What comes back here is
 * the DELTA ALONE — typically tens of kilobytes — and the browser concatenates
 * it onto the original with `new Blob([original, delta])`, which is disk-backed:
 * a 76 MB document is exported without a single megabyte of it entering the JS
 * heap or this one.
 *
 * THREE THINGS MuPDF WILL NOT DO FOR US ON THIS PATH, all verified in
 * `source/pdf/pdf-write.c` and all handled by `ink_shim_incremental_refusal`:
 *
 *  1. `pdf_write_document` (2896) LACKS the `!doc->file` guard that
 *     `pdf_save_document` (2953) has, so writing incrementally from a document
 *     with no backing file produces a bad delta SILENTLY. We check it ourselves.
 *  2. `opts.bias` is never set on the `pdf_write_document` path AND CANNOT BE
 *     SET FROM OUTSIDE. `pdf_save_document` assigns it at 3009 (`opts.bias =
 *     doc->bias`, under `if (do_incremental)`) — but that `opts` is the internal
 *     `pdf_write_state`, not the `pdf_write_options` a caller hands in. For a
 *     file with junk before `%PDF-` every xref offset in the delta would be
 *     written unbiased and point at the wrong byte. `doc->bias` is public, so we
 *     read it and refuse. Detectable, not fixable, and MuPDF stays unpatched.
 *  3. MuPDF itself refuses incremental on a REPAIRED file, with `do_garbage`,
 *     and with any encryption change. The repair case is pre-empted here so the
 *     refusal arrives BEFORE any page is mutated; the other two are simply not
 *     asked for. `do_clean`/`do_sanitize`/`do_garbage` — which the single-page
 *     export needs, because grafting drags shared resources along — are neither
 *     available nor wanted here: nothing is grafted, so nothing is duplicated.
 *
 * Each refusal is a sentence the UI can show. Falling back to grafting every
 * page is NOT an option: that is the exact fidelity loss this route exists to
 * avoid, and doing it silently would be worse than not offering the row.
 */

/* Why `src` cannot take an incremental update, or NULL if it can. */
static const char *ink_shim_incremental_refusal(pdf_document *src)
{
	if (!src->file)
		return "this PDF has no original file to append to";
	if (src->repair_attempted)
		return "this PDF had to be repaired to open, so it cannot be updated in place";
	if (src->bias != 0)
		return "this PDF has junk before its %PDF- header, which would misplace every offset";
	return NULL;
}

/* The output the delta is written through: absolute file positions in, only the
 * bytes at or after `base` kept.
 *
 * WHY NOT `fz_new_output_with_buffer`. Because of what MuPDF does FIRST on an
 * incremental write: `do_pdf_save_document` calls
 * `ensure_initial_incremental_contents(ctx, doc->file, out, doc->file_size)`,
 * whose contract is that the output must ALREADY CONTAIN the original file. It
 * checks by reading the output back through `fz_stream_from_output`, and a
 * buffer output has no `as_stream`, so it takes the other branch and COPIES the
 * whole original into the buffer — which would hand back original+delta, tens of
 * megabytes, and throw away the entire point.
 *
 * So the output DISCARDS everything written below `base`. MuPDF's copy loop
 * writes the original into a sink, which leaves the cursor at exactly `base` and
 * every real byte after it; every offset MuPDF records afterwards —
 * `fz_tell_output` is what fills the xref — is a true file offset, because
 * `tell` answers in the original's coordinates rather than the delta's. No
 * MuPDF state is poked and no documented behaviour is bent; the cost is that the
 * original is READ once through `doc->file`, which is why the browser points
 * `ink.host_read` at its own local copy for the duration (`pdfWorker.ts`).
 */
typedef struct {
	fz_buffer *delta; /* owned reference; the bytes from `base` onwards */
	int64_t base;     /* the original file's length */
	int64_t pos;      /* the write cursor, as an offset into the WHOLE file */
} ink_delta_state;

static void ink_delta_write(fz_context *ctx, void *opaque, const void *data, size_t n)
{
	ink_delta_state *st = opaque;
	const unsigned char *p = data;
	int64_t at = st->pos;
	size_t off;

	st->pos += (int64_t)n;
	if (at < st->base) {
		int64_t skip = st->base - at;
		if ((int64_t)n <= skip)
			return; /* wholly inside the original: the caller already has it */
		p += (size_t)skip;
		n -= (size_t)skip;
		at = st->base;
	}
	off = (size_t)(at - st->base);
	if (off == st->delta->len) {
		fz_append_data(ctx, st->delta, p, n);
		return;
	}
	/* A backwards seek followed by a write. The only writer that does this is
	 * the signature path (`pdf-write.c:1816`), which we never reach — but a
	 * position-addressed output that silently appended instead would corrupt the
	 * delta rather than fail, so it is handled rather than asserted. */
	while (st->delta->len < off + n)
		fz_append_byte(ctx, st->delta, 0);
	memcpy(st->delta->data + off, p, n);
}

static void ink_delta_seek(fz_context *ctx, void *opaque, int64_t offset, int whence)
{
	ink_delta_state *st = opaque;
	int64_t target = offset;

	if (whence == SEEK_CUR)
		target = st->pos + offset;
	else if (whence == SEEK_END)
		target = st->base + (int64_t)st->delta->len + offset;
	if (target < 0)
		fz_throw(ctx, FZ_ERROR_ARGUMENT, "cannot seek before the start of the file");
	st->pos = target;
}

static int64_t ink_delta_tell(fz_context *ctx, void *opaque)
{
	ink_delta_state *st = opaque;

	(void)ctx;
	return st->pos;
}

static void ink_delta_truncate(fz_context *ctx, void *opaque)
{
	ink_delta_state *st = opaque;

	if (st->pos <= st->base)
		fz_clear_buffer(ctx, st->delta);
	else if ((size_t)(st->pos - st->base) < st->delta->len)
		st->delta->len = (size_t)(st->pos - st->base);
}

static void ink_delta_drop(fz_context *ctx, void *opaque)
{
	ink_delta_state *st = opaque;

	fz_drop_buffer(ctx, st->delta);
	fz_free(ctx, st);
}

/* Draw `alpha` onto page `number` of the OPEN document, in place. Writes
 * nothing; call once per annotated page, then `ink_shim_export_incremental`.
 * 0 on success, -1 with a message in `ink_shim_error` on failure.
 *
 * THE REFUSALS ARE CHECKED HERE TOO, and that is the point of checking them
 * early: a document that cannot be written incrementally is turned down before
 * its first page is touched, so a refusal never leaves a half-annotated document
 * behind for the next render to draw.
 *
 * ON THE STREAMED PATH THIS CAN SUSPEND — loading a page walks the xref, which
 * pulls through `ink_host_read`. No Zig frame is on the stack inside `fz_try`.
 */
int ink_shim_annotate_page(fz_document *doc, int number,
	const unsigned char *alpha, int w, int h,
	float a, float b, float c, float d, float e, float f)
{
	fz_context *ctx = g_ctx;
	pdf_document *src;
	const char *refusal;

	if (!ctx || !doc || !alpha || w <= 0 || h <= 0)
		return -1;

	src = pdf_specifics(ctx, doc);
	if (!src) {
		ink_set_error("only a PDF can be exported with its structure intact");
		return -1;
	}
	refusal = ink_shim_incremental_refusal(src);
	if (refusal) {
		ink_set_error(refusal);
		return -1;
	}

	fz_try(ctx)
		ink_shim_draw_ink(ctx, src, number, alpha, w, h, a, b, c, d, e, f);
	fz_catch(ctx)
	{
		ink_record_error(ctx);
		return -1;
	}
	return 0;
}

/* Write the changes made by `ink_shim_annotate_page` as an incremental update,
 * and hand back THE DELTA ONLY — the bytes that belong after the original file.
 * The caller must drop the buffer. NULL on failure (message in
 * `ink_shim_error`).
 *
 * The result is not a PDF on its own: `original bytes || delta` is.
 */
fz_buffer *ink_shim_export_incremental(fz_document *doc)
{
	fz_context *ctx = g_ctx;
	pdf_document *src;
	const char *refusal;
	ink_delta_state *st = NULL;
	/* A NON-OWNING alias, live only inside the `fz_try`: `out` owns `st` and
	 * drops it, and the invariant has to be read after the write finishes. */
	ink_delta_state *check = NULL;
	fz_buffer *out_buf = NULL;
	fz_output *out = NULL;

	if (!ctx || !doc)
		return NULL;

	src = pdf_specifics(ctx, doc);
	if (!src) {
		ink_set_error("only a PDF can be exported with its structure intact");
		return NULL;
	}
	refusal = ink_shim_incremental_refusal(src);
	if (refusal) {
		ink_set_error(refusal);
		return NULL;
	}
	/* An empty delta is a valid answer to "nothing changed", and a useless one
	 * to a caller who asked for an annotated document: the concatenation would
	 * be the original file, which the raw-download row already offers. Refusing
	 * says so rather than shipping a copy under a name that promises ink. */
	if (!pdf_has_unsaved_changes(ctx, src)) {
		ink_set_error("no ink was added to this document");
		return NULL;
	}

	fz_var(st);
	fz_var(check);
	fz_var(out_buf);
	fz_var(out);
	fz_try(ctx)
	{
		pdf_write_options opts = pdf_default_write_options;

		/* Compression of the NEW objects only — in an incremental write the
		 * unchanged ones are not written at all, so nothing of the original is
		 * re-encoded. It is not optional: one page's coverage mask is w*h raw
		 * bytes (2.5 MB for A4 at the pen's resolution) and deflates to a few
		 * kilobytes. `do_clean`/`do_sanitize`/`do_garbage` are absent because
		 * MuPDF forbids garbage collection here and because the reason the
		 * single-page path needs them — a graft dragging a shared resource
		 * dictionary along — does not exist when nothing is grafted. */
		opts.do_incremental = 1;
		opts.do_compress = 1;
		opts.do_compress_images = 1;
		opts.do_compress_fonts = 1;

		out_buf = fz_new_buffer(ctx, 8192);
		st = fz_malloc_struct(ctx, ink_delta_state);
		st->delta = fz_keep_buffer(ctx, out_buf);
		st->base = src->file_size;
		/* Position ZERO, not `base`: MuPDF's first act is to write the whole
		 * original into this output, and those `base` bytes are what carry the
		 * cursor to the end of it. Starting at `base` would double-count them
		 * and put every appended object `base` bytes further on than the xref
		 * says. The invariant below is what makes that a thrown error rather
		 * than a file that opens and shows nothing. */
		st->pos = 0;
		out = fz_new_output(ctx, 0, st, ink_delta_write, NULL, ink_delta_drop);
		check = st;
		st = NULL; /* the output owns it, and drops it with `ink_delta_drop` */
		out->seek = ink_delta_seek;
		out->tell = ink_delta_tell;
		out->truncate = ink_delta_truncate;

		pdf_write_document(ctx, src, out, &opts);
		fz_close_output(ctx, out);

		/* THE INVARIANT THAT MAKES THE DISCARD SAFE. The cursor must have ended
		 * exactly `base` bytes above the delta it produced — which holds if and
		 * only if MuPDF's copy of the original wrote every one of its
		 * `file_size` bytes and nothing else was silently dropped below `base`.
		 * A short read of `doc->file` (an aborted range fetch on the streamed
		 * path is the realistic way) would otherwise sink the real objects too
		 * and hand back a delta whose offsets are all wrong — a file that opens
		 * to a blank page rather than one that fails. */
		if (check->pos != check->base + (int64_t)check->delta->len)
			fz_throw(ctx, FZ_ERROR_LIBRARY,
				"could not read the whole of the original while writing the update");
	}
	fz_always(ctx)
		fz_drop_output(ctx, out);
	fz_catch(ctx)
	{
		ink_record_error(ctx);
		fz_free(ctx, st); /* non-NULL only if `fz_new_output` itself failed */
		fz_drop_buffer(ctx, out_buf);
		return NULL;
	}
	return out_buf;
}

/* Buffer accessors: `fz_buffer` is opaque to Zig, as `fz_pixmap` is. */
unsigned char *ink_shim_buffer_data(fz_buffer *buf)
{
	unsigned char *data = NULL;

	if (g_ctx && buf)
		fz_buffer_storage(g_ctx, buf, &data);
	return data;
}

int ink_shim_buffer_len(fz_buffer *buf)
{
	size_t len;

	if (!g_ctx || !buf)
		return -1;
	len = fz_buffer_storage(g_ctx, buf, NULL);
	if (len > 0x7fffffff)
		return -1;
	return (int)len;
}

void ink_shim_drop_buffer(fz_buffer *buf)
{
	if (g_ctx)
		fz_drop_buffer(g_ctx, buf);
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

/* MuPDF calls `mkstemp` only from the temporary-FILE path used when saving a
 * document to a path. `ink_shim_export_page` does write a PDF, but into an
 * `fz_output` over a memory buffer, which never goes near it. wasi-libc has no
 * filesystem-creating `mkstemp`, so this stub keeps the module linkable and
 * fails honestly if it were ever reached. */
int mkstemp(char *template)
{
	(void)template;
	return -1;
}
