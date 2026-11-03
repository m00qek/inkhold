/* MuPDF <-> Zig shim for the browser PDF viewer. `fz_try` is setjmp/longjmp,
 * so every MuPDF call lives here and every function is exception-free at its
 * boundary (NULL or a negative int). `pdf_decode.zig` owns the ABI. */

#include <mupdf/fitz.h>
#include <mupdf/pdf.h> /* the export path builds a PDF, not just reads one */

#include <stdio.h> /* EOF, SEEK_CUR, SEEK_END — for the callback stream */
#include <stdlib.h>
#include <string.h> /* strlen, for the ink's content-stream fragment */

/* Store cap. MuPDF's 256 MB default can grow a wasm heap without bound; 16 MB
 * keeps one large page's resources across a re-render. */
#define INK_STORE_LIMIT (16 << 20)

static fz_context *g_ctx;

/* Last MuPDF error message: return codes say which call failed, not why. */
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

/* Only valid inside `fz_catch`; our own refusals use `ink_set_error`. */
static void ink_record_error(fz_context *ctx)
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
		fz_register_document_handlers(g_ctx);
	fz_catch(g_ctx)
	{
		ink_record_error(g_ctx);
		fz_drop_context(g_ctx);
		g_ctx = NULL;
	}
	return g_ctx;
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

/* --- links on a page ---
 * A uri that is not http/https/mailto is dropped, never flagged: it is
 * untrusted text from a synced file. The client checks again at its own trust
 * boundary. */

/* Longer links are dropped, not truncated (a truncated URI goes elsewhere). */
#define INK_MAX_URI 4096

/* A malformed /Rect degrades to infinite, and MuPDF's formatter prints NaN as 0
 * and infinity as FLT_MAX, so non-finite values are refused here. */
static int ink_finite(float v)
{
	return v > -1e6f && v < 1e6f;
}

/* Appends `v` as a JSON number. Not `%g`: MuPDF's `fmtfloat` writes 0.5 as
 * `.5`, which JSON.parse rejects. Three decimals at most. */
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
		fz_append_byte(ctx, out, '.');
		fz_append_byte(ctx, out, (char)('0' + frac / 100));
		if (frac % 100 != 0) {
			fz_append_byte(ctx, out, (char)('0' + (frac / 10) % 10));
			if (frac % 10 != 0)
				fz_append_byte(ctx, out, (char)('0' + frac % 10));
		}
	}
}

/* Appends `n` bytes of `s` as a JSON string, escaping `"`, `\` and C0 controls
 * so a hostile uri cannot close the string. Bytes >= 0x80 pass through. */
static void ink_json_string_n(fz_context *ctx, fz_buffer *out, const char *s, size_t n)
{
	static const char hex[] = "0123456789abcdef";
	size_t i;

	fz_append_byte(ctx, out, '"');
	for (i = 0; i < n; i++) {
		unsigned char c = (unsigned char)s[i];
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

static void ink_json_string(fz_context *ctx, fz_buffer *out, const char *s)
{
	ink_json_string_n(ctx, out, s, strlen(s));
}

/* The longest prefix of `s` within `max` bytes that does not cut a UTF-8 rune. */
static size_t ink_utf8_trunc(const char *s, size_t max)
{
	size_t n = strlen(s);

	if (n <= max)
		return n;
	n = max;
	while (n > 0 && ((unsigned char)s[n] & 0xc0) == 0x80)
		n--;
	return n;
}

/* http, https or mailto, case-insensitive, anchored at byte zero. */
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

/* The 0-based page `uri` names, or -1. Shared by links and the outline.
 * `fz_resolve_link` answers in (chapter, page) and
 * `fz_page_number_from_location` flattens it (EPUB has chapters). */
static int ink_page_for_uri(fz_context *ctx, fz_document *doc, const char *uri)
{
	fz_location loc;
	int number;

	if (!uri || !uri[0])
		return -1;
	loc = fz_resolve_link(ctx, doc, uri, NULL, NULL);
	if (loc.chapter < 0 || loc.page < 0)
		return -1;
	number = fz_page_number_from_location(ctx, doc, loc);
	return number < 0 ? -1 : number;
}

/* The links on `number` as JSON `[{"x","y","w","h","page","uri"}]`, in the
 * space `ink_shim_page_size` reports: the box origin is subtracted (nothing
 * promises a zero origin for non-PDF pages), and `pdf_load_link_annots` uses
 * the same `pdf_page_transform` as `fz_bound_page`, so rotation agrees. Links
 * with an empty, overlong, disallowed or unresolvable uri, or a degenerate
 * rect, are dropped. NULL on failure. */
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
				target = ink_page_for_uri(ctx, doc, link->uri);
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

/* --- words on a page ---
 * Words, not `fz_search_page`: the server's index folds with SQLite's
 * `unicode61 remove_diacritics 2`, which MuPDF's matcher does not, so the
 * client folds and matches. Output `[{"t","x","y","w","h","l"}]` in page-size
 * space; `l` is the page-wide text line ordinal, contiguous from 0. */

/* Longer runs are split, not dropped. */
#define INK_MAX_WORD_BYTES 192

/* Past this a page contributes no more words: it costs boxes, never matches. */
#define INK_MAX_WORDS 20000

/* A cheap approximation of `unicode61` separators. Safe because it only
 * decides box extents; the client re-tokenises with the index's rule. */
static int ink_word_char(int c)
{
	if (c <= 0x20 || c == 0x7f)
		return 0; /* ASCII space and controls */
	if ((c >= 0x21 && c <= 0x2f) || (c >= 0x3a && c <= 0x40) ||
	    (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e))
		return 0; /* ASCII punctuation */
	if (c == 0xa0 || c == 0x202f || c == 0x205f || c == 0x3000)
		return 0; /* the non-breaking and ideographic spaces */
	if (c >= 0x2000 && c <= 0x200a)
		return 0; /* en/em/thin/hair spaces */
	if (c == 0x2028 || c == 0x2029)
		return 0; /* line and paragraph separators */
	if (c >= 0x2010 && c <= 0x2027)
		return 0; /* dashes, quotes, bullets, ellipsis */
	if (c == 0xab || c == 0xbb || c == 0x2039 || c == 0x203a)
		return 0; /* guillemets — Portuguese and French quotation */
	return 1;
}

/* One word run being accumulated; `n == 0` means none open. */
struct ink_word {
	char text[INK_MAX_WORD_BYTES + 8]; /* +8: one rune never straddles the cap */
	int n;
	fz_rect box;
};

/* Emits and closes the open run, dropping degenerate or non-finite rects.
 * `line` is the current line id, which is always the run's own. */
static void ink_flush_word(fz_context *ctx, fz_buffer *out, struct ink_word *w,
			   fz_point origin, int *first, int *count, int line)
{
	float x, y, bw, bh;

	if (w->n == 0)
		return;
	w->text[w->n] = 0;
	w->n = 0;
	if (*count >= INK_MAX_WORDS)
		return;

	x = w->box.x0 - origin.x;
	y = w->box.y0 - origin.y;
	bw = w->box.x1 - w->box.x0;
	bh = w->box.y1 - w->box.y0;
	if (!(bw > 0) || !(bh > 0))
		return;
	if (!ink_finite(x) || !ink_finite(y) || !ink_finite(bw) || !ink_finite(bh))
		return;

	if (!*first)
		fz_append_byte(ctx, out, ',');
	*first = 0;
	(*count)++;
	fz_append_string(ctx, out, "{\"t\":");
	ink_json_string(ctx, out, w->text);
	fz_append_string(ctx, out, ",\"x\":");
	ink_json_number(ctx, out, x);
	fz_append_string(ctx, out, ",\"y\":");
	ink_json_number(ctx, out, y);
	fz_append_string(ctx, out, ",\"w\":");
	ink_json_number(ctx, out, bw);
	fz_append_string(ctx, out, ",\"h\":");
	ink_json_number(ctx, out, bh);
	fz_append_printf(ctx, out, ",\"l\":%d", line);
	fz_append_byte(ctx, out, '}');
}

/* Walks one block list, recursing into `FZ_STEXT_BLOCK_STRUCT` (tagged PDFs
 * keep text there), bounded by `depth` because the wasm C stack is 64 KB.
 * `line` must stay a pointer: lines are numbered per page, across structure
 * subtrees. Unreachable today (needs `FZ_STEXT_COLLECT_STRUCTURE`). */
static void ink_words_in_blocks(fz_context *ctx, fz_buffer *out, fz_stext_block *first_block,
				fz_point origin, int depth, int *first, int *count, int *line)
{
	fz_stext_block *block;
	fz_stext_line *line_it;
	fz_stext_char *ch;
	struct ink_word w;

	if (depth <= 0)
		return;
	w.n = 0;
	for (block = first_block; block; block = block->next) {
		if (block->type == FZ_STEXT_BLOCK_STRUCT) {
			if (block->u.s.down)
				ink_words_in_blocks(ctx, out, block->u.s.down->first_block,
						    origin, depth - 1, first, count, line);
			continue;
		}
		if (block->type != FZ_STEXT_BLOCK_TEXT)
			continue;
		for (line_it = block->u.t.first_line; line_it; line_it = line_it->next) {
			/* The id advances only when the line emitted a word, so ids stay
			 * contiguous. */
			int emitted_before = *count;

			for (ch = line_it->first_char; ch; ch = ch->next) {
				fz_rect r;

				if (!ink_word_char(ch->c)) {
					ink_flush_word(ctx, out, &w, origin, first, count, *line);
					continue;
				}
				if (w.n > INK_MAX_WORD_BYTES)
					ink_flush_word(ctx, out, &w, origin, first, count, *line);
				r = fz_rect_from_quad(ch->quad);
				w.box = w.n == 0 ? r : fz_union_rect(w.box, r);
				w.n += fz_runetochar(w.text + w.n, ch->c);
			}
			/* A line ends a word (no rects spanning baselines), and the flush
			 * must precede the id advance. */
			ink_flush_word(ctx, out, &w, origin, first, count, *line);
			if (*count > emitted_before)
				(*line)++;
		}
	}
	/* Safety net: the end-of-line flush already drained the run. */
	ink_flush_word(ctx, out, &w, origin, first, count, *line);
}

/* The words on `number` as JSON; an empty page is `[]`. Building stext runs
 * the page, so on the streamed path every resource is pulled through. */
fz_buffer *ink_shim_page_words(fz_document *doc, int number)
{
	fz_context *ctx = g_ctx;
	fz_page *page = NULL;
	fz_stext_page *text = NULL;
	fz_buffer *out = NULL;

	if (!ctx || !doc || number < 0)
		return NULL;
	fz_var(page);
	fz_var(text);
	fz_var(out);
	fz_try(ctx)
	{
		fz_stext_options opts;
		fz_point origin;
		fz_rect box;
		int first = 1;
		int count = 0;
		int line = 0;

		out = fz_new_buffer(ctx, 1024);
		page = fz_load_page(ctx, doc, number);
		box = fz_bound_page(ctx, page);
		origin.x = box.x0;
		origin.y = box.y0;
		fz_init_stext_options(ctx, &opts);
		/* Default options: images off, ligatures expanded, as the index sees. */
		text = fz_new_stext_page_from_page(ctx, page, &opts);
		fz_append_byte(ctx, out, '[');
		ink_words_in_blocks(ctx, out, text->first_block, origin, 16, &first, &count,
				    &line);
		fz_append_byte(ctx, out, ']');
	}
	fz_always(ctx)
	{
		fz_drop_stext_page(ctx, text);
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

/* --- the document outline ---
 * A flat pre-order list with depth `d`, not a tree: a panel needs only the
 * indent. Depth, emitted depth and entry count are capped. */

/* Deeper subtrees are not walked (the wasm C stack is 64 KB): the one place an
 * entry can vanish. */
#define INK_MAX_OUTLINE_DEPTH 256

/* Deeper entries are still emitted, clamped to this depth. */
#define INK_MAX_OUTLINE_LEVEL 32

/* Bounds one call's buffer against a hostile document. */
#define INK_MAX_OUTLINE_ENTRIES 10000

/* Longer titles are truncated, not dropped. */
#define INK_MAX_OUTLINE_TITLE 512

/* Walks one chain and its children. `first`/`count` are pointers so commas and
 * the cap span the document. `budget` guards the stack, `level` only the
 * printed depth; keep them separate. */
static void ink_outline_entries(fz_context *ctx, fz_buffer *out, fz_document *doc,
				fz_outline *chain, int level, int budget, int *first,
				int *count)
{
	fz_outline *node;

	if (budget <= 0)
		return;
	for (node = chain; node; node = node->next) {
		const char *title;
		int page;

		if (*count >= INK_MAX_OUTLINE_ENTRIES)
			return;
		/* The same resolver as links, so both report the same page. */
		page = ink_page_for_uri(ctx, doc, node->uri);
		title = node->title ? node->title : "";

		if (!*first)
			fz_append_byte(ctx, out, ',');
		*first = 0;
		(*count)++;
		fz_append_printf(ctx, out, "{\"d\":%d,\"t\":", level);
		ink_json_string_n(ctx, out, title, ink_utf8_trunc(title, INK_MAX_OUTLINE_TITLE));
		/* `p` is omitted, never -1 or null, when unresolved. */
		if (page >= 0)
			fz_append_printf(ctx, out, ",\"p\":%d", page);
		fz_append_byte(ctx, out, '}');

		if (node->down)
			ink_outline_entries(ctx, out, doc, node->down,
					    level < INK_MAX_OUTLINE_LEVEL ? level + 1 : level,
					    budget - 1, first, count);
	}
}

/* The outline as JSON `[{"d","t","p"}]`: depth, title, 0-based page (omitted
 * when unresolved). Every entry gets a row, an empty title as `""`. No outline
 * is `[]`. NULL on failure. Must be in JS's JSPI promising list. */
fz_buffer *ink_shim_outline(fz_document *doc)
{
	fz_context *ctx = g_ctx;
	fz_outline *outline = NULL;
	fz_buffer *out = NULL;

	if (!ctx || !doc)
		return NULL;
	fz_var(outline);
	fz_var(out);
	fz_try(ctx)
	{
		int first = 1;
		int count = 0;

		out = fz_new_buffer(ctx, 256);
		/* NULL for no outline, read as an empty chain. */
		outline = fz_load_outline(ctx, doc);
		fz_append_byte(ctx, out, '[');
		ink_outline_entries(ctx, out, doc, outline, 0, INK_MAX_OUTLINE_DEPTH, &first,
				    &count);
		fz_append_byte(ctx, out, ']');
	}
	fz_always(ctx)
	{
		/* Dropped in `fz_always`, on every path out. */
		fz_drop_outline(ctx, outline);
	}
	fz_catch(ctx)
	{
		ink_record_error(ctx);
		fz_drop_buffer(ctx, out);
		return NULL;
	}
	return out;
}

/* Renders one page into an RGBA pixmap cleared to opaque white, so the
 * premultiplied output equals the straight RGBA the ABI promises. */
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

	/* Force alpha to 255: MuPDF's 8-bit compositing rounds some pixels to 254. */
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

/* Drops unreferenced cache; called after the last document closes. */
void ink_shim_shrink_store(void)
{
	if (g_ctx)
		fz_shrink_store(g_ctx, 0);
}

/* --- structure-preserving single-page export ---
 * `pdf_graft_page` copies the original page's /Contents, /Resources and boxes
 * into a fresh document, ink on top. `pdf_graft_mapped_page` copies a fixed key
 * list, so /Annots (links, forms, highlights) and a page /Group are dropped. */

/* Builds the ink as an image XObject; caller drops the reference. A 1-bit
 * DeviceGray base with an 8-bit /SMask, not an /ImageMask: the ink is
 * anti-aliased and a stencil staircases. The base keeps w x h (a smaller
 * /SMask base would resample the mask) but at 1 bit, and all-zero samples are
 * black under the default /Decode. */
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

/* Adds `text` as an uncompressed content stream (deflated at write time). */
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

/* The ink XObject name, per page: /Resources are often shared between pages,
 * so a fixed name would let one page's ink overwrite another's. */
static void ink_shim_xobject_name(char *dst, size_t len, int number)
{
	fz_snprintf(dst, len, "InkholdInk%d", number);
}

/* Wraps /Contents as `[ (q) original… (Q + ink) ]`: a content stream, not an
 * annotation, so it can't be hidden or flattened away. `q`/`Q` shields the ink
 * from leftover graphics state (its `cm` is relative); `do_sanitize`
 * rebalances deeper imbalance. */
static void ink_shim_wrap_contents(fz_context *ctx, pdf_document *dst,
	pdf_obj *page_obj, pdf_obj *image, const char *name, const char *tail)
{
	pdf_obj *resources;
	pdf_obj *xobjects;
	pdf_obj *old;
	pdf_obj *contents = NULL;

	/* Inheritable: /Resources often lives on /Pages, and writing an empty one
	 * onto the page would shadow it and lose every font. */
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
		/* Push the old streams before replacing /Contents, which holds them. */
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

/* Draws `alpha` onto page `number` of the open `doc` in place; throws. `a`..`f`
 * map the alpha image's pixel space onto the page in display space. */
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

		/* Content streams are in unrotated MediaBox user space; the caller is
		 * in cropped, rotated display space. The inverse of
		 * `pdf_page_transform_box` maps back (FZ_CROP_BOX only selects the rect
		 * returned; the matrix is the same). `unit` maps image pixels onto the
		 * unit square `Do` paints. `fz_concat(A, B)` is "A, then B". */
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

/* Exports page `number` as a one-page PDF with `alpha` drawn over it (see
 * `ink_shim_draw_ink`). Caller drops the buffer; NULL on failure. */
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

	/* Not a PDF (EPUB, CBZ, XPS): refuse with a message so the caller can fall
	 * back to the rasterising exporter. */
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

		/* `do_clean` + `do_sanitize` + `do_garbage = 3` together, or none: they
		 * rebuild each page's /Resources from what it references and drop the
		 * rest of a shared dictionary. Either alone gains nothing or grows. */
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

/* --- whole-document export as an incremental update ---
 * Keeps the original's bytes verbatim (and every page's /Annots) and appends
 * only changed objects; the browser concatenates the delta. MuPDF does not
 * guard three things here (`ink_shim_incremental_refusal`): a document with no
 * backing file, a nonzero `doc->bias` (never applied on this path), and a
 * repaired file (refused before any page is mutated). */

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

/* The delta's output: absolute positions in, bytes below `base` discarded.
 * MuPDF's incremental write first copies the whole original into the output
 * (`ensure_initial_incremental_contents`), and a buffer output would keep that
 * copy; discarding it keeps `fz_tell_output` in true file offsets. */
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
	/* A backwards seek then write (only the signature path does this) is
	 * handled rather than silently appended. */
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

/* Draws `alpha` onto page `number` of the open document; call once per page,
 * then `ink_shim_export_incremental`. Refusals are checked first so a document
 * is never left half-annotated. 0 on success, -1 on failure. */
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

/* Writes the annotations as an incremental update and returns only the delta
 * (`original || delta` is the PDF). Caller drops; NULL on failure. */
fz_buffer *ink_shim_export_incremental(fz_document *doc)
{
	fz_context *ctx = g_ctx;
	pdf_document *src;
	const char *refusal;
	ink_delta_state *st = NULL;
	/* A non-owning alias, valid only inside `fz_try`. */
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
	/* An empty delta would just be the original, so refuse. */
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

		/* Compress the new objects; MuPDF forbids garbage collection on an
		 * incremental write. */
		opts.do_incremental = 1;
		opts.do_compress = 1;
		opts.do_compress_images = 1;
		opts.do_compress_fonts = 1;

		out_buf = fz_new_buffer(ctx, 8192);
		st = fz_malloc_struct(ctx, ink_delta_state);
		st->delta = fz_keep_buffer(ctx, out_buf);
		st->base = src->file_size;
		/* Start at 0: MuPDF's copy of the original carries the cursor to `base`. */
		st->pos = 0;
		out = fz_new_output(ctx, 0, st, ink_delta_write, NULL, ink_delta_drop);
		check = st;
		st = NULL; /* the output owns it, and drops it with `ink_delta_drop` */
		out->seek = ink_delta_seek;
		out->tell = ink_delta_tell;
		out->truncate = ink_delta_truncate;

		pdf_write_document(ctx, src, out, &opts);
		fz_close_output(ctx, out);

		/* The copy must have written all `file_size` bytes; a short read would
		 * yield a delta with wrong offsets (a blank-opening file). */
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

/* --- JPX stubs ---
 * MuPDF 1.28.1's disabled-JPX stub of `fz_load_jpx_info` lacks the trailing
 * `defcs` parameter; wasm-ld turns the mismatch into a trapping stub. So
 * `load-jpx.c` is excluded in `build.zig` and correct stubs live here. */

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

/* --- wasi-libc gap --- */

/* wasi-libc has no `mkstemp`; MuPDF only uses it on a save-to-path we never
 * take, so this stub keeps the module linkable and fails if reached. */
int mkstemp(char *template)
{
	(void)template;
	return -1;
}
