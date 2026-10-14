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

function switchScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('on'));
  document.getElementById(screenId).classList.add('on');
}

function getInitials(name) {
  if (!name) return "??";
  const parts = name.trim().split(" ");
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// 1. AUTH LOGIC
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

// 2. LOBBY & CODE BOXES LOGIC
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

function getEnteredRoomCode() {
  return codeInputs.map(input => input.value).join('').toUpperCase();
}

function createLobby() {
  const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  joinSocketRoom(roomCode, true);
}

function joinLobby() {
  const roomCode = getEnteredRoomCode();
  if (roomCode.length < 6) return alert("Please enter a 6-character room code.");
  joinSocketRoom(roomCode, false);
}

function joinSocketRoom(roomCode, isHost) {
  currentRoomCode = roomCode;
  const userName = currentUser ? (currentUser.user_metadata.full_name || currentUser.email) : "Rider";

  socket.emit("join-room", { roomCode, userName, isHost });

  document.getElementById("display-room-code").innerText = roomCode;
  document.getElementById("status").innerText = "Connected to room";
  switchScreen("s-room");
  initWebRTC();
}

function copyRoomCode() {
  if (!currentRoomCode) return;
  navigator.clipboard?.writeText(currentRoomCode);
  const span = document.querySelector('#copy span');
  span.textContent = 'Copied';
  setTimeout(() => span.textContent = 'Tap to copy', 1500);
}

function leaveLobby() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  location.reload();
}

// 3. WEBRTC & PUSH-TO-TALK
async function initWebRTC() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStream.getAudioTracks()[0].enabled = false; // Hold-to-talk default off
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

// Hold to Talk pointer event listeners
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

// 4. YOUTUBE PLAYER & SEARCH
function onYouTubeIframeAPIReady() {
  player = new YT.Player('yt', {
    height: '100%',
    width: '100%',
    videoId: '',
    playerVars: { 'autoplay': 1, 'playsinline': 1 }
  });
}

async function searchYouTube() {
  const query = document.getElementById("q").value.trim();
  if (!query) return;

  try {
    const response = await fetch(`${SERVER_URL}/api/search-youtube?q=${encodeURIComponent(query)}`);
    const videos = await response.json();

    const resultsContainer = document.getElementById("results");
    resultsContainer.innerHTML = "";

    videos.forEach(video => {
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = `
        <div class="thumb" style="background-image: url('${video.snippet.thumbnails.default.url}')"></div>
        <div class="meta">
          <div class="t">${video.snippet.title}</div>
          <div class="s">${video.snippet.channelTitle}</div>
        </div>
        <button class="add" onclick="selectVideo('${video.id.videoId}', '${video.snippet.title.replace(/'/g, "\\'")}', '${video.snippet.channelTitle.replace(/'/g, "\\'")}', this)">Add</button>
      `;
      resultsContainer.appendChild(item);
    });
  } catch (err) {
    alert("Error fetching YouTube search results.");
  }
}

function selectVideo(videoId, videoTitle, channelTitle, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Added";
  }
  socket.emit("play-video", { roomCode: currentRoomCode, videoId, videoTitle, channelTitle });
}

socket.on("sync-play-video", ({ videoId, videoTitle, channelTitle }) => {
  document.getElementById("np-title").innerText = videoTitle;
  document.getElementById("np-by").innerText = `${channelTitle || "YouTube"} — added by Rider`;
  const placeholder = document.getElementById("ph");
  if (placeholder) placeholder.style.display = "none";
  if (player && player.loadVideoById) {
    player.loadVideoById(videoId);
  }
});