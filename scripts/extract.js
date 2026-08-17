/**
 * Text extraction, kept separate so it can be tested on its own:
 *   node scripts/extract.test.js
 */

/* ---------- text helpers ------------------------------------------------ */

export function stripHtml(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&rsquo;|&#8217;/g, "'")
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/g, '"')
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const ABBR = /\b(Mr|Mrs|Ms|Dr|Jr|Sr|St|No|Nos|Inc|Corp|Ltd|Co|Assn|Dept|Gov|Sen|Rep|Atty|Hon|Sgt|Lt|Col|Capt|Det|vs|v)\./gi;

/** Splits into sentences without breaking on initials ("Judge B. Lynn Winmill") or "U.S." */
export function sentences(text) {
  const marked = text.replace(ABBR, (m) => m.slice(0, -1) + "\u0000");
  return marked
    .split(/(?<=[^A-Z][.!?])\s+(?=[A-Z\u201C"(])/g)
    .map((s) => s.replace(/\u0000/g, ".").trim())
    .filter(Boolean);
}

/**
 * Finds the sentence that states the punishment and, where the wording is
 * unambiguous, parses it into a number of months. Anything it can't parse
 * confidently is left null rather than guessed at.
 */
export function extractSentence(text) {
  const hit = sentences(text).find(
    (s) => /\bsentenc(?:ed|e of)\b/i.test(s) && /\bto\b/i.test(s)
  );
  if (!hit) return null;

  const raw = hit.length > 260 ? hit.slice(0, 257) + "…" : hit;

  // Read only the stretch after "sentenced", so an opening "According to court
  // documents" can't hijack the number.
  const from = hit.search(/\bsentenc/i);
  const rel = hit.slice(from).search(/\bto\b/i);
  if (rel === -1) return null;
  const window = hit.slice(from + rel, from + rel + 90);

  let months = null;
  let label = null;

  if (/\blife\b/i.test(window)) {
    label = "Life in prison";
  } else {
    // Take whichever unit appears first, so "60 months for a scheme that ran
    // three years" doesn't get read as a three-year sentence.
    const ym = window.match(/(\d{1,3})\s*years?(?:\s*(?:and|,)\s*(\d{1,2})\s*months?)?/i);
    const mo = window.match(/(\d{1,4})\s*months?/i);
    const yi = ym ? ym.index : Infinity;
    const mi = mo ? mo.index : Infinity;
    if (yi <= mi && ym) months = Number(ym[1]) * 12 + Number(ym[2] || 0);
    else if (mo) months = Number(mo[1]);

    if (months !== null) {
      const y = Math.floor(months / 12);
      const m = months % 12;
      label =
        (y ? `${y} year${y === 1 ? "" : "s"}` : "") +
        (y && m ? " " : "") +
        (m ? `${m} month${m === 1 ? "" : "s"}` : "");
      label = label.trim() + " in prison";
    } else if (/\bprobation\b/i.test(window)) {
      label = "Probation";
    } else if (/\btime served\b/i.test(window)) {
      label = "Time served";
    }
  }

  return { raw, months, label };
}

/** The paragraph prosecutors use to lay out the facts. */
export function extractFacts(text) {
  const s = sentences(text);
  const start = s.findIndex((x) =>
    /according to (court|the) (documents|records|filings)/i.test(x)
  );
  const picked = start === -1 ? s.slice(0, 2) : s.slice(start, start + 3);
  const out = picked.join(" ");
  return out.length > 420 ? out.slice(0, 417) + "…" : out;
}

export function districtOf(components) {
  if (!Array.isArray(components)) return null;
  const usao = components.find((c) => /^USAO\s*-\s*/i.test(c?.name || ""));
  return usao ? usao.name.replace(/^USAO\s*-\s*/i, "").trim() : null;
}

export function distill(r, { onlySentenced = true } = {}) {
  const body = stripHtml(r.body) || stripHtml(r.teaser);
  if (!body) return null;
  const sentence = extractSentence(body);
  if (onlySentenced && !sentence) return null;

  return {
    id: r.uuid,
    title: stripHtml(r.title),
    url: r.url,
    date: Number(r.date) || null,
    district: districtOf(r.component),
    topics: Array.isArray(r.topic) ? r.topic.map((t) => t.name) : [],
    facts: extractFacts(body),
    sentenceRaw: sentence?.raw || null,
    sentenceLabel: sentence?.label || null,
    months: sentence?.months ?? null,
    charged: /\bindict|\bcharged with\b/i.test(body),
    pleaded: /\bpleaded guilty\b/i.test(body),
    convicted: /\bconvicted\b|\bfound guilty\b/i.test(body),
  };
}

