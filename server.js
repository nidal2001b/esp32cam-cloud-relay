// server.js
// Complete ESP32-CAM relay server with MJPEG streaming and auto-start on hello
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("ESP32-CAM relay running. Use /api/devices or /stream/:id");
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, path: "/ws" });

const devices = new Map();      // deviceId -> ws
const lastFrame = new Map();    // deviceId -> Buffer (last jpeg)
const streamClients = new Map(); // deviceId -> Set<res>

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (msg, isBinary) => {
    if (isBinary) {
      if (!ws.deviceId) return;
      const buf = Buffer.from(msg);
      lastFrame.set(ws.deviceId, buf);
      console.log(binary frame received from ${ws.deviceId}, ${buf.length} bytes);
      const clients = streamClients.get(ws.deviceId);
      if (clients) {
        for (const res of Array.from(clients)) {
          try {
            res.write(--frame\r\n);
            res.write(Content-Type: image/jpeg\r\n);
            res.write(Content-Length: ${buf.length}\r\n\r\n);
            res.write(buf);
            res.write(\r\n);
          } catch (e) {
            clients.delete(res);
            try { res.end(); } catch (er) {}
          }
        }
      }
      return;
    }

    try {
      const json = JSON.parse(msg.toString());
      if (json.type === "hello" && json.deviceId) {
        ws.deviceId = json.deviceId;
        devices.set(json.deviceId, ws);
        console.log("Device connected:", json.deviceId);
        ws.send(JSON.stringify({ type: "hello_ack" }));

        // <<< auto-start stream immediately after handshake
        try {
          ws.send(JSON.stringify({ cmd: "start_stream" }));
          console.log(sent start_stream to ${json.deviceId});
        } catch (e) {
          console.error("failed to send start_stream:", e && e.message ? e.message : e);
        }
        return;
      }

      if (json.type === "frame" && json.reqId && json.data) {
        if (ws.deviceId) {
          const buf = Buffer.from(json.data, "base64");
          lastFrame.set(ws.deviceId, buf);
          console.log(base64 frame stored for ${ws.deviceId}, ${buf.length} bytes);
        }
        return;
      }
    } catch (e) {
      console.error("Invalid WS message:", e);
    }
  });

  ws.on("close", (code, reason) => {
    if (ws.deviceId) {
      devices.delete(ws.deviceId);
      lastFrame.delete(ws.deviceId);
      console.log(Device disconnected: ${ws.deviceId} (code=${code} reason=${reason}));
    } else {
      console.log(WS closed (no deviceId) code=${code} reason=${reason});
    }
  });

  ws.on("error", (err) => {
    console.error("WS error:", err && err.message ? err.message : err);
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

/* MJPEG stream endpoint */
app.get("/stream/:id", (req, res) => {
  const id = req.params.id;
  res.writeHead(200, {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Connection": "keep-alive"
  });

  const l = lastFrame.get(id);
  if (l) {
    res.write(--frame\r\n);
    res.write(Content-Type: image/jpeg\r\n);
    res.write(Content-Length: ${l.length}\r\n\r\n);
    res.write(l);
    res.write(\r\n);
  } else {
    const ws = devices.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log(requesting immediate capture from ${id});
      ws.send(JSON.stringify({ cmd: "capture_now" }));
    }
  }

  if (!streamClients.has(id)) streamClients.set(id, new Set());
  const clients = streamClients.get(id);
  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
  });
});

/* API endpoints */
app.get("/api/devices", (req, res) => {
  res.json({ online: Array.from(devices.keys()) });
});

app.post("/api/device/:id/capture", (req, res) => {
  const id = req.params.id;
  const ws = devices.get(id);
  const cached = lastFrame.get(id);
  if (cached) {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": cached.length });
    return res.end(cached);
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: "device_offline" });
  }

  ws.send(JSON.stringify({ cmd: "capture_now" }));

  const start = Date.now();
  const timeoutMs = 6000;
  const interval = setInterval(() => {
    const f = lastFrame.get(id);
    if (f && f.length > 0) {
      clearInterval(interval);
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": f.length });
      return res.end(f);
    }
    if (Date.now() - start > timeoutMs) {
      clearInterval(interval);
      return res.status(504).json({ error: "timeout" });
    }
  }, 250);
});

app.post("/api/device/:id/stream", (req, res) => {
  const id = req.params.id;
  const action = (req.query.action || "").toLowerCase();
  const ws = devices.get(id);
  if (!ws || ws.readyState !== WebSocket.OPEN) return res.status(404).json({ error: "device_offline" });

  if (action === "start") {
    ws.send(JSON.stringify({ cmd: "start_stream" }));
    console.log(asked ${id} to start_stream);
    return res.json({ ok: true, started: true });
  } else if (action === "stop") {
    ws.send(JSON.stringify({ cmd: "stop_stream" }));
    console.log(asked ${id} to stop_stream);
    return res.json({ ok: true, stopped: true });
  } else {
    return res.status(400).json({ error: "invalid_action" });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
