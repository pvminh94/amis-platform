import { Alert, Badge, Card } from '@/components/ui';
import { getDb } from '@/db/client';
import { payRuns } from '@/db/schema';
import { entriesForPeriod, trialBalance } from '@/lib/gl';
import { glMapParamsSchema, ACCOUNT_LABELS, REQUIRED_ACCOUNTS } from '@/policy/gl-params';
import { PolicyError, resolvePolicy } from '@/policy/registry';
import { desc } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

const fmt = (n: number) => Math.abs(n).toLocaleString('vi-VN');

export default async function GlPage() {
  const db = getDb();

  const runs = await db.select().from(payRuns).orderBy(desc(payRuns.createdAt)).limit(1);
  const run = runs[0];

  const period = run ? { periodYear: run.periodYear, periodMonth: run.periodMonth } : null;

  const [tb, entries, policy] = await Promise.all([
    period ? trialBalance(period, db) : Promise.resolve(null),
    period ? entriesForPeriod(period.periodYear, period.periodMonth, db) : Promise.resolve([]),
    resolvePolicy('GL_MAP', new Date(), glMapParamsSchema, db).catch((e) =>
      e instanceof PolicyError ? e : null,
    ),
  ]);

  const tk334 = tb?.lines.find((l) => l.account === '334');

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6">
        <a href="/" className="text-sm text-[var(--muted)] hover:underline">
          ← Trang chủ
        </a>
        <h1 className="mt-2 text-2xl font-semibold">Sổ cái — cầu nối lương sang kế toán</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Mỗi kỳ lương sinh ra <strong>ba bút toán kép</strong>: ghi nhận chi phí,
          trích khấu trừ, và trả qua ngân hàng. Bộ phận nào vào tài khoản chi phí
          nào là <strong>tham số</strong>, không phải code.
        </p>
      </div>

      <Alert tone="info">
        Bất biến của trang này: sau ba bút toán, <strong>TK 334 phải bằng 0</strong>.
        Nếu còn dư thì hoặc ghi thiếu hoặc ghi trùng — phép thử này bắt được cả
        hai. Ghi sổ chạy trong <strong>một giao dịch</strong>, và số hiệu bút toán
        là khoá duy nhất nên không thể ghi trùng một kỳ.
      </Alert>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card title="Định khoản đang hiệu lực">
          {policy && 'code' in policy && policy.code === 'NOT_RESOLVABLE' ? (
            <Alert tone="warn">
              Chưa có bản định khoản nào hiệu lực. Chạy{' '}
              <code>npm run seed:gl</code> hoặc tạo tại{' '}
              <a href="/policies/GL_MAP/new" className="underline">
                /policies/GL_MAP/new
              </a>
              .
            </Alert>
          ) : policy && 'params' in policy ? (
            <>
              <p className="text-sm font-medium">{policy.params.regimeLabel}</p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                v{policy.version} · hiệu lực từ {policy.effectiveFrom} ·{' '}
                {policy.legalBasis ?? 'không nêu căn cứ'}
              </p>
              <table className="mt-3 w-full text-sm">
                <tbody>
                  {REQUIRED_ACCOUNTS.map((k) => (
                    <tr key={k} className="border-t border-[var(--border)]">
                      <td className="py-1 text-[var(--muted)]">{ACCOUNT_LABELS[k]}</td>
                      <td className="py-1 text-right font-mono">
                        {policy.params.accounts[k]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-sm font-medium">Chi phí theo bộ phận</p>
              <table className="mt-1 w-full text-sm">
                <tbody>
                  {Object.entries(policy.params.departmentAccounts).map(([d, a]) => (
                    <tr key={d} className="border-t border-[var(--border)]">
                      <td className="py-1">{d}</td>
                      <td className="py-1 text-right font-mono">{a}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-[var(--border)] text-[var(--muted)]">
                    <td className="py-1">(mặc định)</td>
                    <td className="py-1 text-right font-mono">
                      {policy.params.defaultExpenseAccount}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-3">
                <a href="/policies/GL_MAP/new" className="text-sm underline">
                  Đổi định khoản →
                </a>
              </p>
            </>
          ) : (
            <p className="text-sm text-[var(--muted)]">Không đọc được định khoản.</p>
          )}
        </Card>

        <Card title="Bất biến — TK 334 phải trả người lao động">
          {!tb || !tk334 ? (
            <p className="text-sm text-[var(--muted)]">
              Chưa có bút toán nào. Ghi sổ một kỳ lương để xem.
            </p>
          ) : (
            <>
              <table className="w-full text-sm">
                <tbody>
                  <tr className="border-b border-[var(--border)]">
                    <td className="py-1 text-[var(--muted)]">Phát sinh Nợ</td>
                    <td className="py-1 text-right font-mono">{fmt(tk334.debit)}</td>
                  </tr>
                  <tr className="border-b border-[var(--border)]">
                    <td className="py-1 text-[var(--muted)]">Phát sinh Có</td>
                    <td className="py-1 text-right font-mono">{fmt(tk334.credit)}</td>
                  </tr>
                  <tr>
                    <td className="py-1 font-medium">Số dư</td>
                    <td className="py-1 text-right font-mono font-semibold">
                      {fmt(tk334.balance)}
                    </td>
                  </tr>
                </tbody>
              </table>
              {tk334.balance === 0 ? (
                <div className="mt-3">
                  <Badge tone="active">BẰNG 0 — sổ đúng</Badge>
                  <p className="mt-2 text-xs text-[var(--muted)]">
                    Đã ghi nhận đủ, đã trừ đủ, đã trả đủ. Không treo khoản nào.
                  </p>
                </div>
              ) : (
                <div className="mt-3">
                  <Badge tone="danger">KHÁC 0 — sổ sai</Badge>
                  <p className="mt-2 text-xs text-[var(--muted)]">
                    Ghi thiếu hoặc ghi trùng. Sổ này chưa dùng được.
                  </p>
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      {entries.length > 0 && (
        <Card title={`Bút toán kỳ ${String(period!.periodMonth).padStart(2, '0')}/${period!.periodYear}`} className="mt-4">
          <div className="space-y-4">
            {entries.map((e) => (
              <div key={e.id}>
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-sm">{e.entryNo}</span>
                  <span className="text-sm text-[var(--muted)]">{e.memo}</span>
                </div>
                <table className="mt-1 w-full text-sm">
                  <thead>
                    <tr className="text-xs text-[var(--muted)]">
                      <th className="py-1 text-left font-normal">TK</th>
                      <th className="py-1 text-right font-normal">Nợ</th>
                      <th className="py-1 text-right font-normal">Có</th>
                      <th className="py-1 text-left font-normal">Diễn giải</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.lines.map((l, i) => (
                      <tr key={i} className="border-t border-[var(--border)]">
                        <td className="py-1 font-mono">{l.account}</td>
                        <td className="py-1 text-right font-mono">
                          {l.side === 'DEBIT' ? fmt(l.amount) : ''}
                        </td>
                        <td className="py-1 text-right font-mono">
                          {l.side === 'CREDIT' ? fmt(l.amount) : ''}
                        </td>
                        <td className="py-1 text-xs text-[var(--muted)]">{l.memo}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-[var(--border)] font-semibold">
                      <td />
                      <td className="py-1 text-right font-mono">{fmt(e.totalDebit)}</td>
                      <td className="py-1 text-right font-mono">{fmt(e.totalCredit)}</td>
                      <td className="py-1 text-xs">
                        {e.totalDebit === e.totalCredit ? '✓ cân' : '✗ LỆCH'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tb && (
        <Card title="Bảng đối chiếu thử" className="mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-[var(--muted)]">
                <th className="py-1 text-left font-normal">TK</th>
                <th className="py-1 text-left font-normal">Tên tài khoản</th>
                <th className="py-1 text-right font-normal">PS Nợ</th>
                <th className="py-1 text-right font-normal">PS Có</th>
                <th className="py-1 text-right font-normal">SD Nợ</th>
                <th className="py-1 text-right font-normal">SD Có</th>
              </tr>
            </thead>
            <tbody>
              {tb.lines.map((l) => (
                <tr key={l.account} className="border-t border-[var(--border)]">
                  <td className="py-1 font-mono">{l.account}</td>
                  <td className="py-1">{l.accountName}</td>
                  <td className="py-1 text-right font-mono">{fmt(l.debit)}</td>
                  <td className="py-1 text-right font-mono">{fmt(l.credit)}</td>
                  <td className="py-1 text-right font-mono">{fmt(l.debitBalance)}</td>
                  <td className="py-1 text-right font-mono">{fmt(l.creditBalance)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-[var(--border)] font-semibold">
                <td colSpan={2} className="py-1">
                  TỔNG
                </td>
                <td className="py-1 text-right font-mono">{fmt(tb.totalDebit)}</td>
                <td className="py-1 text-right font-mono">{fmt(tb.totalCredit)}</td>
                <td className="py-1 text-right font-mono">
                  {fmt(tb.lines.reduce((s, l) => s + l.debitBalance, 0))}
                </td>
                <td className="py-1 text-right font-mono">
                  {fmt(tb.lines.reduce((s, l) => s + l.creditBalance, 0))}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="mt-3">
            {tb.balanced ? (
              <Badge tone="active">Tổng nợ = tổng có — sổ cân</Badge>
            ) : (
              <Badge tone="danger">Tổng nợ ≠ tổng có — sổ hỏng</Badge>
            )}
          </div>
        </Card>
      )}
    </main>
  );
}
