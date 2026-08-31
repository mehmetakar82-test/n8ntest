/**
 * OPUS PRO — Çerçeve Arşiv Worker
 *
 * NEDEN VAR: Upload-Post'un FFmpeg çıktısı (çerçeveli video) yalnız
 * `Authorization: Apikey ...` başlığıyla iniyor — OpenAPI şemasında indirme ucu
 * HİÇ parametre almıyor, iş yanıtında da herkese açık URL alanı yok. Ama yayın
 * API'si `video` alanındaki linki ANONİM çekiyor. İki uç birbirine bağlanamıyor.
 *
 * ÇÖZÜM: Bu Worker çerçeveli videoyu başlıkla indirip R2'ye AKITIR (bellekte
 * tutmaz) ve kendi üstünden herkese açık bir link sunar. Böylece:
 *   - Upload-Post anahtarı Cloudflare secret'ında kalır, n8n item'larına girmez
 *   - 30-40 MB'lık videolar n8n'in 320 MiB belleğinden GEÇMEZ
 *   - yayın düğümleri hiç değişmez (hâlâ düz bir URL string'i alıyorlar)
 *   - aynı işlem kalıcı arşivi de üretir
 *
 * UÇLAR
 *   POST /al        → indir + R2'ye yaz. Gövde {jobId, key}. X-OPUS-KEY zorunlu.
 *   GET|HEAD /f/... → R2'den herkese açık sun (Upload-Post buradan çeker).
 *   GET  /saglik    → yapılandırma kontrolü (sır sızdırmaz).
 *
 * CLOUDFLARE'DE TANIMLANACAKLAR
 *   Secret   UP_KEY    — Upload-Post API anahtarı
 *   Secret   OPUS_KEY  — n8n ile paylaşılan sır (bu Worker'a erişim izni)
 *   R2       ARSIV     — bucket bağlaması
 */

const UST = 'https://api.upload-post.com/api/uploadposts/ffmpeg/jobs/';

// Anahtar/jobId'yi DAR bir alfabeye kısıtlıyoruz: aksi hâlde '../' veya bir tam
// URL enjekte edilip Worker açık bir vekile (SSRF) dönüşebilirdi.
const JOB_RE = /^[A-Za-z0-9._-]{1,128}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,255}$/;

const json = (govde, durum = 200) =>
  new Response(JSON.stringify(govde), {
    status: durum,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export default {
  async fetch(istek, env) {
    const u = new URL(istek.url);
    const yol = u.pathname;

    if (yol === '/saglik') {
      return json({
        opus: true,
        ok: true,
        upKey: !!env.UP_KEY,
        opusKey: !!env.OPUS_KEY,
        r2: !!env.ARSIV,
      });
    }

    if (yol === '/al' && istek.method === 'POST') return al(istek, env, u);
    if (yol.startsWith('/f/') && (istek.method === 'GET' || istek.method === 'HEAD'))
      return sun(yol.slice(3), env, istek);

    return json({ opus: true, ok: false, hata: 'bilinmeyen uc' }, 404);
  },
};

async function al(istek, env, u) {
  if (!env.ARSIV) return json({ opus: true, ok: false, hata: 'R2 baglanmamis' }, 500);
  if (!env.OPUS_KEY || !env.UP_KEY)
    return json({ opus: true, ok: false, hata: 'sir tanimlanmamis' }, 500);

  // Sabit süreli karşılaştırma gerekmiyor: yanlış anahtarda hiçbir iş yapılmadan
  // dönülüyor, ölçülebilir bir zaman farkı oluşmuyor.
  if (istek.headers.get('X-OPUS-KEY') !== env.OPUS_KEY)
    return json({ opus: true, ok: false, hata: 'yetkisiz' }, 401);

  let g;
  try {
    g = await istek.json();
  } catch (e) {
    return json({ opus: true, ok: false, hata: 'govde JSON degil' }, 400);
  }

  const jobId = String((g && g.jobId) || '');
  const key = String((g && g.key) || '');
  if (!JOB_RE.test(jobId)) return json({ opus: true, ok: false, hata: 'jobId gecersiz' }, 400);
  if (!KEY_RE.test(key)) return json({ opus: true, ok: false, hata: 'key gecersiz' }, 400);

  const link = u.origin + '/f/' + key;

  // Zaten arşivlenmişse yeniden indirme: n8n yeniden denerse (ya da aynı iş iki
  // kez değerlendirilirse) Upload-Post'tan 40 MB'ı bir daha çekmenin anlamı yok.
  try {
    const varMi = await env.ARSIV.head(key);
    if (varMi) return json({ opus: true, ok: true, url: link, tekrar: true });
  } catch (e) {
    /* head hatası akışı durdurmasın — indirmeye devam */
  }

  let kaynak;
  try {
    kaynak = await fetch(UST + jobId + '/download', {
      headers: { Authorization: 'Apikey ' + env.UP_KEY },
    });
  } catch (e) {
    return json({ opus: true, ok: false, hata: 'indirme basarisiz: ' + e.message }, 502);
  }

  if (!kaynak.ok || !kaynak.body)
    return json({ opus: true, ok: false, hata: 'Upload-Post ' + kaynak.status }, 502);

  try {
    await env.ARSIV.put(key, kaynak.body, {
      httpMetadata: {
        contentType: kaynak.headers.get('content-type') || 'video/mp4',
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });
  } catch (e) {
    return json({ opus: true, ok: false, hata: 'R2 yazilamadi: ' + e.message }, 502);
  }

  return json({ opus: true, ok: true, url: link });
}

async function sun(key, env, istek) {
  if (!env.ARSIV) return new Response('R2 baglanmamis', { status: 500 });
  key = decodeURIComponent(key);
  if (!KEY_RE.test(key)) return new Response('gecersiz', { status: 400 });

  // Range: bazı çekiciler videoyu parça parça ister; desteklemezsek indirme yarıda kalır.
  const menzil = istek.headers.get('range');
  const nesne = await env.ARSIV.get(key, menzil ? { range: istek.headers } : undefined);
  if (!nesne) return new Response('yok', { status: 404 });

  const h = new Headers();
  nesne.writeHttpMetadata(h);
  h.set('etag', nesne.httpEtag);
  h.set('accept-ranges', 'bytes');

  if (istek.method === 'HEAD') {
    h.set('content-length', String(nesne.size));
    return new Response(null, { status: 200, headers: h });
  }

  if (nesne.range && menzil) {
    const bas = nesne.range.offset || 0;
    const uzunluk = nesne.range.length != null ? nesne.range.length : nesne.size - bas;
    h.set('content-range', 'bytes ' + bas + '-' + (bas + uzunluk - 1) + '/' + nesne.size);
    return new Response(nesne.body, { status: 206, headers: h });
  }

  return new Response(nesne.body, { status: 200, headers: h });
}
