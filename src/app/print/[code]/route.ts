/**
 * ============================================================================
 * /print/[code] — trả về MỘT TÀI LIỆU HTML in được
 * ============================================================================
 *
 * Đây là route handler chứ không phải page: một tài liệu in phải là HTML gốc
 * với đúng một cặp <html>, không lồng trong layout của app. Mở link này trong
 * tab mới rồi Ctrl/Cmd + P là ra PDF.
 *
 * Lỗi được trả về dưới dạng trang HTML đọc được, không phải JSON — vì người
 * mở link này là kế toán, không phải lập trình viên.
 */

import {
  buildPayslipPrintData,
  loadPayslipPrintData,
  SAMPLE_PAYSLIP,
  type PayslipInput,
} from '@/lib/payslip';
import { renderTemplate, renderDocument, escapeHtml } from '@/engine/print';
import type { WageRegion } from '@/engine/si';

export const dynamic = 'force-dynamic';

/** Đọc tham số truy vấn để ghi đè dữ liệu mẫu — tiện cho việc thử mẫu. */
function readInput(url: URL): PayslipInput {
  const num = (key: string, fallback: number) => {
    const raw = url.searchParams.get(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const str = (key: string, fallback: string) => url.searchParams.get(key) ?? fallback;
  const region = str('region', SAMPLE_PAYSLIP.wageRegion) as WageRegion;

  return {
    ...SAMPLE_PAYSLIP,
    employeeName: str('ten', SAMPLE_PAYSLIP.employeeName),
    department: str('boPhan', SAMPLE_PAYSLIP.department),
    periodEnd: str('ky', SAMPLE_PAYSLIP.periodEnd),
    wageRegion: (['I', 'II', 'III', 'IV'].includes(region) ? region : 'I') as WageRegion,
    dependents: num('phuThuoc', SAMPLE_PAYSLIP.dependents),
    variables: {
      ...SAMPLE_PAYSLIP.variables,
      baseSalary: num('luong', SAMPLE_PAYSLIP.variables.baseSalary!),
      workedDays: num('ngayCong', SAMPLE_PAYSLIP.variables.workedDays!),
      standardDays: num('ngayChuan', SAMPLE_PAYSLIP.variables.standardDays!),
      kpiScore: num('kpi', SAMPLE_PAYSLIP.variables.kpiScore!),
    },
  };
}

function errorPage(title: string, message: string): Response {
  const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#111}
h1{font-size:18px}pre{background:#f6f6f6;padding:14px;border-radius:6px;white-space:pre-wrap;font-size:13px}
code{background:#f0f0f0;padding:1px 4px;border-radius:3px}</style></head>
<body><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(message)}</pre>
<p>Kiểm tra lại tham số, hoặc mở <a href="/">trang chủ</a> để xem các loại chính sách đã có.</p>
</body></html>`;
  return new Response(html, {
    status: 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const url = new URL(req.url);

  try {
    // Có ?payslip=<id> thì in PHIẾU THẬT từ số liệu đã lưu trong database,
    // engine không chạy lại. Không có thì render bản demo từ tham số truy vấn.
    const payslipId = url.searchParams.get('payslip');
    const { template, templateVersion, data, numericInputs, applied } = payslipId
      ? await loadPayslipPrintData(payslipId, code)
      : await buildPayslipPrintData(readInput(url), code);

    const content = renderTemplate(template.body, data, {
      fields: template.fields,
      numericInputs,
    });

    // Ghi chú kỹ thuật để dưới dạng comment HTML: không hiện trên bản in,
    // nhưng ai xem nguồn sẽ biết phiếu này dùng phiên bản chính sách nào.
    const provenance =
      `\n<!-- Sinh bởi AMIS Platform · ${new Date().toISOString()}\n` +
      `     công thức lương : ${applied.salary}\n` +
      `     bảo hiểm        : ${applied.si}\n` +
      `     thuế TNCN       : ${applied.pit}\n` +
      `     mẫu in          : ${template.regimeCode} v${templateVersion} -->\n`;

    const html =
      renderDocument({
        title: template.regimeLabel,
        paperSize: template.paperSize,
        orientation: template.orientation,
        marginMm: template.marginMm,
        css: template.css,
        content,
      }) + provenance;

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return errorPage(`Không in được '${code}'`, message);
  }
}
