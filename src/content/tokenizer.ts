export interface WordBound {
  start: number;
  end: number;
}

const segmenter = new Intl.Segmenter("en", { granularity: "word" });

export function getWordBounds(text: string): WordBound[] {
  const bounds: WordBound[] = [];
  for (const { index, segment, isWordLike } of segmenter.segment(text)) {
    if (isWordLike) {
      bounds.push({ start: index, end: index + segment.length });
    }
  }
  return bounds;
}
