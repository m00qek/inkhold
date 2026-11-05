# Inkhold, as a container: the statically linked server, the built SPA, and a
# static busybox for the nightly backup.
#
# FROM scratch, NOT alpine, and the reason is that there is nothing for a base
# image to provide. `make release-artifact` links against musl STATICALLY, so
# the binary has no loader and no libc to find; it opens no outbound TLS
# connection, so it needs no CA bundle; it formats no local times, so it needs
# no tzdata; and `-DSQLITE_TEMP_STORE=3` keeps every SQLite temp table in
# memory, so it needs no writable /tmp. An alpine base would add ~8 MB and a
# package surface to patch.
#
# BUSYBOX, ONE STATIC BINARY (~1 MB), is the exception, for scheduling: when a
# volume is mounted at /backup, its crond runs `inkhold backup` nightly
# (`rootfs/etc/inkhold/crontab`), and its ash runs the entrypoint that starts
# crond beside the server (`rootfs/usr/local/bin/entrypoint`). Scheduling is a
# distribution's job, like a systemd timer, so it lives here and not in the
# server. A side effect: `docker exec -it inkhold sh` works, with the applets
# linked in `rootfs/bin` (any other one as `busybox <applet>`).
#
# ONE IMAGE PER PLATFORM, assembled into a manifest list by buildx. The binaries
# are CROSS-COMPILED on the runner by Zig rather than built under QEMU inside
# the container: MuPDF alone is several minutes native, and emulated it is
# unusable. `TARGETPLATFORM` is set by buildx per platform in the list, and the
# context is laid out to match — see `make docker-context`.
#
# THE BUILD CONTEXT IS `docker/`, not the repo root. A root context would hand
# the daemon the whole tree on every build, `server/` included — which on a
# machine that has actually run Inkhold is the live database and blob store.
FROM scratch

ARG TARGETPLATFORM
ARG VERSION=dev
ARG SOURCE=https://github.com/m00qek/inkhold-beta

# `image.source` is the one that does more than describe: GHCR reads it to LINK
# the package to its repository, which is what makes the package page show the
# README and inherit the repo's own access rules. Without it the package floats
# unattached to anything.
LABEL org.opencontainers.image.title="Inkhold" \
      org.opencontainers.image.description="A private cloud for your Supernote — self-hosted." \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.revision="${VERSION}" \
      org.opencontainers.image.version="${VERSION}"

# Busybox, copied from the official image for the same platform: a COPY, so
# nothing foreign runs during the build (no QEMU). Then the applet links, the
# passwd crond needs to accept the `root` crontab, the crontab, the entrypoint.
COPY --from=busybox:1.37.0-musl /bin/busybox /bin/busybox
COPY rootfs/ /
ENV PATH=/usr/local/bin:/bin

# The server, and the SPA it serves on the same port.
COPY context/${TARGETPLATFORM}/inkhold /inkhold
COPY context/webapp/dist /srv/webapp/dist

# A config with ABSOLUTE paths. The shipped defaults are relative to the working
# directory, and the working directory here is a volume — so a first run would
# write its database next to a `webapp/dist` that is not there. Absolute paths
# put state in the volume and the SPA in the image, which is the split a
# container wants.
COPY config.zon /etc/inkhold/config.zon

# Everything that must survive the container: the database, the credential key,
# the blob store and the derived search index. NOT /backup: the entrypoint
# turns backups on when something is mounted there, and a VOLUME line would
# mount an anonymous volume on every run (on the same disk, too).
VOLUME ["/var/lib/inkhold"]
WORKDIR /var/lib/inkhold

EXPOSE 8089

# No HEALTHCHECK: there is no HTTP client in here. Point your orchestrator at
# `GET /api/admin/health` instead.
#
# `serve` runs under the entrypoint (server + crond, signals forwarded); any
# other command (`restore /backup`, `users reset-password ...`) is handed to
# `/inkhold --config=/etc/inkhold/config.zon` unchanged, as before.
ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["serve"]
