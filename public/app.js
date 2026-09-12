const CLASS_OPTIONS = {
  Cattle: { Female: ["Cow", "Heifer", "Heifer calf", "Calf"], Male: ["Bull", "Bull calf", "Steer", "Ox", "Calf"] },
  Sheep: { Female: ["Ewe", "Ewe lamb", "Lamb"], Male: ["Ram", "Ram lamb", "Wether", "Lamb"] },
  Goat: { Female: ["Doe", "Doe kid", "Kid"], Male: ["Buck", "Buck kid", "Wether", "Kid"] }
};
const BREEDING_CLASSES = { Cattle: "Bull", Sheep: "Ram", Goat: "Buck" };
const icons = { Cattle: "🐄", Sheep: "🐑", Goat: "🐐" };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

let user = null;
let animals = [];
let activeSpecies = "All";
let selectedRecords = new Set();
let syncing = false;

const tokenKey = "tfnn:access-token";
const refreshKey = "tfnn:refresh-token";
const cacheKey = () => `tfnn:${user?.user_id}:animals`;
const queueKey = () => `tfnn:${user?.user_id}:offline-queue`;
const metaKey = () => `tfnn:${user?.user_id}:meta`;

function accessToken() { return sessionStorage.getItem(tokenKey); }
function getQueue() { try { return JSON.parse(localStorage.getItem(queueKey()) || "[]"); } catch { return []; } }
function setQueue(queue) { localStorage.setItem(queueKey(), JSON.stringify(queue)); renderOffline(); }
function getMeta() { try { return JSON.parse(localStorage.getItem(metaKey()) || "{}"); } catch { return {}; } }
function setMeta(patch) { localStorage.setItem(metaKey(), JSON.stringify({ ...getMeta(), ...patch })); }

async function refreshAccessToken() {
  const refresh_token = sessionStorage.getItem(refreshKey);
  if (!refresh_token) return false;
  const response = await fetch("/api/v1/auth/refresh", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token })
  });
  if (!response.ok) return false;
  const data = await response.json();
  sessionStorage.setItem(tokenKey, data.token);
  return true;
}

async function api(path, options = {}, allowRefresh = true) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(accessToken() ? { Authorization: `Bearer ${accessToken()}` } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 401 && allowRefresh && await refreshAccessToken()) return api(path, options, false);
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}

function animalId(animal) { return String(animal.animal_id); }
function animalSex(animal) {
  if (animal.sex) return animal.sex;
  const female = Object.values(CLASS_OPTIONS[animal.species]?.Female || []).includes(animal.class);
  const male = Object.values(CLASS_OPTIONS[animal.species]?.Male || []).includes(animal.class);
  return female && !male ? "Female" : male && !female ? "Male" : "Unknown";
}
function isBreedingMale(animal) { return animalSex(animal) === "Male" && BREEDING_CLASSES[animal.species] === animal.class; }
function breedingLabel(animal) { return isBreedingMale(animal) ? `Breeding ${animal.class.toLowerCase()}` : "Not breeding male"; }
function findAnimal(id) { return animals.find((animal) => animalId(animal) === String(id)); }

async function handleLogin(event) {
  event.preventDefault();
  const button = $("#loginButton");
  button.disabled = true; button.textContent = "Signing in…";
  $("#loginError").hidden = true;
  try {
    const data = await api("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: $("#loginPhone").value.trim(), password: $("#loginPassword").value })
    }, false);
    if (data.user.role !== "farmer" && data.user.role !== "admin") throw new Error("This portal is available to farmer accounts.");
    sessionStorage.setItem(tokenKey, data.token);
    sessionStorage.setItem(refreshKey, data.refresh_token);
    user = data.user;
    await enterPortal();
  } catch (error) {
    $("#loginView").hidden = false;
    $("#appView").hidden = true;
    $("#loginError").textContent = error.message;
    $("#loginError").hidden = false;
  } finally {
    button.disabled = false; button.textContent = "Sign in to farmer portal";
  }
}

async function restoreSession() {
  if (!accessToken()) return;
  try {
    const data = await api("/api/v1/auth/me");
    user = data.user;
    await enterPortal();
  } catch { signOut(false); }
}

async function enterPortal() {
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  $("#farmName").textContent = user.farm_location || `${user.name}'s Farm`;
  await loadAnimals();
  showView("herd");
  if (navigator.onLine) syncQueue();
}

function signOut(showMessage = true) {
  sessionStorage.removeItem(tokenKey);
  sessionStorage.removeItem(refreshKey);
  user = null; animals = []; selectedRecords.clear();
  $("#appView").hidden = true;
  $("#loginView").hidden = false;
  $("#loginForm").reset();
  $(".sidebar").classList.remove("open");
  if (showMessage) showToast("Signed out safely");
}

async function loadAnimals() {
  try {
    const data = await api("/api/v1/animals");
    animals = data.animals || [];
    localStorage.setItem(cacheKey(), JSON.stringify(animals));
    setMeta({ lastSync: new Date().toISOString() });
  } catch (error) {
    const cached = localStorage.getItem(cacheKey());
    if (!cached) throw error;
    animals = JSON.parse(cached);
    showToast("Showing the last saved offline copy");
  }
  renderAll();
}

function saveLocalCopy() { localStorage.setItem(cacheKey(), JSON.stringify(animals)); setMeta({ lastLocalChange: new Date().toISOString() }); }

function enqueue(method, id, body) {
  const queue = getQueue();
  if (String(id).startsWith("offline-")) {
    const pendingCreate = queue.find((item) => item.method === "POST" && item.local_id === id);
    if (pendingCreate) pendingCreate.body = { ...pendingCreate.body, ...body };
    else queue.push({ method, id, body, queued_at: new Date().toISOString() });
  } else {
    queue.push({ method, id, body, queued_at: new Date().toISOString() });
  }
  setQueue(queue);
}

async function syncQueue() {
  if (syncing || !user || !navigator.onLine) return;
  const queuedAtStart = getQueue();
  if (!queuedAtStart.length) return;
  syncing = true; updateConnection();
  try {
    const remaining = [...queuedAtStart];
    while (remaining.length) {
      const item = remaining[0];
      if (item.method === "POST") await api("/api/v1/animals", { method: "POST", body: JSON.stringify(item.body) });
      else await api(`/api/v1/animals/${item.id}`, { method: "PATCH", body: JSON.stringify(item.body) });
      remaining.shift();
      // Remove each successful request immediately so a later failure cannot
      // cause an already-created animal to be submitted twice.
      setQueue(remaining);
    }
    await loadAnimals();
    showToast(`${queuedAtStart.length} offline change${queuedAtStart.length === 1 ? "" : "s"} synced`);
  } catch (error) { showToast(`Sync paused: ${error.message}`); }
  finally { syncing = false; updateConnection(); }
}

function showView(view) {
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.id === `${view}View`));
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $(".sidebar").classList.remove("open");
  if (view === "breeding") renderBreeding();
  if (view === "offline") renderOffline();
}

function renderAll() {
  if (!user) return;
  renderStats(); renderSpeciesTabs(); renderClassFilter(); renderRecords(); renderBreeding(); renderOffline();
  const updated = getMeta().lastSync || getMeta().lastLocalChange;
  $("#updatedLabel").textContent = updated ? `Records updated ${new Date(updated).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : "Ready for your first record";
}

function renderStats() {
  const active = animals.filter((animal) => animal.status === "Active");
  const data = [
    { label: "Total livestock", value: active.length, icon: "◎", featured: true },
    { label: "Cattle", value: active.filter((a) => a.species === "Cattle").length, icon: icons.Cattle },
    { label: "Sheep", value: active.filter((a) => a.species === "Sheep").length, icon: icons.Sheep },
    { label: "Goats", value: active.filter((a) => a.species === "Goat").length, icon: icons.Goat }
  ];
  $("#statGrid").innerHTML = data.map((stat) => `<article class="stat-card ${stat.featured ? "featured" : ""}"><div class="stat-icon">${stat.icon}</div><strong>${stat.value}</strong><small>${stat.label}</small><span class="accent"></span></article>`).join("");
}

function renderSpeciesTabs() {
  $("#speciesTabs").innerHTML = ["All", "Cattle", "Sheep", "Goat"].map((species) => `<button class="tab ${activeSpecies === species ? "active" : ""}" data-species="${species}" role="tab">${species === "Goat" ? "Goats" : species}</button>`).join("");
  $$("[data-species]").forEach((button) => button.addEventListener("click", () => { activeSpecies = button.dataset.species; renderSpeciesTabs(); renderClassFilter(); renderRecords(); }));
}

function renderClassFilter() {
  const previous = $("#recordClass").value;
  const classes = [...new Set(animals.filter((animal) => activeSpecies === "All" || animal.species === activeSpecies).map((animal) => animal.class).filter(Boolean))].sort();
  $("#recordClass").innerHTML = `<option>All</option>${classes.map((value) => `<option>${safe(value)}</option>`).join("")}`;
  if (classes.includes(previous)) $("#recordClass").value = previous;
}

function visibleRecords() {
  const query = $("#recordSearch").value.trim().toLowerCase();
  const classFilter = $("#recordClass").value;
  const status = $("#recordStatus").value;
  const breedingOnly = $("#breedingOnly").checked;
  const records = animals.filter((animal) =>
    (activeSpecies === "All" || animal.species === activeSpecies) &&
    (classFilter === "All" || animal.class === classFilter) &&
    (status === "All" || animal.status === status) &&
    (!breedingOnly || isBreedingMale(animal)) &&
    (!query || [animal.tag_number, animal.name, animal.breed, animal.class, animal.stock_brand].some((value) => String(value || "").toLowerCase().includes(query)))
  );
  const sort = $("#recordSort").value;
  return [...records].sort((a, b) => sort === "updated"
    ? String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at))
    : sort === "species"
      ? a.species.localeCompare(b.species) || a.tag_number.localeCompare(b.tag_number, undefined, { numeric: true })
      : a.tag_number.localeCompare(b.tag_number, undefined, { numeric: true }));
}

function renderRecords() {
  const records = visibleRecords();
  $("#recordCount").textContent = `${records.length} ${records.length === 1 ? "animal" : "animals"} shown`;
  $("#recordsBody").innerHTML = records.map((animal) => `
    <tr>
      <td><input class="record-check" type="checkbox" data-select="${animalId(animal)}" aria-label="Select ${safe(animal.tag_number)}" ${selectedRecords.has(animalId(animal)) ? "checked" : ""}></td>
      <td><div class="animal-cell"><span class="animal-avatar">${icons[animal.species]}</span><span><strong>${safe(animal.name || animal.tag_number)}</strong><small>${animal.name ? safe(animal.tag_number) : "Ear tag"} · <span class="health-${safe((animal.health_status || "Healthy").toLowerCase().replaceAll(" ", "-"))}">${safe(animal.health_status || "Healthy")}</span></small></span></div></td>
      <td><span class="species-chip">${safe(animal.species)}</span></td><td>${safe(animal.class || "Not classified")}</td>
      <td>${safe(animal.breed || "—")}<small class="table-subline">${safe(animal.registration_status || "Registered")}</small></td>
      <td>${isBreedingMale(animal) ? `<span class="role-chip">${safe(breedingLabel(animal))}</span>` : `<span class="muted">—</span>`}</td>
      <td><span class="${animal.status === "Active" ? "role-chip" : "status-chip"}">${safe(animal.status)}</span></td>
      <td><button class="row-button" data-edit="${animalId(animal)}">Edit</button></td>
    </tr>`).join("");
  $("#emptyRecords").hidden = records.length > 0;
  const selectAll = $("#selectAllRecords");
  selectAll.checked = records.length > 0 && records.every((record) => selectedRecords.has(animalId(record)));
  selectAll.indeterminate = records.some((record) => selectedRecords.has(animalId(record))) && !selectAll.checked;
  $$("[data-edit]").forEach((button) => button.addEventListener("click", () => openAnimalDialog(button.dataset.edit)));
  $$("[data-select]").forEach((checkbox) => checkbox.addEventListener("change", () => { checkbox.checked ? selectedRecords.add(checkbox.dataset.select) : selectedRecords.delete(checkbox.dataset.select); renderBulkBar(); }));
  renderBulkBar();
}

function renderBulkBar() {
  selectedRecords = new Set([...selectedRecords].filter((id) => findAnimal(id)));
  $("#bulkBar").hidden = selectedRecords.size === 0;
  $("#selectedCount").textContent = `${selectedRecords.size} selected`;
}

function renderBreeding() {
  if (!user) return;
  const species = $("#breedingSpecies").value;
  const males = animals.filter((animal) => isBreedingMale(animal) && animal.status === "Active" && (species === "All" || animal.species === species));
  $("#breedingList").innerHTML = males.length ? males.map((animal) => `<article class="breeding-card"><span class="breeding-avatar">${icons[animal.species]}</span><span><strong>${safe(animal.name || animal.tag_number)}</strong><small>${safe(animal.tag_number)} · ${safe(animal.breed || "Breed not recorded")}</small></span><span class="role-chip">${safe(animal.class)}</span></article>`).join("") : `<div class="empty-state"><span>♢</span><h4>No confirmed breeding males</h4><p>Classify an adult male as ${species === "All" ? "Bull, Ram, or Buck" : BREEDING_CLASSES[species]} to include it.</p></div>`;
  renderPedigreeOptions();
}

function renderPedigreeOptions() {
  const species = $("#pedigreeSpecies").value;
  const options = animals.filter((animal) => species === "All" || animal.species === species).sort((a, b) => a.tag_number.localeCompare(b.tag_number, undefined, { numeric: true }));
  const previous = $("#pedigreeAnimal").value;
  $("#pedigreeAnimal").innerHTML = options.map((animal) => `<option value="${animalId(animal)}">${safe(animal.tag_number)} · ${safe(animal.name || animal.class || "Unclassified")}</option>`).join("");
  if (options.some((animal) => animalId(animal) === previous)) $("#pedigreeAnimal").value = previous;
  renderPedigree();
}

function nodeMarkup(animal, fallback, extraClass = "") {
  return `<div class="tree-node ${extraClass}"><strong>${safe(animal ? (animal.name || animal.tag_number) : fallback)}</strong><small>${animal ? `${safe(animal.tag_number)} · ${safe(animal.class || "Unclassified")}` : "Not recorded"}</small></div>`;
}

function closeRelationWarning(fatherId, motherId) {
  const father = findAnimal(fatherId), mother = findAnimal(motherId);
  if (!father || !mother) return "Add both parents to run a close-relation check.";
  const fatherParents = [father.father_id, father.mother_id].filter(Boolean).map(String);
  const motherParents = [mother.father_id, mother.mother_id].filter(Boolean).map(String);
  if (fatherParents.some((id) => motherParents.includes(id))) return "Warning: sire and dam share a recorded parent.";
  if ([father.father_id, father.mother_id].map(String).includes(animalId(mother)) || [mother.father_id, mother.mother_id].map(String).includes(animalId(father))) return "Warning: a parent–offspring relationship is recorded.";
  return "No close relationship found in the recorded pedigree.";
}

function renderPedigree() {
  const animal = findAnimal($("#pedigreeAnimal").value);
  if (!animal) { $("#pedigreeTree").innerHTML = `<div class="empty-state"><span>⌁</span><h4>No animal selected</h4></div>`; return; }
  const sire = findAnimal(animal.father_id), dam = findAnimal(animal.mother_id);
  const offspring = animals.filter((entry) => String(entry.father_id) === animalId(animal) || String(entry.mother_id) === animalId(animal));
  const relation = closeRelationWarning(animal.father_id, animal.mother_id);
  $("#pedigreeTree").innerHTML = `<div class="tree-layout">${nodeMarkup(sire, "Sire unknown", "tree-parent sire")}${nodeMarkup(dam, "Dam unknown", "tree-parent dam")}<div class="tree-lines"></div>${nodeMarkup(animal, "", "focus")}<div class="offspring-row"><strong>${offspring.length} recorded offspring:</strong> ${offspring.length ? offspring.map((entry) => safe(entry.tag_number)).join(", ") : "None in this farmer record"}<span class="relation-result ${relation.startsWith("Warning") ? "relation-warning" : "relation-ok"}">${safe(relation)}</span></div></div>`;
}

function renderOffline() {
  if (!user) return;
  const meta = getMeta(), queue = getQueue();
  $("#offlineFarmer").textContent = user.farm_location || user.name;
  $("#offlineCount").textContent = String(animals.length);
  $("#pendingChanges").textContent = String(queue.length);
  $("#lastBackup").textContent = meta.lastBackup ? new Date(meta.lastBackup).toLocaleDateString([], { dateStyle: "medium" }) : "Not yet";
  $("#offlineStatusBadge").textContent = navigator.onLine ? (queue.length ? "Online · sync pending" : "Online · synced") : "Offline · local save active";
}

function updateClassOptions(preferred = "") {
  const options = CLASS_OPTIONS[$("#animalSpecies").value][$("#animalSex").value];
  $("#animalClass").innerHTML = options.map((value) => `<option>${value}</option>`).join("");
  if (options.includes(preferred)) $("#animalClass").value = preferred;
}

function updateParentOptions(currentId = "", fatherId = "", motherId = "") {
  const species = $("#animalSpecies").value;
  const candidates = animals.filter((animal) => animal.species === species && animalId(animal) !== String(currentId) && animal.status === "Active");
  const blank = `<option value="">Not recorded</option>`;
  $("#animalSire").innerHTML = blank + candidates.filter(isBreedingMale).map((animal) => `<option value="${animalId(animal)}">${safe(animal.tag_number)} · ${safe(animal.name || animal.class)}</option>`).join("");
  $("#animalDam").innerHTML = blank + candidates.filter((animal) => animalSex(animal) === "Female").map((animal) => `<option value="${animalId(animal)}">${safe(animal.tag_number)} · ${safe(animal.name || animal.class)}</option>`).join("");
  $("#animalSire").value = String(fatherId || ""); $("#animalDam").value = String(motherId || ""); updatePedigreeCheck();
}

function updatePedigreeCheck() {
  const message = closeRelationWarning($("#animalSire").value, $("#animalDam").value);
  $("#pedigreeCheck").textContent = message;
  $("#pedigreeCheck").classList.toggle("warning", message.startsWith("Warning"));
}

function openAnimalDialog(id = "") {
  const animal = findAnimal(id);
  $("#animalForm").reset(); $("#formError").hidden = true;
  $("#dialogTitle").textContent = animal ? "Edit animal" : "Add animal";
  $("#animalId").value = animal ? animalId(animal) : "";
  $("#animalTag").value = animal?.tag_number || ""; $("#animalName").value = animal?.name || "";
  $("#animalSpecies").value = animal?.species || "Cattle";
  const existingSex = animal ? animalSex(animal) : "Female";
  $("#animalSex").value = existingSex === "Unknown" ? "Female" : existingSex;
  updateClassOptions(animal?.class || "");
  $("#animalBreed").value = animal?.breed || ""; $("#animalBirth").value = String(animal?.date_of_birth || "").slice(0, 10);
  $("#animalStatus").value = animal?.status || "Active"; $("#animalBrand").value = animal?.stock_brand || "";
  $("#animalRegistration").value = animal?.registration_status || "Registered"; $("#animalHealth").value = animal?.health_status || "Healthy";
  $("#animalCondition").value = animal?.condition_score || ""; $("#animalNotes").value = animal?.notes || "";
  updateParentOptions(animal ? animalId(animal) : "", animal?.father_id, animal?.mother_id);
  $("#animalDialog").showModal();
}

function validateAnimal(body, id) {
  if (!body.tag_number) throw new Error("Ear tag is required.");
  if (body.date_of_birth && new Date(`${body.date_of_birth}T00:00:00`) > new Date()) throw new Error("Birth date cannot be in the future.");
  if (animals.some((animal) => animal.tag_number.toLowerCase() === body.tag_number.toLowerCase() && animalId(animal) !== String(id))) throw new Error("That ear tag already belongs to another animal in your record.");
  if (!CLASS_OPTIONS[body.species][body.sex].includes(body.class)) throw new Error(`${body.class} does not match the selected species and sex.`);
  const sire = findAnimal(body.father_id), dam = findAnimal(body.mother_id);
  if (sire && (sire.species !== body.species || !isBreedingMale(sire))) throw new Error("The sire must be a confirmed Bull, Ram, or Buck of the same species.");
  if (dam && (dam.species !== body.species || animalSex(dam) !== "Female")) throw new Error("The dam must be a female of the same species.");
}

async function handleAnimalSubmit(event) {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(event.currentTarget));
  const id = form.id;
  const body = {
    tag_number: form.tag.trim(), name: form.name.trim() || null, species: form.species, sex: form.sex,
    class: form.classification, breed: form.breed.trim() || null, date_of_birth: form.birthDate || null,
    status: form.status, stock_brand: form.stockBrand.trim() || null, registration_status: form.registrationStatus,
    health_status: form.healthStatus, condition_score: form.conditionScore ? Number(form.conditionScore) : null,
    father_id: form.sireId || null, mother_id: form.damId || null, notes: form.notes.trim() || null
  };
  try {
    validateAnimal(body, id);
    if (navigator.onLine) {
      const data = await api(id ? `/api/v1/animals/${id}` : "/api/v1/animals", { method: id ? "PATCH" : "POST", body: JSON.stringify(body) });
      const saved = data.animal;
      const index = animals.findIndex((animal) => animalId(animal) === animalId(saved));
      index >= 0 ? animals.splice(index, 1, saved) : animals.unshift(saved);
    } else if (id) {
      const index = animals.findIndex((animal) => animalId(animal) === String(id));
      animals[index] = { ...animals[index], ...body, updated_at: new Date().toISOString() };
      enqueue("PATCH", id, body);
    } else {
      const localId = `offline-${crypto.randomUUID()}`;
      animals.unshift({ ...body, animal_id: localId, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      const queue = getQueue(); queue.push({ method: "POST", local_id: localId, body, queued_at: new Date().toISOString() }); setQueue(queue);
    }
    saveLocalCopy(); renderAll(); $("#animalDialog").close();
    showToast(navigator.onLine ? (isBreedingMale({ ...body, class: body.class }) ? `${body.class} saved as a breeding male` : "Animal record saved") : "Animal saved offline and queued for sync");
  } catch (error) { $("#formError").textContent = error.message; $("#formError").hidden = false; }
}

async function applyBulkStatus() {
  const status = $("#bulkStatus").value;
  if (!status) return showToast("Choose a status first");
  const ids = [...selectedRecords];
  try {
    if (navigator.onLine) await Promise.all(ids.map((id) => api(`/api/v1/animals/${id}`, { method: "PATCH", body: JSON.stringify({ status }) })));
    else ids.forEach((id) => enqueue("PATCH", id, { status }));
    animals = animals.map((animal) => selectedRecords.has(animalId(animal)) ? { ...animal, status, updated_at: new Date().toISOString() } : animal);
    selectedRecords.clear(); $("#bulkStatus").value = ""; saveLocalCopy(); renderAll();
    showToast(`${ids.length} record${ids.length === 1 ? "" : "s"} updated${navigator.onLine ? "" : " offline"}`);
  } catch (error) { showToast(error.message); }
}

function clearFilters() {
  activeSpecies = "All"; $("#recordSearch").value = ""; $("#recordStatus").value = "All"; $("#recordSort").value = "tag"; $("#breedingOnly").checked = false;
  renderSpeciesTabs(); renderClassFilter(); $("#recordClass").value = "All"; renderRecords();
}

function csv(records) {
  const headers = ["Ear Tag", "Name", "Species", "Sex", "Class", "Breed", "Birth Date", "Status", "Stock Brand", "Registration", "Health", "Condition", "Sire", "Dam", "Breeding Male", "Notes"];
  const escape = (values) => values.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",");
  const tag = (id) => findAnimal(id)?.tag_number || "";
  return [escape(headers), ...records.map((a) => escape([a.tag_number, a.name, a.species, animalSex(a), a.class, a.breed, String(a.date_of_birth || "").slice(0,10), a.status, a.stock_brand, a.registration_status, a.health_status, a.condition_score, tag(a.father_id), tag(a.mother_id), isBreedingMale(a) ? "Yes" : "No", a.notes]))].join("\n");
}

function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
}
function fileStem() { return String(user.farm_location || user.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function exportCsv(records = visibleRecords(), suffix = activeSpecies.toLowerCase()) { download(csv(records), `${fileStem()}-${suffix}-livestock.csv`, "text/csv"); showToast(`${records.length} record${records.length === 1 ? "" : "s"} exported`); }
function exportJson() {
  download(JSON.stringify({ format: "TFNN-OFFLINE-2", farmer_id: user.user_id, farmer_name: user.name, exported_at: new Date().toISOString(), animals }, null, 2), `${fileStem()}-offline-record.json`, "application/json");
  setMeta({ lastBackup: new Date().toISOString() }); renderOffline(); showToast("Offline farmer record downloaded");
}

async function importJson(file) {
  try {
    const payload = JSON.parse(await file.text());
    if (payload.format !== "TFNN-OFFLINE-2" || !Array.isArray(payload.animals)) throw new Error("This is not a current TFNN offline file.");
    if (String(payload.farmer_id) !== String(user.user_id)) throw new Error("This file belongs to another farmer account.");
    let changed = 0;
    for (const incoming of payload.animals) {
      const existing = animals.find((animal) => animal.tag_number.toLowerCase() === String(incoming.tag_number).toLowerCase());
      const body = { tag_number: incoming.tag_number, name: incoming.name || null, species: incoming.species, sex: incoming.sex || animalSex(incoming), class: incoming.class, breed: incoming.breed || null, date_of_birth: String(incoming.date_of_birth || "").slice(0,10) || null, status: incoming.status || "Active", stock_brand: incoming.stock_brand || null, registration_status: incoming.registration_status || "Registered", health_status: incoming.health_status || "Healthy", condition_score: incoming.condition_score || null, father_id: incoming.father_id || null, mother_id: incoming.mother_id || null, notes: incoming.notes || null };
      validateAnimal(body, existing ? animalId(existing) : "");
      if (navigator.onLine) await api(existing ? `/api/v1/animals/${animalId(existing)}` : "/api/v1/animals", { method: existing ? "PATCH" : "POST", body: JSON.stringify(body) });
      else if (existing) enqueue("PATCH", animalId(existing), body);
      else { const localId = `offline-${crypto.randomUUID()}`; animals.push({ ...body, animal_id: localId }); const queue = getQueue(); queue.push({ method: "POST", local_id: localId, body }); setQueue(queue); }
      changed += 1;
    }
    if (navigator.onLine) await loadAnimals(); else { saveLocalCopy(); renderAll(); }
    $("#importMessage").textContent = `${changed} record${changed === 1 ? "" : "s"} checked and saved to this farmer account.`; $("#importMessage").hidden = false;
  } catch (error) { $("#importMessage").textContent = error.message; $("#importMessage").hidden = false; }
}

function showToast(message) { $("#toast").textContent = message; $("#toast").classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => $("#toast").classList.remove("show"), 2800); }
function updateConnection() {
  const online = navigator.onLine;
  $(".sync-pill").classList.toggle("offline", !online);
  $("#connectionText").textContent = syncing ? "Syncing field changes…" : online ? "Online · secure sync active" : "Offline · local save active";
  renderOffline();
}

$("#loginForm").addEventListener("submit", handleLogin);
$$(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$("#switchFarmer").addEventListener("click", () => signOut());
$("#mobileMenu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$("#addAnimal").addEventListener("click", () => openAnimalDialog());
$("#closeDialog").addEventListener("click", () => $("#animalDialog").close());
$("#cancelDialog").addEventListener("click", () => $("#animalDialog").close());
$("#animalForm").addEventListener("submit", handleAnimalSubmit);
$("#animalSpecies").addEventListener("change", () => { updateClassOptions(); updateParentOptions($("#animalId").value); });
$("#animalSex").addEventListener("change", () => updateClassOptions());
$("#animalSire").addEventListener("change", updatePedigreeCheck); $("#animalDam").addEventListener("change", updatePedigreeCheck);
$("#recordSearch").addEventListener("input", renderRecords); $("#recordClass").addEventListener("change", renderRecords); $("#recordStatus").addEventListener("change", renderRecords); $("#recordSort").addEventListener("change", renderRecords); $("#breedingOnly").addEventListener("change", renderRecords);
$("#clearFilters").addEventListener("click", clearFilters);
$("#selectAllRecords").addEventListener("change", (event) => { visibleRecords().forEach((animal) => event.target.checked ? selectedRecords.add(animalId(animal)) : selectedRecords.delete(animalId(animal))); renderRecords(); });
$("#clearSelection").addEventListener("click", () => { selectedRecords.clear(); renderRecords(); });
$("#applyBulkStatus").addEventListener("click", applyBulkStatus);
$("#exportSelected").addEventListener("click", () => exportCsv(animals.filter((animal) => selectedRecords.has(animalId(animal))), "selected"));
$("#breedingSpecies").addEventListener("change", renderBreeding); $("#pedigreeSpecies").addEventListener("change", renderPedigreeOptions); $("#pedigreeAnimal").addEventListener("change", renderPedigree);
$("#exportCsv").addEventListener("click", () => exportCsv()); $("#downloadCsv").addEventListener("click", () => exportCsv(animals, "all")); $("#downloadJson").addEventListener("click", exportJson);
$("#importFileButton").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", (event) => { if (event.target.files[0]) importJson(event.target.files[0]); event.target.value = ""; });
window.addEventListener("online", () => { updateConnection(); syncQueue(); }); window.addEventListener("offline", updateConnection);
updateConnection(); restoreSession();
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
