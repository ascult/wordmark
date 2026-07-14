export function generateInflections(word: string): string[] {
  const inflections = new Set<string>([word]);

  // Plural / third person singular: -s
  inflections.add(word + "s");

  // -es (words ending in s, x, z, ch, sh, o)
  if (/[szx]$/.test(word)) {
    inflections.add(word + "es");
  }
  if (/[cs]h$/.test(word)) {
    inflections.add(word + "es");
  }
  if (/o$/.test(word)) {
    inflections.add(word + "es");
  }

  // -ies (consonant + y)
  if (/[^aeiou]y$/.test(word)) {
    inflections.add(word.slice(0, -1) + "ies");
  }

  // Past tense: -ed
  inflections.add(word + "ed");

  // -ied (consonant + y)
  if (/[^aeiou]y$/.test(word)) {
    inflections.add(word.slice(0, -1) + "ied");
  }

  // -d (words ending in e)
  if (/e$/.test(word)) {
    inflections.add(word + "d");
  }

  // Present participle: -ing
  inflections.add(word + "ing");

  // -ly adverb
  if (word.endsWith("le")) {
    inflections.add(word.slice(0, -2) + "ly");
  } else if (word.endsWith("e")) {
    inflections.add(word.slice(0, -1) + "ly");
  } else {
    inflections.add(word + "ly");
  }

  // Double final consonant + -ing/-ed for short words (at least 2 letters)
  if (word.length >= 2 && word.length <= 3 && /[^aeiou]$/.test(word)) {
    inflections.add(word + word[word.length - 1] + "ing");
    inflections.add(word + word[word.length - 1] + "ed");
  }

  return Array.from(inflections);
}

// Derivational suffixes: [suffix, lettersToAddBack]
// e.g. "independence" → strip "ence" → "independ" → + "ent" → "independent"
const DERIVATIONS: [string, string][] = [
  ["ness", ""],
  ["ment", ""],
  ["tion", "e"],
  ["sion", "e"],
  ["ation", "e"],
  ["ition", "e"],
  ["ution", "e"],
  ["ance", "e"],
  ["ence", "t"],
  ["ency", "t"],
  ["ancy", "t"],
  ["ity", "e"],
  ["able", "e"],
  ["ible", "e"],
  ["al", ""],
  ["ical", "ic"],
  ["ic", ""],
  ["ive", "e"],
  ["ous", ""],
  ["ful", ""],
  ["less", ""],
  ["ist", ""],
  ["ism", ""],
  ["ship", ""],
  ["ize", "e"],
  ["ise", "e"],
  ["ify", "y"],
  ["er", ""],
  ["or", "e"],
  ["est", "e"],
];

export function generateDerivations(word: string): string[] {
  const results: string[] = [];

  for (const [suffix, add] of DERIVATIONS) {
    if (word.length <= suffix.length + 1) continue;
    const derived = word + suffix;
    results.push(derived);
    results.push(derived + "s");

    // For words ending in e, drop the e before adding suffix
    if (word.endsWith("e")) {
      const dropped = word.slice(0, -1) + suffix;
      if (dropped !== derived) {
        results.push(dropped);
        results.push(dropped + "s");
      }
    }
  }

  return results;
}

export function resolveDerivedWord(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const [suffix, add] of DERIVATIONS) {
    if (lower.endsWith(suffix) && lower.length > suffix.length + 2) {
      const base = lower.slice(0, -suffix.length) + add;
      if (base.length >= 2) return base;
    }
    if (lower.endsWith(suffix + "s") && lower.length > suffix.length + 3) {
      const base = lower.slice(0, -suffix.length - 1) + add;
      if (base.length >= 2) return base;
    }
  }
  return undefined;
}
