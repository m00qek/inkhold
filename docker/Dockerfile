# Inkhold, as a container: the statically linked server, the built SPA, nothing
# else.
#
# FROM scratch, NOT alpine, and the reason is that there is nothing for a base
# image to provide. `make release-artifact` links against musl STATICALLY, so
# the binary has no loader and no libc to find; it opens no outbound TLS
# connection, so it needs no CA bundle; it formats no local times, so it needs
# no tzdata; and `-DSQLITE_TEMP_STORE=3` keeps every SQLite temp table in
# memory, so it needs no writable /tmp. An alpine base would add ~8 MB and a
# package surface to patch, in exchange for a shell.
#
# THE TRADE THAT BUYS, stated so nobody has to discover it: there is no shell in
# here, so `docker exec` cannot give you one. To look inside, `docker cp` the
# path out, or run the binary with `--help`/`--version`. Swapping the first line
# for `FROM alpine:3` is all it takes to get a shell back if that is ever worth
# 8 MB to you.
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

LABEL org.opencontainers.image.title="Inkhold" \
      org.opencontainers.image.description="A private cloud for your Supernote — self-hosted." \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}"

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
# the blob store and the derived search index.
VOLUME ["/var/lib/inkhold"]
WORKDIR /var/lib/inkhold

EXPOSE 8089

# No HEALTHCHECK: it would need a shell or curl, and neither is in here. Point
# your orchestrator at `GET /api/admin/health` instead.
ENTRYPOINT ["/inkhold", "--config=/etc/inkhold/config.zon"]
CMD ["serve"]
