# Changelog / Değişiklik günlüğü

Entries are in Turkish. Eumaeus was developed under the working name
"Jev Mail" until 0.30. Full notes: `docs/eumaeus-1.0.0.md`, §1 and §21.

Kayıtlar Türkçedir. Eumaeus, 0.30'a kadar "Jev Mail" çalışma adıyla
geliştirildi. Ayrıntılar: `docs/eumaeus-1.0.0.md`, bölüm 1 ve 21.

- **1.2** (görünürlük ve bildirim) — Giden e-posta kaydı ve “Giden e-postalar” sayfası; kural tetiklenince e-posta bildirimi (`email_notify` kanalı: üye/izin grubu/onaylı dış adres, anında/seyreltilmiş/özet, önizleme ve bana test gönder); tüm sistem e-postaları ortak tasarımda, uyarı başlık ve açıklamaları okuyanın dilinde; Jev durumu kartı ve analiz edilemeyenleri tek tıkla yeniden sorma
- **1.1** (nöbet) — Worker bekçisi (worker durunca e-posta); anında posta alma (IMAP IDLE) ve “Canlı” göstergesi; şema kayması testi; GitHub Actions CI; Docker kurulumu uçtan uca doğrulandı (boş `ACME_EMAIL` hatası düzeltildi) ve VPS rehberi
- **1.0.2** (e-posta) — Yeniden tasarlanan uyarı e-postası: logo, durum rozeti (uyarı / hâlâ açık / çözüldü), hata kutusu, ilk görülme ve süre, türe göre “Ne yapmalı?” önerisi, sorunun giderildiği sayfaya düğme. Davet, iletme onayı, Review özeti (tek tıkla karar düğmeleriyle), atama ve test e-postaları da aynı tasarımda
- **1.0.1** (bakım) — Uyku/ağ kopmasında düşen IMAP bağlantısı artık worker'ı durdurmuyor; `fastrun --bg` çöken API/worker'ı kendiliğinden yeniden başlatıyor
- **1.0** (üretim) — Docker ile kurulum, otomatik HTTPS, yedekleme, dağıtık hız sınırlama, güvenlik başlıkları, yük testi
- **0.31** (görünüm) — “Çam ve Kil” teması (Claude turuncusu vurgu), Nöbetçi logosu
- **0.30** (ad) — Yeni ad: Eumaeus (eski adla oluşturulan başlık, bağlantı ve dosyalarla uyumlu)
- **0.29** (ek) — Eşikli atama e-postaları, eski mailler için gönderen doğrulama, art arda hata sayısı, organizasyon sayfasından Google/Microsoft ile kutu ekleme, devre dışı bırakma ve kalıcı silme
- **0.28** (28) — Mail araması (alıcı, hedef, tarih), Human Review ataması ve notları
- **0.27** (27) — SPF / DKIM / DMARC yakalama, `sender.*` doğrulama koşulları, doğrulama rozeti
- **0.26** (26) — Mail kutusu eşitleme sağlığı, iş kuyruğu görünümü, başarısız işlerin otomatik temizliği, testlerde ayrı Redis
- **0.25** (25) — Kural sürüm geçmişi, sürüme geri dönme, silinmiş kuralı geri getirme
- **0.24** (24) — “Yanlış yere gitti” düzeltmesi, insan düzeltmesi kanıtı, düzeltmeden kural önerisi
- **0.23** (23 + düzeltme turu) — Kaydetmeden önce kural etkisi ve riskli değişiklik onayı, konu kelimesine göre kural önerileri, Türkçe duyarlı `contains`, zincirli taşıma geri alma; özet mailinden tek tıkla karar, klavye kısayolları, benzerlerine uygula, review izin kontrolleri
- **0.22** (22) — Organizasyona özel Jev soruları, geliş bağlamı koşulları, mesai saatleri, Jev'e yeniden sorma
- **0.21** (21) — Türkçe arayüz, iki dilli sistem e-postaları, yerelleştirilmiş tarih ve sayılar
- **0.20** (20) — Saklama süreleri, KVKK silme, audit CSV, API anahtarları, Google/Microsoft ile giriş
- **0.19** (19) — Otomatik yanıt, Slack, Teams, Jira ve Zendesk kanalları, kural JSON içe/dışa aktarma, raporlarda host görünümü
- **0.18** (18) — Operasyon uyarıları (e-posta, webhook), yeniden işleme (sürümlü kararlar), raporlar
- **0.17** (17) — Gmail ve Microsoft 365'i oturum açarak (OAuth) bağlama, otomatik token yenileme, yeniden bağlama
- **0.16** (16) — VIP ve engel listeleri, Review'dan öneriler, liste kaydını deneme
- **0.15** (15) — Bayrak/etiket kanalı, taşımadan önce bayrak, taşımayı geri alma
- **0.14** (14) — Geçmiş maillerde deneme (kural ve akış), kural istatistikleri, ortak karar çekirdeği
- **0.13.1** (bakım) — SMTP test maili, port/TLS uyumsuzluk koruması, hedef oluşturma bütünlüğü
- **0.13** (13) — İletme kanalı (hemen veya özet), alıcı onayı, iletme güvenlik önlemleri, orijinal mail saklama
- **0.12** (12) — Review eşiği ve özeti, hesap güvenliği, kanal yönetimi, kural akışlarının canlı çalışması
- **0.11** (11) — Kullanıcılar, izinler, MFA, davetler, sistem ayarları
- **0.10** (10) — Organizasyonlar, çoklu mail kutusu, Human Review çözümü
- **0.9** (9) — Kural akışı veri modeli ve editör
- **0.8** (8) — Web arayüzü
- **0.7** (7) — Güvenli kapanış, hazır olma kontrolleri
- **0.6** (6) — Kontrol paneli API'si
- **0.5** (5A/5B) — Klasöre taşıma, webhook, imza anahtarları
- **0.4** (4) — Kural motoru
- **0.3** (3) — Jev AI analizi
- **0.2** (2) — Zamanlanmış senkron, bağlantı sağlığı
- **0.1** (1) — IMAP toplama, idempotent kayıt
