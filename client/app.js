// Connect to local Node.js server (When deployed to Render, swap this URL to your Render backend URL)
const socket = io("https://rider-jukebox-backend.onrender.com", {
  transports: ["polling", "websocket"]
});
// DOM Elements
const serverStatus = document.getElementById("server-status");
const roomSelection = document.getElementById("room-selection");
const dashboard = document.getElementById("dashboard");
const usernameInput = document.getElementById("username-input");
const roomInput = document.getElementById("room-input");
const joinBtn = document.getElementById("join-btn");
const displayRoomName = document.getElementById("display-room-name");
const memberCount = document.getElementById("member-count");

const audioUrlInput = document.getElementById("audio-url-input");
const playBtn = document.getElementById("play-btn");
const pauseBtn = document.getElementById("pause-btn");
const audioPlayer = document.getElementById("audio-player");
const micToggleBtn = document.getElementById("mic-toggle-btn");
const remoteVoice = document.getElementById("remote-voice");

let currentRoom = "";
let currentUser = "";
let localStream = null;
let peerConnection = null;
let isMicOn = false;

// WebRTC STUN Servers (Free from Google)
const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

// 1. Connection Status Updates
socket.on("connect", () => {
  serverStatus.innerText = "Status: Connected to Server";
  serverStatus.style.color = "#4caf50";
});

socket.on("disconnect", () => {
  serverStatus.innerText = "Status: Disconnected (Reconnecting...)";
  serverStatus.style.color = "#f44336";
});

// 2. Room Connection Logic
joinBtn.addEventListener("click", () => {
  currentUser = usernameInput.value.trim() || "Rider";
  currentRoom = roomInput.value.trim();

  if (!currentRoom) {
    alert("Please enter a Room Name or Code.");
    return;
  }

  socket.emit("join-room", { roomId: currentRoom, user: { name: currentUser } });
  
  roomSelection.classList.add("hidden");
  dashboard.classList.remove("hidden");
  displayRoomName.innerText = `Room: ${currentRoom}`;
});

// Sync state on joining
socket.on("sync-state", (state) => {
  if (state.members) {
    memberCount.innerText = `Riders: ${state.members.length}`;
  }
  if (state.trackUrl) {
    audioPlayer.src = state.trackUrl;
    audioPlayer.currentTime = state.currentTime;
    if (state.isPlaying) audioPlayer.play();
  }
});

socket.on("user-joined", (data) => {
  console.log("Rider joined:", data);
});

// 3. Jukebox Sync Controls & Media Session API
playBtn.addEventListener("click", () => {
  const url = audioUrlInput.value.trim();
  if (url && audioPlayer.src !== url) {
    audioPlayer.src = url;
  }
  audioPlayer.play();
  setupMediaSession();
  socket.emit("play-track", {
    roomId: currentRoom,
    trackUrl: audioPlayer.src,
    currentTime: audioPlayer.currentTime
  });
});

pauseBtn.addEventListener("click", () => {
  audioPlayer.pause();
  socket.emit("pause-track", {
    roomId: currentRoom,
    currentTime: audioPlayer.currentTime
  });
});

socket.on("track-played", ({ trackUrl, currentTime }) => {
  if (audioPlayer.src !== trackUrl) {
    audioPlayer.src = trackUrl;
  }
  audioPlayer.currentTime = currentTime;
  audioPlayer.play();
  setupMediaSession();
});

socket.on("track-paused", ({ currentTime }) => {
  audioPlayer.currentTime = currentTime;
  audioPlayer.pause();
});

// Media Session API for locked phone background playback
function setupMediaSession() {
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Rider Sync Jukebox",
      artist: currentUser,
      album: currentRoom
    });

    navigator.mediaSession.setActionHandler("play", () => {
      playBtn.click();
    });

    navigator.mediaSession.setActionHandler("pause", () => {
      pauseBtn.click();
    });
  }
}

// 4. Helmet Intercom (WebRTC Microphone Stream)
micToggleBtn.addEventListener("click", async () => {
  if (!isMicOn) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      isMicOn = true;
      micToggleBtn.innerText = "Mic ON 🎙️";
      micToggleBtn.className = "btn success-btn";

      initWebRTC();
    } catch (err) {
      alert("Microphone access denied or not available.");
      console.error(err);
    }
  } else {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    isMicOn = false;
    micToggleBtn.innerText = "Mic OFF";
    micToggleBtn.className = "btn danger-btn";
  }
});

function initWebRTC() {
  peerConnection = new RTCPeerConnection(rtcConfig);

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    remoteVoice.srcObject = event.streams[0];
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("webrtc-candidate", { targetId: "broadcast", candidate: event.candidate });
    }
  };
}

socket.on("webrtc-offer", async ({ senderId, offer }) => {
  if (!peerConnection) initWebRTC();
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit("webrtc-answer", { targetId: senderId, answer });
});

socket.on("webrtc-answer", async ({ answer }) => {
  if (peerConnection) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  }
});

socket.on("webrtc-candidate", async ({ candidate }) => {
  if (peerConnection && candidate) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }
});