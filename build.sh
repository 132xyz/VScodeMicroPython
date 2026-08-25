#!/usr/bin/env bash

set -Eeuo pipefail
shopt -s nullglob

VERSION_TYPE="patch"
SKIP_VERSION=false
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="release"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    CYAN='\033[0;36m'
    RED='\033[0;31m'
    RESET='\033[0m'
else
    GREEN=''
    YELLOW=''
    CYAN=''
    RED=''
    RESET=''
fi

info() {
    printf '%b%s%b\n' "$GREEN" "$1" "$RESET"
}

warn() {
    printf '%b%s%b\n' "$YELLOW" "$1" "$RESET"
}

error() {
    printf '%b%s%b\n' "$RED" "$1" "$RESET" >&2
}

usage() {
    cat <<'EOF'
Usage: ./build.sh [patch|minor|major] [-S|--skip-version]

Options:
  patch|minor|major  Version increment type. Defaults to patch.
  -S, --skip-version
                     Package without updating package.json/package-lock.json.
  -h, --help         Show this help.
EOF
}

while (($# > 0)); do
    case "$1" in
        patch|minor|major)
            VERSION_TYPE="$1"
            ;;
        -S|--skip-version)
            SKIP_VERSION=true
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            error "Error: unsupported argument: $1"
            usage >&2
            exit 2
            ;;
    esac
    shift
done

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        error "Error: $1 was not found. Install it or ensure it is on PATH."
        exit 1
    fi
}

find_python() {
    if command -v python3 >/dev/null 2>&1; then
        command -v python3
        return
    fi
    if command -v python >/dev/null 2>&1; then
        command -v python
        return
    fi
    error "Error: Python was not found. Install Python 3 or ensure python3/python is on PATH."
    exit 1
}

get_package_version() {
    node -p "require('./package.json').version"
}

cd "$SCRIPT_DIR"
require_command node
require_command npm
PYTHON="$(find_python)"

info "Compiling..."
if npm run compile; then
    :
else
    status=$?
    error "Error: compilation failed. Aborting version bump and packaging."
    exit "$status"
fi

info "Running JavaScript tests..."
if npm test; then
    :
else
    status=$?
    error "Error: JavaScript tests failed. Aborting version bump and packaging."
    exit "$status"
fi

info "Running Python tests..."
if "$PYTHON" scripts/mpyrepl/tests/run_with_coverage.py; then
    :
else
    status=$?
    error "Error: Python tests failed. Aborting version bump and packaging."
    exit "$status"
fi

if [[ "$SKIP_VERSION" == false ]]; then
    info "Reading current version from package.json..."
    CURRENT_VERSION="$(get_package_version)"
    warn "Current version: $CURRENT_VERSION"

    info "Incrementing version ($VERSION_TYPE)..."
    if npm version "$VERSION_TYPE" --no-git-tag-version; then
        :
    else
        status=$?
        error "Error: version bump failed. Aborting packaging."
        exit "$status"
    fi

    NEW_VERSION="$(get_package_version)"
    info "Version updated to $NEW_VERSION"
else
    CURRENT_VERSION="$(get_package_version)"
    printf '%b%s%b\n' "$CYAN" "Using current version: $CURRENT_VERSION (no increment)" "$RESET"
fi

warn "Cleaning old .vsix files from root directory..."
ROOT_VSIX_FILES=(./*.vsix)
if ((${#ROOT_VSIX_FILES[@]} > 0)); then
    rm -f -- "${ROOT_VSIX_FILES[@]}"
fi

info "Packaging..."
if npm run package; then
    :
else
    status=$?
    error "Error: packaging failed. Aborting output organization."
    exit "$status"
fi

info "Organizing output..."
if [[ ! -d "$OUTPUT_DIR" ]]; then
    mkdir -p -- "$OUTPUT_DIR"
    info "Created output directory: $OUTPUT_DIR"
fi

VSIX_FILES=(./*.vsix)
if ((${#VSIX_FILES[@]} == 0)); then
    warn "Warning: No .vsix files found to move"
else
    for vsix_file in "${VSIX_FILES[@]}"; do
        destination="$OUTPUT_DIR/$(basename -- "$vsix_file")"
        mv -f -- "$vsix_file" "$destination"
        info "Moved $(basename -- "$vsix_file") to $OUTPUT_DIR"
    done
fi

info "Build completed successfully!"
printf '%b%s%b\n' "$CYAN" "Output files are located in: $OUTPUT_DIR" "$RESET"
