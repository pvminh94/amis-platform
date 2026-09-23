/**
 * Test ghép cặp quẹt thẻ và tính công ngày.
 *
 * Nhóm quan trọng nhất là các ca THIẾU QUẸT và ca ĐÊM. Thiếu quẹt xảy ra hàng
 * ngày và cách xử lý nó quyết định lương của người ta; còn ca đêm thì giờ ra nằm
 * ở ngày hôm sau nên mọi so sánh naive đều sai.
 */

import { describe, it, expect } from 'vitest';
import {
  pairPunches,
  punchToAbsMinute,
  AttendanceError,
  DEFAULT_PAIRING_CONFIG,
  type PunchLike,
} from '../src/engine/attendance';
import { resolveShift } from '../src/engine/shift';

const D = '2026-09-15';
const M = 60; // đọc cho dễ: 8 * M = 08:00

const OFFICE = resolveShift(
  {
    code: 'HC',
    name: 'Hành chính',
    type: 'OFFICE',
    segments: [
      {
        name: 'Sáng-chiều',
        start: '08:00',
        end: '17:00',
        breakMinutes: 60,
        breakStart: '12:00',
        breakEnd: '13:00',
      },
    ],
  },
  D,
);
const NIGHT = resolveShift(
  {
    code: 'CA3',
    name: 'Ca đêm',
    type: 'NIGHT_CROSS_DAY',
    segments: [{ name: 'Ca đêm', start: '22:00', end: '06:00', endDayOffset: 1 }],
  },
  D,
);
const SPLIT = resolveShift(
  {
    code: 'GAY',
    name: 'Ca gãy',
    type: 'SPLIT',
    segments: [
      { name: 'Sáng', start: '08:00', end: '12:00' },
      { name: 'Chiều', start: '14:00', end: '18:00' },
    ],
  },
  D,
);

const at = (h: number, min = 0): PunchLike => ({ absMinute: h * M + min });

describe('ngày thường — đi đủ', () => {
  it('quẹt đúng giờ → PRESENT, 8 giờ công', () => {
    const r = pairPunches(OFFICE, [at(8), at(17)], 'WORKING_DAY');
    expect(r.status).toBe('PRESENT');
    expect(r.workedMinutes).toBe(480);
    expect(r.standardDays).toBe(1);
    expect(r.lateMinutes).toBe(0);
    expect(r.absentMinutes).toBe(0);
  });

  it('giờ nghỉ trưa không bị tính là giờ công', () => {
    // 08:00–17:00 là 540 phút, trừ 60 phút nghỉ = 480
    const r = pairPunches(OFFICE, [at(8), at(17)], 'WORKING_DAY');
    expect(OFFICE.absEnd - OFFICE.absStart).toBe(540);
    expect(r.workedMinutes).toBe(480);
  });

  it('đến sớm và về muộn KHÔNG tự thành giờ công chính', () => {
    // Nếu cộng thẳng thì người hay đến sớm sẽ có lương cao hơn người đúng giờ.
    // Phần dư phải nằm ở OT, không nằm ở workedMinutes.
    const r = pairPunches(OFFICE, [at(7), at(18)], 'WORKING_DAY');
    expect(r.workedMinutes).toBe(480);
    expect(r.otWeekdayMinutes).toBe(120); // 07–08 và 17–18
  });

  it('làm nửa buổi KHÔNG bị trừ giờ nghỉ trưa mà họ không nghỉ', () => {
    // 08:00–11:00 = 180 phút, không chạm khung nghỉ 12:00–13:00.
    // Bản trước trừ trọn 60 phút nên 3 giờ làm chỉ còn 2 giờ công.
    const r = pairPunches(OFFICE, [at(8), at(11)], 'WORKING_DAY');
    expect(r.workedMinutes).toBe(180);
    expect(r.status).toBe('HALF_DAY');
  });

  it('làm vắt qua khung nghỉ thì bị trừ đúng phần giao', () => {
    // 08:00–14:00 chạm khung 12:00–13:00 → trừ 60
    expect(pairPunches(OFFICE, [at(8), at(14)], 'WORKING_DAY').workedMinutes).toBe(300);
    // 08:00–12:30 chạm nửa khung → trừ 30
    expect(pairPunches(OFFICE, [at(8), at(12, 30)], 'WORKING_DAY').workedMinutes).toBe(240);
  });

  it('không có quẹt nào → ABSENT', () => {
    const r = pairPunches(OFFICE, [], 'WORKING_DAY');
    expect(r.status).toBe('ABSENT');
    expect(r.workedMinutes).toBe(0);
  });
});

describe('đi trễ và grace period', () => {
  it('trễ trong grace 10 phút → vẫn PRESENT, không phạt, nhưng CÓ cảnh báo', () => {
    const r = pairPunches(OFFICE, [at(8, 8), at(17)], 'WORKING_DAY');
    expect(r.status).toBe('PRESENT');
    expect(r.lateMinutes).toBe(0);
    // Im lặng bỏ qua thì không ai biết có chuyện gì; cảnh báo để HR thấy.
    expect(r.warnings.some((w) => w.includes('grace period'))).toBe(true);
  });

  it('trễ quá grace → LATE và đếm đủ số phút', () => {
    const r = pairPunches(OFFICE, [at(8, 25), at(17)], 'WORKING_DAY');
    expect(r.status).toBe('LATE');
    expect(r.lateMinutes).toBe(25);
  });

  it('trễ 130 phút → HALF_DAY (vượt ngưỡng 120)', () => {
    const r = pairPunches(OFFICE, [at(10, 10), at(17)], 'WORKING_DAY');
    expect(r.status).toBe('HALF_DAY');
  });

  it('trễ 250 phút → ABSENT (vượt ngưỡng 240)', () => {
    const r = pairPunches(OFFICE, [at(12, 10), at(17)], 'WORKING_DAY');
    expect(r.status).toBe('ABSENT');
  });

  it('ngưỡng đổi được qua tham số', () => {
    const punches = [at(10, 10), at(17)];
    // Mặc định: trễ 130' → HALF_DAY
    expect(pairPunches(OFFICE, punches, 'WORKING_DAY').status).toBe('HALF_DAY');
    // Nới ngưỡng lên 200' thì cùng bộ quẹt đó chỉ còn LATE
    expect(
      pairPunches(OFFICE, punches, 'WORKING_DAY', { halfDayAfterLateMin: 200 }).status,
    ).toBe('LATE');
  });

  it('làm thiếu quá nửa kế hoạch → HALF_DAY', () => {
    // Vào đúng giờ nhưng ra lúc 11:00 → chỉ 180' trên 480' kế hoạch
    const r = pairPunches(OFFICE, [at(8), at(11)], 'WORKING_DAY');
    expect(r.workedMinutes).toBe(180);
    expect(r.status).toBe('HALF_DAY');
  });

  it('về sớm bị đếm', () => {
    const r = pairPunches(OFFICE, [at(8), at(16)], 'WORKING_DAY');
    expect(r.earlyLeaveMinutes).toBe(60);
  });
});

describe('thiếu quẹt — suy ra nhưng phải đánh dấu', () => {
  it('thiếu quẹt VÀO → giờ vào lấy theo kế hoạch, nguồn INFERRED, trạng thái MISSING_PUNCH', () => {
    // CHỈ MỘT quẹt: hai quẹt thì theo FIRST-IN/LAST-OUT quẹt đầu đã là giờ vào.
    const r = pairPunches(OFFICE, [at(17)], 'WORKING_DAY');
    const s = r.segments[0]!;
    expect(s.missingIn).toBe(true);
    expect(s.inSource).toBe('INFERRED');
    expect(s.actualIn).toBe(8 * M);
    expect(r.status).toBe('MISSING_PUNCH');
    expect(r.warnings.some((w) => w.includes('thiếu quẹt VÀO'))).toBe(true);
  });

  it('thiếu quẹt RA → giờ ra lấy theo kế hoạch, nguồn INFERRED', () => {
    const r = pairPunches(OFFICE, [at(8)], 'WORKING_DAY');
    const s = r.segments[0]!;
    expect(s.missingOut).toBe(true);
    expect(s.outSource).toBe('INFERRED');
    expect(s.actualOut).toBe(17 * M);
    expect(r.status).toBe('MISSING_PUNCH');
  });

  it('quẹt từ đơn giải trình được ghi nguồn REGULARIZATION và đếm phút bù', () => {
    const r = pairPunches(
      OFFICE,
      [{ absMinute: 8 * M, isRegularization: true }, { absMinute: 17 * M, isRegularization: true }],
      'WORKING_DAY',
    );
    expect(r.segments[0]!.inSource).toBe('REGULARIZATION');
    expect(r.regularizedMinutes).toBe(480);
  });
});

describe('ca đêm vắt 0h', () => {
  it('quẹt 22:00 và 06:00 hôm sau → 8 giờ, cả 8 giờ là giờ đêm', () => {
    const r = pairPunches(NIGHT, [at(22), at(30)], 'WORKING_DAY'); // 30h = 06:00 hôm sau
    expect(r.status).toBe('PRESENT');
    expect(r.workedMinutes).toBe(480);
    expect(r.nightMinutes).toBe(480);
  });

  it('phút tuyệt đối của quẹt 06:00 hôm sau là 1800, lớn hơn 1320 của 22:00', () => {
    // Đây là lý do cả hệ thống dùng phút tuyệt đối: so bằng "giờ trong ngày"
    // thì 06:00 < 22:00 và ca đêm sẽ có giờ ra TRƯỚC giờ vào.
    expect(at(30).absMinute).toBe(1800);
    expect(at(30).absMinute).toBeGreaterThan(at(22).absMinute);
  });

  it('ca đêm về lúc 04:00 → thiếu 2 giờ, đếm về sớm', () => {
    const r = pairPunches(NIGHT, [at(22), at(28)], 'WORKING_DAY'); // 28h = 04:00
    expect(r.workedMinutes).toBe(360);
    expect(r.nightMinutes).toBe(360);
    expect(r.earlyLeaveMinutes).toBe(120);
  });

  it('OT ca đêm 06:00→08:00 KHÔNG phải giờ đêm', () => {
    // Khung đêm kết thúc 06:00, nên 2 tiếng ở lại sau đó là OT ngày thường.
    const r = pairPunches(NIGHT, [at(22), at(32)], 'WORKING_DAY'); // 32h = 08:00
    expect(r.otWeekdayMinutes).toBe(120);
    expect(r.otNightMinutes).toBe(0);
  });

  it('OT ca đêm 04:00→06:00 CÓ giờ đêm', () => {
    // Vào sớm 20:00, làm tới 06:00: phần 20:00–22:00 là OT ngoài khung đêm.
    const r = pairPunches(NIGHT, [at(20), at(30)], 'WORKING_DAY');
    expect(r.otWeekdayMinutes).toBe(120);
    expect(r.otNightMinutes).toBe(0);
  });
});

describe('ca gãy và suy luận chéo đoạn', () => {
  it('quẹt đủ 4 lần → hai đoạn, 8 giờ công', () => {
    const r = pairPunches(SPLIT, [at(8), at(12), at(14), at(18)], 'WORKING_DAY');
    expect(r.status).toBe('PRESENT');
    expect(r.segments.length).toBe(2);
    expect(r.workedMinutes).toBe(480);
  });

  it('quên quẹt lúc đổi đoạn → suy giờ RA của đoạn trước từ quẹt VÀO đoạn sau', () => {
    // Chỉ quẹt 3 lần: 08:00, 14:00, 18:00 (quên quẹt ra lúc 12:00)
    const r = pairPunches(SPLIT, [at(8), at(14), at(18)], 'WORKING_DAY');
    const morning = r.segments[0]!;
    expect(morning.missingOut).toBe(false);
    expect(morning.outSource).toBe('INFERRED');
    expect(morning.actualOut).toBe(12 * M); // kẹp về giờ kế hoạch, không phải 14:00
    expect(morning.workedMinutes).toBe(240);
    expect(r.warnings.some((w) => w.includes('suy giờ RA'))).toBe(true);
  });

  it('quẹt được gán vào đoạn gần điểm giữa nhất', () => {
    // 13:30 gần đoạn Chiều (điểm giữa 16:00) hơn đoạn Sáng (điểm giữa 10:00)
    const r = pairPunches(SPLIT, [at(8), at(12), at(13, 30), at(18)], 'WORKING_DAY');
    expect(r.segments[1]!.actualIn).toBe(13 * M + 30);
  });

  it('quẹt đúng giữa hai đoạn thì về đoạn TRƯỚC — quy ước có chủ đích', () => {
    // 13:00 cách đều điểm giữa của Sáng (10:00) và Chiều (16:00) — đúng 180 phút
    // mỗi bên. Khi hoà thì giữ đoạn đầu tiên, vì gán về đoạn sau sẽ khiến đoạn
    // trước thiếu quẹt RA và bị suy giờ một cách không cần thiết.
    const r = pairPunches(SPLIT, [at(8), at(12), at(13), at(18)], 'WORKING_DAY');
    expect(r.segments[0]!.actualOut).toBe(13 * M);
    expect(r.segments[1]!.actualIn).toBe(14 * M);
  });
});

describe('làm thêm giờ', () => {
  it('ở lại 2 tiếng → 120 phút OT ngày thường', () => {
    const r = pairPunches(OFFICE, [at(8), at(19)], 'WORKING_DAY');
    expect(r.otWeekdayMinutes).toBe(120);
    expect(r.otWeekendMinutes).toBe(0);
    expect(r.otHolidayMinutes).toBe(0);
  });

  it('hai khoảng OT gối nhau được GỘP, không đếm trùng', () => {
    // Đến sớm 07:00 và ở lại 18:00 trên ca 08:00–17:00: hai khoảng rời nhau.
    const r = pairPunches(OFFICE, [at(7), at(18)], 'WORKING_DAY');
    expect(r.otWeekdayMinutes).toBe(120);
  });

  it('OT ≥ 4 giờ thì cảnh báo giới hạn 40h/tháng', () => {
    const r = pairPunches(OFFICE, [at(8), at(21)], 'WORKING_DAY');
    expect(r.otWeekdayMinutes).toBe(240);
    expect(r.warnings.some((w) => w.includes('40h/tháng'))).toBe(true);
  });

  it('OT dưới 4 giờ thì không cảnh báo', () => {
    const r = pairPunches(OFFICE, [at(8), at(19)], 'WORKING_DAY');
    expect(r.warnings.some((w) => w.includes('40h/tháng'))).toBe(false);
  });
});

describe('ngày nghỉ và ngày lễ — mọi giờ đều là OT', () => {
  it('nghỉ hằng tuần không đi làm → WEEKLY_OFF, không phải ABSENT', () => {
    const r = pairPunches(OFFICE, [], 'WEEKLY_REST');
    expect(r.status).toBe('WEEKLY_OFF');
    expect(r.absentMinutes).toBe(0);
  });

  it('ngày lễ không đi làm → HOLIDAY_OFF', () => {
    expect(pairPunches(OFFICE, [], 'PUBLIC_HOLIDAY').status).toBe('HOLIDAY_OFF');
  });

  it('đi làm ngày nghỉ → PRESENT, toàn bộ là OT cuối tuần, công chính = 0', () => {
    const r = pairPunches(OFFICE, [at(8), at(17)], 'WEEKLY_REST');
    expect(r.status).toBe('PRESENT');
    expect(r.otWeekendMinutes).toBe(540); // không trừ nghỉ vì không có ca kế hoạch
    expect(r.standardDays).toBe(0); // nếu tính thì sẽ trả lương hai lần
    expect(r.otWeekdayMinutes).toBe(0);
  });

  it('đi làm ngày lễ → OT 300%, không phải OT cuối tuần', () => {
    const r = pairPunches(OFFICE, [at(8), at(17)], 'PUBLIC_HOLIDAY');
    expect(r.otHolidayMinutes).toBe(540);
    expect(r.otWeekendMinutes).toBe(0);
  });
});

describe('lọc quẹt ngoài cửa sổ', () => {
  it('quẹt lúc 03:00 không thuộc ca 08:00 → bị loại', () => {
    // Nếu cứ ghép thì giờ vào thành 03:00 và người đó "đến sớm 5 tiếng".
    const r = pairPunches(OFFICE, [at(3), at(8), at(17)], 'WORKING_DAY');
    expect(r.rejectedPunches).toEqual([3 * M]);
    expect(r.segments[0]!.actualIn).toBe(8 * M);
  });

  it('cửa sổ mở được qua tham số', () => {
    const r = pairPunches(OFFICE, [at(3), at(8), at(17)], 'WORKING_DAY', {
      windowBeforeMin: 360,
    });
    expect(r.rejectedPunches).toEqual([]);
    expect(r.segments[0]!.actualIn).toBe(3 * M);
  });
});

describe('dữ liệu và cấu hình sai phải bị chặn', () => {
  it('absMinute là NaN → ném, không trả ngày công 0 phút', () => {
    // Math.max(0, NaN) là NaN và lan ra mọi phép tính mà không kêu.
    expect(() =>
      pairPunches(OFFICE, [{ absMinute: Number.NaN }, at(17)], 'WORKING_DAY'),
    ).toThrowError(AttendanceError);
  });

  it('ngưỡng âm → ném', () => {
    expect(() => pairPunches(OFFICE, [at(8), at(17)], 'WORKING_DAY', { graceMinutes: -5 })).toThrowError(
      AttendanceError,
    );
  });

  it('standardDayHours = 0 → ném (nếu không thì standardDays thành Infinity)', () => {
    expect(() =>
      pairPunches(OFFICE, [at(8), at(17)], 'WORKING_DAY', { standardDayHours: 0 }),
    ).toThrowError(AttendanceError);
  });

  it('halfDayWorkedRatio ngoài (0,1] → ném', () => {
    expect(() =>
      pairPunches(OFFICE, [at(8), at(17)], 'WORKING_DAY', { halfDayWorkedRatio: 1.5 }),
    ).toThrowError(AttendanceError);
  });
});

describe('punchToAbsMinute', () => {
  it('quẹt cùng ngày → phút trong ngày', () => {
    expect(punchToAbsMinute({ date: D, minutes: 8 * M }, D)).toBe(480);
  });

  it('quẹt 06:00 hôm sau của ca đêm → 1800', () => {
    expect(punchToAbsMinute({ date: '2026-09-16', minutes: 6 * M }, D)).toBe(1800);
  });

  it('quẹt hôm TRƯỚC (đến sớm qua đêm) → số âm, vẫn so sánh được', () => {
    expect(punchToAbsMinute({ date: '2026-09-14', minutes: 23 * M }, D)).toBe(-60);
  });

  it('ngày sai → ném', () => {
    expect(() => punchToAbsMinute({ date: 'không phải ngày', minutes: 0 }, D)).toThrowError(
      AttendanceError,
    );
  });
});

describe('giá trị mặc định', () => {
  it('grace 10 phút, cửa sổ 180/240, chuẩn 8 giờ', () => {
    expect(DEFAULT_PAIRING_CONFIG.graceMinutes).toBe(10);
    expect(DEFAULT_PAIRING_CONFIG.windowBeforeMin).toBe(180);
    expect(DEFAULT_PAIRING_CONFIG.windowAfterMin).toBe(240);
    expect(DEFAULT_PAIRING_CONFIG.standardDayHours).toBe(8);
    expect(DEFAULT_PAIRING_CONFIG.halfDayWorkedRatio).toBe(0.5);
  });
});
