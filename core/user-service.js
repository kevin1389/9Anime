// User Account & Multi-Device Progress Engine
// Persists watch progress, history, and watchlist across browsers and devices.
import fs from "fs";
import path from "path";

const USERS_FILE = path.join(process.cwd(), "data", "users.json");

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    }
  } catch (e) {
    console.warn("Failed to load users file:", e.message);
  }
  return {};
}

function saveUsers(users) {
  try {
    const dir = path.dirname(USERS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (e) {
    console.warn("Failed to save users file:", e.message);
  }
}

export function authenticateUser(email, password, isSignUp = false) {
  if (!email) throw new Error("Email is required");
  const cleanEmail = email.trim().toLowerCase();
  const users = loadUsers();

  let user = users[cleanEmail];

  if (isSignUp) {
    if (user && user.password && user.password !== password) {
      throw new Error("An account with this email already exists. Please sign in.");
    }
    if (!user) {
      const uid = `user_${Buffer.from(cleanEmail).toString("hex").slice(0, 16)}`;
      user = {
        uid,
        email: cleanEmail,
        password: password || "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        watchProgress: {},
        watchlist: {}
      };
      users[cleanEmail] = user;
      saveUsers(users);
    }
  } else {
    // Sign In
    if (!user) {
      // Auto-create on first sign in if user doesn't exist yet for seamless UX
      const uid = `user_${Buffer.from(cleanEmail).toString("hex").slice(0, 16)}`;
      user = {
        uid,
        email: cleanEmail,
        password: password || "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        watchProgress: {},
        watchlist: {}
      };
      users[cleanEmail] = user;
      saveUsers(users);
    } else if (user.password && password && user.password !== password) {
      throw new Error("Invalid password. Please check your credentials.");
    }
  }

  return {
    uid: user.uid,
    email: user.email,
    watchProgress: user.watchProgress || {},
    watchlist: user.watchlist || {},
    updatedAt: user.updatedAt || Date.now()
  };
}

export function getUserData(uidOrEmail) {
  if (!uidOrEmail) return null;
  const users = loadUsers();
  const key = String(uidOrEmail).trim().toLowerCase();

  // Search by email key or uid
  if (users[key]) return users[key];
  for (const email of Object.keys(users)) {
    if (users[email].uid === uidOrEmail) {
      return users[email];
    }
  }
  return null;
}

export function saveUserData(uidOrEmail, { watchProgress, watchlist, email }) {
  if (!uidOrEmail) return false;
  const users = loadUsers();
  let userKey = null;

  const key = String(uidOrEmail).trim().toLowerCase();
  if (users[key]) {
    userKey = key;
  } else {
    for (const em of Object.keys(users)) {
      if (users[em].uid === uidOrEmail) {
        userKey = em;
        break;
      }
    }
  }

  if (!userKey) {
    const targetEmail = (email || uidOrEmail).trim().toLowerCase();
    userKey = targetEmail;
    users[userKey] = {
      uid: uidOrEmail.startsWith("user_") ? uidOrEmail : `user_${Buffer.from(targetEmail).toString("hex").slice(0, 16)}`,
      email: targetEmail,
      createdAt: Date.now(),
      watchProgress: {},
      watchlist: {}
    };
  }

  const existing = users[userKey];
  if (watchProgress && typeof watchProgress === "object") {
    existing.watchProgress = {
      ...(existing.watchProgress || {}),
      ...watchProgress
    };
  }

  if (watchlist && typeof watchlist === "object") {
    existing.watchlist = {
      ...(existing.watchlist || {}),
      ...watchlist
    };
  }

  existing.updatedAt = Date.now();
  users[userKey] = existing;
  saveUsers(users);
  return existing;
}
