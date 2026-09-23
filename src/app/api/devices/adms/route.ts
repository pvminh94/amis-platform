/**
 * POST /api/devices/adms — nhận quẹt thẻ từ máy Ronald Jack / ZKTeco (ADMS Push)
 *
 * Ở chế độ ADMS máy CHỦ ĐỘNG gửi HTTP POST tới server, và server trả về "lệnh"
 * trong body để điều khiển máy. Ba endpoint máy gọi:
 *
 *   ?sn=<serial>&options=CMD=DATA   → đăng ký / heartbeat
 *   body ATTLOG tab-phân-tách        → đẩy log quẹt
 *
 * KHÔNG dùng JWT: máy chấm công không giữ được token. Thay vào đó mỗi máy một
 * khoá chia sẻ, so bằng phép so thời gian không đổi — xem `authenticateDevice`.
 *
 * Response body là lệnh cho máy, KHÔNG phải JSON. Trả JSON ở đây thì máy không
 * hiểu và sẽ retry vô hạn.
 */

import { NextResponse } from 'next/server';

import { getDb } from '@/db/client';
import { DeviceIngestError, authenticateDevice, ingestPunches, mapWorkCodeToSource } from '@/lib/device-ingest';
import { buildAdmsResponse, parseAdmsAttendanceBody, parseAdmsRegistration } from '@/engine/adms';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const url = new URL(req.url);
  const key = req.headers.get('x-device-key') ?? url.searchParams.get('key');

  let device;
  try {
    device = await authenticateDevice(getDb(), url.searchParams.get('sn') ?? '', key);
  } catch (e) {
    if (e instanceof DeviceIngestError) {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: 401 });
    }
    throw e;
  }

  const body = await req.text();
  const { records, skipped } = parseAdmsAttendanceBody(body);

  const result = await ingestPunches(
    getDb(),
    device.serial,
    records.map((r) => ({
      deviceUserId: r.deviceUserId,
      punchedAt: r.punchAt,
      verifyMethod: mapWorkCodeToSource(r.workCode),
      rawLine: r.rawLine,
    })),
    { source: 'ADMS' },
  );

  // 200 với body RỖNG = "đã nhận, không có lệnh gì". Trả 4xx/5xx khi có dòng bị
  // bỏ qua sẽ khiến máy gửi lại toàn bộ log mãi mãi — và những dòng đó hỏng thật,
  // gửi lại bao nhiêu lần cũng vẫn hỏng.
  return new NextResponse(buildAdmsResponse([]), {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // Header dành cho người vận hành, máy bỏ qua. Đây là cách duy nhất để thấy
      // số dòng bị bỏ qua mà không cần đọc log server.
      'x-amis-received': String(result.received),
      'x-amis-inserted': String(result.inserted),
      'x-amis-duplicates': String(result.duplicates),
      'x-amis-skipped': String(skipped.length),
      'x-amis-unmatched': String(result.unmatched.reduce((a, u) => a + u.count, 0)),
    },
  });
}
