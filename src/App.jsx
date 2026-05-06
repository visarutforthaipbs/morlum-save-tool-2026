import { useState, useEffect } from "react";

const ROLE_META = {
  headliner:     { label: "หมอลำ",  color: "#92400E", bg: "#FEF3C7" },
  dancer_troupe: { label: "แดนซ์",  color: "#9D174D", bg: "#FCE7F3" },
  band:          { label: "วง",     color: "#1E3A8A", bg: "#DBEAFE" },
  sound:         { label: "ซาวด์",  color: "#14532D", bg: "#DCFCE7" },
  float:         { label: "รถแห่",  color: "#4C1D95", bg: "#EDE9FE" },
  unknown:       { label: "?",      color: "#374151", bg: "#F3F4F6" },
};

async function supabaseInsert(url, key, table, rows) {
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Prefer": "return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || res.statusText);
  }
  return res.json();
}

export default function MorLumSaveTool() {
  const [step, setStep] = useState("credentials"); // credentials | paste | preview | done
  const [sbUrl, setSbUrl] = useState("");
  const [sbKey, setSbKey] = useState("");
  const [rawText, setRawText] = useState("");
  const [postDate, setPostDate] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [performances, setPerformances] = useState([]);
  const [parseError, setParseError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [saveError, setSaveError] = useState(null);

  // Load saved credentials
  useEffect(() => {
    try {
      const u = localStorage.getItem("sb_url");
      const k = localStorage.getItem("sb_key");
      if (u) setSbUrl(u);
      if (k) setSbKey(k);
      if (u && k) setStep("paste");
    } catch {}
  }, []);

  function saveCredentials() {
    if (!sbUrl.trim() || !sbKey.trim()) return;
    try {
      localStorage.setItem("sb_url", sbUrl.trim());
      localStorage.setItem("sb_key", sbKey.trim());
      setStep("paste");
    } catch (e) {
      alert("Could not save credentials: " + e.message);
    }
  }

  function parseJSON() {
    setParseError(null);
    try {
      const cleaned = jsonText.trim()
        .replace(/^```json\s*/i, "")
        .replace(/^```/i, "")
        .replace(/```$/i, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
      setPerformances(parsed);
      setStep("preview");
    } catch (e) {
      setParseError("JSON ไม่ถูกต้อง: " + e.message);
    }
  }

  function removePerf(idx) {
    setPerformances(p => p.filter((_, i) => i !== idx));
  }

  async function saveAll() {
    setSaving(true);
    setSaveError(null);
    try {
      // 1. Save raw post
      const rawRows = await supabaseInsert(sbUrl, sbKey, "raw_posts", [{
        post_date: postDate || performances[0]?.performance_date || null,
        raw_text: rawText || jsonText,
        parsed: true,
        parse_status: "success",
      }]);
      const rawPostId = rawRows[0]?.id;

      let savedN = 0;
      for (const perf of performances) {
        const { artists, ...perfData } = perf;

        // 2. Save performance
        const perfRows = await supabaseInsert(sbUrl, sbKey, "performances", [{
          raw_post_id: rawPostId,
          performance_date: perfData.performance_date,
          province: perfData.province,
          district: perfData.district,
          subdistrict: perfData.subdistrict,
          village: perfData.village,
          venue: perfData.venue,
          event_type: perfData.event_type,
          period: perfData.period,
          time_start: perfData.time_start,
          time_end: perfData.time_end,
          raw_line: perfData.raw_line,
          confidence: perfData.confidence,
          flagged: perfData.flagged ?? (perfData.confidence < 0.7),
          flag_reason: perfData.flag_reason,
          validated: false,
        }]);
        const perfId = perfRows[0]?.id;

        // 3. Save artists
        if (artists?.length && perfId) {
          await supabaseInsert(sbUrl, sbKey, "performance_artists",
            artists.map(a => ({
              performance_id: perfId,
              raw_name: a.raw_name,
              role_type: a.role_type,
              resolved: false,
            }))
          );
        }
        savedN++;
      }

      setSavedCount(savedN);
      setStep("done");
    } catch (e) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setJsonText("");
    setRawText("");
    setPostDate("");
    setPerformances([]);
    setParseError(null);
    setSaveError(null);
    setSavedCount(0);
    setStep("paste");
  }

  const flagged = performances.filter(p => p.flagged || p.confidence < 0.7).length;

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <span style={s.logo}>🎭</span>
          <span style={s.title}>MorLum Save Tool</span>
        </div>
        <div style={s.steps}>
          {["credentials","paste","preview","done"].map((st, i) => (
            <div key={st} style={{
              ...s.stepDot,
              background: step === st ? "#D97706"
                : ["credentials","paste","preview","done"].indexOf(step) > i ? "#059669" : "#374151"
            }} />
          ))}
        </div>
      </div>

      <div style={s.body}>

        {/* ── STEP: CREDENTIALS ── */}
        {step === "credentials" && (
          <div style={s.card}>
            <h2 style={s.cardTitle}>🔑 ตั้งค่า Supabase</h2>
            <p style={s.hint}>ทำครั้งเดียว — ระบบจำไว้ให้</p>
            <label style={s.label}>Project URL</label>
            <input style={s.input} value={sbUrl}
              onChange={e => setSbUrl(e.target.value)}
              placeholder="https://xxxx.supabase.co" />
            <label style={s.label}>Anon Public Key</label>
            <input style={s.input} value={sbKey}
              onChange={e => setSbKey(e.target.value)}
              placeholder="eyJhbGciOiJIUzI1NiIs..." type="password" />
            <button style={s.primaryBtn}
              onClick={saveCredentials}
              disabled={!sbUrl || !sbKey}>
              บันทึกและเริ่มใช้งาน →
            </button>
          </div>
        )}

        {/* ── STEP: PASTE ── */}
        {step === "paste" && (
          <div style={s.card}>
            <div style={s.cardRow}>
              <h2 style={s.cardTitle}>📋 วาง JSON จาก Claude</h2>
              <button style={s.ghostBtn}
                onClick={() => { setStep("credentials"); }}>
                ⚙️ ตั้งค่า
              </button>
            </div>
            <p style={s.hint}>
              1. เปิด Project <strong>MorLum Parser</strong> ใน Claude.ai<br/>
              2. วางโพสต์ Facebook แล้วส่ง<br/>
              3. Copy JSON ที่ได้ → วางลงด้านล่าง
            </p>

            <label style={s.label}>วันที่ (optional — ถ้า Claude ใส่มาแล้วไม่ต้องกรอก)</label>
            <input style={s.input} value={postDate}
              onChange={e => setPostDate(e.target.value)}
              placeholder="2026-05-06" />

            <label style={s.label}>ข้อความโพสต์ต้นฉบับ (optional — เก็บไว้เป็น archive)</label>
            <textarea style={{...s.input, height: 60, resize: "vertical"}}
              value={rawText}
              onChange={e => setRawText(e.target.value)}
              placeholder="วางข้อความดิบจาก Facebook (ถ้ามี)" />

            <label style={s.label}>JSON จาก Claude *</label>
            <textarea style={{...s.input, height: 200, fontFamily: "monospace", fontSize: 12, resize: "vertical"}}
              value={jsonText}
              onChange={e => setJsonText(e.target.value)}
              placeholder='[{"performance_date": "2026-05-06", ...}]' />

            {parseError && <div style={s.errorBox}>{parseError}</div>}

            <button style={s.primaryBtn}
              onClick={parseJSON}
              disabled={!jsonText.trim()}>
              ตรวจสอบ JSON →
            </button>
          </div>
        )}

        {/* ── STEP: PREVIEW ── */}
        {step === "preview" && (
          <div>
            {/* Summary */}
            <div style={s.summaryBar}>
              <div style={s.summaryItem}>
                <span style={s.summaryNum}>{performances.length}</span>
                <span style={s.summaryLbl}>รายการ</span>
              </div>
              <div style={s.summaryItem}>
                <span style={{...s.summaryNum, color: "#F87171"}}>{flagged}</span>
                <span style={s.summaryLbl}>ต้องตรวจสอบ</span>
              </div>
              <div style={s.summaryItem}>
                <span style={{...s.summaryNum, color: "#34D399"}}>{performances.length - flagged}</span>
                <span style={s.summaryLbl}>ดี</span>
              </div>
              <div style={{marginLeft: "auto", display: "flex", gap: 8}}>
                <button style={s.ghostBtn} onClick={() => setStep("paste")}>← แก้ไข</button>
                <button style={{...s.primaryBtn, margin: 0}}
                  onClick={saveAll} disabled={saving || performances.length === 0}>
                  {saving ? "⏳ กำลังบันทึก..." : `💾 บันทึก ${performances.length} รายการ → Supabase`}
                </button>
              </div>
            </div>

            {saveError && <div style={{...s.errorBox, marginBottom: 12}}>{saveError}</div>}

            {/* Cards */}
            <div style={s.grid}>
              {performances.map((p, idx) => (
                <div key={idx} style={{
                  ...s.perfCard,
                  borderLeft: `3px solid ${p.flagged || p.confidence < 0.7 ? "#EF4444" : "#10B981"}`
                }}>
                  <div style={s.perfHeader}>
                    <div style={{display:"flex", gap:6, flexWrap:"wrap", alignItems:"center"}}>
                      <span style={s.dateChip}>{p.performance_date}</span>
                      {p.period && <span style={s.periodChip}>{p.period}</span>}
                      {(p.flagged || p.confidence < 0.7) && (
                        <span style={s.flagChip}>⚠️ {p.flag_reason || "ตรวจสอบ"}</span>
                      )}
                    </div>
                    <div style={{display:"flex", gap:6, alignItems:"center"}}>
                      <span style={{
                        ...s.confChip,
                        background: p.confidence >= 0.9 ? "#DCFCE7" : p.confidence >= 0.7 ? "#FEF9C3" : "#FEE2E2",
                        color: p.confidence >= 0.9 ? "#166534" : p.confidence >= 0.7 ? "#854D0E" : "#991B1B",
                      }}>{Math.round((p.confidence||0)*100)}%</span>
                      <button style={s.removeBtn} onClick={() => removePerf(idx)}>✕</button>
                    </div>
                  </div>

                  <div style={s.location}>
                    📍 {[p.village, p.venue, p.subdistrict, p.district, p.province].filter(Boolean).join(" › ")}
                  </div>

                  {p.event_type && <div style={s.eventType}>🎊 {p.event_type}</div>}
                  {(p.time_start||p.time_end) && (
                    <div style={s.eventType}>🕐 {p.time_start}{p.time_end ? ` – ${p.time_end}` : ""}</div>
                  )}

                  <div style={{display:"flex", flexDirection:"column", gap:4, marginTop:4}}>
                    {p.artists?.map((a, ai) => {
                      const m = ROLE_META[a.role_type] || ROLE_META.unknown;
                      return (
                        <div key={ai} style={{display:"flex", gap:6, alignItems:"center"}}>
                          <span style={{...s.roleBadge, background:m.bg, color:m.color}}>{m.label}</span>
                          <span style={s.artistName}>{a.raw_name}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── STEP: DONE ── */}
        {step === "done" && (
          <div style={{...s.card, textAlign:"center"}}>
            <div style={{fontSize:56, marginBottom:16}}>✅</div>
            <h2 style={{...s.cardTitle, color:"#34D399"}}>
              บันทึกแล้ว {savedCount} รายการ
            </h2>
            <p style={s.hint}>ข้อมูลอยู่ใน Supabase แล้ว พร้อมสำหรับวันพรุ่งนี้</p>
            <button style={s.primaryBtn} onClick={reset}>
              + วันใหม่
            </button>
          </div>
        )}

      </div>
    </div>
  );
}

const s = {
  root: {
    minHeight: "100vh",
    background: "#111827",
    color: "#F9FAFB",
    fontFamily: "'Sarabun', 'Noto Sans Thai', sans-serif",
    fontSize: 14,
  },
  header: {
    background: "#1F2937",
    borderBottom: "1px solid #374151",
    padding: "12px 20px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  logo: { fontSize: 20, marginRight: 8 },
  title: { fontSize: 16, fontWeight: 700, color: "#D97706", letterSpacing: 1 },
  steps: { display: "flex", gap: 6, alignItems: "center" },
  stepDot: { width: 10, height: 10, borderRadius: "50%", transition: "background 0.3s" },
  body: { maxWidth: 900, margin: "0 auto", padding: "24px 16px 48px" },
  card: {
    background: "#1F2937",
    border: "1px solid #374151",
    borderRadius: 12,
    padding: 24,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  cardRow: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { margin: 0, fontSize: 17, fontWeight: 700, color: "#F3F4F6" },
  hint: { margin: 0, color: "#9CA3AF", lineHeight: 1.7 },
  label: { fontSize: 12, color: "#9CA3AF", textTransform: "uppercase", letterSpacing: 1 },
  input: {
    background: "#111827",
    border: "1px solid #374151",
    borderRadius: 8,
    padding: "10px 12px",
    color: "#F9FAFB",
    fontSize: 14,
    fontFamily: "inherit",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  },
  primaryBtn: {
    background: "#D97706",
    border: "none",
    borderRadius: 8,
    padding: "10px 24px",
    color: "#111827",
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
    fontFamily: "inherit",
    marginTop: 4,
    alignSelf: "flex-start",
  },
  ghostBtn: {
    background: "transparent",
    border: "1px solid #374151",
    borderRadius: 8,
    padding: "7px 14px",
    color: "#9CA3AF",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: "inherit",
  },
  errorBox: {
    background: "#1F0A0A",
    border: "1px solid #7F1D1D",
    borderRadius: 8,
    padding: "10px 14px",
    color: "#FCA5A5",
  },
  summaryBar: {
    background: "#1F2937",
    border: "1px solid #374151",
    borderRadius: 10,
    padding: "14px 20px",
    display: "flex",
    alignItems: "center",
    gap: 28,
    marginBottom: 16,
  },
  summaryItem: { display: "flex", flexDirection: "column", alignItems: "center" },
  summaryNum: { fontSize: 24, fontWeight: 700, color: "#D97706" },
  summaryLbl: { fontSize: 10, color: "#6B7280", textTransform: "uppercase", letterSpacing: 1 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 },
  perfCard: {
    background: "#1F2937",
    border: "1px solid #374151",
    borderRadius: 10,
    padding: 14,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  perfHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  dateChip: { fontSize: 12, fontWeight: 600, color: "#D97706" },
  periodChip: {
    fontSize: 11, background: "#374151", color: "#D1D5DB",
    padding: "2px 8px", borderRadius: 10,
  },
  flagChip: {
    fontSize: 11, background: "#450A0A", color: "#FCA5A5",
    padding: "2px 8px", borderRadius: 10, border: "1px solid #7F1D1D",
  },
  confChip: { fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10 },
  removeBtn: {
    background: "transparent", border: "none",
    color: "#4B5563", cursor: "pointer", fontSize: 14, padding: "2px 6px",
  },
  location: { fontSize: 13, color: "#D1D5DB", lineHeight: 1.5 },
  eventType: { fontSize: 12, color: "#9CA3AF", fontStyle: "italic" },
  roleBadge: {
    fontSize: 10, fontWeight: 700, padding: "2px 7px",
    borderRadius: 8, minWidth: 34, textAlign: "center",
  },
  artistName: { fontSize: 13, color: "#E5E7EB" },
};
