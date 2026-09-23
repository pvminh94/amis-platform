/**
 * ============================================================================
 * SEED — GEOFENCE (kind 12) + LIVENESS (kind 13)
 * ============================================================================
 *
 * Chạy: npm run seed:geofence
 *
 * Hai loại này KHÔNG phụ thuộc dữ liệu nghiệp vụ nào nên nằm trong `seed:policies`,
 * chạy được ngay trên DB trắng.
 *
 * ⚠️ BSSID và toạ độ dưới đây là SỐ MẪU. Toạ độ là thật (Quận 1 và VSIP Bình
 * Dương) để khoảng cách tính ra có nghĩa khi đối chiếu bằng tay, nhưng BSSID
 * thì phải thay bằng access point thật — và phải kiểm bằng chính app mobile vì
 * iOS và Android trả về BSSID theo hai định dạng phân cách khác nhau.
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { ensureKind, createVersion, activateVersion, resolvePolicy } = await import(
  '../src/policy/registry.js'
);
const { geofenceParamsSchema, geofenceJsonSchema, SEED_GEOFENCES_VN } = await import(
  '../src/policy/geofence-params.js'
);
const { livenessParamsSchema, livenessJsonSchema, SEED_LIVENESS_VN } = await import(
  '../src/policy/liveness-params.js'
);
const { fenceFromParams, configFromParams, livenessConfigFromParams } = await import(
  '../src/lib/location.js'
);
const { validateGpsPunch, haversineDistanceM } = await import('../src/engine/geofence.js');
const { sql } = await import('drizzle-orm');

const db = getDb();
const fmt = (n: number) => n.toLocaleString('vi-VN');

console.log('\n' + '═'.repeat(78));
console.log('  SEED GEOFENCE + LIVENESS — hai loại chính sách mới, không cần viết form');
console.log('═'.repeat(78) + '\n');

// --- [1] GEOFENCE -----------------------------------------------------------
await db.execute(sql`DELETE FROM policy_audit_logs WHERE kind_code = 'GEOFENCE'`);
await db.execute(sql`DELETE FROM policy_versions WHERE kind_code = 'GEOFENCE'`);
await ensureKind(
  {
    code: 'GEOFENCE',
    nameVi: 'Vùng chấm công hợp lệ (geofence)',
    nameEn: 'Geofence',
    description:
      'Tâm + bán kính hoặc polygon khuôn viên, BSSID WiFi cho phép, và các ngưỡng ' +
      'chấp nhận một lần chấm công từ điện thoại.',
    paramsSchema: geofenceJsonSchema,
    // Mỗi ĐỊA ĐIỂM một hàng rào đang hiệu lực; nhiều địa điểm cùng tồn tại.
    exclusiveByCode: true,
  },
  db,
);
console.log(`[1] ✓ Đã đăng ký 'GEOFENCE' kèm JSON Schema ${JSON.stringify(geofenceJsonSchema).length} byte`);

for (const seed of SEED_GEOFENCES_VN) {
  // Dùng thẳng `versionId` mà createVersion trả về.
  //
  // Bản đầu tiên tra cứu lại bằng (kindCode, version) như seed:bhxh làm. Cách đó
  // ĐÚNG với loại độc-quyền-theo-loại, nhưng SAI với exclusiveByCode: số version
  // được đánh riêng cho từng MÃ, nên SITE_HQ và SITE_BINH_DUONG đều là v1. Lọc
  // theo (kind, version) bắt được cả hai dòng, `.limit(1)` lấy đại dòng đầu —
  // vốn đã ACTIVE — và nổ ALREADY_ACTIVE ở địa điểm thứ hai.
  const { versionId, version } = await createVersion(
    {
      kindCode: 'GEOFENCE',
      effectiveFrom: '2026-01-01',
      createdBy: 'seed',
      legalBasis: 'Nội quy công ty — vùng chấm công hợp lệ',
    },
    seed,
    geofenceParamsSchema,
    db,
  );
  await activateVersion(versionId, { id: 'seed' }, db);
  const shape = seed.polygon ? `polygon ${seed.polygon.length} đỉnh` : `bán kính ${seed.hardRadiusM} m`;
  console.log(`    ✓ v${version}  ${seed.regimeCode.padEnd(16)} ${shape}`);
}

// --- [2] LIVENESS -----------------------------------------------------------
await db.execute(sql`DELETE FROM policy_audit_logs WHERE kind_code = 'LIVENESS'`);
await db.execute(sql`DELETE FROM policy_versions WHERE kind_code = 'LIVENESS'`);
await ensureKind(
  {
    code: 'LIVENESS',
    nameVi: 'Ngưỡng chống giả mạo khuôn mặt',
    nameEn: 'Face liveness thresholds',
    description:
      'Ngưỡng phát hiện ảnh in 2D, phát lại trên màn hình (Moiré), và các tín hiệu ' +
      'hành vi (chớp mắt, chuyển động đầu, độ sâu).',
    paramsSchema: livenessJsonSchema,
    // Chỉ MỘT bộ ngưỡng hiệu lực tại một thời điểm, như biểu thuế.
    exclusiveByCode: false,
  },
  db,
);
console.log(`[2] ✓ Đã đăng ký 'LIVENESS' kèm JSON Schema ${JSON.stringify(livenessJsonSchema).length} byte`);

for (const seed of SEED_LIVENESS_VN) {
  const { versionId, version } = await createVersion(
    { kindCode: 'LIVENESS', effectiveFrom: '2026-01-01', createdBy: 'seed' },
    seed,
    livenessParamsSchema,
    db,
  );
  await activateVersion(versionId, { id: 'seed' }, db);
  const total =
    seed.weightSpectral + seed.weightMoire + seed.weightBlink +
    seed.weightMotion + seed.weightDepth + seed.weightSimilarity;
  console.log(
    `    ✓ v${version}  ${seed.regimeCode.padEnd(16)} ngưỡng ${seed.minConfidence}, ` +
      `tổng trọng số ${total.toFixed(2)}`,
  );
}

// --- [3] Resolve và chấm thử vài vị trí ------------------------------------
console.log('\n[3] Chấm thử quanh trụ sở — đọc tham số TỪ DATABASE, không từ seed');
const hq = await resolvePolicy('GEOFENCE', '2026-09-15', geofenceParamsSchema, db, 'SITE_HQ');
const fence = fenceFromParams(hq.params);
const cfg = configFromParams(hq.params);
const center = { lat: hq.params.centerLat!, lng: hq.params.centerLng! };
console.log(
  `    ${hq.params.regimeLabel} (v${hq.version}) — tâm ${center.lat},${center.lng}, ` +
    `cứng ${hq.params.hardRadiusM} m, mềm ${hq.params.softRadiusM} m\n`,
);

// Mỗi trường hợp là MỘT NHÁNH của engine. Nếu chỉ thử "đứng đúng giữa văn phòng"
// thì bốn nhánh còn lại không bao giờ được chạy.
const CASES: { label: string; metres: number; accuracy?: number; mock?: boolean }[] = [
  { label: 'Đứng ở sảnh (30 m)', metres: 30 },
  { label: 'Bãi xe đối diện (150 m)', metres: 150 },
  { label: 'Quán cà phê cuối đường (500 m)', metres: 500 },
  { label: 'GPS mờ 150 m, đứng gần (40 m)', metres: 40, accuracy: 150 },
  { label: 'Mock location, đứng gần (20 m)', metres: 20, mock: true },
];

for (const c of CASES) {
  const lat = center.lat + c.metres / 111_320;
  const v = validateGpsPunch(
    {
      lat,
      lng: center.lng,
      accuracyM: c.accuracy ?? 15,
      bssid: hq.params.allowedBssids[0] ?? null,
      isMockLocation: c.mock ?? false,
    },
    fence,
    cfg,
  );
  const verdict = !v.ok ? 'REJECTED' : v.trusted ? 'TRUSTED' : 'REVIEW';
  console.log(
    `    ${verdict.padEnd(9)} ${c.label.padEnd(38)} cách ${String(v.distanceM ?? '-').padStart(4)} m` +
      (v.reasons.length ? `  ← ${v.reasons.join(', ')}` : ''),
  );
}

// --- [4] Liveness: ảnh thật vs ảnh in --------------------------------------
console.log('\n[4] Liveness — ảnh tổng hợp, chạy FFT thật');
const { detectLiveness, synthTestImage } = await import('../src/engine/liveness.js');
const lp = await resolvePolicy('LIVENESS', '2026-09-15', livenessParamsSchema, db);
const lcfg = livenessConfigFromParams(lp.params);

const natural = synthTestImage('natural', 64, 64);
const printed = synthTestImage('print', 64, 64);
// 'screen' KHÔNG phải một chế độ của synthTestImage — bốn chế độ thật là
// 'flat' | 'natural' | 'moire' | 'print'. 'moire' là vân giao thoa của màn hình.
const replay = synthTestImage('moire', 64, 64);
for (const [label, img, extra] of [
  ['Người thật (có chớp mắt, chuyển động)', natural, { blinkCount: 2, headMotionDeg: 3, meanDepthMm: 40, hasDepthSignal: true, similarity: 0.8 }],
  ['Ảnh in ra giấy', printed, { blinkCount: 0, headMotionDeg: 0, meanDepthMm: 0, similarity: 0.8 }],
  ['Phát lại trên màn hình', replay, { blinkCount: 0, headMotionDeg: 0.2, meanDepthMm: 1, similarity: 0.8 }],
] as const) {
  const r = detectLiveness({ gray: img, width: 64, height: 64, ...extra }, lcfg);
  console.log(
    `    ${r.isLive ? 'NGƯỜI THẬT' : 'TỪ CHỐI '} ${label.padEnd(40)} điểm ${r.confidence.toFixed(3)}` +
      (r.suspectedAttack ? `  ← nghi ${r.suspectedAttack}` : ''),
  );
}

console.log(
  `\n  Đối chiếu khoảng cách: 30 m tính bằng haversine = ` +
    `${Math.round(haversineDistanceM(center, { lat: center.lat + 30 / 111_320, lng: center.lng }))} m\n`,
);

console.log('═'.repeat(78));
console.log('  Thêm một địa điểm mới = thêm một phiên bản GEOFENCE trên giao diện.');
console.log('  Không sửa code, không deploy lại, không viết form.');
console.log('═'.repeat(78) + '\n');

void fmt;
await closeDb();
