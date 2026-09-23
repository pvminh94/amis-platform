/**
 * GET /api/payment-batches/[id]/download — tải nội dung file đã lưu.
 *
 * Trả NỘI DUNG ĐÃ LƯU, không sinh lại. Kiểm tra SHA-256 trước khi trả: nếu không
 * khớp thì từ chối và trả 500. Một file chi tiền mà không tự chứng minh được nó
 * đúng bằng nội dung đã ghi lúc xuất thì tốt hơn hết là không đưa ra — gửi nhầm
 * một lệnh chuyển tiền đắt hơn nhiều so với một màn hình báo lỗi.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { bankPaymentBatches } from '@/db/schema';
import { verifyBatchChecksum } from '@/lib/payment';
import { authErrorResponse, requirePermission } from '@/lib/rbac';
import { isUuid } from '@/lib/uuid';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let _principal;
  try {
    _principal = await requirePermission(req, 'payment:read');
  } catch (e) {
    return authErrorResponse(e);
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return NextResponse.json(
      { error: { code: 'INVALID_ID', message: 'Mã lô không hợp lệ' } },
      { status: 400 },
    );
  }

  const db = getDb();
  const [b] = await db
    .select({
      fileName: bankPaymentBatches.fileName,
      content: bankPaymentBatches.content,
      checksum: bankPaymentBatches.checksum,
      byteLength: bankPaymentBatches.byteLength,
      status: bankPaymentBatches.status,
    })
    .from(bankPaymentBatches)
    .where(eq(bankPaymentBatches.id, id))
    .limit(1);

  if (!b) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Không tìm thấy lô thanh toán' } },
      { status: 404 },
    );
  }

  // Lô sinh ra trước khi hệ thống lưu nội dung: rỗng, không tái tạo được.
  // Báo rõ thay vì trả một file trống mà người dùng tưởng là "không có ai".
  if (b.content === '') {
    return NextResponse.json(
      {
        error: {
          code: 'CONTENT_NOT_STORED',
          message:
            'Lô này được lập trước khi hệ thống lưu nội dung file, không tải lại được. Hãy huỷ và xuất lô mới.',
        },
      },
      { status: 409 },
    );
  }

  const v = await verifyBatchChecksum(db, id, b.content);
  if (!v.ok) {
    return NextResponse.json(
      {
        error: {
          code: 'CHECKSUM_MISMATCH',
          message: `Nội dung lưu trữ không khớp SHA-256 đã ghi (${v.expected.slice(0, 12)}… ≠ ${v.actual.slice(0, 12)}…). Từ chối trả file.`,
        },
      },
      { status: 500 },
    );
  }

  // Tên file ASCII thuần — header HTTP không mang được dấu tiếng Việt, và tên lô
  // vốn đã được sinh ra không dấu từ đầu.
  return new Response(b.content, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(b.byteLength),
      'content-disposition': `attachment; filename="${b.fileName}"`,
      'cache-control': 'no-store',
      'x-batch-status': b.status,
      'x-batch-checksum': b.checksum,
    },
  });
}
