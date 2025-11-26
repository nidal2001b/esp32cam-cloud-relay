// server.js
// MJPEG-capable relay: devices -> server via WSS (binary frames), clients -> /stream/:id (MJPEG)

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, path: "/ws" });

// Maps
const devices = new Map();      // deviceId -> ws
const lastFrame = new Map();    // deviceId -> Buffer (last jpeg)
const streamClients = new Map(); // deviceId -> Set<res>

// upgrade handler
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (msg, isBinary) => {
    // if binary => treat as a JPEG frame (must be associated with ws.deviceId)
    if (isBinary) {
      if (!ws.deviceId) return;
      const buf = Buffer.from(msg);
      lastFrame.set(ws.deviceId, buf);
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
            // likely client disconnected unexpectedly
            clients.delete(res);
            try { res.end(); } catch (er){}
          }
        }
      }
      return;
    }

    // text messages (json)
    try {
      const json = JSON.parse(msg.toString());
      if (json.type === "hello" && json.deviceId) {
        ws.deviceId = json.deviceId;
        devices.set(json.deviceId, ws);
        console.log("Device connected:", json.deviceId);
        ws.send(JSON.stringify({ type: "hello_ack" }));
        return;
      }
      // device can also send JSON frame responses (legacy)
      if (json.type === "frame" && json.reqId && json.data) {
        // base64 frame (legacy snapshot). store as Buffer
        const buf = Buffer.from(json.data, "base64");
        lastFrame.set(ws.deviceId, buf);
        // handle pending snapshot logic if you implemented it elsewhere
        return;
      }
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
});

// ping/pong health
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

/* ===========================
    HTTP API: MJPEG stream endpoint
   =========================== */
app.get("/stream/:id", (req, res) => {
  const id = req.params.id;
  res.writeHead(200, {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Connection": "keep-alive"
  });

  // send last frame quickly (if any)
  const l = lastFrame.get(id);
  if (l) {
    res.write(`--frame\r\n`);
    res.write(`Content-Type: image/jpeg\r\n`);
    res.write(`Content-Length: ${l.length}\r\n\r\n`);
    res.write(l);
    res.write(`\r\n`);
  } else {
    // optionally request an immediate capture from device
    const ws = devices.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ cmd: "capture_now" }));
      // device should send a binary frame shortly
    }
  }

  // register client
  if (!streamClients.has(id)) streamClients.set(id, new Set());
  const clients = streamClients.get(id);
  clients.add(res);

  // on client close, remove from set
  req.on("close", () => {
    clients.delete(res);
  });
});

/* ===========================
    HTTP API: List Devices and snapshot fallback
   =========================== */
app.get("/api/devices", (req, res) => {
  res.json({ online: Array.from(devices.keys()) });
});

// snapshot endpoint: return lastFrame if exists, else ask device for one (simple fallback)
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

  // wait for next binary frame (one-time)
  let done = false;
  const handler = (buffer) => {
    if (done) return;
    done = true;
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": buffer.length });
    res.end(buffer);
  };

  // temporarly listen for next frame by monkey-patching lastFrame change: simplest approach is to wait up to 6s polling
  const timeout = setTimeout(() => {
    if (!done) {
      done = true;
      res.status(504).json({ error: "timeout" });
    }
  }, 6000);

  // ask device for immediate capture
  ws.send(JSON.stringify({ cmd: "capture_now" }));

  // poll for lastFrame change (cheap and safe)
  const start = Date.now();
  const interval = setInterval(() => {
    const f = lastFrame.get(id);
    if (f && f.length > 0) {
      clearInterval(interval);
      clearTimeout(timeout);
      if (!done) handler(f);
    } else if (Date.now() - start > 6000) {
      clearInterval(interval);
    }
  }, 250);
});

/* ===========================
    Start server
   =========================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

