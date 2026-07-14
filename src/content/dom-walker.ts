import type { Settings } from "../common/types.js";
import { ANNOTATION_CLASS } from "../common/constants.js";

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT",
  "OPTION", "SVG", "PATH", "NOSCRIPT",
]);

export interface TextNodeInfo {
  node: Text;
  text: string;
}

export function walkTextNodes(root: Node): TextNodeInfo[] {
  const result: TextNodeInfo[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest(`.${ANNOTATION_CLASS}`)) return NodeFilter.FILTER_REJECT;
      if (getComputedStyle(parent).visibility === "hidden")
        return NodeFilter.FILTER_REJECT;
      if (getComputedStyle(parent).display === "none")
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const text = node.textContent || "";
    if (text.trim().length > 0) {
      result.push({ node, text });
    }
  }

  return result;
}

export function isDomainAllowed(settings: Settings): boolean {
  const hostname = window.location.hostname;

  if (settings.whitelist.length > 0) {
    return settings.whitelist.some((d) => hostname === d || hostname.endsWith("." + d));
  }

  if (settings.blacklist.length > 0) {
    return !settings.blacklist.some((d) => hostname === d || hostname.endsWith("." + d));
  }

  return true;
}
