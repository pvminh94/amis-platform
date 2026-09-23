import { desc, eq, sql } from 'drizzle-orm';
import { requirePageSession } from '@/lib/page-auth';

import { Alert, Badge, Card } from '@/components/ui';
import { BatchDownload } from '@/components/batch-download';
import { getDb } from '@/db/client';
import { bankPaymentBatches, payRuns } from '@/db/schema';
import { employeesWithoutAccount } from '@/lib/payment';

export const dynamic = 'force-dynamic';

const fmt = (n: number) => n.toLocaleString('vi-VN');

const TONE: Record<string, 'neutral' | 'active' | 'warn' | 'danger'> = {
  GENERATED: 'warn',
  SENT: 'active',
  RETURNED: 'danger',
  VOID: 'neutral',
};

export default async function PaymentsPage() {
  // Trang RSC phai tu kiem tra phien — xem src/lib/page-auth.ts
  await requirePageSession();
  const db = getDb();

  const batches = await db
    .select({
      id: bankPaymentBatches.id,
      batchNo: bankPaymentBatches.batchNo,
      bankCode: bankPaymentBatches.bankCode,
      fileName: bankPaymentBatches.fileName,
      rowCount: bankPaymentBatches.rowCount,
      totalAmount: bankPaymentBatches.totalAmount,
      status: bankPaymentBatches.status,
      returnedCount: bankPaymentBatches.returnedCount,
      generatedAt: bankPaymentBatches.generatedAt,
      year: payRuns.periodYear,
      month: payRuns.periodMonth,
    })
    .from(bankPaymentBatches)
    .innerJoin(payRuns, eq(bankPaymentBatches.payRunId, payRuns.id))
    .orderBy(desc(bankPaymentBatches.generatedAt));

  // Nhân viên chưa có tài khoản ở TOÀN HỆ THỐNG — cảnh báo sớm, trước khi tới
  // lúc xuất file mới phát hiện ra một người bị bỏ rơi.
  const noAccount = await employeesWithoutAccount(db);

  const active = batches.filter((b) => b.status !== 'VOID');
  const sent = batches.filter((b) => b.status === 'SENT');

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <a href="/" className="text-sm text-[var(--muted)] hover:underline">
        ← Trang chủ
      </a>
      <h1 className="mt-2 text-2xl font-semibold">Thanh toán ngân hàng</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Mỗi lô là một chứng từ: nội dung file được lưu nguyên văn kèm SHA-256, và
        server từ chối trả file nếu băm không khớp. Không lô nào sinh lại được từ
        dữ liệu hiện tại — cái đã gửi ngân hàng phải đúng là cái đang lưu.
      </p>

      {noAccount.length > 0 && (
        <Alert tone="warn">
          {noAccount.length} nhân viên chưa có tài khoản ngân hàng chính:{' '}
          <span className="font-mono">{noAccount.join(', ')}</span>. Họ sẽ bị loại
          khỏi file và tiền lương của họ chưa được trả.
        </Alert>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="text-center">
          <div className="text-2xl font-semibold">{batches.length}</div>
          <div className="text-xs text-[var(--muted)]">lô đã lập</div>
        </Card>
        <Card className="text-center">
          <div className="text-2xl font-semibold">{active.length}</div>
          <div className="text-xs text-[var(--muted)]">lô còn hiệu lực</div>
        </Card>
        <Card className="text-center">
          <div className="text-2xl font-semibold">
            {fmt(sent.reduce((s, b) => s + Number(b.totalAmount), 0))}
          </div>
          <div className="text-xs text-[var(--muted)]">đ đã chuyển</div>
        </Card>
      </div>

      <Card className="mt-4" title="Các lô">
        {batches.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            Chưa có lô nào. Vào một kỳ lương để xuất.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[var(--muted)]">
                <tr>
                  <th className="py-1 pr-3 font-normal">Kỳ</th>
                  <th className="py-1 pr-3 font-normal">Số lô</th>
                  <th className="py-1 pr-3 font-normal">Ngân hàng</th>
                  <th className="py-1 text-right font-normal">Món</th>
                  <th className="py-1 pr-3 text-right font-normal">Tổng (đ)</th>
                  <th className="py-1 pr-3 font-normal">Trạng thái</th>
                  <th className="py-1 pr-3 font-normal">Lập lúc</th>
                  <th className="py-1 font-normal"></th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {batches.map((b) => (
                  <tr key={b.id} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-3">
                      {String(b.month).padStart(2, '0')}/{b.year}
                    </td>
                    <td className="py-1.5 pr-3">{b.batchNo}</td>
                    <td className="py-1.5 pr-3">{b.bankCode}</td>
                    <td className="py-1.5 text-right">
                      {b.rowCount}
                      {b.returnedCount > 0 && (
                        <span className="ml-1 text-[var(--danger)]">
                          (trả {b.returnedCount})
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right">{fmt(Number(b.totalAmount))}</td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={TONE[b.status] ?? 'neutral'}>{b.status}</Badge>
                    </td>
                    <td className="py-1.5 pr-3">
                      {new Date(b.generatedAt).toLocaleString('vi-VN', {
                        hour12: false,
                      })}
                    </td>
                    <td className="py-1.5">
                      {/* Thẻ <a href> ở đây nhận về 401 vì không đính kèm được
                          header Authorization — xem src/components/batch-download.tsx */}
                      <BatchDownload batchId={b.id} fileName={b.fileName} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </main>
  );
}
