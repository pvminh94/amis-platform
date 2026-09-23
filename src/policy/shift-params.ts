/**
 * ============================================================================
 * LOẠI CHÍNH SÁCH THỨ TÁM — ĐỊNH NGHĨA CA LÀM VIỆC
 * ============================================================================
 *
 * Giờ vào ca là thứ thay đổi thường xuyên nhất trong một nhà máy: đổi theo mùa,
 * theo đơn hàng, theo thoả ước lao động. Nếu nó nằm trong code thì mỗi lần đổi
 * là một lần deploy — và trong lúc chờ deploy thì người ta sửa tay trong database,
 * mất luôn khả năng truy vết.
 *
 * ĐIỂM QUAN TRỌNG NHẤT của file này: việc kiểm tra hợp lệ được giao cho CHÍNH
 * ENGINE (`resolveShift`). Không viết lại một bộ luật kiểm tra thứ hai ở đây, vì
 * hai bộ luật thì sớm muộn cũng lệch nhau — và bản lệch nhau sẽ cho lưu một ca
 * mà engine không resolve được, tức là lỗi nổ vào lúc đang xếp lịch chứ không
 * phải lúc người dùng bấm lưu.
 */

import { z } from 'zod';

import { DEFAULT_NIGHT_END, DEFAULT_NIGHT_START, resolveShift, ShiftError } from '@/engine/shift';

/** "HH:mm", cho phép 24:00 để diễn đạt "kết thúc đúng nửa đêm". */
const TIME_RE = '^([01]?[0-9]|2[0-3]|24):[0-5][0-9]$';

export const SHIFT_TYPES = ['OFFICE', 'NIGHT_CROSS_DAY', 'SPLIT', 'ROTATING', 'FLEXIBLE'] as const;

export const shiftSegmentSchema = z.object({
  name: z.string().min(1),
  start: z.string().regex(new RegExp(TIME_RE), 'Giờ vào phải theo dạng HH:mm'),
  end: z.string().regex(new RegExp(TIME_RE), 'Giờ ra phải theo dạng HH:mm'),
  /**
   * Cố ý không có `.default(0)`.
   *
   * Tham số ca kíp không được có giá trị ngầm định: một trường số trống gửi lên
   * thành 0, và 0 với "không khai" là hai ý khác nhau ở đây (0 = ra cùng ngày,
   * không khai = để engine tự suy luận từ giờ). Đây đúng là họ lỗi đã gặp ở bộ
   * tham số thuế.
   */
  endDayOffset: z.number().int().min(0).max(1).optional(),
  breakMinutes: z.number().int().min(0).optional(),
});

export const shiftParamsSchema = z
  .object({
    regimeCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Mã ca phải là chữ hoa, số và gạch dưới'),
    regimeLabel: z.string().min(1),
    shiftType: z.enum(SHIFT_TYPES),
    segments: z.array(shiftSegmentSchema).min(1, 'Ca phải có ít nhất một đoạn giờ'),
    nightStart: z
      .string()
      .regex(new RegExp(TIME_RE), 'Giờ phải theo dạng HH:mm')
      .optional(),
    nightEnd: z
      .string()
      .regex(new RegExp(TIME_RE), 'Giờ phải theo dạng HH:mm')
      .optional(),
    standardHours: z.number().positive().optional(),
  })
  .superRefine((p, ctx) => {
    // --- Tên đoạn không được trùng ---------------------------------------
    // Hai đoạn cùng tên thì dòng chấm công và phiếu lương không phân biệt được
    // chúng, và khi sửa một đoạn người ta rất dễ sửa nhầm đoạn kia.
    const seen = new Set<string>();
    p.segments.forEach((s, i) => {
      if (seen.has(s.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', i, 'name'],
          message: `Đoạn "${s.name}" trùng tên với một đoạn khác trong cùng ca.`,
        });
      }
      seen.add(s.name);
    });

    // --- GIAO CHO ENGINE kiểm tra phần còn lại ----------------------------
    // Chồng lấn đoạn, giờ nghỉ vượt thời lượng, giờ ra không sau giờ vào, khung
    // đêm vô lý — tất cả đã có luật trong resolveShift. Gọi nó ở đây nghĩa là
    // "lưu được" và "engine chạy được" là cùng một điều kiện.
    try {
      resolveShift(
        {
          code: p.regimeCode,
          name: p.regimeLabel,
          type: p.shiftType,
          segments: p.segments,
          nightStart: p.nightStart,
          nightEnd: p.nightEnd,
          standardHours: p.standardHours ?? null,
        },
        '2000-01-03', // ngày bất kỳ — resolveShift không phụ thuộc ngày cụ thể
      );
    } catch (e) {
      if (e instanceof ShiftError) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: e.code === 'SEGMENTS_OVERLAP' || e.code === 'SEGMENT_NOT_POSITIVE' ? ['segments'] : [],
          message: e.message,
        });
      } else {
        // parseTimeOfDay ném RangeError. Vẫn phải báo cho người dùng, nhưng không
        // được nuốt: một định nghĩa ca không resolve được thì không được lưu.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [],
          message: e instanceof Error ? e.message : 'Định nghĩa ca không hợp lệ',
        });
      }
    }
  });

export type ShiftParams = z.infer<typeof shiftParamsSchema>;

export const shiftJsonSchema = {
  type: 'object',
  required: ['regimeCode', 'regimeLabel', 'shiftType', 'segments'],
  properties: {
    regimeCode: {
      type: 'string',
      title: 'Mã ca (regimeCode)',
      pattern: '^[A-Z][A-Z0-9_]*$',
      description: 'VD: HC, CA1, CA2, CA3',
    },
    regimeLabel: { type: 'string', title: 'Tên ca' },
    shiftType: {
      type: 'string',
      title: 'Loại ca',
      enum: [...SHIFT_TYPES],
      description: 'NIGHT_CROSS_DAY là ca vắt qua nửa đêm',
    },
    nightStart: {
      type: 'string',
      title: 'Bắt đầu khung giờ đêm',
      pattern: TIME_RE,
      description: `Mặc định ${DEFAULT_NIGHT_START} — Điều 106 BLLĐ 2019`,
    },
    nightEnd: {
      type: 'string',
      title: 'Kết thúc khung giờ đêm',
      pattern: TIME_RE,
      description: `Mặc định ${DEFAULT_NIGHT_END}`,
    },
    standardHours: {
      type: 'number',
      title: 'Số giờ công chuẩn',
      exclusiveMinimum: 0,
      description: 'Bỏ trống thì tự tính từ các đoạn giờ',
    },
    segments: {
      type: 'array',
      title: 'Đoạn giờ',
      minItems: 1,
      description: 'Ca gãy có nhiều đoạn. Ca đêm có endDayOffset = 1.',
      items: {
        type: 'object',
        required: ['name', 'start', 'end'],
        properties: {
          name: { type: 'string', title: 'Tên đoạn' },
          start: { type: 'string', title: 'Giờ vào', pattern: TIME_RE },
          end: { type: 'string', title: 'Giờ ra', pattern: TIME_RE },
          endDayOffset: {
            type: 'integer',
            title: 'Giờ ra thuộc ngày hôm sau',
            minimum: 0,
            maximum: 1,
            description: '1 nếu ca vắt qua 0h. Bỏ trống thì tự suy luận.',
          },
          breakMinutes: {
            type: 'integer',
            title: 'Giờ nghỉ (phút)',
            minimum: 0,
            description: 'Trừ khỏi giờ công',
          },
        },
      },
    },
  },
} as const;

/** Bốn ca phổ biến: hành chính, và ba ca của hệ 3 ca 4 kíp. */
export const SEED_SHIFTS_VN: ShiftParams[] = [
  {
    regimeCode: 'HC',
    regimeLabel: 'Hành chính 8:00–17:00',
    shiftType: 'OFFICE',
    nightStart: DEFAULT_NIGHT_START,
    nightEnd: DEFAULT_NIGHT_END,
    segments: [{ name: 'Sáng-chiều', start: '08:00', end: '17:00', breakMinutes: 60 }],
  },
  {
    regimeCode: 'GAY',
    regimeLabel: 'Ca gãy sáng–chiều',
    shiftType: 'SPLIT',
    nightStart: DEFAULT_NIGHT_START,
    nightEnd: DEFAULT_NIGHT_END,
    segments: [
      { name: 'Sáng', start: '08:00', end: '12:00' },
      { name: 'Chiều', start: '14:00', end: '18:00' },
    ],
  },
  {
    regimeCode: 'CA1',
    regimeLabel: 'Ca 1 — sáng',
    shiftType: 'ROTATING',
    nightStart: DEFAULT_NIGHT_START,
    nightEnd: DEFAULT_NIGHT_END,
    segments: [{ name: 'Ca sáng', start: '06:00', end: '14:00' }],
  },
  {
    regimeCode: 'CA2',
    regimeLabel: 'Ca 2 — chiều',
    shiftType: 'ROTATING',
    nightStart: DEFAULT_NIGHT_START,
    nightEnd: DEFAULT_NIGHT_END,
    segments: [{ name: 'Ca chiều', start: '14:00', end: '22:00' }],
  },
  {
    regimeCode: 'CA3',
    regimeLabel: 'Ca 3 — đêm (vắt 0h)',
    shiftType: 'NIGHT_CROSS_DAY',
    nightStart: DEFAULT_NIGHT_START,
    nightEnd: DEFAULT_NIGHT_END,
    // endDayOffset khai tường minh để người đọc thấy ngay đây là ca qua ngày,
    // dù engine cũng tự suy luận được từ 06:00 < 22:00.
    segments: [{ name: 'Ca đêm', start: '22:00', end: '06:00', endDayOffset: 1 }],
  },
];
