# Çerçeve Arşiv Worker — kurulum

Toplam ~15 dakika. Cloudflare hesabı yoksa ücretsiz açılıyor.

## 1. R2 bucket

Cloudflare panel → **R2** → *Create bucket* → ad: `opus-arsiv`.

> R2 ücretsiz katmanı: 10 GB depolama, çıkış (egress) **ücretsiz**.
> Bizim hacim ~1 TB/yıl → aylık büyüyen depolama için ücretli plana geçilir,
> ama çıkış bedava kaldığı için yayın trafiği para yakmaz.

## 2. Worker deploy

Bu klasörde:

```bash
npx wrangler deploy
```

İlk çalıştırmada tarayıcıdan Cloudflare girişi ister.

## 3. Sırları tanımla

```bash
npx wrangler secret put UP_KEY
```

Sorduğunda **Upload-Post API anahtarını** yapıştır (n8n'deki `Header Auth account`
kimliğinde duran anahtarın aynısı — `Apikey ` öneki OLMADAN, yalnız anahtar).

```bash
npx wrangler secret put OPUS_KEY
```

Buraya **kendi ürettiğin uzun rastgele bir dize** yapıştır (ör. 40 karakter).
Aynısını panele gireceksin. Bu, Worker'a yalnız senin n8n'inin erişmesini sağlar.

## 4. Doğrula

Deploy çıktısındaki adresi al (`https://opus-arsiv.<hesabin>.workers.dev`) ve:

```bash
curl https://opus-arsiv.<hesabin>.workers.dev/saglik
```

Beklenen: `{"opus":true,"ok":true,"upKey":true,"opusKey":true,"r2":true}`

Üçü de `true` değilse ilgili adım eksik.

## 5. Panele gir

Panel → **Çerçeve** → *Arşiv (R2 Worker)* bölümü:

- **Worker adresi**: `https://opus-arsiv.<hesabin>.workers.dev`
- **Paylaşılan sır**: 3. adımda `OPUS_KEY` olarak girdiğin dize

Sonra **⇪ Şimdi Gönder**'e bas — ayarlar n8n'e gider ve çerçeve sistemi açılır.

## Ne olmuş oluyor

```
n8n  ──POST /al {jobId,key}──►  Worker
                                  │  fetch(Upload-Post, Authorization: Apikey)
                                  ▼
                                 R2  (video buraya akar, n8n'e uğramaz)
                                  │
     ◄──{ok:true,url}─────────────┘
n8n  → cerceveUrl = https://opus-arsiv.../f/2026/09/<jobId>.mp4
     → Upload-Post bu linki anonim çeker → yayın
```
