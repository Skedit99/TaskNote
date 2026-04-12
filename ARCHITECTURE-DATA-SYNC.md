# TaskNote 데이터 읽기/쓰기 및 동기화 아키텍처

## 1. 전체 구조 개요

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer (React)                                           │
│  useStorage.js ← useTaskData.js ← UI 컴포넌트              │
│       │  ▲                                                  │
│  300ms 디바운스        external-data-changed IPC            │
│       ▼  │                                                  │
├─────── IPC 채널 ────────────────────────────────────────────┤
│  Main Process (Electron)                                    │
│       │                                                     │
│       ├─ save-app-data ──► SQLite (primary) + sync.json     │
│       ├─ load-app-data ──► SQLite 읽기                      │
│       └─ watcher ────────► sync.json 변경 감지              │
├─────────────────────────────────────────────────────────────┤
│  External                                                   │
│       ├─ Google Calendar API (양방향 push/pull)             │
│       └─ 클라우드 폴더 (Google Drive 등) ← sync.json 동기화 │
└─────────────────────────────────────────────────────────────┘
```

- **SQLite** (`taskdata.db`) — 로컬 주 저장소, better-sqlite3 (동기식)
- **sync.json** (`taskdata.sync.json`) — 클라우드 동기화용 JSON 미러, 커스텀 경로 설정 시에만 생성
- **GCal** — Google Calendar API를 통한 양방향 이벤트 동기화

---

## 2. 저장소 계층

### 2-1. SQLite (`electron/database.js` + `electron/storage-sqlite.js`)

**DB 설정**
- 라이브러리: `better-sqlite3` (동기식, main process에서 실행)
- 파일: `taskdata.db`
- WAL 모드 활성화 (동시 읽기/쓰기 성능)
- `busy_timeout = 3000ms`, `synchronous = NORMAL`

**스키마 (v5)**

| 테이블 | PK/UNIQUE | 설명 |
|--------|-----------|------|
| `projects` | PK: `id` | 프로젝트 (subtasks는 JSON 컬럼) |
| `completed_today` | UNIQUE: `(date_key, task_id)` | 날짜별 완료 기록 |
| `recurring` | PK: `id` | 정기 업무 |
| `recurring_overrides` | UNIQUE: `(date_key, recurring_id, type)` | 정기업무 skip/add |
| `scheduled` | UNIQUE: `(date_key, task_id)` | 날짜별 예약 업무 |
| `events` | PK: `id` | 독립 캘린더 이벤트 |
| `quick_tasks` | PK: `id` | 퀵 태스크 템플릿 |
| `gcal_mappings` | PK: `local_id` | 로컬 ↔ Google Calendar 이벤트 매핑 |
| `gcal_queue` | `rowid` | GCal 오프라인 작업 큐 |
| `meta` | PK: `key` | lastUpdated, settings, schema_version |

> **v5 변경사항**: `today_tasks` 테이블 제거됨. 오늘 할일 데이터는 `events` + `scheduled` + `recurring` + `completedToday`에서 실시간 파생 계산 (`deriveTodayTasks()`). `gcal_mappings`에 `sync_hash` 컬럼 추가 (변경 기반 Push용).

**스키마 변천**

| 버전 | 주요 변경 |
|------|----------|
| v1 | 핵심 테이블 생성 (projects, today_tasks, completed_today, recurring 등) |
| v2 | UNIQUE 인덱스 추가 (UPSERT 지원) |
| v3 | Tombstone 모델 도입 (`deleted_at` 컬럼), `recurring_overrides`에 `updated_at` |
| v4 | `gcal_mappings` + `gcal_queue` 테이블 편입 (파일 기반 → SQLite) |
| v5 | `today_tasks` 제거 (파생 뷰 전환), `gcal_mappings.sync_hash` 추가 |

**saveAllData 동작 방식**
- `safeTransaction()` 래퍼로 전체를 단일 트랜잭션으로 실행
- PK 테이블: `INSERT ... ON CONFLICT DO UPDATE` (UPSERT) 후, incoming에 없는 행은 soft delete
- UNIQUE 테이블: 동일한 UPSERT + 잔여 DELETE 패턴
- **프로젝트 저장 최적화**: `updatedAt` 비교로 변경 없는 프로젝트는 SKIP (서브태스크 변경 시 반드시 `p.updatedAt` 갱신 필요)
- `safeTransaction`은 `SQLITE_BUSY`/`SQLITE_LOCKED` 시 최대 3회 재시도 (500ms × 시도횟수 대기)

**loadAllData 동작 방식**
- 모든 테이블을 SELECT → 프론트엔드 JSON 구조로 변환하여 반환
- `completedToday`, `scheduled`, `recurringOverrides`는 `{dateKey: [items]}` 형태로 그룹핑
- `todayTasks` 필드 없음 — 프론트엔드에서 `deriveTodayTasks()`로 파생 계산

**getLastUpdated** — meta 테이블에서 `lastUpdated` 하나만 읽는 경량 함수 (충돌 판정용)

### 2-2. sync.json (`electron/main.js`)

**목적**: 클라우드 폴더(Google Drive 등)를 통한 멀티 PC 동기화

**생성 조건**: `custom-data-path.json`에 커스텀 데이터 경로가 설정된 경우에만 생성

**쓰기 (`writeSyncFile`)**
- 원자적 쓰기: 시스템 임시 폴더에 `.tmp` 파일 생성 → `rename`으로 교체 (rename 실패 시 copy+unlink)
- `selfWriteFlag`를 1.5초간 true로 설정하여 자체 쓰기 시 watcher가 무시하도록 함
- 실패 시 최대 2회 재시도, 최종 실패 시 `pendingSyncData`에 보관하여 다음 저장 때 재시도
- 성공 시 `lastSyncHash` 업데이트 (다음 쓰기 시 변경 감지용)

**외부 변경 보호 (`writeSyncFileWithCheck`)**
- `computeDataHash()`로 현재 데이터 해시 계산 (lastUpdated, _writerDeviceId 제외)
- `lastSyncHash`와 비교 → 동일하면 쓰기 생략 (불필요한 sync.json 갱신 방지)
- `lastSyncWriteTimestamp` 변수로 이 PC가 마지막으로 sync.json에 쓴/읽은 lastUpdated 추적
- 쓰기 전에 sync.json의 현재 `lastUpdated`를 확인
- `syncTimestamp > lastSyncWriteTimestamp`이면 다른 PC가 업데이트한 것으로 판단 → `mergeData()` 후 저장
- 외부 변경 없으면 기존대로 `writeSyncFile()` 직접 호출

---

## 3. 데이터 흐름 상세

### 3-1. 앱 시작 시 (`app.whenReady`)

```
1. SQLite 초기화
   ├─ JSON → SQLite 마이그레이션 (최초 1회: taskdata.json이 있고 DB가 비어있을 때)
   ├─ settings.json → SQLite 마이그레이션
   ├─ GCal 파일 → SQLite 마이그레이션 (gcal-mapping.json/gcal-queue.json → 테이블)
   └─ openDatabase(dbPath) → WAL 모드 + 스키마 마이그레이션 (v1→v5)

2. 클라우드 동기화 체크 (커스텀 경로가 설정된 경우)
   ├─ sync.json 읽기
   ├─ lastSyncWriteTimestamp = syncData.lastUpdated (기준점 기록)
   ├─ sync.json.lastUpdated > DB.lastUpdated → DB에 sync.json 데이터 반영
   └─ 아니면 → 스킵

3. createWindow() → 렌더러 로드
4. archiveOldData(90일) → 오래된 completedToday, scheduled, overrides, tombstone 이벤트 삭제
5. watchDataFile() → sync.json 파일 감시 시작 (chokidar)
```

### 3-2. 렌더러 초기 로드 (`useStorage.js`)

```
1. loadAppData() IPC 호출 → SQLite에서 전체 데이터 로드
2. migrateToNormalizedData() → todayTasks 필드 제거 등 정규화
3. setData(loadedData) → React state 설정
4. initialLoadDoneRef = true → 초기 로드 시 save-back 방지

5. 시작 정리 useEffect (useStorage.js)
   ├─ Ghost 이벤트 정리 (GCal import 오류로 생긴 중복)
   ├─ scheduled에서 이미 완료된 태스크 정리 (잔류 방어)
   └─ 잔여 todayTasks 필드 제거 (마이그레이션)

6. GCal 오프라인 큐 처리 + 초기 동기화 (gcal.syncExisting)
7. GCal 이벤트 Pull (fetchGcalEvents)
8. GCal 변경사항 Pull (pullGcalChanges)
```

### 3-3. 오늘 할일 데이터 파생 (`deriveTodayTasks`)

```
deriveTodayTasks(data) — 호출될 때마다 실시간 계산:
   │
   ├─ 1. events에서 date === 오늘 && !deleted 수집
   │      → { projectId: "event", taskId, time }
   │
   ├─ 2. scheduled[오늘]에서 수집 (done 태스크 제외)
   │      → { projectId, taskId, time }
   │
   ├─ 3. recurring에서 당일 매칭 항목 수집
   │      → getRecurringItemsForDate(data, 오늘)
   │      → { projectId: "recurring", taskId, time }
   │
   ├─ 4. completedToday[오늘]에서 완료 상태 매핑
   │
   └─ 5. 각 항목을 hydrateTask()로 결합하여 반환
```

### 3-4. 사용자 조작 → 저장 (정상 흐름)

```
사용자 클릭/입력
    │
    ▼
updateData(fn) → setData(produce(prev, fn))  ← immer로 불변 업데이트
    │
    ▼
useEffect([data]) 발동
    ├─ latestDataRef.current = data (항상 최신 ref 유지)
    ├─ externalUpdateRef 체크 → 외부 변경이면 return (저장 안 함)
    ├─ dataDirtyRef = true
    └─ 300ms 디바운스 타이머 시작
           │
           ▼ (300ms 후)
       flushData()
           ├─ dataDirtyRef = false
           ├─ ts = Date.now() → 새 타임스탬프 생성
           └─ saveAppData({...data, lastUpdated: ts}) IPC 호출
                  │
                  ▼ (Main Process)
              save-app-data 핸들러
                  ├─ flushPendingSync() → 이전 실패한 sync 쓰기 재시도
                  ├─ 충돌 판정: diskLastUpdated vs incomingData.lastUpdated
                  │     ├─ incoming > disk → 정상 저장
                  │     └─ disk > incoming → 외부 변경 → renderer에 disk 데이터 전송
                  ├─ sqliteStorage.saveAllData(incomingData) → SQLite 저장
                  └─ writeSyncFileWithCheck(incomingData)
                       ├─ computeDataHash 비교 → 변경 없으면 쓰기 생략
                       └─ 변경 있으면 sync.json 저장 (외부 변경 확인 포함)
```

### 3-5. 다른 PC에서 변경 수신 (클라우드 동기화)

```
다른 PC가 sync.json 수정
    │
    ▼ (클라우드 서비스가 파일 전파)
chokidar watcher 감지
    ├─ selfWriteFlag 확인 → true면 무시 (자체 쓰기)
    ├─ _writerDeviceId 확인 → 자기 ID면 무시
    ├─ awaitWriteFinish (500ms 안정화 대기)
    ├─ readJsonFile(sync.json) → 새 데이터 읽기
    ├─ lastSyncWriteTimestamp = newData.lastUpdated (기준점 갱신)
    ├─ sqliteStorage.saveAllData(newData) → SQLite에 반영
    └─ IPC: external-data-changed → renderer에 통지
           │
           ▼ (Renderer)
       onExternalDataChanged 핸들러
           ├─ dataDirtyRef 확인
           │     ├─ 미저장 변경 있음 → mergeOnRenderer()로 병합 (양쪽 보존)
           │     └─ 깨끗한 상태 → 전체 교체
           └─ externalUpdateRef = true → 저장 루프 방지
```

### 3-6. 탭 복귀 시 (`onFocus` 핸들러)

```
window focus 이벤트
    ├─ isCloudSync() 확인 → 로컬 모드면 스킵
    ├─ getLastUpdated() → 경량 타임스탬프 체크
    ├─ diskTs <= local.lastUpdated → 변경 없음, 스킵
    └─ diskTs > local.lastUpdated → 전체 loadAppData() → setData(diskData)
```

### 3-7. 종료 시 (`before-quit`)

```
앱 종료 요청
    │
    ▼
before-quit 이벤트
    ├─ e.preventDefault() → 종료 지연
    ├─ IPC: request-save-before-close → renderer에 저장 요청
    │       │
    │       ▼ (Renderer)
    │   flushData() + flushSettings() → 마지막 데이터 저장
    │   gcal.forceFlush() → GCal 디바운스 큐 즉시 전송
    │   IPC: save-complete → main에 완료 통지
    │
    ├─ save-complete 수신 → app.quit()
    └─ 3초 타임아웃 → 강제 app.quit()

window-all-closed 이벤트
    ├─ dataWatcher.close() → 파일 감시 종료
    └─ closeDatabase() → WAL 체크포인트(TRUNCATE) + DB 닫기
```

---

## 4. 데이터 병합 전략 (`mergeData`)

`main.js`의 `mergeData`와 `useStorage.js`의 `mergeOnRenderer`가 동일한 로직을 사용:

| 데이터 유형 | 병합 키 | 전략 |
|------------|---------|------|
| `projects`, `events`, `recurring`, `quickTasks` | `id` | `updatedAt`이 큰 쪽 우선 |
| `scheduled`, `completedToday` | `dateKey` + `taskId` | `updatedAt`이 큰 쪽 우선 |
| `recurringSkips`, `recurringAdds` | `dateKey` | 양쪽 합집합 (Object spread) |
| `gcalMappings` | `localId` | `lastSynced`가 큰 쪽 우선 |
| `gcalQueue` | `action:localId` | 양쪽 합집합 (중복 제거) |
| `lastUpdated` | - | `Math.max(local, remote)` |

**병합이 발동하는 시점**: `writeSyncFileWithCheck`에서 sync.json의 `lastUpdated`가 `lastSyncWriteTimestamp`보다 클 때

---

## 5. Google Calendar 동기화

### 5-1. 아키텍처

```
┌───────────────────────────────────┐
│ Renderer (gcalHelper.js)          │
│ 디바운스 배치 큐                    │
│ ├─ DEBOUNCE_MS = 1000ms           │
│ ├─ MAX_WAIT_MS = 5000ms           │
│ └─ 3건씩 500ms 간격 전송           │
│         │                         │
│         ▼                         │
│ IPC: gcal-sync-create/update/del  │
├───────────────────────────────────┤
│ Main Process (gcal-sync.js)       │
│ ├─ Google Calendar API 호출        │
│ ├─ gcal_mappings 테이블 (매핑)     │
│ ├─ gcal_queue 테이블 (오프라인 큐)  │
│ ├─ 항상 DB 직접 읽기 (캐시 없음)    │
│ ├─ computeSyncHash (변경 감지)     │
│ └─ 지수 백오프 재시도 (Rate Limit)  │
└───────────────────────────────────┘
```

### 5-2. 디바운스 배치 큐 (`gcalHelper.js`)

**큐 동작**
- `gcal.create/update/del` 호출 시 `_queue`에 추가
- 마지막 enqueue 후 1초 뒤 flush (디바운스)
- 첫 enqueue 후 최대 5초면 강제 flush (무한 지연 방지)

**큐 최적화 (`_optimize`)**

| 기존 액션 | 새 액션 | 결과 |
|-----------|---------|------|
| create | delete | 양쪽 삭제 (상쇄) |
| create | update | create에 필드 병합 |
| update | update | 나중 것으로 병합 |
| update | delete | delete만 남김 |

**flush 동작**
- 최적화된 작업을 3건씩 `Promise.all`로 병렬 전송
- 청크 간 500ms 대기 (Rate Limit 방지)
- flush 중 새 항목 추가 시 완료 후 재 flush

### 5-3. Push: 앱 → Google Calendar

**개별 작업 (gcal.create/update/del)**
- 태스크 생성/수정/삭제/완료 시 해당 함수 호출
- 디바운스 큐를 거쳐 main process로 전달
- `computeSyncHash()` 로 해시 저장 → 다음 syncExisting 시 변경 없으면 skip

**초기 일괄 동기화 (syncExisting)**
- 앱 시작 시 1회 + 10분 주기 + 탭 복귀 시 실행
- 오늘 이후 ~1개월의 모든 일정을 batch로 수집
- 디바운스 큐를 우회하여 직접 `gcalSyncCreate` IPC 호출 (3건씩 500ms 간격)
- 완료 후 `cleanupStaleMapping` 호출 → 유효하지 않은 매핑 정리

**매핑 테이블 (`gcal_mappings`)**

| 컬럼 | 설명 |
|------|------|
| `local_id` | 로컬 ID (PK). 정기업무: `recurring:<taskId>:<YYYY-MM-DD>` |
| `gcal_event_id` | Google Calendar 이벤트 ID |
| `last_synced` | 마지막 동기화 시각 (ISO) |
| `type` | `event` / `scheduled` / `recurring` / `imported` |
| `date_key` | 이벤트 날짜 |
| `summary` | 이벤트 제목 (변경 감지용) |
| `sync_hash` | 내용 해시 (변경 기반 Push용) |

### 5-4. Pull: Google Calendar → 앱

**새 이벤트 가져오기 (`fetchGcalEvents`)**
- 현재 보고 있는 월의 GCal 이벤트를 가져옴
- 매핑에 있는 이벤트 (push한 것) + `tasknote=true` 속성이 있는 이벤트는 건너뜀
- 새로운 외부 이벤트는 독립 일정(`events`)으로 import
- import 시 `saveImportMapping`으로 매핑 저장 + GCal에 `tasknote=true` 마커 추가

**기존 이벤트 변경 감지 (`pullChangesFromGcal`)**
- `tasknote=true` 이벤트만 조회 (앱이 push한 이벤트)
- gcal_mappings 역방향 조회로 로컬 ID 매핑
- 변경사항 감지 및 반영:

| 감지 항목 | 반영 방식 |
|----------|----------|
| 제목 변경 | 로컬 이벤트/서브태스크 이름 업데이트, `p.updatedAt` 갱신 |
| 날짜 변경 | 로컬 이벤트 날짜 변경 + scheduled 이동 |
| `(완료)` 추가 | `completedToday`에 추가, `task.done = true` |
| `(완료)` 제거 | `completedToday`에서 제거, `task.done = false` |

**Ghost 이벤트 정리** (앱 시작 시)
- GCal에서 잘못 import된 이벤트(프로젝트/정기 업무 이름과 중복) 자동 제거

### 5-5. 매핑 정리 (`cleanupStaleMapping`)

- `syncExisting` 완료 후 호출
- batch에 포함된 `validLocalIds`에 없는 매핑 = "잔여"로 판정
- **보호 대상**: `type === 'imported'` + 최근 7일 이내 `type === 'recurring'` 매핑
- 잔여 매핑의 GCal 이벤트 삭제 + 매핑 제거

### 5-6. 오프라인 큐 (`gcal_queue` 테이블)

- 네트워크 오류/Rate Limit 발생 시 SQLite `gcal_queue`에 작업 저장
- 앱 시작 시/포커스 시 `processOfflineQueue` 호출하여 재시도
- 큐 최적화: create→delete 쌍 제거, 같은 localId의 update는 마지막 것만 유지
- 요청 간 300ms 딜레이

### 5-7. 완료 상태 반영

- 태스크 완료 시 GCal 이벤트 제목에 `(완료)` 접두사 추가 (`gcal.update`)
- 완료 해제 시 접두사 제거
- `completeForDate`: 날짜 파라미터 사용 → `recurring:<taskId>:<dateKey>` 형식
- `toggleTodayTask`: `todayKey()` 사용 → `recurring:<taskId>:<오늘날짜>` 형식
- GCal에서 `(완료)` 태그를 직접 추가/제거하면 `pullChangesFromGcal`이 감지하여 앱에 반영

### 5-8. 자동 동기화 주기

```
10분 주기 syncCycle:
  1. gcal.syncExisting(data)       — Push 보정: 누락 항목 재동기화
  2. gcal.flushOfflineQueue()      — 오프라인 큐 재시도
  3. fetchGcalEvents()             — 새 이벤트 import
  4. pullGcalChanges()             — 기존 이벤트 변경사항 반영
```

---

## 6. 충돌 해결 전략

### 6-1. SQLite 레벨 (로컬 충돌)

```
save-app-data 핸들러:
  diskLastUpdated = SQLite meta에서 읽기
  if incoming.lastUpdated > diskLastUpdated → 정상 저장
  if diskLastUpdated > incoming.lastUpdated → 외부 변경으로 판단
    → disk 데이터를 renderer에 전송 (external-data-changed)
  if 동일 → 정상 저장
```

### 6-2. sync.json 레벨 (멀티 PC 충돌)

```
writeSyncFileWithCheck:
  1. computeDataHash 비교 → 데이터 변경 없으면 쓰기 생략 (dirty tracking)
  2. sync.json의 lastUpdated 확인
     if syncTimestamp > lastSyncWriteTimestamp → 다른 PC가 업데이트함
       → mergeData(incoming, syncData)로 병합
       → 병합 결과를 SQLite + sync.json에 저장
       → renderer에 병합 결과 통지
     else → 기존대로 writeSyncFile 호출
```

### 6-3. Renderer 레벨 (React state 충돌)

```
onExternalDataChanged:
  if dataDirtyRef (미저장 변경 있음) → mergeOnRenderer()로 병합 (양쪽 보존)
  if 깨끗한 상태 → 전체 교체 (newData.lastUpdated >= prev.lastUpdated일 때)
  externalUpdateRef = true → 저장 루프 방지

onDataConflict:
  강제 전체 교체 (최신 데이터 기준)
```

---

## 7. 타이머/주기 정리

| 타이머 | 위치 | 값 | 용도 |
|--------|------|-----|------|
| 데이터 저장 디바운스 | useStorage.js | 300ms | React state → SQLite 저장 |
| GCal 큐 디바운스 | gcalHelper.js | 1000ms | GCal API 호출 배치 |
| GCal 큐 최대 대기 | gcalHelper.js | 5000ms | 무한 지연 방지 |
| GCal 큐 청크 간격 | gcalHelper.js | 500ms | Rate Limit 방지 |
| GCal 오프라인 큐 간격 | gcal-sync.js | 300ms | 요청 간 대기 |
| selfWriteFlag 해제 | main.js | 1500ms | watcher 자기 쓰기 무시 |
| watcher 안정화 | main.js | 500ms | 파일 쓰기 완료 대기 |
| 종료 전 타임아웃 | main.js | 3000ms | 강제 종료 |
| 자동 동기화 주기 | useTaskData.js | 10분 | Push 보정 + Pull |
| 탭 복귀 최소 간격 | useTaskData.js | 5분 | 불필요한 동기화 방지 |
| DB 잠금 재시도 | database.js | 500ms × 시도 | SQLITE_BUSY 재시도 |
| GCal 지수 백오프 | gcal-sync.js | 1000ms × 2^n | Rate Limit/네트워크 재시도 |

---

## 8. 주요 변수/플래그 정리

| 변수 | 위치 | 용도 |
|------|------|------|
| `selfWriteFlag` | main.js | 자체 sync.json 쓰기 시 watcher 무시 |
| `lastSyncWriteTimestamp` | main.js | 마지막 sync.json 쓰기/읽기 시점 추적 |
| `lastSyncHash` | main.js | 마지막 sync.json 쓰기 시 데이터 해시 (dirty tracking) |
| `pendingSyncData` | main.js | 실패한 sync.json 쓰기 데이터 보관 |
| `saveBeforeQuitDone` | main.js | 종료 전 저장 완료 여부 |
| `deviceId` | main.js | 이 PC 고유 식별자 (자기 쓰기 판별) |
| `dataDirtyRef` | useStorage.js | 미저장 변경 있음 플래그 |
| `externalUpdateRef` | useStorage.js | 외부 데이터 수신 시 저장 방지 |
| `initialLoadDoneRef` | useStorage.js | 초기 로드 시 save-back 방지 |
| `lastSavedTimestampRef` | useStorage.js | 마지막 저장 시 사용한 lastUpdated |
| `_flushing` | gcalHelper.js | GCal 큐 flush 진행 중 플래그 |
| `_syncRunning` | gcalHelper.js | syncExisting 중복 실행 방지 |
| `_initialSyncDone` | gcalHelper.js | 초기 GCal 동기화 완료 플래그 |

---

## 9. 파일 경로 구조

```
<userData>/                          (기본: %APPDATA%/tasknote)
  ├─ taskdata.db                     ← SQLite 주 저장소
  ├─ custom-data-path.json           ← 커스텀 경로 설정
  ├─ gcal-mapping.json.backup        ← GCal 매핑 (v4 마이그레이션 후 백업)
  └─ gcal-queue.json.backup          ← GCal 큐 (v4 마이그레이션 후 백업)

<customPath>/                        (클라우드 폴더, 예: Google Drive)
  ├─ taskdata.db                     ← SQLite (커스텀 경로 모드)
  └─ taskdata.sync.json              ← 클라우드 동기화용 JSON
```

---

## 10. 알려진 보호 메커니즘 요약

1. **300ms 디바운스** — 빠른 UI 변경 시 저장 횟수 제한
2. **GCal 배치 큐** — 1초 디바운스 + 5초 최대 대기 + 큐 최적화 (상쇄/병합)
3. **safeTransaction** — SQLite 잠금 시 최대 3회 재시도
4. **selfWriteFlag** — 자체 sync.json 쓰기 시 watcher 무시 (1.5초)
5. **writeSyncFileWithCheck** — sync.json 쓰기 전 외부 변경 감지 → 병합
6. **computeDataHash (dirty tracking)** — 데이터 변경 없으면 sync.json 쓰기 생략
7. **lastSyncWriteTimestamp** — 다른 PC의 sync.json 업데이트 감지 기준점
8. **externalUpdateRef** — 외부 데이터 수신 시 저장 루프 방지
9. **initialLoadDoneRef** — 초기 로드 시 save-back 방지
10. **종료 전 핸드셰이크** — 3초 타임아웃 내 데이터 플러시
11. **GCal 오프라인 큐** — 네트워크 실패 시 SQLite에 보관 → 재시도
12. **GCal 매핑 보호** — 최근 7일 이내 과거 정기업무 매핑 삭제 방지
13. **원자적 파일 쓰기** — tmp → rename 패턴으로 파일 손상 방지
14. **프로젝트 updatedAt 연동** — 서브태스크 변경 시 부모 프로젝트 updatedAt 갱신 (저장 보장)
15. **GCal 매핑 캐시 없음** — 항상 SQLite에서 직접 읽기 (불일치 방지)
