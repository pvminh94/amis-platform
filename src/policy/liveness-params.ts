/**
 * ============================================================================
 * LOẠI CHÍNH SÁCH THỨ MƯỜI BA — NGƯỠNG CHỐNG GIẢ MẠO KHUÔN MẶT
 * ============================================================================
 *
 * Vì sao ngưỡng là THAM SỐ còn thuật toán là CODE:
 *
 *   Thuật toán (FFT, phổ Moiré, phương sai Laplacian) là vật lý và toán học —
 *   nó không đổi theo nghị định nào. Nhưng NGƯỠNG thì phải chỉnh theo thiết bị:
 *   camera của máy chấm công để ở cổng nhà máy, phơi nắng buổi trưa, cho ra ảnh
 *   tương phản khác hẳn camera trong văn phòng máy lạnh. Cùng một ngưỡng sẽ chặn
 *   oan người thật ở chỗ này và lọt ảnh in ở chỗ kia.
 *
 *   Đây là ranh giới "cái gì configurable" áp dụng đúng nghĩa: người vận hành
 *   chỉnh ngưỡng trên giao diện và có audit trail ai đã chỉnh, còn không ai
 *   chỉnh được công thức Fourier từ giao diện.
 *
 * exclusiveByCode = false: chỉ MỘT bộ ngưỡng hiệu lực tại một thời điểm, giống
 * biểu thuế. Hai bộ ngưỡng cùng hiệu lực thì không biết chấm công bị đánh giá
 * theo bộ nào.
 */

import { z } from 'zod';

const unit = z.number().min(0).max(1);

export const livenessParamsSchema = z
  .object({
    regimeCode: z
      .string()
      .min(2)
      .max(32)
      .regex(/^[A-Z0-9_]+$/, 'Mã bộ ngưỡng chỉ gồm chữ HOA, số và dấu gạch dưới'),
    regimeLabel: z.string().min(1).max(200),

    /**
     * Điểm tổng hợp tối thiểu để coi là người thật (0..1).
     *
     * Không có `.default()` — cùng lý do với mọi bộ tham số khác trong repo:
     * một trường số để trống gửi lên thành 0, và ngưỡng 0 nghĩa là CHẤP NHẬN
     * MỌI THỨ kể cả ảnh in ra giấy.
     */
    minConfidence: unit,

    /** Đỉnh phổ Moiré vượt tỷ lệ này => nghi phát lại trên màn hình. */
    moirePeakThreshold: z.number().min(1).max(100),

    /**
     * Dải tần số KHÔNG GIAN hợp lệ của vân Moiré, tính theo phần của Nyquist.
     *
     * Màn hình có chu kỳ pixel ~2–10 px nên đỉnh Moiré nằm trong dải này. Đỉnh
     * nằm NGOÀI dải là gradient của chính bức ảnh (trời, tường, áo) chứ không
     * phải Moiré — nếu không lọc dải thì ảnh chụp ngoài trời bị kết luận oan là
     * phát lại từ màn hình.
     */
    moireFreqLow: z.number().min(0).max(0.5),
    moireFreqHigh: z.number().min(0).max(0.5),

    /** Độ sắc nét chuẩn hoá dưới ngưỡng này => nghi ảnh in 2D / bề mặt phẳng. */
    minDetailSharpness: z.number().min(0).max(50),

    /** Số lần chớp mắt tối thiểu trong cửa sổ quan sát. */
    minBlinks: z.number().int().min(0).max(10),

    /** Biên độ chuyển động đầu tối thiểu (độ). Đầu bất động hoàn toàn là dấu hiệu phát lại. */
    minHeadMotionDeg: z.number().min(0).max(60),

    /** Độ sâu trung bình tối thiểu để coi là có khối (mm). Màn hình phẳng ~ 0. */
    minMeanDepthMm: z.number().min(0).max(500),

    /** Điểm tương đồng tối thiểu với vector khuôn mặt đã đăng ký (0..1). */
    minSimilarity: unit,

    // --- Trọng số các thành phần điểm --------------------------------------
    weightSpectral: unit,
    weightMoire: unit,
    weightBlink: unit,
    weightMotion: unit,
    weightDepth: unit,
    weightSimilarity: unit,
  })
  .strict()
  .refine((v) => v.moireFreqLow < v.moireFreqHigh, {
    message: 'moireFreqLow phải nhỏ hơn moireFreqHigh',
    path: ['moireFreqLow'],
  })
  /**
   * Tổng trọng số phải bằng 1.
   *
   * Điểm tổng hợp là TỔNG CÓ TRỌNG SỐ và được so với `minConfidence` nằm trong
   * 0..1. Nếu trọng số cộng lại thành 0,7 thì điểm tối đa đạt được là 0,7 — và
   * nếu ai đó đặt minConfidence = 0,8 thì KHÔNG AI qua được liveness, kể cả người
   * thật đứng trước camera. Ngược lại tổng 1,3 thì ảnh in cũng có thể đạt 0,8.
   * Cả hai hướng đều sai và đều không có thông báo nào kêu lên.
   */
  .refine(
    (v) => {
      const total =
        v.weightSpectral + v.weightMoire + v.weightBlink + v.weightMotion + v.weightDepth + v.weightSimilarity;
      return Math.abs(total - 1) < 1e-6;
    },
    {
      message: 'Tổng sáu trọng số phải đúng bằng 1 — lệch thì điểm tổng hợp không so được với minConfidence',
      path: ['weightSpectral'],
    },
  );

export type LivenessParams = z.infer<typeof livenessParamsSchema>;

export const livenessJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Ngưỡng chống giả mạo khuôn mặt',
  type: 'object',
  additionalProperties: false,
  required: [
    'regimeCode',
    'regimeLabel',
    'minConfidence',
    'moirePeakThreshold',
    'moireFreqLow',
    'moireFreqHigh',
    'minDetailSharpness',
    'minBlinks',
    'minHeadMotionDeg',
    'minMeanDepthMm',
    'minSimilarity',
    'weightSpectral',
    'weightMoire',
    'weightBlink',
    'weightMotion',
    'weightDepth',
    'weightSimilarity',
  ],
  properties: {
    regimeCode: {
      type: 'string',
      title: 'Mã bộ ngưỡng',
      pattern: '^[A-Z0-9_]+$',
      minLength: 2,
      maxLength: 32,
    },
    regimeLabel: { type: 'string', title: 'Tên bộ ngưỡng', minLength: 1, maxLength: 200 },
    minConfidence: {
      type: 'number',
      title: 'Điểm tối thiểu để coi là người thật (0..1)',
      minimum: 0,
      maximum: 1,
    },
    moirePeakThreshold: {
      type: 'number',
      title: 'Ngưỡng đỉnh Moiré (nghi màn hình)',
      minimum: 1,
      maximum: 100,
    },
    moireFreqLow: {
      type: 'number',
      title: 'Dải Moiré — cận dưới (phần của Nyquist)',
      minimum: 0,
      maximum: 0.5,
    },
    moireFreqHigh: {
      type: 'number',
      title: 'Dải Moiré — cận trên (phần của Nyquist)',
      minimum: 0,
      maximum: 0.5,
    },
    minDetailSharpness: {
      type: 'number',
      title: 'Độ sắc nét tối thiểu (nghi ảnh in 2D)',
      minimum: 0,
      maximum: 50,
    },
    minBlinks: { type: 'integer', title: 'Số lần chớp mắt tối thiểu', minimum: 0, maximum: 10 },
    minHeadMotionDeg: {
      type: 'number',
      title: 'Chuyển động đầu tối thiểu (độ)',
      minimum: 0,
      maximum: 60,
    },
    minMeanDepthMm: {
      type: 'number',
      title: 'Độ sâu tối thiểu (mm) — màn hình phẳng ~ 0',
      minimum: 0,
      maximum: 500,
    },
    minSimilarity: {
      type: 'number',
      title: 'Tương đồng tối thiểu với khuôn mặt đã đăng ký',
      minimum: 0,
      maximum: 1,
    },
    weightSpectral: { type: 'number', title: 'Trọng số — phổ tần số', minimum: 0, maximum: 1 },
    weightMoire: { type: 'number', title: 'Trọng số — Moiré', minimum: 0, maximum: 1 },
    weightBlink: { type: 'number', title: 'Trọng số — chớp mắt', minimum: 0, maximum: 1 },
    weightMotion: { type: 'number', title: 'Trọng số — chuyển động đầu', minimum: 0, maximum: 1 },
    weightDepth: { type: 'number', title: 'Trọng số — độ sâu', minimum: 0, maximum: 1 },
    weightSimilarity: { type: 'number', title: 'Trọng số — tương đồng', minimum: 0, maximum: 1 },
  },
} as const;

/**
 * Bộ ngưỡng mặc định — đúng bằng DEFAULT_LIVENESS_CONFIG trong engine, nhưng ở
 * đây nó là DỮ LIỆU để người vận hành chỉnh được.
 */
export const SEED_LIVENESS_VN: LivenessParams[] = [
  {
    regimeCode: 'LIVENESS_STD',
    regimeLabel: 'Ngưỡng chuẩn — camera chấm công trong nhà',
    minConfidence: 0.62,
    moirePeakThreshold: 8,
    moireFreqLow: 0.08,
    moireFreqHigh: 0.48,
    minDetailSharpness: 2.5,
    minBlinks: 1,
    minHeadMotionDeg: 1.5,
    minMeanDepthMm: 12,
    minSimilarity: 0.42,
    weightSpectral: 0.2,
    weightMoire: 0.25,
    weightBlink: 0.12,
    weightMotion: 0.13,
    weightDepth: 0.15,
    weightSimilarity: 0.15,
  },
];
