/**
 * Kiểm tra dạng UUID TRƯỚC khi đưa vào truy vấn.
 *
 * Không kiểm tra thì một id rác như `/approvals/khong-ton-tai` làm PostgreSQL
 * ném `22P02 invalid input syntax for type uuid`, và người dùng nhận 500 thay vì
 * 404. Đây không phải chuyện thẩm mỹ: 500 nghĩa là "server hỏng", 404 nghĩa là
 * "không có cái đó" — hai thông báo khác nhau dẫn người dùng tới hai hành động
 * khác nhau, và log 500 sẽ che mất lỗi thật.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
