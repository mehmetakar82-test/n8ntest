# Çerçeve Arşiv Worker — kurulum

Toplam ~15 dakika. Cloudflare hesabı yoksa ücretsiz açılıyor.

## 1. R2 bucket

Cloudflare panel → sol menü **Storage & databases → R2 object storage → Overview**
→ *Create bucket* → ad: `opus-arsiv`

Kestirme: `https://dash.cloudflare.com/?to=/:account/r2/overview`

> ### ⚠ "Data Catalog" sihirbazına GİRME
>
> R2 bölümünde **Create Data Catalog** diye ayrı bir akış var (Catalog /
> Maintenance / Review adımları, "Compaction", "Target file size 128 MB",
> "Snapshot Expiration"). Bu **Apache Iceberg analitik tabloları** içindir —
> MP4 dosyalarıyla ilgisi yok. Üstelik Review adımında bucket'ı **Iceberg
> kataloğu + servis kimlik bilgisiyle birlikte** oluşturur; yani gereksiz bir
> kimlik bilgisi ve ayrı bir fatura kalemi eklersin. Review'a gelmeden çıkarsan
> hiçbir şey oluşmaz.
>
> ### Üç tuzak — ikisi GERİ ALINAMAZ
>
> 1. **Location / konum:** `None` (Automatic) bırak. Bu değer bucket
>    oluşturulduktan sonra **asla değiştirilemez** — bucket'ı silip aynı adla
>    yeniden açsan bile eski konum geri gelir.
> 2. **Jurisdiction:** varsayılan (`Default`) bırak. `EU` seçersen
>    `wrangler.toml`'a ayrıca `jurisdiction = "eu"` satırı eklemen gerekir;
>    eklemezsen ad birebir aynı olsa da deploy *"The specified bucket does not
>    exist"* der. Bu da geri alınamaz.
> 3. **Default storage class:** `Standard` bırak (aşağıdaki nota bak).
>
> ### Ad birebir aynı olmalı
>
> `wrangler.toml` bucket adını açıkça yazıyor (`bucket_name = "opus-arsiv"`).
> Ad yazılı olduğu için Wrangler'ın otomatik oluşturma özelliği **devreye
> girmez** — bucket'ı önce sen oluşturmalısın, yoksa deploy hata verir.
> Farklı bir ad verdiysen `wrangler.toml`'daki satırı ona göre düzelt.
> (`binding = "ARSIV"` bucket adıyla alakasız; o sadece koddaki `env.ARSIV`
> değişkeninin adı.)
>
> **Panelden EL İLE binding ekleme.** `wrangler deploy` bağlamayı
> `wrangler.toml`'dan kendisi kurar ve panelde yaptığın düzenlemeleri bir
> sonraki deploy'da ezer.
>
> **"Public access" / r2.dev'i AÇMA.** Worker dosyaları kendi `/f/...` ucundan
> sunuyor (`env.ARSIV.get()`), bucket'ın public olmasına gerek yok. Kapalı
> bırakmak hem Worker'daki doğrulamaları atlayan ikinci bir kapıyı önler, hem de
> r2.dev'in hız kısıtına takılmanı engeller.

> **R2 bir abonelik, ücretsiz plan değil** — açarken geçerli bir ödeme yöntemi
> ister. Kesintinin GERÇEK sebebi budur: kartın süresi dolarsa bucket'lara erişim
> askıya alınır, istekler hata döner ve zamanlanmış yayınlar sessizce kırılır.
> Kurduktan sonra kartın son kullanma tarihini kontrol et ve Notifications'tan bir
> kullanım uyarısı kur — R2'nin harcama tavanı (spend limit) özelliği YOK.
>
> **10 GB bir duvar DEĞİL**, faturadan düşülen ücretsiz paydır (ve "10 GB-month",
> yani anlık doluluk değil ay boyunca ortalama doluluk). Aşınca yazma durmaz,
> bucket kilitlenmez — aşan kısım $0,015/GB-ay olarak faturalanır.
>
> Ölçülen hacim: her video için **TEK** R2 nesnesi yazılıyor (5 platform aynı
> linki okuyor, yani 5× çoğalma yazmada değil okumada) → günde ~15 dosya ×
> ~25-35 MB = **~0,5 GB/gün**. Hiç silmezsen 1. yıl toplam ~$15, 2. yıl ~$50.
> Çıkış (egress) her hacimde ücretsiz.
>
> **Depolama sınıfı Standard kalmalı.** Infrequent Access'e geçersen 10 GB
> ücretsizliği TAMAMEN kalkar, üstüne $0,01/GB çekme ücreti ve 30 günlük asgari
> saklama süresi gelir.
>
> **Otomatik silme (lifecycle) kurmadan önce düşün.** Takvim bir klibi 364 güne
> kadar ileriye planlayabiliyor (`TAVAN_MS`) ve Upload-Post'un videoyu istek
> anında mı yoksa yayın anında mı çektiği **kesin değil** — belgede istek anında
> çektiğini ima eden bir cümle var ama taahhüt yok. Erken silmenin bedeli
> (kırılan yayınlar, üstelik uyarı vermeden) aylık birkaç dolardan çok daha
> ağır. Üstelik bu arşiv videoların muhtemelen tek kalıcı kopyası.
> Kural kuracaksan **400 gün** (≈210 GB, ~$3/ay) güvenli taraftır.

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
