// Fragment có key: slips.map trả về HAI <tr> cho mỗi nhân viên (dòng số liệu +
// dòng chi tiết), nên phải bọc. Bản trước dùng `<>` trần và đặt key ở <tr> bên
// trong — React chỉ nhìn key ở PHẦN TỬ NGOÀI CÙNG, nên cả danh sách không có
// key nào và nó cảnh báo. Không chỉ ồn: thiếu key thì khi danh sách đổi thứ tự
// React có thể giữ lại DOM của dòng khác.
import { Fragment } from 'react';
import { AuthDownload } from '@/components/auth-download';
import { requirePageSession } from '@/lib/page-auth';
import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/uuid';
import { getDb } from '@/db/client';
import { bankPaymentBatches, employees, payslips, payRuns } from '@/db/schema';
import { Badge, Card, Alert } from '@/components/ui';
import { PayRunSubmit } from '@/components/pay-run-submit';
import { PaymentExport } from '@/components/payment-export';

export const dynamic = 'force-dynamic';

const fmt = (n: number) => n.toLocaleString('vi-VN');

export default async function PayRunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Trang RSC phai tu kiem tra phien — xem src/lib/page-auth.ts
  await requirePageSession();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const db = getDb();

  const [run] = await db.select().from(payRuns).where(eq(payRuns.id, id)).limit(1);
  if (!run) notFound();

  const slips = await db
    .select({ s: payslips, region: employees.wageRegion, dependents: employees.dependents })
    .from(payslips)
    .innerJoin(employees, eq(payslips.employeeId, employees.id))
    .where(eq(payslips.payRunId, id));

  // Danh sách lô thanh toán đã xuất của kỳ này, kể cả lô VOID — một lô đã huỷ
  // mà biến mất khỏi màn hình thì không ai biết là đã từng có file gửi ngân hàng.
  const batches = await db
    .select({
      id: bankPaymentBatches.id,
      batchNo: bankPaymentBatches.batchNo,
      bankCode: bankPaymentBatches.bankCode,
      fileName: bankPaymentBatches.fileName,
      rowCount: bankPaymentBatches.rowCount,
      totalAmount: bankPaymentBatches.totalAmount,
      status: bankPaymentBatches.status,
      generatedAt: bankPaymentBatches.generatedAt,
    })
    .from(bankPaymentBatches)
    .where(eq(bankPaymentBatches.payRunId, id))
    .orderBy(bankPaymentBatches.generatedAt);

  const snap = run.policySnapshot as Record<
    string,
    { code?: string; version?: number; resolvedAt?: string }
  >;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6">
        <a href="/payroll" className="text-sm text-[var(--muted)] hover:underline">
          ← Bảng lương
        </a>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold">
            Kỳ {String(run.periodMonth).padStart(2, '0')}/{run.periodYear}
          </h1>
          <Badge tone={run.status === 'DRAFT' ? 'warn' : 'active'}>{run.status}</Badge>
          <span className="text-sm text-[var(--muted)]">{slips.length} phiếu</span>
        </div>
      </div>

      <Card className="mb-6">
        <div className="text-sm font-medium">Chính sách đã áp dụng</div>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Resolve một lần cho cả kỳ theo ngày{' '}
          <code>{String(snap.resolvedAt ?? '')}</code>. Không resolve trong vòng
          lặp — nếu ai đó kích hoạt chính sách mới giữa chừng thì hai nhân viên
          trong cùng một kỳ sẽ bị áp hai bộ luật.
        </p>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          {Object.entries(snap)
            .filter(([, v]) => typeof v === 'object' && v !== null && 'code' in v)
            .map(([kind, v]) => (
              <div key={kind}>
                <dt className="text-xs text-[var(--muted)]">{kind}</dt>
                <dd className="font-mono">
                  {v.code} v{v.version}
                </dd>
              </div>
            ))}
        </dl>
      </Card>

      <div className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        {[
          ['Tổng thu nhập', run.grossTotal],
          ['BH NLĐ', run.employeeSiTotal],
          ['BH NSDLĐ', run.employerSiTotal],
          ['Thuế TNCN', run.pitTotal],
          ['Thực nhận', run.netTotal],
        ].map(([label, value]) => (
          <Card key={label as string}>
            <div className="text-xs text-[var(--muted)]">{label}</div>
            <div className="num text-base font-semibold">{fmt(value as number)} đ</div>
          </Card>
        ))}
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                <th className="py-2 pr-3 font-normal">Mã</th>
                <th className="py-2 pr-3 font-normal">Họ tên</th>
                <th className="py-2 pr-3 font-normal">Vùng</th>
                <th className="num py-2 pr-3 font-normal">Thu nhập</th>
                <th className="num py-2 pr-3 font-normal">BH NLĐ</th>
                <th className="num py-2 pr-3 font-normal">Thuế</th>
                <th className="num py-2 pr-3 font-normal">Thực nhận</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {slips.map(({ s, region }) => {
                const comps = (s.components ?? []) as {
                  code: string;
                  label: string;
                  formula: string;
                  amount: number;
                  taxable: boolean;
                  inInsuranceBase: boolean;
                }[];
                return (
                  <Fragment key={s.id}>
                    <tr className="border-b border-[var(--border)]">
                      <td className="py-2 pr-3 font-mono text-xs">{s.employeeCode}</td>
                      <td className="py-2 pr-3">{s.fullName}</td>
                      <td className="py-2 pr-3 text-xs">{region}</td>
                      <td className="num py-2 pr-3">{fmt(s.earningsTotal)}</td>
                      <td className="num py-2 pr-3">{fmt(s.siEmployee)}</td>
                      <td className="num py-2 pr-3">{fmt(s.pit)}</td>
                      <td className="num py-2 pr-3 font-medium">{fmt(s.netPay)}</td>
                      <td className="py-2 text-right">
                        <a
                          href={`/print/PHIEU_LUONG?payslip=${s.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-[var(--accent)] hover:underline"
                        >
                          In ↗
                        </a>
                      </td>
                    </tr>
                    {/*
                      Chi tiết từng thành phần. TRƯỚC ĐÂY KHÔNG CÓ: bảng lương chỉ
                      hiện bốn con số tổng, còn "vì sao ra số này" thì phải đọc
                      jsonb trong database. Với một hệ thống mà công thức lương sửa
                      được trên giao diện thì không hiện được công thức đã chạy là
                      thiếu mất một nửa giá trị — người ta sửa công thức mà không
                      thấy nó áp vào đâu.
                    */}
                    <tr className="border-b border-[var(--border)]">
                      <td colSpan={8} className="px-0 py-0">
                        <details className="group">
                          <summary className="cursor-pointer py-1 text-xs text-[var(--muted)] hover:text-[var(--accent)]">
                            {comps.length} thành phần · công thức và số tiền
                          </summary>
                          <table className="mb-2 mt-1 w-full text-xs">
                            <tbody>
                              {comps.map((c) => (
                                <tr key={c.code} className="border-t border-[var(--border)]/50">
                                  <td className="py-1 pr-2 font-mono text-[10px] text-[var(--muted)]">
                                    {c.code}
                                  </td>
                                  <td className="py-1 pr-2">{c.label}</td>
                                  <td className="py-1 pr-2 font-mono text-[10px] text-[var(--muted)]">
                                    {c.formula}
                                  </td>
                                  <td className="py-1 pr-2 text-[10px]">
                                    {[c.taxable ? 'thuế' : null, c.inInsuranceBase ? 'BH' : null]
                                      .filter(Boolean)
                                      .join(', ')}
                                  </td>
                                  <td
                                    className={
                                      'num py-1 ' + (c.amount < 0 ? 'text-[var(--danger,#c00)]' : '')
                                    }
                                  >
                                    {fmt(c.amount)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </details>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">
          Mỗi phiếu in ra dùng <strong>số liệu đã lưu</strong>, không tính lại —
          vì chính sách có thể đã đổi kể từ khi kỳ này được lập.
        </p>
      </Card>

      {run.status === 'DRAFT' ? (
        <Card className="mt-4">
          <div className="mb-2 text-sm font-medium">Nộp ra duyệt</div>
          <p className="mb-3 text-xs text-[var(--muted)]">
            Chuỗi duyệt lấy từ loại chính sách <strong>APPROVAL</strong> theo tổng
            thực nhận của kỳ, và được chụp lại vào đơn — đổi ngưỡng sau đó không
            ảnh hưởng đơn đang duyệt dở.
          </p>
          <PayRunSubmit payRunId={run.id} label="kỳ này" />
        </Card>
      ) : (
        <Alert tone="info">
          Kỳ này đang ở trạng thái <strong>{run.status}</strong>. Xem dấu vết tại{' '}
          <a href="/approvals" className="underline">
            Đơn xin duyệt
          </a>
          .
        </Alert>
      )}

      <Card className="mt-4" title="Thanh toán ngân hàng">
        <p className="mb-3 text-xs text-[var(--muted)]">
          File sinh từ chính phiếu lương đã khoá và tham số ngân hàng{' '}
          <strong>BANK_PAYOUT</strong> — không nhập tay số tài khoản ở đây, vì tay
          gõ là tay sai. Tổng ở footer được đối chiếu với tổng các dòng trước khi
          ghi, lệch một đồng là không sinh file.
        </p>

        {batches.length > 0 && (
          <table className="mb-4 w-full text-left text-xs">
            <thead className="text-[var(--muted)]">
              <tr>
                <th className="py-1 pr-3 font-normal">Số lô</th>
                <th className="py-1 pr-3 font-normal">Ngân hàng</th>
                <th className="py-1 pr-3 text-right font-normal">Món</th>
                <th className="py-1 pr-3 text-right font-normal">Tổng</th>
                <th className="py-1 pr-3 font-normal">Trạng thái</th>
                <th className="py-1 font-normal"></th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {batches.map((b) => (
                <tr key={b.id} className="border-t border-[var(--border)]">
                  <td className="py-1.5 pr-3">{b.batchNo}</td>
                  <td className="py-1.5 pr-3">{b.bankCode}</td>
                  <td className="py-1.5 pr-3 text-right">{b.rowCount}</td>
                  <td className="py-1.5 pr-3 text-right">{fmt(Number(b.totalAmount))}</td>
                  <td className="py-1.5 pr-3">
                    <Badge tone={b.status === 'VOID' ? 'neutral' : b.status === 'SENT' ? 'active' : 'warn'}>
                      {b.status}
                    </Badge>
                  </td>
                  <td className="py-1.5">
                    {/* <a href> nhận về 401 vì không đính kèm được Authorization */}
                    <AuthDownload
                      href={`/api/payment-batches/${b.id}/download`}
                      fileName={b.fileName}
                      label="tải"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <PaymentExport payRunId={run.id} />
      </Card>
    </main>
  );
}
