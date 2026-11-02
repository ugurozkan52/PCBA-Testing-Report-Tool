# Montaj Görüntüleyici

Altium (veya herhangi bir CAD) üretim çıktılarından **interaktif montaj (dizgi) takip** ekranı oluşturan, platformdan bağımsız (Windows / Linux / macOS) Electron masaüstü uygulaması.

## Tarayıcı sürümü (GitHub Pages)

Aynı uygulama kurulum gerektirmeden tarayıcıda da çalışır: `https://<kullanıcı>.github.io/<depo>/`.
IPC-2581, BOM ve STEP dosyaları tarayıcıda işlenir; **hiçbir dosya sunucuya gönderilmez**.

**Yayınlama**
1. GitHub'da yeni bir depo açın (Pages ücretsiz planda depo herkese açık olmalıdır).
2. Bu klasörü depoya gönderin:
   ```
   git init -b main
   git add -A
   git commit -m "Montaj Görüntüleyici"
   git remote add origin https://github.com/<kullanıcı>/<depo>.git
   git push -u origin main
   ```
3. Depo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. `main` dalına her gönderimde `.github/workflows/pages.yml` web sürümünü derler (`node web/build.js`) ve yayınlar; adres Actions çıktısında görünür.

Yerelde denemek için: `npm run build:web` → `dist-web/` klasörünü herhangi bir statik sunucuyla açın (ör. `npx http-server dist-web`). `file://` ile açılmaz (Web Worker ve WASM sunucu ister).

**Masaüstü sürümden farkları**

| | Masaüstü (Electron) | Tarayıcı |
|---|---|---|
| Veri | Veri klasöründe JSON dosyaları | Tarayıcının kendi deposu (IndexedDB). Üst menüdeki **Veriler** düğmesiyle yedek indirilir / geri yüklenir. Tarayıcı verilerini temizlemek projeleri siler. |
| STEP → 3D | Ayrı işlem | Web Worker (occt-import-js WASM); çok büyük STEP dosyaları tarayıcı belleğiyle sınırlıdır |
| Test raporu | Her ölçümde `test-reports/<seri no>.pdf` güncellenir | **Raporu kaydet (PDF)…** ile PDF indirilir (pdfmake, DejaVu Sans gömülü) |
| KiCad eklentisi | Var | Yok (KiCad çıktıları elle yüklenir) |
| Proje silme | `_silinen` klasörüne taşınır | Kalıcı silinir (önce yedek alın) |
| İnternet | Gerekmez | Sitenin açılması için gerekir; dosyalar yine de cihazdan çıkmaz |

Tarayıcı sürümünün kodu `web/` klasöründedir: `vfs.js` (IndexedDB üzerinde senkron dosya sistemi; masaüstündeki `store.js` aynen kullanılır), `backend.js` (ana süreç işleyicilerinin tarayıcı karşılığı, `window.asm`), `step-worker.js`, `report-pdf.js`, `viewer-boot.js`, `build.js` (esbuild). Test: `npm run test:web`.

> Depoya `test/data/ipc/testcase3*.xml` (IPC-2581 Consortium örnek kartı) ve ondan üretilen STEP dosyaları konmaz (`.gitignore`); bu dosyalar yalnızca yerel testler içindir.

## Girdiler

Uygulama yalnızca iki girdi kullanır:

| Dosya | Zorunlu | İçerik |
|---|---|---|
| **IPC-2581** (Rev A/B/C, `.xml/.cvg`) | Evet | Kart profili, bileşen konum/açı/yüz, kılıf çerçeveleri, varsa gömülü BOM (AVL'den üretici ve MPN). Okunan katmanlar: **Top / ara katmanlar / Bottom** bakır (pad, yol, via, net), **Top / Bottom Silkscreen** ve **delik** katmanları. Montaj, doküman/fab yazıları, maske, pasta katmanları okunmaz. |
| **BOM** (CSV / XLS / XLSX) | Önerilir | Satır gruplaması ve gösterilecek sütunlar (Comment, MPN, üretici…). BOM'da olmayan bileşenler DNP sayılır. Seçilmezse IPC-2581 içindeki BOM kullanılır. |

Altium: *File → Fabrication Outputs → IPC-2581 Files* ve BOM için *Reports → Bill of Materials*.

Kartta çizilenler: **Top / Bottom Silkscreen**, pad'ler, **yollar**, **vialar** ve **delikler** (TH pad delikleri, montaj/NPTH delikleri). Bir yola tıklamak o neti seçer ve vurgular (net listesi modunda ilgili satıra gider). Bakır dolgular varsayılan olarak kapalıdır, Ayarlar → *Dolgular* ile açılır. Montaj/fab yazıları çizilmez.

BOM'daki **Description**, **Manufacturer** ve **Manufacturer Part Number** sütunları (Türkçe karşılıkları dahil) dizgi listesinde varsayılan olarak gösterilir; listenin sol üstündeki sütun menüsünden onay kutularıyla açılıp kapatılabilir.

### Türkçe karakter desteği
- IPC-2581: XML başlığındaki kodlama (UTF-8, UTF-16, ISO-8859-9, windows-1254…) kullanılır.
- BOM: XLSX/XLS; CSV için UTF-8 (BOM'lu/BOM'suz), UTF-16 ve windows-1254 otomatik tanınır; `;` ayraçlı Excel CSV desteklenir.
- Proje adı, seri no, operatör, sütun adları, kayıt ve CSV dışa aktarımı Türkçe karakterleri korur.
- Arama/filtrede İ, I, ı → i olarak eşlenir ("IĞNE", "iğne", "ığne" aynı sonucu verir).
BOM'da Designator sütunu `R1, R2, R3` veya `R1-R5` biçiminde olabilir; Türkçe karakterli CSV'ler (UTF-8 veya Windows-1254) otomatik tanınır.

## Görsel tasarım

Arayüz teması **Arctic Frost**: Ice Blue #D4E4F7, Steel Blue #4A6FA5 (ana renk), Silver #C0C0C0, Crisp White #FAFAFA. Kart görünümünde seçilebilir PCB rengi, beyaz serigrafi ve altın pad'ler. Kartta renk montaj durumunu taşır: **altın** = boş pad, **mavi** = yerleştirildi, **sarı (yanıp söner)** = üzerinde çalışılan satır / seçili net. PCB rengi Ayarlar menüsünden seçilir (yeşil, mavi, kırmızı, siyah, mor, beyaz, sarı). BOM, üst yüz ve alt yüz panelleri köşedeki düğmeyle tek ekran yapılır (Esc geri alır). Kullanım kılavuzu ve açık kaynak lisansları uygulamadaki **Hakkında** sayfasındadır. İlerleme çubukları bir sıra SMD pad'i olarak çizilir. Ana ekrandaki "kaldığınız yerden devam" kartı bir üretim takip kartı (traveller) gibi büyük seri numarasıyla gösterilir. Yazı tipi: DejaVu Sans (başlıklar kalın), yoğun tablolarda DejaVu Sans Condensed; uygulamayla birlikte gelir, internet gerekmez.

## Dizgi ekranı (v1.9)

- **Şimdi çubuğu:** seçili satırın değeri, açıklaması, adedi ve referansları; büyük **◀ Önceki / Yerleştirildi ✓ / Sonraki ▶** düğmeleri.
- Onay kutuları büyük (24 px); hücrenin tamamı tıklanabilir.
- Her işaretlemeden sonra 6 sn **Geri al**; sütun başlığına çift tıklayarak toplu işaretleme onay ister.
- Satır/net seçiliyken kartın geri kalanı soluklaşır; seçim sarı yanıp söner (Ayarlar → *Seçim yanıp sönmesi*: Kısa / Sürekli / Kapalı). Sarı PCB'de seçim camgöbeği olur.
- Kısayol ipucu tablonun üstünde; istatistik menüsü araç çubuğundan kaldırıldı; yüz düğmeleri yazılı (Üst yüz / İki yüz / Alt yüz).
- İçe aktarma hataları önizleme alanında kalıcı gösterilir; proje silme "⋯" menüsünde.

## v1.10

- Ayarlar → **Maske rengi** (lehim maskesi: yeşil, mavi, kırmızı, siyah, mor, beyaz, sarı).
- Varsayılan tek onay sütunu: **Dizildi / Placed** ("Toplandı" kaldırıldı; eski projelerde otomatik kaldırılır, kayıtlar korunur).
- Koyu tema uygulama genelidir: görüntüleyicide veya ana ekrandaki ◐ düğmesiyle açılır, ana ekran ve sihirbazda da geçerlidir.
- Üst paneldeki etiket/değer satırları tek hizada; yazılar taşmaz, kısaltılır.

## Dil / Language

Arayüz **Türkçe** ve **English** destekler. Ana ekrandaki dil seçicisi veya *Dil / Language* menüsüyle değiştirilir; seçim hatırlanır. İlk açılışta işletim sistemi dili kullanılır. Yeni projelerde varsayılan onay sütunları dile göre gelir (Toplandı/Dizildi – Picked/Placed). Çeviriler `src/i18n/i18n.js` içindedir.

## Özellikler

- Görüntüleyici özellikleri: üst/alt/çift yüz, BOM sol/üst/sadece, gruplu/grupsuz/net listesi, referans arama ve filtre, pin-1 vurgusu, kart döndürme, koyu tema, net renklendirme, görüntü ve BOM (CSV/TXT) dışa aktarma, klavye kısayolları (↑/↓ satır, **n** = işaretle ve sonrakine geç, Alt+1..9 sütun değiştir).
- **Kart (seri no) bazlı takip**: aynı tasarımdan her kartın ilerlemesi ayrı tutulur.
- **Operatör + zaman damgalı kayıt**: her işaretleme/işaret kaldırma `log.jsonl` dosyasına (zaman, bilgisayar, seri no, operatör, sütun, referanslar, değer) eklenir; uygulama içinden görüntülenir, CSV'ye aktarılır.
- **Kaldığı yerden devam**: tüm durum her tıklamada diske yazılır; uygulama yeniden açıldığında son proje/kart/operatör ve son çalışılan BOM satırı geri gelir.
- **Veriyi güncelleme**: düzeltilmiş/yeni revizyon dosyalarla yeniden içe aktarım; ilerleme designator bazında saklandığından korunur.
- Tek dosyalık HTML dışa aktarımı (tarayıcıda açılan montaj sayfası, paylaşım için).

## Veri klasörü

Varsayılan: `%APPDATA%\Montaj Görüntüleyici\MontajData` (portable sürümde exe'nin yanındaki `MontajData`). Uygulamadan değiştirilebilir (ör. yedeklenen bir ağ klasörü).

```
MontajData/
  app-state.json               son oturum, operatör listesi
  projects/<id>/
    project.json               proje bilgisi + içe aktarma ayarları + rapor
    pcbdata.json               işlenmiş kart verisi
    sources/                   içe aktarılan orijinal dosyaların kopyası (izlenebilirlik)
    settings.json              görünüm ayarları (proje geneli)
    boards/<seri>.json         kartın işaret durumları ve ilerlemesi
    log.jsonl                  montaj kaydı (yalnızca eklenir)
  projects/_silinen/           silinen projeler (geri alınabilir)
```

## Geliştirme / derleme

```bash
npm install
npm start                      # geliştirme modunda çalıştır
npm test                       # çekirdek ayrıştırıcı testleri (test verisi yolu argüman)
npm run dist:win               # Windows kurulum (Windows'ta veya wine ile)
npm run dist:linux             # AppImage + deb
npm run dist:mac               # dmg (macOS'ta)
```

## Kod yapısı

```
src/core/      IPC-2581 okuyucu, BOM tabloları, pcbdata üretimi (Node, UI'dan bağımsız)
src/main/      Electron ana süreç, kalıcı depolama, IPC
src/renderer/home/    proje listesi, içe aktarma sihirbazı, kart/operatör seçimi
src/renderer/viewer/  montaj görüntüleyici + oturum çubuğu, kayıt, depolama köprüsü
```

## Bilinen sınırlar

- IPC-2581'de birden fazla Step varsa ilki kullanılır (rapor uyarır).
- Aynı karta aynı anda iki istasyondan işlem yapılması desteklenmez.

## Lisans

MIT. `src/renderer/viewer/ibom/` klasöründeki görüntüleme kodu MIT lisanslı açık kaynak koddan uyarlanmıştır; lisans metni aynı klasördedir (MIT lisansı, kaynak dağıtımında bu dosyanın korunmasını gerektirir).
