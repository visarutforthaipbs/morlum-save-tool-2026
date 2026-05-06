"use client";
// MorLum Pipeline Tool — Parser → Validator → Entity Resolver → Save
// Steps: credentials → paste → validate → resolve → save → done

import { useState, useEffect, useCallback } from "react";

// ─── Supabase REST helpers ────────────────────────────────────────────────────
async function sbGet(url, key, table, params = "") {
  const res = await fetch(`${url}/rest/v1/${table}?${params}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || res.statusText);
  return res.json();
}
async function sbPost(url, key, table, rows) {
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || res.statusText);
  return res.json();
}

// ─── Fuzzy match helpers ──────────────────────────────────────────────────────
function similarity(a, b) {
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  if (a === b) return 1.0;
  if (a.includes(b) || b.includes(a)) return 0.85;
  // Trigram similarity
  const trigrams = (s) => {
    const t = new Set();
    for (let i = 0; i < s.length - 2; i++) t.add(s.slice(i, i + 3));
    return t;
  };
  const ta = trigrams(a), tb = trigrams(b);
  const intersect = [...ta].filter((x) => tb.has(x)).length;
  return (2 * intersect) / (ta.size + tb.size);
}

function findBestMatch(rawName, entities) {
  let best = null, bestScore = 0;
  for (const e of entities) {
    const names = [e.canonical_name, ...(e.aliases || [])];
    for (const n of names) {
      const score = similarity(rawName, n);
      if (score > bestScore) { bestScore = score; best = e; }
    }
  }
  if (bestScore >= 0.95) return { entity: best, score: bestScore, status: "exact" };
  if (bestScore >= 0.70) return { entity: best, score: bestScore, status: "suggested" };
  return { entity: null, score: bestScore, status: "new" };
}

// ─── Role → colour map ────────────────────────────────────────────────────────
const ROLE = {
  headliner: { label: "หมอลำ", bg: "#FEF3C7", color: "#92400E" },
  dancer_troupe: { label: "แดนซ์", bg: "#FCE7F3", color: "#9D174D" },
  band: { label: "วง", bg: "#DBEAFE", color: "#1E3A8A" },
  sound: { label: "ซาวด์", bg: "#DCFCE7", color: "#14532D" },
  float: { label: "รถแห่", bg: "#EDE9FE", color: "#4C1D95" },
  unknown: { label: "?", bg: "#F3F4F6", color: "#374151" },
};

const STATUS_COLOR = { exact: "#34D399", suggested: "#FBBF24", new: "#F87171" };
const STATUS_LABEL = { exact: "✅ ตรงเป๊ะ", suggested: "⚠️ ใกล้เคียง", new: "🆕 ใหม่" };

// ─── Step indicator ───────────────────────────────────────────────────────────
const STEPS = ["paste", "validate", "resolve", "done"];

// ─── Main component ───────────────────────────────────────────────────────────
export default function MorLumPipeline() {
  const [step, setStep] = useState("paste");
  const sbUrl = import.meta.env.VITE_SUPABASE_URL || "";
  const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
  const [rawText, setRawText] = useState("");
  const [postDate, setPostDate] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [performances, setPerfs] = useState([]);
  const [parseErr, setParseErr] = useState(null);
  const [parseStats, setParseStats] = useState(null);

  // Validator state
  const [validating, setValidating] = useState(false);
  const [validationResults, setValResults] = useState(null); // { provinces, duplicates }

  // Entity resolver state
  const [entities, setEntities] = useState([]);     // canonical entities from DB
  const [resolution, setResolution] = useState({});     // { raw_name → { entity_id, status, canonical_name } }
  const [resolving, setResolving] = useState(false);
  const [newEntityForms, setNewForms] = useState({});     // raw_name → { canonical_name, role_type }

  // Save state
  const [saving, setSaving] = useState(false);
  const [savedCount, setSaved] = useState(0);
  const [saveErr, setSaveErr] = useState(null);



  // ── Step 2 : Parse JSON ───────────────────────────────────────────────────
  function parseJSON() {
    setParseErr(null);
    try {
      const clean = jsonText.trim()
        .replace(/^```json\s*/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
      let arr = JSON.parse(clean);
      let stats = null;

      if (!Array.isArray(arr) && arr.performances) {
        stats = {
          count: arr.count,
          expected_count: arr.expected_count,
          completeness_ratio: arr.completeness_ratio,
          completeness_warning: arr.completeness_warning,
        };
        arr = arr.performances;
      }

      if (!Array.isArray(arr)) throw new Error("Expected JSON array");
      setPerfs(arr);
      setParseStats(stats);
      setStep("validate");
    } catch (e) { setParseErr("JSON ไม่ถูกต้อง: " + e.message); }
  }

  // ── Step 3 : Validate ─────────────────────────────────────────────────────
  async function runValidation() {
    setValidating(true);
    try {
      // 1. Load province master list
      const provinces = await sbGet(sbUrl, sbKey, "provinces", "select=name_th");
      const validProvinces = new Set(provinces.map((p) => p.name_th));

      // 2. Check each performance
      const results = await Promise.all(
        performances.map(async (perf) => {
          const issues = [];

          // Province check
          if (perf.province && !validProvinces.has(perf.province)) {
            issues.push({ type: "province", msg: `"${perf.province}" ไม่อยู่ใน master list` });
          }

          // Duplicate check
          if (perf.performance_date && perf.province) {
            const dupes = await sbGet(
              sbUrl, sbKey, "performances",
              `performance_date=eq.${perf.performance_date}&province=eq.${encodeURIComponent(perf.province)}&select=id,village,raw_line&limit=3`
            );
            if (dupes.length > 0) {
              // Check if same village/raw_line already exists
              const exactDupe = dupes.find(
                (d) => d.village === perf.village || d.raw_line === perf.raw_line
              );
              if (exactDupe) issues.push({ type: "duplicate", msg: "อาจซ้ำกับข้อมูลที่มีอยู่แล้ว" });
            }
          }

          return { perf, issues, ok: issues.length === 0 };
        })
      );

      setValResults(results);
    } catch (e) {
      setValResults({ error: e.message });
    } finally {
      setValidating(false);
    }
  }

  function removeInvalidPerf(idx) {
    setPerfs((prev) => prev.filter((_, i) => i !== idx));
    if (Array.isArray(validationResults)) {
      setValResults(validationResults.filter((_, i) => i !== idx));
    }
  }

  function updatePerfField(idx, field, value) {
    setPerfs((prev) => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
    // Also update the validation result's copy so the UI stays in sync
    if (Array.isArray(validationResults)) {
      setValResults((prev) =>
        prev.map((r, i) => i === idx ? { ...r, perf: { ...r.perf, [field]: value } } : r)
      );
    }
  }

  function proceedToResolve() {
    // Remove performances flagged as duplicates (optional — user can keep)
    setStep("resolve");
    loadEntitiesAndResolve();
  }

  // ── Step 4 : Entity resolution ────────────────────────────────────────────
  async function loadEntitiesAndResolve() {
    setResolving(true);
    try {
      const ents = await sbGet(sbUrl, sbKey, "entities", "select=id,canonical_name,role_type,aliases&limit=2000");
      setEntities(ents);

      // Collect all unique artist raw_names across all performances
      const allArtists = {};
      for (const perf of performances) {
        for (const a of perf.artists || []) {
          if (!allArtists[a.raw_name]) allArtists[a.raw_name] = a.role_type;
        }
      }

      // Resolve each
      const res = {};
      for (const [rawName, roleType] of Object.entries(allArtists)) {
        const match = findBestMatch(rawName, ents);
        res[rawName] = {
          status: match.status,
          entity_id: match.entity?.id || null,
          canonical_name: match.entity?.canonical_name || rawName,
          role_type: roleType,
          score: match.score,
        };
      }
      setResolution(res);
    } catch (e) {
      console.error("Entity load error", e);
    } finally {
      setResolving(false);
    }
  }

  function confirmSuggestion(rawName) {
    setResolution((prev) => ({
      ...prev,
      [rawName]: { ...prev[rawName], status: "exact" },
    }));
  }

  function rejectSuggestion(rawName) {
    setResolution((prev) => ({
      ...prev,
      [rawName]: { ...prev[rawName], status: "new", entity_id: null },
    }));
  }

  function updateNewForm(rawName, field, value) {
    setNewForms((prev) => ({
      ...prev,
      [rawName]: { ...(prev[rawName] || {}), [field]: value },
    }));
  }

  // ── Step 5 : Save ─────────────────────────────────────────────────────────
  async function saveAll() {
    setSaving(true);
    setSaveErr(null);
    try {
      // 1. Create new entities first
      for (const [rawName, res] of Object.entries(resolution)) {
        if (res.status === "new") {
          const form = newEntityForms[rawName] || {};
          const newEnt = await sbPost(sbUrl, sbKey, "entities", [{
            canonical_name: form.canonical_name || rawName,
            role_type: form.role_type || res.role_type || "unknown",
            aliases: [rawName],
          }]);
          if (newEnt[0]) {
            setResolution((prev) => ({
              ...prev,
              [rawName]: { ...prev[rawName], entity_id: newEnt[0].id, status: "exact" },
            }));
            resolution[rawName].entity_id = newEnt[0].id;
          }
        }
      }

      // 2. Save raw post
      const rawRows = await sbPost(sbUrl, sbKey, "raw_posts", [{
        post_date: postDate || performances[0]?.performance_date || null,
        raw_text: rawText || jsonText,
        parsed: true,
        parse_status: "success",
      }]);
      const rawPostId = rawRows[0]?.id;

      // 3. Save each performance + artists
      let n = 0;
      for (const perf of performances) {
        const { artists, ...pd } = perf;
        const perfRows = await sbPost(sbUrl, sbKey, "performances", [{
          raw_post_id: rawPostId,
          performance_date: pd.performance_date,
          province: pd.province,
          district: pd.district,
          subdistrict: pd.subdistrict,
          village: pd.village,
          venue: pd.venue,
          event_type: pd.event_type,
          period: pd.period,
          time_start: pd.time_start,
          time_end: pd.time_end,
          raw_line: pd.raw_line,
          confidence: pd.confidence,
          flagged: pd.flagged ?? (pd.confidence < 0.7),
          flag_reason: pd.flag_reason,
          validated: false,
        }]);
        const perfId = perfRows[0]?.id;

        if (artists?.length && perfId) {
          await sbPost(sbUrl, sbKey, "performance_artists",
            artists.map((a) => ({
              performance_id: perfId,
              raw_name: a.raw_name,
              role_type: a.role_type,
              entity_id: resolution[a.raw_name]?.entity_id || null,
              resolved: !!resolution[a.raw_name]?.entity_id,
              resolution_method: resolution[a.raw_name]?.status === "exact" ? "auto" : "manual",
            }))
          );
        }
        n++;
      }

      setSaved(n);
      setStep("done");
    } catch (e) {
      setSaveErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setJsonText(""); setRawText(""); setPostDate(""); setPerfs([]);
    setParseErr(null); setValResults(null); setResolution({}); setNewForms({});
    setParseStats(null);
    setSaveErr(null); setSaved(0); setStep("paste");
  }

  // ─── Derived counts ────────────────────────────────────────────────────────
  const resEntries = Object.entries(resolution);
  const exactCount = resEntries.filter(([, v]) => v.status === "exact").length;
  const suggestedCount = resEntries.filter(([, v]) => v.status === "suggested").length;
  const newCount = resEntries.filter(([, v]) => v.status === "new").length;
  const stepIdx = STEPS.indexOf(step);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={s.root}>
      {/* Header */}
      <div style={s.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 20 }}>🎭</span>
          <div>
            <div style={s.title}>MorLum Pipeline</div>
            <div style={s.subtitle}>Parser → Validator → Entity Resolver → Save</div>
          </div>
        </div>
        {/* Step progress */}
        <div style={{ display: "flex", gap: 0, alignItems: "center" }}>
          {["Paste", "Validate", "Resolve", "Save"].map((label, i) => {
            const active = stepIdx === i;
            const done = stepIdx > i || stepIdx === 3;
            return (
              <div key={label} style={{ display: "flex", alignItems: "center" }}>
                <div style={{
                  ...s.stepPill,
                  background: done ? "#059669" : active ? "#D97706" : "#374151",
                  color: done || active ? "#fff" : "#9CA3AF",
                }}>
                  {done ? "✓ " : ""}{label}
                </div>
                {i < 3 && <div style={s.stepArrow}>→</div>}
              </div>
            );
          })}
        </div>
      </div>

      <div style={s.body}>



        {/* ── PASTE ────────────────────────────────────────────────────────── */}
        {step === "paste" && (
          <Card title="📋 Step 1 — วาง JSON จาก Claude" hint={
            <>1. เปิด Project <b>MorLum Parser</b> → วางโพสต์ → Copy JSON<br />2. วาง JSON ลงด้านล่าง</>
          }>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 2 }}>
                  <Label>วันที่โพสต์ (optional)</Label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button style={s.ghostBtn} onClick={() => setPostDate(new Date().toISOString().split('T')[0])}>วันนี้</button>
                    <button style={s.ghostBtn} onClick={() => {
                      const d = new Date(); d.setDate(d.getDate() - 1);
                      setPostDate(d.toISOString().split('T')[0]);
                    }}>เมื่อวาน</button>
                  </div>
                </div>
                <Input type="date" value={postDate} onChange={setPostDate} />
              </div>
            </div>
            <Label>ข้อความโพสต์ต้นฉบับ (optional)</Label>
            <Textarea value={rawText} onChange={setRawText} rows={3} placeholder="วางข้อความดิบ (สำหรับ archive)" />
            <Label>JSON จาก Claude *</Label>
            <Textarea value={jsonText} onChange={setJsonText} rows={10} mono
              placeholder='[{"performance_date":"2026-05-06","province":"ร้อยเอ็ด",...}]' />
            {parseErr && <Err>{parseErr}</Err>}
            <Btn onClick={parseJSON} disabled={!jsonText.trim()}>ตรวจสอบ JSON →</Btn>
          </Card>
        )}

        {/* ── VALIDATE ─────────────────────────────────────────────────────── */}
        {step === "validate" && (
          <div>
            <Card title="🔍 Step 2 — Validator">
              <p style={s.hint}>ตรวจสอบชื่อจังหวัด และหาข้อมูลซ้ำ — แก้ไขได้เลยถ้าสะกดผิด</p>
              
              {parseStats?.completeness_warning && (
                <div style={s.warningBox}>
                  ⚠️ Parser อาจได้ไม่ครบ — คาดว่ามี ~{parseStats.expected_count} รายการ
                  แต่ได้มา {parseStats.count} รายการ ({Math.round(parseStats.completeness_ratio * 100)}%)
                  แนะนำให้ parse ใหม่อีกครั้ง
                </div>
              )}

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
                <button style={s.ghostBtn} onClick={() => { setStep("paste"); setValResults(null); }}>← กลับแก้ JSON</button>
                <Btn onClick={runValidation} disabled={validating}>
                  {validating ? "⏳ กำลังตรวจสอบ..." : validationResults ? "🔄 ตรวจสอบอีกครั้ง" : "🔍 เริ่มตรวจสอบ"}
                </Btn>
                {validationResults && !validationResults.error && (
                  <Btn onClick={proceedToResolve} secondary>ถัดไป: Entity Resolver →</Btn>
                )}
              </div>
            </Card>

            {validationResults?.error && <Err>{validationResults.error}</Err>}

            {Array.isArray(validationResults) && (
              <div style={{ marginTop: 16 }}>
                {/* Summary */}
                <div style={s.summaryBar}>
                  <Stat n={performances.length} label="รายการ" />
                  <Stat n={validationResults.filter(r => r.ok).length} label="ผ่าน" color="#34D399" />
                  <Stat n={validationResults.filter(r => !r.ok).length} label="มีปัญหา" color="#F87171" />
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <Btn onClick={runValidation} disabled={validating} secondary>
                      🔄 ตรวจใหม่
                    </Btn>
                    <Btn onClick={proceedToResolve} disabled={validating}>
                      ถัดไป: Entity Resolver →
                    </Btn>
                  </div>
                </div>

                {/* Cards */}
                <div style={s.grid}>
                  {validationResults.map((r, idx) => (
                    <div key={idx} style={{
                      ...s.card2,
                      borderLeft: `3px solid ${r.ok ? "#34D399" : "#F87171"}`,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#D97706" }}>
                          {r.perf.performance_date}
                        </span>
                        <button style={s.removeBtn} onClick={() => removeInvalidPerf(idx)}>✕ ลบ</button>
                      </div>

                      {/* Editable location fields */}
                      {!r.ok ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span style={s.fieldLabel}>จังหวัด</span>
                            <input style={s.inlineInput}
                              value={r.perf.province || ""}
                              onChange={e => updatePerfField(idx, "province", e.target.value)} />
                          </div>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span style={s.fieldLabel}>อำเภอ</span>
                            <input style={s.inlineInput}
                              value={r.perf.district || ""}
                              onChange={e => updatePerfField(idx, "district", e.target.value)} />
                          </div>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span style={s.fieldLabel}>ตำบล</span>
                            <input style={s.inlineInput}
                              value={r.perf.subdistrict || ""}
                              onChange={e => updatePerfField(idx, "subdistrict", e.target.value)} />
                          </div>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span style={s.fieldLabel}>หมู่บ้าน</span>
                            <input style={s.inlineInput}
                              value={r.perf.village || ""}
                              onChange={e => updatePerfField(idx, "village", e.target.value)} />
                          </div>
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: "#D1D5DB", margin: "4px 0" }}>
                          📍 {[r.perf.village, r.perf.district, r.perf.province].filter(Boolean).join(" › ")}
                        </div>
                      )}

                      {r.issues.map((issue, ii) => (
                        <div key={ii} style={s.issueTag}>
                          {issue.type === "duplicate" ? "🔁" : "⚠️"} {issue.msg}
                        </div>
                      ))}
                      {r.ok && <div style={{ fontSize: 11, color: "#34D399" }}>✅ ผ่านการตรวจสอบ</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── ENTITY RESOLVER ──────────────────────────────────────────────── */}
        {step === "resolve" && (
          <div>
            <Card title="🔗 Step 3 — Entity Resolver">
              <p style={s.hint}>จับคู่ชื่อศิลปินกับฐานข้อมูล entities</p>
              {resolving && <p style={{ color: "#9CA3AF" }}>⏳ กำลังโหลด entities จาก Supabase...</p>}
              {!resolving && resEntries.length > 0 && (
                <>
                  <div style={s.summaryBar}>
                    <Stat n={exactCount} label="ตรงเป๊ะ" color="#34D399" />
                    <Stat n={suggestedCount} label="ใกล้เคียง" color="#FBBF24" />
                    <Stat n={newCount} label="ใหม่" color="#F87171" />
                    <div style={{ marginLeft: "auto" }}>
                      <Btn onClick={saveAll} disabled={saving}>
                        {saving ? "⏳ กำลังบันทึก..." : `💾 บันทึก ${performances.length} รายการ`}
                      </Btn>
                    </div>
                  </div>
                  {saveErr && <Err>{saveErr}</Err>}
                </>
              )}
            </Card>

            {/* Entity resolution table */}
            {!resolving && resEntries.length > 0 && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>

                {/* Suggested — needs confirmation */}
                {resEntries.filter(([, v]) => v.status === "suggested").length > 0 && (
                  <Section title="⚠️ ใกล้เคียง — ยืนยันการจับคู่">
                    {resEntries.filter(([, v]) => v.status === "suggested").map(([rawName, res]) => (
                      <EntityRow key={rawName}
                        rawName={rawName} res={res}
                        onConfirm={() => confirmSuggestion(rawName)}
                        onReject={() => rejectSuggestion(rawName)}
                      />
                    ))}
                  </Section>
                )}

                {/* New — needs creation */}
                {resEntries.filter(([, v]) => v.status === "new").length > 0 && (
                  <Section title="🆕 ใหม่ — กำหนดชื่อ canonical">
                    {resEntries.filter(([, v]) => v.status === "new").map(([rawName, res]) => (
                      <NewEntityRow key={rawName}
                        rawName={rawName} res={res}
                        form={newEntityForms[rawName] || {}}
                        onChange={(field, val) => updateNewForm(rawName, field, val)}
                      />
                    ))}
                  </Section>
                )}

                {/* Exact — auto-matched */}
                {exactCount > 0 && (
                  <Section title={`✅ ตรงเป๊ะ — auto-matched (${exactCount})`} collapsed>
                    {resEntries.filter(([, v]) => v.status === "exact").map(([rawName, res]) => (
                      <div key={rawName} style={s.exactRow}>
                        <span style={{ color: "#9CA3AF", fontSize: 12 }}>{rawName}</span>
                        <span style={{ color: "#34D399", fontSize: 11 }}>→ {res.canonical_name}</span>
                        <span style={{ ...s.roleBadge, background: ROLE[res.role_type]?.bg, color: ROLE[res.role_type]?.color }}>
                          {ROLE[res.role_type]?.label}
                        </span>
                      </div>
                    ))}
                  </Section>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── DONE ─────────────────────────────────────────────────────────── */}
        {step === "done" && (
          <Card>
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ fontSize: 56 }}>✅</div>
              <h2 style={{ color: "#34D399", margin: "12px 0 4px" }}>บันทึกแล้ว {savedCount} รายการ</h2>
              <p style={s.hint}>ข้อมูลอยู่ใน Supabase พร้อม entity links แล้ว</p>
              <Btn onClick={reset} style={{ margin: "16px auto 0" }}>+ วันใหม่</Btn>
            </div>
          </Card>
        )}

      </div>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────
function Card({ title, hint, children }) {
  return (
    <div style={s.card}>
      {title && <h2 style={s.cardTitle}>{title}</h2>}
      {hint && <p style={s.hint}>{hint}</p>}
      {children}
    </div>
  );
}
function Label({ children }) { return <div style={s.label}>{children}</div>; }
function Input({ value, onChange, placeholder, type }) {
  return <input type={type || "text"} style={s.input} value={value}
    onChange={e => onChange(e.target.value)} placeholder={placeholder} />;
}
function Textarea({ value, onChange, rows, mono, placeholder }) {
  return <textarea style={{ ...s.input, height: rows * 22, resize: "vertical", fontFamily: mono ? "monospace" : "inherit", fontSize: mono ? 12 : 14 }}
    value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />;
}
function Btn({ onClick, disabled, children, secondary }) {
  return <button style={{ ...s.btn, ...(secondary ? s.btnSecondary : {}), opacity: disabled ? 0.5 : 1 }}
    onClick={onClick} disabled={disabled}>{children}</button>;
}
function Err({ children }) { return <div style={s.err}>{children}</div>; }
function Stat({ n, label, color }) {
  return <div style={{ textAlign: "center" }}>
    <div style={{ fontSize: 22, fontWeight: 700, color: color || "#D97706" }}>{n}</div>
    <div style={{ fontSize: 10, color: "#6B7280", textTransform: "uppercase" }}>{label}</div>
  </div>;
}
function Section({ title, children, collapsed }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <div style={{ background: "#1F2937", border: "1px solid #374151", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "10px 16px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: open ? "1px solid #374151" : "none" }}
        onClick={() => setOpen(o => !o)}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#F3F4F6" }}>{title}</span>
        <span style={{ color: "#6B7280" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && <div style={{ padding: "8px 16px 12px", display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>}
    </div>
  );
}
function EntityRow({ rawName, res, onConfirm, onReject }) {
  return (
    <div style={{ background: "#111827", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 13, color: "#E5E7EB", flex: "0 0 180px" }}>{rawName}</span>
      <span style={{ fontSize: 11, color: "#6B7280" }}>→</span>
      <span style={{ fontSize: 13, color: "#FBBF24" }}>{res.canonical_name}</span>
      <span style={{ fontSize: 11, color: "#6B7280" }}>({Math.round(res.score * 100)}%)</span>
      <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
        <button style={{ ...s.confirmBtn }} onClick={onConfirm}>✅ ใช่</button>
        <button style={{ ...s.rejectBtn }} onClick={onReject}>✕ ไม่ใช่</button>
      </div>
    </div>
  );
}
function NewEntityRow({ rawName, res, form, onChange }) {
  return (
    <div style={{ background: "#111827", borderRadius: 8, padding: "10px 14px" }}>
      <div style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 6 }}>Raw: <span style={{ color: "#F87171" }}>{rawName}</span></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input style={{ ...s.input, flex: "1 1 200px", fontSize: 13, padding: "6px 10px" }}
          value={form.canonical_name || rawName}
          onChange={e => onChange("canonical_name", e.target.value)}
          placeholder="Canonical name" />
        <select style={{ ...s.input, flex: "0 0 130px", fontSize: 13, padding: "6px 10px" }}
          value={form.role_type || res.role_type || "unknown"}
          onChange={e => onChange("role_type", e.target.value)}>
          <option value="headliner">หมอลำ</option>
          <option value="dancer_troupe">แดนซ์</option>
          <option value="band">วง</option>
          <option value="sound">ซาวด์</option>
          <option value="float">รถแห่</option>
          <option value="unknown">ไม่แน่ใจ</option>
        </select>
      </div>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────
const s = {
  root: { minHeight: "100vh", background: "#111827", color: "#F9FAFB", fontFamily: "'DBHelvethaicaX', sans-serif", fontSize: 18 },
  header: { background: "#1F2937", borderBottom: "1px solid #374151", padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 },
  title: { fontSize: 16, fontWeight: 700, color: "#D97706", letterSpacing: 1 },
  subtitle: { fontSize: 11, color: "#6B7280", letterSpacing: 1 },
  stepPill: { fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 12, letterSpacing: 0.5 },
  stepArrow: { color: "#374151", padding: "0 4px", fontSize: 12 },
  body: { maxWidth: 960, margin: "0 auto", padding: "24px 16px 48px" },
  card: { background: "#1F2937", border: "1px solid #374151", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 },
  card2: { background: "#1F2937", border: "1px solid #374151", borderRadius: 8, padding: 12 },
  warningBox: { background: "#422006", border: "1px solid #B45309", borderRadius: 8, padding: "12px 16px", color: "#FDE68A", fontSize: 13, lineHeight: 1.5 },
  cardTitle: { margin: 0, fontSize: 16, fontWeight: 700, color: "#F3F4F6" },
  hint: { margin: 0, color: "#9CA3AF", lineHeight: 1.7, fontSize: 13 },
  label: { fontSize: 11, color: "#6B7280", textTransform: "uppercase", letterSpacing: 1, marginTop: 4 },
  input: { background: "#111827", border: "1px solid #374151", borderRadius: 8, padding: "9px 12px", color: "#F9FAFB", fontSize: 14, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" },
  btn: { background: "#D97706", border: "none", borderRadius: 8, padding: "9px 20px", color: "#111827", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit", alignSelf: "flex-start" },
  btnSecondary: { background: "#374151", color: "#F9FAFB" },
  ghostBtn: { background: "transparent", border: "1px solid #374151", borderRadius: 6, padding: "2px 8px", color: "#9CA3AF", cursor: "pointer", fontSize: 11, fontFamily: "inherit" },
  err: { background: "#1F0A0A", border: "1px solid #7F1D1D", borderRadius: 8, padding: "10px 14px", color: "#FCA5A5" },
  summaryBar: { background: "#111827", borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", gap: 24, marginBottom: 12, flexWrap: "wrap" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 10 },
  issueTag: { fontSize: 11, background: "#2A0A0A", border: "1px solid #7F1D1D", color: "#FCA5A5", padding: "3px 8px", borderRadius: 6, display: "inline-block", marginTop: 4 },
  removeBtn: { background: "transparent", border: "1px solid #7F1D1D", borderRadius: 6, padding: "2px 8px", color: "#F87171", cursor: "pointer", fontSize: 11, fontFamily: "inherit" },
  exactRow: { display: "flex", gap: 10, alignItems: "center", padding: "4px 0", borderBottom: "1px solid #1F2937" },
  roleBadge: { fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 6, minWidth: 32, textAlign: "center" },
  confirmBtn: { background: "#052E16", border: "1px solid #166534", borderRadius: 6, padding: "4px 10px", color: "#34D399", cursor: "pointer", fontSize: 12, fontFamily: "inherit" },
  rejectBtn: { background: "#1F0A0A", border: "1px solid #7F1D1D", borderRadius: 6, padding: "4px 10px", color: "#F87171", cursor: "pointer", fontSize: 12, fontFamily: "inherit" },
  fieldLabel: { fontSize: 10, color: "#6B7280", minWidth: 48, textAlign: "right" },
  inlineInput: { background: "#111827", border: "1px solid #374151", borderRadius: 6, padding: "4px 8px", color: "#F9FAFB", fontSize: 13, fontFamily: "inherit", outline: "none", flex: 1 },
};