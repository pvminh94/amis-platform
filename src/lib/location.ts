/**
 * ============================================================================
 * ADAPTER: tham số geofence/liveness trong DB → đầu vào của engine
 * ============================================================================
 *
 * Engine (`src/engine/geofence.ts`) nhận `GeoFence` + `GeoValidationConfig`.
 * Chính sách trong DB lưu theo hình dạng PHẲNG (`centerLat`, `centerLng`,
 * `weightSpectral`…) vì JSON Schema phải sinh được form.
 *
 * Hai hình dạng đó là hai cách diễn đạt cùng một thứ, nên việc chuyển đổi phải
 * nằm ở ĐÚNG MỘT chỗ. Nếu route và service mỗi nơi tự map một lần thì thêm một
 * ngân hàng tham số là thêm một chỗ để bỏ sót trường — và bỏ sót trường trong
 * geofence nghĩa là `hardRadiusM` thành `undefined`, nhân với dung sai thành
 * `NaN`, và mọi phép so sánh với NaN đều false tức là KHÔNG BAO GIỜ CHẶN.
 *
 * Đây chính là họ lỗi `Math.max(0, undefined) === NaN` đã gặp ở engine lương.
 */

import type { GeoFence, GeoValidationConfig, GpsFix } from '@/engine/geofence';
import type { LivenessConfig } from '@/engine/liveness';
import type { GeofenceParams } from '@/policy/geofence-params';
import type { LivenessParams } from '@/policy/liveness-params';

/** Ghép `GeoFence` (hình dạng engine) từ tham số phẳng trong DB. */
export function fenceFromParams(p: GeofenceParams): GeoFence {
  return {
    center:
      p.centerLat !== null && p.centerLng !== null
        ? { lat: p.centerLat, lng: p.centerLng }
        : undefined,
    radiusM: p.hardRadiusM,
    polygon: p.polygon ?? undefined,
    allowedBssids: p.allowedBssids,
  };
}

/** Ghép `GeoValidationConfig` từ tham số phẳng trong DB. */
export function configFromParams(p: GeofenceParams): GeoValidationConfig {
  return {
    maxAccuracyM: p.maxAccuracyM,
    hardRadiusM: p.hardRadiusM,
    softRadiusM: p.softRadiusM ?? undefined,
    requireWifiBssid: p.requireWifiBssid,
    blockMockLocation: p.blockMockLocation,
    accuracyToleranceFactor: p.accuracyToleranceFactor,
  };
}

/** Ghép `LivenessConfig` từ tham số phẳng trong DB. */
export function livenessConfigFromParams(p: LivenessParams): LivenessConfig {
  return {
    minConfidence: p.minConfidence,
    moirePeakThreshold: p.moirePeakThreshold,
    moireFreqBand: [p.moireFreqLow, p.moireFreqHigh],
    minDetailSharpness: p.minDetailSharpness,
    // `minHighFreqRatio` cố ý KHÔNG nằm trong tham số: engine ghi rõ nó chỉ mang
    // tính tham khảo vì phổ 2D của ảnh tự nhiên vốn trải rộng nên giá trị này gần
    // 1 với mọi ảnh. Đưa một con số vô nghĩa lên form là mời người ta chỉnh nó.
    minHighFreqRatio: 0.12,
    minBlinks: p.minBlinks,
    minHeadMotionDeg: p.minHeadMotionDeg,
    minMeanDepthMm: p.minMeanDepthMm,
    minSimilarity: p.minSimilarity,
    weights: {
      spectral: p.weightSpectral,
      moire: p.weightMoire,
      blink: p.weightBlink,
      motion: p.weightMotion,
      depth: p.weightDepth,
      similarity: p.weightSimilarity,
    },
  };
}

/**
 * Ghép `GpsFix` từ một dòng `raw_punches`.
 *
 * Cột trong DB là nullable; engine muốn `null` chứ không phải `undefined` cho
 * "không có". Ánh xạ tường minh ở đây thay vì rải `?? null` khắp nơi.
 */
export function gpsFixFromPunch(p: {
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  bssid: string | null;
  isMockLocation?: boolean | null;
}): GpsFix | null {
  // KHÔNG có toạ độ thì trả null, không phải một fix với lat/lng = 0. Toạ độ
  // (0,0) là một điểm có thật ở vịnh Guinea; engine sẽ tính khoảng cách tới đó
  // và kết luận "ngoài vùng" thay vì "không có dữ liệu vị trí".
  if (p.latitude === null || p.longitude === null) return null;
  return {
    lat: p.latitude,
    lng: p.longitude,
    accuracyM: p.accuracyMeters,
    bssid: p.bssid,
    isMockLocation: p.isMockLocation ?? false,
  };
}
