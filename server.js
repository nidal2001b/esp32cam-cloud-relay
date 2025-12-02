// server.js
// Complete ESP32-CAM relay server with Firebase RTDB + SendGrid + OTP
// Includes support for FIREBASE_SERVICE_ACCOUNT_JSON env variable (your env name)

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");

// ============================
// Load ENV
// ============================

const FIREBASE_DB_URL = process.env.FIREBASE_DATABASE_URL;
const SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON; // YOU ARE USING THIS
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;
const APP_URL = process.env.APP_URL || "https://esp32cam-cloud-relay.onrender.com";

if (!SERVICE_ACCOUNT_JSON) {
  console.error("❌ ERROR: FIREBASE_SERVICE_ACCOUNT_JSON not found in ENV");
  process.exit(1);
}

if (!FIREBASE_DB_URL) {
  console.error("❌ ERROR: FIREBASE_DATABASE_URL not found");
  process.exit(1);
}

if (!SENDGRID_API_KEY) {
  console.error("❌ ERROR: SENDGRID_API_KEY missing");
  process.exit(1);
}

// ============================
// Init Firebase Admin
// ============================

let serviceAccountObj = null;

try {
  if (SERVICE_ACCOUNT_JSON.trim().startsWith("{")) {
    serviceAccountObj = JSON.parse(SERVICE_ACCOUNT_JSON);
    console.log("✔ Loaded Firebase service account from FIREBASE_SERVICE_ACCOUNT_JSON (raw JSON).");
  } else {
    const decoded = Buffer.from(SERVICE_ACCOUNT_JSON, "base64").toString("utf8");
    serviceAccountObj = JSON.parse(decoded);
    console.log("✔ Loaded Firebase service account from FIREBASE_SERVICE_ACCOUNT_JSON (base64).");
  }
} catch (e) {
  console.error("❌ Invalid FIREBASE_SERVICE_ACCOUNT_JSON:", e);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccountObj),
  databaseURL: FIREBASE_DB_URL,
});

const rtdb = admin.database();

// ============================
// Initialize SendGrid
// ============================
sgMail.setApiKey(SENDGRID_API_KEY);

// ============================
// Express + WS Setup
// ============================

const app = express();
app.use(bodyParser.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, path: "/ws" });

const devices = new Map(); // deviceId -> ws
const lastFrame = new Map(); // deviceId -> latest frame buffer
const streamClients = new Map(); // deviceId -> Set<res>

// ============================
// WebSocket Upgrade
// ============================

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ============================
// OTP Helpers
// ============================

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendEmailOTP(to, code, deviceId) {
  const msg = {
    to,
    from: FROM_EMAIL,
    subject: `Camera Verification Code`,
    text: `Your verification code: ${code}\nDevice: ${deviceId}`,
    html: `<h2>Your OTP: ${code}</h2><p>Device: ${deviceId}</p>`,
  };

  await sgMail.send(msg);
}

// ============================
// WS Events
// ============================

wss.on("connection", (ws) => {
  ws.isAlive = true;

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (msg, isBinary) => {
    if (!isBinary) {
      try {
        const json = JSON.parse(msg.toString());
        if (json.type === "hello" && json.deviceId) {
          ws.deviceId = json.deviceId;
          devices.set(json.deviceId, ws);

          await rtdb.ref(`devices/${json.deviceId}`).update({
            lastSeen: Date.now(),
          });

          ws.send(JSON.stringify({ type: "hello_ack" }));

          console.log("✔ Device connected:", json.deviceId);

          const devSnap = await rtdb.ref(`devices/${json.deviceId}/pendingStart`).get();
          if (devSnap.exists() && devSnap.val() === true) {
            try {
              ws.send(JSON.stringify({ cmd: "start_stream" }));
              console.log("🔥 Auto-start stream for", json.deviceId);

              await rtdb.ref(`devices/${json.deviceId}`).update({
                pendingStart: false,
              });
            } catch (e) {
              console.error("Failed auto start:", e);
            }
          }
        }
      } catch (e) {
        console.error("Invalid WS JSON:", e);
      }
      return;
    }

    if (isBinary) {
      if (!ws.deviceId) return;

      const buf = Buffer.from(msg);
      lastFrame.set(ws.deviceId, buf);

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
            try {
              res.end();
            } catch (_) {}
          }
        }
      }
    }
  });

  ws.on("close", () => {
    if (ws.deviceId) {
      devices.delete(ws.deviceId);
      console.log("❌ Device disconnected:", ws.deviceId);
    }
  });

  ws.on("error", (err) => {
    console.error("WS Error:", err);
  });
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

// ============================
// HTTP API
// ============================

app.get("/", (req, res) => {
  res.send("ESP32 CAM RELAY OK");
});

// Register device email
app.post("/api/register_email", async (req, res) => {
  const { deviceId, email } = req.body;

  if (!deviceId || !email) {
    return res.status(400).json({ error: "missing_fields" });
  }

  await rtdb.ref(`devices/${deviceId}`).update({
    email,
    verified: false,
    createdAt: Date.now(),
  });

  console.log("📩 Registered email for", deviceId);

  res.json({ ok: true });
});

// Request start
app.post("/api/device/:id/request_start", async (req, res) => {
  const id = req.params.id;
  const devSnap = await rtdb.ref(`devices/${id}`).get();

  if (!devSnap.exists()) return res.status(404).json({ error: "device_not_found" });

  const dev = devSnap.val();

  if (dev.verified === true) {
    const ws = devices.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ cmd: "start_stream" }));
      return res.json({ ok: true, started: true });
    } else {
      await rtdb.ref(`devices/${id}`).update({ pendingStart: true });
      return res.json({ ok: true, started: false });
    }
  }

  const code = generateOTP();
  await rtdb.ref(`otps/${id}`).set({
    code,
    email: dev.email,
    createdAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000,
    used: false,
  });

  await sendEmailOTP(dev.email, code, id);

  res.json({ ok: true, otp_sent: true });
});

// Verify OTP
app.post("/api/device/:id/verify", async (req, res) => {
  const id = req.params.id;
  const { code } = req.body;

  const otpSnap = await rtdb.ref(`otps/${id}`).get();
  if (!otpSnap.exists()) return res.status(404).json({ error: "no_otp" });

  const otp = otpSnap.val();
  if (otp.used) return res.status(400).json({ error: "already_used" });
  if (Date.now() > otp.expiresAt) return res.status(400).json({ error: "expired" });
  if (otp.code !== code) return res.status(400).json({ error: "wrong_code" });

  await rtdb.ref(`otps/${id}`).update({ used: true });
  await rtdb.ref(`devices/${id}`).update({
    verified: true,
    verifiedAt: Date.now(),
  });

  const ws = devices.get(id);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ cmd: "start_stream" }));
    return res.json({ ok: true, started: true });
  } else {
    await rtdb.ref(`devices/${id}`).update({ pendingStart: true });
    return res.json({ ok: true, started: false });
  }
});

// MJPEG Stream
app.get("/stream/:id", (req, res) => {
  const id = req.params.id;

  res.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    Connection: "keep-alive",
  });

  const buf = lastFrame.get(id);
  if (buf) {
    res.write(`--frame\r\n`);
    res.write(`Content-Type: image/jpeg\r\n`);
    res.write(`Content-Length: ${buf.length}\r\n\r\n`);
    res.write(buf);
    res.write(`\r\n`);
  }

  if (!streamClients.has(id)) streamClients.set(id, new Set());
  streamClients.get(id).add(res);

  req.on("close", () => {
    streamClients.get(id).delete(res);
  });
});

// ============================
// Start Server
// ============================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
});
