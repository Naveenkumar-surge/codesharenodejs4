import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import multer from "multer";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 100000 * 1024 * 1024, // 10 MB per message (increase if needed)
  pingTimeout: 60000, // 60s ping timeout
  pingInterval: 25000, // default is 25s
});


app.use(express.json({ limit: "10gb" }));
app.use(express.urlencoded({ extended: true, limit: "10gb" }));
server.timeout = 0;

// ===== AWS S3 CONFIG =====
const s3Client = new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  region: process.env.AWS_REGION,
});

const S3_BUCKET = process.env.AWS_BUCKET_NAME;

// ===== ROOM STORAGE =====
const roomMessages = {};

// ===== SOCKET.IO =====
io.on("connection", (socket) => {
  console.log("✅ New client connected:", socket.id);

  // Join room
  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    if (!roomMessages[roomId])
      roomMessages[roomId] = { messages: [], contentType: "text" };
    socket.emit("room-messages", roomMessages[roomId].messages);
    socket.emit("room-contentType", roomMessages[roomId].contentType);
  });

  // Switch room content type
  socket.on("room-contentType", ({ roomId, type }) => {
    if (!roomMessages[roomId])
      roomMessages[roomId] = { messages: [], contentType: type };
    roomMessages[roomId].contentType = type;
    io.to(roomId).emit("room-contentType", type);
  });

  // Text messages
  socket.on("room-message", (data) => {
    const { roomId } = data;
    if (!roomMessages[roomId])
      roomMessages[roomId] = { messages: [], contentType: "text" };
    roomMessages[roomId].messages.push(data);
    if (roomMessages[roomId].messages.length > 5)
      roomMessages[roomId].messages.shift();
    io.to(roomId).emit("room-message", data);
  });

  // ===== CHUNKED FILE UPLOAD (DIRECT TO S3) =====
  socket.on("upload-start", ({ roomId, fileName, totalChunks, fileType }) => {
    socket.uploadFile = {
      chunks: [],
      fileName,
      fileType,
      totalChunks,
      roomId,
      chunksReceived: 0,
    };
    console.log(`🚀 Upload started: ${fileName}`);
  });

  socket.on("upload-chunk", async ({ chunkData }) => {
    if (!socket.uploadFile) return;
    const upload = socket.uploadFile;

    upload.chunks.push(Buffer.from(chunkData));
    upload.chunksReceived++;

    const percent = Math.round(
      (upload.chunksReceived / upload.totalChunks) * 100
    );

    // Log progress for each chunk
    console.log(
      `🧩 Received chunk ${upload.chunksReceived}/${upload.totalChunks} (${percent}%) for ${upload.fileName}`
    );

    socket.emit("upload-progress", { fileName: upload.fileName, percent });

    // When all chunks are received
    if (upload.chunksReceived === upload.totalChunks) {
      try {
        const fileBuffer = Buffer.concat(upload.chunks);
        const s3Key = `uploads/${Date.now()}-${upload.fileName}`;

        console.log(`📦 Uploading ${upload.fileName} to S3...`);

        const uploader = new Upload({
          client: s3Client,
          params: {
            Bucket: S3_BUCKET,
            Key: s3Key,
            Body: fileBuffer,
            ContentType: upload.fileType,
          },
        });

        // Track S3 upload progress
        uploader.on("httpUploadProgress", (progress) => {
          if (progress.total) {
            const percent = Math.round(
              (progress.loaded / progress.total) * 100
            );
            console.log(
              `📤 S3 Upload ${upload.fileName}: ${percent}% (${progress.loaded}/${progress.total} bytes)`
            );
            socket.emit("upload-progress", {
              fileName: upload.fileName,
              percent,
            });
          }
        });

        const result = await uploader.done();
        console.log(`✅ Uploaded to S3: ${result.Location}`);

        const fileMessage = {
          roomId: upload.roomId,
          type: "file",
          fileName: upload.fileName,
          fileType: upload.fileType,
          data: result.Location,
        };

        // Save message in memory
        if (!roomMessages[upload.roomId])
          roomMessages[upload.roomId] = { messages: [], contentType: "text" };
        roomMessages[upload.roomId].messages.push(fileMessage);
        if (roomMessages[upload.roomId].messages.length > 5)
          roomMessages[upload.roomId].messages.shift();

        io.to(upload.roomId).emit("room-message", fileMessage);
        socket.emit("upload-progress", {
          fileName: upload.fileName,
          percent: 100,
        });

        // Auto delete from S3 after 4 minutes
        setTimeout(async () => {
          try {
            await s3Client.send(
              new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: s3Key })
            );
            console.log(`🗑️ Deleted from S3 after 9 mins: ${upload.fileName}`);
          } catch (err) {
            console.error("Error deleting from S3:", err.message);
          }
        }, 9 * 60 * 1000);

        delete socket.uploadFile;
      } catch (err) {
        console.error("❌ Error uploading to S3:", err.message);
      }
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});

// ===== REST API MULTIPLE FILE UPLOAD (DIRECT TO S3) =====
const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload", upload.array("files", 10), async (req, res) => {
  try {
    const files = req.files;
    const results = [];

    for (const file of files) {
      const s3Key = `uploads/${Date.now()}-${file.originalname}`;
      console.log(`📦 Uploading ${file.originalname} via REST API...`);

      const uploader = new Upload({
        client: s3Client,
        params: {
          Bucket: S3_BUCKET,
          Key: s3Key,
          Body: file.buffer,
          ContentType: file.mimetype,
        },
      });

      uploader.on("httpUploadProgress", (progress) => {
        if (progress.total) {
          const percent = Math.round(
            (progress.loaded / progress.total) * 100
          );
          console.log(
            `📤 REST Upload ${file.originalname}: ${percent}% (${progress.loaded}/${progress.total} bytes)`
          );
        }
      });

      const result = await uploader.done();
      console.log(`✅ Uploaded: ${file.originalname}`);

      // Auto delete after 4 minutes
      setTimeout(async () => {
        try {
          await s3Client.send(
            new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: s3Key })
          );
          console.log(`🗑️ Deleted from S3 after 9 mins: ${file.originalname}`);
        } catch (err) {
          console.error("Error deleting from S3:", err.message);
        }
      }, 9 * 60 * 1000);

      results.push({
        fileName: file.originalname,
        s3Url: result.Location,
      });
    }

    res.status(200).json({
      message: "Files uploaded successfully!",
      uploaded: results,
    });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).send("Error uploading files");
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 5000;
server.listen(PORT, () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);
