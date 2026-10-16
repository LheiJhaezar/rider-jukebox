const SERVER_URL = "https://rider-jukebox.onrender.com";
const socket = io(SERVER_URL, {
  transports: ["polling", "websocket"],
  secure: true,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 15000
});

const SUPABASE_URL = "https://kfanbcvigynrohzdyecw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_nbZ0GPA4G1XcGgYuAtNTNQ_rW5TuQIq"; // Place actual key here

window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentRoomCode = null;
let player = null;
let localStream = null;
let peerConnections = {};

let isHost = false;
let currentTrack = null;
let audioUnlocked = false;

// Web Audio & Talking Cues
let audioCtx = null;
let audioAnalysers = {};
let audioAnimFrame = null;
let targetMusicVolume = 100;
let baseMusicVolume = 100;
let userVolume = 100;
let isDucked = false;
let duckTimeout = null;
let toastTimeout = null;

let activeTalkers = new Map();
let micTestObj = null;

// Ready Check & Wake Lock
let readyDone = false;
let wakeLock = null;

// ===== VOICE (WebRTC) SETUP =====
let ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
async function loadIceServers() {
  try {
    const r = await fetch(`${SERVER_URL}/api/ice-servers`);
    if (r.ok) {
      const list = await r.json();
      if (Array.isArray(list) && list.length) ICE_SERVERS = list;
    }
  } catch (e) {
    console.warn("[voice] could not load ICE servers, using STUN only", e);
  }
}
const iceReady = loadIceServers();
let micError = null;

const pendingIce = {};
const peerUser = {};
let micPromise = null;
let wantTalk = false;

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
  if (!audioCtx || !id) return;
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

  const talkBar = document.getElementById('talkbar');
  const talkText = document.getElementById('talktext');
  const rline = document.getElementById('rline');
  const rtxt = document.getElementById('rtxt');

  const names = Array.from(activeTalkers.values());
  const statusStr = names.length ? names.join(' and ') + ' talking' : 'Nobody is talking';

  if (talkBar && talkText) {
    talkBar.classList.toggle('on', names.length > 0);
    talkText.textContent = statusStr;
  }
  if (rline && rtxt) {
    rline.classList.toggle('on', names.length > 0);
    rtxt.textContent = statusStr;
  }

  const enableDucking = document.getElementById("chk-ducking")?.checked;
  if (enableDucking) {
    if (anyRiderTalking) {
      if (duckTimeout) clearTimeout(duckTimeout);
      duckTimeout = null;
      if (!isDucked) {
        isDucked = true;
        if (player && player.getVolume) baseMusicVolume = player.getVolume() || userVolume;
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
  if (navigator.vibrate) navigator.vibrate(30);
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
    baseMusicVolume = player.getVolume() || userVolume;
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
  sessionStorage.removeItem('rj:rideMode');
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
  const rcodeElem = document.getElementById("rcode");
  if (displayElem) displayElem.innerText = roomCode;
  if (rcodeElem) rcodeElem.innerText = roomCode;

  const rejoinBtn = document.getElementById("btn-rejoin-audio");
  if (rejoinBtn) rejoinBtn.style.display = audioUnlocked ? "none" : "block";

  if (!readyDone) {
    document.getElementById("ready").hidden = false;
  }
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

// ===== 6. VOICE (WebRTC) =====
function getMic() {
  if (localStream) return Promise.resolve(localStream);
  if (micPromise) return micPromise;
  initAudioContext();
  micPromise = navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
    .then(stream => {
      localStream = stream;
      micError = null;
      updateMicPills('ok');
      const track = stream.getAudioTracks()[0];
      if (track) track.enabled = wantTalk;
      if (currentUser) attachAudioAnalyser(currentUser.id, stream);
      Object.values(peerConnections).forEach(attachMicToPeer);
      return stream;
    })
    .catch(err => {
      micPromise = null;
      micError = err.name;
      updateMicPills(err.name === 'NotAllowedError' ? 'blocked' : 'off');
      console.warn("Microphone unavailable:", err.name, err.message);
      return null;
    });
  return micPromise;
}

function updateMicPills(state) {
  const c = document.getElementById('micchip');
  const r = document.getElementById('rmic');
  const map = {
    ok: ['Mic ready', 'pill ok'],
    off: ['Mic not set up', 'pill bad'],
    blocked: ['Mic blocked', 'pill bad']
  };
  const val = map[state] || map.off;
  if (c) { c.textContent = val[0]; c.className = val[1]; }
  if (r) { r.textContent = val[0]; r.className = val[1]; }
}

function attachMicToPeer(pc) {
  const track = localStream && localStream.getAudioTracks()[0];
  if (track && pc._sender) {
    pc._sender.replaceTrack(track).catch(e => console.warn("replaceTrack failed", e));
  }
}

function closePeer(remoteId) {
  const pc = peerConnections[remoteId];
  if (pc) { pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null; pc.close(); }
  delete peerConnections[remoteId];
  delete pendingIce[remoteId];
  if (peerUser[remoteId]) removeAudioAnalyser(peerUser[remoteId]);
  delete peerUser[remoteId];
  const elem = document.getElementById(`audio-${remoteId}`);
  if (elem) elem.remove();
  updateVoicePill();
}

function createPeer(remoteId, remoteUserId) {
  if (peerConnections[remoteId]) closePeer(remoteId);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peerConnections[remoteId] = pc;
  pendingIce[remoteId] = [];
  peerUser[remoteId] = remoteUserId;

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit("webrtc-ice-candidate", { targetId: remoteId, candidate: e.candidate });
  };

  pc.ontrack = e => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    let audio = document.getElementById(`audio-${remoteId}`);
    if (!audio) {
      audio = document.createElement("audio");
      audio.id = `audio-${remoteId}`;
      audio.autoplay = true;
      audio.playsInline = true;
      (document.getElementById("audio-streams") || document.body).appendChild(audio);
    }
    audio.srcObject = stream;
    if (audioUnlocked) audio.play().catch(() => {});
    attachAudioAnalyser(remoteUserId, stream);
  };

  pc.onconnectionstatechange = () => {
    console.log("[voice]", remoteId, pc.connectionState);
    updateVoicePill();
    if (pc.connectionState === "failed") {
      if (!pc._restarted) {
        pc._restarted = true;
        try { pc.restartIce(); } catch (e) { closePeer(remoteId); }
      } else closePeer(remoteId);
    }
  };
  pc.oniceconnectionstatechange = () => console.log("[voice] ice", remoteId, pc.iceConnectionState);

  return pc;
}

async function callPeer(remoteId, remoteUserId) {
  await iceReady;
  const pc = createPeer(remoteId, remoteUserId);
  const tx = pc.addTransceiver("audio", { direction: "sendrecv" });
  pc._sender = tx.sender;
  attachMicToPeer(pc);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("webrtc-offer", { targetId: remoteId, offer: pc.localDescription });
}

async function flushIce(remoteId) {
  const pc = peerConnections[remoteId];
  const list = pendingIce[remoteId] || [];
  pendingIce[remoteId] = [];
  for (const c of list) { try { await pc.addIceCandidate(c); } catch (e) { console.warn("ICE add failed", e); } }
}

socket.on("user-joined-webrtc", ({ socketId, userId }) => {
  callPeer(socketId, userId).catch(e => console.warn("call failed", e));
});

socket.on("webrtc-offer", async ({ senderId, senderUserId, offer }) => {
  try {
    await iceReady;
    const pc = createPeer(senderId, senderUserId || senderId);
    await pc.setRemoteDescription(offer);
    const tx = pc.getTransceivers().find(t => t.receiver && t.receiver.track && t.receiver.track.kind === "audio");
    if (tx) { tx.direction = "sendrecv"; pc._sender = tx.sender; attachMicToPeer(pc); }
    await flushIce(senderId);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("webrtc-answer", { targetId: senderId, answer: pc.localDescription });
  } catch (e) { console.warn("offer handling failed", e); }
});

socket.on("webrtc-answer", async ({ senderId, answer }) => {
  const pc = peerConnections[senderId];
  if (!pc) return;
  try { await pc.setRemoteDescription(answer); await flushIce(senderId); }
  catch (e) { console.warn("answer handling failed", e); }
});

socket.on("webrtc-ice-candidate", async ({ senderId, candidate }) => {
  const pc = peerConnections[senderId];
  if (!pc || !candidate) return;
  if (pc.remoteDescription) { try { await pc.addIceCandidate(candidate); } catch (e) { console.warn(e); } }
  else (pendingIce[senderId] = pendingIce[senderId] || []).push(candidate);
});

socket.on("user-disconnected-webrtc", ({ socketId }) => closePeer(socketId));

function unlockRemoteAudio() {
  document.querySelectorAll("#audio-streams audio, audio[id^='audio-']").forEach(a => a.play().catch(() => {}));
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && audioUnlocked) {
    unlockRemoteAudio();
    if (!document.getElementById('ride').hidden) requestRideWakeLock();
  }
});

async function rejoinAudioAndMedia() {
  audioUnlocked = true;
  const btn = document.getElementById("btn-rejoin-audio");
  if (btn) btn.style.display = "none";
  initAudioContext();
  unlockRemoteAudio();
  if (player && player.playVideo && currentTrack) player.playVideo();
  try { await getMic(); } catch (e) {}
}

const talkBtns = ['#talk', '#rtalk'];

// Mic mode: "hold" = push-to-talk (original), "toggle" = tap once to talk, tap again to mute
let talkMode = 'hold';
try { if (localStorage.getItem('rj:talkMode') === 'toggle') talkMode = 'toggle'; } catch (e) {}

const talkLabel = (live) => talkMode === 'toggle'
  ? (live ? 'Tap to mute' : 'Tap to talk')
  : (live ? 'Talking' : 'Hold to talk');

function refreshTalkUI() {
  talkBtns.forEach(id => {
    const b = document.querySelector(id);
    if (b) {
      b.classList.toggle('live', wantTalk);
      b.setAttribute('aria-pressed', wantTalk);
      b.textContent = talkLabel(wantTalk);
    }
  });
  document.querySelectorAll('[data-talkmode]').forEach(s => {
    s.setAttribute('aria-pressed', s.dataset.talkmode === talkMode);
  });
}

function setTalkMode(mode) {
  talkMode = mode === 'toggle' ? 'toggle' : 'hold';
  try { localStorage.setItem('rj:talkMode', talkMode); } catch (e) {}
  setTalkingState(false); // always start muted after switching modes
  refreshTalkUI();
}

const setTalkingState = async (isTalking) => {
  wantTalk = isTalking;
  initAudioContext();
  audioUnlocked = true;
  unlockRemoteAudio();

  const btn = document.getElementById("btn-rejoin-audio");
  if (btn) btn.style.display = "none";

  if (isTalking && !localStream) {
    try { await getMic(); } catch (e) {}
  }

  const track = localStream && localStream.getAudioTracks()[0];
  if (track) track.enabled = wantTalk;

  talkBtns.forEach(id => {
    const b = document.querySelector(id);
    if (b) {
      b.classList.toggle("live", wantTalk);
      b.setAttribute("aria-pressed", wantTalk);
      b.textContent = talkLabel(wantTalk);
    }
  });

  if (navigator.vibrate && (isTalking || talkMode === 'toggle')) navigator.vibrate(isTalking ? 15 : [10, 40, 10]);
};

talkBtns.forEach(id => {
  const b = document.querySelector(id);
  if (b) {
    b.addEventListener("pointerdown", e => {
      e.preventDefault();
      setTalkingState(talkMode === 'toggle' ? !wantTalk : true);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(ev => b.addEventListener(ev, () => {
      if (talkMode === 'hold') setTalkingState(false); // toggle mode ignores release
    }));
  }
});

document.querySelectorAll('[data-talkmode]').forEach(s => {
  s.addEventListener('click', () => setTalkMode(s.dataset.talkmode));
});
refreshTalkUI();

function updateVoicePill() {
  const pill = document.getElementById('vchip');
  if (!pill) return;

  const connectedPeers = Object.values(peerConnections).filter(pc => pc.connectionState === 'connected').length;
  const totalPeers = Object.keys(peerConnections).length + 1;

  if (connectedPeers > 0) {
    pill.textContent = `Voice: ${connectedPeers + 1} of ${totalPeers} linked`;
    pill.className = 'pill ok';
  } else {
    pill.textContent = `Voice: waiting`;
    pill.className = 'pill';
  }
}

// Diagnostics Exporter
async function copyDiagnostics() {
  const peers = {};
  for (const [id, pc] of Object.entries(peerConnections)) {
    let candidateType = null;
    try {
      const stats = await pc.getStats();
      stats.forEach(r => {
        if (r.type === "transport" && r.selectedCandidatePairId) {
          const pair = stats.get(r.selectedCandidatePairId);
          const local = pair && stats.get(pair.localCandidateId);
          if (local) candidateType = local.candidateType;
        }
      });
    } catch (e) {}
    peers[id] = {
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      signalingState: pc.signalingState,
      candidateType,
      directions: pc.getTransceivers().map(t => t.currentDirection)
    };
  }
  const t = localStream && localStream.getAudioTracks()[0];
  const text = JSON.stringify({
    userAgent: navigator.userAgent,
    micError,
    track: t ? { readyState: t.readyState, muted: t.muted, enabled: t.enabled } : null,
    peers
  }, null, 2);
  try { await navigator.clipboard.writeText(text); } catch (e) {}
  return text;
}

async function copyDiagnosticsHandler(btn) {
  const diag = await copyDiagnostics();
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => btn.textContent = orig, 2000);
  }
}

// 7. READY CHECK OVERLAY
function updateReadyStep(id, ok, text) {
  const e = document.querySelector(id);
  if (e) {
    e.className = 'step ' + (ok ? 'ok' : 'bad');
    const span = e.querySelector('span');
    if (span) span.textContent = text;
  }
}

async function runReadyCheck() {
  const msg = document.getElementById('rmsg');
  const btn = document.getElementById('rgo');

  initAudioContext();
  unlockRemoteAudio();
  updateReadyStep('#st-audio', true, 'On');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;

    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let heard = false;
    let raf = null;

    updateReadyStep('#st-mic', false, 'Say something');
    if (msg) msg.textContent = 'Say something. The bar should move.';

    function loop() {
      analyser.getByteTimeDomainData(buf);
      let max = 0;
      for (const v of buf) max = Math.max(max, Math.abs(v - 128));
      const rlvl = document.getElementById('rlvl');
      if (rlvl) rlvl.style.width = Math.min(100, (max / 128) * 220) + '%';

      if ((max / 128) > 0.06 && !heard) {
        heard = true;
        updateReadyStep('#st-mic', true, 'Working');
        if (msg) msg.textContent = 'Your mic works.';
        updateMicPills('ok');
        if (btn) {
          btn.textContent = 'Done';
          btn.onclick = finishReady;
        }
      }
      raf = requestAnimationFrame(loop);
    }

    loop();

    setTimeout(() => {
      cancelAnimationFrame(raf);
      stream.getTracks().forEach(t => t.stop());
      ctx.close();
      if (!heard) {
        updateReadyStep('#st-mic', false, 'No sound heard');
        if (msg) msg.textContent = 'We heard nothing. Check the mute switch on your headset, or pick another mic in your phone settings.';
        updateMicPills('off');
      }
    }, 10000);

  } catch (err) {
    updateReadyStep('#st-mic', false, err.name === 'NotAllowedError' ? 'Blocked' : 'Not found');
    updateMicPills('blocked');
    if (msg) {
      msg.textContent = err.name === 'NotAllowedError'
        ? 'Mic is blocked. Allow microphone for this site in your browser settings, then tap the button again.'
        : 'No microphone found. Connect a headset or check your Bluetooth device.';
    }
  }
}

function finishReady() {
  readyDone = true;
  document.getElementById('ready').hidden = true;
  updateReadyStep('#st-link', true, 'Linked');
}

function skipReadyCheck() {
  readyDone = true;
  document.getElementById('ready').hidden = true;
}

// 8. RIDE MODE
async function requestRideWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) {
    const rnote = document.getElementById('rnote');
    if (rnote) rnote.textContent = 'Could not keep the screen on. Change your phone sleep setting.';
  }
}

function openRideMode() {
  document.getElementById('ride').hidden = false;
  sessionStorage.setItem('rj:rideMode', 'on');
  requestRideWakeLock();
}

function closeRideMode() {
  document.getElementById('ride').hidden = true;
  sessionStorage.removeItem('rj:rideMode');
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function changeVolume(delta) {
  if (!player || !player.getVolume || !player.setVolume) return;
  userVolume = Math.max(0, Math.min(100, userVolume + delta));
  player.setVolume(userVolume);

  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = `Music volume ${userVolume}%`;
    toast.classList.add('on');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('on'), 1200);
  }
}

// 9. ROOM STATE RESTORATION
socket.on('full-room-state', ({ roomCode, hostUserId, currentTrack: track, currentPosition, isPlaying, queue, serverTimestamp }) => {
  switchScreen("s-room");

  if (sessionStorage.getItem('rj:rideMode') === 'on') {
    openRideMode();
  }

  if (track) {
    currentTrack = track;
    const titleElem = document.getElementById("np-title");
    const byElem = document.getElementById("np-by");
    const rtitle = document.getElementById("rtitle");
    const rby = document.getElementById("rby");

    if (titleElem) titleElem.innerText = track.title;
    if (byElem) byElem.innerText = `${track.channel} — added by ${track.addedBy}`;
    if (rtitle) rtitle.innerText = track.title;
    if (rby) rby.innerText = `${track.channel} — added by ${track.addedBy}`;

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
        <span class="rstat">${r.status === 'reconnecting' ? 'Reconnecting' : (r.isHost ? 'Host' : 'Linked')}</span>
      </div>
    `).join('');
  }

  const skipBtn = document.getElementById('skip');
  const skip2Btn = document.getElementById('skip2');
  const skipTxt = isHost ? 'Skip (Host)' : `Vote skip ${state.skipVotes}/${state.votesNeeded}`;

  if (skipBtn) {
    skipBtn.style.display = state.currentTrack ? 'inline-flex' : 'none';
    skipBtn.innerText = skipTxt;
  }
  if (skip2Btn) skip2Btn.innerText = skipTxt;

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
        ${(isHost || (currentUser && t.addedBy === (currentUser.user_metadata?.full_name || currentUser.email))) ? `<button class="sm" onclick="removeQueueItem(${i})">Remove</button>` : ''}
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

// 10. PLAYER CONTROLS
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
      const pct = (cur / dur * 100) + '%';
      const nowElem = document.getElementById('t-now');
      const lenElem = document.getElementById('t-len');
      const barElem = document.getElementById('bar');
      const rbarElem = document.getElementById('rbar');

      if (nowElem) nowElem.innerText = fmt(cur);
      if (lenElem) lenElem.innerText = fmt(dur);
      if (barElem) barElem.style.width = pct;
      if (rbarElem) rbarElem.style.width = pct;
    }
  }

  if (isHost && currentRoomCode && player && player.getCurrentTime) {
    const curTime = player.getCurrentTime();
    if (curTime > 0) {
      socket.emit('host-time-sync', { roomCode: currentRoomCode, currentTime: curTime });
    }
  }
}, 2000);

socket.on('play-track', ({ track, currentTime, serverTimestamp }) => {
  currentTrack = track;
  const titleElem = document.getElementById("np-title");
  const byElem = document.getElementById("np-by");
  const rtitle = document.getElementById("rtitle");
  const rby = document.getElementById("rby");

  if (titleElem) titleElem.innerText = track.title;
  if (byElem) byElem.innerText = `${track.channel} — added by ${track.addedBy}`;
  if (rtitle) rtitle.innerText = track.title;
  if (rby) rby.innerText = `${track.channel} — added by ${track.addedBy}`;

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
  const rbarElem = document.getElementById("rbar");
  const rtitle = document.getElementById("rtitle");
  const rby = document.getElementById("rby");

  if (titleElem) titleElem.innerText = "Nothing playing";
  if (byElem) byElem.innerText = "Add a song from Search";
  if (rtitle) rtitle.innerText = "Nothing playing";
  if (rby) rby.innerText = "Add a song before you ride";
  if (barElem) barElem.style.width = '0%';
  if (rbarElem) rbarElem.style.width = '0%';

  const placeholder = document.getElementById("ph");
  if (placeholder) placeholder.style.display = "grid";
});

socket.on('sync-time', ({ currentTime, serverTimestamp }) => {
  if (!isHost && player && player.getCurrentTime) {
    const latencyOffset = (Date.now() - serverTimestamp) / 1000;
    const targetTime = currentTime + latencyOffset;
    const localTime = player.getCurrentTime();

    if (Math.abs(localTime - targetTime) > 1.5) {
      player.seekTo(targetTime, true);
    }
  }
});

function voteSkip() {
  if (currentRoomCode) {
    socket.emit('vote-skip', { roomCode: currentRoomCode });
  }
}

// 11. CLEARABLE SEARCH
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

// 12. REAL MIC CHECK DIAGNOSTICS
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