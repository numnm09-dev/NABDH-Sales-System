import { auth, db } from "./firebase.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import {
  ref,
  get,
  set,
  update
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

window.NabdhFirebase = {
  auth,
  db,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  ref,
  get,
  set,
  update
};

window.dispatchEvent(new Event("nabdh-firebase-ready"));
