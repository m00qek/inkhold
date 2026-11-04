/* Declarations shared by the pdf_shim*.c files: the one MuPDF context, the
 * error slot, and the JSON and geometry helpers more than one area uses. */
#ifndef INK_PDF_SHIM_H
#define INK_PDF_SHIM_H

#include <mupdf/fitz.h>
#include <mupdf/pdf.h> /* the export path builds a PDF, not just reads one */

#include <stdio.h> /* EOF, SEEK_CUR, SEEK_END — for the callback stream */
#include <stdlib.h>
#include <string.h> /* strlen, for the ink's content-stream fragment */

extern fz_context *g_ctx;

fz_context *ink_shim_context(void);
void ink_set_error(const char *msg);
void ink_record_error(fz_context *ctx);
int ink_shim_page_size(fz_document *doc, int number, float *w, float *h);
int ink_finite(float v);
void ink_json_number(fz_context *ctx, fz_buffer *out, float v);
void ink_json_string_n(fz_context *ctx, fz_buffer *out, const char *s, size_t n);
void ink_json_string(fz_context *ctx, fz_buffer *out, const char *s);
size_t ink_utf8_trunc(const char *s, size_t max);
int ink_page_for_uri(fz_context *ctx, fz_document *doc, const char *uri);

#endif
