# ADR-0019 — Tài xế báo lỗi súng: nhãn "reported issue", ẩn súng và chuyển t8 `SESSION_COMPLETED`

| | |
|---|---|
| Trạng thái | Đề xuất |
| Ngày | 11/11/2026 · sửa mục 4–7 ngày 16/11/2026 (T131, review #139, quyết định D-G 14/11) · sửa mục 6 ngày 19/11/2026 (T141, quyết định D-X 17/11) |
| Người quyết định | WP4 (Trần Trọng Nghĩa) |
| Liên quan | FE-17, UC-CHG-05, FR-06, F-05, BR-P42, STM-6 (Report 4 Fig 14), AD-7 (SRS Fig 16), ADR-0016 |

## Bối cảnh

WF-04 có ba tín hiệu lỗi; tín hiệu "tài xế báo lỗi" chưa có code. Tài liệu chính thức quy định phần lớn:

- **BR-P42:** súng mang nhãn "reported issue" khi 2 tài xế khác nhau báo trong 2 giờ, hoặc 1 tài xế báo lúc trạng thái súng bất thường; nhãn xoá khi Operator đóng **hoặc một phiên trên súng hoàn tất bình thường**.
- **STM-6 (Fig 14):** sự cố được tạo bởi "2nd Driver report within 2 h" với hành động "hide connector, void reservations, alert Operator"; tín hiệu tới khi đã có sự cố mở thì "attach to this fault"; trạng thái `resolved` có "entry / show connector, clear label". STM-6 chỉ có các đường đóng: súng báo Available, trụ kết nối lại, Operator đóng.
- **AD-7 (Fig 16):** báo cáo chưa đủ điều kiện thì "keep the report for later grouping"; đủ thì hiện nhãn, tạo sự cố, ẩn súng khỏi tìm kiếm và gợi ý.

Những gì tài liệu chưa nói (cửa sổ gộp, "bất thường", "hoàn tất bình thường", báo trùng) đã được chốt trong buổi grilling ngày 11/11 (WF-04-PLAN Q75–Q81).

Vấn đề: STM-6 không có đường đóng nào ứng với "một phiên hoàn tất bình thường" của BR-P42. Và mã hiện tại coi mọi trạng thái hoạt động (Preparing, Charging…) là "đã hồi phục" vì một súng `Faulted` có thể chuyển thẳng sang đó; với sự cố do tài xế báo, cắm xe (Preparing) không chứng minh gì cả.

## Quyết định

Chúng ta sẽ:

1. Thêm `FaultService.reportFromDriver` và route `POST /api/driver/v1/connectors/{id}/fault-reports` (chỉ mô tả, 5–500 ký tự). Áp đúng BR-P42:
   - **2 tài xế khác nhau trong 2 giờ**, hoặc **1 tài xế khi súng `Faulted` / `Unavailable` hoặc trụ Offline**, tạo sự cố `source = driver_report`;
   - súng (hoặc cả trụ) đang có sự cố mở → báo cáo gắn vào đó;
   - chưa đủ → lưu và chờ gộp;
   - *Thêm 16/11 (T131):* "cùng một tài xế chỉ tính một" áp cho **cả trụ** ở đường một tài xế: trong 2 giờ, một tài xế tự mình chỉ mở được **một** sự cố trên một trụ. Báo cáo ở súng khác vẫn lưu và chờ luật hai tài xế. Lý do: trụ Offline thì một người báo lần lượt từng súng là ẩn được cả trạm, và theo D-G các sự cố đó không tự đóng khi trụ nối lại. Cần Ân thêm vào BR-P42.
2. Khi **bất kỳ** sự cố nào mở trên súng (kể cả `Faulted` từ trụ, `Offline` cả trụ), gắn các báo cáo chờ chưa xoá trong **2 giờ** (cùng cửa sổ với BR-P42).
3. Sự cố `driver_report` **ẩn súng** khỏi `/stations` và gợi ý như mọi sự cố mở (STM-6, AD-7). Nhãn hiện ở tra mã QR (`reported_issue`), vì súng không còn trong kết quả tìm kiếm.
4. Thêm chuyển **t8 `SESSION_COMPLETED`**: `raised → resolved` và `acknowledged → resolved`, chỉ cho sự cố `driver_report`. "Hoàn tất bình thường" = phiên bắt đầu **sau** khi sự cố được tạo, đã dừng, điện năng > 0 Wh, lý do dừng không phải `EmergencyStop` / `PowerLoss` / `Other`. Gọi sau `StopTransaction`, theo kiểu best-effort như móc `StatusNotification`.
   - *Sửa 16/11 (T131):* "bắt đầu sau" so theo **giờ trụ đã đối soát**: `cp_started_at` khi đồng hồ trụ qua đúng phép kiểm của BR-P02 (`checkTariffTimeline`: lệch ≤ 300 s, đúng epoch); không qua thì giờ CSMS nhận, nhưng chỉ khi phiên không phải bản gửi bù (`delivered_offline`). Bản đầu so giờ CSMS nhận, nên một phiên trụ gửi bù sau khi nối lại (đã sạc trước khi có báo cáo) có thể đóng nhầm sự cố.
5. *Sửa 16/11 (T131, quyết định D-G 14/11 — BR-P42 "a connector status change alone does not clear it"):* sự cố `driver_report` **không đóng theo trạng thái nào**, kể cả `Available` hay trụ khởi động lại; chỉ Operator đóng (t7) hoặc t8. Bản đầu nhận `Available` (Q76), nên một phiên 0 Wh rồi `Available` hoặc trụ khởi động lại vượt qua được điều kiện của t8. Reset trên sự cố này chờ hết hạn rồi về `acknowledged`.
   - Trụ báo `Faulted` có mã lỗi khi súng đang có sự cố `driver_report` chưa có mã → ghi mã đó vào sự cố (vẫn một sự cố, vẫn `driver_report`), để Operator thấy lỗi phần cứng thật và mức nghiêm trọng của nó.
6. Nhãn chỉ xoá khi Operator đóng sự cố (t7) hoặc t8: khi đó ghi `fault_reports.cleared_at`; `cleared_by` là nhân viên khi Operator đóng.
   - *Sửa 19/11 (T141, quyết định D-X 17/11):* sự cố OCPP / Offline có báo cáo tài xế gắn kèm mà **tự đóng** (súng báo hồi phục, trụ nối lại) thì **không** xoá nhãn. Các báo cáo chưa xoá được chuyển, theo từng súng, sang sự cố đang mở của súng đó, hoặc một sự cố `driver_report` mới (`raised`, t1). Súng vẫn bị ẩn và vẫn mang nhãn tới khi Operator đóng hoặc t8. Bản 16/11 còn xoá nhãn ở hai đường này (điểm mở, nay đã đóng). Sự cố tạo do chuyển giao không phải "tài xế tự mở" nên không tính vào giới hạn một sự cố / trụ / 2 giờ của mục 1; giới hạn đó giữ nguyên, Ân thêm vào BR-P42 (T143).
7. Cùng tài xế, cùng súng trong 60 s → 409 `duplicate_report`, không ghi gì. Cùng một tài xế báo nhiều lần chỉ tính một.
8. *Thêm 16/11 (T131):* hai đường mở sự cố (StatusNotification và báo cáo của tài xế) đều khoá dòng connector `FOR NO KEY UPDATE` trước, sự cố cả trụ khoá mọi connector của trụ theo id. Hai đường đi tuần tự: không deadlock, không 500 vì trùng chỉ mục một-sự-cố-mở, không rơi sự cố OCPP. `NO KEY` để không chặn insert có khoá ngoại tới connector (phiên, báo cáo).

Không cần migration: `fault_reports.fault_event_id / cleared_at / cleared_by` và giá trị `driver_report` của `fault_source` đã có.

## Hệ quả

**Được:**

- BR-P42 và STM-6 chạy đúng như tài liệu; F-05 có test (TC-F05-01..03).
- Nhãn tự xoá khi súng thực sự sạc được một phiên, không chờ Operator.
- Bảng quét STM-6 tăng từ 24 lên 28 cặp (9 hợp lệ, 3 no-op, 16 bị từ chối), vẫn kiểm đủ.

**Mất:**

- STM-6 trong Report 4 (Fig 14) cần thêm t8; SRS Table 5 #6 ghi "category and note" phải sửa thành chỉ mô tả (khớp ERD). Nhờ Ân cập nhật.
- Súng bị ẩn nên tài xế chỉ thấy nhãn khi quét QR tại trụ, không thấy trong danh sách.
- Hai báo cáo sai của hai người có thể ẩn một súng tốt cho tới khi Operator đóng hoặc có một phiên sạc bình thường trên súng (D-G: súng báo Available không còn đóng).
- Một sự cố phần cứng tự hết (súng báo Available) mà có tài xế đã báo cùng lúc thì súng vẫn bị ẩn tới khi Operator đóng — chủ đích của D-X (T141): Operator kiểm lại lời báo của tài xế trước khi mở súng.

## Các phương án đã cân nhắc và loại bỏ

| Phương án | Vì sao loại |
|---|---|
| Chỉ gắn nhãn, không ẩn súng | Trái STM-6 và AD-7 (cả hai ghi "hide connector") |
| Đóng sự cố do tài xế báo khi súng báo `Available` (bản đầu, Q76) | Thay ngày 16/11 theo D-G: đổi trạng thái không xoá nhãn (BR-P42) |
| Giới hạn tần suất chung (vd 5 báo cáo / giờ, 429) | Vẫn đủ để một người ẩn 5 súng; luật theo trụ chặn đúng kiểu lạm dụng mà không bỏ báo cáo |
| Coi mọi phiên đã dừng là "bình thường" | Phiên 0 Wh hoặc dừng khẩn cấp không chứng minh súng chạy được |
| Thêm loại lỗi (category) | ERD Report 4 và bảng `fault_reports` chỉ có mô tả; cần migration và sửa ERD |
