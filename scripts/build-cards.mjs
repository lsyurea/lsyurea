#!/usr/bin/env node
// Builds every image on this profile README (typing header, badges, LeetCode
// and contribution-streak cards) as SVGs in assets/, so viewing the profile
// doesn't depend on third-party image services. Runs daily from
// .github/workflows/update-profile.yml; if a data source fails, that image
// keeps its last good version.
//
// Local run: GITHUB_TOKEN=$(gh auth token) node scripts/build-cards.mjs

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "assets");
const LOGO_DIR = path.join(ROOT, "scripts", "logos"); // Simple Icons 16.35.0, CC0

// Same GitHub-dark palette as the Open Source card from lsyurea/Open-Source.
const THEME = {
  bg: "#0d1117", border: "#30363d", title: "#58a6ff", ink: "#e6edf3", text: "#8b949e",
  easy: "#3fb950", medium: "#d29922", hard: "#f85149",
};
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const BADGE_FONT = "Verdana, 'DejaVu Sans', Geneva, sans-serif";
// The README's status dashboard is a row of badges over a row of cards, laid out
// by inline wrapping (GitHub strips CSS): two cards fit side by side in the
// ~760px profile column on laptops and stack one per row on narrower screens,
// where images shrink to the column width. Badges are sized so three of them
// span the same width as two cards, given the ~3.8px space GitHub leaves
// between images.
const CARD = { width: 372, height: 182, pad: 20 };
const BADGE_WIDTH = (2 * CARD.width - 3.8) / 3;

const LEETCODE_QUERY = `
query ($username: String!) {
  allQuestionsCount { difficulty count }
  matchedUser(username: $username) {
    username
    profile { ranking }
    submitStatsGlobal { acSubmissionNum { difficulty count } }
  }
  userContestRanking(username: $username) { attendedContestsCount rating topPercentage }
}`;

const CALENDAR_QUERY = `
query ($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar { weeks { contributionDays { date contributionCount } } }
    }
  }
}`;

async function main() {
  const config = JSON.parse(await readFile(path.join(ROOT, "profile.config.json"), "utf8"));
  const logos = await loadLogos();

  // LeetCode feeds both the badge and the card, so fetch it once.
  let leetcode;
  const leetcodeStats = () => (leetcode ??= fetchLeetcode(config.leetcode));

  const outputs = {
    "header.svg": () => typingHeader(config.typing),
    "badges/leetcode.svg": async () => {
      const { contest } = await leetcodeStats();
      return badge(logos.leetcode, "LeetCode", contest ? `Rating ${Math.round(contest.rating)}` : "View Profile");
    },
    "badges/codeforces.svg": async () => {
      const user = await fetchCodeforces(config.codeforces);
      return badge(logos.codeforces, "Codeforces", user.rating ? `Rating ${user.rating}` : "Unrated");
    },
    "badges/kaggle.svg": () => badge(logos.kaggle, "Kaggle", "View Profile"),
    "leetcode.svg": async () => leetcodeCard(await leetcodeStats(), logos.leetcode),
    "streak.svg": async () => streakCard(config.github, streaks(await fetchContributionDays(config.github)), logos.github),
  };

  let failed = 0;
  for (const [file, build] of Object.entries(outputs)) {
    try {
      const target = path.join(ASSETS, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await build());
      console.log(`Built assets/${file}`);
    } catch (error) {
      failed++;
      // ::warning:: shows up as an annotation on the Actions run.
      console.log(`::warning::Kept previous assets/${file}: ${error.message}`);
    }
  }
  if (failed === Object.keys(outputs).length) process.exit(1);
}

async function loadLogos() {
  const logos = {};
  for (const file of await readdir(LOGO_DIR)) {
    const svg = await readFile(path.join(LOGO_DIR, file), "utf8");
    logos[path.basename(file, ".svg")] = svg.match(/ d="([^"]+)"/)[1];
  }
  return logos;
}

async function getJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": "lsyurea-profile-cards", ...init.headers },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

async function fetchLeetcode(username) {
  const { data } = await getJson("https://leetcode.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Referer: "https://leetcode.com" },
    body: JSON.stringify({ query: LEETCODE_QUERY, variables: { username } }),
  });
  if (!data?.matchedUser) throw new Error(`LeetCode user ${username} not found`);
  const byDifficulty = (list) => Object.fromEntries(list.map(({ difficulty, count }) => [difficulty, count]));
  const contest = data.userContestRanking;
  return {
    username: data.matchedUser.username,
    ranking: data.matchedUser.profile.ranking,
    solved: byDifficulty(data.matchedUser.submitStatsGlobal.acSubmissionNum),
    total: byDifficulty(data.allQuestionsCount),
    contest: contest?.attendedContestsCount ? contest : null,
  };
}

async function fetchCodeforces(handle) {
  const body = await getJson(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(handle)}`);
  if (body.status !== "OK") throw new Error(`Codeforces: ${body.comment}`);
  return body.result[0];
}

async function githubGraphql(query, variables) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const body = await getJson("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}

// The calendar API caps each query at one year, so walk every year with activity.
async function fetchContributionDays(login) {
  const { user } = await githubGraphql(
    "query ($login: String!) { user(login: $login) { contributionsCollection { contributionYears } } }",
    { login },
  );
  if (!user) throw new Error(`GitHub user ${login} not found`);
  const today = new Date().toISOString().slice(0, 10);
  const days = new Map();
  for (const year of [...user.contributionsCollection.contributionYears].sort()) {
    const { user: { contributionsCollection: { contributionCalendar } } } = await githubGraphql(CALENDAR_QUERY, {
      login,
      from: `${year}-01-01T00:00:00Z`,
      to: `${year}-12-31T23:59:59Z`,
    });
    for (const week of contributionCalendar.weeks) {
      for (const day of week.contributionDays) if (day.date <= today) days.set(day.date, day.contributionCount);
    }
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
}

function streaks(days) {
  let total = 0;
  let first = null;
  let run = null;
  let longest = { length: 0 };
  for (const { date, count } of days) {
    total += count;
    if (count > 0) {
      first ??= date;
      run = run ? { ...run, length: run.length + 1, end: date } : { length: 1, start: date, end: date };
      if (run.length > longest.length) longest = run;
    } else {
      run = null;
    }
  }
  // No contributions yet today doesn't break the streak.
  let end = days.length - 1;
  if (days[end]?.count === 0) end--;
  let start = end;
  while (start >= 0 && days[start].count > 0) start--;
  const current = end > start ? { length: end - start, start: days[start + 1].date, end: days[end].date } : { length: 0 };
  return { total, first, current, longest };
}

function leetcodeCard(stats, logo) {
  const meta = stats.contest
    ? ["Rating ", String(Math.round(stats.contest.rating)), ` · Top ${stats.contest.topPercentage}%`]
    : ["Rank ", `#${fmt(stats.ranking)}`, ""];
  const body = cardHeader(logo, "#ffa116", "LeetCode", meta);

  // Ring: share of all problems solved
  body.push(...ringStat(stats.solved.All / stats.total.All, fmt(stats.solved.All), "solved"));
  ["Easy", "Medium", "Hard"].forEach((level, i) => {
    const solved = stats.solved[level];
    const total = stats.total[level];
    const row = statRow(i);
    const { x, y, width } = row;
    body.push(...statLabel(row, level, ["", fmt(solved), ` / ${fmt(total)}`]));
    body.push(`<rect x="${x}" y="${y + 9}" width="${width}" height="6" rx="3" fill="${THEME.border}"/>`);
    body.push(`<rect x="${x}" y="${y + 9}" width="${round(Math.max(6, (width * solved) / total))}" height="6" rx="3" fill="${THEME[level.toLowerCase()]}"/>`);
  });
  return card(body, `LeetCode: ${stats.solved.All} problems solved`);
}

function streakCard(login, s, logo) {
  const body = cardHeader(logo, THEME.ink, "Contribution Streak", ["", `@${login}`, ""]);
  const days = (n) => ["", fmt(n), n === 1 ? " day" : " days"];

  // Ring fills as the current streak approaches the longest one.
  body.push(...ringStat(s.longest.length ? s.current.length / s.longest.length : 0, fmt(s.current.length), "day streak"));
  [
    ["Current streak", days(s.current.length), dateRange(s.current)],
    ["Longest streak", days(s.longest.length), dateRange(s.longest)],
    ["Total contributions", ["", fmt(s.total), ""], s.first ? `${formatDate(s.first)} – Present` : "No contributions yet"],
  ].forEach(([label, value, detail], i) => {
    const row = statRow(i);
    body.push(...statLabel(row, label, value));
    body.push(svgText(row.x, row.y + 16, detail, { fill: THEME.text, "font-size": 12 }));
  });
  return card(body, `GitHub: ${s.total} contributions, current streak ${s.current.length} days, longest ${s.longest.length} days`);
}

// Both cards share one layout: a ring on the left, three stat rows on the right.
const RING = { cx: CARD.pad + 54, cy: 114, r: 42, stroke: 8 };

function ringStat(share, value, label) {
  const { cx, cy, r, stroke } = RING;
  return [
    ...ring(cx, cy, r, stroke, share),
    svgText(cx, cy + 6, value, { fill: THEME.ink, "font-size": 26, "font-weight": 600, "text-anchor": "middle" }),
    svgText(cx, cy + 24, label, { fill: THEME.text, "font-size": 12, "text-anchor": "middle" }),
  ];
}

function statRow(i) {
  const x = RING.cx + RING.r + RING.stroke / 2 + 28;
  return { x, y: 76 + i * 36, width: CARD.width - CARD.pad - x };
}

function statLabel({ x, y, width }, label, value) {
  return [
    svgText(x, y, label, { fill: THEME.ink, "font-size": 13, "font-weight": 500 }),
    richText(x + width, y, value, { fill: THEME.text, "font-size": 12, "text-anchor": "end" }),
  ];
}

// meta is [prefix, emphasised value, suffix], right-aligned in the header.
function cardHeader(logo, logoColor, title, meta) {
  const { width, pad } = CARD;
  return [
    `<svg x="${pad}" y="18" width="20" height="20" viewBox="0 0 24 24"><path d="${logo}" fill="${logoColor}"/></svg>`,
    svgText(pad + 30, 34, title, { fill: THEME.title, "font-size": 16, "font-weight": 600 }),
    richText(width - pad, 34, meta, { fill: THEME.text, "font-size": 12, "text-anchor": "end" }),
  ];
}

function ring(cx, cy, r, stroke, share) {
  const circumference = 2 * Math.PI * r;
  const arc = Math.min(1, Math.max(0, share)) * circumference;
  return [
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${THEME.border}" stroke-width="${stroke}"/>`,
    arc > 0
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${THEME.title}" stroke-width="${stroke}" stroke-linecap="round" ` +
        `stroke-dasharray="${round(arc)} ${round(circumference)}" transform="rotate(-90 ${cx} ${cy})"/>`
      : "",
  ];
}

function card(body, title) {
  const { width, height } = CARD;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" font-family="${FONT}">\n` +
    `<title>${escapeXml(title)}</title>\n` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${THEME.bg}" stroke="${THEME.border}"/>\n` +
    `${body.filter(Boolean).join("\n")}\n</svg>\n`
  );
}

// Shields-style "for-the-badge": dark label with logo, grey message centred in
// the rest of the fixed width so the badges line up as a grid. textLength
// pins each text run to the computed width so the layout holds in any font.
function badge(logo, label, message) {
  const height = 28;
  const labelText = label.toUpperCase();
  const messageText = message.toUpperCase();
  const labelWidth = capsWidth(labelText, false);
  const messageWidth = capsWidth(messageText, true);
  const split = 30 + labelWidth + 10;
  const width = round(Math.max(BADGE_WIDTH, split + 12 + messageWidth + 12));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">\n` +
    `<title>${escapeXml(`${label}: ${message}`)}</title>\n` +
    `<clipPath id="r"><rect width="${width}" height="${height}" rx="6"/></clipPath>\n` +
    `<g clip-path="url(#r)"><rect width="${split}" height="${height}" fill="${THEME.bg}"/>` +
    `<rect x="${split}" width="${round(width - split)}" height="${height}" fill="${THEME.border}"/></g>\n` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="5.5" fill="none" stroke="${THEME.border}"/>\n` +
    `<svg x="10" y="7" width="14" height="14" viewBox="0 0 24 24"><path d="${logo}" fill="${THEME.title}"/></svg>\n` +
    `<g font-family="${BADGE_FONT}" font-size="10" fill="#ffffff">` +
    `<text x="30" y="18" textLength="${labelWidth}" lengthAdjust="spacing">${escapeXml(labelText)}</text>` +
    `<text x="${round((split + width) / 2)}" y="18" font-weight="700" text-anchor="middle" textLength="${messageWidth}" lengthAdjust="spacing">${escapeXml(messageText)}</text>` +
    `</g>\n</svg>\n`
  );
}

// Verdana caps at 10px plus ~1.2px tracking, the for-the-badge look.
function capsWidth(text, bold) {
  const glyph = (ch) => (ch === " " ? 3.5 : /[0-9]/.test(ch) ? 6.4 : /[A-Z]/.test(ch) ? 7.1 : 4.5) * (bold ? 1.08 : 1);
  return round([...text].reduce((sum, ch) => sum + glyph(ch) + 1.2, -1.2));
}

// Types each line character by character, pauses, deletes it, then moves on.
// Every glyph gets its own step keyframes; textLength pins the advance to
// 0.6em so the cursor lines up whichever monospace font the viewer has.
function typingHeader({ lines, color = THEME.title, width = 600, height = 50, fontSize = 24 }) {
  const typeMs = 2500;
  const pauseMs = 800;
  const deleteMs = 900;
  const slot = typeMs + pauseMs + deleteMs + 300;
  const cycle = slot * lines.length;
  const pct = (ms) => `${Math.round((ms / cycle) * 1e5) / 1e3}%`;
  const advance = fontSize * 0.6;
  const keyframes = [];
  const texts = [];
  const cursor = [];

  lines.forEach((line, i) => {
    const chars = [...line];
    const left = (width - chars.length * advance) / 2;
    const start = i * slot;
    const typeStep = typeMs / chars.length;
    const deleteStep = deleteMs / chars.length;
    const deleteStart = start + typeMs + pauseMs;
    cursor.push([start, left]);
    const spans = chars.map((ch, k) => {
      const on = start + (k + 1) * typeStep;
      const off = deleteStart + (chars.length - 1 - k) * deleteStep;
      keyframes.push(`@keyframes l${i}c${k}{${pct(on)}{fill-opacity:1}${pct(off)}{fill-opacity:0}}`);
      cursor.push([on, left + (k + 1) * advance], [off, left + k * advance]);
      return `<tspan class="c" style="animation-name:l${i}c${k}">${escapeXml(ch)}</tspan>`;
    });
    texts.push(
      `<text x="${round(left)}" y="${height / 2}" dominant-baseline="central" textLength="${round(chars.length * advance)}" ` +
        `lengthAdjust="spacing" xml:space="preserve">${spans.join("")}</text>`,
    );
  });

  cursor.sort(([a], [b]) => a - b);
  const cursorFrames = cursor.map(([ms, x]) => `${pct(ms)}{transform:translateX(${round(x)}px)}`).join("");
  const cursorHeight = Math.round(fontSize * 1.15);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">\n` +
    `<title>${escapeXml(lines.join(" · "))}</title>\n` +
    `<style>` +
    `text{font-family:${MONO};font-size:${fontSize}px;fill:${color}}` +
    `.c{fill-opacity:0;animation:${cycle}ms step-end infinite}` +
    `.cursor{animation:cursor ${cycle}ms step-end infinite}` +
    `.blink{animation:blink 1s step-end infinite}` +
    `@keyframes blink{50%{opacity:0}}` +
    `@keyframes cursor{${cursorFrames}}` +
    `${keyframes.join("")}</style>\n` +
    `${texts.join("\n")}\n` +
    `<g class="blink"><rect class="cursor" x="0" y="${(height - cursorHeight) / 2}" width="2" height="${cursorHeight}" fill="${color}"/></g>\n` +
    `</svg>\n`
  );
}

function dateRange({ length, start, end }) {
  if (!length) return "Start one today";
  const thisYear = String(new Date().getUTCFullYear());
  const showYear = start.slice(0, 4) !== thisYear || end.slice(0, 4) !== thisYear;
  if (start === end) return formatDate(start, showYear);
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${formatDate(start, false)} – ${formatDate(end, showYear)}`
    : `${formatDate(start)} – ${formatDate(end)}`;
}

function formatDate(iso, withYear = true) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear && { year: "numeric" }),
    timeZone: "UTC",
  });
}

function svgText(x, y, content, attrs) {
  return `<text x="${round(x)}" y="${round(y)}"${attrList(attrs)}>${escapeXml(String(content))}</text>`;
}

// [prefix, value, suffix] with the value emphasised.
function richText(x, y, [prefix, value, suffix], attrs) {
  return (
    `<text x="${round(x)}" y="${round(y)}"${attrList(attrs)}>${escapeXml(prefix)}` +
    `<tspan fill="${THEME.ink}" font-weight="600">${escapeXml(value)}</tspan>${escapeXml(suffix)}</text>`
  );
}

function attrList(attrs) {
  return Object.entries(attrs).map(([key, value]) => ` ${key}="${value}"`).join("");
}

function escapeXml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]);
}

const round = (n) => Math.round(n * 10) / 10;
const fmt = (n) => n.toLocaleString("en-US");

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
