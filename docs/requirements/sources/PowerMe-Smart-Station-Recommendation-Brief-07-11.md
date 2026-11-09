# PowerMe — Brief: Gợi ý trạm theo pin & loại xe (cho Trí, 07-11)

> Phạm vi: `apps/csms/src/sessions/station-search.ts` + hợp đồng API app tài xế (#69).
> Gồm: (A) kết quả kiểm tra schema/code · (B) brief triển khai · (C) phụ lục so sánh 3 phương án.

---

## A. Kết quả kiểm tra schema & code (repo hiện tại)

| Dữ liệu cần | Có chưa | Ở đâu | Ghi chú |
|---|---|---|---|
| Dung lượng pin, tầm công bố, cổng | ✅ | `vehicle_models.battery_capacity_kwh`, `rated_range_km`, `connector_type` | Cả hai cột số đều **nullable** |
| Công suất DC tối đa của xe | ✅ | `vehicle_models.max_dc_kw` | Dùng để lấy `min(trạm, xe)` |
| Công suất súng / trụ | ✅ | `connectors.max_power_kw`, `charge_points.rated_power_kw` | Seed demo: súng 60 kW, trụ 120 kW |
| Đơn giá | ✅ | `tariff_periods.price_per_kwh_vnd` (theo operator, khung giờ) | `driver-charging.service.ts` đã dùng `max(price)` để ước tính, nên dùng lại |
| SoC từ trụ | ✅ | `meter_values` (measurand `SoC`), cờ `charge_points.reports_soc` | Simulator D1 đã phát SoC (giả định pin 75 kWh, công suất giữ 100% tới 80% rồi giảm) |
| Lọc theo xe | ✅ | `searchStations(c, driverId, vehicleId, …)` đã join `vehicles → vehicle_models`, lọc `connector_type` | `vehicleId` **đã là tham số**, không cần thêm |
| Lọc bán kính | ✅ | `radiusKm` | Khoảng cách là **haversine (đường chim bay)** |
| Trạng thái rảnh / sắp rảnh | ✅ | `driver_status`, `available_now` | `Finishing` → `freeing_soon` |
| Giữ chỗ súng | ⚠️ Chỉ có bảng | `reservations` («Should»), `charge_points.supports_reservation` | Chưa thấy service nào dùng, nên để **sau MVP** |
| Dữ liệu mẫu xe trong seed demo | ❌ | `demo/seed.sql` không có `vehicle_models` | **Phải seed** trước khi demo |

**Kết luận:** chỉ cần **thêm 2 input tùy chọn** (`socPercent`, `targetSocPercent`), **1 giá trị sort** (`smart`) và **các trường tính toán trong response**. Không cần migration.

---

## B. Brief triển khai

### B1. Mục tiêu
Xếp hạng trạm theo **"bao lâu nữa thì sạc xong"**, có nhãn mức chắc chắn tới được. Lọc theo tầm chỉ là lớp an toàn, không phải tiêu chí chính.

### B2. Thay đổi API (chỉ thêm, không phá client cũ)
**Input** (`StationSearchInput`):
- `socPercent?: number`: 0–100, % pin hiện tại do tài xế nhập.
- `targetSocPercent?: number`: mặc định 80, tối đa 80 ở MVP.
- `sort`: thêm giá trị `'smart'`. Nếu có `socPercent` và có vị trí thì mặc định là `smart`.

**Response:**
- Cấp kết quả: `estimate: { soc_percent, est_range_km, assumptions: { range_factor: 0.75, road_factor: 1.3, reserve_km: 10, avg_speed_kmh: 30 } } | null`, và `smart_unavailable_reason?: 'no_soc' | 'no_location' | 'missing_vehicle_specs'`.
- Mỗi trạm: `reach: 'ok' | 'tight' | 'risky'`, `est_drive_min`, `est_wait_min`, `est_charge_min`, `est_total_min`, `est_energy_kwh`, `est_cost_vnd_max`.
- Tùy chọn: `last_known_soc: { percent, at } | null`. Đây là SoC cuối cùng trong `meter_values` của phiên gần nhất với xe này, để app **điền sẵn** (server không tự dùng giá trị này để tính).

### B3. Công thức (mọi hằng số để trong config, không hard-code)
```
est_range_km = rated_range_km × soc/100 × 0.75          // hệ số tầm, dùng MỘT lần
road_km      = distance_m/1000 × 1.3                     // bù đường chim bay → đường đi

reach = 'ok'    nếu road_km ≤ est_range_km − 10          // còn dự phòng 10 km
        'tight' nếu road_km ≤ est_range_km
        'risky' còn lại                                  // vẫn trả về, KHÔNG lọc bỏ

est_drive_min  = road_km / 30 × 60
est_wait_min   = available → 0 · freeing_soon → 5 · in_use → 30
                 (unknown / unavailable / offline: không tính vào smart, xếp cuối)
power_kw       = min(connector.max_power_kw ?? cp.rated_power_kw, model.max_dc_kw ?? ∞)
est_energy_kwh = battery_capacity_kwh × (target − soc)/100
est_charge_min = est_energy_kwh / (power_kw × 0.85) × 60   // 0.85: hiệu suất trung bình tới 80%
est_total_min  = drive + wait + charge
est_cost_vnd_max = est_energy_kwh × max(price_per_kwh_vnd hiện hành của operator)
```
- Mỗi trạm lấy **súng tốt nhất** (cùng `connector_type`, `est_total_min` nhỏ nhất).
- **Thứ tự `smart`:** `reach` (ok → tight → risky), sau đó `est_total_min` tăng dần, sau đó `distance_m`.
  Pin thấp thì tự nhiên chỉ còn ít trạm "ok", nên không cần hai chế độ pin cao / pin thấp riêng.
- **Không lọc cứng theo tầm.** Nếu có `radiusKm` thì giữ nguyên hành vi cũ. Nếu không có, giới hạn ở `est_range_km × 1.5` để danh sách không quá dài.

### B4. Fallback
| Tình huống | Hành vi |
|---|---|
| Không có `socPercent` | Sort theo khoảng cách như hiện tại, `smart_unavailable_reason='no_soc'` (app hiện "Nhập % pin để gợi ý chính xác hơn") |
| Mẫu xe thiếu `battery_capacity_kwh` / `rated_range_km` | Như trên, với `missing_vehicle_specs` |
| Súng không có công suất | Dùng `rated_power_kw` của trụ; nếu vẫn null thì bỏ `est_charge_min`, xếp sau |
| Không trạm nào `ok`/`tight` | Vẫn trả các trạm `risky` gần nhất; app hiện cảnh báo đỏ |

### B5. Lưu ý kỹ thuật
- **Phân trang:** sort đang làm trong SQL (`ORDER BY … LIMIT`). Với `smart`, nên tính các biểu thức trong CTE để phân trang vẫn đúng. Nếu tính ở TS thì phải lấy hết trong bán kính rồi mới cắt trang.
- Kiểm tra `socPercent`/`targetSocPercent` là số hữu hạn, `0 ≤ soc < target ≤ 80`. Sai thì trả `invalid_search`, giống các validate hiện có.
- **Seed demo:** thêm 3–4 mẫu xe (VinFast VF 5 / VF 6 / VF 8 và một xe khác hãng). Lấy số liệu từ trang hãng hoặc Open EV Data và **ghi nguồn**, không tự điền số. Seed thêm một trụ 30 kW để kịch bản demo có chênh lệch.

### B6. Test tối thiểu
| # | Input | Kỳ vọng |
|---|---|---|
| 1 | Không có `socPercent` | Kết quả như hiện tại + `no_soc` |
| 2 | SoC 15%, xe 300 km | `est_range_km ≈ 33.75`; trạm road 20 km → `ok`, 30 km → `tight`, 40 km → `risky` |
| 3 | Trạm A gần, 30 kW, `in_use`; trạm B xa hơn 5 km, 120 kW, `available` | B đứng trước A |
| 4 | Mẫu xe `battery_capacity_kwh = null` | `missing_vehicle_specs`, sort theo khoảng cách |
| 5 | Mọi trạm `risky` | Danh sách không rỗng |
| 6 | `socPercent = 90` hoặc `-1` | `invalid_search` |
| 7 | Xe `max_dc_kw = 50`, súng 120 kW | `power_kw = 50` |

### B7. Ngoài MVP (ghi vào SRS là "phát triển sau")
- Ước thời gian chờ thật từ SoC của xe đang sạc (`meter_values` của phiên đang mở).
- Nút "Giữ súng 15 phút" qua `reservations` / OCPP `ReserveNow` khi trụ có `supports_reservation`.
- Khoảng cách đường đi thật bằng OSRM.
- Đọc SoC trực tiếp từ xe (API bên thứ ba như Smartcar): tốn phí, cần OAuth với hãng, chưa xác nhận hỗ trợ VinFast/VN.

### B8. Kịch bản demo (số giả định)
Xe 87 kWh còn 15%, CCS2. Cần ≈ 56,6 kWh để lên 80%. Trạm A cách 4 km, 30 kW, đang bận: ≈ 10 (chạy) + 30 (chờ) + 133 (sạc) ≈ **173 phút**. Trạm B cách 9 km, 120 kW, rảnh: ≈ 23 + 0 + 33 ≈ **56 phút** (giả sử xe nhận ≥ 120 kW). App xếp **B trước A**. Thông điệp cho hội đồng: *"gần nhất không phải tốt nhất, và vì vậy cần biết loại xe"*.

### B9. Câu hỏi mở cho Trí
1. Hằng số (0.75 / 1.3 / 10 km / 30 km/h / 0.85) để trong env hay bảng config?
2. Có cần `est_cost` theo đúng khung giờ hiện tại thay vì `max` không? (`max` an toàn hơn và khớp cách tính hiện tại.)
3. `last_known_soc` có đáng làm ở MVP không, hay để app tự nhớ giá trị nhập lần trước?

---

## C. Phụ lục — So sánh 3 phương án

### C1. Đề xuất gốc của Trí
- Chọn xe một lần (`vehicle_models`). Nhập % bằng thanh trượt hoặc 4 mức, gợi ý theo lần sạc trước.
- Tầm còn lại = `rated_range_km × % × 0,7–0,8`. Ghi rõ "ước tính".
- Lọc: tới được (khoảng cách < tầm, kèm hệ số an toàn) + đúng cổng + `available_now`/`freeing_soon`.
- Xếp: theo khoảng cách. Pin thấp thì ưu tiên trạm gần dù bận; pin nhiều thì ưu tiên trạm rảnh, giá tốt.
- Không nhập thì sort theo khoảng cách + lời nhắc. Không trạm nào trong tầm thì báo "pin thấp, không trạm nào chắc chắn tới được".
- Backend: thêm `socPercent`, `vehicleId` + hàm lọc trong `station-search.ts`.

### C2. Góp ý lần 1 (sửa trên nền đề xuất của Trí)
1. Khoảng cách là haversine nên phải nhân ×1,3 (hoặc dùng OSRM cho vài trạm đầu).
2. Không áp hệ số an toàn hai lần. Dùng một hệ số + **dự phòng cố định 10 km** để bảo vệ lúc pin thấp.
3. Điền sẵn SoC từ OCPP `MeterValues` (SoC lúc kết thúc lần sạc trước). Đây là dữ liệu thật, đáng khoe.
4. Nếu dùng 4 mức thì **lấy cận dưới** của mức.
5. Không để danh sách trống: vẫn hiện 1–2 trạm gần nhất kèm cảnh báo.
6. Ghi luật xếp hạng thành công thức/ngưỡng trong SRS.
- Có sẵn: Open EV Data (seed mẫu xe), Smartcar (đọc SoC từ xe, nên nói "để ngoài phạm vi" thay vì "bị hãng chặn").

### C3. Hướng đề xuất lần 2 (đã thành brief ở phần B)
- Đổi câu hỏi từ "trạm nào tới được?" sang **"sạc ở đâu xong sớm nhất / rẻ nhất?"**.
- 3 nhãn tới được (ok / sát tầm / rủi ro) thay cho ngưỡng cắt cứng.
- Xếp theo **tổng thời gian = chạy tới + chờ + sạc tới 80%**, hiện **chi phí ước tính**.
- Pin thấp thì có nút giữ súng (để sau MVP vì `reservations` chưa có service).

### C4. Bảng so sánh
| Tiêu chí | Trí (C1) | Trí + góp ý (C2) | Hướng mới (C3 / B) |
|---|---|---|---|
| Câu hỏi trả lời | Trạm nào tới được | Trạm nào tới được, an toàn hơn | Trạm nào **xong sớm nhất / rẻ nhất** |
| Dùng thông số xe | Tầm, cổng | Tầm, cổng | Tầm, cổng, **dung lượng pin, max DC** |
| Khi không có trạm trong tầm | Báo lỗi, danh sách trống | Hiện 1–2 trạm + cảnh báo | Luôn có danh sách, gắn nhãn rủi ro |
| Luật xếp hạng | 2 chế độ theo mức pin, mô tả bằng lời | Ngưỡng ghi trong SRS | 1 công thức, nhãn reach trước, tổng phút sau |
| Thông tin cho tài xế | Khoảng cách | Khoảng cách | Phút tới xong, chi phí tối đa |
| Công backend | Nhỏ | Nhỏ | Nhỏ–vừa (thêm biểu thức trong CTE, không migration) |
| Rủi ro | Đường chim bay, hệ số kép | Thấp | Thời gian chờ `in_use` là hằng số thô |
| Sức thuyết phục khi Review | Trung bình | Khá | Cao (thấy rõ vì sao cần biết loại xe) |

**Khuyến nghị:** làm phương án B cho MVP. Nếu thiếu thời gian, rút về **C2**. Phần lọc/nhãn reach dùng chung, chỉ bỏ phần tính thời gian sạc và chi phí.
