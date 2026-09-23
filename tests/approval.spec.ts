/**
 * ============================================================================
 * TEST — NGƯỠNG DUYỆT (schema + engine)
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';
import {
  approvalParamsSchema,
  approvalJsonSchema,
  SEED_APPROVAL_VN_STD,
  type ApprovalParams,
} from '../src/policy/approval-params.js';
import { resolveApprovalChain, findRule } from '../src/engine/approval.js';
import { expectSchemasAgree } from './helpers.js';

const P = SEED_APPROVAL_VN_STD;
const codes = (r: ReturnType<typeof resolveApprovalChain>) => r.chain.map((s) => s.code);

// ---------------------------------------------------------------------------
// 1. SCHEMA
// ---------------------------------------------------------------------------

describe('APPROVAL: JSON Schema và Zod schema khớp nhau', () => {
  it('cùng tập tên trường và cùng danh sách bắt buộc', () => {
    const { jsonFields } = expectSchemasAgree(approvalJsonSchema, approvalParamsSchema);
    expect(jsonFields).toEqual(['levels', 'regimeCode', 'regimeLabel', 'rules']);
  });

  it('seed parse được', () => {
    expect(approvalParamsSchema.safeParse(P).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. RÀNG BUỘC LÚC LƯU
// ---------------------------------------------------------------------------

describe('APPROVAL: ràng buộc chặn cấu hình sai lúc LƯU', () => {
  const patchLeave = (
    thresholds: ApprovalParams['rules'][number]['thresholds'],
  ): ApprovalParams => ({
    ...P,
    rules: P.rules.map((r) => (r.docType === 'LEAVE' ? { ...r, thresholds } : r)),
  });

  it('ngưỡng không tăng dần bị chặn — nếu không một giá trị khớp nhiều bậc', () => {
    const r = approvalParamsSchema.safeParse(
      patchLeave([
        { upto: 10, level: 'DIRECT_MANAGER' },
        { upto: 3, level: 'DEPT_HEAD' },
        { upto: null, level: 'HR_HEAD' },
      ]),
    );
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/phải LỚN HƠN ngưỡng trước/);
  });

  it('bậc cuối không mở bị chặn — nếu không đơn lớn sẽ KHÔNG CẦN AI DUYỆT', () => {
    const r = approvalParamsSchema.safeParse(
      patchLeave([
        { upto: 3, level: 'DIRECT_MANAGER' },
        { upto: 10, level: 'DEPT_HEAD' },
      ]),
    );
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/KHÔNG CẦN AI DUYỆT/);
  });

  it('bậc mở nằm giữa bị chặn', () => {
    const r = approvalParamsSchema.safeParse(
      patchLeave([
        { upto: null, level: 'DIRECT_MANAGER' },
        { upto: 10, level: 'DEPT_HEAD' },
      ]),
    );
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/phải là bậc CUỐI/);
  });

  it('ngưỡng trỏ tới cấp không tồn tại bị chặn', () => {
    const r = approvalParamsSchema.safeParse(
      patchLeave([{ upto: null, level: 'GIAM_DOC_KHONG_CO' }]),
    );
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/không tồn tại/);
  });

  it('trùng loại chứng từ bị chặn — không biết dùng bảng ngưỡng nào', () => {
    const r = approvalParamsSchema.safeParse({ ...P, rules: [...P.rules, P.rules[0]!] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/hai lần/);
  });

  it('trùng mã cấp và trùng thứ bậc bị chặn', () => {
    const dupCode = approvalParamsSchema.safeParse({
      ...P,
      levels: [...P.levels, { code: 'CEO', name: 'Trùng', order: 9 }],
    });
    expect(dupCode.success).toBe(false);
    expect(dupCode.error?.issues[0]?.message).toMatch(/'CEO' bị trùng/);

    const dupOrder = approvalParamsSchema.safeParse({
      ...P,
      levels: [...P.levels, { code: 'KHAC', name: 'Trùng bậc', order: 1 }],
    });
    expect(dupOrder.success).toBe(false);
    expect(dupOrder.error?.issues[0]?.message).toMatch(/Thứ bậc 1 bị trùng/);
  });

  it('mã không đúng quy ước bị chặn', () => {
    expect(
      approvalParamsSchema.safeParse({
        ...P,
        levels: [{ code: 'cap thuong', name: 'x', order: 1 }],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. ENGINE — CHUỖI DUYỆT
// ---------------------------------------------------------------------------

describe('Engine duyệt: trả về CHUỖI, không phải một người', () => {
  it('đơn nhỏ chỉ cần quản lý trực tiếp', () => {
    const r = resolveApprovalChain({ docType: 'LEAVE', value: 2 }, P);
    expect(codes(r)).toEqual(['DIRECT_MANAGER']);
    expect(r.matchedUpto).toBe(3);
  });

  it('đơn vừa cần cả quản lý trực tiếp LẪN trưởng phòng', () => {
    const r = resolveApprovalChain({ docType: 'LEAVE', value: 5 }, P);
    expect(codes(r)).toEqual(['DIRECT_MANAGER', 'DEPT_HEAD']);
    expect(r.matchedLevel).toBe('DEPT_HEAD');
  });

  it('ngưỡng là KHÔNG BAO GỒM: đúng 3 ngày đã sang bậc kế', () => {
    const r = resolveApprovalChain({ docType: 'LEAVE', value: 3 }, P);
    expect(r.matchedLevel).toBe('DEPT_HEAD');
    expect(codes(r)).toEqual(['DIRECT_MANAGER', 'DEPT_HEAD']);
  });

  it('đơn lớn đi hết chuỗi', () => {
    const r = resolveApprovalChain({ docType: 'LEAVE', value: 15 }, P);
    expect(codes(r)).toEqual(['DIRECT_MANAGER', 'DEPT_HEAD', 'HR_HEAD']);
    expect(r.matchedUpto).toBeNull();
  });

  /**
   * Test quan trọng nhất của engine này.
   *
   * EXPENSE có đường duyệt DIRECT_MANAGER → DEPT_HEAD → CHIEF_ACCOUNTANT → CEO.
   * HR_HEAD có thứ bậc 3 (giữa DEPT_HEAD và CHIEF_ACCOUNTANT) nhưng KHÔNG nằm
   * trong đường duyệt chi phí. Nếu dựng chuỗi bằng "mọi cấp có thứ bậc ≤ cấp
   * khớp" thì HR_HEAD sẽ bị kéo vào duyệt một đề nghị thanh toán — sai.
   */
  it('chuỗi lấy từ đường duyệt CỦA LUẬT, không kéo cấp không liên quan vào', () => {
    const r = resolveApprovalChain({ docType: 'EXPENSE', value: 300_000_000 }, P);
    expect(codes(r)).toEqual([
      'DIRECT_MANAGER',
      'DEPT_HEAD',
      'CHIEF_ACCOUNTANT',
      'CEO',
    ]);
    expect(codes(r)).not.toContain('HR_HEAD');
  });

  it('đề nghị thanh toán nhỏ chỉ cần quản lý trực tiếp', () => {
    const r = resolveApprovalChain({ docType: 'EXPENSE', value: 3_000_000 }, P);
    expect(codes(r)).toEqual(['DIRECT_MANAGER']);
  });

  it('bảng lương luôn cần kế toán trưởng', () => {
    const r = resolveApprovalChain({ docType: 'PAYRUN', value: 1_500_000_000 }, P);
    expect(codes(r)).toEqual(['CHIEF_ACCOUNTANT']);
  });

  it('chain sắp theo thứ bậc và đánh dấu bậc khớp', () => {
    const r = resolveApprovalChain({ docType: 'LEAVE', value: 5 }, P);
    expect(r.chain.map((s) => s.order)).toEqual([1, 2]);
    expect(r.chain.map((s) => s.isMatched)).toEqual([false, true]);
  });
});

describe('Engine duyệt: ném lỗi thay vì cho qua', () => {
  it('loại chứng từ chưa cấu hình → ném lỗi, KHÔNG mặc định cho quản lý duyệt', () => {
    // Nếu mặc định "cho quản lý trực tiếp duyệt" thì một đề nghị 500 triệu
    // sẽ âm thầm bỏ qua kế toán trưởng.
    expect(() => resolveApprovalChain({ docType: 'PURCHASE', value: 500_000_000 }, P)).toThrow(
      /chưa cấu hình ngưỡng duyệt/,
    );
    expect(() => findRule(P, 'PURCHASE')).toThrow(/PURCHASE/);
  });

  it('giá trị NaN → ném lỗi (NaN sẽ khớp sai bậc)', () => {
    expect(() => resolveApprovalChain({ docType: 'LEAVE', value: Number.NaN }, P)).toThrow(
      /không hữu hạn/,
    );
  });

  it('giá trị âm → ném lỗi', () => {
    expect(() => resolveApprovalChain({ docType: 'EXPENSE', value: -1 }, P)).toThrow(/âm/);
  });

  it('bộ tham số bị sửa ngoài giao diện (bậc cuối không mở) → ném lỗi', () => {
    const broken: ApprovalParams = {
      ...P,
      rules: [{ docType: 'X', label: 'X', unit: 'đ', thresholds: [{ upto: 10, level: 'CEO' }] }],
    };
    expect(() => resolveApprovalChain({ docType: 'X', value: 100 }, broken)).toThrow(
      /Không bậc ngưỡng nào khớp/,
    );
  });
});
