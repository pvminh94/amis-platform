/**
 * Test máy trạng thái duyệt.
 *
 * Nhóm quan trọng nhất là "trường thiếu" — bản Phase 1 im lặng bỏ qua bước
 * duyệt khi trường không tồn tại, và đó là lỗi chứ không phải tính năng.
 */

import { describe, it, expect } from 'vitest';
import {
  STATE_TRANSITIONS,
  REQUEST_STATES,
  WORKFLOW_ACTIONS,
  transition,
  canTransition,
  allowedActions,
  isFinalState,
  evaluateCondition,
  performApprovalAction,
  isValidIp,
  extractClientIp,
  WorkflowError,
  type RequestState,
  type WorkflowAction,
} from '../src/engine/workflow';
import { isUuid } from '../src/lib/uuid';

describe('bảng chuyển trạng thái', () => {
  it('mọi trạng thái đều có khoá trong bảng — không trạng thái nào undefined', () => {
    for (const s of REQUEST_STATES) {
      expect(STATE_TRANSITIONS[s], s).toBeDefined();
    }
  });

  it('ba trạng thái cuối có bảng RỖNG — không thoát ra được', () => {
    for (const s of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) {
      expect(allowedActions(s), s).toEqual([]);
      expect(isFinalState(s), s).toBe(true);
    }
  });

  it('trạng thái không cuối thì LUÔN có ít nhất một hành động', () => {
    // Một trạng thái không cuối mà không có lối ra là đơn bị kẹt vĩnh viễn.
    for (const s of REQUEST_STATES) {
      if (!isFinalState(s)) {
        expect(allowedActions(s).length, s).toBeGreaterThan(0);
      }
    }
  });

  it('mọi đích đến đều là trạng thái hợp lệ', () => {
    for (const [from, map] of Object.entries(STATE_TRANSITIONS)) {
      for (const [action, to] of Object.entries(map)) {
        expect(REQUEST_STATES, `${from}.${action}`).toContain(to);
        expect(WORKFLOW_ACTIONS, `${from}.${action}`).toContain(action);
      }
    }
  });

  it('không có đường nào từ trạng thái cuối quay lại', () => {
    // Nếu có, toàn bộ quy trình duyệt vô nghĩa.
    const reachable = (start: RequestState): Set<RequestState> => {
      const seen = new Set<RequestState>();
      const walk = (s: RequestState) => {
        for (const to of Object.values(STATE_TRANSITIONS[s])) {
          if (to && !seen.has(to)) {
            seen.add(to);
            walk(to);
          }
        }
      };
      walk(start);
      return seen;
    };
    for (const s of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) {
      expect([...reachable(s)], s).toEqual([]);
    }
  });
});

describe('transition()', () => {
  it('DRAFT + SUBMIT → PENDING_APPROVAL', () => {
    expect(transition('DRAFT', 'SUBMIT')).toBe('PENDING_APPROVAL');
  });

  it('chuyển đổi ngoài bảng bị từ chối với thông báo nêu các lựa chọn hợp lệ', () => {
    try {
      transition('APPROVED', 'REJECT');
      throw new Error('đáng lẽ phải ném');
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError);
      expect((e as WorkflowError).code).toBe('ILLEGAL_TRANSITION');
      expect((e as Error).message).toContain('không có — đơn đã kết thúc');
    }
  });

  it('APPROVE ở bước chưa cuối vẫn PENDING_APPROVAL', () => {
    expect(transition('PENDING_APPROVAL', 'APPROVE', { currentStep: 0, totalSteps: 3 })).toBe(
      'PENDING_APPROVAL',
    );
  });

  it('APPROVE ở bước cuối → APPROVED', () => {
    expect(transition('PENDING_APPROVAL', 'APPROVE', { currentStep: 2, totalSteps: 3 })).toBe(
      'APPROVED',
    );
  });

  it('totalSteps = 0 bị chặn thay vì chia ngầm và duyệt tắt cả chuỗi', () => {
    expect(() =>
      transition('PENDING_APPROVAL', 'APPROVE', { currentStep: 0, totalSteps: 0 }),
    ).toThrow(/Bước duyệt không hợp lệ/);
  });

  it('một cấp duyệt không thể chốt đơn một bước khi chuỗi có nhiều bước', () => {
    // Đây là lý do transition() cần totalSteps.
    const r = transition('PENDING_APPROVAL', 'APPROVE', { currentStep: 0, totalSteps: 4 });
    expect(r).toBe('PENDING_APPROVAL');
  });

  it('REJECT kết thúc ngay ở bất kỳ bước nào', () => {
    for (const step of [0, 1, 2]) {
      expect(
        transition('PENDING_APPROVAL', 'REJECT', { currentStep: step, totalSteps: 3 }),
      ).toBe('REJECTED');
    }
  });
});

describe('evaluateCondition — LỖ HỔNG TRƯỜNG THIẾU ĐÃ SỬA', () => {
  const ctx = { amount: 300_000_000, days: 5, type: 'ANNUAL', isPaid: true };

  it('trường thiếu thì NÉM LỖI, không im lặng bỏ qua bước', () => {
    // Bản Phase 1: Number(undefined) = NaN, NaN > 100_000_000 = false
    // → bước CEO bị bỏ qua cho một đơn 500 triệu. Không một lỗi nào hiện ra.
    expect(() =>
      evaluateCondition({ field: 'amountVnd', op: '>', value: 100_000_000 }, {}),
    ).toThrow(/MISSING_FIELD|tham chiếu trường/);
  });

  it('trường có nhưng rỗng cũng coi là thiếu', () => {
    // MISSING_FIELD là error CODE, không nằm trong message — phải đọc .code.
    const codeOf = (fn: () => unknown): string => {
      try {
        fn();
        return '(khong nem)';
      } catch (e) {
        return e instanceof WorkflowError ? e.code : `(khong phai WorkflowError: ${String(e)})`;
      }
    };
    expect(codeOf(() => evaluateCondition({ field: 'amount', op: '>', value: 1 }, { amount: '' }))).toBe('MISSING_FIELD');
    expect(codeOf(() => evaluateCondition({ field: 'amount', op: '>', value: 1 }, { amount: null }))).toBe('MISSING_FIELD');
  });

  it('0 KHÔNG phải là thiếu — đây là ranh giới dễ nhầm', () => {
    // Một đơn 0 đồng là đơn hợp lệ; một đơn thiếu trường tiền thì không.
    expect(evaluateCondition({ field: 'amount', op: '>', value: 0 }, { amount: 0 })).toBe(false);
    expect(evaluateCondition({ field: 'amount', op: '>=', value: 0 }, { amount: 0 })).toBe(true);
  });

  it('muốn khoan dung thì phải nói rõ onMissingField', () => {
    const cond = { field: 'amountVnd', op: '>' as const, value: 100_000_000 };
    expect(evaluateCondition(cond, {}, 'skipStep')).toBe(false);
    expect(evaluateCondition(cond, {}, 'zero')).toBe(false);
  });

  it("'zero' từ chối áp dụng cho so sánh chuỗi", () => {
    expect(() =>
      evaluateCondition({ field: 'type', op: '==', value: 'X' }, {}, 'zero'),
    ).toThrow(/chỉ áp dụng cho so sánh số/);
  });

  it('giá trị không phải số thì báo lỗi, không âm thầm thành NaN', () => {
    expect(() =>
      evaluateCondition({ field: 'amount', op: '>', value: 1 }, { amount: 'nhiều' }),
    ).toThrow(/cần là số/);
  });
});

describe('evaluateCondition — các toán tử', () => {
  const ctx = { amount: 300_000_000, days: 5, type: 'ANNUAL', isPaid: true };

  it.each([
    ['>', 100_000_000, true],
    ['>', 300_000_000, false],
    ['>=', 300_000_000, true],
    ['<', 300_000_000, false],
    ['<=', 300_000_000, true],
  ])('%s %s', (op, value, expected) => {
    expect(evaluateCondition({ field: 'amount', op: op as '>', value }, ctx)).toBe(expected);
  });

  it('== so sánh lỏng về kiểu vì điều kiện soạn trên form luôn ra chuỗi', () => {
    expect(evaluateCondition({ field: 'days', op: '==', value: '5' }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'isPaid', op: '==', value: 'true' }, ctx)).toBe(true);
  });

  it('!= là phủ định của ==', () => {
    expect(evaluateCondition({ field: 'type', op: '!=', value: 'ANNUAL' }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'type', op: '!=', value: 'SICK' }, ctx)).toBe(true);
  });

  it('in / nin', () => {
    expect(evaluateCondition({ field: 'type', op: 'in', value: ['ANNUAL', 'SICK'] }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'type', op: 'in', value: ['SICK'] }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'type', op: 'nin', value: ['SICK'] }, ctx)).toBe(true);
  });

  it('toán tử lạ bị từ chối thay vì trả về false', () => {
    expect(() =>
      evaluateCondition({ field: 'amount', op: '~=' as '>', value: 1 }, ctx),
    ).toThrow(/Toán tử điều kiện không hỗ trợ/);
  });
});

describe('performApprovalAction — audit trail', () => {
  const base = {
    requestId: 'req-1',
    currentState: 'PENDING_APPROVAL' as RequestState,
    action: 'APPROVE' as WorkflowAction,
    actorId: 'u1',
    actorName: 'Trần Trưởng phòng',
    actorRole: 'DEPT_HEAD',
    currentStep: 0,
    totalSteps: 2,
    ipAddress: '10.0.0.5',
  };

  it('sinh bản ghi audit đầy đủ và tiến bước', () => {
    const r = performApprovalAction(base);
    expect(r.newState).toBe('PENDING_APPROVAL');
    expect(r.nextStep).toBe(1);
    expect(r.isFinished).toBe(false);
    expect(r.audit.fromStatus).toBe('PENDING_APPROVAL');
    expect(r.audit.toStatus).toBe('PENDING_APPROVAL');
    expect(r.audit.step).toBe(1);
    expect(r.audit.actorId).toBe('u1');
  });

  it('bước cuối đánh dấu kết thúc', () => {
    const r = performApprovalAction({ ...base, currentStep: 1 });
    expect(r.newState).toBe('APPROVED');
    expect(r.isFinished).toBe(true);
  });

  it('APPROVE/REJECT/RETURN bắt buộc có người thực hiện', () => {
    for (const action of ['APPROVE', 'REJECT', 'RETURN'] as const) {
      expect(() => performApprovalAction({ ...base, action, actorId: null })).toThrow(
        /bắt buộc phải có người thực hiện/,
      );
    }
  });

  it('CANCEL thì không cần người duyệt cụ thể', () => {
    const r = performApprovalAction({
      ...base,
      action: 'CANCEL',
      actorId: null,
      currentState: 'DRAFT',
    });
    expect(r.newState).toBe('CANCELLED');
  });

  it('IP rác bị chặn — audit trail không phải nơi chứa rác', () => {
    expect(() => performApprovalAction({ ...base, ipAddress: 'không phải ip' })).toThrow(
      /IP không hợp lệ/,
    );
  });
});

describe('isValidIp', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.5', true],
    ['255.255.255.255', true],
    ['256.1.1.1', false],
    ['1.2.3', false],
    ['', false],
    [null, false],
    ['::1', true],
    ['2001:db8::1', true],
  ])('%s → %s', (ip, expected) => {
    expect(isValidIp(ip as string | null)).toBe(expected);
  });
});

describe('extractClientIp', () => {
  it('lấy giá trị ĐẦU của X-Forwarded-For — đó là client gốc', () => {
    expect(extractClientIp({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1, 10.0.0.2' })).toBe('1.2.3.4');
  });

  it('header rác thì bỏ qua và rơi về socket', () => {
    expect(extractClientIp({ 'x-forwarded-for': 'rác' }, '10.0.0.9')).toBe('10.0.0.9');
  });

  it('không có gì hợp lệ thì 0.0.0.0 — không ném, vì log vẫn phải ghi được', () => {
    expect(extractClientIp({})).toBe('0.0.0.0');
  });
});

describe('isUuid — chặn trước khi chạm PostgreSQL', () => {
  // Không kiểm tra thì id rác làm PostgreSQL ném 22P02 và người dùng nhận 500
  // thay vì 404. Đã xảy ra thật với /approvals/khong-ton-tai.
  it.each([
    ['d1e2a2ef-d74f-4070-8297-d9c68c944ece', true],
    ['00000000-0000-4000-8000-000000000001', true],
    ['D1E2A2EF-D74F-4070-8297-D9C68C944ECE', true],
    ['khong-ton-tai', false],
    ['d1e2a2ef-d74f-4070-8297-d9c68c944ec', false],
    ['d1e2a2ef-d74f-4070-8297-d9c68c944ece-extra', false],
    ["'; DROP TABLE approval_requests; --", false],
    ['', false],
  ])('%s → %s', (v, expected) => {
    expect(isUuid(v)).toBe(expected);
  });
});
