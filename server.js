// server.js
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(helmet());

// ---------- CONFIG via ENV ----------
const PORT = process.env.PORT || 3000;
const SERVICE_ACCOUNT_PATH = process.env.SERVICE_ACCOUNT_PATH || null; // path to JSON file (or null)
const SERVICE_ACCOUNT_JSON = process.env.SERVICE_ACCOUNT_JSON || null; // base64 JSON string alternative
const DB_URL = process.env.DB_URL || 'https://your-db.firebaseio.com'; // realtime db url
const EMAIL_FROM = process.env.EMAIL_FROM || 'your@gmail.com';
const EMAIL_SMTP_USER = process.env.EMAIL_SMTP_USER || process.env.EMAIL_FROM;
const EMAIL_SMTP_PASS = process.env.EMAIL_SMTP_PASS || null;
const OTP_TTL_MS = parseInt(process.env.OTP_TTL_MS || String(2 * 60 * 1000)); // default 2 minutes
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || String(15 * 60 * 1000)); // default 15 minutes
const RELAY_API_URL = process.env.RELAY_API_URL || ''; // optional: call to relay to forward start/stop

// ---------- init Firebase Admin ----------
let serviceAccount;
if (SERVICE_ACCOUNT_JSON) {
  // assume base64 or raw JSON string
  try {
    const jsonStr = Buffer.from(SERVICE_ACCOUNT_JSON, 'base64').toString();
    serviceAccount = JSON.parse(jsonStr);
  } catch (e) {
    console.error('Failed parse SERVICE_ACCOUNT_JSON', e);
    process.exit(1);
  }
} else if (SERVICE_ACCOUNT_PATH) {
  serviceAccount = require(SERVICE_ACCOUNT_PATH);
} else {
  console.error('Provide SERVICE_ACCOUNT_PATH or SERVICE_ACCOUNT_JSON env var');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DB_URL
});

const db = admin.database();

// ---------- init nodemailer ----------
if (!EMAIL_SMTP_PASS) {
  console.warn('EMAIL_SMTP_PASS not set — emails will fail unless SMTP credentials provided');
}
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_SMTP_USER,
    pass: EMAIL_SMTP_PASS
  }
});

// ---------- Helpers ----------
function genOtp6() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function nowMs() {
  return Date.now();
}

// ---------- Endpoints ----------

/**
 * Register device (called by ESP after provisioning)
 * body: { deviceId, ownerEmail, requireOtp (bool) }
 */
app.post('/register_device', async (req, res) => {
  try {
    const { deviceId, ownerEmail, requireOtp } = req.body;
    if (!deviceId || !ownerEmail) return res.status(400).json({ error: 'deviceId and ownerEmail required' });

    const path = `devices/${deviceId}`;
    const payload = {
      ownerEmail,
      requireOtp: !!requireOtp,
      createdAt: nowMs(),
      // fields for OTP/session flow
      otp: '',
      otpExpiresAt: 0,
      sessionToken: '',
      sessionExpiresAt: 0,
      streamRequested: false
    };

    await db.ref(path).set(payload);
    return res.json({ ok: true });
  } catch (e) {
    console.error('register_device error', e);
    return res.status(500).json({ error: 'server_error', details: e.message });
  }
});

/**
 * Request OTP — server generates OTP and emails it to ownerEmail from DB.
 * body: { deviceId }
 */
app.post('/request-otp', async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const devSnap = await db.ref(`devices/${deviceId}`).once('value');
    if (!devSnap.exists()) return res.status(404).json({ error: 'device not found' });

    const dev = devSnap.val();
    const ownerEmail = dev.ownerEmail;
    if (!ownerEmail) return res.status(400).json({ error: 'ownerEmail not configured' });

    // generate OTP and store as a child node (keeps history) AND write latest fields for compatibility
    const otp = genOtp6();
    const createdAt = nowMs();
    const expiresAt = createdAt + OTP_TTL_MS;

    // push under view_otps/{deviceId}/{pushId}
    const pushRef = db.ref(`view_otps/${deviceId}`).push();
    await pushRef.set({
      otp,
      createdAt,
      expiresAt,
      used: false
    });

    // Also store last-otp fields (optional, for devices that read single path)
    await db.ref(`devices/${deviceId}`).update({
      otp: otp,
      otpExpiresAt: expiresAt
    });

    // send email
    const mailOptions = {
      from: EMAIL_FROM,
      to: ownerEmail,
      subject: `Your camera OTP (${deviceId})`,
      text: `Your OTP to view camera ${deviceId} is: ${otp}\nIt expires in ${Math.round(OTP_TTL_MS / 1000)} seconds.`
    };

    await transporter.sendMail(mailOptions);

    return res.json({ ok: true, expiresAt });
  } catch (e) {
    console.error('request-otp error', e);
    return res.status(500).json({ error: 'server_error', details: e.message });
  }
});

/**
 * Verify OTP -> create session token
 * body: { deviceId, otp }
 */
app.post('/verify-otp', async (req, res) => {
  try {
    const { deviceId, otp } = req.body;
    if (!deviceId || !otp) return res.status(400).json({ error: 'deviceId and otp required' });

    // search for a non-used, non-expired OTP under view_otps/{deviceId}
    const otpsSnap = await db.ref(`view_otps/${deviceId}`).orderByChild('otp').equalTo(otp).once('value');
    if (!otpsSnap.exists()) return res.status(401).json({ error: 'invalid_otp' });

    // find matching record that is not used and not expired
    let matchedKey = null;
    let matchedVal = null;
    otpsSnap.forEach(child => {
      const v = child.val();
      if (!v.used && v.expiresAt && v.expiresAt > nowMs()) {
        matchedKey = child.key;
        matchedVal = v;
      }
    });

    if (!matchedKey) return res.status(401).json({ error: 'invalid_or_expired_otp' });

    // mark otp used
    await db.ref(`view_otps/${deviceId}/${matchedKey}`).update({ used: true, usedAt: nowMs() });

    // create session token
    const token = uuidv4(); // random UUID
    const createdAt = nowMs();
    const expiresAt = createdAt + SESSION_TTL_MS;

    const sessionObj = {
      deviceId,
      createdAt,
      expiresAt,
      used: false
    };

    await db.ref(`sessions/${token}`).set(sessionObj);

    // optionally write current session on device node
    await db.ref(`devices/${deviceId}`).update({
      sessionToken: token,
      sessionExpiresAt: expiresAt
    });

    return res.json({ ok: true, sessionToken: token, expiresAt });
  } catch (e) {
    console.error('verify-otp error', e);
    return res.status(500).json({ error: 'server_error', details: e.message });
  }
});

/**
 * Use session token to request start-stream
 * body: { deviceId, sessionToken }
 */
app.post('/start-stream', async (req, res) => {
  try {
    const { deviceId, sessionToken } = req.body;
    if (!deviceId || !sessionToken) return res.status(400).json({ error: 'deviceId and sessionToken required' });

    const sSnap = await db.ref(`sessions/${sessionToken}`).once('value');
    if (!sSnap.exists()) return res.status(401).json({ error: 'invalid_session' });

    const s = sSnap.val();
    if (s.used) return res.status(401).json({ error: 'session_used' });
    if (s.deviceId !== deviceId) return res.status(401).json({ error: 'session_device_mismatch' });
    if (s.expiresAt < nowMs()) return res.status(401).json({ error: 'session_expired' });

    // mark session as used (single-use) OR keep used=false depending on behavior
    await db.ref(`sessions/${sessionToken}`).update({ used: true, usedAt: nowMs() });

    // set device streamRequested true (camera polls DB per our esp code)
    await db.ref(`devices/${deviceId}`).update({
      streamRequested: true,
      sessionToken: sessionToken // device can read this to validate
    });

    // optional: if you have RELAY_API_URL, call it to instruct relay to send start_stream to camera
    if (RELAY_API_URL) {
      try {
        const fetch = require('node-fetch');
        await fetch(RELAY_API_URL + '/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, cmd: 'start_stream', sessionToken })
        });
      } catch (e) {
        console.warn('relay API call failed', e.message);
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('start-stream error', e);
    return res.status(500).json({ error: 'server_error', details: e.message });
  }
});

/**
 * Stop stream (optional) - invalidates device streamRequested
 * body: { deviceId }
 */
app.post('/stop-stream', async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    await db.ref(`devices/${deviceId}`).update({ streamRequested: false });

    // optional relay call
    if (RELAY_API_URL) {
      try {
        const fetch = require('node-fetch');
        await fetch(RELAY_API_URL + '/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, cmd: 'stop_stream' })
        });
      } catch (e) {
        console.warn('relay API call failed', e.message);
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('stop-stream error', e);
    return res.status(500).json({ error: 'server_error', details: e.message });
  }
});

// health
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
