# ocppdl — tài liệu tham khảo thư viện

Chứa gói `ocpp` (Python) tải về trong giai đoạn nghiên cứu nền, **chỉ để tra cứu cấu trúc bản tin và schema JSON**.

⚠️ Đây **không phải** phụ thuộc của dự án.

- Backend của nhóm viết bằng **NestJS + TypeScript**, không dùng thư viện Python này.
- File `ocpp-2.1.0-py3-none-any.whl` là bản 2.1, trong khi **phạm vi đồ án chỉ có OCPP 1.6J** — phần cứng D1 / YJ-EU chỉ khai báo 1.6J. Gói này giữ lại vì các schema trong đó tiện để đối chiếu tên trường và enum, không phải vì nhóm định làm 2.x.

Muốn xem bên trong: `.whl` là file zip.

```bash
unzip -l ocppdl/ocpp-2.1.0-py3-none-any.whl
```
