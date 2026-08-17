/**
 * Pulls new press releases from the DOJ API and stores a distilled record for
 * each one. The full body is thrown away after extraction so the repo stays
 * small — the site always links back to justice.gov for the full text.
 *
 * DOJ limits: 50 results per page, and more than 4 requests/second gets you
 * throttled or blocked. We sleep 400ms between pages.
 */

import fs from "node:fs";
import path from "node:path";
import { distill } from "./extract.js";

const API = "https://www.justice.gov/api/v1/press_releases.json";
const FIELDS = "uuid,title,url,date,body,teaser,component,topic";
const STORE = path.join("data", "releases.json");

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 730);
const MAX_PAGES = Number(process.env.MAX_PAGES || 20);
const ONLY_SENTENCED = (process.env.ONLY_SENTENCED || "true") === "true";
const CUTOFF = Date.now() / 1000 - WINDOW_DAYS * 86400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- fetch loop -------------------------------------------------- */

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return {};
  }
}

async function getPage(page) {
  const url = `${API}?fields=${FIELDS}&sort=created&direction=DESC&pagesize=50&page=${page}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "plain-docket (static site, daily update)" },
  });
  if (!res.ok) throw new Error(`DOJ API returned ${res.status} on page ${page}`);
  const json = await res.json();
  return json?.results || [];
}

const store = loadStore();
let added = 0;
let seenOld = 0;

for (let page = 0; page < MAX_PAGES; page++) {
  let results;
  try {
    results = await getPage(page);
  } catch (e) {
    console.error(e.message, "— stopping early, will retry tomorrow");
    break;
  }
  if (!results.length) break;

  let newOnPage = 0;
  for (const r of results) {
    if (!r.uuid) continue;
    if (Number(r.date) < CUTOFF) {
      seenOld++;
      continue;
    }
    if (store[r.uuid]) continue;
    const rec = distill(r, { onlySentenced: ONLY_SENTENCED });
    if (rec) {
      store[rec.id] = rec;
      added++;
    }
    newOnPage++;
  }

  console.log(`page ${page}: ${results.length} results, ${newOnPage} new`);
  // Nothing new and we're into old territory — we've caught up.
  if (newOnPage === 0 && seenOld > 0) break;
  await sleep(400);
}

// Drop anything that has fallen outside the window.
for (const [id, rec] of Object.entries(store)) {
  if (rec.date && rec.date < CUTOFF) delete store[id];
}

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync(STORE, JSON.stringify(store, null, 0));
console.log(`added ${added}, store now holds ${Object.keys(store).length}`);
