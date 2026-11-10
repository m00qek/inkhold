---
title: "Put it behind HTTPS"
description: "Serve Inkhold over HTTPS, with its own certificate or behind a reverse proxy."
weight: 2030
extra:
  reader: operator
  type: how-to
---

# Put it behind HTTPS

Serve Inkhold over HTTPS, so the tablet and browsers can reach it safely from
outside your home. Plain HTTP is fine inside a trusted home network.

## Let Inkhold do it

Inkhold speaks TLS 1.3 itself; you need no reverse proxy. Give it a
certificate and its key in [config.zon](@/manual/configuration.md):

```zig
.tls = .{
    .enabled = true,
    .cert_path = "/etc/inkhold/cert.pem",
    .key_path = "/etc/inkhold/key.pem",
},
```

Restart Inkhold. On the tablet's sign-in screen, turn on **Enable HTTPS**; in
the browser, use `https://`.

Leave `cipher_suites` empty. Inkhold then picks what is cheap on its own
processor: AES-GCM where the processor has AES instructions, ChaCha20 where it
does not, as on every Raspberry Pi. On a Pi 1, AES costs about three times as
much.

The tablet accepts only a certificate from a public certificate authority, such
as Let's Encrypt. It ignores certificates you add to it, so a self-signed one
fails at sign-in and at every sync. A server reachable only from home can still
get one: with Let's Encrypt's DNS challenge, the name has to exist in public
DNS, but the server itself never has to be reachable from outside.

To try HTTPS in a browser before you have a real certificate,
`bash scripts/dev-cert.sh` in the repository makes a self-signed one. Browsers
accept it once you tell them to; the tablet does not.

## Or behind a reverse proxy

If nginx, Caddy or Traefik already handles HTTPS for you:

- Set **`trusted_proxy`** to the proxy's address, so Inkhold's sign-in limits
  apply to each visitor (read from `X-Real-IP` or the last `X-Forwarded-For`)
  and not to the proxy.
- Have the proxy mark the session cookie `Secure` (nginx:
  `proxy_cookie_flags ~ secure`). Inkhold only does it when it handles TLS
  itself.
