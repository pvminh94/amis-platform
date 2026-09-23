import { and, asc, eq } from 'drizzle-orm';

import { getDb, type Db } from '@/db/client';
import { employees, glAccounts, glEntries, glLines, payRuns, payslips } from '@/db/schema';
import {
  buildSalaryJournals,
  GlError,
  type GlEntry,
  type PayslipForGl,
} from '@/engine/gl';
import { glMapParamsSchema } from '@/policy/gl-params';
import { resolvePolicy } from '@/policy/registry';

export { GlError } from '@/engine/gl';

/** Mã lỗi ràng buộc "giá trị trùng khoá duy nhất" của PostgreSQL. */
const DUPLICATE_KEY = '23505';

type Side = GlEntry['lines'][number]['side'];

/**
 * Ghi sổ một kỳ lương.
 *
 * Ba bút toán nằm trong MỘT giao dịch, và điều đó quan trọng hơn vẻ ngoài của nó:
 *
 * Ghi rời từng bút toán thì một lần chết giữa chừng sẽ để lại sổ cái có ghi nhận
 * chi phí lương nhưng chưa trả — TK 334 treo một số dư không có thật, và chỉ đối
 * chiếu thủ công mới phát hiện ra. Trong một giao dịch thì hoặc đủ cả, hoặc không
 * có gì.
 *
 * Ghi trùng bị chặn ở tầng database chứ không phải ở đây: `entry_no` là khoá duy
 * nhất nên lần ghi thứ hai nổ ràng buộc và giao dịch roll back. Kiểm tra "đã ghi
 * chưa" ở tầng ứng dụng thì luôn có cửa race — hai yêu cầu cùng đọc được "chưa",
 * rồi cả hai cùng ghi.
 */
export async function postPayRun(
  runId: string,
  actor: { id: string },
  db: Db = getDb(),
): Promise<{ entries: GlEntry[]; periodLabel: string }> {
  const found = await db.select().from(payRuns).where(eq(payRuns.id, runId)).limit(1);
  const run = found[0];
  if (!run) throw new GlError('NO_PAYSLIPS', `Không tìm thấy kỳ lương ${runId}`);

  const rows = await db
    .select({
      employeeCode: payslips.employeeCode,
      fullName: payslips.fullName,
      department: employees.department,
      earningsTotal: payslips.earningsTotal,
      deductionsTotal: payslips.deductionsTotal,
      siEmployee: payslips.siEmployee,
      siEmployer: payslips.siEmployer,
      pit: payslips.pit,
      netPay: payslips.netPay,
      siBreakdown: payslips.siBreakdown,
    })
    .from(payslips)
    .leftJoin(employees, eq(employees.id, payslips.employeeId))
    .where(eq(payslips.payRunId, runId))
    .orderBy(asc(payslips.employeeCode));

  const slips: PayslipForGl[] = rows.map((r) => ({
    employeeCode: r.employeeCode,
    fullName: r.fullName,
    department: r.department ?? 'Không rõ',
    earningsTotal: r.earningsTotal,
    deductionsTotal: r.deductionsTotal,
    siEmployee: r.siEmployee,
    siEmployer: r.siEmployer,
    pit: r.pit,
    netPay: r.netPay,
    // jsonb về TypeScript là `unknown`. Ép kiểu ở đúng một chỗ, ngay ranh giới
    // với DB — engine sẽ tự kiểm tra tính nhất quán và ném lỗi nếu hỏng.
    siBreakdown: r.siBreakdown as PayslipForGl['siBreakdown'],
  }));

  const periodLabel = `${String(run.periodMonth).padStart(2, '0')}/${run.periodYear}`;
  const postingDate = `${run.periodYear}-${String(run.periodMonth).padStart(2, '0')}-01`;

  // Lấy định khoản đang hiệu lực tại NGÀY ĐĂNG, không phải hôm nay: ghi lại sổ
  // cho một kỳ cũ phải dùng đúng bộ định khoản của kỳ đó.
  const policy = await resolvePolicy('GL_MAP', postingDate, glMapParamsSchema, db);

  const entries = buildSalaryJournals(
    { id: run.id, periodYear: run.periodYear, periodMonth: run.periodMonth },
    slips,
    policy.params,
    postingDate,
  );

  await db.transaction(async (tx) => {
    for (const e of entries) {
      try {
        const inserted = await tx
          .insert(glEntries)
          .values({
            entryNo: e.entryNo,
            entryType: e.entryType,
            postingDate: e.postingDate,
            periodYear: e.periodYear,
            periodMonth: e.periodMonth,
            memo: e.memo,
            sourceType: e.sourceType,
            sourceId: e.sourceId,
            totalDebit: e.totalDebit,
            totalCredit: e.totalCredit,
            postedBy: actor.id,
          })
          .returning({ id: glEntries.id });

        // INSERT một dòng luôn trả đúng một dòng, nhưng TypeScript không biết
        // điều đó. Nếu nó sai thì thà nổ ở đây còn hơn ghi dòng hạch toán vào một
        // bút toán không tồn tại — và vì đang trong giao dịch nên lỗi này roll
        // back sạch, không để lại bút toán mồ côi.
        const entry = inserted[0];
        if (!entry) throw new GlError('INTERNAL', `Không lấy được id của bút toán ${e.entryNo}`);

        await tx.insert(glLines).values(
          e.lines.map((l, i) => ({
            entryId: entry.id,
            lineNo: i + 1,
            accountCode: l.account,
            side: l.side,
            amount: l.amount,
            memo: l.memo ?? null,
          })),
        );
      } catch (err) {
        // Dịch lỗi driver sang lỗi nghiệp vụ — không để "duplicate key value
        // violates unique constraint" lộ ra cho người dùng kế toán đọc.
        if ((err as { code?: string })?.code === DUPLICATE_KEY) {
          throw new GlError(
            'ALREADY_POSTED',
            `Kỳ lương ${periodLabel} đã được ghi sổ. Không ghi trùng — ` +
              'toàn bộ giao dịch đã được hoàn tác, sổ cái không đổi.',
          );
        }
        throw err;
      }
    }
  });

  return { entries, periodLabel };
}

export interface AccountBalance {
  account: string;
  accountName: string;
  /** Số dư bình thường của tài khoản — quyết định số dư được đọc theo bên nào. */
  normalSide: Side;
  debit: number;
  credit: number;
  /**
   * Số dư THEO BÊN BÌNH THƯỜNG của tài khoản, nên dương là bình thường.
   *
   * Một con số có dấu duy nhất (nợ trừ có) thì đúng về số học nhưng ngược nghiệp
   * vụ: TK 334 dư có 500 triệu — hoàn toàn bình thường — sẽ hiện ra âm 500 triệu
   * và kế toán phải tự đảo dấu trong đầu cho từng dòng. Đọc theo bên bình thường
   * thì âm mới thực sự nghĩa là bất thường.
   */
  balance: number;
  /**
   * Số dư đặt vào cột mà nó THỰC SỰ thuộc về, theo dấu của (nợ − có).
   *
   * Hai cột này không suy ra được từ `normalSide`: một tài khoản dư Nợ vẫn có
   * thể mang số dư Có (TK 1121 sau khi chi tiền là ví dụ), và khi đó con số phải
   * nằm ở cột Có. Đặt cột theo bên bình thường sẽ in ra một số dương ở cột sai —
   * nhìn vẫn đẹp, đọc thì sai dấu.
   */
  debitBalance: number;
  creditBalance: number;
}

/**
 * Bảng đối chiếu thử (trial balance).
 *
 * Tổng nợ PHẢI bằng tổng có. Nếu lệch thì sổ đã hỏng ở đâu đó — hàm này là cách
 * phát hiện, không phải cách sửa.
 */
export async function trialBalance(
  filter: { periodYear?: number; periodMonth?: number } = {},
  db: Db = getDb(),
): Promise<{
  lines: AccountBalance[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}> {
  const conds = [];
  if (filter.periodYear !== undefined) conds.push(eq(glEntries.periodYear, filter.periodYear));
  if (filter.periodMonth !== undefined) conds.push(eq(glEntries.periodMonth, filter.periodMonth));

  const rows = await db
    .select({
      account: glLines.accountCode,
      name: glAccounts.nameVi,
      amount: glLines.amount,
      side: glLines.side,
      normalSide: glAccounts.normalSide,
    })
    .from(glLines)
    .innerJoin(glEntries, eq(glEntries.id, glLines.entryId))
    .leftJoin(glAccounts, eq(glAccounts.code, glLines.accountCode))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(glLines.accountCode));

  // Cộng dồn ở tầng ứng dụng thay vì GROUP BY trong SQL: số dòng ở mức một kỳ
  // lương là vài chục, và làm ở đây thì con số này dùng đúng một phép cộng với
  // engine — không có hai cách tính để lệch nhau.
  const agg = new Map<
    string,
    { name: string; normalSide: Side; debit: number; credit: number }
  >();
  for (const r of rows) {
    const cur = agg.get(r.account) ?? {
      name: r.name ?? r.account,
      // Không có trong danh mục thì mặc định dư Nợ — nhưng đó là dữ liệu thiếu,
      // không phải lý do để đoán sai: bảng đối chiếu vẫn cho thấy dòng này.
      normalSide: (r.normalSide === 'CREDIT' ? 'CREDIT' : 'DEBIT') as Side,
      debit: 0,
      credit: 0,
    };
    if ((r.side as Side) === 'DEBIT') cur.debit += r.amount;
    else cur.credit += r.amount;
    agg.set(r.account, cur);
  }

  const lines: AccountBalance[] = [...agg.entries()]
    .map(([account, v]) => ({
      account,
      accountName: v.name,
      normalSide: v.normalSide,
      debit: v.debit,
      credit: v.credit,
      balance: v.normalSide === 'DEBIT' ? v.debit - v.credit : v.credit - v.debit,
      debitBalance: Math.max(0, v.debit - v.credit),
      creditBalance: Math.max(0, v.credit - v.debit),
    }))
    .sort((a, b) => a.account.localeCompare(b.account));

  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);

  return { lines, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

/** Các bút toán đã ghi của một kỳ, kèm dòng hạch toán. */
export async function entriesForPeriod(
  periodYear: number,
  periodMonth: number,
  db: Db = getDb(),
): Promise<(GlEntry & { id: string })[]> {
  const headers = await db
    .select()
    .from(glEntries)
    .where(and(eq(glEntries.periodYear, periodYear), eq(glEntries.periodMonth, periodMonth)))
    .orderBy(asc(glEntries.entryNo));
  if (headers.length === 0) return [];

  const lines = await db
    .select()
    .from(glLines)
    .orderBy(asc(glLines.entryId), asc(glLines.lineNo));

  return headers.map((h) => ({
    id: h.id,
    entryNo: h.entryNo,
    entryType: h.entryType as GlEntry['entryType'],
    postingDate: h.postingDate,
    periodYear: h.periodYear,
    periodMonth: h.periodMonth,
    // `memo` nullable ở DB nhưng bắt buộc ở engine — bút toán nào cũng có diễn
    // giải, nên null chỉ có thể là dữ liệu cũ; coi như rỗng.
    memo: h.memo ?? '',
    sourceType: h.sourceType,
    sourceId: h.sourceId,
    totalDebit: h.totalDebit,
    totalCredit: h.totalCredit,
    lines: lines
      .filter((l) => l.entryId === h.id)
      .map((l) => ({
        account: l.accountCode,
        side: l.side as Side,
        amount: l.amount,
        memo: l.memo ?? undefined,
      })),
  }));
}
