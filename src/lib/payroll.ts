/**
 * ============================================================================
 * TÍNH LƯƠNG HÀNG LOẠT — một kỳ, mọi nhân viên, trong MỘT transaction
 * ============================================================================
 *
 * Toàn bộ hoặc không gì cả. Nếu nhân viên thứ 37 có dữ liệu hỏng thì cả kỳ
 * phải rollback — một bảng lương thiếu người là thứ không ai phát hiện ra cho
 * tới khi người đó hỏi.
 */

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { employees, payslips, payRuns } from '@/db/schema';
import { resolvePolicy } from '@/policy/registry';
import { vnSalaryParamsSchema } from '@/policy/salary-params';
import { vnSiParamsSchema } from '@/policy/si-params';
import { vnPitParamsSchema } from '@/policy/tax-params';
import { calculateSalary } from '@/engine/salary';
import { calculateSocialInsurance, type WageRegion } from '@/engine/si';
import { calculateTaxableIncome, calculateProgressivePit } from '@/engine/pit';

export interface AttendanceInput {
  workedDays: number;
  kpiScore: number;
  otNormalHours: number;
  otWeekendHours: number;
  otHolidayHours: number;
  mealDays: number;
  lateCount: number;
  advanceAmount: number;
}

export interface GeneratePayRunInput {
  periodYear: number;
  periodMonth: number;
  /** Ghi đè dữ liệu chấm công theo mã nhân viên. Không có thì dùng mặc định. */
  attendance?: Record<string, Partial<AttendanceInput>>;
  actor?: string;
}

export interface GeneratePayRunResult {
  payRunId: string;
  count: number;
  totals: {
    gross: number;
    siEmployee: number;
    siEmployer: number;
    pit: number;
    net: number;
  };
  applied: { salary: string; si: string; pit: string };
}

/**
 * Số ngày làm việc chuẩn của tháng (thứ Hai đến thứ Bảy — tuần 6 ngày, phổ
 * biến ở VN).
 *
 * KHÔNG hardcode 26. Tháng 2 và tháng 7 khác nhau, và chia cứng 26 sẽ làm
 * lương tháng 2 cao bất thường so với số ngày thực tế đã làm.
 */
export function standardWorkingDays(year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (dow !== 0) count++; // bỏ Chủ nhật
  }
  return count;
}

const DEFAULT_ATTENDANCE = (std: number): AttendanceInput => ({
  workedDays: std,
  kpiScore: 100,
  otNormalHours: 0,
  otWeekendHours: 0,
  otHolidayHours: 0,
  mealDays: std,
  lateCount: 0,
  advanceAmount: 0,
});

export async function generatePayRun(
  input: GeneratePayRunInput,
): Promise<GeneratePayRunResult> {
  const { periodYear, periodMonth } = input;
  if (!Number.isInteger(periodMonth) || periodMonth < 1 || periodMonth > 12) {
    throw new RangeError(`Tháng không hợp lệ: ${periodMonth}`);
  }
  if (!Number.isInteger(periodYear) || periodYear < 2000) {
    throw new RangeError(`Năm không hợp lệ: ${periodYear}`);
  }

  const db = getDb();
  const lastDay = new Date(periodYear, periodMonth, 0).getDate();
  // Ngày cuối kỳ — dùng để resolve chính sách. Mốc này quyết định bộ luật.
  const periodEnd = `${periodYear}-${String(periodMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const std = standardWorkingDays(periodYear, periodMonth);

  return db.transaction(async (tx) => {
    // --- 1. Resolve CHÍNH SÁCH MỘT LẦN cho cả kỳ --------------------------
    // Không resolve trong vòng lặp: vừa chậm, vừa có nguy cơ hai nhân viên
    // trong cùng một kỳ bị áp hai bộ luật nếu ai đó kích hoạt bản mới giữa
    // chừng. Resolve trước rồi dùng chung là đúng ngữ nghĩa "một kỳ một luật".
    // TUẦN TỰ, không Promise.all. Cả ba dùng CHUNG một client của transaction;
    // bắn ba query đồng thời trên một client là điều pg cảnh báo ("Calling
    // client.query() when the client is already executing") và có thể làm rối
    // thứ tự thực thi bên trong transaction.
    const salaryPolicy = await resolvePolicy('VN_SALARY', periodEnd, vnSalaryParamsSchema, tx);
    const siPolicy = await resolvePolicy('VN_BHXH', periodEnd, vnSiParamsSchema, tx);
    const pitPolicy = await resolvePolicy('VN_PIT', periodEnd, vnPitParamsSchema, tx);
    const snapshot = {
      VN_SALARY: { code: salaryPolicy.params.regimeCode, version: salaryPolicy.version },
      VN_BHXH: { code: siPolicy.params.regimeCode, version: siPolicy.version },
      VN_PIT: { code: pitPolicy.params.regimeCode, version: pitPolicy.version },
      resolvedAt: periodEnd,
    };

    // --- 2. Kỳ lương ------------------------------------------------------
    const existing = await tx
      .select({ id: payRuns.id })
      .from(payRuns)
      .where(and(eq(payRuns.periodYear, periodYear), eq(payRuns.periodMonth, periodMonth)))
      .limit(1);
    if (existing.length > 0) {
      throw new RangeError(
        `Kỳ ${periodMonth}/${periodYear} đã được tính (id ${existing[0]!.id}). ` +
          `Xoá kỳ cũ trước khi tính lại — hai kỳ trùng sẽ làm tổng quỹ lương bị đội lên.`,
      );
    }
    const [run] = await tx
      .insert(payRuns)
      .values({
        periodYear,
        periodMonth,
        status: 'DRAFT',
        policySnapshot: snapshot,
        policyVersionIds: {
          VN_SALARY: salaryPolicy.versionId,
          VN_BHXH: siPolicy.versionId,
          VN_PIT: pitPolicy.versionId,
        },
      })
      .returning({ id: payRuns.id });
    const payRunId = run!.id;

    // --- 3. Từng nhân viên ------------------------------------------------
    const rows = await tx
      .select()
      .from(employees)
      .where(eq(employees.active, true));
    if (rows.length === 0) {
      throw new RangeError('Không có nhân viên nào đang hoạt động để tính lương.');
    }

    const totals = { gross: 0, siEmployee: 0, siEmployer: 0, pit: 0, net: 0 };

    for (const emp of rows) {
      const att = { ...DEFAULT_ATTENDANCE(std), ...(input.attendance?.[emp.employeeCode] ?? {}) };
      const variables = {
        baseSalary: emp.baseSalary,
        hourlyRate: emp.hourlyRate,
        workedDays: att.workedDays,
        standardDays: std,
        kpiScore: att.kpiScore,
        otNormalHours: att.otNormalHours,
        otWeekendHours: att.otWeekendHours,
        otHolidayHours: att.otHolidayHours,
        mealDays: att.mealDays,
        lateCount: att.lateCount,
        advanceAmount: att.advanceAmount,
      };

      // Lỗi ở đây phải NÊU TÊN NHÂN VIÊN. Một kỳ 500 người mà thông báo chỉ
      // nói "thiếu biến kpiScore" thì không ai biết sửa cho ai.
      const who = `${emp.employeeCode} (${emp.fullName})`;
      let sal;
      try {
        sal = calculateSalary({ variables }, salaryPolicy.params);
      } catch (e) {
        throw new RangeError(`${who}: ${e instanceof Error ? e.message : String(e)}`);
      }

      const si = calculateSocialInsurance(
        {
          contributionSalary: sal.insuranceBaseSalary,
          wageRegion: emp.wageRegion as WageRegion,
          trainedWorker: emp.trainedWorker,
        },
        siPolicy.params,
      );

      const ti = calculateTaxableIncome(
        {
          grossIncome: sal.taxableIncome,
          exemptIncome: 0,
          employeeSocialInsurance: si.employee.total,
          voluntaryPensionContribution: 0,
          dependentCount: emp.dependents,
        },
        pitPolicy.params,
      );
      const pit = calculateProgressivePit(ti.taxableIncome, pitPolicy.params);

      if (!pit.quickFormulaMatch) {
        throw new RangeError(
          `${who}: hai cách tính thuế lệch nhau — bộ tham số thuế đang hiệu lực bị nhập sai.`,
        );
      }

      const net = sal.netFromComponents - si.employee.total - pit.pit;

      await tx.insert(payslips).values({
        payRunId,
        employeeId: emp.id,
        employeeCode: emp.employeeCode,
        fullName: emp.fullName,
        variables,
        policySnapshot: snapshot,
        components: sal.components,
        earningsTotal: sal.earningsTotal,
        deductionsTotal: sal.deductionsTotal,
        taxableIncome: sal.taxableIncome,
        insuranceBase: sal.insuranceBaseSalary,
        siBase: si.siBase,
        uiBase: si.uiBase,
        siEmployee: si.employee.total,
        siEmployer: si.employer.total,
        pit: pit.pit,
        netPay: net,
      });

      totals.gross += sal.earningsTotal;
      totals.siEmployee += si.employee.total;
      totals.siEmployer += si.employer.total;
      totals.pit += pit.pit;
      totals.net += net;
    }

    // --- 4. Cập nhật tổng lên kỳ ------------------------------------------
    await tx
      .update(payRuns)
      .set({
        grossTotal: totals.gross,
        employeeSiTotal: totals.siEmployee,
        employerSiTotal: totals.siEmployer,
        pitTotal: totals.pit,
        netTotal: totals.net,
        updatedAt: new Date(),
      })
      .where(eq(payRuns.id, payRunId));

    return {
      payRunId,
      count: rows.length,
      totals,
      applied: {
        salary: `${snapshot.VN_SALARY.code} v${snapshot.VN_SALARY.version}`,
        si: `${snapshot.VN_BHXH.code} v${snapshot.VN_BHXH.version}`,
        pit: `${snapshot.VN_PIT.code} v${snapshot.VN_PIT.version}`,
      },
    };
  });
}

/** Đối chiếu tổng: tổng các phiếu phải bằng đúng số ghi trên kỳ. */
export async function assertPayRunConsistent(payRunId: string): Promise<void> {
  const db = getDb();
  const [run] = await db
    .select()
    .from(payRuns)
    .where(eq(payRuns.id, payRunId))
    .limit(1);
  if (!run) throw new RangeError(`Không tìm thấy kỳ lương ${payRunId}`);

  const [agg] = await db
    .select({
      n: sql<number>`count(*)::int`,
      gross: sql<number>`coalesce(sum(earnings_total),0)::int`,
      si: sql<number>`coalesce(sum(si_employee),0)::int`,
      pit: sql<number>`coalesce(sum(pit),0)::int`,
      net: sql<number>`coalesce(sum(net_pay),0)::int`,
    })
    .from(payslips)
    .where(eq(payslips.payRunId, payRunId));

  const checks: Array<[string, number, number]> = [
    ['grossTotal', run.grossTotal, agg!.gross],
    ['employeeSiTotal', run.employeeSiTotal, agg!.si],
    ['pitTotal', run.pitTotal, agg!.pit],
    ['netTotal', run.netTotal, agg!.net],
  ];
  for (const [name, onRun, onSlips] of checks) {
    if (onRun !== onSlips) {
      throw new RangeError(
        `Kỳ ${payRunId} lệch ở ${name}: trên kỳ ${onRun}, tổng phiếu ${onSlips}.`,
      );
    }
  }
}
