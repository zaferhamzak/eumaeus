# Jev AI — Teknik Rehber

> Kaynak: TypeSafe AI resmi duyurusu, Wikipedia, OpenRouter/Vercel/Cloudflare dokümantasyonu ve üçüncü parti geliştirici yazıları (Eylül 2026). Jev çok yeni bir ürün olduğu için bazı detaylar zamanla değişebilir — canlıya almadan önce resmi dokümantasyonu (console.typesafe.ai) tekrar kontrol edin.

## 1. Jev nedir?

Jev, **TypeSafe AI** (San Francisco, 2024 kuruluş) tarafından 15 Eylül 2026'da tanıtılan, kendilerinin **"System One Model"** adını verdiği yeni bir model sınıfının ilk örneği.

Fikir Kahneman'ın Sistem 1 / Sistem 2 ayrımından geliyor:

| | Sistem 2 (klasik LLM) | Sistem 1 (Jev) |
|---|---|---|
| Davranış | Yavaş, adım adım "düşünür" (chain-of-thought) | Hızlı, sezgisel, tek adımda karar verir |
| Çıktı | Serbest metin (parse edilmesi gerekir) | Önceden tanımlı şemaya sıkı sıkıya bağlı tipli değer |
| Kullanım alanı | Yazma, özetleme, açık uçlu akıl yürütme | Sınıflandırma, skorlama, yönlendirme, evet/hayır kararları |
| Maliyet/Gecikme | Yüksek | Çok düşük (70–500ms, girdi $0.042/M token, çıktı ücretsiz) |

**Özetle Jev bir metin üretme modeli değil, bir *karar* modelidir.** Bir "durum" (state) verirsiniz, ona dair önceden tanımladığınız soruları (questions) sorarsınız, o da her soru için olasılık dağılımı + güven skoru içeren tipli bir cevap döner.

---

## 2. Teknik olarak nasıl çalışır?

1. **State (durum)**: Değerlendirilecek ham veri — serbest metin, JSON, mesaj geçmişi, tool çıktısı, form verisi vs. olabilir.
2. **Questions (sorular)**: State hakkında sormak istediğiniz, önceden tipi belirlenmiş kararlar. Bir istekte birden fazla soru sorabilirsiniz.
3. Model, tüm soruları **tek bir çağrıda paralel** değerlendirir — yani 10 soru sormak, 1 soru sormakla neredeyse aynı sürede sonuçlanır (transformer'ın tek forward-pass'inde tüm sorular birlikte işlenir).
4. Çıktı, sorulan şemanın **dışına asla çıkamaz** — model "typesafe/jev-1.13" gibi bir model ID'siyle çağrılır ve dönen değer sadece sizin tanımladığınız seçenek kümesinden biri olabilir. Bu, geleneksel LLM'lerdeki "modelin şemayı bozması / var olmayan alan icat etmesi" (hallüsinasyon) riskini yapısal olarak ortadan kaldırır.
5. **Eğitim yöntemi**: Model sentetik veriyle, TypeSafe'in "RLCD" (Reinforcement Learning for Calibrated Decisions) dediği bir yöntemle eğitilmiş. Amaç insan tercihini taklit etmek değil, **olasılık tahminlerini gerçek sonuçlara göre kalibre etmek** — yani "%80 eminim" dediğinde gerçekten ~%80 ihtimalle doğru olması hedefleniyor.
6. **Context window**: ~32.000 token.

### Mimari zihniyet
Jev'i bir LLM gibi değil, agent/uygulama akışınızın içine gömülü **"anlamsal if-statement"** gibi düşünün:

```
kullanıcı girdisi / tool çıktısı
        │
        ▼
   Jev: sınıflandır / puanla / yönlendir  (70-500ms)
        │
        ├─ düşük riskli → doğrudan otomatik işlem
        ├─ orta riskli  → tam LLM çağrısı (GPT-5.6 vb.)
        └─ yüksek riskli → insan onayı
```

---

## 3. Typed Questions Yapısı

Jev üç soru **primitifi (tipi)** destekler. Her sorunun `type`, `instructions` (ve Choice için `criteria`) alanları vardır.

### 3.1 `Noul` — Evet/Hayır olasılığı
Bir önermenin doğru olma olasılığını 0–1 arası bir sayı olarak döner.

```json
{
  "urgent": {
    "type": "noul",
    "instructions": "Bu mesaj şu anda acil müdahale gerektiriyor mu?"
  }
}
```
→ Cevap: `{"noul": 0.91, "confidence": 0.84}`

### 3.2 `Choice` — Çoktan seçmeli
Önceden tanımlı seçenekler arasından seçim yapar; her seçenek için olasılık dağılımı döner (255 seçeneğe kadar).

```json
{
  "category": {
    "type": "choice",
    "instructions": "Bu destek talebini en uygun kategoriye ata.",
    "criteria": {
      "billing": "Fatura, ödeme, abonelik ile ilgili",
      "technical": "Hata, çökme, teknik sorun",
      "sales": "Satış öncesi soru, fiyat teklifi"
    }
  }
}
```
→ Cevap: `{"choice": "technical", "probabilities": {"billing": 0.04, "technical": 0.89, "sales": 0.07}, "confidence": 0.86}`

### 3.3 `Score` — Sıralı derecelendirme
Önceden tanımlı sıralı seviyelerde puanlama yapar.

```json
{
  "churn_risk": {
    "type": "score",
    "instructions": "Müşterinin önümüzdeki 30 gün içinde ayrılma riskini derecelendir.",
    "criteria": {
      "low": "Aktif kullanım, olumlu sinyaller",
      "medium": "Kullanım azalmış",
      "high": "Uzun süredir giriş yok, şikayet var"
    }
  }
}
```
→ Cevap: `{"score": "medium", "probabilities": {"low": 0.15, "medium": 0.61, "high": 0.24}, "confidence": 0.72}`

> **Önemli:** `confidence` alanı "cevabın doğru olma ihtimali" değildir — modelin kendi tahminine ne kadar güvendiğini gösteren ayrı bir kalibrasyon metriğidir. İkisini karıştırmayın.

---

## 4. API Kullanımı

### 4.1 Erişim yolları

Jev'e üç farklı yoldan erişebilirsiniz:

| Yol | Ne zaman tercih edilir | Not |
|---|---|---|
| **TypeSafe Console (doğrudan)** | Üretim, tam kontrol, en düşük katman | `console.typesafe.ai` üzerinden early-access waitlist gerekir |
| **Vercel AI Gateway** | En hızlı başlangıç, mevcut Vercel projeleri | 25 Eylül 2026'ya kadar ücretsiz (ödeme yöntemi kayıtlı olmalı), kurulum dakikalar sürüyor |
| **OpenRouter / Cloudflare AI** | Çoklu model sağlayıcısı kullanan projeler | Model ID: `typesafe/jev` veya `typesafe/jev-1.13` |
| **LangChain (`langchain-typesafe`)** | Agent/LangChain tabanlı sistemler | `pip install langchain-typesafe`, `TYPESAFE_API_KEY` env değişkeni |

### 4.2 Authentication

Bearer token ile, sunucu tarafında saklanması gereken bir API key:

```
Authorization: Bearer <TYPESAFE_API_KEY>
Content-Type: application/json
```

### 4.3 Endpoint (OpenRouter üzerinden örnek)

```
POST https://openrouter.ai/api/alpha/decisions
```

### 4.4 Request şeması

```json
{
  "model": "typesafe/jev-1.13",
  "state": "Deploy iki kez başarısız oldu, kullanıcılar 500 hatası alıyor. Şu an bakabilecek biri var mı?",
  "questions": {
    "urgent": {
      "type": "noul",
      "instructions": "Bu mesaj şu anda acil müdahale gerektiriyor mu?"
    },
    "team": {
      "type": "choice",
      "instructions": "Bu sorunu hangi ekibe yönlendirmeliyiz?",
      "criteria": {
        "infra": "Altyapı / deploy sorunları",
        "backend": "Uygulama mantığı hataları",
        "support": "Müşteri iletişimi"
      }
    }
  }
}
```

### 4.5 Response şeması

```json
{
  "answers": {
    "urgent": {
      "noul": 0.94,
      "confidence": 0.88
    },
    "team": {
      "choice": "infra",
      "probabilities": {"infra": 0.81, "backend": 0.15, "support": 0.04},
      "confidence": 0.79
    }
  },
  "usage": {
    "input_tokens": 142,
    "output_tokens": 0
  }
}
```

Çıktı tokenleri **ücretsizdir** çünkü model metin üretmez — sadece önceden var olan şemayı doldurur.

### 4.6 curl örneği

```bash
curl -X POST https://openrouter.ai/api/alpha/decisions \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "typesafe/jev-1.13",
    "state": "...",
    "questions": { "urgent": { "type": "noul", "instructions": "..." } }
  }'
```

### 4.7 Python (LangChain entegrasyonu) örneği

```python
from langchain_typesafe import Noul, Choice, TypeSafeClassifier

classifier = TypeSafeClassifier()  # TYPESAFE_API_KEY env'den okunur

response = classifier.invoke(
    state="Deploy iki kez başarısız oldu, kullanıcılar 500 hatası görüyor.",
    questions={
        "urgent": Noul(instructions="Bu mesaj şu anda acil müdahale gerektiriyor mu?"),
        "team": Choice(
            instructions="Hangi ekibe yönlendirilmeli?",
            criteria={"infra": "Altyapı sorunları", "backend": "Uygulama hataları"},
        ),
    },
)

is_urgent = response.nouls["urgent"].noul          # 0.94
target_team = response.choices["team"].choice       # "infra"
```

---

## 5. Sınırlamalar

- **Metin üretmez.** Özetleme, kod yazma, serbest açıklama, e-posta taslağı yazma gibi açık uçlu görevlerde kullanılamaz — sadece Noul/Choice/Score tipinde kapalı kararlar verir.
- **Görüntü desteklemiyor** (henüz metin/yapılandırılmış veriyle sınırlı).
- **Gerekçe (rationale) vermez.** Sadece olasılık + güven döner; "neden bu kararı verdi" sorusuna cevap yok. Denetim (audit) gerektiren alanlarda bu, LLM ile desteklenmesi gereken bir boşluk.
- **State'i düşmanca (adversarial) olarak ele almaz.** Bir güvenlik testinde, state'e enjekte edilen sahte/yanıltıcı bir tool çıktısı, bir "engelleme" kararının olasılığını 0.76'dan 0.48'e düşürebilmiş — yani **prompt injection karar sonucunu doğrudan etkileyebiliyor.**
- **Seçenek sırasına duyarlı.** Choice sorularında seçeneklerin sırası cevabı kaydırabilir.
- **`confidence` = doğruluk olasılığı değildir.** Kalibrasyon marjı olarak yorumlanmalı, kesinlik garantisi olarak değil.
- Performans rakamları (40–200x hız, 40–400x maliyet avantajı) TypeSafe'in kendi iç testlerine dayanıyor; bağımsız doğrulama sınırlı — üretime almadan önce kendi verinizle test edin.

**Öneri (Pydantic/LangChain ekiplerinden):** Jev'i tek başına karar verici olarak değil, **deterministik kontrollerle birlikte** ve kritik/yüksek riskli işlemlerde **insan onayı** ile kullanın.

---

## 6. Ne zaman Jev, ne zaman klasik LLM?

**Jev kullanın:**
- Yüksek hacimli, tekrarlanan sınıflandırma (destek biletleri, e-posta kategorileme, içerik moderasyonu)
- Gerçek zamanlı/gecikmeye duyarlı kararlar (agent içi routing, oyun durumu tepkisi)
- Ölçekli skorlama (milyonlarca satırı ucuza puanlamak — örn. 50M yorumu ~$20'a değerlendirmek)
- Agent mimarisinde "düşük riskli kararı otomatik geçir, belirsizi LLM'e/insana eskale et" filtre katmanı

**Klasik LLM kullanın:**
- Serbest metin üretimi gerektiren her şey (yazma, özetleme, kod, açıklama)
- Gerekçelendirme/izlenebilirlik gereken denetim senaryoları
- Düşmanca girdiye karşı dayanıklılık kritikse (tek başına Jev'e güvenmeyin)

**Eumaeus projesi bağlamında** olası kullanım: gelen e-postaları önce Jev ile (acil mi / hangi kategori / hangi ekibe yönlendirilmeli gibi) hızlı ve ucuza triage edip, sadece yanıt yazımı gerektiren e-postaları tam LLM'e devretmek — maliyeti ve gecikmeyi düşürecek bir ön filtre katmanı olarak.

---

## 7. Kaynaklar

- [TypeSafe AI — Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [Wikipedia — Jev (AI model)](https://en.wikipedia.org/wiki/Jev_(AI_model))
- [VentureBeat — Companies are putting Jev in charge of AI agent decisions](https://venturebeat.com/security/companies-are-putting-jev-in-charge-of-ai-agent-decisions-and-prompt-injection-can-influence-the-verdict)
- [AIHubMix — Jev Explained: How to Add Fast, Typed Decisions to an AI Agent](https://aihubmix.com/blog/jev-explained-how-to-add-fast-typed-decisions-to-an-ai-agent)
- [DataCamp — System One Models: Jev](https://www.datacamp.com/blog/system-one-models-jev)
- [Vercel — What is Jev, TypeSafe AI's System One model?](https://vercel.com/i/what-is-jev)
- [Cloudflare AI Docs — Jev (typesafe)](https://developers.cloudflare.com/ai/models/typesafe/jev/)
- [Jev AI Developer Guides & Community](https://jevai.dev/)
- [AI Profit Boardroom — Jev AI API: State, Questions, Three Access Routes](https://aiprofitboardroom.com/blog/jev-ai-api/)
- [kie.ai — What Is Jev? The $0.042 Decision Model](https://kie.ai/blog/what-is-jev)
