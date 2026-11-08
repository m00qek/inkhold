# Changelog

What changed in each release of Inkhold, for the people who run it. When a
release asks for something before you upgrade, it says so first, under
**Upgrade notes**. Install and upgrade steps: <https://m00qek.github.io/inkhold/>.

## 1.0.0-beta.1 (2026-11-08)

The first public beta. Inkhold is a private cloud for your Supernote: the
tablet syncs to a small server on your own machine instead of Supernote's
cloud, and your household reads, searches and exports its notes in a browser.

**Before you start:** copy your tablet's folders to another computer. Sync
runs both ways, and this is beta software.

What's in it:

- **Sync**: the tablet's own Private Cloud sync, by hand or with Auto Sync,
  verified end to end on a Supernote Nomad.
- **Read in the browser**: notebooks with their layers, PDFs with your
  handwriting over them, sketches, images and text files, on a computer or a
  phone.
- **Search your handwriting**, and your PDFs and text files, across the whole
  library.
- **Recover mistakes**: a recycle bin, and earlier versions of a note.
- **Export** a page or a notebook to PDF, PNG or layered ORA.
- **A household**: an account for each person and tablet, with storage
  allotments, run from an admin console.
- **Backups** to a folder of plain files, and restore from them.
- **Runs anywhere Linux does**: one static binary for x86_64, aarch64, 32-bit
  ARM (every Raspberry Pi from the 1 B+ up) and 32-bit x86, or one container
  image for all four.

Not yet: Digest sync; viewing EPUB and Office files; searching handwriting on
PDFs; the Supernote phone app. To-Do sync works but is off until you turn it
on. Other Supernote models very likely work but aren't confirmed yet. The
details: <https://m00qek.github.io/inkhold/manual/limits/>.
