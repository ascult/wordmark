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

  // Double final consonant + -ing/-ed for short words (at least 2 letters)
  if (word.length >= 2 && word.length <= 3 && /[^aeiou]$/.test(word)) {
    inflections.add(word + word[word.length - 1] + "ing");
    inflections.add(word + word[word.length - 1] + "ed");
  }

  return Array.from(inflections);
}
