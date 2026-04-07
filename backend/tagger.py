from pathlib import Path
from mutagen.id3 import (
    ID3, TIT2, TPE1, TALB, TPE2, APIC, ID3NoHeaderError
)
from mutagen.mp3  import MP3
from mutagen.mp4  import MP4, MP4Cover
from mutagen.flac import FLAC, Picture


def tag_audio_file(file_path: str, title: str, artists: list,
                   album: str = '', cover_path: str = None):
    """
    Automatically detect audio file format and use appropriate tagger.
    Supports MP3, M4A/AAC, and FLAC.

    Embedded info:
      - Track title (TIT2 / ©nam / title)
      - Artist(s) (TPE1 / ©ART / artist)
      - Album artist (TPE2)
      - Album name (TALB / ©alb / album)
      - Cover art (APIC / covr / Picture)
    """
    path = Path(file_path)
    ext  = path.suffix.lower()

    duration = 0
    if ext == '.mp3':
        _tag_mp3(path, title, artists, album, cover_path)
        try: duration = int(MP3(path).info.length)
        except: pass
    elif ext in ('.m4a', '.aac', '.mp4'):
        _tag_m4a(path, title, artists, album, cover_path)
        try: duration = int(MP4(path).info.length)
        except: pass
    elif ext == '.flac':
        _tag_flac(path, title, artists, album, cover_path)
        try: duration = int(FLAC(path).info.length)
        except: pass
        
    dur_str = f"{duration//60}:{int(duration%60):02d}" if duration > 0 else "0:00"
    return dur_str


def _tag_mp3(path, title, artists, album, cover_path):
    try:
        tags = ID3(str(path))
    except ID3NoHeaderError:
        tags = ID3()

    tags['TIT2'] = TIT2(encoding=3, text=title)
    tags['TPE1'] = TPE1(encoding=3, text='; '.join(artists))
    tags['TPE2'] = TPE2(encoding=3, text=artists[0] if artists else '')
    tags['TALB'] = TALB(encoding=3, text=album)

    if cover_path and Path(cover_path).exists():
        cover_data = Path(cover_path).read_bytes()
        mime = 'image/jpeg' if cover_path.endswith('.jpg') else 'image/png'
        tags['APIC'] = APIC(
            encoding=3, mime=mime,
            type=3,          # 3 = Front cover
            desc='Cover',
            data=cover_data
        )

    tags.save(str(path), v2_version=3)


def _tag_m4a(path, title, artists, album, cover_path):
    tags = MP4(str(path))
    tags['\xa9nam'] = [title]
    tags['\xa9ART'] = ['; '.join(artists)]
    tags['\xa9alb'] = [album]

    if cover_path and Path(cover_path).exists():
        cover_data = Path(cover_path).read_bytes()
        fmt = MP4Cover.FORMAT_JPEG if cover_path.endswith('.jpg') \
              else MP4Cover.FORMAT_PNG
        tags['covr'] = [MP4Cover(cover_data, imageformat=fmt)]

    tags.save()


def _tag_flac(path, title, artists, album, cover_path):
    audio = FLAC(str(path))
    audio['title']  = [title]
    audio['artist'] = ['; '.join(artists)]
    audio['album']  = [album]

    if cover_path and Path(cover_path).exists():
        pic = Picture()
        pic.data = Path(cover_path).read_bytes()
        pic.type = 3
        pic.mime = 'image/jpeg' if cover_path.endswith('.jpg') else 'image/png'
        audio.add_picture(pic)

    audio.save()
