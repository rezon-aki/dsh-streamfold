/**
 * A1–A7 帧率矩阵分析器（M4 / task-24）。
 *   node test/framerate-afix.mjs <jsonl...> [--md out.md]
 * A1 写入比/skip；A3 插值后跨档差（全纯段 + 稳态段）；A4 稳态 gap_ss 六档极差；
 * A5 稳态漂移；A6 塌缩配对；A7 原始格相位差 + 解析下界 v·dt/2。
 * 纯段 = 剔除每次塌缩（Δfloor < -50px）前后 300ms；稳态段 = 最后一次塌缩 +400ms 之后。
 */
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mdIdx = args.indexOf("--md");
const files = args.filter((a, i) => !a.startsWith("--") && i !== mdIdx + 1);
const outMd = mdIdx >= 0 ? args[mdIdx + 1] : null;
const load = (p) => readFileSync(p, "utf8").trim().split("\n").map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean).slice(1);
const q = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN; };
const interp = (F, key) => (t) => {
  if (t <= F[0].t) return F[0][key];
  if (t >= F[F.length - 1].t) return F[F.length - 1][key];
  let lo = 0, hi = F.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (F[m].t <= t) lo = m; else hi = m; }
  const k = (t - F[lo].t) / (F[hi].t - F[lo].t || 1);
  return F[lo][key] + (F[hi][key] - F[lo][key]) * k;
};
const runs = files.map((p) => {
  const F = load(p); if (F.length < 10) return null;
  const cuts = []; for (let i = 1; i < F.length; i++) if (F[i].floor - F[i - 1].floor < -50) cuts.push(F[i].t);
  const isPure = (t) => { for (const c of cuts) if (t >= c - 300 && t <= c + 300) return false; return t >= F[0].t + 200 && t <= F[F.length - 1].t - 100; };
  return { path: p, F, hz: F[0].hz || Math.round(1000 / (F[1].t - F[0].t)), isPure, cuts, lastCut: cuts.length ? cuts[cuts.length - 1] : F[0].t };
}).filter(Boolean);
const lines = []; const say = (s) => { lines.push(s); console.log(s); };
const t0 = Math.max(...runs.map((r) => r.F[0].t)) + 200;
const t1 = Math.min(...runs.map((r) => r.F[r.F.length - 1].t)) - 100;
const grid = []; for (let t = t0; t <= t1; t += 5) if (runs.every((r) => r.isPure(t))) grid.push(t);
// 稳态段 = 最长的公共纯段（按各档塌缩点合并出的区间里选最长；末次塌缩常贴在片尾，不能只取"最后一次之后"）
const cuts = [...new Set(runs.flatMap((r) => r.cuts.map((c) => Math.round(c / 50) * 50)))].sort((x, y) => x - y);
const segs = [];
{
  let from = t0;
  for (const c of cuts) { if (c - 300 > from) segs.push([from, c - 300]); from = Math.max(from, c + 300); }
  if (t1 > from) segs.push([from, t1]);
}
const steadySeg = segs.length ? segs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a)) : [t0, t1];
const steady = []; for (let t = steadySeg[0]; t <= steadySeg[1]; t += 5) if (runs.every((r) => r.isPure(t))) steady.push(t);
const base = runs.find((r) => r.hz === 60);
const stBase = base ? interp(base.F, "st") : null;
const lastOf = (G, tt) => { let v = G[0]; for (const f of G) { if (f.t <= tt) v = f; else break; } return v; };

say("# M4 帧率矩阵（A1–A7）");
say("");
say(`> 纯段网格 ${grid.length} 点 / 稳态段（最长公共纯段 ${Math.round(steadySeg[0])}–${Math.round(steadySeg[1])}ms）${steady.length} 点（5ms 步长，六档公共）。`);
say("");
say("| Hz | frames | 写入比 | skip% | gap_ss(稳态) | p95(\|gap−gap_ss\|) | A3 稳态 p50/p95/max | A3 全纯段 p50 | 漂移 px/s | 格相位 p50 (下界 v·dt/2) | 塌缩违规 |");
say("|---|---|---|---|---|---|---|---|---|---|---|");

const rows = [];
for (const r of runs) {
  const F = r.F, hz = r.hz, dt = F[1].t - F[0].t;
  const iSt = interp(F, "st"), iFl = interp(F, "floor");
  let grow = 0, wrote = 0, skip = 0;
  for (let i = 1; i < F.length; i++) if (r.isPure(F[i].t) && F[i].floor > F[i - 1].floor + 0.5) { grow++; if (Math.abs(F[i].st - F[i - 1].st) > 0.01) wrote++; else skip++; }
  const gaps = steady.map((t) => iFl(t) - iSt(t));
  const gapSS = q(gaps, 0.5), devP95 = q(gaps.map((g) => Math.abs(g - gapSS)), 0.95);
  const dS = base && hz !== 60 ? steady.map((t) => iSt(t) - stBase(t)) : [];
  const dA = base && hz !== 60 ? grid.map((t) => iSt(t) - stBase(t)) : [];
  let drift = 0;
  if (dS.length) {
    const n = steady.length, xs = steady.map((t) => (t - steady[0]) / 1000);
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = dS.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0; for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (dS[i] - my); den += (xs[i] - mx) ** 2; }
    drift = den ? num / den : 0;
  }
  const dRaw = base && hz !== 60 ? steady.map((t) => lastOf(F, t).st - lastOf(base.F, t).st) : [];
  let viol = 0;
  for (let i = 1; i < F.length - 1; i++) if (F[i].floor < F[i - 1].floor - 2 && !F[i].pluginWrote && F[i + 1].pluginWrote && F[i + 1].st - F[i].st > 2) viol++;
  rows.push({ hz, frames: F.length, wrote: grow ? wrote / grow : 1, skip: grow ? skip / grow : 0, gapSS, devP95, dS, dA, dRaw, drift, viol, dt });
}
for (const r of rows) {
  const f3 = (d) => d.length ? `${q(d, 0.5).toFixed(0)}/${q(d, 0.95).toFixed(0)}/${Math.max(...d.map(Math.abs)).toFixed(0)}` : "—";
  const a3all = r.dA.length ? q(r.dA.map(Math.abs), 0.5).toFixed(0) : "—";
  const a7 = r.dRaw.length ? `${q(r.dRaw.map(Math.abs), 0.5).toFixed(0)} (${(11.7 * r.dt / 2).toFixed(0)})` : "—";
  say(`| ${r.hz} | ${r.frames} | ${r.wrote.toFixed(3)} | ${(r.skip * 100).toFixed(1)} | ${r.gapSS.toFixed(1)} | ${r.devP95.toFixed(2)} | ${f3(r.dS)} | ${a3all} | ${r.drift.toFixed(2)} | ${a7} | ${r.viol} |`);
}
const spread = Math.max(...rows.map((r) => r.gapSS)) - Math.min(...rows.map((r) => r.gapSS));
const withD = rows.filter((r) => r.dS.length);
say("");
say(`- A1：写入比最小 ${Math.min(...rows.map((r) => r.wrote)).toFixed(3)}；skip 最大 ${(Math.max(...rows.map((r) => r.skip)) * 100).toFixed(1)}%`);
say(`- A3 稳态：p50 ≤ ${Math.max(...withD.map((r) => Math.abs(q(r.dS, 0.5)))).toFixed(1)} / p95 ≤ ${Math.max(...withD.map((r) => Math.abs(q(r.dS, 0.95)))).toFixed(1)} / max ≤ ${Math.max(...withD.map((r) => Math.max(...r.dS.map(Math.abs)))).toFixed(1)} px`);
say(`- A4：gap_ss = ${rows.map((r) => r.gapSS.toFixed(0)).join("/")}，**六档极差 ${spread.toFixed(2)} px**`);
say(`- A5：稳态漂移最大 ${Math.max(...rows.map((r) => Math.abs(r.drift))).toFixed(2)} px/s`);
say(`- A6：塌缩违规合计 ${rows.reduce((a, r) => a + r.viol, 0)}`);
if (outMd) writeFileSync(outMd, lines.join("\n") + "\n");
