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

// 45 sn'lik 1080x1920 CRF21 bir video ~20-35 MB olur. 100 KB'ın altındaki
// hiçbir şey video değildir (hata sayfası, JSON yanıtı, boş gövde).
// Ölçülen gerçek vaka (4 Eylül 2026): Upload-Post HTTP 200 + 43 BAYT döndürdü.
const ASGARI_BAYT = 100000;

// SÜRÜM DAMGASI: Cloudflare panelindeki "Versions" listesi hangi KODUN canlı
// olduğunu söylemiyor, yalnız ne zaman deploy edildiğini söylüyor. Bu damga
// /saglik çıktısında görünür, yani doğru sürümün canlı olduğu dışarıdan
// tek istekle doğrulanabilir. Kod her değiştiğinde BURAYI DA GÜNCELLE.
const SURUM = 'w2026.09.10-3';

// CORS ZORUNLU: panel GitHub Pages'ten (BAŞKA bir kaynaktan) /saglik ve /olcum
// çağırıyor. Bu başlıklar olmadan tarayıcı yanıtı bloklar ve panel adres doğru
// olsa bile "ulaşılamadı" der. /olcum özel başlık (X-OPUS-KEY) kullandığı için
// tarayıcı önce OPTIONS ön-uçuşu yapar — o da yanıtlanmak zorunda.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-opus-key',
  'access-control-max-age': '86400',
};

// Gövdenin yalnız BAŞINI oku (teşhis örneği). 40 MB'lık bir videoyu text() ile
// belleğe çekmek izoleyi öldürür ve 'ornek' tam gerekli anda üretilemezdi.
async function govdeBasi(yanit, n = 400) {
  try {
    if (!yanit.body) return '';
    const rd = yanit.body.getReader();
    const { value } = await rd.read();
    try { await rd.cancel(); } catch (e) { /* iptal edilemezse de örnek elimizde */ }
    return new TextDecoder().decode((value || new Uint8Array()).slice(0, n));
  } catch (e) {
    return '(gövde okunamadı)';
  }
}

// Uzunluğu BİLİNMEYEN akışı R2'ye parça parça yaz (multipart): sabit ~10 MiB bellek,
// dosya boyutu ne olursa olsun. Belleğe alma (arrayBuffer) 128 MB izole sınırını
// eşzamanlı /al çağrılarıyla paylaşırdı ve uzun klipte tek başına aşabilirdi.
// R2 kuralı: son parça hariç tüm parçalar AYNI boyutta olmalı.
const PARCA = 10 * 1024 * 1024;
async function parcaliYaz(env, key, govde, meta) {
  const mp = await env.ARSIV.createMultipartUpload(key, meta);
  const parcalar = [];
  let n = 0, toplam = 0, dolu = 0, tampon = new Uint8Array(PARCA);
  const rd = govde.getReader();
  try {
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      let ofs = 0;
      while (ofs < value.length) {
        const al = Math.min(PARCA - dolu, value.length - ofs);
        tampon.set(value.subarray(ofs, ofs + al), dolu);
        dolu += al; ofs += al;
        if (dolu === PARCA) {
          parcalar.push(await mp.uploadPart(++n, tampon));
          toplam += dolu; dolu = 0; tampon = new Uint8Array(PARCA);
        }
      }
    }
    if (dolu > 0 || n === 0) {
      parcalar.push(await mp.uploadPart(++n, tampon.subarray(0, dolu)));
      toplam += dolu;
    }
    const nesne = await mp.complete(parcalar);
    return (nesne && typeof nesne.size === 'number') ? nesne.size : toplam;
  } catch (e) {
    try { await mp.abort(); } catch (e2) { /* yarım yükleme R2'de kalmasın */ }
    throw e;
  }
}

const json = (govde, durum = 200) =>
  new Response(JSON.stringify(govde), {
    status: durum,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS),
  });

export default {
  async fetch(istek, env) {
    const u = new URL(istek.url);
    const yol = u.pathname;

    if (yol === '/saglik') {
      return json({
        opus: true,
        ok: true,
        surum: SURUM,
        upKey: !!env.UP_KEY,
        opusKey: !!env.OPUS_KEY,
        r2: !!env.ARSIV,
      });
    }

    if (istek.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (yol === '/olcum') return olcum(istek, env);
    if (yol === '/al' && istek.method === 'POST') return al(istek, env, u);
    if (yol.startsWith('/f/') && (istek.method === 'GET' || istek.method === 'HEAD'))
      return sun(yol.slice(3), env, istek);

    return json({ opus: true, ok: false, hata: 'bilinmeyen uc' }, 404);
  },
};

// Arşivin gerçek boyutu. Cloudflare'in "10 GB" rakamı bir DUVAR değil, faturadan
// düşülen ücretsiz pay (aşınca yazma durmaz, $0,015/GB-ay olarak faturalanır) —
// ama büyümeyi görmeden yönetmek mümkün değil, bu yüzden panele canlı sayı veriyoruz.
async function olcum(istek, env) {
  if (!env.ARSIV) return json({ opus: true, ok: false, hata: 'R2 baglanmamis' }, 500);
  if (!env.OPUS_KEY) return json({ opus: true, ok: false, hata: 'sir tanimlanmamis' }, 500);
  if (istek.headers.get('X-OPUS-KEY') !== env.OPUS_KEY)
    return json({ opus: true, ok: false, hata: 'yetkisiz' }, 401);

  let adet = 0, bayt = 0, imlec, sayfa = 0, enEski = null, enYeni = null;
  // Sayfa başı 1000 nesne; 50 sayfa = 50.000 nesne ≈ 9 yıllık üretim. Sınıra
  // dayanırsak kırpıldığını SÖYLÜYORUZ — sessizce eksik sayı vermek yanıltır.
  do {
    const s = await env.ARSIV.list({ limit: 1000, cursor: imlec });
    for (const o of s.objects) {
      adet++;
      bayt += o.size || 0;
      const t = o.uploaded ? new Date(o.uploaded).getTime() : 0;
      if (t) {
        if (enEski === null || t < enEski) enEski = t;
        if (enYeni === null || t > enYeni) enYeni = t;
      }
    }
    imlec = s.truncated ? s.cursor : null;
  } while (imlec && ++sayfa < 50);

  const gunSayisi = enEski && enYeni ? Math.max(1, (enYeni - enEski) / 86400000) : 0;
  return json({
    opus: true,
    ok: true,
    adet,
    bayt,
    gb: Math.round((bayt / 1073741824) * 100) / 100,
    ortalamaMb: adet ? Math.round((bayt / adet / 1048576) * 10) / 10 : 0,
    gunlukGb: gunSayisi ? Math.round((bayt / 1073741824 / gunSayisi) * 1000) / 1000 : 0,
    enEski: enEski ? new Date(enEski).toISOString() : null,
    kirpik: !!imlec,
  });
}

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
  // Ama yalnız GERÇEK bir video duruyorsa: eski sürümün ya da elle eklenen bir
  // yer tutucunun bıraktığı çöp nesne, boyutuna bakılmadan "tekrar/ok" sayılırsa
  // sonsuza dek yayına verilir. Küçükse sil ve yeniden indir.
  try {
    const varMi = await env.ARSIV.head(key);
    if (varMi && varMi.size >= ASGARI_BAYT)
      return json({ opus: true, ok: true, url: link, tekrar: true, boyut: varMi.size });
    if (varMi) { try { await env.ARSIV.delete(key); } catch (e) { /* silinemezse yeniden yazilir */ } }
  } catch (e) {
    /* head hatası akışı durdurmasın — indirmeye devam */
  }

  // ── İNDİRME ──────────────────────────────────────────────────────────
  // redirect:'manual' — Workers fetch yönlendirmeyi kendisi izlerken Authorization
  // başlığını YABANCI alana da taşır; hedef imzalı bir depolama URL'siyse depolama
  // "yalnız tek kimlik mekanizması" diye 400 döner. Yönlendirmeyi kendimiz izliyor,
  // başlığı yalnız Upload-Post'un kendi kaynağına (origin) gönderiyoruz.
  let kaynak;
  try {
    let hedef = UST + jobId + '/download';
    for (let atlama = 0; ; atlama++) {
      const ayniKaynak = new URL(hedef).origin === new URL(UST).origin;
      kaynak = await fetch(hedef, {
        redirect: 'manual',
        headers: ayniKaynak ? { Authorization: 'Apikey ' + env.UP_KEY } : {},
      });
      const konum = kaynak.headers.get('location');
      if (!(kaynak.status >= 300 && kaynak.status < 400 && konum)) break;
      // Yalnız KAYNAĞI yaz: Location imzalı bir indirme linkiyse n8n kaydına düşmesin.
      if (atlama >= 3) return json({ opus: true, ok: false, hata: 'cok fazla yonlendirme', konum: new URL(konum, hedef).origin }, 502);
      hedef = new URL(konum, hedef).toString();
    }
  } catch (e) {
    return json({ opus: true, ok: false, hata: 'indirme basarisiz: ' + e.message }, 502);
  }

  // Ret hâlinde gövdenin başını da geri ver — Upload-Post'un/deponun ne dediği
  // n8n çalıştırma kaydında okunsun, bir daha "402 mi 404 mü" diye tahmin edilmesin.
  if (!kaynak.ok || !kaynak.body) {
    const ornek = await govdeBasi(kaynak);
    return json({ opus: true, ok: false, hata: 'Upload-Post ' + kaynak.status, ornek }, 502);
  }

  // ── GELEN ŞEY GERÇEKTEN VİDEO MU? ────────────────────────────────────
  // 4 Eylül 2026: Upload-Post HTTP 200 ile 43 BAYTLIK bir gövde döndürdü;
  // eski hâl yalnız kaynak.ok'a bakıp bunu R2'ye yazdı ve ok:true dedi.
  // Sonuç: yayın düğümü 43 baytlık bir "video"ya işaret eden linki kullandı.
  // Artık hem tip hem BOYUT doğrulanıyor ve hata hâlinde gövdenin başı geri
  // gönderiliyor — Upload-Post'un ne dediğini n8n çalıştırma kaydında GÖRELİM.
  // Yönlendirme sonrası tip depo kaynağından gelebilir: binary/octet-stream ve
  // application/mp4 de meşru ikili tiplerdir. Çöp zaten boyut kapısında eleniyor.
  const ctype = kaynak.headers.get('content-type') || '';
  if (!/^(video\/|application\/(octet-stream|mp4)|binary\/octet-stream)/i.test(ctype)) {
    const ornek = await govdeBasi(kaynak);
    return json({
      opus: true, ok: false,
      hata: 'video degil: content-type=' + (ctype || '(yok)'),
      ornek,
    });
  }

  // ── R2'YE YAZ ─────────────────────────────────────────────────────────
  // R2 put() bir akış (ReadableStream) için BİLİNEN UZUNLUK ister; uzunluk
  // yalnız yanıtta Content-Length varsa bilinir. Upload-Post gövdeyi parça
  // parça (chunked) yollarsa put() TEK BAYT yazmadan "Provided readable stream
  // must have a known length" diye patlar ve R2 boş kalır. O hâlde uzunluk
  // bilinmiyorsa gövdeyi belleğe alıp (20-40 MB, 128 MB sınırının altında)
  // öyle yazıyoruz; biliniyorsa akıtmaya devam.
  const uzunluk = Number(kaynak.headers.get('content-length') || 0);
  const meta = {
    httpMetadata: {
      contentType: ctype || 'video/mp4',
      cacheControl: 'public, max-age=31536000, immutable',
    },
  };
  let boyut = 0;
  try {
    if (uzunluk > 0) {
      // Uzunluk biliniyor → doğrudan akıt (tek put, bellekte tutulmaz).
      const yazilan = await env.ARSIV.put(key, kaynak.body, meta);
      boyut = (yazilan && typeof yazilan.size === 'number') ? yazilan.size : uzunluk;
    } else {
      // Uzunluk bilinmiyor (chunked) → multipart ile parça parça.
      boyut = await parcaliYaz(env, key, kaynak.body, meta);
    }
  } catch (e) {
    return json({ opus: true, ok: false, hata: 'R2 yazilamadi: ' + e.message, uzunluk, akis: uzunluk > 0 }, 502);
  }

  // İçerik akış hâlinde geldiği için boyut ancak YAZDIKTAN sonra kesinleşiyor.
  // Eşiğin altındaysa nesneyi SİLİYORUZ: arşivde çöp bırakmak, yayın düğümünün
  // ona işaret etmesinden daha kötü (sessizce bozuk yayın üretir).
  if (boyut < ASGARI_BAYT) {
    try { await env.ARSIV.delete(key); } catch (e) { /* silinemezse de basarisiz don */ }
    return json({
      opus: true, ok: false,
      hata: 'gelen icerik cok kucuk (' + boyut + ' bayt, esik ' + ASGARI_BAYT + ') — video degil, R2den silindi',
      boyut,
    });
  }

  return json({ opus: true, ok: true, url: link, boyut });
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
