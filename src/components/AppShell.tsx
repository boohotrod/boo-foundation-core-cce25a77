import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ReactNode } from "react";
import {
  LayoutDashboard,
  Puzzle,
  Activity,
  Settings as SettingsIcon,
  History,
  LogOut,
  Shield,
  Rocket,
} from "lucide-react";
import { api, clearAuthSession, getAuthSession } from "@/lib/api";

const NAV = [
  { to: "/dashboard", label: "Vezérlőpult", icon: LayoutDashboard },
  { to: "/plugins", label: "Bővítmények", icon: Puzzle },
  { to: "/system-health", label: "Rendszerállapot", icon: Activity },
  { to: "/deployment", label: "Deployment Center", icon: Rocket, superadmin: true },
  { to: "/settings", label: "Beállítások", icon: SettingsIcon },
  { to: "/rollback-points", label: "Visszaállítási pontok", icon: History },
] as const;

export function AppShell({ children, title }: { children: ReactNode; title: string }) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const role = getAuthSession()?.user?.role;

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // Local cleanup still happens if the server session is already invalid.
    }
    if (typeof window !== "undefined") clearAuthSession();
    navigate({ to: "/login" });
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="w-64 shrink-0 border-r border-border bg-card flex flex-col">
        <div className="px-6 py-5 border-b border-border flex items-center gap-2">
          <Shield className="h-6 w-6 text-primary" />
          <div>
            <div className="font-semibold leading-tight">BBS Core</div>
            <div className="text-xs text-muted-foreground">v0.2.0</div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {NAV.map((item) => {
            if (item.superadmin && role !== "superadmin") return null;
            const { to, label, icon: Icon } = item;
            const active = pathname === to;
            return (
              <Link
                key={to}
                to={to}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </nav>
        <button
          onClick={logout}
          className="m-3 flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground"
        >
          <LogOut className="h-4 w-4" />
          Kijelentkezés
        </button>
      </aside>
      <main className="flex-1 overflow-auto flex flex-col">
        <header className="border-b border-border bg-card/50 px-8 py-4">
          <h1 className="text-xl font-semibold">{title}</h1>
        </header>
        <div className="flex-1 p-8">{children}</div>
        <footer className="border-t border-border bg-card/30 px-8 py-3 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
          <span>BBS Core v0.2.0</span>
          <span>Build: real-auth</span>
          <span>Környezet: production</span>
        </footer>
      </main>
    </div>
  );
}
