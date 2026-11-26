# Dev container for Gauss Aurora: GitHub Codespaces, or VS Code "Reopen in Container".
# Node 22 matches .nvmrc. Go and the GitHub CLI come from devcontainer.json features.
FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# TruffleHog 3, the secret scanner behind the commit hook and `npm run security:secrets`.
# Pinned and checksum-checked. To bump: the version and both sums from the release's
# trufflehog_<version>_checksums.txt.
ARG TRUFFLEHOG_VERSION=3.99.2
ARG TRUFFLEHOG_SHA256_AMD64=3c7b0d1dc4278294269bfdd7594bca8bb28c78da0a4a06ad202ded37b48deca4
ARG TRUFFLEHOG_SHA256_ARM64=929b81efffca752eafd58bf6f17bf725d354f338636a7bbbee65c086d2f9ddf3
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sum="$TRUFFLEHOG_SHA256_AMD64" ;; \
      arm64) sum="$TRUFFLEHOG_SHA256_ARM64" ;; \
      *) echo "no TruffleHog build for $arch" >&2; exit 1 ;; \
    esac; \
    tgz="trufflehog_${TRUFFLEHOG_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSLo "/tmp/$tgz" "https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VERSION}/$tgz"; \
    echo "$sum  /tmp/$tgz" | sha256sum -c -; \
    tar -xzf "/tmp/$tgz" -C /usr/local/bin trufflehog; \
    rm "/tmp/$tgz"; \
    trufflehog --version

# pre-commit runs the git hooks (.pre-commit-config.yaml); pipx keeps it out of the system Python.
ARG PRE_COMMIT_VERSION=4.6.2
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends pipx; \
    rm -rf /var/lib/apt/lists/*; \
    PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install "pre-commit==${PRE_COMMIT_VERSION}"; \
    pre-commit --version
