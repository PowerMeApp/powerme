# Quy ước code React — `apps/dashboard`

**Ngày:** 07/11/2026 · **Chủ sở hữu:** Trần Trọng Nghĩa (WP4) · **Áp dụng cho:** Operator Dashboard và Admin Console (`apps/dashboard`, React + Vite + TypeScript, Redux Toolkit / RTK Query)

Tài liệu này bổ sung cho [CONTRIBUTING.md](../CONTRIBUTING.md): CONTRIBUTING nói về nhánh, commit, PR; tài liệu này nói **file nào nằm ở đâu và viết thế nào** trong dashboard. Ai thêm một màn hình, một feature hay một test cho dashboard đọc hết một lần trước khi mở PR.

---

## 1. Phạm vi và nguồn

| Nguồn | Dùng cho |
|---|---|
| **PKG-2 v2.0** — Report 4, `diagrams/report4/package/PKG-2/PKG-2.puml` | Các tầng và danh sách feature (mục 3, 4) |
| **SRS Report 3** — screen 16–33, Fig 10 (Operator Dashboard), Fig 11 (Admin Console), Table 6 (phân quyền màn hình) | Số màn hình, route, quyền (mục 9) |
| **STM-6, STM-8, STM-4…** — Report 4 | Luật nghiệp vụ phía UI (mục 8) |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Git, commit, PR, Definition of Done |

Không áp dụng cho `apps/csms` (NestJS) hay `apps/mobile` (Flutter).

---

## 2. Cây thư mục chuẩn

```
apps/dashboard/
├── index.html · vite.config.ts · tsconfig.json · vitest.setup.ts · package.json · README.md
├── src/
│   ├── main.tsx              # điểm vào: render <App />
│   ├── App.tsx               # Providers (store, router, auth, toast) + AppRoutes
│   ├── routes/               # routes.tsx (bảng route = screen 16–33), RequireRole.tsx
│   ├── layouts/              # AppShell: sidebar, header, đăng xuất
│   ├── pages/
│   │   ├── LoginPage.tsx     # screen 16 / 26
│   │   ├── operator/         # screen 17–25, mỗi màn hình một file <Ten>Page.tsx
│   │   └── admin/            # screen 27–33
│   ├── components/           # UI dùng chung, KHÔNG biết nghiệp vụ (Button, Card, Pill, ConfirmDialog…)
│   ├── hooks/                # hook dùng chung (useToast…)
│   ├── features/
│   │   └── <feature>/        # kebab-case, theo PKG-2 (mục 3)
│   │       ├── <Ten>.tsx     # component nghiệp vụ của feature
│   │       └── <luat>.ts     # luật thuần, không React (state machine, validate, tính toán)
│   ├── core/
│   │   ├── api/              # RTK Query: một api slice, endpoints, errorMessage
│   │   ├── auth/             # AuthContext, phiên đăng nhập, homePathFor
│   │   ├── realtime/         # polling (hiện tại), SSE sau này
│   │   ├── store/            # configureStore
│   │   └── config/           # env (useMock, appName…)
│   ├── mocks/                # mock server + fixtures — CHỈ core/api và test được dùng
│   ├── types/                # domain.ts: kiểu dữ liệu khớp hợp đồng OpenAPI
│   ├── utils/                # hàm thuần dùng chung (format.ts…)
│   ├── styles/               # global.css
│   └── assets/               # ảnh, icon tĩnh
└── test/
    ├── render.tsx            # renderApp(url, user): dựng app thật + store + mock
    ├── <feature>.test.tsx    # luồng trên UI
    └── <luat>.test.ts        # luật thuần
```

Không tạo thư mục cấp một mới trong `src/` mà không sửa tài liệu này và PKG-2 trong cùng PR.

---

## 3. Danh sách feature (theo PKG-2)

Tên thư mục là **kebab-case tiếng Anh**, khớp đúng PKG-2. Thêm feature mới thì thêm vào PKG-2 trước.

| Operator (`features/`) | Màn hình | Admin (`features/`) | Màn hình |
|---|---|---|---|
| `charge-points` — onboard, danh sách | 18, 19 | `users-roles` | 28 |
| `monitoring` — trạng thái súng live | 17, 20 | `charge-point-registry` | 29 |
| `faults` — cảnh báo, xác nhận, đóng | 21 | `rfid-cards` — thẻ, free-vend tag | 30 |
| `remote-commands` — reset, start, stop, unlock | 20 | `network-monitor` | 33 |
| `tariffs-promotions` | 23 | `billing-exceptions` — hoàn tiền, e-invoice | 31 |
| `unattributed-sessions` | 22 | `platform-fee` | (UC-ADM-09) |
| `revenue-share` | 25 | `platform-revenue` | (UC-ADM-10) |
| `ocpp-messages` — trình xem bản tin thô | — | | |

---

## 4. Luật phụ thuộc giữa các tầng

Phụ thuộc **một chiều từ trên xuống**: `pages` → `features` → `core` → foundation (`types`, `utils`, `styles`, `assets`, `components`, `hooks`).

| Thư mục | Được import | KHÔNG được import |
|---|---|---|
| `routes/`, `layouts/`, `pages/` | `features`, `core`, foundation | `mocks` |
| `features/<a>/` | `core`, foundation | **feature khác** (`features/<b>`), `pages`, `mocks` |
| `core/` | foundation | `features`, `pages`, `routes` (riêng `core/api` được import `mocks`) |
| `components/`, `hooks/` | `types`, `utils`, `styles`, `assets` | `core`, `features`, `pages` |
| `types/`, `utils/` | không gì trong `src/` (trừ `types` lẫn nhau) | mọi thứ còn lại |

Hệ quả:

- **Chỉ `core/api` gọi mạng.** Không có `fetch`/`axios` trong page hay component.
- Hai feature cần dùng chung một thứ → đưa xuống `components/` (UI) hoặc `types/`/`utils/` (dữ liệu, hàm), không import chéo.
- `mocks/` không bao giờ lọt vào code chạy thật ngoài `core/api` (`env.useMock`) và `test/`.

---

## 5. Đặt tên

| Loại | Quy ước | Ví dụ |
|---|---|---|
| Component | `PascalCase.tsx`, **một component chính mỗi file** | `FaultItem.tsx`, `ChargePointCard.tsx` |
| Màn hình | `<Ten>Page.tsx` trong `pages/operator` hoặc `pages/admin` | `FaultAlertsPage.tsx` |
| Hook | `useTen.ts` | `useToast.ts` |
| Module thuần | `camelCase.ts` | `faultStateMachine.ts`, `validateBands.ts` |
| Thư mục | kebab-case | `billing-exceptions/` |
| Hằng số | `UPPER_SNAKE` | `LIVE_POLL_MS` |
| Kiểu | `PascalCase`, không tiền tố `I` | `FaultEvent`, `SessionUser` |
| Route | kebab-case, số nhiều | `/operator/charge-points/:id` |

- **Định danh bằng tiếng Anh, chữ hiển thị trên UI bằng tiếng Việt.**
- Thuật ngữ thiết bị là **Charge Point** (RF-01, Commitment §9). Không dùng `pillar`/`Pillar` trong tên file, biến, route hay chữ hiển thị mới.
- Tên trạng thái giữ đúng giá trị của API/DB (`raised`, `acknowledged`…); nhãn tiếng Việt đặt ở chỗ hiển thị.

---

## 6. Chú thích đầu file

Mọi file trong `src/` mở đầu bằng một khối `/** */` nói **vì sao file tồn tại** và **truy vết** tới tài liệu (số màn hình, UC, workflow, STM). Không mô tả lại code từng dòng.

```tsx
/**
 * Screen 21 — Fault Alerts (UC-OPS-03, WF-04). Sự cố mở trước, nặng trước; chọn một sự cố → Charge
 * Point Detail (Fig 10: "select alert"). Khi có sự cố đang reset, nhịp làm mới dày hơn để thấy t5/t6.
 */
```

```ts
/**
 * STM-6 FaultEvent ở phía dashboard — CÙNG bảng chuyển với
 * apps/csms/src/stations/faults/fault-state-machine.ts, để UI chỉ bật nút hành động hợp lệ.
 */
```

Quyết định không hiển nhiên trong thân hàm (vì sao chọn cách này, trường hợp biên) thì chú thích ngay chỗ đó, kèm mã tài liệu nếu có (BR-Pxx, ADR-xxxx).

---

## 7. Dữ liệu và trạng thái

- **Mọi dữ liệu từ server đi qua RTK Query** trong `core/api/api.ts`: một endpoint cho mỗi thao tác, hook tự sinh (`useFaultsQuery`, `useResetFaultMutation`).
- Mỗi mutation **invalidates đúng tag** của danh sách nó làm thay đổi; không gọi `refetch()` tay để "cho chắc".
- **Không chép dữ liệu server vào `useState`.** `useState` chỉ cho trạng thái giao diện (tab đang chọn, hộp thoại đang mở, ô nhập đang gõ).
- Lỗi API hiển thị qua `errorMessage(err)` + toast; không `alert()`, không nuốt lỗi.
- Kiểu dữ liệu nằm ở `types/domain.ts` và **khớp hợp đồng OpenAPI** của CSMS. Hợp đồng đổi thì sửa `types/domain.ts` và mock trong cùng PR.
- **Mock → thật chỉ là đổi `baseQuery`** (`env.useMock`). Page và feature không được biết mình đang chạy mock.
- Làm mới định kỳ dùng `pollingInterval` với hằng trong `core/realtime/polling.ts`; không tự `setInterval` trong component.

---

## 8. Luật nghiệp vụ phía UI

- Luật đã có ở backend (state machine, validate) mà UI cần để bật/tắt nút thì **chép thành module thuần trong feature**, ghi rõ file backend gốc ở chú thích đầu file và giữ **đúng bảng chuyển** (vd. `features/faults/faultStateMachine.ts` ↔ `apps/csms/src/stations/faults/fault-state-machine.ts`). Khi có `@powerme/shared`, gộp hai bản làm một.
- **UI chỉ gợi ý, server quyết định.** Nút bị tắt khi chuyển không hợp lệ, nhưng server vẫn kiểm; lỗi 409 hiện ở toast.
- Hành động có hậu quả (Reset, hoàn tiền, khoá tài khoản, chặn thẻ) luôn qua `ConfirmDialog`.
- Số tiền là **VND nguyên**, năng lượng là **Wh nguyên** (ADR-0009); chỉ định dạng ở `utils/format.ts` lúc hiển thị, không làm tròn giữa chừng.

---

## 9. Route và phân quyền

- Bảng route nằm ở `routes/routes.tsx`, mỗi dòng ghi **số màn hình SRS** bằng chú thích (`// 21`).
- Mọi màn hình sau đăng nhập nằm dưới `RequireRole` đúng vai trò (`operator` hoặc `admin`, SRS Table 6). Operator chỉ thấy dữ liệu của operator mình (BR-P16) — server lọc, UI không tự lọc thay.
- Màn hình «Should» chưa làm dùng trang giữ chỗ (`ShouldPages.tsx`), không ẩn khỏi menu.

**Thêm một màn hình mới — checklist:**

1. `pages/<vai-tro>/<Ten>Page.tsx` có chú thích đầu file (số màn hình, UC).
2. Route trong `routes.tsx` dưới `RequireRole`, kèm số màn hình.
3. Mục menu trong `layouts/AppShell.tsx`.
4. Endpoint trong `core/api/api.ts` + kiểu trong `types/domain.ts`.
5. Mock handler + fixture trong `mocks/`.
6. Test trong `test/` (mục 10).
7. Cập nhật PKG-2 nếu thêm feature, và báo WP1 nếu lệch screen flow Fig 10/11.

---

## 10. Test

- **Vitest + Testing Library**, chạy `npm test -w @powerme/dashboard`.
- Test luồng UI dựng app thật bằng `renderApp(url, user)` trong `test/render.tsx` (route + store + mock server), không render component lẻ khi luồng đi qua nhiều màn hình.
- Tìm phần tử theo **vai trò và nhãn** (`getByRole('button', { name: 'Xác nhận' })`, `findByRole('article', { name: 'Sự cố #101' })`), không theo class CSS hay cấu trúc DOM.
- Polling và hẹn giờ dùng `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`, nhớ `vi.useRealTimers()` trong `afterEach`.
- Mỗi feature có ít nhất **một nhánh thành công và một nhánh lỗi** (409, 403, server từ chối).
- Luật thuần (`<luat>.ts`) có test riêng không cần render (`<luat>.test.ts`), phủ đủ bảng chuyển.
- Ghi **mã test case** của Report 5 trong tên test để đếm được (`it('TC-F10-02: …')`).

---

## 11. Style và khả năng tiếp cận

- Định dạng bằng Prettier theo cấu hình gốc của repo (`npm run format:check` như CI).
- CSS đặt trong `styles/global.css` theo tên class; `style={{…}}` chỉ cho giá trị động (độ rộng thanh tiến độ…).
- Nút luôn có nhãn đọc được (chữ hoặc `aria-label`); mỗi mục danh sách quan trọng là `article` có `aria-label` để test và trình đọc màn hình cùng tìm được.
- Trạng thái không chỉ thể hiện bằng màu: luôn kèm chữ (`Pill` có nhãn).

---

## 12. Hiện trạng so với quy ước

Shell trên nhánh `wp4/fe-01-dashboard-shell` (27/10) viết trước PKG-2 v2.0 và RF-01, nên còn lệch. Sửa trong PR đưa shell vào `main`, không sửa lẻ tẻ:

| Hiện tại | Theo quy ước |
|---|---|
| `features/alerts/` | `features/faults/` |
| `features/stations/` (`PillarCard.tsx`) | `features/charge-points/` (`ChargePointCard.tsx`) |
| `features/billing/` | `features/billing-exceptions/` |
| `features/tariffs/` | `features/tariffs-promotions/` |
| `core/context/AuthContext.tsx` | `core/auth/AuthContext.tsx` |
| `pages/operator/PillarListPage.tsx`, `PillarDetailPage.tsx`, route `/operator/pillars` | `ChargePointListPage.tsx`, `ChargePointDetailPage.tsx`, route `/operator/charge-points` |
| `components/ui.tsx` (nhiều component một file) | tách mỗi component một file trong `components/` |

---

## 13. Checklist PR cho dashboard

Thêm vào Definition of Done của CONTRIBUTING mục 5:

- [ ] File mới đúng thư mục ở mục 2–3, đúng luật phụ thuộc mục 4.
- [ ] Không còn `pillar` trong tên hoặc chữ hiển thị mới.
- [ ] Mỗi file mới có chú thích đầu file có truy vết.
- [ ] Dữ liệu server chỉ qua `core/api`; kiểu khớp OpenAPI; mock cập nhật cùng PR.
- [ ] Có test nhánh thành công và nhánh lỗi, mã TC trong tên test.
- [ ] `npm run typecheck`, `npm test -w @powerme/dashboard`, `npm run format:check` đều qua.
