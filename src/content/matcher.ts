import type { VocabularyEntry } from "../common/types.js";
import { generateInflections } from "./inflector.js";
import type { WordBound } from "./tokenizer.js";

interface ACOutput {
  word: string;
  variantLen: number;
}

interface ACNode {
  children: Map<string, ACNode>;
  fail: ACNode | null;
  output: ACOutput[];
}

export interface MatchResult {
  word: string;
  index: number;
  endIndex: number;
}

export class AhoCorasick {
  private root: ACNode;

  constructor(patterns: Map<string, string[]>) {
    this.root = { children: new Map(), fail: null, output: [] };
    this.buildTrie(patterns);
    this.buildFail();
  }

  private buildTrie(patterns: Map<string, string[]>): void {
    for (const [baseWord, variants] of patterns) {
      for (const variant of variants) {
        let node = this.root;
        for (const ch of variant) {
          if (!node.children.has(ch)) {
            node.children.set(ch, {
              children: new Map(),
              fail: null,
              output: [],
            });
          }
          node = node.children.get(ch)!;
        }
        node.output.push({ word: baseWord, variantLen: variant.length });
      }
    }
  }

  private buildFail(): void {
    const queue: ACNode[] = [];
    for (const child of this.root.children.values()) {
      child.fail = this.root;
      queue.push(child);
    }
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const [ch, child] of node.children) {
        let fail = node.fail;
        while (fail && !fail.children.has(ch)) {
          fail = fail.fail;
        }
        child.fail = fail ? fail.children.get(ch)! : this.root;
        child.output.push(...child.fail.output);
        queue.push(child);
      }
    }
  }

  search(text: string, wordBounds?: WordBound[]): MatchResult[] {
    const results: MatchResult[] = [];
    let node = this.root;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      while (node !== this.root && !node.children.has(ch)) {
        node = node.fail!;
      }
      node = node.children.get(ch) || this.root;

      if (node.output.length > 0) {
        for (const { word, variantLen } of node.output) {
          results.push({
            word,
            index: i - variantLen + 1,
            endIndex: i + 1,
          });
        }
      }
    }

    if (wordBounds) {
      return results.filter((match) =>
        wordBounds.some(
          (bound) => match.index === bound.start && match.endIndex === bound.end
        )
      );
    }

    return results;
  }
}

export function buildMatcher(vocabList: VocabularyEntry[]): AhoCorasick {
  const patterns = new Map<string, string[]>();
  for (const entry of vocabList) {
    patterns.set(entry.word, generateInflections(entry.word));
  }
  return new AhoCorasick(patterns);
}
