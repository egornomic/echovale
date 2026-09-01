import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";

const devCommand = ["npm", "run", "dev"];
const startupTimeoutMs = 60_000;

const worktreePath = realpathSync(process.env.CODEX_WORKTREE_PATH ?? process.cwd());
const sourceTreePath = realpathSync(process.env.CODEX_SOURCE_TREE_PATH ?? worktreePath);
const commonGitResult = spawnSync(
  "git",
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  { cwd: worktreePath, encoding: "utf8" },
);
if (commonGitResult.status !== 0) {
  throw new Error(`Could not resolve the Git common directory: ${commonGitResult.stderr}`);
}
const commonGitPath = realpathSync(commonGitResult.stdout.trim());
const sharedEnvPath = join(dirname(commonGitPath), ".env");
const mainDatabasePath = join(commonGitPath, "codex", "feedfold.db");
if (existsSync(sharedEnvPath)) process.loadEnvFile(sharedEnvPath);
const runtimePath = join(worktreePath, ".codex", "runtime");
const worktreeDatabasePath = join(runtimePath, "feedfold.db");
const statePath = join(runtimePath, "dev-server.json");
const logPath = join(runtimePath, "dev-server.log");
const operation = process.argv[2] ?? "start";
const shouldOpen = process.argv.includes("--open");
const shouldCopy = process.argv.includes("--copy");

function readState() {
  if (!existsSync(statePath)) return null;
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (
    !Number.isInteger(state.pid) ||
    state.worktreePath !== worktreePath ||
    !Array.isArray(state.command) ||
    typeof state.readyUrl !== "string" ||
    typeof state.healthUrl !== "string"
  ) {
    throw new Error(`Invalid or foreign dev-server state at ${statePath}`);
  }
  return state;
}

function removeState() {
  if (existsSync(statePath)) unlinkSync(statePath);
}

function isAlive(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function assertOwnedProcess(state) {
  if (process.platform === "win32" || !isAlive(state.pid)) return;
  const result = spawnSync("ps", ["-ww", "-p", String(state.pid), "-o", "command="], {
    encoding: "utf8",
  });
  if (result.status === 0 && !result.stdout.includes(basename(state.command[0]))) {
    throw new Error(`Refusing to stop unrelated process ${state.pid}`);
  }
}

function signalProcessGroup(pid, signal, force = false) {
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    spawnSync("taskkill", args, { stdio: "ignore" });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitUntilStopped(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(100);
  }
  return !isAlive(pid);
}

async function stop() {
  const state = readState();
  if (!state) {
    console.log("Dev server is not running.");
    return;
  }
  if (!isAlive(state.pid)) {
    removeState();
    console.log("Removed stale dev-server state.");
    return;
  }

  assertOwnedProcess(state);
  signalProcessGroup(state.pid, "SIGTERM");
  if (!(await waitUntilStopped(state.pid, 5_000))) {
    signalProcessGroup(state.pid, "SIGKILL", true);
  }
  if (!(await waitUntilStopped(state.pid, 2_000))) {
    throw new Error(`Could not stop dev-server process ${state.pid}`);
  }
  removeState();
  console.log(`Stopped dev server at ${state.readyUrl}`);
}

function logTail() {
  if (!existsSync(logPath)) return "No dev-server log was written.";
  return readFileSync(logPath, "utf8").slice(-4_000);
}

async function waitForResponse(url, label) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) return;
    } catch {
      // Retry until the bounded startup deadline.
    }
    await delay(250);
  }
  throw new Error(`${label} did not become ready.\n${logTail()}`);
}

async function waitUntilReady(state) {
  const exited = new Promise((_, reject) => {
    const interval = setInterval(() => {
      if (!isAlive(state.pid)) {
        clearInterval(interval);
        reject(new Error(`Dev server exited during startup.\n${logTail()}`));
      }
    }, 100);
    interval.unref();
  });
  await Promise.race([
    Promise.all([
      waitForResponse(state.healthUrl, "API health endpoint"),
      waitForResponse(state.readyUrl, "Frontend"),
    ]),
    exited,
  ]);
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a development port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function openBrowser(url) {
  const commands = {
    darwin: ["open", url],
    linux: ["xdg-open", url],
    win32: ["cmd", "/c", "start", "", url],
  };
  const command = commands[process.platform];
  if (!command) throw new Error(`Cannot open a browser on ${process.platform}`);
  const result = spawnSync(command[0], command.slice(1), { stdio: "ignore" });
  if (result.status !== 0) throw new Error(`Could not open ${url} in a browser`);
}

function copyUrl(url) {
  if (process.platform !== "darwin") {
    throw new Error(`Cannot copy a URL to the clipboard on ${process.platform}`);
  }
  const result = spawnSync("pbcopy", { input: url, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Could not copy the dev-server URL");
}

async function copyMainDatabase() {
  if (existsSync(worktreeDatabasePath)) return;
  const database = new Database(mainDatabasePath, { readonly: true, fileMustExist: true });
  try {
    await database.backup(worktreeDatabasePath);
  } finally {
    database.close();
  }
}

async function start() {
  const existingState = readState();
  if (existingState && isAlive(existingState.pid)) {
    assertOwnedProcess(existingState);
    if (shouldOpen) openBrowser(existingState.readyUrl);
    if (shouldCopy) copyUrl(existingState.readyUrl);
    console.log(`Dev server is already running at ${existingState.readyUrl}`);
    return;
  }
  if (existingState) removeState();

  const [apiPort, webPort] = await Promise.all([availablePort(), availablePort()]);
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const readyUrl = `http://localhost:${webPort}/`;
  const healthUrl = `${apiOrigin}/health`;
  mkdirSync(runtimePath, { recursive: true });
  await copyMainDatabase();
  const logDescriptor = openSync(logPath, "w");
  const child = spawn(devCommand[0], devCommand.slice(1), {
    cwd: worktreePath,
    detached: true,
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: basename(sourceTreePath),
      FEEDFOLD_DEV_API_ORIGIN: apiOrigin,
      FEEDFOLD_DEV_PORT: String(webPort),
      DATABASE_PATH: worktreeDatabasePath,
      PORT: String(apiPort),
    },
    stdio: ["ignore", logDescriptor, logDescriptor],
    windowsHide: true,
  });
  closeSync(logDescriptor);
  if (!child.pid) throw new Error("Dev server did not return a process ID");

  const state = {
    pid: child.pid,
    worktreePath,
    command: devCommand,
    readyUrl,
    healthUrl,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  child.unref();

  try {
    await waitUntilReady(state);
  } catch (error) {
    await stop();
    throw error;
  }
  if (shouldOpen) openBrowser(readyUrl);
  if (shouldCopy) copyUrl(readyUrl);
  console.log(`Dev server is ready at ${readyUrl}`);
}

switch (operation) {
  case "start":
    await start();
    break;
  case "stop":
    await stop();
    break;
  case "restart":
    await stop();
    await start();
    break;
  default:
    throw new Error(`Unknown dev-server operation: ${operation}`);
}
