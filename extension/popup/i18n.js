const locales = {
    en: {
        title: "Spotify Archive",
        subtitle: "Archive your playlist",
        checking: "Checking...",
        backend_active: "Backend active",
        backend_offline: "Backend offline",
        no_backend: "No Backend Connection",
        start_backend: "Please start backend: bash start.sh",
        scanning: "Scanning tracks...",
        sending: "Sending tracks to backend...",
        tracks_found: "tracks found...",
        starting: "Starting...",
        download_playlist: "Download Playlist",
        running: "Running",
        processing: "tracks processing...",
        download_continuing: "Download continuing...",
        ready: "Ready",
        ready_msg: "Open a Spotify playlist to start downloading",
        completed: "Completed!",
        downloaded: "tracks downloaded",
        failed: "failed",
        start_new: "Start New Download",
        error: "Error",
        session_not_found: "Download session not found. Please restart.",
        tagging: "Tagging...",
        waiting_queue: "Waiting in queue...",
        playlist_uptodate: "Playlist is already up-to-date, no new tracks found.",
        no_downloads: "No downloads yet",
        unknown: "Unknown",
        track: "track",
        resume: "Resume",
        reset_confirm: "All download history and stuck background tasks will be deleted. Are you sure?",
        cleared: "Reset",
        cleared_msg: "System is clean. You can start a new download.",
        failed_reset: "Failed to reset backend: ",
        all_downloaded: "All downloaded",
        status_done: "Done",
        status_active: "Active",
        status_partial: "Partial",
        resuming: "Resuming from left off...",
        redownloading: "tracks re-downloading...",

        lbl_downloading: "Downloading...",
        lbl_done: "Done",
        lbl_pending: "Pending",
        lbl_failed: "Failed",
        lbl_total: "Total",
        lbl_recent: "Recent Downloads",
        lbl_listen: "Listen Archive",
        lbl_reset: "Reset"
    },
    tr: {
        title: "Spotify Arşiv",
        subtitle: "Çalma listeni arşivle",
        checking: "Kontrol ediliyor...",
        backend_active: "Backend aktif",
        backend_offline: "Backend kapalı",
        no_backend: "Backend Bağlantısı Yok",
        start_backend: "Lütfen backend'i başlatın: bash start.sh",
        scanning: "Şarkılar taranıyor...",
        sending: "Şarkılar backend'e iletiliyor...",
        tracks_found: "şarkı bulundu...",
        starting: "Başlatılıyor...",
        download_playlist: "Çalma Listesini İndir",
        running: "Çalışıyor",
        processing: "şarkı işleniyor...",
        download_continuing: "İndirme devam ediyor...",
        ready: "Hazır",
        ready_msg: "Bir Spotify çalma listesi açın ve indirmeye başlayın",
        completed: "Tamamlandı!",
        downloaded: "şarkı indirildi",
        failed: "başarısız",
        start_new: "Yeni İndirme Başlat",
        error: "Hata",
        session_not_found: "İndirme oturumu bulunamadı. Lütfen tekrar başlatın.",
        tagging: "Etiketleniyor...",
        waiting_queue: "Sırada bekliyor...",
        playlist_uptodate: "Playlist zaten güncel, yeni şarkı bulunamadı.",
        no_downloads: "Henüz indirme yok",
        unknown: "Bilinmeyen",
        track: "şarkı",
        resume: "Devam",
        reset_confirm: "Tüm indirme geçmişi ve takılı kalan arkaplan görevleri silinecek. Emin misiniz?",
        cleared: "Sıfırlandı",
        cleared_msg: "Sistem tertemiz oldu. Yeni indirmeye başlayabilirsiniz.",
        failed_reset: "Backend sıfırlanamadı: ",
        all_downloaded: "Hepsi indirilmiş",
        status_done: "Tamam",
        status_active: "Aktif",
        status_partial: "Yarıda",
        resuming: "Kaldığı yerden devam ediliyor...",
        redownloading: "şarkı yeniden indiriliyor...",

        lbl_downloading: "İndiriliyor...",
        lbl_done: "Tamamlandı",
        lbl_pending: "Bekliyor",
        lbl_failed: "Başarısız",
        lbl_total: "Toplam",
        lbl_recent: "Son İndirmeler",
        lbl_listen: "Arşivi Dinle",
        lbl_reset: "Sıfırla"
    }
};

let currentLang = 'en';

function initI18n() {
    chrome.storage.local.get(['lang'], (res) => {
        if (res.lang) {
            currentLang = res.lang;
        } else {
            // Priority english
            currentLang = 'en';
            chrome.storage.local.set({ lang: 'en' });
        }
        applyTranslations();
        updateLangSwitcher();
    });
}

function switchLang(lang) {
    if (locales[lang]) {
        currentLang = lang;
        chrome.storage.local.set({ lang: lang });
        applyTranslations();
        updateLangSwitcher();
        if (typeof refreshDynamicTexts === 'function') {
            refreshDynamicTexts();
        }
    }
}

function t(key) {
    return locales[currentLang] ? (locales[currentLang][key] || key) : key;
}

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (locales[currentLang][key]) {
            el.textContent = locales[currentLang][key];
        }
    });
}

function updateLangSwitcher() {
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-lang') === currentLang) {
            btn.classList.add('active');
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initI18n();
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            switchLang(e.target.getAttribute('data-lang'));
        });
    });
});
