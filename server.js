// server.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const WebSocket = require('ws');
const sgMail = require('@sendgrid/mail');

const PORT = process.env.PORT || 8080;      // HTTP API
const WS_PORT = process.env.WS_PORT || 8081; // WebSocket relay
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL; // e.g., "no-reply@yourdomain.com"
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

if (!SENDGRID_API_KEY || !FROM_EMAIL) {
  console.error("Please set SENDGRID_API_KEY and FROM_EMAIL env variables.");
  process.exit(1);
}

sgMail.setApiKey(SENDGRID_API_KEY);

const app = express();
app.use(bodyParser.json());
app.use(cors());

// In-memory stores
const otps = new Map();     // deviceId -> { otp, email, expiresAt, attempts }
const sessions = new Map(); // deviceId -> { token, email, expiresAt }

// WebSocket server (relay)
const wss = new WebSocket.Server({ port: WS_PORT });
console.log("WebSocket server listening on port", WS_PORT);
const clients = new Map(); // deviceId -> ws

wss.on('connection', (ws) => {
  console.log('WS client connected');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());
      if (msg.type === 'hello' && msg.deviceId) {
        clients.set(msg.deviceId, ws);
        ws.deviceId = msg.deviceId;
        console.log('Registered deviceId on WS:', msg.deviceId);
      } else {
        console.log('WS recv:', msg);
      }
    } catch (e) {
      console.log('Invalid WS message', e);
    }
  });

  ws.on('close', () => {
    if (ws.deviceId) clients.delete(ws.deviceId);
    console.log('WS closed');
  });
});

// keepalive
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function genOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function genToken() {
  return [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
}

// POST /request_otp
app.post('/request_otp', async (req, res) => {
  const { deviceId, email } = req.body || {};
  if (!deviceId || !email) return res.status(400).json({ ok:false, error:'deviceId and email required' });

  // rate limiting simple check
  const prev = otps.get(deviceId);
  if (prev && Date.now() < (prev.expiresAt - (OTP_TTL_MS - 1000))) {
    // if already requested recently, refuse (simple)
    return res.status(429).json({ ok:false, error:'OTP recently requested. Wait a bit.' });
  }

  const otp = genOtp();
  const expiresAt = Date.now() + OTP_TTL_MS;
  otps.set(deviceId, { otp, email, expiresAt, attempts:0 });

  const msg = {
    to: email,
    from: FROM_EMAIL,
    subject: `Your OTP for device ${deviceId}`,
    text: `Your OTP code is ${otp}. It is valid for 5 minutes.`
  };

  try {
    await sgMail.send(msg);
    console.log('OTP sent to', email, 'for device', deviceId);
    return res.json({ ok:true });
  } catch (err) {
    console.error('SendGrid error', err);
    return res.status(500).json({ ok:false, error:'failed to send email' });
  }
});

// POST /verify_otp
app.post('/verify_otp', (req, res) => {
  const { deviceId, email, otp } = req.body || {};
  if (!deviceId || !email || !otp) return res.status(400).json({ ok:false, error:'deviceId,email,otp required' });

  const rec = otps.get(deviceId);
  if (!rec) return res.status(403).json({ ok:false, error:'no otp for device' });
  if (rec.email !== email) return res.status(403).json({ ok:false, error:'email mismatch' });
  if (Date.now() > rec.expiresAt) { otps.delete(deviceId); return res.status(403).json({ ok:false, error:'otp expired' }); }

  // increase attempts and limit
  rec.attempts = (rec.attempts || 0) + 1;
  if (rec.attempts > 6) { otps.delete(deviceId); return res.status(403).json({ ok:false, error:'too many attempts' }); }

  if (rec.otp !== otp) return res.status(403).json({ ok:false, error:'invalid otp' });

  // success -> create session & delete otp
  const token = genToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(deviceId, { token, email, expiresAt });
  otps.delete(deviceId);

  // push auth_grant via WS if device connected
  const ws = clients.get(deviceId);
  const payload = { type: 'auth_grant', deviceId, email, token, ttl_ms: SESSION_TTL_MS };
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    console.log('Sent auth_grant to device', deviceId);
  } else {
    console.log('Device not connected; session stored on server for later (device will get token when reconnected if needed).');
  }

  return res.json({ ok:true, token, expires_ms: SESSION_TTL_MS });
});

// POST /command -> verify token on server-side then forward to device via WS
app.post('/command', (req, res) => {
  const { deviceId, email, token, cmd } = req.body || {};
  if (!deviceId || !email || !token || !cmd) return res.status(400).json({ ok:false, error:'deviceId,email,token,cmd required' });
  const sess = sessions.get(deviceId);
  if (!sess) return res.status(403).json({ ok:false, error:'no session for device' });
  if (sess.email !== email) return res.status(403).json({ ok:false, error:'email mismatch' });
  if (sess.token !== token) return res.status(403).json({ ok:false, error:'invalid token' });
  if (Date.now() > sess.expiresAt) { sessions.delete(deviceId); return res.status(403).json({ ok:false, error:'session expired' }); }

  const ws = clients.get(deviceId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return res.status(500).json({ ok:false, error:'device not connected' });

  const out = { type: 'cmd', payload: { cmd, email, token } };
  try {
    ws.send(JSON.stringify(out));
    return res.json({ ok:true });
  } catch (e) {
    console.error('Failed to send cmd', e);
    return res.status(500).json({ ok:false, error:'failed to forward cmd' });
  }
});

// POST /revoke (optional)
app.post('/revoke', (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ ok:false, error:'deviceId required' });
  sessions.delete(deviceId);
  const ws = clients.get(deviceId);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'revoke' }));
  return res.json({ ok:true });
});

app.listen(PORT, () => console.log(`HTTP API listening on port ${PORT}`));
