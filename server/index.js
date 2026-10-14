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
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// In-memory room state
const rooms = {};

// Cache YouTube searches to conserve API quota
const searchCache = new Map();

app.get('/api/search-youtube', async (req, res) => {
  const query = req.query.q?.trim();
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!query) return res.status(400).json({ error: 'Query parameter is required' });
  if (searchCache.has(query)) return res.json(searchCache.get(query));

  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', maxResults: 6, q: query, type: 'video', key: apiKey }
    });
    searchCache.set(query, response.data.items);
    res.json(response.data.items);
  } catch (err) {
    if (err.response?.status === 403) {
      return res.status(429).json({ error: 'Search is unavailable right now. Try again later.' });
    }
    res.status(500).json({ error: 'Failed to fetch YouTube videos' });
  }
});

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomCode, userName }) => {
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.userName = userName;

    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        hostId: socket.id,
        currentTrack: null,
        queue: [],
        skipVotes: new Set(),
        riders: {}
      };
    }

    const room = rooms[roomCode];
    room.riders[socket.id] = { name: userName, isHost: room.hostId === socket.id };

    // WebRTC connection signaling to other riders
    socket.to(roomCode).emit('user-joined-webrtc', { socketId: socket.id });

    // Send updated room state to all clients in room
    broadcastRoomState(roomCode);
  });

  socket.on('add-to-queue', ({ roomCode, videoId, videoTitle, channelTitle }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const track = {
      id: videoId,
      title: videoTitle,
      channel: channelTitle || 'YouTube',
      addedBy: socket.userName
    };

    if (!room.currentTrack) {
      room.currentTrack = track;
      io.to(roomCode).emit('play-track', { track, currentTime: 0 });
    } else {
      room.queue.push(track);
    }

    broadcastRoomState(roomCode);
  });

  socket.on('vote-skip', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.currentTrack) return;

    const isHost = room.hostId === socket.id;
    room.skipVotes.add(socket.id);

    const riderCount = Object.keys(room.riders).length;
    const votesNeeded = Math.ceil(riderCount / 2);

    if (isHost || room.skipVotes.size >= votesNeeded) {
      playNextTrack(roomCode);
    } else {
      broadcastRoomState(roomCode);
    }
  });

  socket.on('track-ended', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (room && socket.id === room.hostId) {
      playNextTrack(roomCode);
    }
  });

  socket.on('host-time-sync', ({ roomCode, currentTime }) => {
    socket.to(roomCode).emit('sync-time', { currentTime });
  });

  // WebRTC Signaling Relays
  socket.on('webrtc-offer', ({ targetId, offer }) => io.to(targetId).emit('webrtc-offer', { senderId: socket.id, offer }));
  socket.on('webrtc-answer', ({ targetId, answer }) => io.to(targetId).emit('webrtc-answer', { senderId: socket.id, answer }));
  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => io.to(targetId).emit('webrtc-ice-candidate', { senderId: socket.id, candidate }));

  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];
    delete room.riders[socket.id];
    room.skipVotes.delete(socket.id);

    io.to(roomCode).emit('user-disconnected-webrtc', { socketId: socket.id });

    // Host transfer if current host leaves
    if (room.hostId === socket.id) {
      const remainingSocketIds = Object.keys(room.riders);
      if (remainingSocketIds.length > 0) {
        room.hostId = remainingSocketIds[0];
        room.riders[room.hostId].isHost = true;
      } else {
        delete rooms[roomCode];
        return;
      }
    }

    broadcastRoomState(roomCode);
  });
});

function playNextTrack(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.skipVotes.clear();

  if (room.queue.length > 0) {
    room.currentTrack = room.queue.shift();
    io.to(roomCode).emit('play-track', { track: room.currentTrack, currentTime: 0 });
  } else {
    room.currentTrack = null;
    io.to(roomCode).emit('queue-empty');
  }

  broadcastRoomState(roomCode);
}

function broadcastRoomState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const riderList = Object.entries(room.riders).map(([id, info]) => ({
    id,
    name: info.name,
    isHost: info.isHost
  }));

  const totalRiders = riderList.length;
  const votesNeeded = Math.ceil(totalRiders / 2);

  io.to(roomCode).emit('room-state-update', {
    hostId: room.hostId,
    riders: riderList,
    currentTrack: room.currentTrack,
    queue: room.queue,
    skipVotes: room.skipVotes.size,
    votesNeeded
  });
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));