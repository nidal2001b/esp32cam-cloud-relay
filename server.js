// server.js
// Relay server: Firebase listener + SendGrid OTP + WebSocket relay
// Required env vars: SENDGRID_API_KEY, FROM_EMAIL, FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_DATABASE_URL

const fs = require('fs');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const WebSocket = require('ws');
const sgMail = require('@sendgrid/mail');

const PORT = process.env.PORT || 10000;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;
const SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const DB_URL = process.env.FIREBASE_DATABASE_URL;

if (!SENDGRID_API_KEY || !FROM_EMAIL || !SERVICE_ACCOUNT_JSON || !DB_URL) {
  console.error('Missing required env vars: SENDGRID_API_KEY, FROM_EMAIL, FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_DATABASE_URL');
  process.exit(1);
}

sgMail.setApiKey(SENDGRID_API_KEY);

// Initialize Firebase Admin
let serviceAccount;
try {
  if (SERVICE_ACCOUNT_JSON.trim().startsWith('{')) {
    serviceAccount = JSON.parse(SERVICE_ACCOUNT_JSON);
  } else {
    serviceAccount = require(SERVICE_ACCOUNT_JSON);
  }
} catch (e) {
  console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', e);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DB_URL
});

const db = admin.database();

// In-memory stores
const sessions = new Map(); // deviceId -> { token, email, expiresAt }
const clients = new Map();  // deviceId -> ws (camera)
const viewers = new Map();  // deviceId -> Set(ws) (viewers)

const app = express();
app.use(bodyParser.json());
app.get('/health', (req, res) => res.json({ ok: true }));

// register_device (camera posts this after connecting to WiFi)
app.post('/register_device', async (req, res) => {
  const { deviceId, email, ssid } = req.body || {};
  if (!deviceId || !email) return res.status(400).json({ ok:false, error:'deviceId,email required' });
  try {
    const ref = db.ref(`/devices/${deviceId}/config`);
    await ref.update({ email, ssid, registeredAt: Date.now() });
    console.log('Registered device', deviceId, email);
    return res.json({ ok:true });
  } catch (e) {
    console.error('register_device error', e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// request_otp - convenience endpoint (writes otp_request to Firebase)
app.post('/request_otp', async (req, res) => {
  const { deviceId, email } = req.body || {};
  if (!deviceId || !email) return res.status(400).json({ ok:false, error:'deviceId,email required' });
  try {
    await db.ref(`/devices/${deviceId}/live/otp_request`).set({ email, timestamp: Date.now(), status: 'pending' });
    console.log('OTP request written for', deviceId, email);
    return res.json({ ok:true });
  } catch (e) {
    console.error('request_otp error', e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// verify_otp - convenience endpoint (writes otp_verify to Firebase)
app.post('/verify_otp', async (req, res) => {
  const { deviceId, email, otp } = req.body || {};
  if (!deviceId || !email || !otp) return res.status(400).json({ ok:false, error:'deviceId,email,otp required' });
  try {
    await db.ref(`/devices/${deviceId}/live/otp_verify`).set({ email, otp, timestamp: Date.now(), status: 'pending' });
    console.log('OTP verify request written for', deviceId, email);
    return res.json({ ok:true });
  } catch (e) {
    console.error('verify_otp error', e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// command endpoint - forward cmd to camera (requires valid session)
app.post('/command', async (req, res) => {
  const { deviceId, email, token, cmd } = req.body || {};
  if (!deviceId || !email || !token || !cmd) return res.status(400).json({ ok:false, error:'missing' });

  // quick memory check
  let sess = sessions.get(deviceId);
  if (!sess || sess.email !== email || sess.token !== token || Date.now() > sess.expiresAt) {
    // fallback to DB
    try {
      const snap = await db.ref(`/devices/${deviceId}/live/session`).once('value');
      const dbSess = snap.val();
      if (dbSess && dbSess.email === email && dbSess.token === token && Date.now() < (dbSess.expiresAt || 0)) {
        sessions.set(deviceId, { token: dbSess.token, email: dbSess.email, expiresAt: dbSess.expiresAt });
        sess = sessions.get(deviceId);
      } else {
        return res.status(403).json({ ok:false, error:'invalid session' });
      }
    } catch (e) {
      console.error('Error while validating session from DB:', e);
      return res.status(500).json({ ok:false, error:'internal' });
    }
  }

  const cam = clients.get(deviceId);
  if (!cam || cam.readyState !== WebSocket.OPEN) {
    return res.status(500).json({ ok:false, error:'camera not connected' });
  }
  try {
    cam.send(JSON.stringify({ type:'cmd', payload:{ cmd, email, token } }));
    console.log(`Forwarded command ${cmd} to camera ${deviceId}`);
    return res.json({ ok:true });
  } catch (e) {
    console.error('Error sending command to camera', e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// push_session - read session from DB and push auth_grant to camera if connected
app.post('/push_session', async (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ ok:false, error:'deviceId required' });
  try {
    const snap = await db.ref(`/devices/${deviceId}/live/session`).once('value');
    const sess = snap.val();
    if (!sess || !sess.token) return res.status(404).json({ ok:false, error:'no session in DB' });
    const cam = clients.get(deviceId);
    if (!cam || cam.readyState !== WebSocket.OPEN) {
      return res.status(500).json({ ok:false, error:'camera not connected' });
    }
    const ttl = Math.max(0, (sess.expiresAt || 0) - Date.now());
    const payload = { type:'auth_grant', deviceId, email: sess.email, token: sess.token, ttl_ms: ttl };
    cam.send(JSON.stringify(payload));
    sessions.set(deviceId, { token: sess.token, email: sess.email, expiresAt: sess.expiresAt });
    console.log(`Pushed session on-demand to camera ${deviceId}`);
    return res.json({ ok:true });
  } catch (e) {
    console.error('push_session error', e);
    return res.status(500).json({ ok:false, error: String(e) });
  }
});

// create server + ws
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// WebSocket message handling
wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', (msg) => {
    (async function handleMessage() {
      try {
        if (typeof msg === 'string') {
          // debug print
          try { console.log('WS text received:', msg); } catch(e){}

          let obj;
          try { obj = JSON.parse(msg); } catch (e) {
            console.log('WS: invalid JSON text message:', e);
            return;
          }

          if (obj.type === 'hello' && obj.deviceId && obj.role) {
            ws.deviceId = obj.deviceId;
            ws.role = obj.role;

            if (obj.role === 'camera') {
              clients.set(obj.deviceId, ws);
              console.log(`Camera connected (hello): ${obj.deviceId}`);

              // check DB for existing session and push auth_grant if present
              try {
                const sessSnap = await db.ref(`/devices/${obj.deviceId}/live/session`).once('value');
                const sess = sessSnap.val();
                if (sess && sess.token && sess.email && sess.expiresAt && Date.now() < (sess.expiresAt || 0)) {
                  const ttl = Math.max(0, sess.expiresAt - Date.now());
                  const payload = {
                    type: 'auth_grant',
                    deviceId: obj.deviceId,
                    email: sess.email,
                    token: sess.token,
                    ttl_ms: ttl
                  };
                  try {
                    ws.send(JSON.stringify(payload));
                    console.log(`Pushed stored auth_grant to camera ${obj.deviceId} (session from DB).`);
                    sessions.set(obj.deviceId, { token: sess.token, email: sess.email, expiresAt: sess.expiresAt });
                  } catch (e) {
                    console.error('Failed sending auth_grant to camera after hello:', e);
                  }
                } else {
                  console.log(`No valid stored session in DB for ${obj.deviceId} (or expired).`);
                }
              } catch (e) {
                console.error('Error while checking/pushing stored session to camera:', e);
              }

            } else if (obj.role === 'viewer') {
              let s = viewers.get(obj.deviceId);
              if (!s) { s = new Set(); viewers.set(obj.deviceId, s); }
              s.add(ws);
              console.log(`Viewer connected for ${obj.deviceId}`);
            }
            return;
          } else if (obj.type === 'control' && ws.role === 'viewer') {
            const cam = clients.get(obj.deviceId);
            if (cam && cam.readyState === WebSocket.OPEN) cam.send(JSON.stringify(obj));
            return;
          } else if (obj.type === 'auth_grant' && ws.role === 'camera') {
            console.log('Camera auth_grant ack or message:', obj);
            return;
          }
        } else {
          // binary frame from camera -> forward to viewers
          if (ws.role === 'camera' && ws.deviceId) {
            const s = viewers.get(ws.deviceId);
            if (s) {
              for (const v of s) {
                if (v.readyState === WebSocket.OPEN) {
                  try { v.send(msg); } catch(e) {}
                }
              }
            }
          }
        }
      } catch (e) {
        console.error('Error in WS message handler:', e);
      }
    })();
  });

  ws.on('close', () => {
    if (ws.role === 'camera' && ws.deviceId) {
      const mapped = clients.get(ws.deviceId);
      if (mapped === ws) {
        clients.delete(ws.deviceId);
        console.log('Camera disconnected', ws.deviceId);
      }
    } else if (ws.role === 'viewer' && ws.deviceId) {
      const s = viewers.get(ws.deviceId);
      if (s) s.delete(ws);
    }
  });

  ws.on('error', (err) => {
    console.error('WS socket error:', err);
  });
});

// keepalive ping/pong
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch(e) {}
  });
}, 30000);

// helpers
function genOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function genToken() {
  return [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
}

// watch device flows
function watchDevice(deviceId) {
  console.log('Watching device:', deviceId);
  const otpReqRef = db.ref(`/devices/${deviceId}/live/otp_request`);
  otpReqRef.on('value', async (snap) => {
    const val = snap.val();
    if (!val) return;
    if (val.status && val.status !== 'pending') return;
    if (!val.email) return;
    try {
      await otpReqRef.update({ status: 'processing' });
      const otp = genOtp();
      await db.ref(`/devices/${deviceId}/live/otp_expected`).set(otp);
      await db.ref(`/devices/${deviceId}/live/otp_expected_expiresAt`).set(Date.now() + 5*60*1000);
      const msg = {
        to: val.email,
        from: FROM_EMAIL,
        subject: `Your OTP for device ${deviceId}`,
        text: `Your OTP code is ${otp}. It is valid for 5 minutes.`
      };
      await sgMail.send(msg);
      console.log(`Sent OTP to ${val.email} for ${deviceId}`);
      await otpReqRef.update({ status: 'sent', sentAt: Date.now() });
    } catch (e) {
      console.error('Failed to process otp_request', e);
      try { await otpReqRef.update({ status: 'error', error: String(e) }); } catch(e2){}
    }
  });

  const otpVerifyRef = db.ref(`/devices/${deviceId}/live/otp_verify`);
  otpVerifyRef.on('value', async (snap) => {
    const val = snap.val();
    if (!val) return;
    if (val.status && val.status !== 'pending') return;
    if (!val.otp || !val.email) return;
    try {
      await otpVerifyRef.update({ status: 'processing' });
      const expected = (await db.ref(`/devices/${deviceId}/live/otp_expected`).once('value')).val();
      const expiresAt = (await db.ref(`/devices/${deviceId}/live/otp_expected_expiresAt`).once('value')).val() || 0;
      if (!expected) {
        await otpVerifyRef.update({ status: 'failed', error: 'no expected otp' });
        return;
      }
      if (Date.now() > expiresAt) {
        await otpVerifyRef.update({ status: 'failed', error: 'otp expired' });
        return;
      }
      if (String(val.otp) !== String(expected)) {
        await otpVerifyRef.update({ status: 'failed', error: 'invalid otp' });
        return;
      }
      const token = genToken();
      const ttl = 30 * 60 * 1000; // 30 minutes
      const expiresAtSession = Date.now() + ttl;
      await db.ref(`/devices/${deviceId}/live/session`).set({ token, email: val.email, expiresAt: expiresAtSession });
      await db.ref(`/devices/${deviceId}/live/otp_expected`).remove();
      await db.ref(`/devices/${deviceId}/live/otp_expected_expiresAt`).remove();
      await otpVerifyRef.update({ status: 'ok', grantedAt: Date.now() });
      await db.ref(`/devices/${deviceId}/live/logs/${Date.now()}`).set({ event: 'session_created', email: val.email });
      sessions.set(deviceId, { token, email: val.email, expiresAt: expiresAtSession });

      // push auth_grant to camera if connected
      const cam = clients.get(deviceId);
      const payload = { type: 'auth_grant', deviceId, email: val.email, token, ttl_ms: ttl };
      if (cam && cam.readyState === WebSocket.OPEN) {
        cam.send(JSON.stringify(payload));
        console.log('Pushed auth_grant to camera', deviceId);
      } else {
        console.log('Camera not connected; session stored in DB for later.');
      }
    } catch (e) {
      console.error('Error in otp_verify flow', e);
      try { await otpVerifyRef.update({ status: 'error', error: String(e) }); } catch(e2){}
    }
  });
}

// Watch existing devices and child_added
const devicesRef = db.ref('/devices');
devicesRef.on('child_added', (snap) => {
  const deviceId = snap.key;
  watchDevice(deviceId);
});

(async () => {
  try {
    const list = await devicesRef.once('value');
    const v = list.val() || {};
    Object.keys(v).forEach(deviceId => watchDevice(deviceId));
  } catch (e) {
    console.error('Initial device listing failed', e);
  }
})().catch(e => console.error('Initial device listing failed', e));

server.listen(PORT, () => {
  console.log(`HTTP + WS server listening on port ${PORT}`);
});
