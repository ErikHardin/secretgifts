// Secret Gifts — Cloudflare Worker
// Runs the draw, keeps matches secret, and sends email through Resend.
//
// Variables (plain text):  DB_URL, ADMIN_EMAIL, APP_URL, FROM_EMAIL, ALLOWED_ORIGIN
// Secrets (encrypted):     SERVICE_ACCOUNT_JSON, RESEND_API_KEY

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method === 'GET') return json({ ok: true, app: 'secretgifts' });
    if (req.method !== 'POST') return json({ error: 'Not found' }, 404);

    try {
      const user = await verifyIdToken(req.headers.get('Authorization'), env);
      const body = await req.json().catch(() => ({}));
      const path = new URL(req.url).pathname.replace(/\/+$/, '');
      if (body.exchangeId && !/^[A-Za-z0-9_-]+$/.test(body.exchangeId)) throw httpErr(400, 'Bad exchange id');

      switch (path) {
        case '/draw':   return json(await doDraw(env, user, body));
        case '/resend': return json(await doResend(env, user, body));
        case '/invite': return json(await doInvite(env, user, body));
        case '/notify': return json(await doNotify(env, user, body));
        default:        return json({ error: 'Not found' }, 404);
      }
    } catch (e) {
      return json({ error: e.message || 'Something went wrong' }, e.status || 400);
    }
  },
};

// ---------- actions ----------

async function doDraw(env, user, { exchangeId, force }) {
  requireAdmin(env, user);
  const ex = await dbGet(env, `exchanges/${exchangeId}`);
  if (!ex) throw httpErr(404, 'Exchange not found');
  if (ex.status === 'drawn' && !force) throw httpErr(409, 'Names were already drawn for this exchange');

  const people = (await dbGet(env, 'people')) || {};
  const members = Object.keys(ex.members || {}).filter((p) => people[p]);
  if (members.length < 3) throw httpErr(400, 'Add at least 3 people to the exchange first');

  const year = String(ex.year || new Date().getFullYear());
  const prevYear = String(Number(year) - 1);
  const last = {
    ...((await dbGet(env, `history_manual/${exchangeId}/${prevYear}`)) || {}),
    ...((await dbGet(env, `history_drawn/${exchangeId}/${prevYear}`)) || {}),
  };

  const blocked = (g, r) =>
    g === r ||
    !!people[g].excludes?.[r] ||
    !!people[r].excludes?.[g] ||
    last[g] === r;

  const result = solve(members, blocked, true) || solve(members, blocked, false);
  if (!result) {
    throw httpErr(400, "No valid draw exists with these exclusions. Try adding people or clearing last year's pairs.");
  }

  await dbPatch(env, {
    [`matches/${exchangeId}`]: result,
    [`history_drawn/${exchangeId}/${year}`]: result,
    [`qa/${exchangeId}`]: null,
    [`exchanges/${exchangeId}/status`]: 'drawn',
    [`exchanges/${exchangeId}/drawnAt`]: { '.sv': 'timestamp' },
  });

  const emails = members.map((g) => matchEmail(env, ex, people[g], people[result[g]]));
  const sent = await sendBatch(env, emails);
  return { ok: true, sent, total: members.length };
}

async function doResend(env, user, { exchangeId }) {
  const pid = await pidFor(env, user.email);
  const ex = await dbGet(env, `exchanges/${exchangeId}`);
  if (!ex || !ex.members?.[pid]) throw httpErr(403, "You're not in this exchange");
  const rid = await dbGet(env, `matches/${exchangeId}/${pid}`);
  if (!rid) throw httpErr(400, "Names haven't been drawn yet");
  const [me, them] = await Promise.all([dbGet(env, `people/${pid}`), dbGet(env, `people/${rid}`)]);
  await sendBatch(env, [matchEmail(env, ex, me, them)]);
  return { ok: true };
}

async function doInvite(env, user, { exchangeId }) {
  requireAdmin(env, user);
  const ex = await dbGet(env, `exchanges/${exchangeId}`);
  if (!ex) throw httpErr(404, 'Exchange not found');
  const people = (await dbGet(env, 'people')) || {};
  const members = Object.keys(ex.members || {}).filter((p) => people[p]);
  if (!members.length) throw httpErr(400, 'No one is in this exchange yet');

  const emails = members.map((p) => {
    const person = people[p];
    const inner = `
      <p style="margin:0 0 12px">Hi ${h(first(person.name))},</p>
      <p style="margin:0 0 12px">You're in the <strong>${h(ex.name)}</strong> gift exchange${ex.cap ? `, with a limit of <strong>$${h(ex.cap)}</strong>` : ''}.</p>
      ${ex.date ? `<p style="margin:0 0 12px">Exchange day: <strong>${h(fmtDate(ex.date))}</strong></p>` : ''}
      ${ex.message ? `<p style="margin:0 0 12px;font-style:italic">${h(ex.message)}</p>` : ''}
      <p style="margin:0 0 18px">Sign in with this email and add a few ideas to your wishlist, so whoever draws your name knows what you'd love.</p>
      ${button(env.APP_URL, 'Add my wishlist')}`;
    return mail(env, person.email, `You're in the ${ex.name} gift exchange`, inner);
  });
  const sent = await sendBatch(env, emails);
  return { ok: true, sent, total: members.length };
}

async function doNotify(env, user, { exchangeId, type }) {
  const pid = await pidFor(env, user.email);
  const ex = await dbGet(env, `exchanges/${exchangeId}`);
  if (!ex || !ex.members?.[pid]) throw httpErr(403, "You're not in this exchange");

  if (type === 'question') {
    const rid = await dbGet(env, `matches/${exchangeId}/${pid}`);
    if (!rid) throw httpErr(400, 'No match yet');
    const them = await dbGet(env, `people/${rid}`);
    const inner = `
      <p style="margin:0 0 12px">Hi ${h(first(them.name))},</p>
      <p style="margin:0 0 18px">Your Secret Santa in <strong>${h(ex.name)}</strong> sent you an anonymous question. Open the app to answer it.</p>
      ${button(env.APP_URL, 'Answer the question')}`;
    await sendBatch(env, [mail(env, them.email, `Your Secret Santa has a question (${ex.name})`, inner)]);
    return { ok: true };
  }

  if (type === 'answer') {
    const matches = (await dbGet(env, `matches/${exchangeId}`)) || {};
    const givers = Object.keys(matches).filter((g) => matches[g] === pid);
    const me = await dbGet(env, `people/${pid}`);
    const emails = [];
    for (const g of givers) {
      const giver = await dbGet(env, `people/${g}`);
      if (!giver?.email) continue;
      const inner = `
        <p style="margin:0 0 12px">Hi ${h(first(giver.name))},</p>
        <p style="margin:0 0 18px">${h(first(me.name))} answered your question in <strong>${h(ex.name)}</strong>.</p>
        ${button(env.APP_URL, 'See the answer')}`;
      emails.push(mail(env, giver.email, `Your question was answered (${ex.name})`, inner));
    }
    if (emails.length) await sendBatch(env, emails);
    return { ok: true };
  }

  throw httpErr(400, 'Unknown notification');
}

// ---------- draw ----------

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Finds a random assignment giver -> recipient where nobody is blocked.
// avoidMutual tries to prevent A->B and B->A pairs.
function solve(members, blocked, avoidMutual) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const givers = shuffle([...members]);
    const options = {};
    for (const g of givers) options[g] = shuffle(members.filter((r) => !blocked(g, r)));
    givers.sort((a, b) => options[a].length - options[b].length);

    const taken = new Set();
    const res = {};
    let steps = 0;
    const bt = (i) => {
      if (i === givers.length) return true;
      if (++steps > 50000) return false;
      const g = givers[i];
      for (const r of options[g]) {
        if (taken.has(r)) continue;
        if (avoidMutual && res[r] === g) continue;
        taken.add(r);
        res[g] = r;
        if (bt(i + 1)) return true;
        taken.delete(r);
        delete res[g];
      }
      return false;
    };
    if (bt(0)) return res;
    if (steps <= 50000) return null; // search was exhaustive: no solution exists
  }
  return null;
}

// ---------- email ----------

function matchEmail(env, ex, giver, recipient) {
  const inner = `
    <p style="margin:0 0 12px">Hi ${h(first(giver.name))},</p>
    <p style="margin:0 0 6px">For <strong>${h(ex.name)}</strong>, you're giving a gift to:</p>
    <p style="margin:0 0 16px;font-size:28px;font-weight:700;color:#b3262e;font-family:Georgia,serif">${h(recipient.name)}</p>
    ${ex.cap ? `<p style="margin:0 0 8px">Gift limit: <strong>$${h(ex.cap)}</strong></p>` : ''}
    ${ex.date ? `<p style="margin:0 0 8px">Exchange day: <strong>${h(fmtDate(ex.date))}</strong></p>` : ''}
    ${ex.message ? `<p style="margin:12px 0;font-style:italic">${h(ex.message)}</p>` : ''}
    <p style="margin:12px 0 18px">See their wishlist, or send them an anonymous question, in the app.</p>
    ${button(env.APP_URL, 'See their wishlist')}`;
  return mail(env, giver.email, `Your Secret Gifts match for ${ex.name}`, inner);
}

function mail(env, to, subject, inner) {
  return {
    from: env.FROM_EMAIL,
    to: [to],
    subject,
    html: `<!doctype html><html><body style="margin:0;background:#fbf6ee;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2a2320">
      <div style="max-width:520px;margin:0 auto;padding:28px 20px">
        <div style="font-size:22px;font-weight:700;color:#b3262e;font-family:Georgia,serif">&#127873; Secret Gifts</div>
        <div style="background:#ffffff;border-radius:14px;padding:24px;margin-top:16px;border:1px solid #eadfcd;font-size:16px;line-height:1.5">${inner}</div>
        <p style="font-size:12px;color:#8a7f74;margin-top:16px">Shhh, keep it a secret.</p>
      </div></body></html>`,
  };
}

function button(url, label) {
  return `<a href="${h(url)}" style="display:inline-block;background:#1f6b45;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">${h(label)}</a>`;
}

async function sendBatch(env, emails) {
  let sent = 0;
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    const r = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw httpErr(502, `Email failed to send (${r.status}). ${t.slice(0, 200)}`);
    }
    sent += chunk.length;
  }
  return sent;
}

// ---------- helpers ----------

const h = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';
const emailKey = (e) => String(e).trim().toLowerCase().replace(/\./g, ',');

function fmtDate(d) {
  const dt = new Date(`${d}T12:00:00Z`);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function requireAdmin(env, user) {
  if (user.email !== String(env.ADMIN_EMAIL || '').toLowerCase()) throw httpErr(403, 'Admin only');
}

async function pidFor(env, email) {
  const pid = await dbGet(env, `emailIndex/${emailKey(email)}`);
  if (!pid) throw httpErr(403, "You're not on any gift exchange list");
  return pid;
}

// ---------- Firebase ID token verification ----------

let jwkCache = { keys: null, exp: 0 };
async function getJwks() {
  if (jwkCache.keys && Date.now() < jwkCache.exp) return jwkCache.keys;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const j = await r.json();
  const m = (r.headers.get('cache-control') || '').match(/max-age=(\d+)/);
  jwkCache = { keys: j.keys, exp: Date.now() + (m ? Number(m[1]) : 3600) * 1000 };
  return j.keys;
}

const b64urlToBytes = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const bytesToB64url = (bytes) => {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function verifyIdToken(header, env) {
  const tok = String(header || '').replace(/^Bearer\s+/i, '');
  const parts = tok.split('.');
  if (parts.length !== 3) throw httpErr(401, 'Please sign in again');
  const [h64, p64, s64] = parts;
  const dec = (x) => JSON.parse(new TextDecoder().decode(b64urlToBytes(x)));
  const head = dec(h64);
  const payload = dec(p64);
  const projectId = serviceAccount(env).project_id;

  const jwk = (await getJwks()).find((k) => k.kid === head.kid);
  if (!jwk) throw httpErr(401, 'Please sign in again');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s64), new TextEncoder().encode(`${h64}.${p64}`));
  const now = Date.now() / 1000;
  if (
    !ok ||
    payload.aud !== projectId ||
    payload.iss !== `https://securetoken.google.com/${projectId}` ||
    payload.exp < now ||
    !payload.email ||
    payload.email_verified !== true
  ) {
    throw httpErr(401, 'Please sign in again');
  }
  return { uid: payload.sub, email: String(payload.email).toLowerCase() };
}

// ---------- Realtime Database via service account ----------

let saParsed = null;
function serviceAccount(env) {
  if (!saParsed) saParsed = JSON.parse(env.SERVICE_ACCOUNT_JSON);
  return saParsed;
}

let saCache = { token: null, exp: 0 };
async function saToken(env) {
  if (saCache.token && Date.now() < saCache.exp) return saCache.token;
  const sa = serviceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${bytesToB64url(new Uint8Array(sig))}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const j = await r.json();
  if (!j.access_token) throw httpErr(500, 'Server could not reach the database');
  saCache = { token: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  return j.access_token;
}

const dbBase = (env) => String(env.DB_URL).replace(/\/+$/, '');

async function dbGet(env, path) {
  const t = await saToken(env);
  const r = await fetch(`${dbBase(env)}/${path}.json?access_token=${encodeURIComponent(t)}`);
  if (!r.ok) throw httpErr(500, 'Database read failed');
  return r.json();
}

async function dbPatch(env, obj) {
  const t = await saToken(env);
  const r = await fetch(`${dbBase(env)}/.json?access_token=${encodeURIComponent(t)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  if (!r.ok) throw httpErr(500, 'Database write failed');
  return r.json();
}
