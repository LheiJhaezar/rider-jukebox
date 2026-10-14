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

const rooms = {};
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
  socket.on('join-room', ({ roomCode, userId, userName }) => {
    if (!roomCode || !userId) return;

    socket.roomCode = roomCode;
    socket.userId = userId;
    socket.userName = userName;

    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        hostUserId: userId,
        currentTrack: null,
        playbackStartTime: 0,
        isPlaying: false,
        queue: [],
        skipVotes: new Set(),
        riders: {}
      };
    }

    const room = rooms[roomCode];

    if (room.riders[userId] && room.riders[userId].disconnectTimeout) {
      clearTimeout(room.riders[userId].disconnectTimeout);
      room.riders[userId].disconnectTimeout = null;
    }

    room.riders[userId] = {
      socketId: socket.id,
      name: userName,
      isHost: room.hostUserId === userId,
      status: 'connected',
      connectedAt: room.riders[userId]?.connectedAt || Date.now(),
      disconnectTimeout: null,
      lastSignalTime: 0
    };

    socket.join(roomCode);
    socket.to(roomCode).emit('user-joined-webrtc', { socketId: socket.id, userId });

    sendFullRoomState(socket, roomCode);
    broadcastRoomState(roomCode);
  });

  socket.on('send-quick-signal', ({ roomCode, signalType }) => {
    const room = rooms[roomCode];
    if (!room || !room.riders[socket.userId]) return;

    const rider = room.riders[socket.userId];
    const now = Date.now();

    if (now - (rider.lastSignalTime || 0) < 3000) return;

    rider.lastSignalTime = now;
    io.to(roomCode).emit('receive-quick-signal', {
      senderName: socket.userName,
      signalType
    });
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
      room.playbackStartTime = Date.now();
      room.isPlaying = true;
      io.to(roomCode).emit('play-track', { track, currentTime: 0, serverTimestamp: Date.now() });
    } else {
      room.queue.push(track);
    }

    broadcastRoomState(roomCode);
  });

  socket.on('vote-skip', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.currentTrack) return;

    const isHost = room.hostUserId === socket.userId;
    room.skipVotes.add(socket.userId);

    const activeRidersCount = Object.values(room.riders).filter(r => r.status === 'connected').length;
    const votesNeeded = Math.ceil(activeRidersCount / 2);

    if (isHost || room.skipVotes.size >= votesNeeded) {
      playNextTrack(roomCode);
    } else {
      broadcastRoomState(roomCode);
    }
  });

  socket.on('track-ended', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (room && socket.userId === room.hostUserId) {
      playNextTrack(roomCode);
    }
  });

  socket.on('host-time-sync', ({ roomCode, currentTime }) => {
    const room = rooms[roomCode];
    if (room && socket.userId === room.hostUserId) {
      room.playbackStartTime = Date.now() - (currentTime * 1000);
      socket.to(roomCode).emit('sync-time', { currentTime, serverTimestamp: Date.now() });
    }
  });

  socket.on('webrtc-offer', ({ targetId, offer }) => io.to(targetId).emit('webrtc-offer', { senderId: socket.id, offer }));
  socket.on('webrtc-answer', ({ targetId, answer }) => io.to(targetId).emit('webrtc-answer', { senderId: socket.id, answer }));
  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => io.to(targetId).emit('webrtc-ice-candidate', { senderId: socket.id, candidate }));

  socket.on('disconnect', () => {
    const { roomCode, userId } = socket;
    if (!roomCode || !rooms[roomCode] || !userId) return;

    const room = rooms[roomCode];
    const rider = room.riders[userId];
    if (!rider) return;

    rider.status = 'reconnecting';
    room.skipVotes.delete(userId);
    io.to(roomCode).emit('user-disconnected-webrtc', { socketId: socket.id });

    broadcastRoomState(roomCode);

    rider.disconnectTimeout = setTimeout(() => {
      if (rooms[roomCode] && rooms[roomCode].riders[userId]?.status === 'reconnecting') {
        delete rooms[roomCode].riders[userId];

        if (rooms[roomCode].hostUserId === userId) {
          const remainingRiders = Object.entries(rooms[roomCode].riders)
            .sort(([, a], [, b]) => a.connectedAt - b.connectedAt);

          if (remainingRiders.length > 0) {
            const [newHostUserId, newHostData] = remainingRiders[0];
            rooms[roomCode].hostUserId = newHostUserId;
            newHostData.isHost = true;
          } else {
            delete rooms[roomCode];
            return;
          }
        }
        broadcastRoomState(roomCode);
      }
    }, 60000);
  });
});

function playNextTrack(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.skipVotes.clear();

  if (room.queue.length > 0) {
    room.currentTrack = room.queue.shift();
    room.playbackStartTime = Date.now();
    room.isPlaying = true;
    io.to(roomCode).emit('play-track', { track: room.currentTrack, currentTime: 0, serverTimestamp: Date.now() });
  } else {
    room.currentTrack = null;
    room.isPlaying = false;
    io.to(roomCode).emit('queue-empty');
  }

  broadcastRoomState(roomCode);
}

function sendFullRoomState(socket, roomCode) {
  const room = rooms[roomCode];
  if (!room) return socket.emit('room-not-found');

  let currentPosition = 0;
  if (room.currentTrack && room.playbackStartTime > 0) {
    currentPosition = (Date.now() - room.playbackStartTime) / 1000;
  }

  socket.emit('full-room-state', {
    roomCode,
    hostUserId: room.hostUserId,
    currentTrack: room.currentTrack,
    currentPosition,
    isPlaying: room.isPlaying,
    queue: room.queue,
    serverTimestamp: Date.now()
  });
}

function broadcastRoomState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const riderList = Object.entries(room.riders).map(([uId, info]) => ({
    userId: uId,
    name: info.name,
    isHost: info.isHost,
    status: info.status
  }));

  const activeRiders = riderList.filter(r => r.status === 'connected');
  const votesNeeded = Math.ceil(activeRiders.length / 2);

  io.to(roomCode).emit('room-state-update', {
    hostUserId: room.hostUserId,
    riders: riderList,
    currentTrack: room.currentTrack,
    queue: room.queue,
    skipVotes: room.skipVotes.size,
    votesNeeded
  });
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));