import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCWUio5wXovdiQws2vo69vde3GTz_tsnGY",
  authDomain: "nabdh-7fded.firebaseapp.com",
  databaseURL: "https://nabdh-7fded-default-rtdb.firebaseio.com",
  projectId: "nabdh-7fded",
  storageBucket: "nabdh-7fded.firebasestorage.app",
  messagingSenderId: "5367933860",
  appId: "1:5367933860:web:49df23cf011b82ac4bef31",
  measurementId: "G-9JCV7YTG0H"
};

const app = initializeApp(firebaseConfig);

export const db = getDatabase(app);
export const auth = getAuth(app);
