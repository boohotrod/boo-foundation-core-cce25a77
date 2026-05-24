import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { RequireAuth } from "@/components/RequireAuth";
import { api, ApiError, getAuthSession } from "@/lib/api";
import {
  RefreshCw,
  Download,
  GitPullRequestArrow,
  Hammer,
  Server,
  RotateCw,
  HeartPulse,
  Loader2,
} from "lucide-react";

export const Route = createFileRoute("/deployment")({
  head: () => ({ meta: [{ title: "Deployment Center — BBS Core" }] }),
  component: () => (
    <RequireAuth>
      <DeploymentPage />
    </RequireAuth>
  ),
});

interface CommandResult {
  ok: boolean;
  action?: string;
  exitCode: number | null;
  output: string;
  error: string;
  durationMs?: number;
}

interface DeploymentStatus {
  app: {
    version: string;
    build: string;
    environment: string;
    uptime: number;
    timestamp: string;
  };
  repo: {
    url: string;
    path: string;
    configured: boolean;
    localCommit: string | null;
    branch: string | null;
    remoteLatest: string | null;
    workingTree: string | null;
  };
}

type ActionKey =
  | "check-update"
  | "backup"
  | "pull"
  | "rebuild-frontend"
  | "rebuild-backend"
  | "restart"
  | "healthcheck";

const ACTION_META: Record<ActionKey, { label: string; icon: typeof RefreshCw; confirm?: string }> = {
  "check-update": { label: "Frissítés keresése", icon: RefreshCw },
  backup: { label: "Mentés készítése", icon: Download },
  pull: {
    label: "Legújabb verzió letöltése",
    icon: GitPullRequestArrow,
    confirm:
      "Figyelem: a letöltés megváltoztathatja a futó rendszert. Ajánlott előbb mentést készíteni. Folytatja?",
  },
  "rebuild-frontend": {
    label: "Frontend újraépítése",
    icon: Hammer,
    confirm: "A frontend konténer újraépítése néhány percig tarthat. Folytatja?",
  },
  "rebuild-backend": {
    label: "Backend újraépítése",
    icon: Server,
    confirm:
      "A backend konténer újraépítése rövid leállást okozhat. Folytatja?",
  },
  restart: {
    label: "Rendszer újraindítása",
    icon: RotateCw,
    confirm: "A teljes stack újraindítása következik. Folytatja?",
  },
  healthcheck: { label: "Healthcheck futtatása", icon: HeartPulse },
};

function DeploymentPage() {
  const navigate = useNavigate();
  const session = getAuthSession();
  const isSuperAdmin = session?.user?.role === "superadmin";

  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const [running, setRunning] = useState<ActionKey | null>(null);
  const [lastResult, setLastResult] = useState<{ key: ActionKey; result: CommandResult } | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const data = await api.get<DeploymentStatus>("/deployment/status");
      setStatus(data);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) {
        navigate({ to: "/login" });
        return;
      }
      setStatusError(
        err.status === 403
          ? "Csak SuperAdmin férhet hozzá a Deployment Center-hez."
          : `Az állapot betöltése sikertelen: ${err.message || "ismeretlen hiba"}`
      );
    } finally {
      setStatusLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    if (!isSuperAdmin) {
      setStatusLoading(false);
      setStatusError("Csak SuperAdmin férhet hozzá a Deployment Center-hez.");
      return;
    }
    loadStatus();
  }, [isSuperAdmin, loadStatus]);

  const runAction = async (key: ActionKey) => {
    if (running) return;
    const meta = ACTION_META[key];
    if (meta.confirm && !window.confirm(meta.confirm)) return;

    setRunning(key);
    setLastResult(null);
    try {
      const result = await api.post<CommandResult>(`/deployment/${key}`);
      setLastResult({ key, result });
      if (key === "pull" || key === "check-update") {
        loadStatus();
      }
    } catch (e) {
      const err = e as ApiError;
      const fallback: CommandResult = {
        ok: false,
        exitCode: null,
        output: "",
        error: `${err.message || "Ismeretlen hiba"} (HTTP ${err.status ?? "?"})`,
      };
      setLastResult({ key, result: fallback });
    } finally {
      setRunning(null);
    }
  };

  return (
    <AppShell title="Deployment Center">
      <div className="space-y-6 max-w-5xl">
        <section className="rounded-xl border border-border bg-card p-5">
          <header className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Aktuális telepítés
            </h2>
            <button
              type="button"
              onClick={loadStatus}
              disabled={statusLoading || !isSuperAdmin}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-50"
            >
              {statusLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Frissítés
            </button>
          </header>

          {statusError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {statusError}
            </div>
          )}

          {status && (
            <div className="grid gap-4 md:grid-cols-2">
              <InfoBlock title="Alkalmazás">
                <InfoRow label="Verzió" value={status.app.version} />
                <InfoRow label="Build" value={status.app.build} />
                <InfoRow label="Környezet" value={status.app.environment} />
                <InfoRow label="Üzemidő" value={`${Math.round(status.app.uptime)} mp`} />
                <InfoRow label="Időbélyeg" value={status.app.timestamp} />
              </InfoBlock>
              <InfoBlock title="GitHub repozitórium">
                <InfoRow
                  label="Állapot"
                  value={status.repo.configured ? "konfigurálva" : "nincs konfigurálva"}
                />
                <InfoRow label="URL" value={status.repo.url || "—"} />
                <InfoRow label="Szerver útvonal" value={status.repo.path || "—"} />
                <InfoRow label="Branch" value={status.repo.branch || "—"} />
                <InfoRow label="Helyi commit" value={status.repo.localCommit || "—"} />
                <InfoRow label="Távoli commit" value={status.repo.remoteLatest || "—"} />
              </InfoBlock>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Műveletek
          </h2>
          <p className="mb-4 text-xs text-muted-foreground">
            A backend csak rögzített, engedélyezett parancsokat futtat. Szabad parancsbemenet nincs.
            Frissítés előtt érdemes mentést készíteni.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {(Object.keys(ACTION_META) as ActionKey[]).map((key) => {
              const { label, icon: Icon } = ACTION_META[key];
              const isRunning = running === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => runAction(key)}
                  disabled={!!running || !isSuperAdmin}
                  className="inline-flex items-center justify-start gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
                >
                  {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
                  <span>{isRunning ? `${label}…` : label}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Utolsó futás eredménye
          </h2>
          {!lastResult && (
            <p className="text-sm text-muted-foreground">Még nincs futtatott művelet.</p>
          )}
          {lastResult && <ResultPanel actionKey={lastResult.key} result={lastResult.result} />}
        </section>
      </div>
    </AppShell>
  );
}

function InfoBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <dl className="space-y-1.5 text-sm">{children}</dl>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/40 pb-1 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs text-right break-all">{value}</dd>
    </div>
  );
}

function ResultPanel({ actionKey, result }: { actionKey: ActionKey; result: CommandResult }) {
  const label = ACTION_META[actionKey].label;
  const statusText = result.ok ? "sikeres" : "sikertelen";
  return (
    <div className="space-y-2 text-sm">
      <div
        className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 ${
          result.ok
            ? "border-green-500/40 text-green-600"
            : "border-destructive/40 text-destructive"
        }`}
      >
        <span>
          <strong>{label}</strong> — {statusText}
          {result.exitCode !== null && result.exitCode !== undefined && ` (exit ${result.exitCode})`}
        </span>
        {typeof result.durationMs === "number" && (
          <span className="text-xs text-muted-foreground">{result.durationMs} ms</span>
        )}
      </div>
      {result.output && (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Kimenet</div>
          <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
            {result.output}
          </pre>
        </div>
      )}
      {result.error && (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Hibakimenet</div>
          <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap text-destructive">
            {result.error}
          </pre>
        </div>
      )}
    </div>
  );
}
