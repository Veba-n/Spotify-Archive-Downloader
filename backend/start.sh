#!/bin/bash
cd "$(dirname "$0")"

# Activate Venv (if exists)
VENV_DIR="$(dirname "$0")/../.venv"
if [ -d "$VENV_DIR" ]; then
    source "$VENV_DIR/bin/activate"
    echo "🐍 Venv active: $VENV_DIR"
fi

RSYNC_ENABLED=false
for arg in "$@"; do
    if [ "$arg" == "--rsync-lyric" ]; then
        RSYNC_ENABLED=true
    fi
done

echo "📦 Checking dependencies..."
if [ "$RSYNC_ENABLED" = true ]; then
    echo "🎤 AI Sync Enabled. Installing heavy dependencies (Whisper/Torch)..."
    pip3 install -r requirements.txt -r requirements-gpu.txt -q || pip install -r requirements.txt -r requirements-gpu.txt -q
else
    echo "⚡ Lite Mode. Installing basic dependencies..."
    pip3 install -r requirements.txt -q || pip install -r requirements.txt -q
fi

echo "🔧 Checking FFmpeg..."
if ! command -v ffmpeg &> /dev/null; then
    echo "⚠️  FFmpeg not found! To install:"
    echo "   Ubuntu: sudo apt install ffmpeg"
    echo "   Fedora: sudo dnf install ffmpeg"
    echo "   Arch:   sudo pacman -S ffmpeg"
    exit 1
fi

echo "🚀 Starting backend..."
python main.py "$@"
