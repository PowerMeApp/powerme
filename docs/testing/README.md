# Test case Report 5 trong repo (T112)

## Nguồn

`report5-test-cases.csv` là danh sách 119 test case của Report 5, chép từ
`Report5_Test Report - PowerMe.xlsx` trên Drive, **bản 10/11/2026**.

| Cột | Ý nghĩa |
|---|---|
| `id` | Mã ca, ghi đúng như Report 5 (vd. `TC-F06-01`, `TC-STM3-1`, `TC-STM6-t1`) |
| `sheet` | Sheet trong file Excel |
| `owner` | Người phụ trách ca |
| `run` | `CI`: test tự động; `Man`: chạy tay; `Stg`: chạy trên staging |
| `title` | Tên ca trong Report 5 |

Cam kết: **73** ca `CI` có test tự động (trong 110 ca `CI`, 119 ca tổng).

## Đếm số ca

```sh
npm run tc:coverage                 # bảng tóm tắt
npm run tc:coverage -- --verbose    # kèm file:dòng của từng mã
npm run tc:coverage -- --json       # JSON cho máy đọc
npm run tc:coverage -- --min 73     # exit 1 nếu chưa đủ 73 ca
node --test scripts/tc-coverage.test.mjs
```

Script `scripts/tc-coverage.mjs` không chạy test mà chỉ đọc tên test trong source:
`apps/**/*.spec.ts`, `*.test.ts`, `*.test.tsx` và `apps/mobile/test/**/*_test.dart`.
CI chạy toàn bộ các test này, nên CI xanh nghĩa là mọi test có mã đều pass.
Bước "Đếm test case Report 5 (T112)" trong CI in bảng vào Job summary và chưa đặt `--min`.

## Quy ước đặt mã trong tên test

- Đặt mã ở đầu chuỗi tên của `it` / `test` / `describe` (Dart: `test` / `testWidgets` /
  `group`), sau đó là một dấu cách: `it('TC-F06-02 IPN trùng chỉ cộng một lần', …)`.
- Test phủ nhiều ca thì ghi nhiều mã: `it('TC-F06-01 TC-STM4-02 …', …)`. Dạng gộp
  `TC-STM4-12/13` được hiểu là hai mã.
- Mã trên `describe` áp cho mọi test bên trong.
- Với `it.each` / `describe.each`, mã có thể nằm trong bảng (thường là cột ghi chú),
  miễn là tên test có placeholder (`%s`, `$note`…) để giá trị đó hiện ra trong tên.
- Mã trong comment hoặc JSDoc **không** được tính. Test `.skip` / `.todo` / `xit` hoặc
  `describe` bị skip theo điều kiện không phải DB cũng không tính, script liệt kê riêng.
- Script so khớp theo dạng chuẩn hoá: bỏ `t` và bỏ số 0 đầu, nên `TC-STM3-02` ≡ `TC-STM3-2`,
  `TC-STM6-1` ≡ `TC-STM6-t1`. Không cần đổi tên test chỉ vì khác định dạng.
- Chỉ gắn mã khi assertion thật sự kiểm đúng nội dung ca. Mã không có trong CSV chỉ bị
  cảnh báo, không làm script lỗi.

## Khi Report 5 có bản mới

1. Xuất lại danh sách ca, thay `report5-test-cases.csv` (UTF-8, LF, giữ dòng tiêu đề).
2. Sửa ngày bản ở mục **Nguồn**.
3. Chạy `npm run tc:coverage -- --verbose`: xem ca mới chưa có test và mã cũ không còn trong
   CSV, rồi đổi tên test cho khớp trong cùng PR.
