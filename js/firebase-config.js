// ============================================================
//  WalkWorld — firebase-config.js
//
//  ⚠️  REPLACE the values below with YOUR Firebase project config.
//
//  How to get your config:
//    1. Go to https://console.firebase.google.com
//    2. Create a project (or open an existing one)
//    3. Click the </> Web icon to add a web app
//    4. Copy the firebaseConfig object shown and paste it here
//    5. In Firebase console → Realtime Database → Create database
//       (start in TEST MODE for now — you can lock it down later)
// ============================================================
 
import { initializeApp }     from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase }       from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
 
// ── ✏️  PASTE YOUR CONFIG HERE ──────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyDU-rtxp20m2f6XdVPzs8MJ6UsiOpPvMWY",
  authDomain:        "infinite-craft-remake-56705.firebaseapp.com",
  databaseURL:       "https://infinite-craft-remake-56705-default-rtdb.firebaseio.com",
  projectId:         "infinite-craft-remake-56705",
  storageBucket:     "infinite-craft-remake-56705.firebasestorage.app",
  messagingSenderId: "347877015349",
  appId:             "1:347877015349:web:bea7754ad38990b97cd67c",
};
// ────────────────────────────────────────────────────────────
 
let app = null;
let db  = null;
 
// Guard: won't crash if config hasn't been filled in yet
const isConfigured = firebaseConfig.apiKey !== "YOUR_API_KEY";
 
if (isConfigured) {
  app = initializeApp(firebaseConfig);
  db  = getDatabase(app);
} else {
  console.warn(
    "[WalkWorld] Firebase not configured!\n" +
    "Open js/firebase-config.js and paste your Firebase project config."
  );
}
 
export { app, db, isConfigured };
 
