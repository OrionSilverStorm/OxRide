// npm test: backend tests (pytest) + frontend type check, on Windows, macOS and Linux.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const isWin = process.platform === "win32";
const python = path.join(root, ".venv", isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");

if (!existsSync(python)) {
  console.error(`No Python venv found at ${python}. See scripts/dev-api.mjs for setup.`);
  process.exit(1);
}

function run(label, cmd, args, cwd) {
  console.log(`\n== ${label} ==`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: isWin && cmd === "npx" });
  return r.status === 0;
}

const results = [
  run("Backend tests", python, ["-m", "pytest", path.join("backend", "tests"), "-q"], root),
  run("Frontend types", "npx", ["next", "typegen"], path.join(root, "frontend")) &&
    run("Frontend type check", "npx", ["tsc", "--noEmit"], path.join(root, "frontend")),
];

if (results.every(Boolean)) {
  console.log("\nAll good.");
} else {
  console.error("\nSomething failed: see above.");
  process.exit(1);
}
