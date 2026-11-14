# Changelog

What changed in each release of Inkhold, for the people who run it. When a
release asks for something before you upgrade, it says so first, under
**Upgrade notes**. Install and upgrade steps: <https://m00qek.github.io/inkhold/>.

## 1.0.0-beta.2 (2026-11-14)

**Upgrade notes**

- **Take a backup first.** The database moves forward four steps (schema 22 to
  26) at the first start, and an older Inkhold can't open it afterwards: going
  back means restoring that backup.
- **The container now checks every backup file once a week**, Sundays at
  04:00, besides the nightly quick check. On an "online-only" cloud folder that
  downloads the whole backup each week; mount your own `crontab` to change it.
- Building from source needs Zig 0.17.1.

What's new:

- **Digest sync**: the tablet's Digest app syncs its digests, categories and
  handwritten notes. New and tested on one Nomad, so it is off until you turn
  it on (`digest_sync`).
- **Digest in the browser**: read your digests by category or by source, change
  their comments, move them between categories, make, rename and delete
  categories. Deleted digests go to the Recycle bin with your files, and come
  back from there.
- **One search** for notes, documents, file names, to-dos and digests, which
  keeps working offline.
- **Backups**: a weekly check that re-reads every file in the backup folder
  (also as a systemd timer in `contrib/systemd`), and a guide to keeping a copy
  away from the server, on a NAS, a cloud drive or another computer.

Fixed:

- Text typed into a note's text boxes is searchable, whether handwriting
  recognition is on or off.
- A to-do changed in the browser is no longer overridden by a tablet whose
  clock runs ahead.
- Signing out leaves nothing of yours in the browser.
- Closing the reader while a page is drawing no longer leaves an error behind.

Known issue: Inkhold doesn't yet notice a stored file whose bytes changed on
disk, and would serve it as it is
([#7](https://github.com/m00qek/inkhold/issues/7)).

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
