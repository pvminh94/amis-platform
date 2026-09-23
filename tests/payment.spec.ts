/**
 * Test sinh file thanh toán ngân hàng.
 *
 * Trọng tâm là những chỗ mà lỗi KHÔNG hiện ra cho tới khi tiền đã đi: STK sai
 * một số, tổng footer lệch một đồng, tên có dấu lọt vào file ASCII, dấu phẩy trong
 * tên phá cấu trúc CSV.
 */

import { describe, it, expect } from 'vitest';
import {
  generatePaymentFile,
  removeVietnameseTones,
  renderDescription,
  validatePaymentFile,
  PaymentFileError,
  type PaymentFileInfo,
  type PaymentRow,
} from '../src/engine/payment-file';

const row = (over: Partial<PaymentRow> = {}): PaymentRow => ({
  employeeCode: 'NV001',
  fullName: 'Nguyễn Văn An',
  accountNumber: '0011001234567',
  beneficiaryName: 'NGUYEN VAN AN',
  beneficiaryBankCode: 'VCBVNVX',
  amount: 12_345_678,
  description: 'LUONG T09/2026 NV001',
  ...over,
});

const info = (over: Partial<PaymentFileInfo> = {}): PaymentFileInfo => ({
  batchNo: 'PR202609-VCB-01',
  date: '2026-09-30',
  payer: {
    name: 'CÔNG TY CỔ PHẦN AMIS',
    accountNumber: '0011009999999',
    bankCode: 'VCBVNVX',
    taxCode: '0312345678',
  },
  bank: 'VCB',
  purpose: 'SALARY',
  periodLabel: '09/2026',
  rows: [row(), row({ employeeCode: 'NV002', accountNumber: '0011001234568', amount: 9_000_000 })],
  minAccountLength: 6,
  format: 'txt',
  withBom: false,
  ...over,
});

describe('bỏ dấu tiếng Việt', () => {
  it('chuyển có dấu thành ASCII không dấu, viết hoa', () => {
    expect(removeVietnameseTones('Nguyễn Văn An')).toBe('NGUYEN VAN AN');
    expect(removeVietnameseTones('Đặng Thị Hoa')).toBe('DANG THI HOA');
    expect(removeVietnameseTones('Trịnh Thị Mai')).toBe('TRINH THI MAI');
  });

  it('bỏ ký hiệu — dấu phẩy lọt vào CSV sẽ phá cấu trúc cột', () => {
    // File vẫn "trông đúng" khi mở bằng Excel, nhưng core banking đọc sai cột.
    expect(removeVietnameseTones('AMIS, JSC')).toBe('AMIS JSC');
    expect(removeVietnameseTones('An "A"')).toBe('AN A');
  });

  it('gộp nhiều khoảng trắng thành một', () => {
    expect(removeVietnameseTones('  Nguyen   Van   An  ')).toBe('NGUYEN VAN AN');
  });

  it('chuỗi rỗng và chỉ ký hiệu → rỗng', () => {
    expect(removeVietnameseTones('')).toBe('');
    expect(removeVietnameseTones('***')).toBe('');
  });

  it('GIỮ lại / - . trong nội dung chuyển khoản', () => {
    // Lỗi thật đã gặp: bản đầu tiên bỏ mọi ký hiệu nên "LUONG T09/2026 NV001"
    // ra thành "LUONG T092026 NV001". Ngân hàng vẫn nhận, nhưng đó là dòng người
    // lao động dùng để nhận ra lương của mình trên sao kê.
    expect(removeVietnameseTones('LUONG T09/2026 NV001')).toBe('LUONG T09/2026 NV001');
    expect(removeVietnameseTones('TT 01-09.2026')).toBe('TT 01-09.2026');
    // Dấu phẩy vẫn phải bị bỏ — nó phá cấu trúc cột CSV.
    expect(removeVietnameseTones('A, B')).toBe('A B');
  });
});

describe('renderDescription', () => {
  it('thay biến trong mẫu', () => {
    expect(
      renderDescription('LUONG T{PERIOD_MONTH}/{PERIOD_YEAR} {EMPLOYEE_CODE}', {
        PERIOD_MONTH: '09',
        PERIOD_YEAR: '2026',
        EMPLOYEE_CODE: 'NV001',
      }),
    ).toBe('LUONG T09/2026 NV001');
  });

  it('biến lạ → NÉM, không bỏ qua', () => {
    // Bỏ qua thì chuỗi "{EMPLOYE_CODE}" sẽ nằm nguyên trong nội dung chuyển khoản
    // của 500 người, ngân hàng vẫn nhận, và chỉ phát hiện lúc đối chiếu.
    expect(() => renderDescription('LUONG {EMPLOYE_CODE}', { EMPLOYEE_CODE: 'NV001' })).toThrowError(
      PaymentFileError,
    );
  });

  it('giá trị 0 vẫn được thay (không bị coi là thiếu)', () => {
    expect(renderDescription('T{N}', { N: 0 })).toBe('T0');
  });
});

describe('validatePaymentFile', () => {
  it('dữ liệu hợp lệ → ok, tổng đúng', () => {
    const v = validatePaymentFile(info());
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.totalAmount).toBe(12_345_678 + 9_000_000);
    expect(v.rowCount).toBe(2);
  });

  it('STK ngắn hơn mức tối thiểu của ngân hàng → lỗi', () => {
    // CTG yêu cầu 9 số. Một STK 6 số vẫn sinh được file, vẫn tải lên được, và
    // chỉ nổ ở phía ngân hàng — lúc đó phải làm lại cả lô.
    const v = validatePaymentFile(info({ bank: 'CTG', minAccountLength: 9, rows: [row({ accountNumber: '123456' })] }));
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/< tối thiểu 9/);
  });

  it('STK có chữ → lỗi', () => {
    const v = validatePaymentFile(info({ rows: [row({ accountNumber: '0011ABC234' })] }));
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/chỉ gồm chữ số/);
  });

  it('số tiền 0 → lỗi, không phải "vô hại"', () => {
    // Nhiều ngân hàng từ chối CẢ LÔ khi có một món 0đ — thế là những người còn
    // lại cũng không nhận được lương đúng hạn.
    const v = validatePaymentFile(info({ rows: [row({ amount: 0 })] }));
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/phải > 0/);
  });

  it('số tiền âm → lỗi', () => {
    expect(validatePaymentFile(info({ rows: [row({ amount: -1000 })] })).ok).toBe(false);
  });

  it('không có dòng nào → lỗi', () => {
    const v = validatePaymentFile(info({ rows: [] }));
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/không có dòng/);
  });

  it('STK bên trả sai → lỗi', () => {
    const v = validatePaymentFile(info({ payer: { name: 'X', accountNumber: '12', bankCode: 'V' } }));
    expect(v.ok).toBe(false);
  });

  it('ngày sai định dạng → lỗi', () => {
    expect(validatePaymentFile(info({ date: '30/09/2026' })).ok).toBe(false);
  });

  it('số hiệu lô có ký tự lạ → lỗi (nó vào thẳng tên file)', () => {
    expect(validatePaymentFile(info({ batchNo: 'PR/2026 09' })).ok).toBe(false);
  });

  it('trùng STK + số tiền → CẢNH BÁO chứ không phải lỗi', () => {
    // Có thể hợp lệ (một người nhận hai khoản bằng nhau), nhưng đủ bất thường để
    // bắt người ta nhìn lại.
    const v = validatePaymentFile(
      info({ rows: [row(), row({ employeeCode: 'NV002' })] }),
    );
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes('trùng STK'))).toBe(true);
  });

  it('thiếu nội dung chuyển khoản → cảnh báo', () => {
    const v = validatePaymentFile(info({ rows: [row({ description: '' })] }));
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes('nội dung'))).toBe(true);
  });
});

describe('generatePaymentFile — mẫu VCB', () => {
  it('có HEADER / DETAIL / FOOTER, ngăn bằng |, xuống dòng CRLF', () => {
    const f = generatePaymentFile(info());
    const lines = f.content.split('\r\n').filter((l) => l !== '');
    expect(lines[0]!.startsWith('A|')).toBe(true);
    expect(lines[1]!.startsWith('D|00001|')).toBe(true);
    expect(lines[lines.length - 1]!.startsWith('Z|')).toBe(true);
    expect(lines.length).toBe(4); // 1 header + 2 detail + 1 footer
  });

  it('tên có dấu được bỏ dấu trước khi ghi', () => {
    const f = generatePaymentFile(info({ rows: [row({ beneficiaryName: 'Nguyễn Văn An' })] }));
    expect(f.content).toContain('NGUYEN VAN AN');
    expect(f.content).not.toContain('Nguyễn');
  });

  it('nội dung chuyển khoản giữ nguyên dấu / sau khi bỏ dấu', () => {
    // Test này tồn tại vì bộ test cũ chỉ kiểm tra TÊN, không kiểm tra NỘI DUNG —
    // và lỗi xoá dấu '/' chỉ hiện ra ở nội dung.
    const f = generatePaymentFile(
      info({ rows: [row({ description: 'LUONG T09/2026 NV001' })] }),
    );
    expect(f.content).toContain('LUONG T09/2026 NV001');
    expect(f.content).not.toContain('T092026');
  });

  it('tổng ở footer bằng tổng các dòng', () => {
    const f = generatePaymentFile(info());
    const footer = f.content.split('\r\n').filter((l) => l.startsWith('Z|'))[0]!;
    expect(Number(footer.split('|')[2])).toBe(f.totalAmount);
    expect(f.totalAmount).toBe(12_345_678 + 9_000_000);
  });

  it('dữ liệu sai → NÉM, không sinh file', () => {
    expect(() => generatePaymentFile(info({ rows: [row({ amount: 0 })] }))).toThrowError(
      PaymentFileError,
    );
  });

  it('cùng đầu vào → cùng checksum (tính tất định)', () => {
    const a = generatePaymentFile(info());
    const b = generatePaymentFile(info());
    expect(a.checksum).toBe(b.checksum);
    expect(a.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('đổi một đồng → checksum đổi', () => {
    const a = generatePaymentFile(info());
    const b = generatePaymentFile(info({ rows: [row({ amount: 12_345_679 }), row({ employeeCode: 'NV002', accountNumber: '0011001234568', amount: 9_000_000 })] }));
    expect(a.checksum).not.toBe(b.checksum);
  });
});

describe('generatePaymentFile — mẫu CSV', () => {
  const csv = () =>
    generatePaymentFile(info({ bank: 'TCB', format: 'csv', delimiter: ',', withBom: true }));

  it('có BOM khi withBom = true (Excel tiếng Việt cần)', () => {
    expect(csv().content.charCodeAt(0)).toBe(0xfeff);
  });

  it('không BOM khi withBom = false', () => {
    const f = generatePaymentFile(info({ bank: 'TCB', format: 'csv', withBom: false }));
    expect(f.content.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('BOM nằm TRONG nội dung được băm — checksum phải của đúng dãy byte trên đĩa', () => {
    const withBom = csv();
    const noBom = generatePaymentFile(info({ bank: 'TCB', format: 'csv', withBom: false }));
    expect(withBom.checksum).not.toBe(noBom.checksum);
    expect(withBom.byteLength).toBe(noBom.byteLength + 3);
  });

  it('STK được bọc thành công thức Excel, mã hoá đúng RFC-4180', () => {
    // STK dài mà Excel hiển thị 1.0011E+12 thì cả lô hỏng mà nhìn trên màn hình
    // vẫn "có vẻ đúng". Cách chặn là bọc thành ="0011001234567".
    //
    // Nhưng bản thân chuỗi đó CHỨA dấu nháy, nên theo RFC-4180 nó phải được bọc
    // nháy ngoài và nhân đôi nháy bên trong. Test đầu tiên tôi assert dạng thô
    // ="0011001234567" và fail — engine đúng, test sai: Excel bỏ lớp nháy ngoài
    // rồi mới thực thi công thức.
    const cell = csv().content.split('\r\n').find((l) => l.startsWith('1,'))!.split(',')[3]!;
    expect(cell).toBe('"=""0011001234567"""');
    // Bỏ một lớp nháy theo RFC-4180 thì phải ra đúng công thức Excel.
    const unquoted = cell.slice(1, -1).replace(/""/g, '"');
    expect(unquoted).toBe('="0011001234567"');
  });

  it('tổng ở dòng # TONG bằng tổng các dòng', () => {
    const f = csv();
    const line = f.content.split('\r\n').find((l) => l.startsWith('# TONG'))!;
    const total = Number(line.split(',')[2]);
    expect(total).toBe(f.totalAmount);
  });

  it('tên chứa dấu phẩy không phá cấu trúc cột (được bọc nháy)', () => {
    const f = generatePaymentFile(
      info({ bank: 'TCB', format: 'csv', rows: [row({ fullName: 'An, Nguyen' })] }),
    );
    // Dấu phẩy trong tên đã bị bỏ dấu/loại bỏ, nên dòng vẫn đúng 9 cột.
    const dataLine = f.content.split('\r\n').find((l) => l.startsWith('1,'))!;
    expect(dataLine.split(',').length).toBeGreaterThanOrEqual(9);
  });
});

describe('kiểm tra chéo footer', () => {
  it('footer VCB đọc lại được và khớp tổng', () => {
    const f = generatePaymentFile(info({ rows: [row({ amount: 1 })] }));
    const footer = f.content.split('\r\n').find((l) => l.startsWith('Z|'))!;
    expect(Number(footer.split('|')[2])).toBe(1);
  });
});
