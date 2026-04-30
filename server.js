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

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let clientesVip = {};

if (fs.existsSync(CLIENTES_FILE)) {
  try {
    clientesVip = JSON.parse(fs.readFileSync(CLIENTES_FILE, "utf8"));
  } catch (error) {
    console.log("⚠️ No se pudo leer clientes-vip.json:", error.message);
    clientesVip = {};
  }
}

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
  const recompensas = Math.floor(
    Number(cliente.monedasAcumuladas || 0) / META_MONEDAS_EXTENSA_GRATIS
  );

  if (recompensas > Number(cliente.extensasGratisGanadas || 0)) {
    const nuevas = recompensas - Number(cliente.extensasGratisGanadas || 0);
    cliente.extensasGratisGanadas = recompensas;
    cliente.esVip = true;

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
  "8 - La Justicia",
  "9 - El Ermitaño",
  "10 - La Rueda de la Fortuna",
  "11 - La Fuerza",
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
    g === "rosa para siempre" ||
    g === "eternity rose" ||
    g === "rosa de la eternidad"
  ) {
    return "rosa_de_la_eternidad";
  }

  if (
    g === "heart in hands" ||
    g === "heart on hands" ||
    g === "corazon en las manos" ||
    g === "corazón en las manos"
  ) {
    return "corazon_en_las_manos";
  }

  if (
    g === "heart umbrella" ||
    g === "umbrella of love" ||
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
    g === "perfume" ||
    g === "perfume gift"
  ) {
    return "perfume";
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
  if (type === "corazon_en_las_manos") return "analisis_karmico_pareja";
  if (type === "sesion_privada") return "sesion_privada";

  return null;
}

function getSpecialOverrideRule(giftName) {
  const type = normalizeGiftType(giftName);

  if (type === "corazon_en_las_manos") {
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
  };

  emitRoseAuction();
}

const roseStreakState = new Map();

function registerRoseGift({ username, giftId, repeatCount = 1 }) {
  if (!roseAuction.active) return;

  const safeRepeat = Number(repeatCount || 1);
  const streakKey = `${username}|${giftId || "rose"}`;

  const previous = roseStreakState.get(streakKey) || 0;
  let rosesToAdd = safeRepeat - previous;

  if (rosesToAdd <= 0) {
    rosesToAdd = 0;
  }

  roseStreakState.set(streakKey, safeRepeat);

  if (!roseAuction.totals[username]) {
    roseAuction.totals[username] = {
      username,
      roses: 0
    };
  }

  roseAuction.totals[username].roses += rosesToAdd;
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

  if (taps >= 10000) return "🏆 Leyenda del Live";
  if (taps >= 5000) return "👑 A Punto de Ser Leyenda";
  if (taps >= 3000) return "💎 Incondicional";
  if (taps >= 1000) return "💖 Ya Es Parte";
  if (taps >= 500) return "🔥 Siempre Presente";
  if (taps >= 100) return "💫 Recién Llegad@";

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

  // 👑 VIP / CASERITOS
  // Solo regalos normales, fuera de subasta.
  const cliente = getClienteVip({ username, uniqueId });

  const safeCoins = Number(coins || 0);
  const safeRepeat = Number(repeatCount || 1);
  const totalCoins = safeCoins * safeRepeat;

  cliente.totalRegalos += safeRepeat;
  cliente.monedasAcumuladas += totalCoins;

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

  if (arcanoGame.active) {
    return registerArcanoPick({ username, comment });
  }

  return { ok: false, reason: "arcano_inactive" };
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
      item.username ||
      item.nickname ||
      item.user?.nickname ||
      "";

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
  clientesVip = clientesVip.filter(c => !isTestUser(c.username));
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

    tiktok.on("gift", (data) => {
      lastEventAt = nowIso();
      lastGiftAt = nowIso();
      liveActive = true;

      cleanupRecentGiftKeys();

      const username =
        data.nickname ||
        data.user?.nickname ||
        data.uniqueId ||
        data.user?.uniqueId ||
        "Usuario";

      const giftName = data.giftName || "Regalo";
      const coins = data.diamondCount || 0;
      const repeatCount = data.repeatCount || 1;
      const normalizedGiftName = normalizeText(giftName);

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
    username;

  const taps = Number(
    data.likeCount ||
    data.count ||
    data.repeatCount ||
    1
  );

  const cliente = getClienteVip({ username, uniqueId });

  // 👇 ESTA LÍNEA YA LA TIENES
  cliente.totalTaps += taps;

  // 🔥 AQUÍ VA LO NUEVO (JUSTO DESPUÉS)
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

  // 👇 ESTO YA EXISTÍA
  saveClientesVip();
  emitClientesVip();

  io.emit("tap:update", {
    username,
    uniqueId,
    taps,
    totalTaps: cliente.totalTaps,
    cliente
  });

  console.log("👆 Tap tap:", username, taps, "Total:", cliente.totalTaps);
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

// ---------- SOCKET ----------

io.on("connection", (socket) => {
  console.log("Cliente conectado:", socket.id);

  socket.emit("queue:update", queue);
  socket.emit("queue:visible", buildVisibleQueue());
  socket.emit("live_status", { isConnected, currentUsername });
  socket.emit("roseAuction:update", buildRoseAuctionState());
  socket.emit("arcanoGame:update", buildArcanoGameState());
  socket.emit("clientesVip:update", buildClientesVipState());
});

server.listen(PORT, () => {
  console.log(`🌸 Backend corriendo en http://127.0.0.1:${PORT}`);
});