/**
 * POST /api/devices/hikvision — nhận event alert từ máy Hikvision (ISAPI)
 *
 * Máy được cấu hình bằng HTTP Listening (xem `buildHttpListeningXml`) để bắn sự
 * kiện AccessControllerEvent về đây, dạng JSON thuần hoặc multipart/mixed kèm
 * ảnh khuôn mặt.
 *
 * MÃ TRẠNG THÁI LÀ PHẦN QUAN TRỌNG NHẤT của route này:
 *
 *   200 = đã nhận, máy xoá sự kiện khỏi hàng đợi
 *   400 = body hỏng, máy KHÔNG nên gửi lại (gửi lại bao nhiêu lần cũng vẫn hỏng)
 *   401 = khoá sai
 *   5xx = máy RETRY. Trả 500 cho một body thiếu trường nghĩa là máy bắn lại sự
 *         kiện đó mãi mãi — đúng cái bẫy mà `parseHikvisionEvent` đã được sửa để
 *         tránh (nó trả null thay vì ném).
 */

import { NextResponse } from 'next/server';

import { getDb } from '@/db/client';
import { DeviceIngestError, authenticateDevice, ingestPunches } from '@/lib/device-ingest';
import { parseHikvisionEvent } from '@/engine/hikvision';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const url = new URL(req.url);
  const key = req.headers.get('x-device-key') ?? url.searchParams.get('key');
  const serial = url.searchParams.get('sn') ?? '';

  try {
    await authenticateDevice(getDb(), serial, key);
  } catch (e) {
    if (e instanceof DeviceIngestError) {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: 401 });
    }
    throw e;
  }

  const buf = Buffer.from(await req.arrayBuffer());
  const contentType = req.headers.get('content-type') ?? 'application/json';

  const punch = parseHikvisionEvent(buf, contentType);
  if (!punch) {
    // 400 chứ không phải 500 — xem giải thích ở đầu file.
    return NextResponse.json(
      { error: { code: 'NOT_AN_EVENT', message: 'Body không phải sự kiện ISAPI hợp lệ' } },
      { status: 400 },
    );
  }

  // Máy TỪ CHỐI người này (sai khuôn mặt, thẻ hết hạn, không qua anti-spoofing).
  // Vẫn ghi nhận để có dấu vết, nhưng KHÔNG tính là một lần chấm công.
  if (!punch.accepted) {
    await ingestPunches(getDb(), serial, [], {
      source: 'DEVICE',
      rejectedByDevice: 1,
    });
    return NextResponse.json({ received: true, accepted: false, reason: punch.rejectReason });
  }

  const result = await ingestPunches(
    getDb(),
    serial,
    [{ deviceUserId: punch.deviceUserId, punchedAt: punch.punchAt, verifyMethod: 'FACE' }],
    { source: 'DEVICE' },
  );

  return NextResponse.json({
    received: true,
    accepted: true,
    inserted: result.inserted,
    duplicates: result.duplicates,
    // Nêu rõ số thẻ không khớp ai — đây là thông tin người vận hành cần ngay khi
    // máy vừa được nạp lại khuôn mặt với dãy số mới.
    unmatched: result.unmatched,
  });
}
