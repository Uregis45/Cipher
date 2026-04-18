// ============================================================
//  KnotCipher Ghost — script.js
//  Real AES-GCM encryption via Web Crypto API + Firebase RTDB
//  NEW: Ghost Mode with self-destructing messages
// ============================================================

// ── Firebase config ─────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyCGt-aChYWe-xWqPNFBMQgSSVa8_2Ra-uc",
  authDomain: "knotcipher.firebaseapp.com",
  databaseURL: "https://knotcipher-default-rtdb.firebaseio.com",
  projectId: "knotcipher",
  storageBucket: "knotcipher.firebasestorage.app",
  messagingSenderId: "250799176721",
  appId: "1:250799176721:web:e0a7ccb3c6cae9926b45b0",
  measurementId: "G-Q1K76V3N8R"
};

firebase.initializeApp(firebaseConfig);
const database = firebase.database();
console.log("✅ Firebase connected!");

// ── State ────────────────────────────────────────────────────
let currentRoom    = "lobby";
let knotKey        = "";
let cryptoKey      = null;          // CryptoKey object (AES-GCM)
let currentUser    = generateUserId();
let messageCache   = new Set();     // prevent duplicate renders
let currentMsgRef  = null;
let isKeySet       = false;
let typingTimeout  = null;
let onlineRef      = null;
let typingRef      = null;

// ── Ghost Mode State ─────────────────────────────────────────
let currentMode      = "classic";   // "classic" or "ghost"
let ghostTimer       = 30;          // seconds
let ghostTimeouts    = new Map();    // track active ghost timers

// ── User ID ──────────────────────────────────────────────────
function generateUserId() {
  const stored = sessionStorage.getItem("knotcipher_uid");
  if (stored) return stored;
  const adjectives = ["Swift","Silent","Brave","Clever","Phantom","Mystic","Shadow","Neon"];
  const nouns      = ["Fox","Wolf","Hawk","Lynx","Viper","Raven","Cipher","Ghost"];
  const id = adjectives[Math.floor(Math.random()*adjectives.length)]
           + nouns[Math.floor(Math.random()*nouns.length)]
           + "_" + Math.floor(Math.random()*999);
  sessionStorage.setItem("knotcipher_uid", id);
  return id;
}

// ── AES-GCM Helpers ──────────────────────────────────────────
async function deriveKey(password) {
  const enc     = new TextEncoder();
  const rawKey  = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "PBKDF2" }, false,
    ["deriveKey"]
  );
  // Use a fixed salt derived from the app name (both sides use same salt)
  const salt = enc.encode("KnotCipherSalt_v2");
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptMessage(plainText, key) {
  const enc  = new TextEncoder();
  const iv   = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plainText)
  );
  // Pack: iv (12 bytes) + ciphertext, then base64
  const combined = new Uint8Array(iv.byteLength + data.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(data), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

async function decryptMessage(base64, key) {
  try {
    const bytes     = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const iv        = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null; // null = wrong key
  }
}

// ── Key Setup ────────────────────────────────────────────────
async function setKnotKey() {
  const input     = document.getElementById("knotKeyInput").value.trim();
  const statusDiv = document.getElementById("keyStatus");

  if (!input) {
    statusDiv.textContent      = "⚠️ Enter a key first";
    statusDiv.style.background = "#ff9800";
    isKeySet = false;
    return;
  }

  statusDiv.textContent      = "⏳ Deriving key…";
  statusDiv.style.background = "#607d8b";

  try {
    cryptoKey = await deriveKey(input);
    knotKey   = input;
    isKeySet  = true;

    const preview              = "●".repeat(Math.min(input.length, 8));
    statusDiv.textContent      = `✅ Key set: ${preview}`;
    statusDiv.style.background = "#4caf50";

    // Re-render existing messages with the new key
    await reDecryptMessages();
  } catch (e) {
    statusDiv.textContent      = "❌ Key derivation failed";
    statusDiv.style.background = "#f44336";
    console.error(e);
  }
}

// ── Ghost Mode Functions ───────────────────────────────────
function setMode(mode) {
  currentMode = mode;
  const classicBtn = document.getElementById("classicModeBtn");
  const ghostBtn   = document.getElementById("ghostModeBtn");
  const timerContainer = document.getElementById("ghostTimerContainer");
  
  if (mode === "classic") {
    classicBtn.classList.add("active");
    ghostBtn.classList.remove("active");
    timerContainer.style.display = "none";
    showToast("📝 Classic mode — messages are permanent");
  } else {
    ghostBtn.classList.add("active");
    classicBtn.classList.remove("active");
    timerContainer.style.display = "flex";
    showToast("👻 Ghost mode — messages will self-destruct");
  }
}

function scheduleGhostDeletion(messageId, messageRef, seconds) {
  // Clear any existing timer for this message
  if (ghostTimeouts.has(messageId)) {
    clearTimeout(ghostTimeouts.get(messageId));
  }
  
  const timeout = setTimeout(async () => {
    // Delete from Firebase
    await messageRef.remove();
    // Remove from UI with fade effect
    const msgElement = document.querySelector(`.message[data-key="${messageId}"]`);
    if (msgElement) {
      msgElement.style.transition = "opacity 0.3s";
      msgElement.style.opacity = "0";
      setTimeout(() => {
        if (msgElement && msgElement.parentNode) msgElement.remove();
      }, 300);
    }
    ghostTimeouts.delete(messageId);
    showToast("💀 A ghost message self-destructed", 1500);
  }, seconds * 1000);
  
  ghostTimeouts.set(messageId, timeout);
}

// ── Room ─────────────────────────────────────────────────────
function joinRoom() {
  const roomName = document.getElementById("roomInput").value.trim();
  if (!roomName) { alert("Enter a room name"); return; }

  // Tear down previous listeners
  if (currentMsgRef)  currentMsgRef.off();
  if (onlineRef)      onlineRef.remove();
  if (typingRef)      typingRef.remove();
  
  // Clear ghost timers from previous room
  for (const [id, timer] of ghostTimeouts) {
    clearTimeout(timer);
  }
  ghostTimeouts.clear();

  currentRoom = sanitiseRoomName(roomName);
  messageCache.clear();

  document.getElementById("currentRoom").textContent  = currentRoom;
  document.getElementById("messagesContainer").innerHTML = `
    <div class="system-msg">🔐 Joined <strong>${escHtml(currentRoom)}</strong>. Waiting for messages…</div>`;

  const roomStatus = document.getElementById("roomStatus");
  roomStatus.textContent      = `✅ Room: ${currentRoom}`;
  roomStatus.style.background = "#4caf50";

  // Presence
  setupPresence();

  // Listen for messages (last 50 only)
  const msgRef = database.ref(`rooms/${currentRoom}/messages`).limitToLast(50);
  currentMsgRef = msgRef;
  msgRef.on("child_added", async snap => {
    const msg = snap.val();
    if (!msg || messageCache.has(snap.key)) return;
    messageCache.add(snap.key);
    await displayMessage(msg, snap.key);
  });

  // Listen for typing indicators
  database.ref(`rooms/${currentRoom}/typing`).on("value", snap => {
    const data    = snap.val() || {};
    const others  = Object.entries(data)
      .filter(([uid, ts]) => uid !== currentUser && Date.now() - ts < 4000)
      .map(([uid]) => uid.split("_")[0]);
    const el = document.getElementById("typingIndicator");
    el.textContent = others.length ? `${others.join(", ")} ${others.length > 1 ? "are" : "is"} typing…` : "";
  });
}

function sanitiseRoomName(name) {
  // Firebase paths can't contain . # $ [ ]
  return name.replace(/[.#$[\]]/g, "_").substring(0, 40);
}

// ── Presence ─────────────────────────────────────────────────
function setupPresence() {
  onlineRef = database.ref(`rooms/${currentRoom}/online/${currentUser}`);
  onlineRef.set(true);
  onlineRef.onDisconnect().remove();

  database.ref(`rooms/${currentRoom}/online`).on("value", snap => {
    const count = snap.numChildren();
    const el    = document.getElementById("onlineCount");
    if (el) el.textContent = `${count} online`;
  });
}

// ── Typing ───────────────────────────────────────────────────
function handleTyping() {
  if (!currentRoom) return;
  database.ref(`rooms/${currentRoom}/typing/${currentUser}`).set(Date.now());
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    database.ref(`rooms/${currentRoom}/typing/${currentUser}`).remove();
  }, 3000);
}

// ── Send ─────────────────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById("messageInput");
  const text  = input.value.trim();
  if (!text) return;

  if (!isKeySet) {
    showToast("⚠️ Set your Knot Key first!");
    return;
  }

  input.value = "";
  database.ref(`rooms/${currentRoom}/typing/${currentUser}`).remove();

  const encrypted = await encryptMessage(text, cryptoKey);

  const msgData = {
    sender:      currentUser,
    encrypted,
    timestamp:   Date.now(),
    mode:        currentMode,           // NEW: store mode
    ghostTimer:  currentMode === "ghost" ? ghostTimer : null   // NEW: store timer
  };

  const newMsgRef = await database.ref(`rooms/${currentRoom}/messages`).push(msgData);
  
  // If ghost mode, schedule deletion immediately (sender side)
  if (currentMode === "ghost") {
    scheduleGhostDeletion(newMsgRef.key, newMsgRef, ghostTimer);
  }

  capMessages();
}

async function capMessages() {
  const snap = await database.ref(`rooms/${currentRoom}/messages`).once("value");
  const count = snap.numChildren();
  if (count > 200) {
    const keys = Object.keys(snap.val());
    const toDelete = keys.slice(0, count - 200);
    const updates  = {};
    toDelete.forEach(k => { updates[`rooms/${currentRoom}/messages/${k}`] = null; });
    database.ref().update(updates);
  }
}

// ── Display ──────────────────────────────────────────────────
async function displayMessage(msg, key) {
  const container  = document.getElementById("messagesContainer");
  const isOwn      = msg.sender === currentUser;
  const time       = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  let decrypted = null;
  if (isKeySet) {
    decrypted = await decryptMessage(msg.encrypted, cryptoKey);
  }

  const el        = document.createElement("div");
  el.className    = `message ${isOwn ? "sent" : "received"}`;
  if (msg.mode === "ghost") el.classList.add("ghost-message");
  el.dataset.key  = key;
  el.dataset.enc  = msg.encrypted;

  const bubbleText = decrypted !== null
    ? escHtml(decrypted)
    : `<span class="locked-msg">🔒 Wrong key or not yet set</span>`;

  const encPreview = msg.encrypted.substring(0, 24) + "…";
  const ghostBadge = msg.mode === "ghost" ? `<span class="ghost-badge">👻 ${msg.ghostTimer}s</span>` : "";

  el.innerHTML = `
    <div class="msg-meta">${isOwn ? "" : `<span class="sender-name">${escHtml(msg.sender)}</span>`} ${ghostBadge}</div>
    <div class="message-bubble">
      <div class="bubble-text">${bubbleText}</div>
      <div class="msg-footer">
        <span class="msg-time">${time}</span>
        ${isOwn ? '<span class="msg-tick">✓✓</span>' : ""}
      </div>
    </div>
    <div class="message-encrypted">🔒 ${encPreview}</div>
  `;

  const placeholder = container.querySelector(".empty-placeholder");
  if (placeholder) placeholder.remove();

  container.appendChild(el);
  container.scrollTop = container.scrollHeight;

  // Schedule ghost deletion for received ghost messages
  if (msg.mode === "ghost" && msg.ghostTimer && !isOwn) {
    const msgRef = database.ref(`rooms/${currentRoom}/messages/${key}`);
    scheduleGhostDeletion(key, msgRef, msg.ghostTimer);
  }
}

// Re-render all messages when key changes
async function reDecryptMessages() {
  const els = document.querySelectorAll(".message[data-enc]");
  for (const el of els) {
    const enc       = el.dataset.enc;
    const decrypted = await decryptMessage(enc, cryptoKey);
    const bubble    = el.querySelector(".bubble-text");
    if (bubble) {
      bubble.innerHTML = decrypted !== null
        ? escHtml(decrypted)
        : `<span class="locked-msg">🔒 Wrong key</span>`;
    }
  }
}

// ── Toast ────────────────────────────────────────────────────
function showToast(msg, duration = 3000) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className   = "toast show";
  setTimeout(() => { t.className = "toast"; }, duration);
}

// ── Util ─────────────────────────────────────────────────────
function escHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ── Init ─────────────────────────────────────────────────────
window.onload = () => {
  document.getElementById("currentUser").textContent = currentUser;

  // Keyboard shortcuts
  document.getElementById("messageInput").addEventListener("keypress", e => {
    if (e.key === "Enter") sendMessage();
  });
  document.getElementById("messageInput").addEventListener("input", handleTyping);
  document.getElementById("knotKeyInput").addEventListener("keypress", e => {
    if (e.key === "Enter") setKnotKey();
  });
  document.getElementById("roomInput").addEventListener("keypress", e => {
    if (e.key === "Enter") joinRoom();
  });

  // Show password toggle
  const keyInput  = document.getElementById("knotKeyInput");
  const toggleBtn = document.getElementById("toggleKeyVisibility");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const isPassword = keyInput.type === "password";
      keyInput.type    = isPassword ? "text" : "password";
      toggleBtn.textContent = isPassword ? "🙈" : "👁️";
    });
  }

  // Ghost mode toggle buttons
  const classicBtn = document.getElementById("classicModeBtn");
  const ghostBtn = document.getElementById("ghostModeBtn");
  const timerSelect = document.getElementById("ghostTimerSelect");
  
  if (classicBtn) classicBtn.addEventListener("click", () => setMode("classic"));
  if (ghostBtn) ghostBtn.addEventListener("click", () => setMode("ghost"));
  if (timerSelect) {
    timerSelect.addEventListener("change", (e) => {
      ghostTimer = parseInt(e.target.value, 10);
    });
  }

  // Auto-join lobby after brief delay
  setTimeout(joinRoom, 600);
};