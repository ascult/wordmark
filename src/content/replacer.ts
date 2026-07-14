import type { VocabInfo } from "../common/types.js";
import { ANNOTATION_CLASS, ANNOTATION_STYLE } from "../common/constants.js";
import { walkTextNodes, TextNodeInfo } from "./dom-walker.js";
import { AhoCorasick, MatchResult } from "./matcher.js";
import { getWordBounds } from "./tokenizer.js";
import { STOP_WORDS } from "../common/stop-words.js";

const CHUNK_SIZE = 10;

export { ANNOTATION_CLASS };

export function replaceMatches(
  root: Node,
  matcher: AhoCorasick,
  vocabInfoMap: Map<string, VocabInfo>
): void {
  const textNodes = walkTextNodes(root);

  if (textNodes.length === 0) return;

  let index = 0;

  function processChunk(): void {
    const end = Math.min(index + CHUNK_SIZE, textNodes.length);
    for (let i = index; i < end; i++) {
      const { node, text } = textNodes[i];
      const bounds = getWordBounds(text);
      const matches = matcher
        .search(text.toLowerCase(), bounds)
        .filter((m) => !STOP_WORDS.has(m.word));
      if (matches.length === 0) continue;
      applyMatchToNode(node, text, matches, vocabInfoMap);
    }
    index = end;

    if (index < textNodes.length) {
      if (typeof requestIdleCallback !== "undefined") {
        requestIdleCallback(processChunk, { timeout: 50 });
      } else {
        setTimeout(processChunk, 0);
      }
    }
  }

  processChunk();
}

function applyMatchToNode(
  node: Text,
  text: string,
  matches: MatchResult[],
  vocabInfoMap: Map<string, VocabInfo>
): void {
  const parts: (string | HTMLElement)[] = [];
  let lastIndex = 0;

  const sorted = [...matches].sort((a, b) => a.index - b.index);
  const merged = mergeOverlapping(sorted);

  for (const match of merged) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const info = vocabInfoMap.get(match.word);
    if (info) {
      const originalText = text.slice(match.index, match.endIndex);
      const mark = createAnnotatedElement(originalText, info.definition);
      parts.push(mark);
    }
    lastIndex = match.endIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  const fragment = document.createDocumentFragment();
  for (const part of parts) {
    fragment.appendChild(typeof part === "string" ? document.createTextNode(part) : part);
  }
  node.parentNode?.replaceChild(fragment, node);
}

function mergeOverlapping(matches: MatchResult[]): MatchResult[] {
  if (matches.length === 0) return [];
  const result: MatchResult[] = [matches[0]];
  for (let i = 1; i < matches.length; i++) {
    const prev = result[result.length - 1];
    if (matches[i].index <= prev.endIndex) {
      if (matches[i].endIndex > prev.endIndex) {
        result[result.length - 1] = matches[i];
      }
    } else {
      result.push(matches[i]);
    }
  }
  return result;
}

function createAnnotatedElement(
  original: string,
  definition?: string
): HTMLElement {
  const el = document.createElement("mark");
  el.className = ANNOTATION_CLASS;
  el.setAttribute("data-original", original);
  el.style.cssText = ANNOTATION_STYLE;
  el.textContent = definition ? `${original}(${definition})` : original;
  return el;
}
