import express from "express";
import http from "http";
import { Server } from "socket.io";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // allow frontend
    methods: ["GET", "POST"],
  },
});

// 📂 Setup file uploads
const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage });

// Serve uploaded files
app.use("/uploads", express.static(uploadPath));

// 📝 Store messages + contentType per room
// Example: roomMessages = { roomId: { messages: [], contentType: "text" } }
const roomMessages = {};

// 🔌 Socket.io
io.on("connection", (socket) => {
  console.log("✅ New client connected:", socket.id);

  // Join a room
  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    console.log(`📌 User ${socket.id} joined room ${roomId}`);

    // Ensure room initialized
    if (!roomMessages[roomId]) {
      roomMessages[roomId] = { messages: [], contentType: "text" };
    }

    // Send last messages + current contentType
    socket.emit("room-messages", roomMessages[roomId].messages);
    socket.emit("room-contentType", roomMessages[roomId].contentType);
  });

  // Change content type (sync dropdown across room)
  socket.on("room-contentType", ({ roomId, type }) => {
    if (!roomMessages[roomId]) {
      roomMessages[roomId] = { messages: [], contentType: type };
    }
    roomMessages[roomId].contentType = type;

    io.to(roomId).emit("room-contentType", type);
    console.log(`🔄 Room ${roomId} contentType changed to: ${type}`);
  });

  // Handle new message
  socket.on("room-message", (data) => {
    const { roomId } = data;
    if (!roomMessages[roomId]) {
      roomMessages[roomId] = { messages: [], contentType: "text" };
    }

    roomMessages[roomId].messages.push(data);

    // Keep only last 5 messages
    if (roomMessages[roomId].messages.length > 5) {
      roomMessages[roomId].messages.shift();
    }

    io.to(roomId).emit("room-message", data);
    console.log(`💬 New message in room ${roomId}`);
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});

// 📤 REST API for uploads
app.post("/upload", upload.single("file"), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send("No file uploaded");

  const fileUrl = `http://localhost:5000/uploads/${file.filename}`;
  res.json({
    success: true,
    fileName: file.originalname,
    fileType: file.mimetype,
    fileUrl,
  });
});

// 🚀 Start server
const PORT = 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
