// The tests that passed only on their retry, from Playwright's JSON report:
// one warning each (a GitHub annotation in CI) and a list in the job summary.
// A flake still passes the run; this keeps it from passing unseen.
//
//   node scripts/flaky-report.mjs [test-results/report.json]
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const path = process.argv[2] ?? "test-results/report.json";
if (!existsSync(path)) {
  console.log(`no report at ${path}`);
  process.exit(0);
}

const flaky = [];
const walk = (suite, titles) => {
  const here = suite.title ? [...titles, suite.title] : titles;
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      if (t.status === "flaky") flaky.push({ title: [...here, spec.title].join(" › "), file: spec.file, line: spec.line });
    }
  }
  for (const child of suite.suites ?? []) walk(child, here);
};
for (const suite of JSON.parse(readFileSync(path, "utf8")).suites ?? []) walk(suite, []);

if (flaky.length === 0) {
  console.log("no flaky tests");
  process.exit(0);
}
for (const f of flaky) console.log(`::warning file=webapp/tests/e2e/${f.file},line=${f.line}::flaky (passed on retry): ${f.title}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${flaky.length} flaky test(s), passed only on retry\n\n${flaky.map((f) => `- ${f.title}`).join("\n")}\n`);
}
