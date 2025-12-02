// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const sendgrid = require("@sendgrid/mail");
const fs = require("fs");
const path = require("path");

// ===== init config =====
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "serviceAccountKey.json");
if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
  console.error("Missing serviceAccountKey.json - place it in project root or supply via Render secrets.");
  process.exit(1);
}
const serviceAccount = require(SERVICE_ACCOUNT_PATH);

const FIREBASE_DB_URL = process.env.FIREBASE_DATABASE_URL || "https://<your-project>.firebaseio.com";
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DB_URL
});
const rtdb = admin.database();

// SendGrid
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "no-reply@example.com";
const APP_URL = process.env.APP_URL || "https://esp32cam-cloud-relay.onrender.com";
if (!SENDGRID_API_KEY) {
  console.warn("WARN: SENDGRID_API_KEY not set. OTP emails will fail.");
}
sendgrid.setApiKey(SENDGRID_API_KEY);

// ===== server + ws (kept similar to your previous code) =====
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("ESP32-CAM relay running. Use /api/devices or /stream/:id");
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, path: "/ws" });

const devices = new Map();      // deviceId -> ws
const lastFrame = new Map();    // deviceId -> Buffer (last jpeg)
const streamClients = new Map(); // deviceId -> Set<res>

// handle ws upgrades
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// helper: generate OTP 6 digits
function genOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// helper: send OTP email via SendGrid
async function sendOtpEmail(email, deviceId, code) {
  const msg = {
    to: email,
    from: FROM_EMAIL,
    subject: `رمز التحقق لتشغيل الكاميرا ${deviceId}`,
    text: `رمز التحقق الخاص بك: ${code}`,
    html: `<p>رمز التحقق الخاص بك: <b>${code}</b></p><p>أو افتح هذه الصفحة للتحقق: <a href="${APP_URL}/verify/${deviceId}">${APP_URL}/verify/${deviceId}</a></p>`
  };
  await sendgrid.send(msg);
}

// WebSocket connection handling
wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (msg, isBinary) => {
    if (isBinary) {
      // binary frame (jpeg)
      if (!ws.deviceId) return;
      const buf = Buffer.from(msg);
      lastFrame.set(ws.deviceId, buf);
      // console log
      console.log(`binary frame received from ${ws.deviceId}, ${buf.length} bytes`);
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
            clients.delete(res);
            try { res.end(); } catch (er) {}
          }
        }
      }
      return;
    }

    // text message
    try {
      const json = JSON.parse(msg.toString());
      if (json.type === "hello" && json.deviceId) {
        ws.deviceId = json.deviceId;
        devices.set(json.deviceId, ws);
        console.log("Device connected:", json.deviceId);
        ws.send(JSON.stringify({ type: "hello_ack" }));

        // update lastSeen in RTDB
        try {
          await rtdb.ref(`devices/${json.deviceId}/lastSeen`).set(admin.database.ServerValue.TIMESTAMP);
        } catch (e) {
          console.warn("Failed to update lastSeen:", e.message || e);
        }

        // When device connects, server reads RTDB for device info (email, verified, pendingStart)
        try {
          const snap = await rtdb.ref(`devices/${json.deviceId}`).once("value");
          const dev = snap.exists() ? snap.val() : null;
          if (dev) {
            // if verified already and pendingStart flag present, or verified and auto-start desired
            if (dev.pendingStart) {
              // clear pendingStart then send start_stream
              await rtdb.ref(`devices/${json.deviceId}/pendingStart`).remove();
              try {
                ws.send(JSON.stringify({ cmd: "start_stream" }));
                console.log(`Sent start_stream to ${json.deviceId} on reconnect (pending)`);
              } catch (e) {
                console.error("send start_stream failed:", e.message || e);
              }
            }
          }
        } catch (e) {
          console.warn("Error reading device info on connect:", e.message || e);
        }

        // Optionally request immediate capture (not necessary)
        // ws.send(JSON.stringify({ cmd: "capture_now" }));
        return;
      }

      if (json.type === "frame" && json.reqId && json.data) {
        if (ws.deviceId) {
          const buf = Buffer.from(json.data, "base64");
          lastFrame.set(ws.deviceId, buf);
          console.log(`base64 frame stored for ${ws.deviceId}, ${buf.length} bytes`);
        }
        return;
      }

      // handle other text commands or client messages
      console.log("WS text message:", json);
    } catch (e) {
      console.error("Invalid WS message:", e);
    }
  });

  ws.on("close", (code, reason) => {
    if (ws.deviceId) {
      devices.delete(ws.deviceId);
      lastFrame.delete(ws.deviceId);
      console.log(`Device disconnected: ${ws.deviceId} (code=${code} reason=${reason})`);
    } else {
      console.log(`WS closed (no deviceId) code=${code} reason=${reason}`);
    }
  });

  ws.on("error", (err) => {
    console.error("WS error:", err && err.message ? err.message : err);
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
    res.write(`--frame\r\n`);
    res.write(`Content-Type: image/jpeg\r\n`);
    res.write(`Content-Length: ${l.length}\r\n\r\n`);
    res.write(l);
    res.write(`\r\n`);
  } else {
    const ws = devices.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log(`requesting immediate capture from ${id}`);
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

// 1) Register email - called by ESP (after successful WiFi connect)
app.post('/api/register_email', async (req, res) => {
  try {
    const { deviceId, email } = req.body;
    if (!deviceId || !email) return res.status(400).json({ error: 'missing' });
    await rtdb.ref(`devices/${deviceId}`).update({
      email,
      verified: false,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error("register_email error:", e);
    return res.status(500).json({ error: 'internal' });
  }
});

// 2) Request start -> server reads email from RTDB and sends OTP
app.post('/api/device/:id/request_start', async (req, res) => {
  const id = req.params.id;
  try {
    const devSnap = await rtdb.ref(`devices/${id}`).once("value");
    if (!devSnap.exists()) return res.status(404).json({ error: 'no_email_registered' });
    const dev = devSnap.val();
    const email = dev.email;
    if (!email) return res.status(400).json({ error: 'no_email' });

    // if already verified -> immediate start
    if (dev.verified === true) {
      const ws = devices.get(id);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // mark pendingStart so when device reconnects it starts
        await rtdb.ref(`devices/${id}`).update({ pendingStart: true });
        return res.json({ ok: true, started: false, note: 'device_offline_pending' });
      } else {
        ws.send(JSON.stringify({ cmd: 'start_stream' }));
        return res.json({ ok: true, started: true, note: 'already_verified' });
      }
    }

    // generate OTP and store in /otps/{id}
    const code = genOtp();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    await rtdb.ref(`otps/${id}`).set({
      code,
      email,
      expiresAt,
      used: false,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    // send email (async)
    try {
      await sendOtpEmail(email, id, code);
      return res.json({ ok: true, otp_sent: true });
    } catch (e) {
      console.error("sendOtpEmail failed:", e);
      return res.status(500).json({ error: 'email_failed' });
    }
  } catch (e) {
    console.error("request_start error:", e);
    return res.status(500).json({ error: 'internal' });
  }
});

// 3) Verify OTP
app.post('/api/device/:id/verify', async (req, res) => {
  const id = req.params.id;
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'missing_code' });

  try {
    const otpSnap = await rtdb.ref(`otps/${id}`).once("value");
    if (!otpSnap.exists()) return res.status(404).json({ error: 'no_otp' });
    const otp = otpSnap.val();
    if (otp.used) return res.status(400).json({ error: 'already_used' });
    if (Date.now() > otp.expiresAt) return res.status(400).json({ error: 'expired' });
    if (String(otp.code) !== String(code)) return res.status(400).json({ error: 'invalid' });

    // mark verified
    await rtdb.ref(`devices/${id}`).update({ verified: true, verifiedAt: admin.database.ServerValue.TIMESTAMP });
    await rtdb.ref(`otps/${id}`).update({ used: true, usedAt: admin.database.ServerValue.TIMESTAMP });

    // send start_stream if device connected
    const ws = devices.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ cmd: 'start_stream' }));
      return res.json({ ok: true, started: true });
    } else {
      // mark pendingStart
      await rtdb.ref(`devices/${id}`).update({ pendingStart: true });
      return res.json({ ok: true, started: false, note: 'device_offline_pending' });
    }
  } catch (e) {
    console.error("verify error:", e);
    return res.status(500).json({ error: 'internal' });
  }
});

// API: list devices online
app.get("/api/devices", (req, res) => {
  res.json({ online: Array.from(devices.keys()) });
});

// API: capture immediate (reuse existing logic)
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

// API: control stream (start/stop) - require verified state for start
app.post("/api/device/:id/stream", async (req, res) => {
  const id = req.params.id;
  const action = (req.query.action || "").toLowerCase();
  const ws = devices.get(id);
  if (!ws || ws.readyState !== WebSocket.OPEN) return res.status(404).json({ error: "device_offline" });

  if (action === "start") {
    // check verified
    const devSnap = await rtdb.ref(`devices/${id}`).once("value");
    const dev = devSnap.exists() ? devSnap.val() : null;
    if (!dev || dev.verified !== true) {
      return res.status(403).json({ error: 'not_verified' });
    }
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
