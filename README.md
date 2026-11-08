# Inkhold

**A private cloud for your Supernote, on hardware you own, so your notes never
leave home.**

Point your Supernote at Inkhold instead of Supernote's cloud and your notebooks
sync as before, to one small program on your own machine: a home server, a
spare laptop, even a Raspberry Pi from 2014. In the browser you can read,
search your handwriting, recover deleted notes and export to PDF.

![A handwritten note reading "Hey there! Welcome to Inkhold. I hope it keeps your notes safe and always at hand :)"](docs/screenshots/welcome-hero.png)

> **Beta, and unofficial.** Inkhold is reverse-engineered for interoperability,
> verified on a Supernote Nomad, and not affiliated with Ratta or Supernote.
> Keep a copy of your notes elsewhere until it has earned your trust.

## Try it

```sh
docker run -d --name inkhold -p 8089:8089 -v inkhold:/var/lib/inkhold \
  ghcr.io/m00qek/inkhold-beta:latest
docker logs inkhold    # the first admin password
```

Open `http://<this machine's address>:8089`, sign in as `admin@home.lan`, then
[point your Supernote at it](docs/content/manual/point-supernote.md).

## Documentation

- **[Your first sync](docs/content/manual/first-sync.md)**: install Inkhold,
  sign in, point the tablet at it, and see your notes in the browser.
- **[The manual](docs/content/manual/_index.md)**: install, back up, upgrade,
  and everyday use on the tablet and in the browser.
- **[The contributor manual](docs/content/contributor/_index.md)**: build, test,
  and how it works.

Found a bug? [Open an issue](https://github.com/m00qek/inkhold-beta/issues):
that feedback is the point of the beta.

## License

[GPLv3](LICENSE). The understanding of Supernote's file formats derives from
[supernote-tool](https://github.com/jya-dev/supernote-tool) (Apache-2.0).
