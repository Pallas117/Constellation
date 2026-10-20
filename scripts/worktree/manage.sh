#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${ROOT}" ]]; then
  echo "Error: run from inside a git repository." >&2
  exit 1
fi

# Worktrees live next to the main checkout as "<main checkout>.worktrees/<branch>", whichever
# worktree this runs from (the common .git dir always belongs to the main checkout).
COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
MAIN_CHECKOUT="$(dirname "${COMMON_DIR}")"
DEFAULT_WORKTREE_HOME="${MAIN_CHECKOUT}.worktrees"
WORKTREE_HOME="${GAUSS_WORKTREE_HOME:-${DEFAULT_WORKTREE_HOME}}"

usage() {
  cat <<EOF
Usage:
  bash scripts/worktree/manage.sh create <branch-name> [base]
  bash scripts/worktree/manage.sh list
  bash scripts/worktree/manage.sh status
  bash scripts/worktree/manage.sh sync
  bash scripts/worktree/manage.sh remove <branch-name|absolute-path>
  bash scripts/worktree/manage.sh prune
  bash scripts/worktree/manage.sh doctor

Defaults:
  worktree home: ${WORKTREE_HOME}
  create base: origin/$(default_branch), fetched first (your local main may be stale)

Notes:
  - Branch names need a prefix: the Linear issue's branch name (jzwnathan/gau-<n>-...)
    or <type>/<name> (fix/..., chore/..., docs/..., ops/...).
  - New branches don't track the base, so the first push sets the upstream.
  - Paths are mapped as: <worktree-home>/<branch-with-slashes-replaced-by-double-underscore>
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

default_branch() {
  git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || echo "main"
}

normalize_branch_name() {
  local input="$1"
  [[ "${input}" == */* ]] \
    || die "branch '${input}' needs a prefix: use the Linear issue's branch name (jzwnathan/gau-<n>-...) or <type>/<name> (fix/, chore/, docs/, ops/)"
  echo "${input}"
}

branch_to_path() {
  local branch="$1"
  echo "${WORKTREE_HOME}/${branch//\//__}"
}

worktree_paths() {
  git worktree list --porcelain | awk '/^worktree / {sub(/^worktree /, ""); print}'
}

find_worktree_path_by_branch() {
  local target="$1"
  local wt_path=""
  local wt_branch=""
  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "${line}" == worktree\ * ]]; then
      wt_path="${line#worktree }"
    elif [[ "${line}" == branch\ refs/heads/* ]]; then
      wt_branch="${line#branch refs/heads/}"
    elif [[ -z "${line}" ]]; then
      if [[ "${wt_branch}" == "${target}" ]]; then
        echo "${wt_path}"
        return 0
      fi
      wt_path=""
      wt_branch=""
    fi
  done < <(git worktree list --porcelain; echo)

  return 1
}

command_create() {
  local raw_name="${1:-}"
  local base="${2:-origin/$(default_branch)}"
  [[ -n "${raw_name}" ]] || die "create requires <branch-name>"
  git fetch --quiet --prune origin || echo "Warning: fetch failed; using the last fetched refs." >&2

  local branch
  branch="$(normalize_branch_name "${raw_name}")"
  local wt_path
  wt_path="$(branch_to_path "${branch}")"

  mkdir -p "${WORKTREE_HOME}"
  [[ ! -e "${wt_path}" ]] || die "worktree path already exists: ${wt_path}"

  if git show-ref --verify --quiet "refs/heads/${branch}"; then
    git worktree add "${wt_path}" "${branch}"
  elif git show-ref --verify --quiet "refs/remotes/origin/${branch}"; then
    git worktree add --track -b "${branch}" "${wt_path}" "origin/${branch}"
  else
    git rev-parse --verify --quiet "${base}^{commit}" >/dev/null || die "base not found: ${base}"
    git worktree add --no-track -b "${branch}" "${wt_path}" "${base}"
  fi

  echo "Created worktree:"
  echo "  branch: ${branch}"
  echo "  path:   ${wt_path}"
}

command_list() {
  echo "Worktree home: ${WORKTREE_HOME}"
  git worktree list
}

command_status() {
  local default
  default="$(default_branch)"
  printf "%-56s %-28s %-10s %-16s\n" "PATH" "BRANCH" "DIRTY" "UPSTREAM"
  printf "%-56s %-28s %-10s %-16s\n" \
    "--------------------------------------------------------" \
    "----------------------------" \
    "----------" \
    "----------------"

  while IFS= read -r wt; do
    local branch dirty_count upstream marker
    branch="$(git -C "${wt}" branch --show-current 2>/dev/null || echo "detached")"
    dirty_count="$(git -C "${wt}" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    upstream="$(git -C "${wt}" rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" 2>/dev/null || echo "-")"
    marker=""
    if [[ "${branch}" == "${default}" ]]; then
      marker="(default)"
    fi
    printf "%-56s %-28s %-10s %-16s %s\n" \
      "${wt}" \
      "${branch}" \
      "${dirty_count}" \
      "${upstream}" \
      "${marker}"
  done < <(worktree_paths)
}

command_sync() {
  # All worktrees share one repository, so a single fetch updates them all.
  echo "Fetching origin..."
  git fetch origin --prune >/dev/null
  echo "Fetch complete."
  command_status
}

command_remove() {
  local target="${1:-}"
  [[ -n "${target}" ]] || die "remove requires <branch-name|absolute-path>"

  local path="${target}"
  if [[ ! -d "${path}" ]]; then
    path="$(find_worktree_path_by_branch "${target}" || true)"
  fi
  [[ -n "${path}" ]] || die "could not find worktree for target: ${target}"
  [[ -d "${path}" ]] || die "worktree path does not exist: ${path}"
  [[ "${path}" != "${ROOT}" ]] || die "refusing to remove the main repository worktree"

  git worktree remove "${path}"
  echo "Removed worktree: ${path}"
}

command_prune() {
  git worktree prune
  if [[ -d "${WORKTREE_HOME}" ]]; then
    find "${WORKTREE_HOME}" -mindepth 1 -maxdepth 1 -type d -empty -exec rmdir {} + 2>/dev/null || true
  fi
  echo "Pruned stale worktree metadata."
}

command_doctor() {
  echo "Repository root: ${ROOT}"
  echo "Worktree home:   ${WORKTREE_HOME}"
  echo
  echo "[1] Worktree list"
  git worktree list
  echo
  echo "[2] Dry-run prune"
  git worktree prune --dry-run || true
  echo
  echo "[3] Status summary"
  command_status
}

main() {
  local cmd="${1:-help}"
  shift || true

  case "${cmd}" in
    create) command_create "$@" ;;
    list) command_list ;;
    status) command_status ;;
    sync) command_sync ;;
    remove) command_remove "$@" ;;
    prune) command_prune ;;
    doctor) command_doctor ;;
    help|-h|--help) usage ;;
    *) die "unknown command: ${cmd} (use help)" ;;
  esac
}

main "$@"
