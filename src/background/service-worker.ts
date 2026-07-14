import { createContextMenu, handleContextMenuClick } from "./context-menu.js";
import { getSettings, updateSettings } from "./storage.js";

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

console.log("wordmark service worker loaded");
