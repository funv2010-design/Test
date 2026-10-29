const { WebSocketServer } = require('ws');

// Khởi tạo máy chủ WebSocket lắng nghe tại cổng 8080 (Tầng 7)
const wss = new WebSocketServer({ port: 8080 });
console.log("WebSocket Server ứng dụng đang chạy tại port 8080...");

wss.on('connection', function connection(ws) {
  console.log("Có một phần mềm Client vừa kết nối thành công!");

  // Lắng nghe dữ liệu định dạng chuỗi từ phần mềm Client gửi lên
  ws.on('message', function message(data) {
    console.log('Dữ liệu nhận được ở Tầng ứng dụng: %s', data);
    
    // Phát tán (Broadcast) tin nhắn này tới tất cả các Client khác đang online
    wss.clients.forEach(function each(client) {
      if (client.readyState === 1) {
        client.send(`Người dùng khác: ${data}`);
      }
    });
  });
});
