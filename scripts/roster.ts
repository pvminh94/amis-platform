/**
 * ============================================================================
 * DANH SÁCH NHÂN VIÊN MẪU — một sự thật, một nơi
 * ============================================================================
 *
 * Tách ra khỏi run-payroll.ts vì HAI script cần nó: `seed:employees` (tạo nhân
 * viên) và `payroll` (tính lương). Trước đây chỉ payroll có, nên thứ tự seed bị
 * khoá cứng: seed:attendance cần nhân viên, mà nhân viên lại do payroll tạo,
 * payroll lại cần chấm công — một vòng phụ thuộc khiến `npm run seed:all` trên
 * DB trắng không thể chạy đúng thứ tự.
 *
 * Không copy danh sách này sang chỗ khác. Hai bản sao của cùng một roster là
 * hai bản sẽ lệch nhau.
 */

/** 12 nhân viên, 4 vùng lương, 6 bộ phận — đủ để trần/sàn bảo hiểm có tác dụng. */
export const ROSTER = [
  { employeeCode: 'NV001', fullName: 'Nguyễn Văn An', department: 'Kỹ thuật', wageRegion: 'I', trainedWorker: true, dependents: 1, baseSalary: 25_000_000, hourlyRate: 120_000 },
  { employeeCode: 'NV002', fullName: 'Trần Thị Bình', department: 'Kỹ thuật', wageRegion: 'I', trainedWorker: true, dependents: 2, baseSalary: 32_000_000, hourlyRate: 155_000 },
  { employeeCode: 'NV003', fullName: 'Lê Văn Cường', department: 'Kinh doanh', wageRegion: 'I', trainedWorker: false, dependents: 0, baseSalary: 18_000_000, hourlyRate: 87_000 },
  { employeeCode: 'NV004', fullName: 'Phạm Thị Dung', department: 'Kinh doanh', wageRegion: 'II', trainedWorker: true, dependents: 3, baseSalary: 22_000_000, hourlyRate: 106_000 },
  { employeeCode: 'NV005', fullName: 'Hoàng Văn Em', department: 'Nhân sự', wageRegion: 'I', trainedWorker: true, dependents: 1, baseSalary: 28_000_000, hourlyRate: 135_000 },
  { employeeCode: 'NV006', fullName: 'Vũ Thị Giang', department: 'Kế toán', wageRegion: 'I', trainedWorker: true, dependents: 2, baseSalary: 26_000_000, hourlyRate: 125_000 },
  { employeeCode: 'NV007', fullName: 'Đặng Văn Hải', department: 'Sản xuất', wageRegion: 'III', trainedWorker: false, dependents: 4, baseSalary: 12_000_000, hourlyRate: 58_000 },
  { employeeCode: 'NV008', fullName: 'Bùi Thị Hoa', department: 'Sản xuất', wageRegion: 'III', trainedWorker: true, dependents: 1, baseSalary: 14_500_000, hourlyRate: 70_000 },
  { employeeCode: 'NV009', fullName: 'Đỗ Văn Inh', department: 'Sản xuất', wageRegion: 'IV', trainedWorker: false, dependents: 0, baseSalary: 9_000_000, hourlyRate: 43_000 },
  { employeeCode: 'NV010', fullName: 'Ngô Thị Kim', department: 'Kỹ thuật', wageRegion: 'I', trainedWorker: true, dependents: 0, baseSalary: 45_000_000, hourlyRate: 216_000 },
  { employeeCode: 'NV011', fullName: 'Lý Văn Long', department: 'Kinh doanh', wageRegion: 'II', trainedWorker: false, dependents: 2, baseSalary: 16_000_000, hourlyRate: 77_000 },
  { employeeCode: 'NV012', fullName: 'Trịnh Thị Mai', department: 'Nhân sự', wageRegion: 'IV', trainedWorker: true, dependents: 1, baseSalary: 11_000_000, hourlyRate: 53_000 },
] as const;

/**
 * Số thẻ / PIN của từng người TRÊN MÁY CHẤM CÔNG.
 *
 * Cố ý KHÁC mã nhân sự (NV001 → 1001): máy được cấu hình từ nhiều năm trước với
 * dãy PIN riêng, còn mã nhân sự đổi theo đợt tái cấu trúc. Ép hai số trùng nhau
 * nghĩa là mỗi lần đổi mã nhân sự phải đi nạp lại vân tay cho cả công ty.
 *
 * NV011 và NV012 cố ý KHÔNG có trong map — để nhánh "số thẻ không khớp ai" và
 * nhánh "nhân viên chưa gán số thẻ" đều có dữ liệu thật đi qua.
 */
export const DEVICE_PINS: Record<string, string> = {
  NV001: '1001', NV002: '1002', NV003: '1003', NV004: '1004',
  NV005: '1005', NV006: '1006', NV007: '1007', NV008: '1008',
  NV009: '1009', NV010: '1010',
};

/** Khoá webhook cho từng máy. Ở hệ thống thật: sinh ngẫu nhiên, không commit. */
export const DEVICE_WEBHOOK_KEYS: Record<string, string> = {
  'DEV-GATE-01': 'whk_gate01_demo_2026',
  'DEV-XUONG-02': 'whk_xuong02_demo_2026',
  'DEV-MOBILE': 'whk_mobile_demo_2026',
};

/**
 * KPI và tạm ứng KHÔNG nằm trong bảng chấm công — chúng đến từ đánh giá năng
 * lực và từ kế toán. Ở hệ thống thật hai module đó cấp; trong demo để số cố
 * định và ghi rõ, chứ không trộn lẫn với dữ liệu chấm công thật.
 */
export const OTHER: Record<string, { kpiScore: number; advanceAmount: number }> = {
  NV001: { kpiScore: 85, advanceAmount: 2_000_000 },
  NV002: { kpiScore: 95, advanceAmount: 0 },
  NV003: { kpiScore: 60, advanceAmount: 0 },
  NV010: { kpiScore: 100, advanceAmount: 0 },
};
