import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { WebcastPushConnection } from "tiktok-live-connector";

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

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

// Barrera anti-duplicados de corta duración
const recentGiftKeys = new Map();

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

/**
 * DINÁMICA ACTUAL
 *
 * rápida:
 * - Quiéreme → Galleta de la fortuna
 * - Collar de amistad → Mensaje Oráculo
 *
 * normal:
 * - Rosquilla → Oráculo Salud, Dinero y Amor
 * - Perfume → Pregunta Sí o No
 *
 * premium:
 * - Tiara de plumas → Pregunta extensa
 * - Corgi → 3 Preguntas profundas
 *
 * especial:
 * - Heart umbrella / similares → Sesión Privada
 */
const GIFT_RULES = [
  {
    matches: ["heart me", "heartme", "quiéreme", "quiereme"],
    serviceKey: "galleta_fortuna",
    serviceLabel: "Galleta de la fortuna",
    queueType: "rapida",
    icon: "🍪"
  },
  {
    matches: [
      "friendship necklace",
      "friendship collar",
      "collar de amistad"
    ],
    serviceKey: "mensaje_oraculo",
    serviceLabel: "Mensaje Oráculo",
    queueType: "rapida",
    icon: "💌"
  },
  {
    matches: ["doughnut", "donut", "rosquilla"],
    serviceKey: "oraculo_sda",
    serviceLabel: "Oráculo Salud, Dinero y Amor",
    queueType: "normal",
    icon: "🌈"
  },
  {
    matches: ["perfume", "perfume bottle"],
    serviceKey: "si_no",
    serviceLabel: "Pregunta Sí o No",
    queueType: "normal",
    icon: "🟢"
  },
  {
    matches: [
      "feather tiara",
      "feather crown",
      "tiara de plumas",
      "plume tiara"
    ],
    serviceKey: "pregunta_extensa",
    serviceLabel: "Pregunta extensa",
    queueType: "premium",
    icon: "👑"
  },
  {
    matches: ["corgi"],
    serviceKey: "tres_profundas",
    serviceLabel: "3 Preguntas profundas",
    queueType: "premium",
    icon: "🐶"
  },
  {
    matches: [
      "heart umbrella",
      "umbrella of love",
      "paraguas de corazón",
      "paraguas de corazon"
    ],
    serviceKey: "sesion_privada",
    serviceLabel: "Sesión Privada",
    queueType: "especial",
    icon: "☂️"
  }
];

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
  const rule = getGiftRule(giftName);

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

// ✅ CORREGIDO:
// cada regalo entra como item NUEVO, aunque sea del mismo usuario
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

function emitQueue() {
  io.emit("queue:update", queue);
  io.emit("queue:visible", buildVisibleQueue());
}

function emitLiveStatus() {
  io.emit("live_status", { isConnected, currentUsername });
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

app.get("/", (req, res) => {
  res.send("Backend activo");
});

app.get("/queue", (req, res) => {
  res.json(queue);
});

app.get("/queue-visible", (req, res) => {
  res.json(buildVisibleQueue());
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
    ).length
  });
});

app.post("/test-gift", (req, res) => {
  const { username, giftName = "PRUEBA", coins = 0, repeatCount = 1 } = req.body;

  if (!username) {
    return res.status(400).json({ error: "Falta username" });
  }

  const result = upsertQueueItem({
    username,
    giftName,
    coins,
    repeatCount
  });

  emitQueue();

  res.json({
    ok: true,
    action: result.action,
    item: result.item,
    queue,
    visibleQueue: buildVisibleQueue()
  });
});

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
  queue = queue.filter((item) => item.status !== "atendido");
  emitQueue();

  res.json({ ok: true, queue, visibleQueue: buildVisibleQueue() });
});

app.post("/clear", (req, res) => {
  queue = [];
  emitQueue();

  res.json({ ok: true, queue, visibleQueue: buildVisibleQueue() });
});

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
      cleanupRecentGiftKeys();

      const nickname =
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
        nickname,
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
          nickname,
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
        normalizedGiftName === "paraguas de corazon"
      ) {
        ttlMs = 3000;
      }

      if (hasRecentGiftKey(giftKey)) {
        console.log("⚠️ Regalo duplicado ignorado:", giftKey);
        return;
      }

      registerGiftKey(giftKey, ttlMs);

      const result = upsertQueueItem({
        username: nickname,
        giftName,
        coins,
        repeatCount
      });

      console.log(`🎁 Cola ${result.action}:`, result.item);
      emitQueue();
    });

    tiktok.on("chat", (data) => {
      console.log("💬 Chat:", data.nickname, data.comment);
    });

    tiktok.on("streamEnd", () => {
      console.log("📴 Live finalizado");
      isConnected = false;
      emitLiveStatus();
    });

    const state = await tiktok.connect();

    isConnected = true;

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

io.on("connection", (socket) => {
  console.log("Cliente conectado:", socket.id);

  socket.emit("queue:update", queue);
  socket.emit("queue:visible", buildVisibleQueue());
  socket.emit("live_status", { isConnected, currentUsername });
});

server.listen(PORT, () => {
  console.log(`🌸 Backend corriendo en http://127.0.0.1:${PORT}`);
});