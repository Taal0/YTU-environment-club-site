# 🎰 Live Event Raffle Application

This project is a real-time **Live Event Raffle** platform built on Firebase infrastructure. It uses Google Authentication to provide exclusive access, allowing administrators to create sessions, display QR codes to participants, and conduct a raffle with an advanced weighted mechanics system.

## ✨ Features

- **🎭 Advanced User & Admin Roles**: Login via Google (Authentication). An assigned email automatically gets `admin` privileges while others stay as regular `users`.
- **⏱️ Real-Time Sessions**: Administrators can instantly launch live sessions with custom participant limits, pause, or cancel them directly from the dashboard.
- **🛡️ Entry Limits & Anti-Cheat Mechanisms**: Every user can join an active session only once. Robust backend operations (Firestore Transactions) effectively prevent race conditions and over-booking.
- **🤝 Loyalty-Based Weighting (Weighted Pool)**: As participants attend events over time, their `totalParticipations` (Tickets) increases. The raffle mechanism gives an exponentially higher win chance to users who have attended more events (loyalty system).
- **🎨 Glassmorphism & TailwindCSS UI**: Features a modern, sleek, and dynamic dark-themed UI built for engaging live events.
- **📱 Dynamic QR Code Integration**: A QR Code is automatically generated for every session in the admin panel. Participants simply scan it on their smartphones to jump right in.

## 🛠 Tech Stack

- **Frontend**: HTML5, Vanilla JavaScript, Alpine.js (Reactive State Management), TailwindCSS (Styling), QRCode.js
- **Backend**: Firebase Cloud Functions (Node.js)
- **Database**: Cloud Firestore (NoSQL)
- **Authentication**: Firebase Auth (Google Auth Provider)

## 📦 Setup & Installation

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (Version 18 or higher recommended)
- Firebase CLI installed globally: `npm install -g firebase-tools`

### 2. Clone the Repository & Install Dependencies

```bash
git clone <repo-url>
cd cekilis

# Install Cloud Functions dependencies
cd functions
npm install
cd ..
```

### 3. Local Testing with Firebase Emulator
You can easily test the project locally without deploying to production environments.

```bash
firebase emulators:start
```
- App will run on: `http://localhost:5000`
- Firebase Emulator Suite Dashboard: `http://localhost:4000`

> **Admin Access:** In local emulator mode, simply sign in (via Google prompt) using the email defined in `ADMIN_EMAIL` inside `app.js` and `functions/index.js` to gain immediate **Admin** access.

### 4. Deployment
Once your Firebase project is configured, a single command deploys the backend (Functions & Firestore Rules) and the frontend (Hosting):

```bash
firebase deploy
```
*(Note: Deploying Cloud Functions requires your Firebase project to be on the **Blaze (Pay as you go)** pricing plan.)*

## 🗄️ Database Architecture

The system relies on 3 main collections on Firestore:

1. **`Users`**: Holds the user profiles, their roles (user/admin), and total ticket count (`totalParticipations`). Replicated seamlessly within the backend via triggers.
2. **`Sessions`**: The session ledger created by the admin. Holds session status, participation limits, timeline, and prize data.
3. **`Participations`**: Relational tables indicating which user joined which session at what time.

## 🛡️ Security (Security Rules & Transactions)

- **Frontend Authorization**: Critical data modifications (e.g., granting a user a participation ticket or conducting the raffle) occur strictly within **Cloud Functions**. The frontend solely dispatches intention signals.
- **Firestore Rules**: The database is fully protected by access rules. A user can only read their own profile. Non-admins invoking the "Draw Raffle" function are blocked inherently by the Firebase server, preventing major vulnerabilities.
