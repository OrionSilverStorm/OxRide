// Starts the FastAPI backend with the repo's .venv, on Windows, macOS and Linux.
// Windows keeps venv programs in .venv\Scripts, the others in .venv/bin.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const isWin = process.platform === "win32";
const python = path.join(root, ".venv", isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");

if (!existsSync(python)) {
  console.error(`No Python venv found at ${python}`);
  console.error("Create it from the repo root:");
  console.error(isWin
    ? "  python -m venv .venv && .venv\\Scripts\\pip install -r backend\\requirements.txt"
    : "  python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt");
  process.exit(1);
}

const child = spawn(python, ["-m", "uvicorn", "main:app", "--reload", "--port", "8000"], {
  cwd: path.join(root, "backend"),
  stdio: "inherit",
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
