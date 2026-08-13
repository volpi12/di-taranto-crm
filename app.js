const STORAGE_KEY = "detailingCrm.v1";
const AUTH_KEY = "detailingCrm.authenticated";
const DISMISSED_NOTIFICATIONS_KEY = "detailingCrm.dismissedNotifications.v1";

const defaultState = {
  settings: {
    shopName: "Tu Taller Detailing",
    shopWhatsapp: "",
    shopAddress: "",
    shopTaxId: "",
    shopPayment: "",
    shopTaxCondition: "",
    loginUserSetting: "admin",
    loginPasswordSetting: "1234",
    appTheme: "dark",
  },
  services: [
    {
      id: "service-basic-wash",
      name: "Lavado premium",
      price: 25000,
      currency: "ARS",
      category: "Lavados",
      description: "Lavado exterior, aspirado interior y terminación de neumáticos",
    },
    {
      id: "service-polish-one-step",
      name: "Pulido one step",
      price: 120000,
      currency: "ARS",
      category: "Pulidos",
      description: "Corrección liviana de brillo y protección final",
    },
    {
      id: "service-ceramic",
      name: "Tratamiento cerámico",
      price: 280000,
      currency: "ARS",
      category: "Tratamientos",
      description: "Preparación de pintura y protección cerámica",
    },
  ],
  products: [
    {
      id: "product-shampoo",
      name: "Shampoo neutro 5L",
      price: 18000,
      stock: 4,
      minStock: 2,
      description: "Uso para lavados premium",
    },
    {
      id: "product-microfiber",
      name: "Paño de microfibra",
      price: 3500,
      stock: 12,
      minStock: 5,
      description: "Paños de terminación y secado",
    },
  ],
  appointments: [],
  payments: [],
  clients: [],
  quotes: [],
  invoices: [],
  whatsappTemplates: [
    {
      id: "template-confirm-appointment",
      name: "Confirmar turno",
      body: "Hola {cliente}, te confirmo tu turno para {servicio} el {fecha}, horario {hora}. Te esperamos en {taller}.",
    },
    {
      id: "template-car-ready",
      name: "Auto listo",
      body: "Hola {cliente}, tu vehículo {patente} ya está listo para retirar. Muchas gracias por confiar en {taller}.",
    },
    {
      id: "template-deposit",
      name: "Pedir seña",
      body: "Hola {cliente}, para reservar el turno de {servicio} podemos tomar una seña. El total estimado es {total}.",
    },
  ],
};

let state = loadState();
let selectedClientHistoryId = "";
let selectedClientHistoryVehicleId = "";
let agendaFilter = "today";
let paymentDraftItems = [];

const money = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});

const usdMoney = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const SERVICE_CATEGORIES = ["Lavados", "Polarizados", "Pulidos", "Tratamientos", "Interior", "Otros"];
let memoryAuth = false;
let syncReady = false;
let serverAuthReady = false;
let syncPollTimer = null;
let syncingFromServer = false;
let searchIndexCache = { stamp: "", items: [] };
let receptionSummaryFrame = null;
let migrationDraft = null;

function debounce(fn, delay = 120) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

function scheduleReceptionSummary() {
  if (receptionSummaryFrame) window.cancelAnimationFrame(receptionSummaryFrame);
  receptionSummaryFrame = window.requestAnimationFrame(() => {
    receptionSummaryFrame = null;
    renderReceptionSummary();
  });
}

function readStorage(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorage(storage, key) {
  try {
    storage.removeItem(key);
  } catch {}
}

function loadState() {
  const saved = readStorage(localStorage, STORAGE_KEY);
  if (!saved) return structuredClone(defaultState);
  try {
    const parsed = JSON.parse(saved);
    return { ...structuredClone(defaultState), ...parsed, settings: { ...defaultState.settings, ...(parsed.settings || {}) } };
  } catch {
    return structuredClone(defaultState);
  }
}

function normalizeState(nextState = {}) {
  return { ...structuredClone(defaultState), ...nextState, settings: { ...defaultState.settings, ...(nextState.settings || {}) } };
}

function hasBusinessData(nextState = state) {
  return ["clients", "appointments", "payments", "quotes", "invoices"].some((key) => Array.isArray(nextState[key]) && nextState[key].length > 0);
}

function persistLocalState() {
  writeStorage(localStorage, STORAGE_KEY, JSON.stringify(state));
}

function dismissedNotificationKeys() {
  try {
    const parsed = JSON.parse(readStorage(localStorage, DISMISSED_NOTIFICATIONS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function notificationKey(item) {
  return [item.tone, item.title, item.detail, item.tab].join("|");
}

function visibleNotificationItems() {
  const dismissed = new Set(dismissedNotificationKeys());
  return notificationItems().filter((item) => !dismissed.has(notificationKey(item)));
}

function clearNotifications() {
  const keys = notificationItems().map(notificationKey);
  writeStorage(localStorage, DISMISSED_NOTIFICATIONS_KEY, JSON.stringify(keys));
  renderNotifications();
  showToast("Alertas limpiadas.");
}

function saveState() {
  state._updatedAt = new Date().toISOString();
  persistLocalState();
  if (syncReady) saveStateToServer();
  renderAll();
}

let pendingConfirmResolver = null;

function showToast(message, type = "success") {
  const stack = $("#toastStack");
  if (!stack) return;
  const toast = document.createElement("article");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  stack.appendChild(toast);
  window.setTimeout(() => toast.classList.add("is-leaving"), 2600);
  window.setTimeout(() => toast.remove(), 3100);
}

function notificationItems() {
  const tomorrow = addDays(1);
  const staleQuotes = state.quotes
    .filter((quote) => quote.validUntil && quote.validUntil < today())
    .slice(0, 4)
    .map((quote) => ({
      tone: "warning",
      title: `Cotización vencida ${quote.number}`,
      detail: `${getClient(quote.clientId)?.name || "Cliente eliminado"} · ${recordTotalLabel(quote)}`,
      tab: "quotes",
    }));
  const lowStock = state.products
    .filter((product) => Number(product.stock || 0) <= Number(product.minStock || 0))
    .slice(0, 4)
    .map((product) => ({
      tone: "danger",
      title: `Stock bajo: ${product.name}`,
      detail: `Quedan ${product.stock}. Alerta configurada en ${product.minStock}.`,
      tab: "products",
    }));
  const pending = pendingAppointmentBalances()
    .filter(({ appointment }) => appointmentHasPassed(appointment))
    .slice(0, 4)
    .map(({ appointment, status, client, service }) => ({
      tone: "danger",
      title: `Saldo pendiente ${client.name}`,
      detail: `${service?.name || appointment.serviceName || "Servicio"} · ${formatCurrency(status.balance, serviceCurrencyForAppointment(appointment))}`,
      tab: "payments",
    }));
  const tomorrowAppointments = sortedAppointments()
    .filter((appointment) => appointment.date === tomorrow && appointment.status !== "Cancelado")
    .slice(0, 4)
    .map((appointment) => {
      const client = appointmentClient(appointment);
      const service = getService(appointment.serviceId);
      return {
        tone: appointment.status === "Confirmado" ? "success" : "info",
        title: `${appointment.time} · ${client.name}`,
        detail: `${service?.name || appointment.serviceName || "Servicio"} · ${appointment.status}`,
        tab: "appointments",
      };
    });
  const backupHint = hasBusinessData() && !state._lastBackupDismissed
    ? [{ tone: "info", title: "Backup recomendado", detail: "Exportá una copia si cargaste datos importantes esta semana.", tab: "settings" }]
    : [];
  return [...pending, ...lowStock, ...staleQuotes, ...tomorrowAppointments, ...backupHint].slice(0, 12);
}

function renderNotifications() {
  const items = visibleNotificationItems();
  const count = $("#notificationCount");
  const panel = $("#notificationPanel");
  if (count) count.textContent = items.length;
  if (!panel) return;
  panel.innerHTML = `
    <div class="notification-head">
      <strong>Centro de notificaciones</strong>
      <div class="notification-head-actions">
        <span>${items.length ? `${items.length} alerta${items.length === 1 ? "" : "s"}` : "Todo en orden"}</span>
        <button class="secondary notification-clear" type="button" id="clearNotifications" ${items.length ? "" : "disabled"}>Limpiar</button>
      </div>
    </div>
    <div class="notification-list">
      ${
        items
          .map(
            (item) => `
              <button class="notification-item ${item.tone}" type="button" data-notification-tab="${item.tab}">
                <strong>${escapeHtml(item.title)}</strong>
                <span>${escapeHtml(item.detail)}</span>
              </button>
            `
          )
          .join("") || `<div class="empty">No hay alertas importantes ahora.</div>`
      }
    </div>
  `;
}

function toggleNotifications(force) {
  const panel = $("#notificationPanel");
  const button = $("#notificationToggle");
  if (!panel || !button) return;
  const nextOpen = typeof force === "boolean" ? force : panel.hidden;
  panel.hidden = !nextOpen;
  button.setAttribute("aria-expanded", String(nextOpen));
}

function askConfirm({ title = "¿Querés continuar?", message = "Esta acción modifica información del CRM.", action = "Confirmar", tone = "danger" } = {}) {
  const dialog = $("#confirmDialog");
  if (!dialog) return Promise.resolve(window.confirm(message));
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  $("#confirmAccept").textContent = action;
  $("#confirmAccept").className = tone === "danger" ? "danger" : "primary";
  delete $("#confirmAccept").dataset.iconified;
  delete $("#confirmCancel").dataset.iconified;
  enhanceButtonIcons();
  dialog.classList.add("active");
  dialog.setAttribute("aria-hidden", "false");
  $("#confirmAccept").focus();
  return new Promise((resolve) => {
    pendingConfirmResolver = resolve;
  });
}

function closeConfirm(result = false) {
  const dialog = $("#confirmDialog");
  if (!dialog) return;
  dialog.classList.remove("active");
  dialog.setAttribute("aria-hidden", "true");
  const resolver = pendingConfirmResolver;
  pendingConfirmResolver = null;
  if (resolver) resolver(result);
}

function currentTheme() {
  return state.settings.appTheme === "light" ? "light" : "dark";
}

function applyTheme() {
  if (!document.body) return;
  const theme = currentTheme();
  document.body.classList.toggle("theme-light", theme === "light");
  document.body.classList.toggle("theme-dark", theme !== "light");
  const toggle = $("#themeToggle");
  if (toggle) {
    toggle.textContent = theme === "light" ? "Modo oscuro" : "Modo claro";
    toggle.setAttribute("aria-pressed", String(theme === "light"));
  }
}

async function loadServerState() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.state) return null;
    const nextState = normalizeState(data.state);
    if (data.updatedAt) nextState._updatedAt = data.updatedAt;
    return nextState;
  } catch {
    return null;
  }
}

async function loadServerSession() {
  try {
    const response = await fetch("/api/session", { cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

async function renderLoginNetworkInfo() {
  const info = $("#loginNetworkInfo");
  if (!info) return;
  try {
    const response = await fetch("/api/ping", { cache: "no-store" });
    if (!response.ok) throw new Error("server unavailable");
    const data = await response.json();
    const shared = data.state || {};
    $("#recoverLogin").hidden = data.recoveryAllowed === false;
    info.textContent = shared.exists
      ? `Conectado al servidor. Usuario: ${shared.loginUser || "admin"} · Clientes: ${shared.clients || 0} · Turnos: ${shared.appointments || 0}.`
      : "Conectado al servidor. Todavía no hay datos centrales cargados.";
  } catch {
    info.textContent = "No pude conectar con el servidor.";
  }
}

async function saveStateToServer() {
  if (!hasBusinessData(state)) return;
  try {
    const response = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
    if (response.status === 401) {
      serverAuthReady = false;
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (data.updatedAt) {
      state._updatedAt = data.updatedAt;
      persistLocalState();
    }
  } catch {}
}

async function syncFromServer({ resetForms = false, notify = false } = {}) {
  if (syncingFromServer || !serverAuthReady) return false;
  syncingFromServer = true;
  try {
    const serverState = await loadServerState();
    if (!serverState) return false;
    if (String(serverState._updatedAt || "") === String(state._updatedAt || "")) return false;
    applySyncedState(serverState, { resetForms });
    if (notify) showToast("Datos sincronizados desde otro dispositivo.");
    return true;
  } finally {
    syncingFromServer = false;
  }
}

function startServerSync() {
  if (syncPollTimer) window.clearInterval(syncPollTimer);
  syncPollTimer = window.setInterval(() => {
    if (!document.hidden) syncFromServer();
  }, 5000);
}

async function syncInitialState() {
  const localHasData = hasBusinessData(state);
  serverAuthReady = await loadServerSession();
  if (!serverAuthReady && readStorage(sessionStorage, AUTH_KEY) === "true") {
    removeStorage(sessionStorage, AUTH_KEY);
    applyAuthState();
  }
  const serverState = await loadServerState();
  const serverHasData = hasBusinessData(serverState || {});

  if (serverAuthReady && serverHasData) {
    applySyncedState(serverState, { resetForms: true });
  } else if (serverAuthReady && localHasData && !serverHasData) {
    state._updatedAt ||= new Date().toISOString();
    persistLocalState();
    await saveStateToServer();
  }

  syncReady = true;
  if (serverAuthReady) unlockApp();
  if (serverAuthReady) startServerSync();
  renderLoginNetworkInfo();
}

function applySyncedState(nextState, { resetForms = true } = {}) {
  if (!nextState) return false;
  state = normalizeState(nextState);
  persistLocalState();
  if (resetForms) {
    resetQuoteForm();
    resetInvoiceForm();
    resetAppointmentForm();
    resetPaymentForm();
    resetTemplateForm();
  }
  renderAll();
  return true;
}

function applyAuthState() {
  document.body.classList.toggle("locked", !memoryAuth && readStorage(sessionStorage, AUTH_KEY) !== "true");
}

function unlockApp() {
  memoryAuth = true;
  writeStorage(sessionStorage, AUTH_KEY, "true");
  $("#loginError").textContent = "";
  applyAuthState();
}

function credentialsMatch(user, password) {
  const cleanUser = String(user || "").trim().toLowerCase();
  const cleanPassword = String(password || "").trim();
  const expectedUser = String(state.settings.loginUserSetting || "admin").trim().toLowerCase();
  const expectedPassword = String(state.settings.loginPasswordSetting || "1234").trim();
  const matchesSavedLogin = cleanUser === expectedUser && cleanPassword === expectedPassword;
  const matchesRecoveryLogin = cleanUser === "admin" && cleanPassword === "1234";
  return matchesSavedLogin || matchesRecoveryLogin;
}

async function login(user, password) {
  $("#loginError").textContent = "Iniciando sesión...";
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.ok) {
      if (data.state) applySyncedState({ ...data.state, _updatedAt: data.updatedAt || data.state._updatedAt });
      unlockApp();
      serverAuthReady = true;
      startServerSync();
      return true;
    }
    $("#loginError").textContent = data.error || "Usuario o contraseña incorrectos.";
    return false;
  } catch {
    $("#loginError").textContent = "No pude conectar con el servidor central. Revisá que estés usando el link correcto.";
    return false;
  }
}

async function logout() {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch {}
  memoryAuth = false;
  serverAuthReady = false;
  if (syncPollTimer) window.clearInterval(syncPollTimer);
  syncPollTimer = null;
  removeStorage(sessionStorage, AUTH_KEY);
  $("#loginPassword").value = "";
  applyAuthState();
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatMoney(value) {
  return money.format(Number(value || 0));
}

function normalizeCurrency(currency) {
  return currency === "USD" ? "USD" : "ARS";
}

function formatCurrency(value, currency = "ARS") {
  return normalizeCurrency(currency) === "USD" ? `USD ${usdMoney.format(Number(value || 0))}` : formatMoney(value);
}

function plainMoney(value, currency = "ARS") {
  return formatCurrency(value, currency).replace(/\u00a0/g, " ");
}

function totalsByCurrency(items) {
  return items.reduce(
    (totals, item) => {
      const currency = normalizeCurrency(item.currency);
      totals[currency] += Number(item.qty || 0) * Number(item.price || 0);
      return totals;
    },
    { ARS: 0, USD: 0 }
  );
}

function sumPayments(payments) {
  return payments.reduce(
    (totals, payment) => {
      totals[normalizeCurrency(payment.currency)] += Number(payment.amount || 0);
      return totals;
    },
    { ARS: 0, USD: 0 }
  );
}

function formatTotals(totals = {}) {
  const ars = Number(totals.ARS || 0);
  const usd = Number(totals.USD || 0);
  if (ars && usd) return `${formatCurrency(ars, "ARS")} / ${formatCurrency(usd, "USD")}`;
  if (usd) return formatCurrency(usd, "USD");
  return formatCurrency(ars, "ARS");
}

function formatCompactCurrency(value, currency = "ARS") {
  const number = new Intl.NumberFormat(normalizeCurrency(currency) === "USD" ? "en-US" : "es-AR", {
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
  return normalizeCurrency(currency) === "USD" ? `USD ${number}` : `$ ${number}`;
}

function formatCompactTotals(totals = {}) {
  const ars = Number(totals.ARS || 0);
  const usd = Number(totals.USD || 0);
  if (ars && usd) return `${formatCompactCurrency(ars, "ARS")} / ${formatCompactCurrency(usd, "USD")}`;
  if (usd) return formatCompactCurrency(usd, "USD");
  return formatCompactCurrency(ars, "ARS");
}

function formatWhatsappDisplay(value = "") {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "-";
  const local = digits.startsWith("549") ? digits.slice(3) : digits.startsWith("54") ? digits.slice(2) : digits;
  if (local.length === 10) return `${local.slice(0, 2)} ${local.slice(2, 6)}-${local.slice(6)}`;
  if (local.length === 11) return `${local.slice(0, 2)} ${local.slice(2, 3)} ${local.slice(3, 7)}-${local.slice(7)}`;
  if (digits.length > 7) return digits.replace(/(\d{2,3})(?=\d)/g, "$1 ").trim();
  return raw;
}

function recordTotalLabel(record) {
  return record.totals ? formatTotals(record.totals) : formatCurrency(record.total, record.currency || "ARS");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonth() {
  return today().slice(0, 7);
}

function monthMatches(date, month) {
  return String(date || "").startsWith(month);
}

function monthLabel(month) {
  const [year, monthNumber] = String(month || currentMonth()).split("-");
  const date = new Date(Number(year), Number(monthNumber) - 1, 1);
  return date.toLocaleDateString("es-AR", { month: "long", year: "numeric" });
}

function previousMonth(month) {
  let [year, monthNumber] = String(month || currentMonth()).split("-").map(Number);
  monthNumber -= 1;
  if (monthNumber < 1) {
    monthNumber = 12;
    year -= 1;
  }
  return `${year}-${String(monthNumber).padStart(2, "0")}`;
}

function compareTotals(a = {}, b = {}) {
  const arsDiff = Number(a.ARS || 0) - Number(b.ARS || 0);
  if (arsDiff) return arsDiff;
  return Number(a.USD || 0) - Number(b.USD || 0);
}

function totalsPercentChange(current = {}, previous = {}) {
  const arsCurrent = Number(current.ARS || 0);
  const arsPrevious = Number(previous.ARS || 0);
  const usdCurrent = Number(current.USD || 0);
  const usdPrevious = Number(previous.USD || 0);
  const baseCurrency = arsPrevious || arsCurrent ? "ARS" : "USD";
  const currentValue = baseCurrency === "ARS" ? arsCurrent : usdCurrent;
  const previousValue = baseCurrency === "ARS" ? arsPrevious : usdPrevious;
  if (!previousValue && currentValue) return { label: "Nuevo", className: "is-up" };
  if (!previousValue && !currentValue) return { label: "0%", className: "" };
  const diff = Math.round(((currentValue - previousValue) / previousValue) * 100);
  return {
    label: `${diff > 0 ? "+" : ""}${diff}%`,
    className: diff > 0 ? "is-up" : diff < 0 ? "is-down" : "",
  };
}

function dateLabel(date) {
  if (!date) return "-";
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

function addDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function addDaysToDate(dateValue, days) {
  const date = new Date(`${dateValue}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekStart(dateValue) {
  const date = new Date(`${dateValue || today()}T12:00:00`);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function totalItems(items) {
  return items.reduce((sum, item) => sum + Number(item.qty || 0) * Number(item.price || 0), 0);
}

function getClient(id) {
  return state.clients.find((client) => client.id === id);
}

const BRAND_HINTS = {
  Toyota: ["toyota", "hilux", "corolla", "yaris", "etios", "sw4", "rav4"],
  Volkswagen: ["volkswagen", "vw", "amarok", "golf", "vento", "polo", "nivus", "taos", "suran", "gol", "saveiro"],
  Ford: ["ford", "ranger", "focus", "fiesta", "ka", "ecosport", "territory", "mustang"],
  Chevrolet: ["chevrolet", "cruze", "s10", "tracker", "onix", "prisma", "classic", "corsa"],
  Fiat: ["fiat", "toro", "cronos", "argo", "mobi", "strada", "palio", "siena"],
  Renault: ["renault", "kangoo", "sandero", "logan", "duster", "fluence", "clio"],
  Peugeot: ["peugeot", "208", "308", "408", "partner", "rcz"],
  "Citroën": ["citroen", "citroën", "c3", "c4", "berlingo"],
  "Mercedes-Benz": ["mercedes", "benz", "sprinter", "a200", "c200", "glc", "gla"],
  BMW: ["bmw", "118", "120", "320", "330", "x1", "x3", "x5"],
  Audi: ["audi", "a1", "a3", "a4", "q3", "q5", "tt"],
  Honda: ["honda", "civic", "fit", "hr-v", "hrv", "cr-v", "crv"],
  Nissan: ["nissan", "frontier", "sentra", "versa", "kicks", "march"],
  Jeep: ["jeep", "renegade", "compass", "cherokee", "wrangler"],
  Hyundai: ["hyundai", "tucson", "santa fe", "veloster", "hb20"],
  Kia: ["kia", "sportage", "sorento", "cerato", "rio"],
};

function detectBrandFromVehicle(vehicle = "") {
  const normalized = String(vehicle).toLowerCase();
  return Object.entries(BRAND_HINTS).find(([, hints]) => hints.some((hint) => normalized.includes(hint)))?.[0] || "";
}

function clientBrand(client) {
  const primary = primaryVehicle(client);
  return normalizeBrand(primary?.brand || client?.brand || detectBrandFromVehicle(primary?.vehicle || client?.vehicle));
}

function normalizeBrand(brand) {
  return String(brand || "").trim() || "Otro";
}

function normalizeVehicleEntry(vehicle = {}) {
  const model = String(vehicle.vehicle || vehicle.model || "").trim();
  const plate = normalizePlate(vehicle.plate || "");
  const brand = normalizeBrand(vehicle.brand || detectBrandFromVehicle(model));
  return {
    id: vehicle.id || uid("vehicle"),
    brand,
    vehicle: model,
    plate,
  };
}

function clientVehicles(client = {}) {
  const vehicles = Array.isArray(client.vehicles) ? client.vehicles : [];
  const normalized = vehicles.map(normalizeVehicleEntry).filter((vehicle) => vehicle.plate || vehicle.vehicle);
  if (!normalized.length && (client.plate || client.vehicle || client.brand)) {
    normalized.push(normalizeVehicleEntry({ id: "primary", plate: client.plate, brand: client.brand, vehicle: client.vehicle }));
  }
  return normalized;
}

function primaryVehicle(client = {}) {
  return clientVehicles(client)[0] || normalizeVehicleEntry({ id: "primary", plate: client.plate, brand: client.brand, vehicle: client.vehicle });
}

function vehicleOptionLabel(vehicle) {
  return `${vehicle.brand || "Marca"} · ${vehicle.vehicle || "Vehículo"} · ${vehicle.plate || "Sin patente"}`;
}

function clientVehicleOptions(clientId, selectedVehicleId = "") {
  const client = getClient(clientId);
  const vehicles = clientVehicles(client);
  if (!client || !vehicles.length) return `<option value="">Sin vehículos cargados</option>`;
  return vehicles
    .map((vehicle) => `<option value="${vehicle.id}" ${vehicle.id === selectedVehicleId ? "selected" : ""}>${vehicleOptionLabel(vehicle)}</option>`)
    .join("");
}

function updateVehicleSelect(selectId, clientId, selectedVehicleId = "") {
  const select = $("#" + selectId);
  if (!select) return;
  select.innerHTML = clientVehicleOptions(clientId, selectedVehicleId);
  if (selectedVehicleId && [...select.options].some((option) => option.value === selectedVehicleId)) {
    select.value = selectedVehicleId;
  }
}

function selectedVehicleSnapshot(clientId, vehicleId) {
  const client = getClient(clientId);
  if (!client) return null;
  const vehicle = clientVehicles(client).find((item) => item.id === vehicleId) || primaryVehicle(client);
  return vehicle ? normalizeVehicleEntry(vehicle) : null;
}

function recordVehicle(record, client = getClient(record?.clientId)) {
  if (record?.vehicle) return normalizeVehicleEntry(record.vehicle);
  if (!client) return null;
  if (record?.vehicleId) {
    const found = clientVehicles(client).find((vehicle) => vehicle.id === record.vehicleId);
    if (found) return found;
  }
  return primaryVehicle(client);
}

function vehicleMatchesRecord(record, client, vehicleId = "") {
  if (!vehicleId) return true;
  const selected = clientVehicles(client).find((vehicle) => vehicle.id === vehicleId);
  if (!selected) return true;
  if (record?.vehicleId && record.vehicleId === vehicleId) return true;
  const vehicle = recordVehicle(record, client);
  if (!vehicle) return false;
  if (selected.plate && vehicle.plate && selected.plate === vehicle.plate) return true;
  return selected.vehicle && vehicle.vehicle && selected.vehicle === vehicle.vehicle && selected.brand === vehicle.brand;
}

function brandSlug(brand) {
  return normalizeBrand(brand)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function brandLogoPath(brand) {
  return `assets/brands/${brandSlug(brand)}.svg`;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function normalizePlate(plate = "") {
  return String(plate || "").trim().toUpperCase().replace(/\s+/g, "");
}

function plateType(plate = "", forced = "auto") {
  if (["mercosur", "classic"].includes(forced)) return forced;
  const normalized = normalizePlate(plate);
  if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(normalized)) return "mercosur";
  if (/^[A-Z]{3}\d{3}$/.test(normalized)) return "classic";
  return "custom";
}

function plateDisplay(plate = "") {
  const normalized = normalizePlate(plate);
  if (!normalized || normalized === "-") return "-";
  if (/^[A-Z]{2}\d{3}[A-Z]{2}$/.test(normalized)) return `${normalized.slice(0, 2)} ${normalized.slice(2, 5)} ${normalized.slice(5)}`;
  if (/^[A-Z]{3}\d{3}$/.test(normalized)) return `${normalized.slice(0, 3)} ${normalized.slice(3)}`;
  return normalized;
}

function plateSvgMarkup(plate, forcedType = "auto") {
  const display = plateDisplay(plate);
  const type = plateType(plate, forcedType);
  const text = escapeHtml(display);
  const id = `plate-${type}-${Math.random().toString(36).slice(2, 9)}`;
  if (type === "classic") {
    return `
      <svg viewBox="0 0 500 215" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Patente ${text}">
        <defs>
          <linearGradient id="${id}-shell" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="#f7f7f3"/>
            <stop offset="0.42" stop-color="#c8cecc"/>
            <stop offset="1" stop-color="#eef0ec"/>
          </linearGradient>
          <linearGradient id="${id}-black" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="#151717"/>
            <stop offset="0.18" stop-color="#010101"/>
            <stop offset="1" stop-color="#050606"/>
          </linearGradient>
          <filter id="${id}-raised" x="-5%" y="-5%" width="110%" height="120%">
            <feDropShadow dx="0" dy="2" stdDeviation="1.4" flood-color="#000" flood-opacity=".38"/>
          </filter>
        </defs>
        <rect x="4" y="4" width="492" height="207" rx="13" fill="url(#${id}-shell)" stroke="#8b918f" stroke-width="3"/>
        <rect x="17" y="58" width="466" height="123" rx="7" fill="url(#${id}-black)" stroke="#f2f3ef" stroke-width="7"/>
        <text x="250" y="43" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="31" font-weight="800" fill="#36b8ea">ARGENTINA</text>
        <rect x="96" y="24" width="42" height="8" rx="4" fill="#e7ebe8" stroke="#87908d" stroke-width="2"/>
        <rect x="362" y="24" width="42" height="8" rx="4" fill="#e7ebe8" stroke="#87908d" stroke-width="2"/>
        <rect x="96" y="192" width="42" height="8" rx="4" fill="#e7ebe8" stroke="#87908d" stroke-width="2"/>
        <rect x="362" y="192" width="42" height="8" rx="4" fill="#e7ebe8" stroke="#87908d" stroke-width="2"/>
        <circle cx="56" cy="34" r="19" fill="#f7f9f4" stroke="#8a918e" stroke-width="2"/>
        <path d="M44 34h24M56 22v24" stroke="#6bc3ef" stroke-width="3.5"/>
        <circle cx="56" cy="34" r="5.5" fill="#efc43b"/>
        <text x="250" y="157" text-anchor="middle" font-family="Arial Black, Impact, Arial, sans-serif" font-size="108" font-weight="900" textLength="424" lengthAdjust="spacingAndGlyphs" fill="#f7f7f2" filter="url(#${id}-raised)">${text}</text>
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 400 130" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Patente ${text}">
      <defs>
        <linearGradient id="${id}-base" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset="0.58" stop-color="#efefeb"/>
          <stop offset="1" stop-color="#fafaf6"/>
        </linearGradient>
        <linearGradient id="${id}-blue" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="#0c60c9"/>
          <stop offset="1" stop-color="#073b99"/>
        </linearGradient>
        <filter id="${id}-ink" x="-4%" y="-4%" width="108%" height="112%">
          <feDropShadow dx="0" dy="1" stdDeviation=".65" flood-color="#000" flood-opacity=".28"/>
        </filter>
      </defs>
      <rect x="2" y="2" width="396" height="126" rx="7" fill="url(#${id}-base)" stroke="#111820" stroke-width="4"/>
      <rect x="5" y="5" width="390" height="30" rx="4" fill="url(#${id}-blue)"/>
      <text x="34" y="25" font-family="Arial, Helvetica, sans-serif" font-size="9" font-weight="800" fill="#fff">MERCOSUR</text>
      <text x="200" y="26" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="18" font-weight="900" fill="#fff">REPÚBLICA ARGENTINA</text>
      <rect x="348" y="10" width="34" height="20" rx="2" fill="#fff" stroke="#d8dde0" stroke-width=".8"/>
      <path d="M351 12h28v5h-28zM351 23h28v5h-28z" fill="#72b9ef"/>
      <circle cx="365" cy="20" r="3" fill="#f3c33d"/>
      <path d="M54 49c42 12 76 12 118 0M228 49c42 12 76 12 118 0" fill="none" stroke="#d7dcd7" stroke-width="3" opacity=".58"/>
      <text x="200" y="107" text-anchor="middle" font-family="Arial Black, Impact, Arial, sans-serif" font-size="70" font-weight="900" textLength="318" lengthAdjust="spacingAndGlyphs" fill="#111318" filter="url(#${id}-ink)">${text}</text>
      <circle cx="22" cy="112" r="5" fill="#cbd1cf" stroke="#5d6466" stroke-width="1.4"/>
      <circle cx="378" cy="112" r="5" fill="#cbd1cf" stroke="#5d6466" stroke-width="1.4"/>
    </svg>
  `;
}

function plateBadge(plate, compact = false, forcedType = "auto") {
  const display = plateDisplay(plate);
  if (display === "-") return `<span class="vehicle-plate vehicle-plate-empty">Sin patente</span>`;
  const type = plateType(plate, forcedType);
  return `
    <span class="vehicle-plate vehicle-plate-${type}${compact ? " vehicle-plate-compact" : ""}" aria-label="Patente ${escapeHtml(display)}">
      ${plateSvgMarkup(plate, forcedType)}
    </span>
  `;
}

function plateLine(plate, text = "") {
  return `<span class="plate-line">${plateBadge(plate, true)}${text ? `<span>${text}</span>` : ""}</span>`;
}

function brandBadge(brand) {
  const normalized = normalizeBrand(brand);
  const key = brandSlug(normalized);
  return `
    <span class="brand-badge brand-${key}" title="${normalized}" style="visibility: hidden;">
      <img class="brand-logo-img" src="${brandLogoPath(normalized)}" alt="${normalized}" loading="lazy" onload="this.parentElement.style.visibility = 'visible';" onerror="this.parentElement.style.display = 'none';">
    </span>
  `;
}

function paymentClient(payment) {
  return getClient(payment.clientId) || {
    id: "",
    name: payment.guestName || "Consumidor final",
    whatsapp: payment.guestWhatsapp || "",
    plate: "-",
    vehicle: "",
  };
}

function appointmentClient(appointment) {
  return getClient(appointment.clientId) || {
    id: "",
    name: appointment.guestName || "Cliente sin agendar",
    whatsapp: appointment.guestWhatsapp || "",
    plate: "-",
    vehicle: "",
  };
}

function getService(id) {
  return state.services.find((service) => service.id === id);
}

function serviceCategory(service) {
  return SERVICE_CATEGORIES.includes(service?.category) ? service.category : "Otros";
}

function serviceOptionLabel(service) {
  return `${serviceCategory(service)} · ${service.name} · ${formatCurrency(service.price, service.currency)}`;
}

function getProduct(id) {
  return state.products.find((product) => product.id === id);
}

function paymentItemValue(type, id) {
  return id ? `${type}:${id}` : "";
}

function parsePaymentItem(value = "") {
  const [type, id] = String(value || "").split(":");
  if (type === "product") return { type, id, item: getProduct(id) };
  if (type === "service") return { type, id, item: getService(id) };
  const legacyService = getService(value);
  return legacyService ? { type: "service", id: value, item: legacyService } : { type: "", id: "", item: null };
}

function syncPaymentItemSelection() {
  const type = $("#paymentItemType")?.value || "service";
  const serviceId = $("#paymentServiceChoice")?.value || "";
  const productId = $("#paymentProductChoice")?.value || "";
  const value = type === "product" ? paymentItemValue("product", productId) : paymentItemValue("service", serviceId);
  if ($("#paymentService")) $("#paymentService").value = value;
  document.body?.dataset && (document.body.dataset.paymentItemType = type);
  $$(".payment-kind-switch button").forEach((button) => {
    button.classList.toggle("active", button.dataset.paymentKind === type);
  });
  $$(".payment-service-field").forEach((field) => {
    field.hidden = type !== "service";
    field.classList.toggle("is-active", type === "service");
  });
  $$(".payment-product-field").forEach((field) => {
    field.hidden = type !== "product";
    field.classList.toggle("is-active", type === "product");
  });
  return parsePaymentItem(value);
}

function setPaymentItemSelection(value = "") {
  const parsed = parsePaymentItem(value);
  if (parsed.type) $("#paymentItemType").value = parsed.type;
  if (parsed.type === "product") $("#paymentProductChoice").value = parsed.id;
  if (parsed.type === "service") $("#paymentServiceChoice").value = parsed.id;
  syncPaymentItemSelection();
  renderPaymentCatalog();
}

function setPaymentKind(type = "service") {
  $("#paymentItemType").value = type === "product" ? "product" : "service";
  syncPaymentItemSelection();
  updatePaymentCalculation(true);
  renderPaymentCatalog();
}

function paymentItemLabel(payment) {
  const items = paymentItemsFromPayment(payment);
  if (items.length) return paymentItemsLabel(items);
  const product = getProduct(payment.productId);
  const service = getService(payment.serviceId);
  return product?.name || service?.name || payment.serviceName || "Servicio";
}

function paymentItemCurrency(parsedItem) {
  if (parsedItem.type === "product") return "ARS";
  return normalizeCurrency(parsedItem.item?.currency);
}

function paymentItemPrice(parsedItem) {
  return Number(parsedItem.item?.price || 0);
}

function paymentLineSubtotal(item) {
  return Number(item.price || 0) * Math.max(1, Number(item.quantity || 1));
}

function paymentLineLabel(item) {
  const name = item.name || "Concepto";
  return `${name}${Number(item.quantity || 1) > 1 ? ` x${item.quantity}` : ""}`;
}

function paymentItemsTotal(items = []) {
  return items.reduce((sum, item) => sum + paymentLineSubtotal(item), 0);
}

function paymentItemsLabel(items = []) {
  if (!items.length) return "";
  if (items.length === 1) return paymentLineLabel(items[0]);
  const [first, ...rest] = items;
  return `${paymentLineLabel(first)} + ${rest.length} ítem${rest.length > 1 ? "s" : ""}`;
}

function paymentReceiptItemLines(payment = {}) {
  const items = paymentItemsFromPayment(payment);
  if (items.length) return items;
  return [
    {
      id: uid("payitem"),
      type: payment.productId ? "product" : "service",
      itemId: payment.productId || payment.serviceId || "",
      name: payment.serviceName || "Concepto",
      quantity: Math.max(1, Number(payment.quantity || 1)),
      price: Number(payment.amount || 0),
      currency: normalizeCurrency(payment.currency),
    },
  ];
}

function paymentItemsFromPayment(payment = {}) {
  payment = payment || {};
  if (Array.isArray(payment.items) && payment.items.length) {
    return payment.items.map((item) => ({
      id: item.id || uid("payitem"),
      type: item.type || (item.productId ? "product" : "service"),
      itemId: item.itemId || item.productId || item.serviceId || "",
      name: item.name || item.description || "Concepto",
      quantity: Math.max(1, Number(item.quantity || 1)),
      price: Number(item.price || 0),
      currency: normalizeCurrency(item.currency || payment.currency),
    }));
  }
  if (!payment.serviceId && !payment.productId && !payment.serviceName) return [];
  const type = payment.productId ? "product" : "service";
  const item = type === "product" ? getProduct(payment.productId) : getService(payment.serviceId);
  const quantity = type === "product" ? Math.max(1, Number(payment.quantity || 1)) : 1;
  return [
    {
      id: uid("payitem"),
      type,
      itemId: payment.productId || payment.serviceId || "",
      name: item?.name || payment.serviceName || "Concepto",
      quantity,
      price: Number(item?.price || Number(payment.amount || 0) / quantity || 0),
      currency: normalizeCurrency(payment.currency || item?.currency),
    },
  ];
}

function paymentProductLines(payment = {}) {
  payment = payment || {};
  return paymentItemsFromPayment(payment)
    .filter((item) => item.type === "product" && item.itemId)
    .map((item) => ({ productId: item.itemId, quantity: Math.max(1, Number(item.quantity || 1)) }));
}

function paymentDraftCurrency() {
  return normalizeCurrency(paymentDraftItems[0]?.currency || $("#paymentCurrency")?.value || "ARS");
}

function paymentLineFromCurrentSelection() {
  const parsed = syncPaymentItemSelection();
  if (!parsed.item) return null;
  const quantity = parsed.type === "product" ? Math.max(1, Number($("#paymentQuantity")?.value || 1)) : 1;
  return {
    id: uid("payitem"),
    type: parsed.type,
    itemId: parsed.id,
    name: parsed.item.name,
    quantity,
    price: paymentItemPrice(parsed),
    currency: paymentItemCurrency(parsed),
  };
}

function renderPaymentTicket() {
  const list = $("#paymentTicketList");
  const total = paymentItemsTotal(paymentDraftItems);
  const currency = paymentDraftItems.length ? paymentDraftCurrency() : normalizeCurrency($("#paymentCurrency")?.value || "ARS");
  if ($("#paymentAmount")) $("#paymentAmount").value = total;
  if ($("#paymentCurrency") && paymentDraftItems.length) $("#paymentCurrency").value = currency;
  if (list) {
    if (!paymentDraftItems.length) {
      list.innerHTML = `<div class="payment-ticket-empty">Agregá servicios o productos. El total se suma automáticamente.</div>`;
    } else {
      list.innerHTML = paymentDraftItems
        .map(
          (item) => `
            <div class="payment-ticket-row">
              <div>
                <strong>${paymentLineLabel(item)}</strong>
                <span>${item.type === "product" ? "Producto" : "Servicio"} · ${formatCurrency(item.price, item.currency)}${Number(item.quantity || 1) > 1 ? ` c/u` : ""}</span>
              </div>
              <em>${formatCurrency(paymentLineSubtotal(item), item.currency)}</em>
              <button class="icon-btn" type="button" data-remove-payment-item="${item.id}" title="Quitar">×</button>
            </div>
          `
        )
        .join("");
    }
  }
  updatePaymentChange();
}

function paymentCatalogCard(item, type, selectedId) {
  const currency = type === "product" ? "ARS" : normalizeCurrency(item.currency);
  const stockText = type === "product" ? `Stock ${Number(item.stock || 0)}` : serviceCategory(item);
  const disabled = type === "product" && Number(item.stock || 0) <= 0;
  return `
    <button class="payment-catalog-card ${item.id === selectedId ? "active" : ""}" type="button" data-payment-catalog-item="${type}:${item.id}" ${disabled ? "disabled" : ""}>
      <span>${type === "product" ? "Producto" : "Servicio"}</span>
      <strong>${escapeHtml(item.name)}</strong>
      <small>${escapeHtml(stockText)}</small>
      <em>${formatCurrency(item.price, currency)}</em>
    </button>
  `;
}

function renderPaymentCatalog() {
  const catalog = $("#paymentCatalog");
  if (!catalog) return;
  const parsed = syncPaymentItemSelection();
  const type = parsed.type || "service";
  const items = type === "product" ? state.products : state.services;
  if (!items.length) {
    catalog.innerHTML = `<div class="payment-catalog-empty">Todavía no hay ${type === "product" ? "productos" : "servicios"} cargados.</div>`;
    return;
  }
  catalog.innerHTML = items.map((item) => paymentCatalogCard(item, type, parsed.id)).join("");
}

function hidePaymentDone() {
  const panel = $("#paymentDonePanel");
  if (!panel) return;
  panel.hidden = true;
  panel.innerHTML = "";
}

function showPaymentDone(payment) {
  const panel = $("#paymentDonePanel");
  if (!panel || !payment) return;
  const client = paymentClient(payment);
  panel.hidden = false;
  panel.innerHTML = `
    <div class="payment-done-content">
      <div>
        <p class="eyebrow">Cobro realizado</p>
        <h3>${paymentReceiptNumber(payment)} · ${formatCurrency(payment.amount, payment.currency)}</h3>
        <p>${escapeHtml(client.name)} · ${escapeHtml(paymentItemLabel(payment))}</p>
      </div>
      <div class="payment-done-actions">
        <button class="secondary" type="button" data-payment-receipt="${payment.id}">Ver recibo</button>
        <button class="secondary" type="button" data-download-payment="${payment.id}">Descargar PDF</button>
        <button class="whatsapp" type="button" data-share-payment="${payment.id}">WhatsApp</button>
        <button class="primary" type="button" id="newPaymentFromDone">Nuevo cobro</button>
      </div>
    </div>
  `;
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function addPaymentDraftItem() {
  const line = paymentLineFromCurrentSelection();
  if (!line) return showToast("Elegí un servicio o producto para agregar al cobro.", "error");
  if (paymentDraftItems.length && normalizeCurrency(line.currency) !== paymentDraftCurrency()) {
    return showToast("Para evitar errores, hacé cobros separados cuando mezcles ARS y USD.", "error");
  }
  if (line.type === "product") {
    const product = getProduct(line.itemId);
    const alreadyInDraft = paymentDraftItems
      .filter((item) => item.type === "product" && item.itemId === line.itemId)
      .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const available = Number(product?.stock || 0);
    if (available <= 0) return showToast(`No hay stock disponible de ${line.name}.`, "error");
    if (alreadyInDraft + Number(line.quantity || 1) > available) {
      return showToast(`Stock insuficiente de ${line.name}. Disponible: ${available}. En este cobro ya tenés ${alreadyInDraft}.`, "error");
    }
  }
  const existing = paymentDraftItems.find((item) => item.type === line.type && item.itemId === line.itemId);
  if (existing) existing.quantity += line.quantity;
  else paymentDraftItems.push(line);
  if ($("#paymentReceived")) $("#paymentReceived").value = "";
  renderPaymentTicket();
}

function servicePriceForAppointment(appointment) {
  const service = getService(appointment.serviceId);
  return Number(service?.price || 0);
}

function serviceCurrencyForAppointment(appointment) {
  const service = getService(appointment.serviceId);
  return normalizeCurrency(service?.currency);
}

function paymentsForAppointment(appointmentId) {
  return state.payments.filter((payment) => payment.appointmentId === appointmentId);
}

function appointmentPaymentStatus(appointment) {
  const currency = serviceCurrencyForAppointment(appointment);
  const paid = paymentsForAppointment(appointment.id)
    .filter((payment) => normalizeCurrency(payment.currency) === currency)
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const total = servicePriceForAppointment(appointment);
  if (!paid) return { label: "Sin cobrar", className: "unpaid", paid, total, balance: total };
  if (total && paid < total) return { label: `Seña ${formatCurrency(paid, currency)}`, className: "partial", paid, total, balance: total - paid };
  return { label: "Pagado", className: "paid", paid, total, balance: Math.max(total - paid, 0) };
}

function switchTab(tabId) {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabId));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === tabId));
  closeMobileMore();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function toggleMobileMore(force) {
  const panel = $("#mobileMorePanel");
  if (!panel) return;
  const nextOpen = typeof force === "boolean" ? force : panel.hidden;
  panel.hidden = !nextOpen;
  panel.setAttribute("aria-hidden", String(!nextOpen));
}

function closeMobileMore() {
  toggleMobileMore(false);
}

function toggleUniversalActions(force) {
  const panel = $("#universalActionPanel");
  const button = $("#universalActionToggle");
  if (!panel) return;
  const nextOpen = typeof force === "boolean" ? force : panel.hidden;
  panel.hidden = !nextOpen;
  panel.setAttribute("aria-hidden", String(!nextOpen));
  if (button) button.setAttribute("aria-expanded", String(nextOpen));
}

function closeUniversalActions() {
  toggleUniversalActions(false);
}

function runUniversalAction(action) {
  closeUniversalActions();
  if (action === "reception") {
    resetReceptionForm();
    switchTab("reception");
    $("#receptionSearch")?.focus();
    return;
  }
  if (action === "client") {
    resetClientForm();
    switchTab("clients");
    $("#clientName")?.focus();
    return;
  }
  if (action === "appointment") {
    resetAppointmentForm();
    setAppointmentFormOpen(true);
    switchTab("appointments");
    $("#appointmentClient")?.focus();
    return;
  }
  if (action === "payment") {
    resetPaymentForm();
    switchTab("payments");
    $("#paymentServiceChoice")?.focus();
    return;
  }
  if (action === "quote") {
    resetQuoteForm();
    switchTab("quotes");
    $("#quoteClient")?.focus();
    return;
  }
  if (action === "product") {
    resetProductForm();
    switchTab("products");
    $("#productName")?.focus();
  }
}

function resetClientForm() {
  $("#clientId").value = "";
  $("#clientName").value = "";
  $("#clientWhatsapp").value = "";
  $("#clientPlate").value = "";
  $("#clientBrand").value = "";
  $("#clientVehicle").value = "";
  $("#clientVehicleRows").innerHTML = "";
}

function vehicleBrandOptions(selected = "") {
  const brands = ["", "Toyota", "Volkswagen", "Ford", "Chevrolet", "Fiat", "Renault", "Peugeot", "Citroën", "Mercedes-Benz", "BMW", "Audi", "Honda", "Nissan", "Jeep", "Hyundai", "Kia", "Otro"];
  return brands
    .map((brand) => `<option value="${brand}" ${brand === selected ? "selected" : ""}>${brand || "Seleccionar marca"}</option>`)
    .join("");
}

function addClientVehicleRow(vehicle = {}) {
  const row = document.createElement("div");
  row.className = "client-vehicle-row";
  row.innerHTML = `
    <input class="vehicle-row-plate" placeholder="Patente" value="${escapeHtml(vehicle.plate || "")}" />
    <select class="vehicle-row-brand">${vehicleBrandOptions(vehicle.brand || "")}</select>
    <input class="vehicle-row-model" placeholder="Modelo / vehículo" value="${escapeHtml(vehicle.vehicle || "")}" />
    <button class="icon-btn" type="button" data-remove-client-vehicle aria-label="Eliminar vehículo">×</button>
  `;
  $("#clientVehicleRows").appendChild(row);
}

function readClientVehicles() {
  const primary = normalizeVehicleEntry({
    plate: $("#clientPlate").value,
    brand: $("#clientBrand").value || detectBrandFromVehicle($("#clientVehicle").value),
    vehicle: $("#clientVehicle").value,
  });
  const extra = $$("#clientVehicleRows .client-vehicle-row")
    .map((row) =>
      normalizeVehicleEntry({
        plate: row.querySelector(".vehicle-row-plate").value,
        brand: row.querySelector(".vehicle-row-brand").value || detectBrandFromVehicle(row.querySelector(".vehicle-row-model").value),
        vehicle: row.querySelector(".vehicle-row-model").value,
      })
    )
    .filter((vehicle) => vehicle.plate || vehicle.vehicle);
  return [primary, ...extra].filter((vehicle, index, list) => vehicle.plate || vehicle.vehicle || index === 0).filter((vehicle, index, list) => {
    if (!vehicle.plate) return true;
    return list.findIndex((item) => item.plate === vehicle.plate) === index;
  });
}

function fillClientForm(client) {
  const vehicles = clientVehicles(client);
  const primary = vehicles[0] || primaryVehicle(client);
  $("#clientId").value = client.id;
  $("#clientName").value = client.name;
  $("#clientWhatsapp").value = client.whatsapp;
  $("#clientPlate").value = primary.plate || "";
  $("#clientBrand").value = primary.brand || detectBrandFromVehicle(primary.vehicle);
  $("#clientVehicle").value = primary.vehicle || "";
  $("#clientVehicleRows").innerHTML = "";
  vehicles.slice(1).forEach(addClientVehicleRow);
}

function resetServiceForm() {
  $("#serviceId").value = "";
  $("#serviceName").value = "";
  $("#servicePrice").value = "";
  $("#serviceCurrency").value = "ARS";
  $("#serviceCategory").value = "Lavados";
  $("#serviceDescription").value = "";
}

function resetProductForm() {
  $("#productId").value = "";
  $("#productName").value = "";
  $("#productPrice").value = "";
  $("#productStock").value = "";
  $("#productMinStock").value = "";
  $("#productDescription").value = "";
}

function resetAppointmentForm() {
  $("#appointmentId").value = "";
  $("#appointmentClient").value = "";
  updateVehicleSelect("appointmentVehicle", "");
  $("#appointmentGuestName").value = "";
  $("#appointmentGuestWhatsapp").value = "";
  $("#appointmentService").value = state.services[0]?.id || "";
  $("#appointmentDate").value = today();
  $("#appointmentTime").value = "09:00";
  $("#appointmentStatus").value = "Pendiente";
  $("#appointmentNotes").value = "";
  const title = $("#appointmentFormTitle");
  if (title) title.textContent = "Agendar turno";
  updateAppointmentVehicleInfo();
}

function setAppointmentFormOpen(open, { focus = false } = {}) {
  const form = $("#appointmentForm");
  if (!form) return;
  form.hidden = !open;
  const button = $("#openAppointmentForm");
  if (button) button.textContent = open ? "Formulario abierto" : "Agendar turno";
  if (open && focus) {
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function resetPaymentForm() {
  hidePaymentDone();
  $("#paymentId").value = "";
  $("#paymentClient").value = "";
  updateVehicleSelect("paymentVehicle", "");
  $("#paymentGuestName").value = "";
  $("#paymentGuestWhatsapp").value = "";
  $("#paymentAppointment").value = "";
  $("#paymentItemType").value = state.services[0] ? "service" : "product";
  $("#paymentServiceChoice").value = state.services[0]?.id || "";
  $("#paymentProductChoice").value = state.products[0]?.id || "";
  syncPaymentItemSelection();
  $("#paymentQuantity").value = 1;
  $("#paymentDate").value = today();
  $("#paymentAmount").value = 0;
  $("#paymentReceived").value = "";
  $("#paymentChange").value = formatCurrency(0, "ARS");
  $("#paymentChange").className = "";
  $("#paymentType").value = "Pago total";
  $("#paymentCurrency").value = "ARS";
  $("#paymentMethod").value = "Efectivo";
  $("#paymentNotes").value = "";
  paymentDraftItems = [];
  updatePaymentCalculation(true);
  renderPaymentTicket();
  renderPaymentCatalog();
}

function resetQuoteForm() {
  $("#quoteId").value = "";
  $("#quoteClient").value = state.clients[0]?.id || "";
  updateVehicleSelect("quoteVehicle", $("#quoteClient").value);
  $("#quoteValidUntil").value = addDays(7);
  $("#quoteNotes").value = "";
  $("#quoteItems").innerHTML = "";
  addItemRow("#quoteItems");
  updateQuoteTotal();
}

function resetInvoiceForm() {
  $("#invoiceId").value = "";
  $("#invoiceClient").value = state.clients[0]?.id || "";
  $("#invoiceQuote").value = "";
  $("#invoiceDate").value = today();
  $("#invoiceStatus").value = "Pendiente";
  $("#invoiceNotes").value = "";
  $("#invoiceItems").innerHTML = "";
  addItemRow("#invoiceItems");
  updateInvoiceTotal();
}

function resetTemplateForm() {
  $("#templateId").value = "";
  $("#templateName").value = "";
  $("#templateClient").value = state.clients[0]?.id || "";
  $("#templateBody").value = state.whatsappTemplates[0]?.body || "";
  updateTemplatePreview();
}

function addItemRow(containerSelector, item = { desc: "", qty: 1, price: "" }) {
  const template = $("#itemTemplate").content.cloneNode(true);
  const row = template.querySelector(".item-row");
  const serviceSelect = row.querySelector(".item-service");
  serviceSelect.innerHTML = serviceOptions(item.serviceId);
  serviceSelect.value = item.serviceId || "";
  row.querySelector(".item-desc").value = item.desc || "";
  row.querySelector(".item-qty").value = item.qty || 1;
  row.querySelector(".item-price").value = item.price || "";
  row.querySelector(".item-currency").value = normalizeCurrency(item.currency);
  serviceSelect.addEventListener("change", () => {
    const service = getService(serviceSelect.value);
    if (service) {
      row.querySelector(".item-desc").value = service.name;
      row.querySelector(".item-price").value = service.price;
      row.querySelector(".item-currency").value = normalizeCurrency(service.currency);
    }
    updateQuoteTotal();
    updateInvoiceTotal();
  });
  row.querySelector(".remove-item").addEventListener("click", () => {
    row.remove();
    updateQuoteTotal();
    updateInvoiceTotal();
  });
  row.querySelectorAll("input, select").forEach((input) => {
    const recalculate = () => {
      updateQuoteTotal();
      updateInvoiceTotal();
    };
    input.addEventListener("input", recalculate);
    input.addEventListener("change", recalculate);
  });
  $(containerSelector).appendChild(row);
}

function readItems(containerSelector) {
  return $$(containerSelector + " .item-row")
    .map((row) => ({
      serviceId: row.querySelector(".item-service").value,
      desc: row.querySelector(".item-desc").value.trim(),
      qty: Number(row.querySelector(".item-qty").value || 1),
      price: Number(row.querySelector(".item-price").value || 0),
      currency: normalizeCurrency(row.querySelector(".item-currency").value),
    }))
    .filter((item) => item.desc);
}

function updateQuoteTotal() {
  $("#quoteTotal").textContent = formatTotals(totalsByCurrency(readItems("#quoteItems")));
}

function updateInvoiceTotal() {
  $("#invoiceTotal").textContent = formatTotals(totalsByCurrency(readItems("#invoiceItems")));
}

function receptionServiceItem() {
  if (receptionItemType() === "product") {
    const product = getProduct($("#receptionProduct")?.value);
    return {
      productId: product?.id || "",
      desc: product?.name || "Producto",
      qty: 1,
      price: Number(product?.price || $("#receptionAmount").value || 0),
      currency: "ARS",
    };
  }
  const service = getService($("#receptionService").value);
  const desc = service?.name || "Servicio de detailing";
  const price = Number(service?.price || $("#receptionAmount").value || 0);
  const currency = normalizeCurrency(service?.currency || $("#receptionCurrency").value);
  return { serviceId: service?.id || "", desc, qty: 1, price, currency };
}

function receptionItemType() {
  return $("#receptionItemType")?.value === "product" ? "product" : "service";
}

function syncReceptionItemType() {
  const type = receptionItemType();
  $$(".reception-service-picker").forEach((field) => {
    field.hidden = type !== "service";
  });
  $$(".reception-product-picker").forEach((field) => {
    field.hidden = type !== "product";
  });
  const service = getService($("#receptionService")?.value);
  const product = getProduct($("#receptionProduct")?.value);
  if (type === "product" && product) {
    $("#receptionAmount").value = product.price;
    $("#receptionCurrency").value = "ARS";
  } else if (service) {
    $("#receptionAmount").value = service.price;
    $("#receptionCurrency").value = normalizeCurrency(service.currency);
  }
  renderReceptionSummary();
}

function receptionSelectedVehicle(clientId) {
  if (clientId) {
    return selectedVehicleSnapshot(clientId, $("#receptionVehicle").value);
  }
  return normalizeVehicleEntry({
    id: "reception-vehicle",
    plate: $("#receptionPlate").value,
    brand: $("#receptionBrand").value,
    vehicle: $("#receptionModel").value,
  });
}

function fillReceptionFromClient(clientId) {
  const client = getClient(clientId);
  updateVehicleSelect("receptionVehicle", clientId);
  if (!client) {
    renderReceptionSummary();
    return;
  }
  const vehicle = primaryVehicle(client);
  $("#receptionName").value = client.name || "";
  $("#receptionWhatsapp").value = client.whatsapp || "";
  $("#receptionPlate").value = vehicle?.plate || "";
  $("#receptionBrand").value = vehicle?.brand || "";
  $("#receptionModel").value = vehicle?.vehicle || "";
  renderReceptionSummary();
}

function fillReceptionFromVehicle() {
  const client = getClient($("#receptionClient").value);
  const vehicle = clientVehicles(client).find((item) => item.id === $("#receptionVehicle").value);
  if (!vehicle) {
    renderReceptionSummary();
    return;
  }
  $("#receptionPlate").value = vehicle.plate || "";
  $("#receptionBrand").value = vehicle.brand || "";
  $("#receptionModel").value = vehicle.vehicle || "";
  renderReceptionSummary();
}

function resetReceptionForm() {
  $("#receptionSearch").value = "";
  $("#receptionClient").value = "";
  updateVehicleSelect("receptionVehicle", "");
  $("#receptionName").value = "";
  $("#receptionWhatsapp").value = "";
  $("#receptionPlate").value = "";
  $("#receptionBrand").value = "";
  $("#receptionModel").value = "";
  $("#receptionItemType").value = "service";
  $("#receptionService").value = state.services[0]?.id || "";
  if ($("#receptionProduct")) $("#receptionProduct").value = state.products[0]?.id || "";
  $("#receptionDate").value = today();
  $("#receptionTime").value = "09:00";
  $("#receptionAmount").value = getService($("#receptionService").value)?.price || "";
  $("#receptionCurrency").value = normalizeCurrency(getService($("#receptionService").value)?.currency);
  $("#receptionNotes").value = "";
  syncReceptionItemType();
  renderReceptionMatches();
  renderReceptionSummary();
}

function ensureReceptionClient() {
  const selectedId = $("#receptionClient").value;
  if (selectedId) return selectedId;

  const name = $("#receptionName").value.trim();
  const whatsapp = $("#receptionWhatsapp").value.trim();
  const vehicle = receptionSelectedVehicle("");
  if (!name) {
    showToast("Cargá el nombre del cliente.", "error");
    return "";
  }
  if (!vehicle.plate) {
    showToast("Cargá la patente del vehículo.", "error");
    return "";
  }

  const client = {
    id: uid("client"),
    name,
    whatsapp,
    plate: vehicle.plate,
    brand: vehicle.brand,
    vehicle: vehicle.vehicle,
    vehicles: [vehicle],
  };
  state.clients.unshift(client);
  $("#receptionClient").value = client.id;
  renderClientOptions();
  $("#receptionClient").value = client.id;
  updateVehicleSelect("receptionVehicle", client.id, vehicle.id);
  return client.id;
}

function receptionPayload() {
  const clientId = ensureReceptionClient();
  if (!clientId) return null;
  const type = receptionItemType();
  const service = getService($("#receptionService").value);
  const product = getProduct($("#receptionProduct")?.value);
  const vehicle = receptionSelectedVehicle(clientId);
  const selectedName = type === "product" ? product?.name || "Producto" : service?.name || "Servicio de detailing";
  const selectedAmount = type === "product" ? Number(product?.price || $("#receptionAmount").value || 0) : Number($("#receptionAmount").value || service?.price || 0);
  const selectedCurrency = type === "product" ? "ARS" : normalizeCurrency(service?.currency || $("#receptionCurrency").value);
  return {
    clientId,
    type,
    service,
    product,
    vehicle,
    serviceId: type === "service" ? service?.id || "" : "",
    productId: type === "product" ? product?.id || "" : "",
    serviceName: selectedName,
    date: $("#receptionDate").value || today(),
    time: $("#receptionTime").value || "09:00",
    notes: $("#receptionNotes").value.trim(),
    amount: selectedAmount,
    currency: selectedCurrency,
  };
}

function createReceptionAppointment() {
  const payload = receptionPayload();
  if (!payload) return;
  if (payload.type === "product") {
    showToast("Para agendar un turno elegí un servicio. Los productos se cobran directo.", "error");
    return;
  }
  state.appointments.unshift({
    id: uid("appointment"),
    clientId: payload.clientId,
    vehicleId: payload.vehicle?.id || "",
    vehicle: payload.vehicle,
    guestName: "",
    guestWhatsapp: "",
    serviceId: payload.serviceId,
    serviceName: payload.serviceName,
    date: payload.date,
    time: payload.time,
    status: "Pendiente",
    notes: payload.notes,
  });
  saveState();
  showToast("Turno creado desde Recepción.");
  switchTab("appointments");
}

function createReceptionQuote() {
  const payload = receptionPayload();
  if (!payload) return;
  const item = receptionServiceItem();
  state.quotes.unshift({
    id: uid("quote"),
    number: nextNumber(state.quotes, "COT"),
    clientId: payload.clientId,
    vehicleId: payload.vehicle?.id || "",
    vehicle: payload.vehicle,
    validUntil: addDays(7),
    notes: payload.notes,
    items: [item],
    totals: totalsByCurrency([item]),
    total: totalItems([item]),
  });
  saveState();
  showToast("Cotización creada desde Recepción.");
  switchTab("quotes");
}

function createReceptionPayment() {
  const payload = receptionPayload();
  if (!payload) return;
  if (payload.type === "product" && payload.product) {
    if (Number(payload.product.stock || 0) <= 0) {
      showToast(`No hay stock disponible de ${payload.product.name}.`, "error");
      return;
    }
  }
  const payment = {
    id: uid("payment"),
    receiptNumber: nextNumber(state.payments, "REC"),
    clientId: payload.clientId,
    vehicleId: payload.vehicle?.id || "",
    vehicle: payload.vehicle,
    guestName: "",
    guestWhatsapp: "",
    appointmentId: "",
    serviceId: payload.serviceId,
    productId: payload.productId,
    quantity: 1,
    serviceName: payload.serviceName,
    items: [
      {
        id: uid("payitem"),
        type: payload.type,
        itemId: payload.type === "product" ? payload.productId : payload.serviceId,
        serviceId: payload.serviceId,
        productId: payload.productId,
        name: payload.serviceName,
        quantity: 1,
        price: payload.amount,
        currency: payload.currency,
      },
    ],
    date: today(),
    amount: payload.amount,
    type: "Pago total",
    currency: payload.currency,
    method: "Efectivo",
    notes: payload.notes || `Cobro rápido recepción ${payload.date} ${payload.time}`,
  };
  adjustStockForPaymentChange(null, payment);
  state.payments.unshift(payment);
  saveState();
  showToast("Cobro creado desde Recepción.");
  switchTab("payments");
}

function renderReceptionMatches() {
  const query = $("#receptionSearch")?.value.trim().toLowerCase() || "";
  const container = $("#receptionMatches");
  if (!container) return;
  if (!query) {
    container.innerHTML = `<div class="empty">Buscá por patente, nombre, WhatsApp, marca o modelo.</div>`;
    return;
  }
  const matches = state.clients
    .map((client) => ({ client, vehicles: clientVehicles(client) }))
    .filter(({ client, vehicles }) =>
      [client.name, client.whatsapp, ...vehicles.flatMap((vehicle) => [vehicle.plate, vehicle.brand, vehicle.vehicle])].join(" ").toLowerCase().includes(query)
    )
    .slice(0, 6);

  container.innerHTML =
    matches
      .map(({ client, vehicles }) => {
        const vehicle = vehicles[0];
        return `
          <button class="reception-match" type="button" data-reception-client="${client.id}">
            <strong>${client.name}</strong>
            <span>${plateLine(vehicle?.plate, `${vehicle?.brand || "Vehículo"} ${vehicle?.vehicle || ""} · ${client.whatsapp || "Sin WhatsApp"}`)}</span>
          </button>
        `;
      })
      .join("") || `<div class="empty">No encontré coincidencias. Podés cargarlo como cliente nuevo.</div>`;
}

function renderReceptionSummary() {
  const container = $("#receptionSummary");
  if (!container) return;
  const client = getClient($("#receptionClient")?.value);
  const service = getService($("#receptionService")?.value);
  const product = getProduct($("#receptionProduct")?.value);
  const type = receptionItemType();
  const vehicle = receptionSelectedVehicle(client?.id || "");
  const name = $("#receptionName")?.value.trim() || client?.name || "Cliente sin nombre";
  const whatsapp = $("#receptionWhatsapp")?.value.trim() || client?.whatsapp || "Sin WhatsApp";
  const itemName = type === "product" ? product?.name || "Elegí un producto" : service?.name || "Elegí un servicio";
  const amount = Number($("#receptionAmount")?.value || (type === "product" ? product?.price : service?.price) || 0);
  const currency = type === "product" ? "ARS" : normalizeCurrency(service?.currency || $("#receptionCurrency")?.value);
  const date = $("#receptionDate")?.value || today();
  const time = $("#receptionTime")?.value || "09:00";
  container.innerHTML = `
    <div class="reception-summary-top">
      <strong>${escapeHtml(name)}</strong>
      <span>${escapeHtml(whatsapp)}</span>
    </div>
    <div class="reception-summary-vehicle">
      ${plateBadge(vehicle?.plate, true)}
      <span>${escapeHtml([vehicle?.brand, vehicle?.vehicle].filter(Boolean).join(" ") || "Vehículo sin completar")}</span>
    </div>
    <div class="reception-summary-grid">
      <article>
        <span>${type === "product" ? "Producto" : "Servicio"}</span>
        <strong>${escapeHtml(itemName)}</strong>
      </article>
      <article>
        <span>Turno</span>
        <strong>${dateLabel(date)} · ${escapeHtml(time)}</strong>
      </article>
      <article>
        <span>Total</span>
        <strong>${formatCurrency(amount, currency)}</strong>
      </article>
    </div>
  `;
}

function renderClientOptions() {
  const options = state.clients
    .map((client) => {
      const count = clientVehicles(client).length;
      return `<option value="${client.id}">${client.name} · ${count} vehículo${count === 1 ? "" : "s"}</option>`;
    })
    .join("");
  $("#quoteClient").innerHTML = options || `<option value="">Cargá un cliente primero</option>`;
  $("#invoiceClient").innerHTML = options || `<option value="">Cargá un cliente primero</option>`;
  $("#appointmentClient").innerHTML = `<option value="">Sin cliente agendado</option>${options}`;
  $("#paymentClient").innerHTML = `<option value="">Cobro sin cliente</option>${options}`;
  $("#receptionClient").innerHTML = `<option value="">Cliente nuevo / sin agendar</option>${options}`;
  $("#templateClient").innerHTML = options || `<option value="">Cargá un cliente primero</option>`;
  updateVehicleSelect("quoteVehicle", $("#quoteClient").value, $("#quoteVehicle")?.value || "");
  updateVehicleSelect("paymentVehicle", $("#paymentClient").value, $("#paymentVehicle")?.value || "");
  updateVehicleSelect("receptionVehicle", $("#receptionClient").value, $("#receptionVehicle")?.value || "");
  updateAppointmentVehicleInfo();
}

function updateAppointmentVehicleInfo(selectedVehicleId = "") {
  const info = $("#appointmentVehicleInfo");
  const select = $("#appointmentVehicle");
  const client = getClient($("#appointmentClient").value);
  updateVehicleSelect("appointmentVehicle", client?.id || "", selectedVehicleId || select?.value || "");
  if (!info) return;
  if (!client) {
    info.textContent = "Seleccioná un cliente para elegir su vehículo.";
    return;
  }
  const count = clientVehicles(client).length;
  info.textContent = count
    ? `Elegí uno de sus ${count} vehículo${count === 1 ? "" : "s"} registrado${count === 1 ? "" : "s"}.`
    : "Este cliente todavía no tiene vehículos cargados.";
}

function renderQuoteOptions() {
  const options = state.quotes
    .map((quote) => {
      const client = getClient(quote.clientId);
      return `<option value="${quote.id}">${quote.number} · ${client?.name || "Cliente eliminado"} · ${recordTotalLabel(quote)}</option>`;
    })
    .join("");
  $("#invoiceQuote").innerHTML = `<option value="">Factura manual</option>${options}`;
}

function renderTimeOptions() {
  const currentValue = $("#appointmentTime").value || "09:00";
  const options = [];
  for (let hour = 8; hour <= 17; hour += 1) {
    for (let minute = 0; minute < 60; minute += 30) {
      if (hour === 17 && minute > 0) continue;
      const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      options.push(`<option value="${value}">${value}</option>`);
    }
  }
  $("#appointmentTime").innerHTML = options.join("");
  $("#receptionTime").innerHTML = options.join("");
  $("#appointmentTime").value = options.some((option) => option.includes(`value="${currentValue}"`)) ? currentValue : "09:00";
  $("#receptionTime").value = $("#receptionTime").value || "09:00";
}

function serviceOptions(selectedId = "") {
  const options = state.services
    .map((service) => `<option value="${service.id}" ${service.id === selectedId ? "selected" : ""}>${serviceOptionLabel(service)}</option>`)
    .join("");
  return `<option value="">Servicio personalizado</option>${options}`;
}

function renderAppointmentServiceOptions() {
  const currentPaymentValue = $("#paymentService")?.value || "";
  const options = state.services
    .map((service) => `<option value="${service.id}">${serviceOptionLabel(service)}</option>`)
    .join("");
  $("#appointmentService").innerHTML = options || `<option value="">Cargá un servicio primero</option>`;
  const paymentServiceOptions = state.services
    .map((service) => `<option value="${service.id}">${serviceOptionLabel(service)}</option>`)
    .join("");
  const paymentProductOptions = state.products
    .map((product) => `<option value="${product.id}">${product.name} · ${formatMoney(product.price)} · Stock ${product.stock}</option>`)
    .join("");
  $("#paymentServiceChoice").innerHTML = paymentServiceOptions || `<option value="">Cargá un servicio primero</option>`;
  $("#paymentProductChoice").innerHTML = paymentProductOptions || `<option value="">Cargá un producto primero</option>`;
  if (currentPaymentValue) setPaymentItemSelection(currentPaymentValue);
  else syncPaymentItemSelection();
  $("#receptionService").innerHTML = options || `<option value="">Cargá un servicio primero</option>`;
  if ($("#receptionProduct")) $("#receptionProduct").innerHTML = paymentProductOptions || `<option value="">Cargá un producto primero</option>`;
  updatePaymentCalculation(true);
  renderPaymentCatalog();
  syncReceptionItemType();
}

function renderPaymentAppointmentOptions() {
  const options = sortedAppointments()
    .map((appointment) => {
      const client = appointmentClient(appointment);
      const vehicle = recordVehicle(appointment, getClient(appointment.clientId));
      const service = getService(appointment.serviceId);
      return `<option value="${appointment.id}">${appointment.date} ${appointment.time} · ${client.name}${vehicle?.plate ? " · " + vehicle.plate : ""} · ${service?.name || appointment.serviceName || "Servicio"}</option>`;
    })
    .join("");
  $("#paymentAppointment").innerHTML = `<option value="">Cobro sin turno</option>${options}`;
}

function updatePaymentCalculation(force = false) {
  const select = $("#paymentService");
  if (!select) return;
  const parsed = syncPaymentItemSelection();
  const qtyInput = $("#paymentQuantity");
  const amountInput = $("#paymentAmount");
  const hint = $("#paymentCalcHint");
  const quantity = parsed.type === "product" ? Math.max(1, Number(qtyInput?.value || 1)) : 1;
  if (qtyInput) {
    qtyInput.value = quantity;
    qtyInput.closest("label").hidden = parsed.type !== "product";
  }
  const unitPrice = paymentItemPrice(parsed);
  const total = unitPrice * quantity;
  const currency = paymentItemCurrency(parsed);
  if (parsed.item && !paymentDraftItems.length) $("#paymentCurrency").value = currency;
  if (!hint) return;
  if (!parsed.item) {
    hint.textContent = "Elegí un servicio o un producto y el sistema calcula el total.";
    updatePaymentChange();
    return;
  }
  if (parsed.type === "product") {
    hint.innerHTML = `<span>Listo para sumar</span><strong>${parsed.item.name}</strong><em>${formatMoney(unitPrice)} x ${quantity} = ${formatMoney(total)} · Stock ${parsed.item.stock}</em>`;
    updatePaymentChange();
    return;
  }
  hint.innerHTML = `<span>Listo para sumar</span><strong>${parsed.item.name}</strong><em>${formatCurrency(unitPrice, currency)}</em>`;
  updatePaymentChange();
}

function updatePaymentChange() {
  const amountInput = $("#paymentAmount");
  const receivedInput = $("#paymentReceived");
  const changeInput = $("#paymentChange");
  if (!amountInput || !receivedInput || !changeInput) return;
  const currency = normalizeCurrency($("#paymentCurrency")?.value);
  const total = Number(amountInput.value || 0);
  const received = Number(receivedInput.value || 0);
  const difference = received - total;
  if (!received) {
    changeInput.value = formatCurrency(0, currency);
    changeInput.className = "";
    return;
  }
  if (difference < 0) {
    changeInput.value = `Faltan ${formatCurrency(Math.abs(difference), currency)}`;
    changeInput.className = "payment-change-negative";
    return;
  }
  changeInput.value = formatCurrency(difference, currency);
  changeInput.className = difference > 0 ? "payment-change-positive" : "";
}

function refreshItemServiceOptions() {
  $$(".item-service").forEach((select) => {
    const value = select.value;
    select.innerHTML = serviceOptions(value);
    select.value = getService(value) ? value : "";
  });
}

function renderClients() {
  const query = "";
  const clients = state.clients.filter((client) =>
    [client.name, client.whatsapp, clientBrand(client), ...clientVehicles(client).flatMap((vehicle) => [vehicle.plate, vehicle.brand, vehicle.vehicle])].join(" ").toLowerCase().includes(query)
  );
  const vehicleTotal = state.clients.reduce((total, client) => total + clientVehicles(client).length, 0);
  const whatsappCount = state.clients.filter((client) => String(client.whatsapp || "").trim()).length;
  $("#clientSummary").innerHTML = `
    <article>
      <span>Clientes</span>
      <strong>${state.clients.length}</strong>
      <small>registrados</small>
    </article>
    <article>
      <span>Vehículos</span>
      <strong>${vehicleTotal}</strong>
      <small>cargados</small>
    </article>
    <article>
      <span>WhatsApp</span>
      <strong>${whatsappCount}</strong>
      <small>contactos útiles</small>
    </article>
    <article>
      <span>Vista actual</span>
      <strong>${clients.length}</strong>
      <small>resultado${clients.length === 1 ? "" : "s"}</small>
    </article>
  `;
  $("#clientListTitle").textContent = `${clients.length} cliente${clients.length === 1 ? "" : "s"} en pantalla`;
  $("#clientsTable").innerHTML =
    clients.length
      ? `
        <section class="client-sheet panel">
          <div class="client-sheet-top">
            <div>
              <p class="eyebrow">Planilla de clientes</p>
              <h3>Clientes y vehículos</h3>
            </div>
            <span>${vehicleTotal} vehículo${vehicleTotal === 1 ? "" : "s"} cargado${vehicleTotal === 1 ? "" : "s"}</span>
          </div>
          <div class="client-sheet-head" aria-hidden="true">
            <span>Cliente</span>
            <span>WhatsApp</span>
            <span>Vehículos</span>
            <span>Actividad</span>
            <span>Acciones</span>
          </div>
          ${clients.map(clientSheetRow).join("")}
        </section>
      `
      : `<div class="empty">Todavía no hay clientes cargados.</div>`;
  renderClientHistory();
}

function clientSheetRow(client) {
  const vehicles = clientVehicles(client);
  const appointments = state.appointments.filter((item) => item.clientId === client.id).length;
  const payments = state.payments.filter((item) => item.clientId === client.id);
  const quotes = state.quotes.filter((item) => item.clientId === client.id).length;
  const paidTotals = sumPayments(payments);
  const vehicleList = vehicles.length
    ? vehicles
        .map(
          (vehicle) => `
            <div class="client-sheet-vehicle">
              ${brandBadge(vehicle.brand)}
              <div>
                <strong>${vehicle.vehicle || "Vehículo sin detalle"}</strong>
                <small>${vehicle.brand || "Marca sin definir"}</small>
              </div>
              ${plateBadge(vehicle.plate, true)}
            </div>
          `
        )
        .join("")
    : `<div class="client-sheet-empty">Sin vehículos cargados.</div>`;
  return `
    <article class="client-sheet-row">
      <div class="client-sheet-person">
        <div class="client-avatar">${String(client.name || "?").trim().slice(0, 1).toUpperCase()}</div>
        <div>
          <strong>${client.name || "Cliente sin nombre"}</strong>
          <small>${vehicles.length} vehículo${vehicles.length === 1 ? "" : "s"}</small>
        </div>
      </div>
      <div class="client-sheet-whatsapp">
        <strong>${formatWhatsappDisplay(client.whatsapp)}</strong>
        <small>${client.whatsapp ? "contacto cargado" : "sin WhatsApp"}</small>
      </div>
      <div class="client-sheet-vehicles">${vehicleList}</div>
      <div class="client-sheet-activity">
        <strong>${formatCompactTotals(paidTotals)}</strong>
        <small>${appointments} turno${appointments === 1 ? "" : "s"} · ${payments.length} cobro${payments.length === 1 ? "" : "s"} · ${quotes} cot.</small>
      </div>
      <div class="record-actions client-sheet-actions">
        <button class="secondary" data-edit-client="${client.id}">Editar</button>
        <button class="secondary" data-history-client="${client.id}">Historial</button>
        <button class="primary" data-appointment-client="${client.id}">Turno</button>
        <button class="danger" data-delete-client="${client.id}">Eliminar</button>
      </div>
    </article>
  `;
}

function renderClientHistory() {
  const client = getClient(selectedClientHistoryId) || state.clients[0];
  if (!client) {
    $("#clientHistoryTitle").textContent = "Seleccioná un cliente";
    $("#clientHistoryClientFilter").innerHTML = "";
    $("#clientHistoryVehicleFilter").innerHTML = "";
    $("#vehicleHistorySummary").innerHTML = "";
    $("#clientHistory").innerHTML = `<div class="empty">Cuando cargues clientes, acá vas a ver sus turnos, cobros, cotizaciones y facturas.</div>`;
    return;
  }

  selectedClientHistoryId = client.id;
  const vehicles = clientVehicles(client);
  $("#clientHistoryClientFilter").innerHTML = state.clients
    .map((item) => `<option value="${item.id}" ${item.id === client.id ? "selected" : ""}>${item.name} · ${clientVehicles(item).length} vehículo${clientVehicles(item).length === 1 ? "" : "s"}</option>`)
    .join("");
  $("#clientHistoryClientFilter").value = client.id;
  if (selectedClientHistoryVehicleId && !vehicles.some((vehicle) => vehicle.id === selectedClientHistoryVehicleId)) {
    selectedClientHistoryVehicleId = "";
  }
  $("#clientHistoryVehicleFilter").innerHTML =
    `<option value="">Todos los vehículos</option>` +
    vehicles.map((vehicle) => `<option value="${vehicle.id}" ${vehicle.id === selectedClientHistoryVehicleId ? "selected" : ""}>${vehicleOptionLabel(vehicle)}</option>`).join("");
  $("#clientHistoryVehicleFilter").value = selectedClientHistoryVehicleId;

  const selectedVehicle = vehicles.find((vehicle) => vehicle.id === selectedClientHistoryVehicleId) || null;
  const appointments = state.appointments.filter((item) => item.clientId === client.id && vehicleMatchesRecord(item, client, selectedClientHistoryVehicleId));
  const payments = state.payments.filter((item) => item.clientId === client.id && vehicleMatchesRecord(item, client, selectedClientHistoryVehicleId));
  const quotes = state.quotes.filter((item) => item.clientId === client.id && vehicleMatchesRecord(item, client, selectedClientHistoryVehicleId));
  const invoices = state.invoices.filter((item) => item.clientId === client.id && vehicleMatchesRecord(item, client, selectedClientHistoryVehicleId));
  const paidTotals = payments.reduce(
    (totals, payment) => {
      totals[normalizeCurrency(payment.currency)] += Number(payment.amount || 0);
      return totals;
    },
    { ARS: 0, USD: 0 }
  );
  const movementTotal = appointments.length + payments.length + quotes.length + invoices.length;
  const vehicleText = (vehicle) => [vehicle?.brand, vehicle?.vehicle, vehicle?.plate].filter(Boolean).join(" · ") || "Sin vehículo";
  const movements = [
    ...appointments.map((appointment) => {
      const service = getService(appointment.serviceId);
      const status = appointmentPaymentStatus(appointment);
      const vehicle = recordVehicle(appointment, client);
      return {
        date: appointment.date,
        time: appointment.time,
        kind: "Turno",
        title: service?.name || appointment.serviceName || "Servicio",
        detail: `${vehicleText(vehicle)} · ${appointment.status} · ${status.label}`,
        value: appointment.time || "",
        tone: "agenda",
      };
    }),
    ...payments.map((payment) => {
      const vehicle = recordVehicle(payment, client);
      return {
        date: payment.date,
        time: "",
        kind: "Cobro",
        title: paymentItemLabel(payment),
        detail: `${vehicleText(vehicle)} · ${payment.method}`,
        value: formatCurrency(payment.amount, payment.currency),
        tone: "payment",
      };
    }),
    ...quotes.map((quote) => {
      const vehicle = recordVehicle(quote, client);
      return {
        date: quote.validUntil,
        time: "",
        kind: "Cotización",
        title: quote.number,
        detail: `${vehicleText(vehicle)} · vence ${quote.validUntil}`,
        value: recordTotalLabel(quote),
        tone: "quote",
      };
    }),
    ...invoices.map((invoice) => {
      const vehicle = recordVehicle(invoice, client);
      return {
        date: invoice.date || invoice.validUntil || "",
        time: "",
        kind: "Factura",
        title: invoice.number,
        detail: `${vehicleText(vehicle)} · ${invoice.status}`,
        value: recordTotalLabel(invoice),
        tone: "invoice",
      };
    }),
  ].sort((a, b) => `${b.date || ""} ${b.time || ""}`.localeCompare(`${a.date || ""} ${a.time || ""}`));

  $("#clientHistoryTitle").innerHTML = `${client.name} · ${selectedVehicle ? `${selectedVehicle.brand} ${plateBadge(selectedVehicle.plate, true)}` : `${vehicles.length} vehículo${vehicles.length === 1 ? "" : "s"}`}`;
  $("#vehicleHistorySummary").innerHTML = `
    <article>
      <span>Vehículo</span>
      <strong>${selectedVehicle ? selectedVehicle.vehicle || selectedVehicle.brand : "Todos"}</strong>
      <small>${selectedVehicle ? selectedVehicle.brand : `${vehicles.length} cargado${vehicles.length === 1 ? "" : "s"}`}</small>
    </article>
    <article>
      <span>Patente</span>
      <strong>${selectedVehicle ? plateBadge(selectedVehicle.plate, true) : "General"}</strong>
      <small>${selectedVehicle ? "historial individual" : "historial completo"}</small>
    </article>
    <article>
      <span>Movimientos</span>
      <strong>${movementTotal}</strong>
      <small>turnos, cobros y documentos</small>
    </article>
    <article>
      <span>Cobrado</span>
      <strong>${formatTotals(paidTotals)}</strong>
      <small>sobre este filtro</small>
    </article>
  `;
  $("#clientHistory").innerHTML = `
    <section class="history-timeline">
      <div class="history-timeline-head">
        <div>
          <p class="eyebrow">Últimos movimientos</p>
          <h4>${movements.length ? `${Math.min(movements.length, 10)} registros recientes` : "Sin movimientos"}</h4>
        </div>
        <span>${selectedVehicle ? "Historial del vehículo" : "Historial completo"}</span>
      </div>
      ${movements.length ? movements.slice(0, 10).map(historyTimelineItem).join("") : `<div class="empty">Este cliente todavía no tiene movimientos registrados.</div>`}
    </section>
    <aside class="history-breakdown">
      ${historyColumn("Turnos", appointments.map((appointment) => {
        const service = getService(appointment.serviceId);
        const status = appointmentPaymentStatus(appointment);
        const vehicle = recordVehicle(appointment, client);
        return `${appointment.date} ${appointment.time} · ${vehicle?.plate || "-"} · ${service?.name || appointment.serviceName || "Servicio"} · ${appointment.status} · ${status.label}`;
      }))}
      ${historyColumn("Cobros", payments.map((payment) => {
        const vehicle = recordVehicle(payment, client);
        return `${payment.date} · ${vehicle?.plate || "-"} · ${paymentItemLabel(payment)} · ${formatCurrency(payment.amount, payment.currency)} · ${payment.method}`;
      }), `Total: ${formatTotals(paidTotals)}`)}
      ${historyColumn("Cotizaciones", quotes.map((quote) => {
        const vehicle = recordVehicle(quote, client);
        return `${quote.number} · ${vehicle?.plate || "-"} · ${recordTotalLabel(quote)} · vence ${quote.validUntil}`;
      }))}
      ${historyColumn("Facturas", invoices.map((invoice) => {
        const vehicle = recordVehicle(invoice, client);
        return `${invoice.number} · ${vehicle?.plate || "-"} · ${recordTotalLabel(invoice)} · ${invoice.status}`;
      }))}
    </aside>
  `;
}

function historyTimelineItem(item) {
  return `
    <article class="history-timeline-item ${item.tone}">
      <div class="history-dot"></div>
      <div class="history-movement-main">
        <div class="history-movement-title">
          <span>${item.kind}</span>
          <strong>${item.title}</strong>
        </div>
        <p>${item.detail}</p>
      </div>
      <div class="history-movement-meta">
        <strong>${item.value || "-"}</strong>
        <small>${[item.date, item.time].filter(Boolean).join(" · ")}</small>
      </div>
    </article>
  `;
}

function historyColumn(title, rows, summary = "") {
  const body = rows.length ? rows.slice(0, 6).map((row) => `<p>${row}</p>`).join("") : `<p>Sin movimientos.</p>`;
  return `
    <div class="history-column">
      <h4>${title}</h4>
      ${body}
      ${summary ? `<strong>${summary}</strong>` : ""}
    </div>
  `;
}

function renderServices() {
  renderServiceCategoryFilter();
  const selectedCategory = $("#serviceCategoryFilter").value || "Todos";
  const categories = selectedCategory === "Todos" ? SERVICE_CATEGORIES : [selectedCategory];
  const visibleServices = state.services.filter((service) => categories.includes(serviceCategory(service)));
  const groups = categories
    .map((category) => {
      const services = state.services.filter((service) => serviceCategory(service) === category);
      if (!services.length && selectedCategory !== "Todos") return `<div class="empty">No hay servicios en ${category}.</div>`;
      if (!services.length) return "";
      return `
        <section class="service-sheet-group ${serviceCategoryClass(category)}">
          <div class="service-sheet-category">
            <strong>${category}</strong>
            <span>${services.length} servicio${services.length === 1 ? "" : "s"}</span>
          </div>
          <div class="service-sheet-rows">
            ${services.map((service, index) => serviceSheetRow(service, index)).join("")}
          </div>
        </section>
      `;
    })
    .join("");

  $("#servicesTable").innerHTML = visibleServices.length
    ? `
      <section class="service-sheet panel">
        <div class="service-sheet-top">
          <div>
            <p class="eyebrow">Planilla de precios</p>
            <h3>Servicios cargados</h3>
          </div>
          <span>${visibleServices.length} servicio${visibleServices.length === 1 ? "" : "s"}</span>
        </div>
        <div class="service-sheet-head" aria-hidden="true">
          <span>Tipo</span>
          <span>Servicio</span>
          <span>Detalle</span>
          <span>Precio</span>
          <span>Moneda</span>
          <span>Acciones</span>
        </div>
        ${groups}
      </section>
    `
    : groups || `<div class="empty">Todavía no hay servicios cargados.</div>`;
}

function renderServiceCategoryFilter() {
  const current = $("#serviceCategoryFilter").value || "Todos";
  $("#serviceCategoryFilter").innerHTML = ["Todos", ...SERVICE_CATEGORIES]
    .map((category) => `<option value="${category}">${category}</option>`)
    .join("");
  $("#serviceCategoryFilter").value = ["Todos", ...SERVICE_CATEGORIES].includes(current) ? current : "Todos";
}

function serviceCategoryClass(category = "Otros") {
  return `service-category-${String(category)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}`;
}

function serviceSheetRow(service, index = 0) {
  const category = serviceCategory(service);
  return `
    <article class="service-sheet-row ${index % 2 ? "is-alt" : ""}">
      <div class="service-sheet-type">
        <span>${category}</span>
      </div>
      <div class="service-sheet-name">
        <strong>${service.name}</strong>
      </div>
      <p>${service.description || "Sin detalle."}</p>
      <strong class="service-sheet-price">${formatCurrency(service.price, service.currency)}</strong>
      <span class="service-sheet-currency">${normalizeCurrency(service.currency)}</span>
      <div class="row-actions service-sheet-actions">
        <button class="secondary" data-edit-service="${service.id}">Editar</button>
        <button class="danger" data-delete-service="${service.id}">Eliminar</button>
      </div>
    </article>
  `;
}

function renderProducts() {
  renderStockSmartSummary();
  $("#productsTable").innerHTML =
    state.products
      .map((product) => {
        const isLow = product.stock <= product.minStock;
        const movement = productMovement(product.id);
        return `
          <tr>
            <td><strong>${product.name}</strong></td>
            <td>${product.description || "-"}</td>
            <td>${formatMoney(product.price)}</td>
            <td><span class="stock-pill ${isLow ? "low" : ""}">${product.stock}</span></td>
            <td>${product.minStock}</td>
            <td>${movement.sold} vend. · ${movement.lastSold || "sin ventas"}</td>
            <td>
              <div class="row-actions">
                <button class="secondary" data-edit-product="${product.id}">Editar</button>
                <button class="danger" data-delete-product="${product.id}">Eliminar</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("") || `<tr><td colspan="7">Todavía no hay productos cargados.</td></tr>`;
}

function productMovement(productId) {
  const productPayments = state.payments
    .map((payment) => ({
      payment,
      quantity: paymentProductLines(payment)
        .filter((line) => line.productId === productId)
        .reduce((sum, line) => sum + Number(line.quantity || 0), 0),
    }))
    .filter((entry) => entry.quantity > 0);
  const sold = productPayments.reduce((sum, entry) => sum + entry.quantity, 0);
  const last = productPayments.sort((a, b) => String(b.payment.date || "").localeCompare(String(a.payment.date || "")))[0]?.payment.date || "";
  return { sold, lastSold: last ? dateLabel(last) : "" };
}

function productStockStatus(product) {
  const stock = Number(product.stock || 0);
  const min = Number(product.minStock || 0);
  if (stock <= 0) return { label: "Sin stock", className: "danger", reorder: Math.max(min * 2, 1) };
  if (stock <= min) return { label: "Reponer", className: "warning", reorder: Math.max(min * 2 - stock, min) };
  return { label: "OK", className: "ok", reorder: 0 };
}

function renderStockSmartSummary() {
  const container = $("#stockSmartSummary");
  if (!container) return;
  const products = state.products || [];
  const totalStock = products.reduce((sum, product) => sum + Number(product.stock || 0), 0);
  const low = products.filter((product) => productStockStatus(product).className !== "ok");
  const topProduct = products
    .map((product) => ({ product, movement: productMovement(product.id) }))
    .sort((a, b) => b.movement.sold - a.movement.sold)[0];
  const reorderList = low
    .slice(0, 4)
    .map((product) => {
      const status = productStockStatus(product);
      return `<div class="stock-reorder-row"><strong>${product.name}</strong><span>${status.label} · Stock ${product.stock} · sugerido ${status.reorder}</span></div>`;
    })
    .join("") || `<div class="stock-reorder-row"><strong>Stock saludable</strong><span>No hay productos debajo del mínimo.</span></div>`;
  container.innerHTML = `
    <article class="stock-smart-card">
      <span>Unidades en stock</span>
      <strong>${totalStock}</strong>
      <small>${products.length} producto${products.length === 1 ? "" : "s"} cargado${products.length === 1 ? "" : "s"}</small>
    </article>
    <article class="stock-smart-card ${low.length ? "needs-stock" : ""}">
      <span>Alertas</span>
      <strong>${low.length}</strong>
      <small>${low.length ? "productos para revisar" : "sin urgencias"}</small>
    </article>
    <article class="stock-smart-card">
      <span>Más vendido</span>
      <strong>${topProduct?.movement.sold ? topProduct.product.name : "-"}</strong>
      <small>${topProduct?.movement.sold || 0} unidad${topProduct?.movement.sold === 1 ? "" : "es"} vendida${topProduct?.movement.sold === 1 ? "" : "s"}</small>
    </article>
    <article class="stock-smart-card stock-reorder-card">
      <span>Reposición sugerida</span>
      ${reorderList}
    </article>
  `;
}

function appointmentDateTime(appointment) {
  return `${appointment.date}T${appointment.time || "00:00"}`;
}

function appointmentHasPassed(appointment) {
  if (!appointment?.date) return false;
  const value = new Date(`${appointment.date}T${appointment.time || "00:00"}`);
  return Number.isFinite(value.getTime()) && value.getTime() < Date.now();
}

function sortedAppointments() {
  return [...state.appointments].sort((a, b) => appointmentDateTime(a).localeCompare(appointmentDateTime(b)));
}

function visibleAppointments() {
  return sortedAppointments().filter((appointment) => {
    const paymentStatus = appointmentPaymentStatus(appointment);
    return paymentStatus.className !== "paid" && appointment.status !== "Cancelado";
  });
}

function appointmentsForAgendaFilter() {
  const visible = visibleAppointments();
  const selected = $("#weeklyDate")?.value || today();
  if (agendaFilter === "today") return visible.filter((appointment) => appointment.date === today());
  if (agendaFilter === "tomorrow") return visible.filter((appointment) => appointment.date === addDays(1));
  if (agendaFilter === "week") {
    const start = weekStart(selected);
    const end = addDaysToDate(start, 5);
    return visible.filter((appointment) => appointment.date >= start && appointment.date <= end);
  }
  return visible;
}

function renderAgendaSummary(filteredAppointments = appointmentsForAgendaFilter()) {
  const todayCount = visibleAppointments().filter((appointment) => appointment.date === today()).length;
  const pendingBalance = filteredAppointments.reduce(
    (totals, appointment) => {
      const currency = serviceCurrencyForAppointment(appointment);
      totals[currency] += Number(appointmentPaymentStatus(appointment).balance || 0);
      return totals;
    },
    { ARS: 0, USD: 0 }
  );
  const nextAppointment = filteredAppointments[0];
  const nextClient = nextAppointment ? appointmentClient(nextAppointment) : null;
  const nextService = nextAppointment ? getService(nextAppointment.serviceId) : null;
  $("#agendaSummary").innerHTML = `
    <article>
      <span>Hoy</span>
      <strong>${todayCount}</strong>
      <small>turno${todayCount === 1 ? "" : "s"}</small>
    </article>
    <article>
      <span>Vista actual</span>
      <strong>${filteredAppointments.length}</strong>
      <small>pendiente${filteredAppointments.length === 1 ? "" : "s"}</small>
    </article>
    <article>
      <span>Saldo estimado</span>
      <strong>${formatTotals(pendingBalance)}</strong>
      <small>por cobrar</small>
    </article>
    <article class="agenda-next">
      <span>Próximo</span>
      <strong>${nextAppointment ? `${nextAppointment.time} · ${nextClient.name}` : "Sin turno"}</strong>
      <small>${nextAppointment ? `${dateLabel(nextAppointment.date)} · ${nextService?.name || nextAppointment.serviceName || "Servicio"}` : "Agenda libre"}</small>
    </article>
  `;
}

function appointmentMarkup(appointment) {
  const client = appointmentClient(appointment);
  const vehicle = recordVehicle(appointment, getClient(appointment.clientId));
  const service = getService(appointment.serviceId);
  const serviceName = service?.name || appointment.serviceName || "Servicio eliminado";
  const paymentStatus = appointmentPaymentStatus(appointment);
  return `
    <article class="record appointment-record">
      <div class="appointment-date-box">
        <strong>${appointment.time || "--:--"}</strong>
        <span>${dateLabel(appointment.date)}</span>
      </div>
      <div class="appointment-record-main">
        <div class="appointment-record-head">
          <strong>${client.name}</strong>
          <span class="status-pill ${paymentStatus.className}">${paymentStatus.label}</span>
        </div>
        <p>${plateLine(vehicle?.plate, `${serviceName} · ${appointment.status}`)}</p>
        ${appointment.notes ? `<small>${appointment.notes}</small>` : ""}
      </div>
      <div class="record-actions">
        <button class="secondary" data-edit-appointment="${appointment.id}">Editar</button>
        <button class="primary" data-charge-appointment="${appointment.id}">Cobrar</button>
        <button class="secondary" data-cancel-appointment="${appointment.id}">Cancelar</button>
        <a class="whatsapp" target="_blank" rel="noreferrer" href="${appointmentWhatsappUrl(appointment)}">WhatsApp</a>
        <button class="danger" data-delete-appointment="${appointment.id}">Eliminar</button>
      </div>
    </article>
  `;
}

function renderAppointments() {
  const filtered = appointmentsForAgendaFilter();
  $("#appointmentsList").innerHTML =
    filtered.map((appointment) => appointmentMarkup(appointment)).join("") ||
    `<div class="empty">No hay turnos pendientes de cobro.</div>`;
  renderAgendaSummary(filtered);
  renderWeeklyAgenda();
}

function renderWeeklyAgenda() {
  const selected = $("#weeklyDate").value || today();
  const start = weekStart(selected);
  const dayNames = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const dates = dayNames.map((_, index) => addDaysToDate(start, index));
  const weekAppointments = visibleAppointments().filter((appointment) => appointment.date >= dates[0] && appointment.date <= dates[dates.length - 1]);
  const workHours = Array.from({ length: 10 }, (_, index) => `${String(index + 8).padStart(2, "0")}:00`);
  const appointmentHours = [...new Set(weekAppointments.map((appointment) => `${String(Number(String(appointment.time || "09:00").slice(0, 2)) || 0).padStart(2, "0")}:00`))];
  const timeSlots = [...new Set([...workHours, ...appointmentHours])].sort();
  $("#weeklyDate").value = $("#weeklyDate").value || start;
  $$("#agendaFilter [data-agenda-filter]").forEach((button) => button.classList.toggle("active", button.dataset.agendaFilter === agendaFilter));
  $("#weeklyAgenda").classList.toggle("is-filtered-agenda", ["today", "tomorrow"].includes(agendaFilter));
  $("#weeklyAgenda").innerHTML = `
    <div class="calendar-corner">Hora</div>
    ${dates
      .map((date, index) => {
        const isToday = date === today();
        const isSelected = date === ($("#weeklyDate").value || start);
        const isFilterTarget = agendaFilter === "today" ? date === today() : agendaFilter === "tomorrow" ? date === addDays(1) : true;
        const appointments = weekAppointments.filter((appointment) => appointment.date === date);
        return `
          <section class="calendar-day-head ${isToday ? "is-today" : ""} ${isSelected ? "is-selected" : ""} ${isFilterTarget ? "is-filter-target" : "is-muted-by-filter"}">
            <strong>${dayNames[index]}</strong>
            <span>${dateLabel(date).slice(0, 5)}</span>
            <em>${appointments.length}</em>
          </section>
        `;
      })
      .join("")}
    ${timeSlots
      .map((slot) => {
        const cells = dates
          .map((date) => {
            const isFilterTarget = agendaFilter === "today" ? date === today() : agendaFilter === "tomorrow" ? date === addDays(1) : true;
            const appointments = weekAppointments.filter((appointment) => appointment.date === date && String(appointment.time || "").startsWith(slot.slice(0, 2)));
            const cards = appointments
              .map((appointment) => {
                const client = appointmentClient(appointment);
                const vehicle = recordVehicle(appointment, getClient(appointment.clientId));
                const service = getService(appointment.serviceId);
                const paymentStatus = appointmentPaymentStatus(appointment);
                const serviceLabel = service?.name || appointment.serviceName || "Servicio";
                const vehicleLabel = vehicle?.plate ? `${serviceLabel} · ${vehicle.plate}` : serviceLabel;
                return `
                  <article class="calendar-event week-card" data-edit-appointment="${appointment.id}">
                    <div class="week-card-head">
                      <strong>${appointment.time}</strong>
                      <em class="status-pill ${paymentStatus.className}">${paymentStatus.label}</em>
                    </div>
                    <span>${client.name}</span>
                    <small>${vehicleLabel}</small>
                    <div class="week-card-actions">
                      <button class="secondary" type="button" data-edit-appointment="${appointment.id}">Editar</button>
                      <button class="primary" type="button" data-charge-appointment="${appointment.id}">Cobrar</button>
                    </div>
                  </article>
                `;
              })
              .join("");
            return `<div class="calendar-cell ${isFilterTarget ? "is-filter-target" : "is-muted-by-filter"}">${cards}</div>`;
          })
          .join("");
        return `<div class="calendar-time">${slot}</div>${cells}`;
      })
      .join("")}
  `;
}

function paymentReceiptNumber(payment) {
  return payment.receiptNumber || `REC-${String(state.payments.findIndex((item) => item.id === payment.id) + 1 || state.payments.length + 1).padStart(4, "0")}`;
}

function paymentMarkup(payment) {
  const client = paymentClient(payment);
  const vehicle = recordVehicle(payment, getClient(payment.clientId));
  const type = payment.type || "Pago total";
  const items = paymentReceiptItemLines(payment);
  const itemPreview = items
    .slice(0, 3)
    .map((item) => `<span>${paymentLineLabel(item)} · ${formatCurrency(paymentLineSubtotal(item), item.currency || payment.currency)}</span>`)
    .join("");
  const extraItems = items.length > 3 ? `<em>+${items.length - 3} ítem${items.length - 3 === 1 ? "" : "s"}</em>` : "";
  return `
    <article class="record receipt-card">
      <div class="receipt-stub">
        <span>RECIBO</span>
        <strong>${paymentReceiptNumber(payment)}</strong>
        <small>${dateLabel(payment.date)}</small>
      </div>
      <div class="receipt-card-main">
        <div class="receipt-card-head">
          <div>
            <strong>${client.name}</strong>
            <p>${plateLine(vehicle?.plate, `${vehicle?.vehicle || "Vehículo"} · ${type} · ${payment.method}`)}</p>
          </div>
          <span class="document-total">${formatCurrency(payment.amount, payment.currency)}</span>
        </div>
        <div class="receipt-items-preview">
          ${itemPreview || `<span>${paymentItemLabel(payment)}</span>`}
          ${extraItems}
        </div>
        ${payment.notes ? `<small class="document-note">${payment.notes}</small>` : ""}
      </div>
      <div class="record-actions">
        <button class="secondary" data-edit-payment="${payment.id}">Editar</button>
        <button class="primary" data-payment-receipt="${payment.id}">Recibo</button>
        <button class="secondary" data-download-payment="${payment.id}">Descargar PDF</button>
        <button class="whatsapp" data-share-payment="${payment.id}">WhatsApp PDF</button>
        <button class="danger" data-delete-payment="${payment.id}">Eliminar</button>
      </div>
    </article>
  `;
}

function dashboardAppointmentRow(appointment) {
  const client = appointmentClient(appointment);
  const vehicle = recordVehicle(appointment, getClient(appointment.clientId));
  const service = getService(appointment.serviceId);
  const status = appointmentPaymentStatus(appointment);
  return `
    <article class="mini-row dashboard-row">
      <div>
        <strong>${appointment.time} · ${client.name}</strong>
        <small>${plateLine(vehicle?.plate, `${service?.name || appointment.serviceName || "Servicio"} · ${appointment.status}`)}</small>
      </div>
      <span class="status-pill ${status.className}">${status.label}</span>
    </article>
  `;
}

function dashboardQuoteRow(quote) {
  const client = getClient(quote.clientId);
  const vehicle = recordVehicle(quote, client);
  return `
    <article class="mini-row dashboard-row">
      <div>
        <strong>${quote.number} · ${client?.name || "Cliente eliminado"}</strong>
        <small>${plateLine(vehicle?.plate, `vence ${quote.validUntil}`)}</small>
      </div>
      <span>${recordTotalLabel(quote)}</span>
    </article>
  `;
}

function dashboardProductRow(product) {
  return `
    <article class="mini-row dashboard-row">
      <div>
        <strong>${product.name}</strong>
        <small>Stock actual ${product.stock} · mínimo ${product.minStock}</small>
      </div>
      <span>Reponer</span>
    </article>
  `;
}

function renderPayments() {
  renderCashDashboard();
  const query = "";
  const method = $("#paymentMethodFilter").value;
  const currency = $("#paymentCurrencyFilter").value;
  const payments = state.payments
    .filter((payment) => {
      const client = getClient(payment.clientId);
      const cashClient = paymentClient(payment);
      const vehicle = recordVehicle(payment, client);
      const haystack = [
        paymentReceiptNumber(payment),
        cashClient.name,
        cashClient.whatsapp,
        vehicle?.plate,
        vehicle?.vehicle,
        vehicle?.brand,
        paymentItemLabel(payment),
        payment.method,
        payment.type,
        payment.notes,
      ]
        .join(" ")
        .toLowerCase();
      return (!query || haystack.includes(query)) && (!method || payment.method === method) && (!currency || normalizeCurrency(payment.currency) === currency);
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  $("#paymentsList").innerHTML =
    payments
      .map((payment) => paymentMarkup(payment))
      .join("") || `<div class="empty">Todavía no hay cobros cargados.</div>`;
}

function pendingAppointmentBalances() {
  return sortedAppointments()
    .map((appointment) => {
      const status = appointmentPaymentStatus(appointment);
      const client = appointmentClient(appointment);
      const service = getService(appointment.serviceId);
      return { appointment, status, client, service };
    })
    .filter((item) => item.status.balance > 0 && item.status.total > 0 && !["Cancelado"].includes(item.appointment.status));
}

function renderCashDashboard() {
  const todayPayments = state.payments.filter((payment) => payment.date === today());
  const monthPayments = state.payments.filter((payment) => monthMatches(payment.date, currentMonth()));
  const pendingTotals = pendingAppointmentBalances().reduce(
    (totals, item) => {
      totals[serviceCurrencyForAppointment(item.appointment)] += Number(item.status.balance || 0);
      return totals;
    },
    { ARS: 0, USD: 0 }
  );
  $("#cashToday").textContent = formatTotals(sumPayments(todayPayments));
  $("#cashMonth").textContent = formatTotals(sumPayments(monthPayments));
  $("#cashPending").textContent = formatTotals(pendingTotals);
  $("#cashCount").textContent = state.payments.length;
  renderCashClosing();
  renderPendingBalances();
}

function renderCashClosing() {
  const date = $("#cashDate").value || today();
  $("#cashDate").value = date;
  const dayPayments = state.payments.filter((payment) => payment.date === date);
  const byMethod = dayPayments.reduce((acc, payment) => {
    const key = payment.method || "Sin método";
    acc[key] ||= { ARS: 0, USD: 0 };
    acc[key][normalizeCurrency(payment.currency)] += Number(payment.amount || 0);
    return acc;
  }, {});
  const byCurrency = dayPayments.reduce(
    (totals, payment) => {
      totals[normalizeCurrency(payment.currency)] += Number(payment.amount || 0);
      return totals;
    },
    { ARS: 0, USD: 0 }
  );
  const cashTotal = dayPayments
    .filter((payment) => payment.method === "Efectivo")
    .reduce(
      (totals, payment) => {
        totals[normalizeCurrency(payment.currency)] += Number(payment.amount || 0);
        return totals;
      },
      { ARS: 0, USD: 0 }
    );
  const digitalTotal = dayPayments
    .filter((payment) => payment.method !== "Efectivo")
    .reduce(
      (totals, payment) => {
        totals[normalizeCurrency(payment.currency)] += Number(payment.amount || 0);
        return totals;
      },
      { ARS: 0, USD: 0 }
    );
  const rows = Object.entries(byMethod)
    .map(([method, totals]) => `<article class="mini-row"><strong>${method}</strong><span>${formatTotals(totals)}</span></article>`)
    .join("");
  $("#cashClosingSummary").innerHTML = `
    <article>
      <span>Total del día</span>
      <strong>${formatTotals(byCurrency)}</strong>
      <small>${dayPayments.length} cobro${dayPayments.length === 1 ? "" : "s"}</small>
    </article>
    <article>
      <span>Efectivo</span>
      <strong>${formatTotals(cashTotal)}</strong>
      <small>para contar en caja</small>
    </article>
    <article>
      <span>Digital</span>
      <strong>${formatTotals(digitalTotal)}</strong>
      <small>transferencia, MP y tarjeta</small>
    </article>
  `;
  $("#cashMethodGrid").innerHTML =
    Object.entries(byMethod)
      .map(([method, totals]) => `<article><span>${method}</span><strong>${formatTotals(totals)}</strong></article>`)
      .join("") || `<div class="empty">No hay métodos para esta fecha.</div>`;
  $("#cashClosing").innerHTML =
    `<article class="mini-row total-row"><strong>Total del día</strong><span>${formatTotals(byCurrency)}</span></article>` +
    (rows || `<div class="empty">No hay cobros en esta fecha.</div>`);
}

function renderPendingBalances() {
  $("#pendingBalances").innerHTML =
    pendingAppointmentBalances()
      .slice(0, 8)
      .map(({ appointment, status, client, service }) => {
        const currency = serviceCurrencyForAppointment(appointment);
        const vehicle = recordVehicle(appointment, getClient(appointment.clientId));
        return `
          <article class="mini-row balance-row">
            <div>
              <strong>${client.name}</strong>
              <small>${plateLine(vehicle?.plate, `${appointment.date} ${appointment.time} · ${service?.name || appointment.serviceName || "Servicio"}`)}</small>
            </div>
            <div class="balance-actions">
              <span>${formatCurrency(status.balance, currency)}</span>
              <button class="primary" data-charge-balance="${appointment.id}">Cobrar</button>
            </div>
          </article>
        `;
      })
      .join("") || `<div class="empty">No hay saldos pendientes.</div>`;
}

function productRecordMarkup(product) {
  const isLow = product.stock <= product.minStock;
  return `
    <article class="record">
      <div>
        <strong>${product.name} · ${formatMoney(product.price)}</strong>
        <p>Stock: ${product.stock} · Alerta: ${product.minStock}${isLow ? " · Reponer" : ""}</p>
      </div>
      <div class="record-actions">
        <button class="secondary" data-edit-product="${product.id}">Editar</button>
      </div>
    </article>
  `;
}

function recordMarkup(record, type) {
  const client = getClient(record.clientId);
  const vehicle = recordVehicle(record, client);
  const isInvoice = type === "invoice";
  const label = isInvoice ? "Factura" : "Cotización";
  const dateLabelText = isInvoice ? `Fecha ${record.date}` : `Válida hasta ${record.validUntil}`;
  const status = record.status || label;
  const itemCount = (record.items || []).length;
  const itemPreview = documentItemsPreview(record);
  const quoteActions = `
    <button class="primary" data-quote-pdf="${record.id}">PDF</button>
    <button class="secondary" data-download-quote="${record.id}">Descargar PDF</button>
    <button class="whatsapp" data-share-quote="${record.id}">WhatsApp PDF</button>
    <button class="primary" data-invoice-from="${record.id}">Facturar</button>
  `;
  const invoiceActions = `
    <button class="primary" data-pdf="${record.id}">PDF</button>
    <a class="whatsapp" target="_blank" rel="noreferrer" href="${whatsappUrl(record, type)}">WhatsApp</a>
  `;
  return `
    <article class="document-card document-card-${type}">
      <div class="document-card-main">
        <div class="document-card-top">
          <div class="document-id-block">
            <span class="document-type">${label}</span>
            <strong>${record.number}</strong>
          </div>
          <span class="status-pill ${isInvoice && status === "Pagada" ? "paid" : isInvoice ? "unpaid" : "partial"}">${status}</span>
        </div>
        <div class="document-card-title">
          <div>
            <strong>${client?.name || "Cliente eliminado"}</strong>
            <p>${itemCount} concepto${itemCount === 1 ? "" : "s"} · ${dateLabelText}</p>
          </div>
          <span class="document-total">${recordTotalLabel(record)}</span>
        </div>
        <div class="document-meta">
          ${plateLine(vehicle?.plate, `${vehicle?.vehicle || "Vehículo"} · ${dateLabelText}`)}
        </div>
        <div class="document-items-preview">${itemPreview}</div>
        ${record.notes ? `<small class="document-note">${record.notes}</small>` : ""}
      </div>
      <div class="record-actions document-actions">
        <button class="secondary" data-edit-${type}="${record.id}">Editar</button>
        ${isInvoice ? invoiceActions : quoteActions}
        <button class="danger" data-delete-${type}="${record.id}">Eliminar</button>
      </div>
    </article>
  `;
}

function documentItemsPreview(record) {
  const items = record.items || [];
  if (!items.length) return `<span>Sin conceptos detallados.</span>`;
  const rows = items
    .slice(0, 3)
    .map((item) => `<span>${item.desc || "Servicio"} · ${item.qty || 1} x ${formatCurrency(item.price || 0, item.currency)}</span>`)
    .join("");
  const extra = items.length > 3 ? `<em>+${items.length - 3} concepto${items.length - 3 === 1 ? "" : "s"} más</em>` : "";
  return rows + extra;
}

function renderDocumentSummary(type) {
  const isInvoice = type === "invoice";
  const records = isInvoice ? state.invoices : state.quotes;
  const target = isInvoice ? $("#invoiceSummary") : $("#quoteSummary");
  if (!target) return;
  const totals = records.reduce(
    (acc, record) => {
      const recordTotals = record.totals || totalsByCurrency(record.items || []);
      acc.ARS += Number(recordTotals.ARS || 0);
      acc.USD += Number(recordTotals.USD || 0);
      return acc;
    },
    { ARS: 0, USD: 0 }
  );
  const paid = isInvoice ? records.filter((record) => record.status === "Pagada").length : 0;
  const pending = isInvoice ? records.length - paid : records.filter((record) => String(record.validUntil || "") >= today()).length;
  const latest = records[0];
  target.innerHTML = `
    <article>
      <span>${isInvoice ? "Facturas" : "Cotizaciones"}</span>
      <strong>${records.length}</strong>
      <small>documento${records.length === 1 ? "" : "s"} guardado${records.length === 1 ? "" : "s"}</small>
    </article>
    <article>
      <span>${isInvoice ? "Pendientes" : "Vigentes"}</span>
      <strong>${pending}</strong>
      <small>${isInvoice ? "por cobrar/revisar" : "dentro de fecha"}</small>
    </article>
    <article>
      <span>Total emitido</span>
      <strong>${formatTotals(totals)}</strong>
      <small>suma de documentos</small>
    </article>
    <article>
      <span>Último</span>
      <strong>${latest?.number || "-"}</strong>
      <small>${latest ? `${getClient(latest.clientId)?.name || "Cliente eliminado"} · ${recordTotalLabel(latest)}` : "sin movimientos"}</small>
    </article>
  `;
}

function renderQuotes() {
  renderDocumentSummary("quote");
  $("#quotesList").innerHTML =
    state.quotes.map((quote) => recordMarkup(quote, "quote")).join("") ||
    `<div class="empty">Todavía no hay cotizaciones.</div>`;
}

function renderInvoices() {
  renderDocumentSummary("invoice");
  $("#invoicesList").innerHTML =
    state.invoices.map((invoice) => recordMarkup(invoice, "invoice")).join("") ||
    `<div class="empty">Todavía no hay facturas.</div>`;
}

function reportMonthsForComparison(selectedMonth) {
  const months = new Set([selectedMonth || currentMonth()]);
  [...state.payments, ...state.appointments].forEach((item) => {
    const month = String(item.date || "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(month)) months.add(month);
  });
  state.quotes.forEach((quote) => {
    const month = String(quote.validUntil || quote.date || "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(month)) months.add(month);
  });
  state.invoices.forEach((invoice) => {
    const month = String(invoice.date || "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(month)) months.add(month);
  });
  return [...months].sort().reverse().slice(0, 12);
}

function reportMonthStats(month) {
  const payments = state.payments.filter((payment) => monthMatches(payment.date, month));
  const appointments = state.appointments.filter((appointment) => monthMatches(appointment.date, month));
  const quotes = state.quotes.filter((quote) => monthMatches(quote.validUntil || quote.date, month));
  const invoices = state.invoices.filter((invoice) => monthMatches(invoice.date, month));
  const income = sumPayments(payments);
  const arsPayments = payments.filter((payment) => normalizeCurrency(payment.currency) === "ARS").length;
  const usdPayments = payments.filter((payment) => normalizeCurrency(payment.currency) === "USD").length;
  const clientIds = new Set([
    ...payments.map((payment) => payment.clientId || `guest:${payment.guestName || paymentReceiptNumber(payment)}`),
    ...appointments.map((appointment) => appointment.clientId || `guest:${appointment.guestName || appointment.id}`),
  ].filter(Boolean));
  return {
    month,
    payments: payments.length,
    appointments: appointments.length,
    clients: clientIds.size,
    quotes: quotes.length,
    invoices: invoices.length,
    income,
    average: {
      ARS: arsPayments ? income.ARS / arsPayments : 0,
      USD: usdPayments ? income.USD / usdPayments : 0,
    },
  };
}

function renderMonthlyComparison(selectedMonth) {
  const stats = reportMonthsForComparison(selectedMonth).map(reportMonthStats);
  const selectedStats = stats.find((item) => item.month === selectedMonth) || reportMonthStats(selectedMonth);
  const previousStats = reportMonthStats(previousMonth(selectedMonth));
  const bestStats = stats.length ? [...stats].sort((a, b) => compareTotals(b.income, a.income))[0] : null;
  const selectedChange = totalsPercentChange(selectedStats.income, previousStats.income);
  const maxArs = Math.max(...stats.map((item) => Number(item.income.ARS || 0)), 1);
  const maxUsd = Math.max(...stats.map((item) => Number(item.income.USD || 0)), 1);

  $("#reportComparisonSummary").innerHTML = [
    {
      label: "Mes seleccionado",
      value: formatTotals(selectedStats.income),
      detail: `${selectedStats.payments} cobro${selectedStats.payments === 1 ? "" : "s"} · ${selectedStats.appointments} turno${selectedStats.appointments === 1 ? "" : "s"}`,
      tone: "selected",
    },
    {
      label: "Contra mes anterior",
      value: selectedChange.label,
      detail: `${monthLabel(previousStats.month)} · ${formatTotals(previousStats.income)}`,
      tone: selectedChange.className || "neutral",
    },
    {
      label: "Mejor mes registrado",
      value: bestStats ? formatTotals(bestStats.income) : "$0",
      detail: bestStats ? monthLabel(bestStats.month) : "Sin actividad",
      tone: "best",
    },
  ]
    .map((item) => `
      <article class="${item.tone}">
        <span>${item.label}</span>
        <strong>${item.value}</strong>
        <small>${item.detail}</small>
      </article>
    `)
    .join("");

  $("#reportMonthlyComparison").innerHTML = `
    <div class="report-month-head">
      <span>Mes</span>
      <span>Ingresos</span>
      <span>Variación</span>
      <span>Cobros</span>
      <span>Turnos</span>
      <span>Clientes</span>
      <span>Ticket prom.</span>
      <span>Docs</span>
    </div>
    ${stats
      .map((item) => {
        const prev = reportMonthStats(previousMonth(item.month));
        const change = totalsPercentChange(item.income, prev.income);
        const arsWidth = Math.round((Number(item.income.ARS || 0) / maxArs) * 100);
        const usdWidth = Math.round((Number(item.income.USD || 0) / maxUsd) * 100);
        return `
          <article class="report-month-row ${item.month === selectedMonth ? "is-selected" : ""}">
            <strong>${monthLabel(item.month)}</strong>
            <div class="report-month-income">
              <b>${formatTotals(item.income)}</b>
              <div class="report-mini-bars" aria-hidden="true">
                <i class="ars" style="width:${arsWidth}%"></i>
                ${item.income.USD ? `<i class="usd" style="width:${usdWidth}%"></i>` : ""}
              </div>
            </div>
            <span class="report-change ${change.className}">${change.label}</span>
            <span>${item.payments}</span>
            <span>${item.appointments}</span>
            <span>${item.clients}</span>
            <span>${formatTotals(item.average)}</span>
            <span>${item.quotes} cot. · ${item.invoices} fac.</span>
          </article>
        `;
      })
      .join("") || `<div class="empty">No hay meses para comparar todavía.</div>`}
  `;
}

function renderReports() {
  const month = $("#reportMonth").value || currentMonth();
  $("#reportMonth").value = month;
  const monthPayments = state.payments.filter((payment) => monthMatches(payment.date, month));
  const monthQuotes = state.quotes.filter((quote) => monthMatches(quote.validUntil, month));
  const monthInvoices = state.invoices.filter((invoice) => monthMatches(invoice.date, month));
  const monthAppointments = state.appointments.filter((appointment) => monthMatches(appointment.date, month));
  const incomeTotals = monthPayments.reduce(
    (totals, payment) => {
      totals[normalizeCurrency(payment.currency)] += Number(payment.amount || 0);
      return totals;
    },
    { ARS: 0, USD: 0 }
  );
  const arsPayments = monthPayments.filter((payment) => normalizeCurrency(payment.currency) === "ARS").length;
  const usdPayments = monthPayments.filter((payment) => normalizeCurrency(payment.currency) === "USD").length;
  const averageTotals = {
    ARS: arsPayments ? incomeTotals.ARS / arsPayments : 0,
    USD: usdPayments ? incomeTotals.USD / usdPayments : 0,
  };
  const clientIds = new Set([
    ...monthPayments.map((payment) => payment.clientId || `guest:${payment.guestName || paymentReceiptNumber(payment)}`),
    ...monthAppointments.map((appointment) => appointment.clientId || `guest:${appointment.guestName || appointment.id}`),
  ].filter(Boolean));
  const serviceCount = monthAppointments.reduce((acc, appointment) => {
    const service = getService(appointment.serviceId);
    const name = service?.name || appointment.serviceName || "Servicio";
    acc[name] = (acc[name] || 0) + 1;
    return acc;
  }, {});
  const methods = monthPayments.reduce((acc, payment) => {
    const method = payment.method || "Sin método";
    acc[method] ||= { ARS: 0, USD: 0 };
    acc[method][normalizeCurrency(payment.currency)] += Number(payment.amount || 0);
    return acc;
  }, {});
  const clientTotals = monthPayments.reduce((acc, payment) => {
    const client = paymentClient(payment);
    const key = payment.clientId || `guest:${client.name}`;
    acc[key] ||= { name: client.name, ARS: 0, USD: 0, count: 0 };
    acc[key][normalizeCurrency(payment.currency)] += Number(payment.amount || 0);
    acc[key].count += 1;
    return acc;
  }, {});
  const statuses = monthAppointments.reduce((acc, appointment) => {
    const status = appointment.status || "Pendiente";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const conversion = monthQuotes.length ? Math.round((monthInvoices.length / monthQuotes.length) * 100) : 0;
  const completedAppointments = statuses.Realizado || 0;
  const canceledAppointments = statuses.Cancelado || 0;
  const completionRate = monthAppointments.length ? Math.round((completedAppointments / monthAppointments.length) * 100) : 0;
  const cancelRate = monthAppointments.length ? Math.round((canceledAppointments / monthAppointments.length) * 100) : 0;
  const payableAppointments = monthAppointments
    .map((appointment) => ({ appointment, paymentStatus: appointmentPaymentStatus(appointment) }))
    .filter(({ paymentStatus }) => Number(paymentStatus.total || 0) > 0);
  const paidAppointments = payableAppointments.filter(({ paymentStatus }) => paymentStatus.className === "paid").length;
  const paymentCoverage = payableAppointments.length ? Math.round((paidAppointments / payableAppointments.length) * 100) : monthPayments.length ? 100 : 0;
  const activeClientIds = [...clientIds].filter((id) => !String(id).startsWith("guest:"));
  const recurrentClients = activeClientIds.filter((clientId) => {
    const previousPayments = state.payments.some((payment) => payment.clientId === clientId && String(payment.date || "") < `${month}-01`);
    const previousAppointments = state.appointments.some((appointment) => appointment.clientId === clientId && String(appointment.date || "") < `${month}-01`);
    return previousPayments || previousAppointments;
  }).length;
  const recurrenceRate = activeClientIds.length ? Math.round((recurrentClients / activeClientIds.length) * 100) : 0;
  const qualityScore = monthAppointments.length || monthPayments.length || monthQuotes.length
    ? Math.round(completionRate * 0.32 + paymentCoverage * 0.26 + Math.min(conversion, 100) * 0.18 + Math.max(0, 100 - cancelRate) * 0.16 + recurrenceRate * 0.08)
    : 0;
  const qualityGrade = qualityScore >= 85 ? "Excelente" : qualityScore >= 70 ? "Muy bien" : qualityScore >= 50 ? "En mejora" : qualityScore ? "Revisar" : "Sin actividad";
  const [year, monthNumber] = month.split("-");
  const reportDate = new Date(Number(year), Number(monthNumber) - 1, 1);
  const monthLabel = reportDate.toLocaleDateString("es-AR", { month: "long", year: "numeric" });
  const topService = Object.entries(serviceCount).sort((a, b) => b[1] - a[1])[0];
  const topMethod = Object.entries(methods).sort((a, b) => (b[1].ARS + b[1].USD) - (a[1].ARS + a[1].USD))[0];
  const topClient = Object.values(clientTotals).sort((a, b) => (b.ARS + b.USD) - (a.ARS + a.USD))[0];

  $("#reportTitle").textContent = `Reporte de ${monthLabel}`;
  $("#reportSummary").textContent =
    monthPayments.length || monthAppointments.length
      ? `${monthPayments.length} cobro${monthPayments.length === 1 ? "" : "s"}, ${monthAppointments.length} turno${monthAppointments.length === 1 ? "" : "s"} y ${clientIds.size} cliente${clientIds.size === 1 ? "" : "s"} con actividad.`
      : "Todavía no hay actividad registrada para este mes.";
  $("#reportIncome").textContent = formatTotals(incomeTotals);
  $("#reportPayments").textContent = monthPayments.length;
  $("#reportAverageTicket").textContent = formatTotals(averageTotals);
  $("#reportQuotes").textContent = monthQuotes.length;
  $("#reportInvoices").textContent = monthInvoices.length;
  $("#reportConversion").textContent = `${conversion}%`;
  $("#reportAppointments").textContent = monthAppointments.length;
  $("#reportClients").textContent = clientIds.size;
  $("#reportQualityScore").textContent = qualityScore;
  $("#reportQualityGrade").textContent = qualityGrade;
  $("#reportHeroPills").innerHTML = [
    `${formatTotals(incomeTotals)} cobrados`,
    `${monthAppointments.length} turnos`,
    `${clientIds.size} clientes`,
    `${paymentCoverage}% cobertura`,
  ].map((text) => `<span>${text}</span>`).join("");
  $("#reportTopService").textContent = topService?.[0] || "-";
  $("#reportTopServiceDetail").textContent = topService ? `${topService[1]} turno${topService[1] === 1 ? "" : "s"} en el mes` : "Sin turnos cargados";
  $("#reportTopClient").textContent = topClient?.name || "-";
  $("#reportTopClientDetail").textContent = topClient ? `${formatTotals(topClient)} · ${topClient.count} cobro${topClient.count === 1 ? "" : "s"}` : "Sin cobros cargados";
  $("#reportTopMethod").textContent = topMethod?.[0] || "-";
  $("#reportTopMethodDetail").textContent = topMethod ? formatTotals(topMethod[1]) : "Sin cobros cargados";
  $("#reportHealthBars").innerHTML = [
    ["Cumplimiento", completionRate, `${completedAppointments}/${monthAppointments.length} turnos realizados`, "success"],
    ["Cobertura de cobro", paymentCoverage, `${paidAppointments}/${payableAppointments.length} turnos cobrados`, "cash"],
    ["Conversión comercial", Math.min(conversion, 100), `${monthInvoices.length}/${monthQuotes.length} documentos cerrados`, "info"],
    ["Clientes recurrentes", recurrenceRate, `${recurrentClients}/${activeClientIds.length} clientes volvieron`, "warning"],
  ]
    .map(([label, value, detail, tone]) => `
      <article class="${tone}">
        <div>
          <span>${label}</span>
          <strong>${value}%</strong>
        </div>
        <div class="report-progress"><i style="width: ${Math.max(0, Math.min(100, Number(value || 0)))}%"></i></div>
        <small>${detail}</small>
      </article>
    `)
    .join("");
  renderMonthlyComparison(month);
  $("#reportQualityGrid").innerHTML = [
    ["Cumplimiento", `${completionRate}%`, `${completedAppointments} de ${monthAppointments.length} turnos realizados`],
    ["Cobro de trabajos", `${paymentCoverage}%`, `${paidAppointments} de ${payableAppointments.length} turnos con precio quedaron cobrados`],
    ["Cancelaciones", `${cancelRate}%`, `${canceledAppointments} turno${canceledAppointments === 1 ? "" : "s"} cancelado${canceledAppointments === 1 ? "" : "s"}`],
    ["Conversión", `${conversion}%`, `${monthInvoices.length} factura${monthInvoices.length === 1 ? "" : "s"} sobre ${monthQuotes.length} cotización${monthQuotes.length === 1 ? "" : "es"}`],
    ["Recurrentes", `${recurrenceRate}%`, `${recurrentClients} cliente${recurrentClients === 1 ? "" : "s"} ya había${recurrentClients === 1 ? "" : "n"} venido antes`],
  ]
    .map(([label, value, detail]) => `<article><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`)
    .join("");
  const qualityInsights = [];
  if (!qualityScore) qualityInsights.push("Todavía no hay actividad suficiente para medir calidad este mes.");
  if (completionRate < 70 && monthAppointments.length) qualityInsights.push("Conviene actualizar los turnos realizados para que el seguimiento sea más preciso.");
  if (paymentCoverage < 80 && payableAppointments.length) qualityInsights.push("Hay trabajos con precio que no figuran cobrados; revisá Caja para cerrar saldos.");
  if (cancelRate > 15) qualityInsights.push("Las cancelaciones están algo altas; podés reforzar confirmaciones por WhatsApp.");
  if (conversion < 40 && monthQuotes.length) qualityInsights.push("Hay oportunidad de convertir más cotizaciones en facturas o cobros.");
  if (recurrenceRate >= 35) qualityInsights.push("Buen nivel de clientes recurrentes: el taller está generando confianza.");
  $("#reportQualityInsights").innerHTML = qualityInsights
    .slice(0, 4)
    .map((insight) => `<article>${insight}</article>`)
    .join("");
  $("#reportServices").innerHTML = Object.entries(serviceCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count], index) => `<article class="mini-row report-rank-row"><em>${index + 1}</em><strong>${name}</strong><span>${count} turno${count === 1 ? "" : "s"}</span></article>`)
    .join("") || `<div class="empty">No hay turnos en este mes.</div>`;
  $("#reportMethods").innerHTML = Object.entries(methods)
    .map(([method, totals]) => `<article class="mini-row report-method-row"><strong>${method}</strong><span>${formatTotals(totals)}</span></article>`)
    .join("") || `<div class="empty">No hay cobros en este mes.</div>`;
  $("#reportTopClients").innerHTML = Object.values(clientTotals)
    .sort((a, b) => (b.ARS + b.USD) - (a.ARS + a.USD))
    .slice(0, 6)
    .map((client, index) => `<article class="mini-row report-rank-row"><em>${index + 1}</em><strong>${client.name}</strong><span>${formatTotals(client)}</span></article>`)
    .join("") || `<div class="empty">No hay clientes con cobros en este mes.</div>`;
  $("#reportStatuses").innerHTML = ["Pendiente", "Confirmado", "Realizado", "Cancelado"]
    .map((status) => `<article><strong>${statuses[status] || 0}</strong><span>${status}</span></article>`)
    .join("");
  $("#reportRecentPayments").innerHTML = [...monthPayments]
    .sort((a, b) => `${b.date || ""}${b.id || ""}`.localeCompare(`${a.date || ""}${a.id || ""}`))
    .slice(0, 5)
    .map((payment) => {
      const client = paymentClient(payment);
      return `<article class="mini-row"><strong>${client.name}</strong><span>${payment.date} · ${paymentItemLabel(payment)} · ${formatCurrency(payment.amount, payment.currency)}</span></article>`;
    })
    .join("") || `<div class="empty">No hay cobros registrados en este mes.</div>`;
}

function renderTemplates() {
  $("#templatesList").innerHTML = state.whatsappTemplates
    .map(
      (template) => `
        <article class="record">
          <div>
            <strong>${template.name}</strong>
            <p>${template.body}</p>
          </div>
          <div class="record-actions">
            <button class="secondary" data-edit-template="${template.id}">Editar</button>
            <button class="whatsapp" data-use-template="${template.id}">Usar</button>
            <button class="danger" data-delete-template="${template.id}">Eliminar</button>
          </div>
        </article>
      `
    )
    .join("") || `<div class="empty">Todavía no hay plantillas.</div>`;
  updateTemplatePreview();
}

function latestClientAppointment(clientId) {
  return sortedAppointments()
    .filter((appointment) => appointment.clientId === clientId)
    .reverse()[0];
}

function latestClientQuote(clientId) {
  return state.quotes.filter((quote) => quote.clientId === clientId)[0];
}

function templateVariables(clientId) {
  const client = getClient(clientId) || state.clients[0];
  const vehicle = primaryVehicle(client);
  const appointment = latestClientAppointment(client?.id);
  const quote = latestClientQuote(client?.id);
  const service = getService(appointment?.serviceId);
  return {
    cliente: client?.name || "cliente",
    patente: vehicle?.plate || "-",
    vehiculo: vehicle?.vehicle || "tu vehículo",
    fecha: appointment ? dateLabel(appointment.date) : dateLabel(today()),
    hora: appointment?.time || "a coordinar",
    servicio: service?.name || appointment?.serviceName || quote?.items?.[0]?.desc || "el servicio",
    total: quote ? recordTotalLabel(quote) : service ? formatCurrency(service.price, service.currency) : "-",
    taller: state.settings.shopName || "el taller",
  };
}

function fillTemplate(body, clientId) {
  const variables = templateVariables(clientId);
  return String(body || "").replace(/\{(\w+)\}/g, (_, key) => variables[key] ?? `{${key}}`);
}

function updateTemplatePreview() {
  const body = $("#templateBody").value || state.whatsappTemplates[0]?.body || "";
  $("#templatePreview").textContent = fillTemplate(body, $("#templateClient").value);
}

function quickClientSuggestions() {
  const weighted = new Map();
  const addClient = (clientId, reason, weight = 1) => {
    const client = getClient(clientId);
    if (!client) return;
    const current = weighted.get(client.id) || { client, reasons: [], weight: 0 };
    current.weight += weight;
    if (reason && !current.reasons.includes(reason)) current.reasons.push(reason);
    weighted.set(client.id, current);
  };
  sortedAppointments()
    .filter((appointment) => appointment.status !== "Cancelado" && appointment.date >= today())
    .slice(0, 10)
    .forEach((appointment) => addClient(appointment.clientId, `Próximo turno ${dateLabel(appointment.date)} ${appointment.time || ""}`, 5));
  state.payments
    .slice(0, 12)
    .forEach((payment) => addClient(payment.clientId, `Último cobro ${dateLabel(payment.date)}`, 3));
  pendingAppointmentBalances()
    .forEach(({ appointment }) => addClient(appointment.clientId, "Tiene saldo pendiente", 6));
  state.clients.slice(0, 8).forEach((client) => addClient(client.id, "Cliente reciente", 1));
  return [...weighted.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6);
}

function renderQuickClientSuggestions() {
  const suggestions = quickClientSuggestions();
  if (!suggestions.length) return `<div class="empty">Cargá clientes para usar la ficha rápida.</div>`;
  return `
    <div class="search-suggestions-head">
      <strong>Clientes a mano</strong>
      <span>tocá uno para abrir su ficha</span>
    </div>
    ${suggestions.map(({ client, reasons }) => {
      const vehicle = primaryVehicle(client);
      return `
        <button class="search-result search-client-suggestion" type="button" data-search-type="client" data-search-id="${client.id}">
          <span class="suggestion-main">
            <strong>${escapeHtml(client.name)}</strong>
            ${plateBadge(vehicle.plate, true)}
          </span>
          <span>${escapeHtml(reasons.slice(0, 2).join(" · ") || formatWhatsappDisplay(client.whatsapp))}</span>
        </button>
      `;
    }).join("")}
  `;
}

function globalSearchItems() {
  const stamp = [
    state._updatedAt || "",
    state.clients.length,
    state.appointments.length,
    state.payments.length,
    state.quotes.length,
    state.invoices.length,
    state.services.length,
    state.products.length,
  ].join("|");
  if (searchIndexCache.stamp === stamp) return searchIndexCache.items;
  const items = [
    ...state.clients.map((client) => ({
      type: "client",
      id: client.id,
      title: client.name,
      detail: `Cliente · ${clientVehicles(client).map((vehicle) => `${vehicle.brand} ${vehicle.vehicle} ${vehicle.plate}`).join(" / ")} · ${client.whatsapp}`,
    })),
    ...state.clients.flatMap((client) =>
      clientVehicles(client).map((vehicle) => ({
        type: "vehicle",
        id: `${client.id}:${vehicle.id}`,
        title: `${vehicle.plate || "Sin patente"} · ${client.name}`,
        detail: `Vehículo · ${vehicle.brand || "Marca"} ${vehicle.vehicle || ""} · WhatsApp ${client.whatsapp || "-"}`,
      }))
    ),
    ...state.appointments.map((appointment) => {
      const client = appointmentClient(appointment);
      const vehicle = recordVehicle(appointment, getClient(appointment.clientId));
      const service = getService(appointment.serviceId);
      return {
        type: "appointment",
        id: appointment.id,
        title: `${appointment.date} ${appointment.time} · ${client.name}`,
        detail: `Turno · ${vehicle?.plate || "-"} · ${vehicle?.brand || ""} ${vehicle?.vehicle || ""} · ${service?.name || appointment.serviceName || "Servicio"} · ${appointment.status} · ${appointment.notes || ""}`,
      };
    }),
    ...state.payments.map((payment) => {
      const client = paymentClient(payment);
      const vehicle = recordVehicle(payment, getClient(payment.clientId));
      return {
        type: "payment",
        id: payment.id,
        title: `${paymentReceiptNumber(payment)} · ${client.name}`,
        detail: `Cobro · ${vehicle?.plate || "-"} · ${vehicle?.brand || ""} ${vehicle?.vehicle || ""} · ${paymentItemLabel(payment)} · ${formatCurrency(payment.amount, payment.currency)} · ${payment.method} · ${payment.type || "Pago total"} · ${payment.notes || ""}`,
      };
    }),
    ...state.quotes.map((quote) => {
      const client = getClient(quote.clientId);
      const vehicle = recordVehicle(quote, client);
      return {
        type: "quote",
        id: quote.id,
        title: `${quote.number} · ${client?.name || "Cliente eliminado"}`,
        detail: `Cotización · ${vehicle?.plate || "-"} · ${vehicle?.brand || ""} ${vehicle?.vehicle || ""} · ${(quote.items || []).map((item) => item.desc).join(" · ")} · ${recordTotalLabel(quote)} · vence ${quote.validUntil} · ${quote.notes || ""}`,
      };
    }),
    ...state.invoices.map((invoice) => {
      const client = getClient(invoice.clientId);
      const vehicle = recordVehicle(invoice, client);
      return {
        type: "invoice",
        id: invoice.id,
        title: `${invoice.number} · ${client?.name || "Cliente eliminado"}`,
        detail: `Factura · ${vehicle?.plate || "-"} · ${vehicle?.brand || ""} ${vehicle?.vehicle || ""} · ${(invoice.items || []).map((item) => item.desc).join(" · ")} · ${recordTotalLabel(invoice)} · ${invoice.status} · ${invoice.notes || ""}`,
      };
    }),
    ...state.services.map((service) => ({
      type: "service",
      id: service.id,
      title: service.name,
      detail: `Servicio · ${serviceCategory(service)} · ${formatCurrency(service.price, service.currency)} · ${service.description || ""}`,
    })),
    ...state.products.map((product) => ({
      type: "product",
      id: product.id,
      title: product.name,
      detail: `Producto · Stock ${product.stock} · ${formatMoney(product.price)} · ${product.description || "-"}`,
    })),
  ];
  searchIndexCache = { stamp, items };
  return items;
}

function renderGlobalSearch() {
  const input = $("#globalSearch");
  const query = input.value.trim().toLowerCase();
  const resultsPanel = $("#globalResults");
  if (!query && document.activeElement === input) {
    resultsPanel.classList.add("active");
    resultsPanel.innerHTML = renderQuickClientSuggestions();
    return;
  }
  if (!query) {
    resultsPanel.classList.remove("active");
    resultsPanel.innerHTML = "";
    return;
  }
  const results = globalSearchItems()
    .filter((item) => [item.title, item.detail].join(" ").toLowerCase().includes(query))
    .slice(0, 8);
  const actions = [
    { keywords: ["turno", "agendar", "agenda"], action: "appointment", title: "Nuevo turno", detail: "Abrir agenda y cargar turno" },
    { keywords: ["cobro", "cobrar", "caja", "recibo"], action: "payment", title: "Nuevo cobro", detail: "Ir a Caja y armar recibo" },
    { keywords: ["cliente", "whatsapp", "patente"], action: "client", title: "Nuevo cliente", detail: "Cargar cliente y vehículo" },
    { keywords: ["producto", "stock"], action: "product", title: "Nuevo producto", detail: "Cargar producto y stock" },
    { keywords: ["cotizacion", "cotización", "presupuesto"], action: "quote", title: "Nueva cotización", detail: "Crear cotización para enviar" },
  ].filter((item) => item.keywords.some((keyword) => query.includes(keyword))).slice(0, 3);
  resultsPanel.classList.add("active");
  resultsPanel.innerHTML =
    [
      ...actions.map(
        (item) => `
          <button class="search-result search-action-result" type="button" data-universal-action="${item.action}">
            ${escapeHtml(item.title)}
            <span>${escapeHtml(item.detail)}</span>
          </button>
        `
      ),
      ...results
      .map(
        (item) => `
          <button class="search-result" type="button" data-search-type="${item.type}" data-search-id="${item.id}">
            ${escapeHtml(item.title)}
            <span>${escapeHtml(item.detail)}</span>
          </button>
        `
      ),
    ].join("") || `<div class="empty">No encontré resultados.</div>`;
}

function closeQuickProfile() {
  const panel = $("#quickProfile");
  if (!panel) return;
  panel.hidden = true;
  panel.innerHTML = "";
}

function quickProfileVehicleFilter(record, client, vehicleId) {
  return !vehicleId || vehicleMatchesRecord(record, client, vehicleId);
}

function quickProfileMovements(client, vehicleId = "") {
  const movementVehicleText = (record) => {
    const vehicle = recordVehicle(record, client);
    return [vehicle?.plate, vehicle?.brand, vehicle?.vehicle].filter(Boolean).join(" · ") || "Sin vehículo";
  };
  return [
    ...state.appointments
      .filter((appointment) => appointment.clientId === client.id && quickProfileVehicleFilter(appointment, client, vehicleId))
      .map((appointment) => {
        const service = getService(appointment.serviceId);
        return {
          date: appointment.date,
          tone: appointment.status === "Cancelado" ? "danger" : appointment.status === "Realizado" ? "success" : "info",
          label: "Turno",
          title: `${appointment.date} ${appointment.time}`,
          detail: `${service?.name || appointment.serviceName || "Servicio"} · ${movementVehicleText(appointment)} · ${appointment.status}`,
        };
      }),
    ...state.payments
      .filter((payment) => payment.clientId === client.id && quickProfileVehicleFilter(payment, client, vehicleId))
      .map((payment) => ({
        date: payment.date,
        tone: "success",
        label: "Cobro",
        title: `${paymentReceiptNumber(payment)} · ${formatCurrency(payment.amount, payment.currency)}`,
        detail: `${paymentItemLabel(payment)} · ${movementVehicleText(payment)} · ${payment.method}`,
      })),
    ...state.quotes
      .filter((quote) => quote.clientId === client.id && quickProfileVehicleFilter(quote, client, vehicleId))
      .map((quote) => ({
        date: quote.validUntil,
        tone: "warning",
        label: "Cotización",
        title: `${quote.number} · ${recordTotalLabel(quote)}`,
        detail: `${movementVehicleText(quote)} · vence ${quote.validUntil}`,
      })),
  ].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
}

function quickProfilePending(client, vehicleId = "") {
  return pendingAppointmentBalances().filter(({ appointment }) => appointment.clientId === client.id && quickProfileVehicleFilter(appointment, client, vehicleId));
}

function showQuickProfile(clientId, vehicleId = "") {
  const client = getClient(clientId);
  const panel = $("#quickProfile");
  if (!client || !panel) return;
  const vehicles = clientVehicles(client);
  const selectedVehicle = vehicles.find((vehicle) => vehicle.id === vehicleId) || null;
  const relatedPayments = state.payments.filter((payment) => payment.clientId === client.id && quickProfileVehicleFilter(payment, client, vehicleId));
  const totals = sumPayments(relatedPayments);
  const pending = quickProfilePending(client, vehicleId);
  const pendingTotals = pending.reduce(
    (totalsAcc, item) => {
      totalsAcc[serviceCurrencyForAppointment(item.appointment)] += Number(item.status.balance || 0);
      return totalsAcc;
    },
    { ARS: 0, USD: 0 }
  );
  const nextAppointment = sortedAppointments().find((appointment) => appointment.clientId === client.id && quickProfileVehicleFilter(appointment, client, vehicleId) && appointment.date >= today() && appointment.status !== "Cancelado");
  const movements = quickProfileMovements(client, vehicleId).slice(0, 6);
  const whatsappHref = client.whatsapp ? `https://wa.me/${client.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(`Hola ${client.name}, te escribimos de ${state.settings.shopName || "Ditaranto Car Detailing"}.`)}` : "";
  panel.hidden = false;
  panel.innerHTML = `
    <div class="quick-profile-card">
      <div class="quick-profile-head">
        <div>
          <p class="eyebrow">${selectedVehicle ? "Ficha de vehículo" : "Ficha rápida"}</p>
          <h3>${escapeHtml(client.name)}</h3>
          <span>${client.whatsapp ? `WhatsApp ${escapeHtml(client.whatsapp)}` : "Sin WhatsApp cargado"}</span>
        </div>
        <button class="icon-btn" type="button" data-close-quick-profile aria-label="Cerrar ficha">×</button>
      </div>
      <div class="quick-profile-vehicles">
        ${vehicles.map((vehicle) => `
          <button class="${vehicle.id === vehicleId ? "active" : ""}" type="button" data-open-quick-client="${client.id}" data-open-quick-vehicle="${vehicle.id}">
            ${plateLine(vehicle.plate, `${escapeHtml(vehicle.brand)} · ${escapeHtml(vehicle.vehicle || "Vehículo")}`)}
          </button>
        `).join("") || `<span class="empty-inline">Sin vehículos cargados</span>`}
      </div>
      <div class="quick-profile-stats">
        <article class="success"><span>Cobrado</span><strong>${formatTotals(totals)}</strong></article>
        <article class="${pending.length ? "danger" : "success"}"><span>Saldos</span><strong>${pending.length ? formatTotals(pendingTotals) : "Sin deuda"}</strong></article>
        <article class="info"><span>Próximo</span><strong>${nextAppointment ? `${nextAppointment.date} ${nextAppointment.time}` : "Sin turno"}</strong></article>
      </div>
      <div class="quick-profile-actions">
        <button class="secondary" type="button" data-quick-action="history" data-quick-client="${client.id}" data-quick-vehicle="${vehicleId}">Historial</button>
        <button class="secondary" type="button" data-quick-action="edit" data-quick-client="${client.id}" data-quick-vehicle="${vehicleId}">Editar</button>
        <button class="secondary" type="button" data-quick-action="appointment" data-quick-client="${client.id}" data-quick-vehicle="${vehicleId}">Agendar</button>
        <button class="secondary" type="button" data-quick-action="quote" data-quick-client="${client.id}" data-quick-vehicle="${vehicleId}">Cotizar</button>
        <button class="primary" type="button" data-quick-action="payment" data-quick-client="${client.id}" data-quick-vehicle="${vehicleId}">Cobrar</button>
        ${client.whatsapp ? `<button class="secondary" type="button" data-copy-whatsapp="${escapeHtml(client.whatsapp)}">Copiar WhatsApp</button>` : ""}
        ${whatsappHref ? `<a class="whatsapp" target="_blank" rel="noreferrer" href="${whatsappHref}">WhatsApp</a>` : ""}
      </div>
      <div class="quick-profile-timeline">
        <strong>Últimos movimientos</strong>
        ${movements.map((movement) => `
          <article class="${movement.tone}">
            <span>${movement.label}</span>
            <div>
              <strong>${escapeHtml(movement.title)}</strong>
              <small>${escapeHtml(movement.detail)}</small>
            </div>
          </article>
        `).join("") || `<div class="empty">Todavía no hay movimientos para esta ficha.</div>`}
      </div>
    </div>
  `;
}

function runQuickProfileAction(action, clientId, vehicleId = "") {
  const client = getClient(clientId);
  if (!client) return;
  closeQuickProfile();
  if (action === "history") {
    selectedClientHistoryId = clientId;
    selectedClientHistoryVehicleId = vehicleId || "";
    renderClientHistory();
    fillClientForm(client);
    switchTab("clients");
    return;
  }
  if (action === "edit") {
    fillClientForm(client);
    selectedClientHistoryId = clientId;
    selectedClientHistoryVehicleId = vehicleId || "";
    renderClientHistory();
    switchTab("clients");
    $("#clientName")?.focus();
    return;
  }
  if (action === "appointment") {
    resetAppointmentForm();
    switchTab("appointments");
    setAppointmentFormOpen(true, { focus: true });
    $("#appointmentClient").value = clientId;
    updateAppointmentVehicleInfo(vehicleId);
    if (vehicleId) $("#appointmentVehicle").value = vehicleId;
    return;
  }
  if (action === "quote") {
    resetQuoteForm();
    switchTab("quotes");
    $("#quoteClient").value = clientId;
    updateVehicleSelect("quoteVehicle", clientId, vehicleId);
    if (vehicleId) $("#quoteVehicle").value = vehicleId;
    updateQuoteTotal();
    return;
  }
  if (action === "payment") {
    resetPaymentForm();
    switchTab("payments");
    $("#paymentClient").value = clientId;
    updateVehicleSelect("paymentVehicle", clientId, vehicleId);
    if (vehicleId) $("#paymentVehicle").value = vehicleId;
  }
}

function openSearchResult(type, id) {
  $("#globalSearch").value = "";
  renderGlobalSearch();
  if (type === "client") {
    showQuickProfile(id);
    return;
  }
  if (type === "vehicle") {
    const [clientId, vehicleId] = String(id || "").split(":");
    showQuickProfile(clientId, vehicleId);
    return;
  }
  if (type === "appointment") fillAppointmentForm(id);
  if (type === "payment") fillPaymentForm(id);
  if (type === "quote") fillQuoteForm(id);
  if (type === "invoice") fillInvoiceForm(id);
  if (type === "service") {
    const service = getService(id);
    if (service) {
      $("#serviceId").value = service.id;
      $("#serviceName").value = service.name;
      $("#servicePrice").value = service.price;
      $("#serviceCurrency").value = normalizeCurrency(service.currency);
      $("#serviceCategory").value = serviceCategory(service);
      $("#serviceDescription").value = service.description || "";
    }
    switchTab("services");
  }
  if (type === "product") {
    const product = getProduct(id);
    if (product) {
      $("#productId").value = product.id;
      $("#productName").value = product.name;
      $("#productPrice").value = product.price;
      $("#productStock").value = product.stock;
      $("#productMinStock").value = product.minStock;
      $("#productDescription").value = product.description || "";
    }
    switchTab("products");
  }
}

function dashboardPriorityRow(kind, title, detail, tab, tone = "") {
  return `
    <button class="home-priority-item ${tone}" type="button" data-open-tab="${tab}">
      <span>${kind}</span>
      <strong>${title}</strong>
      <small>${detail}</small>
    </button>
  `;
}

function dashboardActivityRows() {
  const rows = [
    ...state.payments.map((payment) => {
      const client = paymentClient(payment);
      return { date: payment.date, type: "Cobro", title: `${client.name} · ${formatCurrency(payment.amount, payment.currency)}`, detail: paymentItemLabel(payment), tab: "payments" };
    }),
    ...state.appointments.map((appointment) => {
      const client = appointmentClient(appointment);
      return { date: appointment.date, type: "Turno", title: `${client.name} · ${appointment.time || ""}`, detail: appointment.serviceName || getService(appointment.serviceId)?.name || "Servicio", tab: "appointments" };
    }),
    ...state.quotes.map((quote) => {
      const client = getClient(quote.clientId);
      return { date: quote.validUntil, type: "Cotización", title: `${quote.number} · ${client?.name || "Cliente eliminado"}`, detail: recordTotalLabel(quote), tab: "quotes" };
    }),
    ...state.invoices.map((invoice) => {
      const client = getClient(invoice.clientId);
      return { date: invoice.date, type: "Factura", title: `${invoice.number} · ${client?.name || "Cliente eliminado"}`, detail: recordTotalLabel(invoice), tab: "invoices" };
    }),
  ].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return rows.slice(0, 6).map((row) => `
    <button class="home-activity-item" type="button" data-open-tab="${row.tab}">
      <span>${row.type}</span>
      <strong>${row.title}</strong>
      <small>${dateLabel(row.date)} · ${row.detail}</small>
    </button>
  `).join("");
}

function renderDashboard() {
  const lowStockProducts = state.products.filter((product) => product.stock <= product.minStock);
  const pendingAppointments = visibleAppointments().filter((appointment) => appointment.status !== "Realizado");
  const todayAppointments = visibleAppointments().filter((appointment) => appointment.date === today());
  const todayIncome = sumPayments(state.payments.filter((payment) => payment.date === today()));
  const invoicedTotals = state.invoices.reduce(
    (totals, invoice) => {
      const source = invoice.totals || { [normalizeCurrency(invoice.currency)]: Number(invoice.total || 0) };
      totals.ARS += Number(source.ARS || 0);
      totals.USD += Number(source.USD || 0);
      return totals;
    },
    { ARS: 0, USD: 0 }
  );
  const pendingBalances = pendingAppointmentBalances();
  const pendingBalanceTotals = pendingBalances.reduce(
    (totals, item) => {
      totals[serviceCurrencyForAppointment(item.appointment)] += Number(item.status.balance || 0);
      return totals;
    },
    { ARS: 0, USD: 0 }
  );
  const pendingInvoices = state.invoices.filter((invoice) => invoice.status !== "Pagada");
  const openQuotes = state.quotes.filter((quote) => quote.validUntil >= today());
  const expiredQuotes = state.quotes.filter((quote) => String(quote.validUntil || "") < today());
  const tomorrowAppointments = visibleAppointments().filter((appointment) => appointment.date === addDays(1));

  $("#dashboardTodayTitle").textContent = `${todayAppointments.length} turno${todayAppointments.length === 1 ? "" : "s"} programado${todayAppointments.length === 1 ? "" : "s"}`;
  $("#dashboardTodayText").textContent = todayAppointments.length
    ? `Próximo: ${todayAppointments[0].time} · ${getClient(todayAppointments[0].clientId)?.name || "Cliente"}`
    : "No hay turnos para hoy. Buen momento para cargar trabajos o revisar pendientes.";
  $("#dashboardHeroIncome").textContent = formatTotals(todayIncome);
  $("#dashboardHeroPending").textContent = pendingBalances.length ? `${pendingBalances.length} saldo${pendingBalances.length === 1 ? "" : "s"} pendiente${pendingBalances.length === 1 ? "" : "s"} · ${formatTotals(pendingBalanceTotals)}` : "Sin saldos pendientes";
  $("#metricClients").textContent = state.clients.length;
  $("#metricQuotes").textContent = openQuotes.length;
  $("#metricInvoices").textContent = pendingInvoices.length;
  $("#metricRevenue").textContent = formatTotals(invoicedTotals);
  $("#metricProducts").textContent = state.products.length;
  $("#metricLowStock").textContent = lowStockProducts.length;
  $("#metricAppointments").textContent = pendingAppointments.length;
  $("#metricIncome").textContent = formatTotals(todayIncome);
  $("#todayAppointments").innerHTML =
    todayAppointments.map((appointment) => dashboardAppointmentRow(appointment)).join("") ||
    `<div class="empty">No hay turnos para hoy.</div>`;
  $("#dashboardPendingBalances").innerHTML =
    pendingBalances
      .slice(0, 5)
      .map(({ appointment, status, client, service }) => {
        const currency = serviceCurrencyForAppointment(appointment);
        const vehicle = recordVehicle(appointment, getClient(appointment.clientId));
        return `
          <article class="mini-row dashboard-row">
            <div>
              <strong>${client.name}</strong>
              <small>${plateLine(vehicle?.plate, `${service?.name || appointment.serviceName || "Servicio"} · ${appointment.date} ${appointment.time}`)}</small>
            </div>
            <div class="balance-actions">
              <span>${formatCurrency(status.balance, currency)}</span>
              <button class="primary" data-charge-balance="${appointment.id}">Cobrar</button>
            </div>
          </article>
        `;
      })
      .join("") || `<div class="empty">No hay saldos pendientes.</div>`;
  $("#recentQuotes").innerHTML =
    state.quotes.slice(0, 5).map((quote) => dashboardQuoteRow(quote)).join("") ||
    `<div class="empty">Las cotizaciones nuevas van a aparecer acá.</div>`;
  $("#lowStockList").innerHTML =
    lowStockProducts.slice(0, 5).map((product) => dashboardProductRow(product)).join("") ||
    `<div class="empty">No hay productos con stock bajo.</div>`;
  const priorityRows = [
    pendingBalances.length ? dashboardPriorityRow("Caja", `${pendingBalances.length} saldo${pendingBalances.length === 1 ? "" : "s"} por cobrar`, formatTotals(pendingBalanceTotals), "payments", "urgent") : "",
    todayAppointments.length ? dashboardPriorityRow("Hoy", `${todayAppointments.length} turno${todayAppointments.length === 1 ? "" : "s"} en agenda`, "Revisá horarios y cobros del día", "appointments", "active") : "",
    lowStockProducts.length ? dashboardPriorityRow("Stock", `${lowStockProducts.length} producto${lowStockProducts.length === 1 ? "" : "s"} bajo mínimo`, "Conviene revisar reposición", "products", "warning") : "",
    expiredQuotes.length ? dashboardPriorityRow("Ventas", `${expiredQuotes.length} cotización${expiredQuotes.length === 1 ? "" : "es"} vencida${expiredQuotes.length === 1 ? "" : "s"}`, "Podés actualizar o cerrar seguimiento", "quotes", "warning") : "",
    tomorrowAppointments.length ? dashboardPriorityRow("Mañana", `${tomorrowAppointments.length} turno${tomorrowAppointments.length === 1 ? "" : "s"} próximo${tomorrowAppointments.length === 1 ? "" : "s"}`, "Ideal para confirmar por WhatsApp", "appointments") : "",
  ].filter(Boolean);
  $("#dashboardPriority").innerHTML = priorityRows.join("") || `<div class="empty">Todo tranquilo. No hay prioridades fuertes por ahora.</div>`;
  $("#dashboardActivity").innerHTML = dashboardActivityRows() || `<div class="empty">Cuando uses el CRM, la actividad reciente aparece acá.</div>`;
  $("#upcomingAppointments").innerHTML =
    pendingAppointments.slice(0, 6).map((appointment) => dashboardAppointmentRow(appointment)).join("") ||
    `<div class="empty">Los próximos turnos van a aparecer acá.</div>`;
  if ($("#mobileTodayLabel")) {
    $("#mobileTodayLabel").textContent = `${dateLabel(today())} · ${todayAppointments.length} turno${todayAppointments.length === 1 ? "" : "s"}`;
  }
}

function renderSettings() {
  Object.entries(state.settings).forEach(([key, value]) => {
    const input = $("#" + key);
    if (input) input.value = value;
  });
  applyTheme();
}

function renderAll() {
  renderTimeOptions();
  renderClientOptions();
  renderQuoteOptions();
  renderAppointmentServiceOptions();
  renderPaymentAppointmentOptions();
  refreshItemServiceOptions();
  renderClients();
  renderServices();
  renderProducts();
  renderAppointments();
  renderPayments();
  renderQuotes();
  renderInvoices();
  renderReports();
  renderTemplates();
  renderDashboard();
  renderSettings();
  renderGlobalSearch();
  renderReceptionMatches();
  renderReceptionSummary();
  renderNotifications();
  renderMigrationTool();
  enhanceButtonIcons();
}

function nextNumber(collection, prefix) {
  return `${prefix}-${String(collection.length + 1).padStart(4, "0")}`;
}

const ICONS = {
  add: `<path d="M12 5v14"/><path d="M5 12h14"/>`,
  calendar: `<path d="M8 2v4"/><path d="M16 2v4"/><path d="M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/>`,
  cash: `<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M7 12h.01"/><path d="M17 12h.01"/>`,
  check: `<path d="M20 6 9 17l-5-5"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  download: `<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>`,
  edit: `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>`,
  file: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>`,
  history: `<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/><path d="M12 7v5l3 2"/>`,
  home: `<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/>`,
  invoice: `<path d="M4 3h16v18l-3-2-3 2-3-2-3 2-4-2Z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>`,
  login: `<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>`,
  logout: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>`,
  message: `<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/>`,
  package: `<path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>`,
  pdf: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 16h1"/><path d="M11 16h1"/><path d="M14 16h2"/>`,
  receipt: `<path d="M4 2v20l3-2 3 2 3-2 3 2 4-2V2Z"/><path d="M8 7h8"/><path d="M8 11h8"/><path d="M8 15h5"/>`,
  search: `<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>`,
  settings: `<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1A1.7 1.7 0 0 0 10 3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>`,
  trash: `<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>`,
  user: `<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>`,
  users: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>`,
  vehicle: `<path d="M5 11 7 6h10l2 5"/><path d="M3 11h18v7H3z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>`,
  x: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
};

function iconSvg(name) {
  return `<svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.check}</svg>`;
}

function iconForAction(element) {
  const text = (element.textContent || "").trim().toLowerCase();
  const data = element.dataset || {};
  const targetTab = data.tab || data.openTab || "";
  if (targetTab === "reception") return "home";
  if (targetTab === "dashboard") return "home";
  if (targetTab === "clients") return "users";
  if (targetTab === "services") return "check";
  if (targetTab === "products") return "package";
  if (targetTab === "appointments") return "calendar";
  if (targetTab === "payments") return "cash";
  if (targetTab === "quotes") return "file";
  if (targetTab === "invoices") return "invoice";
  if (targetTab === "reports") return "history";
  if (targetTab === "whatsappTemplates") return "message";
  if (targetTab === "settings") return "settings";
  if (data.tab === "reception") return "home";
  if (data.tab === "dashboard") return "home";
  if (data.tab === "clients") return "users";
  if (data.tab === "services") return "check";
  if (data.tab === "products") return "package";
  if (data.tab === "appointments") return "calendar";
  if (data.tab === "payments") return "cash";
  if (data.tab === "quotes") return "file";
  if (data.tab === "invoices") return "invoice";
  if (data.tab === "reports") return "history";
  if (data.tab === "whatsappTemplates") return "message";
  if (data.tab === "settings") return "settings";
  if (data.deleteClient || data.deleteService || data.deleteProduct || data.deleteAppointment || data.deletePayment || data.deleteQuote || data.deleteInvoice || data.deleteTemplate) return "trash";
  if (data.editClient || data.editService || data.editProduct || data.editAppointment || data.editPayment || data.editQuote || data.editInvoice || data.editTemplate) return "edit";
  if (data.historyClient) return "history";
  if (data.appointmentClient || data.chargeAppointment || data.chargeBalance || text.includes("turno") || text.includes("agendar") || text.includes("hoy") || text.includes("mañana")) return "calendar";
  if (data.cancelAppointment || text.includes("cancelar")) return "x";
  if (data.paymentReceipt || text.includes("recibo")) return "receipt";
  if (data.downloadPayment || data.downloadQuote || text.includes("descargar") || text.includes("backup") || text.includes("importar")) return "download";
  if (data.sharePayment || data.shareQuote || text.includes("whatsapp")) return "message";
  if (data.quotePdf || data.pdf || text === "pdf") return "pdf";
  if (data.invoiceFrom || text.includes("facturar") || text.includes("factura")) return "invoice";
  if (text.includes("cobrar") || text.includes("cobro")) return "cash";
  if (text.includes("cotiz")) return "file";
  if (text.includes("guardar")) return "check";
  if (text.includes("limpiar")) return "trash";
  if (text.includes("agregar") || text.includes("nuevo") || text.includes("nueva")) return "add";
  if (text.includes("entrar")) return "login";
  if (text.includes("salir")) return "logout";
  if (text.includes("cliente")) return "user";
  if (text.includes("usar")) return "check";
  return "";
}

function enhanceButtonIcons() {
  $$("button:not(.icon-btn), a.primary, a.secondary, a.danger, a.whatsapp, .file-button").forEach((element) => {
    if (element.dataset.iconified === "true") return;
    const icon = iconForAction(element);
    if (!icon) return;
    element.insertAdjacentHTML("afterbegin", iconSvg(icon));
    element.dataset.iconified = "true";
  });
}

function whatsappUrl(record, type) {
  const client = getClient(record.clientId);
  if (!client?.whatsapp) return "#";
  const vehicle = recordVehicle(record, client);
  const label = type === "invoice" ? "factura" : "cotización";
  const text = `Hola ${client.name}, te envío la ${label} ${record.number} por ${recordTotalLabel(record)} para tu vehículo ${vehicle?.plate || ""}.`;
  return `https://wa.me/${client.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

function appointmentWhatsappUrl(appointment) {
  const client = appointmentClient(appointment);
  if (!client?.whatsapp) return "#";
  const vehicle = recordVehicle(appointment, getClient(appointment.clientId));
  const service = getService(appointment.serviceId);
  const serviceName = service?.name || appointment.serviceName || "el servicio";
  const text = `Hola ${client.name}, te recuerdo tu turno para ${serviceName}${vehicle?.plate ? ` del vehículo ${vehicle.plate}` : ""} el ${appointment.date} a las ${appointment.time}.`;
  return `https://wa.me/${client.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

function paymentReceiptWhatsappUrl(payment) {
  const client = paymentClient(payment);
  if (!client?.whatsapp) return "#";
  const vehicle = recordVehicle(payment, getClient(payment.clientId));
  const serviceName = paymentItemLabel(payment);
  const text = `Hola ${client.name}, te envío el recibo ${paymentReceiptNumber(payment)} por ${formatCurrency(payment.amount, payment.currency)} correspondiente a ${serviceName}${vehicle?.plate ? ` del vehículo ${vehicle.plate}` : ""}.`;
  return `https://wa.me/${client.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

function paymentReceiptDetails(payment) {
  const client = paymentClient(payment);
  const vehicle = recordVehicle(payment, getClient(payment.clientId));
  const service = getService(payment.serviceId);
  const product = getProduct(payment.productId);
  const appointment = state.appointments.find((item) => item.id === payment.appointmentId);
  const items = paymentReceiptItemLines(payment);
  const quantity = Number(payment.quantity || 1);
  const serviceName = items.length ? items.map(paymentLineLabel).join(" · ") : product?.name || service?.name || payment.serviceName || "Servicio";
  const servicePrice = Number(items.length ? paymentItemsTotal(items) : product ? product.price * quantity : service?.price || payment.amount || 0);
  const currency = normalizeCurrency(payment.currency || service?.currency);
  const balance = Math.max(servicePrice - Number(payment.amount || 0), 0);
  return {
    client,
    service,
    appointment,
    items,
    serviceName,
    servicePrice,
    currency,
    balance,
    appointmentLabel: appointment ? `${appointment.date} ${appointment.time}` : "Sin turno asociado",
    vehicleLabel: vehicle?.plate ? `${vehicle.vehicle || "-"} · Patente: ${vehicle.plate}` : "Cliente sin vehículo agendado",
  };
}

function receiptFileName(payment) {
  return `${paymentReceiptNumber(payment)}-${payment.date}.pdf`;
}

function paymentReceiptPreviewHtml(payment) {
  const client = paymentClient(payment);
  if (!payment || !client) return "";
  const settings = state.settings;
  const details = paymentReceiptDetails(payment);
  const receiptRows = details.items
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(paymentLineLabel(item))}</td>
          <td>${Math.max(1, Number(item.quantity || 1))}</td>
          <td>${formatCurrency(item.price, item.currency)}</td>
          <td>${formatCurrency(paymentLineSubtotal(item), item.currency)}</td>
        </tr>
      `
    )
    .join("");
  return `
    <main class="receipt-preview-document">
      <header>
        <div>
          <img class="receipt-preview-logo" src="assets/ditaranto-logo-wordmark-boost.png" alt="${escapeHtml(settings.shopName)}" />
          <h1>${escapeHtml(settings.shopName)}</h1>
          ${settings.shopAddress ? `<p>${escapeHtml(settings.shopAddress)}</p>` : ""}
          ${settings.shopWhatsapp ? `<p>WhatsApp: ${escapeHtml(settings.shopWhatsapp)}</p>` : ""}
          ${(settings.shopTaxId || settings.shopTaxCondition) ? `<p>${escapeHtml([settings.shopTaxId, settings.shopTaxCondition].filter(Boolean).join(" · "))}</p>` : ""}
        </div>
        <div class="right">
          <h1>Recibo</h1>
          <p><strong>${escapeHtml(paymentReceiptNumber(payment))}</strong></p>
          <p>${escapeHtml(payment.date)}</p>
        </div>
      </header>
      <h2>Cliente</h2>
      <p><strong>${escapeHtml(client.name)}</strong>${client.whatsapp ? ` · ${escapeHtml(client.whatsapp)}` : ""}</p>
      <p>${escapeHtml(details.vehicleLabel)}</p>
      <div class="receipt-preview-meta">
        <span>Turno: ${escapeHtml(details.appointmentLabel)}</span>
        <span>Método: ${escapeHtml(payment.method || "-")}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Concepto</th>
            <th>Cant.</th>
            <th>Unitario</th>
            <th>Subtotal</th>
          </tr>
        </thead>
        <tbody>${receiptRows}</tbody>
      </table>
      <div class="receipt-preview-total">Total: ${formatCurrency(payment.amount, details.currency)}</div>
      ${payment.notes ? `<div class="receipt-preview-notes"><strong>Notas:</strong> ${escapeHtml(payment.notes)}</div>` : ""}
      <p class="receipt-preview-legal">Comprobante interno. No reemplaza factura fiscal electrónica.</p>
    </main>
  `;
}

function closePaymentReceiptModal() {
  const modal = $("#receiptModal");
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  delete modal.dataset.paymentId;
  $("#receiptModalDocument").innerHTML = "";
  document.body.classList.remove("modal-open");
}

function pdfEscape(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "-")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r?\n/g, " ");
}

function pdfShort(text, max = 68) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

function pdfText(value, x, y, options = {}) {
  const { size = 10, color = "0.95 0.97 0.95 rg", font = "F1", max = 68 } = options;
  return `${color} BT /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(pdfShort(value, max))}) Tj ET`;
}

function buildSimplePdf(pageWidth, pageHeight, content) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
}

function pdfDocumentHeader(data, label, number, meta) {
  return [
    "0.035 0.045 0.05 rg 0 0 420 595 re f",
    "0.06 0.075 0.08 rg 18 458 384 112 re f",
    "0.12 0.16 0.16 rg 26 466 368 88 re f",
    "0.33 0.94 0.18 rg 26 550 368 3 re f",
    "0.33 0.94 0.18 rg 30 515 78 2 re f",
    pdfText("DITARANTO", 30, 528, { size: 25, font: "F2", color: "1 1 1 rg", max: 18 }),
    pdfText("CAR DETAILING", 162, 520, { size: 10, font: "F2", color: "0.33 0.94 0.18 rg", max: 20 }),
    pdfText(data.title || "Taller Detailing", 30, 497, { size: 10, font: "F2", color: "0.82 0.88 0.84 rg", max: 42 }),
    data.workshop ? pdfText(data.workshop, 30, 482, { size: 7, color: "0.62 0.68 0.65 rg", max: 74 }) : "",
    pdfText(label, 294, 528, { size: 17, font: "F2", color: "0.33 0.94 0.18 rg", max: 18 }),
    pdfText(number, 294, 508, { size: 11, font: "F2", color: "1 1 1 rg", max: 24 }),
    meta ? pdfText(meta, 294, 492, { size: 8, color: "0.68 0.74 0.70 rg", max: 30 }) : "",
  ];
}

function receiptPdfRows(payment) {
  const settings = state.settings;
  const details = paymentReceiptDetails(payment);
  const client = details.client;
  return {
    title: settings.shopName || "Taller Detailing",
    receipt: paymentReceiptNumber(payment),
    date: payment.date,
    workshop: [settings.shopAddress, settings.shopWhatsapp ? `WA ${settings.shopWhatsapp}` : "", settings.shopTaxId].filter(Boolean).join(" · "),
    client: client?.name || "Cliente eliminado",
    whatsapp: client?.whatsapp || "-",
    vehicle: details.vehicleLabel,
    service: details.serviceName,
    items: details.items.map((item) => ({
      concept: paymentLineLabel(item),
      quantity: Math.max(1, Number(item.quantity || 1)),
      unit: plainMoney(item.price, item.currency),
      subtotal: plainMoney(paymentLineSubtotal(item), item.currency),
    })),
    appointment: details.appointmentLabel,
    type: payment.type || "Pago total",
    method: payment.method || "-",
    total: plainMoney(payment.amount, details.currency),
    notes: payment.notes || "",
  };
}

function buildReceiptPdf(data) {
  const pageWidth = 420;
  const pageHeight = 595;
  const itemRows = (data.items || []).slice(0, 9).flatMap((item, index) => {
    const y = 222 - index * 16;
    return [
      "0.10 0.125 0.13 rg 28 " + (y - 5) + " 364 16 re f",
      pdfText(item.concept, 36, y, { size: 8, color: "1 1 1 rg", max: 31 }),
      pdfText(String(item.quantity), 214, y, { size: 8, font: "F2", color: "0.85 0.90 0.87 rg", max: 6 }),
      pdfText(item.unit, 252, y, { size: 8, color: "0.85 0.90 0.87 rg", max: 15 }),
      pdfText(item.subtotal, 326, y, { size: 8, font: "F2", color: "0.33 0.94 0.18 rg", max: 16 }),
    ];
  });
  const extraItems = (data.items || []).length > 9 ? pdfText(`+ ${(data.items || []).length - 9} conceptos mas`, 36, 76, { size: 8, color: "0.74 0.79 0.76 rg", max: 35 }) : "";
  const content = [
    ...pdfDocumentHeader(data, "RECIBO", data.receipt, `Fecha ${data.date}`),
    "0.08 0.10 0.105 rg 18 326 384 102 re f",
    "0.08 0.10 0.105 rg 18 72 384 218 re f",
    "0.33 0.94 0.18 rg 28 405 78 2 re f",
    pdfText("CLIENTE", 28, 412, { size: 8, font: "F2", color: "0.33 0.94 0.18 rg", max: 20 }),
    pdfText(data.client, 28, 386, { size: 15, font: "F2", color: "1 1 1 rg", max: 34 }),
    pdfText(`WhatsApp: ${data.whatsapp}`, 28, 368, { size: 8, color: "0.74 0.79 0.76 rg", max: 46 }),
    pdfText(`Vehiculo: ${data.vehicle}`, 28, 352, { size: 8, color: "0.74 0.79 0.76 rg", max: 62 }),
    pdfText(`Turno: ${data.appointment}`, 224, 386, { size: 8, color: "0.74 0.79 0.76 rg", max: 36 }),
    pdfText(`Metodo: ${data.method}`, 224, 368, { size: 8, color: "0.74 0.79 0.76 rg", max: 36 }),
    pdfText("DETALLE DEL COBRO", 28, 304, { size: 9, font: "F2", color: "0.33 0.94 0.18 rg", max: 28 }),
    pdfText("Concepto", 36, 246, { size: 7, font: "F2", color: "0.70 0.76 0.73 rg", max: 18 }),
    pdfText("Cant.", 214, 246, { size: 7, font: "F2", color: "0.70 0.76 0.73 rg", max: 8 }),
    pdfText("Unitario", 252, 246, { size: 7, font: "F2", color: "0.70 0.76 0.73 rg", max: 12 }),
    pdfText("Subtotal", 326, 246, { size: 7, font: "F2", color: "0.70 0.76 0.73 rg", max: 12 }),
    ...itemRows,
    extraItems,
    "0.10 0.18 0.11 rg 218 28 184 32 re f",
    "0.33 0.94 0.18 rg 218 58 184 2 re f",
    pdfText("TOTAL", 228, 45, { size: 9, font: "F2", color: "0.74 0.79 0.76 rg", max: 10 }),
    pdfText(data.total, 274, 43, { size: 16, font: "F2", color: "0.33 0.94 0.18 rg", max: 20 }),
    data.notes ? pdfText(`Notas: ${data.notes}`, 28, 54, { size: 8, color: "0.74 0.79 0.76 rg", max: 42 }) : "",
    pdfText("Comprobante interno. No reemplaza factura fiscal electronica.", 28, 34, { size: 7, color: "0.55 0.60 0.57 rg", max: 65 }),
  ].join("\n");
  return buildSimplePdf(pageWidth, pageHeight, content);
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadPaymentReceiptPdf(id) {
  const payment = state.payments.find((item) => item.id === id);
  if (!payment) return;
  downloadBlob(buildReceiptPdf(receiptPdfRows(payment)), receiptFileName(payment));
}

function cashClosingFileName(date = $("#cashDate")?.value || today()) {
  return `cierre-caja-${date}.pdf`;
}

function buildCashClosingPdf(date) {
  const payments = state.payments.filter((payment) => payment.date === date);
  const byMethod = payments.reduce((acc, payment) => {
    const key = payment.method || "Sin metodo";
    acc[key] ||= { ARS: 0, USD: 0 };
    acc[key][normalizeCurrency(payment.currency)] += Number(payment.amount || 0);
    return acc;
  }, {});
  const totals = sumPayments(payments);
  const text = (value, x, y, size = 10, color = "0.95 0.97 0.95 rg") => `${color} BT /F1 ${size} Tf ${x} ${y} Td (${pdfEscape(value)}) Tj ET`;
  const methodRows = Object.entries(byMethod).slice(0, 8).flatMap(([method, methodTotals], index) => {
    const y = 355 - index * 20;
    return [text(method, 42, y, 11, "1 1 1 rg"), text(formatTotals(methodTotals), 250, y, 11, "0.33 0.94 0.18 rg")];
  });
  const paymentRows = payments.slice(0, 10).flatMap((payment, index) => {
    const y = 160 - index * 14;
    return [
      text(paymentReceiptNumber(payment), 42, y, 8, "0.74 0.79 0.76 rg"),
      text(paymentClient(payment).name, 120, y, 8, "1 1 1 rg"),
      text(payment.method || "-", 245, y, 8, "0.74 0.79 0.76 rg"),
      text(plainMoney(payment.amount, payment.currency), 325, y, 8, "0.33 0.94 0.18 rg"),
    ];
  });
  const content = [
    "0.04 0.05 0.06 rg 0 0 420 595 re f",
    "0.09 0.11 0.13 rg 24 466 372 78 re f",
    "0.33 0.94 0.18 rg 24 466 372 4 re f",
    "0.08 0.10 0.12 rg 24 230 372 190 re f",
    "0.08 0.10 0.12 rg 24 44 372 156 re f",
    text(state.settings.shopName || "Taller Detailing", 36, 516, 18, "1 1 1 rg"),
    text(`Cierre de caja - ${date}`, 36, 496, 11, "0.70 0.76 0.73 rg"),
    text("TOTAL DEL DIA", 250, 516, 9, "0.33 0.94 0.18 rg"),
    text(formatTotals(totals), 250, 494, 17, "0.33 0.94 0.18 rg"),
    text(`${payments.length} cobros registrados`, 250, 478, 9, "0.70 0.76 0.73 rg"),
    text("DESGLOSE POR METODO", 42, 396, 10, "0.33 0.94 0.18 rg"),
    ...methodRows,
    !methodRows.length ? text("Sin cobros en esta fecha.", 42, 355, 10, "0.74 0.79 0.76 rg") : "",
    text("ULTIMOS COBROS", 42, 178, 10, "0.33 0.94 0.18 rg"),
    ...paymentRows,
    payments.length > 10 ? text(`+ ${payments.length - 10} cobros mas en el sistema`, 42, 26, 8, "0.74 0.79 0.76 rg") : "",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf], { type: "application/pdf" });
}

function downloadCashClosingPdf() {
  const date = $("#cashDate")?.value || today();
  downloadBlob(buildCashClosingPdf(date), cashClosingFileName(date));
}

function quoteFileName(quote) {
  return `${quote.number}-${quote.validUntil}.pdf`;
}

function quoteDetails(quote) {
  const client = getClient(quote.clientId);
  const vehicle = recordVehicle(quote, client);
  return {
    client,
    vehicleLabel: vehicle?.plate ? `${vehicle.vehicle || "-"} · Patente: ${vehicle.plate}` : "-",
    totals: quote.totals || totalsByCurrency(quote.items || []),
  };
}

function quotePdfRows(quote) {
  const settings = state.settings;
  const details = quoteDetails(quote);
  const client = details.client;
  const itemLines = (quote.items || []).map((item) => {
    const subtotal = Number(item.qty || 0) * Number(item.price || 0);
    return {
      concept: item.desc,
      quantity: Math.max(1, Number(item.qty || 1)),
      unit: plainMoney(item.price, item.currency),
      subtotal: plainMoney(subtotal, item.currency),
    };
  });
  return {
    title: settings.shopName || "Taller Detailing",
    number: quote.number,
    validUntil: quote.validUntil,
    workshop: [settings.shopAddress, settings.shopWhatsapp ? `WA ${settings.shopWhatsapp}` : "", settings.shopTaxId].filter(Boolean).join(" · "),
    client: client?.name || "Cliente eliminado",
    whatsapp: client?.whatsapp || "-",
    vehicle: details.vehicleLabel,
    items: itemLines,
    total: formatTotals(details.totals),
    notes: quote.notes || "",
  };
}

function buildQuotePdf(data) {
  const pageWidth = 420;
  const pageHeight = 595;
  const itemCommands = (data.items || []).slice(0, 9).flatMap((item, index) => {
    const y = 262 - index * 16;
    return [
      "0.10 0.125 0.13 rg 28 " + (y - 5) + " 364 16 re f",
      pdfText(item.concept, 36, y, { size: 8, color: "1 1 1 rg", max: 31 }),
      pdfText(String(item.quantity), 214, y, { size: 8, font: "F2", color: "0.85 0.90 0.87 rg", max: 6 }),
      pdfText(item.unit, 252, y, { size: 8, color: "0.85 0.90 0.87 rg", max: 15 }),
      pdfText(item.subtotal, 326, y, { size: 8, font: "F2", color: "0.33 0.94 0.18 rg", max: 16 }),
    ];
  });
  const extraItems = (data.items || []).length > 9 ? pdfText(`+ ${(data.items || []).length - 9} conceptos mas`, 36, 116, { size: 8, color: "0.74 0.79 0.76 rg", max: 35 }) : "";
  const content = [
    ...pdfDocumentHeader(data, "COTIZACION", data.number, `Valida hasta ${data.validUntil}`),
    "0.08 0.10 0.105 rg 18 336 384 92 re f",
    "0.08 0.10 0.105 rg 18 112 384 188 re f",
    "0.33 0.94 0.18 rg 28 405 78 2 re f",
    pdfText("CLIENTE", 28, 412, { size: 8, font: "F2", color: "0.33 0.94 0.18 rg", max: 20 }),
    pdfText(data.client, 28, 386, { size: 15, font: "F2", color: "1 1 1 rg", max: 34 }),
    pdfText(`WhatsApp: ${data.whatsapp}`, 28, 368, { size: 8, color: "0.74 0.79 0.76 rg", max: 46 }),
    pdfText(`Vehiculo: ${data.vehicle}`, 28, 352, { size: 8, color: "0.74 0.79 0.76 rg", max: 62 }),
    pdfText("SERVICIOS COTIZADOS", 28, 314, { size: 9, font: "F2", color: "0.33 0.94 0.18 rg", max: 30 }),
    pdfText("Concepto", 36, 286, { size: 7, font: "F2", color: "0.70 0.76 0.73 rg", max: 18 }),
    pdfText("Cant.", 214, 286, { size: 7, font: "F2", color: "0.70 0.76 0.73 rg", max: 8 }),
    pdfText("Unitario", 252, 286, { size: 7, font: "F2", color: "0.70 0.76 0.73 rg", max: 12 }),
    pdfText("Subtotal", 326, 286, { size: 7, font: "F2", color: "0.70 0.76 0.73 rg", max: 12 }),
    ...itemCommands,
    extraItems,
    "0.10 0.18 0.11 rg 188 58 214 36 re f",
    "0.33 0.94 0.18 rg 188 92 214 2 re f",
    pdfText("TOTAL", 198, 77, { size: 9, font: "F2", color: "0.74 0.79 0.76 rg", max: 10 }),
    pdfText(data.total, 248, 75, { size: 16, font: "F2", color: "0.33 0.94 0.18 rg", max: 25 }),
    data.notes ? pdfText(`Notas: ${data.notes}`, 28, 76, { size: 8, color: "0.74 0.79 0.76 rg", max: 37 }) : "",
    pdfText("Cotizacion sujeta a revision del vehiculo y disponibilidad de turno.", 28, 38, { size: 7, color: "0.55 0.60 0.57 rg", max: 72 }),
  ].join("\n");
  return buildSimplePdf(pageWidth, pageHeight, content);
}

function downloadQuotePdf(id) {
  openQuotePdf(id, { autoPrint: true });
}

async function sharePaymentReceiptPdf(id) {
  const payment = state.payments.find((item) => item.id === id);
  if (!payment) return;
  const receiptBlob = buildReceiptPdf(receiptPdfRows(payment));
  const client = paymentClient(payment);
  const text = `Recibo ${paymentReceiptNumber(payment)} por ${formatCurrency(payment.amount, payment.currency)} - ${paymentItemLabel(payment)}`;

  if (client?.whatsapp) {
    try {
      const result = await sendReceiptWithWhatsappApi({ payment, client, receiptBlob, caption: text });
      if (result.ok) {
        showToast("Recibo enviado por WhatsApp.");
        return;
      }
    } catch (error) {
      console.warn(error);
    }
  }

  const file = new File([receiptBlob], receiptFileName(payment), {
    type: "application/pdf",
  });

  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      title: `Recibo ${paymentReceiptNumber(payment)}`,
      text,
      files: [file],
    });
    return;
  }

  downloadBlob(file, receiptFileName(payment));
  if (client?.whatsapp) {
    window.open(paymentReceiptWhatsappUrl(payment), "_blank", "noopener,noreferrer");
  } else {
    showToast("Tu navegador no permite compartir archivos directo. Descargué el PDF para que lo adjuntes manualmente.", "error");
  }
}

async function shareQuotePdf(id) {
  const quote = state.quotes.find((item) => item.id === id);
  const client = getClient(quote?.clientId);
  if (!quote || !client) return;
  const vehicle = recordVehicle(quote, client);
  const quoteBlob = buildQuotePdf(quotePdfRows(quote));
  const caption = `Cotización ${quote.number} por ${recordTotalLabel(quote)}${vehicle?.plate ? ` para ${vehicle.plate}` : ""}.`;

  if (client.whatsapp) {
    try {
      const result = await sendDocumentWithWhatsappApi({
        to: client.whatsapp,
        filename: quoteFileName(quote),
        caption,
        pdfBlob: quoteBlob,
      });
      if (result.ok) {
        showToast("Cotización enviada por WhatsApp.");
        return;
      }
    } catch (error) {
      console.warn(error);
    }
  }

  const file = new File([quoteBlob], quoteFileName(quote), { type: "application/pdf" });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      title: `Cotización ${quote.number}`,
      text: caption,
      files: [file],
    });
    return;
  }

  downloadBlob(file, quoteFileName(quote));
  if (client.whatsapp) window.open(whatsappUrl(quote, "quote"), "_blank", "noopener,noreferrer");
}

async function sendReceiptWithWhatsappApi({ payment, client, receiptBlob, caption }) {
  return sendDocumentWithWhatsappApi({
    to: client.whatsapp,
    filename: receiptFileName(payment),
    caption,
    pdfBlob: receiptBlob,
  });
}

async function sendDocumentWithWhatsappApi({ to, filename, caption, pdfBlob }) {
  const response = await fetch("/api/send-document-whatsapp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to,
      filename,
      caption,
      pdfBase64: await blobToBase64(pdfBlob),
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudo enviar el PDF por WhatsApp.");
  return data;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function exportBackup() {
  const payload = {
    app: "Ditaranto CRM",
    version: 1,
    exportedAt: new Date().toISOString(),
    state,
  };
  const fileName = `backup-ditaranto-crm-${today()}.json`;
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), fileName);
}

function readBackupFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error("Archivo no seleccionado."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        resolve(normalizeState(parsed.state || parsed));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function cleanTextKey(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function clientSignature(client = {}) {
  const vehicles = clientVehicles(client);
  return {
    id: client.id || "",
    name: cleanTextKey(client.name),
    whatsapp: String(client.whatsapp || "").replace(/\D/g, ""),
    plates: vehicles.map((vehicle) => normalizePlate(vehicle.plate)).filter(Boolean),
  };
}

function findClientMigrationMatch(importedClient, targetClients = state.clients) {
  const imported = clientSignature(importedClient);
  return targetClients.find((client) => {
    const current = clientSignature(client);
    if (imported.id && imported.id === current.id) return true;
    if (imported.whatsapp && imported.whatsapp === current.whatsapp) return true;
    if (imported.plates.some((plate) => current.plates.includes(plate))) return true;
    return imported.name && imported.name === current.name;
  });
}

function mergeClientRecord(currentClient, importedClient, maps) {
  const target = currentClient ? { ...currentClient } : { ...importedClient, id: importedClient.id || uid("client") };
  const importedVehicles = clientVehicles(importedClient);
  const currentVehicles = clientVehicles(target);
  const vehicleMap = maps.vehicleIds;
  if (!target.name && importedClient.name) target.name = importedClient.name;
  if (!target.whatsapp && importedClient.whatsapp) target.whatsapp = importedClient.whatsapp;
  target.vehicles = [...currentVehicles];
  importedVehicles.forEach((vehicle) => {
    const existingVehicle = target.vehicles.find((item) => {
      const samePlate = vehicle.plate && item.plate && normalizePlate(vehicle.plate) === normalizePlate(item.plate);
      const sameModel = cleanTextKey(vehicle.vehicle) && cleanTextKey(vehicle.vehicle) === cleanTextKey(item.vehicle) && normalizeBrand(vehicle.brand) === normalizeBrand(item.brand);
      return samePlate || sameModel || (vehicle.id && item.id === vehicle.id);
    });
    if (existingVehicle) {
      vehicleMap.set(vehicle.id, existingVehicle.id);
      existingVehicle.brand = existingVehicle.brand || vehicle.brand;
      existingVehicle.vehicle = existingVehicle.vehicle || vehicle.vehicle;
      existingVehicle.plate = existingVehicle.plate || vehicle.plate;
      return;
    }
    const nextVehicle = { ...vehicle, id: vehicle.id || uid("vehicle") };
    vehicleMap.set(vehicle.id, nextVehicle.id);
    target.vehicles.push(nextVehicle);
  });
  target.plate = target.vehicles[0]?.plate || target.plate || "";
  target.brand = target.vehicles[0]?.brand || target.brand || "";
  target.vehicle = target.vehicles[0]?.vehicle || target.vehicle || "";
  maps.clientIds.set(importedClient.id, target.id);
  return target;
}

function collectionMatch(collection, importedItem, matchers = []) {
  return collection.find((item) => {
    if (importedItem.id && item.id === importedItem.id) return true;
    return matchers.some((matcher) => matcher(item, importedItem));
  });
}

function migrateRecordReferences(item, maps) {
  const next = { ...item };
  if (next.clientId && maps.clientIds.has(next.clientId)) next.clientId = maps.clientIds.get(next.clientId);
  if (next.vehicleId && maps.vehicleIds.has(next.vehicleId)) next.vehicleId = maps.vehicleIds.get(next.vehicleId);
  if (next.serviceId && maps.serviceIds?.has(next.serviceId)) next.serviceId = maps.serviceIds.get(next.serviceId);
  if (next.productId && maps.productIds?.has(next.productId)) next.productId = maps.productIds.get(next.productId);
  if (Array.isArray(next.items)) {
    next.items = next.items.map((line) => ({
      ...line,
      serviceId: line.serviceId && maps.serviceIds?.has(line.serviceId) ? maps.serviceIds.get(line.serviceId) : line.serviceId,
      productId: line.productId && maps.productIds?.has(line.productId) ? maps.productIds.get(line.productId) : line.productId,
      itemId: line.itemId && maps.serviceIds?.has(line.itemId)
        ? maps.serviceIds.get(line.itemId)
        : line.itemId && maps.productIds?.has(line.itemId)
          ? maps.productIds.get(line.itemId)
          : line.itemId,
    }));
  }
  if (next.vehicle) next.vehicle = normalizeVehicleEntry(next.vehicle);
  return next;
}

function buildMigrationPlan(importedState) {
  const plan = {
    importedState,
    summary: {},
    duplicates: [],
    actions: [],
  };
  const maps = { clientIds: new Map(), vehicleIds: new Map(), serviceIds: new Map(), productIds: new Map() };
  const working = normalizeState(state);
  const addSummary = (key, added = 0, updated = 0, skipped = 0) => {
    plan.summary[key] = {
      added: (plan.summary[key]?.added || 0) + added,
      updated: (plan.summary[key]?.updated || 0) + updated,
      skipped: (plan.summary[key]?.skipped || 0) + skipped,
    };
  };

  (importedState.clients || []).forEach((client) => {
    const match = findClientMigrationMatch(client, working.clients);
    const merged = mergeClientRecord(match, client, maps);
    if (match) {
      const index = working.clients.findIndex((item) => item.id === match.id);
      working.clients[index] = merged;
      addSummary("clients", 0, 1);
      plan.duplicates.push(`${client.name || "Cliente"} se fusiona con ${match.name || "cliente existente"}`);
    } else {
      working.clients.unshift(merged);
      addSummary("clients", 1, 0);
    }
  });

  const mergeCollections = [
    {
      key: "services",
      label: "servicios",
      matchers: [(a, b) => cleanTextKey(a.name) === cleanTextKey(b.name) && serviceCategory(a) === serviceCategory(b)],
      normalize: (item) => ({ ...item, currency: normalizeCurrency(item.currency) }),
      map: "serviceIds",
    },
    {
      key: "products",
      label: "productos",
      matchers: [(a, b) => cleanTextKey(a.name) === cleanTextKey(b.name)],
      normalize: (item) => ({ ...item }),
      map: "productIds",
    },
    {
      key: "appointments",
      label: "turnos",
      matchers: [
        (a, b) => a.date === b.date && a.time === b.time && a.clientId === b.clientId && cleanTextKey(a.serviceName || getService(a.serviceId)?.name) === cleanTextKey(b.serviceName || getService(b.serviceId)?.name),
      ],
      normalize: (item) => migrateRecordReferences(item, maps),
    },
    {
      key: "payments",
      label: "cobros",
      matchers: [(a, b) => a.receiptNumber && a.receiptNumber === b.receiptNumber],
      normalize: (item) => migrateRecordReferences(item, maps),
    },
    {
      key: "quotes",
      label: "cotizaciones",
      matchers: [(a, b) => a.number && a.number === b.number],
      normalize: (item) => migrateRecordReferences(item, maps),
    },
    {
      key: "invoices",
      label: "facturas",
      matchers: [(a, b) => a.number && a.number === b.number],
      normalize: (item) => migrateRecordReferences(item, maps),
    },
    {
      key: "whatsappTemplates",
      label: "plantillas",
      matchers: [(a, b) => cleanTextKey(a.name) === cleanTextKey(b.name)],
      normalize: (item) => ({ ...item }),
    },
  ];

  mergeCollections.forEach(({ key, matchers, normalize, map }) => {
    const importedItems = Array.isArray(importedState[key]) ? importedState[key] : [];
    working[key] = Array.isArray(working[key]) ? working[key] : [];
    importedItems.forEach((rawItem) => {
      const item = normalize(rawItem);
      const match = collectionMatch(working[key], item, matchers);
      if (match) {
        const index = working[key].findIndex((current) => current.id === match.id);
        working[key][index] = { ...match, ...item, id: match.id || item.id || uid(key) };
        if (map && item.id) maps[map].set(item.id, working[key][index].id);
        addSummary(key, 0, 1);
      } else {
        const nextItem = { ...item, id: item.id || uid(key) };
        working[key].unshift(nextItem);
        if (map && item.id) maps[map].set(item.id, nextItem.id);
        addSummary(key, 1, 0);
      }
    });
  });

  working.settings = { ...working.settings, ...(importedState.settings || {}), appTheme: state.settings.appTheme };
  working._updatedAt = new Date().toISOString();
  plan.nextState = working;
  return plan;
}

function migrationSummaryLabel(key) {
  return {
    clients: "Clientes",
    services: "Servicios",
    products: "Productos",
    appointments: "Turnos",
    payments: "Cobros",
    quotes: "Cotizaciones",
    invoices: "Facturas",
    whatsappTemplates: "Plantillas",
  }[key] || key;
}

function renderMigrationTool() {
  const preview = $("#migrationPreview");
  const apply = $("#applyMigration");
  const clear = $("#clearMigration");
  if (!preview || !apply || !clear) return;
  apply.disabled = !migrationDraft;
  clear.disabled = !migrationDraft;
  if (!migrationDraft) {
    preview.innerHTML = `<div class="empty">Todavía no hay backup analizado.</div>`;
    return;
  }
  const entries = Object.entries(migrationDraft.summary).filter(([, item]) => item.added || item.updated || item.skipped);
  const totalChanges = entries.reduce((sum, [, item]) => sum + item.added + item.updated, 0);
  preview.innerHTML = `
    <div class="migration-status ${totalChanges ? "ready" : "quiet"}">
      <strong>${totalChanges ? `${totalChanges} cambio${totalChanges === 1 ? "" : "s"} listo${totalChanges === 1 ? "" : "s"} para fusionar` : "No hay diferencias importantes"}</strong>
      <span>Actual online: ${state.clients.length} clientes · Backup: ${migrationDraft.importedState.clients.length} clientes</span>
    </div>
    <div class="migration-grid">
      ${entries.map(([key, item]) => `
        <article>
          <span>${migrationSummaryLabel(key)}</span>
          <strong>+${item.added}</strong>
          <small>${item.updated} fusionado${item.updated === 1 ? "" : "s"}</small>
        </article>
      `).join("") || `<div class="empty">El backup parece igual a los datos actuales.</div>`}
    </div>
    ${migrationDraft.duplicates.length ? `
      <div class="migration-duplicates">
        <strong>Posibles duplicados resueltos</strong>
        ${migrationDraft.duplicates.slice(0, 6).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
      </div>
    ` : ""}
  `;
}

async function analyzeSmartMigration(file) {
  try {
    const importedState = await readBackupFile(file);
    migrationDraft = buildMigrationPlan(importedState);
    renderMigrationTool();
    showToast("Backup analizado. Revisá el resumen antes de fusionar.");
  } catch {
    migrationDraft = null;
    renderMigrationTool();
    showToast("No pude analizar el backup. Revisá que sea JSON válido.", "error");
  }
}

async function applySmartMigration() {
  if (!migrationDraft?.nextState) return;
  const totalChanges = Object.values(migrationDraft.summary).reduce((sum, item) => sum + item.added + item.updated, 0);
  const confirmed = await askConfirm({
    title: "Fusionar datos del backup",
    message: `Se van a aplicar ${totalChanges} cambio${totalChanges === 1 ? "" : "s"} al CRM actual. Se evita duplicar clientes por WhatsApp, patente o nombre.`,
    action: "Fusionar",
    tone: "primary",
  });
  if (!confirmed) return;
  state = normalizeState(migrationDraft.nextState);
  persistLocalState();
  saveStateToServer();
  migrationDraft = null;
  resetQuoteForm();
  resetInvoiceForm();
  resetAppointmentForm();
  resetPaymentForm();
  renderAll();
  showToast("Datos fusionados correctamente.");
}

function importBackup(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || "{}"));
      const importedState = parsed.state || parsed;
      state = normalizeState(importedState);
      state._updatedAt = new Date().toISOString();
      persistLocalState();
      saveStateToServer();
      selectedClientHistoryId = "";
      resetQuoteForm();
      resetInvoiceForm();
      resetAppointmentForm();
      resetPaymentForm();
      renderAll();
      showToast("Backup importado correctamente.");
    } catch {
      showToast("No pude importar el backup. Revisá que sea un archivo JSON válido.", "error");
    }
  };
  reader.readAsText(file);
}

function createInvoiceFromQuote(quoteId) {
  const quote = state.quotes.find((item) => item.id === quoteId);
  if (!quote) return;
  switchTab("invoices");
  resetInvoiceForm();
  $("#invoiceClient").value = quote.clientId;
  $("#invoiceQuote").value = quote.id;
  $("#invoiceNotes").value = quote.notes || "";
  $("#invoiceItems").innerHTML = "";
  quote.items.forEach((item) => addItemRow("#invoiceItems", item));
  updateInvoiceTotal();
}

function fillQuoteForm(id) {
  const quote = state.quotes.find((item) => item.id === id);
  if (!quote) return;
  switchTab("quotes");
  $("#quoteId").value = quote.id;
  $("#quoteClient").value = quote.clientId;
  updateVehicleSelect("quoteVehicle", quote.clientId, quote.vehicleId);
  $("#quoteValidUntil").value = quote.validUntil;
  $("#quoteNotes").value = quote.notes || "";
  $("#quoteItems").innerHTML = "";
  quote.items.forEach((item) => addItemRow("#quoteItems", item));
  updateQuoteTotal();
}

function fillInvoiceForm(id) {
  const invoice = state.invoices.find((item) => item.id === id);
  if (!invoice) return;
  switchTab("invoices");
  $("#invoiceId").value = invoice.id;
  $("#invoiceClient").value = invoice.clientId;
  $("#invoiceQuote").value = invoice.quoteId || "";
  $("#invoiceDate").value = invoice.date;
  $("#invoiceStatus").value = invoice.status;
  $("#invoiceNotes").value = invoice.notes || "";
  $("#invoiceItems").innerHTML = "";
  invoice.items.forEach((item) => addItemRow("#invoiceItems", item));
  updateInvoiceTotal();
}

function fillAppointmentForm(id) {
  const appointment = state.appointments.find((item) => item.id === id);
  if (!appointment) return;
  switchTab("appointments");
  setAppointmentFormOpen(true, { focus: true });
  $("#appointmentId").value = appointment.id;
  $("#appointmentFormTitle").textContent = "Editar turno";
  $("#appointmentClient").value = appointment.clientId;
  updateAppointmentVehicleInfo(appointment.vehicleId || appointment.vehicle?.id || "");
  $("#appointmentGuestName").value = appointment.guestName || "";
  $("#appointmentGuestWhatsapp").value = appointment.guestWhatsapp || "";
  $("#appointmentService").value = appointment.serviceId;
  $("#appointmentDate").value = appointment.date;
  $("#appointmentTime").value = appointment.time;
  $("#appointmentStatus").value = appointment.status;
  $("#appointmentNotes").value = appointment.notes || "";
}

function fillPaymentForm(id) {
  const payment = state.payments.find((item) => item.id === id);
  if (!payment) return;
  switchTab("payments");
  $("#paymentId").value = payment.id;
  $("#paymentClient").value = payment.clientId;
  updateVehicleSelect("paymentVehicle", payment.clientId, payment.vehicleId);
  $("#paymentGuestName").value = payment.guestName || "";
  $("#paymentGuestWhatsapp").value = payment.guestWhatsapp || "";
  $("#paymentAppointment").value = payment.appointmentId || "";
  setPaymentItemSelection(payment.productId ? paymentItemValue("product", payment.productId) : paymentItemValue("service", payment.serviceId));
  $("#paymentQuantity").value = payment.quantity || 1;
  $("#paymentDate").value = payment.date;
  $("#paymentAmount").value = payment.amount;
  $("#paymentReceived").value = payment.received || "";
  $("#paymentType").value = payment.type || "Pago total";
  $("#paymentCurrency").value = normalizeCurrency(payment.currency);
  $("#paymentMethod").value = payment.method;
  $("#paymentNotes").value = payment.notes || "";
  paymentDraftItems = paymentItemsFromPayment(payment);
  renderPaymentTicket();
  updatePaymentCalculation(false);
  updatePaymentChange();
}

function fillPaymentFromAppointment(id, mode = "total") {
  const appointment = state.appointments.find((item) => item.id === id);
  const service = getService(appointment?.serviceId);
  if (!appointment) return;
  const status = appointmentPaymentStatus(appointment);
  const currency = serviceCurrencyForAppointment(appointment);
  const amount = mode === "balance" ? status.balance : service?.price || "";
  switchTab("payments");
  resetPaymentForm();
  $("#paymentClient").value = appointment.clientId;
  updateVehicleSelect("paymentVehicle", appointment.clientId, appointment.vehicleId);
  $("#paymentGuestName").value = appointment.clientId ? "" : appointment.guestName || "";
  $("#paymentGuestWhatsapp").value = appointment.clientId ? "" : appointment.guestWhatsapp || "";
  $("#paymentAppointment").value = appointment.id;
  setPaymentItemSelection(paymentItemValue("service", appointment.serviceId));
  $("#paymentQuantity").value = 1;
  paymentDraftItems = service
    ? [
        {
          id: uid("payitem"),
          type: "service",
          itemId: service.id,
          name: service.name,
          quantity: 1,
          price: Number(amount || service.price || 0),
          currency,
        },
      ]
    : [];
  $("#paymentDate").value = today();
  $("#paymentReceived").value = "";
  $("#paymentType").value = mode === "balance" ? "Saldo" : status.paid > 0 ? "Saldo" : "Pago total";
  $("#paymentCurrency").value = currency;
  $("#paymentNotes").value = `${mode === "balance" ? "Saldo pendiente" : "Turno"} ${appointment.date} ${appointment.time}`;
  renderPaymentTicket();
  updatePaymentCalculation(false);
  updatePaymentChange();
}

function adjustStockForPaymentChange(previousPayment, nextPayment) {
  paymentProductLines(previousPayment).forEach((line) => {
    const previousProduct = getProduct(line.productId);
    if (previousProduct) previousProduct.stock += Number(line.quantity || 1);
  });
  paymentProductLines(nextPayment).forEach((line) => {
    const nextProduct = getProduct(line.productId);
    if (nextProduct) nextProduct.stock = Math.max(0, Number(nextProduct.stock || 0) - Number(line.quantity || 1));
  });
}

function openQuotePdf(id, options = {}) {
  const quote = state.quotes.find((item) => item.id === id);
  const client = getClient(quote?.clientId);
  if (!quote || !client) return;
  const vehicle = recordVehicle(quote, client);
  const settings = state.settings;
  const rows = quote.items
    .map(
      (item) => `
        <tr>
          <td>${item.desc}</td>
          <td>${item.qty}</td>
          <td>${formatCurrency(item.price, item.currency)}</td>
          <td>${formatCurrency(item.qty * item.price, item.currency)}</td>
        </tr>
      `
    )
    .join("");
  const doc = window.open("", "_blank");
  const autoPrint = Boolean(options.autoPrint);
  doc.document.write(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <title>${quote.number}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; background: #eef1ef; color: #1f2628; }
          .actions { display: flex; gap: 10px; margin: 0 auto 12px; width: min(100%, 760px); padding-top: 18px; }
          button { min-height: 38px; border: 0; border-radius: 6px; padding: 0 13px; font-weight: 700; cursor: pointer; }
          .primary { background: #0b6b62; color: white; }
          .secondary { background: #e8efed; color: #1f2628; }
          .document { width: min(100%, 760px); margin: 0 auto 18px; background: white; padding: 28px; border: 1px solid #d7ddda; box-sizing: border-box; }
          header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #46e323; padding-bottom: 16px; }
          .doc-logo { width: 240px; max-height: 90px; object-fit: contain; display: block; margin-bottom: 8px; background: transparent; filter: drop-shadow(0 0 1px rgba(0,0,0,.45)); }
          h1 { margin: 0 0 6px; font-size: 28px; }
          h2 { margin: 22px 0 8px; font-size: 17px; }
          p { margin: 4px 0; }
          table { width: 100%; border-collapse: collapse; margin-top: 16px; }
          th, td { padding: 10px; border-bottom: 1px solid #d7ddda; text-align: left; }
          th { background: #eef4f2; }
          .right { text-align: right; }
          .total { font-size: 24px; font-weight: 800; margin-top: 18px; text-align: right; }
          .notes { margin-top: 20px; padding: 12px; background: #f5f5f2; }
          .legal { margin-top: 18px; color: #667074; font-size: 12px; }
          .plate-line { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
          .vehicle-plate { width: 94px; height: 30px; display: inline-flex; vertical-align: middle; filter: drop-shadow(0 3px 8px rgba(0,0,0,.16)); }
          .vehicle-plate svg { width: 100%; height: 100%; display: block; }
          .vehicle-plate-classic { width: 94px; height: 40px; }
          .vehicle-plate-empty { width: auto; height: 24px; align-items: center; border: 1px dashed #74817b; border-radius: 5px; padding: 0 8px; background: rgba(0,0,0,.04); color: #667074; font-family: Arial, sans-serif; font-size: 11px; font-weight: 800; }
          @media print { .actions { display: none; } body { background: white; } .document { margin: 0; border: 0; width: auto; } }
        </style>
        ${
          autoPrint
            ? `<script>
                window.addEventListener("load", () => {
                  setTimeout(() => window.print(), 450);
                });
              </script>`
            : ""
        }
      </head>
      <body>
        <div class="actions">
          <button class="primary" onclick="window.print()">Descargar PDF</button>
          <button class="primary" onclick="window.opener.shareQuotePdf('${quote.id}')">WhatsApp PDF</button>
          <button class="secondary" onclick="window.print()">Imprimir / Guardar</button>
        </div>
        <main class="document">
          <header>
            <div>
              <img class="doc-logo" src="assets/ditaranto-logo-wordmark-boost.png" alt="${settings.shopName}" />
              <h1>${settings.shopName}</h1>
              <p>${settings.shopAddress || ""}</p>
              <p>${settings.shopWhatsapp ? "WhatsApp: " + settings.shopWhatsapp : ""}</p>
              <p>${settings.shopTaxId || ""} ${settings.shopTaxCondition || ""}</p>
            </div>
            <div class="right">
              <h1>Cotización</h1>
              <p><strong>${quote.number}</strong></p>
              <p>Válida hasta: ${quote.validUntil}</p>
              <p>Estado: ${quote.status || "Cotización"}</p>
            </div>
          </header>
          <h2>Cliente</h2>
          <p><strong>${client.name}</strong></p>
          <p>WhatsApp: ${client.whatsapp}</p>
          <p>${plateLine(vehicle?.plate, `Vehículo: ${vehicle?.vehicle || "-"}`)}</p>
          <table>
            <thead>
              <tr>
                <th>Concepto</th>
                <th>Cantidad</th>
                <th>Precio</th>
                <th>Subtotal</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="total">Total: ${recordTotalLabel(quote)}</div>
          ${settings.shopPayment ? `<div class="notes"><strong>Pago:</strong> ${settings.shopPayment}</div>` : ""}
          ${quote.notes ? `<div class="notes"><strong>Observaciones:</strong> ${quote.notes}</div>` : ""}
          <p class="legal">Cotización sujeta a revisión del vehículo y disponibilidad de turno.</p>
        </main>
      </body>
    </html>
  `);
  doc.document.close();
}

function openPaymentReceipt(id, options = {}) {
  const payment = state.payments.find((item) => item.id === id);
  const client = payment ? paymentClient(payment) : null;
  if (!payment || !client) return;
  const modal = $("#receiptModal");
  if (modal) {
    modal.dataset.paymentId = payment.id;
    $("#receiptModalTitle").textContent = paymentReceiptNumber(payment);
    $("#receiptModalDocument").innerHTML = paymentReceiptPreviewHtml(payment);
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    $("#closeReceiptModal")?.focus();
    if (options.autoPrint) showToast("Recibo listo. Podés descargarlo desde el visor.");
    return;
  }
  const settings = state.settings;
  const details = paymentReceiptDetails(payment);
  const receiptRows = details.items
    .map(
      (item) => `
        <tr>
          <td>${paymentLineLabel(item)}</td>
          <td>${Math.max(1, Number(item.quantity || 1))}</td>
          <td>${formatCurrency(item.price, item.currency)}</td>
          <td>${formatCurrency(paymentLineSubtotal(item), item.currency)}</td>
        </tr>
      `
    )
    .join("");
  const doc = window.open("", "_blank");
  const autoPrint = Boolean(options.autoPrint);
  doc.document.write(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <title>${paymentReceiptNumber(payment)}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; background: #eef1ef; color: #1f2628; }
          .receipt { width: min(100%, 560px); margin: 18px auto; background: white; padding: 24px; border: 1px solid #d7ddda; }
          .actions { display: flex; gap: 10px; margin: 0 auto 12px; width: min(100%, 560px); padding-top: 18px; }
          button { min-height: 38px; border: 0; border-radius: 6px; padding: 0 13px; font-weight: 700; cursor: pointer; }
          .primary { background: #0b6b62; color: white; }
          .secondary { background: #e8efed; color: #1f2628; }
          header { display: flex; justify-content: space-between; gap: 18px; border-bottom: 2px solid #46e323; padding-bottom: 12px; }
          .receipt-logo { width: 230px; max-height: 82px; object-fit: contain; display: block; margin-bottom: 6px; background: transparent; filter: drop-shadow(0 0 1px rgba(0,0,0,.45)); }
          h1 { margin: 0 0 4px; font-size: 24px; }
          h2 { margin: 18px 0 8px; font-size: 16px; }
          p { margin: 3px 0; font-size: 13px; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
          th, td { padding: 8px; border-bottom: 1px solid #d7ddda; text-align: left; }
          th { background: #eef4f2; }
          .right { text-align: right; }
          .total { font-size: 22px; font-weight: 800; margin-top: 12px; text-align: right; }
          .receipt-meta { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 12px 0 4px; color: #667074; font-size: 12px; }
          .notes { margin-top: 14px; padding: 10px; background: #f5f5f2; font-size: 12px; }
          .legal { margin-top: 16px; color: #667074; font-size: 11px; }
          @media print { .actions { display: none; } body { background: white; } .receipt { margin: 0; border: 0; width: auto; } }
        </style>
        ${
          autoPrint
            ? `<script>
                window.addEventListener("load", () => {
                  setTimeout(() => window.print(), 450);
                });
              </script>`
            : ""
        }
      </head>
      <body>
        <div class="actions">
          <button class="primary" onclick="window.print()">Descargar PDF</button>
          <button class="primary" onclick="window.opener.sharePaymentReceiptPdf('${payment.id}')">WhatsApp PDF</button>
          <button class="secondary" onclick="window.print()">Imprimir / Guardar</button>
        </div>
        <main class="receipt">
          <header>
            <div>
              <img class="receipt-logo" src="assets/ditaranto-logo-wordmark-boost.png" alt="${settings.shopName}" />
              <h1>${settings.shopName}</h1>
              <p>${settings.shopAddress || ""}</p>
              <p>${settings.shopWhatsapp ? "WhatsApp: " + settings.shopWhatsapp : ""}</p>
              <p>${settings.shopTaxId || ""} ${settings.shopTaxCondition || ""}</p>
            </div>
            <div class="right">
              <h1>Recibo</h1>
              <p><strong>${paymentReceiptNumber(payment)}</strong></p>
              <p>${payment.date}</p>
            </div>
          </header>
          <h2>Cliente</h2>
          <p><strong>${client.name}</strong> · ${client.whatsapp}</p>
          <p>${details.vehicleLabel}</p>
          <div class="receipt-meta">
            <span>Turno: ${details.appointmentLabel}</span>
            <span>Método: ${payment.method || "-"}</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Concepto</th>
                <th>Cant.</th>
                <th>Unitario</th>
                <th>Subtotal</th>
              </tr>
            </thead>
            <tbody>
              ${receiptRows}
            </tbody>
          </table>
          <div class="total">Total: ${formatCurrency(payment.amount, details.currency)}</div>
          ${payment.notes ? `<div class="notes"><strong>Notas:</strong> ${payment.notes}</div>` : ""}
          <p class="legal">Comprobante interno. No reemplaza factura fiscal electrónica.</p>
        </main>
      </body>
    </html>
  `);
  doc.document.close();
}

function openInvoicePdf(id) {
  const invoice = state.invoices.find((item) => item.id === id);
  const client = getClient(invoice?.clientId);
  if (!invoice || !client) return;
  const vehicle = recordVehicle(invoice, client);
  const settings = state.settings;
  const rows = invoice.items
    .map(
      (item) => `
        <tr>
          <td>${item.desc}</td>
          <td>${item.qty}</td>
          <td>${formatCurrency(item.price, item.currency)}</td>
          <td>${formatCurrency(item.qty * item.price, item.currency)}</td>
        </tr>
      `
    )
    .join("");
  const doc = window.open("", "_blank");
  doc.document.write(`
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <title>${invoice.number}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 36px; color: #1f2628; }
          header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #46e323; padding-bottom: 18px; }
          .doc-logo { width: 240px; max-height: 90px; object-fit: contain; display: block; margin-bottom: 8px; background: transparent; filter: drop-shadow(0 0 1px rgba(0,0,0,.45)); }
          h1 { margin: 0 0 6px; font-size: 30px; }
          h2 { margin: 24px 0 8px; font-size: 18px; }
          p { margin: 4px 0; }
          table { width: 100%; border-collapse: collapse; margin-top: 18px; }
          th, td { padding: 11px; border-bottom: 1px solid #d7ddda; text-align: left; }
          th { background: #eef4f2; }
          .right { text-align: right; }
          .total { font-size: 24px; font-weight: 800; margin-top: 18px; text-align: right; }
          .notes { margin-top: 24px; padding: 12px; background: #f5f5f2; }
          .plate-line { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
          .vehicle-plate { width: 94px; height: 30px; display: inline-flex; vertical-align: middle; filter: drop-shadow(0 3px 8px rgba(0,0,0,.16)); }
          .vehicle-plate svg { width: 100%; height: 100%; display: block; }
          .vehicle-plate-classic { width: 94px; height: 40px; }
          .vehicle-plate-empty { width: auto; height: 24px; align-items: center; border: 1px dashed #74817b; border-radius: 5px; padding: 0 8px; background: rgba(0,0,0,.04); color: #667074; font-family: Arial, sans-serif; font-size: 11px; font-weight: 800; }
          @media print { button { display: none; } body { margin: 24px; } }
        </style>
      </head>
      <body>
        <button onclick="window.print()">Guardar como PDF / Imprimir</button>
        <header>
          <div>
            <img class="doc-logo" src="assets/ditaranto-logo-wordmark-boost.png" alt="${settings.shopName}" />
            <h1>${settings.shopName}</h1>
            <p>${settings.shopAddress || ""}</p>
            <p>${settings.shopWhatsapp ? "WhatsApp: " + settings.shopWhatsapp : ""}</p>
            <p>${settings.shopTaxId || ""} ${settings.shopTaxCondition || ""}</p>
          </div>
          <div class="right">
            <h1>Factura</h1>
            <p><strong>${invoice.number}</strong></p>
            <p>Fecha: ${invoice.date}</p>
            <p>Estado: ${invoice.status}</p>
          </div>
        </header>
        <h2>Cliente</h2>
        <p><strong>${client.name}</strong></p>
        <p>WhatsApp: ${client.whatsapp}</p>
        <p>${plateLine(vehicle?.plate, `Vehículo: ${vehicle?.vehicle || "-"}`)}</p>
        <table>
          <thead>
            <tr>
              <th>Servicio</th>
              <th>Cantidad</th>
              <th>Precio</th>
              <th>Subtotal</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="total">Total: ${recordTotalLabel(invoice)}</div>
        ${settings.shopPayment ? `<div class="notes"><strong>Pago:</strong> ${settings.shopPayment}</div>` : ""}
        ${invoice.notes ? `<div class="notes"><strong>Observaciones:</strong> ${invoice.notes}</div>` : ""}
      </body>
    </html>
  `);
  doc.document.close();
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button, a");
  if (!target) return;

  if (target.id === "confirmCancel") return closeConfirm(false);
  if (target.id === "confirmAccept") return closeConfirm(true);
  if (target.id === "confirmDialog") return closeConfirm(false);
  if (target.id === "closeReceiptModal" || target.id === "receiptModal") return closePaymentReceiptModal();
  if (target.id === "receiptModalDownload") {
    const id = $("#receiptModal")?.dataset.paymentId;
    if (id) downloadPaymentReceiptPdf(id);
  }
  if (target.id === "receiptModalWhatsapp") {
    const id = $("#receiptModal")?.dataset.paymentId;
    if (id) sharePaymentReceiptPdf(id);
  }
  if (target.id === "mobileMoreToggle") toggleMobileMore();
  if (target.id === "mobileMoreClose" || target.id === "mobileMorePanel") closeMobileMore();
  if (target.id === "universalActionToggle") toggleUniversalActions();
  if (target.id === "universalActionClose" || target.id === "universalActionPanel") closeUniversalActions();
  if (target.dataset.universalAction) runUniversalAction(target.dataset.universalAction);
  if (target.id === "mobileAlertsShortcut") {
    toggleNotifications(true);
    $("#globalSearch")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (target.dataset.tab) switchTab(target.dataset.tab);
  if (target.dataset.openTab) switchTab(target.dataset.openTab);
  if (target.id === "notificationToggle") toggleNotifications();
  if (target.id === "clearNotifications") clearNotifications();
  if (target.dataset.notificationTab) {
    toggleNotifications(false);
    switchTab(target.dataset.notificationTab);
  }
  if (target.dataset.searchType) {
    openSearchResult(target.dataset.searchType, target.dataset.searchId);
  }
  if (target.dataset.closeQuickProfile !== undefined) closeQuickProfile();
  if (target.dataset.openQuickClient) {
    showQuickProfile(target.dataset.openQuickClient, target.dataset.openQuickVehicle || "");
  }
  if (target.dataset.quickAction) {
    runQuickProfileAction(target.dataset.quickAction, target.dataset.quickClient, target.dataset.quickVehicle || "");
  }
  if (target.dataset.copyWhatsapp) {
    try {
      await navigator.clipboard.writeText(target.dataset.copyWhatsapp);
      showToast("WhatsApp copiado.");
    } catch {
      showToast("No pude copiar el WhatsApp.", "error");
    }
  }

  if (target.dataset.receptionClient) {
    $("#receptionClient").value = target.dataset.receptionClient;
    fillReceptionFromClient(target.dataset.receptionClient);
  }

  if (target.dataset.editClient) {
    const client = getClient(target.dataset.editClient);
    fillClientForm(client);
    switchTab("clients");
  }

  if (target.dataset.removeClientVehicle !== undefined) {
    target.closest(".client-vehicle-row")?.remove();
  }

  if (target.dataset.historyClient) {
    selectedClientHistoryId = target.dataset.historyClient;
    selectedClientHistoryVehicleId = "";
    renderClientHistory();
    switchTab("clients");
  }

  if (target.dataset.appointmentClient) {
    resetAppointmentForm();
    $("#appointmentClient").value = target.dataset.appointmentClient;
    updateAppointmentVehicleInfo();
    switchTab("appointments");
    setAppointmentFormOpen(true, { focus: true });
  }

  if (target.dataset.deleteClient && await askConfirm({ title: "Eliminar cliente", message: "Se eliminará el cliente de la base. Sus movimientos anteriores pueden quedar como registros históricos.", action: "Eliminar" })) {
    state.clients = state.clients.filter((client) => client.id !== target.dataset.deleteClient);
    if (selectedClientHistoryId === target.dataset.deleteClient) selectedClientHistoryId = "";
    saveState();
    showToast("Cliente eliminado.");
  }

  if (target.dataset.editService) {
    const service = getService(target.dataset.editService);
    $("#serviceId").value = service.id;
    $("#serviceName").value = service.name;
    $("#servicePrice").value = service.price;
    $("#serviceCurrency").value = normalizeCurrency(service.currency);
    $("#serviceCategory").value = serviceCategory(service);
    $("#serviceDescription").value = service.description || "";
    switchTab("services");
  }

  if (target.dataset.deleteService && await askConfirm({ title: "Eliminar servicio", message: "El servicio dejará de aparecer en nuevas cotizaciones, turnos y cobros.", action: "Eliminar" })) {
    state.services = state.services.filter((service) => service.id !== target.dataset.deleteService);
    saveState();
    showToast("Servicio eliminado.");
  }

  if (target.dataset.editProduct) {
    const product = getProduct(target.dataset.editProduct);
    $("#productId").value = product.id;
    $("#productName").value = product.name;
    $("#productPrice").value = product.price;
    $("#productStock").value = product.stock;
    $("#productMinStock").value = product.minStock;
    $("#productDescription").value = product.description || "";
    switchTab("products");
  }

  if (target.dataset.deleteProduct && await askConfirm({ title: "Eliminar producto", message: "El producto dejará de estar disponible para nuevos cobros y stock.", action: "Eliminar" })) {
    state.products = state.products.filter((product) => product.id !== target.dataset.deleteProduct);
    saveState();
    showToast("Producto eliminado.");
  }

  if (target.dataset.editAppointment) fillAppointmentForm(target.dataset.editAppointment);
  if (target.dataset.chargeAppointment) fillPaymentFromAppointment(target.dataset.chargeAppointment);
  if (target.dataset.chargeBalance) fillPaymentFromAppointment(target.dataset.chargeBalance, "balance");

  if (target.dataset.cancelAppointment && await askConfirm({ title: "Cancelar turno", message: "El turno saldrá de la agenda pendiente, pero seguirá registrado como cancelado.", action: "Cancelar turno", tone: "primary" })) {
    const appointment = state.appointments.find((item) => item.id === target.dataset.cancelAppointment);
    if (appointment) {
      appointment.status = "Cancelado";
      saveState();
      showToast("Turno cancelado.");
    }
  }

  if (target.dataset.deleteAppointment && await askConfirm({ title: "Eliminar turno", message: "Se eliminará este turno del sistema.", action: "Eliminar" })) {
    state.appointments = state.appointments.filter((appointment) => appointment.id !== target.dataset.deleteAppointment);
    saveState();
    showToast("Turno eliminado.");
  }

  if (target.dataset.editPayment) fillPaymentForm(target.dataset.editPayment);
  if (target.dataset.paymentReceipt) openPaymentReceipt(target.dataset.paymentReceipt);
  if (target.dataset.downloadPayment) downloadPaymentReceiptPdf(target.dataset.downloadPayment);
  if (target.dataset.sharePayment) sharePaymentReceiptPdf(target.dataset.sharePayment);
  if (target.dataset.paymentKind) setPaymentKind(target.dataset.paymentKind);
  if (target.dataset.paymentCatalogItem) {
    setPaymentItemSelection(target.dataset.paymentCatalogItem);
    updatePaymentCalculation(true);
  }
  if (target.id === "newPaymentFromDone") resetPaymentForm();
  if (target.dataset.removePaymentItem) {
    paymentDraftItems = paymentDraftItems.filter((item) => item.id !== target.dataset.removePaymentItem);
    if (!paymentDraftItems.length) updatePaymentCalculation(true);
    renderPaymentTicket();
  }

  if (target.dataset.deletePayment && await askConfirm({ title: "Eliminar cobro", message: "Se eliminará el cobro y se ajustará el stock asociado si correspondía.", action: "Eliminar cobro" })) {
    const payment = state.payments.find((item) => item.id === target.dataset.deletePayment);
    adjustStockForPaymentChange(payment, null);
    state.payments = state.payments.filter((payment) => payment.id !== target.dataset.deletePayment);
    saveState();
    showToast("Cobro eliminado.");
  }

  if (target.dataset.editQuote) fillQuoteForm(target.dataset.editQuote);
  if (target.dataset.editInvoice) fillInvoiceForm(target.dataset.editInvoice);
  if (target.dataset.invoiceFrom) createInvoiceFromQuote(target.dataset.invoiceFrom);
  if (target.dataset.quotePdf) openQuotePdf(target.dataset.quotePdf);
  if (target.dataset.downloadQuote) downloadQuotePdf(target.dataset.downloadQuote);
  if (target.dataset.shareQuote) shareQuotePdf(target.dataset.shareQuote);
  if (target.dataset.pdf) openInvoicePdf(target.dataset.pdf);

  if (target.dataset.editTemplate || target.dataset.useTemplate) {
    const template = state.whatsappTemplates.find((item) => item.id === (target.dataset.editTemplate || target.dataset.useTemplate));
    if (template) {
      $("#templateId").value = template.id;
      $("#templateName").value = template.name;
      $("#templateBody").value = template.body;
      updateTemplatePreview();
      switchTab("whatsappTemplates");
    }
  }

  if (target.dataset.deleteTemplate && await askConfirm({ title: "Eliminar plantilla", message: "La plantilla dejará de estar disponible para mensajes de WhatsApp.", action: "Eliminar" })) {
    state.whatsappTemplates = state.whatsappTemplates.filter((template) => template.id !== target.dataset.deleteTemplate);
    saveState();
    showToast("Plantilla eliminada.");
  }

  if (target.dataset.deleteQuote && await askConfirm({ title: "Eliminar cotización", message: "Se eliminará esta cotización guardada.", action: "Eliminar" })) {
    state.quotes = state.quotes.filter((quote) => quote.id !== target.dataset.deleteQuote);
    saveState();
    showToast("Cotización eliminada.");
  }

  if (target.dataset.deleteInvoice && await askConfirm({ title: "Eliminar factura", message: "Se eliminará esta factura del historial.", action: "Eliminar" })) {
    state.invoices = state.invoices.filter((invoice) => invoice.id !== target.dataset.deleteInvoice);
    saveState();
    showToast("Factura eliminada.");
  }
});

$("#confirmDialog")?.addEventListener("click", (event) => {
  if (event.target.id === "confirmDialog") closeConfirm(false);
});

$("#receiptModal")?.addEventListener("click", (event) => {
  if (event.target.id === "receiptModal") closePaymentReceiptModal();
});

$("#mobileMorePanel")?.addEventListener("click", (event) => {
  if (event.target.id === "mobileMorePanel") closeMobileMore();
});

$("#universalActionPanel")?.addEventListener("click", (event) => {
  if (event.target.id === "universalActionPanel") closeUniversalActions();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && pendingConfirmResolver) closeConfirm(false);
  if (event.key === "Escape" && !$("#receiptModal")?.hidden) closePaymentReceiptModal();
  if (event.key === "Escape" && !$("#mobileMorePanel")?.hidden) closeMobileMore();
  if (event.key === "Escape" && !$("#universalActionPanel")?.hidden) closeUniversalActions();
});

$("#clientForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = $("#clientId").value || uid("client");
  const vehicles = readClientVehicles();
  const primary = vehicles[0] || normalizeVehicleEntry({});
  const client = {
    id,
    name: $("#clientName").value.trim(),
    whatsapp: $("#clientWhatsapp").value.trim(),
    plate: primary.plate,
    brand: primary.brand,
    vehicle: primary.vehicle,
    vehicles,
  };
  const index = state.clients.findIndex((item) => item.id === id);
  if (index >= 0) state.clients[index] = client;
  else state.clients.unshift(client);
  resetClientForm();
  saveState();
});

$("#serviceForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = $("#serviceId").value || uid("service");
  const service = {
    id,
    name: $("#serviceName").value.trim(),
    price: Number($("#servicePrice").value || 0),
    currency: normalizeCurrency($("#serviceCurrency").value),
    category: $("#serviceCategory").value,
    description: $("#serviceDescription").value.trim(),
  };
  const index = state.services.findIndex((item) => item.id === id);
  if (index >= 0) state.services[index] = service;
  else state.services.unshift(service);
  resetServiceForm();
  saveState();
});

$("#productForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = $("#productId").value || uid("product");
  const product = {
    id,
    name: $("#productName").value.trim(),
    price: Number($("#productPrice").value || 0),
    stock: Number($("#productStock").value || 0),
    minStock: Number($("#productMinStock").value || 0),
    description: $("#productDescription").value.trim(),
  };
  const index = state.products.findIndex((item) => item.id === id);
  if (index >= 0) state.products[index] = product;
  else state.products.unshift(product);
  resetProductForm();
  saveState();
});

$("#appointmentForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = $("#appointmentId").value || uid("appointment");
  const service = getService($("#appointmentService").value);
  const appointment = {
    id,
    clientId: $("#appointmentClient").value,
    vehicleId: $("#appointmentVehicle").value,
    vehicle: selectedVehicleSnapshot($("#appointmentClient").value, $("#appointmentVehicle").value),
    guestName: $("#appointmentGuestName").value.trim() || "Cliente sin agendar",
    guestWhatsapp: $("#appointmentGuestWhatsapp").value.trim(),
    serviceId: $("#appointmentService").value,
    serviceName: service?.name || "",
    date: $("#appointmentDate").value,
    time: $("#appointmentTime").value,
    status: $("#appointmentStatus").value,
    notes: $("#appointmentNotes").value.trim(),
  };
  const index = state.appointments.findIndex((item) => item.id === id);
  if (index >= 0) state.appointments[index] = appointment;
  else state.appointments.unshift(appointment);
  resetAppointmentForm();
  setAppointmentFormOpen(false);
  saveState();
  showToast(index >= 0 ? "Turno actualizado." : "Turno agendado.");
});

$("#paymentForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = $("#paymentId").value || uid("payment");
  const existing = state.payments.find((payment) => payment.id === id);
  const items = paymentDraftItems;
  if (!items.length) return showToast("Agregá al menos un servicio o producto al cobro.", "error");
  const firstService = items.find((item) => item.type === "service");
  const firstProduct = items.find((item) => item.type === "product");
  const suggestedTotal = paymentItemsTotal(items);
  const amount = Number($("#paymentAmount").value || suggestedTotal || 0);
  const received = Number($("#paymentReceived").value || 0);
  const change = Math.max(received - amount, 0);
  const inferredType = suggestedTotal && amount < suggestedTotal ? "Seña" : $("#paymentType").value;
  const payment = {
    id,
    receiptNumber: existing?.receiptNumber || nextNumber(state.payments, "REC"),
    clientId: $("#paymentClient").value,
    vehicleId: $("#paymentVehicle").value,
    vehicle: selectedVehicleSnapshot($("#paymentClient").value, $("#paymentVehicle").value),
    guestName: $("#paymentClient").value ? "" : $("#paymentGuestName").value.trim(),
    guestWhatsapp: $("#paymentGuestWhatsapp").value.trim(),
    appointmentId: $("#paymentAppointment").value,
    serviceId: firstService?.itemId || "",
    productId: items.length === 1 ? firstProduct?.itemId || "" : "",
    quantity: items.length === 1 ? firstProduct?.quantity || 1 : 1,
    serviceName: paymentItemsLabel(items),
    items: items.map((item) => ({
      id: item.id,
      type: item.type,
      itemId: item.itemId,
      serviceId: item.type === "service" ? item.itemId : "",
      productId: item.type === "product" ? item.itemId : "",
      name: item.name,
      quantity: Math.max(1, Number(item.quantity || 1)),
      price: Number(item.price || 0),
      currency: normalizeCurrency(item.currency),
    })),
    date: $("#paymentDate").value,
    amount,
    received,
    change,
    type: inferredType,
    currency: normalizeCurrency($("#paymentCurrency").value),
    method: $("#paymentMethod").value,
    notes: $("#paymentNotes").value.trim(),
  };
  const index = state.payments.findIndex((item) => item.id === id);
  adjustStockForPaymentChange(existing, payment);
  if (index >= 0) state.payments[index] = payment;
  else state.payments.unshift(payment);
  saveState();
  resetPaymentForm();
  showPaymentDone(payment);
  openPaymentReceipt(id);
});

$("#quoteForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const items = readItems("#quoteItems");
  if (!items.length) return showToast("Agregá al menos un servicio.", "error");
  const id = $("#quoteId").value || uid("quote");
  const existing = state.quotes.find((quote) => quote.id === id);
  const quote = {
    id,
    number: existing?.number || nextNumber(state.quotes, "COT"),
    clientId: $("#quoteClient").value,
    vehicleId: $("#quoteVehicle").value,
    vehicle: selectedVehicleSnapshot($("#quoteClient").value, $("#quoteVehicle").value),
    validUntil: $("#quoteValidUntil").value,
    notes: $("#quoteNotes").value.trim(),
    items,
    totals: totalsByCurrency(items),
    total: totalItems(items),
  };
  const index = state.quotes.findIndex((item) => item.id === id);
  if (index >= 0) state.quotes[index] = quote;
  else state.quotes.unshift(quote);
  resetQuoteForm();
  saveState();
});

$("#invoiceForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const items = readItems("#invoiceItems");
  if (!items.length) return showToast("Agregá al menos un servicio.", "error");
  const id = $("#invoiceId").value || uid("invoice");
  const existing = state.invoices.find((invoice) => invoice.id === id);
  const sourceQuote = state.quotes.find((quote) => quote.id === $("#invoiceQuote").value);
  const invoiceVehicle = existing?.vehicle || sourceQuote?.vehicle || selectedVehicleSnapshot($("#invoiceClient").value, sourceQuote?.vehicleId);
  const invoice = {
    id,
    number: existing?.number || nextNumber(state.invoices, "FAC"),
    clientId: $("#invoiceClient").value,
    quoteId: $("#invoiceQuote").value,
    vehicleId: existing?.vehicleId || sourceQuote?.vehicleId || "",
    vehicle: invoiceVehicle || null,
    date: $("#invoiceDate").value,
    status: $("#invoiceStatus").value,
    notes: $("#invoiceNotes").value.trim(),
    items,
    totals: totalsByCurrency(items),
    total: totalItems(items),
  };
  const index = state.invoices.findIndex((item) => item.id === id);
  if (index >= 0) state.invoices[index] = invoice;
  else state.invoices.unshift(invoice);
  resetInvoiceForm();
  saveState();
});

$("#templateForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = $("#templateId").value || uid("template");
  const template = {
    id,
    name: $("#templateName").value.trim(),
    body: $("#templateBody").value.trim(),
  };
  const index = state.whatsappTemplates.findIndex((item) => item.id === id);
  if (index >= 0) state.whatsappTemplates[index] = template;
  else state.whatsappTemplates.unshift(template);
  resetTemplateForm();
  saveState();
});

$("#settingsForm").addEventListener("submit", (event) => {
  event.preventDefault();
  Object.keys(state.settings).forEach((key) => {
    const input = $("#" + key);
    if (input) state.settings[key] = input.value.trim();
  });
  applyTheme();
  saveState();
});

$("#themeToggle").addEventListener("click", () => {
  state.settings.appTheme = currentTheme() === "light" ? "dark" : "light";
  applyTheme();
  saveState();
});

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await login($("#loginUser").value, $("#loginPassword").value);
});
$("#recoverLogin").addEventListener("click", async () => {
  $("#loginUser").value = "admin";
  $("#loginPassword").value = "1234";
  await login("admin", "1234");
});
$("#logoutButton").addEventListener("click", logout);
const debouncedGlobalSearch = debounce(renderGlobalSearch, 110);
const debouncedReceptionMatches = debounce(renderReceptionMatches, 110);
$("#globalSearch").addEventListener("input", debouncedGlobalSearch);
$("#receptionSearch").addEventListener("input", debouncedReceptionMatches);
$("#receptionClient").addEventListener("change", () => fillReceptionFromClient($("#receptionClient").value));
$("#receptionVehicle").addEventListener("change", fillReceptionFromVehicle);
$("#receptionService").addEventListener("change", () => {
  syncReceptionItemType();
});
$("#receptionItemType").addEventListener("change", syncReceptionItemType);
$("#receptionProduct").addEventListener("change", syncReceptionItemType);
["receptionName", "receptionWhatsapp", "receptionPlate", "receptionBrand", "receptionModel", "receptionDate", "receptionTime", "receptionAmount", "receptionCurrency", "receptionNotes"].forEach((id) => {
  $("#" + id)?.addEventListener("input", scheduleReceptionSummary);
  $("#" + id)?.addEventListener("change", scheduleReceptionSummary);
});
$("#clearReception").addEventListener("click", resetReceptionForm);
$("#clearReceptionSelection").addEventListener("click", resetReceptionForm);
$("#receptionCreateAppointment").addEventListener("click", createReceptionAppointment);
$("#receptionCreateQuote").addEventListener("click", createReceptionQuote);
$("#receptionCreatePayment").addEventListener("click", createReceptionPayment);
$("#clearClient").addEventListener("click", resetClientForm);
$("#clearService").addEventListener("click", resetServiceForm);
$("#clearProduct").addEventListener("click", resetProductForm);
$("#clearAppointment").addEventListener("click", resetAppointmentForm);
$("#openAppointmentForm").addEventListener("click", () => {
  resetAppointmentForm();
  setAppointmentFormOpen(true, { focus: true });
});
$("#closeAppointmentForm").addEventListener("click", () => {
  resetAppointmentForm();
  setAppointmentFormOpen(false);
});
$("#appointmentToday").addEventListener("click", () => {
  $("#appointmentDate").value = today();
  $("#weeklyDate").value = weekStart(today());
  agendaFilter = "today";
  renderAppointments();
});
$("#appointmentTomorrow").addEventListener("click", () => {
  const tomorrow = addDays(1);
  $("#appointmentDate").value = tomorrow;
  $("#weeklyDate").value = weekStart(tomorrow);
  agendaFilter = "tomorrow";
  renderAppointments();
});
$("#appointmentClient").addEventListener("change", () => {
  if ($("#appointmentClient").value) {
    $("#appointmentGuestName").value = "";
    $("#appointmentGuestWhatsapp").value = "";
  }
  updateAppointmentVehicleInfo();
});
$("#clearPayment").addEventListener("click", resetPaymentForm);
$("#clearQuote").addEventListener("click", resetQuoteForm);
$("#clearInvoice").addEventListener("click", resetInvoiceForm);
$("#clearTemplate").addEventListener("click", resetTemplateForm);
$("#addClientVehicle").addEventListener("click", () => addClientVehicleRow());
$("#addQuoteItem").addEventListener("click", () => addItemRow("#quoteItems"));
$("#addInvoiceItem").addEventListener("click", () => addItemRow("#invoiceItems"));
$("#clientSearch").addEventListener("input", renderClients);
$("#clientHistoryClientFilter").addEventListener("change", (event) => {
  selectedClientHistoryId = event.target.value;
  selectedClientHistoryVehicleId = "";
  renderClientHistory();
});
$("#clientHistoryVehicleFilter").addEventListener("change", (event) => {
  selectedClientHistoryVehicleId = event.target.value;
  renderClientHistory();
});
$("#serviceCategoryFilter").addEventListener("change", renderServices);
$("#paymentSearch").addEventListener("input", renderPayments);
$("#paymentMethodFilter").addEventListener("change", renderPayments);
$("#paymentCurrencyFilter").addEventListener("change", renderPayments);
$("#cashDate").addEventListener("change", renderCashDashboard);
$("#downloadCashClosing").addEventListener("click", downloadCashClosingPdf);
$("#weeklyDate").addEventListener("change", renderAppointments);
$("#agendaFilter").addEventListener("click", (event) => {
  const button = event.target.closest("[data-agenda-filter]");
  if (!button) return;
  agendaFilter = button.dataset.agendaFilter;
  if (agendaFilter === "today") $("#weeklyDate").value = weekStart(today());
  if (agendaFilter === "tomorrow") $("#weeklyDate").value = weekStart(addDays(1));
  renderAppointments();
});
$("#reportMonth").addEventListener("change", renderReports);
$("#templateClient").addEventListener("change", updateTemplatePreview);
$("#templateBody").addEventListener("input", updateTemplatePreview);
$("#sendTemplateWhatsapp").addEventListener("click", () => {
  const client = getClient($("#templateClient").value);
  if (!client?.whatsapp) return showToast("Elegí un cliente con WhatsApp cargado.", "error");
  const message = fillTemplate($("#templateBody").value, client.id);
  window.open(`https://wa.me/${client.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
});
$("#exportBackup").addEventListener("click", exportBackup);
$("#importBackup").addEventListener("change", (event) => {
  importBackup(event.target.files?.[0]);
  event.target.value = "";
});
$("#smartMigrationFile").addEventListener("change", (event) => {
  analyzeSmartMigration(event.target.files?.[0]);
  event.target.value = "";
});
$("#applyMigration").addEventListener("click", applySmartMigration);
$("#clearMigration").addEventListener("click", () => {
  migrationDraft = null;
  renderMigrationTool();
  showToast("Análisis limpiado.");
});
$("#globalSearch").addEventListener("focus", renderGlobalSearch);
$("#globalSearch").addEventListener("blur", () => {
  window.setTimeout(() => {
    if (!$("#globalResults")?.matches(":hover") && !$("#globalSearch").value.trim()) renderGlobalSearch();
  }, 180);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    $("#globalSearch")?.focus();
  }
  if (event.key === "Escape") {
    closeQuickProfile();
    if ($("#globalSearch")) {
      $("#globalSearch").value = "";
      renderGlobalSearch();
    }
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncFromServer({ notify: true });
});

$("#paymentItemType").addEventListener("change", () => {
  updatePaymentCalculation(true);
  renderPaymentCatalog();
});
$("#paymentServiceChoice").addEventListener("change", () => {
  updatePaymentCalculation(true);
  renderPaymentCatalog();
});
$("#paymentProductChoice").addEventListener("change", () => {
  updatePaymentCalculation(true);
  renderPaymentCatalog();
});
$("#addPaymentItem").addEventListener("click", addPaymentDraftItem);
$("#clearPaymentItems").addEventListener("click", () => {
  paymentDraftItems = [];
  updatePaymentCalculation(true);
  renderPaymentTicket();
});

$("#paymentQuantity").addEventListener("input", () => updatePaymentCalculation(true));
$("#paymentAmount").addEventListener("input", updatePaymentChange);
$("#paymentReceived").addEventListener("input", updatePaymentChange);
$("#paymentCurrency").addEventListener("change", updatePaymentChange);
$("#paymentMethod").addEventListener("change", updatePaymentChange);

$("#paymentClient").addEventListener("change", () => {
  updateVehicleSelect("paymentVehicle", $("#paymentClient").value);
  if ($("#paymentClient").value) {
    $("#paymentGuestName").value = "";
    $("#paymentGuestWhatsapp").value = "";
  }
});

$("#quoteClient").addEventListener("change", () => {
  updateVehicleSelect("quoteVehicle", $("#quoteClient").value);
});

$("#paymentAppointment").addEventListener("change", (event) => {
  const appointment = state.appointments.find((item) => item.id === event.target.value);
  const service = getService(appointment?.serviceId);
  if (!appointment) return;
  const status = appointmentPaymentStatus(appointment);
  $("#paymentClient").value = appointment.clientId;
  updateVehicleSelect("paymentVehicle", appointment.clientId, appointment.vehicleId);
  $("#paymentGuestName").value = appointment.clientId ? "" : appointment.guestName || "";
  $("#paymentGuestWhatsapp").value = appointment.clientId ? "" : appointment.guestWhatsapp || "";
  setPaymentItemSelection(paymentItemValue("service", appointment.serviceId));
  $("#paymentQuantity").value = 1;
  if (service) {
    $("#paymentCurrency").value = normalizeCurrency(service.currency);
  }
  $("#paymentAmount").value = status.balance || service?.price || "";
  $("#paymentType").value = status.paid > 0 ? "Saldo" : "Pago total";
  updatePaymentCalculation(false);
});

$("#invoiceQuote").addEventListener("change", (event) => {
  const quote = state.quotes.find((item) => item.id === event.target.value);
  if (!quote) return;
  $("#invoiceClient").value = quote.clientId;
  $("#invoiceNotes").value = quote.notes || "";
  $("#invoiceItems").innerHTML = "";
  quote.items.forEach((item) => addItemRow("#invoiceItems", item));
  updateInvoiceTotal();
});

resetQuoteForm();
resetInvoiceForm();
resetAppointmentForm();
resetPaymentForm();
resetTemplateForm();
$("#receptionBrand").innerHTML = vehicleBrandOptions();
resetReceptionForm();
$("#weeklyDate").value = weekStart(today());
$("#reportMonth").value = currentMonth();
$("#cashDate").value = today();
renderAll();
applyAuthState();
renderLoginNetworkInfo();
syncInitialState();

Object.assign(window, {
  downloadPaymentReceiptPdf,
  sharePaymentReceiptPdf,
  downloadQuotePdf,
  shareQuotePdf,
});
