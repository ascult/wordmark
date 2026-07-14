import type { VocabularyEntry } from "../common/types.js";
import { generateInflections } from "./inflector.js";

interface ACNode {
  children: Map<string, ACNode>;
  fail: ACNode | null;
  output: string[];
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
        node.output.push(baseWord);
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

  search(text: string): MatchResult[] {
    const results: MatchResult[] = [];
    let node = this.root;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      while (node !== this.root && !node.children.has(ch)) {
        node = node.fail!;
      }
      node = node.children.get(ch) || this.root;

      if (node.output.length > 0) {
        for (const word of node.output) {
          results.push({
            word,
            index: i - word.length + 1,
            endIndex: i + 1,
          });
        }
      }
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
