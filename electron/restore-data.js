/**
 * restore-data.js — 데이터 복구 스크립트 (JSON 기반)
 *
 * taskdata.json.backup (3/30 원본) + taskdata.json (4월 gcal 이벤트)를
 * 병합하여 taskdata.json과 sync.json에 저장합니다.
 * 기존 DB를 제거하면 앱 시작 시 자동으로 JSON → SQLite 마이그레이션이 실행됩니다.
 *
 * 사용법: node electron/restore-data.js "C:\Users\Ryzen 3600\Desktop\TaskNote Project"
 */
const fs = require('fs');
const path = require('path');

const dataDir = process.argv[2];
if (!dataDir) {
  console.error('사용법: node electron/restore-data.js <데이터 폴더 경로>');
  process.exit(1);
}

const backupPath = path.join(dataDir, 'taskdata.json.backup');
const jsonPath = path.join(dataDir, 'taskdata.json');
const syncPath = path.join(dataDir, 'taskdata.sync.json');
const dbPath = path.join(dataDir, 'taskdata.db');
const walPath = dbPath + '-wal';
const shmPath = dbPath + '-shm';

// 1. 파일 존재 확인
if (!fs.existsSync(backupPath)) {
  console.error('taskdata.json.backup 파일이 없습니다:', backupPath);
  process.exit(1);
}

console.log('=== TaskNote 데이터 복구 시작 ===\n');

// 2. 백업 데이터 로드 (3/30 원본)
const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
console.log('[백업 데이터] (taskdata.json.backup)');
console.log(`  - 프로젝트: ${(backupData.projects || []).length}개`);
console.log(`  - 오늘할일: ${(backupData.todayTasks || []).length}개`);
console.log(`  - 반복일정: ${(backupData.recurring || []).length}개`);
console.log(`  - 이벤트: ${(backupData.events || []).length}개`);
console.log(`  - 퀵태스크: ${(backupData.quickTasks || []).length}개`);
console.log(`  - 완료기록 날짜: ${Object.keys(backupData.completedToday || {}).length}일\n`);

// 3. 현재 JSON 데이터 로드 (4월 gcal 이벤트)
let currentData = null;
if (fs.existsSync(jsonPath)) {
  currentData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  console.log('[현재 데이터] (taskdata.json)');
  console.log(`  - 이벤트: ${(currentData.events || []).length}개\n`);
}

// 4. 병합: 백업 기반 + 현재 JSON의 신규 이벤트 추가
const merged = { ...backupData };

if (currentData && currentData.events) {
  const backupEventIds = new Set((backupData.events || []).map(e => e.id));
  const backupGcalIds = new Set(
    (backupData.events || []).filter(e => e.gcalSourceId).map(e => e.gcalSourceId)
  );

  let addedCount = 0;
  for (const ev of currentData.events) {
    if (!backupEventIds.has(ev.id) && !(ev.gcalSourceId && backupGcalIds.has(ev.gcalSourceId))) {
      merged.events.push(ev);
      addedCount++;
      console.log(`  [+] 신규 이벤트 추가: "${ev.name}" (${ev.date})`);
    }
  }
  console.log(`\n총 ${addedCount}개 신규 이벤트 병합됨`);
}

// 5. lastUpdated를 현재 시각으로 갱신
merged.lastUpdated = Date.now();

// 6. 기존 DB 파일 백업 후 제거 (앱 시작 시 JSON→SQLite 마이그레이션 유도)
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
if (fs.existsSync(dbPath)) {
  // 이전 백업이 이미 있으면 중복 백업 스킵
  const existingBackups = fs.readdirSync(dataDir).filter(f => f.startsWith('taskdata.db.pre-restore'));
  if (existingBackups.length === 0) {
    fs.copyFileSync(dbPath, path.join(dataDir, `taskdata.db.pre-restore-${timestamp}`));
    console.log(`\n[백업] 기존 DB 백업 완료`);
  } else {
    console.log(`\n[백업] 기존 DB 백업이 이미 존재 — 스킵`);
  }
  fs.unlinkSync(dbPath);
  console.log('[제거] taskdata.db 삭제 (마이그레이션 유도)');
}
if (fs.existsSync(walPath)) {
  fs.unlinkSync(walPath);
  console.log('[제거] taskdata.db-wal 삭제');
}
if (fs.existsSync(shmPath)) {
  fs.unlinkSync(shmPath);
  console.log('[제거] taskdata.db-shm 삭제');
}

// 7. 복구 데이터를 JSON 파일에 저장
fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2), 'utf-8');
console.log('\n[복구] taskdata.json에 병합 데이터 저장 완료');

fs.writeFileSync(syncPath, JSON.stringify(merged), 'utf-8');
console.log('[복구] taskdata.sync.json 갱신 완료');

// 8. 결과 요약
console.log('\n=== 복구 완료 ===');
console.log(`  프로젝트: ${merged.projects.length}개`);
console.log(`  오늘할일: ${merged.todayTasks.length}개`);
console.log(`  반복일정: ${merged.recurring.length}개`);
console.log(`  이벤트: ${merged.events.length}개`);
console.log(`  퀵태스크: ${merged.quickTasks.length}개`);
console.log(`  완료기록: ${Object.keys(merged.completedToday || {}).length}일`);
console.log('\n앱을 재시작하면 자동으로 JSON → SQLite 마이그레이션이 실행되고');
console.log('복구된 데이터가 표시됩니다.');
