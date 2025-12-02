// server.js
// Complete ESP32-CAM relay server with Firebase RTDB + SendGrid + OTP + JWT session protection
// Uses FIREBASE_SERVICE_ACCOUNT_JSON env for service account, and expects JWT_SECRET & JWT_EXPIRES_SEC in ENV.

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

// ============================
// Load ENV
// ============================

const FIREBASE_DB_URL = process.env.FIREBASE_DATABASE_URL;
const SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON; // required
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;
const APP_URL = process.env.APP_URL || "https://esp32cam-cloud-relay.onrender.com";

const JWT_SECRET = process.env.JWT_SECRET || null;
const JWT_EXPIRES_SEC = parseInt(process.env.JWT_EXPIRES_SEC || "300", 10); // default 300s = 5min

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
if (!FROM_EMAIL) {
  console.error("❌ ERROR: FROM_EMAIL missing");
  process.exit(1);
}
if (!JWT_SECRET) {
  console.warn("⚠️ WARNING: JWT_SECRET not set. Tokens will be signed with default insecure secret. Set JWT_SECRET in env!");
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
app.use(cookieParser());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, path: "/ws" });

const devices = new Map(); // deviceId -> ws
const lastFrame = new Map(); // deviceId -> latest frame buffer
const streamClients = new Map(); // deviceId -> Set<res>

// ============================
// JWT helpers & middleware
// ============================

function signSessionToken(deviceId, email) {
  const payload = { sub: deviceId, email: email || "" };
  return jwt.sign(payload, JWT_SECRET || "change_me", { expiresIn: JWT_EXPIRES_SEC });
}

async function isTokenRevoked(token) {
  // Optional: implement lookup in RTDB if you want revocation support
  return false;
}

function verifySessionMiddleware(req, res, next) {
  let token = null;
  if (req.cookies && req.cookies.session) token = req.cookies.session;
  if (!token && req.headers && req.headers.authorization) {
    const parts = req.headers.authorization.split(" ");
    if (parts.length === 2 && parts[0] === "Bearer") token = parts[1];
  }
  if (!token) return res.status(401).json({ error: "unauthenticated" });

  try {
    // (optional) revocation check
    // if (await isTokenRevoked(token)) return res.status(401).json({ error: "revoked" });

    const decoded = jwt.verify(token, JWT_SECRET || "change_me");
    req.session = decoded; // { sub, email, iat, exp }
    req._sessionToken = token;
    next();
  } catch (e) {
    return res.status(401).json({ error: "invalid_token", message: e.message });
  }
}

// ============================
// WebSocket Upgrade
// ============================

server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/ws")) {
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
    html: `<h2>Your OTP: ${code}</h2><p>Device: ${deviceId}</p><p>Use this code to verify and start streaming. Expires in ${Math.round(JWT_EXPIRES_SEC/60)} minutes.</p>`,
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

          // Auto-start if pendingStart = true
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
        } else if (json.type === "auth" && json.token) {
          // optional: if you send auth via ws from client
          try {
            const decoded = jwt.verify(json.token, JWT_SECRET || "change_me");
            ws.auth = decoded;
            ws.send(JSON.stringify({ type: "auth_ok" }));
          } catch (e) {
            ws.send(JSON.stringify({ type: "auth_failed", message: e.message }));
            ws.terminate();
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
            try { res.end(); } catch (_) {}
          }
        }
      }
    }
  });

  ws.on("close", () => {
    if (ws.deviceId) {
      devices.delete(ws.deviceId);
      console.log("❌ Device disconnected:", ws.deviceId);
    } else {
      console.log("❌ WS closed (no deviceId)");
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

// Verify OTP -> ISSUE JWT + set HttpOnly cookie + start/pending
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

  // sign JWT & set cookie
  const token = signSessionToken(id, otp.email || "");
  res.cookie("session", token, {
    httpOnly: true,
    secure: true, // requires HTTPS (Render provides HTTPS)
    sameSite: "Strict",
    maxAge: JWT_EXPIRES_SEC * 1000,
    path: "/",
  });

  // try to start stream if device connected, else set pendingStart
  const ws = devices.get(id);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ cmd: "start_stream" }));
    return res.json({ ok: true, started: true, token });
  } else {
    await rtdb.ref(`devices/${id}`).update({ pendingStart: true });
    return res.json({ ok: true, started: false, token });
  }
});

// Protected capture endpoint (returns single JPEG)
app.post("/api/device/:id/capture", verifySessionMiddleware, async (req, res) => {
  const id = req.params.id;
  if (!req.session || req.session.sub !== id) return res.status(403).json({ error: "forbidden" });

  // return cached frame if available
  const cached = lastFrame.get(id);
  if (cached) {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": cached.length });
    return res.end(cached);
  }

  const ws = devices.get(id);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: "device_offline" });
  }

  // ask camera for immediate capture
  ws.send(JSON.stringify({ cmd: "capture_now" }));

  const timeoutMs = 6000;
  const start = Date.now();

  // poll for new frame
  while (Date.now() - start < timeoutMs) {
    const f = lastFrame.get(id);
    if (f && f.length > 0) {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": f.length });
      return res.end(f);
    }
    // sleep 200ms
    await new Promise((r) => setTimeout(r, 200));
  }

  return res.status(504).json({ error: "timeout" });
});

// MJPEG Stream (protected)
app.get("/stream/:id", verifySessionMiddleware, (req, res) => {
  const id = req.params.id;
  if (!req.session || req.session.sub !== id) return res.status(403).send("forbidden");

  res.writeHead(200, {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Connection": "keep-alive",
  });

  const buf = lastFrame.get(id);
  if (buf) {
    res.write(`--frame\r\n`);
    res.write(`Content-Type: image/jpeg\r\n`);
    res.write(`Content-Length: ${buf.length}\r\n\r\n`);
    res.write(buf);
    res.write(`\r\n`);
  } else {
    // If we have device connected, ask it to capture one
    const ws = devices.get(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ cmd: "capture_now" }));
      } catch (e) {
        console.error("Failed to request immediate capture:", e);
      }
    }
  }

  if (!streamClients.has(id)) streamClients.set(id, new Set());
  const clients = streamClients.get(id);
  clients.add(res);

  req.on("close", () => {
    const s = streamClients.get(id);
    if (s) s.delete(res);
  });
});

// ============================
// Start Server
// ============================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
});
