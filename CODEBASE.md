# TaskNote V2 코드베이스 문서

## 프로젝트 개요

Electron + React + SQLite 기반 데스크탑 업무 관리 앱.
프로젝트 관리, 일정 예약, 정기 업무, Google Calendar 양방향 동기화, 멀티 디바이스 클라우드 동기화를 지원한다.

**기술 스택**: Electron 36 / React 19 / Vite 8 / better-sqlite3 / Immer / googleapis

---

## 파일 구조 및 역할

### Electron (Main Process)

| 파일 | 줄 수 | 역할 |
|------|-------|------|
| `electron/main.js` | 1,103 | 앱 라이프사이클, 윈도우 관리, IPC 핸들러, sync.json 감시, 데이터 병합 |
| `electron/preload.js` | 68 | IPC 브릿지 (`window.electronAPI` 노출) |
| `electron/database.js` | 402 | SQLite 열기/닫기, 스키마 정의, v1~v5 마이그레이션 |
| `electron/storage-sqlite.js` | 534 | JSON ↔ SQLite 어댑터 (`loadAllData`, `saveAllData`) |
| `electron/gcal-sync.js` | 884 | Google Calendar CRUD, 매핑 관리, 오프라인 큐, Pull 변경 감지 |
| `electron/google-auth.js` | 337 | OAuth2 PKCE 인증, 토큰 암호화/갱신 |
| `electron/migrate-json-to-sqlite.js` | 405 | JSON → SQLite 1회 마이그레이션 |
| `electron/restore-data.js` | 115 | 백업 데이터 복구 스크립트 |

### React Hooks (상태 관리)

| 파일 | 줄 수 | 역할 |
|------|-------|------|
| `src/hooks/useTaskData.js` | 649 | **메인 상태 허브**. 모든 액션 훅 통합, GCal 폴링, 이벤트 CRUD |
| `src/hooks/useStorage.js` | 374 | React ↔ SQLite 브릿지. 디바운스 저장, 외부 변경 병합, 시작 정리 |
| `src/hooks/useTodayTasks.js` | 289 | 완료 토글, 날짜별 완료/미완료, 예약 관리, 파생 상태 계산 |
| `src/hooks/useProjects.js` | 249 | 프로젝트/서브태스크 CRUD, 드래그 앤 드롭 이동 |
| `src/hooks/useRecurring.js` | 186 | 정기 업무 CRUD, skip/add 오버라이드, GCal 미래 인스턴스 Push |
| `src/hooks/useElectronWindow.js` | 81 | 위젯 모드, 항상 위, 잠금, 투명도, 윈도우 제어 |
| `src/hooks/gcalHelper.js` | 380 | GCal 디바운스 배치 큐, 큐 최적화, syncExisting |

### UI 컴포넌트

| 파일 | 줄 수 | 역할 |
|------|-------|------|
| `src/App.jsx` | 294 | 루트 컴포넌트. 레이아웃, 모달 라우팅, 약관 동의 |
| `src/components/Calendar.jsx` | 242 | 메인 캘린더 뷰. 월 그리드, 일자별 상세 (이벤트/예약/정기/완료) |
| `src/components/MiniCalendar.jsx` | 268 | 캘린더 위젯 모드. 축소 그리드 + 일자별 완료 토글 |
| `src/components/MiniToday.jsx` | 230 | 오늘할일 위젯 모드. 미완료/완료 목록, 진행률 |
| `src/components/Sidebar.jsx` | 371 | 우측 사이드바. 오늘할일 탭, 프로젝트 탭, 아카이브 탭 |
| `src/components/TaskItem.jsx` | 206 | 서브태스크 행. 드래그 앤 드롭, +오늘/+날짜 버튼, 인라인 편집 |
| `src/components/ResizeEdges.jsx` | 42 | 위젯 모드 리사이즈 핸들 |
| `src/components/WinControls.jsx` | 17 | 최소화/최대화/닫기 커스텀 타이틀바 |
| `src/components/GlobalCSS.jsx` | 16 | 전역 스타일 (스크롤바, 드래그 영역) |

### 모달

| 파일 | 줄 수 | 역할 |
|------|-------|------|
| `src/components/modals/SettingsModal.jsx` | 399 | 설정 모달. GCal 연동, 데이터 경로, 테마, 버전 관리 |
| `src/components/modals/CalendarEventForm.jsx` | 133 | 캘린더 이벤트 추가 폼 (독립일정/서브태스크 선택) |
| `src/components/modals/FormComponents.jsx` | 308 | 재사용 모달: 프로젝트/서브태스크/정기업무/퀵태스크/편입 폼 |

### 유틸리티

| 파일 | 줄 수 | 역할 |
|------|-------|------|
| `src/utils/selectors.js` | 249 | 파생 상태 셀렉터: `deriveTodayTasks`, `getRecurringItemsForDate`, `hydrateTask` |
| `src/utils/helpers.js` | 94 | 유틸 함수: `generateId`, `todayKey`, `findTaskById`, `weeksBetween` |
| `src/constants/index.js` | 26 | 앱 상수: `defaultData`, `STORAGE_KEY`, `MAX_ACTIVE_PROJECTS` |
| `src/constants/theme.js` | 38 | 테마 정의: `THEMES.light/dark`, 프로젝트 컬러 팔레트 |

---

## 데이터 모델

### 앱 전체 데이터 구조

```
AppData {
  projects: Project[]            — 프로젝트 목록 (서브태스크는 중첩 JSON)
  completedToday: {              — 날짜별 완료 기록
    "YYYY-MM-DD": CompletedItem[]
  }
  recurring: RecurringTask[]     — 정기 업무 템플릿
  recurringSkips: {              — 정기업무 건너뛰기 오버라이드
    "YYYY-MM-DD": RecurringId[]
  }
  recurringAdds: {               — 정기업무 수동 추가 오버라이드
    "YYYY-MM-DD": RecurringId[]
  }
  scheduled: {                   — 날짜별 예약 업무
    "YYYY-MM-DD": ScheduledItem[]
  }
  events: Event[]                — 독립 캘린더 이벤트
  quickTasks: QuickTask[]        — 퀵 태스크 템플릿
  lastUpdated: number            — 최종 수정 시각 (ms)
}
```

### 핵심 엔티티

**Project** — 프로젝트
```
{
  id, name, deadline?, colorId,
  subtasks: SubtaskNode[],   ← 재귀 트리 구조
  archived, deleted, updatedAt
}
```

**SubtaskNode** — 서브태스크 (트리 노드)
```
{
  id, name, done, description?,
  time?, endTime?,
  children: SubtaskNode[],   ← 하위 업무 중첩
  updatedAt
}
```

**Event** — 독립 이벤트
```
{
  id, name, description, date, time?, endTime?,
  gcalSourceId?,   ← GCal에서 import된 경우
  quickTaskId?,    ← 퀵태스크에서 생성된 경우
  deleted,         ← Soft Delete (Tombstone)
  updatedAt
}
```

**RecurringTask** — 정기 업무
```
{
  id, name,
  type: "weekly" | "monthly",
  dayValue,        ← 0-6(요일) / 1-31(일) / -1(말일)
  interval,        ← 1=매주, 2=격주...
  startDate?, endDate?,
  monthlyMode?: "nthWeekday",
  nthWeek?, nthDayOfWeek?,
  active, updatedAt
}
```

### 파생 데이터 (저장 안 됨)

**오늘 할일** — `deriveTodayTasks(data)` 함수가 실시간 계산:
1. `events`에서 당일 이벤트 수집
2. `scheduled[오늘]`에서 예약 업무 수집
3. `recurring`에서 당일 매칭 항목 수집
4. `completedToday[오늘]`에서 완료 상태 매핑
5. `hydrateTask()`로 이름/설명 결합

---

## 컴포넌트 트리

```
App.jsx
├─ [약관 미동의] TermsAgreement
├─ [miniMode=today] MiniToday
├─ [miniMode=calendar] MiniCalendar
└─ [일반 모드]
    ├─ Header (제목, 동기화, 테마, 설정, 위젯 전환)
    ├─ Content (flex)
    │   ├─ Calendar (좌측 flex)
    │   │   ├─ 월 탐색 (이전/다음 월)
    │   │   ├─ 캘린더 그리드
    │   │   │   └─ 일자 셀: 이벤트/예약/정기/완료 표시
    │   │   └─ 선택 날짜 상세 (renderDayDetail)
    │   │       ├─ ⚑ 독립 일정
    │   │       ├─ ◇ 예약된 업무
    │   │       ├─ ↻ 정기 업무
    │   │       ├─ ↯ 퀵 일정
    │   │       └─ ✓ 완료한 일
    │   └─ Sidebar (우측 토글)
    │       ├─ 오늘할일 탭 (pendingToday + doneToday)
    │       ├─ 프로젝트 탭
    │       │   └─ TaskItem (재귀, 드래그 앤 드롭)
    │       │       ├─ +오늘 버튼 → addToScheduled(today)
    │       │       ├─ +날짜 버튼 → addToScheduled(선택일)
    │       │       └─ 인라인 편집/삭제
    │       └─ 아카이브 탭
    └─ 모달 오버레이
        ├─ SettingsModal (설정, GCal 인증, 데이터 관리)
        ├─ CalendarEventForm (독립일정/서브태스크 추가)
        ├─ ProjectForm, SubtaskForm, EditTaskForm
        ├─ RecurringForm (정기업무 추가/수정)
        ├─ QuickTaskForm, ConvertEventForm
        └─ Alert/Confirm 다이얼로그
```

---

## 상태 관리 체계

### 훅 의존 관계

```
useStorage()                ← SQLite 영속화, 외부 병합
    │
    └─► useTaskData()       ← 메인 오케스트레이터
          ├─ createProjectActions()      ← useProjects.js
          ├─ createTodayTaskActions()    ← useTodayTasks.js
          ├─ createRecurringActions()    ← useRecurring.js
          ├─ createElectronWindowActions() ← useElectronWindow.js
          ├─ fetchGcalEvents()          ← GCal Pull (새 이벤트)
          ├─ pullGcalChanges()          ← GCal Pull (변경 감지)
          └─ gcal (gcalHelper.js)       ← GCal Push 큐

App.jsx
    └─ const ctx = useTaskData()
        ├─ <Calendar ctx={ctx} />
        ├─ <Sidebar ctx={ctx} />
        ├─ <MiniToday ctx={ctx} />
        └─ <MiniCalendar ctx={ctx} />
```

### 데이터 상태 (`useStorage`)

| 상태 | 타입 | 설명 |
|------|------|------|
| `data` | AppData | 앱 전체 데이터 |
| `loaded` | boolean | 초기 로드 완료 여부 |
| `themeKey` | string | "light" / "dark" |
| `miniSettings` | object | 위젯별 투명도 설정 |
| `calendarRange` | number | 월 단위 범위 프리뷰 |
| `windowMode` | string | "normal" / "alwaysOnTop" / "widget" |
| `agreedTerms` | boolean | 약관 동의 여부 |

### UI 상태 (`useTaskData`)

| 상태 | 타입 | 설명 |
|------|------|------|
| `sideTab` | string/null | 사이드바 탭 ("today"/"projects"/"archived"/null) |
| `activeProject` | string/null | 선택된 프로젝트 ID |
| `modal` | object/null | 현재 표시 모달 `{ type, ...params }` |
| `editingTask` | string/null | 인라인 편집 중인 태스크 ID |
| `expanded` | object | 펼쳐진 서브태스크 부모 ID 맵 |
| `calYear, calMonth` | number | 캘린더 현재 년/월 |
| `selectedDay` | number/null | 선택된 날짜 |
| `miniMode` | string/false | 위젯 모드 ("today"/"calendar"/false) |
| `isLocked` | boolean | 위치 잠금 |
| `holidays` | object | 공휴일 맵 `{ "YYYY-MM-DD": "공휴일명" }` |

### 파생 상태 (매 렌더마다 계산)

| 상태 | 소스 | 설명 |
|------|------|------|
| `pendingToday` | `deriveTodayTasks` | 오늘 미완료 업무 |
| `doneToday` | `deriveTodayTasks` | 오늘 완료 업무 (시간순 정렬) |
| `activeProjects` | `data.projects` | 미아카이브/미삭제 프로젝트 |
| `archivedProjects` | `data.projects` | 아카이브된 프로젝트 |

---

## IPC 채널 목록

### 데이터 I/O

| 채널명 | 방향 | 설명 |
|--------|------|------|
| `load-app-data` | R→M | SQLite에서 전체 데이터 로드 |
| `save-app-data` | R→M | SQLite + sync.json 저장 |
| `load-settings` | R→M | 설정 로드 (meta 테이블) |
| `save-settings` | R→M | 설정 저장 |
| `get-last-updated` | R→M | lastUpdated만 경량 조회 |
| `is-cloud-sync` | R→M | 클라우드 동기화 모드 여부 |
| `external-data-changed` | M→R | 외부 데이터 변경 통지 |
| `data-conflict` | M→R | 데이터 충돌 통지 |
| `request-save-before-close` | M→R | 종료 전 저장 요청 |
| `save-complete` | R→M | 저장 완료 통지 |

### Google Calendar

| 채널명 | 방향 | 설명 |
|--------|------|------|
| `gcal-login` | R→M | OAuth2 인증 시작 |
| `gcal-logout` | R→M | 로그아웃 (토큰 삭제) |
| `gcal-status` | R→M | 인증 상태 확인 |
| `gcal-sync-create` | R→M | GCal 이벤트 생성 |
| `gcal-sync-update` | R→M | GCal 이벤트 수정 |
| `gcal-sync-delete` | R→M | GCal 이벤트 삭제 |
| `gcal-sync-delete-multiple` | R→M | GCal 이벤트 다중 삭제 |
| `gcal-sync-flush-queue` | R→M | 오프라인 큐 처리 |
| `gcal-fetch-events` | R→M | GCal에서 이벤트 가져오기 |
| `gcal-fetch-holidays` | R→M | 공휴일 캘린더 가져오기 |
| `gcal-pull-changes` | R→M | 기존 이벤트 변경사항 감지 |
| `gcal-save-import-mapping` | R→M | import 매핑 저장 |
| `gcal-cleanup-stale` | R→M | 잔여 매핑 정리 |
| `gcal-full-reset` | R→M | 전체 GCal 동기화 리셋 |
| `gcal-deduplicate` | R→M | 중복 GCal 이벤트 정리 |

### 윈도우/시스템

| 채널명 | 방향 | 설명 |
|--------|------|------|
| `set-mini-mode` | R→M | 위젯 모드 전환 |
| `set-opacity` | R→M | 배경 투명도 설정 |
| `set-locked` | R→M | 위치 잠금 |
| `set-always-on-top` | R→M | 항상 위 설정 |
| `set-window-level` | R→M | 윈도우 레벨 (normal/widget) |
| `window-minimize/maximize/close` | R→M | 윈도우 제어 |
| `get-bounds/set-bounds` | R→M | 윈도우 위치/크기 |
| `get-data-path` | R→M | 현재 데이터 경로 |
| `select-data-folder` | R→M | 폴더 선택 다이얼로그 |
| `set-data-path/reset-data-path` | R→M | 데이터 경로 변경/초기화 |
| `get-app-version` | R→M | 앱 버전 조회 |
| `check-for-update` | R→M | 업데이트 확인 |
| `get-auto-launch/set-auto-launch` | R→M | 자동 시작 설정 |

---

## 주요 액션 함수 목록

### 프로젝트 (`useProjects.js`)

| 함수 | 설명 | GCal |
|------|------|------|
| `addProject(name, deadline, colorId)` | 프로젝트 추가 | - |
| `editProject(id, name, deadline, colorId)` | 프로젝트 수정 | - |
| `deleteProject(id)` | Soft delete + scheduled/completed 정리 | `delMultiple` |
| `archiveProject(id)` | 아카이브 | - |
| `restoreProject(id)` | 복원 | - |
| `reorderProjects(newOrder)` | 순서 변경 | - |
| `addSubtask(pid, name, parentId)` | 서브태스크 추가 | - |
| `editSubtask(pid, tid, name)` | 이름 변경 | `update` |
| `editSubtaskDesc(pid, tid, desc)` | 설명 변경 | `update` |
| `editSubtaskTime(pid, tid, time, endTime)` | 시간 변경 | `update` |
| `deleteSubtask(pid, tid)` | 삭제 + scheduled/completed 정리 | `del` |
| `moveTaskUnder(pid, dragId, targetId)` | 하위로 이동 | `del` |
| `moveTaskBeside(pid, dragId, targetId, pos)` | 형제로 이동 | - |

### 오늘 할일 / 예약 (`useTodayTasks.js`)

| 함수 | 설명 | GCal |
|------|------|------|
| `toggleTodayTask(tid)` | 오늘 업무 완료/해제 토글 | `update` |
| `completeForDate(dateKey, item)` | 날짜별 완료 처리 | `update` |
| `uncompleteForDate(dateKey, taskId)` | 날짜별 미완료 복원 | `update` |
| `addToScheduled(pid, tid, dateKey)` | 날짜에 예약 | `create` |
| `deleteScheduled(dateKey, idxOrTaskId)` | 예약 삭제 | `del` |
| `updateCompletedAt(tid, newTime)` | 완료 시각 수정 | - |
| `updateTaskTime(taskId, time)` | 업무 시간 변경 | `update` |

### 정기 업무 (`useRecurring.js`)

| 함수 | 설명 | GCal |
|------|------|------|
| `addRecurring(name, type, dayValue, ...)` | 정기 업무 추가 | `pushFutureDates` |
| `editRecurring(id, name, ...)` | 수정 (미래 인스턴스 재생성) | `delMultiple` + `pushFutureDates` |
| `deleteRecurring(id)` | 삭제 (미래 인스턴스 전부 삭제) | `delMultiple` |
| `toggleRecurring(id)` | 활성/비활성 토글 | - |
| `skipRecurringForDate(dateKey, recId)` | 특정 날짜 건너뛰기 | `del` |
| `addRecurringToDate(rec, dateKey)` | 특정 날짜에 수동 추가 | `create` |
| `getRecurringForDay(day, year, month)` | 날짜별 정기 업무 조회 | - |

### 이벤트 (`useTaskData.js`)

| 함수 | 설명 | GCal |
|------|------|------|
| `addEvent(name, desc, dateKey, time, endTime)` | 독립 이벤트 추가 | `create` |
| `editEvent(id, name, desc)` | 수정 | `update` |
| `updateEventTime(id, time, endTime)` | 시간 변경 | `update` |
| `deleteEvent(id)` | Soft Delete | `del` |
| `convertEventToSubtask(eventId, projectId)` | 이벤트 → 서브태스크 편입 | `del` + `create` |
| `addEventAsSubtask(pid, name, ...)` | 서브태스크로 추가 + 예약 | `create` |

### 퀵 태스크 (`useTaskData.js`)

| 함수 | 설명 | GCal |
|------|------|------|
| `addQuickTask(name, desc, time, endTime)` | 템플릿 추가 | - |
| `editQuickTask(id, name, ...)` | 수정 | - |
| `deleteQuickTask(id)` | 삭제 | - |
| `scheduleQuickTask(quickTaskId, dateKey)` | 날짜에 일정 생성 | `create` |

---

## 핵심 알고리즘

### 정기 업무 날짜 매칭 (`getRecurringItemsForDate`)

```
입력: data, dateKey("YYYY-MM-DD")
출력: 해당 날짜에 활성인 RecurringTask[]

1. dateKey를 파싱하여 요일(dow), 일(dom) 추출
2. data.recurring 순회:
   - active=false → skip
   - startDate > dateKey → skip
   - endDate < dateKey → skip
   - weekly: dow 일치 + interval 계산 (weeksBetween % interval === 0)
   - monthly: dom 일치 / nthWeekday 계산 / 말일(-1) 처리
3. recurringSkips[dateKey]에 있으면 제외
4. recurringAdds[dateKey]에 있으면 추가
```

### 오늘 할일 파생 (`deriveTodayTasks`)

```
입력: data (전체 앱 데이터)
출력: HydratedTask[] (이름/설명 포함된 오늘 업무 목록)

1. events에서 date=오늘 && !deleted 수집
2. scheduled[오늘]에서 수집 (done 서브태스크 제외)
3. getRecurringItemsForDate(data, 오늘) 수집
4. completedToday[오늘]에서 완료 상태 매핑
5. completedToday에만 있고 1-3에 없는 항목도 포함
6. 중복 제거 (seen Set)
7. hydrateTask()로 이름/설명 결합
```

### GCal 큐 최적화 (`_optimize`)

```
입력: 큐 배열 [{action, localId, payload, ts}]
출력: 최적화된 큐 배열

규칙:
  create + delete (같은 ID) → 둘 다 제거 (상쇄)
  create + update → create에 payload 병합
  update + update → 나중 payload로 병합
  update + delete → delete만 남김
```

### LWW 병합 (`mergeData`)

```
입력: local (현재 PC), remote (다른 PC)
출력: 병합된 데이터

엔티티 배열 (projects, events 등):
  Map<id, item> 구성 → updatedAt이 큰 쪽 우선

날짜 키 객체 (scheduled, completedToday):
  날짜별 → Map<taskId, item> 구성 → updatedAt이 큰 쪽 우선
```

---

## 테마 시스템

### 테마 구조 (`constants/theme.js`)

| 속성 | light | dark |
|------|-------|------|
| `primary` | #5b6cf7 | #7c8cf7 |
| `accent` | #7c5cf7 | #9c7cf7 |
| `bgGrad` | 하늘 그라데이션 | 다크 그라데이션 |
| `cardBg` | #fff | #1e1e2e |
| `text` | #1a1a1a | #e0e0e0 |
| `border` | #e5e7eb22 | #333344 |

### 프로젝트 컬러 팔레트

7색: blue, red, green, orange, purple, pink, brown
각각 `color`(메인), `light`(배경), `dark`(다크모드 배경) 변형

---

## 빌드 및 배포

```bash
npm run dev              # Vite 개발 서버 (브라우저)
npm run build            # Vite 프로덕션 빌드
npm run electron:dev     # Electron 개발 모드
npm run electron:build   # Electron 패키징 (.exe)
npm run electron:publish # GitHub Releases 배포 + 자동 업데이트
```

### 설정 (`package.json`)

- **버전**: 1.1.4
- **빌드 도구**: Vite 8 + electron-builder
- **출력**: `release/` (NSIS 설치 파일)
- **자동 업데이트**: GitHub Releases provider
- **아이콘**: `build/icon.ico`
