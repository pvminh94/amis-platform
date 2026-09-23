/**
 * ============================================================================
 * TEST — ENGINE CÔNG THỨC (tokenizer / parser / evaluator)
 * ============================================================================
 *
 * Port nguyên khối từ Phase 1 (src/domain/formula.ts). KHÔNG viết lại: đây là
 * code đã chạy thật trên VPS và đã bắt được lỗi. Viết lại một bộ parser mới
 * chỉ để "cho gọn" là cách nhanh nhất để đưa lỗ hổng bảo mật vào lại.
 *
 * Phần test về biểu thuế và giảm trừ gia cảnh của Phase 1 KHÔNG port theo, vì
 * Phase 2 đã có tests/policy.spec.ts viết lại cho engine PIT mới (tham số đọc
 * từ DB chứ không từ hằng số).
 */
import { describe, expect, it } from 'vitest';

import {
  compileFormula,
  evalFormula,
  extractVariables,
  FormulaError,
  tokenize,
  validateFormula,
} from '../src/engine/formula.js';

describe('tokenize', () => {
  it('tách số, biến, toán tử', () => {
    const t = tokenize('baseSalary * 0.1 + 1_000');
    expect(t.map((x) => x.type)).toEqual(['ident', 'op', 'num', 'op', 'num', 'eof']);
    expect(t[4]!.value).toBe('1000'); // dấu _ được bỏ
  });
  it('toán tử 2 ký tự', () => {
    const t = tokenize('a >= b && c != d');
    expect(t.map((x) => x.value)).toEqual(['a', '>=', 'b', '&&', 'c', '!=', 'd', '']);
  });
  it('bắt lỗi ký tự lạ', () => {
    expect(() => tokenize('a $ b')).toThrow(FormulaError);
  });
  it('số không hợp lệ', () => {
    expect(() => tokenize('1.2.3')).toThrow(FormulaError);
  });
});

describe('evalFormula — số học', () => {
  it('cộng trừ nhân chia và độ ưu tiên', () => {
    expect(evalFormula('2 + 3 * 4', {})).toBe(14);
    expect(evalFormula('(2 + 3) * 4', {})).toBe(20);
    expect(evalFormula('10 - 2 - 3', {})).toBe(5); // trái sang phải
    expect(evalFormula('100 / 5 / 2', {})).toBe(10);
    expect(evalFormula('7 % 3', {})).toBe(1);
  });
  it('luỹ thừa phải kết hợp', () => {
    expect(evalFormula('2 ^ 3 ^ 2', {})).toBe(512); // 2^(3^2)
  });
  it('unary trừ và NOT', () => {
    expect(evalFormula('-5 + 3', {})).toBe(-2);
    expect(evalFormula('--5', {})).toBe(5);
  });
  it('chia 0 trả về 0 (không crash công thức lương)', () => {
    expect(evalFormula('100 / 0', {})).toBe(0);
    expect(evalFormula('100 % 0', {})).toBe(0);
  });
  it('biến chưa khai báo = 0', () => {
    expect(evalFormula('a + 10', {})).toBe(10);
    expect(() => evalFormula('a + 10', {}, { onMissingVar: 'throw' })).toThrow(/chưa được khai báo/);
  });
  it('biến boolean', () => {
    expect(evalFormula('x ? 100 : 0', { x: true })).toBe(100);
    expect(evalFormula('x ? 100 : 0', { x: false })).toBe(0);
  });
});

describe('evalFormula — so sánh và logic', () => {
  it('toán tử so sánh', () => {
    expect(evalFormula('5 > 3', {})).toBe(1);
    expect(evalFormula('5 < 3', {})).toBe(0);
    expect(evalFormula('5 >= 5', {})).toBe(1);
    expect(evalFormula('5 <= 4', {})).toBe(0);
  });
  it('so sánh bằng lỏng về kiểu', () => {
    expect(evalFormula('a == 3', { a: 3 })).toBe(1);
    expect(evalFormula('a != 3', { a: 4 })).toBe(1);
  });
  it('short-circuit && và ||', () => {
    expect(evalFormula('a > 10 && b > 10', { a: 5, b: 100 })).toBe(0);
    expect(evalFormula('a > 10 || b > 10', { a: 5, b: 100 })).toBe(1);
  });
  it('toán tử ba ngôi lồng nhau', () => {
    expect(evalFormula('d >= 3 ? 100 : d >= 2 ? 50 : 10', { d: 3 })).toBe(100);
    expect(evalFormula('d >= 3 ? 100 : d >= 2 ? 50 : 10', { d: 2 })).toBe(50);
    expect(evalFormula('d >= 3 ? 100 : d >= 2 ? 50 : 10', { d: 1 })).toBe(10);
  });
});

describe('evalFormula — hàm có sẵn', () => {
  it('round half-up', () => {
    expect(evalFormula('round(2.5)', {})).toBe(3);
    expect(evalFormula('round(2.4)', {})).toBe(2);
    expect(evalFormula('round(-2.5)', {})).toBe(-3);
  });
  it('round1000 làm tròn xuống nghìn', () => {
    expect(evalFormula('round1000(12450)', {})).toBe(12000);
  });
  it('min / max / clamp / cap', () => {
    expect(evalFormula('min(10, 20, 5)', {})).toBe(5);
    expect(evalFormula('max(10, 20, 5)', {})).toBe(20);
    expect(evalFormula('clamp(150, 0, 100)', {})).toBe(100);
    expect(evalFormula('cap(9999999, 5000000)', {})).toBe(5000000);
    expect(evalFormula('floorAt(100, 500)', {})).toBe(500);
  });
  it('tier luỹ tiến', () => {
    // 3% đến 500tr, 5% từ 500tr–1tỷ, 7% trên 1 tỷ
    const f = 'tier(x, 500000000, 0.03, 1000000000, 0.05, 999999999999, 0.07)';
    expect(evalFormula(f, { x: 300_000_000 })).toBe(9_000_000);
    expect(evalFormula(f, { x: 800_000_000 })).toBe(15_000_000 + 15_000_000);
    expect(evalFormula(f, { x: 1_500_000_000 })).toBe(15_000_000 + 25_000_000 + 35_000_000);
  });
  it('if() dạng hàm', () => {
    expect(evalFormula('if(a > 5, 100, 0)', { a: 10 })).toBe(100);
    expect(evalFormula('if(a > 5, 100, 0)', { a: 1 })).toBe(0);
  });
  it('hàm không tồn tại → lỗi', () => {
    expect(() => evalFormula('khongCoHam(1)', {})).toThrow(/không tồn tại/);
  });
  it('sai số tham số → lỗi', () => {
    expect(() => evalFormula('round(1, 2)', {})).toThrow(/tham số/);
  });
});

describe('evalFormula — AN TOÀN (không eval)', () => {
  it('không truy cập được global/process', () => {
    expect(evalFormula('process', {})).toBe(0);
    expect(() => evalFormula('process.exit(1)', {})).toThrow();
  });
  it('không cho phép gán', () => {
    expect(validateFormula('a = 5').ok).toBe(false);
  });
  it('biểu thức rỗng → lỗi', () => {
    expect(() => compileFormula('')).toThrow(/rỗng/);
    expect(validateFormula('   ').ok).toBe(false);
  });
  it('thiếu đóng ngoặc → lỗi', () => {
    expect(validateFormula('(1 + 2').ok).toBe(false);
  });
  it('thừa token → lỗi', () => {
    expect(validateFormula('1 2').ok).toBe(false);
  });
});

describe('extractVariables / validateFormula', () => {
  it('liệt kê biến được tham chiếu', () => {
    expect(extractVariables('round(baseSalary * kpiScore / 100) + maxKpiSalary').sort()).toEqual([
      'baseSalary',
      'kpiScore',
      'maxKpiSalary',
    ]);
  });
  it('không liệt kê tên hàm', () => {
    expect(extractVariables('min(a, b)')).toEqual(['a', 'b']);
  });
  it('validateFormula trả về biến khi hợp lệ', () => {
    const r = validateFormula('a > b ? c : d');
    expect(r.ok).toBe(true);
    expect(r.variables.sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('compileFormula có cache', () => {
    const a = compileFormula('1 + 1');
    const b = compileFormula('1 + 1');
    expect(a).toBe(b);
  });
});

// ===========================================================================
// THUẾ LUỸ TIẾN
// ===========================================================================
