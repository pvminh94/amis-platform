/**
 * ============================================================================
 * LOẠI CHÍNH SÁCH THỨ MƯỜI — HỆ XOAY CA (3 CA 4 KÍP, 4 CA 5 KÍP…)
 * ============================================================================
 *
 * Vì sao hệ xoay cũng phải là policy kind chứ không phải hằng số:
 *
 *   Một nhà máy chuyển từ 3 ca 4 kíp sang 4 ca 5 kíp là chuyện xảy ra khi mở thêm
 *   dây chuyền. Nếu hệ xoay nằm trong code thì đó là một lần deploy, và trong lúc
 *   chờ deploy thì lịch đã xếp xong bằng hệ cũ — nghĩa là có một khoảng thời gian
 *   người ta làm ca mà hệ thống không biết, và khoảng đó sẽ bị tính là VẮNG.
 *
 *   Tệ hơn: hệ xoay quyết định AI LÀM CA ĐÊM. Đây là dữ liệu ảnh hưởng trực tiếp
 *   đến sức khoẻ người lao động và đến khoản phụ cấp 30% — nó phải có phiên bản,
 *   có khoảng hiệu lực, và có người ký, giống hệt mức thuế.
 *
 * Kiểm tra hợp lệ được GIAO CHO ENGINE (`validateRotation`), không viết lại một
 * bộ luật thứ hai — hai bộ luật thì sớm muộn cũng lệch nhau.
 */

import { z } from 'zod';

import { validateRotation, ShiftError, type RotationDef } from '@/engine/shift';

export const rotationParamsSchema = z
  .object({
    regimeCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, 'Mã hệ xoay phải VIẾT HOA, không dấu cách'),
    regimeLabel: z.string().min(1),

    /** Số ngày của một chu kỳ. Bắt buộc — không có giá trị ngầm định. */
    cycleLength: z.number().int().positive(),

    /**
     * pattern[i] = mã ca của ngày thứ i trong chu kỳ, hoặc mã nghỉ.
     *
     * Số phần tử PHẢI BẰNG cycleLength. Đây là ràng buộc dễ sai nhất: người ta
     * thêm một ngày vào pattern mà quên tăng cycleLength, và lịch xoay sẽ lệch
     * dần — mỗi chu kỳ trôi qua là lệch thêm một ngày, cho tới khi có người làm
     * ca đêm hai đêm liền.
     */
    pattern: z.array(z.string().min(1)).min(1),

    /** Mã dùng cho ngày nghỉ trong pattern. Không khai thì engine coi là 'REST'. */
    restCode: z.string().min(1).optional(),

    /** Số ngày lệch pha giữa hai kíp liên tiếp. Không khai thì engine dùng 2. */
    phaseStep: z.number().int().min(0).optional(),

    /**
     * Số kíp trong hệ. Cố ý KHÔNG để engine tự suy từ chu kỳ: suy ra thì phải
     * đoán (chu kỳ 8 có thể là 4 kíp pha 2, hoặc 8 kíp pha 1), và đoán sai thì
     * xếp "kíp 5" vào hệ 4 kíp sẽ âm thầm cho ra một ca sai thay vì báo lỗi.
     */
    teamCount: z.number().int().positive().optional(),
  })
  .superRefine((p, ctx) => {
    // GIAO CHO ENGINE. "Lưu được" và "engine resolve được" phải là cùng một
    // điều kiện — nếu không thì lỗi sẽ nổ lúc xếp lịch thay vì lúc bấm lưu.
    try {
      validateRotation({
        code: p.regimeCode,
        name: p.regimeLabel,
        cycleLength: p.cycleLength,
        pattern: p.pattern,
        restCode: p.restCode,
        phaseStep: p.phaseStep,
        teamCount: p.teamCount,
      });
    } catch (e) {
      if (!(e instanceof ShiftError)) throw e;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        // Lỗi về độ dài pattern thì trỏ vào đúng trường pattern để form bôi đỏ
        // đúng chỗ; các lỗi khác trỏ vào gốc.
        path: e.code === 'PATTERN_LENGTH_MISMATCH' || e.code === 'EMPTY_PATTERN_CODE'
          ? ['pattern']
          : e.code === 'BAD_CYCLE'
            ? ['cycleLength']
            : e.code === 'BAD_PHASE_STEP'
              ? ['phaseStep']
              : e.code === 'BAD_TEAM_COUNT'
                ? ['teamCount']
                : [],
        message: e.message,
      });
    }
  });

export type RotationParams = z.infer<typeof rotationParamsSchema>;

/** Bản mô tả cho giao diện tự sinh form — phải khớp trường với Zod schema. */
export const rotationJsonSchema = {
  type: 'object',
  required: ['regimeCode', 'regimeLabel', 'cycleLength', 'pattern'],
  properties: {
    regimeCode: {
      type: 'string',
      title: 'Mã hệ xoay (regimeCode)',
      pattern: '^[A-Z][A-Z0-9_]*$',
      description: 'VD: ROT_3CA4KIP, ROT_4CA5KIP',
    },
    regimeLabel: { type: 'string', title: 'Tên hệ xoay' },
    cycleLength: {
      type: 'integer',
      title: 'Độ dài chu kỳ (ngày)',
      minimum: 1,
      description: 'Phải bằng đúng số phần tử của pattern bên dưới.',
    },
    pattern: {
      type: 'array',
      title: 'Mẫu ca theo chu kỳ',
      description:
        'pattern[i] = mã ca của ngày thứ i trong chu kỳ. VD 3 ca 4 kíp: ' +
        'CA1, CA1, CA2, CA2, CA3, CA3, REST, REST',
      items: { type: 'string', minLength: 1, title: 'Mã ca' },
      minItems: 1,
    },
    restCode: {
      type: 'string',
      title: 'Mã ngày nghỉ',
      description: 'Phần tử nào trong pattern bằng mã này thì ngày đó nghỉ. Mặc định REST.',
    },
    phaseStep: {
      type: 'integer',
      title: 'Lệch pha giữa hai kíp (ngày)',
      minimum: 0,
      description: 'Mặc định 2. Kíp i lệch i × giá trị này.',
    },
    teamCount: {
      type: 'integer',
      title: 'Số kíp',
      minimum: 1,
      description: 'Khai để chặn xếp lịch vào kíp không tồn tại.',
    },
  },
} as const;

/** Hệ xoay 3 ca 4 kíp — phổ biến nhất ở nhà máy VN. */
export const SEED_ROTATIONS_VN: RotationParams[] = [
  {
    regimeCode: 'ROT_3CA4KIP',
    regimeLabel: 'Xoay 3 ca 4 kíp (chu kỳ 8 ngày)',
    cycleLength: 8,
    pattern: ['CA1', 'CA1', 'CA2', 'CA2', 'CA3', 'CA3', 'REST', 'REST'],
    restCode: 'REST',
    phaseStep: 2,
    teamCount: 4,
  },
];
