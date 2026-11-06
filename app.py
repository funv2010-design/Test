"""
Ephemeral Share — trang chia sẻ dữ liệu tạm thời.

- Dữ liệu chỉ được lưu trong bộ nhớ RAM (một dict Python), KHÔNG ghi xuống
  database hay file trên đĩa.
- Mỗi phiên (session) có một mã token ngẫu nhiên, khó đoán, dùng làm một phần
  của đường dẫn truy cập (dạng /s/<token>). Chỉ ai có đường link đầy đủ mới
  mở được phiên đó — không có danh sách phiên công khai, không có trang liệt
  kê nào để dò ra các phiên khác.
- Khi người dùng bấm "Xóa", toàn bộ nội dung của phiên đó bị xóa khỏi RAM
  ngay lập tức và không thể khôi phục.
- Khi tiến trình server dừng / khởi động lại, mọi dữ liệu trong RAM cũng mất,
  đúng tinh thần "dữ liệu tạm thời, không lưu trữ bền vững".

Đây KHÔNG phải trang giả mạo bất kỳ tổ chức, thương hiệu hay dịch vụ nào —
toàn bộ giao diện và tên gọi là tự thiết kế.
"""

import secrets
import time
from datetime import datetime, timezone

from flask import Flask, abort, redirect, render_template, request, url_for

app = Flask(__name__)

# ---------------------------------------------------------------------------
# "Cơ sở dữ liệu" trong RAM. Đây là một dict Python bình thường — khi tiến
# trình kết thúc hoặc bị khởi động lại, dict này mất hoàn toàn. Không có
# dòng code nào trong file này ghi dữ liệu người dùng xuống đĩa.
# ---------------------------------------------------------------------------
SESSIONS: dict[str, dict] = {}

TOKEN_BYTES = 16  # ~128 bit ngẫu nhiên -> thực tế không thể đoán được


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S %d/%m/%Y UTC")


def generate_token() -> str:
    """Sinh một mã token ngẫu nhiên, an toàn cho URL."""
    while True:
        token = secrets.token_urlsafe(TOKEN_BYTES)
        if token not in SESSIONS:
            return token


@app.route("/", methods=["GET"])
def home():
    return render_template("index.html")


@app.route("/create", methods=["POST"])
def create_session():
    token = generate_token()
    SESSIONS[token] = {
        "content": "",
        "created_at": _now(),
        "updated_at": _now(),
    }
    return redirect(url_for("view_session", token=token))


@app.route("/s/<token>", methods=["GET"])
def view_session(token):
    session = SESSIONS.get(token)
    if session is None:
        # Token sai, đã bị xóa, hoặc server đã khởi động lại -> coi như
        # không tồn tại. Không tiết lộ thêm thông tin gì về việc token này
        # "từng" tồn tại hay chưa, để tránh dò quét.
        abort(404)
    return render_template(
        "session.html",
        token=token,
        content=session["content"],
        created_at=session["created_at"],
        updated_at=session["updated_at"],
    )


@app.route("/s/<token>/save", methods=["POST"])
def save_session(token):
    session = SESSIONS.get(token)
    if session is None:
        abort(404)
    session["content"] = request.form.get("content", "")
    session["updated_at"] = _now()
    return redirect(url_for("view_session", token=token))


@app.route("/s/<token>/delete", methods=["POST"])
def delete_session(token):
    # Xóa thẳng khỏi dict RAM -> dữ liệu biến mất vĩnh viễn, không có thùng rác.
    SESSIONS.pop(token, None)
    return redirect(url_for("home"))


@app.errorhandler(404)
def not_found(_e):
    return render_template("404.html"), 404


if __name__ == "__main__":
    # debug=False khi triển khai thật; bật True chỉ khi đang phát triển cục bộ.
    app.run(host="127.0.0.1", port=5000, debug=True)
