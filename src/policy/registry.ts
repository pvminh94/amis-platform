/**
 * ============================================================================
 * POLICY REGISTRY — đọc/ghi tham số luật theo khoảng hiệu lực
 * ============================================================================
 *
 * Ba thao tác cốt lõi:
 *   resolvePolicy(kind, date)  — kỳ lương ngày X thì áp bộ tham số nào?
 *   createVersion(...)         — soạn một bộ tham số mới (DRAFT)
 *   activateVersion(...)       — cho hiệu lực, tự động archive bản cũ
 *
 * MỌI thao tác ghi đều để lại policy_audit_logs. Với dữ liệu pháp lý, một thay
 * đổi không có dấu vết là một thay đổi không thể bảo vệ khi bị thanh tra.
 */

import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/client.js';
import {
  auditAction,
  policyKinds,
  policyVersions,
  policyAuditLogs,
} from '../db/schema.js';

// ---------------------------------------------------------------------------
// LỖI CÓ CHỦ Ý — không dùng Error chung chung
// ---------------------------------------------------------------------------

export class PolicyError extends Error {
  constructor(
    readonly code: PolicyErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

export type PolicyErrorCode =
  | 'KIND_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'INVALID_DATE_RANGE'
  | 'OVERLAP'
  | 'ALREADY_ACTIVE'
  | 'NOT_RESOLVABLE';

// ---------------------------------------------------------------------------
// LOẠI CHÍNH SÁCH
// ---------------------------------------------------------------------------

export interface KindDefinition {
  code: string;
  nameVi: string;
  nameEn?: string;
  description?: string;
  paramsSchema: Record<string, unknown>;
  roundingMode?: string;
  /**
   * true = nhiều thực thể cùng loại được ACTIVE đồng thời (mẫu in, báo cáo).
   * false = chỉ một bản ACTIVE cho cả loại (tham số luật). Mặc định false —
   * an toàn hơn: thà chặn nhầm còn hơn để hai biểu thuế cùng hiệu lực.
   */
  exclusiveByCode?: boolean;
}

export async function ensureKind(def: KindDefinition, db: Db = getDb()): Promise<void> {
  const existing = await db
    .select({ code: policyKinds.code })
    .from(policyKinds)
    .where(eq(policyKinds.code, def.code))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(policyKinds)
      .set({
        nameVi: def.nameVi,
        nameEn: def.nameEn ?? null,
        description: def.description ?? null,
        paramsSchema: def.paramsSchema,
        roundingMode: def.roundingMode ?? 'HALF_UP_VND',
        exclusiveByCode: def.exclusiveByCode ?? false,
        updatedAt: new Date(),
      })
      .where(eq(policyKinds.code, def.code));
    return;
  }

  await db.insert(policyKinds).values({
    code: def.code,
    nameVi: def.nameVi,
    nameEn: def.nameEn ?? null,
    description: def.description ?? null,
    paramsSchema: def.paramsSchema,
    roundingMode: def.roundingMode ?? 'HALF_UP_VND',
  });
}

// ---------------------------------------------------------------------------
// RESOLVE — kỳ lương ngày này thì dùng bộ tham số nào?
// ---------------------------------------------------------------------------

export interface ResolvedPolicy<T> {
  kindCode: string;
  versionId: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  legalBasis: string | null;
  params: T;
}

/**
 * Tìm phiên bản ACTIVE áp dụng tại một ngày.
 *
 * Khoảng hiệu lực là NỬA MỞ [effectiveFrom, effectiveTo):
 *   - ngày = effectiveFrom        → THUỘC bản này
 *   - ngày = effectiveTo          → KHÔNG thuộc (đã chuyển sang bản kế tiếp)
 *
 * Nhờ EXCLUDE constraint ở tầng DB, không thể có hai bản ACTIVE chồng lấn,
 * nên kết quả luôn duy nhất. Nếu không tìm thấy → ném lỗi, KHÔNG trả về
 * giá trị mặc định âm thầm. Một kỳ lương không có cơ sở pháp lý thì phải
 * dừng lại chứ không được tính bừa.
 */
export async function resolvePolicy<T>(
  kindCode: string,
  at: string | Date,
  validator: z.ZodType<T>,
  db: Db = getDb(),
  /**
   * Lọc theo mã thực thể. BẮT BUỘC với loại `exclusiveByCode` (mẫu in, báo cáo)
   * vì một loại có nhiều bản ACTIVE cùng lúc — không lọc theo mã thì "bản nào
   * đang hiệu lực" là câu hỏi không có đáp án duy nhất.
   */
  code?: string,
): Promise<ResolvedPolicy<T>> {
  const atStr = typeof at === 'string' ? at : at.toISOString().slice(0, 10);

  const rows = await db
    .select({
      id: policyVersions.id,
      version: policyVersions.version,
      effectiveFrom: policyVersions.effectiveFrom,
      effectiveTo: policyVersions.effectiveTo,
      legalBasis: policyVersions.legalBasis,
      params: policyVersions.params,
    })
    .from(policyVersions)
    .where(
      and(
        eq(policyVersions.kindCode, kindCode),
        // Lọc theo mã NẾU được yêu cầu. Bỏ qua điều kiện này với mẫu in/báo cáo
        // là lỗi đã từng xảy ra: hệ thống trả về mẫu của người khác.
        ...(code === undefined ? [] : [eq(policyVersions.code, code)]),
        eq(policyVersions.status, 'ACTIVE'),
        lte(policyVersions.effectiveFrom, atStr),
        or(isNull(policyVersions.effectiveTo), gt(policyVersions.effectiveTo, atStr)),
      ),
    )
    .orderBy(desc(policyVersions.effectiveFrom))
    .limit(2);

  if (rows.length === 0) {
    throw new PolicyError(
      'NOT_RESOLVABLE',
      `Không có chính sách '${kindCode}' nào hiệu lực tại ngày ${atStr}. ` +
        `Phải cấu hình tham số cho khoảng thời gian này trước khi tính toán — ` +
        `hệ thống cố ý không dùng giá trị mặc định, vì một con số thuế không có ` +
        `căn cứ pháp lý còn nguy hiểm hơn là dừng lại.`,
      { kindCode, at: atStr },
    );
  }

  if (rows.length > 1) {
    // Về lý thuyết EXCLUDE constraint đã chặn. Vẫn kiểm tra để nếu ai đó
    // xoá constraint thì phát hiện ngay thay vì tính sai âm thầm.
    throw new PolicyError(
      'OVERLAP',
      `Phát hiện ${rows.length} phiên bản '${kindCode}' cùng hiệu lực tại ${atStr}. ` +
        `Ràng buộc excl_policy_active_overlap có thể đã bị xoá.`,
      { kindCode, at: atStr, ids: rows.map((r) => r.id) },
    );
  }

  const row = rows[0]!;
  const parsed = validator.safeParse(row.params);
  if (!parsed.success) {
    throw new PolicyError(
      'INVALID_PARAMS',
      `Tham số của '${kindCode}' v${row.version} không hợp lệ so với schema hiện tại. ` +
        `Có thể schema đã đổi sau khi phiên bản này được lưu.`,
      { kindCode, version: row.version, issues: parsed.error.issues },
    );
  }

  return {
    kindCode,
    versionId: row.id,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    legalBasis: row.legalBasis,
    params: parsed.data,
  };
}

// ---------------------------------------------------------------------------
// GHI — tạo bản nháp và kích hoạt
// ---------------------------------------------------------------------------

export interface CreateVersionInput {
  kindCode: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  legalBasis?: string | null;
  note?: string | null;
  createdBy: string;
  actorIp?: string | null;
}

function diffFields(before: unknown, after: unknown): string[] {
  if (typeof before !== 'object' || typeof after !== 'object' || !before || !after) return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  return [...keys].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
}

/**
 * Tạo một phiên bản DRAFT. Chưa có giá trị pháp lý, engine không đọc.
 * Số phiên bản tự sinh = max(version) + 1 trong cùng loại.
 */
export async function createVersion<T>(
  input: CreateVersionInput,
  params: unknown,
  validator: z.ZodType<T>,
  db: Db = getDb(),
): Promise<{ versionId: string; version: number }> {
  // Validate NGAY lúc soạn, không đợi tới lúc kích hoạt — phản hồi sớm cho
  // người dùng biết họ điền sai chỗ nào.
  const parsed = validator.safeParse(params);
  if (!parsed.success) {
    throw new PolicyError('INVALID_PARAMS', 'Tham số không hợp lệ', parsed.error.issues);
  }

  if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) {
    throw new PolicyError(
      'INVALID_DATE_RANGE',
      `Ngày kết thúc (${input.effectiveTo}) phải sau ngày bắt đầu (${input.effectiveFrom})`,
    );
  }

  const kind = await db
    .select({ code: policyKinds.code, exclusiveByCode: policyKinds.exclusiveByCode })
    .from(policyKinds)
    .where(eq(policyKinds.code, input.kindCode))
    .limit(1);
  if (kind.length === 0) {
    throw new PolicyError('KIND_NOT_FOUND', `Loại chính sách '${input.kindCode}' chưa tồn tại`);
  }

  /**
   * Mã thực thể lấy từ chính tham số. Mọi schema tham số đều có `regimeCode`,
   * nên đây là quy ước chứ không phải trường tuỳ chọn.
   */
  const code = (parsed.data as { regimeCode?: unknown }).regimeCode;
  if (typeof code !== 'string' || code === '') {
    throw new PolicyError(
      'INVALID_PARAMS',
      `Tham số của '${input.kindCode}' thiếu 'regimeCode' — không xác định được mã thực thể.`,
    );
  }

  /**
   * Đánh số phiên bản theo ĐÚNG phạm vi độc quyền của loại.
   *
   *   tham số luật (exclusiveByCode = false) → theo KIND. Biểu thuế 7 bậc và
   *     biểu 5 bậc là hai BẢN KẾ TIẾP NHAU của cùng một đạo luật, nên chúng
   *     phải là v1, v2 — không phải hai chuỗi v1 song song.
   *   định nghĩa (exclusiveByCode = true) → theo (KIND, CODE). Hai báo cáo khác
   *     nhau chẳng liên quan gì, mỗi cái có lịch sử riêng bắt đầu ở v1.
   *
   * Hai quy tắc này phải khớp nhau. Lần đầu tôi đánh số theo (kind, code) cho
   * mọi loại và test registry vỡ ngay: ba bản TEST_PIT đều thành v1 nên
   * resolvePolicy không phân biệt được bản nào mới hơn.
   */
  const byCode = kind[0]!.exclusiveByCode;
  const maxRow = await db
    .select({ v: sql<number>`COALESCE(MAX(${policyVersions.version}), 0)` })
    .from(policyVersions)
    .where(
      and(
        eq(policyVersions.kindCode, input.kindCode),
        ...(byCode ? [eq(policyVersions.code, code)] : []),
      ),
    );
  const nextVersion = Number(maxRow[0]?.v ?? 0) + 1;

  const [inserted] = await db
    .insert(policyVersions)
    .values({
      kindCode: input.kindCode,
      code,
      // Sao chép lên dòng để ràng buộc EXCLUDE đọc được (nó không join được).
      exclusiveByCode: kind[0]!.exclusiveByCode,
      version: nextVersion,
      status: 'DRAFT',
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      params: parsed.data,
      legalBasis: input.legalBasis ?? null,
      note: input.note ?? null,
      createdBy: input.createdBy,
    })
    .returning({ id: policyVersions.id, version: policyVersions.version });

  await db.insert(policyAuditLogs).values({
    kindCode: input.kindCode,
    versionId: inserted!.id,
    version: inserted!.version,
    action: 'CREATE',
    before: null,
    after: parsed.data,
    changedFields: Object.keys(parsed.data as object),
    actorId: input.createdBy,
    actorIp: input.actorIp ?? null,
    reason: input.note ?? null,
  });

  return { versionId: inserted!.id, version: inserted!.version };
}

/**
 * Kích hoạt một phiên bản.
 *
 * Việc này chạy trong MỘT TRANSACTION: archive bản cũ đang chồng lấn + set
 * ACTIVE + ghi audit. Nếu làm rời rạc, một lỗi giữa chừng sẽ để lại hệ thống
 * với hai bản ACTIVE — đúng cái trạng thái mà EXCLUDE constraint được sinh ra
 * để ngăn.
 */
export async function activateVersion(
  versionId: string,
  actor: { id: string; ip?: string | null; reason?: string | null },
  db: Db = getDb(),
): Promise<{ versionId: string; archived: string[]; warnings: string[] }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.id, versionId))
      .limit(1);

    const target = rows[0];
    if (!target) {
      throw new PolicyError('VERSION_NOT_FOUND', `Không tìm thấy phiên bản ${versionId}`);
    }
    if (target.status === 'ACTIVE') {
      throw new PolicyError('ALREADY_ACTIVE', `Phiên bản v${target.version} đã ACTIVE rồi`);
    }

    // Tìm bản ACTIVE đang chồng lấn khoảng hiệu lực → archive chúng.
    // Dùng chính logic khoảng nửa mở [from, to).
    //
    // Với loại độc quyền theo MÃ (mẫu in, báo cáo) thì chỉ đụng tới bản CÙNG MÃ.
    // Thiếu điều kiện này, kích hoạt mẫu "Bảng chấm công" sẽ archive luôn mẫu
    // "Phiếu lương" — hai thứ chẳng liên quan gì tới nhau.
    const overlapping = await tx
      .select()
      .from(policyVersions)
      .where(
        and(
          eq(policyVersions.kindCode, target.kindCode),
          ...(target.exclusiveByCode ? [eq(policyVersions.code, target.code)] : []),
          eq(policyVersions.status, 'ACTIVE'),
          sql`${policyVersions.effectiveFrom}::date < COALESCE(${target.effectiveTo}::date, 'infinity'::date)`,
          sql`COALESCE(${policyVersions.effectiveTo}::date, 'infinity'::date) > ${target.effectiveFrom}::date`,
        ),
      );

    const archived: string[] = [];
    for (const old of overlapping) {
      // Không archive hẳn nếu bản cũ bắt đầu TRƯỚC bản mới — chỉ cần cắt
      // khoảng hiệu lực lại để hai bản nối tiếp nhau, giữ nguyên lịch sử.
      if (old.effectiveFrom < target.effectiveFrom) {
        await tx
          .update(policyVersions)
          .set({ effectiveTo: target.effectiveFrom, updatedAt: new Date() })
          .where(eq(policyVersions.id, old.id));
        await tx.insert(policyAuditLogs).values({
          kindCode: target.kindCode,
          versionId: old.id,
          version: old.version,
          action: 'UPDATE',
          before: { effectiveTo: old.effectiveTo },
          after: { effectiveTo: target.effectiveFrom },
          changedFields: ['effectiveTo'],
          actorId: actor.id,
          actorIp: actor.ip ?? null,
          reason: `Cắt khoảng hiệu lực để nhường chỗ cho v${target.version}`,
        });
      } else {
        await tx
          .update(policyVersions)
          .set({ status: 'ARCHIVED', updatedAt: new Date() })
          .where(eq(policyVersions.id, old.id));
        await tx.insert(policyAuditLogs).values({
          kindCode: target.kindCode,
          versionId: old.id,
          version: old.version,
          action: 'ARCHIVE',
          before: { status: 'ACTIVE' },
          after: { status: 'ARCHIVED' },
          changedFields: ['status'],
          actorId: actor.id,
          actorIp: actor.ip ?? null,
          reason: `Bị thay thế bởi v${target.version}`,
        });
        archived.push(old.id);
      }
    }

    const [updated] = await tx
      .update(policyVersions)
      .set({
        status: 'ACTIVE',
        approvedBy: actor.id,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(policyVersions.id, versionId))
      .returning({ id: policyVersions.id, version: policyVersions.version });

    await tx.insert(policyAuditLogs).values({
      kindCode: target.kindCode,
      versionId,
      version: target.version,
      action: 'ACTIVATE',
      before: { status: target.status },
      after: { status: 'ACTIVE', approvedBy: actor.id },
      changedFields: ['status', 'approvedBy', 'approvedAt'],
      actorId: actor.id,
      actorIp: actor.ip ?? null,
      reason: actor.reason ?? null,
    });

    // -------------------------------------------------------------------------
    // CẢNH BÁO KHOẢNG TRỐNG
    //
    // Nếu bản liền trước kết thúc TRƯỚC ngày bản này bắt đầu, sẽ có một đoạn
    // thời gian không có chính sách nào áp dụng — và resolvePolicy sẽ NÉM LỖI
    // cho mọi kỳ lương rơi vào đó. Đây không phải lỗi (có thể người dùng định
    // điền sau), nhưng phải nói rõ ngay lúc kích hoạt, chứ không để kế toán
    // tính lương kỳ đó rồi mới phát hiện hệ thống từ chối.
    // -------------------------------------------------------------------------
    const warnings: string[] = [];

    const prevRows = await tx
      .select({
        version: policyVersions.version,
        effectiveTo: policyVersions.effectiveTo,
      })
      .from(policyVersions)
      .where(
        and(
          eq(policyVersions.kindCode, target.kindCode),
          eq(policyVersions.status, 'ACTIVE'),
          sql`${policyVersions.id} <> ${versionId}`,
          sql`${policyVersions.effectiveFrom}::date < ${target.effectiveFrom}::date`,
        ),
      )
      .orderBy(desc(policyVersions.effectiveFrom))
      .limit(1);

    const prev = prevRows[0];
    if (prev) {
      const prevEnd = prev.effectiveTo; // null = còn hiệu lực, không thể có khoảng trống
      if (prevEnd && prevEnd < target.effectiveFrom) {
        warnings.push(
          `Có khoảng trống chính sách từ ${prevEnd} đến ${target.effectiveFrom} ` +
            `(không có phiên bản nào áp dụng). Kỳ lương rơi vào khoảng này sẽ ` +
            `không tính được cho đến khi bạn thêm phiên bản phủ kín.`,
        );
      }
    } else if (target.effectiveFrom > '1970-01-01') {
      // Không có bản nào trước đó — mọi ngày trước effectiveFrom đều trống
      warnings.push(
        `Đây là phiên bản đầu tiên của '${target.kindCode}'. Mọi ngày trước ` +
          `${target.effectiveFrom} sẽ không có chính sách áp dụng.`,
      );
    }

    return { versionId: updated!.id, archived, warnings };
  });
}

/** Lịch sử thay đổi của một loại chính sách — dùng cho màn hình đối chiếu. */
export async function getAuditTrail(kindCode: string, db: Db = getDb()) {
  return db
    .select()
    .from(policyAuditLogs)
    .where(eq(policyAuditLogs.kindCode, kindCode))
    .orderBy(desc(policyAuditLogs.at));
}
