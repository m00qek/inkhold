/* Words on a page and the document outline, as JSON. */

#include "pdf_shim.h"

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
