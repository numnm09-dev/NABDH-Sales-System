
import { auth, db } from "./firebase.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  reload,
  verifyBeforeUpdateEmail,
  EmailAuthProvider,
  reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import {
  ref,
  get,
  set,
  update,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

window.NabdhFirebase = {
  auth,
  db,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  reload,
  verifyBeforeUpdateEmail,
  EmailAuthProvider,
  reauthenticateWithCredential,
  ref,
  get,
  set,
  update,
  runTransaction
};

window.dispatchEvent(new Event("nabdh-firebase-ready"));
