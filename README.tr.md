<p align="center"><img src="apps/web/app/icon.svg" width="72" height="72" alt="Eumaeus logosu"></p>

<h1 align="center">Eumaeus</h1>

<p align="center">E-posta kontrol paneli: her mail okunur, anlaşılır, yönlendirilir ve kayda geçer.</p>

<p align="center"><a href="README.md">English</a> · <a href="docs/eumaeus-1.0.0.md">Tam dokümantasyon</a> · <a href="CHANGELOG.md">Değişiklikler</a> · <a href="LICENSE">Apache-2.0</a></p>

---

Eumaeus bağlanan IMAP mail kutularını düzenli olarak kontrol eder, gelen her
maili [Jev AI](https://api.typesafe.ai) ile analiz ettirir (spam mı, hangi
kategori, cevap gerekiyor mu, ne kadar acil), kurallarınıza göre ne
yapılacağına karar verir ve uygular: klasöre taşır, başka adrese iletir,
webhook'a, Slack'e, Teams'e, Jira'ya veya Zendesk'e gönderir ya da otomatik
yanıt verir. Emin olmadığı mailleri insan kontrolüne bırakır. Her adım
değiştirilemez bir denetim kaydına yazılır.

Çok organizasyonludur: tek kurulum birçok organizasyona hizmet eder; her
birinin kendi mail kutuları, kuralları, üyeleri ve izinleri vardır.

*Eumaeus, Odysseia'da Odysseus'un sadık çobanıdır: gözcülük eder, kapıya
geleni karşılar.*

## Kurulum (üretim)

Gereksinimler: Docker (Compose v2), sunucuyu gösteren bir alan adı, açık 80 ve
443 portları.

```sh
git clone <bu depo> eumaeus && cd eumaeus
cp deploy/.env.example deploy/.env
# DOMAIN, POSTGRES_PASSWORD, SECRET_ENCRYPTION_KEY (openssl rand -base64 32),
# JEV_API_KEY ve BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD değerlerini doldurun
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Ardından `https://<alan adınız>` adresini açın, ilk yönetici hesabıyla giriş
yapın, şifreyi değiştirin (Güvenlik), SMTP'yi ayarlayın (Ayarlar) ve bir
organizasyonla mail kutularını ekleyin.

Kurulumda PostgreSQL 16, Redis 7, API, arka plan worker'ı, web uygulaması,
Caddy (Let's Encrypt ile otomatik HTTPS) ve yedekleme servisi vardır. Dışarıya
yalnızca Caddy açıktır; her servis kendiliğinden yeniden başlar ve sağlık
kontrolüne sahiptir. Veritabanı migration'ları API açılırken uygulanır.

**`SECRET_ENCRYPTION_KEY` değerini güvenli bir yerde saklayın.** Mail kutusu
şifreleri, OAuth token'ları ve webhook sırları onunla şifrelenir; anahtar
olmadan veritabanı yedeğindeki bu sırlar çözülemez.

Yedekleme, geri yükleme, güncelleme ve tüm özellikler için:
[tam dokümantasyon](docs/eumaeus-1.0.0.md).

## Geliştirme

Gereksinimler: Node.js 22+, pnpm, PostgreSQL 16, Redis 7.

```sh
pnpm install
cp apps/api/.env.example apps/api/.env      # doldurun
pnpm fastrun          # Postgres/Redis'i kontrol eder, migration'ları uygular; API :3000,
                      # worker ve arayüz :3001 birlikte başlar; Ctrl+C hepsini kapatır
pnpm test && pnpm typecheck && pnpm lint
```

`pnpm fastrun:bg` aynısını arka planda başlatır (loglar `.run/` içinde),
`pnpm fastrun:status` neyin çalıştığını ve sağlığını gösterir,
`pnpm fastrun:stop` durdurur. Servisler tek tek `pnpm api`, `pnpm worker` ve
`pnpm web` ile de çalıştırılabilir.

## Lisans

Apache License 2.0 — bkz. [LICENSE](LICENSE) ve [NOTICE](NOTICE).
