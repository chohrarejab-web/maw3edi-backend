/**
 * SahaTN / Maw2idi — Security regression suite (phase 4)
 *
 * Usage:
 *   ADMIN_PASSWORD=<admin password> node server/test_security_phase4.js http://localhost:4000 dev
 *   ADMIN_PASSWORD=<admin password> node server/test_security_phase4.js http://localhost:4100 prod
 *
 * "dev"  = checks that run against a normal development server.
 * "prod" = extra checks that only make sense with NODE_ENV=production (HSTS, HTTPS redirect,
 *          strict CORS, SQL console disabled, tight rate limits). Run it against a SANDBOX copy.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4000';
const MODE = process.argv[3] || 'dev';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@sahatn.tn';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const u = new URL(BASE);

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) pass++; else fail++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? '\n        -> ' + String(detail).slice(0, 300) : ''}`);
}

// Raw HTTP helper (lets us control Host / X-Forwarded-* headers, which fetch() forbids)
function raw(method, p, { token, body, headers = {}, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined);
    const h = { 'User-Agent': 'SecTest/1.0', ...headers };
    if (payload !== undefined) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    if (token) h.Authorization = `Bearer ${token}`;
    const r = http.request({ hostname: u.hostname, port: u.port, path: p, method, headers: h }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}
const GET = (p, o) => raw('GET', p, o);
const POST = (p, body, o = {}) => raw('POST', p, { ...o, body });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function adminLogin() {
  const r = await POST('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return r.json?.token || null;
}

async function devSuite() {
  console.log('\n[1] Exposed files & information leakage');
  for (const p of ['/.env', '/.git/config', '/server.js', '/package.json', '/src/config/database.js', '/data/database.json', '/db/schema.sql', '/uploads/x', '/test_api.js', '/cloudflared.log']) {
    const r = await GET(p);
    check(`GET ${p} is not served`, r.status === 404 || r.status === 403, `status ${r.status}`);
  }
  const mal = await raw('POST', '/api/auth/login', { rawBody: '{"email": ' });
  check('Malformed JSON returns a clean JSON error (no stack / file paths)', mal.status === 400 && mal.json && !/\\Users\\|node_modules|at .*\(/i.test(mal.text), `status ${mal.status} ${mal.text.slice(0, 120)}`);

  console.log('\n[2] Security headers');
  const h = await GET('/api/health');
  check('X-Content-Type-Options: nosniff', h.headers['x-content-type-options'] === 'nosniff');
  check('X-Frame-Options set', !!h.headers['x-frame-options']);
  check('X-Powered-By hidden', !h.headers['x-powered-by']);
  const csp = h.headers['content-security-policy'] || '';
  check("CSP: no 'unsafe-eval'", csp && !csp.includes('unsafe-eval'));
  check("CSP: object-src 'none', frame-ancestors, form-action, base-uri", ["object-src 'none'", 'frame-ancestors', 'form-action', 'base-uri'].every(d => csp.includes(d)), csp);

  console.log('\n[3] Registration hardening (privilege escalation + validation)');
  const ts = Date.now();
  for (const role of ['SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'SECRETARY']) {
    const r = await POST('/api/auth/register', { name: 'Sec Probe', email: `sec.probe.${role.toLowerCase()}.${ts}@example.com`, password: 'Probe#12345!x', role, phone: '20000000' });
    check(`Self-register as ${role} is refused`, r.status === 403 && !r.json?.user, `status ${r.status} ${r.text.slice(0, 120)}`);
  }
  let r = await POST('/api/auth/register', { name: 'Sec Test', email: 'not-an-email', password: 'Probe#12345!x' });
  check('Invalid email rejected (400)', r.status === 400, `status ${r.status}`);
  r = await POST('/api/auth/register', { name: 'Sec Test', email: `sec.long.${ts}@example.com`, password: 'A1!' + 'x'.repeat(200) });
  check('Over-long password rejected (400)', r.status === 400, `status ${r.status}`);
  r = await POST('/api/auth/register', { name: { $gt: '' }, email: `sec.obj.${ts}@example.com`, password: 'Probe#12345!x' });
  check('Non-string name (NoSQL/object injection) rejected (400)', r.status === 400, `status ${r.status}`);
  const email = `sec.test.${ts}@example.com`;
  const password = 'SecTest#2026x!';
  r = await POST('/api/auth/register', { name: 'Security Test', email, password, phone: '20123456' });
  check('Normal patient registration still works and role is PATIENT', r.status === 201 && r.json?.user?.role === 'PATIENT', `status ${r.status} ${r.text.slice(0, 120)}`);
  const patientToken = r.json?.token;
  const patientId = r.json?.user?.uuid;
  check('Registration response does not contain a password hash', !/passwordHash|password_hash|\$2[aby]\$/.test(r.text));

  console.log('\n[4] SQL injection & auth bypass payloads on login');
  for (const payload of ["' OR '1'='1", "admin@sahatn.tn'--", "' OR 1=1--", "'; DROP TABLE users;--", "' UNION SELECT 1,2,3--"]) {
    const x = await POST('/api/auth/login', { email: payload, password: "' OR '1'='1" });
    check(`Login payload ${JSON.stringify(payload)} -> 400/401 (never 200/500)`, [400, 401].includes(x.status) && !x.json?.token, `status ${x.status}`);
  }

  console.log('\n[5] JWT tampering');
  if (patientToken) {
    const [hd, pl, sig] = patientToken.split('.');
    const payload = JSON.parse(Buffer.from(pl, 'base64url').toString());
    const forged = `${hd}.${b64({ ...payload, role: 'SUPER_ADMIN' })}.${sig}`;
    let x = await GET('/api/admin/stats', { token: forged });
    check('Token with modified role (bad signature) is rejected', [401, 403].includes(x.status), `status ${x.status}`);
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...payload, role: 'SUPER_ADMIN' })}.`;
    x = await GET('/api/admin/stats', { token: none });
    check('alg:none token is rejected', [401, 403].includes(x.status), `status ${x.status}`);
  }

  console.log('\n[6] Admin routes lock-down');
  const adminRoutes = [['GET', '/api/admin/stats'], ['GET', '/api/admin/table/users'], ['GET', '/api/admin/database/dump'], ['GET', '/api/admin/security/overview'], ['POST', '/api/admin/sql'], ['GET', '/api/admin/audit-logs']];
  for (const [m, p] of adminRoutes) {
    const a = await raw(m, p, { body: m === 'POST' ? { query: 'select 1' } : undefined });
    check(`${m} ${p} without token -> 401/403`, [401, 403].includes(a.status), `status ${a.status}`);
    if (patientToken) {
      const b = await raw(m, p, { token: patientToken, body: m === 'POST' ? { query: 'select 1' } : undefined });
      check(`${m} ${p} as PATIENT -> 403`, b.status === 403, `status ${b.status}`);
    }
  }

  console.log('\n[7] Password reset / 2FA must never leak the OTP');
  r = await POST('/api/auth/forgot-password', { email });
  check('forgot-password response has no previewCode / OTP', !/previewCode/.test(r.text) && !/"code"\s*:\s*"?\d{6}/.test(r.text), r.text.slice(0, 200));

  console.log('\n[8] Server-side price & status verification, IDOR');
  let adminToken = null;
  if (ADMIN_PASSWORD) adminToken = await adminLogin();
  check('Admin login works with the rotated password', !!adminToken || !ADMIN_PASSWORD, ADMIN_PASSWORD ? 'login failed' : 'ADMIN_PASSWORD not provided');
  const doc = await GET('/api/doctors/doc-1');
  const realFee = parseInt(String(doc.json?.data?.fee ?? doc.json?.fee ?? '70').replace(/\D/g, ''), 10);
  const t = `${String(10 + (ts % 8)).padStart(2, '0')}:${String(ts % 6 * 10).padStart(2, '0')}`;
  r = await POST('/api/appointments', { doctorId: 'doc-1', doctorName: 'Dr. Selim Ben Ali', date: '2027-03-15', dateIso: '2027-03-15', time: t, fee: '1 TND', status: 'COMPLETED', patientName: 'Security Test', motif: 'sec-test' }, { token: patientToken });
  const apt = r.json?.data || r.json?.appointment || r.json;
  check(`Client-supplied fee "1 TND" is ignored (server uses doctor's fee ${realFee} TND)`, r.status === 201 && String(apt?.fee).replace(/\D/g, '') === String(realFee), `status ${r.status} fee=${apt?.fee} ${r.text.slice(0, 160)}`);
  check('Client-supplied status COMPLETED is ignored (forced to CONFIRMED)', r.status === 201 && apt?.status === 'CONFIRMED', `status=${apt?.status}`);
  const aptId = apt?.id;

  if (adminToken && patientToken) {
    const list = await GET('/api/admin/table/appointments', { token: adminToken });
    const rows = list.json?.data || list.json?.rows || list.json || [];
    const other = Array.isArray(rows) ? rows.find(a => a.patientId !== patientId && a.id && a.status !== 'BLOCKED') : null;
    if (other) {
      const x = await raw('PATCH', `/api/appointments/${encodeURIComponent(other.id)}`, { token: patientToken, body: { status: 'CANCELLED' } });
      check("Patient cannot cancel ANOTHER patient's appointment (IDOR) -> 403", x.status === 403, `status ${x.status}`);
    } else { check('IDOR test (no foreign appointment available)', true, 'skipped'); }
  }
  if (aptId && patientToken) {
    const x = await raw('PATCH', `/api/appointments/${encodeURIComponent(aptId)}`, { token: patientToken, body: { status: 'CANCELLED', fee: '0 TND', paid: true, paymentStatus: 'PAID', total: 0 } });
    check('Patient can cancel their own appointment', x.status === 200, `status ${x.status} ${x.text.slice(0, 120)}`);
    if (adminToken) {
      const list = await GET('/api/admin/table/appointments', { token: adminToken });
      const rows = list.json?.data || list.json?.rows || list.json || [];
      const stored = Array.isArray(rows) ? rows.find(a => a.id === aptId) : null;
      check('Patient cannot rewrite fee/paid/paymentStatus via PATCH', !!stored && String(stored.fee).replace(/\D/g, '') === String(realFee) && stored.paid !== true, JSON.stringify(stored && { fee: stored.fee, paid: stored.paid, paymentStatus: stored.paymentStatus }));
    }
  }

  console.log('\n[9] Upload restrictions');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  if (patientToken) {
    for (const [label, uri] of [['text/html', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='], ['image/svg+xml', 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+'], ['application/x-msdownload', 'data:application/x-msdownload;base64,TVqQAAMAAAAEAAAA']]) {
      const x = await POST('/api/uploads', { dataUri: uri, category: 'documents' }, { token: patientToken });
      check(`Upload of ${label} is refused`, x.status === 400, `status ${x.status}`);
    }
    let x = await POST('/api/uploads', { dataUri: 'data:image/png;base64,' + Buffer.alloc(6 * 1024 * 1024, 1).toString('base64'), category: 'documents' }, { token: patientToken });
    check('Upload larger than 5 MB is refused', x.status === 400 || x.status === 413, `status ${x.status}`);
    x = await POST('/api/uploads', { dataUri: png, category: '../../etc' }, { token: patientToken });
    check('Upload with path-traversal category is refused', x.status === 400, `status ${x.status}`);
    x = await POST('/api/uploads', { dataUri: png, category: 'documents' }, { token: patientToken });
    check('Valid small PNG is accepted and stored under a random name', x.status === 201 && /^\/api\/uploads\/documents\/\d+_[a-f0-9]{24}\.png$/.test(x.json?.url || ''), `status ${x.status} ${x.text.slice(0, 120)}`);
    const unauth = await POST('/api/uploads', { dataUri: png, category: 'documents' });
    check('Upload without authentication -> 401', unauth.status === 401, `status ${unauth.status}`);
    if (x.json?.url) { try { fs.unlinkSync(path.join(__dirname, 'uploads', 'documents', path.basename(x.json.url))); } catch { /* ignore */ } }
  }

  console.log('\n[10] CSRF protection for browser-style requests');
  r = await POST('/api/queue/delay', { minutes: 5 }, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', Origin: 'https://evil.example', Cookie: 'sahatn_admin_token=x' } });
  check('Cross-site POST without CSRF token is blocked (403)', r.status === 403, `status ${r.status}`);

  console.log('\n[11] Account lockout (brute force)');
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await POST('/api/auth/login', { email, password: 'wrong-password-' + i })).status);
  check('Repeated wrong passwords lock the account (423)', codes.includes(423), codes.join(','));

  console.log('\n[12] Clean-up of test data');
  if (adminToken) {
    for (const [tbl, id] of [['users', patientId], ['appointments', aptId]]) {
      if (!id) continue;
      const d = await raw('DELETE', `/api/admin/table/${tbl}/row/${encodeURIComponent(id)}`, { token: adminToken });
      check(`Removed test ${tbl} row ${id}`, d.status === 200 || d.status === 404, `status ${d.status}`);
    }
  }
}

async function prodSuite() {
  console.log('\n[P1] HTTPS enforcement & HSTS');
  let r = await GET('/api/health');
  check('HSTS header present (max-age >= 1 year)', /max-age=(\d+)/.test(r.headers['strict-transport-security'] || '') && Number(RegExp.$1) >= 31536000, r.headers['strict-transport-security']);
  r = await GET('/api/health', { headers: { Host: 'maw2idi.example.com' } });
  check('Plain HTTP on a public host is redirected to HTTPS (301)', r.status === 301 && /^https:\/\/maw2idi\.example\.com\//.test(r.headers.location || ''), `status ${r.status} ${r.headers.location}`);
  r = await POST('/api/auth/login', { email: 'a@b.co', password: 'x' }, { headers: { Host: 'maw2idi.example.com' } });
  check('Plain HTTP POST on a public host is refused (426)', r.status === 426, `status ${r.status}`);
  r = await GET('/api/health', { headers: { Host: 'maw2idi.example.com', 'X-Forwarded-Proto': 'https' } });
  check('Behind an HTTPS proxy (X-Forwarded-Proto: https) requests pass', r.status === 200, `status ${r.status}`);

  console.log('\n[P2] Strict CORS');
  r = await GET('/api/health', { headers: { Origin: 'https://evil.example' } });
  check('Origin https://evil.example gets NO Access-Control-Allow-Origin', !r.headers['access-control-allow-origin'], r.headers['access-control-allow-origin']);
  r = await GET('/api/health', { headers: { Origin: 'https://maw2idi.tn' } });
  check('Origin https://maw2idi.tn is allowed', r.headers['access-control-allow-origin'] === 'https://maw2idi.tn', r.headers['access-control-allow-origin']);

  console.log('\n[P3] Debug / dev features are OFF in production');
  r = await POST('/api/auth/forgot-password', { email: 'admin@sahatn.tn' });
  check('forgot-password never returns previewCode', !/previewCode/.test(r.text), r.text.slice(0, 160));
  const token = ADMIN_PASSWORD ? await adminLogin() : null;
  if (token) {
    r = await POST('/api/admin/sql', { query: 'select 1' }, { token });
    check('Interactive SQL console is disabled for admins (403/501, never 200)', [403, 404, 501].includes(r.status), `status ${r.status}`);
    const login = await POST('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const sc = [].concat(login.headers['set-cookie'] || []).join(' | ');
    check('Session cookie (if issued) is HttpOnly + SameSite=Strict + Secure', !sc || (/HttpOnly/i.test(sc) && /SameSite=Strict/i.test(sc) && /Secure/i.test(sc)), sc);
  }

  console.log('\n[P4] Rate limiting');
  const seen = [];
  for (let i = 0; i < 40; i++) seen.push((await POST('/api/auth/login', { email: `rl${i}@example.com`, password: 'x' })).status);
  check('Auth endpoint rate-limits bursts (429 appears within 40 attempts)', seen.includes(429), seen.join(','));
}

(async () => {
  console.log(`Security suite -> ${BASE} (mode: ${MODE})`);
  try {
    await GET('/api/health');
  } catch (e) { console.error('Server not reachable:', e.message); process.exit(2); }
  if (MODE === 'prod') await prodSuite(); else await devSuite();
  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
