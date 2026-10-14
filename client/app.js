// 1. BACKEND & SUPABASE INITIALIZATION
const SERVER_URL = "https://rider-jukebox.onrender.com";
const socket = io(SERVER_URL, {
  transports: ["polling", "websocket"],
  secure: true
});

const SUPABASE_URL = "https://YOUR_SUPABASE_PROJECT_URL.supabase.co"; // Replace with your Supabase URL
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY"; // Replace with your Supabase Anon Key

// Initialize client on window object directly to avoid duplicate identifier errors
window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentRoomCode = null;
let player = null;

// 2. AUTH STATE LISTENER (PERSIST LOG IN ON RELOAD)
window.supabaseClient.auth.onAuthStateChange((event, session) => {
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

// 3. LOBBY CREATION & JOINING
function createLobby() {
  const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  joinSocketRoom(roomCode, true);
}

function joinLobby() {
  const roomCode = document.getElementById("join-room-input").value.trim().toUpperCase();
  if (!roomCode) return alert("Please enter a valid room code.");
  joinSocketRoom(roomCode, false);
}

function joinSocketRoom(roomCode, isHost) {
  currentRoomCode = roomCode;
  const userName = currentUser ? (currentUser.user_metadata.full_name || currentUser.email) : "Rider";

  socket.emit("join-room", { roomCode, userName, isHost });

  document.getElementById("display-room-code").innerText = roomCode;
  document.getElementById("lobby-screen").style.display = "none";
  document.getElementById("jukebox-screen").style.display = "block";
}

function leaveLobby() {
  location.reload();
}

// 4. YOUTUBE API PLAYER INITIALIZATION
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

// 5. YOUTUBE SEARCH & SYNCHRONIZED PLAYBACK
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

// Receive Real-time Sync Event from Backend
socket.on("sync-play-video", ({ videoId, videoTitle }) => {
  document.getElementById("now-playing-title").innerText = `Playing: ${videoTitle}`;
  if (player && player.loadVideoById) {
    player.loadVideoById(videoId);
  }
});