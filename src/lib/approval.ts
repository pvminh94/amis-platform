/**
 * ============================================================================
 * QUY TRÌNH DUYỆT — nối ngưỡng (dữ liệu) với máy trạng thái (code)
 * ============================================================================
 *
 * Hai nửa tách biệt và đó là có chủ ý:
 *
 *   NGƯỠNG  — loại chính sách APPROVAL, sửa được trên giao diện. "Chi trên 200
 *             triệu thì cần CEO" là thông số, thay đổi theo phân cấp công ty.
 *   TRẠNG THÁI — engine/workflow.ts, code cố định. "Đơn APPROVED không quay lại
 *             PENDING" là luật chơi. Cho sửa cái này trên UI thì ai cũng tự
 *             duyệt được đơn của mình.
 */

import { and, eq } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import { approvalAudit, approvalRequests, payRuns } from '@/db/schema';
import { resolvePolicy } from '@/policy/registry';
import { approvalParamsSchema } from '@/policy/approval-params';
import { resolveApprovalChain, type ApprovalChainStep } from '@/engine/approval';
import {
  allowedActions,
  evaluateCondition,
  isFinalState,
  performApprovalAction,
  type OnMissingField,
  type RequestState,
  type WorkflowAction,
} from '@/engine/workflow';

export interface SubmitInput {
  docType: string;
  docRef: string;
  docLabel: string;
  /** Giá trị so với ngưỡng: số tiền, số ngày… Tuỳ loại chứng từ. */
  value: number;
  /** Ngữ cảnh bổ sung cho điều kiện bước. */
  context?: Record<string, unknown>;
  actor: string;
}

export interface ActInput {
  requestId: string;
  action: WorkflowAction;
  actorId: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  comment?: string | null;
  ipAddress: string;
  userAgent?: string | null;
}

/**
 * Nộp một đơn xin duyệt.
 *
 * CHUỖI DUYỆT ĐƯỢC CHỤP LẠI ngay lúc này. Nếu để đọc từ chính sách mỗi lần
 * hiển thị, một thay đổi ngưỡng giữa chừng sẽ đổi số bước của đơn đang duyệt
 * dở — đơn "bước 2/3" bỗng thành "bước 2/2" và tự chốt ở lần duyệt kế tiếp.
 */
export async function submitApproval(
  input: SubmitInput,
  db: Db = getDb(),
): Promise<{ requestId: string; chain: ApprovalChainStep[]; policy: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const policy = await resolvePolicy('APPROVAL', today, approvalParamsSchema, db);
  const resolved = resolveApprovalChain(
    { docType: input.docType, value: input.value },
    policy.params,
  );

  if (resolved.chain.length === 0) {
    throw new RangeError(
      `Chuỗi duyệt cho ${input.docType} = ${input.value} rỗng. Một đơn không có ai duyệt ` +
        `thì không phải là đơn đã duyệt — nó là đơn bị bỏ quên.`,
    );
  }

  const existing = await db
    .select({ id: approvalRequests.id, state: approvalRequests.state })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.docType, input.docType),
        eq(approvalRequests.docRef, input.docRef),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    throw new RangeError(
      `${input.docLabel} đã có đơn duyệt ở trạng thái ${existing[0]!.state}. ` +
        `Một tài liệu không thể có hai đơn song song.`,
    );
  }

  const context = {
    docType: input.docType,
    value: input.value,
    ...(input.context ?? {}),
  };

  const [row] = await db
    .insert(approvalRequests)
    .values({
      docType: input.docType,
      docRef: input.docRef,
      docLabel: input.docLabel,
      amount: input.docType === 'PAYRUN' || input.docType === 'EXPENSE' ? input.value : null,
      context,
      chain: resolved.chain,
      policySnapshot: {
        APPROVAL: { code: policy.params.regimeCode, version: policy.version },
        matchedUpto: resolved.matchedUpto,
        matchedLevel: resolved.matchedLevel,
        unit: resolved.unit,
      },
      state: 'PENDING_APPROVAL',
      currentStep: 0,
      totalSteps: resolved.chain.length,
      requestedBy: input.actor,
    })
    .returning({ id: approvalRequests.id });

  // Nộp đơn cũng là một sự kiện cần dấu vết, không chỉ các bước duyệt.
  await db.insert(approvalAudit).values({
    requestId: row!.id,
    action: 'SUBMIT',
    fromStatus: 'DRAFT',
    toStatus: 'PENDING_APPROVAL',
    step: 0,
    actorId: input.actor,
    actorName: input.actor,
    actorRole: null,
    comment: `Chuỗi duyệt: ${resolved.chain.map((c) => c.name).join(' → ')}`,
    ipAddress: '0.0.0.0',
    userAgent: null,
  });

  return {
    requestId: row!.id,
    chain: resolved.chain,
    policy: `${policy.params.regimeCode} v${policy.version}`,
  };
}

/**
 * Thực hiện một hành động duyệt.
 *
 * Chạy trong MỘT TRANSACTION: đổi trạng thái + ghi audit. Nếu ghi audit thất
 * bại thì việc đổi trạng thái cũng phải rollback — một lần duyệt không có dấu
 * vết thì coi như chưa từng xảy ra về mặt pháp lý.
 */
export async function actOnApproval(
  input: ActInput,
  db: Db = getDb(),
): Promise<{ state: RequestState; finished: boolean; currentStep: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, input.requestId))
      .limit(1);
    const req = rows[0];
    if (!req) throw new RangeError(`Không tìm thấy đơn duyệt ${input.requestId}`);

    const result = performApprovalAction({
      requestId: req.id,
      currentState: req.state as RequestState,
      action: input.action,
      actorId: input.actorId,
      actorName: input.actorName ?? null,
      actorRole: input.actorRole ?? null,
      currentStep: req.currentStep,
      totalSteps: req.totalSteps,
      comment: input.comment,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    await tx
      .update(approvalRequests)
      .set({
        state: result.newState,
        currentStep: result.nextStep,
        updatedAt: new Date(),
      })
      .where(eq(approvalRequests.id, req.id));

    await tx.insert(approvalAudit).values({
      requestId: req.id,
      action: result.audit.action,
      fromStatus: result.audit.fromStatus,
      toStatus: result.audit.toStatus,
      step: result.audit.step,
      actorId: result.audit.actorId,
      actorName: result.audit.actorName,
      actorRole: result.audit.actorRole,
      comment: result.audit.comment,
      ipAddress: result.audit.ipAddress,
      userAgent: result.audit.userAgent,
      at: result.audit.at,
    });

    return {
      state: result.newState,
      finished: result.isFinished,
      currentStep: result.nextStep,
    };
  });
}

/** Các hành động được phép ở trạng thái hiện tại — UI dùng để hiện nút. */
export function actionsFor(state: string): WorkflowAction[] {
  return allowedActions(state as RequestState);
}

/**
 * Đánh giá điều kiện bước trên ngữ cảnh đơn.
 *
 * Mặc định 'throw': xem engine/workflow.ts — bản Phase 1 im lặng bỏ qua bước
 * khi trường thiếu, và đó là lỗi.
 */
export function checkStepCondition(
  cond: { field: string; op: string; value: unknown },
  context: Record<string, unknown>,
  onMissingField: OnMissingField = 'throw',
): boolean {
  return evaluateCondition(
    { field: cond.field, op: cond.op as '>', value: cond.value as number },
    context,
    onMissingField,
  );
}

/**
 * Nộp một kỳ lương ra duyệt, và khoá kỳ khi đơn được duyệt xong.
 *
 * Khoá là việc của tầng này chứ không phải của state machine: state machine chỉ
 * biết trạng thái, không biết "khoá bảng lương" nghĩa là gì.
 */
export async function submitPayRunForApproval(
  payRunId: string,
  actor: string,
  ipAddress = '0.0.0.0',
  db: Db = getDb(),
): Promise<{ requestId: string; chain: ApprovalChainStep[] }> {
  const [run] = await db.select().from(payRuns).where(eq(payRuns.id, payRunId)).limit(1);
  if (!run) throw new RangeError(`Không tìm thấy kỳ lương ${payRunId}`);
  if (run.status !== 'DRAFT') {
    throw new RangeError(
      `Kỳ ${run.periodMonth}/${run.periodYear} đang ở trạng thái ${run.status}, chỉ kỳ DRAFT mới nộp duyệt được.`,
    );
  }

  const submitted = await submitApproval(
    {
      docType: 'PAYRUN',
      docRef: payRunId,
      docLabel: `Bảng lương ${String(run.periodMonth).padStart(2, '0')}/${run.periodYear}`,
      value: run.netTotal,
      context: {
        grossTotal: run.grossTotal,
        netTotal: run.netTotal,
        pitTotal: run.pitTotal,
      },
      actor,
    },
    db,
  );

  await db.update(payRuns).set({ status: 'PENDING', updatedAt: new Date() }).where(eq(payRuns.id, payRunId));
  void ipAddress;
  return { requestId: submitted.requestId, chain: submitted.chain };
}

/**
 * Đồng bộ kỳ lương theo trạng thái đơn duyệt.
 *
 * Chỉ được gọi SAU khi actOnApproval thành công, trong cùng một luồng nghiệp vụ.
 */
export async function syncPayRunStatus(
  payRunId: string,
  state: RequestState,
  db: Db = getDb(),
): Promise<void> {
  const map: Record<string, string> = {
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    CANCELLED: 'DRAFT',
    RETURNED: 'DRAFT',
    PENDING_APPROVAL: 'PENDING',
  };
  const next = map[state];
  if (!next) return;
  await db.update(payRuns).set({ status: next, updatedAt: new Date() }).where(eq(payRuns.id, payRunId));
}

export { isFinalState };
