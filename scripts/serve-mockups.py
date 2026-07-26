#!/usr/bin/env python3
"""Serve docs/mockups/ with caching OFF.

`python3 -m http.server` sends no `Cache-Control` and no validator for HTML, so
browsers fall back to HEURISTIC freshness and happily keep serving a mockup you
edited a minute ago. That wasted real time twice: a change looks like it did
nothing, and the natural conclusion is that the change is broken rather than
unseen. It is also the same defect we just fixed in the real server, where a
stale `index.html` pinned the whole app to an old bundle.

Usage:  python3 scripts/serve-mockups.py [port]
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # no-store, not no-cache: there is no revalidation machinery here and
        # nothing worth keeping, so never write it to the cache at all.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, *args):
        pass  # the mockups are reloaded constantly; the log is only noise


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8199
    handler = partial(NoCacheHandler, directory="docs/mockups")
    print(f"mockups on http://127.0.0.1:{port}  (no-store)")
    ThreadingHTTPServer(("0.0.0.0", port), handler).serve_forever()
