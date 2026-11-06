import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDbwhuqoHUVIuSfxpY8DQMCgwdnLYoFvM8",
  authDomain: "nabdh-erp.firebaseapp.com",
  databaseURL: "https://nabdh-erp-default-rtdb.firebaseio.com",
  projectId: "nabdh-erp",
  storageBucket: "nabdh-erp.firebasestorage.app",
  messagingSenderId: "724767321442",
  appId: "1:724767321442:web:cb59d9fc3ef3e2a16d903b",
  measurementId: "G-KSMZX57WG5"
};

const app = initializeApp(firebaseConfig);

export const db = getDatabase(app);
export const auth = getAuth(app);
