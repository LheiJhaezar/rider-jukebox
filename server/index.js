require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.get('/api/search-youtube', async (req, res) => {
  const query = req.query.q;
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!query) {
    return res.status(400).json({ error: 'Query parameter is required' });
  }

  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        maxResults: 6,
        q: query,
        type: 'video',
        key: apiKey
      }
    });
    res.json(response.data.items);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch YouTube videos' });
  }
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomCode, userName, isHost }) => {
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.userName = userName;

    // Notify existing room members for WebRTC voice handshake
    socket.to(roomCode).emit('user-joined-webrtc', { socketId: socket.id });
  });

  // WebRTC Signaling Events
  socket.on('webrtc-offer', ({ targetId, offer }) => {
    io.to(targetId).emit('webrtc-offer', { senderId: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ targetId, answer }) => {
    io.to(targetId).emit('webrtc-answer', { senderId: socket.id, answer });
  });

  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc-ice-candidate', { senderId: socket.id, candidate });
  });

  socket.on('play-video', ({ roomCode, videoId, videoTitle }) => {
    io.to(roomCode).emit('sync-play-video', { videoId, videoTitle });
  });

  socket.on('disconnect', () => {
    if (socket.roomCode) {
      io.to(socket.roomCode).emit('user-disconnected-webrtc', { socketId: socket.id });
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));