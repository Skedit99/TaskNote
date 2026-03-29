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

// GitHub에서 이전 릴리즈 태그 찾기 (로컬 태그 없어도 동작)
async function getPreviousTag() {
  try {
    // GitHub API에서 릴리즈 목록 가져오기 (최신순)
    const { status, data: releases } = await githubApi('GET', '/releases?per_page=20');
    if (status === 200 && Array.isArray(releases)) {
      // 현재 버전이 아닌 published 릴리즈 중 가장 최신 것
      const prev = releases.find(r => r.tag_name !== TAG && !r.draft);
      if (prev) return prev.tag_name;
    }
  } catch {}

  // GitHub API 실패 시 로컬 태그 fallback
  try {
    const tags = execSync('git tag --sort=-creatordate', { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    const currentIdx = tags.indexOf(TAG);
    if (currentIdx >= 0 && tags[currentIdx + 1]) return tags[currentIdx + 1];
    if (tags.length >= 2) return tags[1];
  } catch {}

  return null;
}

// 이전 릴리즈 커밋을 찾아서 해당 버전 커밋 이후의 메시지만 수집
async function getCommitMessages() {
  const prevTag = await getPreviousTag();
  console.log(`[Release Notes] 이전 릴리즈: ${prevTag || '없음'}`);

  // 로컬에 태그가 없을 수 있으므로, 버전 커밋 메시지로 범위 특정
  if (prevTag) {
    // 먼저 로컬 태그로 시도
    try {
      const log = execSync(`git log ${prevTag}..HEAD --pretty=format:"%s" --no-merges`, { encoding: 'utf-8' }).trim();
      return log.split('\n').filter(Boolean);
    } catch {}

    // 로컬 태그 없으면, 커밋 메시지에서 이전 버전 커밋 찾기
    // "v1.1.1: ..." 형식의 버전 커밋만 중단점으로 인식 (본문에 버전이 언급된 건 무시)
    const prevVersion = prevTag.replace('v', '');
    const versionCommitPattern = new RegExp(`^v?${prevVersion.replace(/\./g, '\\.')}[:\\s]`);
    try {
      const allLog = execSync('git log --pretty=format:"%H %s" --no-merges -50', { encoding: 'utf-8' }).trim();
      const lines = allLog.split('\n').filter(Boolean);
      const commits = [];
      for (const line of lines) {
        const msg = line.substring(41); // hash(40) + space(1)
        // "v1.1.1: ..." 또는 "1.1.1: ..." 로 시작하는 버전 커밋만 중단
        if (versionCommitPattern.test(msg)) break;
        commits.push(msg);
      }
      if (commits.length > 0) return commits;
    } catch {}
  }

  // fallback: 최근 5개 커밋만
  try {
    const log = execSync('git log HEAD~5..HEAD --pretty=format:"%s" --no-merges', { encoding: 'utf-8' }).trim();
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

    // 내부 작업 커밋 제외 (다운로드 링크 변경, 홈페이지 링크 등)
    if (/다운로드\s*링크/i.test(clean) || /download\s*link/i.test(clean)) continue;

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
  const commits = await getCommitMessages();
  console.log(`[Release Notes] ${commits.length}개 커밋 발견`);

  // 2. 릴리즈 노트 생성
  const notes = formatReleaseNotes(commits);
  console.log('\n--- 릴리즈 노트 미리보기 ---');
  console.log(notes);
  console.log('----------------------------\n');

  // 3. 기존 Release 찾기 (Draft 포함)
  // /releases/tags/ API는 Draft를 못 찾으므로, 전체 목록에서 검색
  let release = null;

  // 먼저 published release 검색
  const { status, data: pubRelease } = await githubApi('GET', `/releases/tags/${TAG}`);
  if (status === 200 && pubRelease.id) {
    release = pubRelease;
  }

  // 없으면 Draft 포함 전체 목록에서 검색
  if (!release) {
    const { status: listStatus, data: allReleases } = await githubApi('GET', '/releases?per_page=10');
    if (listStatus === 200 && Array.isArray(allReleases)) {
      release = allReleases.find(r => r.tag_name === TAG);
    }
  }

  if (release && release.id) {
    // Release가 이미 있으면 업데이트 (Draft → Published 전환 + 릴리즈 노트)
    const updateBody = {
      body: notes,
      name: `TaskNote ${TAG}`,
      draft: false,
    };
    const { status: patchStatus } = await githubApi('PATCH', `/releases/${release.id}`, updateBody);
    if (patchStatus === 200) {
      console.log(`[Release Notes] ✓ ${TAG} 릴리즈 노트 업데이트 완료! (Draft→Published)`);
    } else {
      console.error(`[Release Notes] 업데이트 실패 (${patchStatus})`);
    }
  } else {
    console.log(`[Release Notes] ${TAG} Release가 아직 없습니다. 새로 생성합니다.`);
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
