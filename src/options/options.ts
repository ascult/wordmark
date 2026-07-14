import {
  getVocabList, removeWord, updateWord, exportJSON, importJSON, importCSV,
  getSettings, updateSettings,
} from "../background/storage.js";

let searchTerm = "";
let editingId: string | null = null;

async function renderList(): Promise<void> {
  const list = document.getElementById("vocab-list");
  const countEl = document.getElementById("word-count");
  if (!list || !countEl) return;

  const vocab = await getVocabList();
  const filtered = searchTerm
    ? vocab.filter(
        (e) =>
          e.word.includes(searchTerm) ||
          e.definition.includes(searchTerm)
      )
    : vocab;

  countEl.textContent = `共 ${vocab.length} 词`;

  list.innerHTML = filtered
    .map(
      (entry) => `
      <li class="vocab-item${editingId === entry.id ? " editing" : ""}" data-id="${entry.id}">
        <span class="word">${escapeHtml(entry.word)}</span>
        <span class="definition">${escapeHtml(entry.definition)}</span>
        <div class="actions">
          <button class="edit-btn">编辑</button>
          <button class="delete-btn">删除</button>
        </div>
      </li>
    `
    )
    .join("");

  list.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = (e.currentTarget as HTMLElement).closest(".vocab-item")?.getAttribute("data-id");
      if (id && confirm("确认删除？")) {
        await removeWord(id);
        renderList();
      }
    });
  });

  list.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const item = (e.currentTarget as HTMLElement).closest(".vocab-item") as HTMLElement;
      const id = item?.getAttribute("data-id");
      if (!id) return;
      editingId = editingId === id ? null : id;
      renderList();
      if (editingId === id) enterEditMode(id);
    });
  });
}

function enterEditMode(id: string): void {
  const item = document.querySelector(`.vocab-item[data-id="${id}"]`);
  if (!item) return;

  const wordEl = item.querySelector(".word");
  const defEl = item.querySelector(".definition");
  const actionsEl = item.querySelector(".actions");
  if (!wordEl || !defEl || !actionsEl) return;

  const wordInput = document.createElement("input");
  wordInput.className = "edit-input word-input";
  wordInput.value = wordEl.textContent || "";

  const defInput = document.createElement("input");
  defInput.className = "edit-input def-input";
  defInput.value = defEl.textContent || "";

  const saveBtn = document.createElement("button");
  saveBtn.className = "save-btn";
  saveBtn.textContent = "保存";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "cancel-btn";
  cancelBtn.textContent = "取消";

  wordEl.replaceWith(wordInput);
  defEl.replaceWith(defInput);
  actionsEl.innerHTML = "";
  actionsEl.appendChild(saveBtn);
  actionsEl.appendChild(cancelBtn);
  item.classList.add("editing");

  function save(): void {
    const newWord = wordInput.value.trim();
    const newDef = defInput.value.trim();
    if (newWord && newDef) {
      updateWord(id, { word: newWord, definition: newDef }).then(() => {
        editingId = null;
        renderList();
      });
    }
  }

  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", () => { editingId = null; renderList(); });
  wordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") defInput.focus();
    if (e.key === "Escape") { editingId = null; renderList(); }
  });
  defInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") { editingId = null; renderList(); }
  });
  defInput.focus();
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function renderDomainLists(): Promise<void> {
  const settings = await getSettings();
  renderDomainList("whitelist-list", settings.whitelist, "whitelist");
  renderDomainList("blacklist-list", settings.blacklist, "blacklist");
}

function renderDomainList(listId: string, domains: string[], key: "whitelist" | "blacklist"): void {
  const list = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = domains
    .map(
      (d) =>
        `<li class="domain-item">
          <span>${escapeHtml(d)}</span>
          <button class="domain-remove-btn" data-key="${key}" data-domain="${escapeHtml(d)}">删除</button>
        </li>`
    )
    .join("");

  list.querySelectorAll(".domain-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = (btn as HTMLElement).getAttribute("data-key") as "whitelist" | "blacklist";
      const domain = (btn as HTMLElement).getAttribute("data-domain") || "";
      const settings = await getSettings();
      settings[key] = settings[key].filter((d) => d !== domain);
      await updateSettings({ [key]: settings[key] });
      renderDomainLists();
    });
  });
}

function setupDomainInput(inputId: string, addBtnId: string, key: "whitelist" | "blacklist"): void {
  const input = document.getElementById(inputId) as HTMLInputElement;
  const addBtn = document.getElementById(addBtnId);

  async function addDomain(): Promise<void> {
    const domain = input.value.trim().toLowerCase();
    if (!domain) return;
    const settings = await getSettings();
    if (!settings[key].includes(domain)) {
      settings[key].push(domain);
      await updateSettings({ [key]: settings[key] });
    }
    input.value = "";
    renderDomainLists();
  }

  addBtn?.addEventListener("click", addDomain);
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addDomain();
  });
}

function init(): void {
  const searchInput = document.getElementById("search-input") as HTMLInputElement;
  searchInput?.addEventListener("input", (e) => {
    searchTerm = (e.target as HTMLInputElement).value.toLowerCase();
    editingId = null;
    renderList();
  });

  document.getElementById("export-btn")?.addEventListener("click", async () => {
    const vocab = await getVocabList();
    const json = exportJSON(vocab);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wordmark-vocab.json";
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("import-btn")?.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.csv";
    input.addEventListener("change", async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        await (file.name.endsWith(".csv") ? importCSV(text) : importJSON(text));
        renderList();
      } catch (err) {
        alert(`导入失败: ${err}`);
      }
    });
    input.click();
  });

  setupDomainInput("whitelist-input", "whitelist-add-btn", "whitelist");
  setupDomainInput("blacklist-input", "blacklist-add-btn", "blacklist");

  renderList();
  renderDomainLists();
}

init();
