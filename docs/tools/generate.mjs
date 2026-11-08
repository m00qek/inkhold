// Writes the reference pages that must never drift from the code
// (content/contributor/documentation-rules.md, "Generated, not written"):
//
//   manual/configuration.md   each setting with its real default (backend/config.zig) and its
//                             comment (config.example.zon); fails when the two disagree on the set
//   manual/command-line.md    from backend/cli.zig's help text
//   contributor/http-api.md   from backend/routes.zig's route table
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

/** Each setting's real default, from the struct the server parses (backend/config.zig). */
function defaults() {
  const src = readFileSync(join(repo, "backend/config.zig"), "utf8");
  const structs = {};
  for (const m of src.matchAll(/pub const (\w+) = struct \{([\s\S]*?)\n\};/g)) {
    structs[m[1]] = [...m[2].matchAll(/^    (\w+): ([^=\n]+?) = ([^\n]+),$/gm)].map((f) => ({ name: f[1], type: f[2].trim(), value: f[3].trim() }));
  }
  const out = {};
  const walk = (struct, prefix) => {
    for (const f of structs[struct] ?? []) {
      if (structs[f.type]) walk(f.type, `${prefix}${f.name}.`);
      else out[`${prefix}${f.name}`] = f.value;
    }
  };
  walk("Config", "");
  return out;
}

const shown = (v) => (v === ".{}" || v === "&.{}" ? "none" : `\`${v.replace(/_/g, "")}\``);

function configuration() {
  const real = defaults();
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
      if (!(name in real)) throw new Error(`config.example.zon: ${name} is not a setting in backend/config.zig`);
      rows.push(`| \`${name}\` | ${shown(real[name])} | ${comment.join(" ")} |`);
      delete real[name];
      comment = [];
    } else if (line === "" || line === ".{" || line === "}") {
      // The file's own introduction is not a setting's.
      if (line === ".{") comment = [];
    }
  }
  const missing = Object.keys(real);
  if (missing.length) throw new Error(`config.example.zon lacks ${missing.join(", ")} (backend/config.zig has them)`);
  return `# config.zon settings

Every setting of Inkhold's config file, its default, and what it changes.
Every setting is optional: one left out takes its default. Copy
[\`config.example.zon\`](https://github.com/m00qek/inkhold/blob/main/config.example.zon),
which lists them all, and change what you need.

${NOTE("config.example.zon and backend/config.zig")}
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

function httpApi() {
  const src = readFileSync(join(repo, "backend/routes.zig"), "utf8");
  const table = src.slice(src.indexOf("pub const routes = [_]router.Route{"));
  const groups = [];
  let group = { title: "General", rows: [] };
  for (const line of table.split("\n")) {
    const head = line.match(/^\s*\/\/ --- (.+?) ---\s*$/);
    if (head) {
      if (group.rows.length) groups.push(group);
      group = { title: head[1].replace(/\s*\(DESIGN\.md[^)]*\)/, "").replace(/\s*\([^)]*\)$/, ""), rows: [] };
      continue;
    }
    // Each field on its own: their order varies from route to route.
    const method = line.match(/\.method = \.(\w+)/);
    if (!method) continue;
    const path = line.match(/\.path = "([^"]+)"/);
    const scope = line.match(/\.scopes = &\.\{([^}]*)\}/);
    const handler = line.match(/\.handler = ([\w.]+)/);
    if (!path || !scope || !handler) throw new Error(`routes.zig: can't read the route: ${line.trim()}`);
    const r = [null, method[1], path[1], scope[1], handler[1]];
    const scopes = r[3].split(",").map((x) => x.trim().replace(/^\./, "")).filter(Boolean);
    const flags = [];
    if (/\.require_admin = true/.test(line)) flags.push("elevated admin");
    if (/\.read_only = true/.test(line)) flags.push("read-only");
    if (/\.manual_db_lock = true/.test(line)) flags.push("streams");
    if (/\.held = true/.test(line)) flags.push("held stream");
    const rl = line.match(/\.rate_limit = \.\{ \.max = (\d+), \.window_s = (\d+), \.by = \.(\w+) \}/);
    if (rl) flags.push(`${rl[1]} per ${rl[2]} s by ${rl[3]}`);
    group.rows.push(`| ${r[1]} | \`${r[2]}\` | ${scopes.join(", ")} | \`${r[4]}\` | ${flags.join("; ")} |`);
  }
  if (group.rows.length) groups.push(group);
  const count = groups.reduce((n, g) => n + g.rows.length, 0);
  const declared = (table.match(/\.method = \./g) ?? []).length;
  if (count !== declared) throw new Error(`routes.zig: read ${count} of ${declared} routes`);
  return `# HTTP API

Every route Inkhold serves, ${count} of them, in the order of the route table.
**Who** is the caller's scope: \`public\` needs no session, \`device\` is a
tablet, \`controlplane\` the browser app, \`pending\` a first sign-in that
must still change its password. A caller outside a route's scopes gets 403.
**Read-only** routes run on a pooled reader, **streams** take the database lock
only around their own reads and writes ([Threads and locks](@/contributor/threads-and-locks.md)).
The device routes' behaviour is in [Device protocol](@/contributor/device-protocol.md).

${NOTE("backend/routes.zig")}
${groups.map((g) => `## ${g.title}\n\n| Method | Path | Who | Handler | Notes |\n|---|---|---|---|---|\n${g.rows.join("\n")}\n`).join("\n")}`;
}

let stale = 0;
for (const [page, body] of [
  ["content/manual/configuration.md", configuration()],
  ["content/manual/command-line.md", commandLine()],
  ["content/contributor/http-api.md", httpApi()],
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
