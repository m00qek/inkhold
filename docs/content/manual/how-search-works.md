---
title: "How search works"
description: "Where the searchable text comes from, why the index lives in your browser, and what can't be searched."
weight: 4050
extra:
  reader: household
  type: explanation
---

# How search works

## Where the text comes from

Inkhold reads text; it doesn't recognise handwriting itself. Your Supernote
recognises the handwriting in your notebooks and saves that text inside each
file. Inkhold reads it, and the text typed into a notebook's text boxes, as it
reads the text of PDFs and text files.

So handwriting in a notebook the tablet never recognised can't be searched,
though text typed into its text boxes can. Handwriting on a PDF can't either:
the tablet only recognises handwriting in notebooks. The
line under your results says how many pages with writing are searchable, and
**Which notes** lists the ones that aren't, so a missing result never passes
for "not there".

Inkhold doesn't run its own recognition on purpose: it would cost the server
far more than everything else it does, and a Raspberry Pi has to be enough.

## Where the search runs

In your browser. The server keeps a compact index of the words in each file;
the browser fetches the parts it lacks, keeps them, and answers every search
itself. After the first search, searching costs the server nothing, and the
second search is as fast as your device.

## What a search matches

A result holds every word you type, in its name or in its text: notebook and
folder names, recognised handwriting, text typed into text boxes, PDF and text
file contents, to-dos and digests. They are all searched the same way: accents
and capitals don't matter, and words in quotes must appear together and in
that order. Your to-dos and digests are kept in the browser for search too, so
they are found without a connection; signing out removes them.
Results come best first, by how much of a document matched, with notebooks
weighed above other files. With no exact match, it looks for close spellings
and says so.
