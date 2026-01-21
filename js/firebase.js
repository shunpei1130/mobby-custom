// js/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

// あなたの設定（貼ってくれたやつ）
const firebaseConfig = {
  apiKey: "AIzaSyC9p0CGc65dim9DwxNN6Khvai3ZjV4p5FU",
  authDomain: "mobbyfashion.firebaseapp.com",
  projectId: "mobbyfashion",
  storageBucket: "mobbyfashion.firebasestorage.app",
  messagingSenderId: "459297026910",
  appId: "1:459297026910:web:4c4ad521961ea52c0dd5cf",
  measurementId: "G-7LEBQ0SCHZ"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// ✅ ここが必要（app.jsが import してる export）
export const db = getFirestore(app);
export const storage = getStorage(app);

export async function ensureAnonLogin() {
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      unsubscribe();
      try {
        if (user) return resolve(user);
        const cred = await signInAnonymously(auth);
        resolve(cred.user);
      } catch (e) {
        reject(e);
      }
    });
  });
}
