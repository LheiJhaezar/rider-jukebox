const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allows connections from mobile browsers and local dev
    methods: ["GET", "POST"]
  }
});

// Store active room states in memory
const rooms = {};

io.on("connection", (socket) => {
  console.log(`Rider connected: ${socket.id}`);

  // 1. Join or Create Room
  socket.on("join-room", ({ roomId, user }) => {
    socket.join(roomId);
    
    if (!rooms[roomId]) {
      rooms[roomId] = {
        host: socket.id,
        trackUrl: "",
        currentTime: 0,
        isPlaying: false,
        members: []
      };
    }

    rooms[roomId].members.push({ id: socket.id, user });
    console.log(`User ${user?.name || socket.id} joined room: ${roomId}`);

    // Send initial jukebox state to newly connected rider
    socket.emit("sync-state", rooms[roomId]);

    // Notify others in room
    socket.to(roomId).emit("user-joined", { id: socket.id, user });
  });

  // 2. Synchronized Jukebox Events
  socket.on("play-track", ({ roomId, trackUrl, currentTime }) => {
    if (rooms[roomId]) {
      rooms[roomId].trackUrl = trackUrl;
      rooms[roomId].currentTime = currentTime;
      rooms[roomId].isPlaying = true;

      io.to(roomId).emit("track-played", { trackUrl, currentTime, timestamp: Date.now() });
    }
  });

  socket.on("pause-track", ({ roomId, currentTime }) => {
    if (rooms[roomId]) {
      rooms[roomId].currentTime = currentTime;
      rooms[roomId].isPlaying = false;

      io.to(roomId).emit("track-paused", { currentTime });
    }
  });

  socket.on("seek-track", ({ roomId, currentTime }) => {
    if (rooms[roomId]) {
      rooms[roomId].currentTime = currentTime;

      io.to(roomId).emit("track-seeked", { currentTime });
    }
  });

  // 3. WebRTC Audio Signaling (Helmet Intercom / Voice Chat)
  socket.on("webrtc-offer", ({ targetId, offer }) => {
    io.to(targetId).emit("webrtc-offer", { senderId: socket.id, offer });
  });

  socket.on("webrtc-answer", ({ targetId, answer }) => {
    io.to(targetId).emit("webrtc-answer", { senderId: socket.id, answer });
  });

  socket.on("webrtc-candidate", ({ targetId, candidate }) => {
    io.to(targetId).emit("webrtc-candidate", { senderId: socket.id, candidate });
  });

  // 4. Handle Disconnection
  socket.on("disconnect", () => {
    console.log(`Rider disconnected: ${socket.id}`);
    for (const roomId in rooms) {
      rooms[roomId].members = rooms[roomId].members.filter(m => m.id !== socket.id);
      socket.to(roomId).emit("user-left", { id: socket.id });
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Rider Jukebox server running on port ${PORT}`);
});