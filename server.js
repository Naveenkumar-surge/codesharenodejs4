const express = require("express");
const http = require("http");
const cors = require("cors");
const socketIO = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

app.get("/h", (req, res) => {
  res.send("server");
});

// Room and canvas state management
let rooms = {};
let canvasState = null;

// User management
const users = [];

// Join user to chat
const userJoin = (id, username, room, host, presenter) => {
  const user = { id, username, room, host, presenter };
  users.push(user);
  return user;
};

// User leaves chat
const userLeave = (id) => {
  const index = users.findIndex((user) => user.id === id);
  if (index !== -1) {
    return users.splice(index, 1)[0];
  }
};

// Get users in a room
const getUsers = (room) => {
  return users.filter((user) => user.room === room);
};

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("user-joined", (data) => {
    const { roomId, userId, userName, host, presenter } = data;
    const user = userJoin(socket.id, userName, roomId, host, presenter);
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = { users: [], canvasState: null };
    }
    rooms[roomId].users.push({ socketId: socket.id, username: userName });

    const roomUsers = getUsers(user.room);

    socket.emit("message", { message: "Welcome to ChatRoom" });
    socket.broadcast
      .to(user.room)
      .emit("message", { message: `${user.username} has joined` });

    io.to(user.room).emit("users", roomUsers);
    io.to(user.room).emit("canvasImage", rooms[roomId].canvasState);
  });

  socket.on("joinRoom", ({ username, roomId }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = { users: [], canvasState: null };
    }
    rooms[roomId].users.push({ socketId: socket.id, username });

    io.to(roomId).emit("roomMembers", rooms[roomId].users);
    if (rooms[roomId].canvasState) {
      socket.emit("canvasState", { roomId, image: rooms[roomId].canvasState });
    }
    console.log(`User ${username} joined room ${roomId}`);
  });

  socket.on("sendMessage", ({ username, message, roomId }) => {
    io.to(roomId).emit("receiveMessage", { username, message, roomId });
  });

  socket.on("getRoomMembers", ({ roomId }) => {
    io.to(socket.id).emit("roomMembers", rooms[roomId]?.users || []);
  });

  socket.on("leaveRoom", ({ username, roomId }) => {
    socket.leave(roomId);
    if (rooms[roomId]) {
      rooms[roomId].users = rooms[roomId].users.filter(
        (user) => user.socketId !== socket.id
      );
      io.to(roomId).emit("roomMembers", rooms[roomId].users);
    }
    console.log(`User ${username} left room ${roomId}`);
  });

  socket.on("drawing", ({ roomId, image }) => {
    rooms[roomId].canvasState = image;
    socket.broadcast.to(roomId).emit("canvasState", { roomId, image });
  });

  socket.on("clear", ({ roomId }) => {
    rooms[roomId].canvasState = null;
    io.to(roomId).emit("canvasState", { roomId, image: null });
  });

  socket.on("disconnect", () => {
    const userLeaves = userLeave(socket.id);
    
    if (userLeaves) {
      const { room, username } = userLeaves;
      const roomUsers = getUsers(room);
      
      io.to(room).emit("message", { message: `${username} left the chat` });
      io.to(room).emit("users", roomUsers);

      if (rooms[room]) {
        rooms[room].users = rooms[room].users.filter(
          (user) => user.socketId !== socket.id
        );
        io.to(room).emit("roomMembers", rooms[room].users);
      }
    }

    console.log(`User disconnected: ${socket.id}`);
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
