import { useState, useEffect } from "react";
import { isElectron } from "../../constants";

const RANGE_OPTIONS = [
  { value: 0, label: "당일만" },
  { value: 1, label: "±1일" },
  { value: 2, label: "±2일" },
  { value: 3, label: "±3일" },
  { value: 4, label: "±4일" },
  { value: 5, label: "±5일" },
  { value: 6, label: "±6일" },
  { value: 7, label: "±7일" },
  { value: 14, label: "±2주" },
  { value: 30, label: "±1달" },
];

const WINDOW_MODES = [
  { value: "normal", label: "일반", desc: "기본 동작 (다른 창과 동일)" },
  { value: "alwaysOnTop", label: "항상 위에", desc: "위젯 모드에서 다른 창 위에 항상 표시" },
  { value: "widget", label: "항상 아래", desc: "위젯 모드에서 다른 창 아래에 배치 (바탕화면 위젯)" },
];

export default function SettingsModal({ onClose, T, calendarRange, onRangeChange, windowMode, onWindowModeChange, onDataReload }) {
  const [tab, setTab] = useState("settings");
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [autoLaunchLoaded, setAutoLaunchLoaded] = useState(false);
  const [localRange, setLocalRange] = useState(calendarRange || 0);
  const [localWindowMode, setLocalWindowMode] = useState(windowMode || "normal");

  const [appVersion, setAppVersion] = useState("...");
  const [gcalStatus, setGcalStatus] = useState(null);
  const [gcalLoading, setGcalLoading] = useState(false);
  const [gcalError, setGcalError] = useState("");
  const [dataPath, setDataPath] = useState("");
  const [isCustomPath, setIsCustomPath] = useState(false);
  const [updateStatus, setUpdateStatus] = useState(null); // null | "checking" | "downloading" | "installing" | "latest"
  const [updatePercent, setUpdatePercent] = useState(0);
  const [updateVersion, setUpdateVersion] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");

  useEffect(() => {
    if (isElectron) {
      window.electronAPI.getAutoLaunch().then((v) => { setAutoLaunch(v); setAutoLaunchLoaded(true); });
      if (window.electronAPI.getAppVersion) {
        window.electronAPI.getAppVersion().then((v) => setAppVersion(v));
      }
      if (window.electronAPI.getDataPath) {
        window.electronAPI.getDataPath().then((r) => { setDataPath(r.path); setIsCustomPath(r.isCustom); });
      }
      if (window.electronAPI.onUpdateProgress) {
        window.electronAPI.onUpdateProgress((pct) => setUpdatePercent(Math.round(pct * 0.9))); // 다운로드 = 0~90%
      }
      if (window.electronAPI.onUpdateDownloaded) {
        window.electronAPI.onUpdateDownloaded(() => {
          setUpdatePercent(90);
          setUpdateStatus("installing");
          // 설치 준비 애니메이션 (90% → 100%)
          let p = 90;
          const timer = setInterval(() => {
            p += 2;
            if (p >= 100) { p = 100; clearInterval(timer); }
            setUpdatePercent(p);
          }, 200);
          // 2초 후 자동 설치 & 재시작
          setTimeout(() => {
            clearInterval(timer);
            setUpdatePercent(100);
            if (window.electronAPI.installUpdate) window.electronAPI.installUpdate();
          }, 2000);
        });
      }
    } else { setAutoLaunchLoaded(true); }
  }, []);

  useEffect(() => {
    if (isElectron && window.electronAPI.gcalGetStatus) {
      window.electronAPI.gcalGetStatus().then((s) => setGcalStatus(s)).catch(() => setGcalStatus({ connected: false }));
    } else { setGcalStatus({ connected: false }); }
  }, []);

  const handleGcalLogin = async () => {
    if (!isElectron || !window.electronAPI.gcalLogin) return;
    setGcalLoading(true); setGcalError("");
    try {
      const result = await window.electronAPI.gcalLogin();
      if (result.success) setGcalStatus({ connected: true, ...result.profile });
      else setGcalError(result.error || "로그인에 실패했습니다");
    } catch (e) { setGcalError("로그인 중 오류가 발생했습니다"); }
    setGcalLoading(false);
  };

  const handleGcalLogout = async () => {
    if (!isElectron || !window.electronAPI.gcalLogout) return;
    setGcalLoading(true); setGcalError("");
    try { await window.electronAPI.gcalLogout(); setGcalStatus({ connected: false }); }
    catch (e) { setGcalError("로그아웃 중 오류가 발생했습니다"); }
    setGcalLoading(false);
  };

  const handleApply = () => {
    if (isElectron) window.electronAPI.setAutoLaunch(autoLaunch);
    if (onRangeChange) onRangeChange(localRange);
    if (onWindowModeChange) onWindowModeChange(localWindowMode);
    onClose();
  };

  const tabs = [
    { key: "settings", label: "설정", icon: "⚙️" },
    { key: "calendar", label: "캘린더", icon: "📆" },
    { key: "google", label: "Google 캘린더", icon: "📅" },
    { key: "storage", label: "저장소", icon: "💾" },
    { key: "about", label: "정보", icon: "📄" },
  ];

  return (
    <div>
      <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>설정</h3>
      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: `2px solid ${T.border}`, paddingBottom: 0 }}>
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: "10px 16px", border: "none", borderBottom: tab === t.key ? `2px solid ${T.primary}` : "2px solid transparent", background: "transparent", cursor: "pointer", fontSize: 14, fontWeight: tab === t.key ? 700 : 500, color: tab === t.key ? T.primary : T.textSec, transition: "all .15s", marginBottom: -2, display: "flex", alignItems: "center", gap: 6 }}>
            <span>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {tab === "settings" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* 자동 시작 */}
          <div style={{ padding: "20px", background: T.surfaceBg, borderRadius: 12, border: `1px solid ${T.border}` }}>
            <label style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }} onClick={() => setAutoLaunch(!autoLaunch)}>
              <div style={{ width: 24, height: 24, borderRadius: 7, border: autoLaunch ? `2px solid ${T.primary}` : `2px solid ${T.border}`, background: autoLaunch ? T.primary : T.cardBg, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s", flexShrink: 0 }}>
                {autoLaunch && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>}
              </div>
              <div>
                <p style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Windows 시작 시 자동 실행</p>
                <p style={{ fontSize: 13, color: T.textMut, margin: "4px 0 0" }}>컴퓨터를 켜면 TaskNote가 자동으로 시작됩니다</p>
              </div>
            </label>
          </div>

          {/* 위젯 모드 창 설정 */}
          <div style={{ padding: "20px", background: T.surfaceBg, borderRadius: 12, border: `1px solid ${T.border}` }}>
            <p style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px" }}>위젯 모드 창 동작</p>
            <p style={{ fontSize: 13, color: T.textMut, margin: "0 0 16px" }}>위젯 모드(오늘 할 일, 캘린더)에서 창의 동작 방식을 설정합니다</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {WINDOW_MODES.map((m) => (
                <label key={m.value} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: localWindowMode === m.value ? T.primaryLight : T.cardBg, border: localWindowMode === m.value ? `2px solid ${T.primary}` : `1px solid ${T.border}`, borderRadius: 10, cursor: "pointer", transition: "all .15s" }} onClick={() => setLocalWindowMode(m.value)}>
                  <div style={{ width: 20, height: 20, borderRadius: "50%", border: localWindowMode === m.value ? `6px solid ${T.primary}` : `2px solid ${T.border}`, background: T.cardBg, flexShrink: 0, transition: "all .15s", boxSizing: "border-box" }} />
                  <div>
                    <p style={{ fontSize: 14, fontWeight: localWindowMode === m.value ? 700 : 500, margin: 0, color: localWindowMode === m.value ? T.primary : T.text }}>{m.label}</p>
                    <p style={{ fontSize: 12, color: T.textMut, margin: "2px 0 0" }}>{m.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {!isElectron && <p style={{ fontSize: 13, color: T.warnText, marginTop: 0, padding: "8px 12px", background: T.warnBg, borderRadius: 8 }}>이 기능은 데스크탑 앱에서만 사용할 수 있습니다</p>}
          {!autoLaunchLoaded && <p style={{ fontSize: 13, color: T.textMut, marginTop: 0 }}>설정 불러오는 중...</p>}
        </div>
      )}

      {tab === "calendar" && (
        <div>
          <div style={{ padding: "20px", background: T.surfaceBg, borderRadius: 12, border: `1px solid ${T.border}` }}>
            <p style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px" }}>일정 표시 범위</p>
            <p style={{ fontSize: 13, color: T.textMut, margin: "0 0 16px" }}>선택한 날짜 앞뒤로 몇 일까지의 일정을 함께 표시할지 설정합니다</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {RANGE_OPTIONS.map((opt) => (
                <button key={opt.value} onClick={() => setLocalRange(opt.value)}
                  style={{
                    padding: "8px 16px", border: localRange === opt.value ? `2px solid ${T.primary}` : `1px solid ${T.border}`,
                    background: localRange === opt.value ? T.primaryLight : T.cardBg,
                    borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: localRange === opt.value ? 700 : 500,
                    color: localRange === opt.value ? T.primary : T.textSec, transition: "all .15s",
                  }}>
                  {opt.label}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 16, padding: "12px 16px", background: T.cardBg, borderRadius: 10, border: `1px solid ${T.border}` }}>
              <p style={{ fontSize: 13, color: T.textMut, margin: 0, lineHeight: "20px" }}>
                • 지난 날의 업무는 미완료 항목만 표시됩니다<br />
                • 날짜별로 그룹화되어 표시됩니다
              </p>
            </div>
          </div>
        </div>
      )}

      {tab === "google" && (
        <div>
          <div style={{ padding: "24px", background: T.surfaceBg, borderRadius: 12, border: `1px solid ${T.border}` }}>
            {gcalStatus === null ? (
              <p style={{ fontSize: 14, color: T.textMut, textAlign: "center", padding: "20px 0" }}>연동 상태 확인 중...</p>
            ) : gcalStatus.connected ? (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
                  <div style={{ width: 48, height: 48, borderRadius: 12, background: "linear-gradient(135deg, #4285f4, #34a853)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 16, fontWeight: 700, margin: 0, color: T.text }}>Google 계정 연결됨</p>
                    <p style={{ fontSize: 14, color: T.textSec, margin: "4px 0 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{gcalStatus.email}</p>
                    {gcalStatus.name && <p style={{ fontSize: 13, color: T.textMut, margin: "2px 0 0" }}>{gcalStatus.name}</p>}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", background: T.cardBg, borderRadius: 10, border: `1px solid ${T.border}` }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#34a853", flexShrink: 0 }} />
                  <span style={{ fontSize: 13, color: T.textSec, flex: 1 }}>Google Calendar API 연결 활성</span>
                </div>
                <button onClick={handleGcalLogout} disabled={gcalLoading} style={{ width: "100%", marginTop: 16, padding: "12px", border: "1px solid #ef4444", background: "transparent", color: "#ef4444", borderRadius: 10, cursor: gcalLoading ? "not-allowed" : "pointer", fontSize: 14, fontWeight: 600, opacity: gcalLoading ? 0.5 : 1, transition: "all .15s" }}>
                  {gcalLoading ? "처리 중..." : "연결 해제"}
                </button>
              </div>
            ) : (
              <div>
                <div style={{ textAlign: "center", padding: "8px 0 20px" }}>
                  <div style={{ width: 64, height: 64, borderRadius: 16, background: "linear-gradient(135deg, #4285f4 0%, #4285f4 25%, #ea4335 25%, #ea4335 50%, #fbbc05 50%, #fbbc05 75%, #34a853 75%, #34a853 100%)", margin: "0 auto 16px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <div style={{ width: 40, height: 40, borderRadius: 8, background: T.cardBg, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={T.text} strokeWidth="2" strokeLinecap="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                    </div>
                  </div>
                  <p style={{ fontSize: 16, fontWeight: 700, margin: 0, color: T.text }}>Google 캘린더 연동</p>
                  <p style={{ fontSize: 14, color: T.textSec, margin: "8px 0 0", lineHeight: "20px" }}>Google 계정을 연결하면 TaskNote의 일정을<br />Google 캘린더와 동기화할 수 있습니다</p>
                </div>
                <button onClick={handleGcalLogin} disabled={gcalLoading} style={{ width: "100%", padding: "14px", border: "none", background: "#4285f4", color: "white", borderRadius: 10, cursor: gcalLoading ? "not-allowed" : "pointer", fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, opacity: gcalLoading ? 0.6 : 1, transition: "all .15s", boxShadow: "0 2px 8px #4285f433" }}>
                  <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#fff" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" /><path fill="#fff" opacity="0.8" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" /><path fill="#fff" opacity="0.6" d="M10.53 28.59A14.5 14.5 0 019.5 24c0-1.59.28-3.13.77-4.59l-7.98-6.19A23.94 23.94 0 000 24c0 3.77.9 7.34 2.49 10.5l8.04-5.91z" /><path fill="#fff" opacity="0.4" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-8.04 5.91C6.51 42.62 14.62 48 24 48z" /></svg>
                  {gcalLoading ? "연결 중..." : "Google 계정으로 연결"}
                </button>
              </div>
            )}
            {gcalError && <p style={{ fontSize: 13, color: "#ef4444", marginTop: 12, padding: "8px 12px", background: "#fef2f2", borderRadius: 8, textAlign: "center" }}>{gcalError}</p>}
          </div>
          <div style={{ marginTop: 16, padding: "16px", background: T.surfaceBg, borderRadius: 10, border: `1px solid ${T.border}` }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: T.textSec, margin: "0 0 8px" }}>연동 안내</p>
            <div style={{ fontSize: 13, color: T.textMut, lineHeight: "20px" }}>
              <p style={{ margin: "0 0 4px" }}>• Google 캘린더 읽기/쓰기 권한을 요청합니다</p>
              <p style={{ margin: "0 0 4px" }}>• 인증 정보는 이 PC에만 안전하게 저장됩니다</p>
              <p style={{ margin: "0 0 4px" }}>• 언제든 연결을 해제할 수 있습니다</p>
              <p style={{ margin: "0 0 4px" }}>• 공휴일을 표시하려면 <a href="https://calendar.google.com/calendar/r/settings" target="_blank" rel="noopener noreferrer" style={{ color: T.primary }}>Google Calendar 설정</a> → 관심 있는 캘린더 추가 → 지역별 휴일에서 <b style={{ color: T.textSec }}>대한민국의 휴일</b>을 활성화하세요</p>
              <p style={{ margin: 0 }}>• <a href="https://skedit-tasknote.online/privacy-policy.html" target="_blank" rel="noopener noreferrer" style={{ color: T.primary }}>개인정보처리방침</a>에서 자세한 내용을 확인하세요</p>
            </div>
          </div>
          {!isElectron && <p style={{ fontSize: 13, color: T.warnText, marginTop: 12, padding: "8px 12px", background: T.warnBg, borderRadius: 8 }}>이 기능은 데스크탑 앱에서만 사용할 수 있습니다</p>}
        </div>
      )}

      {tab === "storage" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ padding: "20px", background: T.surfaceBg, borderRadius: 12, border: `1px solid ${T.border}` }}>
            <p style={{ fontSize: 16, fontWeight: 600, margin: "0 0 4px" }}>데이터 저장 위치</p>
            <p style={{ fontSize: 13, color: T.textMut, margin: "0 0 16px" }}>클라우드 폴더(OneDrive, Google Drive 등)를 선택하면 여러 PC에서 데이터를 동기화할 수 있습니다</p>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: T.cardBg, borderRadius: 10, border: `1px solid ${T.border}`, marginBottom: 12 }}>
              <span style={{ fontSize: 13, color: T.textMut, flexShrink: 0 }}>📂</span>
              <span style={{ fontSize: 13, color: T.textSec, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dataPath || "로딩 중..."}</span>
              {isCustomPath && <span style={{ fontSize: 11, padding: "2px 8px", background: T.primaryLight, color: T.primary, borderRadius: 6, fontWeight: 600, flexShrink: 0 }}>커스텀</span>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={async () => {
                const folder = await window.electronAPI.selectDataFolder();
                if (!folder) return;
                const result = await window.electronAPI.setDataPath(folder);
                if (result?.success) {
                  setDataPath(result.path);
                  setIsCustomPath(true);
                  if (result.data && onDataReload) onDataReload(result.data);
                } else {
                  alert("경로 변경 실패: " + (result?.error || "알 수 없는 오류"));
                }
              }} style={{ flex: 1, padding: "10px", border: `1px solid ${T.primary}`, background: "transparent", color: T.primary, borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, transition: "all .15s" }}>
                폴더 변경
              </button>
              {isCustomPath && (
                <button onClick={async () => {
                  const result = await window.electronAPI.resetDataPath();
                  if (result?.success) {
                    setDataPath(result.path);
                    setIsCustomPath(false);
                    if (result.data && onDataReload) onDataReload(result.data);
                  }
                }} style={{ padding: "10px 16px", border: `1px solid ${T.border}`, background: "transparent", color: T.textSec, borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, transition: "all .15s" }}>
                  기본으로 복원
                </button>
              )}
            </div>
          </div>
          <div style={{ padding: "16px", background: T.surfaceBg, borderRadius: 10, border: `1px solid ${T.border}` }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: T.textSec, margin: "0 0 8px" }}>사용 방법</p>
            <div style={{ fontSize: 13, color: T.textMut, lineHeight: "20px" }}>
              <p style={{ margin: "0 0 4px" }}>1. 클라우드 동기화 앱(OneDrive, Google Drive 등)이 설치된 폴더를 선택하세요</p>
              <p style={{ margin: "0 0 4px" }}>2. 다른 PC에서도 같은 클라우드 폴더를 선택하면 데이터가 동기화됩니다</p>
              <p style={{ margin: "0 0 4px" }}>3. 변경 후 앱을 재시작해야 적용됩니다</p>
            </div>
          </div>
          <div style={{ padding: "10px 14px", background: T.cardBg, borderRadius: 8, border: `1px solid ${T.border}` }}>
            <p style={{ fontSize: 12, color: T.textMut, margin: 0, lineHeight: "18px" }}>
              ⚠️ 두 PC에서 동시에 앱을 열고 수정하면 데이터가 충돌할 수 있습니다. 한쪽에서 종료 후 사용하세요.
            </p>
          </div>
          {!isElectron && <p style={{ fontSize: 13, color: T.warnText, marginTop: 0, padding: "8px 12px", background: T.warnBg, borderRadius: 8 }}>이 기능은 데스크탑 앱에서만 사용할 수 있습니다</p>}
        </div>
      )}

      {tab === "about" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ padding: "24px", background: T.surfaceBg, borderRadius: 12, border: `1px solid ${T.border}`, textAlign: "center" }}>
            <p style={{ fontSize: 20, fontWeight: 800, margin: "0 0 4px", color: T.text }}>TaskNote</p>
            <p style={{ fontSize: 13, color: T.textMut, margin: 0 }}>버전 {appVersion}</p>
            <p style={{ fontSize: 13, color: T.textMut, margin: "4px 0 0" }}>개발자: Skedit99</p>
          </div>
          <div style={{ padding: "20px", background: T.surfaceBg, borderRadius: 12, border: `1px solid ${T.border}` }}>
            <p style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px", color: T.text }}>소프트웨어 업데이트</p>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <p style={{ fontSize: 13, color: T.textSec, margin: 0 }}>현재 버전: {appVersion}</p>
                <p style={{ fontSize: 12, color: T.textMut, margin: "2px 0 0" }}>최신 버전을 확인하고 업데이트를 설치합니다</p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {updateStatus === "latest" && <span style={{ fontSize: 12, color: "#22c55e", fontWeight: 600 }}>✓ 이미 최신 버전입니다</span>}
                <button onClick={async () => {
                  if (!isElectron) return;
                  setUpdateStatus("checking");
                  const result = await window.electronAPI.checkForUpdate();
                  if (result?.updateAvailable) {
                    setUpdateVersion(result.latestVersion || "");
                    setReleaseNotes(result.releaseNotes || "");
                    setUpdateStatus("downloading");
                    setUpdatePercent(0);
                    window.electronAPI.downloadUpdate();
                  } else {
                    setUpdateStatus("latest");
                    setTimeout(() => setUpdateStatus(null), 3000);
                  }
                }} disabled={updateStatus === "downloading" || updateStatus === "checking"} style={{ padding: "8px 16px", border: `1px solid ${T.primary}`, background: "transparent", color: T.primary, borderRadius: 8, cursor: updateStatus ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600, opacity: updateStatus === "downloading" ? 0.5 : 1 }}>
                  {updateStatus === "checking" ? "확인 중..." : updateStatus === "downloading" ? "다운로드 중..." : "업데이트 확인"}
                </button>
              </div>
            </div>
          </div>
          <div style={{ padding: "20px", background: T.surfaceBg, borderRadius: 12, border: `1px solid ${T.border}` }}>
            <p style={{ fontSize: 15, fontWeight: 600, margin: "0 0 12px", color: T.text }}>법적 고지</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <a href="https://skedit-tasknote.online/privacy-policy.html" target="_blank" rel="noopener noreferrer"
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", background: T.cardBg, borderRadius: 10, border: `1px solid ${T.border}`, textDecoration: "none", color: T.text, cursor: "pointer", transition: "all .15s" }}>
                <span style={{ fontSize: 18 }}>🔒</span>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>개인정보처리방침</p>
                  <p style={{ fontSize: 12, color: T.textMut, margin: "2px 0 0" }}>수집하는 정보와 처리 방법을 확인하세요</p>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.textMut} strokeWidth="2" strokeLinecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
              </a>
              <a href="https://skedit-tasknote.online/terms-of-service.html" target="_blank" rel="noopener noreferrer"
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", background: T.cardBg, borderRadius: 10, border: `1px solid ${T.border}`, textDecoration: "none", color: T.text, cursor: "pointer", transition: "all .15s" }}>
                <span style={{ fontSize: 18 }}>📋</span>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>서비스 이용약관</p>
                  <p style={{ fontSize: 12, color: T.textMut, margin: "2px 0 0" }}>이용 조건 및 면책 사항을 확인하세요</p>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.textMut} strokeWidth="2" strokeLinecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
              </a>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24 }}>
        <button style={{ padding: "10px 22px", border: `1px solid ${T.border}`, background: T.cardBg, borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 500, color: T.textSec }} onClick={onClose}>취소</button>
        <button style={{ padding: "10px 22px", border: "none", background: `linear-gradient(135deg,${T.primary},${T.accent})`, color: "white", borderRadius: 10, cursor: "pointer", fontSize: 15, fontWeight: 600, boxShadow: `0 2px 8px ${T.primary}44` }} onClick={handleApply}>적용</button>
      </div>

      {/* 업데이트 프로그레스 모달 */}
      {(updateStatus === "downloading" || updateStatus === "installing") && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000 }}>
          <div style={{ background: T.cardBg, borderRadius: 16, padding: "32px 36px", width: 400, textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.2)", animation: "modalIn .2s ease" }}>
            <p style={{ fontSize: 18, fontWeight: 700, color: T.text, margin: "0 0 4px" }}>
              {updateStatus === "downloading" ? "업데이트 다운로드 중" : "업데이트 설치 중"}
            </p>
            {updateVersion && <p style={{ fontSize: 12, color: T.primary, fontWeight: 600, margin: "0 0 4px" }}>v{updateVersion}</p>}
            <p style={{ fontSize: 13, color: T.textMut, margin: "0 0 16px" }}>
              {updateStatus === "downloading" ? "잠시만 기다려주세요..." : "설치 후 자동으로 재시작됩니다..."}
            </p>
            {releaseNotes && (
              <div style={{ textAlign: "left", padding: "10px 14px", background: T.surfaceBg, borderRadius: 10, border: `1px solid ${T.border}`, marginBottom: 16, maxHeight: 120, overflowY: "auto" }} className="hide-scrollbar">
                <p style={{ fontSize: 11, fontWeight: 700, color: T.textSec, margin: "0 0 6px" }}>변경사항</p>
                <p style={{ fontSize: 12, color: T.textSec, margin: 0, whiteSpace: "pre-wrap", lineHeight: "1.6" }}>{releaseNotes}</p>
              </div>
            )}
            <div style={{ width: "100%", height: 8, background: T.border, borderRadius: 4, overflow: "hidden", marginBottom: 10 }}>
              <div style={{ width: `${updatePercent}%`, height: "100%", background: `linear-gradient(90deg, ${T.primary}, ${T.accent})`, borderRadius: 4, transition: "width 0.3s ease" }} />
            </div>
            <p style={{ fontSize: 24, fontWeight: 800, color: T.primary, margin: 0 }}>{updatePercent}%</p>
          </div>
        </div>
      )}
    </div>
  );
}
