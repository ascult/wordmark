import { normalizeWord } from "../common/utils.js";
import { translate } from "./translator.js";
import { addWord } from "./storage.js";

export function createContextMenu(): void {
  chrome.contextMenus.create({
    id: "add-to-wordmark",
    title: "添加到单词本",
    contexts: ["selection"],
  });
}

export async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): Promise<void> {
  if (info.menuItemId !== "add-to-wordmark" || !info.selectionText) return;

  const word = normalizeWord(info.selectionText);

  try {
    const definition = await translate(word);
    await addWord(word, definition);

    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: "vocab-updated" }).catch(() => {});
    }
  } catch (err) {
    console.error("Failed to add word:", err);
  }
}
