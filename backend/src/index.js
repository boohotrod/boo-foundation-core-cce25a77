import express from "express";
import cors from "cors";
import morgan from "morgan";
import os from "os";
import { query, ping, migrateAndSeed } from "./db.js";
import { runBackup, getBackupStatus, startScheduler } from "./backup.js";
import { signToken, verifyPassword, verifyToken } from "./auth.js";
import {
  runAllowed,
  listLogs,
  listAllowedCommands,
  getRepoConfig,
} from "./deployment.js";

const PORT = Number(process.env.PORT || 4000);
const APP_VERSION = "0.2.0";
const APP_BUILD = "real-auth";
const APP_ENV = process.env.NODE_ENV || "production";
const startedAt = Date.now();

const DEFAULT_SETTINGS = [
  { key: "site_name", value: "BBS Core" },
  { key: "timezone", value: "UTC" },
  { key: "log_level", value: "info" },
  { key: "retain_rollbacks", value: "10" },
];

// ── Structured logger ──────────────────────────────────────────────────────
function log(level, event, extra = {}) {
  const entry = {
    level,
    event,
    service: "backend",
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else console.log(line);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim();
}

async function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "authentication required" });

    const payload = verifyToken(token);
    const [user] = await query(
      "SELECT id, username, email, role FROM users WHERE id = ? LIMIT 1",
      [Number(payload.sub)]
    );
    if (!user) return res.status(401).json({ error: "invalid session" });

    req.user = user;
    next();
  } catch (e) {
    log("warn", "auth_rejected", { path: req.path, reason: e?.message });
    res.status(401).json({ error: "invalid or expired session" });
  }
}

// ── Health ──────────────────────────────────────────────────────────────────
app.get("/api/health", async (_req, res) => {
  const db = await ping();
  res.status(db ? 200 : 503).json({
    status: db ? "ok" : "error",
    service: "backend",
    version: APP_VERSION,
    build: APP_BUILD,
    environment: APP_ENV,
    database: db ? "connected" : "disconnected",
    uptime: (Date.now() - startedAt) / 1000,
    timestamp: new Date().toISOString(),
  });
});

// ── Auth ────────────────────────────────────────────────────────────────────
app.post("/api/login", async (req, res, next) => {
  try {
    const login = String(req.body?.username || req.body?.email || "").trim();
    const password = String(req.body?.password || "");

    if (!login || !password) {
      log("warn", "login_failed", { reason: "missing_credentials" });
      return res.status(400).json({ error: "Felhasználónév/email és jelszó szükséges." });
    }

    const [user] = await query(
      "SELECT id, username, email, password_hash, role FROM users WHERE username = ? OR email = ? LIMIT 1",
      [login, login]
    );

    if (!user || !verifyPassword(password, user.password_hash)) {
      log("warn", "login_failed", { login, reason: "invalid_credentials" });
      return res.status(401).json({ error: "Hibás felhasználónév/email vagy jelszó." });
    }

    const safeUser = { id: user.id, username: user.username, email: user.email, role: user.role };
    log("info", "login_success", { userId: user.id, username: user.username });
    res.json({ token: signToken(safeUser), user: safeUser });
  } catch (e) {
    next(e);
  }
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post("/api/logout", requireAuth, (req, res) => {
  log("info", "logout", { userId: req.user.id, username: req.user.username });
  res.json({ loggedOut: true });
});

app.use("/api", requireAuth);

// ── System status ───────────────────────────────────────────────────────────
app.get("/api/system/status", async (_req, res) => {
  const db = await ping();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg()[0];
  const cpuCount = os.cpus().length || 1;
  res.json({
    cpu: Math.min(100, (load / cpuCount) * 100),
    memory: { used: totalMem - freeMem, total: totalMem },
    disk: { used: 0, total: 0 },
    database: db ? "connected" : "disconnected",
    uptime: (Date.now() - startedAt) / 1000,
    version: APP_VERSION,
    build: APP_BUILD,
    environment: APP_ENV,
  });
});

// ── Backup ──────────────────────────────────────────────────────────────────
app.post("/api/backup/run", async (_req, res) => {
  log("info", "backup_requested", { trigger: "manual" });
  const result = await runBackup({ trigger: "manual", logger: log });
  res.status(result.status === "ok" ? 200 : 500).json(result);
});

app.get("/api/backup/status", (_req, res) => {
  res.json(getBackupStatus());
});

// ── Plugins ─────────────────────────────────────────────────────────────────
app.get("/api/plugins", async (_req, res, next) => {
  try {
    const rows = await query(
      "SELECT id, name, description, version, enabled FROM plugins ORDER BY id"
    );
    res.json(rows.map((r) => ({ ...r, enabled: !!r.enabled })));
  } catch (e) {
    next(e);
  }
});

app.post("/api/plugins/toggle", async (req, res, next) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Valid plugin id is required." });
    }
    const [existing] = await query("SELECT id, enabled FROM plugins WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Plugin not found." });
    const next = existing.enabled ? 0 : 1;
    await query("UPDATE plugins SET enabled = ? WHERE id = ?", [next, id]);
    const [updated] = await query(
      "SELECT id, name, description, version, enabled FROM plugins WHERE id = ?",
      [id]
    );
    res.json({ ...updated, enabled: !!updated.enabled });
  } catch (e) {
    next(e);
  }
});

// ── Settings ────────────────────────────────────────────────────────────────
async function listSettings() {
  const rows = await query("SELECT `key`, value FROM app_settings ORDER BY `key`");
  return rows.length > 0 ? rows : DEFAULT_SETTINGS;
}

async function saveSettingsPayload(payload) {
  if (!Array.isArray(payload)) {
    const err = new Error("Settings payload must be an array.");
    err.status = 400;
    throw err;
  }
  for (const item of payload) {
    if (!item || typeof item.key !== "string" || typeof item.value !== "string") {
      const err = new Error("Each setting requires {key, value}.");
      err.status = 400;
      throw err;
    }
    if (item.key.length < 1 || item.key.length > 128 || item.value.length > 4096) {
      const err = new Error("Setting too large or invalid.");
      err.status = 400;
      throw err;
    }
    await query(
      "INSERT INTO app_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [item.key, item.value]
    );
  }
  return listSettings();
}

app.get("/api/settings", async (_req, res, next) => {
  try {
    res.json(await listSettings());
  } catch (e) {
    next(e);
  }
});

app.post("/api/settings", async (req, res, next) => {
  try {
    res.json(await saveSettingsPayload(req.body));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

app.put("/api/settings", async (req, res, next) => {
  try {
    res.json(await saveSettingsPayload(req.body));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// ── Rollback points ─────────────────────────────────────────────────────────
app.get("/api/rollback-points", async (_req, res, next) => {
  try {
    const rows = await query(
      "SELECT id, label, size_bytes, created_at FROM rollback_points ORDER BY created_at DESC"
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        label: r.label,
        size_bytes: Number(r.size_bytes),
        created_at:
          r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      }))
    );
  } catch (e) {
    next(e);
  }
});

// ── Deployment Center (SuperAdmin only) ────────────────────────────────────
function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== "superadmin") {
    return res.status(403).json({ error: "SuperAdmin jogosultság szükséges." });
  }
  next();
}

async function safeRun(actionId, user) {
  return runAllowed(actionId, { user });
}

app.get("/api/deployment/status", requireSuperAdmin, async (req, res) => {
  const repo = getRepoConfig();
  const [head, branch, remote, status] = await Promise.all([
    safeRun("git.rev-parse", req.user),
    safeRun("git.branch", req.user),
    safeRun("git.log-remote", req.user),
    safeRun("git.status", req.user),
  ]);
  res.json({
    app: {
      version: APP_VERSION,
      build: APP_BUILD,
      environment: APP_ENV,
      uptime: (Date.now() - startedAt) / 1000,
      timestamp: new Date().toISOString(),
    },
    repo: {
      url: repo.repoUrl,
      path: repo.repoPath,
      configured: Boolean(repo.repoUrl),
      localCommit: head.ok ? head.output.trim() : null,
      branch: branch.ok ? branch.output.trim() : null,
      remoteLatest: remote.ok ? remote.output.trim() : null,
      workingTree: status.ok ? status.output.trim() : null,
      checks: { head, branch, remote, status },
    },
  });
});

app.get("/api/deployment/logs", requireSuperAdmin, async (_req, res, next) => {
  try {
    res.json(await listLogs(25));
  } catch (e) { next(e); }
});

app.get("/api/deployment/allowed", requireSuperAdmin, (_req, res) => {
  res.json(listAllowedCommands());
});

app.post("/api/deployment/check-update", requireSuperAdmin, async (req, res) => {
  const fetched = await safeRun("git.fetch", req.user);
  const [head, remote] = await Promise.all([
    safeRun("git.rev-parse", req.user),
    safeRun("git.log-remote", req.user),
  ]);
  const localHash = head.ok ? head.output.trim() : null;
  const remoteFirstWord = remote.ok ? remote.output.trim().split(/\s+/)[0] : null;
  const updateAvailable =
    !!(localHash && remoteFirstWord) && !localHash.startsWith(remoteFirstWord);
  res.json({
    ok: fetched.ok && head.ok && remote.ok,
    updateAvailable,
    local: localHash,
    remote: remote.ok ? remote.output.trim() : null,
    fetch: fetched,
  });
});

app.post("/api/deployment/backup", requireSuperAdmin, async (req, res) => {
  res.json(await safeRun("backup", req.user));
});

app.post("/api/deployment/pull", requireSuperAdmin, async (req, res) => {
  res.json(await safeRun("git.pull", req.user));
});

app.post("/api/deployment/rebuild-frontend", requireSuperAdmin, async (req, res) => {
  res.json(await safeRun("docker.frontend", req.user));
});

app.post("/api/deployment/rebuild-backend", requireSuperAdmin, async (req, res) => {
  res.json(await safeRun("docker.backend", req.user));
});

app.post("/api/deployment/restart", requireSuperAdmin, async (req, res) => {
  res.json(await safeRun("docker.up", req.user));
});

app.post("/api/deployment/healthcheck", requireSuperAdmin, async (req, res) => {
  res.json(await safeRun("docker.ps", req.user));
});

// ── Error handler ───────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log("error", "api_error", {
    path: req.path,
    method: req.method,
    message: err?.message,
    stack: err?.stack,
  });
  res.status(500).json({ error: "Internal server error" });
});

// ── Process-level safety net ───────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  log("error", "uncaught_exception", { message: err?.message, stack: err?.stack });
});
process.on("unhandledRejection", (reason) => {
  log("error", "unhandled_rejection", { reason: String(reason) });
});

// ── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  log("info", "server_starting", { port: PORT, version: APP_VERSION, build: APP_BUILD });

  let dbReady = false;
  for (let i = 0; i < 30; i++) {
    if (await ping()) {
      dbReady = true;
      break;
    }
    log("warn", "db_waiting", { attempt: i + 1 });
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (dbReady) log("info", "db_connected");
  else log("error", "db_connect_failed", { attempts: 30 });

  try {
    await migrateAndSeed();
    log("info", "db_schema_ready");
  } catch (e) {
    log("error", "db_migration_failed", { message: e?.message, stack: e?.stack });
  }

  app.listen(PORT, () => {
    log("info", "server_started", { port: PORT });
    startScheduler(log);
  });
}

boot();
