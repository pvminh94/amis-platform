/**
 * ============================================================================
 * MÁY TRẠNG THÁI DUYỆT — port từ Phase 1 (src/domain/approval.ts, 508 dòng)
 * ============================================================================
 *
 * ĐÂY LÀ CODE CỐ ĐỊNH, KHÔNG PHẢI DỮ LIỆU.
 *
 * Bảng chuyển trạng thái là bất biến nghiệp vụ: một đơn đã APPROVED không được
 * quay lại PENDING_APPROVAL, một đơn REJECTED không được SUBMIT lại. Nếu để
 * người dùng sửa được bảng này trên giao diện thì toàn bộ giá trị của quy trình
 * duyệt biến mất — ai cũng có thể tự duyệt đơn của mình bằng cách đổi luật.
 *
 * Cái là DỮ LIỆU nằm ở loại chính sách APPROVAL: ngưỡng bao nhiêu thì cần cấp
 * nào, chuỗi duyệt gồm những ai. Luật chơi cố định, thông số điều chỉnh được.
 *
 * ---------------------------------------------------------------------------
 * MỘT LỖ HỔNG TRONG BẢN GỐC ĐÃ SỬA KHI PORT
 * ---------------------------------------------------------------------------
 *
 * `evaluateCondition` bản Phase 1 đọc `ctx[cond.field]` rồi so sánh trực tiếp.
 * Nếu trường đó THIẾU thì `Number(undefined)` là `NaN`, và `NaN > 5` là
 * `false` — bước duyệt bị BỎ QUA trong im lặng, không một lỗi nào hiện ra.
 *
 * Nghĩa là một đơn chi 500 triệu thiếu trường `amount` sẽ đi thẳng qua bước
 * CEO. Đây đúng cùng một họ lỗi với `onMissingVar: 'zero'` trong engine công
 * thức: giá trị mặc định im lặng ở nơi không được phép có giá trị mặc định.
 *
 * Nay mặc định là NÉM LỖI. Muốn khoan dung thì phải viết rõ `onMissingField`.
 */

// ---------------------------------------------------------------------------
// KIỂU
// ---------------------------------------------------------------------------

export const REQUEST_STATES = [
  'DRAFT',
  'SUBMITTED',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'RETURNED',
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const WORKFLOW_ACTIONS = [
  'SUBMIT',
  'APPROVE',
  'REJECT',
  'RETURN',
  'CANCEL',
  'REASSIGN',
  'AUTO_APPROVE',
  'ESCALATE',
] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

export const CONDITION_OPERATORS = ['>', '>=', '<', '<=', '==', '!=', 'in', 'nin'] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface ApprovalCondition {
  /** Trường trên đơn: days | hours | amount | amountVnd | docType … */
  field: string;
  op: ConditionOperator;
  value: number | string | boolean | Array<string | number>;
}

/** Trường thiếu thì xử lý thế nào khi đánh giá điều kiện. */
export type OnMissingField = 'throw' | 'skipStep' | 'zero';

export class WorkflowError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// BẢNG CHUYỂN TRẠNG THÁI
// ---------------------------------------------------------------------------

/**
 * Mọi chuyển đổi ngoài bảng này bị từ chối.
 *
 * Ba trạng thái cuối (APPROVED, REJECTED, CANCELLED) có bảng RỖNG — đó là cách
 * biểu diễn "không thoát ra được". Viết thành `{}` rõ ràng hơn là thiếu khoá,
 * vì thiếu khoá thì `STATE_TRANSITIONS[state]` là `undefined` và code phía sau
 * phải phòng thủ ở mọi chỗ đọc.
 */
export const STATE_TRANSITIONS: Record<
  RequestState,
  Partial<Record<WorkflowAction, RequestState>>
> = {
  DRAFT: {
    SUBMIT: 'PENDING_APPROVAL',
    CANCEL: 'CANCELLED',
  },
  SUBMITTED: {
    APPROVE: 'PENDING_APPROVAL',
    AUTO_APPROVE: 'APPROVED',
    CANCEL: 'CANCELLED',
    REJECT: 'REJECTED',
  },
  PENDING_APPROVAL: {
    // Vẫn ở PENDING_APPROVAL; transition() sẽ đổi thành APPROVED nếu là bước cuối.
    APPROVE: 'PENDING_APPROVAL',
    REJECT: 'REJECTED',
    RETURN: 'RETURNED',
    CANCEL: 'CANCELLED',
    ESCALATE: 'PENDING_APPROVAL',
    REASSIGN: 'PENDING_APPROVAL',
  },
  RETURNED: {
    SUBMIT: 'PENDING_APPROVAL',
    CANCEL: 'CANCELLED',
  },
  APPROVED: {},
  REJECTED: {},
  CANCELLED: {},
};

const FINAL_STATES: ReadonlySet<RequestState> = new Set(['APPROVED', 'REJECTED', 'CANCELLED']);

export function isFinalState(state: RequestState): boolean {
  return FINAL_STATES.has(state);
}

export function canTransition(state: RequestState, action: WorkflowAction): boolean {
  return STATE_TRANSITIONS[state]?.[action] !== undefined;
}

export function allowedActions(state: RequestState): WorkflowAction[] {
  return Object.keys(STATE_TRANSITIONS[state] ?? {}) as WorkflowAction[];
}

/**
 * Thực hiện một bước chuyển. Ném WorkflowError nếu không hợp lệ.
 *
 * `APPROVE` ở PENDING_APPROVAL cần biết đang ở bước mấy: chỉ thành APPROVED khi
 * đã duyệt hết chuỗi. Nếu không, một cấp duyệt đơn lẻ sẽ chốt luôn cả đơn.
 */
export function transition(
  current: RequestState,
  action: WorkflowAction,
  ctx: { currentStep?: number; totalSteps?: number } = {},
): RequestState {
  const next = STATE_TRANSITIONS[current]?.[action];
  if (next === undefined) {
    throw new WorkflowError(
      'ILLEGAL_TRANSITION',
      `Không thể thực hiện "${action}" ở trạng thái "${current}". ` +
        `Các hành động hợp lệ: ${allowedActions(current).join(', ') || '(không có — đơn đã kết thúc)'}`,
    );
  }
  if (action === 'APPROVE' && current === 'PENDING_APPROVAL') {
    const { currentStep = 0, totalSteps = 1 } = ctx;
    if (!Number.isInteger(currentStep) || !Number.isInteger(totalSteps) || totalSteps < 1) {
      throw new WorkflowError(
        'BAD_STEP_CONTEXT',
        `Bước duyệt không hợp lệ: currentStep=${currentStep}, totalSteps=${totalSteps}.`,
      );
    }
    return currentStep + 1 >= totalSteps ? 'APPROVED' : 'PENDING_APPROVAL';
  }
  return next;
}

// ---------------------------------------------------------------------------
// ĐÁNH GIÁ ĐIỀU KIỆN
// ---------------------------------------------------------------------------

function isMissing(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

/**
 * Đánh giá một điều kiện trên ngữ cảnh đơn.
 *
 * `onMissingField` mặc định là `'throw'` — xem giải thích ở đầu file.
 */
export function evaluateCondition(
  cond: ApprovalCondition,
  ctx: Record<string, unknown>,
  onMissingField: OnMissingField = 'throw',
): boolean {
  const present = Object.prototype.hasOwnProperty.call(ctx, cond.field);
  const raw = present ? ctx[cond.field] : undefined;

  /**
   * Giá trị thực sự đem ra so sánh. Tách khỏi `raw` vì nhánh 'zero' phải thay
   * thế được — bản đầu tiên chỉ `break` ra khỏi switch rồi vẫn dùng `raw`
   * (undefined), nên toNumber ném NOT_A_NUMBER thay vì so với 0.
   */
  let actual: unknown = raw;

  if (isMissing(raw)) {
    if (onMissingField === 'throw') {
      throw new WorkflowError(
        'MISSING_FIELD',
        `Điều kiện duyệt tham chiếu trường '${cond.field}' nhưng đơn không có trường này. ` +
          `Không thể tự suy ra — một bước duyệt bị bỏ qua trong im lặng là rủi ro không chấp nhận được.`,
      );
    }
    if (onMissingField === 'skipStep') return false;
    // 'zero' — chỉ dành cho so sánh số, và phải nói rõ là đang làm vậy.
    if (!['>', '>=', '<', '<='].includes(cond.op)) {
      throw new WorkflowError(
        'MISSING_FIELD',
        `onMissingField='zero' chỉ áp dụng cho so sánh số, không dùng được với '${cond.op}'.`,
      );
    }
    actual = 0;
  }

  switch (cond.op) {
    case '>':
      return toNumber(actual, cond.field) > toNumber(cond.value, cond.field);
    case '>=':
      return toNumber(actual, cond.field) >= toNumber(cond.value, cond.field);
    case '<':
      return toNumber(actual, cond.field) < toNumber(cond.value, cond.field);
    case '<=':
      return toNumber(actual, cond.field) <= toNumber(cond.value, cond.field);
    case '==':
      // So sánh lỏng về kiểu: 3 == "3" == true. Có chủ ý — điều kiện do người
      // dùng soạn trên form luôn ra chuỗi.
      return String(actual) === String(cond.value);
    case '!=':
      return String(actual) !== String(cond.value);
    case 'in': {
      const list = Array.isArray(cond.value) ? cond.value : [cond.value];
      return list.some((v) => String(v) === String(actual));
    }
    case 'nin': {
      const list = Array.isArray(cond.value) ? cond.value : [cond.value];
      return !list.some((v) => String(v) === String(actual));
    }
    default:
      throw new WorkflowError(
        'UNKNOWN_OPERATOR',
        `Toán tử điều kiện không hỗ trợ: ${String(cond.op)}`,
      );
  }
}

function toNumber(v: unknown, field: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) {
    throw new WorkflowError(
      'NOT_A_NUMBER',
      `Trường '${field}' cần là số để so sánh nhưng nhận được ${JSON.stringify(v)}.`,
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// HÀNH ĐỘNG DUYỆT + AUDIT
// ---------------------------------------------------------------------------

export interface AuditEntry {
  requestId: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  action: WorkflowAction;
  fromStatus: RequestState;
  toStatus: RequestState;
  step: number | null;
  comment: string | null;
  ipAddress: string;
  userAgent: string | null;
  at: Date;
}

export interface ActionInput {
  requestId: string;
  currentState: RequestState;
  action: WorkflowAction;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  /** Bước hiện tại, 0-based. */
  currentStep: number;
  totalSteps: number;
  comment?: string | null;
  ipAddress: string;
  userAgent?: string | null;
  now?: Date;
}

export interface ActionResult {
  newState: RequestState;
  nextStep: number;
  isFinished: boolean;
  audit: AuditEntry;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

/** Kiểm tra IP hợp lệ — chống ghi rác vào audit trail. */
export function isValidIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  if (IPV4_RE.test(ip)) {
    return ip.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
  }
  return ip.length <= 45 && IPV6_RE.test(ip);
}

/**
 * Thực hiện một hành động duyệt và sinh bản ghi audit BẤT BIẾN.
 *
 * Audit trail là thứ duy nhất trả lời được "ai đã duyệt cái này, lúc nào, từ
 * đâu". Nó chỉ có giá trị nếu không sửa được — nên bảng ghi chỉ có INSERT.
 */
export function performApprovalAction(input: ActionInput): ActionResult {
  if (!isValidIp(input.ipAddress)) {
    throw new WorkflowError('INVALID_IP', `Địa chỉ IP không hợp lệ: ${input.ipAddress}`);
  }
  if (input.action === 'APPROVE' || input.action === 'REJECT' || input.action === 'RETURN') {
    if (!input.actorId) {
      throw new WorkflowError(
        'ACTOR_REQUIRED',
        'Hành động duyệt bắt buộc phải có người thực hiện.',
      );
    }
  }

  const from = input.currentState;
  const to = transition(from, input.action, {
    currentStep: input.currentStep,
    totalSteps: input.totalSteps,
  });

  let nextStep = input.currentStep;
  if (input.action === 'APPROVE' && to === 'PENDING_APPROVAL') nextStep = input.currentStep + 1;

  const audit: AuditEntry = {
    requestId: input.requestId,
    actorId: input.actorId,
    actorName: input.actorName,
    actorRole: input.actorRole,
    action: input.action,
    fromStatus: from,
    toStatus: to,
    step: input.action === 'APPROVE' ? input.currentStep + 1 : input.currentStep,
    comment: input.comment ?? null,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent ?? null,
    at: input.now ?? new Date(),
  };

  return { newState: to, nextStep, isFinished: isFinalState(to), audit };
}

/**
 * Lấy IP thật của client.
 *
 * X-Forwarded-For là header DO CLIENT GỬI — ai cũng đặt được. Chỉ tin nó khi
 * chắc chắn có một reverse proxy đáng tin đứng trước đã ghi đè. Ở đây vẫn đọc
 * vì deployment thật luôn có proxy, nhưng giá trị phải qua isValidIp.
 */
export function extractClientIp(
  headers: Record<string, string | string[] | undefined>,
  socketRemote?: string,
): string {
  const xff = headers['x-forwarded-for'] ?? headers['X-Forwarded-For'];
  if (typeof xff === 'string' && xff.trim() !== '') {
    const first = xff.split(',')[0]!.trim();
    if (isValidIp(first)) return first;
  }
  if (Array.isArray(xff) && xff.length > 0) {
    const first = String(xff[0]).split(',')[0]!.trim();
    if (isValidIp(first)) return first;
  }
  const real = headers['x-real-ip'] ?? headers['X-Real-IP'];
  if (typeof real === 'string' && isValidIp(real)) return real;
  return socketRemote && isValidIp(socketRemote) ? socketRemote : '0.0.0.0';
}
