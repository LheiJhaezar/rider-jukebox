const SERVER_URL = "https://rider-jukebox.onrender.com";
const socket = io(SERVER_URL, {
  transports: ["polling", "websocket"],
  secure: true
});

const SUPABASE_URL = "https://kfanbcvigynrohzdyecw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_nbZ0GPA4G1XcGgYuAtNTNQ_rW5TuQIq"; // Ensure your actual anon key is placed here

window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentRoomCode = null;
let player = null;
let localStream = null;
let peerConnections = {};

let isHost = false;
let hostSyncInterval = null;
let currentTrack = null;
let isRideMode = false;
let wakeLock = null;

function switchScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('on'));
  document.getElementById(screenId).classList.add('on');
}

function getInitials(name) {
  if (!name) return "??";
  const parts = name.trim().split(" ");
  return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
}

function fmt(s) {
  s = Math.floor(s || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// 1. SCREEN WAKE LOCK API (KEEP SCREEN ON WHILE IN RIDE)
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (err) {
    console.warn("Screen Wake Lock error:", err);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().then(() => { wakeLock = null; });
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && currentRoomCode) {
    await requestWakeLock();
  }
});

// 2. RIDE MODE TOGGLE
function toggleRideMode() {
  isRideMode = !isRideMode;
  const btn = document.getElementById("btn-ridemode");
  const collapsibleSections = document.querySelectorAll(".collapsible-section");

  if (isRideMode) {
    btn.innerText = "Exit ride mode";
    btn.style.background = "var(--lamp)";
    btn.style.color = "var(--lamp-ink)";
    collapsibleSections.forEach(s => s.style.display = "none");
  } else {
    btn.innerText = "Ride mode";
    btn.style.background = "var(--lane)";
    btn.style.color = "var(--line)";
    collapsibleSections.forEach(s => s.style.display = "flex");
  }
}

// 3. AUTO-FILL ROOM FROM SHARE LINK & AUTH RESTORATION
window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get('room')?.toUpperCase();
  if (roomFromUrl && roomFromUrl.length === 6) {
    const codeInputs = [...document.querySelectorAll('#code input')];
    codeInputs.forEach((x, j) => x.value = roomFromUrl[j] || '');
  }
});

window.supabaseClient.auth.onAuthStateChange((event, session) => {
  if (session) {
    currentUser = session.user;
    const name = currentUser.user_metadata.full_name || currentUser.email;
    document.getElementById("user-display-name").innerText = name;
    document.getElementById("user-avatar").innerText = getInitials(name);
    switchScreen("s-lobby");
  } else {
    currentUser = null;
    switchScreen("s-login");
  }
});

async function loginWithGoogle() {
  await window.supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
}

async function logout() {
  await window.supabaseClient.auth.signOut();
}

// 4. LOBBY & RECONNECT HANDLING
const codeInputs = [...document.querySelectorAll('#code input')];
codeInputs.forEach((b, i) => {
  b.addEventListener('input', () => {
    b.value = b.value.toUpperCase();
    if (b.value && codeInputs[i + 1]) codeInputs[i + 1].focus();
  });
  b.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !b.value && codeInputs[i - 1]) codeInputs[i - 1].focus();
  });
  b.addEventListener('paste', e => {
    const v = (e.clipboardData.getData('text') || '').toUpperCase().slice(0, 6);
    codeInputs.forEach((x, j) => x.value = v[j] || '');
    e.preventDefault();
  });
});

function createLobby() {
  const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  joinSocketRoom(roomCode);
}

function joinLobby() {
  const roomCode = codeInputs.map(input => input.value).join('').toUpperCase();
  if (roomCode.length < 6) return alert("Please enter a valid 6-character room code.");
  joinSocketRoom(roomCode);
}

function joinSocketRoom(roomCode) {
  currentRoomCode = roomCode;
  const userName = currentUser ? (currentUser.user_metadata.full_name || currentUser.email) : "Rider";

  socket.emit("join-room", { roomCode, userName });

  document.getElementById("display-room-code").innerText = roomCode;
  document.getElementById("status").innerText = "";
  switchScreen("s-room");
  initWebRTC();
  requestWakeLock();
}

socket.on('connect', () => {
  if (currentRoomCode) {
    document.getElementById("status").innerText = "";
    joinSocketRoom(currentRoomCode);
  }
});

socket.on('disconnect', () => {
  document.getElementById("status").innerText = "Reconnecting...";
});

function copyRoomCode() {
  if (!currentRoomCode) return;
  const shareUrl = `${window.location.origin}/?room=${currentRoomCode}`;
  navigator.clipboard?.writeText(shareUrl);
  const span = document.querySelector('#copy span');
  span.textContent = 'Link copied';
  setTimeout(() => span.textContent = 'Tap to copy link', 1500);
}

function leaveLobby() {
  releaseWakeLock();
  if (localStream) localStream.getTracks().forEach(track => track.stop());
  location.href = window.location.origin;
}

// 5. WEBRTC & PUSH-TO-TALK
async function initWebRTC() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStream.getAudioTracks()[0].enabled = false;
  } catch (err) {
    console.warn("Microphone unavailable:", err);
  }

  socket.on("user-joined-webrtc", ({ socketId }) => createPeerConnection(socketId, true));
  socket.on("webrtc-offer", async ({ senderId, offer }) => {
    const pc = createPeerConnection(senderId, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("webrtc-answer", { targetId: senderId, answer });
  });
  socket.on("webrtc-answer", async ({ senderId, answer }) => {
    if (peerConnections[senderId]) {
      await peerConnections[senderId].setRemoteDescription(new RTCSessionDescription(answer));
    }
  });
  socket.on("webrtc-ice-candidate", async ({ senderId, candidate }) => {
    if (peerConnections[senderId]) {
      await peerConnections[senderId].addIceCandidate(new RTCIceCandidate(candidate));
    }
  });
  socket.on("user-disconnected-webrtc", ({ socketId }) => {
    if (peerConnections[socketId]) {
      peerConnections[socketId].close();
      delete peerConnections[socketId];
    }
    const elem = document.getElementById(`audio-${socketId}`);
    if (elem) elem.remove();
  });
}

function createPeerConnection(targetSocketId, isInitiator) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  peerConnections[targetSocketId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = event => {
    if (event.candidate) {
      socket.emit("webrtc-ice-candidate", { targetId: targetSocketId, candidate: event.candidate });
    }
  };

  pc.ontrack = event => {
    let remoteAudio = document.getElementById(`audio-${targetSocketId}`);
    if (!remoteAudio) {
      remoteAudio = document.createElement("audio");
      remoteAudio.id = `audio-${targetSocketId}`;
      remoteAudio.autoplay = true;
      document.getElementById("audio-streams").appendChild(remoteAudio);
    }
    remoteAudio.srcObject = event.streams[0];
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("webrtc-offer", { targetId: targetSocketId, offer });
    };
  }
  return pc;
}

const talkBtn = document.getElementById('talk');
const setTalkingState = (isTalking) => {
  if (!localStream || !localStream.getAudioTracks()[0]) return;
  localStream.getAudioTracks()[0].enabled = isTalking;
  talkBtn.classList.toggle('live', isTalking);
  talkBtn.setAttribute('aria-pressed', isTalking);
  talkBtn.textContent = isTalking ? 'Talking' : 'Hold to talk';
  document.getElementById('mic-note').textContent = isTalking ? 'Everyone can hear you' : 'Mic is off';
};

['pointerdown'].forEach(ev => talkBtn.addEventListener(ev, e => { e.preventDefault(); setTalkingState(true); }));
['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => talkBtn.addEventListener(ev, () => setTalkingState(false)));

// 6. PLAYER & QUEUE SYNC
function onYouTubeIframeAPIReady() {
  player = new YT.Player('yt', {
    height: '100%',
    width: '100%',
    videoId: '',
    playerVars: { 'autoplay': 1, 'playsinline': 1 },
    events: {
      'onStateChange': (e) => {
        if (e.data === YT.PlayerState.ENDED && isHost) {
          socket.emit('track-ended', { roomCode: currentRoomCode });
        }
      }
    }
  });
}

setInterval(() => {
  if (player && player.getCurrentTime && player.getDuration) {
    const cur = player.getCurrentTime();
    const dur = player.getDuration();
    if (dur > 0) {
      document.getElementById('t-now').innerText = fmt(cur);
      document.getElementById('t-len').innerText = fmt(dur);
      document.getElementById('bar').style.width = (cur / dur * 100) + '%';
    }
  }
}, 1000);

socket.on('room-state-update', (state) => {
  isHost = state.hostId === socket.id;

  document.getElementById('riders').innerHTML = state.riders.map(r => `
    <div class="rider">
      <div class="avatar">${getInitials(r.name)}</div>
      ${r.name.split(" ")[0]}${r.isHost ? ' (Host)' : ''}
    </div>
  `).join('');

  const skipBtn = document.getElementById('btn-skip');
  if (state.currentTrack) {
    skipBtn.style.display = 'block';
    skipBtn.innerText = isHost ? 'Skip (Host)' : `Skip (${state.skipVotes}/${state.votesNeeded})`;
  } else {
    skipBtn.style.display = 'none';
  }

  const queueContainer = document.getElementById('queue');
  if (state.queue.length > 0) {
    queueContainer.innerHTML = state.queue.map(t => `
      <div class="item">
        <div class="thumb" style="background-image: url('https://img.youtube.com/vi/${t.id}/hqdefault.jpg')"></div>
        <div class="meta">
          <div class="t">${t.title}</div>
          <div class="s">${t.channel} — added by ${t.addedBy}</div>
        </div>
      </div>
    `).join('');
  } else {
    queueContainer.innerHTML = '<div class="empty">Nothing queued.</div>';
  }

  if (isHost && !hostSyncInterval) {
    hostSyncInterval = setInterval(() => {
      if (player && player.getCurrentTime) {
        socket.emit('host-time-sync', { roomCode: currentRoomCode, currentTime: player.getCurrentTime() });
      }
    }, 4000);
  } else if (!isHost && hostSyncInterval) {
    clearInterval(hostSyncInterval);
    hostSyncInterval = null;
  }
});

socket.on('play-track', ({ track, currentTime }) => {
  currentTrack = track;
  document.getElementById("np-title").innerText = track.title;
  document.getElementById("np-by").innerText = `${track.channel} — added by ${track.addedBy}`;
  const placeholder = document.getElementById("ph");
  if (placeholder) placeholder.style.display = "none";

  if (player && player.loadVideoById) {
    player.loadVideoById(track.id, currentTime);
  }
});

socket.on('queue-empty', () => {
  currentTrack = null;
  document.getElementById("np-title").innerText = "Queue is empty";
  document.getElementById("np-by").innerText = "Add the first song below";
  document.getElementById("bar").style.width = '0%';
  document.getElementById("t-now").innerText = "0:00";
  document.getElementById("t-len").innerText = "0:00";
  const placeholder = document.getElementById("ph");
  if (placeholder) placeholder.style.display = "grid";
});

socket.on('sync-time', ({ currentTime }) => {
  if (!isHost && player && player.getCurrentTime) {
    const clientTime = player.getCurrentTime();
    if (Math.abs(clientTime - currentTime) > 1.5) {
      player.seekTo(currentTime, true);
    }
  }
});

function voteSkip() {
  if (currentRoomCode) {
    socket.emit('vote-skip', { roomCode: currentRoomCode });
  }
}

// 7. YOUTUBE SEARCH & RATE LIMITING
async function searchYouTube() {
  const query = document.getElementById("q").value.trim();
  if (!query) return;

  try {
    const response = await fetch(`${SERVER_URL}/api/search-youtube?q=${encodeURIComponent(query)}`);
    const data = await response.json();

    if (data.error) return alert(data.error);

    const resultsContainer = document.getElementById("results");
    resultsContainer.innerHTML = "";

    data.forEach(video => {
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = `
        <div class="thumb" style="background-image: url('${video.snippet.thumbnails.default.url}')"></div>
        <div class="meta">
          <div class="t">${video.snippet.title}</div>
          <div class="s">${video.snippet.channelTitle}</div>
        </div>
        <button class="add" onclick="addToQueue('${video.id.videoId}', '${video.snippet.title.replace(/'/g, "\\'")}', '${video.snippet.channelTitle.replace(/'/g, "\\'")}', this)">Add</button>
      `;
      resultsContainer.appendChild(item);
    });
  } catch (err) {
    alert("Error fetching YouTube search results.");
  }
}

function addToQueue(videoId, videoTitle, channelTitle, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Added";
  }
  socket.emit("add-to-queue", { roomCode: currentRoomCode, videoId, videoTitle, channelTitle });
}