const SERVER_URL = "https://rider-jukebox.onrender.com";
const socket = io(SERVER_URL, {
  transports: ["polling", "websocket"],
  secure: true,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 15000
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
let audioUnlocked = false;

// Web Audio API & Ducking
let audioCtx = null;
let audioAnalysers = {};
let audioAnimFrame = null;
let targetMusicVolume = 100;
let baseMusicVolume = 100;
let isDucked = false;
let duckTimeout = null;
let toastTimeout = null;

// Local Talking State Tracking
let activeTalkers = new Map(); // Keyed by userId -> userName
let isLocalTalker = false;

// Mic Check Test State
let micTestObj = null;

function switchScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('on'));
  if (screenId) {
    const target = document.getElementById(screenId);
    if (target) target.classList.add('on');
  }
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

// 1. NAVIGATION & LAYOUT CONTROLS
function switchTab(tabId, tabBtn) {
  document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected', 'false'));
  if (tabBtn) tabBtn.setAttribute('aria-selected', 'true');

  document.querySelectorAll('.pane').forEach(p => p.classList.remove('on'));
  const pane = document.getElementById(tabId);
  if (pane) pane.classList.add('on');

  const tabsContainer = document.querySelector('.tabs');
  if (tabsContainer) tabsContainer.scrollTop = 0;
}

function toggleMiniPlayer() {
  const stage = document.getElementById('stage');
  const btn = document.getElementById('shrink');
  if (!stage) return;

  const isMini = stage.classList.toggle('mini');
  if (btn) btn.textContent = isMini ? 'Expand video' : 'Shrink video';
}

window.addEventListener('DOMContentLoaded', () => {
  if (window.innerHeight < 700) {
    const stage = document.getElementById('stage');
    const btn = document.getElementById('shrink');
    if (stage) stage.classList.add('mini');
    if (btn) btn.textContent = 'Expand video';
  }
});

// 2. WEB AUDIO & TALKING CUES
function initAudioContext() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function attachAudioAnalyser(id, stream) {
  if (!audioCtx) return;
  try {
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);

    audioAnalysers[id] = {
      analyser,
      dataArray: new Uint8Array(analyser.frequencyBinCount)
    };

    if (!audioAnimFrame) {
      processAudioVolumes();
    }
  } catch (err) {
    console.warn("Error attaching audio analyser:", err);
  }
}

function removeAudioAnalyser(id) {
  delete audioAnalysers[id];
}

function processAudioVolumes() {
  let anyRiderTalking = false;
  const TALKING_THRESHOLD = 25;

  Object.entries(audioAnalysers).forEach(([id, obj]) => {
    obj.analyser.getByteFrequencyData(obj.dataArray);
    let sum = 0;
    for (let i = 0; i < obj.dataArray.length; i++) {
      sum += obj.dataArray[i];
    }
    const average = sum / obj.dataArray.length;

    const riderElem = document.querySelector(`[data-user-id="${id}"]`);
    const riderName = riderElem?.getAttribute('data-user-name') || "Rider";

    if (average > TALKING_THRESHOLD) {
      anyRiderTalking = true;
      activeTalkers.set(id, riderName.split(" ")[0]);
      if (riderElem) riderElem.classList.add('talking');
    } else {
      activeTalkers.delete(id);
      if (riderElem) riderElem.classList.remove('talking');
    }
  });

  // Update Talk Bar Text & Cues
  const talkBar = document.getElementById('talkbar');
  const talkText = document.getElementById('talktext');
  if (talkBar && talkText) {
    const names = Array.from(activeTalkers.values());
    if (names.length > 0) {
      talkBar.classList.add('on');
      talkText.textContent = names.join(' and ') + ' talking';
    } else {
      talkBar.classList.remove('on');
      talkText.textContent = 'Nobody is talking';
    }
  }

  // Smooth Music Ducking
  const enableDucking = document.getElementById("chk-ducking")?.checked;
  if (enableDucking) {
    if (anyRiderTalking) {
      if (duckTimeout) clearTimeout(duckTimeout);
      duckTimeout = null;
      if (!isDucked) {
        isDucked = true;
        if (player && player.getVolume) baseMusicVolume = player.getVolume() || 100;
        targetMusicVolume = Math.round(baseMusicVolume * 0.25);
        smoothSetVolume(targetMusicVolume);
      }
    } else if (isDucked && !duckTimeout) {
      duckTimeout = setTimeout(() => {
        isDucked = false;
        targetMusicVolume = baseMusicVolume;
        smoothSetVolume(targetMusicVolume);
        duckTimeout = null;
      }, 500);
    }
  }

  audioAnimFrame = requestAnimationFrame(processAudioVolumes);
}

function smoothSetVolume(target) {
  if (!player || !player.getVolume || !player.setVolume) return;
  const current = player.getVolume();
  if (Math.abs(current - target) <= 2) {
    player.setVolume(target);
    return;
  }
  const step = current < target ? 2 : -2;
  player.setVolume(current + step);
  setTimeout(() => smoothSetVolume(target), 20);
}

// 3. QUICK SIGNALS & SYNTHESIZED CHIME
function playSynthesizedChime() {
  if (!audioCtx) return;

  const now = audioCtx.currentTime;
  const osc1 = audioCtx.createOscillator();
  const osc2 = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc1.type = 'sine';
  osc2.type = 'sine';

  osc1.frequency.setValueAtTime(660, now);
  osc2.frequency.setValueAtTime(880, now + 0.15);

  gain.gain.setValueAtTime(0.3, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(audioCtx.destination);

  osc1.start(now);
  osc1.stop(now + 0.15);
  osc2.start(now + 0.15);
  osc2.stop(now + 0.4);
}

function sendSignal(type) {
  if (!currentRoomCode) return;
  socket.emit('send-quick-signal', { roomCode: currentRoomCode, signalType: type });
}

socket.on('receive-quick-signal', ({ senderName, signalType }) => {
  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = `${senderName.split(" ")[0]}: ${signalType}`;
    toast.classList.add('on');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('on'), 4000);
  }

  playSynthesizedChime();

  if (player && player.setVolume && player.getVolume) {
    baseMusicVolume = player.getVolume() || 100;
    player.setVolume(Math.round(baseMusicVolume * 0.2));
    setTimeout(() => {
      if (!isDucked) player.setVolume(baseMusicVolume);
    }, 2000);
  }
});

// 4. SESSION RESTORATION & AUTH
function getSavedRoomCode() {
  const urlParams = new URLSearchParams(window.location.search);
  const roomFromUrl = urlParams.get('room')?.toUpperCase();
  if (roomFromUrl && roomFromUrl.length === 6) return roomFromUrl;
  return localStorage.getItem('rj:lastRoom')?.toUpperCase() || null;
}

function saveRoomSession(code) {
  localStorage.setItem('rj:lastRoom', code);
  history.replaceState(null, '', `/?room=${code}`);
}

function clearRoomSession() {
  localStorage.removeItem('rj:lastRoom');
  history.replaceState(null, '', '/');
}

window.supabaseClient.auth.onAuthStateChange(async (event, session) => {
  if (session) {
    currentUser = session.user;
    const name = currentUser.user_metadata.full_name || currentUser.email;
    const nameElem = document.getElementById("user-display-name");
    const avatarElem = document.getElementById("user-avatar");
    if (nameElem) nameElem.innerText = name;
    if (avatarElem) avatarElem.innerText = getInitials(name);

    const savedRoom = getSavedRoomCode();
    if (savedRoom) {
      joinSocketRoom(savedRoom);
    } else {
      switchScreen("s-lobby");
    }
  } else {
    currentUser = null;
    clearRoomSession();
    switchScreen("s-login");
  }
});

async function loginWithGoogle() {
  await window.supabaseClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href }
  });
}

async function logout() {
  clearRoomSession();
  await window.supabaseClient.auth.signOut();
}

// 5. LOBBY & RECONNECT
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
  saveRoomSession(roomCode);

  const userId = currentUser ? currentUser.id : "guest";
  const userName = currentUser ? (currentUser.user_metadata.full_name || currentUser.email) : "Rider";

  socket.emit("join-room", { roomCode, userId, userName });

  const displayElem = document.getElementById("display-room-code");
  if (displayElem) displayElem.innerText = roomCode;

  const rejoinBtn = document.getElementById("btn-rejoin-audio");
  if (rejoinBtn) rejoinBtn.style.display = audioUnlocked ? "none" : "block";
}

socket.on('connect', () => {
  const statusElem = document.getElementById("status");
  if (statusElem) {
    statusElem.innerText = "Connected";
    setTimeout(() => {
      if (statusElem.innerText === "Connected") statusElem.innerText = "";
    }, 2500);
  }

  if (currentRoomCode && currentUser) {
    joinSocketRoom(currentRoomCode);
  }
});

socket.on('disconnect', () => {
  const statusElem = document.getElementById("status");
  if (statusElem) statusElem.innerText = "Reconnecting";
});

window.addEventListener('online', () => {
  if (!socket.connected) socket.connect();
});

socket.on('room-not-found', () => {
  clearRoomSession();
  currentRoomCode = null;
  switchScreen("s-lobby");
  const errElem = document.getElementById("lobby-error-msg");
  if (errElem) {
    errElem.innerText = "That ride has ended. Create a new lobby or join another.";
    errElem.style.display = "block";
  }
});

function copyRoomCode() {
  if (!currentRoomCode) return;
  const shareUrl = `${window.location.origin}/?room=${currentRoomCode}`;
  navigator.clipboard?.writeText(shareUrl);
  const chipSpan = document.querySelector('#copy span');
  if (chipSpan) {
    chipSpan.textContent = 'Copied';
    setTimeout(() => chipSpan.textContent = 'Copy link', 1500);
  }
}

function leaveLobby() {
  clearRoomSession();
  if (audioAnimFrame) cancelAnimationFrame(audioAnimFrame);
  if (localStream) localStream.getTracks().forEach(track => track.stop());
  location.href = window.location.origin;
}

// 6. WEBRTC & PUSH-TO-TALK
async function rejoinAudioAndMedia() {
  audioUnlocked = true;
  const rejoinBtn = document.getElementById("btn-rejoin-audio");
  if (rejoinBtn) rejoinBtn.style.display = "none";

  initAudioContext();

  if (player && player.playVideo && currentTrack) {
    player.playVideo();
  }

  await initWebRTC();
}

async function initWebRTC() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStream.getAudioTracks()[0].enabled = false;

    if (currentUser) {
      attachAudioAnalyser(currentUser.id, localStream);
    }
  } catch (err) {
    console.warn("Microphone access declined or delayed:", err);
  }

  socket.on("user-joined-webrtc", ({ socketId, userId }) => createPeerConnection(socketId, userId, true));
  socket.on("webrtc-offer", async ({ senderId, offer }) => {
    const pc = createPeerConnection(senderId, senderId, false);
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
    removeAudioAnalyser(socketId);
    const elem = document.getElementById(`audio-${socketId}`);
    if (elem) elem.remove();
  });
}

function createPeerConnection(targetSocketId, userId, isInitiator) {
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
      const audioContainer = document.getElementById("audio-streams");
      if (audioContainer) audioContainer.appendChild(remoteAudio);
    }
    remoteAudio.srcObject = event.streams[0];
    attachAudioAnalyser(userId, event.streams[0]);
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

const setTalkingState = async (isTalking) => {
  initAudioContext();
  audioUnlocked = true;

  const rejoinBtn = document.getElementById("btn-rejoin-audio");
  if (rejoinBtn) rejoinBtn.style.display = "none";

  if (!localStream || !localStream.getAudioTracks()[0]) {
    await initWebRTC();
  }

  if (localStream && localStream.getAudioTracks()[0]) {
    localStream.getAudioTracks()[0].enabled = isTalking;
  }

  if (talkBtn) {
    talkBtn.classList.toggle('live', isTalking);
    talkBtn.setAttribute('aria-pressed', isTalking);
    talkBtn.textContent = isTalking ? 'Talking' : 'Hold to talk';
  }
};

if (talkBtn) {
  ['pointerdown'].forEach(ev => talkBtn.addEventListener(ev, e => { e.preventDefault(); setTalkingState(true); }));
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => talkBtn.addEventListener(ev, () => setTalkingState(false)));
}

// 7. ROOM STATE RESTORATION
socket.on('full-room-state', ({ roomCode, hostUserId, currentTrack: track, currentPosition, isPlaying, queue, serverTimestamp }) => {
  switchScreen("s-room");

  if (track) {
    currentTrack = track;
    const titleElem = document.getElementById("np-title");
    const byElem = document.getElementById("np-by");
    if (titleElem) titleElem.innerText = track.title;
    if (byElem) byElem.innerText = `${track.channel} — added by ${track.addedBy}`;

    const placeholder = document.getElementById("ph");
    if (placeholder) placeholder.style.display = "none";

    const latencyOffset = (Date.now() - serverTimestamp) / 1000;
    const adjustedPosition = currentPosition + latencyOffset;

    if (player && player.loadVideoById) {
      player.loadVideoById(track.id, adjustedPosition);
      if (player.playVideo) player.playVideo();
    }
  }
});

socket.on('room-state-update', (state) => {
  isHost = state.hostUserId === (currentUser ? currentUser.id : null);

  const ridersContainer = document.getElementById('riders');
  if (ridersContainer) {
    ridersContainer.innerHTML = state.riders.map(r => `
      <div class="rider" data-user-id="${r.userId}" data-user-name="${r.name}" style="${r.status === 'reconnecting' ? 'opacity:0.5;' : ''}">
        <div class="avatar">${getInitials(r.name)}</div>
        <span class="rname">${r.name.split(" ")[0]}</span>
        <span class="bars"><b></b><b></b><b></b></span>
      </div>
    `).join('');
  }

  const skipBtn = document.getElementById('skip');
  if (skipBtn) {
    if (state.currentTrack) {
      skipBtn.style.display = 'inline-flex';
      skipBtn.innerText = isHost ? 'Skip (Host)' : `Vote skip ${state.skipVotes}/${state.votesNeeded}`;
    } else {
      skipBtn.style.display = 'none';
    }
  }

  renderQueue(state.queue);
});

function renderQueue(queue) {
  const container = document.getElementById('queue');
  const qn = document.getElementById('qn');
  const qcount = document.getElementById('qcount');

  if (qn) qn.textContent = queue.length;
  if (qcount) qcount.textContent = queue.length ? queue.length + ' songs' : '';

  if (!container) return;

  if (queue.length > 0) {
    container.innerHTML = queue.map((t, i) => `
      <div class="item">
        <div class="thumb" style="background-image: url('https://img.youtube.com/vi/${t.id}/hqdefault.jpg')"></div>
        <div class="m">
          <div class="t">${t.title}</div>
          <div class="s">${t.channel} · added by ${t.addedBy}</div>
        </div>
        ${(isHost || (currentUser && t.addedBy === currentUser.user_metadata?.full_name)) ? `<button class="sm" onclick="removeQueueItem(${i})">Remove</button>` : ''}
      </div>
    `).join('');
  } else {
    container.innerHTML = '<div class="empty">Nothing queued. Open Search to add a song.</div>';
  }
}

function removeQueueItem(index) {
  if (currentRoomCode) {
    socket.emit('remove-queue-item', { roomCode: currentRoomCode, index });
  }
}

// 8. PLAYER CONTROLS
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
      const nowElem = document.getElementById('t-now');
      const lenElem = document.getElementById('t-len');
      const barElem = document.getElementById('bar');
      if (nowElem) nowElem.innerText = fmt(cur);
      if (lenElem) lenElem.innerText = fmt(dur);
      if (barElem) barElem.style.width = (cur / dur * 100) + '%';
    }
  }
}, 1000);

socket.on('play-track', ({ track, currentTime, serverTimestamp }) => {
  currentTrack = track;
  const titleElem = document.getElementById("np-title");
  const byElem = document.getElementById("np-by");
  if (titleElem) titleElem.innerText = track.title;
  if (byElem) byElem.innerText = `${track.channel} — added by ${track.addedBy}`;

  const placeholder = document.getElementById("ph");
  if (placeholder) placeholder.style.display = "none";

  const latencyOffset = (Date.now() - serverTimestamp) / 1000;
  const adjustedTime = currentTime + latencyOffset;

  if (player && player.loadVideoById) {
    player.loadVideoById(track.id, adjustedTime);
    if (player.playVideo) player.playVideo();
  }
});

socket.on('queue-empty', () => {
  currentTrack = null;
  const titleElem = document.getElementById("np-title");
  const byElem = document.getElementById("np-by");
  const barElem = document.getElementById("bar");
  const nowElem = document.getElementById("t-now");
  const lenElem = document.getElementById("t-len");

  if (titleElem) titleElem.innerText = "Nothing playing";
  if (byElem) byElem.innerText = "Add a song from Search";
  if (barElem) barElem.style.width = '0%';
  if (nowElem) nowElem.innerText = "0:00";
  if (lenElem) lenElem.innerText = "0:00";

  const placeholder = document.getElementById("ph");
  if (placeholder) placeholder.style.display = "grid";
});

socket.on('sync-time', ({ currentTime, serverTimestamp }) => {
  if (!isHost && player && player.getCurrentTime) {
    const latencyOffset = (Date.now() - serverTimestamp) / 1000;
    const targetTime = currentTime + latencyOffset;
    if (Math.abs(player.getCurrentTime() - targetTime) > 1.5) {
      player.seekTo(targetTime, true);
    }
  }
});

function voteSkip() {
  if (currentRoomCode) {
    socket.emit('vote-skip', { roomCode: currentRoomCode });
  }
}

// 9. CLEARABLE SEARCH
function syncSearchClear() {
  const q = document.getElementById("q");
  const clr = document.getElementById("clr");
  if (clr && q) {
    clr.classList.toggle("on", !!q.value);
  }
}

function clearSearch() {
  const q = document.getElementById("q");
  const resultsContainer = document.getElementById("results");
  const rhead = document.getElementById("rhead");

  if (q) q.value = '';
  if (resultsContainer) resultsContainer.innerHTML = '<div class="empty">Search for a song to add it to the queue.</div>';
  if (rhead) rhead.hidden = true;

  syncSearchClear();
  if (q) q.focus();
}

const searchInput = document.getElementById("q");
if (searchInput) {
  searchInput.addEventListener('input', syncSearchClear);
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') clearSearch();
  });
}

async function searchYouTube() {
  const q = document.getElementById("q");
  const query = q?.value.trim();
  if (!query) return;

  q.blur();

  try {
    const response = await fetch(`${SERVER_URL}/api/search-youtube?q=${encodeURIComponent(query)}`);
    const data = await response.json();

    if (data.error) return alert(data.error);

    const resultsContainer = document.getElementById("results");
    const rhead = document.getElementById("rhead");

    if (rhead) rhead.hidden = false;
    if (!resultsContainer) return;

    resultsContainer.innerHTML = "";

    data.forEach(video => {
      const item = document.createElement("div");
      item.className = "item";
      item.innerHTML = `
        <div class="thumb" style="background-image: url('${video.snippet.thumbnails.default.url}')"></div>
        <div class="m">
          <div class="t">${video.snippet.title}</div>
          <div class="s">${video.snippet.channelTitle}</div>
        </div>
        <button class="sm add" onclick="addToQueue('${video.id.videoId}', '${video.snippet.title.replace(/'/g, "\\'")}', '${video.snippet.channelTitle.replace(/'/g, "\\'")}', this)">Add</button>
      `;
      resultsContainer.appendChild(item);
    });

    syncSearchClear();
  } catch (err) {
    const resultsContainer = document.getElementById("results");
    if (resultsContainer) {
      resultsContainer.innerHTML = '<div class="empty">Search is unavailable right now. Try again later.</div>';
    }
  }
}

function addToQueue(videoId, videoTitle, channelTitle, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Added";
  }
  socket.emit("add-to-queue", { roomCode: currentRoomCode, videoId, videoTitle, channelTitle });
}

// 10. REAL MIC CHECK DIAGNOSTICS
async function toggleMicTest() {
  const btn = document.getElementById("mtest");
  const st = document.getElementById("mstat");
  const dev = document.getElementById("mdev");
  const lvl = document.getElementById("lvl");

  if (micTestObj) {
    stopMicTest();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;

    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let peak = 0;

    micTestObj = { stream, ctx, raf: 0, timer: null };

    if (btn) btn.textContent = 'Stop mic test';
    if (dev) dev.textContent = 'Using: ' + (stream.getAudioTracks()[0].label || 'default microphone');
    if (st) {
      st.className = 'status';
      st.textContent = 'Listening. Say something.';
    }

    function loop() {
      analyser.getByteTimeDomainData(buf);
      let max = 0;
      for (const v of buf) {
        max = Math.max(max, Math.abs(v - 128));
      }
      const level = max / 128;
      peak = Math.max(peak, level);

      if (lvl) lvl.style.width = Math.min(100, level * 220) + '%';

      if (peak > 0.06 && st) {
        st.className = 'status ok';
        st.textContent = 'Mic is working. We can hear you.';
      }

      if (micTestObj) micTestObj.raf = requestAnimationFrame(loop);
    }

    loop();

    micTestObj.timer = setTimeout(() => {
      if (peak <= 0.06 && st) {
        st.className = 'status bad';
        st.textContent = 'We heard nothing. Check the mute switch on your headset or choose another mic in your phone settings.';
      }
      stopMicTest(true);
    }, 12000);

  } catch (err) {
    if (st) {
      st.className = 'status bad';
      st.textContent = err.name === 'NotAllowedError'
        ? 'Mic is blocked. Allow microphone for this site in your browser settings, then try again.'
        : 'No microphone found. Connect a headset or check your Bluetooth device.';
    }
  }
}

function stopMicTest(keepStatusMessage) {
  if (!micTestObj) return;

  cancelAnimationFrame(micTestObj.raf);
  clearTimeout(micTestObj.timer);

  micTestObj.stream.getTracks().forEach(t => t.stop());
  micTestObj.ctx.close();
  micTestObj = null;

  const lvl = document.getElementById("lvl");
  const btn = document.getElementById("mtest");
  const st = document.getElementById("mstat");

  if (lvl) lvl.style.width = '0%';
  if (btn) btn.textContent = 'Start mic test';
  if (!keepStatusMessage && st) {
    st.className = 'status';
    st.textContent = 'Test stopped.';
  }
}