const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

// 🔥 Cola interna
let queue = [];

// 👉 función para ordenar y mostrar solo 6
function getVisibleQueue() {
  const priority = queue
    .filter(u => u.priority)
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 3);

  const normal = queue
    .filter(u => !u.priority)
    .slice(0, 3);

  return [...priority, ...normal];
}

io.on("connection", (socket) => {
  console.log("Usuario conectado");

  socket.emit("queue:update", getVisibleQueue());

  socket.on("queue:add", (user) => {
    queue.push(user);

    io.emit("queue:update", getVisibleQueue());
  });

  socket.on("disconnect", () => {
    console.log("Usuario desconectado");
  });
});

server.listen(3002, () => {
  console.log("Servidor corriendo en puerto 3002");
});