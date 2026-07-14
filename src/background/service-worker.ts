import { createContextMenu, handleContextMenuClick } from "./context-menu.js";
import { getSettings, updateSettings } from "./storage.js";
import { translate, batchTranslate } from "./translator.js";

chrome.runtime.onInstalled.addListener(() => {
  try {
    createContextMenu();
  } catch (err) {
    console.error("Failed to create context menu:", err);
  }
});

chrome.contextMenus.onClicked.addListener(handleContextMenuClick);

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command !== "toggle-replacement") return;
    const settings = await getSettings();
    const enabled = !settings.enabled;
    await updateSettings({ enabled });

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs
          .sendMessage(tab.id, { type: "toggle-replace", payload: enabled })
          .catch(() => {});
      }
    }
  } catch (err) {
    console.error("Command handler failed:", err);
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: { type: string; word?: string; words?: string[]; pageText?: string },
    _sender,
    sendResponse
  ) => {
    if (message.type === "fetch-translation" && message.word) {
      translate(message.word)
        .then((definition) => sendResponse({ definition }))
        .catch(() => sendResponse({ definition: undefined }));
      return true;
    }

    if (
      message.type === "batch-translate" &&
      message.words &&
      message.words.length > 0 &&
      message.segments &&
      message.segments.length > 0
    ) {
      batchTranslate(message.words, message.segments)
        .then((definitions) => sendResponse({ definitions }))
        .catch(() => sendResponse({ definitions: {} }));
      return true;
    }
  }
);

console.log("wordmark service worker loaded");
