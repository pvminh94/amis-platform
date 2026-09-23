/**
 * UI primitives viết tay theo phong cách shadcn — KHÔNG dùng shadcn CLI.
 *
 * Lý do: shadcn vốn dĩ là "copy component vào repo", không phải thư viện.
 * Viết thẳng ra còn nhẹ hơn chạy CLI (CLI kéo theo radix-ui + hàng chục phụ
 * thuộc), và sandbox này chỉ có ~1,4GB RAM đang chia sẻ với PostgreSQL.
 */

export function Card({
  title,
  subtitle,
  children,
  actions,
}: {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]">
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {subtitle && <p className="mt-1 text-sm text-[var(--muted)]">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

const VARIANTS = {
  primary: 'bg-[var(--accent)] text-[#04140c] hover:bg-[#54e6a8]',
  ghost: 'border border-[var(--border)] bg-transparent text-[var(--text)] hover:bg-[var(--panel-2)]',
  danger: 'border border-[var(--danger)] text-[var(--danger)] hover:bg-[#2a1416]',
} as const;

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium
        transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'active' | 'warn' | 'danger';
  children: React.ReactNode;
}) {
  const tones = {
    neutral: 'border-[var(--border)] text-[var(--muted)]',
    active: 'border-[var(--accent-dim)] bg-[#0d2a1e] text-[var(--accent)]',
    warn: 'border-[#5a4413] bg-[#2a2009] text-[var(--warn)]',
    danger: 'border-[#5a1c22] bg-[#2a1416] text-[var(--danger)]',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-[var(--muted)]">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-[var(--danger)]">{error}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm ' +
  'text-[var(--text)] outline-none transition-colors focus:border-[var(--accent-dim)] ' +
  'placeholder:text-[var(--muted)]';

export function Alert({
  tone = 'warn',
  children,
}: {
  tone?: 'warn' | 'danger' | 'info';
  children: React.ReactNode;
}) {
  const tones = {
    warn: 'border-[#5a4413] bg-[#2a2009] text-[var(--warn)]',
    danger: 'border-[#5a1c22] bg-[#2a1416] text-[var(--danger)]',
    info: 'border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]',
  };
  return (
    <div className={`rounded-md border px-4 py-3 text-sm leading-relaxed ${tones[tone]}`}>
      {children}
    </div>
  );
}
