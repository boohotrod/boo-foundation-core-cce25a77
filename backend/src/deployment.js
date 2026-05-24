// Deployment Center — safe allowlisted command runner for SuperAdmin actions.
// NEVER accept user-provided command strings. Every action maps to a fixed
// entry in ALLOWED_COMMANDS below. Arguments are passed as an array (no shell).

import { spawn } from "child_process";
import { query } from "./db.js";

const REPO_PATH = process.env.GIT_REPO_PATH || "/opt/boo-foundation-core";
const GITHUB_REPO_URL =
  process.env.GITHUB_REPO_URL || "https://github.com/boohotrod/boo-foundation-core.git";
const COMMAND_TIMEOUT_MS = 120_000;

// Fixed allowlist. Key = action id used by API. Value = { bin, args, cwd? }.
export const ALLOWED_COMMANDS = {
  "git.status":        { bin: "git", args: ["status", "--short"], cwd: REPO_PATH },
  "git.rev-parse":     { bin: "git", args: ["rev-parse", "HEAD"], cwd: REPO_PATH },
  "git.branch":        { bin: "git", args: ["branch", "--show-current"], cwd: REPO_PATH },
  "git.fetch":         { bin: "git", args: ["fetch", "origin"], cwd: REPO_PATH },
  "git.log-remote":    { bin: "git", args: ["log", "origin/main", "-1", "--oneline"], cwd: REPO_PATH },
  "git.pull":          { bin: "git", args: ["pull"], cwd: REPO_PATH },
  "backup":            { bin: "./scripts/backup-db.sh", args: [], cwd: REPO_PATH },
  "docker.frontend":   { bin: "docker", args: ["compose", "up", "-d", "--build", "frontend"], cwd: REPO_PATH },
  "docker.backend":    { bin: "docker", args: ["compose", "up", "-d", "--build", "backend"], cwd: REPO_PATH },
  "docker.up":         { bin: "docker", args: ["compose", "up", "-d"], cwd: REPO_PATH },
  "docker.ps":         { bin: "docker", args: ["compose", "ps"], cwd: REPO_PATH },
};

export function listAllowedCommands() {
  return Object.entries(ALLOWED_COMMANDS).map(([id, c]) => ({
    id,
    command: `${c.bin} ${c.args.join(" ")}`.trim(),
    cwd: c.cwd || process.cwd(),
  }));
}

function trim(s, max = 4000) {
  const str = String(s || "");
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n…[truncated ${str.length - max} bytes]`;
}

async function ensureLogTable() {
  await query(
    `CREATE TABLE IF NOT EXISTS deployment_logs (
       id INT AUTO_INCREMENT PRIMARY KEY,
       user_id INT NULL,
       username VARCHAR(128) NULL,
       action VARCHAR(64) NOT NULL,
       started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       ended_at TIMESTAMP NULL,
       success TINYINT(1) NOT NULL DEFAULT 0,
       exit_code INT NULL,
       output TEXT NULL,
       error TEXT NULL
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

let tableReady = false;
async function logRun(entry) {
  try {
    if (!tableReady) {
      await ensureLogTable();
      tableReady = true;
    }
    await query(
      `INSERT INTO deployment_logs
       (user_id, username, action, started_at, ended_at, success, exit_code, output, error)
       VALUES (?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), ?, ?, ?, ?)`,
      [
        entry.userId || null,
        entry.username || null,
        entry.action,
        Math.floor(entry.startedAt / 1000),
        Math.floor(entry.endedAt / 1000),
        entry.success ? 1 : 0,
        entry.exitCode,
        trim(entry.output),
        trim(entry.error),
      ]
    );
  } catch (e) {
    // Logging failure must not break the deployment response.
    console.error(JSON.stringify({ level: "error", event: "deployment_log_failed", message: e?.message }));
  }
}

export async function listLogs(limit = 25) {
  if (!tableReady) {
    await ensureLogTable();
    tableReady = true;
  }
  const rows = await query(
    `SELECT id, username, action, started_at, ended_at, success, exit_code, output, error
     FROM deployment_logs ORDER BY id DESC LIMIT ?`,
    [Number(limit) || 25]
  );
  return rows.map((r) => ({
    ...r,
    success: !!r.success,
    started_at: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
    ended_at: r.ended_at instanceof Date ? r.ended_at.toISOString() : r.ended_at,
  }));
}

export function runAllowed(actionId, { user } = {}) {
  const cmd = ALLOWED_COMMANDS[actionId];
  if (!cmd) {
    return Promise.resolve({
      ok: false,
      action: actionId,
      exitCode: null,
      output: "",
      error: `Tiltott vagy ismeretlen művelet: ${actionId}`,
      durationMs: 0,
    });
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;

    let child;
    try {
      child = spawn(cmd.bin, cmd.args, {
        cwd: cmd.cwd,
        env: process.env,
        shell: false, // CRITICAL: no shell interpretation, ever.
      });
    } catch (e) {
      const endedAt = Date.now();
      const result = {
        ok: false,
        action: actionId,
        exitCode: null,
        output: "",
        error: `Indítás sikertelen: ${e?.message || e}`,
        durationMs: endedAt - startedAt,
      };
      logRun({
        userId: user?.id, username: user?.username, action: actionId,
        startedAt, endedAt, success: false, exitCode: null,
        output: "", error: result.error,
      });
      return resolve(result);
    }

    const timeout = setTimeout(() => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch { /* noop */ }
    }, COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const endedAt = Date.now();
      const result = {
        ok: false,
        action: actionId,
        exitCode: null,
        output: trim(stdout),
        error: trim(stderr || err?.message || "Ismeretlen hiba"),
        durationMs: endedAt - startedAt,
      };
      logRun({
        userId: user?.id, username: user?.username, action: actionId,
        startedAt, endedAt, success: false, exitCode: null,
        output: stdout, error: stderr || err?.message,
      });
      resolve(result);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const endedAt = Date.now();
      const ok = code === 0;
      const result = {
        ok,
        action: actionId,
        exitCode: code,
        output: trim(stdout),
        error: trim(stderr),
        durationMs: endedAt - startedAt,
      };
      logRun({
        userId: user?.id, username: user?.username, action: actionId,
        startedAt, endedAt, success: ok, exitCode: code,
        output: stdout, error: stderr,
      });
      resolve(result);
    });
  });
}

export function getRepoConfig() {
  return { repoUrl: GITHUB_REPO_URL, repoPath: REPO_PATH };
}
