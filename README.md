# OPUS PRO Panel

YouTube video → Short otomasyon sisteminin kontrol paneli. Tek dosyalık statik HTML — herhangi bir statik hosting'te veya doğrudan tarayıcıda açılabilir.

## Özellikler

- **Dashboard** — canlı Sheets + Upload-Post metrikleri, platform dağılımı ve son 7 gün trendi
- **Video Gönder / Toplu URL** — tekli veya toplu YouTube linklerini kategori seçerek n8n webhook'una yollar
- **YouTube Ara** — anahtar kelimeyle 10 video getir, seçtiklerini tek tek işleme al (arama geçmişi cache'te saklanır)
- **YT Kanal Ara** — anahtar kelimeye eşleşen kanalları listeler, "▶ Videoları Getir" ile lazy load, videoya tıklayınca gömülü YouTube oynatıcı modal
- **Yayın Tekrarları** — Twitch kanal arama (Helix API, kendi Client ID + Secret'ınla) ve Kick kanal sorgulama; seçilen yayın tekrarı (VOD) kategoriyle n8n'e işleme yollanır
- **OpusClip Direkt** — mevcut OpusClip projelerini clip ID ile işleme al
- **Toplu Anahtar Kelimeler** — sıralı arama, önceki tamamlanana kadar bekler
- **Google Drive / Sheets** — Drive Sheet'inden URL çekip toplu gönderim
- **Kuyruk / Short Listesi / URL Takip / Arşiv / Raporlar / Takvim** — Google Sheets tabanlı veri görüntüleyicileri (esnek kolon adı fallback ile)
- **Platformlar** — Upload-Post'a bağlı 8+ sosyal medya hesabı (IG/YT/TT/FB/LinkedIn/X/Threads/Pinterest/Bluesky), her hesap tıklanınca detay modal
- **Loglar** — filtrelenebilir işlem geçmişi tablosu

## Kullanım

1. `opuspro_panel_v9.html` dosyasını tarayıcıda aç.
2. Sol menüden **Ayarlar** → n8n webhook base URL'sini, Google Sheets API Key + Sheet ID'lerini, YouTube API Key'i ve Upload-Post API Key'i gir.
3. Ayarlar tarayıcı localStorage'ında kalır — bir daha girmene gerek yok.

## Bağımlılıklar

Panel harici bir bileşene ihtiyaç duymaz. Backend olarak:
- n8n workflow (video işleme, Sheets yazma, Upload-Post entegrasyonu) — bu repo'da paylaşılmıyor
- Google Sheets API (v4)
- YouTube Data API v3 — kendi anahtarını Ayarlar'dan gir
- Upload-Post API — kendi anahtarını Ayarlar'dan gir

## Geliştirme notları

Tek dosya HTML — ES6+ vanilla JavaScript, CSS custom properties. State `localStorage` üzerinde. Detaylar dosyanın en üstündeki bölüm ayrıştırmalarında.
