/* Exports: a structure-preserving single page, and the whole document as an incremental update. */

#include "pdf_shim.h"

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
