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

// YouTube Proxy Endpoint
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
    console.error('YouTube API Error:', err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Failed to fetch YouTube videos' });
  }
});

// Real-Time Socket Lobby & Synchronized Playback
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomCode, userName, isHost }) => {
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.userName = userName;

    console.log(`${userName} joined room ${roomCode} (Host: ${isHost})`);

    // Notify room of new member
    io.to(roomCode).emit('user-joined', { userName, isHost });
  });

  socket.on('play-video', ({ roomCode, videoId, videoTitle }) => {
    // Broadcast selected video to all riders in the room
    io.to(roomCode).emit('sync-play-video', { videoId, videoTitle });
  });

  socket.on('disconnect', () => {
    if (socket.roomCode && socket.userName) {
      io.to(socket.roomCode).emit('user-left', { userName: socket.userName });
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});