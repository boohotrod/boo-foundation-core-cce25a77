import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { RequireAuth } from "@/components/RequireAuth";
import { api, ApiError, AppSetting, getAuthSession } from "@/lib/api";

const SETTINGS_TIMEOUT_MS = 5_000;
const SETTINGS_TIMEOUT_MESSAGE =
  "A beállítások betöltése sikertelen. A szerver nem válaszolt időben.";
const SETTINGS_QUERY_KEY = ["settings"] as const;

async function fetchSettingsWithTimeout(
  querySignal: AbortSignal,
  addStatus: (line: string) => void
): Promise<AppSetting[]> {
  const controller = new AbortController();
  const session = getAuthSession();
  let failedLogged = false;
  const markFailed = () => {
    if (!failedLogged) addStatus("request failed");
    failedLogged = true;
  };
  const timeout = window.setTimeout(() => controller.abort(), SETTINGS_TIMEOUT_MS);
  const abortFromQuery = () => controller.abort();

  querySignal.addEventListener("abort", abortFromQuery, { once: true });
  addStatus("request started");

  try {
    const res = await fetch("/api/settings", {
      headers: {
        "Content-Type": "application/json",
        ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
      },
      signal: controller.signal,
    });

    addStatus("request finished");
    addStatus(`HTTP status: ${res.status}`);

    if (!res.ok) {
      markFailed();
      const text = await res.text().catch(() => res.statusText);
      throw new ApiError(text || `Request failed: ${res.status}`, res.status);
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      markFailed();
      throw new ApiError("Invalid settings response", 500);
    }
    return data.filter(
      (item): item is AppSetting =>
        item && typeof item.key === "string" && typeof item.value === "string"
    );
  } catch (e) {
    markFailed();
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new ApiError(SETTINGS_TIMEOUT_MESSAGE, 408);
    }
    throw e;
  } finally {
    window.clearTimeout(timeout);
    querySignal.removeEventListener("abort", abortFromQuery);
  }
}

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Beállítások — BBS Core" }] }),
  component: () => (
    <RequireAuth>
      <SettingsPage />
    </RequireAuth>
  ),
});

function SettingsPage() {
  const qc = useQueryClient();
  const hydrated = useRef(false);
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const [timedOut, setTimedOut] = useState(false);
  const addStatus = useCallback((line: string) => {
    setStatusLines((prev) => [...prev, line].slice(-6));
  }, []);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: ({ signal }) => fetchSettingsWithTimeout(signal, addStatus),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    staleTime: 60_000,
  });

  const [draft, setDraft] = useState<Record<string, string>>({});

  // Hard UI fallback: the page must never stay in infinite loading.
  useEffect(() => {
    if (!isLoading) return;
    setTimedOut(false);
    const timeout = window.setTimeout(() => {
      setTimedOut(true);
      addStatus("request failed");
    }, SETTINGS_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [addStatus, isLoading]);

  // Hydrate draft exactly once from the first successful fetch.
  useEffect(() => {
    if (!hydrated.current && data) {
      setDraft(Object.fromEntries(data.map((s) => [s.key, s.value])));
      hydrated.current = true;
    }
  }, [data]);

  const save = useMutation({
    mutationFn: (payload: AppSetting[]) => api.post<AppSetting[]>("/settings", payload),
    onSuccess: (fresh) => {
      qc.setQueryData(SETTINGS_QUERY_KEY, fresh);
      setDraft(Object.fromEntries(fresh.map((s) => [s.key, s.value])));
    },
  });

  const retry = async () => {
    hydrated.current = false;
    setTimedOut(false);
    setStatusLines([]);
    await qc.cancelQueries({ queryKey: SETTINGS_QUERY_KEY });
    refetch();
  };

  const StatusText = () => (
    <div className="mt-3 space-y-1 text-xs text-muted-foreground">
      {statusLines.map((line, index) => (
        <div key={`${line}-${index}`}>{line}</div>
      ))}
    </div>
  );

  if (isLoading && !timedOut) {
    return (
      <AppShell title="Beállítások">
        <div className="text-sm text-muted-foreground">Betöltés…</div>
        <StatusText />
      </AppShell>
    );
  }

  if (isError || timedOut) {
    const msg =
      timedOut || (error instanceof ApiError && error.status === 408)
        ? SETTINGS_TIMEOUT_MESSAGE
        : "Nem sikerült betölteni a beállításokat. Próbáld újra később.";
    return (
      <AppShell title="Beállítások">
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {msg}
          <div className="mt-4">
            <button
              onClick={retry}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              Újrapróbálás
            </button>
          </div>
        </div>
        <StatusText />
      </AppShell>
    );
  }

  return (
    <AppShell title="Beállítások">
      <div className="max-w-2xl rounded-xl border border-border bg-card p-6">
        {data?.map((s) => (
          <div key={s.key} className="mb-4">
            <label className="mb-1 block text-sm font-medium">{s.key}</label>
            <input
              value={draft[s.key] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
        ))}
        <button
          onClick={() =>
            save.mutate(Object.entries(draft).map(([key, value]) => ({ key, value })))
          }
          disabled={save.isPending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {save.isPending ? "Mentés…" : "Módosítások mentése"}
        </button>
        {save.isSuccess && (
          <span className="ml-3 text-sm text-muted-foreground">Mentve.</span>
        )}
        {save.isError && (
          <span className="ml-3 text-sm text-destructive">
            Mentés sikertelen. Próbáld újra.
          </span>
        )}
        <StatusText />
      </div>
    </AppShell>
  );
}
