// Writes the reference pages that must never drift from the code
// (content/contributor/documentation-rules.md, "Generated, not written"):
//
//   manual/configuration.md   from config.example.zon: each setting, its default, its comment
//   manual/command-line.md    from backend/cli.zig's help text
//
// Each page keeps its own front matter; the body below it is replaced.
//   node tools/generate.mjs           write them
//   node tools/generate.mjs --check   fail if they are out of date (the docs CI)

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const docs = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(docs, "..");
const check = process.argv.includes("--check");

/** The page with its body replaced; its front matter kept. */
function withBody(path, body) {
  const old = readFileSync(path, "utf8");
  const end = old.indexOf("\n---\n", 4) + 5;
  const front = old.slice(0, end).replace("  stub: true\n", "");
  return front + "\n" + body;
}

const NOTE = (src) =>
  `<!-- Generated from ${src} by docs/tools/generate.mjs. Edit the source, not this page. -->\n`;

function configuration() {
  const rows = [];
  let comment = [];
  const prefix = [];
  for (const raw of readFileSync(join(repo, "config.example.zon"), "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("//")) {
      comment.push(line.replace(/^\/\/\s?/, ""));
      continue;
    }
    const open = line.match(/^\.(\w+) = \.\{$/);
    if (open) {
      prefix.push(open[1]);
      comment = [];
      continue;
    }
    if (line === "}," && prefix.length) {
      prefix.pop();
      continue;
    }
    const field = line.match(/^\.(\w+) = (.*),$/);
    if (field) {
      const name = [...prefix, field[1]].join(".");
      const value = field[2] === ".{}" ? "none" : `\`${field[2]}\``;
      rows.push(`| \`${name}\` | ${value} | ${comment.join(" ")} |`);
      comment = [];
    } else if (line === "" || line === ".{" || line === "}") {
      // The file's own introduction is not a setting's.
      if (line === ".{") comment = [];
    }
  }
  return `# config.zon settings

Every setting of Inkhold's config file, its default, and what it changes.
Every setting is optional: one left out takes its default. Copy
[\`config.example.zon\`](https://github.com/m00qek/inkhold/blob/main/config.example.zon),
which lists them all, and change what you need.

${NOTE("config.example.zon")}
| Setting | Default | What it does |
|---|---|---|
${rows.join("\n")}

A setting inside \`tls\` is written in its own block:

\`\`\`zig
.tls = .{
    .enabled = true,
    .cert_path = "/etc/inkhold/cert.pem",
    .key_path = "/etc/inkhold/key.pem",
},
\`\`\`

A change takes effect when Inkhold restarts.
`;
}

function commandLine() {
  const src = readFileSync(join(repo, "backend/cli.zig"), "utf8");
  const at = src.indexOf("pub fn writeHelp(");
  const lines = [];
  for (const line of src.slice(at).split("\n").slice(2)) {
    const m = line.match(/^\s*\\\\(.*)$/);
    if (!m) {
      if (lines.length) break;
      continue;
    }
    lines.push(m[1].replace(/\{\[\w+\]s\}/g, "").replace(/\{\{/g, "{").replace(/\}\}/g, "}"));
  }
  return `# Command line

Every command and option of the \`inkhold\` program, as \`inkhold --help\`
prints it. The server is \`inkhold\` with no command; the others manage
accounts and backups, and work beside a running server (all but \`restore\`).

${NOTE("backend/cli.zig")}
\`\`\`text
${lines.join("\n").trimEnd()}
\`\`\`

In Docker, run a command inside the container:

\`\`\`sh
docker exec inkhold /inkhold --config=/etc/inkhold/config.zon users list
\`\`\`
`;
}

let stale = 0;
for (const [page, body] of [
  ["content/manual/configuration.md", configuration()],
  ["content/manual/command-line.md", commandLine()],
]) {
  const path = join(docs, page);
  const next = withBody(path, body);
  if (readFileSync(path, "utf8") === next) continue;
  if (check) {
    console.error(`generate: ${page} is out of date; run make -C docs generate`);
    stale++;
  } else {
    writeFileSync(path, next);
    console.log(`generate: wrote ${page}`);
  }
}
if (stale) process.exit(1);
