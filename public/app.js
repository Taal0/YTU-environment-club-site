// ═══════════════════════════════════════════════════════════════
// Firebase Configuration
// ═══════════════════════════════════════════════════════════════
// ⚠️ Replace these values with your own Firebase project information!
const firebaseConfig = {
    apiKey: "AIzaSyAfnNQqevZ0rXMJFES3u5XG0YE4bJRVrCI",
    authDomain: "ytu-club-event-site.firebaseapp.com",
    projectId: "ytu-club-event-site",
    storageBucket: "ytu-club-event-site.firebasestorage.app",
    messagingSenderId: "455806746895",
    appId: "1:455806746895:web:f41fc1ecc5a78600193e7a",
    measurementId: "G-WKWXHM0H89"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();
const functions = firebase.app().functions("europe-west3");

// ═══════════════════════════════════════════════════════════════
// Local Emulator Connection (Only active when running on localhost or 127.0.0.1)
// ═══════════════════════════════════════════════════════════════
if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    console.log("🛠️ Local Emulator Mode Active!");
    // We use the address we entered in the browser to prevent cross-origin token errors
    const host = window.location.hostname; 

    auth.useEmulator(`http://${host}:9099`);
    db.useEmulator(host, 8080);
    functions.useEmulator(host, 5001);
}


// ═══════════════════════════════════════════════════════════════
// FingerprintJS - Device Fingerprint
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Alpine.js Main Application
// ═══════════════════════════════════════════════════════════════
function app() {
    return {
        // ─── State ───
        authReady: false,
        isLoggedIn: false,
        isAdmin: false,
        user: null,
        deviceId: null,
        currentSession: null,
        currentSessionId: null,
        joinedCount: 0,
        userStatus: "idle", // idle | joining | joined
        sessionLimit: 200,
        sessionPrize: "",
        sessionMinParticipation: 0,
        userTotalParticipations: 0,
        participants: [],
        toasts: [],
        pastSessions: [],
        winner: null,
        winnerPoolSize: 0,
        winnerUniqueCount: 0,
        isDrawing: false,

        // Realtime listener unsubscribe functions
        _sessionListener: null,
        _participantsListener: null,
        _pastSessionsListener: null,

        // Performance: participant user cache & session dedup
        _userCache: {},
        _lastCheckedSessionId: null,

        // Concurrency guard: incremented on every onAuthStateChanged call;
        // each awaited step checks this to abort stale callbacks early.
        _authGeneration: 0,
        // Resolves when FingerprintJS + device ID is ready (non-blocking boot)
        _deviceIdReady: null,

        // ─── Init ───
        async init() {
            // Start device ID loading in the background — do NOT await here.
            // This lets onAuthStateChanged register immediately, cutting ~400-1000ms off cold boot.
            this._deviceIdReady = this.initDeviceId();

            // Listen for Firebase Auth state changes
            auth.onAuthStateChanged(async (user) => {
                // Generation guard: stamp this invocation so any stale async chain
                // from a previous auth state can detect it's obsolete and bail out.
                const gen = ++this._authGeneration;

                this.cleanupListeners();
                this.authReady = false;

                if (user) {
                    this.user = user;
                    this.isLoggedIn = true;

                    // ── Step 1+2: bootstrapAndRegisterDevice (tek çağrı) ──
                    // Device ID'yi arka planda yükle (zaten initDeviceId ile başlatılmış)
                    await this._deviceIdReady;

                    try {
                        const bootstrapFn = functions.httpsCallable("bootstrapAndRegisterDevice");
                        const result = await bootstrapFn({ deviceId: this.deviceId || null });
                        this.isAdmin = !!result?.data?.isAdmin;

                        // Bail out if a newer auth event superseded us while we awaited above
                        if (this._authGeneration !== gen) return;

                        // Device blocked kontrolü
                        if (result?.data?.deviceBlocked) {
                            this.showToast("Bu cihaz daha önce farklı bir hesapla kullanılmış. Her cihaz yalnızca bir hesapla katılabilir.", "error");
                            if (this._authGeneration === gen) await auth.signOut();
                            return;
                        }
                    } catch (error) {
                        console.error("Bootstrap auth hatası:", error);
                        this.showToast("Oturum bilgileri alınamadı, kullanıcı modu ile devam ediliyor.", "warning");
                        this.isAdmin = false;
                    }

                    // Bail out if a newer auth event superseded us while we awaited above
                    if (this._authGeneration !== gen) return;

                    // ── Step 3: Fetch user ticket count (non-admin only) ──
                    if (!this.isAdmin) {
                        try {
                            const userDoc = await db.collection("Users").doc(user.uid).get();
                            if (this._authGeneration !== gen) return;
                            this.userTotalParticipations = userDoc.exists ? (userDoc.data().totalParticipations || 0) : 0;
                        } catch (e) {
                            console.warn("Bilet sayısı alınamadı:", e);
                            this.userTotalParticipations = 0;
                        }
                    }

                    // ── Step 4: Start listeners ──
                    this._userCache = {};
                    this._lastCheckedSessionId = null;

                    this.listenForActiveSession();
                    this.listenForPastSessions();
                } else {
                    this.isLoggedIn = false;
                    this.isAdmin = false;
                    this.user = null;
                    this.currentSession = null;
                    this.currentSessionId = null;
                    this._userCache = {};
                    this._lastCheckedSessionId = null;
                }

                this.authReady = true;
            });
        },

        // ═══════════════════════════════════════════════════════════
        // Auth Operations
        // ═══════════════════════════════════════════════════════════
        async signInWithGoogle() {
            try {
                const provider = new firebase.auth.GoogleAuthProvider();
                await auth.signInWithPopup(provider);
                this.showToast("Giriş başarılı!", "success");
            } catch (error) {
                console.error("Google giriş hatası:", error);
                this.showToast("Giriş yapılamadı: " + error.message, "error");
            }
        },

        async signOut() {
            try {
                this.cleanupListeners();
                await auth.signOut();
                this.userStatus = "idle";
                this.participants = [];
                this.winner = null;
                this.showToast("Çıkış yapıldı", "info");
            } catch (error) {
                this.showToast("Çıkış yapılamadı", "error");
            }
        },

        // ═══════════════════════════════════════════════════════════
        // Device ID (FingerprintJS)
        // ═══════════════════════════════════════════════════════════
        async ensureFingerprintJsLoaded() {
            if (window.FingerprintJS) return;

            await new Promise((resolve, reject) => {
                const existingScript = document.querySelector('script[data-fpjs="1"]');
                if (existingScript) {
                    existingScript.addEventListener("load", resolve, { once: true });
                    existingScript.addEventListener("error", () => reject(new Error("FingerprintJS yüklenemedi")), { once: true });
                    return;
                }

                const script = document.createElement("script");
                script.src = "https://openfpcdn.io/fingerprintjs/v4";
                script.async = true;
                script.defer = true;
                script.dataset.fpjs = "1";
                script.onload = resolve;
                script.onerror = () => reject(new Error("FingerprintJS yüklenemedi"));
                document.head.appendChild(script);
            });
        },

        async initDeviceId() {
            try {
                await this.ensureFingerprintJsLoaded();
                const fp = await window.FingerprintJS.load();
                const result = await fp.get();
                this.deviceId = result.visitorId;
                console.log("✅ Device ID hazır:", this.deviceId);
            } catch (error) {
                console.warn("FingerprintJS hatası, fallback ID kullanılıyor:", error);
                const KEY = "raffle_device_id_v1";
                let id = localStorage.getItem(KEY);
                if (!id) {
                    id = window.crypto?.randomUUID?.() || `dev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
                    localStorage.setItem(KEY, id);
                }
                this.deviceId = id;
            }
        },

        // ═══════════════════════════════════════════════════════════
        // Session Management (Realtime Listener)
        // ═══════════════════════════════════════════════════════════
        listenForActiveSession() {
            // Önceki listener'ları temizle
            this.cleanupListeners();

            // Aktif ve duraklatılmış oturumları dinle (en son oluşturulan)
            this._sessionListener = db.collection("Sessions")
                .where("status", "in", ["active", "paused"])
                .orderBy("createdAt", "desc")
                .limit(1)
                .onSnapshot((snapshot) => {
                    if (!snapshot.empty) {
                        const doc = snapshot.docs[0];
                        const prevSessionId = this.currentSessionId;
                        this.currentSession = doc.data();
                        this.currentSessionId = doc.id;
                        this.joinedCount = this.currentSession.joinedCount || 0;

                        // Katılımcı listesini dinle (admin için) — sadece session değişince
                        if (this.isAdmin && doc.id !== prevSessionId) {
                            this.listenForParticipants(doc.id);
                        }

                        // Kullanıcının bu oturuma katılıp katılmadığını kontrol et
                        // Sadece session değiştiğinde sorgula (joinedCount artışında tekrar sorgulamayı engelle)
                        if (!this.isAdmin && this.user && doc.id !== this._lastCheckedSessionId) {
                            this._lastCheckedSessionId = doc.id;
                            this.checkUserParticipation(doc.id);
                        }

                        // QR kodu güncelle — sadece session değişince
                        if (this.isAdmin && doc.id !== prevSessionId) {
                            this.$nextTick(() => this.generateQR());
                        }
                    } else {
                        this.currentSession = null;
                        this.currentSessionId = null;
                        this.joinedCount = 0;
                        // Oturum kapandı — katılım durumunu ve dedup key'i sıfırla
                        this.userStatus = "idle";
                        this._lastCheckedSessionId = null;
                    }
                }, (error) => {
                    console.error("Session listener hatası:", error);
                });
        },

        listenForParticipants(sessionId) {
            // Clear previous participant listener
            if (this._participantsListener) {
                this._participantsListener();
            }

            this._participantsListener = db.collection("Participations")
                .where("sessionId", "==", sessionId)
                .orderBy("timestamp", "desc")
                .onSnapshot(async (snapshot) => {
                    // Collect all unique userIds that are NOT already cached
                    const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                    const uniqueIds = [...new Set(docs.map(d => d.userId))];
                    const uncachedIds = uniqueIds.filter(uid => !this._userCache[uid]);

                    // Batch-fetch uncached users in parallel
                    if (uncachedIds.length > 0) {
                        const fetched = await Promise.all(
                            uncachedIds.map(uid =>
                                db.collection("Users").doc(uid).get().catch(() => null)
                            )
                        );
                        for (const userDoc of fetched) {
                            if (userDoc && userDoc.exists) {
                                const d = userDoc.data();
                                this._userCache[userDoc.id] = {
                                    displayName: d.displayName || "Anonim",
                                    email: d.email || "",
                                };
                            } else if (userDoc) {
                                this._userCache[userDoc.id] = { displayName: "Anonim", email: "" };
                            }
                        }
                    }

                    // Build participant list from cache
                    this.participants = docs.map(d => {
                        const cached = this._userCache[d.userId] || { displayName: "Anonim", email: "" };
                        return {
                            id: d.id,
                            ...d,
                            displayName: cached.displayName,
                            email: cached.email,
                        };
                    });
                }, (error) => {
                    console.error("Participants listener hatası:", error);
                });
        },

        listenForPastSessions() {
            if (this._pastSessionsListener) {
                this._pastSessionsListener();
            }

            // Only closed/completed/cancelled sessions will be fetched to feed the history
            this._pastSessionsListener = db.collection("Sessions")
                .where("status", "in", ["completed", "cancelled", "closed"])
                .orderBy("createdAt", "desc")
                .limit(20)
                .onSnapshot((snapshot) => {
                    const sessions = [];
                    snapshot.forEach((doc) => {
                        const data = doc.data();
                        sessions.push({
                            id: doc.id,
                            ...data
                        });
                    });
                    this.pastSessions = sessions;
                }, (error) => {
                    console.error("Past Sessions listener hatası:", error);
                });
        },

        async checkUserParticipation(sessionId) {
            try {
                const snap = await db.collection("Participations")
                    .where("sessionId", "==", sessionId)
                    .where("userId", "==", this.user.uid)
                    .limit(1)
                    .get();

                this.userStatus = snap.empty ? "idle" : "joined";
            } catch (error) {
                console.error("Katılım kontrol hatası:", error);
            }
        },

        cleanupListeners() {
            if (this._sessionListener) {
                this._sessionListener();
                this._sessionListener = null;
            }
            if (this._participantsListener) {
                this._participantsListener();
                this._participantsListener = null;
            }
            if (this._pastSessionsListener) {
                this._pastSessionsListener();
                this._pastSessionsListener = null;
            }
            this._lastCheckedSessionId = null;
        },

        // ═══════════════════════════════════════════════════════════
        // User: Join Session
        // ═══════════════════════════════════════════════════════════
        async joinCurrentSession() {
            if (!this.currentSessionId || this.userStatus !== "idle") return;

            console.log("DEBUG: joinCurrentSession çağrılıyor, auth.currentUser:", auth.currentUser);

            this.userStatus = "joining";

            try {
                const joinSession = functions.httpsCallable("joinSession");
                const result = await joinSession({
                    sessionId: this.currentSessionId,
                });

                this.userStatus = "joined";
                this.userTotalParticipations++;
                this.showToast(result.data.message, "success");
            } catch (error) {
                this.userStatus = "idle";
                // Detailed error message
                let errorMessage = error.message || "Hilinmeyen bir hata oluştu.";
                if (error.code) errorMessage = `[${error.code}] ${errorMessage}`;
                if (error.details) errorMessage += ` (${error.details})`;
                
                this.showToast(errorMessage, "error");
                console.error("Katılım hatası:", error);
            }
        },

        // ═══════════════════════════════════════════════════════════
        // Admin: Create Session
        // ═══════════════════════════════════════════════════════════
        async createSession() {
            if (!this.isAdmin) return;

            const limit = parseInt(this.sessionLimit);
            if (!limit || limit < 1 || limit > 1000) {
                this.showToast("Lütfen 1-1000 arası bir limit girin.", "warning");
                return;
            }

            try {
                const minP = parseInt(this.sessionMinParticipation) || 0;
                await db.collection("Sessions").add({
                    status: "active",
                    limit: limit,
                    prize: this.sessionPrize || "",
                    minParticipation: minP,
                    joinedCount: 0,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                });
                this.sessionPrize = ""; // Clear after starting
                this.sessionMinParticipation = 0; // Clear after starting
                this.showToast(`${limit} kişilik oturum başlatıldı!`, "success");
            } catch (error) {
                this.showToast("Oturum oluşturulamadı: " + error.message, "error");
            }
        },

        // ═══════════════════════════════════════════════════════════
        // Admin: Start/Pause Session
        // ═══════════════════════════════════════════════════════════
        async pauseSession() {
            if (!this.isAdmin || !this.currentSessionId) return;

            const currentStatus = this.currentSession.status;
            if (currentStatus !== "active" && currentStatus !== "paused") return;
            
            const newStatus = currentStatus === "active" ? "paused" : "active";

            try {
                await db.collection("Sessions").doc(this.currentSessionId).update({
                    status: newStatus,
                });
                this.showToast(
                    newStatus === "active" ? "Oturum devam ediyor!" : "Oturum duraklatıldı!",
                    newStatus === "active" ? "success" : "warning"
                );
            } catch (error) {
                this.showToast("Oturum güncellenemedi: " + error.message, "error");
            }
        },

        // ═══════════════════════════════════════════════════════════
        // Admin: Cancel Session
        // ═══════════════════════════════════════════════════════════
        async cancelSession() {
            if (!this.isAdmin || !this.currentSessionId) return;

            // Onay modal'ı (kaza önlemi)
            if (!confirm("⚠️ Bu çekilişi iptal etmek istediğinize emin misiniz?\n\nBu işlem geri alınamaz ve tüm katılımcıların biletleri geri alınacak.")) {
                return;
            }

            try {
                const cancelSessionFn = functions.httpsCallable("cancelSession");
                const result = await cancelSessionFn({ sessionId: this.currentSessionId });

                this.showToast(`Oturum iptal edildi. ${result.data.rolledBackCount} kişinin bileti geri alındı.`, "warning");
                this.currentSession = null;
                this.currentSessionId = null;
                this.participants = [];
            } catch (error) {
                let errorMessage = error.message || "İptal işlemi başarısız.";
                if (error.code) errorMessage = `[${error.code}] ${errorMessage}`;
                this.showToast(errorMessage, "error");
            }
        },

        // ═══════════════════════════════════════════════════════════
        // Admin: Draw Raffle
        // ═══════════════════════════════════════════════════════════
        async drawRaffle() {
            if (!this.isAdmin || !this.currentSessionId || this.isDrawing) return;

            console.log("DEBUG: drawRaffle çağrılıyor, auth.currentUser:", auth.currentUser);

            this.isDrawing = true;

            try {
                const drawWinner = functions.httpsCallable("drawWinner");
                const result = await drawWinner({
                    sessionId: this.currentSessionId,
                });

                if (result.data.success) {
                    this.winner = result.data.winner;
                    this.winnerPoolSize = result.data.totalPoolSize;
                    this.winnerUniqueCount = result.data.uniqueParticipants;
                    this.showToast("🏆 Kazanan belirlendi!", "success");
                }
            } catch (error) {
                // Detailed error message
                let errorMessage = error.message || "Çekiliş yapılamadı.";
                if (error.code) errorMessage = `[${error.code}] ${errorMessage}`;
                
                this.showToast(errorMessage, "error");
                console.error("Çekiliş hatası:", error);
            } finally {
                this.isDrawing = false;
            }
        },

        // ═══════════════════════════════════════════════════════════
        // Create QR Code
        // ═══════════════════════════════════════════════════════════
        generateQR() {
            console.log("QR Kod oluşturuluyor...");
            const container = document.getElementById("qrcode-container");
            if (!container) {
                console.warn("QR Container bulunamadı!");
                return;
            }

            container.innerHTML = "";

            const url = window.location.origin + window.location.pathname;
            const canvas = document.createElement("canvas");
            container.appendChild(canvas);

            // Kütüphane kontrolü (Bazen QRCode bazen qrcode olabiliyor)
            const qrLib = window.QRCode || window.qrcode;

            if (!qrLib) {
                console.error("QR Kod kütüphanesi yüklenemedi!");
                this.showToast("QR Kütüphanesi yüklenemedi!", "error");
                return;
            }

            qrLib.toCanvas(canvas, url, {
                width: 200,
                margin: 1,
                color: {
                    dark: "#1e1b2e",
                    light: "#ffffff",
                },
            }, (error) => {
                if (error) {
                    console.error("QR oluşturma hatası:", error);
                } else {
                    console.log("QR Kod başarıyla oluşturuldu.");
                }
            });
        },

        // ═══════════════════════════════════════════════════════════
        // Helper Functions
        // ═══════════════════════════════════════════════════════════
        showToast(message, type = "info") {
            const toast = { message, type };
            this.toasts.push(toast);
            setTimeout(() => {
                const idx = this.toasts.indexOf(toast);
                if (idx > -1) this.toasts.splice(idx, 1);
            }, 4000);
        },

        formatTime(timestamp) {
            if (!timestamp) return "";
            const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
            return date.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
        },
    };
}
