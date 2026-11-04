/* Links on a page, as JSON records, and the JSON helpers the text exports share. */

#include "pdf_shim.h"

/* --- links on a page ---
 * A uri that is not http/https/mailto is dropped, never flagged: it is
 * untrusted text from a synced file. The client checks again at its own trust
 * boundary. */

/* Longer links are dropped, not truncated (a truncated URI goes elsewhere). */
#define INK_MAX_URI 4096

/* A malformed /Rect degrades to infinite, and MuPDF's formatter prints NaN as 0
 * and infinity as FLT_MAX, so non-finite values are refused here. */
int ink_finite(float v)
{
	return v > -1e6f && v < 1e6f;
}

/* Appends `v` as a JSON number. Not `%g`: MuPDF's `fmtfloat` writes 0.5 as
 * `.5`, which JSON.parse rejects. Three decimals at most. */
void ink_json_number(fz_context *ctx, fz_buffer *out, float v)
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
void ink_json_string_n(fz_context *ctx, fz_buffer *out, const char *s, size_t n)
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

void ink_json_string(fz_context *ctx, fz_buffer *out, const char *s)
{
	ink_json_string_n(ctx, out, s, strlen(s));
}

/* The longest prefix of `s` within `max` bytes that does not cut a UTF-8 rune. */
size_t ink_utf8_trunc(const char *s, size_t max)
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
int ink_page_for_uri(fz_context *ctx, fz_document *doc, const char *uri)
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
