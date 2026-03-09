#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RUNTIME_ROOT="${REPO_ROOT}/runtime"
PYTHON_TARGET="${RUNTIME_ROOT}/python"
NODE_TARGET="${RUNTIME_ROOT}/node"
PLAYWRIGHT_TARGET="${RUNTIME_ROOT}/playwright-browsers"
TOOLS_TARGET="${RUNTIME_ROOT}/tools"

NODE_DEPS=(pptxgenjs sharp react react-dom react-icons)

PYTHON_STANDALONE_RELEASE="20240415"
PYTHON_STANDALONE_VERSION="3.12.3"
PYTHON_DOWNLOAD_BASE_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_STANDALONE_RELEASE}"
PYTHON_ARCHIVE_X64="cpython-${PYTHON_STANDALONE_VERSION}+${PYTHON_STANDALONE_RELEASE}-x86_64-apple-darwin-install_only.tar.gz"
PYTHON_ARCHIVE_ARM64="cpython-${PYTHON_STANDALONE_VERSION}+${PYTHON_STANDALONE_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
PYTHON_SHA256_X64="c37a22fca8f57d4471e3708de6d13097668c5f160067f264bb2b18f524c890c8"
PYTHON_SHA256_ARM64="ccc40e5af329ef2af81350db2a88bbd6c17b56676e82d62048c15d548401519e"

log() {
  printf '[prepare:runtimes:mac] %s\n' "$1"
}

warn() {
  printf '[prepare:runtimes:mac] Warning: %s\n' "$1" >&2
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

cleanup_dir() {
  rm -rf "$1"
  mkdir -p "$1"
}

resolve_python_artifact() {
  local arch_name
  arch_name="$(uname -m)"

  case "${arch_name}" in
    x86_64)
      PYTHON_ARCHIVE_NAME="${PYTHON_ARCHIVE_X64}"
      PYTHON_ARCHIVE_SHA256="${PYTHON_SHA256_X64}"
      ;;
    arm64|aarch64)
      PYTHON_ARCHIVE_NAME="${PYTHON_ARCHIVE_ARM64}"
      PYTHON_ARCHIVE_SHA256="${PYTHON_SHA256_ARM64}"
      ;;
    *)
      echo "Unsupported macOS arch for portable Python: ${arch_name}" >&2
      exit 1
      ;;
  esac

  PYTHON_ARCHIVE_URL="${PYTHON_DOWNLOAD_BASE_URL}/${PYTHON_ARCHIVE_NAME}"
}

verify_sha256() {
  local file_path="$1"
  local expected_sha="$2"
  local actual_sha

  actual_sha="$(shasum -a 256 "$file_path" | awk '{print $1}')"
  if [[ "${actual_sha}" != "${expected_sha}" ]]; then
    echo "SHA256 mismatch for ${file_path}" >&2
    echo "Expected: ${expected_sha}" >&2
    echo "Actual:   ${actual_sha}" >&2
    exit 1
  fi
}

find_extracted_python_root() {
  local extract_root="$1"
  local candidate=""

  if [[ -x "${extract_root}/python/bin/python3" ]]; then
    printf '%s\n' "${extract_root}/python"
    return 0
  fi

  candidate="$(find "${extract_root}" -type f -path '*/bin/python3' | head -n 1 || true)"
  if [[ -z "${candidate}" ]]; then
    echo "Portable Python archive did not contain bin/python3 under ${extract_root}" >&2
    exit 1
  fi

  dirname "$(dirname "${candidate}")"
}

cleanup_python_runtime() {
  find "${PYTHON_TARGET}" -type d \( -name "__pycache__" -o -name ".pytest_cache" -o -name ".ruff_cache" \) -prune -exec rm -rf {} +
  find "${PYTHON_TARGET}" -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete
  rm -rf \
    "${PYTHON_TARGET}/build" \
    "${PYTHON_TARGET}/pip-selfcheck.json" \
    "${PYTHON_TARGET}/lib/python3.12/test" \
    "${PYTHON_TARGET}/lib/python3.12/idlelib" \
    "${PYTHON_TARGET}/lib/python3.12/tkinter"
}

prepare_portable_python_runtime() {
  local archive_cache_root="${RUNTIME_ROOT}/_toolcache/python-standalone-${PYTHON_STANDALONE_RELEASE}"
  local archive_path=""
  local extract_root=""
  local source_root=""

  resolve_python_artifact
  mkdir -p "${archive_cache_root}"
  archive_path="${archive_cache_root}/${PYTHON_ARCHIVE_NAME}"
  extract_root="${archive_cache_root}/extract"

  log "Portable Python release: ${PYTHON_STANDALONE_RELEASE}"
  log "Portable Python archive: ${PYTHON_ARCHIVE_NAME}"
  log "Portable Python URL: ${PYTHON_ARCHIVE_URL}"

  if [[ ! -f "${archive_path}" ]]; then
    curl -L --fail --retry 3 --output "${archive_path}" "${PYTHON_ARCHIVE_URL}"
  fi
  verify_sha256 "${archive_path}" "${PYTHON_ARCHIVE_SHA256}"

  rm -rf "${extract_root}"
  mkdir -p "${extract_root}"
  tar -xzf "${archive_path}" -C "${extract_root}"

  source_root="$(find_extracted_python_root "${extract_root}")"
  cleanup_dir "${PYTHON_TARGET}"
  cp -R "${source_root}/." "${PYTHON_TARGET}/"

  if [[ ! -x "${PYTHON_TARGET}/bin/python3" ]]; then
    echo "Portable Python extraction did not produce ${PYTHON_TARGET}/bin/python3" >&2
    exit 1
  fi

  "${PYTHON_TARGET}/bin/python3" -m ensurepip --upgrade
  "${PYTHON_TARGET}/bin/python3" -m pip install --upgrade pip setuptools wheel
  "${PYTHON_TARGET}/bin/python3" -m pip install -r "${REPO_ROOT}/requirements-runtime.txt"

  cleanup_python_runtime
  log "Portable Python runtime prepared at ${PYTHON_TARGET}"
}

write_runtime_node_package_json() {
  cat > "${NODE_TARGET}/package.json" <<'JSON'
{
  "name": "skills-mcp-runtime-node",
  "private": true,
  "description": "Bundled node dependencies required by skills"
}
JSON
}

prepare_node_runtime() {
  local node_bin
  local playwright_version
  node_bin="$(command -v node)"
  cleanup_dir "${NODE_TARGET}"
  mkdir -p "${NODE_TARGET}/bin"
  cp "${node_bin}" "${NODE_TARGET}/bin/node"
  chmod +x "${NODE_TARGET}/bin/node"
  write_runtime_node_package_json

  playwright_version="$(node -p "try{require('${REPO_ROOT//\\/\\\\}/mcp-servers/playwright/node_modules/playwright/package.json').version}catch(e){''}")"
  if [[ -n "${playwright_version}" ]]; then
    NODE_DEPS+=("playwright@${playwright_version}")
  else
    NODE_DEPS+=("playwright")
  fi

  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix "${NODE_TARGET}" --omit=dev --no-package-lock --no-audit --fund=false "${NODE_DEPS[@]}"
}

prepare_playwright_browsers() {
  local pw_version
  local rednote_pw_version
  cleanup_dir "${PLAYWRIGHT_TARGET}"

  pw_version="$(node -p "try{require('${REPO_ROOT//\\/\\\\}/mcp-servers/playwright/node_modules/playwright/package.json').version}catch(e){''}")"
  rednote_pw_version="$(node -p "try{require('${REPO_ROOT//\\/\\\\}/mcp-servers/rednote/node_modules/playwright/package.json').version}catch(e){''}")"

  if [[ ! -x "${REPO_ROOT}/mcp-servers/playwright/node_modules/.bin/playwright" ]]; then
    echo "Playwright CLI not found under mcp-servers/playwright" >&2
    exit 1
  fi

  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_TARGET}" \
    "${REPO_ROOT}/mcp-servers/playwright/node_modules/.bin/playwright" install chromium --no-shell

  if [[ -x "${REPO_ROOT}/mcp-servers/rednote/node_modules/.bin/playwright" && "${pw_version}" != "${rednote_pw_version}" ]]; then
    PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_TARGET}" \
      "${REPO_ROOT}/mcp-servers/rednote/node_modules/.bin/playwright" install chromium --no-shell
  fi

  rm -rf "${PLAYWRIGHT_TARGET}/mcp-chrome" "${PLAYWRIGHT_TARGET}/.links"
}

stage_pandoc() {
  local version="3.6.2"
  local work_root="${RUNTIME_ROOT}/_toolcache/pandoc-${version}"
  local extract_root="${work_root}/extract"
  local found=""
  local arch_name
  local archive_name=""
  local archive_path=""
  local download_url=""
  local downloaded="0"

  arch_name="$(uname -m)"

  mkdir -p "${work_root}"

  for archive_name in \
    "pandoc-${version}-${arch_name}-macOS.zip" \
    "pandoc-${version}-arm64-macOS.zip" \
    "pandoc-${version}-x86_64-macOS.zip"
  do
    archive_path="${work_root}/${archive_name}"
    download_url="https://github.com/jgm/pandoc/releases/download/${version}/${archive_name}"
    if curl -L --fail --retry 3 --output "${archive_path}" "${download_url}"; then
      rm -rf "${extract_root}"
      mkdir -p "${extract_root}"
      ditto -x -k "${archive_path}" "${extract_root}"
      found="$(find "${extract_root}" -type f -name pandoc | head -n 1 || true)"
      if [[ -n "${found}" ]]; then
        downloaded="1"
        break
      fi
    fi
  done

  if [[ "${downloaded}" != "1" ]]; then
    warn "Official pandoc release download failed; falling back to brew"
    if ! stage_brew_tool "pandoc" "pandoc" "pandoc"; then
      warn "Unable to prepare pandoc via official release or brew"
      return 1
    fi
    return 0
  fi

  if [[ -z "${found}" ]]; then
    warn "pandoc download finished but executable not found"
    return 1
  fi

  mkdir -p "${TOOLS_TARGET}/pandoc/payload"
  cp "${found}" "${TOOLS_TARGET}/pandoc/payload/pandoc"
  chmod +x "${TOOLS_TARGET}/pandoc/payload/pandoc"
  return 0
}

stage_brew_tool() {
  local formula="$1"
  local payload_name="$2"
  local binary_name="$3"
  local source_bin=""

  if ! brew list --versions "${formula}" >/dev/null 2>&1; then
    if ! brew install "${formula}"; then
      warn "brew install failed for ${formula}"
      return 1
    fi
  fi

  source_bin="$(brew --prefix "${formula}")/bin/${binary_name}"
  if [[ ! -x "${source_bin}" ]]; then
    warn "Installed ${formula} but executable missing: ${source_bin}"
    return 1
  fi

  mkdir -p "${TOOLS_TARGET}/${payload_name}/payload"
  cp "${source_bin}" "${TOOLS_TARGET}/${payload_name}/payload/${binary_name}"
  chmod +x "${TOOLS_TARGET}/${payload_name}/payload/${binary_name}"
  return 0
}

prepare_tools() {
  cleanup_dir "${TOOLS_TARGET}"
  mkdir -p "${RUNTIME_ROOT}/_toolcache"

  stage_pandoc || true
  warn "tesseract is not bundled for macOS yet; avoid copying Homebrew-only binaries without their runtime libraries"
  warn "qpdf is not bundled for macOS yet; avoid copying Homebrew-only binaries without their runtime libraries"
  warn "pdftk is not bundled for macOS yet; keep this as a CI warning until a self-contained mac binary source is available"

  cat > "${TOOLS_TARGET}/manifest.json" <<'JSON'
{
  "platform": "darwin",
  "preparedBy": "frontend/scripts/prepare-bundled-runtimes-macos.sh",
  "portablePythonRelease": "20240415",
  "portablePythonVersion": "3.12.3"
}
JSON
}

main() {
  need_cmd node
  need_cmd npm
  need_cmd curl
  need_cmd ditto
  need_cmd tar
  need_cmd shasum

  log "Repo root: ${REPO_ROOT}"
  log "Prepare Python runtime..."
  prepare_portable_python_runtime

  log "Prepare Node runtime..."
  prepare_node_runtime

  log "Install Playwright browser assets..."
  prepare_playwright_browsers

  log "Stage bundled tools..."
  prepare_tools

  log "Done."
}

main "$@"
