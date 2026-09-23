/**
 * ============================================================================
 * TEST THAM SỐ GEOFENCE + LIVENESS (policy kind thứ 12 và 13)
 * ============================================================================
 *
 * Trọng tâm không phải "schema có validate được không" mà là những ràng buộc
 * mà nếu thiếu thì HỆ THỐNG VẪN CHẠY VÀ VẪN SAI:
 *
 *   - hàng rào rỗng (không tâm, không polygon) → engine chấp nhận MỌI vị trí
 *   - tổng trọng số ≠ 1 → điểm liveness không so được với ngưỡng, chặn oan
 *     người thật hoặc lọt ảnh in
 *   - bán kính mềm > cứng → mọi người đều bị chuyển HR rà soát
 *
 * Và `expectSchemasAgree`: mỗi loại có HAI bản mô tả (JSON Schema cho form,
 * Zod cho backend). Lệch một trường là form cho lưu thiếu một tham số.
 */

import { describe, expect, it } from 'vitest';

import { expectSchemasAgree } from './helpers';
import {
  geofenceParamsSchema,
  geofenceJsonSchema,
  SEED_GEOFENCES_VN,
} from '@/policy/geofence-params';
import {
  livenessParamsSchema,
  livenessJsonSchema,
  SEED_LIVENESS_VN,
} from '@/policy/liveness-params';
import {
  configFromParams,
  fenceFromParams,
  gpsFixFromPunch,
  livenessConfigFromParams,
} from '@/lib/location';
import { validateGpsPunch } from '@/engine/geofence';
import { DEFAULT_LIVENESS_CONFIG } from '@/engine/liveness';

const HQ = SEED_GEOFENCES_VN[0]!;
const STD = SEED_LIVENESS_VN[0]!;

describe('JSON Schema và Zod phải cùng tập trường', () => {
  it('GEOFENCE', () => {
    const { jsonFields } = expectSchemasAgree(geofenceJsonSchema, geofenceParamsSchema);
    expect(jsonFields).toContain('regimeCode');
    expect(jsonFields).toContain('allowedBssids');
  });

  it('LIVENESS', () => {
    const { jsonFields } = expectSchemasAgree(livenessJsonSchema, livenessParamsSchema);
    expect(jsonFields).toContain('minConfidence');
    expect(jsonFields).toContain('weightSpectral');
  });
});

describe('GEOFENCE — ràng buộc nghiệp vụ', () => {
  it('seed hợp lệ', () => {
    for (const s of SEED_GEOFENCES_VN) {
      const r = geofenceParamsSchema.safeParse(s);
      expect(r.success, JSON.stringify(r.success ? '' : r.error.flatten())).toBe(true);
    }
  });

  it('HÀNG RÀO RỖNG bị từ chối — không tâm, không polygon', () => {
    // Đây là ràng buộc quan trọng nhất của file này. Thiếu nó thì lưu được một
    // hàng rào rỗng, và engine gặp hàng rào rỗng sẽ CHẤP NHẬN MỌI VỊ TRÍ kèm
    // một câu cảnh báo — tức là "ai chấm ở đâu cũng được", âm thầm.
    const r = geofenceParamsSchema.safeParse({ ...HQ, centerLat: null, centerLng: null });
    expect(r.success).toBe(false);
  });

  it('có polygon thì không cần tâm', () => {
    const r = geofenceParamsSchema.safeParse({ ...HQ, centerLat: null, centerLng: null });
    expect(r.success).toBe(false);
    const withPoly = geofenceParamsSchema.safeParse({
      ...HQ,
      centerLat: null,
      centerLng: null,
      polygon: [
        { lat: 1, lng: 1 },
        { lat: 1, lng: 2 },
        { lat: 2, lng: 2 },
      ],
    });
    expect(withPoly.success).toBe(true);
  });

  it('polygon dưới 3 đỉnh bị từ chối', () => {
    const r = geofenceParamsSchema.safeParse({
      ...HQ,
      polygon: [
        { lat: 1, lng: 1 },
        { lat: 1, lng: 2 },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('bán kính MỀM lớn hơn cứng bị từ chối', () => {
    // Nếu lọt qua thì mọi người trong vùng cứng vẫn bị coi là "ngoài vùng tin
    // cậy" và chuyển HR rà soát — một hàng đợi rà soát dài vô nghĩa.
    const r = geofenceParamsSchema.safeParse({ ...HQ, softRadiusM: HQ.hardRadiusM + 1 });
    expect(r.success).toBe(false);
  });

  it('BSSID sai định dạng bị từ chối NGAY LÚC LƯU', () => {
    // BSSID gõ sai trong cấu hình khiến mọi nhân viên ở đó bị đánh dấu "không
    // khớp WiFi" — và lỗi đó trông y hệt gian lận, nên không ai nghĩ tới việc
    // đi kiểm tra cấu hình.
    for (const bad of ['a4:5e:60:11:22', 'a4-5e-60-11-22-33-44', 'zz:5e:60:11:22:33', 'a4:5e:60:11:22:3g']) {
      expect(geofenceParamsSchema.safeParse({ ...HQ, allowedBssids: [bad] }).success).toBe(false);
    }
    // Cả hai dạng phân cách hợp lệ đều nhận — iOS và Android trả về khác nhau.
    for (const good of ['a4:5e:60:11:22:33', 'A4-5E-60-11-22-33']) {
      expect(geofenceParamsSchema.safeParse({ ...HQ, allowedBssids: [good] }).success).toBe(true);
    }
  });

  it('toạ độ ngoài phạm vi bị từ chối', () => {
    expect(geofenceParamsSchema.safeParse({ ...HQ, centerLat: 91 }).success).toBe(false);
    expect(geofenceParamsSchema.safeParse({ ...HQ, centerLng: -181 }).success).toBe(false);
  });

  it('regimeCode phải là CHỮ HOA + số + gạch dưới (registry dùng nó làm mã thực thể)', () => {
    expect(geofenceParamsSchema.safeParse({ ...HQ, regimeCode: 'site hq' }).success).toBe(false);
    expect(geofenceParamsSchema.safeParse({ ...HQ, regimeCode: 'SITE_HQ' }).success).toBe(true);
  });
});

describe('LIVENESS — ràng buộc nghiệp vụ', () => {
  it('seed hợp lệ', () => {
    for (const s of SEED_LIVENESS_VN) {
      const r = livenessParamsSchema.safeParse(s);
      expect(r.success, JSON.stringify(r.success ? '' : r.error.flatten())).toBe(true);
    }
  });

  it('TỔNG TRỌNG SỐ phải đúng bằng 1', () => {
    // Điểm tổng hợp là TỔNG CÓ TRỌNG SỐ, so với minConfidence trong 0..1.
    // Tổng 0,7 + ngưỡng 0,8 → KHÔNG AI qua được kể cả người thật.
    // Tổng 1,3 + ngưỡng 0,8 → ảnh in cũng có thể đạt 0,8.
    // Cả hai hướng đều sai và đều không có thông báo nào kêu lên.
    const under = livenessParamsSchema.safeParse({ ...STD, weightSpectral: STD.weightSpectral - 0.3 });
    expect(under.success).toBe(false);

    const over = livenessParamsSchema.safeParse({ ...STD, weightMoire: STD.weightMoire + 0.3 });
    expect(over.success).toBe(false);

    // Sai số dấu phẩy động nhỏ thì phải chấp nhận — 0.2+0.25+0.12+0.13+0.15+0.15
    expect(livenessParamsSchema.safeParse(STD).success).toBe(true);
  });

  it('dải tần Moiré phải có cận dưới < cận trên', () => {
    // Ngược dải thì không đỉnh nào "nằm trong dải", tức là Moiré không bao giờ
    // bị phát hiện — một cấu hình sai vô hiệu hoá cả cơ chế chống phát lại.
    expect(livenessParamsSchema.safeParse({ ...STD, moireFreqLow: 0.4, moireFreqHigh: 0.1 }).success).toBe(
      false,
    );
    expect(livenessParamsSchema.safeParse({ ...STD, moireFreqLow: 0.2, moireFreqHigh: 0.2 }).success).toBe(
      false,
    );
  });

  it('giá trị ngoài miền bị từ chối', () => {
    expect(livenessParamsSchema.safeParse({ ...STD, minConfidence: 1.5 }).success).toBe(false);
    expect(livenessParamsSchema.safeParse({ ...STD, minBlinks: -1 }).success).toBe(false);
    expect(livenessParamsSchema.safeParse({ ...STD, minBlinks: 2.5 }).success).toBe(false);
  });

  it('seed khớp DEFAULT_LIVENESS_CONFIG của engine — hai nguồn không được lệch', () => {
    // Engine có một bộ mặc định, DB có một bộ seed. Nếu chúng lệch thì kết quả
    // chạy test (dùng default) khác kết quả chạy thật (dùng DB) và không ai biết.
    expect(STD.minConfidence).toBe(DEFAULT_LIVENESS_CONFIG.minConfidence);
    expect(STD.moirePeakThreshold).toBe(DEFAULT_LIVENESS_CONFIG.moirePeakThreshold);
    expect(STD.minDetailSharpness).toBe(DEFAULT_LIVENESS_CONFIG.minDetailSharpness);
    expect(STD.minSimilarity).toBe(DEFAULT_LIVENESS_CONFIG.minSimilarity);
  });
});

describe('adapter params → engine', () => {
  it('fenceFromParams giữ đủ bốn trường của GeoFence', () => {
    const f = fenceFromParams(HQ);
    expect(f.center).toEqual({ lat: HQ.centerLat, lng: HQ.centerLng });
    expect(f.radiusM).toBe(HQ.hardRadiusM);
    expect(f.allowedBssids).toEqual(HQ.allowedBssids);

    // Polygon null phải thành undefined, không phải null — engine kiểm tra
    // `fence.polygon && fence.polygon.length >= 3`, null và undefined cùng falsy
    // nên ở đây không khác, nhưng để null lọt vào một chỗ khác kiểm tra
    // `!== undefined` thì sẽ sai.
    expect(f.polygon).toBeUndefined();
  });

  it('softRadiusM null → undefined, không phải 0', () => {
    const c = configFromParams({ ...HQ, softRadiusM: null });
    // 0 với undefined là hai ý khác nhau: 0 nghĩa là "vùng tin cậy rộng 0 mét"
    // tức là KHÔNG AI đáng tin, undefined nghĩa là "không dùng vùng mềm".
    expect(c.softRadiusM).toBeUndefined();
  });

  it('configFromParams + fenceFromParams cho ra kết quả engine dùng được', () => {
    const fence = fenceFromParams(HQ);
    const cfg = configFromParams(HQ);

    // Đứng ngay tại tâm → hợp lệ và đáng tin
    const at = validateGpsPunch({ lat: HQ.centerLat!, lng: HQ.centerLng!, accuracyM: 10 }, fence, cfg);
    expect(at.ok).toBe(true);
    expect(at.trusted).toBe(true);

    // Cách 5 km → chặn
    const far = validateGpsPunch({ lat: 10.82, lng: 106.75, accuracyM: 10 }, fence, cfg);
    expect(far.ok).toBe(false);
    expect(far.reasons).toContain('OUTSIDE_HARD_RADIUS');
  });

  it('livenessConfigFromParams ghép đúng mảng moireFreqBand và object weights', () => {
    const c = livenessConfigFromParams(STD);
    expect(c.moireFreqBand).toEqual([STD.moireFreqLow, STD.moireFreqHigh]);
    expect(c.weights.spectral).toBe(STD.weightSpectral);
    expect(c.weights.similarity).toBe(STD.weightSimilarity);
    // Tổng trọng số = 1, nếu không điểm không so được với minConfidence
    const total = Object.values(c.weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('gpsFixFromPunch: thiếu toạ độ → null, KHÔNG phải fix (0,0)', () => {
    // (0,0) là một điểm có thật ở vịnh Guinea. Trả về một fix với lat/lng = 0
    // thì engine sẽ tính khoảng cách tới đó và kết luận "ngoài vùng" thay vì
    // "không có dữ liệu vị trí" — hai kết luận dẫn tới hai hành động khác nhau.
    expect(gpsFixFromPunch({ latitude: null, longitude: null, accuracyMeters: null, bssid: null })).toBeNull();
    expect(
      gpsFixFromPunch({ latitude: 10.77, longitude: null, accuracyMeters: 10, bssid: null }),
    ).toBeNull();

    const ok = gpsFixFromPunch({
      latitude: 10.77,
      longitude: 106.7,
      accuracyMeters: 15,
      bssid: 'a4:5e:60:11:22:33',
      isMockLocation: null,
    });
    expect(ok).not.toBeNull();
    expect(ok!.lat).toBe(10.77);
    expect(ok!.isMockLocation).toBe(false);
  });
});
