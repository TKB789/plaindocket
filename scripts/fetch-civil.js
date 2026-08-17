/**
 * Pulls civil dockets and their publicly available filings from CourtListener's
 * RECAP archive, for every case listed in data/watchlist.json.
 *
 * THE BINDING CONSTRAINT: an authenticated CourtListener account is limited to
 * 5 requests per minute, 50 per hour and 125 per day. That is the whole budget.
 * Entries come back 20 per page, so a 100-entry case costs ~6 requests and
 * finishes in one night; a 1,500-entry case costs ~75 and takes two. This
 * script therefore:
 *   - spaces every request 75 seconds apart (the 50/hour cap, not the 5/minute
 *     one, is what actually binds),
 *   - stops at MAX_REQUESTS,
 *   - remembers where it left off per docket and resumes there tomorrow.
 *
 * The token lives in a GitHub Actions secret and never reaches the browser.
 */

import fs from "node:fs";
import path from "node:path";

const BASE = "https://www.courtlistener.com/api/rest/v4";
const TOKEN = process.env.COURTLISTENER_TOKEN;
// 50 requests/hour is the binding limit, not the 5/minute one: 3600/50 = 72s
// between requests. 75s leaves a margin. 45 requests then takes about 56 min.
const MAX_REQUESTS = Number(process.env.MAX_REQUESTS || 45);
const SPACING_MS = Number(process.env.SPACING_MS || 75000);

const STORE = path.join("data", "lawsuits.json");
const WATCHLIST = path.join("data", "watchlist.json");
const OUT = path.join("docs", "lawsuits.json");

if (!TOKEN) {
  console.error(
    "No COURTLISTENER_TOKEN set — skipping civil dockets. Add it under Settings -> Secrets and variables -> Actions."
  );
  process.exit(0); // skip quietly rather than failing the whole run
}

let spent = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url) {
  if (spent >= MAX_REQUESTS) return null; // budget gone; pick up tomorrow
  if (spent > 0) await sleep(SPACING_MS);
  spent++;

  const res = await fetch(url, {
    headers: { Authorization: `Token ${TOKEN}`, "User-Agent": "plain-docket" },
  });

  if (res.status === 429) {
    console.warn("Throttled by CourtListener — stopping for today.");
    spent = MAX_REQUESTS;
    return null;
  }
  if (!res.ok) {
    console.warn(`${res.status} on ${url}`);
    return null;
  }
  return res.json();
}

/* ---------- shaping ----------------------------------------------------- */

const clean = (s) =>
  String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Where the public can actually read the PDF, if it exists at all. */
function docUrl(d) {
  if (d.filepath_local) return "https://storage.courtlistener.com/" + d.filepath_local;
  if (d.absolute_url) return "https://www.courtlistener.com" + d.absolute_url;
  return null;
}

function shapeDocs(entry) {
  const docs = entry.recap_documents || [];
  return docs
    .map((d) => ({
      num: d.document_number ?? null,
      att: d.attachment_number ?? null,
      desc: clean(d.description) || null,
      pages: d.page_count ?? null,
      available: Boolean(d.is_available),
      url: d.is_available ? docUrl(d) : null,
    }))
    .filter((d) => d.num !== null || d.desc);
}

function shapeEntry(e) {
  return {
    id: e.id,
    number: e.entry_number ?? null,
    date: e.date_filed || null,
    text: clean(e.description).slice(0, 600),
    docs: shapeDocs(e),
  };
}

/* ---------- store ------------------------------------------------------- */

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const watchlist = load(WATCHLIST, []);
const store = load(STORE, {});

/* ---------- per-docket work -------------------------------------------- */

async function updateDocket(item) {
  const key = String(item.docket);
  const rec = (store[key] ||= {
    docket: item.docket,
    label: item.label,
    entries: {},
    backfillNext: null,
    backfillDone: false,
  });
  rec.label = item.label; // let the watchlist rename things

  // Case metadata: only fetch once, it barely changes.
  if (!rec.caseName) {
    const d = await api(`${BASE}/dockets/${item.docket}/`);
    if (d) {
      rec.caseName = d.case_name || item.label;
      rec.docketNumber = d.docket_number || null;
      rec.court = typeof d.court === "string" ? d.court.split("/").filter(Boolean).pop() : null;
      rec.dateFiled = d.date_filed || null;
      rec.absoluteUrl = d.absolute_url
        ? "https://www.courtlistener.com" + d.absolute_url
        : null;
      rec.natureOfSuit = d.nature_of_suit || null;
    }
  }

  // Phase A — newest entries first, stop as soon as a page is all familiar.
  let url = `${BASE}/docket-entries/?docket=${item.docket}&order_by=-entry_number`;
  let page = await api(url);
  if (page === null) return;
  if (!page.results) {
    // Some deployments reject that ordering; fall back to the default.
    page = await api(`${BASE}/docket-entries/?docket=${item.docket}`);
    if (!page?.results) return;
  }

  let fresh = 0;
  for (const e of page.results) {
    if (!rec.entries[e.id]) fresh++;
    rec.entries[e.id] = shapeEntry(e);
  }
  if (!rec.backfillNext && !rec.backfillDone) rec.backfillNext = page.next || null;
  console.log(`${rec.label}: ${fresh} new on first page`);

  // Phase B — walk backwards through history until the budget runs out.
  while (rec.backfillNext && spent < MAX_REQUESTS) {
    const next = await api(rec.backfillNext);
    if (!next) break;
    for (const e of next.results || []) rec.entries[e.id] = shapeEntry(e);
    rec.backfillNext = next.next || null;
    if (!rec.backfillNext) {
      rec.backfillDone = true;
      console.log(`${rec.label}: backfill complete`);
    }
  }
}

for (const item of watchlist) {
  if (spent >= MAX_REQUESTS) {
    console.log("Daily request budget spent — remaining cases wait until tomorrow.");
    break;
  }
  await updateDocket(item);
}

/* ---------- write ------------------------------------------------------- */

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync(STORE, JSON.stringify(store));

const cases = Object.values(store).map((rec) => {
  const entries = Object.values(rec.entries).sort(
    (a, b) => (b.number ?? 0) - (a.number ?? 0)
  );
  const withDocs = entries.filter((e) => e.docs.some((d) => d.available)).length;
  return {
    docket: rec.docket,
    label: rec.label,
    caseName: rec.caseName || rec.label,
    docketNumber: rec.docketNumber || null,
    court: rec.court || null,
    dateFiled: rec.dateFiled || null,
    natureOfSuit: rec.natureOfSuit || null,
    absoluteUrl: rec.absoluteUrl || null,
    complete: Boolean(rec.backfillDone),
    entryCount: entries.length,
    readableCount: withDocs,
    entries,
  };
});

fs.mkdirSync("docs", { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify({ updated: new Date().toISOString(), cases })
);

const mb = (fs.statSync(OUT).size / 1048576).toFixed(2);
console.log(
  `${cases.length} case(s), ${cases.reduce((n, c) => n + c.entryCount, 0)} entries, ` +
    `${mb} MB, ${spent} requests used`
);
