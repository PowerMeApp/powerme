# Nhật ký migration 0030 — kiểm authorize offline (T150)

Ngày 26/11/2026. File:
[`0030_t150-kiem-the-offline.sql`](../apps/csms/drizzle/0030_t150-kiem-the-offline.sql).
Migration SQL viết tay, nối sau 0029 (ADR-0008); không sửa migration cũ.

## Vì sao

BR-P52: trụ mất mạng mà còn tự cho phép thẻ (Authorization Cache / Local List /
`AllowOfflineTxForUnknownId`) thì thẻ lạ hoặc thẻ đã khoá vẫn sạc được. CSMS chỉ biết khi trụ nối
lại, tiền không thu được, dẫn tới shortfall (BR-P20). Sau mỗi BootNotification CSMS đọc và tắt ba
key; cần nơi lưu bằng chứng (giá trị đọc được, phản hồi từng lệnh, SupportedFeatureProfiles, thời
điểm) và cờ cho dashboard.

## Thay đổi

Một bảng mới `charge_point_offline_auth_checks`, chỉ ghi thêm (mỗi lần kiểm một dòng):

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `charge_point_id` | bigint FK `charge_points` | |
| `epoch` | integer | epoch kết nối lúc kiểm |
| `started_at`, `completed_at` | timestamptz | CHECK `completed_at >= started_at` |
| `config_values` | jsonb | `{key: {value, readonly} \| null}`; null cả cột = GetConfiguration không có phản hồi |
| `change_results` | jsonb, mặc định `{}` | `{key: Accepted \| Rejected \| RebootRequired \| NotSupported \| timeout \| error \| skipped}` |
| `supported_feature_profiles` | text | nguyên văn |
| `offline_card_risk` | boolean | |
| `risk_reason` | varchar(40) | CHECK: khác null ⇔ `offline_card_risk` |
| `fallback_profile_status` | varchar(20) | TxDefaultProfile dự phòng; `unsupported`; null = tắt / không cần |

Index `(charge_point_id, id DESC)` cho truy vấn "dòng mới nhất của trụ" (LATERAL trong
`operator-monitoring.ts`). Không thêm enum, không đụng bảng cũ, nên cả file nằm trong một
transaction. Schema Drizzle: `chargePointOfflineAuthChecks` trong
`apps/csms/src/db/schema/stations.ts`. Mô tả bảng: `docs/THIET-KE-CSDL-VAT-LY.md` §3.2.

Không có backfill: trụ chưa có dòng nào được Operator API coi là rủi ro với lý do `not_checked`
cho tới lần Boot tiếp theo.

## Kiểm tra

- `test/t150-offline-auth-check.integration.test.ts` chạy trên Postgres thật (helper
  `resetAndMigrate` áp 0000 … 0030), gồm ca vi phạm CHECK `reason_check` theo cả hai chiều.
- `test/fe03-operator-monitoring.integration.test.ts` đọc bảng qua API danh sách và chi tiết trụ.
- Demo local `node apps/csms/demo/db-embedded.mjs --port-offset 80` áp 0030 lên DB demo có sẵn.

## Hoàn tác

`DROP TABLE charge_point_offline_auth_checks;` rồi xoá dòng `0030_t150-kiem-the-offline` khỏi
`_migrations`. Không mất dữ liệu nghiệp vụ nào khác (bảng chỉ là bằng chứng kiểm cấu hình).
