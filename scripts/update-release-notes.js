/**
 * GitHub Release 노트 자동 업데이트 스크립트
 *
 * 사용법: node scripts/update-release-notes.js
 *
 * electron-builder --publish always 실행 후 자동으로 호출됨.
 * 마지막 태그 이후의 커밋 메시지를 파싱하여 GitHub Release body에 작성.
 *
 * 환경변수: GH_TOKEN (GitHub Personal Access Token)
 */
const https = require('https');
const { execSync } = require('child_process');
const path = require('path');

const OWNER = 'Skedit99';
const REPO = 'TaskNote';

// package.json에서 현재 버전 가져오기
const pkg = require(path.join(__dirname, '..', 'package.json'));
const VERSION = pkg.version;
const TAG = `v${VERSION}`;

// GH_TOKEN 확인
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('[Release Notes] GH_TOKEN 환경변수가 설정되지 않았습니다.');
  console.error('  set GH_TOKEN=ghp_xxxxx  (Windows)');
  process.exit(1);
}

// 이전 태그 찾기
function getPreviousTag() {
  try {
    const tags = execSync('git tag --sort=-creatordate', { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    const currentIdx = tags.indexOf(TAG);
    if (currentIdx >= 0 && tags[currentIdx + 1]) return tags[currentIdx + 1];
    if (tags.length >= 2) return tags[1];
    return null;
  } catch {
    return null;
  }
}

// 커밋 메시지 가져오기
function getCommitMessages() {
  const prevTag = getPreviousTag();
  const range = prevTag ? `${prevTag}..HEAD` : 'HEAD~10..HEAD';
  try {
    const log = execSync(`git log ${range} --pretty=format:"%s" --no-merges`, { encoding: 'utf-8' }).trim();
    return log.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// 커밋 메시지를 릴리즈 노트로 변환
function formatReleaseNotes(commits) {
  const fixes = [];
  const features = [];
  const others = [];

  for (const msg of commits) {
    // Co-Authored-By 제거, 버전 태그 커밋 제거
    const clean = msg.replace(/Co-Authored-By:.*$/i, '').trim();
    if (!clean || clean.startsWith('Merge')) continue;

    if (/^fix[:(]/i.test(clean) || clean.includes('버그') || clean.includes('수정')) {
      fixes.push(clean.replace(/^fix:\s*/i, '').trim());
    } else if (/^feat[:(]/i.test(clean) || clean.includes('추가') || clean.includes('기능')) {
      features.push(clean.replace(/^feat:\s*/i, '').trim());
    } else if (/^v\d+\.\d+/.test(clean)) {
      // 버전 커밋에서 상세 내용 추출
      const lines = clean.split('\n');
      const title = lines[0];
      // "v1.1.2: 설명" 형식에서 설명 부분
      const desc = title.replace(/^v[\d.]+:\s*/, '');
      if (desc) others.push(desc);
    } else {
      others.push(clean);
    }
  }

  let notes = `## TaskNote ${TAG}\n\n`;

  if (features.length > 0) {
    notes += `### ✨ 새 기능\n`;
    for (const f of features) notes += `- ${f}\n`;
    notes += '\n';
  }

  if (fixes.length > 0) {
    notes += `### 🐛 버그 수정\n`;
    for (const f of fixes) notes += `- ${f}\n`;
    notes += '\n';
  }

  if (others.length > 0) {
    notes += `### 📝 기타\n`;
    for (const o of others) notes += `- ${o}\n`;
    notes += '\n';
  }

  if (features.length === 0 && fixes.length === 0 && others.length === 0) {
    notes += '안정성 및 성능 개선\n';
  }

  return notes.trim();
}

// GitHub API 호출
function githubApi(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${OWNER}/${REPO}${endpoint}`,
      method,
      headers: {
        'User-Agent': 'TaskNote-Release-Script',
        'Authorization': `token ${TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let result = '';
      res.on('data', (c) => result += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(result) }); }
        catch { resolve({ status: res.statusCode, data: result }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  console.log(`[Release Notes] ${TAG} 릴리즈 노트 업데이트 중...`);

  // 1. 커밋 메시지 수집
  const commits = getCommitMessages();
  console.log(`[Release Notes] ${commits.length}개 커밋 발견`);

  // 2. 릴리즈 노트 생성
  const notes = formatReleaseNotes(commits);
  console.log('\n--- 릴리즈 노트 미리보기 ---');
  console.log(notes);
  console.log('----------------------------\n');

  // 3. 기존 Release 찾기
  const { status, data: release } = await githubApi('GET', `/releases/tags/${TAG}`);

  if (status === 200 && release.id) {
    // Release가 이미 있으면 업데이트
    const { status: patchStatus } = await githubApi('PATCH', `/releases/${release.id}`, { body: notes });
    if (patchStatus === 200) {
      console.log(`[Release Notes] ✓ ${TAG} 릴리즈 노트 업데이트 완료!`);
    } else {
      console.error(`[Release Notes] 업데이트 실패 (${patchStatus})`);
    }
  } else {
    console.log(`[Release Notes] ${TAG} Release가 아직 없습니다. 빌드 후 다시 실행하세요.`);
    // Release가 없으면 생성
    const { status: createStatus } = await githubApi('POST', '/releases', {
      tag_name: TAG,
      name: `TaskNote ${TAG}`,
      body: notes,
      draft: false,
      prerelease: false,
    });
    if (createStatus === 201) {
      console.log(`[Release Notes] ✓ ${TAG} 릴리즈 생성 완료!`);
    } else {
      console.error(`[Release Notes] 생성 실패 (${createStatus})`);
    }
  }
}

main().catch(console.error);
