/**
 * ============================================================================
 * LOẠI CHÍNH SÁCH THỨ MƯỜI HAI — GEOFENCE (vùng chấm công hợp lệ)
 * ============================================================================
 *
 * Vì sao đây là THAM SỐ chứ không phải code:
 *   - Văn phòng chuyển địa điểm, mở thêm chi nhánh, thuê thêm tầng
 *   - Access point WiFi được thay → BSSID đổi
 *   - Bán kính phải nới ra khi toà nhà bên cạnh che tín hiệu GPS
 * Cả ba việc đó xảy ra hàng tháng. Nếu nằm trong code thì mỗi lần là một lần
 * deploy, và trong lúc chờ deploy thì người ta sửa tay trong database — mất
 * luôn khả năng truy vết ai đã nới vùng chấm công và vì sao.
 *
 * exclusiveByCode = true: mỗi ĐỊA ĐIỂM một hàng rào đang hiệu lực, nhiều địa
 * điểm cùng tồn tại. Cùng mẫu với SHIFT và PRINT.
 *
 * `regimeCode` ở đây là MÃ ĐỊA ĐIỂM (SITE_HQ, SITE_BINH_DUONG…). Registry bắt
 * buộc trường này để xác định thực thể — không phải quy ước tuỳ ý.
 */

import { z } from 'zod';

/** Một đỉnh toạ độ. */
const latLngSchema = z
  .object({
    lat: z.number().min(-90).max(90).describe('Vĩ độ (-90..90)'),
    lng: z.number().min(-180).max(180).describe('Kinh độ (-180..180)'),
  })
  .strict();

/**
 * BSSID hợp lệ: 6 cặp hex phân cách bằng ':' hoặc '-'.
 *
 * Kiểm tra ngay lúc LƯU, không phải lúc chấm công. Một BSSID gõ sai trong cấu
 * hình sẽ khiến mọi nhân viên ở văn phòng đó bị đánh dấu "không khớp WiFi" —
 * và lỗi đó trông y hệt gian lận, nên sẽ không ai nghĩ tới việc kiểm tra cấu hình.
 */
const BSSID_RE = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/;

export const geofenceParamsSchema = z
  .object({
    regimeCode: z
      .string()
      .min(2)
      .max(32)
      .regex(/^[A-Z0-9_]+$/, 'Mã địa điểm chỉ gồm chữ HOA, số và dấu gạch dưới'),
    regimeLabel: z.string().min(1).max(200),

    /** Tâm của vùng tròn. Bỏ trống nếu chỉ dùng polygon. */
    centerLat: z.number().min(-90).max(90).nullable(),
    centerLng: z.number().min(-180).max(180).nullable(),

    /**
     * Bán kính CỨNG (mét) — ra ngoài là CHẶN.
     *
     * Không có `.default()`: một trường số để trống gửi lên thành 0, và bán kính
     * 0 nghĩa là chặn hết mọi người. Đây đúng là họ lỗi đã gặp ở bộ tham số thuế
     * và ca kíp — thiếu thì bắt khai báo rõ.
     */
    hardRadiusM: z.number().int().min(0).max(100_000),

    /**
     * Bán kính MỀM (mét) — trong vùng cứng nhưng ngoài vùng này thì vẫn chấm
     * được, chỉ chuyển sang HR rà soát.
     *
     * null = không dùng vùng mềm (mọi thứ trong bán kính cứng đều tin cậy).
     */
    softRadiusM: z.number().int().min(0).max(100_000).nullable(),

    /**
     * Polygon khuôn viên (mảng đỉnh). Ưu tiên hơn bán kính tròn khi có.
     *
     * Khai MỞ hay ĐÓNG đều được — engine tự nhận ra điểm cuối trùng điểm đầu.
     * (Bản Phase 1 có một bug ở đây: hai hàm hiểu "ring đóng" theo hai kiểu
     * khác nhau, khiến tứ giác khai báo mở bị mất một cạnh khi tính khoảng
     * cách tới biên — lệch 41%. Đã sửa bằng một hàm `openRing` dùng chung.)
     */
    polygon: z.array(latLngSchema).min(3).nullable(),

    /**
     * Danh sách BSSID WiFi hợp lệ. RỖNG = không đối soát WiFi (nhiều thiết bị
     * iOS không đọc được BSSID nên không thể bắt buộc ở mọi nơi).
     */
    allowedBssids: z.array(z.string().regex(BSSID_RE, 'BSSID phải theo dạng aa:bb:cc:dd:ee:ff')),

    // --- Ngưỡng kiểm tra ----------------------------------------------------

    /**
     * Từ chối fix có accuracy lớn hơn giá trị này (mét).
     *
     * `navigator.geolocation` trả về accuracy là bán kính tin cậy 68%. Fix quá
     * "mờ" thì khoảng cách tính ra vô nghĩa — 500m sai số thì bán kính 200m
     * không nói lên điều gì.
     */
    maxAccuracyM: z.number().int().min(1).max(5_000),

    /** Bắt buộc phải khớp BSSID. true thì không đọc được BSSID cũng bị chặn. */
    requireWifiBssid: z.boolean(),

    /** Chặn vị trí giả lập (mock provider) do hệ điều hành khai báo. */
    blockMockLocation: z.boolean(),

    /**
     * Dung sai cộng thêm vào bán kính cứng, theo accuracy của fix.
     *
     *   bán kính hiệu dụng = hardRadiusM + accuracy × hệ số
     *
     * Bù cho sai số GPS: người đứng đúng cổng nhưng fix lệch 40m thì không nên
     * bị từ chối. Hệ số 0 = không bù.
     */
    accuracyToleranceFactor: z.number().min(0).max(3),
  })
  .strict()
  /**
   * Phải có ÍT NHẤT một trong hai cách xác định vùng: tâm+bán kính, hoặc polygon.
   *
   * Không có ràng buộc này thì lưu được một hàng rào "rỗng" — và engine gặp
   * hàng rào rỗng sẽ chấp nhận MỌI vị trí kèm một câu cảnh báo. Một cấu hình
   * sai vì thế biến thành "ai chấm ở đâu cũng được", âm thầm.
   */
  .refine((v) => (v.centerLat !== null && v.centerLng !== null) || (v.polygon?.length ?? 0) >= 3, {
    message: 'Phải khai báo tâm + bán kính, HOẶC một polygon ít nhất 3 đỉnh',
    path: ['centerLat'],
  })
  .refine((v) => v.softRadiusM === null || v.softRadiusM <= v.hardRadiusM, {
    message: 'Bán kính mềm không được lớn hơn bán kính cứng',
    path: ['softRadiusM'],
  });

export type GeofenceParams = z.infer<typeof geofenceParamsSchema>;

export const geofenceJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Geofence — vùng chấm công hợp lệ',
  type: 'object',
  additionalProperties: false,
  required: [
    'regimeCode',
    'regimeLabel',
    'centerLat',
    'centerLng',
    'hardRadiusM',
    'softRadiusM',
    'polygon',
    'allowedBssids',
    'maxAccuracyM',
    'requireWifiBssid',
    'blockMockLocation',
    'accuracyToleranceFactor',
  ],
  properties: {
    regimeCode: {
      type: 'string',
      title: 'Mã địa điểm',
      pattern: '^[A-Z0-9_]+$',
      minLength: 2,
      maxLength: 32,
    },
    regimeLabel: { type: 'string', title: 'Tên địa điểm', minLength: 1, maxLength: 200 },
    centerLat: {
      type: ['number', 'null'],
      title: 'Vĩ độ tâm',
      minimum: -90,
      maximum: 90,
    },
    centerLng: {
      type: ['number', 'null'],
      title: 'Kinh độ tâm',
      minimum: -180,
      maximum: 180,
    },
    hardRadiusM: {
      type: 'integer',
      title: 'Bán kính cứng (m) — ra ngoài là chặn',
      minimum: 0,
      maximum: 100000,
    },
    softRadiusM: {
      type: ['integer', 'null'],
      title: 'Bán kính mềm (m) — ngoài thì chuyển HR rà soát',
      minimum: 0,
      maximum: 100000,
    },
    polygon: {
      type: ['array', 'null'],
      title: 'Polygon khuôn viên (ưu tiên hơn bán kính tròn)',
      minItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['lat', 'lng'],
        properties: {
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
        },
      },
    },
    allowedBssids: {
      type: 'array',
      title: 'BSSID WiFi hợp lệ (rỗng = không đối soát)',
      items: { type: 'string', pattern: '^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$' },
    },
    maxAccuracyM: {
      type: 'integer',
      title: 'Độ chính xác GPS tối đa chấp nhận (m)',
      minimum: 1,
      maximum: 5000,
    },
    requireWifiBssid: { type: 'boolean', title: 'Bắt buộc đối soát WiFi' },
    blockMockLocation: { type: 'boolean', title: 'Chặn vị trí giả lập (mock GPS)' },
    accuracyToleranceFactor: {
      type: 'number',
      title: 'Hệ số bù sai số GPS (0 = không bù)',
      minimum: 0,
      maximum: 3,
    },
  },
} as const;

/**
 * Hai địa điểm mẫu. Toạ độ thật ở TP.HCM để khoảng cách tính ra có nghĩa khi
 * đối chiếu bằng tay.
 *
 * ⚠️ BSSID DƯỚI ĐÂY LÀ SỐ GIẢ. Trước khi dùng thật phải thay bằng BSSID của
 * access point thật — và phải kiểm bằng chính app mobile, vì iOS và Android
 * trả về BSSID theo hai định dạng phân cách khác nhau (`:` và `-`).
 */
export const SEED_GEOFENCES_VN: GeofenceParams[] = [
  {
    regimeCode: 'SITE_HQ',
    regimeLabel: 'Trụ sở chính — Quận 1, TP.HCM',
    centerLat: 10.776889,
    centerLng: 106.700806,
    hardRadiusM: 200,
    softRadiusM: 120,
    polygon: null,
    allowedBssids: ['a4:5e:60:11:22:33', 'a4:5e:60:11:22:34'],
    maxAccuracyM: 65,
    requireWifiBssid: false,
    blockMockLocation: true,
    accuracyToleranceFactor: 1,
  },
  {
    regimeCode: 'SITE_BINH_DUONG',
    regimeLabel: 'Nhà máy Bình Dương — khu công nghiệp VSIP',
    // Khuôn viên nhà máy là MỘT ĐA GIÁC, không phải hình tròn: cổng nằm sát
    // đường lớn, và bán kính tròn đủ rộng để bao cổng thì sẽ bao luôn cả bãi
    // đỗ xe của khu công nghiệp bên cạnh.
    centerLat: 11.004,
    centerLng: 106.717,
    hardRadiusM: 350,
    softRadiusM: 250,
    polygon: [
      { lat: 11.0021, lng: 106.7142 },
      { lat: 11.0021, lng: 106.7198 },
      { lat: 11.0059, lng: 106.7198 },
      { lat: 11.0059, lng: 106.7142 },
    ],
    // Nhà máy không có WiFi phủ khắp xưởng nên không đối soát BSSID.
    allowedBssids: [],
    maxAccuracyM: 80,
    requireWifiBssid: false,
    blockMockLocation: true,
    accuracyToleranceFactor: 1.5,
  },
];
