import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { RequireAuth } from "@/components/RequireAuth";
import { api, ApiError, AppSetting, clearAuthSession } from "@/lib/api";

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
  const navigate = useNavigate();
  const hydrated = useRef(false);
  const redirected = useRef(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<AppSetting[]>("/settings"),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    staleTime: 60_000,
  });

  const [draft, setDraft] = useState<Record<string, string>>({});

  // Hydrate draft exactly once from the first successful fetch.
  useEffect(() => {
    if (!hydrated.current && data) {
      setDraft(Object.fromEntries(data.map((s) => [s.key, s.value])));
      hydrated.current = true;
    }
  }, [data]);

  // Handle auth errors: redirect to /login exactly once, no retry storm.
  useEffect(() => {
    if (isError && error instanceof ApiError && error.status === 401 && !redirected.current) {
      redirected.current = true;
      clearAuthSession();
      navigate({ to: "/login" });
    }
  }, [isError, error, navigate]);

  const save = useMutation({
    mutationFn: (payload: AppSetting[]) => api.post<AppSetting[]>("/settings", payload),
    onSuccess: (fresh) => {
      qc.setQueryData(["settings"], fresh);
      setDraft(Object.fromEntries(fresh.map((s) => [s.key, s.value])));
    },
  });

  if (isLoading) {
    return (
      <AppShell title="Beállítások">
        <div className="text-sm text-muted-foreground">Betöltés…</div>
      </AppShell>
    );
  }

  if (isError) {
    const msg =
      error instanceof ApiError && error.status === 401
        ? "Lejárt munkamenet. Átirányítás a bejelentkezéshez…"
        : "Nem sikerült betölteni a beállításokat. Próbáld újra később.";
    return (
      <AppShell title="Beállítások">
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {msg}
        </div>
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
      </div>
    </AppShell>
  );
}
