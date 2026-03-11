const { onCall, HttpsError } = require("firebase-functions/v2/https");
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

admin.initializeApp();
const db = admin.firestore();

const ADMIN_EMAILS = [
  "talatozdemir00@gmail.com",
  "mert.ytucev@gmail.com",
  "ezgisayar0@gmail.com"
].map((email) => email.toLowerCase());

function isAdminEmail(email) {
  return ADMIN_EMAILS.includes((email || "").toLowerCase());
}

// ═══════════════════════════════════════════════════════════════
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
// setDeviceId - Kullanıcının cihaz ID bilgisini güvenli şekilde kaydet (Gen 2)
// ═══════════════════════════════════════════════════════════════
exports.setDeviceId = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Giriş yapmanız gerekiyor."
    );
  }

  const { deviceId } = request.data || {};
  if (typeof deviceId !== "string" || deviceId.length < 8 || deviceId.length > 128) {
    throw new HttpsError(
      "invalid-argument",
      "Geçersiz deviceId."
    );
  }

  await db.collection("Users").doc(request.auth.uid).set({
    deviceId,
  }, { merge: true });

  return { success: true };
});

// ═══════════════════════════════════════════════════════════════
// joinSession - Kullanıcı Katılım Cloud Function (Gen 2)
// ═══════════════════════════════════════════════════════════════
exports.joinSession = onCall(async (request) => {
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

  // 3. Oturum durumu kontrolü
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

  // 4. Hile kontrolü (Cihaz kontrolü geçici olarak kaldırıldı, sadece tek hesap = 1 katılım)

  // 5. Aynı kullanıcı kontrolü
  const userCheck = await participationsRef
    .where("sessionId", "==", sessionId)
    .where("userId", "==", userId)
    .limit(1)
    .get();

  if (!userCheck.empty) {
    throw new HttpsError(
      "already-exists",
      "Bu oturuma zaten katıldınız."
    );
  }

  // 6. Transaction - Atomik İşlem
  try {
    await db.runTransaction(async (transaction) => {
      const sessionSnap = await transaction.get(sessionRef);
      const sessionData = sessionSnap.data();
      const userSnap = await transaction.get(userRef);

      if (sessionData.joinedCount >= sessionData.limit) {
        throw new HttpsError(
          "resource-exhausted",
          "Kontenjan doldu! Daha fazla katılımcı kabul edilmiyor."
        );
      }

      // joinedCount artır
      transaction.update(sessionRef, {
        joinedCount: FieldValue.increment(1),
      });

      // Participations kaydı oluştur
      const newParticipationRef = participationsRef.doc();
      transaction.set(newParticipationRef, {
        userId: userId,
        sessionId: sessionId,
        timestamp: FieldValue.serverTimestamp(),
      });

      // Users tablosunu güncelle veya oluştur (Race condition önlemi)
      if (userSnap.exists) {
        transaction.update(userRef, {
          totalParticipations: FieldValue.increment(1),
        });
      } else {
        const authUser = await admin.auth().getUser(userId);
        transaction.set(userRef, {
          email: authUser.email || "",
          displayName: authUser.displayName || "Anonim",
          role: isAdminEmail(authUser.email) ? "admin" : "user",
          totalParticipations: 1,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
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
exports.drawWinner = onCall(async (request) => {
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

  // 3. Oturuma ait tüm katılımları getir
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

  // 4. Benzersiz kullanıcı ID'lerini topla
  const userIds = [...new Set(participationsSnap.docs.map((doc) => doc.data().userId))];

  // 5. Her kullanıcının totalParticipations bilgisini al
  const userDocs = await Promise.all(
    userIds.map((uid) => db.collection("Users").doc(uid).get())
  );

  // 6. Ağırlıklı Havuz oluştur
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

  // 7. Rastgele kazanan seç
  const randomIndex = Math.floor(Math.random() * weightedPool.length);
  const winnerId = weightedPool[randomIndex];
  const winnerInfo = participantDetails[winnerId];

  // 8. Session durumunu completed yap ve kazanan bilgisini kaydet
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
exports.cancelSession = onCall(async (request) => {
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
