#!/bin/sh
# ── AgentHive — Installation Script ──────────────────────────────────
#
# Downloads and installs the AgentHive standalone binary from GitHub
# Releases. Detects OS and architecture automatically.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/leogimenes/agenthive/main/scripts/install.sh | sh
#   wget -qO- https://raw.githubusercontent.com/leogimenes/agenthive/main/scripts/install.sh | sh
#
# Options:
#   --global            Install to /usr/local/bin instead of ~/.local/bin
#   --version <tag>     Install a specific release (e.g. v0.1.0)
#   --uninstall         Remove the installed binary
#   --yes               Skip confirmation prompts
#
# Requires: curl or wget, sha256sum or shasum
# ──────────────────────────────────────────────────────────────────────

set -eu

REPO="leogimenes/agenthive"
BINARY_NAME="hive"
LOCAL_DIR="$HOME/.local/bin"
GLOBAL_DIR="/usr/local/bin"

# ── Defaults ─────────────────────────────────────────────────────────

INSTALL_DIR="$LOCAL_DIR"
VERSION=""
UNINSTALL=0
YES=0

# ── Argument parsing ─────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --global)
      INSTALL_DIR="$GLOBAL_DIR"
      shift
      ;;
    --version)
      if [ $# -lt 2 ]; then
        echo "Error: --version requires a tag argument (e.g. --version v0.1.0)"
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --yes|-y)
      YES=1
      shift
      ;;
    --help|-h)
      sed -n '/^# Usage:/,/^# Requires:/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run with --help for usage."
      exit 1
      ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────

info() {
  echo "  $*"
}

error() {
  echo "Error: $*" >&2
  exit 1
}

confirm() {
  if [ "$YES" = 1 ]; then
    return 0
  fi
  printf "%s [y/N] " "$1"
  read -r answer
  case "$answer" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# Select download command: prefer curl, fall back to wget
setup_fetch() {
  if command -v curl >/dev/null 2>&1; then
    FETCH="curl"
  elif command -v wget >/dev/null 2>&1; then
    FETCH="wget"
  else
    error "Neither curl nor wget found. Please install one and retry."
  fi
}

# fetch_url <url> <output_file>
# Downloads a URL to a file. Uses curl or wget.
fetch_url() {
  url="$1"
  output="$2"
  if [ "$FETCH" = "curl" ]; then
    curl -fsSL -o "$output" "$url"
  else
    wget -qO "$output" "$url"
  fi
}

# fetch_text <url>
# Downloads a URL and prints to stdout.
fetch_text() {
  url="$1"
  if [ "$FETCH" = "curl" ]; then
    curl -fsSL "$url"
  else
    wget -qO- "$url"
  fi
}

# Select SHA256 checksum command
setup_checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    SHASUM="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    SHASUM="shasum -a 256"
  else
    error "Neither sha256sum nor shasum found. Cannot verify download."
  fi
}

# ── Platform detection ───────────────────────────────────────────────

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux)  OS="linux" ;;
    Darwin) OS="darwin" ;;
    *)      error "Unsupported OS: $OS. Only Linux and macOS are supported." ;;
  esac

  case "$ARCH" in
    x86_64|amd64)   ARCH="x64" ;;
    aarch64|arm64)   ARCH="arm64" ;;
    *)               error "Unsupported architecture: $ARCH. Only x64 and arm64 are supported." ;;
  esac

  PLATFORM="${OS}-${ARCH}"
}

# ── Resolve version ─────────────────────────────────────────────────

resolve_version() {
  if [ -n "$VERSION" ]; then
    # Ensure version starts with 'v'
    case "$VERSION" in
      v*) ;;
      *)  VERSION="v${VERSION}" ;;
    esac
    return
  fi

  info "Fetching latest release..."
  # Use GitHub API to get the latest release tag
  LATEST=$(fetch_text "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

  if [ -z "$LATEST" ]; then
    error "Could not determine latest release. Specify a version with --version."
  fi
  VERSION="$LATEST"
}

# ── Uninstall ────────────────────────────────────────────────────────

do_uninstall() {
  found=0
  for dir in "$LOCAL_DIR" "$GLOBAL_DIR"; do
    if [ -f "$dir/$BINARY_NAME" ]; then
      found=1
      if confirm "Remove $dir/$BINARY_NAME?"; then
        rm -f "$dir/$BINARY_NAME"
        info "Removed $dir/$BINARY_NAME"
      fi
    fi
  done
  if [ "$found" = 0 ]; then
    info "No AgentHive installation found."
  fi
  exit 0
}

# ── Install ──────────────────────────────────────────────────────────

do_install() {
  setup_fetch
  setup_checksum
  detect_platform
  resolve_version

  BINARY_URL="https://github.com/${REPO}/releases/download/${VERSION}/hive-${PLATFORM}"
  CHECKSUM_URL="${BINARY_URL}.sha256"

  echo ""
  echo "AgentHive Installer"
  echo "  Version:  $VERSION"
  echo "  Platform: $PLATFORM"
  echo "  Target:   $INSTALL_DIR/$BINARY_NAME"
  echo ""

  # Check for existing installation
  if [ -f "$INSTALL_DIR/$BINARY_NAME" ]; then
    existing_version=$("$INSTALL_DIR/$BINARY_NAME" --version 2>/dev/null || echo "unknown")
    info "Existing installation found: $BINARY_NAME $existing_version"
    if ! confirm "Overwrite $INSTALL_DIR/$BINARY_NAME?"; then
      info "Aborted."
      exit 0
    fi
  fi

  # Create install directory
  mkdir -p "$INSTALL_DIR"

  # Download to a temp directory
  TMPDIR=$(mktemp -d)
  trap 'rm -rf "$TMPDIR"' EXIT

  info "Downloading hive-${PLATFORM}..."
  fetch_url "$BINARY_URL" "$TMPDIR/$BINARY_NAME"

  # Verify checksum (if available)
  if fetch_url "$CHECKSUM_URL" "$TMPDIR/$BINARY_NAME.sha256" 2>/dev/null; then
    info "Verifying checksum..."
    EXPECTED=$(awk '{print $1}' "$TMPDIR/$BINARY_NAME.sha256")
    ACTUAL=$(cd "$TMPDIR" && $SHASUM "$BINARY_NAME" | awk '{print $1}')

    if [ "$EXPECTED" != "$ACTUAL" ]; then
      error "Checksum verification failed!
  Expected: $EXPECTED
  Got:      $ACTUAL
  The download may be corrupted. Please try again."
    fi
  else
    info "No checksum file found, skipping verification."
  fi

  # Install
  chmod +x "$TMPDIR/$BINARY_NAME"
  mv "$TMPDIR/$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME"

  echo ""
  info "AgentHive $VERSION installed to $INSTALL_DIR/$BINARY_NAME"

  # Check PATH
  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*)
      info "Run 'hive --version' to verify."
      ;;
    *)
      echo ""
      echo "  WARNING: $INSTALL_DIR is not in your PATH."
      echo ""
      echo "  Add it to your shell profile:"
      echo ""
      echo "    # bash (~/.bashrc)"
      echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
      echo ""
      echo "    # zsh (~/.zshrc)"
      echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
      echo ""
      echo "    # fish (~/.config/fish/config.fish)"
      echo "    fish_add_path $INSTALL_DIR"
      echo ""
      echo "  Then restart your shell or run: export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
  esac

  # Shell completion setup instructions
  echo ""
  echo "  Shell completions:"
  echo ""
  echo "    # bash"
  echo "    hive completion bash >> ~/.bashrc"
  echo ""
  echo "    # zsh"
  echo "    hive completion zsh > \"\${fpath[1]}/_hive\""
  echo ""
  echo "    # fish"
  echo "    hive completion fish > ~/.config/fish/completions/hive.fish"
}

# ── Main ─────────────────────────────────────────────────────────────

if [ "$UNINSTALL" = 1 ]; then
  do_uninstall
else
  do_install
fi
