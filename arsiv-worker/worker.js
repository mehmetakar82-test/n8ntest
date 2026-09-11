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
// '.' ve '..' tek başına kabul edilmez: URL normalizasyonu '/jobs/../download'u
// başka bir Upload-Post yoluna çevirir ve anahtarlı istek oraya giderdi.
const JOB_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,128}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,255}$/;

// 45 sn'lik 1080x1920 CRF21 bir video ~20-35 MB olur. 100 KB'ın altındaki
// hiçbir şey video değildir (hata sayfası, JSON yanıtı, boş gövde).
// Ölçülen gerçek vaka (4 Eylül 2026): Upload-Post HTTP 200 + 43 BAYT döndürdü.
const ASGARI_BAYT = 100000;

// SÜRÜM DAMGASI: Cloudflare panelindeki "Versions" listesi hangi KODUN canlı
// olduğunu söylemiyor, yalnız ne zaman deploy edildiğini söylüyor. Bu damga
// /saglik çıktısında görünür, yani doğru sürümün canlı olduğu dışarıdan
// tek istekle doğrulanabilir. Kod her değiştiğinde BURAYI DA GÜNCELLE.
const SURUM = 'w2026.09.11-4';

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

// ── R2'YE YAZMA — İKİ YOL ────────────────────────────────────────────
// 11 Eylül 2026 üretimde: put(key, yanit.body) → "Provided readable stream must
// have a known length". R2 bir akışı ancak uzunluğu BİLİNİYORSA kabul eder.
// workerd kaynağıyla doğrulandı (11 Eyl, 4 araştırma + çürütme): uzunluk yalnız
// Content-Length VAR ve gövde çalışma zamanınca AÇILMIYORSA bilinir. Parça parça
// (chunked) gövdede ya da gzip/br gövdede (çalışma zamanı okurken açar; başlıklar
// sıkıştırılmış boyutu göstermeye devam eder) uzunluk bilinmez.
//
// dogrudan(): Content-Length var, kodlama yok → put(key, yanit.body). Baytları
//             çalışma zamanı YEREL pompayla taşır: JS döngüsü yok, bellekte tutulmaz.
// parcali():  aksi hâlde BYOB readAtLeast ile TAM 10 MiB'lik parçalar → R2 multipart.
//             Parça başına tek JS turu (30 MB ≈ 3 tur), tepe bellek ≈ 20 MB.
//
// ELENEN iki yol (bilerek):
//  - arrayBuffer() ile belleğe alma: çalışma zamanı gövdenin ~2 KATINI tutuyor;
//    60 MB'lık video 128 MB izole sınırını (eşzamanlı isteklerle ortak) aşabilir.
//  - Varsayılan okuyucuyla JS döngüsü: her read() 4-16 KiB döndürüyor → 30 MB için
//    binlerce tur; Free plandaki 10 ms CPU sınırını aşıp 1102'ye düşer.
//  - 'Accept-Encoding: identity': Cloudflare'in çıkış vekili (FL) gövdeyi kendisi
//    açıp Content-Encoding'i siliyor — gövde yine uzunluksuz geliyor. Yarar yok.
const PARCA = 10 * 1024 * 1024;          // R2: son parça hariç HEPSİ aynı boyda olmalı

async function dogrudan(env, key, yanit, meta) {
  const yazilan = await env.ARSIV.put(key, yanit.body, meta);
  return (yazilan && typeof yazilan.size === 'number') ? yazilan.size : 0;
}

// MP4/QuickTime dosyası 4. bayttan itibaren bir kutu adıyla başlar (ffmpeg mp4 → 'ftyp').
// Çalışma zamanının AÇMADIĞI bir kodlama (deflate, zstd...) sıkıştırılmış baytları
// olduğu gibi verir; boyut kapısı bunu yakalamaz, imza yakalar.
const MP4_KUTU = ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'];
function mp4Mu(b) {
  if (!b || b.byteLength < 8) return false;
  return MP4_KUTU.indexOf(String.fromCharCode(b[4], b[5], b[6], b[7])) >= 0;
}
function hexBasi(b, n = 16) {
  return Array.from((b || new Uint8Array()).subarray(0, n)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

async function parcali(env, key, yanit, meta) {
  const rd = yanit.body.getReader({ mode: 'byob' });
  let mp = null, n = 0, toplam = 0, kisa = null, ilk = true, tampon = new ArrayBuffer(PARCA);
  const parcalar = [];
  const yukle = async (v) => {
    if (!mp) mp = await env.ARSIV.createMultipartUpload(key, meta);
    parcalar.push(await mp.uploadPart(++n, v));
    toplam += v.byteLength;
  };
  try {
    for (;;) {
      // min, tampon boyunu ASLA aşmamalı: workerd (ve WHATWG) min > view.byteLength
      // olan readAtLeast'i TypeError ile reddeder (readable.c++:113-116). Kısa son
      // parçadan sonraki EOF doğrulama okuması bu yüzden min=1 ile yapılıyor.
      const { value, done } = await rd.readAtLeast(kisa ? 1 : PARCA, new Uint8Array(tampon));
      if (value && value.byteLength) {
        if (ilk) {
          ilk = false;
          if (!mp4Mu(value)) {
            const e = new Error('video degil (mp4 imzasi yok): ' + hexBasi(value));
            e.imza = true;
            throw e;
          }
        }
        // Kısa okuma yalnız EOF'ta olur; ardından veri gelirse parça boyları bozulur.
        if (kisa) throw new Error('parca boyu tutarsiz (kisa okumadan sonra veri geldi)');
        if (value.byteLength === PARCA) {
          await yukle(value);
          tampon = value.buffer;   // yükleme bitti → aynı belleği yeniden kullan (sıfırlama yok)
        } else {
          kisa = value;            // son parça (daha kısa olabilir)
        }
      }
      if (done) break;
      // workerd: EOF'tan önce minBytes'a ulaşılamazsa kısa veri done:false ile gelir,
      // done:true bir SONRAKİ okumada gelir (internal.c++ ~705/742). O doğrulama
      // okumasına küçük tampon yeter (yukarıda min=1). kisa kendi belleğinde duruyor;
      // yeni tampon onu ayırmaz (detach etmez).
      if (kisa) tampon = new ArrayBuffer(4096);
    }
    if (!mp) {
      // Gövde tek parçadan küçük: multipart gereksiz, tek put.
      const yazilan = await env.ARSIV.put(key, kisa || new Uint8Array(0), meta);
      return (yazilan && typeof yazilan.size === 'number') ? yazilan.size : (kisa ? kisa.byteLength : 0);
    }
    if (kisa) await yukle(kisa);
    const nesne = await mp.complete(parcalar);
    return (nesne && typeof nesne.size === 'number') ? nesne.size : toplam;
  } catch (e) {
    if (mp) { try { await mp.abort(); } catch (e2) { /* yarım yükleme R2'de kalmasın */ } }
    try { await rd.cancel(); } catch (e3) { /* gövde zaten kapanmış olabilir */ }
    throw e;
  }
}

// Upload-Post yanıtının başlıkları — n8n'de görünür (hata → _cerOrnek, başarı →
// Arşivle çıktısı). Bir dahaki arızada "chunked mı, gzip mi" diye tahmin etmeyelim.
function ustBilgi(y) {
  const b = (n) => y.headers.get(n) || '-';
  return 'cl=' + b('content-length') + ' ce=' + b('content-encoding') + ' te=' + b('transfer-encoding') + ' ct=' + b('content-type');
}

// ── İNDİRME ──────────────────────────────────────────────────────────
// redirect:'manual' — Workers fetch yönlendirmeyi kendisi izlerken Authorization
// başlığını YABANCI alana da taşır; hedef imzalı bir depolama URL'siyse depolama
// "yalnız tek kimlik mekanizması" diye 400 döner. Yönlendirmeyi kendimiz izliyor,
// başlığı yalnız Upload-Post'un kendi kaynağına (origin) gönderiyoruz.
// Anahtar yalnız İLK kaynağa gider: bir kez yabancı alana çıkıldıysa, oradan
// Upload-Post'a geri dönen bir yönlendirmeye de anahtar eklenmez. Yalnız https
// izlenir (düşürme ve tuhaf şemalar reddedilir; hata metnine yalnız şema/kaynak yazılır).
async function indir(env, jobId) {
  let hedef = UST + jobId + '/download';
  let disarida = false;
  for (let atlama = 0; ; atlama++) {
    const ayniKaynak = !disarida && new URL(hedef).origin === new URL(UST).origin;
    const basliklar = {};
    if (ayniKaynak) basliklar.Authorization = 'Apikey ' + env.UP_KEY;
    const y = await fetch(hedef, { redirect: 'manual', headers: basliklar });
    const konum = y.headers.get('location');
    if (!(y.status >= 300 && y.status < 400 && konum)) return { yanit: y };
    let sonraki;
    try { sonraki = new URL(konum, hedef); } catch (e) { return { yonlendirme: 'gecersiz Location' }; }
    if (sonraki.protocol !== 'https:') return { yonlendirme: 'https disi yonlendirme (' + sonraki.protocol + ')' };
    // Yalnız KAYNAĞI yaz: Location imzalı bir indirme linkiyse n8n kaydına düşmesin.
    if (atlama >= 3) return { yonlendirme: 'cok fazla (' + sonraki.origin + ')' };
    if (sonraki.origin !== new URL(UST).origin) disarida = true;
    hedef = sonraki.toString();
  }
}

// İçerik tipi + kodlama kapısı — ilk indirmeye de tekrar indirmeye de AYNI kapı.
// Dönen: null (geçti) ya da { hata, ornek } (reddedildi; gövde iptal edildi).
async function kapidanGecir(yanit) {
  const ust = ustBilgi(yanit);
  const ctype = yanit.headers.get('content-type') || '';
  if (!/^(video\/|application\/(octet-stream|mp4)|binary\/octet-stream)/i.test(ctype)) {
    const ornek = await govdeBasi(yanit);
    return { hata: 'video degil: content-type=' + (ctype || '(yok)'), ornek: ornek || ust };
  }
  // workerd yalnız TAM 'gzip' ve 'br' değerlerini açar; başka bir kodlama (deflate,
  // zstd, 'GZIP', liste...) sıkıştırılmış baytları olduğu gibi verir → MP4 diye çöp
  // saklanırdı. Onları baştan reddediyoruz.
  const kodlama = (yanit.headers.get('content-encoding') || '').trim();
  if (kodlama && kodlama !== 'identity' && kodlama !== 'gzip' && kodlama !== 'br') {
    try { await yanit.body.cancel(); } catch (e) { /* önemsiz */ }
    return { hata: 'desteklenmeyen kodlama: ' + kodlama, ornek: ust };
  }
  return null;
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
    // Yakalanmayan istisna Cloudflare'in CORS'suz 1101 HTML sayfasına dönüşürdü: panel
    // "ulaşılamadı", n8n okunaksız HTML görürdü. Artık her uç JSON + opus:true döner.
    try {
      if (yol === '/olcum') return await olcum(istek, env);
      if (yol === '/al' && istek.method === 'POST') return await al(istek, env, u);
      if (yol.startsWith('/f/') && (istek.method === 'GET' || istek.method === 'HEAD'))
        return await sun(yol.slice(3), env, istek);
    } catch (e) {
      return json({ opus: true, ok: false, hata: 'beklenmeyen hata: ' + (e && e.message ? e.message : String(e)) }, 500);
    }

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

  let kaynak;
  try {
    const s = await indir(env, jobId);
    if (s.yonlendirme) return json({ opus: true, ok: false, hata: 'yonlendirme reddedildi: ' + s.yonlendirme }, 502);
    kaynak = s.yanit;
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
  // Artık tip, kodlama, (parçalı yolda) MP4 imzası ve BOYUT doğrulanıyor; hata
  // hâlinde gövdenin başı/başlıklar geri gönderiliyor — n8n kaydında GÖRELİM.
  const red = await kapidanGecir(kaynak);
  if (red) return json({ opus: true, ok: false, hata: red.hata, ornek: red.ornek }, 502);

  // ── R2'YE YAZ ─────────────────────────────────────────────────────────
  const uzunluk = Number(kaynak.headers.get('content-length') || 0);
  const kodlama = (kaynak.headers.get('content-encoding') || '').trim();
  let ust = ustBilgi(kaynak);
  // İçerik tipi SABİT: çıktı her zaman mp4 (output_extension + imza kontrolü).
  // Kaynağın tipini aynen saklamak, virgüllü/tuhaf bir değerle /f/'den HTML
  // sunulmasına kapı açardı.
  const meta = {
    httpMetadata: {
      contentType: 'video/mp4',
      cacheControl: 'public, max-age=31536000, immutable',
    },
  };

  // Doğrudan yol düşerse (çalışma zamanı uzunluğu bilinmez saydı) gövdenin okunup
  // okunmadığı garanti değil → ilk gövdeyi bırak, indirmeyi BİR KEZ tekrarla, aynı
  // kapıdan geçir, parçalı yaz. GET /download yan etkisiz.
  let boyut = 0;
  let yol = (Number.isSafeInteger(uzunluk) && uzunluk > 0 && (!kodlama || kodlama === 'identity')) ? 'dogrudan' : 'parcali';
  try {
    boyut = (yol === 'dogrudan') ? await dogrudan(env, key, kaynak, meta) : await parcali(env, key, kaynak, meta);
  } catch (e1) {
    if (e1 && e1.imza)
      return json({ opus: true, ok: false, hata: e1.message, ornek: ust + ' yol=' + yol }, 502);
    if (yol !== 'dogrudan')
      return json({ opus: true, ok: false, hata: 'R2 yazilamadi: ' + e1.message, ornek: ust + ' yol=' + yol }, 502);
    try { await kaynak.body.cancel(); } catch (e) { /* kilitliyse zararsız */ }
    try {
      const t = await indir(env, jobId);
      if (t.yonlendirme) throw new Error('yonlendirme reddedildi: ' + t.yonlendirme);
      if (!t.yanit.ok || !t.yanit.body) throw new Error('Upload-Post ' + t.yanit.status);
      ust += ' | tekrar ' + ustBilgi(t.yanit);
      const red2 = await kapidanGecir(t.yanit);
      if (red2) throw new Error(red2.hata);
      yol = 'dogrudan>parcali';
      boyut = await parcali(env, key, t.yanit, meta);
    } catch (e2) {
      return json({ opus: true, ok: false, hata: 'R2 yazilamadi: ' + e1.message + ' | tekrar: ' + e2.message, ornek: ust + ' yol=' + yol }, 502);
    }
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
      ornek: ust + ' yol=' + yol,
    });
  }

  // yol + ust başarıda da dönüyor: n8n 'Çerçeve Arşivle' çıktısında Upload-Post'un
  // hangi biçimde yolladığı (chunked/gzip/düz) ilk gerçek koşuda görülsün.
  return json({ opus: true, ok: true, url: link, boyut, yol, ust });
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
  // Tarayıcı içerik tipini "tahmin" edip bir dosyayı HTML gibi çalıştırmasın.
  h.set('x-content-type-options', 'nosniff');

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
