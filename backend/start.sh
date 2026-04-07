#!/bin/bash
cd "$(dirname "$0")"

# Activate Venv (if exists)
VENV_DIR="$(dirname "$0")/../.venv"
if [ -d "$VENV_DIR" ]; then
    source "$VENV_DIR/bin/activate"
    echo "🐍 Venv active: $VENV_DIR"
fi

echo "📦 Checking dependencies..."
pip3 install -r requirements.txt -q 2>/dev/null || pip install -r requirements.txt -q

echo "🔧 Checking FFmpeg..."
if ! command -v ffmpeg &> /dev/null; then
    echo "⚠️  FFmpeg not found! To install:"
    echo "   Ubuntu: sudo apt install ffmpeg"
    echo "   Fedora: sudo dnf install ffmpeg"
    echo "   Arch:   sudo pacman -S ffmpeg"
    exit 1
fi

echo "🚀 Starting backend..."
python main.py
