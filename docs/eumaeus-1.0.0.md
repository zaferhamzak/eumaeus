# Eumaeus 1.0.0

**Sürüm:** 1.0.0 · **Tarih:** Eylül 2026 · **Lisans:** Apache-2.0

Eumaeus, bağlanan e-posta kutularını düzenli olarak kontrol eden, gelen her maili
Jev AI ile analiz ettiren, sonucu kurallara göre değerlendirip kararı uygulayan
(klasöre taşıma, webhook, başka adrese iletme) ve karar veremediği mailleri
insan kontrolüne bırakan, çok organizasyonlu bir e-posta kontrol panelidir. Her
adım değiştirilemez bir denetim kaydına yazılır.

Bu belge sistemin 1.0.0 sürümündeki tam hâlini anlatır: ne yaptığı, nasıl
yönetildiği, ne kadar güvenli olduğu, nasıl kurulduğu ve neleri yapmadığı.

---

## İçindekiler

1. [Sürüm özeti](#1-sürüm-özeti)
2. [Bir mailin yolculuğu](#2-bir-mailin-yolculuğu)
3. [Temel kavramlar](#3-temel-kavramlar)
4. [Mail toplama (ingestion)](#4-mail-toplama-ingestion)
5. [Jev AI analizi](#5-jev-ai-analizi)
6. [Kurallar ve kural akışları](#6-kurallar-ve-kural-akışları)
7. [Hedefler ve kanallar](#7-hedefler-ve-kanallar)
8. [İletme (forward) kanalı](#8-i̇letme-forward-kanalı)
9. [Human Review](#9-human-review)
10. [Kullanıcılar, izinler ve oturumlar](#10-kullanıcılar-izinler-ve-oturumlar)
11. [Ayarlar: neyi nereden yönetirim?](#11-ayarlar-neyi-nereden-yönetirim)
12. [Ekran rehberi](#12-ekran-rehberi)
13. [Güvenlik](#13-güvenlik)
14. [Arka plan işleri ve operasyon](#14-arka-plan-işleri-ve-operasyon)
15. [Veri modeli](#15-veri-modeli)
16. [API referansı](#16-api-referansı)
17. [Kurulum ve geliştirme](#17-kurulum-ve-geliştirme)
18. [Testler](#18-testler)
19. [Bilinen sınırlar](#19-bilinen-sınırlar)
20. [Sık sorulanlar](#20-sık-sorulanlar)
21. [Sürüm geçmişi](#21-sürüm-geçmişi)
22. [Yol haritası](#22-yol-haritası)

---

## 1. Sürüm özeti

1.0.0 ile gelenler (üretime hazırlık):

- **Docker ile kurulum.** Tek komutla Postgres, Redis, API, worker, web,
  otomatik HTTPS (Caddy, Let's Encrypt) ve yedekleme servisi. Her servis
  kendiliğinden yeniden başlar ve sağlık kontrolü vardır; dışarıya yalnızca
  80/443 açıktır. Veritabanı migration'ları API açılırken uygulanır. Bkz. 17.
- **Otomatik yedekleme.** Belirlenen aralıkta (varsayılan günde bir)
  `pg_dump` yedeği, saklama süresi (varsayılan 14 gün), boş veritabanına geri
  yükleme betiği. Uçtan uca denendi: geri yüklenen tablolardaki satır
  sayıları kaynakla birebir aynı. Bkz. 17.2.
- **Dağıtık hız sınırlama.** Sınırlar Redis üzerinden tüm API kopyalarında
  ortak; Redis'e ulaşılamazsa her kopya kendi sınırını uygular (hiçbir zaman
  tüm istekleri reddetmez). `RATE_LIMIT_PER_MINUTE` ile ayarlanır.
- **Güvenlik.** API ve web için güvenlik başlıkları, üretimde sıkı bir CSP
  (tarayıcıda 6 sayfada denendi, engellenen kaynak yok), HSTS (Caddy), ters
  proxy arkasında gerçek istemci IP'si (`TRUST_PROXY`), `pnpm audit` ile
  bilinen zafiyet 0.
- **Yük testi.** 50 eş zamanlı bağlantıyla mail listesi saniyede ~550 sayfa
  (p99 158 ms), istatistikler ~6.100 istek/sn. Bkz. `docs/load-test.md`.
- **Worker sağlığı.** Worker "çalışıyorum" sinyali bırakır; durursa üst
  çubukta ve Sistem sayfasında görünür, Docker'da sağlık kontrolüyle yeniden
  başlatılır.
- Eski tek-kutu ortam değişkenleri (`MAIL_HOST` …) artık zorunlu değil.

0.31.0 ile gelenler:

- **Yeni görünüm: “Çam ve Kil”.** Çam yeşili zemin ve adaçayı tonlu nötrler
  kaldı; Claude turuncusu vurgu rengi oldu: ana düğmeler, bağlantılar, seçili
  menü öğesi (turuncu sol çizgi ve açık turuncu zemin), seçili filtreler,
  klavyeyle seçilen review satırı, bekleyen sayısı rozeti ve genel bakışta bir
  kişinin ilgilenmesi gereken sayaçların (bekleyen review, başarısız/belirsiz
  işlem) üst kenarı. Yeşil yalnızca “yolunda” anlamında; uyarı rengi
  turuncuyla karışmasın diye hardal sarısı oldu.
- Turuncunun iki tonu var: düğme ve metinde `#B4532F` (beyaz yazıyla 5,0:1),
  işaret ve süslemede Claude turuncusu `#D97757`. Rapor grafiklerindeki yeşil
  ve turuncu çift, renk körlüğü denetiminden geçecek şekilde yeniden seçildi.
- **Yeni Genel bakış (dashboard).** Başlık ve hızlı eylemler (Raporu aç,
  Yeni kural); açık uyarılar; dört özet kart: bugün işlenen (dünle), kontrol
  bekleyen (sana atananlarla), başarısız işlem (belirsizlerle) ve son 7 günde
  doğrulanmış gönderen oranı; 7 günlük mail/spam grafiği ve yanında doğrudan
  karar verilebilen İnsan kontrolü kuyruğunun ilk 5 kaydı; işlem hattı sayıları;
  mail kutusu sağlığı ve son etkinlikler. Bir kişinin ilgilenmesi gereken
  kartların üst kenarı turuncu. `GET /stats/reports` cevabına `senderAuth: {
  checked, verified }` eklendi.
- **Yumuşak kartlar.** Liste çerçeveleri, filtre çubukları, özet kutuları ve
  giriş kartları yuvarlatılmış köşeli ve ince kenarlı; filtre düğmeleri ve
  alanları da yuvarlatıldı.
- **Worker çökmesi düzeltildi, worker durumu görünür.** Bir IMAP bağlantısı
  kurulum sırasında koparsa imapflow, kimsenin beklemediği bir hata
  bırakabiliyordu ("Connection not available", COMPRESS adımında); bu hata
  worker'ı kapattı ve eşitleme 28 Eylül'de yaklaşık 7,5 saat durdu. Artık IMAP
  sıkıştırması kapalı (tetikleyici), bu tür bağlantı artıkları worker'ı
  kapatmıyor (yalnızca uyarı olarak loglanıyor; başka her yakalanmamış hata
  yine güvenli kapanış yapar) ve worker 20 saniyede bir Redis'e "çalışıyorum"
  yazıyor. `GET /ready` cevabında `worker: { status, lastSeenAt }` var (API'nin
  kendi hazır olma durumunu etkilemez); worker durursa üst çubukta kırmızı
  **Worker durdu** ve Sistem sayfasında uyarı görünür. Not: uyarı e-postalarını
  da worker gönderdiği için bu gösterge olmadan worker'ın durması fark
  edilmiyordu.
- **Yeni logo: Nöbetçi.** Yuvarlatılmış bir rozet içinde yandan bakan kurt
  başı, turuncu göz. Uygulama simgesi (`icon.svg`, `favicon.ico`), kenar
  çubuğu, giriş, davet kabul, iletme onayı ve özet onay sayfalarında.

0.30.0 ile gelenler:

- **Yeni ad: Eumaeus.** Ürünün adı “Jev Mail”den **Eumaeus**'a değişti
  (Odysseia'da Odysseus'un sadık çobanı; sürüyü bekleyen, yabancıyı kapıda
  karşılayan kişi). Arayüz, sistem e-postaları, dokümanlar, dosya adları ve
  metrik adları yeni adı kullanır. Mailleri analiz eden **Jev AI** ayrı bir
  hizmettir; adı değişmedi.
- **Eski adla oluşturulanlar çalışmaya devam eder:**
  - `X-JevMail-Forwarded` başlıklı eski iletilmiş kopyalar hâlâ “bizim
    kopyamız” olarak tanınır (döngü koruması); yeni kopyalara
    `X-Eumaeus-Forwarded` yazılır.
  - Ad değişmeden önce gönderilen özet mailindeki tek tık bağlantıları süreleri
    dolana (7 gün) kadar çalışır.
  - `jevmail.rules` biçimindeki eski kural dışa aktarma dosyaları içe
    aktarılabilir; yeni dosyalar `eumaeus.rules` biçimindedir.
  - Tarayıcıda seçili organizasyon yeni anahtara kendiliğinden taşınır.
- **Değişmeyenler:** veritabanı adları (`jev_mail_dev`, `jev_mail_test`),
  `email.forwarded_by_jev_mail` sütunu, API anahtarlarının `jm_` öneki ve
  oturum çerezinin adı (`jm_session`). Bunlar dışarıdan görünmez; değiştirmek
  mevcut anahtarları ve oturumları geçersiz kılardı.
- **Prometheus metrikleri** `jev_mail_*` yerine `eumaeus_*` adını taşır;
  varsa panolar güncellenmelidir.

0.29.0 ile gelenler:

- **Atama e-postaları, eşikli.** Bir kişiye Human Review kaydı atanınca o
  kişiye kayıtları listeleyen bir e-posta gider. Organizasyon › Review
  policy'de “Şu kadar birikince gönder” (1–100) ayarlanır: örneğin 10 ise,
  aynı kişiye atanmış ve henüz bildirilmemiş 10 açık kayıt birikince tek bir
  e-posta gider. Bkz. 9.1.
- **Eski mailler için gönderen doğrulama.** SPF/DKIM/DMARC sonucu, orijinali
  hâlâ saklanan eski maillerde de dolduruldu (bakım işi). Bkz. 4.2.
- **Art arda hata sayısı.** Sistem sayfasında her mail kutusunun kaç kez üst
  üste eşitlenemediği görünür. Bkz. 14.2.
- **Organizasyon sayfasından Google/Microsoft ile mail kutusu ekleme** ve
  kurulmamış sağlayıcı için kurulum açıklaması. Bkz. 4.1.
- **Mail kutusu şifresini güncelleme**, reddedilen şifrede durma ve
  anlaşılır eşitleme hataları; ilk eşitleme varsayılan olarak en yeni 200
  mail. Organizasyon değiştirince önceki organizasyonun listeleri artık bir an
  bile görünmez. Bkz. 4.1, 14.2.
- **Devre dışı bırakma ve kalıcı silme.** Organizasyon önce devre dışı
  bırakılır (mail kutuları eşitlenmez, geri alınabilir), sonra sistem
  yöneticisi adını yazarak kalıcı siler. Devre dışı mail kutuları da aynı
  şekilde silinir. Mail listesinden seçilen mailler kalıcı silinebilir.
  Bkz. 11.4.

0.23.0 – 0.28.0 ile gelenler (Faz 23–28 ve öncesindeki düzeltme turu):

- **Kural değişikliğinin etkisi kaydetmeden önce** (düzeltme turu). Bir kuralı
  oluştururken, değiştirirken veya silerken son 30 günün (en fazla 500 mail)
  kararlarının nasıl değişeceği gösterilir; iş maili gibi görünen bir maili
  spam/çöp benzeri bir hedefe taşıyacak **riskli** değişiklikler ayrıca onay
  ister. Bkz. 6.3.
- **Konu kelimesine göre kural önerileri** (düzeltme turu). Review kararları
  yalnızca göndericiye göre değil, gönderici + ortak konu kelimesine göre de
  kural önerir (Türkçe büyük/küçük harf ve “ı/i” farkına dayanıklı). Bkz. 6.7.
- **Human Review hızlandı (Faz 23).** Özet mailinde her kayıt için tek tıkla
  “Spam” / “Doğru” bağlantıları; listede klavye kısayolları; bir kararı aynı
  göndericinin (isterseniz aynı konu kelimesini taşıyan) diğer açık
  kayıtlarına da uygulama. Review route'larına eksik izin kontrolleri
  eklendi. Bkz. 9.
- **“Yanlış yere gitti” düzeltmesi (Faz 24).** Mail sayfasında doğru hedef
  seçilir: mail önceki taşımadan geri alınır, doğru hedefe gider, düzeltme
  insan kararı olarak kaydedilir ve tekrarını önleyecek bir kural önerilir.
  Bkz. 6.11.
- **Kural geçmişi ve geri dönme (Faz 25).** Kural sayfasında tüm sürümler,
  koşul farkları ve eşleşme sayıları; “Bu sürüme dön” ve silinmiş kuralı geri
  getirme — etki kontrolüyle. Bkz. 6.12.
- **Senkronizasyon sağlığı (Faz 26).** Sistem sayfasında mail kutularının son
  başarılı/başarısız eşitlemesi ve (sistem yöneticisine) tüm iş kuyrukları;
  eski ve sahipsiz başarısız eşitleme işleri otomatik temizlenir. Bkz. 14.2.
- **Gönderen doğrulama (Faz 27).** Mail sağlayıcısının SPF / DKIM / DMARC
  sonucu saklanır; kurallarda `sender.spf`, `sender.dkim`, `sender.dmarc`,
  `sender.authenticated` alanları ve mail sayfasında doğrulama rozeti.
  Bkz. 4.2, 6.1.
- **Arama ve ekip çalışması (Faz 28).** Emails listesinde alıcı, hedef ve
  tarih aralığı filtreleri (URL'de saklanır); Human Review kayıtlarını bir
  üyeye atama, “Bana atananlar” filtresi ve denetim kaydına yazılan notlar.
  Bkz. 9.1, 12.

0.22.0 ile gelenler (Faz 22 — Özel Jev soruları ve yeni koşullar):

- **Organizasyona özel Jev soruları.** Organizasyon › Jev questions: en fazla
  20 soru (evet/hayır, seçenekli, seviye). Her yeni maile yerleşik 8 soruyla
  birlikte, aynı istekte sorulur; cevap kurallarda `answers.<anahtar>` olarak
  kullanılır. Bkz. 5.1.
- **Dört yeni koşul alanı** (mailin geldiği ana göre hesaplanır):
  `email.business_hours`, `email.is_reply`, `sender.first_email`,
  `sender.emails_last_24h`. Bkz. 6.1.
- **Mesai saatleri** (Organizasyon › Working hours) — `email.business_hours`
  için.
- **Yeniden işlemede “Jev'e yeniden sor”.** Eski maillerin yeni sorulara cevap
  alması için. Bkz. 6.8.
- **Kural editörü** alan listesini organizasyona göre sunucudan alır (özel
  sorular dahil).

0.21.0 ile gelenler (Faz 21 — Türkçe arayüz):

- **Arayüz Türkçe ve İngilizce.** Üst çubukta ve giriş ekranında dil seçimi.
  Seçim tarayıcıda (çerez) ve hesapta saklanır; hiç seçilmemişse tarayıcının
  dili kullanılır. Bkz. 10.5.
- **Sistem e-postaları iki dilli.** Davet, Review özeti ve uyarılar üyenin
  kendi dilinde; iletme onayı, iletilen maillerin üstündeki not ve iletme
  özetleri organizasyonun dilinde (Organizasyon ayarı).
- **Tarih ve sayılar** seçili dile göre biçimlenir (27 Eyl 2026 14:05 /
  Sep 27, 2026, 2:05 PM; “3 dk önce” / “3 min ago”).

0.20.0 ile gelenler (Faz 20 — Saklama, dışa aktarım, API anahtarları, SSO):

- **Saklama süreleri.** Organizasyon başına: mail içeriği N gün sonra silinir
  (konu, analiz ve karar kalır), mailin tamamı M gün sonra silinir. Saatlik
  bakım işi uygular. Bkz. 11.2.
- **KVKK / GDPR silme.** Bir gönderici adresine ait her şey tek seferde
  silinir; önce kaç kayıt gideceği gösterilir, adres yeniden yazılarak
  onaylanır. Denetim kaydında adresin kendisi değil, yalnızca özeti kalır.
- **Audit dışa aktarımı.** Tarih aralığıyla CSV, akış halinde; Excel'de Türkçe
  karakterler doğru görünür, formül enjeksiyonuna karşı korumalı. Bkz. 11.3.
- **API anahtarları.** Organizasyon başına, seçili izinlerle; sahibinin
  izinlerini aşamaz; yalnızca özeti saklanır; süre sonu, son kullanım ve iptal.
  Bkz. 10.3.
- **Google / Microsoft ile giriş (SSO).** Faz 17'nin uygulama kaydıyla;
  yalnızca hesabı olan kişiler, isteğe bağlı alan adı kısıtı, MFA korunur.
  Bkz. 10.4.
- Yeni izinler: `privacy:erase`, `api_keys:manage`.

0.19.0 ile gelenler (Faz 19 — Otomatik yanıt ve hazır entegrasyonlar):

- **Otomatik yanıt kanalı (`auto_reply`).** Göndericiye şablonla cevap verir.
  Otomatik mesajlara, bültenlere, posta listelerine, no-reply adreslerine ve
  spam'e asla cevap vermez; aynı kişiye belirlenen sürede (varsayılan 7 gün)
  tek yanıt gider. Yanıtlar günlük giden mail limitine sayılır.
- **Slack ve Microsoft Teams kanalları.** Mailin konusu, göndereni, Jev
  özeti ve Eumaeus'a link içeren biçimlendirilmiş mesaj.
- **Jira ve Zendesk kanalları.** Mail için kayıt açar; açılan kaydın numarası
  (SUP-42, #77) ve linki mailin sayfasında görünür.
- **Kuralları JSON olarak dışa/içe aktarma.** Rules ekranında **Export JSON**
  aktif kuralları dosya olarak indirir; **Import JSON** hazır bir kural setini
  (dosya veya yapıştırılan JSON) önce kontrol eder, sonra tek seferde ekler.
  Bkz. Bölüm 6.10.
- **Raporlarda host görünümü.** Sistem yöneticisi (superAdmin) Reports
  ekranında “All organizations” seçerek bütün organizasyonları aynı anda görür:
  toplamlar ve her organizasyon için bir satır (kutu sayısı, mail, spam, cevap
  bekleyen, Human Review'da bekleyen, başarısız işlem, açık uyarı, son mail).
  Satıra tıklayınca o organizasyonun raporuna geçilir. Yalnızca Reports'ta;
  uygulamanın geri kalanı organizasyon organizasyon çalışır. API:
  `GET /api/v1/admin/reports?days=30&tz=Europe/Istanbul` (superAdmin değilse 403).
- **Başlık bilgileri.** Ingestion artık Auto-Submitted, Precedence, List-Id,
  Reply-To ve gönderen adını saklar.

0.18.0 ile gelenler (Faz 18 — Operasyon):

- **Uyarılar.** Her 5 dakikada bir sorunlar kontrol edilir: 30 dakikadır
  senkronlanamayan mail kutusu, süresi dolan oturum, son bir saatte işlemlerin
  yarısından fazlasının başarısız olması, Jev hataları, gönderilemeyen
  iletmeler. Açık sorunlar Overview'ın en üstünde görünür; organizasyonu
  yönetebilen üyelere e-posta ve isteğe bağlı webhook ile bildirilir. Sorun
  düzelince uyarı kendiliğinden kapanır ve “düzeldi” bildirimi gider.
- **Yeniden işleme.** Bir mail bugünkü kurallar, listeler ve akışlarla tekrar
  yönlendirilebilir; yeni kararın işlemleri gerçekten çalışır. Eski karar
  silinmez, “yerini aldı” olarak geçmişte kalır. Önce ne olacağı ücretsiz
  olarak görülebilir. Yeni izin: `emails:reprocess`.
- **Raporlar.** 7/30/90 günlük dönemler için: gelen mail, spam oranı, cevap
  bekleyenler, kategoriler, maillerin nereye gittiği, en çok çalışan kurallar,
  işlem sonuçları ve Human Review'un ne kadar sürede çözüldüğü.

0.17.0 ile gelenler (Faz 17 — Gmail ve Microsoft 365 ile oturum açarak bağlama):

- **Şifresiz bağlama.** Mailboxes ekranında **Connect Gmail** ve **Connect
  Microsoft 365** düğmeleri. Kullanıcı sağlayıcıda oturum açıp izin verir;
  App Password gerekmez. IMAP bağlantısı OAuth (XOAUTH2) ile kurulur.
- **Otomatik yenileme.** Erişim token'ı süresi dolmadan yenilenir. Oturum iptal
  edilirse (şifre değişikliği, erişimin kaldırılması) mail kutusu “Sign-in
  expired” durumuna geçer, senkron durur ve **Reconnect** düğmesi çıkar.
- **Settings'ten yönetim.** Google ve Microsoft uygulama bilgileri (client ID,
  secret, Microsoft tenant) Settings'ten girilir; kaydedilecek yönlendirme
  adresleri ekranda hazır gösterilir.

0.16.0 ile gelenler (Faz 16 — Gönderici listeleri ve öneriler):

- **VIP (izin) listesi.** Listedeki göndericilerin mailleri olduğu yerde
  bırakılır: hiçbir kural çalışmaz, hiçbir işlem yapılmaz, Human Review'a
  düşmez.
- **Engel listesi.** Listedeki göndericilerin mailleri kurallardan önce
  organizasyonun seçtiği engel hedefine gider (seçilmemişse Human Review).
- **Review'dan öneriler.** Son 30 günde en az 5 maili aynı şekilde (%90 spam
  ya da %90 onay) çözülen göndericiler için “engelle” veya “izin ver” önerisi.
  Aynı şirketten birden fazla adres varsa alan adı önerilir; Gmail gibi
  herkese açık sağlayıcılar için asla alan adı önerilmez.
- **Önce dene.** Yeni bir liste kaydı da, kural gibi, kaydedilmeden geçmiş
  maillerde denenebilir.

0.15.0 ile gelenler (Faz 15 — Bayrak, etiket ve geri alma):

- **Bayrak/etiket kanalı (`flag`).** Maili taşımadan okundu yapar, yıldızlar
  ve etiket ekler. Gmail'de etiketler gerçek Gmail etiketi olur; diğer
  sunucularda IMAP anahtar kelimesi olarak eklenir.
- **Taşımadan önce bayrak.** Klasöre taşıma kanalı, maili taşımadan hemen önce
  aynı bayrakları kendisi uygulayabilir (ör. “okundu yap ve Junk'a taşı”).
- **Taşımayı geri al.** Emails ekranında her başarılı taşımanın yanında
  **Undo move** düğmesi. Mail, taşındığı klasörden geldiği klasöre geri
  döner. Eumaeus geri dönen maili tanır ve tekrar yönlendirmez. Yeni izin:
  `action_executions:undo`.
- **Taşımanın izi.** Her taşıma artık mailin nereden nereye gittiğini ve
  (sunucu bildiriyorsa) hedef klasördeki yeni UID'sini kaydeder.

0.14.0 ile gelenler (Faz 14 — Deneme modu ve kural istatistikleri):

- **Geçmiş maillerde dene.** Kural ve kural akışı editörlerinde, formdaki
  kaydedilmemiş hâli daha önce gelmiş mailler üzerinde çalıştıran bir panel.
  Kaç mailin bu kurala düşeceğini, hangi maillerin kararının değişeceğini,
  hedeflere dağılımı ve örnek mailleri gösterir. Hiçbir şey kaydedilmez,
  hiçbir mail taşınmaz, Jev yeniden çağrılmaz.
- **Canlı motorla birebir aynı karar.** Karar mantığı tek bir fonksiyonda
  toplandı; canlı motor ve simülasyon aynı fonksiyonu kullanır. Gerçek veride
  doğrulandı: 698 maillik bir organizasyonda mevcut kural setinin simülasyonu,
  canlı kararların hepsiyle aynı çıktı.
- **Kural istatistikleri.** Rules listesinde her kuralın son 30 ve 7 günde kaç
  maile uyduğu ve en son ne zaman uyduğu. Maillerin ulaştığı ama hiç
  eşleşmediği kurallar “No matches in 30 days” rozetiyle işaretlenir.

0.13.1 ile gelenler (bakım sürümü):

- **SMTP test maili.** Settings'te “Send test email” düğmesi kayıtlı ayarlarla
  gerçek bir mail gönderir; başarısız olursa hatayı ve anlaşılır bir ipucu
  gösterir (TLS uyumsuzluğu, kimlik doğrulama, erişilemeyen sunucu, reddedilen
  gönderen).
- **Port/TLS uyumsuzluk koruması.** Port 587 ile implicit TLS açık ya da port
  465 ile kapalı kaydedilmek istenirse arayüz yazarken uyarır, API reddeder.
  Gerçekten farklı çalışan sunucular için “yine de kaydet” onayı vardır.
- **Hedef oluşturma bütünlüğü.** Yeni hedef oluşturulurken kanallardan biri
  hatalıysa artık hiçbir şey oluşturulmaz (önceden kanalsız bir hedef
  kalıyordu).

0.13.0 ile gelenler (Faz 13 — İletme):

- **İletme kanalı.** Bir hedef, maili başka e-posta adreslerine iletebilir. Üç
  iletme şekli (ek olarak, klasik Fwd:, yönlendirme), To/Cc/Bcc, gönderen adı,
  yanıt adresi, konu şablonu, ekler ve Jev analiz notu kullanıcı tarafından
  seçilir.
- **Tek tek veya özet halinde gönderim.** Bir iletme kanalı her maili hemen
  iletebilir ya da mailleri biriktirip belirlenen aralıkta (15 dakika – 1 hafta)
  tek bir özet mail olarak gönderebilir.
- **Alıcı onayı.** İletme yapılacak her yeni adrese onay maili gider; adresin
  sahibi onaylamadan o adrese hiçbir şey gönderilmez.
- **Güvenlik önlemleri.** Döngü koruması, organizasyon bazlı günlük limit ve
  isteğe bağlı alan adı izin listesi.
- **Orijinal mailin saklanması.** Gelen her mailin orijinal MIME kaynağı
  (ekleriyle) ayarlanabilir süre boyunca saklanır (varsayılan 14 gün).
- **Bakım kuyruğu.** Süresi dolan orijinal kopyalar saatte bir silinir.

Önceki sürümlerden gelen her şey (IMAP toplama, Jev analizi, kural motoru, kural
akışları, klasöre taşıma ve webhook, Human Review ve özet maili, kullanıcılar,
izinler, MFA, sistem ayarları) bu sürümde de aynen çalışır.

---

## 2. Bir mailin yolculuğu

```
Mail kutusu (IMAP)
      │  düzenli kontrol (varsayılan 60 sn)
      ▼
Toplama ──► Email kaydı + orijinal kaynak (EmailSource)
      │
      ▼
Jev AI analizi ──► 8 sorunun cevabı (AnalysisResult)
      │
      ▼
Karar
  1. Jev "insan bakmalı" diyor ve eşik aşıldı  ──► Human Review
  2. Mail kutusuna açık bir kural akışı atanmış ──► akışın kararı
  3. Değilse düz kurallar (öncelik sırası, ilk eşleşen kazanır)
  4. Hiçbiri eşleşmedi                          ──► Human Review
      │
      ▼
Hedef ──► kanalları paralel çalışır
          • archive : IMAP klasörüne taşı
          • webhook : imzalı HTTP POST
          • forward : başka adreslere ilet (hemen veya özet)
      │
      ▼
Denetim kaydı (her adım, değiştirilemez)
```

**Örnek.** `kampanya@odul-merkezi.biz` adresinden “Tebrikler, 5.000 TL
kazandınız!” konulu bir mail gelir.

| Adım | Ne olur |
|---|---|
| Toplama | Senkron döngüsü maili `INBOX` klasöründe bulur, kaydeder, orijinalini saklar. |
| Jev | `is_spam = 0.94`, `category = marketing`, `urgency = low`. |
| Karar | “Spam'i Junk'a taşı” kuralı eşleşir (`answers.is_spam >= 0.8`). |
| Uygulama | “Spam klasörü” hedefi maili IMAP ile `Junk` klasörüne taşır. Silmez. |
| Kayıt | Emails ekranında analiz, karar, işlem ve tüm olaylar tek sayfada görünür. |

---

## 3. Temel kavramlar

| Kavram | Anlamı |
|---|---|
| **Organizasyon** | Bir şirket veya ekip. Mail kutuları, kurallar, hedefler ve kayıtlar organizasyona aittir; organizasyonların verisi birbirinden tamamen ayrıdır. |
| **Mail kutusu** | Bağlanan bir e-posta hesabı: sunucu, kullanıcı adı, şifre, izlenen klasör. Şifre şifrelenmiş saklanır. |
| **Analiz** | Jev AI'nın bir mail için verdiği cevaplar. |
| **Kural** | “Şu koşul sağlanırsa maili şu hedefe gönder.” Öncelik numarası vardır. |
| **Kural akışı** | Adım adım dallanan karar ağacı. Bir mail kutusuna atanınca o kutunun kararlarını verir. |
| **Hedef** | Kararın uygulandığı yer. Bir veya daha fazla kanaldan oluşur. |
| **Kanal** | Hedefin içindeki tek bir işlem: `archive`, `webhook` veya `forward`. |
| **Yönlendirme kararı** | Bir mail için verilen nihai karar ve gerekçesi (hangi kural/akış, hangi hedef, hangi yol). |
| **İşlem (action execution)** | Bir kanalın bir mail için bir kez çalıştırılması ve sonucu: başarılı, başarısız, belirsiz. |
| **Human Review** | Sistemin karar veremediği maillerin insan kontrolü için beklediği sıra. |
| **İletme alıcısı** | İletme kanalının gönderdiği bir adres. Onaylanmadan kullanılmaz. |
| **Üyelik** | Bir kullanıcının bir organizasyona erişimi ve oradaki izinleri. |
| **Denetim kaydı** | Sistemde olan her şeyin zaman damgalı, değiştirilemez kaydı. |

---

## 4. Mail toplama (ingestion)

- Mailler **IMAP** ile, sunucuya zaten düşmüş mesajlar olarak çekilir. UID
  aralığı üzerinden artımlı çalışır; aynı mail iki kez kaydedilmez (veritabanı
  seviyesinde benzersizlik).
- Her mail kutusu için ayrı bir zamanlayıcı vardır. Aralık Settings'ten
  ayarlanır (varsayılan 60 saniye). “Reconcile now” düğmesi anında kontrol eder.
- İlk bağlantıda en fazla `MAIL_INITIAL_SYNC_LIMIT` kadar eski mail alınır.
- Sunucu UID'leri sıfırlarsa (UIDVALIDITY değişimi) bu tespit edilir, eski
  kayıtlara dokunulmaz, yeni bir başlangıç noktasından devam edilir.
- Her mail kutusunun kendi şifresi vardır; AES-256-GCM ile şifreli saklanır.
- **Google / Microsoft ile bağlama (0.17.0).** Gmail ve Microsoft 365 kutuları
  şifre yerine sağlayıcıda oturum açılarak bağlanabilir (bölüm 4.1).

### 4.1 Gmail ve Microsoft 365 ile oturum açarak bağlama

**Kurulum (bir kez, süper admin):**

1. *Google:* Google Cloud Console › APIs & Services › Credentials › OAuth
   client ID (Web application). Gmail API etkin olmalı; kapsam
   `https://mail.google.com/`. Yalnızca kendi Workspace alanınız için
   kullanılacaksa onay ekranı **Internal** olarak ayarlanır; dışarıya açık
   kullanım Google'ın güvenlik incelemesini gerektirir.
2. *Microsoft:* Azure portal › App registrations › New registration (Web).
   API izinleri: Office 365 Exchange Online › `IMAP.AccessAsUser.All` ve
   `offline_access`. Certificates & secrets altında bir client secret oluşturun.
3. Settings › **Mailbox sign-in** kartındaki yönlendirme adreslerini
   (`<uygulama adresi>/api/v1/mailboxes/oauth/google/callback` ve
   `.../microsoft/callback`) sağlayıcıdaki uygulamaya ekleyin; client ID ve
   secret'ı bu karta girin. Microsoft için tenant: `common` (her hesap) ya da
   kendi dizin kimliğiniz.

**Bağlama:** Mailboxes › **Connect Gmail** / **Connect Microsoft 365** →
sağlayıcıda oturum aç ve izin ver → Mailboxes ekranına dönülür, kutu eklenmiş
olur ve ilk senkron bir dakika içinde başlar.

Aynı düğmeler **Organizasyon › Add mailbox** sekmesinde de vardır (0.29):
kutu o organizasyona eklenir ve dönüş o organizasyonun sayfasına olur. Düğmeler
kurulum yapılmamışken de görünür; tıklanınca süper admine kurulum özeti ve
Settings › Mailbox sign-in bağlantısı, diğer üyelere “yöneticinize başvurun”
açıklaması çıkar. Settings kartında Google için 4 adımlık kurulum listesi
vardır. *Not:* Google, kayıtlı bir uygulama (client ID) olmadan hiçbir
uygulamaya oturum açtırmaz; Eumaeus kendi sunucunuzda çalıştığı için bu
kaydı her kurulum kendisi bir kez yapar.

**Güvenlik:**

- Yetkilendirme kodu akışı ve PKCE kullanılır. Başlatma kaydı (`state`) tek
  kullanımlıktır, 10 dakika geçerlidir ve akışı başlatan oturumla eşleşmek
  zorundadır; başkasının başlattığı bir bağlantı sizin organizasyonunuza hesap
  ekleyemez.
- Access ve refresh token'lar AES-256-GCM ile şifreli saklanır; hiçbir API
  cevabında dönmez. Client secret'lar da öyle.
- Access token süresi dolmadan 5 dakika önce yenilenir. Sağlayıcı yenilemeyi
  `invalid_grant` ile reddederse kutu “Sign-in expired” (`reauth_required`)
  olur ve senkronu durdurulur. Ağ hataları geçici sayılır, kutunun durumunu
  değiştirmez.
- **Reconnect** aynı kutuyu yeniden bağlar; farklı bir hesapla oturum açılırsa
  reddedilir.
- OAuth ile bağlanan kutuda sunucu, port, kullanıcı adı ve şifre
  değiştirilemez; bunlar sağlayıcıya aittir.
- **Orijinal kaynak (0.13.0).** Mailin ham MIME hâli, ekleriyle birlikte
  `EmailSource` tablosunda saklanır. Süre Settings › *Keep original messages*
  ile ayarlanır (varsayılan 14 gün, 0 = saklama). 25 MB'tan büyük mailler
  saklanmaz. İletme kanalı maili bu kopyadan gönderir; kopya yoksa sadece
  metin gövdesiyle, eksiz iletir.
- **İletme işareti.** Eumaeus'un kendi ilettiği mailler `X-Eumaeus-Forwarded`
  başlığı taşır. Böyle bir mail bir kutuya geri gelirse işaretlenir ve bir daha
  iletilmez.

**Şifreyi güncelleme** (0.29): şifreyle bağlı her kutunun satırında
**Şifreyi güncelle** vardır (kullanıcı adı da değiştirilebilir). Gmail
(`imap.gmail.com`) normal şifreyi IMAP'te kabul etmez: iki adımlı doğrulama
açıkken Google Hesabı › Güvenlik › Uygulama şifreleri'nden alınan 16 karakterlik
şifre girilir; pencere bunu hatırlatır.

**İlk eşitleme sınırı** (0.29): yeni bağlanan bir kutunun ilk eşitlemesi en
yeni **200** maili okur (`MAIL_INITIAL_SYNC_LIMIT`; `all` = hepsi). Önceden
boş bırakılınca kutudaki bütün mailler indirilip Jev'e soruluyordu.

### 4.2 Gönderen doğrulama (SPF / DKIM / DMARC)

0.27'den itibaren gelen her mailde, **mail sağlayıcısının** gönderen hakkında
verdiği sonuç saklanır. Eumaeus DNS'e kendisi bakmaz; SMTP oturumunu gören
sağlayıcının kararını okur.

- Okunan başlık: mesajdaki **en üstteki** `Authentication-Results` (RFC 8601).
  Başlıklar mail yol alırken üste eklenir; en üstteki son durağın, yani mail
  kutusu sağlayıcısınındır. Gönderenin mesaja koyduğu sahte
  `Authentication-Results` başlıkları bunun altında kalır ve okunmaz.
- `Authentication-Results` yoksa `Received-SPF` okunur (yalnızca SPF; DKIM ve
  DMARC bilinmez kalır).
- **Doğrulanmış gönderen** (`sender.authenticated`): DMARC geçti, ya da SPF
  veya DKIM, From alan adıyla hizalı bir alan adı için geçti (eşit ya da biri
  diğerinin alt alan adı).
- Mail sayfasında başlığın altında rozet: “Doğrulanmış gönderen” / “Gönderen
  doğrulanmadı”, yanında SPF, DKIM, DMARC sonuçları ve kontrol eden sunucu.
- 0.27'den önce gelen mailler, orijinali hâlâ saklanıyorsa (varsayılan 14
  gün) saatlik bakım işiyle doldurulur. Orijinali artık olmayan eski
  maillerde değer **bilinmez**: rozet görünmez, koşullar eşleşmez. Sağlayıcı
  hiçbir sonuç eklememişse rozet bunu söyler. Doldurma, verilmiş kararları
  değiştirmez; deneme, yeniden işleme ve rozette kullanılır.
- Sınır: hiç `Authentication-Results` eklemeyen bir sağlayıcıda, gönderenin
  koyduğu başlık en üstte kalabilir. Yaygın sağlayıcıların (Gmail, Microsoft
  365, Hostinger, Yandex, cPanel/Exim) hepsi ekler.

---

## 5. Jev AI analizi

Jev her maile aynı 8 soruyu sorar. Evet/hayır sorularının cevabı 0 ile 1
arasında bir olasılıktır. Kurallarda bu alanlara `answers.` önekiyle başvurulur.

| Alan | Tip | Soru |
|---|---|---|
| `is_spam` | 0–1 | Spam mı? |
| `category` | seçim | sales, business_opportunity, collaboration, invoice, support, job_offer, marketing, personal, customer_message, other |
| `is_business_opportunity` | 0–1 | İş fırsatı mı? |
| `is_collaboration` | 0–1 | İş birliği teklifi mi? |
| `is_customer_related` | 0–1 | Müşteriyle ilgili mi? |
| `requires_response` | 0–1 | Cevap bekleniyor mu? |
| `urgency` | seviye | low, medium, high, critical |
| `human_review_required` | 0–1 | Bir insan bakmalı mı? |

Ek olarak `answers.category.confidence` ve `answers.urgency.confidence`
kullanılabilir. Jev geçici olarak cevap vermezse (ör. 503) istek otomatik olarak
yeniden denenir.

### 5.1 Organizasyona özel sorular

Jev'de sorular sunucuda sabit değildir; her istekte soruları Eumaeus gönderir
(docs.typesafe.ai/api.md: “You choose each key.”). Bu yüzden bir organizasyonun
kendi soruları, o organizasyonun maillerinde yerleşik 8 sorunun yanına eklenir.

- **Yeri:** Organizasyon › **Jev questions**. Okumak `rules:read`, eklemek,
  düzenlemek ve silmek `rules:write` ister.
- **Tipler:** evet/hayır (0–1 olasılık), seçenekli (2–50 seçenek; seçenek adı
  kuralda karşılaştırılan değerdir), seviye (2–10 sıralı seviye, düşükten
  yükseğe; cevap 0…N-1 arası ağırlıklı ortalama). Seçenekli ve seviye soruları
  için `answers.<anahtar>.confidence` da vardır.
- **Anahtar:** küçük harf, rakam ve alt çizgi (2–40 karakter); yerleşik soru
  adları kullanılamaz. Anahtar ve tip sonradan değişmez (kurallar cevabın
  biçimine dayanır); soru metni ve seçenekler düzenlenebilir. Silinen bir
  sorunun anahtarı yeniden kullanılamaz (eski analizler anlamını korusun diye).
- **Sınır:** organizasyon başına 20 aktif soru; soru metni en fazla 1.000
  karakter.
- **Güvenlik:** soru metinleri yöneticilerce yazılır; mail içeriği hiçbir zaman
  soruya karışmaz, yalnızca Jev'in `state` alanında gider (yerleşik sorularla
  aynı ayrım).
- **Dayanıklılık:** Jev özel bir soruya eksik veya bozuk cevap verirse analiz
  yine başarılı sayılır; yalnızca o cevap kaydedilmez ve denetim kaydında
  `customQuestionsSkipped` olarak görünür. O alanı okuyan kural o mailde
  eşleşmez.
- **Silme:** soruyu kullanan aktif kural veya kural akışı varsa silme
  reddedilir ve hangileri olduğu gösterilir; yine de silinebilir (kurallar o
  alanda eşleşmemeye başlar).
- **Eski mailler:** soru eklenmeden önce gelmiş maillerde cevap yoktur. Cevap
  almak için mailde Reprocess › **Ask Jev again** (bölüm 6.8).
- **Maliyet:** Jev yalnızca gönderilen metin için ücret alır (milyon token
  başına $0,042; cevaplar ücretsiz). Bir soru kabaca 50–150 token ekler; sorular
  paralel değerlendirildiği için yanıt süresi pek değişmez. Sınırlar: istek
  başına 64k token (mail + en uzun soru 32k), dakikada 1.200 istek.

---

## 6. Kurallar ve kural akışları

### 6.1 Koşullar

Kullanılabilen alanlar:

- **Mail:** `sender.address`, `sender.domain`, `recipient.address`, `subject`,
  `has_attachment`, `attachment.filename`
- **Jev:** bölüm 5'teki alanlar ve organizasyonun kendi soruları (5.1)
- **Geliş bağlamı** (0.22; mailin geldiği ana göre hesaplanır, simülasyon ve
  canlı karar aynı sonucu verir):

| Alan | Tip | Anlamı | Bilinmediğinde |
|---|---|---|---|
| `email.business_hours` | evet/hayır | Organizasyonun mesai saatleri içinde geldi (saat dilimine göre; bitiş başlangıçtan erkense gece vardiyası) | Mesai saati ayarlanmamışsa |
| `email.is_reply` | evet/hayır | `In-Reply-To` veya `References` başlığı var | 0.22'den önce gelen maillerde |
| `sender.first_email` | evet/hayır | Bu organizasyonda bu adresten daha önce mail yok (büyük/küçük harf duyarsız) | — |
| `sender.emails_last_24h` | sayı | Bu adresten, bu mailden önceki 24 saatte gelen mail sayısı | — |
| `sender.spf` | metin | Sağlayıcının SPF sonucu: `pass`, `fail`, `softfail`, `neutral`, `none`, `temperror`, `permerror` (0.27) | 0.27'den önce gelen ya da sonuç taşımayan maillerde |
| `sender.dkim` | metin | Sağlayıcının DKIM sonucu (birden çok imzada en iyisi) | aynı |
| `sender.dmarc` | metin | Sağlayıcının DMARC sonucu | aynı |
| `sender.authenticated` | evet/hayır | Doğrulanmış gönderen (bkz. 4.2) | aynı; yalnızca `Received-SPF` varsa ve SPF kanıtlamadıysa da |

Bilinmeyen alan hiçbir koşulu sağlamaz. Gönderici geçmişi yalnızca Eumaeus'un
hâlâ tuttuğu maillere bakar; saklama süresi ve KVKK silmesi geçmişi kısaltır.
Örnek: `sender.first_email == true AND answers.category == "sales"` → yeni
potansiyel müşteri. `sender.domain == "banka.com" AND sender.authenticated ==
false` → banka taklidi.

`contains` (0.23'ten beri) büyük/küçük harf ve Türkçe “İ/ı” farkını yok sayar:
`FATURA`, `Fatura` ve `fatura` aynıdır; `İndirim` `indirim` ile eşleşir.

Karşılaştırmalar: `==`, `!=`, `>=`, `<=`, `>`, `<`, `in`, `contains`. Koşullar
`AND`, `OR` ve `NOT` ile birleştirilebilir. Çözülemeyen bir alan (ör. analiz
yoksa) hiçbir karşılaştırmayı sağlamaz; sistem emin olmadığında eşleşme saymaz.

### 6.2 Karar sırası

0. Gönderici **VIP listesindeyse** → mail olduğu gibi bırakılır. **Engel
   listesindeyse** → engel hedefine gider. Bu adım analizden bile önce gelir;
   Jev maili analiz edememiş olsa da çalışır.
1. Organizasyonda sinyal açıksa ve `human_review_required` eşiği (varsayılan
   0.5) aşıyorsa → Human Review. Eşik Organizasyon › Review policy'den değişir.
2. Mail kutusuna **açık** bir kural akışı atanmışsa → akışın kararı. Akış
   hatalıysa (döngü, olmayan adım) → Human Review.
3. Değilse düz kurallar, öncelik numarasına göre küçükten büyüğe. İlk eşleşen
   kazanır.
4. Hiçbiri eşleşmezse → Human Review.

### 6.3 Düz kurallar

Rules ekranından oluşturulur. Her düzenleme yeni bir sürüm oluşturur; geçmiş
kararlar hangi sürümle verildiğini korur. Hedef olarak bir hedef adı veya özel
`human_review` değeri seçilir.

**Kaydetmeden önce etki.** Kural oluşturma, düzenleme ve silme ekranlarında
**Impact** paneli, değişikliğin son 30 gündeki (en yeni 500 mail) kararları
nasıl değiştireceğini gösterir: kaç mail etkilenir, hangi hedeften hangisine
geçer, kuralın önündeki hangi kuralların onu gölgelediği ve örnekler. Hesap
canlı motorla aynı karar çekirdeğini kullanır.

- **Riskli değişiklik:** iş maili gibi görünen (müşteri, finans veya güvenlik
  maili) bir maili spam veya çöp benzeri bir hedefe taşıyacak değişiklik. Bu durumda kayıt, ayrıca onay verilmeden yapılmaz (API:
  `confirmImpact: true`).
- API: `POST /rules/impact` (salt okunur); `POST/PATCH/DELETE /rules`
  riskliyse `409` ve etki raporu döner.

### 6.4 Geçmiş maillerde deneme

Kural editöründe (yeni veya düzenlenen kural) ve kural akışı editöründe
**Try on past emails** paneli bulunur. Seçenekler: dönem (son 7 / 30 / 90 gün
veya tümü), mail kutusu ve en fazla kaç mail (en yeni 200 / 500 / 1000).

- **Kural:** Taslak, mevcut aktif kuralların arasına öncelik numarasıyla
  yerleştirilir. Mevcut bir kuralı düzenliyorsanız o kuralın yerine geçer.
  Aynı öncelik numarası başka bir kuralda varsa, kaydetmede olacağı gibi hata
  verilir.
- **Kural akışı:** Kapsamdaki tüm maillere, akış mail kutularına atanmış ve
  açıkmış gibi uygulanır.
- Canlı sistemdeki sıra aynen korunur: Jev'in review sinyali önce gelir; bir
  mail kutusuna atanmış akış varsa o kutunun mailleri için taslak kural
  uygulanmaz (panel bunu ayrıca sayar).
- Sonuçlar: kontrol edilen mail sayısı, taslağın alacağı mail sayısı,
  kararı değişecek mail sayısı, Human Review'a gidecek sayı, hedeflere
  dağılım ve değişenler önde olmak üzere 20 örnek (önceki karar → yeni karar,
  maile link).
- Analizi olmayan mailler yalnızca Human Review'a gidebilir; panel bunları
  ayrıca belirtir.

### 6.5 Kural istatistikleri

Rules listesindeki **Matches (30 days)** sütunu, kuralın bu sürümünün son 30
günde kaç maile uyduğunu, bunun kaçının son 7 günde olduğunu ve son eşleşme
zamanını gösterir. Bir kural düzenlenince yeni sürüm oluşur ve sayılar o
sürümden itibaren başlar. Mailler ulaştığı hâlde hiç eşleşmeyen açık kurallar
uyarı rozetiyle işaretlenir; henüz hiçbir mailin ulaşmadığı kurallar “Not
reached yet” olarak görünür.

### 6.6 VIP ve engel listeleri

**Sender lists** ekranından yönetilir (izin: görmek için `rules:read`,
değiştirmek için `rules:write`).

- Bir kayıt ya tam adrestir (`ceo@acme.com`) ya da alan adıdır (`acme.com`
  veya `@acme.com`). Alan adı alt alan adlarını da kapsar: `acme.com`,
  `x@mail.acme.com` ile eşleşir; `notacme.com` ile eşleşmez.
- Birden fazla kayıt eşleşirse en özgül olan kazanır: tam adres alan adından,
  uzun alan adı kısa olandan önce gelir. Tam eşitlikte VIP kazanır; bir VIP
  yanlışlıkla engellenmez.
- Bir adres veya alan adı listelerde yalnızca bir kez bulunabilir; türünü
  değiştirmek için önce kaldırılır.
- **Engel hedefi** aynı ekranın altından seçilir (organizasyon ayarıdır,
  `organizations:write` gerekir). Seçilmemişse engelli göndericilerin mailleri
  Human Review'a düşer.
- Mailin kararında (Emails ekranı) hangi liste kaydının karar verdiği yazar.
- Ekleme formunun altındaki **Try on past emails** paneli, yeni kaydın geçmiş
  maillerden kaçını yakalayacağını ve hangilerinin kararının değişeceğini
  gösterir.

### 6.7 Review'dan öneriler

Human Review ve Sender lists ekranlarında **Suggestions from Human Review**
paneli bulunur.

| Kural | Değer |
|---|---|
| Dönem | Son 30 günde çözülen review'lar |
| Kanıt | Göndericiden en az 5 çözülmüş mail |
| Uyum | En az %90'ı aynı şekilde (spam → engel önerisi, onay → VIP önerisi) |
| Alan adı | Aynı alan adından en az 2 farklı adres uyuşuyorsa alan adı önerilir |
| Hariç | Gmail, Outlook, Yahoo, iCloud gibi herkese açık sağlayıcıların alan adları |
| Reddedilen | 90 gün boyunca tekrar önerilmez |

- **Kabul et:** gönderici önerilen listeye eklenir (“from review” olarak
  işaretlenir).
- **Reddet:** öneri kapanır.
- Öneriler saatte bir yeniden hesaplanır; **Check again** ile hemen de
  hesaplanabilir. Kanıtı artık tutmayan açık öneriler geri çekilir.
- Zaten bir listede olan göndericiler önerilmez.

**Kural önerileri** (0.23): Bir göndericinin tüm mailleri aynı karara gitmiyor
ama belirli bir konu kelimesini taşıyanları gidiyorsa, liste yerine kural
önerilir: `gönderici AND konu içerir "<kelime>"`. Koşullar: son 30 günde o
gönderici + kelimeden en az 3 çözülmüş mail ve en az %90 uyum. Kabul
edildiğinde kural, etki kontrolünden geçerek oluşturulur. Yalnızca bir insanın
karar verdiği (çözülmüş, spam/onay) kayıtlar sayılır; yeniden işlemeyle kapanan
kayıtlar sayılmaz.

### 6.8 Yeniden işleme

Bir kuralı düzelttikten sonra, daha önce gelmiş bir maili yeni kurallarla
tekrar yönlendirmek için: Emails › mail › Processing sekmesi.

- **Check with current rules:** kaydetmeden, bugünkü ayarlarla bu mailin
  nereye gideceğini gösterir (hiçbir şey değişmez).
- **Reprocess:** onaydan sonra mail bugünkü VIP/engel listeleri, akışlar ve
  kurallardan tekrar geçer; yeni kararın işlemleri (taşıma, iletme, webhook)
  çalışır. Varsayılan olarak Jev tekrar çağrılmaz, kayıtlı analiz kullanılır.
- **Ask Jev again** (0.22) işaretlenirse önce mail Jev'e yeniden sorulur
  (ücretli bir çağrı; organizasyonun güncel özel sorularıyla), yeni analiz
  kaydedilir ve karar ona göre verilir. Jev başarısız olursa hiçbir şey
  değişmez. İçeriği saklama politikasıyla silinmiş maillerde bu seçenek
  reddedilir. API: gövde `{ "reanalyze": true }` (toplu uçta da).
- Eski karar silinmez: “Earlier decisions” altında, ne zaman yerini aldığıyla
  birlikte görünür. Mailin açık Human Review kaydı kapanır; yeni karar review
  gerektiriyorsa yenisi açılır.
- **Reddedilen durumlar:** Mail daha önceki bir kararla başka bir klasöre
  taşınmışsa (ve taşıma geri alınmamışsa) yeniden işleme reddedilir; yeni bir
  taşıma maili gelen kutusunda arar ve bulamaz. Önce **Undo move**, sonra
  yeniden işleme. Mail için hâlâ çalışan bir işlem varsa da beklenir.
- Toplu yeniden işleme API'den yapılabilir (en fazla 100 mail); her mail için
  ayrı sonuç döner.
- İzin: `emails:reprocess` (işlemleri yeniden çalıştırdığı için ayrı izin).

### 6.9 Kural akışları

Rule graphs ekranından adım adım kurulur. Her adım bir koşul sorar; “doğruysa”
ve “değilse” dalları ya başka bir adıma ya da bir hedefe gider. **Check**
düğmesi kaydetmeden doğrular: döngüleri, olmayan adımları ve ulaşılamayan
adımları yakalar. Her kayıt yeni bir sürümdür. Akış açılıp kapatılabilir ve
mail kutularına atanır. **Atama anında devreye girer.** Kararın hangi akıştan ve
hangi yoldan geldiği Emails ekranında görünür.

### 6.10 Kuralları JSON olarak dışa ve içe aktarma

**Dışa aktarma:** Rules › **Export JSON**, organizasyonun aktif kurallarını
öncelik sırasıyla bir dosyaya indirir
(`eumaeus-rules-<organizasyon>-<tarih>.json`). Dosyada yalnızca kuralın kendisi
vardır: ad, öncelik, koşullar ve hedef adı. Kimlik, sürüm veya istatistik
yoktur; bu yüzden başka bir organizasyona veya başka bir Eumaeus kurulumuna
taşınabilir.

```json
{
  "format": "eumaeus.rules",
  "version": 1,
  "exportedAt": "2026-09-27T09:00:00.000Z",
  "organization": "Acme",
  "destinations": ["Junk", "Is Firsatlari"],
  "rules": [
    {
      "name": "Spam",
      "priority": 10,
      "destinationRef": "Junk",
      "conditions": { "field": "answers.is_spam", "op": ">=", "value": 0.8 }
    },
    {
      "name": "İş başvuruları",
      "priority": 20,
      "destinationRef": "Is Firsatlari",
      "conditions": {
        "op": "AND",
        "children": [
          { "field": "answers.category", "op": "==", "value": "job_offer" },
          { "field": "answers.is_spam", "op": "<", "value": 0.5 }
        ]
      }
    }
  ]
}
```

**İçe aktarma:** Rules › **Import JSON**. Dosya seçilir ya da JSON yapıştırılır.
Dışa aktarılmış dosyanın tamamı da, yalnızca `rules` dizisi de kabul edilir.

1. İki seçim yapılır:
   - **Mevcut kurallar:** *Add* (mevcutlar kalır, yeniler eklenir) veya *Replace*
     (mevcut kuralların hepsi kapatılır, yeniler eklenir; geçmiş kaybolmaz).
   - **Öncelikler:** *Put them after the current rules* (dosyanın sırası korunur,
     10, 20, 30… diye mevcut son kuralın arkasına eklenir) veya *Keep the file's
     priority numbers* (dosyadaki numaralar kullanılır; aktif bir kuralla
     çakışan numara hatadır).
2. **Check** kaydetmeden her kuralı doğrular ve sonucu gösterir.
   - **Hata:** bilinmeyen alan, alana uymayan karşılaştırma, çakışan öncelik.
     Tek bir hata bile varsa hiçbir kural eklenmez.
   - **Uyarı:** hedef adı bu organizasyonda yok. Kural yine eklenir; hedef
     oluşturulana kadar eşleşen mailler Human Review'a düşer.
3. **Import** yalnızca kontrol hatasız geçtiyse etkinleşir. Kurallar tek bir
   işlemle eklenir ve denetim kaydına `rules_imported` olarak yazılır.

Sınırlar ve izinler: bir dosyada en fazla 500 kural; dışa aktarmak için
`rules:read`, eklemek için `rules:write`, *Replace* için ayrıca `rules:delete`.
Kural akışları (rule graphs) ve VIP/engel listeleri bu dosyaya dahil değildir.

### 6.11 “Yanlış yere gitti” düzeltmesi

Emails › mail › **Correct destination** paneli (izin: `emails:reprocess`).
Doğru hedef seçilir ya da “Gelen kutusunda kalsın” denir.

1. Mail, son kararın taşıdığı klasördeyse önce **geri alınır**. Geri alma
   başarısız olursa hiçbir şey değişmez.
2. Eski karar `superseded` olur; yerine seçilen hedefe giden yeni bir karar
   yazılır (kural yok — kararı kişi verdi) ve hedefin işlemleri çalışır.
   “Gelen kutusu” seçilirse işlem yapılmaz.
3. Düzeltme bir **insan kararı** olarak kaydedilir: `human_correction`
   nedenli, çözülmüş bir Human Review kaydı (hedef spam/çöp benzeriyse
   “spam”, değilse “onay”). Liste ve kural önerileri bundan öğrenir. Mailin
   açık review kayıtları da aynı şekilde kapanır.

Ardından **Bunun için kural öner:** gönderici (ya da alan adı) + aynı yanlış
yere gitmiş diğer maillerde en çok geçen konu kelimesi, yanlış kararı veren
kuralın hemen önüne yerleştirilir. Kaydetmeden önce etki paneli gösterilir.

### 6.12 Kural geçmişi ve geri dönme

Kural sayfasında **History** bölümü (izin: görmek `rules:read`, geri dönmek
`rules:write`):

- Kuralın tüm sürümleri: ne zaman, önceki sürüme göre koşul farkı, hedef ve
  öncelik, her sürümün eşleştiği mail sayısı.
- **Bu sürüme dön:** seçilen sürümün içeriği **yeni bir sürüm** olarak
  kaydedilir; geçmiş silinmez. Önce etki önizlemesi; öncelik başka bir kuralda
  kullanılıyorsa yeni bir öncelik istenir; riskli ise onay gerekir.
- **Silinmiş kuralı geri getirme:** silinmiş bir kuralın sayfasında son
  sürümünden geri getirilir, aynı kontrollerle.
- Bir kuralın sürümleri ortak bir “soy” kimliğiyle bağlıdır (0.25'te mevcut
  kurallar ad ve organizasyona göre bağlandı).
- API: `GET /rules/:id/versions` · `POST /rules/:id/revert` (gövde:
  `version`, isteğe bağlı `priority`, `confirmImpact`). Denetim kaydı:
  `rule_reverted`.

---

## 7. Hedefler ve kanallar

Bir hedefin tüm açık kanalları, bir mail o hedefe yönlendirildiğinde paralel
olarak çalışır. Kanallar sonradan eklenir, düzenlenir (yeni sürüm) veya
kapatılır; eski sürümler geçmişte görünür.

| Kanal | Ne yapar | Önemli noktalar |
|---|---|---|
| `archive` | Maili IMAP ile istenen klasöre taşır (`Junk`, `Trash`, `Faturalar`…). İsteğe bağlı olarak taşımadan hemen önce okundu yapar, yıldızlar, etiket ekler. | Asla silmez. Bağlantı taşıma sırasında koparsa sonuç “belirsiz” sayılır ve Human Review'a düşer. Taşıma sonradan geri alınabilir (bölüm 7.1). |
| `flag` | Maili yerinde bırakır; okundu yapar, yıldızlar ve/veya etiket ekler. | Gmail'de etiketler Gmail etiketi olur, diğer sunucularda IMAP anahtar kelimesi. Bayrak eklemek tekrarlanabilir bir işlemdir, yeniden deneme güvenlidir. Mail o sırada klasörde değilse işlem “uygulanmadı” olarak kaydedilir. |
| `webhook` | Mail bilgisini HTTP POST ile gönderir. | `X-Jev-Signature` (HMAC-SHA256) ile imzalanabilir. İç ağ adreslerine istek atılamaz; kontrol her gönderimde yapılır. URL API'de yalnızca alan adıyla gösterilir. |
| `forward` | Maili başka e-posta adreslerine iletir. | Bölüm 8. |
| `auto_reply` | Göndericiye şablonla cevap verir. | Bölüm 7.2. |
| `email_notify` | Kural bu hedefe mail yönlendirdiğinde seçilen kişilere kısa bir bildirim e-postası gönderir (1.2). | Bölüm 7.4. |
| `slack` / `teams` | Kanala biçimlendirilmiş mesaj gönderir (incoming webhook). | URL bir şifre gibidir; yalnızca alan adı gösterilir. İç ağ adreslerine gönderilmez. |
| `jira` / `zendesk` | Mail için Jira issue'su / Zendesk ticket'ı açar. | API token'ı hedefin şifreli sırlarında durur. Bağlantı gönderimden sonra koparsa sonuç “belirsiz” sayılır ve aynı kayıt iki kez açılmasın diye tekrar denenmez. |

**Özel hedef:** `human_review` — mail işlem görmeden Human Review'a düşer.

**Bayrak ve taşıma aynı hedefte.** Bir hedefte hem `flag` hem `archive`
kanalı olamaz: kanallar aynı anda çalıştığı için ayrı bir bayrak işlemi
taşımayla yarışır ve çoğunlukla mail çoktan taşınmış olur. Bunun yerine
taşıma kanalının kendi bayrak seçenekleri kullanılır; bu bayraklar taşımadan
hemen önce, aynı bağlantıda uygulanır.

**Etiket kuralları.** Her etiket tek kelimedir (boşluk ve `( ) { } % * " \ ]`
olmadan, en fazla 64 karakter), bir kanalda en fazla 10 etiket.

### 7.1 Otomatik yanıt

Hedefe “Reply to the sender automatically” kanalı eklenir: konu şablonu,
mesaj (düz metin), gönderen adı, bekleme süresi ve spam eşiği seçilir.
Şablonlarda `{sender_name}`, `{sender}`, `{subject}`, `{category}`
kullanılabilir.

Yanıt **gönderilmez** (işlem “No reply sent: …” nedeniyle kaydedilir, Human
Review'a düşmez):

| Durum | Neden |
|---|---|
| `Auto-Submitted` başlığı var (değeri `no` değil) | Otomatik mesaj (RFC 3834) |
| `Precedence: bulk / list / junk` | Toplu gönderim |
| `List-Id` başlığı var | Posta listesi |
| Gönderen `noreply`, `do-not-reply`, `mailer-daemon`, `postmaster`, `bounce…` | Cevap alınmayan adres |
| Jev spam skoru eşiğin üstünde veya analiz yok | Olası spam |
| Aynı hedef bu kişiye bekleme süresi içinde yanıt verdi | Tekrar yanıt yok |
| Mail Eumaeus'tan veya organizasyonun kendi kutularından geldi | Döngü koruması |
| Mail 0.19.0'dan önce alındı | Başlıkları bilinmiyor |

- Yanıt, varsa `Reply-To` adresine gider; `In-Reply-To` ile aynı konuşmaya
  bağlanır ve `Auto-Submitted: auto-replied` taşır.
- Gönderilen yanıtlar iletmelerle birlikte organizasyonun günlük giden mail
  limitine sayılır (Organizasyon › Forwarding).
- SMTP ayarlı değilse işlem başarısız olur ve Human Review'a düşer.

### 7.2 Slack, Teams, Jira ve Zendesk

- **Slack:** Slack › Apps › Incoming Webhooks ile bir kanala webhook ekleyin,
  URL'yi kanala girin.
- **Teams:** Kanalda Workflows › “Post to a channel when a webhook request is
  received” akışını oluşturup URL'yi girin. Mesaj Adaptive Card olarak gelir.
- **Jira:** Site adresi (`https://şirket.atlassian.net`), proje anahtarı,
  issue tipi, hesap e-postası ve token sırrının adı girilir. Token
  id.atlassian.com › Security › API tokens'tan alınır ve hedefin Secrets
  bölümüne aynı adla eklenir.
- **Zendesk:** Alt alan adı (`şirket`), hesap e-postası, isteğe bağlı öncelik ve
  token sırrının adı. Token Admin Center › Zendesk API'den alınır.
- Mailden gelen metinler güvenilmeyen içerik sayılır: Slack'te `<!channel>`
  gibi bildirimler, Teams'te Markdown biçimlendirmesi etkisizleştirilir.
- Açılan kayıt `eumaeus` etiketi taşır ve açıklamasında Eumaeus'a link vardır.

### 7.3 Taşımayı geri alma

Emails ekranında bir mailin **Processing** sekmesindeki her başarılı taşımanın
yanında **Undo move** düğmesi bulunur (izin: `action_executions:undo`).

- Mail, taşındığı klasörden geldiği klasöre (mail kutusunun izlenen
  klasörüne) geri taşınır. Mail, taşıma sırasında kaydedilen UID ile, bu
  mümkün değilse Message-ID ile bulunur.
- Geri dönen mail sunucuda yeni bir UID alır. Eumaeus bunu önceden bilir:
  geri almadan hemen önce bir “bastırma” kaydı açar; bir sonraki senkron maili
  mevcut kaydına bağlar, yeniden analiz etmez ve yeniden yönlendirmez.
- Geri alma, mailin geçmişinde ayrı bir işlem olarak görünür ve taşıma
  “undone” olarak işaretlenir. Aynı taşıma iki kez geri alınamaz.
- Bir mail art arda taşındıysa (ör. yeniden işlemeyle), taşımalar **en
  yenisinden geriye** doğru geri alınır; daha eskisi, sonraki taşıma geri
  alınmadan reddedilir. Sonraki bir taşımadan sonra eski UID'ye güvenilmez,
  mail Message-ID ile aranır.
- Sonuçlar:
  - **Başarılı:** mail geri döndü.
  - **Başarısız:** mail hedef klasörde yok (elle taşınmış veya silinmiş
    olabilir) ya da sunucuya ulaşılamadı; hiçbir şey değişmedi, tekrar
    denenebilir.
  - **Belirsiz:** taşıma komutu gönderildi ama cevap alınamadı; mail kutusunu
    kontrol edin.
- İletme ve webhook geri alınamaz: gönderilmiş bir mail veya yapılmış bir
  HTTP çağrısı geri çekilemez.

**İşlem güvenliği.** Her kanal çalıştırması benzersiz bir anahtarla kayıt
altındadır. Aynı işlem iki kez yapılmaz; geçici hatalar otomatik olarak yeniden
denenir; kalıcı hatalar ve belirsiz sonuçlar Human Review'a gider. Başarısız
işlemler Emails ekranından elle yeniden denenebilir.

---

### 7.4 E-posta bildirimi (`email_notify`, 1.2)

Kural bir maili bu hedefe yönlendirdiğinde seçilen kişilere kısa bir
bildirim gider. Bildirimde şunlar yer alır:
- kimden geldiği, konusu, hangi kutuya düştüğü ve ne zaman geldiği;
- Jev'in değerlendirmesi (spam skoru, kategori, aciliyet);
- Eumaeus'ta maili açan bir düğme.

Mailin kendisi gönderilmez; bunun için iletme kanalı (bölüm 8) kullanılır.

| Ayar | Açıklama |
|---|---|
| Şu izne sahip herkes | Örneğin "insan kontrolünde karar verebilenler" (`reviews:resolve`). Ekibi takip eder: izni alan ya da kaybeden kişi kendiliğinden eklenir ya da çıkar. |
| Ve şu üyeler | Organizasyonun etkin üyelerinden seçilenler (en fazla 50). |
| Dış adresler | En fazla 10. Kanal kaydedilince her birine onay e-postası gider; yalnızca onaylayanlar bildirim alır. İletmedeki alan adı izin listesi burada da geçerlidir. |
| Konu | Varsayılan `{destination}: {subject}`. |
| Giriş cümlesi | İsteğe bağlı. |
| İlk 500 karakter | İsteğe bağlı, varsayılan kapalı. Yalnızca HTML içeren maillerde metin HTML'den çıkarılır. |
| Gönderim | **Her mail için**; **en fazla şu sürede bir** (15 dk – 1 gün): ilk mail hemen bildirilir, süre dolmadan gelenler bir sonraki bildirimde birlikte gider; **özet olarak her…** (15 dk – 1 hafta): mailler toplanıp tek liste hâlinde gider. |

Konu ve giriş cümlesinde kullanılabilen değişkenler: `{subject}`,
`{sender}`, `{sender_name}`, `{mailbox}`, `{category}`, `{urgency}`,
`{spam}` ve `{destination}`.

Güvenlik ve gürültü kontrolü:
- **Döngü koruması:** Eumaeus'un izlediği kutulara bildirim gitmez; giden
  bildirim yeniden gelen mail olarak içeri girerdi. Eumaeus'un kendi
  gönderdiği bir kopya hakkında da bildirim yapılmaz.
- **Dil ve gizlilik:** Her dil için tek mesaj gider. Birden çok alıcı Gizli
  (Bcc) alanındadır, birbirlerinin adresini görmezler.
- **Günlük sınır:** Bildirimler iletme ve otomatik yanıtla aynı günlük
  gönderim sınırını (organizasyon başına, varsayılan 200) paylaşır. Her
  bildirim **Giden e-postalar** kaydında `Kural bildirimi` olarak görünür.
- **Bekleyen bildirimler:** Seyreltilmiş ve özet bildirimler 5 dakikalık
  iletme özeti görevinde gönderilir. Kanal düzenlenince bekleyenler
  korunur; kanal kapatılınca atılır.

Düzenleyicide iki düğme vardır:
- **Önizle:** Bildirimi organizasyonun gerçek bir maili üzerinde gösterir.
- **Bana test gönder:** Bildirimi yalnızca giriş yapmış kişinin adresine
  gönderir, ayar ne olursa olsun.

## 8. İletme (forward) kanalı

### 8.1 Ayarlar

| Ayar | Seçenekler | Varsayılan |
|---|---|---|
| **İletme şekli** | `attachment`: kısa not + orijinal .eml eki · `inline`: klasik Fwd:, orijinal gövdede · `redirect`: orijinal mail olduğu gibi, orijinal gönderenle | `attachment` |
| **Gönderim** | `each`: her mail hemen · `digest`: biriktir, aralıklarla tek özet mail | `each` |
| **Özet aralığı** | 15 dakika – 1 hafta (yalnızca `digest`) | 60 dakika |
| **Alıcılar** | To (zorunlu), Cc, Bcc; toplam en fazla 10 adres | — |
| **Gönderen adı** | Serbest metin; adres her zaman SMTP gönderen adresidir | SMTP gönderen adı |
| **Yanıtlar** | Orijinal gönderene / SMTP gönderen adresine | orijinal gönderen |
| **Konu şablonu** | `{subject}`, `{sender}`, `{category}`, `{destination}` (yalnızca tek tek gönderimde; özet mailin konusu sabittir) | `Fwd: {subject}` |
| **Ekler** | `inline` modunda orijinal ekler eklensin mi | evet |
| **Jev notu** | Spam skoru, kategori, aciliyet mesaja eklensin mi | evet |

`redirect` modu orijinal gönderen adresini korur ama mail kendi SMTP
sunucunuzdan çıkar. Alıcı sunucular bunu çoğu zaman sahtecilik sayar
(SPF/DMARC) ve spam'e atar ya da reddeder. Arayüz bu modu seçerken uyarır.
`redirect`, özet gönderimle birlikte kullanılamaz.

### 8.2 Özet (digest) gönderimi

- `digest` seçiliyse mail hemen gönderilmez; kanalın kuyruğuna eklenir ve işlem
  “özete eklendi” olarak başarılı sayılır.
- Worker her 5 dakikada kuyrukları kontrol eder. Bir kanalın son özetinden bu
  yana aralık dolduysa bekleyen mailler tek bir mailde gönderilir.
- Özet maili: konu `N emails from <hedef> (Eumaeus digest)`, gövdede her mail
  için gönderen, konu, tarih ve (açıksa) Jev notu. `attachment` modunda her
  mailin orijinali .eml eki olarak eklenir (toplam 20 MB'a kadar; fazlası
  listede “eklenemedi” notuyla yer alır). `inline` modunda her mailin metninden
  kısa bir alıntı eklenir.
- Bir özet en fazla 50 mail içerir; daha fazlası varsa aynı turda birden fazla
  özet gider.
- Kanal düzenlenirse bekleyen mailler yeni sürüme taşınır. Kanal kapatılırsa
  bekleyen mailler iptal edilir ve kayda geçer.
- Özet gönderimi belirsiz sonuçlanırsa (bağlantı gönderim sırasında koparsa) o
  özetteki mailler tekrar gönderilmez, Human Review'a düşer. Geçici hatalarda
  mailler kuyrukta kalır ve bir sonraki turda tekrar denenir.
- Hedef sayfasında her özet kanalı için bekleyen mail sayısı ve son gönderim
  zamanı görünür.

### 8.3 Alıcı onayı

- Bir iletme kanalı kaydedildiğinde listedeki her yeni adrese onay maili gider.
  Link 7 gün geçerlidir.
- Adresin sahibi `/verify-forward` sayfasında **Confirm forwarding** düğmesine
  basar. Onay sayfa açılınca otomatik verilmez; böylece bağlantı önizleyicileri
  veya tarayıcılar kimsenin yerine onay veremez.
- Onaylanmamış, süresi dolmuş veya durdurulmuş adreslere gönderim yapılmaz.
  Diğer alıcılara gönderim devam eder; atlanan adresler işlem kaydında
  gerekçesiyle görünür.
- Alıcı listesi Destinations sayfasındadır: onay linkini yeniden gönder, iletmeyi
  durdur, durdurulan adrese yeniden sor.
- SMTP ayarlı değilse alıcılar “onay bekliyor” durumunda kalır; SMTP
  ayarlandıktan sonra link yeniden gönderilebilir.

### 8.4 Güvenlik önlemleri

| Önlem | Nasıl çalışır |
|---|---|
| Döngü koruması | Organizasyonun izlediği bir mail kutusu adresine iletme yapılamaz (kayıtta ve gönderimde kontrol). Eumaeus'un ilettiği bir mail tekrar iletilmez. |
| Günlük limit | Organizasyon başına 24 saatte gönderilen iletme maili sayısı (varsayılan 200; özet maili tek mail sayılır). Limit dolunca yeni iletmeler Human Review'a düşer. 0 = iletme kapalı. |
| Alan adı izin listesi | Boşsa her alan adı serbesttir. Doluysa yalnızca listedeki alan adlarına iletme yapılabilir. Kayıtta ve gönderimde kontrol edilir. |
| Alıcı onayı | Bölüm 8.3. |
| Belirsiz sonuç | SMTP bağlantısı gönderim sırasında koparsa mail tekrar gönderilmez, Human Review'a düşer. Bağlantı kurulamadıysa otomatik yeniden denenir. Sunucu kalıcı olarak reddettiyse Human Review'a düşer. |
| Başlık güvenliği | Orijinal konu ve adresler tek satıra indirilir; başlık enjeksiyonu yapılamaz. HTML'e giren değerler kaçışlanır. |

Günlük limit ve izin listesi Organizasyon › **Forwarding** sekmesinden yönetilir.

### 8.5 Örnek: pazarlama maillerini bir adrese toplamak

1. Settings'te SMTP'nin çalıştığından emin olun.
2. Destinations › **New destination** → ad “Pazarlama”, kanal “Forward to email
   addresses”, To `pazarlama@sirket.com`, gönderim `digest`, aralık `1 day`.
3. İsteğe bağlı: aynı hedefe “Move message to an IMAP folder” kanalı ekleyin
   (klasör `Pazarlama`); mail gelen kutusundan da kalkar.
4. `pazarlama@sirket.com` gelen onay mailindeki linkten onaylar.
5. Rules › yeni kural: `answers.category == marketing` → hedef “Pazarlama”.

Bundan sonra pazarlama mailleri günde bir kez tek bir özet mail olarak iletilir.

---

## 9. Human Review

Bir mail şu durumlarda Human Review'a düşer:

- Jev'in “insan bakmalı” sinyali eşiği aşarsa (organizasyonda açıksa),
- hiçbir kural eşleşmezse,
- atanmış kural akışı hatalıysa,
- bir kural bilerek `human_review` hedefine yönlendirirse,
- bir işlem kalıcı olarak başarısız olur ya da belirsiz sonuçlanırsa (iletme
  limiti, onaysız tüm alıcılar, belirsiz SMTP sonucu dahil).

Her satırda Jev'in spam skoruna göre *Suspicious* veya *Likely safe* rozeti
görünür. Mailler tek tek veya toplu olarak **Onaylandı** ya da **Spam** diye
işaretlenir. İşaretleme maili taşımaz; yalnızca kaydı günceller.

Bir mailin son açık kontrol kaydı çözülünce mailin durumu **Reviewed**
(İncelendi) olur. Mail Emails listesinde kalır — orası tüm maillerin kaydıdır —
ama artık “Awaiting review” filtresinde görünmez; çözülenler “Reviewed”
filtresindedir. (0.22'den önce mailin durumu güncellenmiyordu; bir migration
eskiden çözülmüş mailleri düzeltir. Kontrol kaydı yeniden işlemeyle kapanan
mailler yeni kararlarının durumunu korur.)

**Özet maili.** Organizasyon › Review policy'den açılır. Review görme veya çözme
izni olan üyelere belirlenen aralıkta (5 dakika – 7 gün) bekleyen maillerin
özeti gider. SMTP ayarlı değilse gönderilmez.

**Özet mailinden tek tık** (0.23). Çözme izni (`reviews:resolve`) olan
alıcıların özetinde her kaydın yanında **Spam** ve **Doğru** bağlantıları
bulunur:

- Bağlantı alıcıya özel ve imzalıdır (sunucunun gizli anahtarından türetilen
  HMAC); 7 gün geçerlidir; yalnızca kendi organizasyonunun kaydını çözer.
- Tıklayınca oturum gerektirmeyen bir **onay sayfası** açılır (yanlış tıklamaya
  ve bağlantı önizleyen e-posta tarayıcılarına karşı); karar ancak orada onay
  verilince yazılır.
- Onay anında kişinin hâlâ etkin üye olduğu ve çözme izni taşıdığı yeniden
  kontrol edilir. Kayıt zaten kapanmışsa hiçbir şey değişmez; bağlantı
  pratikte tek kullanımlıktır. Karar, bağlantının sahibi adına denetim kaydına
  yazılır.

**Klavye kısayolları** (Human Review listesi): `j`/`k` veya oklar gezinir,
`Enter` açar, `s` spam, `a` doğru, `x` seçer, `?` yardımı gösterir.

**Benzerlerine uygula.** Kayıt sayfasında “Benzer açık kayıtlar” kartı aynı
göndericinin diğer açık kayıtlarını (isteğe bağlı olarak bir konu kelimesiyle
daraltılmış) listeler; aynı karar hepsine birden verilebilir (en fazla 200).
Her kayıt denetim kaydına ayrı ayrı yazılır.

**İzinler** (0.23 düzeltmesi): listeyi ve kaydı görmek `reviews:read`, karar
vermek `reviews:resolve` ister. Önceden bu kontroller eksikti.

### 9.1 Atama ve notlar

0.28'den itibaren kayıt sayfasında **Atama ve notlar** kartı:

- Kayıt, organizasyonda karar verme izni (`reviews:resolve`) olan bir üyeye
  atanabilir ya da atama kaldırılabilir; “Bana ata” kısayolu vardır.
- Listede “Herkes / Bana atananlar / Atanmamış” filtresi (URL'de
  `?assigned=me|none`) ve her satırda atanan kişi.
- **Notlar:** karar verme izni olan herkes not ekleyebilir (en fazla 2000
  karakter). Notlar yalnızca denetim kaydında tutulur (`review_note_added`) ve
  düzenlenemez; herkes (görme izniyle) okuyabilir.
- Her atama değişikliği `review_assigned` olarak denetim kaydına yazılır.
- Sistem yöneticisi (superAdmin) organizasyonun üyesi değilse atanamaz.

**Atama e-postaları** (0.29): Organizasyon › Review policy › Atama
e-postaları.

| Ayar | Anlamı |
|---|---|
| Açık/kapalı | Varsayılan açık. |
| Şu kadar birikince gönder (1–100) | Aynı kişiye atanmış, açık ve henüz bildirilmemiş kayıt sayısı bu değere ulaşınca **tek** e-posta gider (en fazla 20 kayıt listelenir, her biri bağlantılı). 1 = her atamada. |

- Sayılmayanlar: kişinin kendine atadığı kayıtlar, eşiğe ulaşmadan çözülen
  veya başkasına atanan kayıtlar.
- E-posta alıcının dilindedir; SMTP ayarlı değilse gönderilmez.
- Gönderim başarısız olursa atama geri alınmaz; kayıtlar 5 dakikalık review
  özeti turunda yeniden denenir. Eşik düşürülürse o turda geçerli olur.
- Not: eşik 10 ise ve bir kişiye 3 kayıt atanıp kalırsa e-posta gitmez; o
  kayıtlar “Bana atananlar” filtresinde ve review özetinde görünür.

---

## 10. Kullanıcılar, izinler ve oturumlar

- **Kayıt yoktur.** Kullanıcılar bir organizasyonun Members sekmesinden e-posta
  ile davet edilir. Davet linkini açan kişi şifresini belirler.
- İlk süper admin sunucu ilk açıldığında `BOOTSTRAP_ADMIN_EMAIL` /
  `BOOTSTRAP_ADMIN_PASSWORD` ile oluşturulur (yalnızca bir kez; sonraki
  açılışlarda şifre değiştirilmez).
- **Süper admin** tüm organizasyonları görür, organizasyon oluşturur ve sistem
  ayarlarını yönetir.
- Diğer kullanıcılar yalnızca **üye oldukları** organizasyonları görür ve
  yalnızca **kendilerine verilen izinlerle** işlem yapar.

### 10.1 İzin kataloğu

| Alan | İzinler |
|---|---|
| Organizasyon | `organizations:read` `organizations:write` `organizations:delete` |
| Mail kutuları | `mailboxes:read` `mailboxes:write` `mailboxes:delete` `mailboxes:reconcile` |
| Hedefler | `destinations:read` `destinations:write` `destinations:delete` `destinations:manage_secrets` |
| Kurallar | `rules:read` `rules:write` `rules:delete` (gönderici listeleri ve öneriler de bu izinlerle yönetilir) |
| Kural akışları | `rule_graphs:read` `rule_graphs:write` |
| Mailler | `emails:read` |
| Kararlar ve işlemler | `routing_decisions:read` `action_executions:read` `action_executions:retry` `action_executions:undo` |
| Yeniden işleme | `emails:reprocess` |
| Human Review | `reviews:read` `reviews:resolve` |
| Kayıt ve özet | `audit:read` (CSV dışa aktarım dahil) `stats:read` |
| Üyeler | `members:read` `members:invite` `members:manage` |
| Gizlilik | `privacy:erase` (bir göndericiye ait her şeyi silme) |
| API anahtarları | `api_keys:manage` |

İletme kanalları ve iletme alıcıları `destinations:*` izinleriyle yönetilir;
günlük limit ve izin listesi `organizations:write` gerektirir.

### 10.5 Dil

- **Arayüz:** üst çubuktaki dil seçici (English / Türkçe). Seçim bir çerezde
  (`jm_locale`) ve hesapta tutulur; yeni bir tarayıcıda hesaptaki seçim
  uygulanır. Giriş ekranında da seçici vardır (yalnızca tarayıcıya kaydeder).
  Hiç seçim yoksa tarayıcının `Accept-Language` başlığı belirler.
- **E-postalar:** Eumaeus'un üyelere gönderdiği e-postalar (davet, Review
  özeti, uyarılar) üyenin dilinde; hesabı olmayanlara gidenler (iletme onayı,
  iletilen maillerin notu, iletme özeti) organizasyonun e-posta dilinde
  gider. Organizasyon dili Organizasyon › Forwarding › **Email language**
  bölümünden ayarlanır (varsayılan İngilizce; `organizations:write`).
- **Çevrilmeyenler:** kullanıcı verisi (konu, adres, kural ve hedef adları),
  API'nin döndürdüğü hata mesajları, izin ve olay tipi gibi teknik
  tanımlayıcılar, uyarıların kayıtlı başlık ve açıklamaları, otomatik yanıt
  şablonları (kullanıcının yazdığı metin).
- API: `PUT /api/v1/auth/me/locale` gövde `{ "locale": "tr" | "en" | null }`;
  `GET /auth/me` cevabında `user.locale`; organizasyonda `locale` alanı.

### 10.2 Oturum ve hesap güvenliği

| Konu | Davranış |
|---|---|
| Oturum | JavaScript'in okuyamadığı (httpOnly) çerez; oturum Redis'te. Süre Settings'ten ayarlanır (varsayılan 24 saat). |
| Şifre | Argon2id; en az 10 karakter. Değişince diğer tüm oturumlar kapanır. |
| MFA | TOTP. Security sayfasında QR kod ile kurulur, isteğe bağlıdır, kapatılabilir. |
| Kilitleme | 15 dakikada 5 hatalı giriş veya MFA kodu → geçici kilit. |
| Oturum listesi | Açık oturumlar cihaz ve IP ile listelenir; tek tek veya toplu kapatılır. |
| Giriş kayıtları | Giriş, çıkış, MFA ve şifre olayları ayrı tutulur; hiçbirinde şifre, kod veya oturum anahtarı yoktur. |
| SSO | Google / Microsoft ile giriş; yalnızca var olan hesaplar. Bkz. 10.4. |

### 10.3 API anahtarları

Betikler ve başka sistemler için. Organizasyon › **API keys** sekmesinden
yönetilir (`api_keys:manage`).

- **Kullanım:** `Authorization: Bearer jm_…` başlığıyla. `X-Organization-Id`
  gerekmez; gönderilirse anahtarın organizasyonuyla aynı olmalıdır.
- **Kapsam:** bir organizasyon ve seçilen izinler. Oluşturan kişinin o
  organizasyonda sahip olmadığı bir izin verilemez.
- **Yapamadıkları:** oturum/hesap uçları (`/auth/*`), organizasyon ve üye
  yönetimi, sistem ayarları, başka API anahtarı oluşturma.
- **Saklama:** anahtar yalnızca oluşturulduğunda bir kez gösterilir; Eumaeus
  yalnızca SHA-256 özetini ve ekranda ayırt etmek için baş kısmını
  (`jm_ab12cd34`) tutar.
- **Süre ve iptal:** 30 / 90 / 365 gün ya da süresiz. **Revoke** anında
  geçersiz kılar. Son kullanım zamanı dakikada bir güncellenir.
- **Denetim:** anahtarla yapılan işlemler denetim kaydında
  `api-key:<ad> (jm_…)` olarak görünür; oluşturma ve iptal de kaydedilir.

```bash
curl -H "Authorization: Bearer jm_ab12cd34_…" https://eumaeus.sirket.com/api/v1/rules/export
```

### 10.4 Google / Microsoft ile giriş (SSO)

Settings › **Sign in to Eumaeus with Google / Microsoft**. Faz 17'de mail
kutuları için kaydedilen aynı Google / Microsoft uygulaması kullanılır; yalnızca
ikinci bir yönlendirme adresi (`/api/v1/auth/sso/<google|microsoft>/callback`)
uygulamaya eklenmelidir. Ekranda kopyalanabilir olarak gösterilir.

- **Kimler girebilir:** yalnızca Eumaeus'ta hesabı olan (davet edilmiş) aktif
  kullanıcılar. SSO hesap oluşturmaz. Bekleyen davet, o adresle SSO ile giriş
  yapılınca kabul edilmiş olur.
- **Alan adı kısıtı:** isteğe bağlı liste (`acme.com, acme.com.tr`); boşsa her
  alan adı, ama hesap yine var olmalıdır.
- **MFA:** hesapta MFA açıksa SSO'dan sonra kod yine sorulur.
- **Güvenlik:** PKCE ve tek kullanımlık `state`; `state` ayrıca akışı başlatan
  tarayıcıya kısa ömürlü bir çerezle bağlanır (başkasının tarayıcısında
  tamamlanamaz). ID token'ın yayıncı, hedef, süre ve `nonce` alanları
  doğrulanır; Google için e-postanın doğrulanmış olması şarttır.
- Reddedilen denemeler giriş kayıtlarına `sso_login_refused` olarak yazılır
  (neden ve alan adıyla).

---

## 11. Ayarlar: neyi nereden yönetirim?

| Ayar | Yeri | Kim |
|---|---|---|
| SMTP sunucusu, port, TLS, kullanıcı, şifre, gönderen adresi/adı | Settings | Süper admin |
| Google / Microsoft oturum açma uygulamaları | Settings › Mailbox sign-in | Süper admin |
| Uygulama adresi (maillerdeki linkler) | Settings | Süper admin |
| Oturum süresi | Settings | Süper admin |
| Mail kutusu kontrol aralığı | Settings | Süper admin |
| Orijinal mail saklama süresi | Settings | Süper admin |
| Google / Microsoft ile giriş (SSO), izinli alan adları | Settings | Süper admin |
| Mail içeriği ve mail saklama süreleri | Organizasyon › Data & privacy | `organizations:write` |
| Bir göndericiyi silme (KVKK) | Organizasyon › Data & privacy | `privacy:erase` |
| API anahtarları | Organizasyon › API keys | `api_keys:manage` |
| Denetim kaydı CSV | Audit › Export CSV | `audit:read` |
| Review eşiği ve özet maili | Organizasyon › Review policy | `organizations:write` |
| Uyarı e-postaları ve uyarı webhook'u | Organizasyon › Alerts | `organizations:write` |
| VIP ve engel listeleri | Sender lists | `rules:write` |
| Engel hedefi | Sender lists (altta) | `organizations:write` |
| İletme günlük limiti, izinli alan adları, organizasyonun e-posta dili | Organizasyon › Forwarding | `organizations:write` |
| Arayüz dili | Üst çubuk (dil seçici) | Her kullanıcı |
| Mail kutuları | Mailboxes / Organizasyon | `mailboxes:write` |
| Kurallar | Rules | `rules:write` |
| Kural akışları ve atamalar | Rule graphs | `rule_graphs:write` |
| Hedefler, kanallar, iletme alıcıları | Destinations | `destinations:write` |
| Webhook imza anahtarları | Destinations › detay | `destinations:manage_secrets` |
| Üyeler ve izinler | Organizasyon › Members | `members:invite` / `members:manage` |
| Kendi şifrem, MFA, oturumlarım | Security | Her kullanıcı |

**SMTP notu.** Port 587 STARTTLS ile çalışır; bu durumda *implicit TLS*
kapalı olmalıdır. Port 465 doğrudan TLS kullanır; açık olmalıdır. Yanlış
eşleşme “wrong version number” TLS hatası verir ve hiçbir mail gitmez. 0.13.1
itibarıyla bu kombinasyon açık onay olmadan kaydedilemez. Ayarları kaydettikten
sonra Settings › **Send test email** ile deneyin; başarısız olursa ekranda
nedeni ve ne yapılacağı yazar.

### 11.2 Saklama süreleri ve KVKK silme

Organizasyon › **Data & privacy**. İki süre, ikisi de boş bırakılırsa
“süresiz”:

| Ayar | Süre dolunca | Kalanlar |
|---|---|---|
| Remove email content after N days | Metin ve HTML gövde ile orijinal kopya silinir; `bodyPurgedAt` işaretlenir. | Konu, gönderen, alıcılar, Jev analizi, karar, işlemler, denetim kaydı. Mail sayfası “içerik saklama politikasıyla kaldırıldı” der. İçeriği silinen mail artık iletilemez. |
| Delete emails entirely after M days | Mail ve ondan türeyen her şey (analiz, kural değerlendirmeleri, kararlar, işlemler, Review kaydı, özet kuyruğu) silinir. | Denetim olayları kalır ama içerikleri `{ erased: true, emailId }` olarak kimliğe indirilir. |

- Süreler 1–3650 gün; içerik süresi mail süresinden uzun olamaz.
- Saatlik bakım işi uygular; her turda organizasyon başına en fazla 5.000 mail
  silinir (büyük birikimler birkaç saatte erir).
- Yalnızca Eumaeus'un kendi kopyası silinir; **mail kutusundaki mesaja
  dokunulmaz.**

**Bir göndericiyi silme (KVKK / GDPR talebi):**

1. Adresi yazın, **Find**: kaç mail, otomatik yanıt kaydı ve öneri silineceği
   gösterilir (hiçbir şey silinmez). Adres hem gönderen hem Reply-To olarak
   aranır, büyük/küçük harf fark etmez.
2. Adres VIP/engel listesindeyse uyarı çıkar; liste kaydı yapılandırmadır ve
   silinmez (talep kapsıyorsa Sender lists'ten kaldırın).
3. Adresi onay kutusuna yeniden yazın, **Erase permanently**. Geri alınamaz.
4. Denetim kaydına `privacy_sender_erased` yazılır; adresin kendisi değil,
   SHA-256 özeti ve silinen kayıt sayıları tutulur.

API: `POST /api/v1/privacy/erase-sender` gövde `{ "address": "…", "dryRun": true }`
(varsayılan `dryRun: true`; silmek için açıkça `false`).

### 11.3 Denetim kaydını dışa aktarma

Audit › **Export CSV**: başlangıç ve bitiş günü seçilir (bitiş dahil, en fazla
366 gün); seçili olay tipi filtresi de uygulanır. Sütunlar: `created_at`,
`event_type`, `actor`, `email_id`, `payload` (JSON). Dosya en eskiden yeniye
sıralıdır, UTF-8 BOM ile başlar (Excel Türkçe karakterleri doğru gösterir) ve
akış halinde üretilir. `=`, `+`, `-`, `@` ile başlayan hücrelerin başına `'`
eklenir; tablo programı bunları formül olarak çalıştırmaz.

API: `GET /api/v1/audit/export.csv?from=2026-09-01&to=2026-10-01&eventType=`
(`to` hariç).

### 11.4 Devre dışı bırakma ve kalıcı silme

Kalıcı silme yalnızca Eumaeus'un kendi verisini siler; mail kutularındaki
mesajlara hiçbir zaman dokunulmaz.

| Ne | Nasıl | Kim |
|---|---|---|
| Organizasyonu devre dışı bırakma | Organizasyon sayfasının altı › **Organizasyonu devre dışı bırak**. Tüm mail kutularının eşitlemesi durur; hiçbir şey silinmez. **Tekrar etkinleştir** ile geri gelir; eşitleme kaldığı yerden devam eder. | `organizations:delete` |
| Organizasyonu kalıcı silme | Yalnızca devre dışıyken: **Kalıcı olarak sil** → adı yazarak onay. Mail kutuları, mailler, analizler, kararlar, kurallar, akışlar, hedefler, listeler, üye erişimleri, API anahtarları ve denetim kaydı silinir; kullanıcı hesapları kalır. Denetim kaydı da gittiği için silme, yapan yöneticinin hesabına `organization_deleted` giriş olayı olarak yazılır. | Sistem yöneticisi |
| Mail kutusunu kalıcı silme | Yalnızca devre dışıyken: satırda **Kalıcı olarak sil** → adresi yazarak onay. Kutu, mailleri ve onlardan türeyen her şeyle silinir; organizasyonun denetim kaydına `mailbox_deleted` yazılır. | Sistem yöneticisi |
| Seçilen mailleri silme | Emails listesinde kutucuklarla seçip **Kalıcı olarak sil** (bir seferde en fazla 100). KVKK silmesiyle aynı şekilde silinir: bu maillere ait denetim olayları içeriksiz olarak kalır; `emails_deleted` kaydı düşer. | `privacy:erase` |

API: `DELETE /organizations/:id` (devre dışı bırakır) · `POST
/organizations/:id/reactivate` · `POST /organizations/:id/delete-permanently`
(`{ confirmName }`) · `POST /mailboxes/:id/delete-permanently` (`{
confirmAddress }`) · `POST /emails/delete` (`{ emailIds }`). Aktif bir
organizasyon ya da kutu için silme `409 INVALID_STATE`, yanlış ad `400` döner.

### 11.1 Ortam değişkenleri (`apps/api/.env`)

| Değişken | Açıklama |
|---|---|
| `DATABASE_URL`, `DATABASE_URL_TEST` | PostgreSQL bağlantıları |
| `REDIS_URL` | Kuyruklar ve oturumlar |
| `SECRET_ENCRYPTION_KEY` | Base64, 32 bayt (`openssl rand -base64 32`). Kaybedilirse kayıtlı tüm şifreler çözülemez. |
| `JEV_API_KEY`, `JEV_MODEL_VERSION`, `JEV_API_BASE_URL`, `JEV_TIMEOUT_MS` | Jev AI |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | İlk süper admin |
| `SESSION_COOKIE_NAME`, `SESSION_COOKIE_SECURE` | Çerez; üretimde `SECURE=true` ve HTTPS |
| `API_PORT`, `API_HOST`, `SHUTDOWN_GRACE_PERIOD_MS`, `WEBHOOK_TIMEOUT_MS` | Sunucu |
| `MAIL_*`, `DEFAULT_TENANT_NAME`, `MAIL_INITIAL_SYNC_LIMIT` | Eski tek-kutu kurulumu ve ilk senkron sınırı |
| `APP_BASE_URL`, `SESSION_TTL_SECONDS`, `MAIL_SYNC_INTERVAL_SECONDS`, `SMTP_*` | Yalnızca ilk açılışta Settings'e başlangıç değeri olarak okunur; sonrası arayüzden yönetilir. |
| `MAIL_IDLE_ENABLED`, `MAIL_POLL_FALLBACK_SECONDS`, `MAIL_IDLE_MAX_CONNECTIONS` | Anında posta alma (IMAP IDLE): açık/kapalı (varsayılan açık), canlı kutuların yedek yoklama aralığı (300 sn), açık bağlantı üst sınırı (50). §14.2 |
| `WORKER_WATCHDOG_MINUTES`, `SYSTEM_ALERT_EMAILS`, `SYSTEM_ALERT_LOCALE` | Worker bekçisi: kaç dakika sessizlikten sonra e-posta gideceği (5, 0 = kapalı), alıcılar, dil. §14.1 |

---

## 12. Ekran rehberi

| Ekran | Ne işe yarar |
|---|---|
| Overview | Açık uyarılar (en üstte), işlenen mailler, bekleyen review'lar, başarısız işlemler. |
| Emails | Tüm mailler; gönderen, alıcı, konu, hedef, durum ve tarih aralığına göre arama (URL'de saklanır). Detayda gönderen doğrulama rozeti, analiz, karar, akış yolu, işlemler, “Correct destination” ve kayıtlar zaman çizelgesi olarak. |
| Human Review | Bekleyen mailler; tekli veya toplu onay/spam, klavye kısayolları, atanana göre filtre. Detayda benzerlerine uygula, atama ve notlar. |
| Rules | Düz kurallar, eşleşme istatistikleri, geçmiş maillerde deneme, kaydetmeden önce etki, sürüm geçmişi ve geri dönme. |
| Sender lists | VIP ve engel listeleri, Review'dan öneriler, engel hedefi, yeni kaydı geçmiş maillerde deneme. |
| Rule graphs | Adım adım akış editörü, geçmiş maillerde deneme, açma/kapama, mail kutusu ataması. |
| Destinations | Hedefler, kanallar, sürüm geçmişi, iletme alıcıları ve bekleyen özetler. |
| Organizations | Mail kutuları, toplu içe aktarma, Members, Review policy, Forwarding. |
| Mailboxes | Bağlı kutular, bağlantı sağlığı, “Reconcile now”, Gmail / Microsoft 365 ile bağlama ve yeniden bağlama. |
| Reports | 7/30/90 günlük rapor: günlük mail ve spam grafiği, kategoriler, hedefler, kurallar, işlemler, review süresi. |
| Audit | Değiştirilemez olay kaydı. |
| System | Sunucu ve veritabanı sağlığı, mail kutusu eşitleme sağlığı, (superAdmin) iş kuyrukları ve son hatalar. |
| Settings | Sistem geneli ayarlar (süper admin). |
| Security | Şifre, MFA, oturumlar. |
| Login / Accept invite / Verify forward | Oturum dışı sayfalar. |

---

## 13. Güvenlik

| Konu | Durum |
|---|---|
| Kimlik doğrulama | Oturum çerezi + Redis; her organizasyon verisine erişim üyelik ve izinle kontrol edilir. |
| Yetkilendirme | 29 izinlik katalog; organizasyon adresi URL'den alınan route'larda izin o organizasyona göre kontrol edilir. |
| Saklanan sırlar | Mail kutusu, SMTP, webhook ve MFA sırları AES-256-GCM ile şifreli; hiçbir API cevabında dönmez. |
| Şifreler | Argon2id; davet ve onay tokenları yalnızca SHA-256 özeti olarak saklanır. |
| Webhook | HMAC-SHA256 imza; her gönderimde SSRF kontrolü (özel ağlar, bulut metadata adresi, DNS rebinding). |
| İletme | Alıcı onayı, döngü koruması, günlük limit, alan adı izin listesi, başlık enjeksiyonu koruması. |
| Girdi doğrulama | Tüm route'larda Zod şemaları. Rapor sorguları Postgres'te gruplanır ama yalnızca parametreli (tagged template) sorgularla; SQL metnine değer eklenmez. |
| Yıkıcı işlemler | IMAP silme (expunge) yok; yalnızca taşıma. |
| Denetim | Kayıtlar yalnızca eklenir; şifre, token veya sır içermez. |
| Hız sınırlama | İşlem başına IP bazlı (dakikada 300; hassas route'larda daha sıkı); giriş kilitleme Redis'te. |
| Aktarım | Uygulama HTTPS sağlamaz; internete açılacaksa ters proxy arkasında çalıştırılmalı. |

---

## 14. Arka plan işleri ve operasyon

### 14.1 Uyarılar

| Uyarı | Ne zaman açılır | Ne zaman kapanır |
|---|---|---|
| Mail kutusu senkronlanamıyor | Son başarılı senkrondan bu yana en az 30 dakika geçti ve son deneme başarısız | Başarılı bir senkron olunca |
| Oturum süresi doldu | OAuth kutusu `reauth_required` durumunda | Kutu yeniden bağlanınca |
| İşlemler başarısız | Son bir saatte en az 5 işlemin yarısı veya fazlası başarısız ya da belirsiz | Oran düşünce |
| Jev hataları | Son bir saatte en az 5 analizin yarısı veya fazlası hata | Oran düşünce |
| İletme başarısız | Son bir saatte bir özet gönderilemedi ya da en az 3 iletme kalıcı olarak başarısız | Son bir saatte hata kalmayınca |

- Açık uyarılar Overview'ın en üstünde görünür (izin: `stats:read`).
- Bildirimler: organizasyonda `organizations:write` izni olan üyelere e-posta
  (Organizasyon › Alerts sekmesinden kapatılabilir; SMTP gerekir) ve isteğe
  bağlı webhook (JSON POST: `alert.opened` / `alert.resolved`). Webhook adresi
  şifreli saklanır, yalnızca kökü gösterilir; iç ağ adreslerine gönderilmez.
- Bir uyarı açıldığında bir kez, sürdüğü her gün bir kez ve kapandığında bir
  kez bildirilir.
- Uyarı e-postası (1.0.2) alıcının dilindedir ve şunları içerir:
  - logo ve durum rozeti: **Uyarı**, **Hâlâ açık** (günlük hatırlatma) ya da
    **Çözüldü** (rozet ayrıca kil, hardal ve yeşil renkle ayırt edilir);
  - hatanın ayrıntısını bir kutu içinde;
  - ilk görülme zamanını ve kapandıysa süreyi; saatler, organizasyonun mesai
    saatlerinde seçili saat diliminde, yoksa UTC olarak gösterilir;
  - türe göre bir **Ne yapmalı?** önerisini;
  - sorunun giderildiği sayfaya (Mail kutuları, Mailler, Hedefler) giden bir
    düğmeyi ve uyarı ayarlarına bağlantıyı.

  Logo, mesajın içinde satır içi (cid) görsel olarak gider. E-postanın düz
  metin bölümü de aynı bilgileri taşır. Diğer sistem e-postaları da aynı
  çerçeveyi kullanır: davet, iletme onayı, Review özeti (her mail bir satır;
  "Spam" / "Sorun yok" düğmeleriyle), atama bildirimi ve Settings'teki test
  e-postası.
- Açılma ve kapanma denetim kaydına yazılır.
- **Dil (1.2):** Uyarının başlığı ve açıklaması okuyanın dilinde gösterilir; panelde kullanıcının arayüz dili, e-postada alıcının hesap dili. Uyarı, metnin kurulduğu değerleri (`params`) saklar. Webhook'a ve 1.2 öncesi kayıtlara İngilizce metin gider. Açık bir uyarı, bir sonraki değerlendirmede bu değerleri kazanır.

**Worker bekçisi (1.1).** Uyarıları worker değerlendirir. Worker durursa
uyarılar da durur, bu yüzden worker'ı API izler:
- **Kontrol:** API her dakika worker nabzına bakar.
- **E-postalar:** Nabız `WORKER_WATCHDOG_MINUTES` (varsayılan 5, 0 = kapalı)
  dakika gelmezse "Arka plan worker'ı durdu" e-postası gider. Bu e-postada
  son nabız, fark edilme zamanı ve ne yapılacağı yazar. Worker dönünce
  kesinti süresiyle birlikte "yeniden çalışıyor" e-postası gider.
- **Alıcılar:** `SYSTEM_ALERT_EMAILS` (virgülle ayrılmış adresler); boşsa
  etkin sistem yöneticilerinin hesap adresleri. Dil, adresin kendi hesabının
  dilidir; hesabı yoksa `SYSTEM_ALERT_LOCALE` kullanılır.
- **Çok API'li kurulum:** Birden fazla API süreci olsa da her e-posta bir
  kez gider; durum Redis'te tutulur.
- **SMTP hatası:** Gönderim başarısız olursa bir sonraki dakika yeniden
  denenir.

**Giden e-postalar (1.2).** Eumaeus'un gönderdiği her e-posta kaydedilir.
Kayıtta şunlar tutulur:
- tür, alıcılar, konu;
- gönderildi mi, başarısız mı; başarısızsa SMTP hatası;
- SMTP mesaj kimliği.

Kapsanan e-postalar: uyarılar, Review özeti, atama, davet, iletme onayı,
worker durumu, SMTP testi, iletme, iletme özeti, otomatik yanıt ve kural
bildirimi.

- **Gizlilik:** İçerik (gövde) saklanmaz. Kayıtlar 90 gün tutulur; bakım
  görevi eskilerini siler. Organizasyon kalıcı olarak silinince onun
  kayıtları da silinir.
- **Görüntüleme:** Yan menüde **Giden e-postalar** sayfası vardır. Bu sayfa
  seçili organizasyonun gönderimlerini `audit:read` izniyle gösterir.
  Filtreler: yalnızca başarısızlar, tür. İletme ve otomatik yanıtta ilgili
  maile bağlantı vardır.
- **Süper admin:** Tüm organizasyonlara ve organizasyonu olmayan sistem
  e-postalarına geçebilir.
- **API:** `GET /api/v1/outbound-emails` ve
  `GET /api/v1/admin/outbound-emails` (`status`, `kind`, `organizationId`,
  sayfalama).
- **Tekrar gönderme yok:** Gövde saklanmadığı için yeniden gönderme
  yapılmaz. Başarısız bir iletme, kendi işlem kaydından yeniden denenir.

**Jev durumu (1.2).** Sistem sayfasındaki **Jev** kartında şunlar yer alır:
- son başarılı analiz;
- Jev'in şu anki hatası (anahtar, plan ya da kredi yüzünden reddediyorsa
  bu açıkça yazılır);
- 2 dakikadan uzun süredir analiz bekleyen mailler;
- son analizi hatayla biten mailler;
- son 7 günün başarılı ve hatalı analiz sayıları.

Bir sorun varsa aynı kart Genel bakış'ta da çıkar. **Jev'e yeniden sor**
düğmesi `emails:reprocess` izni ister ve onay ister, çünkü her analiz
ücretlidir. Düğme, analiz edilemeyen maillerin en yeni 100 tanesini yeniden
analiz eder ve bugünkü kurallarla yönlendirir. API:
`GET /api/v1/jev/status` (`stats:read`).

### 14.2 Kuyruklar

Üç süreç çalışır: **API** (`pnpm api`, port 3000), **worker** (`pnpm worker`) ve
**web** (`pnpm web`, port 3001; `/api/v1/*` isteklerini API'ye aktarır).

| Kuyruk | Tetikleyici | İş |
|---|---|---|
| `mailbox-sync` | Mail kutusu başına zamanlayıcı; ayrıca IDLE'ın "yeni mail" bildirimi (`idle-sync`) | Yeni mailleri çeker. |
| `process-email` | Her yeni mail | Jev analizi, karar, hedefe dağıtım. 3 deneme, üstel bekleme. |
| `execute-action` | Her kanal çalıştırması | archive / webhook / forward. |
| `review-digest` | 5 dakikada bir | Organizasyonların review özetleri. |
| `forward-digest` | 5 dakikada bir | Aralığı dolan iletme özetlerini gönderir. |
| `ops-alerts` | 5 dakikada bir | Uyarı koşullarını değerlendirir, uyarı açar/kapatır, bildirir. |
| `maintenance` | Saatte bir | Süresi dolan orijinal mail kopyalarını siler; organizasyonların saklama sürelerini uygular; Review önerilerini yeniden hesaplar; başarısız eşitleme işlerini temizler (0.26). |

**Anında posta alma: IMAP IDLE (1.1).** Worker her etkin kutu için açık bir
IMAP bağlantısı tutar. Bağlantı kutunun klasöründe bekler ve sunucu yeni posta
bildirdiğinde normal senkron işi hemen kuyruğa girer. Posta saniyeler içinde
gelir; çekme, kaydetme ve imleç yine tek yoldan (senkron) yürür.

- **Yoklama:** Bağlantısı canlı olan kutunun yoklaması
  `MAIL_POLL_FALLBACK_SECONDS` (300 sn) aralığına iner ve güvenlik ağı
  olarak kalır. Bağlantı düşünce yoklama hemen normal aralığa döner.
  Zamanlayıcısı olmayan kutulara (kapalı, yeniden giriş bekleyen) hiç
  dokunulmaz.
- **Kopan bağlantı:** Uyku, ağ kesintisi ya da sunucu yeniden başlaması
  gibi durumlarda bağlantı 5 sn, 15 sn, 30 sn, 1 dk, 2 dk ve 5 dk
  beklemelerle yeniden açılır. Geri gelince kaçırılmış olabilecek postalar
  için bir senkron çalışır. Reddedilen girişte en uzun süre beklenir; şifre
  sorununa yoklama senkronu karar verir.
- **Oturum yenileme:** IDLE her 25 dakikada bir yenilenir (sunucular
  30 dakikada kesebilir).
- **Kutu ayarı değişince:** Kutu eklenince, kapatılınca ya da sunucu
  ayarı değişince bağlantılar dakika içinde güncellenir.
- **Durum görünümü:** Kutu sağlığında (Overview ve Sistem sayfası) yeşil
  **Canlı** göstergesi çıkar. API, `live` alanını worker'ın Redis'e yazdığı
  durumdan okur.
- **Sınır:** `MAIL_IDLE_MAX_CONNECTIONS` (50). Gmail hesap başına en fazla 15
  eşzamanlı bağlantıya izin verir.

Zamanlayıcılar Redis'te tutulur; birden fazla worker çalışsa bile her tur tek
bir worker'da çalışır. Kapanışta işler yarıda kesilmez, belirlenen süre boyunca
bitmeleri beklenir. `/api/v1/health`, `/api/v1/ready` ve `/metrics`
(Prometheus) izleme için açıktır.

**Sistem sayfasında sağlık** (0.26):

- **Posta kutusu eşitleme** (izin: `mailboxes:read`): organizasyonun mail
  kutuları, sorunlular önde — *Yeniden giriş gerekli*, *Hata veriyor* (son
  hata son başarıdan yeni), *Henüz eşitlenmedi*, *Sağlıklı*, *Devre dışı*.
  Her birinde son başarılı ve son başarısız eşitleme zamanı, son hata ve
  (0.29) art arda kaç kez başarısız olduğu; aynı durumdakilerden çok hata
  verenler önde. Başarılı bir eşitleme sayacı sıfırlar.
- **Hata metni** (0.29): hangi adımda (giriş, klasörü açma, mail çekme)
  başarısız olduğu ve sunucunun asıl cevabı kaydedilir. Örnek: `Command failed
  (while connecting / signing in; sign-in rejected; [ALERT]; server said:
  Application-specific password required)`.
- **Reddedilen şifre** (0.29): şifreyle bağlı bir kutunun girişi art arda 3
  kez reddedilirse kutu “Yeniden giriş gerekli” olur ve denemeyi bırakır (her
  dakika denemek hesabı kilitletebilir). Satırdaki **Şifreyi güncelle** ile
  yeni şifre kaydedilince eşitleme kendiliğinden yeniden başlar. Ağ hataları
  kutuyu durdurmaz.
- **İş kuyrukları** (yalnızca superAdmin): her kuyruk için bekleyen, çalışan,
  ertelenen ve başarısız iş sayısı; son başarısız işlerin nedeni ve deneme
  sayısı. Artık `redis-cli` gerekmez.
- **Otomatik temizlik:** bakım işi her turda 7 günden eski başarısız eşitleme
  işlerini ve silinmiş ya da devre dışı mail kutularına ait başarısız işleri
  siler; silinmiş kutuların zamanlayıcılarını kaldırır. Yalnızca kuyruk
  kayıtlarına dokunur, mail verisine dokunmaz.
- API: `GET /mailboxes/health` · `GET /admin/queues` (superAdmin).

---

## 15. Veri modeli

| Tablo | İçerik |
|---|---|
| `tenant` | Organizasyon; review eşiği, review özeti, iletme limiti ve izin listesi, saklama süreleri, e-posta dili, mesai saatleri. |
| `mailbox_connection`, `mailbox_credential`, `mailbox_oauth_token` | Mail kutuları (oturum türüyle; `consecutive_sync_failures`: art arda başarısız eşitleme), şifreli şifreleri ve şifreli OAuth token'ları. |
| `email`, `email_source` | Mailler (`body_purged_at`: içerik saklama politikasıyla silindi; `in_reply_to`/`references`: yanıt başlıkları; `sender_auth`: sağlayıcının SPF/DKIM/DMARC sonucu, `sender_auth_captured` ile) ve süreli saklanan orijinal kaynakları. |
| `analysis_result` | Jev cevapları. |
| `rule`, `rule_evaluation` | Kurallar (sürümlü; `lineage_id` bir kuralın tüm sürümlerini bağlar) ve her mail için değerlendirme izi; istatistikler bu tablodan hesaplanır. |
| `rule_graph`, `rule_graph_version`, `rule_node` | Kural akışları. |
| `routing_decision` | Kararlar, akış yolu dahil. Mail başına tek **güncel** karar (kısmi benzersiz indeks); yeniden işlenen kararlar `superseded_at` ile geçmişte kalır. |
| `alert` | Operasyon uyarıları (açık / kapanmış). |
| `destination`, `destination_channel`, `destination_secret` | Hedefler, sürümlü kanallar, şifreli imza anahtarları. |
| `action_execution` | Kanal çalıştırmaları ve sonuçları. |
| `forward_recipient` | İletme alıcıları ve onay durumu. |
| `auto_reply_record` | Otomatik yanıtın her göndericiye en son ne zaman cevap verdiği (bekleme süresi için). |
| `forward_digest_item`, `forward_digest_batch` | Özet kuyruğu ve gönderilen özetler. |
| `ingestion_suppression` | Geri alınan taşımalar için bastırma kayıtları: geri dönen mailin yeni mail sanılmaması. 24 saat geçerli. |
| `sender_list_entry`, `routing_suggestion` | VIP/engel listeleri ve Review'dan hesaplanan öneriler. |
| `human_review_item` | Human Review sırası (`assigned_to`: atanan kullanıcı, `assigned_at`, `assignment_notified_at`: atama e-postası gönderildi mi; `human_correction` nedenli kayıtlar düzeltmelerin kanıtıdır). Notlar ayrı tabloda değil, `audit_event` içindedir. |
| `audit_event` | Değiştirilemez olay kaydı. |
| `app_user`, `membership`, `auth_event` | Kullanıcılar (dil tercihi dahil), üyelikler, giriş olayları. |
| `tenant_question` | Organizasyonun özel Jev soruları (anahtar, tip, metin, seçenekler; silinenler `deleted` olarak kalır). |
| `api_key` | API anahtarları: ad, baş kısım, SHA-256 özet, izinler, süre sonu, son kullanım, iptal. |
| `system_settings` | Arayüzden yönetilen sistem ayarları (tek satır). |

---

## 16. API referansı

Tüm organizasyon kapsamlı route'lar oturum çerezi ve `X-Organization-Id`
başlığı ister; ya da bir API anahtarı (`Authorization: Bearer jm_…`, başlık
isteğe bağlı). Hata cevapları `{ "error": { "code", "message", "requestId" } }`
biçimindedir.

**Oturum dışı:** `POST /api/v1/auth/login`, `POST /api/v1/auth/login/mfa`,
`POST /api/v1/auth/accept-invite`, `POST /api/v1/forward-recipients/verify`,
`GET /api/v1/mailboxes/oauth/:provider/callback` (oturum çerezi ister, organizasyon başlığı istemez),
`GET /api/v1/review-actions/preview?token=` ve `POST /api/v1/review-actions` (özet mailindeki imzalı bağlantılar),
`GET /api/v1/health`, `GET /api/v1/ready`, `GET /metrics`.

| Alan | Route'lar |
|---|---|
| SSO | `GET /auth/sso/providers` · `GET /auth/sso/:provider/start` · `GET /auth/sso/:provider/callback` (tarayıcı yönlendirmesi; oturumsuz) |
| API anahtarları | `GET/POST /api-keys` · `DELETE /api-keys/:id` (izin: `api_keys:manage`; yalnızca oturumla, anahtarla değil) |
| Gizlilik | `POST /privacy/erase-sender` (izin: `privacy:erase`) |
| Oturum | `POST /auth/logout` · `GET /auth/me` · `PUT /auth/me/locale` · `POST /auth/mfa/enroll` · `POST /auth/mfa/confirm` · `POST /auth/mfa/disable` · `POST /auth/password` · `GET /auth/sessions` · `DELETE /auth/sessions/:id` · `POST /auth/sessions/revoke-others` |
| Organizasyonlar | `GET/POST /organizations` · `GET/PATCH/DELETE /organizations/:id` |
| Üyeler | `GET/POST /organizations/:id/members` · `PATCH/DELETE /organizations/:id/members/:membershipId` |
| Ayarlar | `GET/PATCH /settings` · `POST /settings/smtp-test` |
| Mail kutuları | `GET/POST /mailboxes` · `GET/PATCH/DELETE /mailboxes/:id` · `POST /mailboxes/:id/reconcile` · `GET /mailboxes/oauth/providers` · `POST /mailboxes/oauth/:provider/start` |
| Mailler | `GET /emails` (filtreler: `state`, `mailboxConnectionId`, `sender`, `recipient`, `subject`, `destination` — hedef adı, `human_review` veya `left_alone` —, `receivedAfter`, `receivedBefore`) · `GET /emails/:id` (`senderAuth` dahil) · `/emails/:id/analysis` · `/emails/:id/routing` · `/emails/:id/executions` · `/emails/:id/audit` |
| Özel sorular | `GET/POST /questions` · `PATCH /questions/:id` · `DELETE /questions/:id[?force=true]` (409 + `usedBy`) · `GET /rules/fields` (organizasyonun tüm koşul alanları ve tipleri) |
| Kurallar | `GET/POST /rules` · `GET/PATCH/DELETE /rules/:id` (cevaplarda `stats`; riskli değişiklikte `409`, `confirmImpact: true` ile onay) · `POST /rules/impact` · `GET /rules/:id/versions` · `POST /rules/:id/revert` · `GET /rules/export` · `POST /rules/import` (gövde: `rules`, `mode: add\|replace`, `priorities: keep\|append`, `dryRun`) |
| Deneme | `POST /simulations` (izin: `rules:read` + `emails:read`; salt okunur; hedef: kural, akış veya liste kaydı) |
| Gönderici listeleri | `GET/POST /sender-lists` · `DELETE /sender-lists/:id` |
| Öneriler | `GET /routing-suggestions` · `POST /routing-suggestions/refresh` · `POST /routing-suggestions/:id/accept` · `POST /routing-suggestions/:id/dismiss` · kural önerileri: `GET /rule-suggestions` · `POST /rule-suggestions/refresh` · `POST /rule-suggestions/:id/accept` · `POST /rule-suggestions/:id/dismiss` |
| Kural akışları | `GET/POST /rule-graphs` · `GET/PATCH /rule-graphs/:id` · `PUT /rule-graphs/:id/enabled` · `POST /rule-graphs/validate` |
| Hedefler | `GET/POST /destinations` · `GET/PATCH/DELETE /destinations/:id` · `POST /destinations/:id/channels` · `PATCH/DELETE /destinations/:id/channels/:channelId` · `GET /destinations/:id/secrets` · `PUT/DELETE /destinations/:id/secrets/:name` |
| İletme alıcıları | `GET /forward-recipients` · `POST /forward-recipients/:id/resend` · `DELETE /forward-recipients/:id` |
| Kararlar ve işlemler | `GET /routing-decisions` · `GET /routing-decisions/:id` · `GET /action-executions` · `GET /action-executions/:id` · `POST /action-executions/:id/retry` · `POST /action-executions/:id/undo` |
| Human Review | `GET /reviews` (filtre `assignedTo=me\|none\|<kullanıcı>`) · `GET /reviews/:id` (`notes` dahil) · `POST /reviews/:id/resolve` · `GET /reviews/:id/similar?word=` · `POST /reviews/resolve` (toplu, en fazla 200) · `GET /reviews/assignees` · `POST /reviews/:id/assign` · `POST /reviews/:id/notes` |
| Kayıt ve özet | `GET /audit` · `GET /audit/export.csv?from=&to=&eventType=` · `GET /stats` · `GET /stats/reports?days=7\|30\|90&tz=&mailboxId=` · `GET /alerts?status=open\|resolved` · `GET /admin/reports?days=&tz=` (yalnızca superAdmin, organizasyon başlığı istemez) |
| Düzeltme | `POST /emails/:id/correct` (gövde: `destinationRef` veya `"inbox"`) · `GET /emails/:id/correction-rule?destinationRef=&wrong=` |
| Sağlık | `GET /mailboxes/health` · `GET /admin/queues` (superAdmin) |
| Yeniden işleme | `POST /emails/:id/reprocess` · `POST /emails/reprocess` (en fazla 100; ikisinde de `reanalyze`) · önizleme: `POST /simulations` hedef `{type:"current"}`, kapsam `emailIds` |

(Tablodaki yollar `/api/v1` önekiyle kullanılır.)

**İletme kanalı config örneği:**

```json
{
  "type": "forward",
  "config": {
    "mode": "attachment",
    "delivery": "digest",
    "digestIntervalMinutes": 1440,
    "to": ["pazarlama@sirket.com"],
    "cc": [],
    "bcc": [],
    "fromName": "Eumaeus",
    "replyTo": "original_sender",
    "subjectTemplate": "[{category}] {subject}",
    "includeAttachments": true,
    "includeAnalysis": true
  }
}
```

---

## 17. Kurulum ve geliştirme

### 17.1 Üretim kurulumu (Docker)

Gereksinimler: Docker (Compose v2), alan adının bu sunucuyu gösteren bir DNS
kaydı, 80 ve 443 portları.

```bash
cp deploy/.env.example deploy/.env      # DOMAIN, POSTGRES_PASSWORD, SECRET_ENCRYPTION_KEY,
                                        # JEV_API_KEY, BOOTSTRAP_ADMIN_* doldurun
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

- `SECRET_ENCRYPTION_KEY` için: `openssl rand -base64 32`. Bu anahtarı ayrıca
  saklayın: mail kutusu şifreleri, OAuth token'ları ve webhook sırları onunla
  şifrelenir; anahtar olmadan veritabanı yedeğindeki bu sırlar çözülemez.
- İlk açılışta yönetici hesabı `BOOTSTRAP_ADMIN_*` ile oluşturulur (sonraki
  açılışlarda asla üzerine yazılmaz). İlk girişten sonra şifreyi Güvenlik
  sayfasından değiştirin ve `deploy/.env` dosyasından silin; SMTP'yi
  Ayarlar'dan yapın.
- Servisler: `postgres`, `redis`, `api` (açılırken migration uygular),
  `worker`, `web`, `caddy` (HTTPS), `backup`. Hepsi `restart:
  unless-stopped`; `api`, `worker`, `web`, `postgres`, `redis` için sağlık
  kontrolü var.
- Güncelleme: kodu çekin ve aynı `up -d --build` komutunu çalıştırın;
  migration'lar kendiliğinden uygulanır.
- `ACME_EMAIL` isteğe bağlıdır. Boşsa Caddy hesabı e-postasız açar. Dolu
  olacaksa gerçek bir adres olmalıdır: Let's Encrypt `example.com` gibi
  adresleri reddeder.
- **Yerelde deneme:** `DOMAIN=localhost` ile Caddy kendi yerel sertifikasını
  üretir; tarayıcı güvenmez ama akış aynıdır.
- **macOS'ta deneme (Colima):**
  - Kurulum: `brew install colima docker docker-compose`, ardından
    `colima start`. Yönetici şifresi gerektirmez.
  - Colima varsayılan olarak yalnızca ev dizinini paylaşır. `BACKUP_PATH`
    ev dizini altında olmalıdır, varsayılan `./backups` uygundur; yoksa
    yedekler Mac'e değil sanal makineye yazılır.
- **Doğrulanan senaryolar (1.1, macOS + Colima):**
  - build yaklaşık 3 dakika sürdü;
  - 39 migration temiz bir veritabanına uygulandı;
  - HTTPS, `Secure` oturum çerezi, HTTP'den HTTPS'e yönlendirme ve
    dışarıya kapalı `/metrics` çalışıyor;
  - worker nabzı geliyor; öldürülen worker kendiliğinden yeniden başladı;
  - yedek alındı ve boş bir veritabanına birebir geri yüklendi.

### 17.1.1 Sunucuya kurulum rehberi (VPS)

1. **Sunucu.** Ubuntu 24.04 LTS, en az 2 vCPU, 4 GB RAM ve 40 GB disk
   yeterlidir. Kutu ve mail sayısı arttıkça RAM'i artırın. Hetzner,
   DigitalOcean ya da benzeri bir sağlayıcı olabilir.
2. **DNS.** Alan adınız için sunucunun IP adresine bir `A` kaydı (ve
   varsa bir `AAAA` kaydı) ekleyin, örneğin `mail.firma.com`. Kayıt
   yayılmadan Caddy sertifika alamaz.
3. **Güvenlik duvarı.** Yalnızca 22 (SSH), 80 ve 443 portlarını açın:
   ```bash
   ufw allow OpenSSH && ufw allow 80,443/tcp && ufw allow 443/udp && ufw enable
   ```
4. **Docker.** Resmî kurulum betiğiyle kurun:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
5. **Kod ve ayarlar.**
   ```bash
   git clone <repo> eumaeus && cd eumaeus
   cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
   ```
   Ardından `deploy/.env` içindeki `DOMAIN`, `POSTGRES_PASSWORD`,
   `SECRET_ENCRYPTION_KEY`, `JEV_API_KEY`, `BOOTSTRAP_ADMIN_*` ve
   `SYSTEM_ALERT_EMAILS` alanlarını doldurun.
6. **Başlatma.**
   ```bash
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   ```
   Durumu `docker compose -f deploy/docker-compose.yml ps` ile izleyin; tüm
   servisler `healthy` olmalıdır.
7. **İlk giriş.** `https://<DOMAIN>` adresinden bootstrap yöneticiyle girin.
   Sonra sırasıyla:
   - şifreyi değiştirin ve MFA'yı açın (Güvenlik);
   - SMTP'yi ayarlayıp test e-postası gönderin (Ayarlar);
   - `BOOTSTRAP_ADMIN_PASSWORD` satırını `deploy/.env` dosyasından silin.
8. **Güncelleme.**
   ```bash
   git pull
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
   ```
   Migration'lar API açılırken uygulanır.
9. **Yedeklerin sunucu dışına kopyası.** `deploy/backups/` klasörü aynı
   sunucudadır; sunucu kaybolursa yedekler de gider. Günlük bir kopya alın.
   `rclone` ile S3 uyumlu bir depolamaya örnek bir `cron` satırı:
   ```cron
   30 4 * * * rclone copy /root/eumaeus/deploy/backups remote:eumaeus-backups --max-age 48h
   ```
   `SECRET_ENCRYPTION_KEY`'i de ayrı ve güvenli bir yerde saklayın.
10. **İzleme.** Worker durursa `SYSTEM_ALERT_EMAILS` adreslerine e-posta
    gider (§14.1). Sunucunun kendisi için sağlayıcınızın izleme özelliğini ya
    da `https://<DOMAIN>/api/v1/ready` adresini yoklayan harici bir uptime
    servisini kullanın.

### 17.2 Yedekleme ve geri yükleme

`backup` servisi `BACKUP_INTERVAL_HOURS` saatte bir (varsayılan 24)
`BACKUP_PATH` klasörüne (varsayılan `deploy/backups`) `eumaeus-<zaman>.dump`
yazar; `BACKUP_RETENTION_DAYS` günden (varsayılan 14) eski yedekleri yalnızca
yeni yedek başarılı olursa siler.

Geri yükleme (boş bir veritabanına):

```bash
docker compose -f deploy/docker-compose.yml stop api worker
docker compose -f deploy/docker-compose.yml exec postgres dropdb -U eumaeus eumaeus
docker compose -f deploy/docker-compose.yml exec postgres createdb -U eumaeus eumaeus
docker compose -f deploy/docker-compose.yml run --rm -e PGPASSWORD=<şifre> backup \
  sh /scripts/restore.sh /backups/eumaeus-<zaman>.dump
docker compose -f deploy/docker-compose.yml start api worker
```

Yedekleri sunucunun dışına da kopyalayın (ör. günlük `rsync` ya da nesne
depolama); aynı diskteki yedek disk arızasına karşı korumaz.

### 17.3 Geliştirme ortamı

Gereksinimler: Node.js 22+, pnpm, PostgreSQL 16, Redis 7.

```bash
pnpm install
docker compose up -d                     # Postgres + Redis (yerelde kuruluysa gerekmez)

cp apps/api/.env.example apps/api/.env   # DATABASE_URL, REDIS_URL, JEV_API_KEY,
                                         # SECRET_ENCRYPTION_KEY, BOOTSTRAP_ADMIN_* doldurun
pnpm --filter api prisma:migrate:deploy
pnpm prisma:generate

pnpm api       # http://localhost:3000
pnpm worker
pnpm web       # http://localhost:3001
```

Tek komutla: `pnpm fastrun` Postgres/Redis'i denetler (macOS'ta Homebrew
servislerini başlatır), bekleyen migration'ları uygular ve üç servisi etiketli
loglarla bu terminalde çalıştırır (Ctrl+C hepsini durdurur).
`pnpm fastrun:bg` aynısını arka planda yapar (loglar `.run/` altında); orada
API ya da worker kendiliğinden kapanırsa 5 saniye sonra yeniden başlatılır ve
loga `[fastrun] … exited with <kod>` satırı düşer. `pnpm fastrun:status`
durumu ve worker nabzını gösterir, `pnpm fastrun:stop` durdurur.

Not: Bilgisayar uykudayken senkron da uyur; uyanınca kaldığı UID'den devam
eder, posta kaybolmaz ama gecikir. Kesintisiz çalışma için sunucu kurulumu
(§17.1) kullanılmalıdır.

Yeni bir migration üretmek için `prisma migrate diff` ile gölge veritabanı
kullanılır; klasör adı mevcut en son migration'dan sonra sıralanmalıdır.

Proje yapısı:

```
apps/api   Fastify 5 API, BullMQ worker, Prisma 6 şeması
apps/web   Next.js 16 arayüzü (React 19, React Query)
deploy/    Docker Compose üretim kurulumu, Caddy, yedekleme betikleri
docs/      Mimari notlar, yük testi
```

---

## 18. Testler

```bash
pnpm test        # api (Vitest, gerçek Postgres + Redis) + web
pnpm typecheck
pnpm lint
```

Backend testleri test veritabanına (`DATABASE_URL_TEST`) karşı çalışır; gerçek
IMAP, SMTP veya Jev hesabı gerekmez (sahte istemciler kullanılır). Mimari
testleri modül sınırlarını zorlar (ör. hedefler modülü Jev veya kural modülünü
içe aktaramaz).

Testler Redis'te **ayrı bir veritabanı** kullanır (`REDIS_URL_TEST`, yoksa aynı
sunucunun 15 numaralı veritabanı). 0.26'ya kadar testler canlı kuyrukları
paylaşıyordu: çalışan bir geliştirme worker'ı test işlerini kapabiliyordu
(eskiden “zaman zaman başarısız olan 4 BullMQ testi” bundandı) ve bir test
canlı kuyruğu temizleyebiliyordu. 0.30.0'da 115 backend test dosyası (912
test) ve 32 web test dosyası (123 test) geçer.

---

## 19. Bilinen sınırlar

- **Mail kutusundan mail silinmez, yalnızca taşınır.** Bilinçli tasarım; her
  taşıma arayüzden geri alınabilir (bölüm 7.3). Saklama ve KVKK silme yalnızca
  Eumaeus'un kendi kopyasını siler.
- **Silinen göndericiden yeni mail gelirse** normal şekilde işlenir; KVKK
  silmesi geçmişe yöneliktir. Gelecek mailleri engellemek için engel listesi
  kullanılır.
- **SSO hesap açmaz.** Kişi önce davet edilmelidir.
- **Mail önce kutuya düşer.** Sistem kutuyu aralıklarla kontrol eder; mail
  sunucusuna ulaşmadan önce yakalama yoktur.
- **Yalnızca IMAP.** Gmail ve Microsoft 365 artık oturum açılarak (OAuth)
  bağlanabilir; diğer sağlayıcılar şifreyle. POP3 ve Gmail API yok.
- **Google'ın güvenlik incelemesi.** Gmail OAuth uygulaması kendi Workspace
  alanınız dışındaki hesaplara açılacaksa Google'ın doğrulama sürecinden
  geçmelidir; o zamana kadar yalnızca Internal ya da test kullanıcılarıyla
  çalışır.
- **Özel soruların cevabı eski maillerde yok.** Jev'e yeniden sormak
  (Reprocess › Ask Jev again) ücretli bir çağrıdır; mail başına yapılır (toplu
  uçta en fazla 100).
- **Gönderen doğrulama sağlayıcının sözüne dayanır** (bkz. 4.2): Eumaeus DNS
  kontrolü yapmaz; orijinali artık saklanmayan eski mailler için değer yoktur.
- **Arayüz iki dilli (Türkçe, İngilizce).** API hata mesajları ve uyarı
  başlıkları İngilizcedir.
- **0.13.0'dan önce gelen mailler** için orijinal kaynak yoktur; bunlar
  iletilirse eksiz, metin olarak gider.

---

## 20. Sık sorulanlar

**Neden neredeyse her mail Human Review'a düşüyor?** Ya hiçbir kural
eşleşmiyor (Emails ekranında maili açıp kural değerlendirmesine bakın) ya da
Jev'in “insan bakmalı” sinyali eşiği sık aşıyor (Review policy'den eşiği
yükseltin veya kapatın).

**Spam'i otomatik temizleyebilir miyim?** Klasöre taşıma kanallı bir hedef
(`Junk` veya `Trash`) ve `answers.is_spam >= 0.8` koşullu bir kural yazın.

**Pazarlama maillerini bir adrese iletebilir miyim?** Evet, bölüm 8.5.

**İletme maili neden gitmedi?** Destinations'ta alıcının onay durumuna, Emails
ekranında işlem sonucuna bakın: onaysız alıcı, günlük limit, izin listesi veya
SMTP hatası orada gerekçesiyle yazar.

**Bir göndericinin maillerine hiç dokunulmasın istiyorum.** Sender lists
ekranından VIP listesine ekleyin. O göndericinin mailleri kurallardan ve
Human Review'dan muaf tutulur.

**Sürekli spam işaretlediğim bir gönderici var.** Human Review ekranındaki
öneriler paneline bakın; 5 ve daha fazla mail aynı şekilde çözüldüyse sistem
engellemeyi önerir. Beklemek istemiyorsanız Sender lists'ten doğrudan
ekleyebilirsiniz.

**Yanlışlıkla Junk'a taşınan bir maili nasıl geri getiririm?** Emails
ekranında maili açın, Processing sekmesinde taşımanın yanındaki **Undo move**
düğmesine basın. Mail gelen kutusuna döner ve tekrar taşınmaz.

**Maili taşımadan sadece okundu yapabilir veya etiketleyebilir miyim?** Evet,
hedefe “Mark read, star or label” (`flag`) kanalı ekleyin.

**Bir kuralı düzelttim, eski mailler de düzelsin istiyorum.** Emails
ekranında maili açıp **Check with current rules** ile ne olacağını görün,
sonra **Reprocess**'e basın (izin: `emails:reprocess`). Mail başka klasöre
taşınmışsa önce **Undo move**.

**Bir mail kutusu bozulursa haberim olur mu?** Evet. 30 dakika boyunca
senkronlanamayan kutu için Overview'da uyarı çıkar ve organizasyonu
yönetenlere e-posta gider. Düzelince “Resolved” maili gelir.

**İş başvurularına otomatik “aldık” cevabı verebilir miyim?** Evet. Bir hedefe
“Reply to the sender automatically” kanalı ekleyin ve `answers.category ==
job_offer` koşuluyla bu hedefe giden bir kural yazın. Bültenlere, no-reply
adreslerine ve spam'e cevap gitmez.

**Kendi sorumu Jev'e sorabilir miyim?** Evet: Organizasyon › Jev questions ›
yeni soru. Örneğin “Bu mail bir faturanın gecikmesinden mi bahsediyor?”
(evet/hayır, anahtar `is_invoice_overdue`). Sonra kurala
`answers.is_invoice_overdue >= 0.8` koşulunu yazın.

**Mesai dışında gelen acil mailleri ayrı bir yere yönlendirebilir miyim?**
Evet: önce Organizasyon › Working hours'ı ayarlayın, sonra
`email.business_hours == false AND answers.urgency >= 2` koşullu bir kural.

**Arayüzü Türkçe yapabilir miyim?** Evet: üst çubuktaki dil seçiciden
Türkçe'yi seçin. Seçim hesabınıza kaydedilir, size gelen e-postalar da Türkçe
olur.

**Bir müşteri KVKK kapsamında verilerinin silinmesini istedi. Ne yaparım?**
Organizasyon › Data & privacy › Erase a sender. Adresi yazıp **Find** ile ne
silineceğini görün, adresi yeniden yazarak onaylayın. Mail kutusundaki
mesajları ayrıca mail sağlayıcınızdan silmeniz gerekir.

**CRM'imiz Eumaeus'tan veri çekebilir mi?** Evet. Organizasyon › API keys'ten
yalnızca gereken izinlerle (ör. `emails:read`) bir anahtar oluşturun ve
`Authorization: Bearer jm_…` başlığıyla kullanın.

**Elimdeki hazır kural setini nasıl yüklerim?** Rules › Import JSON. Dosyayı
seçin, **Check** ile kontrol edin, hata yoksa **Import**'a basın. Bir
organizasyondaki kuralları başka birine taşımak için önce oradan **Export JSON**
alın.

**Önemli müşteri maillerini Slack'e düşürebilir miyim?** Evet: “Post to Slack”
kanallı bir hedef ve örneğin `answers.is_customer_related >= 0.8` koşullu bir
kural. Aynı hedefe Jira kanalı eklerseniz kayıt da açılır.

**Kural mı çalışır, akış mı?** Mail kutusuna açık bir akış atanmışsa akış.

**Yeni bir kuralı canlıya almadan nasıl denerim?** Kural editöründeki **Try on
past emails** panelinden **Run**'a basın. Kaydetmeden, geçmiş maillerde neyin
değişeceğini gösterir (bölüm 6.4).

**Bir kural hiç çalışıyor mu?** Rules listesindeki eşleşme sütununa bakın.
“No matches in 30 days” rozeti, maillerin ulaştığı ama kuralın hiç uymadığı
anlamına gelir.

**Mail kutum “Command failed” diyor.** Genellikle kimlik bilgisi sorunudur.
En kolayı kutuyu **Connect Gmail** / **Connect Microsoft 365** ile yeniden
bağlamaktır. Şifreyle bağlıyorsanız Gmail'de IMAP'i açın ve App Password
kullanın.

**Kutum “Sign-in expired” diyor.** Hesabın şifresi değişmiş ya da Eumaeus'un
erişimi kaldırılmış. Mailboxes ekranındaki **Reconnect** ile tekrar oturum
açın; senkron kaldığı yerden devam eder.

**Davet veya onay mailleri gitmiyor.** Settings › **Send test email** ile
deneyin; ekrandaki ipucu sorunun port/TLS eşleşmesi, kimlik bilgisi, sunucuya
erişim ya da gönderen adresi olduğunu söyler (bölüm 11).

**MFA kodumu kaybettim.** Oturumunuz açıksa Security'den MFA'yı kapatıp yeniden
kurun; değilse bir yöneticiden yardım isteyin.

---

## 21. Sürüm geçmişi

| Sürüm | Faz | Başlıca eklemeler |
|---|---|---|
| 0.1 | 1 | IMAP toplama, idempotent kayıt |
| 0.2 | 2 | Zamanlanmış senkron, bağlantı sağlığı |
| 0.3 | 3 | Jev AI analizi |
| 0.4 | 4 | Kural motoru |
| 0.5 | 5A/5B | Klasöre taşıma, webhook, imza anahtarları |
| 0.6 | 6 | Kontrol paneli API'si |
| 0.7 | 7 | Güvenli kapanış, hazır olma kontrolleri |
| 0.8 | 8 | Web arayüzü |
| 0.9 | 9 | Kural akışı veri modeli ve editör |
| 0.10 | 10 | Organizasyonlar, çoklu mail kutusu, Human Review çözümü |
| 0.11 | 11 | Kullanıcılar, izinler, MFA, davetler, sistem ayarları |
| 0.12 | 12 | Review eşiği ve özeti, hesap güvenliği, kanal yönetimi, kural akışlarının canlı çalışması |
| 0.13 | 13 | İletme kanalı (hemen veya özet), alıcı onayı, iletme güvenlik önlemleri, orijinal mail saklama |
| 0.13.1 | bakım | SMTP test maili, port/TLS uyumsuzluk koruması, hedef oluşturma bütünlüğü |
| 0.14 | 14 | Geçmiş maillerde deneme (kural ve akış), kural istatistikleri, ortak karar çekirdeği |
| 0.15 | 15 | Bayrak/etiket kanalı, taşımadan önce bayrak, taşımayı geri alma |
| 0.16 | 16 | VIP ve engel listeleri, Review'dan öneriler, liste kaydını deneme |
| 0.17 | 17 | Gmail ve Microsoft 365'i oturum açarak (OAuth) bağlama, otomatik token yenileme, yeniden bağlama |
| 0.18 | 18 | Operasyon uyarıları (e-posta, webhook), yeniden işleme (sürümlü kararlar), raporlar |
| 0.19 | 19 | Otomatik yanıt, Slack, Teams, Jira ve Zendesk kanalları, kural JSON içe/dışa aktarma, raporlarda host görünümü |
| 0.20 | 20 | Saklama süreleri, KVKK silme, audit CSV, API anahtarları, Google/Microsoft ile giriş |
| 0.21 | 21 | Türkçe arayüz, iki dilli sistem e-postaları, yerelleştirilmiş tarih ve sayılar |
| 0.22 | 22 | Organizasyona özel Jev soruları, geliş bağlamı koşulları, mesai saatleri, Jev'e yeniden sorma |
| 0.23 | 23 + düzeltme turu | Kaydetmeden önce kural etkisi ve riskli değişiklik onayı, konu kelimesine göre kural önerileri, Türkçe duyarlı `contains`, zincirli taşıma geri alma; özet mailinden tek tıkla karar, klavye kısayolları, benzerlerine uygula, review izin kontrolleri |
| 0.24 | 24 | “Yanlış yere gitti” düzeltmesi, insan düzeltmesi kanıtı, düzeltmeden kural önerisi |
| 0.25 | 25 | Kural sürüm geçmişi, sürüme geri dönme, silinmiş kuralı geri getirme |
| 0.26 | 26 | Mail kutusu eşitleme sağlığı, iş kuyruğu görünümü, başarısız işlerin otomatik temizliği, testlerde ayrı Redis |
| 0.27 | 27 | SPF / DKIM / DMARC yakalama, `sender.*` doğrulama koşulları, doğrulama rozeti |
| 0.28 | 28 | Mail araması (alıcı, hedef, tarih), Human Review ataması ve notları |
| 0.29 | ek | **Eşikli atama e-postaları, eski mailler için gönderen doğrulama, art arda hata sayısı, organizasyon sayfasından Google/Microsoft ile kutu ekleme, devre dışı bırakma ve kalıcı silme |
| 0.30 | ad | Yeni ad: Eumaeus (eski adla oluşturulan başlık, bağlantı ve dosyalarla uyumlu) |
| 0.31 | görünüm | “Çam ve Kil” teması (Claude turuncusu vurgu), Nöbetçi logosu |
| **1.0** | **üretim** | **Docker ile kurulum, otomatik HTTPS, yedekleme, dağıtık hız sınırlama, güvenlik başlıkları, yük testi** |
| 1.0.1 | bakım | Düşen IMAP bağlantısının artığı worker'ı durdurmuyor; `pnpm fastrun`, arka planda çöken API/worker'ı yeniden başlatma |
| 1.0.2 | e-posta | Tasarımlı uyarı e-postası: logo, durum rozeti, hata kutusu, zamanlar ve süre, türe göre öneri, ilgili sayfaya düğme; tüm sistem e-postaları aynı tasarımda |
| 1.1 | nöbet | Worker bekçisi, anında posta alma (IMAP IDLE), şema kayması testi, GitHub Actions CI, Docker kurulumunun uçtan uca doğrulanması ve VPS rehberi |
| 1.2 | görünürlük ve bildirim | Giden e-posta kaydı, kural tetiklenince e-posta bildirimi (`email_notify`), tüm sistem e-postaları ortak tasarımda, uyarılar okuyanın dilinde, Jev durumu kartı |

---

## 22. Yol haritası

1.0.0 ile yol haritasındaki tüm fazlar tamamlandı. Gerekçeleri ve kabul
kriterleriyle birlikte fazların tamamı `docs/roadmap.md` dosyasındadır.
Sonraki sürümler için açık konular:

- Mail HTML gövdesini güvenli biçimde gösterme (şu an yalnızca düz metin).
- Birden fazla worker kopyası için kuyruk başına eş zamanlılık ayarları.
- Yedeklerin nesne depolamaya (S3 uyumlu) otomatik gönderilmesi.
