#!/usr/bin/env python3
"""Writes two-chapter.epub, the book fixture for pdf_decode_abi/book.mjs.

Two short chapters of text written for this repo (no copyright). Chapter one
opens with its title in an <hgroup> that the book's own CSS pushes down by
20em: the shim's user stylesheet zeroes hgroup margins, as the tablet's
MuPDF 1.17 (which doesn't know hgroup) does. Chapter two holds an image the
archive doesn't have and one on a remote host: neither is ever fetched, and
a paragraph pairing "abcd" with "ab<U+FEFF>cd": the invisible character must
take no width, as in the tablet's layout (Noto Serif, the shim's fallback),
and one of words with soft hyphens, where the tablet breaks lines.

Usage: python3 make_two_chapter_epub.py two-chapter.epub
"""
import sys
import zipfile

SENTENCE = (
    "The harbour lay quiet under a grey sky, and the boats knocked softly "
    "against the stones while the gulls argued over what the tide had left. "
)
CHAPTER_ONE = "".join(f"<p>{SENTENCE * 6}</p>\n" for _ in range(12))
# Long words with soft hyphens (U+00AD): the tablet's reader breaks lines at
# them, as `hyphens: manual` does; `none` would not.
SOFT = " ".join(["quix\u00adot\u00adic\u00adal\u00adly"] * 60)
CHAPTER_TWO = "".join(f"<p>{SENTENCE * 5}</p>\n" for _ in range(10))

def xhtml(title, body, css):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title>
<style>{css}</style></head><body>{body}</body></html>"""

FILES = {
    "META-INF/container.xml": """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>""",
    "book.opf": """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">inkhold-two-chapter</dc:identifier>
<dc:title>Two Chapters</dc:title><dc:language>en</dc:language></metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>""",
    "nav.xhtml": xhtml("Contents", '<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>'
                       '<li><a href="one.xhtml">One</a></li><li><a href="two.xhtml">Two</a></li></ol></nav>', ""),
    "one.xhtml": xhtml("One", f"<hgroup><h1>One</h1></hgroup>\n{CHAPTER_ONE}",
                       "hgroup { margin-top: 20em } p { hyphens: auto }"),
    "two.xhtml": xhtml("Two", '<h1>Two</h1><p>abcd ab\ufeffcd</p><p>' + SOFT + '</p><p><img src="missing.png" alt=""/>'
                       '<img src="https://example.invalid/remote.png" alt=""/></p>\n' + CHAPTER_TWO, ""),
}

with zipfile.ZipFile(sys.argv[1], "w") as z:
    # The mimetype first and stored, as the EPUB container spec requires.
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    for name, text in FILES.items():
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        z.writestr(info, text, compress_type=zipfile.ZIP_DEFLATED)
