/**
 * Test resolve ca kíp.
 *
 * Nhóm quan trọng nhất là CA ĐÊM VẮT 0h. Đây là nguồn bug kinh điển của chấm
 * công: giờ ra nhỏ hơn giờ vào, ngày của giờ ra khác ngày công vụ, và khung phụ
 * cấp đêm nằm vắt qua chính cái ranh giới đó. Nếu những test này xanh thì phần
 * khó nhất của chấm công đã đúng; nếu thiếu chúng thì "ca đêm chạy được" chỉ có
 * nghĩa là ca hành chính chạy được.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveShift,
  nightOverlapMinutes,
  resolveRotationShiftCode,
  absToCalendar,
  ShiftError,
  type ShiftDef,
  type RotationDef,
} from '../src/engine/shift';
import { parseTimeOfDay, formatTimeOfDay, toLocalMoment, diffDays } from '../src/engine/time';

const D = '2026-09-15'; // Thứ ba

const OFFICE: ShiftDef = {
  code: 'HC',
  name: 'Hành chính',
  type: 'OFFICE',
  segments: [{ name: 'Sáng-chiều', start: '08:00', end: '17:00', breakMinutes: 60 }],
};

const NIGHT: ShiftDef = {
  code: 'CA3',
  name: 'Ca đêm',
  type: 'NIGHT_CROSS_DAY',
  segments: [{ name: 'Đêm', start: '22:00', end: '06:00' }],
};

const SPLIT: ShiftDef = {
  code: 'GAY',
  name: 'Ca gãy',
  type: 'SPLIT',
  segments: [
    { name: 'Sáng', start: '08:00', end: '12:00' },
    { name: 'Chiều', start: '14:00', end: '18:00' },
  ],
};

describe('ca hành chính', () => {
  it('9 tiếng trừ 60 phút nghỉ = 8 giờ công', () => {
    const r = resolveShift(OFFICE, D);
    expect(r.totalNetMinutes).toBe(480);
    expect(r.totalNetHours).toBe(8);
    expect(r.standardDays).toBe(1);
  });

  it('không có phút đêm nào', () => {
    expect(resolveShift(OFFICE, D).nightMinutes).toBe(0);
  });

  it('không vắt qua ngày — endDate trùng workDate', () => {
    const r = resolveShift(OFFICE, D);
    expect(r.crossMidnight).toBe(false);
    expect(r.endDate).toBe(D);
  });
});

describe('ca đêm vắt 0h — trường hợp khó nhất', () => {
  it('22:00 → 06:00 tự hiểu là qua ngày hôm sau', () => {
    const r = resolveShift(NIGHT, D);
    expect(r.crossMidnight).toBe(true);
    expect(r.segments[0]!.endDayOffset).toBe(1);
  });

  it('endDate là ngày HÔM SAU của workDate', () => {
    const r = resolveShift(NIGHT, D);
    expect(r.startDate).toBe('2026-09-15');
    expect(r.endDate).toBe('2026-09-16');
  });

  it('8 tiếng thì cả 8 tiếng đều là giờ đêm', () => {
    const r = resolveShift(NIGHT, D);
    expect(r.totalNetMinutes).toBe(480);
    expect(r.nightMinutes).toBe(480);
    expect(r.nightHours).toBe(8);
  });

  it('phút tuyệt đối của giờ ra lớn hơn 1440 — bằng chứng nó nằm ở ngày sau', () => {
    const r = resolveShift(NIGHT, D);
    expect(r.segments[0]!.absStart).toBe(1320);
    expect(r.segments[0]!.absEnd).toBe(1800); // 1440 + 360
  });

  it('ca đêm vắt qua tháng/năm vẫn đúng ngày', () => {
    // Đây là chỗ addDays phải thật sự đúng, không phải cộng 1 vào chuỗi.
    expect(resolveShift(NIGHT, '2026-09-30').endDate).toBe('2026-10-01');
    expect(resolveShift(NIGHT, '2026-12-31').endDate).toBe('2027-01-01');
    // Năm nhuận
    expect(resolveShift(NIGHT, '2028-02-28').endDate).toBe('2028-02-29');
    expect(resolveShift(NIGHT, '2028-02-29').endDate).toBe('2028-03-01');
  });
});

describe('ca gãy — hai đoạn không liền nhau', () => {
  it('4 + 4 = 8 giờ công', () => {
    const r = resolveShift(SPLIT, D);
    expect(r.segments.length).toBe(2);
    expect(r.totalNetMinutes).toBe(480);
  });

  it('khoảng nghỉ giữa hai đoạn không bị tính là giờ công', () => {
    const r = resolveShift(SPLIT, D);
    // 08:00→18:00 là 600 phút, nhưng chỉ 480 phút công
    expect(r.absEnd - r.absStart).toBe(600);
    expect(r.totalNetMinutes).toBe(480);
  });

  it('các đoạn được sắp lại theo giờ vào dù khai báo lộn xộn', () => {
    const reversed: ShiftDef = { ...SPLIT, segments: [SPLIT.segments[1]!, SPLIT.segments[0]!] };
    const r = resolveShift(reversed, D);
    expect(r.segments[0]!.name).toBe('Sáng');
    expect(r.segments[1]!.name).toBe('Chiều');
    expect(r.segments[0]!.index).toBe(0);
  });
});

describe('khung giờ đêm — chỉ tính phần thật sự nằm trong khung', () => {
  it('ca 20:00→04:00 chỉ có 6 tiếng đêm (22:00→04:00)', () => {
    const r = resolveShift(
      { code: 'X', name: 'X', type: 'NIGHT_CROSS_DAY', segments: [{ name: 'a', start: '20:00', end: '04:00' }] },
      D,
    );
    expect(r.totalNetMinutes).toBe(480);
    expect(r.nightMinutes).toBe(360);
  });

  it('ca 04:00→12:00 chỉ có 2 tiếng đêm (04:00→06:00)', () => {
    const r = resolveShift(
      { code: 'X', name: 'X', type: 'ROTATING', segments: [{ name: 'a', start: '04:00', end: '12:00' }] },
      D,
    );
    expect(r.nightMinutes).toBe(120);
  });

  it('ca 12 tiếng 20:00→08:00 chạm trọn một khung đêm = 480 phút', () => {
    // Ca này dài hơn một khung đêm nhưng chỉ chạm MỘT khung (22:00 D → 06:00 D+1).
    // Nếu hàm quét khoảng đêm bị đếm trùng thì số này sẽ thành 960.
    const r = resolveShift(
      { code: 'X', name: 'X', type: 'NIGHT_CROSS_DAY', segments: [{ name: 'a', start: '20:00', end: '08:00' }] },
      D,
    );
    expect(r.totalNetMinutes).toBe(720);
    expect(r.nightMinutes).toBe(480);
  });

  it('nightOverlapMinutes: khoảng không chạm đêm → 0', () => {
    expect(nightOverlapMinutes(480, 1020, 1320, 360)).toBe(0); // 08:00→17:00
  });

  it('nightOverlapMinutes: khoảng rỗng hoặc ngược → 0, không ném', () => {
    expect(nightOverlapMinutes(600, 600, 1320, 360)).toBe(0);
    expect(nightOverlapMinutes(600, 300, 1320, 360)).toBe(0);
  });

  it('khung đêm có thể đổi — 23:00→05:00 thì ca 22:00→06:00 chỉ còn 6 tiếng đêm', () => {
    const r = resolveShift({ ...NIGHT, nightStart: '23:00', nightEnd: '05:00' }, D);
    expect(r.nightMinutes).toBe(360);
    expect(r.nightStartMin).toBe(1380);
    expect(r.nightEndMin).toBe(300);
  });
});

describe('dữ liệu ca sai phải bị chặn', () => {
  it('hai đoạn chồng lấn → lỗi (nếu không thì giờ công bị đếm hai lần)', () => {
    expect(() =>
      resolveShift(
        {
          code: 'X',
          name: 'X',
          type: 'SPLIT',
          segments: [
            { name: 'a', start: '08:00', end: '13:00' },
            { name: 'b', start: '12:00', end: '17:00' },
          ],
        },
        D,
      ),
    ).toThrowError(ShiftError);
    try {
      resolveShift(
        {
          code: 'X',
          name: 'X',
          type: 'SPLIT',
          segments: [
            { name: 'a', start: '08:00', end: '13:00' },
            { name: 'b', start: '12:00', end: '17:00' },
          ],
        },
        D,
      );
    } catch (e) {
      expect((e as ShiftError).code).toBe('SEGMENTS_OVERLAP');
    }
  });

  it('hai đoạn CHẠM nhau nhưng không đè thì được phép', () => {
    // 12:00 kết thúc và 12:00 bắt đầu là hợp lệ — ranh giới nửa mở [vào, ra).
    const r = resolveShift(
      {
        code: 'X',
        name: 'X',
        type: 'SPLIT',
        segments: [
          { name: 'a', start: '08:00', end: '12:00' },
          { name: 'b', start: '12:00', end: '16:00' },
        ],
      },
      D,
    );
    expect(r.totalNetMinutes).toBe(480);
  });

  it('giờ nghỉ >= thời lượng đoạn → lỗi', () => {
    try {
      resolveShift(
        { code: 'X', name: 'X', type: 'OFFICE', segments: [{ name: 'a', start: '08:00', end: '09:00', breakMinutes: 60 }] },
        D,
      );
      throw new Error('đáng lẽ phải ném');
    } catch (e) {
      expect((e as ShiftError).code).toBe('BREAK_EXCEEDS_SEGMENT');
    }
  });

  it('khai rõ endDayOffset=0 mà giờ ra không sau giờ vào → lỗi, không tự đoán', () => {
    try {
      resolveShift(
        { code: 'X', name: 'X', type: 'OFFICE', segments: [{ name: 'a', start: '22:00', end: '06:00', endDayOffset: 0 }] },
        D,
      );
      throw new Error('đáng lẽ phải ném');
    } catch (e) {
      expect((e as ShiftError).code).toBe('SEGMENT_NOT_POSITIVE');
    }
  });

  it('ca không có đoạn nào → lỗi', () => {
    try {
      resolveShift({ code: 'X', name: 'X', type: 'OFFICE', segments: [] }, D);
      throw new Error('đáng lẽ phải ném');
    } catch (e) {
      expect((e as ShiftError).code).toBe('NO_SEGMENTS');
    }
  });

  it('giờ sai định dạng → RangeError, không trả 0 âm thầm', () => {
    // Trả 0 sẽ biến giờ vào thành 00:00 và sinh ra ca 24 tiếng.
    expect(() => parseTimeOfDay('8h00')).toThrow(RangeError);
    expect(() => parseTimeOfDay('25:00')).toThrow(RangeError);
    expect(() => parseTimeOfDay('24:01')).toThrow(RangeError);
  });
});

describe('khung giờ nghỉ', () => {
  const withBreak = (over: Record<string, unknown> = {}) =>
    resolveShift(
      {
        code: 'HC',
        name: 'Hành chính',
        type: 'OFFICE',
        segments: [
          { name: 'a', start: '08:00', end: '17:00', breakStart: '12:00', breakEnd: '13:00', ...over },
        ],
      },
      D,
    );

  it('có khung thì suy thời lượng từ khung', () => {
    const r = withBreak();
    expect(r.segments[0]!.breakMinutes).toBe(60);
    expect(r.segments[0]!.breakAbsStart).toBe(12 * 60);
    expect(r.segments[0]!.breakAbsEnd).toBe(13 * 60);
    expect(r.totalNetMinutes).toBe(480);
  });

  it('breakMinutes khớp với khung thì được chấp nhận', () => {
    expect(withBreak({ breakMinutes: 60 }).segments[0]!.breakMinutes).toBe(60);
  });

  it('breakMinutes LỆCH khung → lỗi, không âm thầm chọn một', () => {
    // Hai con số mô tả cùng một sự thật; chọn im lặng một cái thì giờ công sẽ
    // sai mà không có gì báo.
    try {
      withBreak({ breakMinutes: 45 });
      throw new Error('đáng lẽ phải ném');
    } catch (e) {
      expect((e as ShiftError).code).toBe('BREAK_MISMATCH');
    }
  });

  it('chỉ khai một đầu khung → lỗi', () => {
    try {
      withBreak({ breakEnd: undefined });
      throw new Error('đáng lẽ phải ném');
    } catch (e) {
      expect((e as ShiftError).code).toBe('BREAK_WINDOW_INCOMPLETE');
    }
  });

  it('khung nghỉ nằm ngoài đoạn giờ → lỗi', () => {
    try {
      resolveShift(
        {
          code: 'X',
          name: 'X',
          type: 'OFFICE',
          segments: [{ name: 'a', start: '08:00', end: '12:00', breakStart: '13:00', breakEnd: '14:00' }],
        },
        D,
      );
      throw new Error('đáng lẽ phải ném');
    } catch (e) {
      expect((e as ShiftError).code).toBe('BREAK_OUTSIDE_SEGMENT');
    }
  });

  it('không khai khung thì breakAbs là null — engine chấm công sẽ trừ trọn', () => {
    const r = resolveShift(OFFICE, D); // OFFICE chỉ có breakMinutes: 60
    expect(r.segments[0]!.breakAbsStart).toBeNull();
    expect(r.segments[0]!.breakAbsEnd).toBeNull();
    expect(r.segments[0]!.breakMinutes).toBe(60);
  });

  it('ca seed HC có khung nghỉ 12:00–13:00', () => {
    const hc = SEED_SHIFTS_VN.find((s) => s.regimeCode === 'HC')!;
    expect(hc.segments[0]!.breakStart).toBe('12:00');
    expect(hc.segments[0]!.breakEnd).toBe('13:00');
  });
});

describe('absToCalendar — phút tuyệt đối ra ngày lịch', () => {
  it('phút < 1440 nằm cùng ngày', () => {
    expect(absToCalendar(D, 1320)).toEqual({ date: D, minutes: 1320 });
  });

  it('phút >= 1440 nằm ngày hôm sau', () => {
    expect(absToCalendar(D, 1800)).toEqual({ date: '2026-09-16', minutes: 360 });
  });

  it('khớp với kết quả resolveShift của ca đêm', () => {
    const r = resolveShift(NIGHT, D);
    expect(absToCalendar(D, r.absEnd)).toEqual({ date: r.endDate, minutes: 360 });
  });
});

// ---------------------------------------------------------------------------

const ROT: RotationDef = {
  code: 'ROT_3CA4KIP',
  name: 'Xoay 3 ca 4 kíp',
  cycleLength: 8,
  pattern: ['CA1', 'CA1', 'CA2', 'CA2', 'CA3', 'CA3', 'REST', 'REST'],
};

describe('xoay 3 ca 4 kíp', () => {
  it('ngày neo: kíp 0 làm CA1, ba kíp còn lại lệch pha 2 ngày', () => {
    // Tính tay, không đoán: idx = ((0 - teamIndex*2) % 8 + 8) % 8
    //   kíp 0 → idx 0 → CA1     kíp 2 → idx 4 → CA3
    //   kíp 1 → idx 6 → REST    kíp 3 → idx 2 → CA2
    // Bản test đầu tiên tôi điền CA1/CA3/CA2/null theo cảm tính và sai hai vị
    // trí — engine đúng, test sai. Bài học: với phép modulo thì phải tính ra giấy.
    expect(resolveRotationShiftCode(D, D, 0, ROT)).toBe('CA1');
    expect(resolveRotationShiftCode(D, D, 1, ROT)).toBeNull();
    expect(resolveRotationShiftCode(D, D, 2, ROT)).toBe('CA3');
    expect(resolveRotationShiftCode(D, D, 3, ROT)).toBe('CA2');
  });

  it('BẤT BIẾN: mỗi ngày đúng một kíp/ca, một kíp nghỉ', () => {
    // Đây là lý do tồn tại của hệ 3 ca 4 kíp: nhà máy chạy liên tục 24/7 nhưng
    // không ai phải làm hai ca liền. Nếu bất biến này vỡ thì lịch xoay sai.
    for (let i = 0; i < 40; i += 1) {
      const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      const codes = [0, 1, 2, 3].map((t) => resolveRotationShiftCode(day, D, t, ROT));
      const working = codes.filter((c) => c !== null);
      expect(working.length, `ngày ${day}`).toBe(3);
      expect(new Set(working).size, `ngày ${day} có ca trùng`).toBe(3);
      expect(working.sort().join(','), `ngày ${day}`).toBe('CA1,CA2,CA3');
    }
  });

  it('ngày nghỉ trả null chứ không phải chuỗi "REST"', () => {
    // Chuỗi 'REST' mà lọt xuống tầng xếp ca sẽ thành một ca có thật tên là REST.
    const rests = [0, 1, 2, 3]
      .map((t) => resolveRotationShiftCode(D, D, t, ROT))
      .filter((c) => c === null);
    expect(rests.length).toBe(1);
  });

  it('workDate TRƯỚC ngày neo vẫn đúng (modulo âm)', () => {
    // `%` của JS giữ dấu số bị chia, nên thiếu xử lý sẽ ra index âm và
    // pattern[-2] === undefined — tức là im lặng trả null và cả kíp được nghỉ
    // oan trong quá khứ.
    //
    // Không đoán trước mã ca ở đây (kíp 0 nghỉ ngày đó là hợp lệ). Bất biến cần
    // giữ là TÍNH TUẦN HOÀN: lùi hay tiến đúng một chu kỳ thì kết quả phải giống
    // nhau, kể cả khi đi ngược qua ngày neo.
    const before = '2026-09-13'; // D - 2
    expect(diffDays(before, D)).toBe(-2);
    for (let t = 0; t < 4; t += 1) {
      const past = resolveRotationShiftCode(before, D, t, ROT);
      const oneCycleLater = resolveRotationShiftCode('2026-09-21', D, t, ROT); // before + 8
      expect(oneCycleLater, `kíp ${t}`).toBe(past);
      expect(past === null || ['CA1', 'CA2', 'CA3'].includes(past), `kíp ${t}`).toBe(true);
    }
  });

  it('chu kỳ lặp lại đúng sau cycleLength ngày', () => {
    for (let t = 0; t < 4; t += 1) {
      const a = resolveRotationShiftCode(D, D, t, ROT);
      const b = resolveRotationShiftCode('2026-09-23', D, t, ROT); // D + 8
      expect(b, `kíp ${t}`).toBe(a);
    }
  });

  it('đổi mã nghỉ và bước lệch pha qua tham số', () => {
    const custom: RotationDef = {
      code: 'CUSTOM',
      name: 'Tự đặt',
      cycleLength: 4,
      pattern: ['SANG', 'CHIEU', 'NGHI', 'NGHI'],
      restCode: 'NGHI',
      phaseStep: 1,
    };
    expect(resolveRotationShiftCode(D, D, 0, custom)).toBe('SANG');
    expect(resolveRotationShiftCode(D, D, 2, custom)).toBeNull();
    expect(resolveRotationShiftCode('2026-09-16', D, 0, custom)).toBe('CHIEU');
  });

  it('pattern sai độ dài so với cycleLength → lỗi, không im lặng xoay lệch', () => {
    try {
      resolveRotationShiftCode(D, D, 0, { ...ROT, cycleLength: 7 });
      throw new Error('đáng lẽ phải ném');
    } catch (e) {
      expect((e as ShiftError).code).toBe('PATTERN_LENGTH_MISMATCH');
    }
  });

  it('teamIndex âm hoặc không nguyên → lỗi', () => {
    expect(() => resolveRotationShiftCode(D, D, -1, ROT)).toThrowError(ShiftError);
    expect(() => resolveRotationShiftCode(D, D, 1.5, ROT)).toThrowError(ShiftError);
  });
});

describe('tiện ích thời gian', () => {
  it('parse/format khứ hồi', () => {
    for (const s of ['00:00', '06:30', '13:45', '22:00', '23:59']) {
      expect(formatTimeOfDay(parseTimeOfDay(s))).toBe(s);
    }
  });

  it('formatTimeOfDay nhận phút >= 1440 và quy về trong ngày', () => {
    expect(formatTimeOfDay(1800)).toBe('06:00');
    expect(formatTimeOfDay(-60)).toBe('23:00');
  });

  it('toLocalMoment: 17:00 UTC là 00:00 hôm sau giờ VN', () => {
    const m = toLocalMoment('2026-09-15T17:00:00.000Z');
    expect(m.date).toBe('2026-09-16');
    expect(m.minutes).toBe(0);
  });

  it('toLocalMoment giữ giây — đây là bug đã sửa', () => {
    // Bản gốc chia giây cho 60000 nên kết quả luôn ~0. Đúng phải là 30/60 = 0.5.
    const m = toLocalMoment('2026-09-15T01:02:30.000Z');
    expect(m.minutes).toBeCloseTo(8 * 60 + 2 + 0.5, 6);
  });

  it('toLocalMoment với thời điểm rác → ném', () => {
    expect(() => toLocalMoment('không phải ngày')).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Loại chính sách SHIFT — định nghĩa ca là DỮ LIỆU trong database
// ---------------------------------------------------------------------------

import {
  shiftParamsSchema,
  shiftJsonSchema,
  SEED_SHIFTS_VN,
} from '../src/policy/shift-params';
import { expectSchemasAgree } from './helpers';

describe('policy kind SHIFT', () => {
  it('JSON Schema và Zod schema cùng tập trường và cùng danh sách bắt buộc', () => {
    // Hai mô tả này phải khớp tuyệt đối: form tự sinh từ JSON Schema, backend
    // validate bằng Zod. Lệch nhau thì form cho điền một trường mà backend từ
    // chối, hoặc ngược lại — và người dùng chỉ biết khi đã bấm lưu.
    const { jsonFields } = expectSchemasAgree(shiftJsonSchema, shiftParamsSchema);
    expect(jsonFields).toContain('segments');
  });

  it('mọi ca seed đều hợp lệ', () => {
    for (const s of SEED_SHIFTS_VN) {
      const r = shiftParamsSchema.safeParse(s);
      expect(r.success, `${s.regimeCode}: ${JSON.stringify(r.error?.issues ?? [])}`).toBe(true);
    }
  });

  it('ca đêm seed có đúng 8 giờ đêm — kiểm chứng chéo với engine', () => {
    const ca3 = SEED_SHIFTS_VN.find((s) => s.regimeCode === 'CA3')!;
    const r = resolveShift(
      {
        code: ca3.regimeCode,
        name: ca3.regimeLabel,
        type: ca3.shiftType,
        segments: ca3.segments,
        nightStart: ca3.nightStart,
        nightEnd: ca3.nightEnd,
        standardHours: null,
      },
      D,
    );
    expect(r.crossMidnight).toBe(true);
    expect(r.nightMinutes).toBe(480);
  });

  it('ba ca của hệ 3 ca 4 kíp phủ kín 24 giờ, không hở không đè', () => {
    // CA1 06–14, CA2 14–22, CA3 22–06. Tổng đúng 1440 phút và không khoảng hở:
    // nếu hở thì có khoảng thời gian không ai trực, nếu đè thì giờ công bị đếm hai lần.
    const codes = ['CA1', 'CA2', 'CA3'];
    let total = 0;
    const spans: Array<[number, number]> = [];
    for (const code of codes) {
      const s = SEED_SHIFTS_VN.find((x) => x.regimeCode === code)!;
      const r = resolveShift(
        { code: s.regimeCode, name: s.regimeLabel, type: s.shiftType, segments: s.segments, nightStart: s.nightStart, nightEnd: s.nightEnd, standardHours: null },
        D,
      );
      total += r.totalNetMinutes;
      spans.push([r.segments[0]!.startMin, r.segments[0]!.startMin + r.totalNetMinutes]);
    }
    expect(total).toBe(1440);
    expect(spans[1]![0]).toBe(spans[0]![1]); // CA2 vào đúng lúc CA1 ra
    expect(spans[2]![0]).toBe(spans[1]![1]); // CA3 vào đúng lúc CA2 ra
  });

  it('ca có hai đoạn CHỒNG LẤN bị từ chối ngay lúc lưu', () => {
    const r = shiftParamsSchema.safeParse({
      regimeCode: 'X',
      regimeLabel: 'Sai',
      shiftType: 'SPLIT',
      segments: [
        { name: 'a', start: '08:00', end: '13:00' },
        { name: 'b', start: '12:00', end: '17:00' },
      ],
    });
    expect(r.success).toBe(false);
    const msg = JSON.stringify(r.error?.issues ?? []);
    expect(msg).toContain('chồng lấn');
  });

  it('giờ nghỉ dài hơn đoạn bị từ chối', () => {
    const r = shiftParamsSchema.safeParse({
      regimeCode: 'X',
      regimeLabel: 'Sai',
      shiftType: 'OFFICE',
      segments: [{ name: 'a', start: '08:00', end: '09:00', breakMinutes: 90 }],
    });
    expect(r.success).toBe(false);
  });

  it('hai đoạn trùng tên bị từ chối', () => {
    const r = shiftParamsSchema.safeParse({
      regimeCode: 'X',
      regimeLabel: 'Sai',
      shiftType: 'SPLIT',
      segments: [
        { name: 'Ca', start: '08:00', end: '12:00' },
        { name: 'Ca', start: '14:00', end: '18:00' },
      ],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues ?? [])).toContain('trùng tên');
  });

  it('giờ sai định dạng bị từ chối ở cả hai schema', () => {
    const bad = {
      regimeCode: 'X',
      regimeLabel: 'Sai',
      shiftType: 'OFFICE',
      segments: [{ name: 'a', start: '8 giờ', end: '17:00' }],
    };
    expect(shiftParamsSchema.safeParse(bad).success).toBe(false);
  });

  it('mã ca chữ thường bị từ chối', () => {
    expect(
      shiftParamsSchema.safeParse({
        regimeCode: 'ca1',
        regimeLabel: 'x',
        shiftType: 'OFFICE',
        segments: [{ name: 'a', start: '08:00', end: '17:00' }],
      }).success,
    ).toBe(false);
  });

  it('không có .default() — trường bỏ trống là optional thật, không phải 0', () => {
    // endDayOffset mà có default(0) thì "ca đêm không khai offset" sẽ bị ép thành
    // "ra cùng ngày" và engine ném lỗi thay vì tự suy luận qua ngày.
    const parsed = shiftParamsSchema.parse({
      regimeCode: 'X',
      regimeLabel: 'x',
      shiftType: 'NIGHT_CROSS_DAY',
      segments: [{ name: 'a', start: '22:00', end: '06:00' }],
    });
    expect(parsed.segments[0]!.endDayOffset).toBeUndefined();
    expect(parsed.segments[0]!.breakMinutes).toBeUndefined();
  });
});
