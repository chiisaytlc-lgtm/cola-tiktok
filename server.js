import express from "express";
import cors from "cors";
import http from "http";
import fs from "fs";
import { Server } from "socket.io";
import { WebcastPushConnection } from "tiktok-live-connector";
import giftRules from "./gift-rules.json" with { type: "json" };

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let queue = [];
let tiktok = null;
let currentUsername = "";
let isConnected = false;

// ---------- CLIENTES VIP / CASERITOS ----------

const DATA_DIR = path.join(__dirname, "data");
const CLIENTES_FILE = path.join(DATA_DIR, "clientes-vip.json");
const META_MONEDAS_EXTENSA_GRATIS = 1500;

const UMBRAL_RECOMPENSA_CERCA = 300;
const UMBRAL_RECOMPENSA_ULTRA = 100;


if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let clientesVip = {};

const TAP_RESET_FILE = path.join(DATA_DIR, "tap-reset-date.txt");

function resetTapTapsIfNewDay() {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Lima"
  });

  let lastResetDate = "";

  if (fs.existsSync(TAP_RESET_FILE)) {
    lastResetDate = fs.readFileSync(TAP_RESET_FILE, "utf8").trim();
  }

  if (lastResetDate === today) {
    return;
  }

  for (const key of Object.keys(clientesVip)) {
    clientesVip[key].totalTaps = 0;
    clientesVip[key].lastTapAt = null;
    clientesVip[key].tituloTap = "";
  }

  fs.writeFileSync(TAP_RESET_FILE, today);
  saveClientesVip();

  console.log("👆 Tap taps reiniciados por nuevo día:", today);
}

if (fs.existsSync(CLIENTES_FILE)) {
  try {
    clientesVip = JSON.parse(fs.readFileSync(CLIENTES_FILE, "utf8"));
  } catch (error) {
    console.log("⚠️ No se pudo leer clientes-vip.json:", error.message);
    clientesVip = {};
  }
}

resetTapTapsIfNewDay();

function saveClientesVip() {
  fs.writeFileSync(CLIENTES_FILE, JSON.stringify(clientesVip, null, 2));
}

function getClienteVip({ username, uniqueId }) {
  const safeUsername = username || "Usuario";
  const key = uniqueId || safeUsername;

  if (!clientesVip[key]) {
    clientesVip[key] = {
      id: key,
      username: safeUsername,
      uniqueId: uniqueId || "",
      totalTaps: 0,
      totalComentarios: 0,
      totalRegalos: 0,
      monedasAcumuladas: 0,
      monedasLive: 0,
      ultimaRecompensa: null,

     recompensasPorCiclo: {},
      avisosRecompensaPorCiclo: {},
      ultimoAvisoRecompensaKey: null,
      ultimoNivelRecompensaAvisado: null,

     

      regalos: {},
      extensasGratisGanadas: 0,
      extensasGratisUsadas: 0,
      esVip: false,
      esCaserito: false,
      notas: "",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastSeenAt: nowIso()
    };
  }

  clientesVip[key].username = safeUsername || clientesVip[key].username;
  clientesVip[key].uniqueId = uniqueId || clientesVip[key].uniqueId;
  clientesVip[key].updatedAt = nowIso();
  clientesVip[key].lastSeenAt = nowIso();

  return clientesVip[key];
}

function actualizarRecompensasCliente(cliente) {
  const monedas = Number(cliente.monedasAcumuladas || 0);
  const progreso = monedas > 0
  ? ((monedas - 1) % META_MONEDAS_EXTENSA_GRATIS) + 1
  : 0;

const faltan = progreso === 0
  ? META_MONEDAS_EXTENSA_GRATIS
  : META_MONEDAS_EXTENSA_GRATIS - progreso;

  cliente.progresoRecompensa = progreso;
  cliente.faltanRecompensa = faltan;

  const nivelActual =
    faltan > 0 && faltan <= UMBRAL_RECOMPENSA_ULTRA
      ? "ultra"
      : faltan > 0 && faltan <= UMBRAL_RECOMPENSA_CERCA
        ? "cerca"
        : "normal";

  const cicloAviso = monedas > 0
  ? Math.floor((monedas - 1) / META_MONEDAS_EXTENSA_GRATIS)
  : 0;

// 🔔 Avisos cerca / ultra cerca máximo 2 veces por usuario + ciclo + nivel
if (!cliente.avisosRecompensaPorCiclo || typeof cliente.avisosRecompensaPorCiclo !== "object") {
  cliente.avisosRecompensaPorCiclo = {};
}

const avisoKey = `${cicloAviso}|${nivelActual}`;

if (nivelActual !== "normal") {
  cliente.avisosRecompensaPorCiclo[avisoKey] =
    Number(cliente.avisosRecompensaPorCiclo[avisoKey] || 0);

  if (cliente.avisosRecompensaPorCiclo[avisoKey] < 2) {
    cliente.avisosRecompensaPorCiclo[avisoKey] += 1;
    cliente.ultimoAvisoRecompensaKey = avisoKey;
    cliente.ultimoNivelRecompensaAvisado = nivelActual;

    const payload = {
      username: cliente.username,
      uniqueId: cliente.uniqueId,
      monedas,
      faltan,
      progreso,
      meta: META_MONEDAS_EXTENSA_GRATIS,
      ciclo: cicloAviso + 1,
      avisoNumero: cliente.avisosRecompensaPorCiclo[avisoKey],
      maxAvisos: 2
    };

    if (nivelActual === "cerca") {
      io.emit("reward:near", payload);
    }

    if (nivelActual === "ultra") {
      io.emit("reward:ultra", payload);
    }
  }
}

  const recompensas = Math.floor(monedas / META_MONEDAS_EXTENSA_GRATIS);

  if (recompensas > Number(cliente.extensasGratisGanadas || 0)) {
    const nuevas = recompensas - Number(cliente.extensasGratisGanadas || 0);

    cliente.extensasGratisGanadas = recompensas;
    cliente.esVip = true;
    cliente.ultimoNivelRecompensaAvisado = "reward";

    io.emit("reward:unlocked", {
      username: cliente.username,
      uniqueId: cliente.uniqueId,
      nuevas,
      disponibles: cliente.extensasGratisGanadas - cliente.extensasGratisUsadas,
      monedas,
      meta: META_MONEDAS_EXTENSA_GRATIS,
      mensaje: `${cliente.username} ganó ${nuevas} pregunta extensa gratis 💖`
    });

    // Mantengo tu evento anterior para no romper el control
    io.emit("vip:reward", {
      username: cliente.username,
      nuevas,
      disponibles: cliente.extensasGratisGanadas - cliente.extensasGratisUsadas,
      mensaje: `${cliente.username} ganó ${nuevas} pregunta extensa gratis 💖`
    });
  }
}

function buildClientesVipState() {
  return Object.values(clientesVip).sort((a, b) => {
    const scoreA =
      Number(a.monedasAcumuladas || 0) +
      Number(a.totalTaps || 0) / 100 +
      Number(a.totalComentarios || 0) * 2;

    const scoreB =
      Number(b.monedasAcumuladas || 0) +
      Number(b.totalTaps || 0) / 100 +
      Number(b.totalComentarios || 0) * 2;

    return scoreB - scoreA;
  });
}

function emitClientesVip() {
  io.emit("clientesVip:update", buildClientesVipState());
}

/* NUEVO: estado de salud ampliado para el Guardian */
let liveActive = false;
let lastEventAt = null;
let lastGiftAt = null;

// anti-duplicados de corta duración
const recentGiftKeys = new Map();

const MAJOR_ARCANA = [
  "0 - El Loco",
  "1 - El Mago",
  "2 - La Sacerdotisa",
  "3 - La Emperatriz",
  "4 - El Emperador",
  "5 - El Hierofante",
  "6 - Los Enamorados",
  "7 - El Carro",
  "8 - La Fuerza",
  "9 - El Ermitaño",
  "10 - La Rueda de la Fortuna",
  "11 - La Justicia",
  "12 - El Colgado",
  "13 - La Muerte",
  "14 - La Templanza",
  "15 - El Diablo",
  "16 - La Torre",
  "17 - La Estrella",
  "18 - La Luna",
  "19 - El Sol",
  "20 - El Juicio",
  "21 - El Mundo"
];

// SUBASTA DE ROSAS
let roseAuction = {
  active: false,
  startedAt: null,
  endsAt: null,
  totals: {}, // { username: { username, roses } }
  selectedWinners: [],
  finished: false
};

// SORTEO DE ARCANOS
let arcanoGame = {
  active: false,
  picks: {}, // { username: { username, number, arcano } }
  takenNumbers: {}, // { number: username }
  winner: null
};

// ARCANOS CON REGALO
let giftArcanaGame = {
  active: false,
  paidUsers: {},     // usuarios que enviaron rosquilla
  picks: {},         // username -> elección
  takenNumbers: {}   // número -> username
};

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

const QUEUE_PRIORITY = {
  especial: 0,
  premium: 1,
  normal: 2,
  rapida: 3
};

const STATUS_PRIORITY = {
  llamado: 1,
  pendiente: 2,
  pendiente_contacto: 3,
  sin_responder: 4,
  atendido: 5
};

const GIFT_RULES = giftRules;

function getGiftRule(giftName) {
  const normalizedGiftName = normalizeText(giftName);

  const foundRule = GIFT_RULES.find((rule) =>
    rule.matches.some((name) => normalizeText(name) === normalizedGiftName)
  );

  if (foundRule) return foundRule;

  return {
    serviceKey: "regalo_general",
    serviceLabel: giftName || "Regalo general",
    queueType: "normal",
    icon: "✨"
  };
}

function isTestUser(username = "") {
  const u = String(username || "").toLowerCase();

  return (
    u.startsWith("test") ||
    u.includes("test_") ||
    u.includes("test-")
  );
}

function limpiarClientesTest() {
  for (const key of Object.keys(clientesVip)) {
    const cliente = clientesVip[key];
    const username = cliente?.username || key;

    if (isTestUser(username) || isTestUser(key)) {
      delete clientesVip[key];
    }
  }

  saveClientesVip();
  emitClientesVip();
}

function normalizeGiftType(giftName) {
  const g = normalizeText(giftName);

  if (g === "rose" || g === "roses" || g === "rosa" || g === "rosas") {
    return "rose";
  }

  if (g === "capybara" || g === "capibara") {
    return "capibara";
  }

  if (
    g === "feather tiara" ||
    g === "feather crown" ||
    g === "tiara de plumas" ||
    g === "plume tiara"
  ) {
    return "tiara_de_plumas";
  }

  if (
      g === "eternal rose" ||
      g === "rose of eternity" ||
      g === "forever rose" ||
      g === "rose forever" ||
      g === "forever rosa" ||
      g === "rosa forever" ||
      g === "rosa para siempre" ||
      g === "eternity rose" ||
      g === "rosa de la eternidad" ||
      g === "rosa eterna"
    ) {
      return "rosa_de_la_eternidad";
    }

    if (
      g === "corona de globos" ||
      g === "balloon heart wreath" ||
      g === "balloon heart wreath x1" ||
      g === "heart balloons"
    ) {
      return "corona_de_globos";
    }  

    if (
    g === "heart umbrella" ||
    g === "umbrella of love" ||
    g === "love shelter" ||
    g === "paraguas de corazon" ||
    g === "refugio de amor" ||
    g === "paraguas de corazón"
  ) {
    return "sesion_privada";
  }

  if (
    g === "heart me" ||
    g === "heartme" ||
    g === "quiéreme" ||
    g === "quiereme"
  ) {
    return "quiereme";
  }

  if (
      g === "confetti" ||
      g === "confeti" ||
      g === "confetti gift"
    ) {
      return "confetti";
    }
  
  if (
    g === "mishka" ||
    g === "mishka bear" ||
    g === "oso mishka"
  ) {
    return "mishka";
  }

  if (g === "doughnut" || g === "donut" || g === "rosquilla") {
    return "rosquilla";
  }

  return g;
}

function getPremiumAlertType(giftName) {
  const type = normalizeGiftType(giftName);

  if (type === "capibara") return "capibara";
  if (type === "tiara_de_plumas") return "tiara_de_plumas";
  if (type === "rosa_de_la_eternidad") return "rosa_de_la_eternidad";
  if (type === "corona_de_globos") return "analisis_karmico_pareja";
  if (type === "sesion_privada") return "sesion_privada";

  return null;
}

function getSpecialOverrideRule(giftName) {
  const type = normalizeGiftType(giftName);

    if (type === "confetti") {
    return {
      serviceKey: "oraculo_premium_amor",
      serviceLabel: "Oráculo Premium del Amor",
      queueType: "premium",
      icon: "💖"
    };
  }

   if (type === "mishka") {
    return {
      serviceKey: "oraculo_premium_dinero",
      serviceLabel: "Oráculo Premium del Dinero",
      queueType: "premium",
      icon: "💰"
    };
  }

    if (type === "rosa_de_la_eternidad") {
      return {
        serviceKey: "tres_preguntas_extensas",
        serviceLabel: "3 preguntas extensas",
        queueType: "premium",
        icon: "🌹"
      };
    }

  if (type === "corona_de_globos") {
      return {
        serviceKey: "analisis_karmico_pareja",
        serviceLabel: "Análisis kármico de pareja",
        queueType: "premium",
        icon: "❤️"
      };
    }

  if (type === "sesion_privada") {
    return {
      serviceKey: "sesion_privada",
      serviceLabel: "Sesión Privada",
      queueType: "especial",
      icon: "☂️"
    };
  }

  return null;
}

function sortQueueItems(items) {
  return [...items].sort((a, b) => {
    const aStatus = STATUS_PRIORITY[a.status] ?? 99;
    const bStatus = STATUS_PRIORITY[b.status] ?? 99;

    if (aStatus !== bStatus) return aStatus - bStatus;

    const aQueueType = QUEUE_PRIORITY[a.queueType] ?? 99;
    const bQueueType = QUEUE_PRIORITY[b.queueType] ?? 99;

    if (aQueueType !== bQueueType) return aQueueType - bQueueType;

    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

function isActiveItem(item) {
  return item.status !== "atendido";
}

function getDefaultStatusForQueueType(queueType) {
  return queueType === "especial" ? "pendiente_contacto" : "pendiente";
}

function createQueueItem({ username, giftName, coins, repeatCount }) {
  const overrideRule = getSpecialOverrideRule(giftName);
  const rule = overrideRule || getGiftRule(giftName);

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    username,
    giftName,
    coins,
    repeatCount,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: getDefaultStatusForQueueType(rule.queueType),
    serviceKey: rule.serviceKey,
    serviceLabel: rule.serviceLabel,
    queueType: rule.queueType,
    icon: rule.icon
  };
}

function upsertQueueItem({ username, giftName, coins, repeatCount }) {
  const newItem = createQueueItem({ username, giftName, coins, repeatCount });
  queue.push(newItem);
  return { item: newItem, action: "created" };
}

function buildVisibleQueue() {
  const activeItems = queue.filter(isActiveItem);
  const calledItem =
    sortQueueItems(activeItems).find((item) => item.status === "llamado") || null;

  const waitingItems = sortQueueItems(
    activeItems.filter(
      (item) =>
        item.status === "pendiente" ||
        item.status === "pendiente_contacto" ||
        !item.status
    )
  );

  const specialItems = waitingItems.filter((item) => item.queueType === "especial");
  const premiumItems = waitingItems.filter((item) => item.queueType === "premium");
  const normalItems = waitingItems.filter((item) => item.queueType === "normal");
  const fastItems = waitingItems.filter((item) => item.queueType === "rapida");

  return {
    current: calledItem,
    hasPremium: premiumItems.length > 0,
    hasSpecial: specialItems.length > 0,

    premiumList: premiumItems.slice(0, 5),
    normalList: normalItems.slice(0, 5),
    fastList: fastItems.slice(0, 5),
    specialList: specialItems.slice(0, 3),

    nextList: [...premiumItems, ...normalItems].slice(0, 5),

    counts: {
      total: activeItems.length,
      especial: specialItems.length,
      premium: premiumItems.length,
      normal: normalItems.length,
      rapida: fastItems.length
    }
  };
}

function buildRoseAuctionState() {
  const ranking = Object.values(roseAuction.totals).sort((a, b) => b.roses - a.roses);

  return {
    ...roseAuction,
    ranking
  };
}

function buildArcanoGameState() {
  const picksList = Object.values(arcanoGame.picks).sort((a, b) => a.number - b.number);

  return {
    ...arcanoGame,
    picksList
  };
}

function buildGiftArcanaState() {
  const picksList = Object.values(giftArcanaGame.picks).sort(
    (a, b) => a.number - b.number
  );

  return {
    ...giftArcanaGame,
    picksList
  };
}

function emitGiftArcana() {
  io.emit("giftArcana:update", buildGiftArcanaState());
}

function startGiftArcana() {
  giftArcanaGame = {
    active: true,
    paidUsers: {},
    picks: {},
    takenNumbers: {}
  };

  emitGiftArcana();
}

function finishGiftArcana() {
  giftArcanaGame.active = false;
  emitGiftArcana();
}

function clearGiftArcana() {
  giftArcanaGame = {
    active: false,
    paidUsers: {},
    picks: {},
    takenNumbers: {}
  };

  emitGiftArcana();
}

function emitQueue() {
  io.emit("queue:update", queue);
  io.emit("queue:visible", buildVisibleQueue());
}

function emitLiveStatus() {
  io.emit("live_status", { isConnected, currentUsername });
}

function emitRoseAuction() {
  io.emit("roseAuction:update", buildRoseAuctionState());
}

function emitArcanoGame() {
  io.emit("arcanoGame:update", buildArcanoGameState());
}

function cleanupRecentGiftKeys() {
  const now = Date.now();

  for (const [key, data] of recentGiftKeys.entries()) {
    if (now - data.ts > data.ttl) {
      recentGiftKeys.delete(key);
    }
  }
}

function registerGiftKey(key, ttl = 2500) {
  recentGiftKeys.set(key, {
    ts: Date.now(),
    ttl
  });
}

function hasRecentGiftKey(key) {
  return recentGiftKeys.has(key);
}

function getNextPendingItem() {
  const pendingItems = queue.filter(
    (item) =>
      (item.status === "pendiente" || !item.status) &&
      item.queueType !== "especial"
  );

  const sortedPending = sortQueueItems(pendingItems);
  return sortedPending[0] || null;
}

// ---------- SUBASTA DE ROSAS ----------

function startRoseAuction(durationMs = 3 * 60 * 1000) {
  roseAuction.active = true;
  roseAuction.startedAt = nowIso();
  roseAuction.endsAt = new Date(Date.now() + durationMs).toISOString();
  roseAuction.totals = {};
  roseStreakState.clear();
  roseAuction.selectedWinners = [];
  roseAuction.finished = false;
  roseRepeatTracker.clear();

  emitRoseAuction();
}

function finishRoseAuction() {
  roseAuction.active = false;
  roseAuction.finished = true;
  emitRoseAuction();
}

function clearRoseAuction() {
  roseAuction = {
    active: false,
    startedAt: null,
    endsAt: null,
    totals: {},
    selectedWinners: [],
    finished: false
    roseRepeatTracker.clear();
  };

  emitRoseAuction();
}

const roseStreakState = new Map();
const roseRepeatTracker = new Map();

function registerRoseGift({ username, giftId, repeatCount = 1 }) {
  if (!roseAuction.active) return;

  const safeRepeat = Math.max(1, Number(repeatCount || 1));

  const trackerKey = `${username}-${giftId}`;

  const previousRepeat =
    roseRepeatTracker.get(trackerKey) || 0;

  let rosesToAdd = safeRepeat;

  // TikTok manda acumulado de racha
  if (safeRepeat > previousRepeat) {
    rosesToAdd = safeRepeat - previousRepeat;
  }

  // evitar negativos o eventos repetidos
  if (rosesToAdd <= 0) {
    return;
  }

  roseRepeatTracker.set(trackerKey, safeRepeat);

  if (!roseAuction.totals[username]) {
    roseAuction.totals[username] = {
      username,
      roses: 0
    };
  }

  roseAuction.totals[username].roses += rosesToAdd;

  console.log("🌹 Rosa sumada:", {
    username,
    repeatCount: safeRepeat,
    previousRepeat,
    rosesToAdd,
    total: roseAuction.totals[username].roses
  });

  emitRoseAuction();
}

function setRoseSelectedWinners(usernames = []) {
  const rankingUsernames = new Set(
    Object.values(roseAuction.totals).map((u) => u.username)
  );

  roseAuction.selectedWinners = usernames.filter((u) => rankingUsernames.has(u));
  emitRoseAuction();
}

function awardRoseSelectedWinners({ prizeLabel = "1 pregunta extensa" } = {}) {
  const selected = roseAuction.selectedWinners
    .map((username) => roseAuction.totals[username])
    .filter(Boolean);

  const createdItems = selected.map((user) => {
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      username: user.username,
      giftName: "Ganó subasta de rosas",
      coins: user.roses,
      repeatCount: user.roses,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "pendiente",
      serviceKey: "subasta_rosas",
      serviceLabel: prizeLabel,
      queueType: "premium",
      icon: "🌹"
    };

    queue.push(item);
    return item;
  });

  emitQueue();

  return createdItems;
}

// ---------- SORTEO ARCANOS ----------

function resetArcanoGame() {
  arcanoGame = {
    active: false,
    picks: {},
    takenNumbers: {},
    winner: null
  };

  emitArcanoGame();
}

function startArcanoGame() {
  arcanoGame.active = true;
  arcanoGame.picks = {};
  arcanoGame.takenNumbers = {};
  arcanoGame.winner = null;
  emitArcanoGame();
}

function finishArcanoGame() {
  arcanoGame.active = false;
  emitArcanoGame();
}

function extractArcanoNumber(text = "") {
  const cleaned = String(text || "").trim();

  const match = cleaned.match(/(^|\D)([0-9]|1[0-9]|2[0-1])(\D|$)/);

  if (!match) return null;

  return Number(match[2]);
}

function registerArcanoPick({ username, comment }) {
  if (!arcanoGame.active) return { ok: false, reason: "inactive" };

  const number = extractArcanoNumber(comment);
  if (number === null) return { ok: false, reason: "invalid" };

  if (arcanoGame.picks[username]) {
    return { ok: false, reason: "user_already_picked" };
  }

  if (arcanoGame.takenNumbers[number]) {
    io.emit("arcanoGame:pickRejected", {
      username,
      number,
      reason: "number_taken",
      message: `El arcano ${number} ya fue elegido. Pide otro número del 0 al 21.`
    });

  return { ok: false, reason: "number_taken" };
}

  arcanoGame.picks[username] = {
    username,
    number,
    arcano: MAJOR_ARCANA[number]
  };

  arcanoGame.takenNumbers[number] = username;

  emitArcanoGame();
  io.emit("arcanoGame:pickAccepted", arcanoGame.picks[username]);

  return { ok: true, pick: arcanoGame.picks[username] };
}

function drawArcanoWinner() {
  const entries = Object.values(arcanoGame.picks);

  if (!entries.length) {
    return null;
  }

  const winner = entries[Math.floor(Math.random() * entries.length)];
  arcanoGame.winner = winner;

  io.emit("arcanoGame:winner", winner);
  emitArcanoGame();

  return winner;
}

function getTituloTap(totalTaps = 0) {
  const taps = Number(totalTaps || 0);

  if (taps >= 100000) return "🌌 Titán del Live";
if (taps >= 90000) return "⚡ Deidad del Live";
if (taps >= 80000) return "👁️ Dueñ@ del Portal";
if (taps >= 70000) return "🔥 Guardián Supremo";
if (taps >= 60000) return "🛡️ Alma Inmortal";
if (taps >= 50000) return "👑 Rey/Reina del Tap";
if (taps >= 45000) return "💠 Leyenda Cósmica";
if (taps >= 40000) return "🌟 Ser de Otro Plano";
if (taps >= 35000) return "⚜️ Espíritu Supremo";
if (taps >= 30000) return "💎 Leyenda Dorada";
if (taps >= 28500) return "🕯️ Maestro/a del Portal";
if (taps >= 27000) return "🌠 Energía Imparable";
if (taps >= 25500) return "🏛️ Guardián Celestial";
if (taps >= 24000) return "✨ Presencia Legendaria";
if (taps >= 22500) return "🔥 Alma Ascendida";
if (taps >= 21000) return "👑 Favorit@ del Universo";
if (taps >= 19500) return "⚡ Espíritu del Live";
if (taps >= 18000) return "💫 Aura Legendaria";
if (taps >= 16500) return "🌟 Presencia Suprema";
if (taps >= 15000) return "🪽 Energía Dorada";
if (taps >= 13500) return "🔥 Imparable";
if (taps >= 12000) return "💎 Leyenda Naciente";
if (taps >= 10500) return "⚜️ Ascendiendo al Olimpo";
if (taps >= 10000) return "🏆 Leyenda del Live";
if (taps >= 8500) return "🌟 Casi Imparable";
if (taps >= 7000) return "✨ Favorit@ del Live";
if (taps >= 6000) return "🔥 Energía VIP";
if (taps >= 5000) return "👑 A Punto de Ser Leyenda";
if (taps >= 4000) return "🪽 Protector/a del Live";
if (taps >= 3000) return "💎 Incondicional";
if (taps >= 2000) return "🌹 Corazón Fiel";
if (taps >= 1000) return "💖 Ya Es Parte";
if (taps >= 500) return "🔥 Siempre Presente";
if (taps >= 250) return "✨ Energía Activa";
if (taps >= 100) return "💫 Recién Llegad@";

return "🌱 Nueva Energía";

  return "";
}

// ---------- EVENTOS REUTILIZABLES ----------

function handleGiftEvent({
  username,
  giftName = "Regalo",
  coins = 0,
  repeatCount = 1,
  uniqueId = ""
}) {
  const normalizedType = normalizeGiftType(giftName);
  const premiumType = getPremiumAlertType(giftName);


  if (premiumType) {
    io.emit("gift:premium", {
      type: premiumType,
      username,
      giftName,
      coins,
      repeatCount,
      createdAt: nowIso()
    });
  }

  // 🌹 SUBASTA DE ROSAS
  // Si la subasta está activa, las rosas SOLO se cuentan en la subasta.
  // NO suman monedas VIP, NO suman totalRegalos, NO entran a cola normal.
  if (roseAuction.active && normalizedType === "rose") {
    registerRoseGift({
      username,
      giftId: normalizedType,
      repeatCount
    });

    return {
      skippedQueue: true,
      skippedVip: true,
      mode: "rose_auction",
      username,
      giftName,
      repeatCount
    };
  }

  // 🃏 ARCANOS CON REGALO
if (giftArcanaGame.active && normalizedType === "rosquilla") {
  giftArcanaGame.paidUsers[username] = {
    username,
    uniqueId,
    paidAt: nowIso()
  };

  emitGiftArcana();

  io.emit("giftArcana:paid", {
    username,
    message: `${username} ya puede elegir un número 🃏`
  });

  return {
    skippedQueue: true,
    skippedVip: true,
    mode: "gift_arcana_paid",
    username,
    giftName
  };
}
    // 🚫 Ignorar regalos de 1 moneda excepto Quiéreme
  if (
    Number(coins || 0) === 1 &&
    normalizedType !== "quiereme"
  ) {
    console.log("🚫 Regalo de 1 moneda ignorado:", giftName);
    return {
      skippedQueue: true,
      skippedVip: true,
      reason: "one_coin_filtered"
    };
  }

  // 👑 VIP / CASERITOS
  // Solo regalos normales, fuera de subasta.
  const cliente = getClienteVip({ username, uniqueId });

  const safeCoins = Number(coins || 0);
  const safeRepeat = Number(repeatCount || 1);
  const totalCoins = safeCoins * safeRepeat;

  cliente.totalRegalos += safeRepeat;
  cliente.monedasAcumuladas += totalCoins;
  cliente.monedasLive = (cliente.monedasLive || 0) + totalCoins;


  const totalHistorico = Number(cliente.monedasAcumuladas || 0);

const cicloActual =
  totalHistorico > 0
    ? Math.floor((totalHistorico - 1) / META_MONEDAS_EXTENSA_GRATIS)
    : 0;

const progresoCiclo =
  totalHistorico > 0
    ? ((totalHistorico - 1) % META_MONEDAS_EXTENSA_GRATIS) + 1
    : 0;

if (!cliente.recompensasPorCiclo || typeof cliente.recompensasPorCiclo !== "object") {
  cliente.recompensasPorCiclo = {};
}

if (!cliente.recompensasPorCiclo[cicloActual]) {
  cliente.recompensasPorCiclo[cicloActual] = {};
}

const recompensasCiclo = [
  {
    limite: 500,
    tipo: "oraculo",
    mensaje: "🔮 Desbloqueaste un mensaje del oráculo"
  },
  {
    limite: 700,
    tipo: "si_no",
    mensaje: "❓ Desbloqueaste un Sí o No GRATIS"
  },
  {
    limite: 1500,
    tipo: "extensa",
    mensaje: "💎 Desbloqueaste una pregunta extensa GRATIS"
  }
];

for (const r of recompensasCiclo) {
  if (
    progresoCiclo >= r.limite &&
    !cliente.recompensasPorCiclo[cicloActual][r.tipo]
  ) {
    cliente.recompensasPorCiclo[cicloActual][r.tipo] = true;

    io.emit("reward:live", {
      username: cliente.username,
      tipo: r.tipo,
      mensaje: r.mensaje,
      monedas: totalHistorico,
      progresoCiclo,
      ciclo: cicloActual + 1,
      limite: r.limite
    });
  }
}

  if (!cliente.regalos[giftName]) {
    cliente.regalos[giftName] = {
      cantidad: 0,
      monedas: 0
    };
  }

  cliente.regalos[giftName].cantidad += safeRepeat;
  cliente.regalos[giftName].monedas += totalCoins;

  actualizarRecompensasCliente(cliente);
  saveClientesVip();
  emitClientesVip();

  const result = upsertQueueItem({
    username,
    giftName,
    coins,
    repeatCount
  });

  emitQueue();

  return result;
}

function handleChatEvent({ username, comment }) {
  io.emit("chat", { username, comment, createdAt: nowIso() });

  // 🃏 ARCANOS CON REGALO
  if (giftArcanaGame.active) {
    const paidUser = giftArcanaGame.paidUsers[username];

    if (paidUser) {
      const number = extractArcanoNumber(comment);

      if (number !== null) {
        if (giftArcanaGame.picks[username]) {
          return {
            ok: false,
            reason: "gift_arcana_already_picked"
          };
        }

        if (giftArcanaGame.takenNumbers[number]) {
          io.emit("giftArcana:pickRejected", {
            username,
            number,
            reason: "taken",
            message: `El número ${number} ya fue elegido. Pide otro número.`
          });

          return {
            ok: false,
            reason: "gift_arcana_taken"
          };
        }

        const DEFAULT_GIFT_ARCANA_PRIZES = [

  {
    icon: "🔥",
    label: "Pregunta Extensa",
    queueType: "premium",
    serviceKey: "arcano_extensa"
  },

  {
    icon: "🔮",
    label: "Oráculo",
    queueType: "normal",
    serviceKey: "arcano_oraculo"
  },

  {
    icon: "🔮",
    label: "Oráculo",
    queueType: "normal",
    serviceKey: "arcano_oraculo"
  },

  {
    icon: "⚖️",
    label: "Sí o No",
    queueType: "normal",
    serviceKey: "arcano_si_no"
  },

  {
    icon: "⚖️",
    label: "Sí o No",
    queueType: "normal",
    serviceKey: "arcano_si_no"
  },

  {
    icon: "💗",
    label: "Energía en el Amor",
    queueType: "normal",
    serviceKey: "arcano_amor"
  },

  {
    icon: "💰",
    label: "Energía en el Dinero",
    queueType: "normal",
    serviceKey: "arcano_dinero"
  },

  {
    icon: "👑",
    label: "Premio Sorpresa",
    queueType: "premium",
    serviceKey: "arcano_sorpresa"
  }
];

        const assignedCount =
          Object.keys(giftArcanaGame.picks || {}).length;

        const premio =
          DEFAULT_GIFT_ARCANA_PRIZES[
            assignedCount % DEFAULT_GIFT_ARCANA_PRIZES.length
          ];

        giftArcanaGame.picks[username] = {
          username,
          number,
          arcano: MAJOR_ARCANA[number] || `Arcano ${number}`,
          prize: premio,
          revealed: false,
          paidAt: paidUser.paidAt,
          pickedAt: nowIso()
        };

        giftArcanaGame.takenNumbers[number] = username;

        emitGiftArcana();

        io.emit("giftArcana:pickAccepted", {
          username,
          number,
          prize: premio
        });

        return {
          ok: true,
          mode: "gift_arcana",
          pick: giftArcanaGame.picks[username]
        };
      }
    }
  }

  // TU SORTEO DE ARCANOS ACTUAL SE QUEDA IGUAL
  if (arcanoGame.active) {
    return registerArcanoPick({ username, comment });
  }

  return { ok: false, reason: "no_active_dynamic" };
}

// ---------- RUTAS ----------

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "cola-tiktok-backend",
    time: new Date().toISOString(),
    tiktokConnected: isConnected,
    liveActive,
    queueLength: queue.length,
    lastEventAt,
    lastGiftAt
  });
});

app.get("/", (req, res) => {
  res.send("Backend activo");
});

app.get("/queue", (req, res) => {
  res.json(queue);
});

app.get("/queue-visible", (req, res) => {
  res.json(buildVisibleQueue());
});

app.get("/rose-auction", (req, res) => {
  res.json(buildRoseAuctionState());
});

app.get("/arcano-game", (req, res) => {
  res.json(buildArcanoGameState());
});

app.post("/arcano/award-user", (req, res) => {
  const { username, prizeLabel = "Premio sorteo de arcanos" } = req.body || {};

  if (!username) {
    return res.status(400).json({ error: "Falta username" });
  }

  const pick = arcanoGame.picks[username];

  if (!pick) {
    return res.status(404).json({ error: "Usuario no encontrado en sorteo" });
  }

  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    username: pick.username,
    giftName: "Ganó sorteo de arcanos",
    coins: 0,
    repeatCount: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "pendiente",
    serviceKey: "sorteo_arcanos",
    serviceLabel: prizeLabel,
    queueType: "premium",
    icon: "🃏"
  };

  queue.push(item);

  arcanoGame.winner = pick;

  emitQueue();
  emitArcanoGame();

  io.emit("arcanoGame:winner", pick);

  res.json({
    ok: true,
    winner: pick,
    item,
    queue,
    visibleQueue: buildVisibleQueue(),
    arcanoGame: buildArcanoGameState()
  });
});

app.get("/status", (req, res) => {
  res.json({
    isConnected,
    currentUsername,
    queueLength: queue.length,
    pendingCount: queue.filter(
      (item) => item.status === "pendiente" || item.status === "llamado" || !item.status
    ).length,
    pendingContactCount: queue.filter(
      (item) => item.status === "pendiente_contacto"
    ).length,
    noResponseCount: queue.filter((item) => item.status === "sin_responder").length,
    attendedCount: queue.filter((item) => item.status === "atendido").length,
    specialCount: queue.filter(
      (item) =>
        item.queueType === "especial" &&
        (item.status === "pendiente_contacto" || item.status === "pendiente")
    ).length,
    premiumCount: queue.filter(
      (item) =>
        item.queueType === "premium" &&
        (item.status === "pendiente" || item.status === "llamado" || !item.status)
    ).length,
    normalCount: queue.filter(
      (item) =>
        item.queueType === "normal" &&
        (item.status === "pendiente" || item.status === "llamado" || !item.status)
    ).length,
    rapidCount: queue.filter(
      (item) =>
        item.queueType === "rapida" &&
        (item.status === "pendiente" || item.status === "llamado" || !item.status)
    ).length,
    roseAuction: buildRoseAuctionState(),
    arcanoGame: buildArcanoGameState()
  });
});

app.get("/clientes-vip", (req, res) => {
  res.json(buildClientesVipState());
});

app.post("/clean-tests", (req, res) => {
  queue = queue.filter((item) => {
    const username =
      data.nickname ||
      data.user?.nickname ||
      data.user?.profileName ||
      data.uniqueId ||
      data.user?.uniqueId ||
      data.userId ||
      "Usuario";

    return !isTestUser(username);
  });

  limpiarClientesTest();
  emitQueue();

  res.json({
    ok: true,
    queue,
    visibleQueue: buildVisibleQueue(),
    clientes: buildClientesVipState()
  });
});

app.post("/clientes-vip/:id/caserito", (req, res) => {
  const { id } = req.params;
  const { esCaserito = true } = req.body || {};

  if (!clientesVip[id]) {
    return res.status(404).json({ error: "Cliente no encontrado" });
  }

  clientesVip[id].esCaserito = Boolean(esCaserito);
  clientesVip[id].updatedAt = nowIso();

  saveClientesVip();
  emitClientesVip();

  res.json({
    ok: true,
    cliente: clientesVip[id],
    clientes: buildClientesVipState()
  });
});

app.post("/clientes-vip/:id/usar-extensa-gratis", (req, res) => {
  const { id } = req.params;

  if (!clientesVip[id]) {
    return res.status(404).json({ error: "Cliente no encontrado" });
  }

  const disponibles =
    Number(clientesVip[id].extensasGratisGanadas || 0) -
    Number(clientesVip[id].extensasGratisUsadas || 0);

  if (disponibles <= 0) {
    return res.status(400).json({ error: "No tiene extensas gratis disponibles" });
  }

  clientesVip[id].extensasGratisUsadas += 1;
  clientesVip[id].updatedAt = nowIso();

  saveClientesVip();
  emitClientesVip();

  res.json({
    ok: true,
    cliente: clientesVip[id],
    clientes: buildClientesVipState()
  });
});

// ---------- TESTS ----------

app.post("/test-gift", (req, res) => {
  const {
    username,
    giftName = "PRUEBA",
    coins = 0,
    repeatCount = 1
  } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Falta username" });
  }

  const result = handleGiftEvent({
    username,
    giftName,
    coins,
    repeatCount
  });

  res.json({
    ok: true,
    result,
    queue,
    visibleQueue: buildVisibleQueue(),
    roseAuction: buildRoseAuctionState()
  });
});

app.post("/test-chat", (req, res) => {
  const { username, comment = "0" } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Falta username" });
  }

  const result = handleChatEvent({ username, comment });

  res.json({
    ok: true,
    result,
    arcanoGame: buildArcanoGameState()
  });
});

app.post("/test-tap", (req, res) => {
  const { username = "Test_Tap", taps = 10 } = req.body || {};

  const cliente = getClienteVip({
    username,
    uniqueId: username
  });

  const safeTaps = Number(taps || 1);

  // 👉 acumula taps
  cliente.totalTaps += safeTaps;
  cliente.lastTapAt = Date.now(); // 🔥 IMPORTANTE

  // 🔥 NUEVO: lógica de títulos
  const tituloAnterior = cliente.tituloTap || "";
  const tituloNuevo = getTituloTap(cliente.totalTaps);

  cliente.tituloTap = tituloNuevo;

  if (tituloNuevo && tituloNuevo !== tituloAnterior) {
    io.emit("tap:title-unlocked", {
      username: cliente.username,
      totalTaps: cliente.totalTaps,
      tituloTap: tituloNuevo,
      mensaje: `${cliente.username} ahora es ${tituloNuevo}`
    });
  }

  // 👉 guarda y emite
  saveClientesVip();
  emitClientesVip();

  io.emit("tap:update", {
    username,
    uniqueId: username,
    taps: safeTaps,
    totalTaps: cliente.totalTaps,
    cliente
  });

  res.json({
    ok: true,
    cliente
  });
});

// ---------- SUBASTA ----------

app.post("/rose-auction/start", (req, res) => {
  const durationMs = Number(req.body?.durationMs || 3 * 60 * 1000);
  startRoseAuction(durationMs);

  res.json({
    ok: true,
    roseAuction: buildRoseAuctionState()
  });
});

app.post("/rose-auction/finish", (req, res) => {
  finishRoseAuction();

  res.json({
    ok: true,
    roseAuction: buildRoseAuctionState()
  });
});

app.post("/rose-auction/select-winners", (req, res) => {
  const { usernames = [] } = req.body;

  if (!Array.isArray(usernames)) {
    return res.status(400).json({ error: "usernames debe ser un array" });
  }

  setRoseSelectedWinners(usernames);

  res.json({
    ok: true,
    roseAuction: buildRoseAuctionState()
  });
});

app.post("/rose-auction/award-selected", (req, res) => {
  const { prizeLabel = "1 pregunta extensa" } = req.body || {};

  const createdItems = awardRoseSelectedWinners({ prizeLabel });

  res.json({
    ok: true,
    createdItems,
    queue,
    visibleQueue: buildVisibleQueue(),
    roseAuction: buildRoseAuctionState()
  });
});

app.post("/rose-auction/clear", (req, res) => {
  clearRoseAuction();

  res.json({
    ok: true,
    roseAuction: buildRoseAuctionState()
  });
});

// ---------- ARCANOS CON REGALO ----------

app.post("/gift-arcana/start", (req, res) => {
  startGiftArcana();

  res.json({
    ok: true,
    giftArcana: buildGiftArcanaState()
  });
});

app.post("/gift-arcana/finish", (req, res) => {
  finishGiftArcana();

  res.json({
    ok: true,
    giftArcana: buildGiftArcanaState()
  });
});

app.post("/gift-arcana/clear", (req, res) => {
  clearGiftArcana();

  res.json({
    ok: true,
    giftArcana: buildGiftArcanaState()
  });
});

app.get("/gift-arcana", (req, res) => {
  res.json(buildGiftArcanaState());
});

// ---------- ARCANOS ----------

app.post("/arcano/start", (req, res) => {
  startArcanoGame();

  res.json({
    ok: true,
    arcanoGame: buildArcanoGameState()
  });
});

app.post("/arcano/finish", (req, res) => {
  finishArcanoGame();

  res.json({
    ok: true,
    arcanoGame: buildArcanoGameState()
  });
});

app.post("/arcano/draw", (req, res) => {
  const winner = drawArcanoWinner();

  if (!winner) {
    return res.status(400).json({ error: "No hay participantes" });
  }

  res.json({
    ok: true,
    winner,
    arcanoGame: buildArcanoGameState()
  });
});

app.post("/arcano/clear", (req, res) => {
  resetArcanoGame();

  res.json({
    ok: true,
    arcanoGame: buildArcanoGameState()
  });
});

// ---------- COLA ----------

app.post("/next", (req, res) => {
  const currentCalled = queue.find((item) => item.status === "llamado");

  if (currentCalled) {
    currentCalled.status = "sin_responder";
    currentCalled.updatedAt = nowIso();
  }

  const nextUser = getNextPendingItem();

  if (nextUser) {
    nextUser.status = "llamado";
    nextUser.updatedAt = nowIso();
  }

  emitQueue();
  res.json({ ok: true, queue, visibleQueue: buildVisibleQueue() });
});

app.post("/no-response", (req, res) => {
  const { index } = req.body;

  if (typeof index !== "number" || index < 0 || index >= queue.length) {
    return res.status(400).json({ error: "Índice inválido" });
  }

  queue[index].status = "sin_responder";
  queue[index].updatedAt = nowIso();

  emitQueue();

  res.json({ ok: true, queue, visibleQueue: buildVisibleQueue() });
});

app.post("/back-to-pending", (req, res) => {
  const { index } = req.body;

  if (typeof index !== "number" || index < 0 || index >= queue.length) {
    return res.status(400).json({ error: "Índice inválido" });
  }

  queue[index].status = getDefaultStatusForQueueType(queue[index].queueType);
  queue[index].updatedAt = nowIso();

  emitQueue();

  res.json({ ok: true, queue, visibleQueue: buildVisibleQueue() });
});

app.post("/attended", (req, res) => {
  const { index } = req.body;

  if (typeof index !== "number" || index < 0 || index >= queue.length) {
    return res.status(400).json({ error: "Índice inválido" });
  }

  queue[index].status = "atendido";
  queue[index].updatedAt = nowIso();

  emitQueue();

  res.json({ ok: true, queue, visibleQueue: buildVisibleQueue() });
});

app.post("/clear-attended", (req, res) => {
  // 🧹 quitar atendidos
  queue = queue.filter((item) => item.status !== "atendido");

  // 🔥 quitar usuarios de prueba (aunque no estén atendidos)
  queue = queue.filter((item) => {
    const username =
      item.username ||
      item.nickname ||
      item.user?.nickname ||
      "";

    return !isTestUser(username);
  });

  emitQueue();

  res.json({ ok: true, queue, visibleQueue: buildVisibleQueue() });
});

app.post("/clear", (req, res) => {
  queue = [];
  emitQueue();

  res.json({ ok: true, queue, visibleQueue: buildVisibleQueue() });
});

app.post("/reset-all", (req, res) => {
  queue = [];
  clearRoseAuction();
  resetArcanoGame();

  // 🔥 LIMPIAR CLIENTES DE PRUEBA
  for (const key of Object.keys(clientesVip)) {
  const cliente = clientesVip[key];

  if (isTestUser(cliente?.username) || isTestUser(key)) {
    delete clientesVip[key];
  }
}
  saveClientesVip();
  emitClientesVip();

  emitQueue();

  res.json({
    ok: true,
    queue,
    visibleQueue: buildVisibleQueue(),
    roseAuction: buildRoseAuctionState(),
    arcanoGame: buildArcanoGameState()
  });
});

// ---------- TIKTOK ----------

app.post("/connect", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Falta username del live" });
  }

  try {
    if (tiktok) {
      try {
        await tiktok.disconnect();
      } catch (e) {
        console.log("⚠️ No se pudo cerrar conexión anterior:", e.message);
      }
    }

    tiktok = new WebcastPushConnection(username);
    currentUsername = username;

    // 🔄 Conexión / reconexión TikTok
// NO resetear tap taps aquí, porque el Guardian puede reconectar en pleno live.

      for (const key in clientesVip) {
        clientesVip[key].monedasLive = clientesVip[key].monedasLive || 0;
        clientesVip[key].ultimaRecompensa = clientesVip[key].ultimaRecompensa || null;
        clientesVip[key].ultimoAvisoRecompensaKey = clientesVip[key].ultimoAvisoRecompensaKey || null;
        clientesVip[key].ultimoNivelRecompensaAvisado = clientesVip[key].ultimoNivelRecompensaAvisado || null;
      }

      saveClientesVip();
      emitClientesVip();

      console.log("🔄 TikTok conectado/reconectado sin resetear tap taps");

    

    tiktok.on("gift", (data) => {
      lastEventAt = nowIso();
      lastGiftAt = nowIso();
      liveActive = true;

      cleanupRecentGiftKeys();

     const username =
        data.nickname ||
        data.user?.nickname ||
        data.user?.profileName ||
        data.uniqueId ||
        data.user?.uniqueId ||
        data.userId ||
        "Usuario";

      const giftName = data.giftName || "Regalo";
      const coins = data.diamondCount || 0;
      const repeatCount = data.repeatCount || 1;
      const normalizedGiftName = normalizeText(giftName);

      const normalizedType = normalizeGiftType(giftName);

      const GIFTS_CON_RACHA = new Set([
        "perfume",
        "rosquilla",
        "capibara"
      ]);

      if (
        GIFTS_CON_RACHA.has(normalizedType) &&
        data.repeatEnd === false
      ) {
        console.log("⏳ Regalo en racha esperando cierre:", {
          username,
          giftName,
          repeatCount
        });
        return;
      }

      console.log("🎁 Gift recibido:", {
        username,
        giftName,
        normalizedGiftName,
        giftId: data.giftId,
        coins,
        repeatCount
      });

      let giftKey;

      if (data.msgId) {
        giftKey = `msg:${data.msgId}`;
      } else {
        giftKey = [
          username,
          normalizedGiftName,
          coins,
          repeatCount,
          data.giftId || "",
          data.user?.userId || "",
          data.userId || ""
        ].join("|");
      }

      let ttlMs = 2500;

      if (
        normalizedGiftName === "heart me" ||
        normalizedGiftName === "heartme" ||
        normalizedGiftName === "quiéreme" ||
        normalizedGiftName === "quiereme"
      ) {
        ttlMs = 900;
      }

      if (
        normalizedGiftName === "corgi" ||
        normalizedGiftName === "feather tiara" ||
        normalizedGiftName === "feather crown" ||
        normalizedGiftName === "tiara de plumas" ||
        normalizedGiftName === "plume tiara" ||
        normalizedGiftName === "heart umbrella" ||
        normalizedGiftName === "umbrella of love" ||
        normalizedGiftName === "paraguas de corazón" ||
        normalizedGiftName === "paraguas de corazon" ||
        normalizedGiftName === "capybara" ||
        normalizedGiftName === "capibara" ||
        normalizedGiftName === "heart in hands" ||
        normalizedGiftName === "heart on hands" ||
        normalizedGiftName === "corazon en las manos" ||
        normalizedGiftName === "corazón en las manos" ||
        normalizedGiftName === "eternal rose" ||
        normalizedGiftName === "rose of eternity" ||
        normalizedGiftName === "forever rose" ||
        normalizedGiftName === "rose forever" ||
        normalizedGiftName === "rosa para siempre" ||
        normalizedGiftName === "rosa de la eternidad"
      ) {
        ttlMs = 3000;
      }

      if (hasRecentGiftKey(giftKey)) {
        console.log("⚠️ Regalo duplicado ignorado:", giftKey);
        return;
      }

      registerGiftKey(giftKey, ttlMs);

      const result = handleGiftEvent({
        username,
        giftName,
        coins,
        repeatCount,
        uniqueId: data.uniqueId || data.user?.uniqueId || data.userId || username
      });

      console.log("🎁 Resultado handleGiftEvent:", result);
    });

    tiktok.on("chat", (data) => {
      lastEventAt = nowIso();
      liveActive = true;

      const username =
        data.nickname ||
        data.user?.nickname ||
        data.uniqueId ||
        data.user?.uniqueId ||
        "Usuario";

      const comment = data.comment || "";

      console.log("💬 Chat:", username, comment);

      const cliente = getClienteVip({
        username,
        uniqueId: data.uniqueId || data.user?.uniqueId || username
      });

      cliente.totalComentarios += 1;
      saveClientesVip();
      emitClientesVip();

      const result = handleChatEvent({ username, comment });

      if (result?.ok) {
        console.log("🃏 Arcano registrado:", result.pick);
      }
    });

    tiktok.on("like", (data) => {
      lastEventAt = nowIso();
      liveActive = true;

      const username =
        data.nickname ||
        data.user?.nickname ||
        data.uniqueId ||
        data.user?.uniqueId ||
        "Usuario";

      const uniqueId =
        data.uniqueId ||
        data.user?.uniqueId ||
        data.userId ||
        username;

     const taps = Number(
        data.likeCount ||
        data.like_count ||
        data.count ||
        data.repeatCount ||
        data.totalLikeCount ||
        data.likes ||
        data.like ||
        1
      );

      const cliente = getClienteVip({ username, uniqueId });

      // 👉 acumula taps
      cliente.totalTaps += taps;

      // 🔥 CLAVE: registrar último tap (para ranking en vivo)
      cliente.lastTapAt = Date.now();

      // 👉 lógica de títulos
      const tituloAnterior = cliente.tituloTap || "";
      const tituloNuevo = getTituloTap(cliente.totalTaps);

      cliente.tituloTap = tituloNuevo;

      if (tituloNuevo && tituloNuevo !== tituloAnterior) {
        io.emit("tap:title-unlocked", {
          username: cliente.username,
          totalTaps: cliente.totalTaps,
          tituloTap: tituloNuevo,
          mensaje: `${cliente.username} ahora es ${tituloNuevo}`
        });
      }

      // 👉 guardar y actualizar clientes
      saveClientesVip();
      emitClientesVip();

      // 👉 emitir actualización de taps en tiempo real
      io.emit("tap:update", {
        username,
        uniqueId,
        taps,
        totalTaps: cliente.totalTaps,
        cliente
      });

      console.log("👆 Tap tap:", username, taps, "Total:", cliente.totalTaps);
      console.log("👀 DATA LIKE COMPLETA:", JSON.stringify(data, null, 2));
    });

    tiktok.on("streamEnd", () => {
      console.log("📴 Live finalizado");
      isConnected = false;
      liveActive = false;
      emitLiveStatus();
    });

    const state = await tiktok.connect();

    isConnected = true;
    liveActive = true;
    lastEventAt = nowIso();

    console.log(`✅ Conectado al live de @${username}`);
    console.log("RoomId:", state.roomId);

    emitLiveStatus();

    res.json({
      ok: true,
      message: `Conectado al live de @${username}`,
      roomId: state.roomId
    });
  } catch (error) {
    console.error("❌ Error conectando a TikTok:", error);
    isConnected = false;
    liveActive = false;

    res.status(500).json({
      error: "No se pudo conectar al live",
      detail: error.message
    });
  }
});

app.post("/disconnect", async (req, res) => {
  try {
    if (tiktok) {
      await tiktok.disconnect();
      tiktok = null;
    }

    isConnected = false;
    liveActive = false;
    currentUsername = "";

    emitLiveStatus();

    res.json({ ok: true, message: "Desconectado del live" });
  } catch (error) {
    res.status(500).json({
      error: "No se pudo desconectar",
      detail: error.message
    });
  }
});

app.post("/activar-amor", (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ ok: false });
  }

  io.emit("love:activation", {
    username
  });

  res.json({ ok: true });
});

app.post("/activar-dinero", (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ ok: false });
  }

  io.emit("money:activation", {
    username
  });

  res.json({ ok: true });
});

// ---------- SOCKET ----------

io.on("connection", (socket) => {
  console.log("Cliente conectado:", socket.id);

  socket.emit("queue:update", queue);
  socket.emit("queue:visible", buildVisibleQueue());
  socket.emit("live_status", { isConnected, currentUsername });
  socket.emit("roseAuction:update", buildRoseAuctionState());
  socket.emit("arcanoGame:update", buildArcanoGameState());
  socket.emit("giftArcana:update", buildGiftArcanaState());
  socket.emit("clientesVip:update", buildClientesVipState());
});

// 💾 AUTO-GUARDADO DE CLIENTES VIP (incluye tap taps)
setInterval(() => {
  try {
    saveClientesVip();
    // opcional: log suave cada cierto tiempo
    // console.log("💾 Autosave clientesVip");
  } catch (e) {
    console.log("⚠️ Error autosave:", e.message);
  }
}, 10000); // cada 10 segundos

server.listen(PORT, () => {
  console.log(`🌸 Backend corriendo en http://127.0.0.1:${PORT}`);
});