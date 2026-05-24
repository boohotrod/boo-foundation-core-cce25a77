import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { RequireAuth } from "@/components/RequireAuth";
import { getAuthSession } from "@/lib/api";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Beállítások — BBS Core" }] }),
  component: () => (
    <RequireAuth>
      <SettingsPage />
    </RequireAuth>
  ),
});

function SettingsPage() {
  const session = getAuthSession();
  const timestamp = new Date().toISOString();

  return (
    <AppShell title="Beállítások">
      <div className="max-w-2xl rounded-xl border border-border bg-card p-6 text-sm text-foreground">
        <p className="whitespace-pre-line leading-6">
          {"Beállítások modul ideiglenesen letiltva.\n\nStabilitási vizsgálat szükséges.\n\nA rendszer többi része használható."}
        </p>

        <dl className="mt-6 grid gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">BBS Core version</dt>
            <dd>v0.2.0</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Build</dt>
            <dd>real-auth</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Current timestamp</dt>
            <dd>{timestamp}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Logged-in user</dt>
            <dd>{session?.user?.username ?? session?.user?.email ?? "Nem elérhető"}</dd>
          </div>
        </dl>
      </div>
    </AppShell>
  );
}