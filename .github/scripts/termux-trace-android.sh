#!/usr/bin/env bash
# Diagnostic only: target and debugger failures are recorded, not smoke-test passes.
set -uo pipefail
umask 077
ulimit -c 0

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 BINARY OUTPUT_DIRECTORY" >&2
  exit 2
fi

binary="$(realpath -- "$1")" || exit 2
mkdir -p -- "$2" || exit 2
output="$(realpath -- "$2")" || exit 2

if [[ ! -x "$binary" ]]; then
  echo "Not an executable: $binary" >&2
  exit 2
fi

printf 'diagnostic_only=true\n' >"$output/status.txt"

for tool in timeout script bash; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'setup_missing=%s\n' "$tool" >>"$output/status.txt"
    echo "Trace unavailable: missing $tool; see $output/status.txt"
    exit 0
  fi
done

{
  printf 'binary=%s\n' "$binary"
  printf 'cwd=%s\n' "$PWD"
  printf 'HOME=%s\n' "${HOME-}"
  printf 'XDG_CONFIG_HOME=%s\n' "${XDG_CONFIG_HOME-}"
  printf 'XDG_CACHE_HOME=%s\n' "${XDG_CACHE_HOME-}"
  printf 'XDG_DATA_HOME=%s\n' "${XDG_DATA_HOME-}"
  printf 'TMPDIR=%s\n' "${TMPDIR-}"
  printf 'LD_PRELOAD=%s\n' "${LD_PRELOAD-}"
  printf 'TERM=%s\nCOLUMNS=%s\nLINES=%s\n' "${TERM-}" "${COLUMNS-}" "${LINES-}"
  timeout -k 1s 3s uname -a
  timeout -k 1s 3s id
  timeout -k 1s 3s id -Z
  timeout -k 1s 3s getconf PAGESIZE
  if [[ -r /proc/self/attr/current ]]; then
    printf 'selinux_context='
    timeout -k 1s 3s cat /proc/self/attr/current
  fi
  if [[ -r /proc/self/status ]]; then
    timeout -k 1s 3s grep -E '^(NoNewPrivs|Seccomp|CapEff):' /proc/self/status
  fi
  if command -v getprop >/dev/null 2>&1; then
    for property in ro.build.version.sdk ro.build.version.release ro.product.cpu.abi; do
      printf '%s=' "$property"
      timeout -k 1s 3s getprop "$property"
    done
  fi
  for tool in script strace gdb; do
    command -v "$tool" || continue
    timeout -k 1s 3s "$tool" --version | head -n 1
  done
  timeout -k 1s 10s sha256sum -- "$binary"
} >"$output/host.txt" 2>&1

timeout -k 1s 5s "$binary" --version >"$output/version.txt" 2>&1
printf 'version=%s\n' "$?" >>"$output/status.txt"

run_pty() {
  local name="$1"
  local status
  shift

  # The inner timeout owns the traced command; the outer one also bounds script.
  # Do not resize the baseline PTY: its inherited size may explain the CI crash.
  timeout -k 2s 27s script -q -e -f \
    -O "$output/$name.pty.log" \
    -- bash -c 'printf "pty_rows_columns="; stty size; exec "$@"' \
    "$name" timeout -k 2s 20s "$@" >"$output/$name.console.log" 2>&1
  status="$?"
  printf '%s=%s\n' "$name" "$status" >>"$output/status.txt"
  printf '%s diagnostic exit status: %s\n' "$name" "$status"
}

if command -v strace >/dev/null 2>&1; then
  # Exclude read/write/network buffers and render exec arguments as raw pointers.
  run_pty strace strace -f -tt -T -s 160 \
    -e trace=%process,%file,%memory,%signal,prctl,uname \
    -e raw=execve,execveat \
    -o "$output/syscalls.log" "$binary" --standalone
else
  printf 'strace=missing\n' >>"$output/status.txt"
fi

if command -v gdb >/dev/null 2>&1; then
  # Each -ex is separate so unreadable PC=0 memory does not suppress the LR dump.
  # Register expressions must reach GDB without shell expansion.
  # shellcheck disable=SC2016
  run_pty gdb gdb -q -nx -batch \
    -ex 'set pagination off' \
    -ex 'set confirm off' \
    -ex 'set auto-load off' \
    -ex 'set startup-with-shell off' \
    -ex 'set disable-randomization off' \
    -ex 'handle SIGSEGV stop print nopass' \
    -ex 'handle SIGBUS stop print nopass' \
    -ex 'handle SIGABRT stop print nopass' \
    -ex run \
    -ex 'thread apply all bt' \
    -ex 'info registers' \
    -ex 'p $_siginfo' \
    -ex 'info sharedlibrary' \
    -ex 'info proc mappings' \
    -ex 'info auxv' \
    -ex 'x/16i $pc-32' \
    -ex 'x/16i $lr-32' \
    -ex quit \
    --args "$binary" --standalone
else
  printf 'gdb=missing\n' >>"$output/status.txt"
fi

# Controlled comparison: only terminal geometry changes from the baseline.
run_pty sized-pty bash -c \
  'stty rows 24 cols 80; printf "resized_pty_rows_columns="; stty size; exec "$@"' \
  sized-pty "$binary" --standalone

echo "Diagnostics saved to $output. Statuses describe probes, not smoke-test success."
exit 0
