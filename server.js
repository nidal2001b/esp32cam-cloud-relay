// server.js
// Complete ESP32-CAM relay server with MJPEG streaming
// Dependencies: express, ws, body-parser
// Usage: node server.js   (or deploy to Render/Heroku/VPS)

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// Simple root page
app.get("/", (req, res) => {
  res.send("ESP32-CAM relay running. Use /api/devices or /stream/:id");
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, path: "/ws" });

// In-memory structures
const devices = new Map();      // deviceId -> ws
const lastFrame = new Map();    // deviceId -> Buffer (last jpeg)
const streamClients = new Map(); // deviceId -> Set<res>

// Upgrade HTTP -> WebSocket at /ws
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
    // If binary frame => treat as JPEG image from device
    if (isBinary) {
      if (!ws.deviceId) return;
      const buf = Buffer.from(msg);
      lastFrame.set(ws.deviceId, buf);

      // debug log
      console.log(`binary frame received from ${ws.deviceId}, ${buf.length} bytes`);

      // push to all HTTP clients subscribed to stream
      const clients = streamClients.get(ws.deviceId);
      if (clients) {
        for (const res of Array.from(clients)) {
          try {
            res.write(`--frame\r\n`);
            res.write(`Content-Type: image/jpeg\r\n`);
            res.write(`Content-Length: ${buf.length}\r\n\r\n`);
            res.write(buf);
            res.write(`\r\n`);
          } catch (e) {
            // remove broken client
            clients.delete(res);
            try { res.end(); } catch (er) {}
          }
        }
      }
      return;
    }

    // text JSON messages
    try {
      const json = JSON.parse(msg.toString());
      // handshake from device
      if (json.type === "hello" && json.deviceId) {
        ws.deviceId = json.deviceId;
        devices.set(json.deviceId, ws);
        console.log("Device connected:", json.deviceId);
        ws.send(JSON.stringify({ type: "hello_ack" }));
        return;
      }

      // device might send a base64 snapshot (legacy)
      if (json.type === "frame" && json.reqId && json.data) {
        if (ws.deviceId) {
          const buf = Buffer.from(json.data, "base64");
          lastFrame.set(ws.deviceId, buf);
          console.log(`base64 frame stored for ${ws.deviceId}, ${buf.length} bytes`);
        }
        return;
      }

      // handle other JSON messages if needed
    } catch (e) {
      console.error("Invalid WS message:", e);
    }
  });

  ws.on("close", () => {
    if (ws.deviceId) {
      devices.delete(ws.deviceId);
      lastFrame.delete(ws.deviceId);
      console.log("Device disconnected:", ws.deviceId);
    }
  });

  ws.on("error", (err) => {
    console.error("WS error:", err && err.message ? err.message : err);
  });
});

// ping/pong keepalive
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

/* ===========================
    HTTP: MJPEG stream endpoint
   =========================== */
app.get("/stream/:id", (req, res) => {
  const id = req.params.id;
  res.writeHead(200, {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Connection": "keep-alive"
  });

  // Immediately send last frame if available
  const l = lastFrame.get(id);
  if (l) {
    res.write(`--frame\r\n`);
    res.write(`Content-Type: image/jpeg\r\n`);
    res.write(`Content-Length: ${l.length}\r\n\r\n`);
    res.write(l);
    res.write(`\r\n`);
  } else {
    // ask device for an immediate capture if it's online
    const ws = devices.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log(`requesting immediate capture from ${id}`);
      ws.send(JSON.stringify({ cmd: "capture_now" }));
      // device should send a binary frame soon
    }
  }

  // register this response as a subscriber
  if (!streamClients.has(id)) streamClients.set(id, new Set());
  const clients = streamClients.get(id);
  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
  });
});

/* ===========================
    HTTP: API endpoints
   =========================== */

// list online devices
app.get("/api/devices", (req, res) => {
  res.json({ online: Array.from(devices.keys()) });
});

// snapshot: return last frame or request one
app.post("/api/device/:id/capture", async (req, res) => {
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

  // ask device for capture and wait up to 6s
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

// start/stop stream via server (sends WS cmd to device)
app.post("/api/device/:id/stream", (req, res) => {
  const id = req.params.id;
  const action = (req.query.action || "").toLowerCase();
  const ws = devices.get(id);
  if (!ws || ws.readyState !== WebSocket.OPEN) return res.status(404).json({ error: "device_offline" });

  if (action === "start") {
    ws.send(JSON.stringify({ cmd: "start_stream" }));
    console.log(`asked ${id} to start_stream`);
    return res.json({ ok: true, started: true });
  } else if (action === "stop") {
    ws.send(JSON.stringify({ cmd: "stop_stream" }));
    console.log(`asked ${id} to stop_stream`);
    return res.json({ ok: true, stopped: true });
  } else {
    return res.status(400).json({ error: "invalid_action" });
  }
});

/* ===========================
    Start server
   =========================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
