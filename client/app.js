// 1. CONFIGURATION & INITIALIZATION
const SERVER_URL = "https://rider-jukebox.onrender.com";
const socket = io(SERVER_URL, {
  transports: ["polling", "websocket"],
  secure: true
});

const SUPABASE_URL = "https://kfanbcvigynrohzdyecw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_nbZ0GPA4G1XcGgYuAtNTNQ_rW5TuQIq"; // Replace with your actual anon key

window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentRoomCode = null;
let player = null;

// WebRTC State Variables
let localStream = null;
let peerConnections = {}; // Keyed by socketId
let isMicMuted = true;

const rtcConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

// 2. PERSISTENT AUTH STATE LISTENER
window.supabaseClient.auth.onAuthStateChange((event, session) => {
  document.getElementById("loading-screen").style.display = "none";

  if (session) {
    currentUser = session.user;
    const name = currentUser.user_metadata.full_name || currentUser.email;
    document.getElementById("user-display-name").innerText = name;

    document.getElementById("auth-screen").style.display = "none";
    document.getElementById("lobby-screen").style.display = "block";
  } else {
    currentUser = null;
    document.getElementById("auth-screen").style.display = "block";
    document.getElementById("lobby-screen").style.display = "none";
    document.getElementById("jukebox-screen").style.display = "none";
  }
});

async function loginWithGoogle() {
  await window.supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin
    }
  });
}

async function logout() {
  await window.supabaseClient.auth.signOut();
}

// 3. LOBBY MANAGEMENT & SOCKET CONNECTIONS
function createLobby() {
  const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  joinSocketRoom(roomCode, true);
}

function joinLobby() {
  const roomCode = document.getElementById("join-room-input").value.trim().toUpperCase();
  if (!roomCode) return alert("Please enter a room code.");
  joinSocketRoom(roomCode, false);
}

function joinSocketRoom(roomCode, isHost) {
  currentRoomCode = roomCode;
  const userName = currentUser ? (currentUser.user_metadata.full_name || currentUser.email) : "Rider";

  socket.emit("join-room", { roomCode, userName, isHost });

  document.getElementById("display-room-code").innerText = roomCode;
  document.getElementById("lobby-screen").style.display = "none";
  document.getElementById("jukebox-screen").style.display = "block";

  initWebRTC();
}

function leaveLobby() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  location.reload();
}

// 4. WEBRTC REAL-TIME VOICE CHAT
async function initWebRTC() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    // Keep mic muted by default
    localStream.getAudioTracks()[0].enabled = false;
  } catch (err) {
    console.warn("Microphone access declined or unavailable:", err);
  }

  // Socket signaling events
  socket.on("user-joined-webrtc", async ({ socketId }) => {
    createPeerConnection(socketId, true);
  });

  socket.on("webrtc-offer", async ({ senderId, offer }) => {
    const pc = createPeerConnection(senderId, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("webrtc-answer", { targetId: senderId, answer });
  });

  socket.on("webrtc-answer", async ({ senderId, answer }) => {
    const pc = peerConnections[senderId];
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  });

  socket.on("webrtc-ice-candidate", async ({ senderId, candidate }) => {
    const pc = peerConnections[senderId];
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  });

  socket.on("user-disconnected-webrtc", ({ socketId }) => {
    if (peerConnections[socketId]) {
      peerConnections[socketId].close();
      delete peerConnections[socketId];
    }
    const remoteAudio = document.getElementById(`audio-${socketId}`);
    if (remoteAudio) remoteAudio.remove();
  });
}

function createPeerConnection(targetSocketId, isInitiator) {
  const pc = new RTCPeerConnection(rtcConfiguration);
  peerConnections[targetSocketId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("webrtc-ice-candidate", { targetId: targetSocketId, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    let remoteAudio = document.getElementById(`audio-${targetSocketId}`);
    if (!remoteAudio) {
      remoteAudio = document.createElement("audio");
      remoteAudio.id = `audio-${targetSocketId}`;
      remoteAudio.autoplay = true;
      remoteAudio.playsInline = true;
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

function toggleMicrophone() {
  if (!localStream) return alert("Microphone access is not available.");
  
  isMicMuted = !isMicMuted;
  localStream.getAudioTracks()[0].enabled = !isMicMuted;

  const btn = document.getElementById("btn-mic");
  const status = document.getElementById("mic-status");

  if (isMicMuted) {
    btn.innerText = "Enable Microphone";
    status.innerText = "Mic: Muted";
  } else {
    btn.innerText = "Mute Microphone";
    status.innerText = "Mic: Live 🎙️";
  }
}

// 5. YOUTUBE PLAYER & MOBILE BACKGROUND AUDIO UNLOCK
function onYouTubeIframeAPIReady() {
  player = new YT.Player('youtube-player', {
    height: '220',
    width: '100%',
    videoId: '',
    playerVars: {
      'autoplay': 1,
      'playsinline': 1
    }
  });
}

function unlockMobileAudio() {
  if (player && player.playVideo) {
    player.playVideo();
  }
  
  // Register Media Session metadata for mobile background controls
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Rider Jukebox Session",
      artist: "Synchronized Ride Audio",
      album: "Rider Jukebox"
    });

    navigator.mediaSession.setActionHandler('play', () => player && player.playVideo());
    navigator.mediaSession.setActionHandler('pause', () => player && player.pauseVideo());
  }

  document.getElementById("btn-unlock-audio").style.display = "none";
}

async function searchYouTube() {
  const query = document.getElementById("yt-search-input").value.trim();
  if (!query) return;

  try {
    const response = await fetch(`${SERVER_URL}/api/search-youtube?q=${encodeURIComponent(query)}`);
    const videos = await response.json();

    const resultsContainer = document.getElementById("search-results");
    resultsContainer.innerHTML = "";

    videos.forEach(video => {
      const item = document.createElement("div");
      item.className = "video-card";
      item.innerHTML = `
        <img src="${video.snippet.thumbnails.default.url}" width="80" />
        <div class="video-info">
          <strong>${video.snippet.title}</strong>
          <button onclick="selectVideo('${video.id.videoId}', '${video.snippet.title.replace(/'/g, "\\'")}')">Play for Ride</button>
        </div>
      `;
      resultsContainer.appendChild(item);
    });
  } catch (err) {
    alert("Error fetching YouTube search results.");
  }
}

function selectVideo(videoId, videoTitle) {
  socket.emit("play-video", { roomCode: currentRoomCode, videoId, videoTitle });
}

socket.on("sync-play-video", ({ videoId, videoTitle }) => {
  document.getElementById("now-playing-title").innerText = `Playing: ${videoTitle}`;
  if (player && player.loadVideoById) {
    player.loadVideoById(videoId);
  }
  
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: videoTitle,
      artist: "Rider Jukebox Sync"
    });
  }
});