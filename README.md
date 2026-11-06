# Ephemeral Share

Demo đồ án: web app truyền/lưu dữ liệu **tạm thời, chỉ trong bộ nhớ RAM**,
mỗi phiên truy cập bằng một đường link chứa mã bí mật ngẫu nhiên.

## Ý tưởng / kiến trúc

- **Lưu trữ**: toàn bộ dữ liệu nằm trong một `dict` Python
  (`SESSIONS` trong `app.py`), sống trong bộ nhớ của tiến trình Flask.
  Không có bước nào ghi dữ liệu người dùng xuống file hay database.
  → Khi server restart, hoặc khi người dùng bấm "Xóa phiên", dữ liệu
  biến mất **vĩnh viễn, không thể khôi phục**.
- **Phiên riêng tư bằng link bí mật**: khi tạo phiên mới, server sinh một
  token ngẫu nhiên 128-bit (`secrets.token_urlsafe`) và gắn vào URL dạng
  `/s/<token>`. Không có trang nào liệt kê các phiên đang tồn tại, và
  token không thể đoán được bằng cách dò số thứ tự — vì vậy chỉ người nào
  được chia sẻ đúng đường link mới mở được đúng phiên đó.
- **Không mạo danh ai**: toàn bộ giao diện, tên gọi, màu sắc là tự thiết
  kế từ đầu, không sao chép thương hiệu/giao diện của bất kỳ tổ chức hay
  dịch vụ có thật nào.

## Cấu trúc thư mục

```
ephemeral-share/
├── app.py                  # toàn bộ logic Flask + lưu RAM
├── requirements.txt
├── templates/
│   ├── index.html          # trang chủ: nút "Tạo phiên mới"
│   ├── session.html        # trang phiên: xem / sửa / lưu / xóa
│   └── 404.html            # khi token sai hoặc phiên đã bị xóa
└── static/
    └── style.css
```

## Chạy thử

```bash
cd ephemeral-share
pip install -r requirements.txt
python app.py
```

Mặc định chạy tại `http://127.0.0.1:5000`.

1. Mở trang chủ, bấm **"Tạo phiên mới"** → được chuyển tới
   `http://127.0.0.1:5000/s/<token-ngau-nhien>`.
2. Nhập nội dung, bấm **Lưu** → nội dung được giữ trong RAM.
3. Copy đường link (hiển thị sẵn trong khung) gửi cho người cần chia sẻ —
   chỉ ai có link này mới xem được.
4. Bấm **"Xóa phiên"** → toàn bộ dữ liệu của phiên biến mất ngay lập tức.

## Những điểm có thể mở rộng thêm cho đồ án

- Thêm **hạn dùng tự động** (ví dụ: phiên tự xóa sau N phút không hoạt
  động) bằng một luồng dọn dẹp chạy nền.
- Thêm **mã hóa nội dung** trước khi lưu vào RAM (vẫn không lưu khóa ra
  đĩa) để minh họa thêm phần bảo mật dữ liệu khi truyền.
- Giới hạn số lần xem / chỉ cho xem một lần rồi tự xóa (giống mô hình
  "self-destructing message").
- Thêm WebSocket để nhiều người cùng xem một phiên được cập nhật realtime.

## Lưu ý quan trọng

Đây là **demo học thuật**, không phải hệ thống sản xuất. Nếu triển khai
thật, cần thêm: HTTPS bắt buộc, giới hạn kích thước nội dung, giới hạn số
phiên tối đa (tránh tràn RAM), rate-limiting để chống brute-force token,
và cân nhắc dùng Redis (với TTL) thay cho dict thuần nếu cần chạy nhiều
tiến trình/worker song song.
