**Language / Dil:** [English](README.md) &nbsp;|&nbsp; Türkçe

---

# Spotify Archive Downloader

Spotify çalma listelerini arşivlemek ve bunları premium bir web arayüzü üzerinden oynatmak için kendi sunucunuzda barındırabileceğiniz (self-hosted) iki parçalı bir sistem. Proje, Spotify çalma listesi meta verilerini çeken (scrape) bir Chrome uzantısı ve ses kütüphanesini indiren, etiketleyen ve sunan yerel bir Python arka ucundan (backend) oluşur.

---

## İçindekiler

- [Genel Bakış](#genel-bakış)
- [Mimari](#mimari)
- [Chrome Uzantısı](#chrome-uzantısı)
- [Arka Uç](#arka-uç)
  - [İndirici](#i̇ndirici)
  - [Ses Etiketleyici](#ses-etiketleyici)
  - [Yerel Kütüphane Tarayıcı](#yerel-kütüphane-tarayıcı)
  - [REST API](#rest-api)
- [Web Oynatıcı](#web-oynatıcı)
  - [Oynatma Motoru](#oynatma-motoru)
  - [Oynatma Kontrolleri](#oynatma-kontrolleri)
  - [Oturum ve Durum Kalıcılığı](#oturum-ve-durum-kalıcılığı)
  - [Ses Görselleştirici](#ses-görselleştirici)
  - [Şarkı Sözü Entegrasyonu](#şarkı-sözü-entegrasyonu)
  - [Şarkı Listesi](#şarkı-listesi)
  - [Detaylar Paneli](#detaylar-paneli)
  - [Kenar Çubuğu ve Kütüphane Gezinmesi](#kenar-çubuğu-ve-kütüphane-gezinmesi)
  - [Kütüphane Yönetimi](#kütüphane-yönetimi)
  - [Klavye Kısayolları](#klavye-kısayolları)
  - [Uluslararasılaştırma](#uluslararasılaştırma)
- [Kurulum](#kurulum)
- [Yapılandırma](#yapılandırma)
- [Gereksinimler](#gereksinimler)

---

## Genel Bakış

Spotify Archive Downloader pratik bir sorunu çözer: Spotify, kendi uygulaması dışında çevrimdışı dinlemeye izin vermez ve yerel dosyalar özelliği oldukça sınırlıdır. Bu araç, sahip olduğunuz veya takip ettiğiniz herhangi bir Spotify çalma listesinin kalıcı, DRM'siz (Dijital Haklar Yönetimi olmayan) kişisel bir arşivini oluşturmanıza olanak tanır. Orijinal Spotify deneyimiyle yarışacak düzeyde şık bir tarayıcı tabanlı müzik çalar üzerinden erişilebilen bu arşiv, yerel makinenizde yüksek kaliteli MP3 dosyaları olarak, gömülü kapak resimleri ve ID3 meta verileriyle birlikte saklanır.

Chrome uzantısı, API kimlik bilgilerine ihtiyaç duymadan parça verilerini doğrudan Spotify'ın web arayüzünden okur. Arka uç bu meta verileri alır, YouTube Music veya standart YouTube'dan `yt-dlp` kullanarak eşleşen sesi bulur ve indirir, elde edilen dosyaları mutagen ile etiketler ve kütüphaneyi bir FastAPI HTTP sunucusu aracılığıyla kullanıma sunar. Web oynatıcı tamamen tarayıcı içinde, bu yerel sunucuya bağlı olarak çalışır.

---

## Mimari

```text
Spotify Web (tarayıcı)
        |
  Chrome Uzantısı
        | (HTTP POST parçaları / chunks)
        v
  FastAPI Arka Ucu (port 8765)
        |-- SQLite Veritabanı (oturumlar, işler)
        |-- yt-dlp + FFmpeg (ses indirme + dönüştürme)
        |-- mutagen (ID3/MP4/FLAC etiketleme)
        |-- Yerel dosya sistemi (~/Music/SpotifyArchive/)
        |
  Web Oynatıcı (/player)
        |-- PlayerEngine (HTMLAudioElement + Web Audio API)
        |-- Visualizer (Canvas 2D, gerçek zamanlı FFT)
        |-- LyricsManager (Genius API + sunucu taraflı proxy)
        |-- Store (localStorage destekli durum yönetimi)
```

---

## Chrome Uzantısı

Tarayıcı uzantısı `open.spotify.com` üzerinde çalışır ve arşiv işlemlerini yönetmek için kalıcı bir açılır (popup) arayüz sağlar.

**Veri çekme mekanizması.** Uzantı, açık olan herhangi bir Spotify çalma listesi sayfasının DOM'unu okuyarak parça kimliklerini (ID), başlıkları, sanatçıları, albüm adlarını, süreleri ve kapak resmi URL'lerini çıkarır. Spotify API'sini kullanmaz ve OAuth kimlik bilgilerine ihtiyaç duymaz.

**Parçalı (Chunked) aktarım.** Parçalar tek seferde gönderilmez. Çalma listesi kaydırıldıkça uzantı bunları parçalar halinde arka uca gönderir, böylece sayfa hala taranırken indirmelerin hemen başlaması sağlanır. Bu, 1000 parçalık bir çalma listesinde ilk parçaların sayfanın tamamı yüklenmeden saniyeler içinde inmeye başlaması anlamına gelir.

**Oturum yaşam döngüsü.** Bir arşivleme başlatıldığında, uzantı bir `POST /session/init`, ardından birden fazla `POST /session/chunk` isteği ve son olarak `POST /session/finalize` gönderir. Aynı çalma listesi adı arka uç veritabanında zaten varsa, oturum çoğaltılmak yerine birleştirilir ve gereksiz indirmeler önlenir.

**İlerleme durumu sorgulama.** Açılır pencere, düzenli aralıklarla `GET /session/{id}/progress` uç noktasını sorgular ve tamamlanan, bekleyen ve başarısız olan parçaların sayısını gerçek zamanlı olarak gösterir.

**Hata kurtarma.** Yeni bir parçada daha önce `failed` (başarısız) durumuna sahip bir parça ile karşılaşılırsa, arka uç durumunu otomatik olarak `pending` (bekliyor) olarak sıfırlar ve indirmeyi yeniden dener.

---

## Arka Uç

Arka uç, `localhost:8765` üzerinde çalışan bir FastAPI uygulamasıdır. Veritabanını, indirme kuyruğunu, dosya etiketlemeyi yönetir ve web oynatıcı ile ses akışlarını sunar.

### İndirici

`downloader.py` içindeki temel indirme hattı, tek bir parçanın tüm yaşam döngüsünü yönetir: kapak resmi edinme, ses indirme ve ID3 etiketleme.

**Paralel indirme kuyruğu.** İndirmeler, yapılandırılabilir sayıda işçi (`CONCURRENT_WORKERS`, varsayılan: 8) ile bir `ThreadPoolExecutor` ve eşzamanlı `yt-dlp` işlemlerini sınırlamak için bir `asyncio.Semaphore` üzerinden yürütülür. Bu sayede büyük çalma listeleri, ana olay döngüsünü (event loop) engellemeden veya ağı doyurmadan yüksek verimle indirilebilir.

**YouTube Music önceliği ve geri dönüş (fallback).** İndirici, her parça için önce YouTube Music'te `ytmsearch:` aracılığıyla `{artist} - {title}` arama sorgusunu kullanır. Başarısız olursa, standart YouTube aramasında `{artist} - {title} official audio` sorgusuna geri döner. Bu iki aşamalı yaklaşım, temiz ve sadece müzik içeren bir ses kaynağı bulma olasılığını en üst düzeye çıkarır.

**En iyi ses kalitesi seçimi.** `yt-dlp`, `format: bestaudio/best` ile yapılandırılmıştır ve FFmpeg aracılığıyla hedef kodek'e (varsayılan: MP3, kalite 0 = en yüksek) dönüştürülür. `yt-dlp` tarafından hiçbir küçük resim, JSON bilgisi veya meta veri yazılmaz; tüm etiketleme işlemleri etiketleyici modül tarafından ayrı olarak gerçekleştirilir.

**Kapak resmi çözünürlüğünü yükseltme.** Spotify'dan gelen ham kapak URL'leri genellikle küçük resim boyutu kodları içerir. İndirici, bunları otomatik olarak 640x640 (`b273`) varyantını isteyecek şekilde yeniden yazar, daha büyük varyant kullanılamıyorsa sırasıyla 300x300 ve 64x64'e geri döner. Hatalı resim yanıtlarını algılamak ve reddetmek için minimum 500 baytlık bir yanıt boyutu zorunlu kılınmıştır.

**Çalma listesi yedeği ile parça başına kapak.** Her parçanın kendi kapağı indirilir ve `{playlist_dir}/.covers/{track_id}.jpg` altına önbelleğe alınır. Bir parçanın kapağı yoksa, gömme işlemi için çalma listesi düzeyindeki kapak (`cover.jpg`) yedek olarak kullanılır.

**Otomatik başlangıç devamlılığı (resumption).** Sunucunun her başlatılışında, `auto_resume_sessions` olay işleyicisi (event handler), beklemede olan, indirilen veya etiketlenen işlere sahip tüm oturumlar için veritabanını sorgular ve bunları otomatik olarak arka plan görevleri olarak yeniden kuyruğa alır. Bu, kesintiye uğrayan indirme oturumlarının manuel müdahale olmadan kurtarılması anlamına gelir.

**Manuel oturum devam ettirme uç noktası.** `POST /session/{id}/resume`, bir oturum için başarısız olan ve devam ederken takılı kalan tüm işleri `pending` (bekliyor) durumuna sıfırlar ve yeni bir indirme partisi başlatır. Bu, kullanıcıya Spotify'ı yeniden taramadan isteğe bağlı bir yeniden deneme mekanizması sunar.

### Ses Etiketleyici

`tagger.py`, mutagen kullanarak formata duyarlı ID3 meta veri gömme işlemi sağlar.

**Desteklenen formatlar:** MP3 (ID3v2.3), M4A/AAC (MP4 atoms), FLAC (Vorbis comments + embedded picture block).

**Gömülü alanlar:** parça başlığı, birincil sanatçı(lar) (çoklu sanatçı parçaları için noktalı virgülle ayrılmış), albüm sanatçısı (MP3 için TPE2), albüm adı ve ön kapak resmi (APIC / covr / Picture block).

**Süre çıkarma.** Etiketleri yazdıktan sonra etiketleyici, `mutagen.mp3.MP3.info.length` (veya M4A/FLAC için eşdeğeri) kullanarak dönüştürülen dosyadan gerçek ses süresini okur ve `DD:SS` dizesi (string) olarak döndürür. Bu değer veritabanında saklanır ve web oynatıcı tarafından görüntülenir.

**Canlı yeniden etiketleme.** Kullanıcı web oynatıcının düzenleme modülü (modal) aracılığıyla parça meta verilerini düzenlediğinde, arka uç diskteki mevcut dosya üzerinde `tag_audio_file` işlevini çağırarak, ses dosyasının içindeki gömülü etiketlerin her zaman oynatıcının gösterdiğiyle aynı olmasını sağlar.

### Yerel Kütüphane Tarayıcı

`scanner.py`, başlangıçta `scan_and_rebuild_db()` aracılığıyla çalışır ve normal indirme hattı dışında çıktı dizinine yerleştirilen tüm ses dosyalarının tanınmasını ve oynatıcıda kullanılabilir olmasını sağlar.

**Dizin geçişi.** Tarayıcı, `MUSIC_OUTPUT_DIR` altındaki her alt dizini tarar. Her alt dizin, `local_` önekli bir oturum kimliği ile bir çalma listesi oturumu haline gelir.

**Etiket çıkarma.** Her ses dosyası (MP3, M4A, AAC, FLAC, Opus, WebM, OGG) için tarayıcı, mutagen kullanarak başlık, sanatçı(lar), albüm ve süreyi çıkarmak için gömülü etiketleri okur.

**Gömülü kapak çıkarma.** Gömülü bir kapak resmi bulunursa (MP3 için APIC, M4A için `covr`, FLAC için `pictures`), doğru uzantı (MIME türüne göre jpg veya png) kullanılarak ses dosyalarının yanındaki `.covers/` alt dizinine yazılır. Bu çıkarılan kapak daha sonra `/local-cover/` uç noktası tarafından sunulur ve oynatıcıda görüntülenir.

**Idempotency (Etkisizlik).** Zaten dizine eklenmiş parçalar, gereksiz veritabanı yazımlarını önlemek için sonraki tarayıcı çalıştırmalarında atlanır.

### REST API

Arka uç, hem Chrome uzantısı hem de web oynatıcı tarafından tüketilen eksiksiz bir REST API sunar.

| Yöntem | Uç Nokta | Açıklama |
|--------|----------|-------------|
| POST | `/session/init` | Yeni bir indirme oturumu başlatır |
| POST | `/session/chunk` | Bir parça meta veri partisi alır |
| POST | `/session/finalize` | Oturum tarama işlemini tamamlandı olarak işaretler |
| GET | `/session/{id}/progress` | Gerçek zamanlı indirme ilerleme durumu |
| POST | `/session/{id}/resume` | Başarısız/eksik indirmeleri yeniden dener |
| GET | `/sessions` | Tüm arşivlenmiş çalma listelerini listeler |
| DELETE | `/sessions/clear` | Tüm verileri siler ve tüm oturumları durdurur |
| GET | `/session/{id}/tracks` | Oynatıcı için tamamlanmış parçaları getirir |
| GET | `/stream/{track_id}` | HTTP range (aralık) uyumlu ses akışı (streaming) |
| GET | `/player` | Web oynatıcı HTML'ini sunar |
| GET | `/api/lyrics/proxy` | Genius CORS engelini aşmak için sunucu taraflı proxy |
| GET | `/local-cover/{playlist}/{track_id}` | Çıkarılan kapak resimlerini sunar |
| PATCH | `/api/track/{track_id}` | Parça meta verilerini günceller + dosyayı yeniden etiketler |
| DELETE | `/api/track/{track_id}` | Parçayı diskten ve veritabanından siler |
| POST | `/api/track/{track_id}/cover` | Yeni kapak resmi yükler ve gömer |
| DELETE | `/api/session/{session_id}` | Tüm çalma listesi arşivini siler |
| PATCH | `/api/session/{session_id}` | Bir çalma listesi oturumunu yeniden adlandırır |
| POST | `/api/session/{session_id}/cover` | Yeni çalma listesi kapağı resmi yükler |

**HTTP Aralık (Range) akışı.** `/stream/{track_id}` uç noktası, `Range` isteklerini yerel olarak işleyen FastAPI'nin `FileResponse` özelliğini kullanır. Bu sayede oynatıcı, büyük arşivler için kritik olan tüm dosyayı arabelleğe (buffer) almadan parçanın herhangi bir konumuna atlayabilir (seek).

---

## Web Oynatıcı

Web oynatıcı, `http://localhost:8765/player` adresinde sunulan Tek Sayfalık bir Uygulamadır (Single-Page Application). ES modül mimarisi kullanılarak saf (vanilla) JavaScript ile oluşturulmuştur. Durum yönetimi `Store` modülünde merkezileştirilmiştir ve tüm kalıcı tercihler `localStorage` ile desteklenir.

### Oynatma Motoru

`PlayerEngine.js`, yerel bir `HTMLAudioElement` ve bir `Web Audio API` grafiğini sarmalar.

**Ses bağlamı (Audio context) başlatma.** `AudioContext`, tarayıcı otomatik oynatma (autoplay) politikalarına uymak için sayfa yüklendiğinde değil, ilk kullanıcı etkileşiminde tembel (lazy) olarak oluşturulur. Ses öğesi, görselleştiriciyi besleyen bir `AnalyserNode`'a (FFT boyutu 512) bağlanır. Analizör çıkışı daha sonra ses hedefine bağlanır, böylece görselleştirici oynatmayı kesintiye uğratmaz.

**Cross-origin yapılandırması.** Sunucu uygun CORS başlıklarını içerdiğinde Web Audio API'nin akışı işlemesine izin vermek için ses öğesinin `crossOrigin` niteliği `"anonymous"` olarak ayarlanır.

**Parça yükleme ve arayüz senkronizasyonu.** `playTrack(idx)` ses kaynağını `/stream/{track_id}` olarak ayarlar, oynatmayı tetikler ve aynı anda çalan kapak resmini, başlığı, sanatçı metnini, parça listesindeki çalan satır vurgusunu, tam ekran görselleştirici katmanını, işletim sistemi düzeyindeki `MediaSession` meta verilerini (sistem medya kontrolleri ve kilit ekranı göstergeleri tarafından kullanılır) günceller ve yeni parça için `LyricsManager` veri çekme işlemini başlatır.

**Otomatik atlama ile hata yönetimi.** Bir parça yüklenemezse (`onerror`), bir bildirim (toast) gösterilir ve oynatıcı 1.5 saniye sonra otomatik olarak bir sonraki parçaya atlar, böylece ara sıra bozulan veya eksik olan parçalara rağmen büyük çalma listelerinde oynatma kesintisiz devam eder.

**Fisher-Yates ile Karıştırma (Shuffle).** Karıştırma etkinleştirildiğinde, `Controls.buildShuffle()` Fisher-Yates algoritmasını kullanarak tüm parça indekslerinin yeni bir rastgele permütasyonunu oluşturur. Şu anda çalan parça, bir karıştırma oturumunun başlangıcında hemen tekrar çalınmaması için karıştırma sırasının sıfırıncı konumuna yerleştirilir.

**Tekrar modları.** Üç tekrar modu sırayla döner: kapalı (0), listeyi tekrarla (1), parçayı tekrarla (2). Parçayı tekrarla modunda `nextTrack()`, indeksi ilerletmek yerine `currentTime`'ı sıfıra sıfırlar ve `play()` işlevini çağırır.

**Akıllı önceki parça.** Geçerli oynatma konumu 3 saniyeden büyükse, `prevTrack()` önceki parçaya gitmek yerine geçerli parçayı baştan başlatır. Bu, özel müzik çalarların standart davranışıyla eşleşir.

### Oynatma Kontrolleri

`Controls.js`, tüm etkileşimli oynatma kontrollerini birbirine bağlar.

**İlerleme çubuğunda sarma.** İlerleme çubuğunda fareyi sürüklemek, `audio.currentTime` değerini çubuk genişliğine göre ayarlar. Sürükleme sırasında, `Store`'daki `isDraggingProgress` bayrağı `onTimeUpdate` işlevinin görsel dolguyu üzerine yazmasını engeller ve sarma (scrubbing) sırasında titremeyi ortadan kaldırır.

**Ses kontrolü.** Ses çubuğu, ilerleme çubuğu etkileşim modelini yansıtır. Ses değişiklikleri `localStorage` içine `sa_volume` altında kaydedilir. Sayfa yüklendiğinde, `PlayerEngine` bu değeri okur ve önceki ses seviyesini otomatik olarak geri yükler.

**Hafızalı sessize alma geçişi.** Ses simgesine tıklamak mevcut sesi `_prevVol` içinde depolar ve sesi sıfıra ayarlar. Tekrar tıklandığında depolanan değer geri yüklenir. Ses simgesi görsel olarak dört ayrı durumu yansıtır: sessiz, düşük (%0-33), orta (%33-66) ve yüksek (%66-100), bunu SVG öğesindeki CSS sınıflarını değiştirerek yapar.

**Şarkı sözleri paneli geçişi.** Hiçbir Genius API anahtarı yapılandırılmamışsa, şarkı sözleri düğmesine tıklamak panel yerine ayarlar modülünü açarak kullanıcıyı önce anahtarı yapılandırmaya yönlendirir.

**Görselleştirici geçişi.** Görselleştiriciyi açmak `Visualizer.draw()` animasyon döngüsünü başlatır ve katmanı mevcut parça bilgileriyle günceller. Kapatmak animasyon karesini (animation frame) iptal eder ve tuvali (canvas) temizler.

**Panel görünürlüğü kalıcılığı.** Kenar çubuğunun, detaylar panelinin, şarkı sözleri panelinin ve görselleştiricinin açık/kapalı durumu `localStorage` içinde saklanır ve her sayfa yüklendiğinde kullanıcının düzenini yeniden yapılandırmasına gerek kalmadan geri yüklenir.

### Oturum ve Durum Kalıcılığı

Tüm oynatma durumu, her parça değiştiğinde çağrılan `Store.savePlaybackState()` aracılığıyla `localStorage`'a kaydedilir.

**Başlangıçta geri yüklenen durumlar:**
- Son aktif çalma listesi oturumu (`player_last_session`)
- Son çalınan parça (`player_last_track`)
- Oynatma sırasında her 2 saniyede bir güncellenen oynatma zaman damgası (`player_last_time`)
- Karıştır (Shuffle) açık/kapalı durumu (`player_shuffle`)
- Tekrar modu (0/1/2) (`player_repeat`)
- Ses seviyesi (`sa_volume`)
- Kenar çubuğu, detaylar paneli, şarkı sözleri paneli ve görselleştiricinin açık/kapalı durumu

**Otomatik oynatmadan geri yükleme.** `App.restoreTrack()`, son çalınan parça için tüm oynatıcı arayüz durumunu (kapak, başlık, sanatçı, parça listesi vurgusu, detaylar paneli, `MediaSession` meta verileri, şarkı sözleri) yeniden yapılandırır ve bilinen son oynatma süresine atlar, ancak otomatik olarak oynatmaz. Kullanıcı devam etmek için oynat (play) düğmesine basar. Bu, sayfa yüklendiğinde sesin beklenmedik bir şekilde başlamasının sarsıcı deneyimini önler.

**Dil kalıcılığı.** Seçilen arayüz dili `localStorage`'da `player_lang` altında saklanır ve herhangi bir arayüz işlenmeden (render) önce başlangıçta uygulanır.

### Ses Görselleştirici

`Visualizer.js`, Web Audio API'nin `AnalyserNode`'u tarafından yönlendirilen gerçek zamanlı, canvas (tuval) tabanlı radyal halka görselleştirici uygular.

**Çok halkalı organik yapı.** Görselleştirici, her biri bağımsız olarak rastgele belirlenmiş parametrelere (faz ofseti, dönüş hızı çarpanı ve bozulma genliğini ölçeklendiren bir kaos faktörü) sahip 10 eşmerkezli halka oluşturur. Bu, her oturum için benzersiz, organik bir görünüm üretir.

**Çift modlu animasyon.** Her halka, normalleştirilmiş bir `activeBlend` skaleri kullanarak iki bozulma modu arasında sorunsuz bir şekilde geçiş yapar:

- *Boşta (Idle) modu* (ses sinyali yok): Halkalar, farklı frekanslara ve genliklere sahip katmanlı sinüzoidal fonksiyonlar tarafından yönlendirilir ve müzik duraklatıldığında bile görsel olarak ilgi çekici kalan yavaş, nefes alan, organik bir hareket yaratır.
- *Aktif mod* (ses çalıyor): `AnalyserNode`'dan gelen frekans kutusu (bin) verileri her halkayla eşleştirilir. Her halka, bireysel kaos faktörü ve ikincil bir sinüzoidal frekans modülatörü tarafından modüle edilen frekans spektrumunun farklı bir bölgesini okur. İç halkalar ses seviyesiyle orantılı bir çizgi genişliği (line-width) artışı alır ve merkezin bas geçişleriyle görünür şekilde atmasını sağlar.

**Dikiş (Seam) incelmesi.** Her halkanın yolunun ilk ve son 24 bölümü, kapalı yolun kendiyle buluştuğu yerde görünür bir dikiş oluşmasını önlemek için doğrusal olarak soldurulur.

**Boştan aktife pürüzsüz geçiş.** `activeBlend` durumlar arasında aniden geçiş yapmaz. Bir sinyal algılandığında (eşik üzerindeki RMS enerjisi), kare (frame) başına %6 oranında 1.0'a doğru yükselir. Sinyal düştüğünde, 110 karelik bir `idleFade` sayacı yavaşlamayı geciktirir ve aktif görünümü bir vuruştan (beat) sonra kısaca tutar. Sayaç sona erdiğinde, `activeBlend` kare başına %4 hızla 0'a geri döner. Bu, iki görsel mod arasındaki herhangi bir titreşimi veya sert kesintiyi ortadan kaldırır.

**Duyarlı (Responsive) tuval boyutlandırma.** Kapsayıcı öğedeki bir `ResizeObserver`, tuval boyutlarını kapsayıcının düzen dikdörtgeni ile senkronize tutar ve pencere yeniden boyutlandırıldığında veya görselleştirici tam ekrana genişletildiğinde doğru işlemeyi (rendering) sağlar.

**Sürüklenebilir yüzen pencere öğesi.** Görselleştirici kapsayıcısı, kendi özel tutamacı (handle) sürüklenerek ekranda serbestçe yeniden konumlandırılabilir. Girdi gecikmesini önlemek için sürükleme sırasında CSS geçişleri (transitions) devre dışı bırakılır, ardından farenin bırakılmasıyla geri yüklenir.

**Ölçek döngüsü.** Bir ölçek düğmesi, `--viz-scale` özel CSS özelliğini kullanarak görselleştirici bileşenini beş ölçek seviyesi (0.8x, 1.0x, 1.25x, 1.6x, 2.0x) boyunca döngüye sokar. 1.0x değerine geri dönülmesi konumu varsayılan köşe çıpasına (anchor) sıfırlar.

**Tam ekran sürükleyici mod.** Bir tam ekran düğmesi, kapsayıcıdaki `is-fullscreen` CSS sınıfını ve `document.body` üzerindeki `viz-fullscreen-active` sınıfını açıp kapatır. Geçiş, sert bir görsel kesintiyi önlemek için 250ms'lik bir opaklık animasyonu ile çapraz geçiş (cross-fade) yapılır. Tam ekran modunda, geçerli parça başlığı ve sanatçı bir metin katmanı olarak görüntülenir. Özel bir kapat düğmesi, aynı solma geçişiyle tam ekran modundan çıkar.

**Renk tepkisi.** Halka kontur (stroke) rengi, ses arttıkça yeşilden cam göbeği-beyaza (cyan-white) doğru geçiş yapar. Yeşil kanal 215'ten 255'e yükseltilir ve 0'dan 180'e kadar bir mavi kanal eklenerek yüksek ses seviyelerinde imza niteliğinde bir parlama etkisi yaratılır. Halka opaklığı hem aktif karışım (blend) seviyesi hem de mevcut ses seviyesi ile ölçeklenir ve görselleştirmenin ses enerjisiyle fiziksel olarak bağlantılı hissedilmesini sağlar.

### Şarkı Sözü Entegrasyonu

`LyricsManager.js`, arka ucun bir CORS proxy'si olarak hareket etmesiyle Genius API'sinden şarkı sözlerini getirir ve görüntüler.

**API anahtarı gereksinimi.** Şarkı sözleri, kullanıcının `Store.geniusApiKey` aracılığıyla yerel olarak `localStorage` içinde depolanan kişisel Genius API anahtarı kullanılarak getirilir. Sunucu tarafında hiçbir anahtar gerekmez. Hiçbir anahtar yapılandırılmamışsa, şarkı sözleri paneli Genius API istemci kayıt sayfasına doğrudan bir bağlantı içeren bir uyarı (prompt) görüntüler.

**Parça-yerel önbelleğe alma (caching).** Getirildikten sonra, şarkı sözleri ve şarkı meta verileri oturum süresince `this.currentData` içinde saklanır. İkinci kez aynı parçaya geçmek yeni bir ağ isteğini tetiklemez.

**Genius araması ve meta veri getirme.** Yönetici, en iyi eşleşen şarkıyı bulmak için bir `GET https://api.genius.com/search?q={title}+{artist}` isteğiyle başlar. En iyi sonucun `url`, `id` ve `primary_artist.id` değerleri saklanır. Paralel olarak, Detaylar Panelinde görüntülenen şarkı açıklamasını ve sanatçı biyografisini almak için `GET /songs/{id}` ve `GET /artists/{id}` hedeflerine iki ek istek gönderir.

**Sunucu taraflı şarkı sözü proxy'si.** Genius, şarkı sözlerini istemci tarafı JavaScript'inde işler ve CORS kısıtlamaları nedeniyle doğrudan fetch (getirme) tabanlı veri çekmeyi imkansız hale getirir. Bunu aşmak için oynatıcı, arka uçtan `GET /api/lyrics/proxy?url=...` adresinden Genius sayfasını ister; arka uç tüm HTML'yi sunucu tarafında getirir ve JSON olarak döndürür. Yönetici daha sonra tarayıcıda `DOMParser` kullanarak bu HTML'yi ayrıştırır, `[class^="Lyrics__Container"]` ve `.lyrics` öğelerini hedefler.

**Gereksiz satır filtreleme.** HTML'den ham metin çıkarıldıktan sonra, yönetici şarkı sözü bloğunun hem üstündeki hem de altındaki yaygın kullanıcı arayüzü kalıntılarını temizler: katkıda bulunan sayımları, çeviri etiketleri, "X Şarkı Sözleri" başlıkları, "Embed" alt bilgileri, "URL'yi Paylaş" uyarıları ve "Embed Kodunu Kopyala" dizeleri.

**Kademeli düşüş (Graceful degradation).** Şarkı sözleri metni HTML'den çıkarılamıyorsa (örneğin bir Genius sayfa yapısı değişikliği nedeniyle), panel, manuel görüntüleme için Genius sayfasına doğrudan bir bağlantı ile birlikte şarkı adını ve sanatçıyı görüntüler.

**Ertelenmiş yükleme (Deferred loading).** Yeni bir parça başladığında şarkı sözleri paneli kapalıysa, `LyricsManager.update()` yalnızca Genius aramasını ve meta veri getirme işlemini gerçekleştirir (Detaylar Paneli'nin sanatçı biyografisini ve şarkı bilgilerini doldurmak için). Tam şarkı sözü metni yalnızca panel açıldığında getirilerek gereksiz ağ trafiğini en aza indirir.

### Şarkı Listesi

`Tracklist.js`, o an yüklü olan çalma listesi için etkileşimli şarkı listesini işler.

**Satır düzeyinde oynatma.** Parça listesindeki herhangi bir satıra tıklamak `PlayerEngine.playTrack(idx)` öğesini çağırır. Etkin parçanın satırı, satır numarasının yerini animasyonlu bir ekolayzır çubuğu animasyonu (bağımsız CSS keyframe animasyonlarına sahip dört çubuk) almasına neden olan `playing` CSS sınıfını alır.

**Gerçek zamanlı metin arama.** Şarkı listesinin üstündeki bir girdi (input) alanı, sorgu dizesini parça başlığı, sanatçı adı ve albüm adıyla aynı anda eşleştirerek görünür satırları hiçbir düğmeye basmaya gerek kalmadan anında filtreler.

**Çok sütunlu sıralama (sorting).** Parça numarası, başlık, albüm ve süre sütun başlıkları tıklanabilirdir. Bir başlığa tıklamak şarkı listesini o alana göre sıralar; tekrar tıklamak sırayı tersine çevirir. Etkin sıralama sütunu, başlık hücresindeki bir CSS sınıfıyla belirtilir. Sıralama işlemi, oynatma sırasının görsel sırayı takip etmesi için `Store.currentTracks` değişkenini yerinde değiştirir.

**Parça düzenleme.** Her satırda, parçanın geçerli başlığı, sanatçıları, albümü ve kapak resmiyle önceden doldurulmuş bir açılır pencere (modal) açan bir düzenleme işlemi düğmesi bulunur. Sanatçı alanı virgülle ayrılmış bir dize (string) kabul eder. Kaydedildiğinde, değişiklikler diske kayıtlı ses dosyasındaki gömülü ID3 etiketlerini ve veritabanını güncelleyen `PATCH /api/track/{id}` uç noktasına gönderilir. Modülde yeni bir kapak resmi seçilirse, bu resim ayrı olarak `POST /api/track/{id}/cover` uç noktasına yüklenir ve mutagen kullanılarak ses dosyasına gömülür.

**Parça silme.** Bir silme eylemi düğmesi onay penceresi açar. Onaylandığında, `DELETE /api/track/{id}` ses dosyasını diskten ve kaydı veritabanından kaldırır. Şarkı listesi, sayfa yeniden yüklenmeden anında yeniden işlenir (render).

**Boş durum (Empty state).** Arama filtresi eşleşme üretmezse, tablo satırlarının yerine ortalanmış bir "Eşleşen parça bulunamadı" mesajı görüntülenir.

### Detaylar Paneli

`DetailsPanel.js`, o an çalan parça hakkında genişletilmiş bilgileri gösteren daraltılabilir (collapsible) bir yan paneli yönetir.

**Görüntülenen alanlar:** tam çözünürlüklü kapak resmi, parça başlığı, sanatçı adı, albüm adı, parça süresi, arşiv tarihi (tarayıcının yerel ayarlarına göre biçimlendirilmiş) ve mevcut olduğunda parçanın orijinal Spotify URL'sine doğrudan bir bağlantı.

**Genius destekli genişletilmiş bilgi.** `LyricsManager` geçerli parça için `fetchExtraInfo` çağrısını tamamladığında, `DetailsPanel.updateExtraInfo()`, Genius şarkı açıklamasını (şarkı hakkında) ve sanatçı biyografisini alır ve bunları özel daraltılabilir bölümlerde görüntüler. Bu bölümler, veri elde edilene kadar gizli kalır ve düzen (layout) kaymasını engeller.

**Kapak resmi değiştirme.** Detaylar panelindeki kapak resmine tıklamak bir dosya seçici açar. Yeni bir resim seçmek onu `POST /api/track/{id}/cover` adresine yükler, bu da resmi diskteki ses dosyasına gömer. Kullanıcı arayüzü, sayfa yeniden yüklenmeden hem detaylar panelindeki hem de parça listesi satırındaki kapağı hemen yeniler.

**Panel geçişi.** Panel durumu (açık/kapalı) `localStorage`'da saklanır. Şimdi oynatılıyor (now-playing) çubuğundaki albüm kapağı küçük resmine tıklamak da paneli açıp kapatır. Panel bir CSS sınıfı geçişi (toggle) ile içeri ve dışarı kayar.

### Kenar Çubuğu ve Kütüphane Gezinmesi

`Sidebar.js`, sol taraftaki çalma listesi tarayıcısını yönetir.

**Oturum listesi.** Tüm arşivlenmiş çalma listeleri kapak resimleri, adları ve `{done}/{total} İndirildi` formatında bir parça sayısıyla kartlar olarak listelenir. Sıfır tamamlanmış parçası olan oturumlar filtrelenir.

**Çalma listesi arama.** Kenar çubuğunun üstündeki bir arama girişi, görünür çalma listesi kartlarını gerçek zamanlı olarak çalma listesi adına göre filtreler.

**Aktif durum.** Şu anda yüklü olan çalma listesinin kartı bir `active` CSS sınıfı alır.

**Çalma listesi başlığı.** Bir çalma listesi yüklendiğinde, ana içerik alanı çalma listesi kapağını, adını, toplam parça sayısını ve toplam formatlanmış süreyi (`X sa Y dk` veya `Y dk Z sn`) görüntüler.

**Çalma listesi düzenleme.** Her çalma listesi kartında, çalma listesini yeniden adlandırmak ve kapak resmini değiştirmek için bir pencere (modal) açan bir düzenle düğmesi bulunur. İsim değişikliği `PATCH /api/session/{id}` adresine gönderilir. Yeni bir kapak `POST /api/session/{id}/cover` adresine yüklenir. Düzenlenen çalma listesi şu anda aktifse, başlık ve kapak yeniden yüklenmeden canlı olarak güncellenir.

**Çalma listesi silme.** Bir silme düğmesi onay modülü açar. Onaylandığında, `DELETE /api/session/{id}` diske kayıtlı ilişkili tüm ses dosyalarını ve o oturum için tüm veritabanı kayıtlarını kaldırır. Silinen çalma listesi o anda çalıyorsa, sayfa yeniden yüklenir.

**Kenar çubuğu daraltma.** Kenar çubuğu, kontrol çubuğundaki bir geçiş (toggle) düğmesi aracılığıyla gizlenebilir. Daraltılmış durum `localStorage`'a kaydedilir.

**Ayarlar modülü (modal).** Ayarlar düğmesi (dişli simgesi), arayüz dilini (İngilizce veya Türkçe) seçmek ve Genius API anahtarını girmek için bir modül açar. Değişiklikler kaydedildiği anda uygulanır.

### Kütüphane Yönetimi

Şarkı Listesi ve Detaylar Paneli bölümlerinde açıklanan parça bazlı işlemlerin ötesinde, arka uç ek kütüphane seviyesi yönetim uç noktaları sunar.

**Tüm arşivi silme.** `DELETE /sessions/clear` tüm SQLite veritabanını siler ve tüm bellek içi oturum durumunu temizleyerek dosyalara dokunmadan temiz bir sayfa (sıfırlama) sağlar.

**Oturum kurtarma uç noktası.** `POST /session/{id}/resume`, sunucunun indirme işleminin ortasında kesintiye uğradığı, parçaların `downloading` (indiriliyor) veya `tagging` (etiketleniyor) durumlarında takılı kaldığı veya tek tek parçaların başarısız olduğu durumlar için tasarlanmıştır. Etkilenen işleri sıfırlar ve hemen yeni bir arka plan indirme partisi gönderir.

### Klavye Kısayolları

Küresel klavye kısayolları `App.bindGlobalEvents()` içinde bağlanmıştır. Bir giriş alanına (input) odaklanıldığında tüm kısayollar devre dışı bırakılır.

| Tuş | Eylem |
|-----|--------|
| Boşluk (Space) | Oynat / Duraklat |
| Sağ Ok | 5 saniye ileri sar |
| Sol Ok | 5 saniye geri sar |
| Yukarı Ok | Sesi %5 artır |
| Aşağı Ok | Sesi %5 azalt |

### Uluslararasılaştırma

Oynatıcı İngilizce ve Türkçe arayüz dillerini destekler. Tüm kullanıcı tarafından görülebilen dizeler `app.js` içindeki bir `locales` nesnesinde tanımlanır. Aktif dil `localStorage`'da depolanır ve başlangıçta uygulanır. Dilleri değiştirmek, çalma listesi süresi etiketleri ve parça listesi başlıkları dahil olmak üzere tüm kullanıcı arayüzünü bir sayfa yeniden yüklemesi olmadan yeniden işler (render).

Çeviri anahtarları şunları kapsar: tüm kenar çubuğu etiketleri, parça listesi sütun başlıkları, oynatma durumu dizeleri, hata mesajları, uyarı bildirimleri (toast), ayarlar penceresi etiketleri ve tekrar modu etiketleri.

---

## Kurulum

**Ön Koşullar:**
- Python 3.10 veya üzeri
- FFmpeg (`PATH` değişkeninde erişilebilir olmalıdır)
- Google Chrome veya Chromium

**Arka uç kurulumu:**

```bash
cd backend
pip install -r requirements.txt
./start.sh
```

Arka uç `http://localhost:8765` adresinde başlar. Web oynatıcısına `http://localhost:8765/player` adresinden erişilebilir.

**Uzantı kurulumu:**

1. `chrome://extensions` adresini açın
2. Geliştirici Modu'nu (Developer Mode) etkinleştirin
3. "Paketlenmemiş öğe yükle"ye (Load unpacked) tıklayın ve `extension/` dizinini seçin
4. Herhangi bir Spotify çalma listesine gidin ve arşivlemeye başlamak için uzantı simgesine tıklayın

---

## Yapılandırma

Tüm arka uç parametreleri `backend/config.py` içinde ayarlanır.

| Parametre | Varsayılan | Açıklama |
|-----------|---------|-------------|
| `MUSIC_OUTPUT_DIR` | `~/Music/SpotifyArchive` | İndirilen tüm sesler için kök dizin |
| `CONCURRENT_WORKERS` | `8` | Paralel yt-dlp indirme thread (iş parçacığı) sayısı |
| `MAX_RETRIES` | `3` | Başarısızlık durumunda parça başına yeniden deneme sayısı |
| `AUDIO_FORMAT` | `mp3` | Çıktı ses formatı (`mp3`, `m4a`, `flac`, `opus`) |
| `AUDIO_QUALITY` | `0` | yt-dlp kalite ayarı (0 = en iyi, 9 = en kötü) |
| `PREFERRED_CODEC` | `mp3` | Dönüştürme için FFmpeg kodeği |
| `BACKEND_PORT` | `8765` | Yerel sunucu portu |
| `SEARCH_TEMPLATE` | `ytmsearch:{artist} - {title}` | Birincil arama sorgusu (YouTube Music) |
| `FALLBACK_TEMPLATE` | `ytsearch:{artist} - {title} official audio` | Geri dönüş (fallback) arama sorgusu (YouTube) |

---

## Gereksinimler

```text
fastapi
uvicorn
yt-dlp
mutagen
aiohttp
```

Python bağımlılıkları `backend/requirements.txt` içinde listelenmiştir. FFmpeg ayrı olarak sistem paket yöneticiniz aracılığıyla yüklenmelidir (`apt install ffmpeg`, `brew install ffmpeg`, vb.).
