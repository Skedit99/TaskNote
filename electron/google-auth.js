// ═══════════════════════════════
// Google OAuth 2.0 인증 모듈
// ═══════════════════════════════
// PKCE + CLIENT_SECRET 방식
// 인증 URL 생성 · 토큰 교환 · 갱신을 직접 HTTPS로 처리
// googleapis는 Calendar/Userinfo API 호출 시에만 사용

const { BrowserWindow, app, safeStorage } = require('electron');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ── .env 로드 (경로 탐색 강화) ──
const dotenv = require('dotenv');
const envPaths = app.isPackaged
  ? [
      path.join(process.resourcesPath, '.env'),
      path.join(process.resourcesPath, '..', '.env'),
      path.join(path.dirname(process.execPath), '.env'),
    ]
  : [
      path.join(__dirname, '.env'),
      path.join(__dirname, '..', '.env'),
      path.join(__dirname, '../..', '.env'),
      path.join(process.cwd(), '.env'),
    ];
let loadedEnvPath = null;
for (const p of envPaths) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    loadedEnvPath = p;
    break;
  }
}

// ── 상수 ──
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];
const TOKEN_FILE = 'gcal-tokens.json';
const LOOPBACK_PORT = 48521;
const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;
const rawClientId = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_ID = rawClientId.replace(/[\r\n\s]+/g, '');
const rawClientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const CLIENT_SECRET = rawClientSecret.replace(/[\r\n\s]+/g, '');

// ── 시작 시점 디버깅 로그 (터미널 + 파일) ──
const debugLog = [
  '=============================================',
  '[GAuth] 환경변수 로드 상태 점검',
  `- 시각: ${new Date().toLocaleString()}`,
  `- __dirname: ${__dirname}`,
  `- 탐색 경로: ${envPaths.join(' | ')}`,
  `- 인식된 .env: ${loadedEnvPath || '찾을 수 없음'}`,
  `- CLIENT_ID: ${CLIENT_ID ? `OK (${CLIENT_ID.substring(0, 15)}...)` : '실패 (비어있음)'}`,
  `- CLIENT_SECRET: ${CLIENT_SECRET ? 'OK (로드됨)' : '실패 (비어있음)'}`,
  '=============================================',
].join('\n');
console.log('\n' + debugLog + '\n');
try {
  const logPath = path.join(app.getPath('userData'), 'gauth-debug.log');
  fs.writeFileSync(logPath, debugLog + '\n', 'utf-8');
} catch {}

if (!CLIENT_ID) {
  console.error('[GAuth] 치명적 오류: CLIENT_ID가 존재하지 않습니다!');
}

// ── 토큰 파일 관리 ──
let tokenPath = null;
function getTokenPath() {
  if (!tokenPath) tokenPath = path.join(app.getPath('userData'), TOKEN_FILE);
  return tokenPath;
}

function saveTokens(tokens) {
  try {
    const json = JSON.stringify(tokens, null, 2);
    if (safeStorage.isEncryptionAvailable()) {
      // OS 레벨 암호화 (Windows DPAPI / macOS Keychain)
      const encrypted = safeStorage.encryptString(json);
      fs.writeFileSync(getTokenPath(), encrypted);
      console.log('[GAuth] 토큰 암호화 저장 완료');
    } else {
      fs.writeFileSync(getTokenPath(), json, 'utf-8');
      console.warn('[GAuth] 암호화 불가 — 평문 저장');
    }
  } catch (e) { console.error('[GAuth] 토큰 저장 실패:', e.message); }
}

function loadTokens() {
  try {
    const p = getTokenPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p);
    // 암호화된 파일인지 판별 (평문 JSON은 '{' 로 시작)
    if (raw[0] === 0x7B) {
      // 기존 평문 파일 — 읽은 후 암호화 저장으로 마이그레이션
      const tokens = JSON.parse(raw.toString('utf-8'));
      console.log('[GAuth] 평문 토큰 감지 → 암호화 마이그레이션');
      saveTokens(tokens);
      return tokens;
    }
    // 암호화된 파일
    if (safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(raw);
      return JSON.parse(decrypted);
    }
    console.warn('[GAuth] 암호화된 토큰 파일이나 복호화 불가');
    return null;
  } catch (e) { console.error('[GAuth] 토큰 로드 실패:', e.message); }
  return null;
}

function deleteTokens() {
  try {
    const p = getTokenPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) { console.error('[GAuth] 토큰 삭제 실패:', e.message); }
}

// ── googleapis OAuth2 클라이언트 생성 (Calendar API 호출 전용) ──
function createApiClient(tokens) {
  const client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  // access_token만 전달하여 라이브러리의 자동 갱신 방지
  // 토큰 갱신은 getAuthenticatedClient()에서 httpsPost로 직접 처리
  if (tokens) client.setCredentials({ access_token: tokens.access_token });
  return client;
}

// ── HTTPS POST (토큰 교환·갱신용) ──
function httpsPost(endpoint, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const { hostname, pathname } = new URL(endpoint);
    const req = https.request({
      hostname, path: pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Google 프로필 조회 ──
async function getUserProfile(apiClient) {
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: apiClient });
    const { data } = await oauth2.userinfo.get();
    return { email: data.email, name: data.name, picture: data.picture };
  } catch (e) {
    console.error('[GAuth] 프로필 조회 실패:', e.message);
    return null;
  }
}

// ── 인증된 클라이언트 반환 (자동 토큰 갱신) ──
async function getAuthenticatedClient() {
  const tokens = loadTokens();
  if (!tokens) return null;

  if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) {
    try {
      const res = await httpsPost('https://oauth2.googleapis.com/token', {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      });
      if (res.error) throw new Error(res.error_description || res.error);
      const refreshed = {
        ...tokens,
        access_token: res.access_token,
        expiry_date: Date.now() + res.expires_in * 1000,
      };
      saveTokens(refreshed);
      return createApiClient(refreshed);
    } catch (e) {
      console.error('[GAuth] 토큰 갱신 실패:', e.message);
      deleteTokens();
      return null;
    }
  }

  return createApiClient(tokens);
}

// ── 로그인 플로우 ──
function loginWithGoogle(_appRef, parentWindow) {
  return new Promise((resolve, reject) => {
    if (!CLIENT_ID) {
      return reject(new Error('CLIENT_ID가 로드되지 않았습니다. 터미널 콘솔을 확인하세요.'));
    }

    // PKCE 생성
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    // 인증 URL 구성 후 제어 문자 강제 제거
    const authUrl = (
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString()
    ).replace(/[\r\n]+/g, '');

    let server = null;
    let authWindow = null;
    let settled = false;

    const cleanup = () => {
      if (server) { try { server.close(); } catch {} server = null; }
      if (authWindow && !authWindow.isDestroyed()) { try { authWindow.close(); } catch {} }
    };

    // 로컬 콜백 서버
    server = http.createServer(async (req, res) => {
      try {
        const parsed = new URL(req.url, `http://127.0.0.1:${LOOPBACK_PORT}`);
        if (parsed.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

        const code = parsed.searchParams.get('code');
        const error = parsed.searchParams.get('error');
        if (error || !code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>인증 취소됨</h2><p>창을 닫아도 됩니다.</p></body></html>');
          if (!settled) { settled = true; cleanup(); reject(new Error('사용자가 인증을 취소했습니다')); }
          return;
        }

        // 토큰 교환
        const tokenRes = await httpsPost('https://oauth2.googleapis.com/token', {
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          code_verifier: codeVerifier,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT_URI,
        });
        if (tokenRes.error) throw new Error(tokenRes.error_description || tokenRes.error);

        const tokens = {
          access_token: tokenRes.access_token,
          refresh_token: tokenRes.refresh_token,
          expiry_date: Date.now() + tokenRes.expires_in * 1000,
          token_type: tokenRes.token_type,
          scope: tokenRes.scope,
        };

        saveTokens(tokens);
        const profile = await getUserProfile(createApiClient(tokens));

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Google 계정 연결 완료!</h2>
          <p>${profile?.email || ''}</p>
          <p style="color:#888;margin-top:20px">이 창은 자동으로 닫힙니다...</p>
          <script>setTimeout(()=>window.close(),1500)</script>
        </body></html>`);

        if (!settled) { settled = true; setTimeout(cleanup, 2000); resolve({ tokens, profile }); }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>오류 발생</h2><p>${e.message}</p></body></html>`);
        if (!settled) { settled = true; cleanup(); reject(e); }
      }
    });

    server.listen(LOOPBACK_PORT, '127.0.0.1', () => {
      authWindow = new BrowserWindow({
        width: 520, height: 700,
        parent: parentWindow || undefined,
        modal: true, show: true, autoHideMenuBar: true,
        title: 'Google 로그인',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      authWindow.loadURL(authUrl);
      authWindow.on('closed', () => {
        authWindow = null;
        if (!settled) { settled = true; cleanup(); reject(new Error('사용자가 로그인 창을 닫았습니다')); }
      });
    });

    server.on('error', (e) => {
      if (!settled) { settled = true; reject(new Error('로컬 서버 시작 실패: ' + e.message)); }
    });
  });
}

// ── 로그아웃 ──
async function logoutGoogle() {
  const tokens = loadTokens();
  if (tokens?.access_token) {
    try { await httpsPost('https://oauth2.googleapis.com/revoke', { token: tokens.access_token }); }
    catch (e) { console.log('[GAuth] 토큰 폐기 실패 (무시):', e.message); }
  }
  deleteTokens();
}

// ── 로그인 상태 확인 ──
async function getGoogleAuthStatus() {
  const client = await getAuthenticatedClient();
  if (!client) return { connected: false };

  try {
    const profile = await getUserProfile(client);
    if (profile) return { connected: true, email: profile.email, name: profile.name, picture: profile.picture };
  } catch (e) { console.error('[GAuth] 상태 확인 실패:', e.message); }

  return { connected: false };
}

module.exports = { loginWithGoogle, logoutGoogle, getGoogleAuthStatus, getAuthenticatedClient };
