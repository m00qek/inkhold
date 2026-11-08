import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

// Starts the REAL server, the built binary serving the built SPA, on a fresh
// install, and hands the tests its first-run admin password. Nothing is mocked.
//
//   INKHOLD_BIN  the server binary (default ../zig-out/bin/inkhold)
//   INKHOLD_WEB  the built SPA (default dist)
//   SMOKE_PORT   its port (default 4339, as in playwright.smoke.config.ts)
export default async function startServer(): Promise<() => void> {
  const bin = resolve(process.env.INKHOLD_BIN ?? "../zig-out/bin/inkhold");
  const web = resolve(process.env.INKHOLD_WEB ?? "dist");
  const port = Number(process.env.SMOKE_PORT ?? 4339);
  const dir = mkdtempSync(join(tmpdir(), "inkhold-smoke-"));
  writeFileSync(
    join(dir, "config.zon"),
    `.{ .host = "127.0.0.1", .port = ${port}, .db_path = "${dir}/inkhold.db", ` +
      `.cred_key_path = "${dir}/cred.key", .data_dir = "${dir}/data", ` +
      `.web_dir = "${web}", .admin_email = "admin@home.lan" }\n`,
  );

  const server = spawn(bin, [`--config=${dir}/config.zon`, "serve"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  const log: string[] = [];
  const password = await new Promise<string>((done, fail) => {
    let temp = "";
    const timer = setTimeout(() => fail(new Error(`server did not start:\n${log.join("\n")}`)), 30_000);
    server.on("exit", (code) => fail(new Error(`server exited (${code}):\n${log.join("\n")}`)));
    // Read every line, then and later: a full pipe would block the server.
    createInterface({ input: server.stderr! }).on("line", (line) => {
      log.push(line);
      temp = /temporary password: (\S+)/.exec(line)?.[1] ?? temp;
      if (line.includes("listening on")) {
        clearTimeout(timer);
        temp ? done(temp) : fail(new Error(`no first-run password:\n${log.join("\n")}`));
      }
    });
  });
  process.env.SMOKE_PASSWORD = password;

  return () => {
    server.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  };
}
