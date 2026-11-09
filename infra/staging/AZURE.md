# Dựng staging trên Azure (Azure for Students) — từng bước

Mục tiêu: một máy chủ Ubuntu 24.04 chạy `infra/staging/` (Caddy + CSMS + Postgres), có HTTPS thật tại một tên miền **miễn phí của Azure** (không cần mua domain), để demo Defense 1.1 chạy trên staging chứ không phải máy cá nhân.

> **Trạng thái thật (04/11/2026):** đã chạy trên Azure thật: VM Japan East, `B2als_v2`, cloud-init xong, deploy `review-4`, kiểm bảo mật và OCPP `wss://` đạt. Tên mục/nút trong Portal có thể khác chút; chỗ nào không chắc có ghi "kiểm trên giao diện".
>
> **Bài học khi tạo VM (subscription Azure for Students):**
> - Policy chỉ cho 5 vùng: `eastasia`, `indiasouthcentral`, `koreacentral`, `japaneast`, `indonesiacentral` (xem bằng `az policy assignment list --query "[].{ten:displayName, vung:parameters.listOfAllowedLocations.value}"`). Southeast Asia và Central India bị chặn (`RequestDisallowedByAzure`).
> - Japan East: `Standard_B2als_v2` (2 vCPU / 4 GiB, ~36 USD/tháng) chỉ có ở **Availability zone 3**.
> - Ô Custom data của Azure chỉ nhận ký tự ASCII: `cloud-init.yaml` không được có tiếng Việt có dấu.
> - Chọn image **Ubuntu Server 24.04 LTS** (không phải Ubuntu Pro, có phí bản quyền).
> - FQDN thật: `powerme-staging.japaneast.cloudapp.azure.com` (mã vùng trong FQDN đổi theo vùng).

## Vì sao làm theo cách này

| Quyết định | Lý do |
|---|---|
| Tên miền `*.cloudapp.azure.com` | Azure cấp miễn phí cho mỗi IP công khai (DNS name label); Let's Encrypt cấp chứng chỉ được vì Caddy dùng cổng 80/443 |
| `cloud-init.yaml` dán vào "Custom data" | Tự cài Docker, tạo user `deploy`, clone repo: bớt ~10 thao tác tay dễ sai |
| `init-env.sh` | Sinh mật khẩu ngẫu nhiên, không ai phải nghĩ hay gõ secret; không bao giờ in ra màn hình |
| Một khoá SSH cho cả người và CI | `~/.ssh/powerme_staging` của Trí; khoá riêng ở máy Trí và ở GitHub secret `STAGING_SSH_KEY` |
| Chỉ mở cổng 22, 80, 443 | Console vận hành chưa có xác thực → **không** mở cổng nào khác; xem bằng SSH tunnel |

## 0. Điều kiện trước khi bắt đầu

- [ ] Subscription **Azure for Students đã Active** (Portal → Subscriptions). Nếu còn "pending", chưa làm gì được.
- [ ] Khoá SSH có sẵn: `~/.ssh/powerme_staging` và `.pub` (đã có từ 26/10).
- [ ] GitHub: environment `staging` có secret `STAGING_SSH_KEY` và `STAGING_USER=deploy` (xem mục 8; đã tạo sẵn nếu PR này nói vậy).
- [ ] Biết **tag** sẽ deploy: một tag `review-*` hoặc `v*` đã được CI build ảnh (xem tab Actions → `deploy-staging`, job `build` xanh). Tag cũ `review-2`/`review-3` build trước các thay đổi gần đây (migration 0009…); nên đẩy một tag mới sau khi các PR cần thiết đã vào `main`.

## 1. Tạo máy ảo (Portal → Virtual machines → Create → Azure virtual machine)

| Ô | Giá trị |
|---|---|
| Subscription | Azure for Students |
| Resource group | tạo mới `powerme-staging` |
| Virtual machine name | `powerme-staging` |
| Region | **Japan East** (đã kiểm; Singapore bị policy chặn trên subscription này). Chỉ 5 vùng được phép, xem ghi chú đầu file. Lưu ý PDPL: vùng nào cũng là dữ liệu ngoài Việt Nam; dữ liệu staging là **dữ liệu giả lập**, không có dữ liệu thật |
| Image | **Ubuntu Server 24.04 LTS – x64 Gen2** |
| Size | **2 vCPU / 4 GB RAM trở lên** (dòng B2s hoặc tương đương còn khả dụng; kiểm trên giao diện). 2 GB chạy được nhưng `docker compose pull` và build chậm, nên thêm swap |
| Authentication | **SSH public key**, Username `azureuser`, dán nội dung `~/.ssh/powerme_staging.pub` |
| Public inbound ports | **Allow selected**: **SSH (22), HTTP (80), HTTPS (443)** — không mở gì thêm |
| OS disk | Standard SSD, 30 GB là đủ |
| Networking → Public IP | tạo mới; **Assignment = Static** (để IP không đổi khi dừng/bật máy) |
| **Advanced → Custom data** | **dán toàn bộ nội dung `infra/staging/cloud-init.yaml`** |

Bấm Review + create → Create. Chi phí: xem mục 9.

## 2. Đặt tên miền miễn phí

Portal → **Public IP addresses** → chọn IP của VM → **Configuration** → ô **DNS name label** = `powerme-staging` → Save.
Tên miền đầy đủ (FQDN) sẽ có dạng **`powerme-staging.<mã-vùng>.cloudapp.azure.com`** (Singapore = `southeastasia`). Xem chính xác ở trang Overview của Public IP, ô "DNS name". Nhãn phải duy nhất trong vùng; nếu trùng, đổi nhãn.

Kiểm DNS đã trỏ đúng (từ máy bạn): `nslookup powerme-staging.southeastasia.cloudapp.azure.com`.

## 3. Đợi cloud-init chạy xong (3–5 phút sau khi VM lên)

```bash
ssh -i ~/.ssh/powerme_staging deploy@<FQDN> "cloud-init status --wait; ls /var/lib/powerme-cloud-init.done; docker --version; docker compose version; ls ~/powerme/infra/staging | head -3"
```

Kỳ vọng: `status: done`, file `.done` tồn tại, Docker và Compose in phiên bản, thư mục repo có file. Nếu lỗi: `ssh azureuser@<FQDN> "sudo tail -80 /var/log/cloud-init-output.log"` (user `azureuser` cũng đăng nhập được bằng cùng khoá).

## 4. Tạo `.env` (mật khẩu ngẫu nhiên)

```bash
ssh -i ~/.ssh/powerme_staging deploy@<FQDN>
cd ~/powerme/infra/staging
./init-env.sh <FQDN> <TAG>        # ví dụ: ./init-env.sh powerme-staging.japaneast.cloudapp.azure.com review-4
```

Script sinh `POSTGRES_PASSWORD` và `DEMO_CHARGE_POINT_PASSWORD`, ghi vào `.env` (chmod 600), **không in ra**. Chạy lại sẽ bị từ chối (tránh làm lệch mật khẩu DB đã tạo); chỉ dùng `--force` khi chấp nhận mất mật khẩu cũ.

## 5. Deploy lần đầu (tay)

Ảnh GHCR là **public** nên không cần `docker login`.

```bash
./deploy.sh <TAG> --seed
```

`deploy.sh` kiểm `.env` → sao lưu DB → pull ảnh → migrate → seed trụ `RH24D1-00001` (có credential) → khởi động → kiểm sức khoẻ trong container và công khai qua TLS. Caddy xin chứng chỉ Let's Encrypt lần đầu (vài chục giây).

## 6. Kiểm tra bằng chứng thật (làm đủ, ghi lại kết quả)

```bash
curl -s https://<FQDN>/health                      # kỳ vọng: {"ok":true,"db":true}
curl -i https://<FQDN>/ | head -5                  # kỳ vọng: HTTP/2 200 + một dòng chữ nêu địa chỉ wss
curl -s https://<FQDN>/api/admin/summary | grep -c '"stations"'   # kỳ vọng: 0 (console KHÔNG được lộ)
```

Dòng thứ ba là kiểm **bảo mật**. Caddy trả `HTTP 200` kèm một dòng chữ cho mọi đường dẫn lạ nên **không** nhìn mã trạng thái, phải nhìn nội dung: nếu kết quả khác `0` nghĩa là bảng điều khiển không xác thực (có nút ngắt kết nối và dừng từ xa) đang lộ ra internet; **dừng ngay**, đừng demo, báo Trí.

Kiểm đường OCPP thật từ máy Trí (trụ giả lập nối qua `wss://`, có Basic Auth):

```powershell
# trên máy Trí, trong D:\CAPSTONE; lấy DEMO_CHARGE_POINT_PASSWORD từ .env trên VPS (đừng dán lên chat)
$env:CSMS_URL="wss://<FQDN>/ocpp"; $env:CP_PASSWORD="<DEMO_CHARGE_POINT_PASSWORD>"; node simulator/d1-hmi/server.mjs
```

Mở `http://localhost:8100`, cắm súng, quẹt thẻ: phiên phải hiện trong console của staging (mục 7). Hoặc chạy simulator ngay trên VPS: `./deploy.sh <TAG> --sim`.

## 7. Xem console vận hành qua SSH tunnel (không mở cổng)

```bash
ssh -i ~/.ssh/powerme_staging -L 3000:127.0.0.1:3000 -L 8100:127.0.0.1:8100 deploy@<FQDN>
```

Giữ cửa sổ đó mở, rồi mở `http://localhost:3000` (console) và `http://localhost:8100` (HMI trụ nếu bật `--sim`).

## 8. Bật deploy tự động từ GitHub (sau khi deploy tay thành công)

1. Settings → Environments → **staging**: secrets `STAGING_SSH_KEY` (khoá riêng), `STAGING_USER` (`deploy`), **`STAGING_HOST`** (= FQDN). Hai cái đầu có thể đã được tạo sẵn; thiếu `STAGING_HOST` thì thêm.
2. Settings → Secrets and variables → Actions → **Variables** → New repository variable: **`STAGING_ENABLED` = `true`**.
3. Đẩy tag: `git tag -a review-N -m "..." <commit>` rồi `git push origin review-N` → workflow `deploy-staging` build ảnh rồi deploy qua SSH.

Chưa bật `STAGING_ENABLED` thì đẩy tag chỉ build ảnh, không deploy (đúng ý: không làm workflow đỏ khi chưa có VPS).

## 9. Chi phí, tắt máy, dọn dẹp

- Azure for Students có **hạn mức credit** (kiểm số dư ở Cost Management + Billing). Máy chạy 24/7 tiêu credit theo giờ.
- Không dùng thì **Stop** máy (Portal → VM → Stop): trạng thái *Deallocated* dừng tính tiền compute (đĩa và IP tĩnh vẫn tính một ít). Bật lại: **Start**; Caddy và Docker tự chạy lại (`restart: unless-stopped`).
- Xoá hết: xoá **resource group** `powerme-staging` (mất cả đĩa/dữ liệu staging).
- Đặt cảnh báo ngân sách (Cost Management → Budgets) trước khi để máy chạy lâu.

## 10. Gỡ rối

| Triệu chứng | Kiểm |
|---|---|
| `https://<FQDN>` báo lỗi chứng chỉ/không kết nối | `nslookup <FQDN>` trỏ đúng IP chưa; cổng 80 và 443 mở trong Network security group chưa; `docker compose logs caddy` (Let's Encrypt cần cả 80 lẫn 443) |
| `deploy.sh` dừng ở `.env` | còn chuỗi `change-me`/domain mẫu → chạy `./init-env.sh` |
| Pull ảnh lỗi `denied`/`not found` | tag chưa được CI build (tab Actions → `deploy-staging` → job `build`); ảnh GHCR phải **public** (Packages → Package settings) |
| `/health` 503 | `docker compose logs csms`; DB chưa lên hoặc migration lỗi |
| Simulator trên VPS không nối được `wss://<FQDN>` | hairpin NAT: đặt `SIM_CSMS_URL=ws://csms:9000/ocpp` trong `.env` (xem `.env.example`) |
| SSH `Permission denied` | đang dùng đúng khoá `-i ~/.ssh/powerme_staging` và user `deploy` chưa; cloud-init đã xong chưa |
| Deploy thất bại giữa chừng | **không tự lùi nếu đã áp migration** (an toàn dữ liệu); đọc thông báo và mục Rollback ở `README.md` |

## 11. Những gì chưa được kiểm chứng

- Chưa tạo VM nào trên Azure: mọi bước portal là từ mô tả, chưa bấm thật.
- `cloud-init.yaml` chưa chạy trên Ubuntu 24.04 thật (chỉ kiểm cú pháp YAML). Rủi ro chính: tên gói/kho Docker thay đổi, hoặc user `deploy` chưa có nhóm `docker` ngay phiên SSH đầu (đăng xuất rồi đăng nhập lại là đủ).
- Chưa kiểm Let's Encrypt trên tên miền `cloudapp.azure.com` (về nguyên tắc dùng được; giới hạn tần suất cấp chứng chỉ áp cho cả tên miền cha, hiếm khi chạm tới).
- Hành vi `docker compose` với cú pháp lồng `${SIM_CSMS_URL:-wss://${DOMAIN}/ocpp}` chưa kiểm bằng Docker thật (đã nêu từ PR #48).
