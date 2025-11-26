// server.js
// Simple ESP32-CAM Cloud Relay Server
// Requires: express, ws, body-parser

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// Store connected devices: Map<deviceId, WebSocket>
const devices = new Map();

// Pending capture requests: Map<reqId, {resolve, reject, timer}>
const pending = new Map();

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server on path "/ws"
const wss = new WebSocket.Server({ noServer: true, path: "/ws" });

// Upgrade HTTP → WebSocket
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// WebSocket connection handler (ESP32 connects here)
wss.on("connection", (ws, req) => {
  ws.isAlive = true;

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (msg) => {
    try {
      const data = msg.toString();
      const json = JSON.parse(data);

      // Device handshake
      if (json.type === "hello" && json.deviceId) {
        ws.deviceId = json.deviceId;
        devices.set(json.deviceId, ws);
        console.log("Device connected:", json.deviceId);
        ws.send(JSON.stringify({ type: "hello_ack" }));
        return;
      }

      // Device returned a captured frame
      if (json.type === "frame" && json.reqId) {
        const p = pending.get(json.reqId);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(json.reqId);
          p.resolve(json.data); // base64 image
        }
        return;
      }
    } catch (e) {
      console.error("Invalid WS message:", e);
    }
  });

  ws.on("close", () => {
    if (ws.deviceId) {
      devices.delete(ws.deviceId);
      console.log("Device disconnected:", ws.deviceId);
    }
  });
});

// Ping devices regularly
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

/* ===========================
    HTTP API: Capture Image
   =========================== */
app.post("/api/device/:id/capture", async (req, res) => {
  const id = req.params.id;
  const ws = devices.get(id);

  if (!ws || ws.readyState !== WebSocket.OPEN)
    return res.status(404).json({ error: "device_offline" });

  const reqId = Date.now().toString() + "-" + Math.random().toString(36).slice(2);
  const command = { cmd: "capture", reqId };

  // Promise waiting for frame
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error("timeout"));
    }, 10000);

    pending.set(reqId, { resolve, reject, timer });
  });

  try {
    ws.send(JSON.stringify(command));
  } catch (e) {
    pending.delete(reqId);
    return res.status(500).json({ error: "send_failed" });
  }

  try {
    const base64Img = await promise;
    const buffer = Buffer.from(base64Img, "base64");

    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": buffer.length,
      "Cache-Control": "no-cache",
    });

    res.end(buffer);
  } catch (e) {
    return res.status(504).json({ error: "timeout_waiting_device" });
  }
});

/* ===========================
    HTTP API: List Devices
   =========================== */
app.get("/api/devices", (req, res) => {
  res.json({ online: Array.from(devices.keys()) });
});

// Start server (Railway uses PORT env variable)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
