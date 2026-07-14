import { readFileSync, writeFileSync } from "node:fs";

// ── Parse CET word lists from TS files ──
function parseWordList(filePath) {
  const src = readFileSync(filePath, "utf-8");
  const words = [];
  const re = /['"](\w+)['"]/g;
  let m;
  while ((m = re.exec(src))) words.push(m[1]);
  return words;
}

const cet4 = parseWordList("src/common/cet4.ts");
const cet6 = parseWordList("src/common/cet6.ts");
const allWords = [...new Set([...cet4, ...cet6])]; // deduplicate
console.log(`CET4: ${cet4.length}, CET6: ${cet6.length}, total: ${allWords.length}`);

// ── Helper: extract core Chinese words from definition ──
function extractCoreWords(fullDef, word) {
  const cleaned = fullDef.replace(
    /\b(v\.|vi\.|vt\.|n\.|adj\.|adv\.|prep\.|pron\.|conj\.|int\.|art\.|abbr\.|num\.|aux\.)\s*/gi,
    ""
  );
  const parts = cleaned
    .split(/[；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const wordLower = word.toLowerCase();
  const coreWords = [];
  const seen = new Set();

  for (const part of parts) {
    if (part.toLowerCase().includes(wordLower)) continue;
    if (/^[a-zA-Z]/.test(part)) continue;

    const stripped = part
      .replace(/[（(][^）)]*[）)]/g, "")
      .replace(/[，、]/g, "；")
      .replace(/\s+/g, "；")
      .trim();

    const words = stripped
      .split(/[；;]+/)
      .map((s) => s.trim())
      .filter((s) => /^[\u4e00-\u9fff]/.test(s));

    for (const w of words) {
      if (!seen.has(w)) {
        seen.add(w);
        coreWords.push(w);
      }
    }
  }

  return coreWords;
}

// ── Helper: parse definition from Youdao response ──
function parseDefinition(data) {
  try {
    return data?.ec?.word?.[0]?.trs?.[0]?.tr?.[0]?.l?.i?.[0];
  } catch {
    return undefined;
  }
}

// ── Fetch definition for a single word ──
async function fetchDef(word) {
  const url = `https://dict.youdao.com/jsonapi?jsonversion=2&client=mobile&q=${encodeURIComponent(word)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const def = parseDefinition(data);
  if (!def) throw new Error("Empty definition");
  return def;
}

// ── Load existing progress ──
const PROGRESS_FILE = "scripts/.dict-progress.json";
const OUTPUT_FILE = "src/common/dict.json";

let dict = {};
let completed = 0;

try {
  const saved = JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
  dict = saved.dict || {};
  completed = saved.completed || 0;
  console.log(`Resuming from ${completed} words already fetched`);
} catch {
  console.log("Starting fresh fetch");
}

// ── Main fetch loop ──
const BATCH_SIZE = 100;
const DELAY_MS = 150;

for (let i = completed; i < allWords.length; i++) {
  const word = allWords[i];

  if (dict[word]) {
    completed = i + 1;
    continue;
  }

  try {
    const def = await fetchDef(word);
    const cn = extractCoreWords(def, word);
    dict[word] = { def, cn };
  } catch (err) {
    console.error(`FAIL: ${word} — ${err.message}`);
    dict[word] = { def: "", cn: [] };
  }

  completed = i + 1;

  // Save progress periodically
  if ((i + 1) % BATCH_SIZE === 0 || i === allWords.length - 1) {
    writeFileSync(PROGRESS_FILE, JSON.stringify({ dict, completed }));
    writeFileSync(OUTPUT_FILE, JSON.stringify(dict, null, 0));
    const pct = (((i + 1) / allWords.length) * 100).toFixed(1);
    console.log(`[${i + 1}/${allWords.length} (${pct}%)] saved`);
  }

  await new Promise((r) => setTimeout(r, DELAY_MS));
}

console.log("Done! Dict saved to", OUTPUT_FILE);
