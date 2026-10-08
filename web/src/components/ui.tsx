import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./icons";

export function Page({ title, subtitle, action, back, children }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; back?: ReactNode; children: ReactNode }) {
  return (
    <div className="px-4 pt-2">
      {back}
      <header className="flex items-end justify-between gap-3 mb-4 pt-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-[26px] font-bold leading-tight tracking-tight [overflow-wrap:anywhere]">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-2 [overflow-wrap:anywhere]">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      {children}
    </div>
  );
}

export function Card({ children, className = "", onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} className={`block w-full text-left rounded-2xl bg-surface border border-line shadow-card ${onClick ? "tap active:bg-surface-2 transition-colors" : ""} ${className}`}>
      {children}
    </Tag>
  );
}

export function SectionLabel({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "success" | "warning" | "accent" | "danger" }) {
  const color = { default: "text-ink-3", success: "text-success", warning: "text-warning", accent: "text-accent", danger: "text-danger" }[tone];
  return <p className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${color}`}>{children}</p>;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" | "violet" | "success"; size?: "md" | "sm"; loading?: boolean; icon?: ReactNode; full?: boolean };
export function Button({ variant = "primary", size = "md", loading, icon, full, className = "", children, disabled, ...rest }: ButtonProps) {
  const base = "tap inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-[transform,background-color,opacity] active:scale-[0.98] disabled:opacity-45 disabled:active:scale-100";
  const sizes = size === "sm" ? "h-9 px-3.5 text-[13px]" : "h-12 px-5 text-[15px]";
  const variants = {
    primary: "bg-accent text-white shadow-glow hover:bg-accent-strong",
    secondary: "bg-surface-2 text-ink border border-line-2",
    ghost: "text-ink-2 hover:text-ink",
    danger: "bg-danger-soft text-danger border border-danger/30",
    violet: "bg-violet/15 text-violet border border-violet/40 hover:bg-violet/25",
    success: "bg-success-soft text-success border border-success/30 hover:bg-success/20",
  }[variant];
  return (
    <button className={`${base} ${sizes} ${variants} ${full ? "w-full" : ""} ${className}`} disabled={disabled || loading} {...rest}>
      {loading ? <Spinner size={16} /> : icon}
      {children}
    </button>
  );
}

export function Pill({ tone = "neutral", dot, pulse, children }: { tone?: "neutral" | "accent" | "success" | "warning" | "danger"; dot?: boolean; pulse?: boolean; children: ReactNode }) {
  const tones = {
    neutral: "bg-surface-3 text-ink-2",
    accent: "bg-accent-soft text-accent",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold whitespace-nowrap ${tones}`}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full bg-current ${pulse ? "animate-pulse" : ""}`} />}
      {children}
    </span>
  );
}

export function ProgressBar({ value, tone = "accent" }: { value: number; tone?: "accent" | "success" }) {
  return (
    <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
      <div className={`h-full rounded-full transition-[width] duration-500 ${tone === "success" ? "bg-success" : "bg-accent"}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

const AVATAR_COLORS = ["bg-[#3b6ee8]", "bg-[#2fa37a]", "bg-[#c98b2a]", "bg-[#c4557a]", "bg-[#7a5cd6]", "bg-[#2a9fb8]"];
export function Avatar({ name, index = 0, size = 32 }: { name: string; index?: number; size?: number }) {
  const initial = (name.trim().replace(/^S(\d+)$/, "$1")[0] ?? "?").toUpperCase();
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-full text-white font-bold ${AVATAR_COLORS[index % AVATAR_COLORS.length]}`} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {initial}
    </span>
  );
}
export const speakerColorClass = (index: number) => ["text-[#7ea3ff]", "text-[#4fd1a1]", "text-[#f0c060]", "text-[#f088aa]", "text-[#a894ff]", "text-[#5cc8e0]"][index % 6];

export function Segmented<T extends string>({ options, value, onChange, className = "" }: { options: { value: T; label: ReactNode; icon?: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={`flex gap-1 overflow-x-auto no-scrollbar rounded-xl bg-surface p-1 border border-line ${className}`} role="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} role="tab" aria-selected={active} onClick={() => onChange(o.value)} className={`tap shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 h-9 text-[13px] font-semibold transition-colors ${active ? "bg-surface-3 text-ink shadow-card" : "text-ink-3"}`}>
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={`tap relative h-8 w-[52px] rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-success" : "bg-surface-3 border border-line-2"}`}>
      <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-[left] ${checked ? "left-[22px]" : "left-1"}`} />
    </button>
  );
}

export function EmptyState({ illustration, title, description, action }: { illustration: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mt-14 flex flex-col items-center text-center px-6">
      {illustration}
      <p className="mt-5 text-[17px] font-semibold">{title}</p>
      {description && <p className="mt-1.5 text-sm text-ink-2 leading-relaxed">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton rounded-lg ${className}`} />;
}

export function InlineError({ children }: { children: ReactNode }) {
  return <p className="mt-3 rounded-xl bg-danger-soft border border-danger/30 px-3 py-2.5 text-sm text-danger">{children}</p>;
}

export function Bullets({ items, empty = "없음" }: { items: string[]; empty?: string }) {
  if (!items.length) return <p className="text-sm text-ink-3">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-[14px] text-ink leading-relaxed">
      {items.map((x, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-3" />
          <span>{x}</span>
        </li>
      ))}
    </ul>
  );
}

export const formatDate = (iso: string) => new Date(iso).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const formatDuration = (sec: number) => (sec >= 3600 ? `${Math.floor(sec / 3600)}시간 ${Math.round((sec % 3600) / 60)}분` : `${Math.max(1, Math.round(sec / 60))}분`);
