const { onCall, HttpsError } = require("firebase-functions/v2/https");
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

admin.initializeApp();
const db = admin.firestore();

const REGION = "europe-west3";

const ADMIN_EMAILS = [
  "talatozdemir00@gmail.com",
  "mert.ytucev@gmail.com",
  "ezgisayar0@gmail.com"
].map((email) => email.toLowerCase());

function isAdminEmail(email) {
  return ADMIN_EMAILS.includes((email || "").toLowerCase());
}

// ═══════════════════════════════════════════════════════════════
// onCreate - Kullanıcı İlk Giriş Yaptığında Veritabanına Ekleme
// ═══════════════════════════════════════════════════════════════
exports.createUserRecord = functions.auth.user().onCreate(async (user) => {
  const email = user.email || "";
  const role = isAdminEmail(email) ? "admin" : "user";
  
  await db.collection("Users").doc(user.uid).set({
    email: email,
    displayName: user.displayName || "Anonim",
    role: role,
    totalParticipations: 0,
    createdAt: FieldValue.serverTimestamp()
  });
});

// ═══════════════════════════════════════════════════════════════
// bootstrapAndRegisterDevice - Boot sırasında kullanıcı/rol doğrulama
// + cihaz kilidini tek çağrıda yap (Gen 2)
// ═══════════════════════════════════════════════════════════════
exports.bootstrapAndRegisterDevice = onCall({
  region: REGION,
  minInstances: 1,
  maxInstances: 50,
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Giriş yapmanız gerekiyor.");
  }

  const uid = request.auth.uid;
  const email = (request.auth.token.email || "").toLowerCase().trim();
  const displayName = request.auth.token.name || "Anonim";
  const role = isAdminEmail(email) ? "admin" : "user";
  const isAdmin = role === "admin";
  const userRef = db.collection("Users").doc(uid);

  // ── Step 1: bootstrapAuth — kullanıcı dokümanını oluştur/güncelle ──
  await db.runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);

    if (!userSnap.exists) {
      transaction.set(userRef, {
        email,
        displayName,
        role,
        totalParticipations: 0,
      });
      return;
    }

    const existing = userSnap.data() || {};
    const patch = {
      email,
      displayName: existing.displayName || displayName,
      role,
    };

    if (typeof existing.totalParticipations !== "number") {
      patch.totalParticipations = 0;
    }

    transaction.set(userRef, patch, { merge: true });
  });

  // ── Step 2: setDeviceId — admin değilse cihaz kilidini kontrol et ──
  const { deviceId } = request.data || {};
  let deviceBlocked = false;

  if (!isAdmin && deviceId) {
    if (typeof deviceId !== "string" || deviceId.length < 8 || deviceId.length > 128) {
      throw new HttpsError("invalid-argument", "Geçersiz deviceId.");
    }

    const lockRef = db.collection("DeviceLocks").doc(deviceId);

    try {
      await db.runTransaction(async (tx) => {
        const lockSnap = await tx.get(lockRef);

        if (!lockSnap.exists) {
          tx.set(lockRef, { uid });
        } else if (lockSnap.data().uid !== uid) {
          throw new HttpsError(
            "already-exists",
            "Bu cihaz daha önce farklı bir hesapla kullanılmış. Her cihaz yalnızca bir hesapla katılabilir."
          );
        }

        tx.set(userRef, { deviceId }, { merge: true });
      });
    } catch (error) {
      if (error instanceof HttpsError && error.code === "already-exists") {
        deviceBlocked = true;
      } else if (error instanceof HttpsError) {
        throw error;
      } else {
        console.error("Device lock hatası:", error);
        // Device lock hatasını yutma — giriş yapabilsin ama device blocked olarak işaretle
        deviceBlocked = true;
      }
    }
  }

  return {
    ok: true,
    uid,
    email,
    role,
    isAdmin,
    deviceBlocked,
  };
});

// ═══════════════════════════════════════════════════════════════
// joinSession - Kullanıcı Katılım Cloud Function (Gen 2)
// ═══════════════════════════════════════════════════════════════
exports.joinSession = onCall({
  region: REGION,
  minInstances: 1,
  maxInstances: 50,
}, async (request) => {
  // 1. Auth kontrolü
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Giriş yapmanız gerekiyor."
    );
  }

  const userId = request.auth.uid;
  const { sessionId } = request.data;

  // 2. Parametre validasyonu
  if (!sessionId) {
    throw new HttpsError(
      "invalid-argument",
      "sessionId gereklidir."
    );
  }

  const sessionRef = db.collection("Sessions").doc(sessionId);
  const participationsRef = db.collection("Participations");
  const userRef = db.collection("Users").doc(userId);

  // 3. Oturum durumu kontrolü (transaction öncesi hızlı kontrol)
  const sessionDoc = await sessionRef.get();
  if (!sessionDoc.exists) {
    throw new HttpsError(
      "not-found",
      "Oturum bulunamadı."
    );
  }
  
  const sessionStatus = sessionDoc.data().status;
  if (sessionStatus !== "active") {
    const statusMessages = {
      paused: "Bu oturum şu anda duraklatılmış.",
      cancelled: "Bu oturum iptal edilmiş.",
      completed: "Bu oturum sonuçlanmış.",
    };
    throw new HttpsError(
      "failed-precondition",
      statusMessages[sessionStatus] || "Bu oturum şu anda aktif değil."
    );
  }

  // 4. Transaction - Atomik İşlem
  // joinedCount artırma transaction DIŞINDA yapılacak (contention azaltma).
  // Deterministic doc ID: sessionId_userId — transaction içinde okunup kontrol edilir;
  // çift isteği sunucu tarafında atomik olarak engeller (race condition yok).
  const participationRef = participationsRef.doc(`${sessionId}_${userId}`);

  try {
    await db.runTransaction(async (transaction) => {
      const [sessionSnap, participationSnap, userSnap] = await Promise.all([
        transaction.get(sessionRef),
        transaction.get(participationRef),
        transaction.get(userRef),
      ]);

      const sessionData = sessionSnap.data();

      // Oturum durumunu transaction içinde yeniden kontrol et (status değişmiş olabilir)
      if (sessionData.status !== "active") {
        const statusMessages = {
          paused: "Bu oturum şu anda duraklatılmış.",
          cancelled: "Bu oturum iptal edilmiş.",
          completed: "Bu oturum sonuçlanmış.",
        };
        throw new HttpsError(
          "failed-precondition",
          statusMessages[sessionData.status] || "Bu oturum şu anda aktif değil."
        );
      }

      // Çift katılım kontrolü (atomik — önceki Firestore sorgusu olmadan)
      if (participationSnap.exists) {
        throw new HttpsError("already-exists", "Bu oturuma zaten katıldınız.");
      }

      // Minimum katılım şartı kontrolü
      const minReq = sessionData.minParticipation || 0;
      if (minReq > 0) {
        const currentTickets = (userSnap.exists ? userSnap.data().totalParticipations : 0) || 0;
        if (currentTickets < minReq) {
          throw new HttpsError(
            "failed-precondition",
            `Bu çekilişe katılmak için en az ${minReq} önceki katılımınız olmalı. Mevcut: ${currentTickets}`
          );
        }
      }

      if (sessionData.joinedCount >= sessionData.limit) {
        throw new HttpsError(
          "resource-exhausted",
          "Kontenjan doldu! Daha fazla katılımcı kabul edilmiyor."
        );
      }

      // ── Transaction içinde: sadece participationRef ve userRef yazılır ──
      // joinedCount artırma transaction DIŞINDA yapılır (contention azaltma)

      // Participations kaydı oluştur (deterministic ID)
      transaction.set(participationRef, {
        userId: userId,
        sessionId: sessionId,
        timestamp: FieldValue.serverTimestamp(),
      });

      // Users tablosunu güncelle veya oluştur
      if (userSnap.exists) {
        transaction.update(userRef, {
          totalParticipations: FieldValue.increment(1),
        });
      } else {
        // Fix 4: request.auth.token'dan al, admin.auth().getUser() çağrısını kaldır
        const email = request.auth.token.email || "";
        const displayName = request.auth.token.name || "Anonim";
        transaction.set(userRef, {
          email: email,
          displayName: displayName,
          role: isAdminEmail(email) ? "admin" : "user",
          totalParticipations: 1,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    });

    // Fix 1: joinedCount artırma — transaction DIŞINDA, non-transactional atomik increment
    // Bu sayede 500 eşzamanlı kullanıcı session doc üzerinde contention yaratmaz.
    await sessionRef.update({
      joinedCount: FieldValue.increment(1),
    });

    return { success: true, message: "Başarıyla katıldınız!" };
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    console.error("Transaction hatası:", error);
    throw new HttpsError(
      "internal",
      "Bir hata oluştu, lütfen tekrar deneyin."
    );
  }
});

// ═══════════════════════════════════════════════════════════════
// drawWinner - Ağırlıklı Çekiliş Cloud Function (Gen 2)
// ═══════════════════════════════════════════════════════════════
exports.drawWinner = onCall({
  region: REGION,
  maxInstances: 10,
}, async (request) => {
  // 1. Auth kontrolü
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Giriş yapmanız gerekiyor."
    );
  }

  // 2. Admin kontrolü
  if (!isAdminEmail(request.auth.token.email)) {
    throw new HttpsError(
      "permission-denied",
      "Bu işlem sadece admin tarafından yapılabilir."
    );
  }

  const { sessionId } = request.data;

  if (!sessionId) {
    throw new HttpsError(
      "invalid-argument",
      "sessionId gereklidir."
    );
  }

  // 3. Oturum durumunu kontrol et — tamamlanmış/iptal oturumda tekrar çekiliş yapılmasını engelle
  const sessionSnap = await db.collection("Sessions").doc(sessionId).get();
  if (!sessionSnap.exists) {
    throw new HttpsError("not-found", "Oturum bulunamadı.");
  }
  const sessionStatus = sessionSnap.data().status;
  if (sessionStatus !== "active" && sessionStatus !== "paused") {
    throw new HttpsError(
      "failed-precondition",
      "Bu oturum zaten sonuçlanmış veya iptal edilmiş."
    );
  }

  // 4. Oturuma ait tüm katılımları getir
  const participationsSnap = await db
    .collection("Participations")
    .where("sessionId", "==", sessionId)
    .get();

  if (participationsSnap.empty) {
    throw new HttpsError(
      "not-found",
      "Bu oturumda hiç katılımcı yok."
    );
  }

  // 5. Benzersiz kullanıcı ID'lerini topla
  const userIds = [...new Set(participationsSnap.docs.map((doc) => doc.data().userId))];

  // 6. Her kullanıcının totalParticipations bilgisini al
  const userDocs = await Promise.all(
    userIds.map((uid) => db.collection("Users").doc(uid).get())
  );

  // 7. Ağırlıklı Havuz oluştur
  const weightedPool = [];
  const participantDetails = {};

  for (const userDoc of userDocs) {
    if (userDoc.exists) {
      const userData = userDoc.data();
      const weight = userData.totalParticipations || 1;
      participantDetails[userDoc.id] = {
        displayName: userData.displayName || "Anonim",
        email: userData.email || "",
        totalParticipations: weight,
      };
      // Kullanıcı ID'sini ağırlığı kadar havuza ekle
      for (let i = 0; i < weight; i++) {
        weightedPool.push(userDoc.id);
      }
    }
  }

  if (weightedPool.length === 0) {
    throw new HttpsError(
      "internal",
      "Ağırlıklı havuz oluşturulamadı."
    );
  }

  // 8. Rastgele kazanan seç
  const randomIndex = Math.floor(Math.random() * weightedPool.length);
  const winnerId = weightedPool[randomIndex];
  const winnerInfo = participantDetails[winnerId];

  // 9. Session durumunu completed yap ve kazanan bilgisini kaydet
  await db.collection("Sessions").doc(sessionId).update({
    status: "completed",
    completedAt: FieldValue.serverTimestamp(),
    winnerId: winnerId,
    winnerName: winnerInfo.displayName,
  });

  return {
    success: true,
    winner: {
      id: winnerId,
      displayName: winnerInfo.displayName,
      email: winnerInfo.email,
      totalParticipations: winnerInfo.totalParticipations,
    },
    totalPoolSize: weightedPool.length,
    uniqueParticipants: userIds.length,
  };
});

// ═══════════════════════════════════════════════════════════════
// cancelSession - Oturumu İptal Et ve Hakları Geri Ver (Gen 2)
// ═══════════════════════════════════════════════════════════════
exports.cancelSession = onCall({
  region: REGION,
  maxInstances: 10,
  timeoutSeconds: 120,
}, async (request) => {
  // 1. Auth kontrolü
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Giriş yapmanız gerekiyor."
    );
  }

  // 2. Admin kontrolü
  if (!isAdminEmail(request.auth.token.email)) {
    throw new HttpsError(
      "permission-denied",
      "Bu işlem sadece admin tarafından yapılabilir."
    );
  }

  const { sessionId } = request.data;

  if (!sessionId) {
    throw new HttpsError(
      "invalid-argument",
      "sessionId gereklidir."
    );
  }

  const sessionRef = db.collection("Sessions").doc(sessionId);
  const sessionDoc = await sessionRef.get();

  if (!sessionDoc.exists) {
    throw new HttpsError("not-found", "Oturum bulunamadı.");
  }

  const currentStatus = sessionDoc.data().status;
  if (currentStatus === "cancelled" || currentStatus === "completed") {
    throw new HttpsError(
      "failed-precondition",
      "Bu oturum zaten sonlandırılmış."
    );
  }

  // Katılımcıları getir
  const participationsSnap = await db
    .collection("Participations")
    .where("sessionId", "==", sessionId)
    .get();

  // KURAL: Biz bilet sayısını (totalParticipations) katılım yapılan SIRA KADAR değil
  // her bir tekil katılım kaydı (Participation document) için 1 azaltmalıyız.
  // Bir kullanıcı 3 biletle (farklı zamanlarda) katıldıysa, 3 participation doc vardır.

  const participations = participationsSnap.docs.map(doc => doc.data());
  
  // Hangi kullanıcının kaç katılımı (bileti) olduğunu hesapla
  const userTicketCounts = {};
  for (const p of participations) {
    if (!userTicketCounts[p.userId]) {
      userTicketCounts[p.userId] = 0;
    }
    userTicketCounts[p.userId]++;
  }

  const userIds = Object.keys(userTicketCounts);
  
  // Firestore batch write limit 500
  const BATCH_LIMIT = 499;

  for (let i = 0; i < userIds.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    const chunk = userIds.slice(i, i + BATCH_LIMIT);

    // Sadece ilk döngüde session status güncellenir
    if (i === 0) {
      batch.update(sessionRef, {
        status: "cancelled",
        cancelledAt: FieldValue.serverTimestamp(),
      });
    }

    for (const uid of chunk) {
      const ticketsToRollback = userTicketCounts[uid];
      const userRef = db.collection("Users").doc(uid);
      batch.update(userRef, {
        totalParticipations: FieldValue.increment(-ticketsToRollback),
      });
    }

    await batch.commit();
  }

  // Eğer katılımcı yoksa sadece oturumu iptal et
  if (userIds.length === 0) {
    await sessionRef.update({
      status: "cancelled",
      cancelledAt: FieldValue.serverTimestamp(),
    });
  }

  return {
    success: true,
    message: "Oturum iptal edildi ve katılım hakları geri alındı.",
    rolledBackCount: userIds.length,
  };
});
