/**
 * ============================================================================
 * SINH FILE ỦY NHIỆM CHI (UNC) / FILE THANH TOÁN LƯƠNG THEO MẪU NGÂN HÀNG
 * ============================================================================
 *
 * VCB / TCB / CTG / MBB / GENERIC.
 *
 * ⚠️ LƯU Ý TRIỂN KHAI: mẫu file của từng ngân hàng được cập nhật định kỳ và khác
 * nhau giữa các kênh (iBanking doanh nghiệp / ERP Connect / H2H). Các hàm ở đây
 * sinh ĐỊNH DẠNG PHỔ BIẾN NHẤT đang được chấp nhận. TRƯỚC KHI GO-LIVE phải đối
 * chiếu lại với mẫu hiện hành do ngân hàng cấp.
 *
 * BA NGUYÊN TẮC:
 *
 *  1. KHÔNG BAO GIỜ SINH FILE SAI. `generatePaymentFile` ném lỗi nếu validate
 *     không đạt. Một file UNC sai mà vẫn sinh ra được thì sẽ có người tải nó lên
 *     iBanking, và tiền đi thật — không hoàn tác được bằng cách sửa code.
 *
 *  2. TỔNG Ở FOOTER PHẢI BẰNG TỔNG CÁC DÒNG. Đây là phép kiểm tra chéo nội bộ:
 *     nếu hai chỗ tính tổng lệch nhau thì có bug, và thà ném lỗi còn hơn gửi một
 *     lô mà ngân hàng từ chối giữa chừng.
 *
 *  3. CHECKSUM. File UNC là chứng từ chi tiền. SHA-256 của nội dung được trả về
 *     để lưu cùng lô — sau này có tranh chấp "file có bị sửa không" thì đó là
 *     bằng chứng duy nhất.
 */

import { createHash } from 'node:crypto';

import { roundVnd } from './money';

export type BankCode = 'VCB' | 'TCB' | 'CTG' | 'MBB' | 'GENERIC';

export interface PaymentRow {
  employeeCode: string;
  fullName: string;
  /** Số tài khoản nhận */
  accountNumber: string;
  /** Tên chủ tài khoản ĐÚNG NHƯ NGÂN HÀNG GHI — không phải tên trong hồ sơ. */
  beneficiaryName: string;
  /** Mã NAPAS của ngân hàng thụ hưởng, vd 'VCBVNVX'. */
  beneficiaryBankCode?: string;
  beneficiaryBranch?: string;
  amount: number;
  /** Nội dung chuyển khoản — đã render từ mẫu. */
  description: string;
}

export interface PayerInfo {
  name: string;
  accountNumber: string;
  bankCode: string;
  branch?: string;
  taxCode?: string;
}

export interface PaymentFileInfo {
  batchNo: string;
  /** Ngày lập, 'YYYY-MM-DD' */
  date: string;
  payer: PayerInfo;
  bank: BankCode;
  purpose: 'SALARY' | 'TRANSFER';
  periodLabel: string;
  rows: PaymentRow[];
  /** Từ tham số ngân hàng trong database, không hardcode. */
  minAccountLength: number;
  format: 'csv' | 'txt';
  delimiter?: string;
  withBom?: boolean;
}

export class PaymentFileError extends Error {
  constructor(
    readonly code:
      | 'INVALID_PAYMENT_DATA'
      | 'EMPTY_FILE'
      | 'TOTAL_MISMATCH'
      | 'BAD_DATE'
      | 'BAD_BATCH_NO',
    message: string,
  ) {
    super(message);
    this.name = 'PaymentFileError';
  }
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  totalAmount: number;
  rowCount: number;
}

// ---------------------------------------------------------------------------
// KIỂM TRA DỮ LIỆU
// ---------------------------------------------------------------------------

export function validatePaymentFile(info: PaymentFileInfo): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(info.date)) {
    errors.push(`Ngày lập phải theo dạng YYYY-MM-DD, nhận "${info.date}"`);
  }
  if (!info.batchNo || !/^[A-Za-z0-9_-]{1,40}$/.test(info.batchNo)) {
    // Số hiệu lô vào thẳng tên file. Một ký tự '/' hay khoảng trắng trong đó sẽ
    // tạo ra đường dẫn hỏng, và lỗi hiện ra ở tầng ghi file chứ không phải ở đây.
    errors.push(`Số hiệu lô không hợp lệ: "${info.batchNo}"`);
  }
  if (!info.payer.accountNumber || !/^\d{6,20}$/.test(info.payer.accountNumber)) {
    errors.push(`STK bên trả không hợp lệ: "${info.payer.accountNumber}"`);
  }
  if (!info.payer.name) errors.push('Thiếu tên bên trả');
  if (info.rows.length === 0) errors.push('File không có dòng thanh toán nào');

  const seen = new Set<string>();
  let total = 0;

  info.rows.forEach((r, i) => {
    const where = `dòng ${i + 1} (${r.employeeCode || '?'})`;
    if (!r.accountNumber || !/^\d+$/.test(r.accountNumber)) {
      errors.push(`${where}: STK phải chỉ gồm chữ số, nhận "${r.accountNumber}"`);
    } else if (r.accountNumber.length < info.minAccountLength) {
      errors.push(
        `${where}: STK ${r.accountNumber.length} số < tối thiểu ${info.minAccountLength} của ${info.bank}`,
      );
    }
    if (!r.beneficiaryName || r.beneficiaryName.trim().length < 2) {
      errors.push(`${where}: thiếu tên người thụ hưởng`);
    }
    const amt = roundVnd(r.amount);
    if (!Number.isFinite(amt)) {
      errors.push(`${where}: số tiền không phải số hữu hạn: ${r.amount}`);
    } else if (amt <= 0) {
      // Số tiền 0 không phải "vô hại": nhiều ngân hàng từ chối CẢ LÔ khi có một
      // món 0đ, và thế là 499 người còn lại không nhận được lương đúng hạn.
      errors.push(`${where}: số tiền phải > 0, nhận ${amt}`);
    }
    if (!r.description || r.description.trim() === '') {
      warnings.push(`${where}: thiếu nội dung chuyển khoản — ngân hàng có thể từ chối`);
    }
    const key = `${r.accountNumber}:${amt}`;
    if (seen.has(key)) {
      // Cảnh báo chứ không phải lỗi: hai người trùng STK + số tiền là bất thường
      // (thường là nhập sai) nhưng vẫn có thể hợp lệ (ví dụ cùng một người nhận
      // hai khoản bằng nhau).
      warnings.push(`${where}: trùng STK + số tiền với dòng trước — kiểm tra trùng lặp`);
    }
    seen.add(key);
    total += amt;
  });

  return { ok: errors.length === 0, errors, warnings, totalAmount: total, rowCount: info.rows.length };
}

// ---------------------------------------------------------------------------
// CHUẨN HOÁ CHUỖI
// ---------------------------------------------------------------------------

const VN_MAP: Record<string, string> = {
  à: 'a', á: 'a', ả: 'a', ã: 'a', ạ: 'a', ă: 'a', ằ: 'a', ắ: 'a', ẳ: 'a', ẵ: 'a', ặ: 'a',
  â: 'a', ầ: 'a', ấ: 'a', ẩ: 'a', ẫ: 'a', ậ: 'a',
  đ: 'd',
  è: 'e', é: 'e', ẻ: 'e', ẽ: 'e', ẹ: 'e', ê: 'e', ề: 'e', ế: 'e', ể: 'e', ễ: 'e', ệ: 'e',
  ì: 'i', í: 'i', ỉ: 'i', ĩ: 'i', ị: 'i',
  ò: 'o', ó: 'o', ỏ: 'o', õ: 'o', ọ: 'o', ô: 'o', ồ: 'o', ố: 'o', ổ: 'o', ỗ: 'o', ộ: 'o',
  ơ: 'o', ờ: 'o', ớ: 'o', ở: 'o', ỡ: 'o', ợ: 'o',
  ù: 'u', ú: 'u', ủ: 'u', ũ: 'u', ụ: 'u', ư: 'u', ừ: 'u', ứ: 'u', ử: 'u', ữ: 'u', ự: 'u',
  ỳ: 'y', ý: 'y', ỷ: 'y', ỹ: 'y', ỵ: 'y',
};

/**
 * Bỏ dấu tiếng Việt và viết hoa — nhiều core banking chỉ nhận ASCII.
 *
 * GIỮ LẠI khoảng trắng, '/', '-', '.'. Bản đầu tiên bỏ MỌI ký hiệu, và hệ quả là
 * nội dung chuyển khoản "LUONG T09/2026 NV001" ra thành "LUONG T092026 NV001" —
 * vẫn hợp lệ, ngân hàng vẫn nhận, nhưng đó là dòng người lao động dùng để nhận
 * ra lương của mình trên sao kê. Làm sạch quá tay cũng là một loại lỗi.
 *
 * Vẫn bỏ dấu phẩy (phá cấu trúc cột CSV) và dấu nháy.
 */
export function removeVietnameseTones(input: string): string {
  return input
    .toLowerCase()
    .split('')
    .map((ch) => VN_MAP[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9\s/\-.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function padEnd(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}
function padStart(s: string, len: number, ch = '0'): string {
  return s.length >= len ? s.slice(-len) : ch.repeat(len - s.length) + s;
}
function ymd(d: string): string {
  return d.replace(/-/g, '');
}
function escapeCsv(v: string, delimiter: string): string {
  const needsQuote = v.includes(delimiter) || v.includes('"') || v.includes('\n');
  return needsQuote ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Thay biến trong mẫu nội dung chuyển khoản.
 *
 * NÉM LỖI khi gặp biến lạ thay vì bỏ qua. Một biến gõ sai ({EMPLOYE_CODE}) nếu
 * bỏ qua sẽ ra nguyên chuỗi đó trong nội dung chuyển khoản của 500 người, ngân
 * hàng vẫn nhận, và chỉ phát hiện được lúc đối chiếu.
 */
export function renderDescription(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{([A-Z_]+)\}/g, (whole, name: string) => {
    const v = vars[name];
    if (v === undefined) {
      throw new PaymentFileError(
        'INVALID_PAYMENT_DATA',
        `Mẫu nội dung dùng biến {${name}} nhưng không có giá trị. ` +
          `Các biến có sẵn: ${Object.keys(vars).join(', ')}`,
      );
    }
    return String(v);
  });
}

// ---------------------------------------------------------------------------
// SINH FILE
// ---------------------------------------------------------------------------

export interface GeneratedPaymentFile {
  fileName: string;
  content: string;
  format: 'csv' | 'txt';
  rowCount: number;
  totalAmount: number;
  /** SHA-256 của nội dung (đã gồm BOM nếu có) — lưu cùng lô để đối chiếu. */
  checksum: string;
  byteLength: number;
  validation: ValidationResult;
}

export function generatePaymentFile(info: PaymentFileInfo): GeneratedPaymentFile {
  const validation = validatePaymentFile(info);
  if (!validation.ok) {
    throw new PaymentFileError('INVALID_PAYMENT_DATA', validation.errors.join(' | '));
  }
  const totalAmount = validation.totalAmount;

  const content =
    info.bank === 'VCB'
      ? generateVcb(info, totalAmount)
      : generateGenericCsv(info, totalAmount);

  // BOM phải nằm TRONG nội dung được băm: checksum của file trên đĩa và checksum
  // lưu trong database phải là của cùng một dãy byte, kể cả ba byte BOM đầu tiên.
  const bom = info.withBom && info.format === 'csv' ? '\uFEFF' : '';
  const finalContent = bom + content;

  // --- Kiểm tra chéo: tổng ở footer phải bằng tổng các dòng ------------------
  // Hai chỗ cùng tính tổng mà lệch nhau thì có bug ở một trong hai. Gửi đi một
  // lô mà footer sai thì ngân hàng từ chối, và 500 người không nhận được lương.
  const footerTotal = extractFooterTotal(info.bank, content);
  if (footerTotal !== totalAmount) {
    throw new PaymentFileError(
      'TOTAL_MISMATCH',
      `Tổng ở footer (${footerTotal}) khác tổng các dòng (${totalAmount}) — không gửi file này`,
    );
  }

  return {
    fileName: `UNC_${info.bank}_${info.purpose}_${ymd(info.date)}_${info.batchNo}.${info.format}`,
    content: finalContent,
    format: info.format,
    rowCount: info.rows.length,
    totalAmount,
    checksum: createHash('sha256').update(finalContent, 'utf8').digest('hex'),
    byteLength: Buffer.byteLength(finalContent, 'utf8'),
    validation,
  };
}

/** Đọc lại tổng từ dòng footer của nội dung đã sinh — dùng cho kiểm tra chéo. */
function extractFooterTotal(bank: BankCode, content: string): number {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== '');
  const last = lines[lines.length - 1] ?? '';
  if (bank === 'VCB') {
    // Z|<count>|<total>
    const parts = last.split('|');
    return Number(parts[2] ?? '0');
  }
  // CSV: dòng cuối dạng "# TONG,<count>,<total>"
  const m = last.match(/# TONG[^0-9]*(\d+)[,;\t](\d+)/);
  return m ? Number(m[2]) : 0;
}

/**
 * Mẫu Vietcombank — cột cố định, phân cách '|', ASCII không dấu, CRLF.
 *
 *   HEADER : A|<batch>|<payerAcc>|<payerName>|<yyyymmdd>|<purpose>|<count>|<total>
 *   DETAIL : D|<seq>|<benefAcc>|<benefName>|<amount>|<description>
 *   FOOTER : Z|<count>|<total>
 */
function generateVcb(info: PaymentFileInfo, total: number): string {
  const lines: string[] = [];
  lines.push(
    [
      'A',
      info.batchNo,
      info.payer.accountNumber,
      padEnd(removeVietnameseTones(info.payer.name), 60).trim(),
      ymd(info.date),
      info.purpose,
      padStart(String(info.rows.length), 5),
      padStart(String(total), 15),
    ].join('|'),
  );
  info.rows.forEach((r, i) => {
    lines.push(
      [
        'D',
        padStart(String(i + 1), 5),
        r.accountNumber,
        padEnd(removeVietnameseTones(r.beneficiaryName), 60).trim(),
        padStart(String(roundVnd(r.amount)), 15),
        padEnd(removeVietnameseTones(r.description), 80).trim(),
      ].join('|'),
    );
  });
  lines.push(['Z', padStart(String(info.rows.length), 5), padStart(String(total), 15)].join('|'));
  // CRLF: hầu hết core banking đọc file theo dòng kiểu Windows.
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Mẫu CSV tổng quát cho TCB / CTG / MBB và để đối chiếu nội bộ.
 *
 * Số tài khoản được bọc trong dấu "=" để Excel không tự cắt số 0 đầu và không
 * chuyển STK dài thành ký hiệu khoa học (1.0011E+12) — lỗi này làm hỏng cả lô
 * mà nhìn trên màn hình vẫn thấy "có vẻ đúng".
 */
function generateGenericCsv(info: PaymentFileInfo, total: number): string {
  const d = info.delimiter ?? ',';
  const lines: string[] = [];
  const cell = (v: string) => escapeCsv(v, d);
  /** Bọc STK để Excel không phá. */
  const acct = (v: string) => cell(`="${v}"`);

  lines.push(`# ${info.bank === 'GENERIC' ? 'PHIEU THANH TOAN LUONG' : `UNC ${info.bank}`}`);
  lines.push(`# So hieu lo${d}${cell(info.batchNo)}`);
  lines.push(`# Ngay lap${d}${cell(info.date)}`);
  lines.push(`# Ky luong${d}${cell(info.periodLabel)}`);
  lines.push(`# Don vi tra${d}${cell(removeVietnameseTones(info.payer.name))}`);
  lines.push(`# STK trich no${d}${acct(info.payer.accountNumber)}`);
  lines.push(`# Ngan hang${d}${cell(info.payer.bankCode)}`);
  if (info.payer.taxCode) lines.push(`# Ma so thue${d}${cell(info.payer.taxCode)}`);
  lines.push('');
  lines.push(
    [
      'So thu tu',
      'Ma nhan vien',
      'Ho ten',
      'So tai khoan',
      'Ten chu tai khoan',
      'Ngan hang thu huong',
      'Chi nhanh',
      'So tien (VND)',
      'Noi dung',
    ]
      .map(cell)
      .join(d),
  );

  info.rows.forEach((r, i) => {
    lines.push(
      [
        String(i + 1),
        cell(r.employeeCode),
        cell(removeVietnameseTones(r.fullName)),
        acct(r.accountNumber),
        cell(removeVietnameseTones(r.beneficiaryName)),
        cell(r.beneficiaryBankCode ?? ''),
        cell(removeVietnameseTones(r.beneficiaryBranch ?? '')),
        String(roundVnd(r.amount)),
        cell(removeVietnameseTones(r.description)),
      ].join(d),
    );
  });

  lines.push('');
  lines.push(`# TONG${d}${String(info.rows.length)}${d}${String(total)}`);
  return `${lines.join('\r\n')}\r\n`;
}
