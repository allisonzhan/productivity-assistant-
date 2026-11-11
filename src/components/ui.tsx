// Minimal shadcn-style primitives. Kept deliberately plain until Gate 1 is accepted.

export function Card({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-label={title}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Button({
  children,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  const styles = {
    primary: "bg-accent text-white hover:opacity-90",
    secondary: "border border-border hover:bg-bg",
    danger: "border border-red-500/50 text-red-600 hover:bg-red-500/10 dark:text-red-400",
  }[variant];
  return (
    <button
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 ${styles}`}
    >
      {children}
    </button>
  );
}

const BADGE: Record<string, string> = {
  green: "bg-green-500/15 text-green-700 dark:text-green-300",
  red: "bg-red-500/15 text-red-700 dark:text-red-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  gray: "bg-slate-500/15 text-muted",
  purple: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
};

export function Badge({ tone = "gray", children }: { tone?: keyof typeof BADGE; children: React.ReactNode }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${BADGE[tone]}`}>{children}</span>;
}

export function statusTone(status: string): keyof typeof BADGE {
  if (["connected", "delivered", "processed", "succeeded"].includes(status)) return "green";
  if (["failed", "undelivered", "error", "reauth_required", "canceled"].includes(status)) return "red";
  if (status === "simulated") return "purple";
  if (status === "skipped") return "gray";
  return "amber";
}

export function Alert({ tone, children }: { tone: "error" | "info"; children: React.ReactNode }) {
  const styles = tone === "error" ? "border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200" : "border-border bg-bg";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-md border p-3 text-sm ${styles}`}>
      {children}
    </div>
  );
}

export const inputClass =
  "w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-accent";
