/* How the server opens a document for MuPDF, the probe and the text pass
 * alike. */

#ifndef INK_OPEN_H
#define INK_OPEN_H

#include <mupdf/fitz.h>
#include <mupdf/pdf.h>

/* A zip goes by its content: an XPS opens as one, anything else with images
 * as a comic book. Every other file is read as a PDF, repaired if it must be,
 * so MuPDF's other archive readers (tar, OLE) never see an upload, whatever
 * its name. Throws as MuPDF does. */
static inline fz_document *ink_open_document(fz_context *ctx, fz_stream *stm)
{
    /* A descriptor carries no extension, so name a format; the content
     * decides among the handlers registered. */
    if (fz_is_zip_archive(ctx, stm)) return fz_open_document_with_stream(ctx, ".pdf", stm);
    return (fz_document *)pdf_open_document_with_stream(ctx, stm);
}

#endif
