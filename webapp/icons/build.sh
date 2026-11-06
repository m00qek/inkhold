#!/bin/sh
# The installed app's icons (manifest.webmanifest), from the favicon's mark.
# "any": the mark fills ~half the square, like apple-touch-icon.png.
# "maskable": smaller, inside the 80% circle a launcher may crop to.
# Needs rsvg-convert. Run from webapp/: sh icons/build.sh
set -eu
mk() {
  cat <<EOF
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect width="24" height="24" fill="#e9e6dc"/>
  <g transform="translate(12 12) scale($1) translate(-12 -12)" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <g stroke="#1c1b17" stroke-width="2.4">
      <path d="M9 3.5H6.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2H9"/>
      <path d="M15 3.5h2.5a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H15"/>
    </g>
    <path d="M12 8v8" stroke="#3f6b4a" stroke-width="3.4"/>
  </g>
</svg>
EOF
}
mk 0.8 | rsvg-convert -w 192 -h 192 -o public/icon-192.png
mk 0.8 | rsvg-convert -w 512 -h 512 -o public/icon-512.png
mk 0.62 | rsvg-convert -w 512 -h 512 -o public/icon-maskable-512.png
